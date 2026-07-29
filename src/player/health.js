/**
 * Health, regeneration, suppression and the damage-direction model.
 *
 * Regeneration follows the GTA contract, NOT the CoD one this file was forked
 * from: a delay after the last hit (`HEALTH.regenDelay`, 5.0 s), then a slow
 * climb that STOPS AT HALF (`HEALTH.regenCap`). The rest needs a health shop.
 * Anything above the cap does not regenerate at all, which is why a shot that
 * armour mostly ate leaves you sitting at 117/130 for ever. Measured on
 * `feeltest.mjs`: first gain at 5.03 s, plateau at exactly 0.500 of max.
 *
 * Damage arriving from a direction produces an indicator and a matching camera
 * impulse, so a hit is felt before it is read. The indicator angle is taken
 * from the PLAYER'S BODY but expressed in the CAMERA'S yaw frame, so the HUD
 * can draw it in screen space — see the long note in `damage()`, and do not
 * collapse those two back into one point.
 *
 * Suppression is a separate 0..1 pool fed by near misses, hits and blasts. It
 * widens the breathing sway and adds a little shake — the same trick CoD uses to
 * make being shot at feel dangerous without taking control away.
 */

import * as THREE from 'three';
import { HEALTH } from './tuning.js';
import { clamp01, approach, lerp, DEG } from './springs.js';

export class Health {
  constructor(ctx, rig) {
    this.ctx = ctx;
    this.rig = rig;
    this.max = HEALTH.max;
    this.value = HEALTH.max;
    /** GTA-style armour: a second pool that soaks most of each hit first. */
    this.maxArmour = HEALTH.armour;
    this.armour = 0;
    this.dead = false;
    this.regenerating = false;
    this.lastDamageTime = -100;
    this.suppression = 0;
    this.hitFlash = 0;

    /** Direction indicators, oldest first. angle is radians, 0 = straight ahead. */
    this.indicators = [];
    for (let i = 0; i < HEALTH.indicatorMax; i++) {
      this.indicators.push({ active: false, angle: 0, amount: 0, life: 0, worldX: 0, worldY: 0, worldZ: 0 });
    }

    // Heartbeat: phase 0..1 per beat, with a double-thump envelope.
    this.beatPhase = 0;
    this.pulse = 0;
    this.effect = 0; // 0..1 overall low-health treatment weight

    this._payload = { amount: 0, from: new THREE.Vector3(), health: 0, direction: 0, critical: false };
    this._statePayload = {
      health: HEALTH.max, fraction: 1, low: false, critical: false,
      regenerating: false, suppression: 0, dead: false,
    };
    this._emitTimer = 0;
    this._lastEmitHealth = HEALTH.max;
    this._beat = { strength: 0, fraction: 1 };
  }

  get fraction() {
    return clamp01(this.value / this.max);
  }

  /**
   * `player.health` is this OBJECT, not a number — a shape every external
   * probe and half the tooling gets wrong, because "health" reads like a
   * scalar. `hp` is the scalar, so `player.health.hp` means what a caller
   * expects instead of returning undefined.
   */
  get hp() {
    return this.value;
  }

  set hp(v) {
    this.value = Math.max(0, Math.min(this.max, v));
    if (this.value > 0) this.dead = false;
  }

  get low() {
    return this.fraction < HEALTH.lowThreshold;
  }

  get critical() {
    return this.fraction < HEALTH.criticalThreshold;
  }

  reset(full = true) {
    if (full) {
      this.value = this.max;
      this.armour = this.maxArmour;
    }
    this.dead = false;
    this.suppression = 0;
    this.hitFlash = 0;
    this.lastDamageTime = -100;
    for (let k = 0; k < this.indicators.length; k++) this.indicators[k].active = false;
  }

  /* ==================================================================== */

  /**
   * @param {number} amount
   * @param {THREE.Vector3|null} from  world position of the attacker/blast
   * @param {object} opts { yaw, type, suppress }
   */
  damage(amount, from, opts = {}) {
    if (this.dead || amount <= 0) return 0;
    const before = this.value;
    // Armour first: it absorbs `armourAbsorb` of every hit until it is gone,
    // so a plated player takes ~3.5x as many rounds as a bare one.
    let toHealth = amount;
    // A plate stops a round. It does not stop a fall, and it does not hold
    // your breath for you.
    if (this.armour > 0 && opts.type !== 'fall' && opts.type !== 'drown') {
      const soak = Math.min(this.armour, amount * HEALTH.armourAbsorb);
      this.armour -= soak;
      toHealth = amount - soak;
      if (this.armour < 0.01) this.armour = 0;
    }
    this.value = Math.max(0, this.value - toHealth);
    this.lastDamageTime = this.ctx.time.elapsed;
    this.regenerating = false;
    const dealt = before - this.value;

    // ---- direction in view space ---------------------------------------
    let angle = 0;
    if (from) {
      /**
       * THE ORIGIN IS THE BODY. THE FRAME IS THE CAMERA.
       *
       * These two were the same point when this was a first-person game, and
       * the line was written there. In third person the camera sits 3.4 m
       * BEHIND the body, and a bearing taken from the camera is wrong by
       * whatever parallax that buys. Measured on the feel bench, with the
       * shooter 4 m away:
       *
       *   off the right shoulder   0.857 rad, should be  1.571  (-40 deg)
       *   off the left shoulder   -0.901 rad, should be -1.571  (+38 deg)
       *   directly behind         -2.886 rad, should be  3.142  (a hit from
       *                                                  behind read as a hit
       *                                                  from 15 deg off the
       *                                                  left rear quarter)
       *
       * It is not only the HUD arc that reads this: the camera punch below is
       * aimed with sin(angle), so being shot from directly behind produced a
       * sideways kick of sin(-2.886) = -0.25 instead of the 0 it should be.
       *
       * The FRAME stays the camera's yaw — the indicator is drawn in screen
       * space, so it has to be relative to what the player is looking along.
       * Only the origin moves. `opts.origin` is the player's own body position
       * (`PlayerSystem.applyDamage` passes `headPosition`); the camera is kept
       * as the fallback so an external caller that does not supply one still
       * gets the old, merely-imprecise answer rather than a NaN.
       *
       * Convention note, because this project has been bitten by it: an ACTOR's
       * forward at yaw is (-sin, -cos) and his right is (cos, -sin). That is
       * the opposite sign convention from a VEHICLE's nose (+Z). The camera
       * yaw used here is an actor-style yaw, which is why the two lines below
       * are unchanged by this fix.
       */
      const yaw = opts.yaw ?? this.ctx.camera.rotation.y;
      const ox = opts.origin?.x ?? this.ctx.camera.position.x;
      const oz = opts.origin?.z ?? this.ctx.camera.position.z;
      const dx = from.x - ox;
      const dz = from.z - oz;
      // Forward at yaw is (-sin, -cos); right is (cos, -sin).
      const f = -Math.sin(yaw) * dx - Math.cos(yaw) * dz;
      const r = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
      angle = Math.atan2(r, f);
      this._pushIndicator(angle, dealt, from);
    }

    // ---- felt response --------------------------------------------------
    // Driven by the INCOMING amount, not what got through: a round stopped by
    // the plate still has to be felt or armour reads as invulnerability.
    // `quiet` damage (drowning, gas, anything on a tick) skips the punch: the
    // treatment is a rising vignette, not thirty camera kicks a second.
    const severity = clamp01(amount / 45);
    this.hitFlash = clamp01(this.hitFlash + HEALTH.effect.hitFlash * (0.4 + severity) * (opts.quiet ? 0.25 : 1));
    if (!opts.quiet) this.addSuppression(HEALTH.suppression.perHit * (0.5 + severity));
    if (this.rig && !opts.quiet) {
      // Punch the camera away from the hit: pitch up, yaw and roll off-axis.
      const s = 0.6 + severity * 1.9;
      this.rig.addRecoil(
        (1.1 + severity) * DEG * s * 0.7,
        -Math.sin(angle) * (1.4 * DEG) * s,
        -Math.sin(angle) * (2.2 * DEG) * s,
        0.008 * s
      );
      this.rig.addTrauma(0.22 * s);
    }

    const p = this._payload;
    p.amount = amount;
    p.armour = this.armour;
    p.health = this.value;
    p.direction = angle;
    p.critical = this.critical;
    if (from) p.from.copy(from);
    else p.from.set(this.ctx.camera.position.x, this.ctx.camera.position.y, this.ctx.camera.position.z);
    this.ctx.events.emit('damage:taken', p);

    if (this.value <= 0) {
      this.dead = true;
      this.ctx.events.emit('player:death', { position: this.ctx.camera.position });
      // (one allocation on death is fine — it happens once)
    }
    this._emitState(true);
    return dealt;
  }

  heal(amount) {
    this.value = Math.min(this.max, this.value + amount);
  }

  addSuppression(a) {
    this.suppression = clamp01(this.suppression + a);
  }

  _pushIndicator(angle, amount, from) {
    // Reuse the slot pointing the most similar way, else the oldest.
    let slot = null;
    let oldest = null;
    for (let k = 0; k < this.indicators.length; k++) {
      const i = this.indicators[k];
      if (!i.active) { slot = i; break; }
      if (Math.abs(angle - i.angle) < 0.5) { slot = i; break; }
      if (!oldest || i.life > oldest.life) oldest = i;
    }
    slot = slot ?? oldest ?? this.indicators[0];
    slot.active = true;
    slot.angle = angle;
    slot.amount = Math.max(slot.active ? slot.amount * 0.5 : 0, amount);
    slot.life = 0;
    slot.worldX = from.x; slot.worldY = from.y; slot.worldZ = from.z;
  }

  /* ==================================================================== */

  update(dt) {
    const H = HEALTH;

    // ---- regeneration ---------------------------------------------------
    // GTA regenerates slowly and only to half — the rest needs a health shop.
    const cap = this.max * (H.regenCap ?? 1);
    const since = this.ctx.time.elapsed - this.lastDamageTime;
    if (!this.dead && this.value < cap && since > H.regenDelay) {
      this.regenerating = true;
      const ramp = clamp01((since - H.regenDelay) / H.regenRamp);
      this.value = Math.min(cap, this.value + H.regenRate * ramp * dt);
    } else if (this.value >= cap) {
      this.regenerating = false;
    }

    // ---- pools ----------------------------------------------------------
    this.suppression = Math.max(0, this.suppression - H.suppression.decay * dt);
    this.hitFlash = approach(this.hitFlash, 0, H.effect.hitFlashTau, dt);

    for (let k = 0; k < this.indicators.length; k++) {
      const i = this.indicators[k];
      if (!i.active) continue;
      i.life += dt;
      if (i.life > H.indicatorTime) i.active = false;
    }

    // ---- low-health treatment weight ------------------------------------
    const f = this.fraction;
    const target = clamp01((H.lowThreshold - f) / H.lowThreshold);
    this.effect = approach(this.effect, target, 0.25, dt);

    // ---- heartbeat ------------------------------------------------------
    if (this.effect > 0.02) {
      const freq = lerp(H.effect.heartbeatMin, H.effect.heartbeatMax, clamp01(1 - f / H.lowThreshold));
      this.beatPhase += dt * freq;
      if (this.beatPhase >= 1) {
        this.beatPhase -= Math.floor(this.beatPhase);
        this._beat.strength = this.effect;
        this._beat.fraction = f;
        this.ctx.events.emit('player:heartbeat', this._beat);
      }
      // lub-dub: two gaussian thumps 0.16 of a cycle apart
      const t = this.beatPhase;
      const thump = (c, w, g) => g * Math.exp(-((t - c) * (t - c)) / (2 * w * w));
      this.pulse = (thump(0.06, 0.035, 1) + thump(0.22, 0.045, 0.62)) * this.effect;
    } else {
      this.beatPhase = 0;
      this.pulse = 0;
    }

    // ---- suppression feel ------------------------------------------------
    if (this.rig && this.suppression > 0.02) {
      this.rig.addTrauma(this.suppression * H.suppression.shakeScale * dt);
    }

    this._emitTimer -= dt;
    if (this._emitTimer <= 0) {
      this._emitTimer = 0.1;
      if (Math.abs(this.value - this._lastEmitHealth) > 0.4) this._emitState(false);
    }
  }

  _emitState(force) {
    const s = this._statePayload;
    const wasLow = s.low;
    s.health = this.value;
    s.armour = this.armour;
    s.maxArmour = this.maxArmour;
    s.fraction = this.fraction;
    s.low = this.low;
    s.critical = this.critical;
    s.regenerating = this.regenerating;
    s.suppression = this.suppression;
    s.dead = this.dead;
    this._lastEmitHealth = this.value;
    s.changedLowState = wasLow !== s.low;
    s.forced = !!force;
    this.ctx.events.emit('player:health', s);
  }
}
