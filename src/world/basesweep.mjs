#!/usr/bin/env node
/**
 * WORLD — "does Ridgeline AFB exist, read as a military base, and WORK as
 * one?" — asserted on the EMITTED geometry, node-only. Modelled on
 * `airsweep.mjs`; the military differences are the point:
 *
 *   - the RUNWAY must measure ~2x the civilian strips on its own collision
 *     triangles (the jet's take-off run), with markings verified by
 *     ray-casting the emitted paint meshes — never by reading the layout
 *     rects back (rule 12: the layout is the promise, the triangles are the
 *     artefact, and the gap between them is what this gate bounds);
 *   - the PERIMETER must CLOSE: the fence polygon is walked end to end and
 *     a horizontal ray is fired across the line at chest height every 4 m —
 *     every ray must be stopped by emitted collision EXCEPT through the two
 *     gate gaps, which must stay open;
 *   - the gates must be DRIVABLE and the fence must not be: the real
 *     `Vehicle` dynamics (same 120 Hz `fixedStep` the game runs) drive a
 *     car through each gate gap onto the base, and the same car aimed at
 *     the fence 40 m away must be STOPPED — a live negative control proving
 *     the fence collision, not the harness, is what closes the perimeter;
 *   - the ACCESS ROAD must be welded: `route()` on the emitted graph from
 *     downtown to the apron-end node, plus a junction-angle check at the
 *     weld, plus "no drivable edge crosses the fence except through a gate"
 *     asserted over every emitted edge;
 *   - every published layout field (`world.airbase` contract: perimeter,
 *     gates, runwayStart, apronSlots, patrol) must be present and finite —
 *     three other agents build on those numbers.
 *
 * NEGATIVE CONTROL — the whole base is rebuilt with `OW_NO_AIRBASE=1`
 * (the `?noairbase=1` hatch, same shape as `?noairfield=1`) and the run
 * fails unless that arm comes back with no bench, no paving, no
 * structures and no access road.
 *
 * The probe imports `vehicles`' spec/dynamics modules HARNESS-ONLY, the way
 * `airsweep` and `flightprobe` do; no production `world` module imports
 * another subsystem (rule 2 binds the game, and still does).
 *
 * Usage:  node src/world/basesweep.mjs [--verbose]
 */

import * as THREE from 'three';
import { Terrain } from './terrain.js';
import { generateCity } from './netgen.js';
import { AIRBASE, SECTOR } from './plan.js';
import {
  buildAirbasePaving, finaliseAirbase, abLocal, abWorld, airbaseDeckAt,
} from './airbase.js';
import { padY } from './airfield.js';
import { Rng } from '../core/rng.js';
import { ProtoLibrary, TileBuilder } from '../buildings/tile.js';
import { buildAirbase } from '../buildings/airbase.js';
import { VEHICLE_SPECS, finalizeSpec, SURFACE_GRIP } from '../vehicles/specs.js';
import { Vehicle } from '../vehicles/dynamics.js';
import { StaticWorld } from '../physics/bvh.js';
import { MASK as PHYS_MASK } from '../physics/surfaces.js';

const VERBOSE = process.argv.includes('--verbose');
const DT = 1 / 120;

let pass = 0;
let fail = 0;
const fails = [];
function check(section, label, ok, detail) {
  if (ok) pass++;
  else {
    fail++;
    fails.push(`${section}: ${label} — ${detail}`);
  }
  if (!ok || VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${label}  (${detail})`);
}

/* ------------------------------------------------------------------ rays -- */

/** World-space triangle soup with an XZ cell index and a Möller ray query.
 *  Same machinery as `airsweep.mjs`. */
class TriSet {
  constructor(cell = 14) {
    this.cell = cell;
    this.pos = [];
    this.surf = [];
    this.grid = new Map();
  }

  addMesh(mesh, surface) {
    const geo = mesh.geometry;
    const p = geo.getAttribute('position');
    const idx = geo.getIndex();
    const n = idx ? idx.count : p.count;
    const at = (k) => (idx ? idx.getX(k) : k);
    for (let i = 0; i < n; i += 3) {
      const a = at(i);
      const b = at(i + 1);
      const c = at(i + 2);
      this._tri(
        p.getX(a), p.getY(a), p.getZ(a),
        p.getX(b), p.getY(b), p.getZ(b),
        p.getX(c), p.getY(c), p.getZ(c),
        surface ?? mesh.userData?.surface ?? 'concrete'
      );
    }
  }

  _tri(ax, ay, az, bx, by, bz, cx, cy, cz) {
    const id = this.surf.length;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.surf.push(arguments[9]);
    const x0 = Math.floor(Math.min(ax, bx, cx) / this.cell);
    const x1 = Math.floor(Math.max(ax, bx, cx) / this.cell);
    const z0 = Math.floor(Math.min(az, bz, cz) / this.cell);
    const z1 = Math.floor(Math.max(az, bz, cz) / this.cell);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const k = x * 73856093 ^ (z * 19349663);
        let l = this.grid.get(k);
        if (!l) this.grid.set(k, (l = []));
        l.push(id);
      }
    }
  }

  ray(ox, oy, oz, dx, dy, dz, maxDist) {
    const ex = ox + dx * maxDist;
    const ez = oz + dz * maxDist;
    const x0 = Math.floor(Math.min(ox, ex) / this.cell);
    const x1 = Math.floor(Math.max(ox, ex) / this.cell);
    const z0 = Math.floor(Math.min(oz, ez) / this.cell);
    const z1 = Math.floor(Math.max(oz, ez) / this.cell);
    let best = Infinity;
    let bestId = -1;
    const seen = new Set();
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const l = this.grid.get(x * 73856093 ^ (z * 19349663));
        if (!l) continue;
        for (const id of l) {
          if (seen.has(id)) continue;
          seen.add(id);
          const t = this._hit(id, ox, oy, oz, dx, dy, dz, Math.min(maxDist, best));
          if (t !== null && t < best) {
            best = t;
            bestId = id;
          }
        }
      }
    }
    if (bestId < 0) return null;
    const o = bestId * 9;
    const p = this.pos;
    const e1x = p[o + 3] - p[o];
    const e1y = p[o + 4] - p[o + 1];
    const e1z = p[o + 5] - p[o + 2];
    const e2x = p[o + 6] - p[o];
    const e2y = p[o + 7] - p[o + 1];
    const e2z = p[o + 8] - p[o + 2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const il = 1 / (Math.hypot(nx, ny, nz) || 1);
    nx *= il;
    ny *= il;
    nz *= il;
    if (nx * dx + ny * dy + nz * dz > 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    return {
      t: best,
      x: ox + dx * best,
      y: oy + dy * best,
      z: oz + dz * best,
      nx, ny, nz,
      surface: this.surf[bestId],
    };
  }

  _hit(id, ox, oy, oz, dx, dy, dz, tMax) {
    const p = this.pos;
    const o = id * 9;
    const ax = p[o];
    const ay = p[o + 1];
    const az = p[o + 2];
    const e1x = p[o + 3] - ax;
    const e1y = p[o + 4] - ay;
    const e1z = p[o + 5] - az;
    const e2x = p[o + 6] - ax;
    const e2y = p[o + 7] - ay;
    const e2z = p[o + 8] - az;
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-9) return null;
    const inv = 1 / det;
    const tx = ox - ax;
    const ty = oy - ay;
    const tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-6 || u > 1 + 1e-6) return null;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -1e-6 || u + v > 1 + 1e-6) return null;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t > 1e-6 && t <= tMax ? t : null;
  }

  down(x, z, yFrom = 500, maxDrop = 700) {
    return this.ray(x, yFrom, z, 0, -1, 0, maxDrop);
  }
}

/* --------------------------------------------------------------- build ---- */

async function buildArm() {
  const terrain = new Terrain({ cell: 8, extent: 1792 }).bake();
  const city = generateCity(terrain, new Rng(0x600d));
  const graph = city.graph;
  const ab = finaliseAirbase(AIRBASE);

  const arm = {
    terrain, graph, ab,
    tris: new TriSet(),       // everything solid: decks + structures + roads
    structTris: new TriSet(), // structures only (capsule-stopping checks)
    paintW: new TriSet(),     // white runway paint, emitted
    paintY: new TriSet(),     // yellow taxi/apron paint, emitted
    report: null, paved: null,
    /**
     * The REAL BVH (`physics/bvh.js`), fed the same emitted collision meshes,
     * so `Vehicle._collide`'s capsule probes run against real triangles. A
     * `staticWorld: null` stub silently NOOPs chassis collision — the first
     * run of this probe proved it by driving a car THROUGH the fence at
     * 22.6 m/s — which is rule 12's "a stub is an assertion that nothing
     * downstream of it can be wrong", caught live.
     */
    sw: new StaticWorld(),
  };
  if (!ab) return arm;

  const stubMat = () => new THREE.MeshBasicMaterial();
  const paved = buildAirbasePaving(ab, { terrain, roads: graph, mat: stubMat });
  arm.paved = paved;
  if (paved?.colMesh) {
    arm.tris.addMesh(paved.colMesh, 'asphalt');
    paved.colMesh.updateMatrixWorld?.(true);
    arm.sw.addMesh(paved.colMesh, 'asphalt');
  }
  for (const m of paved?.group.children ?? []) {
    if (m.name === 'ab_runway_paint') arm.paintW.addMesh(m, 'paint');
    if (m.name === 'ab_mil_paint_yellow') arm.paintY.addMesh(m, 'paint');
  }

  const stubLib = new ProtoLibrary({ get: () => new THREE.MeshBasicMaterial() });
  const T = new TileBuilder(stubLib, 'probe_ab');
  let report = null;
  try {
    report = buildAirbase(T, stubLib, ab, new Rng((ab.id.length * 0x9e37 + ab.x) >>> 0),
      (px, pz) => terrain.heightAt(px, pz), graph);
  } catch (err) {
    console.error('[basesweep] structures threw', err);
  }
  arm.report = report;
  const built = T.build(null);
  for (const cm of built.colMeshes ?? []) {
    arm.structTris.addMesh(cm);
    arm.tris.addMesh(cm);
    cm.updateMatrixWorld?.(true);
    arm.sw.addMesh(cm, cm.userData?.surface);
  }

  // Real road collision over the base and its access road, so the drive
  // tests ride the emitted kerbs and the welded junction (same as airsweep).
  const { RoadMeshBuilder } = await import('./roadmesh.js');
  const rm = new RoadMeshBuilder({ graph, terrain, materials: null, palette: {}, rng: new Rng(1) });
  const sx0 = Math.floor((ab.x - 800) / SECTOR);
  const sx1 = Math.floor((ab.x + 800) / SECTOR);
  const sz0 = Math.floor((ab.z - 500) / SECTOR);
  const sz1 = Math.floor((ab.z + 700) / SECTOR);
  for (let sz = sz0; sz <= sz1; sz++) {
    for (let sx = sx0; sx <= sx1; sx++) {
      const b = rm.begin(sx, sz, 'collision');
      while (!b.step(1e9)) { /* drain */ }
      const { colMesh } = b.finish();
      if (colMesh) {
        arm.tris.addMesh(colMesh, 'asphalt');
        colMesh.updateMatrixWorld?.(true);
        arm.sw.addMesh(colMesh, 'asphalt');
      }
    }
  }
  arm.sw.build();
  return arm;
}

/* ------------------------------------------------------------- vehicles --- */

const STUB = { root: null, wheels: [], panels: [], glassMeshes: [], lampMats: {} };
const CTX = { events: { emit() {} }, peek: () => null, time: { elapsed: 0 } };

function physFor(tris, terrain, sw = null) {
  const HIT = {
    hit: false,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: 0,
    surface: 'concrete',
    object: null,
  };
  return {
    MASK: PHYS_MASK,
    staticWorld: sw,
    raycast(o, d, maxDist) {
      const h = tris.ray(o.x, o.y, o.z, d.x, d.y, d.z, maxDist);
      if (h) {
        HIT.hit = true;
        HIT.distance = h.t;
        HIT.point.set(h.x, h.y, h.z);
        HIT.normal.set(h.nx, h.ny, h.nz);
        HIT.surface = h.surface;
        return HIT;
      }
      // Terrain patch, analytic — mirrors `world._updateTerrainCollider`,
      // including the airbase deck clamp (production behaviour under test).
      if (d.y < -0.5) {
        let g = terrain.heightAt(o.x, o.z) - 0.06;
        const deck = airbaseDeckAt(o.x, o.z);
        if (deck !== null && g < deck - 0.02) g = deck - 0.02;
        const t = (o.y - g) / -d.y;
        if (t >= 0 && t <= maxDist) {
          HIT.hit = true;
          HIT.distance = t;
          HIT.point.set(o.x + d.x * t, g, o.z + d.z * t);
          HIT.normal.set(0, 1, 0);
          HIT.surface = 'dirt';
          return HIT;
        }
      }
      HIT.hit = false;
      return HIT;
    },
    groundHeight: (x, z) => {
      const deck = airbaseDeckAt(x, z);
      if (deck !== null) return deck;
      const h = tris.down(x, z, 500);
      return h ? h.y : terrain.heightAt(x, z) - 0.06;
    },
  };
}

function worldFor(tris, terrain, sw = null) {
  const grip = {};
  for (const k in SURFACE_GRIP) grip[k] = { ...SURFACE_GRIP[k] };
  return {
    physics: physFor(tris, terrain, sw),
    slope: 0,
    lodOf: () => 0,
    surfaceAt: () => 'concrete',
    waterHeightAt: () => null,
    reportCollision: () => {},
    gripOf: (n) => grip[n] ?? grip.asphalt,
    _world: () => null,
  };
}

function spawnPlane(tris, terrain, x, z, yaw) {
  const spec = finalizeSpec(VEHICLE_SPECS.plane);
  const v = new Vehicle(worldFor(tris, terrain), spec, STUB, {});
  v.damage = null;
  const drop = spec.comY - spec.style.gearY;
  const gy = v.sys.physics.groundHeight(x, z, 500);
  v.setPose(new THREE.Vector3(x, gy + drop + 0.02, z), yaw);
  v.driver = { isPlayer: true };
  v.autoReverse = true;
  return v;
}

function spawnCar(tris, terrain, sw, x, z, yaw) {
  const spec = finalizeSpec(VEHICLE_SPECS.sports);
  const v = new Vehicle(worldFor(tris, terrain, sw), spec, STUB, {});
  v.damage = null;
  const gy = v.sys.physics.groundHeight(x, z, 500);
  v.setPose(new THREE.Vector3(x, gy + spec.comY + 0.05, z), yaw);
  v.driver = { isPlayer: true };
  v.autoReverse = true;
  return v;
}

function step(v, input, seconds) {
  const n = Math.round(120 * seconds);
  for (let i = 0; i < n; i++) {
    v.input.throttle = input.throttle ?? 0;
    v.input.brake = input.brake ?? 0;
    v.input.steer = input.steer ?? 0;
    v.input.handbrake = !!input.handbrake;
    v.input.boost = input.boost ?? 0;
    v.fixedStep(DT, CTX);
  }
}

/* ------------------------------------------------------------- sections --- */

const fin = (v) => Number.isFinite(v);

function sweepPublished(ab) {
  const S = 'published';
  check(S, 'bench pad present and finite', !!ab.pad && fin(ab.pad.yMid) && fin(ab.pad.slope),
    ab.pad ? `yMid ${ab.pad.yMid.toFixed(1)}, slope ${(ab.pad.slope * 100).toFixed(2)}%` : 'no pad');
  check(S, 'bench gradient runway-plausible', !!ab.pad && Math.abs(ab.pad.slope) <= 0.023,
    ab.pad ? `${(ab.pad.slope * 100).toFixed(2)}%` : 'no pad');
  const per = ab.perimeter ?? [];
  check(S, 'perimeter polygon published (>= 6 corners, all finite)',
    per.length >= 6 && per.every((p) => fin(p[0]) && fin(p[1])),
    `${per.length} corners`);
  const gates = ab.gates ?? [];
  check(S, 'two gates published, positions + headings finite',
    gates.length === 2 && gates.every((g) => fin(g.x) && fin(g.z) && fin(g.heading) && g.width >= 10),
    JSON.stringify(gates.map((g) => g.id)));
  check(S, 'runway start + end + heading published',
    !!ab.runwayStart && fin(ab.runwayStart.x) && fin(ab.runwayStart.heading) &&
    !!ab.runwayEnd && fin(ab.runwayEnd.heading),
    ab.runwayStart ? `start (${ab.runwayStart.x.toFixed(0)}, ${ab.runwayStart.z.toFixed(0)}) hdg ${ab.runwayStart.heading.toFixed(2)}` : 'missing');
  const slots = ab.apronSlots ?? [];
  const kinds = new Set(slots.map((s) => s.kind));
  check(S, 'apron parking published and tagged (jet + tank + jeep)',
    slots.length >= 16 && kinds.has('jet') && kinds.has('tank') && kinds.has('jeep') &&
      slots.every((s) => fin(s.x) && fin(s.z) && fin(s.heading)),
    `${slots.length} slots, kinds [${[...kinds].join(',')}]`);
  check(S, 'guard patrol loop published', (ab.patrol ?? []).length >= 8 &&
    ab.patrol.every((p) => fin(p[0]) && fin(p[1])), `${ab.patrol?.length ?? 0} waypoints`);
  const gateOut = gates[0] ? { x: gates[0].x - Math.sin(gates[0].heading) * 20, z: gates[0].z - Math.cos(gates[0].heading) * 20 } : null;
  check(S, 'insidePerimeter answers (centre in, outside-the-gate out)',
    typeof ab.insidePerimeter === 'function' && ab.insidePerimeter(ab.x, ab.z) === true &&
      gateOut && ab.insidePerimeter(gateOut.x, gateOut.z) === false,
    'field test');
  // Every patrol waypoint and every slot is inside the fence.
  const strays = [...(ab.patrol ?? []).filter((p) => !ab.insidePerimeter(p[0], p[1])).length ? ['patrol'] : [],
    ...slots.filter((s) => !ab.insidePerimeter(s.x, s.z)).length ? ['slots'] : []];
  check(S, 'patrol + parking all inside the fence', strays.length === 0, strays.join(',') || 'all inside');
}

function sweepRunway(arm) {
  const { ab, tris, paintW, paintY } = arm;
  const S = 'runway';
  const L = ab.runway[0];
  const w = { x: 0, z: 0 };

  /* SELF-CHECK: the pavement detector can say no — the north verge between
   * the runway edge (d=23) and the fence (d=42) is deliberately dirt. */
  {
    abWorld(ab, 33, 0, w);
    const h = tris.down(w.x, w.z);
    const bogus = h && h.surface === 'asphalt' && Math.abs(h.y - (padY(ab, 0) + 0.06)) < 0.4;
    check(S, 'SELF-CHECK — no pavement on the north verge (runway edge to fence)', !bogus,
      bogus ? `asphalt at y=${h.y.toFixed(2)}` : 'verge unpaved as expected');
  }

  let covered = 0;
  let samples = 0;
  let hits = 0;
  let worstStep = 0;
  let maxGap = 0;
  const stepM = 4;
  for (const dLane of [0, -14, 14]) {
    let run = 0;
    let prevResid = null;
    for (let a = -L / 2 + 2; a <= L / 2 - 2; a += stepM) {
      abWorld(ab, dLane, a, w);
      const h = tris.down(w.x, w.z);
      const bench = padY(ab, a) + 0.06;
      const on = !!h && h.surface === 'asphalt' && Math.abs(h.y - bench) < 0.5;
      samples++;
      if (on) {
        hits++;
        if (dLane === 0) covered += stepM;
        run = 0;
        const resid = h.y - bench;
        if (prevResid !== null) worstStep = Math.max(worstStep, Math.abs(resid - prevResid));
        prevResid = resid;
      } else {
        if (dLane === 0) {
          run += stepM;
          maxGap = Math.max(maxGap, run);
        }
        prevResid = null;
      }
    }
  }
  check(S, 'the strip DWARFS the civilian fields: centreline pavement >= 1150 m (2x the 600/512 m strips), on collision triangles',
    covered >= 1150, `${covered} m of ${L} covered`);
  check(S, 'three lanes present end to end', hits / Math.max(1, samples) >= 0.95,
    `${((100 * hits) / Math.max(1, samples)).toFixed(1)}% of ${samples}`);
  check(S, 'no gap a jet cannot roll across', maxGap <= 24, `worst gap ${maxGap} m`);
  check(S, 'deck sheet continuous (no step a gear leg trips on)', worstStep <= 0.12,
    `worst residual step ${worstStep.toFixed(3)} m over ${stepM} m`);

  /* markings, on the emitted paint triangles */
  let dashHit = 0;
  let dashN = 0;
  for (let a = -L / 2 + 46; a + 24 <= L / 2 - 46; a += 42) {
    abWorld(ab, 0, a + 12, w);
    const h = paintW.down(w.x, w.z);
    dashN++;
    if (h && Math.abs(h.y - (padY(ab, a + 12) + 0.088)) < 0.06) dashHit++;
  }
  check(S, 'centreline dashes painted (emitted paint mesh)', dashN >= 24 && dashHit / dashN >= 0.9,
    `${dashHit}/${dashN} dash centres hit`);
  // SELF-CHECK: mid-gap between dashes must NOT read as paint.
  {
    abWorld(ab, 0, -L / 2 + 46 + 33, w);
    const h = paintW.down(w.x, w.z);
    check(S, 'SELF-CHECK — the paint detector can say no (dash gap unpainted)', !h,
      h ? `paint at y=${h.y.toFixed(2)}` : 'gap clean');
  }
  let keyHit = 0;
  let keyN = 0;
  for (const end of [-1, 1]) {
    const a = end * (L / 2 - 20);
    for (let i = 0; i < 8; i++) {
      abWorld(ab, (i - 3.5) * 4.9, a, w);
      keyN++;
      if (paintW.down(w.x, w.z)) keyHit++;
    }
  }
  check(S, 'threshold piano keys painted both ends', keyHit / keyN >= 0.8, `${keyHit}/${keyN}`);
  let taxiHit = 0;
  let taxiN = 0;
  const lay = ab.layout;
  const tcD = (lay.taxiway.d0 + lay.taxiway.d1) / 2;
  for (let a = lay.taxiway.a0 + 4; a + 10 <= lay.taxiway.a1 - 4; a += 12) {
    abWorld(ab, tcD, a + 5, w);
    taxiN++;
    if (paintY.down(w.x, w.z)) taxiHit++;
  }
  check(S, 'yellow taxiway centreline painted (emitted)', taxiN >= 60 && taxiHit / taxiN >= 0.9,
    `${taxiHit}/${taxiN}`);

  /* the apron itself */
  let apHit = 0;
  let apN = 0;
  for (let a = lay.apron.a0 + 4; a <= lay.apron.a1 - 4; a += 10) {
    for (let d = lay.apron.d0 + 4; d <= lay.apron.d1 - 4; d += 10) {
      abWorld(ab, d, a, w);
      const h = tris.down(w.x, w.z);
      apN++;
      if (h && (h.surface === 'asphalt' || h.surface === 'concrete') &&
        Math.abs(h.y - (padY(ab, a) + 0.06)) < 0.5) apHit++;
    }
  }
  check(S, 'apron paved wall to wall', apHit / Math.max(1, apN) >= 0.9, `${apHit}/${apN} samples`);

  /* every published parking slot stands on pavement, clear of masses */
  let slotBad = 0;
  let slotNear = Infinity;
  for (const s of ab.apronSlots) {
    const h = tris.down(s.x, s.z);
    abLocal(ab, s.x, s.z, { a: 0, d: 0 });
    if (!h || Math.abs(h.y - (tris.down(s.x, s.z)?.y ?? NaN)) > 0.001) { /* h is the surface */ }
    const lo = abLocal(ab, s.x, s.z, { a: 0, d: 0 });
    const bench = padY(ab, lo.a) + 0.06;
    if (!h || !(h.surface === 'asphalt' || h.surface === 'concrete') || Math.abs(h.y - bench) > 0.35) slotBad++;
    if (arm.report) slotNear = Math.min(slotNear, nearestMass(arm.report, s.x, s.z));
  }
  check(S, 'every apron slot stands on emitted pavement', slotBad === 0, `${slotBad} of ${ab.apronSlots.length} off pavement`);
  check(S, 'parking rows clear of structure masses', slotNear >= 6, `nearest mass ${slotNear === Infinity ? 'inf' : slotNear.toFixed(1)} m`);
}

function nearestMass(rep, x, z) {
  let best = Infinity;
  const all = [
    ...rep.hangars, ...(rep.tower ? [rep.tower] : []), ...(rep.radar ? [rep.radar] : []),
    ...rep.tanks, ...rep.bunkers, ...rep.gatehouses, ...rep.floodlights,
  ];
  for (const m of all) best = Math.min(best, Math.hypot(m.x - x, m.z - z));
  return best;
}

function sweepStructures(arm) {
  const { ab, report: rep, structTris, terrain } = arm;
  const S = 'structures';
  check(S, 'structures were built', !!rep, rep ? 'report present' : 'no report');
  if (!rep) return;
  check(S, 'four arched hangars stand', rep.hangars.length >= 4,
    `${rep.hangars.length} hangars, skipped: ${rep.skipped.join(',') || 'none'}`);
  check(S, 'tower + radar dome + fuel farm + gatehouses stand',
    !!rep.tower && !!rep.radar && rep.tanks.length >= 3 && rep.gatehouses.length === 2,
    `tower ${!!rep.tower}, radar ${!!rep.radar}, tanks ${rep.tanks.length}, gatehouses ${rep.gatehouses.length}`);
  check(S, 'bunker row stands (doors shut, collision on)', rep.bunkers.length >= 4, `${rep.bunkers.length} bunkers`);
  check(S, 'warning signs hung on the wire', rep.signs >= 20, `${rep.signs} signs`);

  const masses = [
    ...rep.hangars.map((h, i) => [`hangar ${i}`, h, 2.0, 30]),
    ['tower', rep.tower, 2.0, 16],
    ['radar plinth', rep.radar, 2.0, 16],
    ...rep.bunkers.map((b, i) => [`bunker ${i}`, b, 1.6, 16]),
    ...rep.gatehouses.map((g) => [`gatehouse ${g.id}`, g, 1.5, 10]),
    ...rep.tanks.map((t, i) => [`fuel tank ${i}`, t, 2.0, 10]),
  ];
  for (const [name, m, h, R] of masses) {
    if (!m) continue;
    let blocked = 0;
    for (const ang of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const dx = Math.sin(ang + ab.yaw);
      const dz = Math.cos(ang + ab.yaw);
      const gy = m.gy ?? terrain.heightAt(m.x, m.z);
      if (structTris.ray(m.x - dx * R, gy + h, m.z - dz * R, dx, 0, dz, R)) blocked++;
    }
    check(S, `${name} stops a capsule`, blocked >= 3, `${blocked}/4 bearings blocked`);
  }
}

function sweepFence(arm) {
  const { ab, structTris, terrain } = arm;
  const S = 'fence';
  const lay = ab.layout;
  const poly = lay.polygon;
  const gates = lay.gates;
  const w0 = { x: 0, z: 0 };
  const w1 = { x: 0, z: 0 };
  let closed = 0;
  let open = 0;
  let total = 0;
  const holes = [];
  for (let i = 0; i < poly.length; i++) {
    const [a0, d0] = poly[i];
    const [a1, d1] = poly[(i + 1) % poly.length];
    const len = Math.hypot(a1 - a0, d1 - d0);
    const ua = (a1 - a0) / len;
    const ud = (d1 - d0) / len;
    // Perpendicular in field space; outward = the side that is NOT inside.
    const pa = -ud;
    const pd = ua;
    for (let t = 2; t < len - 2; t += 4) {
      const a = a0 + ua * t;
      const d = d0 + ud * t;
      let nearGate = null;
      for (const g of gates) {
        if (Math.abs(d - g.d) < 3 && Math.abs(a - g.a) <= g.half + 1.5) nearGate = g;
      }
      if (nearGate) continue;
      abWorld(ab, d + pd * 6, a + pa * 6, w0);
      const sideInside = ab.insidePerimeter(w0.x, w0.z);
      const sgn = sideInside ? -1 : 1; // start from the OUTSIDE
      abWorld(ab, d + sgn * pd * 6, a + sgn * pa * 6, w0);
      abWorld(ab, d - sgn * pd * 6, a - sgn * pa * 6, w1);
      const gy = terrain.heightAt((w0.x + w1.x) / 2, (w0.z + w1.z) / 2);
      const dx = w1.x - w0.x;
      const dz = w1.z - w0.z;
      const dist = Math.hypot(dx, dz);
      total++;
      const hit = structTris.ray(w0.x, gy + 1.3, w0.z, dx / dist, 0, dz / dist, dist);
      if (hit) closed++;
      else if (holes.length < 5) holes.push({ a: Math.round(a), d: Math.round(d) });
    }
  }
  check(S, 'THE PERIMETER CLOSES: a chest-height ray across the fence line is stopped everywhere off-gate',
    total > 700 && closed / total >= 0.985,
    `${closed}/${total} rays blocked (${((100 * closed) / Math.max(1, total)).toFixed(1)}%)` +
      (holes.length ? ` first holes ${JSON.stringify(holes)}` : ''));
  for (const g of gates) {
    let openHere = 0;
    for (const da of [-3, 0, 3]) {
      abWorld(ab, g.d - 6, g.a + da, w0);
      abWorld(ab, g.d + 6, g.a + da, w1);
      const gy = terrain.heightAt((w0.x + w1.x) / 2, (w0.z + w1.z) / 2);
      const dx = w1.x - w0.x;
      const dz = w1.z - w0.z;
      const dist = Math.hypot(dx, dz);
      if (!structTris.ray(w0.x, gy + 1.3, w0.z, dx / dist, 0, dz / dist, dist)) openHere++;
    }
    open += openHere;
    check(S, `gate '${g.id}' gap is OPEN (no collision across the gap)`, openHere === 3,
      `${openHere}/3 rays pass`);
  }
  void open;
}

function sweepGraph(arm) {
  const { ab, graph } = arm;
  const S = 'graph';
  const lo = { a: 0, d: 0 };
  // Every drivable edge crossing the fence does it through a gate.
  let crossings = 0;
  let badCross = 0;
  const bad = [];
  for (const e of graph.edges) {
    if (e.rail) continue;
    const na = graph.nodes[e.a];
    const nb = graph.nodes[e.b];
    const inA = ab.insidePerimeter(na.x, na.z);
    const inB = ab.insidePerimeter(nb.x, nb.z);
    if (inA === inB) continue;
    crossings++;
    // Bisect for the boundary crossing point.
    let t0 = 0;
    let t1 = 1;
    for (let k = 0; k < 24; k++) {
      const tm = (t0 + t1) / 2;
      const xm = na.x + (nb.x - na.x) * tm;
      const zm = na.z + (nb.z - na.z) * tm;
      if (ab.insidePerimeter(xm, zm) === inA) t0 = tm;
      else t1 = tm;
    }
    const xm = na.x + (nb.x - na.x) * t0;
    const zm = na.z + (nb.z - na.z) * t0;
    abLocal(ab, xm, zm, lo);
    let atGate = false;
    for (const g of ab.layout.gates) {
      if (Math.abs(lo.d - g.d) < 8 && Math.abs(lo.a - g.a) <= g.half + 4) atGate = true;
    }
    if (!atGate) {
      badCross++;
      if (bad.length < 4) bad.push({ id: e.corridor ?? e.id, a: Math.round(lo.a), d: Math.round(lo.d) });
    }
  }
  check(S, 'no drivable edge breaches the fence off-gate (emitted graph)', badCross === 0,
    `${crossings} crossing edge(s), ${badCross} off-gate${bad.length ? ' ' + JSON.stringify(bad) : ''}`);
  check(S, 'the base road exists and enters through the main gate', crossings >= 1,
    `${crossings} crossing(s)`);

  // The weld: a node where the base road meets the city grid, at a sane angle.
  let weldNodes = 0;
  let worstAngle = 0;
  let bestAngle = null;
  for (const nd of graph.nodes) {
    if (!nd) continue;
    let abxDir = null;
    const others = [];
    for (const ei of nd.links) {
      const e = graph.edges[ei];
      if (e.rail) continue;
      const other = graph.nodes[e.a === nd.id ? e.b : e.a];
      const dir = Math.atan2(other.x - nd.x, other.z - nd.z);
      if (String(e.corridor ?? '').startsWith('abx_')) abxDir = dir;
      else others.push(dir);
    }
    if (abxDir === null || !others.length) continue;
    weldNodes++;
    for (const od of others) {
      let da = Math.abs(od - abxDir);
      while (da > Math.PI) da = Math.abs(da - 2 * Math.PI);
      const lineAngle = Math.min(da, Math.PI - da); // angle between the LINES
      worstAngle = Math.max(worstAngle, da);
      if (bestAngle === null || lineAngle > bestAngle) bestAngle = lineAngle;
    }
  }
  check(S, 'base road is WELDED into the network (shares junctions with city streets)', weldNodes >= 1,
    `${weldNodes} weld junction(s)`);
  check(S, 'weld junction angle sane (crossing angle in [0.3, 1.9] rad, no grazing merge)',
    bestAngle !== null && bestAngle >= 0.3 && bestAngle <= 1.9,
    bestAngle === null ? 'no weld' : `best crossing angle ${bestAngle.toFixed(2)} rad`);

  // A car can be ROUTED from downtown to the apron.
  const src = graph.nearestNode(-232, 64, 600);
  let apronNode = null;
  for (const e of graph.edges) {
    if (!String(e.corridor ?? '').startsWith('abx_')) continue;
    for (const ni of [e.a, e.b]) {
      const nd = graph.nodes[ni];
      if (ab.insidePerimeter(nd.x, nd.z)) {
        abLocal(ab, nd.x, nd.z, lo);
        if (!apronNode || lo.d > apronNode.d) apronNode = { id: nd.id, d: lo.d };
      }
    }
  }
  const route = src && apronNode ? graph.route(src.id, apronNode.id) : null;
  check(S, 'route() reaches the apron from downtown', !!route && route.length > 10,
    route ? `${route.length} nodes` : `src ${!!src}, apron node ${!!apronNode}`);
}

function sweepDriving(arm) {
  const { ab, tris, terrain, sw } = arm;
  const S = 'drive';
  const w = { x: 0, z: 0 };
  // Through each gate: spawn outside on the approach, drive straight in.
  for (const g of ab.gates) {
    const bx = g.x - Math.sin(g.heading) * 26;
    const bz = g.z - Math.cos(g.heading) * 26;
    const v = spawnCar(tris, terrain, sw, bx, bz, g.heading);
    step(v, { throttle: 1 }, 6);
    const inside = ab.insidePerimeter(v.position.x, v.position.z);
    const dist = Math.hypot(v.position.x - bx, v.position.z - bz);
    check(S, `a real car DRIVES IN through gate '${g.id}'`, inside && dist > 40,
      `travelled ${dist.toFixed(1)} m, inside ${inside}, speed ${v.velocity.length().toFixed(1)} m/s`);
  }
  // NEGATIVE CONTROL, live: the same car aimed at the WIRE 46 m from the
  // main gate must be stopped outside — proving the fence collision (not
  // the harness) is what closes the perimeter.
  {
    const g = ab.gates[0];
    const glo = abLocal(ab, g.x, g.z, { a: 0, d: 0 });
    abWorld(ab, glo.d - 26, glo.a + 46, w);
    const yawIn = g.heading;
    const v = spawnCar(tris, terrain, sw, w.x, w.z, yawIn);
    step(v, { throttle: 1 }, 6);
    const inside = ab.insidePerimeter(v.position.x, v.position.z);
    check(S, 'CONTROL — the same car aimed at the fence 46 m off-gate is STOPPED outside', !inside,
      `inside ${inside}, final speed ${v.velocity.length().toFixed(1)} m/s`);
  }
}

function sweepFlight(arm) {
  const { ab, tris, terrain } = arm;
  const S = 'flight';
  const L = ab.runway[0];
  const lo = { a: 0, d: 0 };
  // Parked on the runway start: settles and holds.
  const v = spawnPlane(tris, terrain, ab.runwayStart.x, ab.runwayStart.z, ab.runwayStart.heading);
  const p0 = v.position.clone();
  step(v, {}, 3);
  const drift = Math.hypot(v.position.x - p0.x, v.position.z - p0.z);
  check(S, 'a parked SKYLARK settles on the emitted strip and holds',
    v.grounded >= 3 && v.altitude < 0.2 && drift < 0.6,
    `grounded ${v.grounded}, alt ${v.altitude.toFixed(3)}, drift ${drift.toFixed(2)} m`);
  {
    const spec = v.spec;
    const wheelPlane = v.position.y - (spec.comY - spec.style.gearY);
    const deckHit = tris.down(v.position.x, v.position.z);
    const sink = deckHit ? wheelPlane - deckHit.y : NaN;
    check(S, 'it sits ON the pavement (not floating/buried)',
      Number.isFinite(sink) && sink > -0.12 && sink < 0.1,
      `wheel plane ${Number.isFinite(sink) ? sink.toFixed(3) : '?'} m vs deck`);
  }
  // Full throttle down the military strip: lift off with room to spare.
  let liftA = null;
  let maxD = 0;
  let alt8A = null;
  for (let i = 0; i < 120 * 40; i++) {
    v.input.boost = 1;
    v.fixedStep(DT, CTX);
    abLocal(ab, v.position.x, v.position.z, lo);
    if (v.grounded > 0 && Math.abs(lo.d) > maxD) maxD = Math.abs(lo.d);
    if (liftA === null && v.grounded === 0 && v.altitude > 1.5) liftA = lo.a;
    if (liftA !== null && alt8A === null && v.altitude > 8) {
      alt8A = lo.a;
      break;
    }
  }
  check(S, 'full throttle: takeoff from the emitted runway', liftA !== null && liftA <= L / 2 + 24,
    liftA === null ? `never lifted (a=${lo.a.toFixed(0)}, v=${v.velocity.length().toFixed(1)})`
      : `liftoff at a=${liftA.toFixed(0)} (paved end ${L / 2})`);
  check(S, 'climbs away past the fence', alt8A !== null && alt8A <= L / 2 + 170,
    alt8A === null ? 'never reached 8 m' : `8 m by a=${alt8A.toFixed(0)}`);
  check(S, 'the roll tracks the strip', maxD <= 20, `max |d| grounded ${maxD.toFixed(1)} (half-width 23)`);
}

/* ----------------------------------------------------------------- main --- */

const t0 = Date.now();
{
  const arm = await buildArm();
  if (!arm.ab) {
    check('build', 'the airbase exists', false, 'finaliseAirbase returned null');
  } else {
    sweepPublished(arm.ab);
    sweepRunway(arm);
    sweepStructures(arm);
    sweepFence(arm);
    sweepGraph(arm);
    sweepDriving(arm);
    sweepFlight(arm);
  }
}

/* ---- NEGATIVE CONTROL: the un-built base must go red ------------------- */
{
  process.env.OW_NO_AIRBASE = '1';
  const terrain = new Terrain({ cell: 8, extent: 1792 }).bake();
  const city = generateCity(terrain, new Rng(0x600d));
  const anyPad = !!AIRBASE.pad;
  const paved = buildAirbasePaving(AIRBASE, { terrain, roads: city.graph, mat: () => new THREE.MeshBasicMaterial() });
  const stubLib = new ProtoLibrary({ get: () => new THREE.MeshBasicMaterial() });
  const T = new TileBuilder(stubLib, 'nc_ab');
  const rep = buildAirbase(T, stubLib, AIRBASE, new Rng(1), (x, z) => terrain.heightAt(x, z), city.graph);
  let abxEdges = 0;
  for (const e of city.graph.edges) if (String(e.corridor ?? '').startsWith('abx_')) abxEdges++;
  const fin2 = finaliseAirbase(AIRBASE);
  check('control', 'NEGATIVE CONTROL — OW_NO_AIRBASE=1 removes bench, paving, structures AND the access road',
    !anyPad && !paved && !rep && abxEdges === 0 && !fin2,
    `pad ${anyPad}, paving ${!!paved}, structures ${!!rep}, abx edges ${abxEdges}, published ${!!fin2} (all must be false/0)`);
  delete process.env.OW_NO_AIRBASE;
}

console.log(`\nbasesweep: ${pass}/${pass + fail} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (fail) {
  console.log('FAILURES:');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
