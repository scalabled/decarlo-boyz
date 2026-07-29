#!/usr/bin/env node
/**
 * COP FIRE PROBE — "what does one police round cost the car you are sitting
 * in?", as a gate.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `TUNE.fire.damage` is in ACTOR points. The proof is in `officer.js` itself:
 * when the quarry is on foot the same array goes to `sys.copHit()` against a
 * 100 HP player, and when he is in a car it goes to `vehicles.damage()`
 * against a 900-1250 HP body. Something has to convert between those two
 * scales, and `vehicles` publishes exactly one answer to that —
 * `ACTOR_TO_VEHICLE`, live on the system as `actorDamageScale`, which
 * `weapons/vehiclehit.js` reads rather than copying.
 *
 * `police/tune.js` had its own: `vehicleScale: 3.5`, hand-fitted, under a
 * comment claiming a car was a 100 HP body (a car is 900-1250; the 100 is the
 * player). It was never double-scaled — `damage()`
 * takes vehicle points and always did — it was simply a second, quieter answer
 * to a question the engine now answers centrally, and it made a police round
 * worth 35% of what the identical number of actor points is worth through
 * every other path in the game.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — TWO INDEPENDENT PRODUCTION PATHS, COMPARED BY WHAT THEY EMIT
 * ---------------------------------------------------------------------------
 * The gate does not evaluate `dmg * share * scale`. Restating that expression
 * would be reading the code's own input, which is the mistake this project has
 * shipped green gates for repeatedly. Instead it drives two DIFFERENT
 * subsystems' code over the same actor-point number and compares the two
 * health drops the cars actually took:
 *
 *   A  the real `Officer._combat()` — the aimed shot, its accuracy roll, its
 *      LOS test and its `vehicles.damage()` call — into a real `Vehicle`
 *   B  the real `explosion` event into the real `VehicleSystem._explosionDamage`
 *      at zero distance, where the falloff is 1 and the only thing left is the
 *      engine's own actor -> vehicle conversion
 *
 * If police is using the engine's conversion, A/B is `TUNE.fire.vehicleShare`
 * and nothing else, at every star and for any body. If police keeps a private
 * one, the ratio moves off the share and this goes red. Measured on the value
 * this replaced, `vehicleScale: 3.5`, the ratio was 0.280 against a share of
 * 0.8.
 *
 * The car's HP comes from `vehicles/specs.js` and the conversion from
 * `vehicles/index.js`, neither of which this subsystem owns or restates, so
 * the whole check is a relationship between separately owned tables.
 *
 *   node src/police/copfireprobe.mjs
 *   node src/police/copfireprobe.mjs --verbose
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROL
 * ---------------------------------------------------------------------------
 * No `--break` flag; revert for real. `src/police/tune.js`:
 *
 *   vehicleScale: 3.5   (the value this replaced)
 *       4/7.  ratio 0.280 against a 0.800 share, and a sedan needs 46
 *       connecting rounds at the lowest firing star — outside the band.
 *   vehicleScale: 40    (over-correction, to prove the band cuts both ways)
 *       4/7.  ratio 3.200, and five-star fire writes a sedan off in THREE
 *       connecting rounds.
 *
 * Note which check does NOT move in either arm: "it holds across every body
 * and every star" stays green, because a private conversion is still a
 * CONSISTENT private conversion. Consistency is not correctness, which is why
 * the absolute ratio is asserted separately and first.
 */

import * as THREE from 'three';
import { Officer } from './officer.js';
import { TUNE } from './tune.js';
import { VEHICLE_SPECS, finalizeSpec } from '../vehicles/specs.js';
import { Vehicle } from '../vehicles/dynamics.js';
import { VehicleSystem, ACTOR_TO_VEHICLE } from '../vehicles/index.js';
import { DamageModel } from '../vehicles/damage.js';
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
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed++;
}

/* ------------------------------------------------------------------ */
/* A headless chase, real where it matters.                            */
/* ------------------------------------------------------------------ */

const NOOP = () => {};
const STUB_MATS = {
  paint: () => ({ dispose: NOOP }),
  glass: () => ({ clone: () => ({ color: { set: NOOP } }), dispose: NOOP }),
  cracksTexture: () => null,
};
function stubModel() {
  return { root: null, wheels: [], panels: [], glassMeshes: [], lampMats: {}, paintMat: null };
}

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

/** `damage` and `_explosionDamage` are the production methods, on this object. */
function makeVehSys(ctx) {
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
    /* Class field, so not on the prototype — harness plumbing, exactly as in
     * `vehicles/damageprobe.mjs`. No assertion in this file reads it. */
    actorDamageScale: ACTOR_TO_VEHICLE,
    damage: VehicleSystem.prototype.damage,
    _explosionDamage: VehicleSystem.prototype._explosionDamage,
  };
  ctx._veh = sys;
  ctx.events.on('explosion', (e) => sys._explosionDamage(e));
  return sys;
}

let _seed = 1;
function spawn(sys, type) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(sys, spec, stubModel(), {});
  v.damage = new DamageModel(v, STUB_MATS, new Rng(_seed++));
  v.setPose(new THREE.Vector3(0, spec.comY, 0), 0);
  sys.vehicles.push(v);
  return v;
}

/**
 * A police system stubbed everywhere except the path under test. `rng.float`
 * returns 0 so the accuracy roll always connects — the roll itself still runs,
 * this only removes the coin from the measurement.
 */
function makeCopSys(vehSys, level, rec) {
  return {
    level,
    fireEnabled: true,
    playerSys: { health: { dead: false, max: 100 } },
    _quarryOverride: null,
    diff: { aggr: 1, dmg: 1 },
    rng: { float: () => 0 },
    rayVisible: () => true,
    copShotFx: NOOP,
    statFire: () => { rec.shots++; },
    copHit: (o, amount) => { rec.playerHits.push(amount); },
    vehicles: vehSys,
    groundAt: () => 0,
  };
}

/** One connecting round at `level` into a fresh `type`. Returns what it cost. */
function oneRound(type, level) {
  const ctx = makeCtx();
  const vehSys = makeVehSys(ctx);
  const v = spawn(vehSys, type);
  const rec = { shots: 0, playerHits: [] };
  const o = new Officer(makeCopSys(vehSys, level, rec));
  o.ped = { position: new THREE.Vector3(6, 0, 0), id: 3 };
  o.crooked = false;
  o.fireT = 0;
  const q = { position: v.position, speed: 0, inVehicle: true, vehicle: v };
  const hp0 = v.health;
  o._combat(0, q, 6);
  return { drop: hp0 - v.health, hp0, rec };
}

/** ...and how many of them write the car off, through the same path. */
function roundsToWreck(type, level) {
  const ctx = makeCtx();
  const vehSys = makeVehSys(ctx);
  const v = spawn(vehSys, type);
  const rec = { shots: 0, playerHits: [] };
  const o = new Officer(makeCopSys(vehSys, level, rec));
  o.ped = { position: new THREE.Vector3(6, 0, 0), id: 3 };
  o.crooked = false;
  const q = { position: v.position, speed: 0, inVehicle: true, vehicle: v };
  let n = 0;
  while (!v.destroyed && n < 5000) {
    o.fireT = 0;
    const before = v.health;
    o._combat(0, q, 6);
    if (v.health === before) break;
    n++;
  }
  return v.destroyed ? n : -1;
}

/** The same actor points through the engine's own conversion, falloff 1. */
function blastDrop(type, actorPoints) {
  const ctx = makeCtx();
  const vehSys = makeVehSys(ctx);
  const v = spawn(vehSys, type);
  const hp0 = v.health;
  ctx.events.emit('explosion', { position: v.position.clone(), radius: 8, damage: actorPoints });
  return hp0 - v.health;
}

/* ================================================================== */
/* 1. THE CONVERSION IS THE ENGINE'S. Only the share is police's.      */
/* ================================================================== */

const SHARE = TUNE.fire.vehicleShare;
const rows = [];
let ratioOk = true;
for (const type of ['sedan', 'muscle', 'van']) {
  for (let level = TUNE.fire.fromLevel; level <= 5; level++) {
    const actor = TUNE.fire.damage[level];
    const shot = oneRound(type, level);
    const blast = blastDrop(type, actor);
    const ratio = blast > 0 ? shot.drop / blast : NaN;
    rows.push({ type, level, actor, drop: shot.drop, blast, ratio, hp0: shot.hp0 });
    if (!(Math.abs(ratio - SHARE) < 1e-6)) ratioOk = false;
  }
}
check('one police round is exactly `vehicleShare` of the same actor points delivered by blast',
  ratioOk,
  `ratios ${[...new Set(rows.map((r) => r.ratio.toFixed(3)))].join(', ')} vs share ${SHARE}`);

check('...and it holds across every body and every star',
  new Set(rows.map((r) => r.ratio.toFixed(6))).size === 1,
  `${new Set(rows.map((r) => r.ratio.toFixed(6))).size} distinct ratios over ${rows.length} cases`);

/* ================================================================== */
/* 2. THE MAN IN THE CAR TAKES NOTHING.                                */
/* ================================================================== */

{
  const r = oneRound('sedan', 5);
  check('a round that lands on the car does not also hit the player',
    r.rec.playerHits.length === 0 && r.rec.shots === 1,
    `${r.rec.playerHits.length} player hits, ${r.rec.shots} shots counted`);
}

/* ================================================================== */
/* 3. THE PRESSURE IS IN A BAND A DESIGNER WOULD RECOGNISE.            */
/*                                                                     */
/*    Deliberately wide. The shape of the thing is "sustained fire      */
/*    costs you the car", not "one burst" and not "never". Anything     */
/*    from 5 to 40 rounds reads as that; 1 does not, and 200 does not.  */
/* ================================================================== */

const BAND = { min: 5, max: 40 };
for (const type of ['sedan', 'muscle']) {
  const w5 = roundsToWreck(type, 5);
  const w2 = roundsToWreck(type, TUNE.fire.fromLevel);
  check(`${type}: five-star fire wrecks it in ${BAND.min}-${BAND.max} connecting rounds`,
    w5 >= BAND.min && w5 <= BAND.max, `${w5} rounds`);
  check(`${type}: the lowest firing star is slower, and still inside the band`,
    w2 > w5 && w2 <= BAND.max, `w${TUNE.fire.fromLevel} ${w2} vs w5 ${w5}`);
}

/* ------------------------------------------------------------------ */

console.log('\nCOP FIRE PROBE — a police round against the car you are in');
console.log(`  vehicleShare ${SHARE}   vehicleScale ${TUNE.fire.vehicleScale}`);
if (VERBOSE) {
  console.log('\n  body    star  actor   round     blast   ratio   %/round');
  for (const r of rows) {
    console.log(`  ${r.type.padEnd(7)} ${r.level}   ${String(r.actor).padStart(4)}  ` +
      `${r.drop.toFixed(1).padStart(6)}  ${r.blast.toFixed(1).padStart(7)}   ${r.ratio.toFixed(3)}   ` +
      `${((r.drop / r.hp0) * 100).toFixed(2)}%`);
  }
  console.log('');
}
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok || VERBOSE) console.log(`        ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
