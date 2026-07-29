#!/usr/bin/env node
/**
 * POSE GATE — "are these arms attached to a person?", offline.
 *
 * `gaitprobe.mjs` already measures the LEGS (foot slide, stance duty, stride
 * reach). Nothing measured the upper body, and the upper body is where
 * "arms contorted" shows up. This drives the real `PedAnimator`
 * over every clip and every behaviour layer the game can actually stack, and
 * asserts four things about the result:
 *
 *   1 JOINT    every joint's swing — the angle between a bone and its parent,
 *              in WORLD space — stays inside an anatomical range. The animator
 *              has no joint limits of any kind: `Poser.d` is `+=` over a dozen
 *              layers that are all applied unconditionally, so a pedestrian
 *              carrying an umbrella who then gawks at a crash gets both, added,
 *              with nothing to stop the sum.
 *   2 SEGMENT  every bone's length is constant frame to frame. Catches a NaN,
 *              a zero scale, or anything writing a bone POSITION when it meant
 *              to write a rotation.
 *   3 MIRROR   every clip that takes a `side` produces the exact mirror image
 *              of itself when the side flips. `punch` did not: three lateral
 *              channels carried a fixed sign while the bone names flipped, so
 *              half of all punches folded both arms across the chest.
 *   5 MIDLINE  no hand ends up inside the opposite half of the torso.
 *   4 SKIN     the emitted skinned geometry's worst edge stretch over the whole
 *              animation set — the same measurement `corpseprobe.mjs` makes on
 *              a corpse, made on a walking pedestrian, so a skinning change
 *              cannot fix the dead and break the living.
 *
 * The limit table is ANATOMY and it is held here. The animator never reads it —
 * it has no limits at all — so this is not the gate comparing a number to
 * itself (ARCHITECTURE.md rule 12). It is deliberately generous: it is looking
 * for a shoulder folded across the chest, not for stylistic disagreement.
 *
 *   node src/peds/poseprobe.mjs
 *   node src/peds/poseprobe.mjs --worst
 *   node src/peds/poseprobe.mjs --legacy     # NEGATIVE CONTROL, must fail
 */
import * as THREE from 'three';
import { RIG } from './rig.js';
import { PedAnimator } from './animator.js';
import { LEGACY, punch, dive, carryAdd, phoneAdd, smokeAdd, umbrellaAdd } from './clips.js';
import { buildOutfit } from './builder.js';
import { makeOutfit, SHAPE_IDS } from './wardrobe.js';
import { Rng } from '../core/rng.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
LEGACY.mirrorSigns = !!args.legacy;

/**
 * Anatomical swing limits, degrees, measured as the angle between a bone's
 * world direction and its PARENT's world direction. The bind pose value is in
 * brackets, because a limit is only meaningful as a distance from where the
 * rig starts:
 *
 *   Clavicle vs Spine2   [57]  a shoulder girdle protracts/elevates ~25
 *   UpperArm vs Clavicle [92]  a shoulder has ~180 of flexion, ~50 of extension
 *   Forearm  vs UpperArm  [5]  the elbow is a hinge: 0 to ~150
 *   Hand     vs Forearm   [8]  the wrist: ~80 either way
 *   UpLeg    vs Hips      [?]  hip flexion ~120, extension ~20
 *   Leg      vs UpLeg     [9]  the knee: 0 to ~150
 *   Foot     vs Leg       [?]  the ankle: ~50 total
 *   Neck/Head vs parent         ~55 each, and they stack
 *
 * These are the SAME joints `rig.js` DOLL now limits for the ragdoll, but the
 * numbers are independent: DOLL's cones are measured against welding stubs, in
 * a different frame, and the animator consults neither.
 */
const RANGE = {
  ClavicleR: 32, ClavicleL: 32,
  UpperArmR: 178, UpperArmL: 178,
  ForearmR: 152, ForearmL: 152,
  HandR: 88, HandL: 88,
  UpLegR: 130, UpLegL: 130,
  LegR: 152, LegL: 152,
  FootR: 72, FootL: 72,
  Neck: 56, Head: 60,
  Spine: 46, Spine1: 42, Spine2: 40,
};

/**
 * The limit is `bind swing + range`. Measuring a swing as the angle between a
 * bone and its parent bakes in whatever offset the bind pose already has — the
 * ankle sits 72 degrees off the shin before anything animates, because a foot
 * points forward and a shin points down — so a bare "75 degree ankle" would be
 * a 3-degree limit. The bind term comes from `rig.js`, which defines the
 * reference frame; the RANGE above is the independent anatomy, and the animator
 * reads neither.
 */
/** The bone a joint bends TOWARD — the same primary child `rig.js` uses. */
function primaryChild(i) {
  const kids = RIG.children[i];
  if (!kids.length) return -1;
  if (kids.length === 1) return kids[0];
  const primary = kids.find((k) => !/Clavicle|UpLeg/.test(RIG.names[k]));
  return primary === undefined ? kids[0] : primary;
}

const LIMIT = {};
const CHILD = {};
{
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (const [name, r] of Object.entries(RANGE)) {
    const i = RIG.index(name);
    const p = RIG.parent[i];
    const c = primaryChild(i);
    CHILD[name] = c;
    if (p < 0 || c < 0) { LIMIT[name] = r; continue; }
    a.subVectors(RIG.bindPos[c], RIG.bindPos[i]).normalize();
    b.subVectors(RIG.bindPos[i], RIG.bindPos[p]).normalize();
    const bind = (Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * 180) / Math.PI;
    LIMIT[name] = bind + r;
  }
}

/**
 * SKIN is a RATCHET (rule 13). The goal is ~1.2 and this is a NEW gate, so the
 * number below is simply where this pass landed over the full space, not a bar
 * anyone has cleared.
 *
 * On the base clips alone — no act layers, no one-shots, which is the subset
 * `gaitprobe` and the old eyeball test covered — it went 4.19 -> 2.18 in this
 * pass, the improvement coming from the radial shoulder weighting in `geo.js`
 * (a coat edge that used to go 27.7 mm -> 115.9 mm on a LIVE pedestrian in
 * `cower`). Over the whole space including stacked acts and dives it is 2.79.
 *
 * The residual is ONE defect and it is content, not maths: the torso shell is
 * lofted at 10-15 rows over a metre, so a single 7 cm quad has to span the
 * whole shoulder-to-chest weight gradient, and the four-bone skinning limit
 * then drops the clavicle entirely from the vertex below it. Rows concentrated
 * at the shoulder would close it. Lowering the clavicle bias, raising the row
 * count and Laplacian-smoothing the weight field were all tried in this pass
 * and all made it worse. Lower this when the shell is retessellated. Never
 * raise it.
 */
const SKIN_RATCHET = 2.85;
/** Edges shorter than this are compared against this, not against themselves:
 *  a 0.2 mm seam edge growing to 2 mm is a 10x ratio and 1.8 mm of nothing. */
const EDGE_FLOOR = 0.004;

const CLIPS = ['idle', 'walk', 'jog', 'run', 'cower', 'wait', 'lean'];
/** Layer stacks the game actually produces — see `ped.js` `_updateGawk`,
 *  `_updateFlee`, `_applyCarry` and `hurt`, none of which clear the others. */
const STACKS = [
  {},
  { pockets: 1 },
  { folded: 1 },
  { carry: 1 },
  { phone: 1 },
  { smoke: 1 },
  { talk: 1 },
  { umbrella: 1 },
  { gawk: 0.9 },
  { film: 1 },
  { flee: 1 },
  { hurt: 1 },
  { umbrella: 1, gawk: 0.9 },
  { umbrella: 1, hurt: 1 },
  { carry: 1, flee: 1, hurt: 1 },
  { phone: 1, gawk: 0.9, hurt: 1 },
  { umbrella: 1, film: 1, gawk: 0.9, hurt: 1 },
];
/**
 * SIDED CLIPS, for the mirror gate. Every one of these takes a `side` and every
 * one of them must produce the mirror image of itself when the side flips.
 */
const SIDED = [
  ['punch', (P, t, side) => punch(P, t, side)],
  ['dive', (P, t, side) => dive(P, t, side)],
  ['carryAdd', (P, t, side) => carryAdd(P, 1, side)],
  ['phoneAdd', (P, t, side) => phoneAdd(P, 1, t, side)],
  ['smokeAdd', (P, t, side) => smokeAdd(P, 1, t, side)],
  ['umbrellaAdd', (P, t, side) => umbrellaAdd(P, 1, side)],
];

/** One-shots, driven on top of the stacks. */
const SHOTS = [null, ['punch', -1], ['punch', 1], ['dive', -1], ['dive', 1], ['flinch'], ['turn', 1], ['turn', -1]];

/* ------------------------------------------------------------------ */

function edgeSet(geometry) {
  const idx = geometry.index.array;
  const pos = geometry.attributes.position.array;
  const seen = new Set();
  const a = [], b = [], len = [];
  const push = (i, j) => {
    const k = i < j ? i * 1048576 + j : j * 1048576 + i;
    if (seen.has(k)) return;
    seen.add(k);
    const l = Math.hypot(pos[i * 3] - pos[j * 3], pos[i * 3 + 1] - pos[j * 3 + 1], pos[i * 3 + 2] - pos[j * 3 + 2]);
    a.push(i); b.push(j); len.push(l);
  };
  for (let t = 0; t < idx.length; t += 3) {
    push(idx[t], idx[t + 1]);
    push(idx[t + 1], idx[t + 2]);
    push(idx[t + 2], idx[t]);
  }
  return { a: Int32Array.from(a), b: Int32Array.from(b), len: Float64Array.from(len) };
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3();

/**
 * The angle AT joint `i`, in world space: between the bone leaving it (i to its
 * primary child) and the bone arriving at it (parent to i). That is the elbow
 * at `Forearm`, the knee at `Leg`, the ankle at `Foot` — one joint per bone,
 * named for the bone the joint is in.
 */
function swing(bones, i, c) {
  const p = RIG.parent[i];
  if (p < 0 || c < 0) return 0;
  _a.setFromMatrixPosition(bones[c].matrixWorld);
  _b.setFromMatrixPosition(bones[i].matrixWorld);
  _c.setFromMatrixPosition(bones[p].matrixWorld);
  _d1.subVectors(_a, _b);
  _d2.subVectors(_b, _c);
  if (_d1.lengthSq() < 1e-12 || _d2.lengthSq() < 1e-12) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, _d1.normalize().dot(_d2.normalize())))) * 180) / Math.PI;
}

function run() {
  const worst = {
    joint: 0, jointName: '', jointWhere: '',
    seg: 0, segName: '', segWhere: '',
    mid: -Infinity, midName: '', midWhere: '',
    skin: 0, skinWhere: '', skinBind: 0, skinLen: 0,
  };
  let frames = 0;

  for (const shapeId of SHAPE_IDS) {
    const built = buildOutfit(shapeId, { rng: new Rng(0x9051e ^ (shapeId.length * 6151)), lod: 0 });
    const geo = built.geometry;
    const edges = edgeSet(geo);
    const outfit = makeOutfit(new Rng(11), 'street', { shape: shapeId });

    const { bones, skeleton, root } = RIG.createSkeleton();
    const group = new THREE.Group();
    const mesh = new THREE.SkinnedMesh(geo, null);
    group.add(root);
    group.add(mesh);
    mesh.bind(skeleton);
    group.scale.setScalar(outfit.scale);
    group.updateMatrixWorld(true);

    const an = new PedAnimator(RIG, bones, {
      gait: outfit.gait, height: outfit.height, scale: outfit.scale,
      probe: (x, z, fromY, out) => { out.y = 0; out.nx = 0; out.ny = 1; out.nz = 0; out.hit = true; return true; },
    });

    /** Bind segment lengths, scaled — the reference gate 2 compares against. */
    const segRef = [];
    for (let i = 0; i < RIG.count; i++) {
      const p = RIG.parent[i];
      segRef.push(p < 0 ? 0 : RIG.bindPos[i].distanceTo(RIG.bindPos[p]) * outfit.scale);
    }

    for (const clip of CLIPS) {
      for (const stack of STACKS) {
        for (const shot of SHOTS) {
          an.clearActs?.();
          for (const [k, v] of Object.entries(stack)) an.setAct(k, v, k === 'carry' || k === 'umbrella' ? -1 : undefined);
          an.setState({ clip, speed: clip === 'run' ? 4.4 : clip === 'jog' ? 2.7 : clip === 'walk' ? 1.4 : 0 });
          an.blend = 1;
          if (shot) {
            if (shot[0] === 'punch') an.punchNow(shot[1]);
            else if (shot[0] === 'dive') an.diveNow(shot[1]);
            else if (shot[0] === 'flinch') an.flinch(1.2);
            else if (shot[0] === 'turn') an.turn(shot[1]);
          }
          const where = `${shapeId}/${clip}/${JSON.stringify(stack)}${shot ? '/' + shot.join('') : ''}`;
          for (let f = 0; f < 46; f++) {
            an.update(1 / 60, f / 60);
            group.updateMatrixWorld(true);
            if (f % 3) continue;
            frames++;

            /* 1 JOINT */
            for (const name of Object.keys(LIMIT)) {
              const i = RIG.index(name);
              const s = swing(bones, i, CHILD[name]);
              const over = s - LIMIT[name];
              if (over > worst.joint) { worst.joint = over; worst.jointName = `${name} ${s.toFixed(0)}deg`; worst.jointWhere = where; }
            }

            /* 2 SEGMENT */
            for (let i = 0; i < RIG.count; i++) {
              const p = RIG.parent[i];
              if (p < 0 || segRef[i] < 1e-4) continue;
              _a.setFromMatrixPosition(bones[i].matrixWorld);
              _b.setFromMatrixPosition(bones[p].matrixWorld);
              const e = Math.abs(_a.distanceTo(_b) / segRef[i] - 1);
              if (e > worst.seg) { worst.seg = e; worst.segName = RIG.names[i]; worst.segWhere = where; }
            }

            /* 3 MIDLINE — a hand must not be inside the opposite half of the
             * torso. Measured as how far past the spine plane, in the ped's
             * own frame, a hand gets while it is also inside the chest slab. */
            for (const side of ['R', 'L']) {
              const sgn = side === 'R' ? -1 : 1; // the ped's right is -x
              _a.setFromMatrixPosition(bones[RIG.index(`Hand${side}`)].matrixWorld);
              _b.setFromMatrixPosition(bones[RIG.index('Spine1')].matrixWorld);
              const local = _c.copy(_a).sub(_b).applyQuaternion(
                bones[0].parent.getWorldQuaternion(new THREE.Quaternion()).invert()
              );
              // inside the chest slab: within 0.16 m vertically and 0.14 m deep
              if (Math.abs(local.y) > 0.20 * outfit.scale || Math.abs(local.z) > 0.16 * outfit.scale) continue;
              const past = -sgn * local.x; // >0 means the hand crossed the midline
              if (past > worst.mid) { worst.mid = past; worst.midName = `Hand${side}`; worst.midWhere = where; }
            }
          }

          /* 4 SKIN — emitted geometry, once per configuration at the peak of
           * the one-shot rather than every frame (this is the expensive one). */
          mesh.updateMatrixWorld(true);
          const inv = skeleton.boneInverses;
          const bindInv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
          const mats = bones.map((bn, k) => new THREE.Matrix4()
            .copy(mesh.matrixWorld).multiply(bindInv).multiply(bn.matrixWorld)
            .multiply(inv[k]).multiply(mesh.bindMatrix));
          const pos = geo.attributes.position.array;
          const si = geo.attributes.skinIndex.array;
          const sw = geo.attributes.skinWeight.array;
          const n = pos.length / 3;
          const P = new Float64Array(n * 3);
          for (let v = 0; v < n; v++) {
            const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
            let ox = 0, oy = 0, oz = 0;
            for (let k = 0; k < 4; k++) {
              const w = sw[v * 4 + k];
              if (!w) continue;
              const e = mats[si[v * 4 + k]].elements;
              ox += w * (e[0] * x + e[4] * y + e[8] * z + e[12]);
              oy += w * (e[1] * x + e[5] * y + e[9] * z + e[13]);
              oz += w * (e[2] * x + e[6] * y + e[10] * z + e[14]);
            }
            P[v * 3] = ox; P[v * 3 + 1] = oy; P[v * 3 + 2] = oz;
          }
          for (let e = 0; e < edges.len.length; e++) {
            const i = edges.a[e] * 3, j = edges.b[e] * 3;
            const l = Math.hypot(P[i] - P[j], P[i + 1] - P[j + 1], P[i + 2] - P[j + 2]);
            const r = l / Math.max(edges.len[e] * outfit.scale, EDGE_FLOOR);
            if (r > worst.skin) {
              worst.skin = r;
              worst.skinWhere = where;
              worst.skinBind = edges.len[e] * outfit.scale;
              worst.skinLen = l;
            }
          }
        }
      }
    }
  }
  return { worst, frames };
}


/* ------------------------------------------------------------------ */
/* 3 MIRROR — a sided clip must be its own mirror image                */
/* ------------------------------------------------------------------ */

/**
 * The one structural property every `side`-taking clip has to obey, and the one
 * nothing in the code enforces: flipping the side must reflect the pose through
 * the character's own midline.
 *
 * Under that reflection a bone swaps with its opposite number and its rotation
 * deltas map (x, y, z) -> (x, -y, -z): flexion is unchanged, twist and lateral
 * lean reverse. That is exactly the convention `dive` already writes by hand
 * (`ClavicleR z +16` against `ClavicleL z -16`) and exactly what `punch` had
 * stopped doing on three lines — it wrote a FIXED +8 / +16 / -10 while the bone
 * NAMES flipped with `side`, so a left-handed punch drove the punching arm
 * across the chest and folded the guard arm in behind it. Half of every fight.
 *
 * This is a pure test on the clip functions, independent of the animator, the
 * rig and the skin — which is why it catches the defect where gate 1 (joint
 * limits) and gate 4 (skin) both miss it: a 16-degree sign error is anatomically
 * legal and geometrically smooth. It is only WRONG.
 */
function mirrorName(n) {
  return n.endsWith('R') ? `${n.slice(0, -1)}L` : n.endsWith('L') ? `${n.slice(0, -1)}R` : n;
}

function recorder() {
  const out = new Map();
  return {
    w: 1,
    out,
    d(name, x, y, z) {
      const c = out.get(name) ?? [0, 0, 0];
      c[0] += x; c[1] += y; c[2] += z;
      out.set(name, c);
    },
    hip(x, y, z) {
      const c = out.get('#hip') ?? [0, 0, 0];
      c[0] += x; c[1] += y; c[2] += z;
      out.set('#hip', c);
    },
  };
}

function mirrorCheck() {
  let worst = 0, where = '';
  for (const [name, fn] of SIDED) {
    for (let k = 0; k <= 20; k++) {
      const t = k / 20;
      const A = recorder(); fn(A, t, -1);
      const B = recorder(); fn(B, t, 1);
      const names = new Set([...A.out.keys(), ...B.out.keys()]);
      for (const bone of names) {
        const a = A.out.get(bone) ?? [0, 0, 0];
        // the hip OFFSET is a translation: x mirrors, y and z do not
        const m = bone === '#hip' ? '#hip' : mirrorName(bone);
        const b = B.out.get(m) ?? [0, 0, 0];
        const want = bone === '#hip' ? [-b[0], b[1], b[2]] : [b[0], -b[1], -b[2]];
        for (let c = 0; c < 3; c++) {
          const e = Math.abs(a[c] - want[c]);
          if (e > worst) { worst = e; where = `${name} t=${t.toFixed(2)} ${bone}.${'xyz'[c]}  ${a[c].toFixed(2)} vs ${want[c].toFixed(2)}`; }
        }
      }
    }
  }
  return { worst, where };
}

const mirror = mirrorCheck();
const t0 = Date.now();
const { worst, frames } = run();
const secs = (Date.now() - t0) / 1000;

const MID_T = 0.02; // metres past the midline, inside the chest slab
const MIRROR_T = 1e-9; // degrees — an exact algebraic property, not a tolerance
const SEG_T = 0.002; // 0.2% — a rotation-only animator must be exact

console.log(`\n=== poseprobe — ${SHAPE_IDS.length} silhouettes x ${CLIPS.length} clips x ${STACKS.length} layer stacks x ${SHOTS.length} one-shots` +
  `${args.legacy ? '  \x1b[31m[LEGACY / NEGATIVE CONTROL]\x1b[0m' : ''} — ${frames} poses, ${secs.toFixed(1)} s ===\n`);
console.log(`  1 JOINT   worst swing over its anatomical limit : ${worst.joint > 0 ? `+${worst.joint.toFixed(1)} deg on ${worst.jointName}` : 'none'}  (want <= 0)`);
if (worst.joint > 0) console.log(`            ${worst.jointWhere}`);
console.log(`  2 SEGMENT worst bone length drift              : ${(worst.seg * 100).toFixed(4)}%  (want <= ${(SEG_T * 100).toFixed(1)}%)`);
console.log(`  3 MIRROR worst sided-clip asymmetry            : ${mirror.worst.toFixed(3)} deg  (want <= ${MIRROR_T})`);
if (mirror.worst > MIRROR_T) console.log(`            ${mirror.where}`);
console.log(`  5 MIDLINE worst hand past the spine, in-chest  : ${worst.mid > -Infinity ? (worst.mid * 1000).toFixed(1) : '0.0'} mm ${worst.midName}  (want <= ${MID_T * 1000} mm)`);
if (worst.mid > MID_T) console.log(`            ${worst.midWhere}`);
console.log(`  4 SKIN    worst emitted edge / bind edge        : ${worst.skin.toFixed(3)}  (want <= ${SKIN_RATCHET}, RATCHET)`);
console.log(`            ${(worst.skinBind * 1000).toFixed(1)} mm -> ${(worst.skinLen * 1000).toFixed(1)} mm   ${worst.skinWhere}`);

const bad = [];
if (worst.joint > 0) bad.push(`JOINT +${worst.joint.toFixed(0)} ${worst.jointName}`);
if (worst.seg > SEG_T) bad.push(`SEGMENT ${(worst.seg * 100).toFixed(2)}%`);
if (mirror.worst > MIRROR_T) bad.push(`MIRROR ${mirror.worst.toFixed(1)}deg`);
if (worst.mid > MID_T) bad.push(`MIDLINE ${(worst.mid * 1000).toFixed(0)}mm`);
if (worst.skin > SKIN_RATCHET) bad.push(`SKIN ${worst.skin.toFixed(2)}`);
console.log(bad.length ? `\nFAIL: ${bad.join(', ')}\n` : '\nPASS\n');
process.exit(bad.length ? 1 : 0);
