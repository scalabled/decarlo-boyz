#!/usr/bin/env node
/**
 * TRAFFIC — headless behaviour harness.
 *
 * A still frame cannot tell you whether your drivers are any good. This runs
 * the real game, headless, at a fixed 1/60 s step for minutes of simulated
 * time, watches every car every frame, and asserts on what it saw:
 *
 *   intersect   no two vehicles may overlap (OBB, and the sphere model the
 *               physics actually resolves against)
 *   offroad     no car may leave the carriageway
 *   stuck       no car may sit still forever
 *   junctions   throughput through signalised/give-way nodes must be non-zero
 *   speeding    nobody may exceed the limit for their road kind by much
 *   weave       steering must not oscillate — a weaving car reads as broken
 *   nan         no non-finite transform, ever
 *
 * Usage
 *   node src/traffic/harness.mjs                        (60 s, downtown, high)
 *   node src/traffic/harness.mjs --minutes=3 --q=ultra
 *   node src/traffic/harness.mjs --site=steelrow --hour=4
 *   node src/traffic/harness.mjs --render=1             (draw frames too)
 *   node src/traffic/harness.mjs --json=/tmp/tr.json
 *   node src/traffic/harness.mjs --isolate              (silence police)
 *   node src/traffic/harness.mjs --control              (NEGATIVE CONTROL:
 *       run the live build with the derby fixes' debug hatches flipped —
 *       trap refusal, recovery cap, lane adoption and the queue-head wedge
 *       resolver all off. The carriageway, lane-keeping and collision-rate
 *       checks must go red under it.)
 *   node src/traffic/harness.mjs --noresolver           (NEGATIVE CONTROL for
 *       the wedge resolver alone: flips only debugNoWedgeResolver, so the
 *       round-1 welded-pair deadlock class comes back while every other fix
 *       stays live. "nobody stopped forever" must go red under it on a tree
 *       where the wedge manifests.)
 *
 * The engine is booted with `?capture=1&lockstep=1`, so it never schedules a
 * frame of its own and `engine.step()` advances exactly 1/60 s. That makes the
 * run reproducible AND lets us step far faster than real time.
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

/** Where to stand. All on real roads, chosen for what they stress. */
const SITES = {
  downtown: { near: [-232, 64], doc: 'Golden Triangle grid — signals, queues, density' },
  liberty: { near: [-160, 80], doc: 'Liberty Avenue — the green wave down an arterial' },
  steelrow: { near: [784, 384], doc: 'Steel Row — trucks, sparse, industrial' },
  lawren: { near: [680, -552], doc: 'Lawrenceville — tight residential grid, give-way' },
  southside: { near: [160, 608], doc: 'South Side — Carson Street arterial' },
  bridge: { near: [-150, -20], doc: 'Sixth Street Bridge approach — a chokepoint' },
  mtwash: { near: [-528, 464], doc: 'Mt. Washington — hills and bends' },
};

const MINUTES = Number(args.minutes ?? 1);
const FRAMES = Math.round(MINUTES * 60 * 60);
const CHUNK = Number(args.chunk ?? 120);
const QUALITY = args.q ?? 'high';
const SITE = SITES[args.site ?? 'downtown'] ?? SITES.downtown;
const HOUR = args.hour !== undefined ? Number(args.hour) : 17.2;
const RENDER = args.render === '1' || args.render === true;
const W = Number(args.w ?? 640);
const H = Number(args.h ?? 360);

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
  args: [
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--disable-frame-rate-limit',
    '--mute-audio',
    '--js-flags=--max-old-space-size=4096',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(`${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

let failure = null;
let report = null;
try {
  await page.goto(`http://127.0.0.1:${PORT}/?capture=1&lockstep=1&prewarm=0&q=${QUALITY}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });

  // Put the camera on a real road at the chosen site and hour.
  const applied = await page.evaluate(
    ({ near, hour }) =>
      window.__APPLY_SHOT__(
        JSON.stringify({
          pos: [near[0], 5.5, near[1] + 30],
          look: [near[0], 4, near[1]],
          fov: 62,
          time: hour,
          ground: true,
          onRoad: { near, eye: 5.0, ahead: 0.3 },
        }),
        { grabFrame: 1 }
      ),
    { near: SITE.near, hour: HOUR }
  );
  if (applied?.error) throw new Error(`shot: ${applied.error}`);

  /**
   * MOVE THE PLAYER OFF THE CARRIAGEWAY.
   *
   * `onRoad` shots put the camera — and with it the player's capsule — on the
   * lane centreline. A solid body standing in a live traffic lane is a hazard
   * every driver brakes for, so the block in front of the harness camera
   * became a permanent pile-up: 4830 panic stops and 314 write-offs in sixty
   * seconds, all inside one twenty-metre square, all of them an artefact of
   * where the test rig was standing. Traffic has to be measured from the
   * pavement.
   */
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    const w = e.ctx.peek('world');
    const player = e.ctx.peek('player');
    const cam = e.camera;
    const hit = w?.roads?.nearestEdge?.(cam.position.x, cam.position.z);
    if (!hit?.edge || !player?.teleport) return;
    const half = hit.edge.width * 0.5 + 2.6;
    const nx = -hit.edge.dz;
    const nz = hit.edge.dx;
    const p = cam.position.clone();
    p.x += nx * half;
    p.z += nz * half;
    p.y = (w.groundHeight?.(p.x, p.z) ?? p.y) + 1.2;
    player.teleport(p, cam.rotation);
  });

  // Let the city stream in around the new camera before judging anybody.
  await page.evaluate(async () => {
    const e = window.__ENGINE__;
    for (let i = 0; i < 900; i++) {
      e.step();
      if (window.__SETTLED__?.() === true && i > 120) break;
    }
  });

  await page.evaluate((r) => { window.__TRAFFIC_RENDER__ = r; }, RENDER);
  /**
   * `--control` is the NEGATIVE CONTROL for the derby fixes: it flips the
   * three debug hatches (`lanes.debugNoTrapGuard`, `debugNoRecoverCap`,
   * `debugNoLaneAdopt`) so the fleet runs the pre-fix behaviour against the
   * LIVE code, no edit needed. The off-carriageway, lane-keeping and
   * collision-rate checks below must go red under it, or they are decorative.
   */
  if (args.control) {
    await page.evaluate(() => {
      const t = window.__ENGINE__.ctx.peek('traffic');
      t.debugNoRecoverCap = true;
      t.debugNoLaneAdopt = true;
      t.debugNoWedgeResolver = true;
      t.lanes.debugNoTrapGuard = true;
      if (t.lanes._trap) t.lanes._trap.fill(0);
    });
  }
  if (args.noresolver) {
    await page.evaluate(() => {
      window.__ENGINE__.ctx.peek('traffic').debugNoWedgeResolver = true;
    });
  }
  /**
   * `--isolate` silences `police` so the traffic controller can be measured on
   * its own. Sirens are a legitimate input, but a pursuit driving through the
   * measurement window dominates every statistic in it.
   */
  if (args.isolate) {
    await page.evaluate(() => {
      const e = window.__ENGINE__;
      const pol = e.ctx.peek('police');
      if (pol) { pol.update = () => {}; if (pol.fixedUpdate) pol.fixedUpdate = () => {}; if (pol.lateUpdate) pol.lateUpdate = () => {}; }
      const veh = e.ctx.peek('vehicles');
      for (const v of [...veh.vehicles]) if (v.type === 'police') veh.despawn(v);
    });
  }
  await page.evaluate(installProbe);

  const series = [];
  let done = 0;
  const t0 = Date.now();
  while (done < FRAMES) {
    const n = Math.min(CHUNK, FRAMES - done);
    const s = await page.evaluate((k) => window.__TRAFFIC_PROBE__.run(k), n);
    series.push(s);
    done += n;
    if (args.quiet !== true && series.length % 10 === 0) {
      process.stderr.write(
        `\r  ${((done / FRAMES) * 100).toFixed(0)}%  cars=${s.cars} ` +
        `v=${s.meanKmh.toFixed(0)}km/h  ms=${s.ms.toFixed(2)}   `
      );
    }
  }
  if (args.quiet !== true) process.stderr.write('\n');
  const wall = (Date.now() - t0) / 1000;

  report = await page.evaluate(() => window.__TRAFFIC_PROBE__.report());
  report.site = String(args.site ?? 'downtown');
  report.series = series;
  report.wallSeconds = +wall.toFixed(1);
  report.simSeconds = +(FRAMES / 60).toFixed(1);
  report.speedup = +(FRAMES / 60 / wall).toFixed(2);
  report.errors = errors.slice(0, 10);
} catch (e) {
  failure = e;
} finally {
  await browser.close();
  server.kill();
}

if (failure) {
  console.error(`[harness] FAILED: ${failure.message}`);
  if (errors.length) console.error(errors.slice(0, 10).join('\n'));
  process.exit(1);
}

/* ------------------------------------------------------------------ output */

const R = report;
const F = [];
const check = (ok, name, detail) => {
  F.push({ ok, name, detail });
  return ok;
};

check(R.nan === 0, 'no NaN transforms', `${R.nan} frames with a non-finite pose`);
check(
  R.intersect.drivenMax < 0.35,
  'no vehicle interpenetration',
  `worst overlap involving a driver ${R.intersect.drivenMax.toFixed(3)} m over ` +
    `${R.intersect.drivenFrames} frames; any-pair worst ${R.intersect.sphereMax.toFixed(2)} m\n        ` +
      `${JSON.stringify(R.intersect.drivenPair)} kinds=${JSON.stringify(R.intersect.pairKinds)}`
);
/**
 * RATCHET at 2.2 — the goal is the original 1.5. MEASURED before the derby
 * fixes (trap refusal, recovery speed cap, lane adoption; downtown, budget
 * 38): 3.59% at 2 min, 5.11% under `--control` at 3 min. After round 1:
 * 2.24% downtown at 2 min. After round 2 (probe scenery-filter fix, tighter
 * recovery cap, spawn wall probe): 1.46-1.62% downtown at 3 min vs 2.72%
 * under `--control`, so the ratchet comes DOWN from 2.6. LOWER this when you
 * improve it; never raise it to make a run green (ARCHITECTURE.md rule 13).
 */
check(
  R.offroad.pct < 2.2,
  'cars stay on the carriageway (RATCHET 2.2, goal 1.5)',
  `${R.offroad.pct.toFixed(2)}% of samples with a wheel past the kerb, worst ${R.offroad.max.toFixed(2)} m over` +
    (R.offroad.worst ? ` [${JSON.stringify(R.offroad.worst)}]` : '')
);
/**
 * LANE KEEPING IS NOW MEASURED AGAINST THE EMITTED LANE GEOMETRY (rule 12):
 * the DRAWN car's distance to the nearest usable lane centre of the road
 * graph, travel direction taken from the drawn heading — see `laneErrOf` in
 * the probe. The old metric read `d.diag.lat`, the controller's own
 * cross-track belief, and the round-1 lane-adoption fix REWRITES that belief
 * mid-block — a gate reading it back was comparing the controller to itself
 * (the eighth instance of the rule-12 disease, caught before it shipped a
 * number: belief p95 read 4.6-6.2 while the emitted error's p95 was 7.8).
 *
 * THREE clauses, because the fixed and control arms separate differently on
 * the emitted quantity — MEASURED downtown, 3 min, budget 38, round-2 fixes:
 *
 *              p95      max     cars ever >10 m off
 *   fixed      5.05    16.35     4/27
 *   --control  6.12    41.43    16/27
 *
 * The control arm's p95 is BARELY worse than the fixed arm's, because a
 * reckless fleet crosses its off-lane distance quickly (few samples, huge
 * errors) while a careful one crawls back at the recovery cap (many samples,
 * bounded errors) — p95 integrates exposure, so it must never be this
 * check's only clause. `max` and the >10 m car count are what the fixes
 * actually buy: nobody tens of metres from any lane.
 *
 * p95 RATCHET 6.0 (goal 0.85, a car inside its own lane); max 25; bad cars
 * a third of the fleet. LOWER the ratchet when you improve it; never raise
 * it to make a run green (ARCHITECTURE.md rule 13).
 */
check(
  R.laneKeep.p95 < 6.0 && R.laneKeep.max < 25 &&
    R.laneKeep.badCars <= R.laneKeep.totalCars / 3,
  'lane keeping vs EMITTED lanes (RATCHET p95 6.0, goal 0.85)',
  `mean |lat| ${R.laneKeep.mean.toFixed(2)} m, p95 ${R.laneKeep.p95.toFixed(2)} m, max ${R.laneKeep.max.toFixed(2)} m (cap 25)\n        ` +
    `p50 ${R.laneKeep.p50.toFixed(2)} p75 ${R.laneKeep.p75.toFixed(2)} p90 ${R.laneKeep.p90.toFixed(2)} p99 ${R.laneKeep.p99.toFixed(2)}; ` +
    `${R.laneKeep.badCars}/${R.laneKeep.totalCars} cars ever >10 m off (cap 1/3)\n        ` + JSON.stringify(R.laneKeep.worst)
);
/**
 * RATCHET at 0.55 (was 0.75) — collision events (impulse > 2x mass) per
 * driver-minute across the whole fleet, the "crash-up derby" number. The
 * goal is well under 0.1. MEASURED downtown, budget 38, 3 min, this round:
 * 0.348-0.472 across code rolls vs 0.697 under `--control`.
 *
 * TWO facts a future editor needs before touching this number:
 *
 * 1. WHAT IS IN IT. Bucketing (see `hitBuckets`) showed the round-1 number
 *    was 33/35 car-vs-WORLD, not car-vs-car. Round 2 cut the driver-caused
 *    share: the forward probe's scenery filter no longer discards obstacles
 *    in front of an OFF-LANE car (13/35 hits carried the off-lane tag), the
 *    recovery cap is tighter (9.0/1.8), and spawns cast a wall ray before
 *    materialising (5/35 were sub-5 s-old cars aimed at bridge abutments).
 *    Car-vs-car is now ~1 rear-end per 80 driver-minutes. The residual is
 *    world-geometry conflict: road-collider TILE SEAMS firing near-vertical
 *    impulses (normal.y ~1) under in-lane cars at legal speed on a junction
 *    approach, and `props` street furniture standing inside the swept corner
 *    corridor — neither is steerable from traffic; both are named per-site
 *    in `hitCtx`. The number stays TOTAL anyway, so a regression in either
 *    subsystem is still caught here rather than nowhere.
 *
 * 2. RESHUFFLE SENSITIVITY. Runs are deterministic, but ANY behavioural
 *    change reshuffles the whole 3-minute roll: one unchanged mechanism set
 *    measured 0.348 and 0.472 under two trivially different signal timings.
 *    Do not read a +/-0.1 move as signal without replicates across sites.
 *
 * The separation from the control arm is strongest at 3 minutes — the first
 * two are dominated by the fill transient. Lower it when you improve it;
 * never raise it (ARCHITECTURE.md rule 13).
 */
check(
  R.hitsPerDriverMin < 0.55,
  'collision rate (RATCHET 0.55, goal 0.1)',
  `${R.bigHits} big impacts over ${R.driverMinutes.toFixed(1)} driver-minutes = ` +
    `${R.hitsPerDriverMin.toFixed(3)}/driver-min\n        by kind: ` +
    Object.entries(R.hitBuckets).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('  ')
);
check(
  R.stuck.worst < 45,
  'nobody stopped forever',
  `longest continuous stop ${R.stuck.worst.toFixed(1)} s, ${R.stuck.over20} cars over 20 s ` +
    JSON.stringify(R.stuck.ctx)
);
check(
  R.junctionPasses > 0 && R.junctionRate > 0.05,
  'junction throughput',
  `${R.junctionPasses} junction crossings (${R.junctionRate.toFixed(2)}/s), ${R.linkPasses} links`
);
check(
  R.speeding.pct < 2.5,
  'speed limits obeyed',
  `${R.speeding.pct.toFixed(2)}% of car-frames over 125% of the limit, worst ${R.speeding.worstRatio.toFixed(2)}x`
);
check(
  R.weave.worstHz < 1.6,
  'no oscillating steering',
  `worst steering reversal rate ${R.weave.worstHz.toFixed(2)} Hz, mean ${R.weave.meanHz.toFixed(2)} Hz`
);
check(
  R.moving.blockedPct < 6,
  'nobody stopped without a reason',
  `${R.moving.blockedPct.toFixed(2)}% of car-frames stopped with no light, no leader and no errand ` +
    `(a further ${R.moving.walledPct.toFixed(2)}% stopped at world geometry across the carriageway)`
);
check(
  R.moving.pct > 45,
  'traffic is actually moving',
  `${R.moving.pct.toFixed(1)}% of car-frames above 1 m/s, mean ${R.meanKmh.toFixed(1)} km/h`
);
check(
  R.msPerCar < 0.06,
  'per-car frame cost',
  `${(R.msPerCar * 1000).toFixed(1)} us/car/tick, ${R.ms.toFixed(3)} ms total at ${R.peakCars} cars`
);

const bar = (v, max, w = 40) => '#'.repeat(Math.max(0, Math.round((v / max) * w)));
const spark = (vals) => {
  const g = '▁▂▃▄▅▆▇█';
  const lo = Math.min(...vals);
  const hi = Math.max(...vals, lo + 1e-6);
  return vals.map((v) => g[Math.min(7, Math.floor(((v - lo) / (hi - lo)) * 7.999))]).join('');
};

console.log('');
console.log(`TRAFFIC HARNESS  ${args.site ?? 'downtown'} · ${SITE.doc}`);
console.log(`  ${R.simSeconds}s simulated in ${R.wallSeconds}s wall (${R.speedup}x), q=${QUALITY}, hour=${HOUR}`);
console.log(`  peak ${R.peakCars} drivers + ${R.peakParked} parked, ${R.spawns} spawns, ` +
  `${R.despawns} despawns, ${R.recycled} recovered, ${R.totalVehicles} vehicles live at end`);
console.log('');
for (const f of F) {
  console.log(`  ${f.ok ? 'PASS' : 'FAIL'}  ${f.name.padEnd(30)} ${f.detail}`);
}
console.log('');
console.log('  cars    ' + spark(R.series.map((s) => s.cars)));
console.log('  km/h    ' + spark(R.series.map((s) => s.meanKmh)));
console.log('  ms      ' + spark(R.series.map((s) => s.ms)));
console.log('');
console.log('  speed histogram (km/h)');
for (let i = 0; i < R.hist.length; i++) {
  if (!R.hist[i]) continue;
  console.log(
    `   ${String(i * 10).padStart(3)}-${String(i * 10 + 9).padStart(3)} ` +
      bar(R.hist[i], Math.max(...R.hist))
  );
}
console.log('');
console.log('  reasons: ' + Object.entries(R.reasons).map(([k, v]) => `${k} ${v}`).join('  '));
console.log('  stopped by: ' + Object.entries(R.stoppedBy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('  '));
console.log(`  vehicle write-offs ${R.deaths}, big impacts ${R.bigHits}`);
console.log('  impact buckets: ' + (Object.entries(R.hitBuckets).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${v}`).join('  ') || 'none'));
console.log('  impact tags: ' + (Object.entries(R.hitTags).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${v}`).join('  ') || 'none'));
for (const d of R.deathCtx) console.log('    dead: ' + JSON.stringify(d));
if (args.verbose) for (const h of R.hitCtx) console.log('    hit: ' + JSON.stringify(h));
console.log(`  horns ${R.horns}  panics ${R.panics}  lane changes ${R.laneChanges}  states ${JSON.stringify(R.states)}`);
if (args.verbose) {
  // Forensics. `blockedBy` raycasts forward from any car that is on the
  // throttle and going nowhere and names what it is touching — that is how the
  // building colliders standing on the carriageway were found.
  console.log('  blocked-with-throttle samples:');
  for (const f of R.blockedBy) console.log('    ' + JSON.stringify(f));
  console.log('  frozen samples:');
  for (const f of R.frozen) console.log('    ' + JSON.stringify(f));
  console.log('  longest-stop trace:');
  for (const t of R.stuck.trace) console.log('    ' + JSON.stringify(t));
  console.log('  fastest car: ' + JSON.stringify(R.fastCtx));
  console.log(`  abandoned wrecks now ${R.abandonedNow}; no driver and not parked:`);
  console.log('    ' + JSON.stringify(R.censusX));
}
if (R.errors.length) console.log('  page errors: ' + R.errors.join(' | '));

if (args.json) {
  const out = resolve(String(args.json));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(R, null, 1));
  console.log(`  wrote ${out}`);
}

const failed = F.filter((f) => !f.ok);
console.log('');
console.log(failed.length ? `  ${failed.length} CHECK(S) FAILED` : '  ALL CHECKS PASSED');
process.exit(failed.length ? 1 : 0);

/* =========================================================================
 * In-page probe. Everything below runs inside the browser.
 * ========================================================================= */

function installProbe() {
  const e = window.__ENGINE__;
  const traffic = e.ctx.peek('traffic');
  const vehicles = e.ctx.peek('vehicles');
  const roads = e.ctx.peek('world').roads;
  const render = e.ctx.peek('render');
  const NO_RENDER = !window.__TRAFFIC_RENDER__;
  if (NO_RENDER && render && !render.__origRender) {
    render.__origRender = render.render;
    render.render = () => {};
  }

  const S = {
    frames: 0,
    nan: 0,
    obbMax: 0,
    sphereMax: 0,
    contactFrames: 0,
    worstPair: null,
    drivenMax: 0,
    drivenPair: null,
    drivenFrames: 0,
    pairKinds: {},
    latWorst: null,
    badCars: new Set(),
    allCars: new Set(),
    fastest: 0,
    fastCtx: null,
    stoppedBy: {},
    frozen: [],
    blockedBy: [],
    latSum: 0,
    latN: 0,
    latMax: 0,
    lats: [],
    offroad: 0,
    roadN: 0,
    roadMax: -99,
    worst: null,
    carFrames: 0,
    speedSum: 0,
    speeding: 0,
    worstRatio: 1,
    moving: 0,
    blocked: 0,
    walled: 0,
    hist: new Array(20).fill(0),
    reasons: {},
    states: {},
    peakCars: 0,
    peakParked: 0,
    msSum: 0,
    msN: 0,
    stopRun: new Map(),
    stopWorst: 0,
    stopCtx: null,
    stopOver20: 0,
    steerPrev: new Map(),
    reversals: new Map(),
    carSeconds: new Map(),
    projTmp: { s: 0, lateral: 0 },
    laneTmp: { s: 0, lateral: 0 },
    hitBuckets: {},
    hitTags: {},
    hitCtx: [],
    traces: new Map(),
    traceLen: new Map(),
  };

  /** Junction nodes (links > 2), for bucketing collisions by location. */
  const JN = [];
  for (const n of roads.nodes) if (n && n.links && n.links.length > 2) JN.push(n);
  function junctionDist(x, z) {
    let best = Infinity;
    for (let i = 0; i < JN.length; i++) {
      const d = Math.hypot(JN[i].x - x, JN[i].z - z);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * LANE-KEEPING ERROR AGAINST THE EMITTED LANE GEOMETRY (rule 12).
   *
   * `d.diag.lat` is the CONTROLLER'S OWN cross-track belief — the very number
   * the round-1 lane-adoption rewrite edits when it re-decides which lane the
   * car is in. A gate that reads it back is comparing the controller to
   * itself: adopt the lane you drifted into and the "error" vanishes with no
   * car having moved. This measures instead where the DRAWN car sits relative
   * to the nearest usable lane centre of the road graph's own geometry:
   * nearest edge by plan+height, plus the edge the driver is on as a second
   * candidate (same reason the off-carriageway check uses both — the nearest
   * CENTRELINE to a car in the outer lane of a six-lane parkway is often a
   * side street). Direction comes from the car's drawn heading, never from
   * the driver's plan; a car pointing the wrong way down a one-way is scored
   * against every lane rather than excused.
   *
   * Returns { err, mid } or null when no edge is plausibly under the car —
   * those frames are already the off-carriageway check's business.
   */
  function laneErrOf(v, d) {
    let bestErr = Infinity;
    let bestMid = false;
    let seen = false;
    const L = traffic.lanes;
    const consider = (e) => {
      if (!e || e.rail || !L.sane?.(e)) return;
      const na = roads.nodes[e.a];
      const nb = roads.nodes[e.b];
      if (!na || !nb) return;
      L.project(e, 0, v.position.x, v.position.z, S.laneTmp); // lane 0 runs a->b
      const sAB = S.laneTmp.s;
      if (sAB < -2 || sAB > e.len + 2) return; // off the span
      const t = Math.max(0, Math.min(1, sAB / e.len));
      const ey = na.y + (nb.y - na.y) * t;
      if (Math.abs(ey - v.position.y) > 6) return; // a bridge deck / a quay
      const dir = Math.sin(v._yaw) * e.dx + Math.cos(v._yaw) * e.dz >= 0 ? 1 : -1;
      let lo = L.laneLo(e, dir);
      let hi = L.laneHi(e, dir);
      if (hi < lo) { lo = 0; hi = e.lanes - 1; }
      for (let k = lo; k <= hi; k++) {
        L.project(e, k, v.position.x, v.position.z, S.laneTmp);
        const err = Math.abs(S.laneTmp.lateral);
        if (err < bestErr) {
          bestErr = err;
          bestMid = S.laneTmp.s > 14 && e.len - S.laneTmp.s > 14;
        }
        seen = true;
      }
    };
    const ne = roads.nearestEdge(v.position.x, v.position.z, 60, v.position.y);
    consider(ne?.edge);
    if (d._count > 0) {
      const e0 = d._edge(0);
      if (e0 !== ne?.edge) consider(e0);
    }
    return seen ? { err: bestErr, mid: bestMid } : null;
  }

  /** 2D OBB overlap depth via SAT. 0 when separated. */
  function obbDepth(ax, az, ah, aw, al, bx, bz, bh, bw, bl) {
    const axes = [
      [Math.cos(ah), -Math.sin(ah)], [Math.sin(ah), Math.cos(ah)],
      [Math.cos(bh), -Math.sin(bh)], [Math.sin(bh), Math.cos(bh)],
    ];
    let min = Infinity;
    const dx = bx - ax;
    const dz = bz - az;
    for (const [ux, uz] of axes) {
      const ra = Math.abs(aw * (Math.cos(ah) * ux + -Math.sin(ah) * uz)) +
        Math.abs(al * (Math.sin(ah) * ux + Math.cos(ah) * uz));
      const rb = Math.abs(bw * (Math.cos(bh) * ux + -Math.sin(bh) * uz)) +
        Math.abs(bl * (Math.sin(bh) * ux + Math.cos(bh) * uz));
      const d = Math.abs(dx * ux + dz * uz);
      const overlap = ra + rb - d;
      if (overlap <= 0) return 0;
      if (overlap < min) min = overlap;
    }
    return min;
  }

  /** The three-sphere model `vehicles` actually resolves against. */
  function sphereDepth(a, b) {
    let worst = 0;
    const ra = a.spec.half.x * 1.02;
    const rb = b.spec.half.x * 1.02;
    for (let i = -1; i <= 1; i++) {
      const az = a.spec.half.z * 0.62 * i;
      const ax = a.position.x + Math.sin(a._yaw) * az;
      const azz = a.position.z + Math.cos(a._yaw) * az;
      for (let j = -1; j <= 1; j++) {
        const bz = b.spec.half.z * 0.62 * j;
        const bx = b.position.x + Math.sin(b._yaw) * bz;
        const bzz = b.position.z + Math.cos(b._yaw) * bz;
        const d = Math.hypot(bx - ax, bzz - azz, b.position.y - a.position.y);
        const pen = ra + rb - d;
        if (pen > worst) worst = pen;
      }
    }
    return worst;
  }

  function yawOf(v) {
    const q = v.quaternion;
    return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
  }

  function tick() {
    S.frames++;
    const drivers = traffic.drivers;
    const list = vehicles.vehicles;
    const dt = 1 / 60;

    // Stamp when each driver got its current car, for the 'spawn' hit tag.
    for (const d of drivers) {
      if (d.__vBound !== d.vehicle) { d.__vBound = d.vehicle; d.__bornF = S.frames; }
    }

    S.peakCars = Math.max(S.peakCars, drivers.length);
    S.peakParked = Math.max(S.peakParked, traffic.parking.count);
    S.msSum += traffic.stats.ms;
    S.msN++;

    for (const v of list) v._yaw = yawOf(v);

    // --- interpenetration, over every vehicle pair (traffic, parked, player)
    let contact = false;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!Number.isFinite(a.position.x + a.position.y + a.position.z)) { S.nan++; continue; }
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (Math.abs(a.position.y - b.position.y) > 3) continue;
        const rr = a.boundingRadius + b.boundingRadius;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        if (dx * dx + dz * dz > rr * rr) continue;
        const d = obbDepth(
          a.position.x, a.position.z, a._yaw, a.spec.half.x, a.spec.half.z,
          b.position.x, b.position.z, b._yaw, b.spec.half.x, b.spec.half.z
        );
        if (d > 0.01) {
          contact = true;
          if (d > S.obbMax) S.obbMax = d;
          const sd = sphereDepth(a, b);
          if (sd > S.sphereMax) {
            S.sphereMax = sd;
            const da = traffic.driverOf(a);
            const db = traffic.driverOf(b);
            S.worstPair = {
              pen: +sd.toFixed(2),
              a: `${a.type}${a.isParked ? ':parked' : ''}${da ? ':' + da.state + '/' + da.diag.reason : ':none'}@${a.forwardSpeed.toFixed(1)}`,
              b: `${b.type}${b.isParked ? ':parked' : ''}${db ? ':' + db.state + '/' + db.diag.reason : ':none'}@${b.forwardSpeed.toFixed(1)}`,
              x: +a.position.x.toFixed(1), z: +a.position.z.toFixed(1),
              dy: +(b.position.y - a.position.y).toFixed(2),
            };
          }
          // `props` parks its own kerb dressing (v.parked, userData.owParked);
          // ours carries isParked. Either way it is a static object, and two
          // static objects overlapping is not a traffic defect.
          const pa = a.isParked || a.parked || a.userData?.owParked;
          const pb = b.isParked || b.parked || b.userData?.owParked;
          const da2 = traffic.driverOf(a);
          const db2 = traffic.driverOf(b);
          const ka = (pa ? 'P' : da2 ? 'D' : 'X') + (pb ? 'P' : db2 ? 'D' : 'X');
          S.pairKinds[ka] = (S.pairKinds[ka] ?? 0) + 1;
          if (da2 || db2) {
            if (sd > S.drivenMax) {
              S.drivenMax = sd;
              S.drivenPair = {
                pen: +sd.toFixed(2),
                a: `${a.type}${pa ? ':parked' : ''}${da2 ? ':' + da2.state + '/' + da2.diag.reason + '/av' + da2._avoid.toFixed(1) : ''}@${a.forwardSpeed.toFixed(1)}`,
                b: `${b.type}${pb ? ':parked' : ''}${db2 ? ':' + db2.state + '/' + db2.diag.reason + '/av' + db2._avoid.toFixed(1) : ''}@${b.forwardSpeed.toFixed(1)}`,
                x: +a.position.x.toFixed(1), z: +a.position.z.toFixed(1),
              };
            }
            S.drivenFrames++;
          }
        }
      }
    }
    if (contact) S.contactFrames++;

    // --- per-driver behaviour
    for (const d of drivers) {
      const v = d.vehicle;
      if (!v) continue;
      S.carFrames++;
      const kmh = Math.abs(v.forwardSpeed) * 3.6;
      S.speedSum += kmh;
      S.hist[Math.min(19, Math.floor(kmh / 10))]++;
      if (Math.abs(v.forwardSpeed) > 1) S.moving++;
      else if (d._wall < 16) S.walled++;
      else if (!(d._stopDist < 16 || d._lead.gap < 12 || d.state !== 'drive')) S.blocked++;

      /**
       * LANE KEEPING is only meaningful MID-BLOCK. Through a junction a car
       * cuts the corner by design, so its offset from the lane it is joining
       * is metres — measuring that as "lane error" reported 19% of the city
       * driving on the pavement when nothing was. The mid-block test comes
       * from the graph projection inside `laneErrOf`, not the driver's `_s`.
       *
       * Measured at 20 Hz per car (every 3rd tick) — `laneErrOf` runs a
       * `nearestEdge` query, and every tick for the whole fleet is harness
       * cost for no statistical gain.
       */
      S.allCars.add(d.id);
      if (Math.abs(v.forwardSpeed) > S.fastest) {
        S.fastest = Math.abs(v.forwardSpeed);
        S.fastCtx = { v: +v.forwardSpeed.toFixed(1), t: v.type, kind: d._count ? d._edge(0).kind : '?',
          lat: +d.diag.lat.toFixed(1), y: +v.position.y.toFixed(1), g: v.grounded, hp: Math.round(v.health) };
      }
      if (S.frames % 3 === 0) {
        const le = laneErrOf(v, d);
        if (le) {
          const lat = le.err;
          if (lat > 10) S.badCars.add(d.id);
          if (le.mid) {
            S.latSum += lat;
            S.latN++;
            if (lat > S.latMax) {
              S.latMax = lat;
              S.latWorst = {
                lat: +lat.toFixed(2), bel: +d.diag.lat.toFixed(2),
                avoid: +d._avoid.toFixed(2), blend: +d._laneBlend.toFixed(2),
                swerve: +d._swerve.toFixed(2), links: d._count, s: +d._s.toFixed(1),
                len: d._count > 0 ? +d._llen[d._slot(0)].toFixed(1) : 0,
                state: d.state, reason: d.diag.reason,
                kind: d._count > 0 ? d._edge(0).kind : '?', v: +v.forwardSpeed.toFixed(1),
                x: +v.position.x.toFixed(0), z: +v.position.z.toFixed(0),
              };
            }
            if (S.frames % 6 === 0) S.lats.push(lat);
          }
        }
      }
      /**
       * OFF THE CARRIAGEWAY is measured against the road graph itself, not
       * against the driver's own idea of where it should be: nearest edge,
       * its half width, plus the car's own half width.
       *
       * ...taking the SMALLER overhang of the nearest edge and the edge the
       * driver is actually driving (when that edge is at the car's altitude).
       * A car in the outer lane of a six-lane parkway is 14 m from the
       * parkway's centreline, and the nearest CENTRELINE in plan is often a
       * side street nine metres away — scoring the car against the side
       * street's 3.6 m half-width filed a legally-parked-in-its-lane parkway
       * car as four metres off the road. Both edges are graph facts, neither
       * is the controller's own input, and a car genuinely on the grass is
       * beyond the kerb of BOTH.
       */
      if (S.frames % 6 === 0) {
        S.roadN++;
        const ne = roads.nearestEdge(v.position.x, v.position.z, 60);
        let over = ne.edge ? ne.dist - ne.edge.width * 0.5 - v.spec.half.x : 99;
        if (over > 0 && d._count > 0) {
          const e0 = d._edge(0);
          const lane0 = d._lane(0);
          traffic.lanes.project(e0, lane0, v.position.x, v.position.z, S.projTmp);
          const dir0 = traffic.lanes.laneDir(e0, lane0);
          const c = S.projTmp.lateral + traffic.lanes.laneOffset(e0, lane0) * dir0;
          const s0 = S.projTmp.s;
          const onSpan = s0 > -2 && s0 < e0.len + 2;
          const na = roads.nodes[e0.a];
          const nb = roads.nodes[e0.b];
          const ey = na.y + (nb.y - na.y) * Math.max(0, Math.min(1, dir0 > 0 ? s0 / e0.len : 1 - s0 / e0.len));
          if (onSpan && Math.abs(ey - v.position.y) < 6) {
            const overB = Math.abs(c) - e0.width * 0.5 - v.spec.half.x;
            if (overB < over) over = overB;
          }
        }
        if (over > S.roadMax) {
          S.roadMax = over;
          S.worst = {
            over: +over.toFixed(2), state: d.state, reason: d.diag.reason,
            kind: ne.edge ? ne.edge.kind : '?', v: +v.forwardSpeed.toFixed(1),
            lat: +d.diag.lat.toFixed(2), x: +v.position.x.toFixed(1), z: +v.position.z.toFixed(1),
            links: d._count,
          };
        }
        if (over > 0.5) S.offroad++;
      }

      const limit = d._count > 0 ? traffic.lanes.limit(d._edge(0)) : 30;
      const ratio = Math.abs(v.forwardSpeed) / Math.max(1, limit);
      if (ratio > 1.25) S.speeding++;
      if (ratio > S.worstRatio) S.worstRatio = ratio;

      S.reasons[d.diag.reason] = (S.reasons[d.diag.reason] ?? 0) + 1;
      if (Math.abs(v.forwardSpeed) < 1) {
        const k = d.diag.reason + (d.diag.gap >= 0 && d.diag.gap < 6 ? '+close' : '');
        S.stoppedBy[k] = (S.stoppedBy[k] ?? 0) + 1;
        if (S.frames % 90 === 0 && v.input.throttle > 0.4 && S.frozen.length < 16) {
          const q = v.quaternion;
          const fx = 2 * (q.x * q.z + q.w * q.y);
          const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
          const phys = e.ctx.peek('physics');
          const p0 = v.position;
          const probe = [];
          for (const sgn of [-0.7, 0, 0.7]) {
            const ox = p0.x + -fz * sgn * v.spec.half.x;
            const oz = p0.z + fx * sgn * v.spec.half.x;
            const h = phys.raycast(ox, p0.y - 0.15, oz, fx, 0, fz, v.spec.half.z + 2.5, phys.MASK.WORLD);
            probe.push(h.hit ? `${(h.distance - v.spec.half.z).toFixed(1)}m ${h.object?.name ?? '?'}` : '-');
          }
          S.blockedBy.push({
            t: v.type, reason: d.diag.reason, thr: +v.input.throttle.toFixed(2),
            g: v.grounded, slip: +v.wheels[2].combined.toFixed(1), surf: v.wheels[2].surface,
            fwd: +v.forwardSpeed.toFixed(2), lat3: +(v.velocity.x * -fz + v.velocity.z * fx).toFixed(2),
            yawRate: +v.angularVelocity.y.toFixed(2), lat: +d.diag.lat.toFixed(1),
            probe, x: +p0.x.toFixed(0), z: +p0.z.toFixed(0),
          });
        }
        if (d.diag.reason === 'free' && S.frames % 120 === 0 && S.frozen.length < 14) {
          S.frozen.push({
            id: d.id, t: v.type, thr: +v.input.throttle.toFixed(2), br: +v.input.brake.toFixed(2),
            hb: v.input.handbrake, str: +v.input.steer.toFixed(2),
            g: v.grounded, gear: v.drivetrain.gearLabel, rpm: Math.round(v.drivetrain.rpm),
            surf: v.wheels[0].surface, mu: JSON.stringify(v.wheels[0].grip),
            load: Math.round(v.wheels[0].load), slip: +v.wheels[0].combined.toFixed(2),
            fx: Math.round(v.wheels[2] ? v.wheels[2].fx : 0),
            sleep: v.sleeping, air: +v.airborne.toFixed(1), hp: Math.round(v.health),
            tgt: +d.diag.targetSpeed.toFixed(1), acc: +d.diag.accel.toFixed(2),
            pitch: +((Math.asin(Math.max(-1, Math.min(1, 2 * (v.quaternion.y * v.quaternion.z + v.quaternion.w * v.quaternion.x)))) * 180 / Math.PI)).toFixed(0),
            y: +v.position.y.toFixed(1), st: d.state,
          });
        }
      }
      S.states[d.state] = (S.states[d.state] ?? 0) + 1;

      // stopped runs
      const key = v.id;
      if (Math.abs(v.forwardSpeed) < 0.3) {
        const r = (S.stopRun.get(key) ?? 0) + dt;
        S.stopRun.set(key, r);
        // Trace every long runner: what was the signal doing while it waited?
        // Per-key ring buffers, because the eventual record holder is not
        // knowable until the run ends.
        if (r > 18 && S.frames % 120 === 0 && d._count > 0 &&
            (S.traces.has(key) || S.traces.size < 10)) {
          let tr = S.traces.get(key);
          if (!tr) S.traces.set(key, (tr = []));
          if (tr.length < 40) {
            const e0 = d._edge(0);
            const n0 = traffic.lanes.toNode(e0, d._lane(0));
            tr.push({
              r: +r.toFixed(0), ph: traffic.phaseFor(n0, e0.id),
              ttg: +traffic.timeToGreen(n0, e0.id).toFixed(0),
              v: +v.forwardSpeed.toFixed(2), thr: +v.input.throttle.toFixed(2),
              stop: +Math.min(99, d._stopDist).toFixed(1),
              gap: +Math.min(99, d._lead.gap).toFixed(1),
              rsn: d.diag.reason, st: d._stall, k: d._stallStrikes,
              x: +v.position.x.toFixed(0), z: +v.position.z.toFixed(0),
            });
          }
          S.traceLen.set(key, r);
        }
        if (r > S.stopWorst) {
          S.stopWorst = r;
          // What does the SIGNAL think? A worst-stop blamed on a light that
          // `timeToGreen` says will never come is a lights defect, not a queue.
          let ttg = -1;
          let ph = null;
          if (d._count > 0) {
            const e0 = d._edge(0);
            const n0 = traffic.lanes.toNode(e0, d._lane(0));
            ttg = +traffic.timeToGreen(n0, e0.id).toFixed(1);
            ph = traffic.phaseFor(n0, e0.id);
          }
          S.stopCtx = {
            secs: +r.toFixed(1), t: v.type, state: d.state, reason: d.diag.reason,
            stall: d._stall, exc: d._excused, stop: +Math.min(999, d._stopDist).toFixed(1),
            gap: +Math.min(999, d._lead.gap).toFixed(1), thr: +v.input.throttle.toFixed(2),
            br: +v.input.brake.toFixed(2), lat: +d.diag.lat.toFixed(1), links: d._count,
            av: +d._avoid.toFixed(1), ttg, ph,
            x: +v.position.x.toFixed(0), z: +v.position.z.toFixed(0),
          };
        }
      } else if (S.stopRun.get(key) > 20) {
        S.stopOver20++;
        S.stopRun.set(key, 0);
      } else {
        S.stopRun.set(key, 0);
      }

      // steering reversals, only while actually moving on a straight-ish path
      if (Math.abs(v.forwardSpeed) > 5) {
        S.carSeconds.set(key, (S.carSeconds.get(key) ?? 0) + dt);
        const s = d.diag.steer;
        const prev = S.steerPrev.get(key);
        if (prev !== undefined && Math.abs(s) > 0.04 && Math.abs(prev) > 0.04 &&
            Math.sign(s) !== Math.sign(prev)) {
          S.reversals.set(key, (S.reversals.get(key) ?? 0) + 1);
        }
        if (Math.abs(s) > 0.04) S.steerPrev.set(key, s);
      }
    }
  }

  S.deaths = 0;
  S.deathCtx = [];
  S.bigHits = 0;
  e.events.on('vehicle:destroyed', (p) => {
    S.deaths++;
    const v = p?.vehicle;
    if (v && S.deathCtx.length < 12) {
      const d = traffic.driverOf(v);
      S.deathCtx.push({
        t: v.type, tr: !!v.isTraffic, drv: !!d, state: d?.state, reason: d?.diag?.reason,
        v: +Math.abs(v.forwardSpeed).toFixed(1), y: +v.position.y.toFixed(1),
        x: +v.position.x.toFixed(0), z: +v.position.z.toFixed(0),
        air: +v.airborne.toFixed(1), lat: d ? +d.diag.lat.toFixed(1) : null,
      });
    }
  });
  // Pre-existing drivers are not "fresh spawns" for the hit tags below.
  for (const d of traffic.drivers) { d.__vBound = d.vehicle; d.__bornF = -9999; }

  /**
   * BUCKET every big impact by WHERE and by MECHANISM, so "the collision rate
   * is 5x the goal" decomposes into something cuttable. Mechanism comes from
   * the drawn poses (relative heading + bearing), location from distance to
   * the nearest junction node, and the tags from the drivers' manoeuvre state
   * at the moment of impact. `spawn` = the striking driver got its car within
   * the last 5 s.
   */
  e.events.on('vehicle:collision', (p) => {
    if ((p?.impulse ?? 0) <= (p?.vehicle?.mass ?? 1e9) * 2) return;
    S.bigHits++;
    const v = p.vehicle;
    const o = p.other;
    const isVeh = !!o?.isVehicle;
    const da = traffic.driverOf(v);
    const db = isVeh ? traffic.driverOf(o) : null;
    let mech;
    if (!isVeh) {
      // A wall/kerb face across the bumper and a hard landing on the road
      // surface are different defects: split them on the contact normal.
      mech = Math.abs(p.normal?.y ?? 0) > 0.6 ? 'ground' : 'wall';
    } else {
      const ya = yawOf(v);
      const yb = yawOf(o);
      const dot = Math.cos(ya - yb);
      const ahead = (o.position.x - v.position.x) * Math.sin(ya) +
        (o.position.z - v.position.z) * Math.cos(ya);
      const park = o.isParked || o.parked || o.userData?.owParked;
      if (park) mech = 'parked';
      else if (!db && o.speed < 0.6) mech = 'wreck';
      else if (dot > 0.5) mech = ahead >= 0 ? 'rearend' : 'rearended';
      else if (dot < -0.5) mech = 'headon';
      else mech = 'cross';
    }
    const jd = junctionDist(v.position.x, v.position.z);
    const where = jd < 14 ? 'junction' : 'midblock';
    const tags = [];
    const flag = (d, sfx) => {
      if (!d) { tags.push('nodrv' + sfx); return; }
      if (S.frames - (d.__bornF ?? -9999) < 300) tags.push('spawn' + sfx);
      if (Math.abs(d._laneBlend) > 0.3) tags.push('lc' + sfx);
      if (Math.abs(d._avoid) > 0.3 || Math.abs(d._swerve) > 0.3) tags.push('dodge' + sfx);
      if (d.state !== 'drive') tags.push(d.state + sfx);
      if (Math.abs(d.diag.lat) > 2.2) tags.push('offlane' + sfx);
    };
    flag(da, 'A');
    if (isVeh) flag(db, 'B');
    const key = where + '/' + mech;
    S.hitBuckets[key] = (S.hitBuckets[key] ?? 0) + 1;
    for (const t of tags) S.hitTags[t] = (S.hitTags[t] ?? 0) + 1;
    if (S.hitCtx.length < 20) {
      S.hitCtx.push({
        f: S.frames, mech, jd: +jd.toFixed(0),
        a: v.type + (da ? ':' + da.state + '/' + da.diag.reason : '') +
          '@' + Math.abs(v.forwardSpeed).toFixed(1),
        b: isVeh
          ? o.type + (db ? ':' + db.state + '/' + db.diag.reason : '') +
            '@' + Math.abs(o.forwardSpeed).toFixed(1)
          : String(o?.name ?? 'world'),
        imp: +((p.impulse ?? 0) / Math.max(1, v.mass)).toFixed(1),
        ny: +(p.normal?.y ?? 0).toFixed(2),
        tags, x: +v.position.x.toFixed(0), z: +v.position.z.toFixed(0),
      });
    }
  });

  window.__TRAFFIC_PROBE__ = {
    run(n) {
      for (let i = 0; i < n; i++) {
        e.step();
        tick();
      }
      const cars = traffic.drivers.length;
      let sum = 0;
      for (const d of traffic.drivers) sum += Math.abs(d.vehicle?.forwardSpeed ?? 0) * 3.6;
      return {
        f: S.frames,
        cars,
        parked: traffic.parking.count,
        meanKmh: cars ? sum / cars : 0,
        ms: traffic.stats.ms,
      };
    },
    report() {
      const lats = S.lats.slice().sort((a, b) => a - b);
      const pc = (q) => (lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * q))] : 0);
      let worstHz = 0;
      let sumHz = 0;
      let nHz = 0;
      for (const [k, n] of S.reversals) {
        const secs = S.carSeconds.get(k) ?? 0;
        if (secs < 6) continue;
        const hz = n / secs;
        if (hz > worstHz) worstHz = hz;
        sumHz += hz;
        nHz++;
      }
      for (const r of S.stopRun.values()) if (r > 20) S.stopOver20++;
      const st = traffic.stats;
      const census = vehicles.vehicles.map((v) => ({
        t: v.type,
        p: !!v.isParked,
        tr: !!v.isTraffic,
        dead: !!v.destroyed,
        drv: !!traffic.driverOf(v),
        slp: !!v.sleeping,
        hp: Math.round(v.health),
        v: +Math.abs(v.forwardSpeed).toFixed(1),
        x: +v.position.x.toFixed(0), z: +v.position.z.toFixed(0),
      }));
      return {
        frames: S.frames,
        nan: S.nan,
        intersect: {
          obbMax: S.obbMax, sphereMax: S.sphereMax, frames: S.contactFrames,
          worstPair: S.worstPair, pairKinds: S.pairKinds,
          drivenMax: S.drivenMax, drivenPair: S.drivenPair, drivenFrames: S.drivenFrames,
        },
        stoppedBy: S.stoppedBy,
        frozen: S.frozen,
        blockedBy: S.blockedBy,
        laneKeep: {
          mean: S.latN ? S.latSum / S.latN : 0,
          p95: lats.length ? lats[Math.floor(lats.length * 0.95)] : 0,
          max: S.latMax,
          worst: S.latWorst,
          p50: pc(0.5), p75: pc(0.75), p90: pc(0.9), p99: pc(0.99),
          badCars: S.badCars.size, totalCars: S.allCars.size,
        },
        offroad: {
          pct: S.roadN ? (S.offroad / S.roadN) * 100 : 0,
          max: S.roadMax,
          worst: S.worst,
        },
        stuck: {
          worst: S.stopWorst, over20: S.stopOver20, ctx: S.stopCtx,
          trace: [...S.traces.entries()]
            .sort((a, b) => (S.traceLen.get(b[0]) ?? 0) - (S.traceLen.get(a[0]) ?? 0))
            .slice(0, 2)
            .flatMap(([, tr]) => tr),
        },
        speeding: {
          pct: S.carFrames ? (S.speeding / S.carFrames) * 100 : 0,
          worstRatio: S.worstRatio,
        },
        moving: {
          pct: S.carFrames ? (S.moving / S.carFrames) * 100 : 0,
          blockedPct: S.carFrames ? (S.blocked / S.carFrames) * 100 : 0,
          walledPct: S.carFrames ? (S.walled / S.carFrames) * 100 : 0,
        },
        weave: { worstHz, meanHz: nHz ? sumHz / nHz : 0 },
        meanKmh: S.carFrames ? S.speedSum / S.carFrames : 0,
        driverMinutes: S.carFrames / 3600,
        hitsPerDriverMin: S.bigHits / Math.max(1 / 60, S.carFrames / 3600),
        hist: S.hist,
        reasons: S.reasons,
        states: S.states,
        peakCars: S.peakCars,
        peakParked: S.peakParked,
        ms: S.msN ? S.msSum / S.msN : 0,
        msPerCar: S.peakCars ? (S.msN ? S.msSum / S.msN : 0) / S.peakCars : 0,
        junctionPasses: st.junctionPasses,
        junctionRate: st.junctionPasses / Math.max(1, S.frames / 60),
        linkPasses: st.linkPasses,
        spawns: st.spawns,
        recycled: st.recycled,
        horns: st.horns,
        panics: st.panics,
        laneChanges: st.laneChanges,
        abandonedNow: traffic._abandoned.length,
        totalVehicles: vehicles.vehicles.length,
        deaths: S.deaths, deathCtx: S.deathCtx, bigHits: S.bigHits,
        hitBuckets: S.hitBuckets, hitTags: S.hitTags, hitCtx: S.hitCtx,
        despawns: st.despawns,
        fastest: S.fastest, fastCtx: S.fastCtx,
        census,
        censusX: census.filter((c) => !c.p && !c.drv),
      };
    },
  };
}
