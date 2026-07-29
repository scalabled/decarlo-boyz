#!/usr/bin/env node
/**
 * WRECK PROBE — the parked car, which is the only case the feature is about.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM `damageprobe.mjs`
 * ---------------------------------------------------------------------------
 * `damageprobe` gates the wreck chain and scores it green. It cannot see this
 * defect, for one reason that is worth writing down because it is rule 12 in
 * its most seductive form: its `burn()` helper RE-IMPLEMENTS the burn ramp.
 *
 *     if (v.destroyed) v.burning = Math.min(1, v.burning + dt * 0.35);
 *     v.damage.update(dt, ctx);
 *
 * The comment beside it says "reproduced here because the probe does not step
 * the dynamics. Same rate, same source." Same rate — but not the same SOURCE,
 * and the source was the whole defect. In the game that line lived inside
 * `Vehicle._postStep`, i.e. inside `fixedStep`, which `VehicleSystem.fixedUpdate`
 * SKIPS ENTIRELY for a sleeping vehicle. The probe supplied by hand the exact
 * value the game was failing to produce, so it measured a fuse fed by the
 * harness rather than by the engine, and it was never wrong about the number
 * it printed — only about what that number was evidence of.
 *
 * The probe also only ever tested FRESHLY SPAWNED cars, which are the one kind
 * that has never fallen asleep. Every published figure for this feature —
 * "a neighbour at 2.8 m loses 43-51%" — was taken in the one condition where
 * the bug cannot appear.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASURES (rule 12)
 * ---------------------------------------------------------------------------
 * Nothing here writes `burning`, `sleeping`, `_sleepTimer` or `_acc`. The only
 * thing the harness drives is the clock:
 *
 *   - the ground is a real plane behind the real `physics.raycast` contract,
 *   - the cars are real `Vehicle`s with real `DamageModel`s,
 *   - SLEEP is decided by production `VehicleSystem.fixedUpdate` off a
 *     `_sleepTimer` that only production `Vehicle._postStep` ever writes,
 *   - the burn clock and the fuse are production `DamageModel.update`,
 *   - the blast is the production `explosion` event through production
 *     `VehicleSystem._explosionDamage`.
 *
 * and the assertions are on EMITTED artefacts only: the `explosion` events that
 * actually reach a listener, the neighbour's own health, and — for the dent —
 * the millimetres a real `BufferGeometry`'s vertices actually moved.
 *
 * The sharpest section is the DIFFERENTIAL: the same car, same class, same
 * damage, same seconds of clock, differing in one thing only — whether it was
 * allowed to settle and fall asleep first. Both arms must produce the same
 * outcome. That comparison cannot be satisfied by a constant, and it is what
 * the whole defect looked like from outside.
 *
 *   node src/vehicles/wreckprobe.mjs
 *   node src/vehicles/wreckprobe.mjs --verbose
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROL — a gate nobody has seen fail is not a gate
 * ---------------------------------------------------------------------------
 * There is no `--break` flag, for the same reason `damageprobe` has none: a
 * flag that emulates the old behaviour is one more thing that can agree with
 * the code by accident. Revert for real. All four were run; these are their
 * measured outputs, not predictions:
 *
 *   ALL THREE AT ONCE — the shipped code this file was written against:
 *                                                         10/19
 *       asleep:  0 explosions in 15 s; neighbour lost 0.0%
 *       diff:    explosions awake 1, asleep 0; neighbour -40.7% vs -0.0%
 *
 *   dynamics.js  put the `burning`/`smoke` ramps back in `_postStep` and take
 *                them out of `DamageModel.update`         18/19
 *       asleep:  burning 0.423 when the blast was emitted (want >= 0.9) — the
 *                clock only ran for the 1.2 s of grace the wake bought it.
 *                Note it still DETONATES: with the wake in place the fuse is
 *                no longer starved, which is exactly why this control matters.
 *
 *   index.js     drop the `v.wake?.()` in `damage()`      18/19
 *       settle:  sleeping true -> true, _sleepTimer 1.21 -> 1.21 s
 *
 *   index.js     restore `.normalize().multiplyScalar(-1)` with no degenerate
 *                guard, and `amount / ACTOR_TO_VEHICLE`   17/19
 *       dent:    sedan 31.15 mm vs bus 78.36 mm for the same PROPORTION of
 *                the body (ratio 2.52); 1 panel cloned for 0.00 mm of picture
 */

import * as THREE from 'three';
import { VEHICLE_SPECS, finalizeSpec, SURFACE_GRIP, WET_SENS, wetGrip } from './specs.js';
import { Vehicle } from './dynamics.js';
import { VehicleSystem, ACTOR_TO_VEHICLE } from './index.js';
import { DamageModel } from './damage.js';
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
/* A headless street: a real ground plane behind the real ray contract. */
/* ------------------------------------------------------------------ */

const NOOP = () => {};
const STUB_MATS = {
  paint: () => ({ dispose: NOOP }),
  glass: () => ({ clone: () => ({ color: { set: NOOP } }), dispose: NOOP }),
  cracksTexture: () => null,
};

const UP = new THREE.Vector3(0, 1, 0);
const HIT = {
  hit: true, point: new THREE.Vector3(), normal: UP.clone(),
  distance: 0, surface: 'asphalt', object: null,
};
const GRIP = {};
for (const k in SURFACE_GRIP) {
  const base = SURFACE_GRIP[k];
  const sens = WET_SENS[k] ?? 0.6;
  GRIP[k] = { ...base, mu: wetGrip(base.mu, 0), skid: base.skid, roll: base.roll, drag: base.drag };
}

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

/**
 * Every method that decides anything is the production one, taken off the
 * prototype and run on this object. The stubs are the city: materials, a
 * ground plane, and nothing else.
 */
function makeSystem(ctx) {
  const sys = {
    ctx,
    vehicles: [],
    rng: new Rng(20260728),
    mats: STUB_MATS,
    physics: {
      MASK: { WORLD: 3 }, SURFACE: {}, spawnDebris: NOOP, emitImpact: NOOP, staticWorld: null,
      raycast(origin, dir, maxDist) {
        const denom = UP.dot(dir);
        if (Math.abs(denom) < 1e-6) { HIT.hit = false; return HIT; }
        const t = -UP.dot(origin) / denom;
        if (t < 0 || t > maxDist) { HIT.hit = false; return HIT; }
        HIT.hit = true;
        HIT.distance = t;
        HIT.point.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
        HIT.normal.copy(UP);
        HIT.surface = 'asphalt';
        return HIT;
      },
      groundHeight: () => 0,
    },
    lodOf: () => 0,
    surfaceAt: () => 'asphalt',
    waterHeightAt: () => null,
    gripOf: (n) => GRIP[n] ?? GRIP.asphalt,
    _world: () => null,
    actorDamageScale: ACTOR_TO_VEHICLE,
    _stats: { stepMs: 0, count: 0, lod: [0, 0, 0, 0] },
    _poseAnchor: null,
    damage: VehicleSystem.prototype.damage,
    _explosionDamage: VehicleSystem.prototype._explosionDamage,
    fixedUpdate: VehicleSystem.prototype.fixedUpdate,
    _vehicleCollisions: VehicleSystem.prototype._vehicleCollisions,
    _pairResolve: VehicleSystem.prototype._pairResolve,
    reportCollision: VehicleSystem.prototype.reportCollision,
  };
  ctx._veh = sys;
  ctx.events.on('explosion', (e) => sys._explosionDamage(e));
  return sys;
}

/** A panel with REAL geometry, so a dent can be measured in millimetres. */
function panelMesh(spec) {
  const g = new THREE.BoxGeometry(spec.half.x * 2, spec.dims.H, spec.half.z * 2, 24, 12, 40);
  g.translate(0, spec.comY, 0);
  return { lod: 0, mesh: { geometry: g } };
}

function stubModel(spec, withPanels) {
  return {
    root: null, wheels: [], glassMeshes: [], lampMats: {}, paintMat: null,
    panels: withPanels ? [panelMesh(spec)] : [],
  };
}

let _seed = 1;
function spawn(sys, type, x = 0, z = 0, { panels = false } = {}) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(sys, spec, stubModel(spec, panels), { parked: true });
  v.damage = new DamageModel(v, STUB_MATS, new Rng(_seed++));
  v.setPose(new THREE.Vector3(x, spec.comY, z), 0);
  // A car nobody is sitting in is out of gear with the pedals up. `_postStep`
  // will not let a car with a pedal down go still, and a parked car has none.
  v.input.brake = 0;
  sys.vehicles.push(v);
  return v;
}

/**
 * The engine's own cadence: `engine.js` runs the 120 Hz fixed step twice per
 * 60 Hz frame, then the per-frame `update` sweep. `VehicleSystem.update` calls
 * `v.damage?.update(dt, ctx)` for every vehicle unconditionally — that one line
 * is all of the frame sweep this needs, and it is reproduced rather than run
 * only because the rest of it wants a camera, a scene graph and a shadow pool.
 */
const H = 1 / 120;
const FRAME = 1 / 60;
function run(sys, ctx, seconds) {
  const frames = Math.round(seconds * 60);
  for (let f = 0; f < frames; f++) {
    sys.fixedUpdate(H, ctx);
    sys.fixedUpdate(H, ctx);
    ctx.time.elapsed += FRAME;
    for (const v of sys.vehicles) v.damage?.update(FRAME, ctx);
  }
}

/** How long a car has to stand still before `fixedUpdate` stops stepping it. */
const SETTLE_SECONDS = 6;
/** Two cars in adjacent bays: centres 2.8 m apart. */
const BAY = 2.8;
/** Long enough for the 3.2 s fuse several times over. */
const WATCH_SECONDS = 15;

/* ================================================================== */
/* 1. THE HARNESS MUST ACTUALLY PRODUCE A SLEEPING CAR                 */
/* ================================================================== */
/**
 * The condition guard, first and loudest. ARCHITECTURE.md rule 12: "a guard
 * whose whole job is to reject bad test conditions is the last place anyone
 * re-reads, because when it is broken everything looks fine." If a future
 * change to the sleep rule stops these cars sleeping, every section below
 * would go green while testing nothing at all — so the sleep is asserted, not
 * assumed, and it is asserted on the flag PRODUCTION set, never set here.
 */
function testSettle() {
  const ctx = makeCtx();
  const sys = makeSystem(ctx);
  const types = ['sedan', 'truck', 'police'];
  const cars = types.map((t, i) => spawn(sys, t, i * 12, 0));
  run(sys, ctx, SETTLE_SECONDS);

  for (let i = 0; i < cars.length; i++) {
    const v = cars[i];
    check('settle', `a parked ${types[i]} falls asleep on its own within ${SETTLE_SECONDS} s`,
      v.sleeping === true,
      `sleeping ${v.sleeping}, _sleepTimer ${v._sleepTimer.toFixed(2)} s, ` +
      `speed ${v.speed.toFixed(3)} m/s, grounded ${v.grounded}/${v.wheels.length}`);
  }

  /* THE LATCH ITSELF, from both sides.
   *
   * `_sleepTimer` is written in exactly one place in the engine —
   * `Vehicle._postStep`, at the bottom of `fixedStep` — so it is a witness to
   * the step having run, and nothing here ever assigns it. A sleeper's copy is
   * frozen: that is the suppression this defect is made of, and it has to be
   * shown to be real before "it wakes" means anything. */
  {
    const v = cars[2];
    const t0 = v._sleepTimer;
    run(sys, ctx, 1);
    check('settle', 'a sleeping car is not stepped at all (this is the latch)',
      v.sleeping === true && v._sleepTimer === t0,
      `_sleepTimer frozen at ${v._sleepTimer.toFixed(3)} s through 60 frames`);
  }

  /* ...and the other side: a car that has been shot is stepped again. Measured
   * off the same witness — `_sleepTimer` can only be off zero if production
   * `_postStep` ran, which can only happen if `fixedUpdate` stepped it. */
  {
    const v = cars[0];
    const wasAsleep = v.sleeping;
    const before = v._sleepTimer;
    sys.damage(v, 40, null);
    const flag = v.sleeping;
    run(sys, ctx, 0.5);
    /* The timer must have RESTARTED and then advanced — strictly below the
     * frozen reading it was stuck at, and strictly above zero. A sleeper's
     * frozen 1.21 s satisfies neither, which is what stops this passing on the
     * stale value. */
    const restarted = v._sleepTimer < before - 0.1 && v._sleepTimer > 0.4;
    check('settle', 'shooting a sleeping car wakes it, and it is stepped again',
      wasAsleep && flag === false && restarted,
      `sleeping ${wasAsleep} -> ${flag}, _sleepTimer ${before.toFixed(2)} s ` +
      `-> ${v._sleepTimer.toFixed(2)} s after half a second of frames`);
  }
}

/* ================================================================== */
/* 2. THE FUSE, ON A CAR THAT GENUINELY FELL ASLEEP                    */
/* ================================================================== */

/**
 * @param settleFirst let the car fall asleep before writing it off
 * @returns everything measured off EMITTED state
 */
function wreckOne(type, settleFirst) {
  const ctx = makeCtx();
  const sys = makeSystem(ctx);
  const a = spawn(sys, type, 0, 0);
  const b = spawn(sys, type, BAY, 0);
  if (settleFirst) run(sys, ctx, SETTLE_SECONDS);
  const asleep = a.sleeping;

  const booms = [];
  /* `burning` is sampled AT the emit, not at the end: after the blast the
   * wreck is thrown, so it is awake again and any ramp catches up. Sampling
   * late would hide a clock that had stopped while it slept. */
  let alightAtBoom = -1;
  ctx.events.on('explosion', (e) => {
    booms.push(e);
    if (alightAtBoom < 0) alightAtBoom = a.burning;
  });
  const hp0 = b.health;
  sys.damage(a, a.health + 1, null);
  run(sys, ctx, WATCH_SECONDS);

  return {
    asleep,
    booms: booms.length,
    alightAtBoom,
    neighbourLoss: (hp0 - b.health) / b.maxHealth,
    neighbourDead: b.destroyed,
  };
}

function testAsleep() {
  const r = wreckOne('sedan', true);

  check('asleep', 'the car under test really was asleep when it was written off',
    r.asleep === true, `sleeping ${r.asleep} after ${SETTLE_SECONDS} s of standing still`);

  check('asleep', 'a wrecked PARKED car goes up, exactly once',
    r.booms === 1, `${r.booms} explosions in ${WATCH_SECONDS} s`);

  /**
   * FULLY ALIGHT WHEN IT GOES UP, and this is the clock the defect was made of.
   *
   * The fuse is 3.2 s and `burning` saturates in 1/0.35 = 2.857 s, so by
   * construction a wreck is at 1 when it detonates — that spacing is the
   * authored intent, and it is what makes an exploding car a car that has been
   * on fire rather than one that popped. The burn clock therefore has to run
   * for the WHOLE fuse. While it lived in `Vehicle._postStep` it ran only for
   * the seconds the solver happened to be stepping the car, which for a parked
   * one is the 1.2 s of grace after a wake and nothing else: measured 0.423 at
   * the moment of the blast, and 0.000 before damage woke anything at all.
   */
  check('asleep', 'the wreck is fully alight at the moment it goes up',
    r.alightAtBoom >= 0.9,
    `burning ${r.alightAtBoom < 0 ? 'n/a — it never went up' : r.alightAtBoom.toFixed(3)} when the blast was emitted`);

  /* A wreck emits 55 actor points over a 7 m radius, reaching `radius * 1.2` —
   * 55% of a neighbour at the centre, ~41% at a bay's spacing. Measured on the
   * neighbour's own health, never on the payload. */
  check('asleep', 'the car parked beside it loses a serious bite of health',
    r.neighbourLoss >= 0.25 && r.neighbourLoss <= 0.75,
    `neighbour lost ${(r.neighbourLoss * 100).toFixed(1)}% (want 25-75%)`);

  /* ...and a full car park still must not level itself. Eight healthy cars,
   * one wrecked, all of them asleep. */
  {
    const ctx = makeCtx();
    const sys = makeSystem(ctx);
    const row = [];
    for (let i = 0; i < 8; i++) row.push(spawn(sys, 'sedan', i * BAY, 0));
    run(sys, sys.ctx, SETTLE_SECONDS);
    const slept = row.filter((v) => v.sleeping).length;
    sys.damage(row[0], row[0].health + 1, null);
    run(sys, ctx, 40);
    const wrecks = row.filter((v) => v.destroyed).length;
    check('asleep', 'one wreck in a row of eight sleeping parked cars does not burn the row down',
      wrecks === 1 && slept === 8, `${slept}/8 were asleep, ${wrecks} of 8 wrecked`);
  }
}

/* ================================================================== */
/* 3. THE DIFFERENTIAL — asleep must equal awake                       */
/* ================================================================== */
/**
 * One variable: whether the car was allowed to settle first. Everything else —
 * class, damage, seconds of clock, neighbour, seed — is identical. A constant
 * cannot satisfy this, and neither can a harness that supplies the value the
 * engine is failing to produce, because it would supply it to both arms.
 */
function testDifferential() {
  for (const type of ['sedan', 'truck']) {
    const awake = wreckOne(type, false);
    const asleep = wreckOne(type, true);

    check('diff', `a parked ${type} goes up like one that was never parked`,
      asleep.booms === awake.booms && awake.booms === 1,
      `explosions: awake ${awake.booms}, asleep ${asleep.booms}`);

    check('diff', `...and takes the same bite out of its neighbour (${type})`,
      Math.abs(asleep.neighbourLoss - awake.neighbourLoss) < 0.02,
      `neighbour lost ${(awake.neighbourLoss * 100).toFixed(1)}% awake, ` +
      `${(asleep.neighbourLoss * 100).toFixed(1)}% asleep`);
  }

  /* The chain, which is what the feature is FOR: two cars parked together go up
   * together when one of them has already been shot at. Both asleep. */
  {
    const ctx = makeCtx();
    const sys = makeSystem(ctx);
    const a = spawn(sys, 'sedan', 0, 0);
    const b = spawn(sys, 'sedan', BAY, 0);
    run(sys, ctx, SETTLE_SECONDS);
    b.health = b.maxHealth * 0.3;
    const bothAsleep = a.sleeping && b.sleeping;
    let booms = 0;
    ctx.events.on('explosion', () => booms++);
    sys.damage(a, a.health + 1, null);
    run(sys, ctx, 30);
    check('diff', 'a car park is a fuse: a sleeping wreck detonates the shot-up car beside it',
      bothAsleep && b.destroyed === true && booms >= 2,
      `both asleep ${bothAsleep}, neighbour destroyed ${b.destroyed} ` +
      `(${b.health.toFixed(0)} hp left), ${booms} explosions`);
  }
}

/* ================================================================== */
/* 4. THE DENT, IN MILLIMETRES OF EMITTED GEOMETRY                     */
/* ================================================================== */

/** Largest distance any vertex has moved from the pristine copy. */
function maxVertexMove(v) {
  let worst = 0;
  for (const panel of v.model.panels) {
    const g = panel.mesh.geometry;
    const base = g.userData.owBase;
    if (!base) continue;
    const a = g.attributes.position.array;
    for (let i = 0; i < a.length; i += 3) {
      const d = Math.hypot(a[i] - base[i], a[i + 1] - base[i + 1], a[i + 2] - base[i + 2]);
      if (d > worst) worst = d;
    }
  }
  return worst;
}

function dentOnce(type, amount, mode) {
  const ctx = makeCtx();
  const sys = makeSystem(ctx);
  const v = spawn(sys, type, 0, 0, { panels: true });
  let point = null;
  if (mode === 'self') point = v.position;
  else if (mode === 'flank') {
    point = new THREE.Vector3(
      v.position.x + v.spec.half.x, v.position.y + 0.4, v.position.z + v.spec.half.z * 0.3);
  }
  sys.damage(v, amount, point);
  return { mm: maxVertexMove(v) * 1000, cloned: v.damage._cloned.size };
}

function testDent() {
  /* A located hit leaves a crater a player can see: a 16-point hit on a 100 HP
   * body is about 3 cm. */
  {
    const r = dentOnce('sedan', 160, 'flank');
    check('dent', 'a nail-gun round leaves a crater you can see, not a number',
      r.mm >= 15 && r.mm <= 60, `${r.mm.toFixed(2)} mm of vertex movement (want 15-60)`);
  }

  /* THE SCALE MUST NOT BE THE DAMAGE-BOOKKEEPING CONSTANT. Same fraction of
   * the body taken off two bodies eight times apart in HP must leave craters
   * of the same order. Dividing by `ACTOR_TO_VEHICLE` instead made this a
   * factor of the HP ratio, so a bus panel dented exactly as deep as a sedan's
   * for a hit it barely felt. Measured as a ratio of emitted displacements, so
   * no constant appears on either side. */
  {
    const sedan = dentOnce('sedan', 900 * 0.18, 'flank');
    const bus = dentOnce('bus', 3000 * 0.18, 'flank');
    const ratio = bus.mm / Math.max(1e-6, sedan.mm);
    check('dent', 'the same PROPORTION of damage dents a bus like it dents a sedan',
      ratio > 0.6 && ratio < 1.7,
      `sedan ${sedan.mm.toFixed(2)} mm, bus ${bus.mm.toFixed(2)} mm, ratio ${ratio.toFixed(2)}`);
  }

  /* A hit at the body's own centre has no direction. It used to run the full
   * crater loop with a zero-length normal — a copy-on-write clone of every
   * panel plus `computeVertexNormals` over all of it, for 0.00 mm of picture.
   * Assert BOTH halves: nothing moved, and nothing was paid for. */
  {
    const r = dentOnce('sedan', 30, 'self');
    check('dent', 'a hit with no located impact point moves nothing...',
      r.mm < 1e-6, `${r.mm.toFixed(4)} mm`);
    check('dent', '...and does not pay for a panel clone to achieve it',
      r.cloned === 0, `${r.cloned} panels cloned`);
  }
}

/* ------------------------------------------------------------------ */

testSettle();
testAsleep();
testDifferential();
testDent();

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
console.log(`\nparked wreck: ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
