/**
 * labels.ts — map-style dynamic labeling.
 *
 * Instead of a fixed static/dynamic split, every ~150ms the labeler picks the
 * candidates whose projected footprint currently sits in a readable band and
 * that do not collide on screen — so districts give way to files give way to
 * buildings as the camera closes in, like a map engine. Sprites are cached and
 * cross-faded; nothing is allocated per frame.
 *
 * Candidates are plain records supplied by main.ts.
 */
import * as THREE from 'three';
import { makeLabelSprite } from './city.js';

const PICK_INTERVAL = 0.15;   // seconds between re-selections
const MAX_LABELS = 50;
const MIN_PX = 40;            // smaller than this is unreadable clutter
const MAX_VIEW_FRACTION = 0.45; // bigger than this and you are "inside" it
const FADE_RATE = 5.5;
const CACHE_LIMIT = 180;

export type LabelTier = 'folder' | 'file' | 'module';

export interface LabelCandidate {
  key: string;
  text: string;
  tier: LabelTier;
  pos: THREE.Vector3;
  size: number;
}

export interface Labeler {
  group: THREE.Group;
  setCandidates(list: LabelCandidate[]): void;
  update(dt: number): void;
  dispose(): void;
}

const TIER_PX: Record<LabelTier, number> = { folder: 26, file: 18, module: 14 };
const TIER_COLOR: Record<LabelTier, string> = { folder: '#bdf3ff', file: '#7fd8ea', module: '#9ae9ff' };

interface CacheEntry {
  sprite: THREE.Sprite;
  tier: LabelTier;
  text: string;
  used?: number;
}

export function createLabeler(scene: THREE.Scene, camera: THREE.PerspectiveCamera): Labeler {
  const group = new THREE.Group();
  group.name = 'labels';
  scene.add(group);

  const cache = new Map<string, CacheEntry>();
  const active = new Set<string>();    // keys currently chosen
  let candidates: LabelCandidate[] = [];
  let acc = PICK_INTERVAL;

  const _v = new THREE.Vector3();
  const boxes: number[] = [];          // reused screen-space rejection boxes

  return { group, setCandidates, update, dispose };

  /** Replace the candidate set (called on focus/selection rebuilds). */
  function setCandidates(list: LabelCandidate[]): void {
    candidates = list || [];
    acc = PICK_INTERVAL; // re-pick on the next update
  }

  function update(dt: number): void {
    acc += dt;
    if (acc >= PICK_INTERVAL) {
      acc = 0;
      pick();
    }
    fade(dt);
  }

  // --- selection -----------------------------------------------------------

  function pick(): void {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    const scored: Array<{ c: LabelCandidate; px: number; sx: number; sy: number; dist: number }> = [];

    for (const c of candidates) {
      const dist = camera.position.distanceTo(c.pos);
      if (dist < 1) continue;
      const px = (c.size / (2 * dist * tanHalf)) * vh;
      if (px < MIN_PX || px > vh * MAX_VIEW_FRACTION) continue;

      _v.copy(c.pos).project(camera);
      if (_v.z > 1 || _v.x < -1.15 || _v.x > 1.15 || _v.y < -1.15 || _v.y > 1.15) continue;
      scored.push({ c, px, sx: (_v.x * 0.5 + 0.5) * vw, sy: (-_v.y * 0.5 + 0.5) * vh, dist });
    }

    scored.sort((a, b) => b.px - a.px);

    boxes.length = 0;
    const chosen = new Set<string>();
    for (const s of scored) {
      if (chosen.size >= MAX_LABELS) break;
      const fs = TIER_PX[s.c.tier] || 16;
      const w = s.c.text.length * fs * 0.62 + 8;
      const h = fs * 1.5;
      const x0 = s.sx - w / 2;
      const y0 = s.sy - h / 2;
      if (overlaps(x0, y0, w, h)) continue;
      boxes.push(x0, y0, w, h);
      chosen.add(s.c.key);
      show(s.c, s.dist, tanHalf, vh);
    }

    for (const key of active) if (!chosen.has(key)) hide(key);
    active.clear();
    for (const key of chosen) active.add(key);
    evict();
  }

  function overlaps(x: number, y: number, w: number, h: number): boolean {
    for (let i = 0; i < boxes.length; i += 4) {
      const bx = boxes[i] ?? 0;
      const by = boxes[i + 1] ?? 0;
      const bw = boxes[i + 2] ?? 0;
      const bh = boxes[i + 3] ?? 0;
      if (x < bx + bw && x + w > bx && y < by + bh && y + h > by) {
        return true;
      }
    }
    return false;
  }

  // --- sprites -------------------------------------------------------------

  function show(c: LabelCandidate, dist: number, tanHalf: number, vh: number): void {
    let entry = cache.get(c.key);
    if (!entry || entry.text !== c.text) {
      if (entry) destroy(entry);
      const sprite = makeLabelSprite(c.text, { color: TIER_COLOR[c.tier] || '#bdf3ff', worldHeight: 1 });
      sprite.userData.aspect = sprite.scale.x / sprite.scale.y;
      sprite.material.opacity = 0;
      sprite.visible = false;
      group.add(sprite);
      entry = { sprite, tier: c.tier, text: c.text };
      cache.set(c.key, entry);
    }
    // Constant apparent size: convert the tier's target pixel height to world units.
    const worldH = ((TIER_PX[c.tier] || 16) / vh) * 2 * dist * tanHalf;
    entry.sprite.scale.set(worldH * entry.sprite.userData.aspect, worldH, 1);
    entry.sprite.position.copy(c.pos);
    entry.sprite.userData.target = 1;
    entry.sprite.visible = true;
    entry.used = performance.now();
  }

  function hide(key: string): void {
    const entry = cache.get(key);
    if (entry) entry.sprite.userData.target = 0;
  }

  function fade(dt: number): void {
    const k = Math.min(dt * FADE_RATE, 1);
    for (const entry of cache.values()) {
      const s = entry.sprite;
      const target = s.userData.target || 0;
      const o = s.material.opacity + (target - s.material.opacity) * k;
      s.material.opacity = o;
      s.visible = o > 0.02;
    }
  }

  function evict(): void {
    if (cache.size <= CACHE_LIMIT) return;
    const stale = [...cache.entries()]
      .filter(([key, e]) => !active.has(key) && e.sprite.material.opacity < 0.03)
      .sort((a, b) => (a[1].used || 0) - (b[1].used || 0));
    for (const [key, entry] of stale) {
      if (cache.size <= CACHE_LIMIT) break;
      destroy(entry);
      cache.delete(key);
    }
  }

  function destroy(entry: CacheEntry): void {
    group.remove(entry.sprite);
    const dispose = entry.sprite.userData.dispose;
    if (typeof dispose === 'function') dispose();
  }

  function dispose(): void {
    for (const entry of cache.values()) destroy(entry);
    cache.clear();
    active.clear();
  }
}
