import * as THREE from 'three';
import { P } from './atlas.js';
import { resetSpawn } from './particles.js';
import { clamp } from './util.js';

/**
 * OPEN-WORLD AMBIENCE.
 *
 * The things that are not events. Nothing here is triggered by gameplay; it is
 * all a function of where the camera is and what the weather is doing, and it is
 * all there for one reason: an empty street reads as a tech demo. A GTA V frame
 * always has something moving in it that nobody asked for.
 *
 *  - **Litter and leaves** tumbling down the street on the same wind vector that
 *    drives the smoke and the rain, so the whole frame agrees about which way
 *    the air is going.
 *  - **Birds**, sitting invisible until a gunshot or an explosion puts a flock
 *    up off a roof. This is a *reaction*, which is what makes a city feel like
 *    it noticed you.
 *  - **River mist**, low and slow over water at dawn and after rain.
 *  - **Exhaust** from every idling vehicle, visible when the air is cold.
 *
 * Everything is rate-limited against the shared particle budget and culled by
 * distance, and every emitter randomises rotation, scale and tint per instance —
 * a scatter whose instances all show the same face to camera is the single
 * easiest thing for a critic to spot.
 */

const TWO_PI = Math.PI * 2;

export class WorldFx {
  constructor(fx, opts = {}) {
    this.fx = fx;
    this.enabled = opts.enabled !== false;
    /** 0..1 — how much loose litter this district has. */
    this.litter = 0.55;
    this.litterAcc = 0;
    this.mistAcc = 0;
    this.exhaustAcc = 0;
    this.birdCooldown = 0;
    this._waterTimer = 0;
    this._waterNear = false;
    this._waterY = 0;
    this._fwd = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._down = new THREE.Vector3(0, -1, 0);
  }

  /* ===================================================================== */
  /*  litter                                                               */
  /* ===================================================================== */

  /**
   * Paper, leaves and grit skittering along the ground on the wind.
   *
   * Born on the ground UPWIND of the camera and blown across the frame, with a
   * tumbling rate proportional to how fast the wind is: a leaf in a dead calm
   * that is spinning like a propeller is worse than no leaf. They stay low —
   * bouncing along at ankle height — because that is what litter does, and a
   * cloud of leaves at eye level reads as confetti.
   */
  _litter(dt, now, camera, wind, windSpeed) {
    const fx = this.fx;
    const rng = fx.rng;
    if (windSpeed < 0.35 || this.litter <= 0) return;
    const rate = 5.5 * this.litter * clamp(windSpeed / 5, 0.2, 1.6) * fx.pScale;
    this.litterAcc += rate * dt;
    let n = Math.min(4, Math.floor(this.litterAcc));
    this.litterAcc -= n;
    if (n <= 0) return;
    const ph = fx.physics;
    const inv = windSpeed > 1e-4 ? 1 / windSpeed : 0;
    const wx = wind.x * inv;
    const wz = wind.z * inv;
    for (let i = 0; i < n; i++) {
      // upwind of the camera, spread across the wind
      const along = -rng.range(6, 22);
      const across = rng.signed() * 16;
      const x = camera.position.x + wx * along - wz * across;
      const z = camera.position.z + wz * along + wx * across;
      let y = camera.position.y - 1.7;
      if (ph?.groundHeight) {
        const g = ph.groundHeight(x, z, camera.position.y + 6);
        if (!Number.isFinite(g)) continue;
        if (Math.abs(g - camera.position.y) > 9) continue;
        y = g;
      }
      const leaf = rng.float() < 0.55;
      const s = resetSpawn();
      s.x = x;
      s.y = y + rng.range(0.02, 0.5);
      s.z = z;
      s.vx = wind.x * rng.range(0.5, 0.95) + rng.signed() * 0.6;
      s.vy = rng.range(0.1, 1.1);
      s.vz = wind.z * rng.range(0.5, 0.95) + rng.signed() * 0.6;
      s.tile = leaf ? P.LEAF : P.CHIP;
      // per-instance scale jitter: a scatter of identical sizes reads as tiling
      s.size0 = leaf ? rng.range(0.05, 0.13) : rng.range(0.03, 0.08);
      s.size1 = s.size0;
      s.life = rng.range(3.5, 8);
      s.drag = rng.range(1.2, 2.4);
      // Just under neutral: it lifts on gusts and settles between them.
      s.gravity = -rng.range(0.7, 1.9);
      s.rot = rng.float() * TWO_PI; // per-instance roll
      s.spin = rng.signed() * clamp(windSpeed * 0.9, 0.5, 7);
      // per-instance tint: dry brown through bleached grey
      if (leaf) {
        const dry = rng.float();
        s.r0 = 0.24 + 0.2 * dry;
        s.g0 = 0.17 + 0.14 * dry;
        s.b0 = 0.07 + 0.07 * dry;
      } else {
        const g = rng.range(0.3, 0.62);
        s.r0 = g; s.g0 = g * 0.99; s.b0 = g * 0.96;
      }
      s.r1 = s.r0 * 0.85; s.g1 = s.g0 * 0.85; s.b1 = s.b0 * 0.85;
      s.alpha = rng.range(0.7, 1);
      s.alphaCurve = 0.5;
      s.soft = 0.05;
      s.turb = rng.range(0.3, 1.1);
      s.turbFreq = rng.range(0.6, 1.8);
      s.wind = rng.range(0.55, 0.95);
      s.fadeIn = 0.05;
      s.lightGain = 1.1;
      s.seed = rng.float();
      fx.emitLit(s);
    }
  }

  /* ===================================================================== */
  /*  birds                                                                */
  /* ===================================================================== */

  /**
   * A flock going up off a roof, because something loud happened.
   *
   * Launched from a real rooftop found by a ray cast up and out from the noise,
   * fanning away from it, climbing, with a wingbeat driven in the vertex shader
   * (`SP.flap`) so the silhouettes are not frozen cardboard. Each bird gets its
   * own speed, climb angle, size and beat frequency, and they leave over ~0.4 s
   * rather than all at once — a flock that departs on one frame reads as a
   * particle burst, which is exactly what it is.
   */
  startle(x, y, z, strength = 1, now = 0) {
    const fx = this.fx;
    if (this.birdCooldown > 0) return 0;
    const rng = fx.rng;
    this.birdCooldown = 5.5 + rng.float() * 5;
    const ph = fx.physics;
    // Find something to launch from: a roof or a ledge within 25 m.
    let bx = x;
    let by = y + 7;
    let bz = z;
    let found = false;
    for (let tries = 0; tries < 4 && !found; tries++) {
      const a = rng.float() * TWO_PI;
      const rr = rng.range(4, 22);
      this._p.set(x + Math.cos(a) * rr, y + 0.5, z + Math.sin(a) * rr);
      const hit = ph?.raycast?.(this._p, this._up, 40, ph.MASK.WORLD);
      if (hit?.hit && hit.point.y > y + 2.5) {
        bx = hit.point.x;
        by = hit.point.y + 0.35;
        bz = hit.point.z;
        found = true;
      }
    }
    if (!found) {
      // No roof — a flock off the ground/wires still reads, just lower.
      const a = rng.float() * TWO_PI;
      const rr = rng.range(6, 16);
      bx = x + Math.cos(a) * rr;
      bz = z + Math.sin(a) * rr;
      by = y + rng.range(2.5, 6);
    }
    const n = Math.round(clamp(5 + 12 * strength, 4, 20) * clamp(fx.pScale, 0.5, 1));
    // one shared escape bearing, so they leave as a flock, not as a starburst
    const flee = rng.float() * TWO_PI;
    for (let i = 0; i < n; i++) {
      const s = resetSpawn();
      s.x = bx + rng.signed() * 2.6;
      s.y = by + rng.range(-0.3, 1.2);
      s.z = bz + rng.signed() * 2.6;
      const a = flee + rng.signed() * 0.75;
      const sp = rng.range(5.5, 10.5);
      const climb = rng.range(1.4, 4.2);
      s.vx = Math.cos(a) * sp;
      s.vy = climb;
      s.vz = Math.sin(a) * sp;
      s.tile = P.BIRD;
      s.size0 = rng.range(0.16, 0.30); // wingspan, metres — pigeon scale
      s.size1 = s.size0;
      s.life = rng.range(3.2, 6.0);
      // Nearly no drag and slight lift: they are flying, not being thrown.
      s.drag = 0.16;
      s.gravity = -0.55;
      s.rot = rng.signed() * 0.5; // banked differently each
      s.spin = rng.signed() * 0.22;
      s.flap = rng.range(11, 17); // rad/s wingbeat
      // Take off in a ragged wave, not a synchronised salute.
      s.delay = rng.float() * 0.42;
      const g = rng.range(0.1, 0.24);
      s.r0 = g * 1.02; s.g0 = g; s.b0 = g * 1.04;
      s.r1 = g * 0.85; s.g1 = g * 0.84; s.b1 = g * 0.9;
      s.alpha = rng.range(0.85, 1);
      s.alphaCurve = 0.45;
      s.soft = 0.2;
      s.turb = rng.range(0.15, 0.5);
      s.turbFreq = rng.range(0.6, 1.4);
      s.wind = 0.3;
      s.fadeIn = 0.02;
      s.lightGain = 0.8;
      s.seed = rng.float();
      fx.emitLit(s);
    }
    return n;
  }

  /* ===================================================================== */
  /*  river mist                                                           */
  /* ===================================================================== */

  /**
   * Mist lying on the water.
   *
   * Very large, very soft, very slow sprites just above the surface, with a low
   * ceiling so they read as a *layer* rather than as clouds. Strongest at dawn
   * and after rain, which is when a river actually steams.
   */
  _riverMist(dt, now, camera, wind) {
    const fx = this.fx;
    const w = fx.ctx.peek('world');
    this._waterTimer -= dt;
    if (this._waterTimer <= 0) {
      this._waterTimer = 0.75;
      this._waterNear = false;
      if (w?.isWater) {
        camera.getWorldDirection(this._fwd);
        for (let i = 0; i < 5; i++) {
          const d = 8 + i * 22;
          const x = camera.position.x + this._fwd.x * d;
          const z = camera.position.z + this._fwd.z * d;
          if (w.isWater(x, z)) {
            this._waterNear = true;
            this._waterX = x;
            this._waterZ = z;
            this._waterY = w.waterLevel ?? (w.heightAt ? w.heightAt(x, z) : 0);
            break;
          }
        }
      }
    }
    const gain = fx.mistGain;
    if (!this._waterNear || gain < 0.05) return;
    const rng = fx.rng;
    this.mistAcc += dt * 4.5 * gain * fx.pScale;
    let n = Math.min(3, Math.floor(this.mistAcc));
    this.mistAcc -= n;
    for (let i = 0; i < n; i++) {
      const s = resetSpawn();
      const a = rng.float() * TWO_PI;
      const rr = rng.range(6, 60);
      s.x = this._waterX + Math.cos(a) * rr;
      s.z = this._waterZ + Math.sin(a) * rr;
      if (w?.isWater && !w.isWater(s.x, s.z)) continue;
      s.y = this._waterY + rng.range(0.15, 1.6);
      s.vx = wind.x * 0.4 + rng.signed() * 0.15;
      s.vy = rng.range(0.02, 0.16);
      s.vz = wind.z * 0.4 + rng.signed() * 0.15;
      s.tile = rng.float() < 0.55 ? P.MIST : P.PLUME;
      s.size0 = rng.range(3.5, 9);
      s.size1 = rng.range(11, 24);
      s.sizeCurve = 0.7;
      s.life = rng.range(11, 22);
      s.drag = 0.35;
      s.gravity = 0.02;
      s.rot = rng.float() * TWO_PI;
      s.spin = rng.signed() * 0.05;
      const b = rng.range(0.5, 0.72);
      s.r0 = b * 0.96; s.g0 = b * 0.99; s.b0 = b;
      s.r1 = b * 0.9; s.g1 = b * 0.94; s.b1 = b * 0.98;
      s.alpha = rng.range(0.045, 0.13) * gain;
      s.alphaCurve = 1.5;
      s.soft = 3.5;
      s.turb = rng.range(0.3, 1.2);
      s.turbFreq = 0.09;
      s.wind = rng.range(0.35, 0.65);
      s.fadeIn = 0.16;
      s.lightGain = 0.9;
      s.seed = rng.float();
      fx.emitLit(s);
    }
  }

  /* ===================================================================== */
  /*  exhaust                                                              */
  /* ===================================================================== */

  /**
   * Visible exhaust from an idling engine.
   *
   * Only when the air is cold enough to condense it — which is the whole point
   * of the effect: a car steaming at its tailpipe at two in the afternoon in
   * July is wrong, and the same car doing it at 6 a.m. in November is one of
   * the details that sells a city as a real place.
   */
  exhaust(x, y, z, vx, vy, vz, load, dt, now) {
    const fx = this.fx;
    const cold = fx.coldAir;
    if (cold < 0.08) return 0;
    const rng = fx.rng;
    this.exhaustAcc += dt * (7 + 22 * load) * cold * fx.pScale;
    let n = Math.min(4, Math.floor(this.exhaustAcc));
    this.exhaustAcc -= n;
    for (let i = 0; i < n; i++) {
      const s = resetSpawn();
      s.x = x + rng.signed() * 0.05;
      s.y = y + rng.signed() * 0.04;
      s.z = z + rng.signed() * 0.05;
      // Leaves the pipe backwards at a few m/s, then belongs to the airflow.
      s.vx = vx + rng.signed() * 0.5;
      s.vy = vy + rng.range(0.15, 0.7);
      s.vz = vz + rng.signed() * 0.5;
      s.tile = rng.float() < 0.5 ? P.MIST : P.PLUME;
      s.size0 = rng.range(0.05, 0.11);
      s.size1 = rng.range(0.5, 1.2) * (0.7 + load * 0.6);
      s.sizeCurve = 0.42;
      s.life = rng.range(0.7, 1.7) * (0.6 + cold * 0.7);
      s.delay = -rng.float() * dt;
      s.drag = rng.range(2.2, 3.6);
      s.gravity = 0.5;
      s.rot = rng.float() * TWO_PI;
      s.spin = rng.signed() * 1.1;
      const b = rng.range(0.44, 0.66);
      s.r0 = b; s.g0 = b * 1.005; s.b0 = b * 1.02;
      s.r1 = b * 0.7; s.g1 = b * 0.71; s.b1 = b * 0.74;
      s.alpha = rng.range(0.08, 0.22) * cold;
      s.alphaCurve = 2.1;
      s.soft = 0.45;
      s.turb = rng.range(0.08, 0.3);
      s.turbFreq = 1.6;
      s.wind = 0.8;
      s.fadeIn = 0.05;
      s.lightGain = 1.5;
      s.seed = rng.float();
      fx.emitLit(s);
    }
    return n;
  }

  /* ===================================================================== */

  update(dt, now, camera) {
    if (!this.enabled) return;
    if (this.birdCooldown > 0) this.birdCooldown -= dt;
    const wind = this.fx.windVec;
    const ws = Math.hypot(wind.x, wind.z);
    this._litter(dt, now, camera, wind, ws);
    this._riverMist(dt, now, camera, wind);
  }
}
