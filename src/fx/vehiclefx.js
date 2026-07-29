import * as THREE from 'three';
import { P, D } from './atlas.js';
import { resetSpawn } from './particles.js';
import { V, blackbody, C, clamp, reflect } from './util.js';

/**
 * VEHICLE DAMAGE — the whole arc from the first scrape to the burnt-out shell.
 *
 * `vehicle:collision { vehicle, other, point, normal, impulse, speed }` is the
 * only input for impacts, and it fires both for a one-off hit and, frame after
 * frame, while a panel is grinding along a wall. Those two need to look
 * completely different, so the system keeps a short history per vehicle and
 * splits them: a HIT gets a bang (a spark burst, panel debris, a light flash, a
 * paint scuff), a GRIND gets a continuous rooster tail of sparks welded to a
 * moving contact point plus a lengthening scrape on the wall.
 *
 * Damage accumulates. Past thresholds the car starts leaking, steaming, smoking
 * and finally burning, all of it welded to the vehicle object so it travels with
 * it, and `vehicle:destroyed` cashes it in for a proper detonation.
 */

const TWO_PI = Math.PI * 2;
const MAX_TRACKED = 12;

/** Damage fractions at which each stage starts. */
const STAGE = { steam: 0.45, smoke: 0.62, fire: 0.88 };

class Damaged {
  constructor() {
    this.veh = null;
    this.obj = null;
    this.damage = 0;
    this.last = -1e9;
    this.grind = 0;
    this.grindAt = -1e9;
    this.smokeTag = 0;
    this.steamTag = 0;
    this.fireTag = 0;
    this.fireAcc = 0;
    this.pos = new THREE.Vector3();
  }
}

export class VehicleFx {
  constructor(fx) {
    this.fx = fx;
    this.tracked = [];
    for (let i = 0; i < MAX_TRACKED; i++) this.tracked.push(new Damaged());
    this._p = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /* ===================================================================== */

  _slot(veh) {
    let free = null;
    let oldest = null;
    for (let i = 0; i < this.tracked.length; i++) {
      const t = this.tracked[i];
      if (t.veh === veh) return t;
      if (!free && !t.veh) free = t;
      if (!oldest || t.last < oldest.last) oldest = t;
    }
    const t = free ?? oldest;
    if (t.veh) this._clearSources(t);
    t.veh = veh;
    t.obj = objOf(veh);
    t.damage = 0;
    t.grind = 0;
    return t;
  }

  _clearSources(t) {
    const a = this.fx.ambience;
    if (t.smokeTag) a.remove(t.smokeTag);
    if (t.steamTag) a.remove(t.steamTag);
    if (t.fireTag) a.remove(t.fireTag);
    t.smokeTag = t.steamTag = t.fireTag = 0;
  }

  /* ===================================================================== */
  /*  collisions                                                           */
  /* ===================================================================== */

  onCollision(e, now) {
    const pt = e?.point;
    if (!pt) return;
    const fx = this.fx;
    const speed = Math.abs(e.speed ?? 0);
    // `impulse` is the honest measure but not every implementation supplies one,
    // so fall back to closing speed, which every one of them has.
    const imp = e.impulse ?? speed * 320;
    const energy = clamp(imp / 2600, 0.05, 3);
    if (energy < 0.03) return;

    const t = e.vehicle ? this._slot(e.vehicle) : null;
    let nx = 0;
    let ny = 1;
    let nz = 0;
    if (e.normal) {
      nx = e.normal.x; ny = e.normal.y; nz = e.normal.z;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
    }

    // Grind or bang? Repeat contact within a few frames, at a glancing angle,
    // is a panel being dragged along something.
    const repeat = t && now - t.grindAt < 0.14;
    if (t) {
      t.grindAt = now;
      t.last = now;
      // A GRIND fires every frame, so it must cost a fraction of what a single
      // impact does or a two-second scrape along a wall totals more damage than
      // a head-on collision. Measured: at the bang rate a scraping car passed
      // the fire threshold in under two seconds and set itself alight against a
      // kerb, which is how the `sparks` stage ended up photographing a fire.
      t.damage = clamp(t.damage + energy * (repeat ? 0.0025 : 0.055), 0, 1.4);
      this._stages(t, now);
    }

    if (repeat) {
      this._grind(pt, nx, ny, nz, e, energy, now);
      return;
    }
    this._bang(pt, nx, ny, nz, e, energy, speed, now);
  }

  /**
   * A hit. Sparks are the read, and sparks without a light are stickers — so
   * every burst over a threshold takes a real (short, cheap) flash out of the
   * pooled lights.
   */
  _bang(pt, nx, ny, nz, e, energy, speed, now) {
    const fx = this.fx;
    const rng = fx.rng;
    const q = fx.pScale;

    // ---- sparks ----------------------------------------------------------
    // Steel on stone throws a shower; steel on steel throws more and hotter.
    const hard = e.other == null || e.surface === 'metal' || e.surface === 'concrete' ||
      e.surface === 'asphalt' || e.surface == null;
    const nSpark = hard ? Math.round((16 + 42 * energy) * q) : Math.round(6 * energy * q);
    // The shower leaves along the REFLECTED travel direction, not along the
    // normal: a car scraping a wall throws its sparks forward down the wall.
    this._d.set(e.dirX ?? 0, 0, e.dirZ ?? 0);
    if (this._d.lengthSq() < 1e-6 && e.vehicle) velOf(e.vehicle, this._d);
    if (this._d.lengthSq() < 1e-6) this._d.set(-nx, -ny, -nz);
    this._d.normalize();
    reflect(V, this._d.x, this._d.y, this._d.z, nx, ny, nz);
    const rx = V.x;
    const ry = V.y;
    const rz = V.z;
    for (let i = 0; i < nSpark; i++) {
      const s = resetSpawn();
      s.x = pt.x + nx * 0.02 + rng.signed() * 0.05;
      s.y = pt.y + ny * 0.02 + rng.signed() * 0.05;
      s.z = pt.z + nz * 0.02 + rng.signed() * 0.05;
      // wide fan around the reflected direction, biased forward
      const sp = rng.range(2.5, 12) * (0.5 + energy * 0.6);
      const j = 0.85;
      s.vx = (rx + rng.signed() * j) * sp + nx * rng.range(0.5, 3);
      s.vy = (ry + rng.signed() * j) * sp + ny * rng.range(0.5, 3) + rng.range(0.5, 2.5);
      s.vz = (rz + rng.signed() * j) * sp + nz * rng.range(0.5, 3);
      s.tile = P.STREAK;
      s.size0 = rng.range(0.007, 0.019);
      s.size1 = s.size0 * 0.32;
      s.stretch = rng.range(0.9, 1.7);
      s.life = rng.range(0.24, 0.85);
      s.drag = rng.range(0.7, 1.9);
      s.gravity = -14;
      // A steel spark leaves at ~2300 K and is deep red by the time it lands.
      blackbody(C, rng.range(2050, 2600));
      s.r0 = C.r; s.g0 = C.g; s.b0 = C.b;
      s.i0 = rng.range(6, 20);
      blackbody(C, 1150);
      s.r1 = C.r; s.g1 = C.g; s.b1 = C.b;
      s.i1 = 0.12;
      s.flags = 1; // flicker
      s.alphaCurve = 0.55;
      s.soft = 0.05;
      s.turb = 0.06;
      s.turbFreq = 5;
      s.seed = rng.float();
      fx.emitAdd(s);
    }

    // A hot core right at the contact patch: the flash you actually see first.
    if (hard && energy > 0.12) {
      const c = resetSpawn();
      c.x = pt.x + nx * 0.03; c.y = pt.y + ny * 0.03; c.z = pt.z + nz * 0.03;
      c.tile = P.FLASH_CORE;
      c.size0 = 0.06 + energy * 0.1;
      c.size1 = 0.02;
      c.sizeCurve = 0.5;
      c.life = 0.07;
      c.drag = 6;
      c.r0 = 1; c.g0 = 0.86; c.b0 = 0.6; c.i0 = 5 + energy * 7;
      c.r1 = 1; c.g1 = 0.4; c.b1 = 0.1; c.i1 = 0;
      c.alphaCurve = 0.5;
      c.soft = 0.1;
      c.seed = rng.float();
      fx.emitAdd(c);
    }

    // ---- the light -------------------------------------------------------
    // Sparks with no light contribution is one of the named traps. The flash is
    // short (90 ms) and warm, sized off the spark count so a light scuff does
    // not floodlight the street.
    if (hard && energy > 0.1 && fx.lights) {
      fx.lights.flash(
        pt.x + nx * 0.1,
        pt.y + ny * 0.1 + 0.05,
        pt.z + nz * 0.1,
        1, 0.62, 0.24,
        6 + 34 * Math.min(energy, 1.6),
        0.11, 9, 7, 2
      );
    }

    // ---- paint, panel debris and the scuff on the wall --------------------
    const nDeb = Math.round(clamp(energy * 9, 0, 16) * q);
    for (let i = 0; i < nDeb; i++) {
      const s = resetSpawn();
      s.x = pt.x; s.y = pt.y; s.z = pt.z;
      const sp = rng.range(1.5, 7) * (0.4 + energy * 0.5);
      s.vx = (rx + rng.signed() * 1.1) * sp;
      s.vy = (ry + rng.signed() * 0.8) * sp + rng.range(1, 4);
      s.vz = (rz + rng.signed() * 1.1) * sp;
      s.tile = rng.float() < 0.35 ? P.SPLINTER : P.CHIP;
      s.size0 = rng.range(0.012, 0.05) * (0.6 + energy * 0.4);
      s.size1 = s.size0;
      s.life = rng.range(0.7, 1.8);
      s.drag = 0.55;
      s.gravity = -18;
      s.rot = rng.float() * TWO_PI;
      s.spin = rng.signed() * 26;
      // painted panel on one side, primer/steel on the other
      const painted = rng.float() < 0.55;
      if (painted) {
        const p = fx.paintTint;
        s.r0 = p.x; s.g0 = p.y; s.b0 = p.z;
      } else {
        s.r0 = 0.16; s.g0 = 0.16; s.b0 = 0.17;
      }
      s.r1 = s.r0 * 0.8; s.g1 = s.g0 * 0.8; s.b1 = s.b0 * 0.8;
      s.alphaCurve = 0.3;
      s.soft = 0.06;
      s.seed = rng.float();
      fx.emitLit(s);
    }

    // dust knocked off whatever was hit
    for (let i = 0; i < Math.round(clamp(energy * 7, 1, 12) * q); i++) {
      const s = resetSpawn();
      s.x = pt.x + rng.signed() * 0.12;
      s.y = pt.y + rng.signed() * 0.12;
      s.z = pt.z + rng.signed() * 0.12;
      s.vx = nx * rng.range(0.5, 2.5) + rng.signed() * 0.8;
      s.vy = ny * rng.range(0.5, 2.5) + rng.range(0.2, 1.4);
      s.vz = nz * rng.range(0.5, 2.5) + rng.signed() * 0.8;
      s.tile = rng.float() < 0.4 ? P.PLUME : P.DUST;
      s.size0 = rng.range(0.06, 0.14);
      s.size1 = rng.range(0.4, 1.1) * (0.6 + energy * 0.5);
      s.sizeCurve = 0.45;
      s.life = rng.range(0.6, 1.5);
      s.drag = 3;
      s.gravity = -0.5;
      s.rot = rng.float() * TWO_PI;
      s.spin = rng.signed() * 1.2;
      const g = rng.range(0.32, 0.46);
      s.r0 = g; s.g0 = g * 0.95; s.b0 = g * 0.88;
      s.r1 = g * 0.8; s.g1 = g * 0.77; s.b1 = g * 0.72;
      s.alpha = rng.range(0.22, 0.5);
      s.alphaCurve = 1.6;
      s.soft = 0.6;
      s.turb = 0.14;
      s.turbFreq = 1.2;
      s.wind = 0.6;
      s.lightGain = 1.3;
      s.seed = rng.float();
      fx.emitLit(s);
    }

    if (energy > 0.22) {
      fx.addDecal2(pt.x, pt.y, pt.z, nx, ny, nz, {
        tile: D.SCRAPE,
        size: clamp(0.4 + energy * 0.7, 0.35, 1.8),
        // Rolled to the travel direction so the gouge runs the way the car did.
        roll: Math.atan2(rz, rx) + rng.signed() * 0.12,
        life: 150,
        fade: 0.6,
        opacity: clamp(0.4 + energy * 0.4, 0.3, 0.95),
        maxAngle: 74,
      });
    }

    // ---- glass -----------------------------------------------------------
    if (energy > 0.5) this.glassBurst(pt.x, pt.y, pt.z, rx, ry, rz, energy, now);
  }

  /**
   * Sustained grind: a rooster tail of sparks welded to the contact patch, with
   * a *much* smaller per-frame count than a bang so a five-second scrape is not
   * five seconds of explosions.
   */
  _grind(pt, nx, ny, nz, e, energy, now) {
    const fx = this.fx;
    const rng = fx.rng;
    this._d.set(0, 0, 0);
    if (e.vehicle) velOf(e.vehicle, this._d);
    let sp = this._d.length();
    if (sp < 0.2) return;
    this._d.multiplyScalar(1 / sp);
    reflect(V, this._d.x, this._d.y, this._d.z, nx, ny, nz);
    const n = Math.round(clamp(4 + sp * 0.9, 2, 22) * fx.pScale);
    for (let i = 0; i < n; i++) {
      const s = resetSpawn();
      // SPREAD THE BIRTH. A thousand additive streaks a second all starting
      // inside a 6 cm box sum into a saturated white ball welded to the contact
      // point — which is exactly what a grind photographed as. The contact patch
      // of a dragging panel is 20-30 cm long, and the sparks leaving it are
      // spread through the frame, not stacked on its first instant.
      const along = rng.signed() * 0.16;
      s.x = pt.x + nx * 0.015 + this._d.x * along + rng.signed() * 0.035;
      s.y = pt.y + ny * 0.015 + rng.signed() * 0.05;
      s.z = pt.z + nz * 0.015 + this._d.z * along + rng.signed() * 0.035;
      s.delay = -rng.float() * 0.0166;
      const v = rng.range(2, 9) * clamp(sp / 14, 0.3, 1.6);
      s.vx = (V.x + rng.signed() * 0.7) * v + nx * rng.range(0.4, 2.4);
      s.vy = (V.y + rng.signed() * 0.55) * v + ny * rng.range(0.4, 2.4) + rng.range(0.4, 2);
      s.vz = (V.z + rng.signed() * 0.7) * v + nz * rng.range(0.4, 2.4);
      s.tile = P.STREAK;
      s.size0 = rng.range(0.006, 0.016);
      s.size1 = s.size0 * 0.3;
      s.stretch = rng.range(1.3, 2.4);
      s.life = rng.range(0.28, 0.85);
      s.drag = rng.range(0.9, 2.2);
      s.gravity = -14;
      blackbody(C, rng.range(2000, 2500));
      // 3-9, not 5-15: the shower's brightness comes from its COUNT under
      // additive blending, so per-spark radiance has to come down as the count
      // goes up or the near field clips to white.
      s.r0 = C.r; s.g0 = C.g; s.b0 = C.b; s.i0 = rng.range(4, 12);
      blackbody(C, 1150);
      s.r1 = C.r; s.g1 = C.g; s.b1 = C.b; s.i1 = 0.1;
      s.flags = 1;
      s.alphaCurve = 0.55;
      s.soft = 0.05;
      s.turb = 0.05;
      s.turbFreq = 6;
      s.seed = rng.float();
      fx.emitAdd(s);
    }
    // ONE low, steady light — and only occasionally.
    //
    // MEASURED: at one flash every other frame with a 0.13 s duration, all four
    // pool lights were live at once, 0.55 m off a wall, and the wall came out
    // covered in overlapping round hotspots that read as glowing balls rather
    // than as sparks. A grind is a dim continuous source, not a strobe: a
    // sixth of the rate, half the peak, and a longer range so the falloff is
    // gradual instead of a pool.
    if (fx.lights && rng.float() < 0.22) {
      fx.lights.flash(pt.x, pt.y + 0.1, pt.z, 1, 0.6, 0.22, 11 * clamp(sp / 14, 0.3, 1.4), 0.16, 5, 11, 1);
    }
    // Lay the scrape as a series of small overlapping decals along the contact
    // path — the mark a grind leaves is long and thin, not a stamp.
    // Overlapping heavily and faint, so the trail reads as one gouge rather
    // than as a dotted line of bright stamps.
    if (rng.float() < 0.75) {
      fx.addDecal2(pt.x, pt.y, pt.z, nx, ny, nz, {
        tile: D.SCRAPE,
        size: rng.range(0.5, 0.95),
        roll: Math.atan2(V.z, V.x) + rng.signed() * 0.07,
        life: 120,
        fade: 0.5,
        opacity: rng.range(0.1, 0.22),
        maxAngle: 76,
      });
    }
  }

  /* ===================================================================== */
  /*  glass                                                                */
  /* ===================================================================== */

  /**
   * A window letting go. Tempered glass does not shatter into a puff — it dices
   * into thousands of blunt crumbs that leave together in a sheet and then rain
   * down. So: a fast, coherent initial fan, high gravity, near-zero drag, plus a
   * litter decal where they land.
   */
  glassBurst(x, y, z, dx, dy, dz, energy, now) {
    const fx = this.fx;
    const rng = fx.rng;
    const n = Math.round(clamp(18 + 40 * energy, 10, 90) * fx.pScale);
    for (let i = 0; i < n; i++) {
      const s = resetSpawn();
      s.x = x + rng.signed() * 0.28;
      s.y = y + rng.signed() * 0.2;
      s.z = z + rng.signed() * 0.28;
      const sp = rng.range(1.4, 6.5) * (0.5 + energy * 0.5);
      s.vx = (dx + rng.signed() * 0.8) * sp;
      s.vy = (dy + rng.signed() * 0.5) * sp + rng.range(0.8, 3.4);
      s.vz = (dz + rng.signed() * 0.8) * sp;
      s.tile = P.SHARD;
      s.size0 = rng.range(0.008, 0.028);
      s.size1 = s.size0;
      s.life = rng.range(0.9, 2.0);
      s.drag = 0.28;
      s.gravity = -19;
      // Every fragment gets its own roll and tumble rate: a scatter where every
      // instance shows the same face to camera is the giveaway of a lazy emitter.
      s.rot = rng.float() * TWO_PI;
      s.spin = rng.signed() * 34;
      const g = rng.range(0.5, 0.95);
      s.r0 = g * 0.9; s.g0 = g * 0.97; s.b0 = g;
      s.r1 = g * 0.55; s.g1 = g * 0.6; s.b1 = g * 0.64;
      s.i0 = 1; s.i1 = 0.7;
      s.alpha = rng.range(0.5, 1);
      s.alphaCurve = 0.4;
      s.soft = 0.04;
      s.lightGain = 2.6; // glass twinkles under a headlight
      s.seed = rng.float();
      fx.emitLit(s);
    }
    // the sound of it: a pale dust of the very finest crumbs
    for (let i = 0; i < Math.round(6 * fx.pScale); i++) {
      const s = resetSpawn();
      s.x = x + rng.signed() * 0.2; s.y = y; s.z = z + rng.signed() * 0.2;
      s.vx = dx * rng.range(0.5, 2) + rng.signed() * 0.6;
      s.vy = rng.range(0.3, 1.4);
      s.vz = dz * rng.range(0.5, 2) + rng.signed() * 0.6;
      s.tile = P.MIST;
      s.size0 = 0.06; s.size1 = rng.range(0.3, 0.6); s.sizeCurve = 0.45;
      s.life = rng.range(0.4, 0.9);
      s.drag = 4; s.gravity = -1.2;
      s.rot = rng.float() * TWO_PI;
      s.r0 = 0.6; s.g0 = 0.64; s.b0 = 0.68;
      s.r1 = 0.5; s.g1 = 0.53; s.b1 = 0.58;
      s.alpha = rng.range(0.1, 0.25);
      s.alphaCurve = 1.6; s.soft = 0.3; s.lightGain = 1.8;
      s.seed = rng.float();
      fx.emitLit(s);
    }
    const ph = fx.physics;
    let gy = y - 0.9;
    if (ph?.groundHeight) {
      const g = ph.groundHeight(x, z, y + 1);
      if (Number.isFinite(g)) gy = g;
    }
    fx.addDecal2(x + dx * 0.6, gy, z + dz * 0.6, 0, 1, 0, {
      tile: D.GLASS_LITTER,
      size: rng.range(1.1, 2.0),
      roll: rng.float() * TWO_PI,
      life: 180,
      fade: 0.7,
      opacity: 0.9,
      maxAngle: 40,
    });
  }

  /* ===================================================================== */
  /*  damage stages                                                        */
  /* ===================================================================== */

  /** Report a health fraction directly (0 = wrecked, 1 = mint). */
  setHealth(veh, health, now) {
    const t = this._slot(veh);
    t.damage = clamp(1 - health, 0, 1.4);
    t.last = now;
    this._stages(t, now);
  }

  /**
   * Hang the right persistent emitters off the vehicle for its damage level.
   *
   * Everything is attached to the vehicle's Object3D, so `ambience` tracks it
   * automatically as the car drives and nothing here runs per frame.
   */
  _stages(t, now) {
    const fx = this.fx;
    const a = fx.ambience;
    const obj = t.obj ?? (t.obj = objOf(t.veh));
    const d = t.damage;

    // --- radiator steam: white, fast, thin, gone by 1.5 m ---
    if (d >= STAGE.steam && !t.steamTag) {
      t.steamTag = a.addSource(this._anchor(t, 0.42, 0.55), {
        rate: 12,
        radius: 0.16,
        rise: 2.6,
        dark: 0.62,
        life: 0.85,
        growth: 4.2,
        ember: 0,
        haze: 0.16,
        object: obj,
        steam: true,
        wind: 0.75,
        alpha: 0.36,
      });
    } else if (d < STAGE.steam - 0.06 && t.steamTag) {
      a.remove(t.steamTag);
      t.steamTag = 0;
    }

    // --- engine smoke: thickens as it dies ---
    if (d >= STAGE.smoke) {
      const heavy = clamp((d - STAGE.smoke) / (1 - STAGE.smoke), 0, 1);
      if (!t.smokeTag) {
        t.smokeTag = a.addSource(this._anchor(t, 0.5, 0.6), {
          rate: 6,
          radius: 0.22,
          rise: 1.5,
          dark: 0.1,
          life: 2.6,
          growth: 4.4,
          ember: 0,
          haze: 0.2,
          object: obj,
          wind: 0.7,
          alpha: 0.5,
        });
      }
      a.tune(t.smokeTag, {
        rate: 5 + 16 * heavy,
        radius: 0.2 + 0.18 * heavy,
        dark: 0.11 - 0.05 * heavy,
        life: 2.4 + 2.2 * heavy,
      });
    } else if (t.smokeTag) {
      a.remove(t.smokeTag);
      t.smokeTag = 0;
    }

    // --- fire ---
    if (d >= STAGE.fire && !t.fireTag) {
      t.fireTag = a.addSource(this._anchor(t, 0.55, 0.6), {
        rate: 16,
        radius: 0.3,
        rise: 2.2,
        dark: 0.07,
        life: 2.4,
        growth: 4,
        ember: 0.75,
        haze: 0.75,
        object: obj,
        fire: 0.85,
        wind: 0.45,
        alpha: 0.62,
      });
    } else if (d < STAGE.fire - 0.05 && t.fireTag) {
      a.remove(t.fireTag);
      t.fireTag = 0;
    }
  }

  _anchor(t, fwd, up) {
    const obj = t.obj;
    if (obj) {
      obj.updateWorldMatrix(true, false);
      this._p.set(0, up, -fwd * 2.0).applyMatrix4(obj.matrixWorld);
    } else {
      posOf(t.veh, this._p);
      this._p.y += up;
    }
    return this._p;
  }

  /* ===================================================================== */
  /*  the wreck                                                            */
  /* ===================================================================== */

  /**
   * `vehicle:destroyed`. A car going up is not a grenade: the sequence is a
   * white overpressure flash and a ground-hugging shock ring, then a fireball
   * that CLIMBS and rolls over into its own smoke, then the heavy stuff — panel,
   * glass, wheel and trim debris on real ballistic arcs — and finally a column
   * that keeps burning for a quarter of a minute over a scorched, oil-stained
   * patch of road.
   */
  onDestroyed(e, now) {
    const fx = this.fx;
    const rng = fx.rng;
    const q = fx.pScale;
    let px = 0;
    let py = 0;
    let pz = 0;
    if (e?.point) {
      px = e.point.x; py = e.point.y; pz = e.point.z;
    } else if (e?.vehicle) {
      posOf(e.vehicle, this._p);
      px = this._p.x; py = this._p.y; pz = this._p.z;
    }
    const t = e?.vehicle ? this._slot(e.vehicle) : null;
    if (t) this._clearSources(t);

    // Core detonation — reuse the tuned explosion, sized for a car.
    fx.explosion({ position: { x: px, y: py + 0.5, z: pz }, radius: 4.4, damage: 160, noScorch: true });

    // ---- the ground-hugging shock ring -----------------------------------
    // A car bomb's signature: the blast rolls OUT along the road faster than the
    // fireball climbs. Ground-aligned, so it stays a ring on the tarmac.
    const ring = resetSpawn();
    ring.x = px; ring.y = py + 0.08; ring.z = pz;
    ring.tile = P.RING;
    ring.size0 = 1.2;
    ring.size1 = 17;
    ring.sizeCurve = 0.36;
    ring.life = 0.42;
    ring.drag = 5;
    ring.flags = 2;
    ring.r0 = 1; ring.g0 = 0.82; ring.b0 = 0.6; ring.i0 = 2.6;
    ring.r1 = 0.7; ring.g1 = 0.45; ring.b1 = 0.25; ring.i1 = 0;
    ring.alphaCurve = 1.2;
    ring.soft = 1.5;
    ring.seed = rng.float();
    fx.emitAdd(ring);
    fx.hazeRing(px, py + 0.3, pz, 1.0, 13, 0.42, 2.6);

    // dust sheet blown outward along the road
    for (let i = 0; i < Math.round(18 * q) + 8; i++) {
      const a = (i / 26) * TWO_PI + rng.signed() * 0.3;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const s = resetSpawn();
      s.x = px + dx * 0.9; s.y = py + 0.06; s.z = pz + dz * 0.9;
      const sp = rng.range(8, 20);
      s.vx = dx * sp; s.vy = rng.range(0.2, 1.6); s.vz = dz * sp;
      s.tile = rng.float() < 0.5 ? P.PLUME : P.DUST;
      s.size0 = rng.range(0.3, 0.6);
      s.size1 = rng.range(1.8, 3.6);
      s.sizeCurve = 0.4;
      s.life = rng.range(1.2, 2.6);
      s.drag = rng.range(2.6, 4);
      s.gravity = -0.4;
      s.rot = rng.float() * TWO_PI;
      s.spin = rng.signed() * 1.1;
      const g = rng.range(0.3, 0.44);
      s.r0 = g; s.g0 = g * 0.94; s.b0 = g * 0.86;
      s.r1 = g * 0.72; s.g1 = g * 0.68; s.b1 = g * 0.62;
      s.alpha = rng.range(0.35, 0.65);
      s.alphaCurve = 1.5;
      s.soft = 0.7;
      s.turb = 0.2;
      s.turbFreq = 1.1;
      s.wind = 0.55;
      s.lightGain = 1.5;
      s.seed = rng.float();
      fx.emitLit(s);
    }

    // ---- the heavy debris ------------------------------------------------
    const nDeb = Math.round(40 * q) + 16;
    for (let i = 0; i < nDeb; i++) {
      const s = resetSpawn();
      s.x = px + rng.signed() * 0.6;
      s.y = py + rng.range(0.2, 1.1);
      s.z = pz + rng.signed() * 0.6;
      // Cone up and out, with a long tail of low fast pieces skittering away.
      const low = rng.float() < 0.55;
      const el = low ? rng.range(0.05, 0.35) : rng.range(0.45, 1.05);
      const az = rng.float() * TWO_PI;
      const sp = rng.range(7, 26);
      s.vx = Math.cos(az) * Math.cos(el) * sp;
      s.vy = Math.sin(el) * sp;
      s.vz = Math.sin(az) * Math.cos(el) * sp;
      const kind = rng.float();
      s.tile = kind < 0.2 ? P.SHARD : kind < 0.5 ? P.SPLINTER : P.CHIP;
      s.size0 = rng.range(0.02, 0.12);
      s.size1 = s.size0;
      s.life = rng.range(1.1, 2.8);
      s.drag = 0.35;
      s.gravity = -19;
      s.rot = rng.float() * TWO_PI;
      s.spin = rng.signed() * 30;
      // Fast pieces smear. Without it a wreck's debris is a field of static
      // black specks pinned to the sky, which reads as dirt on the lens.
      s.stretch = rng.range(0.12, 0.4);
      if (kind < 0.2) {
        const g = rng.range(0.45, 0.8);
        s.r0 = g * 0.9; s.g0 = g * 0.97; s.b0 = g;
      } else if (kind < 0.62) {
        const p = fx.paintTint;
        // scorched paint: darker and desaturated toward the fire
        const burn = rng.float();
        s.r0 = p.x * (1 - burn * 0.75) + 0.02;
        s.g0 = p.y * (1 - burn * 0.8) + 0.018;
        s.b0 = p.z * (1 - burn * 0.8) + 0.016;
      } else {
        s.r0 = 0.05; s.g0 = 0.047; s.b0 = 0.044;
      }
      s.r1 = s.r0 * 0.75; s.g1 = s.g0 * 0.75; s.b1 = s.b0 * 0.75;
      s.alphaCurve = 0.28;
      s.soft = 0.05;
      s.lightGain = 1.6;
      s.seed = rng.float();
      fx.emitLit(s);
    }

    // ---- aftermath: a column that keeps burning --------------------------
    fx.addSmokeColumn(px, py + 0.5, pz, {
      radius: 0.62,
      duration: 16,
      rate: 13,
      rise: 2.3,
      dark: 0.055,
      life: 5.2,
      growth: 4.6,
      ember: 0.35,
      haze: 0.5,
      fire: 0.5,
      wind: 0.65,
      alpha: 0.68,
    });

    // ---- ground marks ----------------------------------------------------
    fx.scorch(px, py, pz, 4.4);
    fx.addDecal2(px + rng.signed() * 0.5, py, pz + rng.signed() * 0.5, 0, 1, 0, {
      tile: D.OIL,
      size: rng.range(2.0, 3.2),
      roll: rng.float() * TWO_PI,
      life: 240,
      fade: 0.8,
      opacity: 0.92,
      maxAngle: 34,
    });
    for (let i = 0; i < 3; i++) {
      const a = rng.float() * TWO_PI;
      const rr = rng.range(1.4, 3.6);
      fx.addDecal2(px + Math.cos(a) * rr, py, pz + Math.sin(a) * rr, 0, 1, 0, {
        tile: i === 0 ? D.GLASS_LITTER : D.DEBRIS,
        size: rng.range(1.4, 2.6),
        roll: rng.float() * TWO_PI,
        life: 220,
        fade: 0.75,
        opacity: rng.range(0.6, 0.95),
        maxAngle: 38,
      });
    }
    // soot licking outward from under the shell
    for (let i = 0; i < 4; i++) {
      const a = rng.float() * TWO_PI;
      fx.addDecal2(px + Math.cos(a) * 2.1, py, pz + Math.sin(a) * 2.1, 0, 1, 0, {
        tile: D.SOOT_STREAK,
        size: rng.range(2.4, 4.0),
        roll: a + Math.PI * 0.5,
        life: 230,
        fade: 0.7,
        opacity: rng.range(0.5, 0.85),
        maxAngle: 34,
      });
    }

    // The big light. Bright and short, then a long low ember glow from the
    // burning shell that keeps the wreck lit in its own smoke.
    if (fx.lights) {
      fx.lights.flash(px, py + 1.6, pz, 1, 0.7, 0.36, 900, 0.55, 6, 42, 5);
    }
    if (t) {
      t.damage = 1.4;
      t.fireTag = fx.ambience.addSource({ x: px, y: py + 0.3, z: pz }, {
        rate: 14,
        radius: 0.5,
        rise: 2.0,
        dark: 0.06,
        life: 3.0,
        growth: 4.2,
        ember: 0.6,
        haze: 0.6,
        duration: 26,
        fire: 0.8,
        wind: 0.5,
        alpha: 0.6,
      });
    }
  }

  /* ===================================================================== */

  update(dt, now) {
    // Fire lights: a burning wreck must flicker its surroundings, and the
    // ambience emitters cannot do that themselves (they own no lights).
    const fx = this.fx;
    for (let i = 0; i < this.tracked.length; i++) {
      const t = this.tracked[i];
      if (!t.veh || !t.fireTag) continue;
      t.fireAcc -= dt;
      if (t.fireAcc > 0) continue;
      t.fireAcc = 0.09 + fx.rng.float() * 0.07;
      const obj = t.obj;
      if (obj) {
        obj.updateWorldMatrix(true, false);
        this._p.setFromMatrixPosition(obj.matrixWorld);
      } else {
        posOf(t.veh, this._p);
      }
      fx.lights?.flash(
        this._p.x + fx.rng.signed() * 0.2,
        this._p.y + 0.9 + fx.rng.float() * 0.4,
        this._p.z + fx.rng.signed() * 0.2,
        1, 0.48, 0.16,
        26 + fx.rng.float() * 26,
        0.17, 3, 14, 1
      );
    }
  }

  dispose() {
    for (const t of this.tracked) {
      if (t.veh) this._clearSources(t);
      t.veh = null;
      t.obj = null;
    }
  }
}

/* ------------------------------------------------------------------------- */
/*  tolerant accessors for a `vehicles` handle we do not own                  */
/* ------------------------------------------------------------------------- */

/** The Object3D a vehicle handle is drawn with, if it has one. */
export function objOf(veh) {
  if (!veh) return null;
  if (veh.isObject3D) return veh;
  return veh.object ?? veh.object3D ?? veh.mesh ?? veh.root ?? veh.group ?? null;
}

/** World position of a vehicle handle into `out`. */
export function posOf(veh, out) {
  if (!veh) return out.set(0, 0, 0);
  const o = objOf(veh);
  if (o) {
    o.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(o.matrixWorld);
  }
  const p = veh.position ?? veh.pos;
  if (p) return out.set(p.x, p.y, p.z);
  return out.set(0, 0, 0);
}

/** Linear velocity of a vehicle handle into `out`. */
export function velOf(veh, out) {
  const v = veh?.velocity ?? veh?.vel ?? veh?.linearVelocity ?? veh?.body?.velocity;
  if (v) return out.set(v.x ?? 0, v.y ?? 0, v.z ?? 0);
  return out.set(0, 0, 0);
}
