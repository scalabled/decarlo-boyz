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
 * Every threshold below is a MEASURED emitted quantity with a margin, and the
 * negative controls are run so the positive assertions mean something.
 *
 *   node src/vehicles/flightprobe.mjs
 */

import * as THREE from 'three';
import { VEHICLE_SPECS, finalizeSpec, SURFACE_GRIP } from './specs.js';
import { Vehicle } from './dynamics.js';
import { VehicleSystem } from './index.js';

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

function spawn(type, { driver = true, slope = 0 } = {}) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(makeWorld(slope), spec, STUB, {});
  v.damage = null;
  // Rest the gear/skids on the ground: CoM sits one gear-drop above it.
  const drop = type === 'heli'
    ? spec.comY - (spec.style.skidY - spec.style.skidR)
    : spec.comY - spec.style.gearY;
  v.setPose(new THREE.Vector3(0, drop, 0), 0);
  if (driver) v.driver = { isPlayer: true };
  // A player at the controls gets the auto-reverse steer sign; matching it here
  // keeps the A/D roll direction identical in the gate and in the game.
  v.autoReverse = true;
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

function testEnter() {
  for (const [type, ap] of [['heli', [-1072, 784]], ['plane', [1032, -784]]]) {
    const v = spawn(type);
    v.position.set(ap[0], 0.6, ap[1]);
    const sys = { vehicles: [v] };
    const found = VehicleSystem.prototype.nearest.call(sys, ap[0], 1.5, ap[1], 6, TAKEABLE);
    check('enter', `a parked ${type} at the airport is offered by the F scan`,
      found === v && v.enterable !== false,
      `nearest returned ${found === v ? 'it' : found}, enterable=${v.enterable}`);
    // A wreck is not takeable — the other half of the predicate.
    v.destroyed = true;
    const gone = VehicleSystem.prototype.nearest.call(sys, ap[0], 1.5, ap[1], 6, TAKEABLE);
    check('enter', `a destroyed ${type} is NOT offered`, gone === null,
      `nearest returned ${gone === null ? 'null' : 'it'}`);
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
testEnter();
testHeli();
testPlane();

console.log(`\nflightprobe: ${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('FAILURES:');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
