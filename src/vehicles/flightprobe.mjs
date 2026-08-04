#!/usr/bin/env node
/**
 * FLIGHT PROBE — the two flyable verbs, gated on EMITTED motion.
 *
 * The player wanted to fly: helicopters he can take from the airports, and a
 * fixed-wing aircraft he can fly a circuit in and land. This file gates both,
 * at the real 120 Hz `Vehicle.fixedStep`, and it asserts the position and
 * orientation the body ACTUALLY REACHES — never `input`, never the commanded
 * rate, never a lever. (Rule 12: a gate that re-reads the code's own inputs
 * checks nothing.)
 *
 * The helicopter's own flight envelope is gated in depth by `drivetest.mjs`
 * section 11; what this file adds for the helicopter is the two things that are
 * NEW — that a parked one is ENTERABLE through the exact predicate the F-action
 * uses (`freeroam.TAKEABLE`), found by the real `VehicleSystem.nearest`, and
 * that on the current key binding (SPACE, the handbrake channel) it climbs.
 *
 * For the aeroplane it gates the whole model:
 *   - a parked plane sits still on its gear;
 *   - throttle from a standstill builds AIRSPEED, and past flying speed the
 *     body LEAVES THE GROUND and gains ALTITUDE;
 *   - NEGATIVE CONTROL: with no throttle it never leaves the runway;
 *   - cut the throttle in the air and it slows below flying speed and DESCENDS
 *     (the stall — lift goes as V², so below flying speed the wing cannot hold
 *     the weight up whatever the stick does);
 *   - W/S move the emitted pitch the right way, A/D roll it and swing the
 *     heading round in a coordinated turn, and NO roll input holds the wings
 *     level (its negative control).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE VARIANTS
 * ────────────────────────────────────────────────────────────────────────────
 * Two aircraft VARIANTS ride the same two flight models with their own tuning
 * and their own airframes: the SKYWATCH 6 news helicopter (`newsheli`) and the
 * SLIPSTREAM low-wing sport plane (`sportplane`). This file gates that each
 * variant is a genuinely different machine, all of it measured on the EMITTED
 * result:
 *
 *   - the news heli CLIMBS: same 14 s of collective as the Riverhop, higher
 *     emitted altitude and vertical speed. NEGATIVE CONTROL: the same spec
 *     with the Riverhop's rotor block swapped in climbs exactly like a
 *     Riverhop — the gap is the tuning, not the class name.
 *   - the sport plane is FASTER: same seconds of full throttle as the
 *     Skylark, higher emitted airspeed — and TWITCHIER: the same second of
 *     aileron banks it further. NEGATIVE CONTROL: the Skylark's flight/aero
 *     blocks under the Slipstream's silhouette collapse the speed gap to
 *     nothing.
 *   - the SILHOUETTES differ, measured on the geometry the builders emit
 *     (never the style block): the Skylark's wing sits high over the fuselage
 *     centreline where the Slipstream's sits below it, their spans differ by
 *     over a metre, and the Skywatch is the better part of 1.5 m longer than
 *     the Riverhop with a visibly bigger rotor disc. NEGATIVE CONTROL: the
 *     Slipstream rebuilt with the Skylark's wing height reads as a high-wing,
 *     so the detector measures the wing, not the id.
 *   - every aircraft is in `CLASS_IDS` — the exact table `vehicles.classes`
 *     publishes and the cheat menu enumerates its spawn rows from — each one
 *     is offered by the real F-scan predicate once spawned, and each one's
 *     seat anchor (the thing the boarding animation aims at) is finite and
 *     inside its own cabin.
 *
 * Every threshold below is a MEASURED emitted quantity with a margin, and the
 * negative controls are run so the positive assertions mean something.
 *
 *   node src/vehicles/flightprobe.mjs
 */

import * as THREE from 'three';
import { VEHICLE_SPECS, CLASS_IDS, PAINTS, finalizeSpec, SURFACE_GRIP } from './specs.js';
import { Vehicle } from './dynamics.js';
import { VehicleSystem } from './index.js';
import { buildHeliBody } from './heli.js';
import { buildPlaneBody } from './plane.js';

const DT = 1 / 120;
const DEG = 180 / Math.PI;

let pass = 0;
let fail = 0;
const fails = [];
function check(section, label, ok, detail) {
  if (ok) pass++;
  else { fail++; fails.push(`${section}: ${label} — ${detail}`); }
  if (!ok || process.argv.includes('--verbose')) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${label}  (${detail})`);
  }
}

/* ------------------------------------------------------------------ */
/* A flat concrete world — the runway. Same shape drivetest uses.      */
/* ------------------------------------------------------------------ */
function makeWorld(slopeDeg = 0) {
  const a = (slopeDeg * Math.PI) / 180;
  const N = new THREE.Vector3(0, Math.cos(a), Math.sin(a)).normalize();
  const HIT = { hit: true, point: new THREE.Vector3(), normal: N.clone(), distance: 0, surface: 'concrete', object: null };
  const grip = {};
  for (const k in SURFACE_GRIP) grip[k] = { ...SURFACE_GRIP[k] };
  return {
    slope: 0,
    physics: {
      MASK: { WORLD: 3 }, staticWorld: null,
      raycast(o, d, maxDist) {
        const dn = N.dot(d);
        if (Math.abs(dn) < 1e-6) { HIT.hit = false; return HIT; }
        const t = -N.dot(o) / dn;
        if (t < 0 || t > maxDist) { HIT.hit = false; return HIT; }
        HIT.hit = true; HIT.distance = t;
        HIT.point.set(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
        HIT.normal.copy(N); return HIT;
      },
      // Ground plane through the origin with normal N: y = -(N.z z)/N.y.
      groundHeight: (x, z) => -(N.z * z) / N.y,
    },
    slope: a,
    lodOf: () => 0,
    surfaceAt: () => 'concrete',
    waterHeightAt: () => null,
    reportCollision: () => {},
    gripOf: (n) => grip[n] ?? grip.asphalt,
    _world: () => null,
  };
}
const STUB = { root: null, wheels: [], panels: [], glassMeshes: [], lampMats: {} };
const CTX = { events: { emit() {} }, peek: () => null, time: { elapsed: 0 } };

function spawnSpec(spec, { driver = true, slope = 0 } = {}) {
  const v = new Vehicle(makeWorld(slope), spec, STUB, {});
  v.damage = null;
  // Rest the gear/skids on the ground: CoM sits one gear-drop above it.
  // Keyed on KIND, not on the class id, so every variant of either flight
  // model is seated the way its own contact geometry dictates.
  const drop = spec.kind === 'heli'
    ? spec.comY - (spec.style.skidY - spec.style.skidR)
    : spec.comY - spec.style.gearY;
  v.setPose(new THREE.Vector3(0, drop, 0), 0);
  if (driver) v.driver = { isPlayer: true };
  // A player at the controls gets the auto-reverse steer sign; matching it here
  // keeps the A/D roll direction identical in the gate and in the game.
  v.autoReverse = true;
  return v;
}
function spawn(type, opts = {}) {
  return spawnSpec(finalizeSpec(VEHICLE_SPECS[type]), opts);
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

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
function basis(v) {
  _f.set(0, 0, 1).applyQuaternion(v.quaternion);
  _r.set(1, 0, 0).applyQuaternion(v.quaternion);
  _u.set(0, 1, 0).applyQuaternion(v.quaternion);
}
const fwdSpeed = (v) => { basis(v); return v.velocity.dot(_f); };
const pitchOf = (v) => { basis(v); return Math.asin(Math.max(-1, Math.min(1, _f.y))); };
const bankOf = (v) => { basis(v); return Math.atan2(_r.y, _u.y); };
const headingOf = (v) => { basis(v); return Math.atan2(_f.x, _f.z); };
function sideslip(v) {
  const q = v.quaternion.clone().invert();
  const vb = v.velocity.clone().applyQuaternion(q);
  return Math.atan2(vb.x, Math.max(Math.abs(vb.z), 2));
}

/* ================================================================== */
/* 1. THE ENTER PATH — a parked machine is offered by F               */
/* ================================================================== */
/**
 * `freeroam._vehicleNear` scans `vehicles.nearest(x,y,z, R.enter, TAKEABLE)`
 * and `TAKEABLE(v) = !!v && !v.destroyed && v.enterable !== false`. Both halves
 * are exercised against the REAL `VehicleSystem.nearest` and the REAL predicate
 * — not a re-read of a flag the spawn code set.
 */
function TAKEABLE(v) { return !!v && !v.destroyed && v.enterable !== false; }

/** Every flyable class. The variants ride the same two kinds. */
const AIRCRAFT = ['heli', 'newsheli', 'plane', 'sportplane'];

function testEnter() {
  for (const [type, ap] of [
    ['heli', [-1072, 784]], ['plane', [1032, -784]],
    // The variants spawn from the cheat menu wherever the player is standing;
    // the coordinates are arbitrary open ground, which is exactly the claim.
    ['newsheli', [220, -410]], ['sportplane', [-380, 96]],
  ]) {
    const v = spawn(type);
    v.position.set(ap[0], 0.6, ap[1]);
    const sys = { vehicles: [v] };
    const found = VehicleSystem.prototype.nearest.call(sys, ap[0], 1.5, ap[1], 6, TAKEABLE);
    check('enter', `a parked ${type} is offered by the F scan`,
      found === v && v.enterable !== false,
      `nearest returned ${found === v ? 'it' : found}, enterable=${v.enterable}`);
    // A wreck is not takeable — the other half of the predicate.
    v.destroyed = true;
    const gone = VehicleSystem.prototype.nearest.call(sys, ap[0], 1.5, ap[1], 6, TAKEABLE);
    check('enter', `a destroyed ${type} is NOT offered`, gone === null,
      `nearest returned ${gone === null ? 'null' : 'it'}`);
  }

  /**
   * THE CHEAT MENU'S TABLE. `src/ui/cheats.js` builds its spawn rows from
   * `vehicles.classes`, and `VehicleSystem` publishes `this.classes =
   * CLASS_IDS` — so membership in CLASS_IDS IS the wiring: an aircraft in this
   * table gets a SPAWN row with no edit to the menu, and one missing from it
   * cannot be offered at all.
   */
  for (const id of AIRCRAFT) {
    check('cheats', `${id} is in CLASS_IDS (the table the cheat menu enumerates)`,
      CLASS_IDS.includes(id), `CLASS_IDS: ${CLASS_IDS.join(',')}`);
  }

  /**
   * THE SEAT. `nearest` offering a machine is only half of enterable — the
   * boarding animation aims at `seatAnchor`, and for a fixed-wing that runs
   * the GENERIC cabin path, which reads style fields (`sillY`, `beltY`,
   * `cowlZ`) no aircraft used to carry: the emitted anchor was NaN. Assert the
   * anchor the real method emits is finite and the head sits inside the
   * machine's own cabin — between the cockpit floor and the roof, between the
   * cabin bulkheads.
   */
  for (const id of AIRCRAFT) {
    const v = spawn(id);
    v.position.set(50, 1.4, -20);
    const a = VehicleSystem.prototype.seatAnchor.call({}, v, 0);
    const finite = !!a && [a.position.x, a.position.y, a.position.z,
      a.enter.x, a.enter.y, a.enter.z, a.yaw].every(Number.isFinite);
    const st = v.spec.style;
    const headY = finite ? a.local.y + v.spec.comY : NaN;
    const inCabin = finite &&
      headY > st.floorY + 0.4 && headY < st.roofY &&
      a.local.z > (st.cabinZ0 ?? -2) - 0.05 && a.local.z < (st.cabinZ1 ?? 2) + 0.05;
    check('cheats', `${id} seat anchor is finite and inside the cabin`,
      finite && inCabin,
      finite
        ? `head y ${headY.toFixed(2)} (floor ${st.floorY}, roof ${st.roofY}), z ${a.local.z.toFixed(2)} in [${st.cabinZ0}, ${st.cabinZ1}]`
        : 'anchor is not finite');
  }
}

/* ================================================================== */
/* 2. HELICOPTER — enterable, and it climbs on SPACE                  */
/* ================================================================== */
function testHeli() {
  const v = spawn('heli');
  const y0 = v.position.y;
  fly(v, {}, 2);
  const idle = v.position.y - y0;
  // SPACE is the handbrake channel, and per the current binding it climbs.
  fly(v, { handbrake: true }, 14);
  const climbed = v.position.y - y0;
  check('heli', 'sits still on its skids with no collective', Math.abs(idle) < 0.05,
    `drifted ${idle.toFixed(4)} m in 2 s`);
  check('heli', 'climbs on SPACE (the handbrake channel)', climbed > 60 && v.velocity.y > 6,
    `+${climbed.toFixed(1)} m in 14 s at ${v.velocity.y.toFixed(2)} m/s, alt ${v.altitude.toFixed(1)} m`);

  // NEGATIVE CONTROL: nothing held, a spooled machine stays on the ground.
  const n = spawn('heli');
  const ny = n.position.y;
  fly(n, {}, 16);
  check('heli', 'NEGATIVE CONTROL — no collective, no climb',
    Math.abs(n.position.y - ny) < 0.1 && n.grounded >= 3,
    `moved ${(n.position.y - ny).toFixed(3)} m in 16 s, ${n.grounded} skids down`);
}

/* ================================================================== */
/* 3. AEROPLANE — the whole flight model                              */
/* ================================================================== */
function testPlane() {
  /* ---- parked: sits still on its gear -------------------------------- */
  {
    const v = spawn('plane');
    const p0 = v.position.clone();
    fly(v, {}, 3);
    const drift = Math.hypot(v.position.x - p0.x, v.position.z - p0.z);
    check('plane', 'parked, it settles on its gear and sits still',
      v.grounded >= 3 && Math.abs(v.velocity.y) < 0.1 && v.altitude < 0.15 && drift < 0.2,
      `grounded ${v.grounded}, vy ${v.velocity.y.toFixed(4)}, alt ${v.altitude.toFixed(3)}, drift ${drift.toFixed(3)} m`);
  }

  /* ---- parked on a SLOPE: it holds and settles, does not creep ------ */
  // The airfields sit on natural, gently sloped ground. It must not slide off.
  {
    const parked = spawn('plane', { driver: false, slope: 5 });
    fly(parked, {}, 3);              // settle onto the slope
    const p0 = parked.position.clone();
    fly(parked, {}, 6);
    const creep = Math.hypot(parked.position.x - p0.x, parked.position.z - p0.z);
    check('plane', 'parked on a 5 deg slope it settles and holds, no creep',
      creep < 0.4 && parked.grounded >= 3,
      `drifted ${creep.toFixed(3)} m in 6 s, ${parked.grounded} wheels down`);
  }

  /* ---- throttle builds airspeed, and it takes off -------------------- */
  {
    const v = spawn('plane');
    fly(v, { boost: 1 }, 12);
    const vRoll = fwdSpeed(v);
    check('plane', 'throttle from a standstill builds airspeed', vRoll > 25,
      `${vRoll.toFixed(1)} m/s along the nose after 12 s of throttle`);
    fly(v, { boost: 1 }, 14);
    check('plane', 'past flying speed it leaves the ground and climbs',
      v.altitude > 40 && v.velocity.y > 3,
      `altitude ${v.altitude.toFixed(1)} m, climb ${v.velocity.y.toFixed(2)} m/s`);
  }

  /* ---- NEGATIVE CONTROL: no throttle, no take-off -------------------- */
  {
    const v = spawn('plane');
    const y0 = v.position.y;
    fly(v, {}, 26);
    check('plane', 'NEGATIVE CONTROL — no throttle, it never leaves the runway',
      fwdSpeed(v) < 2 && v.altitude < 0.2 && Math.abs(v.position.y - y0) < 0.1 && v.grounded >= 3,
      `airspeed ${fwdSpeed(v).toFixed(2)} m/s, altitude ${v.altitude.toFixed(3)} m, ${v.grounded} wheels down`);
  }

  /* ---- the stall: below flying speed it descends -------------------- */
  {
    const v = spawn('plane');
    fly(v, { boost: 1 }, 26);
    const vCruise = fwdSpeed(v);
    // Chop the throttle (SPACE winds the lever down) and hold nothing else. It
    // trades what speed it has for a little height first (the phugoid), so the
    // claim is measured on a LATER window: once slow, is it losing altitude?
    fly(v, { handbrake: true }, 8);
    const altA = v.altitude;
    const vSlow = fwdSpeed(v);
    fly(v, { handbrake: true }, 6);
    const altB = v.altitude;
    check('plane', 'chop the throttle and airspeed bleeds off below flying speed',
      vSlow < vCruise - 8 && vSlow < 36,
      `${vCruise.toFixed(1)} -> ${vSlow.toFixed(1)} m/s`);
    check('plane', 'below flying speed the wing stalls and it descends',
      v.velocity.y < -2 && altB < altA - 5,
      `sink ${v.velocity.y.toFixed(2)} m/s, altitude ${altA.toFixed(1)} -> ${altB.toFixed(1)} m over the last 6 s`);
  }

  /* ---- pitch: W noses down, S noses up ------------------------------ */
  {
    const base = () => { const v = spawn('plane'); fly(v, { boost: 1 }, 18); return v; };
    const up = base(); fly(up, { boost: 0.5, brake: 1 }, 1.5);   // S
    const dn = base(); fly(dn, { boost: 0.5, throttle: 1 }, 1.5); // W
    const pUp = pitchOf(up), pDn = pitchOf(dn);
    check('plane', 'the elevator pitches it — S up, W down', pUp - pDn > 0.21,
      `pitch S ${(pUp * DEG).toFixed(1)} deg vs W ${(pDn * DEG).toFixed(1)} deg`);
  }

  /* ---- roll / yaw: A/D bank it and swing the heading, coordinated --- */
  {
    const base = () => { const v = spawn('plane'); fly(v, { boost: 1 }, 18); return v; };
    // D (steer +1). With the auto-reverse sign that is a roll RIGHT: the right
    // wing drops (bank < 0) and the heading swings right (heading increases).
    const rt = base(); const hR0 = headingOf(rt);
    fly(rt, { boost: 0.6, steer: 1 }, 1.2);
    const bankR = bankOf(rt), dHR = headingOf(rt) - hR0, slipR = sideslip(rt);
    // A (steer -1): roll LEFT — bank > 0, heading swings left.
    const lf = base(); const hL0 = headingOf(lf);
    fly(lf, { boost: 0.6, steer: -1 }, 1.2);
    const bankL = bankOf(lf), dHL = headingOf(lf) - hL0;

    check('plane', 'D rolls right and the heading swings right',
      bankR < -0.12 && dHR > 0.05,
      `bank ${(bankR * DEG).toFixed(1)} deg, heading +${(dHR * DEG).toFixed(1)} deg`);
    check('plane', 'A rolls left and the heading swings left',
      bankL > 0.12 && dHL < -0.05,
      `bank ${(bankL * DEG).toFixed(1)} deg, heading ${(dHL * DEG).toFixed(1)} deg`);
    check('plane', 'the banked turn stays coordinated (sideslip bounded)',
      Math.abs(slipR) < 25 / DEG,
      `sideslip ${(slipR * DEG).toFixed(1)} deg`);

    // NEGATIVE CONTROL: no aileron, the wings stay level and it flies straight.
    const st = base(); const hS0 = headingOf(st);
    fly(st, { boost: 0.6 }, 1.2);
    check('plane', 'NEGATIVE CONTROL — no aileron, wings stay level',
      Math.abs(bankOf(st)) < 0.09 && Math.abs(headingOf(st) - hS0) < 0.05,
      `bank ${(bankOf(st) * DEG).toFixed(1)} deg, heading drift ${((headingOf(st) - hS0) * DEG).toFixed(1)} deg`);
  }
}

/* ================================================================== */
/* 4. THE VARIANTS — same models, measurably different machines       */
/* ================================================================== */

/** Re-finalize a structured clone with overrides — the drivetest pattern. */
function variantSpec(type, mutate) {
  const base = structuredClone(VEHICLE_SPECS[type]);
  mutate(base);
  return finalizeSpec({ ...base, _final: false });
}

function testNewsHeli() {
  // Same 14 s of collective from the same cold start, both machines. The gap
  // is the tuning (climbUp 15.5 vs 12.0), read off the EMITTED altitude.
  const climb14 = (v) => {
    const y0 = v.position.y;
    fly(v, { handbrake: true }, 14);
    return v.position.y - y0;
  };
  const news = spawn('newsheli');
  const dNews = climb14(news);
  const river = spawn('heli');
  const dRiver = climb14(river);
  check('newsheli', 'climbs on SPACE, and faster than the Riverhop',
    dNews > 120 && news.velocity.y > 14 && dNews > dRiver + 25,
    `+${dNews.toFixed(1)} m at ${news.velocity.y.toFixed(2)} m/s vs Riverhop +${dRiver.toFixed(1)} m`);

  // Idle: a spooled news machine with no collective stays on its skids.
  const idle = spawn('newsheli');
  const iy = idle.position.y;
  fly(idle, {}, 3);
  check('newsheli', 'sits still on its skids with no collective',
    Math.abs(idle.position.y - iy) < 0.05 && idle.grounded >= 3,
    `drifted ${(idle.position.y - iy).toFixed(4)} m, ${idle.grounded} skids down`);

  // NEGATIVE CONTROL: the same airframe with the RIVERHOP'S rotor block climbs
  // exactly like a Riverhop. If this "variant" still out-climbed it, the gate
  // above would be measuring the class id, not the tuning.
  const ctrl = spawnSpec(variantSpec('newsheli', (b) => {
    b.rotor = structuredClone(VEHICLE_SPECS.heli.rotor);
  }));
  const dCtrl = climb14(ctrl);
  check('newsheli', 'NEGATIVE CONTROL — with the Riverhop rotor the climb gap collapses',
    Math.abs(dCtrl - dRiver) < 8,
    `control +${dCtrl.toFixed(1)} m vs Riverhop +${dRiver.toFixed(1)} m (variant was +${dNews.toFixed(1)})`);
}

function testSportPlane() {
  /* ---- parked: settles on its gear and holds ------------------------- */
  {
    const v = spawn('sportplane');
    const p0 = v.position.clone();
    fly(v, {}, 3);
    const drift = Math.hypot(v.position.x - p0.x, v.position.z - p0.z);
    check('sportplane', 'parked, it settles on its gear and sits still',
      v.grounded >= 3 && Math.abs(v.velocity.y) < 0.1 && v.altitude < 0.15 && drift < 0.2,
      `grounded ${v.grounded}, vy ${v.velocity.y.toFixed(4)}, alt ${v.altitude.toFixed(3)}, drift ${drift.toFixed(3)} m`);
  }

  /* ---- FASTER: same 26 s of throttle as the Skylark ------------------- */
  const run26 = (v) => { fly(v, { boost: 1 }, 26); return fwdSpeed(v); };
  const sport = spawn('sportplane');
  const vSport = run26(sport);
  const lark = spawn('plane');
  const vLark = run26(lark);
  check('sportplane', 'flies off the same runway and is faster than the Skylark',
    sport.grounded === 0 && sport.altitude > 40 && vSport > 54 && vSport > vLark + 6,
    `${vSport.toFixed(1)} m/s at ${sport.altitude.toFixed(0)} m vs Skylark ${vLark.toFixed(1)} m/s`);

  /* ---- TWITCHIER: the same second of aileron banks it further --------- */
  {
    fly(sport, { boost: 0.6, steer: 1 }, 0.9);
    fly(lark, { boost: 0.6, steer: 1 }, 0.9);
    const bS = Math.abs(bankOf(sport)), bL = Math.abs(bankOf(lark));
    check('sportplane', 'the same second of aileron banks it further than the Skylark',
      bS > bL + 12 / DEG,
      `bank ${(bS * DEG).toFixed(1)} deg vs Skylark ${(bL * DEG).toFixed(1)} deg`);
  }

  /* ---- NEGATIVE CONTROL: no throttle, no take-off --------------------- */
  {
    const v = spawn('sportplane');
    fly(v, {}, 26);
    check('sportplane', 'NEGATIVE CONTROL — no throttle, it never leaves the runway',
      fwdSpeed(v) < 2 && v.altitude < 0.2 && v.grounded >= 3,
      `airspeed ${fwdSpeed(v).toFixed(2)} m/s, altitude ${v.altitude.toFixed(3)} m, ${v.grounded} wheels down`);
  }

  /* ---- NEGATIVE CONTROL: the speed is the TUNING, not the skin -------- */
  // The Skylark's flight/aero/mass under the Slipstream's silhouette must fly
  // like a Skylark. If it did not, the speed gate above would be crediting the
  // low wing's paintwork with the tuning's work.
  {
    const ctrl = spawnSpec(variantSpec('sportplane', (b) => {
      b.flight = structuredClone(VEHICLE_SPECS.plane.flight);
      b.aero = structuredClone(VEHICLE_SPECS.plane.aero);
      b.mass = VEHICLE_SPECS.plane.mass;
    }));
    const vCtrl = run26(ctrl);
    check('sportplane', 'NEGATIVE CONTROL — Skylark tuning under this skin collapses the speed gap',
      Math.abs(vCtrl - vLark) < 3,
      `control ${vCtrl.toFixed(1)} m/s vs Skylark ${vLark.toFixed(1)} m/s (variant was ${vSport.toFixed(1)})`);
  }
}

/* ================================================================== */
/* 5. SILHOUETTES AND LIVERIES — the variants READ different          */
/* ================================================================== */
/**
 * All measured on the geometry the builders EMIT — the same vertices build.js
 * merges into the meshes on screen — never on the style block that asked for
 * them (rule 12: the input is not the measurement).
 */
function paintExtent(out, groups = ['paint']) {
  let minZ = Infinity, maxZ = -Infinity, maxX = 0;
  for (const g of groups) {
    for (const geo of out[g] ?? []) {
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const z = p.getZ(i);
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
        const x = Math.abs(p.getX(i));
        if (x > maxX) maxX = x;
      }
    }
  }
  return { len: maxZ - minZ, maxX };
}
/** Mean emitted y of everything further outboard than `xMin` — the wing band.
 *  Only the main wing lives out there (the stabs stop well inside 2.6 m). */
function wingBandY(out, xMin = 2.6) {
  let sum = 0, n = 0;
  for (const geo of out.paint ?? []) {
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(p.getX(i)) > xMin) { sum += p.getY(i); n++; }
    }
  }
  return n ? sum / n : NaN;
}
function rotorRadius(out) {
  let r = 0;
  const p = out.rotors[0].geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const d = Math.hypot(p.getX(i), p.getZ(i));
    if (d > r) r = d;
  }
  return r;
}

function testSilhouettes() {
  const heli = buildHeliBody(finalizeSpec(VEHICLE_SPECS.heli), 0);
  const news = buildHeliBody(finalizeSpec(VEHICLE_SPECS.newsheli), 0);
  const lark = buildPlaneBody(finalizeSpec(VEHICLE_SPECS.plane), 0);
  const sportSpec = finalizeSpec(VEHICLE_SPECS.sportplane);
  const sport = buildPlaneBody(sportSpec, 0);

  // Helicopters: the news machine is visibly longer with a bigger disc.
  const he = paintExtent(heli), ne = paintExtent(news);
  check('silhouette', 'the Skywatch is over a metre longer than the Riverhop',
    ne.len > he.len + 0.9,
    `${ne.len.toFixed(2)} m vs ${he.len.toFixed(2)} m emitted fuselage length`);
  const hr = rotorRadius(heli), nr = rotorRadius(news);
  check('silhouette', 'the Skywatch swings a bigger rotor disc',
    nr > hr + 0.3, `${nr.toFixed(2)} m vs ${hr.toFixed(2)} m emitted blade reach`);

  // Planes: high wing vs low wing, and a much shorter span.
  const fyL = VEHICLE_SPECS.plane.style.fuseY;
  const fyS = VEHICLE_SPECS.sportplane.style.fuseY;
  const wL = wingBandY(lark), wS = wingBandY(sport);
  check('silhouette', 'the Skylark carries its wing HIGH over the fuselage centreline',
    wL > fyL + 0.5, `wing band y ${wL.toFixed(2)} vs centreline ${fyL.toFixed(2)}`);
  check('silhouette', 'the Slipstream carries its wing LOW, under the centreline',
    wS < fyS, `wing band y ${wS.toFixed(2)} vs centreline ${fyS.toFixed(2)}`);
  check('silhouette', 'the two wings sit more than 0.8 m apart in the emitted metal',
    wL - wS > 0.8, `${wL.toFixed(2)} vs ${wS.toFixed(2)}`);
  const le = paintExtent(lark), se = paintExtent(sport);
  check('silhouette', 'the Slipstream span is over a metre shorter',
    le.maxX > se.maxX + 1.0, `half-span ${le.maxX.toFixed(2)} m vs ${se.maxX.toFixed(2)} m`);

  // NEGATIVE CONTROL: rebuild the Slipstream with the Skylark's wing height —
  // the low-wing reading must vanish, or the checks above are reading the id.
  const ctrl = buildPlaneBody(variantSpec('sportplane', (b) => {
    b.style.wingY = VEHICLE_SPECS.plane.style.wingY;
  }), 0);
  const wC = wingBandY(ctrl);
  check('silhouette', 'NEGATIVE CONTROL — with the Skylark wing height it reads high-wing',
    wC > fyS + 0.5, `control wing band y ${wC.toFixed(2)} vs centreline ${fyS.toFixed(2)}`);

  /**
   * LIVERIES. Each variant's paint pools resolve through the SAME `PAINTS`
   * table the spawner reads (`_choosePaint`: `spec.paints` -> `PAINTS[pool]`),
   * and each variant's colour set shares nothing with its sibling's — so the
   * pair can never roll the same coat of paint.
   */
  const colours = (id) => {
    const out = new Set();
    for (const pool of VEHICLE_SPECS[id].paints ?? []) {
      for (const p of PAINTS[pool] ?? []) out.add(p.color);
    }
    return out;
  };
  for (const [a, b] of [['heli', 'newsheli'], ['plane', 'sportplane']]) {
    const ca = colours(a), cb = colours(b);
    const overlap = [...cb].filter((c) => ca.has(c));
    check('livery', `${b} resolves its own paint pool (${VEHICLE_SPECS[b].paints.join(',')})`,
      cb.size > 0, `${cb.size} colours`);
    check('livery', `${b} shares no colour with ${a}`,
      cb.size > 0 && overlap.length === 0,
      overlap.length ? `shared: ${overlap.map((c) => c.toString(16)).join(',')}` : `${ca.size} vs ${cb.size} colours, disjoint`);
  }
}

/* ================================================================== */
testEnter();
testHeli();
testPlane();
testNewsHeli();
testSportPlane();
testSilhouettes();

console.log(`\nflightprobe: ${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('FAILURES:');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
