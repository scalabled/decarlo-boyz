/**
 * POLICE — officers on foot.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW THIS TALKS TO `peds` — and why it is done this way
 * ────────────────────────────────────────────────────────────────────────────
 * `peds` owns every human body in this game: the rig, the twelve-slot palette,
 * the animator, the hit capsules and the ragdolls. Building a second, parallel
 * character system inside `police/` would mean a cop that does not match the
 * pedestrian standing next to him, cannot be shot with the same hit boxes, and
 * does not ragdoll. So an officer IS a `peds` Ped. We borrow one through the
 * public `attachDriver()` entry point, repaint its palette into a uniform, and
 * then steer it through the only control surface a Ped exposes to the outside
 * world without reaching into private state:
 *
 *   state = 'gawk'  + `threat` + `_gawkDist`
 *       → hold a standoff distance from a point and FACE it. That is exactly
 *         "take a position covering the suspect", and the `film` behaviour
 *         layer it turns on is a two-handed pose at eye level — a pistol grip
 *         if you do not give the person a phone to hold. So we don't.
 *   state = 'fight' + `fightTarget`
 *       → close on a point at a run and make contact when you get there. That
 *         is the arrest.
 *   `glanceAt` / `setAct('talk')`
 *       → head tracking and the shouting layer.
 *
 * Everything else — the walk cycle, foot IK, avoidance, ground following,
 * ragdoll on death — is peds' own code doing its own job. The two things peds'
 * state machine would do on its own that we do NOT want are the timeouts (a
 * gawker gives up after ~20 s, a fighter panics after 14 s), so `stateTime` is
 * held down every tick. This is documented rather than hidden because it is the
 * one place `police` leans on another subsystem's internals.
 *
 * FIRE. From two stars (TUNE.fire.fromLevel) an officer in the COVER stance
 * shoots: an aimed round every period[level] seconds inside fire.range, with
 * wanted-scaled accuracy and damage, resolved exactly the way
 * `src/game/hostiles.js` resolves enemy fire — `weapon:fire` (muzzle flash +
 * gunshot; fx's pooled lights, so the visible point-light count never moves),
 * `bullet:tracer`, and `damage:dealt` that the player's own listener applies.
 * An arrest team (1-2 stars, quarry slow and on foot) holds fire — the cuffs
 * and the gun are different tools for different star counts.
 */

import * as THREE from 'three';
import { UNIFORM, CROOKED_UNIFORM, TUNE, clamp, clamp01 } from './tune.js';

const _v = new THREE.Vector3();
const _aim = new THREE.Vector3();

export const OFFICER = {
  COVER: 'cover',      // holding a position, weapon up, shouting
  ADVANCE: 'advance',  // closing on the suspect
  ARREST: 'arrest',    // in contact, cuffing
  DOWN: 'down',
};

export class Officer {
  constructor(sys) {
    this.sys = sys;
    this.ped = null;
    this.active = false;
    this.state = OFFICER.COVER;
    this.anchor = new THREE.Vector3();   // the car door we came out of
    this.face = new THREE.Vector3();     // what we are pointing at
    this.standoff = 7;
    this.arrestT = 0;
    this.shoutT = 0;
    this.age = 0;
    this.unit = null;
    this._body = null;
    /** The `copwar` variant: hostile whatever the meter says, no wanted price. */
    this.crooked = false;
    /** Seconds until the next aimed shot. Positive at adopt so a freshly
     *  staged tableau (dt 0) can never fire into the lens. */
    this.fireT = 1;
    /** True until the death transition has been reported by the pool. */
    this.wasAlive = true;
  }

  /** Adopt a Ped and put it in uniform. */
  adopt(ped, opts = {}) {
    this.ped = ped;
    this.active = true;
    this.age = 0;
    this.arrestT = 0;
    this.shoutT = 1.2;
    this.state = OFFICER.COVER;
    this.unit = opts.unit ?? null;
    this.standoff = opts.standoff ?? 7;
    this.crooked = !!opts.crooked;
    this.fireT = 1.2 + (ped.id % 7) * 0.35;
    this.wasAlive = true;
    if (opts.anchor) this.anchor.copy(opts.anchor);

    // Uniform. `peds` copies `outfit.palette` into the body's uniform block the
    // moment a body is granted, so writing it here lands whether the body
    // arrives this frame or in ten.
    const pal = ped.outfit?.palette;
    const wear = this.crooked ? CROOKED_UNIFORM : UNIFORM;
    if (pal) {
      for (let i = 0; i < wear.length; i++) {
        if (wear[i]) pal[i] = wear[i].slice();
      }
    }
    // No phone: the `film` layer is our aim pose and a handset would draw in it.
    if (ped.outfit?.props) {
      ped.outfit.props.phone = false;
      ped.outfit.props.umbrella = false;
      ped.outfit.props.umbrellaClosed = false;
      ped.outfit.props.cigarette = false;
    }
    ped.isPolice = true;
    ped.vehicle = null;
    ped.isDriver = false;
    ped.seat = -1;
    if (opts.position) {
      ped.position.copy(opts.position);
      ped.position.y = this.sys.groundAt(opts.position.x, opts.position.z, opts.position.y + 3);
      ped.groundY = ped.position.y;
    }
    ped.state = 'gawk';
    ped.stateTime = 0;
    ped.hasThreat = true;
    ped._gawkFilm = true;
    ped._gawkDist = this.standoff;
    ped.navMode = 'none';
    ped.animator?.clearActs();
    return this;
  }

  release() {
    this.active = false;
    if (this.ped) {
      this.ped.isPolice = false;
      this.ped.animator?.clearActs();
    }
    this.ped = null;
    this.unit = null;
    this.crooked = false;
    this.wasAlive = true;
  }

  get alive() {
    return !!this.ped?.active && !!this.ped?.alive;
  }

  get position() {
    return this.ped?.position ?? _v.set(0, 0, 0);
  }

  /* ==================================================================== */
  /* Frame                                                                */
  /* ==================================================================== */

  update(dt) {
    const ped = this.ped;
    const sys = this.sys;
    if (!ped || !ped.active) { this.active = false; return; }
    this.age += dt;

    if (!ped.alive) {
      this.state = OFFICER.DOWN;
      return;
    }

    // Hold off peds' own timeouts. A gawker quits after ~20 s and a fighter
    // panics after 14; an officer does neither.
    if (ped.stateTime > 5) ped.stateTime = 5;

    const q = sys.quarry;
    if (!q.valid) {
      this._cover(dt, this.anchor, this.standoff);
      return;
    }

    const d = Math.hypot(ped.position.x - q.position.x, ped.position.z - q.position.z);
    const level = sys.level;

    if (this.crooked) {
      // A crooked cop is not an instrument of the wanted level: he hunts
      // whatever the meter says, never arrests, and presses to gunfight range.
      this.state = OFFICER.COVER;
      this._cover(dt, q.position, Math.min(this.standoff, 9));
      this._combat(dt, q, d);
      this._shout(dt, q);
      return;
    }

    const canArrest =
      level > 0 && level <= TUNE.arrestMaxLevel && !q.inVehicle && q.speed < 1.6;

    if (canArrest && d < TUNE.bailoutRange) {
      // An arrest team holds fire: shooting the man you are cuffing is what
      // makes one star lethal, and it reads as a bug.
      this.state = d < TUNE.arrestRange ? OFFICER.ARREST : OFFICER.ADVANCE;
      this._advance(dt, q, d);
    } else {
      this.state = OFFICER.COVER;
      this._cover(dt, q.position, this.standoff);
      this._combat(dt, q, d);
    }

    this._shout(dt, q);
  }

  /* ==================================================================== */
  /* Fire                                                                 */
  /* ==================================================================== */

  /**
   * The aimed shot. Resolution is deliberately the same shape as
   * `src/game/hostiles.js _attack`: a `weapon:fire` for the muzzle flash and
   * the gunshot (fx/audio own what those look and sound like — the flash uses
   * fx's pooled lights, so the visible point-light count never moves), a
   * `bullet:tracer` so the shot reads on screen, and on a hit a
   * `damage:dealt` that the target's own listener applies. Nothing here
   * touches another subsystem's state directly except the documented
   * `vehicles.damage()` entry point.
   */
  _combat(dt, q, d) {
    const sys = this.sys;
    this.fireT -= dt;
    if (!sys.fireEnabled) return;
    const F = TUNE.fire;
    const level = this.crooked ? F.crookedLevel : sys.level;
    if (level < F.fromLevel && !this.crooked) return;
    if (this.fireT > 0 || d > F.range || d < 0.5) return;

    // Never shoot a corpse, and never shoot the real player on behalf of a
    // staged/overridden quarry that is just a point in space.
    const player = sys.playerSys;
    const overridden = !!sys._quarryOverride;
    if (!overridden && player?.health?.dead) return;

    const eye = _v.set(this.ped.position.x, this.ped.position.y + F.muzzleHeight, this.ped.position.z);
    if (!sys.rayVisible(this.ped.position, q.position, F.targetHeight)) {
      this.fireT = F.losRetry;
      return;
    }

    const diff = sys.diff;
    const rng = sys.rng;
    this.fireT = (F.period[clamp(level, 1, 5)] ?? 1.5) / diff.aggr * (0.85 + rng.float() * 0.3);

    /* ---- will it connect? --------------------------------------------- */
    let acc = (F.acc[clamp(level, 1, 5)] ?? 0.5) * (1 - (d / F.range) * F.rangeFade);
    if (q.speed > 2.2) acc *= F.movePenalty;
    if (q.inVehicle && q.speed > 8) acc *= F.fastCarPenalty;
    const hit = rng.float() < clamp01(acc);

    /* ---- the shot, on screen and in the ears -------------------------- */
    const spread = hit ? F.hitSpread : F.missSpread;
    _aim.set(
      q.position.x + (rng.float() - 0.5) * 2 * spread,
      q.position.y + F.targetHeight + (rng.float() - 0.5) * 0.5,
      q.position.z + (rng.float() - 0.5) * 2 * spread
    );
    sys.copShotFx(eye, _aim, this);

    if (!hit) return;

    /* ---- damage, through the canonical paths -------------------------- */
    const dmg = (F.damage[clamp(level, 1, 5)] ?? 8) * diff.dmg;
    if (q.inVehicle && q.vehicle) {
      // 80% lands on the vehicle and the player inside takes none.
      try { sys.vehicles?.damage?.(q.vehicle, dmg * F.vehicleShare * F.vehicleScale, _aim); }
      catch { /* vehicles may not have booted */ }
      sys.statFire(true);
      return;
    }
    if (overridden) { sys.statFire(true); return; }  // a scripted quarry has no HP pool
    if (!player) return;
    const cap = (player.health?.max ?? 100) * F.hitCapFrac;
    sys.copHit(this, Math.min(dmg, cap), q.position, eye);
  }

  /**
   * Hold a covering position: peds' gawk behaviour keeps a ring distance from
   * `threat` and faces it, and we override the pose layers to a weapon-up
   * stance. We also nudge the ring so an officer prefers to be on the FAR side
   * of his own car door from the suspect.
   */
  _cover(dt, at, standoff) {
    const ped = this.ped;
    ped.state = 'gawk';
    ped.hasThreat = true;
    ped.threat.copy(at);
    ped._gawkFilm = true;
    ped._gawkDist = standoff;
    ped.faceTarget = at;
    ped.glanceAt(_v.set(at.x, at.y + 1.5, at.z), 1, 0.5);
    const an = ped.animator;
    if (an) {
      an.setAct('film', 1);          // both hands up at eye level — the aim
      an.setAct('gawk', 0);
      an.setAct('phone', 0);
      an.setAct('carry', 0);
      an.setAct('umbrella', 0);
    }
  }

  _advance(dt, q, d) {
    const ped = this.ped;
    ped.state = 'fight';
    ped.fightTarget = q.position;
    ped.faceTarget = q.position;
    const an = ped.animator;
    if (an) {
      an.setAct('film', d > 3.5 ? 0.75 : 0);
      an.setAct('talk', d > 3.5 ? 0 : 0.9);
    }
    if (d < TUNE.arrestRange && q.speed < 1.6) {
      this.arrestT += dt;
      if (this.arrestT >= TUNE.arrestTime) {
        this.arrestT = 0;
        this.sys.bust(this);
      }
    } else {
      this.arrestT = Math.max(0, this.arrestT - dt * 1.5);
    }
  }

  /** "Out of the vehicle!" — a talk layer plus a dispatch line through audio. */
  _shout(dt, q) {
    this.shoutT -= dt;
    if (this.shoutT > 0) return;
    this.shoutT = 3.2 + (this.ped.id % 5) * 0.7;
    const an = this.ped.animator;
    if (an) {
      an.talkEnergy = 1.35;
      an.setAct('talk', 1);
    }
    const audio = this.sys.audio;
    if (audio?.play) {
      try {
        audio.play('city', this.ped.position, { which: 'shout', level: 0.7, near: true });
      } catch { /* audio may be suspended before a user gesture */ }
    }
  }
}

/* ====================================================================== */

/**
 * Pool + lifecycle for every officer on the street. Officers are borrowed from
 * the `peds` population, so this also enforces a ceiling: a chase must never
 * eat the whole pedestrian budget, or the street it is happening on empties.
 */
export class OfficerPool {
  constructor(sys) {
    this.sys = sys;
    this.list = [];
    this._pool = [];
    this._anchor = new THREE.Vector3();
    /**
     * BODIES WE HAVE ALREADY BORROWED — the fix for police starving the ped
     * budget, see `_borrow`.
     */
    this._reserve = [];
    this._cam = new THREE.Vector3();
  }

  get count() {
    return this.list.length;
  }

  /** Ceiling: at most a third of the ped budget, and never more than eight. */
  get max() {
    const peds = this.sys.peds;
    const budget = peds?.budget ?? 24;
    return Math.max(2, Math.min(8, Math.floor(budget * 0.28)));
  }

  /**
   * ONE BODY, AND THE BUDGET CONTRACT BEHIND IT.
   *
   * `peds` is the authority on its own population and `attachDriver` is the
   * only public door in, so that is always the first ask. The problem is what
   * happens when it says no, which after a couple of chases is the NORMAL
   * state rather than an edge case:
   *
   *   every officer we retire is handed BACK TO THE CROWD as an ordinary
   *   pedestrian (`retire` / `clear` — deliberately, because deleting a person
   *   in front of the player is worse than any budget), and `peds` only
   *   reclaims a pedestrian once it has walked 145 m from the player or died.
   *   During a chase nobody walks 145 m. So each stand-down permanently
   *   inflates the live population by the size of the response, `_freePed()`
   *   runs dry, and every later `spawnCop()` — including the forced,
   *   mission-critical ones the `copwar` job depends on — returns null.
   *
   * Measured before this: the harness's crooked-cop test ran after a phase that
   * had already deployed six officers and got `null` every time; four checks
   * failed on it, including both halves of the crooked-cop API.
   *
   * The contract, which needs nothing from `peds`: police re-adopts a body it
   * ALREADY BORROWED before it asks for another one. `_reserve` holds the peds
   * we handed back and have not seen despawned, and the one furthest from the
   * camera is taken first, so nobody watches a pedestrian blink out. Our
   * footprint on `pedBudget` is then bounded by the officer ceiling no matter
   * how many times a chase starts and ends.
   */
  _borrow(vehicle, seat) {
    const peds = this.sys.peds;
    if (!peds?.attachDriver) return null;
    let ped = null;
    try {
      ped = peds.attachDriver(vehicle ?? null, seat ?? 0, { archetype: 'office' });
    } catch { ped = null; }
    if (ped) return ped;
    return this._recycle();
  }

  /** Take back the least conspicuous body we lent to the crowd, or null. */
  _recycle() {
    const cam = this.sys.ctx?.camera;
    if (cam) cam.getWorldPosition(this._cam);
    let best = -1;
    let bestD = -1;
    for (let i = this._reserve.length - 1; i >= 0; i--) {
      const p = this._reserve[i];
      // Gone: `peds` despawned it, it died on the street, or the slot has been
      // re-granted to somebody else — `traffic` takes drivers through the same
      // door and stealing one would empty a moving car. Either way it is no
      // longer ours to lend back to ourselves.
      if (!p || !p.active || p.alive === false || p.isPolice || p.vehicle) {
        this._reserve.splice(i, 1);
        continue;
      }
      const d = cam ? Math.hypot(p.position.x - this._cam.x, p.position.z - this._cam.z) : i;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best < 0) return null;
    const ped = this._reserve[best];
    this._reserve.splice(best, 1);
    return ped;
  }

  /** Remember a body we are handing back, so we can re-borrow it later. */
  _lend(ped) {
    if (!ped || !ped.active || ped.alive === false) return;
    if (this._reserve.includes(ped)) return;
    if (this._reserve.length >= 12) this._reserve.shift();
    this._reserve.push(ped);
  }

  /**
   * Put an officer on the ground beside `vehicle`. Returns the Officer, or
   * null when `peds` has nobody spare (it is the authority on its own budget).
   */
  deployFrom(unit, seat = 0, opts = {}) {
    const peds = this.sys.peds;
    const v = unit?.vehicle;
    if (!peds?.attachDriver || !v) return null;
    if (this.list.length >= this.max) return null;

    const ped = this._borrow(v, seat);
    if (!ped) return null;

    // Stand them at the door they would have come out of.
    const anchor = this._doorPoint(v, seat, this._anchor);
    const o = this._pool.pop() ?? new Officer(this.sys);
    o.adopt(ped, {
      unit,
      position: anchor,
      anchor,
      standoff: opts.standoff ?? (5.5 + (this.list.length % 3) * 1.6),
    });
    this.list.push(o);
    unit.officers.push(o);
    return o;
  }

  _doorPoint(v, seat, out) {
    const side = seat % 2 === 0 ? -1 : 1;
    const row = seat < 2 ? 0 : 1;
    out.set(side * (v.spec.half.x + 0.75), 0, 0.5 - row * 1.1);
    out.applyQuaternion(v.quaternion);
    out.x += v.position.x;
    out.z += v.position.z;
    out.y = v.position.y;
    return out;
  }

  /**
   * Put an officer on his feet at a world position with no cruiser behind him
   * — the pavement responders and the `spawnCop()` API. The ped is borrowed
   * through the same public `attachDriver` door `deployFrom` uses (it accepts
   * a null vehicle and `adopt` overwrites every vehicle field), so there is
   * still exactly one way a body enters this system.
   */
  deployAt(position, opts = {}) {
    const peds = this.sys.peds;
    if (!peds?.attachDriver || !position) return null;
    if (!opts.force && this.list.length >= this.max) return null;

    const ped = this._borrow(null, 0);
    if (!ped) return null;

    this._anchor.set(position.x, position.y ?? 0, position.z);
    const o = this._pool.pop() ?? new Officer(this.sys);
    o.adopt(ped, {
      unit: null,
      position: this._anchor,
      anchor: this._anchor,
      standoff: opts.standoff ?? (6 + (this.list.length % 3) * 1.4),
      crooked: opts.crooked,
    });
    this.list.push(o);
    return o;
  }

  /** Foot responders with no cruiser — what the foot-dispatch target counts. */
  get standalone() {
    let n = 0;
    for (const o of this.list) if (!o.unit && !o.crooked) n++;
    return n;
  }

  get crookedCount() {
    let n = 0;
    for (const o of this.list) if (o.crooked && o.alive) n++;
    return n;
  }

  /** Officers who ARE the law — everyone but the crooked variant. */
  get lawCount() {
    let n = 0;
    for (const o of this.list) if (!o.crooked) n++;
    return n;
  }

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const o = this.list[i];
      /**
       * RE-ENTRANCY. This list can be emptied from inside `o.update(dt)`:
       * `_advance` finishes an arrest -> `sys.bust()` -> `clearWanted()` ->
       * `_standDownAll()` -> `officers.clear()`, which removes every entry,
       * including the ones a reverse loop has not reached yet. The next
       * iteration then read a hole and threw
       * `TypeError: Cannot read properties of undefined (reading 'update')` —
       * a crash seen twice in long escalating pursuits, always just after a
       * bust, and never reproducible from any subsystem in isolation.
       * The `officerDown` emit below can do the same thing through a listener.
       */
      if (!o) continue;
      o.update(dt);
      // The death transition, exactly once per officer, whatever killed him.
      // `peds` owns the ragdoll and the `actor:death`; this is the cop-shaped
      // event the economy pays on and the copwar job counts. Gated on
      // `ped.alive === false` specifically — a ped the streamer despawns while
      // still breathing is a recycle, not a death.
      if (o.wasAlive && o.ped && o.ped.alive === false) {
        o.wasAlive = false;
        this.sys.officerDown(o);
      }
      // ...and only retire him if he is still ours to retire: a re-entrant
      // `clear()` has already done it, and retiring twice would push the same
      // Officer into the free pool twice and hand one object to two deploys.
      if ((!o.active || !o.ped?.active) && this.list.indexOf(o) >= 0) {
        this.retire(o);
      }
    }
  }

  retire(o) {
    const i = this.list.indexOf(o);
    if (i >= 0) this.list.splice(i, 1);
    // Keep the body on the books: it stays in the crowd as a pedestrian, and
    // re-adopting it later is cheaper for `peds` than being asked for a new one.
    this._lend(o.ped);
    if (o.unit) {
      const j = o.unit.officers.indexOf(o);
      if (j >= 0) o.unit.officers.splice(j, 1);
    }
    // A dead officer stays on the street as a body — `peds` owns the ragdoll
    // and its own clean-up. We only stop steering it.
    o.release();
    if (this._pool.length < 12) this._pool.push(o);
  }

  /**
   * Stand the law down. Crooked cops are NOT the law — they belong to whatever
   * job spawned them and losing the wanted level must not despawn a mission's
   * targets — so they survive unless `all` is set (dispose).
   */
  clear(all = false) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const o = this.list[i];
      if (o.crooked && !all) continue;
      // Send them back to being pedestrians rather than deleting a body in
      // front of the player.
      const ped = o.ped;
      if (ped?.active) {
        ped.state = 'walk';
        ped.navMode = 'wander';
        ped.hasThreat = false;
        ped.animator?.clearActs();
      }
      this.retire(o);
    }
  }

  /** Is this ped one of ours? Used to price killing a cop. */
  owns(ped) {
    for (const o of this.list) if (o.ped === ped) return true;
    return false;
  }

  /** The Officer steering a ped, or null — the crooked flag lives on it. */
  officerOf(ped) {
    for (const o of this.list) if (o.ped === ped) return o;
    return null;
  }

  /** Officers see too — a foot cop with eyes on you keeps the level hot.
   *  Crooked cops do not report to dispatch. */
  sightCheck(q, sys) {
    for (let i = 0; i < this.list.length; i++) {
      const o = this.list[i];
      if (!o.alive || o.crooked) continue;
      const d = Math.hypot(o.position.x - q.position.x, o.position.z - q.position.z);
      if (d > 65) continue;
      if (sys.rayVisible(o.position, q.position, 1.6)) return true;
    }
    return false;
  }
}

export { clamp };
