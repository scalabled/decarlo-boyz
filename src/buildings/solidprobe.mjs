#!/usr/bin/env node
/**
 * SOLID PROBE — is the city you can SEE the city you can WALK INTO?
 *
 *   node src/buildings/solidprobe.mjs
 *   node src/buildings/solidprobe.mjs --legacy      THE NEGATIVE CONTROL
 *   node src/buildings/solidprobe.mjs --tiles=60 --json
 *   node src/buildings/solidprobe.mjs --map=warehouse   plan of the first failure
 *   node src/buildings/solidprobe.mjs --map=ghost       ... of the first ghost
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS EXISTS FOR
 * ────────────────────────────────────────────────────────────────────────────
 * `src/peds/coverprobe.mjs` reported that of ~60 building crossings it examined
 * on real streets, 42 failed a solidity screen, and it named `src/buildings` as
 * the owner. That is a claim about EVERY building in the city and it cannot be
 * answered by walking a few streets: the streamed world only ever has a handful
 * of tiles resident, so a district whose archetype has no collision shell is
 * invisible to a probe that happens not to stand in it.
 *
 * ONE PART OF THAT REPORT DOES NOT SURVIVE MEASUREMENT AND IS WORTH SAYING
 * PLAINLY, because it is the part that pointed at the wrong fix. It said some
 * of the rejects had "NO COLLISION SHELL AT ALL", and that no massing archetype
 * emitted into `_collide`. Neither is true. Every archetype the planner can
 * choose emitted collision before this file existed — checked one plan at a
 * time across the whole lot table, ten archetypes, zero with an empty
 * accumulator — and `coverprobe`'s own `noCollider` counter, the one that
 * counts a capsule sweeping the whole way through, reads ZERO over all forty of
 * its anchors both before and after the fix here. The worked example offered
 * with the report does not reproduce either: at THE STRIP, z = -195.6, a
 * capsule swept from x=246 is stopped at 14.04 m and one swept back from x=300
 * at 7.22 m, and `checkCapsule` sampled at 0.25 m finds six blocked bands
 * across that 54 m line. The three-metre sampling in the report simply stepped
 * over walls one metre thick.
 *
 * What IS true is the defect underneath it, and it is larger than one district:
 * collision was authored from the FACADE's holes rather than from the
 * building's MASS, so every glazed ground storey in the city — shopfront,
 * lobby colonnade, loading dock — was a hole in the hull. See the note over
 * `volumeShell` in archetypes.js for the numbers per archetype.
 *
 * So this walks the whole lot table instead — every tile `world` publishes,
 * every plan `BuildingSystem._plans` makes of it — builds each building through
 * the SHIPPED path (`B.buildPlan` -> `TileBuilder.build`), and asks one
 * question of the result:
 *
 *     the mass you can SEE, on sixteen bearings, from outside:
 *     does something STOP A MAN before he is inside it?
 *
 * ────────────────────────────────────────────────────────────────────────────
 * RULE 12 — THE TWO PRODUCERS, AND WHY THIS IS NOT CIRCULAR
 * ────────────────────────────────────────────────────────────────────────────
 * A building leaves `TileBuilder` as two INDEPENDENT artefacts made by
 * different code from different arithmetic:
 *
 *   THE PICTURE     `T.add` / `T.addOnce` / `T.put*` — extruded wall panels with
 *                   punched openings (`wallPanel`), plan prisms (`polyPrism`),
 *                   crowns, and the instanced window/shopfront kit. This is
 *                   what the renderer draws and what the player looks at.
 *   THE SHELL       `T.box` / `T.slabBox` — axis-aligned proxies authored by
 *                   hand next to the geometry, merged into the `bcol_*` meshes
 *                   that `physics.addStatic` gets.
 *
 * THE PICTURE IS GROUND TRUTH HERE. The footprint is rasterised out of the
 * emitted triangles — merged meshes and `InstancedMesh` alike, per-instance
 * transforms included — and the assertion then sweeps a capsule against THE
 * SHELL and requires the two to agree. Nothing asks a builder whether it thinks
 * it added collision; a wall that was drawn and not collided is exactly the
 * disagreement this measures. (The rasterising technique is `coverprobe`'s;
 * that probe had to route AROUND this defect, this one aims at it.)
 *
 * THE SWEEP RUNS IN AN EMPTY WORLD, AND THAT IS THE OTHER HALF OF RULE 12.
 * Each building's collision meshes go into a `StaticWorld` of their own, with
 * no terrain, no props, no neighbours — so a capsule that stops has been
 * stopped BY THIS BUILDING and by nothing else. Measured on the live streamed
 * world instead, a kerb, a bollard or a parked car two metres short of the wall
 * reads as proof the wall is there; `coverprobe` recorded exactly that at THE
 * STRIP, a capsule stopping at 11.96 m in front of a facade that was not
 * collided at all.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE MEASUREMENT
 * ────────────────────────────────────────────────────────────────────────────
 * Per building, the drawn footprint is the intersection of two grids at 0.5 m,
 * exactly as `coverprobe` derives it, because each half alone is wrong in a way
 * that was measured on real streets:
 *
 *   low    drawn geometry standing in the band a man occupies, gy+0.4..gy+2.4.
 *          Walls close a ring in plan; the legs of a canopy do not.
 *   high   drawn geometry reaching above gy+3 — the massing.
 *   solid  = enclosed by `low` AND covered by `high`.
 *
 * `gy` is `world.walkableHeightAt`, the analytic street surface — the same
 * contract the character controller stands on, and nothing to do with
 * buildings.
 *
 * `solid` is then eroded 1.5 m (see the note at the erosion), so the claim
 * under test is the honest one: by the time a man is a metre and a half INSIDE
 * the drawn massing, something must have stopped him.
 *
 * Then, for each of sixteen bearings that actually meet the footprint: find
 * `dFace`, the distance from the start point at which that eroded mass begins,
 * sweep a 0.34 m man-capsule (0.4 .. 1.7 m over the walkable surface) inward,
 * and require a hit no later than `dFace + TOL`.
 *
 * TOL is 1.5 m — so the whole tolerance is 3 m past the drawn outer face, the
 * same figure `coverprobe` accepts, and it is a tolerance for CORNERS, not for
 * missing walls. A wall that is not there does not miss by three metres: it
 * misses by the width of the building, because the first thing the capsule can
 * hit is the far side — or it never hits at all.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT ASSERTS
 * ────────────────────────────────────────────────────────────────────────────
 *   1 SEALED     every archetype seals at least RATCHET.seal of its bearings,
 *                and no archetype is worse than RATCHET.archSeal.
 *   2 SOLID      no building is a GHOST — one whose shell stops the capsule on
 *                fewer than a third of its bearings. This is the defect in the
 *                report: a drawn 31 m block a man walks straight through.
 *   3 COVERAGE   every archetype the planner can emit was actually tested, and
 *                the count is printed. A new archetype that nobody gives a
 *                collision shell cannot join the city quietly — it either shows
 *                up here with its own row, or gate 3 goes red because the list
 *                below no longer matches what `planBuilding` produces.
 *   4 LANDMARKS  the six hand-authored buildings get the same treatment.
 *
 * `--legacy` is the NEGATIVE CONTROL: it disables the fix in `archetypes.js`
 * (the collision shell for volumes the elevation builder skips) and nothing
 * else. Gates 1 and 2 must go red, and the run exits 0 only if they do.
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
const TILES = Number(args.tiles ?? 0) || 0;
const MAP = typeof args.map === 'string' ? args.map : args.map ? '*' : '';
/**
 * DIAGNOSTIC, not a mode anyone should gate on. `index.js`'s kerb guard deletes
 * emitted geometry — visual AND proxy — that stands in a live carriageway, so a
 * lot the road runs through legitimately loses a wall and keeps its roof. Those
 * show up here as an unsealed bearing whose drawn face was stamped by a roof
 * material, and they are `roadsweep.mjs`'s trade, not a hole in the shell.
 * `--nokerb` turns the guard off so the residual can be attributed.
 */
const NOKERB = !!args.nokerb;

const log = (...a) => { if (!JSON_OUT) console.log(...a); };
const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') });
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(54)} ${detail ?? ''}`);
};

/* ---------------------------------------------------------------- RATCHET */
/**
 * RATCHET (rule 13) — lower these when you improve the shell, NEVER raise one
 * to go green. Measured over the whole lot table: 268 tiles, 1521 buildings,
 * 23 147 bearings, identical inputs on both sides.
 *
 *                              --legacy (as shipped)   with the volume shell
 *   overall sealed                     93.04%                  98.47%
 *   worst archetype              tower 73.31%            house 95.80%
 *   curtain / deco / warehouse   75.5 / 75.0 / 77.8      99.5 / 100 / 98.9
 *   collision tris, one house           1428                      48
 *
 * `ghosts` is 2 and both are the SAME two under the control, so neither is a
 * collision defect: they are hillside houses founded on the lowest corner of
 * their own footprint and buried by up to 9.7 m at the uphill end (see the
 * note at `topY`). A third ghost appearing is a real regression.
 *
 * IN SITU, and measured by a probe this directory neither wrote nor touched:
 * `src/peds/coverprobe.mjs --sites=40` walks forty anchors across all eight
 * districts and screens each drawn crossing by sweeping a capsule on sixteen
 * bearings. Before the volume shell it accepted 35 crossings and rejected 125;
 * after, it accepts 63 and rejects 34. Its `noCollider` count is 0 on both
 * sides — every rejection is a shell that fails to SEAL, never one that is
 * absent.
 */
const RATCHET = {
  /** Fraction of all tested bearings that must be sealed. */
  seal: 0.98,
  /** The worst archetype's own sealed fraction. */
  archSeal: 0.95,
  /** Buildings sealed on under a third of their bearings. */
  ghosts: 2,
  /** A landmark with an enclosed massing must seal at least this much of it. */
  lmSeal: 0.4,
};

/**
 * Every archetype `planBuilding` can choose, plus the six landmarks. Gate 3
 * fails if the run does not test all of them — that is what stops a new
 * massing prototype joining the city with no collision shell and no row here.
 */
const ARCHETYPES = [
  'block', 'curtain', 'deco', 'house', 'market',
  'mill', 'pavilion', 'rowhouse', 'tower', 'warehouse',
];
const LANDMARK_IDS = ['lm_tower', 'lm_stadium', 'lm_mill', 'lm_incline', 'lm_point', 'lm_market'];

/* ==================================================================== */
/* page side                                                             */
/* ==================================================================== */

const PROBE = `
const e = window.__ENGINE__;
const ctx = e.ctx;
const B = ctx.peek('buildings');
if (ARG.nokerb) B.kerbGuard = false;
const world = ctx.peek('world');
const phys = ctx.peek('physics');
const { TileBuilder } = await import('/src/buildings/tile.js');
const { StaticWorld } = await import('/src/physics/bvh.js');
const { LANDMARKS } = await import('/src/buildings/landmarks.js');
const V3 = ctx.scene.position.constructor;
const M4 = ctx.scene.matrixWorld.constructor;

const CELL = ARG.cell;
const TOL = ARG.tol;
const BEARINGS = 16;
/** Man capsule: 0.34 m radius, eyes-down band over the walkable surface. */
const CAP_R = 0.34, CAP_LO = 0.4, CAP_HI = 1.7;
const MASK = phys.MASK.CHARACTER;

/**
 * ONE BUILDING, MEASURED. "built" is what TileBuilder.build() returned.
 * Returns { bearings, sealed, ghost, worst, map? }.
 */
function measure(built, cx, cz, wantMap) {
  /* ---- 1. the DRAWN footprint (ground truth) --------------------------- */
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const tmp = new V3();
  const scan = (geo, mat) => {
    const pos = geo.attributes?.position; if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i).applyMatrix4(mat);
      if (tmp.x < x0) x0 = tmp.x; if (tmp.x > x1) x1 = tmp.x;
      if (tmp.z < z0) z0 = tmp.z; if (tmp.z > z1) z1 = tmp.z;
    }
  };
  built.group.updateMatrixWorld(true);
  const mm = new M4();
  built.group.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const g = o.geometry; if (!g) return;
    if (o.isInstancedMesh) {
      for (let k = 0; k < o.count; k++) { o.getMatrixAt(k, mm); mm.premultiply(o.matrixWorld); scan(g, mm); }
    } else scan(g, o.matrixWorld);
  });
  if (!Number.isFinite(x0)) return null;

  const PAD = 10;
  const ox = x0 - PAD, oz = z0 - PAD;
  const NX = Math.ceil((x1 - x0 + PAD * 2) / CELL) + 1;
  const NZ = Math.ceil((z1 - z0 + PAD * 2) / CELL) + 1;
  if (NX * NZ > 900000) return null;              // a landmark the size of a district

  // Coarse walkable field, so the man band follows a street that climbs.
  const GS = 4;
  const GX = Math.ceil((NX * CELL) / GS) + 2, GZ = Math.ceil((NZ * CELL) / GS) + 2;
  const ground = new Float32Array(GX * GZ);
  for (let j = 0; j < GZ; j++) for (let i = 0; i < GX; i++) {
    const y = world.walkableHeightAt(ox + i * GS, oz + j * GS);
    ground[j * GX + i] = Number.isFinite(y) ? y : 0;
  }
  const groundAt = (x, z) => {
    const i = Math.max(0, Math.min(GX - 1, Math.round((x - ox) / GS)));
    const j = Math.max(0, Math.min(GZ - 1, Math.round((z - oz) / GS)));
    return ground[j * GX + i];
  };

  const low = new Uint8Array(NX * NZ);
  const occ = new Uint8Array(NX * NZ);
  /**
   * WHO DREW THIS CELL. An unsealed bearing is only actionable if the probe can
   * say which emitter put mass where the shell is not — "the drawn face here
   * came from bi_porch_post" is a fix, "3 bearings failed" is a bug report.
   */
  const names = [];
  const nameId = new Map();
  let who = 0;
  const owner = new Int16Array(NX * NZ).fill(-1);
  const a = new V3(), b = new V3(), c = new V3();
  /**
   * HOW HIGH THE DRAWING REACHES over each cell, absolute — every triangle,
   * whatever band it is in. Steel City is on hills and a lot is founded on the
   * LOWEST corner of its own footprint, so a single-storey house on a steep
   * street is BURIED: measured at (222, -1106), a 3.07 m house founded at
   * -4.83 whose own footprint corners stand on terrain at +1.25, +3.05 and
   * +3.82 — the whole building, roof included, is four to five metres under the
   * walkable surface across most of its plan. A man there is walking over the
   * top of it and NOTHING should stop him; the picture agrees, and the probe
   * was calling the agreement a hole. (It is a real defect, but it is a
   * PLACEMENT one and it belongs to whoever founds the lot, not to the shell.)
   */
  const topY = new Float32Array(NX * NZ).fill(-1e9);
  let curTop = 0;
  let target = occ;
  const put = (i, j) => {
    if (i < 0 || j < 0 || i >= NX || j >= NZ) return;
    const k = j * NX + i;
    if (target === null) { if (curTop > topY[k]) topY[k] = curTop; return; }
    target[k] = 1;
    if (target !== low) owner[k] = who;
  };
  /** Supercover a segment: a wall is one triangle THIN in plan. */
  const edge = (ax, az, bx, bz) => {
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      put(Math.floor((ax + (bx - ax) * t - ox) / CELL), Math.floor((az + (bz - az) * t - oz) / CELL));
    }
  };
  const fill = (ax, az, bx, bz, cxx, czz) => {
    let i0 = Math.floor((Math.min(ax, bx, cxx) - ox) / CELL);
    let i1 = Math.ceil((Math.max(ax, bx, cxx) - ox) / CELL);
    let j0 = Math.floor((Math.min(az, bz, czz) - oz) / CELL);
    let j1 = Math.ceil((Math.max(az, bz, czz) - oz) / CELL);
    if (i1 < 0 || j1 < 0 || i0 >= NX || j0 >= NZ) return;
    i0 = Math.max(0, i0); j0 = Math.max(0, j0);
    i1 = Math.min(NX - 1, i1); j1 = Math.min(NZ - 1, j1);
    const d = (bz - czz) * (ax - cxx) + (cxx - bx) * (az - czz);
    if (Math.abs(d) < 1e-9) return;
    const inv = 1 / d;
    for (let j = j0; j <= j1; j++) {
      const pz = oz + (j + 0.5) * CELL;
      for (let i = i0; i <= i1; i++) {
        const px = ox + (i + 0.5) * CELL;
        const l1 = ((bz - czz) * (px - cxx) + (cxx - bx) * (pz - czz)) * inv;
        if (l1 < 0 || l1 > 1) continue;
        const l2 = ((czz - az) * (px - cxx) + (ax - cxx) * (pz - czz)) * inv;
        if (l2 < 0 || l1 + l2 > 1) continue;
        const k = j * NX + i;
        if (target === null) { if (curTop > topY[k]) topY[k] = curTop; continue; }
        target[k] = 1;
        if (target !== low) owner[k] = who;
      }
    }
  };
  const stamp = () => {
    edge(a.x, a.z, b.x, b.z); edge(b.x, b.z, c.x, c.z); edge(c.x, c.z, a.x, a.z);
    fill(a.x, a.z, b.x, b.z, c.x, c.z);
  };
  const eat = (geo, mat) => {
    const pos = geo.attributes?.position; if (!pos) return;
    const idx = geo.index;
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t + 2 < n; t += 3) {
      const ia = idx ? idx.getX(t) : t, ib = idx ? idx.getX(t + 1) : t + 1, ic = idx ? idx.getX(t + 2) : t + 2;
      a.fromBufferAttribute(pos, ia).applyMatrix4(mat);
      b.fromBufferAttribute(pos, ib).applyMatrix4(mat);
      c.fromBufferAttribute(pos, ic).applyMatrix4(mat);
      const gy = groundAt((a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3);
      const yLo = Math.min(a.y, b.y, c.y), yHi = Math.max(a.y, b.y, c.y);
      target = null; curTop = yHi; stamp();
      if (yHi > gy + 0.4 && yLo < gy + 2.4) { target = low; stamp(); }
      if (yHi > gy + 3.0) { target = occ; stamp(); }
    }
  };
  built.group.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const g = o.geometry; if (!g) return;
    const nm = o.name || o.type;
    if (!nameId.has(nm)) { nameId.set(nm, names.length); names.push(nm); }
    who = nameId.get(nm);
    if (o.isInstancedMesh) {
      for (let k = 0; k < o.count; k++) { o.getMatrixAt(k, mm); mm.premultiply(o.matrixWorld); eat(g, mm); }
    } else eat(g, o.matrixWorld);
  });

  // Flood the OUTSIDE of the wall outlines, then solid = massing not outside.
  const out = new Uint8Array(NX * NZ);
  const stack = [];
  const seed = (k) => { if (!low[k] && !out[k]) { out[k] = 1; stack.push(k); } };
  for (let i = 0; i < NX; i++) { seed(i); seed((NZ - 1) * NX + i); }
  for (let j = 0; j < NZ; j++) { seed(j * NX); seed(j * NX + NX - 1); }
  while (stack.length) {
    const k = stack.pop();
    const i = k % NX, j = (k / NX) | 0;
    if (i > 0) seed(k - 1);
    if (i < NX - 1) seed(k + 1);
    if (j > 0) seed(k - NX);
    if (j < NZ - 1) seed(k + NX);
  }
  const raw0 = new Uint8Array(NX * NZ);
  let rawArea = 0;
  for (let k = 0; k < NX * NZ; k++) if (!out[k] && occ[k]) { raw0[k] = 1; rawArea++; }

  /**
   * ERODE 1.5 m, AND THE NUMBER IS EARNED — the same margin, for the same three
   * reasons, as coverprobe's. All three push the raster OUTWARD from the
   * surface the player sees:
   *
   *   - the edge supercover stamps the cell a sample lands in, so a wall running
   *     diagonally is a staircase one to two cells thick;
   *   - the drawn mass is PROUD of the wall plane wherever the kit hangs
   *     something on it. MEASURED, as the dominant residue after the volume
   *     shell landed: the eaves of a pitched roof (b_roof_shingle), a rowhouse
   *     parapet coping (b_roof_tar), a deco crown (b_alu_dark) and a covered
   *     porch, whose posts and rail close a ring 2.6 m out from the wall so the
   *     outside flood cannot reach the deck and the deck reads as INSIDE;
   *   - the man is a 0.34 m capsule whose centre is what the sweep tracks.
   *
   * A porch DECK is somewhere a man legitimately stands and a cornice is
   * somewhere he legitimately walks under, so counting either as mass that must
   * stop him would make this gate assert something false. Eroding first means
   * the claim is the honest one: by the time he is a metre and a half INSIDE the
   * drawn massing, something must have stopped him. Erring outward can only make
   * the gate more forgiving, which is the right direction for a margin whose job
   * is to keep a PASS honest — a missing wall is not 1.5 m late, it is the width
   * of the building late, or it never arrives at all.
   */
  let solid = raw0;
  for (let pass = 0; pass < 3; pass++) {
    const next = new Uint8Array(NX * NZ);
    const src = solid;
    for (let j = 1; j < NZ - 1; j++) for (let i = 1; i < NX - 1; i++) {
      const k = j * NX + i;
      if (src[k] && src[k - 1] && src[k + 1] && src[k - NX] && src[k + NX]) next[k] = 1;
    }
    solid = next;
  }
  let area = 0;
  for (let k = 0; k < NX * NZ; k++) if (solid[k]) area++;
  if (area * CELL * CELL < 25) return null;        // not a building: a kiosk, a pier

  const at = (x, z) => {
    const i = Math.floor((x - ox) / CELL), j = Math.floor((z - oz) / CELL);
    if (i < 0 || j < 0 || i >= NX || j >= NZ) return false;
    return solid[j * NX + i] === 1;
  };

  /* ---- 2. the SHELL, alone in a world of its own ----------------------- */
  const sw = new StaticWorld();
  let colTris = 0;
  for (const cm of built.colMeshes ?? []) {
    cm.updateMatrixWorld(true);
    const g = cm.geometry;
    colTris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    sw.addMesh(cm, cm.userData?.surface ?? 'concrete', phys.LAYER.STATIC);
  }
  sw.flat = true;
  sw.build();

  /* ---- 3. sixteen bearings -------------------------------------------- */
  const bx = (x0 + x1) / 2, bz = (z0 + z1) / 2;
  const rad = Math.max(x1 - x0, z1 - z0) / 2 + 8;
  const raw = {};
  let tested = 0, sealed = 0, worst = 0;
  const marks = [];
  for (let k = 0; k < BEARINGS; k++) {
    const th = (k / BEARINGS) * Math.PI * 2;
    const ux = -Math.cos(th), uz = -Math.sin(th);
    const sx = bx - ux * rad, sz = bz - uz * rad;
    if (at(sx, sz)) continue;                      // start already inside
    let dFace = -1, dExit = -1;
    for (let d = 0; d <= rad * 2; d += CELL * 0.5) {
      if (!at(sx + ux * d, sz + uz * d)) continue;
      if (dFace < 0) dFace = d;
      dExit = d;
    }
    if (dFace < 0) continue;                       // this bearing misses it
    /**
     * ONLY A CROSSING COUNTS. A bearing that clips a corner of the eroded core
     * and leaves again through the same corner proves nothing in either
     * direction: the capsule may legitimately never reach a wall, and a stop
     * would say as little. MEASURED: with grazes counted, the residue was 3.1%
     * of bearings and every sample inspected was a chord under 2 m across a
     * corner where a gable oversails the plan or a porch closes a pocket the
     * outside flood cannot reach.
     *
     * A MISSING wall is not a graze. The chord through a hole runs the width of
     * the building, so nothing this filter drops could have been one.
     */
    if (dExit - dFace < 2.0) continue;
    /**
     * AND THE PICTURE MUST PUT SOMETHING IN HIS WAY ON THE WAY IN.
     *
     * Steel City is on hills and a lot is founded on the LOWEST corner of its
     * own footprint, so a single-storey house is buried to its eaves at the
     * uphill end: the man walks in over the roof, the massing grid only starts
     * where the roof clears his head, and the "face" he crosses is a slope cut
     * in the middle of the house with no wall drawn anywhere near it. A shell
     * that let him through there would be RIGHT, and the probe was calling it a
     * hole — measured, 12 of the 13 "ghosts" on the full-city run were that.
     *
     * So the bearing counts only if the DRAWING actually stands over the
     * walkable surface where he enters — 1.2 m of it, chest height on a 1.7 m
     * capsule and well past anything he could step over. Where the picture is
     * under his feet there is nothing here to assert; where the picture has a
     * hole, that is roadsweep's business and not this gate's.
     */
    const fx = sx + ux * dFace, fz = sz + uz * dFace;
    const fi = Math.floor((fx - ox) / CELL), fj = Math.floor((fz - oz) / CELL);
    if (fi < 0 || fj < 0 || fi >= NX || fj >= NZ) continue;
    if (topY[fj * NX + fi] < groundAt(fx, fz) + 1.2) continue;
    tested++;
    /**
     * THE MAN'S FEET ARE AT THE WALL, NOT AT THE START OF THE SWEEP.
     *
     * Steel City is built on hills and a lot sits on the LOWEST corner of its
     * own footprint (see _plans), so the walkable surface eight metres out can
     * be metres below the base of the wall or above its eaves. Taking the
     * capsule's height from the start point then sweeps it UNDER a hillside
     * house or OVER it, and the miss is the terrain's, not the shell's:
     * measured on a 9 m house at (1131, -278) whose four-edge shell is complete,
     * 11 of 16 bearings "failed" that way. The band that matters is the one a
     * man occupies where he MEETS the wall.
     */
    const gy = groundAt(sx + ux * dFace, sz + uz * dFace);
    const hit = sw.sweepCapsule(sx, gy + CAP_LO, sz, sx, gy + CAP_HI, sz, CAP_R,
      ux, 0, uz, rad * 2, MASK, raw);
    const over = hit ? raw.t - dFace : Infinity;
    if (hit && over <= TOL) sealed++;
    else {
      if (over > worst) worst = over === Infinity ? 999 : over;
      const fi = Math.floor((sx + ux * dFace - ox) / CELL);
      const fj = Math.floor((sz + uz * dFace - oz) / CELL);
      const w = (fi >= 0 && fj >= 0 && fi < NX && fj < NZ) ? owner[fj * NX + fi] : -1;
      marks.push({ at: [+sx.toFixed(1), +sz.toFixed(1)], stop: hit ? +raw.t.toFixed(1) : null,
                   face: +dFace.toFixed(1), drew: w >= 0 ? names[w] : '?' });
    }
  }

  let map = null;
  if (wantMap && (wantMap === 'ghost' ? tested >= 6 && sealed < tested / 3 : sealed < tested)) {
    // The SHELL, rasterised the same way, so the picture says WHERE the two
    // producers disagree rather than only that they do.
    const shell = new Uint8Array(NX * NZ);
    target = shell;
    for (const cm of built.colMeshes ?? []) {
      const g = cm.geometry;
      const pos = g.attributes.position, idx = g.index;
      const n = idx ? idx.count : pos.count;
      for (let t = 0; t + 2 < n; t += 3) {
        const ia = idx ? idx.getX(t) : t, ib = idx ? idx.getX(t + 1) : t + 1, ic = idx ? idx.getX(t + 2) : t + 2;
        a.fromBufferAttribute(pos, ia).applyMatrix4(cm.matrixWorld);
        b.fromBufferAttribute(pos, ib).applyMatrix4(cm.matrixWorld);
        c.fromBufferAttribute(pos, ic).applyMatrix4(cm.matrixWorld);
        const gy = groundAt((a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3);
        const yLo = Math.min(a.y, b.y, c.y), yHi = Math.max(a.y, b.y, c.y);
        if (yHi > gy + 0.4 && yLo < gy + 2.4) stamp();
      }
    }
    const rows = [];
    const step = Math.max(1, Math.ceil(NX / 110));
    for (let j = 0; j < NZ; j += step) {
      let r = '';
      for (let i = 0; i < NX; i += step) {
        const k = j * NX + i;
        r += shell[k] ? (solid[k] ? '#' : 'C') : (solid[k] ? 'D' : '.');
      }
      rows.push(r);
    }
    map = rows;
  }
  return { tested, sealed, worst: +worst.toFixed(1), area: +(area * CELL * CELL).toFixed(0), colTris, marks: marks.slice(0, 4), map };
}

/* ---------------------------------------------------------------------- */
const perArch = {};
const ghosts = [];
let buildings = 0, tilesSeen = 0, planFail = 0, buildFail = 0;
let mapped = null;

const note = (key, m, x, z) => {
  const s = perArch[key] ??= { n: 0, tested: 0, sealed: 0, ghosts: 0, worst: 0, ex: [] };
  s.n++; s.tested += m.tested; s.sealed += m.sealed;
  if (m.worst > s.worst) s.worst = m.worst;
  if (m.tested >= 6 && m.sealed < m.tested / 3) {
    s.ghosts++;
    ghosts.push({ arch: key, x: +x.toFixed(1), z: +z.toFixed(1), sealed: m.sealed, tested: m.tested, area: m.area, colTris: m.colTris });
  }
  if (m.sealed < m.tested && s.ex.length < 3) s.ex.push({ x: +x.toFixed(1), z: +z.toFixed(1), sealed: m.sealed, tested: m.tested, marks: m.marks });
};

const free = (built) => {
  built.group.traverse((o) => {
    if (o.isInstancedMesh) { o.dispose?.(); return; }
    if (o.isMesh) o.geometry?.dispose();
  });
  for (const cm of built.colMeshes ?? []) cm.geometry?.dispose();
};

/* ---- generated lots -------------------------------------------------- */
const keys = [...(world._lotsByTile?.keys() ?? [])];
const useKeys = ARG.tiles ? keys.slice(0, ARG.tiles) : keys;
for (const key of useKeys) {
  const [tx, tz] = key.split(',').map(Number);
  const lots = world.lotsInTile(tx, tz);
  if (!lots?.length) continue;
  tilesSeen++;
  let plans;
  try { plans = B._plans({ tx, tz, key, lots, plans: null }); } catch (err) { planFail++; continue; }
  for (const plan of plans) {
    let built = null;
    try {
      const T = new TileBuilder(B.lib, 'solid');
      B.buildPlan(T, plan, 0);
      built = T.build(null);
    } catch (err) { buildFail++; continue; }
    try {
      const m = measure(built, plan.centroid[0], plan.centroid[1],
        ARG.map && (ARG.map === "*" || ARG.map === "ghost" || ARG.map === plan.arch) && !mapped ? ARG.map : false);
      if (m) {
        buildings++;
        note(plan.arch, m, plan.centroid[0], plan.centroid[1]);
        if (m.map && !mapped) mapped = { arch: plan.arch, x: plan.centroid[0], z: plan.centroid[1], rows: m.map, marks: m.marks };
      }
    } catch (err) { /* measurement of one building must not end the sweep */ }
    free(built);
  }
}

/* ---- landmarks -------------------------------------------------------- */
const perLm = {};
for (const lm of LANDMARKS) {
  let built = null;
  try {
    const T = new TileBuilder(B.lib, 'solid_' + lm.id);
    B.buildLandmarkPlan(T, lm);
    built = T.build(null);
  } catch (err) { continue; }
  try {
    const m = measure(built, lm.x, lm.z, false);
    if (m) perLm[lm.id] = { tested: m.tested, sealed: m.sealed, area: m.area, colTris: m.colTris, worst: m.worst };
  } catch (err) { /* keep going */ }
  free(built);
}

return { perArch, perLm, ghosts: ghosts.slice(0, 40), ghostN: ghosts.length,
         buildings, tilesSeen, planFail, buildFail, mapped };
`;

/* ==================================================================== */

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const pageErrors = [];
page.on('pageerror', (e) => { if (pageErrors.length < 20) pageErrors.push(String(e.message).slice(0, 200)); });

let exitCode = 0;
try {
  await page.goto(`http://127.0.0.1:${port}/?q=low&prewarm=0&capture=1&lockstep=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });

  if (LEGACY) {
    /**
     * THE NEGATIVE CONTROL. `archetypes.collisionOpts.volumeShell = false`
     * reverts collision authoring to the facade kit — `slabBox` per elevation
     * and `solidSlabs` on the ground floor, glazed holes and all — which is
     * exactly what the city shipped. Nothing else changes: same plans, same
     * geometry, same probe.
     */
    const ok = await page.evaluate(async () => {
      const m = await import('/src/buildings/archetypes.js');
      if (!m.collisionOpts) return false;
      m.collisionOpts.volumeShell = false;
      return true;
    });
    if (!ok) throw new Error('cannot reach archetypes.collisionOpts — control not applied');
    log('  [negative control] volume collision shell OFF — gates 1 and 2 must go red');
  }

  log(`\nsolid probe — every lot ${TILES ? `in the first ${TILES} tiles` : 'in the city'}` +
      `${LEGACY ? ' [--legacy]' : ''}`);
  const t0 = Date.now();
  const R = await page.evaluate(
    ({ s, x }) => {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      return new AsyncFunction('ARG', s)(x);
    },
    { s: PROBE, x: { tiles: TILES, cell: 0.5, tol: 1.5, map: MAP, nokerb: NOKERB } }
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  log(`\n  ${R.buildings} buildings over ${R.tilesSeen} lot tiles in ${secs}s` +
      `${R.planFail ? `, ${R.planFail} tile(s) unplannable` : ''}` +
      `${R.buildFail ? `, ${R.buildFail} build(s) threw` : ''}\n`);

  const rows = Object.entries(R.perArch).sort((a, b) => b[1].n - a[1].n);
  let tested = 0, sealed = 0;
  let worstArch = null;
  log('  archetype      n     bearings   sealed    ghosts');
  for (const [k, s] of rows) {
    tested += s.tested; sealed += s.sealed;
    const f = s.tested ? s.sealed / s.tested : 1;
    if (!worstArch || f < worstArch[1]) worstArch = [k, f];
    log(`  ${k.padEnd(12)} ${String(s.n).padStart(5)} ${String(s.tested).padStart(10)} ` +
        `${(f * 100).toFixed(1).padStart(8)}% ${String(s.ghosts).padStart(9)}` +
        (s.sealed < s.tested ? `   worst overshoot ${s.worst} m` : ''));
  }
  const overall = tested ? sealed / tested : 0;

  /**
   * LANDMARKS, AND THE HONEST VERSION OF THE QUESTION.
   *
   * Two of the six have no enclosed massing to measure and that is CORRECT, not
   * a miss: The Point Fountain is a plaza with a 1.1 m basin on it and the
   * Duquesne Incline is a timber trestle up a cliff. Neither is a building and
   * neither should stop a man walking round it, so neither produces a footprint
   * this probe can seed a bearing from. They are reported as "open" and the
   * count of them is asserted, so a landmark that LOSES its massing shows up.
   */
  log('\n  landmark          bearings   sealed   col tris');
  const lmBad = [];
  let lmOpen = 0;
  for (const id of LANDMARK_IDS) {
    const s = R.perLm[id];
    if (!s || s.tested < 6) {
      lmOpen++;
      log(`  ${id.padEnd(16)} ${'—'.padStart(9)} ${'open, no enclosed massing'.padStart(28)}` +
          (s ? ` ${String(s.colTris).padStart(6)}` : ''));
      continue;
    }
    const f = s.sealed / s.tested;
    log(`  ${id.padEnd(16)} ${String(s.tested).padStart(9)} ${(f * 100).toFixed(1).padStart(8)}% ${String(s.colTris).padStart(10)}`);
    if (f < RATCHET.lmSeal) lmBad.push(`${id}: ${s.sealed}/${s.tested}`);
  }

  log('');
  rec('1 SEALED   the shell stops a man where the drawing says a wall is',
    overall >= RATCHET.seal && (worstArch?.[1] ?? 0) >= RATCHET.archSeal,
    `${sealed}/${tested} bearings = ${(overall * 100).toFixed(2)}% (ratchet ${(RATCHET.seal * 100).toFixed(1)}%), ` +
    `worst archetype ${worstArch?.[0]} ${((worstArch?.[1] ?? 0) * 100).toFixed(1)}% (ratchet ${(RATCHET.archSeal * 100).toFixed(0)}%)`);

  rec('2 SOLID    no drawn building is a ghost a man walks through',
    R.ghostN <= RATCHET.ghosts,
    `${R.ghostN} ghost(s) (ratchet ${RATCHET.ghosts})` +
    (R.ghostN ? ` — e.g. ${R.ghosts.slice(0, 3).map((g) => `${g.arch} at (${g.x}, ${g.z}) ${g.sealed}/${g.tested}, ${g.area} m², ${g.colTris} col tris`).join('; ')}` : ''));

  const seen = Object.keys(R.perArch).sort();
  const missing = ARCHETYPES.filter((a) => !seen.includes(a));
  const extra = seen.filter((a) => !ARCHETYPES.includes(a));
  rec('3 COVERAGE every archetype the planner emits was measured',
    missing.length === 0 && extra.length === 0,
    `${seen.length}/${ARCHETYPES.length} archetypes (landmarks are gate 4)` +
    (missing.length ? ` — NOT TESTED: ${missing.join(', ')}` : '') +
    (extra.length ? ` — UNDECLARED, add it to ARCHETYPES: ${extra.join(', ')}` : ''));

  rec('4 LANDMARKS every authored building that encloses mass stops a man',
    lmBad.length === 0 && lmOpen <= 2,
    (lmBad.length ? `UNSEALED ${lmBad.join('; ')} (ratchet ${(RATCHET.lmSeal * 100).toFixed(0)}%); ` : '') +
    `${LANDMARK_IDS.length - lmOpen}/${LANDMARK_IDS.length} enclose massing, ` +
    `${lmOpen} open (the fountain plaza and the incline trestle; ratchet 2)`);

  if (R.mapped) {
    log(`\n  drawn footprint of a failing ${R.mapped.arch} at (${R.mapped.x.toFixed(0)}, ${R.mapped.z.toFixed(0)}):`);
    for (const r of R.mapped.rows) log('    ' + r);
    log(`    unsealed bearings [startX, startZ, capsule stopped at, drawn face at]: ${JSON.stringify(R.mapped.marks)}`);
  }

  if (pageErrors.length) rec('no page errors', false, pageErrors.join(' | '));

  const failed = results.filter((r) => !r.ok);
  log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (JSON_OUT) console.log(JSON.stringify({ legacy: LEGACY, overall, results, perArch: R.perArch, perLm: R.perLm, ghostN: R.ghostN }, null, 2));
  exitCode = failed.length ? 1 : 0;

  if (LEGACY) {
    const broke = results.some((r) => !r.ok && /^1 /.test(r.name));
    log(broke
      ? '  negative control OK: without the volume shell, SEALED fails'
      : '  NEGATIVE CONTROL DID NOT REPRODUCE — this gate is not measuring anything');
    exitCode = broke ? 0 : 1;
  }
} catch (e) {
  console.error('solidprobe failed:', e?.stack ?? e?.message ?? e);
  exitCode = 1;
} finally {
  await browser.close();
  server?.kill();
}
process.exit(exitCode);
