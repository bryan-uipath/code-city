/**
 * sidebar.ts — the persistent right inspector panel.
 *
 * Three stacked sections: INSPECT (live hover), SELECTED (pinned click, with
 * PRs + commits) and CODE (source span + latest diff from the host). A fourth,
 * TOUR, takes SELECTED's place while a tour is playing.
 * Everything data-derived is escaped before it reaches innerHTML.
 */
import type { CityHost } from '../../shared/host.js';
import type { LogCommit, Pr, SourceResponse } from '../../shared/types.js';
import { relTime, type Timeline } from './timeline.js';

const MAX_COMMITS = 8;
/** Commit rows shown before the "+N more" expander. */
const COMMIT_PEEK = 5;
const PR_PEEK = 6;
/** Search result rows shown before the list is cut off. */
const SEARCH_FILE_PEEK = 40;
const SEARCH_LINE_PEEK = 12;

/** How a working-tree path differs from HEAD. */
export type WorkKind = 'modified' | 'untracked' | 'deleted';

export interface WorkChange {
  path: string;
  kind: WorkKind;
  /** False when the path has no plate in the city (new file, ignored root…). */
  inCity: boolean;
}

/** The Working-tree layer's sidebar section; null hides it. */
export interface WorkingTree {
  changes: WorkChange[];
  onSelect(path: string): void;
  onRefresh(): void;
}

/** One matched source line of a content search. */
export interface SearchLine {
  line: number;
  text: string;
}

/** One file's content-search hits, as the palette found them. */
export interface SearchFileHits {
  path: string;
  matches: SearchLine[];
}

/**
 * The ⌘F results, mirrored out of the palette so they outlive it: the palette
 * is a launcher, this is the list you keep working through.
 */
export interface SearchResults {
  query: string;
  files: SearchFileHits[];
  truncated: boolean;
  /** Select + fly to the file (no line). */
  onSelectFile(path: string): void;
  /** Select the file and open the code pane at that line. */
  onSelectLine(path: string, line: number): void;
}

/**
 * One artifact of the current tour step, already resolved and safety-checked by
 * the player (diffs fetched through the host, URLs scheme-validated).
 */
export type TourArtifactView =
  | { type: 'diff'; label: string; diff: string | null }
  | { type: 'image'; src: string; caption: string | null }
  | { type: 'link'; href: string; label: string };

/** The tour player's sidebar section; null removes it and restores SELECTED. */
export interface TourView {
  title: string;
  /** 1-based. */
  index: number;
  count: number;
  stepTitle: string;
  /** Plain text — rendered as escaped paragraphs, never as markup. */
  narration: string;
  artifacts: TourArtifactView[];
}

/** What main.ts hands over for one hovered / selected thing. */
export interface Descriptor {
  name: string;
  kind: string;
  kindColor: number;
  path: string;
  loc?: number;
  churn?: number;
  fixChurn?: number;
  recentChurn?: number;
  /** One extra line under the path — e.g. the commit a strata level stands for. */
  note?: string;
  /** How this file sits inside the active strata filter — `3 of 41 commits match filter`. */
  filterNote?: string;
  /** Replaces the default LOC/CHURN/FIX/RECENT grid (PR descriptors). */
  grid?: Array<[string, string | number]>;
  prs: Pr[];
  coupling?: { out: number; in: number } | null;
  codePath: string | null;
  span: { start: number; end: number } | null;
  /** File-level or deeper — the code pane is worth widening for. */
  deep: boolean;
  /** Filled in from the host when there is no commit stream. */
  logCommits?: LogCommit[];
}

export interface Sidebar {
  /** Live hover descriptor (null clears to the hint). */
  setHover(desc: Descriptor | null): void;
  /** Pinned selection descriptor; triggers PR/commit/code refresh. */
  setSelection(desc: Descriptor | null): void;
  /** Time cursor (epoch seconds or null) — re-renders the commit list. */
  setCursor(t: number | null): void;
  /** Content-search results; null removes the section. */
  setSearch(view: SearchResults | null): void;
  /** Whether the search section is currently showing anything. */
  hasSearch(): boolean;
  /** Working-tree change list; null removes the section. */
  setWorkingTree(view: WorkingTree | null): void;
  /** Current tour step; null removes the section and restores SELECTED. */
  setTour(view: TourView | null): void;
}

export function createSidebar(
  opts: { host: CityHost; timeline: Timeline | null; githubUrl?: string | null; onWidthChange?: (wide: boolean) => void }
): Sidebar {
  const root = requireEl('sidebar');
  const body = requireEl('sb-body');
  const widthBtn = requireEl('sb-width');

  const secInspect = section('inspect');
  const secTour = section('tour');
  const secSearch = section('search');
  const secSelected = section('selected');
  const secWork = section('worktree');
  const secCode = section('code');
  body.append(secInspect, secTour, secSearch, secSelected, secWork, secCode);

  const state: {
    hover: Descriptor | null;
    selected: Descriptor | null;
    manualWide: boolean | null;
    wide: boolean;
    codeToken: number;
    cursor: number | null;
    /** PR numbers expanded to their full title in the SELECTED section. */
    openPrs: Set<number>;
    allCommits: boolean;
    work: WorkingTree | null;
    tour: TourView | null;
    search: SearchResults | null;
    /** Result files expanded to their matched lines. */
    openHits: Set<string>;
  } = {
    hover: null,
    selected: null,
    /** null = follow auto-expand, true/false = manual override. */
    manualWide: null,
    wide: false,
    codeToken: 0,
    cursor: null,
    openPrs: new Set(),
    allCommits: false,
    work: null,
    tour: null,
    search: null,
    openHits: new Set(),
  };

  widthBtn.addEventListener('click', () => {
    state.manualWide = !state.wide;
    applyWidth();
  });

  // Compact rows expand in place rather than opening anything.
  secSelected.addEventListener('click', (e) => {
    const pr = closest(e.target, '.sb-pr[data-pr]');
    if (pr) {
      const n = Number(pr.dataset.pr);
      if (state.openPrs.has(n)) state.openPrs.delete(n);
      else state.openPrs.add(n);
      renderSelected();
      return;
    }
    if (closest(e.target, '.sb-more')) {
      state.allCommits = !state.allCommits;
      renderSelected();
    }
  });

  // A result row selects its file; the caret (or a second click) unfolds the
  // matched lines, and a line opens the code pane on that span.
  secSearch.addEventListener('click', (e) => {
    const view = state.search;
    if (!view) return;
    const lineEl = closest(e.target, '.sb-hit-line[data-path]');
    if (lineEl) {
      const path = lineEl.dataset.path;
      const line = Number(lineEl.dataset.line);
      if (path && Number.isFinite(line)) view.onSelectLine(path, line);
      return;
    }
    const fileEl = closest(e.target, '.sb-hit[data-path]');
    const path = fileEl?.dataset.path;
    if (!path) return;
    if (state.openHits.has(path)) state.openHits.delete(path);
    else state.openHits.add(path);
    renderSearch();
    view.onSelectFile(path);
  });

  secWork.addEventListener('click', (e) => {
    const work = state.work;
    if (!work) return;
    if (closest(e.target, '#sb-work-refresh')) {
      work.onRefresh();
      return;
    }
    const row = closest(e.target, '.sb-work[data-path]');
    const path = row?.dataset.path;
    if (path) work.onSelect(path);
  });

  renderInspect();
  renderTour();
  renderSearch();
  renderSelected();
  renderWork();
  secCode.style.display = 'none';

  return {
    setHover(desc) {
      state.hover = desc;
      renderInspect();
    },
    setSelection(desc) {
      state.selected = desc;
      state.openPrs.clear();
      state.allCommits = false;
      renderSelected();
      loadCode(desc);
      applyWidth();
    },
    setCursor(t) {
      state.cursor = t;
      renderSelected();
    },
    setSearch(view) {
      // A new query starts folded; the same query re-rendered keeps its state.
      if (!view || !state.search || view.query !== state.search.query) state.openHits.clear();
      state.search = view;
      renderSearch();
    },
    hasSearch() {
      return state.search !== null;
    },
    setWorkingTree(view) {
      state.work = view;
      renderWork();
    },
    setTour(view) {
      state.tour = view;
      renderTour();
      renderSelected();
    },
  };

  // --- sections ------------------------------------------------------------

  function renderInspect(): void {
    const d = state.hover;
    secInspect.innerHTML =
      `<div class="h"><span>Inspect</span><em>hover</em></div>` +
      (d ? statsHtml(d) : `<div class="sb-hint">Hover a plate or building</div>`);
  }

  /**
   * The tour step. Narration is UNTRUSTED author text: it is escaped and split
   * on blank lines into paragraphs, never interpreted as markup of any kind.
   */
  function renderTour(): void {
    const t = state.tour;
    if (!t) {
      secTour.style.display = 'none';
      secTour.innerHTML = '';
      return;
    }
    secTour.style.display = '';
    const paras = t.narration
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<div class="sb-para">${escapeHtml(p)}</div>`)
      .join('');
    secTour.innerHTML =
      `<div class="h"><span>Tour</span><em>${t.index} / ${t.count}</em></div>` +
      `<div class="sb-tour-tour">${escapeHtml(t.title)}</div>` +
      `<div class="sb-name">${escapeHtml(t.stepTitle)}</div>` +
      (paras || `<div class="sb-hint">No narration</div>`) +
      t.artifacts.map(artifactHtml).join('');
  }

  function renderSelected(): void {
    // The tour owns this slot while it plays.
    if (state.tour) {
      secSelected.style.display = 'none';
      return;
    }
    secSelected.style.display = '';
    const d = state.selected;
    if (!d) {
      secSelected.innerHTML =
        `<div class="h"><span>Selected</span><em>click to pin</em></div>` +
        `<div class="sb-hint">Nothing pinned</div>`;
      return;
    }
    secSelected.innerHTML =
      `<div class="h"><span>Selected</span><em>${escapeHtml(d.kind || '')}</em></div>` +
      statsHtml(d) +
      prsHtml(d.prs || []) +
      commitsHtml(d);
    loadFallbackCommits(d);
  }

  function statsHtml(d: Descriptor): string {
    const grid = d.grid
      ? d.grid.map(([k, v]) => cell(k, v)).join('')
      : cell('LOC', d.loc) + cell('CHURN', d.churn) + cell('FIX', d.fixChurn) + cell('RECENT', d.recentChurn);
    const coupling = d.coupling
      ? `<div class="sb-sub">imports ${fmt(d.coupling.out)} &rarr; · &larr; imported by ${fmt(d.coupling.in)}</div>`
      : '';
    return (
      `<div class="sb-name">${escapeHtml(d.name)}</div>` +
      `<div class="sb-kind" style="color:${cssColor(d.kindColor)}">${escapeHtml(d.kind || '')}</div>` +
      `<div class="sb-path">${escapeHtml(d.path || '—')}</div>` +
      (d.note ? `<div class="sb-note">${escapeHtml(d.note)}</div>` : '') +
      (d.filterNote ? `<div class="sb-note filter">${escapeHtml(d.filterNote)}</div>` : '') +
      `<div class="sb-grid">${grid}</div>` +
      coupling
    );
  }

  /** One line per PR — `#3088 · title · @author · 3d` — full detail on click. */
  function prsHtml(prs: Pr[]): string {
    if (!prs.length) return '';
    const rows = prs.slice(0, PR_PEEK).map((pr) => {
      const num = Number(pr.number) || 0;
      const open = state.openPrs.has(num);
      const stats =
        Number.isFinite(pr.additions) || Number.isFinite(pr.deletions)
          ? ` <span class="add">+${fmt(pr.additions || 0)}</span><span class="del">&minus;${fmt(pr.deletions || 0)}</span>`
          : '';
      const age = prAge(pr);
      const draft = pr.isDraft ? `<span class="draft">D</span>` : '';
      const head =
        `<span class="num">#${num}</span>` +
        `<span class="ttl">${escapeHtml(open ? pr.title || '' : truncate(pr.title || '', 34))}</span>` +
        draft +
        `<span class="who">@${escapeHtml(pr.author || '?')}</span>` +
        (age ? `<span class="age">${escapeHtml(shortAge(age))}</span>` : '') +
        stats;
      const detail = open
        ? `<div class="det">${fmt(pr.files.length)} file${pr.files.length === 1 ? '' : 's'}` +
          (age ? ` · updated ${escapeHtml(age)}` : '') + `</div>`
        : '';
      return `<div class="sb-pr${open ? ' open' : ''}" data-pr="${num}"><div class="ln">${head}</div>${detail}</div>`;
    });
    const more = prs.length > PR_PEEK ? `<div class="sb-pr who">+${prs.length - PR_PEEK} more</div>` : '';
    return `<div class="sb-sub">${prs.length} open PR${prs.length > 1 ? 's' : ''}</div>` + rows.join('') + more;
  }

  function commitsHtml(d: Descriptor): string {
    const list = commitsFor(d);
    if (!list.length) return '';
    const t = state.cursor;
    const title = t === null ? 'Recent commits' : 'Commits near cursor';
    const shown = state.allCommits ? list.slice(0, MAX_COMMITS) : list.slice(0, COMMIT_PEEK);
    const rows = shown.map((c) => {
      const near = t !== null && Math.abs(c.ts - t) < 2 * 86400;
      const when = t === null ? shortAge(relTime(c.ts)) : new Date(c.ts * 1000).toISOString().slice(5, 10);
      const shortHash = String(c.h || '').slice(0, 7).replace(/[^0-9a-f]/gi, '');
      const github = opts.githubUrl;
      const hashHtml = github && /^https:\/\/github\.com\//.test(github)
        ? `<a class="h" href="${github}/commit/${shortHash}" target="_blank" rel="noopener noreferrer">${shortHash}</a>`
        : `<span class="h">${shortHash}</span>`;
      return (
        `<div class="sb-commit${near ? ' near' : ''}">` +
        `${hashHtml}<span class="msg">${escapeHtml(truncate(c.s || '', 44))}</span>` +
        `<span class="who">${escapeHtml(c.a || '')}</span>` +
        `<span class="when">${escapeHtml(when)}</span></div>`
      );
    });
    const hidden = Math.min(list.length, MAX_COMMITS) - shown.length;
    const more = hidden > 0 || state.allCommits
      ? `<div class="sb-more">${state.allCommits ? '− less' : `+${hidden} more`}</div>`
      : '';
    return `<div class="sb-sub">${title}</div>` + rows.join('') + more;
  }

  // --- search results ------------------------------------------------------

  /**
   * The palette's content hits, kept alive after it closes. Paths, source lines
   * and the echoed query are all author-controlled text: escaped here, with the
   * query marked inside the escaped result.
   */
  function renderSearch(): void {
    const view = state.search;
    if (!view) {
      secSearch.style.display = 'none';
      secSearch.innerHTML = '';
      return;
    }
    secSearch.style.display = '';
    const n = view.files.length;
    let total = 0;
    for (const f of view.files) total += f.matches.length;
    const head =
      `<div class="h"><span>Search</span>` +
      `<em>${fmt(total)} in ${fmt(n)} file${n === 1 ? '' : 's'}${view.truncated ? ' +' : ''}</em></div>` +
      `<div class="sb-path">${escapeHtml(view.query)}</div>`;
    if (!n) {
      secSearch.innerHTML = head + `<div class="sb-hint">No matches</div>`;
      return;
    }

    const parts: string[] = [];
    for (const file of view.files.slice(0, SEARCH_FILE_PEEK)) {
      const open = state.openHits.has(file.path);
      parts.push(
        `<div class="sb-hit${open ? ' open' : ''}" data-path="${escapeHtml(file.path)}">` +
        `<span class="tw">${open ? '&#9662;' : '&#9656;'}</span>` +
        `<span class="nm">${escapeHtml(baseName(file.path))}</span>` +
        `<span class="dir">${escapeHtml(dirName(file.path))}</span>` +
        `<span class="cnt">${fmt(file.matches.length)}</span></div>`
      );
      if (!open) continue;
      for (const m of file.matches.slice(0, SEARCH_LINE_PEEK)) {
        parts.push(
          `<div class="sb-hit-line" data-path="${escapeHtml(file.path)}" data-line="${Number(m.line) || 0}">` +
          `<span class="ln">${Number(m.line) || 0}</span>` +
          `<span class="src">${markHtml(m.text, view.query)}</span></div>`
        );
      }
      if (file.matches.length > SEARCH_LINE_PEEK) {
        parts.push(`<div class="sb-hint">+${fmt(file.matches.length - SEARCH_LINE_PEEK)} more lines</div>`);
      }
    }
    if (n > SEARCH_FILE_PEEK) parts.push(`<div class="sb-hint">+${fmt(n - SEARCH_FILE_PEEK)} more files</div>`);
    secSearch.innerHTML = head + parts.join('');
  }

  // --- working tree --------------------------------------------------------

  function renderWork(): void {
    const work = state.work;
    if (!work) {
      secWork.style.display = 'none';
      secWork.innerHTML = '';
      return;
    }
    secWork.style.display = '';
    const head =
      `<div class="h"><span>Working tree</span>` +
      `<button id="sb-work-refresh" type="button" title="Re-read git status">&#8635;</button></div>`;
    if (!work.changes.length) {
      secWork.innerHTML = head + `<div class="sb-hint">Clean</div>`;
      return;
    }
    const order: WorkKind[] = ['modified', 'untracked', 'deleted'];
    const parts: string[] = [];
    for (const kind of order) {
      const rows = work.changes.filter((c) => c.kind === kind);
      if (!rows.length) continue;
      parts.push(`<div class="sb-sub">${kind} · ${rows.length}</div>`);
      for (const c of rows.slice(0, 60)) {
        parts.push(
          `<div class="sb-work ${kind}${c.inCity ? '' : ' ghost'}" data-path="${escapeHtml(c.path)}">` +
          `<span class="nm">${escapeHtml(baseName(c.path))}</span>` +
          `<span class="dir">${escapeHtml(dirName(c.path))}</span></div>`
        );
      }
      if (rows.length > 60) parts.push(`<div class="sb-hint">+${rows.length - 60} more</div>`);
    }
    secWork.innerHTML = head + parts.join('');
  }

  function commitsFor(d: Descriptor): LogCommit[] {
    const codePath = d.codePath;
    if (!codePath) return [];
    const tl = opts.timeline;
    if (tl && tl.enabled) {
      return state.cursor === null ? tl.commitsFor(codePath).slice(0, MAX_COMMITS)
                                   : tl.commitsNear(state.cursor, codePath, MAX_COMMITS);
    }
    return d.logCommits || [];
  }

  /** Without a commit stream, ask the host for this path's log (once). */
  function loadFallbackCommits(d: Descriptor): void {
    const tl = opts.timeline;
    if ((tl && tl.enabled) || !d.codePath || d.logCommits || !opts.host.available()) return;
    const token = ++state.codeToken;
    opts.host.getLog(d.codePath).then((json) => {
      if (!json || token !== state.codeToken || state.selected !== d) return;
      d.logCommits = Array.isArray(json.commits) ? json.commits : [];
      renderSelected();
    });
  }

  // --- code ----------------------------------------------------------------

  async function loadCode(d: Descriptor | null): Promise<void> {
    const token = ++state.codeToken;
    const codePath = d ? d.codePath : null;
    if (!d || !codePath || !opts.host.available()) {
      secCode.style.display = 'none';
      return;
    }
    secCode.style.display = '';
    secCode.innerHTML = `<div class="h"><span>Code</span><em>loading…</em></div>`;

    const start = d.span ? d.span.start : 1;
    const end = d.span ? d.span.end : start + 160;
    const src = await opts.host.getSource(codePath, start, end);
    if (token !== state.codeToken) return;
    if (!src) {
      secCode.style.display = 'none';
      return;
    }

    const head =
      `<div class="h"><span>Code</span><em>${escapeHtml(baseName(codePath))} ` +
      `${Number(src.start) || start}–${Number(src.end) || end}</em></div>`;
    secCode.innerHTML = head + sourceHtml(src, Number(src.start) || start);

    const latest = latestHashFor(d);
    if (!latest) return;
    const diff = await opts.host.getDiff(codePath, latest);
    if (token !== state.codeToken || !diff || !diff.diff) return;
    secCode.insertAdjacentHTML(
      'beforeend',
      `<div class="sb-sub">Latest diff · ${escapeHtml(latest.slice(0, 7))}</div>` + diffHtml(diff.diff)
    );
  }

  function latestHashFor(d: Descriptor): string | null {
    const codePath = d.codePath;
    const tl = opts.timeline;
    if (tl && tl.enabled && codePath) {
      const list = state.cursor === null ? tl.commitsFor(codePath) : tl.commitsNear(state.cursor, codePath, 1);
      const first = list[0];
      return first ? first.h : null;
    }
    const logged = d.logCommits && d.logCommits.length ? d.logCommits[0] : null;
    return logged ? logged.h : null;
  }

  // --- width ---------------------------------------------------------------

  function applyWidth(): void {
    const auto = !!(state.selected && state.selected.deep);
    state.wide = state.manualWide === null ? auto : state.manualWide;
    root.classList.toggle('wide', state.wide);
    // The timeline bar sizes itself against this so the two never overlap.
    document.documentElement.style.setProperty('--sb-w', state.wide ? '560px' : '300px');
    opts.onWidthChange?.(state.wide);
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function sourceHtml(src: SourceResponse, start: number): string {
  const lines = Array.isArray(src.lines) ? src.lines.slice(0, 400) : [];
  if (!lines.length) return `<div class="sb-hint">empty</div>`;
  const out = lines.map((line, i) =>
    `<span class="ln">${String(start + i).padStart(4, ' ')}</span> ${escapeHtml(String(line))}`
  );
  return `<div class="sb-code">${out.join('\n')}</div>`;
}

function diffHtml(text: string): string {
  const lines = String(text).split('\n').slice(0, 400);
  const out = lines.map((line) => {
    const cls =
      line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')
        ? 'meta'
        : line.startsWith('+') ? 'add'
        : line.startsWith('-') ? 'del'
        : '';
    return cls ? `<span class="${cls}">${escapeHtml(line)}</span>` : escapeHtml(line);
  });
  return `<div class="sb-code">${out.join('\n')}</div>`;
}

/**
 * One tour artifact. `src`/`href` were scheme-validated by the SDK's
 * `validateTour`; escaping here closes the attribute-injection half.
 */
function artifactHtml(a: TourArtifactView): string {
  if (a.type === 'diff') {
    return (
      `<div class="sb-sub">Diff · ${escapeHtml(a.label)}</div>` +
      (a.diff ? diffHtml(a.diff) : `<div class="sb-hint">diff unavailable</div>`)
    );
  }
  if (a.type === 'image') {
    return (
      `<img class="sb-shot" src="${escapeHtml(a.src)}" alt="${escapeHtml(a.caption ?? '')}" />` +
      (a.caption ? `<div class="sb-hint">${escapeHtml(a.caption)}</div>` : '')
    );
  }
  return (
    `<a class="sb-link" href="${escapeHtml(a.href)}" target="_blank" rel="noopener noreferrer">` +
    `${escapeHtml(a.label)} &#8599;</a>`
  );
}

function prAge(pr: Pr): string {
  const t = Date.parse(pr.updatedAt || '');
  return Number.isFinite(t) ? relTime(t / 1000) : '';
}

function section(id: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'sb-sec';
  el.id = 'sb-' + id;
  return el;
}

function cell(k: string, v: string | number | undefined): string {
  const text = typeof v === 'number' ? fmt(v) : escapeHtml(String(v ?? '—'));
  return `<div><div class="k">${escapeHtml(k)}</div><div class="v">${text}</div></div>`;
}

function cssColor(hex: number | undefined): string {
  return typeof hex === 'number' ? '#' + hex.toString(16).padStart(6, '0') : '#22d3ee';
}

function fmt(n: number | undefined): string {
  return Number(n || 0).toLocaleString('en-US');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} in the sidebar markup`);
  return el;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** "3d ago" -> "3d", so a compact row survives on one line. */
function shortAge(rel: string): string {
  return rel.replace(/\s*ago$/, '');
}

/** `Element.closest` from an event target that may not be an element at all. */
function closest(target: EventTarget | null, selector: string): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(selector) : null;
}

/**
 * Escape `text`, wrapping every case-insensitive occurrence of `q` in `<mark>`.
 * Both the palette rows and the sidebar's mirror of them render through this.
 */
export function markHtml(text: string, q: string): string {
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

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}
