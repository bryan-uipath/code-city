/**
 * tour.ts — the tour player: a guided walk through the city.
 *
 * A Tour (see shared/tour.ts) is a list of steps; each one names a target in
 * the city, a camera treatment, some narration and optional artifacts. The
 * player owns the bottom-left HUD panel and the sidebar's TOUR section; the
 * city itself is driven entirely through the `TourHost` callbacks, which map
 * one-to-one onto machinery main.ts already had (reveal/fly, isolate, the
 * search-highlight recolor pass).
 *
 * Tours are UNTRUSTED input. Everything arrives through `validateTour`, and
 * narration reaches the DOM as escaped plain text — never as markup.
 */
import type { DiffResponse } from '../../shared/types.js';
import type { Tour, TourArtifact, TourDiff, TourStep, TourTarget } from '../../shared/tour.js';
import { parseTourTarget, validateTour } from '../../shared/tour.js';
import type { TourArtifactView, TourView } from './sidebar.js';

/** Seconds an autoplaying step is held before advancing. */
const AUTOPLAY_STEP = 8;
/** Only a relative, same-origin `.json` path may be fetched via `?tour=`. */
const SAFE_TOUR_PATH = /^(?:\.\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.json$/;

export interface TourHost {
  /** Select + fly to a target without drilling into it. False = not in this city. */
  frame(target: TourTarget): boolean;
  /** Fly to a target and isolate it (double-click semantics). */
  isolate(target: TourTarget): boolean;
  /** Dim the city down to these targets; null restores the active overlay. */
  highlight(targets: TourTarget[] | null): void;
  /** Slow automatic orbit while a step asks for it. */
  setOrbit(on: boolean): void;
  /** Register a callback fired whenever the *user* moves the camera. */
  onUserCamera(fn: () => void): void;
  /** Push the current step into the sidebar; null removes the section. */
  setView(view: TourView | null): void;
  /** `git show <hash> -- <path>` through the environment adapter. */
  getDiff(path: string, hash: string): Promise<DiffResponse | null>;
  /** Transient HUD message. */
  notice(msg: string): void;
  /** Called on exit, so the host can restore its normal sidebar/selection. */
  onExit(): void;
}

export interface TourPlayer {
  isActive(): boolean;
  /** Validate and start an unknown value as a tour. @returns false when unusable. */
  load(raw: unknown): boolean;
  next(): void;
  prev(): void;
  exit(): void;
  /** Autoplay clock, driven by the render loop. */
  tick(dt: number): void;
}

export function createTour(host: TourHost): TourPlayer {
  const el = buildDom();
  const state: {
    tour: Tour | null;
    step: number;
    autoplay: boolean;
    acc: number;
    /** Guards async artifact loads against a step change mid-flight. */
    token: number;
  } = { tour: null, step: 0, autoplay: false, acc: 0, token: 0 };

  el.prev.addEventListener('click', () => { pause(); go(state.step - 1); });
  el.next.addEventListener('click', () => { pause(); go(state.step + 1); });
  el.auto.addEventListener('click', () => setAutoplay(!state.autoplay));
  el.exit.addEventListener('click', exit);
  host.onUserCamera(pause);
  bindDragAndDrop();

  const player: TourPlayer = { isActive, load, next, prev, exit, tick };
  window.cityTour = {
    load: (tour: unknown) => load(tour),
    exit,
  };
  void loadFromQuery();
  return player;

  // --- lifecycle -----------------------------------------------------------

  function isActive(): boolean {
    return state.tour !== null;
  }

  function load(raw: unknown): boolean {
    const tour = validateTour(raw);
    if (!tour) {
      host.notice('Malformed tour — ignored');
      return false;
    }
    state.tour = tour;
    state.step = -1;
    state.autoplay = false;
    document.body.classList.add('touring');
    el.root.classList.add('on');
    go(0);
    return true;
  }

  function exit(): void {
    if (!state.tour) return;
    state.tour = null;
    state.step = 0;
    state.token++;
    setAutoplay(false);
    host.setOrbit(false);
    host.highlight(null);
    host.setView(null);
    document.body.classList.remove('touring');
    el.root.classList.remove('on');
    host.onExit();
  }

  function next(): void { go(state.step + 1); }
  function prev(): void { go(state.step - 1); }

  // --- steps ---------------------------------------------------------------

  function go(i: number): void {
    const tour = state.tour;
    if (!tour) return;
    const step = tour.steps[Math.min(Math.max(i, 0), tour.steps.length - 1)];
    if (!step) return;
    state.step = Math.min(Math.max(i, 0), tour.steps.length - 1);
    state.acc = 0;
    const token = ++state.token;

    const target = parseTourTarget(step.target);
    const camera = step.camera ?? 'frame';
    const placed = camera === 'isolate' ? host.isolate(target) : host.frame(target);
    if (!placed) host.notice('Tour step target is not in this city: ' + step.target);
    host.setOrbit(camera === 'orbit');
    host.highlight([target, ...(step.highlight ?? []).map(parseTourTarget)]);

    renderHud(tour, step);
    host.setView(viewFor(tour, step, artifactViews(step, target, null)));
    void resolveArtifacts(step, target, token);
  }

  function viewFor(tour: Tour, step: TourStep, artifacts: TourArtifactView[]): TourView {
    return {
      title: tour.title,
      index: state.step + 1,
      count: tour.steps.length,
      stepTitle: step.title,
      narration: step.narration,
      artifacts,
    };
  }

  /** Everything but diff bodies, which need a round trip to the host. */
  function artifactViews(
    step: TourStep,
    target: TourTarget,
    diffs: Map<TourArtifact, string | null> | null
  ): TourArtifactView[] {
    const out: TourArtifactView[] = [];
    for (const a of step.artifacts ?? []) {
      if (a.type === 'diff') {
        const path = a.path ?? target.path;
        out.push({
          type: 'diff',
          label: `${a.commit.slice(0, 7)} · ${path}`,
          diff: diffs ? diffs.get(a) ?? null : null,
        });
      } else if (a.type === 'image') {
        out.push({ type: 'image', src: a.src, caption: a.caption ?? null });
      } else {
        out.push({ type: 'link', href: a.href, label: a.label });
      }
    }
    return out;
  }

  async function resolveArtifacts(step: TourStep, target: TourTarget, token: number): Promise<void> {
    const wanted = (step.artifacts ?? []).filter(isDiffArtifact);
    if (!wanted.length) return;
    const diffs = new Map<TourArtifact, string | null>();
    for (const a of wanted) {
      const res = await host.getDiff(a.path ?? target.path, a.commit);
      if (token !== state.token) return;
      diffs.set(a, res && typeof res.diff === 'string' ? res.diff : null);
    }
    const tour = state.tour;
    if (!tour || token !== state.token) return;
    host.setView(viewFor(tour, step, artifactViews(step, target, diffs)));
  }

  // --- autoplay ------------------------------------------------------------

  function setAutoplay(on: boolean): void {
    state.autoplay = on;
    state.acc = 0;
    el.auto.classList.toggle('on', on);
  }

  function pause(): void {
    if (state.autoplay) setAutoplay(false);
  }

  function tick(dt: number): void {
    const tour = state.tour;
    if (!tour || !state.autoplay) return;
    state.acc += dt;
    el.fill.style.width = `${Math.min(state.acc / AUTOPLAY_STEP, 1) * 100}%`;
    if (state.acc < AUTOPLAY_STEP) return;
    if (state.step >= tour.steps.length - 1) {
      setAutoplay(false);
      el.fill.style.width = '100%';
      return;
    }
    go(state.step + 1);
  }

  // --- HUD -----------------------------------------------------------------

  function renderHud(tour: Tour, step: TourStep): void {
    el.title.textContent = tour.title;
    el.count.textContent = `${state.step + 1} / ${tour.steps.length}`;
    el.name.textContent = step.title;
    el.prev.disabled = state.step === 0;
    el.next.disabled = state.step === tour.steps.length - 1;
    el.fill.style.width = state.autoplay ? '0%' : `${((state.step + 1) / tour.steps.length) * 100}%`;
  }

  // --- loading -------------------------------------------------------------

  /** `?tour=<relative .json path>` — same-origin relative paths only. */
  async function loadFromQuery(): Promise<void> {
    const raw = new URLSearchParams(window.location.search).get('tour');
    if (!raw) return;
    if (!SAFE_TOUR_PATH.test(raw) || raw.split('/').includes('..')) {
      host.notice('Refusing to load tour from ' + raw);
      return;
    }
    try {
      const res = await fetch('./' + raw.replace(/^\.\//, ''), { cache: 'no-cache' });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.includes('json')) throw new Error('HTTP ' + res.status);
      load(await res.json());
    } catch {
      host.notice('Tour not found: ' + raw);
    }
  }

  /** Drop a .json tour file anywhere on the window. */
  function bindDragAndDrop(): void {
    window.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      if (!/\.json$/i.test(file.name)) {
        host.notice('Drop a .json tour file');
        return;
      }
      void file.text().then(
        (text) => {
          try {
            load(JSON.parse(text));
          } catch {
            host.notice('Tour is not valid JSON');
          }
        },
        () => host.notice('Could not read ' + file.name)
      );
    });
  }
}

function isDiffArtifact(a: TourArtifact): a is TourDiff {
  return a.type === 'diff';
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

interface TourDom {
  root: HTMLElement;
  title: HTMLElement;
  count: HTMLElement;
  name: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  auto: HTMLButtonElement;
  exit: HTMLButtonElement;
  fill: HTMLElement;
}

function buildDom(): TourDom {
  const root = requireEl('tour');
  root.innerHTML =
    `<div class="t"><span id="tour-title"></span><em id="tour-count"></em></div>` +
    `<div id="tour-name"></div>` +
    `<div id="tour-bar"><i id="tour-fill"></i></div>` +
    `<div id="tour-btns">` +
    `<button id="tour-prev" type="button" title="Previous step (&larr;)">&#9664;</button>` +
    `<button id="tour-next" type="button" title="Next step (&rarr;)">&#9654;</button>` +
    `<button id="tour-auto" type="button" title="Autoplay">AUTO</button>` +
    `<button id="tour-exit" type="button" title="Exit tour (Esc)">EXIT</button>` +
    `</div>`;
  return {
    root,
    title: requireEl('tour-title'),
    count: requireEl('tour-count'),
    name: requireEl('tour-name'),
    prev: requireButton('tour-prev'),
    next: requireButton('tour-next'),
    auto: requireButton('tour-auto'),
    exit: requireButton('tour-exit'),
    fill: requireEl('tour-fill'),
  };
}

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} in the tour markup`);
  return el;
}

function requireButton(id: string): HTMLButtonElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing button #${id}`);
  return el;
}

declare global {
  interface Window {
    /** Live agent injection: `window.cityTour.load({title, steps})`. */
    cityTour?: { load(tour: unknown): boolean; exit(): void };
  }
}
