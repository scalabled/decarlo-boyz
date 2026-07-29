/**
 * CharacterRig — the visible player: one SkinnedMesh, eight materials, a bone
 * map the animator drives and the weapons system can attach to.
 *
 * All eight materials share the same feature set (map + normalMap +
 * roughnessMap, no vertex colours, no alpha) so three compiles ONE program for
 * the whole character instead of eight, and the CSM/prepass overrides pick up
 * the skinned variant automatically.
 */

import * as THREE from 'three';
import { buildCharacter, MAT } from './mesh.js';
import { buildTextures, disposeTextures } from './textures.js';

const MAT_ORDER = ['skin', 'face', 'shirt', 'pants', 'leather', 'sole', 'hair', 'eye'];

export class CharacterRig {
  constructor(ctx) {
    this.ctx = ctx;
    this.spec = null;
    this.root = null;
    this.mesh = null;
    this.skeleton = null;
    this.bones = null;
    this.materials = null;
    this.textures = null;
    this.scale = 1;
    /** Which shoulder the camera is over; the aim pose mirrors with it. */
    this.side = 1;
    this.visible = true;
    this._opacity = 1;
    this._parent = null;
  }

  /** Build (or rebuild) the body for one brother. */
  setBrother(spec, parent) {
    const same = this.spec?.id === spec.id;
    if (same && this.root) return this.root;
    const keep = this._parent ?? parent;
    this.dispose();
    this.spec = spec;
    this._parent = keep;

    const q = this.ctx.config.q;
    this.textures = buildTextures(spec.palette, {
      anisotropy: Math.min(8, q?.anisotropy ?? 8),
      seed: 0x51ee5 + spec.id.charCodeAt(0) * 977,
      stubble: spec.build.stubble ?? 0.3,
      size: 256,
    });

    this.materials = MAT_ORDER.map((name) => this._material(name));
    const built = buildCharacter(spec.build, this.materials);
    this.root = built.root;
    this.mesh = built.mesh;
    this.skeleton = built.skeleton;
    this.bones = built.bones;
    this.boneList = built.boneList;
    this.geometry = built.geometry;
    this.bindPositions = built.bindPositions;
    this.scale = spec.build.scale ?? 1;

    this.root.name = `player:${spec.id}`;
    if (keep) keep.add(this.root);
    this.root.visible = this.visible;
    return this.root;
  }

  _material(name) {
    const t = this.textures;
    const set = {
      skin: t.skin, face: t.face, shirt: t.shirt, pants: t.pants,
      leather: t.leather, sole: t.leather, hair: t.hair, eye: t.eye,
    }[name];

    const m = new THREE.MeshStandardMaterial({
      name: `player:${name}`,
      map: set.map,
      // The eye has no relief of its own; it borrows the skin normal at zero
      // strength purely so the shader permutation matches every other material.
      normalMap: set.normalMap ?? t.skin.normalMap,
      roughnessMap: set.roughnessMap ?? t.skin.roughnessMap,
      metalness: 0,
      roughness: 1,
      envMapIntensity: 1,
    });

    switch (name) {
      case 'skin':
      case 'face':
        m.normalScale.set(0.28, 0.28);
        // Skin is never fully rough and never a mirror; the map does the rest.
        m.roughness = 0.92;
        break;
      case 'shirt':
        m.normalScale.set(0.85, 0.85);
        break;
      case 'pants':
        m.normalScale.set(0.9, 0.9);
        break;
      case 'leather':
        m.normalScale.set(0.7, 0.7);
        break;
      case 'sole':
        m.normalScale.set(0.8, 0.8);
        m.color.setScalar(0.5); // rubber is darker than the boot upper
        m.roughness = 1.15;
        break;
      case 'hair':
        m.normalScale.set(1.0, 1.0);
        m.roughness = 0.8;
        break;
      case 'eye':
        m.normalScale.set(0, 0);
        m.roughness = 0.16;
        m.metalness = 0;
        break;
      default:
        break;
    }
    return m;
  }

  /**
   * Character visibility. The camera fades him out when it is forced inside
   * him (tight alleys, a wall behind the player) instead of clipping through
   * the skull, which is what GTA does and what the shot harness needs when it
   * parks the camera on top of the capsule.
   */
  setOpacity(a) {
    const v = a > 0.995;
    if (a <= 0.004) {
      if (this.root) this.root.visible = false;
      this._opacity = 0;
      return;
    }
    if (this.root) this.root.visible = this.visible;
    if (v !== (this._opacity > 0.995) || Math.abs(a - this._opacity) > 0.004) {
      for (const m of this.materials ?? []) {
        m.transparent = !v;
        m.opacity = a;
        m.depthWrite = v;
      }
    }
    this._opacity = a;
  }

  setVisible(v) {
    this.visible = !!v;
    if (this.root) this.root.visible = this.visible && this._opacity > 0.004;
  }

  /** Bone the weapons system should parent a third-person weapon to. */
  get weaponHand() {
    return this.bones?.handR ?? null;
  }

  dispose() {
    if (this.root?.parent) this.root.parent.remove(this.root);
    this.geometry?.dispose();
    for (const m of this.materials ?? []) m.dispose();
    disposeTextures(this.textures);
    this.skeleton?.dispose?.();
    this.root = null;
    this.mesh = null;
    this.materials = null;
    this.textures = null;
    this.bones = null;
    this.geometry = null;
  }
}

export { MAT };
