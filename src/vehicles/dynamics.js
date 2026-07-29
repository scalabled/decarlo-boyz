/**
 * Vehicle dynamics — a raycast-vehicle rigid body.
 *
 * The chassis is a full 6-DoF rigid body integrated here rather than handed to
 * `physics.addRigidBody`, because a car is not a box that bounces: every force
 * that acts on it acts at a wheel's contact patch, tens of centimetres below
 * and outboard of the centre of mass. Applying them there is what produces
 * squat, dive and roll for free — no animation, no fudge factors. The body
 * visibly sits down on its outside rear tyre under power out of a corner
 * because that is where the force is being applied.
 *
 * Per fixed step, per wheel:
 *   1. cast a ray down the strut axis, find the ground and its surface
 *   2. spring + damper (asymmetric bump/rebound) -> vertical load
 *   3. anti-roll bar couples the two wheels on an axle
 *   4. combined-slip tyre force from that load and the contact-patch velocity
 *   5. wheel spin integrated from drive torque, brake torque and tyre reaction
 *
 * Then aero, then integrate, then resolve the chassis against the world.
 */

import * as THREE from 'three';
import { Drivetrain } from './drivetrain.js';
import { tyreForces, rollingResistance, surfaceGrip, peakSlipRatio } from './tyre.js';
import { stepBoat, makeHullSamples } from './boat.js';
import { stepHeli, makeSkidPoints } from './heli.js';
import { WATER, HERO } from './specs.js';

const GRAVITY = -9.81;

/**
 * Traction control. The target is a multiple of the tyre's OWN peak slip ratio
 * (`peakSlipRatio`), and the loop is an INTEGRATOR, not a proportional cut.
 *
 * That distinction is the whole thing, and it cost two tuning rounds to see.
 * At steady state a spinning wheel transmits exactly `driveTorque / radius`, so
 * a proportional cut settles wherever its own band happens to balance the tyre
 * — measured at a slip of 0.91 with a (0.45, 1.05) band, which is seven times
 * the peak and still a burnout. Narrowing the band did not fix it either: it
 * just moved the settling point and traded slip for torque, and the sedan still
 * would not climb the bank. An integrator has zero steady-state error, so it
 * parks the slip AT the target whatever the surface, the gradient or the gear,
 * which is the only setting that actually maximises thrust.
 */
const TC_TARGET = 1.35;
const TC_GAIN = 7.0;
/** Most of the drive torque it is allowed to take away. */
const TC_CUT = 0.92;

/**
 * ────────────────────────────────────────────────────────────────────────────
 * KERB RIDE-OVER AND STUCK RECOVERY
 * ────────────────────────────────────────────────────────────────────────────
 * Without this, a car backing over a kerb catches on it, and if it does get
 * over, ends up floating high-centred on top of it. Both halves are one
 * geometry problem with two faces:
 *
 *   CATCHING   the wheel is modelled as a single downward ray, so the tyre has
 *              no leading edge and cannot begin to climb anything. The tyre
 *              passes through the kerb FACE until the ray crosses its edge,
 *              while the chassis probes in `_collide` are already inside that
 *              face and are pushed straight back out along its horizontal
 *              normal. Drive in, push back out, every step: a snag.
 *   FLOATING   if it does get up, the underbody lands on the kerb top and the
 *              wheels dangle. `grounded === 0`, so there is no tyre force at
 *              all and neither pedal does anything. High-centred, forever.
 *
 * The dynamics are NOT simplified to avoid this — they are gated at 208 signed
 * assertions and the handling is the point. They are made FORGIVING instead,
 * the way every shipped open-world game does it:
 *
 *   `_feelKerb`  gives each wheel the leading edge a ray does not have. A short
 *                probe along the rolling direction finds a near-vertical face
 *                within reach; if the surface on top of it is no more than
 *                `KERB_MAX` up, the corner gets a lift proportional to the step.
 *                A real tyre rides a 15 cm kerb because its contact force
 *                rotates up the face; this is that, and nothing else.
 *   `_unstick`   the safety net for everything the feeler cannot see, including
 *                high-centring. Under power, supported by SOMETHING, and no
 *                real progress for `STUCK_TIME` -> a bounded shove in the
 *                direction the driver is already asking for.
 *
 * Both are forces, never a teleport, both ramp rather than pop, and both are
 * armed only at a walking pace against an obstruction — so nothing a player
 * does at speed can feel them.
 */
/**
 * HOW FAR PAST FULL DROOP A WHEEL STILL COUNTS AS TOUCHING THE ROAD, metres.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE BUG THIS FIXES — the car that revs to the limiter and will not move.
 * ────────────────────────────────────────────────────────────────────────────
 * The ground search used to be `hp.max + hp.radius + 0.02` with an acceptance
 * of `distance - radius <= hp.max`: a cliff edge exactly at the end of the
 * suspension's droop, with 2 cm of ray beyond it that could never be accepted.
 * One millimetre inside it, the wheel is grounded and carries its share of the
 * car; one millimetre outside, it is declared AIRBORNE and contributes nothing
 * at all — no spring, no load, and therefore no tyre force in either direction.
 *
 * Droop is not generous. `specs.js` builds `staticLen = travel/2 + 0.06` and
 * `max = staticLen + travel/2`, so the sedan's wheel can follow the ground just
 * **9.5 cm** below ride height before it falls off that cliff. Ordinary city
 * driving clears that constantly: cresting a kerb, a camber break at a junction
 * pad, the lip where a carriageway meets a verge, backing over a kerb.
 *
 * MEASURED, on 60 lane sites across the real city, before this existed: 9 of 60
 * ended with wheels reading `len === max` exactly and an independently-cast
 * vertical ray finding the road 1-6 cm further down. The sedan is FRONT-wheel
 * drive, so the two front wheels going 2 cm light is 100% of the drive gone:
 * `throttle 1, clutch 1, gear 1, rpm at the limiter, forwardSpeed 0.3 m/s`,
 * which is exactly the telemetry the stuck-car reports carry. Worse, it
 * FLICKERS — the same wheel reads grounded and airborne on alternate steps as
 * the body breathes over the boundary — so the car neither drives nor settles.
 *
 * So the contact test gets a bounded forgiveness band. A wheel whose ground is
 * within `GROUND_REACH` past full droop is GROUNDED: it keeps its contact
 * point, its surface and its grip, and its corner force is tapered linearly to
 * zero across the band. At `reach === 0` nothing changes by a single bit; at
 * the far edge the corner carries nothing, which is what stops this from
 * levitating anything. The band is smaller than a kerb (`KERB_MAX`) and smaller
 * than every wheel radius in the fleet, so a car that has genuinely left the
 * ground — a jump, a bridge, a ledge — is airborne on the very next step, and
 * `_stepWheels` still reports `grounded === 0` for it.
 *
 * The principle, and it is the general one for character-and-vehicle-vs-world
 * contact: a car 4 cm too high that DRIVES beats a geometrically perfect car
 * that cannot.
 */
const GROUND_REACH = 0.15;
/** The tallest lip a wheel will ride over unaided. A kerb is 0.15 m. */
const KERB_MAX = 0.22;
/** How far ahead of the contact patch the feeler looks, as a fraction of radius. */
const KERB_REACH = 0.8;
/** Peak lift at a wheel against a full-height step, as a fraction of its own weight. */
const KERB_LIFT = 1.25;
/** Above this road speed the suspension deals with kerbs on its own. */
const KERB_MAX_SPEED = 9;
/** Seconds of no progress under power before the recovery arms. */
const STUCK_TIME = 1.0;
/** Progress that counts as "moving", metres, and the speed that cancels it. */
const STUCK_TRAVEL = 0.30;
const STUCK_SPEED = 0.55;
/** Seconds for the recovery to fade fully in / out. */
const ASSIST_IN = 0.35;
const ASSIST_OUT = 0.22;
/**
 * Recovery shove along the driver's requested direction, m/s^2, and the lift
 * that goes with it as a fraction of the car's own weight.
 *
 * Sized against the thing that actually holds a beached car: `_collide` caps
 * its Coulomb friction at 0.55 of the normal impulse, so a belly resting on a
 * kerb resists up to 0.55 g. Lifting 0.55 g leaves 0.45 g of normal force and
 * therefore about 0.25 g of friction, which a 0.33 g shove clears with margin —
 * the car slides off at walking pace instead of sitting there.
 *
 * The lift can never exceed gravity, so this cannot pick a car up; it only
 * takes weight off the belly. And the whole thing is gone the moment the car
 * has moved 30 cm, so what the player sees is a car that finally bites.
 */
const ASSIST_PUSH = 3.2;
const ASSIST_LIFT = 0.55;
/** The recovery never adds climb rate past this, m/s. It must not launch a car. */
const ASSIST_MAX_CLIMB = 1.15;

/**
 * ────────────────────────────────────────────────────────────────────────────
 * HOW FAR PAST THE GRIP LIMIT THE STEERING IS ALLOWED TO ASK. See
 * `_updateSteering`.
 * ────────────────────────────────────────────────────────────────────────────
 * `_stepWheels`'s yaw limiter already clamps the achievable yaw rate to
 * `mu*g / v`. The Ackermann steer angle that ASKS for exactly that rate is
 *
 *     delta_neutral = atan( mu*g * wheelbase / v^2 )
 *
 * so every degree of lock past `delta_neutral` is dead travel: it cannot buy
 * yaw, it only buys front slip angle — plough, heat, fade, and a violent
 * transient. 1.0 would make the car physically unable to be provoked into a
 * slide by the wheel alone, which is not the intent here, so a quarter
 * over is left in. Beyond that the handbrake and the throttle are the tools.
 */
const STEER_OVERDRIVE = 1.25;
/**
 * The lock never falls below this, radians, however fast the car is going —
 * about 2.9 degrees. At 200 km/h `delta_neutral` is under a degree, and a car
 * you cannot aim at all is its own kind of undriveable.
 */
const STEER_FLOOR = 0.05;
/**
 * Body slip past which the grip cap fades out and the full mechanical lock
 * comes back, radians (20 degrees). See `_updateSteering` — it is set above
 * what ordinary cornering can reach WITH the cap in place (measured 3-5
 * degrees), so nothing the steering itself does can open it.
 */
const SLIDE_ONSET = 0.35;

/* Scratch — allocated once, reused for every vehicle, every step. */
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _n = new THREE.Vector3();
const _r = new THREE.Vector3();
const _k0 = new THREE.Vector3();
const _k1 = new THREE.Vector3();
const _k2 = new THREE.Vector3();
const _k3 = new THREE.Vector3(0, -1, 0);
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m3 = new THREE.Matrix3();

let _nextId = 1;

export class Vehicle {
  constructor(sys, spec, model, opts = {}) {
    this.id = _nextId++;
    this.sys = sys;
    this.spec = spec;
    this.model = model;
    this.type = spec.id;
    this.name = spec.name;
    this.isVehicle = true;

    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();
    this.prevPosition = new THREE.Vector3();
    this.prevQuaternion = new THREE.Quaternion();

    this._force = new THREE.Vector3();
    this._torque = new THREE.Vector3();

    this.mass = spec.mass;
    this.invMass = 1 / spec.mass;
    this.invI = new THREE.Vector3(1 / spec.inertia.x, 1 / spec.inertia.y, 1 / spec.inertia.z);

    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: 0, reverse: 0, horn: false };

    /**
     * The controls AFTER the mapping in `Drivetrain.mapControls`.
     * `input` is what the controller pressed; `control` is what the car does
     * with it, and it is the set every consumer below wants: in reverse the
     * pedals are swapped, so reading `input.brake` for brake torque is what
     * made backing up impossible. Brake lamps and the reverse lamp read it too.
     *
     * `steer` is here for the same reason: `input.steer` is a control AXIS when
     * a person is driving (+1 = D = right) and a body-frame steer ANGLE when an
     * AI is (+1 = left). `control.steer` is always the body-frame command, so
     * `_updateSteering` has exactly one thing to read. That mismatch is what
     * made the a/d keys steer the wrong way — see `drivetrain.js`.
     */
    this.control = { throttle: 0, brake: 0, steer: 0 };
    /**
     * Arm "hold the brake at a standstill to select reverse". Only ever true
     * for a vehicle a PLAYER is driving — see the header of `drivetrain.js`.
     */
    this.autoReverse = false;
    /** Low-speed traction-control cut, 0 (off) to 1 (full). See `_hookUp`. */
    this.traction = 0;
    /** Slip ratio the controller holds the driven wheels at. */
    this._tcTarget = peakSlipRatio(spec.tyre) * TC_TARGET;

    /**
     * FUEL, 0-100. Only the vehicle the PLAYER is driving actually burns any:
     * `traffic` and `police` cars stranding themselves mid-junction is not a
     * mechanic, it is a bug.
     *
     * `burnsFuel` is set by `VehicleSystem.setDriver` when a player-ish actor
     * takes the wheel, and cleared on exit. `game` refuels through
     * `vehicles.refuel()`; the tank is the reason the six gas stations and the
     * scale of the map matter.
     */
    this.fuel = opts.fuel ?? 100;
    this.maxFuel = 100;
    this.burnsFuel = false;
    this.fuelDry = false;
    this._fuelWarnAt = -1e9;
    this.horn = false;
    this.steerAngle = 0;
    this.leanAngle = 0;
    this.drivetrain = new Drivetrain(spec);

    this.wheels = spec.wheels.map((hp) => ({
      hp,
      len: hp.staticLen,
      prevLen: hp.staticLen,
      vel: 0,
      omega: 0,
      load: 0,
      grounded: false,
      surface: 'asphalt',
      grip: surfaceGrip('asphalt'),
      contact: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      forward: new THREE.Vector3(0, 0, 1),
      right: new THREE.Vector3(1, 0, 0),
      fx: 0, fy: 0,
      slipRatio: 0, slipAngle: 0, combined: 0, mu: 1,
      latLag: 0, heat: 0, vLong: 0, kFx: 0,
      spin: 0,
      steer: 0,
      skidding: false,
      skidTime: 0,
      lastEmit: 0,
      broken: false,
      camber: hp.camber,
      /** Height of the step this wheel is up against, metres. See `_feelKerb`. */
      kerbStep: 0,
      /**
       * How far BEYOND full droop the ground is, metres. 0 for a wheel the
       * suspension can actually reach; up to `GROUND_REACH` for one that is
       * hovering just off the surface. See `GROUND_REACH`.
       */
      reach: 0,
      /**
       * Per-wheel scratch for the hero grip multiplier. ONE PER WHEEL, not one
       * per vehicle: `w.grip` is written in the suspension loop and read in the
       * tyre loop, so four wheels sharing a scratch would all end up with the
       * last wheel's surface. Preallocated — hard rule 5.
       */
      gripMod: { mu: 1, roll: 1, drag: 0, noise: 0, skid: 1, dust: 0 },
    }));

    this._driven = [];
    this._drivenOmega = [];
    this._drivenTorque = [];
    for (let i = 0; i < this.wheels.length; i++) {
      if (spec.driven[i]) this._driven.push(i);
    }
    for (let i = 0; i < this._driven.length; i++) {
      this._drivenOmega.push(0);
      this._drivenTorque.push(0);
    }

    this.speed = 0;
    this.forwardSpeed = 0;
    this.lateralSpeed = 0;
    this.slipAngle = 0;
    this.grounded = 0;
    this.airborne = 0;
    this.health = spec.body.hp;
    this.maxHealth = spec.body.hp;
    this.destroyed = false;
    this.burning = 0;
    this.smoke = 0;
    this.engineOn = true;
    this.occupants = [];
    this.driver = null;
    this.parked = !!opts.parked;
    this.sleeping = false;
    this._sleepTimer = 0;
    /**
     * Steps of grace left in which another vehicle is pressing on this one, set
     * by `VehicleSystem._pairResolve`. Suspends the creep damper — see the note
     * in `_stepWheels`.
     */
    this._pressed = 0;
    this._impactCool = 0;
    this._lastImpulse = 0;

    /**
     * Kerb ride-over / stuck recovery state. See the constants at the top.
     * `kerbAssist` and `stuckFor` are published for `stuckdiag.mjs` and the
     * drive gate; nothing in gameplay reads them.
     */
    this._stuckFrom = new THREE.Vector3();
    this.stuckFor = 0;
    this.kerbAssist = 0;
    this._feelPhase = 0;

    // Boat
    this.inWater = false;
    this.waterY = -Infinity;
    this.wetted = 0;
    this.planing = 0;
    this.propThrust = 0;
    this.submerged = 0;
    if (spec.kind === 'boat') this.hullSamples = makeHullSamples(spec);

    /**
     * WATER, for everything that is NOT a boat. `submerged` is the fraction of
     * the body below the waterline; `drowning` counts the seconds the air
     * intake has been under. See `_stepWater` and the WATER block in specs.js.
     */
    this.drowned = false;
    this.drowning = 0;
    this.flooded = 0;
    this.waterDamage = 0;

    /**
     * FLIGHT. Every vehicle carries `altitude` (metres above the ground under
     * it) so a consumer never has to ask what kind it is; for anything on
     * wheels it is zero and stays zero. `blocksPeds` is the predicate
     * `physics` should consume in `_refreshBlockers` — see `heli.js`.
     */
    this.altitude = 0;
    this.groundY = 0;
    this.blocksPeds = true;
    this.rotorSpin = 0;
    this.rotorPhase = 0;
    this.tailPhase = 0;
    this.rotorThrust = 0;
    this.collective = 0;
    this.holdAlt = 0;
    if (spec.kind === 'heli') this.skidPoints = makeSkidPoints(spec);

    /**
     * PER-HERO MODIFIERS, set by `VehicleSystem` when a player takes the wheel
     * and cleared on exit. `HERO.none` is the identity, so every AI car, every
     * parked car and every headless bench vehicle behaves exactly as it did
     * before this existed. See the HERO block in `specs.js`.
     */
    this.hero = HERO.none;

    /**
     * Chassis collision probes.
     *
     * These MUST be sized off the real body, not off the bounding box. Sized
     * off half-extents they hung 5 cm below the car's own floor, so a parked
     * car had all ten probes in permanent contact with the road, the solver
     * pushed it DOWN as often as up, and it sat on its bump stops and would not
     * move. The lower ring's spheres now exactly touch the underbody, so at
     * rest there are zero contacts and the suspension alone holds the car up.
     */
    const floorLocal = (spec.style?.groundY ?? 0.14) - spec.comY;
    const roofLocal = (spec.style?.roofY ?? spec.dims.H) - spec.comY;
    this.probeR = Math.max(
      0.12,
      Math.min(0.32, (roofLocal - floorLocal) * 0.3, spec.half.x * 0.5, spec.half.z * 0.3)
    );
    this.probes = [];
    const px = Math.max(0.02, spec.half.x - this.probeR);
    const pz = Math.max(0.02, spec.half.z - this.probeR);
    const yLo = floorLocal + this.probeR;
    const yHi = Math.max(yLo + 0.02, roofLocal - this.probeR);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 0, 1]) {
        this.probes.push(new THREE.Vector3(sx * px, yLo, sz * pz));
        if (sz !== 0) this.probes.push(new THREE.Vector3(sx * px * 0.8, yHi, sz * pz));
      }
    }

    this.boundingRadius = Math.hypot(spec.half.x, spec.half.y, spec.half.z);

    /** Diagnostics for tools/drive.mjs. Written, never read by gameplay. */
    this.diag = { contacts: 0, pushY: 0, rayLen: 0, groundY: 0, suspF: 0 };
  }

  /* ---------------------------------------------------------- helpers -- */

  addForce(f) {
    this._force.add(f);
  }

  /** Force `f` (world) applied at world-space offset `r` from the CoM. */
  addForceAtLocal(f, r) {
    this._force.add(f);
    this._torque.x += r.y * f.z - r.z * f.y;
    this._torque.y += r.z * f.x - r.x * f.z;
    this._torque.z += r.x * f.y - r.y * f.x;
  }

  addTorque(t) {
    this._torque.add(t);
  }

  localToWorld(v, out) {
    return out.copy(v).applyQuaternion(this.quaternion).add(this.position);
  }

  pointVelocity(rWorld, out) {
    return out.copy(this.angularVelocity).cross(rWorld).add(this.velocity);
  }

  setPose(pos, yaw) {
    this.position.copy(pos);
    this.quaternion.setFromEuler(_e.set(0, yaw, 0, 'YXZ'));
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    for (const w of this.wheels) {
      w.len = w.hp.staticLen;
      w.prevLen = w.len;
      w.omega = 0;
      w.heat = 0;
      w.latLag = 0;
      w.kerbStep = 0;
      w.reach = 0;
    }
    this._stuckFrom.copy(this.position);
    this.stuckFor = 0;
    this.kerbAssist = 0;
    this.drivetrain.reset();
  }

  /**
   * ──────────────────────────────────────────────────────────────────────────
   * COME OUT OF SLEEP. The ONE place the transition is written.
   * ──────────────────────────────────────────────────────────────────────────
   * `VehicleSystem.fixedUpdate` skips `fixedStep` entirely for a sleeping
   * vehicle, and `_sleepTimer` is only ever written inside `_postStep` — which
   * is inside the step it skips. So the flag is a LATCH: once a parked car is
   * asleep, nothing that does not explicitly clear it can ever get it stepped
   * again, and every consequence of the step silently stops.
   *
   * Three call sites had spotted that and each cleared the two fields by hand
   * (`setDriver`, the throttle poll, `_pairResolve`, `_explosionDamage`). The
   * one that had NOT was damage — so shooting, ramming, spiking or drowning a
   * parked car changed a number and nothing else, and a wrecked one never even
   * settled onto the wheels `DamageModel.destroy` had just broken.
   *
   * Waking is cheap: the worst case is 1.2 s of stepping a stationary car
   * before it puts itself back to sleep.
   */
  wake() {
    this.sleeping = false;
    this._sleepTimer = 0;
  }

  /* ------------------------------------------------------------ step -- */

  fixedStep(dt, ctx) {
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);

    this._force.set(0, 0, 0);
    this._torque.set(0, 0, 0);

    this._burnFuel(dt);

    _fwd.set(0, 0, 1).applyQuaternion(this.quaternion);
    _right.set(1, 0, 0).applyQuaternion(this.quaternion);
    _up.set(0, 1, 0).applyQuaternion(this.quaternion);

    this.forwardSpeed = this.velocity.dot(_fwd);
    this.lateralSpeed = this.velocity.dot(_right);
    this.speed = this.velocity.length();
    this.slipAngle =
      this.speed > 1.2 ? Math.atan2(-this.lateralSpeed, Math.abs(this.forwardSpeed) + 0.4) : 0;

    // Pedals -> gear-aware throttle/brake. Must run BEFORE anything reads a
    // pedal: the tyres, the drivetrain and the lamps all consume `control`.
    const kind = this.spec.kind;
    if (kind === 'boat' || kind === 'heli') {
      this.control.throttle = this.input.throttle;
      this.control.brake = this.input.brake;
      // A helm is a wheel too, and so is a pair of pedals: the same axis
      // convention applies to the rudder and to the tail rotor.
      this.control.steer = this.autoReverse ? -this.input.steer : this.input.steer;
    } else {
      this.drivetrain.mapControls(this.input, this.forwardSpeed, dt, this.control, this.autoReverse);
      if (this.fuelDry || !this.engineOn) this.control.throttle = 0;
      this._hookUp(dt);
    }
    /**
     * The SPRINT channel, carried through to `control` with the pedals so the
     * drivetrain has exactly one object to read. It was accepted by `setInput`
     * and consumed by nothing at all until this pass — see the BOOST block in
     * `specs.js`. Gated on the throttle here so a boost held off the pedal is
     * simply not a boost.
     */
    this.control.boost = this.spec.boost && this.control.throttle > 0.02
      ? Math.min(1, Math.max(0, this.input.boost ?? 0))
      : 0;
    // The top-gear trim is the driver's, and it is re-read every step so a
    // brother switch while rolling takes effect without a re-entry.
    this.drivetrain.heroTop = this.hero.top;

    // Gravity always.
    this._force.y += GRAVITY * this.mass;

    this._updateSteering(dt);

    if (kind === 'boat') {
      this._stepBoat(dt, ctx);
    } else if (kind === 'heli') {
      // Its own controller, and it never touches the wheel path. See `heli.js`.
      stepHeli(this, dt, ctx);
    } else {
      this._stepWheels(dt, ctx);
      // After the tyres, before the integrator: the ride-over and the recovery
      // are ordinary forces on the same step, which is what keeps them from
      // reading as a teleport.
      this._rideKerbs(dt);
      this._unstick(dt);
      // A car in a river. Buoyancy, drag, damage and a drowned engine — the
      // three water rules, in this model's units.
      this._stepWater(dt, ctx);
    }

    this._aero(dt);
    this._integrate(dt);
    this._collide(dt, ctx);
    this._postStep(dt, ctx);
  }

  /**
   * Burn fuel against engine load, and cut the engine when the tank is dry.
   *
   * Consumption is `idle + rate * rpmFraction * (0.18 + 0.82 * load)`, so
   * sitting at the lights costs almost nothing, cruising costs about a quarter
   * of the full-throttle rate, and holding it flat empties the tank in a few
   * minutes. The idle floor exists so that leaving the engine running while you
   * do something else is not free — the tank is the reason the gas stations are
   * on the map. `spec.fuelBurn` is derived per class in `finalizeSpec`, so the
   * truck is thirsty and the bike is not.
   */
  _burnFuel(dt) {
    // `nogas`: the bicycle. No tank, so no burn, no dry-tank cut and no gauge.
    // Returning here rather than burning zero also keeps `fuelDry` permanently
    // false, which is what stops the throttle being cut on a vehicle whose
    // engine is a pair of legs.
    if (this.spec.nogas) return;
    if (!this.burnsFuel || this.destroyed) return;
    if (this.fuel > 0) {
      const fb = this.spec.fuelBurn;
      const dr = this.drivetrain;
      const rpmFrac = Math.min(1, Math.max(0, dr.rpm / (this.spec.engine.redline || 6000)));
      const load = Math.min(1, Math.max(0, dr.load ?? this.input.throttle));
      this.fuel = Math.max(0, this.fuel - dt * (fb.idle + fb.rate * rpmFrac * (0.18 + 0.82 * load)));
    }
    const dry = this.fuel <= 0;
    if (dry !== this.fuelDry) {
      this.fuelDry = dry;
      this.sys?.onFuelState?.(this, dry);
    }
    // A dry tank is a dead engine: no drive torque, but the car still rolls,
    // still steers and still brakes, so you coast to a halt rather than stop
    // dead in the road.
    if (dry) this.input.throttle = 0;
  }

  /**
   * LOW-SPEED TRACTION CONTROL — what stops a stationary car sitting in a
   * useless burnout for the rest of the session.
   *
   * The launch is BISTABLE, and that is the defect. Measured on a sedan trying
   * to back out of a river bank (a 14.5 deg dirt slope, the site
   * `tools/playprobe.mjs` finds when the drive test runs long enough to leave
   * the road):
   *
   *   hooked up  the front axle can pull 2 x 3180 N, gravity down the slope
   *              needs 3733 N -> it climbs out at 1.7 m/s^2
   *   spinning   the magic formula past its peak gives sin(C*pi/2) = 0.707 of
   *              that, and the abuse-fade term takes another 16% -> 2 x 1988 N,
   *              which does not even hold the car still
   *
   * Spinning up costs more torque than holding, so the transient throws it into
   * the second state and a pinned digital throttle can never get it out. That
   * is exactly the observed symptom, both directions: `throttle 1.00, rpm 6272
   * (the limiter), gear first, four wheels down, forwardSpeed 0.89`.
   *
   * A human answers this by feathering the pedal. A keyboard cannot, so the car
   * does it — which is what every road car built this century does, and what
   * the quality bar does: you cannot make a stock GTA car sit and spin on a
   * verge, it digs in and goes.
   *
   * Deliberately NOT a global traction limiter:
   *   - authority fades out by 14 m/s, so power oversteer, drifts and burnouts
   *     at speed are untouched;
   *   - the handbrake disarms it completely, because a handbrake slide is the
   *     player asking for exactly this;
   *   - it takes about a third of a second to wind on, so a hard launch still
   *     lights them up and squeals before it hooks.
   *
   * It trims the DRIVE TORQUE AT THE WHEELS, not the throttle pedal. Trimming
   * the pedal was tried first and it bricked every powerful car in the fleet:
   * `bench.mjs` measured the sports car, the muscle car, the cruiser and the
   * bike all unable to pull away at all (`forwardBefore_ms 9.24 -> -0.07`).
   * Below about 12% throttle this engine model makes NET NEGATIVE torque —
   * `eng.brakeTorque` is 44 N.m and barely tapers — so a deep pedal cut does not
   * reduce drive, it applies the brakes. Real traction control cuts spark and
   * fuel to individual cylinders; taking it off the wheels is both closer to
   * that and unable to invert the sign of anything.
   */
  _hookUp(dt) {
    const v = Math.abs(this.forwardSpeed);
    // Full authority below 6 m/s, none above 14.
    const auth = v >= 14 ? 0 : v <= 6 ? 1 : (14 - v) / 8;
    /**
     * Sideways is the player's business, not the controller's: past ~26 degrees
     * of body slip the car is in a slide and the throttle is how you steer out
     * of one. Without this the bike never recovered from a handbrake slide.
     *
     * NOTE there is deliberately no "only when the throttle is open" test. An
     * automatic sat in first at IDLE still pushes torque at the wheels, and with
     * the body pinned by the low-speed creep damper below there is nothing to
     * stop it winding them up: measured at a slip ratio of 1.6 and 42 kN of
     * peak-to-peak chassis force on a stationary cruiser with no key pressed.
     */
    if (auth <= 0 || this.input.handbrake || Math.abs(this.slipAngle) > 0.45) {
      this.traction = Math.max(0, this.traction - dt * 4);
      return;
    }
    /**
     * Slip of the worst driven wheel, against THAT WHEEL's contact-patch speed
     * (`w.vLong`, cached in the tyre loop) and normalised exactly the way the
     * tyre model normalises it, so the two numbers mean the same thing.
     *
     * The chassis' `forwardSpeed` is the same number in a straight line and a
     * very different one sideways: it reads a car at 80 degrees of body slip as
     * a car with its wheels spinning, and cuts all the drive exactly when the
     * player is trying to power out of a slide. `bench.mjs` measured the bike
     * still 68 degrees sideways 2.5 s into the handbrake recovery.
     *
     * ────────────────────────────────────────────────────────────────────────
     * SIGNED, and floored at zero. A wheel turning SLOWER than the road it is
     * on is not spinning, it is being dragged — and the only thing dragging it
     * is a bogged engine. Taking the magnitude instead read that as wheelspin,
     * cut the drive, bogged the engine further, and latched: measured live on a
     * lane-centre launch as `throttle 1.00, gear first, rpm 360, 1.07 m/s` —
     * a whole driveline sitting at a third of idle at full throttle. Traction
     * control fights wheelspin. Wheel DRAG is the gearbox's problem, and cutting
     * torque is the exact opposite of what it needs.
     *
     * `dir` is the direction the drive is pushing, so backing out of a ditch
     * (where a spinning wheel turns the other way) is covered by the same test.
     */
    const dir = this.drivetrain.gear === 0 ? -1 : 1;
    let slip = 0;
    for (let k = 0; k < this._driven.length; k++) {
      const w = this.wheels[this._driven[k]];
      if (!w.grounded) continue;
      const s = ((w.omega * w.hp.radius - w.vLong) * dir) / Math.max(2.2, Math.abs(w.vLong));
      if (s > slip) slip = s;
    }
    // Winds on at `TC_GAIN`, lets go at twice that. Real traction control is
    // asymmetric for the same reason: being slow to intervene costs a chirp,
    // being slow to release costs the acceleration you intervened to protect.
    const err = slip - this._tcTarget;
    const t = this.traction + err * (err > 0 ? TC_GAIN : TC_GAIN * 2) * dt * auth;
    this.traction = t < 0 ? 0 : t > 1 ? 1 : t;
  }

  _updateSteering(dt) {
    const st = this.spec.steer;
    const v = Math.abs(this.forwardSpeed);
    /**
     * `falloffRef` / `minFrac` exist for the BIKE. A car's lock is allowed to
     * stay usable to 150 km/h; a motorcycle's is not — it turns by leaning, and
     * the bars barely move above walking pace. Feeding a bike 20 degrees of
     * steering at 80 km/h put a huge lateral force into a single front contact
     * patch above the centre of mass and simply threw it over: the bench
     * measured 75 degrees of roll and a nonsense 45 g in the steady-state
     * corner. Winding the lock out with speed is the fix, and it is also what
     * makes the bike feel like a bike rather than a narrow car.
     */
    const falloff = 1 - st.speedFalloff * Math.min(1, v / (st.falloffRef ?? 42));
    const lockEnv = st.max * Math.max(st.minFrac ?? 0.24, falloff);

    /**
     * ──────────────────────────────────────────────────────────────────────
     * THE LOCK IS CAPPED AT WHAT THE TYRES CAN CASH. THIS IS THE KEYBOARD FIX.
     * ──────────────────────────────────────────────────────────────────────
     * `st.speedFalloff` is a LINEAR ramp against a 42 m/s reference, and 42 m/s
     * is 151 km/h — so at a city 60 km/h a sedan still had 76% of full lock,
     * i.e. 22.3 degrees at the road wheel. A real driver uses three or four.
     *
     * That is not a cosmetic difference on a keyboard, because a key is a STEP:
     * `player/vehicle.js` ramps the axis with a 0.07 s time constant and
     * `st.rate` is 4-5 rad/s, so a 0.15 s tap of D arrives at the full 22
     * degrees before the player's finger is off the key. MEASURED on a sedan at
     * 60 km/h, one 0.15 s tap: peak yaw rate 41 deg/s — 1.2 g, the friction
     * limit — a 12.4 degree heading change, and **9.4 m of lateral offset in
     * three seconds**, which is nearly three lane widths. Every steering input
     * the player made was a swerve, so holding a lane needed constant opposite
     * correction, and the correction was the same size as the error. That is a
     * pilot-induced oscillation, and it is what "it drifts off the road / it is
     * hard to drive" is. `src/vehicles/laneprobe.mjs` drives a 355 m arterial
     * with a keyboard driver and measures the emitted deviation from the centre
     * line; a sedan's worst error went 6.05 m -> 0.83 m at 60 km/h and
     * 72.35 m -> 1.04 m at 80, and a Slagbolt's heading change from ONE tap of
     * the key went 174.3 degrees — a complete spin — to 26.2.
     *
     * The cap is not a feel constant, it is the geometry the car is already
     * subject to. `_stepWheels`'s yaw limiter clamps the yaw rate to `mu*g / v`;
     * the Ackermann angle that asks for exactly that is
     * `atan(mu*g*wheelbase / v^2)`, and nothing past it can produce yaw. So
     * capping there costs NO cornering ability. The proof is `bench.mjs`'s own
     * steady-state corner, which was not a corner at all before: every car in
     * the fleet reached 88-90 degrees of body slip — a SPIN — and reported a
     * roll angle of -27 to -41 degrees and a 0% or 100% outside/inside load
     * split, i.e. numbers taken while the car was sideways. With the cap a
     * sedan holds 3.2 degrees of slip, 10.0 degrees of roll and an 86% load
     * split at the same speed, and `cornerLat_g` moves 1.24 -> 1.08.
     *
     * It reads the LIVE surface mu off the wheels, so a wet road or gravel
     * winds the lock out on its own and the same keyboard tap does not spin you
     * on a surface that cannot take it. No per-class constant is involved:
     * `wheelbase` and the tyre's own `muLat` carry the whole spread, which is
     * why the truck, the bike and the sports car all come out sensible without
     * a table.
     *
     * NOT for a boat or a helicopter: a rudder and a tail rotor are not an
     * Ackermann steering rack and `wheelbase` means nothing to either.
     *
     * ──────────────────────────────────────────────────────────────────────
     * IT SCALES THE AXIS, IT DOES NOT CLIP THE ANGLE
     * ──────────────────────────────────────────────────────────────────────
     * `lock` is what a FULL axis deflection is worth, so shrinking it re-maps
     * the whole travel. Clipping the resulting angle instead — `target =
     * clamp(steer * lock, cap)` — looks equivalent and is much worse on a
     * keyboard: everything above 40% of the axis maps to the same angle, so the
     * steering STICKS at the cap through the whole release ramp instead of
     * coming off with the key. Measured on the same 0.15 s tap at 60 km/h,
     * clipping gave 9.3 m of lateral offset where scaling gives 5.6, i.e. it
     * threw away nearly the whole fix.
     *
     * ──────────────────────────────────────────────────────────────────────
     * ...AND IT LETS GO ONCE THE CAR IS ACTUALLY SIDEWAYS
     * ──────────────────────────────────────────────────────────────────────
     * `atan(mu*g*L / v^2)` is the neutral angle for a car whose body slip is
     * ZERO. Once the back has stepped out you need much more, because the front
     * tyres have to be pointed back where the car is really travelling before
     * they can do anything: with the cap held on regardless, the muscle car's
     * handbrake recovery went from 17.9 degrees of residual slip to 52.1 — it
     * was the opposite lock that got capped.
     *
     * So the cap fades out over `SLIDE_ONSET`. That threshold is set from the
     * measurement, not from taste: with the cap in place, ordinary cornering
     * peaks at 3-5 degrees of body slip (bench `cornerSlip_deg`), so 20 degrees
     * cannot be reached by steering input alone and the fade cannot become a
     * feedback loop with the player's own finger in it. A handbrake, a spin or
     * a shunt reaches it immediately, which is exactly when the lock is wanted.
     */
    const kind = this.spec.kind;
    let lock = lockEnv;
    if (kind !== 'boat' && kind !== 'heli' && v > 1) {
      let mu = 0;
      let n = 0;
      for (let i = 0; i < this.wheels.length; i++) {
        const g = this.wheels[i].grip;
        if (this.wheels[i].grounded && g) { mu += g.mu; n++; }
      }
      const surfaceMu = n > 0 ? mu / n : 1;
      const latCap = (this.spec.tyre?.muLat ?? 1.3) * surfaceMu * 9.81;
      const neutral = Math.atan((latCap * this.spec.wheelbase) / (v * v));
      const capped = Math.min(lockEnv, Math.max(STEER_FLOOR, neutral * STEER_OVERDRIVE));
      const slide = Math.min(1, Math.max(0, (Math.abs(this.slipAngle) - SLIDE_ONSET) / 0.2));
      lock = capped + (lockEnv - capped) * slide;
    }

    /**
     * `control.steer`, NOT `input.steer`. The raw field is a control axis for a
     * human (+1 = D = right) and a body-frame steer angle for an AI (+1 = left);
     * `mapControls` resolves the two into one convention and this is the only
     * place that consumes it. Reading `input` here is what swapped a and d.
     */
    let target = this.control.steer * lock;

    // Counter-steer assist. Every arcade-accessible driving game does this and
    // GTA V does it heavily: when the back steps out, quietly feed in some
    // opposite lock so the car is catchable on a keyboard. Scaled by how much
    // the player is already correcting, so a deliberate drift still works.
    //
    // NOT WHILE REVERSING. `slipAngle` is built on |forwardSpeed|, so backing
    // up on lock reads as a slide and the assist quietly unwinds the commanded
    // steering — which made reversing round a corner take twice the room.
    // The test is the GEAR, not the sign of the speed: a car sliding backwards
    // out of a spin is exactly when the assist is most wanted.
    if (this.spec.kind !== 'boat' && v > 6 && !this.drivetrain.reversing) {
      const beta = this.slipAngle;
      if (Math.abs(beta) > 0.06) {
        const assist = -beta * st.counterAssist;
        target += Math.max(-st.max * 0.55, Math.min(st.max * 0.55, assist));
      }
    }
    target = Math.max(-st.max, Math.min(st.max, target));

    const rate = (Math.abs(this.control.steer) > 0.02 ? st.rate : st.returnRate) * dt;
    const d = target - this.steerAngle;
    this.steerAngle += Math.max(-rate, Math.min(rate, d));
  }

  /* --------------------------------------------------------- wheels --- */

  _stepWheels(dt, ctx) {
    const spec = this.spec;
    const phys = this.sys.physics;
    const wheels = this.wheels;
    let grounded = 0;

    _up.set(0, 1, 0).applyQuaternion(this.quaternion);
    const rayDir = _v5.copy(_up).multiplyScalar(-1);

    // ---- suspension ------------------------------------------------------
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      const hp = w.hp;
      _v0.set(hp.x, hp.top, hp.z).applyQuaternion(this.quaternion).add(this.position);
      // The ray reaches `GROUND_REACH` past the end of the droop travel, and
      // the acceptance below matches it. Both numbers, or neither: a ray that
      // is longer than what the test will accept is dead length, which is what
      // the old `+ 0.02` was.
      const maxRay = hp.max + hp.radius + GROUND_REACH;
      const hit = phys.raycast(_v0, rayDir, maxRay, phys.MASK.WORLD);
      w.prevLen = w.len;
      if (i === 0) {
        this.diag.rayLen = hit.hit ? hit.distance : -1;
        this.diag.groundY = hit.hit ? hit.point.y : NaN;
        this.diag.raySurface = hit.surface;
        this.diag.rayObj = hit.object?.name ?? null;
      }
      const raw = hit.distance - hp.radius;
      if (hit.hit && raw <= hp.max + GROUND_REACH) {
        const len = Math.min(hp.max, Math.max(hp.min, raw));
        /**
         * How far the strut would have to stretch past its stop to reach. The
         * strut itself cannot, so `w.len` stops at `hp.max` — the wheel is drawn
         * at full droop and `w.vel` sees no step, which is what keeps the damper
         * out of the spike `maxDamp` exists for. Only the corner FORCE tapers.
         */
        w.reach = Math.max(0, raw - hp.max);
        w.len = len;
        w.grounded = true;
        w.contact.copy(hit.point);
        w.normal.copy(hit.normal);
        if (w.normal.dot(_up) < 0.05) w.normal.copy(_up);
        w.surface = hit.surface === 'concrete' ? this.sys.surfaceAt(hit.point.x, hit.point.z, hit.surface) : hit.surface;
        // The SYSTEM's table, not the static one: it carries the current
        // wetness, so rain reaches the contact patch. (Falls back to dry for
        // the headless bench, which has no VehicleSystem.)
        const base = this.sys.gripOf ? this.sys.gripOf(w.surface) : surfaceGrip(w.surface);
        // Per-hero tyre grip. Applied to the SURFACE's mu rather than the
        // class's, because the tyre spec is shared by every instance of the
        // class and mutating it would re-tune the whole fleet. Scaling mu
        // scales `muLong` and `muLat` together, which is what a compound does.
        w.grip = this.hero.grip === 1 ? base : this._heroGrip(base, w);
        grounded++;
      } else {
        // Free droop: the wheel falls to the end of its travel.
        w.len = Math.min(hp.max, w.len + 6 * dt);
        w.grounded = false;
        w.reach = GROUND_REACH;
        w.load = 0;
        w.normal.copy(_up);
      }
      // + = compressing. Clamped: a raycast that steps onto a kerb reports a
      // strut speed no real damper ever sees.
      w.vel = Math.max(-7, Math.min(7, (w.prevLen - w.len) / dt));
    }

    // ---- spring + damper + anti-roll -------------------------------------
    const arb = [0, 0, 0, 0];
    if (wheels.length === 4) {
      const cF = (wheels[0].hp.staticLen - wheels[0].len) - (wheels[1].hp.staticLen - wheels[1].len);
      const cR = (wheels[2].hp.staticLen - wheels[2].len) - (wheels[3].hp.staticLen - wheels[3].len);
      const kF = spec.susp.arbF;
      const kR = spec.susp.arbR;
      arb[0] = -cF * kF; arb[1] = cF * kF;
      arb[2] = -cR * kR; arb[3] = cR * kR;
    }

    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      if (!w.grounded) continue;
      const hp = w.hp;
      const compression = hp.rest - w.len;
      let f = hp.k * compression;
      /**
       * Asymmetric damping: firm on rebound, soft on bump — every road car.
       *
       * The damper force MUST be clamped. `w.vel` is a finite difference of the
       * raycast length, so a 5 cm step at a road-tile seam or a kerb edge reads
       * as 6 m/s of strut velocity and produces a 20 kN spike that launches a
       * 1.4 t car off the road. Real dampers blow off at high shaft speeds for
       * exactly this reason. Without the clamp the car bounced on the spot,
       * lost all four contact patches, and could not accelerate at all.
       */
      const damp = w.vel > 0 ? hp.c : hp.c * spec.susp.reboundScale;
      const maxDamp = (hp.front ? spec.staticLoadF : spec.staticLoadR) * 3.2;
      f += Math.max(-maxDamp, Math.min(maxDamp, damp * w.vel));
      f += arb[i];
      // Bump stop: the last 15% of travel gets very stiff, which is what stops
      // a car bottoming out through the floor over a kerb.
      if (w.len < hp.min + spec.susp.travel * 0.14) {
        const over = hp.min + spec.susp.travel * 0.14 - w.len;
        f += over * hp.k * 9;
      }
      if (f < 0) f = 0;
      if (f > hp.k * spec.susp.travel * 4) f = hp.k * spec.susp.travel * 4;
      /**
       * The forgiveness band, and the ONE line that keeps it honest.
       *
       * A wheel the strut cannot actually reach must not hold the car up — that
       * would turn "forgiving" into "hovering", which is the defect, not the
       * fix. So the whole corner force, and with it `w.load` and therefore every
       * tyre force derived from it, scales linearly to zero across
       * `GROUND_REACH`. At `reach === 0` this multiplies by exactly 1 and the
       * car behaves as it always did; at the edge of the band the corner is
       * carrying nothing and the car sinks onto the wheels that can reach.
       *
       * What it buys is the part that matters: between those two, a wheel that
       * is a couple of centimetres light still has a contact patch, a surface
       * and a mu, so the driven axle can still put power down and steer. A car
       * that is 4 cm too high and drives beats one that is exact and cannot.
       */
      if (w.reach > 0) f *= Math.max(0, 1 - w.reach / GROUND_REACH);
      w.load = f;
      if (i === 0) this.diag.suspF = f;

      _n.copy(w.normal).multiplyScalar(f);
      _r.copy(w.contact).sub(this.position);
      this.addForceAtLocal(_n, _r);
    }

    this.grounded = grounded;
    this.airborne = grounded === 0 ? this.airborne + dt : 0;

    // ---- drivetrain -------------------------------------------------------
    for (let i = 0; i < this._driven.length; i++) {
      this._drivenOmega[i] = wheels[this._driven[i]].omega;
      this._drivenTorque[i] = 0;
    }
    if (this.engineOn && !this.destroyed) {
      this.drivetrain.step(dt, this.control, this._drivenOmega, this._drivenTorque, this.forwardSpeed);
      // Traction control takes its cut here — see `_hookUp`, which decided how
      // much on this step's slip.
      if (this.traction > 0) {
        const keep = 1 - TC_CUT * this.traction;
        for (let i = 0; i < this._drivenTorque.length; i++) this._drivenTorque[i] *= keep;
      }
    } else {
      this.drivetrain.omega *= 1 - Math.min(1, dt * 1.6);
      this.drivetrain.rpm = this.drivetrain.omega / (Math.PI / 30);
      for (let i = 0; i < this._drivenTorque.length; i++) this._drivenTorque[i] = 0;
    }

    // ---- tyres ------------------------------------------------------------
    const handbrake = this.input.handbrake;
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      const hp = w.hp;
      w.steer = hp.steered ? this.steerAngle + hp.toe : hp.toe;

      // Wheel basis in the contact plane.
      _v1.set(Math.sin(w.steer), 0, Math.cos(w.steer)).applyQuaternion(this.quaternion);
      _v2.copy(w.normal).multiplyScalar(_v1.dot(w.normal));
      w.forward.copy(_v1).sub(_v2);
      if (w.forward.lengthSq() < 1e-8) w.forward.set(0, 0, 1);
      w.forward.normalize();
      w.right.crossVectors(w.forward, w.normal).normalize();

      let driveT = 0;
      let inertia = hp.inertia;
      const di = this._driven.indexOf(i);
      if (di >= 0) {
        driveT = this._drivenTorque[di];
        // A driven wheel in first gear carries the engine's rotating mass
        // multiplied by the square of the ratio — tens of kg.m^2. Leave it out
        // and the tyre "spins up" in one step and the model explodes.
        inertia += this.drivetrain.reflectedInertia;
      }

      let brakeT = this.control.brake * hp.braked;
      if (handbrake && hp.handbrake > 0) brakeT = Math.max(brakeT, hp.handbrake);
      if (w.broken) brakeT += 400;

      if (!w.grounded) {
        // Airborne: only drive and brakes act on the wheel.
        w.omega += (driveT / inertia) * dt;
        if (brakeT > 0) {
          const stopT = (Math.abs(w.omega) * inertia) / dt;
          const applied = Math.min(brakeT, stopT);
          w.omega -= (Math.sign(w.omega) * applied * dt) / inertia;
        }
        w.omega -= w.omega * 0.35 * dt;
        w.fx = 0;
        w.fy = 0;
        w.combined = 0;
        w.kFx = 0;
        w.skidding = false;
        continue;
      }

      _r.copy(w.contact).sub(this.position);
      this.pointVelocity(_r, _v3);
      const vLong = _v3.dot(w.forward);
      const vLat = _v3.dot(w.right);
      // Cached for `_hookUp`: the speed the contact patch is ACTUALLY moving at
      // along this wheel's own heading, which is what its slip is measured
      // against. Not the same as the chassis' forward speed once the car is
      // sideways, and using the chassis instead reads a slide as wheelspin.
      w.vLong = vLong;

      const loadRef = hp.front ? this.spec.staticLoadF : this.spec.staticLoadR;
      tyreForces(w, this.spec.tyre, w.load, loadRef, vLong, vLat, w.omega, hp.radius, w.grip, dt);

      // Handbrake kills lateral grip at the rear, which is what makes the back
      // step out instead of the car simply stopping.
      if (handbrake && hp.handbrake > 0) w.fy *= 0.42;
      if (w.broken) { w.fx *= 0.3; w.fy *= 0.25; }

      /**
       * Wheel spin: drive torque, tyre reaction, then brakes as a limited
       * torque so the wheel locks instead of counter-rotating.
       *
       * ────────────────────────────────────────────────────────────────────
       * SEMI-IMPLICIT, and that is load-bearing, not tidy numerics.
       * ────────────────────────────────────────────────────────────────────
       * `w.kFx` is d(fx)/d(omega) from the tyre model. Solving
       *
       *     I (w1 - w0)/dt = T - r fx(w1) ~= T - r fx(w0) - r kFx (w1 - w0)
       *
       * for w1 gives the divisor below and makes the step unconditionally
       * stable. Explicit Euler is stable only while r*kFx*dt/I < 2, and at low
       * road speed that ratio is 12.9 on a sedan's undriven rear wheel — see
       * the derivation in `tyre.js`. The visible symptom was a car at full
       * throttle, four wheels down, nothing touching it, that did not move:
       * the wheels oscillated one step on, one step off, and the tyre forces
       * they threw at the chassis cancelled to zero.
       *
       * The fixed point is untouched — the correction is proportional to
       * (w1 - w0) and vanishes at equilibrium — so every steady-state number
       * in `bench.mjs` (grip, top speed, braking distance, drift angle) is the
       * same. Only the way the wheel GETS there changes, and only where the
       * old path was diverging.
       */
      w.omega += ((driveT - w.fx * hp.radius) * dt) / (inertia + dt * hp.radius * w.kFx);
      if (brakeT > 0) {
        const stopT = (Math.abs(w.omega) * inertia) / dt;
        const applied = Math.min(brakeT, stopT);
        w.omega -= (Math.sign(w.omega) * applied * dt) / inertia;
      }

      // Apply the contact-patch force.
      _v4.copy(w.forward).multiplyScalar(w.fx);
      _v4.addScaledVector(w.right, w.fy);
      const rr = rollingResistance(this.spec.tyre, w.load, vLong, w.grip);
      _v4.addScaledVector(w.forward, rr);
      this.addForceAtLocal(_v4, _r);

      const slipping = w.combined > 1.02 || (handbrake && hp.handbrake > 0 && Math.abs(vLong) > 2);
      w.skidding = slipping && w.load > 40;
      w.skidTime = w.skidding ? w.skidTime + dt : 0;
      w.spin += w.omega * dt;
    }

    /**
     * ---- low-speed creep suppression ---------------------------------------
     *
     * Without it a parked car jitters forever. With it as it was, NOTHING COULD
     * EVER PUSH A STOPPED CAR — which is a car-will-not-move defect in its own
     * right, because the car in front of you is a stopped car.
     *
     * Two things were wrong and they compounded:
     *
     *   It lived INSIDE the per-wheel loop, so a four-wheeler applied it four
     *   times per step: `1 - dt*6` became `(1 - dt*6)^4`, a 24 per second
     *   damper rather than the 6 the expression plainly intends.
     *
     *   It has no idea whether the velocity it is deleting is numerical noise or
     *   somebody's front bumper. At 24 per second it is worth m*24*v of virtual
     *   friction — 15 kN on a stopped truck at the 0.12 m/s threshold — so a
     *   sedan leaning on it with its entire 7.6 kN of traction moved the pair at
     *   4 cm/s and stayed there for as long as the throttle was held.
     *
     * So: once per step, at the rate that was written, and never while another
     * vehicle is pressing on this one (`_pressed`, set by
     * `VehicleSystem._pairResolve`). Residual jitter is still killed; a shove is
     * not.
     */
    if (
      grounded > 0 && this._pressed <= 0 && this.control.throttle < 0.02 &&
      Math.abs(this.forwardSpeed) < 0.12 && Math.abs(this.lateralSpeed) < 0.12
    ) {
      const k = 1 - Math.min(1, dt * 6);
      this.velocity.multiplyScalar(k);
      this.angularVelocity.multiplyScalar(k);
    }

    /**
     * ---- yaw stability -----------------------------------------------------
     *
     * A damper that pulls the yaw rate towards the ACKERMANN rate the steering
     * is asking for — but CLAMPED to the rate the tyres can physically sustain,
     * `mu*g / v`. The clamp is the whole point. Without it, full lock at
     * 100 km/h asks for 7.4 rad/s, the "stabiliser" happily supplies the torque
     * to get there, and the thing it is supposed to prevent is the thing it
     * causes: the car snapped into an unrecoverable spin every time.
     *
     * With the clamp this is the understeer limiter every arcade-accessible
     * driving game runs: it will not turn faster than grip allows, and it bleeds
     * off yaw when the car is already rotating faster than that.
     */
    if (grounded > 0 && this.speed > 3) {
      const yawRate = this.angularVelocity.dot(_up);
      const ackermann = (this.forwardSpeed * Math.tan(this.steerAngle)) / this.spec.wheelbase;
      let mu = 0;
      for (let i = 0; i < wheels.length; i++) mu += wheels[i].mu || 0;
      mu = (mu / wheels.length) || 1;
      const maxYaw = (mu * 9.81) / Math.max(4, Math.abs(this.forwardSpeed));
      const target = Math.max(-maxYaw, Math.min(maxYaw, ackermann));
      const err = target - yawRate;
      const grip = grounded / wheels.length;
      const k = this.spec.inertia.y * 0.7 * Math.min(1, this.speed / 12) * grip;
      this.addTorque(_v0.copy(_up).multiplyScalar(err * k));

      /**
       * Spin recovery: past ~35 degrees of body slip the car is no longer
       * cornering, it is rotating, and a real driver plus a real tyre both
       * fight that. Scaled by grip so an airborne car still tumbles freely.
       *
       * A BIKE gets it earlier and harder. Two contact patches on the
       * centreline give it no yaw damping of its own, so once the rear steps
       * out — which on a 124 N.m superbike is every time you open the throttle
       * — nothing brought it back: the bench measured 50-59 degrees of slip
       * still standing after a handbrake slide and two seconds of corrective
       * lock. A rider catches that with the bars and his knee; this is that.
       */
      const bike = this.spec.kind === 'bike';
      const beta = Math.abs(this.slipAngle);
      const onset = bike ? 0.28 : 0.6;
      if (beta > onset) {
        const strength = Math.min(1, (beta - onset) / 0.7);
        const gain = bike ? 4.2 : 1.5;
        this.addTorque(
          _v0.copy(_up).multiplyScalar(-yawRate * this.spec.inertia.y * gain * strength * grip)
        );
      }
    }

    // ---- bike lean --------------------------------------------------------
    if (this.spec.kind === 'bike') this._bikeLean(dt);
  }

  /* ------------------------------------------------------- kerbs --- */

  /**
   * THE LEADING EDGE A RAYCAST WHEEL DOES NOT HAVE.
   *
   * `_stepWheels` finds the ground with one vertical ray per wheel. That is a
   * POINT contact, and a point cannot climb: against a kerb the tyre simply
   * intersects the vertical face until the ray crosses the edge, while the
   * chassis probes are already inside that face and `_collide` pushes them back
   * out along its horizontal normal every step. Drive in, push out, drive in —
   * a car that catches a 15 cm lip and sits there under full throttle.
   *
   * A real 32 cm tyre rolls over a 15 cm kerb because the contact force rotates
   * up the face as the carcass envelops the edge. This reproduces that effect
   * directly and nothing else: probe forward from the contact patch, and if
   * there is a face within reach whose TOP is a kerb height or less above the
   * ground the car is on, unload the corner in proportion to the step. The car
   * still has to drive itself over — no impulse, no position write.
   *
   * Armed only below `KERB_MAX_SPEED`, only when the driver is asking to move,
   * and only for near vehicles; a car at road speed has a suspension for this
   * and a car nobody can see does not need it. Refreshed every step under
   * 3 m/s (where snags happen) and every fourth step above it, so a city full
   * of traffic pays two rays per wheel at 30 Hz rather than 120.
   */
  _rideKerbs(dt) {
    const wheels = this.wheels;
    const phys = this.sys.physics;
    const drive = Math.max(this.control.throttle, this.input.reverse ?? 0);
    const v = Math.abs(this.forwardSpeed);
    if (
      !phys?.raycast || this.destroyed || drive < 0.05 ||
      v > KERB_MAX_SPEED || (this.sys.lodOf?.(this) ?? 0) >= 2
    ) {
      for (let i = 0; i < wheels.length; i++) wheels[i].kerbStep = 0;
      return;
    }

    this._feelPhase = (this._feelPhase + 1) & 3;
    if (v < 3 || this._feelPhase === 0) {
      // Which way the tyres are trying to roll: measured travel when there is
      // any, the selected gear when there is not (which is the whole point —
      // a snagged car has no travel to read).
      const sign = v > 0.25
        ? Math.sign(this.forwardSpeed)
        : (this.drivetrain.reversing ? -1 : 1);
      _up.set(0, 1, 0).applyQuaternion(this.quaternion);
      for (let i = 0; i < wheels.length; i++) {
        wheels[i].kerbStep = this._feelKerb(wheels[i], sign, phys);
      }
    }

    // Lift, capped so the total can never approach the car's own weight — this
    // has to help a tyre find the top of a kerb, not levitate a car.
    if (this.velocity.y > ASSIST_MAX_CLIMB) return;
    const perWheel = (this.mass * -GRAVITY) / Math.max(1, wheels.length);
    let budget = this.mass * -GRAVITY * 0.9;
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      if (w.kerbStep <= 0) continue;
      const f = Math.min(budget, perWheel * KERB_LIFT * (w.kerbStep / KERB_MAX));
      if (f <= 0) break;
      budget -= f;
      _k0.set(0, f, 0);
      _r.copy(w.contact).sub(this.position);
      this.addForceAtLocal(_k0, _r);
    }
  }

  /**
   * One wheel's feeler. Returns the height of the step it is up against, or 0.
   *
   * Two rays, and the second one is what makes this safe: the first finds a
   * near-vertical FACE in the rolling direction, the second looks DOWN just
   * past that face for the surface on top of it. A wall returns nothing,
   * because nothing is found within `KERB_MAX` of the wheel's own contact — so
   * this can only ever help a car over something a car could drive over.
   */
  _feelKerb(w, sign, phys) {
    if (!w.grounded) return 0;
    const reach = w.hp.radius * KERB_REACH;
    _k1.copy(w.forward).multiplyScalar(sign);
    _k1.y = 0;
    if (_k1.lengthSq() < 1e-6) return 0;
    _k1.normalize();

    // Probe at ankle height so the ray sees the face rather than the road.
    _k0.copy(w.contact).addScaledVector(_up, 0.05);
    const face = phys.raycast(_k0, _k1, reach, phys.MASK.WORLD);
    if (!face.hit) return 0;
    // A face, not a ramp, and one that actually opposes the car.
    if (Math.abs(face.normal.y) > 0.6) return 0;
    if (face.normal.dot(_k1) > -0.2) return 0;

    // What is on top of it?
    _k2.copy(face.point).addScaledVector(_k1, 0.10);
    _k2.y = w.contact.y + KERB_MAX + 0.25;
    _k3.set(0, -1, 0);
    const top = phys.raycast(_k2, _k3, KERB_MAX + 0.55, phys.MASK.WORLD);
    if (!top.hit) return 0;
    // Flat enough to land on.
    if (top.normal.y < 0.55) return 0;
    const step = top.point.y - w.contact.y;
    return step > 0.02 && step <= KERB_MAX ? step : 0;
  }

  /**
   * THE SAFETY NET, including the one state the feeler cannot see.
   *
   * A car that climbs a kerb and comes to rest on its underbody has `grounded
   * === 0`: no tyre is touching anything, so no pedal does anything at all, and
   * the player is stranded for the rest of the session. That is the "floating
   * in the air" half of the report and it is why the support test below is
   * "resting on SOMETHING" rather than "wheels down".
   *
   * Arming is deliberately narrow, and one clause of it is load-bearing for the
   * gate as well as for the feel: the car must be WEDGED — a chassis contact or
   * a wheel against a step. Without that clause a car merely short of grip
   * (a 1-in-4 of wet grass, which `drivetest` asserts on) would get a push, and
   * a launch assertion that can be satisfied by the recovery instead of by the
   * tyres is no longer measuring the tyres. On a bare plane there are no
   * contacts and no faces, so this never fires and all 208 existing assertions
   * are measuring exactly what they were.
   *
   * `diag.contacts` is last step's count — `_collide` runs after this — which
   * is 8 ms stale and does not matter for a car that has been stationary for a
   * second.
   *
   * What it applies is a shove at the CENTRE OF MASS in the direction the
   * driver is already asking to go, plus the lift described at `ASSIST_LIFT`.
   * At the CoM so it cannot add yaw the player did not ask for, and under a g
   * so it can never pick the car up. It ramps over `ASSIST_IN` and lets go over
   * `ASSIST_OUT`, and `ASSIST_MAX_CLIMB` caps the climb rate.
   *
   * ARMING AND RELEASE ARE DELIBERATELY ASYMMETRIC, and this is the part that
   * took measuring rather than reasoning. Arming needs a full second of no
   * progress against an obstruction. RELEASE needs the car to be both rolling
   * AND no longer wedged — "it has moved 30 cm" is not good enough and the
   * numbers say so: releasing on distance let go the moment the car crept, it
   * re-stuck, it re-armed a second later, and every class in the fleet scraped
   * off the same block in 4.35-4.67 s of visible stutter. (That the times were
   * within 0.3 s of each other across a 232 kg bike and a 5.4 t truck is the
   * tell: the limit cycle was the arming delay, not the physics.) Holding until
   * the car is genuinely free is both quicker and quieter.
   */
  _unstick(dt) {
    const asking = Math.max(this.control.throttle, this.input.reverse ?? 0);
    const powered =
      asking > 0.15 && this.engineOn && !this.destroyed && !this.input.handbrake &&
      this._pressed <= 0;
    const supported = this.grounded > 0 || this.diag.contacts > 0;
    let wedged = this.diag.contacts > 0;
    if (!wedged) {
      for (let i = 0; i < this.wheels.length; i++) {
        if (this.wheels[i].kerbStep > 0) { wedged = true; break; }
      }
    }
    const rolling = Math.abs(this.forwardSpeed) > STUCK_SPEED;

    if (!powered || !supported) {
      this._stuckFrom.copy(this.position);
      this.stuckFor = 0;
      this.kerbAssist = Math.max(0, this.kerbAssist - dt / ASSIST_OUT);
    } else if (this.kerbAssist > 0.001) {
      // Engaged: hold until the car is moving AND off whatever held it.
      if (rolling && !wedged) {
        this._stuckFrom.copy(this.position);
        this.stuckFor = 0;
        this.kerbAssist = Math.max(0, this.kerbAssist - dt / ASSIST_OUT);
      } else {
        this.kerbAssist = Math.min(1, this.kerbAssist + dt / ASSIST_IN);
      }
    } else if (!wedged || rolling ||
      this.position.distanceTo(this._stuckFrom) > STUCK_TRAVEL) {
      this._stuckFrom.copy(this.position);
      this.stuckFor = 0;
    } else {
      this.stuckFor += dt;
      if (this.stuckFor > STUCK_TIME) {
        this.kerbAssist = Math.min(1, this.kerbAssist + dt / ASSIST_IN);
      }
    }
    if (this.kerbAssist <= 0.001) return;

    const a = this.kerbAssist;
    const sign = this.drivetrain.reversing ? -1 : 1;
    _k0.set(0, 0, 1).applyQuaternion(this.quaternion).multiplyScalar(sign);
    _k0.y = 0;
    if (_k0.lengthSq() < 1e-6) return;
    _k0.normalize();
    this._force.addScaledVector(_k0, this.mass * ASSIST_PUSH * a);
    if (this.velocity.y < ASSIST_MAX_CLIMB) {
      this._force.y += this.mass * -GRAVITY * ASSIST_LIFT * a;
    }
  }

  /**
   * A two-wheeler has no roll stiffness at all: it stays up because the rider
   * steers under the centre of mass. Model that directly — compute the lean
   * angle that balances the lateral acceleration and drive the roll to it with
   * a stiff PD. It falls over when stopped and destroyed, and leans hard into a
   * corner, which is the whole reason a bike feels different.
   */
  _bikeLean(dt) {
    _fwd.set(0, 0, 1).applyQuaternion(this.quaternion);
    _right.set(1, 0, 0).applyQuaternion(this.quaternion);
    _up.set(0, 1, 0).applyQuaternion(this.quaternion);
    const L = this.spec.lean;
    const yawRate = this.angularVelocity.dot(_up);
    const latAcc = yawRate * this.forwardSpeed;
    // The balanced lean angle is atan(a_lat / g), not a linear gain on a_lat.
    // A linear gain asks for 70 degrees at 1 g, the controller saturates
    // fighting the tyre's own roll moment, and the bike thrashes.
    let target = Math.atan2(latAcc * L.gain * 8, 9.81);
    target = Math.max(-L.max, Math.min(L.max, target));
    if (this.destroyed || (this.grounded === 0 && this.airborne > 0.6)) target = this.leanAngle;
    this.leanAngle += (target - this.leanAngle) * Math.min(1, L.rate * dt);

    // Roll error about the forward axis.
    const rollNow = Math.atan2(_right.y, _up.y);
    const err = -this.leanAngle - rollNow;
    const rollRate = this.angularVelocity.dot(_fwd);
    /**
     * The gain has to be able to BEAT GRAVITY, not just perturb the roll.
     *
     * At 39 degrees of lean the weight of the bike about its contact line is
     * m*g*h*sin(lean) — about 750 N.m on the Slagbolt — and the old gain
     * (`inertia.z * 60`, 822 N.m per radian) produced 80 N.m at a tenth of a
     * radian of error. So the moment the tyre could not supply the cornering
     * force the whole thing simply lay down: the bench measured 86 degrees of
     * roll and a meaningless 57 g in the steady-state corner, and in the game a
     * bike that falls over every time you lean on it is not rideable.
     *
     * Scaled off the gravity moment it is a servo the rider always wins, which
     * is what an arcade bike needs. Damping stays near critical.
     */
    const k = Math.max(this.spec.inertia.z * 60, this.mass * 9.81 * this.spec.comY * 2.6);
    this.addTorque(_v0.copy(_fwd).multiplyScalar(err * k - rollRate * k * 0.17));

    // A bike's contact patches are on the centreline, so nothing else damps
    // yaw at all. Without this it pirouettes the moment it steps out.
    this.addTorque(
      _v0.copy(_up).multiplyScalar(-yawRate * this.spec.inertia.y * 1.1 * Math.min(1, this.grounded))
    );
  }

  _stepBoat(dt, ctx) {
    // The engine still revs; the prop turns it into thrust in stepBoat().
    for (let i = 0; i < this._drivenOmega.length; i++) {
      this._drivenOmega[i] = Math.abs(this.forwardSpeed) * 3.2;
    }
    if (this.engineOn && !this.destroyed) {
      this.drivetrain.step(dt, this.input, this._drivenOmega, this._drivenTorque, this.forwardSpeed);
    }
    const onWater = stepBoat(this, dt, ctx);
    if (!onWater) {
      // Beached or airborne: fall, and let the collision pass catch it.
      this.inWater = false;
      this.planing = 0;
    }
    this.grounded = this.inWater ? 4 : 0;
  }

  /**
   * ────────────────────────────────────────────────────────────────────────
   * A CAR IN THE RIVER. THREE RULES, IN REAL UNITS.
   * ────────────────────────────────────────────────────────────────────────
   * Before this, a car driven into the Allegheny settled on the riverbed on
   * `SURFACE_GRIP.water`'s mu 0.22 and idled there for the rest of the session:
   * no damage, no cap, no drowning, and the engine note still playing. On a map
   * built out of three rivers and forty bridges that is not an edge case, it is
   * something a player does in the first ten minutes.
   *
   * The whole water rule for a land vehicle is a 15% speed cap, 6% of max
   * health per second, and the loss of drive a drowned engine implies. All
   * three are here, and every one of them is a
   * FORCE or a state change rather than a clamp on a position, so the ordinary
   * integrator, the ordinary collision pass and the ordinary damage model all
   * still apply and a car in a river is still a rigid body.
   *
   * See the WATER block in `specs.js` for why the damage is a FRACTION of max
   * health (a bus and a bicycle must drown in the same 16.7 s, and they have a
   * 33:1 health ratio) and how `hydro.capSpeed` is derived without reading a
   * test file.
   */
  _stepWater(dt, ctx) {
    const spec = this.spec;
    const hy = this.sys.waterHeightAt ? this.sys.waterHeightAt(this.position.x, this.position.z, ctx) : null;
    if (hy === null || hy === undefined || !Number.isFinite(hy)) {
      this.inWater = false;
      this.submerged = 0;
      // The intake dries out; a DROWNED engine stays drowned. That is what a
      // body shop is for, and it is the cost of the shortcut across the river.
      this.drowning = Math.max(0, this.drowning - dt);
      return;
    }
    const H = spec.dims.H;
    const floorY = this.position.y - spec.comY + (spec.style?.groundY ?? 0.15);
    const sub = Math.max(0, Math.min(1, (hy - floorY) / H));
    this.waterY = hy;
    this.submerged = sub;
    this.inWater = sub > 0;
    if (sub <= WATER.wadeFrac) {
      this.drowning = Math.max(0, this.drowning - dt);
      return;
    }

    /* ---- buoyancy ------------------------------------------------------ */
    // A car is a box full of air, so it floats for a few seconds and then fills
    // and sinks. `flooded` is that fill, and it is why the nose goes down first.
    this.flooded = Math.min(1, this.flooded + dt * WATER.floodRate);
    const buoy = WATER.rho * 9.81 * spec.hydro.volume * sub * WATER.buoyancy * (1 - this.flooded);
    if (buoy > 0) {
      _v0.set(0, buoy, 0);
      // At the centre of the body, which is above the CoM — so the hull rights
      // itself in roll for free, exactly as a floating body does.
      _r.set(0, H * 0.5 - spec.comY, 0).applyQuaternion(this.quaternion);
      this.addForceAtLocal(_v0, _r);
    }

    /* ---- hydrodynamic drag --------------------------------------------- */
    // Water is 800 times denser than air. This alone is most of the cap.
    const sp = this.velocity.length();
    if (sp > 0.05) {
      _v0.copy(this.velocity).multiplyScalar(-spec.hydro.kDrag * sub * sp * 0.5);
      this.addForce(_v0);
    }
    // Heave damping — see WATER.heaveDamp. Linear, vertical only, and the
    // difference between a car that settles into a river and one that bounces
    // back out of it.
    this._force.y -= this.velocity.y * WATER.heaveDamp * WATER.rho * spec.hydro.volume * sub;

    /* ---- the 15% terrain cap -------------------------------------------- */
    // HORIZONTAL only: a car falling into the river has a large downward
    // velocity and capping the magnitude would have it fighting gravity.
    // Written as a resistive force with a 0.25 s time constant rather than a
    // clamp on `velocity`, so it composes with the collision solver instead of
    // teleporting through it.
    const hx = this.velocity.x, hz = this.velocity.z;
    const hsp = Math.hypot(hx, hz);
    const cap = spec.hydro.capSpeed;
    if (hsp > cap) {
      const k = ((hsp - cap) / hsp) * (this.mass / 0.25);
      _v0.set(-hx * k, 0, -hz * k);
      this.addForce(_v0);
    }

    /* ---- damage --------------------------------------------------------- */
    // Accumulated and flushed at 4 Hz: `sys.damage` dents panels and can emit
    // `vehicle:destroyed`, and doing that 120 times a second is a lot of events
    // for one drowning car.
    this.waterDamage += spec.hydro.dps * dt;
    this._waterHurtT = (this._waterHurtT ?? 0) + dt;
    if (this._waterHurtT >= 0.25) {
      const amount = spec.hydro.dps * this._waterHurtT;
      this._waterHurtT = 0;
      if (this.sys.damage) this.sys.damage(this, amount, null);
      else {
        this.health = Math.max(0, this.health - amount);
        if (this.health <= 0) this.destroyed = true;
      }
    }

    /* ---- the engine drowns ---------------------------------------------- */
    // A `nogas` class has no engine and therefore nothing to drown: the
    // bicycle's motor is a pair of legs and they do not stop working when wet.
    // It still takes the damage and the cap above, which apply to every
    // non-flying vehicle.
    if (spec.nogas) return;
    // Over the AIR INTAKE, not over a tyre: fording a shallow bank must not
    // kill a car, and two metres of Monongahela must.
    const intakeY = this.position.y - spec.comY + spec.hydro.intakeY;
    if (hy > intakeY) {
      this.drowning += dt;
      if (!this.drowned && this.drowning >= WATER.drownDelay) {
        this.drowned = true;
        this.engineOn = false;
        this.input.throttle = 0;
        this.control.throttle = 0;
        this.sys.onEngineDrowned?.(this);
      }
    } else {
      this.drowning = Math.max(0, this.drowning - dt * 2);
    }
  }

  /** Copy a surface grip entry with the driver's own mu. Never allocates. */
  _heroGrip(base, w) {
    const g = w.gripMod;
    g.mu = base.mu * this.hero.grip;
    g.roll = base.roll;
    g.drag = base.drag;
    g.noise = base.noise;
    g.skid = base.skid;
    g.dust = base.dust;
    return g;
  }

  _aero(dt) {
    const a = this.spec.aero;
    const v2 = this.velocity.lengthSq();
    if (v2 > 0.04) {
      const v = Math.sqrt(v2);
      _v0.copy(this.velocity).multiplyScalar(-a.kDrag * v);
      // Applied above the CoM so hard braking at speed adds a nose-down pitch.
      _r.set(0, this.spec.dims.H * 0.22, 0).applyQuaternion(this.quaternion);
      this.addForceAtLocal(_v0, _r);
    }
    if (this.spec.kind === 'car' && this.grounded > 0) {
      const fs2 = this.forwardSpeed * this.forwardSpeed;
      _up.set(0, 1, 0).applyQuaternion(this.quaternion);
      if (a.kDownF > 0) {
        _v0.copy(_up).multiplyScalar(-a.kDownF * fs2);
        _r.set(0, 0, this.spec.axleF).applyQuaternion(this.quaternion);
        this.addForceAtLocal(_v0, _r);
      }
      if (a.kDownR > 0) {
        _v0.copy(_up).multiplyScalar(-a.kDownR * fs2);
        _r.set(0, 0, this.spec.axleR).applyQuaternion(this.quaternion);
        this.addForceAtLocal(_v0, _r);
      }
    }
    // Yaw damping from the body's own side area.
    _up.set(0, 1, 0).applyQuaternion(this.quaternion);
    const yaw = this.angularVelocity.dot(_up);
    this.addTorque(_v0.copy(_up).multiplyScalar(-yaw * a.yawDrag * Math.max(1, this.speed * 0.12)));
  }

  _integrate(dt) {
    // Linear.
    _v0.copy(this._force).multiplyScalar(this.invMass * dt);
    this.velocity.add(_v0);
    this.position.addScaledVector(this.velocity, dt);

    // Angular: torque -> body frame -> I^-1 -> back to world.
    _q0.copy(this.quaternion).invert();
    _v1.copy(this._torque).applyQuaternion(_q0);
    _v1.x *= this.invI.x;
    _v1.y *= this.invI.y;
    _v1.z *= this.invI.z;
    _v1.applyQuaternion(this.quaternion).multiplyScalar(dt);
    this.angularVelocity.add(_v1);

    // Clamp: a numerical blow-up must never launch a car into orbit.
    const aw = this.angularVelocity.length();
    if (aw > 14) this.angularVelocity.multiplyScalar(14 / aw);
    const sp = this.velocity.length();
    if (sp > 140) this.velocity.multiplyScalar(140 / sp);
    if (!Number.isFinite(this.position.x + this.position.y + this.position.z)) {
      this.position.copy(this.prevPosition);
      this.velocity.set(0, 0, 0);
      this.angularVelocity.set(0, 0, 0);
    }

    _q1.set(this.angularVelocity.x, this.angularVelocity.y, this.angularVelocity.z, 0);
    _q1.multiply(this.quaternion);
    this.quaternion.x += _q1.x * 0.5 * dt;
    this.quaternion.y += _q1.y * 0.5 * dt;
    this.quaternion.z += _q1.z * 0.5 * dt;
    this.quaternion.w += _q1.w * 0.5 * dt;
    this.quaternion.normalize();
  }

  /**
   * Chassis vs the static world. Sphere probes at the body corners against the
   * BVH; the deepest contact per probe is resolved with a positional push and
   * an impulse, so hitting a wall costs speed and spins the car rather than
   * stopping it dead or letting it pass through.
   */
  _collide(dt, ctx) {
    const phys = this.sys.physics;
    if (!phys?.staticWorld) return;
    const cts = phys.staticWorld.contacts;
    const r = this.probeR;
    let biggest = 0;
    let hitPointX = 0, hitPointY = 0, hitPointZ = 0;
    let hitNX = 0, hitNY = 0, hitNZ = 0;
    let hitObj = null;
    const near = this.sys.lodOf(this) < 2;
    const step = near ? 1 : 2;
    this.diag.contacts = 0;
    this.diag.pushY = 0;

    for (let i = 0; i < this.probes.length; i += step) {
      _v0.copy(this.probes[i]).applyQuaternion(this.quaternion).add(this.position);
      const n = phys.staticWorld.overlapCapsule(
        _v0.x, _v0.y, _v0.z, _v0.x, _v0.y, _v0.z, r, phys.MASK.WORLD, 0
      );
      if (n === 0) continue;
      // Deepest contact only: resolving all of them fights itself.
      let best = -1;
      let bestDepth = 0;
      for (let c = 0; c < n; c++) {
        if (cts.depth[c] > bestDepth) { bestDepth = cts.depth[c]; best = c; }
      }
      if (best < 0) continue;
      _n.set(cts.nx[best], cts.ny[best], cts.nz[best]);
      const depth = Math.min(bestDepth, 0.35);

      // Positional correction, damped so a car resting in a gutter is stable.
      this.diag.contacts++;
      this.diag.pushY += _n.y * depth * 0.55;
      this.position.addScaledVector(_n, depth * 0.55);

      _r.set(cts.px[best], cts.py[best], cts.pz[best]).sub(this.position);
      this.pointVelocity(_r, _v2);
      const vn = _v2.dot(_n);
      if (vn >= 0) continue;

      // j = -(1+e) vn / (1/m + n . ((I^-1 (r x n)) x r))
      _v3.copy(_r).cross(_n);
      _q0.copy(this.quaternion).invert();
      _v3.applyQuaternion(_q0);
      _v3.x *= this.invI.x; _v3.y *= this.invI.y; _v3.z *= this.invI.z;
      _v3.applyQuaternion(this.quaternion);
      _v4.copy(_v3).cross(_r);
      const denom = this.invMass + _n.dot(_v4);
      const e = 0.12;
      const j = (-(1 + e) * vn) / Math.max(1e-6, denom);

      _v4.copy(_n).multiplyScalar(j);
      this.velocity.addScaledVector(_v4, this.invMass);
      _v3.copy(_r).cross(_v4).applyQuaternion(_q0);
      _v3.x *= this.invI.x; _v3.y *= this.invI.y; _v3.z *= this.invI.z;
      this.angularVelocity.add(_v3.applyQuaternion(this.quaternion));

      // Coulomb friction along the tangent.
      _v5.copy(_v2).addScaledVector(_n, -vn);
      const tl = _v5.length();
      if (tl > 1e-4) {
        _v5.multiplyScalar(1 / tl);
        const jt = Math.max(-j * 0.55, Math.min(j * 0.55, -tl / Math.max(1e-6, denom)));
        _v4.copy(_v5).multiplyScalar(jt);
        this.velocity.addScaledVector(_v4, this.invMass);
        _v3.copy(_r).cross(_v4).applyQuaternion(_q0);
        _v3.x *= this.invI.x; _v3.y *= this.invI.y; _v3.z *= this.invI.z;
        this.angularVelocity.add(_v3.applyQuaternion(this.quaternion));
      }

      if (j > biggest) {
        biggest = j;
        hitPointX = cts.px[best]; hitPointY = cts.py[best]; hitPointZ = cts.pz[best];
        hitNX = _n.x; hitNY = _n.y; hitNZ = _n.z;
        hitObj = phys.staticWorld.objectOf?.(cts.tri[best])?.mesh ?? null;
      }
    }

    this._impactCool = Math.max(0, this._impactCool - dt);
    if (biggest > this.mass * 0.55 && this._impactCool <= 0) {
      this._impactCool = 0.1;
      this._lastImpulse = biggest;
      this.sys.reportCollision(this, hitObj, hitPointX, hitPointY, hitPointZ, hitNX, hitNY, hitNZ, biggest);
    }
  }

  /**
   * ──────────────────────────────────────────────────────────────────────────
   * THE FIRE AND SMOKE RAMPS USED TO LIVE HERE, AND THAT IS WHY NO PARKED CAR
   * HAS EVER BURNED.
   * ──────────────────────────────────────────────────────────────────────────
   * `_postStep` only runs inside `fixedStep`, and `fixedStep` is skipped
   * outright for a sleeping vehicle. Fire is not a force — it is a clock that
   * starts when the car is written off and runs whether or not the solver has
   * anything left to solve. Parking it in the physics step coupled it to the
   * one condition under which the physics deliberately stops: a car standing
   * still. Which is the only state a wreck is ever in.
   *
   * `DamageModel.update` runs unconditionally for every vehicle every frame
   * (`VehicleSystem.update`), so both ramps now live there, at the same rates,
   * next to the fuse they feed. Nothing here decides them any more.
   *
   * Measured before the move, on a sedan that had genuinely fallen asleep and
   * was then written off: `burning 0.000, _acc 0.00, explosions emitted 0`
   * after fifteen seconds of real frames — against `burning 1.000, 1 explosion,
   * neighbour -40.7%` for the identical car killed before it fell asleep.
   */
  _postStep(dt, ctx) {
    if (this._pressed > 0) this._pressed--;
    // Sleep: a parked car with nothing happening to it costs nothing.
    const still = this.speed < 0.12 && this.angularVelocity.lengthSq() < 0.02 &&
      this.input.throttle < 0.01 && this.input.brake < 0.01 && this.grounded >= this.wheels.length - 1;
    this._sleepTimer = still ? this._sleepTimer + dt : 0;
  }

  /* -------------------------------------------------------- rendering -- */

  /** Write the interpolated pose into the scene graph. */
  syncTransforms(alpha, dt) {
    const root = this.model.root;
    root.position.lerpVectors(this.prevPosition, this.position, alpha);
    root.quaternion.copy(this.prevQuaternion).slerp(this.quaternion, alpha);
    root.updateMatrix();

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      const m = this.model.wheels[i];
      if (!m) continue;
      m.node.position.y = w.hp.top - w.len;
      m.node.rotation.y = w.steer;
      m.node.rotation.z = w.camber * (w.hp.x < 0 ? -1 : 1);
      m.spin.rotation.x = w.spin;
    }

    // Rotors. Their own nodes, because they have to turn independently of the
    // body — the same reason doors get a pivot. Phase comes from `heli.js`'s
    // governor, so the disc winds up and runs down instead of snapping on.
    const rotors = this.model.rotors;
    if (rotors) {
      for (let i = 0; i < rotors.length; i++) {
        const r = rotors[i];
        if (r.axis === 'x') r.pivot.rotation.x = this.tailPhase;
        else r.pivot.rotation.y = this.rotorPhase;
      }
    }
  }

  get worldSpeedKmh() {
    return this.speed * 3.6;
  }

  get rpm() {
    return this.drivetrain.rpm;
  }
}
