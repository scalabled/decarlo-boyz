#!/usr/bin/env node
/**
 * STATIC COLLISION PROBE — is the incremental BVH the same collision world as
 * a full rebuild, and how much cheaper is it?
 *
 *   node src/physics/colprobe.mjs              # differential test + benchmark
 *   node src/physics/colprobe.mjs --churn=400  # longer streaming simulation
 *   node src/physics/colprobe.mjs --quiet      # summary lines only
 *
 * WHY THIS EXISTS. `StaticWorld` used to rebuild all 329 000 triangles from
 * scratch whenever one streamed tile changed — 139 ms median, one every 0.58 s
 * standing still. It is now two-level: a per-object subtree built once, plus a
 * small tree over the object boxes rebuilt on every change, plus an in-place
 * refit when a mesh's geometry is rewritten under the same handle.
 *
 * That is exactly the class of change that goes wrong SILENTLY: an object that
 * kept colliding after its tile unloaded, or a subtree that never got stitched
 * in, both look like nothing at all until a player falls through the map.
 *
 * So this drives a stream of add / remove / re-register-in-place operations and
 * after EVERY one compares the incremental world against a reference world
 * built the old flat way from the identical live object set — same rays, same
 * sweeps, same capsule overlaps, to 1e-4 m. A single mismatch fails the run.
 */
import * as THREE from 'three';
import { StaticWorld } from './bvh.js';
import { LAYER, MASK } from './surfaces.js';
import { makeHitRecord } from './math.js';
import { Rng } from '../core/rng.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const CHURN = Number(args.churn ?? 160);
const QUERIES = Number(args.queries ?? 400);
const QUIET = !!args.quiet;

let failures = 0;
let checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`);
  } else if (!QUIET) {
    console.log(`  ok    ${label}${detail ? '  (' + detail + ')' : ''}`);
  }
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/* ------------------------------------------------------------------ */
/* A city-shaped set of collidable meshes                              */
/* ------------------------------------------------------------------ */

const rng = new Rng(0xC0111DE);

/** A tessellated ground patch, the shape `world` streams as terrain. */
function patch(cx, cz, half, step, phase) {
  const n = Math.round((half * 2) / step) + 1;
  const pos = new Float32Array(n * n * 3);
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      idx[k++] = a; idx[k++] = a + n; idx[k++] = a + n + 1;
      idx[k++] = a; idx[k++] = a + n + 1; idx[k++] = a + 1;
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = cx - half + i * step;
      const z = cz - half + j * step;
      const p = (j * n + i) * 3;
      pos[p] = x;
      pos[p + 1] = Math.sin(x * 0.04 + phase) * 2.2 + Math.cos(z * 0.031 - phase) * 1.7;
      pos[p + 2] = z;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ name: 'asphalt' }));
  m.name = `patch_${cx}_${cz}`;
  m.updateWorldMatrix(true, false);
  return m;
}

/** Rewrite a patch's vertices in place — what `world` does to its terrain
 *  collider every 48 m: same THREE.Mesh, same triangle count, new positions. */
function slidePatch(mesh, cx, cz, half, step, phase) {
  const n = Math.round((half * 2) / step) + 1;
  const arr = mesh.geometry.getAttribute('position').array;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = cx - half + i * step;
      const z = cz - half + j * step;
      const p = (j * n + i) * 3;
      arr[p] = x;
      arr[p + 1] = Math.sin(x * 0.04 + phase) * 2.2 + Math.cos(z * 0.031 - phase) * 1.7;
      arr[p + 2] = z;
    }
  }
  mesh.geometry.getAttribute('position').needsUpdate = true;
  return mesh;
}

/** A block of buildings — the shape `buildings` registers per tile. */
function blockMesh(cx, cz, r) {
  const grp = new THREE.Group();
  const count = 3 + (r.int ? r.int(4) : Math.floor(r.float() * 4));
  for (let i = 0; i < count; i++) {
    const w = 4 + r.float() * 10;
    const h = 6 + r.float() * 24;
    const d = 4 + r.float() * 10;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ name: 'concrete' }));
    b.position.set(cx + r.signed() * 22, h * 0.5, cz + r.signed() * 22);
    b.name = 'wall_concrete';
    grp.add(b);
  }
  grp.updateMatrixWorld(true);
  const merged = [];
  grp.traverse((o) => { if (o.isMesh) merged.push(o); });
  return merged;
}

/* ------------------------------------------------------------------ */
/* Two worlds, identical contents                                      */
/* ------------------------------------------------------------------ */

/**
 * Mirrors every registration into an incremental world and a flat one, so the
 * flat world is a live oracle rather than a remembered number.
 */
class Mirror {
  constructor() {
    this.inc = new StaticWorld();
    this.ref = new StaticWorld();
    this.inc.flat = false;
    this.ref.flat = true;
    this.handles = new Map(); // key -> { a, b, mesh }
  }

  add(key, mesh, surface, mask = LAYER.STATIC) {
    const a = this.inc.addMesh(mesh, surface, mask);
    const b = this.ref.addMesh(mesh, surface, mask);
    if (a >= 0) this.handles.set(key, { a, b, mesh });
    return a >= 0;
  }

  remove(key) {
    const h = this.handles.get(key);
    if (!h) return false;
    this.inc.removeObject(h.a);
    this.ref.removeObject(h.b);
    this.handles.delete(key);
    return true;
  }

  build() {
    this.inc.build();
    this.ref.build();
  }
}

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

const hitA = makeHitRecord();
const hitB = makeHitRecord();
const TOL = 1e-4;

/** Every query path, over the same random probes in both worlds. */
function compare(m, r, n, tag) {
  const { inc, ref } = m;
  let rayMismatch = 0, anyMismatch = 0, sweepMismatch = 0, overlapMismatch = 0;
  let worstT = 0, worstSweep = 0;
  let rayHits = 0, sweepHits = 0, overlapHits = 0;
  const MASKS = [MASK.WORLD, MASK.BULLET, MASK.CHARACTER, MASK.DEBRIS];

  for (let i = 0; i < n; i++) {
    const mask = MASKS[i % MASKS.length];
    const ox = r.range(-260, 260);
    const oz = r.range(-260, 260);
    const oy = r.range(-4, 90);
    let dx = r.signed(), dy = r.signed() - 0.55, dz = r.signed();
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;

    const a = inc.raycast(ox, oy, oz, dx, dy, dz, 400, mask, hitA);
    const b = ref.raycast(ox, oy, oz, dx, dy, dz, 400, mask, hitB);
    if (a !== b) rayMismatch++;
    else if (a) {
      rayHits++;
      const dt = Math.abs(hitA.t - hitB.t);
      if (dt > worstT) worstT = dt;
      if (dt > TOL) rayMismatch++;
      else if (hitA.surface !== hitB.surface) rayMismatch++;
      else if (Math.abs(hitA.nx - hitB.nx) + Math.abs(hitA.ny - hitB.ny) + Math.abs(hitA.nz - hitB.nz) > 1e-3) {
        rayMismatch++;
      }
    }

    if (inc.raycastAny(ox, oy, oz, dx, dy, dz, 400, mask) !== ref.raycastAny(ox, oy, oz, dx, dy, dz, 400, mask)) {
      anyMismatch++;
    }

    // Swept capsule: the character-controller path, triangles only.
    const px = r.range(-260, 260), pz = r.range(-260, 260), py = r.range(-2, 40);
    const sa = inc.sweepCapsule(px, py, pz, px, py + 1.2, pz, 0.35, 0, -1, 0, 60, mask, hitA);
    const sb = ref.sweepCapsule(px, py, pz, px, py + 1.2, pz, 0.35, 0, -1, 0, 60, mask, hitB);
    if (sa !== sb) sweepMismatch++;
    else if (sa) {
      sweepHits++;
      const dt = Math.abs(hitA.t - hitB.t);
      if (dt > worstSweep) worstSweep = dt;
      if (dt > TOL) sweepMismatch++;
    }

    // Resting overlap: the penetration path.
    const ca = inc.overlapCapsule(px, py, pz, px, py + 1.2, pz, 0.6, mask, 0);
    const cb = ref.overlapCapsule(px, py, pz, px, py + 1.2, pz, 0.6, mask, 0);
    if (ca !== cb) overlapMismatch++;
    else if (ca > 0) {
      overlapHits++;
      let da = 0, db = 0;
      for (let k = 0; k < ca; k++) da = Math.max(da, inc.contacts.depth[k]);
      for (let k = 0; k < cb; k++) db = Math.max(db, ref.contacts.depth[k]);
      if (Math.abs(da - db) > TOL) overlapMismatch++;
    }
  }

  const bad = rayMismatch + anyMismatch + sweepMismatch + overlapMismatch;
  return {
    bad, rayMismatch, anyMismatch, sweepMismatch, overlapMismatch,
    worstT, worstSweep, rayHits, sweepHits, overlapHits, tag,
  };
}

/* ------------------------------------------------------------------ */

section('Build parity — same triangles, same tree answers');
const m = new Mirror();
const meshes = new Map();

// A resident city: a coarse always-on shell plus a ring of streamed content.
const shell = patch(0, 0, 300, 25, 0);
shell.name = 'ground_net';
m.add('shell', shell, 'dirt', LAYER.CLIP);
meshes.set('shell', shell);

for (let tz = -2; tz <= 2; tz++) {
  for (let tx = -2; tx <= 2; tx++) {
    const key = `road_${tx}_${tz}`;
    const p = patch(tx * 110, tz * 110, 55, 5, tx + tz);
    m.add(key, p, 'asphalt');
    meshes.set(key, p);
    const bs = blockMesh(tx * 110, tz * 110, rng);
    bs.forEach((b, i) => {
      const bk = `bld_${tx}_${tz}_${i}`;
      m.add(bk, b, undefined);
      meshes.set(bk, b);
    });
  }
}
// The terrain patch that slides with the camera.
const terrain = patch(0, 0, 160, 8, 0.5);
terrain.name = 'terrain_collider';
m.add('terrain', terrain, 'dirt');
meshes.set('terrain', terrain);

m.build();
ok(m.inc.triCount === m.ref.triCount, 'both worlds hold the same triangle count',
  `${m.inc.triCount} vs ${m.ref.triCount}`);
ok(m.inc.rootNode >= 0 && m.ref.rootNode >= 0, 'both worlds published a root');
{
  const c = compare(m, rng.fork(), QUERIES, 'initial');
  ok(c.bad === 0, 'every query agrees with a full rebuild',
    `${c.rayHits} ray / ${c.sweepHits} sweep / ${c.overlapHits} overlap hits, ` +
    `worst dt ${c.worstT.toExponential(1)} m`);
  ok(c.rayHits > QUERIES * 0.3, 'the probe set actually hits things', `${c.rayHits}/${QUERIES}`);
}

/* ---------------- streaming churn ---------------- */
section('Streaming churn — add, drop, re-register in place');
{
  const r = rng.fork();
  let worst = { bad: 0 };
  let terrainSlides = 0;
  let adds = 0, drops = 0;
  const live = [...m.handles.keys()].filter((k) => k.startsWith('road_'));
  let nextId = 1000;

  for (let step = 0; step < CHURN; step++) {
    const roll = r.float();
    if (roll < 0.34 || live.length < 4) {
      // Stream a tile in.
      const key = `road_new_${nextId++}`;
      const p = patch(r.range(-280, 280), r.range(-280, 280), 40 + r.float() * 30, 5, r.float() * 6);
      m.add(key, p, 'asphalt');
      meshes.set(key, p);
      live.push(key);
      adds++;
    } else if (roll < 0.68) {
      // Stream a tile out.
      const i = Math.floor(r.float() * live.length) % live.length;
      const key = live[i];
      live.splice(i, 1);
      m.remove(key);
      meshes.delete(key);
      drops++;
    } else {
      // The terrain collider slides: SAME mesh, rewritten geometry, removed
      // and re-added under a new handle. This is the in-place refit path.
      m.remove('terrain');
      slidePatch(terrain, r.range(-120, 120), r.range(-120, 120), 160, 8, r.float() * 6);
      m.add('terrain', terrain, 'dirt');
      terrainSlides++;
    }
    m.build();
    if (m.inc.triCount !== m.ref.triCount) {
      ok(false, `triangle count diverged at churn step ${step}`,
        `${m.inc.triCount} vs ${m.ref.triCount}`);
      break;
    }
    const c = compare(m, r, 40, `churn ${step}`);
    if (c.bad > worst.bad) worst = c;
  }
  ok(worst.bad === 0, 'every query still agrees after full streaming churn',
    `${CHURN} steps: ${adds} adds, ${drops} drops, ${terrainSlides} in-place slides`);
  ok(m.inc.buildStats.refits > 0, 'the in-place refit path was exercised',
    `${m.inc.buildStats.refits} refits`);
  ok(m.inc.truncations.tlas === 0, 'no TLAS leaf ever held more than one object');
  ok(m.inc.truncations.traversal === 0, 'no traversal was abandoned');
}

/* ---------------- stale geometry ---------------- */
section('Stale geometry — nothing collides after its tile is gone');
{
  // A wall somewhere nothing else reaches, so a hit can only be this object.
  const far = new THREE.Mesh(new THREE.BoxGeometry(4, 20, 40), new THREE.MeshBasicMaterial({ name: 'metal' }));
  far.position.set(900, 10, 900);
  far.name = 'wall_metal';
  far.updateWorldMatrix(true, false);
  m.add('far', far, 'metal');
  m.build();
  const seen = m.inc.raycast(880, 10, 900, 1, 0, 0, 60, MASK.BULLET, hitA);
  ok(seen, 'the new wall collides once it is registered');
  const triBefore = m.inc.triCount;

  m.remove('far');
  m.build();
  const still = m.inc.raycast(880, 10, 900, 1, 0, 0, 60, MASK.BULLET, hitA);
  ok(!still, 'and stops the instant its handle is removed');
  ok(m.inc.triCount < triBefore, 'its triangles left the world',
    `${triBefore} -> ${m.inc.triCount}`);

  // Reload the same region: the freed slots get reused, and the new geometry
  // must be the thing that answers — not a ghost of the old one.
  const far2 = new THREE.Mesh(new THREE.BoxGeometry(4, 20, 40), new THREE.MeshBasicMaterial({ name: 'wood' }));
  far2.position.set(900, 10, 940);
  far2.name = 'wall_wood';
  far2.updateWorldMatrix(true, false);
  m.add('far2', far2, 'wood');
  m.build();
  const gone = m.inc.raycast(880, 10, 900, 1, 0, 0, 60, MASK.BULLET, hitA);
  const there = m.inc.raycast(880, 10, 940, 1, 0, 0, 60, MASK.BULLET, hitB);
  ok(!gone, 'the unloaded tile stays gone after a reload cycle');
  ok(there, 'and the reloaded tile collides at its new position');
  const c = compare(m, rng.fork(), QUERIES, 'reload');
  ok(c.bad === 0, 'the world still matches a full rebuild after unload/reload');
  m.remove('far2');
  m.build();
}

/* ---------------- LAYER.CLIP ---------------- */
section('LAYER.CLIP is unchanged');
{
  // Isolated: a CLIP shell under a small STATIC island, so an answer can only
  // have come from one of the two. CLIP is in MASK.CHARACTER and MASK.DEBRIS
  // and in neither MASK.WORLD nor MASK.BULLET (ARCHITECTURE.md).
  const c = new Mirror();
  const clip = patch(0, 0, 400, 25, 0);
  clip.name = 'ground_net';
  c.add('clip', clip, 'dirt', LAYER.CLIP);
  const island = patch(0, 0, 30, 5, 3);
  island.name = 'island_asphalt';
  c.add('island', island, 'asphalt', LAYER.STATIC);
  c.build();

  const probe = (w, x, z) => ({
    bullet: w.raycast(x, 400, z, 0, -1, 0, 900, MASK.BULLET, hitA),
    world: w.raycast(x, 400, z, 0, -1, 0, 900, MASK.WORLD, hitB),
    chr: w.sweepCapsule(x, 60, z, x, 61.2, z, 0.35, 0, -1, 0, 200, MASK.CHARACTER, hitA),
    dbr: w.sweepCapsule(x, 60, z, x, 61.2, z, 0.35, 0, -1, 0, 200, MASK.DEBRIS, hitB),
  });

  const out = probe(c.inc, 260, -271);   // only the CLIP shell is here
  ok(!out.bullet, 'MASK.BULLET does not see the CLIP shell');
  ok(!out.world, 'MASK.WORLD does not see the CLIP shell');
  ok(out.chr, 'MASK.CHARACTER lands on it');
  ok(out.dbr, 'MASK.DEBRIS lands on it');

  const on = probe(c.inc, 3, -4);        // STATIC island over the shell
  ok(on.bullet && on.world, 'real STATIC geometry still answers WORLD and BULLET');

  // Masks are a per-triangle property; a two-level tree must not disturb them.
  const rf = probe(c.ref, 260, -271);
  const rn = probe(c.ref, 3, -4);
  ok(rf.bullet === out.bullet && rf.world === out.world && rf.chr === out.chr && rf.dbr === out.dbr &&
     rn.bullet === on.bullet && rn.world === on.world,
    'the flat reference gives byte-for-byte the same mask answers');

  // And every mask agrees over a whole random probe set, not just two points.
  const cc = compare(c, rng.fork(), QUERIES, 'clip');
  ok(cc.bad === 0, 'all four masks agree with a full rebuild across the probe set');
}

/* ---------------- cost ---------------- */
section('Cost of one streamed change');
{
  // Both arms in the same process, interleaved, on the same operations —
  // the machine's load cancels out of the ratio.
  const r = rng.fork();
  const inc = m.inc, ref = m.ref;
  const incMs = [], refMs = [];
  let incTris = 0, refTris = 0;
  const keys = [];
  for (let i = 0; i < 40; i++) {
    const key = `bench_${i}`;
    const p = patch(r.range(-280, 280), r.range(-280, 280), 45, 5, r.float() * 6);
    m.add(key, p, 'asphalt');
    keys.push(key);
  }
  m.build();

  for (let i = 0; i < 40; i++) {
    // One tile out, one tile in — a single streaming event.
    m.remove(keys[i]);
    const key = `bench_r_${i}`;
    m.add(key, patch(r.range(-280, 280), r.range(-280, 280), 45, 5, r.float() * 6), 'asphalt');
    keys[i] = key;

    const t0 = performance.now();
    inc.build();
    incMs.push(performance.now() - t0);
    incTris += inc.buildStats.lastTris;

    const t1 = performance.now();
    ref.build();
    refMs.push(performance.now() - t1);
    refTris += ref.buildStats.lastTris;
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  console.log(
    `  resident: ${inc.triCount} triangles, ${inc.objectCount} objects, ${inc.partCount} subtrees\n` +
    `  incremental : median ${med(incMs).toFixed(2)} ms  max ${Math.max(...incMs).toFixed(2)} ms  ` +
    `total ${sum(incMs).toFixed(0)} ms  ${(incTris / 1000).toFixed(0)}k triangles processed\n` +
    `  flat rebuild: median ${med(refMs).toFixed(2)} ms  max ${Math.max(...refMs).toFixed(2)} ms  ` +
    `total ${sum(refMs).toFixed(0)} ms  ${(refTris / 1000).toFixed(0)}k triangles processed`
  );
  ok(med(incMs) < med(refMs) * 0.25, 'a streamed change costs under a quarter of a full rebuild',
    `${med(incMs).toFixed(2)} ms vs ${med(refMs).toFixed(2)} ms`);
  ok(incTris < refTris * 0.2, 'and processes a fraction of the triangles',
    `${(incTris / 1000).toFixed(0)}k vs ${(refTris / 1000).toFixed(0)}k`);
  ok(inc.buildStats.compactions === 0, 'the arena never had to compact',
    `${inc.buildStats.compactions}`);
}

/* ---------------- coalescing ---------------- */
section('Coalescing — many asks, one rebuild');
{
  const inc = m.inc;
  const before = inc.buildStats.builds;
  const skipped0 = inc.buildStats.skipped;
  inc.build(); inc.build(); inc.build(); inc.build();
  ok(inc.buildStats.builds === before, 'a build with nothing dirty does no work',
    `${inc.buildStats.skipped - skipped0} calls skipped`);
  const p = patch(500, 500, 30, 5, 1);
  m.add('coalesce', p, 'asphalt');
  inc.build();
  inc.build();
  inc.build();
  ok(inc.buildStats.builds === before + 1, 'one change plus three asks is one rebuild');
}

/* ---------------- amortisation ---------------- */
section('Amortisation — a budget splits the work, never the geometry');
{
  // A hard budget with several large tiles arriving at once. The invariants:
  // every build respects the ceiling, an object is either fully collidable or
  // not in the tree at all, and the queue drains.
  const a = new Mirror();
  const base = patch(0, 0, 200, 10, 0);
  a.add('base', base, 'dirt');
  a.build();

  a.inc.budgetMs = 2;
  const wall = new THREE.Mesh(new THREE.BoxGeometry(3, 18, 60), new THREE.MeshBasicMaterial({ name: 'metal' }));
  wall.position.set(700, 9, 0);
  wall.name = 'wall_metal';
  wall.updateWorldMatrix(true, false);
  const big = [];
  for (let i = 0; i < 6; i++) {
    const p = patch(600 + i * 90, 400, 70, 3, i);   // ~2100 triangles each
    a.add(`big_${i}`, p, 'asphalt');
    big.push(p);
  }
  a.add('wall', wall, 'metal');

  let calls = 0;
  let overBudget = 0;
  let worstMs = 0;
  let partial = 0;
  while (a.inc.dirty && calls < 200) {
    const t0 = performance.now();
    a.inc.build();
    const ms = performance.now() - t0;
    calls++;
    worstMs = Math.max(worstMs, ms);
    // The ceiling is per NEW-object work, plus whatever the last part and the
    // TLAS cost; allow generous slack and only fail on a runaway.
    if (ms > a.inc.budgetMs * 6) overBudget++;
    // Anything published must be whole: if the wall is in the tree at all,
    // both of its faces must answer.
    const front = a.inc.raycast(660, 9, 0, 1, 0, 0, 80, MASK.BULLET, hitA);
    const back = a.inc.raycast(740, 9, 0, -1, 0, 0, 80, MASK.BULLET, hitB);
    if (front !== back) partial++;
  }
  a.ref.build();

  ok(calls > 1, 'the budget actually split the work across calls', `${calls} calls`);
  ok(overBudget === 0, 'no call ran away past the budget', `worst ${worstMs.toFixed(2)} ms`);
  ok(partial === 0, 'no object was ever half-published');
  ok(!a.inc.dirty, 'and the queue drained');
  ok(a.inc.buildStats.deferrals > 0, 'the deferral path was exercised',
    `${a.inc.buildStats.deferrals}`);
  ok(a.inc.triCount === a.ref.triCount, 'ending up with the same world as a full rebuild',
    `${a.inc.triCount} vs ${a.ref.triCount}`);
  const c = compare(a, rng.fork(), QUERIES, 'budget');
  ok(c.bad === 0, 'and the same answers');

  // A world with NO collision at all must never be left that way by a budget:
  // that is the "spawned and dropped through the floor" failure.
  const boot = new StaticWorld();
  boot.budgetMs = 0.001;
  for (let i = 0; i < 4; i++) boot.addMesh(patch(i * 120, 0, 60, 4, i), 'dirt', LAYER.STATIC);
  boot.build();
  ok(boot.triCount > 0 && boot.rootNode >= 0,
    'the first build ignores the budget rather than shipping an empty world',
    `${boot.triCount} triangles after one call`);
}

console.log(`\n${failures === 0 ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m  ${checks - failures}/${checks} checks`);
process.exitCode = failures === 0 ? 0 : 1;
