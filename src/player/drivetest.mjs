#!/usr/bin/env node
/**
 * DRIVING TEST — what the PLAYER does, not what the car can do.
 *
 * `src/vehicles/bench.mjs` measures the car: it writes `v.input.throttle`
 * directly and the numbers are excellent. `tools/playprobe.mjs` measures the
 * game, but it graded "W drives the car" on `v.speed`, which is
 * `velocity.length()` — UNSIGNED. A car being driven backwards at 4 m/s scores
 * 4.0 and passes. Both harnesses were green while the player could not drive
 * forwards at all.
 *
 * So this one runs the real `VehicleHandler` (the thing that reads the
 * keyboard) against the real `Vehicle` (the thing that moves), and every
 * assertion is SIGNED or is a geometric relationship that can only be right one
 * way round:
 *
 *   1. W from rest  -> forwardSpeed must go POSITIVE
 *   2. S from rest  -> forwardSpeed must go NEGATIVE
 *   3. W out of reverse -> back to POSITIVE (the second half of a 3-point turn)
 *   4. the body must be IN the seat: the root within a few cm of the seat
 *      anchor's own hip line, the head UNDER the roof, feet not through it
 *   5. the body's forward vector must agree with the CAR's forward vector.
 *      A yaw taken from the wrong convention is 180 degrees out and every
 *      other test in the project still passes.
 *
 * Nothing here is a mock of the code under test. `Movement`, `VehicleHandler`
 * and `Vehicle` are the shipping classes; only the world (a flat plane) and the
 * keyboard are stubbed, exactly as `bench.mjs` does it.
 *
 *   node src/player/drivetest.mjs
 *   node src/player/drivetest.mjs --type=sports --verbose
 */

import * as THREE from 'three';
import {
  VEHICLE_SPECS, finalizeSpec, SURFACE_GRIP, WET_SENS, wetGrip,
} from '../vehicles/specs.js';
import { Vehicle } from '../vehicles/dynamics.js';
import { VehicleSystem } from '../vehicles/index.js';
import { Movement } from './movement.js';
import { VehicleHandler } from './vehicle.js';
import { CameraRig } from './camera.js';
import { GAIT } from './tuning.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

/** Physics tick, matching `bench.mjs` and the engine. */
const PDT = 1 / 120;
/** Frame tick — `VehicleHandler.update` runs once per rendered frame. */
const FDT = 1 / 60;
const SURFACE = 'asphalt';
const VERBOSE = !!args.verbose;

const TYPES = args.type
  ? String(args.type).split(',')
  : ['sedan', 'sports', 'muscle', 'truck', 'bike'];

/* ====================================================================== */
/* A flat world (same construction as src/vehicles/bench.mjs)             */
/* ====================================================================== */

const HIT = {
  hit: true,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  distance: 0,
  surface: SURFACE,
  object: null,
};

const fakePhysics = {
  MASK: { WORLD: 3, CHARACTER: 3 },
  staticWorld: null,
  raycast(origin, dir, maxDist) {
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
  /** Every exit candidate is clear on an empty plane. */
  checkCapsule: () => true,
  /** Nothing for the camera boom to hit out here. */
  sphereCast: () => ({ hit: false, distance: Infinity }),
};

const GRIP = {};
for (const k in SURFACE_GRIP) {
  const base = SURFACE_GRIP[k];
  const sens = WET_SENS[k] ?? 0.6;
  GRIP[k] = { ...base, mu: wetGrip(base.mu, 0 * sens), skid: base.skid, roll: base.roll, drag: base.drag };
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

/* ====================================================================== */
/* The harness: one player, one car, one shared clock                     */
/* ====================================================================== */

/**
 * A keyboard. `VehicleHandler._stepDrive` reads exactly three things off
 * `ctx.input`, so this is the whole surface — and it is deliberately built the
 * way `core/input.js` builds it, W = +y, S = -y (`Input.moveVector`).
 */
function makeInput() {
  const held = new Set();
  return {
    held,
    press: (k) => held.add(k),
    release: (k) => held.delete(k),
    clear: () => held.clear(),
    moveVector(out = { x: 0, y: 0 }) {
      out.x = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
      out.y = (held.has('forward') ? 1 : 0) - (held.has('back') ? 1 : 0);
      return out;
    },
    action: (name) => held.has(name),
  };
}

/**
 * Just enough `VehicleSystem` to be the real one for everything the player
 * touches. `setInput`, `seatAnchor`, `setDriver` and `clearDriver` are the
 * SHIPPING implementations, borrowed off the prototype — the pedal crossing and
 * the seat anchor both live in there and a reimplementation would hide them.
 */
function makeVehicleSystem(ctx, v, player) {
  return {
    ctx,
    vehicles: [v],
    _isPlayerActor: (a) => a === player,
    setHorn: VehicleSystem.prototype.setHorn,
    onFuelState: () => {},
    nearest: VehicleSystem.prototype.nearest,
    setInput: VehicleSystem.prototype.setInput,
    seatAnchor: VehicleSystem.prototype.seatAnchor,
    setDriver: VehicleSystem.prototype.setDriver,
    clearDriver: VehicleSystem.prototype.clearDriver,
    setDoor: () => {},
  };
}

function makeRig(type) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(fakeSys, spec, stubModel, {});
  v.setPose(new THREE.Vector3(0, spec.comY, 0), 0);
  v.damage = null;
  v.occupants = [];
  v.driver = null;

  const time = { dt: FDT, elapsed: 0, alpha: 1, frame: 0 };
  const listeners = new Map();
  const events = {
    emit(name, payload) { for (const f of listeners.get(name) ?? []) f(payload); },
    on(name, f) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(f);
      return () => {};
    },
  };
  const input = makeInput();
  const registry = { physics: fakePhysics };
  const ctx = {
    time, events, input,
    config: { fov: 65 },
    peek: (k) => registry[k] ?? null,
  };

  const player = { controlEnabled: true, health: { dead: false } };
  const m = new Movement(ctx, player);
  m.grounded = true;
  player.movement = m;

  const vehicles = makeVehicleSystem(ctx, v, player);
  registry.vehicles = vehicles;

  const handler = new VehicleHandler(ctx, player);
  player.vehicles = handler;

  // The real chase camera, so "what the player sees" is measurable too.
  const cam = new CameraRig(ctx);
  const health = { fraction: 1, suppression: 0 };

  return { spec, v, m, ctx, input, handler, player, time, vehicles, cam, health };
}

/** One rendered frame: the handler, the camera, then two physics ticks. */
function frame(rig) {
  rig.time.frame++;
  rig.time.elapsed += FDT;
  rig.handler.update(FDT, rig.m);
  rig.cam.setVehicle(rig.handler.seated ? rig.handler.vehicle : null);
  rig.cam.update(FDT, rig.m, rig.health);
  rig.v.fixedStep(PDT, rig.ctx);
  rig.v.fixedStep(PDT, rig.ctx);
}

function frames(rig, n, sample) {
  for (let i = 0; i < n; i++) {
    frame(rig);
    if (sample) sample(i, rig);
  }
}

/** Walk up to the driver's door, press F, and wait for the seat. */
function seatThePlayer(rig) {
  const a = rig.vehicles.seatAnchor(rig.v, 0);
  // Stand beside the driver's door, on the ground.
  rig.m.position.set(a.enter.x, 0, a.enter.z);
  rig.m.prevPosition.copy(rig.m.position);
  rig.m.grounded = true;
  frame(rig);                                    // _scan picks the candidate
  const ok = rig.handler.tryEnter(rig.m);
  if (!ok) return false;
  for (let i = 0; i < 240 && rig.handler.phase !== 'drive'; i++) frame(rig);
  return rig.handler.phase === 'drive';
}

/* ====================================================================== */
/* Geometry of "in the seat"                                              */
/* ====================================================================== */

/**
 * The mesh, as `anim/animator.js` builds it:
 *   root.position = movement.position                    (animator.js, `_pose`)
 *   forward       = (-sin faceYaw, 0, -cos faceYaw)
 * and the bind skeleton (character/mesh.js, BONE_SPEC) stacks the hips 0.945 m,
 * the head bone 1.548 m and the crown 1.79 m above the root. `_poseDriving`
 * drops the pelvis by `GAIT.seat.hipDrop` and every bone above it follows, so
 * these are the heights of the SEATED body over its root.
 */
const BIND = { hips: 0.945, head: 1.548, crown: 1.79 };
const SEATED = {
  hips: BIND.hips - GAIT.seat.hipDrop,
  head: BIND.head - GAIT.seat.hipDrop,
  crown: BIND.crown - GAIT.seat.hipDrop,
  /** Where `_poseDriving` puts the foot IK target: `soleY + 0.02` over the root. */
  sole: 0.028 + 0.02,
};

function bodyForward(m, out = new THREE.Vector3()) {
  return out.set(-Math.sin(m.faceYaw), 0, -Math.cos(m.faceYaw));
}

function carForward(v, out = new THREE.Vector3()) {
  return out.set(0, 0, 1).applyQuaternion(v.quaternion);
}

/* ====================================================================== */
/* The measurements                                                       */
/* ====================================================================== */

const results = [];
const rec = (area, name, ok, detail) => results.push({ area, name, ok, detail });
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : String(n));

/**
 * 1-3: THE PEDALS. Every number is signed forward speed along the car's own
 * nose, which is the only measure that can tell forwards from backwards.
 */
function testPedals(type) {
  const rig = makeRig(type);
  if (!seatThePlayer(rig)) {
    rec(type, 'player reaches the seat', false, `stuck in phase "${rig.handler.phase}"`);
    return;
  }
  rec(type, 'player reaches the seat', true, 'phase drive');

  // ---- W from rest -------------------------------------------------------
  rig.input.press('forward');
  frames(rig, 60 * 3);
  const wFwd = rig.v.forwardSpeed;
  rig.input.release('forward');
  rec(type, 'W drives FORWARD', wFwd > 2.0, `forwardSpeed ${f2(wFwd)} m/s (want > +2)`);

  // Coast to a stop before the next pedal, so each test starts from rest.
  frames(rig, 60 * 6);

  // ---- S from rest -------------------------------------------------------
  const rig2 = makeRig(type);
  if (!seatThePlayer(rig2)) return;
  rig2.input.press('back');
  frames(rig2, 60 * 5);
  const sFwd = rig2.v.forwardSpeed;
  rec(type, 'S drives BACKWARD', sFwd < -0.8, `forwardSpeed ${f2(sFwd)} m/s (want < -0.8)`);

  // ---- W out of reverse --------------------------------------------------
  rig2.input.release('back');
  rig2.input.press('forward');
  frames(rig2, 60 * 4);
  const outFwd = rig2.v.forwardSpeed;
  rig2.input.release('forward');
  rec(type, 'W pulls out of reverse', outFwd > 1.0, `forwardSpeed ${f2(outFwd)} m/s (want > +1)`);

  // ---- and the car goes where its nose points ----------------------------
  const rig3 = makeRig(type);
  if (!seatThePlayer(rig3)) return;
  const p0 = rig3.v.position.clone();
  rig3.input.press('forward');
  frames(rig3, 60 * 3);
  const travel = rig3.v.position.clone().sub(p0);
  const nose = carForward(rig3.v);
  const along = travel.dot(nose);
  rec(type, 'W moves the car nose-first', along > 2.0,
    `${f2(along)} m along the nose over 3 s`);
}

/**
 * 4-5: THE SEAT. Measured against the anchor `vehicles` publishes, and against
 * the car's own bodywork, in the car's local frame — so it is a statement about
 * the body being inside the cabin, not about a world coordinate.
 */
function testSeat(type) {
  const rig = makeRig(type);
  if (!seatThePlayer(rig)) return;

  const v = rig.v;
  const st = v.spec.style;
  const anchor = rig.vehicles.seatAnchor(v, 0);

  // Body root, in the CAR's local frame.
  const local = rig.m.position.clone().sub(v.position)
    .applyQuaternion(v.quaternion.clone().invert());
  // Ground is y = 0 and the car origin is comY above it, so this converts a
  // local height back to a height above the road — which is what `style` uses.
  const toGround = (y) => y + v.spec.comY;

  const rootY = toGround(local.y);
  const hipY = rootY + SEATED.hips;
  const headY = rootY + SEATED.head;
  const crownY = rootY + SEATED.crown;
  /** Sole of the shoe: the foot IK target in `_poseDriving`. */
  const feetY = rootY + SEATED.sole;
  const roofY = st.roofY;
  const sillY = st.sillY ?? 0.3;
  const anchorY = toGround(anchor.local.y);
  const planErr = Math.hypot(local.x - anchor.local.x, local.z - anchor.local.z);

  if (VERBOSE) {
    console.log(`  [${type}] root ${f2(rootY)}  hip ${f2(hipY)}  head ${f2(headY)} ` +
      `(anchor ${f2(anchorY)})  crown ${f2(crownY)}  sill ${f2(sillY)}  roof ${f2(roofY)}  ` +
      `planErr ${f2(planErr)}`);
  }

  // The contract with `vehicles`: the anchor is where the driver's head goes.
  rec(type, 'head lands on the seat anchor', Math.abs(headY - anchorY) < 0.05,
    `head ${f2(headY)} m vs anchor ${f2(anchorY)} m`);
  if (v.spec.kind === 'car') {
    // ...which is the same statement as "not sitting on the roof", but measured
    // against the bodywork rather than against our own arithmetic.
    rec(type, 'body is IN the cabin, not on the roof', crownY < roofY,
      `crown ${f2(crownY)} m vs roof ${f2(roofY)} m`);
    rec(type, 'head is above the door sill, looking out', headY > sillY,
      `head ${f2(headY)} m vs sill ${f2(sillY)} m`);
    // The other end of the same body. Sink the root and the shoes hang out
    // under the rocker panel, which is exactly as broken as standing on the
    // roof and is only visible from a low angle — so it gets a number.
    rec(type, 'feet are inside the floor pan', feetY > st.groundY,
      `sole ${f2(feetY)} m vs floor ${f2(st.groundY)} m`);
  } else {
    // A bike has no cabin and the rider is SUPPOSED to be proud of it
    // (CONTROLS.md: "bikes keep the rider visible"). What must be true is that
    // he is ON the machine — hips at the saddle, not standing on it or buried
    // in the engine.
    const saddleY = v.spec.style.seatY ?? v.spec.style.deckY ?? 0.5;
    rec(type, 'rider sits ON the machine', hipY > saddleY - 0.22 && hipY < saddleY + 0.55,
      `hip ${f2(hipY)} m vs saddle/deck ${f2(saddleY)} m`);
  }
  rec(type, 'body is over the seat in plan', planErr < 0.25,
    `${f2(planErr)} m from the anchor in XZ`);

  // FACING. The one that reads as "sitting backwards".
  const bf = bodyForward(rig.m);
  const cf = carForward(v);
  const dot = bf.dot(cf);
  const deg = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
  rec(type, 'body faces the way the car faces', dot > 0.99,
    `${f2(deg)} deg apart (dot ${f2(dot)})`);

  // ...and it must stay true once the car is moving and yawing, which is the
  // case the "re-composed each frame" rewrite exists for.
  // Where the root belongs, in the car's frame: the head anchor, dropped by the
  // seated head height. Same arithmetic `_resolveAnchors` does.
  const rootLocal = anchor.local.clone();
  rootLocal.y -= GAIT.seat.headHeight * (rig.m.bodyScale ?? 1);

  rig.input.press('forward');
  rig.input.press('right');
  let worstDeg = 0;
  let worstSeat = 0;
  frames(rig, 60 * 4, () => {
    const d = bodyForward(rig.m).dot(carForward(v));
    worstDeg = Math.max(worstDeg, (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI);
    const l = rig.m.position.clone().sub(v.position).applyQuaternion(v.quaternion.clone().invert());
    worstSeat = Math.max(worstSeat, l.distanceTo(rootLocal));
  });
  rig.input.clear();
  // A bike BANKS, and the seated transform carries a yaw and no roll, so the
  // yaw extracted from a rolled quaternion wanders a few degrees. That is a
  // known gap (the rider does not lean with the machine yet), not the 180 this
  // test exists to catch, so it gets a looser bound rather than a false pass.
  const facingTol = v.spec.kind === 'car' ? 6 : 12;
  rec(type, 'facing holds through a turn', worstDeg < facingTol,
    `worst ${f2(worstDeg)} deg over 4 s of cornering (limit ${facingTol})`);
  rec(type, 'body rides the car through a turn', worstSeat < 0.45,
    `worst ${f2(worstSeat)} m from the seat anchor`);
}

/**
 * WHAT THE PLAYER SEES. The car can be doing everything right and the game can
 * still be unplayable: park the chase camera in FRONT of the car and holding W
 * drives it at the lens, which reads as reverse — which is exactly how it was
 * seen. Neither the car's own numbers nor the body's transform can catch that, so the
 * real `CameraRig` is solved here and asked where it ended up.
 */
function testChaseCamera(type) {
  const rig = makeRig(type);
  if (!seatThePlayer(rig)) return;
  const v = rig.v;
  const cf = carForward(v);

  /**
   * The bonnet view is bolted to the car, so it is the sharpest statement of
   * the same +Z convention: it must sit over the NOSE. Measured AT REST, on
   * purpose — `CHASE.followTau` gives the pivot no velocity feed-forward, so at
   * 25 m/s it legitimately trails the target by ~2 m and the reading would be
   * about the follow lag rather than about which end of the car it is on.
   */
  rig.cam.setView('near');
  frames(rig, 60 * 4);
  const bonnetAhead = rig.cam.position.clone().sub(v.position).dot(cf);
  rec(type, 'bonnet view is over the nose', bonnetAhead > 0.2,
    `${f2(bonnetAhead)} m ahead of the car centre, at rest`);
  rig.cam.setView('chase');
  frames(rig, 60 * 2);

  rig.input.press('forward');
  frames(rig, 60 * 3);

  // Car -> camera. Behind the car means this points AGAINST the nose.
  const toCam = rig.cam.position.clone().sub(v.position);
  toCam.y = 0;
  const behind = toCam.normalize().dot(cf);
  rec(type, 'chase camera sits BEHIND the car', behind < -0.75,
    `car->camera . nose = ${f2(behind)} (want < -0.75; +1 is dead in front)`);

  // ...and looks the way the car is going, so W scrolls the world toward you.
  const look = rig.cam.forward.clone();
  look.y = 0;
  const looking = look.normalize().dot(cf);
  rec(type, 'chase camera looks where the car is going', looking > 0.75,
    `camera fwd . nose = ${f2(looking)}`);

  // The screen-space truth: driving forward must take the car AWAY from the
  // lens along the view axis, not into it.
  const d0 = rig.cam.position.distanceTo(v.position);
  const p0 = v.position.clone();
  frames(rig, 30);
  const moved = v.position.clone().sub(p0);
  const intoScreen = moved.dot(rig.cam.forward);
  rec(type, 'W carries the car INTO the screen', intoScreen > 0.5,
    `${f2(intoScreen)} m along the view axis in 0.5 s ` +
    `(forwardSpeed ${f2(v.forwardSpeed)} m/s)`);
  void d0;

  rig.input.clear();
}

/* ====================================================================== */

console.log(`\nDRIVING TEST — the player's own control path\n`);
for (const type of TYPES) {
  if (!VEHICLE_SPECS[type]) { console.log(`  (no spec "${type}")`); continue; }
  testPedals(type);
  testSeat(type);
  testChaseCamera(type);
}

let area = '';
const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  if (r.area !== area) { area = r.area; console.log(`\n--- ${area} ---`); }
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} checks pass\n`);
process.exit(pass === results.length ? 0 : 1);
