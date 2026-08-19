/**
 * main.ts — scene wiring, data loading, focus stack, overlays, interaction.
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

import type { CityHost } from '../../shared/host.js';
import { HttpHost } from '../../shared/host.js';
import type { CityData, FileNode, FolderNode, MemberKind, ModuleInfo, ModuleKind, Pr } from '../../shared/types.js';
import { layoutCity, plateTop, buildingHeight } from './layout.js';
import {
  buildCity, buildEnvironment, disposeObject,
  buildCouplingArcs, buildArcFlow, buildPrMarker, buildScaffolding, makeSelectionBox, frameNodeBox, makeLabelSprite,
  heatColor, walk, KIND_COLORS, KIND_ORDER, MEMBER_ORDER, PALETTE,
  type Arc, type ArcFlow, type CityBuild, type ModuleRecord,
} from './city.js';
import { createLabeler, type LabelCandidate, type Labeler } from './labels.js';
import { createTerraceSigns, type TerraceSigns } from './terrace.js';
import {
  createSidebar, escapeHtml,
  type Descriptor, type Sidebar, type WorkChange, type WorkKind,
} from './sidebar.js';
import { createTimeline, RECENT_WINDOW, FLASH_WINDOW, type Timeline } from './timeline.js';
import { createSearch, type HighlightSpec, type SearchPalette } from './search.js';
import type { TourTarget } from '../../shared/tour.js';
import { createTour, type TourPlayer } from './tour.js';
import {
  buildStrataIndex, createStrata, COMMIT_TYPE_COLORS, COMMIT_TYPE_ORDER,
  type StrataBuild, type StrataIndex, type StrataRecord,
} from './strata.js';
import { asVNode, type VMod, type VNode } from './vtree.js';

const MAX_ARCS = 150;
const DAY = 86400;
/** Scope transition: contents unfold out of (or fold back into) the parent footprint. */
const TRANSITION_DUR = 0.42;
/** Above this many buildings, module labels are limited to the selected file. */
const MODULE_LABEL_BUDGET = 800;

/** World extent of the root plate, scaled so buildings keep a city-like ratio. */
function cityExtent(fileCount: number): number {
  return Math.min(Math.max(Math.sqrt(fileCount) * 15, 260), 900);
}
let CITY_SIZE = 900;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** `strata` is a render mode: it replaces buildings, the rest recolor them. */
type Mode = 'structure' | 'churn' | 'fix' | 'recent' | 'strata';

/** A node (or building) the pointer / selection is on. */
interface NodeTarget {
  type: 'folder' | 'file' | 'module';
  node: VNode;
  rec: ModuleRecord | null;
  /** The strata level under the pointer, when the hit came from that layer. */
  level?: StrataRecord | null;
}

/** A PR avatar. */
interface PrTarget {
  type: 'pr';
  pr: Pr;
}

type Target = NodeTarget | PrTarget;

const state: {
  data: CityData | null;
  root: VNode | null;
  mode: Mode;
  coupling: boolean;
  people: boolean;
  fx: boolean;
  worktree: boolean;
  focus: VNode | null;
  selection: Target | null;
  hover: Target | null;
  timeCursor: number | null;
  usingFake: boolean;
} = {
  data: null,
  root: null,
  mode: 'recent',
  coupling: false,
  people: true,
  fx: true,
  worktree: false,
  /** Node whose subtree is currently rendered (real folder/file or synthetic module). */
  focus: null,
  /** { node, rec|null } pinned by click. */
  selection: null,
  hover: null,
  timeCursor: null,
  usingFake: false,
};

/** Everything derived from the current focus scope; rebuilt on every transition. */
const scope: {
  root: VNode | null;
  fileNodes: VNode[];
  byRealPath: Map<string, VNode>;
  nodes: Set<VNode>;
} = {
  root: null,
  fileNodes: [],
  byRealPath: new Map(),
  nodes: new Set(),
};

const dom = {
  scene: requireEl('scene'),
  boot: requireEl('boot'),
  notice: requireEl('notice'),
  breadcrumb: requireEl('breadcrumb'),
  repoName: requireEl('repo-name'),
  statFiles: requireEl('stat-files'),
  statModules: requireEl('stat-modules'),
  statModulesLabel: requireEl('stat-modules-label'),
  statLoc: requireEl('stat-loc'),
  statFps: requireEl('stat-fps'),
  legend: requireEl('legend-body'),
  modes: requireEl('modes'),
  toggles: requireEl('toggles'),
  worktreeBtn: requireEl('toggle-worktree'),
};

// Index structures (built once, over the real tree)
const index: {
  filesByPath: Map<string, VNode>;
  nodesByPath: Map<string, VNode>;
  prsByFile: Map<string, Pr[]>;
  prsByNode: Map<VNode, Pr[]>;
  groupMaps: Map<VNode, Map<string, VNode>>;
  edgesOut: Map<string, Array<{ other: string; n: number }>>;
  edgesIn: Map<string, Array<{ other: string; n: number }>>;
  max: { churn: number; fixChurn: number; recentChurn: number };
} = {
  filesByPath: new Map(),
  nodesByPath: new Map(),
  prsByFile: new Map(),   // path -> PR[]
  prsByNode: new Map(),   // node -> PR[]  (aggregated)
  groupMaps: new Map(),   // folder node -> Map(file path -> that folder's child containing it)
  edgesOut: new Map(),    // path -> [{other, n}]
  edgesIn: new Map(),
  max: { churn: 1, fixChurn: 1, recentChurn: 1 },
};

// The environment adapter — the only thing that talks to the outside world.
const host: CityHost = new HttpHost();

// Three.js objects
let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let controls: OrbitControls;
let composer: EffectComposer;
let bloom: UnrealBloomPass;
let city: CityBuild | null = null;
let envGroup: THREE.Group;
let peopleGroup: THREE.Group;
let scaffoldGroup: THREE.Group;
let worktreeGroup: THREE.Group;
let stage: THREE.Group;
let labeler: Labeler;
let terraceSigns: TerraceSigns;
let sidebar: Sidebar;
let timeline: Timeline;
let search: SearchPalette | null = null;
let tour: TourPlayer | null = null;
/** A tour step asked for a slow orbit; suspended while the camera is flying. */
let orbitWanted = false;
let arcMesh: THREE.Mesh | null = null;
let arcFlow: ArcFlow | null = null;
let selectionBox: THREE.LineSegments;
let hoverBox: THREE.LineSegments;
let crumbNodes: VNode[] = [];

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDirty = false;
let pointerInside = false;
let pickables: THREE.Object3D[] = [];
/** Labels and terrace signs — rebuilt every pick, they come and go on their own. */
const overlayPickables: THREE.Object3D[] = [];

// Scratch objects — never allocate inside the render loop.
const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();
const _dim = new THREE.Color();

/** One camera pose: where it sits and what it orbits. */
interface Framing {
  pos: THREE.Vector3;
  target: THREE.Vector3;
}

/**
 * Camera flight along a chain of framings. A single-level move is a two-point
 * path interpolated *around the pivot* (target lerps, the offset slerps and its
 * length blends geometrically) so the view swings rather than re-centring; a
 * multi-level jump appends the framing of every level it passes through, and
 * one global ease carries the camera through all of them without a stop.
 */
const flight: { active: boolean; t: number; dur: number; from: Framing; points: Framing[] } = {
  active: false,
  t: 0,
  dur: 1.1,
  from: { pos: new THREE.Vector3(), target: new THREE.Vector3() },
  points: [],
};
/** Scope transition: the new scene starts mapped onto the old footprint and unfolds. */
const transition: { t: number; k0: number; p0: THREE.Vector3; mats: Array<{ m: THREE.Material; base: number }> } = {
  t: 1, k0: 1, p0: new THREE.Vector3(), mats: [],
};
/**
 * Strata render mode. The index is built once, on first use; the mesh is rebuilt
 * per scope and only *refilled* (throttled) while either timeline handle moves.
 */
const strata: {
  index: StrataIndex | null;
  build: StrataBuild | null;
  dirty: boolean;
  acc: number;
} = {
  index: null, build: null, dirty: false, acc: 0,
};
/** Per-scope-file recency, recomputed (throttled) while scrubbing history. */
const recency: { map: Map<VNode, { count: number; flash: number }>; dirty: boolean; acc: number } = {
  map: new Map(), dirty: false, acc: 0,
};
/**
 * Search highlight pass — while the palette is open this takes precedence over
 * the overlay/timeline recolor; closing it calls applyOverlay() to restore.
 * `paths` maps a real file path to { w, mods } (mods = null → the whole file).
 */
const searchPaint: {
  on: boolean;
  paths: Map<string, { w: number; mods: Set<string> | null }> | null;
  cursor: { path: string; mods: Set<string> | null } | null;
  pulseRecs: ModuleRecord[];
  pulseMeshes: THREE.InstancedMesh[];
} = {
  on: false,
  paths: null,
  cursor: null,
  pulseRecs: [],     // instance records under the keyboard cursor
  pulseMeshes: [],   // their meshes, for a single needsUpdate per frame
};
const SEARCH_HL = new THREE.Color(0xbdfcff);
const _hl = new THREE.Color();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

main().catch((err: unknown) => {
  console.error(err);
  showNotice('FATAL: ' + errMessage(err));
  dom.boot.classList.add('hide');
});

async function main(): Promise<void> {
  const data = await loadData();
  state.data = data;
  state.root = asVNode(data.tree);

  normalizeTree(state.root);
  buildIndex(data);
  CITY_SIZE = cityExtent(index.filesByPath.size);

  initScene();

  timeline = createTimeline(data, {
    onChange: onTimeCursor,
    onRange: () => { strata.dirty = true; },
  });
  sidebar = createSidebar({ host, timeline, githubUrl: data.repo?.githubUrl });
  labeler = createLabeler(scene, camera);
  search = createSearch({
    getRoot: () => state.root ?? asVNode(data.tree),
    highlight: setSearchHighlight,
    reveal: revealPath,
    notice: showNotice,
    search: (q) => host.search(q),
  });

  state.focus = state.root;
  buildStaticScene();
  rebuildScene({ instant: true });
  buildHud();
  bindEvents();
  tour = createTourPlayer();
  animate();

  requestAnimationFrame(() => dom.boot.classList.add('hide'));
  if (state.usingFake) showNotice('No data.json — showing synthetic demo city');

  // The Working-tree layer needs a live git; on a static export there is none,
  // so the toggle only appears once the endpoint has answered.
  void host.getStatus().then((res) => {
    if (res) dom.worktreeBtn.style.display = '';
  });
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadData(): Promise<CityData> {
  try {
    return await host.loadData();
  } catch (err: unknown) {
    console.warn('[code-city] falling back to synthetic dataset:', errMessage(err));
    state.usingFake = true;
    return makeFakeData();
  }
}

/** Fill in missing fields and recompute folder aggregates bottom-up. */
function normalizeTree(node: VNode, parent: VNode | null = null): VNode {
  node.parent = parent;
  node.type = node.type === 'file' ? 'file' : 'folder';
  node.name = node.name ?? '(unnamed)';
  node.path = node.path ?? node.name;

  if (node.type === 'file') {
    node.modules = Array.isArray(node.modules) ? node.modules : [];
    for (const m of node.modules) {
      m.kind = KIND_ORDER.some((k) => k === m.kind) ? m.kind : 'const';
      m.loc = Math.max(Number(m.loc) || 1, 1);
      if (Array.isArray(m.children)) {
        for (const ch of m.children) {
          ch.kind = MEMBER_ORDER.some((k) => k === ch.kind) ? ch.kind : 'member';
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

function buildIndex(data: CityData): void {
  const root = state.root;
  if (!root) return;
  walk(root, (n) => {
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
      let list = index.prsByFile.get(p);
      if (!list) index.prsByFile.set(p, (list = []));
      list.push(pr);
    }
  }
  aggregatePrs(root);

  data.edges = (Array.isArray(data.edges) ? data.edges : []).filter(
    (e) => e && index.filesByPath.has(e.a) && index.filesByPath.has(e.b) && e.a !== e.b
  );
  // Directional adjacency: a imports b.
  for (const e of data.edges) {
    push(index.edgesOut, e.a, { other: e.b, n: Number(e.n) || 1 });
    push(index.edgesIn, e.b, { other: e.a, n: Number(e.n) || 1 });
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  let arr = map.get(key);
  if (!arr) map.set(key, (arr = []));
  arr.push(value);
}

function aggregatePrs(node: VNode): Pr[] {
  if (node.type === 'file') {
    const list = index.prsByFile.get(node.path) || [];
    index.prsByNode.set(node, list);
    return list;
  }
  const set = new Set<Pr>();
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
function makeScopeRoot(node: VNode): VNode {
  if (node.type === 'folder' && !node.synth) return node;
  if (node.synth === 'module') return node;
  if (node.type === 'file' && !node.synth) return fileScope(node);
  return wrapLeaf(node); // synthetic single-module / member leaf
}

function fileScope(file: VNode): VNode {
  if (file._scope) return file._scope;
  const root = statsFrom(file, {
    type: 'folder', synth: 'fileScope', name: file.name, path: file.path,
    srcFile: file, parent: file.parent, children: [],
  });
  root.children = (file.modules ?? []).map((m) => moduleNode(file, m, root));
  // A file with no extractable modules (e.g. pure export lists) still gets one
  // building standing in for the file itself, so the isolate never reads empty.
  if (!root.children.length) {
    const stub: VMod = { name: file.name.replace(/\.[^.]+$/, ''), kind: 'const', loc: file.loc, line: 1, exported: true };
    root.children = [moduleNode(file, stub, root)];
  }
  file._scope = root;
  return root;
}

/** The node representing one module of `file` — a district if it has members. */
function moduleNode(file: VNode, mod: VMod, parent: VNode | null): VNode {
  if (!file._modNodes) file._modNodes = new Map();
  const cached = file._modNodes.get(mod);
  if (cached) {
    cached.parent = parent ?? file;
    return cached;
  }
  const path = `${file.path}#${mod.name}`;
  let node: VNode;
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
function wrapLeaf(leaf: VNode): VNode {
  if (leaf._wrap) return leaf._wrap;
  const wrap = statsFrom(leaf.srcFile || leaf, {
    type: 'folder', synth: 'wrap', name: leaf.name, path: leaf.path,
    srcFile: leaf.srcFile, mod: leaf.mod, parent: leaf.parent, children: [leaf],
  });
  leaf._wrap = wrap;
  return wrap;
}

/** A partially built synthetic node: the stats are copied from its source file. */
type SynthDraft = Omit<VNode, 'loc' | 'churn' | 'fixChurn' | 'recentChurn'> & { loc?: number };

function statsFrom(file: VNode, draft: SynthDraft): VNode {
  return {
    ...draft,
    loc: draft.loc ?? file.loc,
    churn: file.churn,
    fixChurn: file.fixChurn,
    recentChurn: file.recentChurn,
  };
}

/** The real file a (possibly synthetic) node belongs to, or null for folders. */
function realFileOf(node: VNode | null | undefined): VNode | null {
  if (!node) return null;
  if (node.srcFile) return node.srcFile;
  return node.type === 'file' && !node.synth ? node : null;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

function initScene(): void {
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
function buildStaticScene(): void {
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

  worktreeGroup = new THREE.Group();
  worktreeGroup.name = 'worktree';
  worktreeGroup.visible = false;
  stage.add(worktreeGroup);

  terraceSigns = createTerraceSigns(camera);
  stage.add(terraceSigns.group);

  selectionBox = makeSelectionBox(PALETTE.orange);
  hoverBox = makeSelectionBox(PALETTE.cyan);
  scene.add(selectionBox, hoverBox);

  dom.repoName.textContent = '// ' + (state.data?.repo?.name || 'repo');
}

/** Where a node sits in a layout: its centre and average side length. */
interface Footprint {
  cx: number;
  cy: number;
  cz: number;
  size: number;
}

/**
 * Dispose the current city and rebuild everything for `state.focus`.
 * Rects are recomputed on every transition, so no level keeps stale world
 * coordinates from another level's layout.
 */
function rebuildScene(
  opts: { instant?: boolean; anchor?: VNode | null; via?: Framing[]; viaUpFrom?: VNode | null } = {}
): void {
  const focus = state.focus;
  if (!focus) return;
  const from = opts.anchor ? footprintOf(opts.anchor, scope.root) : null;
  clearCallout();
  if (city) {
    disposeObject(city.group);
    city = null;
  }
  clearArcs();
  clearGroup(peopleGroup);
  clearGroup(scaffoldGroup);

  const root = makeScopeRoot(focus);
  scope.root = root;
  layoutCity(root, { size: stageSize(root) });
  city = buildCity(root);
  stage.add(city.group);

  indexScope();
  applyStrataMode();
  buildPeopleLayer();
  terraceSigns.setNodes(terraceSignNodes());
  applyWorktreeLayer();
  applySearchLayerMute();

  if (state.selection && state.selection.type !== 'pr' && !scope.nodes.has(state.selection.node)) {
    setSelection(null, { keepSidebar: true });
  }
  refreshSelectionBox();
  rebuildArcs();
  applyOverlay();
  updateLabelCandidates();
  refreshPickables();

  dom.statFiles.textContent = fmt(scope.fileNodes.length);
  if (!strata.build) {
    dom.statModulesLabel.textContent = 'MODULES';
    dom.statModules.textContent = fmt(city.moduleRecords.length);
  }
  dom.statLoc.textContent = fmt(root.loc);
  renderBreadcrumb();
  renderLegend();

  startTransition(from, opts.anchor ? footprintOf(opts.anchor, root) : null);
  // Zooming out, the levels we pass through only exist in the layout that was
  // just built, so their framings are collected here rather than by the caller.
  const upFrom = opts.viaUpFrom;
  const via = upFrom ? chainFramings(upFrom, focus, { descend: false }) : opts.via;
  flyTo(root, { instant: opts.instant, via });
}

/**
 * Where a node sits in the layout it belongs to. The scope root always occupies
 * the whole stage, so a node that *is* the current root reports the stage rect —
 * which is what makes the drill-down and drill-up maps symmetric.
 */
function footprintOf(node: VNode, root: VNode | null): Footprint | null {
  if (!root) return null;
  const isRoot = node === root || node.path === root.path || root.srcFile === node;
  const target = isRoot ? root : node;
  const r = target.rect || root.rect;
  if (!r) return null;
  return {
    cx: r.x + r.w / 2,
    cy: plateTop(target.tier ?? target.depth ?? 0, target.type === 'file'),
    cz: r.z + r.h / 2,
    size: (r.w + r.h) / 2,
  };
}

/**
 * Start the scene at the transform that maps its new layout onto the footprint
 * the anchor occupied a moment ago, then relax to identity — so drilling in
 * reads as the block unfolding, and drilling out as the scene folding back.
 */
function startTransition(from: Footprint | null, to: Footprint | null): void {
  transition.mats = [];
  stage.traverse((o) => {
    const mat = 'material' in o ? o.material : null;
    if (mat instanceof THREE.Material && mat.transparent) transition.mats.push({ m: mat, base: mat.opacity });
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
function stageSize(root: VNode): number {
  if (!root.synth) return CITY_SIZE;
  let buildings = 0;
  walk(root, (n) => { if (n.type === 'file') buildings += (n.modules || []).length; });
  return Math.min(Math.max(Math.sqrt(Math.max(buildings, 1)) * 55, 60), CITY_SIZE);
}

function indexScope(): void {
  const root = scope.root;
  if (!root) return;
  scope.fileNodes = [];
  scope.byRealPath = new Map();
  scope.nodes = new Set();
  walk(root, (n) => {
    scope.nodes.add(n);
    if (n.type !== 'file' || !n.rect) return;
    scope.fileNodes.push(n);
    const real = realFileOf(n);
    if (!real) return;
    if (!scope.byRealPath.has(real.path)) scope.byRealPath.set(real.path, n);
  });
  // A file/module scope has no real file plate — anchor its PRs on the scope root.
  const rootReal = realFileOf(root);
  if (rootReal && !scope.byRealPath.has(rootReal.path)) {
    scope.byRealPath.set(rootReal.path, root);
  }
}

function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) disposeObject(child);
}

function refreshPickables(): void {
  if (!city) return;
  // Hidden building meshes (Strata mode) must not answer the raycaster.
  pickables = city.pickables.filter((o) => o.visible);
  if (strata.build) pickables.push(strata.build.mesh);
  if (state.people && peopleGroup.visible) {
    for (const g of peopleGroup.children) if (g.userData.sprite) pickables.push(g.userData.sprite);
  }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function buildHud(): void {
  renderLegend();

  dom.modes.addEventListener('click', (e) => {
    const btn = closest(e.target, 'button.mode');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (!isMode(mode)) return;
    state.mode = mode;
    for (const b of dom.modes.querySelectorAll<HTMLElement>('button.mode')) b.classList.toggle('active', b === btn);
    if (mode === 'strata' && !timeline.enabled) showNotice('Strata needs a commit stream — re-run the analyzer');
    applyStrataMode();
    if (mode === 'strata' && !strataActive() && timeline.enabled) {
      showNotice('Strata is a city-level mode — Esc back out of this isolate');
    }
    applyOverlay();
    renderLegend();
    refreshPickables();
    updateLabelCandidates();
    refreshSelectionBox();
  });

  dom.toggles.addEventListener('click', (e) => {
    const btn = closest(e.target, 'button.toggle');
    if (!btn) return;
    const key = btn.dataset.toggle;
    if (key === 'worktree') {
      setWorktree(!state.worktree);
      return;
    }
    if (key !== 'coupling' && key !== 'people' && key !== 'fx') return;
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

function isMode(value: string | undefined): value is Mode {
  return value === 'structure' || value === 'churn' || value === 'fix'
    || value === 'recent' || value === 'strata';
}

function renderLegend(): void {
  const rows: string[] = [];
  if (state.mode === 'structure') {
    const kinds = scope.root && scope.root.synth ? [...KIND_ORDER, ...MEMBER_ORDER] : [...KIND_ORDER];
    for (const kind of kinds) {
      const hex = '#' + KIND_COLORS[kind].toString(16).padStart(6, '0');
      rows.push(`<div class="row"><i class="sw" style="background:${hex};box-shadow:0 0 8px ${hex}"></i><span>${kind}</span></div>`);
    }
  } else if (state.mode === 'recent') {
    rows.push(
      `<div class="row"><i class="sw" style="background:#4ade80;box-shadow:0 0 8px #4ade80"></i><span>touched &lt; 30d</span></div>`,
      `<div class="row"><i class="sw" style="background:#1b2432"></i><span>dormant</span></div>`
    );
  } else if (state.mode === 'strata') {
    // One level per commit, hue = the kind of change that commit was.
    for (const type of COMMIT_TYPE_ORDER) {
      const hex = '#' + (COMMIT_TYPE_COLORS[type] ?? PALETTE.cyan).toString(16).padStart(6, '0');
      rows.push(`<div class="row"><i class="sw" style="background:${hex};box-shadow:0 0 8px ${hex}"></i><span>${type}</span></div>`);
    }
    rows.push(
      `<div id="strata-ramp"></div>`,
      `<div class="ramp-labels"><span>oldest</span><span>untyped · age</span><span>newest</span></div>`,
      `<div class="row"><i class="sw" style="background:#1b2432"></i><span>untouched in range</span></div>`,
      `<div class="row"><span>level = commit · area = loc</span></div>`
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

function renderBreadcrumb(): void {
  crumbNodes = [];
  let n = state.focus || state.root;
  while (n) { crumbNodes.unshift(n); n = n.parent ?? null; }

  const html: string[] = [];
  crumbNodes.forEach((node, i) => {
    if (i > 0) html.push('<i class="sep">/</i>');
    const label = i === 0 ? (state.data?.repo?.name || node.name) : node.name;
    html.push(`<a class="crumb ${i === crumbNodes.length - 1 ? 'active' : ''}" data-idx="${i}">${escapeHtml(label)}</a>`);
  });
  dom.breadcrumb.innerHTML = html.join('');
  dom.breadcrumb.scrollLeft = 1e6;
}

dom.breadcrumb.addEventListener('click', (e) => {
  const el = closest(e.target, '.crumb');
  if (!el) return;
  const node = crumbNodes[Number(el.dataset.idx)];
  if (node) focusNode(node);
});

function showNotice(msg: string): void {
  dom.notice.textContent = msg;
  dom.notice.style.display = 'block';
  setTimeout(() => { dom.notice.style.display = 'none'; }, 7000);
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

function heatValue(fileNode: VNode): number {
  if (state.mode === 'churn') return fileNode.churn;
  if (state.mode === 'fix') return fileNode.fixChurn;
  if (state.mode === 'recent') return recentValue(fileNode).count;
  return 0;
}

/** Recency for a scope file — history-cursor aware while scrubbing. */
function recentValue(fileNode: VNode): { count: number; flash: number } {
  if (state.timeCursor === null) return { count: fileNode.recentChurn, flash: 0 };
  return recency.map.get(fileNode) || { count: 0, flash: 0 };
}

function recomputeRecency(): void {
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

function applyOverlay(): void {
  if (!city) return;
  if (searchPaint.on) {
    paintSearch();
    return;
  }
  const mode = state.mode;
  const scrubbing = mode === 'recent' && state.timeCursor !== null;
  const maxV =
    mode === 'churn' ? index.max.churn :
    mode === 'fix' ? index.max.fixChurn :
    mode === 'recent' ? index.max.recentChurn : 1;
  const denom = Math.sqrt(Math.max(maxV, 1));
  const green = new THREE.Color(PALETTE.green);

  for (const rec of city.moduleRecords) {
    if (mode === 'structure' || mode === 'strata') {
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

  const filePlates = city.filePlates;
  if (filePlates) {
    for (const rec of city.fileRecords) {
      if (mode === 'structure' || mode === 'strata') {
        _color.copy(rec.baseColor);
      } else if (mode === 'recent') {
        const r = recentValue(rec.node);
        if (r.count > 0) _color.copy(green).multiplyScalar(0.28 + (scrubbing ? r.flash * 0.5 : 0));
        else _color.copy(rec.baseColor).multiplyScalar(0.5);
      } else {
        heatColor(Math.sqrt(Math.max(heatValue(rec.node), 0)) / denom, _color).multiplyScalar(0.42);
      }
      filePlates.setColorAt(rec.instanceId, _color);
    }
    if (filePlates.instanceColor) filePlates.instanceColor.needsUpdate = true;
  }

  const folderPlates = city.folderPlates;
  if (folderPlates) {
    for (const rec of city.folderRecords) {
      _dim.copy(rec.baseColor).multiplyScalar(mode === 'structure' || mode === 'strata' ? 1 : 0.7);
      folderPlates.setColorAt(rec.instanceId, _dim);
    }
    if (folderPlates.instanceColor) folderPlates.instanceColor.needsUpdate = true;
  }

  paintWorktree();
}

// ---------------------------------------------------------------------------
// Strata render mode
// ---------------------------------------------------------------------------

/**
 * Strata replaces the module buildings with per-commit slabs, so it only makes
 * sense where files are the unit of rendering: inside a file or module isolate
 * (a synthetic scope) the city falls back to normal module massing.
 */
function strataActive(): boolean {
  return state.mode === 'strata' && timeline.enabled && !!scope.root && !scope.root.synth;
}

/** Build (or tear down) the strata layer for the current scope. */
function applyStrataMode(): void {
  if (!city) return;
  const on = strataActive();
  timeline.setRangeMode(on); // the second handle belongs to this mode alone
  for (const mesh of city.buildingMeshes) mesh.visible = !on;
  if (strata.build) {
    disposeObject(strata.build.group);
    strata.build = null;
  }
  if (!on) {
    dom.statModulesLabel.textContent = 'MODULES';
    dom.statModules.textContent = fmt(city.moduleRecords.length);
    return;
  }

  const data = state.data;
  if (!strata.index && data) strata.index = buildStrataIndex(data);
  const index = strata.index;
  if (!index) return;
  strata.build = createStrata(
    scope.fileNodes,
    index,
    (node) => realFileOf(node)?.path ?? null,
    { min: timeline.min, max: timeline.max }
  );
  if (!strata.build) return;
  stage.add(strata.build.group);
  updateStrata();
}

/** Refill the existing slabs for the current [start, cursor] range. */
function updateStrata(): void {
  const build = strata.build;
  if (!build) return;
  build.update({ start: timeline.start, cursor: state.timeCursor });
  dom.statModulesLabel.textContent = 'LEVELS';
  dom.statModules.textContent = fmt(build.records.length);
}

// ---------------------------------------------------------------------------
// Search highlight
// ---------------------------------------------------------------------------

/** null restores the active overlay. */
function setSearchHighlight(spec: HighlightSpec | null): void {
  if (!spec || !spec.paths || !spec.paths.size) {
    const was = searchPaint.on;
    searchPaint.on = !!spec;
    searchPaint.paths = spec ? spec.paths : null;
    searchPaint.cursor = null;
    searchPaint.pulseRecs.length = 0;
    searchPaint.pulseMeshes.length = 0;
    // An open palette with no matches still dims the city; a closed one restores.
    if (spec || was) applyOverlay();
    applySearchLayerMute();
    refreshPickables();
    return;
  }
  searchPaint.on = true;
  searchPaint.paths = spec.paths;
  searchPaint.cursor = spec.cursor || null;
  applyOverlay();
  applySearchLayerMute();
  refreshPickables();
}

/** PR beams/scaffolding would drown the highlight, so they rest while searching. */
function applySearchLayerMute(): void {
  const show = state.people && !searchPaint.on;
  peopleGroup.visible = show;
  scaffoldGroup.visible = show;
  worktreeGroup.visible = state.worktree && !searchPaint.on;
}

/** Matches glow white-cyan (brighter with weight), everything else goes dark. */
function paintSearch(): void {
  if (!city) return;
  const paths = searchPaint.paths;
  const cursor = searchPaint.cursor;
  searchPaint.pulseRecs.length = 0;
  searchPaint.pulseMeshes.length = 0;

  for (const rec of city.moduleRecords) {
    const real = realFileOf(rec.file);
    const hit = real && paths ? paths.get(real.path) : null;
    if (real && hit) {
      const exact = !hit.mods || hit.mods.has(rec.mod.name);
      _color.copy(SEARCH_HL).multiplyScalar((exact ? 1 : 0.3) * (0.45 + 0.85 * hit.w));
      if (cursor && real.path === cursor.path && (!cursor.mods || cursor.mods.has(rec.mod.name))) {
        searchPaint.pulseRecs.push(rec);
        if (!searchPaint.pulseMeshes.includes(rec.mesh)) searchPaint.pulseMeshes.push(rec.mesh);
      }
    } else {
      _color.copy(rec.baseColor).multiplyScalar(0.05);
    }
    rec.mesh.setColorAt(rec.instanceId, _color);
  }
  for (const mesh of city.buildingMeshes) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  const filePlates = city.filePlates;
  if (filePlates) {
    for (const rec of city.fileRecords) {
      const real = realFileOf(rec.node);
      const hit = real && paths ? paths.get(real.path) : null;
      if (hit) _color.copy(SEARCH_HL).multiplyScalar(0.18 + 0.22 * hit.w);
      else _color.copy(rec.baseColor).multiplyScalar(0.1);
      filePlates.setColorAt(rec.instanceId, _color);
    }
    if (filePlates.instanceColor) filePlates.instanceColor.needsUpdate = true;
  }

  const folderPlates = city.folderPlates;
  if (folderPlates) {
    for (const rec of city.folderRecords) {
      _dim.copy(rec.baseColor).multiplyScalar(0.22);
      folderPlates.setColorAt(rec.instanceId, _dim);
    }
    if (folderPlates.instanceColor) folderPlates.instanceColor.needsUpdate = true;
  }
}

/** Extra pulse on the row under the keyboard cursor. */
function pulseSearchCursor(t: number): void {
  if (!searchPaint.on || !searchPaint.pulseRecs.length) return;
  const k = 1.15 + 0.85 * (0.5 + 0.5 * Math.sin(t * 5.4));
  _hl.copy(SEARCH_HL).multiplyScalar(k);
  for (const rec of searchPaint.pulseRecs) rec.mesh.setColorAt(rec.instanceId, _hl);
  for (const mesh of searchPaint.pulseMeshes) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Tour player — the city drives itself through a scripted walk
// ---------------------------------------------------------------------------

/**
 * The player owns its own HUD and sidebar section; everything it does to the
 * city goes through these five verbs, each of which is machinery that already
 * existed for search, drill-down and the overlay passes.
 */
function createTourPlayer(): TourPlayer {
  return createTour({
    frame: (target) => tourReveal(target),
    isolate: (target) => {
      if (!tourReveal(target)) return false;
      const sel = state.selection;
      if (sel && sel.type !== 'pr') focusNode(focusTargetFor(sel));
      return true;
    },
    highlight: (targets) => tourHighlight(targets),
    setOrbit: (on) => {
      orbitWanted = on;
      if (!on) controls.autoRotate = false;
    },
    onUserCamera: (fn) => { controls.addEventListener('start', fn); },
    setView: (view) => sidebar.setTour(view),
    getDiff: (path, hash) => host.getDiff(path, hash),
    notice: showNotice,
    onExit: () => { sidebar.setSelection(state.selection ? describe(state.selection) : null); },
  });
}

function tourReveal(target: TourTarget): boolean {
  return revealPath(target.path, { module: target.module, line: target.range?.start });
}

/**
 * Co-highlight the step's target plus its blast radius, reusing the
 * search-highlight recolor pass (matches glow, everything else dims). The
 * target itself burns brightest; null hands the city back to its overlay.
 */
function tourHighlight(targets: TourTarget[] | null): void {
  if (!targets || !targets.length) {
    setSearchHighlight(null);
    return;
  }
  const paths = new Map<string, { w: number; mods: Set<string> | null }>();
  targets.forEach((t, i) => {
    const w = i === 0 ? 1 : 0.62;
    const prev = paths.get(t.path);
    if (!prev) {
      paths.set(t.path, { w, mods: t.module ? new Set([t.module]) : null });
      return;
    }
    prev.w = Math.max(prev.w, w);
    if (!t.module) prev.mods = null;        // a whole-file target outranks module ones
    else if (prev.mods) prev.mods.add(t.module);
  });
  setSearchHighlight({ paths, cursor: null });
}

// ---------------------------------------------------------------------------
// Working-tree layer — the "now" end of the time spectrum
// ---------------------------------------------------------------------------

const WORKTREE_AMBER = new THREE.Color(0xfbbf24);
const WORKTREE_UNTRACKED = 0x4ade80;
const WORKTREE_DELETED = 0xef4444;

/** Uncommitted changes, from `git status --porcelain` via the host. */
const worktree: { changes: WorkChange[]; byPath: Map<string, WorkKind> } = {
  changes: [],
  byPath: new Map(),
};

async function refreshWorktree(): Promise<void> {
  const res = await host.getStatus();
  if (!res) {
    showNotice('Working tree needs the dev server');
    setWorktree(false);
    return;
  }
  worktree.changes = [];
  worktree.byPath.clear();
  for (const c of res.changes) {
    const kind: WorkKind = c.untracked ? 'untracked'
      : c.x === 'D' || c.y === 'D' ? 'deleted'
      : 'modified';
    const inCity = index.filesByPath.has(c.path);
    worktree.changes.push({ path: c.path, kind, inCity });
    if (inCity) worktree.byPath.set(c.path, kind);
  }
  pushWorktreeToSidebar();
  applyWorktreeLayer();
  applyOverlay();
}

function setWorktree(on: boolean): void {
  state.worktree = on;
  dom.worktreeBtn.classList.toggle('active', on);
  if (on) {
    void refreshWorktree();
    return;
  }
  worktree.changes = [];
  worktree.byPath.clear();
  pushWorktreeToSidebar();
  applyWorktreeLayer();
  applyOverlay(); // restore whatever overlay was underneath
}

function pushWorktreeToSidebar(): void {
  sidebar.setWorkingTree(
    state.worktree
      ? {
          changes: worktree.changes,
          onSelect: (path) => { revealPath(path); },
          onRefresh: () => { void refreshWorktree(); },
        }
      : null
  );
}

/** Ghost outlines for the files that are not simply "modified in place". */
function applyWorktreeLayer(): void {
  clearGroup(worktreeGroup);
  worktreeGroup.visible = state.worktree && !searchPaint.on;
  if (!state.worktree) return;

  const untracked: VNode[] = [];
  const deleted: VNode[] = [];
  for (const [path, kind] of worktree.byPath) {
    if (kind === 'modified') continue;
    const node = scope.byRealPath.get(path);
    if (!node || !node.rect) continue;
    (kind === 'untracked' ? untracked : deleted).push(node);
  }
  const green = buildScaffolding(untracked, WORKTREE_UNTRACKED);
  if (green) { green.userData.pulseRate = 1.5; worktreeGroup.add(green); }
  const red = buildScaffolding(deleted, WORKTREE_DELETED);
  if (red) { red.userData.pulseRate = 3.4; worktreeGroup.add(red); }
}

/**
 * A recolor pass on top of the active overlay: only the modified files change,
 * so churn/recent/structure still read underneath. Search highlight outranks it.
 */
function paintWorktree(): void {
  if (!city || !state.worktree || !worktree.byPath.size) return;
  let touched = false;
  for (const rec of city.moduleRecords) {
    const real = realFileOf(rec.file);
    if (!real || worktree.byPath.get(real.path) !== 'modified') continue;
    rec.mesh.setColorAt(rec.instanceId, WORKTREE_AMBER);
    touched = true;
  }
  if (touched) for (const mesh of city.buildingMeshes) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  const filePlates = city.filePlates;
  if (!filePlates) return;
  let plateTouched = false;
  for (const rec of city.fileRecords) {
    const real = realFileOf(rec.node);
    if (!real || worktree.byPath.get(real.path) !== 'modified') continue;
    _color.copy(WORKTREE_AMBER).multiplyScalar(0.34);
    filePlates.setColorAt(rec.instanceId, _color);
    plateTouched = true;
  }
  if (plateTouched && filePlates.instanceColor) filePlates.instanceColor.needsUpdate = true;
}

/**
 * Select + fly to a path found in the palette. Matches outside the current
 * focus scope pop the scope back to the root first.
 * @returns false when the path is not part of the analyzed city.
 */
function revealPath(path: string, opts: { module?: string | null; line?: number } = {}): boolean {
  const real = index.filesByPath.get(path);
  if (!real) {
    showNotice('Not in this city: ' + path);
    return false;
  }
  // Outside the current scope → pop to the root city. A file too small to get
  // its own plate at that extent has no footprint there, so drill down to its
  // folder (then to the file itself) until it has one.
  if (!scope.byRealPath.has(path)) focusNode(state.root);
  if (!scope.byRealPath.has(path) && real.parent) focusNode(real.parent);
  if (!scope.byRealPath.has(path)) focusNode(real);

  const node = scope.byRealPath.get(path);
  if (!node) {
    showNotice('No footprint for ' + path);
    return false;
  }

  let target: Target = { type: node.type, node, rec: null };
  const module = opts.module;
  if (module && city) {
    const rec = city.moduleRecords.find((r) => realFileOf(r.file) === real && r.mod.name === module);
    if (rec) target = { type: 'module', rec, node: rec.file };
  }
  setSelection(target);

  const line = opts.line;
  if (line !== undefined && Number.isFinite(line) && line > 0) {
    const desc = describe(target);
    if (desc) {
      desc.span = { start: Math.max(1, line - 12), end: line + 60 };
      desc.deep = true;
      sidebar.setSelection(desc);
    }
  }
  if (node.rect) flyTo(node);
  return true;
}

/** Scrubbing the timeline implies the Recent Focus overlay. */
function onTimeCursor(t: number | null): void {
  state.timeCursor = t;
  strata.dirty = true;
  // Strata reads the cursor as its base snapshot, so it keeps its own overlay.
  if (t !== null && state.mode !== 'recent' && state.mode !== 'strata') {
    state.mode = 'recent';
    for (const b of dom.modes.querySelectorAll<HTMLElement>('button.mode')) b.classList.toggle('active', b.dataset.mode === 'recent');
    renderLegend();
  }
  recency.dirty = true;
  sidebar.setCursor(t);
}

// ---------------------------------------------------------------------------
// Coupling (directional)
// ---------------------------------------------------------------------------

function clearArcs(): void {
  if (arcMesh) {
    disposeObject(arcMesh);
    arcMesh = null;
  }
  if (arcFlow) {
    disposeObject(arcFlow.points);
    arcFlow = null;
  }
}

function rebuildArcs(): void {
  clearArcs();
  if (!state.coupling || !city) return;

  const sel = state.selection && state.selection.type !== 'pr' ? state.selection.node : null;
  const arcs = sel ? arcsForNode(sel) : packageArcs();
  if (!arcs.length) return;
  arcMesh = buildCouplingArcs(arcs, { thick: !sel, scale: CITY_SIZE / 900 });
  if (arcMesh) stage.add(arcMesh);
  arcFlow = buildArcFlow(arcs, { thick: !sel });
  if (arcFlow) stage.add(arcFlow.points);
}

/** Directional arcs between the node and other files inside the current scope. */
function arcsForNode(node: VNode): Arc[] {
  const inside = new Set<string>();
  walk(node, (n) => {
    const real = realFileOf(n);
    if (real) inside.add(real.path);
  });
  if (!inside.size) return [];

  const totals = new Map<string, { path: string; out: boolean; n: number }>(); // "path|dir"
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
  const first = sorted[0];
  if (!first) return [];
  const max = first.n;
  const anchor = nodeAnchor(node);
  if (!anchor) return [];

  const out: Arc[] = [];
  for (const t of sorted) {
    const target = scope.byRealPath.get(t.path);
    if (!target || !target.rect) continue;
    const far = nodeAnchor(target);
    if (!far) continue;
    out.push(t.out
      ? { from: anchor.clone(), to: far, strength: t.n / max }
      : { from: far, to: anchor.clone(), strength: t.n / max });
  }
  return out;
}

function addDir(totals: Map<string, { path: string; out: boolean; n: number }>, path: string, out: boolean, n: number): void {
  const key = path + (out ? '|>' : '|<');
  const prev = totals.get(key);
  if (prev) prev.n += n;
  else totals.set(key, { path, out, n });
}

/** Import counts in both directions between the node and the rest of the repo. */
function couplingSummary(node: VNode): { out: number; in: number } | null {
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
function groupingRoot(): VNode | null {
  let n = scope.root;
  for (let i = 0; i < 8; i++) {
    if (!n || n.type !== 'folder') break;
    const kids = (n.children || []).filter((c) => c.rect);
    if (kids.length !== 1) break;
    n = kids[0] ?? n;
  }
  return n && n.type === 'folder' ? n : scope.root;
}

/** file path -> the child of `parent` that contains it (memoized per parent). */
function groupMapFor(parent: VNode): Map<string, VNode> {
  let map = index.groupMaps.get(parent);
  if (map) return map;
  map = new Map();
  for (const child of parent.children || []) {
    if (!child.rect) continue;
    walk(child, (n) => {
      const real = realFileOf(n);
      if (real) map?.set(real.path, child);
    });
  }
  index.groupMaps.set(parent, map);
  return map;
}

/**
 * Package-level arcs, aggregated per direction. When both directions exist only
 * the dominant one is drawn (the sidebar reports both counts for a selection).
 */
function packageArcs(): Arc[] {
  const parent = groupingRoot();
  if (!parent) return [];
  const tops = (parent.children || []).filter((c) => c.rect);
  if (tops.length < 2) return [];
  const groupOf = groupMapFor(parent);
  const totals = new Map<string, { a: VNode; b: VNode; n: number }>();
  for (const e of state.data?.edges || []) {
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
  const net: Array<{ a: VNode; b: VNode; n: number }> = [];
  const done = new Set<string>();
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
  const first = list[0];
  if (!first) return [];
  const max = first.n;
  const arcs: Arc[] = [];
  for (const x of list) {
    const from = nodeAnchor(x.a);
    const to = nodeAnchor(x.b);
    if (!from || !to) continue;
    arcs.push({ from, to, strength: x.n / max });
  }
  return arcs;
}

function nodeAnchor(node: VNode): THREE.Vector3 | null {
  const r = node.rect;
  if (!r) return null;
  const y = plateTop(node.tier ?? node.depth ?? 0, node.type === 'file') + (node.type === 'file' ? 4 : 2);
  return new THREE.Vector3(r.x + r.w / 2, y, r.z + r.h / 2);
}

// ---------------------------------------------------------------------------
// People / PR layer
// ---------------------------------------------------------------------------

const PR_HIGH = 118;
const PR_LOW = 26;
const PR_STALE_DAYS = 30;

function buildPeopleLayer(): void {
  const prs = state.data?.prs || [];
  const draftFiles: VNode[] = [];
  const now = Date.now() / 1000;

  let maxWeight = 1;
  for (const pr of prs) maxWeight = Math.max(maxWeight, Math.log2(1 + prSize(pr)));

  for (const pr of prs) {
    const nodes = uniq(pr.files.map((p) => scope.byRealPath.get(p)).filter(hasRect));
    if (!nodes.length) continue;

    let cx = 0, cz = 0, top = 0;
    const targets: THREE.Vector3[] = [];
    for (const n of nodes) {
      const rect = n.rect;
      if (!rect) continue;
      cx += rect.x + rect.w / 2;
      cz += rect.z + rect.h / 2;
      const plate = plateTop(n.tier ?? n.depth ?? 0, n.type === 'file');
      top = Math.max(top, plate + tallest(n));
      if (targets.length < 20) targets.push(new THREE.Vector3(rect.x + rect.w / 2, plate, rect.z + rect.h / 2));
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

  const collisionFiles: VNode[] = [];
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

function hasRect(node: VNode | undefined): node is VNode {
  return !!node && !!node.rect;
}

/** additions+deletions when the data has them, else file count as a stand-in. */
function prSize(pr: Pr): number {
  const a = Number(pr.additions);
  const d = Number(pr.deletions);
  if (Number.isFinite(a) || Number.isFinite(d)) return (a || 0) + (d || 0);
  return pr.files.length * 40;
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function tallest(node: VNode): number {
  let m = 0;
  for (const p of node.plots || []) m = Math.max(m, buildingHeight(p.mod.loc));
  if (node.children) for (const c of node.children) m = Math.max(m, tallest(c));
  return m;
}

// ---------------------------------------------------------------------------
// Selection / focus
// ---------------------------------------------------------------------------

function setSelection(target: Target | null, opts: { keepSidebar?: boolean } = {}): void {
  state.selection = target;
  refreshSelectionBox();
  if (!opts.keepSidebar) sidebar.setSelection(target ? describe(target) : null);
  rebuildArcs();
  updateLabelCandidates();
}

function refreshSelectionBox(): void {
  const sel = state.selection;
  if (!sel) {
    selectionBox.visible = false;
    return;
  }
  if (sel.type !== 'pr' && sel.rec) {
    boxAroundInstance(selectionBox, sel.rec);
  } else if (sel.type !== 'pr' && sel.node.rect) {
    frameNodeBox(selectionBox, sel.node, boxHeightFor(sel.node));
  } else {
    selectionBox.visible = false;
  }
}

function boxAroundInstance(box: THREE.LineSegments, rec: ModuleRecord): void {
  rec.mesh.getMatrixAt(rec.instanceId, _m4);
  _m4.decompose(_v3, _q, _scale);
  box.position.set(_v3.x, _v3.y + _scale.y / 2, _v3.z);
  box.scale.set(_scale.x + 0.6, _scale.y + 0.6, _scale.z + 0.6);
  box.visible = true;
}

function boxHeightFor(node: VNode): number {
  const build = strata.build;
  if (build && node.type === 'file') return Math.max(build.heightOf(node) + 4, 10);
  if (node.type === 'file') return Math.max(tallest(node) + 4, 10);
  const r = node.rect;
  if (!r) return 18;
  return Math.max(Math.min(r.w, r.h) * 0.28, 18);
}

/**
 * Push (or pop) the focus stack and rebuild the whole scene for that node.
 * The anchor is the deeper node of the transition — the one whose footprint the
 * unfold animation grows out of (or folds back into).
 */
function focusNode(node: VNode | null | undefined, opts: { instant?: boolean } = {}): void {
  if (!node || node === state.focus) return;
  const prev = state.focus;
  const down = !!prev && isDescendantOf(node, prev);
  const anchor = down ? node : prev;
  // Drilling in, the intermediate levels only exist in the layout that is about
  // to be replaced, so their framings are captured before the rebuild.
  const via = !opts.instant && down && prev ? chainFramings(prev, node, { descend: true }) : undefined;
  state.focus = node;
  index.groupMaps.clear();
  rebuildScene({
    ...opts,
    anchor: opts.instant ? null : anchor,
    via,
    viaUpFrom: !opts.instant && !down && prev ? prev : null,
  });

  if (state.selection) sidebar.setSelection(describe(state.selection));
  else setSelection({ type: node.type, node, rec: null });
}

function isDescendantOf(node: VNode, ancestor: VNode): boolean {
  for (let n = node.parent; n; n = n.parent ?? null) if (n === ancestor) return true;
  return false;
}

/** The camera pose that frames a node in the layout it currently belongs to. */
function framingFor(node: VNode): Framing | null {
  const r = node.rect;
  if (!r) return null;
  const target = new THREE.Vector3(r.x + r.w / 2, plateTop(node.tier ?? node.depth ?? 0, node.type === 'file'), r.z + r.h / 2);
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
  return { pos, target };
}

/**
 * Fly to a node, optionally through the framings of the levels in between.
 * @param opts.via framings to pass through, in travel order
 */
function flyTo(node: VNode, opts: { instant?: boolean; via?: Framing[] } = {}): void {
  const to = framingFor(node);
  if (!to) return;

  if (opts.instant) {
    camera.position.copy(to.pos);
    controls.target.copy(to.target);
    controls.update();
    flight.active = false;
    return;
  }

  flight.from.pos.copy(camera.position);
  flight.from.target.copy(controls.target);
  // Drop waypoints the camera is effectively already at — a zero-length segment
  // would eat a slice of the eased parameter and stall the move.
  const points: Framing[] = [];
  let prev = flight.from;
  for (const f of opts.via ?? []) {
    if (f.pos.distanceTo(prev.pos) + f.target.distanceTo(prev.target) < 6) continue;
    points.push(f);
    prev = f;
  }
  points.push(to);

  flight.points = points;
  flight.t = 0;
  flight.dur = Math.min(0.75 + 0.28 * (points.length - 1), 1.7);
  flight.active = true;
}

/**
 * Framings of the levels strictly between `from` and `to`, in travel order,
 * evaluated against whatever layout is loaded right now.
 */
function chainFramings(from: VNode, to: VNode, opts: { descend: boolean }): Framing[] {
  const stop = opts.descend ? from : to;
  const between: VNode[] = [];
  for (let n = opts.descend ? to.parent : from.parent; n && n !== stop; n = n.parent ?? null) {
    // Only levels that are actually laid out right now have a real framing.
    if (!scope.nodes.has(n)) break;
    between.push(n);
  }
  if (opts.descend) between.reverse(); // parent chain runs deep -> shallow
  const out: Framing[] = [];
  for (const n of between.slice(0, 4)) {
    const f = framingFor(n);
    if (f) out.push(f);
  }
  return out;
}

const _oa = new THREE.Vector3();
const _ob = new THREE.Vector3();
const _da = new THREE.Vector3();
const _db = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * Interpolate between two framings around their (moving) pivot: the target
 * lerps, the camera offset slerps in direction and blends geometrically in
 * length. A straight positional lerp would dive through the city and make the
 * view snap to a new centre; this reads as one continuous orbit + dolly.
 */
function interpFraming(a: Framing, b: Framing, f: number, outPos: THREE.Vector3, outTarget: THREE.Vector3): void {
  outTarget.lerpVectors(a.target, b.target, f);
  _oa.subVectors(a.pos, a.target);
  _ob.subVectors(b.pos, b.target);
  const da = Math.max(_oa.length(), 1e-3);
  const db = Math.max(_ob.length(), 1e-3);
  _da.copy(_oa).divideScalar(da);
  _db.copy(_ob).divideScalar(db);

  const dot = Math.min(Math.max(_da.dot(_db), -1), 1);
  const ang = Math.acos(dot);
  if (ang < 1e-3) {
    _dir.copy(_db);
  } else {
    const s = Math.sin(ang);
    _dir.copy(_da).multiplyScalar(Math.sin((1 - f) * ang) / s).addScaledVector(_db, Math.sin(f * ang) / s);
    _dir.normalize();
  }
  outPos.copy(outTarget).addScaledVector(_dir, da * Math.pow(db / da, f));
}

// ---------------------------------------------------------------------------
// Descriptors for the sidebar
// ---------------------------------------------------------------------------

function describe(target: Target | null): Descriptor | null {
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

  // A strata level stands for one commit on that file — say which one.
  const level = target.level?.commit;
  return {
    name: mod ? mod.name : node.name,
    kind,
    kindColor: mod ? KIND_COLORS[mod.kind] ?? PALETTE.cyan : PALETTE.cyan,
    path: node.path,
    note: level ? `${level.h} · ${level.s}` : undefined,
    loc: mod ? mod.loc : node.loc,
    churn: node.churn,
    fixChurn: node.fixChurn,
    recentChurn: state.timeCursor === null ? node.recentChurn : recentValue(node).count,
    prs: real ? index.prsByFile.get(real.path) || [] : index.prsByNode.get(node) || [],
    coupling: state.coupling ? couplingSummary(node) : null,
    codePath: real ? real.path : null,
    span: mod && mod.line !== undefined && Number.isFinite(mod.line)
      ? { start: Math.max(1, mod.line), end: Math.max(1, mod.line) + Math.max(mod.loc, 1) }
      : null,
    deep: !!real,
  };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * The folders whose names are cut into their terrace side wall (top two tiers).
 * They are deliberately excluded from the floating label pills: the wall is the
 * more legible, more permanent piece of signage.
 */
const signedNodes = new Set<VNode>();

function terraceSignNodes(): VNode[] {
  signedNodes.clear();
  const root = scope.root;
  // Inside a file/module isolate the "districts" are identifiers, not places.
  if (!root || root.synth) return [];
  const base = groupingRoot() ?? root;
  for (const a of base.children || []) {
    if (a.type !== 'folder' || !a.rect) continue;
    signedNodes.add(a);
    for (const b of a.children || []) {
      if (b.type === 'folder' && b.rect) signedNodes.add(b);
    }
  }
  return [...signedNodes];
}

/** The labeler key for a node, also used to link parents to their children. */
function labelKey(node: VNode): string {
  return node.path + (node.type === 'file' ? '|f' : '|d');
}

function parentLabelKey(node: VNode): string | null {
  const p = node.parent;
  return p && scope.nodes.has(p) ? labelKey(p) : null;
}

function updateLabelCandidates(): void {
  if (!city || !scope.root) return;
  const list: LabelCandidate[] = [];

  walk(scope.root, (n) => {
    if (!n.rect) return;
    const size = Math.min(n.rect.w, n.rect.h);
    if (size < 3) return;
    const isFile = n.type === 'file';
    if (!isFile && n === scope.root && scope.root.depth === 0 && (n.children || []).length === 1) return;
    if (!isFile && signedNodes.has(n)) return; // its name is on the terrace wall
    list.push({
      key: labelKey(n),
      // Place names are city signage; file names are identifiers.
      text: isFile ? String(n.name) : String(n.name).toUpperCase(),
      tier: isFile ? 'file' : 'folder',
      pos: new THREE.Vector3(
        n.rect.x + n.rect.w / 2,
        plateTop(n.tier ?? n.depth ?? 0, isFile) + (isFile ? 5 : 9 + (n.depth ?? 0)),
        n.rect.z + n.rect.h / 2
      ),
      size,
      node: n,
      rec: null,
      parentKey: parentLabelKey(n),
    });
  });

  // Strata hides the buildings those labels would point at.
  const many = strata.build !== null || city.moduleRecords.length > MODULE_LABEL_BUDGET;
  const selNode = strata.build || !state.selection || state.selection.type === 'pr'
    ? null : realFileOf(state.selection.node);
  for (const rec of city.moduleRecords) {
    if (many && (!selNode || realFileOf(rec.file) !== selNode)) continue;
    list.push({
      key: rec.file.path + '#' + rec.mod.name,
      text: String(rec.mod.name),
      tier: 'module',
      pos: new THREE.Vector3(rec.center.x, (rec.file.top ?? 0) + rec.height + 2.5, rec.center.z),
      size: Math.max(rec.height, 3),
      node: rec.file,
      rec,
      parentKey: labelKey(rec.file),
    });
  }

  labeler.setCandidates(list);
  updateLeaderFocus();
}

/** Leader lines follow whatever the pointer or the selection is pointing at. */
function updateLeaderFocus(): void {
  const keys: string[] = [];
  for (const t of [state.hover, state.selection]) {
    if (!t || t.type === 'pr') continue;
    const node = t.rec ? t.rec.file : t.node;
    const key = labelKey(node);
    if (!keys.includes(key)) keys.push(key);
  }
  labeler.setFocusKeys(keys);
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function bindEvents(): void {
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

  let downAt: { x: number; y: number } | null = null;
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
    // The palette owns the keyboard while it is open — Escape must close it
    // only, never also pop the focus scope.
    if (search && search.isOpen()) return;
    if (isEditable(e.target)) return;
    // A running tour owns Escape and the arrows before anything else does.
    if (tour && tour.isActive()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        tour.exit();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        tour.next();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        tour.prev();
        return;
      }
    }
    if (e.key === 'Escape') {
      const up = state.focus?.parent;
      if (up) focusNode(up);
    }
    if (e.key === 'c' && !e.metaKey && !e.ctrlKey) {
      const sel = state.selection;
      const node = sel && sel.type !== 'pr' ? sel.node : state.focus;
      if (!node || !node.path) return;
      navigator.clipboard?.writeText(node.path).then(
        () => showNotice('Path copied: ' + node.path),
        () => showNotice('Clipboard unavailable')
      );
    }
  });

  window.addEventListener('resize', onResize);
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement) || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable === true;
}

/** Which node a double-click isolates: buildings drill into their module. */
function focusTargetFor(hit: NodeTarget): VNode {
  if (hit.rec) {
    const file = hit.rec.file;
    return file.synth ? file : moduleNode(file, hit.rec.mod, file);
  }
  return hit.node;
}

function onResize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.setSize(w, h);
}

function updateHover(): void {
  if (!pointerDirty) return;
  pointerDirty = false;

  if (!pointerInside) {
    setHover(null);
    return;
  }
  raycaster.setFromCamera(pointer, camera);
  // Signage draws over everything, so it also wins the pick: a name you can
  // read is a name you can click.
  overlayPickables.length = 0;
  for (const o of labeler.pickables()) overlayPickables.push(o);
  for (const o of terraceSigns.pickables()) overlayPickables.push(o);
  const first = raycaster.intersectObjects(overlayPickables, false)[0]
    ?? raycaster.intersectObjects(pickables, false)[0];
  setHover(first ? resolveHit(first) : null);
}

function resolveHit(hit: THREE.Intersection): Target | null {
  if (!city) return null;
  const o = hit.object;
  const id = hit.instanceId;
  const build = strata.build;
  // A label / terrace sign resolves to whatever it names.
  if (o.userData.pickType === 'label' || o.userData.pickType === 'terrace') {
    const node: VNode | undefined = o.userData.node;
    if (!node) return null;
    const rec: ModuleRecord | null = o.userData.rec ?? null;
    return rec ? { type: 'module', rec, node: rec.file } : { type: node.type, node, rec: null };
  }
  if (build && o === build.mesh) {
    const level = id === undefined ? undefined : build.records[id];
    return level ? { type: 'file', node: level.file, rec: null, level } : null;
  }
  const meta: ModuleRecord[] | null = Array.isArray(o.userData.meta) ? o.userData.meta : null;
  if (meta) {
    const rec = id === undefined ? undefined : meta[id];
    return rec ? { type: 'module', rec, node: rec.file } : null;
  }
  if (o === city.filePlates) {
    const rec = id === undefined ? undefined : city.fileRecords[id];
    return rec ? { type: 'file', node: rec.node, rec: null } : null;
  }
  if (o === city.folderPlates) {
    const rec = id === undefined ? undefined : city.folderRecords[id];
    return rec ? { type: 'folder', node: rec.node, rec: null } : null;
  }
  if (o.userData.pickType === 'pr') return { type: 'pr', pr: o.userData.pr };
  return null;
}

// --- hover callout: name pill raised above the hovered thing, line down -----

const callout: { sprite: THREE.Sprite | null; line: THREE.Line | null; anchor: THREE.Vector3; aspect: number } = {
  sprite: null,
  line: null,
  anchor: new THREE.Vector3(),
  aspect: 1,
};

function clearCallout(): void {
  if (callout.sprite) {
    scene.remove(callout.sprite);
    disposeObject(callout.sprite);
    callout.sprite = null;
  }
  if (callout.line) {
    scene.remove(callout.line);
    callout.line.geometry.dispose();
    const m = callout.line.material;
    if (Array.isArray(m)) for (const mm of m) mm.dispose();
    else m.dispose();
    callout.line = null;
  }
}

function showCallout(hit: NodeTarget, name: string): void {
  clearCallout();
  if (hit.type === 'module' && hit.rec) {
    hit.rec.mesh.getMatrixAt(hit.rec.instanceId, _m4);
    _m4.decompose(_v3, _q, _scale);
    callout.anchor.set(_v3.x, _v3.y + _scale.y, _v3.z);
  } else {
    const r = hit.node.rect;
    if (!r) return;
    const top = plateTop(hit.node.tier ?? hit.node.depth ?? 0, hit.node.type === 'file');
    callout.anchor.set(r.x + r.w / 2, top + boxHeightFor(hit.node), r.z + r.h / 2);
  }
  const sprite = makeLabelSprite(name, { color: '#eafcff', worldHeight: 10 });
  callout.aspect = sprite.scale.y > 0 ? sprite.scale.x / sprite.scale.y : 1;
  sprite.renderOrder = 12;
  scene.add(sprite);
  callout.sprite = sprite;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(
    geom,
    new THREE.LineBasicMaterial({
      color: PALETTE.cyan,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    })
  );
  line.renderOrder = 11;
  line.frustumCulled = false;
  scene.add(line);
  callout.line = line;
  updateCallout();
}

/** Per-frame: constant apparent size, leader line from the anchor up to the pill. */
function updateCallout(): void {
  const sprite = callout.sprite;
  const line = callout.line;
  if (!sprite || !line) return;
  const dist = camera.position.distanceTo(callout.anchor);
  const h = Math.min(Math.max(dist * 0.021, 3.5), 34);
  const rise = h * 2.4;
  sprite.scale.set(h * callout.aspect, h, 1);
  sprite.position.set(callout.anchor.x, callout.anchor.y + rise + h / 2, callout.anchor.z);
  const attr = line.geometry.getAttribute('position');
  if (attr instanceof THREE.BufferAttribute) {
    attr.setXYZ(0, callout.anchor.x, callout.anchor.y + 0.5, callout.anchor.z);
    attr.setXYZ(1, callout.anchor.x, callout.anchor.y + rise, callout.anchor.z);
    attr.needsUpdate = true;
  }
}

function setHover(hit: Target | null): void {
  const prev = state.hover;
  const same =
    hit && prev && hit.type === prev.type &&
    (hit.type === 'pr' ? prev.type === 'pr' && hit.pr === prev.pr
      : hit.type === 'module' ? prev.type !== 'pr' && hit.rec === prev.rec
      : prev.type !== 'pr' && hit.node === prev.node && hit.level === prev.level);
  if (same) return;
  if (!hit && !prev) return;

  state.hover = hit;
  document.body.style.cursor = hit ? 'pointer' : 'default';
  highlightPrLinks();
  updateLeaderFocus();

  if (!hit) {
    hoverBox.visible = false;
    clearCallout();
    sidebar.setHover(null);
    return;
  }

  if (hit.type === 'module' && hit.rec) boxAroundInstance(hoverBox, hit.rec);
  else if (hit.type === 'pr') hoverBox.visible = false;
  else frameNodeBox(hoverBox, hit.node, boxHeightFor(hit.node));

  const desc = describe(hit);
  if (hit.type !== 'pr' && desc) showCallout(hit, desc.name);
  else clearCallout();
  sidebar.setHover(desc);
}

/** Hovering an avatar brightens that PR's beams and file rings. */
function highlightPrLinks(): void {
  const hoveredPr = state.hover && state.hover.type === 'pr' ? state.hover.pr : null;
  for (const g of peopleGroup.children) {
    const u = g.userData;
    const on = hoveredPr && u.pr === hoveredPr;
    if (u.links) u.links.material.opacity = on ? 0.85 : u.linkBase;
    if (u.rings) u.rings.material.opacity = on ? 0.95 : u.ringBase;
    if (u.beam) {
      const mu = u.beam.material.userData ?? {};
      u.beam.material.opacity = on ? (mu.hover ?? 0.42) : (mu.base ?? u.beam.material.opacity);
    }
  }
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();
let fpsAccum = 0;
let fpsFrames = 0;

function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;

  if (flight.active) {
    flight.t = Math.min(flight.t + dt / flight.dur, 1);
    const n = flight.points.length;
    const x = easeInOutCubic(flight.t) * n;
    const i = Math.min(Math.floor(x), n - 1);
    const a = i === 0 ? flight.from : flight.points[i - 1];
    const b = flight.points[i];
    if (a && b) interpFraming(a, b, x - i, camera.position, controls.target);
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
    if (strata.dirty && strata.build) {
      strata.acc += dt;
      if (strata.acc > 0.1) {
        strata.acc = 0;
        strata.dirty = false;
        updateStrata();
      }
    }
    recency.acc += dt;
    if (recency.dirty && recency.acc > 0.12) {
      recency.acc = 0;
      recency.dirty = false;
      recomputeRecency();
      applyOverlay();
    }
  }

  if (tour) tour.tick(dt);
  // The orbit treatment must not fight a camera flight, which writes the
  // position directly a few lines above.
  controls.autoRotate = orbitWanted && !flight.active;
  controls.autoRotateSpeed = 0.35;

  controls.update();
  // Mid-transition the stage is still folded, so world-space picking, labels
  // and highlight boxes would all point at the wrong place.
  const settled = transition.t >= 1;
  labeler.group.visible = settled;
  terraceSigns.group.visible = settled;
  if (settled) {
    updateHover();
    labeler.update(dt);
    terraceSigns.update(dt);
  } else {
    hoverBox.visible = false;
    selectionBox.visible = false;
  }
  updatePeople(t);
  updateCallout();
  if (arcFlow) arcFlow.update(t);

  for (const group of [scaffoldGroup, worktreeGroup]) {
    for (const c of group.children) {
      const rate = c.userData.pulseRate || 2.4;
      const mat = 'material' in c ? c.material : null;
      if (mat instanceof THREE.Material) mat.opacity = 0.42 + 0.34 * (0.5 + 0.5 * Math.sin(t * rate));
    }
  }
  pulseSearchCursor(t);
  if (settled && state.selection) refreshSelectionBox();
  if (selectionBox.visible && selectionBox.material instanceof THREE.Material) {
    selectionBox.material.opacity = 0.55 + 0.4 * (0.5 + 0.5 * Math.sin(t * 3.2));
  }

  composer.render();

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    dom.statFps.textContent = String(Math.round(fpsFrames / fpsAccum));
    fpsAccum = 0;
    fpsFrames = 0;
  }
}

function updatePeople(t: number): void {
  if (!state.people) return;
  for (const g of peopleGroup.children) {
    const u = g.userData;
    if (!u.sprite) continue;
    const bob = Math.sin(t * (u.bobSpeed || 0.9) + u.phase) * (u.bobAmp || 3.2);
    u.sprite.position.y = u.baseY + bob;
    u.beam.scale.y = 1 + bob / Math.max(u.baseY, 1);
  }
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return Number(n || 0).toLocaleString('en-US');
}

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} in the HUD markup`);
  return el;
}

/** `Element.closest` from an event target that may not be an element at all. */
function closest(target: EventTarget | null, selector: string): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(selector) : null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Deterministic synthetic dataset (used when data.json is missing/invalid)
// ---------------------------------------------------------------------------

function makeFakeData(): CityData {
  const rnd = mulberry32(0x5eed1337);
  function pick<T>(arr: readonly T[]): T {
    const v = arr[Math.floor(rnd() * arr.length) % arr.length];
    if (v === undefined) throw new Error('pick from an empty list');
    return v;
  }
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

  const packages = ['canvas', 'runtime', 'ui-kit'];
  const subdirs = ['src/core', 'src/model', 'src/render', 'src/hooks', 'src/util'];
  const fileStems = [
    'index', 'graph-store', 'node-view', 'edge-router', 'selection', 'viewport',
    'use-canvas', 'serializer', 'validator', 'theme', 'shortcuts', 'toolbar',
    'panel', 'layout-engine', 'diff', 'telemetry', 'registry', 'schema',
  ];
  const kinds: ModuleKind[] = ['function', 'class', 'component', 'interface', 'type', 'enum', 'const'];
  const memberKinds: MemberKind[] = ['method', 'property', 'accessor', 'member'];

  const root = folder('packages', 'packages');
  const allFiles: FileNode[] = [];
  let made = 0;

  for (const pkg of packages) {
    const pkgNode = folder(pkg, `packages/${pkg}`);
    root.children.push(pkgNode);

    const dirs = subdirs.slice(0, int(3, 5));
    for (const dir of dirs) {
      if (made >= 42) break;
      const parts = dir.split('/');
      let parent = pkgNode;
      for (const part of parts) {
        const path = `${parent.path}/${part}`;
        const existing = parent.children.find((c) => c.path === path);
        if (existing && existing.type === 'folder') {
          parent = existing;
        } else {
          const next = folder(part, path);
          parent.children.push(next);
          parent = next;
        }
      }

      const nFiles = int(2, 4);
      for (let i = 0; i < nFiles && made < 42; i++) {
        const stem = fileStems[(made * 7 + i * 3) % fileStems.length] ?? 'index';
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
          const mod: ModuleInfo = {
            name: `${stem.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}${k ? k : ''}`,
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
        const file: FileNode = {
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
  const seen = new Set<string>();
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

  /** Aggregates are recomputed by normalizeTree, so they start at zero. */
  function folder(name: string, path: string): FolderNode {
    return { type: 'folder', name, path, loc: 0, churn: 0, fixChurn: 0, recentChurn: 0, children: [] };
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
