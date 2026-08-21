/**
 * checkpoints.ts — timeline annotations: "● milestone landed▍".
 *
 * A checkpoint (see shared/tour.ts) pins a caption to a moment in the repo's
 * history. While the timeline cursor moves — scrubbing, playback, or a
 * scripted sweep — each checkpoint fires as the cursor crosses its moment:
 * the title types on beside a pulsing dot, holds with a blinking caret, and
 * fades. Scrubbing backwards past a checkpoint re-arms it.
 *
 * Loading arms only the checkpoints ahead of the current cursor, so opening a
 * tour at "now" doesn't replay the whole history of captions. Fires that
 * bunch up (a fast sweep through a dense stretch) queue, and the hold
 * shortens while the queue is backed up.
 *
 * Checkpoint titles are untrusted (they arrive with tour JSON) — they reach
 * the DOM through textContent only.
 */
import type { TourCheckpoint } from '../../shared/tour.js';

/** Seconds a caption holds after typing finishes. */
const DEFAULT_HOLD = 1.6;
/** Hold while more captions are waiting behind this one. */
const CROWDED_HOLD = 1.0;
/** Type-on speed, characters per second. */
const TYPE_RATE = 55;
/** Fade-out seconds (matches the #checkpoint CSS transition). */
const FADE = 0.35;

export interface TimelineWindow {
  min: number;
  max: number;
}

export interface Checkpoints {
  /** Replace the loaded set; null clears. Only moments ahead of the cursor arm. */
  load(list: TourCheckpoint[] | null): void;
  /** Show a one-off caption now, in the same dress, independent of the timeline. */
  show(title: string, hold?: number): void;
  /** Drop the loaded set and anything on screen. */
  clear(): void;
  /** Whether a caption is showing or queued (lets a script wait for quiet). */
  busy(): boolean;
  /** Drive from the render loop with the live timeline cursor and range. */
  tick(dt: number, cursor: number | null, range: TimelineWindow | null): void;
}

interface Armed {
  cp: TourCheckpoint;
  fired: boolean;
}

interface Active {
  title: string;
  hold: number;
  /** 'type' → 'hold' → 'fade' */
  phase: 'type' | 'hold' | 'fade';
  t: number;
}

export function createCheckpoints(): Checkpoints {
  const rootEl = document.getElementById('checkpoint');
  const textEl = document.getElementById('cp-text');
  if (!rootEl || !textEl) throw new Error('missing #checkpoint markup');
  const root: HTMLElement = rootEl;
  const text: HTMLElement = textEl;

  const entries: Armed[] = [];
  const queue: Array<{ title: string; hold?: number }> = [];
  let active: Active | null = null;
  /** Arm against the cursor on the first tick after load. */
  let mustArm = false;
  let lastCursor = Infinity;

  return { load, show, clear, busy, tick };

  function load(list: TourCheckpoint[] | null): void {
    entries.length = 0;
    for (const cp of list ?? []) entries.push({ cp, fired: false });
    mustArm = true;
  }

  function show(title: string, hold?: number): void {
    queue.push({ title, hold });
  }

  function clear(): void {
    entries.length = 0;
    queue.length = 0;
    active = null;
    root.classList.remove('on');
  }

  function busy(): boolean {
    return active !== null || queue.length > 0;
  }

  function tick(dt: number, cursor: number | null, range: TimelineWindow | null): void {
    // null cursor is "live / now" — the far end of the range.
    const cur = cursor ?? (range ? range.max : Infinity);

    if (mustArm) {
      mustArm = false;
      lastCursor = cur;
      for (const e of entries) {
        const at = momentOf(e.cp, range);
        e.fired = at !== null && at <= cur;
      }
    }

    // Scrubbing backwards re-arms everything at or ahead of the cursor. The
    // bound is inclusive so that scrubbing onto a moment re-fires it — without
    // it, a checkpoint pinned to the very start of history could never play.
    if (cur < lastCursor) {
      for (const e of entries) {
        const at = momentOf(e.cp, range);
        if (at !== null && at >= cur) e.fired = false;
      }
    }
    lastCursor = cur;

    // Crossing several at once (a fast sweep) narrates them in the order the
    // history happened, not the order the tour file happened to list them.
    const due: Array<{ at: number; cp: TourCheckpoint }> = [];
    for (const e of entries) {
      if (e.fired) continue;
      const at = momentOf(e.cp, range);
      if (at === null || at > cur) continue;
      e.fired = true;
      due.push({ at, cp: e.cp });
    }
    due.sort((a, b) => a.at - b.at);
    for (const d of due) queue.push({ title: d.cp.title, hold: d.cp.hold });

    advance(dt);
  }

  // --- presentation ----------------------------------------------------------

  function advance(dt: number): void {
    if (!active) {
      const next = queue.shift();
      if (!next) return;
      active = { title: next.title, hold: next.hold ?? DEFAULT_HOLD, phase: 'type', t: 0 };
      text.textContent = '';
      root.classList.add('on');
    }

    active.t += dt;
    if (active.phase === 'type') {
      const shown = Math.min(Math.floor(active.t * TYPE_RATE), active.title.length);
      text.textContent = active.title.slice(0, shown);
      if (shown >= active.title.length) {
        active.phase = 'hold';
        active.t = 0;
      }
      return;
    }
    if (active.phase === 'hold') {
      const hold = queue.length ? Math.min(active.hold, CROWDED_HOLD) : active.hold;
      if (active.t < hold) return;
      // Cross-cut straight to the next caption when one is waiting.
      if (queue.length) {
        active = null;
        advance(0);
        return;
      }
      active.phase = 'fade';
      active.t = 0;
      root.classList.remove('on');
      return;
    }
    if (active.t >= FADE) active = null;
  }
}

/** A checkpoint's moment in epoch seconds, or null when unresolvable. */
function momentOf(cp: TourCheckpoint, range: TimelineWindow | null): number | null {
  if (typeof cp.ts === 'number') return cp.ts;
  if (typeof cp.at === 'number' && range) return range.min + cp.at * (range.max - range.min);
  return null;
}
