/**
 * vtree.ts — the viewer's view of a tree node.
 *
 * The data.json tree is read-only input; the viewer augments it in place with
 * parent links, layout results (rect/depth/top/plots) and the synthetic nodes
 * that make file and module drill-down possible. Every one of those fields is
 * declared here — this is the single place where the augmentation lives.
 */
import type * as THREE from 'three';
import type { MemberKind, ModuleKind, ModuleRef, TreeNode } from '../../shared/types.js';

/** Any kind that can become a building: top-level modules and their members. */
export type AnyKind = ModuleKind | MemberKind;

/** A module or a module member, as the city renders them (both are buildings). */
export interface VMod {
  name: string;
  kind: AnyKind;
  loc: number;
  /** 1-based start line; absent on modules synthesized for module-less files. */
  line?: number;
  exported?: boolean;
  children?: VMod[];
  refs?: ModuleRef[];
}

/** World-space footprint on the XZ plane; (x, z) is the min corner. */
export interface Rect {
  x: number;
  z: number;
  w: number;
  h: number;
}

/** One module's slot inside its file plate. */
export interface Plot extends Rect {
  mod: VMod;
  /** Inside a file: slab base above the plate and its linear height (lines × unit). */
  y0?: number;
  height?: number;
}

/** Where a node was first placed. A scope root is re-laid out here, so drilling in never rescales it. */
export interface Home {
  rect: Rect;
  depth: number;
  tier: number;
}

/** Which synthetic layer a node belongs to, absent for real tree nodes. */
export type SynthKind = 'fileScope' | 'module' | 'member' | 'leaf' | 'wrap';

export interface VNode {
  type: 'folder' | 'file';
  name: string;
  path: string;
  loc: number;
  churn: number;
  fixChurn: number;
  recentChurn: number;
  /** Folder nodes. */
  children?: VNode[];
  /** File nodes. */
  modules?: VMod[];

  // --- viewer augmentation -------------------------------------------------

  parent?: VNode | null;
  /** Set on nodes the viewer synthesized for file / module drill-down. */
  synth?: SynthKind;
  /** The real file a synthetic node was derived from. */
  srcFile?: VNode;
  /** The module (or member) a synthetic node stands for. */
  mod?: VMod;
  /** Memoized scopes so drill-down keeps node identity across rebuilds. */
  _scope?: VNode;
  _modNodes?: Map<VMod, VNode>;
  _wrap?: VNode;

  // --- layout (assigned by layout.ts on every scope rebuild) ---------------

  /** null when the node was too small to place at this extent. */
  rect?: Rect | null;
  /** First placement, kept across rebuilds; see layoutCity `at`. */
  home?: Home;
  depth?: number;
  /** Terrace tier — depth minus pass-through (single-child) levels. */
  tier?: number;
  /** Y of the walkable top surface of the node's plate. */
  top?: number;
  /** File nodes: one plot per module. */
  plots?: Plot[];
  plateRef?: { mesh: THREE.InstancedMesh; instanceId: number; isFile: boolean };
}

/** The analyzed tree, seen through the viewer's augmentable node type. */
export function asVNode(node: TreeNode): VNode {
  return node;
}
