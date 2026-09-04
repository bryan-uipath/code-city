/**
 * hologram.ts — floating code readouts. A module's source is drawn to a canvas
 * and stood up in the world above its column: dark glass, cyan monospace,
 * scanlines, turned to face the camera every frame (`facePanel`).
 */
import * as THREE from 'three';

export const SNIPPET_LINES = 14;
const MAX_COLS = 88;
const PX_W = 1024;
const LINE_PX = 26;
const HEAD_PX = 54;
const PAD_PX = 14;
const GUTTER_PX = 78;
const MONO = '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace';

export interface CodePanel {
  mesh: THREE.Mesh;
  /** Canvas height over width: world height = world width × aspect. */
  aspect: number;
}

/**
 * @param header  `kind name`
 * @param sub     right-aligned span note (`L12–48`)
 * @param lines   source lines, or null when the host cannot serve source
 * @param first   line number of `lines[0]`
 * @param more    lines past the snippet, for the "+N lines" tail
 */
export function makeCodePanel(header: string, sub: string, lines: string[] | null, first: number, more = 0): CodePanel {
  const rows = lines ? Math.min(lines.length, SNIPPET_LINES) : 0;
  const canvas = document.createElement('canvas');
  canvas.width = PX_W;
  const tail = rows > 0 && more > 0;
  canvas.height = HEAD_PX + (rows ? PAD_PX * 2 + rows * LINE_PX + (tail ? LINE_PX : 0) : 0);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const W = canvas.width;
  const H = canvas.height;

  ctx.fillStyle = 'rgba(4, 10, 24, 0.88)';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(34, 211, 238, 0.10)';
  ctx.fillRect(0, 0, W, HEAD_PX);
  ctx.textBaseline = 'middle';
  ctx.font = `bold 22px ${MONO}`;
  ctx.fillStyle = '#eafcff';
  ctx.fillText(clip(header, 60), 20, HEAD_PX / 2);
  ctx.font = `18px ${MONO}`;
  ctx.fillStyle = 'rgba(168, 244, 255, 0.75)';
  ctx.textAlign = 'right';
  ctx.fillText(sub, W - 20, HEAD_PX / 2);

  ctx.font = `19px ${MONO}`;
  for (let i = 0; i < rows; i++) {
    const y = HEAD_PX + PAD_PX + i * LINE_PX + LINE_PX / 2;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(120, 160, 190, 0.55)';
    ctx.fillText(String(first + i), GUTTER_PX - 16, y);
    ctx.textAlign = 'left';
    const text = clip((lines?.[i] ?? '').replace(/\t/g, '  '), MAX_COLS);
    ctx.fillStyle = tone(text);
    ctx.fillText(text, GUTTER_PX, y);
  }
  if (tail) {
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(120, 160, 190, 0.6)';
    ctx.fillText(`… +${more} lines`, GUTTER_PX, HEAD_PX + PAD_PX + rows * LINE_PX + LINE_PX / 2);
  }
  // Scanlines, then the frame on top.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
  for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.75)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: false, // a readout is drawn over the city, never inside it
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.renderOrder = 18;
  mesh.frustumCulled = false;
  return { mesh, aspect: H / W };
}

/** Screen-align the panel: its text stays upright and square to the viewer. */
export function facePanel(mesh: THREE.Object3D, camera: THREE.Camera): void {
  mesh.quaternion.copy(camera.quaternion);
}

/** Comments recede; code reads in the hologram's ink. */
function tone(text: string): string {
  const t = text.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? 'rgba(140, 170, 200, 0.7)' : '#c8f1ff';
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
