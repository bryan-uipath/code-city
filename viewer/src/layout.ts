/**
 * layout.ts — squarified treemap + recursive "city" layout.
 *
 * World space convention: the city lies on the XZ plane, Y is up.
 * A rect is { x, z, w, h } with (x, z) the min corner.
 */
import type { Plot, Rect, VNode, VMod } from './vtree.js';

/** Anything the treemap can place: only its relative weight matters. */
export interface Weighted {
  weight: number;
}

/** One placed treemap cell, carrying the index of the item it belongs to. */
export interface Cell extends Rect {
  item: Weighted;
  index: number;
}

// ---------------------------------------------------------------------------
// World scale
// ---------------------------------------------------------------------------

/**
 * The city is laid out in ONE set of units at every drill level: a file's stack
 * reads the same isolated as it does from the org overview, because footprint
 * area per LOC and building height are both absolute (`layoutCity` is handed a
 * `size` proportional to the scope's share of the repo, and the camera moves in
 * instead of the geometry being re-stretched).
 *
 * The one exception is legibility: a scope small enough to be unreadable at its
 * true size is scaled up UNIFORMLY — every world length, footprints and heights
 * alike, multiplied by the same linear factor — so the proportions stay honest
 * even though the absolute size does not. This is that factor, and every world
 * constant in the layout runs through it.
 */
let SCALE = 1;

/** Set the uniform world scale for the layouts and heights built after it. */
export function setWorldScale(scale: number): void {
  SCALE = Math.min(Math.max(Number(scale) || 1, 1), 60);
}

/** The uniform world scale in force — 1 whenever the scope is big enough. */
export function worldScale(): number {
  return SCALE;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Lay out the whole tree in world space.
 * Mutates each node, assigning:
 *   node.rect  = { x, z, w, h }   world-space footprint
 *   node.depth = number           0 for root
 *   node.tier  = number           terrace tier (depth, minus pass-through levels)
 *   node.top   = number           Y of the walkable top surface of its plate
 * File nodes additionally get node.plots = [{ mod, x, z, w, h }].
 *
 * @param root       tree root (folder node)
 * @param opts.size  world extent of the root plate (square), default 900
 * @returns the same root
 */
export function layoutCity(root: VNode, opts: { size?: number } = {}): VNode {
  const size = opts.size ?? 900;
  layoutNode(root, { x: -size / 2, z: -size / 2, w: size, h: size }, 0, 0);
  return root;
}

/** Squarified treemap. */
export function treemap(items: Weighted[], rect: Rect): Cell[] {
  const out: Cell[] = [];
  if (!items || !items.length || rect.w <= 0 || rect.h <= 0) return out;

  const list: Entry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const weight = Math.max(Number(item.weight) || 0, 0);
    list.push({ item, index: i, weight, area: 0 });
  }
  let total = 0;
  for (const e of list) total += e.weight;
  // Degenerate: everything is zero-weight — give each an equal share.
  if (total <= 0) {
    for (const e of list) e.weight = 1;
    total = list.length;
  }
  list.sort((a, b) => b.weight - a.weight);

  const scale = (rect.w * rect.h) / total;
  for (const e of list) e.area = e.weight * scale;

  squarify(list, { ...rect }, out);
  return out;
}

/**
 * Vertical extent of a building for a given LOC count. Absolute in city units:
 * the same module is the same height at every drill level (up to the uniform
 * legibility scale, which stretches footprints by exactly as much).
 */
export function buildingHeight(loc: number): number {
  const h = 2 + 6 * Math.log2(1 + Math.max(loc, 0) / 10);
  return Math.min(Math.max(h, 2), 60) * SCALE;
}

/** Street width (padding) inside a folder at a given depth, in world units. */
export function streetWidth(depth: number): number {
  return Math.min(Math.max(14 - depth * 3, 2), 14) * SCALE;
}

/**
 * Terrace lift, in world units, going from one hierarchy tier to the next. The
 * steps shrink with depth so top-level districts sit visibly raised off the
 * ground and every nesting level below reads as a shallower terrace on top of
 * its parent. `TIER_LIFT[i]` is the rise from tier `i` to tier `i + 1`.
 *
 * The first step is also the top-tier terrace's side wall — the face its name
 * is signed on (`terrace.ts`) — so it is sized for that name to stay readable
 * from the org overview, not only for the step to read as a step.
 */
const TIER_LIFT = [13, 6, 3.4, 2, 1.3] as const;
const TIER_LIFT_MIN = 0.9;

/** The rise from `tier` to `tier + 1`. */
export function tierLift(tier: number): number {
  return (TIER_LIFT[Math.max(tier, 0)] ?? TIER_LIFT_MIN) * SCALE;
}

/** How much higher a file plate rides than the folder terrace it sits on. */
const FILE_RISE = 0.5;

/** Y of the top surface of the plate belonging to a node at terrace `tier`. */
export function plateTop(tier: number, isFile: boolean): number {
  let y = 0;
  for (let i = 0; i < tier; i++) y += tierLift(i);
  return y + (isFile ? FILE_RISE * SCALE : 0);
}

/**
 * Plate thickness for a tier: a terrace's side wall reaches all the way down to
 * its parent's surface, which is what makes the stack read as solid steps (and
 * gives the side-wall signage a face to live on).
 */
export function plateThickness(tier: number, isFile: boolean): number {
  const wall = tier <= 0 ? PLATE_THICKNESS * SCALE : tierLift(tier - 1);
  return wall + (isFile ? FILE_RISE * SCALE : 0) + 0.02;
}

export const PLATE_THICKNESS = 0.55;

/** Per-depth anti-coplanarity nudge; far below anything the eye can read. */
const PLATE_EPSILON = 0.012;

// ---------------------------------------------------------------------------
// Recursive city layout
// ---------------------------------------------------------------------------

/**
 * Smallest placeable footprint, in ABSOLUTE world units — deliberately not
 * multiplied by the legibility scale: scaling a small scope up would grow the
 * strip threshold by the same factor and its files could never re-appear.
 * Kept absolute, drilling into a scaled-up scope places what the parent
 * scope had to strip.
 */
const MIN_RECT = 1.2;

interface Entry {
  item: Weighted;
  index: number;
  weight: number;
  area: number;
}

function layoutNode(node: VNode, rect: Rect, depth: number, tier: number): void {
  node.rect = rect;
  node.depth = depth;
  node.tier = tier;
  node.massed = false;
  // Pass-through levels share a tier, so nudge each depth by a hair: without it
  // a repo -> packages wrapper would be exactly coplanar with its child.
  node.top = plateTop(tier, node.type === 'file') + depth * PLATE_EPSILON * SCALE;

  if (node.type === 'file') {
    node.plots = layoutModules(node, rect);
    return;
  }

  const kids = node.children;
  if (!kids || !kids.length) return;
  // A folder with a single child (repo -> packages) is a pass-through, not a
  // terrace of its own: it would spend a whole tier step on no information.
  const childTier = kids.length === 1 ? tier : tier + 1;
  if (rect.w < MIN_RECT * 2 || rect.h < MIN_RECT * 2) {
    // Too small to subdivide meaningfully — the folder itself becomes one
    // massing block approximating everything underneath.
    node.massed = true;
    for (const k of kids) stripLayout(k);
    return;
  }

  // Streets: inset the folder, then a smaller gutter between siblings.
  const street = Math.min(streetWidth(depth), rect.w * 0.14, rect.h * 0.14);
  const inner = {
    x: rect.x + street,
    z: rect.z + street,
    w: Math.max(rect.w - street * 2, MIN_RECT),
    h: Math.max(rect.h - street * 2, MIN_RECT),
  };
  const gutter = Math.min(Math.max(street * 0.5, 1 * SCALE), 6 * SCALE);

  const items = kids.map((k) => ({ weight: Math.max(k.loc || 0, 1) }));
  const cells = treemap(items, inner);

  for (const cell of cells) {
    const child = kids[cell.index];
    if (!child) continue;
    const shrunk = insetRect(cell, gutter / 2);
    if (shrunk.w < MIN_RECT || shrunk.h < MIN_RECT) {
      // Too small to open, but not invisible: keep the treemap cell and mark
      // the child as one opaque block whose height approximates its loc.
      massLayout(child, cell, depth + 1, childTier);
      continue;
    }
    layoutNode(child, shrunk, depth + 1, childTier);
  }
}

/** Cells this small stay unplaced even as blocks — sub-pixel clutter. */
const MASS_MIN = 0.35;

/** Place a too-small node as a single aggregate massing block. */
function massLayout(node: VNode, rect: Rect, depth: number, tier: number): void {
  if (rect.w < MASS_MIN || rect.h < MASS_MIN) {
    stripLayout(node);
    return;
  }
  node.rect = rect;
  node.depth = depth;
  node.tier = tier;
  node.massed = true;
  node.top = plateTop(tier, node.type === 'file') + depth * PLATE_EPSILON * SCALE;
  node.plots = [];
  if (node.children) for (const k of node.children) stripLayout(k);
}

/** Mini-treemap of a file's modules inside the file's plate. */
function layoutModules(fileNode: VNode, rect: Rect): Plot[] {
  const mods = fileNode.modules;
  if (!mods || !mods.length) return [];

  const pad = Math.min(1.6 * SCALE, rect.w * 0.12, rect.h * 0.12);
  const inner = {
    x: rect.x + pad,
    z: rect.z + pad,
    w: Math.max(rect.w - pad * 2, 0.4 * SCALE),
    h: Math.max(rect.h - pad * 2, 0.4 * SCALE),
  };
  const gap = Math.min(0.8 * SCALE, inner.w * 0.06, inner.h * 0.06);

  const cells = treemap(
    mods.map((m) => ({ weight: Math.max(m.loc || 0, 1) })),
    inner
  );

  const plots: Plot[] = [];
  for (const cell of cells) {
    const mod: VMod | undefined = mods[cell.index];
    if (!mod) continue;
    const r = insetRect(cell, gap / 2);
    if (r.w <= 0.05 * SCALE || r.h <= 0.05 * SCALE) continue;
    plots.push({ mod, x: r.x, z: r.z, w: r.w, h: r.h });
  }
  return plots;
}

function stripLayout(node: VNode): void {
  node.rect = null;
  node.massed = false;
  if (node.children) for (const k of node.children) stripLayout(k);
}

function insetRect(r: Rect, d: number): Rect {
  return { x: r.x + d, z: r.z + d, w: r.w - d * 2, h: r.h - d * 2 };
}

// ---------------------------------------------------------------------------
// Squarified treemap core (Bruls, Huizing & van Wijk)
// ---------------------------------------------------------------------------

function squarify(entries: Entry[], rect: Rect, out: Cell[]): void {
  let i = 0;
  while (i < entries.length && rect.w > 1e-6 && rect.h > 1e-6) {
    const short = Math.min(rect.w, rect.h);
    let rowArea = 0;
    let min = Infinity;
    let max = 0;
    let count = 0;
    let currentWorst = Infinity;

    while (i + count < entries.length) {
      const entry = entries[i + count];
      if (!entry) break;
      const a = entry.area;
      const nMin = Math.min(min, a);
      const nMax = Math.max(max, a);
      const nWorst = worstRatio(rowArea + a, nMin, nMax, short);
      if (count === 0 || nWorst <= currentWorst) {
        rowArea += a;
        min = nMin;
        max = nMax;
        currentWorst = nWorst;
        count++;
      } else break;
    }
    if (count === 0) break;

    if (rect.w >= rect.h) {
      // Row occupies a vertical strip on the left, items stack along Z.
      const thick = rect.h > 0 ? rowArea / rect.h : 0;
      let cz = rect.z;
      for (let k = 0; k < count; k++) {
        const e = entries[i + k];
        if (!e) continue;
        const ch = rowArea > 0 ? rect.h * (e.area / rowArea) : 0;
        out.push({ item: e.item, index: e.index, x: rect.x, z: cz, w: thick, h: ch });
        cz += ch;
      }
      rect.x += thick;
      rect.w -= thick;
    } else {
      // Row occupies a horizontal strip at the top, items stack along X.
      const thick = rect.w > 0 ? rowArea / rect.w : 0;
      let cx = rect.x;
      for (let k = 0; k < count; k++) {
        const e = entries[i + k];
        if (!e) continue;
        const cw = rowArea > 0 ? rect.w * (e.area / rowArea) : 0;
        out.push({ item: e.item, index: e.index, x: cx, z: rect.z, w: cw, h: thick });
        cx += cw;
      }
      rect.z += thick;
      rect.h -= thick;
    }
    i += count;
  }

  // Anything left over (numerical edge cases) gets the remaining slab.
  for (; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    out.push({ item: e.item, index: e.index, x: rect.x, z: rect.z, w: 0, h: 0 });
  }
}

function worstRatio(rowArea: number, min: number, max: number, short: number): number {
  if (rowArea <= 0 || short <= 0) return Infinity;
  const s2 = short * short;
  const a2 = rowArea * rowArea;
  return Math.max((s2 * max) / a2, a2 / (s2 * min));
}
