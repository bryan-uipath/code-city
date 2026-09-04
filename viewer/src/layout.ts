/**
 * layout.ts — squarified treemap + recursive "city" layout; inside a file, a
 * reading-order flow (modules fill the file's footprint left→right, top→bottom;
 * members stack as slabs).
 *
 * World space convention: the city lies on the XZ plane, Y is up.
 * A rect is { x, z, w, h } with (x, z) the min corner.
 */
import type { Home, Plot, Rect, VNode, VMod } from './vtree.js';

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
 * @param opts.at    place the root at this rect/depth/tier instead (a drilled-in
 *                   scope keeps the footprint it had, so nothing rescales)
 * @returns the same root
 */
export function layoutCity(root: VNode, opts: { size?: number; at?: Home } = {}): VNode {
  const size = opts.size ?? 900;
  const at = opts.at ?? { rect: { x: -size / 2, z: -size / 2, w: size, h: size }, depth: 0, tier: 0 };
  layoutNode(root, at.rect, at.depth, at.tier);
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
 * World units per source line inside a file: its longest module stands about
 * half the plate's side (capped at 60), everything else linear in lines. Read
 * off the file's scope layout, so a lone module isolated on its own keeps the
 * height it had inside the file.
 */
export function lineUnit(file: VNode): number {
  const r = file._scope?.rect;
  const side = r ? Math.max(r.w, r.h) : 60;
  let max = 40;
  for (const m of file.modules ?? []) max = Math.max(max, m.loc || 0);
  return Math.min(60, side * 0.4) / max;
}

/** Vertical extent of a building for a given LOC count. */
export function buildingHeight(loc: number): number {
  const h = 2 + 6 * Math.log2(1 + Math.max(loc, 0) / 10);
  return Math.min(Math.max(h, 2), 60);
}

/** Street width (padding) inside a folder at a given depth, in world units. */
export function streetWidth(depth: number): number {
  return Math.min(Math.max(14 - depth * 3, 2), 14);
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
  return TIER_LIFT[Math.max(tier, 0)] ?? TIER_LIFT_MIN;
}

/** How much higher a file plate rides than the folder terrace it sits on. */
const FILE_RISE = 0.5;

/** Y of the top surface of the plate belonging to a node at terrace `tier`. */
export function plateTop(tier: number, isFile: boolean): number {
  let y = 0;
  for (let i = 0; i < tier; i++) y += tierLift(i);
  return y + (isFile ? FILE_RISE : 0);
}

/**
 * Plate thickness for a tier: a terrace's side wall reaches all the way down to
 * its parent's surface, which is what makes the stack read as solid steps (and
 * gives the side-wall signage a face to live on).
 */
export function plateThickness(tier: number, isFile: boolean): number {
  const wall = tier <= 0 ? PLATE_THICKNESS : tierLift(tier - 1);
  return wall + (isFile ? FILE_RISE : 0) + 0.02;
}

export const PLATE_THICKNESS = 0.55;

/** Per-depth anti-coplanarity nudge; far below anything the eye can read. */
const PLATE_EPSILON = 0.012;

// ---------------------------------------------------------------------------
// Recursive city layout
// ---------------------------------------------------------------------------

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
  // First placement wins: the top-level layout runs first, so a real node's
  // home is its spot in the whole city.
  if (!node.home) node.home = { rect, depth, tier };
  // Pass-through levels share a tier, so nudge each depth by a hair: without it
  // a repo -> packages wrapper would be exactly coplanar with its child.
  node.top = plateTop(tier, node.type === 'file') + depth * PLATE_EPSILON;

  if (node.type === 'file') {
    node.plots = layoutModules(node, rect);
    return;
  }
  if (node.synth === 'fileScope') return layoutFileScope(node, rect, depth, tier);
  if (node.synth === 'module') return layoutStack(node, rect, depth, tier, lineUnit(node.srcFile ?? node));

  const kids = node.children;
  if (!kids || !kids.length) return;
  // A folder with a single child (repo -> packages) is a pass-through, not a
  // terrace of its own: it would spend a whole tier step on no information.
  const childTier = kids.length === 1 ? tier : tier + 1;
  if (rect.w < MIN_RECT * 2 || rect.h < MIN_RECT * 2) {
    // Too small to subdivide meaningfully — leave children unplaced.
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
  const gutter = Math.min(Math.max(street * 0.5, 1), 6);

  const items = kids.map((k) => ({ weight: Math.max(k.loc || 0, 1) }));
  const cells = treemap(items, inner);

  for (const cell of cells) {
    const child = kids[cell.index];
    if (!child) continue;
    const shrunk = insetRect(cell, gutter / 2);
    if (shrunk.w < MIN_RECT || shrunk.h < MIN_RECT) {
      stripLayout(child);
      continue;
    }
    layoutNode(child, shrunk, depth + 1, childTier);
  }
}

// --- inside a file ---------------------------------------------------------

/** Gap between stacked member slabs, world units. */
const SLAB_GAP = 0.15;

/**
 * A file isolate fills the file's own footprint with its modules in reading
 * order — rows left→right, top→bottom like text on a page, each module as
 * wide as its line count, every row justified to the plate and as deep as its
 * share — so area stays ∝ lines while source order survives. Heights are
 * linear in lines (`lineUnit`).
 */
function layoutFileScope(root: VNode, rect: Rect, depth: number, tier: number): void {
  const kids = byLine(root.children ?? []);
  if (!kids.length) return;
  const street = Math.min(streetWidth(depth), rect.w * 0.14, rect.h * 0.14);
  const inner = { x: rect.x + street, z: rect.z + street, w: Math.max(rect.w - street * 2, MIN_RECT), h: Math.max(rect.h - street * 2, MIN_RECT) };
  const gutter = Math.min(Math.max(street * 0.5, 1), 6, 0.6);
  const unit = lineUnit(root.srcFile ?? root);
  // A one-line const still needs a plot you can hover: floor each share at a
  // quarter of the average, so area ∝ lines only above that.
  let total = 0;
  for (const k of kids) total += Math.max(k.loc || 0, 1);
  const minW = total / (kids.length * 4);
  const cells = flowLayout(kids.map((k) => ({ weight: Math.max(k.loc || 0, minW) })), inner);
  for (const cell of cells) {
    const k = kids[cell.index];
    if (!k) continue;
    const r = insetRect(cell, gutter / 2);
    if (r.w < MIN_RECT || r.h < MIN_RECT) {
      stripLayout(k);
      continue;
    }
    if (k.synth === 'module') layoutStack(k, r, depth + 1, tier + 1, unit);
    else placeSlab(k, r, depth + 1, tier + 1, 0, unit);
  }
}

/** Reading-order flow: rows of items, each row justified to the rect's width. */
export function flowLayout(items: Weighted[], rect: Rect): Cell[] {
  const out: Cell[] = [];
  if (!items.length || rect.w <= 0 || rect.h <= 0) return out;
  const weights = items.map((it) => Math.max(Number(it.weight) || 0, 0));
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) {
    weights.fill(1);
    total = weights.length;
  }
  // As many rows as it takes for the average cell to be roughly square.
  const rows = Math.max(1, Math.round(Math.sqrt((items.length * rect.h) / rect.w)));
  const perRow = total / rows;
  const groups: number[][] = [[]];
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i] ?? 0;
    const cur = groups[groups.length - 1];
    // Break before an item whose midpoint would overshoot the row's share.
    if (cur && cur.length && acc + w / 2 > perRow) {
      groups.push([i]);
      acc = w;
    } else {
      cur?.push(i);
      acc += w;
    }
  }
  // A light trailing row would be a sliver too thin to place: fold it back.
  const last = groups[groups.length - 1];
  const prev = groups[groups.length - 2];
  if (last && prev && last.reduce((a, i) => a + (weights[i] ?? 0), 0) < perRow * 0.4) {
    prev.push(...last);
    groups.pop();
  }
  let z = rect.z;
  for (const g of groups) {
    let rowW = 0;
    for (const i of g) rowW += weights[i] ?? 0;
    const depth = (rect.h * rowW) / total;
    let x = rect.x;
    for (const i of g) {
      const item = items[i];
      if (!item) continue;
      const cw = rowW > 0 ? (rect.w * (weights[i] ?? 0)) / rowW : 0;
      out.push({ item, index: i, x, z, w: cw, h: depth });
      x += cw;
    }
    z += depth;
  }
  return out;
}

/**
 * A module with members (class, interface, enum): one column made of its
 * members stacked in source order, each slab as tall as its line count.
 */
function layoutStack(node: VNode, rect: Rect, depth: number, tier: number, unit: number): void {
  node.rect = rect;
  node.depth = depth;
  node.tier = tier;
  node.top = plateTop(tier, false) + depth * PLATE_EPSILON;
  if (!node.home) node.home = { rect, depth, tier };
  let y = 0;
  for (const m of byLine(node.children ?? [])) {
    y += placeSlab(m, rect, depth + 1, tier, y, unit) + SLAB_GAP;
  }
}

/** One module or member as a slab over `rect`, its base `y0` above the plate. Returns its height. */
function placeSlab(node: VNode, rect: Rect, depth: number, tier: number, y0: number, unit: number): number {
  node.rect = rect;
  node.depth = depth;
  node.tier = tier;
  node.top = plateTop(tier, true) + depth * PLATE_EPSILON;
  if (!node.home) node.home = { rect, depth, tier };
  const mod = node.mod ?? node.modules?.[0];
  const height = Math.max((mod?.loc ?? node.loc) * unit, 0.4);
  node.plots = mod ? [{ mod, ...rect, y0, height }] : [];
  return height;
}

/** Source order when every item has a line, else the order given. */
function byLine(nodes: VNode[]): VNode[] {
  return nodes.every((n) => typeof n.mod?.line === 'number')
    ? [...nodes].sort((a, b) => (a.mod?.line ?? 0) - (b.mod?.line ?? 0))
    : nodes;
}

/** Mini-treemap of a file's modules inside the file's plate. */
function layoutModules(fileNode: VNode, rect: Rect): Plot[] {
  const mods = fileNode.modules;
  if (!mods || !mods.length) return [];
  // A synthetic leaf (a lone module isolated on its own) keeps its spine height.
  if (fileNode.synth) {
    const mod = mods[0];
    const height = Math.max((mod?.loc ?? fileNode.loc) * lineUnit(fileNode.srcFile ?? fileNode), 0.4);
    return mod ? [{ mod, ...rect, y0: 0, height }] : [];
  }

  const pad = Math.min(1.6, rect.w * 0.12, rect.h * 0.12);
  const inner = {
    x: rect.x + pad,
    z: rect.z + pad,
    w: Math.max(rect.w - pad * 2, 0.4),
    h: Math.max(rect.h - pad * 2, 0.4),
  };
  const gap = Math.min(0.8, inner.w * 0.06, inner.h * 0.06);

  const cells = treemap(
    mods.map((m) => ({ weight: Math.max(m.loc || 0, 1) })),
    inner
  );

  const plots: Plot[] = [];
  for (const cell of cells) {
    const mod: VMod | undefined = mods[cell.index];
    if (!mod) continue;
    const r = insetRect(cell, gap / 2);
    if (r.w <= 0.05 || r.h <= 0.05) continue;
    plots.push({ mod, x: r.x, z: r.z, w: r.w, h: r.h });
  }
  return plots;
}

function stripLayout(node: VNode): void {
  node.rect = null;
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
