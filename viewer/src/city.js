/**
 * city.js — geometry builders for the hologram code-city.
 *
 * Everything that touches Three.js geometry lives here; main.js owns state.
 */
import * as THREE from 'three';
import { buildingHeight, plateTop, PLATE_THICKNESS } from './layout.js';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const KIND_COLORS = {
  function: 0x22d3ee,
  class: 0x60a5fa,
  component: 0xf472b6,
  interface: 0xa78bfa,
  type: 0x64748b,
  enum: 0xfbbf24,
  const: 0x475569,
};

export const KIND_ORDER = ['function', 'class', 'component', 'interface', 'type', 'enum', 'const'];

const KIND_OPACITY = {
  function: 0.92,
  class: 0.92,
  component: 0.92,
  interface: 0.45,
  type: 0.92,
  enum: 0.92,
  const: 0.92,
};

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
];

/** Gray -> yellow -> orange -> red ramp. Writes into `target`. */
export function heatColor(t, target) {
  const x = Math.min(Math.max(t, 0), 1);
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [p1, c1] = HEAT_STOPS[i];
    const [p0, c0] = HEAT_STOPS[i - 1];
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

/**
 * Build all static city geometry from a laid-out tree.
 * @returns {{
 *   group: THREE.Group,
 *   buildingMeshes: THREE.InstancedMesh[],
 *   moduleRecords: Array<object>,
 *   filePlates: THREE.InstancedMesh|null,
 *   fileRecords: Array<object>,
 *   folderPlates: THREE.InstancedMesh|null,
 *   folderRecords: Array<object>,
 *   pickables: THREE.Object3D[],
 * }}
 */
export function buildCity(root) {
  const group = new THREE.Group();
  group.name = 'city';

  const folders = [];
  const files = [];
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

  const pickables = [...buildings.meshes];
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

export function walk(node, fn) {
  fn(node);
  if (node.children) for (const c of node.children) walk(c, fn);
}

// --- plates ----------------------------------------------------------------

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

function buildPlates(nodes, isFile) {
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
  const records = [];

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const r = n.rect;
    const top = plateTop(n.depth, isFile);
    pos.set(r.x + r.w / 2, top - PLATE_THICKNESS / 2, r.z + r.h / 2);
    scale.set(r.w, PLATE_THICKNESS, r.h);
    m.compose(pos, q, scale);
    mesh.setMatrixAt(i, m);

    // Deeper folders read slightly brighter so nesting is legible.
    const lift = isFile ? 1 : 1 + Math.min(n.depth, 5) * 0.13;
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

function buildingMaterial(kind) {
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

function buildBuildings(files) {
  // Bucket module plots by kind so each kind gets one InstancedMesh.
  const buckets = new Map();
  for (const kind of KIND_ORDER) buckets.set(kind, []);

  for (const file of files) {
    if (!file.plots) continue;
    for (const plot of file.plots) {
      const kind = buckets.has(plot.mod.kind) ? plot.mod.kind : 'const';
      buckets.get(kind).push({ file, plot });
    }
  }

  const geom = new THREE.BoxGeometry(1, 1, 1);
  geom.translate(0, 0.5, 0); // base sits at y = 0

  const meshes = [];
  const records = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();

  for (const kind of KIND_ORDER) {
    const entries = buckets.get(kind);
    if (!entries.length) continue;

    const mesh = new THREE.InstancedMesh(geom, buildingMaterial(kind), entries.length);
    mesh.name = `buildings:${kind}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = kind === 'interface' ? 2 : 1;
    color.setHex(KIND_COLORS[kind]);

    const meta = new Array(entries.length);
    for (let i = 0; i < entries.length; i++) {
      const { file, plot } = entries[i];
      const h = buildingHeight(plot.mod.loc);
      pos.set(plot.x + plot.w / 2, file.top, plot.z + plot.h / 2);
      scale.set(Math.max(plot.w, 0.25), h, Math.max(plot.h, 0.25));
      m.compose(pos, q, scale);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, color);

      const rec = {
        kind,
        mesh,
        instanceId: i,
        file,
        mod: plot.mod,
        baseColor: color.clone(),
        height: h,
        center: new THREE.Vector3(pos.x, file.top + h / 2, pos.z),
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
function buildOutlines(folders, files) {
  const positions = [];
  const colors = [];
  const c = new THREE.Color();

  const push = (n, isFile) => {
    const r = n.rect;
    const y = plateTop(n.depth, isFile) + 0.02;
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
    const k = isFile ? 0.22 : Math.max(0.5 - n.depth * 0.09, 0.14);
    c.setHex(isFile ? PALETTE.cyan : PALETTE.edge).multiplyScalar(k);
    for (const [px, pz] of corners) {
      positions.push(px, y, pz);
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

/**
 * Canvas-texture text sprite. `worldHeight` is the on-screen cap height in
 * world units. Returns a Sprite whose material opacity main.js animates.
 */
export function makeLabelSprite(text, { color = '#a8f4ff', worldHeight = 12, glow = true } = {}) {
  const label = String(text || '').toUpperCase();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = LABEL_FONT;
  const pad = 26;
  const w = Math.ceil(ctx.measureText(label).width) + pad * 2;
  const h = 96;
  canvas.width = Math.max(w, 8);
  canvas.height = h;

  const c2 = canvas.getContext('2d');
  c2.font = LABEL_FONT;
  c2.textAlign = 'center';
  c2.textBaseline = 'middle';
  if (glow) {
    c2.shadowColor = color;
    c2.shadowBlur = 22;
  }
  c2.fillStyle = color;
  c2.fillText(label, canvas.width / 2, h / 2);
  c2.shadowBlur = 0;
  c2.fillText(label, canvas.width / 2, h / 2);

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
    blending: THREE.AdditiveBlending,
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

/** Labels for folders at depth <= maxDepth. Returns a Group. */
export function buildStaticLabels(root, maxDepth = 2) {
  const group = new THREE.Group();
  group.name = 'labels:static';
  walk(root, (node) => {
    if (!node.rect || node.type === 'file') return;
    if (node.depth === 0 || node.depth > maxDepth) return;
    const s = labelForNode(node);
    if (s) group.add(s);
  });
  return group;
}

export function labelForNode(node) {
  if (!node.rect) return null;
  const r = node.rect;
  const size = Math.min(r.w, r.h);
  if (size < 6) return null;
  const worldHeight = Math.min(Math.max(size * 0.15, 3.5), 40);
  const sprite = makeLabelSprite(node.name, {
    color: node.type === 'file' ? '#7fd8ea' : '#bdf3ff',
    worldHeight,
  });
  const lift = node.type === 'file' ? 6 : 10 + node.depth * 0.5;
  sprite.position.set(r.x + r.w / 2, plateTop(node.depth, node.type === 'file') + lift, r.z + r.h / 2);
  sprite.userData.node = node;
  return sprite;
}

export function disposeGroup(group) {
  const kids = [...group.children];
  for (const child of kids) {
    group.remove(child);
    if (child.userData.dispose) child.userData.dispose();
    else {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const mm of mats) {
          if (mm.map) mm.map.dispose();
          mm.dispose();
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Coupling arcs
// ---------------------------------------------------------------------------

/**
 * @param {Array<{from:THREE.Vector3, to:THREE.Vector3, strength:number}>} arcs
 *        strength in 0..1 (drives brightness + tube radius)
 * @param {{thick?:boolean}} [opts]
 * @returns {THREE.Mesh|null} one merged additive mesh
 */
export function buildCouplingArcs(arcs, opts = {}) {
  if (!arcs.length) return null;
  const thick = !!opts.thick;

  const positions = [];
  const colors = [];
  const indices = [];
  const normals = [];
  let vertexOffset = 0;

  const mid = new THREE.Vector3();
  const color = new THREE.Color();
  const cyan = new THREE.Color(PALETTE.cyan);
  const violet = new THREE.Color(0xa78bfa);

  for (const arc of arcs) {
    const dist = arc.from.distanceTo(arc.to);
    mid.copy(arc.from).add(arc.to).multiplyScalar(0.5);
    mid.y += Math.min(28 + dist * 0.32, 220);
    const curve = new THREE.QuadraticBezierCurve3(arc.from.clone(), mid.clone(), arc.to.clone());

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
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      colors.push(color.r, color.g, color.b);
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

// ---------------------------------------------------------------------------
// People / PR layer
// ---------------------------------------------------------------------------

const AVATAR_PX = 160;

/**
 * Avatar sprite + light beam for one PR.
 * @param {{number:number,title:string,author:string,avatarUrl:string|null,isDraft:boolean}} pr
 * @param {THREE.Vector3} anchor  centroid of touched files (ground level)
 * @returns {THREE.Group} group with userData.bob for animation
 */
export function buildPrMarker(pr, anchor, opts = {}) {
  const hover = opts.hover ?? 58;
  const group = new THREE.Group();
  group.name = `pr:${pr.number}`;

  const accent = pr.isDraft ? PALETTE.orange : PALETTE.cyan;

  // --- light beam
  const beamH = hover;
  const beamGeom = new THREE.CylinderGeometry(1.1, 3.4, beamH, 10, 1, true);
  beamGeom.translate(0, beamH / 2, 0);
  const beamMat = new THREE.MeshBasicMaterial({
    color: accent,
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(beamGeom, beamMat);
  beam.position.set(anchor.x, anchor.y, anchor.z);
  beam.frustumCulled = false;
  group.add(beam);

  // --- ground pad ring
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(3.2, 4.6, 32),
    new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(anchor.x, anchor.y + 0.4, anchor.z);
  group.add(ring);

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
    baseY: anchor.y + beamH,
    phase: (pr.number % 100) * 0.37,
  };
  return group;
}

/**
 * `https://github.com/<login>.png` 302s to the avatars CDN and the redirect hop
 * carries no CORS header, so the image can never become a WebGL texture. Prefer
 * the CDN host directly (which does send `access-control-allow-origin: *`).
 */
function avatarCandidates(pr) {
  const raw = pr.avatarUrl;
  if (!raw) return []; // no avatar in the data -> initials disc
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\.png/i.exec(raw);
  if (m) return [`https://avatars.githubusercontent.com/${encodeURIComponent(m[1])}?size=160`];
  return [raw];
}

async function loadFirstAvatar(urls, accentHex) {
  for (const url of urls) {
    const tex = await loadAvatarTexture(url, accentHex);
    if (tex) return tex;
  }
  return null;
}

function initialsTexture(login, accentHex) {
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
  const ctx = canvas.getContext('2d');
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

function loadAvatarTexture(url, accentHex) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = AVATAR_PX;
        const ctx = canvas.getContext('2d');
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
 * @param {Array<object>} fileNodes
 * @returns {THREE.LineSegments|null} material opacity is pulsed by main.js
 */
export function buildScaffolding(fileNodes, color = PALETTE.orange) {
  const positions = [];
  for (const n of fileNodes) {
    if (!n.rect) continue;
    const r = n.rect;
    const grow = 2.2;
    const x0 = r.x - grow;
    const x1 = r.x + r.w + grow;
    const z0 = r.z - grow;
    const z1 = r.z + r.h + grow;
    const y0 = plateTop(n.depth, true) - PLATE_THICKNESS - 1;
    const y1 = y0 + Math.max(tallestBuilding(n) + 6, 14);

    const c = [
      [x0, z0], [x1, z0], [x1, z1], [x0, z1],
    ];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = c[i];
      const [bx, bz] = c[(i + 1) % 4];
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

function tallestBuilding(fileNode) {
  let max = 0;
  if (fileNode.plots) {
    for (const p of fileNode.plots) max = Math.max(max, buildingHeight(p.mod.loc));
  }
  return max;
}

// ---------------------------------------------------------------------------
// Selection highlight
// ---------------------------------------------------------------------------

/** Reusable glowing box outline used to mark the selected / hovered node. */
export function makeSelectionBox(color = PALETTE.orange) {
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
export function frameNodeBox(box, node, height = 10) {
  if (!node || !node.rect) {
    box.visible = false;
    return;
  }
  const r = node.rect;
  const isFile = node.type === 'file';
  const top = plateTop(node.depth, isFile);
  const h = Math.max(height, 6);
  box.position.set(r.x + r.w / 2, top + h / 2 - PLATE_THICKNESS, r.z + r.h / 2);
  box.scale.set(r.w + 1.5, h, r.h + 1.5);
  box.visible = true;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export function buildEnvironment(size) {
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
