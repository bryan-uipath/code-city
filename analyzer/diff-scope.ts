/**
 * diff-scope.ts — the changed-file set of a range, and where its added lines
 * came from.
 *
 * The **diff scope** is the file list itself (what the reviewer has to look at
 * at all); **provenance** is the bucketing this module puts on each of them.
 *
 * A split/extract refactor is mostly *relocation*: the review question is not
 * "what changed" but "which of these 3000 added lines is actually new logic".
 * So each added line with any identifier on it lands in one of three buckets
 * (blank and punctuation-only lines are counted nowhere):
 *
 * - **verbatim** — git's own `--color-moved=zebra` matched it to a deleted line
 *   somewhere else in the diff, unchanged (indentation aside).
 * - **reshaped** — moved but modified in transit (`foo` → `this.foo` when
 *   functions get wrapped into a class): paired here against the leftover
 *   deleted lines by normalized-token similarity.
 * - **new** — nothing in the diff explains it. This is what a reviewer reads.
 *
 * The buckets are *proportions of mass*, not a line-accurate mapping: the
 * pairing is a cheap heuristic on purpose (no AST diff), because the payoff is
 * "87% of this file is verbatim — skip it".
 */
import { execFileSync } from 'node:child_process';
import type { DiffFile, DiffScope } from '../shared/types.js';

/** zebra palette: newMoved 1;36 / alt 1;33, oldMoved 1;35 / alt 1;34. */
const MOVED_NEW = new Set(['1;36', '1;33']);
const MOVED_OLD = new Set(['1;35', '1;34']);
const GIT_PINS = [
  // Non-ASCII paths must not arrive octal-escaped in the +++/--- headers, and a
  // signed commit must not prepend gpg lines to `show -s --format=%ct`.
  '-c', 'core.quotePath=false', '-c', 'log.showSignature=false',
];
const COLOR_PINS = [
  ...GIT_PINS,
  '-c', 'color.diff.new=green', '-c', 'color.diff.old=red',
  '-c', 'color.diff.newMoved=bold cyan', '-c', 'color.diff.newMovedAlternative=bold yellow',
  '-c', 'color.diff.oldMoved=bold magenta', '-c', 'color.diff.oldMovedAlternative=bold blue',
];
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const SIGN_RE = /^\x1b\[([0-9;]+)m([+-])/;

/** Lines with fewer tokens than this (`}`, `});`) carry no identity to pair on. */
const MIN_TOKENS = 2;
/** Dice similarity over token sets above which a pair counts as "reshaped". */
const SIM_THRESHOLD = 0.6;
/** Tokens in more deleted lines than this are noise (`const`, `return`). */
const COMMON_TOKEN = 400;
/** Candidate deletions scored per added line. */
const MAX_CANDIDATES = 240;

type Buckets = Omit<DiffFile, 'path'>;

/** One unmatched line of the diff, waiting to be paired. */
interface Loose {
  path: string;
  tokens: Set<string>;
  used?: boolean;
}

/**
 * Bucket every changed line of `range` ("base..head", "base...head" = from the
 * merge base, or a bare rev meaning "<rev>..HEAD"). Throws when the range does
 * not resolve.
 */
export function collectDiffScope(repoRoot: string, range: string): DiffScope {
  const { base, head, baseRef, headRef } = resolveRange(repoRoot, range);
  // Colors pinned and renames off: the parser reads the palette, so a user's
  // color.diff.* must not leak in; a detected rename would hide its unchanged
  // lines from the diff, and those are exactly the verbatim mass to count.
  const raw = git(repoRoot, [
    ...COLOR_PINS,
    'diff', '--color=always', '--no-ext-diff', '--no-renames',
    '--src-prefix=a/', '--dst-prefix=b/',
    '--color-moved=zebra', '--color-moved-ws=allow-indentation-change',
    base, head,
  ]);

  const files = new Map<string, Buckets>();
  const looseAdds: Loose[] = [];
  const looseDels: Loose[] = [];
  // Both sides are tracked: a deleted file's hunk says `+++ /dev/null`, and
  // attributing its deletions to the previous file was the original bug.
  let aPath: string | null = null;
  let bPath: string | null = null;
  // `---`/`+++` are headers only between `diff --git` and the first hunk; a
  // deleted `-- sql comment` line is content that happens to start the same way.
  let inHeader = false;

  for (const line of raw.split('\n')) {
    const plain = line.replace(ANSI_RE, '');
    if (plain.startsWith('diff --git ')) { inHeader = true; aPath = bPath = null; continue; }
    if (inHeader) {
      if (plain.startsWith('--- ')) aPath = pathOf(plain.slice(4), 'a/');
      else if (plain.startsWith('+++ ')) bPath = pathOf(plain.slice(4), 'b/');
      else if (plain.startsWith('@@')) inHeader = false;
      continue;
    }
    const m = SIGN_RE.exec(line);
    const sign = m ? m[2] : plain[0];
    if (sign !== '+' && sign !== '-') continue;
    const color = m ? m[1] ?? '' : '';
    const path = sign === '+' ? bPath ?? aPath : aPath ?? bPath;
    if (!path) continue;
    // Blank and punctuation-only lines (`}`, `});`) are not logic anyone reads;
    // they stay out of every bucket so the shares describe substantive lines.
    const tokens = tokenize(plain.slice(1));
    if (tokens.size === 0) continue;
    const bucket = bucketsFor(files, path);
    if (sign === '+') {
      if (MOVED_NEW.has(color)) bucket.verbatim++;
      else looseAdds.push({ path, tokens });
    } else {
      bucket.deleted++;
      if (!MOVED_OLD.has(color)) looseDels.push({ path, tokens });
    }
  }

  pairReshaped(looseAdds, looseDels, files);
  // The branch's own commits and its two endpoints in time — what the viewer's
  // timeline needs to mark the delta inside the 12-month stream.
  const revs = git(repoRoot, ['rev-list', `${base}..${head}`]).split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    base,
    head,
    baseRef,
    headRef,
    commits: revs,
    baseTs: commitTs(repoRoot, base),
    headTs: commitTs(repoRoot, head),
    files: [...files].map(([path, b]) => ({ path, ...b }))
      .sort((x, y) => (y.verbatim + y.reshaped + y.new) - (x.verbatim + x.reshaped + x.new)),
  };
}

/**
 * Pair leftover adds against leftover dels: a match is "moved but rewritten",
 * everything unpaired is genuinely new. Deletions are indexed by their rarest
 * tokens so an added line only scores against plausible origins.
 */
function pairReshaped(adds: Loose[], dels: Loose[], files: Map<string, Buckets>): void {
  const byToken = new Map<string, Loose[]>();
  for (const del of dels) {
    if (del.tokens.size < MIN_TOKENS) continue;
    for (const t of del.tokens) {
      let list = byToken.get(t);
      if (!list) byToken.set(t, (list = []));
      list.push(del);
    }
  }

  const candidates = new Set<Loose>();
  for (const add of adds) {
    const bucket = bucketsFor(files, add.path);
    if (add.tokens.size < MIN_TOKENS) { bucket.new++; continue; }
    candidates.clear();
    for (const t of add.tokens) {
      const list = byToken.get(t);
      if (!list || list.length > COMMON_TOKEN) continue;
      for (const del of list) {
        if (!del.used) candidates.add(del);
        if (candidates.size >= MAX_CANDIDATES) break;
      }
      if (candidates.size >= MAX_CANDIDATES) break;
    }
    let best: Loose | null = null;
    let bestScore = SIM_THRESHOLD;
    for (const del of candidates) {
      const score = dice(add.tokens, del.tokens);
      if (score > bestScore) { bestScore = score; best = del; }
    }
    if (best) {
      best.used = true;
      bucket.reshaped++;
    } else {
      bucket.new++;
    }
  }
}

/** 2·|A∩B| / (|A|+|B|) over unique tokens — cheap and symmetric. */
function dice(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const t of small) if (large.has(t)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** Identifiers and numbers, with `this.` stripped so a wrapped field still matches. */
function tokenize(text: string): Set<string> {
  const tokens = text.replace(/\bthis\./g, '').match(/[A-Za-z_$][\w$]*|\d+/g);
  return new Set(tokens ?? []);
}

function bucketsFor(files: Map<string, Buckets>, path: string): Buckets {
  let b = files.get(path);
  if (!b) files.set(path, (b = { verbatim: 0, reshaped: 0, new: 0, deleted: 0 }));
  return b;
}

/** `a/foo.ts` → `foo.ts`; `/dev/null` → null. Quoted paths are unquoted. */
export function pathOf(raw: string, prefix: string): string | null {
  let p = raw.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function resolveRange(
  repoRoot: string, range: string
): { base: string; head: string; baseRef: string; headRef: string } {
  const threeDot = range.includes('...');
  const sep = threeDot ? '...' : '..';
  const parts = range.includes('..') ? range.split(sep) : [range, 'HEAD'];
  const left = (parts[0] || '').trim();
  const right = (parts[1] || 'HEAD').trim();
  if (!left) throw new Error(`--diff needs <base>..<head> (got "${range}")`);
  const head = revParse(repoRoot, right);
  const base = threeDot
    ? git(repoRoot, ['merge-base', revParse(repoRoot, left), head]).trim()
    : revParse(repoRoot, left);
  return { base, head, baseRef: left, headRef: right };
}

/** Committer timestamp, unix seconds — same clock as the commit stream's `ts`. */
function commitTs(repoRoot: string, hash: string): number {
  return Number(git(repoRoot, [...GIT_PINS, 'show', '-s', '--format=%ct', hash]).trim()) || 0;
}

function revParse(repoRoot: string, rev: string): string {
  return git(repoRoot, ['rev-parse', '--verify', `${rev}^{commit}`]).trim();
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], { maxBuffer: 1 << 28 }).toString();
}
