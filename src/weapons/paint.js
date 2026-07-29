import * as THREE from 'three';

/**
 * PAINT — what `marks: true` on the Paint Cannon actually does.
 *
 * ---------------------------------------------------------------------------
 * THE FLAG WAS DECORATION
 * ---------------------------------------------------------------------------
 * `lib.js` has said "Paint blinds: a hit smears the target's view and marks
 * them for the FX" since the arsenal landed, and nothing read the flag. Seven
 * gobs of pressurised enamel hit a man and produced a puff of concrete dust,
 * which is the wrong material, the wrong colour and — worse — the wrong
 * mechanic: a shotgun that does 105 damage inside six metres is just a
 * shotgun. What makes the Paint Cannon the signature improvised weapon is that
 * it takes the fight OUT of somebody rather than taking them out of it.
 *
 * So a marking hit does two things, and both are visible from the pavement:
 *
 * 1. IT BLINDS. A painted actor scatters — `peds.panic` at close range and
 *    high severity is exactly "he cannot see, he is not fighting you any more"
 *    expressed in the vocabulary the crowd already speaks. The state is also
 *    held HERE, queryable as `weapons.isBlinded(actor)`, so `police` and `peds`
 *    can read it when they want it without this system reaching into theirs.
 *
 * 2. IT MARKS. A splat of enamel lands where the gob hit — on the wall, on the
 *    pavement, or ON THE MAN, following him for as long as it lasts. That is
 *    the point of a paint gun in a game: you can pick your target out of a
 *    crowd afterwards because you put a teal handprint on his back.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `fx.addDecal`
 * ---------------------------------------------------------------------------
 * `fx`'s decal system projects one of twenty BAKED tiles onto the physics BVH
 * and takes no colour: every tile is authored grey, brown or blood-red, and
 * there is no paint in the atlas. A grey smudge is not what a Paint Cannon
 * leaves. These are real (tiny) meshes off a ring buffer instead — which is
 * also the only way to get one to follow a running pedestrian, since a
 * projected decal is welded to static geometry by construction.
 */

/** Splats alive at once. Seven pellets a shot, so this is ~3 shots of history. */
const SLOTS = 24;
/** Seconds a splat stays before it fades. */
const LIFE = 30;
/** Seconds a painted actor stays blinded. */
const BLIND = 5.5;

/**
 * One irregular splat, in the XY plane facing +Z: a lobed central mass plus
 * three satellite droplets. Deterministic by construction (no rng at all) —
 * the variety comes from per-placement roll and scale.
 */
function splatGeometry(seed = 0) {
  const pos = [];
  const idx = [];
  const uv = [];
  const lobe = (cx, cy, r, wob, phase, segs) => {
    const base = pos.length / 3;
    pos.push(cx, cy, 0);
    uv.push(0.5, 0.5);
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      /* Two harmonics of wobble so the rim is a splash, not a gear. */
      const rr = r * (1 + wob * (Math.sin(a * 3 + phase) * 0.6 + Math.sin(a * 5 + phase * 2.3) * 0.4));
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      pos.push(x, y, 0);
      uv.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
    }
    for (let i = 0; i < segs; i++) {
      idx.push(base, base + 1 + i, base + 1 + ((i + 1) % segs));
    }
  };
  const p = seed * 1.7;
  lobe(0, 0, 0.5, 0.26, p, 18);
  lobe(0.52, 0.30, 0.16, 0.34, p + 1.1, 9);
  lobe(-0.44, 0.42, 0.11, 0.34, p + 2.7, 8);
  lobe(0.18, -0.58, 0.13, 0.34, p + 4.2, 8);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export class PaintField {
  constructor(ctx, mats) {
    this.ctx = ctx;
    this.root = new THREE.Object3D();
    this.root.name = 'weapon-paint';
    ctx.scene.add(this.root);

    this.geoms = [splatGeometry(0), splatGeometry(1), splatGeometry(2)];
    /**
     * Cloned off the shared library material so a polygon offset can keep a
     * 2 mm-thick splat out of a z-fight with the wall it is on, without giving
     * the flying gobs (same material) an offset they do not want. A clone
     * shares the textures and compiles to the same program.
     */
    this.mats = [];
    for (const key of ['imp_paint_teal', 'imp_paint_blue']) {
      const src = mats?.get?.(key);
      const m = src ? src.clone() : new THREE.MeshStandardMaterial({ color: 0x1d8f92, roughness: 0.55 });
      m.polygonOffset = true;
      m.polygonOffsetFactor = -3;
      m.polygonOffsetUnits = -3;
      m.side = THREE.DoubleSide;
      this.mats.push(m);
    }

    this.slots = [];
    for (let i = 0; i < SLOTS; i++) {
      const mesh = new THREE.Mesh(this.geoms[i % this.geoms.length], this.mats[i % this.mats.length]);
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      mesh.userData.owNoShadow = true;
      mesh.userData.owNoPrepass = true;
      this.root.add(mesh);
      this.slots.push({
        mesh, until: -1, size: 0.2,
        /** Non-null when the splat is riding a pedestrian. */
        actor: null,
        offset: new THREE.Vector3(),
        normal: new THREE.Vector3(0, 0, 1),
      });
    }
    this.cursor = 0;

    /** actor -> world-time at which the blindness lifts. */
    this.blind = new Map();

    this._q = new THREE.Quaternion();
    this._n = new THREE.Vector3();
    this._z = new THREE.Vector3(0, 0, 1);
    this._p = new THREE.Vector3();
    this.stats = { splats: 0, blinded: 0 };
  }

  /** Is this actor currently painted over the eyes? Public, for `police`/`peds`. */
  isBlinded(actor) {
    const t = this.blind.get(actor);
    return t !== undefined && t > this.ctx.time.elapsed;
  }

  /**
   * A gob of enamel arrived.
   *
   * @param {object} hit  the physics hit record (point, normal, actor)
   * @param {THREE.Vector3} incident  the gob's direction of travel
   * @param {number} size  splat diameter in metres
   */
  splat(hit, incident, size = 0.34) {
    if (!hit?.point) return null;
    const now = this.ctx.time.elapsed;
    const actor = hit.actor ?? null;

    /* ---- blind ---------------------------------------------------------- */
    if (actor) {
      this.blind.set(actor, now + BLIND);
      this.stats.blinded++;
      /* Close and hard: this is the man who just took a face full of enamel,
       * not a street reacting to a bang. */
      this._p.copy(hit.point);
      this.ctx.peek('peds')?.panic?.(this._p, 3.2, 1.7);
    }

    /* ---- mark ----------------------------------------------------------- */
    let slot = null;
    for (const s of this.slots) if (s.until < 0) { slot = s; break; }
    if (!slot) {
      slot = this.slots[this.cursor];
      this.cursor = (this.cursor + 1) % this.slots.length;
    }
    slot.until = now + LIFE;
    slot.size = size;
    slot.actor = actor;
    /* Face the way the gob came from; on an actor there is no usable surface
     * normal, so use the flight path instead. */
    this._n.copy(actor && incident ? incident : (hit.normal ?? this._z));
    if (actor && incident) this._n.multiplyScalar(-1);
    if (this._n.lengthSq() < 1e-8) this._n.copy(this._z);
    this._n.normalize();
    slot.normal.copy(this._n);
    this._q.setFromUnitVectors(this._z, this._n);
    slot.mesh.quaternion.copy(this._q);
    /* A deterministic roll off the impact position: the same shot replays to
     * the same picture (rule 4), and no two splats land square. */
    slot.mesh.rotateZ((Math.abs(hit.point.x * 37.1 + hit.point.z * 17.7) % 1) * Math.PI * 2);
    slot.mesh.scale.setScalar(size);

    if (actor) {
      /* Ride the body. Store where it hit RELATIVE to him so a running man
       * carries the mark on the same shoulder. */
      slot.offset.set(
        hit.point.x - (actor.position?.x ?? hit.point.x),
        hit.point.y - (actor.position?.y ?? hit.point.y),
        hit.point.z - (actor.position?.z ?? hit.point.z)
      );
      slot.mesh.position.copy(hit.point).addScaledVector(this._n, 0.02);
    } else {
      slot.mesh.position.copy(hit.point).addScaledVector(this._n, 0.012);
    }
    slot.mesh.visible = true;
    this.stats.splats++;
    return slot;
  }

  /** Follow the bodies, retire the old ones. Called from `weapons.lateUpdate`. */
  update() {
    const now = this.ctx.time.elapsed;
    for (const s of this.slots) {
      if (s.until < 0) continue;
      if (now > s.until) {
        s.until = -1;
        s.actor = null;
        s.mesh.visible = false;
        continue;
      }
      if (s.actor) {
        const p = s.actor.position;
        /* A body that despawned or died into a ragdoll takes its paint with
         * it: there is nothing sensible to attach to any more. */
        if (!p || s.actor.active === false) {
          s.until = -1;
          s.actor = null;
          s.mesh.visible = false;
          continue;
        }
        s.mesh.position.set(
          p.x + s.offset.x + s.normal.x * 0.02,
          p.y + s.offset.y + s.normal.y * 0.02,
          p.z + s.offset.z + s.normal.z * 0.02
        );
      }
      /* The last two seconds shrink away rather than blinking out. */
      const left = s.until - now;
      if (left < 2) s.mesh.scale.setScalar(s.size * Math.max(0.04, left / 2));
    }
    /* Blind entries are few and short; sweep only when there is something. */
    if (this.blind.size) {
      for (const [actor, t] of this.blind) if (t <= now) this.blind.delete(actor);
    }
  }

  clear() {
    for (const s of this.slots) {
      s.until = -1;
      s.actor = null;
      s.mesh.visible = false;
    }
    this.blind.clear();
  }

  dispose() {
    this.clear();
    for (const g of this.geoms) g.dispose();
    for (const m of this.mats) m.dispose();
    this.geoms.length = 0;
    this.mats.length = 0;
    this.root.removeFromParent();
  }
}

export { BLIND as PAINT_BLIND_SECONDS, LIFE as PAINT_LIFE };
