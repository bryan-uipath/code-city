/**
 * compile.ts — Snapshot -> CityData. The one place any source becomes the
 * viewer contract: item tree -> TreeNode (paths from keys, folder sums), events
 * -> churn + the indexed commit stream, item ids -> paths everywhere else.
 */
import type { CityData, Commit, Edge, FileNode, FolderNode, Pr, TreeNode } from '../shared/types.js';
import type { Item, Snapshot, SourceEvent } from './snapshot.js';

const DAY = 86400;

/** Commit counts for one leaf. */
interface Churn {
  churn: number;
  fixChurn: number;
  recentChurn: number;
}

export function compile(snap: Snapshot): CityData {
  const churn = countChurn(snap.events, snap.asOf);
  const paths = new Map<string, string>(); // item id -> repo-relative path
  const folders = new Map<string, FolderNode>();
  const files: string[] = [];
  const fileIndex = new Map<string, number>(); // item id -> index into `files`
  let tree: FolderNode | null = null;

  for (const item of snap.items) {
    if (item.parent === null) {
      if (tree) throw new Error(`snapshot has two roots: ${item.id}`);
      if (item.kind !== 'folder') throw new Error(`snapshot root is not a folder: ${item.id}`);
      tree = folderNode(item, '');
      paths.set(item.id, '');
      folders.set(item.id, tree);
      continue;
    }
    const parent = folders.get(item.parent);
    const parentPath = paths.get(item.parent);
    if (!parent || parentPath === undefined) throw new Error(`snapshot item before its parent folder: ${item.id}`);
    const p = parentPath ? `${parentPath}/${item.key}` : item.key;
    paths.set(item.id, p);
    if (item.kind === 'folder') {
      const node = folderNode(item, p);
      folders.set(item.id, node);
      parent.children.push(node);
    } else {
      parent.children.push(fileNode(item, p, churn.get(item.id)));
      fileIndex.set(item.id, files.length);
      files.push(p);
    }
  }
  if (!tree) throw new Error('snapshot has no root item');
  sum(tree);

  return {
    repo: {
      name: snap.source.name,
      root: snap.source.root,
      analyzedAt: new Date().toISOString(),
      githubUrl: snap.source.url,
    },
    tree,
    edges: snap.links.flatMap((l): Edge[] => {
      const a = paths.get(l.from);
      const b = paths.get(l.to);
      return a === undefined || b === undefined ? [] : [{ a, b, n: l.n }];
    }),
    prs: snap.inflight.flatMap((pr) => inflightPr(pr, fileIndex, paths)),
    files,
    commits: snap.events.flatMap((e) => commitOf(e, fileIndex)),
    ...(snap.diff ? { diff: snap.diff } : {}),
  };
}

function folderNode(item: Item, path: string): FolderNode {
  return { type: 'folder', name: item.name, path, loc: 0, churn: 0, fixChurn: 0, recentChurn: 0, children: [] };
}

function fileNode(item: Item, path: string, c: Churn | undefined): FileNode {
  return {
    type: 'file',
    name: item.name,
    path,
    loc: item.mass,
    churn: c?.churn ?? 0,
    fixChurn: c?.fixChurn ?? 0,
    recentChurn: c?.recentChurn ?? 0,
    modules: item.sections ?? [],
  };
}

function sum(node: TreeNode): void {
  if (node.type === 'file') return;
  for (const child of node.children) {
    sum(child);
    node.loc += child.loc;
    node.churn += child.churn;
    node.fixChurn += child.fixChurn;
    node.recentChurn += child.recentChurn;
  }
}

/** Leaf id -> churn counts over the whole stream; recent = the 30 days before `asOf`. */
function countChurn(events: SourceEvent[], asOf: number): Map<string, Churn> {
  const churn = new Map<string, Churn>();
  const recentCutoff = asOf - 30 * DAY;
  for (const e of events) {
    const isRecent = e.ts >= recentCutoff;
    for (const t of e.touches) {
      let c = churn.get(t.item);
      if (!c) churn.set(t.item, (c = { churn: 0, fixChurn: 0, recentChurn: 0 }));
      c.churn++;
      if (e.rework) c.fixChurn++;
      if (isRecent) c.recentChurn++;
    }
  }
  return churn;
}

/** An event as a commit of the stream; none when it touches no leaf in the tree. */
function commitOf(e: SourceEvent, fileIndex: Map<string, number>): Commit[] {
  const f: number[] = [];
  const d: [number, number][] = [];
  for (const t of e.touches) {
    const idx = fileIndex.get(t.item);
    if (idx === undefined) continue;
    f.push(idx);
    d.push([t.adds, t.dels]);
  }
  return f.length ? [{ h: e.id, ts: e.ts, a: e.actor, s: e.subject, f, d }] : [];
}

/** Inflight work re-pointed from item ids to paths; dropped when it touches no leaf. */
function inflightPr(pr: Pr, fileIndex: Map<string, number>, paths: Map<string, string>): Pr[] {
  const files = pr.files.filter((id) => fileIndex.has(id)).map((id) => paths.get(id) ?? id);
  if (!files.length) return [];
  if (!pr.spans) return [{ ...pr, files }];
  const spans: Record<string, [number, number][]> = {};
  for (const [id, ranges] of Object.entries(pr.spans)) {
    const p = paths.get(id);
    if (p !== undefined && fileIndex.has(id)) spans[p] = ranges;
  }
  return [{ ...pr, files, spans }];
}
