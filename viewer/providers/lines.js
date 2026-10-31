/**
 * lines.js — what every line-content provider shares: the reading window a
 * `getDetail` returns, so git and notes page a file the same way.
 */

const MAX_LINES = 400;

/** `[start, end]` (1-based, from raw query strings) clamped to the file and capped at MAX_LINES. */
export function lineWindow(all, startParam, endParam) {
  const total = all.length;
  const start = clamp(intParam(startParam, 1), 1, total);
  const requestedEnd = clamp(intParam(endParam, total), start, total);
  const end = Math.min(requestedEnd, start + MAX_LINES - 1);
  return { start, end, total, lines: all.slice(start - 1, end) };
}

export function intParam(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}
