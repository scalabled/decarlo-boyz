#!/usr/bin/env node
/**
 * BUILDINGS — winding / normal agreement gate.
 *
 * WHAT WENT WRONG. `wallBasis` built the facade's panel->world matrix from two
 * independent sources that were free to disagree: the +X axis came from the
 * order the footprint's vertices happen to be in (a -> b), and the +Z axis came
 * from `outwardNormal`, which resolves against the CENTROID. `normaliseFootprint`
 * forces every footprint to positive shoelace area, and for that winding the
 * centroid test never flips — so the basis came out with determinant -1 on
 * EVERY elevation of EVERY building in the city. A negative determinant is a
 * mirror: `Accum` carries the vertex normals through the normal matrix (so they
 * stay correct) while the triangle indices are copied unchanged (so the winding
 * reverses). The two then disagree by exactly 180 degrees.
 *
 * The forward pass never noticed, because `src/materials/shader.js` flips the
 * shading normal by `gl_FrontFacing`. The DEFERRED path could not: `render`'s
 * prepass measured every building facade writing a view-space normal of about
 * (-0.72, 0.04, -0.69) — pointing away from the camera that could see it — and
 * had to add `dot(n, viewPos) < 0` as a safety net for it. GTAO, SSR, TAA's
 * normal reconstruction and the contact-shadow term all read that buffer.
 *
 * WHY THIS GATE IS NOT CIRCULAR (ARCHITECTURE.md rule 12). It never calls
 * `outwardNormal`, `wallBasis` or anything else the generator used. It reads the
 * EMITTED BufferGeometry out of the live scene and derives each triangle's
 * normal from its own winding, `cross(b - a, c - a)`, then compares the sign
 * against the normal attribute that shipped with it. The input that makes it
 * fail is a mirrored placement matrix or an inside-out extrusion — which is
 * precisely the defect, and which is what it reported before the fix.
 *
 * It also carries its own control: `world` and `props` geometry is measured the
 * same way in the same frame, and matched the renderer's independent finding
 * that the road and the pavement were correct while the facades were not.
 *
 * NEGATIVE CONTROL (ARCHITECTURE.md rule 12's corollary). With the `wallBasis`
 * fix reverted and nothing else changed:
 *
 *                              reverted            fixed
 *   street  geometry           738 982 / 864 624   0 / 864 624
 *           visible facades     38 081 /  42 890   0 /  42 578
 *           front-face hits         16 /      25   0 /      26
 *           g-buffer guard fired    11 /      15   0 /      17   (dot exactly -1.000)
 *   mill    geometry           570 568 / 707 508   0 / 707 508
 *           visible facades     20 303 /  25 051   0 /  25 162
 *           g-buffer guard fired     1 /      24   0 /      25
 *
 * WHAT THIS GATE STILL CANNOT SEE. `outwardNormal` decides "outward" against
 * the polygon CENTROID, and `wallBasis` now takes the whole frame from that one
 * decision. So a REFLEX corner — a plan that is not convex — produces an
 * elevation that faces into its own building with its winding and its normal in
 * perfect agreement, and every tier here passes it. That is why `shapePlan`'s
 * chamfer, shave and wedge plans are half-plane clips and stay convex; keep
 * them that way, or give `outwardNormal` a real inside test first.
 *
 * The pixel tier closes the loop on the g-buffer itself. It ray-casts the
 * emitted geometry with the same backface rule the rasteriser uses, so it knows
 * which surface the prepass drew and what vertex normal that surface carries,
 * then reads the real g-buffer through `?rview=normal` at the same pixel. If the
 * two disagree in sign, RENDER'S GUARD FIRED at that pixel — i.e. the buffer is
 * only correct because `render` is repairing it. That count going to zero is
 * what makes the guard redundant rather than load-bearing.
 *
 * Usage
 *   node src/buildings/windprobe.mjs
 *   node src/buildings/windprobe.mjs --shot=street,hero
 *   node src/buildings/windprobe.mjs --nopixel        geometry tier only (fast)
 *   node src/buildings/windprobe.mjs --json=/tmp/w.json
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { PNG } from 'pngjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const SHOTS = String(args.shot ?? 'street,hero,mill,skyline').split(',');
const W = Number(args.w ?? 1600);
const H = Number(args.h ?? 900);
const PIXELS = !args.nopixel;

/**
 * RATCHET — 0 is the real goal here, not a high-water mark, and it is reached:
 * a triangle whose winding disagrees with its own normal is unambiguously
 * wrong, there is no content trade-off behind it, and the fix costs nothing.
 * Lower is not possible; never raise this.
 */
const MAX_BAD_FRACTION = 0.0;

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function freePort() {
  for (let i = 0; i < 300; i++) {
    const p = 5900 + Math.floor(Math.random() * 900);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

const PORT = await freePort();
const root = resolve(import.meta.dirname, '../..');
const server = spawn(
  resolve(root, 'node_modules/.bin/vite'),
  ['--port', String(PORT), '--strictPort'],
  { cwd: root, stdio: 'ignore', env: { ...process.env, OW_NO_HMR: '1' } }
);
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 200));
  if (await portOpen(PORT)) break;
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--force-color-profile=srgb',
    '--mute-audio',
    '--js-flags=--max-old-space-size=4096',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

const shotPng = resolve(tmpdir(), `windprobe-${process.pid}.png`);
const reports = [];
let failure = null;
try {
  await page.goto(`http://127.0.0.1:${PORT}/?capture=1&shot=${SHOTS[0]}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });

  for (const shot of SHOTS) {
    await page.evaluate((s) => window.__APPLY_SHOT__?.(s, { grabFrame: 90 }), shot);
    await settle(page);
    const R = await page.evaluate(runProbe, { shot, pixels: PIXELS ? 96 : 0 });
    R.shot = shot;

    if (PIXELS && R.rays.length) {
      R.rayed = R.rays.length;
      R.rays = await samplePixels(page, R.rays, 'depth');
      R.gbuf = R.rays.length ? await samplePixels(page, R.rays, 'normal') : null;
      R.aoPix = R.rays.length ? await samplePixels(page, R.rays, 'ao') : null;
      await page.evaluate(() => {
        const r = window.__ENGINE__.ctx.peek('render');
        if (r) r.debugView = null;
      });
    }
    reports.push(R);
  }
} catch (e) {
  failure = e;
} finally {
  await browser.close();
  server.kill();
  try {
    unlinkSync(shotPng);
  } catch {}
}

if (failure) {
  console.error(`[windprobe] FAILED: ${failure.message}`);
  if (errors.length) console.error(errors.slice(0, 8).join('\n'));
  process.exit(1);
}

if (args.json) {
  mkdirSync(dirname(resolve(String(args.json))), { recursive: true });
  writeFileSync(resolve(String(args.json)), JSON.stringify(reports, null, 2));
}

// ------------------------------------------------------------------ report --
let bad = 0;
const line = (ok, name, detail) => {
  if (!ok) bad++;
  console.log(`  ${ok ? ' ok ' : 'FAIL'} ${name.padEnd(38)} ${detail}`);
};
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(2) + '%' : 'n/a');

for (const R of reports) {
  console.log(`\n=== ${R.shot} ===`);
  console.log(
    `  scene walked: ${R.meshes} meshes / ${fmt(R.tris)} triangles (${R.instances} instanced placements)`
  );
  for (const s of R.subsystems) {
    const tag = s.name === 'buildings' ? '*' : ' ';
    console.log(
      `   ${tag} ${s.name.padEnd(12)} ${fmt(s.tris).padStart(10)} tris   winding-vs-normal disagree ` +
        `${fmt(s.bad).padStart(10)}  ${pct(s.bad, s.tris).padStart(8)}` +
        (s.mirrored ? `   [${s.mirrored} mirrored placements]` : '')
    );
  }

  if (R.worst?.length) {
    console.log('  worst building meshes: ' + R.worst.map(([n, c]) => `${n}=${fmt(c)}`).join('  '));
    for (const s of R.samples ?? []) console.log('    sample bad tri: ' + JSON.stringify(s));
  }
  for (const s of R.visible.worst ?? []) console.log('  backwards facade: ' + JSON.stringify(s));
  const B = R.subsystems.find((s) => s.name === 'buildings') ?? { tris: 0, bad: 0 };
  line(
    B.tris > 0 && B.bad / Math.max(1, B.tris) <= MAX_BAD_FRACTION,
    'buildings: winding agrees with normal',
    `${fmt(B.bad)} of ${fmt(B.tris)} emitted triangles disagree (${pct(B.bad, B.tris)})`
  );
  line(
    R.visible.n > 0 && R.visible.bad === 0,
    'visible facades face the camera',
    `${fmt(R.visible.bad)} of ${fmt(R.visible.n)} facade triangles the camera is outside of are ` +
      `wound away from it (${pct(R.visible.bad, R.visible.n)})`
  );

  if (R.selfCheck?.backwardRays) {
    line(
      false,
      'probe self-check: rays point forward',
      `${R.selfCheck.backwardRays} of ${R.selfCheck.cast} rays had positive view-space z — ` +
        `the PROBE is wrong, not the geometry, and nothing below it means anything`
    );
  }
  if (R.selfCheck?.hit) {
    line(
      R.selfCheck.awayHits === 0,
      'front-facing hits have facing normals',
      `${R.selfCheck.awayHits} of ${R.selfCheck.hit} ray hits passed the front-face winding test ` +
        `while their own normal pointed away from the eye`
    );
  }
  if (PIXELS && !R.gbuf) {
    // Not a failure: `hero` and `skyline` frame open ground and a skyline
    // 400 m off, so there is no near facade under any pixel to read back. It is
    // only a failure if NO shot in the run produced a sample — asserted below.
    console.log(
      `       (no facade pixels in this framing: ${R.rayed ?? 0} facade rays of ` +
        `${R.selfCheck?.cast ?? 0} cast, ${R.selfCheck?.hit ?? 0} hit building geometry)`
    );
  }
  if (R.gbuf) {
    const g = R.gbuf;
    line(
      g.hits > 0 && g.guardFired === 0,
      'g-buffer needs no repair from render',
      `render's dot(n,viewPos) guard fired on ${g.guardFired} of ${g.hits} sampled facade pixels ` +
        `(${R.rayed} facade rays, ${g.hits + g.ambiguous} confirmed by g-buffer depth, ` +
        `${g.ambiguous} dropped as edge-on)`
    );
    line(
      g.hits > 0 && g.awayFromCamera === 0,
      'g-buffer normals face the camera',
      `${g.awayFromCamera} of ${g.hits} sampled facade pixels have view-space n.z <= 0` +
        `; mean n = (${g.mean.map((v) => v.toFixed(2)).join(', ')})`
    );
    for (const sm of g.samples ?? []) console.log('       pixel ' + JSON.stringify(sm));
    if (R.aoPix) {
      console.log(
        `       AO on those facade pixels: min ${R.aoPix.min.toFixed(3)} ` +
          `mean ${R.aoPix.mean.toFixed(3)} max ${R.aoPix.max.toFixed(3)} ` +
          `(${R.aoPix.zero} of ${R.aoPix.hits} read 0.000)`
      );
    }
  }
}

if (PIXELS) {
  const px = reports.reduce((n, R) => n + (R.gbuf?.hits ?? 0), 0);
  line(px > 0, 'the pixel tier measured something', `${px} facade pixels confirmed across ${reports.length} shots`);
}

console.log(bad === 0 ? '\nWINDING GATE PASSED' : `\nWINDING GATE FAILED (${bad} checks)`);
process.exit(bad === 0 ? 0 : 1);

// ------------------------------------------------------------------ harness --
function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

async function settle(p) {
  await p.evaluate(
    () =>
      new Promise((done) => {
        let i = 0;
        const tick = () => {
          if (window.__SETTLED__?.() === true) return done();
          if (++i >= 1500) return done();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })
  );
}

/** Set a debug view, let it land, screenshot, and read the listed pixels back. */
async function samplePixels(p, rays, view) {
  await p.evaluate((v) => {
    const r = window.__ENGINE__.ctx.peek('render');
    if (r) r.debugView = v;
  }, view);
  await p.evaluate(
    (n) =>
      new Promise((d) => {
        let i = 0;
        const t = () => (++i >= n ? d() : requestAnimationFrame(t));
        requestAnimationFrame(t);
      }),
    10
  );
  await p.screenshot({ path: shotPng, type: 'png' });
  const png = PNG.sync.read(readFileSync(shotPng));
  const at = (x, y) => {
    const i = (png.width * y + x) * 4;
    return [png.data[i] / 255, png.data[i + 1] / 255, png.data[i + 2] / 255];
  };
  const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

  if (view === 'depth') {
    /**
     * Keep only the pixels whose g-buffer depth matches the surface this probe
     * ray-cast, within 0.6 m. Without it the sample set silently includes
     * pixels where a parked car, a lamp post, a street tree or a nearer
     * building stands between the camera and the facade the ray found, and the
     * normal comparison then compares a facade's expected normal against
     * whatever else is in front of it. That is not a measurement.
     *
     * `render` writes linear view depth and the debug pass shows fract(d/20),
     * so the comparison is modulo 20 m — which is exactly why it is done
     * against a ray distance this probe already knows.
     */
    const kept = [];
    for (const r of rays) {
      const v = srgbToLin(at(r.px, r.py)[0]);
      const want = (r.viewDepth * 0.05) % 1;
      let d = Math.abs(v - want);
      d = Math.min(d, 1 - d);
      if (d < 0.03) kept.push(r);
    }
    return kept;
  }

  if (view === 'ao') {
    let min = 1;
    let max = 0;
    let sum = 0;
    let zero = 0;
    for (const r of rays) {
      const v = srgbToLin(at(r.px, r.py)[0]);
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
      if (v < 0.002) zero++;
    }
    return { hits: rays.length, min, mean: sum / rays.length, max, zero };
  }

  let guardFired = 0;
  let awayFromCamera = 0;
  let ambiguous = 0;
  let hits = 0;
  const mean = [0, 0, 0];
  const samples = [];
  for (const r of rays) {
    const c = at(r.px, r.py).map(srgbToLin);
    // The debug pass writes decodeNormal(n) * 0.5 + 0.5 through linearToSrgb.
    const n = [c[0] * 2 - 1, c[1] * 2 - 1, c[2] * 2 - 1];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    n[0] /= len;
    n[1] /= len;
    n[2] /= len;
    for (let k = 0; k < 3; k++) mean[k] += n[k] / rays.length;
    // (mean is over every confirmed pixel, ambiguous ones included)
    // `r.nRaster` is the interpolated vertex normal of the surface the
    // rasteriser actually drew at this pixel, in view space, computed here from
    // the emitted geometry. If the g-buffer holds its NEGATION, the only thing
    // that could have done that is render's guard.
    const d = n[0] * r.nRaster[0] + n[1] * r.nRaster[1] + n[2] * r.nRaster[2];
    /**
     * |dot| under 0.2 means the g-buffer is holding a surface roughly
     * PERPENDICULAR to the one this probe ray found — a wall seen edge-on at a
     * similar depth, which the modulo-20 m depth confirmation cannot separate.
     * The probe and the buffer are not looking at the same thing, so neither
     * verdict applies. This cannot hide the defect it is measuring: a fired
     * guard puts the two exactly antiparallel, dot = -1, not 0.
     */
    if (d > -0.2 && d < 0.2) {
      ambiguous++;
      continue;
    }
    hits++;
    if (d < 0) guardFired++;
    if (n[2] <= 0) awayFromCamera++;
    samples.push({
      px: r.px,
      py: r.py,
      dist: r.dist,
      gbuf: n.map((v) => +v.toFixed(3)),
      raster: r.nRaster.map((v) => +v.toFixed(3)),
      dot: +d.toFixed(3),
    });
  }
  return {
    hits,
    ambiguous,
    guardFired,
    awayFromCamera,
    mean,
    samples: samples
      .filter((x) => x.dot < 0)
      .slice(0, 4)
      .concat(samples.slice(0, 3)),
  };
}

// ------------------------------------------------------------------ in page --
function runProbe({ shot, pixels }) {
  const E = window.__ENGINE__;
  const scene = E.ctx.scene;
  const cam = E.camera;
  cam.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);

  // ---- helpers, deliberately hand-rolled: this file must not share any maths
  // ---- with the generator it is auditing.
  const xf = (m, x, y, z, o) => {
    o[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    o[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    o[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    return o;
  };
  const xf3 = (m, x, y, z, o) => {
    o[0] = m[0] * x + m[4] * y + m[8] * z;
    o[1] = m[1] * x + m[5] * y + m[9] * z;
    o[2] = m[2] * x + m[6] * y + m[10] * z;
    return o;
  };
  const det3 = (m) =>
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2]);

  /**
   * Per-GEOMETRY object-space tally: how many triangles have
   * sign(cross(b-a, c-a) . (na+nb+nc)) < 0. Cached by uuid, because a prototype
   * is shared by tens of thousands of instances and the answer cannot depend on
   * which one you ask.
   */
  const NEAR_R = 120;
  const geoCache = new Map();
  function tallyGeometry(geo) {
    const hit = geoCache.get(geo.uuid);
    if (hit) return hit;
    const pa = geo.getAttribute('position');
    const na = geo.getAttribute('normal');
    const out = { tris: 0, bad: 0 };
    if (!pa || !na) {
      geoCache.set(geo.uuid, out);
      return out;
    }
    const P = pa.array;
    const N = na.array;
    const idx = geo.getIndex();
    const I = idx ? idx.array : null;
    const count = I ? I.length : pa.count;
    for (let t = 0; t + 2 < count; t += 3) {
      const a = (I ? I[t] : t) * 3;
      const b = (I ? I[t + 1] : t + 1) * 3;
      const c = (I ? I[t + 2] : t + 2) * 3;
      const abx = P[b] - P[a];
      const aby = P[b + 1] - P[a + 1];
      const abz = P[b + 2] - P[a + 2];
      const acx = P[c] - P[a];
      const acy = P[c + 1] - P[a + 1];
      const acz = P[c + 2] - P[a + 2];
      const gx = aby * acz - abz * acy;
      const gy = abz * acx - abx * acz;
      const gz = abx * acy - aby * acx;
      if (gx * gx + gy * gy + gz * gz < 1e-16) continue; // degenerate sliver
      const vx = N[a] + N[b] + N[c];
      const vy = N[a + 1] + N[b + 1] + N[c + 1];
      const vz = N[a + 2] + N[b + 2] + N[c + 2];
      if (vx * vx + vy * vy + vz * vz < 1e-12) continue; // no usable normal
      out.tris++;
      if (gx * vx + gy * vy + gz * vz < 0) out.bad++;
    }
    geoCache.set(geo.uuid, out);
    return out;
  }

  // A mirrored placement re-winds every triangle it carries, so an object-space
  // verdict inverts wholesale under a negative determinant.
  const verdict = (tally, det) => (det < 0 ? tally.tris - tally.bad : tally.bad);

  // ---- which subsystem does a mesh belong to -------------------------------
  const subs = new Map();
  const offenders = new Map();
  const bump = (name, tris, badN, mirrored, mesh) => {
    let s = subs.get(name);
    if (!s) subs.set(name, (s = { name, tris: 0, bad: 0, mirrored: 0, meshes: 0 }));
    s.tris += tris;
    s.bad += badN;
    s.mirrored += mirrored;
    s.meshes++;
    if (badN > 0 && name === 'buildings') {
      const k = mesh || '(unnamed)';
      offenders.set(k, (offenders.get(k) ?? 0) + badN);
    }
  };

  let meshes = 0;
  let tris = 0;
  let instances = 0;
  const nearFacade = []; // world-space triangles near the camera, for the ray tier
  const camPos = [cam.matrixWorld.elements[12], cam.matrixWorld.elements[13], cam.matrixWorld.elements[14]];

  for (const top of scene.children) {
    const name = top.name || top.type.toLowerCase();
    top.traverseVisible((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (o.material && o.material.visible === false) return;
      const tally = tallyGeometry(o.geometry);
      if (!tally.tris) return;
      meshes++;
      if (o.isInstancedMesh) {
        const el = o.instanceMatrix.array;
        const world = o.matrixWorld.elements;
        const wd = det3(world);
        let bd = 0;
        let mir = 0;
        for (let i = 0; i < o.count; i++) {
          const m = el.subarray(i * 16, i * 16 + 16);
          const d = det3(m) * wd;
          if (d < 0) mir++;
          bd += verdict(tally, d);
        }
        instances += o.count;
        tris += tally.tris * o.count;
        bump(name, tally.tris * o.count, bd, mir, o.name);
      } else {
        const d = det3(o.matrixWorld.elements);
        tris += tally.tris;
        bump(name, tally.tris, verdict(tally, d), d < 0 ? 1 : 0, o.name);
        if (name === 'buildings') collectNear(o, camPos, nearFacade);
      }
    });
  }

  /**
   * World-space triangle soup within `NEAR_R` of the camera. Used for the "a
   * wall you can see must be wound towards you" tier and for the pixel
   * ray-casts. 120 m because a downtown avenue is wider than a rowhouse street
   * and at 70 m the `hero` framing found no facade to sample at all.
   */
  function collectNear(mesh, cp, sink) {
    const geo = mesh.geometry;
    if (geo.boundingSphere === null) geo.computeBoundingSphere();
    const bs = geo.boundingSphere;
    const m = mesh.matrixWorld.elements;
    const cw = xf(m, bs.center.x, bs.center.y, bs.center.z, [0, 0, 0]);
    const scale = Math.max(
      Math.hypot(m[0], m[1], m[2]),
      Math.hypot(m[4], m[5], m[6]),
      Math.hypot(m[8], m[9], m[10])
    );
    if (Math.hypot(cw[0] - cp[0], cw[1] - cp[1], cw[2] - cp[2]) > bs.radius * scale + NEAR_R) return;
    const pa = geo.getAttribute('position');
    const na = geo.getAttribute('normal');
    const idx = geo.getIndex();
    if (!pa || !na || !idx) return;
    const P = pa.array;
    const N = na.array;
    const I = idx.array;
    const A = [0, 0, 0];
    const Bv = [0, 0, 0];
    const C = [0, 0, 0];
    const nA = [0, 0, 0];
    const nB = [0, 0, 0];
    const nC = [0, 0, 0];
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a = I[t] * 3;
      const b = I[t + 1] * 3;
      const c = I[t + 2] * 3;
      xf(m, P[a], P[a + 1], P[a + 2], A);
      const dx = A[0] - cp[0];
      const dy = A[1] - cp[1];
      const dz = A[2] - cp[2];
      if (dx * dx + dy * dy + dz * dz > NEAR_R * NEAR_R) continue;
      xf(m, P[b], P[b + 1], P[b + 2], Bv);
      xf(m, P[c], P[c + 1], P[c + 2], C);
      xf3(m, N[a], N[a + 1], N[a + 2], nA);
      xf3(m, N[b], N[b + 1], N[b + 2], nB);
      xf3(m, N[c], N[c + 1], N[c + 2], nC);
      sink.push([
        A[0], A[1], A[2], Bv[0], Bv[1], Bv[2], C[0], C[1], C[2],
        nA[0], nA[1], nA[2], nB[0], nB[1], nB[2], nC[0], nC[1], nC[2],
      ]);
    }
  }

  // ---- locate a few offenders, in world space, for the write-up -----------
  const samples = [];
  const bldRoot = scene.getObjectByName('buildings');
  if (bldRoot) {
    bldRoot.traverseVisible((o) => {
      if (samples.length >= 8 || !o.isMesh || !o.geometry || o.isInstancedMesh) return;
      const geo = o.geometry;
      const pa = geo.getAttribute('position');
      const na = geo.getAttribute('normal');
      const idx = geo.getIndex();
      if (!pa || !na || !idx) return;
      const P = pa.array;
      const N = na.array;
      const I = idx.array;
      const m = o.matrixWorld.elements;
      const A = [0, 0, 0];
      const Bv = [0, 0, 0];
      const C = [0, 0, 0];
      const vn = [0, 0, 0];
      for (let t = 0; t + 2 < I.length && samples.length < 8; t += 3) {
        const a = I[t] * 3;
        const b = I[t + 1] * 3;
        const c = I[t + 2] * 3;
        xf(m, P[a], P[a + 1], P[a + 2], A);
        xf(m, P[b], P[b + 1], P[b + 2], Bv);
        xf(m, P[c], P[c + 1], P[c + 2], C);
        const gx = (Bv[1] - A[1]) * (C[2] - A[2]) - (Bv[2] - A[2]) * (C[1] - A[1]);
        const gy = (Bv[2] - A[2]) * (C[0] - A[0]) - (Bv[0] - A[0]) * (C[2] - A[2]);
        const gz = (Bv[0] - A[0]) * (C[1] - A[1]) - (Bv[1] - A[1]) * (C[0] - A[0]);
        const gl = Math.hypot(gx, gy, gz);
        if (gl < 1e-7) continue;
        xf3(m, N[a] + N[b] + N[c], N[a + 1] + N[b + 1] + N[c + 1], N[a + 2] + N[b + 2] + N[c + 2], vn);
        const vl = Math.hypot(vn[0], vn[1], vn[2]);
        if (vl < 1e-6) continue;
        if ((gx * vn[0] + gy * vn[1] + gz * vn[2]) / (gl * vl) < 0) {
          samples.push({
            mesh: o.name,
            at: [+((A[0] + Bv[0] + C[0]) / 3).toFixed(1), +((A[1] + Bv[1] + C[1]) / 3).toFixed(1), +((A[2] + Bv[2] + C[2]) / 3).toFixed(1)],
            wind: [+(gx / gl).toFixed(2), +(gy / gl).toFixed(2), +(gz / gl).toFixed(2)],
            nrm: [+(vn[0] / vl).toFixed(2), +(vn[1] / vl).toFixed(2), +(vn[2] / vl).toFixed(2)],
            edge: [+Math.hypot(Bv[0] - A[0], Bv[1] - A[1], Bv[2] - A[2]).toFixed(2), +Math.hypot(C[0] - A[0], C[1] - A[1], C[2] - A[2]).toFixed(2)],
          });
        }
      }
    });
  }

  // ---- tier 2: a wall the camera stands outside of must be wound towards it --
  const visible = { n: 0, bad: 0, worst: null };
  for (const T of nearFacade) {
    const abx = T[3] - T[0];
    const aby = T[4] - T[1];
    const abz = T[5] - T[2];
    const acx = T[6] - T[0];
    const acy = T[7] - T[1];
    const acz = T[8] - T[2];
    const gx = aby * acz - abz * acy;
    const gy = abz * acx - abx * acz;
    const gz = abx * acy - aby * acx;
    const gl = Math.hypot(gx, gy, gz);
    if (gl < 1e-7) continue;
    const cx = (T[0] + T[3] + T[6]) / 3;
    const cy = (T[1] + T[4] + T[7]) / 3;
    const cz = (T[2] + T[5] + T[8]) / 3;
    const ex = camPos[0] - cx;
    const ey = camPos[1] - cy;
    const ez = camPos[2] - cz;
    // vertical-ish: this is a facade, not a roof deck or a pavement slab
    if (Math.abs(gy / gl) > 0.5) continue;
    const vx = T[9] + T[12] + T[15];
    const vy = T[10] + T[13] + T[16];
    const vz = T[11] + T[14] + T[17];
    const vl = Math.hypot(vx, vy, vz);
    const el = Math.hypot(ex, ey, ez);
    if (vl < 1e-6 || el < 1e-6) continue;
    /**
     * The camera must be on the OUTSIDE of this wall according to the shipped
     * normal, and PLAINLY so — this tier asks about elevations you can see,
     * not about the silhouette.
     *
     * The deadband is 0.18 (about 10 degrees off edge-on) for a reason that is
     * measurable rather than taste. `wallPanel` chamfers every arris at 22 mm
     * and `computeVertexNormals` averages across those corners, so a face
     * normal and its own vertex normals legitimately differ by up to about 8
     * degrees on the reveal strips. Inside that band the two tests can land
     * either side of an eye vector that is nearly in the wall plane, and the
     * disagreement is smoothing, not inversion: measured, all three survivors
     * in the `street` frame had winding and normal agreeing to a dot product of
     * 0.99 while the eye vector was 3-4 degrees off the plane.
     *
     * It cannot flatter the result. The defect this tier reproduces puts the
     * eye vector 25-60 degrees off the wall plane with the winding pointing the
     * other way; reverted, the tier still reads 92%.
     */
    if ((vx * ex + vy * ey + vz * ez) / (vl * el) <= 0.18) continue;
    visible.n++;
    // ...and the winding must not point away by that same clear margin. The
    // defect this reproduces is a 180-degree inversion, not a rounding call on
    // a silhouette sliver, and the deadband is symmetric so it cannot flatter
    // the result: reverted, this tier still reads 92%.
    if ((gx * ex + gy * ey + gz * ez) / (gl * el) < -0.05) {
      visible.bad++;
      if (!visible.worst) visible.worst = [];
      if (visible.worst.length < 6) {
        const l = Math.hypot(vx, vy, vz) || 1;
        visible.worst.push({
          area: +(gl * 0.5).toFixed(4),
          dNv: +((vx * ex + vy * ey + vz * ez) / (l * Math.hypot(ex, ey, ez))).toFixed(3),
          dGv: +((gx * ex + gy * ey + gz * ez) / (gl * Math.hypot(ex, ey, ez))).toFixed(3),
          dGN: +((gx * vx + gy * vy + gz * vz) / (gl * l)).toFixed(3),
          dist: +Math.hypot(ex, ey, ez).toFixed(1),
          at: [+cx.toFixed(1), +cy.toFixed(1), +cz.toFixed(1)],
          winding: [+(gx / gl).toFixed(2), +(gy / gl).toFixed(2), +(gz / gl).toFixed(2)],
          normal: [+(vx / l).toFixed(2), +(vy / l).toFixed(2), +(vz / l).toFixed(2)],
        });
      }
    }
  }

  // ---- tier 3: rays, for the pixel comparison ------------------------------
  //
  // Backface culling is applied exactly as the rasteriser applies it (the
  // facade materials are FrontSide), so the hit this returns is the surface the
  // prepass actually shaded — which is the only surface whose vertex normal the
  // g-buffer could be holding.
  const rays = [];
  const selfCheck = { backwardRays: 0, awayHits: 0, cast: 0, hit: 0, flat: 0, nearTris: 0 };
  selfCheck.nearTris = nearFacade.length;
  if (pixels > 0 && nearFacade.length) {
    const camWorld = cam.matrixWorld.elements;
    const view = cam.matrixWorldInverse.elements;
    const W = window.innerWidth;
    const Hh = window.innerHeight;
    const cols = 16;
    const rows = Math.max(1, Math.round(pixels / cols));
    for (let ry = 0; ry < rows && rays.length < pixels; ry++) {
      for (let rx = 0; rx < cols && rays.length < pixels; rx++) {
        const ndcX = ((rx + 0.5) / cols) * 2 - 1;
        const ndcY = 1 - ((ry + 0.5) / rows) * 2;
        /**
         * Build the ray from the FOV, NOT by unprojecting through
         * `projectionMatrixInverse`.
         *
         * `render` runs a REVERSED-Z depth buffer (ARCHITECTURE.md rule 11), so
         * ndc z = -1 is not the near plane — unprojecting there puts the point
         * BEHIND the eye and every ray this probe cast pointed backwards. It
         * still found triangles and still looked plausible, which is exactly
         * the kind of quiet wrongness the geometry tier is here to avoid: the
         * ray-space view direction came back with view-space z of +0.75 when
         * a camera looking down -Z can only ever produce a negative one.
         */
        const tanHalf = Math.tan(((cam.fov ?? 60) * Math.PI) / 360);
        const aspect = cam.aspect || W / Hh;
        const dv = [ndcX * tanHalf * aspect, ndcY * tanHalf, -1];
        const dw = xf3(camWorld, dv[0], dv[1], dv[2], [0, 0, 0]);
        const dl = Math.hypot(dw[0], dw[1], dw[2]) || 1;
        dw[0] /= dl;
        dw[1] /= dl;
        dw[2] /= dl;

        selfCheck.cast++;
        let best = Infinity;
        let bestT = null;
        let bestUV = null;
        for (const T of nearFacade) {
          const e1x = T[3] - T[0];
          const e1y = T[4] - T[1];
          const e1z = T[5] - T[2];
          const e2x = T[6] - T[0];
          const e2y = T[7] - T[1];
          const e2z = T[8] - T[2];
          const px = dw[1] * e2z - dw[2] * e2y;
          const py = dw[2] * e2x - dw[0] * e2z;
          const pz = dw[0] * e2y - dw[1] * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det <= 1e-9) continue; // <= keeps only front-facing, like FrontSide
          const inv = 1 / det;
          const tx = camPos[0] - T[0];
          const ty = camPos[1] - T[1];
          const tz = camPos[2] - T[2];
          const u = (tx * px + ty * py + tz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = ty * e1z - tz * e1y;
          const qy = tz * e1x - tx * e1z;
          const qz = tx * e1y - ty * e1x;
          const v = (dw[0] * qx + dw[1] * qy + dw[2] * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (dist > 0.05 && dist < best) {
            best = dist;
            bestT = T;
            bestUV = [u, v];
          }
        }
        if (!bestT) continue;
        selfCheck.hit++;
        const [u, v] = bestUV;
        const w = 1 - u - v;
        // interpolated vertex normal of the surface the rasteriser drew
        let nx = bestT[9] * w + bestT[12] * u + bestT[15] * v;
        let ny = bestT[10] * w + bestT[13] * u + bestT[16] * v;
        let nz = bestT[11] * w + bestT[14] * u + bestT[17] * v;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        const nView = xf3(view, nx, ny, nz, [0, 0, 0]);
        const nvl = Math.hypot(nView[0], nView[1], nView[2]) || 1;
        // only keep near-vertical surfaces: this is a facade sample set
        if (Math.abs(ny) > 0.6) {
          selfCheck.flat++;
          continue;
        }
        // View-space depth of the hit, so the harness can prove the pixel it
        // reads back is showing THIS surface and not something in front of it.
        const fx = -camWorld[8];
        const fy = -camWorld[9];
        const fz = -camWorld[10];
        const fl = Math.hypot(fx, fy, fz) || 1;
        const viewDepth = (dw[0] * fx + dw[1] * fy + dw[2] * fz) * (best / fl);
        /**
         * Probe self-check. A camera looks down its own -Z, so every ray this
         * builds must have a NEGATIVE view-space z; and every hit accepted by
         * the front-face test must have its normal turned towards the eye.
         * Both held while the rays were being built backwards off a reversed-Z
         * projection matrix — the first because it was measured as a magnitude,
         * the second because it was measured against the same backwards ray.
         * They are reported, not assumed.
         */
        const dirView = xf3(view, dw[0], dw[1], dw[2], [0, 0, 0]);
        if (dirView[2] >= 0) selfCheck.backwardRays++;
        if (nx * dw[0] + ny * dw[1] + nz * dw[2] >= 0) selfCheck.awayHits++;
        rays.push({
          px: Math.min(W - 1, Math.max(0, Math.round(((ndcX + 1) / 2) * W))),
          py: Math.min(Hh - 1, Math.max(0, Math.round(((1 - ndcY) / 2) * Hh))),
          dist: +best.toFixed(2),
          viewDepth,
          nRaster: [nView[0] / nvl, nView[1] / nvl, nView[2] / nvl],
        });
      }
    }
  }

  const list = [...subs.values()].sort((a, b) => b.tris - a.tris);
  const worst = [...offenders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  return { shot, meshes, tris, instances, subsystems: list, visible, rays, worst, samples, selfCheck };
}
