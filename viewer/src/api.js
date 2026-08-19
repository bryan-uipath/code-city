/**
 * api.js — thin client for the dev-server git API.
 *
 * Every endpoint is optional: on a static host (or before the middleware
 * exists) the dev server answers with the SPA index.html, so a response is
 * only accepted when it is actually JSON. The first non-JSON answer disables
 * the endpoint family for the session and callers hide their sections.
 */

let available = null; // null = unknown, true/false once probed

/** @returns {boolean} false once the API has proven to be absent. */
export function apiAvailable() {
  return available !== false;
}

/** `GET /api/source` → `{ path, start, end, lines }` or null. */
export function fetchSource(path, start, end) {
  const q = new URLSearchParams({ path });
  if (start != null) q.set('start', String(start));
  if (end != null) q.set('end', String(end));
  return getJson('/api/source?' + q.toString());
}

/** `GET /api/log` → `{ commits: [{h, ts, a, s}] }` or null. */
export function fetchLog(path) {
  return getJson('/api/log?' + new URLSearchParams({ path }).toString());
}

/** `GET /api/diff` → `{ diff: string }` or null. */
export function fetchDiff(path, h) {
  return getJson('/api/diff?' + new URLSearchParams({ path, h }).toString());
}

async function getJson(url) {
  if (available === false) return null;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('json')) {
      if (res.status === 404 || !type.includes('json')) available = false;
      return null;
    }
    const json = await res.json();
    available = true;
    return json;
  } catch {
    available = false;
    return null;
  }
}
