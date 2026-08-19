/**
 * host.ts — the environment adapter the viewer talks to.
 *
 * The viewer never fetches anything itself: it asks a CityHost. `HttpHost` is
 * the browser implementation (data.json + the vite dev-server git API); a VS
 * Code webview would inject a postMessage-backed host with the same surface,
 * plus `openFile` to jump into the real editor.
 */
import type {
  CityData, DiffResponse, LogResponse, SearchResponse, SourceResponse,
} from './types.js';

export interface CityHost {
  /** The analyzed city. Rejects when no dataset is reachable. */
  loadData(): Promise<CityData>;
  /** Source lines of a repo-relative path, or null when unavailable. */
  getSource(path: string, start?: number, end?: number): Promise<SourceResponse | null>;
  /** Recent commits touching a path, or null when unavailable. */
  getLog(path: string): Promise<LogResponse | null>;
  /** `git show <hash> -- <path>`, or null when unavailable. */
  getDiff(path: string, hash: string): Promise<DiffResponse | null>;
  /** Content search over the repo, or null when unavailable. */
  search(q: string): Promise<SearchResponse | null>;
  /** False once the git-backed endpoints have proven to be absent. */
  available(): boolean;
  /** Optional capability: open the file in the surrounding editor. */
  openFile?(path: string, line?: number): void;
}

/**
 * Browser host. Every endpoint is optional: on a static host (or before the
 * middleware exists) the dev server answers with the SPA index.html, so a
 * response is only accepted when it is actually JSON. The first non-JSON answer
 * disables the endpoint family for the session and callers hide their sections.
 */
export class HttpHost implements CityHost {
  /** null = unknown, true/false once probed. */
  #available: boolean | null = null;

  async loadData(): Promise<CityData> {
    const res = await fetch('./data.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json: unknown = await res.json();
    if (!isCityData(json)) throw new Error('malformed data.json');
    return json;
  }

  getSource(path: string, start?: number, end?: number): Promise<SourceResponse | null> {
    const q = new URLSearchParams({ path });
    if (start != null) q.set('start', String(start));
    if (end != null) q.set('end', String(end));
    return this.#getJson<SourceResponse>('/api/source?' + q.toString());
  }

  getLog(path: string): Promise<LogResponse | null> {
    return this.#getJson<LogResponse>('/api/log?' + new URLSearchParams({ path }).toString());
  }

  getDiff(path: string, hash: string): Promise<DiffResponse | null> {
    return this.#getJson<DiffResponse>('/api/diff?' + new URLSearchParams({ path, h: hash }).toString());
  }

  /**
   * Content search stays out of the availability latch: it is the one endpoint
   * a user can trigger against a repo with no matches or no git grep, and that
   * must not disable the source/diff panes.
   */
  async search(q: string): Promise<SearchResponse | null> {
    try {
      const res = await fetch('/api/search?' + new URLSearchParams({ q }).toString(), { cache: 'no-cache' });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.includes('json')) return null;
      const json: unknown = await res.json();
      return isSearchResponse(json) ? json : null;
    } catch {
      return null;
    }
  }

  available(): boolean {
    return this.#available !== false;
  }

  async #getJson<T>(url: string): Promise<T | null> {
    if (this.#available === false) return null;
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.includes('json')) {
        if (res.status === 404 || !type.includes('json')) this.#available = false;
        return null;
      }
      const json = (await res.json()) as T;
      this.#available = true;
      return json;
    } catch {
      this.#available = false;
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Response shape checks
// ---------------------------------------------------------------------------

function isCityData(value: unknown): value is CityData {
  if (!isRecord(value)) return false;
  const tree = value.tree;
  return isRecord(tree) && typeof tree.type === 'string';
}

function isSearchResponse(value: unknown): value is SearchResponse {
  return isRecord(value) && Array.isArray(value.matches);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
