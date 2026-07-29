#!/usr/bin/env node
/**
 * COVER PROBE — can you take cover from a mission goon?
 *
 *   node src/peds/coverprobe.mjs
 *   node src/peds/coverprobe.mjs --legacy      THE NEGATIVE CONTROL
 *   node src/peds/coverprobe.mjs --sites=3 --seconds=14
 *   node src/peds/coverprobe.mjs --json
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS REPRODUCES
 * ────────────────────────────────────────────────────────────────────────────
 * Put a building between yourself and a mission goon — the reflex move when
 * taking fire — and he came THROUGH it: in at the near wall, across the hollow
 * interior, and metres into the air clambering over the far wall before
 * dropping back to the street. `src/game/hostiles.js` had physics HITBOXES and
 * no physics BODY; nothing in it matched `collid|building|nav|obstacle`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * RULE 12 — WHY THE FOOTPRINT IS RASTERISED OFF THE DRAWN MESH
 * ────────────────────────────────────────────────────────────────────────────
 * The obvious containment test is to ask `physics` whether a capsule fits where
 * the goon is standing. That is the mistake this project has shipped green
 * gates for over and over: the fix RESOLVES against the physics triangle soup,
 * so a probe that also consults the physics triangle soup can only ever confirm
 * that the two agree with each other. A building whose collision shell was
 * never emitted would be invisible to both, and the gate would print PASS over
 * a goon walking through a wall the player can see.
 *
 * So the footprint comes from the OTHER producer entirely: every triangle of
 * the BUILDINGS SCENE GRAPH — merged meshes and `InstancedMesh` alike, in world
 * space, including per-instance transforms — is rasterised into a 0.5 m grid,
 * and a cell counts as inside the building only where BOTH
 *
 *   - it is enclosed by geometry standing in the band a man occupies
 *     (gy+0.4 .. gy+2.4) — i.e. there are walls round it, and
 *   - something reaching above gy+3 covers it — i.e. there is massing over it,
 *
 * then eroded 1.5 m for the slack a facade carries. Each half alone has a
 * failure mode this probe measured on real streets; see the note above the
 * grids. The result is the building the player LOOKS at, computed with nothing
 * but `three` geometry and a scanline fill, true whether or not anybody
 * remembered to give it a collider.
 *
 * The path is read the same way: from `mesh.matrixWorld` of the body the
 * renderer draws, not from the AI's `position` field.
 *
 * The ground band is measured against `world.walkableHeightAt` — the analytic
 * street surface, the contract the rest of the engine consumes — so "three
 * metres in the air over the far wall" is a number and not an impression.
 *
 * PHYSICS IS USED IN EXACTLY ONE PLACE, AND IT IS NOT AN ASSERTION: choosing
 * the site. The gate needs a KNOWN-SOLID building, and the only way to know
 * a building is solid is to ask the collider — so a candidate is accepted only
 * if a man-sized capsule swept inward on SIXTEEN bearings is stopped, every
 * time, within 3 m of where the drawn footprint begins. That matters here more
 * than it sounds: of ~60 crossings examined in one run, 42 were rejected, some
 * of them 31 m buildings with a roof at 16.6 m and NO COLLISION SHELL AT ALL,
 * which the player also walks through. Those are holes in the city owned by
 * `src/buildings`, and a gate for `src/peds` must route around them rather than
 * sit permanently red because of them.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FIVE ASSERTIONS
 * ────────────────────────────────────────────────────────────────────────────
 *   0 SITE      the site survives re-validation on the exact footprint the
 *               assertions read: ≥ 40 m² of drawn massing, both ends clear of
 *               it, the midpoint inside it, sight blocked, a capsule stopped.
 *   1 CONTAINED not one sampled frame of the goon's drawn position lies inside
 *               the footprint. THE DEFECT, inverted.
 *   2 GROUNDED  his height above the walkable surface never leaves
 *               [-1.0, +2.0] m. This is the "3 m in the air over the far wall"
 *               half, and it fails independently of gate 1.
 *   3 CHASES    he still closes on the player — he goes AROUND. A goon frozen
 *               at his spawn would score full marks on 1 and 2, so without this
 *               the cheapest way to pass is to break the feature.
 *   4 DROPS     the 28% kill drop exists:
 *               over N staged mission kills the observed rate is within a
 *               binomial band of 0.28 and the drops are health and ammo.
 *
 * `--legacy` restores the old integrator on the live hostiles — the two lines
 * `game/hostiles.js` shipped, `position += dir * speed * dt` and a downward
 * raycast for the floor — and changes nothing else. Gates 1 and 2 must go red,
 * and the run exits 0 only if they do.
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const JSON_OUT = !!args.json;
const LEGACY = !!args.legacy;
const SECONDS = Number(args.seconds ?? 12);
const WANT_SITES = Number(args.sites ?? 2);
const KILLS = Number(args.kills ?? 400);

const log = (...a) => { if (!JSON_OUT) console.log(...a); };
const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') });
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail ?? ''}`);
};

/* ---- the ground band, in metres above `world.walkableHeightAt` ---------- */
const BAND_LO = -1.0;
const BAND_HI = 2.0;
/** Grid resolution of the drawn footprint, metres. */
const CELL = 0.5;
/** Anything whose lowest vertex is above this off the ground is massing. */
const MASSING_Y = 3.0;

/* ==================================================================== */
/* page-side helpers, as source strings                                  */
/* ==================================================================== */

/**
 * Rasterise the DRAWN building massing into an occupancy grid, then flood-fill
 * the outside. `__FOOT__.inside(x, z)` is then a pure geometric predicate over
 * the mesh the player is looking at.
 */
const BUILD_FOOTPRINT = `
const THREE = window.__THREE__;
const w = ctx.peek('world');
const cx = ARG.cx, cz = ARG.cz, R = ARG.r, CELL = ARG.cell;
const N = Math.ceil((R * 2) / CELL) + 1;
const ox = cx - R, oz = cz - R;
const occ = new Uint8Array(N * N);
const root = ctx.peek('buildings')?.root;
if (!root) return { ok: false, why: 'no buildings root' };

// Coarse ground field, so the massing cut follows a street that climbs a
// hillside instead of drifting off it. 4 m is finer than any grade this city
// has over the width of one lot.
const GN = Math.ceil((R * 2) / 4) + 2;
const ground = new Float32Array(GN * GN);
for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
  const y = w.walkableHeightAt(ox + i * 4, oz + j * 4);
  ground[j * GN + i] = Number.isFinite(y) ? y : 0;
}
const groundAt = (x, z) => {
  const i = Math.max(0, Math.min(GN - 1, Math.round((x - ox) / 4)));
  const j = Math.max(0, Math.min(GN - 1, Math.round((z - oz) / 4)));
  return ground[j * GN + i];
};

/**
 * TWO GRIDS, AND THE FOOTPRINT IS THEIR INTERSECTION.
 *
 *   low   drawn geometry in the band a MAN occupies, gy+0.4 .. gy+2.4 — the
 *         walls. A building's walls close a ring in plan; a viaduct's piers do
 *         not.
 *   high  anything reaching above gy+3 — the massing, walls and roof alike.
 *
 * inside = enclosed by low AND covered by high. Each half alone has a
 * failure mode this probe MEASURED and neither is hypothetical:
 *
 *   high alone   reports a man walking UNDER AN OVERPASS as being inside a
 *                building. Measured at THE STRIP: 507 of 720 frames flagged,
 *                every one of them on tarmac at ground level.
 *   low alone    a 55 m patch clips the streets inside a city block, so the
 *                outside fill cannot reach them from the border and a whole
 *                carriageway reads as enclosed. Measured: 1130 m².
 *
 * The intersection has neither: a street has no roof, and a viaduct has no
 * walls. It also drops the roof OVERHANG, which is what a goon rounding a
 * corner with his shoulder to the wall was clipping.
 */
const low = new Uint8Array(N * N);
const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
const m = new THREE.Matrix4();
let tris = 0;
let target = occ;

const put = (i, j) => {
  if (i < 0 || j < 0 || i >= N || j >= N) return;
  target[j * N + i] = 1;
};

/**
 * SUPERCOVER A SEGMENT. A wall is one triangle THIN in XZ, so the interior
 * fill below cannot see it at all; walking its edges at half a cell is what
 * makes the outline watertight, which is the whole basis of the flood fill.
 */
const edge = (x0, z0, x1, z1) => {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    put(Math.floor((x0 + (x1 - x0) * t - ox) / CELL),
        Math.floor((z0 + (z1 - z0) * t - oz) / CELL));
  }
};

/** Fill: every cell CENTRE inside the XZ projection of the triangle. */
const fill = (ax, az, bx, bz, cxx, czz) => {
  let i0 = Math.floor((Math.min(ax, bx, cxx) - ox) / CELL);
  let i1 = Math.ceil((Math.max(ax, bx, cxx) - ox) / CELL);
  let j0 = Math.floor((Math.min(az, bz, czz) - oz) / CELL);
  let j1 = Math.ceil((Math.max(az, bz, czz) - oz) / CELL);
  if (i1 < 0 || j1 < 0 || i0 >= N || j0 >= N) return;
  i0 = Math.max(0, i0); j0 = Math.max(0, j0);
  i1 = Math.min(N - 1, i1); j1 = Math.min(N - 1, j1);
  const d = (bz - czz) * (ax - cxx) + (cxx - bx) * (az - czz);
  if (Math.abs(d) < 1e-9) return;                 // degenerate in plan: edges did it
  const inv = 1 / d;
  for (let j = j0; j <= j1; j++) {
    const pz = oz + (j + 0.5) * CELL;
    for (let i = i0; i <= i1; i++) {
      const px = ox + (i + 0.5) * CELL;
      const l1 = ((bz - czz) * (px - cxx) + (cxx - bx) * (pz - czz)) * inv;
      if (l1 < 0 || l1 > 1) continue;
      const l2 = ((czz - az) * (px - cxx) + (ax - cxx) * (pz - czz)) * inv;
      if (l2 < 0 || l1 + l2 > 1) continue;
      target[j * N + i] = 1;
    }
  }
};

const rasterise = () => {
  edge(a.x, a.z, b.x, b.z);
  edge(b.x, b.z, c.x, c.z);
  edge(c.x, c.z, a.x, a.z);
  fill(a.x, a.z, b.x, b.z, c.x, c.z);
};

const eat = (geo, mat4) => {
  const pos = geo.attributes?.position;
  if (!pos) return;
  const idx = geo.index;
  const n = idx ? idx.count : pos.count;
  for (let t = 0; t + 2 < n; t += 3) {
    const ia = idx ? idx.getX(t) : t;
    const ib = idx ? idx.getX(t + 1) : t + 1;
    const ic = idx ? idx.getX(t + 2) : t + 2;
    a.fromBufferAttribute(pos, ia).applyMatrix4(mat4);
    b.fromBufferAttribute(pos, ib).applyMatrix4(mat4);
    c.fromBufferAttribute(pos, ic).applyMatrix4(mat4);
    if (Math.max(a.x, b.x, c.x) < ox || Math.min(a.x, b.x, c.x) > ox + R * 2) continue;
    if (Math.max(a.z, b.z, c.z) < oz || Math.min(a.z, b.z, c.z) > oz + R * 2) continue;
    const gy = groundAt((a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3);
    const yLo = Math.min(a.y, b.y, c.y);
    const yHi = Math.max(a.y, b.y, c.y);
    let used = false;
    if (yHi > gy + 0.4 && yLo < gy + 2.4) { target = low; rasterise(); used = true; }
    if (yHi > gy + ARG.massingY) { target = occ; rasterise(); used = true; }
    if (used) tris++;
  }
};

root.updateMatrixWorld(true);
const shown = (o) => {
  for (let p = o; p && p !== root.parent; p = p.parent) if (p.visible === false) return false;
  return true;
};
root.traverse((o) => {
  if (!o.isMesh && !o.isInstancedMesh) return;
  if (!shown(o)) return;
  const g = o.geometry;
  if (!g) return;
  if (o.isInstancedMesh) {
    for (let k = 0; k < o.count; k++) {
      o.getMatrixAt(k, m);
      m.premultiply(o.matrixWorld);
      eat(g, m);
    }
  } else {
    eat(g, o.matrixWorld);
  }
});

// Flood the OUTSIDE of the WALL outlines from the border.
const outLow = new Uint8Array(N * N);
const stack = [];
for (let i = 0; i < N; i++) {
  for (const k of [i, (N - 1) * N + i, i * N, i * N + N - 1]) {
    if (!low[k] && !outLow[k]) { outLow[k] = 1; stack.push(k); }
  }
}
while (stack.length) {
  const k = stack.pop();
  const i = k % N, j = (k / N) | 0;
  if (i > 0 && !low[k - 1] && !outLow[k - 1]) { outLow[k - 1] = 1; stack.push(k - 1); }
  if (i < N - 1 && !low[k + 1] && !outLow[k + 1]) { outLow[k + 1] = 1; stack.push(k + 1); }
  if (j > 0 && !low[k - N] && !outLow[k - N]) { outLow[k - N] = 1; stack.push(k - N); }
  if (j < N - 1 && !low[k + N] && !outLow[k + N]) { outLow[k + N] = 1; stack.push(k + N); }
}

const solid = new Uint8Array(N * N);
let area = 0;
for (let k = 0; k < N * N; k++) {
  if (!outLow[k] && occ[k]) { solid[k] = 1; area++; }
}

/**
 * ERODE 1.5 m, AND THE NUMBER IS EARNED.
 *
 * Three sources of slack stack up at a facade, all of them pushing the grid
 * OUTWARD from the surface the player sees:
 *   - the edge supercover stamps the cell a sample lands in, so a wall running
 *     diagonally is a staircase one to two cells thick;
 *   - a wall is drawn as two surfaces, inner and outer;
 *   - the goon is a 0.34 m capsule whose CENTRE is what gets sampled, so he can
 *     legitimately stand a third of a metre inside the drawn outer face.
 * Measured without enough of it: a goon who was correctly STOPPED by a wall and
 * slid along it was reported inside the building for 670 of 720 frames.
 *
 * 1.5 m is comfortably past all three and still far less than any building this
 * probe will accept — so a flagged frame means he is in the ROOM, not on the
 * pavement outside it. Erring outward can only make the gate more forgiving,
 * which is the right direction for a margin whose job is to keep a PASS honest.
 */
let strict = solid;
for (let pass = 0; pass < 3; pass++) {
  const next = new Uint8Array(N * N);
  const src = strict;
  for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
    const k = j * N + i;
    if (src[k] && src[k - 1] && src[k + 1] && src[k - N] && src[k + N]) next[k] = 1;
  }
  strict = next;
}
let strictArea = 0;
for (let k = 0; k < N * N; k++) if (strict[k]) strictArea++;

window.__FOOT__ = {
  N, ox, oz, CELL, solid, strict,
  _at(grid, x, z) {
    const i = Math.floor((x - this.ox) / this.CELL);
    const j = Math.floor((z - this.oz) / this.CELL);
    if (i < 0 || j < 0 || i >= this.N || j >= this.N) return false;
    return grid[j * this.N + i] === 1;
  },
  /** Unambiguously within the drawn building, with 0.5 m of slack. */
  inside(x, z) { return this._at(this.strict, x, z); },
  /** The raw footprint, used only to place the spawn and target clear of it. */
  touches(x, z) { return this._at(this.solid, x, z); },
};
return { ok: true, N, area: area * CELL * CELL, strictArea: strictArea * CELL * CELL, tris };
`;

/** Components of the footprint grid, so a candidate building can be chosen. */
const PICK_SITE = `
const F = window.__FOOT__;
const N = F.N;
const seen = new Int32Array(N * N).fill(-1);
const comps = [];
const stack = [];
for (let s = 0; s < N * N; s++) {
  if (!F.strict[s] || seen[s] >= 0) continue;
  const id = comps.length;
  const c = { n: 0, minI: 1e9, maxI: -1e9, minJ: 1e9, maxJ: -1e9 };
  comps.push(c);
  stack.length = 0; stack.push(s); seen[s] = id;
  while (stack.length) {
    const k = stack.pop();
    const i = k % N, j = (k / N) | 0;
    c.n++;
    if (i < c.minI) c.minI = i; if (i > c.maxI) c.maxI = i;
    if (j < c.minJ) c.minJ = j; if (j > c.maxJ) c.maxJ = j;
    if (i > 0 && F.strict[k - 1] && seen[k - 1] < 0) { seen[k - 1] = id; stack.push(k - 1); }
    if (i < N - 1 && F.strict[k + 1] && seen[k + 1] < 0) { seen[k + 1] = id; stack.push(k + 1); }
    if (j > 0 && F.strict[k - N] && seen[k - N] < 0) { seen[k - N] = id; stack.push(k - N); }
    if (j < N - 1 && F.strict[k + N] && seen[k + N] < 0) { seen[k + N] = id; stack.push(k + N); }
  }
}
const phys = ctx.peek('physics');
const w = ctx.peek('world');
const out = [];
let noCollider = 0;
let notSealed = 0;
for (const c of comps) {
  const area = c.n * F.CELL * F.CELL;
  if (area < 40) continue;
  const minX = F.ox + c.minI * F.CELL, maxX = F.ox + (c.maxI + 1) * F.CELL;
  const minZ = F.oz + c.minJ * F.CELL, maxZ = F.oz + (c.maxJ + 1) * F.CELL;
  const mx = (minX + maxX) / 2, mz = (minZ + maxZ) / 2;
  // A single building, not a whole block: past this the "crossing" is really a
  // walk down a street between two of them and proves nothing.
  if (maxX - minX > 48 || maxZ - minZ > 48) continue;
  for (const axis of [0, 1]) {
    const half = axis === 0 ? (maxX - minX) / 2 : (maxZ - minZ) / 2;
    const dx = axis === 0 ? 1 : 0, dz = axis === 0 ? 0 : 1;
    for (const clear of [4, 6, 8, 11]) {
      const ax = mx - dx * (half + clear), az = mz - dz * (half + clear);
      const tx = mx + dx * (half + clear), tz = mz + dz * (half + clear);
      // Clear of the RAW footprint, not just the eroded one: neither end may be
      // standing on the building at all.
      if (F.touches(ax, az) || F.touches(tx, tz)) continue;
      const ay = w.walkableHeightAt(ax, az), ty = w.walkableHeightAt(tx, tz);
      if (!Number.isFinite(ay) || !Number.isFinite(ty)) continue;
      if (Math.abs(ay - ty) > 4) continue;
      // The building has to be BETWEEN them, and it has to block sight.
      if (!F.inside(mx, mz)) continue;
      const span = (half + clear) * 2;
      const blocked = !phys.lineOfSight(
        { x: ax, y: ay + 1.2, z: az }, { x: tx, y: ty + 1.2, z: tz }, phys.MASK.SIGHT);
      if (!blocked) continue;
      /**
       * KNOWN-SOLID — and this is SELECTION, not the assertion.
       *
       * Sweep a man-sized capsule the whole way from the spawn to the target
       * and require it to be stopped. Without it the probe cannot tell a
       * building from a picture of one. MEASURED at THE STRIP: a drawn 31 m
       * block with a roof at 16.6 m that has NO COLLIDER ANYWHERE — a capsule
       * walks the full 47 m through it, and so would the player. That is a
       * hole in the city owned by src/buildings; a gate for src/peds must not
       * be permanently red because of it, so the site is skipped and counted
       * and the assertions run on a wall that is actually there.
       */
      const dirX = (tx - ax) / span, dirZ = (tz - az) / span;
      const sweep = phys.capsuleCast(
        { x: ax, y: ay + 0.4, z: az }, { x: ax, y: ay + 1.7, z: az },
        0.34, { x: dirX, y: 0, z: dirZ }, span, phys.MASK.CHARACTER);
      if (!sweep?.hit) { noCollider++; continue; }

      /**
       * SEALED ON EVERY BEARING, AND THE COLLIDER WHERE THE DRAWING IS.
       *
       * One sweep down the crossing is not enough: a building can have a
       * collider on the wall facing the spawn and nothing on the flank, and a
       * goon who walks round and in through the side is being contained by
       * nobody. Worse, the single sweep can be stopped by a bollard two metres
       * short of the building and read as proof the wall exists — MEASURED at
       * THE STRIP, where a capsule stopped at 11.96 m and the goon then stood
       * 1.8 m INSIDE the drawn wall.
       *
       * So: sixteen bearings, each swept inward from outside, each required to
       * stop within 1.2 m of where the DRAWN footprint begins along that
       * bearing. That is "the collision shell agrees with the picture, all the
       * way round" — and it is still SELECTION. The assertions never consult
       * physics.
       */
      const rad = Math.max(maxX - minX, maxZ - minZ) / 2 + 5;
      let tested = 0, sealed = 0;
      for (let bb = 0; bb < 16; bb++) {
        const th = (bb / 16) * Math.PI * 2;
        const sx = mx + Math.cos(th) * rad, sz = mz + Math.sin(th) * rad;
        if (F.touches(sx, sz)) continue;
        const sy = w.walkableHeightAt(sx, sz);
        if (!Number.isFinite(sy)) continue;
        const ux = -Math.cos(th), uz = -Math.sin(th);
        let dFace = -1;
        for (let d = 0; d <= rad; d += 0.25) {
          if (F.touches(sx + ux * d, sz + uz * d)) { dFace = d; break; }
        }
        if (dFace < 0) continue;                    // this bearing misses it
        tested++;
        const h2 = phys.capsuleCast(
          { x: sx, y: sy + 0.4, z: sz }, { x: sx, y: sy + 1.7, z: sz },
          0.34, { x: ux, y: 0, z: uz }, rad, phys.MASK.CHARACTER);
        if (h2?.hit && h2.distance <= dFace + 3.0) sealed++;
      }
      // EVERY bearing. One unsealed side is a door a goon walks in through, and
      // the gate would then be red for a hole in src/buildings rather than for
      // anything this directory did — MEASURED at THE STRIP with one bearing
      // in fifteen open: 118 frames inside, at ground level, through the gap.
      // The 3 m tolerance is for cornices and corners, not for missing walls:
      // a wall that is not there puts the first hit on the FAR side of the
      // building, tens of metres late.
      if (tested < 8 || sealed < tested) { notSealed++; continue; }

      out.push({ area, ax, az, ay, tx, tz, ty, span, sealed, tested,
                 stopAt: +sweep.distance.toFixed(2), minX, maxX, minZ, maxZ });
      break;
    }
  }
}
out.sort((p, q) => q.area - p.area);
return { sites: out.slice(0, 6), noCollider, notSealed };
`;

/**
 * ONE FRAME, ONE INSTANT. Advance the engine, then read the goon's DRAWN world
 * position out of the matrix the renderer used, plus the analytic ground under
 * it. Both in the same evaluate, because the page runs free between round trips
 * and a position from one frame against a ground from the next is noise.
 */
const STEP = `
await window.__PUMP__(1);
const F = window.__FOOT__;
const w = ctx.peek('world');
const h = window.__GOON__;
if (!h || !h.active) return { gone: true };
let x, y, z;
const drawn = h.group ?? h.mesh ?? null;
if (drawn) {
  drawn.updateMatrixWorld(true);
  const e = drawn.matrixWorld.elements;
  x = e[12]; y = e[13]; z = e[14];
} else {
  x = h.position.x; y = h.position.y; z = h.position.z;
}
const gy = w.walkableHeightAt(x, z);
const p = ctx.peek('player').position;
return {
  x: +x.toFixed(3), y: +y.toFixed(3), z: +z.toFixed(3),
  inside: F.inside(x, z) ? 1 : 0,
  above: Number.isFinite(gy) ? +(y - gy).toFixed(3) : null,
  d: +Math.hypot(x - p.x, z - p.z).toFixed(2),
  drawn: !!drawn,
  alive: !!h.alive,
};
`;

/**
 * Re-check a candidate crossing against the footprint that is live RIGHT NOW —
 * the one the assertions will read. Same four conditions the site search used.
 */
const REVALIDATE = `
const F = window.__FOOT__;
const phys = ctx.peek('physics');
const S = ARG;
const span = Math.hypot(S.tx - S.ax, S.tz - S.az);
const endsClear = !F.touches(S.ax, S.az) && !F.touches(S.tx, S.tz);
const midInside = F.inside((S.ax + S.tx) / 2, (S.az + S.tz) / 2);
const sightBlocked = !phys.lineOfSight(
  { x: S.ax, y: S.ay + 1.2, z: S.az }, { x: S.tx, y: S.ty + 1.2, z: S.tz }, phys.MASK.SIGHT);
const sweep = phys.capsuleCast(
  { x: S.ax, y: S.ay + 0.4, z: S.az }, { x: S.ax, y: S.ay + 1.7, z: S.az },
  0.34, { x: (S.tx - S.ax) / span, y: 0, z: (S.tz - S.az) / span }, span, phys.MASK.CHARACTER);
let area = 0;
for (let k = 0; k < F.N * F.N; k++) if (F.strict[k]) area++;
return {
  ok: endsClear && midInside && sightBlocked && !!sweep.hit,
  endsClear, midInside, sightBlocked,
  stopAt: sweep.hit ? +sweep.distance.toFixed(2) : null,
  area: area * F.CELL * F.CELL,
};
`;

/**
 * An ASCII plan of the drawn footprint with the goon's path drawn on it.
 * `#` massing, `+` the eroded core the assertion uses, `.` open ground,
 * `o` a sampled position, `X` a sample the gate counted as inside, `S`/`T` the
 * spawn and the target. Printed for any site that fails, because "507 frames
 * inside" is a number and this is the picture that says WHERE.
 */
const MAP_SRC = `
const F = window.__FOOT__;
const S = ARG.site, path = ARG.path;
const i0 = Math.max(0, Math.floor((Math.min(S.ax, S.tx) - 16 - F.ox) / F.CELL));
const i1 = Math.min(F.N - 1, Math.ceil((Math.max(S.ax, S.tx) + 16 - F.ox) / F.CELL));
const j0 = Math.max(0, Math.floor((Math.min(S.az, S.tz) - 26 - F.oz) / F.CELL));
const j1 = Math.min(F.N - 1, Math.ceil((Math.max(S.az, S.tz) + 26 - F.oz) / F.CELL));
const step = Math.max(1, Math.ceil((i1 - i0) / 108));
const cellOf = (x, z) => [Math.floor((x - F.ox) / F.CELL), Math.floor((z - F.oz) / F.CELL)];
const marks = new Map();
const key = (i, j) => i + ',' + j;
for (const p of path) { const c = cellOf(p.x, p.z); marks.set(key(c[0], c[1]), p.inside ? 'X' : 'o'); }
const cs = cellOf(S.ax, S.az); marks.set(key(cs[0], cs[1]), 'S');
const ct = cellOf(S.tx, S.tz); marks.set(key(ct[0], ct[1]), 'T');
const rows = [];
for (let j = j0; j <= j1; j += step) {
  let r = '';
  for (let i = i0; i <= i1; i += step) {
    const mk = marks.get(key(i, j));
    if (mk) { r += mk; continue; }
    const k = j * F.N + i;
    r += F.strict[k] ? '+' : F.solid[k] ? '#' : '.';
  }
  rows.push(r);
}
return rows;
`;

/**
 * THE NEGATIVE CONTROL. Reinstate, on the live hostile manager, exactly the
 * integrator `game/hostiles.js` shipped: add the desired displacement straight
 * onto the position and take the floor from a downward raycast that starts
 * thirty metres up. Nothing else changes — same brain, same speeds, same site.
 */
const LEGACY_PATCH = `
const peds = ctx.peek('peds');
const mgr = peds.hostiles;
if (mgr.__legacy) return true;
mgr.__legacy = true;
for (const p of mgr.pool) if (p.controller) p.controller.enabled = false;
const orig = mgr.update.bind(mgr);
mgr.update = function (dt, anchor) {
  orig(dt, anchor);
  for (const ped of this.live) {
    if (!ped.active || !ped.alive) continue;
    if (ped.controller) ped.controller.enabled = false;
    const moved = ped.speed * dt;
    ped.position.x += ped._steer.x * moved;
    ped.position.z += ped._steer.z * moved;
    ped.position.y = this.sys.groundAt(ped.position.x, ped.position.z, ped.position.y + 30) + 0.02;
    ped._hostX = ped.position.x;
    ped._hostZ = ped.position.z;
  }
};
return true;
`;

/* ==================================================================== */

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
const pageErrors = [];
page.on('pageerror', (e) => { if (pageErrors.length < 20) pageErrors.push(String(e.message).slice(0, 200)); });

const run = (src, a = null) =>
  page.evaluate(({ s, x }) => {
    const engine = window.__ENGINE__;
    // eslint-disable-next-line no-new-func
    return new Function('engine', 'ctx', 'ARG', s)(engine, engine.ctx, x);
  }, { s: src, x: a });
const runAsync = (src, a = null) =>
  page.evaluate(({ s, x }) => {
    const engine = window.__ENGINE__;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return new AsyncFunction('engine', 'ctx', 'ARG', s)(engine, engine.ctx, x);
  }, { s: src, x: a });
const pump = (n = 1) => page.evaluate((k) => window.__PUMP__(k), n);
const settle = async (budget = 60) => {
  for (let k = 0; k < budget; k++) {
    await pump(20);
    if (await page.evaluate(() => (window.__SETTLED__ ? window.__SETTLED__() : true))) return true;
  }
  return false;
};

/**
 * Districts to try, in order. Any dense grid of streets will do — the site
 * search below only accepts a building that actually blocks sight, so which
 * district it happens to be found in is not load-bearing.
 */
const DISTRICTS = [
  ['MANCHESTER', -984, -568],
  ['THE STRIP', 248, -184],
  ['SOUTH SIDE', 160, 608],
  ['LAWRENCEVILLE', 680, -552],
  ['STEEL ROW', 784, 384],
  ['GOLDEN TRIANGLE', -232, 64],
  ['NORTH SHORE', -160, -600],
  ['HAZELWOOD', 984, -56],
];
/**
 * Several road spots per district. Most blocks in this city do NOT survive the
 * solidity screen — of 60-odd crossings examined in one run, 42 were rejected
 * because the drawn building has no collision shell that seals it — so the
 * search needs breadth or the probe reports "no site" and measures nothing.
 */
const JITTER = [[0, 0], [140, -110], [-120, 130], [90, 160], [-170, -60]];
const ANCHORS = [];
for (const [name, x, z] of DISTRICTS) {
  for (let k = 0; k < JITTER.length; k++) {
    ANCHORS.push([k ? `${name} ${k + 1}` : name, x + JITTER[k][0], z + JITTER[k][1]]);
  }
}

let exitCode = 0;
try {
  await page.goto(`http://127.0.0.1:${port}/?q=low&prewarm=0&capture=1&lockstep=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 150000 });
  // `three` is not on `window`; borrow the constructor family off a live object
  // so the rasteriser can use Vector3/Matrix4 without a second copy of the lib.
  await run(`
    const o = ctx.scene;
    window.__THREE__ = {
      Vector3: o.position.constructor,
      Matrix4: o.matrixWorld.constructor,
    };
    engine.input.enabled = false;
    return true;
  `);
  if (LEGACY) log('  [negative control] legacy integrator ON — gates 1 and 2 must go red');

  log(`\ncover probe — ${SECONDS}s per site, ${WANT_SITES} site(s)${LEGACY ? ' [--legacy]' : ''}`);

  /* ------------------------------------------------- find AND run, per site */
  /**
   * ONE PASS PER DISTRICT, AND THE SITE IS CHOSEN WHERE THE RUN HAPPENS.
   *
   * Buildings stream around the CAMERA, so the world the site was chosen in is
   * not the world the goon walks in unless the player is already standing where
   * he will stand. Measured: choosing at the district anchor and asserting from
   * the target grew the drawn footprint from 880 m² to 1420 m² at Manchester —
   * a different set of buildings, and a spawn point that had been 4 m in the
   * clear was inside one of the new ones. So: settle at the anchor, take a
   * rough bearing, move to where the fight will be, settle again, and only then
   * choose the crossing, build the footprint the assertions read, and run.
   */
  const runs = [];
  let noCollider = 0;
  for (const [name, ax, az] of ANCHORS) {
    if (runs.length >= WANT_SITES) break;
    const at = await run(`
      const w = ctx.peek('world');
      const near = w.roads.nearestEdge(ARG.x, ARG.z, 500);
      if (!near?.edge) return null;
      const e = near.edge;
      const na = w.roads.nodes[e.a], nb = w.roads.nodes[e.b];
      const off = (e.width ?? 8) * 0.5 + 2.2;
      const x = na.x + (nb.x - na.x) * near.t - e.dz * off;
      const z = na.z + (nb.z - na.z) * near.t + e.dx * off;
      const y = w.walkableHeightAt(x, z);
      ctx.peek('player').teleport({ x, y: y + 1.0, z }, 0);
      ctx.peek('peds').clearHostiles();
      return { x, y, z };
    `, { x: ax, z: az });
    if (!at) continue;
    await settle();
    const rough = await run(BUILD_FOOTPRINT,
      { cx: at.x, cz: at.z, r: 55, cell: CELL, massingY: MASSING_Y });
    if (!rough?.ok) { log(`  ..${name}: ${rough?.why ?? 'no footprint'}`); continue; }
    const first = await run(PICK_SITE);
    noCollider += first.noCollider + first.notSealed;
    if (!first.sites.length) {
      log(`  ..${name}: ${rough.area.toFixed(0)} m² drawn footprint, no solid crossing` +
          (first.noCollider + first.notSealed
            ? ` (${first.noCollider + first.notSealed} rejected: the collision shell does not match the drawing)` : ''));
      continue;
    }

    // Stand where the fight will be, let the city finish arriving, and only
    // then decide anything.
    const R0 = first.sites[0];
    await run(`ctx.peek('player').teleport({ x: ARG.tx, y: ARG.ty + 1.0, z: ARG.tz }, 0);
               ctx.peek('peds').clearHostiles(); return true;`, R0);
    await settle();
    const foot = await run(BUILD_FOOTPRINT,
      { cx: (R0.ax + R0.tx) / 2, cz: (R0.az + R0.tz) / 2, r: 55, cell: CELL, massingY: MASSING_Y });
    const found = await run(PICK_SITE);
    const rejected = found.noCollider + found.notSealed;
    noCollider += rejected;
    log(`  ..${name}: drawn footprint ${foot.area.toFixed(0)} m² ` +
        `(${foot.strictArea.toFixed(0)} m² after erosion) from ${foot.tris} massing tris, ` +
        `${found.sites.length} solid crossing(s)` +
        (rejected ? `, ${rejected} rejected — ${found.noCollider} with NO collider at all and ` +
          `${found.notSealed} whose shell does not seal the drawn walls (src/buildings)` : ''));
    if (!found.sites.length) continue;
    const S = found.sites[0];

    const v = await run(REVALIDATE, S);
    rec(`0 SITE  ${name}: ${S.area.toFixed(0)} m² of drawn massing, sight blocked, capsule stopped`,
      v.ok,
      `spawn (${S.ax.toFixed(1)}, ${S.az.toFixed(1)}) -> target (${S.tx.toFixed(1)}, ${S.tz.toFixed(1)}), ` +
      `${S.span.toFixed(1)} m apart, a walking capsule stops at ${v.stopAt} m, ` +
      `shell seals ${S.sealed}/${S.tested} bearings`);
    if (!v.ok) continue;

    // The player fights from the target end of the crossing.
    await run(`ctx.peek('player').teleport({ x: ARG.tx, y: ARG.ty + 1.0, z: ARG.tz }, 0);
               ctx.peek('peds').clearHostiles(); return true;`, S);
    await pump(30);
    if (LEGACY) await run(LEGACY_PATCH);

    const spawned = await run(`
      const peds = ctx.peek('peds');
      const g = ctx.peek('game');
      window.__GOON__ = peds.spawnHostile({ x: ARG.ax, y: ARG.ay, z: ARG.az },
        { hp: 100000, dmg: 0, ranged: false, speed: 3.9, range: 2.4 });
      return !!window.__GOON__;
    `, S);
    if (!spawned) { rec(`1 CONTAINED ${name}`, false, 'the hostile pool refused to spawn'); continue; }

    const frames = Math.round(SECONDS * 60);
    const path = [];
    for (let f = 0; f < frames; f++) {
      const p = await runAsync(STEP);
      if (p?.gone) break;
      path.push(p);
    }
    await run(`ctx.peek('peds').clearHostiles(); window.__GOON__ = null; return true;`);
    const map = (args.map || path.some((p) => p.inside))
      ? await run(MAP_SRC, { site: S, path }) : null;
    runs.push({ name, site: S, path, map });
  }

  if (!runs.length) {
    rec('a solid building that blocks line of sight was found', false,
      'no district produced one — the probe could not run');
  }

  /* ---------------------------------------------------------- assertions */
  let anyDrawn = false;
  for (const r of runs) {
    const path = r.path;
    if (!path.length) { rec(`1 CONTAINED ${r.name}`, false, 'no samples'); continue; }
    anyDrawn = anyDrawn || path.some((p) => p.drawn);

    const insideN = path.filter((p) => p.inside).length;
    rec(`1 CONTAINED ${r.name}: the goon's drawn path never enters the footprint`,
      insideN === 0,
      `${insideN}/${path.length} frames inside` +
      (insideN ? ` (first at ${fmt(path.find((p) => p.inside))})` : ''));
    if (r.map) { log(`        # massing  + core  . open  o path  X inside  S spawn  T target`); for (const row of r.map) log('        ' + row); }

    const aboves = path.map((p) => p.above).filter((v) => v != null);
    const hi = aboves.length ? Math.max(...aboves) : 0;
    const lo = aboves.length ? Math.min(...aboves) : 0;
    rec(`2 GROUNDED ${r.name}: height over the walkable surface stays in band`,
      aboves.length > 0 && hi <= BAND_HI && lo >= BAND_LO,
      `${lo.toFixed(2)} .. ${hi.toFixed(2)} m (band ${BAND_LO} .. ${BAND_HI})`);

    const d0 = path[0].d;
    const dMin = Math.min(...path.map((p) => p.d));
    rec(`3 CHASES  ${r.name}: he goes round rather than standing still`,
      dMin < d0 - 3,
      `closed ${d0.toFixed(1)} m -> ${dMin.toFixed(1)} m`);
  }
  rec('the path was read off the DRAWN transform, not the AI position field',
    anyDrawn, anyDrawn ? 'mesh.matrixWorld' : 'no skinned body was ever assigned — fell back to h.position');

  /* ---------------------------------------------------------- 4 DROPS */
  const drop = await run(`
    const g = ctx.peek('game');
    const peds = ctx.peek('peds');
    const p = ctx.peek('player').position;
    g.pickups.clear();
    // Force the chapter state the drop is gated on, without running
    // a whole mission: _dropFor reads missions.running, nothing else.
    const M = g.missions.M;
    const fake = { phase: 'run' };
    g.missions.M = fake;
    const before = g.hostiles.drops;
    const kinds = {};
    let n = 0;
    for (let i = 0; i < ARG.kills; i++) {
      const h = peds.spawnHostile({ x: p.x + 6 + (i % 5), y: p.y, z: p.z + 6 }, { hp: 10, dmg: 0 });
      if (!h) break;
      n++;
      const was = g.hostiles.drops;
      g.hostiles.hurt(h, 999, false, h.position);
      if (g.hostiles.drops > was) {
        // Read what was actually PUT IN THE WORLD, not what the roll said.
        for (const q of g.pickups.live) {
          if (q.kind === 'health' || q.kind === 'ammo') kinds[q.kind] = (kinds[q.kind] ?? 0) + 1;
        }
      }
      peds.despawnHostile(h);
      // The pool is 64 and freeroam drops cash on every goon too, so a full
      // pool would silently refuse the health packs and read as a 0% rate.
      g.pickups.clear();
    }
    const got = g.hostiles.drops - before;
    g.missions.M = M;
    g.pickups.clear();
    return { kills: n, drops: got, kinds };
  `, { kills: KILLS });
  const rate = drop.kills ? drop.drops / drop.kills : 0;
  // 3-sigma binomial band on p=0.28 for this many trials.
  const sd = Math.sqrt(0.28 * 0.72 / Math.max(1, drop.kills));
  const okRate = drop.kills >= 100 && Math.abs(rate - 0.28) <= 3 * sd + 0.005;
  const kinds = Object.keys(drop.kinds).sort();
  rec('4 DROPS   28% of mission kills drop health or ammo',
    okRate && kinds.length > 0 && kinds.every((k) => k === 'health' || k === 'ammo'),
    `${drop.drops}/${drop.kills} = ${(rate * 100).toFixed(1)}% (want 28% ±${(3 * sd * 100).toFixed(1)}), ` +
    `kinds ${JSON.stringify(drop.kinds)}`);

  if (noCollider) {
    log(`\n  NOTE, not a failure and NOT THIS DIRECTORY'S: ${noCollider} drawn crossing(s) were ` +
        'skipped because the collision shell does not match the picture — either no collider at ' +
        'all (a capsule sweeps the whole way through a building with a roof on it) or a shell ' +
        'that leaves at least one side of it open. Nothing on foot, goon or player, is stopped by ' +
        'those walls. src/buildings owns it; this probe only had to route around it to find a ' +
        'building that is really there.');
  }
  if (pageErrors.length) rec('no page errors', false, pageErrors.join(' | '));

  const failed = results.filter((r) => !r.ok);
  log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (JSON_OUT) console.log(JSON.stringify({ legacy: LEGACY, results, runs: runs.map(summarise) }, null, 2));
  exitCode = failed.length ? 1 : 0;
  if (LEGACY) {
    // Under the control, RED is the correct outcome: report it as such and
    // exit 0 only when the gates that must break did break.
    const broke = results.some((r) => !r.ok && /^[12] /.test(r.name));
    log(broke
      ? '  negative control OK: the legacy integrator fails CONTAINED/GROUNDED'
      : '  NEGATIVE CONTROL DID NOT REPRODUCE — this gate is not measuring anything');
    exitCode = broke ? 0 : 1;
  }
} catch (e) {
  console.error('coverprobe failed:', e?.message ?? e);
  exitCode = 1;
} finally {
  await browser.close();
  server?.kill();
}

function fmt(p) {
  if (!p) return '?';
  const a = p.above == null ? '?' : `${p.above >= 0 ? '+' : ''}${p.above.toFixed(2)}`;
  return `${p.x.toFixed(1)}, ${p.z.toFixed(1)} @ ${a} m`;
}
function summarise(r) {
  return {
    name: r.name,
    frames: r.path.length,
    inside: r.path.filter((p) => p.inside).length,
    maxAbove: Math.max(...r.path.map((p) => p.above ?? 0)),
    minDist: Math.min(...r.path.map((p) => p.d)),
  };
}

process.exit(exitCode);
