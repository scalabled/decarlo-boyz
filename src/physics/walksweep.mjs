#!/usr/bin/env node
/**
 * WALK SWEEP — can a man actually walk down this pavement?
 *
 *   node src/physics/walksweep.mjs
 *   node src/physics/walksweep.mjs --sites=downtown,strip
 *   node src/physics/walksweep.mjs --raw          # forgiveness OFF
 *   node src/physics/walksweep.mjs --nofix        # geometry fix OFF
 *   node src/physics/walksweep.mjs --nofix --raw  # the state that shipped
 *   node src/physics/walksweep.mjs --noclip       # MASK.WORLD only
 *   node src/physics/walksweep.mjs --json=/tmp/walk.json
 *   OW_PAVE_LEGACY=1 node src/physics/walksweep.mjs   # the oldest control
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHAT `pavesweep` COULD NOT SEE
 * ────────────────────────────────────────────────────────────────────────────
 * A man on foot can fall into a hole between two pavements on a build where
 * `src/world/pavesweep.mjs` reported ALL CHECKS PASSED with genuinely good
 * numbers: 0.02% of footway area inside a lane, 1.90% step-or-stacked cells,
 * 0 of 24 419 kerb faces off the authored height.
 *
 * Every one of those is a measure of the footway triangles that ARE THERE.
 * None of them can see an ABSENCE. `pavesweep` samples on an 0.5 m lattice and
 * asks "of the footway cells it found, how many disagree with a neighbour it
 * also found"; a cell with no footway at all is simply not a cell, so a corridor
 * that suppressed its strip — and `roadmesh._edgeCollision` suppresses the
 * whole three-column footway wherever either of its two rows would stand in
 * somebody else's lane — contributes nothing to any of the five checks. The
 * hole is invisible to the gate by construction.
 *
 * It is also below the resolution that matters. The player is a capsule of
 * radius 0.32 m (`UNITS.playerRadius`). A void 0.5 m across is a gate cell; it
 * is also a slot he fits into and cannot climb out of.
 *
 * So this measures a completely different quantity: **what happens to a real
 * `CharacterController` walking on the emitted collision triangles.** No road
 * graph arithmetic is compared to anything. The graph is used for one thing
 * only — to say which way a pavement runs, so the walkers walk down it instead
 * of at random — and `world.surfaceAt` is used to find the band, exactly the
 * way a pedestrian AI would. Everything asserted is measured from the
 * controller's own position after `move()` resolved against the BVH.
 *
 * Six assertions, in order of how directly they reproduce the defect:
 *
 *   traps      a capsule put down on paved ground and asked to leave in eight
 *              directions cannot leave in ANY of them. This IS the defect,
 *              reproduced. Candidates are every pit the scan found plus every
 *              place a walker stopped or fell — the scan is only a cheap way of
 *              finding more of them, the walkers are the ground truth.
 *   stops      a walker with movement input, grounded, that makes under 5% of
 *              its commanded progress for a full second, RATCHET
 *   voids      no collider AT ALL under a point `world.surfaceAt` calls
 *              'sidewalk'. Two independent producers disagreeing: the analytic
 *              contract every other subsystem consumes, and the triangles
 *              `roadmesh` actually emitted.
 *   cliffs     two samples one capsule diameter apart differing by more than
 *              0.45 m — the discontinuity census, RATCHET
 *   falls      a walker that leaves the ground and descends more than 0.40 m
 *              without having been asked to, per 100 m COVERED, RATCHET
 *   progress   displacement ALONG THE EDGE, not path length: a walker that
 *              spends ten metres going round a skip got nowhere
 *
 * MASK CHOICE MATTERS AND IS DELIBERATE. The walkers use `MASK.CHARACTER`,
 * which is the mask the shipped player's capsule uses and therefore includes
 * `LAYER.CLIP` — the ground shell and `world`'s corridor floor. `--noclip`
 * runs the same sweep on `MASK.WORLD`, which is the real-triangle layer alone
 * and the answer for everything that queries it: every vehicle wheel ray, every
 * bullet, `groundHeight`, prop placement. Both numbers are worth having and
 * they are not the same number.
 *
 * NEGATIVE CONTROLS, and none of the green figures mean anything without them:
 *
 *   --raw      gap bridging and the unstick nudge off in the controller, the
 *              geometry unchanged. NOTE THAT THIS ONE PASSES, and that is the
 *              correct result rather than a broken control: once the geometry
 *              has no holes there is little left for the forgiveness to save.
 *              Where it is measurable is against BROKEN geometry — `--nofix`
 *              against `--nofix --raw` is walkers stopping dead on pavement
 *              0.22% vs 0.89%, which is the case it exists for and the case
 *              the city will keep producing.
 *   --nofix    the geometry reverted — no footway skirt in `roadmesh`, no
 *              corridor floor in `world` — the controller unchanged.
 *   both       the build the player actually played.
 *   OW_PAVE_LEGACY=1  the radial junction fillet from two fixes ago. MEASURED
 *              AND IT BARELY MOVES THIS GATE (2.25% cliffs against 2.14%),
 *              which is worth recording rather than hiding: the radial fillet
 *              is a defect in the SHAPE of the pavement and `pavesweep` is what
 *              sees it — 2 of 5 red there. Two gates, two different defects,
 *              and a control for one is not a control for the other.
 *
 * MEASURED, 5 districts, 450 walkers, 8 760 m of commanded pavement:
 *
 *                        cliffs   traps   stops   falls/100 m   progress
 *   as the player had it  7.13%      1     0.89%      2.72        85.2%
 *   forgiveness only      7.13%      1     0.22%      2.87        86.2%
 *   geometry only         2.14%      0     0.44%      0.24        90.0%
 *   both (shipped)        2.14%      0     0.22%      0.27        90.1%
 *   --- and for anything on MASK.WORLD, which is not the same world ---
 *   real triangles only   6.55%      6     0.22%      1.29        90.9%
 *
 * That last row is the honest limit of this change. The `LAYER.CLIP` corridor
 * floor is what takes a character from 6.55% to 2.14%, and CLIP is invisible to
 * `MASK.WORLD` on purpose — so a VEHICLE still meets the residual. Closing it
 * for wheels means putting the same sheet on `STATIC`, which is a decision
 * about vehicle handling and belongs to whoever owns `src/vehicles`.
 *
 * Exit code 1 on any failed assertion.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

/** Same five districts `pavesweep` uses, so the two gates are comparable. */
const SITES = [
  { id: 'downtown', x: -232, z: 64, doc: 'Golden Triangle — the densest grid, on a grade' },
  { id: 'lawrenceville', x: 682, z: -548, doc: 'Lawrenceville rowhouse streets and the mill spur' },
  { id: 'strip', x: 248, z: -184, doc: 'The Strip — market blocks, alleys, rail' },
  { id: 'southside', x: 160, z: 608, doc: 'South Side — riverfront industrial, wide arterials' },
  { id: 'mtwash', x: -528, z: 464, doc: 'Mt. Washington — hillside switchbacks and dead ends' },
];
const WANT = args.sites ? String(args.sites).split(',') : null;
const sites = SITES.filter((s) => !WANT || WANT.includes(s.id));
const RADIUS = Number(args.radius ?? 150);
const WALKERS = Number(args.walkers ?? 90);
const RUN_M = Number(args.run ?? 22);
const RAW = !!args.raw;
/**
 * The walkers run on `MASK.CHARACTER` by default, because that is the mask the
 * shipped player's capsule uses and the question is what happens to HIM.
 * `--noclip` runs them on `MASK.WORLD`, which strips the `LAYER.CLIP` corridor
 * floor out and reports the real-triangle layer on its own — the answer for
 * anything that queries MASK.WORLD, which is every vehicle wheel ray.
 */
const USE_CLIP = !args.noclip;
const LEGACY = process.env.OW_PAVE_LEGACY === '1';
const NOFIX = !!args.nofix || process.env.OW_NO_GAP_FIX === '1';

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--js-flags=--max-old-space-size=4096'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));

let report = null;
let failure = null;

/* ===================================================================== */
/* Everything below runs INSIDE the page, against the live engine.       */
/* ===================================================================== */

function sweepSite({ cx, cz, radius, walkers, runM, raw, useClip }) {
  const eng = window.__ENGINE__;
  const phys = eng.ctx.peek('physics');
  const world = eng.ctx.peek('world');
  if (!phys || !world) return { error: 'physics or world missing' };

  const R = 0.32;             // UNITS.playerRadius
  const HGT = 1.78;           // UNITS.playerHeight
  const G = -9.81 * 2.1;      // UNITS.gravity
  const H = 1 / 120;          // the fixed step the engine runs characters at
  const SPEED = 2.4;          // a brisk walk
  const MW = phys.MASK.WORLD;              // emitted triangles, no CLIP shell
  const MC = phys.MASK.CHARACTER;          // what the shipped player sees
  const WALK_MASK = useClip ? MC : MW;

  /* -------- deterministic little rng; hard rule 4 ---------------------- */
  let _s = 0x9e3779b9 ^ ((cx | 0) * 374761393) ^ ((cz | 0) * 668265263);
  const rnd = () => {
    _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5;
    return ((_s >>> 0) % 1048576) / 1048576;
  };

  /* -------- footway centrelines, found the way a pedestrian would ------ */
  //
  // The road graph says where a street runs. It does NOT say where the emitted
  // footway is — that is the question — so the band is located by marching out
  // from the centreline and asking `world.surfaceAt`, the published contract,
  // for the surface name. Nothing derived from `roadmesh`'s cross-section
  // arithmetic appears on either side of any assertion below.
  const roads = world.roads;
  const edges = [];
  for (const e of roads.edges) {
    if (e.rail) continue;
    const a = roads.nodes[e.a];
    const b = roads.nodes[e.b];
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    if (Math.hypot(mx - cx, mz - cz) > radius) continue;
    if (e.len < 12) continue;
    edges.push(e);
  }

  /** Middle of the footway band `side` metres out from the lane centre. */
  const bandAt = (x, z, nx, nz, y) => {
    let lo = -1, hi = -1;
    for (let d = 1.0; d < 16; d += 0.25) {
      const s = world.surfaceAt(x + nx * d, z + nz * d, y);
      if (s === 'sidewalk') { if (lo < 0) lo = d; hi = d; }
      else if (lo >= 0) break;
    }
    if (lo < 0) return null;
    const d = (lo + hi) / 2;
    return { x: x + nx * d, z: z + nz * d, w: hi - lo };
  };

  /* ------------------------------------------------------------------- */
  /* 1. SURFACE SCAN — capsule-scale discontinuity, no external reference. */
  /* ------------------------------------------------------------------- */
  //
  // Walk each edge's two footway bands and cast down every `SS` metres, on
  // three lateral lines per band (inner, middle, outer) because the failure is
  // a strip that ends, and a strip that ends does so across its whole width.
  //
  // THE STEP SIZE IS THE POINT. `SS` is 2 x the capsule radius: a step measured
  // between two samples that far apart is a step the capsule genuinely has to
  // climb in one stride, and a gap narrower than that is one it bridges on its
  // own hemispheres. `pavesweep` samples at 0.5 m and asks whether the footway
  // CELLS IT FOUND agree with each other, so a cell with no footway is not a
  // cell and an absence is invisible to it. This asks a different question of
  // the same ground: how far apart in height are two places a walking man puts
  // consecutive feet, and is there anything under him at all.
  //
  // Nothing analytic appears in the assertion. `walkableHeightAt` is used only
  // to choose where to START the downward ray, several metres up.
  const SS = 0.64;
  let scanN = 0;
  let voids = 0;                 // no collider at all under a 'sidewalk' point
  let cliffs = 0;                // > CLIFF of vertical change between neighbours
  let pits = 0;                  // a sample below BOTH its along-path neighbours
  const CLIFF = 0.45;
  const PIT = 0.40;
  const candidates = [];
  const voidSpots = [];
  const cliffSpots = [];
  /**
   * The FLOOR under (x, z) in the emitted world.
   *
   * The second cast is not paranoia. A footway runs under awnings, fire
   * escapes, skips, container walls and the odd building corner, and a single
   * ray from above returns the top of whichever of those it meets — which then
   * reads as a two-metre cliff in the pavement that is really a roof. Anything
   * standing more than a capsule's shoulder over the surface is an obstacle a
   * walker goes round, not a floor they walk on, so drop under it and ask
   * again. Obstacles are still counted, by the walkers, as what they are.
   */
  const surfaceAt = (x, z, refY, mask) => {
    let h = phys.raycast(x, refY + 3.0, z, 0, -1, 0, 9.0, mask);
    let y = h.hit ? h.point.y : NaN;
    if (Number.isFinite(y) && y - refY > 1.0) {
      h = phys.raycast(x, refY + 0.9, z, 0, -1, 0, 7.0, mask);
      y = h.hit ? h.point.y : NaN;
    }
    return y;
  };

  for (const e of edges) {
    const a = roads.nodes[e.a];
    const b = roads.nodes[e.b];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-3) continue;
    const dx = (b.x - a.x) / L;
    const dz = (b.z - a.z) / L;
    for (const side of [-1, 1]) {
      const nx = -dz * side;
      const nz = dx * side;
      // Locate the band once at mid-edge, then follow it.
      const my = (a.y + b.y) / 2;
      const mid = bandAt((a.x + b.x) / 2, (a.z + b.z) / 2, nx, nz, my);
      if (!mid) continue;
      const off = Math.hypot(mid.x - (a.x + b.x) / 2, mid.z - (a.z + b.z) / 2);
      const halfW = Math.max(0.3, mid.w / 2 - 0.25);
      const lats = [-halfW, 0, halfW];
      // heights of the previous column, for the LATERAL comparison
      let prevCol = null;
      for (let s = 1.5; s < L - 1.5; s += SS) {
        const col = [NaN, NaN, NaN];
        for (let li = 0; li < 3; li++) {
          const o = off + lats[li];
          const px = a.x + dx * s + nx * o;
          const pz = a.z + dz * s + nz * o;
          const refY = world.walkableHeightAt(px, pz);
          if (world.surfaceAt(px, pz, refY) !== 'sidewalk') continue;
          scanN++;
          const y = surfaceAt(px, pz, refY, WALK_MASK);
          if (!Number.isFinite(y)) {
            voids++;
            if (voidSpots.length < 24) voidSpots.push({ x: +px.toFixed(1), z: +pz.toFixed(1), edge: e.id });
            continue;
          }
          col[li] = y;
          col[`x${li}`] = px;
          col[`z${li}`] = pz;
        }
        // lateral discontinuity, across the footway
        for (let li = 0; li < 2; li++) {
          if (!Number.isFinite(col[li]) || !Number.isFinite(col[li + 1])) continue;
          if (Math.abs(col[li] - col[li + 1]) > CLIFF) {
            cliffs++;
            if (cliffSpots.length < 24) {
              cliffSpots.push({
                x: +col[`x${li}`].toFixed(1), z: +col[`z${li}`].toFixed(1),
                rise: +Math.abs(col[li] - col[li + 1]).toFixed(2), dir: 'across', edge: e.id,
              });
            }
          }
        }
        // along-path discontinuity, and the three-point pit that traps a capsule
        if (prevCol) {
          for (let li = 0; li < 3; li++) {
            if (!Number.isFinite(col[li]) || !Number.isFinite(prevCol[li])) continue;
            const d = Math.abs(col[li] - prevCol[li]);
            if (d > CLIFF) {
              cliffs++;
              if (cliffSpots.length < 24) {
                cliffSpots.push({
                  x: +col[`x${li}`].toFixed(1), z: +col[`z${li}`].toFixed(1),
                  rise: +d.toFixed(2), dir: 'along', edge: e.id,
                });
              }
            }
            if (Number.isFinite(prevCol[`p${li}`])) {
              const down = Math.min(prevCol[`p${li}`], col[li]) - prevCol[li];
              if (down > PIT) {
                pits++;
                if (candidates.length < 300) {
                  candidates.push({ x: prevCol[`x${li}`], z: prevCol[`z${li}`], y: prevCol[li], drop: down, edge: e.id });
                }
              }
            }
          }
        }
        // carry the previous-previous heights for the pit test
        for (let li = 0; li < 3; li++) col[`p${li}`] = prevCol ? prevCol[li] : NaN;
        prevCol = col;
      }
    }
  }

  /* ------------------------------------------------------------------- */
  /* 2. THE CAPSULE — the controller the player actually uses.            */
  /* ------------------------------------------------------------------- */
  // `--raw` is the controller-side negative control: the same capsule with gap
  // bridging and the unstick nudge switched off. Everything else — step-up,
  // the plane stack, depenetration — is identical, so the delta between the two
  // runs is exactly what those two features are worth and nothing else.
  const c = phys.createCharacter({
    radius: R, height: HGT, mask: WALK_MASK,
    ...(raw ? { bridgeGap: 0, unstickAfter: 0 } : {}),
  });

  const settle = (steps = 90) => {
    for (let i = 0; i < steps; i++) {
      c.velocity.y = Math.max(-24, c.velocity.y + G * H);
      c.move(0, c.velocity.y * H, 0);
      if (c.grounded) { c.velocity.y = 0; return true; }
    }
    return c.grounded;
  };

  /** How many of eight compass directions can this capsule leave along? */
  const escapeCount = (px, py, pz) => {
    let n = 0;
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      const ux = Math.cos(ang);
      const uz = Math.sin(ang);
      c.teleport(px, py + 0.05, pz);
      settle(60);
      const x0 = c.position.x;
      const z0 = c.position.z;
      const steps = Math.ceil(1.0 / (SPEED * H));
      for (let i = 0; i < steps; i++) {
        c.velocity.x = ux * SPEED;
        c.velocity.z = uz * SPEED;
        if (c.grounded) c.velocity.y = Math.min(0, c.velocity.y);
        else c.velocity.y = Math.max(-24, c.velocity.y + G * H);
        c.move(c.velocity.x * H, c.velocity.y * H, c.velocity.z * H);
      }
      if (Math.hypot(c.position.x - x0, c.position.z - z0) > 0.55) n++;
    }
    return n;
  };

  /* ------------------------------------------------------------------- */
  /* 3. TRAVERSAL — walkers down the pavement.                            */
  /* ------------------------------------------------------------------- */
  let stops = 0;
  let stopsPaved = 0;
  let snags = 0;
  let falls = 0;
  let wanted = 0;
  let got = 0;
  let worstFall = 0;
  const stopSpots = [];
  const fallSpots = [];

  const starts = [];
  for (const e of edges) {
    const a = roads.nodes[e.a];
    const b = roads.nodes[e.b];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-3) continue;
    const dx = (b.x - a.x) / L;
    const dz = (b.z - a.z) / L;
    for (const side of [-1, 1]) {
      const nx = -dz * side;
      const nz = dx * side;
      const my = (a.y + b.y) / 2;
      const band = bandAt((a.x + b.x) / 2, (a.z + b.z) / 2, nx, nz, my);
      if (!band) continue;
      const off = Math.hypot(band.x - (a.x + b.x) / 2, band.z - (a.z + b.z) / 2);
      starts.push({ e, a, dx, dz, nx, nz, off, L });
    }
  }
  // Deterministic shuffle, then take the first `walkers`.
  for (let i = starts.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = starts[i]; starts[i] = starts[j]; starts[j] = t;
  }
  const pick = starts.slice(0, walkers);

  for (const w of pick) {
    // Start somewhere along the edge, walk toward b, then reverse if short.
    const run = Math.min(runM, w.L - 4);
    if (run < 6) continue;
    const s0 = 2 + rnd() * Math.max(0, w.L - 4 - run);
    const sx = w.a.x + w.dx * s0 + w.nx * w.off;
    const sz = w.a.z + w.dz * s0 + w.nz * w.off;
    const sy = world.walkableHeightAt(sx, sz);
    c.teleport(sx, sy + 0.35, sz);
    if (!settle(120)) continue;          // nothing to stand on at all: not a walk

    wanted += run;
    // PROGRESS IS DISPLACEMENT ALONG THE EDGE, NOT PATH LENGTH. A steering
    // walker that spends ten metres going round a skip has travelled ten
    // metres and got nowhere; scoring path length reported 114.7% for one
    // district, which is a number that cannot mean anything.
    const startX = c.position.x;
    const startZ = c.position.z;
    let travelled = 0;
    let winDist = 0;
    let winT = 0;
    let airT = 0;
    let airTop = c.position.y;
    let stalled = 0;
    let px = c.position.x;
    let pz = c.position.z;
    const total = Math.ceil(run / (SPEED * H));
    // A pedestrian who meets a bollard walks round it. Without that, every
    // walker "stops dead" at the first bin on the pavement and the gate reports
    // street furniture as a hole. Steering is deliberately dumb — swing the
    // heading further off the edge direction the longer no progress is made,
    // alternating sides — because the thing being measured is the ground, not
    // the navigation.
    let swing = 0;
    let swingSign = 1;
    let poorT = 0;
    let steerDist = 0;
    let steerT = 0;
    for (let i = 0; i < total; i++) {
      const ca = Math.cos(swing);
      const sa = Math.sin(swing) * swingSign;
      c.velocity.x = (w.dx * ca - w.dz * sa) * SPEED;
      c.velocity.z = (w.dz * ca + w.dx * sa) * SPEED;
      if (c.grounded) {
        c.velocity.y = Math.min(0, c.velocity.y);
        if (airT > 0.2 && airTop - c.position.y > 0.40) {
          falls++;
          const d = airTop - c.position.y;
          if (d > worstFall) worstFall = d;
          if (fallSpots.length < 20) {
            fallSpots.push({ x: +c.position.x.toFixed(1), z: +c.position.z.toFixed(1), depth: +d.toFixed(2), edge: w.e.id });
          }
        }
        airT = 0;
        airTop = c.position.y;
      } else {
        c.velocity.y = Math.max(-24, c.velocity.y + G * H);
        airT += H;
      }
      c.move(c.velocity.x * H, c.velocity.y * H, c.velocity.z * H);
      const step = Math.hypot(c.position.x - px, c.position.z - pz);
      travelled += step;
      winDist += step;
      winT += H;
      steerDist += step;
      steerT += H;
      px = c.position.x;
      pz = c.position.z;
      if (steerT >= 0.25) {
        if (steerDist / (SPEED * steerT) < 0.55) {
          poorT += steerT;
          swing = Math.min(1.05, poorT * 1.2);          // up to 60 degrees off
          if (poorT > 0.6) { swingSign = -swingSign; poorT = 0.15; }
        } else {
          poorT = 0;
          swing *= 0.5;
        }
        steerDist = 0;
        steerT = 0;
      }
      if (winT >= 0.5) {
        const ratio = winDist / (SPEED * winT);
        if (ratio < 0.05) {
          stalled += winT;
          if (stalled >= 1.0) {
            stops++;
            // A stop on unpaved ground is a hillside, not a pavement defect —
            // the Strip bluff and the Mt. Washington cut are steeper than any
            // capsule climbs and are supposed to be. `world` owns the paved
            // network; that is what the hard assertion is scoped to, and the
            // off-paved count is printed beside it so it cannot hide.
            const surf = world.surfaceAt(px, pz, c.position.y);
            const paved = surf === 'sidewalk' || surf === 'asphalt';
            if (paved) stopsPaved++;
            if (stopSpots.length < 20) {
              stopSpots.push({
                x: +px.toFixed(1), z: +pz.toFixed(1), y: +c.position.y.toFixed(2),
                on: surf, edge: w.e.id,
              });
            }
            break;
          }
        } else {
          if (ratio < 0.5) snags++;
          stalled = 0;
        }
        winDist = 0;
        winT = 0;
      }
    }
    const adv = (c.position.x - startX) * w.dx + (c.position.z - startZ) * w.dz;
    got += Math.max(0, Math.min(run, adv));
  }

  /* ------------------------------------------------------------------- */
  /* 4. TRAP CONFIRMATION — a real capsule, eight ways out.               */
  /* ------------------------------------------------------------------- */
  //
  // Candidates are every pit the scan found PLUS every place a walker stopped
  // or fell, because those are the ground truth and the scan is only a cheap
  // way of finding more of them. Confirmation asks the only question that
  // matters: put a capsule there, let it settle, and try to leave in eight
  // directions.
  // Nought of eight is a trap; anything else is a place you can walk out of.
  let traps = 0;
  const trapSpots = [];
  const seen = new Set();
  const uniq = [];
  for (const q of [...candidates, ...stopSpots.map((v) => ({ ...v, drop: 0, from: 'stop' })),
    ...fallSpots.map((v) => ({ ...v, y: NaN, drop: v.depth, from: 'fall' }))]) {
    const k = `${Math.round(q.x / 1.2)},${Math.round(q.z / 1.2)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(q);
  }
  let offPaved = 0;
  for (const q of uniq) {
    const y = Number.isFinite(q.y) ? q.y : world.walkableHeightAt(q.x, q.z);
    // SCOPED TO THE PAVED NETWORK, deliberately. A walker that leaves the
    // footway onto a 60-degree dirt bank on the Strip bluff is stuck because
    // hillsides are steep, and a gate that called that a defect would be
    // asserting that every square metre of Mt. Washington is traversable.
    // `world` owns the pavement; this is the part of the city it owns.
    const surf = world.surfaceAt(q.x, q.z, y);
    if (surf !== 'sidewalk' && surf !== 'asphalt') { offPaved++; continue; }
    if (escapeCount(q.x, y, q.z) === 0) {
      traps++;
      if (trapSpots.length < 20) {
        trapSpots.push({
          x: +q.x.toFixed(1), y: +y.toFixed(2), z: +q.z.toFixed(1),
          drop: +(q.drop ?? 0).toFixed(2), from: q.from ?? 'scan', edge: q.edge,
        });
      }
    }
  }

  phys.removeCharacter(c);

  return {
    edges: edges.length, scanN, voids, cliffs, pits, cand: uniq.length - offPaved, offPaved, traps,
    walkers: pick.length, stops, stopsPaved, snags, falls,
    wanted: +wanted.toFixed(0), got: +got.toFixed(0), worstFall: +worstFall.toFixed(2),
    trapSpots, stopSpots, fallSpots, voidSpots, cliffSpots,
  };
}

/* ===================================================================== */

try {
  const qs = ['capture=1', 'lockstep=1', 'prewarm=0', 'q=high'];
  if (LEGACY) qs.push('paveold=1');
  if (NOFIX) qs.push('nogapfix=1');
  await page.goto(`http://127.0.0.1:${port}/?${qs.join('&')}`, {
    waitUntil: 'domcontentloaded', timeout: 120000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });

  const out = [];
  for (const s of sites) {
    // Re-pin the camera EVERY frame: `player` drives it, so setting it once
    // means the streamer never hears about the new site and the sweep measures
    // whatever was already resident. See the same note in pavesweep.mjs.
    await page.evaluate(async ([x, z]) => {
      const e = window.__ENGINE__;
      const w = e.ctx.peek('world');
      for (let i = 0; i < 1400; i++) {
        const y = (w.walkableHeightAt(x, z) ?? 0) + 2.2;
        e.ctx.camera.position.set(x, y, z);
        e.ctx.camera.updateMatrixWorld();
        if (window.__PUMP__) window.__PUMP__(1);
        await new Promise((r) => requestAnimationFrame(r));
        if (i > 120 && window.__SETTLED__?.() === true) break;
      }
    }, [s.x, s.z]);
    const r = await page.evaluate(sweepSite, {
      cx: s.x, cz: s.z, radius: RADIUS, walkers: WALKERS, runM: RUN_M, raw: RAW, useClip: USE_CLIP,
    });
    if (r.error) throw new Error(`${s.id}: ${r.error}`);
    out.push({ site: s.id, doc: s.doc, ...r });
  }
  report = { legacy: LEGACY, raw: RAW, nofix: NOFIX, clip: USE_CLIP, radius: RADIUS, walkers: WALKERS, runM: RUN_M, sites: out };
} catch (e) {
  failure = e;
} finally {
  await browser.close();
  stopServer(server);
}

if (failure) {
  console.error(`[walksweep] FAILED: ${failure.message}`);
  if (errors.length) console.error(errors.slice(0, 8).join('\n'));
  process.exit(1);
}

const T = report.sites;
const sum = (k) => T.reduce((a, b) => a + (b[k] ?? 0), 0);
const scanN = sum('scanN');
const voids = sum('voids');
const cliffs = sum('cliffs');
const pits = sum('pits');
const traps = sum('traps');
const stops = sum('stops');
const stopsPaved = sum('stopsPaved');
const snags = sum('snags');
const falls = sum('falls');
const wanted = sum('wanted');
const got = sum('got');
const walkers = sum('walkers');
const pct = (a, b) => (b ? (100 * a) / b : 0);

const tags = [];
if (report.legacy) tags.push('LEGACY PAVEMENT');
if (report.nofix) tags.push('GAP FIX OFF');
if (report.raw) tags.push('RAW CONTROLLER');
if (!report.clip) tags.push('MASK.WORLD ONLY');
const tag = tags.length ? `${tags.join(' + ')} (negative control)` : 'current';
console.log('');
console.log(`[walksweep] ${tag} — ${T.length} sites, r=${RADIUS} m, ${WALKERS} walkers x ${RUN_M} m`);
console.log(`  ${'site'.padEnd(14)} ${'scan'.padStart(7)} ${'void'.padStart(6)} ${'cliff'.padStart(6)} ${'trap'.padStart(5)} ${'stop'.padStart(5)} ${'snag'.padStart(5)} ${'fall'.padStart(5)}  progress`);
for (const s of T) {
  console.log(
    `  ${s.site.padEnd(14)} ${String(s.scanN).padStart(7)} ${String(s.voids).padStart(6)} ` +
    `${String(s.cliffs).padStart(6)} ${String(s.traps).padStart(5)} ${String(s.stops).padStart(5)} ` +
    `${String(s.snags).padStart(5)} ${String(s.falls).padStart(5)}  ` +
    `${pct(s.got, s.wanted).toFixed(1)}% of ${s.wanted} m`
  );
}

const F = [];
const check = (ok, name, detail) => F.push({ ok, name, detail });

check(
  traps === 0,
  'no capsule trap on the footway',
  `${traps} confirmed traps (a capsule that cannot leave in ANY of 8 directions) ` +
  `out of ${sum('cand')} candidates on paved ground (${sum('offPaved')} more were off it and skipped) — ` +
  `${pits} pit samples from the scan plus every place a walker stopped or fell, over ${scanN} scanned`
);
check(
  // RATCHET at 0.7%, measured 0.22%, reverted 0.89%. The goal is zero and the
  // reason it is not zero is on the WALKER, not the world: the two that are
  // left are the Mt. Washington cut, where the footway band runs into the face
  // the road is carved out of, and a walker whose steering only swings 60
  // degrees off the edge direction cannot get round a hillside. Both were
  // checked by the trap test below and both can leave in several directions,
  // which is the difference between a steering heuristic giving up and a
  // capsule that is genuinely stuck. Lower it when the steering improves;
  // never raise it.
  pct(stopsPaved, walkers) < 0.7,
  'walkers do not stop dead on paved ground',
  `${stopsPaved} of ${walkers} walkers made under 5% of commanded progress for a full second ` +
  `while on a pavement or a carriageway (${pct(stopsPaved, walkers).toFixed(2)}%); ` +
  `${stops - stopsPaved} more stopped off it, on a bank or a bluff, which is terrain doing its job`
);
check(
  pct(voids, scanN) < 0.5,
  'the pavement exists where the world says it does',
  `${voids} of ${scanN} points that world.surfaceAt calls 'sidewalk' have NO collider at all ` +
  `within 9 m below (${pct(voids, scanN).toFixed(3)}%)`
);
check(
  // RATCHET at 2.5%, measured 2.14%. Zero is not reachable while the footway
  // runs along the top of a retaining wall, past a flight of steps, or up the
  // Mt. Washington cut — those are real cliffs and a gate that banned them
  // would be banning the terrain. Mt. Washington alone is 3.8% and downtown is
  // 1.5%, which is the shape you would expect. What this holds is the RATE, and
  // the residual cause is the corridor overlap `netgen.dedupeCorridors`
  // deliberately leaves below its 60 m threshold — the same residual
  // `pavesweep`'s step check carries. Reverted (`--nofix`) it is 7.13%.
  // Lower it when you improve it, never raise it to make a run go green.
  pct(cliffs, scanN) < 2.5,
  'no capsule-scale cliff in the walkable surface',
  `${cliffs} of ${scanN} samples differ from a neighbour ${(0.64).toFixed(2)} m away by more than ` +
  `0.45 m (${pct(cliffs, scanN).toFixed(2)}%)`
);
check(
  // PER 100 m OF GROUND ACTUALLY COVERED, not per walker.
  //
  // Per walker is a confounded metric and it read backwards: with the geometry
  // reverted, turning the forgiveness ON took falls from 203 to 217, because a
  // walker that no longer stops dead at the first trench goes on to meet six
  // more. Exposure has to be in the denominator or the gate punishes the fix
  // for working. Normalised, the same pair is 2.72 and 2.87 per 100 m — no
  // real change, which is the truth: bridging a gap is not the same thing as
  // there being no gap.
  //
  // RATCHET at 1.0, measured 0.27, reverted 2.72. NOT a claim of zero: a walker
  // crossing a junction mouth comes down a dropped kerb, and a hillside footway
  // on Mt. Washington steps with the terrain. Lower it when you improve it,
  // never raise it to make a run go green.
  (100 * falls) / Math.max(1, got) < 1.0,
  'walkers do not fall into things',
  `${((100 * falls) / Math.max(1, got)).toFixed(2)} unrequested descents over 0.40 m per 100 m ` +
  `covered (${falls} over ${got.toFixed(0)} m by ${walkers} walkers), ` +
  `worst ${T.reduce((a, b) => Math.max(a, b.worstFall), 0).toFixed(2)} m`
);
check(
  // RATCHET at 88%, measured 90.1%, reverted 85.2%. The shortfall left is
  // honest: a walker steers round bins, bollards and building corners, and
  // every metre of that detour is a metre it did not advance. It is a
  // navigation cost, not a collision defect — which is why the assertions that
  // must be ZERO are the traps and the stops, and this one only holds the line.
  pct(got, wanted) > 88,
  'walkers get where they are going',
  `${pct(got, wanted).toFixed(1)}% of ${wanted} m of commanded pavement was covered as ` +
  `displacement ALONG the edge (${snags} half-speed windows)`
);

console.log('');
let bad = 0;
for (const f of F) {
  console.log(`${f.ok ? '  ok  ' : '  FAIL'} ${f.name}`);
  console.log(`        ${f.detail}`);
  if (!f.ok) bad++;
}
const spots = (k) => T.flatMap((s) => (s[k] ?? []).map((v) => ({ site: s.site, ...v }))).slice(0, 8);
if (traps) console.log(`\n  traps: ${JSON.stringify(spots('trapSpots'))}`);
if (stops) console.log(`\n  stops: ${JSON.stringify(spots('stopSpots'))}`);
if (voids) console.log(`\n  voids: ${JSON.stringify(spots('voidSpots'))}`);
if (cliffs) console.log(`\n  cliffs: ${JSON.stringify(spots('cliffSpots'))}`);
if (falls) console.log(`\n  falls: ${JSON.stringify(spots('fallSpots'))}`);

if (args.json) {
  const p = resolve(String(args.json));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(report, null, 2));
  console.log(`\n  json -> ${p}`);
}

console.log('');
console.log(bad ? `[walksweep] ${bad} CHECK${bad > 1 ? 'S' : ''} FAILED` : '[walksweep] ALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
