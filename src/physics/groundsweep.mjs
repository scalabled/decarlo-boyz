#!/usr/bin/env node
/**
 * GROUND SWEEP — how much of the city can physics actually see?
 *
 *   node src/physics/groundsweep.mjs            # 25 m grid over the whole city
 *   node src/physics/groundsweep.mjs --step=50  # coarser, faster
 *   node src/physics/groundsweep.mjs --map      # ASCII map of the holes
 *   node src/physics/groundsweep.mjs --noproxy  # the BEFORE state, for A/B
 *   node src/physics/groundsweep.mjs --flat     # the pre-fix flat BVH, for A/B
 *
 * WHY THIS EXISTS. `weapons` measured that at (-504, 432) a downward
 * `MASK.BULLET` ray finds nothing in 200 m and `groundHeight` returns null.
 * That is not a point defect: `world` keeps real triangle collision only
 * within `TCOL_HALF` of the camera, so most of the map has none at any
 * instant. Projectiles fly through the floor, explosives never detonate, AI
 * shooting from range hits nothing — silently, with no error anywhere.
 *
 * This drives the real build in a real browser and reports, on a grid over the
 * whole city, BOTH failure modes:
 *   1. can a MASK.BULLET ray find ground here?      (ballistics)
 *   2. would a dropped capsule find a floor here?   (falling through the world)
 * They have different answers, because the ray path can consult `world`'s
 * analytic surface and a capsule sweep cannot.
 *
 * Reference points, 50 m grid, same build:
 *   TCOL_HALF 192, no fallback ...  9.2% ray / 9.4% capsule
 *   TCOL_HALF 320, no fallback ... 11.2% ray / 11.2% capsule   (--noproxy)
 *   TCOL_HALF 320, fallback ......  100% ray
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const STEP = Number(args.step ?? 25);
const SHOW_MAP = !!args.map;
const FROM_Y = Number(args.fromY ?? 400);
const MAX_DIST = Number(args.maxDist ?? 900);

const { port, server } = await startServer({ explicitPort: args.port });
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
const physLines = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[physics]')) physLines.push(`${m.type()}: ${t.slice(0, 220)}`);
});

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

try {
  // `--noproxy` boots with the always-resident floor switched off, which is
  // the BEFORE state. Keep it: a fix you cannot un-apply is a fix you cannot
  // prove, and this is the one number that proves it.
  // `--flat` boots the pre-fix single-tree BVH (see src/physics/bvh.js), so
  // the coverage numbers can be paired against the structure they replaced.
  const qs = [];
  if (args.noproxy) qs.push('nogroundproxy=1');
  if (args.flat) qs.push('owbvh=flat');
  const q = qs.length ? `?${qs.join('&')}` : '';
  await page.goto(`http://127.0.0.1:${port}/${q}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await pump(150);

  const out = await page.evaluate(
    ({ STEP, FROM_Y, MAX_DIST }) => {
      const e = window.__ENGINE__;
      const phys = e.ctx.peek('physics');
      const world = e.ctx.peek('world');
      if (!phys || !world) return { error: 'physics or world missing' };
      const SIZE = world.CITY_SIZE ?? 3000;
      const H = SIZE / 2;
      const n = Math.floor(SIZE / STEP) + 1;

      const camXZ = [e.ctx.camera.position.x, e.ctx.camera.position.z];
      // `heightAt` is the TERRAIN, which is sunk ~0.55 m under every road
      // corridor. `walkableHeightAt` is the surface a man actually stands on,
      // and is what physics answers with, so it is the right reference.
      const REF = typeof world.walkableHeightAt === 'function'
        ? (x, z) => world.walkableHeightAt(x, z)
        : (x, z) => world.heightAt(x, z);

      const BULLET = phys.MASK.BULLET;
      const WORLD = phys.MASK.WORLD;

      let miss = 0, total = 0, missWorld = 0;
      /**
       * The CHARACTER CONTROLLER's answer, which is a different code path from
       * the ray: `capsuleCast` sweeps the BVH directly and gets none of the
       * analytic refinement. A proxy that catches bullets but is not in
       * MASK.CHARACTER would fix combat and still drop the player through the
       * floor, so both are measured.
       */
      let capMiss = 0;
      let capSunk = 0;
      const CH = phys.MASK.CHARACTER;
      const p0 = { x: 0, y: 0, z: 0 }, p1 = { x: 0, y: 0, z: 0 }, dn0 = { x: 0, y: -1, z: 0 };
      let errSum = 0, errMax = 0, errN = 0;
      /** Hits that land BELOW the visible ground — a proxy surfacing too low. */
      let sunk = 0;
      const errs = [];
      const grid = new Uint8Array(n * n);       // 0 = hole, 1 = hit
      const t0 = performance.now();
      for (let j = 0; j < n; j++) {
        const z = -H + j * STEP;
        for (let i = 0; i < n; i++) {
          const x = -H + i * STEP;
          total++;
          const h = phys.raycast(x, FROM_Y, z, 0, -1, 0, MAX_DIST, BULLET);
          if (!h.hit) { miss++; } else {
            grid[j * n + i] = 1;
            const ref = REF(x, z);
            if (Number.isFinite(ref)) {
              const d = h.point.y - ref;
              errSum += Math.abs(d);
              errs.push(Math.abs(d));
              if (d < -0.5) sunk++;
              if (Math.abs(d) > Math.abs(errMax)) errMax = d;
              errN++;
            }
          }
          const g = phys.groundHeight(x, z, FROM_Y, WORLD);
          if (!Number.isFinite(g)) missWorld++;

          // Drop a player-sized capsule from 6 m up and see if it lands.
          const ref2 = REF(x, z);
          const base = (Number.isFinite(ref2) ? ref2 : 0) + 6;
          p0.x = p1.x = x; p0.z = p1.z = z;
          p0.y = base + 0.4; p1.y = base + 1.4;
          const cc = phys.capsuleCast(p0, p1, 0.4, dn0, 260, CH);
          if (!cc.hit) capMiss++;
          else if (Number.isFinite(ref2) && (base + 0.4 - cc.distance) - ref2 < -8) capSunk++;
        }
      }
      const ms = performance.now() - t0;

      // Ring profile: coverage as a function of distance from the camera.
      const rings = [];
      for (const r of [64, 128, 192, 256, 384, 512, 768, 1024, 1536, 4096]) rings.push({ r, hit: 0, n: 0 });
      for (let j = 0; j < n; j++) {
        const z = -H + j * STEP;
        for (let i = 0; i < n; i++) {
          const x = -H + i * STEP;
          const d = Math.hypot(x - camXZ[0], z - camXZ[1]);
          for (const rr of rings) {
            if (d <= rr.r) { rr.n++; if (grid[j * n + i]) rr.hit++; break; }
          }
        }
      }

      /* ---- road + kerb continuity ------------------------------------ */
      // `traffic` reports 13.9% of samples with a wheel past the kerb. A kerb
      // that is not in the collision world cannot stop anything, so: walk the
      // road graph, and at each sample fire (a) a ray down for a carriageway,
      // and (b) a ray sideways at kerb height for something to hit.
      const road = { n: 0, ground: 0, asphalt: 0, kerb: 0, byDist: [], byKind: {} };
      const bands = [256, 512, 768, 1024, 1536, 4096];
      for (const r of bands) road.byDist.push({ r, n: 0, ground: 0, kerb: 0 });
      const edges = world.roads?.edges ?? [];
      const P = { x: 0, y: 0, z: 0 };
      const Q = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (!e) continue;
        for (let k = 1; k <= 3; k++) {
          const t = k / 4;
          let c;
          try { c = world.roads.laneCenter(e, 0, t, P); } catch { continue; }
          if (!c) continue;
          let c2;
          try { c2 = world.roads.laneCenter(e, 0, Math.min(0.99, t + 0.02), Q); } catch { continue; }
          const tx = c2.x - c.x, tz = c2.z - c.z;
          const tl = Math.hypot(tx, tz) || 1;
          const sx = -tz / tl, sz = tx / tl;      // lane normal, in plan
          const hw = (e.width ? e.width / 2 : (e.lanes ?? 2) * 1.75) + 0.2;

          const dn = phys.raycast(c.x, c.y + 40, c.z, 0, -1, 0, 80, WORLD);
          const dist = Math.hypot(c.x - camXZ[0], c.z - camXZ[1]);
          const band = road.byDist.find((b) => dist <= b.r) ?? road.byDist[road.byDist.length - 1];
          const kind = e.kind ?? 'street';
          const bk = (road.byKind[kind] ??= { n: 0, ground: 0, kerb: 0, real: 0, near: 0, nearKerb: 0, nearReal: 0, stepAt: 0, stepN: 0 });
          road.n++; band.n++; bk.n++;
          if (dist <= 512) bk.near++;
          if (dn.hit) {
            road.ground++; band.ground++; bk.ground++;
            // A real road collider is a named mesh from `world`; a null object
            // means the hit came from the analytic terrain — bare ground where
            // the carriageway should be.
            if (/road_col|bridge/i.test(dn.object?.name ?? '')) {
              road.asphalt++; bk.real++;
              if (dist <= 512) bk.nearReal++;
            }
            // Is there a STEP at the kerb line in the collision world? Camber
            // makes a horizontal probe unreliable and `edge.width` is ambiguous,
            // so walk a height PROFILE outward from the lane centre and look for
            // the first rise a wheel would have to climb. Kind-agnostic.
            for (let d = 2; d <= 14; d += 0.5) {
              const up = phys.raycast(
                c.x + sx * d, dn.point.y + 6, c.z + sz * d, 0, -1, 0, 12, WORLD
              );
              if (!up.hit) continue;
              if (up.point.y - dn.point.y > 0.08) {
                road.kerb++; band.kerb++; bk.kerb++;
                bk.stepAt += d; bk.stepN++;
                if (dist <= 512) bk.nearKerb++;
                break;
              }
            }
          }
        }
      }

      /* ---- what the fallback costs ----------------------------------- */
      // Paired in ONE page session, so streaming state is identical on both
      // sides. `perfcheck` cannot resolve this: on this machine it swings
      // 35-74 fps across identical builds and the second run of any pair is
      // slower than the first regardless of which build it is.
      const cost = {};
      {
        const timeRays = (n) => {
          const a = performance.now();
          let hits = 0;
          for (let i = 0; i < n; i++) {
            const x = -1400 + (i * 37) % 2800;
            const z = -1400 + (i * 61) % 2800;
            if (phys.raycast(x, 300, z, 0.15, -0.98, 0.1, 700, BULLET).hit) hits++;
          }
          return { ms: performance.now() - a, hits, n };
        };
        const near = (n) => {
          const a = performance.now();
          let hits = 0;
          for (let i = 0; i < n; i++) {
            const x = camXZ[0] + ((i * 13) % 200) - 100;
            const z = camXZ[1] + ((i * 29) % 200) - 100;
            if (phys.raycast(x, 200, z, 0, -1, 0, 400, BULLET).hit) hits++;
          }
          return { ms: performance.now() - a, hits, n };
        };
        const armed = phys.ground.ready;
        const far1 = timeRays(4000);
        const near1 = near(4000);
        cost.far = +far1.ms.toFixed(1);
        cost.farHits = far1.hits;
        cost.near = +near1.ms.toFixed(1);
        cost.nearHits = near1.hits;
        cost.armed = armed;
        cost.fallbackHits = phys.ground.hits;
        cost.tris = phys.staticWorld.triCount;
      }

      /* ---- does anything downstream care? ---------------------------- */
      // `playprobe` swings 17-20/20 on this machine under load, so the only
      // honest way to attribute a change is to A/B the same quantities in one
      // harness. Traffic and vehicles both refuse to place a car where
      // `groundHeight` has no answer, so count what actually got placed.
      const veh = e.ctx.peek('vehicles');
      const traf = e.ctx.peek('traffic');
      const pl = e.ctx.peek('player');
      const pp = pl?.position;
      const near = veh?.nearest && pp ? veh.nearest(pp.x, pp.y, pp.z, 400) : null;
      const downstream = {
        vehicles: veh?.vehicles?.length ?? veh?.list?.length ?? null,
        trafficDrivers: traf?.drivers?.length ?? null,
        nearestVehM: near && pp ? +Math.hypot(near.position.x - pp.x, near.position.z - pp.z).toFixed(1) : null,
        playerY: pp ? +pp.y.toFixed(2) : null,
        playerGroundY: pp ? +phys.groundHeight(pp.x, pp.z, pp.y + 6).toFixed(2) : null,
      };

      // The exact point `weapons` reported: a 200 m bullet ray from head height
      // above the terrain there, which used to find nothing at all.
      const ref504 = REF(-504, 432);
      const probe = phys.raycast(-504, ref504 + 180, 432, 0, -1, 0, 200, BULLET);
      const probeGround = phys.groundHeight(-504, 432);

      return {
        n, STEP, SIZE, total, miss, missWorld, ms: +ms.toFixed(0),
        camXZ: camXZ.map((v) => +v.toFixed(1)),
        coverage: +(100 * (1 - miss / total)).toFixed(2),
        capCoverage: +(100 * (1 - capMiss / total)).toFixed(2),
        capMiss, capSunk,
        coverageWorld: +(100 * (1 - missWorld / total)).toFixed(2),
        errMean: errN ? +(errSum / errN).toFixed(3) : null,
        errP50: errN ? +errs.sort((a, b) => a - b)[errs.length >> 1].toFixed(3) : null,
        errP95: errN ? +errs[Math.floor(errs.length * 0.95)].toFixed(3) : null,
        errMax: +errMax.toFixed(3),
        sunk, sunkPct: errN ? +(100 * sunk / errN).toFixed(2) : null,
        rings: rings.filter((r) => r.n > 0).map((r) => ({ r: r.r, pct: +(100 * r.hit / r.n).toFixed(1), n: r.n })),
        probeHit: probe.hit,
        probeY: probe.hit ? +probe.point.y.toFixed(2) : null,
        probeGround: Number.isFinite(probeGround) ? +probeGround.toFixed(2) : null,
        probeRef: +REF(-504, 432).toFixed(2),
        tris: phys.stats.triangles,
        grid: Array.from(grid),
        road, cost, downstream,
        physLog: phys.worldHoleCount ?? null,
        physLogReady: phys.worldHolesAfterReady ?? null,
        rejected: phys.rejectedStatics ?? null,
        truncContacts: phys.staticWorld.truncations?.contacts ?? 0,
        truncTraversal: phys.staticWorld.truncations?.traversal ?? 0,
        proxyReady: !!phys.ground?.ready,
      };
    },
    { STEP, FROM_Y, MAX_DIST }
  );

  if (out.error) throw new Error(out.error);

  const bar = '─'.repeat(66);
  console.log(bar);
  console.log(`GROUND SWEEP  ${out.SIZE} m city, ${out.STEP} m grid, ${out.n}x${out.n} = ${out.total} samples`);
  console.log(`camera at (${out.camXZ[0]}, ${out.camXZ[1]}) · ${out.tris} collision triangles · ${out.ms} ms`);
  console.log(bar);
  console.log(`MASK.BULLET downward ray finds ground : ${out.coverage}%   (${out.miss} holes)`);
  console.log(`groundHeight() returns a finite floor : ${out.coverageWorld}%   (${out.missWorld} holes)`);
  console.log(
    `a dropped CAPSULE (MASK.CHARACTER) lands  : ${out.capCoverage}%   (${out.capMiss} fall through)`
  );
  console.log(
    '  ^ capsule sweeps are triangles only, by design: `world` owns static collision and keeps\n' +
    '    it within TCOL_HALF of the camera. The analytic surface closes the RAY path (bullets,\n' +
    '    explosions, wheel probes, groundHeight, spawn placement); it cannot close a sweep.'
  );
  console.log(
    `vs world.walkableHeightAt(): median |err| ${out.errP50} m, p95 ${out.errP95} m, ` +
    `mean ${out.errMean} m, worst ${out.errMax} m`
  );
  console.log(`hits more than 0.5 m BELOW the visible ground: ${out.sunkPct}%  (${out.sunk})`);
  console.log(
    `ground fallback: ${out.proxyReady ? 'ARMED' : 'DISABLED'} · ` +
    `silent holes: ${out.physLog} total, ${out.physLogReady} after it armed ` +
    `(must be 0) · statics rejected ${out.rejected} · truncated queries ${out.truncContacts}/${out.truncTraversal}`
  );
  console.log('');
  console.log('coverage by distance from camera:');
  let prev = 0;
  for (const r of out.rings) {
    const label = r.r > 3000 ? `  >${prev} m` : `${prev}-${r.r} m`;
    console.log(`  ${label.padStart(12)}  ${String(r.pct).padStart(5)}%   (${r.n} samples)`);
    prev = r.r;
  }
  console.log('');
  console.log(
    `ray cost (${out.cost.tris} collision triangles resident):\n` +
    `  4000 rays across the whole map : ${out.cost.far} ms, ${out.cost.farHits} hit\n` +
    `  4000 rays within 100 m of the camera : ${out.cost.near} ms, ${out.cost.nearHits} hit\n` +
    `  answered analytically rather than by a triangle, all-time: ${out.cost.fallbackHits}`
  );
  console.log('');
  console.log(
    `downstream: ${out.downstream.vehicles} vehicles, ${out.downstream.trafficDrivers} traffic drivers, ` +
    `nearest car ${out.downstream.nearestVehM} m · player y ${out.downstream.playerY} over ground ${out.downstream.playerGroundY}`
  );
  console.log('');
  console.log(`road graph: ${out.road.n} lane samples`);
  console.log(
    `  carriageway has a collider : ${(100 * out.road.ground / out.road.n).toFixed(1)}%` +
    `   (of those, ${(100 * out.road.asphalt / Math.max(1, out.road.ground)).toFixed(1)}% is real road ` +
    `collision — the rest is bare terrain under the carriageway)`
  );
  console.log(`  a kerb STEP exists in collision: ${(100 * out.road.kerb / out.road.n).toFixed(1)}%`);
  for (const [k, v] of Object.entries(out.road.byKind)) {
    console.log(
      `    ${k.padEnd(10)} kerb ${String((100 * v.kerb / v.n).toFixed(1)).padStart(5)}% overall, ` +
      `${String((100 * v.nearKerb / Math.max(1, v.near)).toFixed(1)).padStart(5)}% within 512 m · ` +
      `road collider ${String((100 * v.nearReal / Math.max(1, v.near)).toFixed(1)).padStart(5)}% within 512 m · step at ${v.stepN ? (v.stepAt / v.stepN).toFixed(1) : '--'} m   (${v.n} samples)`
    );
  }
  let rp = 0;
  for (const bnd of out.road.byDist) {
    if (!bnd.n) continue;
    const label = bnd.r > 3000 ? `  >${rp} m` : `${rp}-${bnd.r} m`;
    console.log(
      `  ${label.padStart(12)}  ground ${String((100 * bnd.ground / bnd.n).toFixed(1)).padStart(5)}%` +
      `   kerb ${String((100 * bnd.kerb / bnd.n).toFixed(1)).padStart(5)}%   (${bnd.n})`
    );
    rp = bnd.r;
  }
  console.log('');
  console.log(`weapons' reported point (-504, 432):`);
  console.log(`  bullet ray hit : ${out.probeHit}${out.probeY != null ? ` at y=${out.probeY}` : ''}`);
  console.log(`  groundHeight   : ${out.probeGround ?? 'NO FLOOR'}`);
  console.log(`  world.walkable : ${out.probeRef}`);

  if (SHOW_MAP) {
    console.log('');
    console.log('hole map (# = ground, . = HOLE), north up, 1 char per grid cell:');
    const n = out.n;
    const stride = Math.max(1, Math.ceil(n / 100));
    for (let j = n - 1; j >= 0; j -= stride) {
      let line = '';
      for (let i = 0; i < n; i += stride) line += out.grid[j * n + i] ? '#' : '.';
      console.log('  ' + line);
    }
  }
  if (physLines.length) {
    console.log('');
    console.log('physics console:');
    const real = physLines.filter((l) => l.includes('IS resident'));
    for (const l of physLines.filter((l) => l.includes('ground proxy')).slice(0, 2)) console.log('  ' + l);
    for (const l of physLines.slice(0, 4)) console.log('  ' + l);
    for (const l of real) console.log('  !! ' + l);
  }
  console.log(bar);
  if (errs.length) console.log(`page errors: ${errs.slice(0, 4).join(' | ')}`);

  // Non-zero exit once coverage is expected to be complete.
  process.exitCode = out.coverage >= 99.5 ? 0 : 1;
} catch (e) {
  console.error('groundsweep failed:', e.message);
  if (errs.length) console.error(errs.slice(0, 6).join('\n'));
  process.exitCode = 2;
} finally {
  await b.close();
  server?.kill();
}
