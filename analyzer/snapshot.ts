/**
 * snapshot.ts — the adapter contract: what every source (git today; Confluence,
 * Jira next) emits, and `compile.ts` turns into data.json. Adapters say what
 * exists and what happened; tree sums, churn and the commit index table are
 * derived once, in `compile`. See DESIGN.md "Adapters".
 */
import type { DiffScope, ModuleInfo, Pr } from '../shared/types.js';

export interface Snapshot {
  source: SourceInfo;
  /** The tree, flat: parents before children, sibling order = render order, one root. */
  items: Item[];
  /** Newest first. */
  events: SourceEvent[];
  links: Link[];
  /** Open work in progress; `files` and `spans` keys name item ids. */
  inflight: Pr[];
  diff?: DiffScope;
}

/** What an adapter hands the CLI: the snapshot plus lines for its run summary. */
export interface AdapterResult {
  snapshot: Snapshot;
  summary: string[];
}

export interface SourceInfo {
  name: string;
  /** Where the source lives (repo dir, site URL) — what the dev API resolves against. */
  root: string;
  url: string | null;
}

export interface Item {
  /** Stable and unique: a repo path, a Jira key, a page id. */
  id: string;
  parent: string | null;
  /** Path segment, unique among siblings, no `/` — e.g. `PROJ-345`, `index.ts`. */
  key: string;
  /** Display name — e.g. a ticket title. */
  name: string;
  kind: 'folder' | 'file';
  /** Leaf size (lines, words, points); folders sum their children. */
  mass: number;
  sections?: ModuleInfo[];
}

export interface SourceEvent {
  id: string;
  /** Unix seconds. */
  ts: number;
  actor: string;
  subject: string;
  /** Counts toward `fixChurn` — a fix, a reopen. */
  rework: boolean;
  touches: Touch[];
}

/** One item an event changed, and by how much. */
export interface Touch {
  item: string;
  adds: number;
  dels: number;
}

/** `from` references `to`, `n` times. */
export interface Link {
  from: string;
  to: string;
  n: number;
}
