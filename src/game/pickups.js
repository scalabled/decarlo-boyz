/**
 * GAME — pickups.
 *
 * Hidden packages, mission crates, and the scattered consumable economy —
 * cash, health, armour, ammo and nitro.
 * All of them are the same thing: a small object that sits in the world, turns
 * on the spot, glows enough to be seen from a moving car, and fires a callback
 * when the player gets close. `freeroam` keeps the consumable field stocked
 * and applies the per-kind effects; this pool only owns the bodies.
 *
 * One shared geometry and one material per kind for the whole pool, so a
 * `collect` chapter with six crates plus twelve packages plus the ambient
 * field is still a handful of draw calls. Preallocated to `POOL`; `update()`
 * allocates nothing.
 */

import * as THREE from 'three';
import { R } from './data.js';

/**
 * 12 hidden packages + up to 6 mission crates + the ~14-strong ambient
 * consumable field + kill drops, all live at once, with headroom.
 */
const POOL = 64;

/**
 * Consumable colours are picked to read at speed: cash green, health red,
 * armour blue, ammo amber-orange, nitro cyan. `package` keeps its established
 * gold; `ammo` stays orange rather than gold so it can never be mistaken for a
 * package.
 */
const KINDS = {
  package: { color: 0xffc93c, emissive: 0xffb02e, size: 0.42, spin: 1.1, bob: 0.16, radius: R.package },
  crate: { color: 0xd9a441, emissive: 0x8a5a12, size: 0.55, spin: 0.7, bob: 0.1, radius: R.crate },
  cash: { color: 0x37e07a, emissive: 0x0f9a4a, size: 0.34, spin: 1.5, bob: 0.14, radius: 4 },
  health: { color: 0xff4d5e, emissive: 0xa01830, size: 0.36, spin: 1.4, bob: 0.14, radius: 4 },
  armor: { color: 0x3aa0ff, emissive: 0x1858c0, size: 0.36, spin: 1.4, bob: 0.14, radius: 4 },
  ammo: { color: 0xff8a2b, emissive: 0xa04a08, size: 0.36, spin: 1.4, bob: 0.14, radius: 4 },
  nitro: { color: 0x22e0ff, emissive: 0x0890b0, size: 0.34, spin: 1.6, bob: 0.14, radius: 4 },
};

class Pickup {
  constructor(i) {
    this.i = i;
    this.active = false;
    this.taken = false;
    this.kind = 'crate';
    this.id = null;
    this.value = 0;
    this.mission = false;
    /** Part of the scattered consumable field `freeroam` keeps stocked. */
    this.ambient = false;
    /** Seconds until self-despawn; 0 = forever. Kill drops use it so an
     *  uncollected wad does not hold a pool slot for the rest of the session. */
    this.ttl = 0;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.t = 0;
    this.radius = 5;
    this.mesh = null;
  }
}

export class PickupPool {
  constructor(ctx, wq) {
    this.ctx = ctx;
    this.wq = wq;
    this.rng = ctx.rng.fork();
    this.list = [];
    this.live = [];
    this.group = null;
    this.geom = null;
    this.mats = new Map();
    /** `(pickup) => void`, fired once when the player walks/drives into it. */
    this.onCollect = null;
    /**
     * Second collect hook, fired after `onCollect`. `game/index.js` owns
     * `onCollect` (packages, mission crates, health); `freeroam` owns this one
     * for the ambient consumables (cash, armour, ammo, nitro) — two owners,
     * two slots, no wrapping.
     */
    this.onConsume = null;
    this._v = new THREE.Vector3();
    /** `pickup:collect { kind, value, x, z }` — reused, never allocated. */
    this._collectPayload = { kind: '', value: 0, x: 0, z: 0 };
  }

  init() {
    this.group = new THREE.Group();
    this.group.name = 'game:pickups';
    this.group.matrixAutoUpdate = false;
    this.ctx.scene.add(this.group);

    // An octahedron reads as "collectible" from any angle and at any distance,
    // and its silhouette is not something the city already contains.
    this.geom = new THREE.OctahedronGeometry(1, 0);
    this.geom.name = 'game_pickup';

    for (const [k, d] of Object.entries(KINDS)) {
      this.mats.set(k, new THREE.MeshStandardMaterial({
        name: `game_pickup_${k}`,
        color: d.color,
        emissive: d.emissive,
        emissiveIntensity: 1.6,
        roughness: 0.42,
        metalness: 0.15,
      }));
    }

    for (let i = 0; i < POOL; i++) {
      const p = new Pickup(i);
      const mesh = new THREE.Mesh(this.geom, this.mats.get('crate'));
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      // A collectible that casts a shadow reads as world geometry, and these
      // hover — the shadow would sit under nothing.
      mesh.userData.owNoShadow = true;
      p.mesh = mesh;
      this.group.add(mesh);
      this.list.push(p);
    }

    // Same call `vehicles` makes after building a car: let `render` inject its
    // shadow/AO/SSR chunks rather than waiting for the first frame to notice.
    this.ctx.peek('render')?.patchMaterials?.(this.group);
    return this;
  }

  async prewarmMaterials(ctx = this.ctx) {
    const r = ctx.peek('render')?.renderer;
    if (!r) return;
    const s = new THREE.Scene();
    for (const m of this.mats.values()) s.add(new THREE.Mesh(this.geom, m));
    await r.compileAsync?.(s, ctx.camera);
  }

  _free() {
    for (const p of this.list) if (!p.active) return p;
    return null;
  }

  /**
   * @param {number} x @param {number} z
   * @param {'package'|'crate'|'cash'|'health'|'armor'|'ammo'|'nitro'} kind
   * @param {object} [opts] `{ id, value, mission, ambient, ttl, y }`
   */
  spawn(x, z, kind = 'crate', opts = EMPTY) {
    const p = this._free();
    if (!p) return null;
    const d = KINDS[kind] ?? KINDS.crate;
    p.active = true;
    p.taken = false;
    p.kind = kind;
    p.id = opts.id ?? null;
    p.value = opts.value ?? 0;
    p.mission = !!opts.mission;
    p.ambient = !!opts.ambient;
    p.ttl = opts.ttl ?? 0;
    p.x = x;
    p.z = z;
    p.y = opts.y ?? this.wq.groundY(x, z) + 1.15;
    p.radius = d.radius;
    p.t = this.rng.float() * 6;
    p.mesh.material = this.mats.get(kind) ?? this.mats.get('crate');
    p.mesh.scale.setScalar(d.size);
    p.mesh.visible = true;
    this.live.push(p);
    return p;
  }

  despawn(p) {
    if (!p?.active) return;
    p.active = false;
    p.mesh.visible = false;
    const i = this.live.indexOf(p);
    if (i >= 0) this.live.splice(i, 1);
  }

  /** Drop every mission-owned pickup, leaving the hidden packages alone. */
  clearMission() {
    for (let i = this.live.length - 1; i >= 0; i--) {
      if (this.live[i].mission) this.despawn(this.live[i]);
    }
  }

  clear() {
    for (let i = this.live.length - 1; i >= 0; i--) this.despawn(this.live[i]);
  }

  has(id) {
    for (const p of this.live) if (p.id === id) return true;
    return false;
  }

  countMission() {
    let n = 0;
    for (const p of this.live) if (p.mission && !p.taken) n++;
    return n;
  }

  /** How many of the ambient consumable field are standing right now. */
  countAmbient() {
    let n = 0;
    for (const p of this.live) if (p.ambient && !p.taken) n++;
    return n;
  }

  /** Nearest live mission pickup to a point — drives the objective marker. */
  nearestMission(x, z) {
    let best = null;
    let bd = Infinity;
    for (const p of this.live) {
      if (!p.mission || p.taken) continue;
      const dx = p.x - x;
      const dz = p.z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /**
   * @param {number} reach multiplier on every collect radius. `game` passes
   *   >1 while the player is driving: the radius grows from 2.2 m on foot to
   *   3.5 m in a vehicle so that you can sweep a pickup up at speed instead of
   *   having to stop, get out and walk to it.
   */
  update(dt, px, py, pz, reach = 1) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      const d = KINDS[p.kind] ?? KINDS.crate;
      p.t += dt;
      if (p.ttl > 0 && (p.ttl -= dt) <= 0) { this.despawn(p); continue; }
      const m = p.mesh;
      m.position.set(p.x, p.y + Math.sin(p.t * 1.9) * d.bob, p.z);
      m.rotation.set(0.42, p.t * d.spin, 0.24);
      m.updateMatrix();

      const dx = p.x - px;
      const dz = p.z - pz;
      const dy = p.y - py;
      const r = p.radius * reach;
      if (dx * dx + dz * dz > r * r) continue;
      if (Math.abs(dy) > 6) continue;
      p.taken = true;
      this.wq.sfx('shell', this._v.set(p.x, p.y, p.z), { gain: 0.8 });
      // One event per collect, keyed by kind, so `audio` can voice cash and
      // nitro differently without this module ever touching a synth.
      const e = this._collectPayload;
      e.kind = p.kind;
      e.value = p.value;
      e.x = p.x;
      e.z = p.z;
      this.ctx.events.emit('pickup:collect', e);
      this.onCollect?.(p);
      this.onConsume?.(p);
      this.despawn(p);
    }
  }

  dispose() {
    this.group?.parent?.remove(this.group);
    this.geom?.dispose();
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
    this.list.length = 0;
    this.live.length = 0;
  }
}

const EMPTY = Object.freeze({});
