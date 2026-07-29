#!/usr/bin/env node
/**
 * Deterministic screenshot harness for the game.
 *
 * Boots vite (if not already up), opens the page in GPU-backed Chromium,
 * waits for `window.__READY__`, optionally runs a named "shot" defined in
 * src/dev/shots.js, then writes a PNG.
 *
 * Usage:
 *   node tools/capture.mjs --shot=hero --out=shots/hero.png
 *   node tools/capture.mjs --shot=hero --out=shots/hero.png --w=2560 --h=1440
 *   node tools/capture.mjs --list
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const PORT = Number(args.port ?? 5173);
const W = Number(args.w ?? 1920);
const H = Number(args.h ?? 1080);
const SHOT = args.shot ?? 'default';
const OUT = resolve(args.out ?? `shots/${SHOT}.png`);
const TIMEOUT = Number(args.timeout ?? 90000);
// Frames to render before capture: lets TAA converge, streaming settle, LOD pick.
const SETTLE = Number(args.settle ?? 90);

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

/**
 * Always bring up a DEDICATED vite on a private port, unless --port was given
 * explicitly.
 *
 * Reusing whatever already holds 5173 is actively dangerous once more than one
 * process is working in the repo:
 *   - that server has HMR on, so anything saving a file mid-capture navigates
 *     the page out from under playwright ("Execution context was destroyed"),
 *   - and worse, it serves ITS owner's working tree, so agent A's screenshot can
 *     silently be a picture of agent B's half-finished edit.
 * A private, HMR-disabled server per capture makes a screenshot mean what it says.
 */
async function freePort() {
  for (let i = 0; i < 200; i++) {
    const p = 5200 + Math.floor(Math.random() * 700);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

let PORT_ACTUAL = PORT;
async function ensureServer() {
  if (args.port) {
    // Explicit port: honour it, reuse whatever is there.
    if (await portOpen(PORT)) return null;
  } else {
    PORT_ACTUAL = await freePort();
  }
  const root = resolve(import.meta.dirname, '..');
  const p = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT_ACTUAL), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    detached: false,
    // No hot reload: a file saved mid-run would reload the page under playwright.
    env: { ...process.env, OW_NO_HMR: '1' },
  });
  for (let i = 0; i < 160; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(PORT_ACTUAL)) return p;
  }
  p.kill();
  throw new Error('vite failed to start');
}

const server = await ensureServer();

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal',
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
    '--disable-frame-rate-limit',
    '--force-color-profile=srgb',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    '--mute-audio',
  ],
});

const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
});

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));


/** Advance exactly n frames. Uses lockstep __PUMP__ when available. */
const pump = (n) =>
  page.evaluate(
    (k) =>
      window.__PUMP__
        ? window.__PUMP__(k)
        : new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

let failed = null;
try {
  /*
   * LOCKSTEP, ALWAYS (opt out with --lockstep=0).
   *
   * `src/dev/shots.js` has had a lockstep mode all along, built for exactly the
   * determinism problem this harness has — and this harness never asked for it.
   * Without it the engine's own rAF loop keeps stepping during every driver
   * round trip, so the frame index at the shutter drifts 10-20 frames run to
   * run, and everything phase-locked to the absolute frame index (TAA jitter,
   * GTAO/SSR/contact noise rotation on `frame % 64`, exposure adaptation)
   * resolves differently every time.
   *
   * MEASURED before enabling it, three captures of one unchanged shot:
   * 2959 / 4074 / 4096 draw calls and 8.26M / 10.94M / 10.96M triangles. An
   * agent trying to certify a change as pixel-neutral got a 1.54% noise floor
   * on one same-tree pair and 81.7% on the next, and correctly discarded their
   * own result as meaningless.
   */
  const LOCKSTEP = String(args.lockstep ?? '1') !== '0';
  const url =
    `http://127.0.0.1:${PORT_ACTUAL}/?capture=1&shot=${encodeURIComponent(SHOT)}` +
    (LOCKSTEP ? '&lockstep=1' : '') + (process.env.OW_WALLCLOCK ? '&owWallClockBuild=1' : '');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

  // Engine sets window.__READY__ = true once assets are loaded and first frame drawn.
  await page.waitForFunction('window.__READY__ === true', null, { timeout: TIMEOUT });

  if (args.list) {
    const shots = await page.evaluate('Object.keys(window.__SHOTS__ ?? {})');
    console.log(JSON.stringify(shots, null, 2));
  } else {
    // Apply the shot (camera pose, time of day, weapon state, ...).
    const applied = await page.evaluate(
      ({ s, settle }) =>
        window.__APPLY_SHOT__ ? window.__APPLY_SHOT__(s, { grabFrame: settle }) : 'no-shot-api',
      { s: SHOT, settle: SETTLE }
    );
    logs.push(`[shot] ${JSON.stringify(applied)}`);

    // A shot teleports the camera across a STREAMED city, so the tiles around
    // the new position still have to be built. Pump frames until `world` says
    // its amortised build queue has drained, THEN do the fixed settle pump so
    // temporal effects (TAA, exposure adaptation, GTAO history) converge on the
    // finished scene. Without this the shutter photographs a half-built city.
    const streamBudget = Number(args.streamBudget ?? 1200);
    let streamed = { settled: false, frames: 0 };
    while (streamed.frames < streamBudget) {
      if (await page.evaluate(() => window.__SETTLED__?.() === true)) { streamed.settled = true; break; }
      await pump(20);
      streamed.frames += 20;
    }
    logs.push(`[stream] ${JSON.stringify(streamed)}`);
    if (process.env.OW_CAPDIAG) console.error('[capdiag] stream', JSON.stringify(streamed));
    if (!streamed.settled) {
      console.error(`[capture] WARNING: world still streaming after ${streamed.frames} frames — frame may be incomplete`);
    }

    // Pump deterministic frames so temporal effects converge.
    await pump(SETTLE);

    // Last chance to clean the frame: a shot settles for ~1300 frames and the
    // world keeps living during them. `__PRESHUTTER__` (installed by the shot)
    // re-clears traffic that has driven into — or crashed in front of — the lens
    // since the shot was applied.
    const cleaned = await page.evaluate(() => window.__PRESHUTTER__?.() ?? 0);
    if (cleaned) {
      logs.push(`[shutter] cleared ${cleaned} vehicle(s) from frame`);
      // Let the despawn settle and the particles it leaves behind fade.
      await pump(20);
    }

    /*
     * FREEZE THE WORLD, THEN SHOOT.
     *
     * Clearing the frame and then rendering more frames before the shutter is a
     * race, and the world wins it. MEASURED: an agent comparing two arms of a
     * lighting change found `hero` had gone from 0.083% to 1.18% crushed
     * pixels, diffed the two frames, and found 16 464 of the 17 658 dark pixels
     * were A SINGLE DARK BLUE TRAFFIC CAR that drove into shot during the 20
     * settle frames above. The lighting change was at parity; the harness had
     * invented a 14x regression.
     *
     * `clearTraffic` deliberately only removes wrecks and stalled vehicles —
     * moving traffic is what a street frame is supposed to show — so the fix is
     * not more clearing, it is to stop time between the last clean and the
     * shutter. `time.scale = 0` leaves `update` and the render running, so the
     * frame still draws and TAA (already converged by now) stays converged.
     *
     * This also makes A/B comparisons honest: two arms of the same shot now
     * photograph the same world state instead of two different moments of it.
     */
    /*
     * ...AND RESTART THE TEMPORAL SEQUENCE FROM A KNOWN PHASE.
     *
     * Freezing the world is necessary but not sufficient. The streaming settle
     * above runs a VARIABLE number of frames — it stops when `world` says its
     * build queue has drained — and TAA advances a Halton jitter index once per
     * frame. So the shutter landed on a different sub-pixel offset every run,
     * and two captures of an unchanged tree could differ enormously.
     *
     * MEASURED by an agent trying to certify a change as pixel-neutral: a
     * 1.54% noise floor on one same-tree pair and **81.7% with maxDelta 235**
     * on the very next, with no source change between them. They correctly
     * discarded their own 80.8% before/after result as evidence of nothing.
     * A gate that noisy is worse than no gate — it cannot clear a change and it
     * cannot catch one.
     *
     * Resetting the jitter index and the history, then converging a FIXED
     * number of frames over a frozen world, makes the shutter a pure function
     * of the scene rather than of how long streaming happened to take.
     */
    const froze = await page.evaluate(() => {
      window.__PRESHUTTER__?.();
      const e = window.__ENGINE__;
      if (!e?.time) return false;
      e.time.scale = 0;
      // Re-pin the sky clock. `setTimeOfDay` runs when the shot is applied, but
      // the sky then advances with wall time across a settle whose length
      // depends on how fast tiles happened to build — so the sun sat in a
      // slightly different place every run. MEASURED residue: sky-sun intensity
      // 6.3308 vs 6.3778 between two runs of one build.
      const shotDef = window.__SHOTS__?.[window.__LAST_SHOT__ ?? ''] ?? null;
      const tod = shotDef?.time;
      if (tod !== undefined) e.ctx.peek('sky')?.setTimeOfDay?.(tod);
      const taa = e.ctx.peek('render')?.taa;
      if (taa) { taa.index = 0; taa.reset?.(); }
      return true;
    });
    if (!froze) logs.push('[shutter] WARNING: could not freeze the sim — frame may include motion');
    // Enough frames for TAA to converge from a cleared history on a static
    // scene. Fixed, never budgeted — a time budget is what made this drift.
    const TAA_CONVERGE = Number(args.converge ?? 32);
    await pump(TAA_CONVERGE);

    mkdirSync(dirname(OUT), { recursive: true });
    await page.screenshot({ path: OUT, type: 'png' });

    const info = await page.evaluate('window.__RENDER_INFO__ ?? null');
    console.log(JSON.stringify({ ok: true, out: OUT, shot: SHOT, w: W, h: H, info }, null, 2));
  }
} catch (e) {
  failed = e;
} finally {
  const gpu = await page
    .evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return 'NO WEBGL2';
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    })
    .catch(() => 'n/a');
  if (failed || args.verbose) {
    console.error('GPU:', gpu);
    console.error(logs.slice(-60).join('\n'));
  }
  await browser.close();
  if (server) server.kill();
}

if (failed) {
  console.error(JSON.stringify({ ok: false, error: failed.message }));
  process.exit(1);
}
