#!/usr/bin/env node
/**
 * BUILDINGS — "is a building standing in the road, and can a car still get
 * past it?" assertion, over the whole road network.
 *
 * A road blocked by a building or facade is, in a driving game, a hard failure
 * — it strands the player, and `traffic` and `police` both route on the
 * assumption that a drivable edge is drivable.
 *
 * WHAT THIS MEASURES, AND WHY IT IS NOT CIRCULAR (ARCHITECTURE.md rule 12)
 *
 * `_clipToStreets` in `index.js` already trims each LOT polygon back to
 * `edge.width * 0.5 + STREET_SETBACK[kind]`. Three separate things make that a
 * proxy rather than an answer, and all three are what this file exists to catch:
 *
 *   1. A LOT RECORD IS NOT A BUILDING. `planBuilding` yaws the plan by up to
 *      +/-0.011 rad about its centroid, and `buildLot` then hangs plinths,
 *      shopfront bulkheads, pilasters, stoops and door surrounds OFF the wall
 *      plane. Every one of those is emitted geometry outside the polygon the
 *      clip was applied to. LANDMARKS are not clipped at all.
 *   2. `edge.width * 0.5` IS NOT THE LANE EDGE. `traffic` publishes the drivable
 *      lane set and its offsets; that is what a driver actually uses, and it is
 *      arrived at by completely different arithmetic.
 *   3. CLEARING THE LANE IS NOT THE SAME AS BEING PASSABLE. A wall 10 cm outside
 *      the painted lane edge still leaves a road no car can drive down.
 *
 * So this file never reads a lot rectangle, never reads `STREET_SETBACK`, and
 * never re-samples the placement arithmetic. It calls the shipped build path
 * (`_plans` -> `buildLot` -> `TileBuilder.build`), takes the TRIANGLES THAT
 * COME OUT — visual meshes, instanced kit and the `bcol_*` collision hulls the
 * car actually hits — and asks two independent questions of them:
 *
 *   TIER A  INTRUSION.  `props`' `layout.laneIntrusion()` — the same function
 *           `src/props/lanesweep.mjs` polices street furniture with, built from
 *           `traffic`'s lane offsets. How deep into a lane a driver may legally
 *           use does emitted building geometry reach?
 *
 *   TIER B  PASSABILITY.  Walk every drivable lane centre of every edge at 1 m
 *           and measure the true XZ distance to the nearest emitted triangle
 *           whose vertical span overlaps a vehicle's own. A lane sample is
 *           BLOCKED when that distance is under half a vehicle width. A
 *           direction is IMPASSABLE when, at some station along it, every lane
 *           the driver may use is blocked at once — which is exactly a blocked
 *           road and cannot be argued down.
 *
 * Tier B is the stronger of the two and does not depend on tier A being right:
 * it never asks where a lane "ends", only how much room is left.
 *
 * The vertical band matters and is why this works on TRIANGLES rather than
 * vertices. A merged wall panel has vertices only at y=ground and y=+3.5 m, so
 * a vertex-band filter finds neither and reports a clear road through a solid
 * wall. A triangle is kept when its own y-span overlaps the vehicle's, which
 * also correctly lets a cornice at +12 m, a balcony at +4 m and an awning at
 * +2.8 m pass over a car without being called an obstruction.
 *
 * Memory is bounded by never holding the city's geometry at once: the lane
 * samples are laid down first, each building is built, measured against them
 * and freed, and only a per-sample running minimum survives.
 *
 * Usage
 *   node src/buildings/roadsweep.mjs
 *   node src/buildings/roadsweep.mjs --json=/tmp/rs.json
 *   node src/buildings/roadsweep.mjs --maxtiles=40      (first 40 lot tiles)
 *   node src/buildings/roadsweep.mjs --width=2.6        vehicle width, metres
 *
 * Negative controls — revert one fix, change nothing else, watch it go red:
 *   node src/buildings/roadsweep.mjs --noclip      `_clipToStreets` off entirely
 *   node src/buildings/roadsweep.mjs --legacyclip  its pre-fix elevation gates
 *                                                  and 0.7 m alley setback
 *   node src/buildings/roadsweep.mjs --nokerb      the emitted-geometry guard off
 * And, the other way, `--lmguard` turns the guard ON for landmarks too, which
 * takes the residual to zero at the cost of cutting holes in them.
 *
 * Exit code 1 when any drivable direction is impassable, or when the intruding
 * building count or worst depth regresses past the RATCHETs at the foot.
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

/**
 * The widest thing a player can drive on a road: `truck` in
 * `src/vehicles/specs.js` is 2.6 m across the body. Cars run 2.0-2.3 m. The
 * corridor is centred on the LANE CENTRE, so this asks for 1.3 m of clear
 * ground either side of where a driver is actually aiming — the minimum for
 * "this road is drivable", not a comfort margin.
 */
const VEH_W = Number(args.width ?? 2.6);
/** Clear ground a car needs under it; below this a wheel rolls over. */
const FLUSH = 0.15;
/** Above this a car passes underneath: awnings, balconies, cornices, decks. */
const ROOF = 1.6;
const STEP = Number(args.step ?? 1.0);
const TOL = Number(args.tolerance ?? 0.02);
const MAXTILES = Number(args.maxtiles ?? 0) || 0;
const QUALITY = args.q ?? 'high';

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

/**
 * Chromium refuses a set of ports outright (`ERR_UNSAFE_PORT`) — 6000 is X11
 * and 6665-6669 are IRC. Landing on one makes the whole sweep fail at
 * `page.goto` with an error that has nothing to do with anything it measures.
 */
const UNSAFE_PORTS = new Set([6000, 6543, 6566, 6665, 6666, 6667, 6668, 6669, 6697]);

async function freePort() {
  for (let i = 0; i < 300; i++) {
    const p = 5900 + Math.floor(Math.random() * 900);
    if (UNSAFE_PORTS.has(p)) continue;
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
    '--enable-gpu-rasterization',
    '--mute-audio',
    '--js-flags=--max-old-space-size=8192',
  ],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));

let report = null;
let failure = null;
try {
  await page.goto(
    `http://127.0.0.1:${PORT}/?capture=1&lockstep=1&prewarm=0&q=${QUALITY}`,
    { waitUntil: 'domcontentloaded', timeout: 120000 }
  );
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 240000 });

  // `traffic` attaches its lane layer lazily and it is the authority on which
  // lanes a driver may use. Without it both tiers fall back to raw carriageway
  // arithmetic and mean much less.
  await page.evaluate(
    () =>
      new Promise((done) => {
        let i = 0;
        const t = () => {
          const l = window.__ENGINE__?.ctx?.peek('traffic')?.lanes;
          if (l?.ready || ++i > 240) return done(!!l?.ready);
          window.__PUMP__ ? window.__PUMP__(1) : 0;
          requestAnimationFrame(t);
        };
        requestAnimationFrame(t);
      })
  );

  report = await page.evaluate(
    async ({ vehW, flush, roof, step, tol, maxTiles, noclip, nokerb, legacy, lmguard }) => {
      const e = window.__ENGINE__;
      const B = e.ctx.peek('buildings');
      const world = e.ctx.peek('world');
      const layout = e.ctx.peek('props')?.layout ?? null;
      const lanes = e.ctx.peek('traffic')?.lanes ?? null;
      const roads = world?.roads;
      if (!B || !roads) return { error: 'no buildings/world' };

      let mods;
      try {
        mods = {
          tile: await import('/src/buildings/tile.js'),
          lm: await import('/src/buildings/landmarks.js'),
        };
      } catch (err) {
        return { error: `module import failed: ${err.message}` };
      }
      const { TileBuilder, releaseTile } = mods.tile;
      const { LANDMARKS } = mods.lm;

      /** NEGATIVE CONTROLS. Each reverts one fix and leaves everything else. */
      if (noclip) B.clipStreets = false;
      if (nokerb) B.kerbGuard = false;
      if (legacy) B.legacyClip = true;
      if (lmguard) B.landmarkGuard = true;

      const HALF = vehW * 0.5;
      const CAP = Math.max(HALF + 0.4, 2.0);

      /* ================================================================== */
      /* 1.  A road-proximity mask, so the harvest can discard the 90%+ of a  */
      /*     city that is nowhere near a carriageway before it costs anything */
      /* ================================================================== */
      const MC = 4;
      const ORG = -2048;
      const GN = 1024;
      const cellOf = (x, z) => {
        const cx = ((x - ORG) / MC) | 0;
        const cz = ((z - ORG) / MC) | 0;
        if (cx < 0 || cz < 0 || cx >= GN || cz >= GN) return -1;
        return cx + cz * GN;
      };
      const mask = new Uint8Array(GN * GN);
      for (const ed of roads.edges) {
        if (ed.rail) continue;
        const na = roads.nodes[ed.a];
        const nb = roads.nodes[ed.b];
        if (!na || !nb) continue;
        // Everything either tier can care about lies within half a carriageway
        // plus the corridor a vehicle needs. Nothing beyond it can foul a lane
        // or narrow a lane-centred corridor, so nothing beyond it is kept.
        const reach = (ed.width ?? 8) * 0.5 + CAP + 1.5;
        const n = Math.max(1, Math.ceil((ed.len ?? 1) / 2));
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const px = na.x + (nb.x - na.x) * t;
          const pz = na.z + (nb.z - na.z) * t;
          const c0 = (((px - reach) - ORG) / MC) | 0;
          const c1 = (((px + reach) - ORG) / MC) | 0;
          const d0 = (((pz - reach) - ORG) / MC) | 0;
          const d1 = (((pz + reach) - ORG) / MC) | 0;
          for (let cz = d0; cz <= d1; cz++) {
            if (cz < 0 || cz >= GN) continue;
            const row = cz * GN;
            for (let cx = c0; cx <= c1; cx++) {
              if (cx < 0 || cx >= GN) continue;
              mask[row + cx] = 1;
            }
          }
        }
      }

      /* ================================================================== */
      /* 2.  Lay down every lane sample ONCE. These are the questions; the    */
      /*     buildings are swept past them one at a time.                     */
      /* ================================================================== */
      const SX = [];
      const SY = [];
      const SZ = [];
      const dirs = []; // { edge, dir, lo, nLanes, nS, start }
      for (const ed of roads.edges) {
        if (ed.rail) continue;
        const len = ed.len ?? 0;
        if (len < 1) continue;
        const na = roads.nodes[ed.a];
        const nb = roads.nodes[ed.b];
        if (!na || !nb) continue;
        const nS = Math.max(2, Math.ceil(len / step));
        for (let dir = 1; dir >= -1; dir -= 2) {
          let lo;
          let hi;
          if (lanes) {
            if (!lanes.drivable(ed, dir)) continue;
            lo = lanes.laneLo(ed, dir);
            hi = lanes.laneHi(ed, dir);
          } else {
            if (ed.oneway && dir < 0) continue;
            lo = dir > 0 ? 0 : ed.forward;
            hi = dir > 0 ? ed.forward - 1 : ed.lanes - 1;
          }
          if (hi < lo) continue;
          const rec = {
            id: ed.id,
            kind: ed.kind,
            width: ed.width,
            dir,
            lo,
            nLanes: hi - lo + 1,
            nS,
            len,
            start: SX.length,
          };
          for (let li = 0; li < rec.nLanes; li++) {
            const lane = lo + li;
            const off =
              lane < ed.forward
                ? (lane + 0.5) * ed.laneWidth
                : -(lane - ed.forward + 0.5) * ed.laneWidth;
            for (let s = 0; s <= nS; s++) {
              const t = s / nS;
              SX.push(na.x + (nb.x - na.x) * t - ed.dz * off);
              SZ.push(na.z + (nb.z - na.z) * t + ed.dx * off);
              SY.push((na.y ?? 0) + ((nb.y ?? 0) - (na.y ?? 0)) * t);
            }
          }
          dirs.push(rec);
        }
      }
      const NS = SX.length;
      const sx = Float64Array.from(SX);
      const sy = Float64Array.from(SY);
      const sz = Float64Array.from(SZ);
      SX.length = SY.length = SZ.length = 0;
      const sMin = new Float32Array(NS).fill(CAP);
      const sOwn = new Int32Array(NS).fill(-1);
      /**
       * WHICH PIECE. Attribution to a building says where to look; attribution
       * to the emitted mesh says WHAT to fix — a wall on the lot line and a
       * shopfront canopy hung off it are different defects with different
       * answers, and after the tile merge only the material key survives to
       * tell them apart.
       */
      const meshIds = [];
      const meshIdx = new Map();
      const meshId = (n) => {
        let i = meshIdx.get(n);
        if (i === undefined) meshIdx.set(n, (i = meshIds.push(n) - 1));
        return i;
      };
      const sMesh = new Int32Array(NS).fill(-1);
      let curMesh = -1;
      /**
       * HOW FAR EMITTED GEOMETRY REACHES BEYOND THE PLAN IT WAS CLIPPED FROM.
       * `_clipToStreets` trims the LOT polygon; nothing checks what `buildLot`
       * then hangs off the wall. This is the number that says whether a setback
       * is enough, and it is measured per emitted piece so the answer names the
       * part rather than the building.
       */
      const overhang = new Map();
      let curPoly = null;
      let curBase = null;
      const outsideBy = (px, pz) => {
        const poly = curPoly;
        if (!poly || poly.length < 3) return 0;
        let worstD = -1e9;
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i];
          const b = poly[(i + 1) % poly.length];
          const dx = b[0] - a[0];
          const dz = b[1] - a[1];
          const l = Math.hypot(dx, dz);
          if (l < 1e-6) continue;
          // Positive-area (CCW) winding puts the interior to the LEFT of a->b.
          const d = -((-dz) * (px - a[0]) + dx * (pz - a[1])) / l;
          if (d > worstD) worstD = d;
        }
        return worstD > 0 ? worstD : 0;
      };

      // Bucket the samples on the same 4 m grid, as intrusive-free linked lists.
      const head = new Int32Array(GN * GN).fill(-1);
      const next = new Int32Array(NS).fill(-1);
      for (let i = 0; i < NS; i++) {
        const c = cellOf(sx[i], sz[i]);
        if (c < 0) continue;
        next[i] = head[c];
        head[c] = i;
      }

      /* ================================================================== */
      /* 3.  Build each building through the SHIPPED path, measure, free.     */
      /* ================================================================== */
      const owners = [];
      const intruders = [];
      /** Over a lane but above a car: reported, never gated. */
      const overhangers = [];
      const det = {};
      const ecand = [];

      let triSeen = 0;
      let triKept = 0;
      const tri = new Float64Array(9);

      /** Squared XZ distance from a point to a triangle's XZ projection. */
      const segD2 = (px, pz, ax, az, bx, bz) => {
        const vx = bx - ax;
        const vz = bz - az;
        const l2 = vx * vx + vz * vz;
        let t = l2 > 1e-12 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - (ax + vx * t);
        const dz = pz - (az + vz * t);
        return dx * dx + dz * dz;
      };

      /**
       * One emitted triangle against every lane sample it could possibly
       * narrow. This is the whole of tier B; everything else is bookkeeping.
       */
      const applyTri = (ownerIdx, ax, ay, az, bx, by, bz, cx, cy, cz) => {
        const yLo = Math.min(ay, by, cy);
        const yHi = Math.max(ay, by, cy);
        const x0 = Math.min(ax, bx, cx) - CAP;
        const x1 = Math.max(ax, bx, cx) + CAP;
        const z0 = Math.min(az, bz, cz) - CAP;
        const z1 = Math.max(az, bz, cz) + CAP;
        let c0 = ((x0 - ORG) / MC) | 0;
        let c1 = ((x1 - ORG) / MC) | 0;
        let d0 = ((z0 - ORG) / MC) | 0;
        let d1 = ((z1 - ORG) / MC) | 0;
        if (c1 < 0 || d1 < 0 || c0 >= GN || d0 >= GN) return;
        if (c0 < 0) c0 = 0;
        if (d0 < 0) d0 = 0;
        if (c1 >= GN) c1 = GN - 1;
        if (d1 >= GN) d1 = GN - 1;
        for (let ccz = d0; ccz <= d1; ccz++) {
          const row = ccz * GN;
          for (let ccx = c0; ccx <= c1; ccx++) {
            let i = head[row + ccx];
            while (i >= 0) {
              const py = sy[i];
              // Does this triangle occupy the volume this vehicle needs?
              if (yHi > py + flush && yLo < py + roof) {
                const px = sx[i];
                const pz = sz[i];
                const cur = sMin[i];
                if (cur > 0) {
                  // inside test (either winding)
                  const w1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
                  const w2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz);
                  const w3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
                  let d;
                  if (!((w1 < 0 || w2 < 0 || w3 < 0) && (w1 > 0 || w2 > 0 || w3 > 0))) d = 0;
                  else {
                    const q = Math.min(
                      segD2(px, pz, ax, az, bx, bz),
                      segD2(px, pz, bx, bz, cx, cz),
                      segD2(px, pz, cx, cz, ax, az)
                    );
                    d = q >= cur * cur ? cur : Math.sqrt(q);
                  }
                  if (d < cur) {
                    sMin[i] = d;
                    sOwn[i] = ownerIdx;
                    sMesh[i] = curMesh;
                  }
                }
              }
              i = next[i];
            }
          }
        }
      };

      /**
       * Pull world-space triangles out of whatever `TileBuilder.build` made,
       * drop everything nowhere near a road, and hand the rest to both tiers.
       * `bbox` accumulates the kept extent so tier A's edge broad-phase can be
       * done once per building instead of once per vertex.
       */
      const harvest = (built, ownerIdx, edgeList, acc) => {
        const visit = (geo, el) => {
          const pos = geo?.attributes?.position;
          if (!pos) return;
          const P = pos.array;
          const idx = geo.index;
          const ia = idx ? idx.array : null;
          const n = ia ? ia.length : pos.count;
          for (let i = 0; i + 2 < n; i += 3) {
            for (let k = 0; k < 3; k++) {
              const vi = (ia ? ia[i + k] : i + k) * 3;
              const x = P[vi];
              const y = P[vi + 1];
              const z = P[vi + 2];
              if (el) {
                tri[k * 3] = el[0] * x + el[4] * y + el[8] * z + el[12];
                tri[k * 3 + 1] = el[1] * x + el[5] * y + el[9] * z + el[13];
                tri[k * 3 + 2] = el[2] * x + el[6] * y + el[10] * z + el[14];
              } else {
                tri[k * 3] = x;
                tri[k * 3 + 1] = y;
                tri[k * 3 + 2] = z;
              }
            }
            triSeen++;
            // Near-road pre-filter: the three corners and the centroid. A
            // triangle bigger than a cell that spans a road with all four
            // outside it is possible in principle, so anything wide falls
            // through to a bounded cell scan rather than being dropped.
            const ax = tri[0];
            const az = tri[2];
            const bx = tri[3];
            const bz = tri[5];
            const cx = tri[6];
            const cz = tri[8];
            let near = false;
            let c = cellOf(ax, az);
            if (c >= 0 && mask[c]) near = true;
            if (!near) {
              c = cellOf(bx, bz);
              if (c >= 0 && mask[c]) near = true;
            }
            if (!near) {
              c = cellOf(cx, cz);
              if (c >= 0 && mask[c]) near = true;
            }
            if (!near) {
              c = cellOf((ax + bx + cx) / 3, (az + bz + cz) / 3);
              if (c >= 0 && mask[c]) near = true;
            }
            if (!near) {
              const x0 = Math.min(ax, bx, cx);
              const x1 = Math.max(ax, bx, cx);
              const z0 = Math.min(az, bz, cz);
              const z1 = Math.max(az, bz, cz);
              if (x1 - x0 > MC || z1 - z0 > MC) {
                let g0 = ((x0 - ORG) / MC) | 0;
                let g1 = ((x1 - ORG) / MC) | 0;
                let h0 = ((z0 - ORG) / MC) | 0;
                let h1 = ((z1 - ORG) / MC) | 0;
                if (g0 < 0) g0 = 0;
                if (h0 < 0) h0 = 0;
                if (g1 >= GN) g1 = GN - 1;
                if (h1 >= GN) h1 = GN - 1;
                if ((g1 - g0 + 1) * (h1 - h0 + 1) <= 4096) {
                  for (let hz = h0; hz <= h1 && !near; hz++) {
                    const row = hz * GN;
                    for (let gx = g0; gx <= g1; gx++) {
                      if (mask[row + gx]) {
                        near = true;
                        break;
                      }
                    }
                  }
                }
              }
            }
            if (!near) continue;
            triKept++;
            if (curPoly) {
              const lowY = Math.min(tri[1], tri[4], tri[7]);
              // Only the part of the building a bumper can meet: a cornice
              // twelve metres up is supposed to overhang.
              if (lowY < (curBase ?? -1e9) + roof) {
                const o = Math.max(outsideBy(ax, az), outsideBy(bx, bz), outsideBy(cx, cz));
                if (o > 0.05) {
                  const name = meshIds[curMesh] ?? '?';
                  const r = overhang.get(name);
                  if (!r) overhang.set(name, { n: 1, max: o });
                  else {
                    r.n++;
                    if (o > r.max) r.max = o;
                  }
                }
              }
            }
            applyTri(ownerIdx, ax, tri[1], az, bx, tri[4], bz, cx, tri[7], cz);
            /**
             * --- tier A, on the same triangle, with the same candidate edges.
             *
             * SPLIT, and the split is the whole point. `laneIntrusion` answers
             * "how far past the lane edge is this point", which is the right
             * question for a bollard and the wrong one for a shop awning: the
             * awning is SUPPOSED to reach over the kerb, and a stadium's
             * concourse deck passing 4 m above a road is not an obstruction.
             * `src/props/lanesweep.mjs` draws the same line — it gates on
             * `baseInLane` and merely prints the overhang — and for the same
             * reason. Counting overhang as intrusion put a 11.60 m "intrusion"
             * on a piece a lorry drives under.
             *
             * So a triangle only counts as INTRUDING when its own vertical span
             * overlaps the band a vehicle occupies over that road's deck. Same
             * criterion tier B uses, applied to the same emitted triangle, so
             * the two tiers cannot disagree about what an obstruction is.
             */
            if (layout && edgeList) {
              const tLo = Math.min(tri[1], tri[4], tri[7]);
              const tHi = Math.max(tri[1], tri[4], tri[7]);
              for (let k = 0; k < 3; k++) {
                det.edge = null;
                const d = layout.laneIntrusion(tri[k * 3], tLo, tri[k * 3 + 2], 0, edgeList, det);
                if (d <= tol) continue;
                const ed = det.edge;
                let atDeck = true;
                if (ed) {
                  const na = roads.nodes[ed.a];
                  const nb = roads.nodes[ed.b];
                  const len = ed.len ?? 0;
                  let tt = (tri[k * 3] - na.x) * ed.dx + (tri[k * 3 + 2] - na.z) * ed.dz;
                  tt = tt < 0 ? 0 : tt > len ? len : tt;
                  const ey = (na.y ?? 0) + ((nb.y ?? 0) - (na.y ?? 0)) * (len > 1e-3 ? tt / len : 0);
                  atDeck = tHi > ey + flush && tLo < ey + roof;
                }
                if (!atDeck) {
                  if (d > acc.over) {
                    acc.over = d;
                    acc.overMesh = curMesh;
                  }
                  continue;
                }
                if (d > acc.depth) {
                  acc.depth = d;
                  acc.x = tri[k * 3];
                  acc.y = tLo;
                  acc.z = tri[k * 3 + 2];
                  acc.edge = ed;
                  acc.mesh = curMesh;
                }
              }
            }
          }
        };
        built.group.updateMatrixWorld(true);
        const out = new Array(16);
        built.group.traverse((o) => {
          if (o.isInstancedMesh) {
            curMesh = meshId(o.name || 'inst');
            const a = o.matrixWorld.elements;
            const b = o.instanceMatrix.array;
            for (let i = 0; i < o.count; i++) {
              const off = i * 16;
              for (let cc = 0; cc < 4; cc++) {
                for (let r = 0; r < 4; r++) {
                  out[cc * 4 + r] =
                    a[r] * b[off + cc * 4] +
                    a[4 + r] * b[off + cc * 4 + 1] +
                    a[8 + r] * b[off + cc * 4 + 2] +
                    a[12 + r] * b[off + cc * 4 + 3];
                }
              }
              visit(o.geometry, out);
            }
          } else if (o.isMesh) {
            curMesh = meshId(o.name || 'mesh');
            visit(o.geometry, o.matrixWorld.elements);
          }
        });
        // The `bcol_*` hulls are NOT under `group` and they are what a car
        // actually hits. Missing them would measure the picture, not the wall.
        for (const cm of built.colMeshes ?? []) {
          cm.updateMatrixWorld(true);
          curMesh = meshId(cm.name || 'col');
          visit(cm.geometry, cm.matrixWorld.elements);
        }
      };

      /** Edges that could possibly own a lane this building reaches into. */
      const edgesFor = (bx0, bz0, bx1, bz1) => {
        ecand.length = 0;
        roads.edgesInRect(bx0 - 32, bz0 - 32, bx1 + 32, bz1 + 32, ecand);
        return ecand;
      };

      const t0 = performance.now();

      const tiles = [...(world._lotsByTile?.keys() ?? [])];
      const useTiles = maxTiles ? tiles.slice(0, maxTiles) : tiles;
      let lotsSeen = 0;
      let planFail = 0;
      const thrown = [];
      let buildingsBuilt = 0;
      let keptOut = 0;

      for (const key of useTiles) {
        const [tx, tz] = key.split(',').map(Number);
        const lots = world.lotsInTile(tx, tz);
        if (!lots?.length) continue;
        lotsSeen += lots.length;
        const rec = { tx, tz, key, lots, plans: null };
        let plans;
        try {
          plans = B._plans(rec);
        } catch (err) {
          planFail++;
          if (thrown.length < 6) thrown.push(`tile ${key}: ${err.message}`);
          continue;
        }
        for (const plan of plans) {
          let built = null;
          try {
            const T = new TileBuilder(B.lib, 'sweep');
            // The SHIPPED build path, kerb guard and all — see
            // `BuildingSystem.buildPlan`. Reimplementing the two lines around
            // `buildLot` here is how the first run of this sweep managed to
            // report the unguarded city and make a working fix look inert.
            B.buildPlan(T, plan, 0);
            built = T.build(null);
            keptOut += T.stats.keptOut;
          } catch (err) {
            if (thrown.length < 12) thrown.push(`lot in ${key}: ${err.message}`);
            continue;
          }
          let bx0 = Infinity;
          let bz0 = Infinity;
          let bx1 = -Infinity;
          let bz1 = -Infinity;
          for (const p of plan.foot ?? []) {
            if (p[0] < bx0) bx0 = p[0];
            if (p[0] > bx1) bx1 = p[0];
            if (p[1] < bz0) bz0 = p[1];
            if (p[1] > bz1) bz1 = p[1];
          }
          if (!Number.isFinite(bx0)) {
            bx0 = plan.centroid?.[0] ?? 0;
            bx1 = bx0;
            bz0 = plan.centroid?.[1] ?? 0;
            bz1 = bz0;
          }
          const oi = owners.length;
          owners.push({
            id: `lot ${key}#${buildingsBuilt}`,
            kind: plan.kind ?? 'lot',
            base: +(plan.groundY ?? 0).toFixed(1),
            x: +((bx0 + bx1) * 0.5).toFixed(1),
            z: +((bz0 + bz1) * 0.5).toFixed(1),
          });
          buildingsBuilt++;
          const acc = { depth: -1e9, over: -1e9, overMesh: -1, x: 0, y: 0, z: 0, edge: null, mesh: -1 };
          curPoly = plan.foot ?? null;
          curBase = plan.groundY ?? null;
          harvest(built, oi, edgesFor(bx0, bz0, bx1, bz1), acc);
          curPoly = null;
          curBase = null;
          if (acc.depth > tol) {
            intruders.push({
              owner: oi,
              kind: owners[oi].kind,
              depth: +acc.depth.toFixed(2),
              x: +acc.x.toFixed(1),
              y: +acc.y.toFixed(1),
              z: +acc.z.toFixed(1),
              edge: acc.edge
                ? { id: acc.edge.id, kind: acc.edge.kind, w: +acc.edge.width.toFixed(1) }
                : null,
              part: meshIds[acc.mesh] ?? '?',
            });
          }
          if (acc.over > tol) {
            overhangers.push({ depth: +acc.over.toFixed(2), part: meshIds[acc.overMesh] ?? '?' });
          }
          releaseTile(built, null);
        }
      }

      /* ---- landmarks: hand-authored, and `_clipToStreets` never sees them - */
      let landmarksBuilt = 0;
      for (const lm of LANDMARKS ?? []) {
        let built = null;
        try {
          const T = new TileBuilder(B.lib, `lm_${lm.id}`);
          B.buildLandmarkPlan(T, lm);
          built = T.build(null);
          keptOut += T.stats.keptOut;
        } catch (err) {
          if (thrown.length < 16) thrown.push(`landmark ${lm.id}: ${err.message}`);
          continue;
        }
        landmarksBuilt++;
        const oi = owners.length;
        owners.push({ id: `landmark ${lm.id}`, kind: 'landmark', base: +B._groundAt(lm.x, lm.z).toFixed(1), x: +lm.x.toFixed(1), z: +lm.z.toFixed(1) });
        const r = lm.r ?? lm.radius ?? 160;
        const acc = { depth: -1e9, over: -1e9, overMesh: -1, x: 0, y: 0, z: 0, edge: null, mesh: -1 };
        harvest(built, oi, edgesFor(lm.x - r, lm.z - r, lm.x + r, lm.z + r), acc);
        if (acc.depth > tol) {
          intruders.push({
            owner: oi,
            kind: 'landmark',
            depth: +acc.depth.toFixed(2),
            x: +acc.x.toFixed(1),
            y: +acc.y.toFixed(1),
            z: +acc.z.toFixed(1),
            edge: acc.edge
              ? { id: acc.edge.id, kind: acc.edge.kind, w: +acc.edge.width.toFixed(1) }
              : null,
            part: meshIds[acc.mesh] ?? '?',
          });
        }
        if (acc.over > tol) {
          overhangers.push({ depth: +acc.over.toFixed(2), part: meshIds[acc.overMesh] ?? '?' });
        }
        releaseTile(built, null);
      }
      const harvestMs = Math.round(performance.now() - t0);

      /* ================================================================== */
      /* 4.  Read the verdict off the per-sample minima.                     */
      /* ================================================================== */
      let blockedSamples = 0;
      for (let i = 0; i < NS; i++) if (sMin[i] < HALF) blockedSamples++;

      let lanesSwept = 0;
      let lanesBlocked = 0;
      let dirsImpassable = 0;
      /**
       * Split by WHO. A lot standing in a lane is this subsystem's bug and its
       * budget is zero. A landmark standing in a lane is a road laid across a
       * site `world/plan.js` already names — see `BuildingSystem.landmarkGuard`
       * — and no amount of work in here makes it go away.
       */
      let dirsImpassableLot = 0;
      let dirsImpassableLm = 0;
      const impassable = [];
      const laneHits = [];
      for (const d of dirs) {
        const per = d.nS + 1;
        lanesSwept += d.nLanes;
        let worst = null;
        const blockedAt = new Uint8Array(per);
        for (let li = 0; li < d.nLanes; li++) {
          let laneBad = false;
          let laneWorst = null;
          for (let s = 0; s < per; s++) {
            const i = d.start + li * per + s;
            if (sMin[i] >= HALF) continue;
            laneBad = true;
            blockedAt[s]++;
            const rec = {
              edge: d.id,
              kind: d.kind,
              dir: d.dir,
              lane: d.lo + li,
              t: +(s / d.nS).toFixed(3),
              x: +sx[i].toFixed(1),
              y: +sy[i].toFixed(1),
              z: +sz[i].toFixed(1),
              free: +(sMin[i] * 2).toFixed(2),
              by: owners[sOwn[i]]?.id ?? '?',
              part: meshIds[sMesh[i]] ?? '?',
              // Is the obstruction inside the carriageway, or is the lane
              // simply laid too close to a legitimately-placed wall?
              lat: +(Math.abs(
                -roads.edges[d.id].dz * (sx[i] - roads.nodes[roads.edges[d.id].a].x) +
                  roads.edges[d.id].dx * (sz[i] - roads.nodes[roads.edges[d.id].a].z)
              ) + sMin[i]).toFixed(1),
              halfW: +(roads.edges[d.id].width * 0.5).toFixed(1),
              dyBase: +(sy[i] - (owners[sOwn[i]]?.base ?? 0)).toFixed(1),
            };
            if (!laneWorst || rec.free < laneWorst.free) laneWorst = rec;
            if (!worst || rec.free < worst.free) worst = rec;
          }
          if (laneBad) {
            lanesBlocked++;
            if (laneHits.length < 3000) laneHits.push(laneWorst);
          }
        }
        let all = false;
        for (let s = 0; s < per; s++) {
          if (blockedAt[s] >= d.nLanes) {
            all = true;
            break;
          }
        }
        if (all) {
          dirsImpassable++;
          if (owners[sOwn[d.start]] || worst) {
            if (worst && /^landmark /.test(worst.by)) dirsImpassableLm++;
            else dirsImpassableLot++;
          }
          if (impassable.length < 500) {
            impassable.push({
              width: +(d.width ?? 0).toFixed(1),
              lanes: d.nLanes,
              len: +d.len.toFixed(0),
              ...worst,
            });
          }
        }
      }

      intruders.sort((a, b) => b.depth - a.depth);
      impassable.sort((a, b) => a.free - b.free);
      laneHits.sort((a, b) => a.free - b.free);

      const bands = { '0.02-0.25': 0, '0.25-0.75': 0, '0.75-1.5': 0, '1.5-3': 0, '3+': 0 };
      for (const h of intruders) {
        if (h.depth < 0.25) bands['0.02-0.25']++;
        else if (h.depth < 0.75) bands['0.25-0.75']++;
        else if (h.depth < 1.5) bands['0.75-1.5']++;
        else if (h.depth < 3) bands['1.5-3']++;
        else bands['3+']++;
      }
      const byKind = {};
      for (const h of impassable) byKind[h.kind] = (byKind[h.kind] ?? 0) + 1;
      const intrudeByKind = {};
      for (const h of intruders) intrudeByKind[h.kind] = (intrudeByKind[h.kind] ?? 0) + 1;
      const intrudingLot = intruders.filter((h) => h.kind !== 'landmark').length;
      const intrudingLm = intruders.length - intrudingLot;
      const worstDepthLot = intruders.filter((h) => h.kind !== 'landmark')[0]?.depth ?? 0;
      // Which BUILDINGS are responsible for the impassable directions — the
      // list to go and look at, and the one that says whether this is a long
      // tail or three bad actors.
      const blamed = new Map();
      for (const h of impassable) blamed.set(h.by, (blamed.get(h.by) ?? 0) + 1);
      // ...and which EMITTED PIECE did it, which is the actionable half.
      const parts = new Map();
      for (const h of impassable) parts.set(h.part, (parts.get(h.part) ?? 0) + 1);
      const intrudeParts = new Map();
      for (const h of intruders) intrudeParts.set(h.part, (intrudeParts.get(h.part) ?? 0) + 1);

      return {
        noclip: !!noclip,
        nokerb: !!nokerb,
        legacy: !!legacy,
        lmguard: !!lmguard,
        lanesReady: !!lanes?.ready,
        haveLayout: !!layout,
        harvestMs,
        tiles: useTiles.length,
        lotsSeen,
        planFail,
        buildingsBuilt,
        landmarksBuilt,
        triSeen,
        triKept,
        clipDropped: B.stats?.clipDropped ?? 0,
        clipTrimmed: B.stats?.clipTrimmed ?? 0,
        clipWhy: B._clipWhy ? { ...B._clipWhy } : null,
        kerbGuard: B.kerbGuard !== false,
        keptOut,
        // --- tier A
        intruding: intruders.length,
        intrudingLot,
        intrudingLm,
        worstDepth: intruders.length ? intruders[0].depth : 0,
        worstDepthLot,
        bands,
        intrudeByKind,
        worstIntruders: intruders.slice(0, 24),
        overhangers: overhangers.length,
        worstOverhang: overhangers.length
          ? overhangers.reduce((a, b) => (b.depth > a.depth ? b : a)).depth : 0,
        // --- tier B
        vehW,
        edgesSwept: roads.edges.filter((x) => !x.rail).length,
        dirsSwept: dirs.length,
        lanesSwept,
        lanesBlocked,
        laneSamples: NS,
        blockedSamples,
        dirsImpassable,
        dirsImpassableLot,
        dirsImpassableLm,
        impassableByKind: byKind,
        blamed: [...blamed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
        blockingParts: [...parts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
        overhang: [...overhang.entries()]
          .map(([k, v]) => [k, +v.max.toFixed(2), v.n])
          .sort((a, b) => b[1] - a[1])
          .slice(0, 18),
        intrudingParts: [...intrudeParts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
        worstImpassable: impassable.slice(0, 24),
        worstLanes: laneHits.slice(0, 24),
        thrown,
      };
    },
    {
      vehW: VEH_W,
      flush: FLUSH,
      roof: ROOF,
      step: STEP,
      tol: TOL,
      maxTiles: MAXTILES,
      noclip: !!args.noclip,
      nokerb: !!args.nokerb,
      legacy: !!args.legacyclip,
      lmguard: !!args.lmguard,
    }
  );
} catch (err) {
  failure = err;
} finally {
  await browser.close();
  server?.kill();
}

if (failure) {
  console.error('roadsweep failed:', failure.message);
  if (errors.length) console.error(errors.slice(0, 6).join('\n'));
  process.exit(2);
}
if (report?.error) {
  console.error('roadsweep:', report.error);
  if (errors.length) console.error(errors.slice(0, 6).join('\n'));
  process.exit(2);
}

if (args.json) {
  mkdirSync(dirname(resolve(String(args.json))), { recursive: true });
  writeFileSync(resolve(String(args.json)), JSON.stringify(report, null, 2));
}

const armBits = [];
if (report.noclip) armBits.push('_clipToStreets OFF');
if (report.legacy) armBits.push('legacy elevation gates + 0.7 m alley setback');
if (report.nokerb) armBits.push('kerb guard OFF');
const arm = armBits.length ? `NEGATIVE CONTROL — ${armBits.join(' + ')}` : 'shipped';
console.log(`buildings road sweep — ${arm}`);
console.log(`  lane layer ready:      ${report.lanesReady}   props.layout: ${report.haveLayout}`);
console.log(`  tiles / lots / built:  ${report.tiles} tiles, ${report.lotsSeen} lots, ` +
  `${report.buildingsBuilt} buildings + ${report.landmarksBuilt} landmarks`);
console.log(`  clip: ${report.clipDropped} dropped, ${report.clipTrimmed} trimmed   ` +
  `kerb guard: ${report.kerbGuard ? 'on' : 'OFF'}, ${report.keptOut} pieces dropped`);
console.log(`  triangles:             ${report.triKept} near a road of ${report.triSeen} emitted ` +
  `(${report.harvestMs} ms)`);
console.log('');
console.log('  TIER A — emitted geometry inside a drivable lane (props laneIntrusion)');
console.log(`    buildings intruding:   ${report.intruding} / ${report.buildingsBuilt + report.landmarksBuilt}` +
  `   (${report.intrudingLot} lot, ${report.intrudingLm} landmark)`);
console.log(`    worst intrusion:       ${report.worstDepth} m   (worst from a LOT: ${report.worstDepthLot} m)`);
console.log(`    over a lane, but ABOVE a vehicle: ${report.overhangers} building(s), ` +
  `worst reach ${report.worstOverhang} m  — awnings, cornices, decks. Not obstructions.`);
console.log('    depth bands:');
for (const [k, v] of Object.entries(report.bands)) {
  console.log(`      ${String(v).padStart(6)}  ${k} m`);
}
if (Object.keys(report.intrudeByKind).length) {
  console.log(`    by lot kind:           ${JSON.stringify(report.intrudeByKind)}`);
}
if (report.intrudingParts?.length) {
  console.log('    by emitted piece:');
  for (const [id, c] of report.intrudingParts) console.log(`      ${String(c).padStart(5)}  ${id}`);
}
for (const h of report.worstIntruders.slice(0, 10)) {
  console.log(`      ${h.depth.toFixed(2)} m  ${String(h.kind).padEnd(11)} @ ${h.x},${h.z}` +
    `  ${h.edge ? `${h.edge.kind} w${h.edge.w} #${h.edge.id}` : ''}  ${h.part}`);
}
console.log('');
console.log(`  TIER B — passability, ${report.vehW} m corridor centred on the lane centre`);
console.log(`    edges / directions:    ${report.edgesSwept} edges, ${report.dirsSwept} drivable directions`);
console.log(`    lane samples:          ${report.laneSamples} at ${STEP} m, ${report.blockedSamples} blocked`);
console.log(`    lanes with a block:    ${report.lanesBlocked} / ${report.lanesSwept}`);
console.log(`    DIRECTIONS IMPASSABLE: ${report.dirsImpassable} / ${report.dirsSwept}` +
  '   (every lane blocked at one station — the driver has nowhere to go)');
console.log(`      of which caused by a LOT:      ${report.dirsImpassableLot}   ` +
  '(this subsystem\'s placement — budget 0)');
console.log(`      of which caused by a LANDMARK: ${report.dirsImpassableLm}   ` +
  '(a road laid across an authored site — see BuildingSystem.landmarkGuard)');
if (Object.keys(report.impassableByKind).length) {
  console.log(`    by road class:         ${JSON.stringify(report.impassableByKind)}`);
}
if (report.blamed?.length) {
  console.log('    blamed on:');
  for (const [id, c] of report.blamed) console.log(`      ${String(c).padStart(5)}  ${id}`);
}
if (report.blockingParts?.length) {
  console.log('    by emitted piece:');
  for (const [id, c] of report.blockingParts) console.log(`      ${String(c).padStart(5)}  ${id}`);
}
if (report.worstImpassable.length) {
  console.log('    worst offenders:');
  for (const h of report.worstImpassable.slice(0, 12)) {
    console.log(`      ${String(h.free).padStart(5)} m free  ${String(h.kind).padEnd(9)} ` +
      `edge ${h.edge} w${h.width} ${h.lanes}L  @ ${h.x},${h.y},${h.z}  by ${h.by} [${h.part}]`);
  }
}
if (report.worstLanes.length) {
  console.log('    tightest single lanes:');
  for (const h of report.worstLanes.slice(0, 8)) {
    console.log(`      ${String(h.free).padStart(5)} m free  ${String(h.kind).padEnd(9)} ` +
      `edge ${h.edge} lane ${h.lane}  @ ${h.x},${h.y},${h.z}  by ${h.by}`);
  }
}
if (report.overhang?.length) {
  console.log('');
  console.log('  DIAGNOSTIC — how far below-bumper emitted geometry reaches beyond plan.foot');
  for (const [id, mx, n] of report.overhang) {
    console.log(`      ${String(mx).padStart(6)} m max  ${String(n).padStart(7)} tris  ${id}`);
  }
}
if (report.thrown?.length) console.log('  build errors:', report.thrown.slice(0, 6));
if (errors.length) console.log('  page errors:', [...new Set(errors)].slice(0, 4));

/**
 * THE ASSERTION.
 *
 * `IMPASSABLE` is the player's defect and its goal is genuinely 0: a drivable
 * direction with every lane blocked at one station is a road the graph promises
 * and the geometry refuses. There is no content trade-off behind it.
 *
 * `MAX_INTRUDING` and `MAX_DEPTH` are RATCHETs (ARCHITECTURE.md rule 13) — they
 * record where this pass got to, not where the bar is. The real goal for both
 * is 0. LOWER THEM WHEN YOU IMPROVE THEM; NEVER RAISE ONE TO GO GREEN.
 */
const MAX_IMPASSABLE = 0;
/**
 * WAS A RATCHET AT 114, AND IT LANDED. It counted drivable directions blocked
 * by a hand-authored landmark that `world`'s district grids were laid straight
 * through — `src/buildings/` could not lower it without deleting the landmark.
 * `world/netgen.js` now reserves the six sites it publishes in `plan.js`
 * (`reserveLandmarks`, a ring road on the reserve isoline, and the incline's
 * uphill bearing solved once and published instead of rediscovered), and
 * `src/world/lmsweep.mjs` gates the reservation off the emitted graph.
 *
 * Measured, same shot, nothing else changed: 114 -> 0 impassable directions
 * and 5 -> 0 intruding landmarks. It is a hard 0 now, like the LOT budget, and
 * there is no content trade-off left behind it. Never raise it.
 */
const MAX_IMPASSABLE_LM = 0;
const MAX_INTRUDING = Number(args.maxintruding ?? 0);
const MAX_DEPTH = Number(args.maxdepth ?? 0.0);
/** Same story as MAX_IMPASSABLE_LM: was 5 authored sites with roads through them. */
const MAX_INTRUDING_LM = 0;

const fails = [];
if (report.dirsImpassableLot > MAX_IMPASSABLE) {
  fails.push(`${report.dirsImpassableLot} impassable direction(s) caused by a LOT (max ${MAX_IMPASSABLE})`);
}
if (report.dirsImpassableLm > MAX_IMPASSABLE_LM) {
  fails.push(`${report.dirsImpassableLm} impassable direction(s) caused by a LANDMARK (RATCHET ${MAX_IMPASSABLE_LM})`);
}
if (report.intrudingLot > MAX_INTRUDING) {
  fails.push(`${report.intrudingLot} intruding LOT building(s) (max ${MAX_INTRUDING})`);
}
if (report.worstDepthLot > MAX_DEPTH) {
  fails.push(`worst LOT intrusion ${report.worstDepthLot} m (max ${MAX_DEPTH} m)`);
}
if (report.intrudingLm > MAX_INTRUDING_LM) {
  fails.push(`${report.intrudingLm} intruding LANDMARK(s) (RATCHET ${MAX_INTRUDING_LM})`);
}
console.log('');
if (fails.length === 0) {
  console.log('ROAD GATE PASSED — nothing this subsystem PLACES stands in a drivable lane, and '
    + `every drivable direction not crossing an authored landmark site has a clear ${report.vehW} m `
    + 'corridor end to end.');
  if (report.dirsImpassableLm) {
    console.log(`  NOT FIXED HERE: ${report.dirsImpassableLm} direction(s) blocked by ` +
      `${report.intrudingLm} hand-authored landmark(s). world/netgen.js reserves the six ` +
      'landmark sites it publishes in world/plan.js; a residual here means a landmark has ' +
      'outgrown its published `site` and the site needs re-measuring, not the guard turning on.');
  }
} else {
  console.log(`ROAD GATE FAILED — ${fails.join('; ')}`);
}
process.exit(fails.length === 0 ? 0 : 1);
