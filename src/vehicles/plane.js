/**
 * THE SKYLARK — a light fixed-wing aircraft: airframe geometry and the flight
 * model.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE CONTROLLER, LIKE THE BOAT AND THE HELICOPTER
 * ────────────────────────────────────────────────────────────────────────────
 * `heli.js` already made the argument in full: a car is a rigid body with a
 * Pacejka tyre and a suspension at each corner, and a flying machine is a rigid
 * body with an AERODYNAMIC force field. Neither is the other, so the aircraft
 * gets its own force model and accumulates into the SAME rigid body the wheel
 * and hull models use. `Vehicle.fixedStep` branches on `kind` once and the
 * wheel path is simply not taken — nothing in `_stepWheels`, the tyre or the
 * drivetrain is touched or reachable from here. The gate for that claim is
 * `drivetest.mjs`'s wheeled-vehicle assertions, none of which name a plane.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE MODEL, IN THE ORDER IT RUNS
 * ────────────────────────────────────────────────────────────────────────────
 * 1. THROTTLE.  A plane does not fly on a digital on/off thrust — you set a
 *    power lever and leave it. So SHIFT (`boost`) winds the throttle lever UP
 *    and SPACE (`handbrake`) winds it DOWN; release both and it HOLDS. This is
 *    the analogue of the helicopter's collective sitting where you leave it,
 *    and it is what makes a keyboard take-off possible: hold SHIFT down the
 *    runway, watch the airspeed build, and rotate. Thrust falls off with
 *    airspeed the way a fixed-pitch prop's does, so static thrust is strong
 *    (a short take-off roll) and the top speed self-limits without a clamp.
 *
 * 2. LIFT.  `L = q * S * CL`, dynamic pressure times wing area times the lift
 *    coefficient, and `CL` climbs with angle of attack until it STALLS. The one
 *    fact that makes an aeroplane an aeroplane is that lift goes as the SQUARE
 *    of airspeed: below flying speed the wing cannot hold the weight up whatever
 *    the pilot does with the stick, so the machine has to build speed on the
 *    ground before it will leave it, and it sinks the moment it drops back below
 *    that speed. That is emergent here, not scripted — it falls straight out of
 *    `q = ½ρV²`.
 *
 * 3. PITCH / ROLL / YAW.  W/S is the elevator, A/D the ailerons. The tail makes
 *    the aircraft weathercock into the airflow (directional stability) and the
 *    wing's static stability returns it toward its trim attitude, so it FLIES A
 *    LINE with the stick released instead of tumbling — that stability is the
 *    whole reason it can be flown round a circuit and landed on a keyboard. A
 *    banked turn needs no separate rudder key: rolled over, the lift vector
 *    tilts, its horizontal component curves the flight path, and the tail yaws
 *    the nose round to follow. A/D adds a little coordinating rudder on top, and
 *    ON THE GROUND it steers the nosewheel.
 *
 * 4. GEAR.  A tricycle undercarriage: three contact points, a stiff spring and
 *    ANISOTROPIC friction — it rolls almost freely fore/aft (so thrust builds
 *    speed) but grips hard sideways (so it tracks straight), and SPACE brakes
 *    the wheels. Modelled the same way the helicopter's skids are: short rays,
 *    a capped spring, a damped positional correction against burial.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE GATE
 * ────────────────────────────────────────────────────────────────────────────
 * `src/vehicles/flightprobe.mjs` flies the real `Vehicle` at the real 120 Hz
 * step and asserts the EMITTED position and orientation, never the control
 * inputs: throttle held from a standstill builds airspeed and, past flying
 * speed, the body leaves the ground and gains altitude; no throttle leaves it on
 * the runway (the negative control); cut the throttle in the air and it slows
 * below flying speed and descends; and W/S, A/D each move the emitted attitude
 * the right way. See that file's header for the numbers.
 */

import * as THREE from 'three';
import { roundedBox, transform, tubeBetween, mergeAll } from './geom.js';

const GRAVITY = 9.81;
const RHO = 1.225;

/* ====================================================================== */
/* Geometry                                                               */
/* ====================================================================== */

/** Per-LOD segment budgets: fuselage rings, tube sides, prop spans. */
const SEG = [
  { ring: 14, tube: 10 },
  { ring: 10, tube: 8 },
  { ring: 6, tube: 6 },
  { ring: 4, tube: 4 },
];

/**
 * The airframe. Returns the same material-group shape `buildHeliBody` and
 * `buildCarBody` do, plus a `rotors` list carrying the propeller — a pivot
 * `build.js` turns into its own node so it can spin about the nose axis.
 *
 * The silhouette has to read from 60 m, and for a light aircraft that means
 * four things in this order: the WING, the fuselage, the TAIL and the gear.
 */
export function buildPlaneBody(spec, lod = 0) {
  const s = spec.style;
  const seg = SEG[Math.min(SEG.length - 1, lod)];
  const out = {
    paint: [], trim: [], chrome: [], cavity: [], glass: [],
    lamps: {}, plate: [], disc: [], doors: [], rotors: [], anchors: {},
  };
  const lamp = (k, g) => (out.lamps[k] = out.lamps[k] ?? []).push(g);

  const fy = s.fuseY;

  /* ---- fuselage ------------------------------------------------------ */
  // A tapered tube: a fat cabin section that tapers to the tail cone, drawn as
  // an ellipsoid squashed into the fuselage box with its tail drawn out.
  const fuseL = s.fuseZ1 - s.fuseZ0;
  const pod = new THREE.SphereGeometry(1, seg.ring, Math.max(4, seg.ring >> 1));
  scaleFuse(pod, s.fuseR, s.fuseR * 0.94, fuseL * 0.5);
  transform(pod, { pos: [0, fy, (s.fuseZ0 + s.fuseZ1) * 0.5] });
  out.paint.push(pod);

  // Firewall / cowling at the nose, a short blunt cone the prop hangs off.
  const cowl = new THREE.CylinderGeometry(s.fuseR * 0.72, s.fuseR * 0.95,
    0.5, seg.ring, 1);
  transform(cowl, { pos: [0, fy, s.noseZ - 0.25], rot: [Math.PI * 0.5, 0, 0] });
  out.paint.push(cowl);
  const spinner = new THREE.ConeGeometry(0.16, 0.34, Math.max(6, seg.ring >> 1));
  transform(spinner, { pos: [0, fy, s.propZ + 0.04], rot: [-Math.PI * 0.5, 0, 0] });
  out.chrome.push(spinner);

  /* ---- cabin glazing ------------------------------------------------- */
  if (lod < 3) {
    // A greenhouse bubble: a CLOSED ellipsoid (no torn edges), sat into the
    // fuselage top over the cabin, its lower half hidden inside the fuselage.
    const cabL = s.cabinZ1 - s.cabinZ0;
    const bubble = new THREE.SphereGeometry(1, seg.ring, Math.max(5, seg.ring >> 1));
    const bp = bubble.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      bp.setXYZ(i, bp.getX(i) * s.fuseR * 0.88,
        bp.getY(i) * (s.cabinY1 - s.cabinY0) * 0.62,
        bp.getZ(i) * cabL * 0.5);
    }
    bubble.computeVertexNormals();
    transform(bubble, { pos: [0, (s.cabinY0 + s.cabinY1) * 0.5 + 0.14, (s.cabinZ0 + s.cabinZ1) * 0.5] });
    out.glass.push(bubble);
    // A raked windscreen panel up front.
    const wind = roundedBox(s.fuseR * 1.4, 0.44, 0.05, 0.03, 2);
    transform(wind, { pos: [0, s.cabinY1 - 0.02, s.cabinZ1 - 0.04], rot: [-0.55, 0, 0] });
    out.glass.push(wind);
  }

  /* ---- cabin floor and seats ----------------------------------------- */
  if (lod < 2) {
    const floor = roundedBox(s.fuseR * 1.4, 0.05, (s.cabinZ1 - s.cabinZ0) * 0.9, 0.02, 1);
    transform(floor, { pos: [0, s.floorY, (s.cabinZ0 + s.cabinZ1) * 0.5] });
    out.cavity.push(floor);
    for (const side of [-1, 1]) {
      const pan = roundedBox(0.42, 0.10, 0.46, 0.05, 2);
      transform(pan, { pos: [side * 0.34, s.floorY + 0.20, s.cabinZ0 + 0.7] });
      out.trim.push(pan);
      const back = roundedBox(0.42, 0.52, 0.09, 0.04, 2);
      transform(back, { pos: [side * 0.34, s.floorY + 0.48, s.cabinZ0 + 0.46], rot: [-0.12, 0, 0] });
      out.trim.push(back);
    }
    // Control yoke — the one control this vehicle actually has out front.
    out.chrome.push(tubeBetween(
      new THREE.Vector3(0, s.floorY + 0.30, s.cabinZ1 - 0.1),
      new THREE.Vector3(0, s.floorY + 0.44, s.cabinZ1 - 0.26), 0.02, 6));
  }

  /* ---- main wing (high or low; struts only on a high wing) ----------- */
  const halfSpan = s.wingSpan * 0.5;
  const wing = wingPanel(s.wingSpan, s.wingChord, s.wingThick, 0.42);
  transform(wing, { pos: [0, s.wingY, s.wingZ] });
  out.paint.push(wing);
  // Lift struts from the fuselage belly to mid-span — the tell of a high-wing.
  // A LOW wing (`wingY` at or under the fuselage centreline, like the
  // Slipstream's) is cantilevered and carries none; struts under a low wing
  // would read as landing-gear legs sprouting from the leading edge.
  if (s.wingY > fy) {
    for (const side of [-1, 1]) {
      out.trim.push(tubeBetween(
        new THREE.Vector3(side * 0.5, fy - s.fuseR * 0.5, s.wingZ + 0.1),
        new THREE.Vector3(side * halfSpan * 0.52, s.wingY - 0.05, s.wingZ),
        0.05, Math.max(4, seg.tube >> 1)));
    }
  }
  // Wingtip nav lamps: red to port, green to starboard.
  lamp('policeRed', transform(new THREE.SphereGeometry(0.08, 8, 6),
    { pos: [-halfSpan + 0.05, s.wingY + 0.02, s.wingZ - s.wingChord * 0.3] }));
  lamp('drl', transform(new THREE.SphereGeometry(0.08, 8, 6),
    { pos: [halfSpan - 0.05, s.wingY + 0.02, s.wingZ - s.wingChord * 0.3] }));

  /* ---- empennage ----------------------------------------------------- */
  // Horizontal stabiliser.
  const stab = wingPanel(s.stabSpan, s.stabChord, 0.10, 0.3);
  transform(stab, { pos: [0, fy + 0.06, s.stabZ] });
  out.paint.push(stab);
  // Vertical fin, swept.
  const fin = roundedBox(0.08, s.finY1 - s.finY0, s.finChord, 0.03, 2);
  transform(fin, { pos: [0, (s.finY0 + s.finY1) * 0.5, s.finZ], rot: [0.5, 0, 0] });
  out.paint.push(fin);
  lamp('brake', transform(new THREE.SphereGeometry(0.07, 8, 6),
    { pos: [0, s.finY1 - 0.08, s.finZ - s.finChord * 0.4] }));

  /* ---- landing gear (tricycle) --------------------------------------- */
  const gw = s.gearWheelR;
  const gearAt = (x, z) => {
    // Strut down from the belly to the axle, and a fat tyre.
    out.trim.push(tubeBetween(
      new THREE.Vector3(x * 0.4, fy - s.fuseR * 0.6, z),
      new THREE.Vector3(x, s.gearY + gw, z), 0.05, Math.max(4, seg.tube >> 1)));
    const tyre = new THREE.CylinderGeometry(gw, gw, 0.14, Math.max(8, seg.tube + 2));
    transform(tyre, { pos: [x, s.gearY + gw, z], rot: [0, 0, Math.PI * 0.5] });
    out.trim.push(tyre);
  };
  gearAt(0, s.gearNoseZ);
  gearAt(-s.gearX, s.gearMainZ);
  gearAt(s.gearX, s.gearMainZ);

  // Landing / taxi light in the cowl.
  lamp('head', transform(
    new THREE.SphereGeometry(s.headlight.w, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.5),
    { pos: [0, s.headlight.y, s.noseZ - 0.1], rot: [Math.PI * 0.5, 0, 0] }));

  /* ---- propeller (its own node — it turns about z) ------------------- */
  {
    const parts = [];
    const n = Math.max(2, s.propBlades | 0);
    const hub = new THREE.CylinderGeometry(0.08, 0.08, 0.12, 8);
    transform(hub, { rot: [Math.PI * 0.5, 0, 0] });
    parts.push(hub);
    for (let i = 0; i < n; i++) {
      const b = propBlade(s.propR, 0.14, 0.03);
      // Lay the blade out along +Y, pitch it, then space it round the hub.
      transform(b, { rot: [0, 0.28, (i * Math.PI * 2) / n] });
      parts.push(b);
    }
    out.rotors.push({
      geo: mergeAll(parts), axis: 'z', material: 'trim',
      pos: [0, fy, s.propZ],
    });
  }

  out.anchors = { propZ: s.propZ, floorY: s.floorY };
  out.surface = null;
  return out;
}

/** Squash a unit sphere into the fuselage ellipsoid, pinching toward the tail. */
function scaleFuse(g, hx, hy, hz) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // Aft half pinches toward the tail cone.
    const aft = Math.max(0, -z);
    p.setXYZ(i, x * hx * (1 - aft * 0.55), y * hy * (1 - aft * 0.4), z * hz);
  }
  g.computeVertexNormals();
  return g;
}

/** A wing/stab panel: a flat box tapered from root chord to tip. */
function wingPanel(span, chord, thick, taper) {
  const g = roundedBox(span, thick, chord, thick * 0.4, 1);
  const p = g.attributes.position;
  const half = span * 0.5;
  for (let i = 0; i < p.count; i++) {
    const t = Math.min(1, Math.abs(p.getX(i)) / half);
    // Taper the chord toward the tip, and sweep it back a touch.
    p.setZ(i, p.getZ(i) * (1 - t * taper) - t * chord * 0.12);
  }
  g.computeVertexNormals();
  return g;
}

/** A single prop blade, laid along +Y from the hub. */
function propBlade(len, chord, thick) {
  const g = roundedBox(chord, len, thick, thick * 0.4, 1);
  transform(g, { pos: [0, len * 0.5, 0] });
  return g;
}

/* ====================================================================== */
/* Flight model                                                           */
/* ====================================================================== */

/** Three gear contact points, in body-local metres from the CoM. */
export function makePlaneGear(spec) {
  const s = spec.style;
  const y = s.gearY - spec.comY;
  return [
    new THREE.Vector3(0, y, s.gearNoseZ),
    new THREE.Vector3(-s.gearX, y, s.gearMainZ),
    new THREE.Vector3(s.gearX, y, s.gearMainZ),
  ];
}

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _p = new THREE.Vector3();
const _r = new THREE.Vector3();
const _f = new THREE.Vector3();
const _t = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _qi = new THREE.Quaternion();
const _dir = new THREE.Vector3(0, -1, 0);

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/**
 * One flight step. Accumulates into the Vehicle's force/torque exactly as the
 * wheel and hull models do, so the same integrator handles all of them.
 */
export function stepPlane(v, dt, ctx) {
  const spec = v.spec;
  const F = spec.flight;
  const q = v.quaternion;
  _fwd.set(0, 0, 1).applyQuaternion(q);
  _right.set(1, 0, 0).applyQuaternion(q);
  _up.set(0, 1, 0).applyQuaternion(q);
  _qi.copy(q).invert();

  const phys = v.sys.physics;
  const weight = v.mass * GRAVITY;

  /* ---- 1. engine / throttle lever ------------------------------------- */
  // The prop only makes power with a pilot aboard and fuel in the tank; a
  // parked plane's lever bleeds back to idle so it does not taxi off on its own.
  const wantEngine = v.engineOn && !v.destroyed && !v.fuelDry && !!v.driver;
  const upT = v.input.boost ?? 0;            // SHIFT — throttle up
  const dnT = v.input.handbrake ? 1 : 0;     // SPACE — throttle down / brake
  let lever = v.throttleLever ?? 0;
  if (!wantEngine) {
    lever -= (1 / F.throttleRate) * dt;
  } else {
    lever += (clamp(upT, 0, 1) - dnT) * (1 / F.throttleRate) * dt;
  }
  lever = clamp(lever, 0, 1);
  v.throttleLever = lever;

  // Prop spool, for the mesh and the audio, and thrust scales with it so you
  // cannot firewall a cold engine and leave.
  const spoolTarget = wantEngine ? 1 : 0;
  const spoolRate = 1 / F.propSpool;
  v.rotorSpin = clamp(v.rotorSpin + (spoolTarget > v.rotorSpin ? spoolRate : -spoolRate) * dt, 0, 1);
  v.rotorPhase = (v.rotorPhase + (24 + 90 * lever) * v.rotorSpin * dt) % (Math.PI * 2);

  /* ---- 2. airspeed, angle of attack, sideslip ------------------------ */
  _vel.copy(v.velocity);
  const V = _vel.length();
  _vb.copy(_vel).applyQuaternion(_qi);        // velocity in body frame
  const along = _vb.z;                        // + is nose-first
  // Guard the small-speed singularity: below a walking pace there is no
  // meaningful angle of attack and no aerodynamic force at all.
  const flying = V > 3;
  const denom = Math.max(Math.abs(along), 2);
  const aoa = flying ? Math.atan2(-_vb.y, denom) + F.aoaTrim : 0;
  const beta = flying ? Math.atan2(_vb.x, denom) : 0;
  const qbar = 0.5 * RHO * V * V;
  // Control effectiveness rises with dynamic pressure; normalise by a reference
  // so the gains read as plain angular accelerations near flying speed.
  const dyn = clamp((V * V) / (F.Vref * F.Vref), 0, 2.2);

  /* ---- 3. altitude, from the gear, and the pedestrian exemption ------- */
  const gy = phys?.groundHeight
    ? phys.groundHeight(v.position.x, v.position.z, v.position.y + 4)
    : 0;
  const ground = Number.isFinite(gy) ? gy : 0;
  const gearLocal = spec.comY - spec.style.gearY;
  v.altitude = Math.max(0, v.position.y - gearLocal - ground);
  v.groundY = ground;
  v.blocksPeds = v.altitude <= F.pedBlockAlt;

  /* ---- 4. lift and drag ---------------------------------------------- */
  if (flying) {
    // Lift coefficient: linear in AoA, then it STALLS — past the critical angle
    // the coefficient falls away instead of climbing without bound, which is
    // what makes a stall a stall and not just "less lift".
    const aStall = F.aoaStall;
    const a = clamp(aoa, -1.4, 1.4);
    let cl;
    if (Math.abs(a) <= aStall) {
      cl = F.CL0 + F.CLalpha * a;
    } else {
      // Beyond the stall the coefficient falls away from its peak toward a low
      // post-stall plateau, keeping the sign it had at the critical angle.
      const peak = F.CL0 + F.CLalpha * aStall * Math.sign(a);
      const over = clamp((Math.abs(a) - aStall) / (1.4 - aStall), 0, 1);
      cl = peak * (1 - 0.7 * over);
    }
    cl = clamp(cl, -F.CLmax, F.CLmax);
    const lift = qbar * F.wingArea * cl;
    // Lift acts along the body-up axis (perpendicular to the wing). At small
    // bank/pitch that is where it is; the simplification buys a lot of stability.
    _f.copy(_up).multiplyScalar(lift);
    v.addForce(_f);

    // Drag: parasitic plus induced (induced grows with the square of CL). Along
    // the airflow, applied at the CoM so it adds no spurious moment.
    const AR = (F.span * F.span) / F.wingArea;
    const cdi = (cl * cl) / (Math.PI * F.oswald * AR);
    const drag = qbar * F.wingArea * (F.CD0 + cdi);
    _f.copy(_vel).multiplyScalar(-drag / Math.max(V, 1e-3));
    v.addForce(_f);
  }

  /* ---- 5. thrust ------------------------------------------------------ */
  // A fixed-pitch prop: static thrust is strong and falls toward zero as the
  // aircraft catches up to the pitch speed, so the top speed self-limits.
  const thrust = lever * v.rotorSpin * F.maxThrust *
    clamp(1 - Math.max(0, along) / F.propVmax, 0.05, 1) * (v.hero?.plane ?? 1);
  v.rotorThrust = thrust;
  v.propThrust = thrust;
  if (thrust > 0) {
    _f.copy(_fwd).multiplyScalar(thrust);
    v.addForce(_f);
  }

  /* ---- 6. control and stability moments ------------------------------ */
  // W/S elevator, A/D ailerons. `control` is filled by `fixedStep` for flight
  // kinds; `steer` already carries the auto-reverse sign a player driver is
  // given (D -> control.steer < 0), so reading it — and negating once here —
  // makes `ail > 0` mean "roll right" in both the game and the gate.
  const elev = clamp((v.control.throttle ?? 0) - (v.control.brake ?? 0), -1, 1);
  const ail = -clamp(v.control.steer ?? 0, -1, 1);

  const wPitch = v.angularVelocity.dot(_right);
  const wRoll = v.angularVelocity.dot(_fwd);
  const wYaw = v.angularVelocity.dot(_up);
  const bank = Math.atan2(_right.y, _up.y);

  // PITCH. Positive torque about +X pitches the nose DOWN (see heli.js's sign
  // note). Elevator W (elev > 0) commands nose-down; the wing's static
  // stability restores toward the trim AoA; a rate term damps it.
  const noseDown =
    (F.pitchElev * elev + F.pitchStab * (aoa - F.aoaTrim)) * dyn - F.pitchDamp * wPitch;
  v.addTorque(_t.copy(_right).multiplyScalar(spec.inertia.x * noseDown));

  // ROLL about +Z. A positive torque about +Z rolls the aircraft LEFT (raises
  // right.y), so a roll-RIGHT command (`ail > 0`) is a NEGATIVE torque. A
  // dihedral term levels the wings toward zero bank; a rate term damps it. The
  // turn itself needs no rudder: banked over, the lift vector tilts and its
  // horizontal component curves the flight path.
  const rollAcc = -F.rollAuth * ail * dyn - F.rollStab * bank * dyn - F.rollDamp * wRoll;
  v.addTorque(_t.copy(_fwd).multiplyScalar(spec.inertia.z * rollAcc));

  // YAW about +Y. The tail weathercocks the nose onto the airflow (drives the
  // sideslip toward zero, which keeps the banked turn coordinated), a little
  // rudder rides on the aileron, and on the ground the same input steers the
  // nosewheel.
  const grounded = v.grounded > 0;
  const groundYaw = grounded ? F.groundSteer * ail * clamp(along / 12, -1, 1) : 0;
  const yawAcc =
    F.yawStab * beta * dyn + F.rudder * ail * dyn + groundYaw - F.yawDamp * wYaw;
  v.addTorque(_t.copy(_up).multiplyScalar(spec.inertia.y * yawAcc));

  /* ---- 7. gear -------------------------------------------------------- */
  // Same shape as the helicopter's skids: short rays, a capped spring, a damped
  // positional correction against burial. Friction is ANISOTROPIC — near-free
  // fore/aft so thrust builds speed, firm sideways so it tracks the runway.
  let contacts = 0;
  let deepest = 0;
  const pts = v.gearPoints;
  const maxRay = 1.4;
  const MAX_SPRING = 0.35;
  // SPACE brakes the wheels — the difference between a taxi roll and a stop on
  // landing. (The gear spring is vertical, so a parked plane does not creep on
  // a slope regardless; there is no separate park brake to model.)
  const braking = dnT > 0;
  for (let i = 0; i < pts.length; i++) {
    _p.copy(pts[i]).applyQuaternion(q).add(v.position);
    const hit = phys.raycast(_p, _dir, maxRay, phys.MASK?.WORLD ?? 0);
    const hitY = hit?.hit ? hit.point.y : (_p.y - ground < maxRay ? ground : null);
    if (hitY === null) continue;
    const pen = hitY - _p.y;
    if (pen < -0.02) continue;
    contacts++;
    if (pen > MAX_SPRING) deepest = Math.max(deepest, pen - MAX_SPRING);
    _r.copy(pts[i]).applyQuaternion(q);
    _vel.copy(v.angularVelocity).cross(_r).add(v.velocity);
    let fy = F.gearK * Math.min(Math.max(0, pen), MAX_SPRING) - F.gearC * _vel.y;
    fy = clamp(fy, 0, weight * 2.2);
    _f.set(0, fy, 0);
    v.addForceAtLocal(_f, _r);

    // Split the contact-point ground velocity into the aircraft's fore/aft and
    // lateral axes and apply a different friction coefficient to each.
    const vAlong = _vel.x * _fwd.x + _vel.y * _fwd.y + _vel.z * _fwd.z;
    const vLatX = _vel.x - _fwd.x * vAlong;
    const vLatY = _vel.y - _fwd.y * vAlong;
    const vLatZ = _vel.z - _fwd.z * vAlong;
    const latL = Math.hypot(vLatX, vLatY, vLatZ);
    const muRoll = braking ? F.muBrake : F.muRoll;
    // Longitudinal: rolling resistance (or the brakes), opposing motion.
    if (Math.abs(vAlong) > 1e-3) {
      const fMax = muRoll * fy;
      const need = Math.abs(vAlong) * v.mass * 1.2 / pts.length;
      const fA = -Math.sign(vAlong) * Math.min(fMax, need);
      _f.set(_fwd.x * fA, _fwd.y * fA, _fwd.z * fA);
      v.addForceAtLocal(_f, _r);
    }
    // Lateral: firm grip so it does not slide sideways off the runway.
    if (latL > 1e-3) {
      const fMax = F.muLat * fy;
      const need = latL * v.mass * 1.2 / pts.length;
      const scale = Math.min(fMax, need) / latL;
      _f.set(-vLatX * scale, -vLatY * scale, -vLatZ * scale);
      v.addForceAtLocal(_f, _r);
    }
  }
  if (deepest > 0) {
    v.position.y += Math.min(deepest, 0.25) * 0.5;
    if (v.velocity.y < 0) v.velocity.y *= 0.4;
  }
  v.grounded = contacts;
  v.airborne = contacts === 0 ? v.airborne + dt : 0;
  v.inWater = false;

  return contacts;
}
