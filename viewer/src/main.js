/**
 * main.js — scene wiring, data loading, interaction, overlay modes.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { layoutCity, plateTop, buildingHeight } from './layout.js';
import {
  buildCity, buildEnvironment, buildStaticLabels, labelForNode, disposeGroup,
  buildCouplingArcs, buildPrMarker, buildScaffolding, makeSelectionBox, frameNodeBox,
  heatColor, walk, KIND_COLORS, KIND_ORDER, PALETTE,
} from './city.js';

const MAX_ARCS = 150;
/** World extent of the root plate, scaled so buildings keep a city-like ratio. */
function cityExtent(fileCount) {
  return Math.min(Math.max(Math.sqrt(fileCount) * 15, 260), 900);
}
let CITY_SIZE = 900;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  data: null,
  root: null,
  mode: 'recent',
  coupling: false,
  people: true,
  fx: true,
  selected: null,
  focused: null,
  hover: null,
  usingFake: false,
};

const dom = {
  scene: document.getElementById('scene'),
  boot: document.getElementById('boot'),
  notice: document.getElementById('notice'),
  tooltip: document.getElementById('tooltip'),
  breadcrumb: document.getElementById('breadcrumb'),
  repoName: document.getElementById('repo-name'),
  statFiles: document.getElementById('stat-files'),
  statModules: document.getElementById('stat-modules'),
  statLoc: document.getElementById('stat-loc'),
  statFps: document.getElementById('stat-fps'),
  legend: document.getElementById('legend-body'),
  modes: document.getElementById('modes'),
  toggles: document.getElementById('toggles'),
};

// Index structures (built once)
const index = {
  filesByPath: new Map(),
  nodesByPath: new Map(),
  prsByFile: new Map(),   // path -> PR[]
  prsByNode: new Map(),   // node -> PR[]  (aggregated)
  groupMaps: new Map(), // folder node -> Map(file path -> that folder's child containing it)
  max: { churn: 1, fixChurn: 1, recentChurn: 1 },
};

// Three.js objects
let renderer, scene, camera, controls, composer, bloom;
let city, envGroup, staticLabels, dynamicLabels, peopleGroup, scaffoldGroup;
let arcMesh = null;
let selectionBox, hoverBox;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const pointerPx = new THREE.Vector2();
let pointerDirty = false;
let pointerInside = false;
let pickables = [];

// Scratch objects — never allocate inside the render loop.
const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();
const _dim = new THREE.Color();

const flight = { active: false, t: 0, dur: 1.1, fromPos: new THREE.Vector3(), toPos: new THREE.Vector3(), fromTarget: new THREE.Vector3(), toTarget: new THREE.Vector3() };

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(err);
  showNotice('FATAL: ' + err.message);
  dom.boot.classList.add('hide');
});

async function main() {
  const data = await loadData();
  state.data = data;
  state.root = data.tree;

  normalizeTree(state.root);
  buildIndex(data);
  CITY_SIZE = cityExtent(index.filesByPath.size);
  layoutCity(state.root, { size: CITY_SIZE });

  initScene();
  buildScene();
  buildHud();
  bindEvents();

  focusNode(state.root, { instant: true });
  applyOverlay();
  animate();

  requestAnimationFrame(() => dom.boot.classList.add('hide'));
  if (state.usingFake) showNotice('No data.json — showing synthetic demo city');
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadData() {
  try {
    const res = await fetch('./data.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (!json || !json.tree) throw new Error('malformed data.json');
    return json;
  } catch (err) {
    console.warn('[code-city] falling back to synthetic dataset:', err.message);
    state.usingFake = true;
    return makeFakeData();
  }
}

/** Fill in missing fields and recompute folder aggregates bottom-up. */
function normalizeTree(node, parent = null) {
  node.parent = parent;
  node.type = node.type === 'file' ? 'file' : 'folder';
  node.name = node.name ?? '(unnamed)';
  node.path = node.path ?? node.name;

  if (node.type === 'file') {
    node.modules = Array.isArray(node.modules) ? node.modules : [];
    for (const m of node.modules) {
      m.kind = KIND_ORDER.includes(m.kind) ? m.kind : 'const';
      m.loc = Math.max(Number(m.loc) || 1, 1);
    }
    node.loc = Math.max(Number(node.loc) || node.modules.reduce((s, m) => s + m.loc, 0) || 1, 1);
    node.churn = Number(node.churn) || 0;
    node.fixChurn = Number(node.fixChurn) || 0;
    node.recentChurn = Number(node.recentChurn) || 0;
    return node;
  }

  node.children = Array.isArray(node.children) ? node.children : [];
  let loc = 0, churn = 0, fix = 0, recent = 0;
  for (const c of node.children) {
    normalizeTree(c, node);
    loc += c.loc; churn += c.churn; fix += c.fixChurn; recent += c.recentChurn;
  }
  node.loc = Math.max(loc, 1);
  node.churn = churn;
  node.fixChurn = fix;
  node.recentChurn = recent;
  return node;
}

function buildIndex(data) {
  walk(state.root, (n) => {
    index.nodesByPath.set(n.path, n);
    if (n.type === 'file') {
      index.filesByPath.set(n.path, n);
      index.max.churn = Math.max(index.max.churn, n.churn);
      index.max.fixChurn = Math.max(index.max.fixChurn, n.fixChurn);
      index.max.recentChurn = Math.max(index.max.recentChurn, n.recentChurn);
    }
  });

  // PRs
  data.prs = Array.isArray(data.prs) ? data.prs : [];
  for (const pr of data.prs) {
    pr.files = (pr.files || []).filter((p) => index.filesByPath.has(p));
    for (const p of pr.files) {
      if (!index.prsByFile.has(p)) index.prsByFile.set(p, []);
      index.prsByFile.get(p).push(pr);
    }
  }
  // aggregate PRs upward
  aggregatePrs(state.root);

  data.edges = (Array.isArray(data.edges) ? data.edges : []).filter(
    (e) => e && index.filesByPath.has(e.a) && index.filesByPath.has(e.b) && e.a !== e.b
  );
}

function aggregatePrs(node) {
  if (node.type === 'file') {
    const list = index.prsByFile.get(node.path) || [];
    index.prsByNode.set(node, list);
    return list;
  }
  const set = new Set();
  for (const c of node.children || []) for (const pr of aggregatePrs(c)) set.add(pr);
  const list = [...set];
  index.prsByNode.set(node, list);
  return list;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

function initScene() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(PALETTE.bg, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  dom.scene.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.bg);
  scene.fog = new THREE.FogExp2(PALETTE.bg, 0.00045);

  camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 1, 8000);
  camera.position.set(0, 520, 640);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 12;
  controls.maxDistance = 2600;
  controls.target.set(0, 0, 0);

  // Lighting: low ambient + one key, everything else is emissive.
  scene.add(new THREE.AmbientLight(0x2a4a68, 1.15));
  const key = new THREE.DirectionalLight(0xa9dcff, 0.75);
  key.position.set(320, 640, 260);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x7c4dff, 0.25);
  fill.position.set(-420, 260, -320);
  scene.add(fill);

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.55, // strength
    0.55, // radius
    0.6   // threshold
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.setSize(window.innerWidth, window.innerHeight);
}

function buildScene() {
  envGroup = buildEnvironment(CITY_SIZE);
  scene.add(envGroup);

  city = buildCity(state.root);
  scene.add(city.group);

  staticLabels = buildStaticLabels(state.root, 2);
  scene.add(staticLabels);

  dynamicLabels = new THREE.Group();
  dynamicLabels.name = 'labels:dynamic';
  scene.add(dynamicLabels);

  peopleGroup = new THREE.Group();
  peopleGroup.name = 'people';
  scene.add(peopleGroup);

  scaffoldGroup = new THREE.Group();
  scaffoldGroup.name = 'scaffolding';
  scene.add(scaffoldGroup);

  selectionBox = makeSelectionBox(PALETTE.orange);
  hoverBox = makeSelectionBox(PALETTE.cyan);
  scene.add(selectionBox, hoverBox);

  buildPeopleLayer();
  refreshPickables();

  dom.repoName.textContent = '// ' + (state.data.repo?.name || 'repo');
  dom.statFiles.textContent = fmt(index.filesByPath.size);
  dom.statModules.textContent = fmt(city.moduleRecords.length);
  dom.statLoc.textContent = fmt(state.root.loc);
}

function refreshPickables() {
  pickables = city.pickables.slice();
  if (state.people) {
    for (const g of peopleGroup.children) if (g.userData.sprite) pickables.push(g.userData.sprite);
  }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function buildHud() {
  renderLegend();
  renderBreadcrumb();

  dom.modes.addEventListener('click', (e) => {
    const btn = e.target.closest('button.mode');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    for (const b of dom.modes.querySelectorAll('button.mode')) b.classList.toggle('active', b === btn);
    applyOverlay();
    renderLegend();
  });

  dom.toggles.addEventListener('click', (e) => {
    const btn = e.target.closest('button.toggle');
    if (!btn) return;
    const key = btn.dataset.toggle;
    state[key] = !state[key];
    btn.classList.toggle('active', state[key]);
    if (key === 'coupling') rebuildArcs();
    if (key === 'fx') {
      bloom.enabled = state.fx;
      const crt = document.getElementById('crt');
      if (crt) crt.style.display = state.fx ? 'block' : 'none';
    }
    if (key === 'people') {
      peopleGroup.visible = state.people;
      scaffoldGroup.visible = state.people;
      refreshPickables();
    }
  });
}

function renderLegend() {
  const rows = [];
  if (state.mode === 'structure') {
    for (const kind of KIND_ORDER) {
      rows.push(
        `<div class="row"><i class="sw" style="background:#${KIND_COLORS[kind]
          .toString(16)
          .padStart(6, '0')};box-shadow:0 0 8px #${KIND_COLORS[kind].toString(16).padStart(6, '0')}"></i><span>${kind}</span></div>`
      );
    }
  } else if (state.mode === 'recent') {
    rows.push(
      `<div class="row"><i class="sw" style="background:#4ade80;box-shadow:0 0 8px #4ade80"></i><span>touched &lt; 30d</span></div>`,
      `<div class="row"><i class="sw" style="background:#1b2432"></i><span>dormant</span></div>`
    );
  } else {
    const label = state.mode === 'churn' ? 'commits / 12mo' : 'fix commits / 12mo';
    const max = state.mode === 'churn' ? index.max.churn : index.max.fixChurn;
    rows.push(
      `<div id="ramp"></div>`,
      `<div class="ramp-labels"><span>0</span><span>${label}</span><span>${max}</span></div>`
    );
  }
  dom.legend.innerHTML = rows.join('');
}

function renderBreadcrumb() {
  const chain = [];
  let n = state.focused || state.root;
  while (n) { chain.unshift(n); n = n.parent; }

  const html = [];
  chain.forEach((node, i) => {
    if (i > 0) html.push('<i class="sep">/</i>');
    const label = i === 0 ? (state.data.repo?.name || node.name) : node.name;
    html.push(
      `<a class="crumb ${i === chain.length - 1 ? 'active' : ''}" data-path="${escapeHtml(node.path)}">${escapeHtml(label)}</a>`
    );
  });
  dom.breadcrumb.innerHTML = html.join('');
  dom.breadcrumb.scrollLeft = 1e6;
}

dom.breadcrumb.addEventListener('click', (e) => {
  const el = e.target.closest('.crumb');
  if (!el) return;
  const node = index.nodesByPath.get(el.dataset.path);
  if (node) { selectNode(node); focusNode(node); }
});

function showNotice(msg) {
  dom.notice.textContent = msg;
  dom.notice.style.display = 'block';
  setTimeout(() => { dom.notice.style.display = 'none'; }, 7000);
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

function heatValue(fileNode) {
  if (state.mode === 'churn') return fileNode.churn;
  if (state.mode === 'fix') return fileNode.fixChurn;
  if (state.mode === 'recent') return fileNode.recentChurn;
  return 0;
}

function applyOverlay() {
  const mode = state.mode;
  const maxV =
    mode === 'churn' ? index.max.churn :
    mode === 'fix' ? index.max.fixChurn :
    mode === 'recent' ? index.max.recentChurn : 1;
  const denom = Math.sqrt(Math.max(maxV, 1));
  const green = new THREE.Color(PALETTE.green);

  // Buildings
  for (const rec of city.moduleRecords) {
    if (mode === 'structure') {
      _color.copy(rec.baseColor);
    } else if (mode === 'recent') {
      if (rec.file.recentChurn > 0) _color.copy(green);
      else _color.copy(rec.baseColor).multiplyScalar(0.15);
    } else {
      heatColor(Math.sqrt(Math.max(heatValue(rec.file), 0)) / denom, _color);
    }
    rec.mesh.setColorAt(rec.instanceId, _color);
  }
  for (const mesh of city.buildingMeshes) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  // File plates
  if (city.filePlates) {
    for (const rec of city.fileRecords) {
      if (mode === 'structure') {
        _color.copy(rec.baseColor);
      } else if (mode === 'recent') {
        if (rec.node.recentChurn > 0) _color.copy(green).multiplyScalar(0.28);
        else _color.copy(rec.baseColor).multiplyScalar(0.5);
      } else {
        heatColor(Math.sqrt(Math.max(heatValue(rec.node), 0)) / denom, _color).multiplyScalar(0.42);
      }
      city.filePlates.setColorAt(rec.instanceId, _color);
    }
    if (city.filePlates.instanceColor) city.filePlates.instanceColor.needsUpdate = true;
  }

  // Folder plates dim slightly outside structure mode so heat reads cleanly.
  if (city.folderPlates) {
    for (const rec of city.folderRecords) {
      _dim.copy(rec.baseColor).multiplyScalar(mode === 'structure' ? 1 : 0.7);
      city.folderPlates.setColorAt(rec.instanceId, _dim);
    }
    if (city.folderPlates.instanceColor) city.folderPlates.instanceColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Coupling
// ---------------------------------------------------------------------------

function rebuildArcs() {
  if (arcMesh) {
    scene.remove(arcMesh);
    arcMesh.geometry.dispose();
    arcMesh.material.dispose();
    arcMesh = null;
  }
  if (!state.coupling) return;

  const arcs = state.selected ? arcsForNode(state.selected) : packageArcs();
  if (!arcs.length) return;
  arcMesh = buildCouplingArcs(arcs, { thick: !state.selected, scale: CITY_SIZE / 900 });
  if (arcMesh) scene.add(arcMesh);
}

function arcsForNode(node) {
  const inside = new Set();
  walk(node, (n) => { if (n.type === 'file') inside.add(n.path); });
  if (!inside.size) return [];

  const totals = new Map(); // other file path -> n
  for (const e of state.data.edges) {
    const aIn = inside.has(e.a);
    const bIn = inside.has(e.b);
    if (aIn === bIn) continue;
    const other = aIn ? e.b : e.a;
    totals.set(other, (totals.get(other) || 0) + (Number(e.n) || 1));
  }
  if (!totals.size) return [];

  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ARCS);
  const max = sorted[0][1];
  const from = nodeAnchor(node);

  const out = [];
  for (const [path, n] of sorted) {
    const target = index.filesByPath.get(path);
    if (!target || !target.rect) continue;
    out.push({ from: from.clone(), to: nodeAnchor(target), strength: n / max });
  }
  return out;
}

/**
 * The level at which "package coupling" is drawn: the focused folder, descended
 * past any single-child wrappers (e.g. repo -> packages) so there is something
 * to compare.
 */
function groupingRoot() {
  let n = state.focused || state.root;
  for (let i = 0; i < 8; i++) {
    if (!n || n.type !== 'folder') break;
    const kids = (n.children || []).filter((c) => c.rect);
    if (kids.length !== 1) break;
    n = kids[0];
  }
  return n && n.type === 'folder' ? n : state.root;
}

/** file path -> the child of `parent` that contains it (memoized per parent). */
function groupMapFor(parent) {
  let map = index.groupMaps.get(parent);
  if (map) return map;
  map = new Map();
  for (const child of parent.children || []) {
    if (!child.rect) continue;
    walk(child, (n) => { if (n.type === 'file') map.set(n.path, child); });
  }
  index.groupMaps.set(parent, map);
  return map;
}

function packageArcs() {
  const parent = groupingRoot();
  const tops = (parent.children || []).filter((c) => c.rect);
  if (tops.length < 2) return [];
  const groupOf = groupMapFor(parent);
  const totals = new Map();
  for (const e of state.data.edges) {
    const ta = groupOf.get(e.a);
    const tb = groupOf.get(e.b);
    if (!ta || !tb || ta === tb || !ta.rect || !tb.rect) continue;
    const key = ta.path < tb.path ? ta.path + '|' + tb.path : tb.path + '|' + ta.path;
    const prev = totals.get(key);
    if (prev) prev.n += Number(e.n) || 1;
    else totals.set(key, { a: ta, b: tb, n: Number(e.n) || 1 });
  }
  const list = [...totals.values()].sort((x, y) => y.n - x.n).slice(0, MAX_ARCS);
  if (!list.length) return [];
  const max = list[0].n;
  return list.map((x) => ({ from: nodeAnchor(x.a), to: nodeAnchor(x.b), strength: x.n / max }));
}

function nodeAnchor(node) {
  const r = node.rect;
  const y = plateTop(node.depth, node.type === 'file') + (node.type === 'file' ? 4 : 2);
  return new THREE.Vector3(r.x + r.w / 2, y, r.z + r.h / 2);
}

// ---------------------------------------------------------------------------
// People / PR layer
// ---------------------------------------------------------------------------

function buildPeopleLayer() {
  const prs = state.data.prs || [];
  const draftFiles = [];

  for (const pr of prs) {
    const nodes = pr.files.map((p) => index.filesByPath.get(p)).filter((n) => n && n.rect);
    if (!nodes.length) continue;

    let cx = 0, cz = 0, top = 0;
    for (const n of nodes) {
      cx += n.rect.x + n.rect.w / 2;
      cz += n.rect.z + n.rect.h / 2;
      top = Math.max(top, plateTop(n.depth, true) + tallest(n));
    }
    const anchor = new THREE.Vector3(cx / nodes.length, top + 4, cz / nodes.length);
    const marker = buildPrMarker(pr, anchor, { hover: 54 + (pr.number % 5) * 6 });
    marker.userData.nodes = nodes;
    peopleGroup.add(marker);

    if (pr.isDraft) draftFiles.push(...nodes);
  }

  const scaffold = buildScaffolding(draftFiles);
  if (scaffold) { scaffold.userData.pulseRate = 2.4; scaffoldGroup.add(scaffold); }

  // PR collisions: files touched by 2+ open PRs — likely merge conflicts.
  const collisionFiles = [];
  for (const [p, list] of index.prsByFile) {
    if (list.length < 2) continue;
    const n = index.filesByPath.get(p);
    if (n && n.rect) collisionFiles.push(n);
  }
  const collide = buildScaffolding(collisionFiles, 0xef4444);
  if (collide) { collide.userData.pulseRate = 5.2; scaffoldGroup.add(collide); }

  peopleGroup.visible = state.people;
  scaffoldGroup.visible = state.people;
}

function tallest(fileNode) {
  let m = 0;
  for (const p of fileNode.plots || []) m = Math.max(m, buildingHeight(p.mod.loc));
  return m;
}

// ---------------------------------------------------------------------------
// Selection / focus
// ---------------------------------------------------------------------------

function selectNode(node) {
  state.selected = node && node.rect ? node : null;
  if (state.selected) {
    frameNodeBox(selectionBox, state.selected, boxHeightFor(state.selected));
  } else {
    selectionBox.visible = false;
  }
  rebuildArcs();
}

function boxHeightFor(node) {
  if (node.type === 'file') return Math.max(tallest(node) + 4, 10);
  return Math.max(Math.min(node.rect.w, node.rect.h) * 0.28, 18);
}

function focusNode(node, opts = {}) {
  if (!node || !node.rect) return;
  state.focused = node;
  renderBreadcrumb();
  rebuildDynamicLabels(node);
  // Package-coupling is drawn relative to the focused folder.
  if (state.coupling && !state.selected) rebuildArcs();
  flyTo(node, opts.instant);
}

function rebuildDynamicLabels(node) {
  disposeGroup(dynamicLabels);
  const kids = node.type === 'folder' ? node.children || [] : [];
  let added = 0;
  for (const child of kids) {
    if (added > 140) break;
    const s = labelForNode(child);
    if (!s) continue;
    dynamicLabels.add(s);
    added++;
  }
}

function flyTo(node, instant) {
  const r = node.rect;
  const target = new THREE.Vector3(r.x + r.w / 2, plateTop(node.depth, node.type === 'file'), r.z + r.h / 2);
  const extent = Math.max(r.w, r.h, 12);
  // Fit the rect to the tighter of the two viewport axes.
  const vFov = (camera.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const fit = Math.min(Math.tan(vFov / 2), Math.tan(hFov / 2));
  const dist = (extent / 2) / fit * 1.05 + 18;

  _v3.copy(camera.position).sub(controls.target);
  if (_v3.lengthSq() < 1e-6) _v3.set(0.4, 0.8, 0.9);
  _v3.normalize();
  if (_v3.y < 0.42) { _v3.y = 0.42; _v3.normalize(); }
  const pos = target.clone().addScaledVector(_v3, dist);

  if (instant) {
    camera.position.copy(pos);
    controls.target.copy(target);
    controls.update();
    flight.active = false;
    return;
  }
  flight.fromPos.copy(camera.position);
  flight.toPos.copy(pos);
  flight.fromTarget.copy(controls.target);
  flight.toTarget.copy(target);
  flight.t = 0;
  flight.dur = 1.0;
  flight.active = true;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function bindEvents() {
  const el = renderer.domElement;

  el.addEventListener('pointermove', (e) => {
    pointerPx.set(e.clientX, e.clientY);
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    pointerDirty = true;
    pointerInside = true;
  });
  el.addEventListener('pointerleave', () => {
    pointerInside = false;
    pointerDirty = true;
  });

  let downAt = null;
  el.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
  el.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 4) return; // it was an orbit drag
    const hit = state.hover;
    if (!hit) { selectNode(null); return; }
    if (hit.type === 'pr') return;
    selectNode(hit.node);
  });

  el.addEventListener('dblclick', () => {
    const hit = state.hover;
    if (!hit || hit.type === 'pr') return;
    selectNode(hit.node);
    focusNode(hit.node);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const up = (state.focused && state.focused.parent) || state.root;
      selectNode(up === state.root ? null : up);
      focusNode(up);
    }
    if (e.key === 'c' && !e.metaKey && !e.ctrlKey) {
      const node = state.selected || state.focused;
      if (!node || !node.path) return;
      navigator.clipboard?.writeText(node.path).then(
        () => showNotice('Path copied: ' + node.path),
        () => showNotice('Clipboard unavailable')
      );
    }
  });

  window.addEventListener('resize', onResize);
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.setSize(w, h);
}

function updateHover() {
  if (!pointerDirty) return;
  pointerDirty = false;

  if (!pointerInside) {
    setHover(null);
    return;
  }
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pickables, false);
  setHover(hits.length ? resolveHit(hits[0]) : null);
}

function resolveHit(hit) {
  const o = hit.object;
  if (o.userData.meta) {
    const rec = o.userData.meta[hit.instanceId];
    if (rec) return { type: 'module', rec, node: rec.file };
    return null;
  }
  if (o === city.filePlates) {
    const rec = city.fileRecords[hit.instanceId];
    return rec ? { type: 'file', node: rec.node } : null;
  }
  if (o === city.folderPlates) {
    const rec = city.folderRecords[hit.instanceId];
    return rec ? { type: 'folder', node: rec.node } : null;
  }
  if (o.userData.pickType === 'pr') return { type: 'pr', pr: o.userData.pr };
  return null;
}

function setHover(hit) {
  const sameModule =
    hit && state.hover && hit.type === 'module' && state.hover.type === 'module' && hit.rec === state.hover.rec;
  const sameNode =
    hit && state.hover && hit.type === state.hover.type && hit.node && hit.node === state.hover.node;
  const samePr = hit && state.hover && hit.type === 'pr' && hit.pr === state.hover.pr;
  if (sameModule || (sameNode && hit.type !== 'module') || samePr) return;
  if (!hit && !state.hover) return;

  state.hover = hit;
  document.body.style.cursor = hit ? 'pointer' : 'default';

  if (!hit) {
    hoverBox.visible = false;
    dom.tooltip.style.display = 'none';
    return;
  }

  if (hit.type === 'module') {
    hit.rec.mesh.getMatrixAt(hit.rec.instanceId, _m4);
    _m4.decompose(_v3, _q, _scale);
    hoverBox.position.set(_v3.x, _v3.y + _scale.y / 2, _v3.z);
    hoverBox.scale.set(_scale.x + 0.6, _scale.y + 0.6, _scale.z + 0.6);
    hoverBox.visible = true;
  } else if (hit.type === 'pr') {
    hoverBox.visible = false;
  } else {
    frameNodeBox(hoverBox, hit.node, boxHeightFor(hit.node));
  }

  dom.tooltip.innerHTML = tooltipHtml(hit);
  dom.tooltip.style.display = 'block';
}

function tooltipHtml(hit) {
  if (hit.type === 'pr') {
    const pr = hit.pr;
    return `
      <div class="tt-name">#${Number(pr.number) || 0}</div>
      <div class="tt-kind" style="color:${pr.isDraft ? '#fa4616' : '#22d3ee'}">${pr.isDraft ? 'DRAFT PR' : 'OPEN PR'}</div>
      <div class="tt-path">${escapeHtml(pr.title || '')}</div>
      <div class="tt-grid">
        <div><div class="k">AUTHOR</div><div class="v" style="font-size:11px">${escapeHtml(pr.author || '?')}</div></div>
        <div><div class="k">FILES</div><div class="v">${pr.files.length}</div></div>
      </div>`;
  }

  const node = hit.node;
  const kindLabel =
    hit.type === 'module' ? hit.rec.mod.kind :
    node.type === 'file' ? 'file' : `folder · ${(node.children || []).length} children`;
  const kindColor =
    hit.type === 'module' ? '#' + KIND_COLORS[hit.rec.kind].toString(16).padStart(6, '0') : '#22d3ee';
  const name = hit.type === 'module' ? hit.rec.mod.name : node.name;
  const loc = hit.type === 'module' ? hit.rec.mod.loc : node.loc;
  const prs = index.prsByNode.get(node) || [];

  const prHtml = prs.length
    ? `<div class="tt-prs"><div class="h">${prs.length} OPEN PR${prs.length > 1 ? 'S' : ''}</div>` +
      prs.slice(0, 4).map((p) =>
        `<div class="pr"><span class="num">#${Number(p.number) || 0}</span> ${escapeHtml(truncate(p.title || '', 42))} <span class="who">@${escapeHtml(p.author || '?')}</span></div>`
      ).join('') +
      (prs.length > 4 ? `<div class="pr who">+${prs.length - 4} more</div>` : '') +
      `</div>`
    : '';

  return `
    <div class="tt-name">${escapeHtml(name)}</div>
    <div class="tt-kind" style="color:${kindColor}">${escapeHtml(kindLabel)}${hit.type === 'module' && hit.rec.mod.exported ? ' · exported' : ''}</div>
    <div class="tt-path">${escapeHtml(node.path)}</div>
    <div class="tt-grid">
      <div><div class="k">LOC</div><div class="v">${fmt(loc)}</div></div>
      <div><div class="k">CHURN</div><div class="v">${fmt(node.churn)}</div></div>
      <div><div class="k">FIX</div><div class="v">${fmt(node.fixChurn)}</div></div>
      <div><div class="k">RECENT</div><div class="v">${fmt(node.recentChurn)}</div></div>
    </div>
    ${prHtml}`;
}

function positionTooltip() {
  if (dom.tooltip.style.display !== 'block') return;
  const w = dom.tooltip.offsetWidth;
  const h = dom.tooltip.offsetHeight;
  let x = pointerPx.x + 18;
  let y = pointerPx.y + 18;
  if (x + w > window.innerWidth - 12) x = pointerPx.x - w - 18;
  if (y + h > window.innerHeight - 12) y = pointerPx.y - h - 18;
  dom.tooltip.style.left = Math.max(8, x) + 'px';
  dom.tooltip.style.top = Math.max(8, y) + 'px';
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();
let fpsAccum = 0;
let fpsFrames = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;

  if (flight.active) {
    flight.t = Math.min(flight.t + dt / flight.dur, 1);
    const e = easeInOutCubic(flight.t);
    camera.position.lerpVectors(flight.fromPos, flight.toPos, e);
    controls.target.lerpVectors(flight.fromTarget, flight.toTarget, e);
    if (flight.t >= 1) flight.active = false;
  }

  controls.update();
  updateHover();
  positionTooltip();
  updateLabels();
  updatePeople(t);

  for (const c of scaffoldGroup.children) {
    const rate = c.userData.pulseRate || 2.4;
    c.material.opacity = 0.42 + 0.34 * (0.5 + 0.5 * Math.sin(t * rate));
  }
  if (selectionBox.visible) selectionBox.material.opacity = 0.55 + 0.4 * (0.5 + 0.5 * Math.sin(t * 3.2));

  composer.render();

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    dom.statFps.textContent = Math.round(fpsFrames / fpsAccum);
    fpsAccum = 0;
    fpsFrames = 0;
  }
}

function updateLabels() {
  fadeGroup(staticLabels);
  fadeGroup(dynamicLabels);
}

/**
 * Label LOD by apparent (angular) size: too small to read fades out, and
 * anything overwhelming the frame fades out too — so district labels give way
 * to their children as you fly in.
 */
function fadeGroup(group) {
  for (const s of group.children) {
    const d = camera.position.distanceTo(s.position);
    const a = s.scale.y / (d > 1 ? d : 1);
    const o = ramp(a, 0.008, 0.018) * (1 - ramp(a, 0.09, 0.17));
    s.material.opacity = o;
    s.visible = o > 0.02;
  }
}

function ramp(x, a, b) {
  const t = (x - a) / (b - a);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function updatePeople(t) {
  if (!state.people) return;
  for (const g of peopleGroup.children) {
    const u = g.userData;
    if (!u.sprite) continue;
    const bob = Math.sin(t * 0.9 + u.phase) * 3.2;
    u.sprite.position.y = u.baseY + bob;
    u.beam.scale.y = 1 + bob / Math.max(u.baseY, 1);
    u.beam.material.opacity = 0.12 + 0.07 * (0.5 + 0.5 * Math.sin(t * 1.7 + u.phase));
  }
}

function easeInOutCubic(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}
function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// ---------------------------------------------------------------------------
// Deterministic synthetic dataset (used when data.json is missing/invalid)
// ---------------------------------------------------------------------------

function makeFakeData() {
  const rnd = mulberry32(0x5eed1337);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  const packages = ['canvas', 'runtime', 'ui-kit'];
  const subdirs = ['src/core', 'src/model', 'src/render', 'src/hooks', 'src/util'];
  const fileStems = [
    'index', 'graph-store', 'node-view', 'edge-router', 'selection', 'viewport',
    'use-canvas', 'serializer', 'validator', 'theme', 'shortcuts', 'toolbar',
    'panel', 'layout-engine', 'diff', 'telemetry', 'registry', 'schema',
  ];
  const kinds = ['function', 'class', 'component', 'interface', 'type', 'enum', 'const'];

  const root = { type: 'folder', name: 'packages', path: 'packages', children: [] };
  const allFiles = [];
  let made = 0;

  for (const pkg of packages) {
    const pkgNode = { type: 'folder', name: pkg, path: `packages/${pkg}`, children: [] };
    root.children.push(pkgNode);

    const dirs = subdirs.slice(0, int(3, 5));
    for (const dir of dirs) {
      if (made >= 42) break;
      // materialize nested folders (src -> core)
      const parts = dir.split('/');
      let parent = pkgNode;
      for (const part of parts) {
        const path = `${parent.path}/${part}`;
        let found = (parent.children || []).find((c) => c.path === path);
        if (!found) {
          found = { type: 'folder', name: part, path, children: [] };
          parent.children.push(found);
        }
        parent = found;
      }

      const nFiles = int(2, 4);
      for (let i = 0; i < nFiles && made < 42; i++) {
        const stem = fileStems[(made * 7 + i * 3) % fileStems.length];
        const ext = rnd() > 0.65 ? 'tsx' : 'ts';
        const path = `${parent.path}/${stem}.${ext}`;
        if (parent.children.some((c) => c.path === path)) continue;

        const nMods = int(2, 8);
        const modules = [];
        let loc = 0;
        for (let k = 0; k < nMods; k++) {
          const kind = ext === 'tsx' && k === 0 ? 'component' : pick(kinds);
          const mloc = int(6, 220);
          loc += mloc;
          modules.push({
            name: `${stem.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}${k ? k : ''}`,
            kind,
            loc: mloc,
            exported: rnd() > 0.35,
          });
        }
        const churn = int(0, 64);
        const file = {
          type: 'file',
          name: `${stem}.${ext}`,
          path,
          loc,
          churn,
          fixChurn: Math.floor(churn * (rnd() * 0.45)),
          recentChurn: rnd() > 0.68 ? int(1, 9) : 0,
          modules,
        };
        parent.children.push(file);
        allFiles.push(file);
        made++;
      }
    }
  }

  const edges = [];
  const seen = new Set();
  for (let i = 0; i < 90 && allFiles.length > 1; i++) {
    const a = allFiles[Math.floor(rnd() * allFiles.length)];
    const b = allFiles[Math.floor(rnd() * allFiles.length)];
    if (!a || !b || a === b) continue;
    const key = a.path < b.path ? a.path + '|' + b.path : b.path + '|' + a.path;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ a: a.path, b: b.path, n: int(1, 6) });
  }

  const prFilesA = allFiles.filter((_, i) => i % 9 === 1).slice(0, 5).map((f) => f.path);
  const prFilesB = allFiles.filter((_, i) => i % 7 === 3).slice(0, 4).map((f) => f.path);

  return {
    repo: { name: 'demo-repo', root: '/demo', analyzedAt: new Date(0).toISOString(), githubUrl: null },
    tree: root,
    edges,
    prs: [
      {
        number: 3055,
        title: 'Refactor edge routing for nested groups',
        author: 'ada-lovelace',
        avatarUrl: null,
        isDraft: false,
        updatedAt: new Date(0).toISOString(),
        files: prFilesA,
      },
      {
        number: 3061,
        title: 'WIP: virtualize the node layer',
        author: 'grace-hopper',
        avatarUrl: null,
        isDraft: true,
        updatedAt: new Date(0).toISOString(),
        files: prFilesB,
      },
    ],
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
