/**
 * PEDS — one pedestrian.
 *
 * A ped is a state machine over a sidewalk link, a skinned body and a set of
 * reactions. The states that matter:
 *
 *   WALK    following a pavement, or wandering if there is no road graph
 *   WAIT    stopped at a kerb, waiting on `traffic.lightAt(nodeId)`
 *   CROSS   out on the road, exposed to vehicles, hurrying
 *   IDLE    stopped doing something — phone, cigarette, talking in a pair
 *   FLEE    running away from a threat, screaming
 *   COWER   down, hands over the head
 *   GAWK    crowded round an incident; some of them filming it
 *   FIGHT   the ones who do not run
 *   DOWN    ragdolled and injured, may get back up
 *   DEAD    ragdolled for good
 *
 * The reaction model is the point of the whole subsystem: a street where
 * nobody flinches at a gunshot reads as a diorama. Peds hear gunfire and turn
 * toward it, scatter from explosions, dive out of the path of a car and get
 * launched if they misjudge it, and once the danger passes a few of them drift
 * back to look — because that is what people do, and it is what makes the
 * aftermath of a crash feel like it happened in a city.
 */

import * as THREE from 'three';
import { RIG } from './rig.js';
import { SHAPES } from './wardrobe.js';
import { PedAnimator } from './animator.js';
import { SEAT } from './clips.js';
import { buildPedRagdoll } from './doll.js';
import { Wander } from './nav.js';

export const STATE = {
  WALK: 'walk',
  WAIT: 'wait',
  CROSS: 'cross',
  IDLE: 'idle',
  FLEE: 'flee',
  COWER: 'cower',
  GAWK: 'gawk',
  FIGHT: 'fight',
  DOWN: 'down',
  DEAD: 'dead',
  DRIVING: 'driving',
  /**
   * CREW — a DeCarlo brother following the player. `crew.js` owns the brain and
   * writes `_steer` / `desiredSpeed` / `faceTarget` before this ped updates, so
   * everything below has to do is NOT overwrite them (see `_move`) and then
   * integrate exactly as it does for a fleeing pedestrian.
   */
  CREW: 'crew',
  /**
   * HOSTILE — a mission enemy. `hostile.js` owns the brain and writes `_steer`
   * / `desiredSpeed` / `faceTarget` before this ped updates, exactly as
   * `crew.js` does; everything below has to do is NOT overwrite them and then
   * integrate. The one difference from every other state in this table is that
   * a hostile's integration is resolved by a `physics` character capsule rather
   * than added straight onto `position` — see `_move`.
   */
  HOSTILE: 'hostile',
};

/**
 * Hit capsules: [part, headBone, tailBone, radius, damageScale]. `part` is what
 * `physics` reports back on the impact, and `damage:dealt` turns a `head` hit
 * into a headshot.
 */
const HITBOXES = [
  ['head', 'Head', 'HeadTop', 0.098, 3.2],
  ['torso', 'Hips', 'Neck', 0.185, 1.0],
  ['leg', 'UpLegR', 'FootR', 0.098, 0.65],
  ['leg', 'UpLegL', 'FootL', 0.098, 0.65],
];

let _nextId = 1;

export class Ped {
  constructor(sys) {
    this.sys = sys;
    this.ctx = sys.ctx;
    this.id = _nextId++;
    this.active = false;
    this.isPed = true;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.targetYaw = 0;
    this.speed = 0;
    this.desiredSpeed = 0;
    this.radius = 0.30;
    this.groundY = 0;

    this.link = { edge: null, side: 1, dir: 1 };
    this.t = 0;
    this.navMode = 'wander';

    this.state = STATE.WALK;
    this.stateTime = 0;
    this.fear = 0;
    this.health = 100;
    /**
     * A civilian's pool. `hostile.js` overwrites both with the chapter's own
     * number (a 400 hp boss, a 58 hp wave goon), which is why the hurt-anim
     * blend below reads this rather than a hard-coded 100.
     */
    this.maxHealth = 100;
    this.alive = true;
    this.lod = 2;
    this.dist = 999;

    /** Set by `crew.js` on a companion brother. Null for everyone else. */
    this.crew = null;
    this.isCrew = false;
    /**
     * Set by `hostile.js` on a mission enemy. `freeroam._onActorDeath` and
     * `crew._gatherHostiles` both key off this, so it is public contract.
     */
    this.isHostile = false;
    /**
     * A `physics.createCharacter()` swept capsule, or null. When it exists it
     * is the AUTHORITY on where this pedestrian is: `_move` hands it the
     * displacement and copies the resolved position back. Only hostiles carry
     * one — a hundred capsule sweeps a frame is not a trade the ambient crowd
     * should make, and the crowd walks pavements derived from the road graph,
     * which keeps it clear of buildings geometrically.
     */
    this.controller = null;
    this._fallV = 0;
    this._vehHitCd = 0;

    this.threat = new THREE.Vector3();
    this.hasThreat = false;
    this.lookAt = new THREE.Vector3();
    this.lookWeight = 0;
    this.faceTarget = null;

    this.group = null;
    this.mesh = null;
    this.bones = null;
    this.skeleton = null;
    this.animator = null;
    this.ragdoll = null;
    this.__ragdoll = null;
    this.mass = 78;

    /* carjack / vehicles */
    this.vehicle = null;
    this.seat = -1;
    this.isDriver = false;
    /**
     * The seat, in the car's OWN space, resolved once per seating — see
     * `_resolveSeat`. `vehicles.seatAnchor()` allocates four Vector3s, so it is
     * never called per frame, and the local offset is what lets the body ride a
     * car that is still rolling.
     */
    this.seatLocal = new THREE.Vector3();
    /** The vehicle `seatLocal` was resolved against; null means "not yet". */
    this._seatFor = null;
    /**
     * Which side of the car this seat is on, +1 or -1, as `vehicles` reports
     * it. Public because it is the door a carjack should swing and the side an
     * ejected body belongs on; nothing reads it yet.
     */
    this.seatSide = -1;
    /** How far the seat was sunk to keep this silhouette's hat out of the roof. */
    this._seatSink = 0;
    /** Footwell room under the root, 0..1, handed to `clips.sit`. */
    this._seatDrop = 0.4;
    /**
     * The tallest vertex of this pedestrian's silhouette in the bind pose, hat
     * included — `builder.js` measures it off the emitted geometry. `rig.js`
     * puts HeadTop at 1.752, which is the bare-headed floor.
     */
    this.crownBind = 1.752;

    this._steer = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._navPt = new THREE.Vector3();
    this._crossFrom = new THREE.Vector3();
    this._crossTo = new THREE.Vector3();
    this._crossK = 0;
    this._groundTimer = 0;
    this._decision = 0;
    this._animAccum = 0;
    this._animSkip = 0;
    this._deadTime = 0;
    this._talkPartner = null;
    this._idleAct = null;
    this._blockTimer = 0;
    this._waterTime = 0;
    /** Preallocated seat scratch — `_seatPose` runs every frame (rule 5). */
    this._seatPos = new THREE.Vector3();
    this._seatUp = new THREE.Vector3();
    this._seatQuat = new THREE.Quaternion();
    this._seatYaw = 0;
    /** World Y of the head anchor `vehicles` published for this seat. */
    this._anchorY = 0;
    this.colliders = [];
  }

  /**
   * `game`'s enemy handles are asked `h.dead` all over `mission.js`,
   * `tracks.js` and `boss.js`. A pedestrian's word for it is `alive`; this is
   * the same fact spelled the way those call sites read it, so the adapter in
   * `game/hostiles.js` does not have to wrap every handle it hands out.
   */
  get dead() {
    return !this.alive;
  }

  /* ================================================================== */
  /* lifecycle                                                          */
  /* ================================================================== */

  /**
   * Place the ped in the world. A pedestrian spawns with NO body: the LOD pass
   * hands one out only if this person is close enough to be worth a skinned
   * mesh, and takes it back when they are not. That is what lets the population
   * be a hundred while the draw calls are a couple of dozen.
   */
  spawn(outfit, position, yaw, rng) {
    this.outfit = outfit;
    this.rng = rng;
    this.gait = outfit.gait;
    this.scale = outfit.scale;
    this.height = outfit.height;
    /**
     * The rig's own bare crown until a body says otherwise.
     *
     * DELIBERATELY NOT `sys.crownOf(outfit.shape)`. Two reasons, and both were
     * measured the hard way: that call materialises a silhouette that this
     * pedestrian may never be close enough to wear (a whole `buildOutfit`, 64 ms
     * of geometry, on the frame a distant ped spawns), and it takes a
     * `rng.fork()` out of the system stream at a new point — which shifts every
     * subsequent draw in the crowd and made `blipprobe`'s scripted firefight
     * spawn nobody. `attachBody` fills the real number in when a body arrives,
     * and invalidates the seat so it is re-resolved with it.
     */
    this.crownBind = 1.752;
    this._seatFor = null;
    this.mass = (outfit.female ? 66 : 80) * (0.85 + outfit.scale * 0.18);
    this.shapeDef = SHAPES[outfit.shape] ?? SHAPES.jacketM;
    this.radius = 0.26 + (this.shapeDef.bulk ?? 1) * 0.05;
    this.lateral = rng.range(-0.55, 0.55);

    this.body = null;
    this.group = null;
    this.mesh = null;

    // Preallocated flat-ground probe for the LOD1 foot solve — see below.
    this._flatProbe = this._flatProbe ?? ((x, z, fromY, out) => {
      out.y = this.position.y;
      out.nx = 0; out.ny = 1; out.nz = 0;
      out.hit = true;
      return true;
    });
    this.animator = new PedAnimator(RIG, null, {
      gait: outfit.gait,
      height: outfit.height,
      scale: outfit.scale,
      probe: this.sys.probeFn,
    });
    this.animator.phase = rng.float();
    this.wander = this.wander ?? new Wander();

    this.position.copy(position);
    this.yaw = yaw;
    this.targetYaw = yaw;

    this.active = true;
    this.alive = true;
    this.health = 100;
    this.maxHealth = 100;
    this.isHostile = false;
    this._fallV = 0;
    this.fear = 0;
    this.speed = 0;
    this.state = STATE.WALK;
    this.stateTime = 0;
    this._deadTime = 0;
    this.ragdoll = null;
    this.__ragdoll = null;
    this.velocity.set(0, 0, 0);
    this._decision = rng.range(0, 3);
    this._waterTime = 0;
    this.baseSpeed = outfit.speed[0] * (outfit.gait.speedK ?? 1);
    this.runSpeed = outfit.speed[1] * (outfit.gait.speedK ?? 1);
    this.jogger = outfit.jogger;
    if (this.jogger) {
      this.desiredSpeed = this.runSpeed * 0.72;
      this.state = STATE.WALK;
    }
    this._applyCarry();
    return this;
  }

  /**
   * Hit capsules pushed onto the animated skeleton every frame, so a headshot
   * is a headshot because of where the round landed. Only bodies carry them:
   * a pedestrian too far away for a skinned mesh is also too far away to be
   * aimed at with any precision, and 150 colliders is already a linear scan
   * on every raycast.
   */
  _makeColliders() {
    const phys = this.sys.phys;
    if (!phys || this.colliders.length) return;
    for (const [part, a, b, r, dmg] of HITBOXES) {
      const c = phys.addCollider({
        shape: 'capsule',
        radius: r * this.scale,
        surface: 'flesh',
        owner: this,
        part,
        damageScale: dmg,
      });
      c.userData = { a, b };
      this.colliders.push(c);
    }
  }

  _dropColliders() {
    const phys = this.sys.phys;
    for (const c of this.colliders) phys?.removeCollider(c);
    this.colliders.length = 0;
  }

  /** Push the hit capsules onto the animated skeleton. */
  syncColliders() {
    if (!this.alive || !this.animator?.bones) return;
    const an = this.animator;
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      an.bonePos(c.userData.a, this._v);
      an.bonePos(c.userData.b, this._v2);
      c.setSegment(this._v.x, this._v.y, this._v.z, this._v2.x, this._v2.y, this._v2.z);
    }
  }

  /** Adopt a skinned body from the pool. Keeps the animator (and its phase). */
  attachBody(body) {
    this.body = body;
    this.group = body.group;
    this.mesh = body.mesh;
    this.skinnedMesh = body.mesh;
    this.bones = body.bones;
    this.skeleton = body.skeleton;
    body.group.visible = true;
    body.group.scale.setScalar(this.scale);
    body.group.position.copy(this.position);
    body.group.rotation.y = this.yaw;
    body.mesh.userData.ped = this;
    // The silhouette's own crown height, hat included. A seat resolved against
    // the old body's hat is a hat in the headliner, so force a re-resolve.
    if (body.crown && body.crown !== this.crownBind) {
      this.crownBind = body.crown;
      this._seatFor = null;
    }
    if (this.animator) {
      this.animator.bones = body.bones;
      this.animator.enabled = this.alive;
    }
    body.group.updateMatrixWorld(true);
    if (this.alive) this._makeColliders();
  }

  detachBody() {
    this._dropColliders();
    if (!this.body) return null;
    const b = this.body;
    b.group.visible = false;
    b.mesh.userData.ped = null;
    this.body = null;
    this.group = null;
    this.mesh = null;
    this.skinnedMesh = null;
    this.bones = null;
    this.skeleton = null;
    if (this.animator) this.animator.bones = null;
    return b;
  }

  despawn() {
    this._dropColliders();
    if (this.ragdoll) {
      this.sys.phys?.removeRagdoll(this.ragdoll);
      this.ragdoll = null;
      this.__ragdoll = null;
    }
    this.active = false;
    this.animator = null;
    this.vehicle = null;
    this.isDriver = false;
  }

  /* ================================================================== */
  /* navigation                                                         */
  /* ================================================================== */

  setLink(link) {
    this.link.edge = link.edge;
    this.link.side = link.side;
    this.link.dir = link.dir;
    this.t = link.t ?? (link.dir > 0 ? 0 : 1);
    this.navMode = 'link';
  }

  /** Where the ped is trying to be right now, in world space. */
  _navPoint(out) {
    const net = this.sys.net;
    if (this.navMode === 'link' && this.link.edge && net.ready) {
      // aim a little ahead down the pavement so the walk has a heading
      const e = this.link.edge;
      const ahead = Math.min(0.5, 3.5 / Math.max(6, e.len));
      const t = Math.min(1, Math.max(0, this.t + ahead * this.link.dir));
      net.pointOn(e, this.link.side, t, out);
      // spread across the pavement width so a queue is not a single file
      out.x += -e.dz * this.lateral;
      out.z += e.dx * this.lateral;
      return out;
    }
    if (this.navMode === 'cross') {
      return out.copy(this._crossTo);
    }
    return out.copy(this.wanderTarget ?? this.position);
  }

  /** Progress along the current pavement link, and pick the next one. */
  _advanceLink(dt, moved) {
    const net = this.sys.net;
    const e = this.link.edge;
    if (!e || !net.ready) return;
    this.t += (moved / Math.max(1, e.len)) * this.link.dir;
    const done = this.link.dir > 0 ? this.t >= 0.995 : this.t <= 0.005;
    if (!done) return;
    this.t = this.link.dir > 0 ? 1 : 0;

    const nodeId = net.endNode(this.link);
    // Decide whether to cross here. A junction is where people cross, and a
    // crossing that never happens is as wrong as one that always does.
    if (this.rng.float() < 0.22 && !this.jogger) {
      const light = this.sys.lightAt(nodeId);
      this._crossFrom.copy(net.pointOn(e, this.link.side, this.link.dir > 0 ? 0.94 : 0.06, this._v));
      net.pointOn(e, -this.link.side, this.link.dir > 0 ? 0.94 : 0.06, this._crossTo);
      this._crossK = 0;
      this.navMode = 'cross';
      this._crossNode = nodeId;
      // A junction light that is GREEN is green for the traffic, so the walker
      // waits. `traffic` is still a stub that answers green everywhere, so the
      // wait is capped at a couple of seconds and jittered — long enough to
      // read as "waiting at a kerb", never long enough to look like a freeze.
      this._waitMax = this.rng.range(1.3, 3.4);
      this.state = light === 'green' ? STATE.WAIT : STATE.CROSS;
      this.stateTime = 0;
      return;
    }
    const nx = net.next(this.link, this.rng, this._nextLink ?? (this._nextLink = {}));
    if (nx) this.setLink(nx);
    this.lateral = this.rng.range(-0.55, 0.55);
  }

  _updateCross(dt) {
    const net = this.sys.net;
    // 'green' at a junction means green for TRAFFIC, so the ped waits.
    if (this.state === STATE.WAIT) {
      const light = this.sys.lightAt(this._crossNode);
      this.desiredSpeed = 0;
      // never wait for ever: if traffic has no opinion, cross after a beat
      if (light !== 'green' || this.stateTime > (this._waitMax ?? 2.4)) {
        this.state = STATE.CROSS;
        this.stateTime = 0;
      }
      return;
    }
    const width = Math.max(2, this._crossFrom.distanceTo(this._crossTo));
    this.desiredSpeed = this.baseSpeed * 1.28;
    this._crossK += (this.speed * dt) / width;
    if (this._crossK >= 1) {
      // land on the far pavement and carry on
      this.link.side = -this.link.side;
      this.navMode = 'link';
      this.state = STATE.WALK;
      this.stateTime = 0;
      const nx = net.next(this.link, this.rng, this._nextLink ?? (this._nextLink = {}));
      if (nx) this.setLink(nx);
    }
  }

  /* ================================================================== */
  /* frame                                                              */
  /* ================================================================== */

  update(dt) {
    if (!this.active) return;
    this.stateTime += dt;
    if (!this.alive) {
      this._deadTime += dt;
      return;
    }
    if (this.state === STATE.DRIVING) {
      /**
       * THE SEAT, NOT THE CENTRE OF MASS.
       *
       * This used to copy `vehicle.position` — the chassis COM — straight into
       * `this.position`, which `updateVisual` then writes to the group, which
       * the animator uses as the FEET. A standing 1.75 m rig whose soles are on
       * the car's centre of mass puts the crown a metre over the roof, and that
       * is the whole of "NPC heads are popping out of cars". Measured on the
       * emitted meshes before this: sedan +0.98 m, sports +1.00 m, kessel
       * +0.88 m, muscle +0.96 m, police +0.58 m over their own roof surfaces.
       *
       * `_seatPose` resolves the real seat out of `vehicles.seatAnchor()` and
       * subtracts the seated head height, exactly as `player/vehicle.js` does
       * for the player's own driver, so a reshaped roofline or a new class is
       * handled by construction rather than by a constant in here.
       *
       * The PHYSICS pose is the right source in this phase: `position` feeds
       * the crowd grid, the LOD sort and the minimap, and none of those care
       * about a sub-step. The DRAWN pose is read in `updateVisual`, which runs
       * in `lateUpdate` — after `vehicles.update()` has written `model.root`.
       */
      if (this.vehicle) this._seatPose(false);
      return;
    }
    if (this.state === STATE.DOWN) {
      this._updateDown(dt);
      return;
    }

    this.fear = Math.max(0, this.fear - dt * 0.16);
    this._decision -= dt;

    switch (this.state) {
      case STATE.WALK: this._updateWalk(dt); break;
      case STATE.IDLE: this._updateIdle(dt); break;
      case STATE.WAIT:
      case STATE.CROSS: this._updateCross(dt); break;
      case STATE.FLEE: this._updateFlee(dt); break;
      case STATE.COWER: this._updateCower(dt); break;
      case STATE.GAWK: this._updateGawk(dt); break;
      case STATE.FIGHT: this._updateFight(dt); break;
      // A brother's brain already ran this frame, in `Crew.update`. Falling
      // through to `_updateWalk` here would hand him back to the sidewalk
      // wander and he would stroll off mid-firefight.
      case STATE.CREW: break;
      // Same contract as CREW: `hostile.js` already ran this frame. Falling
      // through to `_updateWalk` would hand a mission goon back to the
      // sidewalk wander and he would stroll off mid-firefight.
      case STATE.HOSTILE: break;
      default: this._updateWalk(dt); break;
    }

    this._move(dt);
  }

  _updateWalk(dt) {
    this.desiredSpeed = this.jogger ? this.runSpeed * 0.74 : this.baseSpeed;
    if (this.navMode === 'wander') {
      const go = this.wander.step(this.rng, this.position, dt);
      this.wanderTarget = this.wander.target;
      if (!go) this.desiredSpeed = 0;
    }
    // occasionally stop and do something
    if (this._decision <= 0) {
      this._decision = this.rng.range(6, 22);
      if (!this.jogger && this.rng.float() < 0.26) {
        this._enterIdle();
      } else if (this.rng.float() < 0.35) {
        // walk-and-phone / walk-and-smoke
        this._pickWalkAct();
      }
    }
  }

  _pickWalkAct() {
    const acts = this.outfit.idle ?? ['phone'];
    const a = acts[this.rng.u32() % acts.length];
    const an = this.animator;
    if (!an) return;
    if (a === 'phone' && this.outfit.props.phone) {
      an.setAct('phone', 0.85, this.rng.float() < 0.5 ? 1 : -1);
      this._idleAct = 'phone';
    } else if (a === 'smoke' && this.outfit.props.cigarette) {
      an.setAct('smoke', 0.9, -1);
      this._idleAct = 'smoke';
    } else {
      an.clearActs();
      this._idleAct = null;
      this._applyCarry();
    }
  }

  _enterIdle() {
    this.state = STATE.IDLE;
    this.stateTime = 0;
    this.desiredSpeed = 0;
    const acts = this.outfit.idle ?? ['wait'];
    const a = acts[this.rng.u32() % acts.length];
    const an = this.animator;
    this._idleAct = a;
    this._idleTime = this.rng.range(3.5, 14);
    if (!an) return;
    an.clearActs();
    if (a === 'phone') an.setAct('phone', 1, this.rng.float() < 0.5 ? 1 : -1);
    else if (a === 'smoke') an.setAct('smoke', 1, -1);
    else if (a === 'talk') { an.setAct('talk', 1); an.talkEnergy = this.rng.range(0.5, 1.2); }
    else if (a === 'lean') an.setAct('folded', 0.7);
    else this._applyCarry();
  }

  _updateIdle(dt) {
    this.desiredSpeed = 0;
    if (this.stateTime > this._idleTime) {
      this.state = STATE.WALK;
      this.stateTime = 0;
      this.animator?.clearActs();
      this._idleAct = null;
      this._applyCarry();
      this._decision = this.rng.range(8, 26);
    }
  }

  _updateFlee(dt) {
    this.desiredSpeed = this.runSpeed * 1.08;
    this.animator?.setAct('flee', 1);
    if (this.hasThreat) {
      this._steer.copy(this.position).sub(this.threat);
      this._steer.y = 0;
      const d = this._steer.length();
      if (d > 1e-3) this._steer.multiplyScalar(1 / d);
      // stop running once far enough away or after a while
      if (d > 46 || this.stateTime > 11) this._calmDown();
    } else if (this.stateTime > 6) {
      this._calmDown();
    }
  }

  _calmDown() {
    this.animator?.setAct('flee', 0);
    this.fear = Math.min(this.fear, 0.35);
    // some of them come back to look
    if (this.rng.float() < 0.34 && this.hasThreat) {
      this.state = STATE.GAWK;
      this.stateTime = 0;
      this._gawkFilm = this.rng.float() < 0.32 && !!this.outfit.props.phone;
      this._gawkDist = this.rng.range(7, 13);
    } else {
      this.state = STATE.WALK;
      this.stateTime = 0;
      this.navMode = this.link.edge ? 'link' : 'wander';
      this._decision = this.rng.range(3, 9);
    }
  }

  _updateCower(dt) {
    this.desiredSpeed = 0;
    if (this.stateTime > this.rng.range(4, 8) + 3 || this.fear < 0.18) {
      this.state = this.rng.float() < 0.5 ? STATE.GAWK : STATE.WALK;
      this.stateTime = 0;
      this._gawkFilm = false;
      this._gawkDist = this.rng.range(8, 14);
    }
  }

  _updateGawk(dt) {
    const an = this.animator;
    an?.setAct('gawk', this._gawkFilm ? 0 : 0.9);
    an?.setAct('film', this._gawkFilm ? 1 : 0);
    if (!this.hasThreat) {
      this.state = STATE.WALK;
      an?.clearActs();
      return;
    }
    this._v.copy(this.threat).sub(this.position);
    this._v.y = 0;
    const d = this._v.length();
    const want = this._gawkDist;
    if (d > want + 1.5) {
      this._steer.copy(this._v).multiplyScalar(1 / Math.max(1e-3, d));
      this.desiredSpeed = this.baseSpeed * 0.9;
    } else if (d < want - 1.5) {
      this._steer.copy(this._v).multiplyScalar(-1 / Math.max(1e-3, d));
      this.desiredSpeed = this.baseSpeed * 0.7;
    } else {
      this.desiredSpeed = 0;
    }
    this.faceTarget = this.threat;
    if (this.stateTime > this.rng.range(10, 26) + 8) {
      this.state = STATE.WALK;
      this.stateTime = 0;
      an?.clearActs();
      this._applyCarry();
    }
  }

  _updateFight(dt) {
    const target = this.fightTarget;
    if (!target) { this.state = STATE.WALK; return; }
    this._v.copy(target).sub(this.position);
    this._v.y = 0;
    const d = this._v.length();
    this.faceTarget = target;
    if (d > 1.5) {
      this._steer.copy(this._v).multiplyScalar(1 / Math.max(1e-3, d));
      this.desiredSpeed = this.runSpeed * 0.85;
    } else {
      this.desiredSpeed = 0;
      if (this._punchCd === undefined) this._punchCd = 0;
      this._punchCd -= dt;
      if (this._punchCd <= 0) {
        this._punchCd = this.rng.range(0.8, 1.5);
        this.animator?.punchNow(this.rng.float() < 0.5 ? -1 : 1);
        this.sys.onPedPunch(this, target);
      }
    }
    if (this.stateTime > 14 || this.health < 45) {
      this.panic(target, 1.0);
    }
  }

  _updateDown(dt) {
    this._downTime = (this._downTime ?? 0) + dt;
    const rd = this.ragdoll;
    if (rd) {
      const b = rd.aabb;
      this.position.set((b.minx + b.maxx) * 0.5, b.miny, (b.minz + b.maxz) * 0.5);
    }
    // badly hurt people stay down; the lucky ones get up and limp away
    if (this._downTime > 6.5 && this.health > 34 && rd?.sleeping !== false) {
      this._getUp();
    }
  }

  _getUp() {
    const phys = this.sys.phys;
    if (this.ragdoll) {
      phys?.removeRagdoll(this.ragdoll);
      this.ragdoll = null;
      this.__ragdoll = null;
    }
    this.position.y = this.sys.groundAt(this.position.x, this.position.z, this.position.y + 2);
    // A goon knocked down by a car and not killed by it gets back up STILL A
    // GOON. Sending him to FLEE would quietly retire him from the chapter he
    // is the opposition in, and `aliveHostiles` would still be counting him.
    this.state = this.isHostile ? STATE.HOSTILE : STATE.FLEE;
    this.stateTime = 0;
    this.fear = 1;
    this.animator.enabled = true;
    this.animator.setAct('hurt', 1);
    this.baseSpeed *= 0.78;
    this.runSpeed *= 0.7;
    if (this.controller) {
      this.controller.teleport(this.position.x, this.position.y, this.position.z);
      this.position.set(this.controller.position.x, this.controller.position.y, this.controller.position.z);
      this._hostX = this.position.x;
      this._hostZ = this.position.z;
      this._fallV = 0;
    }
  }

  /* ================================================================== */
  /* movement                                                           */
  /* ================================================================== */

  _move(dt) {
    const sys = this.sys;

    /* --- desired direction --- */
    if (this.state === STATE.WALK || this.state === STATE.CROSS) {
      if (this.navMode === 'cross') {
        this._crossFrom.lerp(this._crossFrom, 0); // no-op, keeps the vector live
        this._v.copy(this._crossTo).sub(this.position);
      } else {
        this._navPoint(this._navPt);
        this._v.copy(this._navPt).sub(this.position);
      }
      this._v.y = 0;
      const d = this._v.length();
      if (d > 1e-3) this._steer.copy(this._v).multiplyScalar(1 / d);
      else this._steer.set(0, 0, 0);
    } else if (this.state !== STATE.FLEE && this.state !== STATE.GAWK &&
               this.state !== STATE.FIGHT && this.state !== STATE.CREW &&
               this.state !== STATE.HOSTILE) {
      this._steer.set(0, 0, 0);
    }

    /* --- local avoidance: push off neighbours, with a tangential bias so a
       head-on meeting resolves the way two people on a pavement resolve it --- */
    const near = sys.grid.query(this.position.x, this.position.z, 1.9);
    let crowded = 0;
    for (let i = 0; i < near.length; i++) {
      const o = near[i];
      if (o === this || !o.alive) continue;
      const dx = this.position.x - o.position.x;
      const dz = this.position.z - o.position.z;
      const d2 = dx * dx + dz * dz;
      const rr = this.radius + o.radius + 0.36;
      if (d2 > rr * rr || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const push = (1 - d / rr) * 1.7;
      this._steer.x += (dx / d) * push;
      this._steer.z += (dz / d) * push;
      const s = this.id % 2 ? 1 : -1;
      this._steer.x += (-dz / d) * push * 0.55 * s;
      this._steer.z += (dx / d) * push * 0.55 * s;
      crowded++;
    }
    // the player is solid too
    const pp = sys.playerPos;
    if (sys.hasPlayer) {
      const dx = this.position.x - pp.x;
      const dz = this.position.z - pp.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1.3 * 1.3 && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (1 - d / 1.3) * 2.6;
        this._steer.x += (dx / d) * push;
        this._steer.z += (dz / d) * push;
      }
    }

    if (this._steer.lengthSq() > 1e-6) this._steer.normalize();

    /* --- speed --- */
    let want = this.desiredSpeed;
    if (crowded > 2 && this.state !== STATE.FLEE) want *= 0.62;
    if (this.fear > 0.4 && this.state === STATE.WALK) want *= 1 + this.fear * 0.4;
    this.speed += (want - this.speed) * Math.min(1, dt * 6.5);
    if (this.speed < 0.04) this.speed = 0;

    /* --- facing --- */
    if (this.faceTarget) {
      this.targetYaw = Math.atan2(this.faceTarget.x - this.position.x, this.faceTarget.z - this.position.z);
      if (this.speed > 0.5) this.faceTarget = null;
    } else if (this.speed > 0.18) {
      this.targetYaw = Math.atan2(this._steer.x, this._steer.z);
    }
    let dy = this.targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    if (Math.abs(dy) > 1.0 && this.speed < 0.3) this.animator?.turn(dy > 0 ? 1 : -1);
    const turnRate = this.speed > 0.5 ? 5.2 : 3.0;
    this.yaw += Math.max(-turnRate * dt, Math.min(turnRate * dt, dy));

    /* --- integrate --- */
    const moved = this.speed * dt;

    /**
     * A PEDESTRIAN WITH A PHYSICS BODY.
     *
     * `controller` is non-null only for mission hostiles (see `hostile.js`),
     * and when it is, it OWNS the position: the displacement below is a
     * request, and what comes back is where a swept capsule could actually get
     * to. That single substitution is what makes a wall a wall — walls, kerbs,
     * slopes, doorways, parked cars and ground clamping all arrive at once,
     * from `physics.createCharacter`, which is the same controller the player
     * walks on.
     *
     * The `+=` on the next branch is the code this replaces for that
     * population, and it is exactly what let a goon cross a house: it consults
     * nothing, so nothing can stop it.
     */
    if (this.controller && this.controller.enabled !== false) {
      const c = this.controller;
      // Gravity, owned here because the controller is kinematic. Grounded, a
      // small constant push keeps him welded to a slope and lets the drop step
      // find the floor after a kerb; airborne, he falls.
      this._fallV = c.grounded ? -1.5 : Math.max(-30, this._fallV - 9.81 * dt);
      c.move(this._steer.x * moved, this._fallV * dt, this._steer.z * moved);
      this.position.set(c.position.x, c.position.y, c.position.z);
      this.groundY = c.position.y;
      this.velocity.set(this._steer.x * this.speed, 0, this._steer.z * this.speed);
      return;
    }

    this.position.x += this._steer.x * moved;
    this.position.z += this._steer.z * moved;
    this.velocity.set(this._steer.x * this.speed, 0, this._steer.z * this.speed);

    if (this.navMode === 'link' && this.state === STATE.WALK) this._advanceLink(dt, moved);

    /* --- ground. Sampled at a few Hz and eased, because a per-frame raycast
       for a hundred pedestrians is the single most expensive thing this system
       could do, and the terrain under a pavement does not move. --- */
    this._groundTimer -= dt;
    if (this._groundTimer <= 0) {
      this._groundTimer = this.lod === 0 ? 0.10 : this.lod === 1 ? 0.25 : 0.7;
      const g = this.sys._ground;
      this.groundY = this.sys.groundAt(this.position.x, this.position.z, this.position.y + 1.6, g);
      // Three rivers cut this city in three. A frightened ped will happily run
      // straight off a wharf, so anyone who finds water under their feet turns
      // round; if they are still out there after three seconds the streamer
      // collects them rather than leaving a man standing on the Monongahela.
      if (g.surface === 'water') {
        this._waterTime += dt + this._groundTimer;
        this.targetYaw += Math.PI;
        this._steer.x = -this._steer.x;
        this._steer.z = -this._steer.z;
        if (this.navMode === 'wander') this.wander.pick(this.rng);
      } else {
        this._waterTime = 0;
      }
    }
    const gy = this.groundY;
    if (Number.isFinite(gy)) {
      const k = Math.min(1, dt * (this.lod === 0 ? 14 : 8));
      this.position.y += (gy - this.position.y) * k;
    }

    // A brother is the only ped a car is solid to. `Crew._yield` steers him
    // round the bodywork; this is the floor that guarantees he is never
    // standing IN it. Crew only, so the cost is two peds against a
    // budget-capped blocker array — see the note in `Crew.depenetrate`.
    if (this.crew && this.sys.crew?.carAvoidEnabled) this.sys.crew.depenetrate(this);
  }

  /* ================================================================== */
  /* visual                                                             */
  /* ================================================================== */

  updateVisual(dt, elapsed) {
    if (!this.active || !this.group) return;
    if (this.state === STATE.DOWN || this.state === STATE.DEAD) {
      // physics drives the bones; the group stays where it was
      return;
    }
    // This runs from `lateUpdate`, so `vehicles.update()` has already written
    // `model.root` for this frame — the one phase in which the DRAWN car pose
    // is available and current. See `_seatPose`.
    const seated = this.state === STATE.DRIVING && this.vehicle;
    if (seated) this._seatPose(true);
    this.group.position.copy(this.position);
    if (seated) {
      /**
       * A DRIVER LEANS WITH HIS CAR. The body takes the car's WHOLE
       * orientation, not just its heading, because a ped's forward is +Z and so
       * is a vehicle's nose — the two frames are the same frame (see the yaw
       * note in `_seatPose`), so this is a copy rather than a conversion.
       *
       * It is also worth headroom. A body left bolt upright in a car with 3
       * degrees of roll loses `lateralOffset * sin(roll)` of clearance over its
       * own head — measured 20 mm of the sports car's 31 mm on a steering
       * input, which is most of the tightest margin in the fleet spent on
       * something that also looks wrong.
       */
      this.group.quaternion.copy(this._seatQuat);
    } else {
      // `.set`, not `.y =`: a body that has just been dragged out of a rolled
      // car still has that car's pitch and roll in its Euler, and assigning
      // only the middle component leaves it there for the rest of his life.
      this.group.rotation.set(0, this.yaw, 0);
    }
    this.group.updateMatrixWorld(true);

    const an = this.animator;
    if (!an) return;

    if (seated) return this._seatedVisual(dt, elapsed, an);

    let clip;
    if (this.state === STATE.COWER) clip = 'cower';
    else if (this.state === STATE.WAIT) clip = 'wait';
    else if (this.state === STATE.IDLE && this._idleAct === 'lean') clip = 'lean';
    else if (this.speed > this.runSpeed * 0.82) clip = 'run';
    else if (this.speed > this.baseSpeed * 1.45) clip = 'jog';
    else if (this.speed > 0.22) clip = 'walk';
    else clip = 'idle';

    an.setState({
      clip,
      speed: this.speed,
      lookTarget: this.lookWeight > 0 ? this.lookAt : null,
      lookWeight: this.lookWeight,
    });

    // Animation rate LOD: the pose write, the look-at and the two foot probes
    // are the whole per-ped cost, and a ped 60 m away in a crowd of a hundred
    // buys nothing from being evaluated every frame. The accumulated dt is
    // handed to the solver so the stride phase stays on the same clock and
    // nothing skates when it comes back to full rate.
    /**
     * FOOT IK LOD. This used to be `lod === 0`, so only the twenty metres
     * nearest the camera got planted feet and everything past that skated —
     * which is most of the crowd in every street frame. The expensive part of
     * the solver is the two physics raycasts, not the maths, so LOD1 now runs
     * the same solver against a FLAT plane at the ped's own cached ground
     * height. That buys the stance lock out to 58 m for no raycasts at all,
     * and a pedestrian that far away is never on a kerb edge where the
     * difference between the flat plane and the real surface would show.
     */
    an.footIk = this.lod <= 1;
    an.probe = this.lod === 0 ? this.sys.probeFn : this._flatProbe;
    this._animAccum += dt;
    /**
     * LOD1 NO LONGER SKIPS FRAMES, and that is a foot-planting fix, not a
     * quality-preset change.
     *
     * `Ped.updateVisual` copies the position and yaw to the group on EVERY
     * frame, including the ones where the pose was skipped — so on a skipped
     * frame the whole rig, feet included, was translated bodily forward. Every
     * other frame beyond 20 m was therefore a 100%-slide frame, which put a
     * floor of about 0.5 under the measured slide of most of the crowd however
     * good the walk cycle was. Re-solving only the feet on the skipped frame
     * was tried and is worse (measured 4.21): the two-bone solver is relative
     * to the current pose and running it twice against the same pose diverges.
     *
     * The cost is bounded and small: the two physics raycasts, which were the
     * expensive part, are already gone at LOD1 (flat probe above), so what is
     * left is a pose write for at most `maxBodies` (40) skinned pedestrians.
     * LOD2 has no skinned body at all and still skips.
     */
    if (this.lod >= 2) {
      if (this._animSkip > 0) { this._animSkip--; return; }
      this._animSkip = 3;
    } else {
      this._animSkip = 0;
    }
    an.update(this._animAccum, elapsed);
    this._animAccum = 0;
  }

  /**
   * The seated half of `updateVisual`.
   *
   * THREE THINGS THIS DOES THAT THE STANDING PATH MUST NOT DO TO A SEATED BODY:
   *
   * 1. FOOT IK OFF. The solver drops the pelvis until the lowest ankle reaches
   *    the ground probe and then LOCKS each planted foot in WORLD space. In a
   *    moving car both are catastrophic: the probe reports the road under the
   *    car, so the pelvis is dragged a seat height downward every frame, and a
   *    world-locked foot is a foot that stays on the tarmac while the car
   *    drives away from it. This is the "ground-clamped while seated"
   *    hypothesis, and it is real — it just was not reachable before, because
   *    nothing was seated in the first place.
   * 2. NO ANIMATION-RATE SKIP. A skipped frame leaves the pose alone but the
   *    group has already been moved to the car's new position, so the body
   *    would be a frame of car travel out of its own seat, every other frame,
   *    at LOD >= 2. The pose is a static one; evaluating it is cheap.
   * 3. RE-SEAT ON THE HEAD, NOT ON THE HIPS. The root was placed by subtracting
   *    the AUTHORED seated head height; this puts the head on the anchor to the
   *    millimetre using the height the pose ACTUALLY produced, so an edit to
   *    `clips.sit` can never quietly push a crown back through a roofline.
   */
  _seatedVisual(dt, elapsed, an) {
    const v = this.vehicle;
    an.setState({
      clip: 'sit',
      speed: 0,
      lookTarget: this.lookWeight > 0 ? this.lookAt : null,
      lookWeight: this.lookWeight,
    });
    /**
     * SNAP INTO THE SEAT. `setState` cross-fades a clip change over 0.22 s, and
     * a cross-fade FROM A STANDING IDLE is a body that is 3/4 upright on the
     * frame it is seated — which put the crown 0.65 m over a police roof for
     * the first tenth of a second — the head-through-the-roof defect, briefly,
     * every time the seat sweep reached a car. Nothing is being blended out of here: a
     * pedestrian is placed in a car by `traffic`, not walked into one, so there
     * is no previous pose that belongs in the shot. Leaving IS blended.
     */
    if (an.blend < 1 && an.prevClip !== 'sit') { an.blend = 1; an.prevClip = 'sit'; }
    an.seatArg.steer = v?.input?.steer ?? 0;
    an.seatArg.drop = this._seatDrop;
    an.footIk = false;
    this._animSkip = 0;
    this._animAccum += dt;
    an.update(this._animAccum, elapsed);
    this._animAccum = 0;

    /**
     * Head-anchored correction. `seatLocal.y` was the anchor minus the AUTHORED
     * seated head height, so the residual is whatever the pose disagreed by —
     * and slid ALONG THE CAR'S OWN UP, not along world Y, because the body is
     * bolted to a car that pitches and rolls. Correcting vertically would slide
     * the driver sideways out of his seat in a corner by
     * `err * tan(roll)`; correcting along the seat's own axis lands the head at
     * the same world height without moving it in the car at all.
     */
    if (an.bones) {
      an.bonePos('Head', this._v2);
      const err = this._anchorY - this._v2.y;
      if (err > 1e-4 || err < -1e-4) {
        const uy = this._seatUp.y;
        this.position.addScaledVector(this._seatUp, err / (uy > 0.25 ? uy : 1));
        this.group.position.copy(this.position);
        this.group.updateMatrixWorld(true);
      }
    }
  }

  /* ================================================================== */
  /* reactions                                                          */
  /* ================================================================== */

  /** Turn and look at something interesting, without changing what you do. */
  glanceAt(point, weight = 1, hold = 2.2) {
    this.lookAt.copy(point);
    this.lookWeight = Math.max(this.lookWeight, weight);
    this._lookHold = hold;
  }

  decayLook(dt) {
    if (this._lookHold > 0) {
      this._lookHold -= dt;
      if (this._lookHold <= 0) this.lookWeight = 0;
    } else if (this.lookWeight > 0) {
      this.lookWeight = Math.max(0, this.lookWeight - dt * 1.2);
    }
  }

  /** A bang nearby: flinch, look at it, maybe start running. */
  startle(point, severity = 0.5) {
    if (!this.alive || this.state === STATE.DOWN) return;
    this.glanceAt(point, 1, 3.0);
    this.animator?.flinch(Math.min(1.3, 0.4 + severity));
    this.fear = Math.min(1.6, this.fear + severity);
    if (this.state === STATE.IDLE) {
      this.state = STATE.WALK;
      this.animator?.clearActs();
    }
    if (severity > 0.55 && this.state !== STATE.FLEE && this.state !== STATE.COWER) {
      this.panic(point, severity);
    }
  }

  /**
   * Get away from `point`. Most people run; some freeze and cower; a few of the
   * ones with something to prove square up instead.
   */
  panic(point, severity = 1) {
    if (!this.alive || this.state === STATE.DOWN || this.state === STATE.DRIVING) return;
    // A brother does not scatter when the shooting starts. He flinches (that
    // already happened in `startle`) and he keeps doing his job — this early
    // return is the difference between a companion and a bystander.
    //
    // Neither does a man who came here to kill you. Every route into a panic
    // funnels through this one function — `startle` above it, the explosion and
    // `wanted:heat` listeners in `index.js`, `applyDamage` below, and
    // `sys.panic` — so this single guard is what stops the first shot of a
    // firefight scattering the people the chapter is ABOUT.
    if (this.crew || this.isHostile) return;
    this.threat.copy(point);
    this.hasThreat = true;
    this.fear = Math.min(2, this.fear + severity);
    this.animator?.clearActs();
    this.glanceAt(point, 1, 2.0);
    const r = this.rng.float();
    if (r < 0.14 * Math.min(1, severity)) {
      this.state = STATE.COWER;
    } else if (
      r > 0.965 &&
      severity < 1.2 &&
      (this.outfit.archetype === 'mill' || this.outfit.archetype === 'nightlife' ||
       this.outfit.archetype === 'street')
    ) {
      this.state = STATE.FIGHT;
      this.fightTarget = this.threat;
    } else {
      this.state = STATE.FLEE;
      this.navMode = 'flee';
    }
    this.stateTime = 0;
    this._decision = 4;
  }

  /** A car is going to hit you in `ttc` seconds unless you move. */
  dodge(from, lateralSign, ttc) {
    if (!this.alive || this.state === STATE.DOWN) return;
    if (this.animator?.diving) return;
    this.animator?.diveNow(lateralSign);
    this.glanceAt(from, 1, 2.0);
    this.fear = Math.min(2, this.fear + 1.1);
    // the dive itself displaces the ped: a dodge that does not move you is a
    // dodge that gets you run over
    const push = Math.min(2.6, 1.6 / Math.max(0.25, ttc));
    this._v.copy(this.position).sub(from);
    this._v.y = 0;
    this._v.normalize();
    this.position.x += -this._v.z * lateralSign * push * 0.6;
    this.position.z += this._v.x * lateralSign * push * 0.6;
    // He dives out of the way — but he does not then run off down the street.
    if (this.crew || this.isHostile) return;
    this.state = STATE.FLEE;
    this.threat.copy(from);
    this.hasThreat = true;
    this.stateTime = 0;
  }

  /* ================================================================== */
  /* damage                                                             */
  /* ================================================================== */

  applyDamage(amount, part, point, dir) {
    if (!this.alive) return;
    // A DeCarlo brother goes down, he does not die. Everything about the hit —
    // the collider, the part, the ballistics that produced it — is real; only
    // the consequence is different, and `crew.js` owns it.
    if (this.crew) {
      /**
       * FRIENDLY FIRE. `weapon:fire` is raised by `src/weapons` and by nothing
       * else — `crew.js` and `game/hostiles.js` both deliberately avoid it, and
       * `police` shoots through its own path — so a round landing on a brother
       * within `ffWindow` of that event is THE PLAYER'S. It costs a tenth.
       *
       * Without this the crew is a liability in exactly the way the design
       * brief forbids: a brother crossing your burst eats ~20 rounds' worth of
       * your own fire and goes down, and the player is the reason. He still
       * flinches, `crew:friendlyfire` still fires so the HUD can say something,
       * and forty deliberate rounds will still floor him — but the accident
       * cannot. The behavioural half of the fix is `Crew._yield`, which walks
       * him out of the lane in the first place; this is the safety net for the
       * frame before he gets there.
       */
      let dmg = amount * (part === 'head' ? 1.6 : 1);
      const crew = this.sys.crew;
      const t = this.sys.ctx.time?.elapsed ?? 0;
      // `crew.js` imports THIS file, so the window and the scale are read off
      // the live manager rather than imported back the other way.
      if (crew && t - (this.sys.playerShotAt ?? -1e9) <= crew.ffWindow) {
        dmg *= crew.friendlyFireScale;
        this.crew.friendlyHits++;
        this.sys.ctx.events.emit('crew:friendlyfire', { id: this.crew.id, amount: dmg });
      }
      crew?.hurt(this.crew, dmg, point, dir);
      return;
    }
    this.health -= amount;
    this.fear = 2;
    if (this.health <= 0) {
      this.die(point, dir, amount);
      return;
    }
    this.animator?.flinch(1.2);
    this.animator?.setAct('hurt', Math.min(1, Math.max(0, 1 - this.health / this.maxHealth)));
    if (this.state !== STATE.FLEE) this.panic(point ?? this.position, 1.4);
  }

  /**
   * Hit by a vehicle. This is the one reaction a GTA-class game cannot fake:
   * the body has to leave the ground with the car's momentum in it, tumble,
   * and stay on the street as an injured person — not vanish.
   */
  hitByVehicle(velocity, point, mass = 1400) {
    if (!this.alive) return;
    const speed = Math.hypot(velocity.x, velocity.z);
    // 30 km/h leaves you on the road with broken ribs; 70 km/h does not. The
    // curve is deliberately survivable in the middle, because a street where
    // every clipped pedestrian dies has no aftermath in it.
    const dmg = Math.min(180, 4 + speed * speed * 0.30 * (mass / 1400));
    /**
     * Running your own brother over is a mistake, not a murder — and it is ONE
     * mistake. A struck pedestrian leaves for `STATE.DOWN` and the sweep in
     * `_vehicleThreats` then skips him; a brother stays on his feet, so without
     * this cooldown the same car re-hits him on every frame its corridor still
     * overlaps him. Measured: eight identical 8.4-damage hits from one passing
     * sedan, which quietly flattened the crew during ordinary following and was
     * only visible because the behaviour harness asserted on the down count.
     */
    if (this.crew) {
      if (this._vehHitCd > 0) return;
      this._vehHitCd = 1.2;
      this._v.set(velocity.x, 0, velocity.z);
      if (this._v.lengthSq() < 1e-4) this._v.set(0, 0, 1);
      this.sys.crew?.hurt(this.crew, dmg, point ?? this.position, this._v.normalize(), 0.6);
      return;
    }
    this.health -= dmg;
    const lethal = this.health <= 0 || speed > 21;
    this._v.set(velocity.x, 0, velocity.z);
    if (this._v.lengthSq() < 1e-4) this._v.set(0, 0, 1);
    this._v.normalize();
    // an impulse with a real launch angle: bonnet height throws them up and over
    const j = Math.min(9.5, 1.6 + speed * 0.42) * Math.min(2, mass / 1400);
    this._v2.set(this._v.x * j, j * 0.55 + speed * 0.06, this._v.z * j);
    this._down(point ?? this.position, this._v2, lethal);
  }

  die(point, dir, amount = 40) {
    if (!this.alive) return;
    const imp = this._v2.copy(dir ?? this._v.set(0, 0, 1)).normalize()
      .multiplyScalar(Math.min(5.5, 1.4 + amount * 0.02));
    this._down(point ?? this.position, imp, true);
  }

  /** Hand the live pose to the ragdoll solver. */
  _down(point, impulse, lethal) {
    const phys = this.sys.phys;
    this.alive = !lethal ? true : false;
    this.state = lethal ? STATE.DEAD : STATE.DOWN;
    this.stateTime = 0;
    this._downTime = 0;
    this.speed = 0;
    this.desiredSpeed = 0;
    if (this.animator) this.animator.enabled = false;
    this._dropColliders();

    // A pedestrian too far away to have a skinned body cannot be ragdolled —
    // there is no skeleton to hand over. Pull a body first; if the budget is
    // spent, they die where they stand and the streamer collects them.
    if (!this.mesh) this.sys._acquireBody(this);

    let rd = null;
    if (phys && this.mesh) {
      // Fat capsules that start half-buried tunnel through the floor, so lift
      // the pose clear for the one frame it takes to build the doll.
      const lift = 0.14 * this.scale;
      this.group.position.y += lift;
      this.group.updateMatrixWorld(true);
      /**
       * NOT `phys.createRagdollFromSkeleton`. That helper derives its spec by
       * walking bone->first-child, which on a humanoid leaves the arms and the
       * legs as free-floating chains with nothing holding them to the torso —
       * the "body strewn across the road" defect. Measured on the emitted
       * skinned geometry over 48 kills: worst edge stretch 77.4x bind, worst
       * joint gap 74.9x. `buildPedRagdoll` uses the welded `DOLL` spec instead
       * (4.6x / 1.13x). See `doll.js` and `node src/peds/corpseprobe.mjs`.
       */
      rd = buildPedRagdoll(phys, this.bones, this.skeleton, {
        actor: this,
        mass: this.mass,
        scale: this.scale,
        iterations: 8,
        velocity: { x: this.velocity.x * 0.5, y: 0, z: this.velocity.z * 0.5 },
      });
      if (rd) rd.actor = this;
      this.group.position.y -= lift;
      this.group.updateMatrixWorld(true);
      if (rd && impulse && point) {
        rd.applyImpulse(point.x, point.y, point.z, impulse.x, impulse.y, impulse.z, 0.85);
      }
    }
    this.ragdoll = rd;
    this.__ragdoll = rd;

    // A brother hitting the deck is NOT a death. `actor:death` is priced by
    // `police` (killPed / killCop), counted by `game` and drawn by `ui`, so
    // emitting it here would charge the player a wanted star and a kill
    // notification every time one of his own crew went down.
    if (!this.crew) {
      this.ctx.events.emit('actor:death', {
        actor: this,
        point: point ?? this.position,
        impulse,
        headshot: false,
      });
    }
    // everybody nearby saw that
    this.sys.panic(point ?? this.position, lethal ? 22 : 15, lethal ? 1.3 : 0.9);
  }


  /* ================================================================== */
  /* vehicles / carjacking                                              */
  /* ================================================================== */

  /**
   * WHERE A PASSENGER'S FEET GO, IN THE CAR'S OWN SPACE. Resolved once per
   * seating, because `vehicles.seatAnchor()` allocates four Vector3s (rule 5).
   *
   * THE ANCHOR IS THE HEAD. THE ROOT IS THE FEET — the same trap
   * `player/vehicle.js` documents at length. `seatAnchor` returns a point ON
   * THE BODY (`vehicles` parks its cockpit camera there), so copying it into
   * the root lifts the whole rig by a head height. Subtracting `SEAT.headHeight`
   * — the number the `sit` clip is authored to reproduce — puts the head where
   * `vehicles` asked for it and the rest of the body underneath it, in the
   * cabin, for every class from the sports car to the bus without this file
   * knowing anything about either.
   *
   * The fallback matters: the offline rigs and any vehicle-like object that is
   * not a real `Vehicle` have no `seatAnchor`, and a driver frozen at the COM
   * is the bug this whole method exists to remove. Half-extents plus the car's
   * own `seatHeight` are enough to be roughly right.
   */
  _resolveSeat(v) {
    this._seatFor = v;
    const seat = this.seat < 0 ? 0 : this.seat;
    const scale = this.scale ?? 1;
    let anchor = null;
    const vehicles = this.sys._vehicles ??
      (this.sys._vehicles = this.ctx?.peek?.('vehicles') ?? null);
    if (vehicles && typeof vehicles.seatAnchor === 'function') {
      try { anchor = vehicles.seatAnchor(v, seat); } catch { anchor = null; }
    }
    /**
     * HOW FAR THE SEAT IS OFF THE ROAD, without asking `vehicles` anything it
     * does not already publish. `seatAnchor.enter` is the door anchor, and its
     * local y is `0.05 - comY` by construction — i.e. five centimetres over the
     * ground the car stands on. The gap between that and the head anchor is the
     * whole vertical budget the occupant has, and it is a property of the class:
     * 0.90 m on the sports car, 2.08 m on the truck. Everything the leg pose
     * needs to know is in that one number, so nothing here reads `spec.style`
     * and no second copy of the roofline is created (see rule 12's note on two
     * subsystems deciding the same fact).
     */
    let overRoad = null;
    if (anchor?.local) {
      this.seatLocal.copy(anchor.local);
      this.seatSide = anchor.side ?? -1;
      if (anchor.enter && v.position) {
        // `_seatQuat` is free scratch here: `_seatPose` overwrites it with this
        // frame's pose on the very next statement after this call returns.
        this._v.copy(anchor.enter).sub(v.position);
        if (v.quaternion) this._v.applyQuaternion(this._seatQuat.copy(v.quaternion).invert());
        overRoad = anchor.local.y - this._v.y + 0.05;
      }
    } else {
      const half = v?.spec?.half;
      const halfW = half?.x ?? (v?.width ?? 2.0) * 0.5;
      const halfL = half?.z ?? (v?.length ?? 4.6) * 0.5;
      this.seatSide = seat % 2 === 0 ? 1 : -1;
      this.seatLocal.set(
        this.seatSide * halfW * 0.46,
        (v?.seatHeight ?? 0.32) + SEAT.headHeight,
        seat < 2 ? halfL * 0.12 : -halfL * 0.4
      );
      overRoad = (v?.seatHeight ?? 0.32) + SEAT.headHeight + (half?.y ?? 0.7);
    }

    /**
     * Sink whatever this silhouette's crown exceeds the budget `seatAnchor`
     * reserved above the head. A bare 1.75 m head is 0.240 m of skull; a beanie
     * on a 1.94 m man is 0.31 m, and the sports car has 13 mm of spare
     * headroom. Without this the tallest tenth of the crowd wears its hat
     * through the roof of the two low classes — which is the same complaint
     * this whole change exists to answer, just from a different cause.
     */
    const crown = (this.crownBind ?? 1.752) - SEAT.headBind;
    const excess = crown * scale - SEAT.crownBudget;
    const sink = excess > 0 ? excess : 0;

    // Head anchor -> body root. `SEAT` is the same record `clips.sit` poses
    // from, so the head lands back exactly where `vehicles` put it.
    this.seatLocal.y -= SEAT.headHeight * scale + sink;
    // ...and inboard, because a greenhouse narrows above the belt line the
    // anchor's x was measured at. See `SEAT.trackIn`.
    this.seatLocal.x *= SEAT.trackIn;
    this._seatSink = sink;

    /**
     * How much footwell there is under the root, converted into the 0..1 the
     * leg pose takes. The thing that must not happen is a shoe hanging out
     * under the rocker panel, so the floor estimate is deliberately a LOWER
     * bound (see `SEAT.floorGap`) and the mapping from metres to `drop` is the
     * measured one, not the joint angles.
     *
     * The result is `drop` near 0 for every car in the fleet and a slight fold
     * for the truck and the bus — which is not a fudge, it is what
     * `seatAnchor` decided: it puts a car driver's head only 0.64 m over his
     * own floor, and a man with 0.64 m of cabin under his head has his legs
     * out along it, not folded under him.
     */
    const H = overRoad ?? (SEAT.headHeight * scale + SEAT.floorGap);
    const floorEst = SEAT.floorGap + SEAT.floorSlope * Math.max(0, H - SEAT.floorKnee);
    const fall = floorEst - SEAT.headHeight * scale - sink;
    const d = (fall / scale - SEAT.soleFallBase) / SEAT.soleFallSpan;
    this._seatDrop = d < -1 ? -1 : d > 1 ? 1 : d;
  }

  /**
   * Put the body in the seat.
   *
   * @param drawn  read the car's DRAWN pose (`model.root`, what the renderer is
   *               about to draw) rather than its physics pose. Only legal from
   *               `lateUpdate`: `model.root` is written by `vehicles.update()`,
   *               so reading it from `update()` yields LAST frame's pose, which
   *               is strictly worse than the physics pose. Same rule, and the
   *               same reason, as `player/camera.js`.
   *
   * MEASURED separation between the two, one full physics step of travel at
   * 30 m/s: 0.19 m on a sedan, 0.25 m on the Kessel, 0.26 m on the muscle car.
   * That is a body sliding fore and aft inside the car it is drawn in, and it
   * is a fifth the size of the standing-driver bug but it is the same class of
   * defect as the one confirmed in `src/player/vehicle.js`.
   */
  _seatPose(drawn) {
    const v = this.vehicle;
    if (!v) return false;
    if (this._seatFor !== v) this._resolveSeat(v);

    let px = 0, py = 0, pz = 0;
    const q = this._seatQuat;
    const obj = drawn ? (v.model?.root ?? null) : null;
    if (obj) {
      obj.updateWorldMatrix(true, false);
      this._v.setFromMatrixPosition(obj.matrixWorld);
      px = this._v.x; py = this._v.y; pz = this._v.z;
      q.setFromRotationMatrix(obj.matrixWorld);
    } else if (v.position) {
      px = v.position.x; py = v.position.y; pz = v.position.z;
      if (v.quaternion) q.copy(v.quaternion); else q.identity();
    } else {
      return false;
    }

    this._seatPos.copy(this.seatLocal).applyQuaternion(q);
    this._seatPos.x += px; this._seatPos.y += py; this._seatPos.z += pz;
    this.position.copy(this._seatPos);
    this.groundY = this._seatPos.y;
    /**
     * The head anchor, back in world space. Rebuilt from the SAME rotation
     * rather than as `root.y + headHeight`, because a car pitches: under brakes
     * the flat-Y shortcut is worth `headHeight * (1 - cos pitch)`, which is
     * small but is spent out of the ~60 mm of headliner clearance
     * `vehicles.seatAnchor` leaves, and this is the one budget that must not be
     * eaten by an approximation.
     */
    this._seatUp.set(0, 1, 0).applyQuaternion(q);
    this._anchorY = this._seatPos.y + this._seatUp.y * SEAT.headHeight * (this.scale ?? 1);

    /**
     * ONE YAW CONVENTION, AND IT IS NOT THE PLAYER'S.
     *
     * A vehicle's nose is +Z, and so is a PEDESTRIAN's forward: `rig.js` puts
     * the toe at z = +0.104 against an ankle at z = -0.024, and `_move` steers
     * with `atan2(steer.x, steer.z)`, which sends local +Z along the direction
     * of travel. So `seatYaw = heading` with NO half turn — the opposite of
     * `player/vehicle.js`, whose actor faces -Z and therefore needs one. Taking
     * that file's `+ Math.PI` on trust seats every driver facing the back
     * window; the toe/ankle geometry above is why this one does not.
     */
    this._seatYaw = Math.atan2(
      2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x)
    );
    this.yaw = this._seatYaw;
    this.targetYaw = this._seatYaw;
    this.speed = 0;
    return true;
  }

  /** `player` calls this through PedSystem.pullFromVehicle(). */
  ejectFrom(vehicle, doorPoint) {
    this.vehicle = null;
    this._seatFor = null;
    this.isDriver = false;
    this.seat = -1;
    this.state = STATE.FLEE;
    this.stateTime = 0;
    this.fear = 2;
    this.hasThreat = true;
    if (doorPoint) {
      this.position.set(doorPoint.x, doorPoint.y, doorPoint.z);
      this.threat.copy(doorPoint);
    }
    this.groundY = this.sys.groundAt(this.position.x, this.position.z, this.position.y + 2);
    this.position.y = this.groundY;
    this.navMode = 'flee';
    if (this.group) this.group.visible = true;
    this.animator?.clearActs();
    this.ctx.events.emit('vehicle:exit', { vehicle, actor: this });
  }

  /* ================================================================== */

  /** Set the resting arm layer implied by the outfit's props. */
  _applyCarry() {
    const an = this.animator;
    if (!an) return;
    const p = this.outfit.props;
    if (p.umbrella) an.setAct('umbrella', 1, -1);
    else if (p.umbrellaClosed) an.setAct('carry', 1, -1);
    else if (this.shapeDef.extras?.includes('bag')) an.setAct('carry', 0.7, 1);
    else if (this.rng.float() < 0.22) an.setAct('pockets', 1);
  }
}
