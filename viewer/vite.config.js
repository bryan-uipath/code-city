// Dev-only API for the viewer: source snippets, per-path git log, and diffs.
// See DESIGN.md "Dev API (vite plugin, dev-server only)".
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const DATA_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public/data.json');
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

export default ({ command }) => ({
  // Relative asset URLs so the bundle works wherever it is mounted: a static
  // host, and a host shell's `city://viewer/` custom protocol. Build only —
  // vite's dev server does not support a relative base.
  base: command === 'build' ? './' : '/',
  plugins: [devApiPlugin()],
});

function devApiPlugin() {
  return {
    name: 'codebase-visualizer-dev-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost');
        const route = url.pathname.replace(/\/$/, '');
        const handler = ROUTES[route];
        if (!handler) return next();
        try {
          const root = repoRoot();
          if (!root) return send(res, 404, { error: 'data.json not found — run the analyzer first' });
          let rel = null;
          if (!handler.noPath) {
            rel = safeRelPath(url.searchParams.get('path'), root);
            if (!rel) return send(res, 400, { error: 'invalid path' });
          }
          await handler({ res, root, rel, params: url.searchParams });
        } catch (err) {
          send(res, 400, { error: String(err?.message || err) });
        }
      });
    },
  };
}

const ROUTES = {
  '/source': async ({ res, root, rel, params }) => {
    const text = fs.readFileSync(path.resolve(root, rel), 'utf8');
    const all = text.split('\n');
    const total = all.length;
    const start = clamp(intParam(params.get('start'), 1), 1, total);
    const requestedEnd = clamp(intParam(params.get('end'), total), start, total);
    const end = Math.min(requestedEnd, start + MAX_LINES - 1);
    send(res, 200, { path: rel, start, end, total, lines: all.slice(start - 1, end) });
  },

  '/log': async ({ res, root, rel }) => {
    const { stdout } = await git(root, [
      'log', '-n', String(LOG_COUNT), '--follow',
      `--pretty=format:%h${'\t'}%ct${'\t'}%an${'\t'}%s`, '--', rel,
    ]);
    const commits = stdout.split('\n').filter(Boolean).map((line) => {
      const [h, ts, a, ...rest] = line.split('\t');
      return { h, ts: Number(ts), a, s: rest.join('\t') };
    });
    send(res, 200, { commits });
  },

  '/diff': async ({ res, root, rel, params }) => {
    const h = params.get('h') || '';
    if (!HASH_RE.test(h)) return send(res, 400, { error: 'invalid hash' });
    const { stdout } = await git(root, ['show', h, '--', rel]);
    send(res, 200, { diff: stdout.split('\n').slice(0, MAX_LINES).join('\n') });
  },

  // Working-tree state: modified / added / deleted / untracked (the "now" view),
  // each entry carrying the per-file line balance the city paints it with.
  '/status': Object.assign(async ({ res, root, params }) => {
    // -uall: expand untracked dirs to their files, so each gets its own entry.
    const { stdout } = await git(root, ['status', '--porcelain', '-uall']);
    if (params.get('debug') === '1') {
      const gitEnv = Object.keys(process.env).filter((k) => k.startsWith('GIT_'));
      return send(res, 200, { debugRoot: root, rawLines: stdout.split('\n').filter(Boolean).length, gitEnv });
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
    send(res, 200, { changes });
  }, { noPath: true }),

  // Content search over tracked source files (Ctrl+F in the viewer).
  '/search': Object.assign(async ({ res, root, params }) => {
    const q = (params.get('q') || '').trim();
    if (q.length < 2 || q.length > 200) return send(res, 400, { error: 'query must be 2–200 chars' });
    let stdout = '';
    try {
      ({ stdout } = await git(root, [
        'grep', '-I', '-i', '-n', '--max-count', '5', '--fixed-strings', '-e', q,
        '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs',
      ]));
    } catch {
      // git grep exits 1 when there are no matches
      return send(res, 200, { q, matches: [], truncated: false });
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
    send(res, 200, { q, matches, truncated });
  }, { noPath: true }),
};

// ---------- helpers ----------

let cachedRoot = null;
function repoRoot() {
  if (cachedRoot) return cachedRoot;
  try {
    const data = JSON.parse(fs.readFileSync(DATA_JSON, 'utf8'));
    const root = data?.repo?.root;
    if (root && fs.existsSync(root)) cachedRoot = root;
  } catch { /* not generated yet */ }
  return cachedRoot;
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

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(json);
}

function intParam(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}
