import * as THREE from 'three';
import { DEG } from './mathx.js';

/**
 * MELEE — the swing, the sweep, and the hit.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A SHOOT ANIMATION WITH A SHORT RANGE
 * ---------------------------------------------------------------------------
 * A gun resolves at the instant the trigger breaks. A swing does not: the pipe
 * is nowhere near the target when the input arrives, it arrives 160 ms later at
 * the CONTACT FRAME, and if the target moved out of the arc in the meantime the
 * swing whiffs. That timing is the whole feel of melee — it is what makes a
 * heavy weapon commit you and a light one let you back out — so the state
 * machine here is driven by the def's `swing` block:
 *
 *     wind      s   the wind-up, before which nothing can connect
 *     strike    s   the arc itself
 *     recover   s   the follow-through, during which you cannot swing again
 *     contact   0-1 where in the WHOLE swing the head is at the target
 *     overhead  0-1 how much of the arc is a vertical chop rather than a sweep
 *
 * ---------------------------------------------------------------------------
 * THE FAN FIRED OVER EVERY PEDESTRIAN IN THE CITY. TWO REASONS, BOTH FIXED.
 * ---------------------------------------------------------------------------
 * `player` measured it against a live ped 1.29 m in front of the character, on
 * the same pavement, squarely inside the arc: THREE SWINGS, ZERO HITS. The
 * numbers, in one frame:
 *
 *     old ray origin  (headPosition - 0.10)      y = 2.06
 *     ped head capsule    1.54 .. 1.79  (r 0.108)  -> tops out at 1.898
 *     ped TORSO capsule   0.92 .. 1.45  (r 0.203)  -> tops out at 1.653
 *
 * 1. THE ORIGIN WAS THE EYES. A pedestrian's torso — the only capsule big
 *    enough to be a reliable target — ENDS at about the height of the
 *    attacker's eyes, so a horizontal ray from one to the other grazes the top
 *    of the head at best and sails clean over the moment the two are not on
 *    exactly the same ground plane, which on a street with kerbs is most of the
 *    time. The origin is now the CHEST (0.82 of the stance's anchor height,
 *    ~1.18 m standing, ~0.80 m crouched), which is both where a swing comes
 *    from and the height at which it meets somebody else's chest.
 *
 * 2. THE FAN WAS TOO COARSE AND HAD NO VERTICAL EXTENT. Seven rays across the
 *    Dock Pipe's 108-degree arc is an 18-degree gap — 0.47 m of unswept air at
 *    1.5 m, which a 0.2 m-radius torso fits through with room to spare. The
 *    column count is now derived from the arc so the CHORD between adjacent
 *    rays is at most `CHORD` metres at half reach (9-19 columns), and each
 *    column is cast at three vertical slopes so the fan covers a target on a
 *    kerb above you and one crouching below.
 *
 * Cost is paid lazily: the horizontal row goes first and, if it finds an actor,
 * the other two rows are never cast. A whiff is the expensive case, which is
 * the right way round.
 *
 * ---------------------------------------------------------------------------
 * THE SWEEP
 * ---------------------------------------------------------------------------
 * On the contact frame the weapon head is travelling at 8-14 m/s, which at a
 * 120 Hz fixed step is 7-12 cm per step — a single ray down the middle of the
 * arc misses a 0.22 m ped capsule about as often as it hits one. So the test is
 * a FAN across the weapon's own `arcDeg`, from the chest, out to `reach`. The
 * nearest actor wins; if no actor is in the fan the nearest solid surface takes
 * the hit instead, so a crowbar into a brick wall still sparks and still stops
 * you. Only the HORIZONTAL row may book a solid hit — the downward row exists
 * to find a crouching man and would otherwise report "you hit the pavement"
 * three metres away on every clean miss.
 *
 * Damage goes through `physics.fireBullet` rather than being applied here, for
 * the same reason ballistics does: `physics` owns the impact contract. It
 * raises `bullet:impact` (fx spark/blood, audio, ped startle within 14 m) and
 * `damage:dealt` (the target's own listener applies it), and it carries the
 * knockback impulse into the ragdoll solver. A melee hit deliberately does NOT
 * raise `weapon:fire`: that event startles every ped within 70 m and books the
 * player for discharging a firearm, which is not what a punch is.
 *
 * `src/weapons/meleetest.mjs` is the numeric proof, and it disables `player`'s
 * `peds.nearest` safety net first so it is measuring THIS file.
 *
 * ---------------------------------------------------------------------------
 * WHAT A SWING IS WORTH IS NOT DECIDED HERE
 * ---------------------------------------------------------------------------
 * Damage, reach, arc width, knockback and the stagger a landed blow inflicts
 * are all functions of the COMBO BEAT and of whether the player committed to a
 * heavy — and both of those belong to the man, not to the pipe. They live in
 * `src/player/melee.js` (`MeleeReach`), which is also where the fallback sweep
 * lives, so the two paths that can deal a swing's damage cannot drift apart.
 *
 * This file ASKS: `player.meleeReach.swingDamage(def.damage)`, `.reachScale`,
 * `.arcScale`, `.knockbackScale`, `.staggerTime`, and reports the outcome back
 * with `.landed()`. `player` is an argument `strike()` is already handed, so no
 * import crosses the subsystem boundary. With no model present — the offline
 * rigs build a bare player — every scale is 1 and the swing is the plain
 * authored number, which is exactly what those rigs are measuring.
 *
 * A swing also reaches CARS, through `sim.cars.sweep()` (see vehiclehit.js):
 * vehicles are not in `physics`, so the ray fan passes clean through a door.
 */

/** Fraction of the stance's anchor height the swing is measured from. */
const CHEST_FRAC = 0.82;
/** Fallback chest drop below the eyes, when the player exposes no stance. */
const CHEST_BELOW_HEAD = 0.45;

/**
 * The widest gap the fan may leave between adjacent rays, at half reach.
 * A pedestrian's torso capsule is 0.185-0.203 m in radius, so a step under
 * 0.19 m cannot pass one by.
 */
const CHORD = 0.19;
const MIN_COLS = 9;
const MAX_COLS = 19;

/**
 * Vertical slopes, cast in this order. Row 0 is the swing plane and is the only
 * one allowed to report a solid surface; +0.20 finds somebody standing on a
 * kerb, -0.34 finds one who is crouching, prone, or a step below you (it meets
 * the pavement at ~3.5 m, which is past every reach in the set).
 */
const ROW_SLOPE = [0, 0.20, -0.34];

export class MeleeSolver {
  constructor(ctx) {
    this.ctx = ctx;
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._best = {
      hit: false, distance: 0, actor: null,
      point: new THREE.Vector3(), normal: new THREE.Vector3(), dir: new THREE.Vector3(),
    };
    this._solid = { point: new THREE.Vector3(), dir: new THREE.Vector3() };
    /** Diagnostics for `meleetest.mjs`; written in place, never allocated. */
    this.lastProbe = {
      originY: 0, lowY: 0, highY: 0, cols: 0, rays: 0, reach: 0,
      actor: false, solid: false, car: false, damage: 0, heavy: false,
    };
    /** Reused every swing — `sweep()` reads reach/arcDeg/damage and nothing else. */
    this._carDef = { reach: 3, arcDeg: 70, damage: 0 };
    this.stats = { swings: 0, hits: 0, solidHits: 0, carHits: 0, rays: 0 };
  }

  get physics() {
    if (!this._physics) this._physics = this.ctx.peek('physics');
    return this._physics;
  }

  /**
   * The player's combat model, or a neutral stand-in.
   *
   * The stand-in is not a courtesy: `camtest`, `drivetest` and the fx preview
   * all build a player without one, and a solver that threw there would take
   * the whole bench down. Every scale is 1, so those rigs measure the authored
   * numbers, which is what they are for.
   */
  _model(player) {
    return player?.meleeReach ?? NEUTRAL;
  }

  /**
   * Where the swing is measured FROM.
   *
   * Not the eyes (see the header) and not a bone: `anchorHeight` already folds
   * in the stance AND the brother's body scale, so this tracks a crouch and a
   * short brother without asking the skeleton anything.
   */
  _resolveOrigin(player) {
    const base = player.position ?? player.feetPosition ?? null;
    const anchor = player.movement?.anchorHeight;
    if (base && Number.isFinite(anchor) && anchor > 0.2) {
      return this._origin.set(base.x, base.y + anchor * CHEST_FRAC, base.z);
    }
    const head = player.headPosition;
    if (head) return this._origin.set(head.x, head.y - CHEST_BELOW_HEAD, head.z);
    return null;
  }

  /**
   * Resolve one contact frame.
   *
   * @param {object} def      the finalised weapon
   * @param {object} player   the player system
   * @param {number} side     -1 / +1, which shoulder the arc came from
   * @param {Rng}    rng
   * @returns {boolean} did anything connect
   */
  strike(def, player, side, rng) {
    const phys = this.physics;
    this.stats.swings++;
    if (!phys || !player) return false;
    if (!this._resolveOrigin(player)) return false;

    /* Aim the fan down the CAMERA's yaw+pitch, because that is where the
     * player is looking, but keep the origin on the body — resolving from the
     * camera would let you hit round a corner you are peeking. */
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this._fwd.y = Math.max(-0.55, Math.min(0.4, this._fwd.y));
    this._fwd.normalize();

    /* The beat of the combo and the heavy commit, from their one owner. A
     * heavy is longer AND wider AND harder — that spread is what makes it a
     * different verb rather than a bigger number. */
    const model = this._model(player);
    const half = (def.arcDeg ?? 70) * 0.5 * DEG * model.arcScale;
    const reach = (def.reach ?? 3) * model.reachScale;
    const damage = model.swingDamage(def.damage);
    const mask = phys.MASK?.BULLET;

    /* Columns from the arc, so a wide sweep is not a coarser sweep: the chord
     * between adjacent rays at half reach stays under CHORD metres. */
    const arcLen = 2 * half * reach * 0.5;
    const cols = Math.max(MIN_COLS, Math.min(MAX_COLS, Math.ceil(arcLen / CHORD) | 1));

    const best = this._best;
    best.hit = false;
    best.actor = null;
    best.distance = Infinity;
    const solid = this._solid;
    let solidDist = Infinity;
    let rays = 0;

    const over = def.swing?.overhead ?? 0;
    for (let row = 0; row < ROW_SLOPE.length; row++) {
      /* The horizontal row usually settles it. Only pay for the other two when
       * it found nobody — a hit is the cheap case, a whiff the expensive one. */
      if (row > 0 && best.hit) break;
      const slope = ROW_SLOPE[row];
      for (let i = 0; i < cols; i++) {
        /* Sweep in the direction of travel of THIS swing, so a left hook tests
         * the left of the arc first and the fan is not symmetric about the
         * reticle — that is what makes side-alternating punches feel different. */
        const f = cols === 1 ? 0 : (i / (cols - 1)) * 2 - 1;
        const a = f * half * -side;
        /* An overhead chop leans the whole fan down through the arc: the Body
         * Wrench swings like an axe and finds a man who is already on his knees. */
        const vy = slope - over * (0.5 - Math.abs(f)) * 0.5;
        this._dir.copy(this._fwd)
          .applyAxisAngle(this._up, a)
          .addScaledVector(this._up, vy)
          .normalize();

        const hit = phys.raycast(this._origin, this._dir, reach, mask);
        rays++;
        if (!hit?.hit) continue;
        if (hit.actor) {
          if (hit.distance < best.distance) {
            best.hit = true;
            best.actor = hit.actor;
            best.distance = hit.distance;
            best.point.copy(hit.point);
            best.normal.copy(hit.normal);
            best.dir.copy(this._dir);
          }
        } else if (row === 0 && hit.distance < solidDist) {
          /* Only the swing plane may claim a wall. See the header. */
          solidDist = hit.distance;
          solid.point.copy(hit.point);
          solid.dir.copy(this._dir);
        }
      }
    }

    this.stats.rays += rays;
    const probe = this.lastProbe;
    probe.originY = this._origin.y;
    probe.lowY = this._origin.y + (this._fwd.y + ROW_SLOPE[2] - over * 0.25) * reach * 0.5;
    probe.highY = this._origin.y + (this._fwd.y + ROW_SLOPE[1]) * reach * 0.5;
    probe.cols = cols;
    probe.rays = rays;
    probe.reach = reach;
    probe.actor = best.hit;
    probe.solid = !best.hit && solidDist <= reach;
    probe.damage = damage;
    probe.heavy = !!model.heavy;

    /* ---- cars ----------------------------------------------------------
     * Not in `physics`, so the fan above went straight through the door. This
     * is the same envelope solved against the oriented body — see
     * vehiclehit.js, whose `sweep()` had no caller until now. */
    let carDealt = 0;
    const cars = this.ctx.peek('weapons')?.sim?.cars;
    if (cars?.sweep) {
      this._carDef.reach = reach;
      this._carDef.arcDeg = (def.arcDeg ?? 70) * model.arcScale;
      this._carDef.damage = damage;
      carDealt = cars.sweep(this._origin, this._fwd, this._carDef, side) || 0;
      if (carDealt > 0) this.stats.carHits++;
    }
    probe.car = carDealt > 0;

    const target = best.hit ? best : (solidDist <= reach ? solid : null);
    if (!target) {
      /* A swing that found only a car still landed — the hitstop and the combo
       * credit are owed exactly as much as for a man. */
      if (carDealt > 0) model.landed?.();
      return carDealt > 0;
    }

    /**
     * One "round", NO PENETRATION, and no range drop.
     *
     * The penetration budget used to be 0.25, on the reasoning that a wrench
     * does not stop at the first layer of a shirt. What that actually bought,
     * measured on a 0.68 m capsule at 1.25 m, was FOUR `damage:dealt` events
     * from ONE punch:
     *
     *     flesh 14.00 enter · 13.35 exit · 13.35 enter · 12.64 exit
     *     flesh 12.64 enter · 11.84 exit · 11.84 enter · 10.93 exit
     *
     * 51.8 points for an authored 14, because `Ballistics.fire` re-enters the
     * body it just left and each entry raises its own damage event. A ped
     * carries four overlapping capsules, so the multiplier there is real too.
     * Stack the combo and the heavy on top of that and a third-beat heavy is
     * worth ten times its number.
     *
     * A swing is not a round. It lands once, on the thing it lands on. With
     * `penetration: 0` the budget is zero, `Ballistics` breaks after the first
     * layer, and one swing means one hit.
     *
     * `dropoff: 1` stays: a punch at the far edge of its reach is still a
     * punch, and the range curve exists for bullets losing energy over 400 m.
     *
     * The impulse is the knockback.
     */
    phys.fireBullet({
      origin: this._origin,
      dir: target.dir,
      maxDist: reach,
      damage,
      penetration: 0,
      dropoff: 1,
      impulse: (def.knockback ?? 3) * 9 * model.knockbackScale,
      mask,
      rng,
    });
    if (best.hit) {
      this.stats.hits++;
      this._stagger(best.actor, model.staggerTime, best.point);
      /* THE HITSTOP. Two to five frames of stopped world, on the frame the
       * damage was dealt — not next frame, and not a camera shake. */
      model.landed?.();
    } else {
      this.stats.solidHits++;
    }
    return true;
  }

  /**
   * `e.staggerT = Math.max(e.staggerT, heavy ? 0.7 : 0.28)`.
   *
   * NOTHING in this build publishes a stagger interface, and inventing one by
   * writing into another subsystem's fields is how two owners of one fact get
   * created. So this takes only shapes that already exist and are already
   * decremented by their owner, in order of how well specified they are:
   *
   *   `stagger(seconds)`  the method this file would like to exist
   *   `staggerT`          a seconds-valued field, if anyone adopts it
   *   `stagger`           `game/hostiles.js` — a lean amount, NOT seconds, so
   *                       a heavy reads as a deeper stumble rather than a
   *                       longer one. Its own clamp and decay still apply.
   *
   * plus the flinch that `peds` does publish, which is what a pedestrian's
   * stagger looks like on screen.
   */
  _stagger(actor, seconds, point) {
    if (!actor || !(seconds > 0)) return;
    try {
      if (typeof actor.stagger === 'function') actor.stagger(seconds);
      else if (Number.isFinite(actor.staggerT)) actor.staggerT = Math.max(actor.staggerT, seconds);
      else if (Number.isFinite(actor.stagger)) actor.stagger = Math.max(actor.stagger, seconds);
      actor.animator?.flinch?.(Math.min(1.4, 0.6 + seconds * 1.2));
      if (point && typeof actor.startle === 'function') actor.startle(point, seconds);
    } catch { /* an actor that does not take a stagger is not an error */ }
  }
}

/**
 * The no-model stand-in. Frozen so a bench cannot accidentally tune the game
 * by writing to it, and shaped exactly like `MeleeReach`'s published half.
 */
const NEUTRAL = Object.freeze({
  reachScale: 1,
  arcScale: 1,
  knockbackScale: 1,
  staggerTime: 0.28,
  swingDamage: (base) => base ?? 0,
  landed: () => {},
});

export { CHORD, ROW_SLOPE, CHEST_FRAC, NEUTRAL };
