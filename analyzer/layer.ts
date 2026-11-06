/**
 * layer.ts — the boundary a `--layer x.json` file crosses. A layer is another
 * tool's measurements (duped, coverage, telemetry) keyed by item id; the JSON
 * is UNTRUSTED like a snapshot: `validateLayer` narrows field by field,
 * rebuilds every object, bounds sizes and rejects (never repairs).
 * `resolveLayer` maps ids onto the compiled city's paths and drops the ones it
 * does not hold, counting them. See DESIGN.md "Layers".
 */
import fs from 'node:fs';
import type { CityData, CityLayer, LayerEdge, LayerItem, TreeNode } from '../shared/types.js';
import { SLUG_RE } from '../shared/vocab.js';

export const MAX_LAYER_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_ID = 1_024;
const MAX_LABEL = 60;
const MAX_TEXT = 400;
const REV_RE = /^[0-9a-f]{7,40}$/;

/** Thrown with the JSON location that failed, e.g. `items[3].v: not a number ≥ 0`. */
export class LayerError extends Error {}

/** A validated layer whose items and edges still name source ids. */
export type LayerInput = Omit<CityLayer, 'items' | 'edges'> & {
  items: Array<Omit<LayerItem, 'path'> & { id: string }>;
  edges: LayerEdge[];
};

export function readLayer(file: string): LayerInput {
  const size = fs.statSync(file).size;
  if (size > MAX_LAYER_BYTES) throw new LayerError(`over ${MAX_LAYER_BYTES} bytes: ${file}`);
  return validateLayer(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function validateLayer(raw: unknown): LayerInput {
  const x = record(raw, 'layer');
  const id = str(x.id, 'id', 32);
  if (!SLUG_RE.test(id)) throw new LayerError(`id: must match ${SLUG_RE}`);
  const out: LayerInput = { id, label: str(x.label, 'label', MAX_LABEL), items: [], edges: [] };
  if (x.unit !== undefined) out.unit = str(x.unit, 'unit', MAX_LABEL);
  if (x.source !== undefined) {
    const s = record(x.source, 'source');
    const source: { tool?: string; rev?: string } = {};
    if (s.tool !== undefined) source.tool = str(s.tool, 'source.tool', MAX_LABEL);
    if (s.rev !== undefined) {
      source.rev = str(s.rev, 'source.rev', 40);
      if (!REV_RE.test(source.rev)) throw new LayerError('source.rev: not a 7–40 hex commit');
    }
    out.source = source;
  }
  const seen = new Set<string>();
  for (const [i, e] of list(x.items, 'items').entries()) {
    const at = `items[${i}]`;
    const r = record(e, at);
    const item: LayerInput['items'][number] = { id: str(r.id, `${at}.id`, MAX_ID), v: value(r.v, `${at}.v`) };
    if (seen.has(item.id)) throw new LayerError(`${at}.id: duplicate "${item.id}"`);
    seen.add(item.id);
    if (r.note !== undefined) item.note = str(r.note, `${at}.note`, MAX_TEXT);
    out.items.push(item);
  }
  if (x.edges !== undefined) {
    for (const [i, e] of list(x.edges, 'edges').entries()) {
      const at = `edges[${i}]`;
      const r = record(e, at);
      const edge: LayerEdge = { a: str(r.a, `${at}.a`, MAX_ID), b: str(r.b, `${at}.b`, MAX_ID), v: value(r.v, `${at}.v`) };
      if (r.aLine !== undefined) edge.aLine = line(r.aLine, `${at}.aLine`);
      if (r.bLine !== undefined) edge.bLine = line(r.bLine, `${at}.bLine`);
      if (r.note !== undefined) edge.note = str(r.note, `${at}.note`, MAX_TEXT);
      out.edges.push(edge);
    }
  }
  return out;
}

/** Ids → the city's paths (`TreeNode.id ?? path`, files only); unknown ids are dropped and counted. */
export function resolveLayer(layer: LayerInput, data: CityData): { layer: CityLayer; dropped: number } {
  const byId = new Map<string, string>();
  const walk = (n: TreeNode): void => {
    if (n.type === 'file') byId.set(n.id ?? n.path, n.path);
    else for (const c of n.children) walk(c);
  };
  walk(data.tree);
  let dropped = 0;
  const items: LayerItem[] = [];
  for (const { id, ...rest } of layer.items) {
    const p = byId.get(id);
    if (p === undefined) dropped++;
    else items.push({ path: p, ...rest });
  }
  const edges: LayerEdge[] = [];
  for (const e of layer.edges) {
    const a = byId.get(e.a);
    const b = byId.get(e.b);
    if (a === undefined || b === undefined) dropped++;
    else edges.push({ ...e, a, b });
  }
  const out: CityLayer = { id: layer.id, label: layer.label, items };
  if (layer.unit) out.unit = layer.unit;
  if (layer.source) out.source = layer.source;
  if (edges.length) out.edges = edges;
  return { layer: out, dropped };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function record(v: unknown, at: string): Record<string, unknown> {
  if (!isRecord(v)) throw new LayerError(`${at}: not an object`);
  return v;
}

function list(v: unknown, at: string): unknown[] {
  if (!Array.isArray(v)) throw new LayerError(`${at}: not an array`);
  if (v.length > MAX_ENTRIES) throw new LayerError(`${at}: over ${MAX_ENTRIES} entries`);
  return v;
}

function str(v: unknown, at: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new LayerError(`${at}: not a non-empty string`);
  if (v.length > max) throw new LayerError(`${at}: over ${max} characters`);
  return v;
}

function value(v: unknown, at: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new LayerError(`${at}: not a number ≥ 0`);
  return v;
}

function line(v: unknown, at: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new LayerError(`${at}: not a line ≥ 1`);
  return v;
}
