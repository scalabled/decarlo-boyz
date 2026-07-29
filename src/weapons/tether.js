import * as THREE from 'three';

/**
 * THE HARPOON LINE.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS THERE, AND WHY IT NEVER FIRED
 * ---------------------------------------------------------------------------
 * `ballistics.js` used to answer `tethered: true` with one impulse back along
 * the flight path, gated on `hit.ragdoll || hit.body`. Two things were wrong
 * with that, and the second is the reason nobody ever saw the mechanic:
 *
 * 1. THE GATE COULD ALMOST NEVER BE TRUE. The Harpoon does 90 damage, which is
 *    a one-hit kill on any unarmoured pedestrian — so on the frame it connects
 *    the target is still a LIVE ped with hit capsules, and his ragdoll does not
 *    exist yet. It is created a moment later, out of `actor:death`. A gate that
 *    only fires on an ALREADY-ragdolled target meant the line did nothing in
 *    the one case the weapon is designed around.
 *
 * 2. THE CALL WAS MALFORMED. `Ragdoll.applyImpulse` is
 *    `(x, y, z, ix, iy, iz, radius, dt)` and it was being handed
 *    `(Vector3, ix, iy, iz)` — so `x` was an object, every `this.px[i] - x`
 *    was NaN, and any doll it did reach would have been driven to NaN and
 *    silently vanished.
 *
 * ---------------------------------------------------------------------------
 * A CONSTRAINT, NOT A YANK
 * ---------------------------------------------------------------------------
 * A single impulse is also the wrong model: it launches a body at whatever
 * speed the constant happens to produce and then has no further say. This is a
 * distance constraint driven as a VELOCITY SERVO, which is stable without any
 * knowledge of the doll's internal masses:
 *
 *     want  = clamp((distance - HOLD) * STIFF, 0, MAX_SPEED)   how fast it
 *                                                              should be closing
 *     have  = measured closing speed since the last step
 *     push  = clamp((want - have) * GAIN, -MAX_PUSH * BRAKE, MAX_PUSH)
 *
 * `have` is measured from the anchor's own motion, so the loop self-calibrates:
 * a heavy body gets more push, a light one converges and the push falls to
 * zero. The negative half of the clamp is the reel RESISTING — a taut line can
 * hold a body back as well as pull it, and without it the servo has no way to
 * correct an overshoot and the target coasts straight past the shooter.
 *
 * Measured on a real ragdoll at 17.7 m: closes at 4.8 / 4.6 / 4.8 / 3.6 m/s
 * against a 5.0 m/s target and its centre height holds flat, where the first
 * cut of this file winched the body from y 1.5 to y 7.0.
 *
 * The rope itself is one 6-sided cylinder scaled between the muzzle and the
 * anchor — the physical record that the weapon is a harpoon and not a very
 * slow rifle.
 */

/** Where the line settles the target, metres from the shooter. */
const HOLD = 1.6;
/** Closing speed per metre of slack. */
const STIFF = 2.6;
const MAX_SPEED = 5.0;
/**
 * How hard the servo may push, and how hard it corrects.
 *
 * These are CALIBRATED, not guessed. `Ragdoll.applyImpulse` converts its
 * magnitude into a Verlet displacement scaled by each particle's inverse mass,
 * so the speed a given number produces is not obvious from the call site. At
 * `GAIN 9 / MAX_PUSH 46` the first step overshot to ~16 m/s against a 5 m/s
 * target — the servo had no brake, so it simply stopped pushing and the body
 * coasted 6.5 m in the first 0.4 s. Halving the gain and letting the reel
 * RESIST (a taut line can hold a body back as well as pull it) closes the loop.
 */
const MAX_PUSH = 46;
const GAIN = 4;
/** A rope brakes more weakly than it pulls. */
const BRAKE = 0.6;
/** Seconds the line stays attached before it is cut. */
const DURATION = 2.2;
/**
 * Slack, in metres, past the length the line went out at. A target that pulls
 * this much further away has broken it — you cannot winch a bus.
 *
 * It has to be measured against the SHOT, not against a constant: a fixed 26 m
 * break cut the line the instant it attached on any shot past 26 m, which on a
 * 95 m weapon is most of them, and the winch silently never ran.
 */
const SLACK = 7;

export class Tether {
  constructor(ctx, mats) {
    this.ctx = ctx;
    this.active = false;
    this.actor = null;
    this.ragdoll = null;
    this.body = null;
    this.until = -1;
    this.hold = HOLD;
    this.limit = Infinity;

    this._anchor = new THREE.Vector3();
    this._prev = new THREE.Vector3();
    this._from = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._mid = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._fixed = new THREE.Vector3();
    this._havePrev = false;

    /** Set by `WeaponSystem.init` — writes the muzzle into the vector given. */
    this.muzzle = null;

    /* 4 mm of stainless line. One geometry, one shared material, one draw. */
    this.geo = new THREE.CylinderGeometry(0.004, 0.004, 1, 6, 1, true);
    this.geo.translate(0, 0.5, 0);
    /* Shared with the weapon models — do NOT dispose it; we only own the
     * fallback, and only when there is no material library to ask. */
    this.mat = mats?.get?.('imp_steel') ?? null;
    this._ownsMat = !this.mat;
    if (!this.mat) {
      this.mat = new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.5, metalness: 1 });
    }
    this.rope = new THREE.Mesh(this.geo, this.mat);
    this.rope.visible = false;
    this.rope.frustumCulled = false;
    this.rope.castShadow = false;
    this.rope.userData.owNoShadow = true;
    this.rope.userData.owNoPrepass = true;
    ctx.scene.add(this.rope);

    this.stats = { shots: 0, dragged: 0, cut: 0 };
  }

  /**
   * The head went in. Hold on to whatever it went into.
   *
   * @param {object} hit  the physics hit record
   */
  attach(hit) {
    this.detach();
    this.active = true;
    this.until = this.ctx.time.elapsed + DURATION;
    this.actor = hit?.actor ?? null;
    this.ragdoll = hit?.ragdoll ?? this.actor?.ragdoll ?? null;
    this.body = hit?.body ?? null;
    this._fixed.copy(hit?.point ?? this._fixed);
    this._havePrev = false;
    this.hold = HOLD;
    this._resolveShooter(this._from);
    this.limit = Math.max(12, this._fixed.distanceTo(this._from) + SLACK);
    this.stats.shots++;
    /* Being speared is worth a scream even while he is still standing. */
    if (this.actor) this.ctx.peek('peds')?.panic?.(this._fixed, 9, 1.1);
    return true;
  }

  detach() {
    this.active = false;
    this.actor = null;
    this.ragdoll = null;
    this.body = null;
    this.rope.visible = false;
  }

  /** Current world position of whatever the line is attached to. */
  _resolveAnchor(out) {
    /* A live target only becomes draggable once he is a ragdoll, which is a
     * moment AFTER the hit that killed him — so re-check every step. */
    if (!this.ragdoll && this.actor) {
      this.ragdoll = this.actor.ragdoll ?? this.actor.__ragdoll ?? null;
    }
    const rd = this.ragdoll;
    if (rd && rd.alive !== false && rd.aabb) {
      return out.set(
        (rd.aabb.minx + rd.aabb.maxx) * 0.5,
        (rd.aabb.miny + rd.aabb.maxy) * 0.5,
        (rd.aabb.minz + rd.aabb.maxz) * 0.5
      );
    }
    if (this.body?.position) return out.copy(this.body.position);
    if (this.actor?.position) {
      return out.set(this.actor.position.x, this.actor.position.y + 1.0, this.actor.position.z);
    }
    return out.copy(this._fixed);
  }

  /** Where the shooter's end of the line is. */
  _resolveShooter(out) {
    const p = this.ctx.peek('player');
    const base = p?.position;
    if (!base) return out.copy(this._fixed);
    const anchor = p.movement?.anchorHeight ?? 1.44;
    return out.set(base.x, base.y + anchor * 0.82, base.z);
  }

  /** The constraint. Runs on the fixed step so the servo sees a fixed dt. */
  fixedUpdate(h) {
    if (!this.active) return;
    if (this.ctx.time.elapsed > this.until) { this.detach(); return; }

    this._resolveAnchor(this._anchor);
    this._resolveShooter(this._from);
    this._dir.copy(this._from).sub(this._anchor);
    const dist = this._dir.length();
    if (dist > this.limit) { this.stats.cut++; this.detach(); return; }
    if (dist < 1e-3) return;
    this._dir.divideScalar(dist);

    /* Nothing to pull on (the head is in a wall): the line still draws, and
     * that is the whole of its job. */
    const rd = this.ragdoll;
    if (!rd && !this.body) { this._havePrev = false; return; }

    /* Measured closing speed, from the anchor's own motion. */
    let have = 0;
    if (this._havePrev) {
      this._mid.copy(this._anchor).sub(this._prev);
      have = this._mid.dot(this._dir) / Math.max(1e-5, h);
    }
    this._prev.copy(this._anchor);
    this._havePrev = true;

    const want = Math.min(MAX_SPEED, Math.max(0, (dist - this.hold) * STIFF));
    const push = Math.min(MAX_PUSH, Math.max(-MAX_PUSH * BRAKE, (want - have) * GAIN));
    if (Math.abs(push) < 0.05) return;

    if (rd?.applyImpulse) {
      /**
       * STRICTLY ALONG THE LINE.
       *
       * The first version added a constant `push * 0.12` of lift "so the body
       * clears the kerb". The servo only regulates the component ALONG the
       * line, so that lift was unopposed and integrated for the whole 2.2 s:
       * measured, the ragdoll's centre climbed from y 1.47 to y 6.96 — it was
       * being winched into the sky. A rope pulls along the rope. What lift
       * there is comes from the geometry, because the shooter's end of the
       * line is at his chest and the body is on the ground.
       *
       * A generous radius so the whole doll comes, rather than the line
       * detaching one arm from the man attached to it.
       */
      rd.applyImpulse(
        this._anchor.x, this._anchor.y, this._anchor.z,
        this._dir.x * push, this._dir.y * push, this._dir.z * push,
        1.1, h
      );
      this.stats.dragged++;
    } else if (this.body?.applyImpulse) {
      this.body.applyImpulse(this._dir.x * push, this._dir.y * push, this._dir.z * push);
      this.stats.dragged++;
    }
  }

  /** Draw the line. Called once per rendered frame. */
  update() {
    if (!this.active) { this.rope.visible = false; return; }
    if (this.muzzle) this.muzzle(this._from);
    else this._resolveShooter(this._from);
    this._resolveAnchor(this._anchor);
    this._dir.copy(this._anchor).sub(this._from);
    const len = this._dir.length();
    if (len < 0.05) { this.rope.visible = false; return; }
    this._dir.divideScalar(len);
    this._q.setFromUnitVectors(this._up, this._dir);
    this.rope.position.copy(this._from);
    this.rope.quaternion.copy(this._q);
    this.rope.scale.set(1, len, 1);
    this.rope.visible = true;
  }

  dispose() {
    this.detach();
    this.rope.removeFromParent();
    this.geo.dispose();
    if (this._ownsMat) this.mat.dispose();
  }
}

export { HOLD as TETHER_HOLD, DURATION as TETHER_SECONDS };
