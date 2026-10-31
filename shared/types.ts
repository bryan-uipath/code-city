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
  /** What the source calls its things; absent = code (files, loc, commits). */
  vocab?: Vocabulary;
}

/**
 * A source's words and event types, for labels and the strata legend. Every
 * field is optional and falls back to the code default, so a dataset without
 * one renders exactly as before.
 */
export interface Vocabulary {
  /** Leaf noun — default file / files. */
  leaf?: Noun;
  /** Event noun — default commit / commits. */
  event?: Noun;
  /** Leaf mass unit, short — default `loc`; e.g. `lines`, `words`, `points`. */
  mass?: string;
  /** Legend order. Absent = conventional-commit types parsed from subjects. */
  eventTypes?: EventType[];
}

export interface Noun {
  one: string;
  many: string;
}

/** One kind of event, as the adapter classified it (`Commit.t`). */
export interface EventType {
  /** `[a-z0-9-]`, at most 32 chars. */
  key: string;
  label: string;
  /** `#rrggbb`. */
  color: string;
  /** A fix, a reopen: Fix hotspots filters the strata to these. */
  rework?: boolean;
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

/**
 * How close a PR is to landing, as the city colors it:
 * `ready` green, `pending` yellow (checks running), `failing` red, `draft` grey.
 */
export type PrStatus = 'ready' | 'pending' | 'failing' | 'draft';

export interface Pr {
  number: number;
  title: string;
  author: string;
  avatarUrl: string | null;
  isDraft: boolean;
  /**
   * Absent in data.json written by an analyzer older than the status pass (and
   * whenever `gh` could not answer) — the viewer then falls back to draft/pending.
   */
  status?: PrStatus;
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
  /** Event type key from `vocab.eventTypes`; absent = parsed from the subject. */
  t?: string;
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
  /**
   * Every path the range changes, renames detected — including what `files`
   * cannot hold (deleted, binary, outside the roots). Absent from older data.json.
   */
  manifest?: DiffEntry[];
}

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type';

/** Why a changed path has no building in this city. */
export type OffCity = 'deleted' | 'binary' | 'outside-roots' | 'filtered' | 'not-at-head';

/** One `git diff --name-status -M` row. */
export interface DiffEntry {
  path: string;
  status: DiffStatus;
  /** The base-side path of a rename or copy. */
  oldPath?: string;
  /** git reports no line counts for it. */
  binary?: boolean;
  /** `<baseMode>.<headMode>.<baseBlob>.<headBlob>` (blobs 12 hex): changes exactly when this path's diff does. */
  fp?: string;
  /** Set only when the city has no building at `path`. */
  why?: OffCity;
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
  /**
   * Head-side line ranges its hunks change (`[start, end]`, 1-based, zero
   * context; a pure deletion is `[n, n]` at the line before it). Absent in
   * data.json from an older analyzer.
   */
  spans?: [number, number][];
  /**
   * The working copy's own edits to this file against `head`, as `-U0` hunk
   * headers `[headStart, headLen, wcStart, wcLen]`. Module lines are working-copy
   * lines; this maps them onto `spans`. Absent when the two agree.
   */
  worktree?: HunkHeader[];
}

/** One `@@ -a,b +c,d @@` header as `[a, b, c, d]`; a zero length names the line before the gap. */
export type HunkHeader = [number, number, number, number];

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
  /** True only when a line range was honoured (`git log -L`); false = file-wide fallback. */
  scoped?: boolean;
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
  /**
   * Lines added / removed against HEAD — staged and unstaged hunks summed. An
   * untracked file reports its own length as `added`. Absent when the dev API
   * predates the numstat pass, in which case the city paints magnitude-neutral.
   */
  added?: number;
  removed?: number;
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
