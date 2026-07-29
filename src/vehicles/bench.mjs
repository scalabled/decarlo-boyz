#!/usr/bin/env node
/**
 * Headless dynamics bench (dev tool, not shipped).
 *
 * Runs the REAL `Vehicle` class at the real 120 Hz fixed step against a
 * synthetic flat plane, in Node, with no browser and no city. That isolates
 * the handling model from whatever the world happens to have built this hour,
 * and makes every number reproducible to the last digit.
 *
 * What it measures, per class:
 *   0-60 / 0-100 km/h, top speed, and the gear it tops out in
 *   braking distance from 100 km/h and peak deceleration in g
 *   SQUAT and DIVE in millimetres of real suspension travel — the proof that
 *     load is being applied at the contact patch and not at the centre of mass
 *   steady-state roll angle, lateral g, and the outside/inside load split
 *   handbrake slip angle, and whether it recovers
 *
 *   node src/vehicles/bench.mjs
 *   node src/vehicles/bench.mjs --type=truck --trace
 */

import * as THREE from 'three';
import {
  VEHICLE_SPECS, CLASS_IDS, finalizeSpec, SURFACE_GRIP, WET_SENS, wetGrip,
} from './specs.js';
import { Vehicle } from './dynamics.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const DT = 1 / 120;
const SURFACE = args.surface ?? 'asphalt';

/* ------------------------------------------------------------------ */
/* A flat world.                                                       */
/* ------------------------------------------------------------------ */

const HIT = {
  hit: true,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  distance: 0,
  surface: SURFACE,
  object: null,
};

const fakePhysics = {
  MASK: { WORLD: 3 },
  staticWorld: null, // no chassis collision on an infinite plane
  raycast(origin, dir, maxDist) {
    // Plane y = 0, ray straight down (the strut axis is near-vertical).
    const denom = dir.y;
    if (denom >= -1e-6) { HIT.hit = false; return HIT; }
    const t = -origin.y / denom;
    if (t < 0 || t > maxDist) { HIT.hit = false; return HIT; }
    HIT.hit = true;
    HIT.distance = t;
    HIT.point.set(origin.x + dir.x * t, 0, origin.z + dir.z * t);
    HIT.normal.set(0, 1, 0);
    HIT.surface = SURFACE;
    return HIT;
  },
  groundHeight: () => 0,
};

/**
 * Wetness, exactly as `VehicleSystem` applies it when `sky` pushes
 * `weather:change`. `--wet=0.85` is a road in the rain.
 *
 *   node src/vehicles/bench.mjs --type=sedan --wet=1 | grep brakeDist
 */
const WET = Math.max(0, Math.min(1, Number(args.wet ?? 0)));
const GRIP = {};
for (const k in SURFACE_GRIP) {
  const base = SURFACE_GRIP[k];
  const sens = WET_SENS[k] ?? 0.6;
  GRIP[k] = {
    ...base,
    mu: wetGrip(base.mu, WET * sens),
    skid: base.skid * (1 + 0.5 * WET * sens),
    roll: base.roll * (1 + 0.10 * WET * sens),
    drag: base.drag + 0.012 * WET * sens,
  };
}

const fakeSys = {
  physics: fakePhysics,
  lodOf: () => 0,
  surfaceAt: () => SURFACE,
  waterHeightAt: () => null,
  reportCollision: () => {},
  gripOf: (name) => GRIP[name] ?? GRIP.asphalt,
  _world: () => null,
};

const stubModel = { root: null, wheels: [], panels: [], glassMeshes: [], lampMats: {} };
const CTX = { events: { emit() {} }, peek: () => null, time: { elapsed: 0 } };

function makeVehicle(type) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(fakeSys, spec, stubModel, {});
  v.setPose(new THREE.Vector3(0, spec.comY, 0), 0);
  v.damage = null;
  return v;
}

function step(v, input, n, sample) {
  for (let i = 0; i < n; i++) {
    v.input.throttle = input.throttle ?? 0;
    v.input.brake = input.brake ?? 0;
    v.input.steer = input.steer ?? 0;
    v.input.reverse = input.reverse ?? 0;
    v.input.handbrake = !!input.handbrake;
    v.fixedStep(DT, CTX);
    if (sample) sample(i, v);
  }
}

function settle(v) {
  step(v, { brake: 1 }, 360);
  return v.wheels.map((w) => w.len);
}

const kmh = (v) => v.speed * 3.6;
const deg = (r) => (r * 180) / Math.PI;
function rollDeg(v) {
  const q = v.quaternion;
  return deg(Math.asin(Math.max(-1, Math.min(1, 2 * (q.x * q.y - q.w * q.z)))));
}
function pitchDeg(v) {
  const q = v.quaternion;
  return deg(Math.asin(Math.max(-1, Math.min(1, 2 * (q.y * q.z + q.w * q.x)))));
}

/* ------------------------------------------------------------------ */

/**
 * The boat gets its own bench: flat water at y = 0, no ground at all. What has
 * to be true is that it FLOATS at a sane draft, that it climbs onto the plane
 * (trim swings bow-down and the wetted fraction falls), and that the rudder
 * only bites when there is thrust.
 */
function benchBoat(type) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const waterSys = {
    ...fakeSys,
    physics: { ...fakePhysics, raycast: () => ({ hit: false, distance: Infinity, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), surface: 'water' }) },
    waterHeightAt: () => 0,
  };
  const v = new Vehicle(waterSys, spec, stubModel, {});
  v.setPose(new THREE.Vector3(0, 1.6, 0), 0);
  v.damage = null;
  const s2 = (input, n, sample) => {
    for (let i = 0; i < n; i++) {
      v.input.throttle = input.throttle ?? 0;
      v.input.brake = input.brake ?? 0;
      v.input.steer = input.steer ?? 0;
      v.fixedStep(DT, CTX);
      if (sample) sample(i, v);
    }
  };
  s2({}, 120 * 12);                                  // let it find its waterline
  const restY = v.position.y;
  const restPitch = pitchDeg(v);
  const restWet = v.wetted;

  let top = 0, planing = 0, wetAtSpeed = 1, trimAtSpeed = 0;
  s2({ throttle: 1 }, 120 * 45, () => {
    if (kmh(v) > top) top = kmh(v);
    if (v.planing > planing) planing = v.planing;
    if (kmh(v) > top * 0.94) { wetAtSpeed = v.wetted; trimAtSpeed = pitchDeg(v); }
  });

  // Rudder authority with and without thrust.
  const yawWith = (() => {
    let m = 0;
    s2({ throttle: 1, steer: 1 }, 120 * 4, () => { m = Math.max(m, Math.abs(v.angularVelocity.y)); });
    return m;
  })();
  const yawCoast = (() => {
    let m = 0;
    s2({ throttle: 0, steer: 1 }, 120 * 4, () => { m = Math.max(m, Math.abs(v.angularVelocity.y)); });
    return m;
  })();

  return {
    name: spec.name,
    mass: spec.mass,
    restDraft_m: +(spec.style.keelY - (restY - spec.comY) + 0).toFixed(3),
    restHullY_m: +restY.toFixed(3),
    restTrim_deg: +restPitch.toFixed(2),
    restWetted: +restWet.toFixed(2),
    topSpeed_kmh: +top.toFixed(1),
    planing01: +planing.toFixed(2),
    wettedAtSpeed: +wetAtSpeed.toFixed(2),
    trimAtSpeed_deg: +trimAtSpeed.toFixed(2),
    yawRate_underPower: +yawWith.toFixed(3),
    yawRate_coasting: +yawCoast.toFixed(3),
  };
}

/**
 * REVERSE, and the manoeuvre it exists for.
 *
 * Two things a player does constantly and neither of which worked:
 *
 *   1. Nose into something, hold S, back out. On a keyboard S is `input.brake`,
 *      so the test is literally "hold the brake pedal and check the car ends up
 *      going BACKWARDS" — which it could not, because the auto box shifted out
 *      of reverse as soon as anything touched the throttle and nothing ever
 *      drove the reverse gear.
 *   2. A three-point turn in a dead end: forward-left into the kerb, reverse
 *      right, forward again, and leave facing the way you came. The number that
 *      matters is the net heading change and that it happens inside a road
 *      width — a car that cannot reverse scores ~0 degrees here.
 *
 * `autoReverse` is what `VehicleSystem` arms when a player takes the wheel; AI
 * traffic uses `input.reverse` instead and that path is measured too.
 */
function benchReverse(type) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);

  // ---- 1. brake to a stop, keep holding S, and back up --------------------
  const v = makeVehicle(type);
  v.autoReverse = true;
  settle(v);
  step(v, { throttle: 1 }, 120 * 3);                 // roll forward
  const fwdSpeed = v.forwardSpeed;
  let stoppedAt = -1;
  step(v, { brake: 1 }, 120 * 6, (i) => {
    if (stoppedAt < 0 && v.forwardSpeed < 0.05) stoppedAt = i / 120;
  });
  const revSpeed = -v.forwardSpeed;                  // + = actually reversing
  const revGear = v.drivetrain.gearLabel;
  // Now press W: it must BRAKE the reverse, then pull away forwards again.
  step(v, { throttle: 1 }, 120 * 3);
  const backForward = v.forwardSpeed;

  // ---- 2. the AI channel: setInput({ reverse }) ---------------------------
  const v2 = makeVehicle(type);
  settle(v2);
  step(v2, { throttle: 1 }, 120 * 3);
  step(v2, { reverse: 1 }, 120 * 6);
  const aiRevSpeed = -v2.forwardSpeed;
  // An AI holding the brake at a red light must NEVER select reverse.
  const v3 = makeVehicle(type);
  settle(v3);
  step(v3, { brake: 1 }, 120 * 8);
  const idleCreep = -v3.forwardSpeed;

  // ...and a car ABANDONED in reverse must not drive itself down the street.
  // `clearDriver` parks a car by holding the brake on, and with the pedals
  // crossed that is full reverse throttle.
  const v5 = makeVehicle(type);
  v5.autoReverse = true;
  settle(v5);
  step(v5, { brake: 1 }, 120 * 3);            // select reverse and back up
  const beforeAbandon = -v5.forwardSpeed;
  v5.autoReverse = false;                     // the driver gets out
  step(v5, { brake: 1 }, 120 * 5);
  const abandonedDrift = -v5.forwardSpeed;
  const abandonedGear = v5.drivetrain.gearLabel;

  /**
   * ---- 3. three-point turn in a dead end ---------------------------------
   *
   * Closed loop, because a fixed script measures the script and not the car:
   * drive on full lock until the nose is `CORRIDOR` metres up the dead end,
   * then hold S (reverse, opposite lock) until you are back at the mouth, then
   * pull away again. What is reported is the heading actually turned and the
   * WIDEST the car ever got from where it started — the corridor the manoeuvre
   * needs. A street here is 7-9 m wide.
   */
  const v4 = makeVehicle(type);
  v4.autoReverse = true;
  settle(v4);
  const yaw0 = headingDeg(v4);
  const x0 = v4.position.x;
  const z0 = v4.position.z;
  /** The length of one leg of the manoeuvre — a dead end you can't drive out of. */
  const LEG = 5.0;
  /** Nobody does a three-point turn at speed; hold it to a walking pace. */
  const CRAWL = 2.4;
  let swept = 0;
  const dist = () => Math.hypot(v4.position.x - x0, v4.position.z - z0);
  const turnedSoFar = () => Math.abs(angleDelta(yaw0, headingDeg(v4)));
  /** Runs one leg of at most `LEG` metres of path, or until the turn is done. */
  const leg = (input, maxS) => {
    let travelled = 0;
    let px = v4.position.x;
    let pz = v4.position.z;
    for (let i = 0; i < 120 * maxS; i++) {
      step(v4, input(), 1);
      travelled += Math.hypot(v4.position.x - px, v4.position.z - pz);
      px = v4.position.x;
      pz = v4.position.z;
      if (dist() > swept) swept = dist();
      if (travelled > LEG || turnedSoFar() > 172) return;
    }
  };
  const forward = () => ({
    throttle: v4.forwardSpeed < CRAWL ? 0.3 : 0,
    brake: v4.forwardSpeed > CRAWL * 1.6 ? 0.3 : 0,
    steer: -1,
  });
  // The whole manoeuvre on two keys: W with full left lock, then S held (which
  // brakes, selects reverse, and backs out) with opposite lock, and repeat.
  // `legs` is the answer to "can a player get out of a dead end?" — 3 is a
  // three-point turn, and anything that never reaches 172 degrees is stuck.
  let legs = 0;
  for (; legs < 8 && turnedSoFar() <= 172; legs++) {
    if (legs % 2 === 0) leg(forward, 8);
    else leg(() => ({ brake: 1, steer: 1 }), 10);
  }
  const turned = turnedSoFar();

  return {
    forwardBefore_ms: +fwdSpeed.toFixed(2),
    stopAfter_s: stoppedAt < 0 ? null : +stoppedAt.toFixed(2),
    reverseSpeed_ms: +revSpeed.toFixed(2),
    reverseGear: revGear,
    forwardAgain_ms: +backForward.toFixed(2),
    aiReverseSpeed_ms: +aiRevSpeed.toFixed(2),
    aiBrakeHoldCreep_ms: +idleCreep.toFixed(3),
    abandonedInR_ms: +beforeAbandon.toFixed(2),
    abandonedDrift_ms: +abandonedDrift.toFixed(3),
    abandonedGear: abandonedGear,
    turnAround_deg: +turned.toFixed(1),
    turnAround_legs: legs,
    turnAround_corridor_m: +swept.toFixed(1),
  };
}

/**
 * WEDGED AT FULL THROTTLE — the failure `traffic` measured in the live city.
 *
 * Hold a car still (nose against a kerb, the car in front, a broken wheel
 * dragging) with the throttle flat, then let it go. The engine revs against a
 * slipping clutch the whole time, and an auto box that shifts on ENGINE speed
 * will climb to top gear while the car has never moved — after which it cannot
 * pull away even once it is free, because top gear multiplies torque by a third
 * of what first does and the engine is sitting on the limiter making nothing.
 *
 * Measured live before the fix: `gear 5, rpm 6297, road speed 0.03 m/s,
 * driveTorque 49 N.m` on clean asphalt with nothing touching the car.
 */
function benchStall(type) {
  const v = makeVehicle(type);
  settle(v);
  // Pinned: the world is holding it. Vertical motion is left alone so the
  // suspension still solves and the wheels stay loaded.
  for (let i = 0; i < 120 * 5; i++) {
    v.input.throttle = 1;
    v.input.brake = 0;
    v.input.steer = 0;
    v.input.handbrake = false;
    v.fixedStep(DT, CTX);
    v.velocity.x = 0;
    v.velocity.z = 0;
    v.position.x = 0;
    v.position.z = 0;
    v.angularVelocity.y = 0;
  }
  const gearWedged = v.drivetrain.gearLabel;
  const rpmWedged = Math.round(v.drivetrain.rpm);
  const torqueWedged = Math.round(v.drivetrain.driveTorque);

  // Released: how long to walking pace, and to 30 km/h?
  let t = 0;
  let tWalk = null;
  let t30 = null;
  step(v, { throttle: 1 }, 120 * 12, () => {
    t += DT;
    if (tWalk === null && v.forwardSpeed > 1.5) tWalk = t;
    if (t30 === null && kmh(v) > 30) t30 = t;
  });
  return {
    gearWhileWedged: gearWedged,
    rpmWhileWedged: rpmWedged,
    wheelTorqueWhileWedged_Nm: torqueWedged,
    secsToWalkingPace: tWalk === null ? null : +tWalk.toFixed(2),
    secsTo30kmh: t30 === null ? null : +t30.toFixed(2),
    speedAfter12s_kmh: +kmh(v).toFixed(1),
  };
}

function headingDeg(v) {
  const q = v.quaternion;
  return deg(Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x)));
}

function angleDelta(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return d;
}

function benchOne(type) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  if (spec.kind === 'boat') return benchBoat(type);

  const v = makeVehicle(type);
  const rest = settle(v);
  const restF = (rest[0] + rest[1]) / 2;
  const restR = v.wheels.length > 2 ? (rest[2] + rest[3]) / 2 : rest[1];
  const restLoads = v.wheels.map((w) => Math.round(w.load));

  // ---- acceleration ------------------------------------------------------
  let t = 0, t60 = null, t100 = null, top = 0;
  let squatR = 0, liftF = 0, maxPitch = 0;
  let wheelspin = 0;
  step(v, { throttle: 1 }, 120 * 60, (i) => {
    t += DT;
    const s = kmh(v);
    if (!t60 && s >= 60) t60 = t;
    if (!t100 && s >= 100) t100 = t;
    if (s > top) top = s;
    if (i < 900) {
      const dF = restF - (v.wheels[0].len + v.wheels[1].len) / 2;
      const dR = restR - (v.wheels.length > 2 ? (v.wheels[2].len + v.wheels[3].len) / 2 : v.wheels[1].len);
      if (dR > squatR) squatR = dR;
      if (-dF > liftF) liftF = -dF;
      const p = pitchDeg(v);
      if (Math.abs(p) > Math.abs(maxPitch)) maxPitch = p;
      for (const w of v.wheels) if (w.combined > wheelspin) wheelspin = w.combined;
    }
  });
  const topGear = v.drivetrain.gearLabel;
  const topRpm = Math.round(v.drivetrain.rpm);

  // ---- braking from 100 --------------------------------------------------
  const v2 = makeVehicle(type);
  settle(v2);
  step(v2, { throttle: 1 }, 120 * 60, () => {});
  // bring it to exactly ~100 km/h by coasting or accelerating
  let guard = 0;
  while (kmh(v2) > 101 && guard++ < 4000) step(v2, { throttle: 0 }, 1);
  while (kmh(v2) < 99 && guard++ < 8000) step(v2, { throttle: 1 }, 1);
  const vB = kmh(v2);
  const bStart = v2.position.clone();
  let diveF = 0, liftR = 0, maxDecel = 0, prevSpeed = v2.speed;
  let brakeSteps = 0;
  step(v2, { brake: 1 }, 120 * 20, (i) => {
    if (v2.speed > 0.4) brakeSteps = i;
    const dF = restF - (v2.wheels[0].len + v2.wheels[1].len) / 2;
    const dR = restR - (v2.wheels.length > 2 ? (v2.wheels[2].len + v2.wheels[3].len) / 2 : v2.wheels[1].len);
    if (dF > diveF) diveF = dF;
    if (-dR > liftR) liftR = -dR;
    const a = (prevSpeed - v2.speed) / DT;
    if (a > maxDecel) maxDecel = a;
    prevSpeed = v2.speed;
  });
  const brakeDist = Math.hypot(v2.position.x - bStart.x, v2.position.z - bStart.z);

  // ---- steady-state cornering -------------------------------------------
  // A real steady-state test: hold a target speed with a throttle controller
  // and wind the steering on. Flooring it to 180 km/h and then yanking full
  // lock measures a spin, not a cornering limit.
  const v3 = makeVehicle(type);
  settle(v3);
  const target = Math.min(22, spec.topSpeedHint ?? 22); // m/s ~ 80 km/h
  let maxRoll = 0, latG = 0, lo = 0, li = 0, slip = 0, cSpeed = 0;
  const hold = () => {
    const e = target - v3.forwardSpeed;
    return { throttle: Math.max(0, Math.min(1, e * 0.35)), brake: Math.max(0, Math.min(1, -e * 0.25)) };
  };
  // Accelerate only until the target speed — running full throttle for a fixed
  // 12 s puts a superbike at 165 km/h before the steering test even starts.
  for (let i = 0; i < 120 * 30 && v3.forwardSpeed < target; i++) {
    v3.input.throttle = 1; v3.input.brake = 0; v3.input.steer = 0; v3.input.handbrake = false;
    v3.fixedStep(DT, CTX);
  }
  for (let i = 0; i < 120 * 10; i++) {
    const h = hold();
    const steer = Math.min(0.75, i / (120 * 2.5) * 0.75);
    v3.input.throttle = h.throttle;
    v3.input.brake = h.brake;
    v3.input.steer = steer;
    v3.input.handbrake = false;
    v3.fixedStep(DT, CTX);
    if (i < 120 * 2) continue;
    const beta = Math.abs(deg(v3.slipAngle));
    if (beta > slip) slip = beta;
    // Only sample the cornering limit while the car is still CORNERING.
    if (beta > 22) continue;
    const r = rollDeg(v3);
    if (Math.abs(r) > Math.abs(maxRoll)) maxRoll = r;
    const g = Math.abs(v3.angularVelocity.y * v3.forwardSpeed) / 9.81;
    if (g > latG) {
      latG = g;
      const L = v3.wheels.map((w) => w.load);
      lo = Math.round(L[0] + (L[2] ?? 0));
      li = Math.round(L[1] + (L[3] ?? 0));
      cSpeed = kmh(v3);
    }
  }

  // ---- handbrake ---------------------------------------------------------
  const v4 = makeVehicle(type);
  settle(v4);
  step(v4, { throttle: 1 }, 120 * 8);
  let peak = 0;
  step(v4, { throttle: 0.3, steer: 0.9, handbrake: true }, 120 * 1.1, () => {
    const s = Math.abs(deg(v4.slipAngle));
    if (s > peak) peak = s;
  });
  step(v4, { throttle: 0.5, steer: -0.35 }, 120 * 2.5, () => {
    const s = Math.abs(deg(v4.slipAngle));
    if (s > peak) peak = s;
  });
  const recovered = Math.abs(deg(v4.slipAngle));

  return {
    name: spec.name,
    mass: spec.mass,
    drive: spec.drive,
    restSusp_mm: rest.map((l) => +(l * 1000).toFixed(1)),
    restLoads_N: restLoads,
    staticLoad_N: [Math.round(spec.staticLoadF), Math.round(spec.staticLoadR)],
    t0_60kmh: t60 ? +t60.toFixed(2) : null,
    t0_100kmh: t100 ? +t100.toFixed(2) : null,
    topSpeed_kmh: +top.toFixed(1),
    topGear,
    topRpm,
    peakWheelslip: +wheelspin.toFixed(2),
    squatRear_mm: +(squatR * 1000).toFixed(1),
    liftFront_mm: +(liftF * 1000).toFixed(1),
    accelPitch_deg: +maxPitch.toFixed(2),
    brakeFrom_kmh: +vB.toFixed(1),
    brakeDist_m: +brakeDist.toFixed(1),
    brakeDecel_g: +(maxDecel / 9.81).toFixed(2),
    diveFront_mm: +(diveF * 1000).toFixed(1),
    liftRear_mm: +(liftR * 1000).toFixed(1),
    cornerSpeed_kmh: +cSpeed.toFixed(1),
    cornerLat_g: +latG.toFixed(2),
    cornerRoll_deg: +maxRoll.toFixed(2),
    loadOuter_N: lo,
    loadInner_N: li,
    loadTransfer_pct: lo + li > 0 ? +(((lo - li) / (lo + li)) * 100).toFixed(0) : 0,
    cornerSlip_deg: +slip.toFixed(1),
    handbrakePeakSlip_deg: +peak.toFixed(1),
    handbrakeRecovered_deg: +recovered.toFixed(1),
    reverse: benchReverse(type),
    wedged: benchStall(type),
  };
}

const types = args.type ? String(args.type).split(',') : CLASS_IDS;
const out = {};
for (const t of types) {
  const t0 = performance.now();
  try {
    out[t] = benchOne(t);
    out[t].benchMs = Math.round(performance.now() - t0);
  } catch (e) {
    out[t] = { error: String(e.stack ?? e) };
  }
}
console.log(JSON.stringify({ surface: SURFACE, wetness: WET, dt: DT, out }, null, 2));
