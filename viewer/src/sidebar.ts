/**
 * sidebar.ts — the persistent right inspector panel.
 *
 * Three stacked sections: INSPECT (live hover), SELECTED (pinned click, with
 * PRs + commits) and CODE (source span + latest diff from the host).
 * Everything data-derived is escaped before it reaches innerHTML.
 */
import type { CityHost } from '../../shared/host.js';
import type { LogCommit, Pr, SourceResponse } from '../../shared/types.js';
import { relTime, type Timeline } from './timeline.js';

const MAX_COMMITS = 8;

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
}

export function createSidebar(
  opts: { host: CityHost; timeline: Timeline | null; githubUrl?: string | null; onWidthChange?: (wide: boolean) => void }
): Sidebar {
  const root = requireEl('sidebar');
  const body = requireEl('sb-body');
  const widthBtn = requireEl('sb-width');

  const secInspect = section('inspect');
  const secSelected = section('selected');
  const secCode = section('code');
  body.append(secInspect, secSelected, secCode);

  const state: {
    hover: Descriptor | null;
    selected: Descriptor | null;
    manualWide: boolean | null;
    wide: boolean;
    codeToken: number;
    cursor: number | null;
  } = {
    hover: null,
    selected: null,
    /** null = follow auto-expand, true/false = manual override. */
    manualWide: null,
    wide: false,
    codeToken: 0,
    cursor: null,
  };

  widthBtn.addEventListener('click', () => {
    state.manualWide = !state.wide;
    applyWidth();
  });

  renderInspect();
  renderSelected();
  secCode.style.display = 'none';

  return {
    setHover(desc) {
      state.hover = desc;
      renderInspect();
    },
    setSelection(desc) {
      state.selected = desc;
      renderSelected();
      loadCode(desc);
      applyWidth();
    },
    setCursor(t) {
      state.cursor = t;
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

  function renderSelected(): void {
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
      `<div class="sb-grid">${grid}</div>` +
      coupling
    );
  }

  function prsHtml(prs: Pr[]): string {
    if (!prs.length) return '';
    const rows = prs.slice(0, 6).map((pr) => {
      const stats =
        Number.isFinite(pr.additions) || Number.isFinite(pr.deletions)
          ? ` <span class="add">+${fmt(pr.additions || 0)}</span> <span class="del">&minus;${fmt(pr.deletions || 0)}</span>`
          : '';
      const age = prAge(pr);
      return (
        `<div class="sb-pr"><span class="num">#${Number(pr.number) || 0}</span> ` +
        `${escapeHtml(pr.title || '')}${pr.isDraft ? ' <span class="draft">DRAFT</span>' : ''}<br>` +
        `<span class="who">@${escapeHtml(pr.author || '?')}</span>${stats}` +
        (age ? ` <span class="age">· updated ${escapeHtml(age)}</span>` : '') +
        `</div>`
      );
    });
    const more = prs.length > 6 ? `<div class="sb-pr who">+${prs.length - 6} more</div>` : '';
    return `<div class="sb-sub">${prs.length} open PR${prs.length > 1 ? 's' : ''}</div>` + rows.join('') + more;
  }

  function commitsHtml(d: Descriptor): string {
    const list = commitsFor(d);
    if (!list.length) return '';
    const t = state.cursor;
    const title = t === null ? 'Recent commits' : 'Commits near cursor';
    const rows = list.slice(0, MAX_COMMITS).map((c) => {
      const near = t !== null && Math.abs(c.ts - t) < 2 * 86400;
      const when = t === null ? relTime(c.ts) : new Date(c.ts * 1000).toISOString().slice(0, 10);
      const shortHash = String(c.h || '').slice(0, 7).replace(/[^0-9a-f]/gi, '');
      const github = opts.githubUrl;
      const hashHtml = github && /^https:\/\/github\.com\//.test(github)
        ? `<a class="h" href="${github}/commit/${shortHash}" target="_blank" rel="noopener noreferrer">${shortHash}</a>`
        : `<span class="h">${shortHash}</span>`;
      return (
        `<div class="sb-commit${near ? ' near' : ''}">` +
        `${hashHtml} ` +
        `<span class="when">${escapeHtml(when)}</span> · ${escapeHtml(truncate(c.s || '', 96))} ` +
        `<span class="who">${escapeHtml(c.a || '')}</span></div>`
      );
    });
    return `<div class="sb-sub">${title}</div>` + rows.join('');
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

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}
