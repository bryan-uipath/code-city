/**
 * types.ts — the `viewer/public/data.json` contract (see DESIGN.md) plus the
 * dev-API response shapes, shared by the analyzer (producer) and the viewer
 * (consumer).
 */

// ---------------------------------------------------------------------------
// data.json
// ---------------------------------------------------------------------------

export interface CityData {
  repo: RepoInfo;
  /** Repo root folder node. */
  tree: TreeNode;
  edges: Edge[];
  prs: Pr[];
  /** Index table for `Commit.f`. */
  files: string[];
  /** Newest-first, last 12 months. */
  commits: Commit[];
}

export interface RepoInfo {
  name: string;
  root: string;
  analyzedAt: string;
  githubUrl: string | null;
}

export type TreeNode = FolderNode | FileNode;

interface NodeStats {
  name: string;
  /** Repo-relative POSIX path; '' for the repo root node. */
  path: string;
  loc: number;
  /** Commits touching the node in the last 12 months. */
  churn: number;
  /** Subset of `churn` whose subject looks like a fix. */
  fixChurn: number;
  /** Subset of `churn` from the last 30 days. */
  recentChurn: number;
}

export interface FolderNode extends NodeStats {
  type: 'folder';
  children: TreeNode[];
}

export interface FileNode extends NodeStats {
  type: 'file';
  modules: ModuleInfo[];
}

export type ModuleKind =
  | 'function' | 'class' | 'component' | 'interface' | 'type' | 'enum' | 'const';

export type MemberKind = 'method' | 'property' | 'accessor' | 'member';

export interface ModuleInfo {
  name: string;
  kind: ModuleKind;
  loc: number;
  /** 1-based start line. */
  line: number;
  exported: boolean;
  /** Class methods/properties/accessors, interface members, enum members. */
  children?: ModuleMember[];
}

export interface ModuleMember {
  name: string;
  kind: MemberKind;
  loc: number;
  /** 1-based start line. */
  line: number;
}

/** `a` imports `b`, `n` times (deduped per ordered pair). */
export interface Edge {
  a: string;
  b: string;
  n: number;
}

export interface Pr {
  number: number;
  title: string;
  author: string;
  avatarUrl: string | null;
  isDraft: boolean;
  updatedAt: string;
  additions: number;
  deletions: number;
  /** Filtered to files present in the tree. */
  files: string[];
}

/** One commit of the stream: hash, unix seconds, author, subject, file indices. */
export interface Commit {
  h: string;
  ts: number;
  a: string;
  s: string;
  f: number[];
}

// ---------------------------------------------------------------------------
// Dev API (see DESIGN.md "Dev API")
// ---------------------------------------------------------------------------

export interface SourceResponse {
  path: string;
  start: number;
  end: number;
  total: number;
  lines: string[];
}

export interface LogCommit {
  h: string;
  ts: number;
  a: string;
  s: string;
}

export interface LogResponse {
  commits: LogCommit[];
}

export interface DiffResponse {
  diff: string;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResponse {
  q: string;
  matches: SearchMatch[];
  truncated: boolean;
}
