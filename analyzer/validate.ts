/**
 * validate.ts — the one boundary a snapshot file crosses. `--snapshot x.json`
 * compiles what any producer (script, agent, export) wrote, so the JSON is
 * UNTRUSTED like a tour: `validateSnapshot` narrows field by field, rebuilds
 * every object from checked values, bounds sizes, and rejects (never repairs)
 * a stream `compile` would misread. Structural rules on the tree (one root,
 * parents first, keys as path segments) stay in `compile`, which owns them.
 * See DESIGN.md "Adapters".
 */
import type {
  EventType, MemberKind, ModuleInfo, ModuleKind, ModuleMember, ModuleRef, Noun, Pr, PrStatus, Vocabulary,
} from '../shared/types.js';
import { COLOR_RE, EVENT_KEY_RE, MAX_EVENT_TYPES, MAX_WORD } from '../shared/vocab.js';
import type { Item, Link, Snapshot, SourceEvent, SourceInfo, Touch } from './snapshot.js';

/** A snapshot is a city, not a payload: generous for real sources, finite for hostile ones. */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_ITEMS = 200_000;
const MAX_DEPTH = 64;
const MAX_SECTIONS = 5_000;
const MAX_MEMBERS = 2_000;
/** Sections plus their members, over all items — they dominate data.json's size. */
const MAX_TOTAL_SECTIONS = 1_000_000;
const MAX_REFS = 500;
const MAX_EVENTS = 100_000;
const MAX_TOUCHES = 20_000;
const MAX_TOTAL_TOUCHES = 2_000_000;
const MAX_LINKS = 500_000;
const MAX_INFLIGHT = 1_000;
const MAX_INFLIGHT_FILES = 5_000;
const MAX_SPANS = 1_000;
const MAX_ID = 1_024;
const MAX_KEY = 255;
const MAX_NAME = 300;
const MAX_TEXT = 1_000;
const MAX_URL = 2_048;
/** Counts and line numbers: integers JSON round-trips exactly. */
const MAX_INT = Number.MAX_SAFE_INTEGER;
/** Unix seconds, 1970..2100: a valid Date, and a timeline the viewer can bin by week. */
const MAX_TS = 4_102_444_800;

const MODULE_KINDS: readonly ModuleKind[] = ['function', 'class', 'component', 'interface', 'type', 'enum', 'const', 'section'];
const MEMBER_KINDS: readonly MemberKind[] = ['method', 'property', 'accessor', 'member'];
const PR_STATUSES: readonly PrStatus[] = ['ready', 'pending', 'failing', 'draft'];

/** Thrown with the JSON location that failed, e.g. `events[3].ts: not newest-first`. */
export class SnapshotError extends Error {}

/**
 * Check an unknown value against the Snapshot contract.
 * @returns a Snapshot built from validated fields only (extra properties never
 *          survive); throws SnapshotError naming the first violation.
 */
export function validateSnapshot(x: unknown): Snapshot {
  const o = record(x, 'snapshot');
  const items = validateItems(list(o.items, 'items', MAX_ITEMS));
  const asOf = time(o.asOf, 'asOf');
  const vocab = o.vocab === undefined ? undefined : validateVocab(o.vocab);
  return {
    source: validateSource(o.source),
    items,
    events: validateEvents(list(o.events ?? [], 'events', MAX_EVENTS), vocab?.eventTypes),
    asOf,
    links: list(o.links ?? [], 'links', MAX_LINKS).map((l, i) => validateLink(l, `links[${i}]`)),
    inflight: list(o.inflight ?? [], 'inflight', MAX_INFLIGHT).map((p, i) => validatePr(p, `inflight[${i}]`)),
    // `diff` is not read: it is git-only and its paths assume id = path.
    ...(vocab ? { vocab } : {}),
  };
}

function validateVocab(x: unknown): Vocabulary {
  const o = record(x, 'vocab');
  const v: Vocabulary = {};
  if (o.leaf !== undefined) v.leaf = validateNoun(o.leaf, 'vocab.leaf');
  if (o.event !== undefined) v.event = validateNoun(o.event, 'vocab.event');
  if (o.mass !== undefined) v.mass = text(o.mass, 'vocab.mass', MAX_WORD);
  if (o.eventTypes !== undefined) {
    const keys = new Set<string>();
    const raw = list(o.eventTypes, 'vocab.eventTypes', MAX_EVENT_TYPES);
    // Empty would read as "no vocabulary" in the viewer and revive subject parsing.
    if (!raw.length) throw new SnapshotError('vocab.eventTypes: empty (omit it for conventional-commit types)');
    v.eventTypes = raw.map((t, i): EventType => {
      const at = `vocab.eventTypes[${i}]`;
      const to = record(t, at);
      const key = to.key;
      if (typeof key !== 'string' || !EVENT_KEY_RE.test(key)) throw new SnapshotError(`${at}.key: not a slug ([a-z0-9-], ≤ 32)`);
      if (keys.has(key)) throw new SnapshotError(`${at}.key: repeats ${JSON.stringify(key)}`);
      keys.add(key);
      const color = to.color;
      if (typeof color !== 'string' || !COLOR_RE.test(color)) throw new SnapshotError(`${at}.color: not #rrggbb`);
      const label = text(to.label, `${at}.label`, MAX_WORD);
      const rework = to.rework === undefined ? false : bool(to.rework, `${at}.rework`);
      return rework ? { key, label, color, rework } : { key, label, color };
    });
  }
  return v;
}

function validateNoun(x: unknown, at: string): Noun {
  const o = record(x, at);
  return { one: text(o.one, `${at}.one`, MAX_WORD), many: text(o.many, `${at}.many`, MAX_WORD) };
}

/**
 * `root` is never read from the file: it becomes the dev API's filesystem and
 * git root, a privilege no snapshot producer gets. The git routes stay
 * unavailable for a snapshot city and the viewer hides their sections.
 */
function validateSource(x: unknown): SourceInfo {
  const o = record(x, 'source');
  return { name: text(o.name, 'source.name', MAX_NAME), root: '', url: optionalUrl(o.url, 'source.url') };
}

function validateItems(raw: unknown[]): Item[] {
  const depth = new Map<string, number>(); // item id -> depth; unknown parents are compile's error
  let sections = 0;
  return raw.map((x, i): Item => {
    const at = `items[${i}]`;
    const o = record(x, at);
    const id = itemId(o.id, `${at}.id`);
    const parent = o.parent === null ? null : itemId(o.parent, `${at}.parent`);
    const d = parent === null ? 0 : (depth.get(parent) ?? 0) + 1;
    if (d > MAX_DEPTH) throw new SnapshotError(`${at}: deeper than ${MAX_DEPTH}`);
    depth.set(id, d);
    const kind = o.kind;
    if (kind !== 'folder' && kind !== 'file') throw new SnapshotError(`${at}.kind: not 'folder' or 'file'`);
    // The root's key is never a path segment, so it may be empty.
    const key = parent === null && o.key === '' ? '' : token(o.key, `${at}.key`, MAX_KEY);
    const item: Item = {
      id, parent, key, kind,
      name: text(o.name, `${at}.name`, MAX_NAME),
      // Folders sum their children: their own mass is ignored.
      mass: kind === 'file' ? count(o.mass, `${at}.mass`, true) : 0,
    };
    if (o.sections !== undefined) {
      if (kind !== 'file') throw new SnapshotError(`${at}.sections: only files have sections`);
      item.sections = list(o.sections, `${at}.sections`, MAX_SECTIONS).map((s, j) => validateSection(s, `${at}.sections[${j}]`));
      for (const s of item.sections) sections += 1 + (s.children?.length ?? 0);
      if (sections > MAX_TOTAL_SECTIONS) throw new SnapshotError(`${at}.sections: more than ${MAX_TOTAL_SECTIONS} sections and members in all`);
    }
    return item;
  });
}

function validateSection(x: unknown, at: string): ModuleInfo {
  const o = record(x, at);
  const m: ModuleInfo = {
    name: text(o.name, `${at}.name`, MAX_NAME),
    kind: oneOf(o.kind, MODULE_KINDS, `${at}.kind`),
    loc: count(o.loc, `${at}.loc`),
    line: line(o.line, `${at}.line`),
    exported: o.exported === undefined ? false : bool(o.exported, `${at}.exported`),
  };
  if (o.sig !== undefined) m.sig = text(o.sig, `${at}.sig`, 200);
  if (o.children !== undefined) {
    m.children = list(o.children, `${at}.children`, MAX_MEMBERS).map((c, j): ModuleMember => {
      const ca = `${at}.children[${j}]`;
      const co = record(c, ca);
      const member: ModuleMember = {
        name: text(co.name, `${ca}.name`, MAX_NAME),
        kind: oneOf(co.kind, MEMBER_KINDS, `${ca}.kind`),
        loc: count(co.loc, `${ca}.loc`),
        line: line(co.line, `${ca}.line`),
      };
      if (co.sig !== undefined) member.sig = text(co.sig, `${ca}.sig`, 200);
      return member;
    });
  }
  if (o.refs !== undefined) {
    m.refs = list(o.refs, `${at}.refs`, MAX_REFS).map((r, j): ModuleRef => {
      const ro = record(r, `${at}.refs[${j}]`);
      return { name: text(ro.name, `${at}.refs[${j}].name`, MAX_NAME), n: count(ro.n, `${at}.refs[${j}].n`) };
    });
  }
  return m;
}

/**
 * Newest first, as given: strata rebuild size-at-event from this order, so it is
 * checked, not sorted. With declared types, an event's `type` must be one of
 * them and its `rework` is the type's: the legend's Fix hotspots and the
 * tree's `fixChurn` must count the same events.
 */
function validateEvents(raw: unknown[], types: EventType[] | undefined): SourceEvent[] {
  const declared = new Map((types ?? []).map((t) => [t.key, t]));
  let total = 0;
  let prev = Infinity;
  const ids = new Set<string>(); // the viewer looks a selected event up by id
  return raw.map((x, i): SourceEvent => {
    const at = `events[${i}]`;
    const o = record(x, at);
    const ts = time(o.ts, `${at}.ts`);
    if (ts > prev) throw new SnapshotError(`${at}.ts: not newest-first (${ts} after ${prev})`);
    prev = ts;
    const touches = list(o.touches, `${at}.touches`, MAX_TOUCHES);
    total += touches.length;
    if (total > MAX_TOTAL_TOUCHES) throw new SnapshotError(`${at}.touches: more than ${MAX_TOTAL_TOUCHES} in all`);
    const seen = new Set<string>(); // a repeated item would count its churn twice
    let type: EventType | undefined;
    if (o.type !== undefined) {
      type = typeof o.type === 'string' ? declared.get(o.type) : undefined;
      if (!type) throw new SnapshotError(`${at}.type: not a key of vocab.eventTypes`);
    }
    const rework = o.rework === undefined ? type?.rework === true : bool(o.rework, `${at}.rework`);
    if (types && rework !== (type?.rework === true)) {
      throw new SnapshotError(`${at}.rework: disagrees with its type (rework comes from vocab.eventTypes)`);
    }
    return {
      id: eventId(o.id, `${at}.id`, ids),
      ts,
      actor: o.actor === undefined ? '' : text(o.actor, `${at}.actor`, MAX_NAME, true),
      subject: o.subject === undefined ? '' : text(o.subject, `${at}.subject`, MAX_TEXT, true),
      rework,
      ...(type ? { type: type.key } : {}),
      touches: touches.map((t, j): Touch => {
        const ta = `${at}.touches[${j}]`;
        const to = record(t, ta);
        const item = itemId(to.item, `${ta}.item`);
        if (seen.has(item)) throw new SnapshotError(`${ta}.item: repeats ${JSON.stringify(item)} in one event`);
        seen.add(item);
        return { item, adds: count(to.adds, `${ta}.adds`, true), dels: count(to.dels, `${ta}.dels`, true) };
      }),
    };
  });
}

function eventId(x: unknown, at: string, ids: Set<string>): string {
  const id = token(x, at, 128);
  if (ids.has(id)) throw new SnapshotError(`${at}: repeats ${JSON.stringify(id)}`);
  ids.add(id);
  return id;
}

function validateLink(x: unknown, at: string): Link {
  const o = record(x, at);
  return { from: itemId(o.from, `${at}.from`), to: itemId(o.to, `${at}.to`), n: count(o.n, `${at}.n`) };
}

function validatePr(x: unknown, at: string): Pr {
  const o = record(x, at);
  const pr: Pr = {
    number: count(o.number, `${at}.number`),
    title: text(o.title, `${at}.title`, MAX_TEXT),
    author: text(o.author, `${at}.author`, MAX_NAME),
    avatarUrl: optionalUrl(o.avatarUrl, `${at}.avatarUrl`),
    isDraft: bool(o.isDraft, `${at}.isDraft`),
    // Spread in place, not assigned after: key order matches the git adapter's.
    ...(o.status !== undefined ? { status: oneOf(o.status, PR_STATUSES, `${at}.status`) } : {}),
    updatedAt: text(o.updatedAt, `${at}.updatedAt`, 64),
    additions: count(o.additions, `${at}.additions`),
    deletions: count(o.deletions, `${at}.deletions`),
    files: list(o.files, `${at}.files`, MAX_INFLIGHT_FILES).map((f, j) => itemId(f, `${at}.files[${j}]`)),
  };
  if (o.spans !== undefined) {
    const spans = record(o.spans, `${at}.spans`);
    // No prototype: an item id `__proto__` must stay an own key.
    const out: Record<string, [number, number][]> = Object.create(null);
    for (const [id, ranges] of Object.entries(spans)) {
      const sa = `${at}.spans[${JSON.stringify(id)}]`;
      itemId(id, sa);
      out[id] = list(ranges, sa, MAX_SPANS).map((r, j): [number, number] => {
        const pair = list(r, `${sa}[${j}]`, 2);
        const start = line(pair[0], `${sa}[${j}][0]`);
        const end = line(pair[1], `${sa}[${j}][1]`);
        if (end < start) throw new SnapshotError(`${sa}[${j}]: end before start`);
        return [start, end];
      });
    }
    pr.spans = out;
  }
  return pr;
}

// ---------------------------------------------------------------------------
// Narrowing helpers — each throws with the location it checked
// ---------------------------------------------------------------------------

function record(x: unknown, at: string): Record<string, unknown> {
  if (!isRecord(x)) throw new SnapshotError(`${at}: not an object`);
  return x;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function list(x: unknown, at: string, max: number): unknown[] {
  if (!Array.isArray(x)) throw new SnapshotError(`${at}: not an array`);
  if (x.length > max) throw new SnapshotError(`${at}: more than ${max} entries`);
  return x;
}

/** Display text: a string within `max` chars; empty only when `allowEmpty`. */
function text(x: unknown, at: string, max: number, allowEmpty = false): string {
  if (typeof x !== 'string') throw new SnapshotError(`${at}: not a string`);
  if (!allowEmpty && !x.trim()) throw new SnapshotError(`${at}: empty`);
  if (x.length > max) throw new SnapshotError(`${at}: longer than ${max} chars`);
  return x;
}

/** An identifier (key, event id): non-empty, bounded, no control characters. */
function token(x: unknown, at: string, max: number, allowEmpty = false): string {
  const s = text(x, at, max, allowEmpty);
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new SnapshotError(`${at}: contains control characters`);
  return s;
}

/** An item id: a token that may be empty — the git adapter's root is `''`. */
function itemId(x: unknown, at: string): string {
  return token(x, at, MAX_ID, true);
}

function finite(x: unknown, at: string): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new SnapshotError(`${at}: not a finite number`);
  return x;
}

function time(x: unknown, at: string): number {
  const n = finite(x, at);
  if (n < 0 || n > MAX_TS) throw new SnapshotError(`${at}: not unix seconds between 1970 and 2100`);
  return n;
}

/** A non-negative integer, or (with `fractional`) any non-negative finite number — mass may be points or hours. */
function count(x: unknown, at: string, fractional = false): number {
  const n = finite(x, at);
  if (n < 0 || n > MAX_INT || (!fractional && !Number.isInteger(n))) {
    throw new SnapshotError(`${at}: not a non-negative ${fractional ? 'number' : 'integer'}`);
  }
  return n;
}

/** A 1-based line number. */
function line(x: unknown, at: string): number {
  const n = count(x, at);
  if (n < 1) throw new SnapshotError(`${at}: line numbers start at 1`);
  return n;
}

function bool(x: unknown, at: string): boolean {
  if (typeof x !== 'boolean') throw new SnapshotError(`${at}: not a boolean`);
  return x;
}

function oneOf<T extends string>(x: unknown, allowed: readonly T[], at: string): T {
  const hit = allowed.find((a) => a === x);
  if (hit === undefined) throw new SnapshotError(`${at}: not one of ${allowed.join(', ')}`);
  return hit;
}

/**
 * Absent, null, or https with none of the characters that break out of an attribute:
 * the viewer interpolates `source.url` into an `href` and loads avatars as images.
 */
function optionalUrl(x: unknown, at: string): string | null {
  if (x === undefined || x === null) return null;
  if (typeof x !== 'string' || x.length > MAX_URL
    || !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~%!$&()*+,;=:@/-]*)?$/.test(x)) {
    throw new SnapshotError(`${at}: not a plain https URL`);
  }
  return x;
}
