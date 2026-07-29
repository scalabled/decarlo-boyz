/**
 * PEDS — MISSION HOSTILES.
 *
 * The API `src/game/hostiles.js` has been asking for in its header since it was
 * written: *"The moment `peds` exposes `spawnHostile(position, opts)` this file
 * should shrink to an adapter."* This is that function, and this is why it had
 * to live here rather than in `game`.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS ACTUALLY BROKEN
 * ---------------------------------------------------------------------------
 * `game/hostiles.js` was a SECOND, PARALLEL pedestrian implementation. It had
 * physics *hitboxes* — two `addCollider()` capsules, so the player's rounds
 * came back through the engine's own ballistics — and no physics *body*. Its
 * whole movement model was two lines:
 *
 *     h.position.x += (dx / d) * move * dt;
 *     h.position.y = wq.groundY(h.position.x, h.position.z, h.position.y + 30);
 *
 * Nothing in that file matched `/collid|building|nav|obstacle/`. So a goon
 * walked THROUGH the near wall of a house, across the hollow interior, and
 * (because `groundY` raycasts down from thirty metres up and the first thing it
 * finds inside a building is the roof) rose several metres into the air
 * clambering over the far wall before dropping back to the street. Ten of the
 * twenty-four chapters spawn their opposition from that system. **Putting a
 * building between yourself and a mission goon — the reflex move when taking
 * fire — did nothing at all.**
 *
 * That is not "a missing collision check". A collision check bolted onto that
 * file would have been a third implementation of walking, and the next thing a
 * goon needed (kerbs, parked cars, slopes, doorways) would have been a fourth.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THE FIX: A HOSTILE IS A `Ped`
 * ---------------------------------------------------------------------------
 * Exactly the argument `crew.js` makes for a companion, and for exactly the
 * same reasons — twenty silhouettes, the palette shader, the layered animator,
 * foot IK, ragdoll death, hit capsules on `LAYER.ACTOR`. A mission enemy is now
 * a real pedestrian with a different brain, so it inherits all of that by
 * construction instead of re-earning it badly.
 *
 * On top of the ped it gets the one thing no pedestrian had: a
 * `physics.createCharacter()` swept capsule. That is the same controller the
 * player walks on, so a goon gets wall collision, step-up over kerbs, slope
 * limits, ground clamping, gap bridging and the parked-car blocker set from the
 * code that already does all of it — not from a copy.
 *
 * Ambient peds keep their cheap raycast-and-ease ground: a hundred capsule
 * sweeps a frame is not a trade the crowd should make, and the crowd navigates
 * pavements derived from the road graph, which keeps it out of buildings
 * geometrically. A hostile does not walk a pavement — it walks AT YOU — so it
 * is the one population that has to resolve against the world for real.
 *
 * ---------------------------------------------------------------------------
 * THE BUDGET CONTRACT (the crew's, restated — see the `peds` header)
 * ---------------------------------------------------------------------------
 *   IT NEVER BORROWS. Hostiles live in `this.pool`, their own array of at most
 *   `HOSTILE_MAX` Peds. `PedSystem._freePed()` — what `attachDriver()` hands to
 *   `traffic` and `police` — only ever scans `sys.peds`, so a firefight cannot
 *   take a slot a cop needs, and needs no give-back path at all.
 *
 *   IT PAYS FOR ITS BODIES. `HOSTILE_BODIES` skinned slots are added to
 *   `maxBodies` rather than taken out of the crowd's share, so a wave of goons
 *   does not silently demote the street around them to capsules.
 *
 * THE GATE: `node src/peds/coverprobe.mjs`. It spawns a hostile on one side of
 * a building proven solid by an independent geometric footprint (rasterised off
 * the DRAWN mesh, never off the collider this file resolves against) and
 * asserts the path never enters it and never leaves the ground band.
 */

import * as THREE from 'three';
import { makeOutfit } from './wardrobe.js';
import { Ped, STATE } from './ped.js';

/** Hard cap. A boss phase asks for six minions on top of a wave; 24 is slack. */
export const HOSTILE_MAX = 24;

/**
 * Skinned bodies reserved for hostiles, ON TOP of the crowd's share.
 *
 * Ten, not twenty-four, and the difference is deliberate: the ones past this
 * are drawn by the far-LOD capsule crowd in the same instanced draw as everyone
 * else, and a wave is never ten men deep in the ten metres where a skinned body
 * is legible. What must not happen is a goon being denied a body while he is in
 * your face because the pavement behind him is busy.
 */
export const HOSTILE_BODIES = 10;

/**
 * Silhouettes a mission goon draws from. A subset of the `street` archetype:
 * the jackets, hoodies and puffas, never the pushchair or the office coat. The
 * palette still comes from the ordinary wardrobe draw, so a crew of them reads
 * as men off this street rather than as a uniform.
 */
const GOON_SHAPES = ['jacketM', 'hoodieM', 'hoodedM', 'puffaM', 'workM', 'millM'];

/** Defaults, one for one with the numbers `game/hostiles.js` shipped. */
const DEF = {
  hp: 60,
  dmg: 10,
  ranged: false,
  scale: 1,
  leash: 0,
  tag: '',
};

export class PedHostiles {
  constructor(sys) {
    this.sys = sys;
    this.ctx = sys.ctx;
    this.rng = sys.rng.fork();

    /** Peds that are ONLY ever hostiles. Never visible to `_freePed`. */
    this.pool = [];
    /** Live hostiles. `crew._gatherHostiles` reads this array through `game`. */
    this.live = [];

    /** `(ped) => void`, fired once on the frame a hostile dies. */
    this.onKill = null;
    /** Cleared by `game` when the player is down, so a corpse is not punched. */
    this.targetAlive = true;

    this.kills = 0;

    /* ---- scratch: nothing below may allocate per frame ---- */
    this._spawn = new THREE.Vector3();
    this._tracer = { from: new THREE.Vector3(), to: new THREE.Vector3(), speed: 420 };
    this._dmg = {
      target: null, amount: 0, headshot: false, killed: false,
      point: new THREE.Vector3(), from: new THREE.Vector3(), source: null,
    };
    this.stats = { live: 0, ms: 0 };

    /**
     * A KILL IS NOTICED WHEN IT HAPPENS, NOT ON THE NEXT UPDATE.
     *
     * `Ped._down` raises `actor:death` synchronously, so this fires inside the
     * bullet that did it. Sweeping `live` for corpses once a frame would have
     * been simpler and is wrong: `mission.abort()`, `_despawnHostiles` and the
     * chapter-end teardown all despawn handles in the same tick a goon dies in,
     * and every one of those would have swallowed the kill — the chapter's own
     * progress counter, `save.totals.kills` and the 28% kill drop, all
     * silently short by one on the shot that ENDS the fight.
     *
     * `_hostileCounted` makes it idempotent, so the belt-and-braces sweep in
     * `update()` can stay for any death that never raises the event.
     */
    this._offDeath = this.ctx.events.on('actor:death', (e) => {
      const a = e?.actor;
      if (a?.isHostile === true) this._noteKill(a);
    });
  }

  get phys() {
    return this.sys.phys;
  }

  /** Hostiles on their feet. */
  get aliveCount() {
    let n = 0;
    for (let i = 0; i < this.live.length; i++) if (this.live[i].alive) n++;
    return n;
  }

  /* ================================================================== */
  /* spawn / despawn                                                    */
  /* ================================================================== */

  /**
   * Put an enemy on the ground at `position`.
   *
   * @param {{x:number,y:number,z:number}} position
   * @param {object} [opts] `{ hp, dmg, ranged, range, speed, scale, tag, leash }`
   * @returns {Ped|null} the pedestrian, or null when the pool is spent.
   */
  spawn(position, opts = DEF) {
    if (!position || !Number.isFinite(position.x)) return null;
    const ped = this._take();
    if (!ped) return null;
    const rng = this.rng;

    const hp = opts.hp ?? DEF.hp;
    const ranged = !!opts.ranged;
    const scale = opts.scale ?? DEF.scale;

    const outfit = makeOutfit(rng.fork(), 'street', {
      shape: GOON_SHAPES[rng.u32() % GOON_SHAPES.length],
      // A goon is not carrying an umbrella and is not on his phone.
      props: {},
      rain: 0,
    });
    if (scale !== 1) {
      // A boss is a bigger man. `height` is metric and `scale` is the geometry
      // multiplier derived from it (wardrobe.js: `scale = height / 1.75`), so
      // both have to move or the rig and the capsule disagree.
      outfit.height *= scale;
      outfit.scale *= scale;
    }

    // Land him on the floor rather than wherever the caller guessed. The
    // controller's own `teleport` then de-penetrates, so a spawn point inside a
    // wall pushes out instead of starting the fight inside a building.
    const y = this.sys.groundAt(position.x, position.z, position.y + 30);
    this._spawn.set(position.x, Number.isFinite(y) ? y : position.y, position.z);

    ped.spawn(outfit, this._spawn, rng.range(-Math.PI, Math.PI), rng.fork());
    ped.isHostile = true;
    ped.state = STATE.HOSTILE;
    ped.stateTime = 0;
    ped.maxHealth = hp;
    ped.health = hp;
    ped.damage = opts.dmg ?? DEF.dmg;
    ped.ranged = ranged;
    ped.hostileRange = opts.range ?? (ranged ? 32 : 2.6);
    ped.hostileSpeed = opts.speed ?? (ranged ? 3.0 : 3.9);
    ped.tag = opts.tag ?? DEF.tag;
    ped.leash = opts.leash ?? DEF.leash;
    ped.homeX = this._spawn.x;
    ped.homeZ = this._spawn.z;
    ped.attackCd = 1.2 + rng.float() * 1.4;
    ped._hostileCounted = false;
    // His own face target, allocated once per pooled body. A shared scratch
    // vector would work only for as long as every hostile in the world is
    // looking at the same man, which is a coincidence and not a contract.
    ped._faceAt = ped._faceAt ?? new THREE.Vector3();
    // The teleport-detector's datum. See `_syncBody`.
    ped._hostX = this._spawn.x;
    ped._hostZ = this._spawn.z;

    this._attachController(ped);
    this.live.push(ped);
    return ped;
  }

  /**
   * The swept capsule. THIS is the fix: everything else in this file is the
   * brain that used to live in `game/hostiles.js`, and none of it is what was
   * broken.
   */
  _attachController(ped) {
    const phys = this.phys;
    if (!phys?.createCharacter) return;
    let c = ped.controller;
    if (!c) {
      c = phys.createCharacter({
        id: 'hostile',
        owner: ped,
        radius: Math.max(0.28, ped.radius),
        height: Math.max(1.3, ped.height),
        // A kerb is 0.152 m and a stoop is taller; the player gets 0.42 and a
        // goon that cannot follow you up a step is not cover, it is a bug.
        stepHeight: 0.42,
      });
      ped.controller = c;
    } else {
      c.enabled = true;
      c.radius = Math.max(0.28, ped.radius);
      c.setHeight(Math.max(1.3, ped.height), true);
    }
    c.teleport(ped.position.x, ped.position.y, ped.position.z);
    // `teleport` de-penetrates, so believe the capsule, not the request.
    ped.position.set(c.position.x, c.position.y, c.position.z);
    ped._hostX = ped.position.x;
    ped._hostZ = ped.position.z;
    ped._fallV = 0;
  }

  despawn(ped) {
    if (!ped?.isHostile) return;
    const i = this.live.indexOf(ped);
    if (i >= 0) this.live.splice(i, 1);
    if (!ped.active) return;
    this.sys._releaseBody(ped);
    if (ped.controller) ped.controller.enabled = false;
    ped.isHostile = false;
    ped.despawn();
  }

  clear() {
    for (let i = this.live.length - 1; i >= 0; i--) this.despawn(this.live[i]);
  }

  /** Damage a hostile through the same path a bullet takes. */
  hurt(ped, amount, headshot = false, point = null) {
    if (!ped?.active || !ped.alive || !(amount > 0)) return false;
    ped.applyDamage(amount, headshot ? 'head' : 'torso', point ?? ped.position, null);
    return !ped.alive;
  }

  /** A ped slot the ambient streamer can never see. Mirrors `Crew._takePed`. */
  _take() {
    for (let i = 0; i < this.pool.length; i++) if (!this.pool[i].active) return this.pool[i];
    if (this.pool.length >= HOSTILE_MAX) return null;
    const p = new Ped(this.sys);
    this.pool.push(p);
    return p;
  }

  /* ================================================================== */
  /* frame                                                              */
  /* ================================================================== */

  /**
   * The brain. Runs BEFORE the ped loop — like `Crew.update` — because all it
   * does is write `_steer`, `desiredSpeed` and `faceTarget`, and `Ped._move` is
   * what integrates them (and, for a hostile, resolves them against the world).
   */
  update(dt, anchor) {
    if (!this.live.length) return;
    const t0 = performance.now();
    const alive = this.targetAlive && this.sys.hasPlayer;

    for (let i = this.live.length - 1; i >= 0; i--) {
      const ped = this.live[i];
      if (!ped.active) { this.live.splice(i, 1); continue; }

      if (!ped.alive) {
        // Belt to the `actor:death` braces above — a death that somehow never
        // raised the event still counts, exactly once.
        this._noteKill(ped);
        // The streamer never sees this pool, so retire the body ourselves once
        // the ragdoll has had its moment.
        if (ped._deadTime > 26) this.despawn(ped);
        continue;
      }

      this._syncBody(ped);
      this._brain(ped, dt, anchor, alive);
    }
    this.stats.live = this.live.length;
    this.stats.ms = performance.now() - t0;
  }

  /** Count a hostile death exactly once, whoever noticed it first. */
  _noteKill(ped) {
    if (ped._hostileCounted) return;
    ped._hostileCounted = true;
    this.kills++;
    this.onKill?.(ped);
  }

  /**
   * A HANDLE THE REST OF THE GAME CAN STILL MOVE.
   *
   * `tracks.goons` re-homes a wave that the player has driven away from with
   * `h.position.set(...)`, and `game` is entitled to keep doing that: the
   * position vector is the public handle. But the capsule is the authority on
   * where this man is, so a write nobody told the controller about would be
   * silently undone on the next step. Detect the divergence and honour it as a
   * teleport — the same de-penetration a fresh spawn gets.
   */
  _syncBody(ped) {
    const c = ped.controller;
    if (!c) return;
    const dx = ped.position.x - ped._hostX;
    const dz = ped.position.z - ped._hostZ;
    if (dx * dx + dz * dz > 0.5625) {          // 0.75 m — far more than a frame
      const y = this.sys.groundAt(ped.position.x, ped.position.z, ped.position.y + 30);
      c.teleport(ped.position.x, Number.isFinite(y) ? y : ped.position.y, ped.position.z);
      ped.position.set(c.position.x, c.position.y, c.position.z);
      ped._fallV = 0;
    }
    ped._hostX = ped.position.x;
    ped._hostZ = ped.position.z;
  }

  /**
   * Approach / hold / strike, ported one for one from the brain that shipped in
   * `game/hostiles.js` — the ranged stand-off, the leash, the cooldown spread,
   * the 55% falloff past 18 m. None of that was the defect and none of it
   * changes here.
   */
  _brain(ped, dt, anchor, targetAlive) {
    const tx = anchor.x;
    const tz = anchor.z;
    const dx = tx - ped.position.x;
    const dz = tz - ped.position.z;
    const d = Math.hypot(dx, dz) || 1e-3;

    ped._faceAt.set(tx, ped.position.y + 1.1, tz);
    ped.faceTarget = ped._faceAt;

    const stop = ped.ranged ? Math.min(ped.hostileRange * 0.6, 18) : ped.hostileRange;

    /* --- leashed enemies hold the ground the chapter is about --- */
    const hx = ped.homeX - ped.position.x;
    const hz = ped.homeZ - ped.position.z;
    const home = Math.hypot(hx, hz);
    if (ped.leash > 0 && home > ped.leash && d > stop) {
      ped._steer.set(hx / (home || 1), 0, hz / (home || 1));
      ped.desiredSpeed = ped.hostileSpeed;
    } else if (targetAlive && d > stop) {
      ped._steer.set(dx / d, 0, dz / d);
      ped.desiredSpeed = ped.hostileSpeed;
    } else {
      ped._steer.set(0, 0, 0);
      ped.desiredSpeed = 0;
    }

    // Hands up when he is shooting, down when he is closing. The same aim layer
    // `crew.js` and the officer pool use.
    ped.animator?.setAct('film', ped.ranged && d <= ped.hostileRange ? 0.9 : 0);

    ped.attackCd -= dt;
    if (!targetAlive || ped.attackCd > 0 || d > ped.hostileRange) return;
    ped.attackCd = ped.ranged ? 1.05 + this.rng.float() * 0.5 : 1.35 + this.rng.float() * 0.4;
    this._strike(ped, anchor, d);
  }

  _strike(ped, anchor, d) {
    const ctx = this.ctx;
    const p = this._dmg;
    p.target = ctx.peek('player') ?? 'player';
    p.amount = ped.damage;
    p.headshot = false;
    p.killed = false;
    p.point.copy(anchor);
    p.from.copy(ped.position);
    p.source = ped;

    if (ped.ranged) {
      const t = this._tracer;
      t.from.set(ped.position.x, ped.position.y + 1.45 * ped.scale, ped.position.z);
      t.to.set(anchor.x, anchor.y + 1.1, anchor.z);
      t.speed = 420;
      // A tracer, never `weapon:fire`: raising that would send the whole crowd
      // into a panic and tell `police` the PLAYER just fired, once a second.
      ctx.events.emit('bullet:tracer', t);
      this._sfx('shot', t.from, 0.5);
      // A rifleman at 30 m is not a rifleman at 3 m.
      p.amount = ped.damage * (d > 18 ? 0.55 : 1);
    } else {
      ped.animator?.punchNow(this.rng.float() < 0.5 ? -1 : 1);
      this._sfx('bodyfall', ped.position, 0.35);
    }
    ctx.events.emit('damage:dealt', p);
  }

  _sfx(kind, position, gain) {
    const a = this._audio ?? (this._audio = this.ctx.peek('audio'));
    if (!a?.play) return;
    try { a.play(kind, position, { gain }); } catch { /* optional feedback */ }
  }

  /* ================================================================== */

  dispose() {
    this._offDeath?.();
    this._offDeath = null;
    const phys = this.phys;
    for (const p of this.pool) {
      if (p.active) { this.sys._releaseBody(p); p.despawn(); }
      if (p.controller) { phys?.removeCharacter?.(p.controller); p.controller = null; }
    }
    this.pool.length = 0;
    this.live.length = 0;
  }
}
