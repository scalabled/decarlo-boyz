/**
 * THE CAMERA RIG.
 *
 * Two solvers behind one output: a third-person boom for on foot, and a chase
 * camera for vehicles. Both write `position`, `rotation` and `fov`, and the rig
 * cross-fades between them so getting into a car is one continuous move.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ON-FOOT BOOM
 *
 * 1. PIVOT. A damped follow of the character's neck. Horizontal is tight
 *    (tau 55 ms) so the camera does not feel rubber-banded; vertical is loose
 *    (tau 155 ms) so stairs, kerbs and slopes do not jolt the frame. A hard
 *    leash caps the lag at 1.4 m — without it a teleport or a fall would leave
 *    the pivot behind for half a second.
 *
 * 2. ORBIT. Mouse yaw/pitch integrate into a *target* pair and the live pair
 *    chases them with a 28 ms time constant. That single filter is what turns a
 *    raw mouse delta into GTA's slightly weighty look. Pitch is clamped
 *    asymmetrically (-68 deg down, +34 up), because in third person you look
 *    down at the character far more than you look up.
 *
 * 3. BOOM GEOMETRY. The camera sits at
 *
 *      pos = pivot - forward*distance + right*lateral + up*height
 *
 *    with `forward/right/up` the pitched view basis. That construction has one
 *    very useful property: the character's SCREEN position is invariant to
 *    pitch, so looking up and down never re-frames him. `distance` grows and
 *    `height` shrinks with speed — the camera swings out and drops as you run,
 *    which is most of what makes a GTA sprint feel fast. Aiming collapses both
 *    and pushes `lateral` out to a shoulder offset that can swap sides.
 *
 * 4. COLLISION. A sphere cast from the pivot along the boom. The boom shortens
 *    to the first blocker, minus a pad. Pull-IN uses an 18 ms time constant
 *    (effectively instant, but still continuous — a hard set produces a visible
 *    step); push-OUT uses 340 ms plus a 6 cm hysteresis band. That asymmetry is
 *    the entire answer to camera jitter in a tight alley, where the cast
 *    flickers between hit and miss every frame: a flicker can only ever pull
 *    the camera in, and it takes a third of a second of sustained free space to
 *    let it back out.
 *
 * 5. When the boom is forced closer than 1.1 m the character fades out, so the
 *    camera never ends up rendering the inside of his skull.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE VEHICLE CHASE
 *
 * The single thing that makes a GTA drift readable is that the camera frames
 * the car's DIRECTION OF TRAVEL, not its facing. `travelYaw` comes from the
 * velocity vector and the camera yaw chases it with a 260 ms time constant, so
 * when the back steps out the car rotates inside the frame and you look into
 * the slide. Below 3.2 m/s (and in reverse) it falls back to the car's facing,
 * or the camera would spin on the spot in a car park.
 *
 * On top of that: distance and FOV grow with speed, the boom drops as it grows,
 * and a small roll is driven by the centripetal acceleration.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE VIEW CYCLE (V)
 *
 * GTA gives you four views and one key, and the same key does the same thing on
 * foot and in a car. There is no separate "first-person mode" here: the fourth
 * view is the third view with the boom driven to zero and the pivot walked onto
 * the head (on foot) or the bonnet (in a car). That is deliberate, and it is the
 * reason a view change does not register on the continuity meter — the boom
 * length and the pivot are already filtered channels, so cycling views is a
 * DOLLY along the existing solve rather than a cut between two solvers. Measured
 * over a full cycle the peak camera acceleration stays inside the same envelope
 * as a sprint start.
 *
 * The character fades out on its own once the boom is inside 1.1 m, which is
 * what stops the head filling the frame at zero distance.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Nothing in here allocates after construction, and every filter is an
 * exponential with a real time constant, so the result is identical at 30 fps
 * and 240 fps.
 */

import * as THREE from 'three';
import { CAMERA, CHASE, STANCE, MOVE, VIEWS, VIEW_TIME, TOP_RUN_SPEED } from './tuning.js';
import {
  Spring, RecoilAxis, clamp, clamp01, lerp, approach, smootherstep,
  angleDelta, hashNoise, DEG,
} from './springs.js';

const UP = new THREE.Vector3(0, 1, 0);

export class CameraRig {
  constructor(ctx) {
    this.ctx = ctx;
    const C = CAMERA;

    /* ---- orbit ---- */
    this.yaw = 0;
    this.pitch = C.orbit.restPitch;
    this.yawTarget = 0;
    this.pitchTarget = C.orbit.restPitch;
    this.yawRate = 0;
    this.lookIdle = 0;

    /* ---- pivot ---- */
    this.pivot = new THREE.Vector3();
    this.pivotTarget = new THREE.Vector3();
    this.anchor = STANCE.stand.anchor;

    /* ---- boom ---- */
    this.distance = C.boom.distIdle;
    this.distIdeal = C.boom.distIdle;
    this.height = C.boom.heightIdle;
    this.lateral = C.boom.lateralIdle;
    this.shoulder = 1; // +1 right, -1 left
    this.shoulderBlend = 1;
    this.collideRadius = C.boom.distIdle;
    this.characterFade = 1;
    /**
     * Rings of recent free-space measurements. The boom uses the MINIMUM over
     * the window, so a single frame in which the sphere cast happens to miss
     * can never release the camera into a wall. That is the other half of the
     * anti-jitter story; the first half is the asymmetric time constants.
     */
    this._freeRing = new Float32Array(C.collide.window).fill(C.boom.distIdle);
    this._freeCursor = 0;
    this._chaseRing = new Float32Array(C.collide.window).fill(CHASE.distBase);
    this._chaseCursor = 0;

    /* ---- vehicle ---- */
    this.vehicle = null;
    this.vehicleBlend = 0;
    this.chaseYaw = 0;
    this.chasePitch = CHASE.pitchBase;
    this.chaseDist = CHASE.distBase;
    this.chaseHeight = CHASE.heightIdle;
    this.chaseRoll = 0;
    this.chaseFov = 0;
    this.chaseTravelYaw = 0;
    this.chasePrevTravel = 0;
    this.chaseRadius = CHASE.distBase;
    this.chasePivot = new THREE.Vector3();
    this._footFov = ctx.config.fov * CAMERA.fovScale;
    this._chaseFov = this._footFov;
    this.manualYaw = 0;
    this.manualPitch = 0;
    this.manualAge = 99;
    /* ---- view cycle (V) ---- */
    this.view = 0;
    /** Smoothed 0..1 "how first-person are we", so a cycle is a dolly. */
    this.nearBlend = 0;
    this._viewDist = 1;
    this._viewHeight = 1;
    this._viewLateral = 1;
    /** Timed transition, 0..1. See VIEW_TIME. */
    this._viewT = 1;
    this._viewDur = VIEW_TIME.min;
    this._viewFrom = { dist: 1, height: 1, lateral: 1, near: 0 };
    this._bonnet = new THREE.Vector3();

    this._chasePos = new THREE.Vector3();
    this._chaseQuat = new THREE.Quaternion();
    this._footPos = new THREE.Vector3();
    this._footQuat = new THREE.Quaternion();
    this._vehPos = new THREE.Vector3();
    this._vehVel = new THREE.Vector3();
    this._vehFwd = new THREE.Vector3();
    this._vehRight = new THREE.Vector3();
    this._vehQuat = new THREE.Quaternion();

    /* ---- feel channels (unchanged public API) ---- */
    this.dip = new Spring(C.land.freq, C.land.damping, 0);
    this.step = new Spring(C.step.freq, C.step.damping, 0);
    this.recoilPitch = new RecoilAxis(C.recoil.freq, C.recoil.damping, C.recoil.residualTau, C.recoil.residualShare);
    this.recoilYaw = new RecoilAxis(C.recoil.freq * 1.08, C.recoil.damping + 0.06, C.recoil.residualTau, C.recoil.residualShare);
    this.recoilRoll = new RecoilAxis(C.recoil.freq * 0.86, C.recoil.damping + 0.1, C.recoil.residualTau, 0.24);
    this.punch = new Spring(C.recoil.punchFreq, C.recoil.punchDamping, 0);
    this.kickPitch = new RecoilAxis(11, 0.58, 0.22, 0.28);
    this.kickYaw = new RecoilAxis(11.5, 0.6, 0.22, 0.28);
    this.kickRoll = new RecoilAxis(9, 0.62, 0.22, 0.22);
    this.trauma = 0;
    this.shakeTime = 0;
    this.breathPhase = 0;
    this.strafeRoll = 0;
    this.turnRoll = 0;
    this.airRoll = 0;

    /* ---- fov ---- */
    this.baseFov = ctx.config.fov * CAMERA.fovScale;
    this.fov = this.baseFov;
    this.fovMove = 0;
    this.fovAim = 1;
    /** 0..1 filter of `movement.sprinting` — see the boom section of update(). */
    this.sprintCommit = 0;

    /* ---- outputs ---- */
    this.position = new THREE.Vector3();
    this.eyePosition = this.position; // legacy alias
    this.rotation = new THREE.Euler(0, 0, 0, 'YXZ');
    this.quaternion = new THREE.Quaternion();
    this.forward = new THREE.Vector3(0, 0, -1);
    this.viewKick = { pitch: 0, yaw: 0, roll: 0, punch: 0 };
    this.bobPhase = 0;
    this.eye = STANCE.stand.eye;

    /* ---- scratch ---- */
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');

    /* ---- framing class ---- */
    /** Resolved once per vehicle, never per frame — see `_resolveFrame`. */
    this.frameClass = 'car';
    this._frame = CHASE.classFrame.car;
    /** Live align rate, published for tools. NOT what any gate asserts on. */
    this.alignRate = 0;

    /* ---- the world shaking the camera ---- */
    this._offEvents = [];
    this._bindEvents(ctx);
  }

  /* ==================================================================== */
  /* the world shaking the camera                                         */
  /* ==================================================================== */

  /**
   * `police` has been emitting `camera:shake` on every scripted ram since it
   * was written, with a comment saying the player camera may not consume it
   * yet. `vehicles` has been emitting `vehicle:collision` for every impact in
   * the city. Nothing listened to either, so a crash produced sparks, a metal
   * transient, real damage and a real change of velocity — and a camera that
   * did not so much as flinch.
   *
   * Subscribing here rather than in `src/player/index.js` keeps the whole feel
   * model in one file and, more usefully, makes it testable without standing
   * up a PlayerSystem: `camtest.mjs` drives these with a four-line emitter.
   */
  _bindEvents(ctx) {
    const on = ctx?.events?.on;
    if (typeof on !== 'function') return;
    const sub = (type, fn) => {
      const off = ctx.events.on(type, fn);
      if (typeof off === 'function') this._offEvents.push(off);
    };
    sub('camera:shake', (e) => this._onShake(e));
    sub('vehicle:collision', (e) => this._onVehicleCollision(e));
  }

  dispose() {
    for (const off of this._offEvents) off();
    this._offEvents.length = 0;
  }

  /**
   * 1 at the impact, 0 far away. Distances are measured from the camera's own
   * last emitted position, not from the character — the camera is what is
   * being shaken, and in a car it is six metres behind him.
   */
  _proximity(p) {
    if (!p || !Number.isFinite(p.x)) return 1;
    const C = CAMERA.crash;
    const dx = p.x - this.position.x;
    const dy = p.y - this.position.y;
    const dz = p.z - this.position.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return 1 - clamp01((d - C.near) / Math.max(1e-4, C.far - C.near));
  }

  /** `camera:shake { amount, position }` — police's scripted cruiser ram. */
  _onShake(e) {
    const a = (e?.amount ?? 0) * CAMERA.crash.shakeScale;
    if (!(a > 0)) return;
    this.addTrauma(a * this._proximity(e.position));
  }

  /**
   * `vehicle:collision { vehicle, other, point, normal, impulse, speed }`.
   *
   * `other` is the thing that was hit. `vehicles` fills it from
   * `staticWorld.objectOf(tri)?.mesh` for a strike against the city and with
   * the other Vehicle for a car-to-car shunt — so "does it have a velocity and
   * a spec" is the discriminator, and it does not depend on agreeing a naming
   * convention with a subsystem being written in parallel.
   */
  _onVehicleCollision(e) {
    const v = e?.vehicle;
    if (!v) return;
    const C = CAMERA.crash;
    const mass = v.mass ?? v.spec?.mass ?? 1200;
    const dv = (e.impulse ?? 0) / Math.max(1, mass);
    const sev = clamp01((dv - C.dvMin) / Math.max(1e-4, C.dvFull - C.dvMin));
    if (sev <= 0) return;
    const mine = v === this.vehicle;
    // A car-to-car shunt is reported twice, once from each side. Without this
    // the player's own collision would be counted again as a bystander's.
    //
    // The `this.vehicle` guard is not decoration: `other` is null when a car
    // hits city geometry that has no mesh behind it, and on foot `this.vehicle`
    // is null too — so without it, `null === null` swallowed every building
    // crash the player was standing next to.
    if (!mine && this.vehicle && e.other === this.vehicle) return;
    const hitVehicle = !!(e.other && e.other.velocity && e.other.spec);
    const base = hitVehicle ? C.vehicle : C.building;
    const scale = mine ? 1 : C.remoteScale * this._proximity(e.point);
    if (!(scale > 0)) return;
    this.addTrauma(base * sev * scale);
  }

  /**
   * Which framing this vehicle wants. Resolved on `setVehicle`, never in
   * `update` — the tag test builds a string and hard rule 5 says nothing
   * allocates per frame.
   *
   * The bus and helicopter classes may not have landed in `vehicles` yet, so
   * this matches on anything it might plausibly publish rather than on one
   * field name agreed in advance, and anything unrecognised lands on `car` and
   * keeps exactly today's framing.
   */
  _resolveFrame(v) {
    this.frameClass = 'car';
    if (v) {
      const spec = v.spec ?? v.def ?? null;
      const explicit = v.cameraClass ?? spec?.cameraClass;
      if (explicit && CHASE.classFrame[explicit]) {
        this.frameClass = explicit;
      } else if (spec?.fly === true || spec?.air === true || v.fly === true) {
        this.frameClass = 'heli';
      } else {
        const tag = (`${spec?.kind ?? ''} ${spec?.class ?? ''} ${spec?.id ?? ''} ` +
          `${spec?.type ?? ''} ${v.type ?? ''}`).toLowerCase();
        if (/heli|chopper|rotor|aircraft/.test(tag)) this.frameClass = 'heli';
        else if (/bus|coach|transit/.test(tag)) this.frameClass = 'bus';
      }
    }
    this._frame = CHASE.classFrame[this.frameClass] ?? CHASE.classFrame.car;
    return this.frameClass;
  }

  /* ==================================================================== */
  /* control                                                              */
  /* ==================================================================== */

  reset(anchor = STANCE.stand.anchor, pos = null, yaw = null) {
    this.anchor = anchor;
    if (yaw !== null) {
      this.yaw = this.yawTarget = yaw;
      this.pitch = this.pitchTarget = CAMERA.orbit.restPitch;
    }
    if (pos) {
      this.pivotTarget.set(pos.x, pos.y + anchor, pos.z);
      this.pivot.copy(this.pivotTarget);
    }
    // The player's chosen view survives a teleport; its channels are snapped
    // rather than filtered, or every respawn would dolly from the default.
    const V = VIEWS[this.view];
    this.nearBlend = V.near;
    this._viewDist = V.dist;
    this._viewHeight = V.height;
    this._viewLateral = V.lateral;
    this._viewT = 1;
    this._viewDur = VIEW_TIME.min;
    const d0 = CAMERA.boom.distIdle * V.dist;
    this.distance = this.distIdeal = this.collideRadius = d0;
    // Seed the history, or a teleport inherits the previous location's minimum.
    this._freeRing?.fill(d0);
    this._chaseRing?.fill(CHASE.distBase * V.dist);
    this.chaseRadius = CHASE.distBase * V.dist;
    this.height = CAMERA.boom.heightIdle * V.height;
    this.lateral = CAMERA.boom.lateralIdle * V.lateral;
    this.dip.reset(0);
    this.step.reset(0);
    this.recoilPitch.reset();
    this.recoilYaw.reset();
    this.recoilRoll.reset();
    this.kickPitch.reset();
    this.kickYaw.reset();
    this.kickRoll.reset();
    this.punch.reset(0);
    this.trauma = 0;
    this.strafeRoll = this.turnRoll = this.airRoll = 0;
    this.fovMove = 0;
    this.fovAim = 1;
    this.sprintCommit = 0;
    this.characterFade = 1;
    this.manualYaw = this.manualPitch = 0;
    this.vehicleBlend = this.vehicle ? 1 : 0;
  }

  /** Mouse / stick look. Deltas are already in radians. */
  addLook(dYaw, dPitch) {
    if (dYaw === 0 && dPitch === 0) {
      return;
    }
    this.lookIdle = 0;
    if (this.vehicle) {
      this.manualYaw = clamp(this.manualYaw + dYaw, -Math.PI, Math.PI);
      this.manualPitch = clamp(
        this.manualPitch + dPitch, CHASE.lookPitchMin, CHASE.lookPitchMax
      );
      this.manualAge = 0;
      return;
    }
    this.yawTarget += dYaw;
    if (this.yawTarget > Math.PI) this.yawTarget -= Math.PI * 2;
    else if (this.yawTarget < -Math.PI) this.yawTarget += Math.PI * 2;
    this.pitchTarget = clamp(this.pitchTarget + dPitch, CAMERA.orbit.pitchMin, this.pitchMax);
  }

  /* ==================================================================== */
  /* the view cycle                                                       */
  /* ==================================================================== */

  /** How far up this view is allowed to look. See VIEWS in tuning.js. */
  get pitchMax() {
    return VIEWS[this.view].pitchMax;
  }

  get viewSpec() {
    return VIEWS[this.view];
  }

  get viewId() {
    return VIEWS[this.view].id;
  }

  /** True once the fourth view has actually arrived, not merely been asked for. */
  get firstPerson() {
    return this.nearBlend > 0.72;
  }

  /** Snapshot where the channels are NOW and start a fresh timed ease. */
  _beginViewChange() {
    this._viewFrom.dist = this._viewDist;
    this._viewFrom.height = this._viewHeight;
    this._viewFrom.lateral = this._viewLateral;
    this._viewFrom.near = this.nearBlend;
    this._viewT = 0;
  }

  /** Time the ease by how far the boom actually has to travel. */
  _viewDuration(next) {
    const travel = Math.abs(next.dist - this._viewDist) * CAMERA.boom.distIdle;
    return clamp(
      VIEW_TIME.min + travel * VIEW_TIME.perMetre, VIEW_TIME.min, VIEW_TIME.max
    );
  }

  /** V. Advances the cycle and returns the new spec. */
  cycleView(dir = 1) {
    const next = VIEWS[(this.view + dir + VIEWS.length * 2) % VIEWS.length];
    this._viewDur = this._viewDuration(next);
    this._beginViewChange();
    this.view = (this.view + dir + VIEWS.length * 2) % VIEWS.length;
    // Coming back out of the fourth view must not leave the pitch stuck above
    // the third-person clamp, or the boom starts underneath the character.
    const pm = this.pitchMax;
    if (this.pitchTarget > pm) this.pitchTarget = pm;
    if (this.pitch > pm) this.pitch = pm;
    return VIEWS[this.view];
  }

  setView(idOrIndex) {
    const i = typeof idOrIndex === 'number'
      ? idOrIndex
      : VIEWS.findIndex((v) => v.id === idOrIndex);
    if (i < 0 || i >= VIEWS.length) return VIEWS[this.view];
    if (i !== this.view) {
      this._viewDur = this._viewDuration(VIEWS[i]);
      this._beginViewChange();
    }
    this.view = i;
    return VIEWS[this.view];
  }

  setVehicle(v) {
    if (v === this.vehicle) return;
    this.vehicle = v ?? null;
    this._resolveFrame(this.vehicle);
    if (this.vehicle) {
      this.manualYaw = this.manualPitch = 0;
      this.manualAge = 99;
    } else {
      // Hand the orbit back to the on-foot solver where the chase left it.
      this.yawTarget = this.yaw = this.chaseYaw;
      this.pitchTarget = this.pitch = clamp(
        this.chasePitch, CAMERA.orbit.pitchMin, CAMERA.orbit.pitchMax
      );
    }
  }

  /* ==================================================================== */
  /* impulses — public feel API (unchanged)                               */
  /* ==================================================================== */

  addRecoil(pitch = 0, yaw = 0, roll = 0, punch = 0) {
    this.recoilPitch.kick(pitch);
    this.recoilYaw.kick(yaw);
    this.recoilRoll.kick(roll);
    if (punch) this.punch.impulse(-punch * 14);
  }

  addKick(pitch = 0, yaw = 0, roll = 0) {
    this.kickPitch.kick(pitch);
    this.kickYaw.kick(yaw);
    this.kickRoll.kick(roll);
  }

  addTrauma(a) {
    this.trauma = clamp01(this.trauma + a);
  }

  onLand(speed) {
    const L = CAMERA.land;
    const t = clamp01((speed - L.minSpeed) / (L.fullSpeed - L.minSpeed));
    if (t <= 0) return 0;
    const mag = Math.pow(t, 0.72);
    this.dip.impulse(-L.dipImpulse * mag);
    this.recoilPitch.kick(L.pitch * mag);
    this.addTrauma(L.trauma * mag * mag);
    return mag;
  }

  onFootstep(running, stance) {
    const S = CAMERA.step;
    let amp = S.impulse * (running ? S.sprintScale : 1);
    if (stance === 'crouch') amp *= 0.55;
    this.step.impulse(-amp);
  }

  onSlideStart() {}

  /* ==================================================================== */
  /* frame                                                                */
  /* ==================================================================== */

  /**
   * @param dt
   * @param m       the Movement machine
   * @param health  { fraction, suppression }
   */
  update(dt, m, health) {
    this._stepSprings(dt);

    const blendTarget = this.vehicle ? 1 : 0;
    this.vehicleBlend = approach(this.vehicleBlend, blendTarget, CHASE.blendTau, dt);
    if (Math.abs(this.vehicleBlend - blendTarget) < 0.002) this.vehicleBlend = blendTarget;

    // Always solve the foot boom: it is the fallback, and it keeps the pivot
    // tracking the character during the enter/exit animation.
    this._solveFoot(dt, m, health);

    if (this.vehicle || this.vehicleBlend > 0) {
      this._solveChase(dt, m);
    }

    const b = this.vehicleBlend;
    if (b <= 0) {
      this.position.copy(this._footPos);
      this.quaternion.copy(this._footQuat);
      this.fov = this._footFov;
    } else if (b >= 1) {
      this.position.copy(this._chasePos);
      this.quaternion.copy(this._chaseQuat);
      this.fov = this._chaseFov;
    } else {
      const t = b * b * (3 - 2 * b);
      this.position.lerpVectors(this._footPos, this._chasePos, t);
      this.quaternion.copy(this._footQuat).slerp(this._chaseQuat, t);
      this.fov = lerp(this._footFov, this._chaseFov, t);
    }

    this.forward.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.rotation.setFromQuaternion(this.quaternion, 'YXZ');

    this.viewKick.pitch = this.recoilPitch.value + this.kickPitch.value;
    this.viewKick.yaw = this.recoilYaw.value + this.kickYaw.value;
    this.viewKick.roll = this.recoilRoll.value + this.kickRoll.value;
    this.viewKick.punch = this.punch.value;
  }

  _stepSprings(dt) {
    this.dip.step(dt);
    this.step.step(dt);
    this.punch.step(dt);
    this.recoilPitch.step(dt);
    this.recoilYaw.step(dt);
    this.recoilRoll.step(dt);
    this.kickPitch.step(dt);
    this.kickYaw.step(dt);
    this.kickRoll.step(dt);
    this.trauma = Math.max(0, this.trauma - CAMERA.shake.decay * dt);
    this.shakeTime += dt * CAMERA.shake.freq;
    this.breathPhase += dt;
    this.lookIdle += dt;
    this.manualAge += dt;

    // The view cycle is a timed ease between two parameter sets, never a cut.
    if (this._viewT < 1) {
      this._viewT = Math.min(1, this._viewT + dt / this._viewDur);
      const k = smootherstep(this._viewT);
      const V = VIEWS[this.view];
      const F = this._viewFrom;
      this._viewDist = lerp(F.dist, V.dist, k);
      this._viewHeight = lerp(F.height, V.height, k);
      this._viewLateral = lerp(F.lateral, V.lateral, k);
      this.nearBlend = lerp(F.near, V.near, k);
    }
  }

  /* -------------------------------------------------------------------- */

  _solveFoot(dt, m, health) {
    const C = CAMERA;
    const O = C.orbit;
    const B = C.boom;
    const phys = this.ctx.peek('physics');

    /* ---- 1. pivot ---- */
    const base = m.sampleRender(this.ctx.time.alpha);
    const crouch = clamp01(m.crouchBlend ?? 0);
    this.eye = lerp(STANCE.stand.eye, STANCE.crouch.eye, crouch);
    // The fourth view walks the pivot from the base of the neck up to the eyes.
    this.anchor = lerp(
      lerp(STANCE.stand.anchor, STANCE.crouch.anchor, crouch),
      this.eye,
      this.nearBlend
    ) * (m.bodyScale ?? 1);
    this.pivotTarget.set(base.x, base.y + this.anchor, base.z);

    const tauY = m.grounded ? C.follow.tauY : C.follow.tauYAir;
    this.pivot.x = approach(this.pivot.x, this.pivotTarget.x, C.follow.tauXZ, dt);
    this.pivot.z = approach(this.pivot.z, this.pivotTarget.z, C.follow.tauXZ, dt);
    this.pivot.y = approach(this.pivot.y, this.pivotTarget.y, tauY, dt);
    // Hard leash so a teleport or a long fall can never strand the pivot.
    this._tmp.subVectors(this.pivotTarget, this.pivot);
    const lag = this._tmp.length();
    if (lag > C.follow.maxLag) {
      this.pivot.addScaledVector(this._tmp, 1 - C.follow.maxLag / lag);
    }

    /* ---- 2. orbit ---- */
    // Auto-centre: only when moving fast, only after the player has let go of
    // the look, and gently enough that it never fights an active input.
    const speed = m.horizontalSpeed;
    if (
      speed > O.autoSpeed && this.lookIdle > O.autoDelay &&
      (m.aiming !== true) && m.grounded
    ) {
      const behind = m.faceYaw;
      const d = angleDelta(this.yawTarget, behind);
      const k = 1 - Math.exp(-dt / O.autoTau);
      this.yawTarget += d * k * clamp01((speed - O.autoSpeed) / 3);
      const dp = angleDelta(this.pitchTarget, O.restPitch);
      this.pitchTarget += dp * k * 0.5;
    }
    // Leaving the fourth view narrows the pitch range under an already-tilted
    // target; ease rather than snap so the change is still a continuous move.
    if (this.pitchTarget > this.pitchMax) {
      this.pitchTarget = approach(this.pitchTarget, this.pitchMax, 0.08, dt);
    }

    const ky = 1 - Math.exp(-dt / O.tau);
    this.yawRate = angleDelta(this.yaw, this.yawTarget) * ky / Math.max(1e-4, dt);
    this.yaw += angleDelta(this.yaw, this.yawTarget) * ky;
    this.pitch += (this.pitchTarget - this.pitch) * ky;
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

    /* ---- 3. boom ---- */
    const aim = clamp01(m.adsAmount ?? 0);
    /**
     * Normalise against the CAST's top speed (DESIGN.md's fastest brother), not
     * against `MOVE.sprintSpeed`. Dividing by 6.9 clamped Dylan's 7.9 m/s sprint
     * to the same 1.0 as Aidan's 6.9, so the fastest brother in the game was
     * framed exactly like the middle one and his last metre per second bought
     * nothing. See `TOP_RUN_SPEED` for why per-brother normalisation is worse
     * still. Boom distance, boom height and FOV all hang off this one number,
     * so it is most of what makes the three feel different to move.
     */
    const speedT = clamp01(speed / TOP_RUN_SPEED);
    const vaulting = m.mantleMotion?.active ? 1 : 0;

    /**
     * ...and commit on the STATE, not only on the speed. Sprint has to be
     * legible the instant it engages: speed alone ramps the boom in over the
     * 0.24 s filter AND over the acceleration, so the player gets no immediate
     * confirmation that Shift did anything. `sprintT` adds a small, separate
     * push that keys off `m.sprinting` directly.
     */
    this.sprintCommit = approach(this.sprintCommit, m.sprinting ? 1 : 0, 0.12, dt);
    const sprintT = this.sprintCommit;

    let wantDist = lerp(B.distIdle, B.distSprint, speedT * speedT) + sprintT * B.distSprintCommit;
    wantDist += crouch * B.distCrouch + vaulting * B.distVault;
    let wantHeight = lerp(B.heightIdle, B.heightSprint, speedT);
    let wantLateral = B.lateralIdle;
    if (aim > 0) {
      wantDist = lerp(wantDist, B.distAim, aim);
      wantHeight = lerp(wantHeight, B.heightAim, aim);
      wantLateral = lerp(wantLateral, B.lateralAim * this.shoulderBlend, aim);
    }
    // The view cycle scales what the solver already asked for.
    wantDist *= this._viewDist;
    wantHeight *= this._viewHeight;
    wantLateral *= this._viewLateral;
    this.shoulderBlend = approach(this.shoulderBlend, this.shoulder, B.swapTau, dt);

    const viewing = this._viewT < 1;
    const tau = viewing ? B.viewTau : (aim > 0.02 ? B.aimTau : B.tau);
    this.distIdeal = approach(this.distIdeal, wantDist, tau, dt);
    this.height = approach(this.height, wantHeight, tau, dt);
    this.lateral = approach(this.lateral, wantLateral, tau, dt);

    /* ---- 4. basis ---- */
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    this._fwd.set(-sy * cp, sp, -cy * cp);
    this._right.set(cy, 0, -sy);
    this._up.crossVectors(this._right, this._fwd);

    /* ---- 5. collision ---- */
    this._dir.set(0, 0, 0)
      .addScaledVector(this._fwd, -1)
      .addScaledVector(this._right, this.lateral / Math.max(0.2, this.distIdeal))
      .addScaledVector(this._up, this.height / Math.max(0.2, this.distIdeal));
    const dirLen = this._dir.length() || 1;
    this._dir.multiplyScalar(1 / dirLen);
    const wantRadius = this.distIdeal * dirLen;

    let free = wantRadius;
    if (phys) {
      const hit = phys.sphereCast(
        this.pivot, this._dir, C.collide.radius, wantRadius, phys.MASK.WORLD
      );
      // NEVER clamp UP to a minimum distance here. Doing that — the obvious way
      // to keep the camera off the character — shoves it straight THROUGH any
      // blocker closer than the minimum, which is precisely what happens under
      // a bridge, in a doorway, or against a low ceiling. Measured: 313 of 520
      // frames of the motion test had the camera inside static geometry. The
      // floor is a hard 12 cm so the near plane stays outside the blocker, and
      // the character is faded out instead.
      if (hit.hit) free = Math.max(0.12, hit.distance - C.collide.pad);
    }
    this._freeRing[this._freeCursor] = free;
    this._freeCursor = (this._freeCursor + 1) % this._freeRing.length;
    let held = this._freeRing[0];
    for (let i = 1; i < this._freeRing.length; i++) {
      if (this._freeRing[i] < held) held = this._freeRing[i];
    }
    /**
     * Asymmetric: pull in fast, push out slowly and only past the hysteresis
     * band. With the windowed minimum above, this is what kills alley jitter.
     *
     * The target is `min(free space, what the solver asked for)`, and it has to
     * be, because the obvious alternative — chase the free space and then hard
     * clamp to `wantRadius` afterwards — PINS the boom while `wantRadius` sweeps
     * down past it and then hands over to the clamp in one frame. That is a
     * velocity step from 0 to 11 m/s and the continuity meter reports it as
     * exactly what it is (measured 699 m/s^2 entering first person). It never
     * showed up before because no filtered channel used to move five metres in
     * half a second; the view cycle does.
     */
    /* During a view change the boom is moving metres under its OWN power, so
     * the eight-frame minimum — which exists to stop a stationary boom chasing
     * a sphere cast that flickers hit/miss against a wall — becomes a staircase
     * the filter has to climb, and the per-frame steps stop scaling with dt.
     * Use this frame's measurement instead; the 130 ms pull-in absorbs the
     * flicker the window was there to hide. */
    const target = Math.min(viewing ? free : held, wantRadius);
    if (target < this.collideRadius) {
      this.collideRadius = approach(
        this.collideRadius, target,
        viewing ? C.collide.tauInView : C.collide.tauIn, dt
      );
    } else if (target > this.collideRadius + C.collide.hysteresis) {
      this.collideRadius = approach(
        this.collideRadius, target,
        viewing ? C.collide.tauInView : C.collide.tauOut, dt
      );
    }
    /* The boom may never exceed the request. This clamp has to be
     * UNCONDITIONAL: suspending it during a view change lets the filter lag two
     * metres behind, and the frame the change completes it re-engages and drops
     * the boom by all of it at once — measured 5143 m/s^2, a far worse spike
     * than the one suspending it was meant to avoid. It is safe precisely
     * because `wantRadius` is now C1 (a smootherstep through two first-order
     * lags), so on the shrink the clamp IS the smooth path. */
    this.collideRadius = Math.min(this.collideRadius, wantRadius);

    /* ---- 6. compose ---- */
    this._footPos.copy(this.pivot).addScaledVector(this._dir, this.collideRadius);

    // Feel offsets ride on top, in the view basis.
    const shake = this.trauma * this.trauma;
    let shakeX = 0, shakeY = 0, shakePitch = 0, shakeYaw = 0, shakeRoll = 0;
    if (shake > 1e-4) {
      const S = C.shake;
      shakePitch = hashNoise(this.shakeTime, 11) * shake * S.rot * DEG;
      shakeYaw = hashNoise(this.shakeTime + 31.7, 23) * shake * S.rot * DEG;
      shakeRoll = hashNoise(this.shakeTime + 57.1, 37) * shake * S.rot * 0.7 * DEG;
      shakeX = hashNoise(this.shakeTime * 0.8 + 13.3, 41) * shake * S.pos;
      shakeY = hashNoise(this.shakeTime * 0.8 + 71.9, 53) * shake * S.pos;
    }
    const vert = this.dip.value + this.step.value + shakeY;
    this._footPos.addScaledVector(this._up, vert);
    this._footPos.addScaledVector(this._right, shakeX);
    this._footPos.addScaledVector(this._fwd, this.punch.value);

    /* ---- 7. rotation ---- */
    const R = C.roll;
    const strafeTarget = -(m.moveX ?? 0) * R.strafe * (m.grounded ? 1 : 0.4);
    this.strafeRoll = approach(this.strafeRoll, strafeTarget, R.tau, dt);
    const turnTarget = clamp(this.yawRate * R.yawRate, -R.yawRateMax, R.yawRateMax);
    this.turnRoll = approach(this.turnRoll, turnTarget, R.tau * 1.5, dt);
    const airTarget = m.grounded ? 0 : clamp(-m.velocity.y * 0.02, -1, 1) * R.air;
    this.airRoll = approach(this.airRoll, airTarget, 0.22, dt);

    const Bf = C.breath;
    let amp = Bf.amp;
    amp *= lerp(1, Bf.adsScale, aim);
    amp *= lerp(1, Bf.lowHealthScale, 1 - clamp01(health?.fraction ?? 1));
    amp *= lerp(1, Bf.suppressionScale, clamp01(health?.suppression ?? 0));
    amp *= 1 - Bf.moveDamp * clamp01(speed / 2.2);
    const bA = Math.sin(this.breathPhase * Math.PI * 2 * Bf.freqA);
    const bB = Math.sin(this.breathPhase * Math.PI * 2 * Bf.freqB + 1.7);
    const breathPitch = (bA * 0.7 + bB * 0.3) * amp;
    const breathYaw = (bB * 0.75 - bA * 0.25) * amp * 1.15;

    const pitch = clamp(
      this.pitch + this.recoilPitch.value + this.kickPitch.value + breathPitch + shakePitch,
      -CAMERA.pitchLimit, CAMERA.pitchLimit
    );
    const yaw = this.yaw + this.recoilYaw.value + this.kickYaw.value + breathYaw + shakeYaw;
    const roll = this.strafeRoll + this.turnRoll + this.airRoll +
      this.recoilRoll.value + this.kickRoll.value + shakeRoll;
    this._e.set(pitch, yaw, roll);
    this._footQuat.setFromEuler(this._e);

    /* ---- 8. fov ---- */
    const F = C.fov;
    // First person wants the config FOV it was authored for, not the 62-degree
    // third-person value.
    this.baseFov = this.ctx.config.fov * lerp(C.fovScale, C.fovScaleNear, this.nearBlend);
    // Speed does most of it; the sprint state adds an immediate, separate kick
    // so pressing Shift is visible before the legs have caught up.
    let fovTarget = speedT * speedT * F.sprintGain + this.sprintCommit * F.sprintCommitGain;
    if (!m.grounded) fovTarget += F.airGain;
    this.fovMove = approach(this.fovMove, fovTarget, F.tau, dt);
    this.fovAim = approach(this.fovAim, lerp(1, F.aimScale, aim), F.aimTau, dt);
    this._footFov = (this.baseFov + this.fovMove) * this.fovAim;

    /* ---- 9. character fade ---- */
    const dist = this._footPos.distanceTo(this.pivotTarget);
    const fade = clamp01((dist - C.collide.fadeEnd) / (C.collide.fadeStart - C.collide.fadeEnd));
    this.characterFade = approach(this.characterFade, fade, 0.05, dt);

    this.bobPhase = m.stepPhase ?? 0;
  }

  /* -------------------------------------------------------------------- */

  /**
   * The vehicle chase camera. `this.vehicle` is whatever the vehicles system
   * handed us; we duck-type its transform so we do not depend on its internals.
   */
  _solveChase(dt, m) {
    const v = this.vehicle;
    const phys = this.ctx.peek('physics');
    if (!v) {
      this._chasePos.copy(this._footPos);
      this._chaseQuat.copy(this._footQuat);
      this._chaseFov = this._footFov;
      return;
    }

    /* ---- read the vehicle, tolerantly ---- */
    /**
     * `model.root` IS THE THING THAT GETS DRAWN, and it was missing from this
     * chain. A real `Vehicle` carries no `object3D`, `mesh` or `root` — it
     * exposes `model.root`, which `syncTransforms()` writes each frame with the
     * pose the renderer then draws (`lerpVectors(prevPosition, position,
     * alpha)`). MEASURED on a live Vehicle: object3D/mesh/root all undefined.
     *
     * So this fell through to `v.position`, the raw un-interpolated PHYSICS
     * pose, and the camera framed a car up to one fixed step (8.3 ms of travel,
     * 0.23 m at 100 km/h) ahead of the one on screen — by a margin that
     * oscillates with the interpolation alpha, i.e. a judder rather than an
     * offset. src/player/vehicle.js line 39 records the identical lookup
     * failing for the seat solve, which is why the driver did not ride the car.
     *
     * MEASURED before/after, on a uniform drive at dt = 1.5/120 s (the drawn car
     * in the emitted camera basis, camlagtest.mjs): the framing moved 0.034 m at
     * 54 km/h and 0.187 m at 108 km/h, and the cadence-locked judder in the
     * framing fell from 0.005196 / 0.010393 m to an exact 0.000000 at both
     * speeds. The bound is one fixed step of travel, v/120, NOT v*dt — at 34 fps
     * the same correction measures 0.025 m / 0.061 m, i.e. SMALLER than at
     * 80 fps. Anyone quoting a frame-proportional figure for this is quoting the
     * ordering bug (see `cameraUpdate` in index.js) rather than this one.
     *
     * THIS LINE ONLY WORKS FROM `player.cameraUpdate`. `model.root` is written
     * by `vehicles.update()`, which the registry runs AFTER `player.update()`,
     * so reading it from `update()` yields last frame's pose — 0.245 m / 0.373 m
     * adrift, worse than the bug this fixes. The two changes are one change.
     *
     * The `v.position` branch below is still the right fallback and is still
     * live: the offline rigs (src/player/camtest.mjs, drivetest.mjs) build a
     * Vehicle on a stub model whose `root` is null and never sync a scene graph
     * at all.
     */
    const obj = v.object3D ?? v.mesh ?? v.root ?? v.model?.root ?? null;
    if (obj) {
      obj.updateWorldMatrix(true, false);
      this._vehPos.setFromMatrixPosition(obj.matrixWorld);
      this._vehQuat.setFromRotationMatrix(obj.matrixWorld);
    } else if (v.position) {
      this._vehPos.copy(v.position);
      if (v.quaternion) this._vehQuat.copy(v.quaternion);
    } else {
      this._vehPos.copy(this.pivotTarget);
    }
    if (v.velocity) this._vehVel.copy(v.velocity);
    else this._vehVel.set(0, 0, 0);

    /**
     * A VEHICLE'S NOSE IS +Z. The camera's own basis is -Z (see the `_fwd`
     * built from `yaw` below, and `Object3D`), and this line was written in
     * that convention — so the chase camera solved for a yaw 180 degrees out
     * and parked itself in FRONT of the car, looking back at the windscreen.
     *
     * From in front the car reads as facing the wrong way — reverse looks like
     * the only direction that works: holding W drives the car AT the lens and
     * the world scrolls the wrong way, while S backs it away from the lens and
     * reads as driving off. The car was always doing the right thing
     * (`forwardSpeed` +5.9 m/s on W, measured).
     *
     * `src/vehicles/dynamics.js` takes `forwardSpeed` along +Z, `vehicles`'
     * own cockpit shot looks along +Z, and `tools/steercheck.mjs` confirms the
     * handedness empirically. +Z is not negotiable; this was.
     */
    this._vehFwd.set(0, 0, 1).applyQuaternion(this._vehQuat);
    this._vehRight.set(1, 0, 0).applyQuaternion(this._vehQuat);
    this._vehFwd.y = 0;
    if (this._vehFwd.lengthSq() < 1e-6) this._vehFwd.set(0, 0, 1);
    this._vehFwd.normalize();

    const vx = this._vehVel.x, vz = this._vehVel.z;
    const speed = Math.hypot(vx, vz);
    const forwardDot = vx * this._vehFwd.x + vz * this._vehFwd.z;
    const facingYaw = Math.atan2(-this._vehFwd.x, -this._vehFwd.z);

    /* ---- travel yaw: the whole point of a chase camera ---- */
    let travelYaw = facingYaw;
    if (speed > CHASE.travelMinSpeed && forwardDot > 0) {
      const tYaw = Math.atan2(-vx / speed, -vz / speed);
      // Blend toward pure travel with speed, so a slow crawl still frames the
      // nose and a power slide frames the direction the car is actually going.
      // A bonnet camera is bolted to the car, so it frames FACING: the point of
      // it is that a slide is read off the road going sideways past the wing,
      // which is exactly the information the chase view throws away.
      const wgt = CHASE.travelWeight * clamp01((speed - CHASE.travelMinSpeed) / 6)
        * (1 - this.nearBlend);
      travelYaw = facingYaw + angleDelta(facingYaw, tYaw) * wgt;
    }
    // How hard the direction is changing — loosen the follow through a slide,
    // and use the same rate for the centripetal roll below.
    const swing = angleDelta(this.chasePrevTravel, travelYaw) / Math.max(1e-4, dt);
    this.chasePrevTravel = travelYaw;
    const yawTau = lerp(CHASE.yawTau, CHASE.yawTauFast, clamp01(Math.abs(swing) / 2.6));
    const k = 1 - Math.exp(-dt / yawTau);
    this.chaseYaw += angleDelta(this.chaseYaw, travelYaw) * k;
    if (this.chaseYaw > Math.PI) this.chaseYaw -= Math.PI * 2;
    else if (this.chaseYaw < -Math.PI) this.chaseYaw += Math.PI * 2;

    /* ---- speed-proportional auto-align ----------------------------------- */
    /**
     * The player's look offset eases back behind the car at a rate that rises
     * with road speed, and at exactly zero while the look control is live.
     *
     * Two properties matter and they pull in opposite directions, which is why
     * a single time constant could never serve both: at 40 m/s the camera has
     * to come home in a few tenths or the player spends the whole chase
     * hand-steering it, and at walking pace it must barely move or it is
     * wrestling him for the view in a car park. A rate proportional to speed
     * serves both.
     *
     * `manualAge` is the time since the look control last produced a delta, so
     * `< suppress` means the stick is still live. The ramp after it is what
     * makes the resume gentle: without it, releasing the stick at speed hands
     * the camera a 0.44 s time constant on the same frame and reads as the game
     * snatching the view back.
     */
    const A = CHASE.align;
    let rate = 0;
    if (this.manualAge >= A.suppress) {
      rate = clamp(speed * A.perSpeed, A.floor, A.rateMax) *
        smootherstep(clamp01((this.manualAge - A.suppress) / A.ease));
    }
    this.alignRate = rate;
    if (rate > 0) {
      const ka = 1 - Math.exp(-rate * dt);
      this.manualYaw -= this.manualYaw * ka;
      this.manualPitch -= this.manualPitch * ka;
    }

    const speedT = clamp01(speed / CHASE.speedRef);
    /**
     * HOW BIG IS THIS THING. `spec.half` is the only dimension a real Vehicle
     * actually carries — `v.length`, `v.height` and `v.size` are all undefined
     * on every vehicle in the game, which the bonnet mount below already knew
     * (it reads `v.spec?.half`) and this did not.
     *
     * So `distSizeGain`, `heightSizeGain` and the boom lift have been reading
     * 4.5 m and 1.4 m for a 7.2 m truck and a 9.6 m bus since they were
     * written: every size term in the chase camera was inert and a pickup was
     * framed exactly like a hatchback. The duck-typed fields stay first so a
     * stand-in object can still override, but the spec is what answers.
     */
    const half = v.spec?.half;
    const size = v.length ?? v.size?.z ?? (half ? half.z * 2 : 4.5);
    const tall = v.height ?? v.size?.y ?? (half ? half.y * 2 : 1.4);

    /**
     * Per-state framing. `F` is the framing class for whatever is being framed
     * — see `CHASE.classFrame`. A class with its own framing does not also take
     * the per-metre length gain, or it would be paid for twice.
     */
    const F = this._frame;
    const sizeTerm = F.sizeGain ? Math.max(0, size - 4.5) * CHASE.distSizeGain : 0;

    const nb = this.nearBlend;
    this.chaseDist = approach(
      this.chaseDist,
      (F.dist + CHASE.distSpeedGain * speedT + sizeTerm) * this._viewDist,
      0.3, dt
    );
    this.chaseHeight = approach(
      this.chaseHeight,
      (lerp(CHASE.heightIdle, CHASE.heightFast, speedT) * F.height +
        Math.max(0, tall - 1.4) * 0.45) * this._viewHeight,
      0.35, dt
    );
    this.chasePitch = approach(
      this.chasePitch,
      lerp(lerp(CHASE.pitchBase, CHASE.pitchFast, speedT), CHASE.pitchBonnet, nb),
      CHASE.pitchTau, dt
    );

    /* ---- roll into the corner (centripetal a = v * dPsi/dt) ---- */
    const latAcc = clamp(speed * swing, -14, 14);
    this.chaseRoll = approach(
      this.chaseRoll,
      clamp(-latAcc * CHASE.roll, -CHASE.rollMax, CHASE.rollMax),
      CHASE.rollTau, dt
    );

    /* ---- pivot (its own, so a blend never fights the on-foot pivot) ---- */
    const px = this._vehPos.x, pz = this._vehPos.z;
    const py = this._vehPos.y + CHASE.heightBase + Math.max(0, tall - 1.4) * CHASE.heightSizeGain;
    this._tmp.set(px, py, pz);
    if (nb > 0.002) {
      // The bonnet: on the car's centreline, just above and behind the nose, so
      // the wings are in frame and the bodywork is not clipping the near plane.
      const half = v.spec?.half;
      const hz = half?.z ?? size * 0.5;
      const hy = half?.y ?? tall * 0.5;
      // +Z is the nose (see `_vehFwd` above) — this used to sit on the BOOT.
      this._bonnet.set(0, hy * CHASE.bonnetUp, hz * CHASE.bonnetFore)
        .applyQuaternion(this._vehQuat)
        .add(this._vehPos);
      this._tmp.lerp(this._bonnet, nb);
    }
    if (this.chasePivot.lengthSq() < 1e-8 || this.vehicleBlend < 0.02) this.chasePivot.copy(this._tmp);
    else this.chasePivot.lerp(this._tmp, 1 - Math.exp(-dt / CHASE.followTau));

    /* ---- basis + collision ---- */
    const yaw = this.chaseYaw + this.manualYaw;
    const pitch = clamp(this.chasePitch + this.manualPitch, -1.35, 1.0);
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const sp = Math.sin(pitch), cp = Math.cos(pitch);
    this._fwd.set(-sy * cp, sp, -cy * cp);
    this._right.set(cy, 0, -sy);
    this._up.crossVectors(this._right, this._fwd);

    this._dir.set(0, 0, 0)
      .addScaledVector(this._fwd, -1)
      .addScaledVector(this._up, this.chaseHeight / Math.max(0.5, this.chaseDist));
    const dirLen = this._dir.length() || 1;
    this._dir.multiplyScalar(1 / dirLen);
    const wantRadius = this.chaseDist * dirLen;

    let free = wantRadius;
    if (phys) {
      const hit = phys.sphereCast(
        this.chasePivot, this._dir, CHASE.collideRadius, wantRadius, phys.MASK.WORLD
      );
      if (hit.hit) free = Math.max(0.6, hit.distance - CAMERA.collide.pad);
    }
    this._chaseRing[this._chaseCursor] = free;
    this._chaseCursor = (this._chaseCursor + 1) % this._chaseRing.length;
    let held = this._chaseRing[0];
    for (let i = 1; i < this._chaseRing.length; i++) {
      if (this._chaseRing[i] < held) held = this._chaseRing[i];
    }
    if (held < this.chaseRadius) {
      this.chaseRadius = approach(this.chaseRadius, held, CAMERA.collide.tauIn, dt);
    } else if (held > this.chaseRadius + CAMERA.collide.hysteresis) {
      this.chaseRadius = approach(this.chaseRadius, held, CAMERA.collide.tauOut, dt);
    }
    this.chaseRadius = Math.min(this.chaseRadius, wantRadius);

    this._chasePos.copy(this.chasePivot).addScaledVector(this._dir, this.chaseRadius);

    /**
     * THE FEEL CHANNELS, composed the same way the foot boom composes them.
     *
     * This block used to take the positional shake and `recoilPitch`/
     * `recoilYaw`/`recoilRoll`/`kickPitch` only — no rotational shake, no
     * `kickYaw`, no `kickRoll`, no punch. The published `viewKick` moved on
     * every one of those, so an instrument reading `viewKick` saw a response
     * the emitted camera transform did not have; and a crash, which is the one
     * thing that happens almost exclusively while you are IN a car, arrived as
     * two millimetres of translation and nothing else.
     */
    const full = CHASE.fullKick;
    const shake = this.trauma * this.trauma * CHASE.shakeGain;
    let shakePitch = 0, shakeYaw = 0, shakeRoll = 0;
    if (shake > 1e-4) {
      const S = CAMERA.shake;
      this._chasePos.addScaledVector(this._right, hashNoise(this.shakeTime * 0.8 + 13.3, 41) * shake * S.pos);
      this._chasePos.addScaledVector(this._up, hashNoise(this.shakeTime * 0.8 + 71.9, 53) * shake * S.pos);
      if (full) {
        shakePitch = hashNoise(this.shakeTime, 11) * shake * S.rot * DEG;
        shakeYaw = hashNoise(this.shakeTime + 31.7, 23) * shake * S.rot * DEG;
        shakeRoll = hashNoise(this.shakeTime + 57.1, 37) * shake * S.rot * 0.7 * DEG;
      }
    }
    if (full) this._chasePos.addScaledVector(this._fwd, this.punch.value);

    this._e.set(
      clamp(
        pitch + this.recoilPitch.value + this.kickPitch.value + shakePitch,
        -CAMERA.pitchLimit, CAMERA.pitchLimit
      ),
      yaw + this.recoilYaw.value + (full ? this.kickYaw.value : 0) + shakeYaw,
      this.chaseRoll + this.recoilRoll.value + (full ? this.kickRoll.value : 0) + shakeRoll
    );
    this._chaseQuat.setFromEuler(this._e);

    this.baseFov = this.ctx.config.fov * CAMERA.fovScale;
    this.chaseFov = approach(this.chaseFov, speedT * speedT * CHASE.fovGain, CHASE.fovTau, dt);
    this._chaseFov = this.baseFov * CHASE.fovBase + this.chaseFov;
    this.characterFade = 1;
    void m;
  }

  /* ==================================================================== */

  /** Write the composed transform onto the engine camera. */
  applyTo(camera) {
    camera.position.copy(this.position);
    camera.quaternion.copy(this.quaternion);
    if (Math.abs(camera.fov - this.fov) > 1e-3) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    this.forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  }
}

export { UP };
