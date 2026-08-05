/**
 * Getting in and out of cars.
 *
 * `vehicles` owns the car; this file owns the ACTOR — where he stands, how he
 * reaches the handle, when the capsule leaves the world, and what the driving
 * input is forwarded as. Everything it reads off a vehicle is duck-typed, so
 * the subsystem can evolve its internals without breaking the player.
 *
 * The sequence, GTA-style:
 *
 *   PROMPT   nearest vehicle within reach and a free seat -> `ui` shows [F]
 *   OPEN     the actor steps to the door anchor and the near hand reaches the
 *            handle. Sprinting straight at a car skips this and dives in.
 *   JACK     if the seat is taken, the actor hauls the driver out first
 *   IN       the body is carried along a curve from the door to the seat while
 *            the capsule is disabled; the door shuts behind him
 *   DRIVE    input is forwarded to vehicles.setInput() and the body is pinned
 *            to the seat with hands on the wheel
 *   OUT      the reverse, ending with the capsule re-enabled beside the car
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FOUR THINGS THAT WERE WRONG AND ARE MEASURED NOW
 *
 * 1. THE CAR MOVES. Every anchor used to be resolved once, at the instant F was
 *    pressed. Against parked cars that is invisible; against the traffic the
 *    player actually meets, the actor walked to where the door WAS and got in
 *    through thin air fifteen metres behind a car that had driven off. Every
 *    anchor is now stored in VEHICLE-LOCAL space and re-composed from the car's
 *    live transform each frame, so the whole sequence tracks a car that is still
 *    rolling — which is what a carjack is.
 *
 * 2. NOTHING WAS EVER PULLED OUT. The jack phase called `vehicles.eject()`,
 *    which does not exist and never has, so "PULL OUT" played the animation and
 *    left the driver sitting in the car with the player on top of him. The
 *    driver is a PED: `peds.pullFromVehicle(vehicle, doorPoint)` is the call,
 *    and it also panics the street, which is the half of a carjack you see.
 *
 * 3. THE BODY DID NOT RIDE THE CAR. The live seat solve looked for
 *    `v.object3D ?? v.mesh ?? v.root`; a Vehicle exposes `model.root`, so the
 *    lookup returned null, the solve returned early, and the driver stayed
 *    parked at the seat position he had when the door shut.
 *
 * 4. THE EXIT WAS UNCONDITIONAL. It put you at the door anchor whatever was
 *    there — inside a wall, inside the next car in the queue, off the edge of a
 *    bridge. Five candidate spots are now capsule-tested in priority order and
 *    the first clear one wins; if every one is blocked you stay in the car,
 *    which is also what GTA does.
 *
 * 5. IT RODE THE WRONG CAR. Fixing (3) put the body on `v.position` — the
 *    PHYSICS pose — while the renderer draws the car interpolated between the
 *    last two fixed steps. MEASURED (`camlagtest` check 3, kinematic drive, the
 *    drawn body expressed in the DRAWN car's frame): the driver slid 0.1250 m
 *    at 54 km/h and 0.2500 m at 108 km/h, and because the interpolation alpha
 *    alternates it is a BEAT, not an offset — the head visibly swimming through
 *    the seat back at speed. Half of that was here (`_drawnPose`, below) and
 *    half was `movement.sampleRender` lerping the finished seat AGAIN by the
 *    fixed-step alpha; both are now measured separately and gated.
 */

import * as THREE from 'three';
import { clamp, clamp01, smoothstep, smootherstep, approach } from './springs.js';
import { GAIT, NITRO } from './tuning.js';

/** How far from the vehicle's BOX (not its origin) the prompt appears. */
const ENTER_REACH = 2.2;
/** Vehicles further than this from the player are not even considered. */
const SCAN_RADIUS = 14;

const PHASE = {
  none: 'none',
  open: 'open',
  jack: 'jack',
  in: 'in',
  drive: 'drive',
  out: 'out',
};

const T = {
  open: 0.46,
  jack: 0.85,
  in: 0.62,
  dive: 0.34,
  out: 0.7,
};

/** Above this the actor is thrown clear rather than stepping out. */
const BAIL_SPEED = 7.0;

export class VehicleHandler {
  constructor(ctx, player) {
    this.ctx = ctx;
    this.player = player;
    this.phase = PHASE.none;
    this.t = 0;
    this.duration = 0;
    this.vehicle = null;
    this.seat = 0;
    this.candidate = null;
    this.dive = false;
    this._jacked = false;

    this.doorPos = new THREE.Vector3();
    this.seatPos = new THREE.Vector3();
    this.exitPos = new THREE.Vector3();
    this.startPos = new THREE.Vector3();
    this.bodyPos = new THREE.Vector3();
    /** Anchors in VEHICLE-LOCAL space — the whole point of tracking a mover. */
    this.seatLocal = new THREE.Vector3();
    this.doorLocal = new THREE.Vector3();
    this.seatYaw = 0;
    this.doorYaw = 0;
    this.side = 1;
    this.door = 0;

    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.lateral = 0;
    this._prevVel = new THREE.Vector3();
    this._mv = { x: 0, y: 0 };

    /**
     * NITRO, 0..NITRO.max. The driver's bottle, not the car's — swapping cars
     * does not hand you a fresh tank, which is what makes it a resource. Stored
     * on the player state rather than per vehicle, so a pickup economy has one
     * place to top up.
     */
    this.nitro = NITRO.max;
    /** True on the frames the bottle is actually open. `ui` reads this. */
    this.nitroOn = false;

    this._input = { throttle: 0, brake: 0, steer: 0, handbrake: false, horn: false, boost: 0 };
    this._enterPayload = { vehicle: null, actor: player, seat: 0 };
    this._exitPayload = { vehicle: null, actor: player };
    this._jackPayload = { vehicle: null, actor: player, seat: 0, ped: null };
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._cap0 = new THREE.Vector3();
    this._cap1 = new THREE.Vector3();
    /** The DRAWN vehicle pose for this frame — see `_drawnPose`. */
    this._drawnPos = new THREE.Vector3();
    this._drawnQuat = new THREE.Quaternion();
    /**
     * NEGATIVE CONTROL, read by `src/player/camlagtest.mjs --control=seat` and
     * by nothing else: false composes the seat from the raw physics pose again,
     * which is the build that put the driver one fixed step off his seat.
     */
    this.debugSeatDrawnPose = true;
    /** Local-space exit candidates, filled in `_pickExit`. */
    this._exitTry = [];
    for (let i = 0; i < 6; i++) this._exitTry.push(new THREE.Vector3());
    /** What `ui` should offer, or null. */
    this.prompt = null;
    this._promptRec = { key: 'F', text: 'ENTER', sub: '' };
    /** Diagnostics the playtest harness reads. */
    this.stats = { enters: 0, jacks: 0, exits: 0, exitBlocked: 0, bails: 0 };
  }

  get active() {
    return this.phase !== PHASE.none;
  }

  /** True while the actor is in the seat (the seated pose is on). */
  get seated() {
    return this.phase === PHASE.drive || this.phase === PHASE.in;
  }

  get driving() {
    return this.phase === PHASE.drive;
  }

  get busy() {
    return this.phase === PHASE.open || this.phase === PHASE.jack ||
      this.phase === PHASE.in || this.phase === PHASE.out;
  }

  /* ==================================================================== */

  /** Called from PlayerSystem.update, before the camera solves. */
  update(dt, m) {
    const vehicles = this.ctx.peek('vehicles');
    if (this.phase === PHASE.none) {
      // The bottle refills on foot too, so walking to the next car is not dead
      // time. Only `_stepDrive` can ever open the valve.
      this._stepNitro(dt, false);
      this._scan(vehicles, m);
      return;
    }
    this.prompt = null;
    // A car that blew up, despawned or was streamed out under us is not a car.
    if (!this.vehicle || this.vehicle.destroyed) {
      if (this.phase === PHASE.drive || this.phase === PHASE.in) { this._forceOut(m); return; }
      if (!this.vehicle) { this.abort(m); return; }
    }
    this.t += dt;
    const u = this.duration > 0 ? clamp01(this.t / this.duration) : 1;

    switch (this.phase) {
      case PHASE.open: this._stepOpen(u, m); break;
      case PHASE.jack: this._stepJack(u, m); break;
      case PHASE.in: this._stepIn(u, m); break;
      case PHASE.drive: this._stepDrive(dt, m, vehicles); break;
      case PHASE.out: this._stepOut(u, m); break;
      default: break;
    }
  }

  /* ---- prompt ------------------------------------------------------- */

  /**
   * Distance from the player to the vehicle's oriented box, not to its origin.
   * A Millhand 6 is 7.2 m long: measuring to the origin means you can stand
   * against the cab door and be told there is no vehicle here.
   */
  _boxDistance(v, p) {
    const half = v?.spec?.half;
    if (!half) return this._v.copy(v.position).distanceTo(p) - 1.6;
    this._v.copy(p).sub(v.position);
    if (v.quaternion) this._v.applyQuaternion(this._q.copy(v.quaternion).invert());
    const dx = Math.max(0, Math.abs(this._v.x) - half.x);
    const dy = Math.max(0, Math.abs(this._v.y) - half.y);
    const dz = Math.max(0, Math.abs(this._v.z) - half.z);
    return Math.hypot(dx, dy * 0.5, dz);
  }

  _scan(vehicles, m) {
    this.prompt = null;
    this.candidate = null;
    if (!vehicles || typeof vehicles.nearest !== 'function') return;
    if (!m.grounded || m.swimming) return;
    const p = m.position;
    let best = null;
    let bestD = ENTER_REACH;
    try {
      // `nearest` sorts by origin distance, which is the wrong metric for a
      // truck, so widen the query and re-rank by box distance.
      const list = vehicles.vehicles;
      if (Array.isArray(list)) {
        for (let i = 0; i < list.length; i++) {
          const v = list[i];
          if (!v || v.destroyed || v._staged) continue;
          const dx = v.position.x - p.x, dz = v.position.z - p.z;
          if (dx * dx + dz * dz > SCAN_RADIUS * SCAN_RADIUS) continue;
          if (Math.abs(v.position.y - p.y) > 4) continue;
          const d = this._boxDistance(v, p);
          if (d < bestD) { bestD = d; best = v; }
        }
      } else {
        best = vehicles.nearest(p.x, p.y, p.z, ENTER_REACH + 2.4);
      }
    } catch {
      return;
    }
    if (!best) return;
    this.candidate = best;
    this._promptRec.text = this._occupied(best, 0) ? 'PULL OUT' : 'ENTER';
    this._promptRec.sub = best.spec?.name ?? best.name ?? best.type ?? '';
    this.prompt = this._promptRec;
  }

  /**
   * Is seat `seat` taken? A Vehicle carries `driver` (the actor at the wheel)
   * and `occupants` (a flat push-array, NOT indexed by seat — reading it as if
   * it were is what used to send the player round to the passenger door of a
   * car he had just been told to pull someone out of).
   */
  _occupied(v, seat) {
    if (!v) return false;
    if (seat === 0) {
      if (v.driver !== undefined && v.driver !== null) return v.driver !== this.player;
      const peds = this.ctx.peek('peds');
      if (peds?.driverOf) { try { if (peds.driverOf(v)) return true; } catch { /* stub */ } }
      // A moving traffic car is being DRIVEN — by a `Driver` object rather than
      // by a ped, because `traffic` only materialises a body when it abandons a
      // car. Reading only `v.driver` therefore said every car in the city was
      // empty, offered ENTER instead of PULL OUT, and let the player climb into
      // a car whose AI was still steering it.
      if (this._trafficDriver(v)) return true;
      return !!v.occupant;
    }
    const n = Array.isArray(v.occupants) ? v.occupants.length : 0;
    return n > seat;
  }

  /** The `traffic` Driver bound to this car, if it owns it. */
  _trafficDriver(v) {
    const traffic = this.ctx.peek('traffic');
    if (!v || !traffic || typeof traffic.driverOf !== 'function') return null;
    try { return traffic.driverOf(v); } catch { return null; }
  }

  /**
   * Take the car off `traffic`. Without this the AI keeps calling
   * `vehicles.setInput()` at 60 Hz on the car the player is sitting in and the
   * two controllers fight over the throttle for as long as you are in it —
   * `traffic.fixedUpdate` drives every entry in `drivers` unconditionally and
   * its `isPlayerVehicle` check is only wired to the horn.
   *
   * `abandon()` is the right public call rather than `recycle()`: it releases
   * the driver, hands a BODY to `peds` and has them dragged out at the kerb,
   * and leaves the car in the world. Which is to say it is already, exactly, a
   * carjack — `traffic` uses it when a driver flees a wreck.
   */
  _releaseTraffic(v) {
    const d = this._trafficDriver(v);
    if (!d) return false;
    const traffic = this.ctx.peek('traffic');
    try { traffic.abandon(d, this.ctx); return true; } catch { return false; }
  }

  /* ==================================================================== */
  /* transitions                                                          */
  /* ==================================================================== */

  /** @returns true if an enter actually started. */
  tryEnter(m) {
    if (this.phase !== PHASE.none) return false;
    const v = this.candidate;
    if (!v || v.destroyed) return false;
    this.vehicle = v;
    // The player always goes for the wheel. If somebody is in it, that is a
    // carjack, not a reason to ride shotgun.
    this.seat = 0;
    this._resolveAnchors(v, this.seat, m);
    this._composeAnchors(v, m.position.y);

    this.startPos.copy(m.position);
    const reach = this.startPos.distanceTo(this.doorPos);
    this.dive = m.horizontalSpeed > 4.2;
    // The handler owns the actor's transform for the whole sequence, not just
    // the seated part: the capsule comes out of the world right now.
    m.setDriving(true, m.position, m.faceYaw);
    if (this._occupied(v, this.seat)) {
      this.phase = PHASE.jack;
      this.duration = T.jack;
    } else {
      this.phase = PHASE.open;
      // Cover the ground at a believable rate rather than in a fixed time: a
      // dive-in from four metres is a lunge, from half a metre it is a step.
      this.duration = this.dive
        ? clamp(reach / 8.5, 0.14, 0.45)
        : clamp(reach / 2.6, 0.18, T.open);
    }
    this.t = 0;
    this._jacked = false;
    m.sprinting = false;
    return true;
  }

  tryExit(m) {
    if (this.phase !== PHASE.drive) return false;
    const v = this.vehicle;
    if (!this._pickExit(v, m)) {
      this.stats.exitBlocked++;
      return false;
    }
    this.phase = PHASE.out;
    const speed = v?.speed ?? Math.hypot(v?.velocity?.x ?? 0, v?.velocity?.z ?? 0);
    // Bailing out of a moving car is a tumble, not a step down.
    this._bail = speed > BAIL_SPEED;
    this.duration = this._bail ? 0.26 : T.out;
    this.t = 0;
    this.startPos.copy(this.seatPos);
    this.nitroOn = false;
    this._setInput(0, 0, 0, false);
    const vehicles = this.ctx.peek('vehicles');
    if (vehicles && v) { try { vehicles.setInput(v, this._input); } catch { /* stub */ } }
    return true;
  }

  /**
   * Where the actor stands, where he sits, and which side he came from. Every
   * anchor is converted into VEHICLE-LOCAL space so `_composeAnchors` can
   * rebuild it against the car's live transform every frame.
   *
   * `vehicles.seatAnchor()` is authoritative when it exists; otherwise the
   * anchors are derived from the spec's half extents. `seatAnchor` allocates,
   * so it is called exactly once per enter and never per frame.
   *
   * ──────────────────────────────────────────────────────────────────────────
   * THE ANCHOR IS THE DRIVER'S HEAD. THE ROOT IS HIS FEET.
   *
   * `seatAnchor` is a point ON THE BODY, not a place to stand: `vehicles` puts
   * its own cockpit camera there (`vehicles/index.js`, the 'cockpit' pose), so
   * it is head height. `setSeatTransform` writes the actor's ROOT, which the
   * animator uses as the feet (`anim/animator.js` sets `root.position` from it
   * and the bind skeleton stacks upward from there).
   *
   * Copying one into the other lifted the whole body by a head height. Measured
   * on a sedan: root 1.01 m over the road, crown 2.80 m, roof 1.40 m — the
   * player was standing a metre and a half clear of the roof, which is the
   * "sits on top of the car" in the report. Subtracting the SEATED head height
   * (`GAIT.seat`) puts the head where `vehicles` asked for it and the rest of
   * the body underneath it, in the cabin, for every class from the sports car
   * to the truck without this file knowing anything about either.
   */
  _resolveAnchors(v, seat, m) {
    const vehicles = this.ctx.peek('vehicles');
    let anchor = null;
    if (vehicles && typeof vehicles.seatAnchor === 'function') {
      try { anchor = vehicles.seatAnchor(v, seat); } catch { anchor = null; }
    }

    const half = v?.spec?.half;
    const halfW = half?.x ?? (v?.width ?? 2.0) * 0.5;
    const halfL = half?.z ?? (v?.length ?? 4.6) * 0.5;
    const halfH = half?.y ?? 0.7;

    if (anchor?.local) {
      this.seatLocal.copy(anchor.local);
      this.side = anchor.side ?? -1;
    } else {
      // Which side of the car is the player already on? (Only used when the
      // vehicle system cannot tell us; the driver's door wins for seat 0.)
      this._v.copy(m.position).sub(v.position);
      if (v.quaternion) this._v.applyQuaternion(this._q.copy(v.quaternion).invert());
      this.side = seat === 0 ? -1 : (this._v.x >= 0 ? 1 : -1);
      this.seatLocal.set(
        this.side * halfW * 0.46,
        (v?.seatHeight ?? 0.32),
        seat < 2 ? halfL * 0.12 : -halfL * 0.4
      );
    }
    // Head anchor -> body root. See the note above; `GAIT.seat` is the same
    // record `anim/animator.js` poses the seated body from, so the head lands
    // back exactly where `vehicles` put it.
    this.seatLocal.y -= GAIT.seat.headHeight * (m?.bodyScale ?? 1);

    /* DELIBERATELY THE PHYSICS POSE, unlike `_composeAnchors`. This is an
     * INVERSION of a world point `vehicles.seatAnchor` composed from
     * `v.position` / `v.quaternion`; inverting it with any other transform
     * bakes the difference into the local anchor and then applies it again
     * every frame. What comes out of here is vehicle-LOCAL and pose-free — the
     * drawn pose is applied to it later, in `_composeAnchors`. */
    if (anchor?.enter && v.quaternion) {
      this.doorLocal.copy(anchor.enter).sub(v.position)
        .applyQuaternion(this._q.copy(v.quaternion).invert());
    } else if (anchor?.door && v.quaternion) {
      this.doorLocal.copy(anchor.door).sub(v.position)
        .applyQuaternion(this._q.copy(v.quaternion).invert());
    } else {
      this.doorLocal.set(this.side * (halfW + 0.5), -halfH, this.seatLocal.z);
    }
    this._halfW = halfW;
    this._halfL = halfL;
    this._halfH = halfH;
  }

  /**
   * THE POSE THE CAR IS DRAWN AT THIS FRAME — not the one physics finalised.
   *
   * `v.position` / `v.quaternion` are the end of the last FIXED step. The
   * renderer draws `lerp(prevPosition, position, alpha)` (`Vehicle.syncTransforms`,
   * `vehicles/dynamics.js`), so a body seated on the physics pose rides a car
   * that is up to one whole fixed step ahead of the one on screen — and because
   * `alpha` oscillates with the step cadence, it is a BEAT rather than a
   * constant offset. MEASURED, `camlagtest` check 3, kinematic drive, the drawn
   * body expressed in the DRAWN car's own frame: with `movement.sampleRender`'s
   * half of the same bug already fixed, this one on its own slid the driver
   * **0.0625 m at 54 km/h and 0.1250 m at 108 km/h** fore/aft, every frame —
   * the driver's head visibly swimming through the seat back. Both halves
   * together were 0.1250 / 0.2500 m; the table is in `camlagtest`'s header.
   *
   * This is the same defect `camera.js` fixed for the framing, and it is fixed
   * the same way — read the DRAWN transform — but NOT by reading `model.root`.
   * `vehicles.update()` writes that, and the registry topo-sorts `player`
   * BEFORE `vehicles`, so from here `model.root` still holds LAST frame's pose:
   * `camlagtest` measured that arm of the camera fix at 0.245 m / 0.373 m
   * adrift, i.e. worse than the bug. Recomposing the same lerp from
   * `prevPosition` / `position` / `ctx.time.alpha` is byte-identical to what
   * `syncTransforms` is about to write and depends on no ordering at all, so it
   * is correct whether `vehicles` has run yet or not.
   *
   * Falls back to the physics pose on anything that does not carry the previous
   * step (a stub in a harness, a vehicle mid-spawn) — which is exactly today's
   * behaviour, so nothing that works now can start throwing.
   */
  _drawnPose(v) {
    const p = this._drawnPos, q = this._drawnQuat;
    const alpha = this.ctx.time?.alpha;
    if (
      this.debugSeatDrawnPose === false || !Number.isFinite(alpha) ||
      !v.prevPosition || !v.prevQuaternion || !v.quaternion
    ) {
      p.copy(v.position);
      if (v.quaternion) q.copy(v.quaternion); else q.identity();
      return;
    }
    p.lerpVectors(v.prevPosition, v.position, alpha);
    q.copy(v.prevQuaternion).slerp(v.quaternion, alpha);
  }

  /** Rebuild the world anchors from the car's DRAWN transform. No allocation. */
  _composeAnchors(v, feetY) {
    if (!v) return;
    this._drawnPose(v);
    const q = this._drawnQuat;
    const at = this._drawnPos;
    this.seatPos.copy(this.seatLocal);
    this.seatPos.applyQuaternion(q);
    this.seatPos.add(at);

    this._v.copy(this.doorLocal);
    this._v.applyQuaternion(q);
    this._v.add(at);
    this.doorPos.set(this._v.x, this._v.y, this._v.z);
    const phys = this.ctx.peek('physics');
    if (phys) {
      const g = phys.groundHeight(this.doorPos.x, this.doorPos.z, this.doorPos.y + 2.4);
      if (Number.isFinite(g)) this.doorPos.y = g + 0.02;
      else if (feetY !== undefined) this.doorPos.y = feetY;
    }

    /**
     * TWO DIFFERENT YAW CONVENTIONS MEET HERE, and taking the car's without
     * converting it seats the driver facing out of the back window.
     *
     *   a vehicle's nose is +Z          -> heading H points along ( sinH,  cosH)
     *   the actor's `faceYaw` is -Z     -> facing F points along (-sinF, -cosF)
     *      (`anim/animator.js` builds the body's forward as (-sin, 0, -cos);
     *       so does `index.js._buildPose` and `_pickExit` below)
     *
     * Equal numbers therefore mean OPPOSITE directions: `seatYaw = heading` put
     * the body at exactly 180 degrees to the car, which is measured, not
     * inferred — `drivetest.mjs` read 179.99 deg before this line was fixed.
     */
    const heading =
      Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    this.seatYaw = heading + Math.PI;
    if (this.seatYaw > Math.PI) this.seatYaw -= Math.PI * 2;
    // Face the car while opening the door.
    this.doorYaw = Math.atan2(
      -(at.x - this.doorPos.x), -(at.z - this.doorPos.z)
    );
  }

  /* ==================================================================== */
  /* phases                                                               */
  /* ==================================================================== */

  _stepOpen(u, m) {
    this._composeAnchors(this.vehicle, m.position.y);
    // Walk (or dive) the last stride to the handle, turning to face the door.
    const e = this.dive ? smootherstep(u) : smoothstep(u);
    this.bodyPos.lerpVectors(this.startPos, this.doorPos, e);
    if (this.dive) this.bodyPos.y += Math.sin(e * Math.PI) * 0.1;
    m.setSeatTransform(this.bodyPos, this._turnTo(m.faceYaw, this.doorYaw, e));
    this.door = e; // 0..1 door swing, read by `vehicles` if it wants it
    this._pushDoor(u);
    if (u >= 1) {
      this.phase = PHASE.in;
      this.duration = this.dive ? T.dive * 1.2 : T.in;
      this.t = 0;
      this.startPos.copy(this.doorPos);
    }
  }

  _stepJack(u, m) {
    this._composeAnchors(this.vehicle, m.position.y);
    const e = smoothstep(clamp01(u / 0.45));
    this.bodyPos.lerpVectors(this.startPos, this.doorPos, e);
    m.setSeatTransform(this.bodyPos, this._turnTo(m.faceYaw, this.doorYaw, e));
    this._pushDoor(clamp01(u / 0.3));
    if (u > 0.42 && !this._jacked) {
      this._jacked = true;
      this._haulOut();
    }
    if (u >= 1) {
      this.phase = PHASE.in;
      this.duration = T.in;
      this.t = 0;
      this.startPos.copy(this.doorPos);
    }
  }

  /**
   * The actual carjack. `peds` owns the driver, so `peds` takes him out of the
   * car and leaves him on the road; `vehicles` is told the seat is free.
   */
  _haulOut() {
    const v = this.vehicle;
    const peds = this.ctx.peek('peds');
    const vehicles = this.ctx.peek('vehicles');
    // `traffic` first: it owns the AI driver, and abandoning gives `peds` a
    // body to drag out, so the two halves of a carjack happen in one call.
    const hadTraffic = this._releaseTraffic(v);
    let ped = null;
    if (peds?.pullFromVehicle) {
      try { ped = peds.pullFromVehicle(v, this.doorPos); } catch { ped = null; }
    }
    if (hadTraffic && !ped) {
      // `traffic.abandon` already ejected him; count it as the jack it is.
      ped = peds?.driverOf?.(v) ?? null;
      this._jacked = true;
    }
    if (!ped && v?.driver && vehicles?.clearDriver) {
      // Not a ped (a `traffic` driver, a stub): just take the wheel off them.
      // `police` books a carjack off the ped's own `vehicle:exit`, so only the
      // non-ped case has to be reported by hand or it would double-count.
      const driver = v.driver;
      try { vehicles.clearDriver(v, driver); } catch { /* stub */ }
      const police = this.ctx.peek('police');
      try { police?.reportCrime?.('carjack', this.doorPos, 1); } catch { /* stub */ }
    }
    // Legacy hook, kept because it costs nothing and a future `vehicles` may
    // want to animate the door and the body itself.
    try { vehicles?.eject?.(v, this.seat, 'jack'); } catch { /* not implemented */ }
    if (ped || hadTraffic) this.stats.jacks++;
    this._jackPayload.vehicle = v;
    this._jackPayload.seat = this.seat;
    this._jackPayload.ped = ped;
    this.ctx.events.emit('vehicle:jack', this._jackPayload);
  }

  _stepIn(u, m) {
    this._composeAnchors(this.vehicle, m.position.y);
    // Rise into the seat on an arc — hips up over the sill, then across.
    const e = smootherstep(u);
    this.bodyPos.lerpVectors(this.startPos, this.seatPos, e);
    this.bodyPos.y += Math.sin(e * Math.PI) * 0.13;
    m.setSeatTransform(this.bodyPos, this._turnTo(this.doorYaw, this.seatYaw, e));
    this._pushDoor(1 - smoothstep(clamp01((u - 0.45) / 0.55)));
    if (u >= 1) {
      this.phase = PHASE.drive;
      this.t = 0;
      this.stats.enters++;
      const vehicles = this.ctx.peek('vehicles');
      this._enterPayload.vehicle = this.vehicle;
      this._enterPayload.seat = this.seat;
      // `setDriver` starts the engine, marks the tank as the player's (so fuel
      // burns) and raises `vehicle:enter` itself — do not double-emit.
      // Belt and braces: a car entered without a jack (parked, or one the AI
      // picked up mid-sequence) must still come off the AI's books.
      this._releaseTraffic(this.vehicle);
      let claimed = false;
      if (vehicles?.setDriver) {
        try { vehicles.setDriver(this.vehicle, this.player, this.seat); claimed = true; }
        catch { claimed = false; }
      }
      if (!claimed) this.ctx.events.emit('vehicle:enter', this._enterPayload);
    }
  }

  _stepDrive(dt, m, vehicles) {
    const v = this.vehicle;
    if (!v) { this._forceOut(m); return; }

    // Pin the body to the seat — from the LIVE transform, so it rides the
    // suspension instead of staying where the door shut.
    this._composeAnchors(v, m.position.y);
    m.setSeatTransform(this.seatPos, this.seatYaw);

    const input = this.ctx.input;
    if (this.player.controlEnabled && input && !this.player.health.dead) {
      /**
       * `m.scriptedInput` is how the harness holds a control without
       * synthesising key events, and `Movement.latchInput` has honoured it for
       * years — but this path read `ctx.input` only, so a scripted `{y: 1}`
       * moved a character on foot and did NOTHING once he was behind a wheel.
       * `playtest.mjs --script=car` therefore reported on a car that was
       * coasting, which is half of why a car that would not drive survived a
       * green harness.
       */
      const s = m.scriptedInput;
      const mv = this._mv;
      if (s) { mv.x = s.x ?? 0; mv.y = s.y ?? 0; }
      else input.moveVector(mv);
      const throttle = Math.max(0, mv.y);
      const brake = Math.max(0, -mv.y);
      this.throttle = approach(this.throttle, throttle, 0.05, dt);
      this.brake = approach(this.brake, brake, 0.04, dt);
      this.steer = approach(this.steer, mv.x, 0.07, dt);
      /**
       * NITRO on the SPRINT control. Shift runs on foot and boosts in a car —
       * one control, two contexts. No new key is needed and none is added:
       * `src/core/input.js` already has `sprint`.
       */
      const want = s ? !!s.boost : input.action('sprint');
      /**
       * FLIGHT KINDS TAKE THE SPRINT CHANNEL RAW, NOT THROUGH THE BOTTLE.
       *
       * `plane.js` reads `input.boost` as the THROTTLE LEVER (Shift winds it up)
       * and `heli.js` reads it as DESCENT. The nitro bottle is a car mechanic —
       * it only opens above a throttle pedal (`throttle > minThrottle`) and
       * drains in 3.6 s — and on an aircraft the "throttle pedal" is the
       * ELEVATOR (`this.throttle` = stick-forward = nose down). MEASURED on the
       * real key path: holding Shift in a Skylark delivered `input.boost 0` for
       * ten seconds — the bottle never opened because no forward stick was held —
       * so the lever stayed at 0 and the aeroplane never rolled. That is the
       * "airplane does not take off or move" report, and it is the same defect
       * heli.js's header flagged as `player/vehicle.js`'s to remove (which left
       * the helicopter unable to DESCEND on Shift). Forward the sprint press
       * straight through for a flying machine; the car path is untouched.
       */
      const flying = v.spec?.kind === 'plane' || v.spec?.kind === 'heli';
      this._stepNitro(dt, flying ? false : want);
      this._setInput(
        this.throttle, this.brake, this.steer,
        // Space is the handbrake in a car — the same key the harness scripts
        // as `jump`, which is what it is on foot.
        s ? !!s.jump : input.action('jump'),
        s ? !!s.horn : input.action('horn'),
        flying ? (want ? 1 : 0) : (this.nitroOn ? 1 : 0)
      );
      if (vehicles && typeof vehicles.setInput === 'function') {
        try { vehicles.setInput(v, this._input); } catch { /* stub */ }
      }
    }

    // Lateral load for the lean-into-corners head pose.
    if (v.velocity) {
      this._v.copy(v.velocity).sub(this._prevVel);
      this._prevVel.copy(v.velocity);
      const right = this._v2.set(1, 0, 0);
      if (v.quaternion) right.applyQuaternion(v.quaternion);
      const a = dt > 1e-4 ? (this._v.x * right.x + this._v.z * right.z) / dt : 0;
      this.lateral = approach(this.lateral, clamp(a / 9, -1, 1), 0.14, dt);
    }
  }

  _stepOut(u, m) {
    // The exit target was chosen and validated at tryExit against the car's
    // pose THEN; a car that is still rolling drags it along, so re-compose.
    if (this.vehicle) {
      this._composeAnchors(this.vehicle, m.position.y);
      this._exitWorld(this.vehicle, this._exitLocal, this.exitPos);
    }
    const e = this._bail ? u : smoothstep(u);
    this.bodyPos.lerpVectors(this.startPos, this.exitPos, e);
    this.bodyPos.y += Math.sin(e * Math.PI) * (this._bail ? 0.22 : 0.1);
    m.setSeatTransform(this.bodyPos, this._turnTo(this.seatYaw, this.doorYaw, e));
    this._pushDoor(Math.sin(clamp01(u) * Math.PI));
    if (u >= 1) this._forceOut(m);
  }

  /* ==================================================================== */
  /* exit placement                                                       */
  /* ==================================================================== */

  _exitWorld(v, local, out) {
    // The DRAWN pose, for the same reason `_composeAnchors` uses it: the step
    // out is a body the player watches leave a car he can see.
    this._drawnPose(v);
    out.copy(local);
    out.applyQuaternion(this._drawnQuat);
    out.add(this._drawnPos);
    const phys = this.ctx.peek('physics');
    if (phys) {
      const g = phys.groundHeight(out.x, out.z, out.y + 3.0);
      if (Number.isFinite(g)) out.y = g + 0.03;
    }
    return out;
  }

  /**
   * Choose somewhere the player can actually stand. Candidates, in order:
   * the door he came in by, the far door, behind, in front, then the roof.
   * Each is capsule-tested against the static world; the first clear one wins.
   * Returns false when every one is blocked — in which case you stay in.
   */
  _pickExit(v, m) {
    if (!v) return false;
    const phys = this.ctx.peek('physics');
    const hw = this._halfW ?? 1.0;
    const hl = this._halfL ?? 2.3;
    const hh = this._halfH ?? 0.7;
    const z = this.doorLocal.z;
    const c = this._exitTry;
    c[0].set(this.side * (hw + 0.55), -hh, z);
    c[1].set(-this.side * (hw + 0.55), -hh, z);
    c[2].set(0, -hh, hl + 0.8);
    c[3].set(0, -hh, -(hl + 0.8));
    c[4].set(this.side * (hw + 1.35), -hh, z);
    c[5].set(0, hh + 0.1, 0); // the roof, so a wedged car is never a soft-lock

    const r = 0.32;
    const height = 1.78 * (m?.bodyScale ?? 1);
    for (let i = 0; i < c.length; i++) {
      this._exitWorld(v, c[i], this._v3);
      if (!phys) { this._exitLocal = c[i]; this.exitPos.copy(this._v3); return true; }
      this._cap0.set(this._v3.x, this._v3.y + r + 0.04, this._v3.z);
      this._cap1.set(this._v3.x, this._v3.y + Math.max(r + 0.05, height - r), this._v3.z);
      if (phys.checkCapsule(this._cap0, this._cap1, r * 0.94, phys.MASK.CHARACTER)) {
        this._exitLocal = c[i];
        this.exitPos.copy(this._v3);
        // Step out facing away from the car. `_exitWorld` has just left the
        // drawn pose in `_drawnPos`, and `exitPos` is expressed against it.
        this.doorYaw = Math.atan2(
          -(this.exitPos.x - this._drawnPos.x), -(this.exitPos.z - this._drawnPos.z)
        );
        return true;
      }
    }
    return false;
  }

  _forceOut(m) {
    const v = this.vehicle;
    const phys = this.ctx.peek('physics');
    if (v) this._exitWorld(v, this._exitLocal ?? this.doorLocal, this.exitPos);
    let y = this.exitPos.y;
    if (phys) {
      const g = phys.groundHeight(this.exitPos.x, this.exitPos.z, this.exitPos.y + 3.0);
      if (Number.isFinite(g)) y = g + 0.03;
    }
    m.setDriving(false);
    m.teleport(this.exitPos.x, y, this.exitPos.z, this.doorYaw);
    // Bailing out of a moving car carries the car's momentum into the tumble.
    if (this._bail && v?.velocity) {
      m.velocity.set(v.velocity.x * 0.55, 1.2, v.velocity.z * 0.55);
      m.grounded = false;
      m.beginStumble(1);
      this.stats.bails++;
    }
    this._bail = false;
    this.stats.exits++;

    const vehicles = this.ctx.peek('vehicles');
    let released = false;
    if (v && vehicles?.clearDriver) {
      // `clearDriver` raises `vehicle:exit` itself.
      try { vehicles.clearDriver(v, this.player); released = true; } catch { released = false; }
    }
    if (!released) {
      this._exitPayload.vehicle = v;
      this.ctx.events.emit('vehicle:exit', this._exitPayload);
    }
    this.phase = PHASE.none;
    this.vehicle = null;
    this.t = 0;
    this.steer = this.throttle = this.brake = this.lateral = 0;
    this._prevVel.set(0, 0, 0);
  }

  /* ==================================================================== */

  _turnTo(from, to, t) {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    else if (d < -Math.PI) d += Math.PI * 2;
    return from + d * t;
  }

  _pushDoor(open) {
    const vehicles = this.ctx.peek('vehicles');
    vehicles?.setDoor?.(this.vehicle, this.seat, clamp01(open));
  }

  /**
   * Burn or refill the bottle for this step, and decide whether it is open.
   *
   * Two gates: an empty tank does nothing, and boost off the throttle does
   * nothing — so it cannot be spent standing still or
   * used to shove a car that is braking. `cutoff` keeps the last drop from
   * stuttering the boost on and off frame by frame as the tank empties.
   */
  _stepNitro(dt, want) {
    const open = want && this.nitro > NITRO.cutoff && this.throttle > NITRO.minThrottle;
    this.nitro = clamp(
      this.nitro + (open ? -NITRO.drain : NITRO.charge) * dt,
      0, NITRO.max
    );
    this.nitroOn = open;
    return open;
  }

  /** 0..1, for the HUD gauge. */
  get nitroFraction() {
    return clamp01(this.nitro / NITRO.max);
  }

  _setInput(throttle, brake, steer, handbrake, horn, boost = 0) {
    this._input.throttle = throttle;
    this._input.brake = brake;
    this._input.steer = steer;
    this._input.handbrake = !!handbrake;
    this._input.horn = !!horn;
    this._input.boost = boost;
  }

  /** Drop out of any vehicle immediately (death, teleport, control loss). */
  abort(m) {
    if (this.phase === PHASE.none) return;
    const v = this.vehicle;
    const vehicles = this.ctx.peek('vehicles');
    let released = false;
    if (v && vehicles?.clearDriver) {
      try { vehicles.clearDriver(v, this.player); released = true; } catch { released = false; }
    }
    if (v && !released) {
      this._exitPayload.vehicle = v;
      this.ctx.events.emit('vehicle:exit', this._exitPayload);
    }
    this.phase = PHASE.none;
    this.vehicle = null;
    this.prompt = null;
    this._bail = false;
    this.steer = this.throttle = this.brake = this.lateral = 0;
    // The bottle keeps its charge across cars; only the valve shuts.
    this.nitroOn = false;
    this._input.boost = 0;
    m?.setDriving(false);
  }
}

export { PHASE };
