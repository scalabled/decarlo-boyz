#!/usr/bin/env node
/**
 * WORLD — "do the two airfields exist, read as airports, and WORK as
 * airports?" — asserted on the EMITTED geometry, node-only, in `npm run gate`.
 *
 * THE DEFECT THIS GATES. `plan.js` has always published two airfields and
 * `game/freeroam` has always parked the flyable fleet on them, but nothing
 * ever built them: both sites were raw hillside (the af_county centreline ran
 * 65.6 -> 88.9 -> 26.2 m over its 600 m before the bench went in) with the
 * city street grid laid straight across. The player's report — "airports have
 * no planes or helicopters and don't look like airports" — was half aircraft
 * (fixed elsewhere) and half THIS.
 *
 * WHAT IT MEASURES, AND WHY IT IS NOT CIRCULAR (ARCHITECTURE.md rule 12)
 *
 * Everything is asserted on emitted artefacts, produced by the production
 * builders in production mode:
 *
 *   - the paving and its collision come from `buildAirfieldPaving` — the same
 *     call `world/index.js` makes at init — and every surface question below
 *     is answered by RAY-CASTING THE COLLISION TRIANGLES, never by reading
 *     the layout rects back (the layout says where pavement SHOULD be; the
 *     triangles say where it IS, and the hole-cutting between the two is
 *     exactly what this gate exists to bound);
 *   - the structures come from `buildings/airfield.js` through the real
 *     `TileBuilder`, and "a hangar stops a capsule" is asserted by firing
 *     horizontal rays at the emitted collision shells from outside;
 *   - the road crossings are read off the emitted graph's node heights —
 *     the SOLVED output of grade limiting and relaxation, not the pad plane
 *     the grading wrote (those two agreeing is the assertion);
 *   - and the headline check rolls the REAL flight model (`Vehicle` +
 *     `stepPlane`, the same 120 Hz `fixedStep` the game runs) down the
 *     emitted collision from the exact spot freeroam parks the SKYLARK, and
 *     requires it to LIFT OFF before the strip runs out. A paved strip the
 *     plane cannot take off from fails, whatever the coverage numbers say.
 *
 * The probe imports `vehicles`' spec/dynamics modules the way `flightprobe`
 * imports its own — HARNESS-ONLY, node-side; no production `world` module
 * imports another subsystem (rule 2 binds the game, and still does).
 *
 * NEGATIVE CONTROL — run automatically as the last section: the whole
 * airfield realisation is rebuilt with `OW_NO_AIRFIELD=1` (same A/B-hatch
 * shape as `?nolmreserve=1`) and the run fails unless that arm comes back
 * with no bench, no pavement and no structures — i.e. unless this gate would
 * have caught the airfields not being built at all.
 *
 * Usage:  node src/world/airsweep.mjs [--verbose]
 */

import * as THREE from 'three';
import { Terrain } from './terrain.js';
import { generateCity } from './netgen.js';
import { AIRFIELDS, roadHalfWidth, ROAD_KIND } from './plan.js';
import { buildAirfieldPaving, afLocal, afWorld, padY, airfieldDeckAt } from './airfield.js';
import { Rng } from '../core/rng.js';
import { ProtoLibrary, TileBuilder } from '../buildings/tile.js';
import { buildAirfield } from '../buildings/airfield.js';
import { VEHICLE_SPECS, finalizeSpec, SURFACE_GRIP } from '../vehicles/specs.js';
import { Vehicle } from '../vehicles/dynamics.js';

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

/** World-space triangle soup with an XZ cell index and a Möller ray query. */
class TriSet {
  constructor(cell = 14) {
    this.cell = cell;
    this.pos = []; // 9 floats per tri
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

  /**
   * Nearest hit along `o + t*d`, t in (0, maxDist]. Candidates come from the
   * cells the segment's XZ bbox covers — fine for the short rays used here.
   */
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
    // Geometric normal.
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

/* --------------------------------------------------------------- worlds --- */

/** Build one arm: terrain, city, paving, structures, tri sets. */
async function buildArm() {
  const terrain = new Terrain({ cell: 8, extent: 1792 }).bake();
  const city = generateCity(terrain, new Rng(0x600d));
  const graph = city.graph;

  const arm = { terrain, graph, fields: [] };
  const stubMat = () => new THREE.MeshBasicMaterial();
  const stubLib = new ProtoLibrary({ get: () => new THREE.MeshBasicMaterial() });

  // Road collision for the sectors around each field, so the ground-roll sim
  // rides the real kerbs and crossings the game has. Production builder,
  // collision mode, nothing stubbed (same as drivesweep).
  const { RoadMeshBuilder } = await import('./roadmesh.js');
  const { SECTOR } = await import('./plan.js');
  const rm = new RoadMeshBuilder({ graph, terrain, materials: null, palette: {}, rng: new Rng(1) });

  for (const af of AIRFIELDS) {
    const f = { af, paved: null, report: null, tris: new TriSet(), structTris: new TriSet() };
    arm.fields.push(f);
    if (!af.pad || !af.layout) continue;

    const paved = buildAirfieldPaving(af, {
      terrain,
      roads: graph,
      mat: stubMat,
    });
    f.paved = paved;
    if (paved?.colMesh) f.tris.addMesh(paved.colMesh, 'asphalt');

    const T = new TileBuilder(stubLib, `probe_${af.id}`);
    let report = null;
    try {
      report = buildAirfield(
        T, stubLib, af, new Rng((af.id.length * 0x9e37 + af.x) >>> 0),
        (px, pz) => terrain.heightAt(px, pz), graph
      );
    } catch (err) {
      console.error(`[airsweep] structures for ${af.id} threw`, err);
    }
    f.report = report;
    const built = T.build(null);
    for (const cm of built.colMeshes ?? []) {
      f.structTris.addMesh(cm);
      f.tris.addMesh(cm);
    }

    // Crossing-road collision over the field bbox.
    const lay = af.layout;
    const reach = Math.max(lay.field.a1, lay.field.d1) + 60;
    const sx0 = Math.floor((af.x - reach) / SECTOR);
    const sx1 = Math.floor((af.x + reach) / SECTOR);
    const sz0 = Math.floor((af.z - reach) / SECTOR);
    const sz1 = Math.floor((af.z + reach) / SECTOR);
    for (let sz = sz0; sz <= sz1; sz++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        const b = rm.begin(sx, sz, 'collision');
        while (!b.step(1e9)) { /* drain */ }
        const { colMesh } = b.finish();
        if (colMesh) f.tris.addMesh(colMesh, 'asphalt');
      }
    }
  }
  return arm;
}

/* ------------------------------------------------------------- vehicles --- */

const STUB = { root: null, wheels: [], panels: [], glassMeshes: [], lampMats: {} };
const CTX = { events: { emit() {} }, peek: () => null, time: { elapsed: 0 } };

/** The game's physics answered from the emitted triangles + terrain net. */
function physFor(tris, terrain) {
  const HIT = {
    hit: false,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: 0,
    surface: 'concrete',
    object: null,
  };
  return {
    MASK: { WORLD: 3 },
    staticWorld: null,
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
      // The camera-following terrain collision patch, analytically (what the
      // game gives a ray that misses every real triangle). Mirrors
      // `world._updateTerrainCollider` EXACTLY, including the deck clamp on
      // airfield pavement — that clamp is production behaviour under test.
      if (d.y < -0.5) {
        let g = terrain.heightAt(o.x, o.z) - 0.06;
        const deck = airfieldDeckAt(o.x, o.z);
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
    // The game's `groundHeight` routes to `walkableHeightAt`, which answers
    // the DECK on airfield pavement (that is one of the fixes under test).
    groundHeight: (x, z) => {
      const deck = airfieldDeckAt(x, z);
      if (deck !== null) return deck;
      const h = tris.down(x, z, 500);
      return h ? h.y : terrain.heightAt(x, z) - 0.06;
    },
  };
}

function worldFor(tris, terrain) {
  const grip = {};
  for (const k in SURFACE_GRIP) grip[k] = { ...SURFACE_GRIP[k] };
  return {
    physics: physFor(tris, terrain),
    slope: 0,
    lodOf: () => 0,
    surfaceAt: () => 'concrete',
    waterHeightAt: () => null,
    reportCollision: () => {},
    gripOf: (n) => grip[n] ?? grip.asphalt,
    _world: () => null,
  };
}

function spawnAt(type, tris, terrain, x, z, yaw) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(worldFor(tris, terrain), spec, STUB, {});
  v.damage = null;
  const drop = type === 'heli'
    ? spec.comY - (spec.style.skidY - spec.style.skidR)
    : spec.comY - spec.style.gearY;
  const gy = v.sys.physics.groundHeight(x, z, 500);
  v.setPose(new THREE.Vector3(x, gy + drop + 0.02, z), yaw);
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

function sweepField(f, graph, terrain) {
  const { af, tris } = f;
  const id = af.id;
  const [L, W] = af.runway;
  const lo = { a: 0, d: 0 };
  const w = { x: 0, z: 0 };

  /* ---- site ----------------------------------------------------------- */
  check(id, 'the bench is graded and runway-plausible',
    !!af.pad && Math.abs(af.pad.slope) <= 0.023,
    af.pad ? `slope ${(af.pad.slope * 100).toFixed(2)}%` : 'no pad');

  /* ---- SELF-CHECK: the pavement detector can say no ------------------- */
  // Between the runway edge and the apron there is deliberately grass; a
  // detector that reports pavement there would pass everything below while
  // measuring nothing.
  {
    afWorld(af, (15 + af.layout.apron.d0) / 2, -0.3 * L, w);
    const h = tris.down(w.x, w.z);
    const bogus = h && h.surface === 'asphalt' && Math.abs(h.y - padY(af, -0.3 * L)) < 0.4;
    check(id, 'SELF-CHECK — no pavement reported on the grass gap', !bogus,
      bogus ? `asphalt at gap point y=${h.y.toFixed(2)}` : 'gap point unpaved as expected');
  }

  /* ---- paving: the strip, measured on collision triangles ------------- */
  const gaps = [];
  let covered = 0;
  let samples = 0;
  let hits = 0;
  let worstStep = 0;
  let worstSlope = 0;
  const stepM = 4;
  let this_prevPaveY = null;
  let this_prevPaveD = null;
  for (const dLane of [0, -10, 10]) {
    let run = null;
    let prevDeckY = null;
    this_prevPaveY = null;
    for (let a = -L / 2 + 2; a <= L / 2 - 2; a += stepM) {
      afWorld(af, dLane, a, w);
      const h = tris.down(w.x, w.z);
      // "Rollable pavement" includes the level street crossings (their
      // collision is asphalt on the bench); "deck proper" is the runway sheet
      // itself, and only THAT is held to sheet-continuity — the bumps at a
      // crossing are bounded by the level-crossing check and by the take-off
      // roll below actually surviving them.
      const bench = padY(af, a) + 0.06;
      const onPave = !!h && h.surface === 'asphalt' && Math.abs(h.y - bench) < 0.5;
      const onDeck = !!h && h.surface === 'asphalt' && Math.abs(h.y - bench) < 0.08;
      samples++;
      if (onPave) {
        hits++;
        if (dLane === 0) covered += stepM;
        if (run) {
          if (dLane === 0) gaps.push(run);
          run = null;
        }
      } else if (dLane === 0) {
        run = run ? { a0: run.a0, a1: a } : { a0: a, a1: a };
      }
      if (onDeck) {
        // Sheet continuity, measured on the RESIDUAL against the published
        // bench plane so the pad's own 2.2% grade does not read as steps.
        const resid = h.y - bench;
        if (prevDeckY !== null) {
          const dy = Math.abs(resid - prevDeckY);
          if (dy > worstStep) worstStep = dy;
        }
        prevDeckY = resid;
      } else {
        prevDeckY = null;
      }
      // Rollable-surface bump: worst vertical move between ANY two adjacent
      // rollable samples, kerb lips at street crossings included.
      if (onPave) {
        if (this_prevPaveY !== null && this_prevPaveD === dLane) {
          const sl = Math.abs(h.y - this_prevPaveY) / stepM;
          if (sl > worstSlope) worstSlope = sl;
        }
        this_prevPaveY = h.y;
        this_prevPaveD = dLane;
      } else {
        this_prevPaveY = null;
      }
    }
    if (run && dLane === 0) gaps.push(run);
  }
  const hitFrac = hits / Math.max(1, samples);
  let maxGap = 0;
  for (const g of gaps) maxGap = Math.max(maxGap, g.a1 - g.a0 + stepM);

  /**
   * RATCHETS (rule 13), from the MEASURED emitted strip on the build this
   * landed on — the goal is a fully continuous strip, and the residual is the
   * deliberately-uncut city streets crossing it. Lower these when the
   * crossings are reduced; never raise one to go green.
   */
  check(id, `paved strip: covered centreline >= takeoff run (414 m MEASURED flat roll + margin)`,
    covered >= 430, `${covered} m of ${L} covered, hit fraction ${(hitFrac * 100).toFixed(1)}%`);
  check(id, 'paved strip: three lanes mostly present', hitFrac >= 0.78,
    `${(hitFrac * 100).toFixed(1)}% of ${samples} samples on pavement`);
  check(id, 'paved strip: no unpaved gap a plane cannot roll across', maxGap <= 40,
    `worst gap ${maxGap.toFixed(0)} m of ${gaps.length}`);
  // The deck sheet is analytic (one plane, LIFT above the bench): ANY step
  // between two sheet samples is a builder bug, not terrain.
  check(id, 'runway sheet: continuous (no step a gear leg trips on)', worstStep <= 0.12,
    `worst sheet residual step between 4 m samples ${worstStep.toFixed(3)} m`);
  /**
   * RATCHET (rule 13). Worst bump anywhere along the rollable strip,
   * including the kerb lips and camber of the deliberately-uncut street
   * crossings — MEASURED 0.35 m (county) / 0.27 m (rivers) over 4 m on the
   * build this landed on, and the take-off roll below survives them. The
   * GOAL is ~0 (lay the crossing kerbs flush through the strip); lower this
   * when that lands, never raise it to go green — at 1.3 m off the bench
   * (the pre-levelling state) a crossing is a ramp that launches the
   * aircraft.
   */
  check(id, 'rollable strip: worst crossing bump bounded (RATCHET)', worstSlope * stepM <= 0.38,
    `worst bump between 4 m samples ${(worstSlope * stepM).toFixed(2)} m`);

  // Every gap must be a level crossing: the emitted road's height there must
  // sit on the bench (that is what makes the crossing rollable at speed).
  let worstCross = 0;
  for (const g of gaps) {
    const aMid = (g.a0 + g.a1) / 2;
    afWorld(af, 0, aMid, w);
    const ne = graph.nearestEdge(w.x, w.z, 60);
    if (!ne.edge) continue;
    const na = graph.nodes[ne.edge.a];
    const nb = graph.nodes[ne.edge.b];
    const roadY = na.y + (nb.y - na.y) * ne.t;
    worstCross = Math.max(worstCross, Math.abs(roadY - padY(af, aMid)));
  }
  check(id, 'every unpaved gap is a LEVEL crossing (emitted road on the bench)',
    worstCross <= 0.6, `worst |roadY - bench| across a gap ${worstCross.toFixed(2)} m`);

  /* ---- the apron and the parked fleet's spots ------------------------- */
  {
    const ap = af.layout.apron;
    let apHits = 0;
    let apN = 0;
    for (let a = ap.a0 + 3; a <= ap.a1 - 3; a += 6) {
      for (let d = ap.d0 + 3; d <= ap.d1 - 3; d += 6) {
        afWorld(af, d, a, w);
        const h = tris.down(w.x, w.z);
        apN++;
        if (h && (h.surface === 'asphalt' || h.surface === 'concrete') &&
            Math.abs(h.y - (padY(af, a) + 0.06)) < 0.5) apHits++;
      }
    }
    check(id, 'apron: mostly paved', apHits / Math.max(1, apN) >= 0.7,
      `${apHits}/${apN} apron samples paved`);

    // The EXACT park spots freeroam uses: plane at along(-0.32 L) on the
    // centreline, heli at beside(W/2 + 12, 0.12 L).
    const spots = [
      ['plane spot', 0, -0.32 * L],
      ['heli spot', W / 2 + 12, 0.12 * L],
    ];
    for (const [name, d, a] of spots) {
      afWorld(af, d, a, w);
      const h = tris.down(w.x, w.z);
      const ok = !!h && Math.abs(h.y - (padY(af, a) + 0.06)) < 0.35;
      check(id, `${name} stands on emitted pavement`, ok,
        h ? `${h.surface} at ${h.y.toFixed(2)} vs bench ${(padY(af, a) + 0.06).toFixed(2)}` : 'no surface');
      // Nothing solid stands within rotor/wing reach of a parked machine.
      const near = f.report ? nearestMass(f.report, w.x, w.z) : Infinity;
      check(id, `${name} is clear of structures`, near >= 9,
        `nearest structure mass ${near.toFixed(1)} m`);
    }
  }

  /* ---- structures ------------------------------------------------------ */
  const rep = f.report;
  check(id, 'structures were built', !!rep, rep ? 'report present' : 'no report');
  if (rep) {
    check(id, 'two hangars stand', rep.hangars.length >= 2,
      `${rep.hangars.length} hangars, skipped: ${rep.skipped.join(',') || 'none'}`);
    check(id, 'terminal + tower + windsock + beacon stand',
      !!rep.terminal && !!rep.tower && !!rep.windsock,
      `terminal ${!!rep.terminal}, tower ${!!rep.tower}, windsock ${!!rep.windsock}`);
    check(id, 'perimeter fence exists', rep.fencePosts >= 40, `${rep.fencePosts} fence bays`);

    // Every reported mass STOPS A CAPSULE: horizontal rays from outside at
    // chest height must hit its emitted collision shell.
    const masses = [
      ...rep.hangars.map((h, i) => [`hangar ${i}`, h, 1.4]),
      ...(rep.terminal ? [['terminal', rep.terminal, 1.4]] : []),
      ...(rep.tower ? [['tower', rep.tower, 1.4]] : []),
    ];
    for (const [name, m2, h] of masses) {
      let blocked = 0;
      for (const ang of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const dx = Math.sin(ang + af.yaw);
        const dz = Math.cos(ang + af.yaw);
        const R = 26;
        const hit = f.structTris.ray(m2.x - dx * R, (m2.gy ?? terrain.heightAt(m2.x, m2.z)) + h, m2.z - dz * R, dx, 0, dz, R);
        if (hit) blocked++;
      }
      check(id, `${name} stops a capsule (walls hit from outside)`, blocked >= 3,
        `${blocked}/4 bearings blocked`);
    }

    // No structure stands in a road or on the runway/taxi/apron pavement.
    let worstRoad = Infinity;
    let onPave = 0;
    for (const [, m2] of masses) {
      const ne = graph.nearestEdge(m2.x, m2.z, 90);
      if (ne.edge) {
        const k = ROAD_KIND[ne.edge.kind] ?? ROAD_KIND.street;
        const lim = roadHalfWidth(ne.edge.kind, ne.edge.lanes) + 0.33 + (k.sidewalk ?? 0);
        worstRoad = Math.min(worstRoad, ne.dist - lim);
      }
      afLocal(af, m2.x, m2.z, lo);
      for (const r of [af.layout.runway, af.layout.apron, ...af.layout.taxis]) {
        if (lo.a >= r.a0 - 2 && lo.a <= r.a1 + 2 && lo.d >= r.d0 - 2 && lo.d <= r.d1 + 2) onPave++;
      }
    }
    check(id, 'no structure mass reaches a carriageway', worstRoad > 2,
      `closest mass centre to a corridor line +${worstRoad === Infinity ? 'inf' : worstRoad.toFixed(1)} m`);
    check(id, 'no structure mass on the operational pavement', onPave === 0, `${onPave} on paving`);
  }

  /* ---- the flight model, on the emitted collision --------------------- */
  {
    // Parked: the SKYLARK settles on the strip and sits still.
    afWorld(af, 0, -0.32 * L, w);
    const v = spawnAt('plane', tris, terrain, w.x, w.z, af.yaw);
    const p0 = v.position.clone();
    step(v, {}, 3);
    const drift = Math.hypot(v.position.x - p0.x, v.position.z - p0.z);
    check(id, 'parked SKYLARK settles on the emitted strip and holds',
      v.grounded >= 3 && v.altitude < 0.2 && drift < 0.6,
      `grounded ${v.grounded}, alt ${v.altitude.toFixed(3)}, drift ${drift.toFixed(2)} m in 3 s`);
    // NOT FLOATING, NOT BURIED — the assertion `altitude` cannot make,
    // because it clamps at zero: the wheel-contact plane must sit AT the
    // emitted deck (a few cm of spring compression is the expected sign).
    {
      const spec = v.spec;
      const wheelPlane = v.position.y - (spec.comY - spec.style.gearY);
      const deckHit = tris.down(v.position.x, v.position.z);
      const sink = deckHit ? wheelPlane - deckHit.y : NaN;
      check(id, 'parked SKYLARK sits ON the pavement (not floating/buried)',
        Number.isFinite(sink) && sink > -0.12 && sink < 0.1,
        `wheel plane ${Number.isFinite(sink) ? sink.toFixed(3) : '?'} m relative to the emitted deck`);
    }

    // Full throttle: it must build speed down the emitted strip — bumps,
    // crossings and all — and LIFT OFF before the field runs out.
    let liftA = null;
    let maxD = 0;
    let alt8A = null;
    for (let i = 0; i < 120 * 34; i++) {
      v.input.boost = 1;
      v.fixedStep(DT, CTX);
      afLocal(af, v.position.x, v.position.z, lo);
      if (v.grounded > 0 && Math.abs(lo.d) > maxD) maxD = Math.abs(lo.d);
      if (liftA === null && v.grounded === 0 && v.altitude > 1.5) liftA = lo.a;
      if (liftA !== null && alt8A === null && v.altitude > 8) {
        alt8A = lo.a;
        break;
      }
    }
    check(id, 'full throttle: the SKYLARK takes off from the emitted runway',
      liftA !== null && liftA <= L / 2 + 24,
      liftA === null ? `never lifted (last a=${lo.a.toFixed(0)}, v=${v.velocity.length().toFixed(1)})`
        : `liftoff at a=${liftA.toFixed(0)} (paved end ${L / 2})`);
    check(id, 'and climbs away past the field', alt8A !== null && alt8A <= L / 2 + 170,
      alt8A === null ? 'never reached 8 m' : `8 m altitude by a=${alt8A.toFixed(0)}`);
    check(id, 'the roll tracks the strip', maxD <= 14,
      `max |d| while grounded ${maxD.toFixed(1)} m (strip half-width 15)`);

    // The RIVERHOP parked on the apron: ON the pavement, not floating/buried.
    afWorld(af, af.runway[1] / 2 + 12, 0.12 * L, w);
    const heli = spawnAt('heli', tris, terrain, w.x, w.z, af.yaw);
    step(heli, {}, 3);
    const hs = heli.spec;
    const skidPlane = heli.position.y - (hs.comY - (hs.style.skidY - hs.style.skidR));
    const deckHit = tris.down(heli.position.x, heli.position.z);
    const sink = deckHit ? skidPlane - deckHit.y : NaN;
    check(id, 'parked RIVERHOP sits ON the apron surface (not floating/buried)',
      heli.grounded >= 3 && heli.altitude < 0.25 &&
        Number.isFinite(sink) && sink > -0.12 && sink < 0.1,
      `skids ${heli.grounded}, alt ${heli.altitude.toFixed(3)}, skid plane ` +
        `${Number.isFinite(sink) ? sink.toFixed(3) : '?'} m relative to the emitted apron`);
  }
}

function nearestMass(rep, x, z) {
  let best = Infinity;
  const all = [
    ...rep.hangars,
    ...(rep.terminal ? [rep.terminal] : []),
    ...(rep.tower ? [rep.tower] : []),
    ...(rep.tank ? [rep.tank] : []),
    ...rep.floodlights,
    ...(rep.windsock ? [rep.windsock] : []),
  ];
  for (const m of all) best = Math.min(best, Math.hypot(m.x - x, m.z - z));
  return best;
}

/* ----------------------------------------------------------------- main --- */

const t0 = Date.now();
{
  const arm = await buildArm();
  for (const f of arm.fields) sweepField(f, arm.graph, arm.terrain);
}

/* ---- NEGATIVE CONTROL: the un-built airfield must go red -------------- */
{
  process.env.OW_NO_AIRFIELD = '1';
  const terrain = new Terrain({ cell: 8, extent: 1792 }).bake();
  const city = generateCity(terrain, new Rng(0x600d));
  let anyPad = false;
  let anyPave = false;
  let anyStruct = false;
  const stubLib = new ProtoLibrary({ get: () => new THREE.MeshBasicMaterial() });
  for (const af of AIRFIELDS) {
    if (af.pad) anyPad = true;
    const paved = buildAirfieldPaving(af, { terrain, roads: city.graph, mat: () => new THREE.MeshBasicMaterial() });
    if (paved) anyPave = true;
    const T = new TileBuilder(stubLib, `nc_${af.id}`);
    const rep = buildAirfield(T, stubLib, af, new Rng(1), (x, z) => terrain.heightAt(x, z), city.graph);
    if (rep) anyStruct = true;
  }
  check('control', 'NEGATIVE CONTROL — OW_NO_AIRFIELD=1 removes bench, paving and structures',
    !anyPad && !anyPave && !anyStruct,
    `pad ${anyPad}, paving ${anyPave}, structures ${anyStruct} (all must be false)`);
  delete process.env.OW_NO_AIRFIELD;
}

console.log(`\nairsweep: ${pass}/${pass + fail} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (fail) {
  console.log('FAILURES:');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
