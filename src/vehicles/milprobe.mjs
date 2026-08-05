#!/usr/bin/env node
/**
 * MIL PROBE — the tank, gated on EMITTED results (rule 12 throughout).
 *
 *   node src/vehicles/milprobe.mjs            (~1 s, node only, no browser)
 *
 * WHAT IT PROVES, and how each claim is measured:
 *
 *   DRIVE    the real `Vehicle` at the real 120 Hz step on a flat world:
 *            it launches (emitted forward speed), tops out in the tracked
 *            band ~14 m/s (emitted, not `topSpeedEst`), pivots at low speed
 *            (turn radius from emitted speed / emitted yaw rate), and the
 *            hull stays FLAT in the hardest corner it can hold (emitted bank
 *            angle, against a sedan's on the same measure).
 *
 *   MASS     it SHOVES a parked sedan aside through the production
 *            `_vehicleCollisions` / `_pairResolve`, barely slowing, barely
 *            scratched — measured on both bodies' emitted positions, speeds
 *            and health.
 *
 *   ARMOUR   the REAL Scrap Rocket numbers (`ALL_WEAPONS.rocket`, the same
 *            table the weapon fires with) emitted as the canonical
 *            `explosion` event into the production `_explosionDamage`:
 *            the sedan is written off, the tank shrugs it. NEGATIVE CONTROL:
 *            the identical tank with a sedan's `body.hp` dies to the same
 *            blast — so the gate is measuring the armour, not the class id.
 *
 *   TURRET   `aimTurret` slews at a BOUNDED rate (emitted yaw part-way
 *            through the traverse is far from the target; converged after),
 *            and elevation clamps at the spec limits.
 *
 *   SHELL    `fireShell` -> a ballistic shell stepped by the production
 *            `stepShells` inside the production `fixedUpdate` -> ONE
 *            canonical `explosion` event whose PAYLOAD POSITION lands within
 *            metres of the commanded world point — the event and the impact
 *            are measured, never the inputs. The same landed shell damages a
 *            sedan parked at the aim point THROUGH the same event listener
 *            the Scrap Rocket uses (no parallel damage path to go stale).
 *            NEGATIVE CONTROL: fire the instant the aim is commanded, while
 *            the barrel still points down +z, and the shell lands tens of
 *            metres from the aim point — the gate reads the barrel, not the
 *            order. Reload: a second trigger inside ~4 s returns null and
 *            emits nothing; after the reload it fires again. Recoil moves
 *            the hull (emitted velocity). The muzzle event (`weapon:fire`,
 *            what `fx`/`audio`/`police` consume) leaves from the emitted
 *            barrel tip, along it.
 *
 *   MESH     the emitted LOD0 geometry: a turret band above the hull with a
 *            >4 m gun tube, a glacis whose emitted top line FALLS toward the
 *            bow (NEGATIVE CONTROL: flatten `glacis.drop` and the detector
 *            reads flat), full-length dark track bands with road wheels
 *            below the skirt line, and a paint pool disjoint from every
 *            civilian pool.
 *
 * Thresholds marked RATCHET record where the tuning got to, with margin;
 * lower them when you improve the machine, never raise one to go green.
 */

import * as THREE from 'three';
import { VEHICLE_SPECS, CLASS_IDS, PAINTS, finalizeSpec, SURFACE_GRIP } from './specs.js';
import { Vehicle } from './dynamics.js';
import { VehicleSystem, ACTOR_TO_VEHICLE } from './index.js';
import { DamageModel } from './damage.js';
import { buildTankBody } from './tank.js';
import { ALL_WEAPONS } from '../weapons/lib.js';
import { Rng } from '../core/rng.js';

const DT = 1 / 120;
const DEG = 180 / Math.PI;
const VERBOSE = process.argv.includes('--verbose');

let pass = 0;
let fail = 0;
const fails = [];
function check(section, label, ok, detail) {
  if (ok) pass++;
  else { fail++; fails.push(`${section}: ${label} — ${detail}`); }
  if (!ok || VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${label}  (${detail})`);
}

/* ------------------------------------------------------------------ */
/* Harness: a flat concrete world + the PRODUCTION system methods      */
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
  return {
    time: { elapsed: 0, alpha: 1 },
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
    peek: () => null,
    get: () => null,
  };
}

/**
 * Flat ground plane through y = 0 (the flightprobe shape) married to the
 * PRODUCTION VehicleSystem methods for stepping, collisions, damage, blast
 * and the main gun — nothing about the machinery under test is re-stated.
 */
function makeSys() {
  const ctx = makeCtx();
  const HIT = {
    hit: true, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
    distance: 0, surface: 'concrete', object: null,
  };
  const grip = {};
  for (const k in SURFACE_GRIP) grip[k] = { ...SURFACE_GRIP[k] };
  const sys = {
    ctx,
    vehicles: [],
    rng: new Rng(20260804),
    mats: STUB_MATS,
    physics: {
      MASK: { WORLD: 3 },
      staticWorld: null,
      spawnDebris: NOOP,
      emitImpact: NOOP,
      raycast(o, d, maxDist) {
        if (Math.abs(d.y) < 1e-6) { HIT.hit = false; return HIT; }
        const t = -o.y / d.y;
        if (t < 0 || t > maxDist) { HIT.hit = false; return HIT; }
        HIT.hit = true;
        HIT.distance = t;
        HIT.point.set(o.x + d.x * t, 0, o.z + d.z * t);
        return HIT;
      },
      groundHeight: () => 0,
    },
    lodOf: () => 0,
    surfaceAt: () => 'concrete',
    waterHeightAt: () => null,
    gripOf: (n) => grip[n] ?? grip.asphalt,
    _world: () => null,
    _stats: { count: 0, lod: [0, 0, 0, 0], stepMs: 0 },
    actorDamageScale: ACTOR_TO_VEHICLE,
    // The production machinery, on this object:
    fixedUpdate: VehicleSystem.prototype.fixedUpdate,
    _vehicleCollisions: VehicleSystem.prototype._vehicleCollisions,
    _pairResolve: VehicleSystem.prototype._pairResolve,
    reportCollision: VehicleSystem.prototype.reportCollision,
    damage: VehicleSystem.prototype.damage,
    _explosionDamage: VehicleSystem.prototype._explosionDamage,
    aimTurret: VehicleSystem.prototype.aimTurret,
    fireShell: VehicleSystem.prototype.fireShell,
    nearest: VehicleSystem.prototype.nearest,
  };
  // The rocket's wiring, exactly as `VehicleSystem.init` installs it.
  ctx.events.on('explosion', (e) => sys._explosionDamage(e));
  return sys;
}

let _seed = 1;
function spawn(sys, type, x = 0, z = 0, yaw = 0, mutate = null) {
  let src = VEHICLE_SPECS[type];
  if (mutate) {
    src = structuredClone(src);
    mutate(src);
    src._final = false;
  }
  const spec = finalizeSpec(src);
  const v = new Vehicle(sys, spec, stubModel(), {});
  v.damage = new DamageModel(v, STUB_MATS, new Rng(_seed++));
  v.setPose(new THREE.Vector3(x, spec.comY + 0.02, z), yaw);
  // A crewed machine: without a driver the sleep latch parks the solver after
  // 1.2 s of stillness and a launch-from-rest test would measure a sleeping
  // body. The one check that WANTS the sleeper (the emplacement slew) clears
  // this itself.
  v.driver = { npc: true };
  sys.vehicles.push(v);
  return v;
}

/** Drive the whole system `seconds` forward through the production loop. */
function run(sys, seconds, inputs = null) {
  const n = Math.round(seconds * 120);
  for (let i = 0; i < n; i++) {
    if (inputs) inputs();
    sys.fixedUpdate(DT, sys.ctx);
    sys.ctx.time.elapsed += DT;
  }
}

const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
function bankOf(v) {
  _r.set(1, 0, 0).applyQuaternion(v.quaternion);
  _u.set(0, 1, 0).applyQuaternion(v.quaternion);
  return Math.atan2(_r.y, _u.y);
}

/* ================================================================== */
/* 1. ENTER + CHEAT MENU + SEAT                                       */
/* ================================================================== */
function testEnter() {
  check('cheats', 'tank is in CLASS_IDS (the table the cheat menu enumerates)',
    CLASS_IDS.includes('tank'), `CLASS_IDS: ${CLASS_IDS.join(',')}`);

  const sys = makeSys();
  const v = spawn(sys, 'tank', 40, -12);
  const TAKEABLE = (x) => !!x && !x.destroyed && x.enterable !== false;
  const found = sys.nearest(40, 1.2, -12, 6, TAKEABLE);
  check('enter', 'a parked tank is offered by the F scan predicate',
    found === v, `nearest returned ${found === v ? 'it' : found}`);

  const a = VehicleSystem.prototype.seatAnchor.call({}, v, 0);
  const st = v.spec.style;
  const finite = !!a && [a.position.x, a.position.y, a.position.z,
    a.enter.x, a.enter.y, a.enter.z, a.yaw].every(Number.isFinite);
  const headY = finite ? a.local.y + v.spec.comY : NaN;
  check('enter', 'seat anchor is finite, head up in the hull/turret band',
    finite && headY > st.hull.y1 && headY < st.roofY,
    finite ? `head y ${headY.toFixed(2)} in (${st.hull.y1}, ${st.roofY})` : 'anchor not finite');

  // Livery: the armour pool resolves and shares nothing with civilian pools.
  const mil = new Set((PAINTS.milarmor ?? []).map((p) => p.color));
  let shared = 0;
  for (const pool of ['common', 'loud', 'work', 'police']) {
    for (const p of PAINTS[pool]) if (mil.has(p.color)) shared++;
  }
  check('livery', 'milarmor pool exists and is disjoint from civilian paint',
    mil.size > 0 && shared === 0 && v.spec.paints[0] === 'milarmor',
    `${mil.size} drab coats, ${shared} shared with civilian pools`);
}

/* ================================================================== */
/* 2. DRIVE — tracked character, on the emitted motion                */
/* ================================================================== */
function testDrive() {
  {
    const sys = makeSys();
    const v = spawn(sys, 'tank');
    run(sys, 2); // settle
    run(sys, 6, () => { v.input.throttle = 1; });
    check('drive', 'launches under throttle', v.forwardSpeed > 8,
      `${v.forwardSpeed.toFixed(2)} m/s after 6 s (want > 8)`);
    run(sys, 24, () => { v.input.throttle = 1; });
    const top = v.forwardSpeed;
    check('drive', 'tops out in the tracked band, ~14 m/s not a car\'s 30+',
      top > 11.5 && top < 16.5, `${top.toFixed(2)} m/s emitted at full throttle`);
    run(sys, 4, () => { v.input.throttle = 0; v.input.brake = 1; });
    check('drive', 'brakes to a stand', v.speed < 0.8, `${v.speed.toFixed(2)} m/s after 4 s of brake`);
  }

  /* ---- pivot-y low-speed steering ---------------------------------- */
  {
    const sys = makeSys();
    const v = spawn(sys, 'tank');
    run(sys, 2);
    run(sys, 4, () => { v.input.throttle = 0.35; v.input.steer = 1; });
    // Steady state: radius = speed / |yaw rate|, both emitted.
    let yawRate = 0;
    let speed = 0;
    let n = 0;
    run(sys, 3, () => {
      v.input.throttle = 0.35; v.input.steer = 1;
      yawRate += Math.abs(v.angularVelocity.y); speed += v.speed; n++;
    });
    const radius = (speed / n) / Math.max(1e-3, yawRate / n);
    check('drive', 'pivots tight at crawl speed (turn radius under 9 m)',
      radius < 9, `emitted radius ${radius.toFixed(2)} m at ${(speed / n).toFixed(1)} m/s`);
  }

  /* ---- the flat hull ------------------------------------------------ */
  /**
   * MATCHED lateral acceleration, different machines. Protocol (measured
   * once, then frozen): launch straight, roll into the turn, average |bank|
   * and |yawRate * speed| over a 4 s steady window. The sedan corners at
   * steer 0.5 / throttle 0.25 — the hardest turn it holds without tripping
   * over its own outside tyres (full lock at speed genuinely rolls it, which
   * is a fine fact but not a usable yardstick) — and lands at the SAME
   * ~7.6 m/s^2 the tank's full-lock corner produces.
   *
   * MEASURED at the tuned spec: tank 2.65 deg at 7.72 m/s^2 (0.343 deg per
   * m/s^2) vs sedan 8.02 deg at 7.58 (1.058). Thresholds carry margin, and
   * the bank bound is a RATCHET — lower it if the hull gets flatter.
   *
   * NEGATIVE CONTROL: the identical tank at a car's comY (1.5) does not lean
   * a little more, it ROLLS OVER (emitted up-vector goes negative) — the
   * flat hull is the low CoM and the tuning, not the class id.
   */
  {
    const corner = (type, launch, thr, steer, mutate) => {
      const sys = makeSys();
      const v = spawn(sys, type, 0, 0, 0, mutate);
      run(sys, 2);
      run(sys, launch, () => { v.input.throttle = 1; });
      run(sys, 2.5, () => { v.input.throttle = thr; v.input.steer = steer; });
      let bank = 0;
      let acc = 0;
      let n = 0;
      let minUp = 1;
      run(sys, 4, () => {
        v.input.throttle = thr; v.input.steer = steer;
        bank += Math.abs(bankOf(v)); acc += Math.abs(v.angularVelocity.y * v.speed); n++;
        _u.set(0, 1, 0).applyQuaternion(v.quaternion);
        if (_u.y < minUp) minUp = _u.y;
      });
      return { bank: (bank / n) * DEG, acc: acc / n, minUp };
    };
    const t = corner('tank', 8, 0.6, 1);
    const s = corner('sedan', 4, 0.25, 0.5);
    const tPer = t.bank / Math.max(0.5, t.acc);
    const sPer = s.bank / Math.max(0.5, s.acc);
    check('drive', 'hull stays flat at full lock (near-zero body roll) — RATCHET',
      t.bank < 3.2 && t.acc > 6,
      `bank ${t.bank.toFixed(2)} deg at ${t.acc.toFixed(1)} m/s^2 (sedan: ${s.bank.toFixed(2)} at ${s.acc.toFixed(1)})`);
    check('drive', 'leans under half a sedan per unit of cornering at matched g',
      t.acc > s.acc - 2.5 && tPer < sPer / 2,
      `${tPer.toFixed(3)} vs sedan ${sPer.toFixed(3)} deg per m/s^2`);
    const neg = corner('tank', 8, 0.6, 1, (b) => { b.comY = 1.5; });
    check('drive', 'NEGATIVE CONTROL — at a car\'s comY the same corner rolls it over',
      neg.minUp < 0.5,
      `min emitted up.y ${neg.minUp.toFixed(2)} (tuned tank held ${t.minUp.toFixed(2)})`);
  }

  /* ---- mass: it pushes cars aside ----------------------------------- */
  {
    const sys = makeSys();
    const v = spawn(sys, 'tank');
    const car = spawn(sys, 'sedan', 0, 26);
    run(sys, 2);
    const carFrom = car.position.clone();
    run(sys, 6, () => { v.input.throttle = 1; });
    const pushed = car.position.distanceTo(carFrom);
    check('mass', 'shoves a parked sedan aside by mass',
      pushed > 2 && v.forwardSpeed > 5,
      `sedan displaced ${pushed.toFixed(2)} m, tank still doing ${v.forwardSpeed.toFixed(1)} m/s`);
    check('mass', 'the shunt costs the tank almost nothing',
      v.health > v.maxHealth * 0.97 && !v.destroyed,
      `health ${(100 * v.health / v.maxHealth).toFixed(1)}% after the hit`);
  }
}

/* ================================================================== */
/* 3. ARMOUR — the real rocket, one event, two bodies                 */
/* ================================================================== */
function testArmour() {
  const R = ALL_WEAPONS.rocket;
  const boom = (sys, at) => sys.ctx.events.emit('explosion',
    { position: at, radius: R.splash, damage: R.damage, source: 'rocket' });

  const sys = makeSys();
  const tank = spawn(sys, 'tank', 0, 0);
  const sedan = spawn(sys, 'sedan', 60, 0);
  run(sys, 1);
  boom(sys, sedan.position.clone().add(new THREE.Vector3(1.2, 0.3, 0)));
  boom(sys, tank.position.clone().add(new THREE.Vector3(1.2, 0.3, 0)));
  run(sys, 0.5);
  check('armour', 'the Scrap Rocket wrecks the sedan (the yardstick holds)',
    sedan.destroyed, `sedan health ${sedan.health.toFixed(0)}/${sedan.maxHealth}`);
  check('armour', 'the same rocket leaves the tank fighting',
    !tank.destroyed && tank.health > tank.maxHealth * 0.6,
    `tank health ${(100 * tank.health / tank.maxHealth).toFixed(1)}% (want > 60%)`);

  // NEGATIVE CONTROL: identical tank, sedan's hit points — the same blast
  // kills it, so the check above measures armour, not the class id.
  const sys2 = makeSys();
  const soft = spawn(sys2, 'tank', 0, 0, 0, (b) => {
    b.body = { ...b.body, hp: VEHICLE_SPECS.sedan.body.hp };
  });
  run(sys2, 1);
  boom(sys2, soft.position.clone().add(new THREE.Vector3(1.2, 0.3, 0)));
  run(sys2, 0.5);
  check('armour', 'NEGATIVE CONTROL — with sedan hp the same rocket kills it',
    soft.destroyed, `control health ${soft.health.toFixed(0)}/${soft.maxHealth}`);
}

/* ================================================================== */
/* 4. TURRET — bounded slew, clamped elevation                        */
/* ================================================================== */
function testTurret() {
  const sys = makeSys();
  const v = spawn(sys, 'tank');
  run(sys, 1);
  const T = v.spec.turret;

  // 90 degrees left. At yawRate rad/s the traverse takes ~1.75 s: part-way
  // through it must be genuinely part-way (bounded rate — a snap fails LOW,
  // a dead turret fails HIGH), converged by 3 s.
  const aim = new THREE.Vector3(-60, 1.8, 0);
  sys.aimTurret(v, aim);
  run(sys, 0.5);
  const early = Math.abs(v.turretYaw);
  run(sys, 2.5);
  const late = Math.abs(v.turretYaw);
  const want = Math.PI / 2;
  check('turret', 'slews at the bounded rate, not a snap',
    early > T.yawRate * 0.5 * 0.6 && early < want * 0.6,
    `|yaw| ${(early * DEG).toFixed(1)} deg after 0.5 s (rate ${T.yawRate} rad/s, target 90)`);
  check('turret', 'converges on the commanded bearing',
    Math.abs(late - want) < 0.03,
    `|yaw| ${(late * DEG).toFixed(2)} deg after 3 s (want 90)`);

  // Elevation clamps: a point overhead pins the gun at pitchMax.
  sys.aimTurret(v, new THREE.Vector3(-60, 80, 0));
  run(sys, 3);
  check('turret', 'elevation clamps at the spec limit',
    Math.abs(v.gunPitch - T.pitchMax) < 1e-3,
    `gunPitch ${v.gunPitch.toFixed(3)} rad (max ${T.pitchMax})`);

  /**
   * THE EMPLACEMENT CASE. A driverless parked tank is ASLEEP within 1.2 s —
   * `fixedUpdate` skips its physics entirely — and an AI turret gated behind
   * the physics step would freeze mid-traverse. `stepTurret` runs above the
   * sleep gate for exactly this reason: the hull may sleep, the turret slews.
   */
  {
    const sys2 = makeSys();
    const e = spawn(sys2, 'tank', 0, 0);
    e.driver = null;                       // an emplacement, not a crewed drive
    run(sys2, 3);                          // settle + pass the sleep latch
    check('turret', 'a parked emplacement hull is genuinely asleep',
      e.sleeping === true, `sleeping ${e.sleeping} after 3 s parked`);
    sys2.aimTurret(e, new THREE.Vector3(60, 1.8, 0));
    run(sys2, 1);
    check('turret', 'the turret slews while the hull sleeps (AI emplacement)',
      Math.abs(e.turretYaw) > 0.4 && e.sleeping === true,
      `|yaw| ${(Math.abs(e.turretYaw) * DEG).toFixed(1)} deg after 1 s, sleeping ${e.sleeping}`);
  }
}

/* ================================================================== */
/* 5. THE SHELL — the explosion event lands at the aim point          */
/* ================================================================== */
function testShell() {
  {
    const sys = makeSys();
    const v = spawn(sys, 'tank');
    run(sys, 1);
    const booms = [];
    const shots = [];
    sys.ctx.events.on('explosion', (e) => booms.push({
      x: e.position.x, y: e.position.y, z: e.position.z,
      radius: e.radius, damage: e.damage, source: e.source,
    }));
    sys.ctx.events.on('weapon:fire', (e) => shots.push({
      x: e.origin.x, y: e.origin.y, z: e.origin.z, dir: e.dir.clone(), weapon: e.weapon,
    }));

    const aim = new THREE.Vector3(48, 0, 44);
    sys.aimTurret(v, aim);
    run(sys, 3); // let the barrel get there
    const vel0 = v.velocity.clone();
    const shell = sys.fireShell(v);
    check('shell', 'fireShell returns a live shell once aimed', !!shell, `${shell}`);
    // Recoil is read at the muzzle, before the tracks get a step to absorb it.
    const kick = v.velocity.clone().sub(vel0).length();
    run(sys, 2); // flight + detonation through the production fixedUpdate

    check('shell', 'exactly one explosion event was emitted', booms.length === 1,
      `${booms.length} events`);
    const b = booms[0];
    const miss = b ? Math.hypot(b.x - aim.x, b.z - aim.z) : Infinity;
    check('shell', 'the EVENT lands within metres of the commanded point',
      miss < 6, `impact (${b?.x.toFixed(1)}, ${b?.z.toFixed(1)}) vs aim (48, 44): ${miss.toFixed(2)} m off`);
    check('shell', 'the payload speaks the rocket\'s vocabulary (radius + damage)',
      b && b.radius === v.spec.turret.shell.radius && b.damage === v.spec.turret.shell.damage,
      `radius ${b?.radius}, damage ${b?.damage}, source ${b?.source}`);

    // Muzzle: the weapon:fire event fx/audio/police consume, from the barrel.
    const m = shots[0];
    const muzzleDist = m ? Math.hypot(m.x - v.position.x, m.z - v.position.z) : 0;
    check('shell', 'weapon:fire leaves from the emitted barrel tip',
      shots.length === 1 && muzzleDist > 3.5 && muzzleDist < 8 && m.y > 1.4,
      `origin ${muzzleDist.toFixed(2)} m out at y ${m?.y.toFixed(2)}, weapon ${m?.weapon}`);

    // Recoil: the hull took the opposite impulse (captured at the muzzle).
    check('shell', 'recoil moves the hull', kick > 0.3,
      `|dv| ${kick.toFixed(2)} m/s at the shot`);

    // Reload: an immediate second trigger is refused and emits NOTHING;
    // after the reload window it fires again.
    const again = sys.fireShell(v);
    run(sys, 0.5);
    check('shell', 'a second trigger inside the reload is refused',
      again === null && booms.length === 1 && shots.length === 1,
      `returned ${again}, ${booms.length} booms, ${shots.length} muzzle events`);
    run(sys, 4.0);
    const third = sys.fireShell(v);
    check('shell', `fires again after the ~${v.spec.turret.reload} s reload`,
      !!third, `${third ? 'shell away' : 'still cold'} (gunCool was ticked by the production loop)`);
  }

  /* ---- damage flows through the SAME listener the rocket uses -------- */
  {
    const sys = makeSys();
    const v = spawn(sys, 'tank');
    const target = spawn(sys, 'sedan', 40, 40);
    run(sys, 1);
    const hp0 = target.health;
    sys.aimTurret(v, target.position);
    run(sys, 3);
    sys.fireShell(v);
    run(sys, 2);
    check('shell', 'a sedan at the aim point takes real blast damage',
      target.health < hp0 * 0.6,
      `health ${hp0.toFixed(0)} -> ${target.health.toFixed(0)} through the explosion listener`);
  }

  /* ---- NEGATIVE CONTROL: the gate reads the BARREL, not the order ---- */
  {
    const sys = makeSys();
    const v = spawn(sys, 'tank');
    run(sys, 1);
    const booms = [];
    sys.ctx.events.on('explosion', (e) => booms.push({ x: e.position.x, z: e.position.z }));
    const aim = new THREE.Vector3(0, 0, -70); // dead astern
    sys.fireShell(v, aim);                    // fire IMMEDIATELY — barrel still forward
    run(sys, 2);
    const b = booms[0];
    const miss = b ? Math.hypot(b.x - aim.x, b.z - aim.z) : Infinity;
    check('shell', 'NEGATIVE CONTROL — fired before the slew, the shell lands far from the order',
      booms.length === 1 && miss > 25,
      `impact ${miss === Infinity ? 'none' : miss.toFixed(1) + ' m'} from the un-slewed aim point`);
  }
}

/* ================================================================== */
/* 6. THE MESH — emitted geometry, negative-controlled                */
/* ================================================================== */
function vertsOf(geos) {
  const out = [];
  for (const g of geos ?? []) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) out.push([p.getX(i), p.getY(i), p.getZ(i)]);
  }
  return out;
}
/**
 * Max emitted y among verts with z in [z0, z1], restricted to the CENTRE
 * strip (|x| <= xMax) — the glacis question is about the nose PLATE, and the
 * track skirts run past the hull nose on both flanks, so an unfiltered max
 * reads the skirt's top edge instead of the armour.
 */
function topIn(verts, z0, z1, xMax = Infinity) {
  let m = -Infinity;
  for (const [x, y, z] of verts) {
    if (Math.abs(x) > xMax) continue;
    if (z >= z0 && z <= z1 && y > m) m = y;
  }
  return m;
}

function testMesh() {
  const spec = finalizeSpec(VEHICLE_SPECS.tank);
  const st = spec.style;
  const out = buildTankBody(spec, 0);

  // Turret: a band above the deck, and a long thin gun tube off it.
  const tv = vertsOf([out.turret.geo]);
  let turretTop = -Infinity;
  for (const [, y] of tv) if (y > turretTop) turretTop = y;
  check('mesh', 'the turret rises over the hull deck',
    st.turret.y + turretTop > st.hull.y1 + 0.5,
    `turret top ${(st.turret.y + turretTop).toFixed(2)} m vs deck ${st.hull.y1} m`);

  const gv = vertsOf([out.turret.gun.geo]);
  let gunLen = 0;
  let gunFat = 0;
  for (const [x, y, z] of gv) {
    if (z > gunLen) gunLen = z;
    const r = Math.hypot(x, y);
    if (z > 1.2 && r > gunFat) gunFat = r;
  }
  check('mesh', 'the gun is a LONG tube (the one-glance tank signature)',
    gunLen > 4.2 && gunFat < 0.25,
    `emitted barrel ${gunLen.toFixed(2)} m, outer radius past the mantlet ${gunFat.toFixed(3)} m`);

  // Glacis: the emitted top line FALLS toward the bow (centre strip only —
  // the skirts run past the hull nose and would mask the plate).
  const strip = st.hull.w * 0.4;
  const pv = vertsOf(out.paint);
  const atHull = topIn(pv, st.hull.z1 - 0.2, st.hull.z1 + 0.25, strip);
  const atBow = topIn(pv, st.glacis.z1 - 0.45, st.glacis.z1 + 0.1, strip);
  check('mesh', 'the glacis slopes — the nose plate leans back',
    atHull - atBow > 0.55,
    `top ${atHull.toFixed(2)} m at the deck edge -> ${atBow.toFixed(2)} m at the bow (drop ${(atHull - atBow).toFixed(2)})`);

  // NEGATIVE CONTROL: flatten the glacis and the detector must read flat.
  {
    const flat = structuredClone(VEHICLE_SPECS.tank);
    flat.style.glacis = { ...flat.style.glacis, drop: 0.05 };
    flat._final = false;
    const o2 = buildTankBody(finalizeSpec(flat), 0);
    const p2 = vertsOf(o2.paint);
    const d2 = topIn(p2, st.hull.z1 - 0.2, st.hull.z1 + 0.25, strip) -
      topIn(p2, flat.style.glacis.z1 - 0.45, flat.style.glacis.z1 + 0.1, strip);
    check('mesh', 'NEGATIVE CONTROL — a flattened glacis reads flat',
      d2 < 0.3, `control drop ${d2.toFixed(2)} m (variant was ${(atHull - atBow).toFixed(2)})`);
  }

  // Tracks: a dark band nearly the machine's whole length, BOTH sides, and
  // road wheels visible below the skirt's lower edge.
  const dark = vertsOf(out.trim);
  for (const side of [-1, 1]) {
    let z0 = Infinity;
    let z1 = -Infinity;
    let below = 0;
    for (const [x, y, z] of dark) {
      if (x * side < st.track.x0 - 0.05 || x * side > st.track.x1 + 0.15) continue;
      if (y > st.skirt.y1) continue;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
      if (y < st.skirt.y0 - 0.02) below++;
    }
    check('mesh', `track band runs the hull (${side < 0 ? 'port' : 'starboard'})`,
      z1 - z0 > 6.4 && below > 40,
      `${(z1 - z0).toFixed(1)} m of running gear, ${below} verts below the skirt line`);
  }
}

/* ================================================================== */
testEnter();
testDrive();
testArmour();
testTurret();
testShell();
testMesh();

console.log(`\nmilprobe: ${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('FAILURES:');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
