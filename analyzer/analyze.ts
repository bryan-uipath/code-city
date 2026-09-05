#!/usr/bin/env node
// Codebase analyzer -> viewer/public/data.json (see DESIGN.md for the contract).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import type {
  CityData, Commit, Edge, FileNode, FolderNode, MemberKind, ModuleInfo, ModuleMember, ModuleKind, ModuleRef, Pr, TreeNode,
} from '../shared/types.js';
import { collectDiffScope } from './diff-scope.js';

const execFileAsync = promisify(execFile);

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
const MARKDOWN_EXT = new Set(['.md', '.mdx']);
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.turbo', '.next',
  'test-results', '__snapshots__', 'generated', '__generated__', 'gen', 'playwright-report',
]);
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '.md', '/README.md', '/index.md'];
const FIX_RE = /\b(fix|fixes|fixed|bug|bugfix|hotfix)\b/i;
const HASH_RE = /^[0-9a-f]{7,40}$/;
const DAY = 86400;
const MAX_JSON_BYTES = 25 * 1024 * 1024;
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

/** Commit counts for one file. */
interface Churn {
  churn: number;
  fixChurn: number;
  recentChurn: number;
}

/** One history pass: the stream, the churn it implies, and how it was obtained. */
interface History {
  churn: Map<string, Churn>;
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

interface Options {
  repoPath: string;
  roots: string[];
  out: string;
  prs: boolean;
  /** `<base>..<head>` to mine into a diff scope, or null to skip the pass. */
  diff: string | null;
}

/** A folder node while it is still being built (children are indexed by name). */
interface FolderDraft extends FolderNode {
  children: TreeNode[];
  childMap?: Map<string, FolderDraft>;
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });

async function main(): Promise<void> {
  const started = Date.now();
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(opts.repoPath);
  if (!fs.existsSync(repoRoot)) throw new Error(`repo not found: ${repoRoot}`);

  const files = discoverFiles(repoRoot, opts.roots);
  if (!files.length) throw new Error('no source files found under roots: ' + opts.roots.join(','));
  const fileSet = new Set(files);

  const parsed = new Map<string, ParsedFile>(); // relPath -> { loc, modules, imports: [specifier] }
  for (const rel of files) parsed.set(rel, parseFile(path.join(repoRoot, rel), rel));

  const history = collectHistory(repoRoot, files);
  const commits = history.commits;
  const edges = buildEdges(repoRoot, opts.roots, parsed, fileSet);
  const tree = buildTree(repoRoot, files, parsed, history.churn);
  const prs = opts.prs ? await collectPRs(repoRoot, fileSet) : [];
  const diff = opts.diff ? collectDiffScope(repoRoot, opts.diff) : null;
  if (diff && diff.head !== gitHead(repoRoot)) {
    console.warn(`warn: --diff head ${diff.head.slice(0, 7)} is not the checkout's HEAD; files the range adds may be missing from the city`);
  }

  const data: CityData = {
    repo: {
      name: path.basename(repoRoot),
      root: repoRoot,
      analyzedAt: new Date().toISOString(),
      githubUrl: githubUrl(repoRoot),
    },
    tree,
    edges,
    prs,
    files,
    commits,
    ...(diff ? { diff } : {}),
  };

  const outPath = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  let json = JSON.stringify(data);
  // Budget guard: trim the oldest commits until the payload fits.
  while (json.length > MAX_JSON_BYTES && data.commits.length > 1) {
    data.commits = data.commits.slice(0, Math.floor(data.commits.length * 0.8));
    json = JSON.stringify(data);
  }
  const droppedCommits = commits.length - data.commits.length;
  fs.writeFileSync(outPath, json);

  const moduleCount = [...parsed.values()].reduce((n, f) => n + f.modules.length, 0);
  const last = data.commits[data.commits.length - 1];
  const oldest = last ? last.ts : null;
  console.log(
    `files: ${files.length}\nmodules: ${moduleCount}\nedges: ${edges.length}\nprs: ${prs.length}\n` +
    `commits: ${data.commits.length}${droppedCommits ? ` (dropped ${droppedCommits} oldest for size)` : ''}` +
    `${oldest ? ` back to ${new Date(oldest * 1000).toISOString().slice(0, 10)}` : ''}\n` +
    `history: cache ${history.cacheHit ? `hit (+${history.fresh} new commits)` : 'miss (full pass)'}` +
    ` in ${(history.ms / 1000).toFixed(1)}s\n` +
    `out: ${outPath} (${(json.length / 1e6).toFixed(2)} MB)\nelapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
  if (diff) {
    let v = 0, r = 0, n = 0;
    for (const f of diff.files) { v += f.verbatim; r += f.reshaped; n += f.new; }
    const adds = Math.max(v + r + n, 1);
    const pct = (x: number) => `${Math.round((100 * x) / adds)}%`;
    console.log(
      `diff scope: ${diff.files.length} files ${diff.base.slice(0, 7)}..${diff.head.slice(0, 7)}\n` +
      `  provenance +${adds} — verbatim ${v} (${pct(v)}) · reshaped ${r} (${pct(r)}) · new ${n} (${pct(n)})`
    );
  }
}

function parseArgs(argv: string[]): Options {
  let repoPath: string | null = null;
  let roots: string[] | null = null;
  let out = 'viewer/public/data.json';
  let prs = true;
  let diff: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--roots') roots = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') out = argv[++i] ?? out;
    else if (a === '--diff') {
      diff = argv[++i] ?? '';
      if (!diff || diff.startsWith('--')) throw new Error('--diff needs a range: --diff <base>..<head>');
    }
    else if (a === '--no-prs') prs = false;
    else if (!a.startsWith('--')) repoPath = a;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!repoPath) repoPath = '.';
  // Default roots: a `packages/` monorepo dir when present, else the repo root.
  if (!roots) {
    const hasPackages = fs.existsSync(path.join(path.resolve(repoPath), 'packages'));
    roots = hasPackages ? ['packages'] : ['.'];
  }
  return { repoPath, roots, out, prs, diff };
}

// ---------- discovery ----------

function discoverFiles(repoRoot: string, roots: string[]): string[] {
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
        if (!SOURCE_EXT.has(ext) && !MARKDOWN_EXT.has(ext)) continue;
        if (e.name.endsWith('.d.ts')) continue;
        found.push(toPosix(path.relative(repoRoot, full)));
      }
    }
  }
}

// ---------- TS parsing ----------

function parseFile(absPath: string, rel: string): ParsedFile {
  let text = '';
  try { text = fs.readFileSync(absPath, 'utf8'); } catch { /* unreadable */ }
  const loc = text ? text.split('\n').length : 0;
  const jsx = rel.endsWith('.tsx') || rel.endsWith('.jsx');
  const modules: ModuleInfo[] = [];
  const imports: string[] = [];
  if (!text) return { loc, modules, imports };
  if (MARKDOWN_EXT.has(path.extname(rel))) return parseMarkdown(text, loc);

  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true,
    jsx ? ts.ScriptKind.TSX : rel.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);

  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line;
  const spanLoc = (node: ts.Node) => Math.max(1, lineOf(node.getEnd()) - lineOf(node.getStart(sf)) + 1);
  const startLine = (node: ts.Node) => lineOf(node.getStart(sf)) + 1; // 1-based
  const isExported = (node: ts.Node) =>
    !!ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

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
      if (ts.isConstructorDeclaration(member)) { kind = 'method'; name = 'constructor'; }
      else if (ts.isMethodDeclaration(member)) kind = 'method';
      else if (ts.isPropertyDeclaration(member)) kind = 'property';
      else if (ts.isGetAccessor(member) || ts.isSetAccessor(member)) kind = 'accessor';
      else continue;
      name ??= memberName(member);
      if (!name) continue;
      out.push({ name, kind, loc: spanLoc(member), line: startLine(member) });
    }
    return out;
  };
  const memberChildren = (node: ts.InterfaceDeclaration | ts.EnumDeclaration): ModuleMember[] =>
    [...(node.members ?? [])].flatMap((member) => {
      const name = memberName(member);
      return name ? [{ name, kind: 'member' as MemberKind, loc: spanLoc(member), line: startLine(member) }] : [];
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
      if (name) add({ name, kind: jsx && isUpper(name) ? 'component' : 'function', loc: spanLoc(stmt), line: startLine(stmt), exported: isExported(stmt) }, stmt);
    } else if (ts.isClassDeclaration(stmt)) {
      const name = stmt.name?.text;
      if (name) add({ name, kind: 'class', loc: spanLoc(stmt), line: startLine(stmt), exported: isExported(stmt), children: classChildren(stmt) }, stmt);
    } else if (ts.isInterfaceDeclaration(stmt)) {
      add({ name: stmt.name.text, kind: 'interface', loc: spanLoc(stmt), line: startLine(stmt), exported: isExported(stmt), children: memberChildren(stmt) }, stmt);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      add({ name: stmt.name.text, kind: 'type', loc: spanLoc(stmt), line: startLine(stmt), exported: isExported(stmt) }, stmt);
    } else if (ts.isEnumDeclaration(stmt)) {
      add({ name: stmt.name.text, kind: 'enum', loc: spanLoc(stmt), line: startLine(stmt), exported: isExported(stmt), children: memberChildren(stmt) }, stmt);
    } else if (ts.isVariableStatement(stmt)) {
      const exported = isExported(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        const init = decl.initializer;
        const isFn = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        const kind: ModuleKind = isFn ? (jsx && isUpper(name) ? 'component' : 'function') : 'const';
        add({ name, kind, loc: spanLoc(decl), line: startLine(decl), exported }, decl);
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

// ---------- history (commit stream + churn) ----------

/**
 * Per-file churn and the newest-first commit stream, from one `git log --numstat`
 * pass — or, when the cache still lines up with HEAD, from the cached stream plus
 * a pass over `<cachedHead>..HEAD` only.
 */
function collectHistory(repoRoot: string, files: string[]): History {
  const started = Date.now();
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
  if (!commits) {
    commits = readLog(repoRoot, files, null) ?? [];
    fresh = commits.length;
  }
  if (head) writeCache(cachePath, { v: CACHE_VERSION, repoRoot, headHash: head, cutoffTs, files, commits });

  return { churn: countChurn(commits, files), commits, cacheHit: hit, fresh, ms: Date.now() - started };
}

/**
 * One `git log --numstat` pass, parsed against today's file index table.
 * @param range  a revision range (incremental) or null for the 12-month window
 * @returns null when git itself failed — the caller falls back to a full pass
 */
function readLog(repoRoot: string, files: string[], range: string | null): Commit[] | null {
  const args = ['-C', repoRoot, 'log', '--numstat', '--pretty=format:%x01%h%x09%ct%x09%an%x09%s'];
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

function countChurn(commits: Commit[], files: string[]): Map<string, Churn> {
  const churn = new Map<string, Churn>(); // rel -> {churn, fixChurn, recentChurn}
  const recentCutoff = Math.floor(Date.now() / 1000) - 30 * DAY;
  for (const commit of commits) {
    const isFix = FIX_RE.test(commit.s);
    const isRecent = commit.ts >= recentCutoff;
    for (const i of commit.f) {
      const rel = files[i];
      if (rel === undefined) continue;
      let c = churn.get(rel);
      if (!c) churn.set(rel, (c = { churn: 0, fixChurn: 0, recentChurn: 0 }));
      c.churn++;
      if (isFix) c.fixChurn++;
      if (isRecent) c.recentChurn++;
    }
  }
  return churn;
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

function isAncestor(repoRoot: string, older: string, newer: string): boolean {
  try {
    execFileSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', older, newer], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------- import edges ----------

function buildEdges(repoRoot: string, roots: string[], parsed: Map<string, ParsedFile>, fileSet: Set<string>): Edge[] {
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
    return { a: a ?? '', b: b ?? '', n };
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

function buildTree(repoRoot: string, files: string[], parsed: Map<string, ParsedFile>, churn: Map<string, Churn>): TreeNode {
  const root = folder('', path.basename(repoRoot));

  for (const rel of files) {
    const segs = rel.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      if (seg === undefined) continue;
      const p = segs.slice(0, i + 1).join('/');
      let child = node.childMap?.get(seg);
      if (!child) {
        child = folder(p, seg);
        node.childMap?.set(seg, child);
        node.children.push(child);
      }
      node = child;
    }
    const info = parsed.get(rel);
    if (!info) continue;
    const c = churn.get(rel) || { churn: 0, fixChurn: 0, recentChurn: 0 };
    node.children.push({
      type: 'file',
      name: segs[segs.length - 1] ?? rel,
      path: rel,
      loc: info.loc,
      churn: c.churn,
      fixChurn: c.fixChurn,
      recentChurn: c.recentChurn,
      modules: info.modules,
    });
  }

  for (const child of root.children) collapse(child); // keep the repo root node itself intact
  sum(root);
  strip(root);
  root.name = path.basename(repoRoot);
  root.path = ''; // repo root; children keep their real repo-relative paths
  return root;

  function folder(p: string, name: string): FolderDraft {
    return { type: 'folder', name, path: p, loc: 0, churn: 0, fixChurn: 0, recentChurn: 0, children: [], childMap: new Map() };
  }
}

// Collapse chains of single-child folders: name joins with "/", path = deepest folder path.
function collapse(node: TreeNode): void {
  if (node.type !== 'folder') return;
  for (;;) {
    const only = node.children.length === 1 ? node.children[0] : null;
    if (!only || only.type !== 'folder') break;
    node.name = node.name ? `${node.name}/${only.name}` : only.name;
    node.path = only.path;
    node.children = only.children;
  }
  for (const child of node.children) collapse(child);
}

function sum(node: TreeNode): TreeNode {
  if (node.type === 'file') return node;
  node.loc = 0; node.churn = 0; node.fixChurn = 0; node.recentChurn = 0;
  for (const child of node.children) {
    sum(child);
    node.loc += child.loc;
    node.churn += child.churn;
    node.fixChurn += child.fixChurn;
    node.recentChurn += child.recentChurn;
  }
  return node;
}

function strip(node: TreeNode): void {
  if (node.type !== 'folder') return;
  const draft: FolderDraft = node; // the build-time index lives on folder nodes only
  delete draft.childMap;
  for (const child of node.children) strip(child);
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
}

async function collectPRs(repoRoot: string, fileSet: Set<string>): Promise<Pr[]> {
  const repoSlug = githubSlug(repoRoot);
  if (!repoSlug) { console.warn('warn: no GitHub remote found, prs: []'); return []; }
  let list: GhPr[];
  try {
    const { stdout } = await execFileAsync('gh',
      ['pr', 'list', '--repo', repoSlug, '--state', 'open', '--limit', '50',
        '--json', 'number,title,author,isDraft,updatedAt,additions,deletions'],
      { maxBuffer: 32 * 1024 * 1024 });
    const parsed: unknown = JSON.parse(stdout);
    list = Array.isArray(parsed) ? parsed : [];
  } catch (err: unknown) {
    console.warn('warn: gh pr list failed, prs: []:', errMessage(err).split('\n')[0]);
    return [];
  }

  const results = await pool(list, 8, async (pr): Promise<Pr | null> => {
    let files: string[] = [];
    try {
      const { stdout } = await execFileAsync('gh',
        ['pr', 'view', String(pr.number), '--repo', repoSlug, '--json', 'files', '-q', '.files[].path'],
        { maxBuffer: 32 * 1024 * 1024 });
      files = stdout.split('\n').map((s) => s.trim()).filter((s) => fileSet.has(s));
    } catch { return null; }
    if (!files.length) return null;
    // Hunk line ranges place the PR inside a file; optional, so a failed diff
    // fetch only loses precision.
    let spans: Record<string, [number, number][]> | undefined;
    try {
      const { stdout } = await execFileAsync('gh', ['pr', 'diff', String(pr.number), '--repo', repoSlug], { maxBuffer: 64 * 1024 * 1024 });
      spans = hunkSpans(stdout, fileSet);
    } catch { /* keep file-level placement */ }
    const login = pr.author?.login || 'unknown';
    return {
      number: pr.number,
      title: pr.title,
      author: login,
      avatarUrl: pr.author?.avatarUrl || `https://github.com/${login}.png`,
      isDraft: !!pr.isDraft,
      updatedAt: pr.updatedAt ?? '',
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      files,
      ...(spans && Object.keys(spans).length ? { spans } : {}),
    };
  });
  return results.filter(isPr);
}

/** `+++ b/path` + `@@ -a,b +c,d @@` → head-side `[c, c+d-1]` per tree file. */
function hunkSpans(diff: string, fileSet: Set<string>): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {};
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim().replace(/^b\//, '');
      file = fileSet.has(p) ? p : null;
      continue;
    }
    if (!file || !line.startsWith('@@')) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isFinite(start) || len <= 0) continue;
    (out[file] ??= []).push([start, start + len - 1]);
  }
  return out;
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
