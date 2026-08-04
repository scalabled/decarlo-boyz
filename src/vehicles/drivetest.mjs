#!/usr/bin/env node
/**
 * DRIVE TEST — "the car does not move" as a gate instead of a sighting.
 *
 * `tools/playprobe.mjs` found the defect this file exists for, but it found it
 * about half the time: it drives ONE car, from wherever the player happens to
 * be standing, and whether the car ends up on a lane or nose-down a river bank
 * is decided by how far a sprint got that run. A gate that fires on a coin flip
 * is not a gate — the bug survived several rounds of review precisely because a
 * green run proved nothing.
 *
 * So this runs the REAL `Vehicle` at the real 120 Hz step against a synthetic
 * plane that can be tilted and given any surface, over every class, and asserts
 * SIGNED outcomes from many spawns:
 *
 *   1. STABILITY  a rolling wheel must not oscillate. This is the root cause:
 *      the wheel-spin ODE is stiff at low road speed and explicit Euler was
 *      six times past its stability limit, so undriven wheels flipped sign
 *      every 120 Hz step and threw +2700/-2400 N at the chassis. Gated on the
 *      slip the wheels actually sit at and on the peak-to-peak body force,
 *      because those are what the defect looked like from outside.
 *   2. LAUNCH     full throttle from rest must produce POSITIVE forward speed,
 *      on tarmac and on every loose surface the city has.
 *   3. GRADE      the same, up a hill. A car that cannot climb out of the verge
 *      it just slid into is stuck for the rest of the session.
 *   4. REVERSE    hold the brake at a standstill (which is all a keyboard can
 *      do) and the car must end up going BACKWARDS. Signed, always: `speed` is
 *      unsigned and a car driving the wrong way scores full marks on it.
 *   5. NO BURNOUT LATCH  the exact site `playprobe` gets stuck at — a sedan
 *      nose-down a 14.5 degree dirt bank — must back out. Spinning tyres make
 *      70% of the force hooked-up ones do, so this is bistable, and pinning a
 *      digital throttle parks it on the wrong side.
 *   6. SHOVE      the car in front is not a wall.
 *   7. STEERING   which way the car actually GOES when you hold a control, in
 *      world space, for BOTH conventions `setInput` is handed — see the section
 *      header. Never asserted against the input that produced it.
 *   8. LAYOUT     Pittsburgh is a right-hand-traffic city, so the seat, the
 *      door the actor walks to and the steering wheel must all be on the car's
 *      LEFT — measured along a right vector derived from three's camera basis,
 *      not from the constant that placed them.
 *   9. KERBS      a repro of "stuck backing over a curb, floating in the air":
 *      a real kerb solid, approached forwards at several angles and speeds and
 *      in reverse, plus the high-centred case, plus a wall as the negative
 *      control for the recovery.
 *
 *   node src/vehicles/drivetest.mjs
 *   node src/vehicles/drivetest.mjs --verbose
 *   node src/vehicles/drivetest.mjs --type=sedan
 */

import * as THREE from 'three';
import { VEHICLE_SPECS, finalizeSpec, SURFACE_GRIP, WET_SENS, wetGrip } from './specs.js';
import { Vehicle } from './dynamics.js';
import { VehicleSystem } from './index.js';
import { buildInterior, buildBoatInterior } from './interior.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const VERBOSE = !!args.verbose;
const DT = 1 / 120;

/**
 * Every class that drives on WHEELS. The boat has no wheels and no gradient to
 * climb; the helicopter has neither wheels nor a gearbox nor a kerb to ride
 * over, and gets its own section (11) instead of being forced through nine
 * that do not describe it.
 */
const CAR_TYPES = Object.keys(VEHICLE_SPECS).filter(
  (k) => VEHICLE_SPECS[k].kind !== 'boat' && VEHICLE_SPECS[k].kind !== 'heli' &&
    VEHICLE_SPECS[k].kind !== 'plane'
);
// `--type=heli` must still reach section 11 without being dragged through the
// nine wheeled ones — filter the selection rather than trusting the caller.
const TYPES = (args.type ? String(args.type).split(',') : CAR_TYPES)
  .filter((k) => CAR_TYPES.includes(k));

/* ------------------------------------------------------------------ */
/* A tiltable plane with a surface tag.                                */
/* ------------------------------------------------------------------ */

/**
 * @param surface a `SURFACE_GRIP` key
 * @param slopeDeg ground falls toward +Z, so a car at yaw 0 points DOWNHILL
 * @param wet 0..1, applied exactly as `VehicleSystem.setWetness` applies it
 */
function makeWorld(surface, slopeDeg, wet = 0) {
  const a = (slopeDeg * Math.PI) / 180;
  const N = new THREE.Vector3(0, Math.cos(a), Math.sin(a)).normalize();
  const HIT = {
    hit: true, point: new THREE.Vector3(), normal: N.clone(),
    distance: 0, surface, object: null,
  };
  const grip = {};
  for (const k in SURFACE_GRIP) {
    const base = SURFACE_GRIP[k];
    const sens = WET_SENS[k] ?? 0.6;
    grip[k] = {
      ...base,
      mu: wetGrip(base.mu, wet * sens),
      skid: base.skid * (1 + 0.5 * wet * sens),
      roll: base.roll * (1 + 0.1 * wet * sens),
      drag: base.drag + 0.012 * wet * sens,
    };
  }
  const physics = {
    MASK: { WORLD: 3 },
    staticWorld: null,
    raycast(origin, dir, maxDist) {
      const denom = N.dot(dir);
      if (Math.abs(denom) < 1e-6) { HIT.hit = false; return HIT; }
      const t = -N.dot(origin) / denom;
      if (t < 0 || t > maxDist) { HIT.hit = false; return HIT; }
      HIT.hit = true;
      HIT.distance = t;
      HIT.point.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
      HIT.normal.copy(N);
      HIT.surface = surface;
      return HIT;
    },
    groundHeight: (x, z) => -(N.z * z) / N.y,
  };
  return {
    slope: a,
    physics,
    lodOf: () => 0,
    surfaceAt: () => surface,
    waterHeightAt: () => null,
    reportCollision: () => {},
    gripOf: (n) => grip[n] ?? grip.asphalt,
    _world: () => null,
  };
}

const STUB_MODEL = { root: null, wheels: [], panels: [], glassMeshes: [], lampMats: {} };
const CTX = { events: { emit() {} }, peek: () => null, time: { elapsed: 0 } };

const _euler = new THREE.Euler();
function spawn(type, sys, { autoReverse = false } = {}) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(sys, spec, STUB_MODEL, {});
  v.damage = null;
  v.setPose(new THREE.Vector3(0, spec.comY, 0), 0);
  /**
   * PITCH THE CAR ONTO THE SLOPE. `setPose` only takes a yaw, so a car spawned
   * on a 20 degree bank starts level: the rear wheels are half a metre under
   * the ground, the front half a metre above it and past the end of their
   * struts, and it tumbles off before the test begins (`grounded 0`, sliding at
   * 13 m/s, y = -10.7 m). Every "car cannot climb" reading at 20 degrees was
   * that, not the car.
   */
  if (sys.slope) {
    v.quaternion.setFromEuler(_euler.set(sys.slope, 0, 0, 'YXZ'));
    v.prevQuaternion.copy(v.quaternion);
  }
  v.autoReverse = autoReverse;
  return v;
}

const _fwd = new THREE.Vector3();
/** Run `n` steps with a fixed input. `probe(v, i)` is called after each. */
function drive(v, input, n, probe) {
  for (let i = 0; i < n; i++) {
    v.input.throttle = input.throttle ?? 0;
    v.input.brake = input.brake ?? 0;
    v.input.steer = input.steer ?? 0;
    v.input.reverse = input.reverse ?? 0;
    v.input.handbrake = !!input.handbrake;
    // The SPRINT channel. Left out of this helper originally — which is how a
    // boost section could report `x1.000` for every class in the fleet and look
    // like a finding about the engine rather than about the harness.
    v.input.boost = input.boost ?? 0;
    v.fixedStep(DT, CTX);
    if (probe) probe(v, i);
  }
  return v;
}

/** Settle onto the plane with the brakes on, without arming reverse. */
function settle(v) {
  const ar = v.autoReverse;
  v.autoReverse = false;
  drive(v, { brake: 1 }, 300);
  v.autoReverse = ar;
  v.drivetrain.reset();
  return v;
}

/* ------------------------------------------------------------------ */

const results = [];
let failed = 0;
function check(section, name, ok, detail) {
  results.push({ section, name, ok, detail });
  if (!ok) failed++;
}

/* ------------------------------------------------------------------ */
/* 1. STABILITY — the root cause, gated directly.                      */
/* ------------------------------------------------------------------ */

/**
 * A wheel that is neither driven nor braked is doing one job: rolling at the
 * speed the road is turning it. `slipRatio` is how far off that it is, and it
 * should be a rounding error. The measured failure was +/-4 rad/s of alternate
 * -step oscillation, which reads as a slip ratio of order 1 and produced a
 * chassis force that flipped sign every step and averaged to nothing — a car
 * at full throttle, four wheels down, nothing touching it, going nowhere.
 *
 * Both halves are checked: the slip the wheels sit at, and the peak-to-peak
 * longitudinal force the chassis is handed. A stable integrator has to pass
 * both; the old one failed both by two orders of magnitude.
 */
function testStability(type) {
  const sys = makeWorld('asphalt', 0);
  for (const speed of [0, 8, 20]) {
    const v = spawn(type, sys);
    settle(v);
    // Bring it to speed, then coast: no throttle, no brake, nothing to explain
    // any slip at all.
    if (speed > 0) {
      for (let i = 0; i < 120 * 40 && v.forwardSpeed < speed; i++) {
        drive(v, { throttle: 1 }, 1);
      }
    }
    let maxSlip = 0;
    // Only the LAST second counts. The old integrator never settled at all, at
    // any speed, so a settled window is a fair and much sharper test: measured
    // slip ratios were 0.12 to 2.22 before and are 0.003 to 0.08 now.
    const total = 120 * 6;
    drive(v, {}, total, (veh, i) => {
      if (i < total - 120) return;
      for (const w of veh.wheels) {
        if (!w.grounded) continue;
        const s = Math.abs(w.slipRatio);
        if (s > maxSlip) maxSlip = s;
      }
    });
    check('stability', `${type} coasting from ${speed} m/s: wheels roll`,
      maxSlip < 0.12, `max |slipRatio| ${maxSlip.toFixed(4)} (want < 0.12)`);
  }

  /**
   * And the same thing seen from the chassis: the force a steady cruise hands
   * the body must be steady. The oscillation this gates was worth 30 000 N
   * peak-to-peak at 3 m/s, alternating sign every step and averaging to zero,
   * which is precisely how a car at full throttle stood still.
   *
   * Held at speed by a throttle controller rather than left to coast, because a
   * coasting car eventually arrives at walking pace — and BELOW about 2 m/s the
   * body rings against the tyre's very stiff low-speed spring for a second or
   * so whatever the wheels do. That transient is real, pre-existing, and self-
   * damping; it is a different defect from this one and gating it here would
   * only make this test lie about what it covers.
   */
  for (const speed of [8, 20]) {
    const v = spawn(type, sys);
    settle(v);
    for (let i = 0; i < 120 * 40 && v.forwardSpeed < speed; i++) drive(v, { throttle: 1 }, 1);
    let fMin = Infinity;
    let fMax = -Infinity;
    for (let i = 0; i < 120 * 3; i++) {
      const e = speed - v.forwardSpeed;
      drive(v, { throttle: Math.max(0, Math.min(1, e * 0.4)) }, 1);
      if (i < 120) continue;
      _fwd.set(0, 0, 1).applyQuaternion(v.quaternion);
      const f = v._force.dot(_fwd);
      if (f < fMin) fMin = f;
      if (f > fMax) fMax = f;
    }
    const ripple = fMax - fMin;
    const cap = Math.max(900, v.mass * 0.6);
    check('stability', `${type} holding ${speed} m/s: chassis force is smooth`,
      ripple < cap, `peak-to-peak ${ripple.toFixed(0)} N (want < ${cap.toFixed(0)})`);
  }
}

/* ------------------------------------------------------------------ */
/* 2 + 3. LAUNCH and GRADE — signed, from many spawns.                 */
/* ------------------------------------------------------------------ */

/**
 * Full throttle from rest. `slopeDeg` is NEGATIVE for a climb, because the
 * plane falls toward +Z and the car's nose is +Z.
 */
function launch(type, surface, slopeDeg, seconds) {
  const v = spawn(type, makeWorld(surface, slopeDeg));
  settle(v);
  drive(v, { throttle: 1 }, Math.round(120 * seconds));
  return v;
}

const LAUNCH_SITES = [
  // surface, slope (deg, negative = uphill), seconds, min m/s
  ['asphalt', 0, 4, 10],
  ['concrete', 0, 4, 10],
  ['gravel', 0, 4, 6],
  ['dirt', 0, 4, 6],
  ['grass', 0, 4, 6],
  ['sand', 0, 4, 3],
  ['asphalt', -14.5, 5, 6],
  ['dirt', -14.5, 5, 3],
  ['grass', -14.5, 5, 0.8],
  ['asphalt', -20, 5, 3.5],
];

/**
 * The base numbers above were written for a fleet whose slowest member tops out
 * at 110 km/h. Two of the parity classes are outside that range by a long way
 * and a bar written for a pickup is not a bar for either of them:
 *
 *   bus      10.2 t, governed at 103 km/h. Flat is fine; a GRADE is what
 *            separates it, because 25.1 kN of a 14.5 degree slope and 36.2 kN
 *            of a 20 degree one are large fractions of the 45 kN its first gear
 *            makes. It climbs both — which is the property that matters, since
 *            a player who parks a bus on Mt. Washington must not be trapped —
 *            but it climbs the 36% one at 0.53 m/s, and no bus does better.
 *   bicycle  360 W and 92 kg. Its top speed is 10.4 m/s, so a bar of 10 m/s in
 *            four seconds is a bar it could not clear with unlimited traction.
 *            Uphill it is power-limited outright: 360 W against a 26% grade is
 *            226 N of gravity, i.e. 1.59 m/s, and that is a real rider's real
 *            speed up a real Pittsburgh wall.
 *
 * Flat and hill are scaled separately for exactly that reason. NOT applied to
 * any existing class — every entry here is 1 for the eight that were already
 * gated, so nothing that passed before can pass more easily now.
 */
const LAUNCH_SCALE = {
  bus: { flat: 0.62, hill: 0.25 },
  bicycle: { flat: 0.30, hill: 0.20 },
};

function testLaunch(type) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  // The truck and the van are commercial vehicles; they are not expected to
  // match a cruiser up a 1-in-4. Scale by power to weight.
  const heavy = spec.mass > 2400;
  const fwd = spec.drive === 'fwd';
  const cls = LAUNCH_SCALE[type];
  for (const [surface, slope, secs, want] of LAUNCH_SITES) {
    /**
     * A FRONT-DRIVE car climbing a loose bank is asserted only in REVERSE, and
     * that is a real property of the layout rather than a lowered bar. Nose-up
     * acceleration takes weight OFF the driven axle: the sedan's front load
     * drops to 7.2 kN, grass gives 4.4 kN of thrust against 3.7 kN of gravity
     * and 0.5 kN of rolling resistance, and it simply runs out. Backing UP the
     * same bank puts the weight back on the driven wheels, and the reverse
     * section asserts exactly that — the sedan leaves a 14.5 degree dirt bank at
     * 6.4 m/s. The player is never trapped, which is the thing that matters.
     */
    if (fwd && slope < 0 && surface !== 'asphalt') continue;
    let target = want;
    if (heavy) target *= slope < 0 ? 0.45 : 0.7;
    else if (fwd && slope < 0) target *= 0.3;
    if (cls) target *= slope < 0 ? cls.hill : cls.flat;
    const v = launch(type, surface, slope, secs);
    check('launch',
      `${type} on ${surface}${slope ? ` at ${-slope} deg uphill` : ''}`,
      v.forwardSpeed > target,
      `${v.forwardSpeed.toFixed(2)} m/s after ${secs}s (want > ${target.toFixed(1)})`);
  }
}

/* ------------------------------------------------------------------ */
/* 4. REVERSE — hold the brake, end up going backwards.                */
/* ------------------------------------------------------------------ */

const REVERSE_SITES = [
  ['asphalt', 0, 6, -4],
  ['dirt', 0, 6, -4],
  ['grass', 0, 6, -3],
  ['sand', 0, 6, -2],
  // Nose-down a bank: the site `playprobe` finds, and where it got stuck.
  ['asphalt', 14.5, 8, -4],
  ['dirt', 14.5, 8, -1.5],
  ['dirt', 8, 8, -3],
  ['grass', 8, 8, -3],
  ['sand', 8, 8, -1.5],
];

function testReverse(type) {
  for (const [surface, slope, secs, want] of REVERSE_SITES) {
    const spec = finalizeSpec(VEHICLE_SPECS[type]);
    const cap = spec.gearbox.reverseMax;
    // A bike "reverses" at walking pace by design (2.6 m/s cap), and a loaded
    // truck at 4.6; scale the target off each class's own governor.
    /**
     * A BIKE is excluded from the steep nose-down sites, and that is the same
     * honesty as the front-drive exclusion above rather than a lowered bar.
     * `reverseMax` is 2.6 m/s for a two-wheeler because there is no reverse
     * gear on a motorcycle — the rider walks it backwards. Walking a 232 kg
     * superbike up a 1-in-4 of loose dirt is not a thing, and asserting it
     * would only train someone to relax the number later.
     */
    if (spec.kind === 'bike' && slope > 10 && surface !== 'asphalt') continue;
    const target = Math.max(want, -cap * 0.55) * (slope > 10 ? 0.7 : 1);
    const v = spawn(type, makeWorld(surface, slope), { autoReverse: true });
    settle(v);
    // S, and nothing else — exactly what the keyboard sends.
    drive(v, { brake: 1 }, Math.round(120 * secs));
    check('reverse',
      `${type} backs out on ${surface}${slope ? ` from a ${slope} deg nose-down` : ''}`,
      v.forwardSpeed < target,
      `${v.forwardSpeed.toFixed(2)} m/s, gear ${v.drivetrain.gearLabel} (want < ${target.toFixed(1)})`);
  }

  /**
   * ROLLING BACKWARDS WITH S HELD MUST GIVE YOU REVERSE, not the brakes.
   *
   * The gear-selection guard used to read `forwardSpeed > -0.05`, so a car
   * already drifting backwards faster than 5 cm/s was treated as one that had
   * not stopped yet: full brake, no drive, gearbox left in first. Measured on an
   * icy nose-up slope with S held for the whole 900 frames — `gear 1, control
   * throttle/brake 0.00/1.00, rpm 360, _revHold 6.98 s`, seven seconds past a
   * 0.18 s dwell, sliding down the hill with no drive at all.
   *
   * Asserted on a slippery gradient because that is what SUSTAINS the drift. On
   * the flat the same bug only delayed engagement about 25 frames and then got
   * away with it, which is exactly how it survived: the brake pulls the drift
   * back inside the window by luck, and the test passes.
   */
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  for (const surface of ['ice', 'mud']) {
    const v = spawn(type, makeWorld(surface, -6), { autoReverse: true });
    settle(v);
    // Roll it backwards down the slope with nothing pressed, then hold S.
    drive(v, {}, 120 * 3);
    let gotReverse = -1;
    drive(v, { brake: 1 }, 120 * 4, (veh, i) => {
      if (gotReverse < 0 && veh.drivetrain.gear === 0) gotReverse = i;
    });
    check('reverse',
      `${type} rolling backwards on ${surface} takes reverse, not the brakes`,
      gotReverse >= 0 && gotReverse < 120 && v.control.brake < 0.02,
      gotReverse < 0
        ? `never left gear ${v.drivetrain.gearLabel} in 4 s (brake ${v.control.brake.toFixed(2)}, drift ${v.forwardSpeed.toFixed(2)} m/s)`
        : `reverse after ${gotReverse} frames, brake ${v.control.brake.toFixed(2)} (want < 120 frames, brake off)`);
  }
}

/* ------------------------------------------------------------------ */
/* 5. NO BURNOUT LATCH                                                 */
/* ------------------------------------------------------------------ */

/**
 * The exact frozen state that was captured live: full throttle, engine on the
 * limiter, four wheels on the ground, nothing touching the car, and no motion.
 * A car in that state must not stay in it — the tyres have to hook up.
 */
function testNoLatch(type) {
  for (const [surface, slope] of [['dirt', 14.5], ['grass', 8], ['asphalt', 20]]) {
    const v = spawn(type, makeWorld(surface, slope), { autoReverse: true });
    settle(v);
    let worstSlip = 0;
    let revs = 0;
    // The LAST two seconds. "Sitting spinning" is a steady state; a spike while
    // the tyres first break away is a launch, which is meant to happen.
    drive(v, { brake: 1 }, 120 * 8, (veh, i) => {
      if (i < 120 * 6) return;
      for (const k of veh._driven) {
        const w = veh.wheels[k];
        if (w.grounded) worstSlip = Math.max(worstSlip, Math.abs(w.slipRatio));
      }
      revs = Math.max(revs, veh.drivetrain.rpm / veh.spec.engine.redline);
    });
    check('no-latch',
      `${type} does not sit spinning on ${surface} at ${slope} deg`,
      worstSlip < 1.2 && revs < 0.97,
      `worst driven slip ${worstSlip.toFixed(2)} (want < 1.2), peak rpm ${(revs * 100).toFixed(0)}% of redline (want < 97%)`);
  }
}

/* ------------------------------------------------------------------ */
/* 6. SHOVE — the car in front is not a wall.                          */
/* ------------------------------------------------------------------ */

/**
 * Nose-to-tail with a stopped car, full throttle. The pair must move.
 *
 * This is the residual half of the live failure and it is nothing to do with
 * the tyres: a car pressing on another has ZERO approach velocity, so the
 * restitution impulse in `_pairResolve` never fires and only the positional
 * split ran — which shoves the PUSHER back by 47% of the overlap every step and
 * nails it to the spot. Measured on a lane-centre spawn half a metre off a
 * parked Millhand 6: 7.6 kN at the contact patches, no static contacts, no
 * motion, and reverse working perfectly.
 *
 * `_pairResolve` is called directly rather than through a `VehicleSystem`,
 * because standing one up needs a renderer, a material library and a city. It
 * only touches the two vehicles and `reportCollision`.
 */
const pairResolve = VehicleSystem.prototype._pairResolve;
function testShove(type) {
  const sys = makeWorld('asphalt', 0);
  const host = { reportCollision() {} };
  const mass = finalizeSpec(VEHICLE_SPECS[type]).mass;
  for (const blockerType of ['sedan', 'truck']) {
    // A 232 kg motorcycle does not push a 5.4 tonne truck, and asserting that
    // it should would be the same mistake as the two exclusions above.
    if (mass < finalizeSpec(VEHICLE_SPECS[blockerType]).mass * 0.35) continue;
    const a = spawn(type, sys);           // the pusher
    const b = spawn(blockerType, sys);    // the car in front
    settle(a);
    settle(b);
    // Park the blocker just ahead, overlapping the way a car nosed into a
    // parked one does.
    b.position.z = a.position.z + a.spec.half.z + b.spec.half.z - 0.3;
    b.prevPosition.copy(b.position);
    const z0 = a.position.z;
    for (let i = 0; i < 120 * 6; i++) {
      drive(a, { throttle: 1 }, 1);
      drive(b, {}, 1);
      pairResolve.call(host, a, b, DT);
    }
    const moved = a.position.z - z0;
    check('shove', `${type} shoves a stopped ${blockerType} out of the way`,
      moved > 3 && a.forwardSpeed > 1,
      `moved ${moved.toFixed(2)} m in 6 s at ${a.forwardSpeed.toFixed(2)} m/s (want > 3 m, > 1 m/s)`);
  }
}

/* ------------------------------------------------------------------ */
/* 7. STEERING — which way it actually went.                           */
/* ------------------------------------------------------------------ */

/**
 * THE CAR'S OWN RIGHT, derived without asking the vehicle code anything.
 *
 * three's camera looks down its local -Z and puts its local +X on the right of
 * the screen, so a camera yawed by PI looks along world +Z with screen-right on
 * world -X. Anything whose forward is +Z therefore has its RIGHT along -X. That
 * is one line of three.js's own documented basis and it shares nothing with
 * `dynamics.js` — which matters, because `dynamics` calls its local +X `_right`
 * and it is not: it is the car's LEFT. (`tools/steercheck.mjs` builds
 * `rightX = fz, rightZ = -fx`, which is that same mistake, so its "turns RIGHT"
 * / "turns LEFT" verdict is printed backwards. Flagged to the lead; nothing here
 * depends on it.)
 *
 * Both quantities asserted below are read off the EMITTED motion — the change
 * in world heading and the displacement projected on the car's own starting
 * right — never off `input.steer`, `control.steer` or `steerAngle`. Rule 12:
 * the input that makes this fail is a sign flip anywhere in the chain, and it
 * cannot pass by agreeing with itself.
 */
const _sq = new THREE.Quaternion();
const _sf = new THREE.Vector3();
const _sr = new THREE.Vector3();
const _sd = new THREE.Vector3();
const _su = new THREE.Vector3();

function rightOf(q, out) {
  // right = forward x up, with forward = +Z: see the note above.
  _sf.set(0, 0, 1).applyQuaternion(q);
  return out.copy(_sf).cross(_UP_W).normalize();
}
const _UP_W = new THREE.Vector3(0, 1, 0);

function headingOf(q) {
  _sf.set(0, 0, 1).applyQuaternion(q);
  return Math.atan2(_sf.x, _sf.z);
}

/**
 * Hold a control and report where the car ended up, in its own starting frame.
 * `reverse` backs it out first so the manoeuvre is a real reversing manoeuvre
 * rather than a forward one with a minus sign.
 */
function steerRun(type, { steer, human, reverse = false, seconds = 1.5 }) {
  const v = spawn(type, makeWorld('asphalt', 0), { autoReverse: human });
  settle(v);
  if (reverse) {
    // S until it is actually rolling backwards, then add the lock.
    for (let i = 0; i < 120 * 6 && v.forwardSpeed > -2.5; i++) drive(v, { brake: 1 }, 1);
  } else {
    for (let i = 0; i < 120 * 12 && v.forwardSpeed < 8; i++) drive(v, { throttle: 1 }, 1);
  }
  _sq.copy(v.quaternion);
  const yaw0 = headingOf(_sq);
  rightOf(_sq, _sr);
  const p0 = v.position.clone();
  drive(v, reverse ? { brake: 1, steer } : { throttle: 0.6, steer }, Math.round(120 * seconds));
  let dYaw = headingOf(v.quaternion) - yaw0;
  while (dYaw > Math.PI) dYaw -= Math.PI * 2;
  while (dYaw < -Math.PI) dYaw += Math.PI * 2;
  _sd.copy(v.position).sub(p0);
  return {
    // Positive heading change = the nose rotated toward +X = the car's LEFT.
    yawDeg: (dYaw * 180) / Math.PI,
    lateralRight: _sd.dot(_sr),
  };
}

function testSteering(type) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  // A bike leans and a heavy truck is lazy; assert the SIGN with a margin that
  // every class can clear, not a radius.
  const minYaw = spec.kind === 'bike' ? 4 : 6;
  const minLat = 0.35;

  /* ---- a person at the wheel: the axis convention (+1 = D = right) ---- */
  for (const [key, steer, wantLeft] of [['a', -1, true], ['d', +1, false]]) {
    const r = steerRun(type, { steer, human: true });
    const wentLeft = r.yawDeg > minYaw && r.lateralRight < -minLat;
    const wentRight = r.yawDeg < -minYaw && r.lateralRight > minLat;
    check('steering', `${type}: driver holds ${key} and the car goes ${wantLeft ? 'LEFT' : 'RIGHT'}`,
      wantLeft ? wentLeft : wentRight,
      `heading ${r.yawDeg.toFixed(1)} deg, ${r.lateralRight.toFixed(2)} m to its own right ` +
      `(want ${wantLeft ? 'heading > 0 and right < 0' : 'heading < 0 and right > 0'})`);
  }

  /* ---- reversing: the same key must still put the car to its own left ---- */
  {
    const r = steerRun(type, { steer: -1, human: true, reverse: true, seconds: 1.8 });
    check('steering', `${type}: driver holds a while reversing and backs to the LEFT`,
      r.lateralRight < -0.15,
      `${r.lateralRight.toFixed(2)} m to its own right, heading ${r.yawDeg.toFixed(1)} deg ` +
      `(want right < -0.15)`);
  }

  /**
   * ---- and an AI driver keeps the convention it was written against ----
   *
   * `traffic/driver.js`, `police/unit.js` and `game/util.js` all send a
   * body-frame steer ANGLE, where positive is a left turn, and `traffic`
   * derives that in its own header. If this flips, every car in the city
   * steers into the kerb — so it is asserted here rather than assumed.
   */
  {
    const r = steerRun(type, { steer: +1, human: false });
    check('steering', `${type}: AI steer +1 is still a LEFT turn`,
      r.yawDeg > minYaw && r.lateralRight < -minLat,
      `heading ${r.yawDeg.toFixed(1)} deg, ${r.lateralRight.toFixed(2)} m to its own right ` +
      `(want heading > 0 and right < 0)`);
  }
}

/* ------------------------------------------------------------------ */
/* 7b. PACE — how fast it actually gets, and in which gear.            */
/* ------------------------------------------------------------------ */

/**
 * "The cars drive too slow" as a gate rather than a feeling.
 *
 * Two signed numbers per class, both read off the emitted motion: the top speed
 * along the car's own nose after a long flat-out run, and the gear it is in
 * when it gets there. The gear matters as much as the speed — a car that tops
 * out in fourth of five has a gearbox problem, and a car pinned on the limiter
 * in top is under-geared however fast it is. See the TOP GEAR note in
 * `specs.js` for the measurement that separated those from an engine problem.
 *
 * RATCHET on both columns: these record what this pass reached, with about 6%
 * of margin, not where the bar is. The bar is written down in `specs.js` — a
 * top gear at x0.80 rather than x0.87 gets the sports car to 270 km/h and off
 * the limiter entirely. LOWER these when you improve them; never raise one to
 * make a run go green.
 */
const PACE = {
  // class: [min top speed km/h, expected top gear label]
  sports: [250, '5'],
  // Dylan's fastback. Eight speeds, so it must finish in 8 — the only class in
  // the fleet where topping out in seventh would still look fast.
  kessel: [211, '8'],
  muscle: [219, '4'],
  sedan: [177, '5'],
  van: [124, '5'],
  truck: [104, '6'],
  police: [227, '5'],
  bike: [216, '5'],
  /**
   * The parity classes. Both are RATCHETs on the same terms as the rest of the
   * table — measured 94.7 and 37.4 km/h, recorded with about 6% of margin.
   *
   * The bus is the slowest powered thing in the game and is meant to be: it is
   * governed by a straight top gear rather than the real Allison's 0.64
   * overdrive, which would put it at 153 km/h. The bicycle is slower again by a
   * factor of two and a half, and its number is not a gearing choice at all —
   * it is 360 W against a 0.40 m^2 rider, and there is nothing to raise.
   */
  bus: [88, '5'],
  bicycle: [35, '7'],
};

function testPace(type) {
  const want = PACE[type];
  if (!want) return;
  const v = spawn(type, makeWorld('asphalt', 0));
  settle(v);
  // Long enough that every class is genuinely at its terminal speed: the truck
  // is still gaining at 60 s.
  drive(v, { throttle: 1 }, 120 * 95);
  const kmh = v.forwardSpeed * 3.6;
  check('pace', `${type} reaches its top speed`,
    kmh > want[0],
    `${kmh.toFixed(1)} km/h (want > ${want[0]}), gear ${v.drivetrain.gearLabel}, ` +
    `${Math.round(v.drivetrain.rpm)} rpm = ${Math.round((v.drivetrain.rpm / v.spec.engine.redline) * 100)}% of redline`);
  check('pace', `${type} tops out in its highest gear`,
    v.drivetrain.gearLabel === want[1],
    `finished in gear ${v.drivetrain.gearLabel} (want ${want[1]}) at ${kmh.toFixed(1)} km/h`);
}

/* ------------------------------------------------------------------ */
/* 7c. GO — leaving a junction, which is what a city is made of.       */
/* ------------------------------------------------------------------ */

/**
 * "The cars could drive a little faster", SECOND REPORT — and the reason the
 * section above could not have fixed it.
 *
 * `pace` gates the number on a long straight. Steel City is 3 km across, so
 * that number is one almost nobody sees: the sedan needed 12.1 seconds to
 * cover the first 200 m of a straight and 200 m is about as far as you get
 * before the next junction puts you back at zero. What a player actually feels
 * is METRES PER SECOND FROM REST, and nothing gated it — which is exactly how a
 * pass that raised every top speed by 15% could land and change nothing.
 *
 * Three numbers per class, all read off ONE standing-start run's emitted
 * motion: the clock to 50 and to 100 km/h off the signed forward speed, and the
 * distance covered in the first five seconds off the INTEGRATED speed, so a car
 * that spends a second going backwards is charged for it. Nothing here reads a
 * spec field: `topSpeedEst`, `peakTorque` and the gear ratios are all invisible
 * to it, which is what makes it able to fail.
 *
 * Plus one structural assertion with no threshold in it at all — the upshifts
 * must happen at strictly increasing speeds, and all of them below the top
 * speed the same run reached. A gearbox that hunts, a ratio set entered out of
 * order, or a class that tops out mid-box fails it whatever its numbers are.
 *
 * RATCHET, all three columns, at about 5% of margin on what this pass measured.
 * MIND THE DIRECTION: the two clocks are CEILINGS and come DOWN as the cars get
 * quicker; the distance is a FLOOR and goes UP. Both are the same rule — move a
 * threshold only in the direction that makes it harder to pass.
 * The goal is written down in the ENGINE TORQUE note in `specs.js` along with
 * the two things known to be left on the table (the engine is pinned at idle
 * for the whole slipping-clutch phase; `_hookUp` winds on 3.4x faster than it
 * can let go). LOWER these when you improve them; never raise one to make a run
 * go green.
 *
 * The bus is deliberately the worst entry in the table and its own assertion
 * says so, measured against every other powered class rather than against a
 * constant — it is authored as the slowest thing on the road and a pass that
 * quietly made it quick would be a bug, not an improvement.
 */
const GO = {
  // class: [max seconds to 50 km/h, max seconds to 100 (null = cannot),
  //         min metres covered in the first 5 s]
  sports: [2.29, 4.60, 74.0],
  kessel: [2.95, 7.53, 53.9],
  muscle: [2.31, 4.87, 72.2],
  sedan: [4.27, 9.56, 38.0],
  van: [4.74, 13.71, 39.9],
  truck: [5.39, 17.01, 37.5],
  police: [2.73, 5.58, 61.5],
  bike: [2.54, 4.32, 72.4],
  /**
   * The two parity classes, on the same terms. The bus cannot reach 100 km/h at
   * all — it is governed by a straight top gear at 94.7 — and the bicycle
   * cannot reach 50: 360 W against a 0.40 m^2 rider is 37.4 km/h flat out, and
   * that is a real rider's number, not a gearing choice.
   */
  bus: [11.71, null, 21.9],
  bicycle: [null, null, 13.5],
};

/** One standing start, on flat dry asphalt, with the throttle pinned. */
function goRun(type) {
  const v = spawn(type, makeWorld('asphalt', 0));
  settle(v);
  const out = { t50: null, t100: null, d5: null, shifts: [], top: 0 };
  let dist = 0;
  let gear = v.drivetrain.gear;
  drive(v, { throttle: 1 }, 120 * 40, (veh, i) => {
    const t = (i + 1) * DT;
    // SIGNED and INTEGRATED. `speed` is unsigned and `position` would credit a
    // car that slid sideways; this is distance made good along the nose.
    dist += veh.forwardSpeed * DT;
    const kmh = veh.forwardSpeed * 3.6;
    if (out.t50 === null && kmh >= 50) out.t50 = t;
    if (out.t100 === null && kmh >= 100) out.t100 = t;
    if (out.d5 === null && t >= 5) out.d5 = dist;
    if (veh.drivetrain.gear !== gear) {
      // Record the speed the CAR was doing, not the gear it went to.
      if (veh.drivetrain.gear > gear) out.shifts.push(kmh);
      gear = veh.drivetrain.gear;
    }
    if (kmh > out.top) out.top = kmh;
  });
  return out;
}

const goResults = new Map();

function testGo(type) {
  const want = GO[type];
  if (!want) return;
  const r = goRun(type);
  goResults.set(type, r);
  const [max50, max100, minD5] = want;

  if (max50 === null) {
    check('go', `${type} cannot reach 50 km/h, and should not`,
      r.t50 === null,
      `topped out at ${r.top.toFixed(1)} km/h`);
  } else {
    check('go', `${type} is doing 50 km/h within ${max50} s of leaving a standstill`,
      r.t50 !== null && r.t50 < max50,
      r.t50 === null ? `never reached 50 km/h (top ${r.top.toFixed(1)})`
        : `${r.t50.toFixed(2)} s (want < ${max50})`);
  }

  if (max100 === null) {
    check('go', `${type} cannot reach 100 km/h, and should not`,
      r.t100 === null,
      `topped out at ${r.top.toFixed(1)} km/h`);
  } else {
    check('go', `${type} is doing 100 km/h within ${max100} s of leaving a standstill`,
      r.t100 !== null && r.t100 < max100,
      r.t100 === null ? `never reached 100 km/h (top ${r.top.toFixed(1)})`
        : `${r.t100.toFixed(2)} s (want < ${max100})`);
  }

  check('go', `${type} covers ${minD5} m in the first 5 s from rest`,
    r.d5 !== null && r.d5 > minD5,
    `${(r.d5 ?? 0).toFixed(1)} m (want > ${minD5})`);

  /**
   * No threshold in this one. Every upshift must happen FASTER than the last
   * and slower than the speed the same run finished at — which is true of any
   * correctly ordered gearbox at any power level, and false of a box that hunts
   * or whose ratios were typed out of order.
   */
  let ordered = r.shifts.length > 0;
  for (let i = 1; i < r.shifts.length; i++) if (r.shifts[i] <= r.shifts[i - 1]) ordered = false;
  for (const s of r.shifts) if (s >= r.top) ordered = false;
  check('go', `${type} upshifts at strictly increasing speeds, all below its top`,
    ordered,
    `${r.shifts.map((s) => s.toFixed(1)).join(' / ')} km/h, top ${r.top.toFixed(1)}`);
}

/**
 * The bus is the slowest thing on the road and that is authored, not accidental.
 * Measured against every other powered class on the same run, so it cannot be
 * satisfied by a constant that drifts.
 */
function testBusIsSlowest() {
  const bus = goResults.get('bus');
  if (!bus) return;
  const others = [...goResults].filter(([k, r]) => k !== 'bus' && k !== 'bicycle' && r.t50 !== null);
  if (!others.length) return;
  const quickest = others.reduce((a, b) => (b[1].t50 < a[1].t50 ? b : a));
  const slowestOther = others.reduce((a, b) => (b[1].t50 > a[1].t50 ? b : a));
  check('go', 'the bus is the slowest powered thing away from a standstill',
    bus.t50 > slowestOther[1].t50,
    `bus ${bus.t50.toFixed(2)} s to 50 km/h vs ${slowestOther[0]} ${slowestOther[1].t50.toFixed(2)} ` +
    `and ${quickest[0]} ${quickest[1].t50.toFixed(2)}`);
  check('go', 'the bus covers less ground in 5 s than anything else powered',
    others.every(([, r]) => r.d5 > bus.d5),
    `bus ${bus.d5.toFixed(1)} m vs a next-worst of ` +
    `${Math.min(...others.map(([, r]) => r.d5)).toFixed(1)} m`);
}

/* ------------------------------------------------------------------ */
/* 8. LAYOUT — Pittsburgh drives on the right, so the DRIVER is left.  */
/* ------------------------------------------------------------------ */

/**
 * The seat, the steering wheel and the door the actor walks to must all be on
 * the car's LEFT, and they must agree with each other.
 *
 * Measured along the same independently derived right vector the steering
 * section uses (`rightOf`, from three's camera basis), never against
 * `DRIVER_SIDE` or `WHEEL_SIDE` — a gate that read either of those constants
 * would be comparing the layout to the number that produced it, which is
 * exactly the mistake rule 12 is about, and would have passed happily on the
 * right-hand-drive fleet this replaces.
 *
 * The wheel is taken from the EMITTED interior geometry: `buildInterior`'s
 * `dash` group is the binnacle plane plus the centre screen, and the binnacle
 * is the one that sits in front of the driver. Its bounding box says where it
 * actually was built, which is a different question from where this file
 * thinks it asked for it — and it is the check that catches the wheel and the
 * seat drifting apart, which is how an interior rebuild can mirror one without
 * the other.
 */
const _lx = new THREE.Vector3();
function testLayout(type) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const sys = makeWorld('asphalt', 0);
  const v = spawn(type, sys);
  const veh = { ctx: { events: { emit() {} }, time: { elapsed: 0 } } };
  const anchor = VehicleSystem.prototype.seatAnchor.call(veh, v, 0);

  // Right vector for a car at yaw 0, derived from three's camera basis.
  rightOf(v.quaternion, _lx);
  const seatRight = anchor.local.dot(_lx);
  const bike = spec.kind === 'bike';
  // A rider sits ASTRIDE, so for a two-wheeler the correct answer is the
  // centreline, not the left. Asserting "on the left" there would be a bar the
  // geometry cannot meet and would train someone to relax the real one.
  check('layout', bike
    ? `${type}: the rider sits astride the centreline`
    : `${type}: the driver sits on the car's LEFT`,
    bike ? Math.abs(seatRight) < 0.12 : seatRight < -0.12,
    `seat is ${seatRight.toFixed(3)} m along the car's own right vector ` +
    `(want ${bike ? '|x| < 0.12, on the centreline' : '< -0.12, i.e. to its left'})`);

  // Where he walks to get in has to be the LEFT, and the same side as the seat
  // wherever the seat has a side at all.
  const doorRight = anchor.enter.clone().sub(v.position).dot(_lx);
  check('layout', `${type}: he gets in from the car's LEFT`,
    doorRight < 0 && (bike || Math.sign(doorRight) === Math.sign(seatRight)),
    `entry point ${doorRight.toFixed(2)} m to the car's right, seat ${seatRight.toFixed(2)} m`);

  if (spec.kind !== 'bike') {
    const interior = spec.kind === 'boat'
      ? buildBoatInterior(spec, 0)
      : buildInterior(spec, 0);
    // The binnacle: the smaller of the two `dash` planes is the centre screen,
    // so take the widest one — it is the instrument pack, and it is built at
    // `wheelX`.
    let best = null;
    let bestW = -1;
    for (const g of interior.dash) {
      g.computeBoundingBox();
      const bb = g.boundingBox;
      const w = bb.max.x - bb.min.x;
      if (w > bestW) { bestW = w; best = bb; }
    }
    const wheelX = best ? (best.min.x + best.max.x) * 0.5 : 0;
    rightOf(v.quaternion, _lx);
    const wheelRight = _lx.x * wheelX;
    check('layout', `${type}: the steering wheel is in front of the driver, not the passenger`,
      wheelRight < -0.05 && Math.sign(wheelRight) === Math.sign(seatRight),
      `binnacle ${wheelRight.toFixed(3)} m to the car's right, seat ${seatRight.toFixed(3)} m`);
    for (const g of [...interior.seat, ...interior.leather, ...interior.dash,
      ...interior.trim, ...interior.chrome, ...interior.cavity]) g.dispose?.();
  }
}

/* ------------------------------------------------------------------ */
/* 9. KERBS — the repro for "stuck backing over a curb, floating".     */
/* ------------------------------------------------------------------ */

/**
 * A real kerb, as two half-open boxes that tile the ground with no gap:
 *
 *   ground   { x <= 0, y <= 0 }
 *   kerb     { x >= 0, y <= H }
 *
 * so there is flat road at y = 0 for x < 0, a vertical face at x = 0 of height
 * H, and a footway at y = H for x > 0. Rays and sphere overlaps are solved
 * against the boxes analytically, which makes this exact and deterministic —
 * no BVH, no browser, no triangle soup, and no dependency on `world`'s current
 * kerb geometry (which is `world`'s to change).
 *
 * This is what `_collide` and the wheel raycasts actually consume, so a car
 * driven at it here snags for the same reason it snags in the city.
 */
const _BIG = 1e6;
function makeKerbWorld(H, surface = 'concrete', ridge = null) {
  /**
   * `ridge` swaps the footway for a raised BAR across the road, `{ zHalf }`
   * metres either side of z = 0, with flat road in front of it and behind it.
   * That is the high-centring shape: it is narrower than the wheelbase, so a
   * car parked over it rests on its belly with the front and rear axles both
   * hanging in the air — the "floating" state, and the one
   * state in which no pedal used to do anything at all.
   *
   * It has to catch the CHASSIS PROBES, and they only exist at x = +/-(half.x -
   * probeR): a bar narrow enough to run between the wheels lengthwise passes
   * clean between the probes and the car simply falls off it. Across the car is
   * the shape that works, and it is also the shape a real kerb makes when you
   * drive over its end.
   */
  const boxes = ridge
    ? [
      { lo: [-_BIG, -_BIG, -_BIG], hi: [_BIG, 0, _BIG] },
      { lo: [-_BIG, -_BIG, -ridge.zHalf], hi: [_BIG, H, ridge.zHalf] },
    ]
    : [
      { lo: [-_BIG, -_BIG, -_BIG], hi: [0, 0, _BIG] },
      { lo: [0, -_BIG, -_BIG], hi: [_BIG, H, _BIG] },
    ];
  const HIT = {
    hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
    distance: 0, surface, object: null,
  };
  /** Slab test; returns entry distance and writes the entry face normal. */
  function rayBox(ox, oy, oz, dx, dy, dz, maxDist, box, n) {
    let tmin = 0;
    let tmax = maxDist;
    let axis = -1;
    let sign = 1;
    const o = [ox, oy, oz];
    const d = [dx, dy, dz];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-9) {
        if (o[a] < box.lo[a] || o[a] > box.hi[a]) return -1;
        continue;
      }
      const inv = 1 / d[a];
      let t1 = (box.lo[a] - o[a]) * inv;
      let t2 = (box.hi[a] - o[a]) * inv;
      let s = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
      if (t1 > tmin) { tmin = t1; axis = a; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    if (axis < 0) return -1; // started inside
    n.set(0, 0, 0);
    n.setComponent(axis, sign);
    return tmin;
  }
  const _n = new THREE.Vector3();
  const _bn = new THREE.Vector3();

  const contacts = {
    depth: new Float32Array(8), nx: new Float32Array(8), ny: new Float32Array(8),
    nz: new Float32Array(8), px: new Float32Array(8), py: new Float32Array(8),
    pz: new Float32Array(8), tri: new Int32Array(8),
  };

  const physics = {
    MASK: { WORLD: 3 },
    raycast(origin, dir, maxDist) {
      let best = Infinity;
      HIT.hit = false;
      for (const box of boxes) {
        const t = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist, box, _n);
        if (t >= 0 && t < best) { best = t; _bn.copy(_n); }
      }
      if (!(best <= maxDist)) return HIT;
      HIT.hit = true;
      HIT.distance = best;
      HIT.point.set(origin.x + dir.x * best, origin.y + dir.y * best, origin.z + dir.z * best);
      HIT.normal.copy(_bn);
      HIT.surface = surface;
      return HIT;
    },
    groundHeight: (x) => (x > 0 ? H : 0),
    staticWorld: {
      contacts,
      objectOf: () => null,
      surfaceOf: () => 0,
      /** Sphere (p0 === p1 for a vehicle probe) against the two boxes. */
      overlapCapsule(x0, y0, z0, x1, y1, z1, r) {
        let n = 0;
        for (const box of boxes) {
          const qx = Math.min(box.hi[0], Math.max(box.lo[0], x0));
          const qy = Math.min(box.hi[1], Math.max(box.lo[1], y0));
          const qz = Math.min(box.hi[2], Math.max(box.lo[2], z0));
          let nx = x0 - qx, ny = y0 - qy, nz = z0 - qz;
          const d2 = nx * nx + ny * ny + nz * nz;
          let depth;
          if (d2 > 1e-12) {
            const d = Math.sqrt(d2);
            if (d >= r) continue;
            depth = r - d;
            nx /= d; ny /= d; nz /= d;
          } else {
            // Centre inside: push out through the nearest face.
            const ex = x0 - box.lo[0], exh = box.hi[0] - x0;
            const ey = y0 - box.lo[1], eyh = box.hi[1] - y0;
            const ez = z0 - box.lo[2], ezh = box.hi[2] - z0;
            const cand = [[ex, -1, 0, 0], [exh, 1, 0, 0], [ey, 0, -1, 0],
              [eyh, 0, 1, 0], [ez, 0, 0, -1], [ezh, 0, 0, 1]];
            let bd = Infinity, bi = 3;
            for (let i = 0; i < cand.length; i++) if (cand[i][0] < bd) { bd = cand[i][0]; bi = i; }
            depth = r + bd;
            nx = cand[bi][1]; ny = cand[bi][2]; nz = cand[bi][3];
          }
          if (n >= contacts.depth.length) break;
          contacts.depth[n] = depth;
          contacts.nx[n] = nx; contacts.ny[n] = ny; contacts.nz[n] = nz;
          contacts.px[n] = x0 - nx * (r - depth);
          contacts.py[n] = y0 - ny * (r - depth);
          contacts.pz[n] = z0 - nz * (r - depth);
          contacts.tri[n] = 0;
          n++;
        }
        return n;
      },
    },
  };
  return {
    kerbH: H,
    physics,
    lodOf: () => 0,
    surfaceAt: () => surface,
    waterHeightAt: () => null,
    reportCollision: () => {},
    gripOf: () => SURFACE_GRIP[surface] ?? SURFACE_GRIP.asphalt,
    _world: () => null,
  };
}

/** Drop a car at (x, z) on the low side, facing `yaw`, and let it settle. */
function spawnKerb(type, sys, x, z, yaw, y = null) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(sys, spec, STUB_MODEL, {});
  v.damage = null;
  v.setPose(new THREE.Vector3(x, (y ?? 0) + spec.comY, z), yaw);
  return v;
}

/**
 * Approach a kerb and report whether the car got over it, and when.
 *
 * The geometry is signed and absolute: the kerb face is the plane x = 0 and the
 * footway is everything with x > 0, so "cleared it" is "the whole car is past
 * x = 0 and sitting at footway height". Nothing here reads a force, an assist
 * level or an input.
 */
function kerbRun(type, sys, { yawDeg, entrySpeed, reverse = false, seconds = 6 }) {
  const yaw = (yawDeg * Math.PI) / 180;
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  // Far enough back that it is a run-up, not a spawn on top of the kerb.
  const startX = -(spec.half.z + 2.2);
  const v = spawnKerb(type, sys, startX, 0, yaw);
  // Settle with reverse DISARMED. Holding the brake with it armed selects
  // reverse and drives the car off before the test starts — the same trap
  // `settle()` documents, and it silently moved every spawn here.
  drive(v, { brake: 1 }, 240);
  v.drivetrain.reset();
  v.autoReverse = true;
  // The datum for "got up": the settled ride height on the FLAT, measured, not
  // assumed from `comY`.
  const y0 = v.position.y;
  const x0 = v.position.x;
  if (entrySpeed > 0) {
    // Give it a run-up on the flat rather than teleporting it to speed.
    for (let i = 0; i < 120 * 20 && Math.abs(v.forwardSpeed) < entrySpeed && v.position.x < -1.4; i++) {
      drive(v, reverse ? { brake: 1 } : { throttle: 1 }, 1);
    }
  }
  const n = Math.round(120 * seconds);
  let clearedAt = -1;
  // CLEARED = the whole car is past the face AND standing at footway height.
  // Both halves are needed: `x` alone passes for a car that has slid along the
  // kerb, and `y` alone passes for one that has bounced.
  const wantX = spec.half.z * 0.6 + 0.3;
  const wantY = y0 + sys.kerbH * 0.6;
  drive(v, reverse ? { brake: 1 } : { throttle: 1 }, n, (veh, i) => {
    if (clearedAt < 0 && veh.position.x > wantX && veh.position.y > wantY) clearedAt = i;
  });
  return {
    cleared: clearedAt >= 0,
    seconds: clearedAt >= 0 ? clearedAt / 120 : Infinity,
    x: v.position.x,
    rise: v.position.y - y0,
    travelled: v.position.x - x0,
    wantX, wantY: wantY - y0,
    v,
  };
}

function testKerbs(type) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const sys = makeKerbWorld(0.15);

  /**
   * ---- forwards, at three angles and two speeds ----
   *
   * RATCHET, 4 s. This records where this pass got to, not where the bar is:
   * the whole fleet currently mounts a 15 cm kerb in 1.57-2.71 s from rest and
   * 0.49-1.14 s rolling, so 4 s is roughly a factor of 1.5 of headroom rather
   * than a target. The goal is "you never notice the kerb at all", which is
   * under a second from rest. LOWER this when you improve it; never raise it to
   * make a run go green. Before `_rideKerbs`/`_unstick` existed the same runs
   * did not clear at all inside 6 s.
   */
  const KERB_SECS = 4;
  for (const yawDeg of [90, 62, 42]) {
    for (const entry of [0, 5]) {
      const r = kerbRun(type, sys, { yawDeg, entrySpeed: entry, seconds: KERB_SECS });
      check('kerb',
        `${type} mounts a 15 cm kerb at ${yawDeg} deg from ${entry ? `${entry} m/s` : 'rest'}`,
        r.cleared,
        r.cleared
          ? `over in ${r.seconds.toFixed(2)} s`
          : `stopped at x ${r.x.toFixed(2)} m (want > ${r.wantX.toFixed(2)}), ` +
            `risen ${r.rise.toFixed(3)} m (want > ${r.wantY.toFixed(3)}) in ${KERB_SECS} s`);
    }
  }

  /* ---- and BACKWARDS over one, which is the direction that used to snag ---- */
  {
    // Nose pointing away from the kerb, S held: the car reverses into it.
    const r = kerbRun(type, sys, { yawDeg: -90, entrySpeed: 0, reverse: true, seconds: 7 });
    check('kerb', `${type} backs over a 15 cm kerb`, r.cleared,
      r.cleared
        ? `over in ${r.seconds.toFixed(2)} s`
        : `stopped at x ${r.x.toFixed(2)} m (want > ${r.wantX.toFixed(2)}), ` +
          `risen ${r.rise.toFixed(3)} m (want > ${r.wantY.toFixed(3)}) after 7 s`);
  }

  /* ---- HIGH-CENTRED: the "floating in the air" state, gated directly ---- */
  {
    /**
     * Astride a kerb-height block that runs BETWEEN the wheels: belly on the
     * block, every tyre in the air. `grounded === 0` means the tyre model
     * produces nothing at all, so before the recovery existed this was
     * permanent — the player's "floating in the air" report, and the reason the
     * arming test is "resting on something" rather than "wheels down".
     */
    // Tall enough that the struts run out of droop before a tyre reaches the
    // road — measured off this class's own suspension travel, not guessed, or
    // the "beached" car quietly finds the ground and the test stops testing.
    const hp = spawnKerb(type, makeKerbWorld(0.15), 0, 0, 0).wheels[0].hp;
    const H = spec.style.groundY + (hp.max - hp.staticLen) + 0.12;
    // Narrower than the wheelbase so both axles hang, wide enough to carry the
    // belly. The car sits astride it and drives off along +Z.
    const s = makeKerbWorld(H, 'concrete', { zHalf: Math.min(0.45, spec.wheelbase * 0.2) });
    const v = spawnKerb(type, s, 0, 0, 0, H + 0.01);
    drive(v, { brake: 1 }, 90);
    v.drivetrain.reset();
    v.autoReverse = true;
    const z0 = v.position.z;
    let worstGrounded = 9;
    let escaped = -1;
    drive(v, { throttle: 1 }, 120 * 6, (veh, i) => {
      if (i < 24) return;
      if (i < 150) worstGrounded = Math.min(worstGrounded, veh.grounded);
      if (escaped < 0 && veh.position.z - z0 > 2.0) escaped = i;
    });
    check('kerb', `${type} beached on a kerb-height block drives itself off`,
      worstGrounded === 0 && escaped >= 0 && escaped < 120 * 5,
      escaped >= 0
        ? `2 m clear in ${(escaped / 120).toFixed(2)} s (fewest wheels down ${worstGrounded}, want 0)`
        : `moved ${(v.position.z - z0).toFixed(2)} m in 6 s, fewest wheels down ${worstGrounded}`);
  }

  /**
   * ---- NEGATIVE CONTROL: a wall is not a kerb ----
   *
   * The whole risk of a ride-over tolerance is that it turns every vertical
   * surface into a ramp. `_feelKerb` only returns a step when it can SEE a
   * drivable surface within `KERB_MAX` of the wheel's own contact, and
   * `_unstick` is a 1.9 m/s^2 shove that cannot climb anything — so a car held
   * against a wall at full throttle for eight seconds must still be on the near
   * side of it. This is the input that makes the kerb assertions above mean
   * something.
   *
   * ────────────────────────────────────────────────────────────────────────
   * THE WALL IS SIZED PER CLASS, AND THE 60 cm ONE WAS NOT A WALL TO A BUS
   * ────────────────────────────────────────────────────────────────────────
   * The bus climbed the fixed 60 cm wall in 2.13 s, and the cause is not the
   * ride-over assist at all — it is the CHASSIS PROBE representation. The
   * probes are spheres whose centres sit at `groundY + probeR`, and for the bus
   * that is 0.64 m: ABOVE the top of a 0.60 m ledge. `_collide` then finds the
   * nearest point on the box to be its TOP FACE, so the contact normal comes
   * out pointing up rather than out, and the solver lifts a 10 t bus onto the
   * wall exactly as it would lift it out of a pothole. No tolerance is
   * involved; the wall is simply shorter than the thing meant to be stopped by
   * it, and a 60 cm object is not a wall to a vehicle with 32 cm of clearance
   * and a 53 cm wheel.
   *
   * So the height is derived from the class's own geometry — the number the
   * probe ring cannot rest on — and FLOORED at the original 0.6 so that no
   * class that was already gated gets a weaker control than it had. Measured:
   * sedan 0.70, sports 0.66, muscle 0.69, van 0.73, truck 0.78, police 0.70,
   * bike 0.60 (floored), bicycle 0.60 (floored), bus 0.86.
   */
  {
    const probeR = spawnKerb(type, makeKerbWorld(0.15), 0, 0, 0).probeR;
    const wallH = Math.max(0.6, (spec.style.groundY ?? 0.15) + probeR + 0.22);
    const s = makeKerbWorld(wallH);
    const r = kerbRun(type, s, { yawDeg: 90, entrySpeed: 5, seconds: 8 });
    check('kerb', `${type} does NOT climb a ${Math.round(wallH * 100)} cm wall`, !r.cleared,
      r.cleared
        ? `climbed it in ${r.seconds.toFixed(2)} s — the assist is ramping walls`
        : `held at x ${r.x.toFixed(2)} m, risen ${r.rise.toFixed(3)} m`);
  }

  /**
   * ---- and it must not shove a car nobody is driving ----
   *
   * A recovery that runs on a parked car is a car that creeps across the city
   * on its own. Held against the kerb with no pedal at all.
   */
  {
    const s = makeKerbWorld(0.15);
    const v = spawnKerb(type, s, -(spec.half.z + 0.02), 0, Math.PI / 2);
    drive(v, { brake: 1 }, 120);
    const p0 = v.position.clone();
    drive(v, {}, 120 * 6);
    const drift = v.position.distanceTo(p0);
    check('kerb', `${type} parked at a kerb with no pedal does not creep`,
      drift < 0.35 && v.kerbAssist < 0.01,
      `drifted ${drift.toFixed(3)} m in 6 s, assist ${v.kerbAssist.toFixed(3)} (want < 0.35 m, 0)`);
  }
}

/* ================================================================== */
/* 10. BOOST — the SPRINT channel, which used to be consumed by NOBODY */
/* ================================================================== */

/**
 * `v.input.boost` was written by `player/vehicle.js` and read by nothing in
 * this directory: grep it before this pass and it appears exactly twice, once
 * declared and once assigned. A player holding Shift in a car got an emptying
 * HUD gauge and no thrust at all.
 *
 * Asserted on the EMITTED SPEED of two otherwise identical runs, and on the
 * DIFFERENCE between them — never on `spec.boost`, and never on the input. The
 * negative control is the build this replaces: the same two runs with the class
 * `boost` block removed, where they must come out identical to the millimetre,
 * because that is precisely what a channel nobody consumes looks like.
 */
function testBoost(type) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  if (!spec.boost || spec.boost.kind === 'collective') return;

  /**
   * MEASURED AS DISTANCE COVERED, not as top speed, and that is the point of
   * the mechanic rather than a convenience.
   *
   * Boost is extra ENGINE torque (see the BOOST block in `specs.js` for the
   * measurement that ruled out a thrust term), so on a class whose top speed is
   * set by its GEARING — which is every fast class in this fleet, all sitting
   * at 99% of the redline in top — it cannot raise the terminal speed at all,
   * by construction. It gets you there sooner. Ten seconds of ground covered
   * from a standstill is exactly that, it is signed, and it is what the player
   * feels. A drag-limited class (the bicycle) also gains at the top, and does.
   */
  const run = (boost, mods) => {
    const base = mods ? mods(structuredClone(VEHICLE_SPECS[type])) : VEHICLE_SPECS[type];
    const s = finalizeSpec(base === VEHICLE_SPECS[type] ? base : { ...base, _final: false });
    const sys = makeWorld('asphalt', 0);
    const v = new Vehicle(sys, s, STUB_MODEL, {});
    v.damage = null;
    v.setPose(new THREE.Vector3(0, s.comY, 0), 0);
    settle(v);
    // ROLLING, from 20 m/s. A standing start on a rear-drive class is decided
    // by the tyres and not by the engine: measured, 55% more torque made the
    // superbike cover 22% LESS ground off the line, because all of it went into
    // wheelspin. That is a true thing about a bike and a useless thing to gate
    // a torque channel on. Nitro is an overtaking button; this measures it as
    // one.
    for (let i = 0; i < 120 * 60 && v.forwardSpeed < 20; i++) drive(v, { throttle: 1 }, 1);
    const z0 = v.position.z;
    drive(v, { throttle: 1, boost }, 120 * 10);
    const sprintZ = v.position.z - z0;
    drive(v, { throttle: 1, boost }, 120 * 85);
    return { dist: sprintZ, top: v.forwardSpeed };
  };

  const off = run(0);
  const on = run(1);
  check('boost', `${type}: holding SPRINT actually covers more ground`,
    on.dist > off.dist * 1.03,
    `${off.dist.toFixed(1)} -> ${on.dist.toFixed(1)} m in 10 s ` +
    `(x${(on.dist / off.dist).toFixed(3)}); top ${(off.top * 3.6).toFixed(1)} -> ` +
    `${(on.top * 3.6).toFixed(1)} km/h`);

  /**
   * NEGATIVE CONTROL. Delete the class's boost block — the state of this
   * directory before this pass, where `setInput` stored the channel and nothing
   * read it — and the two runs must be indistinguishable.
   */
  const cOff = run(0, (b) => { b.boost = null; return b; });
  const cOn = run(1, (b) => { b.boost = null; return b; });
  check('boost', `${type}: NEGATIVE CONTROL — with no boost block, SPRINT does nothing`,
    Math.abs(cOn.dist - cOff.dist) < 1e-6 && Math.abs(cOn.top - cOff.top) < 1e-6,
    `${cOff.dist.toFixed(4)} vs ${cOn.dist.toFixed(4)} m (want identical)`);
}

/* ================================================================== */
/* 11. HELICOPTER — the whole flyable verb                             */
/* ================================================================== */

/**
 * Before the `heli` class existed the game had no flyable vehicle at all:
 * `src/police/heli.js` says so outright ("there is no rotorcraft class"), and
 * its airframe is scenery. This section gates the verb itself, on the ALTITUDE
 * THE BODY ACTUALLY REACHED — `position.y` in world space, never `input.boost`
 * and never the commanded climb rate.
 *
 * The controls ride the two channels the vehicle input already carries: SPRINT
 * (`boost`) climbs and the handbrake descends.
 */
function heliWorld() {
  return makeWorld('concrete', 0);
}

function spawnHeli(sys) {
  const spec = finalizeSpec(VEHICLE_SPECS.heli);
  const v = new Vehicle(sys, spec, STUB_MODEL, {});
  v.damage = null;
  // Skids on the ground: the CoM sits one skid-drop above it.
  v.setPose(new THREE.Vector3(0, spec.comY - (spec.style.skidY - spec.style.skidR), 0), 0);
  // The governor only spools with somebody in the seat.
  v.driver = { isPlayer: true };
  return v;
}

function fly(v, input, seconds) {
  const n = Math.round(120 * seconds);
  for (let i = 0; i < n; i++) {
    v.input.throttle = input.throttle ?? 0;
    v.input.brake = input.brake ?? 0;
    v.input.steer = input.steer ?? 0;
    v.input.handbrake = !!input.handbrake;
    v.input.boost = input.boost ?? 0;
    v.fixedStep(DT, CTX);
  }
  return v;
}

/** A standing adult's crown, metres. `player`'s capsule is 1.8 m tall. */
const PED_CROWN = 1.8;

function testHeli() {
  const spec = finalizeSpec(VEHICLE_SPECS.heli);

  /* ---- 1. it gains altitude on the climb control ---------------------- */
  {
    const v = spawnHeli(heliWorld());
    const y0 = v.position.y;
    fly(v, {}, 2);
    const idle = v.position.y - y0;
    fly(v, { boost: 1 }, 14);
    const climbed = v.position.y - y0;
    check('heli', 'climbs on the SPRINT control',
      climbed > 60 && v.velocity.y > 6,
      `+${climbed.toFixed(1)} m in 14 s at ${v.velocity.y.toFixed(2)} m/s, altitude ${v.altitude.toFixed(1)} m`);
    check('heli', 'sits still on the skids with the collective closed',
      Math.abs(idle) < 0.05,
      `moved ${idle.toFixed(4)} m in 2 s with no control held`);
  }

  /* ---- 2. it holds a hover -------------------------------------------- */
  {
    const v = spawnHeli(heliWorld());
    fly(v, { boost: 1 }, 10);
    // Let the 12 m/s of climb rate arrest before the window opens: the
    // collective's own settle is not what "holds a hover" is asking about.
    // The lead term parks it at the altitude it ARRESTS at, a few metres above
    // where the control was released, and it takes a few seconds to get there.
    fly(v, {}, 7);
    const hoverAt = v.position.y;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 120 * 8; i++) {
      fly(v, {}, DT);
      lo = Math.min(lo, v.position.y);
      hi = Math.max(hi, v.position.y);
    }
    const drift = Math.abs(v.position.y - hoverAt);
    check('heli', 'holds a hover with nothing held',
      hi - lo < 0.6 && drift < 0.4 && v.altitude > 40,
      `band ${(hi - lo).toFixed(3)} m over 8 s, net drift ${drift.toFixed(2)} m at ${v.altitude.toFixed(1)} m`);
  }

  /* ---- 3. it descends, and it lands ----------------------------------- */
  {
    const v = spawnHeli(heliWorld());
    fly(v, { boost: 1 }, 10);
    const top = v.position.y;
    fly(v, { handbrake: true }, 3);
    const rate = v.velocity.y;
    fly(v, { handbrake: true }, 20);
    check('heli', 'descends on the handbrake control',
      rate < -6 && v.position.y < top - 40,
      `${rate.toFixed(2)} m/s three seconds in, ${(top - v.position.y).toFixed(1)} m lost`);
    check('heli', 'lands level and stays on its skids',
      v.altitude < 0.1 && v.grounded >= 3 && Math.abs(v.velocity.y) < 0.2,
      `altitude ${v.altitude.toFixed(3)} m, ${v.grounded} skid points down, vy ${v.velocity.y.toFixed(3)}`);
  }

  /* ---- 4. it flies FORWARD when you ask it to ------------------------- */
  {
    const v = spawnHeli(heliWorld());
    fly(v, { boost: 1 }, 12);
    fly(v, { throttle: 1 }, 20);
    // Signed, along its own nose, in world space — `speed` is unsigned and a
    // machine flying backwards scores full marks on it.
    _sf.set(0, 0, 1).applyQuaternion(v.quaternion);
    const along = v.velocity.dot(_sf);
    // A helicopter accelerates by tilting the disc, so the nose must be DOWN.
    const pitch = Math.asin(Math.max(-1, Math.min(1, _sf.y)));
    check('heli', 'flies forward, nose down, on the throttle',
      along > 25 && pitch < -0.08,
      `${along.toFixed(1)} m/s along its nose at ${(pitch * 57.3).toFixed(1)} deg of pitch`);
  }

  /* ---- 5. the pedestrian exemption ------------------------------------ */
  /**
   * `physics` pushes every capsule radially out of every live vehicle. A
   * machine at 40 m must not shove the people underneath it, and the rule is
   * one line: a flying vehicle above 2 m blocks nobody.
   *
   * BOTH halves are gated, because they are different guarantees:
   *
   *   the FLAG   `v.blocksPeds`, the predicate `physics` should consume in
   *              `_refreshBlockers`. Cut at `rotor.pedBlockAlt`, 2.0 m.
   *   the BOX    the condition `CharacterController._pushOutOfVehicles`
   *              ALREADY applies today, with no cooperation from anybody:
   *              `headY < vy - hh`, i.e. the pedestrian's crown below the
   *              underside of the vehicle's own bounding box. Computed here
   *              from the EMITTED `position.y` and the box `physics` is handed,
   *              not from anything `heli.js` calculates — the flight model
   *              never forms this quantity at all.
   */
  {
    const v = spawnHeli(heliWorld());
    const hh = spec.dims.H * 0.5;
    const sample = (label, want) => ({
      label, want, alt: v.altitude, flag: v.blocksPeds,
      clears: PED_CROWN < v.position.y - hh,
    });
    const rows = [];
    rows.push(sample('on the ground'));
    // Spool first — the governor takes 4.5 s and nothing lifts before it — then
    // a short burst to get airborne but STILL BELOW the 2 m exemption.
    fly(v, {}, 5);
    fly(v, { boost: 1 }, 0.6);
    const low = sample('below 2 m');
    fly(v, { boost: 1 }, 12);
    const high = sample('at altitude');
    fly(v, { handbrake: true }, 30);
    const back = sample('landed again');

    check('heli', 'blocks people on foot while it is on the ground',
      rows[0].flag === true && rows[0].alt <= spec.rotor.pedBlockAlt,
      `altitude ${rows[0].alt.toFixed(2)} m, blocksPeds ${rows[0].flag}`);
    check('heli', 'still blocks AIRBORNE but below the 2 m exemption',
      low.flag === true && low.alt > 0.3 && low.alt < spec.rotor.pedBlockAlt,
      `altitude ${low.alt.toFixed(2)} m (want 0.3 to ${spec.rotor.pedBlockAlt}), blocksPeds ${low.flag}`);
    check('heli', 'stops blocking once it is flying',
      high.flag === false && high.alt > spec.rotor.pedBlockAlt,
      `altitude ${high.alt.toFixed(1)} m, blocksPeds ${high.flag}`);
    check('heli', 'blocks again after it lands',
      back.flag === true && back.alt <= spec.rotor.pedBlockAlt,
      `altitude ${back.alt.toFixed(2)} m, blocksPeds ${back.flag}`);
    check('heli', 'in flight its underside clears a standing pedestrian outright',
      high.clears === true && rows[0].clears === false && back.clears === false,
      `ground ${rows[0].clears}, flying ${high.clears}, landed ${back.clears} ` +
      `(crown ${PED_CROWN} m vs box underside)`);
  }

  /**
   * ---- NEGATIVE CONTROL: no flight, no exemption ----
   *
   * Revert the fix by taking the collective away — `rotor.thrustMax` at 1.0
   * cannot lift the machine, which is the build where `fly` does not exist and
   * a helicopter is scenery. It must then never leave the ground, and BOTH
   * halves of the exemption must stay engaged for the whole run. If this went
   * green the assertions above would be measuring nothing.
   */
  {
    const base = structuredClone(VEHICLE_SPECS.heli);
    base.rotor.thrustMax = 1.0;
    base.rotor.climbUp = 0;
    const s = finalizeSpec(base);
    const v = new Vehicle(heliWorld(), s, STUB_MODEL, {});
    v.damage = null;
    v.setPose(new THREE.Vector3(0, s.comY - (s.style.skidY - s.style.skidR), 0), 0);
    v.driver = { isPlayer: true };
    const y0 = v.position.y;
    let everFlew = false;
    let everExempt = false;
    let everCleared = false;
    const hh = s.dims.H * 0.5;
    for (let i = 0; i < 120 * 20; i++) {
      fly(v, { boost: 1 }, DT);
      if (v.position.y - y0 > 0.5) everFlew = true;
      if (v.blocksPeds === false) everExempt = true;
      if (PED_CROWN < v.position.y - hh) everCleared = true;
    }
    check('heli', 'NEGATIVE CONTROL — with no collective it never leaves the ground',
      !everFlew && !everExempt && !everCleared,
      `rose ${(v.position.y - y0).toFixed(3)} m in 20 s of full climb command, ` +
      `exempt ${everExempt}, cleared a pedestrian ${everCleared}`);
  }

  /* ---- 6. the pilot sits where every other driver does ----------------- */
  {
    const sys = heliWorld();
    const v = spawnHeli(sys);
    const veh = { ctx: { events: { emit() {} }, time: { elapsed: 0 } } };
    const anchor = VehicleSystem.prototype.seatAnchor.call(veh, v, 0);
    rightOf(v.quaternion, _lx);
    const seatRight = anchor.local.dot(_lx);
    check('heli', 'the pilot sits on the machine LEFT, like every other class',
      seatRight < -0.12,
      `seat is ${seatRight.toFixed(3)} m along its own right vector (want < -0.12)`);
  }
}

/* ================================================================== */
/* 12. BICYCLE — no fuel, a sprint, and slower than a car              */
/* ================================================================== */

function testBicycle() {
  const spec = finalizeSpec(VEHICLE_SPECS.bicycle);

  /* ---- no fuel is consumed, ever -------------------------------------- */
  /**
   * The `nogas` exemption. Asserted with `burnsFuel` FORCED ON — the flag
   * that makes a tank drain at all — so this cannot pass just because nobody
   * was driving. The negative control is the same bicycle with `nogas`
   * cleared, which must drain, proving the harness's burn path is live and
   * that the first assertion is measuring the exemption and not the harness.
   */
  {
    const v = spawn('bicycle', makeWorld('asphalt', 0));
    v.burnsFuel = true;
    settle(v);
    drive(v, { throttle: 1 }, 120 * 300);
    check('bicycle', 'burns no fuel in five minutes flat out',
      v.fuel === 100 && v.fuelDry === false && v.spec.nogas === true,
      `fuel ${v.fuel.toFixed(3)}/100, dry ${v.fuelDry}`);

    const base = structuredClone(VEHICLE_SPECS.bicycle);
    base.nogas = false;
    const s = finalizeSpec(base);
    const c = new Vehicle(makeWorld('asphalt', 0), s, STUB_MODEL, {});
    c.damage = null;
    c.setPose(new THREE.Vector3(0, s.comY, 0), 0);
    c.burnsFuel = true;
    settle(c);
    drive(c, { throttle: 1 }, 120 * 300);
    check('bicycle', 'NEGATIVE CONTROL — the same run WITH a tank drains it',
      c.fuel < 99,
      `fuel ${c.fuel.toFixed(2)}/100 after the identical run with nogas cleared`);
  }

  /* ---- it is slower than a car ---------------------------------------- */
  {
    const b = spawn('bicycle', makeWorld('asphalt', 0));
    settle(b);
    drive(b, { throttle: 1 }, 120 * 95);
    const s = spawn('sedan', makeWorld('asphalt', 0));
    settle(s);
    drive(s, { throttle: 1 }, 120 * 95);
    check('bicycle', 'is slower than the traffic sedan',
      b.forwardSpeed > 0 && b.forwardSpeed < s.forwardSpeed * 0.35,
      `${(b.forwardSpeed * 3.6).toFixed(1)} km/h against the sedan's ` +
      `${(s.forwardSpeed * 3.6).toFixed(1)} (want under 35% of it, and moving)`);
  }
}

/* ================================================================== */
/* 13. BUS — heavy, and it corners like it                             */
/* ================================================================== */

/**
 * "A heavy, slow, high-mass class" has to be true of the EMITTED MOTION, not of
 * the number in the spec, or the assertion is `spec.mass > spec.mass`. Three
 * properties, all measured against the sedan under identical inputs:
 *
 *   IMMOVABLE  a sports car at 12 m/s into the back of it moves it far less
 *              than the same shunt moves a sedan. This is the mass, seen from
 *              outside, through `VehicleSystem._pairResolve` — the real solver.
 *   LEANS      the same steering input at the same speed rolls it further.
 *              comY 1.05 against a 2.10 m track is a roll couple three times
 *              the sedan's and the anti-roll bars deliberately do not hide it.
 *   WON'T TURN it cannot hold the lateral acceleration a sedan can.
 */
function testBus() {
  /* ---- shunting it ----------------------------------------------------- */
  /**
   * The same shove that section 6 applies, aimed at the two heaviest things a
   * player will actually nose into. `_pairResolve` is the real solver, so this
   * is 10.2 t of bus against 1.36 t of sports car with nothing simplified.
   */
  const shunt = (targetType) => {
    const sys = makeWorld('asphalt', 0);
    const host = { reportCollision() {} };
    const bullet = spawn('sports', sys);
    const target = spawn(targetType, sys);
    settle(bullet);
    settle(target);
    target.position.z = bullet.position.z + bullet.spec.half.z + target.spec.half.z - 0.3;
    target.prevPosition.copy(target.position);
    const z0 = target.position.z;
    for (let i = 0; i < 120 * 8; i++) {
      drive(bullet, { throttle: 1 }, 1);
      drive(target, {}, 1);
      pairResolve.call(host, bullet, target, DT);
    }
    return target.position.z - z0;
  };
  const movedBus = shunt('bus');
  const movedSedan = shunt('sedan');
  check('bus', 'a sports car shunts it far less than it shunts a sedan',
    movedBus < movedSedan * 0.5 && movedSedan > 1.0,
    `bus moved ${movedBus.toFixed(2)} m, sedan ${movedSedan.toFixed(2)} m ` +
    `(want the bus under half of it)`);

  /* ---- roll and lateral grip ------------------------------------------ */
  const corner = (type) => {
    const sys = makeWorld('asphalt', 0);
    const v = spawn(type, sys);
    settle(v);
    // Up to 14 m/s — a speed every class here can hold — then a HALF turn of
    // lock, held. Full lock is a spin for anything with a long wheelbase and
    // what comes out the other side is not a cornering measurement.
    for (let i = 0; i < 120 * 60 && v.forwardSpeed < 14; i++) drive(v, { throttle: 1 }, 1);
    let peakRoll = 0;
    let latSum = 0;
    let latN = 0;
    /**
     * The SUSTAINED lateral acceleration, averaged over the last two seconds of
     * a six second corner, not the peak. The peak is the turn-in transient and
     * every class has one — measured, it separated the bus from the sedan by
     * only 8% while what a player feels is that the bus cannot HOLD a line.
     */
    const total = 120 * 6;
    drive(v, { throttle: 0.55, steer: 0.5 }, total, (veh, i) => {
      if (i < 120) return;
      _sr.set(1, 0, 0).applyQuaternion(veh.quaternion);
      _su.set(0, 1, 0).applyQuaternion(veh.quaternion);
      peakRoll = Math.max(peakRoll, Math.abs(Math.atan2(_sr.y, _su.y)));
      if (i < total - 240) return;
      // a_lat = yaw rate x forward speed, straight off the emitted motion.
      const yawRate = veh.angularVelocity.dot(_su);
      latSum += Math.abs(yawRate * veh.forwardSpeed);
      latN++;
    });
    return { roll: peakRoll, lat: latN ? latSum / latN : 0 };
  };
  const bus = corner('bus');
  const sedan = corner('sedan');
  /**
   * ROLL GAIN — degrees of lean per m/s^2 of lateral acceleration — and not raw
   * roll, because the two classes do not corner at the same rate: the bus tops
   * out at 5.7 m/s^2 where the sedan holds 10.9, so both happen to end up near
   * 6.8 degrees and the raw number says they are the same chassis. Per unit of
   * cornering the bus leans TWICE as far, which is the thing a player feels and
   * the thing comY 1.05 over a 2.10 m track actually predicts.
   */
  const gain = (c) => (c.lat > 0.2 ? (c.roll * 57.3) / c.lat : 0);
  check('bus', 'leans twice as far as a sedan for the same cornering',
    gain(bus) > gain(sedan) * 1.5,
    `${gain(bus).toFixed(3)} deg per m/s^2 against the sedan's ${gain(sedan).toFixed(3)} ` +
    `(${(bus.roll * 57.3).toFixed(2)} deg at ${bus.lat.toFixed(2)} m/s^2 vs ` +
    `${(sedan.roll * 57.3).toFixed(2)} at ${sedan.lat.toFixed(2)})`);
  check('bus', 'cannot hold the lateral acceleration a sedan can',
    bus.lat < sedan.lat * 0.85 && bus.lat > 0.5,
    `${bus.lat.toFixed(2)} m/s^2 against the sedan's ${sedan.lat.toFixed(2)}`);
}

/* ================================================================== */
/* 14. PER-HERO — the same car, three brothers                         */
/* ================================================================== */

/**
 * DESIGN.md gives each brother a `vehicleGrip` and a `boatSpeed`; both were
 * consumed by nothing anywhere in the project, so every brother drove an
 * identical car. This gates the wiring on what the CAR DOES, through the real
 * `VehicleSystem.applyHero` entry point and the real numbers out of
 * `src/player/brothers.js` — not through a literal in this file, so a brother
 * losing his stat row turns this red rather than passing on a default.
 *
 * Both quantities are measured off the emitted motion:
 *
 *   GRIP  the peak lateral acceleration in a steady corner, computed as
 *         (yaw rate x forward speed) from the trajectory. Never `tyre.muLat`.
 *   TOP   terminal speed along the car's own nose after 95 s flat out.
 *
 * Asserted as a strict ORDER with a real separation, which is a property no
 * single multiplier can fake, plus a negative control with the modifiers
 * detached where all three must be bit-identical.
 */
async function loadBrothers() {
  try {
    const m = await import('../player/brothers.js');
    if (m?.BROTHERS) return Object.values(m.BROTHERS);
  } catch { /* fall through to game's copy */ }
  try {
    const m = await import('../game/data.js');
    if (m?.BOYZ) {
      return Object.entries(m.BOYZ).map(([id, b]) => ({
        id, vehicleGrip: b.vehGrip, boatSpeed: b.boatSpeed,
      }));
    }
  } catch { /* nothing to read */ }
  return null;
}

/**
 * A minimal `VehicleSystem` for `applyHero` to run as a method on: `ctx.peek`
 * hands it the brother exactly as the engine does, and `activeBrother` is the
 * REAL implementation, borrowed off the prototype. Nothing here reimplements
 * the lookup — if `activeBrother` stops finding `player.brother`, this goes red.
 */
function heroStub(brother) {
  return {
    ctx: { peek: (id) => (id === 'player' ? { brother } : null) },
    vehicles: [],
    activeBrother: VehicleSystem.prototype.activeBrother,
  };
}

function heroRun(type, brother, attach) {
  const sys = makeWorld('asphalt', 0);
  const v = spawn(type, sys);
  // The REAL entry point, with the REAL lookup: `applyHero` asks
  // `ctx.peek('player').brother` exactly as it does in the game.
  const stub = heroStub(brother);
  VehicleSystem.prototype.applyHero.call(stub, v, attach);
  settle(v);
  for (let i = 0; i < 120 * 60 && v.forwardSpeed < 16; i++) drive(v, { throttle: 1 }, 1);
  let latSum = 0;
  let latN = 0;
  const total = 120 * 6;
  drive(v, { throttle: 0.35, steer: 1 }, total, (veh, i) => {
    if (i < total - 240) return;
    _su.set(0, 1, 0).applyQuaternion(veh.quaternion);
    const yawRate = veh.angularVelocity.dot(_su);
    latSum += Math.abs(yawRate * veh.forwardSpeed);
    latN++;
  });
  const peakLat = latN ? latSum / latN : 0;

  const t = spawn(type, makeWorld('asphalt', 0));
  VehicleSystem.prototype.applyHero.call(stub, t, attach);
  settle(t);
  drive(t, { throttle: 1 }, 120 * 95);
  return { lat: peakLat, top: t.forwardSpeed, hero: v.hero };
}

async function testHero() {
  const boys = await loadBrothers();
  check('hero', 'the brothers’ vehicle stats are readable at all',
    !!boys && boys.length >= 3 && boys.every((b) => typeof b.vehicleGrip === 'number'),
    boys ? `${boys.length} brothers, grips ${boys.map((b) => b.vehicleGrip).join(' / ')}`
      : 'neither src/player/brothers.js nor src/game/data.js exposed a stat row');
  if (!boys || boys.length < 3) return;

  const sorted = [...boys].sort((a, b) => a.vehicleGrip - b.vehicleGrip);
  const runs = sorted.map((b) => ({ b, r: heroRun('sedan', b, true) }));

  const lats = runs.map((x) => x.r.lat);
  const tops = runs.map((x) => x.r.top);
  const names = runs.map((x) => x.b.id ?? '?');

  const monotone = (a) => a.every((v, i) => i === 0 || v > a[i - 1]);
  check('hero', 'more vehicle grip really does corner harder',
    monotone(lats) && lats[lats.length - 1] > lats[0] * 1.04,
    `${names.join(' < ')} : ${lats.map((v) => v.toFixed(3)).join(' < ')} m/s^2 ` +
    `(spread x${(lats[lats.length - 1] / lats[0]).toFixed(3)})`);
  check('hero', 'more vehicle grip really does go faster',
    monotone(tops) && tops[tops.length - 1] > tops[0] + 1.0,
    `${names.join(' < ')} : ${tops.map((v) => (v * 3.6).toFixed(1)).join(' < ')} km/h ` +
    `(spread ${((tops[tops.length - 1] - tops[0]) * 3.6).toFixed(1)} km/h)`);

  /**
   * NEGATIVE CONTROL. `applyHero(v, false)` is the identity — which is exactly
   * the build this replaces, where the stat existed and nothing consumed it.
   * All three brothers must then produce the SAME car, bit for bit.
   */
  const flat = sorted.map((b) => heroRun('sedan', b, false));
  const sameLat = flat.every((r) => Math.abs(r.lat - flat[0].lat) < 1e-9);
  const sameTop = flat.every((r) => Math.abs(r.top - flat[0].top) < 1e-9);
  check('hero', 'NEGATIVE CONTROL — detached, the three brothers drive one car',
    sameLat && sameTop,
    `lat ${flat.map((r) => r.lat.toFixed(6)).join(' / ')}, ` +
    `top ${flat.map((r) => (r.top * 3.6).toFixed(4)).join(' / ')} km/h`);

  /* ---- boats: Carson's arc is on the water ---------------------------- */
  const boat = (brother, attach) => {
    const sys = makeWaterWorld(6, true);
    const s = finalizeSpec(VEHICLE_SPECS.boat);
    const v = new Vehicle(sys, s, STUB_MODEL, {});
    v.damage = null;
    v.setPose(new THREE.Vector3(0, 0.2, 0), 0);
    const stub = heroStub(brother);
    VehicleSystem.prototype.applyHero.call(stub, v, attach);
    drive(v, { throttle: 1 }, 120 * 60);
    return v.forwardSpeed;
  };
  const byBoat = [...boys].sort((a, b) => (a.boatSpeed ?? 1) - (b.boatSpeed ?? 1));
  const fast = boat(byBoat[byBoat.length - 1], true);
  const slow = boat(byBoat[0], true);
  check('hero', 'boatSpeed reaches the water',
    fast > slow + 0.3,
    `${byBoat[0].id} ${(slow * 3.6).toFixed(1)} km/h vs ` +
    `${byBoat[byBoat.length - 1].id} ${(fast * 3.6).toFixed(1)} km/h`);
  const cFast = boat(byBoat[byBoat.length - 1], false);
  const cSlow = boat(byBoat[0], false);
  check('hero', 'NEGATIVE CONTROL — detached, every brother’s boat is the same boat',
    Math.abs(cFast - cSlow) < 1e-9,
    `${(cSlow * 3.6).toFixed(4)} vs ${(cFast * 3.6).toFixed(4)} km/h`);
}

/* ================================================================== */
/* 15. WATER — a car in the Allegheny                                  */
/* ================================================================== */

/**
 * Steel City is three rivers and forty bridges, so this is a state players hit
 * in the first ten minutes, and before this pass NOTHING happened in it: the
 * car settled on the riverbed on `SURFACE_GRIP.water` and idled there for the
 * rest of the session.
 *
 * The three water rules, and how each is asserted here:
 *
 *   6 HP/s      a rate off the EMITTED HEALTH over a measured window, checked
 *               against 6% of this class's own maximum. The 0.06 is written out
 *               here rather than read from `WATER.damageRate`, so changing that
 *               constant turns this red instead of dragging it along.
 *   15% cap     the emitted speed in the river against the emitted top speed of
 *               the SAME class on dry asphalt. Two measurements, no constants.
 *   engine      it drowns when the intake goes under, and does NOT when the
 *               water is only over the sills. Two-sided, because a rule that
 *               kills a car for driving through a puddle is a different bug.
 */
const _BIGW = 1e6;
function makeWaterWorld(depth, everywhere = false) {
  const N = new THREE.Vector3(0, 1, 0);
  const HIT = {
    hit: true, point: new THREE.Vector3(), normal: N.clone(),
    distance: 0, surface: 'asphalt', object: null,
  };
  const grip = {};
  for (const k in SURFACE_GRIP) grip[k] = { ...SURFACE_GRIP[k] };
  const physics = {
    MASK: { WORLD: 3 },
    staticWorld: null,
    raycast(origin, dir, maxDist) {
      if (Math.abs(dir.y) < 1e-6) { HIT.hit = false; return HIT; }
      const t = -origin.y / dir.y;
      if (t < 0 || t > maxDist) { HIT.hit = false; return HIT; }
      HIT.hit = true;
      HIT.distance = t;
      HIT.point.set(origin.x + dir.x * t, 0, origin.z + dir.z * t);
      HIT.normal.copy(N);
      HIT.surface = origin.z + dir.z * t > 0 || everywhere ? 'water' : 'asphalt';
      return HIT;
    },
    groundHeight: () => 0,
  };
  return {
    slope: 0, physics, lodOf: () => 0,
    surfaceAt: (x, z) => (z > 0 || everywhere ? 'water' : 'asphalt'),
    /** Flat bed at y = 0; the river is everything past z = 0, `depth` deep. */
    waterHeightAt: (x, z) => (z > 0 || everywhere ? depth : null),
    reportCollision: () => {},
    gripOf: (n) => grip[n] ?? grip.asphalt,
    _world: () => null,
    /** Damage lands here so the test can see it as `sys.damage` would. */
    damage(v, amount) {
      v.health = Math.max(0, v.health - amount);
      if (v.health <= 0) v.destroyed = true;
    },
  };
}

/** Drive a car off the bank into `depth` metres of river and hold the throttle. */
function driveIntoWater(type, depth, seconds, patch) {
  const sys = makeWaterWorld(depth);
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(sys, spec, STUB_MODEL, {});
  v.damage = null;
  v.setPose(new THREE.Vector3(0, spec.comY, -40), 0);
  if (patch) patch(v);
  settle(v);
  /**
   * Run at it from 40 m back so it arrives at a real speed — and then start
   * MEASURING only once it is properly in.
   *
   * The window matters more than it looks. Opening it the instant `submerged`
   * crosses 0.2 measures the ARRIVAL: a car hitting a river at 40 m/s is still
   * doing 40 m/s for the first half second whatever the cap says, and it is
   * only half wet, so the first reading of the damage rate is roughly half the
   * real one and the first reading of the speed is the entry speed. Both
   * numbers then say the rule does not work when what they are describing is
   * the splash. `settled` is the first frame it is properly in — a quarter
   * under, comfortably past `WATER.wadeFrac` — and everything is measured from
   * a second after that.
   */
  let entered = -1;
  let settled = -1;
  const n = Math.round(120 * seconds);
  const samples = [];
  let peakWet = 0;
  for (let i = 0; i < n; i++) {
    drive(v, { throttle: 1 }, 1);
    if (entered < 0 && v.submerged > 0.2) entered = i;
    if (settled < 0 && v.submerged > 0.25) settled = i;
    if (settled >= 0 && i > settled + 120) {
      peakWet = Math.max(peakWet, Math.hypot(v.velocity.x, v.velocity.z));
      if ((i - settled) % 60 === 0) {
        samples.push({ i, health: v.health, t: i / 120, sub: v.submerged });
      }
    }
  }
  return { v, entered, settled, samples, peakWet, spec };
}

function dryTop(type) {
  const v = spawn(type, makeWorld('asphalt', 0));
  settle(v);
  drive(v, { throttle: 1 }, 120 * 95);
  return v.forwardSpeed;
}

/** The water damage rate: 6 HP per second out of a 0-100 bar. */
const REF_WATER_DPS_FRAC = 0.06;

function testWater(type) {
  const deep = driveIntoWater(type, 2.4, 30);
  const spec = deep.spec;
  check('water', `${type} actually gets into the river`,
    deep.entered >= 0 && deep.v.submerged > 0.5,
    `submerged ${deep.v.submerged.toFixed(3)} after ${(deep.entered / 120).toFixed(2)} s`);

  /* ---- damage rate ----------------------------------------------------- */
  {
    // Over the longest window that is still fully alive: a light class drowns
    // outright inside the run and a rate measured across zero is not a rate.
    const alive = deep.samples.filter((s) => s.health > 0);
    const a = alive[0];
    const b = alive[Math.min(alive.length - 1, 8)];
    const dt = a && b ? b.t - a.t : 0;
    const rate = dt > 0 ? (a.health - b.health) / dt : 0;
    const want = REF_WATER_DPS_FRAC * spec.body.hp;
    check('water', `${type} takes 6% of its health per second in the water`,
      dt > 1 && Math.abs(rate - want) < want * 0.12,
      `${rate.toFixed(1)} hp/s over ${dt.toFixed(2)} s (want ${want.toFixed(1)} = ` +
      `6% of ${spec.body.hp}, +/-12%)`);
  }

  /* ---- speed cap -------------------------------------------------------- */
  {
    const dry = dryTop(type);
    const frac = deep.peakWet / dry;
    check('water', `${type} is capped near 15% of its dry top speed in the water`,
      deep.peakWet > 0.05 && frac < 0.18,
      `${(deep.peakWet * 3.6).toFixed(1)} km/h wet against ${(dry * 3.6).toFixed(1)} dry ` +
      `= ${(frac * 100).toFixed(1)}% (want under 18%, and still moving)`);
  }

  /* ---- the engine drowns, and only when the intake goes under ---------- */
  if (!spec.nogas) {
    /**
     * `driveTorque` is NOT the thing to read here: `_stepWheels` skips the
     * whole drivetrain step when the engine is off, so the field simply keeps
     * whatever it held on the last step that ran — 16 944 N.m on the bus, which
     * looks exactly like an engine that is still pulling. `_drivenTorque` is
     * what actually reaches the tyres and IS zeroed on that branch, so that is
     * what a drowned engine has to be measured by.
     */
    const applied = Math.max(...deep.v._drivenTorque.map(Math.abs));
    check('water', `${type} drowns its engine in a deep river`,
      deep.v.drowned === true && deep.v.engineOn === false && applied < 1e-9,
      `drowned ${deep.v.drowned}, engineOn ${deep.v.engineOn}, ` +
      `${applied.toFixed(3)} N.m still reaching the wheels`);

    // A ford, not a river: water below the intake must NOT kill it.
    const wade = Math.max(0.05, spec.hydro.intakeY - 0.12);
    const shallow = driveIntoWater(type, wade, 18);
    check('water', `${type} fords water below its air intake without drowning`,
      shallow.v.drowned === false && shallow.v.engineOn === true,
      `intake at ${spec.hydro.intakeY.toFixed(2)} m, water ${wade.toFixed(2)} m: ` +
      `drowned ${shallow.v.drowned}, engineOn ${shallow.v.engineOn}`);
  } else {
    /**
     * A `nogas` class has no engine to drown — the bicycle's is a pair of legs.
     * It still takes the water damage and the speed cap above, which apply to
     * every non-flying vehicle; what it cannot do is lose an engine it never
     * had.
     */
    check('water', `${type} has no engine to drown`,
      deep.v.drowned === false && deep.v.engineOn === true,
      `drowned ${deep.v.drowned}, engineOn ${deep.v.engineOn}, nogas ${spec.nogas}`);
  }

  /**
   * ---- NEGATIVE CONTROL: the build before this pass ----
   *
   * `_stepWater` replaced by a no-op is EXACTLY the state this section exists
   * for: the car reaches the riverbed on `SURFACE_GRIP.water`'s mu 0.22 and
   * nothing else happens to it. Health must not move, the engine must still be
   * running, and it must be going faster than the cap.
   */
  {
    const real = Vehicle.prototype._stepWater;
    Vehicle.prototype._stepWater = function noWater() {};
    let ctl;
    try {
      ctl = driveIntoWater(type, 2.4, 30);
    } finally {
      Vehicle.prototype._stepWater = real;
    }
    const dry = dryTop(type);
    check('water', `${type} NEGATIVE CONTROL — with the water rules off, nothing happens`,
      ctl.v.health === ctl.spec.body.hp && ctl.v.drowned === false &&
      ctl.v.engineOn === true,
      `health ${ctl.v.health.toFixed(0)}/${ctl.spec.body.hp}, drowned ${ctl.v.drowned}, ` +
      `engineOn ${ctl.v.engineOn}, ${(ctl.peakWet * 3.6).toFixed(1)} km/h ` +
      `(${((ctl.peakWet / dry) * 100).toFixed(0)}% of dry)`);
  }
}

/* ------------------------------------------------------------------ */

const ONLY = args.type ? new Set(String(args.type).split(',')) : null;
const want = (id) => !ONLY || ONLY.has(id);

for (const type of TYPES) {
  testStability(type);
  testLaunch(type);
  testReverse(type);
  testNoLatch(type);
  testShove(type);
  testSteering(type);
  testPace(type);
  testGo(type);
  testLayout(type);
  testKerbs(type);
  testBoost(type);
  // Water is a car problem: the boat is at home in it and the helicopter is
  // exempt because it flies.
  testWater(type);
}
testBusIsSlowest();
if (want('heli')) testHeli();
if (want('bicycle')) testBicycle();
if (want('bus')) testBus();
if (!ONLY) await testHero();

let section = '';
const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  if (r.section !== section) { section = r.section; console.log(`\n--- ${section} ---`); }
  if (r.ok && !VERBOSE) continue;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} drive assertions pass`);
process.exitCode = failed ? 1 : 0;
