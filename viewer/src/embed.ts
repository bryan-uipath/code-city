/**
 * embed.ts — the viewer as an instrument inside a host shell.
 *
 * Standalone, the city is a whole application: it carries its own inspector,
 * source pane, search palette and keyboard cheat-sheet. Embedded in a host
 * shell all of those jobs already belong to the host, so the viewer drops them
 * and keeps only what it alone can do — the 3D scene, the overlay controls,
 * the strata timeline, the breadcrumb trail.
 *
 * Activation is EXPLICIT: `?embed=1`, the host's `city://` protocol, or a VS
 * Code webview. Merely being framed does not count — an iframe of the static
 * export on some docs page must get the full standalone viewer, not a chrome-
 * stripped panel posting at a host that is not there. Every rule this module
 * adds is scoped to `body.embedded`.
 *
 * What it puts on screen:
 *   - a ☰ button that slides open a drawer holding the overlay/layer/legend
 *     controls plus a TIMELINE row (the resting view is city + breadcrumbs only,
 *     the strata timeline included)
 *   - a one-line selection chip with an "open ↗" affordance that hands the
 *     selection back to the shell over the bridge
 */
import type { OpenMode } from './bridge.js';
import type { Descriptor } from './sidebar.js';
import { CITY_SERVED } from './uiSettings.js';

/** True when the viewer is running as a panel inside a host shell. */
export const EMBEDDED = detectEmbedded();

/** The embed chrome, as far as the rest of the viewer is concerned. */
export interface EmbedUi {
  /** Pinned-selection sink; replaces the inspector while embedded. */
  setSelection(desc: Descriptor | null): void;
}

/**
 * Install the embed chrome. A no-op (and a no-op sink) when not embedded, so a
 * standalone run keeps exactly the DOM, CSS and keybindings it always had.
 */
export function initEmbed(opts: { openSelection(mode: OpenMode): void }): EmbedUi {
  if (!EMBEDDED) return { setSelection: () => {} };

  document.body.classList.add('embedded');

  const drawer = buildDrawer();
  const chip = buildChip(opts.openSelection);

  window.addEventListener('keydown', (e) => {
    if (isEditable(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // The drawer is a transient popover: Escape retires it before Escape gets
    // to mean "up one level" in the scene.
    if (e.key === 'Escape' && drawer.isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      drawer.close();
      return;
    }
    // 'o' is the bridge's own binding; Enter is the chip's. Shift keeps the
    // file in the city's own pane instead of opening one beside it.
    if (e.key === 'Enter' && chip.hasSelection()) {
      e.preventDefault();
      opts.openSelection(e.shiftKey ? 'tab' : 'split');
    }
  }, true);

  return { setSelection: (desc) => chip.set(desc) };
}

function detectEmbedded(): boolean {
  if (CITY_SERVED) return true;
  if (typeof Reflect.get(window, 'acquireVsCodeApi') === 'function') return true;
  try {
    return new URLSearchParams(window.location.search).get('embed') === '1';
  } catch {
    return false; /* an exotic location — treat as standalone */
  }
}

// ---------------------------------------------------------------------------
// Controls drawer
// ---------------------------------------------------------------------------

/**
 * Tuck the existing control stack behind a ☰ button. The `#controls` element is
 * *moved*, not rebuilt, so every listener the HUD bound to `#modes`, `#toggles`
 * and `#legend-body` keeps working untouched.
 */
function buildDrawer(): { isOpen(): boolean; close(): void } {
  const controls = document.getElementById('controls');

  const btn = document.createElement('button');
  btn.id = 'embed-menu';
  btn.type = 'button';
  btn.title = 'Overlays, layers, legend';
  btn.setAttribute('aria-expanded', 'false');
  btn.textContent = '☰';

  const panel = document.createElement('div');
  panel.id = 'embed-drawer';
  if (controls) {
    panel.appendChild(controls);
    addTimelineRow(controls);
  }

  // The button lives in the topbar strip so it lines up with the breadcrumb;
  // the drawer it opens is its own fixed layer.
  const topbar = document.getElementById('topbar');
  if (topbar) topbar.appendChild(btn);
  else document.body.appendChild(btn);
  document.body.appendChild(panel);

  const isOpen = (): boolean => panel.classList.contains('on');
  const set = (on: boolean): void => {
    panel.classList.toggle('on', on);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-expanded', String(on));
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    set(!isOpen());
  });
  // Clicking the city (or anything else outside) puts the drawer away.
  document.addEventListener('pointerdown', (e) => {
    if (!isOpen()) return;
    if (e.target instanceof Node && (panel.contains(e.target) || btn.contains(e.target))) return;
    set(false);
  });

  return { isOpen, close: () => set(false) };
}

/** Body class that reveals the strata timeline while embedded. */
const TIMELINE_ON = 'tl-on';

/**
 * The timeline is chrome the shell did not ask for, so embedded it starts
 * hidden and this row brings it back. It only flips a body class — whether the
 * timeline has any history to show stays timeline.ts's business.
 */
function addTimelineRow(controls: HTMLElement): void {
  const panel = document.createElement('div');
  panel.className = 'panel';

  const title = document.createElement('div');
  title.className = 'panel-title';
  title.textContent = 'View';

  const row = document.createElement('div');
  row.className = 'btnrow';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toggle';
  btn.textContent = 'Timeline';
  btn.setAttribute('aria-pressed', 'false');
  const led = document.createElement('i');
  led.className = 'led';
  btn.appendChild(led);

  btn.addEventListener('click', () => {
    const on = document.body.classList.toggle(TIMELINE_ON);
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
    // The sparkline measures its own track, which had no width while hidden.
    if (on) window.dispatchEvent(new Event('resize'));
  });

  row.appendChild(btn);
  panel.appendChild(title);
  panel.appendChild(row);
  controls.appendChild(panel);
}

// ---------------------------------------------------------------------------
// Selection chip
// ---------------------------------------------------------------------------

/**
 * The embedded stand-in for the inspector: one line of `path · loc · kind` and
 * an "open ↗" that sends the selection to the shell's editor. Text only — the
 * descriptor carries repository strings, so nothing here is ever parsed as HTML.
 */
function buildChip(openSelection: (mode: OpenMode) => void): {
  set(desc: Descriptor | null): void;
  hasSelection(): boolean;
} {
  const root = document.createElement('div');
  root.id = 'embed-chip';

  const label = document.createElement('span');
  label.className = 'txt';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'open';
  open.textContent = 'open ↗';
  open.title = 'Open beside the city (shift: open here)';
  open.addEventListener('click', (e) => {
    e.stopPropagation();
    openSelection(e.shiftKey ? 'tab' : 'split');
  });

  root.appendChild(label);
  root.appendChild(open);
  document.body.appendChild(root);

  let live = false;

  return {
    hasSelection: () => live,
    set(desc) {
      // A PR has no file to hand over, so it never raises the chip.
      live = desc !== null && desc.codePath !== null;
      root.classList.toggle('on', live);
      if (!desc) {
        label.textContent = '';
        return;
      }
      const parts = [desc.path];
      if (desc.loc !== undefined && Number.isFinite(desc.loc)) parts.push(`${desc.loc} loc`);
      if (desc.kind) parts.push(desc.kind);
      label.textContent = parts.join(' · ');
    },
  };
}

export function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement) || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable === true;
}
