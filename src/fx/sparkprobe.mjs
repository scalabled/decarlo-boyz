#!/usr/bin/env node
/**
 * SPARK GATE — does the arsenal still read on a car?
 *
 *   node src/fx/sparkprobe.mjs
 *   node src/fx/sparkprobe.mjs --nc        the negative control (must go RED)
 *   node src/fx/sparkprobe.mjs --json
 *   node src/fx/sparkprobe.mjs --verbose
 *
 * =============================================================================
 * THE DEFECT
 * =============================================================================
 * `bullet:impact.damage` is an ACTOR-scale slot (nail 20, SMG 16, harpoon 90)
 * and `fx/index.js` turns it into a burst with
 *
 *     energy = clamp(0.7 + damage / 55, 0.7, 1.7)
 *
 * so anything at or above ~55 points saturates. `vehicles` prices a body
 * 90-3000 and `ACTOR_TO_VEHICLE` is 10, and both vehicle-hit call sites —
 * `weapons/ballistics.js` (rounds) and `weapons/vehiclehit.js` (swings) — were
 * handing that slot the number they had just given `vehicles.damage()`.
 *
 * MEASURED HERE, on the emitted particles, before the fix: the flash intensity
 * of EVERY round and EVERY swing on a car was 17.000, the ceiling, identically.
 * Nailgun, SMG, rivet gun, speargun, harpoon, pipe, crowbar, wrench — one
 * number. Every hit on every car in Steel City threw the same maximal spark
 * burst while the same rounds on concrete still ranged 9.9 to 17.0.
 *
 * =============================================================================
 * WHAT THIS REFUSES TO DO (hard rule 12)
 * =============================================================================
 * It never reads `damage`, `dealt`, `actorPoints`, `BULLET_TRANSFER`,
 * `MELEE_TRANSFER` or `actorDamageScale`, and it never re-applies the scale
 * conversion to check the scale conversion. It does not stub `emitImpact` —
 * `src/vehicles/damageprobe.mjs` does (NOOP), which is exactly why that gate
 * could not see any of this.
 *
 * The measured quantity is the EMITTED PARTICLE: the impact flash's launch
 * intensity and size, taken at `fx.emitAdd` — the record that goes into the GPU
 * ring, four subsystems downstream of the number under test. Everything between
 * a weapon's own `def.damage` and that record is production code:
 *
 *   weapons/ballistics.js  ProjectileSim.spawn + fixedUpdate     (real)
 *   weapons/vehiclehit.js  cast / apply / sweep                  (real)
 *   vehicles/index.js      VehicleSystem.damage, actorDamageScale(real)
 *   physics/index.js       PhysicsSystem.emitImpact              (real)
 *   physics/penetration.js Ballistics.fire (the world path)      (real)
 *   fx/index.js            FxSystem.onImpact                     (real)
 *   fx/impacts.js          the per-surface recipe                (real)
 *
 * The harness owns exactly two things, neither of which computes a damage or an
 * energy: a wall (one slab, so `phys.raycast` has something to answer with) and
 * the particle sink.
 *
 * EVERY ASSERTION IS A RATIO OF TWO EMITTED FLASHES, so no coefficient from
 * `impacts.js` and no constant from `onImpact` appears on the right-hand side.
 * `SAT_DISPLAY` below is used ONLY to print a familiar number.
 *
 * =============================================================================
 * NEGATIVE CONTROL
 * =============================================================================
 * `--nc` sets `VehicleHitTest.fxVehicleScale`, which puts the VEHICLE-scale
 * number back into the FX slot — the shipped bug, restored in the live code
 * with no edit. It must turn sections 2, 3 and 4 red.
 *
 * The default run ALSO measures both arms and asserts the difference is
 * confined to vehicles: every world-surface flash must be bit-identical across
 * the two arms, and every car flash must move. A fix that changed the world
 * path too would pass every threshold above and fail here.
 *
 * Exit code 1 on any failed assertion.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { PhysicsSystem, MASK, SURFACE } from '../physics/index.js';
import { Ballistics } from '../physics/penetration.js';
import { FxSystem } from './index.js';
import { P } from './atlas.js';
import { ProjectileSim } from '../weapons/ballistics.js';
import { VehicleHitTest } from '../weapons/vehiclehit.js';
import { ALL_WEAPONS } from '../weapons/lib.js';
import { VEHICLE_SPECS, finalizeSpec } from '../vehicles/specs.js';
import { Vehicle } from '../vehicles/dynamics.js';
import { VehicleSystem } from '../vehicles/index.js';
import { DamageModel } from '../vehicles/damage.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const JSON_OUT = !!args.json;
const VERBOSE = !!args.verbose;
const NC = !!args.nc;
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

/** fx's own saturation value. PRINTING ONLY — no assertion reads it. */
const SAT_DISPLAY = 1.7;

const results = [];
let failed = 0;
function check(section, name, ok, detail) {
  results.push({ section, name, ok: !!ok, detail });
  if (!ok) failed++;
}

/* ========================================================================== */
/*  A world just rich enough for the real classes to run in                   */
/* ========================================================================== */

const NOOP = () => {};
const STUB_MATS = {
  paint: () => ({ dispose: NOOP }),
  glass: () => ({ clone: () => ({ color: { set: NOOP } }), dispose: NOOP }),
  cracksTexture: () => null,
};

function makeCtx() {
  const listeners = new Map();
  const ctx = {
    time: { elapsed: 0, raw: 0, dt: 1 / 60, fixed: 1 / 120, alpha: 0, scale: 1, frame: 0 },
    rng: new Rng(4242),
    events: {
      on(k, fn) {
        if (!listeners.has(k)) listeners.set(k, []);
        listeners.get(k).push(fn);
        return NOOP;
      },
      off: NOOP,
      emit(k, p) { const l = listeners.get(k); if (l) for (const fn of l.slice()) fn(p); },
    },
    peek: (id) => ctx._sys[id] ?? null,
    get: (id) => ctx.peek(id),
    has: (id) => !!ctx._sys[id],
    _sys: {},
  };
  return ctx;
}

/**
 * THE ONLY GEOMETRY IN THIS WORLD: one slab, front face at x = 3, 25 cm thick.
 * It exists so `phys.raycast` has something to answer with; it decides nothing
 * about damage or energy. 25 cm defeats every penetration budget in the
 * arsenal, so a shot at it produces exactly ONE entry impact and no exit.
 */
const WALL_X = 3;
const WALL_T = 0.25;
const WALL_OBJ = { name: 'harness-wall' };

/**
 * A `PhysicsSystem` that is REAL where it matters — `emitImpact`, `fireBullet`
 * and the terminal `Ballistics` are the production code, running on this
 * object — and inert where the city would otherwise have to exist.
 */
function makePhysics(ctx, wallSurface) {
  const phys = Object.create(PhysicsSystem.prototype);
  phys.ctx = ctx;
  phys.MASK = MASK;
  phys.SURFACE = SURFACE;
  phys.rng = new Rng(99);
  phys._impactPool = [];
  for (let i = 0; i < 48; i++) {
    phys._impactPool.push({
      point: new THREE.Vector3(), normal: new THREE.Vector3(), incident: new THREE.Vector3(),
      surface: 'concrete', surfaceIndex: 0, damage: 0, exit: false,
      object: null, body: null, actor: null, part: null,
    });
  }
  phys._impactCursor = 0;
  phys._impactResult = [];
  phys.ballistics = new Ballistics(phys);

  const hit = {
    hit: false, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 },
    distance: 0, surface: 'concrete', surfaceIndex: 0, object: null, collider: null,
    body: null, ragdoll: null, actor: null, part: null, frontFace: true, fraction: 0,
  };
  /* Both call shapes, exactly as the real one accepts them. */
  phys.raycast = (a, b, c, d, e, f, g) => {
    let ox, oy, oz, dx, dy, dz, maxDist;
    if (typeof a === 'number') { ox = a; oy = b; oz = c; dx = d; dy = e; dz = f; maxDist = g; }
    else { ox = a.x; oy = a.y; oz = a.z; dx = b.x; dy = b.y; dz = b.z; maxDist = c; }
    if (maxDist === undefined) maxDist = 1000;
    hit.hit = false;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    if (Math.abs(dx) < 1e-6) return hit;
    let best = Infinity;
    let face = null;
    for (const fc of [{ x: WALL_X, front: true, n: -1 }, { x: WALL_X + WALL_T, front: false, n: 1 }]) {
      const t = (fc.x - ox) / dx;
      if (t < 1e-5 || t > maxDist) continue;
      if (t < best) { best = t; face = fc; }
    }
    if (!face) return hit;
    hit.hit = true;
    hit.distance = best;
    hit.point.x = ox + dx * best; hit.point.y = oy + dy * best; hit.point.z = oz + dz * best;
    hit.normal.x = face.n; hit.normal.y = 0; hit.normal.z = 0;
    hit.surfaceIndex = wallSurface;
    hit.object = WALL_OBJ;
    hit.frontFace = face.front;
    hit.collider = null; hit.body = null; hit.actor = null; hit.part = null;
    hit.fraction = best / maxDist;
    return hit;
  };
  ctx._sys.physics = phys;
  return phys;
}

/**
 * The production `FxSystem.onImpact` and the production per-surface recipes,
 * with the GPU particle ring replaced by a recorder. `emitAdd` / `emitLit` are
 * instance fields on the real class, which is precisely the seam: everything
 * upstream of them is untouched production code and the record they receive is
 * the one that would have been uploaded.
 */
function makeFx(ctx, rec) {
  const fx = Object.create(FxSystem.prototype);
  fx.ctx = ctx;
  fx.rng = new Rng(777);
  fx.stats = { spawned: 0 };
  fx.pScale = 1;
  fx.now = 0;
  fx.gravity = -9.81;
  fx.paintTint = new THREE.Vector3(0.36, 0.09, 0.055);
  fx.wetness = 0;
  /* A production field: `stageImpact` sets it for the same reason. Decals are
   * not what this gate measures. */
  fx._suppressDecals = true;
  /* The refraction sprite pool. A steel hit asks for one shimmer; it carries no
   * energy term this gate reads, and it is a separate scene from the particle
   * rings. */
  fx.hazeSys = { emit: NOOP };
  fx._d2 = new THREE.Vector3();
  fx._physics = ctx.peek('physics');
  fx.emitAdd = (s) => { if (rec.cur) rec.cur.parts.push({ layer: 'add', ...s }); };
  fx.emitLit = (s) => { if (rec.cur) rec.cur.parts.push({ layer: 'lit', ...s }); };
  ctx._sys.fx = fx;
  /* Opened BEFORE fx's own listener, so every particle the recipe emits lands
   * in the bucket for the impact that caused it. */
  ctx.events.on('bullet:impact', (e) => {
    rec.cur = { surface: e.surface, exit: e.exit === true, parts: [] };
    rec.impacts.push(rec.cur);
  });
  ctx.events.on('bullet:impact', (e) => fx.onImpact(e));
  return fx;
}

function makeVehicles(ctx) {
  const sys = {
    ctx,
    vehicles: [],
    rng: new Rng(20260728),
    mats: STUB_MATS,
    physics: ctx.peek('physics'),
    lodOf: () => 0,
    surfaceAt: () => 'asphalt',
    waterHeightAt: () => null,
    gripOf: () => ({ mu: 1, roll: 1, drag: 0, noise: 0, skid: 1, dust: 0 }),
    _world: () => null,
    /* The production method AND the production field — never a copy of the
     * number. `actorDamageScale` is a class field, so it comes off a real
     * instance's prototype chain by construction here. */
    actorDamageScale: new VehicleSystem().actorDamageScale,
    damage: VehicleSystem.prototype.damage,
    _explosionDamage: VehicleSystem.prototype._explosionDamage,
  };
  ctx._sys.vehicles = sys;
  return sys;
}

let _carSeed = 1;
function spawnCar(sys, type, x, z) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const model = { root: null, wheels: [], panels: [], glassMeshes: [], lampMats: {}, paintMat: null };
  const v = new Vehicle(sys, spec, model, {});
  v.damage = new DamageModel(v, STUB_MATS, new Rng(_carSeed++));
  v.setPose(new THREE.Vector3(x, spec.comY, z), 0);
  sys.vehicles.push(v);
  return v;
}

/* ========================================================================== */
/*  The instrument                                                            */
/* ========================================================================== */

const FLASH_TILES = new Set([P.FLASH_CORE, P.FLASH_LOBE]);

/** The impact flash: the first additive particle the recipe emits. */
function flashOf(imp) {
  for (const p of imp.parts) if (p.layer === 'add') return p;
  return null;
}

function sparkStats(imp) {
  let n = 0;
  let vmax = 0;
  for (const p of imp.parts) {
    if (p.tile !== P.STREAK && p.tile !== P.SPARK) continue;
    n++;
    const v = Math.hypot(p.vx, p.vy, p.vz);
    if (v > vmax) vmax = v;
  }
  return { n, vmax };
}

/**
 * One shot, one swing, or one round into the wall. Returns what came out of the
 * emitter — never what went in.
 */
function measure(o) {
  const ctx = makeCtx();
  makePhysics(ctx, o.surface ?? SURFACE.concrete);
  const rec = { impacts: [], cur: null };
  makeFx(ctx, rec);
  const veh = makeVehicles(ctx);
  const def = ALL_WEAPONS[o.weapon];
  if (!def) return { error: 'no weapon ' + o.weapon };

  if (o.melee) {
    const cars = new VehicleHitTest(ctx);
    cars.fxVehicleScale = !!o.nc;
    spawnCar(veh, 'sedan', 2.2, 0);
    cars.sweep(new THREE.Vector3(0, 1.2, 0), new THREE.Vector3(1, 0, 0), def, 1);
  } else {
    const sim = new ProjectileSim(ctx, null);
    sim.cars.fxVehicleScale = !!o.nc;
    if (o.target === 'car') spawnCar(veh, 'sedan', WALL_X - 1.2, 0);
    sim.spawn({
      origin: new THREE.Vector3(0, 0.9, 0),
      dir: new THREE.Vector3(1, 0, 0),
      speed: def.muzzleVelocity,
      damage: def.damage,
      penetration: def.penetration,
      dragK: def.dragK,
      dropoff: def.dropoff,
      maxRange: def.maxRange,
      weapon: def,
      tracer: false,
    });
    for (let i = 0; i < 600 && rec.impacts.length === 0; i++) sim.fixedUpdate(1 / 120);
  }

  const entries = rec.impacts.filter((i) => !i.exit);
  const imp = entries[0] ?? null;
  const flash = imp ? flashOf(imp) : null;
  const sp = imp ? sparkStats(imp) : { n: 0, vmax: 0 };
  return {
    entries: entries.length,
    surface: imp?.surface ?? null,
    parts: imp?.parts.length ?? 0,
    flashI0: flash?.i0 ?? 0,
    flashSize1: flash?.size1 ?? 0,
    flashTile: flash?.tile ?? -1,
    sparks: sp.n,
    sparkVmax: sp.vmax,
  };
}

/* The matrix. Ordered by the weapon's place in the arsenal, lightest first —
 * the ORDER is the assertion, and it comes from `lib.js`, not from this file. */
const GUNS = ['smg', 'nailgun', 'rivetgun', 'speargun', 'harpoon'];
const SWINGS = ['crowbar', 'pipe', 'wrench'];
/**
 * WHY THESE SURFACES. The instrument reads the impact FLASH, and only three of
 * the recipes in `impacts.js` emit one: concrete, metal and carpaint. Wood,
 * glass, plaster, dirt and gravel answer a round with splinters, shards and
 * dust — measurable, but not on this scale — and asphalt/sidewalk/gravel/
 * carpaint cannot be requested through `physics.SURFACE` at all (see the
 * surface-enum note at the foot of this file).
 */
const TARGETS = [
  { id: 'car', target: 'car', surface: SURFACE.concrete },
  { id: 'concrete', target: 'wall', surface: SURFACE.concrete },
  { id: 'metal', target: 'wall', surface: SURFACE.metal },
];

function runArm(nc) {
  const arm = { guns: {}, swings: {} };
  for (const t of TARGETS) {
    arm.guns[t.id] = {};
    for (const w of GUNS) {
      arm.guns[t.id][w] = measure({ weapon: w, target: t.target, surface: t.surface, nc });
    }
  }
  for (const w of SWINGS) arm.swings[w] = measure({ weapon: w, melee: true, nc });
  return arm;
}

/* ========================================================================== */
/*  Run                                                                       */
/* ========================================================================== */

const fixed = runArm(false);
const broken = runArm(true);
/* `--nc` asserts against the arm with the fix disabled, and it must go red. */
const A = NC ? broken : fixed;

/** Emitted flash, as a fraction of the heaviest hit's flash ON THE SAME
 *  SURFACE. Dimensionless, so no recipe coefficient survives into a threshold. */
function frac(group, w) { return group[w].flashI0 / group.harpoon.flashI0; }
function display(group, w) { return SAT_DISPLAY * frac(group, w); }

/* ---- 1. the instrument -------------------------------------------------- */
{
  let oneEntry = true;
  let isFlash = true;
  for (const t of TARGETS) {
    for (const w of GUNS) {
      const r = A.guns[t.id][w];
      if (r.entries !== 1) oneEntry = false;
      if (!FLASH_TILES.has(r.flashTile)) isFlash = false;
    }
  }
  for (const w of SWINGS) {
    const r = A.swings[w];
    if (r.entries !== 1) oneEntry = false;
    if (!FLASH_TILES.has(r.flashTile)) isFlash = false;
  }
  check('instrument', 'exactly one entry impact per hit', oneEntry,
    'every shot and swing produced 1 non-exit bullet:impact');
  check('instrument', 'the measured particle is the impact flash', isFlash,
    'first additive particle is FLASH_CORE or FLASH_LOBE');
  /* The saturation the whole defect turns on, proven from emitted values: two
   * DIFFERENT rounds landing on one surface with the identical flash. */
  const c = A.guns.concrete;
  const sat = Math.abs(c.speargun.flashI0 - c.harpoon.flashI0) < 1e-9;
  check('instrument', 'the burst really does saturate', sat,
    'speargun ' + c.speargun.flashI0.toFixed(3) + ' == harpoon ' + c.harpoon.flashI0.toFixed(3) +
    ' on concrete, so the top of the scale is a ceiling and not a range');
}

/* ---- 2. a car is not one number ----------------------------------------- */
{
  const g = A.guns.car;
  let rising = true;
  let prev = -1;
  for (const w of GUNS) {
    const v = g[w].flashI0;
    if (v <= prev + 1e-9) rising = false;
    prev = v;
  }
  check('car', 'the burst rises with the round', rising,
    GUNS.map((w) => w + ' ' + display(g, w).toFixed(3)).join('  '));

  const light = frac(g, 'nailgun');
  check('car', 'a nail is not a maximal burst', light <= 0.75,
    'nailgun / harpoon = ' + light.toFixed(3) + ' (must be <= 0.75; it is 1.000 when the ' +
    'vehicle-scale number reaches the FX slot)');

  const sw = A.swings;
  const swRising = sw.crowbar.flashI0 < sw.pipe.flashI0 - 1e-9 &&
                   sw.pipe.flashI0 < sw.wrench.flashI0 - 1e-9;
  check('car', 'the swing rises with the weapon', swRising,
    SWINGS.map((w) => w + ' ' + (SAT_DISPLAY * sw[w].flashI0 / g.harpoon.flashI0).toFixed(3)).join('  '));

  const swLight = sw.wrench.flashI0 / g.harpoon.flashI0;
  check('car', 'a wrench is not a harpoon', swLight <= 0.75,
    'wrench / harpoon = ' + swLight.toFixed(3));
}

/* ---- 3. the same round, a car and a wall -------------------------------- */
{
  /* Both sides are already normalised by their own surface's heaviest hit, so
   * this compares behaviour and not two recipes' flash coefficients. A panel
   * eats a fraction of a round, so the car must sit a little UNDER the wall —
   * and nowhere near above it. */
  for (const w of ['smg', 'nailgun', 'rivetgun']) {
    const r = frac(A.guns.car, w) / frac(A.guns.concrete, w);
    check('surface', 'car vs concrete: ' + w, r >= 0.75 && r <= 0.99,
      'ratio ' + r.toFixed(3) + '  (car ' + display(A.guns.car, w).toFixed(3) +
      ', concrete ' + display(A.guns.concrete, w).toFixed(3) + ')');
  }
}

/* ---- 4. the heavy round still out-sparks the nail, everywhere ----------- */
{
  for (const t of TARGETS) {
    const g = A.guns[t.id];
    const r = g.harpoon.flashI0 / g.nailgun.flashI0;
    check('spread', 'harpoon out-sparks nailgun on ' + t.id, r >= 1.25,
      'x' + r.toFixed(3) + '  (nail ' + display(g, 'nailgun').toFixed(3) +
      ', harpoon ' + display(g, 'harpoon').toFixed(3) + ')');
  }
}

/* ---- 5. control: the change is confined to vehicles --------------------- */
{
  let worldSame = true;
  for (const t of TARGETS) {
    if (t.id === 'car') continue;
    for (const w of GUNS) {
      if (Math.abs(fixed.guns[t.id][w].flashI0 - broken.guns[t.id][w].flashI0) > 1e-9) worldSame = false;
    }
  }
  check('control', 'no world surface moved', worldSame,
    'concrete and metal emit bit-identical flashes with the fix on and off');

  /* A hit already at the ceiling with the fix IN cannot move when the fix comes
   * out — there is nowhere above the ceiling to go. The harpoon is the one
   * weapon in the arsenal that saturates a car panel on its own merits, so it
   * is the one vehicle hit this control cannot speak for; every other must
   * move. That exemption is derived from the EMITTED ceiling, not asserted. */
  const ceiling = Math.max(...GUNS.map((w) => fixed.guns.car[w].flashI0));
  let expected = 0;
  let moved = 0;
  const stuck = [];
  for (const w of GUNS) {
    if (fixed.guns.car[w].flashI0 >= ceiling - 1e-9) continue;
    expected++;
    if (Math.abs(fixed.guns.car[w].flashI0 - broken.guns.car[w].flashI0) > 1e-9) moved++;
    else stuck.push('gun/' + w);
  }
  for (const w of SWINGS) {
    if (fixed.swings[w].flashI0 >= ceiling - 1e-9) continue;
    expected++;
    if (Math.abs(fixed.swings[w].flashI0 - broken.swings[w].flashI0) > 1e-9) moved++;
    else stuck.push('swing/' + w);
  }
  check('control', 'every unsaturated vehicle hit moved', moved === expected && expected > 0,
    moved + ' of ' + expected + ' vehicle hits changed when the scale conversion was disabled' +
    (stuck.length ? '  UNMOVED: ' + stuck.join(',') : ''));
}

/* ========================================================================== */
/*  Report                                                                    */
/* ========================================================================== */

log('');
log('SPARK GATE' + (NC ? '   [NEGATIVE CONTROL: vehicle-scale damage in the FX slot]' : ''));
log('  emitted impact-flash intensity, as fx energy (ceiling ' + SAT_DISPLAY.toFixed(2) + ')');
log('');
{
  const head = ['weapon   '].concat(TARGETS.map((t) => t.id.padStart(9)));
  log('  ' + head.join(' '));
  for (const w of GUNS) {
    const row = [w.padEnd(9)];
    for (const t of TARGETS) row.push(display(A.guns[t.id], w).toFixed(3).padStart(9));
    log('  ' + row.join(' '));
  }
  log('');
  for (const w of SWINGS) {
    log('  ' + w.padEnd(9) + (SAT_DISPLAY * A.swings[w].flashI0 / A.guns.car.harpoon.flashI0)
      .toFixed(3).padStart(9) + '   (swing)');
  }
}
if (VERBOSE) {
  log('');
  log('  raw emitted records');
  for (const t of TARGETS) {
    for (const w of GUNS) {
      const r = A.guns[t.id][w];
      log('    ' + (t.id + '/' + w).padEnd(20) + 'surface=' + String(r.surface).padEnd(10) +
        'flashI0=' + r.flashI0.toFixed(3).padStart(8) +
        ' flashSize1=' + r.flashSize1.toFixed(4).padStart(8) +
        ' sparks=' + String(r.sparks).padStart(3) +
        ' vmax=' + r.sparkVmax.toFixed(2).padStart(6) +
        ' particles=' + r.parts);
    }
  }
}

log('');
let section = null;
for (const r of results) {
  if (r.section !== section) { section = r.section; log('  [' + section + ']'); }
  log('    ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.name.padEnd(44) + (r.detail ?? ''));
}
log('');
log('  ' + (results.length - failed) + '/' + results.length + ' checks' +
  (failed ? '   ' + failed + ' FAILED' : ''));
log('');

if (JSON_OUT) {
  console.log(JSON.stringify({ nc: NC, results, fixed, broken }, null, 2));
}
process.exit(failed ? 1 : 0);

/* =============================================================================
 * FOUND WHILE BUILDING THIS, NOT FIXED HERE — the surface enum is short.
 * =============================================================================
 * Run with `--verbose` and read the `surface=` column: a round on a CAR reports
 * `concrete`, and so does a swing.
 *
 * ARCHITECTURE.md's surface vocabulary has seventeen names and lists
 * `carpaint`, `asphalt`, `sidewalk` and `gravel` among them. `fx/impacts.js`
 * has a full authored recipe for all four (`carpaint` is 90 lines: paint flakes
 * in the car's own colour showing primer as they tumble, a scorched-clearcoat
 * wisp, a metal bullet hole), and `audio/foley.js` has a `carpaint` impact
 * voice. But `physics/surfaces.js` `SURFACE_NAMES` has only TWELVE entries and
 * none of those four is one of them, so `surfaceName(si)` can never return
 * them and `phys.SURFACE.carpaint` is `undefined`.
 *
 * Both vehicle call sites already ask for it the right way —
 * `phys.SURFACE?.carpaint ?? ...` — and fall back to index 0. So every bullet
 * and every swing on every car in the game is drawn and played as CONCRETE:
 * pale mortar dust off a door skin, and no paint flake has ever been emitted in
 * this game. The same is true of every round that hits a road (`asphalt`).
 *
 * That is a `physics` fact in a `physics` file, so it is reported rather than
 * patched. The fix is to extend `SURFACE_NAMES` and `SURFACE_PROPS` in
 * `src/physics/surfaces.js` with the four missing names — appending keeps every
 * existing index stable, which matters because the index is stored per triangle
 * — e.g.
 *
 *     'carpaint'  { penDepth: 0.012, energyLoss: 0.72, deflect: 0.07,
 *                   friction: 0.5, restitution: 0.4, density: 7800,
 *                   hardness: 0.9, shatters: false }
 *
 * Nothing in `weapons` or `fx` needs to change when it lands: the `?? 0`
 * fallbacks stop firing and the authored recipes start being reached. This
 * gate is written to survive it — every threshold is normalised by the
 * heaviest hit ON THE SAME SURFACE, so the car row may change recipe without
 * changing a single assertion.
 */
