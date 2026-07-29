import * as THREE from 'three';
import { instantiate, disposeInstance } from './models/build.js';
import { Spring, Spring3, Noise1, clamp, clamp01, lerp, smoothstep, easeOutCubic, easeOutBack, DEG } from './mathx.js';

/**
 * THE THIRD-PERSON WEAPON RIG.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `viewmodel.js`
 * ---------------------------------------------------------------------------
 * The inherited rig drew a pair of arms and a rifle into `ctx.viewScene` with
 * its own near plane, sixty centimetres from the eye. This game is played over
 * the shoulder: the weapon is a WORLD OBJECT the size of your fist held by a
 * character you are looking at from two and a half metres behind. Everything
 * that made the first-person rig good — sway, lag, procedural reloads, spring
 * recoil — still applies, but it is now applied to a transform that is SLAVED
 * to a bone in someone else's skeleton, and the recoil that the player feels
 * is the camera and the character's upper body, not a viewmodel kick.
 *
 * ---------------------------------------------------------------------------
 * HOW THE WEAPON GETS ONTO THE HAND
 * ---------------------------------------------------------------------------
 * NOT by `hand.add(weapon)`. Parenting into the character's bone hierarchy
 * would put weapon meshes inside a `SkinnedMesh`'s bone tree (three walks that
 * tree every frame for the skinning matrices), and `player.setBrother()`
 * disposes and rebuilds the whole rig — which would silently take the weapon
 * with it. Instead the weapon group is a direct child of `ctx.scene` and its
 * transform is COMPOSED from `player.weaponHand.matrixWorld` in `lateUpdate`,
 * after `player.update()` has run the animator. Re-acquiring the bone is a
 * property read, so a brother swap costs nothing and cannot lose the weapon.
 *
 * The same machinery gives holstering for free: the holstered pose is the same
 * composition against the CHEST bone with the model's `holster` node, and
 * `drawT` interpolates between the two. A weapon coming out of its sling is
 * one lerp, not a second animation system.
 *
 * ---------------------------------------------------------------------------
 * THE HAND FRAME
 * ---------------------------------------------------------------------------
 * `player`'s skeleton is authored with every bone at identity rotation in bind
 * pose, so the hand bone's local axes ARE the character's bind axes: +Y up,
 * +X toward the character's right, and the finger chain running down -Y
 * (`handEnd` sits 0.135 m below `hand`). When the animator IKs the arm to the
 * aim target the whole chain rotates, so "down the fingers" becomes "down the
 * barrel". A weapon is authored with its bore along -Z (`models/*.js`), so the
 * base rotation that turns a model into a held weapon maps model -Z onto hand
 * -Y, which is a -90 degree rotation about X. Everything on top of that is
 * per-hold-type cant, authored in HOLD below and tuned against renders.
 */

/** Model -Z (the bore) onto hand -Y (down the fingers). */
const BORE_TO_HAND = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(-Math.PI / 2, 0, 0, 'XYZ')
);

/**
 * Per-hold-type grip cant, applied after BORE_TO_HAND, in HAND space.
 *
 * `cant`   euler XYZ radians — how the weapon sits in the fist (MELEE path)
 * `off`    metres in hand space — the fist closes around the grip (MELEE path)
 * `aim`    euler XYZ radians relative to the aim basis (FIREARM path)
 * `grip`   metres in weapon space, wrist -> weapon origin (FIREARM path)
 * `low`    extra pitch when NOT aiming: a carried weapon points at the pavement
 * `support` does the left hand come across? (drives the animator's aim pose)
 */
const HOLD = {
  /* Nothing in the hand: the fist IS the weapon. */
  fists: { cant: [0, 0, 0], off: [0, -0.02, 0], aim: [0, 0, 0], grip: [0, 0, 0], low: 0, support: false, twoHand: false },
  /* A pistol-gripped tool held out at arm's length, slightly canted inboard. */
  oneHand: { cant: [0.10, 0, -0.06], off: [0.005, -0.055, 0.005], aim: [0, 0, -0.09], grip: [0.005, 0.035, 0.02], low: 0.30, support: false, twoHand: false },
  /* Both hands on it — the support hand is 0.2 m up the forend. */
  twoHand: { cant: [0.06, 0, 0], off: [0.004, -0.058, 0.004], aim: [0, 0, 0], grip: [0.005, 0.045, 0.03], low: 0.22, support: true, twoHand: true },
  /**
   * On the shoulder. The tube has to ride high AND well outboard: at 0.02 m of
   * lateral offset a 1.15 m Scrap Rocket ran straight through the character's
   * skull, because the launch tube's axis was directly over the wrist and the
   * wrist is in front of the sternum in the aim pose. 0.085 m puts the bore
   * over the deltoid, which is where you actually carry one.
   */
  shoulder: { cant: [0.02, 0, 0.10], off: [0.01, -0.06, -0.02], aim: [0, 0, 0.06], grip: [0.085, 0.10, -0.03], low: 0.14, support: true, twoHand: true },
  /**
   * A tool held ready to swing.
   *
   * Every model in `models/` — gun and tool alike — puts its business end at
   * NEGATIVE Z (a pipe's `zTip = zButt - LEN`), and the aim basis maps -Z onto
   * the look direction, so a bare cant of 0 lays the pipe out horizontally
   * along the line of sight. `+0.95` rad about X lifts the head to 54 degrees
   * above that, which is where you carry a crowbar you are about to use.
   */
  melee1: { cant: [-1.30, 0, 0.12], off: [0.004, -0.05, 0], aim: [0.78, 0.34, -0.16], grip: [0.05, -0.05, 0.04], low: 0, support: false, twoHand: false },
  /* A metre of pipe: heavier, so it rests further back and further out. */
  melee2: { cant: [-1.18, 0, 0.16], off: [0.006, -0.055, 0], aim: [0.70, 0.30, -0.20], grip: [0.07, -0.07, 0.05], low: 0, support: true, twoHand: false },
};

/**
 * Where a holstered weapon rides. The model's own `holster` node supplies the
 * fine offset; this is the bone it hangs off and the coarse placement.
 */
const SLING = {
  /**
   * `+Z` is BEHIND the character in bind space (forward is -Z), so these push
   * the weapon onto the back. The torso is about 0.19 m deep at the chest and
   * the models are authored around their own grip, so anything under ~0.22 m
   * of Z sits INSIDE the ribcage — measured: a holstered Rivet Gun at 0.16 m
   * showed one visible corner of receiver and nothing else.
   */
  melee: { bone: 'chest', pos: [0.02, 0.02, 0.26], rot: [0, 0, 0] },
  light: { bone: 'hips', pos: [0.10, 0.06, 0.13], rot: [0, 0, 0] },
  precise: { bone: 'chest', pos: [0.0, 0.0, 0.27], rot: [0, 0, 0] },
  explosive: { bone: 'chest', pos: [0.0, 0.03, 0.30], rot: [0, 0, 0] },
};

/* ========================================================================== */
/*  Clips                                                                     */
/* ========================================================================== */

/**
 * A clip is a duration plus a list of `{ t, name }` events in NORMALISED time.
 * The pose itself is procedural — a function of `u` and the model's own travel
 * nodes — because sixteen weapons with five different loading mechanisms
 * (magazine, break-open, hopper, rubber bands, a drum you drop in the top)
 * cannot share one keyframe table, and authoring five tables by hand is how
 * you end up with a bolt that cycles on a break-open flare gun.
 */
const CLIP_EVENTS = {
  draw: [[0, 'start'], [0.55, 'ready'], [1, 'end']],
  holster: [[0, 'start'], [1, 'end']],
  reloadTac: [[0, 'start'], [0.22, 'magout'], [0.34, 'magdrop'], [0.72, 'magin'], [1, 'end']],
  reloadEmpty: [[0, 'start'], [0.18, 'magout'], [0.30, 'magdrop'], [0.62, 'magin'], [0.86, 'boltrelease'], [1, 'end']],
  inspect: [[0, 'start'], [1, 'end']],
};

/* ========================================================================== */

export class WeaponRig {
  constructor(ctx, mats) {
    this.ctx = ctx;
    this.mats = mats;
    this.entries = new Map();
    this.active = null;

    /** Everything the rig owns lives under one node so dispose is one call. */
    this.root = new THREE.Object3D();
    this.root.name = 'weapons-thirdperson';
    ctx.scene.add(this.root);

    /* ---- animation state ---- */
    this.adsT = 0;
    this.drawT = 1;
    this.boltHold = 0;
    this.boltCycle = 0;
    this.triggerT = 0;
    this.pumpT = 0;
    this.clip = null;
    this.clipName = null;
    this.clipT = 0;
    this._clipEventIndex = 0;
    this.onClipEvent = null;
    this.debugFrozen = false;
    this.swingT = -1;
    this.swingDur = 0;
    this.swingSpec = null;
    this.swingSide = 1;
    this.hidden = false;
    /**
     * PER-BROTHER HANDLING (see lib.js BROTHER_HANDLING). `handling` scales
     * draw / holster / swap / ADS time, `reloadScale` scales the reload clips.
     * 1 = the def's authored numbers. Dylan brings a weapon up 20% faster than
     * Carson; Aidan reloads 16% faster than either. Set by
     * `WeaponSystem.setBrother`.
     */
    this.handling = 1;
    this.reloadScale = 1;
    this._swapTo = null;
    this._swapT = 0;
    this._swapOut = 0.14;
    this._swapIn = 0.18;

    /* ---- springs: the weapon's own motion inside the hand ---- */
    this.recPos = new Spring3(15, 0.42);
    this.recRot = new Spring3(17, 0.4);
    this.settle = new Spring3(6.5, 0.85);
    this.lag = new Spring3(9, 0.65);
    this.noise = new Noise1(ctx.rng.fork(), 512);
    this.noiseT = 0;

    /* ---- preallocated scratch (ARCHITECTURE rule 5) ---- */
    this._p = new THREE.Vector3();
    this._p2 = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._q3 = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._m = new THREE.Matrix4();
    this._m2 = new THREE.Matrix4();
    this._handPos = new THREE.Vector3();
    this._handQuat = new THREE.Quaternion();
    this._slingPos = new THREE.Vector3();
    this._slingQuat = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._prevMuzzle = new THREE.Vector3();
    this._armEuler = new THREE.Euler();

    /* ---- support-hand IK scratch (see `_driveSupportArm`) ---- */
    this._ikTarget = new THREE.Vector3();
    this._ikShoulder = new THREE.Vector3();
    this._ikElbow = new THREE.Vector3();
    this._ikDir = new THREE.Vector3();
    this._ikUpper = new THREE.Vector3();
    this._ikLower = new THREE.Vector3();
    this._ikAxis = new THREE.Vector3();
    this._ikPole = new THREE.Vector3();
    this._ikRest = new THREE.Vector3();
    this._ikSlide = new THREE.Vector3();
    this._ikQP = new THREE.Quaternion();
    this._ikQ1 = new THREE.Quaternion();
    this._ikQ2 = new THREE.Quaternion();
    this._ikQD = new THREE.Quaternion();
    this._ikLocal = new THREE.Quaternion();
    /** Read by the pose harness: did the support hand reach the grip? */
    this.gripReach = { active: false, error: 0, weight: 0 };

    this._boneMiss = 0;
    /** Last state handed to `update`, so `place()` can run standalone. */
    this._lastState = { ads: false, sprint: false, speed: 0, holstered: false };
  }

  /* ====================================================================== */
  /*  build                                                                 */
  /* ====================================================================== */

  /**
   * @param {object} model  a `models/*.js` description
   * @param {object} def    the finalised `lib.js` entry
   */
  add(model, def, rng) {
    const bake = this.mats.lib?.bakeMasks?.bind(this.mats.lib) ?? null;
    const inst = instantiate(model, this.mats, { rng, bakeMasks: bake, name: `weapon-${def.id}` });
    inst.group.visible = false;
    this.root.add(inst.group);

    const n = model.nodes ?? {};
    const hold = HOLD[def.hold] ?? HOLD.twoHand;

    /* Muzzle / eject / melee-edge markers are real children so their world
     * transform falls out of the same matrix update as the mesh. */
    const muzzle = new THREE.Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.fromArray(n.muzzle ?? [0, 0, -0.3]);
    if (n.muzzleDir) {
      muzzle.lookAt(
        muzzle.position.x + n.muzzleDir[0],
        muzzle.position.y + n.muzzleDir[1],
        muzzle.position.z + n.muzzleDir[2]
      );
    }
    inst.group.add(muzzle);

    const eject = new THREE.Object3D();
    eject.name = 'eject';
    eject.position.fromArray(n.eject ?? [0.03, 0.02, -0.05]);
    inst.group.add(eject);

    const entry = {
      id: def.id,
      def,
      model,
      inst,
      group: inst.group,
      parts: inst.parts,
      nodes: n,
      hold,
      muzzle,
      eject,
      ejectDir: new THREE.Vector3().fromArray(n.ejectDir ?? [1, 0.4, 0.1]).normalize(),
      tris: inst.tris,
      /* Hand offset: BORE_TO_HAND, then the hold cant, then the model's own
       * fine correction, and a translation so the fist closes on the grip. */
      handQuat: new THREE.Quaternion(),
      handOff: new THREE.Vector3(),
      /* Firearm path: cant relative to the AIM basis (model -Z is already the
       * bore, so no BORE_TO_HAND here) and the offset from the wrist to where
       * the weapon's own origin should sit, in WEAPON space. */
      aimQuat: new THREE.Quaternion(),
      gripOff: new THREE.Vector3(),
      slingQuat: new THREE.Quaternion(),
      slingOff: new THREE.Vector3(),
      slingBone: (SLING[def.class] ?? SLING.light).bone,
      /**
       * The support hand's IK target, in WEAPON space. Every one of the sixteen
       * models authors this and, until now, nothing read it — which is why at
       * 1.5 m the left hand hung at the character's hip while he carried a
       * two-handed launcher. `models/*.js` writes it either as a bare triple or
       * as `{ pos, rot }`; both are accepted.
       */
      gripL: gripVector(n.gripL),
      /* Loaded-round visibility: `spear`, `round`, `charge`, `shaft`, `shell`
       * are the projectile sitting in the weapon and must vanish when fired. */
      loadedPart: inst.parts.spear ?? inst.parts.round ?? inst.parts.charge ??
        inst.parts.shaft ?? inst.parts.shell ?? null,
      magLen: 0.1,
      shell: def.shell ?? null,
      /* Where `instantiate` seated each moving sub-assembly, so a hinge can
       * rotate the seat point about a pivot that is somewhere else entirely. */
      seat: {},
    };
    for (const name in inst.parts) {
      entry.seat[name] = n[`${name}Seat`]?.pos ?? [0, 0, 0];
    }

    entry.handQuat.copy(BORE_TO_HAND);
    this._e.set(hold.cant[0], hold.cant[1], hold.cant[2], 'XYZ');
    entry.handQuat.multiply(this._q.setFromEuler(this._e));
    const hn = n.hand ?? { pos: [0, 0, 0], rot: [0, 0, 0] };
    this._e.set(hn.rot?.[0] ?? 0, hn.rot?.[1] ?? 0, hn.rot?.[2] ?? 0, 'XYZ');
    entry.handQuat.multiply(this._q.setFromEuler(this._e));
    entry.handOff.set(
      hold.off[0] + (hn.pos?.[0] ?? 0),
      hold.off[1] + (hn.pos?.[1] ?? 0),
      hold.off[2] + (hn.pos?.[2] ?? 0)
    );

    this._e.set(hold.aim?.[0] ?? 0, hold.aim?.[1] ?? 0, hold.aim?.[2] ?? 0, 'XYZ');
    entry.aimQuat.setFromEuler(this._e);
    entry.gripOff.fromArray(hold.grip ?? [0, 0, 0]);

    const sl = SLING[def.class] ?? SLING.light;
    const hs = n.holster ?? { pos: [0, 0, 0], rot: [0, 0, 0] };
    this._e.set(
      sl.rot[0] + (hs.rot?.[0] ?? 0),
      sl.rot[1] + (hs.rot?.[1] ?? 0),
      sl.rot[2] + (hs.rot?.[2] ?? 0),
      'XYZ'
    );
    entry.slingQuat.setFromEuler(this._e);
    entry.slingOff.set(
      sl.pos[0] + (hs.pos?.[0] ?? 0),
      sl.pos[1] + (hs.pos?.[1] ?? 0),
      sl.pos[2] + (hs.pos?.[2] ?? 0)
    );
    this._clearBody(entry, sl);

    this.entries.set(def.id, entry);
    return entry;
  }

  /**
   * PUSH THE HOLSTERED WEAPON OUT OF THE RIBCAGE.
   *
   * The sling offsets in `SLING` are one number per CLASS, and the class says
   * nothing about how thick the weapon is: a Rivet Gun's receiver is 90 mm
   * across the breech and a Flare Gun's is 40, so the offset that sat one of
   * them on the back buried the other in it. Measured before this: the Rivet
   * Gun showed one corner of receiver and nothing else, which reads as a
   * texture painted on the shirt rather than a tool slung across it.
   *
   * So the clearance is DERIVED instead of authored: the model's own bounding
   * box says how thick the thing is, and the sling offset is pushed out until
   * that thickness clears the body.
   *
   *   chest sling  outward is +Z (behind the character; forward is -Z)
   *   hip sling    outward is +X (the character's right) AND +Z
   *
   * THICKNESS, NOT THE BOUNDING CORNER. A slung weapon lies ALONG the back —
   * its long axis is tangential, and only its cross-section has to clear the
   * ribs. Clearing the nearest CORNER of the box instead pushed a 0.95 m Dock
   * Pipe 0.82 m off the spine, floating behind the character like a canoe: a
   * correction far worse than the defect. The measure is therefore the box's
   * smallest dimension, taken about its centre, and the whole adjustment is
   * capped at `MAX_PUSH` so a bad box can never launch a weapon into orbit.
   */
  _clearBody(entry, sl) {
    const g = entry.group;
    g.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(g);
    if (box.isEmpty() || !Number.isFinite(box.min.x)) return;
    entry.bounds = box;
    const MAX_PUSH = 0.09;
    box.getSize(this._v);
    const thickness = Math.min(this._v.x, this._v.y, this._v.z);
    box.getCenter(this._v);
    this._v.applyQuaternion(entry.slingQuat);
    /* Torso half-depth at the chest is ~0.095 m and the hips are ~0.13 m wide;
     * the extra millimetres are the shirt and a little daylight. */
    const axes = sl.bone === 'hips' ? [[0, 0.135], [2, 0.075]] : [[2, 0.115]];
    entry.slingPush = 0;
    for (const [axis, clear] of axes) {
      const centre = this._v.getComponent(axis);
      const had = entry.slingOff.getComponent(axis);
      const need = Math.min(clear + thickness * 0.5 - centre, had + MAX_PUSH);
      if (need > had) {
        entry.slingOff.setComponent(axis, need);
        entry.slingPush = Math.max(entry.slingPush, need - had);
      }
    }
  }

  setActive(id, player = null) {
    const e = this.entries.get(id);
    if (!e) return false;
    if (this.active) this.active.group.visible = false;
    this.active = e;
    e.group.visible = !this.hidden;
    this.boltHold = 0;
    this.boltCycle = 0;
    /**
     * Place it NOW rather than waiting for the next `lateUpdate`.
     *
     * A weapon that has never been placed sits at the world origin with an
     * identity transform, so `muzzleWorld()` returns the model-local muzzle —
     * and the very first shot after a swap therefore leaves from (0, 0.07,
     * -0.51) in world space, kilometres from the player, silently. Measured:
     * a Nitro Launcher fired on the switch frame spawned its round at the map
     * origin and flew 146 m through empty air without ever finding a surface.
     */
    if (player) this._place(e, this._lastState, player);
    return true;
  }

  /** Force a placement outside the frame loop (weapon swap, capture harness). */
  place(player) {
    if (this.active && player) this._place(this.active, this._lastState, player);
  }

  /**
   * Animated weapon change: the old one goes down, the model swaps at the
   * bottom, the new one comes up.
   *
   * The GAMEPLAY STATE does not wait for this — `WeaponSystem.setWeapon` moves
   * `activeId` on the same frame the key is pressed, so the HUD, the ammo count
   * and `current` are all correct instantly and only the picture lags. Tying
   * the state change to the end of a holster CLIP is what made E look like it
   * did nothing: the Dock Pipe's holster is 0.4 s, so for twenty-four frames
   * after the keypress every reader still saw the old weapon.
   */
  swapTo(id, out = 0.14, inn = 0.18) {
    if (!this.entries.has(id)) return false;
    this._swapTo = id;
    this._swapOut = Math.max(0.02, out);
    this._swapIn = Math.max(0.02, inn);
    this._swapT = 0;
    return true;
  }

  get swapping() { return this._swapTo !== null; }

  setHidden(h) {
    this.hidden = !!h;
    if (this.active) this.active.group.visible = !this.hidden;
  }

  /* ====================================================================== */
  /*  clips                                                                 */
  /* ====================================================================== */

  /** @returns duration in seconds */
  play(name) {
    const d = this.active?.def;
    if (!d) return 0;
    let dur = 0.5;
    switch (name) {
      case 'draw': dur = d.drawTime * this.handling; break;
      case 'holster': dur = d.holsterTime * this.handling; break;
      case 'reloadTac': dur = d.reloadTac * this.reloadScale; break;
      case 'reloadEmpty': dur = d.reloadEmpty * this.reloadScale; break;
      case 'inspect': dur = 1.6; break;
      default: dur = 0.5;
    }
    this.clip = { name, duration: Math.max(0.05, dur) };
    this.clipName = name;
    this.clipT = 0;
    this._clipEventIndex = 0;
    return this.clip.duration;
  }

  stopClip() {
    this.clip = null;
    this.clipName = null;
    this.clipT = 0;
  }

  _advanceClip(dt) {
    if (!this.clip) return;
    const prev = this.clipT;
    this.clipT += dt;
    const dur = this.clip.duration;
    const events = CLIP_EVENTS[this.clip.name] ?? CLIP_EVENTS.draw;
    for (let i = this._clipEventIndex; i < events.length; i++) {
      const t = events[i][0] * dur;
      if (t > this.clipT) break;
      if (t >= prev || i === 0) {
        this._clipEventIndex = i + 1;
        this.onClipEvent?.(events[i][1], this.clip.name);
      }
    }
    if (this.clipT >= dur) {
      const name = this.clip.name;
      this.clip = null;
      this.clipName = null;
      this.clipT = 0;
      if (this._clipEventIndex < events.length) this.onClipEvent?.('end', name);
    }
  }

  /* ====================================================================== */
  /*  melee                                                                 */
  /* ====================================================================== */

  /**
   * Start a swing. `spec` is the def's `swing` block; `side` alternates for
   * weapons that hook left and right. The swing is a real arc driven into the
   * ARM bones (see `_driveArm`), because a melee attack in which only the
   * wrist rotates reads as a twitch, not a hit.
   */
  startSwing(spec, side) {
    this.swingSpec = spec;
    this.swingSide = side >= 0 ? 1 : -1;
    this.swingDur = spec.wind + spec.strike + spec.recover;
    this.swingT = 0;
    return this.swingDur;
  }

  get swinging() { return this.swingT >= 0; }

  /** 0..1 through the whole swing, or -1. */
  get swingPhase() {
    return this.swingT < 0 ? -1 : clamp01(this.swingT / Math.max(1e-4, this.swingDur));
  }

  /* ====================================================================== */
  /*  recoil                                                                */
  /* ====================================================================== */

  addRecoil(pitch, yaw, first) {
    const d = this.active?.def;
    if (!d) return;
    const r = d.recoil;
    const boost = first ? 1.28 : 1;
    /* The weapon's own travel in the hand: rearward along the bore and up. */
    this.recPos.kick(
      r.kickBack * 0.35 * boost * (yaw > 0 ? 1 : -1),
      r.kickUp * 2.2 * boost,
      r.kickBack * 22 * boost
    );
    this.recRot.kick(-pitch * 26 * boost, yaw * 10 * boost, r.roll * 6 * boost * this.swingSide);
    this.triggerT = 1;
    if (d.eject === 'brass' || d.projectile === 'bullet') this.boltCycle = 1;
    if (d.pump) this.pumpT = 1;
  }

  /* ====================================================================== */
  /*  frame                                                                 */
  /* ====================================================================== */

  /**
   * @param {number} dt
   * @param {object} st  { ads, sprint, speed, trigger, empty, aimPitch }
   * @param {object} player  the player system (may be null)
   */
  update(dt, st, player) {
    const e = this.active;
    if (!e) return;
    this._lastState = st;

    if (!this.debugFrozen) {
      this._advanceClip(dt);
      this.noiseT += dt;
      if (this.swingT >= 0) {
        this.swingT += dt;
        if (this.swingT > this.swingDur) this.swingT = -1;
      }
    }

    const d = e.def;
    /* ADS follows the def's own transition time, not a global constant: a
     * harpoon comes up to the shoulder a lot slower than a nail gun. */
    const adsRate = 1 / Math.max(0.05, d.adsTime * this.handling);
    const wantAds = st.ads && !st.sprint ? 1 : 0;
    this.adsT = clamp01(this.adsT + (wantAds - this.adsT) * Math.min(1, adsRate * dt * 2.6));

    /* ---- weapon change ------------------------------------------------- */
    let swapDraw = null;
    if (this._swapTo !== null) {
      if (!this.debugFrozen) this._swapT += dt;
      if (this._swapT < this._swapOut) {
        swapDraw = 1 - this._swapT / this._swapOut;
      } else {
        if (this.active?.id !== this._swapTo) this.setActive(this._swapTo, player);
        const u = (this._swapT - this._swapOut) / this._swapIn;
        swapDraw = clamp01(u);
        if (u >= 1) { this._swapTo = null; swapDraw = 1; }
      }
    }

    /* Draw / holster blend. `drawT` 1 = in the hand, 0 = on the body. */
    let wantDraw = 1;
    if (swapDraw !== null) wantDraw = swapDraw;
    else if (this.clipName === 'holster') wantDraw = 1 - clamp01(this.clipT / this.clip.duration);
    else if (this.clipName === 'draw') wantDraw = clamp01(this.clipT / (this.clip.duration * 0.62));
    if (st.holstered) wantDraw = 0;
    /* A swap drives `drawT` directly — smoothing it would re-introduce exactly
     * the lag the swap exists to remove. */
    this.drawT = this.debugFrozen || swapDraw !== null
      ? wantDraw
      : lerp(this.drawT, wantDraw, Math.min(1, dt * 18));

    this.triggerT = Math.max(0, this.triggerT - dt * 7);
    this.boltCycle = Math.max(0, this.boltCycle - dt * (d.rpm > 400 ? 22 : 12));
    this.pumpT = Math.max(0, this.pumpT - dt * 3.4);

    if (!this.debugFrozen) {
      this.recPos.step(dt, 0, 0, 0);
      this.recRot.step(dt, 0, 0, 0);
      this.settle.step(dt, 0, 0, 0);
      this.lag.step(dt, 0, 0, 0);
    }

    this._poseParts(e, dt);
    this._place(e, st, player);
  }

  /* ---------------------------------------------------------------- parts */

  /**
   * Moving sub-assemblies. Every weapon declares only the parts it has, so a
   * missing `bolt` is not a special case anywhere — the loop just skips it.
   */
  _poseParts(e, dt) {
    const p = e.parts;
    const n = e.nodes;
    const clip = this.clipName;
    const u = this.clip ? clamp01(this.clipT / this.clip.duration) : -1;
    const reloading = clip === 'reloadTac' || clip === 'reloadEmpty';

    /* trigger: a straight pull about its seat */
    if (p.trigger && n.triggerPull !== undefined) {
      p.trigger.rotation.x = n.triggerPull * this.triggerT;
    }

    /* bolt: fires back and returns; held open on an empty magazine */
    if (p.bolt && n.boltTravel) {
      const back = Math.max(this.boltHold, Math.sin(this.boltCycle * Math.PI) * 1.0);
      p.bolt.position.set(
        n.boltTravel[0] * back, n.boltTravel[1] * back, n.boltTravel[2] * back
      );
    }

    /* magazine: out at 'magout', back in at 'magin' */
    if (p.mag && n.magDrop) {
      let m = 0;
      if (reloading && u >= 0) {
        const ev = CLIP_EVENTS[clip];
        const outT = ev[1][0], inT = ev[3][0];
        if (u < outT) m = 0;
        else if (u < inT) m = easeOutCubic(clamp01((u - outT) / (inT - outT))) ;
        else m = 1 - easeOutBack(clamp01((u - inT) / (1 - inT)), 1.1);
      }
      p.mag.position.set(n.magDrop[0] * m, n.magDrop[1] * m, n.magDrop[2] * m);
      p.mag.visible = m < 0.995;
    }

    /**
     * Break-open action — the barrel (flare gun) or the breech cap (nitro
     * launcher) swings down on a hinge to load.
     *
     * The sub-assembly's own origin is its SEAT, not the hinge, so rotating it
     * in place would swing the barrel about its middle and drive the muzzle
     * through the shooter's hand. Rotate the seat point about the hinge and
     * carry the part with it: `pos = pivot + Rx(a) * (seat - pivot)`.
     */
    const brk = p.barrel ?? p.breech;
    if (brk && n.breakAngle !== undefined) {
      let a = 0;
      if (reloading && u >= 0) a = Math.pow(Math.sin(clamp01(u) * Math.PI), 0.7);
      const ang = n.breakAngle * a;
      brk.rotation.x = ang;
      const seat = e.seat[p.barrel ? 'barrel' : 'breech'];
      const piv = n.breakPivot;
      if (piv && seat) {
        this._v.set(seat[0] - piv[0], seat[1] - piv[1], seat[2] - piv[2]);
        this._v.applyAxisAngle(X_AXIS, ang);
        brk.position.set(piv[0] + this._v.x, piv[1] + this._v.y, piv[2] + this._v.z);
      }
    }

    /* hammer: cocked as the action closes */
    if (p.hammer && n.hammerCock !== undefined) {
      const c = reloading && u >= 0 ? smoothstep(0.6, 0.95, u) : 1 - this.triggerT;
      p.hammer.rotation.x = n.hammerCock * c;
    }

    /* pump / pressure handle: one stroke per shot */
    if (p.pump && n.pumpTravel) {
      const s = Math.sin(clamp01(this.pumpT) * Math.PI);
      p.pump.position.set(n.pumpTravel[0] * s, n.pumpTravel[1] * s, n.pumpTravel[2] * s);
    }

    /* rubber bands: stretched when loaded, slack when spent */
    if (p.slings) {
      const loaded = e.loadedVisible === false ? 0 : 1;
      p.slings.scale.z = lerp(0.72, 1, loaded);
    }

    /* the loaded projectile itself: leaves the rail when fired, comes back on
     * the reload's 'magin' beat */
    const lp = e.loadedPart;
    if (lp) {
      const travel = n.spearTravel ?? n.shaftTravel ?? n.chargeTravel ?? n.roundTravel ?? null;
      const vis = e.loadedVisible !== false;
      lp.visible = vis;
      if (travel && vis) {
        const t = reloading && u >= 0 ? 1 - smoothstep(0.55, 0.9, u) : 0;
        lp.position.set(travel[0] * t, travel[1] * t, travel[2] * t);
      }
    }
  }

  /** Called by the system when a round leaves / is loaded. */
  setLoaded(v) {
    if (this.active) this.active.loadedVisible = !!v;
  }

  /* ---------------------------------------------------------------- place */

  /**
   * Compose the world transform: bone -> grip offset -> spring animation.
   * Runs in `lateUpdate`, after the animator, so the bone is final.
   */
  _place(e, st, player) {
    const hand = player?.weaponHand ?? null;
    const g = e.group;

    if (!hand) {
      /* No character (capture harness before the player spawns, or a brother
       * swap in flight). Park the weapon at the camera so `debugPose` still
       * photographs something rather than dropping it at the origin. */
      if (this._boneMiss++ < 2) return;
      const cam = this.ctx.camera;
      cam.updateMatrixWorld();
      g.position.setFromMatrixPosition(cam.matrixWorld);
      g.quaternion.setFromRotationMatrix(cam.matrixWorld);
      g.translateX(0.24); g.translateY(-0.2); g.translateZ(-0.55);
      g.quaternion.multiply(this._q.setFromEuler(this._e.set(0, 0.22, 0, 'XYZ')));
      return;
    }
    this._boneMiss = 0;

    /* ---- melee: drive the arm before we read the bone ------------------ */
    if (this.swingT >= 0) this._driveArm(e, hand);
    else if (e.def.melee) this._driveMeleeIdle(e, hand);

    hand.updateWorldMatrix(true, false);
    hand.matrixWorld.decompose(this._handPos, this._handQuat, this._s);

    /* Weapon-space animation: recoil travel, ADS cant, low-carry pitch. */
    const rec = this.recPos;
    const rot = this.recRot;
    const lowCarry = e.hold.low * (1 - this.adsT) * (e.def.melee ? 0 : 1);
    const sway = this.noise.fbm(this.noiseT * 0.55, 3) * (1 - this.adsT * 0.72);
    const sway2 = this.noise.fbm(this.noiseT * 0.41 + 91.7, 3) * (1 - this.adsT * 0.72);
    this._e.set(rot.x + lowCarry + sway * 0.03, rot.y + sway2 * 0.035, rot.z, 'XYZ');
    this._q2.setFromEuler(this._e);

    /**
     * ---------------------------------------------------------------------
     * WHY THE WEAPON IS NOT ORIENTED BY THE HAND BONE
     * ---------------------------------------------------------------------
     * `player`'s IK aims the arm with `aimBone`, which is
     * `setFromUnitVectors(restDir, target)` — the MINIMAL rotation onto the
     * target. A minimal rotation says nothing about the TWIST around the limb
     * axis, so the wrist's roll is an emergent property of wherever the elbow
     * happened to end up, and it changes as the aim moves. Bolting a weapon
     * rigidly to that frame put the Shop SMG across the character's chest at 60
     * degrees of cant with the magazine pointing at his ear, and no constant
     * offset can fix it, because the error is not constant.
     *
     * So the weapon takes its POSITION from the hand bone — that part the
     * skeleton gets right, and it is what makes the arm follow a swing — and
     * its ORIENTATION from the AIM BASIS: yaw and pitch off the camera, then a
     * per-hold cant, then the swing arc, then recoil. A gun therefore points
     * exactly where the player is looking, which is the only thing that makes
     * a third-person reticle mean anything, and a pipe sweeps an arc that is
     * authored rather than inherited.
     *
     * The one exception is `fists`, which is two turns of tape on the knuckles
     * and has to stay welded to the hand or it is not on the hand at all.
     */
    if (e.hold === HOLD.fists) {
      this._q3.copy(e.handQuat).multiply(this._q2);
      this._q.copy(this._handQuat).multiply(this._q3);
      this._v.set(e.handOff.x + rec.x, e.handOff.y + rec.y, e.handOff.z + rec.z);
      this._p.copy(this._v).applyQuaternion(this._handQuat).add(this._handPos);
    } else {
      const yaw = player.cameraYaw ?? player.yaw ?? 0;
      const pitch = -(player.pitch ?? 0);
      this._e.set(pitch, yaw, 0, 'YXZ');
      this._q.setFromEuler(this._e).multiply(e.aimQuat);
      if (this.swingT >= 0) this._q.multiply(this._swingQuat(e));
      this._q.multiply(this._q2);
      this._v.set(e.gripOff.x + rec.x, e.gripOff.y + rec.y, e.gripOff.z + rec.z);
      this._p.copy(this._v).applyQuaternion(this._q).add(this._handPos);
    }

    const sling = this.drawT > 0.999 ? null : this._slingBone(player, e.slingBone);
    if (!sling) {
      g.position.copy(this._p);
      g.quaternion.copy(this._q);
    } else {
      /* ---- holstered pose, on the body -------------------------------- */
      sling.updateWorldMatrix(true, false);
      sling.matrixWorld.decompose(this._slingPos, this._slingQuat, this._s);
      this._p2.copy(e.slingOff).applyQuaternion(this._slingQuat).add(this._slingPos);
      this._q2.copy(this._slingQuat).multiply(e.slingQuat);

      const t = smoothstep(0, 1, this.drawT);
      g.position.copy(this._p2).lerp(this._p, t);
      g.quaternion.copy(this._q2).slerp(this._q, t);
    }

    /* The weapon is final: put the LEFT hand on it. */
    this._driveSupportArm(e, player);
  }

  /* ---------------------------------------------------- support-hand IK */

  /**
   * THE OTHER HAND.
   *
   * Every model in `models/` authors a `gripL` node — the exact point on the
   * forend, the tube or the shaft where a support hand belongs — and until now
   * nothing in this system read it. `player`'s animator has one two-handed aim
   * pose, authored for a generic rifle, so a 1.15 m Scrap Rocket and a 0.28 m
   * flare gun got the same left arm and it was wrong for both. At third-person
   * distance you forgive it; standing next to a shopfront at 1.5 m you do not.
   *
   * This is a closed-form two-bone IK, written straight into `armL`/`forearmL`
   * in `lateUpdate` after the animator has run — the same contract `_driveArm`
   * uses for the swing, and safe for the same reason: the animator sets these
   * quaternions ABSOLUTELY every frame, so the override cannot accumulate and
   * cannot leak once the weapon is holstered.
   *
   *   D  = |target - shoulder|, clamped into the arm's reachable annulus
   *   a  = acos((L1^2 + D^2 - L2^2) / (2 L1 D))     shoulder opening angle
   *   the upper arm is the shoulder->target line rotated by `a` about an axis
   *   perpendicular to it and to the POLE, which is world-down: an elbow that
   *   points up is the single loudest tell of a bad arm solve.
   *
   * The bones are authored with identity rotations at bind, so a child's rest
   * direction in its parent's frame is simply `child.position` normalised —
   * which is what makes the delta rotations below exact rather than tuned.
   */
  _driveSupportArm(e, player) {
    const gr = this.gripReach;
    gr.active = false;
    gr.weight = 0;
    gr.error = 0;
    const grip = e.gripL;
    if (!grip || !e.hold.support) return;
    const bones = player?.character?.bones;
    const arm = bones?.armL;
    const fore = bones?.forearmL;
    const hand = bones?.handL;
    if (!arm || !fore || !hand || !arm.parent) return;

    /* Only once the weapon is actually in the hand. A holstered weapon has no
     * support hand, and the transition should ease rather than snap. */
    const w = smoothstep(0.55, 0.96, this.drawT);
    if (w < 0.02) return;

    const g = e.group;
    this._ikTarget.copy(grip).applyQuaternion(g.quaternion).add(g.position);

    arm.parent.updateWorldMatrix(true, false);
    arm.updateWorldMatrix(false, false);
    this._ikShoulder.setFromMatrixPosition(arm.matrixWorld);
    arm.parent.matrixWorld.decompose(this._v, this._ikQP, this._s);

    const L1 = fore.position.length();
    const L2 = hand.position.length();
    if (L1 < 1e-4 || L2 < 1e-4) return;

    this._ikDir.copy(this._ikTarget).sub(this._ikShoulder);
    let raw = this._ikDir.length();
    if (raw < 1e-4) return;

    /**
     * THE HAND SLIDES DOWN THE WEAPON RATHER THAN HANGING OFF THE END OF IT.
     *
     * Four of the sixteen author a `gripL` the left arm cannot physically
     * reach across the body — measured: Scrap Rocket 0.21 m short, Nitro
     * Launcher 0.19, Harpoon 0.14, Spear Gun 0.14. Simply clamping the solve
     * leaves the arm at full stretch with a visible gap between the palm and
     * the tube, which is the exact defect this work exists to remove.
     *
     * A real shooter slides his support hand BACK along the forend until he
     * can hold it, so the target slides along the segment from `gripL` to the
     * weapon's own origin — a line that runs down the middle of the weapon —
     * to the first point inside the arm's reach. Closed form: with A = T - S
     * and B = O - T, solve |A + tB|^2 = maxD^2 for the smaller positive root.
     */
    const maxD = (L1 + L2) * 0.97;
    if (raw > maxD) {
      this._ikSlide.copy(g.position).sub(this._ikTarget);
      const aa = this._ikSlide.lengthSq();
      if (aa > 1e-8) {
        const bb = 2 * this._ikDir.dot(this._ikSlide);
        const cc = raw * raw - maxD * maxD;
        const disc = bb * bb - 4 * aa * cc;
        if (disc >= 0) {
          const s = Math.sqrt(disc);
          let t = (-bb - s) / (2 * aa);
          if (t < 0) t = (-bb + s) / (2 * aa);
          t = clamp(t, 0, 1);
          this._ikTarget.addScaledVector(this._ikSlide, t);
          this._ikDir.copy(this._ikTarget).sub(this._ikShoulder);
          raw = this._ikDir.length();
          if (raw < 1e-4) return;
        }
      }
    }
    this._ikDir.divideScalar(raw);
    /* Still out of reach (the whole weapon is): the arm points at it, which is
     * what an arm does. Clamping into the annulus is what keeps `acos` real. */
    const D = clamp(raw, Math.abs(L1 - L2) + 0.02, (L1 + L2) * 0.995);
    const a = Math.acos(clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1));

    /* Elbow down and slightly outboard. Straight down degenerates when the arm
     * is pointing at the sky, so fall back to the character's own right. */
    this._ikPole.set(0, -1, 0);
    if (Math.abs(this._ikDir.y) > 0.94) {
      this._ikPole.set(1, 0, 0).applyQuaternion(this._ikQP);
    }
    this._ikAxis.crossVectors(this._ikDir, this._ikPole);
    if (this._ikAxis.lengthSq() < 1e-8) this._ikAxis.set(1, 0, 0);
    this._ikAxis.normalize();
    this._ikUpper.copy(this._ikDir).applyAxisAngle(this._ikAxis, a);

    /* upper arm: rotate the bone's rest direction onto `_ikUpper` */
    this._ikRest.copy(fore.position).divideScalar(L1).applyQuaternion(this._ikQP);
    this._ikQD.setFromUnitVectors(this._ikRest, this._ikUpper);
    this._ikQ1.copy(this._ikQD).multiply(this._ikQP);          // arm, world
    this._ikLocal.copy(this._ikQP).invert().multiply(this._ikQ1);
    arm.quaternion.slerp(this._ikLocal, w);

    /* forearm: from the elbow the solve produced, onto the grip */
    this._ikElbow.copy(this._ikShoulder).addScaledVector(this._ikUpper, L1);
    this._ikLower.copy(this._ikTarget).sub(this._ikElbow);
    if (this._ikLower.lengthSq() > 1e-8) {
      this._ikLower.normalize();
      this._ikRest.copy(hand.position).divideScalar(L2).applyQuaternion(this._ikQ1);
      this._ikQD.setFromUnitVectors(this._ikRest, this._ikLower);
      this._ikQ2.copy(this._ikQD).multiply(this._ikQ1);        // forearm, world
      this._ikLocal.copy(this._ikQ1).invert().multiply(this._ikQ2);
      fore.quaternion.slerp(this._ikLocal, w);
    }
    arm.updateWorldMatrix(false, true);

    gr.active = true;
    gr.weight = w;
    /* How far the hand ended up from the grip it was aiming at — the number the
     * pose harness asserts on. Non-zero only when the weapon is out of reach. */
    hand.updateWorldMatrix(false, false);
    this._v.setFromMatrixPosition(hand.matrixWorld);
    gr.error = this._v.distanceTo(this._ikTarget);
  }

  /**
   * The weapon's own rotation through the swing, in WEAPON space, on top of
   * the hold's resting cant.
   *
   * The arc is what the eye actually tracks: a metre of pipe sweeping 140
   * degrees in 140 ms. The wind-up rolls the head back over the shoulder, the
   * strike drives it forward and across on an ease that is fastest at the
   * CONTACT frame (which is where `melee.js` runs its sweep), and the recovery
   * lets it settle. `overhead` trades the horizontal sweep for a vertical chop
   * — the Body Wrench has all its mass in the head and swings like an axe.
   */
  _swingQuat(e) {
    const s = this._swingS();
    const side = this.swingSide;
    const over = this.swingSpec.overhead ?? 0;
    /* Positive pitch lifts the head (the business end is -Z), so the wind-up
     * is POSITIVE and the strike drives through to negative. */
    const b = s < 0 ? -s : Math.min(s, 1.25);
    const pick = (wind, hit) => (s < 0 ? lerp(0, wind, b) : lerp(0, hit, b));
    this._e.set(
      pick(0.90 + over * 0.55, -1.00 - over * 0.85),
      pick(side * 1.10 * (1 - over), -side * 1.00 * (1 - over)),
      pick(side * 0.40, -side * 0.50),
      'XYZ'
    );
    return this._q3.setFromEuler(this._e);
  }

  _slingBone(player, name) {
    const bones = player?.character?.bones;
    if (!bones) return null;
    return bones[name] ?? bones.chest ?? null;
  }

  /* ---------------------------------------------------------------- arms */

  /**
   * THE SWING.
   *
   * `player`'s animator has exactly two upper-body poses: an FK arm swing for
   * locomotion and a two-handed IK aim. Neither is a strike, and `weapons` may
   * not add one to `src/player/`. So the rig writes the shoulder and elbow
   * directly, in `lateUpdate`, AFTER the animator has run — the animator sets
   * these quaternions absolutely every frame, so the override is naturally
   * per-frame and cannot accumulate or leak once the swing ends.
   *
   * The arc is authored in the shoulder because that is where the reach is:
   * a 0.6 m crowbar on a 0.63 m arm sweeps 1.2 m of street, and it is the
   * ACCELERATION through the contact frame that sells the weight.
   */
  /**
   * THE ARC PARAMETER.
   *
   * One scalar drives both the arm and the weapon, so they cannot disagree:
   *
   *    s = 0     at rest
   *    s = -1    fully wound, weight on the back foot
   *    s = +1    THE CONTACT FRAME — `melee.js` runs its sweep here
   *    s = +1.25 the end of the follow-through
   *
   * The reason this is a named quantity rather than three per-phase lerps is
   * that `swing.contact` is 0.44-0.50 of the WHOLE arc while the wind-up alone
   * is already 0.33-0.39 of it, so contact lands about a third of the way into
   * the strike phase, not at the end of it. Interpolating the strike linearly
   * (or on any symmetric ease) therefore leaves the shoulder barely off its
   * wind-up at the moment the damage lands: measured, the arm quaternion at
   * contact was 0.25 rad from bind, and a still of the Dock Pipe's "swing"
   * read as a man standing still holding a pipe. Anchoring s = 1 to the
   * contact TIME makes the peak of the arc and the moment of damage the same
   * instant by construction.
   */
  _swingS() {
    const spec = this.swingSpec;
    const t = this.swingT;
    const total = spec.wind + spec.strike + spec.recover;
    const tc = Math.max(spec.wind + 1e-3, spec.contact * total);
    if (t < spec.wind) return -smoothstep(0, 1, t / Math.max(1e-4, spec.wind));
    if (t < tc) {
      /* Accelerating: fastest right at contact. */
      return lerp(-1, 1, Math.pow((t - spec.wind) / (tc - spec.wind), 0.72));
    }
    const strikeEnd = spec.wind + spec.strike;
    if (t < strikeEnd) return lerp(1, 1.25, clamp01((t - tc) / Math.max(1e-4, strikeEnd - tc)));
    return lerp(1.25, 0, smoothstep(0, 1, (t - strikeEnd) / Math.max(1e-4, spec.recover)));
  }

  _driveArm(e, hand) {
    const fore = hand.parent;
    const arm = fore?.parent;
    if (!arm) return;
    const s = this._swingS();
    const side = this.swingSide;
    const over = this.swingSpec.overhead ?? 0;

    /* Shoulder euler in the bind frame: +x raises the arm FORWARD (the chain
     * hangs down -Y, so Rx swings it into -Z), y takes it across the body,
     * z pushes it out from the ribs. */
    const b = s < 0 ? -s : Math.min(s, 1.25);
    const pick = (rest, wind, hit) => (s < 0 ? lerp(rest, wind, b) : lerp(rest, hit, b));
    const ax = pick(-0.55, -1.35 - over * 0.55, 1.15 + over * 0.35);
    const ay = pick(0.20, side * 1.00 * (1 - over * 0.5), -side * 0.95 * (1 - over * 0.5));
    const az = pick(0.34, 0.66 + over * 0.2, -0.22);
    const fx = pick(1.25, 2.00, 0.25);

    this._armEuler.set(ax, ay, az, 'XYZ');
    arm.quaternion.setFromEuler(this._armEuler);
    this._armEuler.set(fx, 0, 0, 'XYZ');
    fore.quaternion.setFromEuler(this._armEuler);
    arm.updateWorldMatrix(false, true);
  }

  /**
   * A melee weapon that is drawn but not swinging still has to be HELD, and
   * the animator's idle arm swing puts the hand at the hip with the pipe
   * pointing at the pavement. Raise the shoulder into a ready carry.
   */
  _driveMeleeIdle(e, hand) {
    const fore = hand.parent;
    const arm = fore?.parent;
    if (!arm || this.drawT < 0.5) return;
    const w = (this.drawT - 0.5) * 2;
    /* Shoulder up and out, elbow closed to about 90 degrees: the tool sits at
     * chest height where the swing starts, not swinging off a slack arm. */
    this._armEuler.set(-0.78, 0.26, 0.46, 'XYZ');
    this._q.setFromEuler(this._armEuler);
    arm.quaternion.slerp(this._q, w);
    this._armEuler.set(1.55, 0, 0, 'XYZ');
    this._q.setFromEuler(this._armEuler);
    fore.quaternion.slerp(this._q, w);
    arm.updateWorldMatrix(false, true);
  }

  /* ====================================================================== */
  /*  transforms other subsystems read                                      */
  /* ====================================================================== */

  muzzleWorld(out) {
    const e = this.active;
    if (!e) return out.set(0, 0, 0);
    e.group.updateMatrixWorld(true);
    return out.setFromMatrixPosition(e.muzzle.matrixWorld);
  }

  /** Unit bore axis in world space (model -Z). */
  boreDir(out) {
    const e = this.active;
    if (!e) return out.set(0, 0, -1);
    e.group.updateMatrixWorld(true);
    out.set(0, 0, -1).applyQuaternion(e.group.getWorldQuaternion(this._q2)).normalize();
    return out;
  }

  /** The melee contact segment in world space. */
  edgeWorld(a, b) {
    const e = this.active;
    if (!e) return false;
    const seg = e.nodes.edge;
    if (!seg) return false;
    e.group.updateMatrixWorld(true);
    a.fromArray(seg[0]).applyMatrix4(e.group.matrixWorld);
    b.fromArray(seg[1]).applyMatrix4(e.group.matrixWorld);
    return true;
  }

  ejectWorld(out) {
    const e = this.active;
    if (!e) return out.set(0, 0, 0);
    e.group.updateMatrixWorld(true);
    return out.setFromMatrixPosition(e.eject.matrixWorld);
  }

  ejectVelocity(out, speed) {
    const e = this.active;
    if (!e) return out.set(0, 1, 0);
    out.copy(e.ejectDir).applyQuaternion(e.group.getWorldQuaternion(this._q2));
    return out.multiplyScalar(speed);
  }

  /* ====================================================================== */

  dispose() {
    for (const e of this.entries.values()) disposeInstance(e.inst);
    this.entries.clear();
    this.root.removeFromParent();
    this.active = null;
  }
}

const X_AXIS = new THREE.Vector3(1, 0, 0);

/** `gripL` is authored as `[x,y,z]` in most models and `{pos,rot}` in a few. */
function gripVector(g) {
  if (!g) return null;
  if (Array.isArray(g)) return new THREE.Vector3().fromArray(g);
  if (Array.isArray(g.pos)) return new THREE.Vector3().fromArray(g.pos);
  return null;
}

export { HOLD, SLING };
