#!/usr/bin/env node
/**
 * BUILDINGS — skyline impostor gate.
 *
 * A screenshot can show you a box hanging in the sky; it cannot tell you WHICH
 * instance it is or how many more of them are out there. This boots the real
 * engine, poses a shot so the city streams around it, and then asserts on the
 * impostor field itself:
 *
 *   grounded    every VISIBLE instance's base plane must sit within tolerance
 *               of `world` terrain sampled across its own FOOTPRINT — not at
 *               its centre. Sampling at the centre is what the placement code
 *               already does, so a centre-only check is vacuous: it compares a
 *               number to itself and can never fail.
 *   supported   no sub-mass of the prototype may hang with nothing under it:
 *               connected components are transformed to world space and each
 *               must either stand on the base plane or overlap another
 *               component in XZ that reaches its underside.
 *   exclusive   no visible instance may stand where a streamed tile has built
 *               real geometry.
 *   sane        heights must be inside the range the generator claims.
 *
 * Usage
 *   node src/buildings/skyprobe.mjs
 *   node src/buildings/skyprobe.mjs --shot=searchlight_side
 *   node src/buildings/skyprobe.mjs --shot=searchlight_side --pixel=300,200
 *   node src/buildings/skyprobe.mjs --json=/tmp/sky.json
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const SHOTS = String(args.shot ?? 'skyline,farview,hero,night,bridge,searchlight_side').split(',');
const PIXEL = args.pixel ? String(args.pixel).split(',').map(Number) : null;
const W = Number(args.w ?? 1920);
const H = Number(args.h ?? 1080);

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
const server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
  env: { ...process.env, OW_NO_HMR: '1' },
});
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 200));
  if (await portOpen(PORT)) break;
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--js-flags=--max-old-space-size=4096'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

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
    await page.evaluate(
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
    const r = await page.evaluate(runProbe, { shot, pixel: PIXEL });
    reports.push(r);
  }
} catch (e) {
  failure = e;
} finally {
  await browser.close();
  server.kill();
}

if (failure) {
  console.error(`[skyprobe] FAILED: ${failure.message}`);
  if (errors.length) console.error(errors.slice(0, 8).join('\n'));
  process.exit(1);
}

if (args.json) {
  mkdirSync(dirname(resolve(String(args.json))), { recursive: true });
  writeFileSync(resolve(String(args.json)), JSON.stringify(reports, null, 2));
}

let bad = 0;
for (const R of reports) {
  console.log(`\n=== ${R.shot} ===`);
  console.log(
    `  instances ${R.total}  visible ${R.visible}  (field built ${R.meshes} instanced meshes, ${R.tiles} tiles loaded)` +
      (R.build ? `\n  seating: ${JSON.stringify(R.build)}` : '')
  );
  const line = (ok, name, detail) => {
    if (!ok) bad++;
    console.log(`  ${ok ? ' ok ' : 'FAIL'} ${name.padEnd(34)} ${detail}`);
  };
  line(
    R.float.n === 0,
    'no daylight under any impostor',
    `${R.float.n}/${R.visible} visible instances stand clear of the lowest terrain under their own ` +
      `footprint (tol ${R.tol} m); worst ${R.float.worst.toFixed(1)} m` +
      (R.float.list.length ? `\n         ` + R.float.list.map((f) => JSON.stringify(f)).join('\n         ') : '')
  );
  line(
    R.stub.n === 0,
    'a building is left above the hill',
    `${R.stub.n}/${R.visible} visible instances clear the highest ground under their own plan by ` +
      `less than 6 m; worst ${R.stub.worst > 1e8 ? 'n/a' : R.stub.worst.toFixed(1)} m` +
      (R.stub.list.length ? `\n         ` + R.stub.list.map((f) => JSON.stringify(f)).join('\n         ') : '')
  );
  line(
    R.wet.n === 0,
    'no impostor standing in a river',
    `${R.wet.n}/${R.visible} visible instances have part of their plan over water` +
      (R.wet.list.length ? `\n         ` + R.wet.list.map((f) => JSON.stringify(f)).join('\n         ') : '')
  );
  line(
    R.unsupported.n === 0,
    'no sub-mass hangs unsupported',
    `${R.unsupported.n} visible instances emit a part with nothing under it` +
      (R.unsupported.list.length
        ? `\n         ` + R.unsupported.list.map((f) => JSON.stringify(f)).join('\n         ')
        : '')
  );
  line(
    R.inTile.n === 0,
    'no impostor inside a built tile',
    `${R.inTile.n} visible instances stand where a streamed tile is built` +
      (R.inTile.list.length ? `\n         ` + R.inTile.list.map((f) => JSON.stringify(f)).join('\n         ') : '')
  );
  line(
    R.tall.n === 0,
    'no impostor taller than 320 m',
    `${R.tall.n} visible instances exceed 320 m; tallest ${R.tall.worst.toFixed(0)} m` +
      (R.tall.list.length ? `\n         ` + R.tall.list.map((f) => JSON.stringify(f)).join('\n         ') : '')
  );
  line(
    R.unindexed === 0,
    'every instance is in the cell index',
    `${R.unindexed} instances are not reachable from the suppression index`
  );
  if (R.pixel) console.log(`  pixel ${R.pixel.px} -> ${JSON.stringify(R.pixel.hits, null, 2)}`);
  if (R.near.length) {
    console.log('  nearest visible impostors to camera:');
    for (const n of R.near) console.log(`      ${JSON.stringify(n)}`);
  }
}

console.log(bad === 0 ? '\nSKYLINE GATE PASSED' : `\nSKYLINE GATE FAILED (${bad} checks)`);
process.exit(bad === 0 ? 0 : 1);

// ---------------------------------------------------------------- in page --
function runProbe({ shot, pixel }) {
  const E = window.__ENGINE__;
  const B = E.ctx.peek('buildings');
  const W = E.ctx.peek('world');
  const cam = E.camera;
  const TOL = 1.5;
  /**
   * A block may settle into a slope — that is what hillside buildings do — so
   * the question is not how deep it is buried but what is LEFT. Anything less
   * than this above the highest ground under its own plan is not a building
   * seen over a hill, it is a card lying on one.
   */
  const STANDING = 6;

  const out = {
    shot,
    tol: TOL,
    meshes: B?.skyline?.meshes?.length ?? 0,
    tiles: B?.tiles?.size ?? 0,
    build: B?.skyline?.stats ?? null,
    total: 0,
    visible: 0,
    unindexed: 0,
    float: { n: 0, worst: 0, list: [] },
    stub: { n: 0, worst: 1e9, list: [] },
    wet: { n: 0, list: [] },
    unsupported: { n: 0, list: [] },
    inTile: { n: 0, list: [] },
    tall: { n: 0, worst: 0, list: [] },
    near: [],
    pixel: null,
  };
  const sky = B?.skyline;
  if (!sky?.meshes?.length) return out;

  // ---- connected components of every prototype, in prototype space --------
  const comps = new Map();
  const componentsOf = (geo) => {
    if (comps.has(geo)) return comps.get(geo);
    const pos = geo.getAttribute('position');
    const idx = geo.getIndex();
    const n = pos.count;
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (a) => {
      while (parent[a] !== a) a = parent[a] = parent[parent[a]];
      return a;
    };
    const uni = (a, b) => {
      a = find(a);
      b = find(b);
      if (a !== b) parent[b] = a;
    };
    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        uni(idx.getX(i), idx.getX(i + 1));
        uni(idx.getX(i + 1), idx.getX(i + 2));
      }
    }
    const box = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      let b = box.get(r);
      if (!b) box.set(r, (b = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9 }));
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      if (z < b.z0) b.z0 = z;
      if (z > b.z1) b.z1 = z;
    }
    const list = [...box.values()];
    comps.set(geo, list);
    return list;
  };

  // ---- which cell-index entries exist ------------------------------------
  const indexed = new Set();
  if (sky._cells) {
    for (const l of sky._cells.values()) for (let k = 0; k < l.length; k += 2) indexed.add(`${l[k]}:${l[k + 1]}`);
  }

  const tiles = [...(B.tiles?.values() ?? [])];
  const inBuiltTile = (x, z) => {
    for (const t of tiles) {
      if (!t.group) continue;
      const h = t.size * 0.5;
      if (Math.abs(x - t.cx) <= h && Math.abs(z - t.cz) <= h) return t;
    }
    return null;
  };

  /**
   * No `import * as THREE` in here: this function is serialised into the page,
   * so it has no module scope. Everything below reads the instance matrix as a
   * raw column-major float array, which is what it is anyway.
   */
  const V3 = E.camera.position.constructor;
  const terrain = (x, z) => {
    const h = W?.heightAt?.(x, z);
    return Number.isFinite(h) ? h : 0;
  };

  const all = [];
  const live = []; // for the pixel raycast
  for (let mi = 0; mi < sky.meshes.length; mi++) {
    const ent = sky.meshes[mi];
    const geo = ent.im.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const parts = componentsOf(geo);
    const arr = ent.im.instanceMatrix.array;
    for (let i = 0; i < ent.list.length; i++) {
      out.total++;
      if (!indexed.has(`${mi}:${i}`)) out.unindexed++;
      const te = arr.subarray(i * 16, i * 16 + 16);
      // Column-major TRS with a Y-only rotation: sx and sz are the lengths of
      // basis columns 0 and 2, sy of column 1.
      const sx = Math.hypot(te[0], te[2]);
      const sy = Math.abs(te[5]);
      const sz = Math.hypot(te[8], te[10]);
      if (sx < 1e-4 || sy < 1e-4) continue; // collapsed to zero: not drawn
      out.visible++;
      const px = te[12];
      const py = te[13];
      const pz = te[14];
      const baseY = py + bb.min.y * sy;
      const topY = py + bb.max.y * sy;
      const name = ent.im.name;

      // A grid over the prototype's own footprint, taken through the instance
      // matrix so the rotation is honoured.
      let tMax = -1e9;
      let tMin = 1e9;
      let wetN = 0;
      const N = 6; // deliberately not the grid the placement code samples
      for (let a = 0; a <= N; a++) {
        for (let b = 0; b <= N; b++) {
          const lx = bb.min.x + ((bb.max.x - bb.min.x) * a) / N;
          const lz = bb.min.z + ((bb.max.z - bb.min.z) * b) / N;
          const wx = te[0] * lx + te[8] * lz + te[12];
          const wz = te[2] * lx + te[10] * lz + te[14];
          const t = terrain(wx, wz);
          if (t > tMax) tMax = t;
          if (t < tMin) tMin = t;
          if (W?.isWater?.(wx, wz) === true) wetN++;
        }
      }
      /**
       * `over` is the metric that matters and the one the previous invariant
       * did not take. The placement code sets the base to `heightAt` AT THE
       * CENTRE, so "base == terrain at its own x/z" compares a number to
       * itself and can never fail. A skyline block is up to 70 m across on a
       * city with a 120 m hill in it: what floats is the DOWNHILL EDGE, and
       * that only shows up against the LOWEST terrain under the footprint.
       */
      const over = baseY - tMin; // daylight under the lowest point of the plan
      const bury = tMax - baseY; // how deep the uphill edge is inside the hill
      const rec = {
        mesh: name,
        i,
        x: +px.toFixed(1),
        z: +pz.toFixed(1),
        baseY: +baseY.toFixed(1),
        topY: +topY.toFixed(1),
        hM: +(topY - baseY).toFixed(1),
        wM: +((bb.max.x - bb.min.x) * sx).toFixed(1),
        terrainMax: +tMax.toFixed(1),
        terrainMin: +tMin.toFixed(1),
        over: +over.toFixed(1),
        bury: +bury.toFixed(1),
        standing: +(topY - tMax).toFixed(1),
        wet: wetN,
        dist: +Math.hypot(px - cam.position.x, pz - cam.position.z).toFixed(0),
      };
      all.push(rec);
      live.push({ te, bb, rec });

      if (over > TOL) {
        out.float.n++;
        if (over > out.float.worst) out.float.worst = over;
        if (out.float.list.length < 8) out.float.list.push(rec);
      }
      const standing = topY - tMax;
      if (standing < STANDING) {
        out.stub.n++;
        if (standing < out.stub.worst) out.stub.worst = standing;
        if (out.stub.list.length < 6) out.stub.list.push(rec);
      }
      if (wetN > 0) {
        out.wet.n++;
        if (out.wet.list.length < 6) out.wet.list.push(rec);
      }
      const hgt = topY - baseY;
      if (hgt > 320) {
        out.tall.n++;
        if (hgt > out.tall.worst) out.tall.worst = hgt;
        if (out.tall.list.length < 6) out.tall.list.push(rec);
      }
      const t = inBuiltTile(px, pz);
      if (t) {
        out.inTile.n++;
        if (out.inTile.list.length < 8) out.inTile.list.push({ ...rec, tile: t.key });
      }

      // Sub-mass support: each component must reach down to the base plane or
      // rest on another component that overlaps it in XZ.
      for (const c of parts) {
        const y0 = py + c.y0 * sy;
        if (y0 - baseY < TOL) continue;
        let held = false;
        for (const o of parts) {
          if (o === c) continue;
          if (py + o.y1 * sy < y0 - 0.05) continue;
          if (o.x1 < c.x0 || o.x0 > c.x1 || o.z1 < c.z0 || o.z0 > c.z1) continue;
          held = true;
          break;
        }
        if (!held) {
          out.unsupported.n++;
          if (out.unsupported.list.length < 8) out.unsupported.list.push({ ...rec, partY0: +y0.toFixed(1) });
          break;
        }
      }
    }
  }

  all.sort((a, b) => a.dist - b.dist);
  out.near = all.slice(0, 6);

  /**
   * Which impostor is under this pixel? A slab test in each instance's own
   * space — cheaper than a Raycaster and, more to the point, reachable: this
   * function is injected into the page and cannot import three.
   */
  if (pixel) {
    const ndcX = (pixel[0] / window.innerWidth) * 2 - 1;
    const ndcY = -(pixel[1] / window.innerHeight) * 2 + 1;
    const dir = new V3(ndcX, ndcY, 0.5).unproject(cam).sub(cam.position).normalize();
    const o = cam.position;
    const hits = [];
    for (const L of live) {
      const te = L.te;
      const sx = Math.hypot(te[0], te[2]);
      const sy = Math.abs(te[5]);
      const sz = Math.hypot(te[8], te[10]);
      const c = te[0] / sx;
      const sn = -te[2] / sx;
      // world -> local: undo translation, then the inverse Y rotation, then scale
      const rx = o.x - te[12];
      const rz = o.z - te[14];
      const lox = (rx * c - rz * sn) / sx;
      const loz = (rx * sn + rz * c) / sz;
      const loy = (o.y - te[13]) / sy;
      const ldx = (dir.x * c - dir.z * sn) / sx;
      const ldz = (dir.x * sn + dir.z * c) / sz;
      const ldy = dir.y / sy;
      let t0 = -1e12;
      let t1 = 1e12;
      const slab = (lo, ld, a, b) => {
        if (Math.abs(ld) < 1e-9) return lo >= a && lo <= b;
        let ta = (a - lo) / ld;
        let tb = (b - lo) / ld;
        if (ta > tb) [ta, tb] = [tb, ta];
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        return t1 >= t0;
      };
      const bb = L.bb;
      if (!slab(lox, ldx, bb.min.x, bb.max.x)) continue;
      if (!slab(loy, ldy, bb.min.y, bb.max.y)) continue;
      if (!slab(loz, ldz, bb.min.z, bb.max.z)) continue;
      if (t1 < 0) continue;
      hits.push({ t: +Math.max(t0, 0).toFixed(0), ...L.rec });
    }
    hits.sort((a, b) => a.t - b.t);
    out.pixel = { px: pixel, hits: hits.slice(0, 5) };
  }
  return out;
}
