/**
 * hologram.ts — floating code readouts. A module's interface and source are
 * drawn to canvases and projected straight up from its building: a fixed
 * header (kind, name, signature, span), a body that scrolls through the whole
 * module so its length is felt, a scrollbar that shows how much there is, a
 * light cone from the roof. Screen-aligned every frame (`facePanel`).
 */
import * as THREE from 'three';

const PX_W = 1400;
const LINE_PX = 34;
const MAX_COLS = 84;
const GUTTER_PX = 92;
/** Rows drawn into the body texture; the rest is a tail note (GPU texture cap). */
const MAX_ROWS = 220;
const MIN_VIEW = 5;
const MAX_VIEW = 14;
const HOLD_S = 1.8;
const ROWS_PER_S = 2.2;
const MONO = '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace';
const INK = '#d6f6ff';
const DIM = 'rgba(140, 170, 200, 0.7)';

export interface CodeHeader {
  /** `kind name` */
  title: string;
  /** The interface as written: params + return type, heritage, alias. */
  sig: string;
  /** `L75–261 · 186 lines` */
  note: string;
}

export interface CodePanel {
  /** Header + body + scrollbar, screen-aligned as one. */
  group: THREE.Group;
  /** The projection cone from the roof up to the card. */
  beam: THREE.Mesh;
  /** Total height per unit width (header + body). */
  aspect: number;
  /** Lay the parts out for a world width; returns the total height. */
  layout(w: number): number;
  /** Advance the auto-scroll. */
  tick(dt: number): void;
}

export function makeCodePanel(head: CodeHeader, lines: string[] | null, first: number, total: number): CodePanel {
  const header = drawHeader(head);
  const rows = lines ? Math.min(lines.length, MAX_ROWS) : 0;
  const view = rows ? Math.min(Math.max(rows, MIN_VIEW), MAX_VIEW) : 0;
  const body = rows ? drawBody(lines ?? [], rows, first, total) : null;
  // The tail note is a drawn row too: the window must scroll over it, not squeeze it.
  const drawn = body ? body.drawn : rows;

  const group = new THREE.Group();
  const headMesh = card(header.tex);
  group.add(headMesh);
  const bodyMesh = body ? card(body.tex) : null;
  const track = body ? bar(0.22) : null;
  const thumb = body ? bar(0.75) : null;
  if (bodyMesh && track && thumb) group.add(bodyMesh, track, thumb);
  // The body texture shows `view` of `drawn` rows; scrolling moves the window
  // (canvas textures upload unflipped here: v = 0 is the first row).
  if (body) {
    body.tex.flipY = false;
    body.tex.repeat.set(1, view / drawn);
    body.tex.offset.set(0, 0);
  }

  const headAspect = header.h / PX_W;
  const bodyAspect = (view * LINE_PX) / PX_W;
  const aspect = headAspect + bodyAspect;
  const scrollable = drawn > view;
  let t = 0;
  let frac = 0;

  return {
    group,
    beam: makeBeam(),
    aspect,
    layout(w) {
      const hh = w * headAspect;
      const bh = w * bodyAspect;
      headMesh.scale.set(w, hh, 1);
      headMesh.position.set(0, bh / 2 + hh / 2, 0);
      if (bodyMesh && track && thumb) {
        bodyMesh.scale.set(w, bh, 1);
        const x = w / 2 - w * 0.008;
        track.scale.set(w * 0.006, bh, 1);
        track.position.set(x, 0, 0.001);
        const th = Math.max(bh * (view / drawn), bh * 0.06);
        thumb.scale.set(w * 0.006, th, 1);
        thumb.position.set(x, bh / 2 - th / 2 - frac * (bh - th), 0.002);
      }
      return hh + bh;
    },
    tick(dt) {
      if (!body || !scrollable) return;
      // Hold at the top, roll to the bottom at a reading pace, hold, start over.
      const span = drawn - view;
      const roll = span / ROWS_PER_S;
      t = (t + dt) % (HOLD_S + roll + HOLD_S);
      frac = Math.min(Math.max((t - HOLD_S) / roll, 0), 1);
      body.tex.offset.y = (1 - view / drawn) * frac;
    },
  };
}

function drawHeader(head: CodeHeader): { tex: THREE.CanvasTexture; h: number } {
  const canvas = document.createElement('canvas');
  const ctx = ctx2d(canvas);
  const sig = wrap(head.sig.replace(/\s+/g, ' ').trim(), 78).slice(0, 3);
  const H = 22 + 44 + (sig.length ? sig.length * 32 + 8 : 0) + 18;
  canvas.width = PX_W;
  canvas.height = H;
  glass(ctx, PX_W, H, 0.62);
  ctx.fillStyle = 'rgba(34, 211, 238, 0.14)';
  ctx.fillRect(0, 0, PX_W, H);
  ctx.textBaseline = 'middle';
  ctx.font = `bold 34px ${MONO}`;
  ctx.fillStyle = '#f2fdff';
  ctx.fillText(clip(head.title, 44), 24, 22 + 22);
  ctx.font = `22px ${MONO}`;
  ctx.fillStyle = 'rgba(168, 244, 255, 0.8)';
  ctx.textAlign = 'right';
  ctx.fillText(head.note, PX_W - 24, 22 + 22);
  ctx.textAlign = 'left';
  ctx.font = `26px ${MONO}`;
  ctx.fillStyle = '#7fe9ff';
  sig.forEach((line, i) => ctx.fillText(line, 24, 22 + 44 + 8 + i * 32 + 16));
  scanlines(ctx, PX_W, H);
  frame(ctx, PX_W, H);
  return { tex: texture(canvas), h: H };
}

function drawBody(lines: string[], rows: number, first: number, total: number): { tex: THREE.CanvasTexture; drawn: number } {
  const canvas = document.createElement('canvas');
  const ctx = ctx2d(canvas);
  const tail = total > rows;
  const H = (rows + (tail ? 1 : 0)) * LINE_PX;
  canvas.width = PX_W;
  canvas.height = H;
  // Drawn upside down so an unflipped upload reads top-to-bottom in v.
  ctx.translate(0, H);
  ctx.scale(1, -1);
  glass(ctx, PX_W, H, 0.56);
  ctx.textBaseline = 'middle';
  ctx.font = `25px ${MONO}`;
  for (let i = 0; i < rows; i++) {
    const y = i * LINE_PX + LINE_PX / 2;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(120, 160, 190, 0.55)';
    ctx.fillText(String(first + i), GUTTER_PX - 18, y);
    ctx.textAlign = 'left';
    const text = clip((lines[i] ?? '').replace(/\t/g, '  '), MAX_COLS);
    ctx.fillStyle = tone(text);
    ctx.fillText(text, GUTTER_PX, y);
  }
  if (tail) {
    ctx.textAlign = 'left';
    ctx.fillStyle = DIM;
    ctx.fillText(`… ${total - rows} more lines`, GUTTER_PX, rows * LINE_PX + LINE_PX / 2);
  }
  scanlines(ctx, PX_W, H);
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 0, PX_W - 2, H);
  return { tex: texture(canvas), drawn: rows + (tail ? 1 : 0) };
}

// --- pieces ----------------------------------------------------------------

function card(tex: THREE.Texture): THREE.Mesh {
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
  return mesh;
}

/** A flat cyan bar: scrollbar track or thumb. */
function bar(opacity: number): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    color: 0x22d3ee,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.renderOrder = 19;
  mesh.frustumCulled = false;
  return mesh;
}

/** Unit light cone, base on the roof (y=0) widening to the card (y=1); scaled per frame. */
function makeBeam(): THREE.Mesh {
  const geom = new THREE.CylinderGeometry(1, 0.06, 1, 24, 1, true);
  geom.translate(0, 0.5, 0);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x22d3ee,
    transparent: true,
    opacity: 0.1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = 17;
  mesh.frustumCulled = false;
  return mesh;
}

/** Screen-align the panel: its text stays upright and square to the viewer. */
export function facePanel(obj: THREE.Object3D, camera: THREE.Camera): void {
  obj.quaternion.copy(camera.quaternion);
}

// --- canvas helpers ---------------------------------------------------------

function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  return ctx;
}

/** See-through glass, a little brighter toward the bottom where the beam lands. */
function glass(ctx: CanvasRenderingContext2D, w: number, h: number, alpha: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `rgba(6, 14, 30, ${alpha})`);
  g.addColorStop(1, `rgba(10, 40, 60, ${alpha + 0.1})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function scanlines(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.14)';
  for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
}

function frame(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.8)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w - 2, h - 2);
}

function texture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** Comments recede; code reads in the hologram's ink. */
function tone(text: string): string {
  const t = text.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? DIM : INK;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Greedy word wrap at `max` columns; a single overlong token is cut. */
function wrap(s: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of s.split(' ')) {
    if (!word) continue;
    if (cur && cur.length + 1 + word.length > max) { out.push(cur); cur = ''; }
    cur = cur ? `${cur} ${word}` : word;
    while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur) out.push(cur);
  return out;
}
