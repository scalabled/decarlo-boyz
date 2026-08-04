#!/usr/bin/env node
/**
 * Shoulder-coverage gate — the mechanical answer to "can you see skin at the top
 * of the shoulder, through the shirt?".
 *
 * Renders nothing. It takes the geometry `buildBody()` actually emits, POSES the
 * arm bones across the range the player uses (arms hang at rest, flex forward to
 * carry and to aim a two-handed weapon, abduct to shoulder height — this rig
 * never lifts an arm above the shoulder), SKINS every vertex with the real bone
 * matrices, then fires rays at each shoulder from the outer/upper hemisphere and
 * asks what the NEAREST surface is. Skin found in the region the shirt is meant
 * to cover — the acromion / superior deltoid, the top of the shoulder down to
 * the top third of the upper arm — is the bug.
 *
 * WHY POSED + SKINNED, unlike `headprobe.mjs`. The head is one rigid bone, so
 * bind pose == every pose. The shoulder is not: the deltoid skin and the sleeve
 * ride the ARM bone while the shirt torso rides the CHEST, so the gap between
 * them opens as the arm rotates. The old sleeve started inboard, low and open at
 * the top and never domed over the deltoid crown (which stands proud at
 * sh.y + 0.052); a band of skin showed at the acromion and widened as the arm
 * lifted (the chest-weighted torso receded from under it while the arm-weighted
 * crown did not). Measured exposed superior-shoulder skin, before the fix:
 * carson 15343 mm2 / aidan 10441 / dylan 4079 at rest, ~30k raised.
 *
 * WHY IT IS NOT A TAUTOLOGY (rule 12). The assertion is on the emitted, skinned
 * triangles — the drawn cap — not on any outfit input. The input that makes it
 * fail is a sleeve that does not reach over the crown: `build.sleeveShrink`
 * reverts `mesh.js`'s sleeve to exactly that pre-fix shape, and the gate runs it
 * as a MANDATORY negative control every time, asserting the count goes RED. A
 * build where the cap silently stopped covering, or where this file stopped
 * measuring, fails the control and the run is red.
 *
 *   node src/player/character/shirtprobe.mjs            # gate, exits non-zero
 *   node src/player/character/shirtprobe.mjs --dirs=12000
 */
import * as THREE from 'three';
import { buildCharacter, MAT, BONE_NAMES } from './mesh.js';
import { BROTHERS } from '../brothers.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const NDIR = Number(args.dirs ?? 6000);
const SKIN = new Set([MAT.skin, MAT.face]);

/**
 * Arm poses as [name, flexion, abduction] radians, applied to the `arm` bone
 * (the bind pose is identity, +Y is up, +X is the character's right, -Z is
 * forward). Flexion (+X) swings the arm forward; abduction (±Z, outward per
 * side) lifts it to the side. The set brackets real use: hands down, weapon
 * carry, two-handed aim, and an arm raised toward — never past — shoulder level.
 */
const POSES = [
  ['rest', 0.0, 0.0],
  ['hold', 0.55, 0.18],
  ['aim', 0.95, 0.22],
  ['abduct', 0.30, 0.80],
  ['raised', 0.30, 1.00],
];

/**
 * The region the shirt must cover, expressed in each shoulder's own POSED frame:
 * `s` runs 0 at the shoulder joint to 1 at the elbow along the upper-arm axis,
 * so s < 0 is above the joint (the acromion) and s ≈ 0.5 is the sleeve hem.
 *   - s ∈ [-0.40, 0.35]: the shoulder cap and the top third of the upper arm.
 *     -0.40 is 0.11 m above the joint — above the deltoid crown but below the
 *     neck base, so a near-horizontal ray cannot graze the neck/trapezius
 *     junction and be scored as shoulder skin; below 0.35 stays clear of the
 *     rolled hem, where bare arm SHOULD read through (short sleeve).
 *   - radial < RADIAL: within the arm's own girth, i.e. actually on the shoulder.
 * The deltoid skin crown that used to show sits at s ≈ -0.2, squarely inside it.
 */
const S_LO = -0.40, S_HI = 0.35;
const RADIAL = 0.075;

/** The control must expose at least this many rays, or the gate is not measuring. */
const CONTROL_MIN = 500;

function dummyMats() { return new Array(8).fill(0).map(() => new THREE.MeshBasicMaterial()); }
function setEuler(bone, x, y, z) { bone.quaternion.setFromEuler(new THREE.Euler(x, y, z, 'YXZ')); }

function poseArms(bones, fl, ab) {
  for (const n of BONE_NAMES) if (bones[n]) bones[n].quaternion.identity();
  for (const side of ['R', 'L']) setEuler(bones['arm' + side], fl, 0, (side === 'R' ? 1 : -1) * ab);
}

/** Linear-blend-skin every vertex with the real bone matrices; returns positions. */
function skinAll(mesh, root) {
  root.updateMatrixWorld(true);
  mesh.skeleton.update();
  const g = mesh.geometry, n = g.attributes.position.count;
  const out = new Float32Array(n * 3), v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(g.attributes.position, i);
    mesh.applyBoneTransform(i, v);
    out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
  }
  return out;
}

/** Moller-Trumbore, two-sided: a back-facing hit still occludes visually. */
function rayTri(ox, oy, oz, dx, dy, dz, t) {
  const e1x = t[3] - t[0], e1y = t[4] - t[1], e1z = t[5] - t[2];
  const e2x = t[6] - t[0], e2y = t[7] - t[1], e2z = t[8] - t[2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return -1;
  const inv = 1 / det, tx = ox - t[0], ty = oy - t[1], tz = oz - t[2];
  const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) return -1;
  const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return d > 1e-6 ? d : -1;
}

function fibonacci(n) {
  const out = [], golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    // Upper/outer hemisphere only: rays from below look up into the armpit,
    // which is not what a camera sees and not the reported defect.
    if (y < -0.1) continue;
    out.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return out;
}
const DIRS = fibonacci(NDIR);

/** Count rays whose nearest surface is skin inside one shoulder's covered zone. */
function shoulderSkin(pos, groups, idx, armP, elP, S) {
  const axis = elP.clone().sub(armP); const armLen = axis.length(); axis.normalize();
  const R = 0.24 * S; // the covered zone lives within ~0.15 m of the joint
  const tris = [];
  for (const g of groups) {
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, k = idx[i + 2] * 3;
      let near = false;
      for (const o of [a, b, k]) {
        const dx = pos[o] - armP.x, dy = pos[o + 1] - armP.y, dz = pos[o + 2] - armP.z;
        if (dx * dx + dy * dy + dz * dz <= R * R) { near = true; break; }
      }
      if (!near) continue;
      tris.push([pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[k], pos[k + 1], pos[k + 2], g.materialIndex]);
    }
  }
  let cnt = 0;
  for (const d of DIRS) {
    const ox = armP.x + d[0] * R, oy = armP.y + d[1] * R, oz = armP.z + d[2] * R;
    let best = Infinity, mat = -1, hx = 0, hy = 0, hz = 0;
    for (const t of tris) {
      const dd = rayTri(ox, oy, oz, -d[0], -d[1], -d[2], t);
      if (dd >= 0 && dd < best) { best = dd; mat = t[9]; hx = ox - d[0] * dd; hy = oy - d[1] * dd; hz = oz - d[2] * dd; }
    }
    if (mat < 0 || !SKIN.has(mat)) continue;
    const rx = hx - armP.x, ry = hy - armP.y, rz = hz - armP.z;
    const s = (rx * axis.x + ry * axis.y + rz * axis.z) / armLen;
    const px = rx - (s * armLen) * axis.x, py = ry - (s * armLen) * axis.y, pz = rz - (s * armLen) * axis.z;
    const radial = Math.hypot(px, py, pz);
    if (s >= S_LO && s <= S_HI && radial < RADIAL * S) cnt++;
  }
  return cnt;
}

/** Exposed superior-shoulder skin per pose (summed over both shoulders). */
function measure(id, shrink, poses) {
  const build = shrink ? { ...BROTHERS[id].build, sleeveShrink: true } : BROTHERS[id].build;
  const { mesh, root, bones, geometry } = buildCharacter(build, dummyMats());
  const idx = geometry.index.array, groups = geometry.groups, S = build.scale ?? 1;
  const out = {};
  for (const [name, fl, ab] of poses) {
    poseArms(bones, fl, ab);
    const pos = skinAll(mesh, root);
    let cnt = 0;
    for (const SIDE of ['R', 'L']) {
      const armP = new THREE.Vector3().setFromMatrixPosition(bones['arm' + SIDE].matrixWorld);
      const elP = new THREE.Vector3().setFromMatrixPosition(bones['forearm' + SIDE].matrixWorld);
      cnt += shoulderSkin(pos, groups, idx, armP, elP, S);
    }
    out[name] = cnt;
  }
  return out;
}

let failures = 0;
console.log(`shoulder coverage — ${DIRS.length} rays/shoulder, poses: ${POSES.map((p) => p[0]).join(', ')}`);
for (const id of ['carson', 'aidan', 'dylan']) {
  const r = measure(id, false, POSES);
  const total = Object.values(r).reduce((a, b) => a + b, 0);
  const bad = total > 0;
  if (bad) failures++;
  console.log(`\n=== ${id} (${BROTHERS[id].build.hair} shirt) ===`);
  console.log('  exposed superior-shoulder skin (rays): ' + POSES.map(([n]) => `${n} ${r[n]}`).join('  ') + `  (want 0)`);
  if (bad) console.log(`  FAIL: skin visible over the shoulder in ${Object.entries(r).filter(([, v]) => v > 0).map(([n]) => n).join(', ')}`);
  else console.log('  PASS');
}

/* ---- negative control: revert the cap and confirm the gate goes red ---- */
const ctrl = measure('aidan', true, [POSES[0], POSES[4]]); // rest + raised
const ctrlMin = Math.min(ctrl.rest, ctrl.raised);
const ctrlOk = ctrlMin >= CONTROL_MIN;
if (!ctrlOk) failures++;
console.log(`\n=== negative control (aidan, build.sleeveShrink) ===`);
console.log(`  exposed skin with the pre-fix sleeve: rest ${ctrl.rest}  raised ${ctrl.raised}  (want >= ${CONTROL_MIN})`);
console.log(ctrlOk ? '  PASS (gate detects the gap when the cap is removed)' : '  FAIL: control did not go red — the gate is not measuring the cap');

console.log(`\n${failures ? `FAIL (${failures} check${failures > 1 ? 's' : ''})` : 'PASS (3/3 brothers, control red)'}`);
process.exit(failures ? 1 : 0);
