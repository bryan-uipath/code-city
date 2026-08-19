/**
 * terrace.ts — district signage painted on the terrace side walls.
 *
 * The top one or two folder tiers do not get floating label pills: their names
 * live on the vertical face of their own terrace, like the name cut into the
 * plinth of a building. One canvas-texture plane per folder, parked on whichever
 * of the four side faces currently points at the camera — re-picked on the same
 * lazy cadence as the labeler, never per frame.
 */
import * as THREE from 'three';
import { plateThickness, plateTop } from './layout.js';
import type { VNode } from './vtree.js';

/** Seconds between face re-picks. */
const PICK_INTERVAL = 0.2;
const FADE_RATE = 4.5;
/** Below this on-screen wall height the sign is unreadable clutter. */
const MIN_PX = 4;
const FULL_PX = 9;

export interface TerraceSigns {
  group: THREE.Group;
  /** Replace the signed folder set (called on every scope rebuild). */
  setNodes(nodes: VNode[]): void;
  update(dt: number): void;
  /** Visible sign meshes, for the raycaster. */
  pickables(): THREE.Object3D[];
  dispose(): void;
}

interface Sign {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  node: VNode;
  /** Half-extents of the plate footprint plus its wall geometry. */
  cx: number;
  cz: number;
  hw: number;
  hh: number;
  y: number;
  wall: number;
  aspect: number;
  target: number;
}

/** Outward normal (XZ) and the plane yaw that points a sign along it. */
interface Face {
  nx: number;
  nz: number;
  yaw: number;
}

const FACES: readonly Face[] = [
  { nx: 0, nz: 1, yaw: 0 },
  { nx: 0, nz: -1, yaw: Math.PI },
  { nx: 1, nz: 0, yaw: Math.PI / 2 },
  { nx: -1, nz: 0, yaw: -Math.PI / 2 },
];

const FALLBACK_FACE: Face = { nx: 0, nz: 1, yaw: 0 };

export function createTerraceSigns(camera: THREE.PerspectiveCamera): TerraceSigns {
  const group = new THREE.Group();
  group.name = 'terraceSigns';

  let signs: Sign[] = [];
  let acc = PICK_INTERVAL;
  const visible: THREE.Object3D[] = [];
  const _v = new THREE.Vector3();

  return { group, setNodes, update, pickables, dispose };

  function setNodes(nodes: VNode[]): void {
    dispose();
    for (const node of nodes) {
      const sign = makeSign(node);
      if (sign) {
        signs.push(sign);
        group.add(sign.mesh);
      }
    }
    acc = PICK_INTERVAL;
  }

  function makeSign(node: VNode): Sign | null {
    const r = node.rect;
    if (!r) return null;
    const tier = node.tier ?? node.depth ?? 0;
    const wall = plateThickness(tier, node.type === 'file');
    if (wall < 1.4) return null;

    const tex = signTexture(node.name, tier);
    const material = new THREE.MeshBasicMaterial({
      map: tex.texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(PLANE, material);
    mesh.visible = false;
    mesh.renderOrder = 18;
    mesh.frustumCulled = false;
    mesh.userData.pickType = 'terrace';
    mesh.userData.node = node;
    mesh.userData.dispose = () => {
      tex.texture.dispose();
      material.dispose();
    };
    return {
      mesh,
      material,
      node,
      cx: r.x + r.w / 2,
      cz: r.z + r.h / 2,
      hw: r.w / 2,
      hh: r.h / 2,
      y: (node.top ?? plateTop(tier, node.type === 'file')) - wall / 2,
      wall,
      aspect: tex.aspect,
      target: 0,
    };
  }

  function update(dt: number): void {
    acc += dt;
    if (acc >= PICK_INTERVAL) {
      acc = 0;
      place();
    }
    const k = Math.min(dt * FADE_RATE, 1);
    visible.length = 0;
    for (const s of signs) {
      const o = s.material.opacity + (s.target - s.material.opacity) * k;
      s.material.opacity = o;
      s.mesh.visible = o > 0.03;
      if (s.mesh.visible) visible.push(s.mesh);
    }
  }

  /** Re-seat every sign on the face that currently points at the camera. */
  function place(): void {
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    const vh = window.innerHeight;
    for (const s of signs) {
      _v.set(camera.position.x - s.cx, 0, camera.position.z - s.cz);
      let best = FALLBACK_FACE;
      let bestDot = -Infinity;
      for (const f of FACES) {
        const d = f.nx * _v.x + f.nz * _v.z;
        if (d > bestDot) {
          bestDot = d;
          best = f;
        }
      }

      const span = best.nz !== 0 ? s.hw * 2 : s.hh * 2;
      // Text as tall as the wall allows, shrunk further when the name is longer
      // than the face it has to sit on.
      let h = s.wall * 0.82;
      let w = h * s.aspect;
      const maxW = span * 0.9;
      if (w > maxW) {
        const k = maxW / w;
        w = maxW;
        h *= k;
      }
      const out = 0.06;
      s.mesh.position.set(
        s.cx + best.nx * (s.hw + out),
        s.y,
        s.cz + best.nz * (s.hh + out)
      );
      s.mesh.rotation.set(0, best.yaw, 0);
      s.mesh.scale.set(w, h, 1);

      const dist = camera.position.distanceTo(s.mesh.position);
      const px = dist > 1 ? (h / (2 * dist * tanHalf)) * vh : 0;
      _v.copy(s.mesh.position).project(camera);
      const onScreen = _v.z < 1 && _v.x > -1.4 && _v.x < 1.4 && _v.y > -1.4 && _v.y < 1.4;
      s.target = onScreen
        ? Math.min(Math.max((px - MIN_PX) / (FULL_PX - MIN_PX), 0), 1)
        : 0;
    }
  }

  function pickables(): THREE.Object3D[] {
    return visible;
  }

  function dispose(): void {
    for (const s of signs) {
      group.remove(s.mesh);
      const fn = s.mesh.userData.dispose;
      if (typeof fn === 'function') fn();
    }
    signs = [];
    visible.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Texture
// ---------------------------------------------------------------------------

const PLANE = new THREE.PlaneGeometry(1, 1);
PLANE.userData.shared = true;

const SIGN_FONT = '700 64px "SFMono-Regular", "JetBrains Mono", Menlo, monospace';
/** Tier 0/1 is the loudest signage in the city; deeper tiers step back. */
const SIGN_COLOR = ['#e8fbff', '#e8fbff', '#9fd9ee'] as const;

/** Uppercase place-name plate. Returns the texture and its width/height ratio. */
function signTexture(name: string, tier: number): { texture: THREE.CanvasTexture; aspect: number } {
  const text = String(name || '').toUpperCase();
  const color = SIGN_COLOR[Math.min(tier, SIGN_COLOR.length - 1)] ?? '#9fd9ee';

  const probe = ctx2d(document.createElement('canvas'));
  probe.font = SIGN_FONT;
  const spacing = 10;
  const textW = Math.ceil(probe.measureText(text).width) + spacing * Math.max(text.length - 1, 0);

  const canvas = document.createElement('canvas');
  const h = 128;
  canvas.width = Math.max(textW + 72, 16);
  canvas.height = h;
  const ctx = ctx2d(canvas);
  ctx.font = SIGN_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  // A faint engraved band so the letters keep contrast over any plate tint.
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(6, 14, 26, 0.0)');
  grad.addColorStop(0.5, 'rgba(6, 14, 26, 0.55)');
  grad.addColorStop(1, 'rgba(6, 14, 26, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, h);

  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.fillStyle = color;
  let x = 36;
  for (const ch of text) {
    ctx.fillText(ch, x, h / 2);
    x += ctx.measureText(ch).width + spacing;
  }
  ctx.shadowBlur = 0;
  x = 36;
  for (const ch of text) {
    ctx.fillText(ch, x, h / 2);
    x += ctx.measureText(ch).width + spacing;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return { texture, aspect: canvas.width / canvas.height };
}

function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  return ctx;
}
