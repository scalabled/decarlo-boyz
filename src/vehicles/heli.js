/**
 * THE RIVERHOP — airframe geometry and the flight model.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE CONTROLLER AND NOT A CAR WITH THE WHEELS TURNED OFF
 * ────────────────────────────────────────────────────────────────────────────
 * The arcade way to fly a helicopter is to clamp an altitude scalar and lerp
 * the mesh toward it:
 *
 *     if (up)   altitude = clamp(altitude + 13*dt, 0, 55);
 *     if (down) altitude = clamp(altitude - 13*dt, 0, 55);
 *     mesh.position.y = lerp(mesh.position.y, altitude, 0.2);
 *
 * That works where the ground vehicles are also a scalar speed and a yaw. These
 * are not: they are a rigid body with an inertia tensor,
 * a Pacejka tyre at each corner and a suspension that solves. Bolting an
 * altitude scalar onto that model would mean writing `position.y` from outside
 * the integrator every step — which fights `_collide`, fights the sleep test,
 * and makes the machine weightless in a way you can feel the moment you try to
 * carry speed into a turn.
 *
 * So the helicopter gets its own force model, exactly as the boat does, and it
 * accumulates into the SAME rigid body. Nothing in `_stepWheels`, the tyre, the
 * drivetrain or the kerb machinery is touched or reachable from here:
 * `Vehicle.fixedStep` branches on `kind` once and the wheel path is simply not
 * taken. The gate for that claim is `drivetest.mjs`'s existing 340 assertions,
 * every one of which is a ground vehicle and none of which moves.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE MODEL, IN THE ORDER IT RUNS
 * ────────────────────────────────────────────────────────────────────────────
 * 1. GOVERNOR.  A real turbine or governed piston head holds NR constant and
 *    the pilot commands blade PITCH, not throttle. So `rotorSpin` is a 0..1
 *    spool that takes `spoolUp` seconds to wind up and `spoolDown` to run down,
 *    and available thrust scales with its SQUARE (thrust goes as the square of
 *    tip speed). That is why you cannot jump into a cold machine and leave —
 *    there is a four-and-a-half second wind-up, and it is audible and visible.
 *
 * 2. COLLECTIVE.  SPACE climbs, SHIFT descends. It is a VERTICAL SPEED
 *    command, not a position: the collective chases
 *    `climbGain * (vTarget - vy)` in acceleration and the thrust needed for
 *    that is what gets applied. Release both and the machine HOLDS THE
 *    ALTITUDE it was at, which is what a pilot's hand does and what makes the
 *    thing flyable on a keyboard.
 *
 *    ── WHY THE COLLECTIVE IS ON SPACE AND NOT SHIFT. MEASURED. ──
 *
 *    This shipped bound the other way round — Shift (`boost`) up, Space
 *    (`handbrake`) down — and in that state the machine could not climb at all:
 *    Space took it down, and nothing took it up.
 *
 *    THE FLIGHT MODEL WAS NEVER THE PROBLEM. Fed `boost = 1` directly, the
 *    machine climbs 86.5 m in 12 s from a cold start at 11.9 m/s. But `boost`
 *    is not what holding SHIFT delivers. `player/vehicle.js` routes the sprint
 *    control through the NITRO BOTTLE, which only opens above a throttle
 *    threshold and drains in 3.6 s:
 *
 *        const open = want && this.nitro > NITRO.cutoff
 *                          && this.throttle > NITRO.minThrottle;
 *
 *    Measured on the real `_stepNitro`, holding SHIFT for twenty seconds:
 *
 *        SHIFT alone      0.00 s of `boost`, bottle still full at 100
 *        SHIFT + W        6.05 s of `boost`, in stutters, bottle emptied
 *
 *    A helicopter has no throttle to hold — W is the fore/aft cyclic — so the
 *    gate can never open, and driving the whole thing end to end the machine
 *    reached a peak of 0.00 m in twenty seconds of holding the climb control.
 *    So the climb control had never once worked; it was not merely bound to
 *    the wrong key. That gate is `player/vehicle.js`'s to remove and the patch
 *    is reported rather than applied; this file does not own it.
 *
 *    So the collective moves to the channel that ARRIVES: `handbrake` is
 *    forwarded raw, ungated, straight from SPACE. That is also the mapping
 *    every game with a flyable vehicle uses — SPACE is jump on foot and up in
 *    the air, one idea in two contexts, which is CONTROLS.md's whole thesis.
 *
 *    DESCENT stays on `boost` (SHIFT), the natural pairing for it. It is the
 *    same dead channel until the reported patch lands, and that is
 *    stated here rather than hidden, because the failure is silent and looks
 *    like a flight-model bug. Driven end to end from a cold start, holding
 *    SPACE for twelve seconds, then SHIFT for twenty-five:
 *
 *        today          +86.5 m at 11.9 m/s, then 87.7 m -> 93.0 m. Airborne
 *                       with no way down.
 *        with the patch +86.5 m at 11.9 m/s, then 87.7 m -> 1.2 m, four skid
 *                       points on the ground.
 *
 *    Nothing on the SPACE half depends on that patch: the machine climbs on
 *    this file alone.
 *
 * 3. CYCLIC.  You do not push a helicopter forwards; you tilt the disc and the
 *    thrust vector goes with it. Holding W commands 14 degrees nose down and
 *    the machine accelerates because its lift is no longer straight up. That
 *    single fact is the whole feel of rotary flight: it leans into everything,
 *    it does not stop when you let go, and a hard turn makes it sag because
 *    the vertical component of a banked disc is smaller.
 *
 * 4. SKIDS.  Two tubes, four contact points, a stiff spring and Coulomb
 *    friction. No suspension model, because a skid has none.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PEDESTRIANS. THE EXEMPTION THAT MUST NOT BE LOST
 * ────────────────────────────────────────────────────────────────────────────
 * `physics` pushes a capsule radially out of every live vehicle
 * (`CharacterController._pushOutOfVehicles`). A helicopter at 40 m would
 * therefore shove everyone standing under it across the street. The exemption
 * is a single altitude test — a flying vehicle above 2 m blocks nobody —
 * published as `v.blocksPeds` and maintained here every step from the EMITTED
 * altitude. Two things make it hold today and tomorrow:
 *
 *   - GEOMETRICALLY, `_pushOutOfVehicles` already has a vertical gate
 *     (`headY < vy - hh`), so a machine whose underside is over a standing
 *     man's head cannot push him whatever any flag says. Because this
 *     controller flies the BODY — `position.y` genuinely rises — that gate is
 *     live from the first metre of climb and needs no cooperation from anyone.
 *   - EXPLICITLY, `blocksPeds` cuts at `rotor.pedBlockAlt` (2.0 m), which is
 *     LOWER than where the geometry cuts. It is the contract `physics` should
 *     adopt (`if (v.blocksPeds === false) continue;` in `_refreshBlockers`) so
 *     the boundary is stated rather than inferred. Reported up rather than
 *     edited, since `src/physics/` is a different directory.
 *
 * `drivetest.mjs`'s `heli` section gates both halves, and its negative control
 * pins the altitude at zero and watches both go red.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE GATE ON THE COLLECTIVE
 * ────────────────────────────────────────────────────────────────────────────
 * `src/vehicles/drivetest.mjs` section 11 flies the machine and asserts the
 * EMITTED `position.y` — never `climbCmd`, never `v.collective`, never
 * `v.holdAlt`, none of which this file's own arithmetic would be checked by.
 * Hold the climb key from a cold start and the body must actually rise; hold
 * the descend key and it must come down and land on its skids; let go and it
 * must hold the height inside the band the collective comment below documents.
 *
 * That section still encodes the OLD binding; the swap is reported as a patch
 * rather than applied. Measured against a patched copy, with every threshold
 * left exactly where it was:
 *
 *     13/13   binding swapped to match this file
 *      4/13   probe left on the old binding (what the tree reports today)
 *
 * Two negative controls, both run and both red (7 checks, keyed on the KEY the
 * player holds rather than on the channel, so a rebind moves them):
 *
 *      7/7    as it stands
 *      3/7    old binding restored — climb and descend swap places, so "hold
 *             DESCEND" reads +11.90 m/s and the machine gains 265 m
 *      4/7    collective removed (`thrustMax` 1.0, `climbUp` 0) — the build
 *             where a helicopter is scenery and nothing leaves the ground
 *
 * ONE NEW RISK THE SWAP CREATES, gated with the rest. `traffic.abandon()` and
 * `VehicleSystem._stage()` both pin `input.handbrake = true` to chock a
 * vehicle nobody is driving. That bit used to mean "descend" and was harmless;
 * it now means "climb", so a staged airframe flying out of a marketing frame
 * is a live possibility. The governor is what stops it — `wantRotor` needs
 * `v.driver` — and the check reads the emitted height, not the flag: a
 * driverless machine with the handbrake pinned rises 0.0000 m in 30 s.
 */

import * as THREE from 'three';
import { roundedBox, transform, tubeBetween, mergeAll, lathe, mirrorX } from './geom.js';

const GRAVITY = 9.81;

/* ====================================================================== */
/* Geometry                                                               */
/* ====================================================================== */

/** Per-LOD segment budgets: cabin rings, boom sides, blade spans. */
const SEG = [
  { ring: 14, tube: 12, lathe: 20 },
  { ring: 10, tube: 8, lathe: 14 },
  { ring: 6, tube: 6, lathe: 8 },
  { ring: 4, tube: 4, lathe: 6 },
];

/**
 * The airframe. Returns the same material-group shape `buildCarBody` does, plus
 * a `rotors` list: pivots that `build.js` turns into their own nodes because
 * they have to turn independently of the body.
 *
 * The silhouette has to be readable from 60 m — hard requirement in DESIGN.md —
 * and for a helicopter that means exactly four things, in this order of
 * importance: the DISC, the BOOM, the SKIDS and the glazed nose. Everything
 * else is detail.
 */
export function buildHeliBody(spec, lod = 0) {
  const s = spec.style;
  const seg = SEG[Math.min(SEG.length - 1, lod)];
  const out = {
    paint: [], trim: [], chrome: [], cavity: [], glass: [],
    lamps: {}, plate: [], disc: [], doors: [], rotors: [], anchors: {},
  };
  const lamp = (k, g) => (out.lamps[k] = out.lamps[k] ?? []).push(g);

  const cz0 = s.cabinZ0, cz1 = s.cabinZ1;
  const cy0 = s.cabinY0, cy1 = s.cabinY1;
  const hw = s.hwMax;
  const cabL = cz1 - cz0;
  const cabH = cy1 - cy0;

  /* ---- cabin pod ----------------------------------------------------- */
  // A teardrop: an ellipsoid squashed into the cabin box, then the nose pulled
  // forward and down so the glazing has somewhere to sit.
  const pod = new THREE.SphereGeometry(1, seg.ring, Math.max(4, seg.ring >> 1));
  scalePod(pod, hw, cabH * 0.5, cabL * 0.5, s.noseZ - cz1);
  transform(pod, { pos: [0, (cy0 + cy1) * 0.5, (cz0 + cz1) * 0.5] });
  out.paint.push(pod);

  // Belly pan — the machine reads as bottom-heavy from the side, which is what
  // stops it looking like a floating egg.
  const belly = roundedBox(hw * 1.62, 0.34, cabL * 0.86, 0.14, Math.max(2, seg.ring >> 2));
  transform(belly, { pos: [0, cy0 + 0.08, (cz0 + cz1) * 0.5 - 0.05] });
  out.paint.push(belly);

  /* ---- glazing ------------------------------------------------------- */
  // A bubble canopy: the same pod shape, scaled in a touch, keeping only the
  // forward two thirds. Built as its own shell so it takes the glass material.
  if (lod < 3) {
    const glassPod = new THREE.SphereGeometry(1, seg.ring, Math.max(4, seg.ring >> 1),
      0, Math.PI * 2, 0, Math.PI * 0.62);
    scalePod(glassPod, hw * 0.94, cabH * 0.48, cabL * 0.47, (s.noseZ - cz1) * 1.06);
    transform(glassPod, { pos: [0, (cy0 + cy1) * 0.5 + 0.06, (cz0 + cz1) * 0.5 + 0.14] });
    out.glass.push(glassPod);

    // Chin window: the panel under the pilot's feet that every light
    // helicopter has and that nothing else in the fleet does.
    const chin = roundedBox(hw * 1.05, 0.06, 0.62, 0.03, 2);
    transform(chin, { pos: [0, cy0 + 0.20, cz1 + 0.24], rot: [0.5, 0, 0] });
    out.glass.push(chin);
  }

  /* ---- cabin floor and seats ----------------------------------------- */
  if (lod < 2) {
    const floor = roundedBox(hw * 1.5, 0.05, cabL * 0.72, 0.02, 1);
    transform(floor, { pos: [0, s.floorY, (cz0 + cz1) * 0.5] });
    out.cavity.push(floor);
    for (const side of [-1, 1]) {
      const pan = roundedBox(0.44, 0.10, 0.46, 0.05, 2);
      transform(pan, { pos: [side * 0.42, s.floorY + 0.20, 0.62] });
      out.trim.push(pan);
      const back = roundedBox(0.44, 0.56, 0.09, 0.04, 2);
      transform(back, { pos: [side * 0.42, s.floorY + 0.50, 0.38], rot: [-0.12, 0, 0] });
      out.trim.push(back);
    }
    // Collective and cyclic sticks — the two controls this vehicle actually has.
    out.chrome.push(tubeBetween(
      new THREE.Vector3(0.14, s.floorY + 0.06, 0.72),
      new THREE.Vector3(0.14, s.floorY + 0.52, 0.66), 0.018, 6));
    out.chrome.push(tubeBetween(
      new THREE.Vector3(0.62, s.floorY + 0.10, 0.34),
      new THREE.Vector3(0.40, s.floorY + 0.30, 0.86), 0.022, 6));
  }

  /* ---- tail boom ----------------------------------------------------- */
  // A tapered cone from the cabin's rear bulkhead to the fin root.
  const boom = new THREE.CylinderGeometry(s.boomR1, s.boomR0,
    Math.abs(s.boomZ1 - s.boomZ0), seg.tube, 1);
  transform(boom, {
    pos: [0, s.boomY, (s.boomZ0 + s.boomZ1) * 0.5],
    rot: [Math.PI * 0.5, 0, 0],
  });
  out.paint.push(boom);

  // Vertical fin, swept, with the tail rotor hung off its left face.
  const fin = roundedBox(0.07, s.finY - s.boomY + 0.42, s.finChord, 0.03, 2);
  transform(fin, { pos: [0, (s.finY + s.boomY) * 0.5 + 0.2, s.finZ], rot: [0.34, 0, 0] });
  out.paint.push(fin);
  // Ventral fin — the little downward blade that stops a boom strike reading as
  // a chopped-off tube.
  const vfin = roundedBox(0.06, 0.42, 0.4, 0.03, 1);
  transform(vfin, { pos: [0, s.boomY - 0.28, s.finZ - 0.1], rot: [-0.3, 0, 0] });
  out.trim.push(vfin);

  // Horizontal stabiliser.
  const stab = roundedBox(s.stabW * 2, 0.05, 0.38, 0.02, 1);
  transform(stab, { pos: [0, s.stabY, s.stabZ] });
  out.paint.push(stab);

  /* ---- mast and hub -------------------------------------------------- */
  const mast = new THREE.CylinderGeometry(s.mastR, s.mastR * 1.25, s.mastY1 - s.mastY0, seg.tube);
  transform(mast, { pos: [0, (s.mastY0 + s.mastY1) * 0.5, 0.0] });
  out.chrome.push(mast);
  // Transmission fairing at the mast root: the hump behind the cabin.
  const gearbox = roundedBox(0.58, 0.42, 0.86, 0.16, Math.max(2, seg.ring >> 2));
  transform(gearbox, { pos: [0, s.mastY0 - 0.14, -0.05] });
  out.paint.push(gearbox);

  /* ---- lamps --------------------------------------------------------- */
  lamp('head', transform(
    new THREE.SphereGeometry(s.headlight.w, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.5),
    { pos: [0, s.headlight.y, s.noseZ - 0.14], rot: [Math.PI * 0.5, 0, 0] }
  ));
  // Anti-collision beacon on the fin, and a strobe under the belly.
  lamp('brake', transform(new THREE.SphereGeometry(s.taillight.w, 8, 6),
    { pos: [0, s.taillight.y, s.finZ - 0.14] }));
  lamp('indicator', transform(new THREE.SphereGeometry(0.07, 8, 6),
    { pos: [0, cy0 + 0.02, 0.1] }));

  /* ---- skids --------------------------------------------------------- */
  const skidY = s.skidY;
  for (const side of [-1, 1]) {
    // The tube itself, with the forward end swept up like a real skid toe.
    out.trim.push(tubeBetween(
      new THREE.Vector3(side * s.skidX, skidY, s.skidZ0),
      new THREE.Vector3(side * s.skidX, skidY, s.skidZ1), s.skidR, seg.tube));
    out.trim.push(tubeBetween(
      new THREE.Vector3(side * s.skidX, skidY, s.skidZ1),
      new THREE.Vector3(side * s.skidX * 0.94, skidY + 0.22, s.skidZ1 + 0.34),
      s.skidR * 0.9, Math.max(4, seg.tube >> 1)));
    // Two struts per side, splayed.
    for (const z of [s.skidZ1 - 0.55, s.skidZ0 + 0.5]) {
      out.trim.push(tubeBetween(
        new THREE.Vector3(side * s.skidX, skidY + s.skidR, z),
        new THREE.Vector3(side * hw * 0.55, cy0 + 0.06, z * 0.9),
        s.skidR * 0.8, Math.max(4, seg.tube >> 1)));
    }
  }

  /* ---- rotors (their own nodes — they turn) --------------------------- */
  const blade = (len, chord, thick, taper) => {
    const g = roundedBox(chord, thick, len, thick * 0.45, 1);
    // Root cuff to tip: taper the chord so it is not a plank.
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = Math.max(0, Math.min(1, (p.getZ(i) + len * 0.5) / len));
      p.setX(i, p.getX(i) * (1 - t * taper));
    }
    g.computeVertexNormals();
    return g;
  };

  {
    const parts = [];
    const R = spec.rotor?.radius ?? 5;
    const hubCap = lathe(
      [{ x: 0.001, y: 0.10 }, { x: 0.13, y: 0.07 }, { x: 0.20, y: 0.0 }, { x: 0.10, y: -0.06 }],
      Math.max(6, seg.lathe >> 1)
    );
    parts.push(hubCap);
    const n = Math.max(2, s.blades | 0);
    for (let i = 0; i < n; i++) {
      const b = blade(R - 0.22, s.bladeChord, s.bladeThick, 0.28);
      // A little coning and a little pitch, so the disc is not a flat cross.
      transform(b, { pos: [0, 0.03, (R - 0.22) * 0.5 + 0.2], rot: [0, 0, 0.055] });
      transform(b, { rot: [0, (i * Math.PI * 2) / n, 0] });
      parts.push(b);
    }
    out.rotors.push({
      geo: mergeAll(parts), axis: 'y', material: 'trim',
      pos: [0, s.hubY, 0],
    });
  }
  {
    const parts = [];
    const n = Math.max(2, s.tailBlades | 0);
    for (let i = 0; i < n; i++) {
      const b = blade(s.tailR * 2 - 0.1, 0.13, 0.03, 0.2);
      transform(b, { rot: [Math.PI * 0.5, 0, 0] });
      transform(b, { rot: [0, 0, (i * Math.PI) / n] });
      parts.push(b);
    }
    const hub = new THREE.CylinderGeometry(0.07, 0.07, 0.09, 8);
    transform(hub, { rot: [0, 0, Math.PI * 0.5] });
    parts.push(hub);
    out.rotors.push({
      geo: mergeAll(parts), axis: 'x', material: 'trim',
      pos: [s.tailX, s.tailY, s.tailZ],
    });
  }

  out.anchors = { hubY: s.hubY, floorY: s.floorY };
  out.surface = null;
  return out;
}

/** Squash a unit sphere into an ellipsoid and pull its nose out. */
function scalePod(g, hx, hy, hz, noseOut) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // Forward half stretches; the roof over the nose drops away.
    const f = Math.max(0, z);
    p.setXYZ(i, x * hx * (1 - f * 0.24), y * hy * (1 - f * 0.30) + f * f * -0.06, z * hz + f * noseOut);
  }
  g.computeVertexNormals();
  return g;
}

/* ====================================================================== */
/* Flight model                                                           */
/* ====================================================================== */

/** Four skid contact points, in body-local metres from the CoM. */
export function makeSkidPoints(spec) {
  const s = spec.style;
  const y = s.skidY - s.skidR - spec.comY;
  const out = [];
  for (const side of [-1, 1]) {
    for (const z of [s.skidZ1 - 0.35, s.skidZ0 + 0.35]) {
      out.push(new THREE.Vector3(side * s.skidX, y, z));
    }
  }
  return out;
}

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _p = new THREE.Vector3();
const _r = new THREE.Vector3();
const _f = new THREE.Vector3();
const _t = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _dir = new THREE.Vector3(0, -1, 0);

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/**
 * One flight step. Accumulates into the Vehicle's force/torque exactly as the
 * wheel model and the hull model do, so the same integrator handles all three.
 */
export function stepHeli(v, dt, ctx) {
  const spec = v.spec;
  const R = spec.rotor;
  const q = v.quaternion;
  _fwd.set(0, 0, 1).applyQuaternion(q);
  _right.set(1, 0, 0).applyQuaternion(q);
  _up.set(0, 1, 0).applyQuaternion(q);

  const phys = v.sys.physics;
  const weight = v.mass * GRAVITY;

  /* ---- 1. governor ---------------------------------------------------- */
  const wantRotor = v.engineOn && !v.destroyed && !v.fuelDry && !!v.driver;
  const target = wantRotor ? 1 : 0;
  const rate = target > v.rotorSpin ? 1 / R.spoolUp : 1 / R.spoolDown;
  v.rotorSpin = clamp(v.rotorSpin + (target - v.rotorSpin > 0 ? rate : -rate) * dt, 0, 1);
  // Blade phase, for the mesh. Radians; `syncTransforms` writes it.
  const headW = R.nominal * v.rotorSpin;
  v.rotorPhase = (v.rotorPhase + headW * dt) % (Math.PI * 2);
  v.tailPhase = (v.tailPhase + headW * R.tailRatio * dt) % (Math.PI * 2);
  // Thrust goes as the square of tip speed.
  const authority = v.rotorSpin * v.rotorSpin;

  /* ---- 2. altitude ---------------------------------------------------- */
  // Above ground level, from the SKIDS. `groundHeight` is analytic and
  // city-wide (see ARCHITECTURE's collision contract), so this is valid at 180 m
  // where a short raycast would find nothing and read as infinite altitude.
  const gy = phys?.groundHeight
    ? phys.groundHeight(v.position.x, v.position.z, v.position.y + 4)
    : 0;
  const ground = Number.isFinite(gy) ? gy : 0;
  const skidLocal = spec.comY - (spec.style.skidY - spec.style.skidR);
  v.altitude = Math.max(0, v.position.y - skidLocal - ground);
  v.groundY = ground;

  /**
   * THE PEDESTRIAN EXEMPTION. See this file's header. `physics` owns the push;
   * this is the predicate it should consume, published from the altitude the
   * body actually reached rather than from the control that asked for it.
   */
  v.blocksPeds = v.altitude <= R.pedBlockAlt;

  /* ---- 3. controls ---------------------------------------------------- */
  /**
   * SPACE climbs, SHIFT descends — see the header for the measurement that
   * decided which way round these go. W/S is the fore/aft cyclic and A/D the
   * pedals, so no new control is invented and no channel is doubled up.
   *
   * `handbrake` is the SPACE bit and it is the one that matters: it is
   * forwarded to `VehicleSystem.setInput` raw, so the climb command cannot be
   * swallowed by a resource meter the way `boost` is. Both held cancels to
   * zero and falls through to the altitude hold below, which is what a pilot
   * with his hand still on the lever would get.
   */
  const up = v.input.handbrake ? 1 : 0;
  const down = clamp(v.input.boost ?? 0, 0, 1);
  const climbCmd = clamp(up - down, -1, 1);
  const fore = clamp((v.control.throttle ?? 0) - (v.control.brake ?? 0), -1, 1);
  const pedal = clamp(v.control.steer ?? 0, -1, 1);

  /* ---- 4. collective -------------------------------------------------- */
  const vy = v.velocity.y;
  const landed = v.altitude < 0.3 && v.grounded > 0;
  let vTarget;
  /**
   * `holdAlt` LEADS by the arrest distance, and that is what makes the hover
   * crisp instead of a bounce.
   *
   * Latching it at the CURRENT altitude while climbing means that the moment
   * you let go of the collective the machine is already several metres above
   * the height it is trying to hold, and it flies back down to it: measured, a
   * 7.0 m band over eight seconds of "hover" after a 12 m/s climb, settling
   * back to within 0.10 m. Correct, and horrible.
   *
   * A pilot does not do that — he arrests the climb and holds where he ends up.
   * `vy / climbGain` is exactly that height: it is how far the collective
   * loop's own first-order response carries the machine before it stops.
   */
  if (climbCmd > 0.01) {
    vTarget = climbCmd * R.climbUp;
    v.holdAlt = v.altitude + vy / R.climbGain;
  } else if (climbCmd < -0.01) {
    vTarget = climbCmd * R.climbDown;
    v.holdAlt = Math.max(0, v.altitude + vy / R.climbGain);
  } else if (landed || !wantRotor) {
    // Sitting on the skids with no collective: flat pitch. The machine stays
    // where it is because the skids hold it, not because thrust cancels gravity.
    vTarget = null;
    v.holdAlt = v.altitude;
  } else {
    // Hands off in the air: hold the height you were at. A helicopter does not
    // do this by itself, but a pilot's hand does, and the alternative on a
    // keyboard is a machine that sinks whenever you stop thinking about it.
    vTarget = clamp(R.holdGain * (v.holdAlt - v.altitude), -4, 4);
  }

  // Ceiling: the EXCESS thrust over a hover fades out over the last
  // `ceilingFade` metres, so you drift up to it and stop. No clamp, no
  // teleport, and you can still hover and manoeuvre at the top.
  const ceilFrac = clamp((R.ceiling - v.altitude) / R.ceilingFade, 0, 1);
  // Translational lift: the disc is more efficient with air flowing through it.
  const etl = 1 + R.etlGain * Math.min(1, v.speed / R.etlSpeed);
  const hoverT = weight;
  const maxT = (hoverT + (R.thrustMax * weight - hoverT) * ceilFrac) * authority * etl;

  let thrust = 0;
  if (vTarget !== null && authority > 1e-3) {
    const accCmd = R.climbGain * (vTarget - vy);
    // A tilted disc has to make MORE thrust to hold the same height, which is
    // why a helicopter sags in a hard turn. `up.y` is exactly that cosine.
    const cosTilt = Math.max(0.35, _up.y);
    thrust = clamp((v.mass * (GRAVITY + accCmd)) / cosTilt, 0, maxT);
  }
  v.collective = maxT > 1e-3 ? thrust / maxT : 0;
  v.rotorThrust = thrust;
  if (thrust > 0) {
    _f.copy(_up).multiplyScalar(thrust);
    // At the hub. `r x F` is zero for a force along the mast, so this adds no
    // torque of its own — but it is where the force physically acts, and it is
    // where a future ground-effect or vortex-ring term would have to go.
    _r.set(0, spec.style.hubY - spec.comY, 0).applyQuaternion(q);
    v.addForceAtLocal(_f, _r);
  }

  /* ---- 5. cyclic and pedals ------------------------------------------- */
  // Commanded attitude. Nose DOWN to go forward: that is how a helicopter
  // accelerates, and it is why it noses up when you brake.
  const pitchCmd = -fore * R.pitchMax * (0.35 + 0.65 * authority);
  const rollCmd = -pedal * R.rollMax * Math.min(1, v.speed / 14) * (0.35 + 0.65 * authority);

  const pitch = Math.asin(clamp(_fwd.y, -1, 1));
  /**
   * `atan2`, NOT `asin`, and this one is load-bearing.
   *
   * `asin(right.y)` folds at +/-90 degrees: a machine rolled to 120 reads as 60
   * and the controller cheerfully drives it the rest of the way over, where it
   * finds a SECOND stable equilibrium upside down. Measured, and it is not a
   * theoretical state — a running landing on skids at 25 m/s puts a large
   * friction force 1.19 m below the centre of mass, which is more than enough
   * to flip it, and it then sat inverted on its rotor at y = -1.20 with all
   * four skid points reporting contact and the collective refusing to lift.
   * `atan2(right.y, up.y)` is continuous through +/-180, so inverted is an
   * error of pi and the controller rolls it back the short way.
   */
  const roll = Math.atan2(_right.y, _up.y);
  const wPitch = v.angularVelocity.dot(_right);
  const wRoll = v.angularVelocity.dot(_fwd);
  const wYaw = v.angularVelocity.dot(_up);

  const I = spec.inertia;
  /**
   * Sign derivation, because getting one of these backwards produces a machine
   * that flies away from you and looks like a physics blow-up:
   *   about local +X  a positive rotation takes +Y toward +Z, so `fwd.y` goes
   *                   NEGATIVE — positive torque about +X pitches the nose DOWN.
   *                   Therefore d(pitch)/dt = -w_x and the sign flips.
   *   about local +Z  a positive rotation takes +X toward +Y, so `right.y` goes
   *                   POSITIVE — d(roll)/dt = +w_z, no flip.
   * `drivetest.mjs` asserts both from the emitted world-space motion, never
   * from these constants.
   */
  const tPitch = -I.x * (R.attStiff * (pitchCmd - pitch) + R.attDamp * wPitch);
  const tRoll = I.z * (R.attStiff * (rollCmd - roll) - R.attDamp * wRoll);
  const yawCmd = pedal * R.yawRate * (0.25 + 0.75 * authority);
  const tYaw = I.y * (R.yawStiff * (yawCmd - wYaw) - R.yawDamp * wYaw * 0.15);

  _t.copy(_right).multiplyScalar(tPitch);
  v.addTorque(_t);
  _t.copy(_fwd).multiplyScalar(tRoll);
  v.addTorque(_t);
  _t.copy(_up).multiplyScalar(tYaw);
  v.addTorque(_t);

  /* ---- 6. rotor-disc drag --------------------------------------------- */
  // On top of `_aero`'s fuselage drag: a spinning disc edge-on to the airflow
  // is a large flat plate, and it is most of what limits a helicopter's speed.
  if (v.speed > 0.2) {
    _f.copy(v.velocity).multiplyScalar(-R.discDrag * v.speed * authority);
    v.addForce(_f);
  }

  /* ---- 7. skids -------------------------------------------------------- */
  /**
   * A skid is a tube, not a wheel: no suspension, no rolling, a stiff spring
   * and a lot of scrub. Four points, one short ray each.
   *
   * THE FORCE IS CAPPED, SO THE SPRING ALONE CANNOT DIG THE MACHINE OUT, and a
   * capped spring on its own left a crashed helicopter STABLE 0.79 m under the
   * ground with its nose buried — measured, after a 25 m/s arrival with no
   * cyclic. Uncapping it is not the answer either: an uncapped 165 kN/m spring
   * against a 2 m insertion is 330 kN on a 1.25 t airframe, which fires it into
   * orbit on one step.
   *
   * So the spring TRAVEL is capped rather than its force, and anything past
   * that is resolved the way `Vehicle._collide` resolves a deep contact: a
   * damped POSITIONAL correction. Same mechanism, same 0.5 damping, and it
   * makes burial unreachable rather than merely unlikely.
   */
  let contacts = 0;
  let deepest = 0;
  const pts = v.skidPoints;
  const maxRay = 1.2;
  const MAX_SPRING = 0.30;
  for (let i = 0; i < pts.length; i++) {
    _p.copy(pts[i]).applyQuaternion(q).add(v.position);
    const hit = phys.raycast(_p, _dir, maxRay, phys.MASK?.WORLD ?? 0);
    // The analytic ground is the fallback whenever the ray finds nothing, and
    // that includes a point already BELOW it — where a downward ray finds
    // nothing at all and the naive reading is "no contact, keep sinking".
    const hitY = hit?.hit ? hit.point.y : (_p.y - ground < maxRay ? ground : null);
    if (hitY === null) continue;
    const pen = hitY - _p.y;
    if (pen < -0.02) continue;
    contacts++;
    if (pen > MAX_SPRING) deepest = Math.max(deepest, pen - MAX_SPRING);
    _r.copy(pts[i]).applyQuaternion(q);
    _vel.copy(v.angularVelocity).cross(_r).add(v.velocity);
    let fy = R.skidK * Math.min(Math.max(0, pen), MAX_SPRING) - R.skidC * _vel.y;
    fy = clamp(fy, 0, weight * 1.6);
    _f.set(0, fy, 0);
    v.addForceAtLocal(_f, _r);
    /**
     * Coulomb friction: a skid does not roll, so it scrubs. RATE-LIMITED as
     * well as coefficient-limited, and both halves matter.
     *
     * The first cut used mu 0.85 and a 1/6 s time constant PER POINT, i.e. 1/24
     * of a second across the four of them. A running landing at 25 m/s then
     * produced ~33 kN of drag 1.19 m below the centre of mass, four times over
     * — 158 kN.m of pitching moment against a 7.7e3 kg.m^2 tensor, which is
     * 20 rad/s^2, and the machine somersaulted onto its back. A steel skid on
     * wet concrete is a slippery thing (0.55, not 0.85) and the whole gear
     * together bleeds tangential speed on about a sixth of a second, not a
     * twenty-fourth.
     */
    const tx = _vel.x, tz = _vel.z;
    const tl = Math.hypot(tx, tz);
    if (tl > 1e-3) {
      const fmax = R.skidMu * fy;
      const scale = Math.min(fmax, (tl * v.mass * 1.2) / pts.length) / tl;
      _f.set(-tx * scale, 0, -tz * scale);
      v.addForceAtLocal(_f, _r);
    }
  }
  if (deepest > 0) {
    // Damped positional correction, exactly as `_collide` does it, and capped
    // per step so a machine that has arrived inside the terrain is walked out
    // over a few frames rather than teleported.
    v.position.y += Math.min(deepest, 0.25) * 0.5;
    if (v.velocity.y < 0) v.velocity.y *= 0.4;
  }
  v.grounded = contacts;
  v.airborne = contacts === 0 ? v.airborne + dt : 0;
  v.inWater = false;

  return contacts;
}
