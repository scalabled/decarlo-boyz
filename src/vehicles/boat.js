/**
 * The Riverjack — hull geometry and hydrodynamics.
 *
 * Carson's whole arc is on the water and the three rivers are a third of the
 * map, so this is a real displacement/planing model, not a car with the wheels
 * turned off:
 *
 *   - buoyancy is sampled at twelve points spread over the hull, each
 *     contributing rho*g*V of the volume it has pushed under the local water
 *     surface. Twelve samples rather than one is what gives roll and pitch
 *     stiffness for free, and it is why the boat heels into a turn and squats
 *     when the throttle goes down.
 *   - at rest the boat floats bow-up on its transom; above the planing speed
 *     the dynamic lift on the after-body pulls the bow down and the hull climbs
 *     out of the water, which drops the wetted area and doubles the top speed.
 *   - lateral drag is 25x longitudinal, so it tracks straight and skids
 *     sideways in a hard turn like a real V-hull.
 *   - the rudder/outdrive only bites when there is thrust, so chopping the
 *     throttle mid-turn kills the steering exactly as it does on the water.
 */

import * as THREE from 'three';
import { BodySurface, loftBody, roundedBox, transform, mergeAll, mirrorX, tubeBetween, sweep } from './geom.js';
import { CP } from './body.js';

const PER_SEG = [3, 2, 1, 1];
const Z_SAMPLES = [90, 46, 22, 10];

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

function hullStation(z, o) {
  const { hw, sheer, chineY, chineX, keel, deckIn, deckY, hard = false } = o;
  const ctrl = new Array(11);
  ctrl[CP.TOP] = { x: 0, y: deckY };
  ctrl[CP.ROOF_MID] = { x: deckIn * 0.55, y: deckY + 0.005 };
  ctrl[CP.ROOF_EDGE] = { x: deckIn, y: deckY + 0.01, hard: true };
  ctrl[CP.GLASS_MID] = { x: (deckIn + hw) * 0.5, y: (deckY + sheer) * 0.5 + 0.02 };
  ctrl[CP.BELT] = { x: hw * 0.99, y: sheer, hard: true };
  ctrl[CP.SHOULDER] = { x: hw, y: sheer - 0.1, hard: true };
  ctrl[CP.CREASE] = { x: chineX, y: chineY, hard: true }; // the chine
  ctrl[CP.LOWER] = { x: chineX * 0.7, y: chineY - (chineY - keel) * 0.34 };
  ctrl[CP.SILL] = { x: chineX * 0.36, y: chineY - (chineY - keel) * 0.72, hard: false };
  ctrl[CP.FLOOR_EDGE] = { x: chineX * 0.1, y: keel + 0.015 };
  ctrl[CP.FLOOR] = { x: 0, y: keel };
  return { z, ctrl, hard };
}

function boatStations(spec) {
  const s = spec.style;
  const hw = s.hwMax;
  const sheer = s.sheerY;
  const keel = s.keelY;
  const deck = s.deckY;
  const bow = s.bowZ;
  const stern = s.sternZ;
  const out = [];

  const at = (t) => bow + (stern - bow) * t;

  // Bow: fine entry, deep V, high sheer.
  out.push(hullStation(bow, {
    hw: hw * 0.1, sheer: sheer + 0.2, chineY: sheer - 0.02, chineX: hw * 0.08,
    keel: keel + 0.44, deckIn: hw * 0.06, deckY: sheer + 0.18, hard: true,
  }));
  out.push(hullStation(at(0.08), {
    hw: hw * 0.42, sheer: sheer + 0.13, chineY: sheer - 0.24, chineX: hw * 0.36,
    keel: keel + 0.3, deckIn: hw * 0.3, deckY: sheer + 0.08,
  }));
  out.push(hullStation(at(0.22), {
    hw: hw * 0.76, sheer: sheer + 0.06, chineY: sheer - 0.44, chineX: hw * 0.7,
    keel: keel + 0.14, deckIn: hw * 0.56, deckY: deck + 0.09,
  }));
  out.push(hullStation(at(0.38), {
    hw: hw * 0.94, sheer: sheer + 0.01, chineY: sheer - 0.56, chineX: hw * 0.9,
    keel: keel + 0.04, deckIn: hw * 0.72, deckY: deck + 0.03,
  }));
  out.push(hullStation(at(0.55), {
    hw, sheer, chineY: sheer - 0.62, chineX: hw * 0.97, keel,
    deckIn: hw * 0.78, deckY: deck,
  }));
  out.push(hullStation(at(0.75), {
    hw, sheer: sheer - 0.02, chineY: sheer - 0.64, chineX: hw * 0.99, keel: keel + 0.03,
    deckIn: hw * 0.8, deckY: deck,
  }));
  out.push(hullStation(at(0.94), {
    hw: hw * 0.98, sheer: sheer - 0.04, chineY: sheer - 0.64, chineX: hw * 0.97, keel: keel + 0.08,
    deckIn: hw * 0.8, deckY: deck - 0.01,
  }));
  // Transom: a flat, hard cut.
  out.push(hullStation(stern, {
    hw: hw * 0.96, sheer: sheer - 0.05, chineY: sheer - 0.63, chineX: hw * 0.95, keel: keel + 0.1,
    deckIn: hw * 0.78, deckY: deck - 0.02, hard: true,
  }));
  return out;
}

export function buildBoatHull(spec, lod = 0) {
  const s = spec.style;
  const perSeg = PER_SEG[lod];
  const surface = new BodySurface(boatStations(spec), perSeg);
  const C = (cp) => cp * perSeg;
  const out = {
    paint: [], trim: [], chrome: [], cavity: [], glass: [], lamps: {}, plate: [],
    disc: [], grilleMesh: [], surface, anchors: { exhaust: [] },
  };
  const lamp = (k, g) => (out.lamps[k] = out.lamps[k] ?? []).push(g);

  const cuts = [];
  // Cockpit: cut the deck away between the console and the transom.
  const zC0 = s.sternZ + 0.35;
  const zC1 = s.consoleZ + 0.45;
  cuts.push({ kind: 'panel', c0: 0, c1: C(CP.ROOF_EDGE) - 0.5, z0: zC0, z1: zC1 });

  out.paint.push(loftBody(surface, { zSamples: Z_SAMPLES[lod], cuts, uvScale: 1.6 }));

  // Cockpit sole + inner liner so the cut does not look through the hull.
  if (lod < 2) {
    const sole = roundedBox(s.hwMax * 1.5, 0.06, zC1 - zC0, 0.02, 1);
    transform(sole, { pos: [0, s.deckY - 0.34, (zC0 + zC1) / 2] });
    out.trim.push(sole);
    for (const side of [-1, 1]) {
      const wall = roundedBox(0.06, 0.4, zC1 - zC0, 0.02, 1);
      transform(wall, { pos: [side * s.hwMax * 0.76, s.deckY - 0.14, (zC0 + zC1) / 2] });
      out.trim.push(wall);
    }
    const fwd = roundedBox(s.hwMax * 1.5, 0.4, 0.06, 0.02, 1);
    transform(fwd, { pos: [0, s.deckY - 0.14, zC1] });
    out.trim.push(fwd);
  }

  // ---- rubrail along the sheer ------------------------------------------
  const rail = [];
  const n = lod < 1 ? 26 : 12;
  for (let i = 0; i < n; i++) {
    const z = s.bowZ + ((s.sternZ - s.bowZ) * i) / (n - 1);
    const prof = surface.profileAt(z);
    const ci = Math.max(0, Math.min(surface.cols - 1, C(CP.BELT)));
    rail.push(new THREE.Vector3(prof[ci].x + 0.01, prof[ci].y, z));
  }
  const rr = sweep(
    [{ x: 0.02, y: 0.05 }, { x: 0.045, y: 0.0 }, { x: 0.02, y: -0.05 }, { x: -0.04, y: -0.05 }, { x: -0.04, y: 0.05 }],
    rail,
    { closed: true, caps: true, up: new THREE.Vector3(0, 1, 0) }
  );
  out.trim.push(rr, mirrorX(rr.clone()));

  // ---- windshield --------------------------------------------------------
  const wz = s.windshieldZ;
  const wsw = s.hwMax * 1.1;
  const frame = roundedBox(wsw + 0.06, s.windshieldH + 0.06, 0.05, 0.02, 1);
  transform(frame, { pos: [0, s.deckY + s.windshieldH * 0.5 + 0.06, wz], rot: [-0.22, 0, 0] });
  out.chrome.push(frame);
  const glassG = roundedBox(wsw, s.windshieldH, 0.02, 0.015, 1);
  transform(glassG, { pos: [0, s.deckY + s.windshieldH * 0.5 + 0.06, wz], rot: [-0.22, 0, 0] });
  out.glass.push(glassG);

  // ---- outboard ----------------------------------------------------------
  const mz = s.sternZ - 0.24;
  const cowl = roundedBox(0.42, 0.5, 0.46, 0.11, 3);
  transform(cowl, { pos: [0, s.deckY - 0.22, mz] });
  out.trim.push(cowl);
  const leg = roundedBox(0.16, 0.72, 0.2, 0.06, 2);
  transform(leg, { pos: [0, s.deckY - 0.72, mz] });
  out.trim.push(leg);
  const bullet = new THREE.CylinderGeometry(0.075, 0.055, 0.44, 12);
  transform(bullet, { pos: [0, s.deckY - 1.08, mz - 0.02], rot: [Math.PI / 2, 0, 0] });
  out.trim.push(bullet);
  for (let i = 0; i < 3; i++) {
    const blade = roundedBox(0.03, 0.17, 0.09, 0.012, 1);
    const a = (i / 3) * Math.PI * 2;
    transform(blade, { pos: [Math.sin(a) * 0.08, s.deckY - 1.08 + Math.cos(a) * 0.08, mz - 0.24], rot: [0, 0, a] });
    out.chrome.push(blade);
  }
  out.anchors.exhaust.push(new THREE.Vector3(0, s.deckY - 0.8, mz - 0.2));
  out.anchors.prop = new THREE.Vector3(0, s.deckY - 1.08, mz - 0.3);

  // ---- cleats, rails, nav lights ----------------------------------------
  if (lod < 2) {
    for (const zc of [s.bowZ - 0.5, s.consoleZ + 1.2, s.sternZ + 0.5]) {
      for (const side of [-1, 1]) {
        const prof = surface.profileAt(zc);
        const ci = Math.max(0, Math.min(surface.cols - 1, C(CP.ROOF_EDGE)));
        const cl = roundedBox(0.06, 0.05, 0.2, 0.02, 1);
        transform(cl, { pos: [side * prof[ci].x * 0.9, prof[CP.TOP * perSeg].y + 0.05, zc] });
        out.chrome.push(cl);
      }
    }
    const bowRail = tubeBetween(
      new THREE.Vector3(-0.5, s.sheerY + 0.32, s.bowZ - 1.1),
      new THREE.Vector3(0.5, s.sheerY + 0.32, s.bowZ - 1.1),
      0.018, 8
    );
    out.chrome.push(bowRail);
  }
  lamp('policeRed', transform(new THREE.SphereGeometry(0.045, 8, 6), { pos: [-s.hwMax * 0.85, s.sheerY + 0.06, s.bowZ - 1.0] }));
  lamp('drl', transform(new THREE.SphereGeometry(0.045, 8, 6), { pos: [s.hwMax * 0.85, s.sheerY + 0.06, s.bowZ - 1.0] }));
  lamp('reverse', transform(new THREE.SphereGeometry(0.05, 8, 6), { pos: [0, s.deckY + 0.5, s.sternZ + 0.2] }));

  return out;
}

/* ------------------------------------------------------------------ */
/* Hydrodynamics                                                       */
/* ------------------------------------------------------------------ */

const RHO_WATER = 1000;
const G = 9.81;

/** Hull sample points in local space: [x, y, z, volumeShare]. */
export function makeHullSamples(spec) {
  const s = spec.style;
  const hull = spec.hull;
  const pts = [];
  const nz = 6;
  for (let i = 0; i < nz; i++) {
    const t = (i + 0.5) / nz;
    const z = s.bowZ + (s.sternZ - s.bowZ) * t;
    // The forward sections are fine and carry little volume; the after body
    // carries most of it, which is what makes the boat float bow-up.
    const share = 0.25 + 1.75 * t;
    const halfBeam = s.hwMax * Math.min(1, 0.15 + t * 1.9);
    for (const side of [-1, 1]) {
      pts.push({
        x: side * halfBeam * 0.62,
        y: s.keelY + 0.12 + (1 - t) * 0.34,
        z,
        share: share * 0.5,
        t,
      });
    }
  }
  let total = 0;
  for (const p of pts) total += p.share;
  for (const p of pts) p.vol = (hull.buoyancy * p.share) / total;
  return pts;
}

const _p = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _t = new THREE.Vector3();

/**
 * One hydrodynamic step. `v` is the Vehicle (see dynamics.js) — this reads its
 * pose and accumulates forces/torques into it exactly like the wheel model does
 * for a car, so the same rigid-body integrator handles both.
 */
export function stepBoat(v, dt, ctx) {
  const spec = v.spec;
  const hull = spec.hull;
  const q = v.quaternion;
  _fwd.set(0, 0, 1).applyQuaternion(q);
  _right.set(1, 0, 0).applyQuaternion(q);
  _up.set(0, 1, 0).applyQuaternion(q);

  const world = v.sys._world();
  let submerged = 0;
  let wetted = 0;
  let waterY = 0;
  let anyWater = false;

  const speed = v.velocity.dot(_fwd);
  const absSpeed = Math.abs(speed);
  const planing = Math.max(0, Math.min(1, (absSpeed - hull.planeSpeed * 0.45) / hull.planeSpeed));

  for (let i = 0; i < v.hullSamples.length; i++) {
    const hp = v.hullSamples[i];
    _p.set(hp.x, hp.y, hp.z).applyQuaternion(q).add(v.position);
    const wy = v.sys.waterHeightAt(_p.x, _p.z, ctx);
    if (wy === null) continue;
    anyWater = true;
    waterY += wy;
    const depth = wy - _p.y;
    if (depth <= 0) continue;
    submerged++;
    const d = Math.min(depth, 0.55);
    // Buoyancy, ramped over the sample's own draft so it is continuous.
    const frac = d / 0.55;
    let fy = RHO_WATER * G * hp.vol * frac;

    // Vertical damping: water resists the hull moving through it.
    _r.set(hp.x, hp.y, hp.z).applyQuaternion(q);
    _vel.copy(v.angularVelocity).cross(_r).add(v.velocity);
    fy -= _vel.y * hull.dragVert * frac * (1 / v.hullSamples.length) * 4;

    // Planing lift: dynamic pressure on the after body lifts it and pulls the
    // bow down, which is the whole character of a fast small boat.
    if (planing > 0.01) {
      fy += hull.planing * absSpeed * absSpeed * planing * hp.t * hp.t * 0.02;
    }

    _f.set(0, fy, 0);
    v.addForceAtLocal(_f, _r);
    wetted += frac;
  }

  if (!anyWater) return false;
  v.inWater = submerged > 0;
  v.waterY = waterY / v.hullSamples.length;
  v.wetted = wetted / v.hullSamples.length;
  if (submerged === 0) return true;

  const wet = v.wetted;

  // ---- hull drag ---------------------------------------------------------
  const vLong = v.velocity.dot(_fwd);
  const vLat = v.velocity.dot(_right);
  const dragScale = wet * (1 - 0.55 * planing); // planing halves the wetted area
  _f.copy(_fwd).multiplyScalar(-Math.sign(vLong) * hull.dragLong * vLong * vLong * dragScale);
  _t.copy(_right).multiplyScalar(-Math.sign(vLat) * hull.dragLat * vLat * vLat * dragScale);
  _f.add(_t);
  v.addForce(_f);

  // ---- thrust ------------------------------------------------------------
  const throttle = v.input.throttle - v.input.brake;
  /**
   * `boatSpeed` from DESIGN.md's stat table — 1.25 for Carson, 1.00 for Aidan,
   * 1.05 for Dylan — applied to the PROP, which is the only thing on a boat
   * that a driver could plausibly change. It was dead data everywhere in the
   * project until this pass; see the HERO block in `specs.js`. `v.hero` is the
   * identity for every AI and parked boat, so nothing but the player's changes.
   *
   * Aidan is already 1.00 in the table, so unlike the grip this needs no
   * centring: the boat as tuned and benched IS the all-rounder's boat.
   */
  const thrust = throttle * hull.thrust * (0.35 + 0.65 * wet) * (v.hero?.boat ?? 1);
  const steer = v.steerAngle;
  // The outdrive vectors the thrust: no throttle, no steering. Exactly right.
  _f.copy(_fwd).multiplyScalar(Math.cos(steer) * thrust);
  _t.copy(_right).multiplyScalar(-Math.sin(steer) * thrust);
  _f.add(_t);
  _r.set(0, spec.style.deckY - 0.7, spec.style.sternZ - 0.2).applyQuaternion(q);
  v.addForceAtLocal(_f, _r);
  v.propThrust = thrust;

  // ---- yaw damping + righting -------------------------------------------
  v.addTorque(_t.copy(_up).multiplyScalar(-v.angularVelocity.dot(_up) * hull.yawDamp * wet));

  // Righting moments: the metacentre is above the CoM, so the hull self-levels.
  const rollErr = Math.asin(Math.max(-1, Math.min(1, _right.y)));
  const pitchErr = Math.asin(Math.max(-1, Math.min(1, _fwd.y)));
  v.addTorque(
    _t.copy(_fwd).multiplyScalar(
      -rollErr * hull.rollStiff * wet - v.angularVelocity.dot(_fwd) * hull.rollDamp * wet
    )
  );
  // Planing trims the bow DOWN; at rest the transom squats.
  const trimTarget = -0.16 + 0.30 * planing;
  v.addTorque(
    _t.copy(_right).multiplyScalar(
      (pitchErr - trimTarget) * hull.pitchStiff * wet -
      v.angularVelocity.dot(_right) * hull.pitchDamp * wet
    )
  );

  v.planing = planing;
  return true;
}
