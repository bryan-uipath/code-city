/**
 * timeline.js — git history scrubber built on the v2 commit stream.
 *
 * The stream (`data.files` index table + `data.commits`) is indexed once into
 * per-file, ascending commit arrays; every query afterwards is a binary search,
 * so scrubbing and playback never rescan the log.
 *
 * Degrades to `enabled: false` (bar hidden) when the stream is absent (v1 data).
 */

const DAY = 86400;
const WEEK = 7 * DAY;
export const RECENT_WINDOW = 30 * DAY;
/** Playback speed: one week of history per real-time second. */
const PLAY_RATE = WEEK;
/** A file "flashes" when it was touched this close to the cursor. */
export const FLASH_WINDOW = 2 * DAY;

/**
 * @param {object} data           parsed data.json
 * @param {{onChange: (cursor:number|null) => void}} handlers
 * @returns {object} timeline controller (always returns an object; check `.enabled`)
 */
export function createTimeline(data, handlers = {}) {
  const commits = normalizeCommits(data);
  const dom = {
    bar: document.getElementById('timeline'),
    range: document.getElementById('tl-range'),
    play: document.getElementById('tl-play'),
    date: document.getElementById('tl-date'),
    meta: document.getElementById('tl-meta'),
    spark: document.getElementById('tl-spark'),
  };

  const tl = {
    enabled: commits.length > 0,
    /** Time cursor in epoch seconds, or null when live ("now"). */
    cursor: null,
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
  };

  if (!tl.enabled) {
    if (dom.bar) dom.bar.classList.remove('on');
    return tl;
  }

  for (const c of commits) {
    for (const p of c.paths) {
      let arr = tl.byFile.get(p);
      if (!arr) tl.byFile.set(p, (arr = []));
      arr.push(c);
    }
  }
  for (const arr of tl.byFile.values()) arr.sort((a, b) => a.ts - b.ts);

  tl.min = commits[0].ts;
  tl.max = commits[commits.length - 1].ts;
  if (tl.max <= tl.min) tl.max = tl.min + WEEK;

  dom.bar.classList.add('on');
  drawSparkline(dom.spark, commits, tl.min, tl.max);
  dom.meta.textContent = `${commits.length} COMMITS · 12MO`;
  renderReadout();

  dom.range.addEventListener('input', () => {
    const f = Number(dom.range.value) / 1000;
    setCursor(f >= 0.999 ? null : tl.min + f * (tl.max - tl.min));
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
  function commitsFor(path) {
    const arr = tl.byFile.get(path);
    if (!arr) return [];
    return arr.slice().reverse();
  }

  /** Number of commits touching `path` inside (from, to]. */
  function touchedSince(path, from, to) {
    const arr = tl.byFile.get(path);
    if (!arr) return 0;
    return upperBound(arr, to) - upperBound(arr, from);
  }

  /** Seconds between `t` and the nearest commit on `path` at or before `t`, or Infinity. */
  function lastTouchBefore(path, t) {
    const arr = tl.byFile.get(path);
    if (!arr) return Infinity;
    const i = upperBound(arr, t) - 1;
    return i < 0 ? Infinity : t - arr[i].ts;
  }

  /** Commits closest to `t` (optionally restricted to one path), nearest first. */
  function commitsNear(t, path = null, limit = 8) {
    const arr = path ? tl.byFile.get(path) : commits;
    if (!arr || !arr.length) return [];
    const i = Math.min(Math.max(upperBound(arr, t) - 1, 0), arr.length - 1);
    const out = [];
    let lo = i;
    let hi = i + 1;
    while (out.length < limit && (lo >= 0 || hi < arr.length)) {
      const dLo = lo >= 0 ? Math.abs(t - arr[lo].ts) : Infinity;
      const dHi = hi < arr.length ? Math.abs(arr[hi].ts - t) : Infinity;
      if (dLo <= dHi) out.push(arr[lo--]);
      else out.push(arr[hi++]);
    }
    return out;
  }

  // --- playback ------------------------------------------------------------

  function tick(dt) {
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

  function setCursor(t, fromPlayback = false) {
    tl.cursor = t;
    if (fromPlayback || document.activeElement !== dom.range) {
      dom.range.value = String(t === null ? 1000 : Math.round(((t - tl.min) / (tl.max - tl.min)) * 1000));
    }
    renderReadout();
    handlers.onChange?.(tl.cursor);
  }

  function renderReadout() {
    if (tl.cursor === null) {
      dom.date.textContent = 'LIVE / NOW';
      dom.date.style.color = '';
      return;
    }
    dom.date.textContent = new Date(tl.cursor * 1000).toISOString().slice(0, 10).toUpperCase();
    dom.date.style.color = '#fa4616';
  }
}

/** Relative time such as "3d ago" for a unix-seconds timestamp. */
export function relTime(ts, now = Date.now() / 1000) {
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
function normalizeCommits(data) {
  const files = Array.isArray(data.files) ? data.files : null;
  const raw = Array.isArray(data.commits) ? data.commits : null;
  if (!files || !raw || !raw.length) return [];

  const out = [];
  for (const c of raw) {
    const ts = Number(c.ts);
    if (!Number.isFinite(ts)) continue;
    const paths = [];
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
function upperBound(arr, t) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Commits-per-week histogram painted into the slider track. */
function drawSparkline(canvas, commits, min, max) {
  const w = Math.max(canvas.clientWidth, 1);
  const h = Math.max(canvas.clientHeight, 1);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const weeks = Math.max(Math.ceil((max - min) / WEEK), 1);
  const bins = new Float64Array(weeks);
  for (const c of commits) {
    const i = Math.min(Math.floor((c.ts - min) / WEEK), weeks - 1);
    bins[i] += 1;
  }
  let peak = 1;
  for (const v of bins) peak = Math.max(peak, v);

  const bw = w / weeks;
  for (let i = 0; i < weeks; i++) {
    const bh = Math.max((bins[i] / peak) * (h - 2), bins[i] > 0 ? 1 : 0);
    const t = bins[i] / peak;
    ctx.fillStyle = `rgba(${34 + t * 200}, ${211 - t * 90}, ${238 - t * 180}, ${0.28 + t * 0.6})`;
    ctx.fillRect(i * bw, h - bh, Math.max(bw - 0.5, 0.5), bh);
  }
  ctx.strokeStyle = 'rgba(34,211,238,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}
