/**
 * Skeletal maths for the procedural animator: analytic two-bone IK, bone
 * aiming, and swing/twist decomposition.
 *
 * Everything is allocation-free after construction. All solvers write directly
 * into `bone.quaternion` (the bind pose is the identity rotation, which is what
 * makes "aim this bone at that point" a one-liner).
 */

import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();

/** Rest direction of a bone toward its child, in the bone's own local space. */
export function restDir(child, out = new THREE.Vector3()) {
  return out.copy(child.position).normalize();
}

/** World position of a bone (assumes matrixWorld is current). */
export function bonePos(bone, out) {
  return out.setFromMatrixPosition(bone.matrixWorld);
}

/** World rotation of a bone (assumes matrixWorld is current). */
export function boneQuat(bone, out) {
  bone.matrixWorld.decompose(_a, out, _s);
  return out;
}

/**
 * Point `bone` so that its rest child direction ends up along `dirWorld`.
 * `rest` is the bone's rest child direction in its own local space.
 * `twist` (radians, optional) spins the bone about the resulting axis.
 */
export function aimBone(bone, rest, dirWorld, twist = 0) {
  const parent = bone.parent;
  if (parent) {
    parent.matrixWorld.decompose(_a, _q, _s);
    _qi.copy(_q).invert();
    _d.copy(dirWorld).applyQuaternion(_qi);
  } else {
    _d.copy(dirWorld);
  }
  if (_d.lengthSq() < 1e-12) return bone;
  _d.normalize();
  bone.quaternion.setFromUnitVectors(rest, _d);
  if (twist !== 0) {
    _q.setFromAxisAngle(_d, twist);
    bone.quaternion.premultiply(_q);
  }
  return bone;
}

/**
 * Analytic two-bone IK.
 *
 * @param root    upper bone (hip / shoulder), its matrixWorld must be current
 * @param mid     lower bone (knee / elbow)
 * @param restA   root's rest direction toward mid, local
 * @param restB   mid's rest direction toward the end effector, local
 * @param lenA    bind length root->mid
 * @param lenB    bind length mid->end
 * @param target  world position the end effector should reach
 * @param poleDir world-space direction the joint should bend toward
 * @param minBend keeps the joint from locking straight (metres of shortening)
 * @returns the achieved end position error, metres
 */
export function solveTwoBone(root, mid, restA, restB, lenA, lenB, target, poleDir, minBend = 0.02) {
  root.updateWorldMatrix(true, false);
  bonePos(root, _a); // hip

  _b.copy(target).sub(_a);
  let len = _b.length();
  const reach = lenA + lenB - minBend;
  const shortest = Math.abs(lenA - lenB) + 0.01;
  const clamped = Math.min(reach, Math.max(shortest, len));
  if (len < 1e-6) {
    _b.set(0, -1, 0);
    len = 1;
  }
  _b.multiplyScalar(1 / len); // unit axis hip->target

  // Knee position: intersection of the two spheres, biased toward the pole.
  const a = (lenA * lenA - lenB * lenB + clamped * clamped) / (2 * clamped);
  const h = Math.sqrt(Math.max(0, lenA * lenA - a * a));
  _pole.copy(poleDir);
  _pole.addScaledVector(_b, -_pole.dot(_b));
  if (_pole.lengthSq() < 1e-8) {
    // Degenerate pole (parallel to the limb): pick any perpendicular.
    _pole.set(_b.y, -_b.x, 0);
    if (_pole.lengthSq() < 1e-8) _pole.set(0, 0, 1);
    _pole.addScaledVector(_b, -_pole.dot(_b));
  }
  _pole.normalize();

  _c.copy(_a).addScaledVector(_b, a).addScaledVector(_pole, h); // knee, world

  // Aim the upper bone at the knee.
  _d.copy(_c).sub(_a);
  aimBone(root, restA, _d);
  root.updateWorldMatrix(false, false);
  mid.updateWorldMatrix(false, false);

  // Aim the lower bone at the (possibly unreachable) target.
  bonePos(mid, _a);
  _d.copy(target).sub(_a);
  aimBone(mid, restB, _d);
  mid.updateWorldMatrix(false, true);

  return Math.max(0, len - reach);
}

/**
 * Orient a bone by an explicit world-space frame: `fwd` is where the bone's
 * rest child direction should point, `up` disambiguates the twist.
 */
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _rt = new THREE.Vector3();
export function orientBone(bone, rest, restUp, fwdWorld, upWorld) {
  const parent = bone.parent;
  if (parent) {
    parent.matrixWorld.decompose(_a, _q, _s);
    _qi.copy(_q).invert();
    _fwd.copy(fwdWorld).applyQuaternion(_qi);
    _up.copy(upWorld).applyQuaternion(_qi);
  } else {
    _fwd.copy(fwdWorld);
    _up.copy(upWorld);
  }
  if (_fwd.lengthSq() < 1e-12) return bone;
  _fwd.normalize();
  _up.addScaledVector(_fwd, -_up.dot(_fwd));
  if (_up.lengthSq() < 1e-10) _up.set(0, 0, 1).addScaledVector(_fwd, -_fwd.z);
  _up.normalize();
  _rt.crossVectors(_up, _fwd).normalize();

  // Build the target basis and the rest basis, then the rotation between them.
  _m.makeBasis(_rt, _up, _fwd);
  _q.setFromRotationMatrix(_m);
  _rt.crossVectors(restUp, rest).normalize();
  _up.crossVectors(rest, _rt).normalize();
  _m.makeBasis(_rt, _up, rest);
  _qi.setFromRotationMatrix(_m).invert();
  bone.quaternion.copy(_q).multiply(_qi);
  return bone;
}

/** Local euler helper — bind pose is identity, so this is a pure offset pose. */
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
export function setEuler(bone, x, y, z) {
  _e.set(x, y, z);
  bone.quaternion.setFromEuler(_e);
  return bone;
}

export function addEuler(bone, x, y, z) {
  _e.set(x, y, z);
  _q.setFromEuler(_e);
  bone.quaternion.multiply(_q);
  return bone;
}
