// Dev-only API for the viewer: routes /api/* to the dataset's provider, which
// owns the source (git today: viewer/providers/git.js). The server knows nothing
// of git. See DESIGN.md "Dev API (vite plugin, dev-server only)" and "Adapters".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitProvider } from './providers/git.js';

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
        const route = url.pathname.replace(/\/$/, '');
        const handler = ROUTES[route];
        if (!handler) return next();
        try {
          const provider = currentProvider();
          if (!provider) return send(res, 404, { error: 'data.json not found — run the analyzer first' });
          send(res, 200, await handler(provider, url.searchParams));
        } catch (err) {
          send(res, 400, { error: String(err?.message || err) });
        }
      });
    },
  };
}

// URL -> provider call. Raw query strings go through: validating them is the provider's job.
const ROUTES = {
  '/source': (p, q) => p.getDetail({ id: q.get('path'), start: q.get('start'), end: q.get('end') }),
  '/log': (p, q) => p.getHistory({ id: q.get('path'), start: q.get('start'), end: q.get('end') }),
  '/diff': (p, q) => p.getChange({ id: q.get('path'), event: q.get('h') }),
  '/rangediff': (p, q) => p.getRangeDiff({ id: q.get('path'), base: q.get('base'), head: q.get('head'), start: q.get('start'), end: q.get('end') }),
  '/status': (p, q) => p.getLive({ debug: q.get('debug') === '1' }),
  '/search': (p, q) => p.search({ q: q.get('q') }),
};

// ---------- helpers ----------

let cachedProvider = null;
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
    if (root && fs.existsSync(root)) cachedProvider = createGitProvider(root);
  } catch { /* not generated yet */ }
  return cachedProvider;
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(json);
}
