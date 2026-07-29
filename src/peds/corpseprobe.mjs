#!/usr/bin/env node
/**
 * CORPSE GATE — "does a dead pedestrian keep the shape of a person?", offline.
 *
 * Renders nothing, in the same spirit as `src/player/character/headprobe.mjs`
 * and `src/peds/gaitprobe.mjs`. It kills many pedestrians many ways and asserts
 * on the SKINNED GEOMETRY THE GPU WOULD ACTUALLY EMIT — every vertex pushed
 * through the same `boneMatrix = bone.matrixWorld * boneInverse` blend that
 * three's skinning shader does — not on the solver's own particle array.
 *
 * That distinction is the whole point (ARCHITECTURE.md rule 12). The physics
 * self-test already asserts "bone lengths preserved, max stretch < 6%" by
 * measuring the solver's own bone segments, and it passes on a build where the
 * corpse is a five-metre smear, because a bone can hold its own length
 * perfectly while flying away from the body it is supposed to be attached to.
 * The skin is what the player sees, so the skin is what gets measured.
 *
 * The five gates:
 *
 *   1 EDGE    no triangle edge of the emitted mesh longer than
 *             `EDGE_RATIO` x its bind length. This is the direct measure of
 *             "the body got strewn/stretched": skin only stretches by having
 *             its edges stretch. Reference is the SAME mesh's bind-pose edge
 *             lengths, which no part of the death path ever reads.
 *   2 REACH   every driven bone's distance to its parent joint is within
 *             `REACH_RATIO` of the bind distance. Catches a limb that has
 *             separated from the torso before the skin has finished tearing.
 *   3 BBOX    the emitted mesh's bounding box diagonal never exceeds
 *             `BBOX_RATIO` x a standing body's. A corpse is a heap; a heap is
 *             SMALLER than a standing man, never several times larger.
 *   4 FINITE  no NaN and no degenerate (near-zero or exploded) bone scale
 *             anywhere in the skinning matrices.
 *   5 GROUND  no emitted vertex more than `SINK` below the road. A corpse that
 *             drapes through the pavement is the other half of the same class
 *             of bug and is free to measure once the skin is being read.
 *
 *   node src/peds/corpseprobe.mjs
 *   node src/peds/corpseprobe.mjs --kills=120 --worst        # dump the worst case
 *   node src/peds/corpseprobe.mjs --legacy                   # NEGATIVE CONTROL
 *
 * `--legacy` reverts the fix — it builds the ragdoll the way the shipped build
 * did, straight from `physics.createRagdollFromSkeleton` — and is how the
 * numbers below were shown to mean something. A gate that has never failed is
 * not evidence.
 *
 * Cross-subsystem import, deliberate: this gate drives the REAL PBD solver out
 * of `src/physics/ragdoll.js` against the REAL static-world BVH. A stub solver
 * would only ever prove that the stub does not stretch anything. Nothing here
 * ships; it is a dev tool, like `src/physics/selftest.js`.
 */
import * as THREE from 'three';
import { RIG } from './rig.js';
import { PedAnimator } from './animator.js';
import { buildOutfit } from './builder.js';
import { makeOutfit, SHAPE_IDS } from './wardrobe.js';
import { buildPedRagdoll } from './doll.js';
import { Rng } from '../core/rng.js';
import { StaticWorld } from '../physics/bvh.js';
import { Ragdoll, specFromSkeleton } from '../physics/ragdoll.js';
import { SURFACE, LAYER, MASK } from '../physics/surfaces.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const KILLS = Number(args.kills ?? 96);
const LEGACY = !!args.legacy;
const SETTLE_STEPS = 600; // 5 s at 120 Hz — well past the sleep threshold
const SAMPLE_EVERY = 25; // measure the emitted mesh every 25 steps
const ITERS = Number(args.iters ?? 8);

/**
 * THRESHOLDS.
 *
 * All four are RATCHETS (rule 13): they record where this pass got to, not
 * where the bar is. Measured over 48 kills, before this pass and after:
 *
 *   EDGE    77.38  ->  4.56     REACH   74.95  ->  1.13
 *   BBOX     4.30  ->  1.39     GROUND  0.216  ->  0.183 m
 *
 * The goals and the remaining diagnosis, so the next person can tell the
 * difference between "fixed" and "less broken":
 *
 * EDGE  goal ~1.2. Everything above that is ONE defect and it is content, not
 *       maths: the torso shell is lofted at 10-15 rows over a metre, so a
 *       single 7 cm quad has to span the whole shoulder-to-chest weight
 *       gradient, and the four-bone skinning limit then drops the clavicle
 *       entirely from the vertex below it. Every worst case in the set is that
 *       quad. It wants rows concentrated at the shoulder, not a new weighting
 *       rule — lowering the bias, raising the row count and Laplacian-smoothing
 *       the weight field were all tried in this pass and all made it worse.
 * REACH goal 1.0, and 1.0 is reachable: the residual is the PBD solver's own
 *       convergence, since `step()` applies cone and contact corrections AFTER
 *       the last distance solve, so the frame the player sees is always one
 *       half-iteration stale. That is inside `src/physics/`.
 * BBOX  goal ~1.15. A corpse with both arms flung out genuinely has a longer
 *       diagonal than a bind-pose box; 1.39 is a sprawl, not a smear.
 * SINK  goal ~0.05. The residual is entirely the BACKPACK: it hangs 0.19 m
 *       behind the spine and the doll has no capsule for it, so a ped who dies
 *       on his back rests his ribs on the road and buries the pack in it. Give
 *       `pack` outfits a rear capsule to close this.
 *
 * Lower these when the work improves. NEVER raise one to make a run go green.
 */
const T = {
  EDGE_RATIO: 4.80,
  REACH_RATIO: 1.15,
  BBOX_RATIO: 1.45,
  SINK: 0.19,
};

/* ------------------------------------------------------------------ */
/* A flat asphalt road, 40 m square, in a real BVH                      */
/* ------------------------------------------------------------------ */

function makeRoad() {
  const w = new StaticWorld();
  const N = 40; // 40x40 quads over 40 m
  const half = 20;
  const tris = new Float32Array(N * N * 2 * 9);
  let o = 0;
  const put = (x0, z0, x1, z1) => {
    tris[o++] = x0; tris[o++] = 0; tris[o++] = z0;
    tris[o++] = x0; tris[o++] = 0; tris[o++] = z1;
    tris[o++] = x1; tris[o++] = 0; tris[o++] = z1;
    tris[o++] = x0; tris[o++] = 0; tris[o++] = z0;
    tris[o++] = x1; tris[o++] = 0; tris[o++] = z1;
    tris[o++] = x1; tris[o++] = 0; tris[o++] = z0;
  };
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      put(-half + i, -half + j, -half + i + 1, -half + j + 1);
    }
  }
  w.addTriangles(tris, N * N * 2, SURFACE.concrete, LAYER.STATIC | LAYER.DEBRIS, 'road');
  w.build();
  return w;
}

/* ------------------------------------------------------------------ */
/* Emitted skinned geometry                                            */
/* ------------------------------------------------------------------ */

/**
 * Exactly what three's skinning shader computes, then the model matrix:
 *
 *   skinned  = bindMatrixInverse * SUM_j w_j * (bone_j.matrixWorld * inv_j) * bindMatrix * p
 *   world    = mesh.matrixWorld * skinned
 *
 * `bindMode` is the default AttachedBindMode, so `bindMatrixInverse` is the
 * mesh's own current world matrix inverted — recomputed every frame by
 * `SkinnedMesh.updateMatrixWorld`. Reproducing the whole chain rather than the
 * simplified form means the probe stays correct if the body pool ever gives the
 * mesh a non-identity local transform.
 */
class SkinReader {
  constructor(mesh, bones, skeleton) {
    this.mesh = mesh;
    this.bones = bones;
    this.skeleton = skeleton;
    this.mats = [];
    for (let i = 0; i < bones.length; i++) this.mats.push(new THREE.Matrix4());
    this._m = new THREE.Matrix4();
    this._out = null;
  }

  /** Refresh the per-bone skinning matrices from the current pose. */
  refresh() {
    const inv = this.skeleton.boneInverses;
    const bindInv = new THREE.Matrix4().copy(this.mesh.matrixWorld).invert();
    const model = this.mesh.matrixWorld;
    for (let i = 0; i < this.bones.length; i++) {
      // model * bindMatrixInverse * boneWorld * boneInverse * bindMatrix
      this.mats[i]
        .copy(model)
        .multiply(bindInv)
        .multiply(this.bones[i].matrixWorld)
        .multiply(inv[i])
        .multiply(this.mesh.bindMatrix);
    }
    return this;
  }

  /** World positions of every vertex, into a reused Float64Array. */
  positions(geometry) {
    const pos = geometry.attributes.position.array;
    const si = geometry.attributes.skinIndex.array;
    const sw = geometry.attributes.skinWeight.array;
    const n = pos.length / 3;
    if (!this._out || this._out.length !== n * 3) this._out = new Float64Array(n * 3);
    const out = this._out;
    const mats = this.mats;
    for (let v = 0; v < n; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      let ox = 0, oy = 0, oz = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw[v * 4 + k];
        if (w === 0) continue;
        const e = mats[si[v * 4 + k]].elements;
        ox += w * (e[0] * x + e[4] * y + e[8] * z + e[12]);
        oy += w * (e[1] * x + e[5] * y + e[9] * z + e[13]);
        oz += w * (e[2] * x + e[6] * y + e[10] * z + e[14]);
      }
      out[v * 3] = ox; out[v * 3 + 1] = oy; out[v * 3 + 2] = oz;
    }
    return out;
  }
}

/** Unique triangle edges of a geometry, with their bind-pose lengths. */
function edgeSet(geometry) {
  const idx = geometry.index.array;
  const pos = geometry.attributes.position.array;
  const seen = new Set();
  const a = [], b = [], len = [];
  const push = (i, j) => {
    const k = i < j ? i * 100000 + j : j * 100000 + i;
    if (seen.has(k)) return;
    seen.add(k);
    const dx = pos[i * 3] - pos[j * 3];
    const dy = pos[i * 3 + 1] - pos[j * 3 + 1];
    const dz = pos[i * 3 + 2] - pos[j * 3 + 2];
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-4) return; // degenerate in bind pose: a ratio against it is noise
    a.push(i); b.push(j); len.push(l);
  };
  for (let t = 0; t < idx.length; t += 3) {
    push(idx[t], idx[t + 1]);
    push(idx[t + 1], idx[t + 2]);
    push(idx[t + 2], idx[t]);
  }
  return { a: Int32Array.from(a), b: Int32Array.from(b), len: Float64Array.from(len) };
}

/** Which authored part a vertex belongs to — for naming a failure. */
function partOf(parts, v) {
  for (const p of parts) if (v >= p.start && v < p.start + p.count) return p.name;
  return '?';
}

/** The bones a vertex is weighted to, heaviest first — for naming a failure. */
function boneNames(geometry, v) {
  const si = geometry.attributes.skinIndex.array;
  const sw = geometry.attributes.skinWeight.array;
  const out = [];
  for (let k = 0; k < 4; k++) if (sw[v * 4 + k] > 0.001) out.push([RIG.names[si[v * 4 + k]], sw[v * 4 + k]]);
  out.sort((a, b) => b[1] - a[1]);
  return out.map(([n, w]) => `${n}:${w.toFixed(2)}`).join(',');
}

/* ------------------------------------------------------------------ */
/* One death                                                           */
/* ------------------------------------------------------------------ */

const DAMAGE = ['pistol', 'rifle', 'shotgun', 'headshot', 'explosion', 'car', 'melee'];

/**
 * Impulses in the same shape and magnitude `Ped._down` produces for each
 * verb — see `ped.js` `die()` (1.4 + amount*0.02, capped 5.5) and
 * `hitByVehicle()` (up to 9.5 x mass ratio, launched upward).
 */
function damageOf(kind, rng, hips, head, scale) {
  const yaw = rng.float() * Math.PI * 2;
  const dir = { x: Math.cos(yaw), y: 0, z: Math.sin(yaw) };
  const at = (y) => ({ x: hips.x + rng.signed() * 0.09, y, z: hips.z + rng.signed() * 0.09 });
  switch (kind) {
    case 'pistol':
      return { point: at(hips.y + 0.30 * scale), imp: mul(dir, 2.2), radius: 0.45, vel: null };
    case 'rifle':
      return { point: at(hips.y + 0.34 * scale), imp: mul(dir, 4.6), radius: 0.45, vel: null };
    case 'shotgun':
      return { point: at(hips.y + 0.22 * scale), imp: mul(dir, 5.5), radius: 0.85, vel: null };
    case 'headshot':
      return { point: { x: head.x, y: head.y, z: head.z }, imp: mul(dir, 5.5), radius: 0.30, vel: null };
    case 'explosion':
      return {
        point: { x: hips.x + dir.x * 1.6, y: 0.15, z: hips.z + dir.z * 1.6 },
        imp: { x: -dir.x * 11, y: 7.5, z: -dir.z * 11 }, radius: 1.6, vel: null,
      };
    case 'car': {
      const speed = rng.range(9, 24);
      const j = Math.min(9.5, 1.6 + speed * 0.42);
      return {
        point: at(hips.y - 0.10 * scale),
        imp: { x: dir.x * j, y: j * 0.55 + speed * 0.06, z: dir.z * j }, radius: 0.85,
        vel: { x: dir.x * speed * 0.5, y: 0, z: dir.z * speed * 0.5 },
      };
    }
    default:
      return { point: at(hips.y + 0.28 * scale), imp: mul(dir, 3.0), radius: 0.35, vel: null };
  }
}
const mul = (d, k) => ({ x: d.x * k, y: d.y * k * 0.18 + k * 0.22, z: d.z * k });

const CLIPS = ['idle', 'walk', 'jog', 'run', 'cower'];

function kill(trial, road, geoCache) {
  const rng = new Rng(0x51dead ^ (trial * 2654435761));
  const shapeId = SHAPE_IDS[rng.u32() % SHAPE_IDS.length];
  let entry = geoCache.get(shapeId);
  if (!entry) {
    const built = buildOutfit(shapeId, { rng: new Rng(0xc0ffee ^ shapeId.length * 977), lod: 0 });
    entry = { geometry: built.geometry, edges: edgeSet(built.geometry), parts: built.parts };
    geoCache.set(shapeId, entry);
  }
  const { geometry, edges } = entry;
  const outfit = makeOutfit(rng, 'street', { shape: shapeId });

  /* --- a live pedestrian, exactly as the body pool assembles one --- */
  const { bones, skeleton, root } = RIG.createSkeleton();
  const group = new THREE.Group();
  const mesh = new THREE.SkinnedMesh(geometry, null);
  group.add(root);
  group.add(mesh);
  mesh.bind(skeleton);
  group.scale.setScalar(outfit.scale);
  group.position.set(rng.range(-6, 6), 0, rng.range(-6, 6));
  group.rotation.y = rng.float() * Math.PI * 2;
  group.updateMatrixWorld(true);

  const an = new PedAnimator(RIG, bones, {
    gait: outfit.gait, height: outfit.height, scale: outfit.scale,
    probe: (x, z, fromY, out) => { out.y = 0; out.nx = 0; out.ny = 1; out.nz = 0; out.hit = true; return true; },
  });
  const clip = CLIPS[rng.u32() % CLIPS.length];
  an.setState({ clip, speed: clip === 'run' ? 4.4 : clip === 'jog' ? 2.7 : clip === 'walk' ? 1.4 : 0 });
  an.blend = 1;
  an.phase = rng.float();
  for (let i = 0; i < 12; i++) an.update(1 / 60, i / 60);
  group.updateMatrixWorld(true);

  const reader = new SkinReader(mesh, bones, skeleton);

  /**
   * The reference for gate 3 is the BIND-POSE bounding box of this outfit's own
   * geometry, scaled — not the standing pose it happened to die from. A ped
   * killed while cowering has a small standing box, and dividing by that would
   * make the same corpse score worse for having been crouched.
   */
  mesh.updateMatrixWorld(true);
  reader.refresh();
  const standing = bboxDiag(geometry.attributes.position.array) * outfit.scale;

  /* --- the bind-pose parent reach, for gate 2 --- */
  const reachRef = [];
  for (let i = 0; i < RIG.count; i++) {
    const p = RIG.parent[i];
    reachRef.push(p < 0 ? 0 : RIG.bindPos[i].distanceTo(RIG.bindPos[p]) * outfit.scale);
  }

  /* --- kill --- */
  const hips = new THREE.Vector3().setFromMatrixPosition(bones[RIG.index('Hips')].matrixWorld);
  const head = new THREE.Vector3().setFromMatrixPosition(bones[RIG.index('Head')].matrixWorld);
  const kind = DAMAGE[trial % DAMAGE.length];
  const dmg = damageOf(kind, rng, hips, head, outfit.scale);

  an.enabled = false;
  const lift = 0.14 * outfit.scale;
  group.position.y += lift;
  group.updateMatrixWorld(true);

  let rd;
  if (LEGACY) {
    // THE SHIPPED PATH — `physics.createRagdollFromSkeleton`, which derives its
    // bone spec by walking parent/child links and welds nothing.
    const { spec, boneMap } = specFromSkeleton(skeleton, {
      mass: 78, radiusRatio: 0.55, cone: 76, twist: 38,
    });
    rd = new Ragdoll(road, { bones: spec, transform: null, gravity: -20.6, iterations: ITERS, mask: MASK.DEBRIS });
    rd.adoptSkeleton(skeleton, boneMap);
  } else {
    rd = buildPedRagdoll({ createRagdoll: (o) => new Ragdoll(road, { ...o, mask: MASK.DEBRIS }) },
      bones, skeleton, { mass: 78, scale: outfit.scale, iterations: ITERS });
  }
  if (dmg.vel) rd.setVelocity(dmg.vel.x, dmg.vel.y, dmg.vel.z);
  rd.applyImpulse(dmg.point.x, dmg.point.y, dmg.point.z, dmg.imp.x, dmg.imp.y, dmg.imp.z, dmg.radius);

  group.position.y -= lift;
  group.updateMatrixWorld(true);

  /* --- simulate and measure the emitted skin --- */
  const worst = {
    edge: 0, edgeAt: -1, reach: 0, reachBone: '', bbox: 0, sink: 0,
    nonFinite: 0, badScale: 0, kind, shapeId, clip,
  };
  const sc = new THREE.Vector3();
  for (let s = 0; s <= SETTLE_STEPS; s++) {
    if (s > 0) {
      rd.step(1 / 120);
      rd.writeToSkeleton();
    }
    if (s % SAMPLE_EVERY) continue;
    mesh.updateMatrixWorld(true);
    reader.refresh();

    // 4 FINITE — on the skinning matrices, which is what the GPU consumes
    for (let i = 0; i < bones.length; i++) {
      const e = reader.mats[i].elements;
      for (let k = 0; k < 16; k++) if (!Number.isFinite(e[k])) worst.nonFinite++;
      bones[i].matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc);
      const mn = Math.min(sc.x, sc.y, sc.z), mx = Math.max(sc.x, sc.y, sc.z);
      if (!(mn > 1e-3) || !(mx < 1e3)) worst.badScale++;
    }

    const P = reader.positions(geometry);

    // 1 EDGE
    for (let e = 0; e < edges.len.length; e++) {
      const i = edges.a[e] * 3, j = edges.b[e] * 3;
      const l = Math.hypot(P[i] - P[j], P[i + 1] - P[j + 1], P[i + 2] - P[j + 2]);
      const r = l / (edges.len[e] * outfit.scale);
      if (r > worst.edge) {
        worst.edge = r;
        worst.edgeAt = s;
        worst.edgeLen = l;
        worst.edgeBind = edges.len[e] * outfit.scale;
        worst.edgeWhere = partOf(entry.parts, edges.a[e]) + '/' + partOf(entry.parts, edges.b[e]);
        worst.edgeBones = boneNames(geometry, edges.a[e]) + ' | ' + boneNames(geometry, edges.b[e]);
      }
    }

    // 2 REACH
    for (let i = 0; i < bones.length; i++) {
      const p = RIG.parent[i];
      if (p < 0 || reachRef[i] < 1e-4) continue;
      const a = bones[i].matrixWorld.elements, b = bones[p].matrixWorld.elements;
      const d = Math.hypot(a[12] - b[12], a[13] - b[13], a[14] - b[14]);
      const r = d / reachRef[i];
      if (r > worst.reach) { worst.reach = r; worst.reachBone = RIG.names[i]; }
    }

    // 3 BBOX + 5 GROUND
    const diag = bboxDiag(P);
    if (diag / standing > worst.bbox) worst.bbox = diag / standing;
    let sink = 0;
    for (let v = 1; v < P.length; v += 3) {
      if (-P[v] > sink) {
        sink = -P[v];
        if (sink > worst.sink) {
          const vi = (v - 1) / 3;
          worst.sinkPart = partOf(entry.parts, vi) + ' [' + boneNames(geometry, vi) + ']';
        }
      }
    }
    if (sink > worst.sink) worst.sink = sink;
    // The settled sink is the one the player looks at for minutes; the
    // transient one is a frame of a body still travelling into the road.
    worst.sinkEnd = sink;
  }
  worst.asleep = rd.sleeping;
  return worst;
}

function bboxDiag(P) {
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    if (P[i] < mnx) mnx = P[i];
    if (P[i] > mxx) mxx = P[i];
    if (P[i + 1] < mny) mny = P[i + 1];
    if (P[i + 1] > mxy) mxy = P[i + 1];
    if (P[i + 2] < mnz) mnz = P[i + 2];
    if (P[i + 2] > mxz) mxz = P[i + 2];
  }
  return Math.hypot(mxx - mnx, mxy - mny, mxz - mnz);
}

/* ------------------------------------------------------------------ */

const road = makeRoad();
const geoCache = new Map();
const rows = [];
const t0 = Date.now();
for (let i = 0; i < KILLS; i++) rows.push(kill(i, road, geoCache));
const ms = Date.now() - t0;

const q = (arr, p) => {
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
};
const edges = rows.map((r) => r.edge);
const reaches = rows.map((r) => r.reach);
const bboxes = rows.map((r) => r.bbox);
const sinks = rows.map((r) => r.sink);
const sinkEnds = rows.map((r) => r.sinkEnd);
const nonFinite = rows.reduce((a, r) => a + r.nonFinite, 0);
const badScale = rows.reduce((a, r) => a + r.badScale, 0);

const worstEdge = rows.reduce((a, r) => (r.edge > a.edge ? r : a));
const worstReach = rows.reduce((a, r) => (r.reach > a.reach ? r : a));

console.log(`\n=== corpseprobe — ${KILLS} kills x ${SETTLE_STEPS} steps${LEGACY ? '  \x1b[31m[LEGACY / NEGATIVE CONTROL]\x1b[0m' : ''} — ${(ms / 1000).toFixed(1)} s ===`);
console.log(`  damage types: ${DAMAGE.join(', ')};  poses: ${CLIPS.join(', ')};  ${geoCache.size} silhouettes`);
console.log('');
console.log(`  1 EDGE   skin edge / bind edge     median ${q(edges, 0.5).toFixed(3)}  p95 ${q(edges, 0.95).toFixed(3)}  WORST ${q(edges, 1).toFixed(3)}   (want <= ${T.EDGE_RATIO})`);
console.log(`  2 REACH  joint gap / bind gap      median ${q(reaches, 0.5).toFixed(3)}  p95 ${q(reaches, 0.95).toFixed(3)}  WORST ${q(reaches, 1).toFixed(3)}   (want <= ${T.REACH_RATIO})`);
console.log(`  3 BBOX   corpse bbox / standing    median ${q(bboxes, 0.5).toFixed(3)}  p95 ${q(bboxes, 0.95).toFixed(3)}  WORST ${q(bboxes, 1).toFixed(3)}   (want <= ${T.BBOX_RATIO})`);
console.log(`  4 FINITE non-finite matrix terms ${nonFinite}, degenerate bone scales ${badScale}   (want 0, 0)`);
console.log(`  5 GROUND deepest vertex below road  settled ${q(sinkEnds, 1).toFixed(3)} m  (want <= ${T.SINK})   any frame ${q(sinks, 1).toFixed(3)} m`);
console.log('');
console.log(`  worst EDGE  : ${worstEdge.edge.toFixed(2)}x  ${worstEdge.shapeId} / ${worstEdge.kind} / ${worstEdge.clip}  at step ${worstEdge.edgeAt}`);
console.log(`                ${(worstEdge.edgeBind * 1000).toFixed(1)} mm -> ${(worstEdge.edgeLen * 1000).toFixed(1)} mm   parts ${worstEdge.edgeWhere}`);
console.log(`                bones ${worstEdge.edgeBones}`);
console.log(`  worst REACH : ${worstReach.reach.toFixed(2)}x on ${worstReach.reachBone}  ${worstReach.shapeId} / ${worstReach.kind}`);
const worstSink = rows.reduce((a, r) => (r.sinkEnd > a.sinkEnd ? r : a));
console.log(`  worst SINK  : ${worstSink.sinkEnd.toFixed(3)} m on part '${worstSink.sinkPart}'  ${worstSink.shapeId} / ${worstSink.kind}`);
const worstBox = rows.reduce((a, r) => (r.bbox > a.bbox ? r : a));
console.log(`  worst BBOX  : ${worstBox.bbox.toFixed(2)}x  ${worstBox.shapeId} / ${worstBox.kind} / ${worstBox.clip}`);
console.log(`  asleep by 5 s: ${rows.filter((r) => r.asleep).length}/${KILLS}`);

if (args.worst) {
  const byKind = new Map();
  for (const r of rows) {
    const c = byKind.get(r.kind) ?? { n: 0, edge: 0, reach: 0, bbox: 0 };
    c.n++;
    c.edge = Math.max(c.edge, r.edge);
    c.reach = Math.max(c.reach, r.reach);
    c.bbox = Math.max(c.bbox, r.bbox);
    byKind.set(r.kind, c);
  }
  console.log('\n  worst per damage type:');
  for (const [k, c] of byKind) {
    console.log(`    ${k.padEnd(10)} n=${String(c.n).padStart(3)}  edge ${c.edge.toFixed(2)}  reach ${c.reach.toFixed(2)}  bbox ${c.bbox.toFixed(2)}`);
  }
}

const bad = [];
if (q(edges, 1) > T.EDGE_RATIO) bad.push(`EDGE ${q(edges, 1).toFixed(2)} > ${T.EDGE_RATIO}`);
if (q(reaches, 1) > T.REACH_RATIO) bad.push(`REACH ${q(reaches, 1).toFixed(2)} > ${T.REACH_RATIO}`);
if (q(bboxes, 1) > T.BBOX_RATIO) bad.push(`BBOX ${q(bboxes, 1).toFixed(2)} > ${T.BBOX_RATIO}`);
if (nonFinite || badScale) bad.push(`FINITE ${nonFinite}/${badScale}`);
if (q(sinkEnds, 1) > T.SINK) bad.push(`GROUND ${q(sinkEnds, 1).toFixed(2)} > ${T.SINK}`);

console.log(bad.length ? `\nFAIL: ${bad.join(', ')}\n` : '\nPASS\n');
process.exit(bad.length ? 1 : 0);
