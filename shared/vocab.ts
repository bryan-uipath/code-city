/**
 * vocab.ts — the rules for a source vocabulary (`CityData.vocab`), shared by the
 * analyzer's strict `validateSnapshot` and the viewer's lenient `readVocabulary`.
 * Event-type keys and colors reach legend markup and CSS, so both sides hold
 * them to the same shapes. See DESIGN.md "Adapters".
 */
import type { EventType, Noun, Vocabulary } from './types.js';

/** A short slug, nothing to escape: event-type keys, provider names. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Keys land in a `data-type` attribute and `Commit.t`. */
export const EVENT_KEY_RE = SLUG_RE;
/** Colors land in inline CSS: `#rrggbb` only. */
export const COLOR_RE = /^#[0-9a-f]{6}$/i;
export const MAX_EVENT_TYPES = 16;
/** Nouns, labels and the mass unit: legend- and HUD-sized. */
export const MAX_WORD = 24;

/**
 * The viewer's read of `data.vocab`: well-formed fields kept, the rest dropped
 * (falling back to the code default). data.json is the analyzer's output, but a
 * hand-edited or older file must still render, never break the legend.
 */
export function readVocabulary(x: unknown): Vocabulary {
  if (!isRecord(x)) return {};
  const v: Vocabulary = {};
  const leaf = noun(x.leaf);
  if (leaf) v.leaf = leaf;
  const event = noun(x.event);
  if (event) v.event = event;
  const mass = word(x.mass);
  if (mass) v.mass = mass;
  if (Array.isArray(x.eventTypes)) {
    const types: EventType[] = [];
    const seen = new Set<string>();
    for (const t of x.eventTypes.slice(0, MAX_EVENT_TYPES)) {
      if (!isRecord(t)) continue;
      const label = word(t.label);
      const { key, color } = t;
      if (typeof key !== 'string' || !EVENT_KEY_RE.test(key) || seen.has(key)) continue;
      if (typeof color !== 'string' || !COLOR_RE.test(color) || !label) continue;
      seen.add(key);
      types.push(t.rework === true ? { key, label, color, rework: true } : { key, label, color });
    }
    if (types.length) v.eventTypes = types;
  }
  return v;
}

/** The words the viewer labels with: the vocabulary, code defaults filled in. */
export interface Words {
  leaf: Noun;
  event: Noun;
  mass: string;
}

export function wordsOf(v: Vocabulary): Words {
  return {
    leaf: v.leaf ?? { one: 'file', many: 'files' },
    event: v.event ?? { one: 'commit', many: 'commits' },
    mass: v.mass ?? 'loc',
  };
}

function noun(x: unknown): Noun | null {
  if (!isRecord(x)) return null;
  const one = word(x.one);
  const many = word(x.many);
  return one && many ? { one, many } : null;
}

function word(x: unknown): string | null {
  return typeof x === 'string' && x.trim() && x.length <= MAX_WORD ? x : null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
