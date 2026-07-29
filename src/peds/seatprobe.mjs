#!/usr/bin/env node
/**
 * SEAT PROBE — "is the driver's head INSIDE the car?", as a measurement of two
 * emitted meshes rather than as a question put to the seating code.
 *
 *   node src/peds/seatprobe.mjs
 *   node src/peds/seatprobe.mjs --verbose
 *   node src/peds/seatprobe.mjs --control=nopose      (negative control)
 *   node src/peds/seatprobe.mjs --control=physpose
 *   node src/peds/seatprobe.mjs --control=nosink
 *   node src/peds/seatprobe.mjs --control=noyaw
 *   node src/peds/seatprobe.mjs --control=blend
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 * NPC heads pop out of cars as they drive.
 *
 * `Ped` had no seated state at all. `update()` copied `vehicle.position` — the
 * chassis CENTRE OF MASS — into `this.position`, `updateVisual` wrote that to
 * the body group, and the animator uses the group as the FEET. So every driver
 * and passenger in the city was a standing man whose soles were on the car's
 * centre of mass, playing an idle, facing whatever yaw he spawned at.
 *
 * MEASURED with this harness before the fix, crown of the emitted ped mesh over
 * the emitted roof of the car it is drawn in, worst frame of a 30-frame drive:
 *
 *     sports  +1.003 m   sedan   +0.981 m   muscle  +0.955 m
 *     kessel  +0.898 m   police  +0.580 m
 *
 * and it did NOT correlate with speed (sedan +0.981 at rest, +0.731 at 30 m/s —
 * the variation is the idle clip breathing, not the car), did NOT correlate
 * with suspension travel (the chassis y moved 2 mm over the same run), and did
 * NOT correlate with LOD (the far-crowd capsule stacks the same standing figure
 * off the same point). It correlated with CLASS only through roof height: the
 * crown sat at 2.10-2.40 m over the road on every class alike, which is a
 * 1.75 m man standing on a centre of mass 0.4-0.5 m up. The van, the truck and
 * the bus hid it because their roofs are over 2.3 m.
 *
 * The four candidate explanations, against that measurement:
 *   - physics pose instead of drawn pose: REAL but small — 0.19-0.26 m of
 *     horizontal lag at 30 m/s, a body sliding fore and aft in its own seat.
 *     Fixed here too, and gated by `--control=physpose`.
 *   - wrong anchor for some classes: NO. Every class was wrong by a body.
 *   - not applied to LOD peds: NO. It was applied to nobody, at any LOD.
 *   - ground-clamped while seated: NOT REACHABLE — but it WOULD have been the
 *     next bug, because the foot IK drops the pelvis to the ground probe and
 *     locks planted feet in WORLD space. Both are off while seated, and
 *     `--control=nopose` shows what leaving them on looks like.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT IS MEASURED
 * ---------------------------------------------------------------------------
 * Nothing here asks the seating code where it put anything. There is no
 * `seatLocal`, no `_anchorY` and no copy of `SEAT` in any assertion.
 *
 *   THE CAR   the real `Vehicle`, stepped at the real 120 Hz against a real
 *             plane, drawn through the real `buildVehicleModel` scene graph and
 *             posed by the real `syncTransforms(alpha)`. The triangles read are
 *             the INDEXED ones actually drawn, transformed by `matrixWorld`.
 *   THE PED   the real `Ped`, the real `PedAnimator` over the real rig, wearing
 *             a real `buildOutfit` silhouette. The vertices read are SKINNED —
 *             `applyBoneTransform` per vertex — so they are where the renderer
 *             will put them, not where the clip said.
 *
 * The headline assertion is a RAY, not a comparison of two heights: fire
 * straight up out of the highest skinned vertex and require it to hit the car's
 * own drawn triangles. "Below the maximum roof height" would pass a head poking
 * out of a side window or through the backlight of a fastback, and would fail a
 * correctly-seated driver in a car with a roof aerial. A hit means there is
 * bodywork over that vertex; the hit distance is the headroom.
 *
 * Also asserted, all from the same two meshes:
 *   - no skinned vertex outside the car's own bodywork ANYWHERE (the whole
 *     mesh, not just the crown) — which is what catches a head through a side
 *     window, and did: the seat's x had to come inboard of `seatAnchor`'s
 *     because a greenhouse narrows above the belt line it was measured at.
 *   - the body rides the DRAWN car: its position, expressed in the drawn car's
 *     own frame, does not move while the car and its interpolation alpha do
 *   - he faces FORWARD: the emitted toe is nose-ward of the emitted heel, in
 *     the car's own frame. Never asserted against the yaw the code wrote.
 *   - the soles do not come out under the rocker panel
 *
 * across 8 vehicle classes x 3 speeds x 3 body scales, and at LOD2, where the
 * figure is a different piece of geometry entirely (the instanced far crowd).
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROLS — a gate that has never failed is not evidence
 * ---------------------------------------------------------------------------
 * MEASURED, same build, one machine:
 *
 *   fixed                136/136
 *   --control=nopose      73/136   the bug: root = `vehicle.position`, standing
 *                                  idle, foot IK left on. The shipped code.
 *   --control=blend       94/136   let the seated clip cross-fade in from the
 *                                  idle instead of snapping. Three quarters of
 *                                  a metre of leg below the car for 0.22 s,
 *                                  every time the seat sweep reaches a car.
 *   --control=noyaw      110/136   take `player/vehicle.js`'s `+ Math.PI` on
 *                                  trust. A ped's forward is +Z, not -Z.
 *   --control=physpose   119/136   seat from `v.position`/`v.quaternion`
 *                                  instead of the drawn `model.root`.
 *   --control=nosink     133/136   do not sink a tall silhouette for its hat.
 *                                  Only three checks move, and they are the
 *                                  three that matter: the sports car's crown.
 *
 * If a control does not go red, the assertion it targets is decorative.
 */

import * as THREE from 'three';
import { VEHICLE_SPECS, finalizeSpec, SURFACE_GRIP } from '../vehicles/specs.js';
import { Vehicle } from '../vehicles/dynamics.js';
import { VehicleSystem } from '../vehicles/index.js';
import { buildVehicleModel, setVehicleLod } from '../vehicles/build.js';
import { RIG } from './rig.js';
import { Ped, STATE } from './ped.js';
import { buildOutfit } from './builder.js';
import { makeOutfit, SHAPE_IDS } from './wardrobe.js';
import { FarCrowd } from './crowdfx.js';
import { Rng } from '../core/rng.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const VERBOSE = !!args.verbose;
const CONTROL = args.control ?? null;
const CONTROLS = ['nopose', 'physpose', 'nosink', 'noyaw', 'blend'];
if (CONTROL && !CONTROLS.includes(CONTROL)) {
  console.error(`unknown control ${CONTROL}; one of ${CONTROLS.join(', ')}`);
  process.exit(2);
}

const DT = 1 / 120;

/**
 * RATCHET — minimum headroom over the crown, metres.
 *
 * The goal is simply "inside the car", i.e. > 0. This records where the fix got
 * to on the tightest class in the fleet: measured over where a seated driver's
 * head actually is, the sports car's emitted roof stands 1.133 m against a
 * 0.895 m head anchor that `vehicles` deliberately declines to lower
 * (`seatAnchor`'s `max`), and `SEAT.crownBudget` spends 0.21 of the 0.238 that
 * leaves. The other seven classes clear by 74-115 mm. Raising the sports car's
 * roof or lowering its anchor is what would let this go up.
 *
 * LOWER A RATCHET WHEN YOU IMPROVE IT. Never raise one to make a run go green.
 */
const MIN_HEADROOM = 0.02;
/**
 * RATCHET — how far the lowest skinned vertex may sit below the car's own
 * underside, metres. The goal is 0: nothing of a driver should be visible below
 * the rocker panel. MEASURED at 0.035 (sports car, 1.94 m body); it was 0.156
 * before the leg pose was allowed to raise the heels above the hips.
 *
 * The residual is a real and bounded geometric squeeze, not a slack tolerance.
 * The sports car has 1.02 m between its underside and the roof over the
 * driver's head; a 1.94 m man seated with his crown at that roof reaches
 * 0.775 m from head bone to backside, and the arithmetic simply does not
 * close. The choice made is to keep the CROWN inside — a head through a roof is
 * visible from every angle, a heel below a rocker from almost none, and at this
 * size the lowest vertex is under both the car AND the road surface. Closing it
 * needs either a slouching pose (content work) or `vehicles.seatAnchor`
 * applying its own `inGlass` height to the two low classes instead of taking
 * the `max`.
 */
const MAX_SOLE_UNDER = 0.06;
/**
 * How far the body may WANDER inside the car it is drawn in, metres, measured
 * as the spread of its position expressed in the DRAWN car's own frame.
 *
 * A spread, not an offset: comparing the ped's world position with a rebuilt
 * seat point would be comparing the seating code with itself (`seatLocal` is
 * its own input, rule 12). Where the seat IS is a judgement; that it does not
 * MOVE relative to the drawn car is a fact, and it is exactly the fact the
 * physics-pose bug breaks — the drawn car is interpolated between fixed steps
 * and the physics pose is not, so a body pinned to the latter slides fore and
 * aft in its own seat by up to one step of travel every frame.
 */
const MAX_RIDE_SPREAD = 0.01;

let pass = 0;
let fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; if (VERBOSE) console.log(`  ok   ${name}  ${detail ?? ''}`); }
  else { fail++; fails.push(`${name}  ${detail ?? ''}`); console.log(`  FAIL ${name}  ${detail ?? ''}`); }
}

/* ------------------------------------------------------------------ */
/* A flat asphalt plane, exactly as `vehicles/drivetest.mjs` builds it. */
/* ------------------------------------------------------------------ */

function makeWorld() {
  const N = new THREE.Vector3(0, 1, 0);
  const HIT = {
    hit: true, point: new THREE.Vector3(), normal: N.clone(),
    distance: 0, surface: 'asphalt', object: null,
  };
  const physics = {
    MASK: { WORLD: 3 },
    staticWorld: null,
    raycast(o, d, maxDist) {
      const den = N.dot(d);
      if (Math.abs(den) < 1e-6) { HIT.hit = false; return HIT; }
      const t = -N.dot(o) / den;
      if (t < 0 || t > maxDist) { HIT.hit = false; return HIT; }
      HIT.hit = true;
      HIT.distance = t;
      HIT.point.set(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
      HIT.normal.copy(N);
      HIT.surface = 'asphalt';
      return HIT;
    },
    groundHeight: () => 0,
  };
  return {
    slope: 0, physics, lodOf: () => 0, surfaceAt: () => 'asphalt',
    waterHeightAt: () => null, reportCollision: () => {},
    gripOf: (n) => SURFACE_GRIP[n] ?? SURFACE_GRIP.asphalt,
    _world: () => null,
  };
}

const CTX = { events: { emit() {} }, peek: () => null, time: { elapsed: 0 } };
/**
 * The material library is the one thing in the vehicle model that wants a
 * canvas. Nothing here shades anything — only positions are read — so every
 * slot returns a throwaway standard material and the SHAPE is the real one.
 */
const MATS = new Proxy({}, { get: () => (() => new THREE.MeshStandardMaterial()) });

const CAR_TYPES = Object.keys(VEHICLE_SPECS).filter((k) => VEHICLE_SPECS[k].kind === 'car');
const TYPES = args.type ? String(args.type).split(',') : CAR_TYPES;

function spawnVehicle(type) {
  const src = VEHICLE_SPECS[type];
  const spec = finalizeSpec({ ...src, style: { ...src.style } });
  const model = buildVehicleModel(spec, MATS, { paint: 0x334455 });
  setVehicleLod(model, 0);
  const v = new Vehicle(makeWorld(), spec, model, {});
  v.damage = null;
  v.setPose(new THREE.Vector3(0, spec.comY, 0), 0);
  return { v, spec, model };
}

function drive(v, input, n) {
  for (let i = 0; i < n; i++) {
    v.input.throttle = input.throttle ?? 0;
    v.input.brake = input.brake ?? 0;
    v.input.steer = input.steer ?? 0;
    v.input.reverse = 0;
    v.input.handbrake = false;
    v.input.boost = 0;
    v.fixedStep(DT, CTX);
  }
}

/* ------------------------------------------------------------------ */
/* The pedestrian, built the way `PedSystem` builds one.               */
/* ------------------------------------------------------------------ */

const rng = new Rng(20260728);
const VARIANTS = new Map();
function variantOf(shape) {
  let v = VARIANTS.get(shape);
  if (!v) { v = buildOutfit(shape, { rng: rng.fork() }); VARIANTS.set(shape, v); }
  return v;
}
for (const s of SHAPE_IDS) variantOf(s);

const VEHSTUB = { seatAnchor: VehicleSystem.prototype.seatAnchor };
function makePedSys() {
  return {
    ctx: CTX,
    phys: null,
    _vehicles: VEHSTUB,
    probeFn: (x, z, fy, out) => { out.y = 0; out.nx = 0; out.ny = 1; out.nz = 0; out.hit = true; return true; },
    net: { ready: false },
    groundAt: () => 0,
    lightAt: () => null,
    playerPos: new THREE.Vector3(1e6, 0, 1e6),
    hasPlayer: false,
  };
}

function makePed(shape, scale, withBody = true) {
  const ped = new Ped(makePedSys());
  const outfit = makeOutfit(rng.fork(), 'street', { rain: 0 });
  outfit.shape = shape;
  outfit.scale = scale;
  outfit.height = scale * 1.75;
  ped.spawn(outfit, new THREE.Vector3(0, 0, 0), 0, rng.fork());
  if (!withBody) return ped;
  const { bones, skeleton, root } = RIG.createSkeleton();
  const variant = variantOf(shape);
  const mesh = new THREE.SkinnedMesh(variant.geometry, new THREE.MeshStandardMaterial());
  const group = new THREE.Group();
  group.add(root);
  group.add(mesh);
  mesh.bind(skeleton);
  ped.attachBody({ shapeId: shape, group, mesh, bones, skeleton, crown: variant.crown });
  return ped;
}

/**
 * The negative controls, applied to a live `Ped` by monkey-patching the exact
 * behaviour under test. Nothing in `src/peds/` carries a debug flag for this.
 */
function applyControl(ped) {
  if (CONTROL === 'nopose') {
    // Exactly the shipped code: root = the chassis COM, standing idle, foot IK
    // driven by the LOD, spawn yaw kept.
    ped._seatPose = function (drawn) {
      void drawn;
      const p = this.vehicle?.position;
      if (!p) return false;
      this.position.set(p.x, p.y, p.z);
      return true;
    };
    ped._seatedVisual = function (dt, elapsed, an) {
      an.setState({ clip: 'idle', speed: 0, lookTarget: null, lookWeight: 0 });
      an.footIk = this.lod <= 1;
      this._animAccum += dt;
      an.update(this._animAccum, elapsed);
      this._animAccum = 0;
    };
  } else if (CONTROL === 'physpose') {
    const real = ped._seatPose.bind(ped);
    ped._seatPose = (drawn) => real(false);
  } else if (CONTROL === 'nosink') {
    // Pretend every silhouette is a bare 1.75 m skull, which is what
    // `vehicles.seatAnchor` already assumes and what the seat used to take on
    // faith. `attachBody` has already written the real one, so overwrite it and
    // stop it being refreshed.
    ped.crownBind = 1.752;
    ped._seatFor = null;
    Object.defineProperty(ped, 'crownBind', { value: 1.752, writable: false });
  } else if (CONTROL === 'noyaw') {
    // "A vehicle's nose is +Z and an actor's forward is -Z, so add half a turn"
    // — true in `src/player/`, false here. Turn the whole seated frame, which
    // is what taking that on trust produces: `_seatYaw` feeds the minimap and
    // the far crowd, `_seatQuat` orients the drawn body.
    const half = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    const real = ped._seatPose.bind(ped);
    ped._seatPose = (drawn) => {
      const r = real(drawn);
      ped.yaw += Math.PI;
      ped.targetYaw = ped.yaw;
      ped._seatQuat.multiply(half);
      return r;
    };
  } else if (CONTROL === 'blend') {
    // `_seatedVisual` with the one line that snaps the cross-fade removed.
    // Written out rather than wrapped: the snap happens inside the same call as
    // the `setState` that arms it, so there is nothing to intercept from
    // outside.
    ped._seatedVisual = function (dt, elapsed, an) {
      const v = this.vehicle;
      an.setState({
        clip: 'sit',
        speed: 0,
        lookTarget: this.lookWeight > 0 ? this.lookAt : null,
        lookWeight: this.lookWeight,
      });
      an.seatArg.steer = v?.input?.steer ?? 0;
      an.seatArg.drop = this._seatDrop;
      an.footIk = false;
      this._animSkip = 0;
      this._animAccum += dt;
      an.update(this._animAccum, elapsed);
      this._animAccum = 0;
      if (an.bones) {
        an.bonePos('Head', this._v2);
        const err = this._anchorY - this._v2.y;
        if (err > 1e-4 || err < -1e-4) {
          this.position.y += err;
          this.group.position.y = this.position.y;
          this.group.updateMatrixWorld(true);
        }
      }
    };
  }
  return ped;
}

/* ------------------------------------------------------------------ */
/* EMITTED GEOMETRY                                                    */
/* ------------------------------------------------------------------ */

/**
 * Every visible, indexed triangle of the DRAWN vehicle's OUTER SHELL, in world
 * space: paint, trim, chrome, glass and the two hinged doors.
 *
 * The filter is not decoration. The first version of this took every mesh, and
 * the "headroom over the crown" it reported was the distance to the nearest
 * SHUTLINE GROOVE — 0.2 to 3 mm on cars with 57 mm of real roof over the head,
 * because a panel gap is `cavity` geometry sitting in the paint surface. It
 * also read seat leather, the dashboard and lamp housings as things a head can
 * be "under". The shell is what a player looking at the car sees, and a head
 * inside it is a head inside the car.
 */
const SHELL = /^(paint|trim|chrome|glass|door_[lr])$/;
function carTriangles(model, out) {
  out.length = 0;
  model.root.updateWorldMatrix(true, true);
  const p = new THREE.Vector3();
  model.root.traverse((o) => {
    if (!o.isMesh || !SHELL.test(o.name)) return;
    for (let n = o; n; n = n.parent) if (n.visible === false) return;
    const attr = o.geometry.getAttribute('position');
    if (!attr) return;
    const idx = o.geometry.index;
    const count = idx ? idx.count : attr.count;
    for (let i = 0; i + 2 < count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const j = idx ? idx.getX(i + k) : i + k;
        p.fromBufferAttribute(attr, j).applyMatrix4(o.matrixWorld);
        out.push(p.x, p.y, p.z);
      }
    }
  });
  return out;
}

/**
 * Distance from `(x, y, z)` to the nearest triangle in `tris` along `up`, or -1
 * if there is nothing over it. Moller-Trumbore; no BVH, because 30k triangles
 * times a handful of queries is milliseconds.
 *
 * `up` is THE CAR'S up, not the world's, and that is not a convenience. The
 * body is bolted to a car that rolls, so "over his head" is a direction in the
 * car's frame; a world-vertical ray fired from a head in a car with three
 * degrees of roll leaves through the side glass rather than the roof and
 * reports a clearance that is an artefact of the corner the car is in. It made
 * the tightest reading swing 0.031 -> 0.006 m on one steering input with
 * nothing about the seating changed. Nothing here reads the seat: `up` comes
 * off the DRAWN car's own matrix.
 */
function hitAlong(tris, x, y, z, dx, dy, dz) {
  let best = Infinity;
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const hx = dy * e2z - dz * e2y;
    const hy = dz * e2x - dx * e2z;
    const hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (det > -1e-12 && det < 1e-12) continue;
    const inv = 1 / det;
    const sx = x - ax, sy = y - ay, sz = z - az;
    const u = (sx * hx + sy * hy + sz * hz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 1e-5 && t < best) best = t;
  }
  return best === Infinity ? -1 : best;
}

const _sv = new THREE.Vector3();
/** The DRAWN pedestrian: skinned vertices, in world space. */
function skinnedExtremes(mesh) {
  mesh.updateWorldMatrix(true, true);
  const attr = mesh.geometry.getAttribute('position');
  let topY = -Infinity, topI = 0, botY = Infinity;
  const top = new THREE.Vector3();
  for (let i = 0; i < attr.count; i++) {
    _sv.fromBufferAttribute(attr, i);
    mesh.applyBoneTransform(i, _sv);
    _sv.applyMatrix4(mesh.matrixWorld);
    if (_sv.y > topY) { topY = _sv.y; topI = i; top.copy(_sv); }
    if (_sv.y < botY) botY = _sv.y;
  }
  return { topY, botY, topI, top };
}

/**
 * How many skinned vertices have NO bodywork over them. The crown ray answers
 * "is the head in the car"; this answers "is any of him", which is the question
 * a shoulder through a door pillar fails.
 */
function verticesOutside(mesh, tris, up, sample) {
  mesh.updateWorldMatrix(true, true);
  const attr = mesh.geometry.getAttribute('position');
  const step = Math.max(1, Math.round(attr.count / sample));
  let outside = 0, tested = 0;
  let worst = 0;
  for (let i = 0; i < attr.count; i += step) {
    _sv.fromBufferAttribute(attr, i);
    mesh.applyBoneTransform(i, _sv);
    _sv.applyMatrix4(mesh.matrixWorld);
    tested++;
    const d = hitAlong(tris, _sv.x, _sv.y, _sv.z, up.x, up.y, up.z);
    if (d < 0) { outside++; if (_sv.y > worst) worst = _sv.y; }
  }
  return { outside, tested, worst };
}

/** The car's own underside: the lowest bodywork vertex, world space. */
function carUnderside(tris) {
  let lo = Infinity;
  for (let i = 1; i < tris.length; i += 3) if (tris[i] < lo) lo = tris[i];
  return lo;
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

const SPEEDS = [0, 14, 30];
const SCALES = [0.88, 1.0, 1.109];
const SHAPES = ['puffaM', 'hoodieF', 'shirtM'];

const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _local = new THREE.Vector3();
const lo = new THREE.Vector3();
const hi = new THREE.Vector3();
const _toe = new THREE.Vector3();
const _heel = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();

let worstHeadroom = Infinity;
let worstHeadroomAt = '';
let worstSole = Infinity;
let worstSoleAt = '';
let worstRide = 0;
let worstFace = Infinity;
let totalOutside = 0;

for (let ti = 0; ti < TYPES.length; ti++) {
  const type = TYPES[ti];
  const tris = [];
  for (let si = 0; si < SPEEDS.length; si++) {
    const target = SPEEDS[si];
    const scale = SCALES[(ti + si) % SCALES.length];
    const shape = SHAPES[(ti + si) % SHAPES.length];
    const { v, model } = spawnVehicle(type);
    drive(v, { brake: 1 }, 240);
    v.drivetrain.reset();
    if (target > 0) {
      for (let i = 0; i < 120 * 60 && v.forwardSpeed < target; i++) drive(v, { throttle: 1 }, 1);
    }
    const reached = v.forwardSpeed;

    const ped = applyControl(makePed(shape, scale));
    ped.vehicle = v;
    ped.seat = 0;
    ped.isDriver = true;
    ped.state = STATE.DRIVING;

    let headroom = Infinity, headroomFrame = -1;
    let sole = Infinity, ride = 0, face = Infinity, outside = 0, tested = 0;
    const FRAMES = 24;
    for (let f = 0; f < FRAMES; f++) {
      drive(v, { throttle: target > 0 ? 0.4 : 0, steer: Math.sin(f * 0.41) * 0.55 }, 2);
      // The DRAWN pose: a real frame lands between physics steps.
      v.syncTransforms((f % 4) / 4, 1 / 60);
      ped.update(1 / 60);
      ped.updateVisual(1 / 60, f / 60);

      // The DRAWN car's own frame — the basis every reading below is taken in.
      model.root.updateWorldMatrix(true, false);
      _p.setFromMatrixPosition(model.root.matrixWorld);
      _q.setFromRotationMatrix(model.root.matrixWorld);
      _up.set(0, 1, 0).applyQuaternion(_q);

      carTriangles(model, tris);
      const ex = skinnedExtremes(ped.mesh);
      const h = hitAlong(tris, ex.top.x, ex.top.y, ex.top.z, _up.x, _up.y, _up.z);
      if (h < 0) { headroom = -1; headroomFrame = f; }
      else if (headroom >= 0 && h < headroom) { headroom = h; headroomFrame = f; }
      const under = carUnderside(tris);
      const s = ex.botY - under;
      if (s < sole) sole = s;

      // Does the body ride the DRAWN car? Express where he is in the DRAWN
      // car's own frame and watch whether it moves. Nothing the seating code
      // computed is read.
      _local.copy(ped.position).sub(_p).applyQuaternion(_qi.copy(_q).invert());
      if (f === 0) { lo.copy(_local); hi.copy(_local); }
      else { lo.min(_local); hi.max(_local); }

      // Which way is he facing? Read the EMITTED toe against the EMITTED heel
      // and project onto the car's nose direction. Never against `ped.yaw`.
      ped.animator.bonePos('ToeR', _toe);
      ped.animator.bonePos('FootR', _heel);
      _toe.sub(_heel);
      _fwd.set(0, 0, 1).applyQuaternion(_q);
      const dot = _toe.x * _fwd.x + _toe.z * _fwd.z;
      if (dot < face) face = dot;

      if (f === FRAMES - 1) {
        const vo = verticesOutside(ped.mesh, tris, _up, 420);
        outside = vo.outside;
        tested = vo.tested;
      }
    }

    ride = Math.max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z);

    const tag = `${type}@${Math.round(reached)}m/s s${scale.toFixed(2)}`;
    if (headroom < worstHeadroom) { worstHeadroom = headroom; worstHeadroomAt = tag; }
    if (sole < worstSole) { worstSole = sole; worstSoleAt = tag; }
    if (ride > worstRide) worstRide = ride;
    if (face < worstFace) worstFace = face;
    totalOutside += outside;

    ok(`${tag}: crown is under bodywork`, headroom >= MIN_HEADROOM,
      headroom < 0
        ? `NOTHING above the crown (worst frame ${headroomFrame})`
        : `headroom ${headroom.toFixed(3)} m (want >= ${MIN_HEADROOM})`);
    ok(`${tag}: no part of him is outside the car`, outside === 0,
      `${outside}/${tested} skinned vertices with no bodywork over them`);
    ok(`${tag}: soles stay above the rocker`, sole > -MAX_SOLE_UNDER,
      `lowest vertex ${sole.toFixed(3)} m vs the underside (want > ${-MAX_SOLE_UNDER})`);
    ok(`${tag}: rides the DRAWN car`, ride <= MAX_RIDE_SPREAD,
      `wanders ${ride.toFixed(4)} m in the drawn car's frame (want <= ${MAX_RIDE_SPREAD})`);
    ok(`${tag}: faces the way the car does`, face > 0.01,
      `toe-ahead-of-heel along the nose ${face.toFixed(4)} m (want > 0)`);
  }
}

/* ------------------------------------------------------------------ */
/* LOD2 — a different mesh entirely                                    */
/* ------------------------------------------------------------------ */

/**
 * Between 58 m (where `peds` stops handing out skinned bodies) and 118 m (where
 * `traffic` unseats) every driver in the city is drawn by `FarCrowd`, which
 * before this change stacked a STANDING capsule figure off the same point. That
 * is a different piece of geometry from the skinned mesh and it has to be
 * gated separately, or the fix is only true for the nearest 58 m.
 */
{
  const parent = new THREE.Group();
  const far = new FarCrowd(parent, 64, new THREE.MeshStandardMaterial());
  const tris = [];
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const capA = new THREE.Vector3();
  const capB = new THREE.Vector3();

  for (const type of TYPES) {
    const { v, model } = spawnVehicle(type);
    drive(v, { brake: 1 }, 240);
    v.drivetrain.reset();
    for (let i = 0; i < 120 * 60 && v.forwardSpeed < 16; i++) drive(v, { throttle: 1 }, 1);
    const ped = applyControl(makePed('puffaM', 1.05, false));
    ped.vehicle = v;
    ped.seat = 0;
    ped.isDriver = true;
    ped.state = STATE.DRIVING;
    ped.lod = 2;

    let worst = Infinity;
    let low = Infinity;
    for (let f = 0; f < 8; f++) {
      drive(v, { throttle: 0.4, steer: Math.sin(f * 0.5) * 0.4 }, 2);
      v.syncTransforms((f % 4) / 4, 1 / 60);
      ped.update(1 / 60);
      ped._seatPose(true);
      far.begin();
      if (CONTROL === 'nopose') far.addPed(ped, 0.25);
      else far.addSeated(ped);
      far.end();
      carTriangles(model, tris);
      model.root.updateWorldMatrix(true, false);
      _q.setFromRotationMatrix(model.root.matrixWorld);
      _up.set(0, 1, 0).applyQuaternion(_q);
      // The emitted instance matrices ARE the far figure. Every capsule end is
      // an extreme of it, so the same two questions the skinned body is asked
      // — is the TOP of him under bodywork, is the BOTTOM of him above the
      // rocker — can be put to the whole set.
      const under = carUnderside(tris);
      for (let i = 0; i < far.mesh.count; i++) {
        far.mesh.getMatrixAt(i, m);
        m.decompose(pos, quat, scl);
        capA.copy(pos);
        capB.set(0, scl.y, 0).applyQuaternion(quat).add(pos);
        for (const c of [capA, capB]) {
          if (c.y - under < low) low = c.y - under;
          // Only the upper half of the figure answers the headroom question:
          // a foot 6 mm under a floor pan is a `soles` finding, not a head
          // through a roof, and folding the two together buried the one this
          // change exists for behind the other.
          if (c.y < ped.position.y + 0.55 * (ped.scale ?? 1)) continue;
          const d = hitAlong(tris, c.x, c.y, c.z, _up.x, _up.y, _up.z);
          if (d < 0) { worst = -1; }
          else if (worst >= 0 && d < worst) worst = d;
        }
      }
    }
    ok(`${type} @LOD2: far-crowd driver's head is inside the car`, worst >= MIN_HEADROOM,
      worst < 0 ? 'a capsule end has NO bodywork over it'
        : `tightest capsule clearance ${worst.toFixed(3)} m`);
    ok(`${type} @LOD2: far-crowd driver stays above the rocker`, low > -MAX_SOLE_UNDER,
      `lowest capsule end ${low.toFixed(3)} m vs the underside`);
    if (worst < worstHeadroom) { worstHeadroom = worst; worstHeadroomAt = `${type}@LOD2`; }
    if (low < worstSole) { worstSole = low; worstSoleAt = `${type}@LOD2`; }
  }
  far.dispose();
}

/* ------------------------------------------------------------------ */

console.log('');
console.log(`seatprobe${CONTROL ? ` [control=${CONTROL}]` : ''}: ${pass}/${pass + fail}`);
console.log(`  worst headroom over the crown : ${worstHeadroom < 0 ? 'OUTSIDE THE CAR' : `${worstHeadroom.toFixed(3)} m`}  (${worstHeadroomAt})`);
console.log(`  lowest vertex vs the underside: ${worstSole.toFixed(3)} m  (${worstSoleAt})`);
console.log(`  worst drift off the drawn car : ${worstRide.toFixed(4)} m`);
console.log(`  toe ahead of heel, along nose : ${worstFace.toFixed(4)} m`);
console.log(`  skinned vertices outside      : ${totalOutside}`);
if (fail) {
  console.log('');
  for (const f of fails.slice(0, 12)) console.log(`  - ${f}`);
  if (fails.length > 12) console.log(`  ... and ${fails.length - 12} more`);
}
process.exit(fail ? 1 : 0);
