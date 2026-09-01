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
import type {
  CityData, DiffFile, FileNode, FolderNode, MemberKind, ModuleInfo, ModuleKind, Pr,
} from '../../shared/types.js';
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
import { createSearch, type HighlightSpec, type SearchPalette, type SearchResultsPayload } from './search.js';
import type { TourTarget } from '../../shared/tour.js';
import { validateCheckpoints } from '../../shared/tour.js';
import { createTour, type TourPlayer } from './tour.js';
import { createCheckpoints, type Checkpoints } from './checkpoints.js';
import {
  buildStrataIndex, createStrata, commitTypePaint, commitTypeKey,
  COMMIT_TYPE_COLORS, COMMIT_TYPE_ORDER,
  type StrataBuild, type StrataCommit, type StrataIndex, type StrataPaint, type StrataRecord,
  type FileFilter, type LevelFilter,
} from './strata.js';
import { asVNode, type AnyKind, type VMod, type VNode } from './vtree.js';

const MAX_ARCS = 150;
const DAY = 86400;
/**
 * Scope transition: contents unfold out of (or fold back into) the parent
 * footprint. This is only the *fallback* length — a transition that rides a
 * camera flight is stretched to that flight instead (`syncTransitionToFlight`).
 */
const TRANSITION_DUR = 0.42;

// --- Motion tuning ---------------------------------------------------------
/**
 * Camera framings are computed at this FOV even while a dive is breathing, so
 * a flight retargeted mid-breath still frames its destination correctly.
 */
const BASE_FOV = 46;
/** Samples per framing-to-framing segment fed to the spline fit. */
const FLIGHT_SAMPLES = 12;
/** Stations the bearing / pitch / distance schedules are sampled at. */
const SCHEDULE_STATIONS = 128;
/** Resolution of the spline's arc-length table (see flyTo). */
const ARC_DIVISIONS = 1200;
/** Fraction of the flight the outgoing scope takes to fade away. */
const GHOST_FADE = 0.85;
/**
 * Corner-cutting passes over the evenly-spaced route. The framings of a nest of
 * folders zig-zag — each level's centre can sit on the far side of its parent's
 * — and a curve dragged through all of them doubles back on itself inside a
 * single frame. Enough passes to smooth over a whole segment's wavelength turns
 * that zig-zag into the arc a crane would actually swing through.
 */
const CORNER_RELAX = 40;
/** A stop must advance at least this much of the way to the destination. */
const ROUTE_MIN_ADVANCE = 0.08;
/** How far a stop may bow the route sideways, as a fraction of its length. */
const ROUTE_MAX_BOW = 0.22;
/** Control points on the fitted curve, evenly spaced along the route. */
const CONTROL_POINTS = 64;
/** Ease ramp fraction: half (a plain ease-in-out) for a hop, a third — with a
 * constant-speed cruise between — for a multi-level jump. */
const RAMP_SHORT = 0.5;
const RAMP_LONG = 0.3;
/** Degrees of FOV added at mid-flight on a long inward dive. */
const FOV_BREATH = 2;
/** Clearance the crane arc keeps over the tallest thing in the scope. */
const FLIGHT_CLEARANCE = 1.16;
/**
 * The final approach: once the camera is within this multiple of the orbit
 * distance it is heading for, it has arrived and may descend into the city.
 */
const APPROACH_RADIUS = 3;
/**
 * Crane exponents on the geometric close-in: >1 holds a dive high and brings it
 * down late, <1 gets a climb its height early. Raised further, up to SKEW_MAX,
 * when that is what it takes to clear the skyline — capped, because a target
 * that ends up closer to its plate than the city is tall cannot be reached
 * without descending through the skyline, and hovering to the last moment and
 * then dropping is worse than starting down a little sooner.
 */
const SKEW_IN = 1.75;
const SKEW_OUT = 0.6;
const SKEW_MAX = 3.5;
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

/**
 * The mode never changes the massing — the stacked strata silhouette is shared
 * by all five at folder scope (see `strataActive`). It only changes the PAINT:
 * `strata` colors each level by its commit type, the other four color a file's
 * whole stack by that file's metric.
 *
 * `prov` only exists when the analyzer ran with `--diff` (see "PR provenance").
 */
type Mode = 'structure' | 'churn' | 'fix' | 'recent' | 'strata' | 'prov';

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
  fx: false,
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
  provBtn: requireEl('mode-prov'),
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
let checkpoints: Checkpoints;
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
 * Camera flight as ONE move, in the camera's own coordinates.
 *
 * The orbit TARGET follows a smooth spline through the centres of every level
 * the jump passes; the camera is hung off that target by a bearing, a pitch and
 * a distance, and each of those three makes exactly one monotone move from the
 * pose the camera is in to the pose the destination framing asks for. Threading
 * the camera itself through the intermediate framings is what made a dive wobble
 * and tilt — a nest of treemap cells puts consecutive centres on alternating
 * sides, and a curve dragged through their bearings zig-zags.
 *
 * The derived path is then walked by *arc length* under a single global ease, so
 * apparent speed is even from end to end.
 */
const flight: {
  active: boolean;
  t: number;
  /** Eased progress along the path, 0..1 — the unfold rides this too. */
  e: number;
  dur: number;
  ramp: number;
  /** Normalized initial ease slope — non-zero only when retargeting mid-flight. */
  v0: number;
  /** The path the orbit TARGET travels; the camera is hung off it. */
  path: THREE.CatmullRomCurve3 | null;
  /** Monotone bearing / pitch / distance schedules, sampled per station. */
  azim: Float64Array;
  polar: Float64Array;
  dist: Float64Array;
  /** Height of the target's path at each station, for the clearance solve. */
  groundY: Float64Array;
  /** Cumulative APPARENT length of the derived camera path, per station. */
  arc: Float64Array;
  /** The same path in world units — only the retarget speed match needs it. */
  worldLength: number;
  /** Extra degrees of FOV at mid-flight; a long dive breathes, a short hop does not. */
  breath: number;
  /** Camera speed measured last frame, in world units per second. */
  speed: number;
  /** Waypoints after the start pose — kept for a same-frame retarget (see flyTo). */
  route: Framing[];
} = {
  active: false,
  t: 0,
  e: 0,
  dur: 1.1,
  ramp: 0.5,
  v0: 0,
  path: null,
  azim: new Float64Array(SCHEDULE_STATIONS + 1),
  polar: new Float64Array(SCHEDULE_STATIONS + 1),
  dist: new Float64Array(SCHEDULE_STATIONS + 1),
  groundY: new Float64Array(SCHEDULE_STATIONS + 1),
  arc: new Float64Array(SCHEDULE_STATIONS + 1),
  worldLength: 0,
  breath: 0,
  speed: 0,
  route: [],
};
const _sphA = new THREE.Spherical();
const _sphB = new THREE.Spherical();
const _flightA = new THREE.Vector3();
const _flightB = new THREE.Vector3();
const _flightT = new THREE.Vector3();
const _flightP = new THREE.Vector3();

/**
 * Scope transition: the new scene starts mapped onto the old footprint and
 * unfolds. `delay` and `dur` are re-scheduled against every flight so the
 * unfold lands just before the camera settles (see `syncTransitionToFlight`).
 */
const transition: {
  t: number;
  dur: number;
  delay: number;
  k0: number;
  /** Stage-local point that stays pinned, and the world point it is pinned to. */
  anchor: THREE.Vector3;
  pin: THREE.Vector3;
  /**
   * 'flight' ties the unfold to the camera's own eased progress — one gesture,
   * one velocity curve. 'clock' runs it on its own timer (no flight, or the
   * user grabbed the camera and the unfold has to finish by itself).
   */
  drive: 'clock' | 'flight';
  /** Window of the flight's progress the unfold occupies, when flight-driven. */
  from: number;
  to: number;
  mats: Array<{ m: THREE.Material; base: number }>;
} = {
  t: 1, dur: TRANSITION_DUR, delay: 0, k0: 1,
  anchor: new THREE.Vector3(), pin: new THREE.Vector3(),
  drive: 'clock', from: 0, to: 1, mats: [],
};
/**
 * Translation applied to the current scope's layout so that it stands where it
 * stood before the rebuild (see `startTransition`). Every world position
 * derived from a layout rect — camera framings, labels, callouts — carries it.
 */
const stageHome = new THREE.Vector3();
/** The previous scope, standing and fading while the new one opens (retireCity). */
let ghost: { group: THREE.Group; mats: Array<{ m: THREE.Material; base: number }>; t: number } | null = null;
/** Transit dressing: labels, signage and callouts fade out on launch, in on arrival. */
const dressing = { v: 1, frozen: false };
/**
 * Strata render mode. The index is built once, on first use; the mesh is rebuilt
 * per scope and only *refilled* (throttled) while either timeline handle moves.
 */
const strata: {
  index: StrataIndex | null;
  build: StrataBuild | null;
  dirty: boolean;
  acc: number;
  /**
   * The legend filter. `types` are commit-type swatch keys (see `commitTypeKey`);
   * empty = no filter. `collapse` promotes the same set from a highlight (others
   * ghost) to a massing predicate (others are not built at all).
   */
  filter: { types: Set<string>; collapse: boolean };
} = {
  index: null, build: null, dirty: false, acc: 0,
  filter: { types: new Set(), collapse: false },
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
  pulseStrata: number[];
} = {
  on: false,
  paths: null,
  cursor: null,
  pulseRecs: [],     // instance records under the keyboard cursor
  pulseMeshes: [],   // their meshes, for a single needsUpdate per frame
  pulseStrata: [],   // strata instance ids under the cursor, same job
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
  initDiffScope(data);
  CITY_SIZE = cityExtent(index.filesByPath.size);

  initScene();

  timeline = createTimeline(data, {
    onChange: onTimeCursor,
    onRange: () => { strata.dirty = true; },
  });
  checkpoints = createCheckpoints();
  sidebar = createSidebar({ host, timeline, githubUrl: data.repo?.githubUrl });
  labeler = createLabeler(scene, camera);
  search = createSearch({
    getRoot: () => state.root ?? asVNode(data.tree),
    highlight: setSearchHighlight,
    reveal: revealPath,
    notice: showNotice,
    search: (q) => host.search(q),
    results: setSearchResults,
  });

  state.focus = state.root;
  buildStaticScene();
  rebuildScene({ instant: true });
  buildHud();
  bindEvents();
  tour = createTourPlayer();
  installScriptHooks();
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

  camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 1, 8000);
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
  // FX defaults off; the toggle enables bloom + the CRT overlay together.
  bloom.enabled = state.fx;
  const crtInit = document.getElementById('crt');
  if (crtInit) crtInit.style.display = state.fx ? 'block' : 'none';
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
  // On the stage, not in the scene: both are placed from layout rects, which
  // are stage-local, and they must follow the stage's home offset.
  stage.add(selectionBox, hoverBox);

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
  // Captured against the layout that is about to be replaced, so it carries
  // that layout's home offset: this is the WORLD spot the anchor stands on.
  const from = opts.anchor ? footprintOf(opts.anchor, scope.root) : null;
  if (from) {
    from.cx += stageHome.x;
    from.cy += stageHome.y;
    from.cz += stageHome.z;
  }
  clearCallout();
  if (city) {
    retireCity(city.group);
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
  if (probe && from) probe.markRebuild(from);
  // Zooming out, the levels we pass through only exist in the layout that was
  // just built, so their framings are collected here rather than by the caller.
  const upFrom = opts.viaUpFrom;
  const via = upFrom ? chainFramings(upFrom, focus, { descend: false }) : opts.via;
  flyTo(root, { instant: opts.instant, via });
  syncTransitionToFlight();
}

/**
 * Make the unfold and the flight one gesture. Drilling in, the scene grows for
 * most of the trip and finishes just before the camera settles, so you arrive
 * *as* the block finishes opening rather than onto a scene that opened without
 * you. Zooming out is the opposite errand — the parent city reassembles first,
 * and the camera then pulls back off a city that is already whole.
 */
function syncTransitionToFlight(): void {
  if (transition.t >= 1) return;
  if (!flight.active) {
    transition.dur = TRANSITION_DUR;
    transition.delay = 0;
    return;
  }
  transition.drive = 'flight';
  if (transition.k0 < 1) {
    // Drilling in: the section keeps opening for most of the trip and is done
    // just before the camera settles, so you arrive *as* it finishes.
    transition.from = 0.04;
    transition.to = 0.86;
  } else {
    // Backing out: the parent city reassembles first, and the camera then pulls
    // back off something that is already whole.
    transition.from = 0;
    transition.to = 0.55;
  }
}

/**
 * The city you were just looking at does not vanish the instant you drill into
 * it. It is parked, at the world position it already had, and faded out over the
 * first part of the flight — so the block you picked grows out of a city that is
 * still standing around it instead of out of an empty grid.
 */
function retireCity(group: THREE.Object3D): void {
  if (ghost) disposeGhost();
  const holder = new THREE.Group();
  holder.name = 'ghost';
  // The old layout belongs to the old home; the stage is about to move to a new
  // one, so the ghost keeps its own copy of where the world used to be.
  holder.position.copy(stageHome);
  stage.remove(group);
  holder.add(group);
  scene.add(holder);

  const mats: Array<{ m: THREE.Material; base: number }> = [];
  holder.traverse((o) => {
    const mat = 'material' in o ? o.material : null;
    if (!(mat instanceof THREE.Material)) return;
    mats.push({ m: mat, base: mat.transparent ? mat.opacity : 1 });
    mat.transparent = true;
    mat.depthWrite = false;
  });
  ghost = { group: holder, mats, t: 0 };
}

function disposeGhost(): void {
  if (!ghost) return;
  scene.remove(ghost.group);
  disposeObject(ghost.group);
  ghost = null;
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
 * Every scope is laid out around the origin, so a naive rebuild would teleport
 * the section under the camera and the flight would have to absorb the jump.
 * Instead the stage is *homed*: the new layout is translated so the anchor —
 * the node being drilled into, or the child being backed out of — lands exactly
 * on the world position it already occupied, and then only the SCALE animates.
 * The section grows (or folds) about the spot it already stood on; nothing in
 * the world slides sideways, and the camera is left with a modest dolly.
 */
function startTransition(from: Footprint | null, to: Footprint | null): void {
  transition.mats = [];
  stage.traverse((o) => {
    const mat = 'material' in o ? o.material : null;
    if (mat instanceof THREE.Material && mat.transparent) transition.mats.push({ m: mat, base: mat.opacity });
  });
  transition.dur = TRANSITION_DUR;
  transition.delay = 0;
  transition.drive = 'clock';
  if (!from || !to || !to.size || !from.size) {
    transition.t = 1;
    transition.k0 = 1;
    transition.anchor.set(0, 0, 0);
    stageHome.set(0, 0, 0);
    stage.scale.setScalar(1);
    stage.position.set(0, 0, 0);
    envGroup.position.set(0, 0, 0);
    return;
  }
  const k = Math.min(Math.max(from.size / to.size, 0.01), 60);
  transition.k0 = k;
  // Local point that must stay pinned, and the world point it is pinned to.
  transition.anchor.set(to.cx, to.cy, to.cz);
  transition.pin.set(from.cx, from.cy, from.cz);
  stageHome.copy(transition.pin).sub(transition.anchor);
  transition.t = 0;
  applyStageTransform(k);
  envGroup.position.copy(stageHome);
}

/** Place the stage at scale `s` with the anchor still pinned to its old spot. */
function applyStageTransform(s: number): void {
  stage.scale.setScalar(s);
  stage.position.set(
    transition.pin.x - s * transition.anchor.x,
    transition.pin.y - s * transition.anchor.y,
    transition.pin.z - s * transition.anchor.z
  );
}

/**
 * Homing accumulates a small drift away from the origin every time the scope
 * changes. Once everything has settled, shift the whole world — stage, camera
 * and orbit target together — back to the origin. Camera-relative, so nothing
 * moves on screen; only the derived world positions have to be rebuilt.
 */
function rehomeStage(): void {
  if (stageHome.lengthSq() < 1) return;
  camera.position.sub(stageHome);
  controls.target.sub(stageHome);
  stageHome.set(0, 0, 0);
  transition.pin.set(0, 0, 0);
  transition.anchor.set(0, 0, 0);
  stage.position.set(0, 0, 0);
  stage.scale.setScalar(1);
  envGroup.position.set(0, 0, 0);
  controls.update();
  clearCallout();
  updateLabelCandidates();
  refreshSelectionBox();
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
    const clicked = btn.dataset.mode;
    if (!isMode(clicked)) return;
    // "Fix hotspots" is a shortcut, not a paint: wherever there are stacks to
    // filter it lands you in Strata with the fix swatch selected, which says the
    // same thing per commit instead of per file. The old flat heat ramp is only
    // the fallback for a city with no stacks (v1 data, or inside an isolate).
    if (clicked === 'prov' && !diffAvailable()) {
      showNotice('Provenance needs a diff — re-run the analyzer with --diff <base>..<head>');
      return;
    }
    const asFixFilter = clicked === 'fix' && strata.build !== null;
    const mode = asFixFilter ? 'strata' : clicked;
    state.mode = mode;
    for (const b of dom.modes.querySelectorAll<HTMLElement>('button.mode')) {
      b.classList.toggle('active', b.dataset.mode === mode);
    }
    if (asFixFilter) {
      strata.filter.types.clear();
      strata.filter.types.add('fix');
      const wasCollapse = strata.filter.collapse;
      strata.filter.collapse = false;
      applyOverlay();
      applyStrataFilter(wasCollapse);
      showNotice('Fix hotspots · strata filtered to fix commits — "only" compresses to fix mass');
      return;
    }
    if (mode === 'strata' && !timeline.enabled) showNotice('Strata needs a commit stream — re-run the analyzer');
    if (mode === 'strata' && !strataActive() && timeline.enabled) {
      showNotice('Per-commit levels are city-level massing — Esc back out of this isolate');
    }
    // The massing is shared, so switching mode is a recolor and nothing else.
    applyOverlay();
    renderLegend();
  });

  dom.legend.addEventListener('click', (e) => {
    const ctl = closest(e.target, 'button.fbtn');
    if (ctl) {
      if (ctl.dataset.filter === 'clear') clearStrataFilter();
      else if (ctl.dataset.filter === 'collapse') toggleFilterCollapse();
      else if (ctl.dataset.filter === 'diff-only') toggleDiffCollapse();
      return;
    }
    const type = closest(e.target, '.row.f')?.dataset.type;
    if (type) toggleFilterType(type);
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
    || value === 'recent' || value === 'strata' || value === 'prov';
}

function renderLegend(): void {
  const rows: string[] = [];
  const stacked = strata.build !== null;
  if (state.mode === 'structure') {
    const kinds = scope.root && scope.root.synth ? [...KIND_ORDER, ...MEMBER_ORDER] : [...KIND_ORDER];
    for (const kind of kinds) {
      const hex = '#' + KIND_COLORS[kind].toString(16).padStart(6, '0');
      rows.push(`<div class="row"><i class="sw" style="background:${hex};box-shadow:0 0 8px ${hex}"></i><span>${kind}</span></div>`);
    }
    // At folder scope a whole stack takes its file's dominant kind; the kinds
    // themselves become buildings once you isolate into the file.
    if (stacked) rows.push(`<div class="row"><span>file = dominant kind · isolate for modules</span></div>`);
  } else if (state.mode === 'recent') {
    rows.push(
      `<div class="row"><i class="sw" style="background:#4ade80;box-shadow:0 0 8px #4ade80"></i><span>touched &lt; 30d</span></div>`,
      `<div class="row"><i class="sw" style="background:#1b2432"></i><span>dormant</span></div>`
    );
  } else if (state.mode === 'prov') {
    // Three buckets over the whole diff — the same shares the buildings mix.
    const t = diffScope.total;
    const adds = Math.max(t.verbatim + t.reshaped + t.new, 1);
    const buckets: Array<[string, THREE.Color, number]> = [
      ['verbatim · skip', PROV_VERBATIM, t.verbatim],
      ['reshaped · check', PROV_RESHAPED, t.reshaped],
      ['new · read', PROV_NEW, t.new],
    ];
    for (const [label, color, n] of buckets) {
      const hex = '#' + color.getHexString();
      rows.push(
        `<div class="row"><i class="sw" style="background:${hex};box-shadow:0 0 8px ${hex}"></i>` +
        `<span>${label} · ${Math.round((100 * n) / adds)}%</span></div>`
      );
    }
    rows.push(
      `<div class="row"><i class="sw" style="background:#1b2432"></i><span>untouched by the diff</span></div>`,
      `<div class="row"><span>file hue = its share of lines to read</span></div>`,
      diffScopeControlHtml(),
      `<div class="row"><span>+${fmt(adds)} lines · ${escapeHtml(diffScope.base.slice(0, 7))}..${escapeHtml(diffScope.head.slice(0, 7))}</span></div>`
    );
  } else if (state.mode === 'strata') {
    // One level per commit, hue = the kind of change that commit was — and each
    // swatch is also the filter for that kind (see `toggleFilterType`).
    const on = filterActive();
    for (const type of COMMIT_TYPE_ORDER) {
      const hex = '#' + (COMMIT_TYPE_COLORS[type] ?? PALETTE.cyan).toString(16).padStart(6, '0');
      const sel = strata.filter.types.has(type);
      const cls = 'row f' + (sel ? ' on' : on ? ' off' : '');
      rows.push(
        `<div class="${cls}" data-type="${type}" title="Filter the stacks to ${type} commits">` +
        `<i class="sw" style="background:${hex};box-shadow:0 0 8px ${hex}"></i><span>${type}</span></div>`
      );
    }
    rows.push(filterControlsHtml());
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
    // Fix hotspots is a shortcut into the filtered strata everywhere it can be;
    // this flat heat ramp is what is left when there are no stacks to filter.
    if (state.mode === 'fix' && !stacked) {
      rows.push(`<div class="row"><span>no stacks here — heat fallback</span></div>`);
    }
  }
  // Strata mode names the massing in its own block; every other mode gets the
  // same footnote, because the shape on screen is the same shape.
  if (stacked && state.mode !== 'strata') {
    rows.push(`<div class="row"><span>level = commit · area = loc</span></div>`);
    // The filter outlives the mode it was set in, so every mode can undo it.
    if (filterActive()) {
      rows.push(`<div class="row"><span>filter · ${[...strata.filter.types].join(' ')}</span></div>`);
      rows.push(filterControlsHtml());
    }
    // Same rule for the diff scope: it changes the shared massing, so whichever
    // mode you are in has to say so and be able to undo it.
    if (diffScope.collapse && state.mode !== 'prov') {
      rows.push(`<div class="row"><span>diff scope · ${fmt(diffScope.byPath.size)} files only</span></div>`);
      rows.push(diffScopeControlHtml());
    }
  }
  dom.legend.innerHTML = rows.join('');
}

/** The diff scope's "only" — the same control the commit-type filter gets. */
function diffScopeControlHtml(): string {
  if (!diffAvailable()) return '';
  return (
    `<div class="fctl">` +
    `<button type="button" class="fbtn${diffScope.collapse ? ' on' : ''}" data-filter="diff-only"` +
    ` title="Drop every file the diff did not touch">&#8676;&#8677; only the diff</button>` +
    `</div>`
  );
}

/** The "only" / "clear" pair — present exactly while a filter is. */
function filterControlsHtml(): string {
  if (!filterActive()) return '';
  const collapse = strata.filter.collapse;
  return (
    `<div class="fctl">` +
    `<button type="button" class="fbtn${collapse ? ' on' : ''}" data-filter="collapse"` +
    ` title="Drop every other level and recompress the stacks from the base">&#8676;&#8677; only</button>` +
    `<button type="button" class="fbtn" data-filter="clear" title="Clear the filter (Esc)">clear</button>` +
    `</div>`
  );
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
  paintStrata();
  const mode = state.mode;
  const scrubbing = mode === 'recent' && state.timeCursor !== null;
  const maxV =
    mode === 'churn' ? index.max.churn :
    mode === 'fix' ? index.max.fixChurn :
    mode === 'recent' ? index.max.recentChurn : 1;
  const denom = Math.sqrt(Math.max(maxV, 1));
  const green = new THREE.Color(PALETTE.green);

  // The buildings are hidden wherever the stacks stand, so repainting thousands
  // of invisible instances would be pure cost.
  if (!strata.build) {
    for (const rec of city.moduleRecords) {
      if (mode === 'structure' || mode === 'strata') {
        _color.copy(rec.baseColor);
      } else if (mode === 'prov') {
        provColor(rec.file, _color);
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
  }

  const filePlates = city.filePlates;
  if (filePlates) {
    for (const rec of city.fileRecords) {
      if (mode === 'structure' || mode === 'strata') {
        _color.copy(rec.baseColor);
      } else if (mode === 'prov') {
        provColor(rec.node, _color).multiplyScalar(0.4);
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
 * The stacked slabs are the city's SHARED massing, not one mode's geometry: a
 * file's silhouette always tells its commit history, and the mode only decides
 * how that silhouette is painted. So the layer stands wherever files are the
 * unit of rendering — every folder scope, every mode. Inside a file or module
 * isolate (a synthetic scope) the module buildings come back, because that is
 * the level where per-module shape and kind actually resolve.
 *
 * Without a commit stream (v1 data) there is nothing to stack and the city
 * falls back to module massing everywhere.
 */
function strataActive(): boolean {
  return timeline.enabled && !!scope.root && !scope.root.synth;
}

/** Build (or tear down) the strata layer for the current scope. */
function applyStrataMode(): void {
  if (!city) return;
  const on = strataActive();
  // The second handle changes the massing, which every mode now shares.
  timeline.setRangeMode(on);
  for (const mesh of city.buildingMeshes) mesh.visible = !on;
  if (strata.build) {
    disposeObject(strata.build.group);
    strata.build = null;
  }
  if (!on) {
    // The filters are queries on the stacks; with no stacks they have nothing
    // to say, and leaving one armed would surprise you on the way back out.
    strata.filter.types.clear();
    strata.filter.collapse = false;
    diffScope.collapse = false;
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

/** Refill the existing slabs for the current [start, cursor] range and filter. */
function updateStrata(): void {
  const build = strata.build;
  if (!build) return;
  build.update({ start: timeline.start, cursor: state.timeCursor }, collapsePredicate(), diffFilePredicate());
  dom.statModulesLabel.textContent = 'LEVELS';
  dom.statModules.textContent = fmt(visibleLevels(build));
  paintStrata();
}

// ---------------------------------------------------------------------------
// Strata filter — the legend's commit-type swatches, as a live query
// ---------------------------------------------------------------------------

/**
 * How dark a level goes when the filter passes it over: enough that the color
 * is gone, not so much that the silhouette is. The skyline must stay readable
 * — the point of the highlight state is *where* the selected work sits inside
 * the whole history, which needs the rest of the history to still be there.
 */
const FILTER_GHOST = 0.1;

function filterActive(): boolean {
  return strata.filter.types.size > 0;
}

/** Does this commit belong to one of the selected swatches? */
function matchesFilter(commit: StrataCommit): boolean {
  const key = commitTypeKey(commit);
  return key !== null && strata.filter.types.has(key);
}

/** The massing predicate — non-null only while the filter is in COLLAPSE. */
function collapsePredicate(): LevelFilter | null {
  return strata.filter.collapse && filterActive() ? matchesFilter : null;
}

/** Levels the eye actually counts: matching ones while a filter is up. */
function visibleLevels(build: StrataBuild): number {
  if (!filterActive()) return build.records.length;
  let n = 0;
  for (const rec of build.records) if (rec.commit && matchesFilter(rec.commit)) n++;
  return n;
}

/** A file's own share of the filter, for the inspector. */
function filterMatchCount(node: VNode): { matched: number; total: number } | null {
  const build = strata.build;
  if (!build || !filterActive()) return null;
  const path = realFileOf(node)?.path;
  const history = path && strata.index ? strata.index.get(path) : null;
  if (!history) return null;
  const startTs = timeline.start;
  const cursorTs = state.timeCursor ?? Infinity;
  let matched = 0;
  let total = 0;
  for (const c of history) {
    if (c.ts > cursorTs || c.ts < startTs) continue;
    total++;
    if (matchesFilter(c)) matched++;
  }
  return { matched, total };
}

/**
 * Wrap a paint so unselected levels ghost out. This rides *on top of* whatever
 * the mode paints, which is what keeps the filter orthogonal to the overlay:
 * "fix levels, colored by churn" is a sentence the seam can already say.
 */
function ghostedPaint(paint: StrataPaint): StrataPaint {
  return (record, age, target) => {
    paint(record, age, target);
    const commit = record.commit;
    if (!commit || !matchesFilter(commit)) target.multiplyScalar(FILTER_GHOST);
    return target;
  };
}

/**
 * Re-run the filter. A highlight is a pure recolor; a collapse is an
 * `update()`-side rebuild, because it changes which levels exist at all — the
 * same path a range drag takes, with one more predicate on it.
 */
function applyStrataFilter(rebuild: boolean): void {
  const build = strata.build;
  if (build) {
    if (rebuild) updateStrata();
    else {
      dom.statModules.textContent = fmt(visibleLevels(build));
      paintStrata();
    }
  }
  renderLegend();
  // The SELECTED block carries the per-file "N of M match" line, so it restates.
  if (state.selection) sidebar.setSelection(describe(state.selection));
}

function toggleFilterType(type: string): void {
  if (!strata.build) {
    showNotice('The commit-type filter needs the strata massing — Esc back out to a folder');
    return;
  }
  const types = strata.filter.types;
  const wasCollapse = strata.filter.collapse;
  if (types.has(type)) types.delete(type);
  else types.add(type);
  if (!types.size) strata.filter.collapse = false;
  applyStrataFilter(wasCollapse || strata.filter.collapse);
}

function toggleFilterCollapse(): void {
  if (!filterActive()) return;
  strata.filter.collapse = !strata.filter.collapse;
  applyStrataFilter(true);
}

function clearStrataFilter(): void {
  if (!filterActive()) return;
  const wasCollapse = strata.filter.collapse;
  strata.filter.types.clear();
  strata.filter.collapse = false;
  applyStrataFilter(wasCollapse);
}

/** Dormant / untouched massing — the same tone the legend calls "dormant". */
const DORMANT = new THREE.Color(0x1b2432);
/** Dominant module kind per file, memoized: the paint runs per instance. */
const dominantKind = new Map<VNode, THREE.Color>();

/**
 * Repaint the stacks for the active pass. This is the whole difference between
 * the modes at folder scope: same geometry, different color.
 */
function paintStrata(): void {
  const build = strata.build;
  if (!build) return;
  if (searchPaint.on) {
    build.recolor(searchStrataPaint());
    collectStrataPulse(build);
    return;
  }
  searchPaint.pulseStrata.length = 0;
  const base = state.mode === 'strata' ? commitTypePaint : metricStrataPaint();
  build.recolor(filterActive() ? ghostedPaint(base) : base);
}

/**
 * One flat color per FILE: the silhouette already carries the history, so the
 * color is free to carry the metric. Structure uses the file's dominant module
 * kind — at org zoom a per-module building is sub-pixel anyway, and the kinds
 * resolve properly the moment you isolate into the file.
 */
function metricStrataPaint(): StrataPaint {
  const mode = state.mode;
  const maxV =
    mode === 'churn' ? index.max.churn :
    mode === 'fix' ? index.max.fixChurn :
    index.max.recentChurn;
  const denom = Math.sqrt(Math.max(maxV, 1));
  const green = new THREE.Color(PALETTE.green);
  const scrubbing = mode === 'recent' && state.timeCursor !== null;
  const worktreeOn = state.worktree && worktree.byPath.size > 0;

  return (record, _age, target) => {
    const file = record.file;
    // The working-tree layer rides on top of a uniform paint exactly as it does
    // on the buildings; Strata mode keeps its bands and opts out.
    if (worktreeOn) {
      const real = realFileOf(file);
      if (real && worktree.byPath.get(real.path) === 'modified') return target.copy(WORKTREE_AMBER);
    }
    if (mode === 'prov') return provColor(file, target);
    if (mode === 'structure') return target.copy(dominantKindColor(file));
    if (mode === 'recent') {
      const r = recentValue(file);
      return r.count > 0
        ? target.copy(green).multiplyScalar(scrubbing ? 1 + r.flash * 1.4 : 1)
        : target.copy(DORMANT);
    }
    return heatColor(Math.sqrt(Math.max(heatValue(file), 0)) / denom, target);
  };
}

/** The search / tour highlight, as the stacks see it. */
function searchStrataPaint(): StrataPaint {
  const paths = searchPaint.paths;
  return (record, _age, target) => {
    const real = realFileOf(record.file);
    const hit = real && paths ? paths.get(real.path) : null;
    return hit
      ? target.copy(SEARCH_HL).multiplyScalar(0.45 + 0.85 * hit.w)
      : target.copy(DORMANT).multiplyScalar(0.55);
  };
}

/** Instance ids of the file under the palette's keyboard cursor. */
function collectStrataPulse(build: StrataBuild): void {
  searchPaint.pulseStrata.length = 0;
  const cursor = searchPaint.cursor;
  if (!cursor) return;
  for (let i = 0; i < build.records.length; i++) {
    const rec = build.records[i];
    if (rec && realFileOf(rec.file)?.path === cursor.path) searchPaint.pulseStrata.push(i);
  }
}

/** The kind that owns most of a file's lines — the file's "character". */
function dominantKindColor(file: VNode): THREE.Color {
  const cached = dominantKind.get(file);
  if (cached) return cached;
  const source = realFileOf(file) ?? file;
  const totals = new Map<AnyKind, number>();
  for (const mod of source.modules ?? []) totals.set(mod.kind, (totals.get(mod.kind) ?? 0) + Math.max(mod.loc, 1));
  let best = 0;
  let kind: AnyKind | null = null;
  for (const [k, loc] of totals) {
    if (loc <= best) continue;
    best = loc;
    kind = k;
  }
  const color = new THREE.Color(kind === null ? PALETTE.filePlate : KIND_COLORS[kind]);
  dominantKind.set(file, color);
  return color;
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
    searchPaint.pulseStrata.length = 0;
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

/**
 * The ⌘F hits, mirrored into the sidebar. This list deliberately outlives the
 * palette: closing it hands the city back to its overlay, but the results stay
 * as a work queue — a file row selects and flies, a line row opens the code
 * pane on that span. Escape, or picking something else in the city, retires it.
 */
function setSearchResults(view: SearchResultsPayload | null): void {
  sidebar.setSearch(
    view
      ? {
          query: view.query,
          files: view.files,
          truncated: view.truncated,
          onSelectFile: (path) => { revealPath(path); },
          onSelectLine: (path, line) => { revealPath(path, { line }); },
        }
      : null
  );
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
  paintStrata();

  if (!strata.build) {
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
  }

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
  if (!searchPaint.on) return;
  const build = strata.build;
  if (!searchPaint.pulseRecs.length && !(build && searchPaint.pulseStrata.length)) return;
  const k = 1.15 + 0.85 * (0.5 + 0.5 * Math.sin(t * 5.4));
  _hl.copy(SEARCH_HL).multiplyScalar(k);
  for (const rec of searchPaint.pulseRecs) rec.mesh.setColorAt(rec.instanceId, _hl);
  for (const mesh of searchPaint.pulseMeshes) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  if (!build) return;
  for (const id of searchPaint.pulseStrata) build.mesh.setColorAt(id, _hl);
  if (searchPaint.pulseStrata.length && build.mesh.instanceColor) build.mesh.instanceColor.needsUpdate = true;
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
    setCheckpoints: (list) => checkpoints.load(list),
    setView: (view) => sidebar.setTour(view),
    getDiff: (path, hash) => host.getDiff(path, hash),
    notice: showNotice,
    onExit: () => { sidebar.setSelection(state.selection ? describe(state.selection) : null); },
  });
}

/**
 * Scripting hooks — the programmatic surface recordings, tours and tests
 * drive the viewer through (sibling of `window.cityTour`):
 *
 *   `cityScript.hover(path)`      shows the same callout + box a pointer pick
 *                                 would (null clears); the next real pointer
 *                                 move takes hover back.
 *   `cityScript.screenPos(path)`  projects a path's rooftop to CSS pixels, so
 *                                 a script can aim a real mouse at a building.
 *   `cityCheckpoints`             feeds the timeline-annotation layer directly
 *                                 (same validation as tour JSON — untrusted).
 */
function installScriptHooks(): void {
  /**
   * Resolve against what is *rendered*, not the whole tree: a node outside the
   * current scope keeps the `rect` from whatever layout last contained it, so
   * the global index would answer with coordinates from a previous stage.
   */
  const nodeFor = (path: unknown): VNode | null => {
    if (typeof path !== 'string') return null;
    const scoped = scope.byRealPath.get(path);
    if (scoped) return scoped;
    const node = index.filesByPath.get(path) ?? index.nodesByPath.get(path) ?? null;
    return node && scope.nodes.has(node) ? node : null;
  };
  /** World-space rooftop anchor — the point the hover callout rises from. */
  const rooftop = (node: VNode): THREE.Vector3 | null => {
    const r = node.rect;
    if (!r) return null;
    const top = plateTop(node.tier ?? node.depth ?? 0, node.type === 'file');
    return new THREE.Vector3(r.x + r.w / 2, top + boxHeightFor(node), r.z + r.h / 2).add(stageHome);
  };

  Reflect.set(window, 'cityScript', {
    hover(path: unknown): boolean {
      if (path === null) {
        setHover(null);
        return true;
      }
      const node = nodeFor(path);
      if (!node) return false;
      setHover({ type: node.type, node, rec: null });
      return true;
    },
    screenPos(path: unknown): { x: number; y: number; onScreen: boolean } | null {
      const node = nodeFor(path);
      const anchor = node ? rooftop(node) : null;
      if (!anchor) return null;
      anchor.project(camera);
      return {
        x: ((anchor.x + 1) / 2) * window.innerWidth,
        y: ((1 - anchor.y) / 2) * window.innerHeight,
        onScreen: Math.abs(anchor.x) <= 1 && Math.abs(anchor.y) <= 1 && anchor.z < 1,
      };
    },
  });

  Reflect.set(window, 'cityCheckpoints', {
    load: (raw: unknown) => {
      const list = validateCheckpoints(raw);
      checkpoints.load(list);
      return list.length;
    },
    show: (title: unknown, hold?: unknown) => {
      if (typeof title !== 'string' || !title.trim()) return false;
      checkpoints.show(title.slice(0, 200), typeof hold === 'number' ? hold : undefined);
      return true;
    },
    busy: () => checkpoints.busy(),
    clear: () => checkpoints.clear(),
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
// Diff scope — the changed-file set of one range, as a layer
// ---------------------------------------------------------------------------

/**
 * A diff is first a *scope*: the files a reviewer has to look at at all. That
 * layer is deliberately separate from what any overlay paints on top of it —
 * provenance below is the first such overlay, import blast radius and PR tours
 * are meant to be the next.
 *
 * It follows the strata filter's two states exactly (see "Strata filter"):
 * membership is a **highlight** by default — files outside the scope keep their
 * footprint and go dormant, so you still see *where* in the city the PR landed
 * — and `collapse` promotes it to a massing predicate, dropping their stacks
 * entirely for a skyline of nothing but the diff.
 */
const diffScope: {
  base: string;
  head: string;
  byPath: Map<string, DiffFile>;
  /** Files, plus folder subtotals so a district can answer for its subtree. */
  byNode: Map<VNode, DiffSum>;
  total: DiffSum;
  /** "only": non-diff files are not built at all. */
  collapse: boolean;
} = {
  base: '', head: '',
  byPath: new Map(),
  byNode: new Map(),
  total: { verbatim: 0, reshaped: 0, new: 0, deleted: 0 },
  collapse: false,
};

/** Added-line buckets, summed — one file's row or a folder's subtree. */
type DiffSum = { verbatim: number; reshaped: number; new: number; deleted: number };

function diffAvailable(): boolean {
  return diffScope.byNode.size > 0;
}

/** Index `data.diff` (when the analyzer produced one) and reveal the mode. */
function initDiffScope(data: CityData): void {
  const diff = data.diff;
  const root = state.root;
  if (!diff || !Array.isArray(diff.files) || !root) return;
  diffScope.base = String(diff.base || '');
  diffScope.head = String(diff.head || '');
  for (const f of diff.files) {
    if (f && typeof f.path === 'string') diffScope.byPath.set(f.path, f);
  }
  sumDiffScope(root);
  if (!diffAvailable()) return; // the diff touched nothing the city knows about
  dom.provBtn.style.display = '';
}

/** Post-order subtree sums; nodes with nothing changed stay out of the map. */
function sumDiffScope(node: VNode): DiffSum | null {
  if (node.type === 'file') {
    const f = diffScope.byPath.get(node.path);
    if (!f) return null;
    const sum = { verbatim: f.verbatim, reshaped: f.reshaped, new: f.new, deleted: f.deleted };
    diffScope.byNode.set(node, sum);
    addDiffSum(diffScope.total, sum);
    return sum;
  }
  const sum: DiffSum = { verbatim: 0, reshaped: 0, new: 0, deleted: 0 };
  let any = false;
  for (const child of node.children || []) {
    const childSum = sumDiffScope(child);
    if (!childSum) continue;
    any = true;
    addDiffSum(sum, childSum);
  }
  if (!any) return null;
  diffScope.byNode.set(node, sum);
  return sum;
}

function addDiffSum(into: DiffSum, from: DiffSum): void {
  into.verbatim += from.verbatim;
  into.reshaped += from.reshaped;
  into.new += from.new;
  into.deleted += from.deleted;
}

/** The buckets a node stands for — synthetic scopes resolve to their real file. */
function diffSum(node: VNode): DiffSum | null {
  const real = realFileOf(node);
  return diffScope.byNode.get(real ?? node) ?? null;
}

/** The massing predicate — non-null only while the scope is collapsed. */
function diffFilePredicate(): FileFilter | null {
  if (!diffScope.collapse || !diffAvailable()) return null;
  return (node) => diffSum(node) !== null;
}

/** Toggle "only the diff". Like the strata collapse, this is an `update()`. */
function toggleDiffCollapse(): void {
  if (!diffAvailable()) return;
  if (!strata.build) {
    showNotice('"Only the diff" needs the strata massing — Esc back out to a folder');
    return;
  }
  diffScope.collapse = !diffScope.collapse;
  updateStrata();
  renderLegend();
}

// ---------------------------------------------------------------------------
// PR provenance — where the diff scope's added lines came from
// ---------------------------------------------------------------------------

/** Bucket hues: cyan = skip it, violet = check it, orange = read it. */
const PROV_VERBATIM = new THREE.Color(0x22d3ee);
const PROV_RESHAPED = new THREE.Color(0xa78bfa);
const PROV_NEW = new THREE.Color(PALETTE.orange);
/** A file the diff only took lines away from. */
const PROV_DELETED = new THREE.Color(0x7f1d1d);

/**
 * The ramp stops in *display* components. Mixing them in the renderer's linear
 * working space sends violet → orange the long way round, through magenta; in
 * sRGB the same two stops pass through the red-orange the eye expects.
 */
function srgbOf(color: THREE.Color): [number, number, number] {
  const out = { r: 0, g: 0, b: 0 };
  color.getRGB(out, THREE.SRGBColorSpace);
  return [out.r, out.g, out.b];
}
const STOP_VERBATIM = srgbOf(PROV_VERBATIM);
const STOP_RESHAPED = srgbOf(PROV_RESHAPED);
const STOP_NEW = srgbOf(PROV_NEW);

/**
 * One number decides the hue: how much of this file a reviewer has to actually
 * read (`reshaped` counts half — moved, but worth a glance). The three legend
 * swatches are the stops of that ramp, so 87%-verbatim reads calm cyan, a
 * half-rewritten file reads violet, and 93%-new burns orange.
 *
 * A blend of the three hues by share was tried first and mixed to mauve for
 * exactly the interesting middle — a ramp keeps the axis monotone and readable.
 * Files outside the diff scope go dormant, so the PR *is* the city.
 */
function provColor(node: VNode, target: THREE.Color): THREE.Color {
  const sum = diffSum(node);
  if (!sum) return target.copy(DORMANT);
  const adds = sum.verbatim + sum.reshaped + sum.new;
  if (!adds) return target.copy(PROV_DELETED);
  const read = (sum.reshaped * 0.5 + sum.new) / adds;
  const [a, b, k] = read <= 0.5
    ? [STOP_VERBATIM, STOP_RESHAPED, read * 2] as const
    : [STOP_RESHAPED, STOP_NEW, (read - 0.5) * 2] as const;
  return target.setRGB(
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
    THREE.SRGBColorSpace
  );
}

/** The inspector line: `+449 · 87% verbatim · 3% reshaped · 10% new`. */
function provNote(node: VNode): string | undefined {
  const sum = diffSum(node);
  if (!sum) return undefined;
  const adds = sum.verbatim + sum.reshaped + sum.new;
  if (!adds) return `−${fmt(sum.deleted)} · removed only`;
  const pct = (x: number) => Math.round((100 * x) / adds);
  return `+${fmt(adds)} · ${pct(sum.verbatim)}% verbatim · ${pct(sum.reshaped)}% reshaped · ${pct(sum.new)}% new`;
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
  // Where the stacks stand there are no visible buildings, and the amber is
  // already part of their paint (`metricStrataPaint`); only the plates below
  // still need it, which the second half of this pass does.
  if (!strata.build) {
    let touched = false;
    for (const rec of city.moduleRecords) {
      const real = realFileOf(rec.file);
      if (!real || worktree.byPath.get(real.path) !== 'modified') continue;
      rec.mesh.setColorAt(rec.instanceId, WORKTREE_AMBER);
      touched = true;
    }
    if (touched) for (const mesh of city.buildingMeshes) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

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
  // Strata reads the cursor as its base snapshot, and provenance is about one
  // diff rather than the timeline, so both keep their own overlay.
  if (t !== null && state.mode !== 'recent' && state.mode !== 'strata' && state.mode !== 'prov') {
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
  const target = new THREE.Vector3(r.x + r.w / 2, plateTop(node.tier ?? node.depth ?? 0, node.type === 'file'), r.z + r.h / 2)
    .add(stageHome);
  const extent = Math.max(r.w, r.h, 12);
  // Framings are computed at the base FOV: a flight that is mid-breath must
  // still aim at where the destination will sit once the breath is over.
  const vFov = (BASE_FOV * Math.PI) / 180;
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
    endFlight();
    camera.position.copy(to.pos);
    controls.target.copy(to.target);
    controls.update();
    return;
  }

  // A transition still riding the *previous* flight cannot follow this one's
  // progress backwards; hand it to the clock unless the caller re-syncs it.
  if (transition.drive === 'flight' && transition.t < 1) {
    transition.drive = 'clock';
    transition.delay = 0;
    transition.dur = 0.25;
  }

  const from: Framing = { pos: camera.position.clone(), target: controls.target.clone() };
  // A reveal that has to pop the scope out and then drill back in re-targets the
  // flight several times in one frame. Nothing has moved yet, so the route the
  // previous call laid out is still ahead of us and still on the way down.
  const carry = flight.active && flight.t === 0 ? flight.route : [];

  // Waypoints the camera is effectively already at, or that sit a hair from
  // their neighbour on a long route, are dropped.
  const route = [...carry, ...(opts.via ?? [])];
  let span = from.target.distanceTo(to.target);
  for (const f of route) span = Math.max(span, from.target.distanceTo(f.target));
  const minStep = Math.max(6, span * 0.05);
  const waypoints: Framing[] = [from];
  let prev = from;
  for (const f of route) {
    if (f.target.distanceTo(prev.target) < minStep) continue;
    waypoints.push(f);
    prev = f;
  }
  if (to.target.distanceTo(prev.target) < minStep && waypoints.length > 1) waypoints.pop();
  waypoints.push(to);
  straightenRoute(waypoints);
  const segments = waypoints.length - 1;
  flight.route = waypoints.slice(1);

  // --- 1. the target's path -------------------------------------------------
  // The levels passed through steer what the camera LOOKS AT, and nothing else.
  // Their framings' own bearings are deliberately ignored: threading the camera
  // itself through them is what used to make a dive wobble and tilt, because a
  // nest of treemap cells puts consecutive centres on alternating sides.
  const tgtPts: THREE.Vector3[] = [];
  for (let s = 0; s < segments; s++) {
    const a = waypoints[s];
    const b = waypoints[s + 1];
    if (!a || !b) continue;
    for (let j = s === 0 ? 0 : 1; j <= FLIGHT_SAMPLES; j++) {
      tgtPts.push(a.target.clone().lerp(b.target, j / FLIGHT_SAMPLES));
    }
  }
  if (tgtPts.length < 2) return;
  const even = resampleUniform(tgtPts, CONTROL_POINTS);
  relax(even, CORNER_RELAX);
  const path = new THREE.CatmullRomCurve3(even, false, 'centripetal');
  path.arcLengthDivisions = ARC_DIVISIONS;
  flight.path = path;

  // --- 2. the camera's bearing ---------------------------------------------
  // One monotone move each: the bearing swings once, the pitch tips once, the
  // distance closes once. No intermediate framing gets to reverse any of them.
  _sphA.setFromVector3(_v3.subVectors(from.pos, from.target));
  _sphB.setFromVector3(_v3.subVectors(to.pos, to.target));
  const a0 = _sphA.theta;
  const p0 = clampPolar(_sphA.phi);
  const r0 = Math.max(_sphA.radius, 1);
  const da = wrapAngle(_sphB.theta - a0);
  const p1 = clampPolar(_sphB.phi);
  const r1 = Math.max(_sphB.radius, 1);
  const inward = r1 < r0;
  // Crane shaping lives entirely in the distance schedule: skewing the geometric
  // close-in later keeps a dive high over the towers and brings it down at the
  // end, and skewing it earlier lets a climb get its height up front.
  let skew = inward ? SKEW_IN : SKEW_OUT;

  const K = SCHEDULE_STATIONS;
  const azim = flight.azim;
  const polar = flight.polar;
  const dist = flight.dist;
  const groundY = flight.groundY;
  for (let k = 0; k <= K; k++) {
    const u = k / K;
    azim[k] = a0 + da * u;
    polar[k] = p0 + (p1 - p0) * u;
    path.getPoint(u, _v3);
    groundY[k] = _v3.y;
  }

  // --- 3. clearance --------------------------------------------------------
  // The camera must stay over the skyline until it is on final approach. Rather
  // than clamp the distance schedule — which puts a corner in the path exactly
  // where the crane starts coming down — solve for the gentlest crane exponent
  // that clears it. The schedule stays one smooth analytic curve, and a curve
  // with no corner has no kink for the eye to catch.
  const floor = Math.min(scopeCeiling() * FLIGHT_CLEARANCE, Math.max(from.pos.y, to.pos.y));
  const fits = (k: number): boolean => {
    const r = craneDist(r0, r1, k / K, skew);
    // Inside the final approach the camera is allowed — expected — to come down
    // among the buildings it flew here to look at.
    if (r <= r1 * APPROACH_RADIUS) return true;
    const cosP = Math.max(Math.cos(polar[k] ?? 0), 0.05);
    return r >= (floor - (groundY[k] ?? 0)) / cosP;
  };
  let lo = inward ? SKEW_IN : SKEW_OUT;
  let hi = inward ? SKEW_MAX : 1;
  const clears = (candidate: number): boolean => {
    skew = candidate;
    for (let k = 1; k < K; k++) if (!fits(k)) return false;
    return true;
  };
  if (!clears(lo)) {
    // Monotone in the exponent: a later close-in (or an earlier climb) can only
    // hold the camera higher, so the smallest correction is a binary search.
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      if (clears(mid)) hi = mid;
      else lo = mid;
    }
    skew = hi;
  }
  for (let k = 0; k <= K; k++) dist[k] = craneDist(r0, r1, k / K, skew);
  const length = buildArcTable();

  // --- 4. timing ------------------------------------------------------------
  const far = Math.min(length / 1.1, 2.4) * 0.28;
  let dur = 0.55 + 0.26 * (segments - 1) + far;
  if (!inward) dur *= 0.86; // coming back up is a retreat, not an approach
  flight.dur = Math.min(Math.max(dur, 0.5), 2.2);
  flight.ramp = segments > 1 ? RAMP_LONG : RAMP_SHORT;
  // Retargeting mid-flight: carry the speed the camera already has into the new
  // ease instead of stalling to zero and accelerating again.
  flight.v0 = flight.active && flight.worldLength > 1
    ? Math.min((flight.speed * flight.dur) / flight.worldLength, 2)
    : 0;
  flight.breath = inward && segments >= 3 ? FOV_BREATH : 0;
  flight.t = 0;
  flight.e = 0;
  flight.active = true;
  // Nothing anchored to the old view survives the trip.
  clearCallout();
}

/**
 * Force the route to make monotone progress toward where it is going.
 *
 * Treemap centres are not laid out along the way: drilling three levels down
 * can easily pass a folder whose centre sits *behind* the destination, and a
 * path told to visit them all doubles back on itself — the camera swings out
 * and returns, which is the wobble you feel even when every curve is smooth.
 * Each stop is projected onto the straight line to the destination; the ones
 * that do not advance along it are dropped, and the sideways part of the rest
 * is capped, so what survives is a bowed route rather than a zig-zag.
 */
function straightenRoute(waypoints: Framing[]): void {
  const first = waypoints[0];
  const last = waypoints[waypoints.length - 1];
  if (waypoints.length < 3 || !first || !last) return;
  _routeDir.subVectors(last.target, first.target);
  const span = _routeDir.length();
  if (span < 1e-3) {
    waypoints.splice(1, waypoints.length - 2);
    return;
  }
  _routeDir.divideScalar(span);

  let lastAt = 0;
  for (let i = 1; i < waypoints.length - 1; i++) {
    const w = waypoints[i];
    if (!w) continue;
    _routeOff.subVectors(w.target, first.target);
    const at = _routeOff.dot(_routeDir) / span;
    if (at < lastAt + ROUTE_MIN_ADVANCE || at > 1 - ROUTE_MIN_ADVANCE) {
      waypoints.splice(i, 1);
      i--;
      continue;
    }
    // Sideways component, capped: a stop may bow the route, not detour it.
    _routeOff.addScaledVector(_routeDir, -at * span);
    const lateral = _routeOff.length();
    const cap = span * ROUTE_MAX_BOW;
    if (lateral > cap) _routeOff.multiplyScalar(cap / lateral);
    w.target.copy(first.target).addScaledVector(_routeDir, at * span).add(_routeOff);
    lastAt = at;
  }
}

const _routeDir = new THREE.Vector3();
const _routeOff = new THREE.Vector3();

/**
 * Fill the arc-length table and return the path's total length — measured in
 * APPARENT motion, not world units. A dive crosses two orders of magnitude of
 * scale, and a hundred units covered from a thousand away is a crawl while the
 * same hundred covered from fifty away is a blur; dividing by the distance to
 * what you are looking at makes the eased progress mean "how much the view
 * changed", which is what the eye is actually judging the speed by.
 */
function buildArcTable(): number {
  const K = SCHEDULE_STATIONS;
  const arc = flight.arc;
  arc[0] = 0;
  let world = 0;
  let prevR = flight.dist[0] ?? 1;
  for (let k = 0; k <= K; k++) {
    schedulePoint(k / K, _flightB);
    if (k > 0) {
      const r = Math.max(((flight.dist[k] ?? 1) + prevR) / 2, 1);
      const dPos = _flightB.distanceTo(_flightA);
      const dTgt = _flightT.distanceTo(_flightP);
      world += dPos;
      arc[k] = (arc[k - 1] ?? 0) + (dPos + dTgt) / r;
    }
    prevR = flight.dist[k] ?? 1;
    _flightA.copy(_flightB);
    _flightP.copy(_flightT);
  }
  flight.worldLength = world;
  return arc[K] ?? 0;
}

/** Camera pose at schedule position `u`, written into `out` (target into _flightT). */
function schedulePoint(u: number, out: THREE.Vector3): void {
  const path = flight.path;
  if (!path) return;
  path.getPoint(Math.min(Math.max(u, 0), 1), _flightT);
  const K = SCHEDULE_STATIONS;
  const x = Math.min(Math.max(u, 0), 1) * K;
  const i = Math.min(Math.floor(x), K - 1);
  const f = x - i;
  const a = lerp(flight.azim[i] ?? 0, flight.azim[i + 1] ?? 0, f);
  const p = lerp(flight.polar[i] ?? 0, flight.polar[i + 1] ?? 0, f);
  const r = lerp(flight.dist[i] ?? 0, flight.dist[i + 1] ?? 0, f);
  const sinP = Math.sin(p);
  out.set(
    _flightT.x + r * sinP * Math.sin(a),
    _flightT.y + r * Math.cos(p),
    _flightT.z + r * sinP * Math.cos(a)
  );
}

/** Schedule position that sits `e` of the way along the path by arc length. */
function scheduleAt(e: number): number {
  const K = SCHEDULE_STATIONS;
  const arc = flight.arc;
  const total = arc[K] ?? 0;
  if (total <= 1e-6) return e;
  const want = e * total;
  let lo = 0;
  let hi = K;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arc[mid] ?? 0) < want) lo = mid + 1;
    else hi = mid;
  }
  const k = Math.max(lo, 1);
  const c0 = arc[k - 1] ?? 0;
  const c1 = arc[k] ?? c0;
  const f = c1 - c0 > 1e-9 ? (want - c0) / (c1 - c0) : 0;
  return (k - 1 + f) / K;
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** Geometric close-in from `r0` to `r1`, skewed late (or early) by `skew`. */
function craneDist(r0: number, r1: number, u: number, skew: number): number {
  return r0 * Math.pow(r1 / r0, Math.pow(u, skew));
}

/** Shortest signed way round to the same bearing. */
function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

/** Keep the pitch inside what OrbitControls itself allows, so it never clamps. */
function clampPolar(phi: number): number {
  return Math.min(Math.max(phi, 0.08), Math.PI * 0.49);
}

/** Stop the flight and hand the camera back, with the FOV where it started. */
function endFlight(): void {
  flight.active = false;
  flight.path = null;
  flight.speed = 0;
  // An unfold riding this flight has to finish under its own steam now.
  if (transition.drive === 'flight' && transition.t < 1) {
    transition.drive = 'clock';
    transition.delay = 0;
    transition.dur = 0.2;
  }
  if (camera.fov !== BASE_FOV) {
    camera.fov = BASE_FOV;
    camera.updateProjectionMatrix();
  }
}

/**
 * Any hand on the camera cancels the flight from wherever it is — no snap back
 * to the destination — and lets the unfold finish immediately behind it, so the
 * scene is pickable again the moment the user takes over.
 */
function onUserCamera(): void {
  if (flight.active) endFlight();
  if (transition.t < 1) {
    transition.drive = 'clock';
    transition.delay = 0;
    transition.dur = Math.max(0.15 / Math.max(1 - transition.t, 1e-3), 0.05);
  }
}

/** Y of the tallest thing standing in the current scope. */
function scopeCeiling(): number {
  const build = strata.build;
  let top = 0;
  for (const n of scope.fileNodes) {
    const base = n.top ?? 0;
    top = Math.max(top, base + (build ? build.heightOf(n) : tallest(n)));
  }
  return top;
}

/** Re-space a polyline evenly along its own length. */
function resampleUniform(path: THREE.Vector3[], count: number): THREE.Vector3[] {
  const n = path.length;
  const cum: number[] = [0];
  for (let i = 1; i < n; i++) {
    const a = path[i - 1];
    const b = path[i];
    cum.push((cum[i - 1] ?? 0) + (a && b ? a.distanceTo(b) : 0));
  }
  const total = cum[n - 1] ?? 0;
  if (total <= 1e-6) return path;

  const out: THREE.Vector3[] = [];
  let seg = 1;
  for (let k = 0; k < count; k++) {
    const want = (total * k) / (count - 1);
    while (seg < n - 1 && (cum[seg] ?? 0) < want) seg++;
    const c0 = cum[seg - 1] ?? 0;
    const c1 = cum[seg] ?? c0;
    const f = c1 - c0 > 1e-9 ? (want - c0) / (c1 - c0) : 0;
    const pa = path[seg - 1];
    const pb = path[seg];
    if (!pa || !pb) continue;
    out.push(pa.clone().lerp(pb, f));
  }
  return out;
}

/**
 * Corner-cutting passes over a polyline, endpoints pinned. Each pass replaces a
 * point with the [1/4, 1/2, 1/4] blend of its neighbourhood, which is a discrete
 * diffusion: sharp corners open out, straight runs are untouched.
 */
function relax(points: THREE.Vector3[], passes: number): void {
  const n = points.length;
  if (n < 3) return;
  for (let pass = 0; pass < passes; pass++) {
    _relaxPrev.copy(points[0] ?? _relaxPrev);
    for (let i = 1; i < n - 1; i++) {
      const p = points[i];
      const next = points[i + 1];
      if (!p || !next) continue;
      _relaxTmp.copy(p);
      p.multiplyScalar(0.5).addScaledVector(_relaxPrev, 0.25).addScaledVector(next, 0.25);
      _relaxPrev.copy(_relaxTmp);
    }
  }
}

const _relaxPrev = new THREE.Vector3();
const _relaxTmp = new THREE.Vector3();

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a || 1e-6), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * The global flight ease. Normally a trapezoid: a sine ramp up, a constant-speed
 * cruise, a sine ramp down — C1 everywhere, and the cruise is what keeps a long
 * dive from reading as a lunge. A flight that started while the camera was
 * already moving swaps it for the cubic Hermite that begins at that speed.
 */
function flightEase(x: number, ramp: number, v0: number): number {
  if (v0 > 0.05) return (v0 - 2) * x * x * x + (3 - 2 * v0) * x * x + v0 * x;
  const r = Math.min(Math.max(ramp, 0.02), 0.5);
  const v = 1 / (1 - r);
  if (x < r) return 0.5 * v * (x - (r / Math.PI) * Math.sin((Math.PI * x) / r));
  if (x > 1 - r) return 1 - flightEase(1 - x, ramp, 0);
  return 0.5 * v * r + v * (x - r);
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
  const match = filterMatchCount(node);
  return {
    name: mod ? mod.name : node.name,
    kind,
    kindColor: mod ? KIND_COLORS[mod.kind] ?? PALETTE.cyan : PALETTE.cyan,
    path: node.path,
    note: level ? `${level.h} · ${level.s}` : undefined,
    filterNote: match
      ? `${fmt(match.matched)} of ${fmt(match.total)} commits match filter (${[...strata.filter.types].join(' ')})`
      : undefined,
    provNote: provNote(node),
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
      ).add(stageHome),
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
      pos: new THREE.Vector3(rec.center.x, (rec.file.top ?? 0) + rec.height + 2.5, rec.center.z).add(stageHome),
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

  // A hand on the camera always outranks whatever the camera was doing.
  controls.addEventListener('start', onUserCamera);

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
    // Picking something in the city is the end of the search errand.
    if (sidebar.hasSearch()) setSearchResults(null);
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
      // The results list outlives the palette, so Escape retires it before it
      // starts popping the focus stack.
      if (sidebar.hasSearch()) {
        setSearchResults(null);
        return;
      }
      // A filter is a query laid over the current scope, so it comes off before
      // the scope itself does — same rule as the search results above it.
      if (filterActive()) {
        clearStrataFilter();
        return;
      }
      // The diff-scope collapse is the same kind of query, one step further out.
      if (diffScope.collapse) {
        toggleDiffCollapse();
        return;
      }
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
    callout.anchor.set(_v3.x, _v3.y + _scale.y, _v3.z).add(stageHome);
  } else {
    const r = hit.node.rect;
    if (!r) return;
    const top = plateTop(hit.node.tier ?? hit.node.depth ?? 0, hit.node.type === 'file');
    callout.anchor.set(r.x + r.w / 2, top + boxHeightFor(hit.node), r.z + r.h / 2).add(stageHome);
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

  if (flight.active) tickFlight(dt);

  if (transition.t < 1) {
    if (transition.drive === 'flight' && flight.active) {
      // Smoothstep over the window, so the unfold starts and stops with zero
      // velocity inside a flight that is itself still moving: no kick either end.
      transition.t = smoothstep(transition.from, transition.to, flight.e);
    } else if (transition.delay > 0) {
      transition.delay = Math.max(transition.delay - dt, 0);
    } else {
      transition.t = Math.min(transition.t + dt / transition.dur, 1);
    }
    const e = transition.drive === 'flight' ? transition.t : easeInOutCubic(transition.t);
    applyStageTransform(transition.k0 + (1 - transition.k0) * e);
    for (const { m, base } of transition.mats) m.opacity = base * (0.45 + 0.55 * e);
  } else if (!flight.active) {
    rehomeStage();
  }

  checkpoints.tick(
    dt,
    timeline.enabled ? timeline.cursor : null,
    timeline.enabled ? { min: timeline.min, max: timeline.max } : null
  );
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

  if (ghost) {
    ghost.t = Math.min(ghost.t + dt / (flight.active ? flight.dur * GHOST_FADE : TRANSITION_DUR), 1);
    const k = 1 - easeInOutCubic(ghost.t);
    for (const { m, base } of ghost.mats) m.opacity = base * k;
    if (ghost.t >= 1) disposeGhost();
  }

  if (probe) probe.record(dt);

  if (tour) tour.tick(dt);
  // The orbit treatment must not fight a camera flight, which writes the
  // position directly a few lines above.
  controls.autoRotate = orbitWanted && !flight.active;
  controls.autoRotateSpeed = 0.35;

  controls.update();
  // Mid-transition the stage is still folded and mid-flight the view is moving,
  // so world-space picking, labels and highlight boxes would all be pointing at
  // something the user cannot act on. The dressing fades rather than blinks.
  const settled = transition.t >= 1 && !flight.active;
  const flying = !settled;
  dressing.v += ((flying ? 0 : 1) - dressing.v) * Math.min(dt * (flying ? 9 : 5.5), 1);
  if (dressing.frozen !== flying) {
    dressing.frozen = flying;
    labeler.setFrozen(flying);
    terraceSigns.setFrozen(flying);
  }
  labeler.setDim(dressing.v);
  terraceSigns.setDim(dressing.v);
  labeler.update(dt);
  terraceSigns.update(dt);
  if (settled) {
    updateHover();
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

/** Walk the derived camera path by arc length under the global ease. */
function tickFlight(dt: number): void {
  if (!flight.path) {
    endFlight();
    return;
  }
  _flightPrev.copy(camera.position);
  flight.t = Math.min(flight.t + dt / flight.dur, 1);
  const e = Math.min(Math.max(flightEase(flight.t, flight.ramp, flight.v0), 0), 1);
  flight.e = e;
  schedulePoint(scheduleAt(e), camera.position);
  controls.target.copy(_flightT);

  if (flight.breath > 0) {
    // One slow breath out and back, peaking mid-dive: the city opens up a touch
    // on the way down and closes again as the destination fills the frame.
    const fov = BASE_FOV + flight.breath * Math.sin(Math.PI * e) ** 1.5;
    if (fov !== camera.fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
  flight.speed = dt > 0 ? camera.position.distanceTo(_flightPrev) / dt : 0;
  if (flight.t >= 1) endFlight();
}

const _flightPrev = new THREE.Vector3();

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

// ---------------------------------------------------------------------------
// Motion probe (dev only, behind ?probe=1)
// ---------------------------------------------------------------------------

/**
 * Per-frame camera trace for the motion tests: is the eased spline actually
 * C1 (no frame-to-frame speed step), and does the crane arc really clear the
 * skyline? Off unless `?probe=1`, and it writes into one preallocated buffer so
 * even switched on it allocates nothing per frame.
 */
interface MotionProbe {
  record(dt: number): void;
  /**
   * The scope was just replaced: project where the anchor stood in the layout
   * that went away, and where the new layout puts it, through the SAME camera.
   * The two must land on the same pixel — that is the world-continuity
   * assertion, isolated from the camera's own motion.
   */
  markRebuild(world: { cx: number; cy: number; cz: number }): void;
  reset(): void;
  /** [flightId, t, e, px, py, pz, tx, ty, tz, anchorNdcX, anchorNdcY, mark] per frame. */
  frames(): number[][];
  flights(): Array<{ id: number; dur: number; ceiling: number; planY: number }>;
  focusPath(path: string): boolean;
  reveal(path: string): boolean;
  up(): boolean;
  /** Eased progress of the flight in the air right now, 0..1. */
  progress(): number;
  state(): { flying: boolean; focus: string; transition: number };
}

const STRIDE = 12;
const PROBE_CAP = 8192;

const probe: MotionProbe | null = createProbe();

/** Lowest camera height the flight schedule plans on, before its final fifth. */
function planMinY(): number {
  const path = flight.path;
  if (!path) return 0;
  const K = SCHEDULE_STATIONS;
  const total = flight.arc[K] ?? 1;
  let min = Infinity;
  for (let k = 0; k <= K; k++) {
    if ((flight.arc[k] ?? 0) / total > 0.8) break;
    path.getPoint(k / K, _v3);
    min = Math.min(min, _v3.y + (flight.dist[k] ?? 0) * Math.cos(flight.polar[k] ?? 0));
  }
  return min;
}

function createProbe(): MotionProbe | null {
  if (typeof window === 'undefined') return null;
  if (!new URLSearchParams(window.location.search).has('probe')) return null;
  const buf = new Float64Array(PROBE_CAP * STRIDE);
  const meta: Array<{ id: number; dur: number; ceiling: number; planY: number }> = [];
  const _probe = new THREE.Vector3();
  let n = 0;
  let id = 0;
  let last = -1;

  const write = (
    fid: number, t: number, e: number,
    pos: THREE.Vector3, target: THREE.Vector3,
    ax: number, ay: number, mark: number
  ): void => {
    if (n >= PROBE_CAP) return;
    const i = n * STRIDE;
    buf[i] = fid;
    buf[i + 1] = t;
    buf[i + 2] = e;
    buf[i + 3] = pos.x; buf[i + 4] = pos.y; buf[i + 5] = pos.z;
    buf[i + 6] = target.x; buf[i + 7] = target.y; buf[i + 8] = target.z;
    buf[i + 9] = ax; buf[i + 10] = ay; buf[i + 11] = mark;
    n++;
  };

  const api: MotionProbe = {
    record() {
      const t = flight.active ? flight.t : 1;
      // A new flight is a t that went backwards.
      if (flight.active && (t < last || last < 0)) {
        id++;
        meta.push({ id, dur: flight.dur, ceiling: scopeCeiling(), planY: planMinY() });
      }
      last = flight.active ? t : -1;
      // Stage transform is a uniform scale plus a translation, so the anchor's
      // world position is one multiply-add — and unlike matrixWorld it is the
      // value this frame will actually render with.
      _probe.copy(transition.anchor).multiplyScalar(stage.scale.x).add(stage.position).project(camera);
      write(flight.active ? id : 0, t, flight.active ? flight.e : 1,
        camera.position, controls.target, _probe.x, _probe.y, 0);
    },
    markRebuild(world) {
      _probe.set(world.cx, world.cy, world.cz).project(camera);
      write(0, 1, 1, camera.position, controls.target, _probe.x, _probe.y, 1);
      _probe.copy(transition.anchor).multiplyScalar(stage.scale.x).add(stage.position).project(camera);
      write(0, 1, 1, camera.position, controls.target, _probe.x, _probe.y, 2);
    },
    reset() { n = 0; id = 0; last = -1; meta.length = 0; },
    frames() {
      const out: number[][] = [];
      for (let k = 0; k < n; k++) out.push([...buf.slice(k * STRIDE, k * STRIDE + STRIDE)]);
      return out;
    },
    flights() { return meta.map((m) => ({ ...m })); },
    focusPath(path) {
      const node = index.nodesByPath.get(path);
      if (!node) return false;
      focusNode(node);
      return true;
    },
    reveal(path) { return revealPath(path); },
    up() {
      const parent = state.focus?.parent;
      if (!parent) return false;
      focusNode(parent);
      return true;
    },
    progress() { return flight.active ? flight.e : 1; },
    state() {
      return {
        flying: flight.active,
        focus: state.focus?.path ?? '',
        transition: transition.t,
      };
    },
  };
  Reflect.set(window, '__motionProbe', api);
  return api;
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
