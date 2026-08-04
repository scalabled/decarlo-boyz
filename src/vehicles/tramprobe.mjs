#!/usr/bin/env node
/**
 * TRAM PROBE — the trolley runs the emitted rail line, gated on EMITTED motion.
 *
 * The player asked for "the subway (trolley with windows) onto train tracks".
 * `railsweep` proves the track is one continuous line; this file proves a tram
 * actually RUNS on it. It drives the REAL `TramService` (the object
 * `VehicleSystem.update` owns in the game) against the REAL emitted city graph
 * — same generator, same seed as `railsweep` — and asserts, on the positions
 * the service emits into its vehicle handle over simulated time:
 *
 *   spawned     a tram exists, and it is standing ON the rail line;
 *   advances    its arc position along the line sweeps nearly the whole route;
 *   on-rails    lateral deviation from the drawn track stays ~0 for the WHOLE
 *               run (the body centre rides the chord between its two bogies,
 *               so the bound is small but not zero on curves — see RATCHET);
 *   height      the wheel plane follows the railhead over every grade;
 *   terminus    it brakes INTO each end (slow near the buffer stops), REVERSES,
 *               and makes the return trip — a ping-pong service, not a one-shot;
 *   paused      dt <= 0 moves it by exactly nothing (the pause contract).
 *
 * WHY THIS IS NOT CIRCULAR (ARCHITECTURE.md rule 12). The mover's own state
 * (`s`, `dir`, `v`) is never read. Every assertion is on `vehicle.position`
 * sampled over time and compared against rail geometry this file extracts
 * ITSELF from `generateCity(...).graph` — endpoint-matched into a chain by ITS
 * OWN code, not by `extractRailLine` — so a mover that follows its own wrong
 * idea of the line goes red here even though it agrees with itself perfectly.
 * The railhead height offset (+0.17) is restated here from `roadmesh._rail`'s
 * emitted section (ballast +0.06, railhead +0.11), not imported.
 *
 * NEGATIVE CONTROLS, run every time:
 *   paralysed   the same service with its timetable frozen (the live
 *               `paralysed` switch, no source edit): `advances`, `terminus`
 *               and the span must go red — proving the positive arm's motion
 *               is what those checks measure.
 *   offset      the positive arm's own recorded positions shifted 2.5 m off
 *               the track must trip the lateral check — proving the on-rails
 *               checker can fail.
 *
 * Usage:  node src/vehicles/tramprobe.mjs [--verbose]
 */

import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';
import { generateCity } from '../world/netgen.js';
import { Rng } from '../core/rng.js';
import { VEHICLE_SPECS, finalizeSpec } from './specs.js';
import { TramService } from './tram.js';

const VERBOSE = process.argv.includes('--verbose');
const DT = 0.1;          // service is dt-agnostic; coarse steps keep this cheap
const RUN_S = 400;       // one full out-and-back plus change (line ~1082 m)
/** Railhead above a rail node's y — restated from roadmesh._rail (see header). */
const RAIL_HEAD = 0.06 + 0.11;

let pass = 0;
let fail = 0;
const fails = [];
function check(label, ok, detail) {
  if (ok) pass++;
  else { fail++; fails.push(`${label} — ${detail}`); }
  if (!ok || VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${detail})`);
}

/* ================================================================== */
/* The emitted rail line, extracted INDEPENDENTLY of railmover.js      */
/* ================================================================== */

const terrain = new Terrain({ cell: 8, extent: 1792 });
const city = generateCity(terrain, new Rng(0x5eed1234).fork().fork());
const graph = city.graph;

/** Rail segments of the strip line, endpoints in world space (with y). */
const RAIL_SEGS = [];
for (const e of graph.edges) {
  if (!e.rail || !String(e.corridor ?? '').startsWith('rail_strip')) continue;
  const a = graph.nodes[e.a];
  const b = graph.nodes[e.b];
  RAIL_SEGS.push({ ax: a.x, ay: a.y ?? 0, az: a.z, bx: b.x, by: b.y ?? 0, bz: b.z });
}

/**
 * Chain the segments into an ordered polyline by greedy endpoint matching —
 * deliberately a different algorithm from railmover's weld-grid walk, so the
 * two cannot share a bug. O(n^2) on ~33 segments.
 */
function chainSegments(segs, eps = 1.6) {
  const eps2 = eps * eps;
  const d2 = (x1, z1, x2, z2) => (x1 - x2) ** 2 + (z1 - z2) ** 2;
  // Count how many segment-ends sit at each endpoint; degree-1 = an extremity.
  const ends = [];
  for (const s of segs) ends.push([s.ax, s.az], [s.bx, s.bz]);
  const degree = (x, z) => ends.reduce((n, e) => n + (d2(x, z, e[0], e[1]) < eps2 ? 1 : 0), 0);
  let start = null;
  for (const s of segs) {
    if (degree(s.ax, s.az) === 1) { start = { x: s.ax, y: s.ay, z: s.az }; break; }
    if (degree(s.bx, s.bz) === 1) { start = { x: s.bx, y: s.by, z: s.bz }; break; }
  }
  if (!start) return null;
  const used = new Array(segs.length).fill(false);
  const pts = [start];
  let cur = start;
  for (;;) {
    let found = -1;
    let flip = false;
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      const s = segs[i];
      if (d2(cur.x, cur.z, s.ax, s.az) < eps2) { found = i; flip = false; break; }
      if (d2(cur.x, cur.z, s.bx, s.bz) < eps2) { found = i; flip = true; break; }
    }
    if (found < 0) break;
    used[found] = true;
    const s = segs[found];
    cur = flip ? { x: s.ax, y: s.ay, z: s.az } : { x: s.bx, y: s.by, z: s.bz };
    pts.push(cur);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  return { pts, cum, length: cum[cum.length - 1], segsUsed: used.filter(Boolean).length };
}

const LINE = chainSegments(RAIL_SEGS);

/** Project (x,z) onto the chained line: arc s, lateral distance, rail y. */
function project(line, x, z, out) {
  let best = Infinity;
  let bs = 0;
  let by = 0;
  for (let i = 0; i < line.pts.length - 1; i++) {
    const a = line.pts[i];
    const b = line.pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const L2 = dx * dx + dz * dz;
    let t = L2 > 1e-9 ? ((x - a.x) * dx + (z - a.z) * dz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      bs = line.cum[i] + Math.sqrt(L2) * t;
      by = a.y + (b.y - a.y) * t;
    }
  }
  out.s = bs;
  out.lat = best;
  out.railY = by;
  return out;
}

/* ================================================================== */
/* Harness: the REAL TramService on a stub vehicle system              */
/* ================================================================== */

function makeCtx() {
  return {
    peek: (id) => (id === 'world' ? { roads: graph } : null),
    events: { emit() {} },
    time: {},
  };
}

function makeSys() {
  return {
    spawned: null,
    specOf(type) { return finalizeSpec(VEHICLE_SPECS[type]); },
    spawn(type, pos, yaw, opts) {
      const spec = finalizeSpec(VEHICLE_SPECS[type]);
      const v = {
        spec, type, opts, yaw0: yaw,
        position: new THREE.Vector3().copy(pos),
        prevPosition: new THREE.Vector3().copy(pos),
        quaternion: new THREE.Quaternion(),
        prevQuaternion: new THREE.Quaternion(),
        velocity: new THREE.Vector3(),
        angularVelocity: new THREE.Vector3(),
        control: { throttle: 0, brake: 0, steer: 0 },
        input: {},
        destroyed: false,
        sleeping: true,   // the service must hold it awake itself
        _sleepTimer: 9,
        speed: 0,
        forwardSpeed: 0,
      };
      this.spawned = v;
      return v;
    },
  };
}

/**
 * Run a service for `seconds`, recording the EMITTED trajectory.
 *
 * `bogF`/`bogR` are where the vehicle's bogie pivots actually ARE, derived
 * from the emitted `position` + `quaternion` (the pose the renderer draws) —
 * "do the drawn wheels stand on the drawn rails" is asked of those, because
 * the body CENTRE of a carriage legitimately swings inside a curve on the
 * chord between its bogies.
 */
const _bog = new THREE.Vector3();
function bogieLat(v, sign, pr) {
  _bog.set(0, -v.spec.comY, sign * 3.8).applyQuaternion(v.quaternion).add(v.position);
  project(LINE, _bog.x, _bog.z, pr);
  return pr.lat;
}
function run(service, ctx, seconds) {
  const track = []; // { t, x, y, z, s, lat, bog, railY }
  const pr = { s: 0, lat: 0, railY: 0 };
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    service.update(DT, ctx);
    const v = service.vehicle;
    if (!v) continue;
    project(LINE, v.position.x, v.position.z, pr);
    const rec = {
      t: i * DT,
      x: v.position.x, y: v.position.y, z: v.position.z,
      s: pr.s, lat: pr.lat, railY: pr.railY, bog: 0,
    };
    rec.bog = Math.max(bogieLat(v, 1, pr), bogieLat(v, -1, pr));
    track.push(rec);
  }
  return track;
}

/* ================================================================== */
/* 0. The line itself (precondition, not the subject — railsweep owns it) */
/* ================================================================== */

check('emitted rail_strip line chains end to end',
  !!LINE && LINE.segsUsed === RAIL_SEGS.length && LINE.length > 1000,
  LINE ? `${LINE.segsUsed}/${RAIL_SEGS.length} segs, ${LINE.length.toFixed(0)} m` : 'no line');
if (!LINE) { report(); }

/* ================================================================== */
/* 1. The service, positive arm                                        */
/* ================================================================== */

const sys = makeSys();
const svc = new TramService(sys);
const track = run(svc, makeCtx(), RUN_S);
const v = sys.spawned;
const comY = finalizeSpec(VEHICLE_SPECS.tram).comY;

check('a tram spawned', !!v && v.type === 'tram', v ? `type ${v.type}` : 'nothing spawned');

if (v && track.length) {
  const first = track[0];
  check('it spawned ON the rail line', first.lat < 0.5, `${first.lat.toFixed(2)} m off the track`);

  // ---- advances along the emitted polyline --------------------------------
  let sMin = Infinity;
  let sMax = -Infinity;
  let bogMax = 0;
  let chordMax = 0;
  let dyMax = 0;
  for (const p of track) {
    if (p.s < sMin) sMin = p.s;
    if (p.s > sMax) sMax = p.s;
    if (p.bog > bogMax) bogMax = p.bog;
    if (p.lat > chordMax) chordMax = p.lat;
    const dy = Math.abs(p.y - (p.railY + RAIL_HEAD + comY));
    if (dy > dyMax) dyMax = dy;
  }
  const span = sMax - sMin;
  check('it sweeps the route end to end', span > 900,
    `arc span ${span.toFixed(0)} m of ${LINE.length.toFixed(0)}`);

  /**
   * RATCHET (rule 13), two bounds with two meanings:
   *
   *   bogies    where the WHEELS are, from the emitted pose. MEASURED 0.12 m
   *             worst (the residue of two independent weld reconstructions of
   *             the same emitted segments); the bar is ~3x that. This is the
   *             "stays ON the rails" assertion. LOWER it if the weld residue
   *             shrinks; never raise it to admit a wanderer.
   *   centre    the body centre rides the CHORD between bogies 7.6 m apart,
   *             so at the emitted line's sharpest junction jog (34.7 deg at
   *             s=225) it legitimately stands INSIDE the curve — that is how a
   *             carriage corners, not an error. MEASURED 1.01 m there; the
   *             bar says it can never be much more than its own geometry
   *             allows (chord sagitta at 35 deg), i.e. the body cannot leave
   *             the 5 m ballast bed.
   *
   * The offset control below proves the bogie check catches a vehicle 2.5 m
   * off the line.
   */
  check('its wheels stay on the rails all run', bogMax < 0.35,
    `worst bogie lateral ${bogMax.toFixed(2)} m (RATCHET < 0.35)`);
  check('its body never leaves the ballast bed', chordMax < 1.4,
    `worst centre chord-swing ${chordMax.toFixed(2)} m (sharpest emitted jog allows ~1.0)`);
  check('its wheels follow the track height', dyMax < 0.45,
    `worst wheel-plane error ${dyMax.toFixed(2)} m over every grade`);

  // ---- speed profile, from EMITTED positions only -------------------------
  let vPeak = 0;
  let vNearEndPeak = 0;
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1];
    const b = track[i];
    const sp = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / DT;
    if (sp > vPeak) vPeak = sp;
    const dEnd = Math.min(b.s - sMin, sMax - b.s);
    if (dEnd < 10 && sp > vNearEndPeak) vNearEndPeak = sp;
  }
  check('it cruises at tram pace', vPeak > 6 && vPeak < 12,
    `peak ${vPeak.toFixed(1)} m/s (measured 9.0 — the service cap)`);
  check('it brakes INTO the termini', vNearEndPeak < 5.5,
    `fastest emitted speed within 10 m of a buffer stop: ${vNearEndPeak.toFixed(1)} m/s`);

  // ---- reversal: out, back, and out again ---------------------------------
  let iMax = 0;
  for (let i = 0; i < track.length; i++) if (track[i].s === sMax) { iMax = i; break; }
  let backTo = sMax;
  let iBack = iMax;
  for (let i = iMax; i < track.length; i++) if (track[i].s < backTo) { backTo = track[i].s; iBack = i; }
  check('it REVERSES at the far end and runs back', sMax - backTo > 600,
    `returned ${(sMax - backTo).toFixed(0)} m after the far terminus`);
  let outAgain = backTo;
  for (let i = iBack; i < track.length; i++) if (track[i].s > outAgain) outAgain = track[i].s;
  check('...and turns again at the near end (a service, not a one-shot)',
    outAgain - backTo > 80, `re-advanced ${(outAgain - backTo).toFixed(0)} m`);

  // ---- the pause contract -------------------------------------------------
  const frozen = { x: v.position.x, y: v.position.y, z: v.position.z };
  const ctx = makeCtx();
  for (let i = 0; i < 10; i++) svc.update(0, ctx);
  const moved = Math.hypot(v.position.x - frozen.x, v.position.y - frozen.y, v.position.z - frozen.z);
  check('a stopped clock stops the tram (dt=0 moves it 0 m)', moved === 0,
    `${moved.toFixed(4)} m`);

  // ---- it is collidable city furniture, not a ghost -----------------------
  check('it is kinematic and awake for the collision pass',
    v.kinematic === true && v.sleeping === false,
    `kinematic ${v.kinematic}, sleeping ${v.sleeping}`);
}

/* ================================================================== */
/* 2. NEGATIVE CONTROL — paralysed service, same checks must go red    */
/* ================================================================== */

{
  const sys2 = makeSys();
  const svc2 = new TramService(sys2, { paralysed: true });
  const track2 = run(svc2, makeCtx(), 60);
  let s0 = Infinity;
  let s1 = -Infinity;
  for (const p of track2) { if (p.s < s0) s0 = p.s; if (p.s > s1) s1 = p.s; }
  const span2 = track2.length ? s1 - s0 : 0;
  check('CONTROL: a paralysed tram fails the advance check', !(span2 > 900),
    `span ${span2.toFixed(1)} m — the sweep assertion above would go red`);
  check('CONTROL: ...while still standing on the rail',
    track2.length > 0 && track2[0].lat < 0.5,
    track2.length ? `lat ${track2[0].lat.toFixed(2)} m` : 'no tram');
}

/* ================================================================== */
/* 3. CHECKER SELF-CHECK — the on-rails test can fail                  */
/* ================================================================== */

{
  const pr = { s: 0, lat: 0, railY: 0 };
  let worst = 0;
  for (let i = 0; i < track.length; i += 25) {
    const p = track[i];
    project(LINE, p.x + 2.5, p.z, pr);
    if (pr.lat > worst) worst = pr.lat;
  }
  check('CONTROL: a tram 2.5 m off the track trips the on-rails check', worst > 0.35,
    `offset trajectory reads ${worst.toFixed(2)} m worst lateral vs the 0.35 bogie bar`);
}

report();

function report() {
  console.log('');
  console.log(`${pass}/${pass + fail} tram assertions pass`);
  if (fail) {
    console.log('');
    for (const f of fails) console.log(`  - ${f}`);
  }
  process.exit(fail ? 1 : 0);
}
