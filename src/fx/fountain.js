import * as THREE from 'three';
import { P } from './atlas.js';
import { resetSpawn } from './particles.js';
import { clamp } from './util.js';

/**
 * THE POINT FOUNTAIN'S WATER.
 *
 * `buildings` owns the basin, the plinth and the nozzle ring (`pointFountain`
 * in src/buildings/landmarks.js); this file owns the water: a tall central jet
 * that rises, breaks up and falls back, spray blown off the top, the sheet of
 * white water coming down the plinth tiers, and the splash rings where the
 * sixteen perimeter jets land in the basin. Everything is spawned into the
 * shared lit particle ring (see particles.js) — the simulation is closed-form
 * in the vertex shader, so a fountain running all day costs the CPU only its
 * spawn writes (~3 per frame at ultra).
 *
 * WHERE THE FOUNTAIN IS IS NOT THIS FILE'S DECISION (ARCHITECTURE.md rule 12,
 * "one fact, one owner"). The centre comes from `world.landmarks` (lm_point),
 * and the HEIGHT is anchored to the EMITTED collision: a raycast straight down
 * at the centre hits the basin's concrete filler box. MEASURED on the live
 * build before this file existed: heightAt(-452, 46) = 2.6997 and the centre
 * ray hits 'concrete' at 3.7997 — exactly the builder's `gy + 1.1`. The plinth
 * cylinders do NOT carry colliders (the same measurement shows the ray passing
 * straight through the nozzle tip that a naive reading of `pointFountain`
 * says it should hit at gy + 5.8), so the basin box is the anchor and the
 * nozzle offsets below are ADOPTED from the builder's constants, not
 * re-measured:
 *
 *     basin walk surface   gy + 1.10   MEASURED (the collider the ray hits)
 *     ring nozzle mouths   gy + 2.45   adopted (cyl at gy+1.9, h 0.55, r 5.4)
 *     main nozzle tip      gy + 5.80   adopted (alu cyl gy+3.2, h 2.6)
 *
 * If `buildings` reshapes the plinth these two offsets are the only numbers
 * that move, and the anchor (the measured basin top) still keeps the water on
 * the fountain rather than under the Ohio — which is where a second authored
 * coordinate put it once already (see the header of landmarks.js).
 *
 * STREAMING. Landmarks are always-resident geometry, but their COLLISION is
 * only real triangles within the world's streaming radius of the camera, and a
 * bench boot (fx preview, headless probes) may have no world at all. So:
 *
 *   - nothing is emitted until the basin collider has been FOUND by the
 *     centre raycast (delta over terrain in (0.7, 2.5) m) — i.e. until the
 *     fountain is demonstrably streamed in;
 *   - the anchor is then cached: landmark geometry never unloads, so the
 *     fountain keeps playing when the camera crosses the collision horizon;
 *   - the one exception is the far vista (camera beyond raycast range with no
 *     anchor yet — the mkt_point aerial): there the tall jet alone runs from
 *     the landmark's published x,z and terrain height, gated on a `buildings`
 *     system being present, because at 400+ m the jet is a 40 px column and
 *     the basin detail is sub-pixel anyway. The moment the camera comes into
 *     range the measured anchor replaces the provisional one.
 *
 * BUDGET. `cap` is the fountain's whole steady-state allowance out of the
 * shared lit ring — 4.5% of `q.particleBudget`, floor 60, ceiling 900 — and
 * every per-stream rate is derived as share * cap / life, so the sum of the
 * steady-state populations is <= cap BY CONSTRUCTION. Low tier (< 4000)
 * drops the mist and the plinth cascade entirely and folds their share into
 * nothing: fewer, plainer particles, never a blown budget.
 * `src/fx/fountainprobe.mjs` measures both the arc and the cap on the emitted
 * records.
 *
 * DETERMINISM. All randomness is `fx.rng` (the fork `FxSystem.init` keeps),
 * same as rain; under `?capture=1` the fixed-step replay makes the emitted
 * stream byte-identical run to run.
 */

const TWO_PI = Math.PI * 2;

/** Offsets ADOPTED from src/buildings/landmarks.js `pointFountain` — see header. */
const BASIN_TOP = 1.1; // gy -> basin walk surface (also what the anchor measures)
const RING_NOZZLE = 2.45 - BASIN_TOP; // basin top -> perimeter nozzle mouths
const NOZZLE_TIP = 5.8 - BASIN_TOP; // basin top -> main nozzle tip
const RING_R = 5.4; // radius of the 16-nozzle ring
const RING_N = 16;

/** Camera distances, metres. Beyond CULL nothing is emitted at all. */
const NEAR_FULL = 180; // full effect
const DETAIL_CUTOFF = 270; // rings / cascade / splash are sub-pixel past this
const JET_FADE0 = 380; // jet starts fading...
const CULL = 560; // ...and is gone here (the mkt_point aerial sits at ~460)
const ANCHOR_RANGE = 300; // raycast confirmation only inside the collision radius

/** Main-jet ballistics (authored): v0 ~21 m/s against g 12, k 0.1 -> ~17 m apex. */
const JET_APEX = 17;

export class FountainFx {
  /**
   * @param {object} fx     the FxSystem
   * @param {object} opts   { budget } — config.q.particleBudget
   */
  constructor(fx, opts = {}) {
    this.fx = fx;
    const budget = opts.budget ?? 6000;
    /** Steady-state particle allowance — the number the probe holds us to. */
    this.cap = Math.round(clamp(budget * 0.045, 60, 900));
    /** Low tier: no mist, no cascade — degrade, don't starve the ring. */
    this.mist = budget >= 4000;

    // share * cap / life = spawn rate, so share sums <= 1 keep us under cap.
    const share = this.mist
      ? { jet: 0.5, ring: 0.18, mist: 0.16, splash: 0.1, cascade: 0.06 }
      : { jet: 0.62, ring: 0.22, mist: 0, splash: 0.16, cascade: 0 };
    this.rateJet = (share.jet * this.cap) / 3.8;
    this.rateRing = (share.ring * this.cap) / 1.7;
    this.rateMist = (share.mist * this.cap) / 2.6;
    this.rateSplash = (share.splash * this.cap) / 0.8;
    this.rateCascade = (share.cascade * this.cap) / 1.2;

    /** Set true to hold the water with no code edit — the probe's negative
     *  control, same pattern as `debugIgnorePause` (ARCHITECTURE.md). */
    this.debugDisable = false;

    // anchor state
    this.anchored = false;
    this.provisional = false;
    this.cx = 0;
    this.cz = 0;
    /** Basin walk surface (the measured collider top). */
    this.waterY = 0;
    this.ringY = 0;
    this.nozzleY = 0;
    this._lm = null;
    this._anchorTimer = 0;
    this._verifyTimer = 0;
    this._misses = 0;

    // spawn accumulators (fractional carry, like rain's)
    this.jetAcc = 0;
    this.ringAcc = 0;
    this.mistAcc = 0;
    this.splashAcc = 0;
    this.cascadeAcc = 0;
    this.spawned = 0;

    this._camPos = new THREE.Vector3();
    this._rayO = new THREE.Vector3();
    this._rayD = new THREE.Vector3(0, -1, 0);
  }

  /* ===================================================================== */

  update(dt, now, camera) {
    if (this.debugDisable) return;
    const fx = this.fx;
    const world = fx.ctx.peek('world');
    if (!world) return;
    const lm = this._lm ?? (this._lm = world.landmarks?.find?.((l) => l.id === 'lm_point') ?? null);
    if (!lm) return;

    camera.getWorldPosition(this._camPos);
    const dx = this._camPos.x - lm.x;
    const dz = this._camPos.z - lm.z;
    const dh = Math.hypot(dx, dz);
    if (dh > CULL) return;

    this._anchor(dt, world, lm, dh);
    if (!this.anchored) return;

    const dy = this._camPos.y - this.nozzleY;
    const d = Math.hypot(dh, dy);
    if (d > CULL) return;

    // Jet reads to the horizon of its cull; detail work only near the basin.
    const jetGain = 1 - clamp((d - JET_FADE0) / (CULL - JET_FADE0), 0, 1);
    const nearGain = 1 - clamp((d - NEAR_FULL) / (DETAIL_CUTOFF - NEAR_FULL), 0, 1);
    // A 30 cm droplet is sub-pixel at 300 m; grow sprites with distance so the
    // column still reads as white water in the vista instead of vanishing.
    const distScale = clamp(1 + (d - 140) / 320, 1, 2);

    this._jet(dt, jetGain, distScale);
    if (this.mist) this._mist(dt, jetGain, distScale);
    if (!this.provisional && nearGain > 0.01) {
      this._ringJets(dt, nearGain);
      this._splashes(dt, nearGain);
      if (this.mist) this._cascade(dt, nearGain);
    }
  }

  /* ===================================================================== */
  /*  anchor                                                               */
  /* ===================================================================== */

  /**
   * Find the basin by measuring it. The centre raycast against MASK.WORLD hits
   * the basin's concrete filler box at gy + 1.1 when the fountain is streamed
   * in, and bare ground (delta ~0) when it is not — which is exactly the
   * "don't water an empty plaza" test. Outside collision range the analytic
   * ground fallback answers, delta ~0, and we correctly stay unanchored.
   */
  _anchor(dt, world, lm, dh) {
    if (this.anchored && !this.provisional) {
      // Landmarks never unload; re-verify only occasionally, and only where
      // the raycast can actually see triangles.
      this._verifyTimer -= dt;
      if (this._verifyTimer > 0 || dh > ANCHOR_RANGE) return;
      this._verifyTimer = 11;
      const top = this._basinTop(world, lm);
      if (top === null) this.anchored = false;
      else this._adopt(lm, top, false);
      return;
    }

    this._anchorTimer -= dt;
    if (this._anchorTimer > 0) return;
    this._anchorTimer = 0.7;

    if (dh <= ANCHOR_RANGE) {
      const top = this._basinTop(world, lm);
      if (top !== null) {
        this._misses = 0;
        this._adopt(lm, top, false);
      } else if (!this.provisional) {
        this.anchored = false;
      } else if (++this._misses >= 4) {
        // A provisional (far-vista) anchor that the ray, now in range, still
        // cannot confirm after ~3 s is watering an empty plaza. Stop.
        this.anchored = false;
        this.provisional = false;
      }
      return;
    }

    // Far vista: no collider to measure. The landmark is always-resident
    // geometry once `buildings` has booted, so its presence is the gate; the
    // provisional height is terrain + the builder's basin offset, and the
    // measured anchor replaces it the moment the camera comes into range.
    if (!this.anchored && this.fx.ctx.peek('buildings')) {
      const terrain = world.heightAt?.(lm.x, lm.z);
      if (Number.isFinite(terrain)) this._adopt(lm, terrain + BASIN_TOP, true);
    }
  }

  /** Measured basin walk surface, or null when the fountain is not there. */
  _basinTop(world, lm) {
    const ph = this.fx.physics;
    if (!ph?.raycast) return null;
    const terrain = world.heightAt?.(lm.x, lm.z);
    if (!Number.isFinite(terrain)) return null;
    this._rayO.set(lm.x, terrain + 25, lm.z);
    const hit = ph.raycast(this._rayO, this._rayD, 60, ph.MASK.WORLD);
    if (!hit?.hit) return null;
    const delta = hit.point.y - terrain;
    // MEASURED: the basin box top sits at exactly +1.10. Bare plaza is ~0,
    // and anything past +2.5 is not the basin (a prop, a bridge deck).
    if (delta < 0.7 || delta > 2.5) return null;
    return hit.point.y;
  }

  _adopt(lm, basinTop, provisional) {
    this.anchored = true;
    this.provisional = provisional;
    this.cx = lm.x;
    this.cz = lm.z;
    this.waterY = basinTop;
    this.ringY = basinTop + RING_NOZZLE;
    this.nozzleY = basinTop + NOZZLE_TIP;
  }

  /* ===================================================================== */
  /*  the water                                                            */
  /* ===================================================================== */

  /** The central jet: clumps of white water thrown ~17 m up off the nozzle. */
  _jet(dt, gain, distScale) {
    const fx = this.fx;
    const rng = fx.rng;
    this.jetAcc += dt * this.rateJet * gain;
    let n = Math.min(6, Math.floor(this.jetAcc));
    this.jetAcc -= n;
    for (let i = 0; i < n; i++) {
      const s = resetSpawn();
      const a = rng.float() * TWO_PI;
      const rr = rng.float() * 0.14;
      s.x = this.cx + Math.cos(a) * rr;
      s.y = this.nozzleY - rng.float() * 0.3;
      s.z = this.cz + Math.sin(a) * rr;
      // Slight lateral scatter is what breaks the column into water; the
      // closed-form drag/gravity in the vertex shader does the arc.
      s.vx = rng.signed() * 0.9;
      s.vy = rng.range(19.5, 23);
      s.vz = rng.signed() * 0.9;
      s.drag = 0.1;
      s.gravity = -12;
      s.life = rng.range(3.3, 3.75);
      s.delay = -rng.float() * dt;
      const kind = rng.float();
      if (kind < 0.55) {
        s.tile = P.SPLASH;
        s.stretch = 0.07;
      } else if (kind < 0.82) {
        s.tile = P.SPRAY;
        s.stretch = 0.1;
      } else {
        s.tile = P.DROPLET;
        s.stretch = 0.2;
      }
      s.size0 = rng.range(0.2, 0.4) * distScale;
      s.size1 = rng.range(0.9, 1.7) * distScale;
      s.sizeCurve = 0.6;
      s.rot = rng.float() * TWO_PI;
      s.spin = rng.signed() * 0.8;
      const b = rng.range(0.58, 0.82);
      s.r0 = b * 0.95; s.g0 = b * 0.99; s.b0 = b * 1.03;
      s.r1 = b * 0.66; s.g1 = b * 0.7; s.b1 = b * 0.76;
      s.alpha = rng.range(0.28, 0.5);
      s.alphaCurve = 1.3;
      s.soft = 0.35;
      s.fadeIn = 0.03;
      s.turb = 0.12;
      s.turbFreq = 0.8;
      // The top of a tall jet leans downwind — cheap sway off the shared wind.
      s.wind = rng.range(0.04, 0.12);
      // White water lives or dies on catching light — headlights, the flash
      // pool, whatever `sky` keys the night with (same reasoning as rain spray).
      s.lightGain = 2.3;
      s.seed = rng.float();
      fx.emitLit(s);
      this.spawned++;
    }
  }

  /** Spray blown off the top of the jet where it breaks up. */
  _mist(dt, gain, distScale) {
    const fx = this.fx;
    const rng = fx.rng;
    this.mistAcc += dt * this.rateMist * gain;
    let n = Math.min(3, Math.floor(this.mistAcc));
    this.mistAcc -= n;
    for (let i = 0; i < n; i++) {
      const s = resetSpawn();
      s.x = this.cx + rng.signed() * 1.6;
      s.y = this.nozzleY + JET_APEX * rng.range(0.68, 1.02);
      s.z = this.cz + rng.signed() * 1.6;
      s.vx = rng.signed() * 0.7;
      s.vy = rng.range(-0.4, 1.1);
      s.vz = rng.signed() * 0.7;
      s.tile = rng.float() < 0.6 ? P.MIST : P.PLUME;
      s.size0 = rng.range(0.5, 1.1) * distScale;
      s.size1 = rng.range(2.2, 4.2) * distScale;
      s.sizeCurve = 0.5;
      s.life = rng.range(1.6, 2.8);
      s.drag = rng.range(2.6, 4);
      s.gravity = -1.8;
      s.rot = rng.float() * TWO_PI;
      s.spin = rng.signed() * 0.5;
      const b = rng.range(0.55, 0.75);
      s.r0 = b * 0.97; s.g0 = b; s.b0 = b * 1.03;
      s.r1 = b * 0.72; s.g1 = b * 0.75; s.b1 = b * 0.8;
      s.alpha = rng.range(0.07, 0.16);
      s.alphaCurve = 1.8;
      s.soft = 0.6;
      s.fadeIn = 0.09;
      s.turb = rng.range(0.2, 0.5);
      s.turbFreq = 0.5;
      s.wind = rng.range(0.5, 0.85);
      s.lightGain = 2.1;
      s.seed = rng.float();
      fx.emitLit(s);
      this.spawned++;
    }
  }

  /** The sixteen perimeter nozzles, arcing outward into the basin. */
  _ringJets(dt, gain) {
    const fx = this.fx;
    const rng = fx.rng;
    this.ringAcc += dt * this.rateRing * gain;
    let n = Math.min(4, Math.floor(this.ringAcc));
    this.ringAcc -= n;
    for (let i = 0; i < n; i++) {
      const idx = (rng.float() * RING_N) | 0;
      const a = (idx / RING_N) * TWO_PI;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const s = resetSpawn();
      s.x = this.cx + ca * RING_R + rng.signed() * 0.05;
      s.y = this.ringY + rng.float() * 0.1;
      s.z = this.cz + sa * RING_R + rng.signed() * 0.05;
      const out = rng.range(2.4, 3.4);
      s.vx = ca * out + rng.signed() * 0.25;
      s.vy = rng.range(6.8, 8.6);
      s.vz = sa * out + rng.signed() * 0.25;
      s.drag = 0.12;
      s.gravity = -12;
      s.life = rng.range(1.35, 1.7);
      s.delay = -rng.float() * dt;
      s.tile = rng.float() < 0.6 ? P.SPRAY : P.SPLASH;
      s.stretch = 0.12;
      s.size0 = rng.range(0.12, 0.22);
      s.size1 = rng.range(0.45, 0.75);
      s.sizeCurve = 0.55;
      s.rot = rng.float() * TWO_PI;
      const b = rng.range(0.56, 0.8);
      s.r0 = b * 0.95; s.g0 = b * 0.99; s.b0 = b * 1.03;
      s.r1 = b * 0.66; s.g1 = b * 0.7; s.b1 = b * 0.76;
      s.alpha = rng.range(0.3, 0.5);
      s.alphaCurve = 1.4;
      s.soft = 0.25;
      s.fadeIn = 0.03;
      s.wind = 0.06;
      s.lightGain = 2.3;
      s.seed = rng.float();
      fx.emitLit(s);
      this.spawned++;
    }
  }

  /** Ground-aligned rings + bounce puffs where the perimeter jets land. */
  _splashes(dt, gain) {
    const fx = this.fx;
    const rng = fx.rng;
    this.splashAcc += dt * this.rateSplash * gain;
    let n = Math.min(4, Math.floor(this.splashAcc));
    this.splashAcc -= n;
    for (let i = 0; i < n; i++) {
      const a = rng.float() * TWO_PI;
      // Where the ring jets actually come down: launched outward at ~3 m/s off
      // r 5.4, they land r ~7-11 into the basin.
      const rr = rng.range(6.8, 11.5);
      const x = this.cx + Math.cos(a) * rr;
      const z = this.cz + Math.sin(a) * rr;
      if (rng.float() < 0.62) {
        const s = resetSpawn();
        s.x = x; s.y = this.waterY + 0.012; s.z = z;
        s.tile = P.RING;
        s.size0 = 0.03;
        s.size1 = rng.range(0.35, 0.8);
        s.sizeCurve = 0.45;
        s.life = rng.range(0.45, 0.8);
        s.drag = 6;
        s.rot = rng.float() * TWO_PI;
        s.flags = 2; // ground-aligned: a mark ON the water, not a hoop
        const w = rng.range(0.5, 0.75);
        s.r0 = w; s.g0 = w * 1.02; s.b0 = w * 1.05;
        s.r1 = w * 0.6; s.g1 = w * 0.63; s.b1 = w * 0.67;
        s.alpha = rng.range(0.2, 0.4);
        s.alphaCurve = 1.5;
        s.soft = 0.12;
        s.fadeIn = 0.1;
        s.lightGain = 2.2;
        s.seed = rng.float();
        fx.emitLit(s);
      } else {
        const m = resetSpawn();
        m.x = x; m.y = this.waterY + rng.range(0.03, 0.12); m.z = z;
        m.vx = rng.signed() * 0.4;
        m.vy = rng.range(0.3, 1.1);
        m.vz = rng.signed() * 0.4;
        m.tile = P.MIST;
        m.size0 = rng.range(0.08, 0.16);
        m.size1 = rng.range(0.4, 0.9);
        m.sizeCurve = 0.45;
        m.life = rng.range(0.5, 1.0);
        m.drag = rng.range(3.5, 5.5);
        m.gravity = -1.8;
        m.rot = rng.float() * TWO_PI;
        const b = rng.range(0.52, 0.76);
        m.r0 = b * 0.97; m.g0 = b; m.b0 = b * 1.03;
        m.r1 = b * 0.7; m.g1 = b * 0.73; m.b1 = b * 0.78;
        m.alpha = rng.range(0.14, 0.3);
        m.alphaCurve = 1.7;
        m.soft = 0.14;
        m.fadeIn = 0.05;
        m.wind = rng.range(0.4, 0.7);
        m.lightGain = 2.2;
        m.seed = rng.float();
        fx.emitLit(m);
      }
      this.spawned++;
    }
  }

  /** White water sheeting down the plinth tiers under the main jet. */
  _cascade(dt, gain) {
    const fx = this.fx;
    const rng = fx.rng;
    this.cascadeAcc += dt * this.rateCascade * gain;
    let n = Math.min(2, Math.floor(this.cascadeAcc));
    this.cascadeAcc -= n;
    for (let i = 0; i < n; i++) {
      const a = rng.float() * TWO_PI;
      const rr = rng.range(2.6, 4.4);
      const f = Math.pow(rng.float(), 1.5);
      const s = resetSpawn();
      s.x = this.cx + Math.cos(a) * rr;
      s.y = this.waterY + 0.3 + (this.nozzleY - 1.6 - (this.waterY + 0.3)) * f;
      s.z = this.cz + Math.sin(a) * rr;
      s.vx = Math.cos(a) * 0.3;
      s.vy = rng.range(-0.5, -0.1);
      s.vz = Math.sin(a) * 0.3;
      s.drag = 2.2;
      s.gravity = -6;
      s.life = rng.range(0.7, 1.2);
      s.tile = rng.float() < 0.6 ? P.SPLASH : P.MIST;
      s.size0 = rng.range(0.2, 0.35);
      s.size1 = rng.range(0.55, 0.9);
      s.sizeCurve = 0.5;
      s.rot = rng.float() * TWO_PI;
      const b = rng.range(0.54, 0.78);
      s.r0 = b * 0.96; s.g0 = b; s.b0 = b * 1.04;
      s.r1 = b * 0.68; s.g1 = b * 0.71; s.b1 = b * 0.77;
      s.alpha = rng.range(0.15, 0.3);
      s.alphaCurve = 1.5;
      s.soft = 0.28;
      s.fadeIn = 0.05;
      s.lightGain = 2.2;
      s.seed = rng.float();
      fx.emitLit(s);
      this.spawned++;
    }
  }

  dispose() {}
}
