#!/usr/bin/env node
// Codebase analyzer -> viewer/public/data.json (see DESIGN.md for the contract).
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';

const execFileAsync = promisify(execFile);

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.turbo', '.next',
  'test-results', '__snapshots__', 'generated', '__generated__', 'gen',
]);
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
const FIX_RE = /\b(fix|fixes|fixed|bug|bugfix|hotfix)\b/i;
const DAY = 86400;
const toPosix = (p) => p.split(path.sep).join('/');
const isUpper = (name) => /^[A-Z]/.test(name);

main().catch((err) => { console.error(err); process.exit(1); });

async function main() {
  const started = Date.now();
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(opts.repoPath);
  if (!fs.existsSync(repoRoot)) throw new Error(`repo not found: ${repoRoot}`);

  const files = discoverFiles(repoRoot, opts.roots);
  if (!files.length) throw new Error('no source files found under roots: ' + opts.roots.join(','));
  const fileSet = new Set(files);

  const parsed = new Map(); // relPath -> { loc, modules, imports: [specifier] }
  for (const rel of files) parsed.set(rel, parseFile(path.join(repoRoot, rel), rel));

  const churn = collectChurn(repoRoot, fileSet);
  const edges = buildEdges(repoRoot, opts.roots, parsed, fileSet);
  const tree = buildTree(repoRoot, files, parsed, churn);
  const prs = opts.prs ? await collectPRs(repoRoot, fileSet) : [];

  const data = {
    repo: {
      name: path.basename(repoRoot),
      root: repoRoot,
      analyzedAt: new Date().toISOString(),
      githubUrl: githubUrl(repoRoot),
    },
    tree,
    edges,
    prs,
  };

  const outPath = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const json = JSON.stringify(data);
  fs.writeFileSync(outPath, json);

  const moduleCount = [...parsed.values()].reduce((n, f) => n + f.modules.length, 0);
  console.log(
    `files: ${files.length}\nmodules: ${moduleCount}\nedges: ${edges.length}\nprs: ${prs.length}\n` +
    `out: ${outPath} (${(json.length / 1e6).toFixed(2)} MB)\nelapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
}

function parseArgs(argv) {
  const opts = { repoPath: null, roots: ['packages'], out: 'viewer/public/data.json', prs: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--roots') opts.roots = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--no-prs') opts.prs = false;
    else if (!a.startsWith('--')) opts.repoPath = a;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!opts.repoPath) throw new Error('usage: analyze.mjs <repoPath> [--roots a,b] [--out path] [--no-prs]');
  return opts;
}

// ---------- discovery ----------

function discoverFiles(repoRoot, roots) {
  const found = [];
  for (const root of roots) walk(path.join(repoRoot, root));
  return found.sort();

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue; // hidden dirs are tooling/generated
        walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name);
        if (!SOURCE_EXT.has(ext)) continue;
        if (e.name.endsWith('.d.ts')) continue;
        found.push(toPosix(path.relative(repoRoot, full)));
      }
    }
  }
}

// ---------- TS parsing ----------

function parseFile(absPath, rel) {
  let text = '';
  try { text = fs.readFileSync(absPath, 'utf8'); } catch { /* unreadable */ }
  const loc = text ? text.split('\n').length : 0;
  const jsx = rel.endsWith('.tsx') || rel.endsWith('.jsx');
  const modules = [];
  const imports = [];
  if (!text) return { loc, modules, imports };

  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true,
    jsx ? ts.ScriptKind.TSX : rel.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);

  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;
  const spanLoc = (node) => Math.max(1, lineOf(node.getEnd()) - lineOf(node.getStart(sf)) + 1);
  const isExported = (node) =>
    !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) imports.push(spec.text);
      continue;
    }
    if (ts.isFunctionDeclaration(stmt)) {
      const name = stmt.name?.text;
      if (name) modules.push({ name, kind: jsx && isUpper(name) ? 'component' : 'function', loc: spanLoc(stmt), exported: isExported(stmt) });
    } else if (ts.isClassDeclaration(stmt)) {
      const name = stmt.name?.text;
      if (name) modules.push({ name, kind: 'class', loc: spanLoc(stmt), exported: isExported(stmt) });
    } else if (ts.isInterfaceDeclaration(stmt)) {
      modules.push({ name: stmt.name.text, kind: 'interface', loc: spanLoc(stmt), exported: isExported(stmt) });
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      modules.push({ name: stmt.name.text, kind: 'type', loc: spanLoc(stmt), exported: isExported(stmt) });
    } else if (ts.isEnumDeclaration(stmt)) {
      modules.push({ name: stmt.name.text, kind: 'enum', loc: spanLoc(stmt), exported: isExported(stmt) });
    } else if (ts.isVariableStatement(stmt)) {
      const exported = isExported(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        const init = decl.initializer;
        const isFn = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        const kind = isFn ? (jsx && isUpper(name) ? 'component' : 'function') : 'const';
        modules.push({ name, kind, loc: spanLoc(decl), exported });
      }
    }
  }
  return { loc, modules, imports };
}

// ---------- churn ----------

function collectChurn(repoRoot, fileSet) {
  const churn = new Map(); // rel -> {churn, fixChurn, recentChurn}
  let out;
  try {
    out = execFileSync('git', ['-C', repoRoot, 'log', '--since=12.months', '--name-only', '--pretty=format:%x01%ct%x09%s'],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  } catch (err) {
    console.warn('warn: git log failed, churn will be zero:', err.message);
    return churn;
  }
  const recentCutoff = Math.floor(Date.now() / 1000) - 30 * DAY;
  let isFix = false, isRecent = false, seen = new Set();
  for (const line of out.split('\n')) {
    if (line.startsWith('\x01')) {
      const tab = line.indexOf('\t');
      const ts_ = Number(line.slice(1, tab));
      const subject = line.slice(tab + 1);
      isFix = FIX_RE.test(subject);
      isRecent = ts_ >= recentCutoff;
      seen = new Set();
      continue;
    }
    const rel = line.trim();
    if (!rel || !fileSet.has(rel) || seen.has(rel)) continue;
    seen.add(rel);
    let c = churn.get(rel);
    if (!c) churn.set(rel, (c = { churn: 0, fixChurn: 0, recentChurn: 0 }));
    c.churn++;
    if (isFix) c.fixChurn++;
    if (isRecent) c.recentChurn++;
  }
  return churn;
}

// ---------- import edges ----------

function buildEdges(repoRoot, roots, parsed, fileSet) {
  const pkgDirs = scanWorkspacePackages(repoRoot, roots);
  const counts = new Map();
  for (const [rel, info] of parsed) {
    for (const spec of info.imports) {
      const target = resolveSpecifier(repoRoot, rel, spec, pkgDirs, fileSet);
      if (!target || target === rel || !fileSet.has(target)) continue;
      const [a, b] = rel < target ? [rel, target] : [target, rel];
      const key = a + ' ' + b;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts].map(([key, n]) => {
    const [a, b] = key.split(' ');
    return { a, b, n };
  });
}

function scanWorkspacePackages(repoRoot, roots) {
  const map = new Map(); // package name -> abs dir
  const dirs = new Set([...roots.map((r) => path.join(repoRoot, r)), path.join(repoRoot, 'packages')]);
  for (const base of dirs) {
    let entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const pkgPath = path.join(base, e.name, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name) map.set(pkg.name, path.join(base, e.name));
      } catch { /* ignore */ }
    }
  }
  return map;
}

function resolveSpecifier(repoRoot, fromRel, spec, pkgDirs, fileSet) {
  if (spec.startsWith('.')) {
    return tryPaths(repoRoot, path.resolve(repoRoot, path.dirname(fromRel), spec), fileSet);
  }
  const parts = spec.split('/');
  const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
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

function packageEntries(dir) {
  const entries = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const v of [pkg.source, pkg.module, pkg.main, exportsMain(pkg.exports)]) {
      if (typeof v === 'string') entries.push(v.replace(/^\.\//, ''));
    }
  } catch { /* ignore */ }
  entries.push('src/index.ts', 'src/index.tsx', 'src/index.js', 'index.ts', 'index.tsx', 'index.js');
  return entries;
}

function exportsMain(exp) {
  if (typeof exp === 'string') return exp;
  if (!exp || typeof exp !== 'object') return null;
  const root = exp['.'] ?? exp;
  if (typeof root === 'string') return root;
  if (root && typeof root === 'object') {
    for (const k of ['source', 'import', 'module', 'default', 'require']) {
      const v = root[k];
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object' && typeof v.default === 'string') return v.default;
    }
  }
  return null;
}

function tryPaths(repoRoot, absBase, fileSet) {
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

function buildTree(repoRoot, files, parsed, churn) {
  const root = folder('', path.basename(repoRoot));

  for (const rel of files) {
    const segs = rel.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const p = segs.slice(0, i + 1).join('/');
      let child = node.childMap.get(segs[i]);
      if (!child) {
        child = folder(p, segs[i]);
        node.childMap.set(segs[i], child);
        node.children.push(child);
      }
      node = child;
    }
    const info = parsed.get(rel);
    const c = churn.get(rel) || { churn: 0, fixChurn: 0, recentChurn: 0 };
    node.children.push({
      type: 'file',
      name: segs[segs.length - 1],
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

  function folder(p, name) {
    return { type: 'folder', name, path: p, loc: 0, churn: 0, fixChurn: 0, recentChurn: 0, children: [], childMap: new Map() };
  }
}

// Collapse chains of single-child folders: name joins with "/", path = deepest folder path.
function collapse(node) {
  if (node.type !== 'folder') return;
  while (node.children.length === 1 && node.children[0].type === 'folder') {
    const only = node.children[0];
    node.name = node.name ? `${node.name}/${only.name}` : only.name;
    node.path = only.path;
    node.children = only.children;
  }
  for (const child of node.children) collapse(child);
}

function sum(node) {
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

function strip(node) {
  if (node.type !== 'folder') return;
  delete node.childMap;
  for (const child of node.children) strip(child);
}

// ---------- PRs ----------

async function collectPRs(repoRoot, fileSet) {
  const repoSlug = githubSlug(repoRoot);
  if (!repoSlug) { console.warn('warn: no GitHub remote found, prs: []'); return []; }
  let list;
  try {
    const { stdout } = await execFileAsync('gh',
      ['pr', 'list', '--repo', repoSlug, '--state', 'open', '--limit', '50',
        '--json', 'number,title,author,isDraft,updatedAt'],
      { maxBuffer: 32 * 1024 * 1024 });
    list = JSON.parse(stdout);
  } catch (err) {
    console.warn('warn: gh pr list failed, prs: []:', err.message.split('\n')[0]);
    return [];
  }

  const results = await pool(list, 8, async (pr) => {
    let files = [];
    try {
      const { stdout } = await execFileAsync('gh',
        ['pr', 'view', String(pr.number), '--repo', repoSlug, '--json', 'files', '-q', '.files[].path'],
        { maxBuffer: 32 * 1024 * 1024 });
      files = stdout.split('\n').map((s) => s.trim()).filter((s) => fileSet.has(s));
    } catch { return null; }
    if (!files.length) return null;
    const login = pr.author?.login || 'unknown';
    return {
      number: pr.number,
      title: pr.title,
      author: login,
      avatarUrl: pr.author?.avatarUrl || `https://github.com/${login}.png`,
      isDraft: !!pr.isDraft,
      updatedAt: pr.updatedAt,
      files,
    };
  });
  return results.filter(Boolean);
}

async function pool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

// ---------- misc ----------

function githubSlug(repoRoot) {
  try {
    const url = execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    return m ? m[1] : null;
  } catch { return null; }
}

function githubUrl(repoRoot) {
  const slug = githubSlug(repoRoot);
  return slug ? `https://github.com/${slug}` : null;
}

