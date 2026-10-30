/**
 * notes.js — the notes provider: the runtime half of a markdown-folder source
 * (`scripts/notes-snapshot.mjs`). It serves a note's lines (`markdown` content)
 * and content search, and nothing else — no history, no live state, no git.
 * Its root came from a snapshot file, so containment is strict: ids are
 * root-relative paths, and only regular `.md` files whose real path (symlinks
 * resolved) stays under the real root are ever read, through a descriptor
 * opened without following links. Throws Error on bad input (-> 400).
 */
import fs from 'node:fs';
import path from 'node:path';
import { lineWindow } from './lines.js';

/** A note bigger than this is not a note: refuse rather than read it. */
const MAX_NOTE_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 500;
/** Matches per note, as `git grep --max-count 5`. */
const MAX_PER_NOTE = 5;
/** Per search: directory entries visited (any kind), notes read, bytes read. */
const MAX_SEARCH_ENTRIES = 200_000;
const MAX_SEARCH_NOTES = 20_000;
const MAX_SEARCH_BYTES = 64 * 1024 * 1024;
/** Same rule as the snapshot's: `.md` only, so search never finds a note the city lacks. */
const NOTE_RE = /\.md$/;
/** O_NOFOLLOW: the final component must not be a link; O_NONBLOCK: a FIFO can't hang the server. */
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/** @param {string} root absolute directory named by the snapshot, already known to exist */
export function createNotesProvider(root) {
  const realRoot = fs.realpathSync(root);
  // The root itself swapped for a link after startup would move every read: refuse.
  const checkRoot = () => {
    if (fs.realpathSync(root) !== realRoot) throw new Error('notes root changed');
  };

  return {
    /** A note's lines, as `markdown` content. */
    async getDetail({ id, start, end }) {
      checkRoot();
      const { rel, abs } = noteFile(realRoot, id);
      return { kind: 'markdown', path: rel, ...lineWindow(readNote(abs).split('\n'), start, end) };
    },

    /** Case-insensitive substring search over every note under root, bounded per request. */
    async search({ q: raw }) {
      const q = (raw || '').trim();
      if (q.length < 2 || q.length > 200) throw new Error('query must be 2–200 chars');
      checkRoot();
      const needle = q.toLowerCase();
      const matches = [];
      const budget = { entries: MAX_SEARCH_ENTRIES, notes: MAX_SEARCH_NOTES, bytes: MAX_SEARCH_BYTES, spent: false };
      let full = false;
      for (const rel of walkNotes(realRoot, budget)) {
        let text;
        try { text = readNote(path.join(realRoot, rel)); } catch { continue; }
        budget.bytes -= text.length;
        const lines = text.split('\n');
        let found = 0;
        for (let i = 0; i < lines.length && found < MAX_PER_NOTE; i++) {
          const line = lines[i];
          if (!line.toLowerCase().includes(needle)) continue;
          if (matches.length >= MAX_SEARCH_RESULTS) { full = true; break; }
          matches.push({ path: rel, line: i + 1, text: line.trim().slice(0, 200) });
          found++;
        }
        if (full) break;
        if (budget.bytes <= 0) { budget.spent = true; break; }
      }
      return { q, matches, truncated: full || budget.spent };
    },
  };
}

/**
 * A root-relative note id -> its real path, or throw. Syntactic checks first (no
 * absolute, no backslash, no `..`, NUL, a `.md` name), then the real path must
 * stay under the real root.
 */
function noteFile(realRoot, id) {
  if (!id || typeof id !== 'string' || id.includes('\0')) throw new Error('invalid path');
  if (id.includes('\\') || path.isAbsolute(id) || id.split('/').some((seg) => seg === '..')) throw new Error('invalid path');
  if (!NOTE_RE.test(id)) throw new Error('invalid path');
  let real;
  try { real = fs.realpathSync(path.resolve(realRoot, id)); } catch { throw new Error('invalid path'); }
  if (!real.startsWith(realRoot + path.sep) || !NOTE_RE.test(real)) throw new Error('invalid path');
  return { rel: id, abs: real };
}

/**
 * Read one note through a descriptor: opened without following a final link,
 * non-blocking, then checked as a regular file under the size cap on the same
 * descriptor — no window between the check and the read on that file.
 */
function readNote(abs) {
  let fd;
  try { fd = fs.openSync(abs, OPEN_FLAGS); } catch { throw new Error('invalid path'); }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('invalid path');
    if (st.size > MAX_NOTE_BYTES) throw new Error('note too large');
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Root-relative note paths, depth-first; dot-entries, node_modules and links
 * skipped. Every entry visited spends the budget, so a tree of empty
 * directories ends the walk as surely as a tree of notes; `spent` says so.
 */
function* walkNotes(realRoot, budget) {
  const stack = [''];
  while (stack.length) {
    const dir = stack.pop();
    let handle;
    try { handle = fs.opendirSync(path.join(realRoot, dir)); } catch { continue; }
    try {
      // One entry at a time: a huge directory is never listed whole.
      for (let ent = handle.readSync(); ent; ent = handle.readSync()) {
        if (--budget.entries < 0) { budget.spent = true; return; }
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
        const rel = dir ? `${dir}/${ent.name}` : ent.name;
        // Dirent types come from lstat: a link is neither, so it is never followed.
        if (ent.isDirectory()) stack.push(rel);
        else if (ent.isFile() && NOTE_RE.test(ent.name)) {
          if (--budget.notes < 0) { budget.spent = true; return; }
          yield rel;
        }
      }
    } finally {
      handle.closeSync();
    }
  }
}
