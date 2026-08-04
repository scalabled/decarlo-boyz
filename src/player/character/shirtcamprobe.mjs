#!/usr/bin/env node
/**
 * SHIRT CAMERA PROBE — no shoulder skin is visible through the FABRIC, from
 * angles a real camera uses.
 *
 *   npm run shirtcam
 *
 * WHY A SECOND SHIRT GATE EXISTS. `shirtprobe.mjs` fans rays through the arm
 * JOINT — good geometry for the original seam-gap class, but structurally
 * blind to anything the domed sleeve cap shadows from that one point: an
 * independent review rendered the shoulder with a camera-parallel z-buffer and
 * found pixels the joint-fan certified as covered. Adding rays to a blind
 * point cannot see around it, so this probe measures the way a camera does —
 * an orthographic z-buffer over EVERY triangle, from five view directions,
 * across five arm poses, for all three brothers.
 *
 * THE HEM-APERTURE CLASSIFICATION IS THE POINT. A short sleeve is OPEN at the
 * hem, and with the arm flexed a camera can look down that opening and see the
 * shoulder inside — exactly as with a real shirt. Those sightlines cross the
 * open hem disc before striking skin, and they are classified and EXCLUDED:
 * they are correct garment behaviour, not a defect. What must be zero is skin
 * visible WITHOUT passing through the hem opening — skin through the fabric.
 *
 * Negative control: build.sleeveShrink reverts the sleeve to its pre-fix shape
 * and this probe must go red by hundreds of pixels (measured: ~1525 at rest).
 */
// INDEPENDENT shoulder-skin measurement.
// Full-scene orthographic z-buffer from realistic camera directions.
// No cherry-picked near-triangle set, no joint-converging fan. Every triangle
// occludes every ray. We then ask, per camera pixel: is the nearest surface
// SKIN, and does that hit sit on the TOP of a shoulder (above the joint,
// within the arm's girth)? That is the visible defect the claim says is gone.

import * as THREE from 'three';
import { buildCharacter, MAT, BONE_NAMES } from '/Users/greg/decarlo-boyz/src/player/character/mesh.js';
import { BROTHERS } from '/Users/greg/decarlo-boyz/src/player/brothers.js';

const SKIN = new Set([MAT.skin, MAT.face]);
const POSES = [
  ['rest', 0.0, 0.0],
  ['hold', 0.55, 0.18],
  ['aim', 0.95, 0.22],
  ['abduct', 0.30, 0.80],
  ['raised', 0.30, 1.00],
];

function dummyMats() { return new Array(8).fill(0).map(() => new THREE.MeshBasicMaterial()); }
function setEuler(bone, x, y, z) { bone.quaternion.setFromEuler(new THREE.Euler(x, y, z, 'YXZ')); }
function poseArms(bones, fl, ab) {
  for (const n of BONE_NAMES) if (bones[n]) bones[n].quaternion.identity();
  for (const side of ['R', 'L']) setEuler(bones['arm' + side], fl, 0, (side === 'R' ? 1 : -1) * ab);
}
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

// Orthographic raster. Camera looks along -viewDir. Build an orthonormal basis
// (right, up). Project every triangle, z-buffer by depth along viewDir.
// Returns {mat, wx, wy, wz} per pixel (nearest surface world hit).
const W = 220, H = 260;
function raster(pos, idx, groups, viewDir, bbox) {
  const fwd = viewDir.clone().normalize();
  let up = new THREE.Vector3(0, 1, 0);
  if (Math.abs(fwd.dot(up)) > 0.95) up = new THREE.Vector3(0, 0, 1);
  const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
  up = new THREE.Vector3().crossVectors(fwd, right).normalize();

  // Fit bbox into the image with padding.
  const corners = [];
  for (const cx of [bbox.min.x, bbox.max.x]) for (const cy of [bbox.min.y, bbox.max.y]) for (const cz of [bbox.min.z, bbox.max.z]) corners.push(new THREE.Vector3(cx, cy, cz));
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const c of corners) { const u = c.dot(right), v = c.dot(up); minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
  const pad = 0.02; minU -= pad; maxU += pad; minV -= pad; maxV += pad;
  const su = (W - 1) / (maxU - minU), sv = (H - 1) / (maxV - minV);

  const zbuf = new Float32Array(W * H).fill(Infinity);
  const mbuf = new Int8Array(W * H).fill(-1);
  const wx = new Float32Array(W * H), wy = new Float32Array(W * H), wz = new Float32Array(W * H);
  const shirtZ = new Float32Array(W * H).fill(Infinity); // nearest shirt depth per pixel

  const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (const g of groups) {
    for (let i = g.start; i < g.start + g.count; i += 3) {
      for (let k = 0; k < 3; k++) { const o = idx[i + k] * 3; P[k].set(pos[o], pos[o + 1], pos[o + 2]); }
      const u0 = (P[0].dot(right) - minU) * su, v0 = (P[0].dot(up) - minV) * sv, d0 = P[0].dot(fwd);
      const u1 = (P[1].dot(right) - minU) * su, v1 = (P[1].dot(up) - minV) * sv, d1 = P[1].dot(fwd);
      const u2 = (P[2].dot(right) - minU) * su, v2 = (P[2].dot(up) - minV) * sv, d2 = P[2].dot(fwd);
      const minx = Math.max(0, Math.floor(Math.min(u0, u1, u2)));
      const maxx = Math.min(W - 1, Math.ceil(Math.max(u0, u1, u2)));
      const miny = Math.max(0, Math.floor(Math.min(v0, v1, v2)));
      const maxy = Math.min(H - 1, Math.ceil(Math.max(v0, v1, v2)));
      const area = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
      if (Math.abs(area) < 1e-9) continue;
      const invA = 1 / area;
      for (let y = miny; y <= maxy; y++) {
        for (let x = minx; x <= maxx; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = ((u1 - px) * (v2 - py) - (u2 - px) * (v1 - py)) * invA;
          const w1 = ((u2 - px) * (v0 - py) - (u0 - px) * (v2 - py)) * invA;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const d = w0 * d0 + w1 * d1 + w2 * d2;
          const pi = y * W + x;
          if (g.materialIndex === MAT.shirt && d < shirtZ[pi]) shirtZ[pi] = d;
          if (d < zbuf[pi]) {
            zbuf[pi] = d; mbuf[pi] = g.materialIndex;
            wx[pi] = w0 * P[0].x + w1 * P[1].x + w2 * P[2].x;
            wy[pi] = w0 * P[0].y + w1 * P[1].y + w2 * P[2].y;
            wz[pi] = w0 * P[0].z + w1 * P[1].z + w2 * P[2].z;
          }
        }
      }
    }
  }
  return { mbuf, wx, wy, wz, zbuf, shirtZ, W, H };
}

// EXACT gate band, measured with full-scene camera occlusion. For each skin
// pixel, project the hit into the arm's posed frame: s = 0 at the shoulder
// joint, 1 at the elbow. Count only hits with s in the gate's covered band and
// within the gate's radial girth. Identical zone to shirtprobe.mjs; the only
// difference is HOW we decided the surface is visible (real camera z-buffer
// over all triangles vs. the gate's rays fanned through the joint over a
// near-triangle subset).
const S_LO = -0.40, S_HI = 0.35, RADIAL = 0.075;
// A skin pixel counts as a genuine hole only if the nearest shirt behind it is
// at least MARGIN metres further from the camera (else it is a seam/z-fight
// pixel where shirt and skin are effectively coincident). 1.5 mm is well above
// float error and below any real fabric offset.
const MARGIN = 0.0015;
function classify(view, arms, S, fwd) {
  let cnt = 0, seam = 0, hemAperture = 0; const margins = [];
  const { mbuf, wx, wy, wz, zbuf, shirtZ } = view;
  for (let pi = 0; pi < W * H; pi++) {
    if (!SKIN.has(mbuf[pi])) continue;
    const p = new THREE.Vector3(wx[pi], wy[pi], wz[pi]);
    for (const { armP, axis, armLen } of arms) {
      const rx = p.x - armP.x, ry = p.y - armP.y, rz = p.z - armP.z;
      if (rx * rx + ry * ry + rz * rz > (0.24 * S) ** 2) continue;
      const s = (rx * axis.x + ry * axis.y + rz * axis.z) / armLen;
      const qx = rx - s * armLen * axis.x, qy = ry - s * armLen * axis.y, qz = rz - s * armLen * axis.z;
      const radial = Math.hypot(qx, qy, qz);
      if (s >= S_LO && s <= S_HI && radial < RADIAL * S) {
        const behind = shirtZ[pi] - zbuf[pi]; // how far the nearest shirt sits behind the skin
        if (behind > MARGIN || !isFinite(shirtZ[pi])) {
          // Down-the-sleeve-opening test: does this camera ray cross the OPEN
          // hem disc IN FRONT of the skin hit? If so, the sightline enters the
          // sleeve through its physical opening — correct garment behaviour
          // (look down anyone's short sleeve), not a hole in the fabric.
          const hemC = new THREE.Vector3().copy(armP).addScaledVector(axis, 0.52 * armLen);
          const hemR = 0.062 * S;
          const denom = fwd.dot(axis);
          let viaHem = false;
          if (Math.abs(denom) > 1e-6) {
            const tHem = zbuf[pi] - ((p.x - hemC.x) * axis.x + (p.y - hemC.y) * axis.y + (p.z - hemC.z) * axis.z) / denom;
            if (tHem < zbuf[pi] - 1e-4) {
              const cx = p.x + (tHem - zbuf[pi]) * fwd.x - hemC.x;
              const cy = p.y + (tHem - zbuf[pi]) * fwd.y - hemC.y;
              const cz = p.z + (tHem - zbuf[pi]) * fwd.z - hemC.z;
              if (Math.hypot(cx, cy, cz) <= hemR) viaHem = true;
            }
          }
          if (viaHem) hemAperture++;
          else { cnt++; margins.push(behind); }
        }
        else seam++;
        break;
      }
    }
  }
  return { cnt, seam, margins, hemAperture };
}

const VIEWS = {
  front: new THREE.Vector3(0, 0, 1),
  frontQ_R: new THREE.Vector3(0.7, 0, 1),
  frontQ_L: new THREE.Vector3(-0.7, 0, 1),
  sideR: new THREE.Vector3(1, 0, 0.05),
  topFront: new THREE.Vector3(0, 0.8, 0.7),
};

function measure(id, shrink) {
  const build = shrink ? { ...BROTHERS[id].build, sleeveShrink: true } : BROTHERS[id].build;
  const { mesh, root, bones, geometry } = buildCharacter(build, dummyMats());
  const idx = geometry.index.array, groups = geometry.groups, S = build.scale ?? 1;
  const res = {};
  for (const [name, fl, ab] of POSES) {
    poseArms(bones, fl, ab);
    const pos = skinAll(mesh, root);
    const bbox = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.length; i += 3) { v.set(pos[i], pos[i + 1], pos[i + 2]); bbox.expandByPoint(v); }
    const arms = [];
    for (const SIDE of ['R', 'L']) {
      const armP = new THREE.Vector3().setFromMatrixPosition(bones['arm' + SIDE].matrixWorld);
      const elP = new THREE.Vector3().setFromMatrixPosition(bones['forearm' + SIDE].matrixWorld);
      const axis = elP.clone().sub(armP); const armLen = axis.length(); axis.normalize();
      arms.push({ armP, axis, armLen });
    }
    let total = 0, seamTotal = 0, hemTotal = 0; const per = {}; let allMargins = [];
    for (const [vn, vd] of Object.entries(VIEWS)) {
      const view = raster(pos, idx, groups, vd, bbox);
      const { cnt, seam, margins, hemAperture } = classify(view, arms, S, vd.clone().normalize());
      per[vn] = cnt; total += cnt; seamTotal += seam; allMargins = allMargins.concat(margins);
      hemTotal += hemAperture;
    }
    const maxM = allMargins.length ? Math.max(...allMargins.filter(isFinite)) : 0;
    res[name] = { total, per, seamTotal, maxM, hemTotal };
  }
  return res;
}

let fails = 0;
for (const id of ['carson', 'aidan', 'dylan']) {
  console.log(`\n=== ${id} ===`);
  const r = measure(id, false);
  for (const [pose, { total, per, seamTotal, maxM, hemTotal }] of Object.entries(r)) {
    const ok = total === 0;
    if (!ok) fails++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${pose.padEnd(8)} skinThroughFabric=${String(total).padStart(3)} viaHemOpening=${String(hemTotal).padStart(3)} (seam ${seamTotal}, maxMargin ${(maxM * 1000).toFixed(1)}mm)   ` + Object.entries(per).map(([k, v]) => `${k}:${v}`).join(' '));
  }
}

// MANDATORY negative control: the pre-fix sleeve must read as hundreds of
// exposed pixels, or this probe is measuring nothing.
console.log('\n=== negative control: aidan sleeveShrink (pre-fix sleeve) ===');
const c = measure('aidan', true);
let ncMax = 0;
for (const [pose, { total, per }] of Object.entries(c)) {
  ncMax = Math.max(ncMax, total);
  console.log(`  ${pose.padEnd(8)} skinTop=${String(total).padStart(4)}   ` + Object.entries(per).map(([k, v]) => `${k}:${v}`).join(' '));
}
if (ncMax < 300) { fails++; console.log(`  FAIL negative control too weak (${ncMax} < 300) — the probe is blind`); }
else console.log(`  ok   control fires: ${ncMax} exposed pixels on the pre-fix sleeve`);

console.log(`\nshirtcam: ${fails === 0 ? 'PASS' : `${fails} FAILURES`}`);
process.exit(fails ? 1 : 0);
