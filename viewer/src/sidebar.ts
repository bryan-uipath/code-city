/**
 * sidebar.ts — the persistent right inspector panel.
 *
 * Three stacked sections: INSPECT (live hover), SELECTED (pinned click, with
 * PRs + commits) and CODE (source span + latest diff from the host). A fourth,
 * TOUR, takes SELECTED's place while a tour is playing. REVIEW lists a diff's
 * files and their untouched importers.
 * Everything data-derived is escaped before it reaches innerHTML.
 */
import { isCommitHash, type CityHost } from '../../shared/host.js';
import type { ContentKind, DiffEntry, DiffResponse, LogCommit, OffCity, Pr, SourceResponse } from '../../shared/types.js';
import type { Words } from '../../shared/vocab.js';
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
  /** Lines added / removed against HEAD; 0 when git could not say. */
  added?: number;
  removed?: number;
}

/** The Working-tree layer's sidebar section; null hides it. */
export interface WorkingTree {
  changes: WorkChange[];
  onSelect(path: string): void;
  onRefresh(): void;
}

/** One changed file of the diff and the signals the read-first queue sorts on. */
export interface ReviewFile {
  path: string;
  /** Provenance buckets of its added lines, and its deleted lines. */
  verbatim: number;
  reshaped: number;
  new: number;
  deleted: number;
  /** Fix-looking commits on it in the last 12 months. */
  fix: number;
  /** Files that statically import it. */
  importers: number;
  /** Its base-side path, when the range renamed it. */
  oldPath?: string;
}

/** A changed path with no building, and the reason. */
export interface ReviewOffCity extends DiffEntry {
  why: OffCity;
}

/** A file the diff does not touch that imports a changed one (hop 1) or a hop-1 file (hop 2). */
export interface ReviewConsumer {
  path: string;
  hop: 1 | 2;
  /** The imported files that put it here: changed files for hop 1, hop-1 files for hop 2. */
  via: string[];
}

export type ReviewSort = 'new' | 'fix' | 'importers' | 'deleted';

/** The diff's review section; null hides it. */
export interface ReviewView {
  files: ReviewFile[];
  consumers: ReviewConsumer[];
  /** True when the 2nd hop hit its cap. */
  hop2Capped: boolean;
  /** Changed paths the city has no building for. */
  offCity: ReviewOffCity[];
  /** Paths the reviewer marked visited — live: main.ts mutates it and calls `refreshReview`. */
  visited: ReadonlyMap<string, string>;
  /** The analyzed range, for the diff of a path with no building. */
  base: string;
  head: string;
  onSelect(path: string): void;
  /** An off-city row opened its diff: drop the city selection it replaces. */
  onOpenOffCity(): void;
  /** The row's check was clicked. */
  onVisit(path: string): void;
}

/** Why a changed path is not a building, as the list says it (`OffCity` order). */
const OFF_CITY_WHY: Array<[OffCity, string]> = [
  ['deleted', 'deleted — nothing to stand at head'],
  ['binary', 'binary — no lines to read'],
  ['outside-roots', 'outside the analyzed roots'],
  ['filtered', 'a type or folder the analyzer skips'],
  ['not-at-head', 'not in the analyzed checkout'],
];

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
  | { type: 'diff'; label: string; diff: DiffResponse | null }
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

/** The analyzed range for one file; `lines` clips to a module, in diff-head numbering (null: none at head). */
export interface RangeDiff {
  base: string;
  head: string;
  lines?: { start: number; end: number } | null;
  /** The file's modules and members, head-numbered: each hunk is labelled by the innermost one around it. */
  outline?: OutlineEntry[];
}

export interface OutlineEntry {
  name: string;
  kind: string;
  start: number;
  end: number;
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
  /** Its share of the analyzed diff — `+449 · 87% verbatim · 3% reshaped · 10% new`. */
  provNote?: string;
  /** In the analyzed diff: the code pane shows base→head instead of the latest commit. */
  rangeDiff?: RangeDiff;
  /** Replaces the default LOC/CHURN/FIX/RECENT grid (PR descriptors). */
  grid?: Array<[string, string | number]>;
  prs: Pr[];
  coupling?: { out: number; in: number } | null;
  codePath: string | null;
  span: { start: number; end: number } | null;
  /** The module's own lines — scopes the commit log; `span` is only the reading window. */
  logSpan?: { start: number; end: number };
  /** `span` is an explicit line target (a search hit): the code pane opens on source, not changes. */
  sourceFirst?: boolean;
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
  /** The diff's read-first queue and untouched importers; null removes the section. */
  setReview(view: ReviewView | null): void;
  /** Re-render the review lists (visited marks moved). */
  refreshReview(): void;
  /** Current tour step; null removes the section and restores SELECTED. */
  setTour(view: TourView | null): void;
}

export function createSidebar(
  opts: { host: CityHost; timeline: Timeline | null; githubUrl?: string | null; words: Words; onWidthChange?: (wide: boolean) => void }
): Sidebar {
  const words = opts.words;
  const root = requireEl('sidebar');
  const body = requireEl('sb-body');
  const widthBtn = requireEl('sb-width');

  const secInspect = section('inspect');
  const secTour = section('tour');
  const secSearch = section('search');
  const secReview = section('review');
  const secSelected = section('selected');
  const secWork = section('worktree');
  const secCode = section('code');
  body.append(secInspect, secTour, secSearch, secReview, secSelected, secWork, secCode);

  const spanLogs = new Map<string, { commits: LogCommit[]; scoped: boolean }>(); // span key -> its log
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
    review: ReviewView | null;
    reviewSort: ReviewSort;
    /** The bounded 2nd importer hop is unfolded. */
    reviewHop2: boolean;
    /** The off-city path whose diff fills the code pane; a city selection clears it. */
    offSel: string | null;
    /** The reviewer unfolded the queue while something is selected; deselecting resets it. */
    reviewOpen: boolean;
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
    review: null,
    reviewSort: 'new',
    reviewHop2: false,
    offSel: null,
    reviewOpen: false,
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

  secCode.addEventListener('click', (e) => {
    const d = state.selected;
    if (closest(e.target, '.sb-src-btn[data-src]')) {
      if (!d || !d.codePath || secCode.querySelector('.sb-src-btn.on')) return;
      closest(e.target, '.sb-src-btn')?.classList.add('on');
      void loadSource(d, d.codePath, state.codeToken);
      return;
    }
    closest(e.target, '.sb-hunk-h')?.parentElement?.classList.toggle('open');
  });

  secReview.addEventListener('click', (e) => {
    const view = state.review;
    if (!view) return;
    const sort = closest(e.target, '.sb-rv-sort[data-sort]')?.dataset.sort;
    if (sort === 'new' || sort === 'fix' || sort === 'importers' || sort === 'deleted') {
      state.reviewSort = sort;
      renderReview();
      return;
    }
    if (closest(e.target, '.sb-more')) {
      state.reviewHop2 = !state.reviewHop2;
      renderReview();
      return;
    }
    if (closest(e.target, '.sb-rv-fold[data-fold]')) {
      state.reviewOpen = !state.reviewOpen;
      renderReview();
      return;
    }
    // The check marks; the rest of the row selects and flies.
    const visit = closest(e.target, '.sb-rv-visit[data-visit]')?.dataset.visit;
    if (visit) {
      view.onVisit(visit);
      return;
    }
    const off = closest(e.target, '.sb-rv[data-off]')?.dataset.off;
    if (off) {
      view.onOpenOffCity();
      loadOffCityDiff(view, off);
      return;
    }
    const path = closest(e.target, '.sb-rv[data-path]')?.dataset.path;
    if (path) view.onSelect(path);
  });

  renderInspect();
  renderTour();
  renderSearch();
  renderReview();
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
      state.offSel = null;
      if (!desc) state.reviewOpen = false;
      state.openPrs.clear();
      state.allCommits = false;
      renderSelected();
      renderReview(); // marks the selected row
      if (desc) loadSpanCommits(desc); // before loadCode: the tour skips renderSelected
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
      spanLogs.clear(); // a re-read of the tree re-reads the per-span logs too
      state.work = view;
      renderWork();
    },
    setReview(view) {
      state.review = view;
      renderReview();
    },
    refreshReview() {
      renderReview();
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
      : cell(words.mass.toUpperCase(), d.loc) + cell('CHURN', d.churn) + cell('FIX', d.fixChurn) + cell('RECENT', d.recentChurn);
    const coupling = d.coupling
      ? `<div class="sb-sub">imports ${fmt(d.coupling.out)} &rarr; · &larr; imported by ${fmt(d.coupling.in)}</div>`
      : '';
    return (
      `<div class="sb-name">${escapeHtml(d.name)}</div>` +
      `<div class="sb-kind" style="color:${cssColor(d.kindColor)}">${escapeHtml(d.kind || '')}</div>` +
      `<div class="sb-path">${escapeHtml(d.path || '—')}</div>` +
      (d.note ? `<div class="sb-note">${escapeHtml(d.note)}</div>` : '') +
      (d.filterNote ? `<div class="sb-note filter">${escapeHtml(d.filterNote)}</div>` : '') +
      (d.provNote ? `<div class="sb-note prov">${escapeHtml(d.provNote)}</div>` : '') +
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
    const key = spanKey(d);
    const log = key ? spanLogs.get(key) : undefined;
    if (key && !log) return `<div class="sb-sub">Commits on these lines…</div>`;
    if (!list.length) return '';
    const t = state.cursor;
    const title = log ? (log.scoped ? 'Commits on these lines' : 'Recent commits · file')
      : escapeHtml(t === null ? `Recent ${words.event.many}` : `${words.event.many} near cursor`);
    const shown = state.allCommits ? list.slice(0, MAX_COMMITS) : list.slice(0, COMMIT_PEEK);
    const rows = shown.map((c) => {
      const near = t !== null && Math.abs(c.ts - t) < 2 * 86400;
      const when = t === null ? shortAge(relTime(c.ts)) : new Date(c.ts * 1000).toISOString().slice(5, 10);
      const id = String(c.h || '');
      const isHash = isCommitHash(id);
      const shortHash = isHash ? id.slice(0, 7) : truncate(id, 12);
      const github = opts.githubUrl;
      const hashHtml = github && isHash && /^https:\/\/github\.com\//.test(github)
        ? `<a class="h" href="${github}/commit/${shortHash}" target="_blank" rel="noopener noreferrer">${shortHash}</a>`
        : `<span class="h">${escapeHtml(shortHash)}</span>`;
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

  // --- review --------------------------------------------------------------

  /**
   * The read-first queue: changed files sorted by ONE signal the reader picks
   * (ties fall to new lines), every signal shown on the row. No blended score —
   * these are reasons to look first, not a defect estimate. Below it, the
   * direct importers the diff left untouched.
   */
  function renderReview(): void {
    const view = state.review;
    if (!view) {
      secReview.style.display = 'none';
      secReview.innerHTML = '';
      return;
    }
    secReview.style.display = '';
    const key = state.reviewSort;
    const files = view.files.slice().sort((a, b) =>
      b[key] - a[key] || b.new - a.new || (a.path < b.path ? -1 : 1));
    const sel = state.selected?.codePath ?? null;
    // One row: name + folder, then a line of signals (`sig` is markup). `attr` = what a click opens.
    const rvRow = (path: string, cls: string, sig: string, attr: 'path' | 'off' | null = 'path', lead = ''): string =>
      `<div class="sb-rv${cls}${path === sel || path === state.offSel ? ' sel' : ''}"` +
      `${attr ? ` data-${attr}="${escapeHtml(path)}"` : ''}>` +
      `<div class="ln">${lead}<span class="nm">${escapeHtml(baseName(path))}</span>` +
      `<span class="dir">${escapeHtml(dirName(path))}</span></div><div class="sig">${sig}</div></div>`;
    const sorts: ReviewSort[] = ['new', 'fix', 'importers', 'deleted'];
    const seen = files.filter((f) => view.visited.has(f.path)).length;
    // While something is selected the queue folds to one strip, so the code pane sits near the top:
    // `REVIEW · 3/25 visited · next main.ts ▸ · list ▾`. The header click unfolds it until deselect.
    if ((state.selected || state.offSel) && !state.reviewOpen) {
      const next = files.find((f) => !view.visited.has(f.path) && f.path !== sel);
      secReview.innerHTML =
        `<div class="h sb-rv-fold" data-fold="1"><span>Review</span><em>${fmt(seen)}/${fmt(files.length)} visited` +
        ` · list ▾</em></div>` +
        (next ? `<div class="sb-rv-next sb-rv" data-path="${escapeHtml(next.path)}">next ` +
          `<span class="nm">${escapeHtml(baseName(next.path))}</span> <span class="dir">${escapeHtml(dirName(next.path))}</span> ▸</div>`
          : `<div class="sb-hint">every file visited</div>`);
      return;
    }
    const parts: string[] = [
      `<div class="h${state.selected || state.offSel ? ' sb-rv-fold' : ''}" data-fold="1"><span>Review</span>` +
        `<em>${fmt(files.length + view.offCity.length)} changed` +
        `${seen ? ` · ${fmt(seen)}/${fmt(files.length)} visited` : ''}${state.selected || state.offSel ? ' · fold ▴' : ''}</em></div>`,
      `<div class="sb-sub">Read first · by ` +
        sorts.map((k) => `<span class="sb-rv-sort${k === key ? ' on' : ''}" data-sort="${k}">${k}</span>`).join(' ') +
        `</div>`,
    ];
    for (const f of files) {
      // [class, text, tooltip] — only the signals this file actually has.
      const sig: Array<[string, string, string]> = [];
      if (f.new) sig.push(['new', `+${fmt(f.new)} new`, 'added lines nothing in the diff explains']);
      if (f.reshaped) sig.push(['reshaped', `+${fmt(f.reshaped)} reshaped`, 'moved, modified in transit']);
      if (f.verbatim) sig.push(['verbatim', `+${fmt(f.verbatim)} verbatim`, 'moved unchanged — prioritized lower, not verified']);
      if (f.deleted) sig.push(['deleted', `−${fmt(f.deleted)}`, 'deleted lines']);
      if (f.fix) sig.push(['fix', `fix ${fmt(f.fix)}`, 'fix-looking commits on it, last 12 months']);
      if (f.importers) sig.push(['importers', `←${fmt(f.importers)}`, 'files that statically import it']);
      // The full old path: a move keeps its basename.
      if (f.oldPath) sig.push(['via', `from ${escapeHtml(f.oldPath)}`, 'renamed in this range']);
      if (!f.new && !f.reshaped && !f.verbatim && !f.deleted) {
        sig.push(['via', 'no substantive lines', 'blank or punctuation-only edit, or no line diff (mode change)']);
      }
      const on = view.visited.has(f.path);
      const check = `<span class="sb-rv-visit${on ? ' on' : ''}" data-visit="${escapeHtml(f.path)}" ` +
        `title="${on ? 'Visited — click to unmark' : 'Mark visited (V)'}">&#10003;</span>`;
      parts.push(rvRow(f.path, on ? ' visited' : '', sig.map(([k, text, why]) =>
        `<span class="${k}${k === key ? ' on' : ''}" title="${why}">${text}</span>`).join(''), 'path', check));
    }

    // The rest of the inventory: changed paths with no building, grouped by why.
    if (view.offCity.length) {
      parts.push(`<div class="sb-sub">Not in the city · ${fmt(view.offCity.length)}</div>`);
      for (const [why, label] of OFF_CITY_WHY) {
        const rows = view.offCity.filter((o) => o.why === why);
        if (!rows.length) continue;
        parts.push(`<div class="sb-hint">${label} · ${fmt(rows.length)}</div>`);
        for (const o of rows) {
          const from = o.oldPath ? ` · from ${escapeHtml(o.oldPath)}` : '';
          // Binary rows (deleted ones too) have no lines to show; the rest open their range diff when a host can serve it.
          const opens = !o.binary && o.why !== 'binary' && !!view.base && !!view.head && opts.host.available();
          parts.push(rvRow(o.path, ` off ${escapeHtml(o.status)}`, `<span class="via">${escapeHtml(o.status)}${from}</span>`,
            opens ? 'off' : null));
        }
      }
    }

    const hop1 = view.consumers.filter((c) => c.hop === 1);
    const hop2 = view.consumers.filter((c) => c.hop === 2);
    parts.push(
      `<div class="sb-sub">Untouched importers · ${fmt(hop1.length)}</div>`,
      `<div class="sb-hint">${hop1.length ? 'static imports only' : 'No static importer outside the diff'}</div>`
    );
    const row = (c: ReviewConsumer): string => {
      const more = c.via.length > 1 ? ` +${c.via.length - 1}` : '';
      return rvRow(c.path, ' consumer',
        `<span class="via" title="${escapeHtml(c.via.join(', '))}">` +
        `${c.hop === 1 ? 'imports' : 'via'} ${escapeHtml(baseName(c.via[0] ?? ''))}${more}</span>`);
    };
    for (const c of hop1) parts.push(row(c));
    if (hop2.length) {
      parts.push(
        `<div class="sb-more">${state.reviewHop2 ? '− hide' : '+ show'} 2nd hop · ` +
        `${fmt(hop2.length)}${view.hop2Capped ? '+' : ''}</div>`
      );
      if (state.reviewHop2) for (const c of hop2) parts.push(row(c));
    }
    secReview.innerHTML = parts.join('');
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
          `<span class="dir">${escapeHtml(dirName(c.path))}${lineBalance(c)}</span></div>`
        );
      }
      if (rows.length > 60) parts.push(`<div class="sb-hint">+${rows.length - 60} more</div>`);
    }
    secWork.innerHTML = head + parts.join('');
  }

  /** ` +12 −3`, or nothing when the numbers are absent or both zero. */
  function lineBalance(c: WorkChange): string {
    const added = Number(c.added) || 0;
    const removed = Number(c.removed) || 0;
    if (!added && !removed) return '';
    const parts = [];
    if (added) parts.push('+' + added);
    if (removed) parts.push('\u2212' + removed);
    return ' \u00b7 ' + parts.join(' ');
  }

  // A module's commits are the ones that touched its lines (`git log -L`),
  // fetched once per span and remembered across hovers and selections.
  function spanKey(d: Descriptor): string | null {
    const s = d.logSpan;
    return s && d.codePath && opts.host.available() ? `${d.codePath}:${s.start}-${s.end}` : null;
  }
  function loadSpanCommits(d: Descriptor): void {
    const key = spanKey(d);
    const span = d.logSpan;
    if (!key || !span || !d.codePath || spanLogs.has(key)) return;
    opts.host.getLog(d.codePath, span.start, span.end).then((json) => {
      spanLogs.set(key, {
        commits: json && Array.isArray(json.commits) ? json.commits : [],
        scoped: !!json?.scoped,
      });
      if (state.selected === d) {
        renderSelected();
        void loadLatestDiff(d, state.codeToken); // the source pane already stands
      }
    });
  }

  function commitsFor(d: Descriptor): LogCommit[] {
    const codePath = d.codePath;
    if (!codePath) return [];
    const key = spanKey(d);
    if (key) return spanLogs.get(key)?.commits ?? [];
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
    if ((tl && tl.enabled) || d.logSpan || !d.codePath || d.logCommits || !opts.host.available()) return;
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
    // A changed file opens on its changes; the source window is one click away (`source ▸`).
    // A reveal aimed at a line (search hit) opens on that line instead, changes below.
    if (d.rangeDiff && !d.sourceFirst) {
      secCode.innerHTML = `<div class="h"><span>Changes</span><em>${escapeHtml(baseName(codePath))} ` +
        `<span class="sb-src-btn" data-src="1">source ▸</span></em></div>`;
      await loadRangeDiff(d.rangeDiff, codePath, token);
      return;
    }
    secCode.innerHTML = `<div class="h"><span>Code</span><em>loading…</em></div>`;
    await loadSource(d, codePath, token);
    if (d.rangeDiff) await loadRangeDiff(d.rangeDiff, codePath, token);
    else await loadLatestDiff(d, token);
  }

  /** The reading window around the selection: a module's span, or a file's first 160 lines. */
  async function loadSource(d: Descriptor, codePath: string, token: number): Promise<void> {
    const start = d.span ? d.span.start : 1;
    const end = d.span ? d.span.end : start + 160;
    const src = await opts.host.getSource(codePath, start, end);
    if (token !== state.codeToken) return;
    const kind = src ? contentKind(src) : null;
    if (!src || !kind) {
      if (!d.rangeDiff) secCode.style.display = 'none';
      return;
    }

    const head =
      `<div class="h"><span>Code</span><em>${escapeHtml(baseName(codePath))} ` +
      `${Number(src.start) || start}–${Number(src.end) || end}</em></div>`;
    // Asked for from the Changes pane: the source goes right under its header, above the hunks.
    if (d.rangeDiff && !d.sourceFirst) secCode.querySelector('.h')?.insertAdjacentHTML('afterend', head + CONTENT_RENDERERS[kind](src, Number(src.start) || start));
    else secCode.innerHTML = head + CONTENT_RENDERERS[kind](src, Number(src.start) || start);
  }

  /** A changed path with no building: its range diff alone fills the code pane. */
  async function loadOffCityDiff(view: ReviewView, path: string): Promise<void> {
    const token = ++state.codeToken;
    state.offSel = path;
    renderReview();
    secCode.style.display = '';
    secCode.innerHTML = `<div class="h"><span>Diff</span><em>${escapeHtml(baseName(path))}</em></div>` +
      `<div class="sb-sub">${escapeHtml(path)}</div>`;
    await loadRangeDiff({ base: view.base, head: view.head }, path, token);
  }

  /** Appends the analyzed range's diff of this file — only a module's own hunks when it is one. */
  async function loadRangeDiff(range: RangeDiff, codePath: string, token: number): Promise<void> {
    const s = range.lines;
    // null lines: every line of the module is uncommitted, so no hunk can touch it — nothing to fetch.
    const res = s === null ? { diff: '' }
      : await opts.host.getRangeDiff(codePath, range.base, range.head, s?.start, s?.end);
    if (token !== state.codeToken || !res) return;
    const label = `Diff · ${escapeHtml(range.base.slice(0, 7))}&rarr;${escapeHtml(range.head.slice(0, 7))}${s !== undefined ? ' · these lines' : ''}`;
    secCode.insertAdjacentHTML(
      'beforeend',
      `<div class="sb-sub sb-diff-head">${label}</div>` +
      (res.diff ? hunksHtml(res.diff, res.truncated, range.outline ?? []) : `<div class="sb-hint">No hunk of the diff touches these lines</div>`)
    );
  }

  /** Appends the newest commit's diff under the source pane — the tail of loadCode. */
  async function loadLatestDiff(d: Descriptor, token: number): Promise<void> {
    if (d.rangeDiff) return; // the span-log callback lands here too; the range diff owns the pane
    const codePath = d.codePath;
    const latest = codePath ? latestHashFor(d) : null;
    // Both loadCode and the span-log callback can reach here; append once.
    // A non-hash event id (`edit-3`, `CHG-36`) has no commit diff to ask for.
    if (!codePath || !latest || !isCommitHash(latest) || token !== state.codeToken || secCode.querySelector('.sb-diff-head')) return;
    const diff = await opts.host.getDiff(codePath, latest);
    if (token !== state.codeToken || !diff || !diff.diff || secCode.querySelector('.sb-diff-head')) return;
    secCode.insertAdjacentHTML(
      'beforeend',
      `<div class="sb-sub sb-diff-head">Latest diff · ${escapeHtml(latest.slice(0, 7))}</div>` + diffHtml(diff.diff, diff.truncated)
    );
  }

  function latestHashFor(d: Descriptor): string | null {
    const codePath = d.codePath;
    const key = spanKey(d);
    if (key) return spanLogs.get(key)?.commits[0]?.h ?? null;
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

/** One renderer per detail kind. Markdown renders as its lines for now: same pane, no visible change. */
const CONTENT_RENDERERS: Record<ContentKind, (src: SourceResponse, start: number) => string> = {
  code: sourceHtml,
  markdown: sourceHtml,
};

/** The kind a detail renders as, or null for one this viewer has no renderer for (-> header card). */
export function contentKind(src: SourceResponse): ContentKind | null {
  const kind = src.kind ?? 'code'; // absent: a dev API older than typed content
  return kind === 'code' || kind === 'markdown' ? kind : null;
}

function sourceHtml(src: SourceResponse, start: number): string {
  const lines = Array.isArray(src.lines) ? src.lines.slice(0, 400) : [];
  if (!lines.length) return `<div class="sb-hint">empty</div>`;
  const out = lines.map((line, i) =>
    `<span class="ln">${String(start + i).padStart(4, ' ')}</span> ${escapeHtml(String(line))}`
  );
  return `<div class="sb-code">${out.join('\n')}</div>`;
}

/** Context lines kept either side of a change while a hunk card is closed. */
const HUNK_NEAR = 1;

/**
 * A range diff as one card per hunk, headed by the innermost module around its
 * first change (git's own `@@ … @@` context when none) with head line numbers.
 * Closed, a card shows only changed lines and HUNK_NEAR either side; git's file
 * header lines are dropped. A diff with no hunk (binary, mode-only) falls back raw.
 */
function hunksHtml(text: string, truncated: number | undefined, outline: OutlineEntry[]): string {
  const all = String(text).split('\n');
  const hunks: Array<{ at: number; ctx: string; lines: string[] }> = [];
  for (const line of all.slice(0, 400)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (m) hunks.push({ at: Number(m[1]), ctx: m[2] ?? '', lines: [] });
    else if (line && !line.startsWith('\\')) hunks[hunks.length - 1]?.lines.push(line);
  }
  if (!hunks.length) return diffHtml(text, truncated);
  // The 400-line cut can leave a last hunk of context only; it has nothing to show.
  const cards = hunks.filter((h) => h.lines.some((l) => l[0] === '+' || l[0] === '-')).map((h) => {
    let n = h.at;
    const rows = h.lines.map((line) => {
      const c = line[0];
      // A deleted row has no head line; it anchors where it was cut (≥ 1: a cut at the top of the file).
      const at = c === '-' ? Math.max(n, 1) : n++;
      return { c, num: c === '-' ? null : at, at, text: line.slice(1) };
    });
    const changed = rows.map((r, i) => (r.c === '+' || r.c === '-' ? i : -1)).filter((i) => i >= 0);
    const near = (i: number): boolean => changed.some((j) => Math.abs(i - j) <= HUNK_NEAR);
    const nums = rows.filter((r) => r.c !== ' ').map((r) => r.at);
    const first = nums[0] ?? h.at;
    const last = nums[nums.length - 1] ?? first;
    // Owner: the innermost module holding every change (a method, not its class). A hunk across
    // several modules names the first outermost one it touches, `+N more` for the rest.
    const size = (o: OutlineEntry): number => o.end - o.start;
    const holds = outline.filter((o) => o.start <= first && o.end >= last).sort((a, b) => size(a) - size(b));
    const touched = outline.filter((o) => nums.some((x) => o.start <= x && o.end >= x));
    const outer = touched.filter((o) => !touched.some((p) => p !== o && p.start <= o.start && p.end >= o.end && size(p) > size(o)))
      .sort((a, b) => a.start - b.start);
    const owner = holds[0] ?? outer[0];
    const more = holds[0] ? 0 : Math.max(outer.length - 1, 0);
    const adds = rows.filter((r) => r.c === '+').length;
    const dels = rows.filter((r) => r.c === '-').length;
    const label = owner
      ? `<span class="k">${escapeHtml(owner.kind)}</span><span class="nm">${escapeHtml(owner.name)}</span>` +
        (more ? `<span class="k">+${fmt(more)} more</span>` : '')
      : `<span class="nm">${escapeHtml(h.ctx.trim() || 'top of file')}</span>`;
    const body: string[] = [];
    let gap = 0;
    const flushGap = (): void => {
      if (gap) body.push(`<div class="r gap">⋯ ${fmt(gap)} line${gap === 1 ? '' : 's'}</div>`);
      gap = 0;
    };
    rows.forEach((r, i) => {
      const far = r.c === ' ' && !near(i);
      if (far) gap++; else flushGap();
      const cls = r.c === '+' ? 'add' : r.c === '-' ? 'del' : far ? 'far' : '';
      body.push(`<div class="r ${cls}"><span class="g">${r.num ?? ''}</span>${escapeHtml(r.c === ' ' ? r.text : r.c + r.text)}</div>`);
    });
    flushGap();
    return `<div class="sb-hunk"><div class="sb-hunk-h" title="Show surrounding context">${label}` +
      `<span class="at">L${fmt(first)}${last !== first ? `–${fmt(last)}` : ''}</span>` +
      `<span class="add">+${fmt(adds)}</span><span class="del">−${fmt(dels)}</span></div>` +
      `<div class="sb-code">${body.join('')}</div></div>`;
  });
  return cutNote(Math.min(all.length, 400), Math.max(truncated ?? 0, all.length)) +
    `<div class="sb-hint sb-hunk-n">${fmt(cards.length)} change${cards.length === 1 ? '' : 's'} · click a header for context</div>` +
    cards.join('');
}

/** "400 of 601 lines shown · rest truncated" when the diff was cut; '' otherwise. */
function cutNote(shown: number, total: number): string {
  return total > shown
    ? `<div class="sb-hint sb-diff-cut">${fmt(shown)} of ${fmt(total)} lines shown · rest truncated</div>` : '';
}

function diffHtml(text: string, truncated?: number): string {
  const all = String(text).split('\n');
  const lines = all.slice(0, 400);
  const out = lines.map((line) => {
    const cls =
      line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')
        ? 'meta'
        : line.startsWith('+') ? 'add'
        : line.startsWith('-') ? 'del'
        : '';
    return cls ? `<span class="${cls}">${escapeHtml(line)}</span>` : escapeHtml(line);
  });
  // Provider cap or this one: say so up front rather than end mid-hunk. e.g. "400 of 601 lines shown".
  return `${cutNote(lines.length, Math.max(truncated ?? 0, all.length))}<div class="sb-code">${out.join('\n')}</div>`;
}

/**
 * One tour artifact. `src`/`href` were scheme-validated by the SDK's
 * `validateTour`; escaping here closes the attribute-injection half.
 */
function artifactHtml(a: TourArtifactView): string {
  if (a.type === 'diff') {
    return (
      `<div class="sb-sub">Diff · ${escapeHtml(a.label)}</div>` +
      (a.diff?.diff ? diffHtml(a.diff.diff, a.diff.truncated) : `<div class="sb-hint">diff unavailable</div>`)
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
