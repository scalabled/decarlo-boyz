import * as THREE from 'three';
import { P } from './atlas.js';
import { resetSpawn } from './particles.js';
import { clamp } from './util.js';
/**
 * WHAT RAIN DOES WHEN IT ARRIVES.
 *
 * `sky` owns the falling water — the airborne streaks, the wind-driven volume
 * around the camera and the lightning — because the rate, the wind vector and
 * the scattering that lights a drop all come out of its weather state. This
 * file owns everything downstream of the drop landing, which is the half that
 * actually makes a street read as wet:
 *
 *  1. **Splash rings and micro-ripples** where drops land. A scene reads as wet
 *     because of what is happening ON the ground, not because of lines drawn in
 *     the air, and this is by far the larger population.
 *  2. **The bounce layer** — the sheet of rebound mist sitting 10 cm off the
 *     tarmac. Individual rings are sub-pixel past a few metres; this is what
 *     carries the read at distance.
 *  3. **Road spray** thrown from the wheels of every moving vehicle. In GTA V
 *     this is the single biggest reason wet traffic reads as wet.
 *  4. **Drips** off ledges, wires and awnings, landing with their own splash —
 *     scheduled with `delay`, so the CPU touches a drip exactly once.
 *  5. **Puddle strikes** — the sheet of water a wheel throws out of standing
 *     water, and the ripple it leaves behind.
 *  6. **The windscreen** — beads that gather, run, and are swept away together
 *     on the wiper period.
 *
 * Driven by `weather:change { state, wetness, rain, wind, windAngle, windX,
 * windZ, lightning, ... }` and costs exactly nothing when `rain` and `wetness`
 * are both 0.
 *
 * NOTE ON UNITS: nothing in here converts a published ambient into a colour.
 * The lit-particle shader owns that conversion and applies the 1/PI that turns
 * an irradiance into a radiance (see particles.js); a recipe that reads
 * `fx._ambTop` and uses it directly as a colour would be 3.14x too bright.
 */
export class RainSystem {
  /**
   * @param {object} fx
   */
  constructor(fx) {
    this.fx = fx;
    /** 0..1 falling-rain intensity, mirrored from `sky`. Drives splash rate. */
    this.rain = 0;
    /** 0..1 how saturated the world is (lags `rain` by minutes). */
    this.wetness = 0;
    this.state = 'clear';
    this._target = 0;
    this._targetWet = 0;

    // ---- CPU-side emitters ----
    this.splashAcc = 0;
    this.dripAcc = 0;
    this.sprayAcc = 0;
    this.beadAcc = 0;
    this.wipeAt = 0;
    this.wipePeriod = 2.35;
    this._indoor = 0;
    this._indoorTarget = 0;
    this._indoorTimer = 0;
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._probe = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._inVehicle = false;
  }
  /* ===================================================================== */

  /**
   * `weather:change`. `sky` publishes the full vector — `{ state, wetness,
   * rain, wind, windAngle, windX, windZ, lightning, cloudCoverage,
   * fogDensity, transition }` — but this side only needs the two rates, and
   * falls back to the state name for a publisher that sends nothing else.
   */
  onWeather(e) {
    if (!e) return;
    if (e.state) this.state = e.state;
    if (e.rain !== undefined) this._target = clamp(e.rain, 0, 1);
    else if (e.state) this._target = STATE_RAIN[e.state] ?? this._target;
    this._targetWet = e.wetness !== undefined ? clamp(e.wetness, 0, 1) : this._target;
  }

  /** Snap straight to a state — the capture harness has 90 frames, not minutes. */
  setImmediate(rain, wetness) {
    this._target = clamp(rain, 0, 1);
    this._targetWet = clamp(wetness ?? rain, 0, 1);
    this.rain = this._target;
    this.wetness = this._targetWet;
  }

  /* ===================================================================== */

  update(dt, now, camera) {
    // Rain starts and stops in seconds; the ground stays wet for minutes.
    this.rain += (this._target - this.rain) * Math.min(1, dt * 0.9);
    this.wetness += (this._targetWet - this.wetness) * Math.min(1, dt * 0.14);
    if (Math.abs(this.rain - this._target) < 0.002) this.rain = this._target;

    const fx = this.fx;
    if (this.rain < 0.01 && this.wetness < 0.01) return;
    camera.getWorldPosition(this._camPos);

    // Is there a roof over us? Splashes landing on the deck of a multi-storey
    // car park is the sort of thing a critic spots in one frame.
    this._indoorTimer -= dt;
    if (this._indoorTimer <= 0) {
      this._indoorTimer = 0.3;
      let covered = 0;
      const ph = fx.physics;
      if (ph?.raycast) {
        this._probe.copy(this._camPos);
        this._probe.y += 0.4;
        const hit = ph.raycast(this._probe, this._up, 26, ph.MASK.WORLD);
        if (hit?.hit) covered = 1;
      }
      this._indoorTarget = covered;
    }
    this._indoor += (this._indoorTarget - this._indoor) * Math.min(1, dt * 4);

    const vis = this.rain * (1 - this._indoor * 0.94);
    if (vis <= 0.01) return;

    this._splashes(dt, now, camera, vis);
    this._drips(dt, now, camera, vis);
    if (this._inVehicle) this._beads(dt, now, vis);
  }

  /**
   * A wheel going through standing water: the thrown sheet and the ripple.
   *
   * Called by the FX system when a vehicle crosses a surface `world` reports as
   * water, or when `vehicle:skid` reports the `water` surface. Much heavier and
   * much more directional than road spray — this is displaced water, not mist.
   */
  puddleHit(x, y, z, vx, vy, vz, speed, dt, now, gain = 1) {
    const fx = this.fx;
    const rng = fx.rng;
    if (speed < 2) return 0;
    const load = clamp((speed - 2) / 16, 0, 1.4) * gain;
    this.sprayAcc += dt * 90 * load * fx.pScale;
    let n = Math.min(10, Math.floor(this.sprayAcc));
    this.sprayAcc -= n;
    if (n <= 0) return 0;
    const inv = 1 / speed;
    const lx = -vz * inv;
    const lz = vx * inv;
    for (let i = 0; i < n; i++) {
      const side = rng.float() < 0.5 ? -1 : 1;
      const s = resetSpawn();
      s.x = x + rng.signed() * 0.1;
      s.y = y + rng.range(0.01, 0.08);
      s.z = z + rng.signed() * 0.1;
      // Displaced water leaves nearly sideways and FAST — a bow wave, not mist.
      s.vx = vx * rng.range(0.18, 0.42) + lx * side * rng.range(3, 8) * load;
      s.vy = rng.range(1.6, 4.4) * load;
      s.vz = vz * rng.range(0.18, 0.42) + lz * side * rng.range(3, 8) * load;
      s.tile = rng.float() < 0.6 ? P.SPRAY : P.SPLASH;
      s.size0 = rng.range(0.13, 0.3);
      s.size1 = rng.range(0.5, 1.2);
      s.sizeCurve = 0.5;
      s.stretch = 0.15;
      s.life = rng.range(0.4, 0.9);
      s.delay = -rng.float() * dt;
      s.drag = 2.0;
      s.gravity = -14;
      s.rot = rng.float() * 6.2831853;
      s.spin = rng.signed() * 1.4;
      const b = rng.range(0.6, 0.86);
      s.r0 = b * 0.94; s.g0 = b * 0.99; s.b0 = b;
      s.r1 = b * 0.68; s.g1 = b * 0.72; s.b1 = b * 0.78;
      s.alpha = rng.range(0.3, 0.65);
      s.alphaCurve = 1.3;
      s.soft = 0.16;
      s.fadeIn = 0.03;
      s.lightGain = 2.2;
      s.seed = rng.float();
      fx.emitLit(s);
    }
    // the wake ring left on the standing water
    if (rng.float() < 0.4) {
      const r = resetSpawn();
      r.x = x; r.y = y + 0.008; r.z = z;
      r.tile = P.RING;
      r.size0 = 0.1;
      r.size1 = rng.range(0.9, 1.9);
      r.sizeCurve = 0.45;
      r.life = rng.range(0.7, 1.3);
      r.drag = 4;
      r.rot = rng.float() * 6.2831853;
      r.flags = 2; // ground-aligned
      r.r0 = 0.6; r.g0 = 0.64; r.b0 = 0.68;
      r.r1 = 0.4; r.g1 = 0.43; r.b1 = 0.47;
      r.alpha = rng.range(0.22, 0.4);
      r.alphaCurve = 1.5;
      r.soft = 0.1;
      r.fadeIn = 0.06;
      r.lightGain = 2.2;
      r.seed = rng.float();
      fx.emitLit(r);
    }
    return n;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Splash rings and micro ripples on the ground around the camera.
   *
   * Ground-aligned (SP.flags bit 1), because a splash is a mark on a surface.
   * Two populations: a few real crowns with a visible ring and a droplet or two,
   * and a much larger number of near-invisible micro ripples — it is the second
   * population that carries the read at a distance, exactly like real rain.
   */
  _splashes(dt, now, camera, vis) {
    const fx = this.fx;
    const rng = fx.rng;
    const ph = fx.physics;
    // MEASURED: at 300 splashes/s over a 17 m disc the ground carried 0.1 rings
    // per square metre and the storm landed on nothing. Heavy rain covers a road
    // in rings; this is the population that makes a scene read as WET rather
    // than as a dry scene with lines drawn over it, so it gets the budget.
    this.splashAcc += dt * 1250 * vis * fx.pScale;
    let n = Math.min(90, Math.floor(this.splashAcc));
    this.splashAcc -= n;
    if (n <= 0) return;
    camera.getWorldDirection(this._fwd);
    const cx = camera.position.x + this._fwd.x * 5;
    const cz = camera.position.z + this._fwd.z * 5;
    const cy = camera.position.y;
    for (let i = 0; i < n; i++) {
      // Biased toward the camera: density falls off with distance anyway and
      // a splash 20 m away is one pixel.
      const rr = Math.pow(rng.float(), 0.6) * 13;
      const a = rng.float() * 6.2831853;
      const x = cx + Math.cos(a) * rr;
      const z = cz + Math.sin(a) * rr;
      let y = cy - 1.7;
      if (ph?.groundHeight) {
        const g = ph.groundHeight(x, z, cy + 3);
        if (!Number.isFinite(g)) continue;
        // A splash 6 m above or below the camera is on a roof we cannot see.
        if (g > cy + 1.2 || g < cy - 9) continue;
        y = g;
      }
      const big = rng.float() < 0.3;
      const near = rr < 6;
      // Close to the eye a ripple is resolved as a GEOMETRIC CIRCLE, and a
      // 25 cm annulus two metres away photographs as a white washer lying on the
      // road. Real close-range ripples are small, faint and mostly perturbation.
      // Everything within 5 m therefore shrinks and fades; the population that
      // carries the read is the mid-field stipple and the bounce layer.
      const prox = Math.min(1, 0.34 + rr * 0.13);
      // ring
      const s = resetSpawn();
      s.x = x; s.y = y + 0.006; s.z = z;
      s.tile = P.RING;
      // Small. A 0.44 m ring at eight metres photographed as a hard white "O"
      // stamped on the road — a rubber washer, not water. Real rain on tarmac
      // reads as a fine flickering STIPPLE; the size of an individual ripple is
      // a hand span, and it is quantity that carries it.
      s.size0 = (big ? 0.02 : 0.01) * prox;
      s.size1 = (big ? rng.range(0.13, 0.28) : rng.range(0.05, 0.11)) * prox;
      s.sizeCurve = 0.42;
      s.life = big ? rng.range(0.32, 0.55) : rng.range(0.18, 0.3);
      s.drag = 8;
      s.rot = rng.float() * 6.2831853; // scatter: never the same ring twice
      s.flags = 2; // ground-aligned
      const w = rng.range(0.5, 0.78);
      s.r0 = w; s.g0 = w * 1.02; s.b0 = w * 1.05;
      s.r1 = w * 0.6; s.g1 = w * 0.62; s.b1 = w * 0.66;
      s.alpha = (big ? rng.range(0.3, 0.55) : rng.range(0.14, 0.28)) * vis * prox;
      s.alphaCurve = 1.6;
      s.soft = 0.12;
      s.lightGain = 2.2;
      // Ripples spread OUT of nothing; a ring at full contrast on its first
      // frame pops. 0.14 of the life is about 40 ms of growth.
      s.fadeIn = 0.14;
      s.seed = rng.float();
      fx.emitLit(s);

      // The bounce layer: a fine haze of rebound mist sitting 5-15 cm off the
      // ground. On a real wet road this is what you actually SEE from a standing
      // eye height — the individual rings are too small to resolve past a few
      // metres, but the sheet of spray they collectively kick up is not.
      if (rng.float() < 0.75) {
        const m = resetSpawn();
        m.x = x; m.y = y + rng.range(0.02, 0.1); m.z = z;
        m.vx = rng.signed() * 0.35;
        m.vy = rng.range(0.15, 0.7);
        m.vz = rng.signed() * 0.35;
        m.tile = P.MIST;
        m.size0 = rng.range(0.07, 0.16);
        m.size1 = rng.range(0.35, 0.85);
        m.sizeCurve = 0.42;
        m.life = rng.range(0.4, 0.95);
        m.drag = rng.range(4, 6.5);
        m.gravity = -1.6;
        m.rot = rng.float() * 6.2831853;
        m.spin = rng.signed() * 1.2;
        const b = rng.range(0.5, 0.76);
        m.r0 = b * 0.97; m.g0 = b; m.b0 = b * 1.03;
        m.r1 = b * 0.7; m.g1 = b * 0.72; m.b1 = b * 0.76;
        m.alpha = rng.range(0.13, 0.3) * vis;
        m.alphaCurve = 1.7;
        m.soft = 0.12;
        m.wind = rng.range(0.5, 0.85);
        m.fadeIn = 0.05;
        m.lightGain = 2.1;
        m.seed = rng.float();
        fx.emitLit(m);
      }

      // The vertical crown only exists within a few metres — past that it is
      // one pixel and reads as a stray hook on top of the ring.
      if (!big || !near || rng.float() < 0.45) continue;
      // crown + a couple of rebound droplets
      const c = resetSpawn();
      c.x = x; c.y = y + 0.01; c.z = z;
      c.vy = rng.range(0.5, 1.1);
      c.tile = P.SPLASH;
      c.size0 = 0.012 * prox;
      c.size1 = rng.range(0.04, 0.085) * prox;
      c.sizeCurve = 0.5;
      c.life = rng.range(0.14, 0.24);
      c.drag = 5;
      c.gravity = -9;
      c.rot = rng.signed() * 0.25;
      c.r0 = 0.72; c.g0 = 0.75; c.b0 = 0.79;
      c.r1 = 0.5; c.g1 = 0.53; c.b1 = 0.57;
      c.alpha = rng.range(0.22, 0.42) * vis * prox;
      c.alphaCurve = 1.4;
      c.soft = 0.06;
      c.lightGain = 2.4;
      c.seed = rng.float();
      fx.emitLit(c);
    }
  }

  /**
   * Water shed off whatever is above.
   *
   * The landing is scheduled, not simulated: the fall time to the ground is
   * closed-form, so the splash is emitted in the same call with a `delay`. The
   * CPU therefore touches a drip exactly once, when it is created.
   */
  _drips(dt, now, camera, vis) {
    const fx = this.fx;
    const ph = fx.physics;
    if (!ph?.raycast) return;
    this.dripAcc += dt * 14 * vis * fx.pScale;
    let n = Math.min(4, Math.floor(this.dripAcc));
    this.dripAcc -= n;
    const rng = fx.rng;
    for (let i = 0; i < n; i++) {
      const a = rng.float() * 6.2831853;
      const rr = rng.range(1.6, 11);
      this._probe.set(
        camera.position.x + Math.cos(a) * rr,
        camera.position.y - 0.2,
        camera.position.z + Math.sin(a) * rr
      );
      const hit = ph.raycast(this._probe, this._up, 12, ph.MASK.WORLD);
      if (!hit?.hit) continue;
      // Only underside faces shed — a drip out of the top of a kerb is nonsense.
      if (hit.normal && hit.normal.y > -0.25) continue;
      const y0 = hit.point.y - 0.03;
      let ground = camera.position.y - 1.7;
      if (ph.groundHeight) {
        const g = ph.groundHeight(hit.point.x, hit.point.z, y0);
        if (Number.isFinite(g)) ground = g;
      }
      const drop = Math.max(0.12, y0 - ground);
      // v^2 = 2 g h, with the drag term folded in as a fudge on g
      const tFall = Math.sqrt((2 * drop) / 11.5);
      const s = resetSpawn();
      s.x = hit.point.x + rng.signed() * 0.05;
      s.y = y0;
      s.z = hit.point.z + rng.signed() * 0.05;
      s.vy = -0.12;
      s.tile = P.DROPLET;
      s.size0 = rng.range(0.008, 0.017);
      s.size1 = s.size0 * 0.85;
      s.stretch = 0.11;
      s.life = tFall;
      s.drag = 0.12;
      s.gravity = -11.5;
      s.r0 = 0.62; s.g0 = 0.68; s.b0 = 0.74;
      s.r1 = 0.55; s.g1 = 0.6; s.b1 = 0.68;
      s.alpha = rng.range(0.5, 0.85);
      s.alphaCurve = 0.35;
      s.soft = 0.05;
      s.lightGain = 2.4;
      s.fadeIn = 0.01;
      s.seed = rng.float();
      fx.emitLit(s);

      // ... and the splash it makes, pre-scheduled.
      const r = resetSpawn();
      r.x = s.x; r.y = ground + 0.006; r.z = s.z;
      r.delay = tFall;
      r.tile = P.RING;
      r.size0 = 0.02;
      r.size1 = rng.range(0.11, 0.2);
      r.sizeCurve = 0.42;
      r.life = rng.range(0.3, 0.5);
      r.drag = 8;
      r.rot = rng.float() * 6.2831853;
      r.flags = 2;
      r.r0 = 0.62; r.g0 = 0.64; r.b0 = 0.68;
      r.r1 = 0.4; r.g1 = 0.42; r.b1 = 0.46;
      r.alpha = rng.range(0.25, 0.45);
      r.alphaCurve = 1.3;
      r.soft = 0.1;
      r.lightGain = 2.2;
      r.seed = rng.float();
      fx.emitLit(r);
    }
  }

  /**
   * Road spray thrown up behind a moving wheel.
   *
   * Called per vehicle by the FX system, which is the only place that knows how
   * to read a `vehicles` handle. Two plumes: a fine mist that hangs in the air
   * behind the car (this is the one you see in a headlight beam from behind)
   * and a coarser sheet that leaves the tyre nearly horizontally.
   *
   * `dt` is scaled by the caller so the total spend across all vehicles is
   * bounded however many cars are on screen.
   */
  wheelSpray(x, y, z, vx, vy, vz, speed, dt, now, gain = 1) {
    const fx = this.fx;
    const rng = fx.rng;
    const wet = Math.max(this.wetness, this.rain * 0.8);
    if (wet < 0.12 || speed < 3) return 0;
    const load = clamp((speed - 3) / 22, 0, 1) * wet * gain;
    this.sprayAcc += dt * 70 * load * fx.pScale;
    let n = Math.min(8, Math.floor(this.sprayAcc));
    this.sprayAcc -= n;
    if (n <= 0) return 0;
    const inv = speed > 1e-4 ? 1 / speed : 0;
    const dx = vx * inv;
    const dz = vz * inv;
    // lateral of travel
    const lx = -dz;
    const lz = dx;
    for (let i = 0; i < n; i++) {
      const side = rng.float() < 0.5 ? -1 : 1;
      const s = resetSpawn();
      s.x = x + lx * side * rng.range(0.02, 0.16) + rng.signed() * 0.06;
      s.y = y + rng.range(0.02, 0.12);
      s.z = z + lz * side * rng.range(0.02, 0.16) + rng.signed() * 0.06;
      // Thrown BACKWARD relative to the road (the tyre flings it rearward off
      // the top of the contact patch) and outward.
      const back = rng.range(-0.55, -0.15);
      s.vx = vx * back + lx * side * rng.range(0.6, 2.4) + rng.signed() * 0.5;
      s.vy = rng.range(1.1, 3.4);
      s.vz = vz * back + lz * side * rng.range(0.6, 2.4) + rng.signed() * 0.5;
      const coarse = rng.float() < 0.32;
      s.tile = coarse ? P.SPRAY : rng.float() < 0.55 ? P.MIST : P.PLUME;
      s.size0 = rng.range(0.09, 0.2);
      s.size1 = coarse ? rng.range(0.4, 0.9) : rng.range(0.9, 2.1);
      s.sizeCurve = 0.45;
      if (coarse) s.stretch = 0.13;
      s.life = coarse ? rng.range(0.35, 0.7) : rng.range(0.9, 1.9);
      s.delay = -rng.float() * dt;
      s.drag = coarse ? 2.4 : rng.range(3.0, 4.6);
      s.gravity = coarse ? -9 : -1.1;
      s.rot = rng.float() * 6.2831853;
      s.spin = rng.signed() * 1.1;
      const b = rng.range(0.5, 0.76);
      s.r0 = b * 0.96; s.g0 = b * 0.99; s.b0 = b * 1.02;
      s.r1 = b * 0.68; s.g1 = b * 0.7; s.b1 = b * 0.75;
      s.alpha = rng.range(0.1, 0.28) * clamp(0.4 + load, 0.4, 1.2);
      s.alphaCurve = 1.7;
      s.soft = 0.5;
      s.turb = rng.range(0.1, 0.35);
      s.turbFreq = 1.4;
      s.wind = rng.range(0.55, 0.9);
      s.fadeIn = 0.05;
      // Spray is the effect that lives or dies on being lit by headlights.
      s.lightGain = 2.3;
      s.seed = rng.float();
      fx.emitLit(s);
    }
    return n;
  }

  /**
   * Windscreen beads, in viewmodel space so they composite over the interior.
   *
   * The wipe is free: beads are given a lifetime that expires exactly on the
   * next sweep, so the whole population clears together and refills — no
   * per-bead state, no kill list.
   */
  _beads(dt, now, vis) {
    const fx = this.fx;
    const rng = fx.rng;
    const cam = fx.ctx.viewCamera;
    if (!cam) return;
    if (now >= this.wipeAt) this.wipeAt = now + this.wipePeriod;
    const until = this.wipeAt - now;
    if (until < 0.12) return;
    this.beadAcc += dt * 46 * vis * fx.pScale;
    let n = Math.min(8, Math.floor(this.beadAcc));
    this.beadAcc -= n;
    for (let i = 0; i < n; i++) {
      const s = resetSpawn();
      // A plane 0.42 m in front of the view camera — where a windscreen is.
      s.x = rng.signed() * 0.36;
      s.y = rng.range(-0.16, 0.24);
      s.z = -0.42;
      // Beads run DOWN and BACK: gravity plus the airflow over the glass.
      s.vy = -rng.range(0.01, 0.09);
      s.vx = rng.signed() * 0.012;
      s.tile = P.BEAD;
      s.size0 = rng.range(0.006, 0.021);
      s.size1 = s.size0 * rng.range(1.0, 1.9);
      s.sizeCurve = 1.6;
      s.life = Math.min(until, rng.range(0.5, 2.6));
      s.drag = 0.35;
      s.gravity = -0.16;
      s.rot = rng.signed() * 0.12;
      s.r0 = 0.66; s.g0 = 0.7; s.b0 = 0.76;
      s.r1 = 0.6; s.g1 = 0.64; s.b1 = 0.7;
      s.alpha = rng.range(0.32, 0.72);
      s.alphaCurve = 0.55;
      s.soft = 0.01;
      s.fadeIn = 0.06;
      s.lightGain = 1.6;
      s.seed = rng.float();
      fx.emitViewLit(s);
    }
  }

  /* ===================================================================== */

  dispose() {}
}

/** Fallback rain level when `weather:change` only names a state. */
const STATE_RAIN = {
  clear: 0,
  fair: 0,
  cloudy: 0,
  overcast: 0,
  fog: 0,
  drizzle: 0.3,
  rain: 0.68,
  storm: 1,
  thunder: 1,
};
