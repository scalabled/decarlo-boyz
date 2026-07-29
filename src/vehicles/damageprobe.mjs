#!/usr/bin/env node
/**
 * VEHICLE DAMAGE PROBE — "how many rounds does that car take?", as a gate.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Vehicle bodies are priced on a 90-3000 HP scale (`specs.js` `body.hp`).
 * COLLISION damage was derived against that scale; every other damage source in
 * the game is authored against the ~100 HP actor scale and was wired
 * straight through without converting. One ratio, wrong by ten, and it broke
 * three features at once:
 *
 *   - a Nail Gun needed 75 nails and 16.5 s of continuous fire to wreck a
 *     parked sedan,
 *   - all seven Scrap Rockets fired point blank left the sedan alive (11
 *     measured to wreck one),
 *   - a wrecked car did 0% of its neighbour's health — and separately, the
 *     wreck's own `explosion` event was unreachable code that had never once
 *     been emitted.
 *
 * ...and melee never had a vehicle path at all.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT THIS MEASURES, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 * Nothing here asserts against `ACTOR_TO_VEHICLE`, `BULLET_TRANSFER`,
 * `MELEE_TRANSFER`, `WRECK_BLAST_DAMAGE` or `body.hp`. Comparing a tuned
 * constant to itself is the circular gate this project has already shipped
 * several times.
 *
 * What is asserted is the OUTCOME a player and a designer both experience:
 *
 *   - how many ROUNDS of a real weapon, fired through the real
 *     `VehicleHitTest` ray/OBB solve at a real `Vehicle`, flip `v.destroyed`;
 *   - how many SWINGS of the real Body Wrench do;
 *   - how many ROCKETS, delivered through the real `explosion` event into the
 *     real `_explosionDamage`;
 *   - and whether a wrecked car's own blast — emitted by `DamageModel.update`
 *     on its own clock, never synthesised here — takes its neighbour with it.
 *
 * Weapon damage comes from `src/weapons/lib.js`, a table owned by a different
 * subsystem, so the round counts are a ratio between two independently
 * owned tables rather than an echo of one of them. Halving both the HP scale
 * and every damage source would leave every number in this file unchanged —
 * which is exactly right, because the ratio IS the feature.
 *
 * The thresholds are BANDS a designer would recognise ("a magazine wrecks a
 * sedan", "two rockets"), not the exact counts today's constants produce, so a
 * re-tune inside the band does not churn the gate.
 *
 *   node src/vehicles/damageprobe.mjs
 *   node src/vehicles/damageprobe.mjs --verbose
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROL — a gate nobody has seen fail is not a gate
 * ---------------------------------------------------------------------------
 * There is deliberately NO `--break` flag. A flag that emulates the old
 * behaviour is one more thing that can agree with the code by accident; revert
 * the fix for real and watch it go red. The four one-line reverts, each of
 * which turns a different section red:
 *
 *   weapons/vehiclehit.js   BULLET_TRANSFER 0.8  -> 0.075   (bullets: 6/7)
 *   weapons/vehiclehit.js   `sweep()` -> `return 0`         (melee:   1/7)
 *   vehicles/index.js       damage line -> `* f * 0.5`      (blast:   0/6,
 *                                                            chain:   1/4)
 *   vehicles/damage.js      fuse guard -> `v.burning < 1`   (chain:   1/4)
 */

import * as THREE from 'three';
import { VEHICLE_SPECS, finalizeSpec } from './specs.js';
import { Vehicle } from './dynamics.js';
import { VehicleSystem, ACTOR_TO_VEHICLE } from './index.js';
import { DamageModel } from './damage.js';
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
/* A headless world just rich enough for the real classes to run in.   */
/* ------------------------------------------------------------------ */

const NOOP = () => {};
const STUB_MATS = {
  paint: () => ({ dispose: NOOP }),
  glass: () => ({ clone: () => ({ color: { set: NOOP } }), dispose: NOOP }),
  cracksTexture: () => null,
};

function makeCtx() {
  const listeners = new Map();
  const ctx = {
    time: { elapsed: 0 },
    events: {
      on(k, fn) {
        if (!listeners.has(k)) listeners.set(k, []);
        listeners.get(k).push(fn);
        return NOOP;
      },
      off: NOOP,
      emit(k, p) {
        const l = listeners.get(k);
        if (l) for (const fn of l.slice()) fn(p);
      },
    },
    peek: (id) => (id === 'vehicles' ? ctx._veh : null),
    get: (id) => ctx.peek(id),
    _veh: null,
  };
  return ctx;
}

function stubModel() {
  return { root: null, wheels: [], panels: [], glassMeshes: [], lampMats: {}, paintMat: null };
}

/**
 * A `VehicleSystem` that is REAL where it matters — `damage` and
 * `_explosionDamage` are the production methods, called on this object, and
 * `actorDamageScale` is the production field — and inert where the city would
 * otherwise have to exist. Nothing about the damage arithmetic is re-stated.
 */
function makeSystem(ctx) {
  const sys = {
    ctx,
    vehicles: [],
    rng: new Rng(20260728),
    mats: STUB_MATS,
    physics: { MASK: { WORLD: 3 }, SURFACE: {}, spawnDebris: NOOP, emitImpact: NOOP },
    lodOf: () => 0,
    surfaceAt: () => 'asphalt',
    waterHeightAt: () => null,
    gripOf: () => ({ mu: 1, roll: 1, drag: 0, noise: 0, skid: 1, dust: 0 }),
    _world: () => null,
    /* The production field. `actorDamageScale` is a class field, so it is not
     * on the prototype and has to be taken from the constant it is set from —
     * harness plumbing only; no assertion in this file reads it. */
    actorDamageScale: ACTOR_TO_VEHICLE,
    damage: VehicleSystem.prototype.damage,
    _explosionDamage: VehicleSystem.prototype._explosionDamage,
  };
  ctx._veh = sys;
  ctx.events.on('explosion', (e) => sys._explosionDamage(e));
  return sys;
}

let _seed = 1;
function spawn(sys, type, x = 0, z = 0, yaw = 0) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(sys, spec, stubModel(), {});
  v.damage = new DamageModel(v, STUB_MATS, new Rng(_seed++));
  v.setPose(new THREE.Vector3(x, spec.comY, z), yaw);
  sys.vehicles.push(v);
  return v;
}

function fresh(type, opts = {}) {
  const ctx = makeCtx();
  const sys = makeSystem(ctx);
  const v = spawn(sys, type, 0, 0, opts.yaw ?? 0);
  return { ctx, sys, v };
}

/* ------------------------------------------------------------------ */
/* 1. BULLETS — through the real ray/OBB solve.                        */
/* ------------------------------------------------------------------ */

const _from = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * Fire one round of `def` at the driver's door of `v` through the REAL
 * `VehicleHitTest`. Returns the damage the vehicle actually took, measured as
 * the drop in its own health — never as the number handed to `apply`.
 */
function fireOne(cars, v, def, standoff = 5) {
  /* Square on to the flank, muzzle at chest height, so the OBB solve has to
   * succeed for anything at all to happen. */
  _from.set(v.position.x - standoff, v.position.y + 0.35, v.position.z);
  _dir.set(1, 0, 0);
  const hit = cars.cast(_from, _dir, standoff + 4);
  if (!hit) return { hit: false, dealt: 0 };
  const before = v.health;
  cars.apply(hit.vehicle, def.damage, hit.point);
  return { hit: true, dealt: before - v.health };
}

/** Rounds of `weaponId` needed to flip `destroyed` on a fresh `type`. */
function roundsToWreck(type, weaponId, cap = 4000) {
  const def = ALL_WEAPONS[weaponId];
  const { ctx, v } = fresh(type);
  const cars = new VehicleHitTest(ctx);
  let n = 0;
  while (!v.destroyed && n < cap) {
    if (!fireOne(cars, v, def).hit) return { n: Infinity, hp: v.maxHealth, miss: true };
    n++;
  }
  return { n: v.destroyed ? n : Infinity, hp: v.maxHealth };
}

/**
 * A magazine is the unit a player actually feels. `magSize` is the weapon's
 * own, read from the weapons table, so these read as sentences.
 */
const BULLET_CASES = [
  // type,   weapon,   min mags, max mags, prose
  ['sedan', 'nailgun', 0.05, 1.0, 'one Nail Gun magazine wrecks a parked sedan'],
  ['sedan', 'smg', 0.05, 1.0, 'one Shop SMG magazine wrecks a parked sedan'],
  ['police', 'smg', 0.05, 1.2, 'about a magazine wrecks a Precinct Cruiser'],
  ['truck', 'smg', 0.3, 3.0, 'the Millhand 6 takes one to three SMG magazines'],
  ['bus', 'smg', 0.3, 3.5, 'the Steelhauler 30 takes one to four SMG magazines'],
  ['bike', 'nailgun', 0.03, 0.5, 'half a Nail Gun magazine drops the Slagbolt'],
];

function testBullets() {
  const counts = {};
  for (const [type, wid, lo, hi, prose] of BULLET_CASES) {
    const def = ALL_WEAPONS[wid];
    const r = roundsToWreck(type, wid);
    counts[type + ':' + wid] = r.n;
    const mags = r.n / def.magSize;
    check('bullets', prose,
      r.n !== Infinity && mags >= lo && mags <= hi,
      `${r.n === Infinity ? (r.miss ? 'passed through' : 'never') : r.n} rounds = ` +
      `${Number.isFinite(mags) ? mags.toFixed(2) : 'inf'} mag (want ${lo}-${hi}), ${r.hp} hp`);
  }

  /* A round must connect AND move the health. The pass-through this whole file
   * exists for reads as `hit: false, dealt: 0`. */
  {
    const { ctx, v } = fresh('sedan');
    const cars = new VehicleHitTest(ctx);
    const r = fireOne(cars, v, ALL_WEAPONS.nailgun);
    check('bullets', 'a nail connects with a parked sedan and takes health off it',
      r.hit && r.dealt > 0, `hit ${r.hit}, dealt ${r.dealt.toFixed(1)}`);
  }

  /* PER-CLASS DURABILITY SPREAD. The point of `body.hp` varying is that a bus
   * is not a sedan; a re-scale that flattened it would be a regression even if
   * every band above still passed. */
  const sedan = counts['sedan:smg'];
  const truck = counts['truck:smg'];
  const bus = counts['bus:smg'];
  check('bullets', 'the per-class durability spread survives (bus > truck > 1.8x sedan)',
    bus > truck && truck > sedan * 1.8,
    `sedan ${sedan}, truck ${truck}, bus ${bus} rounds`);
}

/* ------------------------------------------------------------------ */
/* 2. MELEE                                                            */
/* ------------------------------------------------------------------ */

/** A swing origin at chest height, `d` metres off the driver's door. */
function stance(v, d) {
  return {
    org: new THREE.Vector3(v.position.x - d, v.position.y + 0.5, v.position.z),
    fwd: new THREE.Vector3(1, 0, 0),
  };
}

/** Swings of `weaponId` needed to flip `destroyed` on a fresh `type`. */
function swingsToWreck(type, weaponId, cap = 400) {
  const def = ALL_WEAPONS[weaponId];
  const { ctx, v } = fresh(type);
  const cars = new VehicleHitTest(ctx);
  const { org, fwd } = stance(v, 1.6);
  let n = 0;
  while (!v.destroyed && n < cap) {
    if (cars.sweep(org, fwd, def, 1) <= 0) return { n: Infinity, hp: v.maxHealth, whiff: true };
    n++;
  }
  return { n: v.destroyed ? n : Infinity, hp: v.maxHealth };
}

function testMelee() {
  {
    const { ctx, v } = fresh('sedan');
    const cars = new VehicleHitTest(ctx);
    const { org, fwd } = stance(v, 1.6);
    const before = v.health;
    const dealt = cars.sweep(org, fwd, ALL_WEAPONS.wrench, 1);
    check('melee', 'a Body Wrench swing damages the car it passes through',
      dealt > 0 && v.health < before,
      `dealt ${dealt.toFixed(1)}, health ${before.toFixed(0)} -> ${v.health.toFixed(0)}`);
    check('melee', 'the swing leaves a dent in the panel, not just a number',
      v.damage.deformed === true,
      `deformed ${v.damage.deformed}`);
  }

  /* Bands, in swings. Slower than a magazine, faster than never — a swing into
   * a car lands `w.dmg * 0.5`. */
  const MELEE_CASES = [
    ['sedan', 'wrench', 4, 40, 'a sedan goes down to a handful of Body Wrench swings'],
    ['sedan', 'fists', 8, 90, 'bare fists take twice as long as the wrench, but get there'],
    ['bike', 'wrench', 1, 20, 'the Slagbolt goes down to a swing or three'],
  ];
  const swings = {};
  for (const [type, wid, lo, hi, prose] of MELEE_CASES) {
    const r = swingsToWreck(type, wid);
    swings[type + ':' + wid] = r.n;
    check('melee', prose,
      r.n >= lo && r.n <= hi,
      `${r.n === Infinity ? (r.whiff ? 'whiffed' : 'never') : r.n} swings ` +
      `(want ${lo}-${hi}), ${r.hp} hp`);
  }
  check('melee', 'the wrench is a better car-opener than a fist',
    swings['sedan:wrench'] < swings['sedan:fists'],
    `wrench ${swings['sedan:wrench']}, fists ${swings['sedan:fists']}`);

  /* And melee must not out-perform the explosive that costs $110 a shot. */
  {
    const { ctx, v } = fresh('sedan');
    const cars = new VehicleHitTest(ctx);
    const { org, fwd } = stance(v, 1.6);
    const swing = cars.sweep(org, fwd, ALL_WEAPONS.wrench, 1);
    const { ctx: c2, v: v2 } = fresh('sedan');
    const b2 = v2.health;
    c2.events.emit('explosion', {
      position: new THREE.Vector3(v2.position.x + 1.2, v2.position.y, v2.position.z),
      radius: ALL_WEAPONS.rocket.splash, damage: ALL_WEAPONS.rocket.damage,
    });
    const rocket = b2 - v2.health;
    check('melee', 'one wrench swing is worth far less than one Scrap Rocket',
      swing * 4 < rocket, `swing ${swing.toFixed(0)}, rocket ${rocket.toFixed(0)}`);
  }

  /* A swing must not reach down the street... */
  {
    const { ctx, v } = fresh('sedan');
    const cars = new VehicleHitTest(ctx);
    const { org, fwd } = stance(v, 9);
    check('melee', 'a wrench does not reach a car nine metres away',
      cars.sweep(org, fwd, ALL_WEAPONS.wrench, 1) === 0, 'dealt 0 at 9 m');
  }
  /* ...nor round the back of the swinger's head. */
  {
    const { ctx, v } = fresh('sedan');
    const cars = new VehicleHitTest(ctx);
    const { org } = stance(v, 1.6);
    const away = new THREE.Vector3(-1, 0, 0);
    check('melee', 'a wrench swung the other way hits nothing',
      cars.sweep(org, away, ALL_WEAPONS.wrench, 1) === 0, 'dealt 0 facing away');
  }
  /* ...and must not hit the car the swinger is sitting in. */
  {
    const { ctx, v } = fresh('sedan');
    const cars = new VehicleHitTest(ctx);
    const inside = new THREE.Vector3(v.position.x, v.position.y + 0.3, v.position.z);
    const fwd = new THREE.Vector3(1, 0, 0);
    check('melee', 'a swing from inside a car does not damage that car',
      cars.sweep(inside, fwd, ALL_WEAPONS.wrench, 1) === 0, 'dealt 0 from the driver seat');
  }
}

/* ------------------------------------------------------------------ */
/* 3. EXPLOSIVES — through the real `explosion` event.                 */
/* ------------------------------------------------------------------ */

function blastsToWreck(type, weaponId, dist = 1.2, cap = 60) {
  const def = ALL_WEAPONS[weaponId];
  const { ctx, v } = fresh(type);
  let n = 0;
  while (!v.destroyed && n < cap) {
    /* Past the refractory window; the damage path is what is under test. */
    ctx.time.elapsed += 5;
    ctx.events.emit('explosion', {
      position: new THREE.Vector3(v.position.x + dist, v.position.y, v.position.z),
      radius: def.splash > 0 ? def.splash : 6,
      damage: def.damage,
    });
    v.velocity.set(0, 0, 0);
    v.angularVelocity.set(0, 0, 0);
    n++;
  }
  return { n: v.destroyed ? n : Infinity, hp: v.maxHealth };
}

const BLAST_CASES = [
  ['sedan', 'rocket', 1, 2, 'a Scrap Rocket wrecks a sedan in one or two'],
  ['police', 'rocket', 1, 2, 'a Scrap Rocket wrecks a Precinct Cruiser in one or two'],
  ['truck', 'rocket', 1, 4, 'the Millhand 6 takes up to four rockets'],
  ['bus', 'launcher', 1, 5, 'the Steelhauler 30 takes up to five nitro rounds'],
  ['sedan', 'depth', 1, 2, 'a Depth Charge wrecks a sedan in one or two'],
];

function testBlast() {
  for (const [type, wid, lo, hi, prose] of BLAST_CASES) {
    const r = blastsToWreck(type, wid);
    check('blast', prose,
      r.n >= lo && r.n <= hi,
      `${r.n === Infinity ? 'never' : r.n} (want ${lo}-${hi}), ${r.hp} hp`);
  }

  /* Falloff must be real: the same rocket well outside its splash must not
   * scratch it. Without this, "one rocket wrecks a sedan" could be satisfied by
   * a blast with no falloff at all. */
  {
    const def = ALL_WEAPONS.rocket;
    const { ctx, v } = fresh('sedan');
    const before = v.health;
    ctx.events.emit('explosion', {
      position: new THREE.Vector3(v.position.x + def.splash * 2.5, v.position.y, v.position.z),
      radius: def.splash,
      damage: def.damage,
    });
    check('blast', 'a rocket well outside its own splash does nothing to a car',
      v.health === before, `health ${before.toFixed(0)} -> ${v.health.toFixed(0)}`);
  }
}

/* ------------------------------------------------------------------ */
/* 4. CHAIN DETONATION                                                 */
/* ------------------------------------------------------------------ */

/** Two cars side by side in adjacent parking bays: centres 2.8 m apart. */
const BAY = 2.8;

/** Burn every wreck in `row` on the real `DamageModel` clock for `seconds`. */
function burn(ctx, row, seconds) {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    ctx.time.elapsed += dt;
    for (const v of row) {
      /* `Vehicle._postStep` owns this ramp; reproduced here because the probe
       * does not step the dynamics. Same rate, same source. */
      if (v.destroyed) v.burning = Math.min(1, v.burning + dt * 0.35);
      v.damage.update(dt, ctx);
    }
  }
}

function testChain() {
  /* 4a. THE EVENT MUST ACTUALLY BE EMITTED. It never was: `burning` saturates
   * at 1 after 2.857 s and the old guard `burning < 1` closed the window before
   * the 3.2 s fuse could elapse. Measured on the shipped code, after 60 s of
   * burning: `_acc 2.800, explosions emitted 0`. */
  {
    const ctx = makeCtx();
    const sys = makeSystem(ctx);
    const a = spawn(sys, 'sedan', 0, 0);
    let booms = 0;
    ctx.events.on('explosion', () => booms++);
    a.health = 0;
    sys.damage(a, 1, null);
    burn(ctx, [a], 60);
    check('chain', 'a wrecked car eventually goes up, exactly once',
      booms === 1, `${booms} explosions in 60 s of burning`);
  }

  /* 4b. A healthy neighbour takes a real bite. Reference: `hurtAround(x, z, 7,
   * 55)` into 100 HP cars — 55% at the centre, ~41% at a bay's spacing. Before
   * this fix it was 0%, because the blast never happened at all. */
  {
    const ctx = makeCtx();
    const sys = makeSystem(ctx);
    const a = spawn(sys, 'sedan', 0, 0);
    const b = spawn(sys, 'sedan', BAY, 0);
    const before = b.health;
    a.health = 0;
    sys.damage(a, 1, null);
    burn(ctx, [a], 20);
    const frac = (before - b.health) / b.maxHealth;
    check('chain', 'a wrecked car takes a serious bite out of the car parked beside it',
      frac >= 0.25 && frac <= 0.75,
      `neighbour lost ${(frac * 100).toFixed(1)}% of its health (want 25-75%)`);
  }

  /* 4c. ...and a neighbour that has already been shot up goes with it. THIS is
   * the feature: `damage.js` has emitted this event since it was written and it
   * had never once destroyed anything. */
  {
    const ctx = makeCtx();
    const sys = makeSystem(ctx);
    const a = spawn(sys, 'sedan', 0, 0);
    const b = spawn(sys, 'sedan', BAY, 0);
    b.health = b.maxHealth * 0.3;
    a.health = 0;
    sys.damage(a, 1, null);
    burn(ctx, [a], 20);
    check('chain', 'a wrecked car detonates a neighbour that is already shot up',
      b.destroyed === true,
      `neighbour destroyed ${b.destroyed}, ${b.health.toFixed(0)} hp left`);
  }

  /* 4d. CONVERGENCE. The runaway this codebase already shipped once — a
   * fender-bender that set a block on fire and awarded two wanted stars nobody
   * earned — must stay impossible. A row of eight HEALTHY parked cars, one of
   * them wrecked, must not become eight wrecks. */
  {
    const ctx = makeCtx();
    const sys = makeSystem(ctx);
    const row = [];
    for (let i = 0; i < 8; i++) row.push(spawn(sys, 'sedan', i * BAY, 0));
    row[0].health = 0;
    sys.damage(row[0], 1, null);
    burn(ctx, row, 40);
    const wrecks = row.filter((v) => v.destroyed).length;
    check('chain', 'one wreck in a row of eight healthy parked cars does not burn the row down',
      wrecks === 1, `${wrecks} of 8 wrecked`);
  }

  /* 4e. ...but a rocket into the middle of that row IS a car park going up.
   * The fuse is the rocket's own splash plus the wrecks it leaves behind. */
  {
    const ctx = makeCtx();
    const sys = makeSystem(ctx);
    const row = [];
    for (let i = 0; i < 6; i++) row.push(spawn(sys, 'sedan', i * BAY, 0));
    const def = ALL_WEAPONS.rocket;
    ctx.events.emit('explosion', {
      position: new THREE.Vector3(row[2].position.x, row[2].position.y, row[2].position.z),
      radius: def.splash,
      damage: def.damage,
    });
    burn(ctx, row, 60);
    const wrecks = row.filter((v) => v.destroyed).length;
    check('chain', 'a rocket into a row of six parked cars takes several of them with it',
      wrecks >= 3, `${wrecks} of 6 wrecked`);
  }
}

/* ------------------------------------------------------------------ */
/* 5. COLLISION — the one source that was ALREADY on the right scale.  */
/* ------------------------------------------------------------------ */

/**
 * Drive the real `DamageModel.impact` with an impulse of the shape
 * `_pairResolve` hands it, and assert what a player expects. This section is
 * here because a re-scale that "fixed" bullets by moving `body.hp` would have
 * quietly broken collisions instead, and nothing else would have noticed.
 */
function testCollision() {
  const ctx = makeCtx();
  const pt = new THREE.Vector3();
  const nrm = new THREE.Vector3(0, 0, -1);
  {
    const { v } = fresh('sedan');
    pt.set(v.position.x, v.position.y + 0.4, v.position.z + 2);
    v.damage.impact(v.mass * 2, pt, nrm, ctx);   // a 2 m/s car-park nudge
    check('collision', 'a car-park nudge does not write a sedan off',
      !v.destroyed && v.health > v.maxHealth * 0.7,
      `health ${((100 * v.health) / v.maxHealth).toFixed(0)}%`);
  }
  {
    const { v } = fresh('sedan');
    pt.set(v.position.x, v.position.y + 0.4, v.position.z + 2);
    let hits = 0;
    while (!v.destroyed && hits < 60) {
      v.damage.impact(v.mass * 16, pt, nrm, ctx);
      hits++;
    }
    check('collision', 'a sedan survives one big crash and dies to a handful',
      hits >= 3 && hits <= 12, `${hits} heavy impacts to wreck`);
  }
}

/* ------------------------------------------------------------------ */

testBullets();
testMelee();
testBlast();
testChain();
testCollision();

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
console.log(`\nvehicle damage: ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
