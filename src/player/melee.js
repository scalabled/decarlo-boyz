/**
 * THE BRAWL MODEL — everything about a fight that belongs to the man, not the
 * weapon: the combo counter, the heavy commit, the guard, the parry window,
 * and the seconds of invulnerability you are owed after being put on the floor.
 *
 * Four of the twenty-four chapters are `brawl` tracks. Before this file grew
 * past its fallback, a swing was one damage number, one reach and one arc:
 * `grep -nE '\bcombo\b|\bparry\b|\bblocking\b|staggerT|iFrames|hitstop' src/`
 * returned nothing. This file is the whole combat system.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ONE FACT, ONE OWNER — WHY THE MULTIPLIERS LIVE HERE AND NOT IN THE SOLVER
 * ────────────────────────────────────────────────────────────────────────────
 * Two different code paths deal a swing's damage: `weapons/melee.js`'s fan
 * sweep, and the `peds.nearest` fallback at the bottom of this file. If each
 * applied its own combo/heavy arithmetic they would drift, and a third of the
 * hits in the build would escalate differently from the other two thirds.
 *
 * So the arithmetic has exactly one home — `swingDamage`, `reachScale`,
 * `arcScale`, `knockbackScale`, `staggerTime`, `hitstopTime` below — and the
 * solver ASKS for it through `player.meleeReach`, which is a plain field on the
 * player object it is already handed. No import crosses the subsystem boundary
 * (hard rule 2); `weapons` reaches this the same way it reaches everything else
 * about the player.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE GUARD INTERCEPTS `damage:dealt` — DELIBERATELY, AND FIRST
 * ────────────────────────────────────────────────────────────────────────────
 * Block, parry and i-frames have to apply BEFORE the subtraction. The
 * subtraction lives in `player/index.js` `_onDamageDealt` -> `health.damage`,
 * in another file. The mitigation therefore runs as a listener registered
 * AHEAD of it: `MeleeReach` is constructed at `player/index.js:261` and the
 * player's own `on('damage:dealt')` is registered at :296, and `EventBus`
 * dispatches a `Set` in insertion order. So this handler sees every
 * player-targeted payload first and lowers `e.amount` in place.
 *
 * Mutating the payload is the CORRECT shape, not a trick: `ui`, `audio` and
 * `game` all read that same amount, and a blow that was parried did not deal
 * 22 damage that everyone else should draw a hitmarker for. It dealt none.
 *
 * WHAT COUNTS AS MELEE, without a flag to read. Payload provenance answers it:
 *
 *   `physics.emitImpact` (every bullet in the game)   has NO `from` field
 *   `peds/hostile._strike` and `peds.onPedPunch`      always set `from`
 *
 * so a blockable hit is one that names an attacker POSITION within touching
 * distance — plus the explicit `e.melee === true` that this file's own
 * fallback sets. The one ambiguous case, a hostile shooting from inside 2.8 m,
 * is closed by watching `bullet:tracer`: `_strike` emits it immediately before
 * the damage for a ranged hit and never for a punch.
 *
 * Both of those payloads are POOLED objects, which is why nothing is ever
 * written back onto one: a field set on a pooled payload survives into every
 * unrelated hit that reuses it. `lastMitigation` on this object is the
 * diagnostic instead.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LIFETIME
 * ────────────────────────────────────────────────────────────────────────────
 * The listeners are unhooked by `dispose()`, which `player/index.js` does not
 * call. In practice nothing leaks, because
 * the only teardown path in the build is `engine.dispose()` and that clears
 * the whole bus. A `player` torn down on its own would leave four inert
 * closures behind; they filter on `target === this.player` and do nothing.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FALLBACK (older than the rest of this file, and still load-bearing)
 * ────────────────────────────────────────────────────────────────────────────
 * `weapons/melee.js` used to cast its fan from the EYES, dead horizontal, over
 * the top of every pedestrian's torso capsule — measured `swings 3, hits 0` at
 * 1.29 m. That is fixed at source now (chest origin, three vertical rows, a
 * chord-derived column count), so this net should catch nothing. It stays
 * because it costs one comparison on a frame where a swing missed, and because
 * `fallbackShare` is the number that tells the next person whether the fan has
 * regressed again.
 *
 * It runs only on the frame `weapons` books a swing that did NOT book a hit, so
 * it can never double-apply, and it escalates through the SAME `swingDamage`
 * the solver uses.
 */

import * as THREE from 'three';
import { clamp01 } from './springs.js';

/* ========================================================================= */
/*  THE NUMBERS.                                                            */
/* ========================================================================= */

/** How long the chain stays alive between swings. */
const COMBO_WINDOW = 1.1;
/** Three beats, then back to one. */
const COMBO_LENGTH = 3;
/** +25% per step, so 1.00 / 1.25 / 1.50. */
const COMBO_STEP = 0.25;

/** A heavy's damage multiplier. */
const HEAVY_DAMAGE = 1.9;
/** A heavy's reach multiplier. */
const HEAVY_REACH = 1.15;
/**
 * What a heavy buys on the arc is a RATIO, not an absolute width. Weapons carry
 * their own `arcDeg`, from 62 (fists) to 108 (Dock Pipe), and widening each by
 * this keeps the per-weapon character that one shared arc number would erase.
 */
const HEAVY_ARC = 1.5 / 1.15;
/** Knockback, light and heavy. */
const KNOCKBACK_LIGHT = 1.9;
const KNOCKBACK_HEAVY = 4.4;
/** Stagger imposed on the victim, light and heavy; never shortens an existing one. */
const STAGGER_LIGHT = 0.28;
const STAGGER_HEAVY = 0.7;

/** Hitstop: light swing, heavy swing, and a parry. */
const HITSTOP_LIGHT = 0.04;
const HITSTOP_HEAVY = 0.075;
const HITSTOP_PARRY = 0.09;

/** The parry window, from the first frame of guard. */
const PARRY_WINDOW = 0.24;
/** What a parry costs the attacker. */
const PARRY_STAGGER = 1.3;
const PARRY_DAMAGE = 22;
/** What a late block still lets through. */
const BLOCK_MULT = 0.22;

/** 3 s of grace after a respawn and after a bust; 1.2 after being ejected. */
const IFRAMES_RESPAWN = 3.0;
const IFRAMES_BUST = 3.0;
const IFRAMES_EJECT = 1.2;

/**
 * How close an attacker must be for his blow to be a blockable melee blow.
 * The longest reach in the melee set is the Dock Pipe's 4.0 m, but that is the
 * PLAYER swinging; `peds.onPedPunch` guards at 2.2 m and `hostiles` closes to
 * contact, so this is the distance at which somebody can touch you.
 */
const MELEE_IN_RANGE = 2.8;

/**
 * Where the swing is measured FROM. Not the eyes: a swing comes off the
 * shoulder and travels through the chest line, which is also the height at
 * which it meets somebody else's chest.
 */
const CHEST = 1.18;

export class MeleeReach {
  constructor(ctx, player) {
    this.ctx = ctx;
    this.player = player;

    /* ---- the chain ---------------------------------------------------- */
    /** 0 when idle, else 1..3 — which beat of the combo the last swing was. */
    this.combo = 0;
    /** Seconds left before the chain lapses. */
    this.comboT = 0;
    /** Did the swing now in flight commit to a heavy? */
    this.heavy = false;

    /* ---- the guard ---------------------------------------------------- */
    this.blocking = false;
    /** Seconds the guard has been up. Under PARRY_WINDOW is a parry. */
    this.blockT = 0;
    /** Seconds of grace left. Nothing may hurt the player while this is > 0. */
    this.iFrames = 0;

    /* ---- internals ---------------------------------------------------- */
    this._swings = 0;
    this._hits = 0;
    this._solid = 0;
    /** Last observed `rig.swingT`; a lower non-negative value is a new swing. */
    this._lastSwingT = -1;
    /** 'parry' | 'block' | 'iframes' | null — diagnostics, never gated on. */
    this.lastMitigation = null;
    this._v = new THREE.Vector3();
    this._point = new THREE.Vector3();
    this._incident = new THREE.Vector3();
    this._tracerAt = -1;
    this._tracerFrom = new THREE.Vector3();
    this._wasDead = false;
    /** A parried attacker to answer next tick — never re-entrantly. */
    this._riposte = null;
    this._ripostePayload = {
      target: null, amount: PARRY_DAMAGE, headshot: false, killed: false,
      point: new THREE.Vector3(), from: new THREE.Vector3(), melee: true,
      source: player,
    };
    this._payload = {
      target: null, amount: 0, headshot: false, part: 'torso',
      killed: false, point: this._point, incident: this._incident,
      source: player, melee: true,
    };

    /** Read by the playtest harness and by `src/fx/meleeprobe.mjs`. */
    this.stats = {
      swings: 0, solverHits: 0, fallbackHits: 0, misses: 0,
      combos: 0, heavies: 0, parries: 0, blocks: 0, iframed: 0, whiffs: 0,
    };

    this._off = [];
    /* Registered HERE, in the constructor, so it lands ahead of the player's
     * own `damage:dealt` handler. See the header — the ordering IS the fix. */
    const on = (t, fn) => this._off.push(ctx.events.on(t, fn));
    on('damage:dealt', (e) => this._onDamage(e));
    on('bullet:tracer', (e) => this._onTracer(e));
    on('police:busted', () => this.grantIFrames(IFRAMES_BUST));
    on('vehicle:exit', (e) => this._onVehicleExit(e));
  }

  /* ===================================================================== */
  /*  the published arithmetic — the solver and the fallback both ask here  */
  /* ===================================================================== */

  /** `w.dmg * (heavy ? 1.9 : 1) * (1 + (p.combo - 1) * 0.25)` */
  swingDamage(base) {
    const step = 1 + Math.max(0, this.combo - 1) * COMBO_STEP;
    return (base ?? 0) * (this.heavy ? HEAVY_DAMAGE : 1) * step;
  }

  /** `w.range * (heavy ? 1.15 : 1)` */
  get reachScale() { return this.heavy ? HEAVY_REACH : 1; }

  /** How much wider a heavy sweeps. See HEAVY_ARC. */
  get arcScale() { return this.heavy ? HEAVY_ARC : 1; }

  /**
   * `const kb = heavy ? 4.4 : 1.9`, expressed as a multiplier on the weapon's
   * own authored `knockback` so the Dock Pipe still shoves harder than fists.
   */
  get knockbackScale() { return this.heavy ? KNOCKBACK_HEAVY / KNOCKBACK_LIGHT : 1; }

  /** `heavy ? 0.7 : 0.28` seconds on the man you just hit. */
  get staggerTime() { return this.heavy ? STAGGER_HEAVY : STAGGER_LIGHT; }

  /** `FX.stop(heavy ? 0.075 : 0.04)`. */
  get hitstopTime() { return this.heavy ? HITSTOP_HEAVY : HITSTOP_LIGHT; }

  /** True on the third beat of a chain — the swing that earns the toast. */
  get comboFinisher() { return this.combo === COMBO_LENGTH; }

  /* ===================================================================== */
  /*  frame                                                                */
  /* ===================================================================== */

  /**
   * @param wp the weapons system (may be absent)
   *
   * Called once per frame from `player._updateMelee`, which passes no dt — the
   * clock comes from `ctx.time.dt`, which is the SCALED delta. That is
   * deliberate: a hitstop has to stretch the combo window and the parry
   * window along with everything else it slows down. A parry
   * window that ran on the wall clock would quietly shrink every time the
   * previous hit froze the world.
   */
  update(wp) {
    const dt = this.ctx.time?.dt ?? 0;
    const p = this.player;

    /* ---- timers -------------------------------------------------------- */
    if (this.comboT > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) { this.comboT = 0; this.combo = 0; }
    }
    if (this.iFrames > 0) this.iFrames = Math.max(0, this.iFrames - dt);

    /* ---- a respawn is a falling edge on `dead`, whoever caused it ------- */
    /* `game._respawn` and `player.respawn` both heal without raising an event
     * of their own; the health flag is what BOTH of them emit. */
    const dead = !!p?.health?.dead;
    if (this._wasDead && !dead) this.grantIFrames(IFRAMES_RESPAWN);
    this._wasDead = dead;

    /* ---- the answer to a parry, one tick late -------------------------- */
    /* Deliberately not fired from inside the `damage:dealt` handler: emitting
     * the same event re-entrantly from one of its own listeners is how a
     * dispatch order becomes unreadable. */
    if (this._riposte) {
      this._fireRiposte(this._riposte);
      this._riposte = null;
    }

    const rig = wp?.rig ?? null;
    const melee = !!wp?.current?.melee;

    /* ---- the guard ----------------------------------------------------- */
    /* The guard is up while the ADS button is held, out of a vehicle, and not
     * mid-swing. It is the same button as aim; with a melee weapon in hand
     * there is no aim for it to drive. */
    const canBlock = melee && !dead
      && p?.controlEnabled !== false
      && !p?.vehicles?.driving
      && !rig?.swinging;
    const wants = canBlock && !!this.ctx.input?.ads;
    if (wants) {
      this.blocking = true;
      this.blockT += dt;
    } else {
      this.blocking = false;
      this.blockT = 0;
    }

    /* ---- the chain -----------------------------------------------------
     * A NEW SWING IS `swingT` GOING BACKWARDS, NOT `swinging` GOING TRUE.
     *
     * The obvious edge detector — `swinging && !wasSwinging` — drops every
     * second swing of a fast chain, and it does it silently. `rig.swingT` is
     * advanced in `weapons.lateUpdate` and the next swing can be booked in
     * `weapons.update` of the very next frame, both of which run AFTER
     * `player.update`: so on a mashed button this file never observes the
     * frame where `swinging` was false, sees `true -> true`, and the combo
     * never leaves beat one. MEASURED, four swings inside the window:
     * `combo 1 / 1 / 1 / 0` with `comboT` running 0.93 -> 0.56 -> 0.22 -> 0,
     * i.e. one chain that started once and then simply expired.
     *
     * `swingT` is monotonic within a swing and restarts at 0, so a value that
     * is non-negative AND lower than the last one we saw is a new swing —
     * whether or not we ever caught the gap between them. */
    const t = rig?.swingT ?? -1;
    if (melee && t >= 0 && (this._lastSwingT < 0 || t < this._lastSwingT)) this._beginSwing();
    this._lastSwingT = t;

    /* ---- the fallback -------------------------------------------------- */
    const solver = wp?.melee?.stats;
    if (!solver) return;
    if (solver.swings === this._swings) {
      this._hits = solver.hits;
      this._solid = solver.solidHits;
      return;
    }
    /* A swing that buried a crowbar in a brick wall did not whiff and does not
     * want the ped fallback: the wall is between you and anybody behind it. */
    const struckWall = solver.solidHits !== this._solid;
    const missed = solver.hits === this._hits;
    this._swings = solver.swings;
    this._hits = solver.hits;
    this._solid = solver.solidHits;
    this.stats.swings++;
    if (!missed) { this.stats.solverHits++; return; }
    if (struckWall) return;
    if (this._resolve(wp.current)) this.stats.fallbackHits++;
    else { this.stats.misses++; this._whiff(wp.current); }
  }

  /**
   * Open a swing: refresh the combo window and advance the beat.
   *
   * The heavy commit is latched HERE, at the top of the swing, not read at the
   * contact frame: a heavy is a decision you make before you throw, and a
   * player who lets go of the modifier mid-arc has still thrown a heavy.
   * The sprint key is the heavy modifier, and sprint is locked out during a
   * swing anyway, so the key is free.
   */
  _beginSwing() {
    this.comboT = COMBO_WINDOW;
    this.combo = (this.combo % COMBO_LENGTH) + 1;
    this.heavy = !!this.ctx.input?.action?.('sprint');
    if (this.heavy) this.stats.heavies++;
    if (this.combo === COMBO_LENGTH) this.stats.combos++;
  }

  /** Nothing was in the arc. A distinct sound, and the chain still stands. */
  _whiff(def) {
    this.stats.whiffs++;
    const fx = this.ctx.peek('fx');
    if (!fx?.meleeSound) return;
    fx.meleeSound('whiff', this.player?.position ?? null,
      this.heavy ? 1 : 0.7 * ((def?.knockback ?? 3) > 4 ? 1.1 : 0.85));
  }

  /* ===================================================================== */
  /*  incoming                                                             */
  /* ===================================================================== */

  /** Grace after a respawn, a bust, or being blown out of a car. */
  grantIFrames(seconds) {
    this.iFrames = Math.max(this.iFrames, seconds);
    /* A fresh start is a fresh start: the chain and the guard reset with it. */
    this.combo = 0;
    this.comboT = 0;
    this.blockT = 0;
  }

  _onTracer(t) {
    if (!t?.from) return;
    this._tracerAt = this.ctx.time?.frame ?? 0;
    this._tracerFrom.copy(t.from);
  }

  /**
   * `vehicle:exit` carries no "was this voluntary" flag, so ask the WORLD:
   * a car you left that is dead or already burning threw you out. A forced
   * exit is only ever reached from a wreck.
   */
  _onVehicleExit(e) {
    const p = this.player;
    const actor = e?.actor;
    if (actor && actor !== p && actor !== 'player' && actor?.isPlayer !== true) return;
    const v = e?.vehicle;
    if (!v) return;
    if (v.dead || v.destroyed || (v.burning ?? 0) > 0) this.grantIFrames(IFRAMES_EJECT);
  }

  /** Is this payload a blow somebody threw with their hands? See the header. */
  _isMeleeBlow(e) {
    if (e.melee === true || e.weapon?.melee === true) return true;
    const from = e.from;
    if (!from) return false;                       // physics/ballistics: never
    /* A ranged hostile announces itself with a tracer from the same muzzle on
     * the same frame. */
    if (this._tracerAt === (this.ctx.time?.frame ?? 0)
      && this._tracerFrom.distanceToSquared(from) < 4) return false;
    const at = this.player?.position;
    if (!at) return false;
    const dx = from.x - at.x, dz = from.z - at.z;
    return dx * dx + dz * dz <= MELEE_IN_RANGE * MELEE_IN_RANGE;
  }

  /**
   * Mitigation only, never the subtraction — `player._onDamageDealt` still owns
   * that and runs immediately afterwards. This decides how much arrives.
   */
  _onDamage(e) {
    if (!e) return;
    const p = this.player;
    const t = e.target;
    if (t !== p && t !== 'player' && t?.isPlayer !== true) return;
    if (!(e.amount > 0)) return;

    /* The mitigation is published on US, never written back onto the payload:
     * `peds/hostile._dmg` is a POOLED object, and a field set on it survives
     * into every unrelated hit that reuses the slot. */
    if (this.iFrames > 0) {
      e.amount = 0;
      this.lastMitigation = 'iframes';
      this.stats.iframed++;
      return;
    }
    if (!this.blocking || !this._isMeleeBlow(e)) return;

    if (this.blockT < PARRY_WINDOW) {
      /* PARRIED. Costs nothing, and it is the attacker who pays. */
      e.amount = 0;
      this.lastMitigation = 'parry';
      this.stats.parries++;
      this._riposte = e.source ?? null;
      if (e.from) this._ripostePayload.from.copy(e.from);
      const fx = this.ctx.peek('fx');
      fx?.stop?.(HITSTOP_PARRY);
      fx?.meleeSound?.('parry', e.from ?? p?.position ?? null, 1);
      this.ctx.peek('ui')?.toast?.('Parried', 'gold');
      p?.addKick?.(-0.6 * (Math.PI / 180), 0, 0);
      p?.addTrauma?.(0.12);
      return;
    }

    /* Blocked late: `amt *= 0.22`. */
    e.amount *= BLOCK_MULT;
    this.lastMitigation = 'block';
    this.stats.blocks++;
    this.ctx.peek('fx')?.meleeSound?.('parry', e.from ?? null, 0.45);
  }

  /**
   * `from.staggerT = 1.3; from.hp -= 22;`
   *
   * The stagger half is best-effort by design: neither `peds` nor
   * `game/hostiles` publishes a stagger method, and inventing one from here
   * would mean writing into another subsystem's fields. What IS canonical is
   * the damage, and that goes back the only sanctioned way — `damage:dealt`
   * with the attacker as `target`, applied by his own listener.
   */
  _fireRiposte(who) {
    if (!who) return;
    const pay = this._ripostePayload;
    pay.target = who;
    pay.amount = PARRY_DAMAGE;
    pay.killed = false;
    const at = who.position ?? pay.from;
    pay.point.set(at.x, (at.y ?? 0) + CHEST, at.z);
    this.ctx.events.emit('damage:dealt', pay);

    /* The stagger, if the victim will take one. Every shape any actor in this
     * build actually uses, and nothing invented. */
    if (typeof who.stagger === 'function') { try { who.stagger(PARRY_STAGGER); } catch { /* not ours */ } }
    else if (Number.isFinite(who.staggerT)) who.staggerT = Math.max(who.staggerT, PARRY_STAGGER);
    else if (Number.isFinite(who.stagger)) who.stagger = Math.max(who.stagger, PARRY_STAGGER);
  }

  /* ===================================================================== */
  /*  the fallback sweep                                                   */
  /* ===================================================================== */

  /** @returns true if something was hit. */
  _resolve(def) {
    if (!def) return false;
    const peds = this.ctx.peek('peds');
    if (!peds || typeof peds.nearest !== 'function') return false;

    const p = this.player;
    const m = p.movement;
    const reach = (def.reach ?? 3) * this.reachScale;
    const half = ((def.arcDeg ?? 70) * 0.5) * (Math.PI / 180) * this.arcScale;

    // Query from the chest, half a stride down the swing, so the sphere the
    // query describes covers the arc rather than a ring centred on the ribs.
    const yaw = p.rig.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const base = m.renderPosition;
    const cy = base.y + CHEST * (m.bodyScale ?? 1);
    const qx = base.x + fx * reach * 0.4;
    const qz = base.z + fz * reach * 0.4;

    let ped = null;
    try {
      ped = peds.nearest(qx, cy, qz, reach * 0.8);
    } catch {
      return false;
    }
    if (!ped || !ped.alive) return false;

    // Inside the arc? A swing is a sweep, not a cone, so the test is the same
    // half-angle the fan uses and nothing tighter.
    const dx = ped.position.x - base.x;
    const dz = ped.position.z - base.z;
    const d = Math.hypot(dx, dz);
    if (d > reach) return false;
    if (d > 1e-3) {
      const dot = (dx * fx + dz * fz) / d;
      if (dot < Math.cos(Math.min(Math.PI * 0.9, half + 0.25))) return false;
    }
    // ...and roughly at the same level. A pipe does not reach a balcony.
    if (Math.abs(ped.position.y - base.y) > 1.6) return false;

    this._point.set(
      ped.position.x, ped.position.y + CHEST * 0.85, ped.position.z
    );
    this._incident.set(dx / (d || 1), 0.12, dz / (d || 1)).normalize();

    const pay = this._payload;
    pay.target = ped;
    /* THE SAME arithmetic the fan uses — see the header. */
    pay.amount = this.swingDamage(def.damage ?? 20);
    pay.killed = false;
    pay.point = this._point;
    pay.incident = this._incident;
    // The ped's own listener applies it — see the header. This only reports it.
    this.ctx.events.emit('damage:dealt', pay);

    // A swing connecting is felt: the camera takes the shock of the impact and
    // the street notices. `weapons` gets this from `bullet:impact`, which a
    // fallback hit never raises, so it is done here instead.
    p.rig.addKick(-0.9 * (Math.PI / 180), 0, 0);
    p.rig.addTrauma(0.16 * (this.heavy ? 1.6 : 1));
    this.landed();
    try { peds.panic?.(this._point, 13, 0.45); } catch { /* stub */ }
    return true;
  }

  /**
   * A SWING CONNECTED — freeze the world for two to five frames.
   *
   * Called by `weapons/melee.js` on a fan hit and by the fallback above, so
   * both paths stall identically. The toast fires here too, for the same
   * reason: whichever path found the man, the third beat is the third beat.
   */
  landed() {
    this.ctx.peek('fx')?.stop?.(this.hitstopTime);
    if (this.comboFinisher) this.ctx.peek('ui')?.toast?.('3-hit combo', 'gold');
  }

  reset() {
    this._swings = 0;
    this._hits = 0;
    this.combo = 0;
    this.comboT = 0;
    this.heavy = false;
    this.blocking = false;
    this.blockT = 0;
    this.iFrames = 0;
    this._riposte = null;
    this._lastSwingT = -1;
  }

  dispose() {
    for (const off of this._off) off();
    this._off.length = 0;
  }

  /** 0..1 — how often a swing that connected needed the fallback. */
  get fallbackShare() {
    const hit = this.stats.solverHits + this.stats.fallbackHits;
    return hit === 0 ? 0 : clamp01(this.stats.fallbackHits / hit);
  }
}

export {
  COMBO_WINDOW, COMBO_LENGTH, COMBO_STEP, HEAVY_DAMAGE, HEAVY_REACH, HEAVY_ARC,
  PARRY_WINDOW, PARRY_DAMAGE, BLOCK_MULT, HITSTOP_LIGHT, HITSTOP_HEAVY,
  HITSTOP_PARRY, IFRAMES_RESPAWN, IFRAMES_EJECT, STAGGER_LIGHT, STAGGER_HEAVY,
};
