#!/usr/bin/env node
/**
 * AIM-POSE GATE — "are the hands on the grip and the forearms clear of the
 * chest?", offline, on the EMITTED skinned geometry.
 *
 * The weapon-hold pose (`Animator._poseAim`) IKs both arms to a two-handed grip
 * authored in CHEST-local space. The elbow POLE vectors that decide which way
 * each elbow points used to be built from the root/face basis
 * (`this._right` / `this._fwd`). When the aim twists the chest away from the
 * pelvis — aiming across the body — the pole no longer meant "down and out from
 * the shoulder", the two-bone solver planted the reaching elbow on the wrong
 * side, and the SUPPORT forearm was driven straight through the ribcage. It read
 * as "arms crossing through the body while holding a weapon".
 *
 * This drives the real `Animator` on the real `buildCharacter` body for all
 * three brothers, over a sweep of aim yaw offsets (the body-vs-camera twist) and
 * pitches, skins the mesh by hand from the posed skeleton, and measures how far
 * any forearm/hand VERTEX penetrates the torso capsule. The capsule radius is
 * taken from the TORSO'S OWN emitted vertices, not from any pose input, so this
 * is not a gate comparing a number to itself (ARCHITECTURE.md rule 12): the
 * torso decides how wide it is, the arm vertices are tested against it.
 *
 *   node src/player/anim/aimposeprobe.mjs
 *   node src/player/anim/aimposeprobe.mjs --legacy   # NEGATIVE CONTROL, must fail
 *
 * `--legacy` flips `Animator.debugAimChestPole = false` on the LIVE animator,
 * restoring the face-frame pole, and the gate goes red — which is what proves
 * the gate measures the fix and not the harness.
 */
import * as THREE from 'three';
import { buildCharacter, BONE_INDEX, BONE_NAMES } from '../character/mesh.js';
import { Animator } from './animator.js';
import { BROTHERS } from '../brothers.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

/** Penetration we treat as a hit. The fix measures 0.0 mm everywhere; skinning
 *  slop and the capsule's own discretisation are well under this. */
const PEN_T = 0.006; // metres

const fakeCtx = { peek: () => null, get: () => null, config: { q: {} } };

const TORSO = ['hips', 'spine', 'chest'].map((n) => BONE_INDEX[n]);
const ARM = new Set();
for (const s of ['R', 'L']) for (const b of ['forearm', 'hand', 'handEnd']) ARM.add(BONE_INDEX[b + s]);

function buildRig(spec) {
  const mats = new Array(8).fill(0).map(() => new THREE.MeshBasicMaterial());
  const built = buildCharacter(spec.build, mats);
  return {
    root: built.root, mesh: built.mesh, skeleton: built.skeleton,
    bones: built.bones, geometry: built.geometry,
    bindPositions: built.bindPositions, scale: spec.build.scale ?? 1, side: 1,
  };
}

function dominant(geo) {
  const si = geo.attributes.skinIndex.array, sw = geo.attributes.skinWeight.array;
  const n = geo.attributes.position.count;
  const d = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    let best = -1, bw = -1;
    for (let k = 0; k < 4; k++) { const w = sw[v * 4 + k]; if (w > bw) { bw = w; best = si[v * 4 + k]; } }
    d[v] = best;
  }
  return d;
}

function skinned(mesh, geo, skel) {
  mesh.updateMatrixWorld(true);
  const inv = skel.boneInverses, bones = skel.bones;
  const bindInv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  const mats = bones.map((bn, k) => new THREE.Matrix4()
    .copy(mesh.matrixWorld).multiply(bindInv).multiply(bn.matrixWorld)
    .multiply(inv[k]).multiply(mesh.bindMatrix));
  const pos = geo.attributes.position.array, si = geo.attributes.skinIndex.array, sw = geo.attributes.skinWeight.array;
  const n = pos.length / 3, P = new Float64Array(n * 3);
  for (let v = 0; v < n; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let ox = 0, oy = 0, oz = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw[v * 4 + k]; if (!w) continue;
      const e = mats[si[v * 4 + k]].elements;
      ox += w * (e[0] * x + e[4] * y + e[8] * z + e[12]);
      oy += w * (e[1] * x + e[5] * y + e[9] * z + e[13]);
      oz += w * (e[2] * x + e[6] * y + e[10] * z + e[14]);
    }
    P[v * 3] = ox; P[v * 3 + 1] = oy; P[v * 3 + 2] = oz;
  }
  return P;
}

function segDist(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const ab2 = abx * abx + aby * aby + abz * abz;
  let t = ab2 > 0 ? (apx * abx + apy * aby + apz * abz) / ab2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t, cy = ay + aby * t, cz = az + abz * t;
  return Math.hypot(px - cx, py - cy, pz - cz);
}

/** Torso capsule from the EMITTED torso vertices: axis hips->neck, radius the
 *  85th-percentile radial distance of the torso's own skin. */
function torsoCapsule(P, dom, bones) {
  const a = new THREE.Vector3().setFromMatrixPosition(bones.hips.matrixWorld);
  const b = new THREE.Vector3().setFromMatrixPosition(bones.neck.matrixWorld);
  const rs = [];
  const n = P.length / 3;
  for (let v = 0; v < n; v++) {
    if (!TORSO.includes(dom[v])) continue;
    rs.push(segDist(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], a.x, a.y, a.z, b.x, b.y, b.z));
  }
  rs.sort((x, y) => x - y);
  return { a, b, r: rs[Math.floor(rs.length * 0.85)] };
}

function poseState(off, pitch) {
  return {
    x: 0, y: 0, z: 0, faceYaw: 0, aimYaw: off, aimPitch: pitch,
    speed: 0, grounded: true, crouch: false, aim: 1, swim: false, driving: false,
    stumble: 0, turning: 0, strafe: 0, forwardSign: 1, verticalVel: 0,
    landImpulse: 0, steer: 0, lateral: 0, surface: 'concrete', groundDist: 0,
    swing: 0, swingSide: 1, swingWeight: 0, submerged: 0, dead: 0, guard: 0,
    topSpeed: 6, sprinting: false,
  };
}

const OFFSETS = [-1.9, -1.4, -0.9, -0.5, 0, 0.5, 0.9, 1.4, 1.9];
const PITCHES = [0, 0.6, -0.6];

let worst = 0, worstWhere = '';
for (const id of ['carson', 'aidan', 'dylan']) {
  const spec = BROTHERS[id];
  const rig = buildRig(spec);
  const an = new Animator(fakeCtx, rig);
  if (args.legacy) an.debugAimChestPole = false;
  const dom = dominant(rig.geometry);

  for (const off of OFFSETS) {
    for (const pitch of PITCHES) {
      const s = poseState(off, pitch);
      for (let f = 0; f < 160; f++) an.update(1 / 60, s);
      rig.root.updateMatrixWorld(true);
      const P = skinned(rig.mesh, rig.geometry, rig.skeleton);
      const cap = torsoCapsule(P, dom, rig.bones);
      const n = P.length / 3;
      for (let v = 0; v < n; v++) {
        if (!ARM.has(dom[v])) continue;
        const d = segDist(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], cap.a.x, cap.a.y, cap.a.z, cap.b.x, cap.b.y, cap.b.z);
        const pen = cap.r - d;
        if (pen > worst) { worst = pen; worstWhere = `${id} yaw=${off} pitch=${pitch} ${BONE_NAMES[dom[v]]} R=${(cap.r * 1000).toFixed(0)}mm`; }
      }
    }
  }
}

console.log(`\n=== aimposeprobe — 3 brothers x ${OFFSETS.length} aim-yaw x ${PITCHES.length} pitch` +
  `${args.legacy ? '  \x1b[31m[LEGACY / NEGATIVE CONTROL]\x1b[0m' : ''} ===\n`);
console.log(`  worst forearm/hand vertex INSIDE the torso capsule : ${(worst * 1000).toFixed(1)} mm  (want <= ${(PEN_T * 1000).toFixed(0)} mm)`);
if (worst > 0) console.log(`  worst at: ${worstWhere}`);

const bad = worst > PEN_T;
console.log(bad ? `\nFAIL: forearm/hand crosses the torso by ${(worst * 1000).toFixed(1)} mm\n` : '\nPASS\n');
process.exit(bad ? 1 : 0);
