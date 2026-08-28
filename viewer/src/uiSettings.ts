/**
 * uiSettings.ts — remember the drawer choices (mode + layer toggles) across
 * sessions. Under the shell (city:// origin) they live with all other app
 * config in ~/.aicode via /api/uiSettings; standalone falls back to
 * localStorage, which can be absent (file://), so every access is guarded.
 */

export interface UiSettings {
  mode?: string;
  coupling?: boolean;
  people?: boolean;
  fx?: boolean;
  worktree?: boolean;
  follow?: boolean;
}

const KEY = 'city:ui-settings';
const CITY_SERVED = window.location.protocol === 'city:';

/** Last loaded/saved snapshot: saveUiSetting PUTs the whole object. */
let current: UiSettings = {};

export async function loadUiSettings(): Promise<UiSettings> {
  if (CITY_SERVED) {
    try {
      const res = await fetch('/api/uiSettings');
      if (res.ok) current = sanitize(await res.json());
    } catch {
      current = {};
    }
    return current;
  }
  try {
    const raw = window.localStorage.getItem(KEY);
    current = raw === null ? {} : sanitize(JSON.parse(raw));
  } catch {
    current = {};
  }
  return current;
}

export function saveUiSetting<K extends keyof UiSettings>(key: K, value: UiSettings[K]): void {
  current = { ...current, [key]: value };
  if (CITY_SERVED) {
    void fetch('/api/uiSettings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(current),
    }).catch(() => {});
    return;
  }
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable — settings just don't stick */
  }
}

function sanitize(parsed: unknown): UiSettings {
  if (typeof parsed !== 'object' || parsed === null) return {};
  const rec: Record<string, unknown> = { ...parsed };
  const out: UiSettings = {};
  if (typeof rec['mode'] === 'string') out.mode = rec['mode'];
  for (const k of ['coupling', 'people', 'fx', 'worktree', 'follow'] as const) {
    if (typeof rec[k] === 'boolean') out[k] = rec[k];
  }
  return out;
}
