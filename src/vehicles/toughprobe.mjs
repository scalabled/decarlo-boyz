#!/usr/bin/env node
/**
 * HOW TOUGH IS A CAR? — the design question, as a gate.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS WHEN `damageprobe.mjs` ALREADY COUNTS ROUNDS
 * ---------------------------------------------------------------------------
 * It does, and its bands are so wide that they CANNOT SEE THE DEFECT THIS FILE
 * was written for. "One Nail Gun magazine wrecks a parked sedan, 0.05 to 1.0
 * magazines" is satisfied by 2 rounds and by 30. The build that shipped
 * needed 6 — 1.3 seconds of fire — and scored 8/8 on that section, because
 * every number in the band was still a number in the band.
 *
 * That is the rule-12 failure mode in its quiet form: not a gate that reads its
 * own input, but a gate whose threshold is so far from the thing being decided
 * that it reports a guarantee it never checked. A band is only a gate if a
 * build a player would reject falls outside it.
 *
 * So this file re-asks the same questions with the bands a designer would
 * actually defend, plus the half `damageprobe` has never had at all: **what
 * speed can you hit something at and drive away**.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT IS ASSERTED
 * ---------------------------------------------------------------------------
 * Nothing here reads `ACTOR_TO_VEHICLE`, `BLAST_TRANSFER`, `CRASH_KILL_DV`,
 * `body.hp` or `crumple`. Every number asserted is an EMITTED one:
 *
 *   - rounds to flip `v.destroyed`, fired through the real `VehicleHitTest`
 *     ray/OBB solve at a real `Vehicle`, with the weapon damage coming from
 *     `src/weapons/lib.js` — a table owned by a different subsystem, so a round
 *     count is a ratio between two independently owned files;
 *   - SECONDS OF CONTINUOUS FIRE, which is the unit the player actually
 *     experiences, computed from the weapon's own `rate`;
 *   - health lost in ONE collision, measured by driving a real `Vehicle` into a
 *     real wall through the real `Vehicle._collide` and
 *     `VehicleSystem.reportCollision`. Nothing synthesises an impulse: the
 *     probe sets a road speed and lets the solver decide what the crash was
 *     worth.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROL — measured, both arms
 * ---------------------------------------------------------------------------
 * There is no `--break` flag; revert for real. Two one-line reverts, each of
 * which turns a different section red, and the numbers they produce:
 *
 *   vehicles/index.js   `ACTOR_TO_VEHICLE = 10` (and `BLAST_TRANSFER = 1.0`)
 *       9/16, BULLETS 1/7. Sedan 6 rounds / 1.3 s of fire (want 15-40 / 2-12),
 *       cruiser 10, Millhand 21, Steelhauler 24, Slagbolt 3. CRASH untouched,
 *       which is the point: the two halves are independent.
 *   vehicles/damage.js  `impact()` back to `(impulse/mass) * 24 * crumple`
 *                       with the absolute point thresholds
 *       8/16, CRASH 1/7 and CHAIN 0/2. A 50 km/h wall hit takes 35.7% of a
 *       sedan, THREE of them write it off and it detonates, a 30 km/h prang
 *       takes 20.8%, a bicycle loses 45% — the cap — bumping a kerb at 20, and
 *       60 vs 100 km/h cost 43.1% and 45.0% because the curve has saturated.
 *       BULLETS untouched.
 *
 *   node src/vehicles/toughprobe.mjs [--verbose]
 */

import * as THREE from 'three';
import { VEHICLE_SPECS, finalizeSpec, SURFACE_GRIP } from './specs.js';
import { Vehicle } from './dynamics.js';
import { DamageModel } from './damage.js';
import { VehicleSystem } from './index.js';
import { VehicleHitTest } from '../weapons/vehiclehit.js';
import { ALL_WEAPONS } from '../weapons/lib.js';
import { Rng } from '../core/rng.js';

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
/* A headless world: a flat plane, and one wall to drive into.         */
/* ------------------------------------------------------------------ */

const DT = 1 / 120;
const WALL_Z = 40;
let wallOn = true;

const HIT = {
  hit: true, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
  distance: 0, surface: 'asphalt', object: null,
};
/** The shape `physics.staticWorld.contacts` has (`src/physics/bvh.js`). */
const CTS = {
  count: 0, capacity: 8,
  nx: new Float32Array(8), ny: new Float32Array(8), nz: new Float32Array(8),
  px: new Float32Array(8), py: new Float32Array(8), pz: new Float32Array(8),
  depth: new Float32Array(8), s: new Float32Array(8), tri: new Int32Array(8),
};
const staticWorld = {
  contacts: CTS,
  objectOf: () => null,
  /** One vertical face at z = WALL_Z, outward normal -Z. */
  overlapCapsule(x, y, z, _x1, _y1, _z1, r) {
    CTS.count = 0;
    const d = WALL_Z - z;
    if (!wallOn || d >= r || d < -2) return 0;
    CTS.nx[0] = 0; CTS.ny[0] = 0; CTS.nz[0] = -1;
    CTS.px[0] = x; CTS.py[0] = y; CTS.pz[0] = WALL_Z;
    CTS.depth[0] = r - d;
    CTS.s[0] = 0; CTS.tri[0] = 0;
    CTS.count = 1;
    return 1;
  },
};
const NOOP = () => {};
const physics = {
  MASK: { WORLD: 3 }, SURFACE: {}, staticWorld,
  spawnDebris: NOOP, emitImpact: NOOP,
  groundHeight: () => 0,
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
const MATS = {
  paint: () => ({ dispose: NOOP }),
  glass: () => ({ clone: () => ({ color: { set: NOOP } }), dispose: NOOP }),
  cracksTexture: () => null,
};

function makeCtx() {
  const listeners = new Map();
  const ctx = {
    time: { elapsed: 0 },
    events: {
      on(k, fn) { if (!listeners.has(k)) listeners.set(k, []); listeners.get(k).push(fn); return NOOP; },
      off: NOOP,
      emit(k, p) { const l = listeners.get(k); if (l) for (const fn of l.slice()) fn(p); },
    },
    peek: (id) => (id === 'vehicles' ? ctx._veh : null),
    get: (id) => ctx.peek(id),
    _veh: null,
  };
  return ctx;
}

/**
 * A `VehicleSystem` that is REAL on every path under test — `damage` and
 * `reportCollision` are the production methods called on this object — and
 * inert where the city would otherwise have to exist.
 */
function makeSystem(ctx) {
  const sys = {
    ctx, vehicles: [], rng: new Rng(20260728), mats: MATS, physics,
    lodOf: () => 0, surfaceAt: () => 'asphalt', waterHeightAt: () => null,
    gripOf: (n) => SURFACE_GRIP[n] ?? SURFACE_GRIP.asphalt,
    _world: () => null,
    damage: VehicleSystem.prototype.damage,
    _explosionDamage: VehicleSystem.prototype._explosionDamage,
    reportCollision: VehicleSystem.prototype.reportCollision,
    /**
     * The PUBLISHED field, taken off a real `VehicleSystem` instance rather
     * than from the module constant — `actorDamageScale` is a class field, so
     * it is not on the prototype, and this is the same object `weapons` reads
     * through `ctx.peek('vehicles')`. Harness plumbing: no assertion in this
     * file reads it.
     */
    actorDamageScale: new VehicleSystem().actorDamageScale,
  };
  ctx._veh = sys;
  ctx.events.on('explosion', (e) => sys._explosionDamage(e));
  return sys;
}

const stubModel = () => ({ root: null, wheels: [], panels: [], glassMeshes: [], lampMats: {}, paintMat: null });

let _seed = 1;
function spawn(sys, type, x = 0, z = 0) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(sys, spec, stubModel(), {});
  v.damage = new DamageModel(v, MATS, new Rng(_seed++));
  v.setPose(new THREE.Vector3(x, spec.comY, z), 0);
  sys.vehicles.push(v);
  return v;
}
function fresh(type) {
  const ctx = makeCtx();
  const sys = makeSystem(ctx);
  return { ctx, sys, v: spawn(sys, type) };
}

/* ================================================================== */
/* 1. HOW LONG DOES IT TAKE TO SHOOT A CAR OUT?                        */
/* ================================================================== */

const _from = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** Rounds of `weaponId` needed to flip `destroyed` on a fresh `type`. */
function roundsToWreck(type, weaponId, cap = 4000) {
  const def = ALL_WEAPONS[weaponId];
  const { ctx, v } = fresh(type);
  const cars = new VehicleHitTest(ctx);
  let n = 0;
  while (!v.destroyed && n < cap) {
    /* Square on to the driver's door, muzzle at chest height, so the real OBB
     * solve has to succeed for anything at all to happen. */
    _from.set(v.position.x - 5, v.position.y + 0.35, v.position.z);
    _dir.set(1, 0, 0);
    const hit = cars.cast(_from, _dir, 9);
    if (!hit) return { n: Infinity, miss: true, hp: v.maxHealth, secs: Infinity };
    cars.apply(hit.vehicle, def.damage, hit.point);
    n++;
  }
  return {
    n: v.destroyed ? n : Infinity,
    hp: v.maxHealth,
    /* What the player experiences: the trigger held down, at the weapon's own
     * cyclic rate. `rate` belongs to `weapons`. */
    secs: v.destroyed ? n * (def.rate ?? 0.2) : Infinity,
  };
}

/**
 * The bands are what a designer defends out loud, and BOTH edges have been
 * shipped and rejected: 6 rounds, where cars exploded at a touch, and 75, where
 * a 90-round magazine could not wreck a parked sedan. A band that admits either
 * is not a gate.
 *
 * type, weapon, min rounds, max rounds, min secs, max secs, prose
 */
const BULLET_CASES = [
  ['sedan', 'nailgun', 15, 40, 2.0, 12.0, 'a parked sedan takes most of a Nail Gun magazine, and several seconds'],
  ['sedan', 'smg', 18, 48, 2.0, 9.0, 'a parked sedan takes most of a Shop SMG magazine'],
  ['police', 'smg', 22, 60, 2.5, 12.0, 'a Precinct Cruiser takes about a magazine'],
  ['truck', 'smg', 55, 160, 4.5, 26.0, 'the Millhand 6 takes a couple of magazines'],
  ['bus', 'smg', 60, 190, 5.0, 30.0, 'the Steelhauler 30 takes more than the truck'],
  ['bike', 'nailgun', 5, 16, 1.0, 5.0, 'the Slagbolt goes down quickly, but not instantly'],
];

function testBullets() {
  for (const [type, wid, lo, hi, slo, shi, prose] of BULLET_CASES) {
    const r = roundsToWreck(type, wid);
    check('bullets', prose,
      r.n >= lo && r.n <= hi && r.secs >= slo && r.secs <= shi,
      `${r.n === Infinity ? (r.miss ? 'passed through' : 'never') : r.n} rounds ` +
      `(want ${lo}-${hi}), ${Number.isFinite(r.secs) ? r.secs.toFixed(1) : 'inf'} s ` +
      `of fire (want ${slo}-${shi}), ${r.hp} hp`);
  }

  /* A wreck must still be REACHABLE with the weapon in your hands. If a class
   * ever became bullet-proof this is what says so. */
  {
    const r = roundsToWreck('bus', 'smg');
    check('bullets', 'no class is bullet-proof — the toughest body still goes down to an SMG',
      Number.isFinite(r.n), `${r.n} rounds`);
  }
}

/* ================================================================== */
/* 2. WHAT SPEED CAN YOU HIT SOMETHING AT AND DRIVE AWAY?              */
/* ================================================================== */

/**
 * Roll a real `Vehicle` into a wall at `kmh` and report what the crash cost.
 *
 * The impulse is the SOLVER'S — `Vehicle._collide` decides what the crash was
 * worth from the contact it finds and the body's own inertia, and
 * `VehicleSystem.reportCollision` hands that to the production
 * `DamageModel.impact`. This function only sets up a car rolling at a road
 * speed, and it reports the speed it actually had when it arrived.
 *
 * `hits` repeats it on the SAME car, because the complaint is cumulative: a
 * city drive is a series of shunts and the car has to still be a car after
 * them. The car is re-launched rather than re-driven so that a bent wheel from
 * hit one cannot silently turn hit three into a 5 km/h nudge.
 */
function wallHit(type, kmh, hits = 1) {
  const ctx = makeCtx();
  const sys = makeSystem(ctx);
  const v = spawn(sys, type);
  const target = kmh / 3.6;
  wallOn = false;
  for (let i = 0; i < 360; i++) {
    v.input.throttle = 0; v.input.brake = 1; v.input.steer = 0;
    v.fixedStep(DT, ctx);
  }
  const out = { kmh: [], lost: [], destroyed: false, booms: 0 };
  ctx.events.on('explosion', () => { out.booms++; });
  for (let h = 0; h < hits; h++) {
    wallOn = false;
    v.setPose(new THREE.Vector3(0, v.position.y, WALL_Z - 7), 0);
    v.velocity.set(0, 0, target);
    v.angularVelocity.set(0, 0, 0);
    /* Wheels rolling at road speed, so the tyres are neither dragging nor
     * spinning as it arrives. */
    for (const w of v.wheels) w.omega = target / w.hp.radius;
    v._impactCool = 0;
    wallOn = true;
    const before = v.health;
    let arrival = 0;
    for (let i = 0; i < 120 * 6; i++) {
      v.input.throttle = 0; v.input.brake = 0; v.input.steer = 0;
      if (v.health === before) arrival = v.forwardSpeed;
      ctx.time.elapsed += DT;
      v.fixedStep(DT, ctx);
      v.damage.update(DT, ctx);
    }
    out.kmh.push(arrival * 3.6);
    out.lost.push((before - v.health) / v.maxHealth);
    out.destroyed = v.destroyed;
    if (v.destroyed) break;
  }
  /* Ten seconds of the real `DamageModel` clock afterwards, so a fuse that was
   * lit has time to burn through and EMIT. `FUSE_SECONDS` is 3.2. */
  wallOn = false;
  for (let i = 0; i < 600; i++) {
    ctx.time.elapsed += 1 / 60;
    v.damage.update(1 / 60, ctx);
  }
  wallOn = true;
  return out;
}

function testCrash() {
  /* 2a. THE HEADLINE. A town-centre shunt is a dent, not a third of the car. */
  {
    const r = wallHit('sedan', 50);
    const pct = r.lost[0] * 100;
    check('crash', 'a 50 km/h wall hit dents a sedan — it does not take a third of it',
      !r.destroyed && pct >= 12 && pct <= 25 && r.kmh[0] > 50 * 0.9,
      `${pct.toFixed(1)}% lost, arrived at ${r.kmh[0].toFixed(0)} km/h (want 12-25%), destroyed ${r.destroyed}`);
  }
  {
    const r = wallHit('sedan', 30);
    const pct = r.lost[0] * 100;
    check('crash', 'a 30 km/h prang is cheap',
      !r.destroyed && pct <= 15 && r.kmh[0] > 30 * 0.9,
      `${pct.toFixed(1)}% lost, arrived at ${r.kmh[0].toFixed(0)} km/h (want <= 15%)`);
  }

  /* 2b. AND YOU CAN DO IT AGAIN. The complaint is cumulative: a city drive is
   * a series of shunts, and the car has to still be a car afterwards. */
  {
    const r = wallHit('sedan', 50, 4);
    check('crash', 'a sedan survives four 50 km/h wall hits and is still driveable',
      !r.destroyed && r.lost.length === 4 && r.kmh.every((k) => k > 50 * 0.9),
      `${r.lost.length} hits at ${r.kmh.map((k) => k.toFixed(0)).join('/')} km/h, lost ` +
      `${r.lost.map((x) => (x * 100).toFixed(0) + '%').join(' ')}, destroyed ${r.destroyed}`);
  }

  /* 2c. THE CURVE MUST STILL BE A CURVE. The old one saturated the 45% cap by
   * 80 km/h, so a town prang and a motorway shunt cost exactly the same and
   * there was no such thing as "too fast". */
  {
    const a = wallHit('sedan', 60).lost[0];
    const b = wallHit('sedan', 100).lost[0];
    check('crash', 'hitting it harder costs more, all the way up',
      b > a * 1.3,
      `60 km/h ${(a * 100).toFixed(1)}%, 100 km/h ${(b * 100).toFixed(1)}% ` +
      `(want the fast one at least 1.3x the slow one)`);
  }

  /* 2d. CLASS SANITY, which the old absolute-points form did not have at all.
   * A bicycle is not a car, but rolling into a kerb is not a write-off; a bus
   * is not a bicycle, but it is not a bunker either. */
  {
    const r = wallHit('bicycle', 20);
    const pct = r.lost[0] * 100;
    check('crash', 'a bicycle bumping a kerb at 20 km/h is not half-destroyed',
      pct <= 25, `${pct.toFixed(1)}% lost (want <= 25)`);
  }
  {
    const r = wallHit('bus', 50);
    const pct = r.lost[0] * 100;
    check('crash', 'a bus is damageable — 50 km/h into a wall is not free',
      pct >= 6, `${pct.toFixed(1)}% lost (want >= 6)`);
  }
  /* ...and the spread still runs the right way round. */
  {
    const sedan = wallHit('sedan', 50).lost[0];
    const truck = wallHit('truck', 50).lost[0];
    check('crash', 'the same crash hurts a sedan more than it hurts a truck',
      sedan > truck * 1.4,
      `sedan ${(sedan * 100).toFixed(1)}%, truck ${(truck * 100).toFixed(1)}%`);
  }
}

/* ================================================================== */
/* 3. ...AND IT MUST NOT BECOME A FIREWORKS DISPLAY                    */
/* ================================================================== */

function testChain() {
  /* The player's word was "explode". A car crashed repeatedly at city speed
   * must not end the drive as a fireball, and what is counted is the EMITTED
   * `explosion` event on `DamageModel`'s own clock — `wallHit` runs ten more
   * seconds of that clock after the last shunt so a lit fuse has time to go
   * off, and it listens on the SAME ctx the crashes happened on. */
  const r = wallHit('sedan', 50, 3);
  check('chain', 'three ordinary city crashes do not end in an explosion',
    !r.destroyed && r.booms === 0,
    `destroyed ${r.destroyed}, ${r.booms} explosions, lost ` +
    `${r.lost.map((x) => (x * 100).toFixed(0) + '%').join(' ')}`);

  /* ...and the gate must be able to SEE an explosion, or the check above is
   * satisfied by a listener that never fires. Same route, fast enough that the
   * car really is written off. */
  const hard = wallHit('sedan', 130, 6);
  check('chain', 'the counter is live: enough crashes DO end in an explosion',
    hard.destroyed && hard.booms === 1,
    `destroyed ${hard.destroyed} after ${hard.lost.length} hits, ${hard.booms} explosions`);
}

/* ------------------------------------------------------------------ */

testBullets();
testCrash();
testChain();

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
console.log(`\nvehicle toughness: ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
