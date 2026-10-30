/**
 * git.ts — the git adapter: a TS/JS/markdown repo at HEAD as a Snapshot.
 * Files are leaves (mass = lines, sections = parsed modules), commits are events
 * (with an incremental history cache), imports are links, open GitHub PRs are
 * the inflight work.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import type {
  Commit, DiffEntry, DiffScope, HunkHeader, MemberKind, ModuleInfo, ModuleMember, ModuleKind, ModuleRef, OffCity, Pr, PrStatus,
} from '../shared/types.js';
import { collectDiffScope, hunkHeaders, hunkSpans, zeroContextDiff } from './diff-scope.js';
import type { AdapterResult, Item, Link, SourceEvent } from './snapshot.js';

const execFileAsync = promisify(execFile);

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const MARKDOWN_EXT = new Set(['.md', '.mdx']);
/** Config/data files render as plain massing (loc only, no module interior) —
 *  without them a yaml-heavy repo (gitops, helm) is mostly invisible. */
const CONFIG_EXT = new Set(['.yaml', '.yml', '.json', '.toml']);
/** Machine-written files whose line counts would dwarf the real city. */
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'bun.lock', 'flake.lock', 'Cargo.lock']);
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.turbo', '.next',
  'test-results', '__snapshots__', 'generated', '__generated__', 'gen', 'playwright-report',
]);
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '.md', '/README.md', '/index.md'];
const FIX_RE = /\b(fix|fixes|fixed|bug|bugfix|hotfix)\b/i;
const HASH_RE = /^[0-9a-f]{7,40}$/;
const DAY = 86400;
/** Committed blobs read individually before the analyzer stops bothering. */
const MAX_HEAD_BLOBS = 4000;
const SUBJECT_MAX = 100;
/** Rolling history window; the cached stream is trimmed to it on every run. */
const HISTORY_DAYS = 365;
const CACHE_VERSION = 1;
/** This project's root — the cache lives here, never inside the analyzed repo. */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toPosix = (p: string) => p.split(path.sep).join('/');
const isUpper = (name: string) => /^[A-Z]/.test(name);

/** Per-file parse result: line count, top-level modules, import specifiers. */
interface ParsedFile {
  loc: number;
  modules: ModuleInfo[];
  imports: string[];
}

/** One history pass: the stream, and how it was obtained. */
interface History {
  commits: Commit[];
  cacheHit: boolean;
  /** Commits parsed from git on this run (the whole stream on a miss). */
  fresh: number;
  ms: number;
}

/** The on-disk incremental cache: one processed stream per analyzed repo root. */
interface HistoryCache {
  v: number;
  repoRoot: string;
  /** The analyzed repo's HEAD when the stream was written. */
  headHash: string;
  cutoffTs: number;
  /** Index table for the cached commits — reindexed against today's files. */
  files: string[];
  commits: Commit[];
}

export interface GitOptions {
  repoPath: string;
  roots: string[];
  prs: boolean;
  /** First-paint mode: cap the history pass, skip PRs, leave the cache alone. */
  quick: boolean;
  /** `<base>..<head>` to mine into a diff scope, or null to skip the pass. */
  diff: string | null;
}

/** Commits the --quick pass reads — enough for churn heat and some strata. */
const QUICK_COMMITS = 1000;
/** Hard ceiling for the full pass: monorepos can hold 250k+ commits in the
 *  12-month window, and an uncapped `git log --numstat` over that runs for
 *  minutes and can overflow the exec buffer. */
const FULL_COMMITS_MAX = 20000;

export async function collectGit(opts: GitOptions): Promise<AdapterResult> {
  const repoRoot = path.resolve(opts.repoPath);
  if (!fs.existsSync(repoRoot)) throw new Error(`repo not found: ${repoRoot}`);

  const files = discoverFiles(repoRoot, opts.roots);
  if (!files.length) throw new Error('no source files found under roots: ' + opts.roots.join(','));
  const fileSet = new Set(files);

  // The dataset is HEAD, not the working tree (see `discoverFiles`), so some of
  // these files may not exist on disk right now; `readSource` falls back to the
  // committed blob for those.
  const parsed = new Map<string, ParsedFile>(); // relPath -> { loc, modules, imports: [specifier] }
  const fromHead = { count: 0, skipped: 0 };
  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    parsed.set(rel, parseFile(abs, rel, readSource(repoRoot, rel, abs, fromHead)));
  }
  if (fromHead.count || fromHead.skipped) {
    console.log(`base: ${fromHead.count} file(s) read from HEAD (absent from the working tree)` +
      `${fromHead.skipped ? `, ${fromHead.skipped} skipped over the blob budget` : ''}`);
  }

  const history = collectHistory(repoRoot, files, opts.quick);
  const asOf = Math.floor(Date.now() / 1000); // churn's recency reference: when history was read
  const edges = buildEdges(repoRoot, opts.roots, parsed, fileSet);
  const prs = opts.prs && !opts.quick ? await collectPRs(repoRoot, fileSet) : [];
  const diff = opts.diff ? collectDiffScope(repoRoot, opts.diff) : null;
  if (diff?.manifest) annotateManifest(diff.manifest, fileSet, opts.roots);
  if (diff && diff.head !== gitHead(repoRoot)) {
    console.warn(`warn: --diff head ${diff.head.slice(0, 7)} is not the checkout's HEAD; files the range adds may be missing from the city`);
  }
  if (diff) mapWorktree(repoRoot, diff, fileSet);

  return {
    snapshot: {
      source: { name: path.basename(repoRoot), root: repoRoot, url: githubUrl(repoRoot) },
      items: treeItems(path.basename(repoRoot), files, parsed),
      events: history.commits.map((c) => eventOf(c, files)),
      asOf,
      // Paths are the item ids, so edges and PRs pass through as-is.
      links: edges,
      inflight: prs,
      ...(diff ? { diff } : {}),
    },
    summary: [
      `history: cache ${history.cacheHit ? `hit (+${history.fresh} new commits)` : 'miss (full pass)'}` +
        ` in ${(history.ms / 1000).toFixed(1)}s`,
    ],
  };
}

// ---------- discovery ----------

/**
 * The dataset's base is the LAST COMMIT, not the working tree.
 *
 * This is what makes the working-tree layer able to say anything about a
 * deletion: a file enumerated from the current tree simply is not there once it
 * has been `rm`ed, so its plot would vanish from the city and `git status` would
 * have nothing to mark. Enumerating HEAD keeps the mass standing and lets the
 * status overlay demolish it. The other side of the same coin: untracked files
 * are deliberately NOT in the base — they reach the city only as the overlay's
 * net-new "under construction" buildings.
 *
 * Falls back to the index (a repo with no commit yet) and then to an fs walk
 * (not a git repo at all).
 */
function discoverFiles(repoRoot: string, roots: string[]): string[] {
  // An empty listing is not authoritative — a repo whose sources are all
  // untracked/gitignored still deserves the fs-walk city it used to get.
  // Roots are directories, not pathspecs: literal, so `app/[id]` or `src/*` mean
  // what they say in every listing and agree with annotateManifest's prefix test.
  const headFiles = gitFiles(repoRoot, ['--literal-pathspecs', 'ls-tree', '-r', 'HEAD', '--name-only', '-z', '--', ...roots]);
  if (headFiles !== null && headFiles.length) return headFiles;
  const indexFiles = gitFiles(repoRoot, ['--literal-pathspecs', 'ls-files', '--cached', '-z', '--', ...roots]);
  if (indexFiles !== null && indexFiles.length) return indexFiles;
  const found: string[] = [];
  for (const root of roots) walk(path.join(repoRoot, root));
  return found.sort();

  function walk(dir: string): void {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue; // hidden dirs are tooling/generated
        walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name);
        if (!SOURCE_EXT.has(ext) && !MARKDOWN_EXT.has(ext) && !CONFIG_EXT.has(ext)) continue;
        if (e.name.endsWith('.d.ts') || SKIP_FILES.has(e.name)) continue;
        found.push(toPosix(path.relative(repoRoot, full)));
      }
    }
  }
}

/**
 * Source text for one dataset file.
 *
 * The working-tree copy wins whenever it exists: it is what the developer is
 * looking at, it is free to read, and for massing purposes the difference from
 * HEAD is a rounding error. A file the base has but the worktree does not — the
 * deletions this whole arrangement exists to keep visible — is read from the
 * commit instead, so its buildings still stand for the overlay to demolish.
 */
function readSource(repoRoot: string, rel: string, absPath: string, budget: { count: number; skipped: number }): string {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch { /* not in the working tree — fall through to HEAD */ }
  if (budget.count >= MAX_HEAD_BLOBS) {
    budget.skipped++;
    return '';
  }
  try {
    const text = execFileSync('git', ['show', `HEAD:${rel}`], {
      cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    budget.count++;
    return text;
  } catch {
    budget.skipped++;
    return ''; // loc 0: the plate still exists, it just has no massing
  }
}

/**
 * Run a NUL-separated git listing and apply the walk's own filters (extensions,
 * `SKIP_DIRS`, hidden and `dist-` directories). Enumerating through git is also
 * what keeps .gitignore honored — an fs walk drags in generated output.
 *
 * @returns null when the command fails (no git, no HEAD, …), so the caller can
 *          fall through to the next enumeration strategy.
 */
function gitFiles(repoRoot: string, args: string[]): string[] | null {
  let out: string;
  try {
    out = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  } catch {
    return null;
  }
  const found: string[] = [];
  for (const rel of out.split('\0')) {
    if (rel && isDatasetPath(rel)) found.push(toPosix(rel));
  }
  return found.sort();
}

/** The listing filters: a path of a kind, and in a directory, the city holds. */
function isDatasetPath(rel: string): boolean {
  const base = path.basename(rel);
  if (base.endsWith('.d.ts') || SKIP_FILES.has(base)) return false;
  const ext = path.extname(base);
  if (!SOURCE_EXT.has(ext) && !MARKDOWN_EXT.has(ext) && !CONFIG_EXT.has(ext)) return false;
  // Keep the walk's exclusions: SKIP_DIRS and hidden directories. Also skip
  // build-output variants like dist-viewer/ that repos forget to gitignore.
  const dirs = rel.split('/').slice(0, -1);
  return !dirs.some((d) => SKIP_DIRS.has(d) || d.startsWith('.') || d.startsWith('dist-'));
}

/**
 * Say why each changed path the city has no building for is missing — the
 * first reason that holds, in the order a reviewer would ask.
 */
function annotateManifest(entries: DiffEntry[], fileSet: Set<string>, roots: string[]): void {
  // `.` and `./src` normalize; `.github` must keep its dot.
  const prefixes = roots.map((r) => (r === '.' ? '' : r.replace(/^\.\//, '').replace(/\/+$/, '')));
  const underRoots = (p: string) => prefixes.some((r) => !r || p === r || p.startsWith(r + '/'));
  for (const e of entries) {
    // A building first: a deletion the checkout still holds (head ≠ HEAD) is still standing.
    const why: OffCity | null = fileSet.has(e.path) ? null
      : e.status === 'deleted' ? 'deleted'
      : e.binary ? 'binary'
      : !underRoots(e.path) ? 'outside-roots'
      : !isDatasetPath(e.path) ? 'filtered'
      : 'not-at-head';
    if (why) e.why = why;
  }
}

// ---------- TS parsing ----------

/**
 * Parse one dataset file. `text` is supplied rather than read here because the
 * base is HEAD: a file may have to come from the committed blob (see
 * `readSource`), and `absPath` is then only a name for the TS source file.
 */
function parseFile(absPath: string, rel: string, text: string): ParsedFile {
  const loc = text ? text.split('\n').length : 0;
  const jsx = rel.endsWith('.tsx') || rel.endsWith('.jsx');
  const modules: ModuleInfo[] = [];
  const imports: string[] = [];
  if (!text) return { loc, modules, imports };
  if (MARKDOWN_EXT.has(path.extname(rel))) return parseMarkdown(text, loc);
  // Config/data files: massing only — no TS parse, no module interior.
  if (CONFIG_EXT.has(path.extname(rel))) return { loc, modules, imports };

  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true,
    jsx ? ts.ScriptKind.TSX : /\.[mc]?ts$/.test(rel) ? ts.ScriptKind.TS : ts.ScriptKind.JS);

  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line;
  const spanLoc = (node: ts.Node) => Math.max(1, lineOf(node.getEnd()) - lineOf(node.getStart(sf)) + 1);
  const startLine = (node: ts.Node) => lineOf(node.getStart(sf)) + 1; // 1-based
  const isExported = (node: ts.Node) =>
    !!ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  // The interface as written in source, whitespace collapsed, capped.
  const src = (n: ts.Node | undefined): string => (n ? n.getText(sf).replace(/\s+/g, ' ') : '');
  const callSig = (n: ts.SignatureDeclarationBase): string =>
    `(${n.parameters.map((p) => src(p)).join(', ')})${n.type ? ': ' + src(n.type) : ''}`;
  const heritage = (n: ts.ClassDeclaration | ts.InterfaceDeclaration): string =>
    (n.heritageClauses ?? []).map((h) => src(h)).join(' ');
  const sigOf = (s: string): { sig?: string } => (s ? { sig: s.length > 200 ? s.slice(0, 199) + '…' : s } : {});
  const varSig = (decl: ts.VariableDeclaration): string => {
    const init = decl.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return callSig(init);
    if (decl.type) return ': ' + src(decl.type);
    return init ? '= ' + src(init).slice(0, 80) : '';
  };
  // Class methods/properties/accessors, interface members, enum members.
  const memberName = (member: ts.ClassElement | ts.TypeElement | ts.EnumMember): string | null => {
    const n = member.name;
    if (!n) return null;
    if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
    if (ts.isPrivateIdentifier(n)) return n.text;
    return null; // computed names
  };
  const classChildren = (node: ts.ClassDeclaration): ModuleMember[] => {
    const out: ModuleMember[] = [];
    for (const member of node.members ?? []) {
      let kind: MemberKind;
      let name: string | null = null;
      let sig = '';
      // `new (…)`: a constructor returns its class, not void.
      if (ts.isConstructorDeclaration(member)) { kind = 'method'; name = 'constructor'; sig = 'new ' + callSig(member); }
      else if (ts.isMethodDeclaration(member)) { kind = 'method'; sig = callSig(member); }
      else if (ts.isPropertyDeclaration(member)) { kind = 'property'; sig = member.type ? ': ' + src(member.type) : ''; }
      else if (ts.isGetAccessor(member) || ts.isSetAccessor(member)) { kind = 'accessor'; sig = callSig(member); }
      else continue;
      name ??= memberName(member);
      if (!name) continue;
      out.push({ name, kind, loc: spanLoc(member), line: startLine(member), ...sigOf(sig) });
    }
    return out;
  };
  const memberChildren = (node: ts.InterfaceDeclaration | ts.EnumDeclaration): ModuleMember[] =>
    [...(node.members ?? [])].flatMap((member) => {
      const name = memberName(member);
      if (!name) return [];
      const sig = ts.isMethodSignature(member) ? callSig(member)
        : ts.isPropertySignature(member) && member.type ? ': ' + src(member.type)
        : ts.isEnumMember(member) && member.initializer ? '= ' + src(member.initializer) : '';
      return [{ name, kind: 'member' as MemberKind, loc: spanLoc(member), line: startLine(member), ...sigOf(sig) }];
    });

  // Each module keeps its declaration node so refs can be mined once all names are known.
  const bodies: ts.Node[] = [];
  const add = (mod: ModuleInfo, node: ts.Node): void => { modules.push(mod); bodies.push(node); };
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) imports.push(spec.text);
      continue;
    }
    if (ts.isFunctionDeclaration(stmt)) {
      const name = stmt.name?.text;
      if (name) add({ name, kind: jsx && isUpper(name) ? 'component' : 'function', loc: spanLoc(stmt), line: startLine(stmt), exported: isExported(stmt), ...sigOf(callSig(stmt)) }, stmt);
    } else if (ts.isClassDeclaration(stmt)) {
      const name = stmt.name?.text;
      if (name) add({ name, kind: 'class', loc: spanLoc(stmt), line: startLine(stmt), exported: isExported(stmt), ...sigOf(heritage(stmt)), children: classChildren(stmt) }, stmt);
    } else if (ts.isInterfaceDeclaration(stmt)) {
      add({ name: stmt.name.text, kind: 'interface', loc: spanLoc(stmt), line: startLine(stmt), exported: isExported(stmt), ...sigOf(heritage(stmt)), children: memberChildren(stmt) }, stmt);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      add({ name: stmt.name.text, kind: 'type', loc: spanLoc(stmt), line: startLine(stmt), exported: isExported(stmt), ...sigOf('= ' + src(stmt.type)) }, stmt);
    } else if (ts.isEnumDeclaration(stmt)) {
      add({ name: stmt.name.text, kind: 'enum', loc: spanLoc(stmt), line: startLine(stmt), exported: isExported(stmt), ...sigOf(`${stmt.members.length} members`), children: memberChildren(stmt) }, stmt);
    } else if (ts.isVariableStatement(stmt)) {
      const exported = isExported(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        const init = decl.initializer;
        const isFn = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        const kind: ModuleKind = isFn ? (jsx && isUpper(name) ? 'component' : 'function') : 'const';
        add({ name, kind, loc: spanLoc(decl), line: startLine(decl), exported, ...sigOf(varSig(decl)) }, decl);
      }
    }
  }
  const names = new Set(modules.map((m) => m.name));
  modules.forEach((mod, i) => {
    const body = bodies[i];
    if (body) {
      const refs = siblingRefs(body, names, mod.name);
      if (refs.length) mod.refs = refs;
    }
  });
  return { loc, modules, imports };
}

/**
 * Which sibling top-level modules a declaration's body names, by identifier.
 * Lexical, not resolved: a shadowing local or a same-named property key reads
 * as a reference too — good enough for arcs, not for refactoring.
 */
function siblingRefs(body: ts.Node, names: Set<string>, self: string): ModuleRef[] {
  const counts = new Map<string, number>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && names.has(n.text) && n.text !== self) {
      const p = n.parent;
      // Naming a member declares/selects it (`obj.name`, `{ name: v }`, `name(): void`);
      // only a shorthand `{ name }` is a real read of the sibling.
      const member = !!p && (
        ts.isPropertyAccessExpression(p) ? p.name === n
          : ts.isQualifiedName(p) ? p.right === n
            : ts.isBindingElement(p) ? p.propertyName === n
              : (ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p)
                || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isEnumMember(p)
                || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)
                || ts.isJsxAttribute(p)) && p.name === n);
      if (!member) counts.set(n.text, (counts.get(n.text) ?? 0) + 1);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return [...counts].map(([name, n]) => ({ name, n }));
}

/**
 * Markdown: modules = headings (top depth found in the file), deeper headings
 * become their children; edges = relative links and [[wikilinks]] (emitted as
 * `wiki:<name>` specifiers, resolved against a basename map in buildEdges).
 */
function parseMarkdown(text: string, loc: number): ParsedFile {
  const lines = text.split('\n');
  const headings: Array<{ depth: number; title: string; line: number }> = [];
  const imports: string[] = [];
  let fenced = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h && h[1] && h[2]) headings.push({ depth: h[1].length, title: h[2], line: i + 1 });
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)#\s]+)[^)]*\)/g)) {
      const target = m[1] ?? '';
      if (target && !/^[a-z][a-z+.-]*:/i.test(target)) imports.push(target); // relative only
    }
    for (const m of line.matchAll(/\[\[([^\]|#]+)/g)) {
      const name = (m[1] ?? '').trim();
      if (name) imports.push('wiki:' + name);
    }
  }

  const modules: ModuleInfo[] = [];
  if (!headings.length) return { loc, modules, imports };
  const first = headings[0];
  let topDepth = first ? first.depth : 1;
  for (const h of headings) topDepth = Math.min(topDepth, h.depth);

  // Span of a heading: until the next heading at the same or a shallower depth.
  const spanEnd = (idx: number): number => {
    const at = headings[idx];
    if (!at) return loc;
    for (let j = idx + 1; j < headings.length; j++) {
      const next = headings[j];
      if (next && next.depth <= at.depth) return next.line - 1;
    }
    return loc;
  };

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!h || h.depth !== topDepth) continue;
    const children: ModuleMember[] = [];
    for (let j = i + 1; j < headings.length; j++) {
      const c = headings[j];
      if (!c || c.depth <= topDepth) break;
      children.push({ name: c.title, kind: 'member', loc: Math.max(spanEnd(j) - c.line + 1, 1), line: c.line });
    }
    modules.push({
      name: h.title,
      kind: 'section',
      loc: Math.max(spanEnd(i) - h.line + 1, 1),
      line: h.line,
      exported: true,
      ...(children.length ? { children } : {}),
    });
  }
  return { loc, modules, imports };
}

// ---------- history (commit stream) ----------

/**
 * The newest-first commit stream, from one `git log --numstat`
 * pass — or, when the cache still lines up with HEAD, from the cached stream plus
 * a pass over `<cachedHead>..HEAD` only.
 */
function collectHistory(repoRoot: string, files: string[], quick: boolean): History {
  const started = Date.now();
  // Quick pass: a capped log read, no cache involvement — a truncated stream
  // written to the cache would masquerade as the full one on the next run.
  if (quick) {
    const commits = readLog(repoRoot, files, null, QUICK_COMMITS) ?? [];
    return { commits, cacheHit: false, fresh: commits.length, ms: Date.now() - started };
  }
  const cutoffTs = Math.floor(Date.now() / 1000) - HISTORY_DAYS * DAY;
  const head = gitHead(repoRoot);
  const cachePath = cachePathFor(repoRoot);
  const cached = readCache(cachePath, repoRoot, files);

  let commits: Commit[] | null = null;
  let hit = false;
  let fresh = 0;
  if (cached && head && isAncestor(repoRoot, cached.headHash, head)) {
    const added = readLog(repoRoot, files, `${cached.headHash}..HEAD`);
    const kept = added ? reindexCached(cached, files) : null;
    if (added && kept) {
      fresh = added.length;
      commits = [...added, ...kept].filter((c) => c.ts >= cutoffTs);
      hit = true;
    }
  }
  let truncated = false;
  if (!commits) {
    commits = readLog(repoRoot, files, null, FULL_COMMITS_MAX) ?? [];
    fresh = commits.length;
    // At the cap the stream is cut mid-window; caching it would masquerade as
    // the full 12 months forever (incremental runs only ever prepend).
    truncated = commits.length >= FULL_COMMITS_MAX;
  }
  if (head && !truncated) writeCache(cachePath, { v: CACHE_VERSION, repoRoot, headHash: head, cutoffTs, files, commits });

  return { commits, cacheHit: hit, fresh, ms: Date.now() - started };
}

/**
 * One `git log --numstat` pass, parsed against today's file index table.
 * @param range  a revision range (incremental) or null for the 12-month window
 * @returns null when git itself failed — the caller falls back to a full pass
 */
function readLog(repoRoot: string, files: string[], range: string | null, limit?: number): Commit[] | null {
  const args = ['-C', repoRoot, 'log', '--numstat', '--pretty=format:%x01%h%x09%ct%x09%an%x09%s'];
  if (limit !== undefined) args.push('-n', String(limit));
  args.push(range ?? '--since=12.months');
  try {
    const out = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    return parseLog(out, files);
  } catch (err: unknown) {
    console.warn('warn: git log failed, churn/commits will be empty:', errMessage(err));
    return null;
  }
}

function parseLog(out: string, files: string[]): Commit[] {
  const fileIndex = new Map(files.map((rel, i) => [rel, i]));
  const commits: Commit[] = [];
  let current: Commit | null = null;
  let deltas: [number, number][] = [];
  let seen = new Set<string>();

  const flush = () => { if (current && current.f.length) commits.push(current); };

  for (const line of out.split('\n')) {
    if (line.startsWith('\x01')) {
      flush();
      const [h, tsStr, author, ...rest] = line.slice(1).split('\t');
      deltas = [];
      seen = new Set();
      current = {
        h: h ?? '', ts: Number(tsStr), a: author ?? '',
        s: rest.join('\t').slice(0, SUBJECT_MAX), f: [], d: deltas,
      };
      continue;
    }
    const stat = parseNumstat(line);
    if (!stat || !current) continue;
    const idx = fileIndex.get(stat.path);
    if (idx === undefined || seen.has(stat.path)) continue;
    seen.add(stat.path);
    current.f.push(idx);
    deltas.push([stat.adds, stat.dels]);
  }
  flush();
  return commits;
}

/** One numstat line: `adds\tdels\tpath`. Binary files (`-`) are skipped. */
function parseNumstat(line: string): { adds: number; dels: number; path: string } | null {
  const t1 = line.indexOf('\t');
  const t2 = t1 < 0 ? -1 : line.indexOf('\t', t1 + 1);
  if (t1 < 0 || t2 < 0) return null;
  const adds = Number(line.slice(0, t1));
  const dels = Number(line.slice(t1 + 1, t2));
  if (!Number.isFinite(adds) || !Number.isFinite(dels)) return null; // binary: "-"
  const rel = renameTarget(line.slice(t2 + 1).trim());
  return rel ? { adds, dels, path: rel } : null;
}

/**
 * Renames arrive as `old.ts => new.ts` or `dir/{a => b}/x.ts`; both resolve to
 * the new path, which is the one the file has in the analyzed tree.
 */
function renameTarget(raw: string): string {
  if (!raw.includes(' => ')) return raw;
  const braced = /^(.*)\{[^{}]* => ([^{}]*)\}(.*)$/.exec(raw);
  if (braced) return `${braced[1] ?? ''}${braced[2] ?? ''}${braced[3] ?? ''}`.replace(/\/{2,}/g, '/');
  return raw.slice(raw.lastIndexOf(' => ') + 4);
}

/** A commit as a snapshot event: touches name file paths (the item ids). */
function eventOf(c: Commit, files: string[]): SourceEvent {
  const touches = c.f.flatMap((idx, i) => {
    const rel = files[idx];
    const [adds, dels] = c.d?.[i] ?? [0, 0];
    return rel === undefined ? [] : [{ item: rel, adds, dels }];
  });
  return { id: c.h, ts: c.ts, actor: c.a, subject: c.s, rework: FIX_RE.test(c.s), touches };
}

// ---------- history cache ----------

/** `<this project>/.codecity/<sha1 of the analyzed repo root>.json`. */
function cachePathFor(repoRoot: string): string {
  const key = crypto.createHash('sha1').update(repoRoot).digest('hex');
  return path.join(PROJECT_ROOT, '.codecity', `${key}.json`);
}

/**
 * The cached stream, or null when anything at all does not line up — a cache
 * miss is always silent, and costs only the full pass the analyzer did before.
 */
function readCache(cachePath: string, repoRoot: string, files: string[]): HistoryCache | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return null;
  }
  if (!isHistoryCache(raw) || raw.v !== CACHE_VERSION || raw.repoRoot !== repoRoot) return null;
  // The cached stream was already filtered to the file set of its run, so it can
  // only be reused when today's files are a subset of that one.
  const cachedFiles = new Set(raw.files);
  for (const rel of files) if (!cachedFiles.has(rel)) return null;
  return raw;
}

/** Cached commits re-pointed at today's `files` index table; null if malformed. */
function reindexCached(cache: HistoryCache, files: string[]): Commit[] | null {
  const indexOf = new Map(files.map((rel, i) => [rel, i]));
  const out: Commit[] = [];
  for (const commit of cache.commits) {
    if (!isCommit(commit)) return null;
    const f: number[] = [];
    const d: [number, number][] = [];
    const deltas = commit.d ?? [];
    for (let i = 0; i < commit.f.length; i++) {
      const cachedIdx = commit.f[i];
      const rel = cachedIdx === undefined ? undefined : cache.files[cachedIdx];
      const idx = rel === undefined ? undefined : indexOf.get(rel);
      if (idx === undefined) continue;
      f.push(idx);
      d.push(deltas[i] ?? [0, 0]);
    }
    if (f.length) out.push({ h: commit.h, ts: commit.ts, a: commit.a, s: commit.s, f, d });
  }
  return out;
}

function writeCache(cachePath: string, cache: HistoryCache): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  } catch (err: unknown) {
    console.warn('warn: could not write the history cache:', errMessage(err));
  }
}

function isHistoryCache(value: unknown): value is HistoryCache {
  if (!isRecord(value)) return false;
  return typeof value.v === 'number'
    && typeof value.repoRoot === 'string'
    && typeof value.headHash === 'string' && HASH_RE.test(value.headHash)
    && typeof value.cutoffTs === 'number'
    && Array.isArray(value.files)
    && Array.isArray(value.commits);
}

function isCommit(value: unknown): value is Commit {
  if (!isRecord(value)) return false;
  return typeof value.h === 'string' && typeof value.ts === 'number'
    && typeof value.a === 'string' && typeof value.s === 'string'
    && Array.isArray(value.f) && (value.d === undefined || Array.isArray(value.d));
}

function gitHead(repoRoot: string): string | null {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** Paths per `git diff -- <paths>` call: well under ARG_MAX at any sane path length. */
const PATHS_PER_CALL = 500;

/**
 * Module lines are working-copy lines (`readSource`), spans are diff-head lines.
 * Record each changed file's working-copy edits against the diff head as `-U0`
 * headers (`DiffFile.worktree`) so the viewer can carry one onto the other. A
 * file read from the checkout's HEAD blob (absent on disk) has no working copy
 * to diff; only when that HEAD is not the diff head are its lines unmapped. A
 * file on disk but out of the index (`git rm --cached`) diffs as deleted, so it
 * is left unmapped too rather than mapped through a false whole-file deletion.
 */
function mapWorktree(repoRoot: string, diff: DiffScope, fileSet: Set<string>): void {
  const paths = diff.files.filter((f) => f.spans && fileSet.has(f.path)).map((f) => f.path);
  const onDisk = paths.filter((p) => fs.existsSync(path.join(repoRoot, p)));
  const edits: Record<string, HunkHeader[]> = Object.create(null);
  let unindexed = 0;
  for (let i = 0; i < onDisk.length; i += PATHS_PER_CALL) {
    const chunk = onDisk.slice(i, i + PATHS_PER_CALL);
    let indexed: Set<string>;
    let out: string;
    try {
      indexed = new Set(execFileSync('git', ['-C', repoRoot, '--literal-pathspecs', 'ls-files', '-z', '--', ...chunk], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      }).split('\0').filter(Boolean));
      const tracked = chunk.filter((p) => indexed.has(p));
      unindexed += chunk.length - tracked.length;
      if (!tracked.length) continue;
      out = zeroContextDiff(repoRoot, [diff.head], tracked);
    } catch {
      console.warn('warn: could not diff the working copy against --diff head; module-level hunk placement may be off');
      return;
    }
    Object.assign(edits, hunkHeaders(out, indexed));
  }
  for (const f of diff.files) {
    const e = Object.hasOwn(edits, f.path) ? edits[f.path] : undefined;
    if (e && e.length) f.worktree = e;
  }
  const missing = paths.length - onDisk.length;
  const unmapped = unindexed + (diff.head !== gitHead(repoRoot) ? missing : 0);
  if (unmapped) {
    console.warn(`warn: ${unmapped} diff file(s) could not be mapped to the working copy (absent from disk or the index); their module-level hunk placement may be off`);
  }
}

function isAncestor(repoRoot: string, older: string, newer: string): boolean {
  try {
    execFileSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', older, newer], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------- import edges ----------

function buildEdges(repoRoot: string, roots: string[], parsed: Map<string, ParsedFile>, fileSet: Set<string>): Link[] {
  const pkgDirs = scanWorkspacePackages(repoRoot, roots);
  // [[wikilink]] targets resolve by normalized markdown basename (first match wins).
  const wikiNorm = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
  const byBase = new Map<string, string>();
  for (const p of fileSet) {
    if (!p.endsWith('.md') && !p.endsWith('.mdx')) continue;
    const base = wikiNorm(path.basename(p).replace(/\.mdx?$/, ''));
    if (!byBase.has(base)) byBase.set(base, p);
  }
  const counts = new Map<string, number>();
  for (const [rel, info] of parsed) {
    for (const spec of info.imports) {
      const target = spec.startsWith('wiki:')
        ? byBase.get(wikiNorm(spec.slice(5))) ?? null
        : resolveSpecifier(repoRoot, rel, spec, pkgDirs, fileSet);
      if (!target || target === rel || !fileSet.has(target)) continue;
      const key = rel + ' ' + target; // ordered pair: a imports b
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts].map(([key, n]) => {
    const [a, b] = key.split(' ');
    return { from: a ?? '', to: b ?? '', n };
  });
}

function scanWorkspacePackages(repoRoot: string, roots: string[]): Map<string, string> {
  const map = new Map<string, string>(); // package name -> abs dir
  const dirs = new Set([...roots.map((r) => path.join(repoRoot, r)), path.join(repoRoot, 'packages')]);
  for (const base of dirs) {
    let entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const pkgPath = path.join(base, e.name, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      try {
        const pkg: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const name = isRecord(pkg) ? pkg.name : null;
        if (typeof name === 'string' && name) map.set(name, path.join(base, e.name));
      } catch { /* ignore */ }
    }
  }
  return map;
}

function resolveSpecifier(
  repoRoot: string, fromRel: string, spec: string, pkgDirs: Map<string, string>, fileSet: Set<string>
): string | null {
  if (spec.startsWith('.')) {
    return tryPaths(repoRoot, path.resolve(repoRoot, path.dirname(fromRel), spec), fileSet);
  }
  const parts = spec.split('/');
  const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec);
  const dir = pkgDirs.get(pkgName);
  if (!dir) return null;
  const sub = spec.slice(pkgName.length).replace(/^\//, '');
  if (sub) {
    return tryPaths(repoRoot, path.join(dir, sub), fileSet)
      || tryPaths(repoRoot, path.join(dir, 'src', sub), fileSet);
  }
  for (const entry of packageEntries(dir)) {
    const hit = tryPaths(repoRoot, path.join(dir, entry), fileSet);
    if (hit) return hit;
  }
  return null;
}

function packageEntries(dir: string): string[] {
  const entries: string[] = [];
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const fields = isRecord(pkg) ? [pkg.source, pkg.module, pkg.main, exportsMain(pkg.exports)] : [];
    for (const v of fields) {
      if (typeof v === 'string') entries.push(v.replace(/^\.\//, ''));
    }
  } catch { /* ignore */ }
  entries.push('src/index.ts', 'src/index.tsx', 'src/index.js', 'index.ts', 'index.tsx', 'index.js');
  return entries;
}

function exportsMain(exp: unknown): string | null {
  if (typeof exp === 'string') return exp;
  if (!isRecord(exp)) return null;
  const root = exp['.'] ?? exp;
  if (typeof root === 'string') return root;
  if (isRecord(root)) {
    for (const k of ['source', 'import', 'module', 'default', 'require']) {
      const v = root[k];
      if (typeof v === 'string') return v;
      if (isRecord(v) && typeof v.default === 'string') return v.default;
    }
  }
  return null;
}

function tryPaths(repoRoot: string, absBase: string, fileSet: Set<string>): string | null {
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = toPosix(path.relative(repoRoot, absBase + suffix));
    if (fileSet.has(candidate)) return candidate;
  }
  // ".js" specifier pointing at a ".ts" source
  const m = absBase.match(/\.(js|jsx)$/);
  if (m) {
    const stem = absBase.slice(0, -m[0].length);
    for (const suffix of ['.ts', '.tsx']) {
      const candidate = toPosix(path.relative(repoRoot, stem + suffix));
      if (fileSet.has(candidate)) return candidate;
    }
  }
  return null;
}

// ---------- tree ----------

/**
 * Files as snapshot items: each folder emitted the first time a path reaches it,
 * so sibling order is first-seen order. Ids are repo paths; the root is ''.
 */
function treeItems(rootName: string, files: string[], parsed: Map<string, ParsedFile>): Item[] {
  const items: Item[] = [{ id: '', parent: null, key: '', name: rootName, kind: 'folder', mass: 0 }];
  const seen = new Set<string>();
  for (const rel of files) {
    const info = parsed.get(rel);
    const segs = rel.split('/');
    for (let i = 0; i < segs.length - 1; i++) {
      const p = segs.slice(0, i + 1).join('/');
      if (seen.has(p)) continue;
      seen.add(p);
      const seg = segs[i] ?? p;
      items.push({ id: p, parent: segs.slice(0, i).join('/'), key: seg, name: seg, kind: 'folder', mass: 0 });
    }
    if (!info) continue;
    const name = segs[segs.length - 1] ?? rel;
    items.push({ id: rel, parent: segs.slice(0, -1).join('/'), key: name, name, kind: 'file', mass: info.loc, sections: info.modules });
  }
  return items;
}

// ---------- PRs ----------

/** The `gh pr list` fields the analyzer asks for. */
interface GhPr {
  number: number;
  title: string;
  author?: { login?: string; avatarUrl?: string };
  isDraft?: boolean;
  updatedAt?: string;
  additions?: number;
  deletions?: number;
  headRefOid?: string;
  /** `MERGEABLE` | `CONFLICTING` | `UNKNOWN`, when gh reports it. */
  mergeable?: string;
  /** Mixed CheckRun / StatusContext nodes; shape varies by CI provider. */
  statusCheckRollup?: GhCheck[];
}

/** `gh pr view --json files,mergeable,statusCheckRollup` for one PR. */
interface GhPrView {
  files?: Array<{ path?: string }>;
  mergeable?: string;
  statusCheckRollup?: GhCheck[];
}

/** A single check as `gh` reports it — CheckRun and StatusContext in one shape. */
interface GhCheck {
  /** CheckRun: QUEUED | IN_PROGRESS | COMPLETED | WAITING | PENDING | REQUESTED. */
  status?: string;
  /** CheckRun: SUCCESS | FAILURE | NEUTRAL | SKIPPED | CANCELLED | TIMED_OUT | … */
  conclusion?: string;
  /** StatusContext: SUCCESS | FAILURE | ERROR | PENDING | EXPECTED. */
  state?: string;
}

/** Check outcomes that make a PR red. */
const CHECK_FAILED = new Set([
  'FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE', 'ERROR',
]);
/** Check states that make a PR yellow. */
const CHECK_RUNNING = new Set(['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED', 'EXPECTED']);

/**
 * Derive the city's four-state PR color from whatever `gh` managed to say:
 * grey draft, red failing, yellow still running, green ready to merge.
 *
 * Every field is optional on purpose: the checks fetch is best-effort (an old
 * `gh` rejects the field; a huge rollup blows the buffer), and "we cannot see
 * the checks" is honestly `pending` — never an unearned green light.
 */
function prStatusOf(pr: GhPr): PrStatus {
  if (pr.isDraft) return 'draft';
  const rollup = pr.statusCheckRollup;
  if (!Array.isArray(rollup)) return 'pending';
  let running = false;
  for (const check of rollup) {
    const conclusion = (check?.conclusion || '').toUpperCase();
    const state = (check?.state || '').toUpperCase();
    if (CHECK_FAILED.has(conclusion) || CHECK_FAILED.has(state)) return 'failing';
    const status = (check?.status || '').toUpperCase();
    if (CHECK_RUNNING.has(status) || CHECK_RUNNING.has(state)) running = true;
    else if (!conclusion && !state && !status) running = true; // unrecognizable node
  }
  if (running) return 'pending';
  // Checks are green (or there are none). A conflicting branch is still not
  // something you can merge, so it keeps the red light rather than the green.
  if ((pr.mergeable || '').toUpperCase() === 'CONFLICTING') return 'failing';
  return 'ready';
}

async function collectPRs(repoRoot: string, fileSet: Set<string>): Promise<Pr[]> {
  const repoSlug = githubSlug(repoRoot);
  if (!repoSlug) { console.warn('warn: no GitHub remote found, prs: []'); return []; }
  let list: GhPr[];
  try {
    const { stdout } = await execFileAsync('gh',
      ['pr', 'list', '--repo', repoSlug, '--state', 'open', '--limit', '50',
        '--json', 'number,title,author,isDraft,updatedAt,additions,deletions,headRefOid'],
      { maxBuffer: 32 * 1024 * 1024 });
    const parsed: unknown = JSON.parse(stdout);
    list = Array.isArray(parsed) ? parsed : [];
  } catch (err: unknown) {
    console.warn('warn: gh pr list failed, prs: []:', errMessage(err).split('\n')[0]);
    return [];
  }

  // Files AND check state come from the per-PR view: asking `pr list` for
  // `statusCheckRollup` across 50 PRs returns tens of megabytes of check runs
  // and the query fails outright on a repo with a big CI matrix.
  const results = await pool(list, 8, async (pr): Promise<Pr | null> => {
    const ghView = async (fields: string): Promise<GhPrView | null> => {
      const { stdout } = await execFileAsync('gh',
        ['pr', 'view', String(pr.number), '--repo', repoSlug, '--json', fields],
        { maxBuffer: 32 * 1024 * 1024 });
      const parsed: unknown = JSON.parse(stdout);
      return isRecord(parsed) ? (parsed as GhPrView) : null;
    };
    let view: GhPrView | null = null;
    try {
      view = await ghView('files');
    } catch { return null; }
    // Check state is best-effort: a rollup too big for the buffer (or a gh too
    // old for the field) must not cost the PR its beam — just its color.
    try {
      const checks = await ghView('mergeable,statusCheckRollup');
      if (checks) view = { ...view, ...checks };
    } catch { /* status falls back to draft/pending */ }
    const files = (view?.files ?? [])
      .map((f) => String(f?.path ?? '').trim())
      .filter((s) => fileSet.has(s));
    if (!files.length) return null;
    // Hunk line ranges place the PR inside a file; optional, so a failed diff
    // fetch only loses precision.
    let spans: Record<string, [number, number][]> | undefined;
    try {
      const { stdout } = await execFileAsync('gh', ['pr', 'diff', String(pr.number), '--repo', repoSlug], { maxBuffer: 64 * 1024 * 1024 });
      // Line numbers are read against the checkout: head-side only when the
      // checkout already contains the PR head, otherwise the shared base side.
      const side = await contains(repoRoot, pr.headRefOid) ? 'head' : 'base';
      spans = hunkSpans(stdout, fileSet, side);
    } catch { /* keep file-level placement */ }
    const login = pr.author?.login || 'unknown';
    return {
      number: pr.number,
      title: pr.title,
      author: login,
      avatarUrl: pr.author?.avatarUrl || `https://github.com/${login}.png`,
      isDraft: !!pr.isDraft,
      status: prStatusOf({ ...pr, ...view }),
      updatedAt: pr.updatedAt ?? '',
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      files,
      ...(spans && Object.keys(spans).length ? { spans } : {}),
    };
  });
  return results.filter(isPr);
}

/** Is `oid` reachable from the checked-out HEAD? */
async function contains(repoRoot: string, oid: string | undefined): Promise<boolean> {
  if (!oid) return false;
  try {
    await execFileAsync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', oid, 'HEAD']);
    return true;
  } catch { return false; }
}

function isPr(pr: Pr | null | undefined): pr is Pr {
  return !!pr;
}

async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<Array<R | undefined>> {
  const out = new Array<R | undefined>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      const item = items[i];
      if (item === undefined) continue;
      out[i] = await fn(item);
    }
  }));
  return out;
}

// ---------- misc ----------

function githubSlug(repoRoot: string): string | null {
  try {
    const url = execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    return m?.[1] ?? null;
  } catch { return null; }
}

function githubUrl(repoRoot: string): string | null {
  const slug = githubSlug(repoRoot);
  return slug ? `https://github.com/${slug}` : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
