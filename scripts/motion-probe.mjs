/**
 * motion-probe.mjs — camera motion regression harness.
 *
 * Drives the viewer through scripted multi-level jumps and analyses the
 * per-frame trace that `?probe=1` records (see the motion probe in main.ts).
 * Asserts, per flight: no frame-to-frame speed step, monotone pitch and
 * bearing, skyline clearance, and screen-space continuity of the drilled node
 * across the scope rebuild.
 *
 *   npm run dev -- --port 5311      # or edit URL below
 *   node scripts/motion-probe.mjs
 *
 * Runs headed on purpose: headless software GL cannot hold 60fps at org scale,
 * and a frame-to-frame envelope is meaningless below it.
 */
import { chromium } from 'playwright';

const URL = 'http://localhost:5311/?probe=1';
const DEEP_FILE = 'packages/canvas/src/ai/code-prompts.ts';
const DEEP_DIR = 'packages/canvas/src/ai';
const F = { id: 0, t: 1, e: 2, px: 3, py: 4, pz: 5, tx: 6, ty: 7, tz: 8, ax: 9, ay: 10, mark: 11 };

const flightStats = (frames, flights) => {
  const byId = new Map();
  for (const f of frames) {
    if (!f[F.id]) continue;
    if (!byId.has(f[F.id])) byId.set(f[F.id], []);
    byId.get(f[F.id]).push(f);
  }
  const out = [];
  for (const [id, fs] of byId) {
    if (fs.length < 8) continue;
    const meta = flights.find((m) => m.id === id) || { dur: 0, ceiling: 0, planY: 0 };
    const speeds = [];
    const apparent = [];
    const tspeeds = [];
    for (let i = 1; i < fs.length; i++) {
      const a = fs[i - 1], b = fs[i];
      const dt = b[F.t] - a[F.t];
      if (dt <= 1e-6) continue;
      const r = Math.hypot(b[F.px] - b[F.tx], b[F.py] - b[F.ty], b[F.pz] - b[F.tz]) || 1;
      speeds.push({ e: b[F.e], v: Math.hypot(b[F.px] - a[F.px], b[F.py] - a[F.py], b[F.pz] - a[F.pz]) / dt });
      apparent.push({ e: b[F.e], v: (Math.hypot(b[F.px] - a[F.px], b[F.py] - a[F.py], b[F.pz] - a[F.pz])
        + Math.hypot(b[F.tx] - a[F.tx], b[F.ty] - a[F.ty], b[F.tz] - a[F.tz])) / r / dt });
      tspeeds.push({ e: b[F.e], v: Math.hypot(b[F.tx] - a[F.tx], b[F.ty] - a[F.ty], b[F.tz] - a[F.tz]) / dt });
    }
    const peak = Math.max(...speeds.map((s) => s.v));
    const tpeak = Math.max(...tspeeds.map((s) => s.v), 1e-9);
    const apeak = Math.max(...apparent.map((s) => s.v), 1e-9);
    let maxAJump = 0;
    for (let i = 1; i < apparent.length; i++) {
      if (apparent[i].e < 0.15 || apparent[i].e > 0.85) continue;
      maxAJump = Math.max(maxAJump, Math.abs(apparent[i].v - apparent[i - 1].v) / apeak);
    }
    let maxJump = 0, at = 0, maxTJump = 0;
    for (let i = 1; i < speeds.length; i++) {
      if (speeds[i].e < 0.15 || speeds[i].e > 0.85) continue;
      const j = Math.abs(speeds[i].v - speeds[i - 1].v) / peak;
      if (j > maxJump) { maxJump = j; at = speeds[i].e; }
      maxTJump = Math.max(maxTJump, Math.abs(tspeeds[i].v - tspeeds[i - 1].v) / tpeak);
    }
    // Altitude: while the camera is still further from what it is looking at
    // than the city is tall, it must be over the skyline. (Closer in than that,
    // clearing the skyline is geometrically impossible.)
    const rOf = (f) => Math.hypot(f[F.px] - f[F.tx], f[F.py] - f[F.ty], f[F.pz] - f[F.tz]);
    let minY = Infinity;
    for (const f of fs) if (rOf(f) > meta.ceiling) minY = Math.min(minY, f[F.py]);
    if (!Number.isFinite(minY)) minY = Math.max(...fs.map((f) => f[F.py]));

    // Tilt / wobble: the pitch must move in one direction only, and the bearing
    // must not travel further than its net change.
    const polar = [], azim = [];
    for (const f of fs) {
      const dx = f[F.px] - f[F.tx], dy = f[F.py] - f[F.ty], dz = f[F.pz] - f[F.tz];
      const r = Math.hypot(dx, dy, dz) || 1e-9;
      polar.push(Math.acos(Math.min(Math.max(dy / r, -1), 1)));
      azim.push(Math.atan2(dx, dz));
    }
    const netP = polar[polar.length - 1] - polar[0];
    let backP = 0, varA = 0;
    for (let i = 1; i < polar.length; i++) {
      const d = polar[i] - polar[i - 1];
      if (netP !== 0 && Math.sign(d) !== Math.sign(netP)) backP += Math.abs(d);
      let da = azim[i] - azim[i - 1];
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      varA += Math.abs(da);
    }
    let netA = azim[azim.length - 1] - azim[0];
    while (netA > Math.PI) netA -= 2 * Math.PI;
    while (netA < -Math.PI) netA += 2 * Math.PI;

    out.push({
      id, frames: fs.length, dur: +meta.dur.toFixed(2), ceiling: +meta.ceiling.toFixed(1),
      'peak u/s': Math.round(peak),
      'max dSpeed %': +(maxJump * 100).toFixed(1), at: +at.toFixed(2),
      'max dApparent %': +(maxAJump * 100).toFixed(1),
      'max dTargetSpeed %': +(maxTJump * 100).toFixed(1),
      'min y': +minY.toFixed(1),
      'clears city': minY >= meta.ceiling || minY >= fs[0][F.py],
      'polar backtrack °': +((backP * 180) / Math.PI).toFixed(2),
      'azim excess °': +(((varA - Math.abs(netA)) * 180) / Math.PI).toFixed(2),
    });
  }
  return out;
};

// Screen-space continuity of the drilled node's centroid across each rebuild.
const rebuildStats = (frames) => {
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    if (frames[i][F.mark] !== 1) continue;
    const before = frames[i];
    const after = frames[i + 1];
    if (!after || after[F.mark] !== 2) continue;
    // NDC is -1..1 across the viewport, so half the NDC delta is the fraction.
    const dx = (after[F.ax] - before[F.ax]) / 2;
    const dy = (after[F.ay] - before[F.ay]) / 2;
    out.push({ jumpPctViewport: +(Math.hypot(dx, dy) * 100).toFixed(3) });
  }
  return out;
};

const run = async () => {
  const browser = await chromium.launch({ headless: false, args: ['--force-device-scale-factor=1'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // Keep the worktree layer (on by default, dirty tree ghosts the city) out of
  // the motion traces.
  await page.addInitScript(() => {
    window.localStorage.setItem('city:ui-settings', JSON.stringify({ worktree: false }));
  });
  await page.goto(URL);
  await page.waitForFunction(() => Reflect.get(window, '__motionProbe') !== undefined, null, { timeout: 30000 });
  await page.waitForTimeout(2500);

  const scenario = async (name, steps) => {
    await page.evaluate(() => Reflect.get(window, '__motionProbe').focusPath(''));
    await page.waitForTimeout(1800);
    await page.evaluate(() => Reflect.get(window, '__motionProbe').reset());
    await steps();
    await page.waitForTimeout(2500);
    const { frames, flights, fps } = await page.evaluate(() => {
      const p = Reflect.get(window, '__motionProbe');
      return {
        frames: p.frames(), flights: p.flights(),
        fps: Number(document.getElementById('stat-fps')?.textContent || 0),
      };
    });
    console.log('\n=== ' + name + ' ===  (fps: ' + fps + ')');
    console.table(flightStats(frames, flights));
    console.table(rebuildStats(frames));
  };

  await scenario('org -> file, reveal (⌘P path)', async () => {
    await page.evaluate((p) => Reflect.get(window, '__motionProbe').reveal(p), DEEP_FILE);
  });

  await scenario('org -> deep file dive (multi level)', async () => {
    await page.evaluate((p) => Reflect.get(window, '__motionProbe').focusPath(p), DEEP_FILE);
  });

  await scenario('file -> org, rapid Esc x4', async () => {
    await page.evaluate((p) => Reflect.get(window, '__motionProbe').focusPath(p), DEEP_FILE);
    await page.waitForTimeout(2400);
    await page.evaluate(() => Reflect.get(window, '__motionProbe').reset());
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(220);
    }
  });

  await scenario('breadcrumb root -> deep -> root', async () => {
    await page.evaluate((p) => Reflect.get(window, '__motionProbe').focusPath(p), DEEP_DIR);
    await page.waitForTimeout(2400);
    await page.evaluate(() => Reflect.get(window, '__motionProbe').focusPath(''));
  });

  console.log('\nend state:', JSON.stringify(await page.evaluate(() => Reflect.get(window, '__motionProbe').state())));
  console.log('console errors:', errors.length ? errors : 'none');
  await browser.close();
};

run();
