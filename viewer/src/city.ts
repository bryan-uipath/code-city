/**
 * city.ts — geometry builders for the hologram code-city.
 *
 * Everything that touches Three.js geometry lives here; main.ts owns state.
 */
import * as THREE from 'three';
import type { Pr } from '../../shared/types.js';
import { buildingHeight, plateTop, plateThickness, PLATE_THICKNESS } from './layout.js';
import type { AnyKind, Plot, VMod, VNode } from './vtree.js';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const KIND_COLORS: Record<AnyKind, number> = {
  function: 0x22d3ee,
  class: 0x60a5fa,
  component: 0xf472b6,
  interface: 0xa78bfa,
  type: 0x64748b,
  enum: 0xfbbf24,
  const: 0x475569,
  section: 0xd9b26b, // markdown heading — parchment gold
  // v2 module members (drill-down inside a building)
  method: 0x22d3ee,
  property: 0x38bdf8,
  accessor: 0xfbbf24,
  member: 0x8b5cf6,
};

export const KIND_ORDER = ['function', 'class', 'component', 'interface', 'type', 'enum', 'const', 'section'] as const;
export const MEMBER_ORDER = ['method', 'property', 'accessor', 'member'] as const;
/** Every kind that can become a building instance bucket. */
export const ALL_KINDS: AnyKind[] = [...KIND_ORDER, ...MEMBER_ORDER];

const KIND_OPACITY: Record<AnyKind, number> = {
  function: 0.92,
  class: 0.92,
  component: 0.92,
  interface: 0.45,
  type: 0.92,
  enum: 0.92,
  const: 0.92,
  section: 0.92,
  method: 0.92,
  property: 0.9,
  accessor: 0.92,
  member: 0.7,
};

/** Members read as distinct silhouettes: properties are slabs, accessors squat. */
const KIND_HEIGHT_SCALE: Partial<Record<AnyKind, number>> = { property: 0.3, accessor: 0.6, member: 0.5 };

export const PALETTE = {
  bg: 0x05080f,
  cyan: 0x22d3ee,
  orange: 0xfa4616,
  green: 0x4ade80,
  folderPlate: 0x0a1322,
  filePlate: 0x122036,
  edge: 0x2ee6ff,
};

const HEAT_STOPS = [
  [0.0, new THREE.Color(0x3b4658)],
  [0.34, new THREE.Color(0xfbbf24)],
  [0.7, new THREE.Color(0xfa4616)],
  [1.0, new THREE.Color(0xef4444)],
] as const;

/** Gray -> yellow -> orange -> red ramp. Writes into `target`. */
export function heatColor(t: number, target: THREE.Color): THREE.Color {
  const x = Math.min(Math.max(t, 0), 1);
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const stop = HEAT_STOPS[i];
    const prev = HEAT_STOPS[i - 1];
    if (!stop || !prev) continue;
    const [p1, c1] = stop;
    const [p0, c0] = prev;
    if (x <= p1 || i === HEAT_STOPS.length - 1) {
      const f = p1 === p0 ? 0 : (x - p0) / (p1 - p0);
      return target.copy(c0).lerp(c1, Math.min(Math.max(f, 0), 1));
    }
  }
  return target.copy(HEAT_STOPS[0][1]);
}

// ---------------------------------------------------------------------------
// City construction
// ---------------------------------------------------------------------------

/** One building instance: which mesh slot it owns and what it stands for. */
export interface ModuleRecord {
  kind: AnyKind;
  mesh: THREE.InstancedMesh;
  instanceId: number;
  file: VNode;
  mod: VMod;
  baseColor: THREE.Color;
  /** World Y of the building's base (its plate top). */
  base: number;
  height: number;
  center: THREE.Vector3;
}

/** One plate instance (file or folder). */
export interface PlateRecord {
  node: VNode;
  instanceId: number;
  baseColor: THREE.Color;
}

export interface CityBuild {
  group: THREE.Group;
  buildingMeshes: THREE.InstancedMesh[];
  moduleRecords: ModuleRecord[];
  filePlates: THREE.InstancedMesh | null;
  fileRecords: PlateRecord[];
  folderPlates: THREE.InstancedMesh | null;
  folderRecords: PlateRecord[];
  pickables: THREE.Object3D[];
}

/** Build all static city geometry from a laid-out tree. */
export function buildCity(root: VNode): CityBuild {
  const group = new THREE.Group();
  group.name = 'city';

  const folders: VNode[] = [];
  const files: VNode[] = [];
  walk(root, (node) => {
    if (!node.rect) return;
    if (node.type === 'file') files.push(node);
    else folders.push(node);
  });
  const folderPart = buildPlates(folders, false);
  const filePart = buildPlates(files, true);
  const buildings = buildBuildings(files);
  const outlines = buildOutlines(folders, files);

  if (folderPart.mesh) group.add(folderPart.mesh);
  if (filePart.mesh) group.add(filePart.mesh);
  for (const m of buildings.meshes) group.add(m);
  if (outlines) group.add(outlines);

  const pickables: THREE.Object3D[] = [...buildings.meshes];
  if (filePart.mesh) pickables.push(filePart.mesh);
  if (folderPart.mesh) pickables.push(folderPart.mesh);

  return {
    group,
    buildingMeshes: buildings.meshes,
    moduleRecords: buildings.records,
    filePlates: filePart.mesh,
    fileRecords: filePart.records,
    folderPlates: folderPart.mesh,
    folderRecords: folderPart.records,
    pickables,
  };
}

export function walk(node: VNode, fn: (node: VNode) => void): void {
  fn(node);
  if (node.children) for (const c of node.children) walk(c, fn);
}

// --- plates ----------------------------------------------------------------

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
UNIT_BOX.userData.shared = true;

function buildPlates(nodes: VNode[], isFile: boolean): { mesh: THREE.InstancedMesh | null; records: PlateRecord[] } {
  if (!nodes.length) return { mesh: null, records: [] };

  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: isFile ? 0.98 : 0.95,
    fog: true,
  });

  const mesh = new THREE.InstancedMesh(UNIT_BOX, material, nodes.length);
  mesh.name = isFile ? 'filePlates' : 'folderPlates';
  mesh.frustumCulled = false;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const base = new THREE.Color(isFile ? PALETTE.filePlate : PALETTE.folderPlate);
  const tint = new THREE.Color();
  const records: PlateRecord[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const r = n?.rect;
    if (!n || !r) continue;
    const depth = n.depth ?? 0;
    const tier = n.tier ?? depth;
    const top = n.top ?? plateTop(tier, isFile);
    // The wall reaches down to the parent terrace, so the stack reads as steps.
    const thick = plateThickness(tier, isFile);
    pos.set(r.x + r.w / 2, top - thick / 2, r.z + r.h / 2);
    scale.set(r.w, thick, r.h);
    m.compose(pos, q, scale);
    mesh.setMatrixAt(i, m);

    // Deeper folders read slightly brighter so nesting is legible.
    const lift = isFile ? 1 : 1 + Math.min(depth, 5) * 0.13;
    tint.copy(base).multiplyScalar(lift);
    mesh.setColorAt(i, tint);

    records.push({ node: n, instanceId: i, baseColor: tint.clone() });
    n.plateRef = { mesh, instanceId: i, isFile };
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();

  return { mesh, records };
}

// --- buildings -------------------------------------------------------------

function buildingMaterial(kind: AnyKind): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0.1,
    transparent: true,
    opacity: KIND_OPACITY[kind] ?? 0.92,
    emissive: 0xffffff,
    emissiveIntensity: 1,
    depthWrite: (KIND_OPACITY[kind] ?? 0.92) > 0.6,
  });
  const strength = kind === 'interface' ? 0.5 : 0.35;
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       #ifdef USE_COLOR
         totalEmissiveRadiance = vColor * ${strength.toFixed(3)};
       #endif`
    );
  };
  mat.customProgramCacheKey = () => `bld-${kind}`;
  return mat;
}

function buildBuildings(files: VNode[]): { meshes: THREE.InstancedMesh[]; records: ModuleRecord[] } {
  // Bucket module plots by kind so each kind gets one InstancedMesh.
  const buckets = new Map<AnyKind, Array<{ file: VNode; plot: Plot }>>();
  for (const kind of ALL_KINDS) buckets.set(kind, []);

  for (const file of files) {
    if (!file.plots) continue;
    for (const plot of file.plots) {
      const kind = buckets.has(plot.mod.kind) ? plot.mod.kind : 'const';
      buckets.get(kind)?.push({ file, plot });
    }
  }

  const geom = new THREE.BoxGeometry(1, 1, 1);
  geom.translate(0, 0.5, 0); // base sits at y = 0

  const meshes: THREE.InstancedMesh[] = [];
  const records: ModuleRecord[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();

  for (const kind of ALL_KINDS) {
    const entries = buckets.get(kind);
    if (!entries || !entries.length) continue;

    const mesh = new THREE.InstancedMesh(geom, buildingMaterial(kind), entries.length);
    mesh.name = `buildings:${kind}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = kind === 'interface' ? 2 : 1;
    color.setHex(KIND_COLORS[kind]);

    const meta = new Array<ModuleRecord>(entries.length);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const { file, plot } = entry;
      const top = file.top ?? 0;
      const h = plot.height ?? buildingHeight(plot.mod.loc) * (KIND_HEIGHT_SCALE[kind] ?? 1);
      pos.set(plot.x + plot.w / 2, top, plot.z + plot.h / 2);
      scale.set(Math.max(plot.w, 0.25), h, Math.max(plot.h, 0.25));
      m.compose(pos, q, scale);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, color);

      const rec: ModuleRecord = {
        kind,
        mesh,
        instanceId: i,
        file,
        mod: plot.mod,
        baseColor: color.clone(),
        base: top,
        height: h,
        center: new THREE.Vector3(pos.x, top + h / 2, pos.z),
      };
      meta[i] = rec;
      records.push(rec);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.userData.meta = meta;
    meshes.push(mesh);
  }

  geom.userData.shared = true;
  return { meshes, records };
}

// --- outlines --------------------------------------------------------------

/** One merged additive LineSegments tracing the top rim of every plate. */
function buildOutlines(folders: VNode[], files: VNode[]): THREE.LineSegments | null {
  const positions: number[] = [];
  const colors: number[] = [];
  const c = new THREE.Color();

  const push = (n: VNode, isFile: boolean) => {
    const r = n.rect;
    if (!r) return;
    const depth = n.depth ?? 0;
    const y = (n.top ?? plateTop(n.tier ?? depth, isFile)) + 0.02;
    const x0 = r.x;
    const x1 = r.x + r.w;
    const z0 = r.z;
    const z1 = r.z + r.h;
    const corners = [
      [x0, z0], [x1, z0],
      [x1, z0], [x1, z1],
      [x1, z1], [x0, z1],
      [x0, z1], [x0, z0],
    ];
    // Shallow folders glow brighter; deep nesting fades back.
    const k = isFile ? 0.22 : Math.max(0.5 - depth * 0.09, 0.14);
    c.setHex(isFile ? PALETTE.cyan : PALETTE.edge).multiplyScalar(k);
    for (const [px, pz] of corners) {
      positions.push(px ?? 0, y, pz ?? 0);
      colors.push(c.r, c.g, c.b);
    }
  };

  for (const n of folders) push(n, false);
  for (const n of files) push(n, true);
  if (!positions.length) return null;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(g, mat);
  lines.name = 'plateOutlines';
  lines.frustumCulled = false;
  lines.renderOrder = 3;
  return lines;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const LABEL_FONT = '600 44px "SFMono-Regular", "JetBrains Mono", Menlo, monospace';
const SUB_FONT = '30px "SFMono-Regular", "JetBrains Mono", Menlo, monospace';

function clipText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Canvas-texture text sprite. `worldHeight` is the on-screen cap height in
 * world units. Returns a Sprite whose material opacity main.ts animates.
 */
export function makeLabelSprite(
  text: string,
  { color = '#a8f4ff', worldHeight = 12, glow = true, sub }: { color?: string; worldHeight?: number; glow?: boolean; sub?: string } = {}
): THREE.Sprite {
  // Case is the caller's call: place names are uppercase city signage, but
  // identifiers (files, modules) must read exactly as they are written.
  const label = String(text || '');
  const canvas = document.createElement('canvas');
  const ctx = ctx2d(canvas);
  ctx.font = LABEL_FONT;
  const pad = 26;
  let w = Math.ceil(ctx.measureText(label).width) + pad * 2;
  // A second, smaller line under the name: a function's `(args) → result`.
  const subText = sub ? clipText(sub, 72) : '';
  if (subText) {
    ctx.font = SUB_FONT;
    w = Math.max(w, Math.ceil(ctx.measureText(subText).width) + pad * 2);
  }
  const h = subText ? 140 : 96;
  canvas.width = Math.max(w, 8);
  canvas.height = h;

  const c2 = ctx2d(canvas);
  c2.font = LABEL_FONT;
  c2.textAlign = 'center';
  c2.textBaseline = 'middle';
  // Dark backing pill so labels stay readable over bright plates.
  c2.fillStyle = 'rgba(3, 6, 18, 0.78)';
  c2.beginPath();
  c2.roundRect(4, 14, canvas.width - 8, h - 28, 30);
  c2.fill();
  if (glow) {
    c2.shadowColor = color;
    c2.shadowBlur = 22;
  }
  const titleY = subText ? 48 : h / 2;
  c2.fillStyle = color;
  c2.fillText(label, canvas.width / 2, titleY);
  c2.shadowBlur = 0;
  c2.fillText(label, canvas.width / 2, titleY);
  if (subText) {
    c2.font = SUB_FONT;
    c2.fillStyle = 'rgba(168, 244, 255, 0.85)';
    c2.fillText(subText, canvas.width / 2, 100);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    opacity: 1,
    // Normal blending: additive would make the dark backing pill invisible.
    blending: THREE.NormalBlending,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set((worldHeight * canvas.width) / canvas.height, worldHeight, 1);
  sprite.renderOrder = 20;
  sprite.userData.dispose = () => {
    tex.dispose();
    mat.dispose();
  };
  return sprite;
}

/** Deep-dispose everything under (and including) `obj`, then detach it. */
export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const dispose = child.userData.dispose;
    if (typeof dispose === 'function') { dispose(); return; }
    const geometry = 'geometry' in child ? child.geometry : null;
    if (geometry instanceof THREE.BufferGeometry && !geometry.userData.shared) geometry.dispose();
    const own = 'material' in child ? child.material : null;
    const mats = own ? (Array.isArray(own) ? own : [own]) : [];
    for (const m of mats) {
      if (!(m instanceof THREE.Material)) continue;
      const map = 'map' in m ? m.map : null;
      if (map instanceof THREE.Texture && map !== _dotTex) map.dispose();
      m.dispose();
    }
  });
  obj.parent?.remove(obj);
}


// ---------------------------------------------------------------------------
// Coupling arcs
// ---------------------------------------------------------------------------

/** One drawn import relation: `from` is the importer. */
export interface Arc {
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** 0..1, drives brightness + tube radius. */
  strength: number;
}

/** The shared arc shape — importer to imported, bowed over the city. */
export function arcCurve(from: THREE.Vector3, to: THREE.Vector3): THREE.QuadraticBezierCurve3 {
  const dist = from.distanceTo(to);
  const mid = from.clone().add(to).multiplyScalar(0.5);
  mid.y += Math.min(28 + dist * 0.32, 220);
  return new THREE.QuadraticBezierCurve3(from.clone(), mid, to.clone());
}

/** @returns one merged additive mesh. */
export function buildCouplingArcs(arcs: Arc[], opts: { thick?: boolean; scale?: number } = {}): THREE.Mesh | null {
  if (!arcs.length) return null;
  const thick = !!opts.thick;

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  let vertexOffset = 0;

  const color = new THREE.Color();
  const shade = new THREE.Color();
  const cyan = new THREE.Color(PALETTE.cyan);
  const violet = new THREE.Color(0xa78bfa);

  for (const arc of arcs) {
    const curve = arcCurve(arc.from, arc.to);

    const s = Math.min(Math.max(arc.strength, 0), 1);
    const k = opts.scale ?? 1;
    const radius = ((thick ? 1.1 : 0.35) + s * (thick ? 2.6 : 1.05)) * k;
    const segs = thick ? 40 : 26;
    const tube = new THREE.TubeGeometry(curve, segs, radius, thick ? 8 : 5, false);

    // Keep the additive peak below full white so overlaps still read as cyan.
    // The tube is additive and double-sided, so every pixel gets two passes —
    // keep the peak well under white or overlaps blow out.
    color.copy(cyan).lerp(violet, 1 - s).multiplyScalar(thick ? 0.14 + s * 0.3 : 0.22 + s * 0.6);

    const pos = tube.attributes.position;
    const nrm = tube.attributes.normal;
    const idx = tube.index;
    if (!pos || !nrm || !idx) { tube.dispose(); continue; }
    // Tube vertices run in curve order, so a per-ring ramp reads as direction:
    // dim at the importer, bright at the imported end.
    const ring = (thick ? 8 : 5) + 1;
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      const along = Math.min(Math.floor(i / ring) / segs, 1);
      shade.copy(color).multiplyScalar(0.35 + 0.95 * along);
      colors.push(shade.r, shade.g, shade.b);
    }
    for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + vertexOffset);
    vertexOffset += pos.count;
    tube.dispose();
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(indices);

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: thick ? 0.85 : 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'couplingArcs';
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  return mesh;
}

export interface ArcFlow {
  points: THREE.Points;
  update: (t: number) => void;
}

/**
 * Pulses that travel importer → imported along the same curves, so direction is
 * readable at a glance. One THREE.Points draw call; positions are lerped from a
 * precomputed sample table, so `update()` allocates nothing.
 */
export function buildArcFlow(arcs: Arc[], opts: { thick?: boolean } = {}): ArcFlow | null {
  if (!arcs.length) return null;
  const SAMPLES = 24;
  const perArc = arcs.length > 60 ? 1 : 2;
  const count = arcs.length * perArc;

  const table = new Float32Array(arcs.length * (SAMPLES + 1) * 3);
  const sizes = new Float32Array(count);
  const offsets = new Float32Array(count);
  const speeds = new Float32Array(count);
  const arcOf = new Uint16Array(count);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  const p = new THREE.Vector3();
  const c = new THREE.Color();
  let k = 0;
  for (let a = 0; a < arcs.length; a++) {
    const arc = arcs[a];
    if (!arc) continue;
    const curve = arcCurve(arc.from, arc.to);
    const base = a * (SAMPLES + 1) * 3;
    for (let s = 0; s <= SAMPLES; s++) {
      curve.getPoint(s / SAMPLES, p);
      table[base + s * 3] = p.x;
      table[base + s * 3 + 1] = p.y;
      table[base + s * 3 + 2] = p.z;
    }
    const strength = Math.min(Math.max(arc.strength, 0), 1);
    for (let j = 0; j < perArc; j++, k++) {
      arcOf[k] = a;
      offsets[k] = (j / perArc + (a % 7) / 7) % 1;
      speeds[k] = 0.16 + strength * 0.2;
      sizes[k] = (opts.thick ? 5 : 3) + strength * 4;
      c.setHex(PALETTE.cyan).lerp(new THREE.Color(0xffffff), strength * 0.4);
      colors[k * 3] = c.r;
      colors[k * 3 + 1] = c.g;
      colors[k * 3 + 2] = c.b;
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.setAttribute('psize', new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.PointsMaterial({
    size: 6,
    map: dotTexture(),
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: false,
  });
  // Per-point size without a custom material: scale gl_PointSize by an attribute.
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute float psize;\n' + shader.vertexShader.replace(
      'gl_PointSize = size;',
      'gl_PointSize = size * psize;'
    );
  };
  mat.size = 1;

  const points = new THREE.Points(geom, mat);
  points.name = 'arcFlow';
  points.frustumCulled = false;
  points.renderOrder = 8;

  const attr = geom.attributes.position;
  return {
    points,
    update(t) {
      for (let i = 0; i < count; i++) {
        const f = ((offsets[i] ?? 0) + t * (speeds[i] ?? 0)) % 1;
        const a = arcOf[i] ?? 0;
        const base = a * (SAMPLES + 1) * 3;
        const x = f * SAMPLES;
        const s0 = Math.min(Math.floor(x), SAMPLES - 1);
        const frac = x - s0;
        const i0 = base + s0 * 3;
        const i1 = i0 + 3;
        positions[i * 3] = lerpAt(table, i0, i1, frac);
        positions[i * 3 + 1] = lerpAt(table, i0 + 1, i1 + 1, frac);
        positions[i * 3 + 2] = lerpAt(table, i0 + 2, i1 + 2, frac);
      }
      if (attr) attr.needsUpdate = true;
    },
  };
}

function lerpAt(table: Float32Array, i0: number, i1: number, frac: number): number {
  const a = table[i0] ?? 0;
  const b = table[i1] ?? 0;
  return a + (b - a) * frac;
}

let _dotTex: THREE.CanvasTexture | null = null;
function dotTexture(): THREE.CanvasTexture {
  if (_dotTex) return _dotTex;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = ctx2d(canvas);
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  _dotTex = new THREE.CanvasTexture(canvas);
  return _dotTex;
}

// ---------------------------------------------------------------------------
// People / PR layer
// ---------------------------------------------------------------------------

const AVATAR_PX = 160;

/**
 * Avatar sprite + light beam for one PR, with a thin light-line and glowing
 * ring on every file the PR touches so the connection is unmistakable.
 *
 * @param pr
 * @param anchor  centroid of touched files (ground level)
 * @param opts.weight 0..1 magnitude (log-scaled additions+deletions) driving beam size
 * @returns group whose userData drives animation + hover highlight
 */
export function buildPrMarker(
  pr: Pr,
  anchor: THREE.Vector3,
  opts: { hover?: number; weight?: number; targets?: THREE.Vector3[] } = {}
): THREE.Group {
  const hover = opts.hover ?? 58;
  const weight = Math.min(Math.max(opts.weight ?? 0.35, 0), 1);
  const targets = opts.targets || [];
  const group = new THREE.Group();
  group.name = `pr:${pr.number}`;

  const accent = pr.isDraft ? PALETTE.orange : PALETTE.cyan;

  // --- light beam (radius + glow scale with the PR's size)
  // Drafts render extra transparent — work under construction, not landed.
  const draftFade = pr.isDraft ? 0.4 : 1;
  const beamH = hover;
  const rTop = 0.8 + weight * 4.5;
  const beamGeom = new THREE.CylinderGeometry(rTop, rTop * 2.6, beamH, 12, 1, true);
  beamGeom.translate(0, beamH / 2, 0);
  // Vertex-color fade (bright under the avatar, dissolving toward the ground)
  // so the cone reads as volumetric light instead of a solid glowing shell.
  const bpos = beamGeom.getAttribute('position');
  if (bpos instanceof THREE.BufferAttribute) {
    const bcols = new Float32Array(bpos.count * 3);
    for (let i = 0; i < bpos.count; i++) {
      const f = bpos.getY(i) / beamH; // 1 at the avatar, 0 at the ground
      const v = 0.08 + 0.92 * f * f;
      bcols[i * 3] = v;
      bcols[i * 3 + 1] = v;
      bcols[i * 3 + 2] = v;
    }
    beamGeom.setAttribute('color', new THREE.BufferAttribute(bcols, 3));
  }
  const beamMat = new THREE.MeshBasicMaterial({
    color: accent,
    vertexColors: true,
    transparent: true,
    opacity: (0.12 + weight * 0.22) * draftFade,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // Far wall only: double-sided additive doubles the brightness and reads solid.
    side: THREE.BackSide,
  });
  beamMat.userData.base = beamMat.opacity;
  beamMat.userData.hover = 0.42 * draftFade;
  const beam = new THREE.Mesh(beamGeom, beamMat);
  beam.position.set(anchor.x, anchor.y, anchor.z);
  beam.frustumCulled = false;
  group.add(beam);

  // --- ground pad ring at the centroid
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(3.2 + weight * 2, 4.6 + weight * 3.4, 32),
    new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.5 * draftFade,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(anchor.x, anchor.y + 0.4, anchor.z);
  group.add(ring);

  // --- light-lines from the avatar down to each touched file + a ring on each
  const capped = targets.slice(0, 20);
  let links: THREE.LineSegments | null = null;
  let rings: THREE.Mesh | null = null;
  if (capped.length) {
    const top = new THREE.Vector3(anchor.x, anchor.y + beamH, anchor.z);
    const lp: number[] = [];
    for (const t of capped) lp.push(top.x, top.y, top.z, t.x, t.y + 0.6, t.z);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    links = new THREE.LineSegments(
      lg,
      new THREE.LineBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.2 * draftFade,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    links.frustumCulled = false;
    links.renderOrder = 7;
    group.add(links);

    rings = new THREE.Mesh(
      ringsGeometry(capped, 1.6, 2.9),
      new THREE.MeshBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    rings.frustumCulled = false;
    rings.renderOrder = 7;
    group.add(rings);
  }

  // --- avatar sprite (initials first, swapped in if the image loads)
  const mat = new THREE.SpriteMaterial({
    map: initialsTexture(pr.author, accent),
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(16, 16, 1);
  sprite.position.set(anchor.x, anchor.y + beamH, anchor.z);
  sprite.renderOrder = 12;
  sprite.userData.pr = pr;
  sprite.userData.pickType = 'pr';
  group.add(sprite);

  loadFirstAvatar(avatarCandidates(pr), accent).then((tex) => {
    if (!tex) return; // no CORS-clean image -> keep the initials disc
    const old = mat.map;
    mat.map = tex;
    mat.needsUpdate = true;
    if (old) old.dispose();
  });

  group.userData = {
    pr,
    sprite,
    beam,
    links,
    rings,
    linkBase: 0.2 * draftFade,
    ringBase: 0.35 * draftFade,
    baseY: anchor.y + beamH,
    phase: (pr.number % 100) * 0.37,
  };
  return group;
}

/** One merged flat ring per point, lying on the XZ plane. */
function ringsGeometry(points: THREE.Vector3[], inner: number, outer: number, segments = 20): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const p of points) {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const y = p.y + 0.5;
      const x0i = p.x + Math.cos(a0) * inner, z0i = p.z + Math.sin(a0) * inner;
      const x1i = p.x + Math.cos(a1) * inner, z1i = p.z + Math.sin(a1) * inner;
      const x0o = p.x + Math.cos(a0) * outer, z0o = p.z + Math.sin(a0) * outer;
      const x1o = p.x + Math.cos(a1) * outer, z1o = p.z + Math.sin(a1) * outer;
      positions.push(x0i, y, z0i, x0o, y, z0o, x1o, y, z1o);
      positions.push(x0i, y, z0i, x1o, y, z1o, x1i, y, z1i);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return g;
}

/**
 * `https://github.com/<login>.png` 302s to the avatars CDN and the redirect hop
 * carries no CORS header, so the image can never become a WebGL texture. Prefer
 * the CDN host directly (which does send `access-control-allow-origin: *`).
 */
function avatarCandidates(pr: Pr): string[] {
  const raw = pr.avatarUrl;
  if (!raw) return []; // no avatar in the data -> initials disc
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\.png/i.exec(raw);
  const login = m?.[1];
  if (login) return [`https://avatars.githubusercontent.com/${encodeURIComponent(login)}?size=160`];
  return [raw];
}

async function loadFirstAvatar(urls: string[], accentHex: number): Promise<THREE.CanvasTexture | null> {
  for (const url of urls) {
    const tex = await loadAvatarTexture(url, accentHex);
    if (tex) return tex;
  }
  return null;
}

function initialsTexture(login: string, accentHex: number): THREE.CanvasTexture {
  const name = String(login || '?');
  const initials = name
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase() || '?';

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_PX;
  const ctx = ctx2d(canvas);
  const r = AVATAR_PX / 2;
  const accent = '#' + accentHex.toString(16).padStart(6, '0');

  const grad = ctx.createLinearGradient(0, 0, 0, AVATAR_PX);
  grad.addColorStop(0, '#123049');
  grad.addColorStop(1, '#07101d');
  ctx.beginPath();
  ctx.arc(r, r, r - 6, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.lineWidth = 6;
  ctx.strokeStyle = accent;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 16;
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#dffaff';
  ctx.font = '700 62px "SFMono-Regular", Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials, r, r + 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function loadAvatarTexture(url: string, accentHex: number): Promise<THREE.CanvasTexture | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = AVATAR_PX;
        const ctx = ctx2d(canvas);
        const r = AVATAR_PX / 2;
        ctx.save();
        ctx.beginPath();
        ctx.arc(r, r, r - 6, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, 0, 0, AVATAR_PX, AVATAR_PX);
        ctx.restore();

        // cool-tint the photo so it sits inside the hologram palette
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = 'rgba(24, 92, 140, 0.28)';
        ctx.beginPath();
        ctx.arc(r, r, r - 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        const accent = '#' + accentHex.toString(16).padStart(6, '0');
        ctx.lineWidth = 6;
        ctx.strokeStyle = accent;
        ctx.shadowColor = accent;
        ctx.shadowBlur = 16;
        ctx.beginPath();
        ctx.arc(r, r, r - 6, 0, Math.PI * 2);
        ctx.stroke();

        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        resolve(tex);
      } catch {
        resolve(null); // tainted canvas etc. -> keep initials
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Orange wireframe scaffolding around each affected file plate (draft PRs).
 * @returns material opacity is pulsed by main.ts
 */
export function buildScaffolding(fileNodes: VNode[], color: number = PALETTE.orange): THREE.LineSegments | null {
  const positions: number[] = [];
  for (const n of fileNodes) {
    if (!n.rect) continue;
    const r = n.rect;
    const grow = 2.2;
    const x0 = r.x - grow;
    const x1 = r.x + r.w + grow;
    const z0 = r.z - grow;
    const z1 = r.z + r.h + grow;
    const tier = n.tier ?? n.depth ?? 0;
    // Each node is caged from its own plate: a nested tier's lift is not height.
    const y0 = plateTop(tier, true) - plateThickness(tier, true) - 1;
    const y1 = y0 + Math.max(tallestBuilding(n) + 6, 14);

    const c: Array<[number, number]> = [
      [x0, z0], [x1, z0], [x1, z1], [x0, z1],
    ];
    for (let i = 0; i < 4; i++) {
      const a = c[i];
      const b = c[(i + 1) % 4];
      if (!a || !b) continue;
      const [ax, az] = a;
      const [bx, bz] = b;
      positions.push(ax, y0, az, bx, y0, bz); // bottom rail
      positions.push(ax, y1, az, bx, y1, bz); // top rail
      positions.push(ax, y0, az, ax, y1, az); // upright
      const my = (y0 + y1) / 2;
      positions.push(ax, my, az, bx, my, bz); // mid rail
    }
  }
  if (!positions.length) return null;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(g, mat);
  lines.name = 'scaffolding';
  lines.frustumCulled = false;
  lines.renderOrder = 7;
  return lines;
}

/** Top of the tallest building on a file's plate, relative to the plate. */
export function tallestBuilding(fileNode: VNode): number {
  let max = 0;
  if (fileNode.plots) {
    for (const p of fileNode.plots) max = Math.max(max, p.height ?? buildingHeight(p.mod.loc));
  }
  return max;
}

// ---------------------------------------------------------------------------
// Selection highlight
// ---------------------------------------------------------------------------

/** Reusable glowing box outline used to mark the selected / hovered node. */
export function makeSelectionBox(color: number = PALETTE.orange): THREE.LineSegments {
  const geom = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const box = new THREE.LineSegments(geom, mat);
  box.renderOrder = 30;
  box.frustumCulled = false;
  box.visible = false;
  return box;
}

/** Position a selection box over a node's footprint. */
export function frameNodeBox(box: THREE.LineSegments, node: VNode | null, height = 10): void {
  if (!node || !node.rect) {
    box.visible = false;
    return;
  }
  const r = node.rect;
  const isFile = node.type === 'file';
  const tier = node.tier ?? node.depth ?? 0;
  const top = plateTop(tier, isFile);
  const h = Math.max(height, 6);
  box.position.set(r.x + r.w / 2, top + h / 2 - PLATE_THICKNESS, r.z + r.h / 2);
  box.scale.set(r.w + 1.5, h, r.h + 1.5);
  box.visible = true;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export function buildEnvironment(size: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'environment';

  const grid = new THREE.GridHelper(size * 3, 72, PALETTE.cyan, 0x0d3b52);
  grid.material.transparent = true;
  grid.material.opacity = 0.18;
  grid.material.blending = THREE.AdditiveBlending;
  grid.material.depthWrite = false;
  grid.position.y = -46;
  group.add(grid);

  const grid2 = new THREE.GridHelper(size * 3, 12, PALETTE.cyan, PALETTE.cyan);
  grid2.material.transparent = true;
  grid2.material.opacity = 0.1;
  grid2.material.blending = THREE.AdditiveBlending;
  grid2.material.depthWrite = false;
  grid2.position.y = -45.8;
  group.add(grid2);

  return group;
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

/** 2d drawing context; the hologram's textures cannot be built without one. */
function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  return ctx;
}
