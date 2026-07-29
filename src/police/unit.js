/**
 * POLICE — one pursuit unit: a cruiser, its driver, and the officers in it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT THE TRAFFIC DRIVER
 * ────────────────────────────────────────────────────────────────────────────
 * `traffic/driver.js` is a very good LANE FOLLOWER. A pursuit driver has the
 * opposite problem: the lane is a suggestion and the quarry is the target. The
 * failure mode everyone recognises — a cruiser glued 20 m behind you, taking
 * your exact line, forever — comes from treating a chase as a follow. So:
 *
 *   · The path is a road-graph route with the racing line pulled toward the
 *     centreline (`path.js`), so junctions get clipped, not rounded.
 *   · Inside `TUNE` direct range with clear sight, the route is ABANDONED and
 *     the car drives at a lead-intercept point. That is what produces
 *     wrong-way driving, cutting a corner across a forecourt, and the shortcut
 *     through a junction — emergent, not scripted.
 *   · Roles come from `tactics.js`. Only ONE car is ever in the direct-follow
 *     slot; the others are told to flank, to intercept a junction AHEAD, to
 *     PIT, or to build a block. A queue of cars behind you is a bug here.
 *   · Every unit carries a separation term against every other unit, so they
 *     fan out instead of stacking into the same corner.
 *
 * The car is driven ONLY through `vehicles.setInput()`. It has the player's
 * tyre model, weight transfer and collision response — a cop that brakes late
 * really does dive on its nose and really does lock a wheel.
 *
 * PLANT CONVENTION (measured against src/vehicles/dynamics.js): body forward is
 * +Z, right-of-forward is (-fz, fx), and POSITIVE `input.steer` is a LEFT turn.
 */

import * as THREE from 'three';
import { RoutePath } from './path.js';
import { TUNE, clamp, clamp01, angDiff } from './tune.js';

export const ROLE = {
  RESPOND: 'respond',   // heading to the scene, no contact yet
  CHASE: 'chase',       // the direct-pursuit slot
  FLANK: 'flank',       // come alongside, on a parallel line
  PIT: 'pit',           // execute a PIT on the rear quarter
  INTERCEPT: 'intercept', // get to a junction ahead and hold it
  BLOCK: 'block',       // part of a roadblock: drive to a pose and park
  SEARCH: 'search',     // no contact: sweep the cordon
  LEAVE: 'leave',       // stand down, drive off, despawn
  /**
   * Not a police role. `debugChase()` binds a Unit to a civilian car and sets
   * this so the headless harness has a runner that drives the same road graph
   * with the same dynamics as the cars chasing it. Keeping it in this file
   * (rather than writing a second, simpler driver for the test) is deliberate:
   * a harness that exercises a different controller from the shipping one
   * proves nothing.
   */
  FLEE: 'flee',
};

const _fwd = new THREE.Vector3();
const _look = new THREE.Vector3();
const _goal = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _corner = { angle: 0, dist: 0 };

/** Seconds within which a second FLEE rescue counts as "the lane is the trap". */
const RESCUE_WINDOW = 12;

let _nextId = 1;

export class Unit {
  constructor(sys) {
    this.sys = sys;
    this.id = _nextId++;
    this.vehicle = null;
    this.active = false;
    this.role = ROLE.RESPOND;
    this.path = new RoutePath();
    this.officers = [];

    /* control */
    this._input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    this._steerCmd = 0;
    this._replan = 0;
    this._roadSpeed = 14;
    this._roadTimer = 0;
    this._spin = 0;
    this._spinCool = 0;
    this._headErr = 0;
    this._latPrev = 0;
    this._offRoad = false;
    this._stuckSteer = 0;
    this._yieldTimer = 0;

    /* separation + obstacles, recomputed at the control rate */
    this._sepX = 0;
    this._sepZ = 0;
    this._obGap = Infinity;
    this._obDv = 0;
    this._blockedT = 0;
    this._shove = 0;

    /* stuck */
    this._stuck = 0;
    this._stuckTotal = 0;
    this._reverse = 0;

    /* ram */
    this._ramT = 0;

    /* role state */
    this.slot = 0;
    this.pitSide = 1;
    this.holdPose = null;     // { x, z, yaw } for BLOCK / INTERCEPT
    /** Seconds parked on an intercept, and the cooldown after abandoning one. */
    this._holdT = 0;
    this._interceptCool = 0;
    /** Seconds of road-network discipline owed after an unstick. */
    this._directCool = 0;
    /** Unbroken seconds without moving, whatever the reason. */
    this._frozenT = 0;
    /** How many times this unit has been written off as wedged. */
    this._giveUps = 0;
    this.searchPt = new THREE.Vector3();
    this.hasSearchPt = false;
    this.deployed = false;
    this.blockId = -1;
    /** Refreshed by the system's sight pass — true when this unit can see the
     *  quarry right now. Drives both detection and the improvisation path. */
    this.los = false;
    this.losAge = 0;

    /* telemetry the harness asserts on */
    this.diag = {
      mode: 'path', targetSpeed: 0, dist: 0, lat: 0, reason: 'free', stuck: 0,
    };
    this._age = 0;
  }

  /* ==================================================================== */
  /* Lifecycle                                                            */
  /* ==================================================================== */

  bind(vehicle, role, opts = {}) {
    this.vehicle = vehicle;
    this.active = true;
    this.isPolice = opts.police !== false;
    this.role = role ?? ROLE.RESPOND;
    this.path.reset();
    this._steerCmd = 0;
    this._replan = 0;
    this._spin = 0;
    this._stuck = 0;
    this._stuckTotal = 0;
    this._reverse = 0;
    this._ramT = 1.5;   // never a ram on the spawn frame
    this._age = 0;
    this._holdT = 0;
    this._interceptCool = 0;
    this._directCool = 0;
    this._frozenT = 0;
    this._giveUps = 0;
    this.deployed = false;
    this.holdPose = null;
    this.hasSearchPt = false;
    this.blockId = -1;
    this.officers.length = 0;
    if (this.isPolice) {
      vehicle.lightbarOn = true;
      vehicle.isPolice = true;
    }
    return this;
  }

  release() {
    this.active = false;
    this.vehicle = null;
    this.officers.length = 0;
    this.path.reset();
    this.holdPose = null;
  }

  get position() {
    return this.vehicle?.position ?? _tmp.set(0, 0, 0);
  }

  get speed() {
    return this.vehicle?.forwardSpeed ?? 0;
  }

  /** Yaw of the body, radians, matching the +Z-forward convention. */
  get yaw() {
    const q = this.vehicle?.quaternion;
    if (!q) return 0;
    return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
  }

  /* ==================================================================== */
  /* Frame                                                                */
  /* ==================================================================== */

  update(dt, ctx) {
    const v = this.vehicle;
    if (!v || !this.active) return;
    this._age += dt;

    if (v.destroyed) {
      this._park(true);
      this.sys.onUnitLost(this, 'destroyed');
      return;
    }

    /* ---- clear a path through civilian traffic ------------------------ */
    this._yieldTimer -= dt;
    if (this._yieldTimer <= 0) {
      this._yieldTimer = 1 / TUNE.yieldHz;
      const traffic = this.sys.traffic;
      if (traffic?.yieldFor) {
        const r = TUNE.yieldRadius[this.sys.level] ?? 48;
        try { traffic.yieldFor(v, r); } catch { /* partner subsystem */ }
      }
    }

    /* ---- what are we driving at this tick? ---------------------------- */
    const mode = this._chooseGoal(dt, ctx, _goal);
    this.diag.mode = mode;

    if (mode === 'hold') {
      // Parked on purpose: the immobility timer in `_stuckCheck` must not
      // count a roadblock standing where it was told to stand.
      this._frozenT = 0;
      this._holdPose(dt);
      return;
    }

    /* ---- plan / replan ------------------------------------------------ */
    this._replan -= dt;
    const drifted =
      !this.path.valid ||
      Math.hypot(this.path.goalX - _goal.x, this.path.goalZ - _goal.z) > 26;
    if (mode === 'direct') {
      // No planning at all: this is the improvisation path.
      this.path.planDirect(v.position.x, v.position.z, _goal.x, _goal.z);
    } else if (this._replan <= 0 || drifted) {
      this._replan = this.role === ROLE.SEARCH ? 2.2 : 1.15;
      const qq = v.quaternion;
      this.path.plan(this.sys.roads, v.position.x, v.position.z, _goal.x, _goal.z, {
        cut: this._cut(),
        hx: 2 * (qq.x * qq.z + qq.w * qq.y),
        hz: 1 - 2 * (qq.x * qq.x + qq.y * qq.y),
      });
    }

    this.path.advance(v.position.x, v.position.z);

    /* ---- sense -------------------------------------------------------- */
    this._separation();
    this._obstacles(dt);
    this._sampleRoadSpeed(dt);

    /* ---- act ---------------------------------------------------------- */
    const steer = this._lateral(dt, v);
    this._longitudinal(dt, v);
    this._input.steer = steer;
    this.sys.vehicles.setInput(v, this._input);

    this._stuckCheck(dt, v);
    this._ram(dt);

    this.diag.lat = this.path.crossTrack(v.position.x, v.position.z);
    this.diag.stuck = this._stuckTotal;
  }

  /**
   * The scripted ram: a cruiser in contact with the
   * quarry's vehicle delivers a metered hit on a cooldown — damage, a speed
   * cut, sparks and camera shake — on TOP of whatever the collision solver
   * does with the momentum. Gated on the cruiser actually driving at the
   * target (closing, or rolling through it): a parked roadblock car the
   * quarry piles into is physics' business, not a ram, and a cruiser boxed
   * in next to a stopped player must not grind their car down by touching it.
   */
  _ram(dt) {
    this._ramT -= dt;
    if (this._ramT > 0) return;
    const sys = this.sys;
    if (!this.isPolice || !sys.ramEnabled || this.role === ROLE.LEAVE) return;
    const q = sys.quarry;
    if (!q.valid || !q.inVehicle || !q.vehicle || q.vehicle.destroyed) return;
    const v = this.vehicle;
    // A unit does not necessarily HAVE a cruiser. Foot responders spawned onto
    // the pavement (`spawnCop`, and the crooked variant) are units with
    // officers and no vehicle at all, and a wrecked unit's cruiser is cleared
    // out from under it. The quarry side of this test was exhaustive while our
    // own side was assumed — so every foot cop threw
    // `Cannot read properties of null (reading 'position')` here on EVERY fixed
    // step it was in range, which is 120 times a second, per cop. It also took
    // the rest of `Unit.update` with it: that is why cops stalled in the road
    // and never closed on the quarry.
    if (!v || v.destroyed) return;

    const dx = q.position.x - v.position.x;
    const dz = q.position.z - v.position.z;
    const d = Math.hypot(dx, dz);
    const reach = v.spec.half.z + (q.vehicle.spec?.half?.z ?? 2.2) + TUNE.ram.gap;
    if (d > reach || d < 1e-3) return;

    // Deliberate: closing on the target, or carrying real speed through it.
    const rvx = v.velocity.x - q.vehicle.velocity.x;
    const rvz = v.velocity.z - q.vehicle.velocity.z;
    const closing = (rvx * dx + rvz * dz) / d;
    if (closing < TUNE.ram.minClosing && Math.abs(v.forwardSpeed) < TUNE.ram.minSpeed) return;

    this._ramT = TUNE.ram.period / sys.diff.aggr;
    sys.applyRam(this, q, dx / d, dz / d);
  }

  /** Racing line: hard chase clips corners, a responding unit drives normally. */
  _cut() {
    switch (this.role) {
      case ROLE.CHASE:
      case ROLE.PIT:
        return 0.75;
      case ROLE.INTERCEPT:
      case ROLE.FLANK:
        return 0.6;
      case ROLE.SEARCH:
      case ROLE.LEAVE:
        return 0.25;
      case ROLE.FLEE:
        return 0.7;
      default:
        return 0.5;
    }
  }

  /* ==================================================================== */
  /* Goal selection — the tactical layer, per role                        */
  /* ==================================================================== */

  /**
   * Fills `out` with a world point to drive at and returns the driving mode:
   *   'path'   follow the road route to `out`
   *   'direct' ignore the road network and drive AT `out` (wrong way, across
   *            a forecourt, straight through the junction)
   *   'hold'   stop here, in this pose
   */
  _chooseGoal(dt, ctx, out) {
    const sys = this.sys;
    const q = sys.quarry;
    const v = this.vehicle;

    if (this.role === ROLE.FLEE) {
      /**
       * Debug runner housekeeping: if it has left the carriageway (a wharf, the
       * river, a spin into a yard) put it back on the nearest lane. A test
       * subject that drowns halfway through the run measures nothing.
       *
       * ...and if putting it back on the nearest lane did not help, MOVE IT.
       * Measured: the runner wedged at one downtown lane centre with two of
       * four wheels off the ground, full throttle, zero speed, for forty
       * seconds — being re-placed onto the same trap every five seconds, which
       * is what "back on the nearest lane" means when the nearest lane is where
       * it is stuck. The whole chase then measures nothing: the harness read
       * "cops never got closer than 70 m" and blamed the pursuit AI for a
       * stationary quarry the cops had no reason to approach. A second rescue
       * inside `RESCUE_WINDOW` seconds jumps it to a fresh spawn pose instead.
       */
      const back = sys.roads?.nearestEdge?.(v.position.x, v.position.z, 200);
      if (!back?.edge || back.dist > 26 || this._stuckTotal > 5) {
        this._stuckTotal = 0;
        this._stuck = 0;
        this._reverse = 0;
        const relapse = this._age - (this._rescuedAt ?? -99) < RESCUE_WINDOW;
        this._rescuedAt = this._age;
        let placed = null;
        if (relapse) {
          const s = sys.roads?.sampleSpawn?.(sys.rng, v.position, 80, 260, (e) => !e.rail && e.len > 30);
          if (s) placed = { x: s.position.x, z: s.position.z, y: s.position.y, yaw: s.yaw };
        }
        if (!placed && back?.edge) {
          const e = back.edge;
          const na = sys.roads.nodes[e.a];
          const nb = sys.roads.nodes[e.b];
          const t = clamp(back.t, 0.1, 0.9);
          placed = {
            x: na.x + (nb.x - na.x) * t,
            z: na.z + (nb.z - na.z) * t,
            y: na.y + (nb.y - na.y) * t,
            yaw: Math.atan2(e.dx, e.dz),
          };
        }
        if (placed) {
          v.setPose(
            { x: placed.x, y: sys.laneSurfaceY(placed.x, placed.z, placed.y) + v.spec.comY + 0.05, z: placed.z },
            placed.yaw
          );
          v.velocity.set(0, 0, 0);
          v.angularVelocity.set(0, 0, 0);
          this.path.reset();
          this.hasSearchPt = false;
        }
      }
      // Run. Pick a far point on the network away from the nearest cruiser and
      // keep re-picking as we arrive, so the runner covers real streets rather
      // than circling one block.
      const near = sys.nearestUnitTo(v.position);
      if (!this.hasSearchPt || this.path.remaining < 40) {
        // Run from the SEARCH, not merely from the nearest car. Once contact is
        // broken, what a player escaping does is put distance between himself
        // and the place the police are sweeping; heading away from one cruiser
        // that happens to be nearest can walk you straight back into the
        // cordon, which is what the harness saw as "re-sighted every four
        // seconds" in a phase whose whole point is that contact is broken.
        const w = sys.meter;
        const kx = v.position.x - w.known.x;
        const kz = v.position.z - w.known.z;
        const useKnown = w.hasKnown && Math.hypot(kx, kz) > 60;
        let ax = useKnown ? kx : v.position.x - (near?.vehicle?.position.x ?? v.position.x - 1);
        let az = useKnown ? kz : v.position.z - (near?.vehicle?.position.z ?? v.position.z);
        const l = Math.hypot(ax, az) || 1;
        ax /= l;
        az /= l;
        const r = 320 + sys.rng.float() * 260;
        const hit = sys.roads?.nearestEdge?.(v.position.x + ax * r, v.position.z + az * r, 260);
        if (hit?.edge) {
          const na = sys.roads.nodes[hit.edge.a];
          this.searchPt.set(na.x, na.y, na.z);
        } else {
          this.searchPt.set(v.position.x + ax * r, 0, v.position.z + az * r);
        }
        this.hasSearchPt = true;
        this._replan = 0;
      }
      out.copy(this.searchPt);
      this.diag.dist = Math.hypot(out.x - v.position.x, out.z - v.position.z);
      return 'path';
    }

    if (this.role === ROLE.LEAVE) {
      if (!this.path.valid || this.path.remaining < 12) {
        const s = sys.roads?.sampleSpawn?.(sys.rng, v.position, 180, 340);
        if (s) out.copy(s.position);
        else out.set(v.position.x + 200, 0, v.position.z + 200);
      } else {
        out.set(this.path.goalX, 0, this.path.goalZ);
      }
      return 'path';
    }

    if (this._interceptCool > 0) this._interceptCool -= dt;
    if (this._directCool > 0) this._directCool -= dt;

    if (this.role === ROLE.BLOCK || (this.role === ROLE.INTERCEPT && this._atHold())) {
      if (this.holdPose) {
        const d = Math.hypot(v.position.x - this.holdPose.x, v.position.z - this.holdPose.z);
        this.diag.dist = d;
        if (d < 3.2) {
          // A roadblock is MEANT to stand there. An intercept is a bet on the
          // quarry coming past, and a bet that never expires is a cruiser
          // parked in the road for the rest of the chase — see
          // TUNE.interceptHold.
          if (this.role !== ROLE.INTERCEPT) return 'hold';
          this._holdT += dt;
          if (this._holdT < TUNE.interceptHold) return 'hold';
          this._holdT = 0;
          this._interceptCool = TUNE.interceptCool;
          this.holdPose = null;
          this.role = ROLE.CHASE;
          this._replan = 0;
          this.hasSearchPt = false;
        } else {
          this._holdT = 0;
          out.set(this.holdPose.x, 0, this.holdPose.z);
          return d < 34 ? 'direct' : 'path';
        }
      } else {
        this.role = ROLE.CHASE;
      }
    }

    if (this.role === ROLE.SEARCH || !q.valid) {
      this._pickSearchPoint(v);
      out.copy(this.searchPt);
      this.diag.dist = Math.hypot(out.x - v.position.x, out.z - v.position.z);
      return 'path';
    }

    /**
     * WHAT THIS CAR IS DRIVING AT: what it can see, or what the radio said.
     *
     * A unit with line of sight pursues the quarry itself. A unit without one
     * pursues `meter.known` — which IS the quarry, live, for as long as anybody
     * else in the fleet has eyes on it, and freezes on the last sighting the
     * moment nobody does. So nothing changes while the chase is on and the
     * clairvoyance disappears the instant contact is broken, which is the whole
     * point of having a wanted meter you can escape.
     */
    const w = sys.meter;
    const useBelief = !this.los && w.hasKnown && !w.seen;
    const tx = useBelief ? w.known.x : q.position.x;
    const tz = useBelief ? w.known.z : q.position.z;
    const tvx = useBelief ? w.knownVX : q.velocity.x;
    const tvz = useBelief ? w.knownVZ : q.velocity.z;
    const dx = tx - v.position.x;
    const dz = tz - v.position.z;
    const dist = Math.hypot(dx, dz);
    this.diag.dist = dist;

    if (this.role === ROLE.INTERCEPT && this.holdPose) {
      out.set(this.holdPose.x, 0, this.holdPose.z);
      const d = Math.hypot(v.position.x - this.holdPose.x, v.position.z - this.holdPose.z);
      return d < 40 ? 'direct' : 'path';
    }

    /* ---- PIT: aim through the quarry's rear quarter ------------------- */
    if (this.role === ROLE.PIT) {
      q.right(_tmp);
      out.copy(q.position)
        .addScaledVector(_tmp, this.pitSide * 2.6)
        .addScaledVector(q.forward, -q.halfLength * 0.55);
      return 'direct';
    }

    /* ---- FLANK: come alongside, offset laterally --------------------- */
    if (this.role === ROLE.FLANK) {
      q.right(_tmp);
      const lead = clamp(q.speed * 0.9, 0, 26);
      out.copy(q.position)
        .addScaledVector(_tmp, this.pitSide * 5.2)
        .addScaledVector(q.forward, lead);
      return dist < 70 && this.los ? 'direct' : 'path';
    }

    /* ---- CHASE / RESPOND --------------------------------------------- */
    // Lead the target. Classic pursuit-with-lead: aim where they will be when
    // we get there, not where they are now, so the car does not swing in
    // behind on every corner.
    const closing = Math.max(4, this.speed);
    const ttc = clamp(dist / closing, 0, 3.2);
    out.set(tx + tvx * ttc * 0.85, 0, tz + tvz * ttc * 0.85);

    // The slot offset: only slot 0 sits on the quarry's tail. Everyone else
    // holds a bearing around them, which is what stops the conga line.
    if (this.role === ROLE.CHASE && this.slot > 0 && dist < 90) {
      const bearing = q.heading + (TUNE.slotBearing[this.slot % TUNE.slotBearing.length] ?? Math.PI);
      const r = TUNE.slotRange;
      out.x += Math.sin(bearing) * r;
      out.z += Math.cos(bearing) * r;
    }

    /**
     * Close and visible: stop obeying the road network.
     *
     * ...unless improvising is what just beached us. Direct mode drives AT the
     * quarry, and the only thing between a cruiser and the quarry may be a
     * building — `_obstacles` scans vehicles, not walls, so nothing sees that
     * coming. The result is a car with its nose in a wall, reversing 1.3 m and
     * driving back into the same wall for the rest of the chase: the harness
     * measured 38 seconds of it, cycling free -> reverse -> panic -> free.
     * So every time the unstick fires, improvisation is suspended for
     * `TUNE.directCool` seconds and the unit drives the road network, which is
     * drivable by construction.
     */
    const direct = dist < (this.role === ROLE.CHASE ? 85 : 45) && this.los &&
      !(this._directCool > 0);
    return direct ? 'direct' : 'path';
  }

  _atHold() {
    if (!this.holdPose) return false;
    const v = this.vehicle;
    return Math.hypot(v.position.x - this.holdPose.x, v.position.z - this.holdPose.z) < 3.2;
  }

  _pickSearchPoint(v) {
    const sys = this.sys;
    const w = sys.meter;
    const need = !this.hasSearchPt ||
      Math.hypot(v.position.x - this.searchPt.x, v.position.z - this.searchPt.z) < 22;
    if (!need) return;
    const r = Math.max(30, w.cordon * (0.35 + sys.rng.float() * 0.7));
    const a = sys.rng.float() * Math.PI * 2;
    const cx = (w.hasKnown ? w.known.x : v.position.x) + Math.cos(a) * r;
    const cz = (w.hasKnown ? w.known.z : v.position.z) + Math.sin(a) * r;
    const hit = sys.roads?.nearestEdge?.(cx, cz, 160);
    if (hit?.edge) {
      const na = sys.roads.nodes[hit.edge.a];
      const nb = sys.roads.nodes[hit.edge.b];
      const t = clamp(hit.t, 0.15, 0.85);
      this.searchPt.set(
        na.x + (nb.x - na.x) * t,
        na.y + (nb.y - na.y) * t,
        na.z + (nb.z - na.z) * t
      );
    } else {
      this.searchPt.set(cx, 0, cz);
    }
    this.hasSearchPt = true;
  }

  /* ==================================================================== */
  /* Sensing                                                              */
  /* ==================================================================== */

  /**
   * Push away from every other cruiser inside `sepRadius`, weighted by how
   * close they are. Applied as a LATERAL OFFSET to the pursuit point rather
   * than straight into the steering command: offsetting the target keeps the
   * pure-pursuit loop stable, while injecting into the steer output makes it
   * ring at exactly the frequency the driver's rate limiter cannot damp.
   */
  _separation() {
    const v = this.vehicle;
    let ax = 0;
    let az = 0;
    const units = this.sys.units;
    for (let i = 0; i < units.length; i++) {
      const o = units[i];
      if (o === this || !o.active || !o.vehicle) continue;
      const dx = v.position.x - o.vehicle.position.x;
      const dz = v.position.z - o.vehicle.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > TUNE.sepRadius * TUNE.sepRadius || d2 < 1e-4) continue;
      const d = Math.sqrt(d2);
      const w = (1 - d / TUNE.sepRadius) ** 2;
      ax += (dx / d) * w;
      az += (dz / d) * w;
    }
    this._sepX = ax * TUNE.sepGain;
    this._sepZ = az * TUNE.sepGain;
  }

  /**
   * The nearest thing in our forward corridor. Cops shove traffic aside but
   * they do not drive through the back of a stationary truck at 40 m/s.
   */
  _obstacles(dt) {
    const v = this.vehicle;
    this._obGap = Infinity;
    this._obDv = 0;
    if (this._shove > 0) {
      // Shoving: deliberately blind to traffic. The vehicle-vehicle solver
      // does the rest, and a cruiser barging a stalled sedan out of a junction
      // is the correct behaviour, not a bug.
      this._shove -= dt;
      return;
    }
    const q = this.sys.quarry;
    const speed = Math.max(2, this.speed);
    const look = clamp(speed * TUNE.corridorTime, 6, 46);
    _fwd.set(0, 0, 1).applyQuaternion(v.quaternion);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) return;
    _fwd.normalize();
    const rx = -_fwd.z;
    const rz = _fwd.x;
    const half = v.spec.half.x + TUNE.corridorHalf;

    const list = this.sys.vehicles.vehicles;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === v) continue;
      // Ramming the quarry is the point at five stars; never treat it as an
      // obstacle to brake for while we are trying to hit it.
      if (o === q.vehicle && this.sys.level >= TUNE.ramFromLevel) continue;
      const dx = o.position.x - v.position.x;
      const dz = o.position.z - v.position.z;
      const along = dx * _fwd.x + dz * _fwd.z;
      if (along < 0.5 || along > look) continue;
      const lat = dx * rx + dz * rz;
      if (Math.abs(lat) > half + o.spec.half.x) continue;
      const gap = along - o.spec.half.z - v.spec.half.z;
      if (gap < this._obGap) {
        this._obGap = gap;
        const ov = o.velocity.x * _fwd.x + o.velocity.z * _fwd.z;
        this._obDv = this.speed - ov;
        // Steer around it: bias the pursuit point to the side with more room,
        // harder the closer it is.
        const urgency = clamp(2.8 - gap * 0.16, 1.2, 2.8);
        this._sepX += rx * (lat > 0 ? -1 : 1) * urgency;
        this._sepZ += rz * (lat > 0 ? -1 : 1) * urgency;
      }
    }

    /**
     * Deadlock breaker. Sitting behind a stopped car with the brake buried is
     * how a pursuit dies quietly: the obstacle never moves, the look-ahead
     * never shrinks below its 6 m floor, and the unit brakes forever while the
     * quarry drives away. After a second of that, stop asking.
     */
    if (this._obGap < 9 && Math.abs(this.speed) < 2.2) this._blockedT += dt;
    else this._blockedT = Math.max(0, this._blockedT - dt * 1.6);
    if (this._blockedT > TUNE.shoveAfter) {
      this._blockedT = 0;
      this._shove = TUNE.shoveTime;
      this._obGap = Infinity;
      this._obDv = 0;
    }
  }

  _sampleRoadSpeed(dt) {
    this._roadTimer -= dt;
    if (this._roadTimer > 0) return;
    this._roadTimer = 0.35;
    const roads = this.sys.roads;
    if (!roads) return;
    const v = this.vehicle;
    const hit = roads.nearestEdge(v.position.x, v.position.z, 90);
    this._roadSpeed = hit?.edge ? hit.edge.speed : 12;
    this._offRoad = !hit?.edge || hit.dist > hit.edge.width * 0.5 + 7;
  }

  /* ==================================================================== */
  /* Lateral                                                              */
  /* ==================================================================== */

  _lateral(dt, v) {
    const speed = Math.abs(v.forwardSpeed);

    if (this._reverse > 0) {
      // Backing out of whatever we hit: steer the opposite way to the way we
      // were pointing when we got stuck, so we actually leave.
      return this._steerCmd = clamp(-this._stuckSteer, -1, 1);
    }

    const Ld = clamp(TUNE.lookL0 + TUNE.lookKv * speed, TUNE.lookMin, TUNE.lookMax);
    this.path.ahead(Ld, _look);
    _look.x += this._sepX;
    _look.z += this._sepZ;

    const q = v.quaternion;
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const rx = -fz;
    const rz = fx;
    const dx = _look.x - v.position.x;
    const dz = _look.z - v.position.z;
    const ahead = dx * fx + dz * fz;
    const right = dx * rx + dz * rz;
    const alpha = Math.atan2(right, Math.max(0.5, ahead));

    this._headErr = alpha;

    /* ---- handbrake turn ---------------------------------------------- */
    // Overshoot a junction at speed and a real driver does not creep round;
    // they pitch it in.
    //
    // HEAVILY gated, and the gating is the lesson. The first version fired on
    // `|alpha| > 1.45` alone, which also happens for one tick every time the
    // path is replanned or the cursor jumps a corner — so a cruiser at 15 m/s
    // would yank the handbrake on a straight road and put itself in a wall.
    // Now it needs a genuinely reversed target, real speed, a cooldown, and a
    // car that is not already sliding.
    if (this._spinCool > 0) this._spinCool -= dt;
    if (this._spin > 0) {
      this._spin -= dt;
      this._input.handbrake = true;
      return (this._steerCmd = clamp(-Math.sign(alpha), -1, 1));
    }
    if (
      Math.abs(alpha) > TUNE.spinYaw &&
      speed > TUNE.spinSpeed &&
      ahead < 4 &&
      this._spinCool <= 0 &&
      Math.abs(v.slipAngle) < 0.25 &&
      this.role !== ROLE.FLEE &&
      this.sys.level >= 3
    ) {
      this._spin = TUNE.spinHold;
      this._spinCool = 6;
    }
    this._input.handbrake = false;

    let delta = Math.atan2(2 * v.spec.wheelbase * Math.sin(alpha), Math.max(1.5, Ld));

    // Cross-track: kill the steady-state offset pure pursuit leaves in a
    // constant-radius corner. Only while following a road route — in direct
    // mode the "path" is a straight line to a moving point and the cross-track
    // term would fight the lead.
    if (!this.path.direct) {
      const lat = this.path.crossTrack(v.position.x, v.position.z);
      const latRate = (lat - (this._latPrev ?? lat)) / Math.max(1e-3, dt);
      this._latPrev = lat;
      delta -= TUNE.crossTrackGain * clamp(lat, -4, 4);
      delta -= TUNE.crossRateGain * clamp(latRate, -7, 7);
    }

    const st = v.spec.steer;
    const falloff = Math.max(0.24, 1 - st.speedFalloff * Math.min(1, speed / 42));
    let cmd = clamp(-delta / Math.max(0.05, st.max * falloff), -1, 1);

    // Stability control. The dynamics model has real Pacejka tyres and will
    // happily let an AI spin a rear-drive car; once the slip angle is past the
    // peak, more lock makes it worse. Wind the command back toward the
    // direction of travel, which is what a driver does and what every
    // production ESC does.
    const slip = v.slipAngle;
    if (Math.abs(slip) > 0.22 && speed > 6) {
      const over = Math.min(1, (Math.abs(slip) - 0.22) / 0.5);
      cmd = cmd * (1 - over) + clamp(slip / Math.max(0.05, st.max), -1, 1) * over;
    }

    const maxStep = TUNE.steerRate * dt;
    cmd = clamp(cmd, this._steerCmd - maxStep, this._steerCmd + maxStep);
    this._steerCmd += (cmd - this._steerCmd) * Math.min(1, TUNE.steerSmooth * dt);
    if (!Number.isFinite(this._steerCmd)) this._steerCmd = 0;
    return this._steerCmd;
  }

  /* ==================================================================== */
  /* Longitudinal                                                         */
  /* ==================================================================== */

  _longitudinal(dt, v) {
    if (this._reverse > 0) {
      // The gearbox in `vehicles/drivetrain.js` selects reverse on
      // (throttle < 0.02 && brake > 0.5 && speed < 0.6), and shifts BACK to
      // first the moment throttle is applied while speed is still above
      // -0.4 m/s. So backing out of a wall is a four-phase sequence, not a
      // button: stop, select R, let the idle governor creep us backwards past
      // the shift-up guard, and only then use the throttle.
      const fs = v.forwardSpeed;
      const inR = v.drivetrain?.gear === 0;
      if (fs > 0.5 || !inR) {
        this._input.throttle = 0;
        this._input.brake = 1;
      } else if (fs > -0.45) {
        this._input.throttle = 0;
        this._input.brake = 0;
      } else {
        this._input.throttle = this._traction(v, 0.55, Math.abs(fs));
        this._input.brake = 0;
      }
      this._input.handbrake = false;
      this.diag.reason = 'reverse';
      this.diag.targetSpeed = -3;
      return;
    }

    const level = this.sys.level;
    const A = TUNE.accelA;
    const B = TUNE.accelB;
    const speed = Math.max(0, v.forwardSpeed);

    let v0 = Math.min(
      TUNE.speedCap,
      this._roadSpeed * (TUNE.speedGain[level] ?? 1.3)
    );
    if (this._offRoad) v0 = Math.min(v0, 16);
    if (this._shove > 0) v0 = Math.min(v0, TUNE.shoveSpeed);
    if (this.role === ROLE.RESPOND) v0 *= 0.92;
    if (this.role === ROLE.FLEE) v0 = Math.min(24, this._roadSpeed * 1.25);
    if (this.role === ROLE.LEAVE || this.role === ROLE.SEARCH) v0 = Math.min(v0, this._roadSpeed * 1.05);
    v0 *= this.sys.gripScale;

    let reason = 'free';

    /* ---- corner ------------------------------------------------------- */
    this.path.corner(TUNE.cornerHorizon, _corner);
    if (_corner.angle > 0.14) {
      // Speed we can carry through a corner of this angle, then the speed we
      // must be at now to brake down to it in `dist`.
      const radius = clamp(9 / Math.max(0.2, _corner.angle), 5, 90);
      const vc = Math.max(TUNE.cornerMin, Math.sqrt(TUNE.cornerLat * radius));
      const brakeTo = Math.sqrt(Math.max(0, vc * vc + 2 * TUNE.cornerBrake * _corner.dist));
      if (brakeTo < v0) { v0 = brakeTo; reason = 'corner'; }
    }

    /* ---- arriving at a stop ------------------------------------------ */
    if (this.role === ROLE.BLOCK || (this.role === ROLE.INTERCEPT && this.holdPose)) {
      const d = this.diag.dist;
      if (d < 40) {
        const arrive = Math.sqrt(Math.max(0, 2 * 5.5 * Math.max(0, d - 1.5)));
        if (arrive < v0) { v0 = arrive; reason = 'arrive'; }
      }
    }

    /* ---- pursuit closing rate ---------------------------------------- */
    const q = this.sys.quarry;
    if (q.valid && (this.role === ROLE.CHASE || this.role === ROLE.PIT || this.role === ROLE.FLANK)) {
      const d = this.diag.dist;
      // Do not rear-end the quarry at low speed unless we mean to.
      const ram = level >= TUNE.ramFromLevel || this.role === ROLE.PIT;
      if (!ram && d < 9 && speed > q.speed + 2) {
        v0 = Math.min(v0, Math.max(2, q.speed + 1.5));
        reason = 'closein';
      }
    }

    // Target behind us: turn round at a speed the car can actually turn at,
    // rather than trying to take a 170-degree corner flat.
    const he = Math.abs(this._headErr ?? 0);
    if (he > 0.8) {
      const turnCap = Math.max(4.5, 15 - (he - 0.8) * 11);
      if (turnCap < v0) { v0 = turnCap; reason = 'turnaround'; }
    }
    // Sliding: lift off. Power-on oversteer in a rear-drive cruiser ends with
    // the car facing the way it came.
    const slip = Math.abs(v.slipAngle);
    if (slip > 0.30 && speed > 6) {
      const cap = Math.max(3, speed * (1 - Math.min(0.6, (slip - 0.30) * 1.4)));
      if (cap < v0) { v0 = cap; reason = 'slide'; }
    }

    this.diag.targetSpeed = v0;

    let acc = A * (1 - (speed / Math.max(1.2, v0)) ** 4);

    /* ---- obstacle ----------------------------------------------------- */
    if (this._obGap < 60) {
      const sStar = 2.6 + Math.max(0, speed * 0.85 + (speed * this._obDv) / (2 * Math.sqrt(A * B)));
      const term = A * (1 - (speed / Math.max(1.2, v0)) ** 4) - A * (sStar / Math.max(0.4, this._obGap)) ** 2;
      if (term < acc) { acc = term; reason = 'obstacle'; }
      if (this._obGap < TUNE.obstacleBrake * 0.4) { acc = Math.min(acc, -TUNE.brakeMax); reason = 'panic'; }
    }

    acc = clamp(acc, -TUNE.brakeMax, A * 1.5);
    this.diag.reason = reason;

    if (acc > 0.02) {
      this._input.throttle = this._traction(v, clamp01(acc / TUNE.throttleRef), speed);
      this._input.brake = 0;
    } else if (acc > TUNE.brakeDeadband) {
      this._input.throttle = 0;
      this._input.brake = 0;
    } else {
      this._input.throttle = 0;
      this._input.brake = clamp01(-acc / TUNE.brakeRef);
    }

    if (v0 < 0.4 && speed < 1.2) {
      this._input.throttle = 0;
      this._input.brake = 1;
    }
  }

  /**
   * Launch control and traction control, in that order.
   *
   * THE BUG THIS EXISTS FOR. `vehicles`' automatic gearbox shifts on ENGINE
   * speed. Bury the throttle in a rear-drive cruiser from a standstill, light
   * the rear tyres up, and the crank screams past the up-shift threshold while
   * the car has not moved a metre — so the box goes to second, then third,
   * with the road speed still zero. The car then sits in third gear spinning
   * its wheels at full throttle, going nowhere, forever. The headless harness
   * found this as "cop stuck at throttle 1.0, speed 0.01, gear 3" and it would
   * have been almost impossible to diagnose from a screenshot.
   *
   * The fix is the one a real driver uses: do not floor it from rest, and back
   * off when the tyres let go.
   */
  _traction(v, thr, speed) {
    // Launch ramp, with an escape: a car that is still not moving after half a
    // second is not spinning its wheels, it is on a hill or against a kerb, so
    // give it everything. Without the escape the ramp itself becomes the
    // reason a cruiser never pulls away.
    this._launchT = speed < 1.5 ? (this._launchT ?? 0) + 0.0167 : 0;
    const ramp = 0.45 + speed * 0.14 + Math.min(0.55, (this._launchT ?? 0) * 0.9);
    let out = Math.min(thr, ramp);
    // Slip ratio is meaningless at a standstill (it is normalised by road
    // speed), so traction control only applies once the car is actually
    // rolling — that mis-gate had cruisers creeping away at 7% throttle.
    if (speed > 1.6) {
      let worst = 0;
      for (let i = 0; i < v.wheels.length; i++) {
        const w = v.wheels[i];
        if (!w.grounded) continue;
        if (w.combined > worst) worst = w.combined;
      }
      if (worst > 1.1) out *= clamp(1 - (worst - 1.1) * 0.55, 0.3, 1);
    }
    return clamp01(out);
  }

  /* ==================================================================== */
  /* Parking, holding, and getting unstuck                                */
  /* ==================================================================== */

  /** Sit still. `hard` also drops the handbrake on so nothing rolls. */
  _park(hard) {
    const v = this.vehicle;
    if (!v) return;
    this._input.throttle = 0;
    this._input.brake = 1;
    this._input.steer = 0;
    this._input.handbrake = !!hard;
    this._steerCmd = 0;
    this.sys.vehicles.setInput(v, this._input);
  }

  /**
   * Hold the assigned pose: brake to a stop and, while still rolling, steer to
   * line the car up ACROSS the road. A block that is parallel to the kerb is
   * not a block.
   */
  _holdPose(dt) {
    const v = this.vehicle;
    const pose = this.holdPose;
    const speed = Math.abs(v.forwardSpeed);
    if (!pose || speed < 0.35) {
      this._park(true);
      this.diag.reason = 'holding';
      this.diag.targetSpeed = 0;
      return;
    }
    const err = angDiff(this.yaw, pose.yaw);
    const st = v.spec.steer;
    const cmd = clamp(err / Math.max(0.05, st.max), -1, 1);
    this._steerCmd += (cmd - this._steerCmd) * Math.min(1, 8 * dt);
    this._input.throttle = 0;
    this._input.brake = 1;
    this._input.steer = this._steerCmd;
    this._input.handbrake = false;
    this.sys.vehicles.setInput(v, this._input);
    this.diag.reason = 'settling';
  }

  /**
   * Nothing reads as broken faster than a cruiser buried in a wall with its
   * lightbar on for the rest of the chase. Three stages: notice, reverse out,
   * and — if it is genuinely wedged — hand it back to the dispatcher, which
   * will delete it out of sight and put a fresh unit somewhere useful.
   */
  _stuckCheck(dt, v) {
    /**
     * IMMOBILITY, measured the way the harness measures it: one unbroken run of
     * not moving, whatever the driver thinks it is doing.
     *
     * The `_stuck`/`_stuckTotal` pair above is a THROTTLE-INTENT measure — it
     * only counts while the controller is asking for speed — and it bleeds off
     * during the reverse phase, so a genuinely wedged car cycles
     * stuck -> reverse -> stuck indefinitely without ever convincing anything
     * that it is finished. Add the blunt one: nine seconds without moving means
     * this unit is not in the pursuit any more, and the dispatcher can put a
     * fresh car on the road out of sight within a second. Bounded, and it does
     * not care WHY the car is not moving.
     */
    if (Math.abs(v.forwardSpeed) < 0.6 && this.role !== ROLE.BLOCK) {
      this._frozenT += dt;
      if (this._frozenT > TUNE.frozenGiveUp) {
        this._frozenT = 0;
        this.sys.onUnitLost(this, 'frozen');
        return;
      }
    } else {
      // Decay rather than reset. A car wedged against another car twitches:
      // measured one unit alternating 0.4 and 0.7 m/s for fourteen seconds
      // while going nowhere, which a hard reset let off the hook every time.
      this._frozenT = Math.max(0, this._frozenT - dt * 2);
    }

    if (this._reverse > 0) {
      this._reverse -= dt;
      if (this._reverse <= 0) this._stuck = 0;
      return;
    }
    const wants = this._input.throttle > 0.25 || this.diag.targetSpeed > 3;
    const slow = Math.abs(v.forwardSpeed) < TUNE.stuckSpeed;
    const holding = this.role === ROLE.BLOCK && this._atHold();
    if (wants && slow && !holding) {
      this._stuck += dt;
      this._stuckTotal += dt;
      if (this._stuck > TUNE.stuckTime) {
        this._stuck = 0;
        this._reverse = TUNE.unstickTime;
        this._stuckSteer = this._steerCmd;
        // Whatever we drove into, we drove into it while improvising. Follow
        // the road for a while — see the direct-mode note in `_chooseGoal`.
        this._directCool = TUNE.directCool;
      }
      if (this._stuckTotal > TUNE.stuckGiveUp) {
        this.sys.onUnitLost(this, 'stuck');
      }
    } else {
      this._stuck = Math.max(0, this._stuck - dt * 2);
      if (!slow) this._stuckTotal = Math.max(0, this._stuckTotal - dt * 0.5);
    }
  }
}
