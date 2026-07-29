/**
 * The procedural animator.
 *
 * There are no clips. Every pose is evaluated analytically from the movement
 * machine's state, and the legs are solved by IK to foot targets that are
 * *defined to be world-static while planted* — which is what makes foot sliding
 * structurally impossible rather than something you tune away.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE GAIT MODEL
 *
 * A cycle is two steps. Phase advances by DISTANCE, never by time:
 *
 *     phase += (speed * dt / strideLength) * 2PI
 *
 * so if the character accelerates, decelerates, is pushed by a slope or hits a
 * wall, the feet follow the body exactly. Right foot is at `phase`, left at
 * `phase + PI`.
 *
 * Within one foot's normalised phase p (0..1):
 *
 *     [0, plant*0.66]     PLANTED. The foot moves backward in body space at
 *                         exactly the body's speed, so it is motionless in the
 *                         world. This is the no-slide guarantee.
 *     [plant*0.66, plant] ROLL-OVER. The heel lifts and the ankle decelerates
 *                         while the toe stays down — the ankle does move, but
 *                         it is pivoting about a static toe, so the contact
 *                         point is still not sliding, and it keeps the leg
 *                         inside its reach at toe-off.
 *     [plant, 1]          SWING. A lifted arc back to the strike position.
 *
 * The reference gaits (stand / walk / jog / sprint) are interpolated by speed,
 * so there is no discrete "walk to run" transition to pop.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT SITS ON TOP
 *   pelvis      vertical bounce (2x cycle rate), lateral sway toward the stance
 *               leg, roll toward the swing leg, counter-yaw
 *   spine       forward lean proportional to speed, counter-yaw to the pelvis
 *   arms        FK swing counter-phased to the legs, elbow flexion by speed;
 *               in aim, IK to a two-handed grip in front of the chest
 *   head        stabilised against the bounce, then aimed at the reticle
 *   foot IK     a ground trace under each foot; the target is lifted onto the
 *               terrain and the ankle rolls to the surface normal. The pelvis
 *               drops when the lower foot cannot be reached (stairs, kerbs)
 *   idle        breathing, a slow weight shift between the legs, micro sway
 */

import * as THREE from 'three';
import { GAIT, STANCE, MOVE, TOP_RUN_SPEED } from '../tuning.js';
import { clamp, clamp01, lerp, approach, angleDelta, smoothstep, hashNoise } from '../springs.js';
import { solveTwoBone, aimBone, orientBone, restDir, setEuler } from './ik.js';

/** Reference gaits, ordered by speed. Interpolated, never switched. */
const REF = [
  { speed: 0.0, stride: 0.62, plant: 0.74, lift: 0.012, bounce: 0.002, lean: 0.0, strike: 0.09, arm: 0.06, elbow: 0.18, sway: 0.012, roll: 0.01, yaw: 0.02 },
  { speed: 1.72, stride: 1.52, plant: 0.60, lift: 0.070, bounce: 0.021, lean: 0.035, strike: 0.28, arm: 0.34, elbow: 0.30, sway: 0.032, roll: 0.055, yaw: 0.075 },
  { speed: 3.35, stride: 2.10, plant: 0.46, lift: 0.145, bounce: 0.044, lean: 0.10, strike: 0.34, arm: 0.62, elbow: 0.78, sway: 0.026, roll: 0.05, yaw: 0.12 },
  { speed: 6.90, stride: 2.95, plant: 0.34, lift: 0.265, bounce: 0.062, lean: 0.24, strike: 0.42, arm: 0.82, elbow: 1.42, sway: 0.018, roll: 0.035, yaw: 0.19 },
];

const KEYS = ['stride', 'plant', 'lift', 'bounce', 'lean', 'strike', 'arm', 'elbow', 'sway', 'roll', 'yaw'];

/** Portion of the plant phase that is dead-static before the heel lifts. */
const ROLL_START = 0.66;
/** How much of the linear travel the roll-over phase still covers. */
const ROLL_TRAVEL = 0.42;

/**
 * THE GUARD.
 *
 * A raised guard is a POSE, and until now it had none: holding the block
 * button with fists up played the two-handed shoulder AIM (`_poseAim`), which
 * puts both hands out in front of the sternum around an object that is not
 * there. This is the boxing answer to it — hands up at the cheekbones, elbows
 * in, chin down, weight back, shoulders bladed toward the threat.
 *
 * Authored in CHEST-LOCAL metres, the same frame `_poseAim` uses and for the
 * same reason: the targets ride the counter-rotated torso, so the guard tracks
 * the shoulders through a stride instead of swimming against them. Bind-space
 * forward is -Z, up is +Y, and +X is the character's right.
 *
 * `lead` is the hand on the far side from the camera shoulder — it carries a
 * little further out and forward, because a guard is not symmetric and a
 * symmetric one reads as a pose rather than a stance.
 *
 * These live here rather than in `tuning.js`; they belong in `GAIT`.
 */
const GUARD = {
  /** Seconds of the exponential settle. Faster than the aim's 0.085. */
  tau: 0.055,
  /** Rear hand: by the cheek on the camera-shoulder side. */
  rear: { x: 0.105, y: 0.315, z: -0.115 },
  /** Lead hand: further forward and slightly across the centre line. */
  lead: { x: -0.085, y: 0.275, z: -0.235 },
  /** Extra forward hunch at the spine and chest, radians. */
  crouch: 0.13,
  /** Chin tuck, radians, on top of the look pitch. */
  chinTuck: 0.16,
  /**
   * How much of the look yaw the shoulders take up, 0..1 — the same channel
   * `aimSm` drives, at a smaller share. A guard turns toward the threat; it
   * does not square up to it the way a rifle does.
   */
  blade: 0.62,
  /** Both clavicles shrug up into it. */
  shrug: 0.09,
};

export class Animator {
  constructor(ctx, rig) {
    this.ctx = ctx;
    this.rig = rig;
    this.physics = ctx.peek('physics');

    this.phase = 0;
    this.prevPhase = 0;
    /** Set true for one frame when a foot plants. `left` says which. */
    this.footEvent = { pending: false, left: false, x: 0, y: 0, z: 0, surface: 'concrete' };

    // blended gait parameters
    this.g = {};
    for (const k of KEYS) this.g[k] = REF[0][k];

    // smoothed channels
    this.speedSm = 0;
    this.leanSm = 0;
    this.crouchSm = 0;
    this.aimSm = 0;
    this.airSm = 0;
    this.landDip = 0;
    this.landVel = 0;
    this.pelvisDrop = 0;
    this.stumbleSm = 0;
    this.swimSm = 0;
    this.driveSm = 0;
    /** Signed swing arc and its blend weight — see GAIT.melee. */
    this.swing = 0;
    this.swingW = 0;
    /** 0..1 guard weight — see `_poseGuard`. */
    this.guardSm = 0;
    /**
     * NEGATIVE CONTROL, read by `src/player/blockblastprobe.mjs` and by nothing
     * else: false pins `guardSm` at 0, which removes the whole guard pose — the
     * hands, the hunch, the chin tuck, the blade and the shrug — in one place.
     */
    this.debugGuardPose = true;
    this.swimPhase = 0;
    this.deadSm = 0;
    this.turnSm = 0;
    this.strafeSm = 0;
    this.forwardSm = 1;
    this.idleShift = 0;
    this.breath = 0;
    this.upperYaw = 0;
    this.headYaw = 0;
    this.headPitch = 0;

    // per-foot IK memory
    this.foot = [];
    for (let i = 0; i < 2; i++) {
      this.foot.push({
        target: new THREE.Vector3(),
        ikY: 0,
        normal: new THREE.Vector3(0, 1, 0),
        smNormal: new THREE.Vector3(0, 1, 0),
        planted: false,
        wasPlanted: false,
        /** True only in the DEAD-static window — the no-slide guarantee. */
        locked: false,
        surface: 'concrete',
      });
    }

    // scratch — nothing here is allocated per frame
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._pole = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._rest = {};
    this._len = {};

    this._cacheRest();
  }

  /** Bind-pose child directions and bone lengths, needed by every IK call. */
  _cacheRest() {
    const b = this.rig.bones;
    const pair = (name, childName) => {
      const bone = b[name];
      const child = b[childName];
      if (!bone || !child) return;
      this._rest[name] = restDir(child, new THREE.Vector3());
      this._len[name] = child.position.length();
    };
    for (const s of ['L', 'R']) {
      pair('thigh' + s, 'shin' + s);
      pair('shin' + s, 'foot' + s);
      pair('foot' + s, 'toe' + s);
      pair('arm' + s, 'forearm' + s);
      pair('forearm' + s, 'hand' + s);
      pair('hand' + s, 'handEnd' + s);
    }
    pair('neck', 'head');
    pair('head', 'headEnd');

    // Bind positions we offset from every frame.
    this.hipsBind = b.hips.position.clone();
    this.hipHeight = this.rig.bindPositions.hips[1];
    this.legLength = this._len.thighL + this._len.shinL;
    this.hipHalfWidth = Math.abs(this.rig.bindPositions.thighL[0]);
    this.soleY = 0.028 * (this.rig.scale ?? 1);
    this.footRestUp = new THREE.Vector3(0, 1, 0);
  }

  /* ==================================================================== */

  /**
   * @param dt   frame delta
   * @param s    the pose request built by PlayerSystem (see _poseRequest there)
   */
  update(dt, s) {
    const rig = this.rig;
    const root = rig.root;

    // ---- root transform ---------------------------------------------------
    root.position.set(s.x, s.y, s.z);
    root.quaternion.setFromAxisAngle(this._up, s.faceYaw);

    this._fwd.set(-Math.sin(s.faceYaw), 0, -Math.cos(s.faceYaw));
    this._right.set(Math.cos(s.faceYaw), 0, -Math.sin(s.faceYaw));

    // ---- smoothing --------------------------------------------------------
    const B = GAIT.blend;
    this.speedSm = approach(this.speedSm, s.speed, 0.06, dt);
    this.crouchSm = approach(this.crouchSm, s.crouch ? 1 : 0, B.stance, dt);
    this.aimSm = approach(this.aimSm, s.aim, B.aim, dt);
    this.airSm = approach(this.airSm, s.grounded ? 0 : 1, s.grounded ? 0.09 : 0.05, dt);
    this.stumbleSm = approach(this.stumbleSm, s.stumble, 0.12, dt);
    this.swimSm = approach(this.swimSm, s.swim ? 1 : 0, 0.22, dt);
    this.driveSm = approach(this.driveSm, s.driving ? 1 : 0, 0.2, dt);
    this.turnSm = approach(this.turnSm, s.turning, B.turn, dt);
    this.strafeSm = approach(this.strafeSm, s.strafe, 0.1, dt);
    this.forwardSm = approach(this.forwardSm, s.forwardSign, 0.14, dt);
    this.breath += dt;
    // The swing arc is taken RAW (it is already on the weapon's own clock and
    // filtering it would round off the acceleration through contact); only its
    // weight is smoothed.
    this.swing = s.swing ?? 0;
    this.swingW = approach(this.swingW, s.swingWeight ?? 0, 0.05, dt);
    /* The guard comes up FAST and drops fast — it is a reaction, not a stance
     * you settle into, and a quarter-second fade would let a blow land against
     * a pose that is still on its way up. Slightly quicker than `B.aim`
     * (0.085 s) for the same reason a parry window is a quarter of a second. */
    this.guardSm = approach(
      this.guardSm, this.debugGuardPose === false ? 0 : (s.guard ?? 0), GUARD.tau, dt
    );
    this.deadSm = approach(this.deadSm, s.dead ? 1 : 0, GAIT.death.tau, dt);
    if (this.swimSm > 0.01) {
      const P = GAIT.swimPose;
      const mv = clamp01(this.speedSm / Math.max(0.4, MOVE.swimSpeed));
      this.swimPhase += dt * Math.PI * 2 * lerp(P.rateIdle, P.rateFast, mv);
      if (this.swimPhase > Math.PI * 2) this.swimPhase -= Math.PI * 2;
    }

    this._blendGait(this.speedSm, this.crouchSm);

    // ---- gait phase, driven by distance -----------------------------------
    this.prevPhase = this.phase;
    if (!s.grounded || this.swimSm > 0.5) {
      // Airborne: let the legs settle rather than pedalling.
      this.phase += dt * 1.2;
    } else {
      const stride = Math.max(0.28, this.g.stride);
      this.phase += (Math.max(0, s.speed) * dt / stride) * Math.PI * 2;
      // A stationary character still shifts weight; the turn-in-place shuffles.
      if (s.speed < 0.12 && this.turnSm > 0.15) this.phase += dt * 3.2 * this.turnSm;
    }
    if (this.phase > Math.PI * 2) {
      this.phase -= Math.PI * 2;
      this.prevPhase -= Math.PI * 2;
    }

    // ---- landing spring ---------------------------------------------------
    if (s.landImpulse > 0) {
      this.landVel -= s.landImpulse;
    }
    // critically damped, ~0.42 s to settle
    const w = 2 * Math.PI * 2.3;
    this.landVel += (-w * w * this.landDip - 2 * 0.85 * w * this.landVel) * dt;
    this.landDip += this.landVel * dt;
    if (this.landDip < -0.34) { this.landDip = -0.34; this.landVel = Math.max(0, this.landVel); }

    this._pose(dt, s);
    rig.root.updateMatrixWorld(true);
  }

  /** Interpolate the reference gaits by speed, then bias for crouch. */
  _blendGait(speed, crouch) {
    let i = 0;
    while (i < REF.length - 2 && speed > REF[i + 1].speed) i++;
    const a = REF[i], b = REF[i + 1];
    const t = clamp01((speed - a.speed) / (b.speed - a.speed || 1));
    for (const k of KEYS) this.g[k] = lerp(a[k], b[k], t);
    if (crouch > 0) {
      this.g.stride = lerp(this.g.stride, this.g.stride * 0.72, crouch);
      this.g.lift = lerp(this.g.lift, this.g.lift * 0.6, crouch);
      this.g.bounce *= 1 - 0.5 * crouch;
      this.g.arm *= 1 - 0.45 * crouch;
    }
  }

  /* ==================================================================== */
  /* pose                                                                 */
  /* ==================================================================== */

  _pose(dt, s) {
    const b = this.rig.bones;
    const g = this.g;
    const scale = this.rig.scale ?? 1;

    // Reset every bone we drive; the bind pose is the identity rotation.
    b.hips.position.copy(this.hipsBind);
    b.hips.quaternion.identity();
    b.spine.quaternion.identity();
    b.chest.quaternion.identity();
    b.neck.quaternion.identity();
    b.head.quaternion.identity();

    const cyc = this.phase;
    // Normalised against the CAST's top speed, so the three brothers reach
    // different points on the run pose (0.81 / 0.87 / 1.00 at full sprint)
    // instead of all clamping to the same one. See `TOP_RUN_SPEED`.
    const speedT = clamp01(this.speedSm / TOP_RUN_SPEED);

    /* ---- pelvis -------------------------------------------------------- */
    // Vertical: two bounces per cycle, lowest at each mid-stance.
    let py = -g.bounce * (0.5 - 0.5 * Math.cos(2 * cyc)) * scale;
    // Crouch lowers the hips; the IK bends the knees to keep the feet down.
    py -= this.crouchSm * 0.34 * scale;
    // Landing dip + the drop the foot IK asked for.
    py += this.landDip * scale;
    py -= this.pelvisDrop;
    // Idle weight shift: a slow drift from one leg to the other.
    const shiftT = this.breath / GAIT.idle.shiftPeriod;
    const idleW = clamp01(1 - this.speedSm / 0.9) * (1 - this.airSm);
    this.idleShift = approach(
      this.idleShift,
      Math.sin(shiftT * Math.PI * 2) * 0.9 + hashNoise(shiftT * 0.7, 11) * 0.3,
      0.8, dt
    );
    const breathe = Math.sin(this.breath * Math.PI * 2 * GAIT.idle.breathFreq);

    let px = Math.cos(cyc) * g.sway * scale;
    px += idleW * this.idleShift * GAIT.idle.shiftAmp * scale;
    py += idleW * breathe * GAIT.idle.breathAmp * 0.4 * scale;

    // Airborne: tuck the hips a little and let the legs trail.
    py -= this.airSm * 0.03 * scale;

    b.hips.position.x += px;
    b.hips.position.y += py;

    /* ---- the swing, from the waist down --------------------------------- */
    // -1 wound up, +1 followed through. The pelvis leads, the shoulders follow
    // it by a further 30 %, the hips drop into it and the weight shifts across.
    const M = GAIT.melee;
    const sw = this.swing * this.swingW;
    const swAbs = Math.abs(sw);
    if (this.swingW > 0.001) {
      px += sw * M.shift * scale;
      py -= swAbs * M.drop * scale;
    }

    // Pelvis rotation: roll toward the swing leg, counter-yaw with the stride.
    const hipRoll = -Math.cos(cyc) * g.roll * (1 - this.airSm);
    const hipYaw = Math.cos(cyc) * g.yaw * this.forwardSm * (1 - this.airSm)
      + sw * M.hipYaw;
    // NB: +X rotation tips a bone BACKWARD (its child runs up +Y, and +X
    // carries +Y toward +Z), so a forward lean is negative.
    // Wind-up leans BACK over the rear foot, the follow-through drives forward.
    const swLean = sw > 0 ? sw * M.lean : sw * M.windLean;
    const pelvisLean = -(g.lean * 0.35 + this.stumbleSm * 0.1 + swLean * 0.45);
    setEuler(b.hips, pelvisLean, hipYaw, hipRoll + idleW * this.idleShift * 0.035);

    /* ---- torso --------------------------------------------------------- */
    // Aim yaw is spread down the spine so the legs can keep striding while the
    // shoulders face the reticle.
    // The guard shares this channel at a smaller weight — see GUARD.blade.
    const turnW = Math.max(this.aimSm, this.guardSm * GUARD.blade);
    const want = clamp(angleDelta(s.faceYaw, s.aimYaw), -1.9, 1.9) * turnW;
    this.upperYaw = approach(this.upperYaw, want, 0.09, dt);
    const uy = this.upperYaw;

    const lean = g.lean * (1 - this.aimSm * 0.4) + this.crouchSm * 0.16
      + this.guardSm * GUARD.crouch;
    this.leanSm = approach(this.leanSm, lean, 0.1, dt);

    const spineYaw = -Math.cos(cyc) * GAIT.chestYaw * 0.4 * this.forwardSm * (1 - this.airSm);
    setEuler(
      b.spine,
      -this.leanSm * 0.45 + this.airSm * 0.06 - breathe * 0.006 - swLean * 0.4,
      uy * 0.3 + spineYaw + sw * M.chestYaw * 0.45,
      -Math.cos(cyc) * g.roll * 0.4 + this.strafeSm * 0.05 - sw * 0.1
    );
    setEuler(
      b.chest,
      -this.leanSm * 0.35 - breathe * 0.012 + this.aimSm * 0.05 - swLean * 0.5,
      uy * 0.42 + spineYaw * 1.3 + sw * M.chestYaw * 0.55,
      -this.strafeSm * 0.06 - sw * 0.14
    );

    /* ---- head ---------------------------------------------------------- */
    // The head is stabilised: it counters the torso lean and the bounce, then
    // looks where the camera looks.
    const lookYaw = clamp(angleDelta(s.faceYaw + uy * 0.72, s.aimYaw), -1.1, 1.1);
    const lookPitch = clamp(s.aimPitch, -0.9, 0.7);
    this.headYaw = approach(this.headYaw, lookYaw, 0.1, dt);
    this.headPitch = approach(this.headPitch, lookPitch * (0.35 + 0.5 * this.aimSm), 0.12, dt);
    // Through a swing the head holds the target while the shoulders rotate
    // under it — a strike that turns the face away from what it is hitting is
    // the single loudest tell that an animation is procedural.
    const headCounter = -sw * M.chestYaw * M.headLag;
    // Chin down behind the hands. +X tips a bone BACKWARD (see the pelvis note
    // above), so the tuck is negative.
    const tuck = this.guardSm * GUARD.chinTuck;
    setEuler(
      b.neck,
      this.leanSm * 0.42 - this.headPitch * 0.45 + swLean * 0.2 - tuck * 0.45,
      this.headYaw * 0.42 + headCounter * 0.45,
      0
    );
    setEuler(
      b.head,
      this.leanSm * 0.36 - this.headPitch * 0.55 - tuck * 0.55 + idleW * hashNoise(this.breath * 0.31, 7) * GAIT.idle.headAmp,
      this.headYaw * 0.58 + headCounter * 0.55 + idleW * hashNoise(this.breath * 0.23, 3) * GAIT.idle.headAmp * 1.6,
      Math.sin(cyc) * 0.02 * (1 - this.airSm)
    );

    /* ---- clavicles ----------------------------------------------------- */
    const shrug = breathe * 0.012 * idleW + speedT * 0.03 + this.guardSm * GUARD.shrug;
    setEuler(b.clavR, 0, 0, -shrug);
    setEuler(b.clavL, 0, 0, shrug);

    if (this.driveSm > 0.5) {
      this._poseDriving(dt, s);
      return;
    }

    if (this.deadSm > 0.02) this._poseDead(dt, s);

    if (this.swimSm > 0.5) {
      this._poseSwim(dt, s);
      return;
    }

    /* ---- legs ---------------------------------------------------------- */
    this.rig.root.updateMatrixWorld(true);
    this._solveLegs(dt, s);

    /* ---- arms ---------------------------------------------------------- */
    this._poseArms(dt, s, cyc, speedT);
  }

  /* ==================================================================== */
  /* the collapse                                                         */
  /* ==================================================================== */

  /**
   * WASTED. Not a ragdoll — `physics` owns those and the player capsule has
   * already left the world by the time this runs — but a body that is still
   * standing to attention under the death card is worse than either. The hips
   * fall, the torso folds forward and the head goes with it.
   */
  _poseDead(dt, s) {
    const b = this.rig.bones;
    const scale = this.rig.scale ?? 1;
    const D = GAIT.death;
    const k = this.deadSm;
    b.hips.position.y -= k * D.drop * scale;
    // Fold about the hips, then let the spine carry the rest of it.
    setEuler(b.hips, -k * D.fold * 0.55, k * 0.35, k * 0.5);
    setEuler(b.spine, -k * D.fold * 0.3, k * 0.12, k * 0.2);
    setEuler(b.chest, -k * D.fold * 0.22, 0, k * 0.16);
    setEuler(b.neck, k * 0.42, 0, k * 0.18);
    setEuler(b.head, k * 0.5, k * 0.2, 0);
    void dt; void s;
  }

  /* ==================================================================== */
  /* swimming                                                             */
  /* ==================================================================== */

  /**
   * A swimmer LIES DOWN. The previous behaviour left the walk cycle switched
   * off and the legs hanging, so a character in the Monongahela was a vertical
   * mannequin bobbing downstream — which, since Carson's entire arc is on the
   * water, is a third of the map's worth of the game reading as broken.
   *
   * The body pitches toward horizontal as the stroke picks up, the hips lift by
   * enough to keep the head at the waterline through that rotation, the legs
   * flutter and the arms take alternate over-arm strokes. Treading water (no
   * input) keeps him nearly upright with a slow scull, which is the pose you
   * want when you are looking for a bank.
   */
  _poseSwim(dt, s) {
    const b = this.rig.bones;
    const P = GAIT.swimPose;
    const scale = this.rig.scale ?? 1;
    const w = this.swimSm;
    const mv = clamp01(this.speedSm / Math.max(0.4, MOVE.swimSpeed));
    const ph = this.swimPhase;
    // Submerged, the stroke slows and the body straightens out into a dive.
    const sub = clamp01(s.submerged ?? 0);

    const pitch = lerp(P.treadPitch, P.swimPitch, mv) * w;
    // Rotating about the hips would drop the head below the waterline; lifting
    // by the sagitta of that rotation puts it back on the surface.
    const hipToHead = Math.max(0.2, (1.6 - this.hipHeight)) * scale;
    b.hips.position.y += (1 - Math.cos(pitch)) * hipToHead * P.lift;
    const roll = Math.sin(ph) * P.roll * mv;
    setEuler(b.hips, -pitch, roll * 0.4, roll);
    setEuler(b.spine, -pitch * 0.12 + sub * 0.06, roll * 0.3, roll * 0.6);
    setEuler(b.chest, -pitch * 0.1, roll * 0.35, roll * 0.7);
    // Head up out of the water when surfaced, tucked in line when under.
    setEuler(b.neck, pitch * 0.45 * (1 - sub), 0, 0);
    setEuler(b.head, pitch * 0.4 * (1 - sub) - this.headPitch * 0.3, this.headYaw * 0.35, 0);

    this.rig.root.updateMatrixWorld(true);

    /* ---- flutter kick ---- */
    for (let i = 0; i < 2; i++) {
      const suffix = i === 0 ? 'R' : 'L';
      const sgn = i === 0 ? 1 : -1;
      const kick = Math.sin(ph * 2 + (i === 0 ? 0 : Math.PI));
      const thigh = b['thigh' + suffix];
      setEuler(
        thigh,
        kick * P.kick * (0.35 + 0.65 * mv) - pitch * 0.55,
        0,
        sgn * 0.05
      );
      setEuler(b['shin' + suffix], Math.max(0, -kick) * P.kickKnee * (0.4 + 0.6 * mv) + 0.12, 0, 0);
      setEuler(b['foot' + suffix], -0.55, 0, 0);
      thigh.updateWorldMatrix(false, true);
      // The IK memory must not carry a stale ground offset back onto dry land.
      this.foot[i].ikY = 0;
      this.foot[i].planted = false;
      this.foot[i].wasPlanted = false;
      this.foot[i].locked = false;
    }

    /* ---- over-arm stroke ---- */
    const reach = lerp(P.treadArm, P.strokeReach, mv);
    for (let i = 0; i < 2; i++) {
      const suffix = i === 0 ? 'R' : 'L';
      const side = i === 0 ? 1 : -1;
      const a = ph + (i === 0 ? 0 : Math.PI);
      const arm = b['arm' + suffix];
      // One stroke: the shoulder sweeps from overhead down past the hip and
      // recovers over the top, so the elbow closes on the pull and opens on
      // the recovery.
      const swing = -Math.cos(a) * reach * 0.5 - reach * 0.25;
      const pull = clamp01(Math.sin(a) * 0.5 + 0.5);
      setEuler(arm, swing - pitch * 0.35, side * (0.12 + pull * 0.2), side * (0.28 + pull * 0.35));
      setEuler(b['forearm' + suffix], 0.28 + pull * P.strokeElbow * (0.3 + 0.7 * mv), 0, 0);
      setEuler(b['hand' + suffix], 0.15, 0, side * 0.1);
      arm.updateWorldMatrix(false, true);
    }
    this.pelvisDrop = approach(this.pelvisDrop, 0, GAIT.ik.pelvisTau, dt);
  }

  /* ==================================================================== */
  /* legs                                                                 */
  /* ==================================================================== */

  /**
   * Analytic foot position for normalised phase p, written into `out` in
   * character-local space (x right, y up, -z forward).
   */
  _footLocal(p, side, out) {
    const g = this.g;
    const plant = g.plant;
    const A = g.stride * plant; // body travel while this foot is down
    const rollAt = plant * ROLL_START;
    const front = g.strike;
    const linearRate = A / plant;

    let fore, lift, ankle;
    if (p < rollAt) {
      // dead planted — the foot is motionless in the world
      fore = front - p * linearRate;
      lift = 0;
      ankle = -0.22 * (1 - clamp01(p / (plant * 0.16))); // heel strike, toe up
    } else if (p < plant) {
      const t = (p - rollAt) / (plant - rollAt);
      const e = t * t * (3 - 2 * t);
      fore = front - rollAt * linearRate - e * (plant - rollAt) * linearRate * ROLL_TRAVEL;
      lift = g.lift * 0.34 * e * e;
      ankle = 0.55 * e; // heel off, toe down
    } else {
      const t = (p - plant) / (1 - plant);
      const back = front - rollAt * linearRate - (plant - rollAt) * linearRate * ROLL_TRAVEL;
      const e = smoothstep(t);
      fore = back + (front - back) * e;
      // Lift peaks early in the swing, like a real leg pulling through.
      const arc = Math.sin(Math.pow(clamp01(t), 0.78) * Math.PI);
      lift = g.lift * arc + g.lift * 0.34 * (1 - e) * (1 - e);
      ankle = lerp(0.55, -0.22, smoothstep(clamp01((t - 0.2) / 0.8)));
    }

    const scale = this.rig.scale ?? 1;
    out.set(
      side * this.hipHalfWidth + side * this.strafeSm * 0.02,
      this.soleY + lift * scale,
      -fore * scale
    );
    return ankle;
  }

  _solveLegs(dt, s) {
    const b = this.rig.bones;
    const root = this.rig.root;
    const phys = this.physics;
    const p = this.phase / (Math.PI * 2);
    let maxDeficit = 0;

    for (let i = 0; i < 2; i++) {
      const isLeft = i === 1;
      const suffix = isLeft ? 'L' : 'R';
      const side = isLeft ? -1 : 1;
      const f = this.foot[i];
      const fp = ((isLeft ? p + 0.5 : p) % 1 + 1) % 1;

      let ankle = this._footLocal(fp, side, this._v);
      // Airborne / swimming: forget the gait and hang the legs.
      if (this.airSm > 0.01) {
        const airFore = lerp(0, s.verticalVel > 0 ? 0.12 : -0.05, 1) * side * 0;
        this._v.z = lerp(this._v.z, 0.06 + (side > 0 ? 0.02 : -0.02) + airFore, this.airSm);
        this._v.y = lerp(this._v.y, this.soleY + 0.16 * (1 - clamp01(s.groundDist ?? 1)), this.airSm);
        ankle = lerp(ankle, -0.35, this.airSm);
      }
      if (this.stumbleSm > 0.01) {
        this._v.x += side * this.stumbleSm * 0.05 * Math.sin(this.breath * 22 + i);
      }

      // to world
      root.localToWorld(this._v);

      /* ---- ground trace under the foot ---- */
      const G = GAIT.ik;
      let groundY = s.y + this.soleY;
      f.normal.set(0, 1, 0);
      f.surface = s.surface ?? 'concrete';
      if (phys && !s.swim) {
        const hit = phys.raycast(
          this._v.x, this._v.y + G.probeUp, this._v.z,
          0, -1, 0, G.probeUp + G.probeDown, phys.MASK.WORLD
        );
        if (hit.hit) {
          groundY = hit.point.y + this.soleY;
          f.normal.copy(hit.normal);
          f.surface = hit.surface;
        }
      }
      // Planted feet snap onto the ground; swinging feet only get raised.
      // The test is the HARD grounded flag, not the smoothed one: during the
      // first frames of a fall the smoothed value is still low, and a foot that
      // reports planted while the body is dropping drags its world target with
      // it — which is exactly the foot-sliding this whole scheme exists to
      // prevent, and it showed up as 900 mm of drift in one frame.
      const planted = fp < this.g.plant && s.grounded && this.airSm < 0.35;
      // `locked` excludes the roll-over, where the ankle legitimately moves
      // while the toe stays put. It is the window that must not slide at all.
      f.locked = planted && fp < this.g.plant * ROLL_START;
      const desired = planted ? groundY : Math.max(this._v.y, groundY);
      f.ikY = approach(f.ikY, desired - this._v.y, planted ? G.tau : G.tau * 2.2, dt);
      this._v.y += f.ikY;
      f.target.copy(this._v);
      f.wasPlanted = f.planted;
      f.planted = planted;

      /* ---- reach check: the pelvis drops if the leg cannot make it ---- */
      const hip = b['thigh' + suffix];
      hip.updateWorldMatrix(true, false);
      this._v2.setFromMatrixPosition(hip.matrixWorld);
      const need = this._v2.distanceTo(f.target);
      const deficit = need - (this.legLength - GAIT.ik.kneeMin);
      if (deficit > maxDeficit) maxDeficit = deficit;

      /* ---- knee pole: forward and slightly outward ---- */
      this._pole.copy(this._fwd).multiplyScalar(1).addScaledVector(this._right, side * 0.24);
      this._pole.y += 0.16 + this.crouchSm * 0.35;
      this._pole.normalize();

      solveTwoBone(
        hip, b['shin' + suffix],
        this._rest['thigh' + suffix], this._rest['shin' + suffix],
        this._len['thigh' + suffix], this._len['shin' + suffix],
        f.target, this._pole, GAIT.ik.kneeMin
      );

      /* ---- ankle ---- */
      f.smNormal.lerp(f.normal, 1 - Math.exp(-dt / GAIT.ik.alignTau)).normalize();
      // Foot forward: the character forward pitched by the gait's ankle angle,
      // then rolled onto the surface.
      this._v3.copy(this._fwd);
      this._v3.addScaledVector(this._up, -Math.sin(ankle));
      this._v3.normalize();
      // Blend the surface normal in only as far as the slope limit allows.
      this._v2.copy(this._up).lerp(f.smNormal, planted ? 0.85 : 0.25).normalize();
      orientBone(b['foot' + suffix], this._rest['foot' + suffix], this.footRestUp, this._v3, this._v2);
      b['foot' + suffix].updateWorldMatrix(false, true);

      /* ---- footfall event ---- */
      if (planted && !f.wasPlanted) {
        const e = this.footEvent;
        e.pending = true;
        e.left = isLeft;
        e.x = f.target.x; e.y = f.target.y - this.soleY; e.z = f.target.z;
        e.surface = f.surface;
      }
    }

    // Smooth the pelvis drop so a kerb is absorbed rather than snapped.
    this.pelvisDrop = approach(
      this.pelvisDrop,
      Math.min(GAIT.ik.maxPelvisDrop, Math.max(0, maxDeficit)),
      GAIT.ik.pelvisTau, dt
    );
  }

  /* ==================================================================== */
  /* arms                                                                 */
  /* ==================================================================== */

  _poseArms(dt, s, cyc, speedT) {
    const b = this.rig.bones;
    const g = this.g;

    // FK swing, counter-phased to the legs.
    const swing = Math.cos(cyc) * g.arm * this.forwardSm;
    const elbowBase = 0.22 + g.elbow * 0.72 + this.crouchSm * 0.3;
    const elbowSwing = g.elbow * 0.42;

    for (const suffix of ['R', 'L']) {
      const side = suffix === 'R' ? 1 : -1;
      const sgn = suffix === 'R' ? -1 : 1; // right arm goes back when right leg goes forward
      const arm = b['arm' + suffix];
      const fore = b['forearm' + suffix];
      const hand = b['hand' + suffix];

      const x = sgn * swing + this.airSm * -0.35 + this.stumbleSm * 0.5 * Math.sin(this.breath * 17 + side);
      const z = side * (0.085 + speedT * 0.055 + this.crouchSm * 0.05 + this.stumbleSm * 0.5);
      const y = side * (-0.05 - speedT * 0.12);
      setEuler(arm, x, y, z);
      setEuler(fore, elbowBase + Math.max(0, sgn * Math.cos(cyc)) * elbowSwing + this.airSm * 0.5, 0, 0);
      setEuler(hand, 0.12, 0, side * 0.12);
    }

    if (this.aimSm > 0.01) this._poseAim(dt, s);
    // After the aim, so that on a build where both somehow arrive the guard
    // wins the hands. They are mutually exclusive by construction —
    // `player._updateAds` refuses to raise `aim` with a melee weapon in hand,
    // and `MeleeReach` refuses to raise the guard without one — but "by
    // construction" in another file is not a reason to leave the order to luck.
    if (this.guardSm > 0.01) this._poseGuard(dt, s);
  }

  /**
   * Two-handed aim. The grip point is authored in CHEST space so the hands
   * follow the counter-rotated torso, then both arms IK to it.
   */
  _poseAim(dt, s) {
    const b = this.rig.bones;
    const w = this.aimSm;
    const scale = this.rig.scale ?? 1;
    b.chest.updateWorldMatrix(true, false);

    const shoulder = this.rig.side; // +1 right shoulder, -1 left
    // Grip in chest-local metres: forward is -Z in bind space.
    this._v.set(0.12 * shoulder * scale, 0.14 * scale, -0.34 * scale);
    // pitch the grip with the aim so the weapon tracks vertically
    const pitch = clamp(s.aimPitch, -0.9, 0.7);
    this._v.y += Math.sin(pitch) * 0.3 * scale;
    this._v.z -= (Math.cos(pitch) - 1) * 0.3 * scale;
    b.chest.localToWorld(this._v);
    const gripR = this._v3.copy(this._v);

    // support hand, a little further out and across
    this._v2.set(-0.02 * shoulder * scale, 0.13 * scale, -0.5 * scale);
    this._v2.y += Math.sin(pitch) * 0.44 * scale;
    this._v2.z -= (Math.cos(pitch) - 1) * 0.44 * scale;
    b.chest.localToWorld(this._v2);

    for (const suffix of ['R', 'L']) {
      const side = suffix === 'R' ? 1 : -1;
      const target = suffix === 'R' ? gripR : this._v2;
      const arm = b['arm' + suffix];
      const fore = b['forearm' + suffix];

      // Blend from the FK swing pose to the IK pose.
      this._q.copy(arm.quaternion);
      this._pole.copy(this._right).multiplyScalar(side * 0.75);
      this._pole.y -= 0.9;
      this._pole.addScaledVector(this._fwd, -0.25);
      this._pole.normalize();

      solveTwoBone(
        arm, fore,
        this._rest['arm' + suffix], this._rest['forearm' + suffix],
        this._len['arm' + suffix], this._len['forearm' + suffix],
        target, this._pole, 0.05
      );
      if (w < 0.999) {
        arm.quaternion.slerp(this._q, 1 - w);
        // the forearm blend is implicit: re-solve is cheap enough to skip
      }
      arm.updateWorldMatrix(false, true);
    }
  }

  /**
   * THE GUARD — hands up, elbows in.
   *
   * Same machinery as `_poseAim` (chest-local targets, two-bone IK, a blend
   * back to the FK swing by weight) and deliberately so: the difference between
   * a man aiming and a man covering up is WHERE the hands are and where the
   * elbows point, not which solver put them there.
   *
   * Two things it does that the aim does not:
   *
   *   - the pole vector points DOWN AND INWARD rather than down and out, which
   *     is what tucks the elbows against the ribs. An elbow winged out to the
   *     side is the difference between a guard and a shrug, and it is the first
   *     thing that reads wrong from the chase camera.
   *   - the targets are NOT pitched with the look. `_poseAim` swings its grip
   *     up and down with `aimPitch` because the weapon has to track vertically;
   *     a guard stays at the cheekbones however far down you are looking.
   *
   * The torso half of the pose is up in `_pose` with the rest of the spine
   * (hunch, chin tuck, blade, shrug) — it has to be applied before the chest
   * matrix these targets are expressed in is composed.
   */
  _poseGuard(dt, s) {
    const b = this.rig.bones;
    const w = this.guardSm;
    const scale = this.rig.scale ?? 1;
    b.chest.updateWorldMatrix(true, false);

    const shoulder = this.rig.side; // +1 right shoulder, -1 left
    // Rear hand, on the camera-shoulder side, by the cheekbone.
    const R = GUARD.rear;
    this._v.set(R.x * shoulder * scale, R.y * scale, R.z * scale);
    b.chest.localToWorld(this._v);
    const rear = this._v3.copy(this._v);

    // Lead hand: across the centre line and further out.
    const L = GUARD.lead;
    this._v2.set(L.x * shoulder * scale, L.y * scale, L.z * scale);
    b.chest.localToWorld(this._v2);

    for (const suffix of ['R', 'L']) {
      const side = suffix === 'R' ? 1 : -1;
      // The hand on the shoulder side is the REAR hand.
      const target = side === shoulder ? rear : this._v2;
      const arm = b['arm' + suffix];
      const fore = b['forearm' + suffix];

      this._q.copy(arm.quaternion);
      // Down, and INWARD across the body — the elbow tucks to the ribs.
      this._pole.copy(this._right).multiplyScalar(-side * 0.35);
      this._pole.y -= 1.0;
      this._pole.addScaledVector(this._fwd, -0.35);
      this._pole.normalize();

      solveTwoBone(
        arm, fore,
        this._rest['arm' + suffix], this._rest['forearm' + suffix],
        this._len['arm' + suffix], this._len['forearm' + suffix],
        target, this._pole, 0.05
      );
      if (w < 0.999) arm.quaternion.slerp(this._q, 1 - w);
      arm.updateWorldMatrix(false, true);
      // Knuckles turned in toward the face rather than left hanging in the
      // wrist's rest roll. Blended off the FK values `_poseArms` just wrote, so
      // a half-raised guard is half way there rather than snapping.
      setEuler(
        b['hand' + suffix],
        lerp(0.12, -0.35, w), 0, side * lerp(0.12, 0.42, w)
      );
    }
  }

  /* ==================================================================== */
  /* driving                                                              */
  /* ==================================================================== */

  /**
   * Seated pose. The legs fold into the footwell, the hands hold a wheel whose
   * position the vehicle handler hands over, and the head leans into corners —
   * the chase camera looks through the glass and will see all of it.
   */
  _poseDriving(dt, s) {
    const b = this.rig.bones;
    const scale = this.rig.scale ?? 1;
    const steer = clamp(s.steer ?? 0, -1, 1);
    const lat = clamp(s.lateral ?? 0, -1, 1);

    /**
     * SIT DOWN. The pelvis falls to seat height and the whole torso comes with
     * it (every bone above the hips is its child), which is what puts the head
     * under the roofline instead of through it — `player/vehicle.js` places the
     * root by subtracting exactly this pose's head height, so the two have to
     * be read off the same record.
     *
     * It is also what makes the leg IK below solvable: from the standing bind
     * pelvis the pedals were 0.97 m away down an 0.83 m leg, so the solver
     * saturated every frame and both legs came out straight.
     */
    b.hips.position.y -= (GAIT.seat.hipDrop + 0.02) * scale;
    setEuler(b.hips, 0.12, 0, 0);
    setEuler(b.spine, -0.1, -lat * 0.05, lat * 0.08);
    setEuler(b.chest, -0.06, -lat * 0.06, lat * 0.1);
    setEuler(b.neck, 0.04 - this.headPitch * 0.3, this.headYaw * 0.35 - lat * 0.1, lat * 0.12);
    setEuler(b.head, 0.02 - this.headPitch * 0.4, this.headYaw * 0.5 - lat * 0.14, lat * 0.16);

    this.rig.root.updateMatrixWorld(true);

    // Legs: knees up and forward, feet on the pedals.
    for (const suffix of ['R', 'L']) {
      const side = suffix === 'R' ? 1 : -1;
      const hip = b['thigh' + suffix];
      hip.updateWorldMatrix(true, false);
      this._v.set(
        side * (this.hipHalfWidth + 0.03) * scale,
        this.soleY + 0.02 * scale,
        -(0.42 + (suffix === 'R' ? 0.04 : 0)) * scale
      );
      this.rig.root.localToWorld(this._v);
      this._pole.copy(this._fwd).addScaledVector(this._right, side * 0.45);
      this._pole.y += 0.9;
      this._pole.normalize();
      solveTwoBone(
        hip, b['shin' + suffix],
        this._rest['thigh' + suffix], this._rest['shin' + suffix],
        this._len['thigh' + suffix], this._len['shin' + suffix],
        this._v, this._pole, 0.04
      );
      this._v2.copy(this._fwd);
      this._v2.y -= 0.35;
      orientBone(b['foot' + suffix], this._rest['foot' + suffix], this.footRestUp, this._v2.normalize(), this._up);
      b['foot' + suffix].updateWorldMatrix(false, true);
    }

    // Hands on the wheel: a circle in chest space, rotated by the steer input.
    b.chest.updateWorldMatrix(true, false);
    const wheelR = 0.17 * scale;
    for (const suffix of ['R', 'L']) {
      const side = suffix === 'R' ? 1 : -1;
      const a = -steer * 1.5 + side * 1.15;
      this._v.set(
        Math.sin(a) * wheelR,
        0.1 * scale + Math.cos(a) * wheelR,
        -0.36 * scale
      );
      b.chest.localToWorld(this._v);
      const arm = b['arm' + suffix];
      this._pole.copy(this._right).multiplyScalar(side * 0.8);
      this._pole.y -= 1.0;
      this._pole.normalize();
      solveTwoBone(
        arm, b['forearm' + suffix],
        this._rest['arm' + suffix], this._rest['forearm' + suffix],
        this._len['arm' + suffix], this._len['forearm' + suffix],
        this._v, this._pole, 0.05
      );
      arm.updateWorldMatrix(false, true);
    }
  }

  /* ==================================================================== */

  /** Force the whole rig back to a clean idle — used after a teleport. */
  reset() {
    this.phase = 0;
    this.prevPhase = 0;
    this.landDip = 0;
    this.landVel = 0;
    this.pelvisDrop = 0;
    this.speedSm = 0;
    this.airSm = 0;
    this.aimSm = 0;
    this.guardSm = 0;
    this.upperYaw = 0;
    for (const f of this.foot) {
      f.ikY = 0;
      f.planted = false;
      f.wasPlanted = false;
      f.smNormal.set(0, 1, 0);
    }
  }
}

export { STANCE };
