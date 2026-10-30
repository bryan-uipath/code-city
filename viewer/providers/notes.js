/**
 * notes.js — the notes provider: the runtime half of a markdown-folder source
 * (`scripts/notes-snapshot.mjs`). It serves a note's lines (`markdown` content)
 * and content search, and nothing else — no history, no live state, no git.
 * Its root came from a snapshot file, so containment is strict: ids are
 * root-relative paths, and only regular `.md`/`.mdx` files whose real path
 * (symlinks resolved) stays under the real root are ever read. Throws Error on
 * bad input (-> 400).
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES = 400;
/** A note bigger than this is not a note: refuse rather than read it. */
const MAX_NOTE_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 500;
/** Matches per note, as `git grep --max-count 5`. */
const MAX_PER_NOTE = 5;
/** Search walks at most this many notes and bytes per request. */
const MAX_SEARCH_NOTES = 20_000;
const MAX_SEARCH_BYTES = 64 * 1024 * 1024;
const NOTE_RE = /\.mdx?$/i;

/** @param {string} root absolute directory named by the snapshot, already known to exist */
export function createNotesProvider(root) {
  const realRoot = fs.realpathSync(root);

  return {
    /** A note's lines, as `markdown` content. */
    async getDetail({ id, start: startParam, end: endParam }) {
      const { rel, abs } = noteFile(realRoot, id);
      if (fs.statSync(abs).size > MAX_NOTE_BYTES) throw new Error('note too large');
      const all = fs.readFileSync(abs, 'utf8').split('\n');
      const total = all.length;
      const start = clamp(intParam(startParam, 1), 1, total);
      const requestedEnd = clamp(intParam(endParam, total), start, total);
      const end = Math.min(requestedEnd, start + MAX_LINES - 1);
      return { kind: 'markdown', path: rel, start, end, total, lines: all.slice(start - 1, end) };
    },

    /** Case-insensitive substring search over every note under root. */
    async search({ q: raw }) {
      const q = (raw || '').trim();
      if (q.length < 2 || q.length > 200) throw new Error('query must be 2–200 chars');
      const needle = q.toLowerCase();
      const matches = [];
      let truncated = false;
      const budget = { notes: MAX_SEARCH_NOTES, bytes: MAX_SEARCH_BYTES };
      for (const rel of walkNotes(realRoot, budget)) {
        let text;
        try { text = fs.readFileSync(path.join(realRoot, rel), 'utf8'); } catch { continue; }
        const lines = text.split('\n');
        let found = 0;
        for (let i = 0; i < lines.length && found < MAX_PER_NOTE; i++) {
          const line = lines[i];
          if (!line.toLowerCase().includes(needle)) continue;
          if (matches.length >= MAX_SEARCH_RESULTS) { truncated = true; break; }
          matches.push({ path: rel, line: i + 1, text: line.trim().slice(0, 200) });
          found++;
        }
        if (truncated) break;
      }
      return { q, matches, truncated: truncated || budget.notes <= 0 || budget.bytes <= 0 };
    },
  };
}

/**
 * A root-relative note id -> its file, or throw. Syntactic checks first (no
 * absolute, no backslash, no `..`, a note extension), then the real path must
 * stay under the real root and be a regular file — a symlink out is refused.
 */
function noteFile(realRoot, id) {
  if (!id || typeof id !== 'string' || id.includes('\0')) throw new Error('invalid path');
  if (id.includes('\\') || path.isAbsolute(id) || id.split('/').some((seg) => seg === '..')) throw new Error('invalid path');
  if (!NOTE_RE.test(id)) throw new Error('invalid path');
  let real;
  try { real = fs.realpathSync(path.resolve(realRoot, id)); } catch { throw new Error('invalid path'); }
  if (!real.startsWith(realRoot + path.sep) || !NOTE_RE.test(real) || !fs.statSync(real).isFile()) {
    throw new Error('invalid path');
  }
  return { rel: id, abs: real };
}

/** Root-relative note paths, depth-first; dot-dirs, node_modules and symlinks skipped. */
function* walkNotes(realRoot, budget) {
  const stack = [''];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(realRoot, dir), { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const rel = dir ? `${dir}/${ent.name}` : ent.name;
      // Dirent types come from lstat: a symlink is neither, so it is never followed.
      if (ent.isDirectory()) stack.push(rel);
      else if (ent.isFile() && NOTE_RE.test(ent.name)) {
        let size;
        try { size = fs.statSync(path.join(realRoot, rel)).size; } catch { continue; }
        if (size > MAX_NOTE_BYTES) continue;
        if (--budget.notes < 0 || (budget.bytes -= size) < 0) return;
        yield rel;
      }
    }
  }
}

function intParam(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}
