/**
 * timeline.ts — git history scrubber built on the v2 commit stream.
 *
 * The stream (`data.files` index table + `data.commits`) is indexed once into
 * per-file, ascending commit arrays; every query afterwards is a binary search,
 * so scrubbing and playback never rescan the log.
 *
 * Degrades to `enabled: false` (bar hidden) when the stream is absent (v1 data).
 */
import type { CityData } from '../../shared/types.js';

const DAY = 86400;
const WEEK = 7 * DAY;
export const RECENT_WINDOW = 30 * DAY;
/** Playback speed: one week of history per real-time second. */
const PLAY_RATE = WEEK;
/** A file "flashes" when it was touched this close to the cursor. */
export const FLASH_WINDOW = 2 * DAY;

/** A commit of the stream with its file paths resolved. */
export interface TimelineCommit {
  h: string;
  ts: number;
  a: string;
  s: string;
  paths: string[];
}

export interface Timeline {
  enabled: boolean;
  /** Time cursor in epoch seconds, or null when live ("now"). */
  cursor: number | null;
  /**
   * Start of the visible range in epoch seconds — only the second handle moves
   * it, and only Strata mode shows that handle. Every other mode reads `min`.
   */
  start: number;
  playing: boolean;
  min: number;
  max: number;
  commits: TimelineCommit[];
  byFile: Map<string, TimelineCommit[]>;
  commitsFor(path: string): TimelineCommit[];
  touchedSince(path: string, from: number, to: number): number;
  lastTouchBefore(path: string, t: number): number;
  commitsNear(t: number, path?: string | null, limit?: number): TimelineCommit[];
  tick(dt: number): void;
  /** Reveal (or hide) the range start handle. */
  setRangeMode(on: boolean): void;
}

/**
 * @param data      parsed data.json
 * @param handlers  onChange fires on every cursor move
 * @returns timeline controller (always returns an object; check `.enabled`)
 */
export function createTimeline(
  data: CityData,
  handlers: {
    onChange?: (cursor: number | null) => void;
    /** Range start moved (Strata mode). */
    onRange?: (start: number) => void;
  } = {}
): Timeline {
  const commits = normalizeCommits(data);
  const bar = document.getElementById('timeline');
  const range = element('tl-range', HTMLInputElement);
  const startRange = element('tl-start', HTMLInputElement);
  const play = element('tl-play', HTMLElement);
  const date = element('tl-date', HTMLElement);
  const meta = element('tl-meta', HTMLElement);
  const spark = element('tl-spark', HTMLCanvasElement);

  const first = commits[0];
  const last = commits[commits.length - 1];

  const tl: Timeline = {
    enabled: commits.length > 0,
    cursor: null,
    start: 0,
    playing: false,
    min: 0,
    max: 0,
    commits,
    byFile: new Map(),
    commitsFor,
    touchedSince,
    lastTouchBefore,
    commitsNear,
    tick,
    setRangeMode,
  };

  if (!tl.enabled || !first || !last || !bar || !range || !play || !date || !meta || !spark || !startRange) {
    tl.enabled = false;
    if (bar) bar.classList.remove('on');
    return tl;
  }
  const dom = { bar, range, startRange, play, date, meta, spark };

  for (const c of commits) {
    for (const p of c.paths) {
      let arr = tl.byFile.get(p);
      if (!arr) tl.byFile.set(p, (arr = []));
      arr.push(c);
    }
  }
  for (const arr of tl.byFile.values()) arr.sort((a, b) => a.ts - b.ts);

  tl.min = first.ts;
  tl.max = last.ts;
  if (tl.max <= tl.min) tl.max = tl.min + WEEK;
  tl.start = tl.min;

  dom.bar.classList.add('on');
  drawSparkline(dom.spark, commits, tl.min, tl.max);
  dom.meta.textContent = `${commits.length} COMMITS · 12MO`;
  renderReadout();

  dom.range.addEventListener('input', () => {
    const f = Number(dom.range.value) / 1000;
    setCursor(f >= 0.999 ? null : tl.min + f * (tl.max - tl.min));
  });
  dom.startRange.addEventListener('input', () => {
    const f = Number(dom.startRange.value) / 1000;
    const at = tl.min + f * (tl.max - tl.min);
    // The start handle can never pass the cursor: the range would be empty.
    const ceiling = (tl.cursor ?? tl.max) - DAY;
    tl.start = Math.min(at, Math.max(ceiling, tl.min));
    renderRangeReadout();
    handlers.onRange?.(tl.start);
  });
  dom.play.addEventListener('click', () => {
    tl.playing = !tl.playing;
    dom.play.classList.toggle('on', tl.playing);
    dom.play.innerHTML = tl.playing ? '&#10073;&#10073;' : '&#9654;';
    if (tl.playing && tl.cursor === null) setCursor(tl.min);
  });
  window.addEventListener('resize', () => drawSparkline(dom.spark, commits, tl.min, tl.max));

  return tl;

  // --- queries -------------------------------------------------------------

  /** Commits touching `path`, newest first. */
  function commitsFor(path: string): TimelineCommit[] {
    const arr = tl.byFile.get(path);
    if (!arr) return [];
    return arr.slice().reverse();
  }

  /** Number of commits touching `path` inside (from, to]. */
  function touchedSince(path: string, from: number, to: number): number {
    const arr = tl.byFile.get(path);
    if (!arr) return 0;
    return upperBound(arr, to) - upperBound(arr, from);
  }

  /** Seconds between `t` and the nearest commit on `path` at or before `t`, or Infinity. */
  function lastTouchBefore(path: string, t: number): number {
    const arr = tl.byFile.get(path);
    if (!arr) return Infinity;
    const i = upperBound(arr, t) - 1;
    const c = i < 0 ? null : arr[i];
    return c ? t - c.ts : Infinity;
  }

  /** Commits closest to `t` (optionally restricted to one path), nearest first. */
  function commitsNear(t: number, path: string | null = null, limit = 8): TimelineCommit[] {
    const arr = path ? tl.byFile.get(path) : commits;
    if (!arr || !arr.length) return [];
    const i = Math.min(Math.max(upperBound(arr, t) - 1, 0), arr.length - 1);
    const out: TimelineCommit[] = [];
    let lo = i;
    let hi = i + 1;
    while (out.length < limit && (lo >= 0 || hi < arr.length)) {
      const cLo = lo >= 0 ? arr[lo] : undefined;
      const cHi = hi < arr.length ? arr[hi] : undefined;
      const dLo = cLo ? Math.abs(t - cLo.ts) : Infinity;
      const dHi = cHi ? Math.abs(cHi.ts - t) : Infinity;
      if (dLo <= dHi) {
        if (cLo) out.push(cLo);
        lo--;
      } else {
        if (cHi) out.push(cHi);
        hi++;
      }
    }
    return out;
  }

  // --- playback ------------------------------------------------------------

  function tick(dt: number): void {
    if (!tl.playing) return;
    const next = (tl.cursor ?? tl.min) + PLAY_RATE * dt;
    if (next >= tl.max) {
      tl.playing = false;
      dom.play.classList.remove('on');
      dom.play.innerHTML = '&#9654;';
      setCursor(null);
      return;
    }
    setCursor(next, true);
  }

  function setCursor(t: number | null, fromPlayback = false): void {
    tl.cursor = t;
    if (fromPlayback || document.activeElement !== dom.range) {
      dom.range.value = String(t === null ? 1000 : Math.round(((t - tl.min) / (tl.max - tl.min)) * 1000));
    }
    renderReadout();
    renderRangeReadout();
    handlers.onChange?.(tl.cursor);
  }

  /** Strata mode owns the second handle; every other mode hides it. */
  function setRangeMode(on: boolean): void {
    if (!tl.enabled) return;
    dom.bar.classList.toggle('ranged', on);
    if (on) dom.startRange.value = String(Math.round(((tl.start - tl.min) / (tl.max - tl.min)) * 1000));
    renderRangeReadout();
  }

  function renderRangeReadout(): void {
    if (!dom.bar.classList.contains('ranged')) {
      dom.meta.textContent = `${commits.length} COMMITS · 12MO`;
      return;
    }
    const from = new Date(tl.start * 1000).toISOString().slice(0, 10).toUpperCase();
    const to = tl.cursor === null ? 'NOW' : new Date(tl.cursor * 1000).toISOString().slice(0, 10).toUpperCase();
    dom.meta.textContent = `RANGE ${from} → ${to}`;
  }

  function renderReadout(): void {
    if (tl.cursor === null) {
      dom.date.textContent = 'LIVE / NOW';
      dom.date.style.color = '';
      return;
    }
    const day = new Date(tl.cursor * 1000).toISOString().slice(0, 10).toUpperCase();
    const at = commitsNear(tl.cursor, null, 1)[0];
    dom.date.style.color = '#fa4616';
    if (!at) {
      dom.date.textContent = day;
      return;
    }
    const github = data.repo?.githubUrl;
    const hash = at.h.replace(/[^0-9a-f]/gi, '');
    if (github && /^https:\/\/github\.com\//.test(github)) {
      dom.date.innerHTML =
        `<a class="tl-hash" href="${github}/commit/${hash}" target="_blank" rel="noopener noreferrer">${hash}</a> · ${day}`;
    } else {
      dom.date.textContent = `${hash} · ${day}`;
    }
  }
}

/** Relative time such as "3d ago" for a unix-seconds timestamp. */
export function relTime(ts: number, now: number = Date.now() / 1000): string {
  const d = Math.max(now - ts, 0);
  if (d < 90) return 'just now';
  if (d < 3600) return Math.round(d / 60) + 'm ago';
  if (d < DAY) return Math.round(d / 3600) + 'h ago';
  if (d < 30 * DAY) return Math.round(d / DAY) + 'd ago';
  if (d < 365 * DAY) return Math.round(d / (30 * DAY)) + 'mo ago';
  return Math.round(d / (365 * DAY)) + 'y ago';
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Flatten the v2 stream into ascending `{h, ts, a, s, paths}` records. */
function normalizeCommits(data: CityData): TimelineCommit[] {
  const files = Array.isArray(data.files) ? data.files : null;
  const raw = Array.isArray(data.commits) ? data.commits : null;
  if (!files || !raw || !raw.length) return [];

  const out: TimelineCommit[] = [];
  for (const c of raw) {
    const ts = Number(c.ts);
    if (!Number.isFinite(ts)) continue;
    const paths: string[] = [];
    for (const i of c.f || []) {
      const p = files[i];
      if (p) paths.push(p);
    }
    out.push({ h: String(c.h || ''), ts, a: String(c.a || ''), s: String(c.s || ''), paths });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** First index whose ts is > t, over an ascending commit array. */
function upperBound(arr: TimelineCommit[], t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const c = arr[mid];
    if (c && c.ts <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Commits-per-week histogram painted into the slider track. */
function drawSparkline(canvas: HTMLCanvasElement, commits: TimelineCommit[], min: number, max: number): void {
  const w = Math.max(canvas.clientWidth, 1);
  const h = Math.max(canvas.clientHeight, 1);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const weeks = Math.max(Math.ceil((max - min) / WEEK), 1);
  const bins = new Float64Array(weeks);
  for (const c of commits) {
    const i = Math.min(Math.floor((c.ts - min) / WEEK), weeks - 1);
    bins[i] = (bins[i] ?? 0) + 1;
  }
  let peak = 1;
  for (const v of bins) peak = Math.max(peak, v);

  const bw = w / weeks;
  for (let i = 0; i < weeks; i++) {
    const v = bins[i] ?? 0;
    const bh = Math.max((v / peak) * (h - 2), v > 0 ? 1 : 0);
    const t = v / peak;
    ctx.fillStyle = `rgba(${34 + t * 200}, ${211 - t * 90}, ${238 - t * 180}, ${0.28 + t * 0.6})`;
    ctx.fillRect(i * bw, h - bh, Math.max(bw - 0.5, 0.5), bh);
  }
  ctx.strokeStyle = 'rgba(34,211,238,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

/** `document.getElementById` narrowed to an expected element type. */
function element<T extends Element>(id: string, ctor: abstract new (...args: never[]) => T): T | null {
  const found = document.getElementById(id);
  return found instanceof ctor ? found : null;
}
