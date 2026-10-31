/**
 * git.js — the git provider: the runtime half of the git adapter (DESIGN.md
 * "An adapter has two halves"). It answers the dev API's questions about
 * one repo by shelling out to git, and owns their input discipline: every id
 * goes through `safeRelPath`, every event id through `HASH_RE`. The dev server
 * routes to it and knows nothing of git. Throws Error on bad input (-> 400).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_LINES = 400;
const LOG_COUNT = 15;
const MAX_SEARCH_RESULTS = 500;
const HASH_RE = /^[0-9a-f]{7,40}$/;
/** Working-tree entries reported per /status call. */
const MAX_STATUS = 2000;
/** Untracked files whose length is actually measured (the rest report 0). */
const MAX_UNTRACKED_COUNTED = 400;
/** Line-count ceiling per untracked file, and the byte ceiling that feeds it. */
const MAX_UNTRACKED_LINES = 10_000;
const MAX_UNTRACKED_BYTES = 4 * 1024 * 1024;
/** Total bytes read per /status call — the reads are sync and polled every 5s. */
const MAX_UNTRACKED_TOTAL_BYTES = 16 * 1024 * 1024;
/** Every git call that takes a user path: pathspec magic (`[id]`, `*`, `:(glob)`) off. Search keeps its globs. */
const LITERAL = '--literal-pathspecs';
/** Detail kinds by extension; everything else is code. */
const MARKDOWN_RE = /\.mdx?$/i;

/** @param {string} root absolute repo root, already known to exist */
export function createGitProvider(root) {
  /** A repo-relative path that exists under root, or throw. */
  const relId = (id) => {
    const rel = safeRelPath(id, root);
    if (!rel) throw new Error('invalid path');
    return rel;
  };

  return {
    /** Lines of one file: typed content, `code` or `markdown` (same lines, the viewer picks the renderer). */
    async getDetail({ id, start: startParam, end: endParam }) {
      const rel = relId(id);
      const text = fs.readFileSync(path.resolve(root, rel), 'utf8');
      const all = text.split('\n');
      const total = all.length;
      const start = clamp(intParam(startParam, 1), 1, total);
      const requestedEnd = clamp(intParam(endParam, total), start, total);
      const end = Math.min(requestedEnd, start + MAX_LINES - 1);
      const kind = MARKDOWN_RE.test(rel) ? 'markdown' : 'code';
      return { path: rel, start, end, total, lines: all.slice(start - 1, end), kind };
    },

    /** Recent commits touching a file, or a line range of it. */
    async getHistory({ id, start: startParam, end: endParam }) {
      const rel = relId(id);
      const pretty = `--pretty=format:%h${'\t'}%ct${'\t'}%an${'\t'}%s`;
      const start = intParam(startParam, 0);
      const end = intParam(endParam, 0);
      // A line range asks which commits touched those lines (`-L`); it cannot
      // be combined with --follow, and a range past EOF falls back to the file.
      // Literal pathspecs so `app/[id]/page.tsx` is that file, not a glob over `app/i/…`.
      const forFile = [LITERAL, 'log', '-n', String(LOG_COUNT), '--follow', pretty, '--', rel];
      let stdout;
      let scoped = false; // did `-L` actually answer? the caller labels the fallback
      if (start >= 1 && end >= start) {
        try {
          ({ stdout } = await git(root, [LITERAL, 'log', '-n', String(LOG_COUNT), '--no-patch', `-L${start},${end}:${rel}`, pretty]));
          scoped = true;
        } catch {
          ({ stdout } = await git(root, forFile));
        }
      } else {
        ({ stdout } = await git(root, forFile));
      }
      const commits = stdout.split('\n').filter(Boolean).map((line) => {
        const [h, ts, a, ...rest] = line.split('\t');
        return { h, ts: Number(ts), a, s: rest.join('\t') };
      });
      return { commits, scoped };
    },

    /** One commit's change to one file. */
    async getChange({ id, event }) {
      const rel = relId(id);
      const h = event || '';
      if (!HASH_RE.test(h)) throw new Error('invalid hash');
      const { stdout } = await git(root, [LITERAL, 'show', h, '--', rel]);
      return { diff: stdout.split('\n').slice(0, MAX_LINES).join('\n') };
    },

    // A path's diff across the analyzed range, optionally only the hunks that
    // change head lines start..end — a module's slice of the PR.
    async getRangeDiff({ id, base: baseParam, head: headParam, start: startParam, end: endParam }) {
      const rel = relId(id);
      const base = baseParam || '';
      const head = headParam || '';
      if (!HASH_RE.test(base) || !HASH_RE.test(head)) throw new Error('invalid hash');
      // Pinned: clipHunks counts head lines, so blank context must keep its ' ' and every hunk its context;
      // literal pathspecs so `app/[id]/page.tsx` is that file, not a glob.
      const { stdout } = await git(root, [
        '--literal-pathspecs', '-c', 'diff.suppressBlankEmpty=false', 'diff', '-U3', '--no-color', '--no-ext-diff', '--no-renames',
        base, head, '--', rel,
      ]);
      const start = intParam(startParam, 0);
      const end = intParam(endParam, 0);
      const text = start >= 1 && end >= start ? clipHunks(stdout, start, end) : stdout;
      return { diff: text.split('\n').slice(0, MAX_LINES).join('\n') };
    },

    // Working-tree state: modified / added / deleted / untracked (the "now" view),
    // each entry carrying the per-file line balance the city paints it with.
    async getLive({ debug }) {
      // -uall: expand untracked dirs to their files, so each gets its own entry.
      const { stdout } = await git(root, ['status', '--porcelain', '-uall']);
      if (debug) {
        const gitEnv = Object.keys(process.env).filter((k) => k.startsWith('GIT_'));
        return { debugRoot: root, rawLines: stdout.split('\n').filter(Boolean).length, gitEnv };
      }
      const changes = stdout.split('\n').filter(Boolean).slice(0, MAX_STATUS).map((line) => {
        const x = line[0] || ' ';
        const y = line[1] || ' ';
        let p = line.slice(3);
        const arrow = p.indexOf(' -> '); // renames: report the new path
        if (arrow >= 0) p = p.slice(arrow + 4);
        if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
        return { path: p, x, y, untracked: x === '?' };
      });

      // Unstaged and staged hunks are one change as far as the city is concerned:
      // the plot shows what the file looks like NOW versus HEAD, so the two
      // numstat passes are summed rather than reported separately.
      const stats = new Map();
      for (const args of [['diff', '--numstat'], ['diff', '--cached', '--numstat']]) {
        let out = '';
        try { ({ stdout: out } = await git(root, args)); } catch { continue; }
        for (const line of out.split('\n')) {
          if (!line) continue;
          const [a, d, ...rest] = line.split('\t');
          let p = rest.join('\t');
          // Rename entries: attribute to the new path. Brace form keeps the common
          // prefix/suffix (`src/{old => new}.ts`); plain form is the whole path.
          p = p.replace(/\{([^{}]*) => ([^{}]*)\}/g, '$2').replace(/\/\//g, '/');
          const arrow = p.indexOf(' => ');
          if (arrow >= 0) p = p.slice(arrow + 4);
          if (!p) continue;
          // '-' is git's marker for a binary file: no line balance exists.
          const added = a === '-' ? 0 : Number(a) || 0;
          const removed = d === '-' ? 0 : Number(d) || 0;
          const prev = stats.get(p) || { added: 0, removed: 0 };
          stats.set(p, { added: prev.added + added, removed: prev.removed + removed });
        }
      }

      // An untracked file has no diff at all — every line in it is new, so its
      // own length is the honest "added" count. Capped in both directions: how
      // many files get counted, and how many lines are counted per file.
      let counted = 0;
      const budget = { left: MAX_UNTRACKED_TOTAL_BYTES };
      for (const c of changes) {
        if (!c.untracked) continue;
        if (counted++ >= MAX_UNTRACKED_COUNTED) break;
        c.added = countLines(root, c.path, budget);
        c.removed = 0;
      }
      for (const c of changes) {
        if (c.added !== undefined) continue;
        const s = stats.get(c.path);
        // Deletions land here with no numstat row when they are unstaged-and-then
        // committed-around; the viewer treats a deletion as removal regardless.
        c.added = s ? s.added : 0;
        c.removed = s ? s.removed : 0;
      }
      return { changes };
    },

    // Content search over tracked source files (Ctrl+F in the viewer).
    async search({ q: raw }) {
      const q = (raw || '').trim();
      if (q.length < 2 || q.length > 200) throw new Error('query must be 2–200 chars');
      let stdout = '';
      try {
        ({ stdout } = await git(root, [
          'grep', '-I', '-i', '-n', '--max-count', '5', '--fixed-strings', '-e', q,
          '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs',
        ]));
      } catch {
        // git grep exits 1 when there are no matches
        return { q, matches: [], truncated: false };
      }
      const lines = stdout.split('\n').filter(Boolean);
      const truncated = lines.length > MAX_SEARCH_RESULTS;
      const matches = lines.slice(0, MAX_SEARCH_RESULTS).map((line) => {
        const first = line.indexOf(':');
        const second = line.indexOf(':', first + 1);
        if (first < 0 || second < 0) return null;
        return {
          path: line.slice(0, first),
          line: Number(line.slice(first + 1, second)),
          text: line.slice(second + 1).trim().slice(0, 200),
        };
      }).filter(Boolean);
      return { q, matches, truncated };
    },
  };
}

// ---------- helpers ----------

/**
 * Keep the file header and the hunks with a change inside head lines lo..hi
 * ('' when none). A change is each run of +/- lines, ranged exactly as `-U0`
 * would (the analyzer's `DiffFile.spans`): its added lines, or for a pure
 * deletion the head line before it — so context lines never count as touched.
 */
function clipHunks(diff, lo, hi) {
  const header = [];
  const kept = [];
  let hunk = null; // { lines, at: next head line, hit }
  let run = null; // { first, last } of the open +/- run; first = null until a '+'
  const close = () => {
    if (!run || !hunk) return;
    const a = run.first ?? run.anchor;
    const b = run.first === null ? run.anchor : run.last;
    if (a <= hi && b >= lo) hunk.hit = true;
    run = null;
  };
  const flush = () => {
    close();
    if (hunk?.hit) kept.push(...hunk.lines);
  };
  for (const line of diff.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      flush();
      // `+c,0` (an emptied side) names the line BEFORE the hunk, not its first line.
      hunk = { lines: [line], at: Number(m[1]) + (m[2] === '0' ? 1 : 0), hit: false };
      continue;
    }
    if (!hunk) { header.push(line); continue; }
    hunk.lines.push(line);
    const c = line[0];
    if (c === '\\') continue; // "\ No newline at end of file" sits inside a run, not between two
    if (c === '+' || c === '-') {
      run ??= { first: null, last: null, anchor: hunk.at - 1 };
      if (c === '+') { run.first ??= hunk.at; run.last = hunk.at; hunk.at++; }
    } else {
      close();
      if (c === ' ') hunk.at++;
    }
  }
  flush();
  return kept.length ? [...header, ...kept].join('\n') : '';
}

// Repo-relative, no absolute/backslash/`..`, resolved under root, and must exist.
function safeRelPath(p, root) {
  if (!p || typeof p !== 'string') return null;
  if (p.includes('\\') || path.isAbsolute(p)) return null;
  if (p.split('/').some((seg) => seg === '..')) return null;
  const abs = path.resolve(root, p);
  if (!abs.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return p;
}

/**
 * Line count of an untracked file, 0 when it cannot be counted. Goes through
 * `safeRelPath` for the same containment check every other route uses: the path
 * came out of `git status`, but nothing downstream should have to trust that.
 */
function countLines(root, relPath, budget) {
  const rel = safeRelPath(relPath, root);
  if (!rel) return 0;
  try {
    const abs = path.resolve(root, rel);
    const size = fs.statSync(abs).size;
    if (size > MAX_UNTRACKED_BYTES) return MAX_UNTRACKED_LINES;
    if (size > budget.left) return 0; // request byte budget spent
    budget.left -= size;
    const text = fs.readFileSync(abs, 'utf8');
    if (text.includes('\0')) return 0; // binary: no line balance to report
    let n = 1;
    for (let i = 0; i < text.length && n < MAX_UNTRACKED_LINES; i++) {
      if (text.charCodeAt(i) === 10) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

function git(root, args) {
  return execFileAsync('git', ['-C', root, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 });
}

function intParam(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}
