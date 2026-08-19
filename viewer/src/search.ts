/**
 * search.ts — the command palette (⌘P files/modules · ⌘F file contents).
 *
 * One palette, two modes. Both drive the SAME city reaction: the host paints a
 * "search highlight" pass (matches glow white-cyan, everything else dims) while
 * the palette is open, and restores the active overlay when it closes.
 *
 * The host contract (see main.ts):
 *   getRoot()            -> the real tree root (search always spans the whole
 *                           repo, not the current focus scope)
 *   highlight(spec|null) -> spec = { paths: Map(path -> {w, mods:Set|null}),
 *                                    cursor: {path, mods:Set|null}|null }
 *   reveal(path, {module, line}) -> pop scope if needed, select + fly, true/false
 *   notice(msg)          -> transient HUD message
 *   search(q)            -> content search results, or null when unavailable
 *   results(view|null)   -> mirror the ⌘F hits into the sidebar; unlike the
 *                           highlight, this list outlives the palette
 *
 * Everything data-derived (paths, module names, matched source lines, the echoed
 * query) is escaped before it reaches innerHTML.
 */
import type { SearchMatch, SearchResponse } from '../../shared/types.js';
import { escapeHtml, markHtml, type SearchFileHits } from './sidebar.js';
import type { VNode } from './vtree.js';

const MAX_RESULTS = 30;
const CONTENT_DEBOUNCE = 250;
const MIN_CONTENT_QUERY = 2;

/** Which files (and modules within them) the city should highlight. */
export interface HighlightSpec {
  paths: Map<string, { w: number; mods: Set<string> | null }>;
  cursor: { path: string; mods: Set<string> | null } | null;
}

export interface SearchHost {
  getRoot(): VNode;
  highlight(spec: HighlightSpec | null): void;
  reveal(path: string, opts?: { module?: string | null; line?: number }): boolean;
  notice(msg: string): void;
  search(q: string): Promise<SearchResponse | null>;
  /**
   * Mirror the content hits into the sidebar. Unlike `highlight`, this survives
   * the palette closing — the host decides when the list has gone stale.
   */
  results(view: SearchResultsPayload | null): void;
}

export interface SearchPalette {
  isOpen(): boolean;
  open(mode: string): void;
  close(): void;
}

/** One file/module hit in ⌘P mode. */
export interface FileResult {
  path: string;
  module: string | null;
  label: string;
  sub: string;
  score: number;
}

/** All content matches for one file in ⌘F mode — the sidebar's row type. */
type Group = SearchFileHits;

type Result = FileResult | Group;

/** What the sidebar mirror needs; the host adds the click behaviour. */
export interface SearchResultsPayload {
  query: string;
  files: Group[];
  truncated: boolean;
}

/** A keyboard-navigable row: a file/group header, or one matched line. */
interface Row {
  type: 'file' | 'line';
  gi: number;
  mi?: number;
}

/** A fuzzy-index entry: one file path, or one `path#module`. */
interface Entry {
  path: string;
  module: string | null;
  text: string;
  boostFrom: number;
}

export function createSearch(host: SearchHost): SearchPalette {
  const el = buildDom();
  const state: {
    open: boolean;
    mode: 'file' | 'content';
    query: string;
    results: Result[];
    rows: Row[];
    cursor: number;
    expanded: Set<number>;
    status: string;
    entries: Entry[] | null;
    entryRoot: VNode | null;
    reqToken: number;
    debounce: ReturnType<typeof setTimeout> | undefined;
  } = {
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
    debounce: undefined,
  };

  window.addEventListener('keydown', onWindowKey);
  el.input.addEventListener('input', () => {
    state.query = el.input.value;
    runQuery();
  });
  el.input.addEventListener('keydown', onInputKey);
  el.tabs.addEventListener('click', (e) => {
    const btn = closest(e.target, 'button[data-mode]');
    if (btn) setMode(btn.dataset.mode ?? 'file');
  });
  el.list.addEventListener('click', onListClick);

  return {
    isOpen: () => state.open,
    open: (mode) => open(mode),
    close,
  };

  // --- open / close --------------------------------------------------------

  function open(mode: string): void {
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

  function close(): void {
    if (!state.open) return;
    state.open = false;
    state.reqToken++;
    clearTimeout(state.debounce);
    el.root.classList.remove('on');
    el.input.blur();
    host.highlight(null);
  }

  function setMode(mode: string, opts: { silent?: boolean } = {}): void {
    const next = mode === 'content' ? 'content' : 'file';
    const changed = next !== state.mode;
    state.mode = next;
    for (const b of el.tabs.querySelectorAll<HTMLElement>('button[data-mode]')) {
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

  function onWindowKey(e: KeyboardEvent): void {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'p' && k !== 'f') return;
    e.preventDefault();
    e.stopPropagation();
    open(k === 'p' ? 'file' : 'content');
  }

  function onInputKey(e: KeyboardEvent): void {
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

  function moveCursor(d: number): void {
    if (!state.rows.length) return;
    state.cursor = (state.cursor + d + state.rows.length) % state.rows.length;
    render();
    pushHighlight();
  }

  // --- querying ------------------------------------------------------------

  function runQuery(): void {
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
      if (state.mode === 'content') host.results(null);
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
      host.results(null);
      return;
    }
    state.status = 'searching…';
    render();
    const token = state.reqToken;
    state.debounce = setTimeout(() => runContentQuery(q, token), CONTENT_DEBOUNCE);
  }

  async function runContentQuery(q: string, token: number): Promise<void> {
    const json = await host.search(q);
    if (token !== state.reqToken || !state.open) return;
    if (!json) {
      state.results = [];
      state.status = 'content search requires the dev server';
      render();
      pushHighlight();
      host.results(null);
      return;
    }
    const groups = groupMatches(json.matches);
    state.results = groups;
    const n = groups.length;
    state.status = `${n} file${n === 1 ? '' : 's'}${json.truncated ? ' · truncated' : ''}`;
    state.cursor = 0;
    render();
    pushHighlight();
    // The sidebar keeps this list after the palette closes.
    host.results({ query: q, files: groups, truncated: !!json.truncated });
  }

  /** The fuzzy index over the whole real tree (rebuilt if the root changes). */
  function entries(): Entry[] {
    const root = host.getRoot();
    if (state.entries && state.entryRoot === root) return state.entries;
    const list: Entry[] = [];
    collectEntries(root, list);
    state.entries = list;
    state.entryRoot = root;
    return list;
  }

  /** The current results, seen as the type the active mode produces. */
  function fileResults(): FileResult[] {
    return state.mode === 'file' ? state.results.filter(isFileResult) : [];
  }

  function groupResults(): Group[] {
    return state.mode === 'content' ? state.results.filter(isGroup) : [];
  }

  // --- city highlight ------------------------------------------------------

  function pushHighlight(): void {
    if (!state.open) return;
    // An empty query leaves the city as it was — only a real query dims it.
    if (!state.query.trim()) {
      host.highlight(null);
      return;
    }
    const paths = new Map<string, { w: number; mods: Set<string> | null }>();
    let cursor: { path: string; mods: Set<string> | null } | null = null;

    if (state.mode === 'file') {
      const results = fileResults();
      const n = results.length;
      results.forEach((r, i) => {
        addPath(paths, r.path, 1 - (i / Math.max(n, 1)) * 0.6, r.module);
      });
      const row = state.rows[state.cursor];
      const sel = row ? results[row.gi] : null;
      if (sel) cursor = { path: sel.path, mods: sel.module ? new Set([sel.module]) : null };
    } else {
      const results = groupResults();
      let max = 1;
      for (const g of results) max = Math.max(max, g.matches.length);
      for (const g of results) addPath(paths, g.path, 0.35 + 0.65 * (g.matches.length / max), null);
      const row = state.rows[state.cursor];
      const g = row ? results[row.gi] : null;
      if (g) cursor = { path: g.path, mods: null };
    }
    host.highlight({ paths, cursor });
  }

  function addPath(
    map: Map<string, { w: number; mods: Set<string> | null }>,
    path: string,
    w: number,
    module: string | null
  ): void {
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

  function render(): void {
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
        const r = fileResults()[row.gi];
        if (!r) return '';
        return (
          `<div class="pal-row${active}" data-i="${i}">` +
          `<span class="tag ${r.module ? 'mod' : 'file'}">${r.module ? 'MOD' : 'FILE'}</span>` +
          `<span class="nm">${markHtml(r.label, q)}</span>` +
          `<span class="dir">${markHtml(r.sub, q)}</span>` +
          `</div>`
        );
      }
      const g = groupResults()[row.gi];
      if (!g) return '';
      if (row.type === 'file') {
        const open = state.expanded.has(row.gi);
        return (
          `<div class="pal-row${active}" data-i="${i}">` +
          `<span class="tag ${open ? 'mod' : 'file'}">${open ? '&#9662;' : '&#9656;'}</span>` +
          `<span class="nm">${markHtml(baseName(g.path), q)}</span>` +
          `<span class="dir">${escapeHtml(dirName(g.path))}</span>` +
          `<span class="cnt">${g.matches.length} match${g.matches.length === 1 ? '' : 'es'}</span>` +
          `</div>`
        );
      }
      const m = row.mi === undefined ? undefined : g.matches[row.mi];
      if (!m) return '';
      return (
        `<div class="pal-row line${active}" data-i="${i}">` +
        `<span class="ln">${Number(m.line) || 0}</span>` +
        `<span class="src">${markHtml(m.text, q)}</span>` +
        `</div>`
      );
    });
    el.list.innerHTML = html.join('');
    const active = el.list.querySelector('.pal-row.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function buildRows(): Row[] {
    const rows: Row[] = [];
    if (state.mode === 'file') {
      state.results.forEach((_, gi) => rows.push({ type: 'file', gi }));
      return rows;
    }
    groupResults().forEach((g, gi) => {
      rows.push({ type: 'file', gi });
      if (state.expanded.has(gi)) g.matches.forEach((_, mi) => rows.push({ type: 'line', gi, mi }));
    });
    return rows;
  }

  // --- activation ----------------------------------------------------------

  function onListClick(e: MouseEvent): void {
    const rowEl = closest(e.target, '.pal-row');
    if (!rowEl) return;
    const i = Number(rowEl.dataset.i);
    if (!Number.isFinite(i)) return;
    state.cursor = i;
    activate(i);
  }

  function toggleExpand(gi: number, wantOpen: boolean): void {
    const isOpen = state.expanded.has(gi);
    if (wantOpen === isOpen) return;
    if (isOpen) state.expanded.delete(gi);
    else state.expanded.add(gi);
    render();
  }

  function activate(i: number): void {
    const row = state.rows[i];
    if (!row) return;
    if (state.mode === 'file') {
      const r = fileResults()[row.gi];
      if (!r) return;
      if (host.reveal(r.path, { module: r.module })) close();
      return;
    }
    const g = groupResults()[row.gi];
    if (!g) return;
    if (row.type === 'file' && !state.expanded.has(row.gi) && g.matches.length > 1) {
      // First Enter on a collapsed group opens it; a second one navigates.
      toggleExpand(row.gi, true);
      pushHighlight();
      return;
    }
    const match = row.type === 'line' && row.mi !== undefined ? g.matches[row.mi] : g.matches[0];
    if (!match) return;
    if (host.reveal(g.path, { line: match.line })) close();
  }
}

// ---------------------------------------------------------------------------
// File / module search
// ---------------------------------------------------------------------------

/** @returns best `MAX_RESULTS` matches. */
export function searchFiles(query: string, entries: Entry[]): FileResult[] {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return [];
  const out: Array<{ e: Entry; score: number }> = [];
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

function scoreEntry(q: string, e: Entry): number {
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
export function fuzzyScore(q: string, text: string, boostFrom = 0): number {
  const n = q.length;
  const m = text.length;
  if (!n || n > m) return 0;
  let score = 0;
  let from = 0;
  let prev = -2;
  let run = 0;
  for (let qi = 0; qi < n; qi++) {
    const ch = q[qi];
    if (ch === undefined) return 0;
    const at = text.indexOf(ch, from);
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
function collectEntries(node: VNode | null | undefined, out: Entry[]): void {
  if (!node) return;
  if (node.type === 'file') {
    out.push(makeEntry(node.path, null));
    for (const mod of node.modules || []) out.push(makeEntry(node.path, mod.name));
    return;
  }
  for (const c of node.children || []) collectEntries(c, out);
}

function makeEntry(path: string, module: string | null): Entry {
  const text = (module ? `${path}#${module}` : path).toLowerCase();
  const cut = module ? text.lastIndexOf('#') + 1 : text.lastIndexOf('/') + 1;
  return { path, module, text, boostFrom: cut };
}

// ---------------------------------------------------------------------------
// Content search
// ---------------------------------------------------------------------------

function groupMatches(matches: SearchMatch[]): Group[] {
  const byPath = new Map<string, Group>();
  for (const m of matches) {
    if (!m || typeof m.path !== 'string') continue;
    let g = byPath.get(m.path);
    if (!g) byPath.set(m.path, (g = { path: m.path, matches: [] }));
    g.matches.push({ line: Number(m.line) || 0, text: String(m.text ?? '') });
  }
  return [...byPath.values()].sort((a, b) => b.matches.length - a.matches.length || a.path.localeCompare(b.path));
}

function isFileResult(r: Result): r is FileResult {
  return 'label' in r;
}

function isGroup(r: Result): r is Group {
  return 'matches' in r;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

interface PaletteDom {
  root: HTMLDivElement;
  tabs: HTMLElement;
  input: HTMLInputElement;
  list: HTMLElement;
  status: HTMLElement;
}

function buildDom(): PaletteDom {
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
  const tabs = root.querySelector<HTMLElement>('#pal-tabs');
  const input = root.querySelector<HTMLInputElement>('#pal-input');
  const list = root.querySelector<HTMLElement>('#pal-list');
  const status = root.querySelector<HTMLElement>('#pal-status');
  if (!tabs || !input || !list || !status) throw new Error('palette markup missing');
  return { root, tabs, input, list, status };
}

function baseName(path: string): string {
  const s = String(path);
  return s.slice(s.lastIndexOf('/') + 1);
}

function dirName(path: string): string {
  const s = String(path);
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i);
}

/** `Element.closest` from an event target that may not be an element at all. */
function closest(target: EventTarget | null, selector: string): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(selector) : null;
}
