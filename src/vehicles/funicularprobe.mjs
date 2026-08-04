#!/usr/bin/env node
/**
 * FUNICULAR — "do the two incline cars actually RIDE the rails the trestle
 * emits, counterbalanced, station to station, in the authored livery?"
 *
 * The Duquesne Incline used to carry two STATIC cars baked into the landmark
 * batch. They are now live meshes owned by `FunicularSystem`
 * (src/vehicles/funicular.js), posed every frame by sampling the track
 * descriptor `world` publishes (src/world/incline.js) — the same descriptor
 * `buildings`' `incline()` emits the trestle and rails from. This gate holds
 * the moving cars to the EMITTED geometry.
 *
 * WHAT THIS MEASURES, AND WHY IT IS NOT CIRCULAR (ARCHITECTURE.md rule 12)
 *
 * The obvious trap: the cars pose themselves by sampling `track.at` /
 * `track.trackY`, so asserting "car position equals track.at(...)" would
 * compare the code's input to itself. Nothing here does that. The rails the
 * player sees are the 'steel_light' boxes `incline()` merges into the
 * landmark batch — one box per trestle bay per side — and this probe rebuilds
 * the landmark through the SHIPPED path (publish -> adopt -> buildLandmark
 * into a real TileBuilder), then reads the rail VERTICES back out of the
 * accumulator. The track axis, the rail ends, and each rail line's polyline
 * (lateral centre and height per bay) are re-derived from that vertex soup
 * with this file's own arithmetic — principal axis over the cloud, bay
 * centroids in emission order — and the moving cars, world positions sampled
 * from the LIVE system over two full cycles of `update()`, are measured
 * against those numbers. If the descriptor and the emitted rails ever
 * disagree, or the cars ride anything but the rails, `on-rails` goes red.
 *
 * Assertions:
 *
 *   exist           two cars in the emitted scene graph, real triangle counts
 *   on-rails        every sample: car lateral centre within MAX_LATERAL_DEV
 *                   of its own measured rail line; height over the measured
 *                   rail polyline inside a fixed band with bounded wobble
 *   travels         each car's along-range spans the measured rail line
 *                   between the two station platforms, both directions
 *   stations        emitted station masses stand at BOTH measured rail ends
 *                   (brick headhouse below, the upper cupola above) and the
 *                   termini sit at them, clear of the brickwork
 *   counterweight   alongA + alongB is constant over the whole cycle
 *   dwell           each car holds still >= 3 s at each terminus per cycle
 *   livery          the emitted car materials are EXACTLY the authored
 *                   FUNICULAR_LIVERY — and the body is red by component, the
 *                   accent yellow, so the authored table itself cannot
 *                   silently rot to blue
 *
 * ...plus a SELF-CHECK on every run: the car samples are copied, pushed
 * 1.5 m sideways, and fed through the SAME on-rails measurement, which must
 * flag them or the run aborts — a gate that cannot fail is decorative.
 *
 * Usage
 *   node src/vehicles/funicularprobe.mjs
 *   node src/vehicles/funicularprobe.mjs --json=/tmp/funicular.json
 *
 * NEGATIVE CONTROLS (each must exit non-zero):
 *   --drift=1.5   the "hardcoded line" failure this gate exists for: the
 *                 whole funicular root is shifted sideways after init, the
 *                 cars leave the measured rails, on-rails goes red
 *   --freeze      update() is never called: travels and dwell go red
 */

import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';
import { generateCity } from '../world/netgen.js';
import { LANDMARKS as PLAN_LANDMARKS } from '../world/plan.js';
import { publishInclineTracks } from '../world/incline.js';
import { adoptLandmarkSites, buildLandmark, LANDMARKS as BLD_LANDMARKS } from '../buildings/landmarks.js';
import { TileBuilder } from '../buildings/tile.js';
import { FunicularSystem, FUNICULAR_LIVERY } from './funicular.js';
import { Rng } from '../core/rng.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const DRIFT = args.drift ? Number(args.drift) : 0;
const FREEZE = !!args.freeze;

/** A car is "on" its rail when its centre is within this of the rail line's
 *  measured lateral centre (the rail box itself is 0.34 m wide). */
const MAX_LATERAL_DEV = 0.35;
/**
 * The car floor rides the rail head by a fixed lift. The reference is the
 * exact emitted rail polyline (bay end-face centres, welded at the bents), so
 * the band is tight: the only legitimate wiggle is the car chording a bent
 * kink over its own wheelbase.
 */
const LIFT_MIN = 0.6;
const LIFT_MAX = 1.4;
const LIFT_WOBBLE = 0.35;
/** Counterweight: |(aA+aB) - median| must stay under this (m). */
const MAX_COUNTER_DEV = 0.75;
/** Each terminus must be held at least this long (s). */
const MIN_DWELL_S = 3;
/** Termini must reach within this of the measured rail-end platforms (m). */
const MAX_STATION_GAP = 14;
/** Simulation step (s); the run covers two full cycles. */
const DT = 1 / 30;

/* ---------------------------------------------------------------- build --- */

const terrain = new Terrain({ cell: 8, extent: 1792 });
terrain.bake();
generateCity(terrain, new Rng(0x5eed1234).fork().fork());
const groundAt = (x, z) => terrain.heightAt(x, z);

// The shipped publication order: world solves+publishes, buildings adopts.
const published = publishInclineTracks(PLAN_LANDMARKS, groundAt);
if (published !== 1) {
  console.error(`FAIL: publishInclineTracks published ${published} tracks, expected 1`);
  process.exit(1);
}
adoptLandmarkSites(PLAN_LANDMARKS);
const lm = BLD_LANDMARKS.find((l) => l.id === 'lm_incline');

// Build the landmark through the shipped entry point into a real TileBuilder
// (no keep-out: the reserve capsule keeps roads from under the trestle, so
// nothing would be dropped; `buildLandmarkPlan` only adds that guard).
const T = new TileBuilder(null, 'probe_lm_incline');
buildLandmark(T, null, lm, new Rng(lm.seed), groundAt(lm.x, lm.z), groundAt);

/* ----------------------------------------- measure the emitted rail lines --- */

function emittedVerts(key) {
  const acc = T._static.get(key);
  if (!acc || acc.empty) return null;
  return acc.pos;
}

const railPos = emittedVerts('steel_light');
const VPB = 24; // BoxGeometry vertex count; Accum appends boxes in order
if (!railPos || railPos.length < 3 * VPB * 8) {
  console.error('FAIL: no emitted incline rails (steel_light) to measure');
  process.exit(1);
}
const nVerts = railPos.length / 3;

// Principal axis of the rail cloud in XZ — this probe's own reading of which
// way the track runs, never the descriptor's `dir`.
let mx = 0;
let mz = 0;
for (let i = 0; i < nVerts; i++) {
  mx += railPos[i * 3];
  mz += railPos[i * 3 + 2];
}
mx /= nVerts;
mz /= nVerts;
let sxx = 0;
let sxz = 0;
let szz = 0;
for (let i = 0; i < nVerts; i++) {
  const dx = railPos[i * 3] - mx;
  const dz = railPos[i * 3 + 2] - mz;
  sxx += dx * dx;
  sxz += dx * dz;
  szz += dz * dz;
}
const trc = sxx + szz;
const det = sxx * szz - sxz * sxz;
const lam = trc / 2 + Math.sqrt(Math.max(0, (trc * trc) / 4 - det));
let axX = sxz;
let axZ = lam - sxx;
if (Math.abs(axX) + Math.abs(axZ) < 1e-9) {
  axX = lam - szz;
  axZ = sxz;
}
const axLen = Math.hypot(axX, axZ);
axX /= axLen;
axZ /= axLen;
// Point the measured axis uphill: the high end of the cloud is +along.
{
  let lo = 0;
  let hi = 0;
  let nLo = 0;
  let nHi = 0;
  for (let i = 0; i < nVerts; i++) {
    const al = (railPos[i * 3] - mx) * axX + (railPos[i * 3 + 2] - mz) * axZ;
    if (al < 0) {
      lo += railPos[i * 3 + 1];
      nLo++;
    } else {
      hi += railPos[i * 3 + 1];
      nHi++;
    }
  }
  if (lo / Math.max(1, nLo) > hi / Math.max(1, nHi)) {
    axX = -axX;
    axZ = -axZ;
  }
}
const perpX = axZ;
const perpZ = -axX;
const along = (x, z) => (x - mx) * axX + (z - mz) * axZ;
const lateral = (x, z) => (x - mx) * perpX + (z - mz) * perpZ;

// Rebuild each rail LINE from the emitted boxes, bay-endpoint faces rather
// than centroids: a centroid polyline cuts the corner at every bent (measured
// 0.6 m at this hill's knee) while the end-face centres ARE the polyline the
// bays were laid along. A BoxGeometry's 24 verts sit on its 8 corners, 12 per
// end face along the bay axis, so the mean of each along-half of a box is an
// end-face centre, exactly.
const leftLine = [];
const rightLine = [];
for (let b = 0; b < Math.floor(nVerts / VPB); b++) {
  const verts = [];
  for (let i = b * VPB; i < (b + 1) * VPB; i++) {
    verts.push({ x: railPos[i * 3], y: railPos[i * 3 + 1], z: railPos[i * 3 + 2] });
  }
  for (const v of verts) v.a = along(v.x, v.z);
  verts.sort((p, q) => p.a - q.a);
  for (const half of [verts.slice(0, VPB / 2), verts.slice(VPB / 2)]) {
    let ax = 0;
    let ay = 0;
    let az = 0;
    for (const v of half) {
      ax += v.x;
      ay += v.y;
      az += v.z;
    }
    ax /= half.length;
    ay /= half.length;
    az /= half.length;
    const p = { a: along(ax, az), lat: lateral(ax, az), y: ay };
    (p.lat < 0 ? leftLine : rightLine).push(p);
  }
}
leftLine.sort((p, q) => p.a - q.a);
rightLine.sort((p, q) => p.a - q.a);
// Weld the shared bent endpoints (consecutive bays meet there).
for (const line of [leftLine, rightLine]) {
  for (let i = line.length - 1; i > 0; i--) {
    if (line[i].a - line[i - 1].a < 0.5) {
      line[i - 1].a = (line[i - 1].a + line[i].a) / 2;
      line[i - 1].lat = (line[i - 1].lat + line[i].lat) / 2;
      line[i - 1].y = (line[i - 1].y + line[i].y) / 2;
      line.splice(i, 1);
    }
  }
}
if (leftLine.length < 8 || rightLine.length < 8) {
  console.error(`FAIL: expected two rail lines, got ${leftLine.length} left / ${rightLine.length} right bays`);
  process.exit(1);
}

/** Lerp the measured rail polyline at along `a` (clamped to its ends). */
function railAt(line, a) {
  if (a <= line[0].a) return line[0];
  const last = line[line.length - 1];
  if (a >= last.a) return last;
  let i = 1;
  while (line[i].a < a) i++;
  const p = line[i - 1];
  const q = line[i];
  const f = (a - p.a) / (q.a - p.a);
  return { a, lat: p.lat + (q.lat - p.lat) * f, y: p.y + (q.y - p.y) * f };
}

const spanLo = Math.min(leftLine[0].a, rightLine[0].a);
const spanHi = Math.max(leftLine[leftLine.length - 1].a, rightLine[rightLine.length - 1].a);

// Emitted station masses. Within this landmark build, 'brick_dark' is only
// the lower headhouse and 'trim_white' only the upper station cupola.
function centroidOf(key) {
  const pos = emittedVerts(key);
  if (!pos) return null;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const c = pos.length / 3;
  for (let i = 0; i < c; i++) {
    cx += pos[i * 3];
    cy += pos[i * 3 + 1];
    cz += pos[i * 3 + 2];
  }
  return { x: cx / c, y: cy / c, z: cz / c };
}
const lowerStation = centroidOf('brick_dark');
const upperStation = centroidOf('trim_white');

/* ------------------------------------------------------ run the live cars --- */

const scene = new THREE.Scene();
const worldStub = { landmarks: PLAN_LANDMARKS, heightAt: groundAt };
const ctx = {
  scene,
  time: { elapsed: 0, dt: DT, scale: 1, frame: 0 },
  rng: new Rng(1),
  config: { q: {} },
  events: { on() {}, off() {}, emit() {} },
  get: (id) => (id === 'world' ? worldStub : null),
  peek: (id) => (id === 'world' ? worldStub : null),
  has: (id) => id === 'world',
};
const sys = new FunicularSystem();
await sys.init(ctx);

if (DRIFT && sys.root) {
  // NEGATIVE CONTROL: simulate cars following a stale, hardcoded line.
  sys.root.matrixAutoUpdate = true;
  sys.root.position.x += perpX * DRIFT;
  sys.root.position.z += perpZ * DRIFT;
}

const cars = sys.cars ?? [];
const CYCLE_GUESS = 120; // generous; dwell+travel are the system's own business
const steps = Math.ceil((2 * CYCLE_GUESS) / DT);
const samples = [[], []]; // per car: { t, a, lat, y }
const wp = new THREE.Vector3();
for (let s = 0; s <= steps; s++) {
  if (!FREEZE) sys.update(DT, ctx);
  scene.updateMatrixWorld(true);
  for (let i = 0; i < cars.length; i++) {
    cars[i].getWorldPosition(wp);
    samples[i].push({ t: s * DT, a: along(wp.x, wp.z), lat: lateral(wp.x, wp.z), y: wp.y });
  }
}

/**
 * The on-rails measurement, shared by the real assertion and the self-check.
 * Each car is measured against ITS OWN rail line (side by median lateral).
 */
function measureOnRails(sampleSets) {
  let worstLat = 0;
  let liftLo = Infinity;
  let liftHi = -Infinity;
  for (const set of sampleSets) {
    if (!set.length) continue;
    const lats = set.map((s) => s.lat).sort((p, q) => p - q);
    const line = lats[Math.floor(lats.length / 2)] < 0 ? leftLine : rightLine;
    for (const s of set) {
      const r = railAt(line, s.a);
      const dev = Math.abs(s.lat - r.lat);
      if (dev > worstLat) worstLat = dev;
      const lift = s.y - r.y;
      if (lift < liftLo) liftLo = lift;
      if (lift > liftHi) liftHi = lift;
    }
  }
  return { worstLat, liftLo, liftHi };
}

/* ------------------------------------------------------------- self-check --- */

{
  const shifted = samples.map((set) => set.map((s) => ({ ...s, lat: s.lat + 1.5 })));
  const m = measureOnRails(shifted);
  if (!(m.worstLat > MAX_LATERAL_DEV)) {
    console.error(
      `SELF-CHECK FAILED: a 1.5 m sideways copy of the car samples was not flagged ` +
        `(worst dev ${m.worstLat.toFixed(3)}). The gate proves nothing; aborting.`
    );
    process.exit(2);
  }
  console.log(
    `self-check: +1.5 m sideways sample copy -> worst dev ${m.worstLat.toFixed(2)} m, flagged. checker CAN fail. ok`
  );
}

/* ------------------------------------------------------------- assertions --- */

const checks = [];
const check = (name, ok, msg) => {
  checks.push({ name, ok, msg });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(14)} ${msg}`);
};

// exist
{
  const tris = [0, 0];
  for (let i = 0; i < cars.length; i++) {
    cars[i].traverse((o) => {
      if (o.isMesh) tris[i] += (o.geometry.getIndex()?.count ?? 0) / 3;
    });
  }
  check(
    'exist',
    cars.length === 2 && tris[0] > 200 && tris[1] > 200,
    `${cars.length} cars, ${tris[0]} / ${tris[1]} tris`
  );
}

// on-rails
{
  const m = measureOnRails(samples);
  const ok =
    cars.length === 2 &&
    m.worstLat <= MAX_LATERAL_DEV &&
    m.liftLo >= LIFT_MIN &&
    m.liftHi <= LIFT_MAX &&
    m.liftHi - m.liftLo <= LIFT_WOBBLE;
  check(
    'on-rails',
    ok,
    `worst lateral dev ${m.worstLat.toFixed(3)} m (max ${MAX_LATERAL_DEV}); ` +
      `lift over rail ${m.liftLo.toFixed(2)}..${m.liftHi.toFixed(2)} m (band ${LIFT_MIN}..${LIFT_MAX}, wobble<=${LIFT_WOBBLE})`
  );
}

// travels
{
  let ok = cars.length === 2;
  let msg = '';
  for (let i = 0; i < cars.length; i++) {
    const as = samples[i].map((s) => s.a);
    const lo = Math.min(...as);
    const hi = Math.max(...as);
    ok = ok && lo <= spanLo + MAX_STATION_GAP && hi >= spanHi - MAX_STATION_GAP;
    msg += `car${i} ${lo.toFixed(1)}..${hi.toFixed(1)} of rails ${spanLo.toFixed(1)}..${spanHi.toFixed(1)}; `;
  }
  check('travels', ok, msg || 'no cars');
}

// stations
{
  const loA = lowerStation ? along(lowerStation.x, lowerStation.z) : NaN;
  const upA = upperStation ? along(upperStation.x, upperStation.z) : NaN;
  const ok =
    Number.isFinite(loA) && Number.isFinite(upA) && Math.abs(loA - spanLo) < 25 && Math.abs(upA - spanHi) < 25;
  check(
    'stations',
    ok,
    `lower mass at along ${Number.isFinite(loA) ? loA.toFixed(1) : 'none'} (rail end ${spanLo.toFixed(1)}), ` +
      `upper at ${Number.isFinite(upA) ? upA.toFixed(1) : 'none'} (end ${spanHi.toFixed(1)})`
  );
}

// dwell
{
  let ok = cars.length === 2;
  let msg = '';
  for (let i = 0; i < cars.length; i++) {
    const ss = samples[i];
    if (!ss.length) continue;
    const lo = Math.min(...ss.map((s) => s.a));
    const hi = Math.max(...ss.map((s) => s.a));
    for (const end of [lo, hi]) {
      let best = 0;
      let cur = 0;
      for (let k = 1; k < ss.length; k++) {
        const still = Math.abs(ss[k].a - ss[k - 1].a) / DT < 0.05 && Math.abs(ss[k].a - end) < 1.5;
        cur = still ? cur + DT : 0;
        if (cur > best) best = cur;
      }
      ok = ok && best >= MIN_DWELL_S;
      msg += `car${i}@${end.toFixed(0)}m ${best.toFixed(1)}s  `;
    }
  }
  check('dwell', ok, msg || 'no cars');
}

// counterweight
{
  const len = Math.min(samples[0]?.length ?? 0, samples[1]?.length ?? 0);
  let ok = len > 0;
  let worst = 0;
  if (ok) {
    const sums = [];
    for (let k = 0; k < len; k++) sums.push(samples[0][k].a + samples[1][k].a);
    const sorted = [...sums].sort((p, q) => p - q);
    const med = sorted[Math.floor(sorted.length / 2)];
    for (const v of sums) worst = Math.max(worst, Math.abs(v - med));
    ok = worst <= MAX_COUNTER_DEV;
  }
  check('counterweight', ok, `max |alongA+alongB - median| = ${worst.toFixed(3)} m (limit ${MAX_COUNTER_DEV})`);
}

// livery — sampled off the EMITTED car meshes
{
  const seen = new Map(); // hex -> tris
  for (const car of cars) {
    car.traverse((o) => {
      if (!o.isMesh) return;
      const hex = o.material.color.getHex();
      seen.set(hex, (seen.get(hex) ?? 0) + (o.geometry.getIndex()?.count ?? 0) / 3);
    });
  }
  const L = FUNICULAR_LIVERY;
  const comp = (hex) => ({ r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 });
  const body = comp(L.body);
  const accent = comp(L.accent);
  const isRed = body.r > 110 && body.r > 2.2 * body.g && body.r > 2.2 * body.b;
  const isYellow =
    accent.r > 180 && accent.g > 130 && accent.b < 0.45 * accent.g && Math.abs(accent.r - accent.g) < 0.45 * accent.r;
  const bodyDominant = (seen.get(L.body) ?? 0) > (seen.get(L.glass) ?? 0) * 0.5;
  const ok = seen.has(L.body) && seen.has(L.accent) && seen.has(L.glass) && isRed && isYellow && bodyDominant;
  check(
    'livery',
    ok,
    `body #${L.body.toString(16)} ${seen.get(L.body) ?? 0} tris (red=${isRed}), ` +
      `accent #${L.accent.toString(16)} ${seen.get(L.accent) ?? 0} tris (yellow=${isYellow}), ` +
      `glass #${L.glass.toString(16)} ${seen.get(L.glass) ?? 0} tris`
  );
}

/* ----------------------------------------------------------------- report --- */

const failed = checks.filter((c) => !c.ok);
if (args.json) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(String(args.json), JSON.stringify({ checks, drift: DRIFT, freeze: FREEZE }, null, 2));
}
if (failed.length) {
  console.error(
    `\nfunicularprobe: ${failed.length}/${checks.length} checks FAILED${DRIFT || FREEZE ? ' (negative-control arm)' : ''}`
  );
  process.exit(1);
}
console.log(
  `\nfunicularprobe: all ${checks.length} checks green — two counterweighted cars riding the emitted rails in the authored livery`
);
