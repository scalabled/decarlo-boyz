/**
 * PLAYER — the third-person DeCarlo brother: body, locomotion, camera rig,
 * vehicles, health and armour.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT LIVES HERE
 *   movement.js       the locomotion state machine (120 Hz, fully interruptible)
 *   camera.js         THE CAMERA RIG — the third-person boom AND the vehicle
 *                     chase camera. This subsystem owns the camera for the
 *                     whole game.
 *   character/        the procedural human: skeleton, swept-tube body, eight
 *                     procedural materials, three brother skins
 *   anim/             analytic IK + the procedural animator (gait, foot IK,
 *                     aim counter-rotation, seated driving pose)
 *   vehicle.js        enter / carjack / drive / exit
 *   melee.js          the swing's contact resolution against `peds`
 *   mantle.js         ledge detection + the rooted climb
 *   health.js         health, armour, regen, suppression, damage direction
 *   brothers.js       Carson / Aidan / Dylan stats and palettes (DESIGN.md)
 *   tuning.js         every number, with what it was calibrated against
 *
 * Collision is *never* computed here — everything goes through
 * `physics.createCharacter()` capsule sweeps.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PUBLIC API — `const p = ctx.get('player')`
 * ────────────────────────────────────────────────────────────────────────────
 * TRANSFORM
 *   p.position        Vector3, FEET (bottom of the capsule), interpolated
 *   p.headPosition    Vector3, roughly the eyes — for LOS tests
 *   p.eyePosition     Vector3, the composed CAMERA position (legacy name)
 *   p.velocity  p.forward  p.speed  p.horizontalSpeed
 *   p.yaw             body facing (radians). p.cameraYaw is the camera's.
 *   p.pitch           camera pitch
 *   p.character       the physics CharacterController (read-only)
 *   p.hitbox          physics collider on LAYER.PLAYER
 *
 * STATE
 *   p.state    'idle'|'walk'|'jog'|'sprint'|'stop'|'turn'|'crouch'|'jump'|
 *              'fall'|'stumble'|'mantle'|'vault'|'swim'|'drive'
 *   p.stance   'stand'|'crouch'   p.sprinting  p.grounded  p.airborne
 *   p.mantling  p.swimming  p.inVehicle  p.vehicle
 *
 * BROTHERS
 *   p.brother                 the active spec (see brothers.js)
 *   p.setBrother('aidan')     rebuilds the body, restats health/armour/speed
 *
 * AIM
 *   p.adsRequested  p.adsProgress  p.setAdsProgress(v)
 *   p.swapShoulder()          over-the-shoulder side (middle mouse — Q is now
 *                             `prevWeapon` and the two were fighting)
 *
 * CAMERA (for `weapons`, `fx`, `ai`, `ui`)
 *   p.addRecoil(pitch,yaw,roll,punch)  p.addKick(...)  p.addTrauma(a)
 *   p.viewKick   p.cameraRig   p.weaponHand   (the right-hand bone)
 *   p.cycleCamera(dir?)       V — chase / close / far / first person (bonnet
 *                             in a vehicle). Returns the new mode.
 *   p.cameraMode  p.cameraModeName  p.setCameraMode(id)
 *
 * MELEE
 *   p.swinging  p.meleePhase (-1 wound up .. +1 followed through)
 *   p.meleeSide  p.meleeStats
 *
 * WATER
 *   p.swimming  p.submerged  p.breath (1..0)  p.drowning
 *
 * HEALTH
 *   p.health p.maxHealth p.armour p.maxArmour p.healthFraction p.dead
 *   p.applyDamage(amount, fromVector3, opts)  p.heal(a)  p.addArmour(a)
 *   `p.health` is the Health OBJECT; the number is `p.health.value` (or `.hp`).
 *
 * CONTROL
 *   p.setControlEnabled(bool)   p.teleport(pos, rotOrYaw)   p.respawn(i)
 *   p.debugState(name)
 *
 * EVENTS EMITTED
 *   player:state · player:land · player:footstep · damage:taken ·
 *   vehicle:enter · vehicle:exit · vehicle:jack · player:health · player:jump ·
 *   player:mantle · player:death · player:wasted · player:brother ·
 *   player:camera { index, mode, name, inVehicle } ·
 *   player:melee  { side, weapon, duration, position } ·
 *   player:water  { entering, speed, depth, position }
 *   damage:dealt  (melee contact against a ped — see melee.js)
 *
 * The last four are not in ARCHITECTURE.md's table. `ui` can toast the camera
 * name and draw a breath meter off `getHudState().breath`; `audio`/`fx` want
 * the swing and the splash.
 */

import * as THREE from 'three';
import { Movement } from './movement.js';
import { CameraRig } from './camera.js';
import { Health } from './health.js';
import { LowHealthPass } from './lowhealth.js';
import { CharacterRig } from './character/index.js';
import { Animator } from './anim/animator.js';
import { VehicleHandler } from './vehicle.js';
import { MeleeReach } from './melee.js';
import { brother, BROTHER_IDS } from './brothers.js';
import { STANCE, MOVE, CAMERA, GAIT, HEALTH, FOOTSTEP, JUMP_SPEED, VIEW_NAMES } from './tuning.js';
import { clamp, clamp01, lerp, approach, smoothstep, angleDelta, DEG } from './springs.js';

/** Used only if `weapons` ever supplies a swing with no spec — never allocate
 *  a replacement inside the per-frame path. */
const FALLBACK_SWING = { wind: 0.12, strike: 0.14, recover: 0.2, contact: 0.5 };

/**
 * The player's share of a blast that everything else in the radius takes in
 * full. See `_onExplosion`.
 */
const BLAST_PLAYER_SHARE = 0.55;

export class PlayerSystem {
  static id = 'player';
  static deps = ['physics', 'world', 'render'];

  constructor() {
    /** Lets `ai` / `physics` recognise the local player from an owner pointer. */
    this.isPlayer = true;
    /**
     * The game is third-person. Published so `weapons` can pick the right rig:
     * a first-person viewmodel drawn into `ctx.viewScene` is wrong for every
     * frame of this game. Also carried on every `player:state` payload.
     */
    this.thirdPerson = true;
    this.firstPerson = false;
    this.movement = null;
    this.rig = null;
    this.character = null;
    this.animator = null;
    this.vehicles = null;
    this.health = null;
    this.lowHealthPass = null;
    this.hitbox = null;

    this.controlEnabled = true;
    /**
     * THE WEAPON POSE, 0..1. How high the weapon rides in the hands. Drives the
     * animator's upper body and nothing else. `weapons` writes it every frame
     * and it deliberately has a FLOOR while a firearm is drawn, because the
     * animator's only pose that puts a weapon in front of the chest is this one.
     */
    this.adsAmount = 0;
    /**
     * THE AIM STATE, 0..1. Whether the player is actually aiming down sights.
     * Everything about gameplay reads this and never `adsAmount`.
     *
     * These were one field, and that is what broke Shift. `weapons` had to push
     * a carry pose through the same channel, `movement.aiming` fired at any
     * value over 0.35, and `_updateSprint` refuses to sprint while aiming — so
     * carrying a two-handed weapon silently disabled sprint AND clamped every
     * gait to `MOVE.aimSpeed` (1.9 m/s), for ten of the sixteen weapons in the
     * game. The symptom was shift-to-run working or not working depending on
     * which gun happened to be in the character's hands.
     *
     * `weapons` has since capped its carry pose under 0.35 from its side, and
     * its own note asks `player` for a separate channel so that cap stops being
     * load-bearing. This is that channel. Splitting the two here means no value
     * any other subsystem pushes into the pose can ever cost the player his
     * sprint again, whatever that subsystem tunes its pose to.
     */
    this.aimAmount = 0;
    /** The player's own aim intent, integrated. Never written from outside. */
    this._aimRamp = 0;
    this._adsExternal = false;
    this._adsExternalAge = 0;
    this.adsRequested = false;
    /**
     * Is the thing in the character's hands a melee weapon? Sampled once a
     * frame in `_updateAds` so the aim pose, the aim state and the guard all
     * answer the question the same way. See `aimPose`.
     */
    this.meleeEquipped = false;
    this.brother = brother('carson');

    this._lookFrame = -1;
    this._shotHide = false;
    this._suppressCamera = false;
    this._adsLock = null;
    this._fade = 1;
    this._promptShown = null;

    /* ---- melee ---- */
    this._meleeActive = false;
    this._meleeSide = 1;
    this._meleeHold = 0;
    /** 0..1 through the swing, 0 when idle. Read by the animator. */
    this.meleePhase = 0;
    this.meleeSide = 1;
    this.meleeWeight = 0;
    /**
     * The guard, mirrored off `MeleeReach.blocking` once per frame so that the
     * animator, the movement machine and `ui` all read ONE value that was
     * sampled at one instant. Never written from outside.
     */
    this.blocking = false;

    /* ---- negative controls -----------------------------------------------
     * Each of these turns exactly ONE fix back off, at
     * runtime, so `src/player/blockblastprobe.mjs` can watch its own checks go
     * red and no other's. Same shape as `weapons.debugIgnorePause` and
     * `buildings.collisionOpts.volumeShell`; nothing but the probe reads them.
     */
    /** false = the pre-fix blast curve: no `* 0.55`, and `(1 - d/r) ^ 1.6`. */
    this.debugBlastShare = true;
    /** false = charge the man in the driver's seat as well as his car. */
    this.debugBlastInVehicle = true;
    /** false = a melee weapon may drive the ADS zoom and the aim pose again. */
    this.debugMeleeAimGate = true;

    /* ---- water / death ---- */
    this._drownTick = 0;
    this._deadTime = 0;
    this._wasDead = false;

    // preallocated payloads
    this._statePayload = {
      stance: 'stand', sprinting: false, aiming: false, inVehicle: false,
      nitro: 100, nitroFraction: 1, nitroOn: false,
      state: 'idle', grounded: true, airborne: false, mantling: false,
      speed: 0, health: 100, healthFraction: 1, armour: 0, crouched: false,
      sliding: false, ads: false, blocking: false, lean: 0,
      thirdPerson: true, firstPerson: false,
    };
    this._landPayload = { velocity: 0, surface: 'concrete', position: new THREE.Vector3() };
    this._stepPayload = {
      position: new THREE.Vector3(), surface: 'concrete', running: false,
      left: false, speed: 0, stance: 'stand',
    };
    this._mantlePayload = { kind: 'none', height: 0 };
    this._jumpPayload = { position: new THREE.Vector3() };
    this._brotherPayload = { id: 'carson', name: 'Carson' };
    this._cameraPayload = { index: 0, mode: 'chase', name: 'CHASE', inVehicle: false };
    this._meleePayload = {
      side: 1, weapon: null, duration: 0, position: new THREE.Vector3(),
    };
    this._waterPayload = {
      entering: true, speed: 0, depth: 0, position: new THREE.Vector3(),
    };
    this._deathPayload = { position: new THREE.Vector3(), cause: 'damage' };
    this._hudState = {
      health: 100, maxHealth: 100, armour: 0, maxArmour: 0, regen: false, dead: false,
      move: 0, sprint: false, crouch: false, ads: false, airborne: false,
      suppression: 0, position: null, inVehicle: false, brother: 'carson',
      swimming: false, submerged: false, breath: 1, drowning: false,
      camera: 'chase', cameraName: 'CHASE', melee: false, blocking: false,
      nitro: 100, nitroFraction: 1, nitroOn: false,
    };
    /** The animator's input, mutated in place every frame. */
    this._pose = {
      x: 0, y: 0, z: 0, faceYaw: 0, aimYaw: 0, aimPitch: 0,
      speed: 0, grounded: true, crouch: false, aim: 0, swim: false, driving: false,
      stumble: 0, turning: 0, strafe: 0, forwardSign: 1, verticalVel: 0,
      landImpulse: 0, steer: 0, lateral: 0, surface: 'concrete', groundDist: 0,
      swing: 0, swingSide: 1, swingWeight: 0, submerged: 0, dead: 0,
      /** 0..1 guard weight — the fists-up pose. See `_poseGuard`. */
      guard: 0,
      /** This brother's top speed, so the animator can normalise per brother. */
      topSpeed: MOVE.sprintSpeed, sprinting: false,
    };

    this._tmp = new THREE.Vector3();
    this._head = new THREE.Vector3();
    this._prev = {
      state: '', stance: '', sprinting: false, grounded: true,
      ads: false, mantling: false, inVehicle: false, blocking: false,
    };
    this._offEvents = [];
  }

  /* ==================================================================== */
  /* init                                                                 */
  /* ==================================================================== */

  async init(ctx) {
    this.ctx = ctx;
    this.physics = ctx.get('physics');
    this.rng = ctx.rng.fork();

    // Which brother? URL first (dev), then whatever `game` says later.
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    const wanted = params?.get('boy');
    this.brother = brother(BROTHER_IDS.includes(wanted) ? wanted : 'carson');

    this.movement = new Movement(ctx, this);
    this.rig = new CameraRig(ctx);
    this.health = new Health(ctx, this.rig);

    // ---- body ------------------------------------------------------------
    this.character = new CharacterRig(ctx);
    this.character.setBrother(this.brother, ctx.scene);
    this.animator = new Animator(ctx, this.character);
    this.vehicles = new VehicleHandler(ctx, this);
    this.meleeReach = new MeleeReach(ctx, this);
    this._applyBrotherStats();

    // ---- spawn -----------------------------------------------------------
    const spawn = this._resolveSpawn();
    this.movement.init(this.physics, spawn.feet);
    this.movement.faceYaw = spawn.yaw;
    this.movement.moveYaw = spawn.yaw;
    this.movement.bodyScale = this.brother.build.scale;
    this.rig.reset(this.movement.anchorHeight, spawn.feet, spawn.yaw);
    this.rig.update(1 / 60, this.movement, this.health);
    this.rig.applyTo(ctx.camera);
    this._buildPose(1 / 60);
    this.animator.update(1 / 60, this._pose);

    // ---- hitbox ----------------------------------------------------------
    this.hitbox = this.physics.addCollider({
      shape: 'capsule',
      layer: this.physics.LAYER.PLAYER,
      surface: 'flesh',
      owner: this,
      part: 'torso',
      radius: 0.3,
    });
    this._syncHitbox();

    // ---- low-health treatment -------------------------------------------
    const render = ctx.peek('render');
    if (render?.registerPass) {
      this.lowHealthPass = new LowHealthPass();
      this._unregisterPass = render.registerPass(this.lowHealthPass);
    }

    // ---- events ----------------------------------------------------------
    const on = (type, fn) => this._offEvents.push(ctx.events.on(type, fn));
    on('damage:dealt', (e) => this._onDamageDealt(e));
    on('explosion', (e) => this._onExplosion(e));
    on('bullet:impact', (e) => this._onBulletImpact(e));
    on('shot:applied', (e) => this._onShotApplied(e));

    const tri = this.character.geometry?.index?.count / 3 | 0;
    console.info(
      `[player] ${this.brother.name} · ${tri} tris / ${this.character.boneList.length} bones · ` +
      `spawn ${spawn.feet.x.toFixed(1)}, ${spawn.feet.y.toFixed(2)}, ${spawn.feet.z.toFixed(1)} · ` +
      `walk ${MOVE.walkSpeed} jog ${MOVE.jogSpeed} sprint ${this.brother.runSpeed} m/s · ` +
      `hp ${this.brother.health}/armour ${this.brother.armour} · jump ${JUMP_SPEED.toFixed(2)} m/s`
    );
  }

  /**
   * Where the player starts, and it must be ON the pavement.
   *
   * This used to take a single physics down-ray from 6 m above the spawn and
   * believe whatever it hit. MEASURED, on a spawn that shipped: the ray settled
   * the capsule at y = -0.423 while `world.walkableHeightAt` at the same x/z
   * was **1.649** — two metres of solid ground overhead, `grounded === true`,
   * and the player buried to the chest before he had pressed a key. It varied
   * by site, so it looked intermittent and survived several passes.
   *
   * Two independent authorities describe the ground here and they can disagree:
   * `world.walkableHeightAt` is the AUTHORED walkable surface (see the note in
   * ARCHITECTURE about it versus `heightAt`), and the physics ray reports the
   * first collision triangle it happens to meet — which near a kerb, a bridge
   * soffit or a road corridor's underside can easily be below the pavement the
   * player is supposed to be standing on.
   *
   * So: take the HIGHER of the two, which is the surface you stand on rather
   * than the one you would fall to, and refuse a site where they disagree so
   * badly that neither can be trusted. Trying the next spawn is free; shipping a
   * player under the map is not.
   */
  _resolveSpawn() {
    const world = this.ctx.peek('world');
    const out = { feet: new THREE.Vector3(0, 0.2, 0), yaw: 0 };
    /** Disagreement beyond this means the site is not understood at all. */
    const MAX_DISAGREE = 1.2;

    let best = null;
    for (let i = 0; i < 8; i++) {
      const sp = world?.spawn?.(i);
      if (!sp?.position) break;
      const x = sp.position.x, z = sp.position.z;
      const wy = world?.walkableHeightAt?.(x, z);
      // Start the ray well clear of anything the spawn record may be embedded
      // in, and above the authored surface as well as the recorded one.
      const from = Math.max(sp.position.y, Number.isFinite(wy) ? wy : -Infinity) + 8;
      const gy = this.physics.groundHeight(x, z, from);

      const hasW = Number.isFinite(wy);
      const hasG = Number.isFinite(gy);
      if (!hasW && !hasG) continue;
      const y = hasW && hasG ? Math.max(wy, gy) : (hasW ? wy : gy);
      const disagree = hasW && hasG ? Math.abs(wy - gy) : 0;

      const cand = { x, y, z, yaw: sp.yaw ?? 0, disagree, i };
      if (!best || cand.disagree < best.disagree) best = cand;
      if (disagree <= MAX_DISAGREE) break;
    }

    if (best) {
      out.feet.set(best.x, best.y + 0.03, best.z);
      out.yaw = best.yaw;
      if (best.disagree > MAX_DISAGREE) {
        console.warn(
          `[player] every spawn candidate is ambiguous — using #${best.i}, where the authored ` +
          `walkable surface and the collision ray differ by ${best.disagree.toFixed(2)} m. ` +
          `Standing on the higher of the two.`
        );
      }
    }
    return out;
  }

  /* ==================================================================== */
  /* brothers                                                             */
  /* ==================================================================== */

  setBrother(id) {
    const spec = brother(id);
    if (spec.id === this.brother.id) return spec;
    this.brother = spec;
    this.character.setBrother(spec, this.ctx.scene);
    this.animator = new Animator(this.ctx, this.character);
    this._applyBrotherStats();
    this._brotherPayload.id = spec.id;
    this._brotherPayload.name = spec.name;
    this.ctx.events.emit('player:brother', this._brotherPayload);
    return spec;
  }

  _applyBrotherStats() {
    const b = this.brother;
    this.health.max = b.health;
    this.health.maxArmour = b.armour;
    this.health.value = Math.min(this.health.value, b.health) || b.health;
    if (this.health.armour === 0) this.health.armour = b.armour;
    this.movement.sprintSpeed = b.runSpeed;
    this.movement.bodyScale = b.build.scale;
  }

  /* ==================================================================== */
  /* look                                                                 */
  /* ==================================================================== */

  /**
   * Mouse/stick look is consumed once per rendered frame and pushed straight
   * into the camera rig, which owns yaw and pitch in third person. Movement
   * reads the rig's *target* yaw, not its smoothed value, so the direction you
   * run is instant even though the camera itself lags.
   */
  _consumeLook(dt) {
    const frame = this.ctx.time.frame;
    if (frame === this._lookFrame) return;
    this._lookFrame = frame;
    if (!this.controlEnabled) return;
    const input = this.ctx.input;
    const cfg = this.ctx.config;
    // ADS sensitivity follows the aim, not the carry pose: merely holding a
    // rifle must not slow the look.
    const sens = lerp(1, cfg.adsSensScale, clamp01(this.aimAmount)) * CAMERA.orbit.sens;

    let dYaw = -input.look.x * sens;
    let dPitch = -input.look.y * sens;
    const stick = input.stick;
    if (stick.lookX || stick.lookY) {
      const rate = 2.6 * sens;
      dYaw -= stick.lookX * rate * dt;
      dPitch -= stick.lookY * rate * dt;
    }
    if (this.movement.mantleMotion.active) {
      dYaw *= 0.6;
      dPitch *= 0.6;
    }
    this.rig.addLook(dYaw, dPitch);
  }

  /* ==================================================================== */
  /* frame                                                                */
  /* ==================================================================== */

  fixedUpdate(h, ctx) {
    if (!this.movement) return;
    this._consumeLook(ctx.time.dt > 1e-5 ? ctx.time.dt : h);
    this.movement.camYaw = this.rig.vehicle ? this.rig.chaseYaw : this.rig.yawTarget;
    this.movement.camPitch = this.rig.pitch;
    this.movement.latchInput(ctx.time.frame);
    if (!this.controlEnabled) return;
    // The aim STATE, not the weapon pose — see the fields in the constructor.
    this.movement.adsAmount = this.aimAmount;
    this.movement.aiming =
      this.aimAmount > 0.35 && !this.vehicles.driving && !this.movement.melee;
    // The guard costs the sprint and most of the speed, and `targetSpeed` reads
    // it from inside `step` — so it has to be current on the FIXED step too,
    // not only on the frame `_updateMelee` ran.
    this.movement.blocking = this.blocking;
    this.movement.step(h);
  }

  update(dt, ctx) {
    if (!this.movement) return;
    this._consumeLook(dt);
    this.movement.camYaw = this.rig.vehicle ? this.rig.chaseYaw : this.rig.yawTarget;
    this.movement.latchInput(ctx.time.frame);

    this._updateMelee(dt);
    this._updateAds(dt);
    this._updateView();
    this._updateVehicle(dt);
    this._drainMovementEvents();
    this._updateWater(dt);
    this.health.update(dt);
    this._updateDeath(dt);

    // NOTE the rig is NOT solved here — see `cameraUpdate` below. `_buildPose`
    // therefore reads the orbit yaw as it stood at the end of the previous
    // frame, which is deliberate: the camera is solved last, after the
    // character has been posed, and that yaw is already a smoothed follower of
    // `rig.yawTarget`, itself updated from the mouse at the top of THIS
    // function.
    this._buildPose(dt);
    this.animator.update(dt, this._pose);
    this._drainFootstep();
    this._updateVisibility(dt);

    this.lowHealthPass?.sync(this.health);
    this._syncHitbox();
    this._publishState();
  }

  /**
   * THE CAMERA IS PLACED AFTER EVERYTHING THAT MOVES WHAT IT FRAMES.
   *
   * The registry topo-sorts `player` immediately BEFORE `vehicles`, and the
   * chase camera's subject — the car's RENDER transform — is written by
   * `v.syncTransforms()` inside `vehicles.update()`. Solve the rig from
   * `update()` and you are reading that transform one whole frame late: v*dt,
   * MEASURED at 0.245 m at 54 km/h and 0.373 m at 108 km/h at dt = 1.5/120 s,
   * and growing as the frame rate drops. That is the "the car slides out from
   * under the camera" artefact, worst in exactly the shots — fast, busy — where
   * it is most visible.
   *
   * CORRECTED, because this comment used to claim that error had SHIPPED and
   * that moving the apply here fixed it. It had not and it did not. Until
   * recently `_solveChase` never reached the render transform at all: it fell
   * through the duck-typed lookup to `v.position`, which physics finalises
   * before any `update()` runs, so where the apply happened made no difference
   * whatsoever. MEASURED, same drive, both call sites, camera reading
   * `v.position`: -8.35709 / -10.18376 m either way, identical to every digit.
   *
   * So this phase is the PRECONDITION for reading the drawn pose (see the note
   * at camera.js's vehicle lookup), not a fix on its own. The two land
   * together or not at all — the pose-source fix WITHOUT this phase is the
   * worst of the four builds.
   *
   * `cameraUpdate` is an engine PHASE, not a place in a dependency list: it runs
   * after every subsystem's `update()` and before every subsystem's
   * `lateUpdate()`, so this is correct with respect to everything that moves a
   * rendered transform, including subsystems that do not exist yet. It is NOT
   * free — four subsystems read the camera inside their own `update()` and now
   * see last frame's, which is measured and argued in src/core/engine.js.
   *
   * Gated by src/player/camlagtest.mjs, which asserts (1) that the framing
   * carries no physics-cadence beat and (2) that nothing moves the drawn car
   * after the camera is placed. Negative controls: `--control=source`,
   * `--control=order`, `--control=both`.
   */
  cameraUpdate(dt, ctx) {
    if (!this.movement) return;
    // Always solve — a shot that suppresses the camera still wants the boom
    // state live (see `debugPose`), it just does not want it written out.
    this.rig.update(dt, this.movement, this.health);
    if (this.controlEnabled && !this._suppressCamera) this.rig.applyTo(ctx.camera);
  }

  /* -------------------------------------------------------------------- */

  /**
   * THE USE KEY.
   *
   * This used to read `movement.cmd.usePressed`, and that is why F "worked"
   * only sometimes. `cmd` is latched once per RENDERED frame, but `Movement.step`
   * runs at 120 Hz and deliberately clears the one-shot edges on every fixed
   * step after the first — so at any frame rate that produces two or more fixed
   * steps per frame (i.e. anything at or below 60 fps, which is the normal
   * case) the edge was already consumed and zeroed by the time `update()` ran.
   * Measured: `tools/playprobe.mjs` reported "F enters the vehicle: still on
   * foot" on every run.
   *
   * `input.actionPressed` is the documented way to read an edge from `update()`,
   * so read it there and nowhere else.
   */
  _useEdge() {
    if (!this.controlEnabled) return false;
    const s = this.movement.scriptedInput;
    if (s) {
      // The harness sets a level; consume it here so it is an EDGE, or a
      // scripted F would enter and immediately exit again on the next frame.
      if (!s.use) return false;
      s.use = false;
      return true;
    }
    return this.ctx.input?.actionPressed?.('use') === true;
  }

  _updateVehicle(dt) {
    const v = this.vehicles;
    const m = this.movement;
    if (this.controlEnabled && !this.health.dead) {
      if (this._useEdge()) {
        if (v.phase === 'drive') v.tryExit(m);
        else if (!v.busy) v.tryEnter(m);
      }
    }
    v.update(dt, m);
    // `driving` on the movement machine means "something else owns this
    // transform" — true for the whole enter/exit sequence, not just the seat.
    m.driving = v.active;
    this.rig.setVehicle(v.seated ? v.vehicle : null);

    // Offer the enter prompt through `ui` when it exists.
    const ui = this.ctx.peek('ui');
    const want = v.prompt ? v.prompt.text : null;
    if (ui && want !== this._promptShown) {
      this._promptShown = want;
      if (want) ui.setPrompt?.(v.prompt);
      else ui.clearPrompt?.();
    }
  }

  /* ==================================================================== */
  /* water                                                                */
  /* ==================================================================== */

  /**
   * Drowning, and the splash.
   *
   * `movement` owns the buoyancy and the breath meter; health is owned here, so
   * this is where the air running out becomes damage. Carson's whole arc is on
   * the water and the rivers are a third of the map, so falling in has to be a
   * survivable event with a real clock on it, not an instant kill and not a
   * free swim.
   */
  _updateWater(dt) {
    const m = this.movement;
    if (m.waterEvent.pending) {
      m.waterEvent.pending = false;
      const w = this._waterPayload;
      w.entering = m.waterEvent.entering;
      w.speed = m.waterEvent.speed;
      w.depth = m.waterDepth;
      w.position.copy(m.position);
      if (w.entering) {
        // Hitting the river at speed is a jolt, and it kills your momentum —
        // which is also what stops a bridge dive from being a free reset.
        this.rig.addTrauma(clamp01(w.speed / 26) * 0.5);
        this.health.addSuppression(clamp01(w.speed / 30) * 0.3);
      }
      this.ctx.events.emit('player:water', w);
    }
    // Ticked, not continuous: a per-frame call would emit `damage:taken` sixty
    // times a second and shake the camera to pieces.
    if (m.drowning && !this.health.dead) {
      this._drownTick += dt;
      if (this._drownTick >= MOVE.swim.drownTick) {
        this.health.damage(
          MOVE.swim.drownDps * this._drownTick, null, { type: 'drown', quiet: true }
        );
        this._drownTick = 0;
        this.rig.addTrauma(0.12);
        if (this.health.dead) this._deathPayload.cause = 'drown';
      }
    } else {
      this._drownTick = 0;
    }
  }

  /* ==================================================================== */
  /* death                                                                */
  /* ==================================================================== */

  /**
   * WASTED. `health` raises `player:death`; `game` catches it, docks 10 % of
   * the cash and respawns at the last safehouse. What has to happen HERE is
   * that the body stops being a playable character the instant it dies —
   * otherwise the corpse keeps jogging under the WASTED card, which is exactly
   * what it did.
   */
  _updateDeath(dt) {
    const dead = this.health.dead;
    if (dead && !this._wasDead) {
      this._wasDead = true;
      this._deadTime = 0;
      const m = this.movement;
      // Out of the car first: a dead driver still steering is worse than the
      // corpse jogging.
      this.vehicles.abort(m);
      m.scriptedInput = null;
      m.sprinting = false;
      m.melee = false;
      m.cancelMantle();
      m.velocity.x *= 0.25;
      m.velocity.z *= 0.25;
      this.movement.controlEnabled = false;
      this.adsAmount = 0;
      this.aimAmount = 0;
      this._aimRamp = 0;
      this._adsExternal = false;
      this.rig.addTrauma(0.55);
      this._deathPayload.position.copy(this.headPosition);
      this.ctx.events.emit('player:wasted', this._deathPayload);
    } else if (!dead && this._wasDead) {
      // `game._respawn` heals and teleports; hand control back on the frame it
      // does, so a respawn is playable immediately.
      this._wasDead = false;
      this._deadTime = 0;
      this._deathPayload.cause = 'damage';
      this.movement.controlEnabled = this.controlEnabled;
      this.movement._cmdFrame = -1;
    }
    if (dead) this._deadTime += dt;
  }

  /** Fill the animator's request. Nothing here allocates. */
  _buildPose(dt) {
    const m = this.movement;
    const p = this._pose;
    const base = m.sampleRender(this.ctx.time.alpha);
    p.x = base.x; p.y = base.y; p.z = base.z;
    p.faceYaw = m.faceYaw;
    p.aimYaw = this.rig.vehicle ? m.faceYaw : this.rig.yaw;
    p.aimPitch = -this.rig.pitch;
    p.speed = m.horizontalSpeed;
    // Per-brother, from DESIGN.md via `brothers.js`: 6.4 / 6.9 / 7.9 m/s.
    p.topSpeed = m.sprintSpeed;
    p.sprinting = m.sprinting;
    p.grounded = m.grounded || m.driving;
    p.crouch = m.stance === 'crouch';
    p.aim = this.aimPose;
    p.swim = m.swimming;
    p.driving = this.vehicles.seated;
    p.stumble = m.stumble;
    p.turning = m.turning;
    p.verticalVel = m.velocity.y;
    p.surface = m.character?.groundSurfaceName ?? 'concrete';
    p.groundDist = m.character ? Math.min(1, m.character.groundDistance) : 1;
    p.steer = this.vehicles.steer;
    p.lateral = this.vehicles.lateral;
    p.swing = this.meleePhase;
    p.swingSide = this.meleeSide;
    p.swingWeight = this.meleeWeight;
    // Raw 0/1 — the animator owns the ramp, the same way it owns `aim`'s.
    p.guard = this.blocking ? 1 : 0;
    p.submerged = m.swimming ? clamp01((m.waterDepth - MOVE.swim.floatDepth) / 0.9) : 0;
    p.dead = this.health.dead ? 1 : 0;

    // Which way is the body travelling relative to its facing?
    const fx = -Math.sin(m.faceYaw), fz = -Math.cos(m.faceYaw);
    const rx = Math.cos(m.faceYaw), rz = -Math.sin(m.faceYaw);
    const sp = m.horizontalSpeed;
    if (sp > 0.2) {
      p.forwardSign = clamp((m.velocity.x * fx + m.velocity.z * fz) / sp, -1, 1);
      p.strafe = clamp((m.velocity.x * rx + m.velocity.z * rz) / sp, -1, 1);
    } else {
      p.forwardSign = approach(p.forwardSign, 1, 0.2, dt);
      p.strafe = approach(p.strafe, 0, 0.2, dt);
    }
    // landImpulse is a one-shot, set by _drainMovementEvents and cleared here.
    // (read by the animator before this line runs next frame)
  }

  _drainFootstep() {
    const e = this.animator.footEvent;
    if (!e.pending) return;
    e.pending = false;
    const out = this._stepPayload;
    out.position.set(e.x, e.y, e.z);
    out.surface = e.surface;
    out.running = this.movement.horizontalSpeed >= FOOTSTEP.runSpeed;
    out.left = e.left;
    out.speed = this.movement.horizontalSpeed;
    out.stance = this.movement.stance;
    this.rig.onFootstep(out.running, out.stance);
    this.ctx.events.emit('player:footstep', out);
  }

  /**
   * Fade the body out when the camera has been pushed inside it, and hide it
   * outright while a scripted shot owns the camera (the harness parks the
   * camera exactly on the capsule, so otherwise every shot in the game would
   * be taken from inside a skull).
   */
  _updateVisibility(dt) {
    const m = this.movement;
    this._head.copy(m.renderPosition);
    this._head.y += m.anchorHeight + 0.16;
    if (this._shotHide) {
      this.character.setOpacity(0);
      return;
    }
    const cam = this.controlEnabled && !this._suppressCamera
      ? this.rig.position : this.ctx.camera.position;
    const d = cam.distanceTo(this._head);
    const C = CAMERA.collide;
    const target = clamp01((d - C.fadeEnd) / (C.fadeStart - C.fadeEnd));
    this._fade = approach(this._fade ?? 1, target, 0.05, dt);
    this.character.setOpacity(this._fade);
  }

  _syncHitbox() {
    if (!this.hitbox) return;
    const m = this.movement;
    const p = m.renderPosition;
    const r = 0.3;
    const h = STANCE[m.stance].height * m.bodyScale;
    this.hitbox.setSegment(p.x, p.y + r, p.z, p.x, p.y + Math.max(r, h - r), p.z, r);
    this.hitbox.enabled = !this.health.dead && !m.driving;
  }

  /**
   * RMB IS TWO BUTTONS, AND WHICH ONE IT IS DEPENDS ON WHAT IS IN YOUR HANDS.
   *
   * With a gun it is ADS. With a melee weapon it is the GUARD — the same
   * button, and `MeleeReach` already reads it that way. What it must NOT do
   * with a pipe in your hands is
   * bring the character up into a two-handed shoulder aim on an empty hand and
   * pull the camera to the ADS FOV. MEASURED with fists, RMB held: camera FOV
   * 62.0 -> 47.1, `animator.aimSm` 1.00 (the aim pose fully on),
   * `movement.aiming` true.
   *
   * TWO SOURCES HAD TO BE CLOSED, not one. The obvious one is `adsRequested`
   * below. The other is `weapons.adsProgress`: the rig's `adsT` follows
   * `st.ads`, and `weapons/index.js:1216` reads `st.ads = input.ads || ...`
   * straight off the raw button with no weapon test — so gating only
   * `adsRequested` leaves `rigAim` at 1 and NOTHING visible changes. The term
   * is therefore dropped HERE instead, which is
   * enough for everything `player` owns (camera FOV, the animator's aim pose,
   * `movement.aiming`, the published `player:state.aiming`).
   *
   * What it is NOT enough for, and what `src/weapons/` still has to fix:
   * `render._readAds` reads `weapons.adsProgress` directly for the ADS
   * depth-of-field blend, so a guard still racks focus. The one-line fix there
   * is to append `&& !def.melee` to the `st.ads` assignment.
   */
  _updateAds(dt) {
    const input = this.ctx.input;
    const m = this.movement;
    const weapons = this.ctx.peek('weapons');
    const melee = weapons?.current?.melee === true && this.debugMeleeAimGate !== false;
    this.adsRequested =
      this.controlEnabled && input.ads && !melee && !m.mantleMotion.active &&
      !m.swimming && !this.vehicles.busy && !this.health.dead;

    if (this._adsExternal) {
      this._adsExternalAge += dt;
      if (this._adsExternalAge > 0.6) this._adsExternal = false;
    }
    if (this._adsLock !== null) {
      // Held by the shot harness / dev states so a long settle cannot bleed it off.
      this.adsAmount = this._adsLock;
      this.adsRequested = this._adsLock > 0.5;
    } else if (!this._adsExternal) {
      this.adsAmount = approach(this.adsAmount, this.adsRequested ? 1 : 0, 0.085, dt);
    }
    /* THE THIRD SOURCE, and the one that actually held the pose up.
     *
     * `adsAmount` is the POSE channel and `weapons.lateUpdate` writes it
     * directly through `setAdsProgress(Math.max(rig.adsT, carry))` — which for
     * a melee weapon is `rig.adsT` and nothing else, and `rig.adsT` follows the
     * raw button. `_buildPose` feeds it to the animator as `aim`, so gating
     * `adsRequested` and `rigAim` alone left the two-handed shoulder aim fully
     * on with empty hands: MEASURED after those two fixes, `animator.aimSm`
     * still 1.00 with fists and RMB held, camera correct, pose wrong.
     *
     * It is closed at the CONSUMER (`aimPose`) rather than by overwriting the
     * field, because `adsAmount` is `weapons`' to write and `weapons` writes it
     * in `lateUpdate` — i.e. after this runs. Zeroing it here would leave it
     * flipping 0 -> 1 inside every frame, so a reader would get a different
     * answer depending on where in the frame it asked. Instead the raw channel
     * keeps saying exactly what `weapons` pushed, and `player` interprets it
     * once, in one place, for the animator and for its own public getter.
     */
    this.meleeEquipped = melee;

    /* ---- the aim STATE, which is not the pose --------------------------
     * Two independent sources, both of them genuine aim and neither of them a
     * carry pose:
     *   - the player's own button, integrated here so it survives a frame in
     *     which `weapons` happens to push a pose;
     *   - `weapons.adsProgress`, which is the weapon rig's own `adsT` and is
     *     documented as the real ADS blend (`render` uses it for the DoF).
     *     The rig folds the carry floor in with a `Math.max` when it writes the
     *     POSE, so `adsProgress` on its own is clean.
     * Reading it at runtime through `peek` rather than importing anything is
     * the cross-subsystem rule; a build with no `weapons` system just gets 0.
     *
     * ...with the one exception above: a melee weapon has no sights, so its
     * `adsT` is not an aim however high it climbs.
     */
    this._aimRamp = approach(this._aimRamp, this.adsRequested ? 1 : 0, 0.085, dt);
    const rigAim = melee ? 0 : clamp01(weapons?.adsProgress ?? 0);
    this.aimAmount = this._adsLock !== null
      ? clamp01(this._adsLock)
      : Math.max(this._aimRamp, rigAim);

    // The animator gets the pose; the camera and the state machine get the aim.
    m.adsAmount = this.aimAmount;
    m.aiming = this.aimAmount > 0.35 && !this.vehicles.driving && !m.melee;
    // Q used to swap shoulder. Q is now `prevWeapon`, so that binding both
    // fought the weapon cycle and was unreachable by anyone reading the control
    // scheme. Shoulder swap has no GTA key at all, so it moves to the middle
    // mouse button, where it collides with nothing.
    if (this.controlEnabled && input.pressed('Mouse1')) this.swapShoulder();
  }

  /* ==================================================================== */
  /* the view cycle (V)                                                   */
  /* ==================================================================== */

  /**
   * One key, four views, the same order on foot and in a car. `camera.js` does
   * the work; this only routes the key and tells `ui` what to print.
   */
  _updateView() {
    if (!this.controlEnabled) return;
    if (this.ctx.input?.actionPressed?.('camera') !== true) return;
    this.cycleCamera();
  }

  cycleCamera(dir = 1) {
    const spec = this.rig.cycleView(dir);
    const inVeh = this.vehicles.seated;
    const names = inVeh ? VIEW_NAMES.vehicle : VIEW_NAMES.foot;
    this._cameraPayload.index = this.rig.view;
    this._cameraPayload.mode = spec.id;
    this._cameraPayload.name = names[this.rig.view];
    this._cameraPayload.inVehicle = inVeh;
    this.ctx.events.emit('player:camera', this._cameraPayload);
    const ui = this.ctx.peek('ui');
    ui?.toast?.(this._cameraPayload.name);
    return this._cameraPayload;
  }

  /** 'chase' | 'close' | 'far' | 'near' */
  get cameraMode() { return this.rig.viewId; }
  get cameraModeName() {
    const names = this.vehicles.seated ? VIEW_NAMES.vehicle : VIEW_NAMES.foot;
    return names[this.rig.view];
  }
  setCameraMode(id) { return this.rig.setView(id); }

  /* ==================================================================== */
  /* melee                                                                */
  /* ==================================================================== */

  /**
   * MELEE IS A WEAPON, NOT A KEY.
   *
   * `melee` is deliberately unbound: with a Dock Pipe, a Body Wrench, a Crowbar
   * or bare fists in your hands the FIRE button swings, and `weapons` already
   * owns the arc, the contact frame and the fan sweep that finds a ped. What it
   * cannot own is the rest of the body — hard rule 1 says it may not write into
   * `src/player/` — and an arm swinging off a torso that is still jogging is
   * exactly the "reads like a shoot animation" failure this is here to avoid.
   *
   * So the player reads the swing clock out of the weapon rig and turns it into
   * a whole-body commit: the facing snaps to the camera (so the fan lands where
   * you are looking), the gait drops to a shuffle, sprint is locked out, and the
   * animator gets a signed 0..1 phase to counter-rotate the hips and shoulders
   * through. `brawl` and `goons` are a whole chapter type; this is the half of
   * the swing the player can see.
   */
  _updateMelee(dt) {
    const wp = this.ctx.peek('weapons');
    const rig = wp?.rig ?? null;
    // Contact resolution against `peds` — see the header of melee.js for why
    // the weapon's own fan cannot be relied on to find one.
    this.meleeReach?.update(wp);
    const swinging = !!(rig && rig.swingT >= 0);
    const m = this.movement;

    let arc = 0;
    let side = this._meleeSide;
    if (swinging) {
      side = rig.swingSide >= 0 ? 1 : -1;
      this._meleeSide = side;
      /* The body arc, on the SAME clock the weapon uses. -1 is fully wound up,
       * +1 is fully followed through, and the strike runs between them on the
       * same `u^0.55` ease as `weapons`' own `_swingQuat` — so the shoulders
       * and the pipe are at their fastest on the identical frame, which is the
       * frame the fan sweep resolves on. Reading a plain 0..1 through the whole
       * swing instead would put the body's peak somewhere in the recovery. */
      const sw = rig.swingSpec ?? FALLBACK_SWING;
      const t = rig.swingT;
      if (t < sw.wind) {
        arc = -smoothstep(clamp01(t / Math.max(1e-4, sw.wind)));
      } else if (t < sw.wind + sw.strike) {
        const u = clamp01((t - sw.wind) / Math.max(1e-4, sw.strike));
        arc = lerp(-1, 1, Math.pow(u, 0.55));
      } else {
        const u = clamp01((t - sw.wind - sw.strike) / Math.max(1e-4, sw.recover));
        arc = lerp(1, 0, smoothstep(u));
      }
      arc *= side;
      if (!this._meleeActive) {
        this._meleeActive = true;
        this._meleePayload.side = side;
        this._meleePayload.weapon = wp?.current?.id ?? null;
        this._meleePayload.duration = rig.swingDur;
        this._meleePayload.position.copy(this.position);
        this.ctx.events.emit('player:melee', this._meleePayload);
        // A swing plants a foot: a little trauma, not a gunshot's worth.
        this.rig.addTrauma(0.05);
      }
    } else if (this._meleeActive) {
      this._meleeActive = false;
    }

    // The commit outlasts the arc by a beat so the recovery is not cancelled
    // by the first frame of stick input.
    this._meleeHold = swinging ? 1 : approach(this._meleeHold, 0, 0.14, dt);
    m.melee = swinging || this._meleeHold > 0.3;
    // The arc itself is NOT smoothed — smoothing it would round off exactly the
    // acceleration through contact that sells the weight. Only the weight the
    // layer is applied with is filtered, so it fades in and out cleanly.
    this.meleePhase = arc;
    this.meleeSide = side;
    this.meleeWeight = approach(this.meleeWeight, swinging ? 1 : 0, swinging ? 0.03 : 0.1, dt);

    /* ---- the guard ------------------------------------------------------
     * `MeleeReach.update` has just resolved it (it runs at the top of this
     * function), so this is the same instant, not last frame's. Mirroring it
     * onto one field here means the animator, the movement machine and `ui`
     * cannot disagree about whether the guard was up. */
    this.blocking = this.meleeReach?.blocking === true;
    m.blocking = this.blocking;
  }

  /** True while a swing is in flight — `game`'s brawl tracks can read it. */
  get swinging() { return this._meleeActive; }
  /** { swings, solverHits, fallbackHits, misses } */
  get meleeStats() { return this.meleeReach?.stats ?? null; }

  _drainMovementEvents() {
    const m = this.movement;
    this._pose.landImpulse = 0;

    if (m.landEvent.pending) {
      m.landEvent.pending = false;
      const speed = m.landEvent.speed;
      this.rig.onLand(speed);
      this._landPayload.velocity = speed;
      this._landPayload.surface = m.landEvent.surface;
      this._landPayload.position.copy(m.position);
      this.ctx.events.emit('player:land', this._landPayload);
      // The knee bend is proportional to the impact — that is the whole read.
      this._pose.landImpulse = clamp(speed * 0.11, 0, 2.4);
      const L = CAMERA.land;
      if (speed > L.damageSpeed) {
        this.health.damage((speed - L.damageSpeed) * L.damagePerSpeed, null, { type: 'fall' });
      }
    }

    if (m.jumped) {
      m.jumped = false;
      this.rig.addRecoil(-0.2 * DEG, 0, 0, 0.002);
      this._jumpPayload.position.copy(m.position);
      this.ctx.events.emit('player:jump', this._jumpPayload);
    }

    if (m.mantleEvent.pending) {
      m.mantleEvent.pending = false;
      this._mantlePayload.kind = m.mantleEvent.kind;
      this._mantlePayload.height = m.mantleEvent.height;
      this.rig.addTrauma(m.mantleEvent.kind === 'vault' ? 0.05 : 0.09);
      this.ctx.events.emit('player:mantle', this._mantlePayload);
    }
  }

  _publishState() {
    const m = this.movement;
    const s = this._statePayload;
    s.state = m.state;
    s.stance = m.stance;
    s.crouched = m.stance === 'crouch';
    s.sprinting = m.sprinting;
    // The aim, not the carry pose — `ui` draws an ADS reticle off this.
    s.aiming = this.aimAmount > 0.5;
    s.ads = s.aiming;
    // The OTHER thing RMB does. Same button, mutually exclusive with `aiming`,
    // and `ui` has no reticle for it yet — publishing it is how it gets one.
    s.blocking = this.blocking;
    s.inVehicle = m.driving;
    // Nitro rides on the player, not the car — see `VehicleHandler.nitro`.
    // `ui` has no gauge for it yet; publishing it is how it gets one.
    s.nitro = this.vehicles.nitro;
    s.nitroFraction = this.vehicles.nitroFraction;
    s.nitroOn = this.vehicles.nitroOn;
    s.grounded = m.grounded;
    s.airborne = !m.grounded && !m.driving;
    s.mantling = m.mantleMotion.active;
    s.speed = m.horizontalSpeed;
    s.health = this.health.value;
    s.armour = this.health.armour;
    s.healthFraction = this.health.fraction;
    const q = this._prev;
    if (
      q.state !== s.state || q.stance !== s.stance || q.sprinting !== s.sprinting ||
      q.grounded !== s.grounded || q.ads !== s.aiming || q.mantling !== s.mantling ||
      q.inVehicle !== s.inVehicle || q.blocking !== s.blocking
    ) {
      q.state = s.state; q.stance = s.stance; q.sprinting = s.sprinting;
      q.grounded = s.grounded; q.ads = s.aiming; q.mantling = s.mantling;
      q.inVehicle = s.inVehicle; q.blocking = s.blocking;
      this.ctx.events.emit('player:state', s);
    }
  }

  /* ==================================================================== */
  /* incoming damage                                                      */
  /* ==================================================================== */

  _onDamageDealt(e) {
    if (!e) return;
    const t = e.target;
    if (t !== this && t !== 'player' && t?.isPlayer !== true) return;
    const from = e.from ?? e.source?.position ?? e.point ?? null;
    this.applyDamage(e.amount ?? 0, from, { type: 'bullet' });
  }

  /**
   * THE BLAST.
   *
   * A blast takes `damage * 0.55 * (1 - d/r)` off a player on foot and nothing
   * at all off one behind a wheel. Three things in one line, and this code had
   * one of them.
   *
   * 1. THE SHARE. `* 0.55`. A blast that writes off a car does not write off
   *    the man beside it, and the enemy/vehicle branches of the same event
   *    take the full number — the 0.55 is what makes the player the durable
   *    thing in the picture. MEASURED before this, `damage 100, radius 12`:
   *    100.0 hp at the epicentre, i.e. instant death from full health with a
   *    plain `explosion` payload, against the correct 55.0.
   *
   * 2. THE CURVE. Linear in `d/r`. This code raised it to the 1.6, which is not
   *    a uniform scale of the linear curve — it is steeper at the rim and much
   *    flatter at the middle. Same shot, hp lost at d/r = 0 / .25 / .5 / .75:
   *
   *        before    100.00   63.11   32.99   10.88
   *        correct    55.00   41.25   27.50   13.75
   *
   *    so "1.8x too much" is only true at the epicentre; at 0.75r it was 0.79x.
   *    The whole shape moves, not a multiplier.
   *
   * 3. THE EXEMPTION. You are blast-immune in a car BECAUSE THE CAR TAKES IT —
   *    the vehicle branch is unconditional and multiplies by `ACTOR_TO_VEHICLE`
   *    (10) on the way in. Both used to be charged: MEASURED, one `damage 100`
   *    blast on a seated player, hp 100 -> 0 AND the sedan 900 -> 0. One
   *    grenade, two write-offs.
   *
   * WHAT DID NOT NEED FIXING: the reach. The old `d > r * 1.6` early-out reads
   * like damage out to 1.6 radii, and it is not — `clamp01(1 - d/r)` is 0 at
   * and beyond `r`, so the falloff, the damage, the trauma and the suppression
   * were all already exactly zero out there. MEASURED at d/r = 1.0, 1.2 and
   * 1.5: 0.00 hp on every one, before any change. The early-out was skipping a
   * computation whose answer was zero, nothing more. It is gone because
   * `d >= r` is the honest bound, not because it was costing anyone health.
   *
   * The camera trauma and the suppression are deliberately NOT exempted in a
   * car: a blast you sat through in a car should still be felt — what the car
   * eats is the damage.
   */
  _onExplosion(e) {
    if (!e?.position) return;
    const at = this.headPosition;
    const r = e.radius ?? 5;
    const d = this._tmp.copy(e.position).distanceTo(at);
    if (!(d < r)) return;
    const legacy = this.debugBlastShare === false;
    const falloff = legacy ? Math.pow(clamp01(1 - d / r), 1.6) : 1 - d / r;
    const share = legacy ? 1 : BLAST_PLAYER_SHARE;
    this.rig.addTrauma(clamp01(falloff * 1.4));
    this.health.addSuppression(HEALTH.suppression.perExplosion * falloff);
    // `inVeh`. `seated` is the drive/settling-into-the-seat pair; the walk to
    // the door and the climb out are NOT in the car, and the man doing them is
    // standing in the open next to one.
    if (this.vehicles.seated && this.debugBlastInVehicle !== false) return;
    const clear = this.physics.lineOfSight(e.position, at, this.physics.MASK.EXPLOSION);
    if (clear && falloff > 0.02) {
      this.applyDamage((e.damage ?? 90) * share * falloff, e.position, { type: 'explosion' });
    }
  }

  _onBulletImpact(e) {
    if (!e?.point || this.health.dead) return;
    const at = this.headPosition;
    const dx = e.point.x - at.x, dy = e.point.y - at.y, dz = e.point.z - at.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    const R = HEALTH.suppression.radius;
    if (d2 > R * R) return;
    const d = Math.sqrt(d2) || 1e-4;
    const f = this.rig.forward;
    if ((dx * f.x + dy * f.y + dz * f.z) / d > 0.55) return;
    this.health.addSuppression(HEALTH.suppression.perNearMiss * (1 - d / R));
  }

  /** `ai` calls this when a round cracks past without connecting. */
  onNearMiss(miss) {
    this.health.addSuppression(HEALTH.suppression.perNearMiss * clamp01(1 - miss / 1.6));
  }

  /* ==================================================================== */
  /* the shot harness                                                     */
  /* ==================================================================== */

  /**
   * The capture harness parks the camera on the player capsule and disables
   * control, which in third person would mean shooting every frame of the game
   * from inside the character's head. So: hide the body by default, and allow
   * the player to be staged from the shot definition itself — an inline shot
   * may carry a `player` block:
   *
   *   node tools/capture.mjs --shot='{"pos":[6,2,6],"look":[0,1.2,0],
   *     "player":{"at":[0,0,0],"yaw":0,"state":"jog","camera":false}}'
   *
   * `camera: true` hands the camera back to the rig, which is how the boom and
   * the collision behaviour are actually reviewed.
   */
  _onShotApplied(e) {
    const req = e?.shot?.player ?? null;
    this._shotHide = !req;
    this.movement.scriptedInput = null;
    this._adsLock = null;
    if (!req) return;

    const cam = this.ctx.camera;
    let x, y, z;
    if (Array.isArray(req.at)) {
      [x, y, z] = req.at;
    } else {
      // Default: drop him `dist` metres in front of the shot camera.
      const d = req.dist ?? 4;
      this._tmp.set(0, 0, -1).applyQuaternion(cam.quaternion);
      this._tmp.y = 0;
      this._tmp.normalize().multiplyScalar(d);
      x = cam.position.x + this._tmp.x;
      z = cam.position.z + this._tmp.z;
      y = cam.position.y;
    }
    const gy = this.physics.groundHeight(x, z, y + 8);
    const feetY = Number.isFinite(gy) ? gy + 0.03 : y;
    let yaw = req.yaw;
    if (yaw === undefined) {
      // Face the camera by default so the shot frames him head on.
      yaw = Math.atan2(-(cam.position.x - x), -(cam.position.z - z));
    }
    this.movement.teleport(x, feetY, z, yaw);
    this.rig.reset(this.movement.anchorHeight, this.movement.position, yaw);
    this.animator.reset();
    this.health.reset(true);

    this.setControlEnabled(true);
    this.ctx.input.frozen = true;
    this.debugState(req.state ?? 'idle');
    if (req.aim) this._adsLock = 1;
    if (req.shoulder) this.rig.shoulder = req.shoulder < 0 ? -1 : 1;
    if (req.brother) this.setBrother(req.brother);
    if (req.camera) {
      if (req.camYaw !== undefined) {
        this.rig.yaw = this.rig.yawTarget = req.camYaw;
      }
      if (req.camPitch !== undefined) {
        this.rig.pitch = this.rig.pitchTarget = req.camPitch;
      }
    }
    // Without `camera: true` the shot keeps its own framing: the rig still
    // solves (so the boom state is live) but never writes to the camera.
    this._suppressCamera = !req.camera;
  }

  /* ==================================================================== */
  /* public API                                                           */
  /* ==================================================================== */

  getHudState() {
    const h = this._hudState;
    const m = this.movement;
    const hp = this.health;
    h.health = hp.value;
    h.maxHealth = hp.max;
    h.armour = hp.armour;
    h.maxArmour = hp.maxArmour;
    h.regen = hp.regenerating;
    h.dead = hp.dead;
    h.suppression = hp.suppression;
    h.move = Math.min(1, m.horizontalSpeed / this.brother.runSpeed);
    h.sprint = m.sprinting;
    h.crouch = m.stance === 'crouch';
    h.ads = this.aimAmount > 0.5;
    h.airborne = !m.grounded && !m.driving;
    h.inVehicle = m.driving;
    // The nitro gauge `ui` will want next to the fuel one.
    h.nitro = this.vehicles.nitro;
    h.nitroFraction = this.vehicles.nitroFraction;
    h.nitroOn = this.vehicles.nitroOn;
    h.brother = this.brother.id;
    h.position = this.position;
    // Swimming: `ui` can draw the breath meter GTA puts under the health arc.
    h.swimming = m.swimming;
    h.submerged = m.submerged;
    h.breath = m.breath;
    h.drowning = m.drowning;
    h.camera = this.rig.viewId;
    h.cameraName = this.cameraModeName;
    h.melee = this._meleeActive;
    h.blocking = this.blocking;
    return h;
  }

  get position() { return this.movement.renderPosition; }
  get feetPosition() { return this.movement.position; }
  get headPosition() {
    this._head.copy(this.movement.renderPosition);
    /**
     * Seated, the body is FOLDED into the cabin — the head is `GAIT.seat`
     * above the root, not a standing 1.6 m. Reporting the standing figure
     * while driving puts every line-of-sight test, explosion check and
     * near-miss radius at a point above the car's roof.
     */
    this._head.y += this.vehicles.seated
      ? GAIT.seat.headHeight * (this.movement.bodyScale ?? 1)
      : this.movement.anchorHeight + 0.16;
    return this._head;
  }
  get eyePosition() { return this.rig.position; }
  get cameraPosition() { return this.rig.position; }
  get velocity() { return this.movement.velocity; }
  get forward() { return this.rig.forward; }
  get yaw() { return this.movement.faceYaw; }
  get cameraYaw() { return this.rig.yaw; }
  get pitch() { return this.rig.pitch; }
  get speed() { return this.movement.speed; }
  get horizontalSpeed() { return this.movement.horizontalSpeed; }
  get character3D() { return this.character?.root ?? null; }
  get weaponHand() { return this.character?.weaponHand ?? null; }
  get skeleton() { return this.character?.skeleton ?? null; }
  get state() { return this.movement.state; }
  get stance() { return this.movement.stance; }
  get sprinting() { return this.movement.sprinting; }
  get sliding() { return false; }
  get slideProgress() { return 0; }
  get grounded() { return this.movement.grounded; }
  get airborne() { return !this.movement.grounded && !this.movement.driving; }
  get mantling() { return this.movement.mantleMotion.active; }
  get swimming() { return this.movement.swimming; }
  get submerged() { return this.movement.submerged; }
  /** 1 = full lungs, 0 = drowning. */
  get breath() { return this.movement.breath; }
  set breath(v) { this.movement.breath = clamp01(v); }
  get drowning() { return this.movement.drowning; }
  get inVehicle() { return this.movement.driving; }
  get vehicle() { return this.vehicles.vehicle; }
  /** Nitro, 0..100 — the driver's bottle. See `VehicleHandler._stepNitro`. */
  get nitro() { return this.vehicles.nitro; }
  get nitroFraction() { return this.vehicles.nitroFraction; }
  get nitroOn() { return this.vehicles.nitroOn; }
  get leanAmount() { return 0; }
  get eyeHeight() { return this.rig.eye; }
  /** The weapon POSE blend (carries a floor while a firearm is drawn). */
  /**
   * The weapon pose the ANIMATOR is actually given, which is not always the
   * raw `adsAmount` `weapons` pushed — a melee weapon has no sights, so its
   * `rig.adsT` is not an aim pose however high the guard drives it. See the
   * third-source note in `_updateAds`. `_adsLock` outranks both: that is the
   * shot harness explicitly asking for a pose.
   */
  get aimPose() {
    if (this._adsLock !== null) return clamp01(this._adsLock);
    return this.meleeEquipped ? 0 : clamp01(this.adsAmount);
  }

  get adsProgress() { return this.aimPose; }
  /** The genuine AIM state. This is the one gameplay should ask about. */
  get aimProgress() { return this.aimAmount; }
  get aiming() { return this.movement.aiming === true; }
  get viewKick() { return this.rig.viewKick; }
  get cameraRig() { return this.rig; }
  get height() { return STANCE[this.movement.stance].height * this.movement.bodyScale; }
  get maxHealth() { return this.health.max; }
  get armour() { return this.health.armour; }
  get maxArmour() { return this.health.maxArmour; }
  get healthFraction() { return this.health.fraction; }
  get lowHealth() { return this.health.low; }
  get dead() { return this.health.dead; }
  get suppression() { return this.health.suppression; }
  get damageIndicators() { return this.health.indicators; }
  get heartbeatPulse() { return this.health.pulse; }
  get bobPhase() { return this.rig.bobPhase; }
  /** `weapons`/`ui` may read the raw health number off the system. */
  get health$() { return this.health.value; }

  /**
   * THE WEAPON POSE CHANNEL. `weapons` writes how high the weapon rides in the
   * hands; nothing about gameplay is inferred from the value.
   *
   * It is safe to push a non-zero floor here while merely carrying a firearm —
   * that used to disable the player's sprint and clamp him to 1.9 m/s, and no
   * longer can. `setCarryPose` is the same channel under the name that says so;
   * prefer it for a pose that is not aiming.
   */
  setAdsProgress(v) {
    this.adsAmount = clamp01(v);
    this._adsExternal = true;
    this._adsExternalAge = 0;
  }

  /** The carry pose, by its real name. See `setAdsProgress`. */
  setCarryPose(v) { this.setAdsProgress(v); }

  /**
   * Force the AIM STATE, for the shot harness and the playtest drivers. Pass
   * `null` to hand aim back to the player's own button and the weapon rig.
   */
  setAimLock(v) {
    this._adsLock = v === null || v === undefined ? null : clamp01(v);
  }

  swapShoulder() {
    this.rig.shoulder = -this.rig.shoulder;
    this.character.side = this.rig.shoulder;
    return this.rig.shoulder;
  }

  addRecoil(pitch, yaw, roll, punch) { this.rig.addRecoil(pitch, yaw, roll, punch); }
  addKick(pitch, yaw, roll) { this.rig.addKick(pitch, yaw, roll); }
  addTrauma(a) { this.rig.addTrauma(a); }
  addCameraShake(a) { this.rig.addTrauma(a); }

  applyDamage(amount, from, opts) {
    // `origin` is the BODY, not the camera — see the bearing note in health.js.
    return this.health.damage(amount, from ?? null, {
      yaw: this.rig.yaw, origin: this.headPosition, ...opts,
    });
  }
  heal(a) { this.health.heal(a); }
  addArmour(a) {
    this.health.armour = Math.min(this.health.maxArmour, this.health.armour + a);
  }
  addSuppression(a) { this.health.addSuppression(a); }

  setControlEnabled(on) {
    this.controlEnabled = !!on;
    this.movement.controlEnabled = this.controlEnabled;
    if (on) {
      this._shotHide = false;
      this._suppressCamera = false;
      this.movement._cmdFrame = -1;
    } else {
      this.movement.latchInput(-2);
      this.movement.velocity.set(0, 0, 0);
      this.movement.sprinting = false;
      this.movement.cancelMantle();
      this.movement.scriptedInput = null;
      this.adsAmount = 0;
      this.aimAmount = 0;
      this._aimRamp = 0;
      this._adsExternal = false;
      this._adsLock = null;
    }
  }

  /**
   * Move the player. The harness supplies a CAMERA transform, so in third
   * person `pos` is where the camera goes, not where the body goes: the body is
   * dropped onto the ground beneath it and the camera boom re-seeded behind.
   */
  teleport(posOrEye, rot) {
    if (!posOrEye) return;
    let yaw = this.movement.faceYaw;
    if (typeof rot === 'number') yaw = rot;
    else if (rot) yaw = rot.y ?? yaw;
    const feetY = posOrEye.y - STANCE.stand.eye * this.movement.bodyScale;
    this.movement.teleport(posOrEye.x, feetY, posOrEye.z, yaw);
    this.rig.reset(this.movement.anchorHeight, this.movement.position, yaw);
    if (rot && typeof rot !== 'number' && rot.x !== undefined) {
      this.rig.pitch = this.rig.pitchTarget = clamp(rot.x, CAMERA.orbit.pitchMin, CAMERA.orbit.pitchMax);
    }
    this.animator?.reset();
    this.vehicles?.abort(this.movement);
    this._lookFrame = this.ctx.time.frame;
    this._prev.state = '';
  }

  respawn(index = 0) {
    const world = this.ctx.peek('world');
    const sp = world?.spawn?.(index);
    this.health.reset(true);
    this.vehicles.abort(this.movement);
    if (!sp?.position) return;
    const gy = this.physics.groundHeight(sp.position.x, sp.position.z, sp.position.y + 6);
    const feetY = Number.isFinite(gy) ? gy + 0.03 : sp.position.y;
    this.movement.teleport(sp.position.x, feetY, sp.position.z, sp.yaw ?? 0);
    this.rig.reset(this.movement.anchorHeight, this.movement.position, sp.yaw ?? 0);
    this.animator.reset();
  }

  /** Named states for dev overlays, the shot harness and the playtest driver. */
  debugState(name) {
    const m = this.movement;
    const scripted = (x, y, opts) => {
      m.scriptedInput = { x, y, sprint: false, walk: false, crouch: false, ...opts };
    };
    switch (name) {
      case 'idle': m.scriptedInput = null; break;
      case 'walk': scripted(0, 1, { walk: true }); break;
      case 'jog': scripted(0, 1, {}); break;
      case 'sprint': scripted(0, 1, { sprint: true }); break;
      case 'back': scripted(0, -1, {}); break;
      case 'strafe': scripted(1, 0, {}); break;
      case 'crouch': scripted(0, 0.6, { crouch: true }); break;
      case 'aim': m.scriptedInput = null; this._adsLock = 1; break;
      case 'jump': m.velocity.y = JUMP_SPEED; m.grounded = false; break;
      case 'air': m.velocity.y = -8; m.grounded = false; break;
      case 'carson': case 'aidan': case 'dylan': this.setBrother(name); break;
      case 'hurt':
        this.health.value = this.health.max * 0.28;
        this.health.armour = 0;
        this.health.lastDamageTime = this.ctx.time.elapsed;
        this.health.effect = clamp01((HEALTH.lowThreshold - 0.28) / HEALTH.lowThreshold);
        break;
      case 'critical':
        this.health.value = this.health.max * 0.11;
        this.health.armour = 0;
        this.health.lastDamageTime = this.ctx.time.elapsed;
        this.health.effect = 1;
        this.health.hitFlash = 0.6;
        break;
      case 'reset':
        m.scriptedInput = null;
        this._adsLock = null;
        this.health.reset(true);
        this.health.effect = 0;
        this.setAdsProgress(0);
        this.aimAmount = 0;
        this._aimRamp = 0;
        this._adsExternal = false;
        break;
      default: break;
    }
    return {
      state: this.state, stance: m.stance, speed: m.horizontalSpeed,
      health: this.health.value, armour: this.health.armour, ads: this.adsAmount,
      brother: this.brother.id,
    };
  }

  get stats() {
    const m = this.movement;
    return {
      brother: this.brother.id,
      state: m.state,
      stance: m.stance,
      speed: m.horizontalSpeed,
      vertical: m.velocity.y,
      grounded: m.grounded,
      faceYaw: m.faceYaw,
      camYaw: this.rig.yaw,
      camDist: this.rig.collideRadius,
      fov: this.rig.fov,
      health: this.health.value,
      armour: this.health.armour,
      inVehicle: m.driving,
    };
  }

  dispose() {
    for (const off of this._offEvents) off?.();
    this._offEvents.length = 0;
    if (this.hitbox) {
      this.physics?.removeCollider(this.hitbox);
      this.hitbox = null;
    }
    this._unregisterPass?.();
    this.lowHealthPass?.dispose();
    this.lowHealthPass = null;
    this.character?.dispose();
    this.movement?.dispose();
    // The rig subscribes to `camera:shake` and `vehicle:collision` itself.
    this.rig?.dispose();
  }
}
