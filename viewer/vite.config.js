// Dev-only API for the viewer: routes /api/<provider>/<route> (and the older
// unprefixed /api/<route>) to the provider data.json names, which owns the
// source. The server knows nothing of git. See DESIGN.md "Dev API (vite plugin,
// dev-server only)" and "Adapters".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitProvider } from './providers/git.js';
import { createNotesProvider } from './providers/notes.js';

const DATA_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public/data.json');

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
        // `/git/source` or `/source` (alias: older viewers and hosts).
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length < 1 || parts.length > 2) return next();
        const name = parts.length === 2 ? parts[0] : null;
        const route = parts[parts.length - 1];
        if (!Object.hasOwn(ROUTES, route)) return next();
        const { method, args } = ROUTES[route];
        try {
          const current = currentProvider();
          // A prefix must name the dataset's own provider: no reaching another one.
          if (!current) return send(res, 404, { error: 'data.json not found — run the analyzer first' });
          if (name !== null && name !== current.name) return send(res, 404, { error: 'not this dataset\'s provider' });
          const call = current.provider[method];
          if (typeof call !== 'function') return send(res, 501, { error: `${current.name} has no ${route}` });
          send(res, 200, await call(args(url.searchParams)));
        } catch (err) {
          send(res, 400, { error: String(err?.message || err) });
        }
      });
    },
  };
}

// Route -> provider method. Raw query strings go through: validating them is the
// provider's job. Items are asked for by `id` (the viewer's), `path` on the aliases.
const itemId = (q) => q.get('id') ?? q.get('path');
const ROUTES = {
  source: { method: 'getDetail', args: (q) => ({ id: itemId(q), start: q.get('start'), end: q.get('end') }) },
  log: { method: 'getHistory', args: (q) => ({ id: itemId(q), start: q.get('start'), end: q.get('end') }) },
  diff: { method: 'getChange', args: (q) => ({ id: itemId(q), event: q.get('h') }) },
  rangediff: {
    method: 'getRangeDiff',
    args: (q) => ({ id: itemId(q), base: q.get('base'), head: q.get('head'), start: q.get('start'), end: q.get('end') }),
  },
  status: { method: 'getLive', args: (q) => ({ debug: q.get('debug') === '1' }) },
  search: { method: 'search', args: (q) => ({ q: q.get('q') }) },
};

/** Providers by the name data.json gives (`repo.provider`); absent = git. */
const PROVIDERS = {
  git: createGitProvider,
  notes: createNotesProvider,
};

// ---------- helpers ----------

let cachedProvider = null; // { name, provider }
let cachedMtime = -1;
// Re-read when data.json changes: a re-analysis may point at another repo, or
// at none (a --snapshot city has root ''), and the old provider must not linger.
function currentProvider() {
  let mtime;
  try { mtime = fs.statSync(DATA_JSON).mtimeMs; } catch { return null; }
  if (mtime === cachedMtime) return cachedProvider;
  cachedMtime = mtime;
  cachedProvider = null;
  try {
    const data = JSON.parse(fs.readFileSync(DATA_JSON, 'utf8'));
    const root = data?.repo?.root;
    const name = data?.repo?.provider ?? 'git';
    // An unknown name gets nothing — never a fallback to git over its root.
    if (typeof name === 'string' && Object.hasOwn(PROVIDERS, name) && typeof root === 'string' && root && fs.existsSync(root)) {
      cachedProvider = { name, provider: PROVIDERS[name](root) };
    }
  } catch { /* not generated yet */ }
  return cachedProvider;
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(json);
}
