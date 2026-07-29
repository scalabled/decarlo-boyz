#!/usr/bin/env node
/**
 * CAN A PERSON ON A KEYBOARD KEEP IT ON THE ROAD? — as a gate.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 * Cars drift off the sides of the road. Road contiguity was fixed (16 780 m of
 * holes -> 399.6 m) and a suspension grounding bug was fixed (22 of 60 lane
 * sites making no drive force at all -> 0), and it still happened. So it is not
 * the road and it is not the suspension: it is the steering, and specifically
 * the steering AS A KEYBOARD DRIVES IT.
 *
 * A key is a STEP input. `src/player/vehicle.js` ramps the axis with a 0.07 s
 * time constant and `spec.steer.rate` is 4-5 rad/s, so a 0.15 s tap of D
 * arrives at whatever the lock is worth before the finger is off the key. At
 * 60 km/h a sedan's lock was worth 22.3 degrees at the road wheel — a real
 * driver uses three or four — so every correction was a swerve, and correcting
 * the swerve needed another swerve. That is a pilot-induced oscillation and it
 * is what "hard to drive" is.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT IS ASSERTED
 * ---------------------------------------------------------------------------
 * Nothing here reads `spec.steer.max`, `speedFalloff`, `STEER_OVERDRIVE`,
 * `wheelbase`, a grip coefficient or the steer angle. Every assertion is on an
 * EMITTED trajectory:
 *
 *   - METRES of lateral deviation from the centre line of a real route,
 *     measured against the closest point on the path, with the car driven by a
 *     keyboard driver;
 *   - METRES of lateral offset and DEGREES of heading change three seconds
 *     after one 0.15 s tap of the steering key, open loop;
 *   - the METRES of turning radius the car still has at parking speed, which is
 *     the guard against "fixing" the handling by taking the steering away.
 *
 * THE DRIVER IS A FIXED POLICY AND IT IS PART OF THE HARNESS, NOT OF THE
 * ANSWER. It presses a key or it does not — `approach(axis, key, 0.07, dt)`,
 * the exact shaping `player/vehicle.js` applies — at an 8 Hz decision rate with
 * 0.15 s of reaction lag, aiming at a preview point 1.1 seconds down the road.
 * Its gain is fixed and its input is normalised by the preview distance, so it
 * is the same driver in every arm and at every speed.
 *
 * That is a real risk of measuring the harness instead of the car, so there is
 * a control for it: **every 40 km/h car run passes in BOTH arms.** Measured on
 * a sedan, worst deviation 1.07 m without the fix and 0.78 m with it — the
 * driver can drive. That is what makes the 60 and 80 km/h results (6.05 m and
 * 72.35 m without it, 0.83 m and 1.04 m with it) a statement about the car
 * rather than about the driver.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROL — measured
 * ---------------------------------------------------------------------------
 * Delete the grip-cap block in `Vehicle._updateSteering` (the `kind !== 'boat'`
 * clause that computes `neutral` and narrows `lock`) and run again:
 *
 * 11/33, and the shape of the failure is the whole argument.
 *
 *   ROUTE 7/20.  Worst deviation from the centre line, fixed -> broken:
 *                sedan   60 km/h  0.83 m ->  6.05 m   (16% of the run on the kerb)
 *                sedan   80 km/h  1.04 m -> 72.35 m   (62% out, 51% sliding)
 *                cruiser 60 km/h  0.90 m -> 25.59 m
 *                cruiser 80 km/h  0.61 m -> 68.49 m
 *                Ironside 60 km/h 0.51 m -> 46.78 m
 *                Slagbolt 40 km/h 0.74 m -> 32.22 m, and it does not finish
 *                the route at all.
 *                The seven that still pass are every 40 km/h car row plus the
 *                truck and the bus, i.e. exactly the cases where the cap was
 *                never binding. That is the harness control, and it is why the
 *                other thirteen are about the car.
 *   TAP    0/9.  One 0.15 s tap of the key, fixed -> broken:
 *                sedan 60 km/h   5.63 ->  9.41 m sideways, 28.5 -> 41.0 deg/s
 *                sedan 90 km/h   5.80 -> 15.17 m sideways, 17.4 -> 40.0 deg/s
 *                Slagbolt 60 km/h  26.2 -> 174.3 DEGREES of heading change —
 *                one tap of the steering key spins the bike round.
 *   LOWSPEED 4/4 unchanged, which is the point of that section: the fix costs
 *                no low-speed authority at all.
 *
 *   node src/vehicles/laneprobe.mjs [--verbose] [--report]
 */

import * as THREE from 'three';
import { VEHICLE_SPECS, finalizeSpec, SURFACE_GRIP } from './specs.js';
import { Vehicle } from './dynamics.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const VERBOSE = !!args.verbose;

const results = [];
let failed = 0;
function check(section, name, ok, detail) {
  results.push({ section, name, ok, detail });
  if (!ok) failed++;
}

/* ------------------------------------------------------------------ */
/* A flat plane. No city, so the answer cannot depend on which hour's   */
/* road network happens to be built.                                    */
/* ------------------------------------------------------------------ */

const DT = 1 / 120;
const HIT = {
  hit: true, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
  distance: 0, surface: 'asphalt', object: null,
};
const physics = {
  MASK: { WORLD: 3 }, staticWorld: null, groundHeight: () => 0,
  raycast(o, dir, maxDist) {
    if (dir.y >= -1e-6) { HIT.hit = false; return HIT; }
    const t = -o.y / dir.y;
    if (t < 0 || t > maxDist) { HIT.hit = false; return HIT; }
    HIT.hit = true; HIT.distance = t;
    HIT.point.set(o.x + dir.x * t, 0, o.z + dir.z * t);
    HIT.normal.set(0, 1, 0); HIT.surface = 'asphalt';
    return HIT;
  },
};
const SYS = {
  physics, lodOf: () => 0, surfaceAt: () => 'asphalt', waterHeightAt: () => null,
  reportCollision: () => {}, _world: () => null,
  gripOf: (n) => SURFACE_GRIP[n] ?? SURFACE_GRIP.asphalt,
};
const MODEL = { root: null, wheels: [], panels: [], glassMeshes: [], lampMats: {} };
const CTX = { events: { emit() {} }, peek: () => null, time: { elapsed: 0 } };

function make(type) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(SYS, spec, MODEL, {});
  v.setPose(new THREE.Vector3(0, spec.comY, 0), 0);
  v.damage = null;
  return v;
}
/** The exact easing `src/player/springs.js` exports and `player/vehicle.js` uses. */
const approach = (c, t, tau, dt) => t + (c - t) * Math.exp(-dt / tau);
const deg = (r) => (r * 180) / Math.PI;
const _f = new THREE.Vector3();
function headingOf(v) {
  _f.set(0, 0, 1).applyQuaternion(v.quaternion);
  return Math.atan2(_f.x, _f.z);
}
/** One 60 Hz control frame = two 120 Hz physics steps, as the engine runs it. */
function frame(v, throttle, brake, steerAxis) {
  v.input.throttle = throttle; v.input.brake = brake; v.input.steer = steerAxis;
  v.input.handbrake = false; v.input.reverse = 0; v.input.boost = 0;
  v.fixedStep(DT, CTX); v.fixedStep(DT, CTX);
}
function settle(v) { for (let i = 0; i < 360; i++) frame(v, 0, 1, 0); }
/** Get up to `target` m/s on a straight, or report that the class cannot. */
function runUp(v, target) {
  for (let f = 0; f < 60 * 60 && v.forwardSpeed < target; f++) frame(v, 1, 0, 0);
  return v.forwardSpeed >= target * 0.92;
}

/**
 * A PERSON ON A KEYBOARD. He does not hold the key, he taps it: the decision
 * rate is 8 Hz and the pulse WIDTH carries the magnitude, which is the only
 * thing a two-state control can modulate.
 */
class KeyDriver {
  constructor() {
    this.axis = 0; this.phase = 0; this.duty = 0; this.dir = 0; this.hist = [];
  }
  /** @param aim  preview miss over preview distance — a required heading change, radians. */
  step(aim, dtF) {
    this.hist.push(aim);
    const lag = this.hist[Math.max(0, this.hist.length - 1 - Math.round(0.15 * 60))];
    this.phase += dtF * 8;
    if (this.phase >= 1) {
      this.phase -= 1;
      const u = Math.max(-1, Math.min(1, lag * 3));
      this.duty = Math.abs(u) < 0.06 ? 0 : Math.abs(u);
      this.dir = Math.sign(u);
    }
    const key = this.phase < this.duty ? this.dir : 0;
    this.axis = approach(this.axis, key, 0.07, dtF);
    return this.axis;
  }
}

/* ------------------------------------------------------------------ */
/* THE ROUTE — a city arterial: straight, a tight bend, straight, a     */
/* wider bend the other way, straight. 355 m.                           */
/* ------------------------------------------------------------------ */

const SEGS = [
  { kind: 'line', len: 80 },
  { kind: 'arc', r: 55, sweep: -Math.PI / 2 },
  { kind: 'line', len: 60 },
  { kind: 'arc', r: 70, sweep: Math.PI / 2 },
  { kind: 'line', len: 80 },
];
const ROUTE_LEN = SEGS.reduce((a, s) => a + (s.kind === 'line' ? s.len : s.r * Math.abs(s.sweep)), 0);
/** Half a lane. A car whose centre is further out than this is on the kerb. */
const LANE_HALF = 1.75;

function advance(p, seg, len) {
  if (seg.kind === 'line') {
    p.x += Math.sin(p.h) * len; p.z += Math.cos(p.h) * len;
    return;
  }
  const sign = Math.sign(seg.sweep);
  const th = (len / seg.r) * sign;
  const cx = p.x + Math.sin(p.h + (Math.PI / 2) * sign) * seg.r;
  const cz = p.z + Math.cos(p.h + (Math.PI / 2) * sign) * seg.r;
  const a0 = Math.atan2(p.x - cx, p.z - cz);
  p.x = cx + Math.sin(a0 + th) * seg.r;
  p.z = cz + Math.cos(a0 + th) * seg.r;
  p.h += th;
}

/** Point and heading at arc length `s` along the route. */
function pathAt(s) {
  const p = { x: 0, z: 0, h: 0 };
  let rem = s;
  for (const seg of SEGS) {
    const L = seg.kind === 'line' ? seg.len : seg.r * Math.abs(seg.sweep);
    if (rem <= L) { advance(p, seg, rem); return p; }
    advance(p, seg, L);
    rem -= L;
  }
  p.x += Math.sin(p.h) * rem; p.z += Math.cos(p.h) * rem;
  return p;
}

/** Drive the route at `kmh` and report the emitted deviation, in metres. */
function driveRoute(type, kmh) {
  const v = make(type);
  settle(v);
  const cruise = kmh / 3.6;
  if (!runUp(v, cruise)) return { skip: true };
  v.setPose(new THREE.Vector3(0, v.position.y, 0), 0);
  if (!runUp(v, cruise)) return { skip: true };

  const drv = new KeyDriver();
  let s = 0, maxDev = 0, sum2 = 0, n = 0, off = 0, sliding = 0;
  const startX = v.position.x, startZ = v.position.z;
  for (let f = 0; f < 60 * 120; f++) {
    /* Closest point on the path, searched forward from the previous one. */
    let best = s, bd = Infinity;
    for (let t = Math.max(0, s - 3); t < s + 15; t += 0.25) {
      const c = pathAt(t);
      const d = (c.x + startX - v.position.x) ** 2 + (c.z + startZ - v.position.z) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
    s = best;
    const c = pathAt(s);
    /* Signed lateral error against the path's own right vector. */
    const err = (v.position.x - c.x - startX) * Math.cos(c.h)
      + (v.position.z - c.z - startZ) * -Math.sin(c.h);

    const preview = Math.max(8, Math.min(28, v.forwardSpeed * 1.1));
    const a = pathAt(s + preview);
    _f.set(0, 0, 1).applyQuaternion(v.quaternion);
    const aimLat = (a.x + startX - v.position.x) * _f.z + (a.z + startZ - v.position.z) * -_f.x;
    const axis = drv.step(aimLat / preview, 1 / 60);
    frame(v, Math.max(0, Math.min(1, (cruise - v.forwardSpeed) * 0.5)), 0, axis);

    if (s > 6) {
      const e = Math.abs(err);
      if (e > maxDev) maxDev = e;
      sum2 += e * e; n++;
      if (e > LANE_HALF) off++;
      if (Math.abs(v.slipAngle) > 0.44) sliding++;
    }
    if (s > ROUTE_LEN - 6) break;
  }
  return {
    maxDev, rms: Math.sqrt(sum2 / Math.max(1, n)),
    outFrac: off / Math.max(1, n), slideFrac: sliding / Math.max(1, n),
    finished: s > ROUTE_LEN - 8,
  };
}

/**
 * ONE 0.15 s TAP of the steering key at a cruise, open loop, then three
 * seconds of hands-off. Returns how far sideways it put the car and how far it
 * turned it.
 */
function tap(type, kmh) {
  const v = make(type);
  settle(v);
  const cruise = kmh / 3.6;
  if (!runUp(v, cruise)) return { skip: true };
  const h0 = headingOf(v);
  const x0 = v.position.x, z0 = v.position.z;
  _f.set(0, 0, 1).applyQuaternion(v.quaternion);
  const rx = _f.z, rz = -_f.x;
  let axis = 0, peakYaw = 0;
  for (let f = 0; f < 60 * 3; f++) {
    axis = approach(axis, f / 60 < 0.15 ? 1 : 0, 0.07, 1 / 60);
    frame(v, Math.max(0, Math.min(1, (cruise - v.forwardSpeed) * 0.4)), 0, axis);
    const y = Math.abs(v.angularVelocity.y);
    if (y > peakYaw) peakYaw = y;
  }
  let dh = headingOf(v) - h0;
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  return {
    lat: Math.abs((v.position.x - x0) * rx + (v.position.z - z0) * rz),
    heading: Math.abs(deg(dh)),
    peakYaw: deg(peakYaw),
  };
}

/** Steady-state radius on full lock at `kmh`, in metres. */
function lockRadius(type, kmh) {
  const v = make(type);
  settle(v);
  const cruise = kmh / 3.6;
  if (!runUp(v, cruise)) return Infinity;
  let axis = 0;
  for (let f = 0; f < 60 * 4; f++) {
    axis = approach(axis, 1, 0.07, 1 / 60);
    frame(v, Math.max(0, Math.min(1, (cruise - v.forwardSpeed) * 0.4)), 0, axis);
  }
  let worst = 0;
  for (let f = 0; f < 60 * 2; f++) {
    axis = approach(axis, 1, 0.07, 1 / 60);
    frame(v, Math.max(0, Math.min(1, (cruise - v.forwardSpeed) * 0.4)), 0, axis);
    const y = Math.abs(v.angularVelocity.y);
    if (y > worst) worst = y;
  }
  return worst > 1e-4 ? Math.abs(v.forwardSpeed) / worst : Infinity;
}

/* ================================================================== */
/* 1. THE ROUTE                                                        */
/* ================================================================== */

/**
 * type, km/h, metres of worst deviation allowed, prose.
 *
 * Half a lane (1.75 m) is the real bar for a car: further out than that and a
 * wheel is on the kerb, which is the report. The 40 km/h rows are the CONTROL
 * — they pass in both arms and prove the driver can drive.
 *
 * ONE RATCHET, marked: the Ironside 440 at 80 km/h (2.2 m, and up to 8% of the
 * run outside the lane) is where this pass got to, not where the bar is; the
 * goal is half a lane for every class at every speed on this route. Lower it
 * when you improve it, never raise it to go green. What is left is mass — the
 * muscle car runs out of front grip on the 55 m bend before the steering runs
 * out of lock, which is a tyre and weight-transfer question rather than a
 * steering one.
 *
 * NOT TESTED, and deliberately: the Millhand 6 at 80 km/h. A 5.4 t truck asked
 * for 0.92 g on a 55 m bend is over its tyres (muLat 1.10) whatever the
 * steering does, and it slides — 70.4 m off line, in both arms. That is a
 * correct outcome, not a defect, and gating it would only record the day
 * somebody made trucks grip like cars.
 */
const ROUTE_CASES = [
  ['sedan', 40, 1.5, 0, 'a sedan holds its lane at 40 km/h'],
  ['sedan', 60, 1.75, 0, 'a sedan holds its lane at 60 km/h'],
  ['sedan', 80, 1.75, 0, 'a sedan holds its lane at 80 km/h'],
  ['sports', 40, 1.5, 0, 'a Peregrine GT holds its lane at 40 km/h'],
  ['sports', 60, 1.75, 0, 'a Peregrine GT holds its lane at 60 km/h'],
  ['sports', 80, 1.75, 0, 'a Peregrine GT holds its lane at 80 km/h'],
  ['police', 40, 1.5, 0, 'a Precinct Cruiser holds its lane at 40 km/h'],
  ['police', 60, 1.75, 0, 'a Precinct Cruiser holds its lane at 60 km/h'],
  ['police', 80, 1.75, 0, 'a Precinct Cruiser holds its lane at 80 km/h'],
  ['kessel', 60, 1.75, 0, 'a Kessel GT holds its lane at 60 km/h'],
  ['muscle', 40, 1.5, 0, 'an Ironside 440 holds its lane at 40 km/h'],
  ['muscle', 60, 1.75, 0, 'an Ironside 440 holds its lane at 60 km/h'],
  ['muscle', 80, 2.2, 0.08, 'an Ironside 440 stays on the road at 80 km/h  [RATCHET]'],
  ['truck', 40, 1.5, 0, 'a Millhand 6 holds its lane at 40 km/h'],
  ['truck', 60, 1.75, 0, 'a Millhand 6 holds its lane at 60 km/h'],
  ['van', 60, 1.75, 0, 'a Foundry Van holds its lane at 60 km/h'],
  ['bus', 60, 1.75, 0, 'a Steelhauler 30 holds its lane at 60 km/h'],
  ['bike', 40, 1.5, 0, 'a Slagbolt holds its lane at 40 km/h'],
  ['bike', 60, 1.75, 0, 'a Slagbolt holds its lane at 60 km/h'],
  ['bike', 80, 1.75, 0, 'a Slagbolt holds its lane at 80 km/h'],
];

function testRoute() {
  for (const [type, kmh, limit, outLimit, prose] of ROUTE_CASES) {
    const r = driveRoute(type, kmh);
    if (r.skip) { check('route', prose, false, 'the class never reached the cruise speed'); continue; }
    check('route', prose,
      r.finished && r.maxDev <= limit && r.outFrac <= outLimit,
      `worst ${r.maxDev.toFixed(2)} m off the centre line (want <= ${limit}), ` +
      `rms ${r.rms.toFixed(2)} m, ${(r.outFrac * 100).toFixed(1)}% of the run outside the lane, ` +
      `${(r.slideFrac * 100).toFixed(1)}% sliding, finished ${r.finished}`);
  }
}

/* ================================================================== */
/* 2. WHAT ONE TAP OF THE KEY DOES                                     */
/* ================================================================== */

/**
 * type, km/h, max metres sideways, max degrees of heading, max deg/s of yaw.
 * A lane is 3.5 m wide; a tap that moves you more than about two lanes in three
 * seconds is a swerve, not a correction.
 */
const TAP_CASES = [
  ['sedan', 60, 7.0, 9.5, 34],
  ['sedan', 90, 8.0, 7.0, 22],
  ['sports', 60, 7.0, 9.5, 36],
  ['sports', 90, 8.0, 7.0, 24],
  ['police', 60, 7.0, 9.5, 36],
  ['police', 90, 8.0, 7.0, 24],
  ['truck', 60, 6.0, 8.0, 24],
  ['bike', 60, 20.0, 45.0, 70],
  ['bike', 90, 24.0, 40.0, 65],
];

function testTap() {
  for (const [type, kmh, mLat, mHead, mYaw] of TAP_CASES) {
    const r = tap(type, kmh);
    if (r.skip) { check('tap', `${type} at ${kmh} km/h`, false, 'never reached the speed'); continue; }
    check('tap', `one tap of the key at ${kmh} km/h nudges the ${type}, it does not throw it`,
      r.lat <= mLat && r.heading <= mHead && r.peakYaw <= mYaw,
      `${r.lat.toFixed(2)} m sideways (want <= ${mLat}), ${r.heading.toFixed(1)} deg of ` +
      `heading (want <= ${mHead}), ${r.peakYaw.toFixed(1)} deg/s peak yaw (want <= ${mYaw})`);
  }
}

/* ================================================================== */
/* 3. ...AND THE CAR MUST STILL TURN                                   */
/* ================================================================== */

/**
 * The cheap way to pass every check above is to take the steering away. This
 * section is the reason that does not work: at manoeuvring speed the car has to
 * keep the lock it always had, and a tap has to still DO something.
 */
function testLowSpeed() {
  {
    const r = lockRadius('sedan', 25);
    check('lowspeed', 'a sedan still turns inside a street on full lock at 25 km/h',
      r <= 12, `${r.toFixed(1)} m radius (want <= 12)`);
  }
  {
    const r = lockRadius('truck', 25);
    check('lowspeed', 'a Millhand 6 still turns inside a junction at 25 km/h',
      r <= 20, `${r.toFixed(1)} m radius (want <= 20)`);
  }
  {
    const r = tap('sedan', 30);
    check('lowspeed', 'a tap at 30 km/h still moves the car — it is not numb',
      r.heading >= 4 && r.lat >= 1.2,
      `${r.heading.toFixed(1)} deg of heading, ${r.lat.toFixed(2)} m sideways ` +
      `(want >= 4 deg and >= 1.2 m)`);
  }
  {
    /* Straight-line tracking, hands off: any drift here is a defect of its own
     * and would make every number above meaningless. */
    const v = make('sedan');
    settle(v);
    let th = 0, worst = 0;
    for (let f = 0; f < 60 * 20; f++) {
      th = approach(th, 1, 0.05, 1 / 60);
      frame(v, th, 0, 0);
      if (Math.abs(v.position.x) > worst) worst = Math.abs(v.position.x);
    }
    check('lowspeed', 'hands off, it tracks dead straight',
      worst < 0.05, `${worst.toFixed(3)} m of drift over ${v.position.z.toFixed(0)} m`);
  }
}

/* ------------------------------------------------------------------ */

if (args.report) {
  const out = {};
  for (const t of ['sedan', 'sports', 'muscle', 'kessel', 'police', 'truck', 'bike', 'van', 'bus']) {
    out[t] = {};
    for (const k of [40, 60, 80]) {
      const r = driveRoute(t, k);
      out[t]['route' + k] = r.skip ? 'skip'
        : `${r.maxDev.toFixed(2)}/${r.rms.toFixed(2)} out ${(r.outFrac * 100).toFixed(0)}% ` +
          `slide ${(r.slideFrac * 100).toFixed(0)}% fin ${r.finished}`;
    }
    for (const k of [30, 60, 90]) {
      const r = tap(t, k);
      out[t]['tap' + k] = r.skip ? 'skip'
        : `${r.lat.toFixed(2)} m ${r.heading.toFixed(1)} deg ${r.peakYaw.toFixed(1)} deg/s`;
    }
    out[t].lockR25 = lockRadius(t, 25).toFixed(1);
  }
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}

testRoute();
testTap();
testLowSpeed();

const bySection = {};
for (const r of results) (bySection[r.section] ??= []).push(r);
for (const [s, rows] of Object.entries(bySection)) {
  const bad = rows.filter((r) => !r.ok).length;
  console.log(`\n${s.toUpperCase()}  ${rows.length - bad}/${rows.length}`);
  for (const r of rows) {
    if (r.ok && !VERBOSE) continue;
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}\n         ${r.detail}`);
  }
}
console.log(`\nkeyboard lane keeping: ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
