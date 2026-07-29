/**
 * The third-person movement state machine.
 *
 * Runs at the fixed 120 Hz step so the feel is framerate-independent and
 * reproducible in capture mode. Collision is *entirely* delegated to
 * `physics.createCharacter()` — this file only ever owns velocity and asks the
 * controller to resolve a displacement.
 *
 * WHAT CHANGED FROM THE INHERITED SHOOTER
 * The camera, not the body, owns yaw. Input is resolved in the camera's basis
 * and the body's facing (`faceYaw`) chases the direction of travel at a rate
 * that falls with speed — which is why a sprint turns in a wide arc and a walk
 * pivots on the spot. Aiming flips it: the body locks to the camera and strafes.
 *
 * States
 *   idle · walk · jog · sprint · stop · turn · crouch · jump · fall · stumble ·
 *   mantle · vault · swim · drive
 *
 * `stop` and `turn` exist purely so the animator has something to key off; they
 * are not gates — every transition here is interruptible on the next step.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WATER. Three rivers is a third of the map and Carson's whole arc is on it, so
 * falling in is a real state, not a fail case. `world.isWater(x, z)` says where
 * the water is and `world.WATER_Y` how high; everything from there is depth
 * above the FEET, which is the only measure that behaves the same on a bridge
 * deck (negative), in the shallows (positive but small) and mid-river. Buoyancy
 * settles the body at `floatDepth` with the head out, holding crouch takes you
 * under, and the breath meter that runs while the head is submerged is what
 * turns a long dive into a drowning. `player` owns the damage; this owns the
 * clock.
 *
 * MELEE. `weapons` owns the arc and writes the arm bones directly. `melee` here
 * is the whole-body commit that goes with it: the facing snaps to the camera so
 * the swing lands where you are looking, the gait drops to a shuffle, and you
 * cannot sprint out of the recovery.
 *
 * BLOCKING is the other half of that: `blocking` is pushed in by `player` from
 * `MeleeReach.blocking` and costs you the sprint and most of your speed. See
 * `BLOCK_SLOW`.
 */

import * as THREE from 'three';
import { STANCE, MOVE, GRAVITY, JUMP_SPEED, FOOTSTEP } from './tuning.js';
import { LedgeProbe, MantleMotion, LEDGE_NONE, LEDGE_VAULT } from './mantle.js';
import { clamp, clamp01, approach, lerp, angleDelta } from './springs.js';

/**
 * Bounds for the fell-through-the-world correction (see the resolve step).
 * MIN so a kerb lip, a step or normal capsule slop never triggers it; MAX so a
 * legitimate basement, tunnel, underpass or riverbed is left entirely alone —
 * those are genuinely below the walkable field and the player is meant to be
 * there. Between the two there is nothing a player can legitimately be doing.
 */
const FELL_THROUGH_MIN = 0.55;
const FELL_THROUGH_MAX = 6.0;

/**
 * What a raised guard costs you: a fraction of the JOG, exclusive with the
 * sprint in both directions. A guard can never be sprinted through, and the
 * sprint never latches while the guard is up in the first place. Both halves are
 * enforced — `_updateSprint` refuses to latch, and `targetSpeed` returns the
 * reduced number even if something else in the build were to set `sprinting`
 * behind its back.
 *
 * It is a RATIO rather than an absolute speed so that it tracks the jog:
 * 3.35 * 0.45 = 1.508 m/s. The constant lives here rather than in `tuning.js`.
 */
const BLOCK_SLOW = 0.45;

export const STATES = [
  'idle', 'walk', 'jog', 'sprint', 'stop', 'turn', 'crouch',
  'jump', 'fall', 'stumble', 'mantle', 'vault', 'swim', 'drive',
];

export class Movement {
  constructor(ctx, player) {
    this.ctx = ctx;
    this.player = player;
    this.physics = null;
    this.character = null;
    this.probe = null;
    this.mantleMotion = new MantleMotion();

    // ---- authored state --------------------------------------------------
    this.state = 'idle';
    this.prevState = 'idle';
    this.stateTime = 0;
    this.stance = 'stand';
    this.stanceWant = 'stand';
    this.crouchBlend = 0;
    this.sprinting = false;
    this.walking = false;
    this.grounded = true;
    this.wasGrounded = true;
    this.airTime = 0;
    this.groundTime = 0;
    this.speed = 0;
    this.horizontalSpeed = 0;
    this.blocked = false;
    this.driving = false;
    this.bodyScale = 1;

    // ---- water -----------------------------------------------------------
    /**
     * `world.isWater(x, z)` says a river is here; `world.WATER_Y` says how high
     * it is. The predecessor's note that swimming was "inert because world
     * exposed no water query" is out of date, but the fallback it left behind
     * read `world.waterLevel`, which has never existed — so the level was always
     * the `?? 0` default and only worked because WATER_Y happens to be 0.
     */
    this.swimming = false;
    this.waterDepth = 0;
    this.waterLevel = -Infinity;
    /** True once the head is under. Drives the breath meter. */
    this.submerged = false;
    /** 1 = full lungs, 0 = drowning. */
    this.breath = 1;
    this.drowning = false;
    /** One-shot for `player`: a splash to emit. */
    this.waterEvent = { pending: false, entering: false, speed: 0 };

    // ---- orientation -----------------------------------------------------
    /** Camera yaw, pushed in by PlayerSystem every step — the input basis. */
    this.camYaw = 0;
    this.camPitch = 0;
    /** Where the body is pointing. */
    this.faceYaw = 0;
    /** Where the player wants to go. */
    this.moveYaw = 0;
    this.turning = 0;
    this.faceRate = 0;

    // ---- externally driven ----------------------------------------------
    this.adsAmount = 0;
    this.aiming = false;
    /**
     * True while `weapons` has a melee swing in flight. A swing commits the
     * whole body: the facing snaps to the camera so the arc lands where you are
     * looking, the gait drops to a shuffle, and you cannot sprint out of it.
     */
    this.melee = false;
    /**
     * True while the guard is up. Pushed in by `PlayerSystem` from
     * `MeleeReach.blocking`, the same way `melee` and `aiming` are — this file
     * never reads the brawl model, and the brawl model never reads this one.
     */
    this.blocking = false;
    /**
     * NEGATIVE CONTROL, read by `src/player/blockblastprobe.mjs` and by nothing
     * else: false restores the pre-fix behaviour in which a raised guard cost
     * neither the sprint nor any speed.
     */
    this.debugBlockSlow = true;
    /**
     * NEGATIVE CONTROL, read by `src/player/camlagtest.mjs --control=seatlerp`
     * and by nothing else: false re-applies the fixed-step render lerp to the
     * seated body, which is the second half of the driver-off-his-seat beat.
     * See `sampleRender`.
     */
    this.debugSeatNoLerp = true;
    this.controlEnabled = true;
    /** Sprint speed for the active brother. */
    this.sprintSpeed = MOVE.sprintSpeed;

    // ---- timers ----------------------------------------------------------
    this._coyote = 0;
    this._jumpBuffer = 0;
    this._jumpCooldown = 0;
    this._mantleCooldown = 0;
    this._ledgeProbeTimer = 0;
    this._stopTime = 0;
    this._waterTimer = 0;
    this.stumbleTime = 0;
    this.stumble = 0;

    /**
     * Height of the last surface that actually carried him. Read only by the
     * ledge probe, which measures a mantle's REACH from here rather than from
     * the feet — otherwise a jump adds its apex to how high he can climb. See
     * the `reachY` note in `mantle.js`.
     */
    this.supportY = 0;

    /** One-shot flags consumed (and cleared) by PlayerSystem each frame. */
    this.jumped = false;

    // ---- input snapshot --------------------------------------------------
    this.cmd = {
      moveX: 0, moveY: 0, mag: 0,
      jump: false, jumpHeld: false,
      crouchPressed: false, crouchHeld: false,
      sprintHeld: false,
      walkHeld: false,
      usePressed: false,
      ads: false,
    };
    this.moveX = 0;
    this.moveY = 0;
    this._cmdFrame = -1;
    this._edgeFrame = -1;
    this._prevHeld = { jump: false, crouch: false, use: false };
    /** Set by debugState()/the harness to drive the machine without a keyboard. */
    this.scriptedInput = null;

    // ---- interpolation ---------------------------------------------------
    this.prevPosition = new THREE.Vector3();
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.renderPosition = new THREE.Vector3();

    // ---- events ----------------------------------------------------------
    this.landEvent = { pending: false, speed: 0, surface: 'concrete' };
    this.mantleEvent = { pending: false, kind: 'none', height: 0 };

    // ---- scratch ---------------------------------------------------------
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    this._prevVy = 0;
    this._bobPhase = 0;
  }

  /* ==================================================================== */
  /* setup                                                                */
  /* ==================================================================== */

  init(physics, spawn) {
    this.physics = physics;
    this.probe = new LedgeProbe(physics);
    this.character = physics.createCharacter({
      id: 'player',
      owner: this.player,
      radius: 0.32,
      height: STANCE.stand.height,
      stepHeight: STANCE.stand.stepHeight,
      slopeLimit: 48 * (Math.PI / 180),
      snapDistance: 0.34,
    });
    if (spawn) this.character.teleport(spawn.x, spawn.y, spawn.z);
    this.position.set(this.character.position.x, this.character.position.y, this.character.position.z);
    this.prevPosition.copy(this.position);
    this.renderPosition.copy(this.position);
    this.supportY = this.position.y;
    return this.character;
  }

  dispose() {
    if (this.character && this.physics) this.physics.removeCharacter(this.character);
    this.character = null;
  }

  get stanceDef() {
    return STANCE[this.stance];
  }

  get eyeHeight() {
    return STANCE[this.stance].eye;
  }

  get anchorHeight() {
    return STANCE[this.stance].anchor * this.bodyScale;
  }

  /* ==================================================================== */
  /* input                                                                */
  /* ==================================================================== */

  /**
   * `scriptedInput` lets the capture harness and the playtest driver hold a
   * gait without synthesising key events: { x, y, sprint, walk, crouch }.
   */
  latchInput(frame) {
    if (frame === this._cmdFrame) return;
    this._cmdFrame = frame;
    const cmd = this.cmd;
    const input = this.ctx.input;
    const prev = this._prevHeld;

    if (this.scriptedInput && this.controlEnabled) {
      const s = this.scriptedInput;
      cmd.moveX = s.x ?? 0;
      cmd.moveY = s.y ?? 0;
      cmd.mag = Math.min(1, Math.hypot(cmd.moveX, cmd.moveY));
      this.moveX = cmd.moveX;
      this.moveY = cmd.moveY;
      // The harness holds a gait; `jump` used to be latched as HELD only, so a
      // scripted jump could never clear the buffer and the jump/fall/land arc
      // was unreachable from any automated test.
      cmd.jump = !!s.jump && !prev.jump;
      cmd.jumpHeld = !!s.jump;
      cmd.crouchPressed = !!s.crouch && this.stanceWant !== 'crouch';
      cmd.crouchHeld = !!s.crouch;
      cmd.usePressed = false;
      cmd.sprintHeld = !!s.sprint;
      cmd.walkHeld = !!s.walk;
      cmd.ads = !!s.aim;
      if (!s.crouch && this.stanceWant === 'crouch') cmd.crouchPressed = true;
      prev.jump = !!s.jump;
      if (cmd.jump) this._jumpBuffer = MOVE.jumpBuffer;
      return;
    }

    if (!this.controlEnabled) {
      cmd.moveX = cmd.moveY = cmd.mag = 0;
      cmd.jump = cmd.jumpHeld = false;
      cmd.crouchPressed = cmd.crouchHeld = false;
      cmd.sprintHeld = cmd.walkHeld = false;
      cmd.usePressed = false;
      cmd.ads = false;
      prev.jump = prev.crouch = prev.use = false;
      this.moveX = this.moveY = 0;
      return;
    }

    input.moveVector(cmd);
    cmd.moveX = cmd.x;
    cmd.moveY = cmd.y;
    cmd.mag = Math.min(1, Math.hypot(cmd.x, cmd.y));
    this.moveX = cmd.moveX;
    this.moveY = cmd.moveY;

    const jump = input.action('jump');
    const crouch = input.action('crouch');
    const use = input.action('use');
    cmd.jump = jump && !prev.jump;
    cmd.jumpHeld = jump;
    cmd.crouchPressed = crouch && !prev.crouch;
    cmd.crouchHeld = crouch;
    cmd.usePressed = use && !prev.use;
    cmd.sprintHeld = input.action('sprint') || Math.abs(input.stick.moveY) > 0.94;
    cmd.walkHeld = input.held('AltLeft') || input.held('AltRight');
    cmd.ads = input.ads;

    prev.jump = jump;
    prev.crouch = crouch;
    prev.use = use;

    if (cmd.jump) this._jumpBuffer = MOVE.jumpBuffer;
  }

  /* ==================================================================== */
  /* the fixed step                                                       */
  /* ==================================================================== */

  step(h) {
    const c = this.character;
    if (!c) return;
    const cmd = this.cmd;

    // One rendered frame contains 0..N fixed steps but only ever one key press.
    const frame = this.ctx.time.frame;
    if (frame !== this._edgeFrame) this._edgeFrame = frame;
    else {
      cmd.jump = false;
      cmd.crouchPressed = false;
      cmd.usePressed = false;
    }

    this.prevPosition.copy(this.position);
    this.stateTime += h;
    this._tickTimers(h);

    if (this.driving) {
      this._publish();
      return;
    }

    // Camera basis for this step.
    const sy = Math.sin(this.camYaw), cy = Math.cos(this.camYaw);
    this._fwd.set(-sy, 0, -cy);
    this._right.set(cy, 0, -sy);

    if (this.mantleMotion.active) {
      this._stepMantle(h);
      this._publish();
      return;
    }

    /* ---- wish direction ------------------------------------------------ */
    const mag = cmd.mag;
    const wish = this._wish;
    if (mag > 1e-4) {
      // While aiming the body strafes, so the sideways/backward penalties apply
      // in the CAMERA basis; free-running has no penalty because the body turns.
      const sx = this.aiming ? cmd.moveX * MOVE.strafeScale : cmd.moveX;
      const sz = this.aiming ? (cmd.moveY >= 0 ? cmd.moveY : cmd.moveY * MOVE.backScale) : cmd.moveY;
      wish.set(this._fwd.x * sz + this._right.x * sx, 0, this._fwd.z * sz + this._right.z * sx);
      const l = Math.hypot(wish.x, wish.z);
      if (l > 1e-5) {
        wish.x /= l; wish.z /= l;
        this.moveYaw = Math.atan2(-wish.x, -wish.z);
      }
    } else {
      wish.set(0, 0, 0);
    }

    this._updateWater(h);
    this._updateStance(cmd, mag);
    this._updateSprint(cmd, mag);
    const jumped = this._updateJump(cmd);
    this._updateFacing(h, mag);

    /* ---- integrate ------------------------------------------------------ */
    const v = this.velocity;
    if (this.swimming) {
      this._accelerateSwim(h, wish, mag);
    } else if (c.grounded && !jumped) {
      this._accelerateGround(h, wish, mag);
      if (v.y < 0) v.y = 0;
      v.y += GRAVITY * h;
    } else {
      this._accelerateAir(h, wish, mag);
      v.y += GRAVITY * h;
    }
    if (v.y < -MOVE.terminalSpeed) v.y = -MOVE.terminalSpeed;

    /* ---- ledge ---------------------------------------------------------- */
    if (this._tryLedge(h, wish, mag, cmd)) {
      this._publish();
      return;
    }

    /* ---- resolve -------------------------------------------------------- */
    this._prevVy = v.y;
    c.velocity.x = v.x; c.velocity.y = v.y; c.velocity.z = v.z;
    c.move(v.x * h, v.y * h, v.z * h);
    const preSpeed = Math.hypot(v.x, v.z);
    v.x = c.velocity.x; v.y = c.velocity.y; v.z = c.velocity.z;
    this.blocked = c.lastMoveBlocked;

    this.wasGrounded = this.grounded;
    this.grounded = this.swimming ? false : c.grounded;
    this.position.set(c.position.x, c.position.y, c.position.z);

    /*
     * FELL THROUGH THE WORLD — put him back.
     *
     * The collision mesh and the authored ground are two different descriptions
     * of the same city, and where they disagree the capsule can settle BELOW
     * the surface the player is supposed to be standing on: through a seam
     * between two pavement pieces, under a kerb, or onto a road corridor's
     * underside. MEASURED at spawn, before a key was pressed: feet at -0.423
     * with `world.walkableHeightAt` reporting 1.649 at the same x/z — two
     * metres of ground overhead, and `grounded === true`, so nothing downstream
     * had any reason to suspect a problem. `groundsweep` reports 0 holes, which
     * is exactly why this is caught here and not left to a gate: the sweep is
     * measuring rays and this is measuring where a man ended up.
     *
     * The correction is deliberately forgiving rather than clever: it never
     * fights honest geometry (a basement, a tunnel, a riverbed are all
     * legitimately below the walkable field, which is why the correction is
     * bounded and only fires while grounded), it just refuses to let the world
     * swallow him.
     */
    if (this.grounded && !this.swimming && !this.driving) {
      const w = this._world ?? (this._world = this.ctx?.peek?.('world') ?? null);
      const wy = w?.walkableHeightAt?.(this.position.x, this.position.z);
      if (Number.isFinite(wy)) {
        const under = wy - this.position.y;
        if (under > FELL_THROUGH_MIN && under < FELL_THROUGH_MAX) {
          this.position.y = wy + 0.02;
          c.position.y = this.position.y;
          this.prevPosition.y = this.position.y;
          v.y = 0;
          this._fellThrough = (this._fellThrough ?? 0) + 1;
        }
      }
    }

    if (this.grounded || this.swimming) this.supportY = this.position.y;
    if (c.touchingCeiling && v.y > 0) v.y = 0;

    // Running full tilt into a wall is a stumble, not a dead stop.
    if (this.blocked && preSpeed > MOVE.stumble.wallSpeed && Math.hypot(v.x, v.z) < preSpeed * 0.5) {
      this._beginStumble(0.7);
    }

    this._postMove(h);
    this._resolveState();
    this._publish();
  }

  _tickTimers(h) {
    this._jumpBuffer = Math.max(0, this._jumpBuffer - h);
    this._jumpCooldown = Math.max(0, this._jumpCooldown - h);
    this._mantleCooldown = Math.max(0, this._mantleCooldown - h);
    this._ledgeProbeTimer = Math.max(0, this._ledgeProbeTimer - h);
    this._stopTime = Math.max(0, this._stopTime - h);
    if (this.stumbleTime > 0) {
      this.stumbleTime = Math.max(0, this.stumbleTime - h);
      this.stumble = clamp01(this.stumbleTime / MOVE.stumble.time);
    } else {
      this.stumble = 0;
    }
    if (this.grounded) {
      this._coyote = MOVE.coyoteTime;
      this.groundTime += h;
      this.airTime = 0;
    } else {
      this._coyote = Math.max(0, this._coyote - h);
      this.airTime += h;
      this.groundTime = 0;
    }
    this.crouchBlend = approach(
      this.crouchBlend, this.stance === 'crouch' ? 1 : 0,
      this.stance === 'crouch' ? MOVE.stanceTau.standCrouch : MOVE.stanceTau.crouchStand, h
    );
  }

  /* ==================================================================== */
  /* water                                                                */
  /* ==================================================================== */

  /**
   * WATER.
   *
   * `world.isWater(x, z)` is a terrain test — "the ground here is below the
   * river plane" — so it is true under every bridge in the city. The depth, not
   * the flag, is what decides anything: `waterDepth` is metres of water above
   * the FEET, so it is negative on a bridge deck and positive in the river.
   *
   * The query is polled at 10 Hz (it walks the terrain field) but the depth is
   * integrated every step from the vertical velocity in between, so the
   * buoyancy spring never sees a staircase.
   */
  _updateWater(h) {
    const S = MOVE.swim;
    this._waterTimer -= h;
    if (this._waterTimer <= 0) {
      this._waterTimer = 0.1;
      const world = this.ctx.peek('world');
      const p = this.position;
      let level = -Infinity;
      if (world) {
        if (typeof world.waterLevelAt === 'function') level = world.waterLevelAt(p.x, p.z);
        else if (typeof world.isWater === 'function' && world.isWater(p.x, p.z)) {
          level = world.WATER_Y ?? world.waterLevel ?? 0;
        }
      }
      this.waterLevel = level;
    }
    const wasSwimming = this.swimming;
    this.waterDepth = Number.isFinite(this.waterLevel)
      ? this.waterLevel - this.position.y
      : -Infinity;

    if (!this.swimming && this.waterDepth > S.enterDepth) {
      this.swimming = true;
      this.stanceWant = 'stand';
      this.stance = 'stand';
      this.character.height = STANCE.stand.height;
      this.sprinting = false;
      this.mantleMotion.end();
    } else if (this.swimming && this.waterDepth < S.exitDepth) {
      this.swimming = false;
    }
    if (this.swimming !== wasSwimming) {
      this.waterEvent.pending = true;
      this.waterEvent.entering = this.swimming;
      this.waterEvent.speed = Math.abs(this.velocity.y);
    }

    /* ---- breath -------------------------------------------------------- */
    // The head is under when the water is deeper than the neck anchor plus the
    // skull. Below that line the lungs run down; at zero, `player` drowns you.
    this.submerged = this.waterDepth > this.anchorHeight + S.headOffset;
    if (this.submerged) {
      this.breath = Math.max(0, this.breath - h / S.breathTime);
    } else {
      this.breath = Math.min(1, this.breath + h / S.recoverTime);
    }
    this.drowning = this.submerged && this.breath <= 0;
  }

  /**
   * Swimming. Three things have to be true at once or it does not read as
   * water: you accelerate slowly and coast, you float back to the surface with
   * your head out, and holding crouch takes you under and keeps you there.
   */
  _accelerateSwim(h, wish, mag) {
    const v = this.velocity;
    const S = MOVE.swim;
    const cmd = this.cmd;
    const sprint = cmd.sprintHeld && this.breath > 0.05;
    const target = (sprint ? MOVE.swimSprint : MOVE.swimSpeed) * mag
      * (this.breath <= 0 ? S.drownSlow : 1);
    const tx = wish.x * target, tz = wish.z * target;
    // Water is heavy: the stroke takes about half a second to reach speed and
    // the same again to coast down. Anything snappier reads as ice.
    const rate = mag > 1e-4 ? S.accel : S.coast;
    v.x += (tx - v.x) * Math.min(1, rate * h);
    v.z += (tz - v.z) * Math.min(1, rate * h);

    // Buoyancy toward the float line: `floatDepth` is metres of the BODY under
    // the surface at rest, so head and shoulders stay out of the river.
    let want = S.floatDepth;
    if (cmd.crouchHeld) want = S.diveDepth;          // dive and hold under
    else if (cmd.jumpHeld) want = S.surfaceDepth;    // kick for the surface
    // Out of breath you sink, which is what makes drowning a thing that happens
    // to you rather than a number that ticks.
    if (this.breath <= 0) want = Math.max(want, this.waterDepth + 0.8);
    const err = this.waterDepth - want;
    v.y += (err * S.buoyancy - v.y * S.drag) * h;
    v.y = clamp(v.y, -S.maxVertical, S.maxVertical);
  }

  /* ==================================================================== */
  /* stance / sprint                                                      */
  /* ==================================================================== */

  _updateStance(cmd, mag) {
    const c = this.character;
    if (this.swimming) {
      this.stanceWant = 'stand';
    } else {
      if (cmd.crouchPressed) this.stanceWant = this.stanceWant === 'crouch' ? 'stand' : 'crouch';
      if (cmd.sprintHeld && mag > 0.5 && this.stanceWant === 'crouch') this.stanceWant = 'stand';
      if (cmd.jump) this.stanceWant = 'stand';
    }
    if (this.stanceWant === this.stance) return;
    const target = STANCE[this.stanceWant];
    if (target.height <= this.stanceDef.height || c.canFit(target.height)) {
      c.height = target.height;
      c.stepHeight = target.stepHeight;
      this.stance = this.stanceWant;
    }
  }

  /** The guard, with the negative control folded in once rather than twice. */
  get _guarding() {
    return this.blocking && this.debugBlockSlow !== false;
  }

  _updateSprint(cmd, mag) {
    this.walking = cmd.walkHeld;
    this.sprinting =
      cmd.sprintHeld && mag > 0.45 && this.stance === 'stand' &&
      !this.aiming && !this.melee && !this._guarding && this.stumbleTime <= 0 &&
      (this.grounded || this.sprinting);
  }

  /** Speed the character is asking for this step. */
  targetSpeed(mag) {
    if (mag < 1e-4) return 0;
    if (this.swimming) return (this.cmd.sprintHeld ? MOVE.swimSprint : MOVE.swimSpeed) * mag;
    if (this.melee) return MOVE.meleeSpeed * mag;
    // Ahead of crouch, aim and sprint, and behind the swing: the swing's own
    // slow stacks on top of everything, and `MOVE.meleeSpeed` is already slower
    // than this. See BLOCK_SLOW.
    if (this._guarding) return MOVE.jogSpeed * BLOCK_SLOW * mag;
    if (this.stance === 'crouch') return MOVE.crouchSpeed * mag;
    if (this.aiming) return MOVE.aimSpeed * mag;
    if (this.sprinting) return this.sprintSpeed;
    if (this.walking) return MOVE.walkSpeed * mag;
    // Analog: the first 62 % of stick travel is a walk, the rest ramps to a jog.
    const m = mag;
    const s = m < 0.62
      ? MOVE.walkSpeed * (m / 0.62)
      : lerp(MOVE.walkSpeed, MOVE.jogSpeed, (m - 0.62) / 0.38);
    return s * (this.stumbleTime > 0 ? MOVE.stumble.slow : 1);
  }

  /* ==================================================================== */
  /* facing                                                               */
  /* ==================================================================== */

  _updateFacing(h, mag) {
    let want;
    if (this.aiming || this.melee) {
      // A swing lands where you are LOOKING (`weapons` sweeps its fan down the
      // camera), so the body has to be pointing there too or the pipe passes
      // through a ped the character has his back to.
      want = this.camYaw;
    } else if (mag > 0.05) {
      want = this.moveYaw;
    } else {
      // Standing still: only re-orient if the camera has swung right around
      // behind the shoulder, which is what GTA does.
      const d = angleDelta(this.faceYaw, this.camYaw);
      if (Math.abs(d) > 2.0) want = this.camYaw - Math.sign(d) * 1.75;
      else want = this.faceYaw;
    }

    const err = angleDelta(this.faceYaw, want);
    const speedT = clamp01(this.horizontalSpeed / this.sprintSpeed);
    let rate;
    if (this.aiming || this.melee) rate = 14;
    else if (mag < 0.05) rate = MOVE.turnInPlaceRate;
    else rate = lerp(lerp(MOVE.turnRateIdle, MOVE.turnRateWalk, clamp01(speedT * 3)), MOVE.turnRateSprint, speedT);

    const step = rate * h;
    this.faceRate = err / Math.max(1e-4, h);
    if (Math.abs(err) <= step) {
      this.faceYaw = want;
      this.faceRate = err / Math.max(1e-4, h);
    } else {
      this.faceYaw += Math.sign(err) * step;
      this.faceRate = Math.sign(err) * rate;
    }
    if (this.faceYaw > Math.PI) this.faceYaw -= Math.PI * 2;
    else if (this.faceYaw < -Math.PI) this.faceYaw += Math.PI * 2;

    // `turning` drives the turn-in-place animation.
    const t = mag < 0.08 && this.grounded ? clamp01(Math.abs(err) / MOVE.turnInPlaceAngle) : 0;
    this.turning = approach(this.turning, t, 0.12, h);
  }

  /* ==================================================================== */
  /* acceleration                                                         */
  /* ==================================================================== */

  _accelerateGround(h, wish, mag) {
    const v = this.velocity;
    const want = this.targetSpeed(mag);

    // The body accelerates along its FACING, not along the stick — you cannot
    // run sideways at full tilt, you have to turn first. That single rule is
    // most of what separates a GTA character from a shooter one.
    let dirX, dirZ;
    if (this.aiming || mag < 1e-4) {
      dirX = wish.x; dirZ = wish.z;
    } else {
      const err = Math.abs(angleDelta(this.faceYaw, this.moveYaw));
      const align = clamp01(1 - err / 1.9);
      dirX = -Math.sin(this.faceYaw) * align + wish.x * (1 - align);
      dirZ = -Math.cos(this.faceYaw) * align + wish.z * (1 - align);
      const l = Math.hypot(dirX, dirZ) || 1;
      dirX /= l; dirZ /= l;
    }

    let tx = dirX * want;
    let tz = dirZ * want;

    // Walk along the ground plane so slopes neither steal speed nor launch.
    const gn = this.character.groundNormal;
    if (gn.y > 0.1 && gn.y < 0.999 && (tx !== 0 || tz !== 0)) {
      const d = tx * gn.x + tz * gn.z;
      const px = tx - gn.x * d, pz = tz - gn.z * d;
      const l = Math.hypot(px, pz);
      if (l > 1e-5) {
        const s = Math.hypot(tx, tz) / l;
        tx = px * s; tz = pz * s;
      }
    }

    const cur = Math.hypot(v.x, v.z);
    const dx = tx - v.x, dz = tz - v.z;
    const dl = Math.hypot(dx, dz);
    if (dl < 1e-6) return;

    let rate;
    if (mag < 0.02) {
      // Releasing the stick above a jog is a HARD STOP: a plant, not a fade.
      if (cur > MOVE.hardStopSpeed && this._stopTime <= 0 && this.state !== 'stop') {
        this._stopTime = MOVE.hardStopTime;
      }
      rate = this._stopTime > 0 ? MOVE.hardStopDecel : MOVE.stopDecel;
    } else if (want < cur * 0.92) {
      rate = MOVE.groundDecel;
    } else {
      rate = MOVE.groundAccel;
      // Turning hard costs speed, which is what makes a sprint arc.
      const err = Math.abs(angleDelta(this.faceYaw, this.moveYaw));
      if (err > 0.6) rate *= lerp(1, 0.35, clamp01((err - 0.6) / 1.4));
    }
    rate *= clamp(this.character.groundFriction + 0.08, 0.75, 1.05);

    const stepD = rate * h;
    if (dl <= stepD) { v.x = tx; v.z = tz; }
    else { const s = stepD / dl; v.x += dx * s; v.z += dz * s; }
  }

  _accelerateAir(h, wish, mag) {
    if (mag < 1e-4) return;
    const v = this.velocity;
    const cap = MOVE.airSpeedCap * mag;
    const along = v.x * wish.x + v.z * wish.z;
    const add = cap - along;
    if (add <= 0) return;
    const accel = MOVE.groundAccel * MOVE.airAccelScale * mag * h;
    const gain = accel < add ? accel : add;
    v.x += wish.x * gain;
    v.z += wish.z * gain;
  }

  /* ==================================================================== */
  /* jump                                                                 */
  /* ==================================================================== */

  _updateJump(cmd) {
    if (this.swimming) return false;
    if (this._jumpBuffer <= 0 || this._jumpCooldown > 0) return false;
    const c = this.character;
    if (!c.grounded && this._coyote <= 0) return false;
    if (this.stance !== 'stand') {
      if (!c.canFit(STANCE.stand.height)) return false;
      c.height = STANCE.stand.height;
      c.stepHeight = STANCE.stand.stepHeight;
      this.stance = this.stanceWant = 'stand';
    }
    this._doJump();
    return true;
  }

  _doJump() {
    const v = this.velocity;
    v.y = JUMP_SPEED;
    this._jumpBuffer = 0;
    this._jumpCooldown = MOVE.jumpCooldown;
    this._coyote = 0;
    this.grounded = false;
    this.character.grounded = false;
    this.jumped = true;
    this._setState('jump');
  }

  _beginStumble(strength) {
    if (this.stumbleTime > MOVE.stumble.time * 0.5) return;
    this.stumbleTime = MOVE.stumble.time * clamp01(strength);
    this.sprinting = false;
  }

  /** Public: `vehicle.js` throws the actor out of a moving car into a tumble. */
  beginStumble(strength) { this._beginStumble(strength); }

  /* ==================================================================== */
  /* mantle / vault                                                       */
  /* ==================================================================== */

  _tryLedge(h, wish, mag, cmd) {
    if (this._mantleCooldown > 0) return false;
    if (mag < 0.35) return false;
    if (this._ledgeProbeTimer > 0) return false;

    const c = this.character;
    const v = this.velocity;
    const sp = Math.hypot(v.x, v.z);

    const pressing = cmd.jumpHeld || cmd.jump;

    /* ---- climbing out of the water -------------------------------------
     * A gentle bank needs nothing: the terrain rises, the depth falls under
     * `exitDepth` and you walk out. A dock wall, a bridge pier or a quay does
     * need this — without it Carson's entire arc ends with him treading water
     * against a vertical face he can see the top of.
     */
    if (this.swimming) {
      if (this.waterDepth > MOVE.swim.climbMaxDepth) return false;
      if (!(c.lastMoveBlocked || pressing)) return false;
      this._ledgeProbeTimer = 0.05;
      const fx0 = -Math.sin(this.faceYaw), fz0 = -Math.cos(this.faceYaw);
      // Treading water: the water line IS the support, so the feet are the datum.
      const kind0 = this.probe.probe(c, fx0, fz0, STANCE.stand.height, c.position.y);
      if (kind0 === LEDGE_NONE) return false;
      this._beginLedge(kind0, this.probe.result, c, fx0, fz0, Math.max(sp, 1.4));
      this.swimming = false;
      return true;
    }
    const blockedNow = c.lastMoveBlocked && sp > 0.3;
    const descending = !c.grounded && v.y < 1.0;
    const closing = c.grounded && sp >= MOVE.mantle.autoSpeed;
    if (!(blockedNow || descending || closing || (pressing && c.grounded))) return false;
    this._ledgeProbeTimer = clamp(0.1 / Math.max(1.5, sp), 0.008, 0.05);

    // Probe along the BODY facing: the character climbs what he is running at.
    const fx = -Math.sin(this.faceYaw), fz = -Math.cos(this.faceYaw);
    const kind = this.probe.probe(
      c, fx, fz, STANCE.stand.height,
      this.grounded ? c.position.y : this.supportY
    );
    if (kind === LEDGE_NONE) return false;

    const r = this.probe.result;
    const auto = r.fast && sp >= MOVE.mantle.autoSpeed;

    if (closing && !blockedNow && !pressing) {
      const reach = MOVE.mantle.proactiveDistance + sp * MOVE.mantle.proactiveLookahead;
      if (r.distance > reach) return false;
      if (r.obstacleHeight < c.stepHeight + 0.07) return false;
    }
    if (!auto && !pressing) return false;

    this._beginLedge(kind, r, c, fx, fz, sp);
    return true;
  }

  _beginLedge(kind, r, c, fx, fz, sp) {
    this.mantleMotion.begin(r, c, fx, fz, 1, sp);
    this.velocity.set(0, 0, 0);
    c.velocity.x = c.velocity.y = c.velocity.z = 0;
    this._jumpBuffer = 0;
    this.sprinting = false;
    this.mantleEvent.pending = true;
    this.mantleEvent.kind = kind === LEDGE_VAULT ? 'vault' : 'mantle';
    this.mantleEvent.height = r.obstacleHeight;
    this._setState(kind === LEDGE_VAULT ? 'vault' : 'mantle');
  }

  _stepMantle(h) {
    const m = this.mantleMotion;
    const c = this.character;
    const alive = m.step(h);
    c.setPosition(m.px, m.py, m.pz);
    this.position.set(m.px, m.py, m.pz);
    this.wasGrounded = this.grounded;
    this.grounded = false;
    if (!alive) {
      m.end();
      c.setPosition(m.landX, m.landY, m.landZ);
      this.position.set(m.landX, m.landY, m.landZ);
      c.depenetrate(4);
      c.probeGround();
      this.grounded = c.grounded;
      this.wasGrounded = true;
      // The lip he just climbed onto is the new support — so a second mantle
      // chained off the first measures its reach from there, not from the
      // street below, and stacking climbs cannot compound.
      this.supportY = this.position.y;
      const v = this.velocity;
      v.x = m.fx * m.exitSpeed;
      v.z = m.fz * m.exitSpeed;
      v.y = 0;
      this._mantleCooldown = MOVE.mantle.cooldown;
      this._resolveState();
    }
  }

  cancelMantle() {
    if (!this.mantleMotion.active) return;
    const m = this.mantleMotion;
    m.end();
    this.character.setPosition(m.landX, m.landY, m.landZ);
    this.position.set(m.landX, m.landY, m.landZ);
    this.character.depenetrate(4);
    this.character.probeGround();
    this._mantleCooldown = MOVE.mantle.cooldown;
    this._resolveState();
  }

  /* ==================================================================== */
  /* post-move                                                            */
  /* ==================================================================== */

  _postMove(h) {
    const c = this.character;
    const v = this.velocity;
    this.speed = Math.hypot(v.x, v.y, v.z);
    this.horizontalSpeed = Math.hypot(v.x, v.z);

    if (this.grounded && !this.wasGrounded) {
      const impact = Math.max(c.landingSpeed, -Math.min(0, this._prevVy));
      this.landEvent.pending = true;
      this.landEvent.speed = impact;
      this.landEvent.surface = c.groundSurfaceName;
      if (impact > MOVE.stumble.landSpeed) {
        this._beginStumble((impact - MOVE.stumble.landSpeed) / 6);
      }
    }

    // Legacy gait accumulator, kept so anything still reading `stepPhase` works;
    // the real animation phase lives in the animator and is distance-driven too.
    const dx = this.position.x - this.prevPosition.x;
    const dz = this.position.z - this.prevPosition.z;
    const moved = Math.hypot(dx, dz);
    const stride = STANCE[this.stance].strideLength * (this.sprinting ? 1.4 : 1);
    this._bobPhase += (moved / stride) * Math.PI;
    if (this._bobPhase > Math.PI * 4) this._bobPhase -= Math.PI * 4;
    void h;
  }

  /* ==================================================================== */
  /* state                                                                */
  /* ==================================================================== */

  _resolveState() {
    if (this.mantleMotion.active) return;
    let next;
    if (this.driving) next = 'drive';
    else if (this.swimming) next = 'swim';
    else if (this.stumbleTime > 0) next = 'stumble';
    else if (!this.grounded) next = this.velocity.y > 0.35 ? 'jump' : 'fall';
    else if (this._stopTime > 0 && this.horizontalSpeed > 0.6) next = 'stop';
    else if (this.stance === 'crouch') next = 'crouch';
    else if (this.horizontalSpeed < 0.25) next = this.turning > 0.3 ? 'turn' : 'idle';
    else if (this.sprinting && this.horizontalSpeed > MOVE.jogSpeed * 1.05) next = 'sprint';
    else if (this.horizontalSpeed > MOVE.walkSpeed * 1.18) next = 'jog';
    else next = 'walk';
    this._setState(next);
  }

  _setState(next) {
    if (next === this.state) return;
    this.prevState = this.state;
    this.state = next;
    this.stateTime = 0;
  }

  _publish() {
    const c = this.character;
    if (!this.driving) this.position.set(c.position.x, c.position.y, c.position.z);
    const v = this.velocity;
    this.speed = Math.hypot(v.x, v.y, v.z);
    this.horizontalSpeed = Math.hypot(v.x, v.z);
  }

  /**
   * Interpolated feet position for rendering.
   *
   * ON FOOT this is the standard fixed-step interpolation: `position` and
   * `prevPosition` are one FIXED STEP apart (written by `step`), and `alpha` is
   * how far through the next step the frame falls. Correct.
   *
   * IN A CAR IT IS NOT, and applying it there was a second, independent source
   * of the driver-swims-in-his-seat beat. `setSeatTransform` is called once per
   * RENDERED FRAME from `VehicleHandler`, so the pair it leaves behind is a
   * frame apart, not a step — and `alpha` is a fraction of a step. Interpolating
   * between them by it draws the body somewhere between where he sat LAST frame
   * and where he sits now, for no reason and by a fraction that jumps around
   * with the step cadence. At dt = 1.5 fixed steps alpha alternates 0.5 / 1.0,
   * so the body was drawn half a frame of travel behind the seat on every other
   * frame. What the handler writes is already the final drawn pose for this
   * frame — composed against the car's own drawn transform, see
   * `vehicle.js#_drawnPose` — so the only right thing to do with it is use it.
   *
   * `driving` covers the whole enter/jack/in/drive/out sequence, i.e. exactly
   * the window in which the handler owns the transform, which is the window in
   * which the pair is frame-spaced.
   *
   * MEASURED with `camlagtest`'s check 3 (the drawn body in the DRAWN car's
   * frame, phase-locked by cadence): this half is worth 0.0938 m at 54 km/h and
   * 0.1875 m at 108 km/h on its own — half a frame of travel at each speed, and
   * MORE than the physics-pose half it was hiding behind. `--control=seatlerp`
   * puts it back.
   */
  sampleRender(alpha) {
    if (this.driving && this.debugSeatNoLerp !== false) {
      this.renderPosition.copy(this.position);
      return this.renderPosition;
    }
    this.renderPosition.lerpVectors(this.prevPosition, this.position, clamp01(alpha));
    return this.renderPosition;
  }

  /* ==================================================================== */
  /* external control                                                     */
  /* ==================================================================== */

  /** Take the capsule out of the world (riding in a vehicle). */
  setDriving(on, seatPos, seatYaw) {
    this.driving = !!on;
    if (this.character) this.character.enabled = !on;
    if (on) {
      this.velocity.set(0, 0, 0);
      this.sprinting = false;
      this.swimming = false;
      this.stance = this.stanceWant = 'stand';
      if (seatPos) {
        this.position.copy(seatPos);
        this.prevPosition.copy(seatPos);
        this.renderPosition.copy(seatPos);
      }
      if (seatYaw !== undefined) this.faceYaw = seatYaw;
      this._setState('drive');
    } else {
      this._setState('idle');
    }
  }

  /**
   * While the vehicle handler owns the actor it writes the transform straight
   * in. Velocity is derived from the delta so the animator still sees a speed
   * during the walk-to-the-door part of the sequence.
   */
  setSeatTransform(pos, yaw) {
    const dt = this.ctx.time.dt;
    this.prevPosition.copy(this.position);
    if (dt > 1e-4) {
      this.velocity.set(
        (pos.x - this.position.x) / dt, 0, (pos.z - this.position.z) / dt
      );
      this.horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
      this.speed = this.horizontalSpeed;
    }
    this.position.copy(pos);
    this.faceYaw = yaw;
    if (this.character) this.character.setPosition(pos.x, pos.y, pos.z);
  }

  teleport(x, y, z, yaw) {
    if (!this.character) return;
    this.mantleMotion.end();
    this.sprinting = false;
    this.swimming = false;
    this.submerged = false;
    this.drowning = false;
    this.breath = 1;
    this.waterDepth = 0;
    this.waterLevel = -Infinity;
    this._waterTimer = 0;
    this.waterEvent.pending = false;
    this.melee = false;
    this.driving = false;
    this.character.enabled = true;
    this.stance = this.stanceWant = 'stand';
    this.character.height = STANCE.stand.height;
    this.character.stepHeight = STANCE.stand.stepHeight;
    this.character.teleport(x, y, z);
    this.velocity.set(0, 0, 0);
    this.position.set(this.character.position.x, this.character.position.y, this.character.position.z);
    this.prevPosition.copy(this.position);
    this.renderPosition.copy(this.position);
    this.grounded = this.character.grounded;
    this.wasGrounded = this.grounded;
    // A teleport re-seats the support datum: the ground he was standing on
    // before is now irrelevant and must not be lent to the next ledge probe.
    this.supportY = this.position.y;
    this.crouchBlend = 0;
    this.stumbleTime = 0;
    this._stopTime = 0;
    this._jumpBuffer = 0;
    this._bobPhase = 0;
    if (yaw !== undefined) {
      this.faceYaw = yaw;
      this.moveYaw = yaw;
    }
    this.landEvent.pending = false;
    this._setState('idle');
  }

  get stepPhase() {
    return this._bobPhase;
  }
}
