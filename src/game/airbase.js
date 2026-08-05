/**
 * GAME — RIDGELINE AFB: the restricted-zone ASSAULT encounter.
 *
 * A FREE-ROAM ENCOUNTER, not a story chapter. `world.airbase` publishes the
 * fence polygon, gates, patrol loop, apron parking and `insidePerimeter` —
 * this module consumes that API (never re-deriving a spatial fact, per the
 * one-fact-one-owner rule) and makes the base defend itself:
 *
 *   - CROSSING THE PERIMETER arms the encounter: a klaxon (the existing
 *     positioned siren one-shot, re-fired on a loop), a HUD warning
 *     ("RESTRICTED AREA — LETHAL FORCE AUTHORIZED"), and a 'trespass' crime
 *     reported through the EXISTING heat vocabulary. Trespass is priced by
 *     `police`'s own tune table (3.0 heat — under a first star on its own)
 *     rather than this module asserting a star count: the garrison, not the
 *     city police, is the threat inside the wire, and the police price the
 *     crime the way they price every other one. Kills the player scores
 *     against guards then escalate stars exactly like any other body
 *     (`actor:death` is already priced).
 *
 *   - GUARDS: waves of RANGED hostiles from the published patrol waypoints
 *     and gate posts, via the existing hostile pool (`peds.spawnHostile` —
 *     real Peds with capsules, collision and ragdolls). Rifle-class stand-off:
 *     range 54 m, the hostile brain's own tracer + damage path. Capped at
 *     GUARD_CAP alive so the fight is intense but never a wall of bodies,
 *     reinforced in small waves while the player stays inside.
 *
 *   - TANK EMPLACEMENTS: the parked Bulwarks seeded on the published apron
 *     slots become live emplacements — `v.aimTurret(point)` slews the EMITTED
 *     turret at spec rates (it keeps tracking while the hull sleeps, by
 *     design), and `v.fireShell()` lobs the 105 m/s shell every 4-6 s when
 *     range and line of sight permit. The shell is slow and loud — dodgeable
 *     on foot — and detonates through the canonical 'explosion' event.
 *     HOLD-FIRE RULE: while the jet chase is live the tanks track but do not
 *     fire — the interceptors own an airborne (or boarded) target, and a
 *     105 m/s shell against a jet is wasted fire-control. It also means the
 *     stolen jet is not deleted on the apron before the chase can happen.
 *
 *   - PATROL JEEPS: the existing 'suv' class in a one-off matte olive-drab —
 *     a paint override on spawn, the same trivial-variant path `boss.js`
 *     already uses — that drive at the player while the base is armed, using
 *     the shared `driveToward` (the same physics-respecting steering every
 *     mission driver and the provisional pursuit use). No new vehicle class.
 *
 *   - WIND-DOWN: leaving the perimeter starts a cooldown; keeping line of
 *     sight from the garrison slows it, breaking it (or getting far away)
 *     runs it at full rate. On stand-down the guards are despawned through
 *     the hostile pool, the turrets stop tracking and the jeeps stop.
 *     Everything also winds down on player death / respawn / save adoption
 *     via `reset()` (wired in `game/index.js` beside `hostiles.clear()`).
 *
 *   - STEAL A JET: boarding any 'jet' inside the perimeter (the canonical
 *     'vehicle:enter' event) flags the theft and scrambles two pursuit jets —
 *     see `jetchase.js`.
 *
 * NEGATIVE-CONTROL HATCH: `?noassault=1` / `OW_NO_ASSAULT=1` leaves the base
 * dressed (parked jets, tanks, jeeps) but inert — nothing arms, nothing
 * chases. Same shape as `?noairbase=1`, under which `world.airbase.pad` is
 * null and this module does nothing at all.
 *
 * ARCHITECTURE.md: rule 2 (subsystems via `wq`/`ctx.peek`, the airbase via
 * the published `world.airbase` object), rule 4 (forked rng), rule 5 (all
 * scratch preallocated; the arm/disarm edges may allocate, frames may not).
 * The pause contract: this module reads NO input; while paused `dt` is 0 and
 * every timer holds, and 'vehicle:enter' cannot fire behind a menu.
 */

import * as THREE from 'three';
import { wrapAngle, dist, dist2, driveToward } from './util.js';
import { JetChase } from './jetchase.js';

/** Concurrent armed guards. HOSTILE_MAX is 24 pool-wide; 8 leaves the story
 *  chapters their share even if one is somehow live at the same time. */
const GUARD_CAP = 8;
/** Guards per reinforcement wave, and seconds between waves. */
const WAVE_SIZE = 3;
const WAVE_PERIOD = 7;
/** Rifle-class stand-off guard. `range` is the hostile brain's fire range. */
const GUARD_OPTS = {
  hp: 90, dmg: 8, ranged: true, range: 54, speed: 3.4, tag: 'airbase', leash: 140,
};
/** Guard spawn annulus around the player, m — in sight, not in his face. */
const SPAWN_MIN = 28;
const SPAWN_MAX = 185;

/** Emplacements armed / jets parked / jeeps on patrol. */
const TANK_N = 3;
const JET_N = 3;
const JEEP_N = 2;
/** Main-gun envelope, m, and the cadence between shells (reload is 4 s). */
const TANK_RANGE = 230;
const TANK_MIN = 22;
const FIRE_PERIOD = 4.2;
const FIRE_JITTER = 1.8;
/** Fire only once the emitted turret bears within this, rad. */
const AIM_TOL = 0.06;

/** Seconds outside the wire before the base stands down. */
const OUT_COOLDOWN = 12;
/** Beyond this far from the fence the cooldown runs full rate regardless. */
const FAR_DIST = 220;
/** Klaxon re-fire and HUD warning cadence, s. */
const ALARM_PERIOD = 6.5;
const WARN_PERIOD = 24;

/** Matte olive drab for the patrol Overlooks — a paint override, not a class. */
const JEEP_PAINT = 0x39412e;

export function assaultDisabled() {
  try {
    if (typeof location !== 'undefined' &&
      new URLSearchParams(location.search).get('noassault') === '1') return true;
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.OW_NO_ASSAULT === '1') return true;
  } catch { /* no process */ }
  return false;
}

export class AirbaseAssault {
  constructor(ctx, { wq, heat, hostiles }) {
    this.ctx = ctx;
    this.wq = wq;
    this.heat = heat;
    this.hostiles = hostiles;
    this.rng = ctx.rng.fork();
    this.disabled = assaultDisabled();

    this.chase = new JetChase(ctx, wq, this.rng.fork());

    /** The published layout — resolved lazily off `world.airbase`. */
    this.ab = null;
    this._seeded = false;

    this.armed = false;
    this.guards = [];
    this.tanks = [];
    this.jets = [];
    this.jeeps = [];

    this._waveT = 0;
    this._alarmT = 0;
    this._warnT = 0;
    this._outT = 0;
    this._losT = 0;
    this._losBroken = false;
    this._jeepsStopped = true;

    /* ---- scratch: nothing in update() allocates ---- */
    this._v = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._muz = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._alarmAt = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._jeepInp = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };
    this._zeroInp = Object.freeze({ throttle: 0, brake: 0, steer: 0, handbrake: false, boost: 0 });
    this._cand = new Array(32); // muster-point coordinates, reused
    this._lo = { a: 0, d: 0 };  // field-local scratch for the fence distance
  }

  init() {
    this._offs = [
      this.ctx.events.on('vehicle:enter', (e) => this._onEnter(e)),
    ];
    return this;
  }

  /** Alive guards on their feet — reads the EMITTED population, not a count. */
  get guardCount() {
    let n = 0;
    for (let i = 0; i < this.guards.length; i++) {
      const g = this.guards[i];
      if (g.active && g.alive && g.isHostile) n++;
    }
    return n;
  }

  /** Diagnostics for `game.stats` and the probe. Menu-rate, may allocate. */
  get stats() {
    return {
      on: !!this.ab,
      disabled: this.disabled,
      armed: this.armed,
      guards: this.guardCount,
      tanks: this.tanks.length,
      jets: this.jets.length,
      jeeps: this.jeeps.length,
      chase: this.chase.active,
      chasePhase: this.chase.phase,
      pursuers: this.chase.count,
      outT: +this._outT.toFixed(2),
    };
  }

  /* ================================================================== */
  /* frame                                                              */
  /* ================================================================== */

  update(dt) {
    const ab = this.ab ?? this._resolve();
    if (!ab) return;
    if (!this._seeded) this._seed(ab);

    // Prune wrecked armour / stolen handles out of the emplacement list.
    for (let i = this.tanks.length - 1; i >= 0; i--) {
      const t = this.tanks[i];
      if (!t.v || t.v.destroyed) this.tanks.splice(i, 1);
    }
    for (let i = this.guards.length - 1; i >= 0; i--) {
      const g = this.guards[i];
      if (!g.active || !g.isHostile) this.guards.splice(i, 1);
    }

    const pos = this.wq.focusPos();
    const px = pos.x;
    const pz = pos.z;
    const py = pos.y;
    const inside = typeof ab.insidePerimeter === 'function' && ab.insidePerimeter(px, pz);
    const playerAlive = !(this.wq.player?.dead);

    if (!this.disabled && inside && !this.armed && playerAlive) this._arm(px, pz);

    if (this.armed) {
      this._cooldown(dt, inside, px, pz);
      this._alarm(dt, inside, px, pz);
      this._waves(dt, inside, px, pz);
      this._emplacements(dt, px, py, pz);
      this._patrol(dt, px, pz, inside);
    }

    this.chase.update(dt);
  }

  /* ================================================================== */
  /* arming and standing down                                           */
  /* ================================================================== */

  _arm(px, pz) {
    this.armed = true;
    this._outT = 0;
    this._waveT = 0;   // first wave immediately
    this._alarmT = 0;  // klaxon immediately
    this._warnT = 0;   // warning immediately
    for (const t of this.tanks) t.fireT = 1.6 + this.rng.float() * FIRE_JITTER;
    this._jeepsStopped = false;
    // The trespass, priced by the police's own table (see the header).
    this.heat?.report?.('trespass', this.wq.focusPos(), 1);
  }

  _disarm() {
    this.armed = false;
    this._outT = 0;
    // Guards stand down: through the pool's despawn chokepoint.
    for (let i = this.guards.length - 1; i >= 0; i--) this.hostiles?.despawn?.(this.guards[i]);
    this.guards.length = 0;
    // Turrets stop tracking; `stepTurret` goes inert on the cleared flag.
    for (const t of this.tanks) { if (t.v) t.v.turretAimActive = false; }
    this._stopJeeps();
  }

  /**
   * Leaving the perimeter winds the encounter down. Holding line of sight
   * from the garrison slows the clock; breaking it — or being far from the
   * fence — runs it at full rate.
   */
  _cooldown(dt, inside, px, pz) {
    if (inside) {
      this._outT = 0;
      return;
    }
    // One LOS ray a second, from the first live emplacement (or a guard).
    this._losT -= dt;
    if (this._losT <= 0) {
      this._losT = 1;
      this._losBroken = !this._garrisonSees(px, pz);
    }
    const far = this._fenceDist(px, pz) > FAR_DIST;
    this._outT += dt * (far || this._losBroken ? 1 : 0.45);
    if (this._outT >= OUT_COOLDOWN) this._disarm();
  }

  _garrisonSees(px, pz) {
    const phys = this.wq.physics;
    if (!phys?.raycast) return true;
    const eye = this.tanks.length ? this.tanks[0].v?.position : this.guards[0]?.position;
    if (!eye) return false;
    this._muz.set(eye.x, eye.y + 2.4, eye.z);
    this._dir.set(px - this._muz.x, (this.wq.groundY(px, pz) + 1.4) - this._muz.y, pz - this._muz.z);
    const d = this._dir.length();
    if (d < 1) return true;
    this._dir.multiplyScalar(1 / d);
    const hit = phys.raycast(this._muz, this._dir, d, phys.MASK?.WORLD ?? 0);
    return !(hit?.hit && hit.distance < d - 3);
  }

  /** Approximate distance outside the fence, using the published layout. */
  _fenceDist(px, pz) {
    const ab = this.ab;
    if (!ab?.localAt || !ab.layout) return Infinity;
    const lo = ab.localAt(px, pz, this._lo);
    let best = Infinity;
    for (const f of [ab.layout.fieldStrip, ab.layout.fieldApron]) {
      if (!f) continue;
      const qa = Math.max(f.a0 - lo.a, lo.a - f.a1, 0);
      const qd = Math.max(f.d0 - lo.d, lo.d - f.d1, 0);
      const dd = Math.hypot(qa, qd);
      if (dd < best) best = dd;
    }
    return best;
  }

  /* ================================================================== */
  /* the klaxon and the warning                                         */
  /* ================================================================== */

  _alarm(dt, inside, px, pz) {
    this._alarmT -= dt;
    this._warnT -= dt;
    if (this._alarmT <= 0) {
      this._alarmT = ALARM_PERIOD;
      // The existing positioned siren one-shot, from the nearest gate — the
      // klaxon is a place in the world, not a head-locked jingle.
      const g = this._nearestGate(px, pz);
      if (g && this._fenceDist(px, pz) < 420) {
        this._alarmAt.set(g.x, this.wq.groundY(g.x, g.z) + 6, g.z);
        this.wq.sfx('ambient', this._alarmAt, ALARM_OPTS);
      }
    }
    if (inside && this._warnT <= 0) {
      this._warnT = WARN_PERIOD;
      this.wq.ui?.notify?.('Restricted area', 'LETHAL FORCE AUTHORIZED', 'bad');
    }
  }

  _nearestGate(px, pz) {
    const gates = this.ab?.gates;
    if (!gates?.length) return null;
    let best = null;
    let bd = Infinity;
    for (const g of gates) {
      const d = dist2(px, pz, g.x, g.z);
      if (d < bd) { bd = d; best = g; }
    }
    return best;
  }

  /* ================================================================== */
  /* guards                                                             */
  /* ================================================================== */

  _waves(dt, inside, px, pz) {
    this._waveT -= dt;
    if (this._waveT > 0 || !inside) return;
    this._waveT = WAVE_PERIOD;
    const alive = this.guardCount;
    const want = Math.min(WAVE_SIZE, GUARD_CAP - alive);
    if (want <= 0) return;

    // Muster points: the published patrol loop plus the gate posts, inside
    // the annulus around the player.
    const ab = this.ab;
    let n = 0;
    const put = (x, z) => {
      const d2 = dist2(px, pz, x, z);
      if (d2 < SPAWN_MIN * SPAWN_MIN || d2 > SPAWN_MAX * SPAWN_MAX) return;
      if (n < this._cand.length) { this._cand[n++] = x; this._cand[n++] = z; }
    };
    if (ab.patrol) for (const p of ab.patrol) put(p[0], p[1]);
    if (ab.gates) for (const g of ab.gates) put(g.x, g.z);
    if (n === 0 && ab.patrol?.length) {
      // Player deep in dead ground: fall back to the nearest patrol point.
      let bx = ab.patrol[0][0];
      let bz = ab.patrol[0][1];
      let bd = Infinity;
      for (const p of ab.patrol) {
        const d2 = dist2(px, pz, p[0], p[1]);
        if (d2 < bd) { bd = d2; bx = p[0]; bz = p[1]; }
      }
      this._cand[n++] = bx;
      this._cand[n++] = bz;
    }
    if (n === 0) return;

    for (let i = 0; i < want; i++) {
      const k = (this.rng.u32() % (n >> 1)) << 1;
      const x = this._cand[k] + this.rng.range(-6, 6);
      const z = this._cand[k + 1] + this.rng.range(-6, 6);
      const g = this.hostiles?.spawn?.(x, z, GUARD_OPTS);
      if (g) this.guards.push(g);
    }
  }

  /* ================================================================== */
  /* tank emplacements                                                  */
  /* ================================================================== */

  _emplacements(dt, px, py, pz) {
    if (!this.tanks.length) return;
    const playerVeh = this.wq.playerVehicle();
    this._aim.set(px, py + 1.0, pz);
    for (const t of this.tanks) {
      const v = t.v;
      if (!v || v.destroyed) continue;
      // A tank the player has stolen is his, not an emplacement.
      if (v === playerVeh) continue;
      const d = dist(v.position.x, v.position.z, px, pz);
      if (d > TANK_RANGE * 1.4) { v.turretAimActive = false; continue; }

      // Track: the production stepTurret slews the emitted turret from here,
      // above the sleep gate, at the spec's bounded rates.
      v.aimTurret?.(this._aim);

      // Fire control: cadence, envelope, hold-fire under a live chase, LOS,
      // and only once the EMITTED turret actually bears.
      t.fireT -= dt;
      if (t.fireT > 0) continue;
      if (this.chase.active) continue;                 // interceptors own it
      if (d < TANK_MIN || d > TANK_RANGE) continue;
      if (!this._turretOnTarget(v)) continue;
      if (!this._tankSees(v, px, py, pz, d)) continue;
      if (v.fireShell?.() ?? null) t.fireT = FIRE_PERIOD + this.rng.float() * FIRE_JITTER;
    }
  }

  /**
   * Does the emitted turret bear on the commanded point? The same body-frame
   * yaw the slew solves, compared against the PUBLISHED `turretYaw` state
   * that `syncTransforms` draws.
   */
  _turretOnTarget(v) {
    const st = v.spec?.style;
    if (!st?.turret) return false;
    this._muz.set(st.turret.x ?? 0, st.turret.y + (st.gun?.y ?? 0.3) - v.spec.comY, st.turret.z)
      .applyQuaternion(v.quaternion).add(v.position);
    this._dir.copy(this._aim).sub(this._muz)
      .applyQuaternion(this._q.copy(v.quaternion).invert());
    const wantYaw = Math.atan2(this._dir.x, this._dir.z);
    return Math.abs(wrapAngle(wantYaw - (v.turretYaw ?? 0))) < AIM_TOL;
  }

  _tankSees(v, px, py, pz, d) {
    const phys = this.wq.physics;
    if (!phys?.raycast) return true;
    this._muz.set(v.position.x, v.position.y + 2.3, v.position.z);
    this._dir.set(px - this._muz.x, py + 1.0 - this._muz.y, pz - this._muz.z);
    const len = this._dir.length();
    if (len < 1) return false;
    this._dir.multiplyScalar(1 / len);
    const hit = phys.raycast(this._muz, this._dir, len, phys.MASK?.WORLD ?? 0);
    void d;
    return !(hit?.hit && hit.distance < len - 3);
  }

  /* ================================================================== */
  /* patrol jeeps                                                       */
  /* ================================================================== */

  _patrol(dt, px, pz, inside) {
    void dt;
    const veh = this.wq.vehicles;
    if (!veh?.setInput) return;
    const playerVeh = this.wq.playerVehicle();
    for (let i = this.jeeps.length - 1; i >= 0; i--) {
      const j = this.jeeps[i];
      if (!j || j.destroyed) { this.jeeps.splice(i, 1); continue; }
      if (j === playerVeh) continue;
      if (!inside) { veh.setInput(j, this._zeroInp); continue; }
      driveToward(veh, j, this._jeepInp, px, pz, JEEP_DRIVE);
    }
    this._jeepsStopped = false;
  }

  _stopJeeps() {
    if (this._jeepsStopped) return;
    this._jeepsStopped = true;
    const veh = this.wq.vehicles;
    const playerVeh = this.wq.playerVehicle();
    for (const j of this.jeeps) {
      if (j && !j.destroyed && j !== playerVeh) veh?.setInput?.(j, this._zeroInp);
    }
  }

  /* ================================================================== */
  /* the stolen jet                                                     */
  /* ================================================================== */

  _onEnter(e) {
    if (this.disabled || !e?.vehicle) return;
    if (e.actor && e.actor !== this.wq.player) return;
    const ab = this.ab;
    const v = e.vehicle;
    if (!ab || v.spec?.id !== 'jet') return;
    if (typeof ab.insidePerimeter !== 'function' ||
      !ab.insidePerimeter(v.position.x, v.position.z)) return;
    if (this.chase.active) return;
    // Boarding the jet is the theft; the base goes to full alert with it.
    if (!this.armed) this._arm(v.position.x, v.position.z);
    if (this.chase.begin(v, ab)) {
      this.wq.ui?.notify?.('Stolen military jet', 'GET AIRBORNE', 'bad');
    }
  }

  /* ================================================================== */
  /* seeding                                                            */
  /* ================================================================== */

  _resolve() {
    const ab = this.wq.world?.airbase;
    if (!ab?.pad || !ab.insidePerimeter) return null;
    this.ab = ab;
    return ab;
  }

  /**
   * Dress the published apron: jets on the jet stands, armour on the tank
   * stands, two patrol Overlooks by the gate road. Parked scenery until the
   * encounter arms; the jets are also what the player steals. Runs once.
   */
  _seed(ab) {
    this._seeded = true;
    const veh = this.wq.vehicles;
    if (typeof veh?.spawn !== 'function' || !Array.isArray(ab.apronSlots)) return;
    const at = (slot, type, opts) => {
      const comY = veh.specOf?.(type)?.comY ?? 1;
      const y = this.wq.groundY(slot.x, slot.z) + comY + 0.02;
      return veh.spawn(type, this._v.set(slot.x, y, slot.z), slot.heading, opts ?? EMPTY_OPTS);
    };
    let jets = 0;
    let tanks = 0;
    let jeeps = 0;
    for (const slot of ab.apronSlots) {
      if (slot.kind === 'jet' && jets < JET_N) {
        const v = at(slot, 'jet');
        if (v) { this.jets.push(v); jets++; }
      } else if (slot.kind === 'tank' && tanks < TANK_N) {
        const v = at(slot, 'tank');
        if (v) { this.tanks.push({ v, fireT: 2 }); tanks++; }
      } else if (slot.kind === 'jeep' && jeeps < JEEP_N) {
        const v = at(slot, 'suv', JEEP_OPTS);
        if (v) { this.jeeps.push(v); jeeps++; }
      }
    }
  }

  /* ================================================================== */

  /**
   * Full wind-down NOW — death, respawn, dossier adoption, a 'clean' debug
   * stage. Parked scenery stays; everything hostile stands down.
   */
  reset() {
    if (this.armed) this._disarm();
    else this._stopJeeps();
    this.guards.length = 0;
    this.chase.reset();
    this._outT = 0;
  }

  dispose() {
    for (const off of this._offs ?? []) off();
    this._offs = null;
    this.reset();
    this.chase.dispose();
    this.tanks.length = 0;
    this.jets.length = 0;
    this.jeeps.length = 0;
  }
}

const EMPTY_OPTS = Object.freeze({});
/** The one-off olive-drab patrol variant — a paint override, not a class. */
const JEEP_OPTS = Object.freeze({ paint: JEEP_PAINT, finish: 'matte' });
/** The klaxon: the existing positioned siren voice, loud and near. */
const ALARM_OPTS = Object.freeze({ which: 'siren', level: 6, gain: 2.4, near: 1 });
/** Patrol driving: the shared mission steering, eased off close in. */
const JEEP_DRIVE = Object.freeze({ slow: 20, throttle: 0.85, gain: 1.6 });
