import * as THREE from 'three';

/**
 * BULLETS vs VEHICLES.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FIXES
 * ---------------------------------------------------------------------------
 * Rounds hit pedestrians, police, mission hostiles, the player and the city,
 * and passed **straight through every car in Steel City**. In a game whose map
 * is a third rivers and two thirds road, and whose police escalation is a car
 * chase, that meant you could empty a Shop SMG into a pursuing cruiser and
 * watch the nails land on the wall behind it.
 *
 * The cause is structural rather than a typo: `physics` only knows about
 * triangles it has been handed and `addCollider` hitboxes somebody registered,
 * and `vehicles` registers neither — its bodies are solved by its own dynamics.
 * So `phys.raycast(..., MASK.BULLET)` has never had anything to hit.
 *
 * ---------------------------------------------------------------------------
 * WHY IT LIVES IN `weapons` AND NOT IN `physics` OR `vehicles`
 * ---------------------------------------------------------------------------
 * `src/vehicles/` has a live agent and hard rule 1 says not to edit it. It
 * already publishes everything needed — `veh.vehicles` (the live array),
 * `v.position`, `v.quaternion`, `v.destroyed`, `v.spec` (L x W x H from
 * DESIGN.md) and `damage(vehicle, amount, point)` — so the test belongs on the
 * side that owns the projectile. Nothing here writes vehicle state directly:
 * damage goes through the published API, which is what raises
 * `vehicle:destroyed` and drives the deformation.
 *
 * ---------------------------------------------------------------------------
 * THE TEST
 * ---------------------------------------------------------------------------
 * One projectile step is a short segment. For each candidate vehicle the
 * segment is taken into the vehicle's own frame by the conjugate of its
 * quaternion and clipped against an axis-aligned slab — the classic ray/OBB
 * solve, done in local space so the box can be the real oriented body rather
 * than a sphere or a world AABB. A sphere would have a Millhand 6 (7.2 x 2.6 x
 * 2.9 m) swallowing rounds 2 m off its flank; a world AABB would do the same
 * for anything parked diagonally.
 *
 * The body is inset slightly (`SHRINK`) and lifted off the road by the wheel
 * radius, so a round that grazes just under the sill still reaches the kerb
 * behind it instead of stopping in mid-air under the chassis.
 *
 * Everything is preallocated (rule 5) and the whole thing is skipped outright
 * when no vehicle's bounding sphere overlaps the segment, which is the common
 * case on foot.
 *
 * ---------------------------------------------------------------------------
 * TWO SCALES, TWO OWNERS — READ THIS BEFORE TOUCHING A NUMBER BELOW
 * ---------------------------------------------------------------------------
 * A weapon's `damage` is in ACTOR points: 20 for a nail, into ~100-point
 * pedestrians. A vehicle body is priced 90-3000 (`vehicles/specs.js`
 * `body.hp`). Turning one into the other takes two independent facts, and they
 * belong to different subsystems:
 *
 *   TRANSFER   how much of a round a car eats rather than a man. A weapons
 *              fact, and it lives here: 0.8 for a bullet, 0.5 for a swing.
 *   SCALE      the ratio between the two health scales. A VEHICLES fact, and
 *              it is read at runtime off `veh.actorDamageScale` — never copied
 *              here, because the day the body scale moves this file must not be
 *              the place that silently disagrees.
 *
 * `DAMAGE_SCALE` used to be a single 0.6 doing the job of both, which meant it
 * was doing the job of neither: 12 points per nail into a 900-point sedan is 75
 * nails and 16.5 seconds of continuous fire to wreck a parked car, and seven
 * Scrap Rockets that leave it running. `src/vehicles/damageprobe.mjs` gates the
 * outcome in rounds and swings rather than in coefficients.
 *
 * ---------------------------------------------------------------------------
 * ...AND THERE IS A THIRD PLACE THE SCALE MATTERS, WHICH IS NOT DAMAGE AT ALL
 * ---------------------------------------------------------------------------
 * `bullet:impact.damage` is an ACTOR-scale slot. Four subsystems size an effect
 * off it and every one of them was authored against ~100-point actors:
 *
 *   fx/index.js:462     energy = clamp(0.7 + damage/55, 0.7, 1.7)
 *   audio/index.js      energy = clamp(damage/34, 0.35, 1.5)
 *   peds, traffic       startle radius
 *
 * When `ACTOR_TO_VEHICLE` went from an implicit 0.6 to 10, both call sites here
 * were still handing that slot the number they had just given `vehicles.damage`
 * — a VEHICLE-scale number. MEASURED on the emitted particles: every round and
 * every swing on a car came out at the 1.7 CEILING (nailgun, SMG, rivet gun,
 * speargun, harpoon, pipe, crowbar, wrench — all of them, one number), where a
 * nail on concrete emits 1.06 and an SMG round 0.99. Every hit on every car in
 * Steel City threw the identical maximal spark burst, and the arsenal stopped
 * being legible on sheet metal.
 *
 * So `_apply` publishes BOTH numbers, named, in `this.dealt`, and the FX slot
 * gets the actor one. The scale is carried explicitly rather than inferred from
 * which variable happens to be in scope. `src/fx/sparkprobe.mjs` gates it on
 * the emitted particles, not on these coefficients.
 */

/**
 * Fraction of a ROUND's damage a vehicle body takes, before the scale
 * conversion. Sheet metal and glass eat some of a nail, a tack or a 9x19.
 */
export const BULLET_TRANSFER = 0.8;

/**
 * ...and of a SWING. A wrench does half to a car what it does to a man, which
 * is also what stops a melee weapon out-performing the Scrap Rocket as a
 * car-opener.
 */
export const MELEE_TRANSFER = 0.5;

/** Metres the collision box is inset from the spec envelope, per axis. */
const SHRINK = 0.06;

/**
 * How far past a swing's own `reach` a vehicle still counts. A centre-to-centre
 * test needs a large allowance (about `reach + 1.6`); the swing here is solved
 * against the real oriented body, so this is a much smaller allowance for the
 * arm and the weapon head being ahead of the chest the arc is measured from.
 */
const SWING_BODY_MARGIN = 0.35;

export class VehicleHitTest {
  constructor(ctx) {
    this.ctx = ctx;
    this.veh = null;
    /** Set true by the gate's negative control to restore the pass-through. */
    this.disabled = false;
    /**
     * NEGATIVE CONTROL, and nothing but `src/fx/sparkprobe.mjs` reads it: set
     * true to fill `dealt.actorPoints` with the VEHICLE-scale number, which is
     * the shipped bug the header describes. Restores the saturated spark burst.
     */
    this.fxVehicleScale = false;
    this.stats = { tests: 0, hits: 0, damage: 0 };

    /**
     * THE LAST HIT, IN BOTH CURRENCIES. Preallocated (rule 5) and overwritten
     * by every `_apply` — read it on the line after the call, never stash the
     * reference.
     *
     *   vehiclePoints  what `vehicles.damage()` was given, in the vehicle's own
     *                  90-3000 body-hp currency.
     *   actorPoints    the SAME hit in the ~100-point actor currency, which is
     *                  what `bullet:impact.damage` means and what `fx` and
     *                  `audio` size their effects against.
     *
     * They differ by `veh.actorDamageScale` (10 today). Nothing in JavaScript
     * will catch you confusing them; the names are the whole defence.
     */
    this.dealt = { vehiclePoints: 0, actorPoints: 0 };

    /* Preallocated scratch — this runs per projectile per fixed step. */
    this._q = new THREE.Quaternion();
    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._half = new THREE.Vector3();
    this._localN = new THREE.Vector3();
    /** Scratch for the swing sweep — see `sweep`. */
    this._sw = new THREE.Vector3();
    this._swFlat = new THREE.Vector3();
    this._swPoint = new THREE.Vector3();
    this._swNormal = new THREE.Vector3();
    /** The oriented body box, filled by `_box`. */
    this._b = { halfX: 0, halfY: 0, halfZ: 0, centreY: 0, radius: 0 };
    this._hit = {
      hit: true, vehicle: null, distance: 0,
      point: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      surface: 'carpaint', surfaceIndex: 0,
      object: null, body: null, actor: null, part: null, collider: null,
    };
  }

  _system() {
    if (!this.veh) this.veh = this.ctx.peek('vehicles');
    return this.veh;
  }

  /**
   * The oriented body box, in the vehicle's own frame, written into `this._b`.
   *
   * ONE OWNER FOR ONE FACT. `cast` and `sweep` must agree to the centimetre
   * about where a car is: two copies of this arithmetic is how a round stops on
   * a door that a wrench passes straight through.
   *
   * Local axes, stated once because getting them wrong is silent: a vehicle's
   * NOSE is +Z (`dynamics.js` takes forwardSpeed along +Z), so length maps to
   * z, width to x, height to y.
   *
   * `v.position` IS THE CENTRE OF MASS, NOT THE CENTRE OF THE BODY.
   * `dynamics.js` sits the origin at `spec.comY` above the ground (0.40 m on a
   * Peregrine GT, 0.88 m on a Millhand 6) and measures the floor and roof from
   * it. A box centred on the origin would hang half a metre below the sills and
   * stop short of the roof — rounds would pass over every bonnet and stop in
   * the tarmac under every car. Take the real floor-to-roof span and centre the
   * slab on ITS middle.
   *
   * @returns the box, or null if the vehicle has no usable spec.
   */
  _box(v) {
    const s = v.spec;
    if (!s) return null;
    const dims = s.dims ?? {};
    const b = this._b;
    b.halfX = Math.max(0.05, (dims.W ?? 2.0) * 0.5 - SHRINK);
    b.halfZ = Math.max(0.05, (dims.L ?? 4.6) * 0.5 - SHRINK);
    const floorY = (s.style?.groundY ?? 0.14) - (s.comY ?? 0.45);
    const roofY = (s.style?.roofY ?? dims.H ?? 1.4) - (s.comY ?? 0.45);
    b.centreY = (floorY + roofY) * 0.5;
    b.halfY = Math.max(0.05, (roofY - floorY) * 0.5 - SHRINK);
    b.radius = Math.hypot(b.halfX, b.halfY + Math.abs(b.centreY), b.halfZ);
    return b;
  }

  /**
   * Nearest vehicle intersection along `from -> from + dir * len`.
   *
   * @returns a hit record shaped like `physics.raycast`'s (so `_impact` and
   *          `emitImpact` can consume it unchanged) or null.
   */
  cast(from, dir, len) {
    if (this.disabled) return null;
    const veh = this._system();
    const list = veh?.vehicles;
    if (!list || list.length === 0) return null;

    let best = Infinity;
    let bestV = null;
    let bestNx = 0, bestNy = 0, bestNz = 0;

    /* Segment midpoint + radius, for the broadphase reject. */
    const mx = from.x + dir.x * len * 0.5;
    const my = from.y + dir.y * len * 0.5;
    const mz = from.z + dir.z * len * 0.5;
    const segR = len * 0.5;

    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      /* A wreck is already out of the fight: rounds pass through it, which
       * also stops a burning shell from soaking a magazine. */
      if (!v || v.destroyed || v._staged) continue;
      const p = v.position;
      if (!p) continue;
      const b = this._box(v);
      if (!b) continue;
      const { halfX, halfY, halfZ, centreY } = b;

      /* Broadphase: bounding spheres of the segment and the body. */
      const bodyR = b.radius;
      const dx = p.x - mx, dy = p.y - my, dz = p.z - mz;
      if (dx * dx + dy * dy + dz * dz > (segR + bodyR) * (segR + bodyR)) continue;

      this.stats.tests++;

      /* World -> body local, then slide the origin onto the box centre. */
      this._q.copy(v.quaternion).conjugate();
      this._o.set(from.x - p.x, from.y - p.y, from.z - p.z).applyQuaternion(this._q);
      this._o.y -= centreY;
      this._d.copy(dir).applyQuaternion(this._q);
      this._half.set(halfX, halfY, halfZ);

      const t = this._slab(this._o, this._d, this._half, len);
      if (t === null || t >= best) continue;

      best = t;
      bestV = v;
      /* The slab solve leaves the local normal in `_localN`; back to world. */
      this._q.copy(v.quaternion);
      this._localN.applyQuaternion(this._q);
      bestNx = this._localN.x; bestNy = this._localN.y; bestNz = this._localN.z;
    }

    if (!bestV) return null;

    const h = this._hit;
    h.vehicle = bestV;
    h.distance = best;
    h.point.set(from.x + dir.x * best, from.y + dir.y * best, from.z + dir.z * best);
    h.normal.set(bestNx, bestNy, bestNz);
    h.object = bestV.model?.root ?? null;
    h.body = bestV;
    h.actor = null;
    h.part = null;
    h.collider = null;
    this.stats.hits++;
    return h;
  }

  /**
   * Ray vs axis-aligned box centred on the origin. Writes the entry face's
   * outward normal into `_localN`. Returns the entry distance, or null.
   */
  _slab(o, d, half, maxT) {
    let tmin = 0;
    let tmax = maxT;
    let axis = -1;
    let sign = 1;
    for (let a = 0; a < 3; a++) {
      const oa = a === 0 ? o.x : a === 1 ? o.y : o.z;
      const da = a === 0 ? d.x : a === 1 ? d.y : d.z;
      const ha = a === 0 ? half.x : a === 1 ? half.y : half.z;
      if (Math.abs(da) < 1e-8) {
        if (oa < -ha || oa > ha) return null;
        continue;
      }
      const inv = 1 / da;
      let t1 = (-ha - oa) * inv;
      let t2 = (ha - oa) * inv;
      let s = -1;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
      if (t1 > tmin) { tmin = t1; axis = a; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    /* Started inside the body (a muzzle inside a car during a drive-by): no
     * entry face, and the round should leave rather than detonate on the boot
     * lid of the car the shooter is sitting in. */
    if (axis < 0) return null;
    this._localN.set(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
    return tmin;
  }

  /**
   * Apply a round's damage to a vehicle through the published API.
   *
   * `damage` arrives in ACTOR points (a weapon's own `def.damage`); it leaves
   * in this vehicle's health points. See the two-scales note in the header —
   * the transfer is ours, the scale is read off `vehicles` so that only one
   * subsystem owns it.
   *
   * @returns the damage actually dealt, in the vehicle's own points. The SAME
   *          hit in actor points — which is what every `bullet:impact` consumer
   *          means by `damage` — is `this.dealt.actorPoints`, valid until the
   *          next call.
   */
  apply(vehicle, damage, point) {
    return this._apply(vehicle, damage, BULLET_TRANSFER, point);
  }

  _apply(vehicle, damage, transfer, point) {
    const d = this.dealt;
    d.vehiclePoints = 0;
    d.actorPoints = 0;
    const veh = this._system();
    if (!veh?.damage || !vehicle || vehicle.destroyed) return 0;
    /**
     * ONE HIT, TWO CURRENCIES, BOTH NAMED. The transfer is a weapons fact and
     * applies in either scale; only `actorDamageScale` crosses between them, so
     * the actor number is computed FIRST and the vehicle number is derived from
     * it. Nothing downstream has to divide anything back, and no call site has
     * to know which of the two it is holding.
     */
    const actor = Math.max(0, damage) * transfer;
    const dealt = actor * (veh.actorDamageScale ?? 1);
    veh.damage(vehicle, dealt, point);
    this.stats.damage += dealt;
    d.vehiclePoints = dealt;
    d.actorPoints = this.fxVehicleScale ? dealt : actor;
    return dealt;
  }

  /**
   * MELEE vs VEHICLES — the swing arc against the real oriented bodies.
   *
   * ---------------------------------------------------------------------
   * WHAT WAS MISSING
   * ---------------------------------------------------------------------
   * `melee.js` resolves a swing with `physics.raycast(..., MASK.BULLET)`, and
   * cars are not in `physics` — the same structural hole this whole file exists
   * to close, but on the swing path rather than the projectile path. So hitting
   * a car with the Body Wrench did NOTHING: no damage, no dent, no spark, no
   * report. The arm animated and the wrench passed through the door as if the
   * car were a hologram.
   *
   * ---------------------------------------------------------------------
   * THE TEST
   * ---------------------------------------------------------------------
   * A centre-to-centre distance with no arc lets you wrench a car behind you.
   * The oriented body is available here, so this asks the honest question: the
   * CLOSEST POINT ON THE BODY BOX to the swing origin, in the vehicle's own
   * frame, must be inside `reach`, and the direction to it must be inside the
   * weapon's own `arcDeg`. That is the same envelope `melee.js`'s ray fan sweeps, expressed
   * against a box instead of a capsule.
   *
   * A vehicle whose box CONTAINS the origin is skipped: that is the shooter's
   * own car, and detonating the boot lid of the thing you are sitting in is the
   * `_slab` "started inside the body" rule again.
   *
   * @param origin   world point the swing is measured from (the chest)
   * @param forward  unit vector the swing is aimed down
   * @param def      the finalised weapon (`reach`, `arcDeg`, `damage`)
   * @param side     -1 / +1, which shoulder — accepted for parity with
   *                 `MeleeSolver.strike`; the arc is symmetric about `forward`
   *                 so it does not change what is inside it.
   * @returns total damage dealt, in vehicle points. 0 if the swing found no car.
   */
  sweep(origin, forward, def, side = 1) {
    if (this.disabled) return 0;
    const veh = this._system();
    const list = veh?.vehicles;
    if (!list || list.length === 0) return 0;

    const reach = (def?.reach ?? 3) + SWING_BODY_MARGIN;
    /* Half the arc, as a cosine against the flattened bearing. `melee.js` casts
     * its fan over the full `arcDeg`, so this is the same envelope. */
    const cosHalf = Math.cos(((def?.arcDeg ?? 70) * 0.5 * Math.PI) / 180);
    const reach2 = reach * reach;
    let total = 0;

    this._swFlat.set(forward.x, 0, forward.z);
    if (this._swFlat.lengthSq() < 1e-8) return 0;
    this._swFlat.normalize();

    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!v || v.destroyed || v._staged) continue;
      const p = v.position;
      if (!p) continue;

      /* Cheap reject before the quaternion work. */
      const gx = p.x - origin.x, gy = p.y - origin.y, gz = p.z - origin.z;
      const b = this._box(v);
      if (!b) continue;
      const gross = reach + b.radius;
      if (gx * gx + gy * gy + gz * gz > gross * gross) continue;

      /* Origin into the body's frame, relative to the box centre. */
      this._q.copy(v.quaternion).conjugate();
      this._sw.set(-gx, -gy, -gz).applyQuaternion(this._q);
      this._sw.y -= b.centreY;

      /* Closest point on the box to the origin, still in local space. */
      const cx = Math.max(-b.halfX, Math.min(b.halfX, this._sw.x));
      const cy = Math.max(-b.halfY, Math.min(b.halfY, this._sw.y));
      const cz = Math.max(-b.halfZ, Math.min(b.halfZ, this._sw.z));
      const ox = this._sw.x - cx, oy = this._sw.y - cy, oz = this._sw.z - cz;
      const d2 = ox * ox + oy * oy + oz * oz;
      /* Inside the body: this is the car the swinger is sitting in. */
      if (d2 < 1e-8) continue;
      if (d2 > reach2) continue;

      /* Back to world, so the arc test and the FX both use the real contact. */
      this._q.copy(v.quaternion);
      this._swPoint.set(cx, cy + b.centreY, cz).applyQuaternion(this._q).add(p);
      this._sw.set(this._swPoint.x - origin.x, 0, this._swPoint.z - origin.z);
      const flat = this._sw.length();
      if (flat > 1e-5 && this._sw.divideScalar(flat).dot(this._swFlat) < cosHalf) continue;

      /**
       * The contact normal, pointing OUT of the panel — the same convention
       * `_slab` writes for a round's entry face and the one `bullet:impact`
       * consumers expect. `(ox, oy, oz)` already runs from the closest point on
       * the box toward the swinger, which IS outward; negating it would spray
       * the sparks into the door.
       */
      this._swNormal.set(ox, oy, oz).applyQuaternion(this._q).normalize();

      const dealt = this._apply(v, def?.damage ?? 0, MELEE_TRANSFER, this._swPoint);
      if (dealt <= 0) continue;
      total += dealt;
      this.stats.hits++;

      /**
       * A swing that damages a car with no spark and no report is worse than
       * one that passes through, because the player cannot tell it landed —
       * exactly the note `ballistics` leaves on the projectile path. `fx`,
       * `audio` and the decal system all listen for this.
       *
       * `damage` here is the ACTOR-scale slot, NOT `dealt`. Handing it `dealt`
       * put every swing on a car at the spark system's 1.7 ceiling — see the
       * third-scale note in the header.
       */
      const phys = this.ctx.peek('physics');
      phys?.emitImpact?.(
        this._swPoint.x, this._swPoint.y, this._swPoint.z,
        this._swNormal.x, this._swNormal.y, this._swNormal.z,
        this._swFlat.x, 0, this._swFlat.z,
        phys.SURFACE?.carpaint ?? 0,
        this.dealt.actorPoints, false, null
      );
    }
    return total;
  }
}
