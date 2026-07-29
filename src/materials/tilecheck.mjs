#!/usr/bin/env node
/**
 * TILING + MICRO-CORRELATION GATE (dev tool, not shipped).
 *
 * Two things a critic said about this material set that were true, and that
 * both have to be proven against EMITTED PIXELS rather than against the
 * constants the shader was fed:
 *
 *   1. "Brick tiles visibly at 10 m", "the road repeats every four metres".
 *   2. "One grey speckle texture is serving as ground aggregate, a shirt weave,
 *      weapon rust and asphalt binder at once — matchable blob for blob."
 *
 * ---------------------------------------------------------------- the trap --
 *
 * The naive tiling test is "sample the material at x and at x + one tile and
 * show the pixels differ". That test cannot fail. Every surface in this shader
 * carries a world-space macro layer, so two points a tile apart ALWAYS differ a
 * little, and the check would report a guarantee it never made — exactly the
 * failure mode ARCHITECTURE.md rule 12 exists to stop.
 *
 * So the statistic is a RATIO of two measurements of the same kind:
 *
 *     repeat   = RMS( highpass(crop @ x), highpass(crop @ x + 1 tile) )
 *     control  = RMS( highpass(crop @ x), highpass(crop @ x + 0.37 tile) )
 *     ratio    = repeat / control
 *
 * A surface that tiles exactly has repeat ~ 0 while control carries the whole
 * texture variance, so the ratio collapses toward 0. A surface with no repeat
 * at the tile offset scores ~1: one tile along is no more similar than any
 * other offset. The high-pass removes the macro wash, which is the term that
 * would otherwise let a tiling surface pass.
 *
 * `--control` reruns every surface with de-tiling forced off. That is the
 * NEGATIVE CONTROL: if the numbers do not drop when the fix is removed, the
 * gate is measuring nothing.
 *
 * The micro-correlation half renders two unrelated surfaces at the same mapping
 * and cross-correlates their high-passed luminance. Shared-speckle surfaces
 * correlate; genuinely different micro families do not.
 *
 *   node src/materials/tilecheck.mjs
 *   node src/materials/tilecheck.mjs --control
 *   node src/materials/tilecheck.mjs --keep=/tmp/tiles   (write the frames out)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';
import { PNG } from 'pngjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = Number(args.port ?? 5388);
const W = 1600;
const H = 900;
const KEEP = args.keep ? resolve(String(args.keep)) : null;
const CONTROL = !!args.control;
/**
 * THE METRIC'S OWN NEGATIVE CONTROL. Forces the macro layer and de-tiling off,
 * which leaves the surface exactly periodic on its tile — so the ratio MUST
 * collapse to ~0 and corrAtTile MUST go to ~1. If it does not, the tiling
 * numbers below are decoration and should be ignored.
 */
const EXACT = !!args.exact;

/**
 * Every surface here is checked at the mapping the game actually gives it.
 * `tile` is the metres the baked texture spans in the world — the period the
 * repeat would land on — and `uvm` is metres per mesh-uv unit for the surfaces
 * that are UV-mapped rather than world-projected.
 */
const CASES = [
  { m: 'road_lane', tile: 4.0, uvm: 4, ppm: 60 },
  { m: 'road_lane_worn', tile: 4.0, uvm: 4, ppm: 60 },
  { m: 'road_asphalt', tile: 4.0, uvm: 4, ppm: 60 },
  { m: 'sidewalk', tile: 2.4, uvm: 4, ppm: 100 },
  { m: 'gravel', tile: 1.6, uvm: 4, ppm: 150 },
];

/**
 * Micro sets that must not be each other. The identity row is the POSITIVE
 * control: if set 0 does not correlate with itself the metric is broken and
 * every zero below it is meaningless.
 */
const SETS = [
  { a: 0, b: 0, rotA: 0, rotB: 0, label: 'set0 vs itself (positive control)' },
  { a: 0, b: 1, rotA: 0, rotB: 0, label: 'mineral vs woven' },
  { a: 0, b: 2, rotA: 0, rotB: 0, label: 'mineral vs machined' },
  { a: 1, b: 2, rotA: 0, rotB: 0, label: 'woven vs machined' },
  { a: 0, b: 0, rotA: 0, rotB: 0.07, label: 'set0 vs set0 rotated 25 deg' },
];

/** Surfaces that must not share a visible micro field. */
const PAIRS = [
  ['road_lane', 'fabric'],
  ['road_lane', 'metal_rust'],
  ['fabric', 'metal_rust'],
  ['concrete', 'burlap'],
];

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let server = null;
if (!(await portOpen(PORT))) {
  server = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await portOpen(PORT);
  }
  if (!up) {
    server.kill();
    throw new Error('vite failed to start');
  }
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

if (KEEP) mkdirSync(KEEP, { recursive: true });

async function shoot(query, tag) {
  await page.goto(`http://127.0.0.1:${PORT}/src/materials/preview.html?view=tiling&${query}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 60000 });
  await page.evaluate(
    () =>
      new Promise((d) => {
        let i = 0;
        const t = () => (++i >= 8 ? d() : requestAnimationFrame(t));
        requestAnimationFrame(t);
      })
  );
  const buf = await page.screenshot({ type: 'png' });
  if (KEEP && tag) writeFileSync(resolve(KEEP, `${tag}.png`), buf);
  return PNG.sync.read(buf);
}

// ------------------------------------------------------------- pixel maths --
/** Linear-ish luminance of a crop, as a Float64Array. */
function luma(png, x0, y0, w, h) {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * png.width + (x0 + x)) << 2;
      out[y * w + x] =
        0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
    }
  }
  return out;
}

/**
 * Remove everything coarser than `r` texels. The macro wash is what makes a
 * tiling surface look non-tiling to a naive difference; taking it out is what
 * makes the ratio below mean "does the TEXTURE repeat".
 */
function boxblur(a, w, h, r) {
  const blur = new Float64Array(w * h);
  const tmp = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        s += a[y * w + xx];
        n++;
      }
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        s += tmp[yy * w + x];
        n++;
      }
      blur[y * w + x] = s / n;
    }
  }
  return blur;
}

/**
 * Keep only the band a human reads as "this repeats": coarser than the micro
 * tooth, finer than the macro wash. Both ends matter. Leave the macro in and a
 * tiling surface passes because its 8 m colour wash differs between the two
 * windows; leave the micro in and the score is dominated by a detail layer
 * whose own period is 18 cm, which is not the artefact anyone is complaining
 * about. rSmall/rBig are in pixels and the caller sets them from ppm.
 */
function bandpass(a, w, h, rSmall, rBig) {
  const lo = boxblur(a, w, h, rSmall);
  const hi = boxblur(a, w, h, rBig);
  const out = new Float64Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = lo[i] - hi[i];
  return out;
}

function rms(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s / a.length);
}

function corr(a, b) {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= a.length;
  mb /= b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.max(Math.sqrt(da * db), 1e-9);
}

// ------------------------------------------------------------------ tiling --
const CROP = 320;
const results = [];
for (const c of CASES) {
  const tilePx = Math.round(c.tile * c.ppm);
  // The band a human calls "tiling": 12 cm to 1.5 m.
  const rS = Math.max(2, Math.round(0.12 * c.ppm));
  const rB = Math.max(rS + 4, Math.round(1.5 * c.ppm));
  const q =
    `m=${c.m}&ppm=${c.ppm}&uvm=${c.uvm}&sun=noon` +
    (CONTROL || EXACT ? '&detile=0' : '') +
    (EXACT ? '&macro=0' : '');
  const png = await shoot(q, `${c.m}${CONTROL ? '-control' : ''}`);
  const y0 = Math.floor((H - CROP) / 2);
  const x0 = 40;
  const need = x0 + tilePx + CROP;
  if (need > W) {
    results.push({ surface: c.m, skipped: `needs ${need}px of frame` });
    continue;
  }
  const bp = (x) => bandpass(luma(png, x, y0, CROP, CROP), CROP, CROP, rS, rB);
  const base = bp(x0);
  const rep = bp(x0 + tilePx);
  const off = bp(x0 + Math.round(tilePx * 0.37));
  const repeat = rms(base, rep);
  const control = rms(base, off);
  results.push({
    surface: c.m,
    tileM: c.tile,
    tilePx,
    repeatRms: +repeat.toFixed(3),
    offsetRms: +control.toFixed(3),
    ratio: +(repeat / Math.max(control, 1e-6)).toFixed(3),
    corrAtTile: +corr(base, rep).toFixed(3),
  });
}

// --------------------------------------------------------- micro decorrelation --
/**
 * Cross-correlate the shared micro FIELDS directly. Doing it on two lit
 * surfaces instead would measure their base textures, which differ anyway —
 * a pass that was never earned. The identity row is the positive control.
 */
async function shootSet(i, rot, tag) {
  await page.goto(
    `http://127.0.0.1:${PORT}/src/materials/preview.html?view=detailmap&i=${i}&rot=${rot}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 }
  );
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 60000 });
  const buf = await page.screenshot({ type: 'png' });
  if (KEEP && tag) writeFileSync(resolve(KEEP, `${tag}.png`), buf);
  return PNG.sync.read(buf);
}

const sets = [];
for (const t of SETS) {
  // In the control arm every surface is forced onto set 0 with no rotation,
  // which is precisely what the old build did — so every row collapses to the
  // identity case and the correlations must go to ~1.
  const a = CONTROL ? 0 : t.a;
  const b = CONTROL ? 0 : t.b;
  const ra = CONTROL ? 0 : t.rotA;
  const rb = CONTROL ? 0 : t.rotB;
  const pa = await shootSet(a, ra, `set${a}-${ra}`);
  const pb = await shootSet(b, rb, `set${b}-${rb}`);
  const x0 = 640;
  const y0 = 290;
  const A = bandpass(luma(pa, x0, y0, CROP, CROP), CROP, CROP, 2, 40);
  const B = bandpass(luma(pb, x0, y0, CROP, CROP), CROP, CROP, 2, 40);
  sets.push({ pair: t.label, corr: +corr(A, B).toFixed(3) });
}

await browser.close();
if (server) server.kill();

const out = {
  mode: EXACT
    ? 'METRIC CONTROL — macro + de-tiling off, surface is exactly periodic'
    : CONTROL
      ? 'NEGATIVE CONTROL — de-tiling off, every surface forced onto one shared micro set'
      : 'shipping',
  tiling: results,
  micro: sets,
  errors: errors.slice(0, 8),
};
console.log(JSON.stringify(out, null, 2));
