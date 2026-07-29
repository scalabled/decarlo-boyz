#!/usr/bin/env node
/**
 * POLICE — searchlight measurement probe.
 *
 * Reproduces the defect frame (night 21:21, overcast, `low` preset, wanted 5,
 * helicopter overhead with the beam on the player) and MEASURES the result:
 * clipped-pixel fraction, crushed-black fraction, and the mean/contrast inside a
 * caller-chosen rectangle, which is what proves a lit building face still has
 * material rather than being replaced by a flat cream slab.
 *
 *   node src/police/_beamprobe.mjs --out=/tmp/beam-before.png
 *   node src/police/_beamprobe.mjs --out=/tmp/x.png --q=high --time=21.35
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const OUT = args.out ?? '/tmp/beam.png';
const Q = args.q ?? 'low';
const TIME = Number(args.time ?? 21.35); // 21:21
const W = Number(args.w ?? 1600);
const H = Number(args.h ?? 900);
const WEATHER = args.weather ?? 'overcast';

const SCENES = {
  // The defect frame: downtown at night, the shot the player stands in.
  downtown: {
    pos: [-232, 5, 150],
    look: [-232, 22, -40],
    fov: 62,
    ground: true,
    onRoad: { near: [-232, 64], eye: 5.0, ahead: 0.3 },
    clearTraffic: 34,
  },
  // Lawrenceville brick rowhouses at eye level — a FACADE close enough to the
  // beam to prove the pool lights material instead of replacing it.
  street: {
    pos: [680, 4, -520],
    look: [640, 8, -600],
    fov: 55,
    ground: true,
    onRoad: { near: [680, -552], eye: 2.2, ahead: 0.35 },
    clearTraffic: 34,
  },
};
const SHOT = { ...(SCENES[args.scene ?? 'downtown']), time: TIME, weather: WEATHER };

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio',
    '--enable-gpu-rasterization', '--force-color-profile=srgb',
    '--force-device-scale-factor=1', '--hide-scrollbars',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d(true) : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

let out = {};
try {
  await page.goto(`http://127.0.0.1:${port}/?capture=1&q=${Q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 120000 });

  const applied = await page.evaluate((s) => window.__APPLY_SHOT__(JSON.stringify(s), { grabFrame: 90 }), SHOT);
  out.applied = applied;

  // Wait for streaming to drain, then let temporal effects (exposure!) converge.
  const streamed = await page.evaluate(
    (budget) => new Promise((done) => {
      let i = 0;
      const tick = () => {
        if (window.__SETTLED__?.() === true) return done({ settled: true, frames: i });
        if (++i >= budget) return done({ settled: false, frames: i });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
    1500
  );
  out.streamed = streamed;
  await pump(120);

  // Wanted 5 + helicopter overhead with the beam on the player.
  out.stage = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    const r = pol.debugStage('air');
    pol.meter.set(5);
    return r;
  });
  /**
   * Aim. `--aim=dx,dz` walks the beam's ground spot off the camera, so the
   * shaft can be judged FROM THE SIDE and the pool can be dropped onto a
   * building face. With no offset the beam is on the player, which is the
   * frame the bug shows up in.
   *
   * `meter.seen = true` matters: the beam runs at 55% while the police have
   * lost you, and the defect frame is an ACTIVE five-star pursuit. The
   * staged tableau does not run the meter, so it is set by hand here.
   */
  if (args.tune) {
    out.tune = await page.evaluate((pairs) => {
      const t = window.__ENGINE__.ctx.peek('police').heli.beamTuning;
      for (const [k, v] of pairs) t[k] = v;
      return { ...t };
    }, String(args.tune).split(',').map((p) => { const [k, v] = p.split(':'); return [k, Number(v)]; }));
  }

  out.aim = await page.evaluate((off) => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    const h = pol.heli;
    const cam = e.camera;
    pol.meter.seen = true;
    // CAMERA space: [right, forward] in metres. World XZ is useless here —
    // `onRoad` snaps the shot onto whatever lane it finds and the street does
    // not run down -Z, so a world-space offset can put the spot off screen.
    const f = new cam.position.constructor(0, 0, -1).applyQuaternion(cam.quaternion);
    f.y = 0; f.normalize();
    const x = cam.position.x + f.z * -off[0] + f.x * off[1];
    const z = cam.position.z + f.x * off[0] + f.z * off[1];
    const gy = pol.groundAt(x, z, cam.position.y + 60);
    h._target.set(x, gy, z);
    h._aimBeam(e.ctx, gy);
    return {
      x, z, gy, beamOn: h.beamOn,
      len: h.beamMat.uniforms?.uBeam.value.x ?? null,
      gain: h.beamMat.uniforms?.uBeam.value.w ?? h.beamMat.opacity,
    };
  }, String(args.aim ?? '0,0').split(',').map(Number));

  /**
   * `--legacy=1` puts the ORIGINAL flat additive cone back, in this same build
   * and this same browser run, so before/after is one run order apart instead
   * of one code state apart.
   */
  if (args.legacy) {
    out.legacy = await page.evaluate(() => {
      const h = window.__ENGINE__.ctx.peek('police').heli;
      // MeshBasicMaterial, reached off the rotor disc so no import is needed.
      const MeshBasic = h.disc.material.constructor;
      h.beam.material = new MeshBasic({
        color: 0xffe6b4,
        transparent: true,
        opacity: 0.11 * h.beamOn,
        side: 2,          // THREE.DoubleSide
        depthWrite: false,
        blending: 2,      // THREE.AdditiveBlending
      });
      // The old build had no ground pool at all: suppress the light too, or
      // this measures a hybrid instead of the shipped defect.
      const on = h.beamOn;
      h.beamOn = -1;
      return { opacity: h.beam.material.opacity, on };
    });
  }
  if (args.nolight) {
    await page.evaluate(() => { window.__ENGINE__.ctx.peek('police').heli.beamOn = -1; });
  }
  if (args.nobeam) {
    await page.evaluate(() => {
      const h = window.__ENGINE__.ctx.peek('police').heli;
      if (h.beam) h.beam.visible = false;
      h._beamOff = true;
    });
  }
  if (args.noheli) {
    await page.evaluate(() => { window.__ENGINE__.ctx.peek('police').heli.root.visible = false; });
  }
  await pump(90);
  await page.evaluate(() => window.__PRESHUTTER__?.());
  await pump(20);

  // Where is the beam on screen? Project the beam cone's axis endpoints so the
  // measurement rectangles can be placed on real geometry inside the beam.
  out.beam = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    const h = pol.heli;
    const THREE = window.__THREE__ ?? null;
    const cam = e.camera;
    const p = { x: h.position.x, y: h.position.y, z: h.position.z };
    const t = { x: h._target.x, y: h._target.y, z: h._target.z };
    const proj = (v) => {
      const o = new h.position.constructor(v.x, v.y, v.z);
      o.project(cam);
      return [Math.round((o.x * 0.5 + 0.5) * window.innerWidth), Math.round((-o.y * 0.5 + 0.5) * window.innerHeight)];
    };
    return {
      heli: p, target: t,
      heliPx: proj(p), targetPx: proj(t),
      beamVisible: h.beam?.visible ?? null,
      gain: h.beamMat?.uniforms?.uBeam?.value?.w ?? h.beamMat?.opacity ?? null,
      beamOn: h.beamOn ?? null,
      level: pol.level,
      spot: h._spot.toArray().map((v) => +v.toFixed(1)),
      spotPx: proj(h._spot),
      pool: (e.ctx.peek('render')?._pool ?? []).map((p) => ({
        i: +p.light.intensity.toFixed(1),
        d: +p.light.distance.toFixed(1),
        key: p.key,
        pos: p.light.position.toArray().map((v) => +v.toFixed(1)),
      })),
      budget: e.ctx.peek('render')?.lightBudget ?? null,
      exposure: e.ctx.peek('render')?.debugExposure?.() ?? null,
      camPos: cam.position.toArray(),
    };
  });

  mkdirSync(dirname(OUT), { recursive: true });
  const buf = await page.screenshot({ type: 'png' });
  writeFileSync(OUT, buf);

  const png = PNG.sync.read(buf);
  out.stats = measure(png);
  if (args.rect) {
    const [x0, y0, x1, y1] = String(args.rect).split(',').map(Number);
    out.rect = rectStats(png, x0, y0, x1, y1);
    const crop = new PNG({ width: x1 - x0, height: y1 - y0 });
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const s = (y * png.width + x) * 4;
        const d = ((y - y0) * crop.width + (x - x0)) * 4;
        crop.data[d] = png.data[s]; crop.data[d + 1] = png.data[s + 1];
        crop.data[d + 2] = png.data[s + 2]; crop.data[d + 3] = 255;
      }
    writeFileSync(OUT.replace(/\.png$/, '') + '.crop.png', PNG.sync.write(crop));
  }
  out.errors = errs.slice(0, 6);
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error('FAILED', e.message, errs.slice(0, 6));
  process.exitCode = 1;
} finally {
  await browser.close();
  server?.kill();
}

function srgbToLin(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function measure(png) {
  const { width, height, data } = png;
  let clip = 0, crush = 0, n = 0, sum = 0;
  let hot85 = 0, hot60 = 0;
  const lum = new Float32Array(width * height);
  const hist = new Uint32Array(32);
  // Column profile of luma, so a hard cone edge shows up as a step.
  const cols = new Float64Array(width);
  const colN = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const L = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      const l = L / 255;
      if (l >= 0.98) clip++;
      if (l >= 0.85) hot85++;
      if (l >= 0.60) hot60++;
      if (l <= 0.02) crush++;
      hist[Math.min(31, Math.floor(l * 32))]++;
      lum[y * width + x] = l;
      sum += l; n++;
      cols[x] += l; colN[x]++;
    }
  }
  // Local contrast. A region that is LIT keeps its material detail; a region
  // that has been REPLACED by a flat additive wash has a gradient of ~0.
  let gAll = 0, gAllN = 0, gHot = 0, gHotN = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const g = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + width] - lum[i - width]);
      gAll += g; gAllN++;
      if (lum[i] >= 0.5) { gHot += g; gHotN++; }
    }
  }
  // Largest jump in the column-mean profile (a hard-edged cone reads as a cliff).
  let maxStep = 0, stepX = 0;
  const prof = Array.from(cols, (v, i) => v / colN[i]);
  for (let x = 4; x < width - 4; x++) {
    const d = Math.abs(prof[x + 4] - prof[x - 4]);
    if (d > maxStep) { maxStep = d; stepX = x; }
  }
  return {
    clipped098: +(clip / n).toFixed(5),
    above085: +(hot85 / n).toFixed(5),
    above060: +(hot60 / n).toFixed(5),
    crushed002: +(crush / n).toFixed(5),
    meanLuma: +(sum / n).toFixed(4),
    meanGradient: +(gAll / gAllN).toFixed(5),
    meanGradientBright: +(gHotN ? gHot / gHotN : 0).toFixed(5),
    brightPixels: +(gHotN / gAllN).toFixed(4),
    maxColumnStep: +maxStep.toFixed(4),
    maxColumnStepX: stepX,
    hist32: Array.from(hist, (v) => +(v / n).toFixed(4)),
  };
}

/** Mean / spread inside a rectangle — a flat cream slab has ~zero spread. */
function rectStats(png, x0, y0, x1, y1) {
  const { width, data } = png;
  let n = 0, s = 0, s2 = 0, mn = 1, mx = 0, clip = 0;
  let rr = 0, gg = 0, bb = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const l = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      rr += data[i]; gg += data[i + 1]; bb += data[i + 2];
      s += l; s2 += l * l; n++;
      if (l < mn) mn = l;
      if (l > mx) mx = l;
      if (l >= 0.98) clip++;
    }
  }
  const mean = s / n;
  return {
    mean: +mean.toFixed(4),
    std: +Math.sqrt(Math.max(0, s2 / n - mean * mean)).toFixed(4),
    min: +mn.toFixed(4), max: +mx.toFixed(4),
    clipped: +(clip / n).toFixed(4),
    rgb: [Math.round(rr / n), Math.round(gg / n), Math.round(bb / n)],
  };
}

export { measure, rectStats, srgbToLin };
