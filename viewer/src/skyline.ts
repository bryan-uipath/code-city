/**
 * skyline.ts — the city as a 2D elevation.
 *
 * The same thing the strata stacks are, with one spatial axis removed: every
 * bar is a node, laid out left to right in tree order, its width its size and
 * its height its commit history. Tree order is what makes it a *skyline* and
 * not a bar chart — folders stay contiguous runs, so `viewer/src` is still one
 * place you can point at, and the bracket under the run names it.
 *
 * It is deliberately a second RENDERER over the first model, not a second
 * model. Levels come from `walkStack` and colors from whatever `StrataPaint`
 * the 3D city is wearing at that moment, so the overlays, the timeline range,
 * the legend filter and the search highlight all arrive here for free — and the
 * two views cannot drift apart, because there is only one answer to draw.
 *
 * Geometry and color stay split exactly as they are in `strata.ts`: `update()`
 * walks the levels, `repaint()` resolves their fills, `draw()` blits. A range
 * drag refills; a mode switch only repaints.
 */
import * as THREE from 'three';
import { KIND_COLORS, PALETTE } from './city.js';
import { buildingHeight } from './layout.js';
import {
  resolveRange, walkStack,
  type LevelFilter, type StackLevel, type StrataCommit, type StrataIndex,
  type StrataPaint, type StrataRecord,
} from './strata.js';
import type { VNode } from './vtree.js';

/**
 * The plot lives in the free strip the HUD leaves behind, measured off the
 * panels themselves — the same accommodation `framingFor` makes for the camera,
 * for the same reason: a row drawn under the control stack is a row you cannot
 * read. `bottom` also holds the bracket strip, `top` the hover pill.
 */
interface Pad { left: number; right: number; top: number; bottom: number }
const PAD_MIN: Pad = { left: 26, right: 26, top: 34, bottom: 58 };
/** Breathing room between a HUD panel's edge and the plot. */
const PAD_GAP = 18;
/** How often the HUD is re-measured while drawing, in ms. */
const PAD_INTERVAL = 200;
/** Height of the strip under the baseline: bracket names, then the scale note. */
const BRACKET_STRIP = 42;
/** A bar narrower than this cannot be seen, let alone clicked. */
const MIN_BAR_PX = 3;
const BAR_GAP = 2;
/**
 * The row fills its band — the 2D analogue of the camera framing a scope, since
 * there is no camera here to do it. The cap only stops a two-commit scope from
 * turning two commits into two enormous slabs.
 */
const MAX_LEVEL_PX = 40;
/** The share of a level its slab fills — the gap is what makes strata legible. */
const SLAB_FILL = 0.72;
/** A bar with no commit in range: a plinth, so the node still reads. */
const STUB_PX = 3;
/** Below this a bracket has no room for its name. */
const MIN_BRACKET_PX = 46;
/**
 * Slabs per bar at most. The row's tallest stack lands exactly on this and
 * everything else folds by the SAME stride, so heights stay comparable — a
 * per-bar budget would flatten every big stack onto one ceiling and quietly
 * tell you a district and a hot file were the same size.
 */
const LEVEL_BUDGET = 120;
/** Sanity bound on how much history one bar will walk. */
const MAX_WALK = 6000;
/** Guard on the cut search; no real tree is this deep. */
const MAX_CUT_DEPTH = 32;
/** Horizon rules every N levels, for depth. */
const GRID_EVERY = 10;

const FONT_BRACKET = '10px "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace';
const FONT_PILL = '11px "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace';

/** One level of one bar. `fill` is resolved by `repaint`, consumed by `draw`. */
export interface SkyLevel {
  /** The record the paints see — the very shape the 3D slabs use. */
  record: StrataRecord;
  ratio: number;
  age: number;
  /** True for the plinth of a node with no commit in range. */
  stub: boolean;
  /** Commits folded into this level. 1 unless the row is striding. */
  group: number;
  fill: string;
}

/** One node standing in the row. */
export interface SkyBar {
  node: VNode;
  /** The folder run this bar sits in, or null when it would name the scope. */
  bracket: VNode | null;
  /** Content-space geometry, before scroll. */
  x: number;
  w: number;
  levels: SkyLevel[];
  /**
   * Height in abstract units — levels where the city is stacked, log-scaled LOC
   * where it is not. Normalized against the tallest bar at draw time, so the
   * skyline always fills its band.
   */
  mass: number;
  /** Module massing (no commit stacks in this scope): the bar is one solid. */
  solidFill: string | null;
}

/** What the row is currently made of — the skyline's answer to the LEVELS stat. */
export interface SkylineStats {
  /** True when the bars are commit stacks rather than module massing. */
  stacked: boolean;
  /** Levels actually drawn, plinths excluded — folded, so this is the row's own count. */
  levels: number;
  bars: number;
  /** Commits folded into one level. 1 = one level, one commit. */
  stride: number;
}

export interface SkyHit {
  bar: SkyBar;
  /** The level under the pointer, or null when the pointer is off the stack. */
  level: SkyLevel | null;
}

export interface SkylineOptions {
  container: HTMLElement;
  /** The repo-relative path whose history a node stands for. */
  realPath(node: VNode): string | null;
  onHover(hit: SkyHit | null): void;
  onSelect(hit: SkyHit | null): void;
  onIsolate(node: VNode): void;
}

export interface Skyline {
  readonly canvas: HTMLCanvasElement;
  setVisible(on: boolean): void;
  isVisible(): boolean;
  /**
   * Point the skyline at a scope. `index`/`bounds` are null when the dataset has
   * no commit stream, which drops the row to module massing. Call `update()`
   * after this to fill the bars — the split is the same one `createStrata` has
   * between allocating the stacks and walking a range into them.
   */
  rebuild(root: VNode | null, index: StrataIndex | null, bounds: { min: number; max: number } | null): void;
  /** Refill the levels for a range + filter. The 2D twin of `StrataBuild.update`. */
  update(range: { start: number; cursor: number | null }, keep?: LevelFilter | null): void;
  /** Repaint the existing levels; omit `paint` to reapply the current one. */
  repaint(paint?: StrataPaint): void;
  /**
   * What is standing. `match` is the legend filter's predicate: a folded level
   * counts as matching when the commit REPRESENTING it does, which is the same
   * commit that decides how the level is painted.
   */
  stats(match?: ((commit: StrataCommit) => boolean) | null): SkylineStats;
  /** Redraw if anything has changed since the last frame. */
  draw(): void;
  resize(): void;
  dispose(): void;
}

export function createSkyline(opts: SkylineOptions): Skyline {
  const canvas = document.createElement('canvas');
  canvas.id = 'skyline';
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) throw new Error('skyline: no 2d context');
  const ctx: CanvasRenderingContext2D = ctx2d;
  opts.container.appendChild(canvas);

  let visible = false;
  let bars: SkyBar[] = [];
  let scopeRoot: VNode | null = null;
  let strataIndex: StrataIndex | null = null;
  let streamBounds: { min: number; max: number } | null = null;
  /** The last range/filter, so a repaint or resize can refill without them. */
  let lastRange: { start: number; cursor: number | null } = { start: -Infinity, cursor: null };
  let lastKeep: LevelFilter | null = null;
  let paint: StrataPaint | null = null;
  /** Are we standing on commit stacks, or on module massing? */
  let stacked = false;
  /** Per-node aggregated history, memoized for the life of a scope. */
  const histories = new Map<VNode, StrataCommit[]>();
  /** Commits folded into one level across the whole row. 1 = one level, one commit. */
  let stride = 1;

  let width = 0;
  let height = 0;
  let pad: Pad = { ...PAD_MIN };
  /** Last HUD measurement, throttled — see `draw`. */
  let padAt = -Infinity;
  let contentW = 0;
  let scrollX = 0;
  let dirty = true;

  let hover: SkyHit | null = null;
  let pointerX = 0;
  let pointerY = 0;
  let pointerIn = false;

  const scratch = new THREE.Color();

  // -------------------------------------------------------------------------
  // Model
  // -------------------------------------------------------------------------

  /**
   * One cut across the scope's subtree: every node at `depth` relative to the
   * root, plus any file that bottoms out above it. Tree order throughout, which
   * is what keeps the runs contiguous.
   */
  function cutAt(root: VNode, depth: number): VNode[] {
    const out: VNode[] = [];
    (function walk(node: VNode, d: number): void {
      if (node !== root && (node.type === 'file' || d >= depth)) { out.push(node); return; }
      for (const child of node.children ?? []) walk(child, d + 1);
    })(root, 0);
    return out;
  }

  /**
   * The bars: the DEEPEST cut that still fits.
   *
   * A repo of 3700 files across an 1100px strip is a third of a pixel a file,
   * so the row aggregates until every bar is wide enough to see and to click —
   * districts at repo scope, folders inside those, files once you have drilled
   * in far enough. Drill-down is therefore the level-of-detail control, and it
   * is the one the user already has in their hands.
   *
   * Walked here rather than taken from the 3D layout's file list, which drops
   * anything too small to have earned a plate: a three-pixel bar still says
   * something, a missing bar says the wrong thing.
   */
  function chooseCut(root: VNode, availW: number): VNode[] {
    const fits = (n: number): boolean => n * MIN_BAR_PX + Math.max(n - 1, 0) * BAR_GAP <= availW;
    let best = cutAt(root, 1);
    for (let depth = 2; depth <= MAX_CUT_DEPTH; depth++) {
      const cut = cutAt(root, depth);
      if (cut.length === best.length) break; // converged — nothing deeper to split
      if (!fits(cut.length)) break;
      best = cut;
    }
    return best;
  }

  /**
   * A folder has no history of its own, so it borrows its subtree's: the union
   * of its files' commits, deduped by hash, with the deltas summed over only the
   * files that live under it. That is exactly the definition `churn` already
   * uses, so the number in the bar matches the number in the inspector.
   */
  function historyOf(node: VNode, index: StrataIndex): StrataCommit[] {
    const cached = histories.get(node);
    if (cached) return cached;

    let out: StrataCommit[];
    if (node.type === 'file') {
      const path = opts.realPath(node);
      out = (path ? index.get(path) : null) ?? [];
    } else {
      const byHash = new Map<string, StrataCommit>();
      (function walk(n: VNode): void {
        if (n.type === 'file') {
          const path = opts.realPath(n);
          for (const c of (path ? index.get(path) : null) ?? []) {
            const seen = byHash.get(c.h);
            if (seen) { seen.adds += c.adds; seen.dels += c.dels; }
            else byHash.set(c.h, { ...c });
          }
          return;
        }
        for (const child of n.children ?? []) walk(child);
      })(node);
      out = [...byHash.values()].sort((a, b) => b.ts - a.ts); // newest first
    }
    histories.set(node, out);
    return out;
  }

  /** The run a bar belongs to: its folder, unless that folder is the scope. */
  function bracketOf(node: VNode, root: VNode): VNode | null {
    const parent = node.parent ?? null;
    if (!parent || parent === root) return null;
    return parent;
  }

  function rebuild(
    root: VNode | null,
    index: StrataIndex | null,
    bounds: { min: number; max: number } | null
  ): void {
    scopeRoot = root;
    strataIndex = index;
    streamBounds = bounds;
    // The stacks stand wherever files are the unit of rendering — the same rule
    // `strataActive()` applies in 3D, so the two views agree about what a bar is.
    stacked = !!index && !!bounds && !!root && !root.synth;
    histories.clear();
    bars = root
      ? chooseCut(root, Math.max(width - pad.left - pad.right, 1)).map((node) => ({
          node,
          bracket: bracketOf(node, root),
          x: 0,
          w: 0,
          levels: [],
          mass: 1,
          solidFill: null,
        }))
      : [];
    hover = null;
    scrollX = 0;
  }

  function update(range: { start: number; cursor: number | null }, keep?: LevelFilter | null): void {
    lastRange = range;
    lastKeep = keep ?? null;
    const index = strataIndex;
    const bounds = streamBounds;

    if (!stacked || !index || !bounds) {
      // No stacks here (a file isolate, or a dataset with no commit stream): the
      // bar falls back to module massing, exactly as the buildings do.
      for (const bar of bars) {
        bar.levels = [];
        bar.mass = buildingHeight(bar.node.loc);
      }
      layout();
      repaint();
      return;
    }

    // Two passes: walk every bar's full history first, because the fold stride
    // is a property of the ROW (the tallest stack sets it) and not of any one bar.
    const resolved = resolveRange(range, bounds);
    const walked: StackLevel[][] = [];
    let tallest = 0;
    for (const bar of bars) {
      const raw = walkStack(historyOf(bar.node, index), bar.node.loc, resolved, lastKeep, MAX_WALK);
      walked.push(raw);
      tallest = Math.max(tallest, raw.length);
    }
    stride = Math.max(1, Math.ceil(tallest / LEVEL_BUDGET));

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const raw = walked[i];
      if (!bar || !raw) continue;
      bar.levels = fold(raw, bar.node, stride);
      if (!bar.levels.length) {
        // Untouched inside the range — one plinth, the 2D twin of the 3D stub.
        bar.levels.push({
          record: { file: bar.node, commit: null, level: 0 },
          ratio: 1,
          age: 0,
          stub: true,
          group: 0,
          fill: '#000',
        });
      }
      bar.mass = bar.levels[0]?.stub ? 0 : bar.levels.length;
    }
    layout();
    repaint();
  }

  /**
   * Fold a walked stack by the row's stride.
   *
   * A folded level stands for `stride` consecutive commits and takes the type
   * that most of them were, represented by a real commit of that type so the
   * inspector and the legend filter still have something true to point at. The
   * footprint is the group's newest member's, which is the one its base sits on.
   * At stride 1 this is the identity, which is the case a file scope is always in.
   */
  function fold(raw: StackLevel[], node: VNode, by: number): SkyLevel[] {
    const out: SkyLevel[] = [];
    for (let i = 0; i < raw.length; i += by) {
      const head = raw[i];
      if (!head) break;
      const end = Math.min(i + by, raw.length);
      let commit = head.commit;
      if (by > 1) {
        const tally = new Map<string, number>();
        for (let j = i; j < end; j++) {
          const c = raw[j]?.commit;
          if (!c) continue;
          const key = c.type ?? (c.fix ? 'fix' : '');
          tally.set(key, (tally.get(key) ?? 0) + 1);
        }
        let bestKey = '';
        let bestN = -1;
        for (const [key, n] of tally) if (n > bestN) { bestN = n; bestKey = key; }
        for (let j = i; j < end; j++) {
          const c = raw[j]?.commit;
          if (c && (c.type ?? (c.fix ? 'fix' : '')) === bestKey) { commit = c; break; }
        }
      }
      out.push({
        record: { file: node, commit, level: out.length },
        ratio: head.ratio,
        age: head.age,
        stub: false,
        group: end - i,
        fill: '#000',
      });
    }
    return out;
  }

  function repaint(next?: StrataPaint): void {
    if (next) paint = next;
    const active = paint;
    for (const bar of bars) {
      if (!bar.levels.length) {
        const kind = bar.node.mod?.kind;
        bar.solidFill = css(kind ? KIND_COLORS[kind] ?? PALETTE.cyan : PALETTE.filePlate);
        continue;
      }
      bar.solidFill = null;
      for (const level of bar.levels) {
        level.fill = active
          ? active(level.record, level.age, scratch).getStyle()
          : css(PALETTE.cyan);
      }
    }
    dirty = true;
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  /**
   * The free strip, measured off the HUD. The sidebar widens on its own (a file
   * selection expands it), so this is re-read every redraw rather than only on
   * resize; five rects on a DOM that is not moving costs nothing.
   */
  function measurePad(): Pad {
    const box = (id: string): DOMRect | null =>
      document.getElementById(id)?.getBoundingClientRect() ?? null;
    const controls = box('controls');
    const help = box('help');
    const side = box('sidebar');
    const time = box('timeline');
    const top = box('topbar');

    const next: Pad = {
      left: Math.max(controls?.right ?? 0, help?.right ?? 0) + PAD_GAP,
      right: width - (side?.left ?? width) + PAD_GAP,
      top: (top?.bottom ?? 0) + PAD_GAP,
      bottom: height - (time?.top ?? height) + PAD_GAP + BRACKET_STRIP,
    };
    // Never let the chrome eat the plot: fall back to the bare minimum if the
    // panels claim more than the window can spare.
    if (next.left + next.right > width * 0.8) { next.left = PAD_MIN.left; next.right = PAD_MIN.right; }
    if (next.top + next.bottom > height * 0.85) { next.top = PAD_MIN.top; next.bottom = PAD_MIN.bottom; }
    return {
      left: Math.max(next.left, PAD_MIN.left),
      right: Math.max(next.right, PAD_MIN.right),
      top: Math.max(next.top, PAD_MIN.top),
      bottom: Math.max(next.bottom, PAD_MIN.bottom),
    };
  }

  function samePad(a: Pad, b: Pad): boolean {
    return a.left === b.left && a.right === b.right && a.top === b.top && a.bottom === b.bottom;
  }

  /**
   * Widths are proportional to size, floored so nothing vanishes. When the floor
   * pushes the row past the viewport the row keeps its natural length and scrolls
   * — squeezing 400 files into 400 pixels would only produce a picket fence.
   */
  function layout(): void {
    const avail = Math.max(width - pad.left - pad.right, 1);
    if (!bars.length) { contentW = avail; return; }

    let totalLoc = 0;
    for (const bar of bars) totalLoc += Math.max(bar.node.loc, 1);
    const gaps = BAR_GAP * (bars.length - 1);
    const share = Math.max(avail - gaps, 1);

    let sum = 0;
    for (const bar of bars) {
      bar.w = Math.max(MIN_BAR_PX, (Math.max(bar.node.loc, 1) / totalLoc) * share);
      sum += bar.w;
    }
    // Under the floor the widths no longer add up; rescale the ones with slack
    // so the row still ends where it should, and only overflow if it cannot.
    if (sum > share) {
      let slack = 0;
      for (const bar of bars) slack += Math.max(bar.w - MIN_BAR_PX, 0);
      const over = sum - share;
      if (slack > over) {
        const k = (slack - over) / slack;
        sum = 0;
        for (const bar of bars) {
          bar.w = MIN_BAR_PX + Math.max(bar.w - MIN_BAR_PX, 0) * k;
          sum += bar.w;
        }
      }
    }

    let x = 0;
    for (const bar of bars) {
      bar.x = x;
      x += bar.w + BAR_GAP;
    }
    contentW = Math.max(x - BAR_GAP, avail);
    scrollX = clamp(scrollX, 0, Math.max(contentW - avail, 0));
  }

  function plotHeight(): number {
    return Math.max(height - pad.top - pad.bottom, 1);
  }

  function maxMass(): number {
    let max = 1;
    for (const bar of bars) max = Math.max(max, bar.mass);
    return max;
  }

  /** World-to-screen for the stack: how many pixels one level gets. */
  function levelPx(): number {
    return Math.min(MAX_LEVEL_PX, plotHeight() / maxMass());
  }

  /**
   * Pixels per unit of mass. Stacked, that is a level and it is capped so a
   * short history does not produce absurd slabs; unstacked it is pure LOC and
   * the tallest building simply fills the band.
   */
  function massUnit(): number {
    return stacked ? levelPx() : plotHeight() / maxMass();
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  function draw(): void {
    if (!visible) return;
    // Re-measuring the HUD is five getBoundingClientRect calls, each a forced
    // layout, and the sidebar it is watching only moves on a CSS transition.
    // Same cadence terrace.ts re-seats its signs on, for the same reason.
    const now = performance.now();
    if (now - padAt > PAD_INTERVAL) {
      padAt = now;
      const next = measurePad();
      if (!samePad(next, pad)) { pad = next; layout(); dirty = true; }
    }
    if (!dirty) return;
    dirty = false;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = css(PALETTE.bg);
    ctx.fillRect(0, 0, width, height);

    const baseY = height - pad.bottom;
    const lp = levelPx();
    const unit = massUnit();

    drawGrid(baseY, lp);

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, 0, Math.max(width - pad.left - pad.right, 1), baseY);
    ctx.clip();
    ctx.translate(pad.left - scrollX, 0);
    for (const bar of bars) {
      if (bar.x - scrollX > width || bar.x + bar.w - scrollX < 0) continue; // offscreen
      drawBar(bar, baseY, unit);
    }
    ctx.restore();

    drawBaseline(baseY);
    drawBrackets(baseY);
    drawScaleNote(baseY);
    if (hover && pointerIn) drawHoverPill(baseY, unit);
  }

  function drawBar(bar: SkyBar, baseY: number, unit: number): void {
    if (!bar.levels.length) {
      const h = Math.max(bar.mass * unit, 1);
      ctx.fillStyle = bar.solidFill ?? css(PALETTE.cyan);
      ctx.fillRect(bar.x, baseY - h, bar.w, h);
      return;
    }
    for (const level of bar.levels) {
      const h = level.stub ? STUB_PX : unit * SLAB_FILL;
      const y = baseY - (level.stub ? STUB_PX : level.record.level * unit + h);
      // ratio is an area, so the side scales by its square root — the same
      // relationship the 3D slab has to its plate.
      const w = Math.max(bar.w * Math.sqrt(level.ratio), 1);
      ctx.fillStyle = level.fill;
      ctx.fillRect(bar.x + (bar.w - w) / 2, y, w, Math.max(h, 1));
    }
  }

  /** Faint horizon rules every ten levels — depth, and a scale you can count. */
  function drawGrid(baseY: number, lp: number): void {
    if (!stacked || lp <= 0) return;
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.07)';
    ctx.lineWidth = 1;
    for (let level = GRID_EVERY; level * lp < plotHeight(); level += GRID_EVERY) {
      const y = Math.round(baseY - level * lp) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();
    }
  }

  function drawBaseline(baseY: number): void {
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.34)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, Math.round(baseY) + 0.5);
    ctx.lineTo(width - pad.right, Math.round(baseY) + 0.5);
    ctx.stroke();
  }

  /**
   * One bracket per contiguous run of bars sharing a folder. Tree order is what
   * guarantees the runs are contiguous, which is the whole reason the ordering
   * is what it is.
   */
  function drawBrackets(baseY: number): void {
    const y = baseY + 9;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, baseY, Math.max(width - pad.left - pad.right, 1), pad.bottom);
    ctx.clip();
    ctx.translate(pad.left - scrollX, 0);
    ctx.font = FONT_BRACKET;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';

    for (const run of runs()) {
      const w = run.end - run.start;
      if (w < MIN_BRACKET_PX) continue;
      ctx.strokeStyle = 'rgba(161, 161, 170, 0.34)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(run.start, y - 3.5);
      ctx.lineTo(run.start, y + 0.5);
      ctx.lineTo(run.end, y + 0.5);
      ctx.lineTo(run.end, y - 3.5);
      ctx.stroke();
      // Folder names are city signage, and signage is uppercase.
      ctx.fillStyle = 'rgba(161, 161, 170, 0.85)';
      ctx.fillText(ellipsize(ctx, run.node.name.toUpperCase(), w - 6), run.start + w / 2, y + 5);
    }
    ctx.restore();
  }

  /** Contiguous spans of bars that share a bracket. */
  function runs(): Array<{ node: VNode; start: number; end: number }> {
    const out: Array<{ node: VNode; start: number; end: number }> = [];
    let current: { node: VNode; start: number; end: number } | null = null;
    for (const bar of bars) {
      const node = bar.bracket;
      if (!node) { current = null; continue; }
      if (current && current.node === node) current.end = bar.x + bar.w;
      else out.push((current = { node, start: bar.x, end: bar.x + bar.w }));
    }
    return out;
  }

  /**
   * When the row is striding, say so. A level that stands for seventeen commits
   * is still an honest axis, but only if the axis admits it.
   */
  function drawScaleNote(baseY: number): void {
    if (!stacked || stride <= 1) return;
    // Below the bracket names, where nothing else is standing — over the row it
    // would sit on top of exactly the short bars it is explaining.
    ctx.font = FONT_BRACKET;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(113, 113, 122, 0.9)';
    ctx.fillText(`1 LEVEL = ${stride} COMMITS`, pad.left, baseY + 27);
  }

  /** Name and numbers for whatever is under the pointer, pinned above the row. */
  function drawHoverPill(baseY: number, unit: number): void {
    const hit = hover;
    if (!hit) return;
    const node = hit.bar.node;
    const level = hit.level;
    const commit = level?.record.commit;
    const commits = commitCount(hit.bar);
    const tail = commit
      ? level && level.group > 1
        ? `${fmt(level.group)} commits · ${commit.h} · ${commit.s}`
        : `${commit.h} · ${commit.s}`
      : commits
        ? `${fmt(node.loc)} loc · ${fmt(commits)} commits`
        : `${fmt(node.loc)} loc · untouched in range`;
    const head = node.name;

    ctx.font = FONT_PILL;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const text = `${head}  ${tail}`;
    const w = Math.min(ctx.measureText(text).width + 16, width - pad.left - pad.right);
    const x = clamp(pointerX - w / 2, pad.left, width - pad.right - w);
    // Just above the stack it names, never above the plot band — the topbar
    // owns everything higher and would swallow it.
    const y = clamp(baseY - barHeight(hit.bar, unit) - 28, pad.top, baseY - 26);

    ctx.fillStyle = 'rgba(24, 24, 27, 0.94)';
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(Math.round(x) + 0.5, y + 0.5, Math.round(w), 20);
    ctx.fill();
    ctx.stroke();
    const name = ellipsize(ctx, head, w - 12);
    const headW = ctx.measureText(name).width;
    ctx.fillStyle = '#eafcff';
    ctx.fillText(name, x + 8, y + 5);
    ctx.fillStyle = 'rgba(161, 161, 170, 0.9)';
    ctx.fillText(ellipsize(ctx, tail, w - headW - 22), x + 8 + headW + 8, y + 5);

    // And a frame around the bar it belongs to.
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, 0, Math.max(width - pad.left - pad.right, 1), baseY);
    ctx.clip();
    ctx.translate(pad.left - scrollX, 0);
    const h = Math.max(barHeight(hit.bar, unit), 2);
    ctx.strokeStyle = css(PALETTE.orange);
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(hit.bar.x) - 1.5, Math.round(baseY - h) - 1.5, Math.round(hit.bar.w) + 3, Math.round(h) + 3);
    ctx.restore();
  }

  /** True commits behind a bar, folding included. */
  function commitCount(bar: SkyBar): number {
    let n = 0;
    for (const level of bar.levels) n += level.group;
    return n;
  }

  function barHeight(bar: SkyBar, unit: number): number {
    if (!bar.levels.length) return bar.mass * unit;
    if (bar.levels[0]?.stub) return STUB_PX;
    return bar.levels.length * unit;
  }

  // -------------------------------------------------------------------------
  // Hit testing
  // -------------------------------------------------------------------------

  function hitTest(cx: number, cy: number): SkyHit | null {
    const baseY = height - pad.bottom;
    if (cy > baseY + pad.bottom || cy < 0) return null;
    const x = cx - pad.left + scrollX;
    if (x < 0 || x > contentW) return null;

    // Bars are laid out left to right with no overlap, so this is a plain search
    // over a sorted span list.
    let lo = 0;
    let hi = bars.length - 1;
    let found: SkyBar | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const bar = bars[mid];
      if (!bar) break;
      if (x < bar.x) hi = mid - 1;
      else if (x > bar.x + bar.w + BAR_GAP) lo = mid + 1;
      else { found = bar; break; }
    }
    if (!found) return null;

    const unit = massUnit();
    const h = barHeight(found, unit);
    // A generous grab: anywhere in the bar's column below the baseline-anchored
    // top, plus the bracket strip, resolves to the bar.
    if (cy < baseY - h - 4) return null;
    if (!found.levels.length || found.levels[0]?.stub) return { bar: found, level: null };
    const level = Math.floor((baseY - cy) / unit);
    return { bar: found, level: found.levels[level] ?? null };
  }

  function setHover(hit: SkyHit | null): void {
    const same =
      (!hit && !hover) ||
      (!!hit && !!hover && hit.bar === hover.bar && hit.level === hover.level);
    if (same) return;
    hover = hit;
    dirty = true;
    opts.onHover(hit);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  let downAt: { x: number; y: number } | null = null;

  const onPointerMove = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    pointerX = e.clientX - rect.left;
    pointerY = e.clientY - rect.top;
    pointerIn = true;
    setHover(hitTest(pointerX, pointerY));
    canvas.style.cursor = hover ? 'pointer' : 'default';
    dirty = true;
  };

  const onPointerLeave = (): void => {
    pointerIn = false;
    setHover(null);
    dirty = true;
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button === 0) downAt = { x: e.clientX, y: e.clientY };
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (!downAt || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 4) return; // it was a scroll drag
    opts.onSelect(hover);
  };

  const onDblClick = (): void => {
    if (hover) opts.onIsolate(hover.bar.node);
  };

  /** The row scrolls under the wheel when it is longer than the viewport. */
  const onWheel = (e: WheelEvent): void => {
    const avail = Math.max(width - pad.left - pad.right, 1);
    const max = Math.max(contentW - avail, 0);
    if (max <= 0) return;
    e.preventDefault();
    scrollX = clamp(scrollX + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY), 0, max);
    setHover(hitTest(pointerX, pointerY));
    dirty = true;
  };

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = opts.container.clientWidth || window.innerWidth;
    height = opts.container.clientHeight || window.innerHeight;
    canvas.width = Math.max(Math.round(width * dpr), 1);
    canvas.height = Math.max(Math.round(height * dpr), 1);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    pad = measurePad();
    dirty = true;
    // Off stage this stops here. `resize` fires continuously while a window edge
    // is dragged, and re-cutting + re-walking 4k bars on each event is a stutter
    // paid for a row nobody is looking at; `setVisible` runs it on the way back in.
    if (!visible) return;
    // The cut depends on how much room there is, so a resize can change what a
    // bar even is. Re-choose it, then refill.
    if (scopeRoot) {
      rebuild(scopeRoot, strataIndex, streamBounds);
      update(lastRange, lastKeep);
    } else {
      layout();
    }
  }

  resize();

  return {
    canvas,
    setVisible(on: boolean): void {
      visible = on;
      canvas.style.display = on ? 'block' : 'none';
      if (on) { resize(); dirty = true; }
      else setHover(null);
    },
    isVisible: () => visible,
    stats(match?: ((commit: StrataCommit) => boolean) | null): SkylineStats {
      let levels = 0;
      for (const bar of bars) {
        for (const level of bar.levels) {
          if (level.stub) continue;
          const commit = level.record.commit;
          if (match && !(commit && match(commit))) continue;
          levels++;
        }
      }
      return { stacked, levels, bars: bars.length, stride };
    },
    rebuild,
    update,
    repaint,
    draw,
    resize,
    dispose(): void {
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('wheel', onWheel);
      canvas.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function css(hex: number): string {
  return '#' + (hex >>> 0).toString(16).padStart(6, '0');
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function fmt(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(Math.round(n));
}

/**
 * Trim to fit a pixel width in the context's CURRENT font. Measured rather than
 * approximated: the brackets and the hover pill are set at different sizes, so
 * one guessed character width overflows in one of them whichever value it takes.
 * Only ever called from a redraw, which is dirty-gated.
 */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (maxPx <= 0) return '';
  if (ctx.measureText(text).width <= maxPx) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return lo <= 0 ? '' : text.slice(0, lo) + '…';
}
