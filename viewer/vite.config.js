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

export default {
  plugins: [devApiPlugin()],
};

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

  '/log': async ({ res, root, rel, params }) => {
    const pretty = `--pretty=format:%h${'\t'}%ct${'\t'}%an${'\t'}%s`;
    const start = intParam(params.get('start'), 0);
    const end = intParam(params.get('end'), 0);
    // A line range asks which commits touched those lines (`-L`); it cannot
    // be combined with --follow, and a range past EOF falls back to the file.
    const forFile = ['log', '-n', String(LOG_COUNT), '--follow', pretty, '--', rel];
    let stdout;
    if (start >= 1 && end >= start) {
      try {
        ({ stdout } = await git(root, ['log', '-n', String(LOG_COUNT), '--no-patch', `-L${start},${end}:${rel}`, pretty]));
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
    send(res, 200, { commits });
  },

  '/diff': async ({ res, root, rel, params }) => {
    const h = params.get('h') || '';
    if (!HASH_RE.test(h)) return send(res, 400, { error: 'invalid hash' });
    const { stdout } = await git(root, ['show', h, '--', rel]);
    send(res, 200, { diff: stdout.split('\n').slice(0, MAX_LINES).join('\n') });
  },

  // Working-tree state: modified / added / deleted / untracked (the "now" view).
  '/status': Object.assign(async ({ res, root }) => {
    const { stdout } = await git(root, ['status', '--porcelain']);
    const changes = stdout.split('\n').filter(Boolean).slice(0, 2000).map((line) => {
      const x = line[0] || ' ';
      const y = line[1] || ' ';
      let p = line.slice(3);
      const arrow = p.indexOf(' -> '); // renames: report the new path
      if (arrow >= 0) p = p.slice(arrow + 4);
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      return { path: p, x, y, untracked: x === '?' };
    });
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
