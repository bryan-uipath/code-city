/**
 * strata.ts — the "Strata" render mode: a file's whole life as a stack of slabs.
 *
 * One slab per commit that touched the file inside the timeline range, at a
 * fixed level height, so **height = commit count**. Each slab's footprint is the
 * file's LOC at that commit relative to today's LOC, so **area = size over time**
 * — a tapering tower grew gradually, a straight one churned at a stable size.
 *
 * The base is the most recent commit (the current handle's snapshot) and older
 * strata stack upward: the building grew from the bottom, like a tree.
 *
 * LOC-at-commit is reconstructed client-side from the stream's per-commit
 * `[adds, dels]` deltas, walking newest → oldest away from today's line count.
 */
import * as THREE from 'three';
import type { CityData } from '../../shared/types.js';
import { plateTop } from './layout.js';
import type { VNode } from './vtree.js';

/** World height of one commit level. */
export const LEVEL_HEIGHT = 1.6;
/** Slab thickness — the gap to the next level is what makes the strata legible. */
const SLAB_HEIGHT = 1.15;
/**
 * Levels per file. Only a handful of files in a big repo pass this, but those
 * few would otherwise dominate both the skyline and the instance budget.
 */
export const MAX_LEVELS = 120;
/** A file's footprint never shrinks below this fraction of its current one. */
const MIN_AREA = 0.06;
/** Files with no commit in range still get a base slab, this thin. */
const STUB_HEIGHT = 0.4;

const FIX_RE = /\b(fix|fixes|fixed|bug|bugfix|hotfix)\b/i;
/** Conventional commits: `type(scope)!: subject`. */
const CONVENTIONAL_RE = /^(\w+)(\(.*?\))?!?:/;

const RECENT_COLOR = new THREE.Color(0x22d3ee);
const OLD_COLOR = new THREE.Color(0x4c1d95);
const STUB_COLOR = new THREE.Color(0x1b2432);

/**
 * Change kind → hue, so a stack's bands read as the file's mix of work:
 * mostly red = it keeps breaking, mostly cyan = it keeps growing features.
 * Subjects with no recognizable type fall back to the age gradient.
 */
export const COMMIT_TYPE_COLORS: Record<string, number> = {
  feat: 0x22d3ee,
  fix: 0xef4444,
  bug: 0xef4444,
  bugfix: 0xef4444,
  hotfix: 0xef4444,
  refactor: 0xa78bfa,
  chore: 0x64748b,
  docs: 0x4ade80,
  test: 0xfbbf24,
  perf: 0xf472b6,
  ci: 0x52525b,
  build: 0x52525b,
};
/** Legend order — the types worth naming, deduped by color. */
export const COMMIT_TYPE_ORDER = ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'chore', 'ci'] as const;

/** Types that share another type's swatch, so a filter on one catches both. */
const TYPE_ALIAS: Record<string, string> = { bug: 'fix', bugfix: 'fix', hotfix: 'fix', build: 'ci' };
const LEGEND_TYPES = new Set<string>(COMMIT_TYPE_ORDER);

const TYPE_COLORS = new Map<string, THREE.Color>(
  Object.entries(COMMIT_TYPE_COLORS).map(([type, hex]) => [type, new THREE.Color(hex)])
);

/**
 * Which legend swatch a commit belongs to — the key the legend filter works in.
 * Aliases collapse onto the swatch they share a color with, and a fix-shaped
 * subject with no type prefix still counts as `fix`, exactly as the paint does.
 * `null` = no named type: the level keeps the age gradient and no swatch owns it.
 */
export function commitTypeKey(commit: StrataCommit): string | null {
  const type = commit.type;
  if (type !== null) {
    const key = TYPE_ALIAS[type] ?? type;
    if (LEGEND_TYPES.has(key)) return key;
  }
  return commit.fix ? 'fix' : null;
}

/** One commit as a file sees it: when, what it said, and how much it moved. */
export interface StrataCommit {
  h: string;
  ts: number;
  s: string;
  adds: number;
  dels: number;
  /** Conventional-commit type, lowercased, or null when the subject has none. */
  type: string | null;
  /** Type `fix`/`bug`/`hotfix`, or a fix-shaped subject without a type prefix. */
  fix: boolean;
}

/** Per-file commit history, newest first. Built once per dataset. */
export type StrataIndex = Map<string, StrataCommit[]>;

/** One slab instance: the file it belongs to and the commit it stands for. */
export interface StrataRecord {
  file: VNode;
  /** null for the stub slab of a file with no commits in range. */
  commit: StrataCommit | null;
  /** 0 = base (most recent). */
  level: number;
}

/**
 * How one level is painted. `age` is 0 (oldest in range) … 1 (newest), so a
 * paint can encode recency as brightness while hue says something else.
 *
 * This is the seam that keeps color independent of geometry: the strata stacks
 * are built once per scope/range and can then be repainted by any pass — the
 * same relationship `applyOverlay` has with the module buildings.
 */
export type StrataPaint = (record: StrataRecord, age: number, target: THREE.Color) => THREE.Color;

/**
 * A predicate on levels, applied alongside the time range: commits it rejects
 * are not built at all, so the stack recompresses from the base and its height
 * becomes "matching commits only". The LOC walk still steps through the rejected
 * commits, so the surviving slabs keep their true size-at-that-moment.
 */
export type LevelFilter = (commit: StrataCommit) => boolean;

export interface StrataBuild {
  group: THREE.Group;
  mesh: THREE.InstancedMesh;
  /** Indexed by instance id; length tracks the live instance count. */
  records: StrataRecord[];
  /** Rebuild the stacks for a time range; cheap enough to call while dragging. */
  update(range: { start: number; cursor: number | null }, keep?: LevelFilter | null): void;
  /** Repaint the existing levels; omit `paint` to reapply the current one. */
  recolor(paint?: StrataPaint): void;
  /** Tallest stack in world units — used to frame selections. */
  heightOf(file: VNode): number;
}

/**
 * Index the commit stream per file. Commits without the `d` array (v2 data from
 * an older analyzer) still index, with zero deltas: the stack then reads as a
 * straight tower, which is the honest answer when sizes are unknown.
 */
export function buildStrataIndex(data: CityData): StrataIndex {
  const index: StrataIndex = new Map();
  const files = Array.isArray(data.files) ? data.files : [];
  for (const commit of Array.isArray(data.commits) ? data.commits : []) {
    const ts = Number(commit.ts);
    if (!Number.isFinite(ts)) continue;
    const subject = commit.s || '';
    const type = CONVENTIONAL_RE.exec(subject)?.[1]?.toLowerCase() ?? null;
    const fix = type === null ? FIX_RE.test(subject) : type === 'fix' || type === 'bug' || type === 'hotfix';
    const deltas = commit.d;
    for (let i = 0; i < commit.f.length; i++) {
      const idx = commit.f[i];
      const path = idx === undefined ? undefined : files[idx];
      if (path === undefined) continue;
      const delta = deltas ? deltas[i] : undefined;
      let arr = index.get(path);
      if (!arr) index.set(path, (arr = []));
      arr.push({
        h: String(commit.h || ''), ts, s: subject,
        adds: delta ? delta[0] : 0, dels: delta ? delta[1] : 0, type, fix,
      });
    }
  }
  for (const arr of index.values()) arr.sort((a, b) => b.ts - a.ts); // newest first
  return index;
}

/**
 * Allocate the strata mesh for a set of laid-out file nodes.
 *
 * The instance buffer is sized once for the widest possible range, so dragging
 * either timeline handle only rewrites matrices and colors — no reallocation,
 * no geometry churn.
 *
 * @param files    scope file nodes (each needs `rect`); synthetic nodes resolve
 *                 to their source file through `realPath`
 * @param realPath the repo-relative path whose history a node stands for
 * @param bounds   the stream's full time span, used to normalize the age
 *                 gradient when a range handle sits at its extreme
 */
export function createStrata(
  files: VNode[],
  index: StrataIndex,
  realPath: (node: VNode) => string | null,
  bounds: { min: number; max: number }
): StrataBuild | null {
  const stacks: Array<{ node: VNode; history: StrataCommit[] }> = [];
  let capacity = 0;
  for (const node of files) {
    if (!node.rect) continue;
    const path = realPath(node);
    const history = (path ? index.get(path) : null) ?? [];
    stacks.push({ node, history });
    capacity += Math.max(Math.min(history.length, MAX_LEVELS), 1);
  }
  if (!capacity) return null;

  const geom = new THREE.BoxGeometry(1, 1, 1);
  geom.translate(0, 0.5, 0); // base sits at y = 0
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.5,
    metalness: 0.08,
    transparent: true,
    opacity: 0.94,
    emissive: 0xffffff,
    emissiveIntensity: 1,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       #ifdef USE_COLOR
         totalEmissiveRadiance = vColor * 0.45;
       #endif`
    );
  };
  material.customProgramCacheKey = () => 'strata';

  const mesh = new THREE.InstancedMesh(geom, material, capacity);
  mesh.name = 'strata';
  mesh.frustumCulled = false;
  const group = new THREE.Group();
  group.name = 'strataLayer';
  group.add(mesh);

  const records: StrataRecord[] = [];
  /** Normalized commit age per instance, so a repaint needs no range math. */
  const ages: number[] = [];
  const heights = new Map<VNode, number>();
  let paint: StrataPaint = commitTypePaint;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();

  const build: StrataBuild = {
    group,
    mesh,
    records,
    update,
    recolor,
    heightOf: (file) => heights.get(file) ?? LEVEL_HEIGHT,
  };
  update({ start: -Infinity, cursor: null });
  return build;

  function update(range: { start: number; cursor: number | null }, keep?: LevelFilter | null): void {
    const cursorTs = range.cursor ?? Infinity;
    const startTs = Number.isFinite(range.start) ? range.start : bounds.min;
    // Age is normalized over the visible range, so the gradient always uses its
    // whole width no matter how far the handles have been dragged together.
    const span = Math.max((Number.isFinite(cursorTs) ? cursorTs : bounds.max) - startTs, 1);
    records.length = 0;
    ages.length = 0;
    heights.clear();
    let n = 0;

    for (const { node, history } of stacks) {
      const rect = node.rect;
      if (!rect) continue;
      const top = plateTop(node.tier ?? node.depth ?? 0, node.type === 'file');
      const inset = Math.min(0.8, rect.w * 0.08, rect.h * 0.08);
      const baseW = Math.max(rect.w - inset * 2, 0.25);
      const baseH = Math.max(rect.h - inset * 2, 0.25);
      const cx = rect.x + rect.w / 2;
      const cz = rect.z + rect.h / 2;

      // The current handle is a snapshot: rewind today's LOC past every commit
      // that happened after it, then stack the commits inside the range.
      let loc = Math.max(node.loc, 1);
      let first = 0;
      while (first < history.length) {
        const c = history[first];
        if (!c || c.ts <= cursorTs) break;
        loc = Math.max(loc - (c.adds - c.dels), 1);
        first++;
      }
      const baseLoc = loc;

      let level = 0;
      for (let i = first; i < history.length && level < MAX_LEVELS && n < capacity; i++) {
        const c = history[i];
        if (!c) break;
        if (c.ts < startTs) break; // history is newest-first: everything past here is older
        // A filtered-out commit still moved the file, so it still moves the LOC
        // walk — it just gets no slab, and the stack closes over the gap.
        if (!keep || keep(c)) {
          const ratio = Math.min(Math.max(loc / baseLoc, MIN_AREA), 1);
          const k = Math.sqrt(ratio); // ratio is an area, the slab scales by its side
          pos.set(cx, top + level * LEVEL_HEIGHT, cz);
          scale.set(baseW * k, SLAB_HEIGHT, baseH * k);
          m.compose(pos, q, scale);
          mesh.setMatrixAt(n, m);
          ages[n] = Math.min(Math.max((c.ts - startTs) / span, 0), 1);
          records[n] = { file: node, commit: c, level };
          n++;
          level++;
        }
        loc = Math.max(loc - (c.adds - c.dels), 1);
      }

      if (level === 0 && n < capacity) {
        // Untouched inside the range — a thin plinth, so the file still reads.
        pos.set(cx, top, cz);
        scale.set(baseW, STUB_HEIGHT, baseH);
        m.compose(pos, q, scale);
        mesh.setMatrixAt(n, m);
        ages[n] = 0;
        records[n] = { file: node, commit: null, level: 0 };
        n++;
        heights.set(node, STUB_HEIGHT);
      } else {
        heights.set(node, level * LEVEL_HEIGHT);
      }
    }

    records.length = n;
    ages.length = n;
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    // Deliberately not `meta`: that key marks the module-building meshes.
    mesh.userData.strata = records;
    recolor();
  }

  function recolor(next?: StrataPaint): void {
    if (next) paint = next;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec) continue;
      mesh.setColorAt(i, paint(rec, ages[i] ?? 0, color));
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

/**
 * The default paint: hue = what kind of change it was (conventional-commit
 * type), brightness = how recent it is inside the range. Subjects with no
 * recognizable type keep the plain age gradient, dim violet → bright cyan.
 */
export const commitTypePaint: StrataPaint = (record, age, target) => {
  const commit = record.commit;
  if (!commit) return target.copy(STUB_COLOR);
  const hue = commit.type ? TYPE_COLORS.get(commit.type) : undefined;
  const lift = 0.55 + 0.6 * age;
  if (hue) return target.copy(hue).multiplyScalar(lift);
  const fixHue = TYPE_COLORS.get('fix');
  if (commit.fix && fixHue) return target.copy(fixHue).multiplyScalar(lift);
  return target.copy(OLD_COLOR).lerp(RECENT_COLOR, age).multiplyScalar(0.5 + 0.6 * age);
};
