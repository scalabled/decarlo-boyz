import * as THREE from 'three';

/**
 * THE EMP COIL'S DISCHARGE — the signature toy.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT HAS TO DO, AND WHY IT IS NOT A DAMAGE TYPE
 * ---------------------------------------------------------------------------
 * DESIGN.md calls the EMP Coil "the signature toy: kills engines and lights".
 * Its 34 damage is incidental — the point is that a cruiser three metres behind
 * you goes dark and coasts. That is a VEHICLE state change, and it belongs to
 * `vehicles`, so this file is deliberately a thin, defensive adapter over the
 * public shape of a `Vehicle` rather than anything clever.
 *
 * What a Vehicle actually exposes (checked against `src/vehicles/`):
 *
 *   v.engineOn            bool. `dynamics.js` gates ALL drive torque on it.
 *   v.drivetrain.ignition bool. `drivetrain.js` zeroes throttle when false, so
 *                         an AI unit that keeps commanding throttle simply
 *                         fails to accelerate — no desync, no fighting.
 *   v.model.lampMats      per-VEHICLE emissive materials (a brake light must
 *                         light on this car and not the one in front), keyed
 *                         head/drl/tail/brake/reverse/indicator/policeRed/Blue.
 *   v.lightbarOn          the police lightbar switch.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THAT MAKES THIS WORK
 * ---------------------------------------------------------------------------
 * `vehicles._updateLamps()` RECOMPUTES every lamp's `emissiveIntensity` from
 * scratch every frame out of `v.destroyed` and the sun altitude. There is no
 * flag it reads that would let a third party say "this car is dark", and
 * writing `emissiveIntensity` from `update()` is stomped a few microseconds
 * later. So the blackout is re-asserted from `lateUpdate`, which the engine
 * runs after EVERY subsystem's `update()` — the last write before the frame is
 * drawn wins, and the moment the effect expires `vehicles` restores the lamps
 * itself on its very next frame with no restore logic here at all.
 *
 * The one thing that IS restored explicitly is `engineOn` / `ignition`, because
 * those are latched state rather than a per-frame recompute.
 */

const LAMP_KEYS = ['head', 'drl', 'tail', 'brake', 'reverse', 'indicator', 'policeRed', 'policeBlue'];

export class EmpField {
  constructor(ctx) {
    this.ctx = ctx;
    /** Vehicle -> { until, wasEngineOn, flash } */
    this.affected = new Map();
    this._expired = [];
    this._v = new THREE.Vector3();
    this._arcFrom = new THREE.Vector3();
    this._arcTo = new THREE.Vector3();
    this._arcPayload = { from: this._arcFrom, to: this._arcTo, speed: 900, weapon: null };
    this._flashPos = new THREE.Vector3();
    this._flashUntil = -1;
    this.stats = { discharges: 0, vehicles: 0 };
  }

  get vehicles() {
    if (this._veh === undefined) this._veh = this.ctx.peek('vehicles') ?? null;
    return this._veh;
  }

  /**
   * Dump the capacitor bank at `point`.
   *
   * @param {THREE.Vector3} point  where the slug landed
   * @param {number} radius        `empRadius` — the arc distance, not the splash
   * @param {number} seconds       `empSeconds`
   * @returns {number} how many vehicles it caught
   */
  discharge(point, radius, seconds) {
    const veh = this.vehicles;
    this.stats.discharges++;
    /* The flash is worth firing even with nothing in range: it is the feedback
     * that says the weapon did its thing. */
    this._flash(point);
    if (!veh?.vehicles) return 0;

    const now = this.ctx.time.elapsed;
    const r2 = radius * radius;
    let caught = 0;
    for (let i = 0; i < veh.vehicles.length; i++) {
      const v = veh.vehicles[i];
      if (!v?.position || v.destroyed) continue;
      const dx = v.position.x - point.x;
      const dy = v.position.y - point.y;
      const dz = v.position.z - point.z;
      /* A car is 4-5 m long, so a strict centre-of-mass test under-reads by
       * half a car length at every angle. Give it its own bounding radius. */
      const reach = radius + (v.boundingRadius ?? 2.2);
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      caught++;
      let rec = this.affected.get(v);
      if (!rec) {
        rec = { until: 0, wasEngineOn: v.engineOn !== false };
        this.affected.set(v, rec);
      }
      rec.until = Math.max(rec.until, now + seconds);
      /* Arc from the strike to every car it reaches. `bullet:tracer` is the
       * only canonical event that draws a bright line between two points, and
       * a capacitor discharge is exactly that. */
      this._arc(point, v.position);
    }
    this.stats.vehicles = this.affected.size;
    return caught;
  }

  /** Re-assert the blackout. MUST be called from `lateUpdate`. */
  lateUpdate() {
    const now = this.ctx.time.elapsed;
    if (now < this._flashUntil) this._submitFlash(1 - (this._flashUntil - now) / 0.22);
    if (this.affected.size === 0) return;
    this._expired.length = 0;
    for (const [v, rec] of this.affected) {
      if (now >= rec.until || !v.position) {
        this._expired.push(v);
        continue;
      }
      /* --- engine --- */
      v.engineOn = false;
      if (v.drivetrain) {
        v.drivetrain.ignition = false;
        /* `stalled` is declared in drivetrain.js and read by nothing today;
         * set it anyway so that when `vehicles` grows a stall behaviour this
         * weapon is already speaking its language. */
        v.drivetrain.stalled = true;
      }
      if (v.input) {
        v.input.throttle = 0;
        v.input.boost = 0;
      }
      /* --- lights --- */
      const lamps = v.model?.lampMats;
      if (lamps) {
        for (let i = 0; i < LAMP_KEYS.length; i++) {
          const m = lamps[LAMP_KEYS[i]];
          if (m) m.emissiveIntensity = 0;
        }
      }
      v.lightbarOn = false;
    }
    for (let i = 0; i < this._expired.length; i++) {
      const v = this._expired[i];
      const rec = this.affected.get(v);
      this.affected.delete(v);
      if (!v || v.destroyed) continue;
      v.engineOn = rec?.wasEngineOn ?? true;
      if (v.drivetrain) {
        v.drivetrain.ignition = true;
        v.drivetrain.stalled = false;
      }
    }
    this.stats.vehicles = this.affected.size;
  }

  /** Is this vehicle currently dead? Read by `game` / debug. */
  isDown(v) {
    const rec = this.affected.get(v);
    return !!rec && this.ctx.time.elapsed < rec.until;
  }

  _arc(from, to) {
    this._arcFrom.copy(from);
    this._arcTo.copy(to);
    this._arcTo.y += 0.55;
    this._arcPayload.speed = 1400;
    this.ctx.events.emit('bullet:tracer', this._arcPayload);
  }

  /**
   * One frame of real light at the strike. `submitLight` is the sanctioned way
   * to get a punctual light in this engine without changing the visible light
   * count and recompiling every material in the city (ARCHITECTURE.md).
   */
  _flash(point) {
    this._flashPos.copy(point);
    this._flashUntil = this.ctx.time.elapsed + 0.22;
  }

  _submitFlash(t) {
    const r = this.ctx.peek('render');
    if (!r?.submitLight) return;
    /* Cold blue-white and high priority: for a fifth of a second it is the
     * brightest thing in the frame. Submitted EVERY frame it is alive —
     * `submitLight` is a per-frame candidate for one of `q.lightSlots`, not a
     * light you create and keep, so a single call at the moment of discharge
     * would be visible for exactly one frame and read as a flicker. */
    const p = this._flashPos;
    r.submitLight(p.x, p.y + 0.4, p.z, 0x9fd8ff, 260 * (1 - t) * (1 - t), 18, 3, 'emp');
  }

  clear() {
    for (const [v, rec] of this.affected) {
      if (!v || v.destroyed) continue;
      v.engineOn = rec?.wasEngineOn ?? true;
      if (v.drivetrain) { v.drivetrain.ignition = true; v.drivetrain.stalled = false; }
    }
    this.affected.clear();
  }

  dispose() {
    this.clear();
  }
}
