/**
 * search.js — the command palette (⌘P files/modules · ⌘F file contents).
 *
 * One palette, two modes. Both drive the SAME city reaction: the host paints a
 * "search highlight" pass (matches glow white-cyan, everything else dims) while
 * the palette is open, and restores the active overlay when it closes.
 *
 * The host contract (see main.js):
 *   getRoot()            -> the real tree root (search always spans the whole
 *                           repo, not the current focus scope)
 *   highlight(spec|null) -> spec = { paths: Map(path -> {w, mods:Set|null}),
 *                                    cursor: {path, mods:Set|null}|null }
 *   reveal(path, {module, line}) -> pop scope if needed, select + fly, true/false
 *   notice(msg)          -> transient HUD message
 *
 * Everything data-derived (paths, module names, matched source lines, the echoed
 * query) is escaped before it reaches innerHTML.
 */
import { escapeHtml } from './sidebar.js';

const MAX_RESULTS = 30;
const CONTENT_DEBOUNCE = 250;
const MIN_CONTENT_QUERY = 2;

/** @param {{getRoot:Function, highlight:Function, reveal:Function, notice:Function}} host */
export function createSearch(host) {
  const el = buildDom();
  const state = {
    open: false,
    mode: 'file',
    query: '',
    /** file mode: FileResult[] · content mode: Group[] */
    results: [],
    /** flattened, keyboard-navigable rows */
    rows: [],
    cursor: 0,
    expanded: new Set(),
    status: '',
    entries: null,     // lazily built fuzzy index over the real tree
    entryRoot: null,
    reqToken: 0,
    debounce: 0,
  };

  window.addEventListener('keydown', onWindowKey);
  el.input.addEventListener('input', () => {
    state.query = el.input.value;
    runQuery();
  });
  el.input.addEventListener('keydown', onInputKey);
  el.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (btn) setMode(btn.dataset.mode);
  });
  el.list.addEventListener('click', onListClick);

  return {
    isOpen: () => state.open,
    open: (mode) => open(mode),
    close,
  };

  // --- open / close --------------------------------------------------------

  function open(mode) {
    const was = state.open;
    state.open = true;
    el.root.classList.add('on');
    if (!was) {
      state.query = '';
      el.input.value = '';
      state.results = [];
      state.rows = [];
      state.cursor = 0;
      state.expanded.clear();
      state.status = '';
    }
    setMode(mode, { silent: was });
    el.input.focus();
    el.input.select();
    if (!was) render();
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    state.reqToken++;
    clearTimeout(state.debounce);
    el.root.classList.remove('on');
    el.input.blur();
    host.highlight(null);
  }

  function setMode(mode, opts = {}) {
    const next = mode === 'content' ? 'content' : 'file';
    const changed = next !== state.mode;
    state.mode = next;
    for (const b of el.tabs.querySelectorAll('button[data-mode]')) {
      b.classList.toggle('active', b.dataset.mode === next);
    }
    el.input.placeholder = next === 'file' ? 'Find file or module…' : 'Find in file contents…';
    if (changed || !opts.silent) {
      state.cursor = 0;
      state.expanded.clear();
      state.status = '';
      runQuery();
    }
  }

  // --- keys ----------------------------------------------------------------

  function onWindowKey(e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'p' && k !== 'f') return;
    e.preventDefault();
    e.stopPropagation();
    open(k === 'p' ? 'file' : 'content');
  }

  function onInputKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveCursor(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const row = state.rows[state.cursor];
      if (state.mode !== 'content' || !row || row.type !== 'file') return;
      e.preventDefault();
      toggleExpand(row.gi, e.key === 'ArrowRight');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      activate(state.cursor);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      setMode(state.mode === 'file' ? 'content' : 'file');
    }
  }

  function moveCursor(d) {
    if (!state.rows.length) return;
    state.cursor = (state.cursor + d + state.rows.length) % state.rows.length;
    render();
    pushHighlight();
  }

  // --- querying ------------------------------------------------------------

  function runQuery() {
    clearTimeout(state.debounce);
    state.reqToken++;
    const q = state.query.trim();
    state.cursor = 0;
    state.expanded.clear();

    if (!q) {
      state.results = [];
      state.status = state.mode === 'file' ? 'type to search paths & modules' : `type ${MIN_CONTENT_QUERY}+ chars`;
      render();
      pushHighlight();
      return;
    }
    if (state.mode === 'file') {
      state.results = searchFiles(q, entries());
      state.status = `${state.results.length} match${state.results.length === 1 ? '' : 'es'}`;
      render();
      pushHighlight();
      return;
    }

    if (q.length < MIN_CONTENT_QUERY) {
      state.results = [];
      state.status = `type ${MIN_CONTENT_QUERY}+ chars`;
      render();
      pushHighlight();
      return;
    }
    state.status = 'searching…';
    render();
    const token = state.reqToken;
    state.debounce = setTimeout(() => runContentQuery(q, token), CONTENT_DEBOUNCE);
  }

  async function runContentQuery(q, token) {
    const json = await fetchSearch(q);
    if (token !== state.reqToken || !state.open) return;
    if (!json) {
      state.results = [];
      state.status = 'content search requires the dev server';
      render();
      pushHighlight();
      return;
    }
    state.results = groupMatches(json.matches);
    const n = state.results.length;
    state.status = `${n} file${n === 1 ? '' : 's'}${json.truncated ? ' · truncated' : ''}`;
    state.cursor = 0;
    render();
    pushHighlight();
  }

  /** The fuzzy index over the whole real tree (rebuilt if the root changes). */
  function entries() {
    const root = host.getRoot();
    if (state.entries && state.entryRoot === root) return state.entries;
    const list = [];
    collectEntries(root, list);
    state.entries = list;
    state.entryRoot = root;
    return list;
  }

  // --- city highlight ------------------------------------------------------

  function pushHighlight() {
    if (!state.open) return;
    // An empty query leaves the city as it was — only a real query dims it.
    if (!state.query.trim()) {
      host.highlight(null);
      return;
    }
    const paths = new Map();
    let cursor = null;

    if (state.mode === 'file') {
      const n = state.results.length;
      state.results.forEach((r, i) => {
        addPath(paths, r.path, 1 - (i / Math.max(n, 1)) * 0.6, r.module);
      });
      const row = state.rows[state.cursor];
      const sel = row ? state.results[row.gi] : null;
      if (sel) cursor = { path: sel.path, mods: sel.module ? new Set([sel.module]) : null };
    } else {
      let max = 1;
      for (const g of state.results) max = Math.max(max, g.matches.length);
      for (const g of state.results) addPath(paths, g.path, 0.35 + 0.65 * (g.matches.length / max), null);
      const row = state.rows[state.cursor];
      const g = row ? state.results[row.gi] : null;
      if (g) cursor = { path: g.path, mods: null };
    }
    host.highlight({ paths, cursor });
  }

  function addPath(map, path, w, module) {
    const prev = map.get(path);
    if (!prev) {
      map.set(path, { w, mods: module ? new Set([module]) : null });
      return;
    }
    prev.w = Math.max(prev.w, w);
    if (!module) prev.mods = null;          // a whole-file hit outranks module hits
    else if (prev.mods) prev.mods.add(module);
  }

  // --- rendering -----------------------------------------------------------

  function render() {
    el.status.textContent = state.status;
    state.rows = buildRows();

    if (!state.rows.length) {
      el.list.innerHTML = `<div class="pal-empty">${escapeHtml(state.status || 'no matches')}</div>`;
      return;
    }
    const q = state.query.trim();
    const html = state.rows.map((row, i) => {
      const active = i === state.cursor ? ' active' : '';
      if (state.mode === 'file') {
        const r = state.results[row.gi];
        return (
          `<div class="pal-row${active}" data-i="${i}">` +
          `<span class="tag ${r.module ? 'mod' : 'file'}">${r.module ? 'MOD' : 'FILE'}</span>` +
          `<span class="nm">${mark(r.label, q)}</span>` +
          `<span class="dir">${mark(r.sub, q)}</span>` +
          `</div>`
        );
      }
      const g = state.results[row.gi];
      if (row.type === 'file') {
        const open = state.expanded.has(row.gi);
        return (
          `<div class="pal-row${active}" data-i="${i}">` +
          `<span class="tag ${open ? 'mod' : 'file'}">${open ? '&#9662;' : '&#9656;'}</span>` +
          `<span class="nm">${mark(baseName(g.path), q)}</span>` +
          `<span class="dir">${escapeHtml(dirName(g.path))}</span>` +
          `<span class="cnt">${g.matches.length} match${g.matches.length === 1 ? '' : 'es'}</span>` +
          `</div>`
        );
      }
      const m = g.matches[row.mi];
      return (
        `<div class="pal-row line${active}" data-i="${i}">` +
        `<span class="ln">${Number(m.line) || 0}</span>` +
        `<span class="src">${mark(m.text, q)}</span>` +
        `</div>`
      );
    });
    el.list.innerHTML = html.join('');
    const active = el.list.querySelector('.pal-row.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function buildRows() {
    const rows = [];
    if (state.mode === 'file') {
      state.results.forEach((_, gi) => rows.push({ type: 'file', gi }));
      return rows;
    }
    state.results.forEach((g, gi) => {
      rows.push({ type: 'file', gi });
      if (state.expanded.has(gi)) g.matches.forEach((_, mi) => rows.push({ type: 'line', gi, mi }));
    });
    return rows;
  }

  // --- activation ----------------------------------------------------------

  function onListClick(e) {
    const rowEl = e.target.closest('.pal-row');
    if (!rowEl) return;
    const i = Number(rowEl.dataset.i);
    if (!Number.isFinite(i)) return;
    state.cursor = i;
    activate(i);
  }

  function toggleExpand(gi, wantOpen) {
    const isOpen = state.expanded.has(gi);
    if (wantOpen === isOpen) return;
    if (isOpen) state.expanded.delete(gi);
    else state.expanded.add(gi);
    render();
  }

  function activate(i) {
    const row = state.rows[i];
    if (!row) return;
    if (state.mode === 'file') {
      const r = state.results[row.gi];
      if (!r) return;
      if (host.reveal(r.path, { module: r.module })) close();
      return;
    }
    const g = state.results[row.gi];
    if (!g) return;
    if (row.type === 'file' && !state.expanded.has(row.gi) && g.matches.length > 1) {
      // First Enter on a collapsed group opens it; a second one navigates.
      toggleExpand(row.gi, true);
      pushHighlight();
      return;
    }
    const line = row.type === 'line' ? g.matches[row.mi].line : g.matches[0].line;
    if (host.reveal(g.path, { line })) close();
  }
}

// ---------------------------------------------------------------------------
// File / module search
// ---------------------------------------------------------------------------

/** @returns {Array<{path,module,label,sub,score}>} best `MAX_RESULTS` matches. */
export function searchFiles(query, entries) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return [];
  const out = [];
  for (const e of entries) {
    const score = scoreEntry(q, e);
    if (score > 0) out.push({ e, score });
  }
  out.sort((a, b) => b.score - a.score || a.e.text.length - b.e.text.length);
  return out.slice(0, MAX_RESULTS).map(({ e, score }) => ({
    path: e.path,
    module: e.module,
    label: e.module || baseName(e.path),
    sub: e.module ? e.path : dirName(e.path),
    score,
  }));
}

function scoreEntry(q, e) {
  let score = fuzzyScore(q, e.text, e.boostFrom);
  if (score <= 0) return 0;
  if (e.text.includes(q)) score += 14;
  if (e.text.slice(e.boostFrom).includes(q)) score += 10;   // basename / module name
  if (e.module) score += 2;
  return score;
}

/**
 * Subsequence score: consecutive runs and word starts pay, gaps and long
 * targets cost. Returns 0 when `q` is not a subsequence of `text`.
 * `boostFrom` is the index where the "interesting" part (basename) begins.
 */
export function fuzzyScore(q, text, boostFrom = 0) {
  const n = q.length;
  const m = text.length;
  if (!n || n > m) return 0;
  let score = 0;
  let from = 0;
  let prev = -2;
  let run = 0;
  for (let qi = 0; qi < n; qi++) {
    const at = text.indexOf(q[qi], from);
    if (at < 0) return 0;
    let s = 1;
    if (at === prev + 1) { run++; s += 3 + Math.min(run, 6); } else { run = 0; }
    const before = at > 0 ? text[at - 1] : '/';
    if (before === '/' || before === '.' || before === '-' || before === '_' || before === '#') s += 5;
    if (at >= boostFrom) s += 2;
    s -= Math.min(at - (prev + 1), 8) * 0.3;
    score += s;
    prev = at;
    from = at + 1;
  }
  return Math.max(score - m * 0.02, 0.01);
}

/** Every file path and every `path#module` in the real tree. */
function collectEntries(node, out) {
  if (!node) return;
  if (node.type === 'file') {
    out.push(makeEntry(node.path, null));
    for (const mod of node.modules || []) out.push(makeEntry(node.path, mod.name));
    return;
  }
  for (const c of node.children || []) collectEntries(c, out);
}

function makeEntry(path, module) {
  const text = (module ? `${path}#${module}` : path).toLowerCase();
  const cut = module ? text.lastIndexOf('#') + 1 : text.lastIndexOf('/') + 1;
  return { path, module, text, boostFrom: cut };
}

// ---------------------------------------------------------------------------
// Content search
// ---------------------------------------------------------------------------

/**
 * `GET /api/search` → parsed JSON, or null when the endpoint is absent (static
 * host answers with index.html, so only a JSON content-type is trusted).
 */
async function fetchSearch(q) {
  try {
    const res = await fetch('/api/search?' + new URLSearchParams({ q }).toString(), { cache: 'no-cache' });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('json')) return null;
    const json = await res.json();
    return json && Array.isArray(json.matches) ? json : null;
  } catch {
    return null;
  }
}

function groupMatches(matches) {
  const byPath = new Map();
  for (const m of matches) {
    if (!m || typeof m.path !== 'string') continue;
    let g = byPath.get(m.path);
    if (!g) byPath.set(m.path, (g = { path: m.path, matches: [] }));
    g.matches.push({ line: Number(m.line) || 0, text: String(m.text ?? '') });
  }
  return [...byPath.values()].sort((a, b) => b.matches.length - a.matches.length || a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function buildDom() {
  const root = document.createElement('div');
  root.id = 'palette';
  root.className = 'hud panel';
  root.innerHTML =
    `<div id="pal-tabs">` +
    `<button type="button" data-mode="file" class="active">&#8984;P&nbsp;&nbsp;Files</button>` +
    `<button type="button" data-mode="content">&#8984;F&nbsp;&nbsp;Contents</button>` +
    `<span id="pal-status"></span></div>` +
    `<input id="pal-input" type="text" spellcheck="false" autocomplete="off" placeholder="Find file or module…" />` +
    `<div id="pal-list"></div>`;
  document.body.appendChild(root);
  return {
    root,
    tabs: root.querySelector('#pal-tabs'),
    input: root.querySelector('#pal-input'),
    list: root.querySelector('#pal-list'),
    status: root.querySelector('#pal-status'),
  };
}

/** Escape `text`, wrapping every case-insensitive occurrence of `q` in <mark>. */
function mark(text, q) {
  const s = String(text ?? '');
  const needle = String(q ?? '').trim().toLowerCase();
  if (!needle) return escapeHtml(s);
  const hay = s.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at < 0) break;
    out += escapeHtml(s.slice(i, at)) + '<mark>' + escapeHtml(s.slice(at, at + needle.length)) + '</mark>';
    i = at + needle.length;
  }
  return out + escapeHtml(s.slice(i));
}

function baseName(path) {
  const s = String(path);
  return s.slice(s.lastIndexOf('/') + 1);
}

function dirName(path) {
  const s = String(path);
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i);
}
