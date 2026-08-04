#!/usr/bin/env node
/**
 * SKY FALLBACK PROBE — the ATMOSPHERE must be VISIBLE on a GPU that cannot
 * render into a 32-bit float target.
 *
 *   npm run skyfb
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT WAS BROKEN
 *
 * Reported from a real phone as: "the sky is black (with clouds)". Clouds
 * rendered; the atmospheric sky behind them was mathematically black.
 *
 * The sky had exactly ONE 32-bit float colour target: the transmittance LUT
 * (`floatTarget` in fullscreen.js, allocated in luts.js). Rendering INTO a
 * float target needs `EXT_color_buffer_float`, which desktop has universally
 * and many mobile GPUs do not — the same capability gap that already blacked
 * out the exposure chain (see src/render/floatfallbackprobe.mjs). On those
 * devices the transmittance framebuffer is incomplete, the bake writes
 * nothing, and the texture samples as ZERO. Everything downstream multiplies
 * through it:
 *
 *   sky-view LUT   = scattering x transmittance(0)      -> black
 *   ambient LUT    = integral of the black sky-view     -> black
 *   dome           = sample of the black sky-view       -> black
 *   sun disc       = radiance x transmittance(0)        -> gone
 *
 * The clouds survive because their ground-bounce term is built from plain CPU
 * uniforms (`uSunIrradiance * uGroundAlbedo * max(0,sunDir.y)/pi` in
 * cloudpass.js), and the scene survives because the sun DirectionalLight
 * colour is the CPU integral in atmosphere.js — which is exactly the reported
 * frame: a normally lit city, grey clouds, void behind them.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * RULE 12 — THE MEASUREMENT
 *
 * Nothing here asks the renderer which type it allocated — that would test the
 * branch, not the outcome, and would have passed on the broken build (which
 * had no branch). This measures MEAN LUMINANCE OF THE SKY BAND — the top
 * quarter of a composited frame whose camera is pitched ~48 degrees up at
 * noon, so the band is pure sky well above the skyline — read back from the
 * canvas as PNG pixels, with `EXT_color_buffer_float` denied at the WebGL
 * level before any engine code runs.
 *
 * Four arms:
 *   A  control            the fixed code on a capable desktop
 *   B  denied             the mobile capability class; the sky must be ALIVE
 *   C  denied + hatch     `owSkyFloatLUT=1` reverts the target fallback
 *                         (negative control: the band must go BLACK again,
 *                         proving the probe measures the fallback and nothing
 *                         else)
 *   D  control + hatch    on a capable device the hatch selects the same
 *                         Float32 the fallback does, so A and D must be
 *                         pixel-identical — the fix is pixel-neutral on
 *                         desktop, proved on emitted pixels, not asserted
 *
 * The B/A ratio deliberately has a wide floor, not a parity bar: denying
 * `EXT_color_buffer_float` in WebGL2 degrades RGBA16F renderability decisions
 * across the whole HDR chain too (see the note in floatfallbackprobe.mjs), so
 * the test arm is harsher than the real device class. The bar is "the sky is
 * a sky", which the absolute checks carry.
 */
import { chromium } from 'playwright';
import { startServer, stopServer } from '../../tools/lib/server.mjs';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

/**
 * Inline shot: Golden Triangle street, camera pitched ~48 degrees up, clear
 * noon. With a 62-degree vertical FOV the measured band (top quarter of the
 * frame) spans ~63-79 degrees of elevation — sky, never skyline. `time: 12`
 * per the report this probe exists for; weather defaults to clear+immediate
 * for inline shots (src/dev/shots.js).
 */
const SHOT = '{"pos":[-232,6,150],"look":[-232,150,20],"fov":62,"time":12}';

/** Deny the extension before a single line of engine code runs. */
const DENY = `(() => {
  const patch = (proto) => {
    if (!proto) return;
    const orig = proto.getExtension;
    proto.getExtension = function (name) {
      if (name === 'EXT_color_buffer_float') return null;
      return orig.call(this, name);
    };
    const os = proto.getSupportedExtensions;
    proto.getSupportedExtensions = function () {
      return (os.call(this) || []).filter((n) => n !== 'EXT_color_buffer_float');
    };
  };
  patch(self.WebGL2RenderingContext && self.WebGL2RenderingContext.prototype);
})()`;

/** Mean luminance / near-black fraction over the SKY BAND (top quarter). */
function skyBand(buf) {
  const png = PNG.sync.read(buf);
  const { width: w, height: h, data } = png;
  const x0 = (w * 0.1) | 0, x1 = (w * 0.9) | 0;
  const y0 = (h * 0.02) | 0, y1 = (h * 0.25) | 0;
  let sum = 0, dark = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += l;
      if (l < 8) dark++;
      n++;
    }
  }
  return { mean: sum / n, darkPct: (dark / n) * 100 };
}

/** Whole-frame RMSE between two PNG buffers (the pixel-neutrality check). */
function rmse(a, b) {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height) return Infinity;
  let s = 0;
  const n = A.width * A.height * 3;
  for (let i = 0; i < A.width * A.height; i++) {
    for (let k = 0; k < 3; k++) {
      const d = A.data[i * 4 + k] - B.data[i * 4 + k];
      s += d * d;
    }
  }
  return Math.sqrt(s / n);
}

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio',
    '--force-color-profile=srgb', '--force-device-scale-factor=1', '--hide-scrollbars'],
});

/**
 * One arm: boot deterministic lockstep capture, apply the inline noon shot,
 * settle, freeze, converge, shoot. Same dance as src/render/shotprobe.mjs.
 */
async function frame({ deny = false, params = '' } = {}) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  const notes = [];
  page.on('console', (m) => {
    const t = m.text();
    // Only the SKY's own fallback line. The render subsystem logs its own
    // '[render] no EXT_color_buffer_float' for the exposure chain, and on the
    // pre-fix tree that line alone made this check pass — a check that can be
    // satisfied by another subsystem's fallback checks nothing about this one.
    if (/\[sky\].*LUT falls back/.test(t)) notes.push(t.slice(0, 110));
  });
  if (deny) await page.addInitScript(DENY);
  const url = `http://127.0.0.1:${port}/?capture=1&lockstep=1${params ? `&${params}` : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });

  const pump = (n) => page.evaluate((k) => window.__PUMP__(k), n);
  await page.evaluate((s) => window.__APPLY_SHOT__(s, { grabFrame: 60 }), SHOT);
  let frames = 0;
  while (frames < 1200) {
    if (await page.evaluate(() => window.__SETTLED__?.() === true)) break;
    await pump(20);
    frames += 20;
  }
  await pump(60);
  await page.evaluate(() => {
    window.__PRESHUTTER__?.();
    const e = window.__ENGINE__;
    e.time.scale = 0;
    // Re-pin the clock: the settle burns game-minutes (see tools/capture.mjs).
    e.ctx.peek('sky')?.setTimeOfDay?.(12);
    const taa = e.ctx.peek('render')?.taa;
    if (taa) { taa.index = 0; taa.reset?.(); }
  });
  await pump(32);
  const shot = await page.screenshot({ type: 'png' });
  const supported = await page.evaluate(
    () => !!document.createElement('canvas').getContext('webgl2')?.getExtension('EXT_color_buffer_float')
  );
  await page.close();
  return { ...skyBand(shot), supported, notes, shot };
}

console.log('\n=== sky fallback: is the ATMOSPHERE visible without EXT_color_buffer_float? ===\n');
const A = await frame({});
const B = await frame({ deny: true });
const C = await frame({ deny: true, params: 'owSkyFloatLUT=1' });
const D = await frame({ params: 'owSkyFloatLUT=1' });

if (args.outdir) {
  mkdirSync(String(args.outdir), { recursive: true });
  for (const [k, v] of [['A-control', A], ['B-denied', B], ['C-denied-hatch', C], ['D-control-hatch', D]])
    writeFileSync(`${args.outdir}/${k}.png`, v.shot);
}

const neutral = rmse(A.shot, D.shot);
const rows = [];
const rec = (name, ok, detail) => rows.push({ name, ok, detail });

rec('the control arm really has the extension', A.supported === true, `supported=${A.supported}`);
rec('the denied arm really had it denied', B.supported === false, `supported=${B.supported}`);
rec('the SKY fallback actually engaged', B.notes.length > 0,
  B.notes[0] ?? "no '[sky] ... LUT falls back' line seen");
rec('control sky band is a daytime sky', A.mean > 60, `mean luma ${A.mean.toFixed(1)}`);
// The defect this probe exists for. MEASURED on the pre-fix tree: control
// 83.7 mean luma, denied 4.3 with 99.2% of the band under 8.
rec('denied sky band is NOT black', B.mean > 25 && B.darkPct < 20,
  `mean ${B.mean.toFixed(1)}, ${B.darkPct.toFixed(1)}% of band < 8 (was 4.3 / 99.2% before the fix)`);
rec('denied sky is a sane fraction of control', A.mean > 0 && B.mean / A.mean > 0.3 && B.mean / A.mean < 3,
  `denied ${B.mean.toFixed(1)} vs control ${A.mean.toFixed(1)} = ${(B.mean / (A.mean || 1)).toFixed(2)}x`);
// NEGATIVE CONTROL: reverting the fallback under denial must reproduce the
// black sky, or these numbers measure something other than the fallback.
rec('negative control: reverting the fallback blacks the band again',
  C.mean < 8 && C.mean < B.mean * 0.25,
  `hatch mean ${C.mean.toFixed(1)} vs fixed ${B.mean.toFixed(1)}`);
// PIXEL NEUTRALITY: on a capable device the hatch and the fallback pick the
// same Float32, so the two frames must agree pixel-for-pixel.
rec('the fix is pixel-neutral on a capable desktop', neutral < 1.5,
  `RMSE(control, control+hatch) = ${neutral.toFixed(3)}`);

const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(w)}   ${r.detail}`);
const fails = rows.filter((r) => !r.ok).length;
console.log(`\nsky fallback: ${rows.length - fails}/${rows.length}`);

await browser.close();
stopServer(server);
process.exit(fails ? 1 : 0);
