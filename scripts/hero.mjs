#!/usr/bin/env node
/**
 * hero.mjs — regenerate docs/hero.png: this repository, visualized by itself.
 *
 * Self-contained pipeline (`npm run hero`):
 *   1. analyze THIS repo into viewer/public/data.json (any pre-existing
 *      data.json is stashed and restored, so your analyzed repo survives).
 *   2. boot the vite dev server on a free port.
 *   3. drive headless Chromium at 1920x1080 @2x: drill into a district so file
 *      blocks, module buildings, import arcs and the inspector's code pane are
 *      all on screen, then shoot.
 *
 * Composition is DOM-driven — the scene is probed by sweeping synthetic
 * pointermove events over the canvas and reading what the inspector reports,
 * so nothing depends on hardcoded scene coordinates. If the drill-down fails
 * for any reason we still ship the org-level overview shot.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(REPO, 'viewer/public/data.json');
const OUT = path.join(REPO, 'docs/hero.png');

const VIEWPORT = { width: 1920, height: 1080 };
const SCALE = 2;
/**
 * Preferred drill-down targets, in order; the first plate found on screen wins,
 * and the biggest plate on screen is used if none of them are. `viewer/src` is
 * the shot we want: several file blocks of module buildings, close enough to
 * read, with the import arcs between them in frame.
 */
const TARGETS = ['viewer/src', 'viewer', 'analyzer', 'viewer/src/main.ts'];

main().catch((err) => {
  console.error('\nhero: ' + (err?.stack || err));
  process.exit(1);
});

async function main() {
  const stash = stashData();
  let vite = null;
  try {
    analyze();
    const port = await freePort();
    vite = await startVite(port);
    await shoot(`http://localhost:${port}/`);
  } finally {
    if (vite) await stopVite(vite);
    stash.restore();
  }
  const { size } = fs.statSync(OUT);
  console.log(`hero: wrote ${path.relative(REPO, OUT)} (${(size / 1024).toFixed(0)} KB)`);
}

// ---------------------------------------------------------------------------
// data.json custody
// ---------------------------------------------------------------------------

/** Move any existing data.json aside; `restore()` puts it back (or removes ours). */
function stashData() {
  if (!fs.existsSync(DATA)) return { restore: () => {} };
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hero-')), 'data.json');
  fs.copyFileSync(DATA, tmp);
  console.log(`hero: stashed your data.json -> ${tmp}`);
  return {
    restore() {
      try {
        fs.copyFileSync(tmp, DATA);
        fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
        console.log('hero: restored your data.json');
      } catch (err) {
        console.error(`hero: could not restore data.json, it is still at ${tmp}`, err);
      }
    },
  };
}

function analyze() {
  console.log('hero: analyzing this repository...');
  execFileSync('npx', ['tsx', 'analyzer/analyze.ts', '.', '--no-prs', '--out', 'viewer/public/data.json'], {
    cwd: REPO,
    stdio: 'inherit',
  });
}

// ---------------------------------------------------------------------------
// vite
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startVite(port) {
  console.log(`hero: starting vite on :${port}`);
  // Spawn vite's entry directly rather than through `npx`: the child we hold is
  // then the server itself, so teardown never has to hunt for processes by name
  // (and can never touch a vite server this script did not start).
  const bin = path.join(REPO, 'node_modules/vite/bin/vite.js');
  const proc = spawn(process.execPath, [bin, 'viewer', '--port', String(port), '--strictPort'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Color codes split vite's "Local: http…" ready banner mid-word.
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not become ready in 60s')), 60_000);
    let log = '';
    const onData = (buf) => {
      // Strip ANSI escapes defensively — NO_COLOR should prevent them, but the
      // ready check must not depend on it.
      log += buf.toString().replace(/\x1b\[[0-9;]*m/g, '');
      if (/Local:\s+http/.test(log)) {
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        proc.stderr.off('data', onData);
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`vite exited early (${code})\n${log}`));
    });
  });
}

function stopVite(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', resolve);
    proc.kill('SIGTERM');
    setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 4000).unref?.();
  });
}

// ---------------------------------------------------------------------------
// the shot
// ---------------------------------------------------------------------------

/**
 * Prefer the full Chromium build in new-headless mode: it reaches the real GPU
 * (~110fps here) where the headless shell falls back to SwiftShader (~4fps),
 * which is the difference between a 40-second run and a 20-minute one.
 */
async function launchBrowser() {
  const { chromium } = await import('playwright');
  try {
    return await chromium.launch({ channel: 'chromium', args: ['--hide-scrollbars'] });
  } catch (err) {
    console.warn('hero: no GPU-capable chromium, falling back to software GL (slow):', err.message.split('\n')[0]);
    return chromium.launch({
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
    });
  }
}

async function shoot(url) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
    page.on('pageerror', (e) => {
      // OrbitControls captures the pointer on pointerdown; our synthetic events
      // carry no live pointer id, so that one call throws and is safe to ignore.
      if (e.message.includes('setPointerCapture')) return;
      console.error('hero: page error:', e.message);
    });
    await page.goto(url, { waitUntil: 'load' });

    await page.waitForFunction(() => document.getElementById('boot')?.classList.contains('hide'), null, {
      timeout: 60_000,
    });
    await page.waitForTimeout(2500); // intro flight + first label pass

    // The FPS readout is a dev affordance, not part of the picture. The history
    // timeline is dropped too: this repo's own history is a handful of commits,
    // so its sparkline is one solid block that shows the feature at its worst.
    await page.evaluate(() => {
      document.getElementById('stat-fps')?.closest('div')?.remove();
      const tl = document.getElementById('timeline');
      if (tl) tl.style.display = 'none';
    });

    await setMode(page, 'structure');
    await page.waitForTimeout(600);

    let composed = false;
    try {
      composed = await compose(page);
    } catch (err) {
      console.error('hero: composition failed, falling back to the overview shot:', err.message);
    }
    if (!composed) {
      console.warn('hero: using the org-level overview shot');
      await resetToOverview(page);
    }

    await page.waitForTimeout(2200); // transitions, label cross-fade, code fetch
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    await page.screenshot({ path: OUT });
  } finally {
    await browser.close();
  }
}

/** Drill into a district, pin one of its modules, light up its coupling arcs. */
async function compose(page) {
  const plate = pickPlate(await sweep(page), TARGETS);
  if (!plate) return false;
  console.log(`hero: drilling into ${plate.path}`);

  // Widen the inspector *before* the camera flight: the flight fits the city
  // into the strip the HUD leaves free, and the pane auto-expands as soon as
  // something is selected — pinning it wide first keeps the city clear of it.
  await page.evaluate(() => document.getElementById('sb-width')?.click());
  await page.waitForTimeout(500);

  await aim(page, plate);
  await dispatch(page, 'dblclick', plate);
  await page.waitForTimeout(2400); // camera flight + scope unfold

  // Since the shared-massing change, folder scopes render strata stacks, not
  // module buildings — so drill one level further, into the scope's largest
  // FILE plate, where module buildings live.
  const fileHits = (await sweep(page)).filter((h) => isPlate(h) && /\.(ts|tsx|js|jsx|mjs|md)$/.test(h.name));
  const filePlate = fileHits.length ? centroidPick(byBiggest(fileHits)) : null;
  if (filePlate) {
    console.log(`hero: isolating ${filePlate.path}`);
    await aim(page, filePlate);
    await dispatch(page, 'dblclick', filePlate);
    await page.waitForTimeout(2400);
  }

  // Pin a module in the new scope: the one covering the most screen area, which
  // is both the easiest to hit reliably and the most worth showing source for.
  const building = pickBuilding(await sweep(page));
  if (!building) return true; // we are drilled in at least — still a good shot
  console.log(`hero: selecting ${building.name}`);

  await setToggle(page, 'coupling', true);
  await aim(page, building);
  await dispatch(page, 'pointerdown', building, { button: 0, buttons: 1 });
  await dispatch(page, 'pointerup', building, { button: 0, buttons: 0 });
  await page.waitForTimeout(1500); // selection + dev-API source/diff fetch
  await aim(page, building); // leave the hover box on it — the shot reads as live
  return true;
}

/** Park the picking ray on a point and let the render loop resolve the hover. */
async function aim(page, at) {
  await dispatch(page, 'pointermove', at);
  await page.waitForTimeout(200);
}

/**
 * Synthetic events only — the canvas listens for plain pointer/dblclick events,
 * and driving them directly keeps the browser's own click-counting (which will
 * happily turn a follow-up click into a second drill-down) out of the picture.
 */
function dispatch(page, type, at, init = {}) {
  return page.evaluate(({ type, x, y, init }) => {
    const canvas = document.querySelector('#scene canvas');
    const Ctor = type === 'dblclick' ? MouseEvent : PointerEvent;
    canvas?.dispatchEvent(new Ctor(type, { clientX: x, clientY: y, bubbles: true, pointerType: 'mouse', ...init }));
  }, { type, x: at.x, y: at.y, init });
}

/** Best-effort return to the repo level — the shot must happen either way. */
async function resetToOverview(page) {
  try {
    await page.evaluate(() => {
      const crumbs = document.querySelectorAll('#breadcrumb .crumb');
      if (crumbs.length > 1) crumbs[0].click();
    });
    await page.waitForTimeout(1800);
  } catch (err) {
    console.error('hero: could not reset to the overview:', err.message);
  }
}

/**
 * Sweep synthetic pointermoves across the free canvas area and read back what
 * the inspector reports at each stop — a screen-space sample of the scene that
 * needs no knowledge of the layout.
 *
 * A building reports its *file's* path with its own name, so a sample is a file
 * plate only when its name is the basename of its path; that distinction is
 * what keeps the drill-down one level deep.
 *
 * @returns {Promise<Array<{x:number,y:number,path:string,name:string}>>}
 */
async function sweep(page) {
  // Sweeping costs one frame per sample; bloom + CRT make frames ~5x slower in
  // software GL, so probe with FX off and switch it back on for the shot.
  await setToggle(page, 'fx', false);
  const hits = await page.evaluate(async ({ vw, vh, step }) => {
    const canvas = document.querySelector('#scene canvas');
    if (!canvas) return [];
    // Keep clear of the HUD, measured rather than assumed: control stack (left),
    // inspector (right, its width changes), top bar and help strip.
    const right = document.getElementById('sidebar')?.getBoundingClientRect().left ?? vw - 320;
    const left = document.getElementById('controls')?.getBoundingClientRect().right ?? 240;
    const box = { x0: left + 16, x1: right - 16, y0: 100, y1: vh - 60 };
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const out = [];
    for (let y = box.y0; y <= box.y1; y += step) {
      for (let x = box.x0; x <= box.x1; x += step) {
        canvas.dispatchEvent(
          new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, pointerType: 'mouse' })
        );
        await frame();
        const sec = document.querySelector('#sb-body .sb-sec');
        const name = sec?.querySelector('.sb-name')?.textContent?.trim() || '';
        const p = sec?.querySelector('.sb-path')?.textContent?.trim() || '';
        if (name) out.push({ x, y, name, path: p });
      }
    }
    return out;
  }, { vw: VIEWPORT.width, vh: VIEWPORT.height, step: 44 });
  await setToggle(page, 'fx', true);
  return hits;
}

const isPlate = (h) => h.name === h.path.split('/').pop();

/** Aim at the first of `targets` whose plate is on screen; else the biggest plate. */
function pickPlate(hits, targets) {
  const plates = hits.filter(isPlate);
  if (!plates.length) return null;
  for (const target of targets) {
    const found = plates.filter((h) => h.path === target || h.path.endsWith('/' + target));
    if (found.length) return centroidPick(found);
  }
  return centroidPick(byBiggest(plates));
}

/** Aim at the module building covering the most screen area (never a plate). */
function pickBuilding(hits) {
  const buildings = hits.filter((h) => !isPlate(h));
  return buildings.length ? centroidPick(byBiggest(buildings)) : null;
}

/** All samples belonging to whichever node covered the most screen area. */
function byBiggest(hits) {
  const groups = new Map();
  for (const h of hits) {
    const key = h.path + '#' + h.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length)[0];
}

/** The sampled point nearest the group's centroid — a stable, central aim. */
function centroidPick(group) {
  const cx = group.reduce((s, h) => s + h.x, 0) / group.length;
  const cy = group.reduce((s, h) => s + h.y, 0) / group.length;
  return group.reduce((best, h) =>
    Math.hypot(h.x - cx, h.y - cy) < Math.hypot(best.x - cx, best.y - cy) ? h : best
  );
}

const setMode = (page, mode) =>
  page.evaluate((m) => document.querySelector(`#modes button[data-mode="${m}"]`)?.click(), mode);

const setToggle = (page, key, on) =>
  page.evaluate(({ k, on }) => {
    const btn = document.querySelector(`#toggles button[data-toggle="${k}"]`);
    if (btn && btn.classList.contains('active') !== on) btn.click();
  }, { k: key, on });
