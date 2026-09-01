/**
 * bridge.ts — the viewer's host-shell protocol, over a pluggable transport.
 *
 * The viewer normally runs standalone; embedded in a host (an Electron shell
 * iframe, a VS Code webview) the host drives it with typed messages instead of
 * the keyboard:
 *
 *   host -> city   { source: 'city-host', type: 'refreshWorktree' }
 *                  { source: 'city-host', type: 'setWorktreeLayer', on }
 *                  { source: 'city-host', type: 'reveal', path, follow? }
 *   city -> host   { source: 'city', type: 'ready', embedded }
 *                  { source: 'city', type: 'openFile', path, line, mode }
 *                  { source: 'city', type: 'chordPrefix' }            (frame only)
 *                  { source: 'city', type: 'chordKey', key, ctrl }    (frame only)
 *                  { source: 'city', type: 'palette', mode }          (frame only)
 *                  { source: 'city', type: 'split', dir }             (frame only)
 *                  { source: 'city', type: 'shellKey', key, shift }   (frame only)
 *
 * The transport carries those messages and owns the trust decision:
 *   - `frameTransport` — `window.parent.postMessage` with an origin allowlist,
 *     for an iframe inside an Electron shell.
 *   - `vscodeTransport` — `acquireVsCodeApi()`, for a VS Code webview panel
 *     (only the extension host can post into a webview, so no origin check).
 *
 * The chord/palette/split forwarding is frame-shell-specific (that shell cannot
 * see keystrokes inside its cross-origin frame); a VS Code host owns its own
 * keybindings, so those hooks stay off there.
 *
 * Everything arriving from a host is untrusted input: the payload has to carry
 * the `city-host` source tag and every field is checked before use.
 */
import type { CityData } from '../../shared/types.js';
import { EMBEDDED, isEditable } from './embed.js';
import { CITY_SERVED, loadUiSettings, saveUiSetting } from './uiSettings.js';

/**
 * Origins a frame host may speak from. The dev shell serves its renderer on
 * 5217; a packaged Electron build loads it from disk, and `file://` pages
 * report exactly that string as `event.origin` (no host, no path).
 */
const ALLOWED_PARENT_ORIGINS = ['http://localhost:5217', 'http://127.0.0.1:5217', 'file://'];

/** Follow mode: whether host context reveals (`follow: true`) move the camera.
 *  Toggled from the ☰ Layers drawer; explicit reveals are never gated. */
let followOn = true;

/** Where the host should put a file the city hands over. */
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
  /** Hand the pinned selection to the host's editor (the chip's "open ↗"). */
  openSelection(mode: OpenMode): void;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/** How host messages travel. Implementations own the trust/origin decision. */
interface ShellTransport {
  kind: 'frame' | 'vscode';
  post(msg: CityMessage): void;
  onMessage(handler: (data: unknown) => void): void;
}

/**
 * The best transport for wherever the viewer finds itself, or null standalone.
 * Inside a webview the VS Code transport is EXCLUSIVE: falling through to the
 * frame transport there would swallow the host's ⌘ keys and post at origins
 * that are not listening.
 */
function createTransport(): ShellTransport | null {
  if (typeof Reflect.get(window, 'acquireVsCodeApi') === 'function') return vscodeTransport();
  return frameTransport();
}

/** Shared slot for the one-shot VS Code API: a host bootstrap that acquired it
 *  first can park it here; we park ours for the same reason. */
const VSCODE_API_SLOT = '__cityVsCodeApi';

/** VS Code webview: the API global exists only inside a webview panel. */
function vscodeTransport(): ShellTransport | null {
  let api: unknown = Reflect.get(window, VSCODE_API_SLOT);
  if (api === undefined) {
    const acquire: unknown = Reflect.get(window, 'acquireVsCodeApi');
    if (typeof acquire !== 'function') return null;
    // acquireVsCodeApi is one-shot per session: a second call throws. If the
    // webview's HTML bootstrap already took it (and did not share it via the
    // slot), the bridge stays off rather than killing the viewer.
    try {
      api = acquire.call(window);
    } catch {
      return null;
    }
    Reflect.set(window, VSCODE_API_SLOT, api);
  }
  if (typeof api !== 'object' || api === null) return null;
  const postFn: unknown = Reflect.get(api, 'postMessage');
  if (typeof postFn !== 'function') return null;
  return {
    kind: 'vscode',
    post: (msg) => postFn.call(api, msg),
    // Extension-host messages arrive as window messages; only the host can
    // post into a webview, so the payload tag is the only gate needed.
    onMessage: (handler) => {
      window.addEventListener('message', (event: MessageEvent) => handler(event.data));
    },
  };
}

/** Iframe inside an Electron shell: parent postMessage with an origin allowlist. */
function frameTransport(): ShellTransport | null {
  if (window.parent === window) return null;
  return {
    kind: 'frame',
    post: (msg) => {
      // An opaque-origin parent (the built shell, loaded from file://) matches
      // no targetOrigin but '*'. Under city:// the parent can only be the shell,
      // so '*' leaks nothing; everywhere else keep the strict per-origin aim.
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
    },
    onMessage: (handler) => {
      window.addEventListener('message', (event: MessageEvent) => {
        if (!allowedParent(event.origin)) return;
        handler(event.data);
      });
    },
  };
}

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

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * Install the host bridge. A no-op unless the viewer is explicitly embedded
 * (see `detectEmbedded`) AND a transport exists — a plain iframe of the static
 * export gets the full standalone viewer, no swallowed keys, no postMessages.
 */
export function installBridge(internals: BridgeInternals): Bridge {
  const transport = EMBEDDED ? createTransport() : null;
  if (!transport) return { openSelection: () => {} };

  transport.onMessage((data) => {
    const msg = parseHostMessage(data);
    if (msg) handle(msg, internals);
  });

  function openSelection(mode: OpenMode): void {
    const sel = internals.getSelection();
    const root = internals.getData()?.repo?.root;
    if (!sel || !root) return;
    transport?.post({
      source: 'city',
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

  if (transport.kind === 'frame') installChordForwarding(transport);

  // The Follow toggle lives with the other layer toggles; it only means
  // anything with a host attached, so it surfaces here.
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
  transport.post({ source: 'city', type: 'ready', embedded: EMBEDDED });
  return { openSelection };
}

// ---------------------------------------------------------------------------
// Chord forwarding (frame shell only)
// ---------------------------------------------------------------------------

/** How long a forwarded prefix keeps watching for its follow-up key. */
const CHORD_WINDOW_MS = 1500;

/** Keys that are only ever a modifier: they are not the chord's second key. */
const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'];

/**
 * Forward ⌃W (plus the one key after it) and ⌘P / ⌘⇧P to the frame shell,
 * which cannot see keystrokes inside this cross-origin frame. Nothing else in
 * the viewer is captured, and the shell decides what the keys mean.
 */
function installChordForwarding(transport: ShellTransport): void {
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
        transport.post({ source: 'city', type: 'palette', mode: e.shiftKey ? 'commands' : 'files' });
        return;
      }
      // ⌘D / ⇧⌘D split the shell pane holding this frame.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        e.stopPropagation();
        transport.post({ source: 'city', type: 'split', dir: e.shiftKey ? 'col' : 'row' });
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
        transport.post({ source: 'city', type: 'shellKey', key: e.key.toLowerCase(), shift: e.shiftKey });
        return;
      }
      if (pending) {
        if (MODIFIER_KEYS.includes(e.key)) return;
        window.clearTimeout(timer);
        pending = false;
        e.preventDefault();
        e.stopPropagation();
        transport.post({ source: 'city', type: 'chordKey', key: e.key, ctrl: e.ctrlKey });
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
      transport.post({ source: 'city', type: 'chordPrefix' });
    },
    true
  );
}

// ---------------------------------------------------------------------------
// Incoming
// ---------------------------------------------------------------------------

/** The messages a host may send, after validation. */
type HostMessage =
  | { type: 'refreshWorktree' }
  | { type: 'setWorktreeLayer'; on: boolean }
  | { type: 'reveal'; path: string; follow: boolean };

function handle(msg: HostMessage, internals: BridgeInternals): void {
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

/** Narrow an untrusted transport payload to a known message, or null. */
function parseHostMessage(data: unknown): HostMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const rec: Record<string, unknown> = { ...data };
  if (rec['source'] !== 'city-host') return null;
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

/** Hosts speak in absolute paths; the city is indexed by repo-relative ones. */
function toRepoRelative(path: string, data: CityData | null): string {
  const root = data?.repo?.root;
  if (!root) return path;
  const prefix = root.replace(/\/$/, '') + '/';
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// ---------------------------------------------------------------------------
// Outgoing
// ---------------------------------------------------------------------------

/** What the city tells its host. */
type CityMessage =
  | { source: 'city'; type: 'ready'; embedded: boolean }
  | { source: 'city'; type: 'openFile'; path: string; line?: number; mode: OpenMode }
  | { source: 'city'; type: 'chordPrefix' }
  | { source: 'city'; type: 'chordKey'; key: string; ctrl: boolean }
  | { source: 'city'; type: 'palette'; mode: 'files' | 'commands' }
  | { source: 'city'; type: 'split'; dir: 'row' | 'col' }
  | { source: 'city'; type: 'shellKey'; key: string; shift: boolean };
