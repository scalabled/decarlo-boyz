/**
 * POLICE — the wanted level.
 *
 * The rule this file exists to enforce, from DESIGN.md:
 *
 *   Heat goes UP when you commit a crime. It comes DOWN only when you have
 *   broken line of sight AND stayed outside the search cordon for long enough.
 *   A respray at Rustbelt Respray clears it instantly.
 *
 * That is the whole tension of the genre: the meter is not a timer you wait
 * out, it is a thing you have to actively escape. Everything else here is in
 * service of making that legible — the last known position, the cordon that
 * grows around it while they sweep, and the two events the HUD's Slag Ring
 * draws from.
 *
 * SEMANTICS OF THE EVENTS (the UI depends on these exactly):
 *
 *   wanted:change { level, prev }
 *     Only on an integer star change. `prev` is the level before. Level 0 with
 *     prev > 0 means "you got away with it" and the HUD says so.
 *
 *   wanted:heat { position, radius }
 *     Where the police believe you are and how big the area they are sweeping
 *     is. Republished at ~2 Hz while hunting. While they can SEE you this is
 *     your actual position with a small radius; the moment contact is lost it
 *     freezes on the last known position and the radius grows. The Slag Ring
 *     sweeps a cordon off it, so a stale or jittering value reads as a bug.
 */

import * as THREE from 'three';
import { STAR_HEAT, HEAT_MAX, CRIME_HEAT, WITNESS_GAIN, UNWITNESSED_GAIN, TUNE, clamp, clamp01 } from './tune.js';

export class WantedModel {
  constructor(ctx) {
    this.ctx = ctx;
    this.heat = 0;
    this.level = 0;
    /** True while at least one unit currently has eyes on the quarry. */
    this.seen = false;
    /** True while the police are actively looking for you at all. */
    this.hunting = false;
    /** Seconds accumulated toward losing a star. */
    this.evade = 0;
    /** Seconds since the last confirmed sighting. */
    this.sinceSeen = 0;

    /** Last known position — the anchor of the search. */
    this.known = new THREE.Vector3();
    this.hasKnown = false;
    /**
     * ...and the direction they last SAW you travelling, m/s. The other half of
     * the belief: a dispatcher may put cars ahead of where the police think you
     * are going, but only along a vector somebody actually observed. Zeroed by
     * `report`, because a phoned-in crime gives a place, not a heading.
     */
    this.knownVX = 0;
    this.knownVZ = 0;
    /** Radius of the sweep around `known`. */
    this.cordon = 0;

    this._heatTimer = 0;
    this._heatPos = new THREE.Vector3();
    this._payload = { position: this._heatPos, radius: 0 };
    this._changed = { level: 0, prev: 0 };
    /** Crimes reported this frame, for the harness and the dev overlay. */
    this.lastCrime = null;
    this.crimeCount = 0;
    this.totalHeat = 0;
  }

  /* ==================================================================== */
  /* Crime                                                                */
  /* ==================================================================== */

  /**
   * @param {string} kind      a key of CRIME_HEAT, or anything (falls back to
   *                           `reckless`, so an unknown crime is never free)
   * @param {THREE.Vector3} position
   * @param {number} severity  multiplier, default 1
   * @param {object} opts      { witnessed, seenByCop, quiet }
   */
  report(kind, position, severity = 1, opts = {}) {
    const base = CRIME_HEAT[kind] ?? CRIME_HEAT.reckless;
    let gain = base * (Number.isFinite(severity) ? clamp(severity, 0, 6) : 1);
    if (opts.seenByCop) gain *= WITNESS_GAIN;
    else if (opts.witnessed === false) gain *= UNWITNESSED_GAIN;

    // A crime you commit while already hot always at least keeps the meter
    // where it is — a getaway is broken by shooting at the roadblock.
    const prevLevel = this.level;
    this.heat = Math.min(HEAT_MAX, this.heat + gain);
    this.crimeCount++;
    this.totalHeat += gain;
    this.lastCrime = kind;

    /**
     * A WITNESSED crime relocates the search: somebody just told them where you
     * are, and that is what makes "shoot once while hiding" a bad idea.
     *
     * A crime nobody saw does not. It still generates heat — `UNWITNESSED_GAIN`
     * — because the wreck gets found and the car gets described, but there is
     * nobody to phone in a position, so the cordon stays where it was and the
     * evade clock keeps running. Without this split, clipping a parked car on
     * an empty street a kilometre from the nearest cop dropped the whole search
     * on top of you and reset the escape, which reads as the police cheating
     * and is the one thing this meter must never do.
     */
    const told = opts.seenByCop === true || opts.witnessed !== false;
    if (position && told) {
      this.known.set(position.x, position.y ?? 0, position.z);
      this.hasKnown = true;
      this.knownVX = 0;
      this.knownVZ = 0;
      this.cordon = Math.min(this.cordon, TUNE.cordonR0);
      this.evade = 0;
      this.sinceSeen = 0;
    }

    this._resolveLevel(prevLevel);
    if (this.level > 0) {
      this.hunting = true;
      this._publishHeat(true);
    }
    return gain;
  }

  /** Rustbelt Respray, a mission script, or a cheat. Instant and total. */
  clear(reason = 'respray') {
    const prev = this.level;
    this.heat = 0;
    this.evade = 0;
    this.sinceSeen = 0;
    this.cordon = 0;
    this.hasKnown = false;
    this.seen = false;
    this.hunting = false;
    this._resolveLevel(prev);
    this.clearReason = reason;
    return prev;
  }

  /** Force a level — missions ("you start this one at three stars"). */
  set(level) {
    const prev = this.level;
    const l = clamp(Math.round(level), 0, 5);
    this.heat = l === 0 ? 0 : STAR_HEAT[l] + 1;
    if (l === 0) {
      this.hunting = false;
      this.seen = false;
      this.hasKnown = false;
      this.cordon = 0;
    } else {
      this.hunting = true;
    }
    this.evade = 0;
    this._resolveLevel(prev);
  }

  /* ==================================================================== */
  /* Frame                                                                */
  /* ==================================================================== */

  /**
   * @param {number} dt
   * @param {THREE.Vector3|null} quarry  where the player actually is
   * @param {boolean} seen               does any unit have eyes on them
   * @param {THREE.Vector3|null} vel     how fast, for the believed heading
   */
  update(dt, quarry, seen, vel = null) {
    if (this.level === 0) {
      this.hunting = false;
      this.seen = false;
      // Sub-star heat still bleeds off — a bumped kerb should not sit on the
      // meter for the rest of the session waiting to become a star.
      if (this.heat > 0) this.heat = Math.max(0, this.heat - dt * 1.6);
      this._heatTimer = 0;
      return;
    }

    this.hunting = true;
    this.seen = !!seen;
    const prevLevel = this.level;

    if (this.seen && quarry) {
      /* --- contact. The search collapses onto you. --- */
      this.known.set(quarry.x, quarry.y, quarry.z);
      this.hasKnown = true;
      if (vel) {
        this.knownVX = vel.x;
        this.knownVZ = vel.z;
      }
      this.sinceSeen = 0;
      this.evade = 0;
      // A tight cordon while they can see you: the ring should read as a lock,
      // not as a sweep.
      this.cordon += (TUNE.cordonR0 * 0.55 - this.cordon) * Math.min(1, dt * 2.2);
    } else {
      /* --- no contact. The search grows and the clock runs. --- */
      this.sinceSeen += dt;
      const cap = TUNE.cordonMax[this.level] ?? 200;
      this.cordon = Math.min(cap, Math.max(this.cordon, TUNE.cordonR0) + TUNE.cordonGrow * dt);

      // Inside the cordon you are not escaping, you are hiding, and the clock
      // runs backwards. Outside it, it runs forward.
      const inside = this.hasKnown && quarry
        ? Math.hypot(quarry.x - this.known.x, quarry.z - this.known.z) < this.cordon
        : true;
      if (inside) this.evade = Math.max(0, this.evade - dt * TUNE.cordonBleed);
      else this.evade += dt;

      const need = TUNE.evadeNeed[this.level] ?? 20;
      if (this.evade >= need) {
        // Lose exactly one star, and start the next one's clock from zero.
        const target = STAR_HEAT[this.level] - TUNE.demoteMargin;
        this.heat = Math.max(0, Math.min(this.heat, target));
        this.evade = 0;
        // The next star down searches a fresh, smaller area — they have given
        // up on the old cordon.
        this.cordon = TUNE.cordonR0;
      }
    }

    this._resolveLevel(prevLevel);

    this._heatTimer -= dt;
    if (this._heatTimer <= 0) {
      this._heatTimer = 1 / TUNE.heatHz;
      this._publishHeat(false);
    }
  }

  /* ==================================================================== */
  /* Derived                                                              */
  /* ==================================================================== */

  /**
   * 0..1 for the HUD. 1 = freshly seen, 0 = one tick from losing a star. The
   * Slag Ring uses it to decide how hard the bezel glows versus how fast the
   * stars flicker, so it must fall monotonically while you are getting away.
   */
  get cooldown() {
    if (this.level === 0) return 1;
    if (this.seen) return 1;
    const need = TUNE.evadeNeed[this.level] ?? 20;
    return clamp01(1 - this.evade / Math.max(0.5, need));
  }

  /** Fractional progress into the current star, for a part-filled pip. */
  get fill() {
    const l = this.level;
    if (l >= 5) return 1;
    const a = STAR_HEAT[l];
    const b = STAR_HEAT[l + 1];
    return clamp01((this.heat - a) / Math.max(1e-3, b - a));
  }

  _resolveLevel(prev) {
    let l = 0;
    for (let i = 5; i >= 1; i--) {
      if (this.heat >= STAR_HEAT[i]) { l = i; break; }
    }
    if (l === this.level) return;
    this.level = l;
    const p = this._changed;
    p.level = l;
    p.prev = prev;
    this.ctx.events.emit('wanted:change', p);
    if (l === 0) {
      this.hunting = false;
      this.seen = false;
      this.hasKnown = false;
      this.cordon = 0;
      this.evade = 0;
    }
  }

  /**
   * Republish the search area. Preallocated payload — this fires a couple of
   * times a second for the whole session.
   */
  _publishHeat(force) {
    if (!this.hasKnown && !force) return;
    this._heatPos.copy(this.known);
    this._payload.radius = Math.max(12, this.cordon);
    this.ctx.events.emit('wanted:heat', this._payload);
  }
}
