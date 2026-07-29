#!/usr/bin/env node
/**
 * PED LIGHT PROBE — "does a pedestrian receive the city's indirect light?"
 *
 * THE DEFECT: at 21:21 overcast a pedestrian is a featureless black silhouette
 * standing on clearly-lit pavement, and raising the whole city's indirect
 * budget does not move him. Measured across a 2.3x ambient sweep, the pavement
 * one metre away went 46.7 -> 108.1 code values while the ped went 6.2 -> 8.4.
 *
 * This reproduces that mechanically, and the sample rects are DERIVED FROM THE
 * REAL GEOMETRY rather than eyeballed off a screenshot:
 *
 *   1. stage a crowd in front of a fixed camera at 21:21 overcast,
 *   2. pick the nearest skinned `ped_body`, project its torso and the pavement
 *      one metre in front of its feet into screen space,
 *   3. sweep the engine's indirect budget — `owFillGain` (the analytic sky and
 *      ground bands) and `owIndirect.x` (the PMREM diffuse budget), i.e. every
 *      indirect term `render` publishes — over a fixed set of multipliers,
 *   4. read HDR scene radiance (pre-tonemap, exposure independent) and the
 *      final 8-bit code value of both rects at every step.
 *
 * The pass condition is a RATIO, not a level: over the sweep the ped's radiance
 * must track the pavement's. `--gate` fails if the ped moves by less than
 * `--minTrack` (default 0.75) of the pavement's change, in stops.
 *
 *   node src/peds/lightprobe.mjs
 *   node src/peds/lightprobe.mjs --gate
 *   node src/peds/lightprobe.mjs --png=shots/peds/sweep   # dump every step
 *   node src/peds/lightprobe.mjs --mark                   # draw the sample rects
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import net from 'node:net';
import { PNG } from 'pngjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const ROOT = resolve(import.meta.dirname, '../..');
const W = Number(args.w ?? 1280);
const H = Number(args.h ?? 720);
const HOUR = Number(args.hour ?? 21.35);
const GAINS = String(args.gains ?? '1,1.6,2.3,3.2').split(',').map(Number);
const MIN_TRACK = Number(args.minTrack ?? 0.75);

const portOpen = (p) =>
  new Promise((res) => {
    const s = net.connect({ port: p, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function freePort() {
  for (let i = 0; i < 200; i++) {
    const p = 5900 + Math.floor(Math.random() * 90);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

const PORT = args.port ? Number(args.port) : await freePort();
let server = null;
if (!(await portOpen(PORT))) {
  server = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, OW_NO_HMR: '1' },
  });
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(PORT)) break;
  }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/?capture=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

/* ---------------------------------------------------------------- */
/* stage: a fixed camera, 21:21 overcast, a crowd in front of it     */
/* ---------------------------------------------------------------- */
await page.evaluate(
  ({ hour }) => {
    const e = window.__ENGINE__;
    window.__APPLY_SHOT__(
      JSON.stringify({ pos: [-200, 4, 90], look: [-240, 3, 30], fov: 55, time: hour, ground: true }),
      { grabFrame: 60 }
    );
    const sky = e.ctx.peek('sky');
    sky.setAutoWeather?.(false);
    sky.snapWeather?.('overcast');
    sky.setTimeRate?.(0);
    sky.setTimeOfDay?.(hour);
  },
  { hour: HOUR }
);
await page.evaluate(
  () => new Promise((d) => { let i = 0; const t = () => (window.__SETTLED__?.() || ++i > 900 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); })
);
await pump(90);
await page.evaluate(() => window.__ENGINE__.ctx.peek('peds')?.debugStage?.('crowd'));
await pump(60);
// FREEZE the crowd. They walk, and a sample rect derived from a pose is only
// valid for that pose — the first version of this probe measured pavement and
// reported it as a pedestrian.
await page.evaluate(() => {
  const peds = window.__ENGINE__.ctx.peek('peds');
  peds.update = () => {};
  peds.lateUpdate = () => {};
  peds.fixedUpdate = () => {};
});
await pump(10);

/* ---------------------------------------------------------------- */
/* pick a subject and derive both sample rects from real geometry    */
/* ---------------------------------------------------------------- */
const subject = await page.evaluate(() => {
  const e = window.__ENGINE__;
  const peds = e.ctx.peek('peds');
  const cam = e.camera;
  cam.updateMatrixWorld(true);
  const q = cam.quaternion;
  const rot = (v) => {
    const { x, y, z, w } = q;
    const ix = w * v.x + y * v.z - z * v.y;
    const iy = w * v.y + z * v.x - x * v.z;
    const iz = w * v.z + x * v.y - y * v.x;
    const iw = -x * v.x - y * v.y - z * v.z;
    return {
      x: ix * w + iw * -x + iy * -z - iz * -y,
      y: iy * w + iw * -y + iz * -x - ix * -z,
      z: iz * w + iw * -z + ix * -y - iy * -x,
    };
  };
  const F = rot({ x: 0, y: 0, z: -1 });

  const cands = [];
  for (const p of peds.live ?? []) {
    if (!p.body || !p.body.group.visible) continue;
    const dx = p.position.x - cam.position.x;
    const dz = p.position.z - cam.position.z;
    const depth = dx * F.x + dz * F.z;
    if (depth < 5 || depth > 26) continue;
    const lat = Math.abs(dx * F.z - dz * F.x);
    if (lat > depth * 0.30) continue;
    cands.push({ p, depth, dx, dz });
  }
  cands.sort((a, b) => a.depth - b.depth);
  if (!cands.length) return { error: 'no staged ped with a body in 5..26 m near frame centre' };

  const project = (x, y, z) => {
    const m = cam.projectionMatrix.elements;
    const vm = cam.matrixWorldInverse.elements;
    const vx = vm[0] * x + vm[4] * y + vm[8] * z + vm[12];
    const vy = vm[1] * x + vm[5] * y + vm[9] * z + vm[13];
    const vz = vm[2] * x + vm[6] * y + vm[10] * z + vm[14];
    const cx = m[0] * vx + m[4] * vy + m[8] * vz + m[12];
    const cy = m[1] * vx + m[5] * vy + m[9] * vz + m[13];
    const cw = m[3] * vx + m[7] * vy + m[11] * vz + m[15];
    return { u: (cx / cw) * 0.5 + 0.5, v: 0.5 - (cy / cw) * 0.5, w: cw };
  };

  // The rect comes off the ACTUAL POSED SKELETON, not off the ped's root and a
  // guessed height: `Spine1` is mid-torso in every outfit and every stance, so
  // the sample cannot slide off the body when the pose changes.
  const out = [];
  for (const c of cands) {
    const ped = c.p;
    const body = ped.body;
    body.group.updateMatrixWorld(true);
    const bone = (n) => {
      const b = body.bones[body.bones.findIndex((x) => x.name === n)];
      b.updateWorldMatrix(true, false);
      const e = b.matrixWorld.elements;
      return { x: e[12], y: e[13], z: e[14] };
    };
    const spine = bone('Spine1');
    const headB = bone('Head');
    const px = ped.position.x, py = ped.position.y, pz = ped.position.z;
    const chest = project(spine.x, spine.y, spine.z);
    const head = project(headB.x, headB.y, headB.z);
    const feet = project(px, py + 0.02, pz);
    const span = Math.abs(feet.v - head.v);
    // torso half-width: a torso is ~0.16 of standing height wide, so 0.045 of
    // the head-to-foot screen span is inside the silhouette at any yaw.
    const hw = span * 0.045;
    const hh = span * 0.055;
    const inv = 1 / Math.hypot(c.dx, c.dz);
    const nx = -c.dx * inv, nz = -c.dz * inv;
    const g = project(px + nx * 1.0, py + 0.01, pz + nz * 1.0);
    const gw = span * 0.09;
    if (chest.u - hw < 0.02 || chest.u + hw > 0.98 || chest.v - hh < 0.02 || chest.v + hh > 0.98) continue;
    if (g.u - gw < 0.02 || g.u + gw > 0.98 || g.v + gw > 0.98) continue;
    out.push({
      depth: c.depth,
      shape: ped.outfit?.shape ?? null,
      chestRect: [chest.u - hw, chest.v - hh, chest.u + hw, chest.v + hh],
      groundRect: [g.u - gw, g.v - gw * 0.5, g.u + gw, g.v + gw * 0.5],
      palette: body.palette.value.map((c2) => [+c2.r.toFixed(4), +c2.g.toFixed(4), +c2.b.toFixed(4)]),
    });
  }

  const body0 = cands[0].p.body;
  const mats = Array.isArray(body0.mesh.material) ? body0.mesh.material : [body0.mesh.material];
  const materials = mats.map((m) => ({
    name: m.name,
    metalness: m.metalness,
    roughness: m.roughness,
    envMapIntensity: m.envMapIntensity,
    aoMapIntensity: m.aoMapIntensity,
    hasEnvMap: !!m.envMap,
    cacheKey: typeof m.customProgramCacheKey === 'function' ? m.customProgramCacheKey() : null,
    patched: typeof m.customProgramCacheKey === 'function'
      ? String(m.customProgramCacheKey()).includes('ow-patch') : false,
  }));
  return { subjects: out, materials };
});

if (subject.error || !subject.subjects?.length) {
  console.error('probe failed:', subject.error ?? 'no usable subjects');
  await browser.close();
  if (server) server.kill();
  process.exit(2);
}

const SUBJ = subject.subjects.slice(0, Number(args.n ?? 10));
console.log(`${SUBJ.length} pedestrians in frame at ${SUBJ[0].depth.toFixed(1)}..${SUBJ[SUBJ.length - 1].depth.toFixed(1)} m`);
for (const m of subject.materials) {
  console.log(
    `  ${String(m.name).padEnd(10)} metalness=${m.metalness} roughness=${m.roughness} ` +
      `envMapIntensity=${m.envMapIntensity} ownEnvMap=${m.hasEnvMap} patched=${m.patched}`
  );
}
if (args.diag) {
  for (const m of subject.materials) console.log(`    key ${m.name}: ${m.cacheKey}`);
  for (const s of SUBJ) console.log(`  ${s.shape} palette: ${JSON.stringify(s.palette)}`);
}

/* install the indirect-budget knob (a measurement hook, not an engine change) */
await page.evaluate(() => {
  const r = window.__ENGINE__.ctx.get('render');
  if (!r.__pedProbeFill) {
    r.__pedProbeFill = r._updateBounceFill;
    r.__pedProbeGain = 1;
    r._updateBounceFill = function () {
      r.__pedProbeFill.call(this);
      const g = r.__pedProbeGain;
      this.patcher.uniforms.owFillGain.value.set(g, g);
      this.patcher.uniforms.owIndirect.value.x *= g;
    };
  }
});

/* ---------------------------------------------------------------- */
/* the sweep                                                         */
/* ---------------------------------------------------------------- */
const L = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const rows = [];
for (const gain of GAINS) {
  await page.evaluate((g) => { window.__ENGINE__.ctx.get('render').__pedProbeGain = g; }, gain);
  await pump(50);

  const hdr = await page.evaluate((subs) => {
    const r = window.__ENGINE__.ctx.get('render');
    const u = r.patcher.uniforms;
    return {
      peds: subs.map((s) => r.probeHdr(s.chestRect[0], s.chestRect[1], s.chestRect[2], s.chestRect[3])),
      pavs: subs.map((s) => r.probeHdr(s.groundRect[0], s.groundRect[1], s.groundRect[2], s.groundRect[3])),
      skyFill: [...u.owSkyFill.value.toArray()],
      ibl: u.owIndirect.value.x,
    };
  }, SUBJ);

  const shotBuf = await page.screenshot({ type: 'png' });
  const png = PNG.sync.read(shotBuf);
  const rectPx = (rect) => [
    Math.max(0, Math.round(rect[0] * png.width)),
    Math.max(0, Math.round(rect[1] * png.height)),
    Math.min(png.width, Math.round(rect[2] * png.width)),
    Math.min(png.height, Math.round(rect[3] * png.height)),
  ];
  const readRect = (rect) => {
    const [x0, y0, x1, y1] = rectPx(rect);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * png.width + x) * 4;
        r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
      }
    }
    n = Math.max(1, n);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / n;
  };
  // READ BEFORE MARKING. The marker writes its border into the same buffer, and
  // on a 23x14 rect the border is 22% of the pixels — enough to move the
  // pavement sample by 40 code values and invert the comparison. That bug made
  // the first run of this probe report a pedestrian darker than the road.
  const pedCodes = SUBJ.map((s) => readRect(s.chestRect));
  const pavCodes = SUBJ.map((s) => readRect(s.groundRect));
  if (args.png || args.mark) {
    if (args.mark) {
      const paint = (rect, col) => {
        const [x0, y0, x1, y1] = rectPx(rect);
        for (let x = x0; x < x1; x++) for (const y of [y0, y1 - 1]) {
          const i = (y * png.width + x) * 4;
          png.data[i] = col[0]; png.data[i + 1] = col[1]; png.data[i + 2] = col[2];
        }
        for (let y = y0; y < y1; y++) for (const x of [x0, x1 - 1]) {
          const i = (y * png.width + x) * 4;
          png.data[i] = col[0]; png.data[i + 1] = col[1]; png.data[i + 2] = col[2];
        }
      };
      for (const s of SUBJ) { paint(s.chestRect, [255, 0, 0]); paint(s.groundRect, [0, 255, 0]); }
    }
    const out = resolve(ROOT, `${args.png ?? 'shots/peds/sweep'}-${String(gain).replace('.', 'p')}.png`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, args.mark ? PNG.sync.write(png) : shotBuf);
  }

  rows.push({
    gain,
    pedHdr: median(hdr.peds.map(L)),
    pavHdr: median(hdr.pavs.map(L)),
    pedHdrMin: Math.min(...hdr.peds.map(L)),
    pedCode: median(pedCodes),
    pavCode: median(pavCodes),
    pedCodeMin: Math.min(...pedCodes),
    skyFill: hdr.skyFill,
    ibl: hdr.ibl,
  });
}

console.log(`\nindirect skyFill  iblBudget  ped HDR    pav HDR    ped code  pav code  darkest ped`);
for (const r of rows) {
  console.log(
    `x${String(r.gain).padEnd(7)} ${r.skyFill[0].toFixed(4).padStart(7)}  ${r.ibl.toFixed(3).padStart(8)}  ` +
      `${r.pedHdr.toFixed(5).padStart(9)}  ${r.pavHdr.toFixed(5).padStart(9)}  ` +
      `${r.pedCode.toFixed(1).padStart(8)}  ${r.pavCode.toFixed(1).padStart(8)}  ` +
      `${r.pedCodeMin.toFixed(1).padStart(8)}`
  );
}

const a = rows[0];
const b = rows[rows.length - 1];
const pedStops = Math.log2(Math.max(b.pedHdr, 1e-9) / Math.max(a.pedHdr, 1e-9));
const pavStops = Math.log2(Math.max(b.pavHdr, 1e-9) / Math.max(a.pavHdr, 1e-9));
const track = pavStops > 1e-3 ? pedStops / pavStops : 1;
console.log(
  `\nover the sweep (median of ${SUBJ.length} peds): pavement +${pavStops.toFixed(2)} stops, ` +
    `ped +${pedStops.toFixed(2)} stops -> the ped tracks ${(track * 100).toFixed(0)}% ` +
    `of the indirect budget (want >= ${(MIN_TRACK * 100).toFixed(0)}%)`
);
console.log(
  `code values: ped ${a.pedCode.toFixed(1)} -> ${b.pedCode.toFixed(1)}, ` +
    `pavement ${a.pavCode.toFixed(1)} -> ${b.pavCode.toFixed(1)}, ` +
    `darkest ped ${a.pedCodeMin.toFixed(1)} -> ${b.pedCodeMin.toFixed(1)}`
);
console.log(
  `ped:pavement at x1 = ${Math.log2(Math.max(a.pedHdr, 1e-9) / Math.max(a.pavHdr, 1e-9)).toFixed(2)} stops`
);
if (errs.length) console.log(`page errors: ${errs.slice(0, 3).join(' | ')}`);

await browser.close();
if (server) server.kill();

if (args.gate) {
  const ok = track >= MIN_TRACK;
  console.log(ok ? 'PASS — pedestrians receive the indirect budget' : 'FAIL — pedestrians ignore the indirect budget');
  process.exit(ok ? 0 : 1);
}
