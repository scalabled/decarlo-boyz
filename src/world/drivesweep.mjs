#!/usr/bin/env node
/**
 * WORLD — "can you actually drive the whole length of every road?"
 *
 * Two symptoms drive this gate: roads that are not contiguous in some places,
 * and a car that drifts off the sides. Both are questions about the SURFACE
 * UNDER A WHEEL, and neither of the gates that already exist can see them:
 *
 *   `probe.mjs`      samples three points per edge (t = 0.3/0.5/0.7) and asks
 *                    only "is there road collision here". Three points cannot
 *                    find a four-metre hole in a two-hundred-metre edge, and
 *                    the check is run on the ONE sector the camera is parked
 *                    in
 *   `pavesweep.mjs`  measures the footway, and says so: its own note records
 *                    that it passed on a build where a player fell into a
 *                    0.70 m trench, because an ABSENCE is not a triangle and
 *                    a gate that counts triangles cannot count it
 *   `groundsweep`    measures rays against `walkableHeightAt`, which is an
 *                    analytic field. It reports 0 holes on geometry that has
 *                    them, because the field is not the geometry
 *
 * WHAT THIS MEASURES, AND WHY IT IS NOT CIRCULAR (ARCHITECTURE.md rule 12)
 *
 * Everything asserted below is read off the EMITTED COLLISION TRIANGLES — the
 * exact `road_col_*` stream `world._streamRoadCollision` hands to
 * `physics.addStatic`, which is the surface a vehicle wheel ray finds, plus
 * `bridge_col`. Nothing here re-evaluates `pt()`, `_insetAt`, `heightAt`,
 * `walkableHeightAt` or any other function the builder used to place a vertex.
 * The road graph is consulted for exactly one thing — WHERE a lane is — which
 * is the one fact the triangles do not contain, and that is the same division
 * `lmsweep.mjs` and `pavesweep.mjs` draw.
 *
 * The triangles are built for the WHOLE CITY here rather than the 512 m round
 * the camera, by driving `world.roadMesh.begin(sx, sz, 'collision')` over every
 * sector. That is the production builder, in production mode, with nothing
 * stubbed: what streaming does at runtime, done everywhere at once.
 *
 * Four assertions:
 *
 *   surface     every sample under every lane centre and every lane EDGE
 *               stands on real road collision. A sample that finds nothing is
 *               a hole you drive into. Reported as metres of hole, and as the
 *               worst single run
 *   steps       no vertical discontinuity greater than `--step` between
 *               samples 0.6 m apart along the same line. This is the "not
 *               contiguous" complaint in its measurable form: a carriageway
 *               that ends and restarts 40 cm lower is a road you fall off,
 *               whether or not both halves exist
 *   welds       every node the graph calls a junction has ONE surface across
 *               it: sweep each arm in and out of every other arm and assert
 *               the same two properties on the turning line
 *   containment every kerbed carriageway has a lip at its edge in the
 *               COLLISION world. This is the "drift off the sides" complaint:
 *               a kerb you can see and cannot feel is a road with no sides
 *
 * ...plus a SELF-CHECK that fires before any of them: the identical sweep is
 * run down a line pushed 14 m off the carriageway, over open ground, and the
 * run aborts unless that control comes back overwhelmingly unsupported. A
 * surface detector that says "supported" everywhere would pass every assertion
 * above while measuring nothing.
 *
 * Usage
 *   node src/world/drivesweep.mjs
 *   node src/world/drivesweep.mjs --json=/tmp/drive.json
 *   node src/world/drivesweep.mjs --step=0.25     step tolerance, metres
 *   node src/world/drivesweep.mjs --ds=0.6        sample pitch, metres
 *   node src/world/drivesweep.mjs --verbose       list every defect site
 *
 * NEGATIVE CONTROLS. Each reverts ONE fix, and — this is the part that makes
 * the green numbers mean something — each takes red exactly the assertion that
 * fix is for, and leaves the other three green. MEASURED:
 *
 *   node src/world/drivesweep.mjs --nopadfix     the junction-pad union reverted
 *     holes 399.6 m -> 16 780.8 m FAIL · junction 3889 -> 5924 lines FAIL ·
 *     steps PASS · containment 7.79% -> 7.76% PASS
 *   node src/world/drivesweep.mjs --nokerbfix    the kerb-containment fix reverted
 *     containment 7.79% -> 10.28% FAIL · holes, steps and junction all PASS
 *     unchanged
 *   node src/world/drivesweep.mjs --noreserve    landmark reservation off
 *   node src/world/drivesweep.mjs --nogapfix     footway skirt + floor reverted
 *
 * Exit code 1 on any failed assertion.
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
 * A step a wheel falls off rather than rides over. The kerb is 0.122 m in the
 * collision world and `vehicles` climbs that deliberately, so the tolerance has
 * to sit above one kerb and below anything that reads as a broken road.
 */
const STEP_TOL = Number(args.step ?? 0.25);
const DS = Number(args.ds ?? 0.6);
const VERBOSE = !!args.verbose;

/**
 * RATCHET (ARCHITECTURE.md rule 13). EVERY ONE OF THESE RECORDS WHERE THIS PASS
 * GOT TO, NOT WHERE THE BAR IS. The goal is 0 on all four. Lower them when you
 * improve them; never raise one to make a run go green.
 *
 * Whole city, 4574 drivable edges, 1254 km of lane line at 0.6 m pitch, over
 * every lane centre and every lane edge `roads.laneCenter` hands out. Before
 * this pass / after it:
 *
 *   holes        16 780.8 m -> 399.6 m   9301 runs -> 163, worst 19.2 -> 12.0 m
 *   steps        12 833 -> 10 241        (see below: the measure changed too)
 *   junction     6256 lines -> 3889      6984 unsupported samples -> 799
 *   containment  11.75% -> 7.79%
 *
 * WHAT IS LEFT, AND WHOSE IT IS. Measured, not guessed:
 *
 *   holes 399.6 m   555 of the 666 samples are still at nodes with four or more
 *                   arms, and every one is inside a junction pad. What survives
 *                   the union fix is the `PAD_RMAX` cap: on a node whose arms
 *                   differ enormously in width the union boundary wants to
 *                   reach further than 1.7x the pad radius and is clipped. The
 *                   honest fix is to let the cap follow the widest ARM rather
 *                   than the pad, which is a `_junction` change and wants its
 *                   own pass
 *   steps 10 241    8952 are inside a junction pad and 1289 mid-run. The mid-run
 *                   ones are NOT an emission defect: they are hillside
 *                   switchbacks where `netgen` lays two legs of ONE corridor
 *                   over each other a couple of metres apart in height —
 *                   `quay_allegheny_-1` at (941, -855) has 2.13 m of daylight
 *                   between its own legs. That is a corridor-layout question
 *                   for `netgen`, not a `roadmesh` one, and it is the single
 *                   biggest remaining number in this file
 *   containment     7709 samples with no lip. Of those, 810 are CORRECT (the
 *   7.79%           ground outboard is another edge's drivable lane and a kerb
 *                   there is a kerb in the road) and 4136 are cancelled by the
 *                   lane of an edge that SHARES A NODE with the one laying the
 *                   kerb — a street's own continuation round a bend. `footPaved`
 *                   already exempts exactly that case and `laneDepth` does not.
 *                   A narrow same-corridor-within-45-degrees exemption was
 *                   tried and measured: it moved 7.80% to 7.79%, so the shared
 *                   node is real but the corridor id is not the discriminator.
 *                   Whoever takes this next should find what is, not widen the
 *                   exemption on faith
 *
 * Also measured and worth not re-deriving: halving the collision row pitch from
 * 11 m to 2 m doubles the collision triangle count (818k -> 1570k) and moves
 * containment 7.80% -> 7.13%. Row pitch is not the problem.
 */
const MAX_HOLE_M = Number(args.maxhole ?? 450);
const MAX_STEPS = Number(args.maxsteps ?? 10600);
const MAX_JUNCTION_BAD = Number(args.maxjunc ?? 4100);
const MAX_UNCONTAINED_PCT = Number(args.maxuncontained ?? 8.2);

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function freePort() {
  for (let i = 0; i < 300; i++) {
    const p = 5300 + Math.floor(Math.random() * 500);
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
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
page.on('pageerror', (ev) => errors.push(String(ev.message)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

let report = null;
let failure = null;
try {
  let extra = '';
  if (args.noreserve) extra += '&nolmreserve=1';
  if (args.nogapfix) extra += '&nogapfix=1';
  if (args.nokerbfix) extra += '&nokerbfix=1';
  if (args.nopadfix) extra += '&nopadfix=1';
  await page.goto(`http://127.0.0.1:${PORT}/?capture=1&lockstep=1&prewarm=0&q=high${extra}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 240000 });
  report = await page.evaluate(runSweep, { stepTol: STEP_TOL, ds: DS });
} catch (e) {
  failure = e;
} finally {
  await browser.close();
  server.kill();
}

if (failure) {
  console.error(`[drivesweep] FAILED: ${failure.message}`);
  if (errors.length) console.error(errors.slice(0, 8).join('\n'));
  process.exit(1);
}

const R = report;
if (args.json) {
  const p = resolve(String(args.json));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(R, null, 2));
}

/* ---------------------------------------------------------------- report -- */

const F = [];
const check = (ok, name, detail) => F.push({ ok, name, detail });

console.log('');
console.log('DRIVE SWEEP — the surface under every lane, over the whole city');
console.log(
  `  ${R.tris} emitted collision triangles from ${R.sectors} sectors · ` +
    `${R.edges} drivable edges · ${(R.sweptM / 1000).toFixed(1)} km of lane line swept ` +
    `at ${DS} m (${R.samples} samples, ${R.lines} lines)`
);
if (R.control) {
  console.log(
    `  SELF-CHECK  the same sweep 14 m off the carriageway: ` +
      `${R.control.absPct.toFixed(1)}% unsupported (needs > 55%) — ` +
      (R.control.absPct > 55 ? 'the detector can say NO' : 'DETECTOR IS BLIND')
  );
}
console.log('');

check(
  R.holeM <= MAX_HOLE_M,
  'the lane has a road under it',
  `${R.holeM.toFixed(1)} m of lane line (RATCHET <= ${MAX_HOLE_M}) stands on no road collision at all ` +
    `— ${R.holeSamples} of ${R.samples} samples, ${R.holeRuns} runs, worst ${R.worstHole.toFixed(1)} m` +
    fmt(R.holeWorst)
);
check(
  R.stepN <= MAX_STEPS,
  'the surface is continuous along the lane',
  `${R.stepN} steps (RATCHET <= ${MAX_STEPS}) over ${STEP_TOL} m between samples ${DS} m apart; ` +
    `worst ${R.worstStep.toFixed(2)} m` + fmt(R.stepWorst)
);
check(
  R.junc.bad <= MAX_JUNCTION_BAD,
  'every junction weld carries a surface',
  `${R.junc.bad} of ${R.junc.lines} turning lines (RATCHET <= ${MAX_JUNCTION_BAD}) at ${R.junc.nodes} ` +
    `junctions have a hole or a step; ${R.junc.holeSamples} unsupported samples, worst step ` +
    `${R.junc.worstStep.toFixed(2)} m` + fmt(R.junc.worst)
);
check(
  R.contain.pct <= MAX_UNCONTAINED_PCT,
  'a kerbed road has sides you can feel',
  `${R.contain.pct.toFixed(2)}% (RATCHET <= ${MAX_UNCONTAINED_PCT}) of ${R.contain.samples} kerb-line ` +
    `samples on ${(R.contain.km).toFixed(1)} km of kerbed carriageway have no collision lip ` +
    `(median lip ${R.contain.median.toFixed(3)} m) — no lip because: ` +
    `another edge's LANE is there ${R.contain.causeLane} (correct, a kerb there is a kerb in the road) · ` +
    `another edge's FOOTWAY ${R.contain.causeFoot} · nothing emitted at all ${R.contain.causeNone} · ` +
    `open ground ${R.contain.causeOpen} (of which ${R.contain.causeNeighbour} are a node-SHARING edge's lane)` +
    `\n        by kind ${JSON.stringify(R.contain.byKind)} · on a bridge deck ${R.contain.onBridge}` +
    fmt(R.contain.worst)
);

function fmt(list) {
  if (!VERBOSE || !list || !list.length) {
    return list && list.length ? `\n        e.g. ${JSON.stringify(list[0])}` : '';
  }
  return '\n        ' + list.map((x) => JSON.stringify(x)).join('\n        ');
}

console.log('');
for (const f of F) {
  console.log(`  ${f.ok ? 'PASS' : 'FAIL'}  ${f.name.padEnd(38)} ${f.detail}`);
}

/* Where the damage is, by corridor, so a defect has an owner. */
if (R.diag) {
  const d = R.diag;
  console.log('');
  console.log('  where the defects are');
  console.log(
    `    holes      lane centre ${d.holeCentre} / lane edge ${d.holeEdge} · ` +
      `inside a junction pad ${d.holeNearNode} / mid-run ${d.holeMidRun} · ` +
      `on oneway ${d.holeOneway} / odd-lane two-way ${d.holeOdd} / even two-way ${d.holeEven2way}`
  );
  console.log(
    `    steps      lane centre ${d.stepCentre} / lane edge ${d.stepEdge} · ` +
      `inside a junction pad ${d.stepNearNode} / mid-run ${d.stepMidRun}`
  );
  console.log(
    `    holes by arc distance to the nearer node (m)  ` +
      ['<1', '1-3', '3-6', '6-12', '12-25', '25+'].map((L, i) =>
        `${L}: ${d.holeArc[i]}/${d.sampArc[i]} (${d.sampArc[i] ? ((d.holeArc[i] / d.sampArc[i]) * 100).toFixed(1) : '0'}%)`).join('  ')
  );
  console.log(
    `    holes by that node's degree  dead-end ${d.holeDeg[0]} · bend ${d.holeDeg[1]} · ` +
      `T ${d.holeDeg[2]} · 4+ ${d.holeDeg[3]}`
  );
  console.log(
    `    laneCenter hands out a lane whose own width falls outside the carriageway on ` +
      `${d.laneOutEdges} edges, worst ${d.laneOutWorst.toFixed(2)} m past the edge`
  );
}
if (R.byCorridor?.length) {
  console.log('');
  console.log('  worst corridors (holes + steps)');
  for (const c of R.byCorridor.slice(0, 12)) {
    console.log(
      `    ${String(c.n).padStart(5)}  ${c.corr.padEnd(26)} ${c.lm ? `near ${c.lm} (${c.lmd} m)` : ''}`
    );
  }
}
if (R.rings?.length) {
  console.log('');
  console.log('  landmark ring roads — the thing every cut street was supposed to land on');
  for (const r of R.rings) {
    console.log(
      `    ${r.id.padEnd(12)} ring edges ${String(r.edges).padStart(3)} / ${r.km.toFixed(2)} km · ` +
        `cut ends ${r.cutEnds} · welded ${r.welded} · ORPHANED ${r.orphans}` +
        (r.orphanAt.length ? `  ${JSON.stringify(r.orphanAt.slice(0, 3))}` : '')
    );
  }
}

console.log('');
const bad = F.filter((f) => !f.ok);
if (!R.control || R.control.absPct <= 55) {
  console.log('  SELF-CHECK FAILED — the surface detector never says NO, so nothing above means anything');
  process.exit(1);
}
console.log(bad.length ? `  ${bad.length} CHECK(S) FAILED` : '  ALL CHECKS PASSED');
process.exit(bad.length ? 1 : 0);

/* ==================================================================== */
/* in page                                                              */
/* ==================================================================== */

function runSweep({ stepTol, ds }) {
  const e = window.__ENGINE__;
  const ctx = e.ctx;
  const w = ctx.peek('world');
  const roads = w.roads;
  const rm = w.roadMesh;
  const SECTOR = 512;
  const HALF = (w.CITY_SIZE ?? 3000) / 2;

  /* ---- 1. harvest the emitted collision triangles, city-wide ----------- */
  //
  // `begin(sx, sz, 'collision')` is the production path: the same SectorBuild
  // `world._streamRoadCollision` pumps, finished in one go instead of 24 items
  // a frame. Nothing about the geometry depends on how it was amortised.
  const V = [];
  let tris = 0;
  let sectors = 0;

  const takeGeo = (geo) => {
    const pos = geo.attributes.position;
    const idx = geo.index;
    if (!pos || !idx) return;
    for (let i = 0; i < idx.count; i += 3) {
      const i0 = idx.getX(i);
      const i1 = idx.getX(i + 1);
      const i2 = idx.getX(i + 2);
      V.push(
        pos.getX(i0), pos.getY(i0), pos.getZ(i0),
        pos.getX(i1), pos.getY(i1), pos.getZ(i1),
        pos.getX(i2), pos.getY(i2), pos.getZ(i2)
      );
      tris++;
    }
  };

  // A SectorBuild forks the builder's rng, which advances it. Restore the
  // stream afterwards so a sweep cannot change what the page builds next.
  const rs = [rm.rng.s0, rm.rng.s1, rm.rng.s2, rm.rng.s3];
  const n = Math.ceil(HALF / SECTOR) + 1;
  for (let sz = -n; sz <= n; sz++) {
    for (let sx = -n; sx <= n; sx++) {
      if (!rm.hasWork(sx, sz)) continue;
      const job = rm.begin(sx, sz, 'collision');
      let guard = 0;
      while (!job.step(4096) && guard++ < 4096) { /* pump */ }
      const out = job.finish();
      sectors++;
      if (!out.colMesh) continue;
      takeGeo(out.colMesh.geometry);
      out.colMesh.geometry.dispose();
    }
  }
  rm.rng.s0 = rs[0];
  rm.rng.s1 = rs[1];
  rm.rng.s2 = rs[2];
  rm.rng.s3 = rs[3];

  // Bridge decks are `road_col` (they are ordinary edges with `bridge` set);
  // `bridge_col` is the parapet wall. Take it so a deck edge is not reported
  // as uncontained when the thing holding a car on it is the parapet.
  const parapet = [];
  e.ctx.scene.traverse((o) => {
    if (!o.isMesh || o.name !== 'bridge_col') return;
    const pos = o.geometry.attributes.position;
    const idx = o.geometry.index;
    if (!pos || !idx) return;
    for (let i = 0; i < idx.count; i += 3) {
      for (const k of [0, 1, 2]) {
        const j = idx.getX(i + k);
        parapet.push(pos.getX(j), pos.getY(j), pos.getZ(j));
      }
    }
  });

  /* ---- 2. a uniform grid over them ------------------------------------- */
  const CELL = 8;
  const grid = new Map();
  const key = (cx, cz) => cx * 8192 + cz;
  const put = (map, arr, base, id) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const x = arr[base + k * 3];
      const z = arr[base + k * 3 + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    const cx0 = Math.floor(x0 / CELL);
    const cx1 = Math.floor(x1 / CELL);
    const cz0 = Math.floor(z0 / CELL);
    const cz1 = Math.floor(z1 / CELL);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const kk = key(cx, cz);
        let l = map.get(kk);
        if (!l) map.set(kk, (l = []));
        l.push(id);
      }
    }
  };
  for (let t = 0; t < tris; t++) put(grid, V, t * 9, t * 9);

  const pgrid = new Map();
  for (let t = 0; t < parapet.length / 9; t++) put(pgrid, parapet, t * 9, t * 9);

  /**
   * The topmost emitted road surface at or below `yTop`, or null.
   *
   * A plain downward ray against the triangles that are actually there. It
   * knows nothing about where the builder thought it was putting them.
   */
  const cand = [];
  const surfacesAt = (x, z, yTop, arr, map) => {
    cand.length = 0;
    const l = map.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!l) return cand;
    for (let i = 0; i < l.length; i++) {
      const b = l[i];
      const ax = arr[b], ay = arr[b + 1], az = arr[b + 2];
      const bx = arr[b + 3], by = arr[b + 4], bz = arr[b + 5];
      const cx = arr[b + 6], cy = arr[b + 7], cz = arr[b + 8];
      // barycentric in the xz plane
      const v0x = bx - ax, v0z = bz - az;
      const v1x = cx - ax, v1z = cz - az;
      const den = v0x * v1z - v1x * v0z;
      if (den === 0 || (den < 1e-9 && den > -1e-9)) continue;
      const px = x - ax, pz = z - az;
      const u = (px * v1z - v1x * pz) / den;
      if (u < -1e-6 || u > 1 + 1e-6) continue;
      const v = (v0x * pz - px * v0z) / den;
      if (v < -1e-6 || u + v > 1 + 1e-6) continue;
      const y = ay + (by - ay) * u + (cy - ay) * v;
      if (y > yTop) continue;
      cand.push(y);
    }
    return cand;
  };
  const surfaceAt = (x, z, yTop, arr, map) => {
    const c = surfacesAt(x, z, yTop, arr, map);
    let best = null;
    for (let i = 0; i < c.length; i++) if (best === null || c[i] > best) best = c[i];
    return best;
  };
  /**
   * The surface a car ALREADY ON `prev` finds here.
   *
   * A city is stacked — a deck over a quay, a switchback over its own lower
   * leg, a parkway beside a wharf — so "the topmost surface below the sky" is
   * not the surface a driver is on. Take the highest candidate the wheel could
   * still be resting on or climb onto; if there is none, take the highest there
   * is and let the step be measured, because that IS the step. `prev` is a
   * previously MEASURED surface height, never a road-graph value.
   */
  const CLIMB = 0.35;
  const followAt = (x, z, yTop, prev) => {
    const c = surfacesAt(x, z, yTop, V, grid);
    if (!c.length) return null;
    let best = null;
    if (prev !== null) {
      for (let i = 0; i < c.length; i++) {
        if (c[i] > prev + CLIMB) continue;
        if (best === null || c[i] > best) best = c[i];
      }
      if (best !== null) return best;
    }
    for (let i = 0; i < c.length; i++) if (best === null || c[i] > best) best = c[i];
    return best;
  };

  /* ---- 3. sweep every lane line --------------------------------------- */
  const LW = { highway: 3.9, arterial: 3.6, street: 3.3, alley: 3.0 };
  const SH = { highway: 2.6, arterial: 0.4, street: 0.3, alley: 0.0 };
  const SW = { highway: 0, arterial: 3.4, street: 2.7, alley: 0 };

  let samples = 0;
  let lines = 0;
  let sweptM = 0;
  let holeSamples = 0;
  let holeRuns = 0;
  let holeM = 0;
  let worstHole = 0;
  let stepN = 0;
  let worstStep = 0;
  const holeWorst = [];
  const stepWorst = [];
  const perCorr = new Map();

  const bump = (corr, x, z) => {
    let r = perCorr.get(corr);
    if (!r) perCorr.set(corr, (r = { corr, n: 0, x, z }));
    r.n++;
  };

  const LM = w.landmarks ?? [];
  const nearLm = (x, z) => {
    let best = null;
    let bd = Infinity;
    for (const lm of LM) {
      const d = Math.hypot(x - lm.x, z - lm.z);
      if (d < bd) { bd = d; best = lm.id; }
    }
    return bd < 260 ? { lm: best, lmd: Math.round(bd) } : { lm: null, lmd: 0 };
  };

  /**
   * Walk one line and score it. `pts` is a flat [x, z, yExpect, ...] array;
   * `yExpect` only picks which deck the ray starts above — the measurement is
   * the emitted surface itself and the step is measured surface-to-surface.
   */
  const walk = (pts, tag, collect, bucket) => {
    lines++;
    let prev = null;
    let run = 0;
    let runStart = 0;
    const nP = pts.length / 3;
    let holes = 0;
    let steps = 0;
    let wStep = 0;
    const closeRun = (endI) => {
      const len = run * ds;
      if (collect) {
        holeRuns++;
        holeM += len;
        if (len > worstHole) worstHole = len;
        if (len > 2 && holeWorst.length < 40) {
          holeWorst.push({
            m: +len.toFixed(1), x: Math.round(pts[runStart * 3]), z: Math.round(pts[runStart * 3 + 1]),
            ...tag, ...nearLm(pts[runStart * 3], pts[runStart * 3 + 1]),
          });
        }
        bump(tag.corr ?? '?', pts[runStart * 3], pts[runStart * 3 + 1]);
      }
      void endI;
      run = 0;
    };
    for (let i = 0; i < nP; i++) {
      const x = pts[i * 3];
      const z = pts[i * 3 + 1];
      const ye = pts[i * 3 + 2];
      samples++;
      const y = followAt(x, z, ye + 4, prev);
      if (y === null || y < ye - 25) {
        holes++;
        if (run === 0) runStart = i;
        run++;
        prev = null;
        if (bucket) bucket(i, nP, 'hole');
        continue;
      }
      if (run > 0) closeRun(i);
      if (prev !== null) {
        const d = Math.abs(y - prev);
        if (d > wStep) wStep = d;
        if (d > stepTol) {
          steps++;
          if (collect) {
            if (d > worstStep) worstStep = d;
            if (stepWorst.length < 40) {
              stepWorst.push({
                dy: +d.toFixed(2), x: Math.round(x), z: Math.round(z), ...tag, ...nearLm(x, z),
              });
            }
            bump(tag.corr ?? '?', x, z);
            if (bucket) bucket(i, nP, 'step');
          }
        }
      }
      prev = y;
    }
    if (run > 0) closeRun(nP);
    if (collect) {
      holeSamples += holes;
      stepN += steps;
    }
    return { holes, steps, wStep };
  };

  const buf = [];
  /** A line parallel to `lane`'s own centreline, `off` metres to its right. */
  const laneLine = (ed, lane, off, outBuf) => {
    const nS = Math.max(2, Math.ceil(ed.len / ds) + 1);
    outBuf.length = 0;
    const p = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < nS; i++) {
      const t = i / (nS - 1);
      roads.laneCenter(ed, lane, t, p);
      outBuf.push(p.x - ed.dz * off, p.z + ed.dx * off, p.y);
    }
    return nS;
  };
  const lineFor = (ed, off, outBuf) => {
    const na = roads.nodes[ed.a];
    const nb = roads.nodes[ed.b];
    const rx = -ed.dz * off;
    const rz = ed.dx * off;
    const nS = Math.max(2, Math.ceil(ed.len / ds) + 1);
    outBuf.length = 0;
    for (let i = 0; i < nS; i++) {
      const t = i / (nS - 1);
      outBuf.push(
        na.x + (nb.x - na.x) * t + rx,
        na.z + (nb.z - na.z) * t + rz,
        na.y + (nb.y - na.y) * t
      );
    }
    return nS;
  };

  let edgeCount = 0;
  const drivable = [];
  for (const ed of roads.edges) {
    if (ed.rail) continue;
    drivable.push(ed);
  }

  /* ---- SELF-CHECK first: can the detector say NO? ---------------------- */
  //
  // The identical sweep, pushed 14 m outboard of the widest kerb line. If that
  // comes back "supported" the detector is broken and every number below is a
  // number about nothing.
  let cAbs = 0;
  let cN = 0;
  for (let i = 0; i < drivable.length; i += 7) {
    const ed = drivable[i];
    const hw = (ed.lanes * (LW[ed.kind] ?? 3.3)) / 2 + (SH[ed.kind] ?? 0.3);
    for (const sgn of [-1, 1]) {
      const nS = lineFor(ed, sgn * (hw + (SW[ed.kind] ?? 0) + 14), buf);
      for (let k = 0; k < nS; k++) {
        const y = surfaceAt(buf[k * 3], buf[k * 3 + 1], buf[k * 3 + 2] + 4, V, grid);
        cN++;
        if (y === null || y < buf[k * 3 + 2] - 25) cAbs++;
      }
    }
  }
  const control = { absPct: cN ? (cAbs / cN) * 100 : 0, n: cN };

  /* ---- the real sweep -------------------------------------------------- */
  //
  // WHERE the lane is comes from `roads.laneCenter` — the SAME call `traffic`,
  // `police`, the minimap and `sampleSpawn` use to decide where a vehicle
  // belongs. Not from `roadHalfWidth`, not from the corridor: if the graph
  // hands out a lane that has no road under it, that is the defect, and asking
  // the geometry where its own middle is would hide it.
  const diag = {
    holeCentre: 0, holeEdge: 0, holeNearNode: 0, holeMidRun: 0,
    holeOneway: 0, holeOdd: 0, holeEven2way: 0,
    stepCentre: 0, stepEdge: 0, stepNearNode: 0, stepMidRun: 0,
    laneOut: 0, laneOutEdges: 0, laneOutWorst: 0,
    holeArc: [0, 0, 0, 0, 0, 0], holeDeg: [0, 0, 0, 0], sampArc: [0, 0, 0, 0, 0, 0],
  };
  const arcBucket = (d) => (d < 1 ? 0 : d < 3 ? 1 : d < 6 ? 2 : d < 12 ? 3 : d < 25 ? 4 : 5);
  const P0 = { x: 0, y: 0, z: 0 };
  for (const ed of drivable) {
    edgeCount++;
    const lw = ed.laneWidth ?? LW[ed.kind] ?? 3.3;
    const hw = (ed.lanes * lw) / 2 + (SH[ed.kind] ?? 0.3);
    const oneway = !!ed.oneway;
    const odd = ed.lanes % 2 === 1;
    // How far outside its own carriageway does the graph put a lane?
    let outWorst = 0;
    for (let l = 0; l < ed.lanes; l++) {
      roads.laneCenter(ed, l, 0.5, P0);
      const na0 = roads.nodes[ed.a];
      const nb0 = roads.nodes[ed.b];
      const mx = (na0.x + nb0.x) / 2;
      const mz = (na0.z + nb0.z) / 2;
      const off = -(P0.x - mx) * ed.dz + (P0.z - mz) * ed.dx;
      const out = Math.abs(off) + lw / 2 - hw;
      if (out > outWorst) outWorst = out;
    }
    if (outWorst > 0.05) {
      diag.laneOutEdges++;
      if (outWorst > diag.laneOutWorst) diag.laneOutWorst = outWorst;
    }
    const tag = { e: ed.id, kind: ed.kind, corr: ed.corridor ?? '?' };
    const near = hw * 1.4 + 2;
    for (let l = 0; l < ed.lanes; l++) {
      for (const k of [0, -1, 1]) {
        const isCentre = k === 0;
        const nS = laneLine(ed, l, k * (lw / 2 - 0.12), buf);
        sweptM += (nS - 1) * ds;
        for (let q = 0; q < nS; q++) {
          const a2 = (q / (nS - 1)) * ed.len;
          diag.sampArc[arcBucket(Math.min(a2, ed.len - a2))]++;
        }
        walk(buf, tag, true, (i, n, what) => {
          const arc = (i / (n - 1)) * ed.len;
          const dNode = Math.min(arc, ed.len - arc);
          const atNode = arc < near || ed.len - arc < near;
          if (what === 'hole') {
            diag.holeArc[arcBucket(dNode)]++;
            const nn = roads.nodes[arc < ed.len - arc ? ed.a : ed.b];
            const deg = nn.links.filter((q) => !roads.edges[q].rail).length;
            diag.holeDeg[Math.min(3, Math.max(0, deg - 1))]++;
            if (isCentre) diag.holeCentre++; else diag.holeEdge++;
            if (atNode) diag.holeNearNode++; else diag.holeMidRun++;
            if (oneway) diag.holeOneway++;
            else if (odd) diag.holeOdd++;
            else diag.holeEven2way++;
          } else {
            if (isCentre) diag.stepCentre++; else diag.stepEdge++;
            if (atNode) diag.stepNearNode++; else diag.stepMidRun++;
          }
        });
      }
    }
  }

  /* ---- 4. junction welds ---------------------------------------------- */
  //
  // An edge sweep stops at the node. What a driver does is turn: in along one
  // arm, across the pad, out along another. If a weld put two carriageways at
  // the same node without a surface between them, this is where it shows.
  const junc = { nodes: 0, lines: 0, bad: 0, holeSamples: 0, worstStep: 0, worst: [] };
  const jbuf = [];
  for (const nd of roads.nodes) {
    const links = nd.links.filter((i) => !roads.edges[i].rail);
    if (links.length < 3) continue;
    junc.nodes++;
    for (let ai = 0; ai < links.length; ai++) {
      for (let bi = 0; bi < links.length; bi++) {
        if (bi === ai) continue;
        const ea = roads.edges[links[ai]];
        const eb = roads.edges[links[bi]];
        const oa = roads.nodes[ea.a === nd.id ? ea.b : ea.a];
        const ob = roads.nodes[eb.a === nd.id ? eb.b : eb.a];
        const ra = Math.min(16, ea.len * 0.45);
        const rb = Math.min(16, eb.len * 0.45);
        const axd = (oa.x - nd.x) / ea.len;
        const azd = (oa.z - nd.z) / ea.len;
        const bxd = (ob.x - nd.x) / eb.len;
        const bzd = (ob.z - nd.z) / eb.len;
        // A quadratic through (in on A) -> node -> (out on B): the driving
        // line, not a ring. A ring reports every crossing of a pad boundary
        // that is not a circle as a defect.
        const p0x = nd.x + axd * ra, p0z = nd.z + azd * ra;
        const p2x = nd.x + bxd * rb, p2z = nd.z + bzd * rb;
        const yA = nd.y + ((oa.y - nd.y) / ea.len) * ra;
        const yB = nd.y + ((ob.y - nd.y) / eb.len) * rb;
        const steps = Math.max(6, Math.ceil((ra + rb) / ds));
        jbuf.length = 0;
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const it = 1 - t;
          jbuf.push(
            it * it * p0x + 2 * it * t * nd.x + t * t * p2x,
            it * it * p0z + 2 * it * t * nd.z + t * t * p2z,
            it * it * yA + 2 * it * t * nd.y + t * t * yB
          );
        }
        junc.lines++;
        const r = walk(jbuf, { n: nd.id, corr: ea.corridor ?? '?' }, false);
        junc.holeSamples += r.holes;
        if (r.wStep > junc.worstStep) junc.worstStep = r.wStep;
        if (r.holes > 0 || r.wStep > stepTol) {
          junc.bad++;
          if (junc.worst.length < 24) {
            junc.worst.push({
              n: nd.id, x: Math.round(nd.x), z: Math.round(nd.z),
              holes: r.holes, dy: +r.wStep.toFixed(2),
              corr: ea.corridor ?? '?', ...nearLm(nd.x, nd.z),
            });
          }
        }
      }
    }
  }

  /* ---- 5. containment: does a kerbed road have sides? ------------------ */
  //
  // Measured as the RISE of the emitted collision surface across the kerb line:
  // one sample just inside the carriageway edge, one just outside it. A car
  // that drifts meets whatever that difference is and nothing else.
  const contain = {
    samples: 0, none: 0, km: 0, lips: [], worst: [],
    // WHY a lip is missing, decided from the road graph (the one thing the
    // triangles cannot tell you): is the ground outboard of this kerb line
    // somebody else's LANE — where a kerb would be a kerb in the road and its
    // absence is correct — or is it somebody else's FOOTWAY, or nobody's?
    causeLane: 0, causeFoot: 0, causeNone: 0, causeOpen: 0, causeNeighbour: 0, byKind: {}, onBridge: 0,
  };
  const _cv = [];
  /** 0 = nobody, 1 = inside another edge's drivable lanes, 2 = its footway. */
  const claimedBy = (x, z, y, skipA, skipB, keepNeighbours) => {
    _cv.length = 0;
    roads.edgesInRect(x - 26, z - 26, x + 26, z + 26, _cv);
    let out = 0;
    for (let i = 0; i < _cv.length; i++) {
      const q = _cv[i];
      if (q.rail) continue;
      if (keepNeighbours ? (q.a === skipA && q.b === skipB) : (q.a === skipA || q.b === skipA || q.a === skipB || q.b === skipB)) continue;
      const na = roads.nodes[q.a];
      const nb = roads.nodes[q.b];
      const dx = nb.x - na.x;
      const dz = nb.z - na.z;
      const l2 = dx * dx + dz * dz;
      if (l2 < 1e-9) continue;
      const t = ((x - na.x) * dx + (z - na.z) * dz) / l2;
      if (t < 0 || t > 1) continue;
      const d = Math.hypot(x - (na.x + dx * t), z - (na.z + dz * t));
      if (Math.abs(y - (na.y + (nb.y - na.y) * t)) > 2.0) continue;
      const lwq = q.laneWidth ?? 3.3;
      const lh = (q.lanes * lwq) / 2;
      if (d <= lh) return 1;
      if (d <= lh + (SH[q.kind] ?? 0) + KERB_W + (SW[q.kind] ?? 0)) out = 2;
    }
    return out;
  };
  const KERB_W = 0.33;
  const lipHist = [];
  for (const ed of drivable) {
    const sw = SW[ed.kind] ?? 0;
    if (sw <= 0) continue; // a highway shoulder / mill alley is graded by design
    const hw = (ed.lanes * (LW[ed.kind] ?? 3.3)) / 2 + (SH[ed.kind] ?? 0.3);
    const na = roads.nodes[ed.a];
    const nb = roads.nodes[ed.b];
    // A kerb line does not run through a junction — the corner fillet does, and
    // whether THAT carries a surface is the junction-weld assertion's job. Skip
    // a generous margin round each node, derived from the road's own width so
    // it owes nothing to `_insetAt`.
    const skip = hw * 1.4 + 2.5;
    if (ed.len < skip * 2 + 4) continue;
    const t0 = skip / ed.len;
    const t1 = 1 - t0;
    const nS = Math.max(2, Math.ceil((ed.len - skip * 2) / 2.0) + 1);
    contain.km += (ed.len - skip * 2) / 1000;
    for (let i = 0; i < nS; i++) {
      const t = t0 + (t1 - t0) * (i / (nS - 1));
      const x = na.x + (nb.x - na.x) * t;
      const z = na.z + (nb.z - na.z) * t;
      const ye = na.y + (nb.y - na.y) * t;
      for (const sgn of [-1, 1]) {
        const ix = x - ed.dz * sgn * (hw - 0.14);
        const iz = z + ed.dx * sgn * (hw - 0.14);
        const ox = x - ed.dz * sgn * (hw + 0.17);
        const oz = z + ed.dx * sgn * (hw + 0.17);
        // Follow the carriageway out from the crown: the surface a wheel at the
        // road edge is on, not the topmost thing in the sky above it.
        const yMid = followAt(x, z, ye + 4, null);
        const yi = followAt(ix, iz, ye + 4, yMid);
        if (yi === null) continue; // no carriageway here: the hole gate owns it
        contain.samples++;
        // The first thing outboard of the kerb line that stands ABOVE the
        // carriageway edge — whatever it is, that is what contains the car.
        // Probe the KERB STONE'S OWN FOOTPRINT, not one point 17 cm out. A lip
        // is a lip whether the builder gave it a flat top or a short back
        // slope; what a drifting car meets is the highest thing standing on the
        // 0.33 m between its lane edge and the back of the stone.
        let top = null;
        let any = false;
        for (const dd of [0.04, 0.12, 0.25]) {
          const qx = x - ed.dz * sgn * (hw + dd);
          const qz = z + ed.dx * sgn * (hw + dd);
          const cs2 = surfacesAt(qx, qz, ye + 6, V, grid);
          for (let q = 0; q < cs2.length; q++) {
            if (cs2[q] > yi + 2.0) continue;
            any = true;
            if (top === null || cs2[q] > top) top = cs2[q];
          }
        }
        const yp = surfaceAt(ox, oz, ye + 6, parapet, pgrid);
        const lip = yp !== null ? 1 : !any ? -1 : top - yi;
        lipHist.push(lip);
        if (lip < 0.06) {
          contain.none++;
          const cause = !any ? 3 : claimedBy(ox, oz, ye, ed.a, ed.b, false);
          // Does the ground outboard belong to a lane of an edge that SHARES A
          // NODE with this one — this street's own continuation round a bend,
          // or the arm it meets? `_blocked` does not exempt those, `footPaved`
          // does, and the difference is a whole class of cancelled kerb.
          if (cause === 0 && claimedBy(ox, oz, ye, ed.a, ed.b, true) === 1) contain.causeNeighbour++;
          if (cause === 1) contain.causeLane++;
          else if (cause === 2) contain.causeFoot++;
          else if (cause === 3) contain.causeNone++;
          else contain.causeOpen++;
          contain.byKind[ed.kind] = (contain.byKind[ed.kind] ?? 0) + 1;
          if (ed.bridge) contain.onBridge++;
          if (contain.worst.length < 40) {
            contain.worst.push({
              e: ed.id, kind: ed.kind, corr: ed.corridor ?? '?', br: !!ed.bridge,
              x: Math.round(x), z: Math.round(z), lip: +lip.toFixed(3), cause,
              yi: +(yi - ye).toFixed(2), top: top === null ? null : +(top - yi).toFixed(2),
              ...nearLm(x, z),
            });
          }
        }
      }
    }
  }
  lipHist.sort((a, b) => a - b);
  contain.median = lipHist.length ? lipHist[lipHist.length >> 1] : 0;
  contain.pct = contain.samples ? (contain.none / contain.samples) * 100 : 0;
  delete contain.lips;

  /* ---- 6. did every landmark cut end land on a ring? ------------------- */
  const rings = [];
  for (const lm of LM) {
    let edges = 0;
    let km = 0;
    const ringNodes = new Set();
    for (const ed of roads.edges) {
      if (!String(ed.corridor ?? '').startsWith(`ring_${lm.id}`)) continue;
      edges++;
      km += ed.len / 1000;
      ringNodes.add(ed.a);
      ringNodes.add(ed.b);
    }
    // A cut end is a node inside (reserve + spur + slack) of this site that
    // belongs to a corridor which is NOT the ring. It is welded if it shares a
    // node with a ring edge, orphaned if it is a dead end.
    let cutEnds = 0;
    let welded = 0;
    let orphans = 0;
    const orphanAt = [];
    const s = lm.site;
    if (s) {
      for (const nd of roads.nodes) {
        const links = nd.links.filter((i) => !roads.edges[i].rail);
        if (!links.length) continue;
        const onRing = links.some((i) => String(roads.edges[i].corridor ?? '').startsWith('ring_'));
        const d = Math.hypot(nd.x - lm.x - (s.ox ?? 0), nd.z - lm.z - (s.oz ?? 0));
        if (d > (s.r ?? 0) + (s.hx ?? 0) + (s.hz ?? 0) + 24 + 14) continue;
        if (onRing) continue;
        cutEnds++;
        if (links.length === 1) {
          orphans++;
          if (orphanAt.length < 6) orphanAt.push({ x: Math.round(nd.x), z: Math.round(nd.z), n: nd.id });
        } else welded++;
      }
    }
    rings.push({ id: lm.id, edges, km, cutEnds, welded, orphans, orphanAt });
  }

  const byCorridor = [...perCorr.values()].sort((a, b) => b.n - a.n).slice(0, 20)
    .map((c) => ({ ...c, ...nearLm(c.x, c.z) }));

  return {
    tris, sectors, edges: edgeCount, samples, lines, sweptM,
    holeSamples, holeRuns, holeM, worstHole, holeWorst,
    stepN, worstStep, stepWorst,
    junc, contain, rings, byCorridor, control, diag,
  };
}
