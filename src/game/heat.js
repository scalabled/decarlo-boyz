/**
 * GAME — the wanted-level bridge.
 *
 * `police` is a 26-line stub: `wanted` is hard-wired to 0, `reportCrime()` and
 * `clearWanted()` have empty bodies, and nothing in the repo emits
 * `wanted:change` or `wanted:heat`. Two of the twenty-four chapters are
 * `escape` tracks whose entire objective is shedding stars, and BUSTED is one
 * of the three mission outcomes, so the game cannot be played end to end
 * without a wanted level existing somewhere.
 *
 * So this owns it — PROVISIONALLY, and it says so out loud:
 *
 *   - At init it probes `police` for a real implementation (`setWanted`,
 *     `raiseWanted`, or a `getHudState`). If it finds one, `authoritative`
 *     goes false and everything here becomes a pass-through: the police
 *     system's numbers win, and this only reads them.
 *   - While authoritative it emits the two canonical events with their exact
 *     documented payloads. Four already-wired consumers pick them up for free:
 *     the HUD stars (`ui/index.js` wanted:change), the siren/tension audio
 *     (`audio/index.js`), the traffic alert state (`traffic/index.js`) and ped
 *     panic (`peds/index.js` wanted:heat).
 *   - The pursuit cars it spawns are `vehicles`' own `police` class with
 *     `lightbarOn = true`, which is the documented hook traffic reads to make
 *     cars pull over. No cop AI is duplicated — they drive straight at you and
 *     that is deliberately all they do.
 *
 * Delete the pursuit half of this file the day `police` lands. The star
 * accounting, the search-cone cooldown and the bust rules are gameplay rules
 * and can stay.
 */

import * as THREE from 'three';
import { clamp, clamp01, dist, wrapAngle, yawOf } from './util.js';

/** Seconds out of sight, per star, before the level drops one. */
const COOLDOWN = [0, 14, 20, 27, 36, 48];
/** Cars the escalation wants on the street at each star. DESIGN.md wanted table. */
const UNITS = [0, 1, 2, 3, 5, 6];
/** How close a cruiser has to be to count as "eyes on you". */
const SIGHT = 110;
/** Seconds inside the bust radius, stopped, before you get hauled in. */
const BUST_TIME = 2.6;
const BUST_RADIUS = 14;
const EMPTY_OPTS = Object.freeze({});

export class Heat {
  constructor(ctx, q) {
    this.ctx = ctx;
    this.q = q;
    this.rng = ctx.rng.fork();

    this.level = 0;
    this.prev = 0;
    /** 0..1 — 1 means actively hunted, falling to 0 as the search dies. */
    this.cooldown = 1;
    this.hunting = false;
    this.authoritative = true;

    this.cops = [];
    this._spawnT = 0;
    this._searchT = 0;
    this._bustT = 0;
    this._sinceChange = 0;
    /** Last place the police were sure you were — the centre of the search. */
    this.searchX = 0;
    this.searchZ = 0;

    this._changePayload = { level: 0, prev: 0 };
    this._heatPayload = { position: new THREE.Vector3(), radius: 60 };
    this._input = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };
    this._v = new THREE.Vector3();
    this._enabled = true;
    this.onBusted = null;
  }

  init() {
    const p = this.ctx.peek('police');
    // A real police system announces itself by having any way to SET the level.
    const real = !!p && (
      typeof p.setWanted === 'function' ||
      typeof p.raiseWanted === 'function' ||
      typeof p.getHudState === 'function' ||
      p.hudState !== undefined
    );
    this.authoritative = !real;
    this._police = p ?? null;
    // `police` emits this when an officer completes an arrest and documents
    // that `game` is the consumer. When `game` owns the level instead, the
    // same callback is fired from this file's own bust timer.
    this._offBusted = this.ctx.events.on('police:busted', () => this.onBusted?.());
    return this;
  }

  /* --------------------------------------------------------------- state -- */

  /**
   * The star count as a NUMBER.
   *
   * `police.wanted` is NOT the number — it is the `WantedModel` instance, and
   * the integer lives on `police.level` / `police.getHudState().wanted`. Reading
   * the wrong one is silent and expensive: `escape` compares `wanted === 0`, so
   * an object there means the chapter can never complete, and anything that
   * publishes it (`getHudState`, a harness snapshot) drags the whole engine
   * object graph along with it. Resolve it defensively and once.
   */
  _readLevel() {
    const p = this._police;
    if (!p) return 0;
    if (typeof p.level === 'number') return p.level;
    if (typeof p.wanted === 'number') return p.wanted;
    const hud = typeof p.getHudState === 'function' ? p.getHudState() : p.hudState;
    return typeof hud?.wanted === 'number' ? hud.wanted : 0;
  }

  get wanted() {
    if (!this.authoritative) return this._readLevel();
    return this.level;
  }

  /** Raise to at least `n`. Never lowers — use `clear()` for that. */
  raise(n, x, z) {
    const want = clamp(n | 0, 0, 5);
    if (!this.authoritative) {
      const p = this._police;
      // `setWanted` is exact, which is what an `escape` chapter needs — it is
      // written against "start me at three stars", not "add some heat".
      if (typeof p?.setWanted === 'function') p.setWanted(Math.max(this._readLevel(), want));
      else p?.reportCrime?.('mission', this._v.set(x ?? 0, 0, z ?? 0), want);
      return this.wanted;
    }
    if (x !== undefined) { this.searchX = x; this.searchZ = z; }
    this._searchT = 0;
    this.cooldown = 1;
    if (want <= this.level) return this.level;
    this._set(want);
    return this.level;
  }

  /**
   * Commit a CRIME, priced by `police`'s own tune table, rather than asserting
   * a star count. This is the honest path for anything the player DOES —
   * carjacking, ramming, a body on the pavement — because `police` gets to
   * decide what it is worth, whether anyone saw it, and where the search
   * re-centres. `raise()` remains for scripts that need an exact level.
   *
   * `kind` MUST be a key of `CRIME_HEAT` in `src/police/tune.js`:
   *   speeding reckless hitCar trespass carjack vandal brawl gunfire
   *   hitPed woundPed killPed ramCop gunfireAtCop woundCop killCop
   *   destroyCruiser explosion mission
   * An unknown kind is silently repriced as `reckless` (2.2 heat, well under
   * the 10 a first star costs), so a typo reads in play as "nothing happened".
   *
   * @returns the new star count.
   */
  report(kind, position, severity = 1, opts = EMPTY_OPTS, reason = kind) {
    if (!this.authoritative) {
      const p = this._police;
      if (typeof p?.reportCrime === 'function') {
        this._v.set(position?.x ?? 0, position?.y ?? 0, position?.z ?? 0);
        p.reportCrime(kind, this._v, severity, opts);
        return this.wanted;
      }
      return this.wanted;
    }
    // Owning the level ourselves there is no heat meter to feed, so the
    // provisional model is the simple one: one crime, one star.
    void reason;
    return this.raise(this.level + 1, position?.x, position?.z);
  }

  set(n) {
    if (!this.authoritative) {
      this._police?.setWanted?.(clamp(n | 0, 0, 5));
      return this.wanted;
    }
    const want = clamp(n | 0, 0, 5);
    if (want === this.level) return this.level;
    this._set(want);
    return this.level;
  }

  clear(reason = 'clean') {
    this._police?.clearWanted?.(reason);
    if (!this.authoritative) return;
    this._searchT = 0;
    this._bustT = 0;
    if (this.level === 0) return;
    this._set(0, reason);
    this._purge();
  }

  _set(n, reason = '') {
    this.prev = this.level;
    this.level = n;
    this._sinceChange = 0;
    this.cooldown = n > 0 ? 1 : 0;
    this.hunting = n > 0;
    const p = this._changePayload;
    p.level = n;
    p.prev = this.prev;
    p.reason = reason;
    this.ctx.events.emit('wanted:change', p);
    // Mirror onto the stub so anything that polls `police.wanted` agrees with
    // the HUD. Guarded: only ever written while WE are the authority.
    if (this._police && this.authoritative) this._police.level = n;
  }

  /**
   * A gunshot, an explosion, a body on the pavement — the crowd scatters and
   * the search re-centres.
   *
   * `wanted:heat` is `police`'s event in the ARCHITECTURE.md table. When the
   * real system is present, emitting it from here would put a second, lying
   * source of "where they think you are" on the bus, so this uses `peds.panic`
   * — the public call `police` itself makes — and lets police own the cordon.
   */
  heat(x, z, radius = 60) {
    if (!this.authoritative) {
      try { this.ctx.peek('peds')?.panic?.(this._v.set(x, 0, z), radius, 0.6); } catch { /* peds optional */ }
      return;
    }
    const p = this._heatPayload;
    p.position.set(x, 0, z);
    p.radius = radius;
    this.ctx.events.emit('wanted:heat', p);
    if (this.level > 0) {
      this.searchX = x;
      this.searchZ = z;
      this._searchT = 0;
    }
  }

  /** Pursuit spawning off, star accounting on — used during scripted chapters. */
  setPursuitEnabled(on) {
    this._enabled = !!on;
    if (!on) this._purge();
  }

  /* --------------------------------------------------------------- frame -- */

  update(dt, wq) {
    if (!this.authoritative) {
      this.level = this._readLevel();
      const c = this._police?.cooldown;
      this.cooldown = typeof c === 'number' ? c : 1;
      this.hunting = this._police?.hunting === true;
      return;
    }
    this._sinceChange += dt;
    if (this.level === 0) {
      if (this.cops.length) this._purge();
      this._bustT = 0;
      return;
    }

    const focus = wq.focusPos(this._v);
    const px = focus.x;
    const pz = focus.z;

    this._prunePursuit();
    if (this._enabled) this._maintainPursuit(dt, wq, px, pz);
    this._drivePursuit(dt, px, pz, wq);

    // ---- line of sight -> cooldown ---------------------------------------
    let seen = false;
    let nearest = Infinity;
    for (const c of this.cops) {
      const d = dist(c.position.x, c.position.z, px, pz);
      if (d < nearest) nearest = d;
      if (d < SIGHT) seen = true;
    }
    // With no cruisers alive yet, the dispatch still has your last position for
    // a while — otherwise a 5-star would evaporate before a car ever arrived.
    if (!this.cops.length && this._sinceChange < 8) seen = true;

    if (seen) {
      this._searchT = 0;
      this.cooldown = 1;
      this.hunting = true;
      this.searchX = px;
      this.searchZ = pz;
    } else {
      this._searchT += dt;
      const need = COOLDOWN[this.level] ?? 20;
      this.cooldown = clamp01(1 - this._searchT / need);
      this.hunting = false;
      if (this._searchT >= need) {
        this._searchT = 0;
        this._set(this.level - 1, 'cooled');
        if (this.level === 0) this._purge();
      }
    }

    // ---- busted ----------------------------------------------------------
    const player = wq.player;
    const speed = player?.inVehicle ? Math.abs(wq.playerVehicle()?.forwardSpeed ?? 0) : (player?.horizontalSpeed ?? 0);
    if (nearest < BUST_RADIUS && speed < 2.2 && !player?.dead) {
      this._bustT += dt;
      if (this._bustT >= BUST_TIME) {
        this._bustT = 0;
        this.onBusted?.();
      }
    } else {
      this._bustT = Math.max(0, this._bustT - dt * 1.5);
    }
  }

  /* ------------------------------------------------------------- pursuit -- */

  _prunePursuit() {
    for (let i = this.cops.length - 1; i >= 0; i--) {
      const c = this.cops[i];
      if (!c || c.destroyed) this.cops.splice(i, 1);
    }
  }

  _maintainPursuit(dt, wq, px, pz) {
    this._spawnT -= dt;
    const want = UNITS[this.level] ?? 0;
    if (this.cops.length >= want || this._spawnT > 0) return;
    this._spawnT = 3.4 - this.level * 0.4;
    const spot = wq.findRoadSpot(150, 320, px, pz);
    const v = wq.spawnVehicle('police', spot.x, spot.z, spot.yaw);
    if (!v) return;
    // The one documented hook: traffic yields to anything with a lit lightbar.
    v.lightbarOn = true;
    v.sirenOn = true;
    v.isPursuit = true;
    this.cops.push(v);
  }

  /**
   * Deliberately dumb pursuit: point at the player, floor it, handbrake if the
   * angle is hopeless. This is a placeholder for `police`'s pursuit driving —
   * it exists so `escape` is a real objective, not so it is good AI.
   */
  _drivePursuit(dt, px, pz, wq) {
    const veh = wq.vehicles;
    if (!veh?.setInput) return;
    const inp = this._input;
    for (const c of this.cops) {
      const want = Math.atan2(px - c.position.x, pz - c.position.z);
      const yaw = yawOf(c);
      const err = wrapAngle(want - yaw);
      const d = dist(c.position.x, c.position.z, px, pz);
      inp.steer = clamp(err * 1.5, -1, 1);
      inp.throttle = d > 14 ? 1 : 0.2;
      inp.brake = d < 9 ? 0.6 : 0;
      inp.handbrake = Math.abs(err) > 1.7 && Math.abs(c.forwardSpeed ?? 0) > 16;
      inp.boost = d > 90 && this.level >= 3;
      veh.setInput(c, inp);
      // 5 stars: they will ram you. DESIGN.md wanted table.
      if (this.level >= 5 && d < 7) veh.damage?.(c, 2 * dt, null);
    }
  }

  _purge() {
    const veh = this.ctx.peek('vehicles');
    for (const c of this.cops) {
      c.lightbarOn = false;
      c.sirenOn = false;
      veh?.despawn?.(c);
    }
    this.cops.length = 0;
  }

  dispose() {
    this._offBusted?.();
    this._purge();
  }
}
