/**
 * tour.ts — the Tour SDK: a codified guided walk through the city.
 *
 * A tour is plain JSON, so it can be written by hand, checked into a repo, or
 * emitted by a coding agent that just read a PR diff (see docs/tours.md). It is
 * therefore UNTRUSTED input: everything that reaches the viewer passes through
 * `validateTour`, which narrows field by field, drops anything malformed, and
 * scheme-checks every URL. The player renders narration as plain text — never
 * as markup — so a hostile tour file can style nothing and script nothing.
 */

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface Tour {
  title: string;
  steps: TourStep[];
}

/** How the camera presents a step's target. */
export type TourCamera = 'isolate' | 'frame' | 'orbit';

export interface TourStep {
  /** `path`, `path#module`, or `path:start-end` (1-based inclusive lines). */
  target: string;
  title: string;
  /** Plain text; blank lines separate paragraphs. Never rendered as markup. */
  narration: string;
  artifacts?: TourArtifact[];
  camera?: TourCamera;
  /** Extra targets to co-highlight — the change's blast radius. */
  highlight?: string[];
}

export type TourArtifact = TourDiff | TourImage | TourLink;

/** Rendered through `CityHost.getDiff` — never a diff body carried in the file. */
export interface TourDiff {
  type: 'diff';
  /** 7–40 hex characters. */
  commit: string;
  /** Repo-relative path; defaults to the step's target path. */
  path?: string;
}

export interface TourImage {
  type: 'image';
  /** https: or data:image/ only. */
  src: string;
  caption?: string;
}

export interface TourLink {
  type: 'link';
  /** https: only. */
  href: string;
  label: string;
}

/** A parsed `target` string. */
export interface TourTarget {
  path: string;
  module: string | null;
  range: { start: number; end: number } | null;
}

// ---------------------------------------------------------------------------
// Limits — a tour is a narrative, not a payload
// ---------------------------------------------------------------------------

const MAX_STEPS = 60;
const MAX_ARTIFACTS = 8;
const MAX_HIGHLIGHTS = 60;
const MAX_TITLE = 200;
const MAX_NARRATION = 4000;
const MAX_URL = 4096;
const HASH_RE = /^[0-9a-f]{7,40}$/;

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * `path` · `path#module` · `path:start-end`. The two suffixes are mutually
 * exclusive; anything unparseable degrades to a plain path so a slightly wrong
 * target still flies somewhere sensible.
 */
export function parseTourTarget(target: string): TourTarget {
  const hash = target.indexOf('#');
  if (hash >= 0) {
    const path = target.slice(0, hash);
    const module = target.slice(hash + 1);
    return { path, module: module || null, range: null };
  }
  const m = /^(.*):(\d+)-(\d+)$/.exec(target);
  if (m) {
    const path = m[1] ?? '';
    const start = Number(m[2]);
    const end = Number(m[3]);
    if (path && Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start) {
      return { path, module: null, range: { start, end } };
    }
  }
  return { path: target, module: null, range: null };
}

// ---------------------------------------------------------------------------
// URL safety
// ---------------------------------------------------------------------------

/** Images may only come from https: or an inline data:image/ URL. */
export function isSafeImageSrc(src: string): boolean {
  if (src.length > MAX_URL) return false;
  const lower = src.trim().toLowerCase();
  if (lower.startsWith('https://')) return true;
  return /^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(src.trim());
}

/** Links may only be https:. */
export function isSafeLinkHref(href: string): boolean {
  return href.length <= MAX_URL && href.trim().toLowerCase().startsWith('https://');
}

// ---------------------------------------------------------------------------
// Runtime validation — the one boundary untrusted JSON crosses
// ---------------------------------------------------------------------------

/**
 * Check an unknown value against the Tour contract.
 * @returns a Tour built from scratch out of the validated fields (never the
 *          input object itself, so no extra properties survive), or null when
 *          the value is not a usable tour.
 */
export function validateTour(x: unknown): Tour | null {
  if (!isRecord(x)) return null;
  const title = str(x.title, MAX_TITLE);
  if (!title) return null;
  if (!Array.isArray(x.steps)) return null;

  const steps: TourStep[] = [];
  for (const raw of x.steps.slice(0, MAX_STEPS)) {
    const step = validateStep(raw);
    if (step) steps.push(step);
  }
  return steps.length ? { title, steps } : null;
}

function validateStep(x: unknown): TourStep | null {
  if (!isRecord(x)) return null;
  const target = str(x.target, 400);
  const title = str(x.title, MAX_TITLE);
  if (!target || !title) return null;

  const step: TourStep = {
    target,
    title,
    narration: str(x.narration, MAX_NARRATION) ?? '',
  };

  const camera = x.camera;
  if (camera === 'isolate' || camera === 'frame' || camera === 'orbit') step.camera = camera;

  if (Array.isArray(x.highlight)) {
    const paths: string[] = [];
    for (const h of x.highlight.slice(0, MAX_HIGHLIGHTS)) {
      const p = str(h, 400);
      if (p) paths.push(p);
    }
    if (paths.length) step.highlight = paths;
  }

  if (Array.isArray(x.artifacts)) {
    const artifacts: TourArtifact[] = [];
    for (const a of x.artifacts.slice(0, MAX_ARTIFACTS)) {
      const artifact = validateArtifact(a);
      if (artifact) artifacts.push(artifact);
    }
    if (artifacts.length) step.artifacts = artifacts;
  }

  return step;
}

function validateArtifact(x: unknown): TourArtifact | null {
  if (!isRecord(x)) return null;
  if (x.type === 'diff') {
    const commit = str(x.commit, 40);
    if (!commit || !HASH_RE.test(commit)) return null;
    const path = str(x.path, 400);
    return path ? { type: 'diff', commit, path } : { type: 'diff', commit };
  }
  if (x.type === 'image') {
    const src = str(x.src, MAX_URL);
    if (!src || !isSafeImageSrc(src)) return null;
    const caption = str(x.caption, MAX_TITLE);
    return caption ? { type: 'image', src, caption } : { type: 'image', src };
  }
  if (x.type === 'link') {
    const href = str(x.href, MAX_URL);
    const label = str(x.label, MAX_TITLE);
    if (!href || !label || !isSafeLinkHref(href)) return null;
    return { type: 'link', href, label };
  }
  return null;
}

/** A non-empty string of at most `max` characters, or null. */
function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
