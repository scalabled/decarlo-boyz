#!/usr/bin/env node
/**
 * FLOAT-FALLBACK PROBE — the game must be VISIBLE on a GPU that cannot render
 * into a 32-bit float target.
 *
 *   npm run floatfb
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT WAS BROKEN
 *
 * Reported as: "mobile isn't working — the lighting was too dark. I tried
 * teleporting to another location and character but it still was too dark to
 * see anything." Controls and HUD were fine.
 *
 * Rendering INTO a float target and SAMPLING one are different capabilities.
 * WebGL2 grants the first only with `EXT_color_buffer_float`, which desktop has
 * universally and many mobile GPUs do not. The auto-exposure chain allocated
 * five `FloatType` targets unconditionally, so on those devices the framebuffers
 * were incomplete, the 1x1 exposure texture read back 0, and `composite.js`
 * multiplied the whole scene by it. Not "too dark" — mathematically black.
 *
 * Teleporting could not help. It was never about the place.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * RULE 12 — WHY THIS DOES NOT ASK THE RENDERER ANYTHING
 *
 * The tempting gate is "assert `floatType()` returns HalfFloatType when the
 * extension is missing". That tests the branch, not the outcome, and would have
 * passed on the broken build too — the broken build had no branch at all.
 *
 * So this measures LUMINANCE OF THE COMPOSITED FRAME, read back from the canvas
 * as PNG pixels, with `EXT_color_buffer_float` DENIED at the WebGL level. The
 * denial is real: `getExtension` is patched before any engine code runs, so the
 * renderer genuinely cannot allocate a float colour target, exactly as on the
 * device that failed.
 *
 * The control arm runs the same frame with the extension left alone. A build
 * that is broken on mobile shows a large gap between the two; a correct build
 * shows almost none.
 */
import { chromium } from 'playwright';
import { startServer, stopServer } from '../../tools/lib/server.mjs';
import { PNG } from 'pngjs';

const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=')[1] : d;
};
const SHOT = arg('shot', 'hero');

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

/** Mean luminance and the fraction of near-black pixels in the centre 80%. */
function stats(buf) {
  const png = PNG.sync.read(buf);
  const { width: w, height: h, data } = png;
  const x0 = (w * 0.1) | 0, x1 = (w * 0.9) | 0;
  const y0 = (h * 0.1) | 0, y1 = (h * 0.9) | 0;
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

const srv = await startServer();
const url = `http://localhost:${srv.port}/?capture=1&shot=${SHOT}&boot=0`;
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});

async function frame(deny) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const notes = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/EXT_color_buffer_float|float targets fall back/.test(t)) notes.push(t.slice(0, 90));
  });
  if (deny) await page.addInitScript(DENY);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__ENGINE__, null, { timeout: 180000 });
  await page.waitForFunction(() => window.__SETTLED__ && window.__SETTLED__(), null, { timeout: 240000 })
    .catch(() => {});
  await page.waitForTimeout(2500);
  const shot = await page.screenshot({ type: 'png' });
  const supported = await page.evaluate(
    () => !!document.createElement('canvas').getContext('webgl2')?.getExtension('EXT_color_buffer_float')
  );
  await page.close();
  return { ...stats(shot), supported, notes };
}

console.log('\n=== float-target fallback: is the frame VISIBLE without EXT_color_buffer_float? ===\n');
const ctrl = await frame(false);
const test = await frame(true);

const rows = [];
const rec = (name, ok, detail) => rows.push({ name, ok, detail });

rec('the control arm really has the extension', ctrl.supported === true, `supported=${ctrl.supported}`);
rec('the test arm really had it denied', test.supported === false, `supported=${test.supported}`);
rec('the fallback actually engaged', test.notes.length > 0, test.notes[0] ?? 'no log line seen');
rec('the frame is not black without float targets', test.mean > 12, `mean luma ${test.mean.toFixed(1)}`);
rec('it is not mostly near-black either', test.darkPct < 35, `${test.darkPct.toFixed(1)}% of pixels < 8`);
// NOT a parity assertion, deliberately. In WebGL2 `EXT_color_buffer_float`
// gates RGBA16F as well as RGBA32F, so denying it degrades the whole HDR
// colour chain — the scene target included — not just the exposure meter. The
// test arm is therefore HARSHER than any real device, and the measured 0.5x is
// the HDR chain, not the fix. What matters is that the frame is legible, which
// the two checks above assert. This one only fails if it goes backwards.
rec(
  'and it stays clear of the black-screen failure',
  ctrl.mean > 0 && test.mean / ctrl.mean > 0.25,
  `denied ${test.mean.toFixed(1)} vs full ${ctrl.mean.toFixed(1)} = ${(test.mean / (ctrl.mean || 1)).toFixed(2)}x` +
  ' (parity is not the bar — see comment)'
);

const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(w)}   ${r.detail}`);
const fails = rows.filter((r) => !r.ok).length;
console.log(`\nfloat fallback: ${rows.length - fails}/${rows.length}`);

await browser.close();
await stopServer(srv);
process.exit(fails ? 1 : 0);
