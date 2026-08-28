/**
 * bridge.ts — postMessage adapter for an embedding shell (the aicode Electron app).
 *
 * The viewer normally runs standalone; when it is loaded inside an iframe the
 * shell drives it over `window.postMessage` instead of the keyboard:
 *
 *   shell -> city   { source: 'aicode', type: 'refreshWorktree' }
 *                   { source: 'aicode', type: 'setWorktreeLayer', on }
 *                   { source: 'aicode', type: 'reveal', path, follow? }
 *   city  -> shell  { source: 'aicode-city', type: 'ready', embedded }
 *                   { source: 'aicode-city', type: 'openFile', path, line, mode }
 *                   { source: 'aicode-city', type: 'chordPrefix' }
 *                   { source: 'aicode-city', type: 'chordKey', key, ctrl }
 *                   { source: 'aicode-city', type: 'palette', mode }
 *                   { source: 'aicode-city', type: 'split', dir }
 *
 * The chord messages exist because the shell cannot see keystrokes inside this
 * cross-origin frame: ⌃W and the single key after it are forwarded verbatim and
 * the shell's own chord machine owns all the timing and meaning.
 *
 * Everything arriving from the parent is untrusted input: the origin has to be
 * on the allowlist, the payload has to carry our `source` tag, and every field
 * is checked with `typeof` before it is used.
 */
import type { CityData } from '../../shared/types.js';
import { EMBEDDED, isEditable } from './embed.js';
import { CITY_SERVED, loadUiSettings, saveUiSetting } from './uiSettings.js';

/**
 * Origins the shell may speak from. The dev shell serves the renderer on 5217;
 * a packaged Electron build loads it from disk, and `file://` pages report
 * exactly that string as `event.origin` (no host, no path).
 *
 * This frame's own origin is `city://viewer` when the shell serves it over its
 * custom protocol — that is the *parent* list, so it stays out of it.
 */
const ALLOWED_PARENT_ORIGINS = ['http://localhost:5217', 'http://127.0.0.1:5217', 'file://'];

/**
 * A `file://` document has an OPAQUE origin: its messages arrive with
 * `event.origin === 'null'` (the string), never 'file://'. Accepting 'null'
 * from arbitrary hosts would let any sandboxed frame through, so it is allowed
 * only when this frame itself is served over the shell's `city://` protocol
 * (CITY_SERVED) — there the parent can only be the Electron shell.
 */
function allowedParent(origin: string): boolean {
  if (ALLOWED_PARENT_ORIGINS.includes(origin)) return true;
  return CITY_SERVED && origin === 'null';
}

/** Follow mode: whether shell context reveals (`follow: true`) move the camera.
 *  Toggled from the ☰ Layers drawer; explicit reveals are never gated. */
let followOn = true;

/** Where the shell should put a file the city hands over. */
export type OpenMode = 'split' | 'tab';

/** The slice of the viewer the bridge is allowed to touch, injected by main.ts. */
export interface BridgeInternals {
  refreshWorktree(): Promise<void>;
  setWorktree(on: boolean): void;
  revealPath(path: string, opts?: { module?: string | null; line?: number }): boolean;
  /** True when a repo-relative path is part of the analyzed city (file or folder). */
  hasPath(path: string): boolean;
  /** Nearest folder node's path for a directory (collapsed chains, pruned
   *  depths), or null when nothing under the repo matches. */
  resolveDir(path: string): string | null;
  /** Repo-relative path of the pinned selection (file or folder), for follow dedupe. */
  selectedPath(): string | null;
  /** Repo-relative path (+ line) of the pinned selection, null when none. */
  getSelection(): { path: string; line?: number } | null;
  getData(): CityData | null;
}

/** The handle the viewer keeps on the bridge. */
export interface Bridge {
  /** Hand the pinned selection to the shell's editor (the chip's "open ↗"). */
  openSelection(mode: OpenMode): void;
}

/**
 * Install the shell bridge. A no-op when the viewer is not framed — standalone
 * runs must not grow an extra keybinding or a polling timer.
 */
export function installBridge(internals: BridgeInternals): Bridge {
  if (window.parent === window) return { openSelection: () => {} };

  window.addEventListener('message', (event: MessageEvent) => {
    if (!allowedParent(event.origin)) return;
    const msg = parseShellMessage(event.data);
    if (!msg) return;
    handle(msg, internals);
  });

  function openSelection(mode: OpenMode): void {
    const sel = internals.getSelection();
    const root = internals.getData()?.repo?.root;
    if (!sel || !root) return;
    post({
      source: 'aicode-city',
      type: 'openFile',
      path: root.replace(/\/$/, '') + '/' + sel.path,
      line: sel.line,
      mode,
    });
  }

  // 'o' opens beside the city; ⇧O opens as a tab in the city's own pane.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'o' && e.key !== 'O') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isEditable(e.target)) return;
    e.preventDefault();
    openSelection(e.shiftKey ? 'tab' : 'split');
  });

  installChordForwarding();

  // The Follow toggle lives with the other layer toggles; it only means
  // anything with a shell attached, so it surfaces here.
  const followBtn = document.getElementById('toggle-follow');
  if (followBtn) {
    followBtn.style.display = '';
    followBtn.addEventListener('click', () => {
      followOn = !followOn;
      followBtn.classList.toggle('active', followOn);
      saveUiSetting('follow', followOn);
    });
    void loadUiSettings().then((s) => {
      if (s.follow === undefined) return;
      followOn = s.follow;
      followBtn.classList.toggle('active', followOn);
    });
  }

  // No poller here: main.ts already re-reads `git status` on an interval.
  post({ source: 'aicode-city', type: 'ready', embedded: EMBEDDED });
  return { openSelection };
}

// ---------------------------------------------------------------------------
// Chord forwarding
// ---------------------------------------------------------------------------

/** How long a forwarded prefix keeps watching for its follow-up key. */
const CHORD_WINDOW_MS = 1500;

/** Keys that are only ever a modifier: they are not the chord's second key. */
const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'];

/**
 * Forward ⌃W (plus the one key after it) and ⌘P / ⌘⇧P to the shell. Nothing
 * else in the viewer is captured, and the shell decides what the keys mean.
 */
function installChordForwarding(): void {
  let pending = false;
  let timer = 0;

  window.addEventListener(
    'keydown',
    (e) => {
      // The shell's command palettes. The viewer's own palette is already off
      // in embed mode, so this frame has no competing binding.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        e.stopPropagation();
        post({ source: 'aicode-city', type: 'palette', mode: e.shiftKey ? 'commands' : 'files' });
        return;
      }
      // ⌘D / ⇧⌘D split the shell pane holding this frame.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        e.stopPropagation();
        post({ source: 'aicode-city', type: 'split', dir: e.shiftKey ? 'col' : 'row' });
        return;
      }
      // Leaf-independent shell shortcuts (⌘B sidebars, ⌘1-9 view tabs) must
      // work with this frame focused too; the shell replays them on its window.
      if (
        (e.metaKey || e.ctrlKey) && !e.altKey &&
        (e.key.toLowerCase() === 'b' || (!e.shiftKey && /^[1-9]$/.test(e.key)))
      ) {
        e.preventDefault();
        e.stopPropagation();
        post({ source: 'aicode-city', type: 'shellKey', key: e.key.toLowerCase(), shift: e.shiftKey });
        return;
      }
      if (pending) {
        if (MODIFIER_KEYS.includes(e.key)) return;
        window.clearTimeout(timer);
        pending = false;
        e.preventDefault();
        e.stopPropagation();
        post({ source: 'aicode-city', type: 'chordKey', key: e.key, ctrl: e.ctrlKey });
        return;
      }
      if (!e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'w') return;
      if (isEditable(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      pending = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        pending = false;
      }, CHORD_WINDOW_MS);
      post({ source: 'aicode-city', type: 'chordPrefix' });
    },
    true
  );
}

// ---------------------------------------------------------------------------
// Incoming
// ---------------------------------------------------------------------------

/** The messages the shell may send, after validation. */
type ShellMessage =
  | { type: 'refreshWorktree' }
  | { type: 'setWorktreeLayer'; on: boolean }
  | { type: 'reveal'; path: string; follow: boolean };

function handle(msg: ShellMessage, internals: BridgeInternals): void {
  switch (msg.type) {
    case 'refreshWorktree':
      void internals.refreshWorktree();
      return;
    case 'setWorktreeLayer':
      internals.setWorktree(msg.on);
      return;
    case 'reveal':
      try {
        let path = toRepoRelative(msg.path, internals.getData());
        // Watchers fire for gitignored files, other checkouts and paths the
        // analysis predates. A reveal nobody asked for must never raise the
        // viewer's "not in this city" notice, so check before asking. A cwd
        // that is not a node itself (some dirs hold no analyzed files) still
        // lands on its nearest real district.
        if (!internals.hasPath(path)) {
          const dir = internals.resolveDir(path);
          if (dir === null) return;
          path = dir;
        }
        // Follow re-reveals of the standing selection must not churn the camera.
        if (msg.follow && !followOn) return;
        if (msg.follow && internals.selectedPath() === path) return;
        internals.revealPath(path, {});
      } catch (err: unknown) {
        console.warn('[bridge] reveal failed:', err);
      }
      return;
  }
}

/** Narrow an untrusted `event.data` to a known message, or null. */
function parseShellMessage(data: unknown): ShellMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const rec: Record<string, unknown> = { ...data };
  if (rec['source'] !== 'aicode') return null;
  const type = rec['type'];
  if (type === 'refreshWorktree') return { type };
  if (type === 'setWorktreeLayer') {
    const on = rec['on'];
    return typeof on === 'boolean' ? { type, on } : null;
  }
  if (type === 'reveal') {
    const path = rec['path'];
    return typeof path === 'string' && path.length > 0 ? { type, path, follow: rec['follow'] === true } : null;
  }
  return null;
}

/** The shell speaks in absolute paths; the city is indexed by repo-relative ones. */
function toRepoRelative(path: string, data: CityData | null): string {
  const root = data?.repo?.root;
  if (!root) return path;
  const prefix = root.replace(/\/$/, '') + '/';
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// ---------------------------------------------------------------------------
// Outgoing
// ---------------------------------------------------------------------------

/** What the city tells the shell. */
type CityMessage =
  | { source: 'aicode-city'; type: 'ready'; embedded: boolean }
  | { source: 'aicode-city'; type: 'openFile'; path: string; line?: number; mode: OpenMode }
  | { source: 'aicode-city'; type: 'chordPrefix' }
  | { source: 'aicode-city'; type: 'chordKey'; key: string; ctrl: boolean }
  | { source: 'aicode-city'; type: 'palette'; mode: 'files' | 'commands' }
  | { source: 'aicode-city'; type: 'split'; dir: 'row' | 'col' }
  | { source: 'aicode-city'; type: 'shellKey'; key: string; shift: boolean };

/**
 * We do not know which of the allowed origins the shell actually is, and `'*'`
 * would leak the payload to any embedder — so aim at each candidate in turn and
 * let the mismatched ones throw or be dropped.
 */
function post(msg: CityMessage): void {
  // An opaque-origin parent (the built shell, loaded from file://) matches no
  // targetOrigin but '*'. Under city:// the parent can only be the shell, so
  // '*' leaks nothing; everywhere else keep the strict per-origin aim.
  if (CITY_SERVED) {
    window.parent.postMessage(msg, '*');
    return;
  }
  for (const origin of ALLOWED_PARENT_ORIGINS) {
    try {
      window.parent.postMessage(msg, origin);
    } catch {
      /* wrong origin for this shell — the next one may match */
    }
  }
}

