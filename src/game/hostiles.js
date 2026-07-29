/**
 * GAME — mission hostiles. AN ADAPTER.
 *
 * WHAT THIS FILE USED TO BE, AND WHY IT IS NOT THAT ANY MORE.
 *
 * Ten of the twenty-four chapters (`goons`, `brawl`, `survive`, and the four
 * `boss` fights) need somebody to fight, and `peds` had no public way to spawn
 * one. So this file carried its own minimal enemy: a proxy body, a three-state
 * brain, and a pair of `physics.addCollider()` hitboxes so the player's rounds
 * hit something real. Its own header said what to do about that:
 *
 *     "The moment `peds` exposes `spawnHostile(position, opts)` this file
 *      should shrink to an adapter."
 *
 * It has, and it has. `src/peds/hostile.js` is that function.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THAT FORCED IT
 * ---------------------------------------------------------------------------
 * The old implementation had physics HITBOXES and no physics BODY. Grepping it
 * for `collid|building|nav|obstacle|groundHeight` returned nothing; movement
 * was `position.x += dir * speed * dt` and a downward raycast for the floor. So
 * a mission goon walked straight THROUGH a house — in through the near wall,
 * across the hollow interior, and (because the floor raycast starts thirty
 * metres up and finds the roof first) three metres into the air over the far
 * wall before dropping back to the street. **Cover did not work against mission
 * enemies**, which is the single most reflexive thing a player does when taking
 * fire.
 *
 * Every enemy step has to be gated on collision, and there was no equivalent
 * anywhere, because this population was never wired to the world at all.
 *
 * Bolting a collision check onto the old file would have been a third
 * implementation of walking, and the next thing a goon needed (kerbs, parked
 * cars, doorways, slopes) would have been a fourth. So the fix is the refactor:
 * a mission enemy is now a real `Ped` carrying a `physics.createCharacter()`
 * capsule, and it inherits navigation, world collision, ground clamping, kerb
 * step-up, ragdoll death and hit capsules by construction.
 *
 * This is the same handshake `heat.js` already had with `police` — it stands
 * down (`authoritative = false`) the moment the real system answers. `hostiles`
 * had no such handshake and now needs none: there is nothing left here to stand
 * down. What remains is the vocabulary conversion between `game`'s call sites
 * (x/z pairs, `spawn/despawn/hurt/clear`, an `onKill` slot) and the `peds` API,
 * plus the one thing that is genuinely `game`'s business and not `peds`':
 *
 * ---------------------------------------------------------------------------
 * THE KILL DROP
 * ---------------------------------------------------------------------------
 * Every mission enemy killed has a 28% chance to drop health or ammo where he
 * fell. In a `survive` or a `boss` chapter that is the difference between
 * attrition you can fight through and attrition you can only lose: the
 * arithmetic of a nine-second wave timer assumes the room restocks you, and
 * without it the chapter is a countdown.
 *
 * ARCHITECTURE.md compliance:
 *  - rule 2: reaches `peds` through `ctx.peek`, imports nothing from it.
 *  - rule 4: the drop roll comes off a forked `ctx.rng`.
 *  - rule 5: `update()` allocates nothing; the one vector is preallocated.
 */

import * as THREE from 'three';

/**
 * 28% of mission kills drop something, and it is an even split between health
 * and ammo.
 */
const DROP_CHANCE = 0.28;
const DROP_HEALTH_SHARE = 0.5;
/**
 * Seconds a kill drop stands before it collects itself. Leaving them forever is
 * affordable in a 700 m town with a 30-slot pool; here a `survive` chapter can
 * produce twenty of them across a block and every one is a pool slot the hidden
 * packages and mission crates also need. Long enough to fight your way back to
 * it, short enough that the field does not silt up.
 */
const DROP_TTL = 45;

export class HostilePool {
  constructor(ctx, wq) {
    this.ctx = ctx;
    this.wq = wq;
    this.rng = ctx.rng.fork();
    this._peds = null;
    this._v = new THREE.Vector3();
    /** Set by `game/index.js`. Fired once per hostile death. */
    this.onKill = null;
    this.kills = 0;
    /** Kill drops actually spawned — read by the probes. */
    this.drops = 0;
  }

  /* ---------------------------------------------------------------- init -- */

  init() {
    const peds = this.ctx.peek('peds');
    if (typeof peds?.spawnHostile !== 'function') {
      // `game.deps` lists `peds`, so the registry guarantees it is constructed
      // before this runs. If that ever stops being true, say so once and loudly
      // rather than silently shipping ten chapters with no opposition.
      console.error('[game] peds.spawnHostile is missing — mission enemies cannot spawn');
      return this;
    }
    this._peds = peds;
    peds.hostiles.onKill = (h) => this._onKill(h);
    return this;
  }

  /** The live enemies. `crew._gatherHostiles` reads this through `game`. */
  get live() {
    return this._peds?.hostiles.live ?? EMPTY_LIST;
  }

  get aliveCount() {
    return this._peds?.hostiles.aliveCount ?? 0;
  }

  /**
   * `peds` compiles its own crowd materials — a hostile is one of its
   * pedestrians and shares them — so there is nothing left for this file to
   * warm. Kept because `game/index.js` awaits it during boot.
   */
  async prewarmMaterials() { /* peds.prewarmMaterials covers the whole crowd */ }

  /* --------------------------------------------------------------- spawn -- */

  /**
   * @param {number} x @param {number} z
   * @param {object} [opts] `{ hp, ranged, dmg, scale, speed, range, tag, leash }`
   * @returns {import('../peds/ped.js').Ped|null}
   */
  spawn(x, z, opts) {
    const peds = this._peds;
    if (!peds) return null;
    this._v.set(x, this.wq.groundY(x, z), z);
    return peds.spawnHostile(this._v, opts);
  }

  despawn(h) {
    this._peds?.despawnHostile(h);
  }

  clear() {
    this._peds?.clearHostiles();
  }

  /* -------------------------------------------------------------- damage -- */

  /** Returns true when this killed him — the contract the old pool had. */
  hurt(h, amount, headshot = false, point = null) {
    return this._peds?.hurtHostile(h, amount, headshot, point) ?? false;
  }

  /**
   * A mission enemy died. `peds` raised `actor:death` on its own (that is what
   * pays the goon respect and cash in `freeroam`), so all that is left here is
   * `game`'s bookkeeping and the kill drop.
   */
  _onKill(h) {
    this.kills++;
    this._dropFor(h);
    this.onKill?.(h);
  }

  /**
   * Gated on a chapter actually being IN PLAY — a goon killed in free roam
   * already pays out through `freeroam`'s cash drop, and doubling it up with a
   * health pack would make the street a vending machine.
   */
  _dropFor(h) {
    const game = this._game ?? (this._game = this.ctx.peek('game'));
    if (!game?.missions?.running) return;
    const pickups = game.pickups;
    if (!pickups?.spawn) return;
    if (this.rng.float() >= DROP_CHANCE) return;
    const kind = this.rng.float() < DROP_HEALTH_SHARE ? 'health' : 'ammo';
    // NOT `mission: true`: that flag is what `nearestMission` puts the glowing
    // objective ring on, and a health pack a goon dropped is not an objective.
    const p = pickups.spawn(h.position.x, h.position.z, kind, { ttl: DROP_TTL });
    if (p) this.drops++;
  }

  /* --------------------------------------------------------------- frame -- */

  /**
   * `peds` runs the hostile brain inside its own update, before its ped loop,
   * exactly as it runs the crew's — the brain writes steering that `Ped._move`
   * then integrates against the world, so it cannot be driven from here without
   * putting it a frame out of step with the body it steers.
   *
   * What is left is the one fact `peds` cannot see for itself: whether the man
   * they are all trying to hit is still on his feet. Publishing it is
   * order-independent, which is why it is a flag and not a call.
   */
  update(dt, playerPos, playerAlive = true) {
    const h = this._peds?.hostiles;
    if (h) h.targetAlive = playerAlive !== false;
  }

  /* ------------------------------------------------------------- dispose -- */

  dispose() {
    const h = this._peds?.hostiles;
    if (h) {
      h.onKill = null;
      h.clear();
    }
    this._peds = null;
  }
}

const EMPTY_LIST = Object.freeze([]);
