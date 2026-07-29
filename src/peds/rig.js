/**
 * PEDS — the pedestrian skeleton.
 *
 * 25 bones, authored in metres in the actor's bind space: feet on y = 0, the
 * character facing +Z. Y is up and Z is forward in a right-handed frame, so the
 * character's own **right** side is at negative X — every `*R` bone lives at
 * x < 0.
 *
 * Bone axis convention matches what `physics`'s ragdoll expects when it adopts
 * the skeleton: local **+Y runs down the bone** toward its child and local +Z
 * points roughly forward, so a death hand-off does not pop.
 *
 * Unlike the inherited soldier rig (whose bind pose is a weapon carry), this
 * bind pose is a relaxed civilian stand: arms hanging, elbows very slightly
 * bent and carried a few centimetres clear of the ribs, feet a hand's width
 * apart with a touch of external rotation. Every garment in `parts.js` is
 * modelled where the limbs actually are, so the skin weights never have to
 * survive a 90 degree shoulder rotation and a coat sleeve does not shear when
 * the arm swings.
 */

import * as THREE from 'three';

/** Reference height the proportions are authored at (8 heads). */
export const REF_HEIGHT = 1.75;

const SHOULDER_R = [-0.162, 1.382, 0.004];
const SHOULDER_L = [0.162, 1.382, 0.004];
const ELBOW_R = [-0.183, 1.128, 0.016];
const ELBOW_L = [0.183, 1.128, 0.016];
const WRIST_R = [-0.196, 0.888, 0.048];
const WRIST_L = [0.196, 0.888, 0.048];

/** name, parent, bind world position, optional up hint, optional leaf dir. */
export const BONES = [
  ['Hips', null, [0, 0.952, -0.004]],
  ['Spine', 'Hips', [0, 1.062, -0.012]],
  ['Spine1', 'Spine', [0, 1.178, 0.0]],
  ['Spine2', 'Spine1', [0, 1.302, 0.006]],
  ['Neck', 'Spine2', [0, 1.432, -0.010]],
  ['Head', 'Neck', [0, 1.512, 0.004]],
  ['HeadTop', 'Head', [0, 1.752, 0.010]],

  ['ClavicleR', 'Spine2', [-0.034, 1.368, 0.014]],
  ['UpperArmR', 'ClavicleR', SHOULDER_R],
  ['ForearmR', 'UpperArmR', ELBOW_R],
  ['HandR', 'ForearmR', WRIST_R],
  ['FingersR', 'HandR', null, null, [-0.04, -0.93, 0.36]],

  ['ClavicleL', 'Spine2', [0.034, 1.368, 0.014]],
  ['UpperArmL', 'ClavicleL', SHOULDER_L],
  ['ForearmL', 'UpperArmL', ELBOW_L],
  ['HandL', 'ForearmL', WRIST_L],
  ['FingersL', 'HandL', null, null, [0.04, -0.93, 0.36]],

  ['UpLegR', 'Hips', [-0.086, 0.918, 0.0]],
  ['LegR', 'UpLegR', [-0.092, 0.492, 0.020]],
  ['FootR', 'LegR', [-0.096, 0.082, -0.024]],
  ['ToeR', 'FootR', [-0.098, 0.026, 0.104], [0, 1, 0]],

  ['UpLegL', 'Hips', [0.086, 0.918, 0.0]],
  ['LegL', 'UpLegL', [0.092, 0.492, 0.020]],
  ['FootL', 'LegL', [0.096, 0.082, -0.024]],
  ['ToeL', 'FootL', [0.098, 0.026, 0.104], [0, 1, 0]],
];

const LEAF_STUB = 0.070;

export class Rig {
  constructor() {
    this.names = [];
    this.parent = [];
    this.children = [];
    this.bindPos = [];
    this.bindQuat = [];
    this.localPos = [];
    this.localQuat = [];
    this.tail = [];
    this.length = [];
    this._map = new Map();

    for (let i = 0; i < BONES.length; i++) {
      const [name, parent] = BONES[i];
      this.names.push(name);
      this._map.set(name, i);
      this.parent.push(parent === null ? -1 : -2);
      this.children.push([]);
    }
    for (let i = 0; i < BONES.length; i++) {
      const parent = BONES[i][1];
      const pi = parent === null ? -1 : this._map.get(parent);
      this.parent[i] = pi;
      if (pi >= 0) this.children[pi].push(i);
    }

    for (let i = 0; i < BONES.length; i++) {
      const spec = BONES[i];
      let p = spec[2];
      if (!p) {
        const pi = this.parent[i];
        const base = this.bindPos[pi];
        const d = new THREE.Vector3(...spec[4]).normalize();
        p = [base.x + d.x * LEAF_STUB, base.y + d.y * LEAF_STUB, base.z + d.z * LEAF_STUB];
      }
      this.bindPos.push(new THREE.Vector3(...p));
    }

    const m = new THREE.Matrix4();
    const yAxis = new THREE.Vector3();
    const xAxis = new THREE.Vector3();
    const zAxis = new THREE.Vector3();
    const up = new THREE.Vector3();
    for (let i = 0; i < BONES.length; i++) {
      const kids = this.children[i];
      const tail = new THREE.Vector3();
      if (kids.length) {
        tail.copy(this.bindPos[kids[0]]);
        if (kids.length > 1) {
          const primary = kids.find((k) => !/Clavicle|UpLeg/.test(this.names[k]));
          if (primary !== undefined) tail.copy(this.bindPos[primary]);
          else {
            tail.set(0, 0, 0);
            for (const k of kids) tail.add(this.bindPos[k]);
            tail.multiplyScalar(1 / kids.length);
          }
        }
      } else {
        const spec = BONES[i];
        const d = spec[4]
          ? new THREE.Vector3(...spec[4]).normalize()
          : new THREE.Vector3().subVectors(this.bindPos[i], this.bindPos[this.parent[i]]).normalize();
        tail.copy(this.bindPos[i]).addScaledVector(d, LEAF_STUB);
      }
      this.tail.push(tail);
      yAxis.copy(tail).sub(this.bindPos[i]);
      this.length.push(yAxis.length());
      if (yAxis.lengthSq() < 1e-10) yAxis.set(0, 1, 0);
      yAxis.normalize();
      const hint = BONES[i][3] ?? [0, 0, 1];
      up.set(hint[0], hint[1], hint[2]);
      if (Math.abs(up.dot(yAxis)) > 0.985) up.set(1, 0, 0);
      xAxis.copy(yAxis).cross(up).normalize();
      zAxis.copy(xAxis).cross(yAxis).normalize();
      m.makeBasis(xAxis, yAxis, zAxis);
      this.bindQuat.push(new THREE.Quaternion().setFromRotationMatrix(m));
    }

    const inv = new THREE.Quaternion();
    const v = new THREE.Vector3();
    for (let i = 0; i < BONES.length; i++) {
      const pi = this.parent[i];
      if (pi < 0) {
        this.localPos.push(this.bindPos[i].clone());
        this.localQuat.push(this.bindQuat[i].clone());
      } else {
        inv.copy(this.bindQuat[pi]).invert();
        v.copy(this.bindPos[i]).sub(this.bindPos[pi]).applyQuaternion(inv);
        this.localPos.push(v.clone());
        this.localQuat.push(inv.clone().multiply(this.bindQuat[i]));
      }
    }

    this.count = BONES.length;
    this.eyeHeight = 1.618;
  }

  index(name) {
    const i = this._map.get(name);
    if (i === undefined) throw new Error(`[peds] unknown bone "${name}"`);
    return i;
  }

  has(name) {
    return this._map.has(name);
  }

  pos(name) {
    const v = this.bindPos[this.index(name)];
    return [v.x, v.y, v.z];
  }

  /** Distance from a point to a bone's bind-pose segment. */
  distanceToBone(i, x, y, z) {
    const a = this.bindPos[i], b = this.tail[i];
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const l2 = dx * dx + dy * dy + dz * dz;
    let t = l2 > 1e-12 ? ((x - a.x) * dx + (y - a.y) * dy + (z - a.z) * dz) / l2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    return Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t), z - (a.z + dz * t));
  }

  /** Fresh THREE.Bone hierarchy + Skeleton for one pedestrian instance. */
  createSkeleton() {
    const bones = [];
    for (let i = 0; i < this.count; i++) {
      const b = new THREE.Bone();
      b.name = this.names[i];
      b.position.copy(this.localPos[i]);
      b.quaternion.copy(this.localQuat[i]);
      b.matrixAutoUpdate = false;
      b.updateMatrix();
      bones.push(b);
    }
    for (let i = 0; i < this.count; i++) {
      const pi = this.parent[i];
      if (pi >= 0) bones[pi].add(bones[i]);
    }
    bones[0].updateMatrixWorld(true);
    return { bones, skeleton: new THREE.Skeleton(bones), root: bones[0] };
  }
}

/** One shared rig — the bind pose is identical for every pedestrian. */
export const RIG = new Rig();

/**
 * Ragdoll bone spec, consumed by `doll.js` and handed to
 * `physics.createRagdoll`, in the order the PBD solver wants it:
 *
 *   [ headBone, tailBone, radius, massFraction, parentIndex, cone°, twist°,
 *     drivesHeadBone ]
 *
 * ## Why the welding stubs exist
 *
 * The solver's ONLY positional constraint is a shared particle, and it shares
 * one exactly when two bones' endpoints coincide to the millimetre. A humanoid
 * branches sideways off the spine — the hip joint is 9 cm lateral of `Hips`,
 * the shoulder 16 cm lateral of `Spine2` — so a doll built naively from
 * head-to-first-child capsules has NOTHING holding a limb to the torso and
 * comes apart on the first impulse. See the write-up in `doll.js`.
 *
 * The `false` entries fix that: a short capsule from the spine joint out to the
 * limb root, whose only job is to put a particle where the torso already has
 * one. They drive no bone — writing a lateral stub's transform into `Spine2` or
 * `Hips` would lay the whole spine on its side.
 *
 * Their cone is free. Their direction is lateral while the parent runs up the
 * spine, so any limit tight enough to be anatomical would be violated in the
 * bind pose and the solver would inject energy trying to satisfy it.
 *
 * ## Why the clavicle is a real link and the pelvis is not
 *
 * A bone the doll does not drive keeps its animated local transform, i.e. it
 * stays RIGID to its parent. That is right for `Fingers`, `Toe` and `HeadTop`,
 * which are leaves the skin barely uses. It was catastrophic for `Clavicle`:
 * it is the heaviest bone on the shoulder-cap skin (0.72 of it), it hung rigid
 * off `Spine2` while the shoulder particle swung free, and the sleeve had to
 * span the difference. Measured on the emitted geometry, that one omission was
 * a 8.8x skin stretch and a 1.97x joint gap all by itself.
 *
 * So the arm chain welds at the CLAVICLE (`Spine2 -> ClavicleR` is the stub)
 * and the clavicle is simulated. The pelvis needs no equivalent because
 * `UpLeg`'s parent in the rig is `Hips`, which the doll already drives.
 */
/**
 * ## The cone column is measured against the PARENT CAPSULE, not against down
 *
 * That is easy to read as an anatomical range and it is not one. A limb's cone
 * limits the angle between it and the capsule above it in THIS list, and above
 * every limb sits a lateral welding stub, so the reference direction points
 * sideways out of the body. In the bind pose the thigh already sits 68 degrees
 * off its stub and the upper arm 92 degrees off the clavicle — so a "98 degree"
 * hip was really +30 degrees of travel, and a "105 degree" shoulder +13.
 *
 * A limit that tight is not a safety rail, it is a permanent fight. The cone
 * solver corrects a violation by moving BOTH ends of the child, and the child's
 * head is the shared joint particle — so every frame the limit was violated,
 * the solver pulled the hip joint out of the pelvis and the distance constraint
 * pulled it back. MEASURED, over 24 kills: the hip joint sat 1.69x its bind
 * distance from `Hips`, a 6 cm hole at the top of the leg, for as long as the
 * corpse was moving. Widening the hip alone to a real range took that to 1.13x.
 *
 * The numbers below are therefore bind-pose offset PLUS a real joint range:
 * shoulder ~180 of flexion, hip ~120 of flexion and ~45 of abduction, elbow and
 * knee ~135 of flexion (a cone cannot express a hinge; the twist column and
 * self-collision keep them honest), clavicle ~25 of protraction.
 */
export const DOLL = [
  ['Hips', 'Spine', 0.130, 0.14, -1, 0, 0, true],
  ['Spine', 'Spine1', 0.120, 0.10, 0, 24, 18, true],
  ['Spine1', 'Spine2', 0.128, 0.14, 1, 20, 14, true],
  ['Spine2', 'Neck', 0.122, 0.10, 2, 18, 12, true],
  ['Neck', 'Head', 0.050, 0.03, 3, 32, 26, true],
  ['Head', 'HeadTop', 0.094, 0.07, 4, 44, 32, true],
  ['Spine2', 'ClavicleR', 0.046, 0.01, 3, 45, 40, false],
  ['ClavicleR', 'UpperArmR', 0.050, 0.014, 6, 90, 34, true],
  ['UpperArmR', 'ForearmR', 0.055, 0.027, 7, 170, 70, true],
  ['ForearmR', 'HandR', 0.045, 0.018, 8, 135, 50, true],
  ['HandR', 'FingersR', 0.036, 0.006, 9, 70, 40, true],
  ['Spine2', 'ClavicleL', 0.046, 0.01, 3, 45, 40, false],
  ['ClavicleL', 'UpperArmL', 0.050, 0.014, 11, 90, 34, true],
  ['UpperArmL', 'ForearmL', 0.055, 0.027, 12, 170, 70, true],
  ['ForearmL', 'HandL', 0.045, 0.018, 13, 135, 50, true],
  ['HandL', 'FingersL', 0.036, 0.006, 14, 70, 40, true],
  ['Hips', 'UpLegR', 0.062, 0.02, 0, 140, 40, false],
  ['UpLegR', 'LegR', 0.085, 0.10, 16, 165, 40, true],
  ['LegR', 'FootR', 0.065, 0.045, 17, 130, 25, true],
  ['FootR', 'ToeR', 0.048, 0.012, 18, 55, 20, true],
  ['Hips', 'UpLegL', 0.062, 0.02, 0, 140, 40, false],
  ['UpLegL', 'LegL', 0.085, 0.10, 20, 165, 40, true],
  ['LegL', 'FootL', 0.065, 0.045, 21, 130, 25, true],
  ['FootL', 'ToeL', 0.048, 0.012, 22, 55, 20, true],
];
