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
  /** Present only when the analyzer ran with `--diff <base>..<head>`. */
  diff?: DiffScope;
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
  | 'function' | 'class' | 'component' | 'interface' | 'type' | 'enum' | 'const'
  | 'section'; // markdown heading

export type MemberKind = 'method' | 'property' | 'accessor' | 'member';

export interface ModuleInfo {
  name: string;
  kind: ModuleKind;
  loc: number;
  /** 1-based start line. */
  line: number;
  exported: boolean;
  /** The interface as written: `(a: T, b?: U): R`, `extends X`, `= { … }`, `: T`. */
  sig?: string;
  /** Class methods/properties/accessors, interface members, enum members. */
  children?: ModuleMember[];
  /** Same-file top-level modules this one's body names, with occurrence counts. */
  refs?: ModuleRef[];
}

export interface ModuleRef {
  name: string;
  n: number;
}

export interface ModuleMember {
  name: string;
  kind: MemberKind;
  loc: number;
  /** 1-based start line. */
  line: number;
  sig?: string;
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
  /** Per file, the head-side line ranges its hunks touch (`[start, end]`, 1-based). */
  spans?: Record<string, [number, number][]>;
}

/** One commit of the stream: hash, unix seconds, author, subject, file indices. */
export interface Commit {
  h: string;
  ts: number;
  a: string;
  s: string;
  f: number[];
  /** Per-file `[additions, deletions]`, aligned index-for-index with `f`. */
  d?: [number, number][];
}

/**
 * One diff, as the city sees it (see DESIGN.md "Diff scope & PR provenance").
 *
 * The **diff scope** is the changed-file set: a file absent from `files` is
 * outside it. **Provenance** is the per-file bucketing carried on top — the
 * first overlay to read this section, and not the last (import blast radius and
 * PR tours are meant to sit on the same scope). Paths are repo-relative.
 */
export interface DiffScope {
  /** Resolved commit hashes of the compared range. */
  base: string;
  head: string;
  /** The range as the user named it (`develop`, `feat/x`, a short hash) — for display. */
  baseRef?: string;
  headRef?: string;
  /** Changed files, biggest added-line count first. */
  files: DiffFile[];
  /**
   * The branch's own commits (`git rev-list base..head`), full hashes — the
   * stream's `Commit.h` is abbreviated, so match on a prefix.
   */
  commits?: string[];
  /** Committer timestamps of base and head, unix seconds like `Commit.ts`. */
  baseTs?: number;
  headTs?: number;
}

export interface DiffFile {
  path: string;
  /** Added lines git matched as moved unchanged from elsewhere in the diff. */
  verbatim: number;
  /** Added lines paired with a deleted line but modified in transit. */
  reshaped: number;
  /** Added lines nothing in the diff explains — the logic to actually read. */
  new: number;
  /** Deleted lines. */
  deleted: number;
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

/** One `git status --porcelain` entry: `x` = index status, `y` = worktree. */
export interface StatusChange {
  path: string;
  x: string;
  y: string;
  untracked: boolean;
}

export interface StatusResponse {
  changes: StatusChange[];
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
