/**
 * Swept-capsule character controller — collide and slide.
 *
 * The controller is kinematic: `player` (or `ai`) sets a desired displacement
 * each fixed step and it is resolved against the static BVH. Nothing here
 * integrates forces; velocity is owned by the caller and only *clipped* here,
 * so the movement state machine keeps full authority over feel.
 *
 * Resolution per move():
 *   1. depenetrate  — push out of anything the capsule is already inside
 *   2. lift         — grounded moves raise the capsule by stepHeight first, so
 *                     a stair tread is simply invisible to the horizontal sweep
 *   3. slide        — up to N swept sweeps, clipping the remaining motion
 *                     against every plane touched (Quake-style plane stack so
 *                     creases don't launch or trap the player)
 *   4. drop         — come back down by the lift plus gravity plus the stair
 *                     descent snap, refusing to cling to unwalkable faces
 *   5. bridge       — a void narrower than the capsule is ground, not a hole
 *   6. unstick      — commanded movement that is going nowhere gets a nudge
 *   7. ground probe — publish grounded / normal / surface for this frame
 *
 * The sweep is a true continuous test (see StaticWorld.sweepCapsule), so there
 * is no tunnelling regardless of speed — a 300 m/s displacement resolves
 * correctly in one step.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FORGIVENESS — steps 5 and 6, and why they are in the CONTROLLER
 * ────────────────────────────────────────────────────────────────────────────
 * A player fell into a hole between two pavements and could not get out. The
 * hole was a real defect and `world` has closed it, but the general answer to
 * "the geometry has a defect" cannot be "find every defect", because a city
 * that is still being built grows new ones every week. What shipped open-world
 * games do instead is make traversal FORGIVING: the character quietly refuses
 * to be beaten by small geometry, and the player experiences the ABSENCE of a
 * snag rather than a rescue.
 *
 * Three properties, all defaulted ON so callers get them without asking:
 *
 *   step-up      already here, and it is generous on purpose: `stepHeight`
 *                0.42 m against a 0.152 m kerb. It runs as an OFFSET (lift,
 *                slide, drop) rather than a detect-and-retry, which is the only
 *                scheme that clears a step in one 8 ms tick — see `move()`.
 *   gap bridging `bridgeGap`. A capsule cannot physically pass through a slot
 *                narrower than its own diameter, but the GROUND PROBE could
 *                still fall between two edges and report "airborne", which
 *                cancels ground friction, kills the step-offset scheme for the
 *                next step and starts a fall the caller then has to recover
 *                from. `_bridgeGround` fires a ring of thin probes and requires
 *                support on OPPOSITE sides — which is exactly the statement
 *                "this void is narrower than the capsule". One-sided support is a
 *                ledge and is deliberately not bridged, or you could stand on
 *                thin air off the edge of a roof.
 *   unstick      `unstickAfter`. Commanded, grounded, and going nowhere for a
 *                second is not a decision the player made; it is a crease, a
 *                kerb corner or a prop they are wedged against. The nudge is
 *                capped at the commanded step length, so at its strongest it
 *                only redirects motion the player already asked for — it can
 *                never move them faster than they are trying to go, and it is
 *                strictly horizontal, so holding forward into a wall cannot
 *                levitate anyone.
 *
 * Measured with `node src/physics/walksweep.mjs`, 5 districts, 450 walkers on
 * emitted pavement — see that file for the full table and its negative
 * controls (`--raw` turns all three off; `--nofix` reverts the geometry).
 */

import { makeHitRecord } from './math.js';
import { MASK, SURFACE_PROPS, surfaceName } from './surfaces.js';

const MAX_PLANES = 5;
const SKIN = 0.008;
/**
 * Directions in the bridge ring and the unstick search. Eight is the smallest
 * count with true opposites on both axes AND both diagonals, which is what the
 * "supported on opposite sides" test needs to see a slot at any orientation.
 */
const BRIDGE_DIRS = 8;
const COS8 = new Float64Array(BRIDGE_DIRS);
const SIN8 = new Float64Array(BRIDGE_DIRS);
for (let i = 0; i < BRIDGE_DIRS; i++) {
  COS8[i] = Math.cos((i / BRIDGE_DIRS) * Math.PI * 2);
  SIN8[i] = Math.sin((i / BRIDGE_DIRS) * Math.PI * 2);
}

export class CharacterController {
  constructor(world, opts = {}) {
    this.world = world;
    this.id = opts.id ?? 'character';
    this.owner = opts.owner ?? null;

    this.radius = opts.radius ?? 0.32;
    this.height = opts.height ?? 1.78; // total capsule height, feet to crown
    this.stepHeight = opts.stepHeight ?? 0.42;
    this.slopeLimit = opts.slopeLimit ?? 50 * (Math.PI / 180);
    this.snapDistance = opts.snapDistance ?? 0.32;
    this.mask = opts.mask ?? MASK.CHARACTER;
    this.maxIterations = opts.maxIterations ?? 5;

    /* ---- forgiveness. 0 disables; see the header. --------------------- */
    /**
     * Widest void treated as ground. A capsule rests on the two edges of any
     * slot narrower than its own diameter whether bridging runs or not, so this is
     * only ever making the GROUND REPORT agree with the geometry; slightly over
     * a diameter buys the sampling slack that the two thin ring probes cost.
     */
    this.bridgeGap = opts.bridgeGap ?? this.radius * 2.3;
    /**
     * Metres of COMMANDED horizontal travel that may go nowhere before the
     * nudge starts. Deliberately a distance and not a timer: `move()` is not
     * given a dt, and "a second" is only meaningful multiplied by the speed the
     * caller asked for anyway. 2.4 m is one second of a brisk walk.
     */
    this.unstickAfter = opts.unstickAfter ?? 2.4;
    /** Fraction of the commanded step that counts as having moved at all. */
    this.unstickProgress = opts.unstickProgress ?? 0.15;
    /** Hard ceiling on the nudge, on top of the never-exceed-commanded rule. */
    this.unstickStrength = opts.unstickStrength ?? 0.06;
    /** Commanded distance that has produced no progress. Diagnostics read it. */
    this.stuckDistance = 0;
    /** Metres of nudge applied on the last move(), 0 when not stuck. */
    this.unstuck = 0;
    /** True when the ground probe bridged a void this step instead of falling. */
    this.bridged = false;
    /**
     * Shared, preallocated vehicle blocker set, refreshed once per fixed step
     * by `PhysicsSystem._refreshBlockers`. See `_pushOutOfVehicles`. Null means
     * no vehicle system, which is every headless test of this file.
     */
    this.blockers = opts.blockers ?? null;
    /** Metres of vehicle push applied on the last move(). Diagnostics read it. */
    this.pushedByVehicle = 0;

    /** Feet position (bottom of the capsule), the authoritative transform. */
    this.position = { x: 0, y: 0, z: 0 };
    /** Velocity is owned by the caller; move() clips it against contacts. */
    this.velocity = { x: 0, y: 0, z: 0 };

    this.grounded = false;
    this.wasGrounded = false;
    this.groundNormal = { x: 0, y: 1, z: 0 };
    this.groundSurface = 0;
    this.groundDistance = 0;
    this.groundObject = -1;
    this.onSteepSlope = false;
    this.touchingCeiling = false;
    this.touchingWall = false;
    this.wallNormal = { x: 0, y: 0, z: 0 };
    this.lastMoveBlocked = false;
    this.steppedUp = 0;
    /** Impact speed along the ground normal on the landing frame. */
    this.landingSpeed = 0;
    this.enabled = true;

    // preallocated scratch
    this._hit = makeHitRecord();
    this._hit2 = makeHitRecord();
    this._hit3 = makeHitRecord();
    this._planes = new Float32Array(MAX_PLANES * 3);
    this._planeCount = 0;
    this._startPos = { x: 0, y: 0, z: 0 };
    /** Ring-probe results for `_bridgeGround`: height per direction, NaN = none. */
    this._ring = new Float64Array(BRIDGE_DIRS);
    this._airSteps = 0;

    if (opts.position) this.setPosition(opts.position.x, opts.position.y, opts.position.z);
  }

  get cosSlope() {
    return Math.cos(this.slopeLimit);
  }

  /** Lower sphere centre of the capsule. */
  get p0y() {
    return this.position.y + this.radius;
  }
  /** Upper sphere centre of the capsule. */
  get p1y() {
    return this.position.y + this.height - this.radius;
  }

  setPosition(x, y, z) {
    this.position.x = x;
    this.position.y = y;
    this.position.z = z;
  }

  /** Teleport: clears contact state and de-penetrates at the destination. */
  teleport(x, y, z) {
    this.setPosition(x, y, z);
    this.velocity.x = this.velocity.y = this.velocity.z = 0;
    this.grounded = false;
    this.touchingCeiling = false;
    this.touchingWall = false;
    this.depenetrate(8);
    this.probeGround();
  }

  /**
   * Change capsule height keeping the feet planted. Returns false if standing
   * up is blocked by a ceiling (caller stays crouched).
   */
  setHeight(h, force = false) {
    if (h > this.height && !force && !this.canFit(h)) return false;
    this.height = h;
    return true;
  }

  /** Would a capsule of `h` metres fit at the current feet position? */
  canFit(h) {
    const r = this.radius;
    const p0y = this.position.y + r;
    const p1y = this.position.y + h - r;
    if (p1y < p0y) return true;
    const n = this.world.overlapCapsule(
      this.position.x, p0y, this.position.z,
      this.position.x, p1y, this.position.z,
      r - 0.01, this.mask, 0
    );
    return n === 0;
  }

  /**
   * Resolve a displacement. `dx/dy/dz` are metres for this step (the caller has
   * already multiplied by dt). Returns the distance actually travelled.
   *
   * Grounded moves use the step-offset scheme: lift the capsule by stepHeight,
   * slide horizontally, then drop back down. A tread shorter than stepHeight is
   * simply invisible to the horizontal sweep, which is the only way to make
   * stairs work with a capsule — its bottom hemisphere always meets a stair
   * nose at a shallow angle, so a "detect the wall then retry higher" scheme
   * never gets enough forward travel in one 8 ms step to clear the nose.
   */
  move(dx, dy, dz) {
    if (!this.enabled) return 0;
    const st = this._startPos;
    st.x = this.position.x; st.y = this.position.y; st.z = this.position.z;
    this.wasGrounded = this.grounded;
    this.touchingCeiling = false;
    this.touchingWall = false;
    this.lastMoveBlocked = false;
    this.steppedUp = 0;
    this.unstuck = 0;
    this.bridged = false;
    this.pushedByVehicle = 0;

    // Vehicles first: a capsule already inside a car has to come out before
    // anything reasons about where it is, and the push is the cheapest and
    // least surprising of the three resolutions in this function.
    this._pushOutOfVehicles();

    this.depenetrate(4);

    const jumping = dy > 1e-6;
    this._jumping = jumping;
    const wantH = Math.hypot(dx, dz);
    const useStepOffset =
      this.wasGrounded && !jumping && this.stepHeight > 1e-4 && wantH > 1e-5;

    if (!useStepOffset) {
      this._slide(dx, dy, dz);
    } else {
      // 1. lift — a low ceiling shortens the lift automatically
      const lift = this._sweepMove(0, this.stepHeight, 0);
      // 2. horizontal
      this._slide(dx, 0, dz);
      // 3. drop back down, plus this step's gravity, plus the stair-descent snap
      //
      //    AT FULL RADIUS, DELIBERATELY. A thinner probe here is an obvious
      //    idea — it would settle the capsule on the tread instead of the
      //    nose — and it is wrong: a narrow trace slips PAST the nose it has
      //    just cleared, finds the tread below, and walks the character back
      //    down every step it climbs. Measured with `src/physics/selftest.js`,
      //    0.72 radius on this one line: peak y 1.808 -> 0.018 m and forward
      //    progress -9.53 -> -2.57 m, i.e. the staircase became unclimbable.
      //    The nose is handled where it should be, in `probeGround`, which runs
      //    a thin trace and a wide one and takes whichever finds a floor.
      const want = lift + Math.max(0, -dy);
      const snap = this.snapDistance;
      const yBefore = this.position.y;
      const dropped = this._sweepDown(want + snap);
      if (dropped < 0) {
        // Nothing underneath: fall exactly what was asked, no more.
        this.position.y = yBefore - want;
      } else if (dropped > want && this._hit2.ny < this.cosSlope) {
        // The only thing within snap range is a cliff face — don't cling to it.
        this.position.y = yBefore - want;
      }
      const gained = this.position.y - st.y;
      if (gained > 1e-4) this.steppedUp = gained;
    }

    this.depenetrate(3);
    this.probeGround();

    // ---- forgiveness ---------------------------------------------------
    // Bridging runs after the probe because it is the probe's fallback, and
    // only while there is still a claim on the ground: the step it was left,
    // or the handful after that while still descending. A jump is exempt or
    // every take-off would be cancelled by the floor just left.
    this._airSteps = this.grounded ? 0 : this._airSteps + 1;
    if (!this.grounded && !jumping && this.bridgeGap > 0 &&
        this.velocity.y <= 0.5 && (this.wasGrounded || this._airSteps <= 6)) {
      if (this._bridgeGround()) {
        this.bridged = true;
        this._airSteps = 0;
      }
    }

    const gotH = Math.hypot(this.position.x - st.x, this.position.z - st.z);
    if (this.unstickAfter > 0 && wantH > 1e-4 && this.grounded) {
      if (gotH < wantH * this.unstickProgress) {
        this.stuckDistance += wantH;
        if (this.stuckDistance >= this.unstickAfter) this._unstick(dx, dz, wantH);
      } else {
        // Recover twice as fast as it accumulates, so a single blocked step in
        // an otherwise clean run never edges the counter toward the threshold.
        this.stuckDistance = Math.max(0, this.stuckDistance - wantH * 2);
      }
    } else if (wantH <= 1e-4 || !this.grounded) {
      this.stuckDistance = 0;
    }

    if (this.grounded && !this.wasGrounded) {
      this.landingSpeed = -Math.min(0, this.velocity.y);
    }

    return Math.hypot(this.position.x - st.x, this.position.y - st.y, this.position.z - st.z);
  }

  /**
   * VEHICLES BLOCK. Until this existed, they did not.
   *
   * The controller resolves against the static BVH and nothing else, dynamic
   * colliders are raycast-only hitboxes, and `src/vehicles` registers no
   * blocking geometry — so a man on foot walked through every car in the city,
   * parked or moving, with no code path anywhere that could stop him.
   *
   * A radial push, not an OBB test, and the choice is the same one the rest of
   * this file makes about traversal:
   *
   *   forgiving at the corners  a box has four of them to catch on and a
   *                             cylinder has none, so brushing a wing deflects
   *                             you round the car instead of stopping you
   *                             square against an edge you cannot slide along
   *   cannot wedge              the push is along the line of centres, so two
   *                             vehicles either side resolve to a sum that
   *                             still points out; there is no crease to trap a
   *                             capsule and nothing for `_unstick` to fight
   *   cheap                     one distance test per vehicle, no broadphase
   *
   * WHO IS EXEMPT. The rider. `player/movement.setDriving` disables the capsule
   * for the whole enter/ride/exit sequence (`character.enabled = false`, and
   * `move()` returns immediately on that), so entry cannot be fought by this
   * code at all — that is the real guarantee and it is not a flag anyone has to
   * remember to set. The occupant test below is belt and braces for any actor
   * that rides with its capsule live.
   *
   * ENTRY STILL REACHES. `player/vehicle.js` scans with `ENTER_REACH = 2.2 m`
   * measured to the vehicle's OBB SURFACE, not its centre. The closest a
   * capsule can now stand to a sedan is `r + radius` = 2.23 m from the centre,
   * which is 1.23 m from the door and inside the box footprint at the nose —
   * comfortably within reach on every approach.
   */
  _pushOutOfVehicles() {
    const b = this.blockers;
    if (!b || b.n === 0) return;
    const px = this.position.x;
    const pz = this.position.z;
    const footY = this.position.y;
    const headY = this.position.y + this.height;
    let mx = 0;
    let mz = 0;
    for (let i = 0; i < b.n; i++) {
      const R = b.r[i] + this.radius;
      const dx = px - b.x[i];
      const dz = pz - b.z[i];
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R) continue;
      // Vertical gate. Standing ON the roof is standing on real geometry and
      // must not be shoved sideways; a deck overhead is not a wall either.
      const vy = b.y[i];
      const hh = b.h[i];
      if (footY > vy + hh * 0.8) continue;
      if (headY < vy - hh) continue;
      /**
       * The rider is exempt — but ONLY when there is a rider to be.
       *
       * `this.owner` defaults to null and a parked car's `driver` is null, so
       * the obvious `v.driver === this.owner` matched every driverless car in
       * the city against every ownerless capsule and skipped the push
       * entirely. Measured by `src/physics/carblock.mjs` on the first run:
       * 6 of 8 approaches still walked clean through the bodywork, reaching
       * -1.02 m — dead centre. Two nulls comparing equal is not a match.
       */
      const v = b.obj[i];
      if (this.owner && v &&
          (v.driver === this.owner ||
           (v.occupants && v.occupants.indexOf(this.owner) >= 0))) continue;
      const d = Math.sqrt(d2);
      // Dead centre has no line of centres to push along. Use the commanded
      // heading's reverse if there is one, and otherwise anything at all —
      // being ejected in an arbitrary direction beats staying inside the car.
      let ux, uz;
      if (d > 1e-4) { ux = dx / d; uz = dz / d; }
      else { ux = 1; uz = 0; }
      const pen = R - d;
      mx += ux * pen;
      mz += uz * pen;
    }
    const l = Math.hypot(mx, mz);
    if (l < 1e-5) return;
    // Capped per step, so a car that materialises on top of the player pushes
    // them out over a few frames rather than firing them across the street.
    // 0.12 m at 120 Hz is 14 m/s of separation, which no vehicle outruns while
    // still overlapping.
    const s = l > 0.12 ? 0.12 / l : 1;
    this.position.x += mx * s;
    this.position.z += mz * s;
    this.pushedByVehicle = l * s;
    // Clip the caller's velocity the same way a wall would, or they keep
    // accelerating into the bodywork and the push has to fight the input.
    const nx = mx / l;
    const nz = mz / l;
    const into = this.velocity.x * nx + this.velocity.z * nz;
    if (into < 0) {
      this.velocity.x -= nx * into;
      this.velocity.z -= nz * into;
    }
  }

  /**
   * A void narrower than the capsule is ground.
   *
   * Fires `BRIDGE_DIRS` thin downward probes on a ring of radius `radius` and
   * accepts only when two OPPOSITE probes find walkable ground — which is the
   * geometric statement "the hole below is narrower than the capsule is wide". One
   * side alone is a ledge and must keep falling, or a character could stand on
   * air at the edge of any roof.
   *
   * Returns true and plants the feet on the higher of the two supports.
   */
  _bridgeGround() {
    const w = this.world;
    const hit = this._hit3;
    const ring = this._ring;
    const r = this.radius;
    /**
     * How far BELOW the feet a support still counts, derived rather than tuned.
     * A sphere of radius r resting in a slot of width g touches both lips with
     * its lowest point `r - sqrt(r^2 - (g/2)^2)` under the lip plane, which for
     * the widest slot the capsule can span (g = 2r) is exactly r. So half the
     * declared bridge WIDTH is the corresponding search DEPTH, and a support
     * further down than that belongs to a hole the capsule really is inside.
     */
    const probe = this.bridgeGap * 0.5;
    // Thin enough to reach past the lip of the void, wide enough to be stable.
    const tr = r * 0.28;
    const cos = this.cosSlope;
    let found = false;
    let surface = -1;
    for (let i = 0; i < BRIDGE_DIRS; i++) {
      const x = this.position.x + COS8[i] * r;
      const z = this.position.z + SIN8[i] * r;
      const ok = w.sweepCapsule(
        x, this.position.y + tr + 0.02, z,
        x, this.position.y + this.height - tr, z,
        tr, 0, -1, 0, probe, this.mask, hit
      );
      if (ok && hit.ny >= cos) {
        ring[i] = this.position.y + 0.02 - hit.t;
        if (surface < 0) surface = hit.surface;
        found = true;
      } else {
        ring[i] = NaN;
      }
    }
    if (!found) return false;

    // OPPOSITE sides, which is the whole test: one lip is a ledge to fall off.
    const half = BRIDGE_DIRS / 2;
    let best = -Infinity;
    for (let i = 0; i < half; i++) {
      const a = ring[i];
      const b = ring[i + half];
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      const h = a > b ? a : b;
      if (h > best) best = h;
    }
    if (best === -Infinity) return false;
    // Never LIFT the character; bridging holds them up, it does not push them
    // up. A support above the feet is a step and belongs to the step-up path.
    if (best > this.position.y) best = this.position.y;
    if (this.position.y - best > probe) return false;

    this.position.y = best;
    this.grounded = true;
    this.onSteepSlope = false;
    this.groundDistance = 0;
    // A bridged void has no single normal and up is the only honest answer;
    // the surface tag is real, so footsteps and tyre grip still read the right
    // material instead of whatever was under the character two seconds ago.
    this.groundNormal.x = 0; this.groundNormal.y = 1; this.groundNormal.z = 0;
    if (surface >= 0) this.groundSurface = surface;
    if (this.velocity.y < 0) this.velocity.y = 0;
    return true;
  }

  /**
   * Nudge a character that is asking to move, is on the ground, and is not
   * moving.
   *
   * Picks the least obstructed of `BRIDGE_DIRS` directions THAT HAS A FLOOR,
   * biased toward where they were trying to go, and travels at most as far as
   * they asked for this step. Three properties, and all three are what let it
   * be on by default rather than a special case:
   *
   *   never faster than the player   the step is capped at the commanded
   *                                  distance, so the assist can only ever
   *                                  redirect motion that was already asked for
   *   never off a ledge              a direction with no ground within a step
   *                                  of the feet is refused, so the nudge can
   *                                  do nothing the player could not have done
   *                                  by walking
   *   never upward                   strictly horizontal, so leaning on a wall
   *                                  for a second cannot levitate anyone
   */
  _unstick(dx, dz, wantH) {
    const w = this.world;
    const hit = this._hit3;
    const inv = 1 / wantH;
    const cx = dx * inv;
    const cz = dz * inv;
    const reach = Math.max(0.35, this.radius * 2);
    let bestScore = -Infinity;
    let bestX = 0, bestZ = 0;
    for (let i = 0; i < BRIDGE_DIRS; i++) {
      const ux = COS8[i];
      const uz = SIN8[i];
      // Lift the probe by the step offset: the way out of a kerb corner is
      // usually over a lip the flat sweep says is a wall.
      const y0 = this.position.y + this.radius + this.stepHeight * 0.5;
      const y1 = this.position.y + this.height - this.radius;
      const blocked = w.sweepCapsule(
        this.position.x, y0, this.position.z,
        this.position.x, y1, this.position.z,
        this.radius * 0.9, ux, 0, uz, reach, this.mask, hit
      );
      const free = blocked ? Math.max(0, hit.t) : reach;
      if (free <= 1e-4) continue;
      /**
       * AND THERE MUST BE A FLOOR THAT WAY.
       *
       * Without this the nudge is a hazard rather than a rescue: a character
       * standing on a fire escape and holding forward into the wall is, by
       * every measure above, stuck — and the least obstructed direction from
       * there is off the edge. Open air scores highest precisely where it is
       * most dangerous. Refusing directions with no ground within a step of the
       * feet makes the assist unable to do anything the player could not have
       * done by walking, which is the property that lets it stay always-on.
       */
      const fx = this.position.x + ux * (this.radius + 0.12);
      const fz = this.position.z + uz * (this.radius + 0.12);
      const tr = this.radius * 0.4;
      // Reachable band: a step up above the feet down to a step down below
      // them — exactly the ground an ordinary move() could have arrived on.
      const land = w.sweepCapsule(
        fx, this.position.y + this.stepHeight + tr, fz,
        fx, this.position.y + this.height - tr, fz,
        tr, 0, -1, 0, this.stepHeight + this.snapDistance, this.mask, hit
      );
      if (!land || hit.ny < this.cosSlope) continue;
      const score = free * (0.55 + 0.45 * (ux * cx + uz * cz));
      if (score > bestScore) {
        bestScore = score;
        bestX = ux;
        bestZ = uz;
      }
    }
    if (bestScore <= 1e-4) return;
    const step = Math.min(this.unstickStrength, wantH);
    const before = this.position.x;
    const beforeZ = this.position.z;
    // Through the normal step-offset path so the nudge respects every collider
    // the ordinary move does — it is a move the player did not type, not a
    // teleport past the world.
    const lift = this._sweepMove(0, this.stepHeight, 0);
    this._slide(bestX * step, 0, bestZ * step);
    const dropped = this._sweepDown(lift + this.snapDistance);
    if (dropped < 0) this.position.y -= lift;
    this.unstuck = Math.hypot(this.position.x - before, this.position.z - beforeZ);
    if (this.unstuck > 1e-4) {
      // The nudge moved the capsule, so everything `probeGround` published a
      // moment ago is about somewhere else. Re-publish, or the caller's very
      // next frame reasons about a stale normal and a stale surface.
      this.probeGround();
      this.stuckDistance = Math.max(0, this.stuckDistance - this.unstuck * 6);
    }
  }

  /** Collide-and-slide core. Returns true if any plane stopped the move. */
  _slide(dx, dy, dz) {
    const planes = this._planes;
    let planeCount = 0;
    let blocked = false;

    for (let iter = 0; iter < this.maxIterations; iter++) {
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 1e-6) break;
      const inv = 1 / dist;
      const ux = dx * inv, uy = dy * inv, uz = dz * inv;

      const hit = this._hit;
      const r = this.radius;
      const ok = this.world.sweepCapsule(
        this.position.x, this.p0y, this.position.z,
        this.position.x, this.p1y, this.position.z,
        r, ux, uy, uz, dist + SKIN, this.mask, hit
      );

      if (!ok) {
        this.position.x += dx;
        this.position.y += dy;
        this.position.z += dz;
        break;
      }

      blocked = true;
      const advance = Math.max(0, Math.min(hit.t - SKIN, dist));
      this.position.x += ux * advance;
      this.position.y += uy * advance;
      this.position.z += uz * advance;

      // remaining motion
      const rem = dist - advance;
      dx = ux * rem; dy = uy * rem; dz = uz * rem;

      const nx = hit.nx, ny = hit.ny, nz = hit.nz;
      this._classifyContact(nx, ny, nz, hit);
      // Note: steep contacts keep their vertical component on purpose. Zeroing
      // it (the usual "don't ramp up cliffs" hack) turns every stair nose into
      // a wall, because the bottom hemisphere always meets a step edge at a
      // shallow angle. Unwalkable surfaces are handled where they should be —
      // probeGround() reports grounded = false, so the caller keeps applying
      // gravity and the character slides straight back down.

      if (planeCount >= MAX_PLANES) break;
      planes[planeCount * 3] = nx;
      planes[planeCount * 3 + 1] = ny;
      planes[planeCount * 3 + 2] = nz;
      planeCount++;

      // Clip against every plane collected so far; if a single-plane projection
      // still violates another plane, slide along the crease of the two.
      let cx = dx, cy = dy, cz = dz;
      let resolved = false;
      for (let i = 0; i < planeCount && !resolved; i++) {
        const px = planes[i * 3], py = planes[i * 3 + 1], pz = planes[i * 3 + 2];
        if (dx * px + dy * py + dz * pz >= 0) continue;
        let tx = dx, ty = dy, tz = dz;
        const into = tx * px + ty * py + tz * pz;
        tx -= px * into; ty -= py * into; tz -= pz * into;
        let violates = -1;
        for (let j = 0; j < planeCount; j++) {
          if (j === i) continue;
          const qx = planes[j * 3], qy = planes[j * 3 + 1], qz = planes[j * 3 + 2];
          if (tx * qx + ty * qy + tz * qz < 0) { violates = j; break; }
        }
        if (violates < 0) {
          cx = tx; cy = ty; cz = tz;
          resolved = true;
        } else {
          // crease: travel along the intersection of the two planes
          const qx = planes[violates * 3], qy = planes[violates * 3 + 1], qz = planes[violates * 3 + 2];
          let ex = py * qz - pz * qy;
          let ey = pz * qx - px * qz;
          let ez = px * qy - py * qx;
          const el = Math.hypot(ex, ey, ez);
          if (el < 1e-6) { cx = cy = cz = 0; resolved = true; break; }
          ex /= el; ey /= el; ez /= el;
          const along = dx * ex + dy * ey + dz * ez;
          cx = ex * along; cy = ey * along; cz = ez * along;
          // Reject if the crease direction is blocked by a third plane.
          let bad = false;
          for (let j = 0; j < planeCount; j++) {
            const rx = planes[j * 3], ry = planes[j * 3 + 1], rz = planes[j * 3 + 2];
            if (cx * rx + cy * ry + cz * rz < -1e-6) { bad = true; break; }
          }
          if (bad) { cx = cy = cz = 0; }
          resolved = true;
        }
      }
      dx = cx; dy = cy; dz = cz;

      // Clip the caller's velocity the same way so accumulated speed doesn't
      // survive a wall impact.
      this._clipVelocity(nx, ny, nz);

      if (dx * dx + dy * dy + dz * dz < 1e-12) break;
    }
    this._planeCount = planeCount;
    this.lastMoveBlocked = blocked;
    return blocked;
  }

  _classifyContact(nx, ny, nz, hit) {
    if (ny >= this.cosSlope) {
      this.grounded = true;
      this.groundNormal.x = nx; this.groundNormal.y = ny; this.groundNormal.z = nz;
      this.groundSurface = hit.surface;
      this.groundObject = hit.object;
      this.onSteepSlope = false;
    } else if (ny < -0.5) {
      this.touchingCeiling = true;
    } else {
      this.touchingWall = true;
      this.wallNormal.x = nx; this.wallNormal.y = ny; this.wallNormal.z = nz;
      if (ny > 0.05) this.onSteepSlope = true;
    }
  }

  _clipVelocity(nx, ny, nz) {
    const v = this.velocity;
    const into = v.x * nx + v.y * ny + v.z * nz;
    if (into < 0) {
      v.x -= nx * into;
      v.y -= ny * into;
      v.z -= nz * into;
    }
  }

  /** Single swept translation with no sliding. Returns distance travelled. */
  _sweepMove(dx, dy, dz) {
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-7) return 0;
    const inv = 1 / dist;
    const ux = dx * inv, uy = dy * inv, uz = dz * inv;
    const hit = this._hit2;
    const ok = this.world.sweepCapsule(
      this.position.x, this.p0y, this.position.z,
      this.position.x, this.p1y, this.position.z,
      this.radius, ux, uy, uz, dist + SKIN, this.mask, hit
    );
    const adv = ok ? Math.max(0, Math.min(hit.t - SKIN, dist)) : dist;
    this.position.x += ux * adv;
    this.position.y += uy * adv;
    this.position.z += uz * adv;
    return adv;
  }

  /**
   * Sweep straight down up to `dist`. Returns the drop distance, or -1 if
   * nothing was hit (the capsule is then left where it started).
   * `radiusScale` shrinks the capsule for the trace — the step-up drop uses a
   * thinner probe so the bottom hemisphere settles onto a step tread instead of
   * hanging on its nose.
   */
  _sweepDown(dist, radiusScale = 1) {
    const hit = this._hit2;
    const r = this.radius * radiusScale;
    const ok = this.world.sweepCapsule(
      this.position.x, this.position.y + r, this.position.z,
      this.position.x, this.position.y + this.height - r, this.position.z,
      r, 0, -1, 0, dist + SKIN, this.mask, hit
    );
    if (!ok) return -1;
    const adv = Math.max(0, Math.min(hit.t - SKIN, dist));
    this.position.y -= adv;
    return adv;
  }

  /** Push the capsule out of anything it currently overlaps. */
  depenetrate(iterations = 4) {
    const w = this.world;
    let moved = 0;
    for (let it = 0; it < iterations; it++) {
      const n = w.overlapCapsule(
        this.position.x, this.p0y, this.position.z,
        this.position.x, this.p1y, this.position.z,
        this.radius, this.mask, 0
      );
      if (n === 0) break;
      const c = w.contacts;
      // Accumulate the maximum push along each distinct normal rather than the
      // sum — summing over a tessellated wall ejects the capsule across the map.
      let px = 0, py = 0, pz = 0;
      let deepest = 0;
      for (let i = 0; i < n; i++) {
        const d = c.depth[i];
        if (d <= 1e-5) continue;
        if (d > deepest) deepest = d;
        const nx = c.nx[i], ny = c.ny[i], nz = c.nz[i];
        const already = px * nx + py * ny + pz * nz;
        const extra = d - already;
        if (extra > 0) {
          px += nx * extra;
          py += ny * extra;
          pz += nz * extra;
        }
      }
      const l = Math.hypot(px, py, pz);
      if (l < 1e-5) break;
      /**
       * SHORTEST AXIS OUT, not the sum of every way out.
       *
       * The accumulation above resolves a crease correctly, but in a corner
       * where a dozen triangle normals fan out it can total several times the
       * deepest single overlap — and a push longer than the deepest overlap is,
       * by definition, further than any one contact needed. That is the launch.
       * Capping the length at the deepest contact makes this iteration a true
       * minimum-translation step along the least-buried axis and leaves the
       * remainder to the next one, which is why the loop runs 3-4 times.
       */
      const maxPush = Math.min(0.25, Math.max(deepest, 1e-3));
      const s = l > maxPush ? maxPush / l : 1;
      this.position.x += px * s;
      this.position.y += py * s;
      this.position.z += pz * s;
      moved += l * s;
      if (l < 1e-4) break;
    }
    return moved;
  }

  /**
   * Short downward sweep that publishes grounded state for this frame.
   *
   * Two traces on purpose. The thin one (60 % radius) finds the floor while
   * ignoring convex edges — without it, a character riding up a stair nose is
   * reported airborne because the nose is the nearest thing below and its
   * normal is steeper than the slope limit. The wide one is the fallback for
   * standing on a narrow beam, where the thin trace would miss entirely.
   */
  probeGround() {
    const probe = 0.06;
    const cos = this.cosSlope;
    const hit = this._hit;
    const w = this.world;

    const thin = w.sweepCapsule(
      this.position.x, this.position.y + this.radius * 0.6, this.position.z,
      this.position.x, this.position.y + this.height - this.radius * 0.6, this.position.z,
      this.radius * 0.6, 0, -1, 0, probe, this.mask, hit
    );

    let found = thin && hit.ny >= cos;
    if (!found) {
      const wide = w.sweepCapsule(
        this.position.x, this.p0y, this.position.z,
        this.position.x, this.p1y, this.position.z,
        this.radius * 0.98, 0, -1, 0, probe, this.mask, hit
      );
      // A surface with any meaningful upward component supports the capsule even if it
      // is too steep to be "walkable" — that is what a stair nose is.
      found = wide && hit.ny > 0.15;
    }

    if (found) {
      this.grounded = true;
      this.groundNormal.x = hit.nx;
      this.groundNormal.y = hit.ny;
      this.groundNormal.z = hit.nz;
      this.groundSurface = hit.surface;
      this.groundObject = hit.object;
      this.groundDistance = hit.t;
      this.onSteepSlope = hit.ny < cos;
    } else {
      this.grounded = false;
      this.groundDistance = hit.hit ? hit.t : Infinity;
      this.onSteepSlope = hit.hit && hit.ny > 0.05 && hit.ny < cos;
      if (hit.hit) {
        this.groundNormal.x = hit.nx;
        this.groundNormal.y = hit.ny;
        this.groundNormal.z = hit.nz;
        this.groundSurface = hit.surface;
      }
    }

    // Ceiling probe — the movement machine needs this to cancel a jump.
    const ch = this._hit2;
    this.touchingCeiling = this.world.sweepCapsule(
      this.position.x, this.p0y, this.position.z,
      this.position.x, this.p1y, this.position.z,
      this.radius * 0.98, 0, 1, 0, 0.06, this.mask, ch
    ) && ch.ny < -0.4;

    return this.grounded;
  }

  /** Friction coefficient of whatever the capsule is standing on. */
  get groundFriction() {
    return SURFACE_PROPS[this.groundSurface]?.friction ?? 0.9;
  }

  get groundSurfaceName() {
    return surfaceName(this.groundSurface);
  }

  /**
   * Can the character stand here? Used by AI spawn placement and by `player`
   * before a mantle/vault commits.
   */
  checkCapsule(x, y, z, height = this.height) {
    return (
      this.world.overlapCapsule(
        x, y + this.radius, z,
        x, y + height - this.radius, z,
        this.radius - 0.005, this.mask, 0
      ) === 0
    );
  }
}
