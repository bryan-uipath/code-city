/**
 * main.js — scene wiring, data loading, focus stack, overlays, interaction.
 *
 * The city is always rendered for ONE focus scope: double-clicking pushes into
 * a node (folder → file → module → member), which disposes the current city and
 * re-lays out that subtree at full extent. Everything else — PR markers, arcs,
 * labels, scaffolding — is rebuilt against the same scope.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { layoutCity, plateTop, buildingHeight } from './layout.js';
import {
  buildCity, buildEnvironment, disposeObject,
  buildCouplingArcs, buildArcFlow, buildPrMarker, buildScaffolding, makeSelectionBox, frameNodeBox,
  heatColor, walk, KIND_COLORS, KIND_ORDER, MEMBER_ORDER, PALETTE,
} from './city.js';
import { createLabeler } from './labels.js';
import { createSidebar, escapeHtml } from './sidebar.js';
import { createTimeline, RECENT_WINDOW, FLASH_WINDOW } from './timeline.js';

const MAX_ARCS = 150;
const DAY = 86400;
/** Scope transition: contents unfold out of (or fold back into) the parent footprint. */
const TRANSITION_DUR = 0.42;
/** Above this many buildings, module labels are limited to the selected file. */
const MODULE_LABEL_BUDGET = 800;

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
  /** Node whose subtree is currently rendered (real folder/file or synthetic module). */
  focus: null,
  /** { node, rec|null } pinned by click. */
  selection: null,
  hover: null,
  timeCursor: null,
  usingFake: false,
};

/** Everything derived from the current focus scope; rebuilt on every transition. */
const scope = {
  root: null,
  fileNodes: [],
  byRealPath: new Map(),
  nodes: new Set(),
};

const dom = {
  scene: document.getElementById('scene'),
  boot: document.getElementById('boot'),
  notice: document.getElementById('notice'),
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

// Index structures (built once, over the real tree)
const index = {
  filesByPath: new Map(),
  nodesByPath: new Map(),
  prsByFile: new Map(),   // path -> PR[]
  prsByNode: new Map(),   // node -> PR[]  (aggregated)
  groupMaps: new Map(),   // folder node -> Map(file path -> that folder's child containing it)
  edgesOut: new Map(),    // path -> [{other, n}]
  edgesIn: new Map(),
  max: { churn: 1, fixChurn: 1, recentChurn: 1 },
};

// Three.js objects
let renderer, scene, camera, controls, composer, bloom;
let city, envGroup, peopleGroup, scaffoldGroup, stage;
let labeler, sidebar, timeline;
let arcMesh = null;
let arcFlow = null;
let selectionBox, hoverBox;
let crumbNodes = [];

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
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
/** Scope transition: the new scene starts mapped onto the old footprint and unfolds. */
const transition = { t: 1, k0: 1, p0: new THREE.Vector3(), mats: [] };
/** Per-scope-file recency, recomputed (throttled) while scrubbing history. */
const recency = { map: new Map(), dirty: false, acc: 0 };

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

  initScene();

  timeline = createTimeline(data, { onChange: onTimeCursor });
  sidebar = createSidebar({ timeline });
  labeler = createLabeler(scene, camera);

  state.focus = state.root;
  buildStaticScene();
  rebuildScene({ instant: true });
  buildHud();
  bindEvents();
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
      if (Array.isArray(m.children)) {
        for (const ch of m.children) {
          ch.kind = MEMBER_ORDER.includes(ch.kind) ? ch.kind : 'member';
          ch.loc = Math.max(Number(ch.loc) || 1, 1);
        }
      }
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

  data.prs = Array.isArray(data.prs) ? data.prs : [];
  for (const pr of data.prs) {
    pr.files = (pr.files || []).filter((p) => index.filesByPath.has(p));
    for (const p of pr.files) {
      if (!index.prsByFile.has(p)) index.prsByFile.set(p, []);
      index.prsByFile.get(p).push(pr);
    }
  }
  aggregatePrs(state.root);

  data.edges = (Array.isArray(data.edges) ? data.edges : []).filter(
    (e) => e && index.filesByPath.has(e.a) && index.filesByPath.has(e.b) && e.a !== e.b
  );
  // Directional adjacency: a imports b.
  for (const e of data.edges) {
    push(index.edgesOut, e.a, { other: e.b, n: Number(e.n) || 1 });
    push(index.edgesIn, e.b, { other: e.a, n: Number(e.n) || 1 });
  }
}

function push(map, key, value) {
  let arr = map.get(key);
  if (!arr) map.set(key, (arr = []));
  arr.push(value);
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
// Focus scopes — synthetic subtrees for file / module drill-down
// ---------------------------------------------------------------------------

/**
 * The layout root for a focus target. Folders are laid out directly; a file
 * becomes a district of its modules, and a module a district of its members
 * (or, with no members, a lone building so it can still be isolated).
 */
function makeScopeRoot(node) {
  if (node.type === 'folder' && !node.synth) return node;
  if (node.synth === 'module') return node;
  if (node.type === 'file' && !node.synth) return fileScope(node);
  return wrapLeaf(node); // synthetic single-module / member leaf
}

function fileScope(file) {
  if (file._scope) return file._scope;
  const root = statsFrom(file, {
    type: 'folder', synth: 'fileScope', name: file.name, path: file.path,
    srcFile: file, parent: file.parent, children: [],
  });
  root.children = file.modules.map((m) => moduleNode(file, m, root));
  // A file with no extractable modules (e.g. pure export lists) still gets one
  // building standing in for the file itself, so the isolate never reads empty.
  if (!root.children.length) {
    const stub = { name: file.name.replace(/\.[^.]+$/, ''), kind: 'const', loc: file.loc, line: 1, exported: true };
    root.children = [moduleNode(file, stub, root)];
  }
  file._scope = root;
  return root;
}

/** The node representing one module of `file` — a district if it has members. */
function moduleNode(file, mod, parent) {
  if (!file._modNodes) file._modNodes = new Map();
  const cached = file._modNodes.get(mod);
  if (cached) {
    cached.parent = parent ?? file;
    return cached;
  }
  const path = `${file.path}#${mod.name}`;
  let node;
  if (Array.isArray(mod.children) && mod.children.length) {
    node = statsFrom(file, {
      type: 'folder', synth: 'module', name: mod.name, path,
      srcFile: file, mod, parent: parent ?? file, children: [],
    });
    node.loc = mod.loc;
    node.children = mod.children.map((ch) =>
      statsFrom(file, {
        type: 'file', synth: 'member', name: ch.name, path: `${path}.${ch.name}`,
        srcFile: file, mod: ch, parent: node, loc: ch.loc, modules: [ch],
      })
    );
  } else {
    node = statsFrom(file, {
      type: 'file', synth: 'leaf', name: mod.name, path,
      srcFile: file, mod, parent: parent ?? file, loc: mod.loc, modules: [mod],
    });
  }
  file._modNodes.set(mod, node);
  return node;
}

/** A single-building scope so a childless module can still be isolated. */
function wrapLeaf(leaf) {
  if (leaf._wrap) return leaf._wrap;
  const wrap = statsFrom(leaf.srcFile || leaf, {
    type: 'folder', synth: 'wrap', name: leaf.name, path: leaf.path,
    srcFile: leaf.srcFile, mod: leaf.mod, parent: leaf.parent, children: [leaf],
  });
  leaf._wrap = wrap;
  return wrap;
}

function statsFrom(file, node) {
  node.loc = node.loc ?? file.loc;
  node.churn = file.churn;
  node.fixChurn = file.fixChurn;
  node.recentChurn = file.recentChurn;
  return node;
}

/** The real file a (possibly synthetic) node belongs to, or null for folders. */
function realFileOf(node) {
  if (!node) return null;
  if (node.srcFile) return node.srcFile;
  return node.type === 'file' && !node.synth ? node : null;
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
  controls.minDistance = 6;
  controls.maxDistance = 2600;
  controls.target.set(0, 0, 0);
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };

  scene.add(new THREE.AmbientLight(0x2a4a68, 1.15));
  const key = new THREE.DirectionalLight(0xa9dcff, 0.75);
  key.position.set(320, 640, 260);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x7c4dff, 0.25);
  fill.position.set(-420, 260, -320);
  scene.add(fill);

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.55, 0.6);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.setSize(window.innerWidth, window.innerHeight);
}

/** Scene furniture that survives focus transitions. */
function buildStaticScene() {
  envGroup = buildEnvironment(CITY_SIZE);
  scene.add(envGroup);

  // Everything that belongs to the focus scope rides one group, so the
  // unfold/fold transition moves city, PR markers and arcs together.
  stage = new THREE.Group();
  stage.name = 'stage';
  scene.add(stage);

  peopleGroup = new THREE.Group();
  peopleGroup.name = 'people';
  stage.add(peopleGroup);

  scaffoldGroup = new THREE.Group();
  scaffoldGroup.name = 'scaffolding';
  stage.add(scaffoldGroup);

  selectionBox = makeSelectionBox(PALETTE.orange);
  hoverBox = makeSelectionBox(PALETTE.cyan);
  scene.add(selectionBox, hoverBox);

  dom.repoName.textContent = '// ' + (state.data.repo?.name || 'repo');
}

/**
 * Dispose the current city and rebuild everything for `state.focus`.
 * Rects are recomputed on every transition, so no level keeps stale world
 * coordinates from another level's layout.
 */
function rebuildScene(opts = {}) {
  const from = opts.anchor ? footprintOf(opts.anchor, scope.root) : null;
  if (city) {
    disposeObject(city.group);
    city = null;
  }
  clearArcs();
  clearGroup(peopleGroup);
  clearGroup(scaffoldGroup);

  scope.root = makeScopeRoot(state.focus);
  layoutCity(scope.root, { size: stageSize(scope.root) });
  city = buildCity(scope.root);
  stage.add(city.group);

  indexScope();
  buildPeopleLayer();

  if (state.selection && !scope.nodes.has(state.selection.node)) setSelection(null, { keepSidebar: true });
  refreshSelectionBox();
  rebuildArcs();
  applyOverlay();
  updateLabelCandidates();
  refreshPickables();

  dom.statFiles.textContent = fmt(scope.fileNodes.length);
  dom.statModules.textContent = fmt(city.moduleRecords.length);
  dom.statLoc.textContent = fmt(scope.root.loc);
  renderBreadcrumb();
  renderLegend();

  startTransition(from, opts.anchor ? footprintOf(opts.anchor, scope.root) : null);
  flyTo(scope.root, opts.instant);
}

/**
 * Where a node sits in the layout it belongs to. The scope root always occupies
 * the whole stage, so a node that *is* the current root reports the stage rect —
 * which is what makes the drill-down and drill-up maps symmetric.
 */
function footprintOf(node, root) {
  if (!root) return null;
  const isRoot = node === root || node.path === root.path || root.srcFile === node;
  const target = isRoot ? root : node;
  const r = target.rect || root.rect;
  if (!r) return null;
  return {
    cx: r.x + r.w / 2,
    cy: plateTop(target.depth ?? 0, target.type === 'file'),
    cz: r.z + r.h / 2,
    size: (r.w + r.h) / 2,
  };
}

/**
 * Start the scene at the transform that maps its new layout onto the footprint
 * the anchor occupied a moment ago, then relax to identity — so drilling in
 * reads as the block unfolding, and drilling out as the scene folding back.
 */
function startTransition(from, to) {
  transition.mats = [];
  stage.traverse((o) => {
    if (o.material && o.material.transparent) transition.mats.push({ m: o.material, base: o.material.opacity });
  });
  if (!from || !to || !to.size || !from.size) {
    transition.t = 1;
    stage.scale.setScalar(1);
    stage.position.set(0, 0, 0);
    return;
  }
  const k = Math.min(Math.max(from.size / to.size, 0.01), 60);
  transition.k0 = k;
  transition.p0.set(from.cx - k * to.cx, from.cy - k * to.cy, from.cz - k * to.cz);
  transition.t = 0;
  stage.scale.setScalar(k);
  stage.position.copy(transition.p0);
}

/**
 * Stage extent for a scope. Buildings are capped at 60 world units tall, so a
 * file or module scope laid out at the full org extent would read as a pancake;
 * shrink the stage to the number of buildings it actually contains.
 */
function stageSize(root) {
  if (!root.synth) return CITY_SIZE;
  let buildings = 0;
  walk(root, (n) => { if (n.type === 'file') buildings += (n.modules || []).length; });
  return Math.min(Math.max(Math.sqrt(Math.max(buildings, 1)) * 55, 60), CITY_SIZE);
}

function indexScope() {
  scope.fileNodes = [];
  scope.byRealPath = new Map();
  scope.nodes = new Set();
  walk(scope.root, (n) => {
    scope.nodes.add(n);
    if (n.type !== 'file' || !n.rect) return;
    scope.fileNodes.push(n);
    const real = realFileOf(n);
    if (!real) return;
    if (!scope.byRealPath.has(real.path)) scope.byRealPath.set(real.path, n);
  });
  // A file/module scope has no real file plate — anchor its PRs on the scope root.
  const rootReal = realFileOf(scope.root);
  if (rootReal && !scope.byRealPath.has(rootReal.path)) {
    scope.byRealPath.set(rootReal.path, scope.root);
  }
}

function clearGroup(group) {
  for (const child of [...group.children]) disposeObject(child);
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
    const kinds = scope.root && scope.root.synth ? [...KIND_ORDER, ...MEMBER_ORDER] : KIND_ORDER;
    for (const kind of kinds) {
      const hex = '#' + KIND_COLORS[kind].toString(16).padStart(6, '0');
      rows.push(`<div class="row"><i class="sw" style="background:${hex};box-shadow:0 0 8px ${hex}"></i><span>${kind}</span></div>`);
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
  crumbNodes = [];
  let n = state.focus || state.root;
  while (n) { crumbNodes.unshift(n); n = n.parent; }

  const html = [];
  crumbNodes.forEach((node, i) => {
    if (i > 0) html.push('<i class="sep">/</i>');
    const label = i === 0 ? (state.data.repo?.name || node.name) : node.name;
    html.push(`<a class="crumb ${i === crumbNodes.length - 1 ? 'active' : ''}" data-idx="${i}">${escapeHtml(label)}</a>`);
  });
  dom.breadcrumb.innerHTML = html.join('');
  dom.breadcrumb.scrollLeft = 1e6;
}

dom.breadcrumb.addEventListener('click', (e) => {
  const el = e.target.closest('.crumb');
  if (!el) return;
  const node = crumbNodes[Number(el.dataset.idx)];
  if (node) focusNode(node);
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
  if (state.mode === 'recent') return recentValue(fileNode).count;
  return 0;
}

/** Recency for a scope file — history-cursor aware while scrubbing. */
function recentValue(fileNode) {
  if (state.timeCursor === null) return { count: fileNode.recentChurn, flash: 0 };
  return recency.map.get(fileNode) || { count: 0, flash: 0 };
}

function recomputeRecency() {
  recency.map.clear();
  if (!timeline || !timeline.enabled || state.timeCursor === null) return;
  const T = state.timeCursor;
  for (const node of scope.fileNodes) {
    const real = realFileOf(node);
    if (!real) continue;
    const count = timeline.touchedSince(real.path, T - RECENT_WINDOW, T);
    const age = timeline.lastTouchBefore(real.path, T);
    recency.map.set(node, { count, flash: age <= FLASH_WINDOW ? 1 - age / FLASH_WINDOW : 0 });
  }
}

function applyOverlay() {
  if (!city) return;
  const mode = state.mode;
  const scrubbing = mode === 'recent' && state.timeCursor !== null;
  const maxV =
    mode === 'churn' ? index.max.churn :
    mode === 'fix' ? index.max.fixChurn :
    mode === 'recent' ? index.max.recentChurn : 1;
  const denom = Math.sqrt(Math.max(maxV, 1));
  const green = new THREE.Color(PALETTE.green);

  for (const rec of city.moduleRecords) {
    if (mode === 'structure') {
      _color.copy(rec.baseColor);
    } else if (mode === 'recent') {
      const r = recentValue(rec.file);
      if (r.count > 0) _color.copy(green).multiplyScalar(scrubbing ? 1 + r.flash * 1.6 : 1);
      else _color.copy(rec.baseColor).multiplyScalar(0.15);
    } else {
      heatColor(Math.sqrt(Math.max(heatValue(rec.file), 0)) / denom, _color);
    }
    rec.mesh.setColorAt(rec.instanceId, _color);
  }
  for (const mesh of city.buildingMeshes) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  if (city.filePlates) {
    for (const rec of city.fileRecords) {
      if (mode === 'structure') {
        _color.copy(rec.baseColor);
      } else if (mode === 'recent') {
        const r = recentValue(rec.node);
        if (r.count > 0) _color.copy(green).multiplyScalar(0.28 + (scrubbing ? r.flash * 0.5 : 0));
        else _color.copy(rec.baseColor).multiplyScalar(0.5);
      } else {
        heatColor(Math.sqrt(Math.max(heatValue(rec.node), 0)) / denom, _color).multiplyScalar(0.42);
      }
      city.filePlates.setColorAt(rec.instanceId, _color);
    }
    if (city.filePlates.instanceColor) city.filePlates.instanceColor.needsUpdate = true;
  }

  if (city.folderPlates) {
    for (const rec of city.folderRecords) {
      _dim.copy(rec.baseColor).multiplyScalar(mode === 'structure' ? 1 : 0.7);
      city.folderPlates.setColorAt(rec.instanceId, _dim);
    }
    if (city.folderPlates.instanceColor) city.folderPlates.instanceColor.needsUpdate = true;
  }
}

/** Scrubbing the timeline implies the Recent Focus overlay. */
function onTimeCursor(t) {
  state.timeCursor = t;
  if (t !== null && state.mode !== 'recent') {
    state.mode = 'recent';
    for (const b of dom.modes.querySelectorAll('button.mode')) b.classList.toggle('active', b.dataset.mode === 'recent');
    renderLegend();
  }
  recency.dirty = true;
  sidebar.setCursor(t);
}

// ---------------------------------------------------------------------------
// Coupling (directional)
// ---------------------------------------------------------------------------

function clearArcs() {
  if (arcMesh) {
    disposeObject(arcMesh);
    arcMesh = null;
  }
  if (arcFlow) {
    disposeObject(arcFlow.points);
    arcFlow = null;
  }
}

function rebuildArcs() {
  clearArcs();
  if (!state.coupling || !city) return;

  const sel = state.selection ? state.selection.node : null;
  const arcs = sel ? arcsForNode(sel) : packageArcs();
  if (!arcs.length) return;
  arcMesh = buildCouplingArcs(arcs, { thick: !sel, scale: CITY_SIZE / 900 });
  if (arcMesh) stage.add(arcMesh);
  arcFlow = buildArcFlow(arcs, { thick: !sel });
  if (arcFlow) stage.add(arcFlow.points);
}

/** Directional arcs between the node and other files inside the current scope. */
function arcsForNode(node) {
  const inside = new Set();
  walk(node, (n) => {
    const real = realFileOf(n);
    if (real) inside.add(real.path);
  });
  if (!inside.size) return [];

  const totals = new Map(); // "path|dir" -> { path, out, n }
  for (const path of inside) {
    for (const { other, n } of index.edgesOut.get(path) || []) {
      if (inside.has(other) || !scope.byRealPath.has(other)) continue;
      addDir(totals, other, true, n);
    }
    for (const { other, n } of index.edgesIn.get(path) || []) {
      if (inside.has(other) || !scope.byRealPath.has(other)) continue;
      addDir(totals, other, false, n);
    }
  }
  if (!totals.size) return [];

  const sorted = [...totals.values()].sort((a, b) => b.n - a.n).slice(0, MAX_ARCS);
  const max = sorted[0].n;
  const anchor = nodeAnchor(node);

  const out = [];
  for (const t of sorted) {
    const target = scope.byRealPath.get(t.path);
    if (!target || !target.rect) continue;
    const far = nodeAnchor(target);
    out.push(t.out
      ? { from: anchor.clone(), to: far, strength: t.n / max }
      : { from: far, to: anchor.clone(), strength: t.n / max });
  }
  return out;
}

function addDir(totals, path, out, n) {
  const key = path + (out ? '|>' : '|<');
  const prev = totals.get(key);
  if (prev) prev.n += n;
  else totals.set(key, { path, out, n });
}

/** Import counts in both directions between the node and the rest of the repo. */
function couplingSummary(node) {
  let out = 0;
  let inn = 0;
  walk(node, (n) => {
    const real = realFileOf(n);
    if (!real) return;
    for (const e of index.edgesOut.get(real.path) || []) out += e.n;
    for (const e of index.edgesIn.get(real.path) || []) inn += e.n;
  });
  return out || inn ? { out, in: inn } : null;
}

/**
 * The level at which "package coupling" is drawn: the focused folder, descended
 * past any single-child wrappers (e.g. repo -> packages) so there is something
 * to compare.
 */
function groupingRoot() {
  let n = scope.root;
  for (let i = 0; i < 8; i++) {
    if (!n || n.type !== 'folder') break;
    const kids = (n.children || []).filter((c) => c.rect);
    if (kids.length !== 1) break;
    n = kids[0];
  }
  return n && n.type === 'folder' ? n : scope.root;
}

/** file path -> the child of `parent` that contains it (memoized per parent). */
function groupMapFor(parent) {
  let map = index.groupMaps.get(parent);
  if (map) return map;
  map = new Map();
  for (const child of parent.children || []) {
    if (!child.rect) continue;
    walk(child, (n) => {
      const real = realFileOf(n);
      if (real) map.set(real.path, child);
    });
  }
  index.groupMaps.set(parent, map);
  return map;
}

/**
 * Package-level arcs, aggregated per direction. When both directions exist only
 * the dominant one is drawn (the sidebar reports both counts for a selection).
 */
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
    const key = ta.path + '>' + tb.path;
    const prev = totals.get(key);
    if (prev) prev.n += Number(e.n) || 1;
    else totals.set(key, { a: ta, b: tb, n: Number(e.n) || 1 });
  }
  if (!totals.size) return [];

  // Net out opposing pairs so the drawn arc shows the dominant flow.
  const net = [];
  const done = new Set();
  for (const [key, t] of totals) {
    if (done.has(key)) continue;
    const backKey = t.b.path + '>' + t.a.path;
    const back = totals.get(backKey);
    done.add(key);
    if (back) {
      done.add(backKey);
      net.push(t.n >= back.n ? { a: t.a, b: t.b, n: t.n } : { a: back.a, b: back.b, n: back.n });
    } else net.push(t);
  }

  const list = net.sort((x, y) => y.n - x.n).slice(0, MAX_ARCS);
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

const PR_HIGH = 118;
const PR_LOW = 26;
const PR_STALE_DAYS = 30;

function buildPeopleLayer() {
  const prs = state.data.prs || [];
  const draftFiles = [];
  const now = Date.now() / 1000;

  let maxWeight = 1;
  for (const pr of prs) maxWeight = Math.max(maxWeight, Math.log2(1 + prSize(pr)));

  for (const pr of prs) {
    const nodes = uniq(pr.files.map((p) => scope.byRealPath.get(p)).filter((n) => n && n.rect));
    if (!nodes.length) continue;

    let cx = 0, cz = 0, top = 0;
    const targets = [];
    for (const n of nodes) {
      cx += n.rect.x + n.rect.w / 2;
      cz += n.rect.z + n.rect.h / 2;
      const plate = plateTop(n.depth, n.type === 'file');
      top = Math.max(top, plate + tallest(n));
      if (targets.length < 20) targets.push(new THREE.Vector3(n.rect.x + n.rect.w / 2, plate, n.rect.z + n.rect.h / 2));
    }

    // Altitude = freshness: recently updated PRs ride high and bob energetically.
    const days = Math.min(Math.max((now - (Date.parse(pr.updatedAt || '') / 1000 || now)) / DAY, 0), PR_STALE_DAYS);
    // Log knee: open PRs cluster in the first few days, so a linear 0..30d ramp
    // would park them all at the same altitude.
    const fresh = 1 - Math.log2(1 + days) / Math.log2(1 + PR_STALE_DAYS);
    const hover = PR_LOW + (PR_HIGH - PR_LOW) * fresh;

    const anchor = new THREE.Vector3(cx / nodes.length, top + 4, cz / nodes.length);
    const marker = buildPrMarker(pr, anchor, {
      hover,
      weight: Math.log2(1 + prSize(pr)) / maxWeight,
      targets,
    });
    marker.userData.nodes = nodes;
    marker.userData.bobAmp = 1.0 + 4.2 * fresh;
    marker.userData.bobSpeed = 0.35 + 1.9 * fresh;
    peopleGroup.add(marker);

    if (pr.isDraft) draftFiles.push(...nodes);
  }

  const scaffold = buildScaffolding(draftFiles);
  if (scaffold) { scaffold.userData.pulseRate = 2.4; scaffoldGroup.add(scaffold); }

  const collisionFiles = [];
  for (const [p, list] of index.prsByFile) {
    if (list.length < 2) continue;
    const n = scope.byRealPath.get(p);
    if (n && n.rect) collisionFiles.push(n);
  }
  const collide = buildScaffolding(collisionFiles, 0xef4444);
  if (collide) { collide.userData.pulseRate = 5.2; scaffoldGroup.add(collide); }

  peopleGroup.visible = state.people;
  scaffoldGroup.visible = state.people;
}

/** additions+deletions when the data has them, else file count as a stand-in. */
function prSize(pr) {
  const a = Number(pr.additions);
  const d = Number(pr.deletions);
  if (Number.isFinite(a) || Number.isFinite(d)) return (a || 0) + (d || 0);
  return pr.files.length * 40;
}

function uniq(arr) {
  return [...new Set(arr)];
}

function tallest(node) {
  let m = 0;
  for (const p of node.plots || []) m = Math.max(m, buildingHeight(p.mod.loc));
  if (node.children) for (const c of node.children) m = Math.max(m, tallest(c));
  return m;
}

// ---------------------------------------------------------------------------
// Selection / focus
// ---------------------------------------------------------------------------

function setSelection(target, opts = {}) {
  state.selection = target;
  refreshSelectionBox();
  if (!opts.keepSidebar) sidebar.setSelection(target ? describe(target) : null);
  rebuildArcs();
  updateLabelCandidates();
}

function refreshSelectionBox() {
  const sel = state.selection;
  if (!sel) {
    selectionBox.visible = false;
    return;
  }
  if (sel.rec) {
    boxAroundInstance(selectionBox, sel.rec);
  } else if (sel.node.rect) {
    frameNodeBox(selectionBox, sel.node, boxHeightFor(sel.node));
  } else {
    selectionBox.visible = false;
  }
}

function boxAroundInstance(box, rec) {
  rec.mesh.getMatrixAt(rec.instanceId, _m4);
  _m4.decompose(_v3, _q, _scale);
  box.position.set(_v3.x, _v3.y + _scale.y / 2, _v3.z);
  box.scale.set(_scale.x + 0.6, _scale.y + 0.6, _scale.z + 0.6);
  box.visible = true;
}

function boxHeightFor(node) {
  if (node.type === 'file') return Math.max(tallest(node) + 4, 10);
  return Math.max(Math.min(node.rect.w, node.rect.h) * 0.28, 18);
}

/**
 * Push (or pop) the focus stack and rebuild the whole scene for that node.
 * The anchor is the deeper node of the transition — the one whose footprint the
 * unfold animation grows out of (or folds back into).
 */
function focusNode(node, opts = {}) {
  if (!node || node === state.focus) return;
  const prev = state.focus;
  const anchor = isDescendantOf(node, prev) ? node : prev;
  state.focus = node;
  index.groupMaps.clear();
  rebuildScene({ ...opts, anchor: opts.instant ? null : anchor });

  if (state.selection) sidebar.setSelection(describe(state.selection));
  else setSelection({ type: node.type, node, rec: null });
}

function isDescendantOf(node, ancestor) {
  for (let n = node.parent; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

function flyTo(node, instant) {
  const r = node.rect;
  if (!r) return;
  const target = new THREE.Vector3(r.x + r.w / 2, plateTop(node.depth, node.type === 'file'), r.z + r.h / 2);
  const extent = Math.max(r.w, r.h, 12);
  const vFov = (camera.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);

  // The HUD eats both edges of the viewport, so fit the footprint to the free
  // strip between the control stack and the sidebar, then slide the framing into
  // it. The sidebar width is predicted rather than measured: at file level or
  // deeper it auto-expands, and its CSS transition would lag the camera move.
  const sidebarEl = document.getElementById('sidebar');
  const sbW = realFileOf(state.focus) ? 560 : sidebarEl ? sidebarEl.offsetWidth : 300;
  const freeRight = window.innerWidth - (sbW + 14);
  const freeWidth = Math.max(freeRight - 240, 240);
  const freeCenter = (240 + freeRight) / 2;
  const shift = (freeCenter / window.innerWidth) * 2 - 1;

  const fit = Math.min(Math.tan(vFov / 2), Math.tan(hFov / 2) * (freeWidth / window.innerWidth));
  const dist = (extent / 2) / fit * 1.05 + 18;

  _v3.copy(camera.position).sub(controls.target);
  if (_v3.lengthSq() < 1e-6) _v3.set(0.4, 0.8, 0.9);
  _v3.normalize();
  if (_v3.y < 0.42) { _v3.y = 0.42; _v3.normalize(); }
  const pos = target.clone().addScaledVector(_v3, dist);
  // Camera right vector: the view direction is -_v3, so right = up × _v3.
  const right = new THREE.Vector3().crossVectors(camera.up, _v3).normalize();
  const slide = -shift * dist * Math.tan(hFov / 2);
  target.addScaledVector(right, slide);
  pos.addScaledVector(right, slide);

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
  flight.dur = 0.75;
  flight.active = true;
}

// ---------------------------------------------------------------------------
// Descriptors for the sidebar
// ---------------------------------------------------------------------------

function describe(target) {
  if (!target) return null;
  if (target.type === 'pr') {
    const pr = target.pr;
    return {
      name: '#' + (Number(pr.number) || 0),
      kind: pr.isDraft ? 'draft pr' : 'open pr',
      kindColor: pr.isDraft ? PALETTE.orange : PALETTE.cyan,
      path: pr.title || '',
      grid: [['FILES', pr.files.length], ['+', pr.additions ?? '—'], ['−', pr.deletions ?? '—'], ['LOC', '—']],
      prs: [pr],
      codePath: null,
      span: null,
      deep: false,
    };
  }

  const node = target.node;
  const mod = target.rec ? target.rec.mod : node.mod;
  const real = realFileOf(node);
  const kind = mod ? mod.kind
    : node.type === 'file' ? 'file'
    : `folder · ${(node.children || []).length} children`;

  return {
    name: mod ? mod.name : node.name,
    kind,
    kindColor: mod ? KIND_COLORS[mod.kind] ?? PALETTE.cyan : PALETTE.cyan,
    path: node.path,
    loc: mod ? mod.loc : node.loc,
    churn: node.churn,
    fixChurn: node.fixChurn,
    recentChurn: state.timeCursor === null ? node.recentChurn : recentValue(node).count,
    prs: real ? index.prsByFile.get(real.path) || [] : index.prsByNode.get(node) || [],
    coupling: state.coupling ? couplingSummary(node) : null,
    codePath: real ? real.path : null,
    span: mod && Number.isFinite(mod.line)
      ? { start: Math.max(1, mod.line), end: Math.max(1, mod.line) + Math.max(mod.loc, 1) }
      : null,
    deep: !!real,
  };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function updateLabelCandidates() {
  if (!city) return;
  const list = [];

  walk(scope.root, (n) => {
    if (!n.rect) return;
    const size = Math.min(n.rect.w, n.rect.h);
    if (size < 3) return;
    const isFile = n.type === 'file';
    if (!isFile && n === scope.root && scope.root.depth === 0 && (n.children || []).length === 1) return;
    list.push({
      key: n.path + (isFile ? '|f' : '|d'),
      text: String(n.name).toUpperCase(),
      tier: isFile ? 'file' : 'folder',
      pos: new THREE.Vector3(
        n.rect.x + n.rect.w / 2,
        plateTop(n.depth, isFile) + (isFile ? 5 : 9 + n.depth),
        n.rect.z + n.rect.h / 2
      ),
      size,
    });
  });

  const many = city.moduleRecords.length > MODULE_LABEL_BUDGET;
  const selNode = state.selection ? realFileOf(state.selection.node) : null;
  for (const rec of city.moduleRecords) {
    if (many && (!selNode || realFileOf(rec.file) !== selNode)) continue;
    list.push({
      key: rec.file.path + '#' + rec.mod.name,
      text: String(rec.mod.name).toUpperCase(),
      tier: 'module',
      pos: new THREE.Vector3(rec.center.x, rec.file.top + rec.height + 2.5, rec.center.z),
      size: Math.max(rec.height, 3),
    });
  }

  labeler.setCandidates(list);
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function bindEvents() {
  const el = renderer.domElement;

  el.addEventListener('pointermove', (e) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    pointerDirty = true;
    pointerInside = true;
  });
  el.addEventListener('pointerleave', () => {
    pointerInside = false;
    pointerDirty = true;
  });
  // Middle-drag pans; suppress the browser's autoscroll puck.
  el.addEventListener('pointerdown', (e) => { if (e.button === 1) e.preventDefault(); });
  el.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  let downAt = null;
  el.addEventListener('pointerdown', (e) => { if (e.button === 0) downAt = { x: e.clientX, y: e.clientY }; });
  el.addEventListener('pointerup', (e) => {
    if (!downAt || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 4) return; // it was an orbit drag
    setSelection(state.hover ? { ...state.hover } : null);
  });

  el.addEventListener('dblclick', () => {
    const hit = state.hover;
    if (!hit || hit.type === 'pr') return;
    focusNode(focusTargetFor(hit));
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const up = state.focus?.parent;
      if (up) focusNode(up);
    }
    if (e.key === 'c' && !e.metaKey && !e.ctrlKey) {
      const node = state.selection?.node || state.focus;
      if (!node || !node.path) return;
      navigator.clipboard?.writeText(node.path).then(
        () => showNotice('Path copied: ' + node.path),
        () => showNotice('Clipboard unavailable')
      );
    }
  });

  window.addEventListener('resize', onResize);
}

/** Which node a double-click isolates: buildings drill into their module. */
function focusTargetFor(hit) {
  if (hit.rec) {
    const file = hit.rec.file;
    return file.synth ? file : moduleNode(file, hit.rec.mod, file);
  }
  return hit.node;
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
    return rec ? { type: 'module', rec, node: rec.file } : null;
  }
  if (o === city.filePlates) {
    const rec = city.fileRecords[hit.instanceId];
    return rec ? { type: 'file', node: rec.node, rec: null } : null;
  }
  if (o === city.folderPlates) {
    const rec = city.folderRecords[hit.instanceId];
    return rec ? { type: 'folder', node: rec.node, rec: null } : null;
  }
  if (o.userData.pickType === 'pr') return { type: 'pr', pr: o.userData.pr };
  return null;
}

function setHover(hit) {
  const same =
    hit && state.hover && hit.type === state.hover.type &&
    (hit.type === 'pr' ? hit.pr === state.hover.pr
      : hit.type === 'module' ? hit.rec === state.hover.rec
      : hit.node === state.hover.node);
  if (same) return;
  if (!hit && !state.hover) return;

  state.hover = hit;
  document.body.style.cursor = hit ? 'pointer' : 'default';
  highlightPrLinks();

  if (!hit) {
    hoverBox.visible = false;
    sidebar.setHover(null);
    return;
  }

  if (hit.type === 'module') boxAroundInstance(hoverBox, hit.rec);
  else if (hit.type === 'pr') hoverBox.visible = false;
  else frameNodeBox(hoverBox, hit.node, boxHeightFor(hit.node));

  sidebar.setHover(describe(hit));
}

/** Hovering an avatar brightens that PR's beams and file rings. */
function highlightPrLinks() {
  const hoveredPr = state.hover && state.hover.type === 'pr' ? state.hover.pr : null;
  for (const g of peopleGroup.children) {
    const u = g.userData;
    const on = hoveredPr && u.pr === hoveredPr;
    if (u.links) u.links.material.opacity = on ? 0.85 : u.linkBase;
    if (u.rings) u.rings.material.opacity = on ? 0.95 : u.ringBase;
    if (u.beam) u.beam.material.opacity = on ? 0.42 : u.beam.material.userData?.base ?? u.beam.material.opacity;
  }
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

  if (transition.t < 1) {
    transition.t = Math.min(transition.t + dt / TRANSITION_DUR, 1);
    const e = easeInOutCubic(transition.t);
    const s = transition.k0 + (1 - transition.k0) * e;
    stage.scale.setScalar(s);
    stage.position.set(transition.p0.x * (1 - e), transition.p0.y * (1 - e), transition.p0.z * (1 - e));
    for (const { m, base } of transition.mats) m.opacity = base * (0.45 + 0.55 * e);
  }

  if (timeline.enabled) {
    timeline.tick(dt);
    recency.acc += dt;
    if (recency.dirty && recency.acc > 0.12) {
      recency.acc = 0;
      recency.dirty = false;
      recomputeRecency();
      applyOverlay();
    }
  }

  controls.update();
  // Mid-transition the stage is still folded, so world-space picking, labels
  // and highlight boxes would all point at the wrong place.
  const settled = transition.t >= 1;
  labeler.group.visible = settled;
  if (settled) {
    updateHover();
    labeler.update(dt);
  } else {
    hoverBox.visible = false;
    selectionBox.visible = false;
  }
  updatePeople(t);
  if (arcFlow) arcFlow.update(t);

  for (const c of scaffoldGroup.children) {
    const rate = c.userData.pulseRate || 2.4;
    c.material.opacity = 0.42 + 0.34 * (0.5 + 0.5 * Math.sin(t * rate));
  }
  if (settled && state.selection) refreshSelectionBox();
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

function updatePeople(t) {
  if (!state.people) return;
  for (const g of peopleGroup.children) {
    const u = g.userData;
    if (!u.sprite) continue;
    const bob = Math.sin(t * (u.bobSpeed || 0.9) + u.phase) * (u.bobAmp || 3.2);
    u.sprite.position.y = u.baseY + bob;
    u.beam.scale.y = 1 + bob / Math.max(u.baseY, 1);
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
  const memberKinds = ['method', 'property', 'accessor', 'member'];

  const root = { type: 'folder', name: 'packages', path: 'packages', children: [] };
  const allFiles = [];
  let made = 0;

  for (const pkg of packages) {
    const pkgNode = { type: 'folder', name: pkg, path: `packages/${pkg}`, children: [] };
    root.children.push(pkgNode);

    const dirs = subdirs.slice(0, int(3, 5));
    for (const dir of dirs) {
      if (made >= 42) break;
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
        let line = 1;
        for (let k = 0; k < nMods; k++) {
          const kind = ext === 'tsx' && k === 0 ? 'component' : pick(kinds);
          const mloc = int(6, 220);
          const mod = {
            name: `${stem.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}${k ? k : ''}`,
            kind,
            loc: mloc,
            line,
            exported: rnd() > 0.35,
          };
          // v2: classes and interfaces carry their members for drill-down.
          if ((kind === 'class' || kind === 'interface' || kind === 'enum') && mloc > 40) {
            const nCh = int(2, 6);
            let cline = line + 1;
            mod.children = [];
            for (let c = 0; c < nCh; c++) {
              const cloc = Math.max(Math.floor(mloc / (nCh + 1)), 3);
              mod.children.push({ name: `member${c}`, kind: pick(memberKinds), loc: cloc, line: cline });
              cline += cloc;
            }
          }
          modules.push(mod);
          loc += mloc;
          line += mloc + 1;
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

  // v2: directional edges (a imports b), both directions allowed.
  const edges = [];
  const seen = new Set();
  for (let i = 0; i < 90 && allFiles.length > 1; i++) {
    const a = allFiles[Math.floor(rnd() * allFiles.length)];
    const b = allFiles[Math.floor(rnd() * allFiles.length)];
    if (!a || !b || a === b) continue;
    const key = a.path + '|' + b.path;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ a: a.path, b: b.path, n: int(1, 6) });
  }

  const prFilesA = allFiles.filter((_, i) => i % 9 === 1).slice(0, 5).map((f) => f.path);
  const prFilesB = allFiles.filter((_, i) => i % 7 === 3).slice(0, 4).map((f) => f.path);

  // v2: commit stream over the last 12 months.
  const now = Math.floor(Date.now() / 1000);
  const files = allFiles.map((f) => f.path);
  const commits = [];
  for (let i = 0; i < 400; i++) {
    const ts = now - Math.floor(rnd() * 360 * DAY);
    const n = int(1, 4);
    const f = [];
    for (let k = 0; k < n; k++) f.push(int(0, files.length - 1));
    commits.push({
      h: (0x1000000 + Math.floor(rnd() * 0xfffffff)).toString(16).slice(0, 7),
      ts,
      a: pick(['ada-lovelace', 'grace-hopper', 'alan-turing']),
      s: pick(['fix(canvas): clamp viewport', 'feat: virtualize node layer', 'refactor: split serializer', 'chore: bump deps']),
      f,
    });
  }
  commits.sort((a, b) => b.ts - a.ts);

  return {
    repo: { name: 'demo-repo', root: '/demo', analyzedAt: new Date(0).toISOString(), githubUrl: null },
    tree: root,
    edges,
    files,
    commits,
    prs: [
      {
        number: 3055,
        title: 'Refactor edge routing for nested groups',
        author: 'ada-lovelace',
        avatarUrl: null,
        isDraft: false,
        updatedAt: new Date((now - 2 * DAY) * 1000).toISOString(),
        additions: 420,
        deletions: 180,
        files: prFilesA,
      },
      {
        number: 3061,
        title: 'WIP: virtualize the node layer',
        author: 'grace-hopper',
        avatarUrl: null,
        isDraft: true,
        updatedAt: new Date((now - 26 * DAY) * 1000).toISOString(),
        additions: 60,
        deletions: 14,
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
