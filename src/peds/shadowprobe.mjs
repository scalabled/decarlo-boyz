#!/usr/bin/env node
/**
 * PED GROUND-CONTACT SHADOW — pixel A/B.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MEASURES, AND WHY IT IS NOT A RESTATEMENT OF THE CODE
 * ────────────────────────────────────────────────────────────────────────────
 * The defect this exists for is that the ped's ground shadow rendered BRIGHTER
 * than the road under it. That is a claim about PIXELS, so nothing here reads a
 * material constant, an opacity or a blend factor — hard rule 12. It:
 *
 *   1. freezes one frame (the harness's own lockstep + `time.scale = 0`),
 *   2. photographs it three times, changing ONLY the blend mode between shots
 *      via `peds.ground.setMode`: `off`, `lerp` (the historical defect) and
 *      `multiply` (the fix),
 *   3. derives the shadow's FOOTPRINT from the difference between arms rather
 *      than from where the code says it put the quads, and
 *   4. reports the road inside that footprint against the road immediately
 *      either side of it, on the same rows of the same frame.
 *
 * Point 3 is the part that matters. If the mask came from projecting the
 * instance transforms, the probe would be asking the code where its own
 * shadow is and would agree with it by construction — the `skyline` mistake in
 * ARCHITECTURE.md rule 12. Instead the mask is "every pixel that moved when the
 * pool was switched on", which is a fact about the framebuffer.
 *
 * WHAT INPUT WOULD MAKE THIS FAIL: any blend that raises a pixel it touches.
 * `--mode=lerp` is the negative control and it goes red, loudly.
 *
 * Usage:
 *   node src/peds/shadowprobe.mjs                       # driving, both TODs
 *   node src/peds/shadowprobe.mjs --shot=crowd --time=12
 *   node src/peds/shadowprobe.mjs --shot=driving --time=21.35 --keep=/tmp/arms
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import net from 'node:net';
import { PNG } from 'pngjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const W = Number(args.w ?? 1920);
const H = Number(args.h ?? 1080);
const TIMEOUT = Number(args.timeout ?? 120000);
const SETTLE = Number(args.settle ?? 90);
const CONVERGE = Number(args.converge ?? 32);
const KEEP = args.keep ? resolve(String(args.keep)) : null;

/**
 * The two lighting conditions the defect has to be measured in. Midday is the
 * easy case; 21:21 overcast is the hard one, because a lerp towards a constant
 * does its worst damage exactly where the receiver is darkest, and an overcast
 * night road is the darkest receiver in the game.
 */
const CONDITIONS = [
  { id: 'midday', time: 12.0, weather: 'overcast' },
  { id: '2121', time: 21.35, weather: 'overcast' },
];

/**
 * The default pair. `driving` is the frame the defect was measured on;
 * `character` is a second, independent scene whose road either side
 * of the subject is homogeneous, so the "is the mark brighter than the road
 * beside it" comparison there is clean rather than straddling a kerb.
 *
 * NOT `crowd` and NOT `combat`, both of which look like obvious choices and
 * are useless: `crowd` frames exactly one pedestrian and his feet are below
 * the bottom of the frame, and `combat`'s nearest subjects are 17 m away
 * behind a foreground prop. Both report UNMEASURED, which is correct and is
 * why that state exists.
 */
const SHOTS = args.shot ? [String(args.shot)] : ['driving', 'character'];
const TIMES = args.time !== undefined
  ? [{ id: String(args.time), time: Number(args.time), weather: String(args.weather ?? 'overcast') }]
  : CONDITIONS;

/* ------------------------------------------------------------------ */
/* server + browser, cloned from tools/capture.mjs                     */
/* ------------------------------------------------------------------ */

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function freePort() {
  for (let i = 0; i < 200; i++) {
    const p = 5200 + Math.floor(Math.random() * 700);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

const root = resolve(import.meta.dirname, '../..');
const PORT = await freePort();
const server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
  env: { ...process.env, OW_NO_HMR: '1' },
});
let up = false;
for (let i = 0; i < 160 && !up; i++) {
  await new Promise((r) => setTimeout(r, 250));
  up = await portOpen(PORT);
}
if (!up) { server.kill(); throw new Error('vite failed to start'); }

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--enable-zero-copy', '--disable-frame-rate-limit', '--force-color-profile=srgb',
    '--force-device-scale-factor=1', '--hide-scrollbars', '--mute-audio',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const pump = (n) => page.evaluate((k) => window.__PUMP__(k), n);

/* ------------------------------------------------------------------ */
/* pixel helpers                                                       */
/* ------------------------------------------------------------------ */

/** Rec.709 luminance of an sRGB byte triple, still in 0..255 display units. */
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** sRGB byte -> linear, scaled x255 so it is comparable with the values the
 *  `vehicles` shadow measurements are quoted in (9.19 -> 5.00 and so on). */
function toLinear(v) {
  const c = v / 255;
  return 255 * (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
}

function stats(png, pixels) {
  if (!pixels.length) return null;
  let sSrgb = 0, sLin = 0, min = Infinity, max = -Infinity;
  for (const i of pixels) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    const L = lum(r, g, b);
    const Ln = lum(toLinear(r), toLinear(g), toLinear(b));
    sSrgb += L; sLin += Ln;
    if (Ln < min) min = Ln;
    if (Ln > max) max = Ln;
  }
  return {
    n: pixels.length,
    srgb: +(sSrgb / pixels.length).toFixed(2),
    linear: +(sLin / pixels.length).toFixed(3),
    min: +min.toFixed(4),
    max: +max.toFixed(3),
  };
}

/* ------------------------------------------------------------------ */
/* one condition                                                       */
/* ------------------------------------------------------------------ */

const results = [];

async function run(shot, cond) {
  const url = `http://127.0.0.1:${PORT}/?capture=1&shot=${encodeURIComponent(shot)}&lockstep=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: TIMEOUT });

  await page.evaluate(
    ({ s, settle }) => window.__APPLY_SHOT__(s, { grabFrame: settle }),
    { s: shot, settle: SETTLE }
  );

  // Override the lighting BEFORE the settle, so the IBL rebake, the exposure
  // adaptation and the shadow cascades all converge on the condition we are
  // actually measuring rather than on the shot's own clock.
  await page.evaluate(({ t, w }) => {
    const sky = window.__ENGINE__.ctx.peek('sky');
    sky?.setTimeOfDay?.(t);
    sky?.setWeather?.(w, { immediate: true });
  }, { t: cond.time, w: cond.weather });

  for (let f = 0; f < 1200; f++) {
    if (await page.evaluate(() => window.__SETTLED__?.() === true)) break;
    await pump(20);
    f += 19;
  }
  await pump(SETTLE);

  // Freeze. Everything after this point differs between arms ONLY by the blend.
  const frozen = await page.evaluate(({ t, w }) => {
    window.__PRESHUTTER__?.();
    const e = window.__ENGINE__;
    e.time.scale = 0;
    const sky = e.ctx.peek('sky');
    sky?.setTimeOfDay?.(t);
    sky?.setWeather?.(w, { immediate: true });
    return { hour: sky?.hour ?? null, wetness: sky?.wetness ?? null };
  }, { t: cond.time, w: cond.weather });

  /*
   * Find something to look at. The ROI comes from the pool's own instance
   * transforms — that is a search hint, not the measurement: it decides WHERE
   * to point the camera crop, and the numbers inside the crop come from the
   * framebuffer and from the between-arm difference.
   */
  const roi = await page.evaluate(({ w, h }) => {
    const e = window.__ENGINE__;
    const peds = e.ctx.peek('peds');
    const cam = e.ctx.camera;
    if (!peds?.ground) return null;
    const mesh = peds.ground.feet.mesh.count > 0
      ? peds.ground.feet.mesh
      : peds.ground.body.mesh;
    const n = mesh.count;
    if (!n) return { error: 'no ground-shadow instances in this frame' };

    const arr = mesh.instanceMatrix.array;
    const el = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
    const px = (x, y, z) => {
      const cw = el[3] * x + el[7] * y + el[11] * z + el[15];
      if (cw <= 0) return null;
      const cx = (el[0] * x + el[4] * y + el[8] * z + el[12]) / cw;
      const cy = (el[1] * x + el[5] * y + el[9] * z + el[13]) / cw;
      return { x: (cx * 0.5 + 0.5) * w, y: (1 - (cy * 0.5 + 0.5)) * h };
    };

    const found = [];
    for (let i = 0; i < n; i++) {
      const o = i * 16;
      const x = arr[o + 12], y = arr[o + 13], z = arr[o + 14];
      const p = px(x, y, z);
      if (!p) continue;
      // Only a few pixels of margin. An earlier cut demanded 120 px and so
      // skipped the ped standing at the right-hand edge of the `driving`
      // frame — which is THE ped the defect shows on — and silently measured
      // a 30 m one instead, reporting a 52 px footprint as if that were the
      // subject. A probe that quietly picks a different subject is worse than
      // one that fails.
      if (p.x < 4 || p.x > w - 4 || p.y < 4 || p.y > h - 4) continue;
      const dx = x - cam.position.x, dy = y - cam.position.y, dz = z - cam.position.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1.2 || d > 45) continue;
      found.push({ x, y, z, px: p.x, py: p.y, d });
    }
    if (!found.length) return { error: 'no ground-shadow instance is on screen' };
    found.sort((a, b) => a.d - b.d);

    /*
     * SEVERAL candidates, not one. Projecting inside the frame is not the same
     * as being VISIBLE — on the `combat` shot the nearest instance sits behind
     * a foreground prop, so its mark is entirely occluded and the crop contains
     * no shadow at all. The arms are whole-frame screenshots and do not depend
     * on the crop, so the caller can try each candidate against the SAME three
     * images for free and take the first that actually contains a mark.
     */
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const R = 1.1;   // ~1 m square of ground: the mark plus a margin of open
                     // road, and not so wide that a second pedestrian's mark
                     // three metres away joins the population being averaged.
    const rois = found.slice(0, 8).map((b) => {
      let minX = b.px, maxX = b.px, minY = b.py, maxY = b.py;
      for (const [ox, oz] of [[R, 0], [-R, 0], [0, R], [0, -R], [R, R], [-R, -R], [R, -R], [-R, R]]) {
        const p = px(b.x + ox, b.y, b.z + oz);
        if (!p) continue;
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      return {
        dist: +b.d.toFixed(2),
        x0: Math.round(clamp(minX - 25, 0, w - 2)),
        y0: Math.round(clamp(minY - 25, 0, h - 2)),
        x1: Math.round(clamp(maxX + 25, 1, w - 1)),
        y1: Math.round(clamp(maxY + 25, 1, h - 1)),
      };
    });
    return {
      instances: { body: peds.ground.body.mesh.count, feet: peds.ground.feet.mesh.count },
      candidates: rois,
    };
  }, { w: W, h: H });

  if (!roi || roi.error) {
    results.push({ shot, cond: cond.id, error: roi?.error ?? 'no peds subsystem' });
    return;
  }

  /* ---- three arms of the same frozen frame ---- */
  const arms = {};
  for (const mode of ['off', 'lerp', 'multiply']) {
    await page.evaluate((m) => {
      const g = window.__ENGINE__.ctx.peek('peds').ground;
      g.setMode(m);
      const taa = window.__ENGINE__.ctx.peek('render')?.taa;
      if (taa) { taa.index = 0; taa.reset?.(); }
    }, mode);
    await pump(CONVERGE);
    const buf = await page.screenshot({ type: 'png' });
    arms[mode] = PNG.sync.read(buf);
    if (KEEP) {
      mkdirSync(KEEP, { recursive: true });
      writeFileSync(join(KEEP, `${shot}-${cond.id}-${mode}.png`), buf);
    }
  }
  // leave the page in the shipped mode
  await page.evaluate(() => window.__ENGINE__.ctx.peek('peds').ground.setMode('multiply'));

  /*
   * Take the first candidate whose crop actually contains a mark. An earlier
   * cut took the nearest candidate unconditionally, found a 0 px footprint on
   * `combat` because the subject was behind a prop, skipped every arm — and
   * still printed PASS. A gate that passes on no evidence is precisely the
   * thing ARCHITECTURE.md rule 12 is about, so an unmeasurable condition is
   * now reported as unmeasured and can never be counted as a pass.
   */
  const MIN_PX = 200;
  let out = null;
  for (const cand of roi.candidates) {
    const m = measure(shot, cond, cand, roi.instances, arms, frozen);
    if (m.footprintPx >= MIN_PX) { out = m; break; }
    if (!out || m.footprintPx > out.footprintPx) out = m;
  }
  if (out.footprintPx < MIN_PX) {
    out.unmeasured = `no candidate crop contains a mark (best ${out.footprintPx} px of ${MIN_PX}) — ` +
      'the pool is on screen but occluded, or too small at this range';
  }
  out.tried = roi.candidates.length;
  results.push(out);
}

/* ------------------------------------------------------------------ */
/* the measurement                                                     */
/* ------------------------------------------------------------------ */

function measure(shot, cond, roi, instances, arms, frozen) {
  const off = arms.off, lerp = arms.lerp, mul = arms.multiply;
  const rw = roi.x1 - roi.x0, rh = roi.y1 - roi.y0;
  const idx = (x, y) => (y * off.width + x) * 4;

  /*
   * THE FOOTPRINT, from the framebuffer.
   *
   * A pixel is "the shadow" if switching the pool on moved it by more than the
   * capture's own noise. The harness is lockstep over a frozen sim, so that
   * floor is tiny; 3/255 on any channel is comfortably above it and well below
   * anything the shadow does.
   */
  const TH = 3;
  const mask = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = idx(roi.x0 + x, roi.y0 + y);
      const dL = Math.max(
        Math.abs(lerp.data[i] - off.data[i]),
        Math.abs(lerp.data[i + 1] - off.data[i + 1]),
        Math.abs(lerp.data[i + 2] - off.data[i + 2])
      );
      const dM = Math.max(
        Math.abs(mul.data[i] - off.data[i]),
        Math.abs(mul.data[i + 1] - off.data[i + 1]),
        Math.abs(mul.data[i + 2] - off.data[i + 2])
      );
      if (dL > TH || dM > TH) mask[y * rw + x] = 1;
    }
  }

  const blob = [];
  const left = [];
  const right = [];
  const SIDE = 14;            // px of open road sampled either side, per row
  for (let y = 0; y < rh; y++) {
    let lo = -1, hi = -1;
    for (let x = 0; x < rw; x++) {
      if (!mask[y * rw + x]) continue;
      if (lo < 0) lo = x;
      hi = x;
    }
    if (lo < 0) continue;
    for (let x = lo; x <= hi; x++) if (mask[y * rw + x]) blob.push(idx(roi.x0 + x, roi.y0 + y));
    for (let x = Math.max(0, lo - SIDE); x < lo; x++) {
      if (!mask[y * rw + x]) left.push(idx(roi.x0 + x, roi.y0 + y));
    }
    for (let x = hi + 1; x < Math.min(rw, hi + 1 + SIDE); x++) {
      if (!mask[y * rw + x]) right.push(idx(roi.x0 + x, roi.y0 + y));
    }
  }

  const out = {
    shot, cond: cond.id, hour: frozen.hour, roi, instances,
    footprintPx: blob.length, arms: {},
  };
  for (const [name, png] of [['off', off], ['lerp', lerp], ['multiply', mul]]) {
    const b = stats(png, blob), l = stats(png, left), r = stats(png, right);
    if (!b || !l || !r) { out.arms[name] = { error: 'empty footprint' }; continue; }
    // The framing that matters: the mark against the open road either side of it,
    // in the same frame and on the same rows.
    const side = (l.linear * l.n + r.linear * r.n) / (l.n + r.n);
    /**
     * THE INVARIANT, and the only pass/fail here.
     *
     * "Brighter than the road around it" is a symptom of the operator, and
     * comparing two DIFFERENT patches of road can always be argued with —
     * asphalt varies, one side may catch more sky, a kerb may be in the strip.
     * The operator itself is not arguable: a transmittance can only multiply
     * DOWN, so no pixel it touches may end up above where it was with the pool
     * switched off. Count the ones that do.
     *
     * 1/255 of slack, because TAA resolves a frozen frame to within well under
     * that (repeat captures of one shot land at RMSE ~3e-05).
     */
    let raised = 0, worst = 0;
    for (const i of blob) {
      const d = lum(png.data[i], png.data[i + 1], png.data[i + 2]) -
                lum(off.data[i], off.data[i + 1], off.data[i + 2]);
      if (d > 1) raised++;
      if (d > worst) worst = d;
    }
    out.arms[name] = {
      under: b, left: l, right: r,
      side: +side.toFixed(3),
      ratio: +(b.linear / side).toFixed(3),
      delta: +(b.linear - stats(off, blob).linear).toFixed(3),
      raised, raisedPct: +((100 * raised) / blob.length).toFixed(1),
      worst: +worst.toFixed(1),
    };
  }
  return out;
}

/* ------------------------------------------------------------------ */

/**
 * The URL switches are what the write-up tells the next person to use, so they
 * have to be proven to work rather than assumed. The arms above drive
 * `setMode` directly (that is the only way to keep one frozen frame across
 * three shots); this checks that the documented flags reach the same place.
 * One page load, no shot, no streaming wait.
 */
let flagCheck = null;
try {
  const read = async (q) => {
    await page.goto(`http://127.0.0.1:${PORT}/?capture=1&shot=hero&lockstep=1${q}`,
      { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction('window.__READY__ === true', null, { timeout: TIMEOUT });
    return page.evaluate(() => window.__ENGINE__.ctx.peek('peds')?.ground?.mode ?? 'no-peds');
  };
  flagCheck = {
    none: await read(''),
    lerp: await read('&owPedShadowLerp=1'),
    off: await read('&owNoPedShadow=1'),
  };
} catch (e) {
  flagCheck = { error: String(e.message ?? e) };
}

let code = 0;
try {
  for (const shot of SHOTS) {
    for (const cond of TIMES) {
      await run(shot, cond);
    }
  }
} catch (e) {
  console.error(e.stack ?? e.message);
  console.error(logs.slice(-20).join('\n'));
  code = 1;
} finally {
  await browser.close();
  server.kill();
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

const pad = (s, n) => String(s).padEnd(n);
let fails = 0;
let measured = 0;
console.log('');
console.log('PED GROUND-CONTACT SHADOW — measured on the emitted frame');
console.log('linear x255; "under" = pixels the pool moved, "side" = open road on the same rows');
console.log('');
for (const r of results) {
  if (r.error) { console.log(`  ${r.shot}/${r.cond}: UNMEASURED — ${r.error}`); continue; }
  if (r.unmeasured) {
    console.log(`  ${r.shot}/${r.cond}: UNMEASURED after ${r.tried} candidate crops — ${r.unmeasured}`);
    continue;
  }
  measured++;
  console.log(
    `  ${r.shot} @ ${r.cond} (hour ${Number(r.hour).toFixed(2)}) — subject ${r.roi.dist} m away, ` +
    `crop ${r.roi.x0},${r.roi.y0}..${r.roi.x1},${r.roi.y1}, ` +
    `${r.instances.body} body + ${r.instances.feet} foot instances, footprint ${r.footprintPx} px`
  );
  console.log(`    ${pad('arm', 10)}${pad('under', 9)}${pad('left', 9)}${pad('right', 9)}${pad('vs OFF', 9)}${pad('raised', 15)}verdict`);
  for (const k of ['off', 'lerp', 'multiply']) {
    const a = r.arms[k];
    if (!a || a.error) { console.log(`    ${pad(k, 10)}${a?.error ?? '-'}`); continue; }
    const brightens = a.raisedPct > 0.5;
    const verdict = k === 'off' ? 'reference (pool switched off)'
      : brightens ? 'BRIGHTENS — a shadow that lights the road' : 'darkens only';
    if (k === 'multiply' && brightens) fails++;
    if (k === 'lerp' && !brightens) fails++;   // negative control must go red
    console.log(
      `    ${pad(k, 10)}${pad(a.under.linear, 9)}${pad(a.left.linear, 9)}${pad(a.right.linear, 9)}` +
      `${pad((a.delta > 0 ? '+' : '') + a.delta, 9)}` +
      `${pad(`${a.raisedPct}% (max +${a.worst})`, 15)}${verdict}`
    );
  }
  console.log('');
}
const flagOk = flagCheck && flagCheck.none === 'multiply' &&
  flagCheck.lerp === 'lerp' && flagCheck.off === 'off';
console.log(`  URL switches: default=${flagCheck?.none} ?owPedShadowLerp=1 -> ${flagCheck?.lerp} ` +
  `?owNoPedShadow=1 -> ${flagCheck?.off}  ${flagOk ? 'OK' : 'BROKEN'}`);
if (!flagOk) fails++;
console.log('');
if (measured === 0) {
  console.log('  NO CONDITION PRODUCED A MEASURABLE FOOTPRINT — this run proves nothing.');
  fails++;
}
console.log(fails === 0
  ? `PASS (${measured} condition${measured === 1 ? '' : 's'} measured) — the fixed blend only ever ` +
    'darkens, and the reverted blend is caught.'
  : `FAIL — ${fails} check(s)`);
process.exit(code || (fails ? 1 : 0));
