/**
 * PEDS — the animation runtime.
 *
 * LAYERS, in evaluation order
 *   1  locomotion base   idle / wait / lean / walk / jog / run, crossfaded, with
 *                        the phase driven by REAL GROUND SPEED and a per-person
 *                        stride length so nobody skates
 *   2  behaviour         phone, smoke, talk, pockets, folded arms, carry,
 *                        umbrella, gawk, film, flee, hurt — all additive, so a
 *                        pedestrian can check a phone while walking
 *   3  one-shots         flinch, punch, dive, turn-in-place
 *
 * IK, after the pose is written to the bones
 *   A  look-at  — neck and head track what interests them, clamped to human
 *                 limits and rate-limited so the head does not snap
 *   B  foot     — ground probe per foot, the pelvis drops to keep both planted,
 *                 two-bone solve per leg, sole rolled onto the surface normal
 *
 * Everything is preallocated: `update()` does not allocate.
 */

import * as THREE from 'three';
import * as C from './clips.js';

/** Hip joint to ankle joint in the bind pose, metres (see rig.js BONES). */
const HIP_TO_ANKLE = 0.836;
/**
 * How much of the straight-leg foot travel the flexed rig actually delivers,
 * per clip. MEASURED with `gaitprobe.mjs` rather than assumed — a walking leg
 * is nearly straight through stance and loses reach to the knee, a sprinting
 * one is folded far harder and the pelvic and ankle contributions more than
 * make it back, so one constant cannot serve all three. Re-measure by reading
 * the REACH column: it prints achieved against required.
 */
const KNEE_SHORTEN = { walk: 0.757, jog: 0.972, run: 1.026 };

/**
 * Ankle joint height above the sole in the bind pose, metres at scale 1. The
 * foot IK targets the ANKLE, so this is what separates "where the bone is"
 * from "where the ground is" — and anything drawing a contact mark needs the
 * second one. It was a bare literal inside `_footIk`; `footContact` has to
 * undo exactly the same offset, so it is a shared constant now.
 */
const ANKLE_H = 0.082;

const DEG = Math.PI / 180;

class Poser {
  constructor(rig) {
    this.rig = rig;
    this.d3 = new Float32Array(rig.count * 3);
    this.hipOff = new THREE.Vector3();
    this.w = 1;
    this._idx = new Map();
    for (let i = 0; i < rig.count; i++) this._idx.set(rig.names[i], i);
  }

  reset() {
    this.d3.fill(0);
    this.hipOff.set(0, 0, 0);
    this.w = 1;
  }

  d(name, x, y, z) {
    const i = this._idx.get(name);
    if (i === undefined) return;
    const w = this.w;
    this.d3[i * 3] += x * w;
    this.d3[i * 3 + 1] += y * w;
    this.d3[i * 3 + 2] += z * w;
  }

  hip(dx, dy, dz) {
    const w = this.w;
    this.hipOff.x += dx * w;
    this.hipOff.y += dy * w;
    this.hipOff.z += dz * w;
  }
}

export class PedAnimator {
  /** Act layers that occupy the hands. Mutually exclusive — see `setAct`. */
  static HAND_ACTS = ['pockets', 'folded', 'carry', 'phone', 'smoke', 'umbrella', 'film', 'gawk'];

  /**
   * @param rig    the shared Rig
   * @param bones  this instance's THREE.Bone array (same order as the rig)
   * @param opts   { gait, height, scale, probe }
   */
  constructor(rig, bones, opts = {}) {
    this.rig = rig;
    this.bones = bones;
    this.gait = opts.gait ?? {};
    this.height = opts.height ?? 1.75;
    this.scale = opts.scale ?? 1;
    this.probe = opts.probe ?? null;
    this.enabled = true;
    this.footIk = true;
    /** The world stance lock. Off only for `gaitprobe.mjs`'s pose pass. */
    this.footLock = true;

    this.P = new Poser(rig);

    this.state = {
      clip: 'idle',
      speed: 0,
      lookTarget: null,
      lookWeight: 0,
    };

    /** Additive behaviour weights, all 0..1, eased toward their targets. */
    this.act = {
      phone: 0, smoke: 0, talk: 0, pockets: 0, folded: 0, carry: 0,
      umbrella: 0, gawk: 0, film: 0, flee: 0, hurt: 0,
    };
    this.actTarget = { ...this.act };
    this.actSide = { phone: 1, smoke: -1, carry: 1, umbrella: -1 };
    this.talkEnergy = 1;

    this.phase = 0;
    this.idlePhase = opts.gait?.phase ?? 0;
    /**
     * Seat arguments for the `sit` clip: how hard the car is turning (-1..1)
     * and how much footwell there is under the root (0..1). Preallocated and
     * written in place — `Ped._seatedVisual` sets it every frame, and a fresh
     * object per pedestrian per frame is a garbage collector pause you can see
     * (rule 5). A field rather than a `setState` key because `setState` is
     * written to detect CHANGES of clip, and these change continuously.
     */
    this.seatArg = { steer: 0, drop: 0.4 };
    this.prevClip = 'idle';
    this.blend = 1;
    this.time = 0;

    // one-shots (negative = inactive)
    this.flinchT = -1;
    this.flinchK = 1;
    this.punchT = -1;
    this.punchSide = -1;
    this.diveT = -1;
    this.diveSide = 1;
    this.turnT = -1;
    this.turnDir = 1;

    this.iHips = rig.index('Hips');
    this.iNeck = rig.index('Neck');
    this.iHead = rig.index('Head');
    /**
     * ANATOMICAL RANGE PER BONE, degrees of DELTA from the bind pose, as
     * [xMin, xMax, yMin, yMax, zMin, zMax]. Nothing else in this system has
     * any joint limits at all — the ragdoll's cones in `rig.js` are measured in
     * a different frame against welding stubs and are never consulted here — so
     * this table is the only thing standing between a dozen additive layers and
     * an arm folded through the ribcage.
     *
     * Every value is chosen to clear the widest single authored clip by a
     * margin, so no clip changes when it plays alone: `cower` needs Forearm
     * +104 and UpperArm +96, `punch` needs Forearm +92 and UpperArm +82,
     * `dive` needs Leg -96. The limits only bind on a SUM.
     */
    const LIMITS = {
      Spine: [-33, 42, -38, 38, -28, 28],
      Spine1: [-33, 42, -38, 38, -28, 28],
      Spine2: [-35, 45, -45, 45, -30, 30],
      Neck: [-45, 45, -60, 60, -35, 35],
      Head: [-42, 42, -70, 70, -35, 35],
      ClavicleR: [-28, 28, -22, 22, -22, 22],
      ClavicleL: [-28, 28, -22, 22, -22, 22],
      UpperArmR: [-60, 168, -90, 90, -95, 95],
      UpperArmL: [-60, 168, -90, 90, -95, 95],
      ForearmR: [-12, 150, -80, 80, -28, 28],
      ForearmL: [-12, 150, -80, 80, -28, 28],
      HandR: [-80, 80, -80, 80, -32, 32],
      HandL: [-80, 80, -80, 80, -32, 32],
      UpLegR: [-32, 124, -45, 45, -45, 45],
      UpLegL: [-32, 124, -45, 45, -45, 45],
      LegR: [-148, 6, -30, 30, -22, 22],
      LegL: [-148, 6, -30, 30, -22, 22],
      FootR: [-46, 36, -28, 28, -28, 28],
      FootL: [-46, 36, -28, 28, -28, 28],
    };
    this._limits = new Array(rig.count).fill(null);
    for (const [name, v] of Object.entries(LIMITS)) {
      if (rig.has(name)) this._limits[rig.index(name)] = v;
    }

    this.iHandR = rig.index('HandR');
    this.iHandL = rig.index('HandL');
    this.legs = [
      [rig.index('UpLegR'), rig.index('LegR'), rig.index('FootR')],
      [rig.index('UpLegL'), rig.index('LegL'), rig.index('FootL')],
    ];

    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._q3 = new THREE.Quaternion();
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
    this._qc = new THREE.Quaternion();
    this._qd = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._v4 = new THREE.Vector3();
    this._v5 = new THREE.Vector3();
    this._pole = new THREE.Vector3();
    this._elbow = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._probeOut = { y: 0, nx: 0, ny: 1, nz: 0, hit: false };
    this._footY = [0, 0];
    this._footN = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)];
    /** How far each ankle is above its own ground this frame. */
    this._footAbove = [0, 0];
    this._planted = [false, false];
    /**
     * Did the ground probe find anything under this foot on the last solve?
     * False also while the IK is not running at all (ragdoll, dive, disabled),
     * so a reader can tell "no ground here" from "stale numbers".
     */
    this._footHit = [false, false];
    /** Smoothed pelvis drop, and the per-foot world stance lock. */
    this._drop = 0;
    this._dropApplied = 0;
    this._lock = [
      { x: 0, z: 0, w: 0 },
      { x: 0, z: 0, w: 0 },
    ];
  }

  setState(s) {
    const st = this.state;
    if (s.clip !== undefined && s.clip !== st.clip) {
      this.prevClip = st.clip;
      this.blend = 0;
      st.clip = s.clip;
    }
    if (s.speed !== undefined) st.speed = s.speed;
    if (s.lookTarget !== undefined) st.lookTarget = s.lookTarget;
    if (s.lookWeight !== undefined) st.lookWeight = s.lookWeight;
  }

  /** Ask for a behaviour layer; it eases in and out over ~0.4 s. */
  /**
   * ONE PAIR OF HANDS.
   *
   * `update()` applies every act layer additively with no exclusivity, and
   * `ped.js` never clears the resting carry an outfit set at spawn when it
   * later sets `gawk`, `film` or `hurt` — so a man with an umbrella who films a
   * crash was running `umbrella + film + gawk` on the SAME right arm, three
   * layers deep, and `hurtAdd` made it four. Every one of them is written for a
   * free arm. Adding them is not a blend, it is a sum, and the sum is what the
   * player saw as "arms contorted".
   *
   * These eight all say what the hands are DOING, so at most one can be true.
   * Raising any of them retargets the rest to zero and the existing 0.30-0.40 s
   * ramp cross-fades them, which is exactly the transition that was wanted.
   * `flee` and `hurt` stay outside the group: they are whole-body reactions, not
   * hand poses, and the limit table in the constructor bounds their sum.
   */
  setAct(name, target, side) {
    if (!(name in this.actTarget)) return;
    this.actTarget[name] = target;
    if (side !== undefined && name in this.actSide) this.actSide[name] = side;
    if (target > 0.002 && PedAnimator.HAND_ACTS.includes(name)) {
      for (const other of PedAnimator.HAND_ACTS) {
        if (other !== name && other in this.actTarget) this.actTarget[other] = 0;
      }
    }
  }

  clearActs(except) {
    for (const k in this.actTarget) if (k !== except) this.actTarget[k] = 0;
  }

  flinch(strength = 1) {
    if (this.flinchT >= 0 && this.flinchT < 0.12) return;
    this.flinchT = 0;
    this.flinchK = strength;
  }

  punchNow(side = -1) {
    if (this.punchT >= 0) return;
    this.punchT = 0;
    this.punchSide = side;
  }

  get punching() { return this.punchT >= 0; }

  diveNow(side = 1) {
    if (this.diveT >= 0) return;
    this.diveT = 0;
    this.diveSide = side;
  }

  get diving() { return this.diveT >= 0; }

  turn(dir) {
    if (this.turnT >= 0) return;
    this.turnT = 0;
    this.turnDir = dir >= 0 ? 1 : -1;
  }

  /**
   * Stride length in metres, from the person's height, their personal stride
   * multiplier and how fast they are actually going — a walking stride is about
   * 0.8 of your height, a sprinting one nearly 1.5 of it. Dividing ground speed
   * by this is what stops the feet skating, and it is the only place the
   * animation rate is allowed to come from.
   */
  strideLength(speed) {
    const g = this.gait;
    return Math.max(0.55, (0.62 + 0.155 * speed) * this.height * (g.strideK ?? 1));
  }

  /**
   * The hip flexion amplitude, in degrees, that this stride actually requires.
   *
   * Setting the phase RATE from the stride length was only half the job, and
   * the missing half is what made every pedestrian in the city skate. Over one
   * gait cycle the hips advance one stride; the foot is on the ground for
   * `DUTY` of that cycle and does not move; therefore the foot's peak-to-peak
   * travel RELATIVE TO THE HIPS is `stride * DUTY` metres, and the hip has to
   * be swung far enough to produce it. Nothing about that is a tuning
   * parameter — it is the definition of not sliding.
   *
   * `KNEE_SHORTEN` is measured, not guessed: at 23 degrees of authored hip
   * flexion the straight-leg model predicts 0.591 m of foot travel and the
   * live rig produced 0.505 m, because the knee is flexed through most of the
   * swing and the ankle rolls. 0.855 is that ratio, and `streetprobe.mjs`
   * checks the result in the running game rather than trusting it.
   */
  swingDegrees(speed, clip) {
    const stride = this.strideLength(speed);
    const need = stride * C.dutyOf(clip) * C.ANKLE_SHARE;
    const legLen = HIP_TO_ANKLE * this.scale * (KNEE_SHORTEN[clip] ?? KNEE_SHORTEN.walk);
    const s = Math.min(0.80, need / (2 * legLen));
    return (Math.asin(s) * 180) / Math.PI;
  }

  update(dt, now) {
    if (!this.enabled) return;
    this.time = now;
    const st = this.state;
    const P = this.P;
    const g = this.gait;

    /* --- phase: real ground speed / stride length --- */
    const clip = st.clip;
    const moving = clip === 'walk' || clip === 'jog' || clip === 'run';
    if (moving) {
      const hz = Math.max(0.28, st.speed / this.strideLength(st.speed));
      this.phase = (this.phase + dt * hz) % 1;
      // The rate and the amplitude have to come from the SAME stride or the
      // foot skates. `gait` is this pedestrian's own object, written in place.
      g.swingDeg = this.swingDegrees(st.speed, clip);
    } else {
      // idle clips run on their own slow clock
      this.phase = (this.phase + dt * 0.06) % 1;
    }
    this.idlePhase = (this.idlePhase + dt * 0.11 * (g.idleRate ?? 1)) % 1;
    if (this.blend < 1) this.blend = Math.min(1, this.blend + dt / 0.22);

    /* --- ease the behaviour weights --- */
    for (const k in this.act) {
      const t = this.actTarget[k];
      const cur = this.act[k];
      if (cur !== t) {
        const rate = dt / (t > cur ? 0.30 : 0.40);
        this.act[k] = t > cur ? Math.min(t, cur + rate) : Math.max(t, cur - rate);
      }
    }

    /* --- layer 1: locomotion, crossfaded --- */
    P.reset();
    const fn = C.CLIPS[clip] ?? C.idle;
    const prev = C.CLIPS[this.prevClip] ?? C.idle;
    const ph = moving ? this.phase : this.idlePhase;
    // The fourth argument is the seat record. Every other clip in the table
    // takes three and ignores it, so this stays one call site.
    const arg = this.seatArg;
    if (this.blend < 1) {
      P.w = 1 - this.blend;
      prev(P, ph, g, arg);
      P.w = this.blend;
      fn(P, ph, g, arg);
    } else {
      P.w = 1;
      fn(P, ph, g, arg);
    }

    /* --- layer 2: behaviours --- */
    P.w = 1;
    const a = this.act;
    const ip = this.idlePhase;
    if (a.pockets > 0.002) C.pocketsAdd(P, a.pockets);
    if (a.folded > 0.002) C.foldedAdd(P, a.folded);
    if (a.carry > 0.002) C.carryAdd(P, a.carry, this.actSide.carry);
    if (a.phone > 0.002) C.phoneAdd(P, a.phone, ip, this.actSide.phone);
    if (a.smoke > 0.002) C.smokeAdd(P, a.smoke, ip, this.actSide.smoke);
    if (a.talk > 0.002) C.talkAdd(P, a.talk, ip, this.talkEnergy);
    if (a.umbrella > 0.002) C.umbrellaAdd(P, a.umbrella, this.actSide.umbrella);
    if (a.gawk > 0.002) C.gawkAdd(P, a.gawk, ip);
    if (a.film > 0.002) C.filmAdd(P, a.film, ip);
    if (a.flee > 0.002) C.fleeAdd(P, a.flee, this.phase);
    if (a.hurt > 0.002) C.hurtAdd(P, a.hurt, ip);

    /* --- layer 3: one-shots --- */
    if (this.flinchT >= 0) {
      C.flinchAdd(P, this.flinchT / 0.55, this.flinchK);
      this.flinchT += dt;
      if (this.flinchT > 0.55) this.flinchT = -1;
    }
    if (this.punchT >= 0) {
      C.punch(P, this.punchT / 0.52, this.punchSide);
      this.punchT += dt;
      if (this.punchT > 0.52) this.punchT = -1;
    }
    if (this.diveT >= 0) {
      C.dive(P, this.diveT / 0.72, this.diveSide);
      this.diveT += dt;
      if (this.diveT > 0.72) this.diveT = -1;
    }
    if (this.turnT >= 0) {
      C.turnStep(P, this.turnT / 0.42, this.turnDir);
      this.turnT += dt;
      if (this.turnT > 0.42) this.turnT = -1;
    }

    this._writePose();

    const root = this.bones[0];
    root.updateMatrixWorld(true);

    this._dropApplied = 0;    // the pose write above reset the pelvis
    if (this.footIk && this.diveT < 0) this._footIk(dt);
    else this._footHit[0] = this._footHit[1] = false;
    if (st.lookTarget && st.lookWeight > 0.01) this._lookAt(st.lookTarget, st.lookWeight);
  }

  _writePose() {
    const rig = this.rig;
    const bones = this.bones;
    const d3 = this.P.d3;
    const e = this._e;
    const q = this._q;
    const lim = this._limits;
    for (let i = 0; i < rig.count; i++) {
      const L = lim[i];
      /**
       * CLAMP THE SUM, NOT THE CLIPS.
       *
       * `Poser.d` is `+=` and `update()` applies every behaviour layer
       * unconditionally on top of the base clip, with no blend, no exclusivity
       * and no bound. That is fine one layer at a time and it is not what the
       * game produces: `ped.js` never clears `umbrella`/`carry` when it sets
       * `gawk`/`film`/`hurt`, and `hurtAdd`, `gawkAdd` and `umbrellaAdd(-1)`
       * all target the SAME right arm. Measured, before this: a man with an
       * umbrella, filming a crash while hurt, in `cower`, reached
       * ForearmR = 300+ degrees of "flexion" and put his right hand 43 cm
       * through his own chest.
       *
       * Clamping here rather than in `clips.js` keeps every authored clip
       * exactly as written when it is the only thing playing, and only bites
       * when the sum leaves anatomy. See `LIMITS` and `poseprobe.mjs`.
       */
      let x = d3[i * 3], y = d3[i * 3 + 1], z = d3[i * 3 + 2];
      if (L) {
        if (x < L[0]) x = L[0]; else if (x > L[1]) x = L[1];
        if (y < L[2]) y = L[2]; else if (y > L[3]) y = L[3];
        if (z < L[4]) z = L[4]; else if (z > L[5]) z = L[5];
      }
      const b = bones[i];
      if (x || y || z) {
        e.set(x * DEG, y * DEG, z * DEG, 'XYZ');
        q.setFromEuler(e);
        b.quaternion.copy(rig.localQuat[i]).multiply(q);
      } else {
        b.quaternion.copy(rig.localQuat[i]);
      }
      if (i === 0) b.position.copy(rig.localPos[i]).add(this.P.hipOff);
      else b.position.copy(rig.localPos[i]);
      b.updateMatrix();
    }
  }

  _wp(i, out) {
    const m = this.bones[i].matrixWorld.elements;
    return out.set(m[12], m[13], m[14]);
  }

  _wq(i, out) {
    return this.bones[i].getWorldQuaternion(out);
  }

  _applyWorld(i, dq) {
    const b = this.bones[i];
    const parent = b.parent;
    const q = this._qa;
    if (parent) parent.getWorldQuaternion(q);
    else q.identity();
    const cur = this._qb.copy(q).multiply(b.quaternion);
    cur.premultiply(dq);
    b.quaternion.copy(q.invert()).multiply(cur);
    b.updateMatrix();
    b.updateMatrixWorld(true);
  }

  _aimBone(i, dir) {
    const wq = this._wq(i, this._qc);
    const cur = this._v5.set(0, 1, 0).applyQuaternion(wq);
    const dq = this._qd.setFromUnitVectors(cur, dir);
    this._applyWorld(i, dq);
  }

  /* ---------------- look-at ---------------- */

  _lookAt(target, weight) {
    const chain = [
      [this.iNeck, 0.36],
      [this.iHead, 0.64],
    ];
    for (const [bi, f] of chain) {
      const wq = this._wq(bi, this._q2);
      const fwd = this._v.set(0, 0, 1).applyQuaternion(wq);
      const want = this._v2.copy(target).sub(this._wp(bi, this._v3));
      if (want.lengthSq() < 1e-6) return;
      want.normalize();
      const dot = Math.min(1, Math.max(-1, fwd.dot(want)));
      let ang = Math.acos(dot) * weight * f;
      if (ang < 0.002) continue;
      // a person cannot look behind themselves, and the head does not snap
      if (ang > 0.42) ang = 0.42;
      const axis = this._v4.crossVectors(fwd, want);
      if (axis.lengthSq() < 1e-10) continue;
      axis.normalize();
      this._q3.setFromAxisAngle(axis, ang);
      this._applyWorld(bi, this._q3);
    }
  }

  /**
   * Re-solve ONLY the feet, for the frames on which the pose is skipped.
   *
   * Animation rate LOD skips the pose write for distant pedestrians, but the
   * BODY still moves on every one of those frames — `Ped.updateVisual` copies
   * the position and yaw to the group unconditionally. So on a skipped frame
   * the whole rig, feet included, was translated bodily forward: every other
   * frame was a 100%-slide frame, which put a floor of ~0.5 under the measured
   * foot slide of the entire crowd beyond 20 m no matter how good the walk
   * cycle was. The pose can run at half rate — it is a smooth continuation —
   * but the thing that holds a foot against a moving world cannot.
   */
  updateFeetOnly(dt) {
    if (!this.enabled || !this.footIk || this.diveT >= 0 || !this.bones) {
      this._footHit[0] = this._footHit[1] = false;
      return;
    }
    this._footIk(dt);
  }

  /* ---------------- feet ---------------- */

  /**
   * FOOT IK — ground conform, pelvis drop and the STANCE LOCK.
   *
   * The pelvis drop used to take `min(want - ankle.y)` over BOTH feet. That
   * quantity is most negative for the foot that is HIGHEST, so the routine
   * whose job was to keep the stance foot on the ground was in fact dragging
   * the pelvis down until the SWING foot touched it too. Measured with
   * `gaitprobe.mjs`: the stance duty factor read 1.00 — both ankles pinned to
   * the floor for every frame of the cycle — while the toe still swung 12 cm,
   * so the leg was rotating about a foot that never left the pavement. That is
   * the flat, gliding walk, and it is also why nothing could be done about
   * foot slide from inside the clip: the clip's swing was being cancelled here.
   *
   * The drop now follows the foot the POSE has planted (the one nearest its own
   * ground), and it is rate-limited so a step onto a kerb settles rather than
   * snapping.
   *
   * THE STANCE LOCK is the second half. Even a correctly-shaped clip leaves a
   * residue of skate, because the leg's ground track is an arc and the body's
   * is a straight line. So while a foot is down, its world XZ is latched at the
   * point where it landed and the two-bone solver is aimed there instead of at
   * wherever the pose put it. The lock releases the moment the pose lifts the
   * foot, and it is clamped to the leg's reach so a locked foot can never
   * stretch the character.
   */
  _footIk(dt = 1 / 60) {
    if (!this.probe) {
      this._footHit[0] = this._footHit[1] = false;
      return;
    }
    const s = this.scale;
    const ankleH = ANKLE_H * s;
    const above = this._footAbove;
    for (let k = 0; k < 2; k++) {
      const ankle = this._wp(this.legs[k][2], this._v);
      const ok = this.probe(ankle.x, ankle.z, ankle.y + 0.55 * s, this._probeOut);
      this._footHit[k] = ok === true;
      if (!ok) {
        this._footY[k] = ankle.y;
        this._footN[k].set(0, 1, 0);
        above[k] = 0;
        continue;
      }
      const want = this._probeOut.y + ankleH;
      this._footY[k] = want;
      this._footN[k].set(this._probeOut.nx, this._probeOut.ny, this._probeOut.nz);
      above[k] = ankle.y - want;      // > 0 : this foot is off the ground
    }
    // WHICH FOOT IS IN STANCE comes from the clip's own phase, per foot, not
    // from "whichever ankle is lower" — see clips.inStance. Both can be true
    // at once: that is double support, and it is 24% of a walk cycle.
    const clip = this.state.clip;
    const locomotion = clip === 'walk' || clip === 'jog' || clip === 'run';
    const p0 = locomotion ? C.stanceProgress(this.phase, this.gait.phase, clip, 0) : 0;
    const p1 = locomotion ? C.stanceProgress(this.phase, this.gait.phase, clip, 1) : 0;
    const planted = this._planted;
    // The weight-bearing foot is the one that landed most recently.
    let bear = -1;
    if (p0 >= 0 && p1 >= 0) bear = p0 <= p1 ? 0 : 1;
    else if (p0 >= 0) bear = 0;
    else if (p1 >= 0) bear = 1;
    planted[0] = bear === 0;
    planted[1] = bear === 1;
    // The pelvis follows the weight-bearing foot; in flight (a run) it follows
    // the lower one, so the landing is caught rather than punched through.
    const stance = bear >= 0 ? bear : (above[0] <= above[1] ? 0 : 1);
    // Lower the pelvis only far enough for THAT foot to reach; never for the
    // other one. A foot below its ground is lifted by the per-foot clamp below.
    // Only reach for ground that is actually within reach. A runner has a
    // flight phase with no foot down at all, and a pelvis that chases the
    // lower foot however far away it is would abolish it — the character would
    // be welded to the pavement at 5.6 m/s.
    const REACH_DOWN = 0.20 * s;
    let drop = above[stance] > 0 && above[stance] < REACH_DOWN ? -above[stance] : 0;
    drop = Math.max(-REACH_DOWN, drop);
    // Rate limit: 1.2 m/s of pelvis travel is a brisk step down a kerb and far
    // beyond anything a flat pavement asks for, so this is invisible on level
    // ground and stops a probe glitch from punching the character into the road.
    const maxStep = 1.2 * s * dt;
    this._drop += Math.max(-maxStep, Math.min(maxStep, drop - this._drop));
    // Applied as a DELTA against what is already on the bone, so this routine
    // is idempotent within a frame — `updateFeetOnly()` re-runs it on the
    // frames the pose is skipped, and a straight `+=` would walk the pelvis
    // into the pavement over a few seconds.
    const dApply = this._drop - this._dropApplied;
    if (Math.abs(dApply) > 1e-5) {
      const b = this.bones[0];
      b.position.y += dApply / s;
      this._dropApplied = this._drop;
      b.updateMatrix();
      b.updateMatrixWorld(true);
    }
    for (let k = 0; k < 2; k++) {
      const leg = this.legs[k];
      const ankle = this._wp(leg[2], this._v);
      const lockY = Math.max(this._footY[k], ankle.y - 0.001);
      /* ---- stance lock ------------------------------------------------- */
      // The stance test has to be made against the POST-DROP height. `above`
      // was measured before the pelvis moved, and the pelvis moves precisely
      // to zero it for the stance foot — testing the pre-drop value means the
      // lock never engages on the one foot it exists for.
      // ENGAGE on height, HOLD on phase. The height test exists to stop a
      // lock latching onto a foot that the pose has not actually put down; it
      // must not also be the release condition, because real ground is uneven
      // and the pelvis drop chases it, so `above` flickers across any fixed
      // threshold several times per stance. Each flicker re-latches the anchor
      // at wherever the foot has by then been carried, which is a lock that
      // measures as engaged and behaves as absent.
      const L0 = this._lock[k];
      const down = this.footLock && planted[k] &&
        (L0.w > 0 || above[k] + this._drop < 0.045 * s);
      const L = this._lock[k];
      if (down) {
        // Latch at FULL weight on the frame it lands. There is nothing to ease
        // into — the anchor is the position the foot is already at — and a
        // ramp only means the first fifth of every stance is unlocked, which
        // is where a quarter of the remaining slide was living.
        if (L.w <= 0) { L.x = ankle.x; L.z = ankle.z; L.w = 1; }
      } else {
        L.w = Math.max(0, L.w - dt / 0.10);
      }
      let tx = ankle.x, tz = ankle.z;
      if (L.w > 0) {
        tx += (L.x - ankle.x) * L.w;
        tz += (L.z - ankle.z) * L.w;
        // never ask for more than the leg has: pull the target back toward the
        // hip if the lock has drifted out of reach, and drop the lock entirely
        // once it has (the character has walked past this footfall).
        const hip = this._wp(leg[0], this._v5);
        const dx = tx - hip.x, dy = lockY - hip.y, dz = tz - hip.z;
        const reach = 0.95 * s;
        const d = Math.hypot(dx, dy, dz);
        if (d > reach) {
          const f = reach / d;
          tx = hip.x + dx * f;
          tz = hip.z + dz * f;
          L.w = Math.max(0, L.w - dt / 0.05);
        }
      }
      const target = this._target.set(tx, lockY, tz);
      this._pole
        .set(k === 0 ? -0.12 : 0.12, 0.05, 1)
        .applyQuaternion(this.bones[0].parent.getWorldQuaternion(this._q2));
      this._twoBone(leg, target, this._pole);
      const n = this._footN[k];
      if (n.y < 0.999) {
        const foot = leg[2];
        const up = this._v2.set(0, 0, 1).applyQuaternion(this._wq(foot, this._q2));
        const dot = Math.min(1, Math.max(-1, up.dot(n)));
        let ang = Math.acos(dot);
        if (ang > 0.32) ang = 0.32;
        const axis = this._v4.crossVectors(up, n);
        if (axis.lengthSq() > 1e-10) {
          axis.normalize();
          this._q3.setFromAxisAngle(axis, ang);
          this._applyWorld(foot, this._q3);
        }
      }
    }
  }

  _twoBone(chain, target, pole) {
    const [iu, il, ie] = chain;
    const A = this._wp(iu, this._v);
    const B = this._wp(il, this._v2);
    const Cp = this._wp(ie, this._v3);
    const l1 = A.distanceTo(B);
    const l2 = B.distanceTo(Cp);
    if (l1 < 1e-5 || l2 < 1e-5) return;
    const dir = this._v4.copy(target).sub(A);
    let d = dir.length();
    if (d < 1e-5) return;
    dir.multiplyScalar(1 / d);
    const min = Math.abs(l1 - l2) + 1e-4;
    const max = l1 + l2 - 1e-4;
    d = Math.min(max, Math.max(min, d));
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const perp = this._elbow.copy(pole).addScaledVector(dir, -pole.dot(dir));
    if (perp.lengthSq() < 1e-8) perp.set(0, 1, 0).addScaledVector(dir, -dir.y);
    perp.normalize();
    const ex = A.x + dir.x * a + perp.x * h;
    const ey = A.y + dir.y * a + perp.y * h;
    const ez = A.z + dir.z * a + perp.z * h;
    const toE = this._elbow.set(ex - A.x, ey - A.y, ez - A.z);
    if (toE.lengthSq() < 1e-10) return;
    this._aimBone(iu, toE.normalize());
    const B2 = this._wp(il, this._v2);
    const toT = this._elbow.set(target.x - B2.x, target.y - B2.y, target.z - B2.z);
    if (toT.lengthSq() < 1e-10) return;
    this._aimBone(il, toT.normalize());
  }

  /** World position of a bone, for props, hitboxes and FX. */
  bonePos(name, out) {
    return this._wp(this.rig.index(name), out);
  }

  /**
   * GROUND CONTACT for one foot — the same quantities the stance lock solved
   * against, published for anything that has to know where this character is
   * actually touching the world: contact shadows, footstep FX, foley.
   *
   * `k` is 0 for the right foot and 1 for the left, matching `legs` and the
   * `FootR`, `FootL` order everything else in this subsystem uses. Fills and
   * returns the caller's preallocated `out` (hard rule 5):
   *
   *   x, z     world XZ of the ankle AFTER the stance lock has anchored it —
   *            the point the foot is standing on, not where the raw clip put it
   *   y        the GROUND under that foot. NOT the ankle, and not the actor's
   *            root either: a foot on a kerb and a foot in the gutter are 15 cm
   *            apart and a contact mark drawn at the root height floats under
   *            one of them.
   *   above    metres of daylight under the sole, measured AFTER the pelvis
   *            drop, so it is ~0 for a foot bearing weight
   *   planted  the clip says this foot is the weight-bearing one this frame
   *   lock     0..1 stance-lock weight; latches to 1 on the frame it lands
   *   hit      false when the probe found no ground under the foot, or when the
   *            IK did not run at all (ragdoll, dive, disabled). Everything else
   *            in `out` is meaningless then — fall back to the actor's own
   *            ground height.
   */
  footContact(k, out) {
    const ankle = this._wp(this.legs[k][2], this._v);
    out.hit = this._footHit[k] === true;
    out.x = ankle.x;
    out.z = ankle.z;
    out.y = this._footY[k] - ANKLE_H * this.scale;
    // `_footAbove` is sampled BEFORE the pelvis drop and the drop exists to
    // zero it for the stance foot, so the pre-drop value reads a planted foot
    // as airborne. This is the same correction the stance lock makes.
    out.above = Math.max(0, this._footAbove[k] + this._drop);
    out.planted = this._planted[k] === true;
    out.lock = this._lock[k].w;
    return out;
  }

  boneMatrix(name) {
    return this.bones[this.rig.index(name)].matrixWorld;
  }
}
