#!/usr/bin/env node
/**
 * AIRFIELD AMBIENT-PED KEEP-OUT — node-only gate, in `npm run gate`.
 *
 * THE DEFECT THIS GATES. "NPCs were spawned all over the airfield and seemed
 * like there were too many people running around." An airfield (the two
 * civilian ones and Ridgeline AFB) is open, RESTRICTED ground. Two things put
 * a crowd on it:
 *
 *   1. netgen (commit ee63000) diverted the city streets that used to cross
 *      each civilian field into a PERIMETER RING ROAD hugging the fence. A ring
 *      road carries pavement, pavement carries the ambient wander crowd, so the
 *      whole airport ended up encircled by a dense band of pedestrians.
 *   2. Standing on the strip with no sidewalk within reach, the spawner's
 *      wander fallback drops people onto the graded FIELD itself.
 *
 * THE FIX (src/peds/nav.js `airfieldSpawnBlocked`, called from
 * `Peds._spawnNear`): consult the PUBLISHED field predicates
 * `world.airfieldAt` / `world.airbaseAt` — reject any ambient spawn inside a
 * field outright, and keep only a sparse `AF_PERIMETER_KEEP` of spawns on the
 * ring. The assault guards (`peds.spawnHostile` / the hostiles pool) are a
 * different path and are NOT touched.
 *
 * WHY THIS IS NOT CIRCULAR (ARCHITECTURE.md rule 12). The measured artefact is
 * the EMITTED ambient-spawn distribution: candidate points are produced by the
 * PRODUCTION sidewalk sampler (`SidewalkNet.sampleLink` + `pointOn`, the exact
 * calls `_spawnNear` makes) over the REAL emitted road graph — the ring road
 * included — then run through the production keep-out. "Inside the field" and
 * "on the perimeter" are classified INDEPENDENTLY of the keep-out, straight
 * from the field-local layout rects (`af.layout.field`,
 * `ab.layout.fieldStrip/fieldApron`), never by calling the predicate the fix
 * uses. The A/B arms share ONE candidate list (same generation seed): only
 * whether the fix is applied differs, so the field/perimeter candidate counts
 * are identical between arms and only the SURVIVORS move.
 *
 * NEGATIVE CONTROL (the `debugIgnorePause` shape). The same candidate list is
 * re-scored with the keep-out OFF; the field must re-fill (fieldSurv > 0, the
 * reproduction) and the ring must go dense again (perimeter survivor fraction
 * high). Without a control a keep-out that rejected EVERYTHING would pass the
 * field/perimeter checks silently — so a DOWNTOWN block (Golden Triangle, far
 * from any field) is scored with the fix ON and must lose ~none of its crowd,
 * proving this measures EXCLUSION near fields, not a global ped kill.
 *
 * Usage:  node src/peds/airpedprobe.mjs [--verbose]
 */

import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';
import { generateCity } from '../world/netgen.js';
import { AIRFIELDS, AIRBASE, DISTRICTS, ROAD_KIND, roadHalfWidth } from '../world/plan.js';
import { afLocal, afWorld, airfieldAt, airfieldPavedAt } from '../world/airfield.js';
import { abLocal, abWorld, airbaseAt, airbasePavedAt, finaliseAirbase } from '../world/airbase.js';
import { Rng } from '../core/rng.js';
import { SidewalkNet, airfieldSpawnBlocked, AF_PERIMETER, AF_PERIMETER_KEEP } from './nav.js';

const VERBOSE = process.argv.includes('--verbose');
const SEED = 0x600d;
const SAMPLES = 1600;                 // candidate draws per anchor
const PERIM_LO = 2;                   // measure the ring band comfortably
const PERIM_HI = AF_PERIMETER - 4;    //   inside the reliably-detected band

let pass = 0, fail = 0;
const fails = [];
function check(section, label, ok, detail) {
  if (ok) pass++;
  else { fail++; fails.push(`${section}: ${label} — ${detail}`); }
  if (!ok || VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${label}  (${detail})`);
}

/* --------------------------------------------------------------- world --- */

/**
 * The slice of the `world` contract the spawner reads: the road graph (so the
 * sidewalk net has the real emitted edges, ring included), the published field
 * predicates the keep-out consults, and a `surfaceAt` mirroring the game's so
 * the spawner's own water/asphalt guards run exactly as they do in play.
 */
function worldFacade(graph, terrain) {
  return {
    roads: graph,
    airfieldAt,
    airbaseAt,
    surfaceAt(x, z) {
      if (terrain.waterDist(x, z) < 0) return 'water';
      const ne = graph.nearestEdge(x, z, 70);
      if (ne.edge) {
        const e = ne.edge;
        const hw = roadHalfWidth(e.kind, e.lanes);
        if (ne.dist <= hw) return e.rail ? 'dirt' : 'asphalt';
        const k = ROAD_KIND[e.kind] ?? ROAD_KIND.street;
        const sw = e.bridge ? Math.max(k.sidewalk, 1.0) : k.sidewalk;
        if (sw > 0 && ne.dist <= hw + 0.34 + sw) return 'sidewalk';
      }
      if (airfieldPavedAt(x, z) || airbasePavedAt(x, z)) return 'asphalt';
      if (terrain.waterDist(x, z) < 26) return 'sand';
      return 'grass';
    },
  };
}

/* ------------------------------------------------------------- fields --- */

/** A field's independent geometry: local transform + the layout rects. */
function fieldDesc(kind, obj) {
  if (kind === 'airfield') {
    return {
      name: obj.id,
      local: (x, z, o) => afLocal(obj, x, z, o),
      world: (d, a, o) => afWorld(obj, d, a, o),
      rects: [obj.layout.field],
    };
  }
  return {
    name: obj.id,
    local: (x, z, o) => abLocal(obj, x, z, o),
    world: (d, a, o) => abWorld(obj, d, a, o),
    rects: [obj.layout.fieldStrip, obj.layout.fieldApron],
  };
}

const _lo = { a: 0, d: 0 };
/** 0 inside any rect, else the shortest distance OUT to the field boundary. */
function outsideDist(desc, x, z) {
  desc.local(x, z, _lo);
  let best = Infinity;
  for (const r of desc.rects) {
    const qa = Math.max(r.a0 - _lo.a, _lo.a - r.a1, 0);
    const qd = Math.max(r.d0 - _lo.d, _lo.d - r.d1, 0);
    best = Math.min(best, Math.hypot(qa, qd));
  }
  return best;
}

/** Anchors ON the field: centre, and just inside each fence of the main rect. */
function anchorsFor(desc) {
  const r = desc.rects[0];
  const cd = (r.d0 + r.d1) / 2, ca = (r.a0 + r.a1) / 2;
  const spots = [
    [cd, ca], [r.d0 + 8, ca], [r.d1 - 8, ca], [cd, r.a0 + 8], [cd, r.a1 - 8],
  ];
  return spots.map(([d, a]) => { const w = { x: 0, z: 0 }; desc.world(d, a, w); return w; });
}

/* ----------------------------------------------------- candidate stream -- */

const _pt = new THREE.Vector3();
const _link = {};

/**
 * Generate ambient-spawn CANDIDATES exactly as `Peds._spawnNear` does: prefer
 * a production sidewalk sample in [9, 92] m of the anchor, else the wander
 * annulus fallback, then apply the spawner's own surface guards. Each survivor
 * is classified against the field geometry INDEPENDENTLY of the keep-out.
 */
function candidatesFor(desc, anchors, net, world, rngGen) {
  const cands = [];
  for (const anchor of anchors) {
    for (let i = 0; i < SAMPLES; i++) {
      let link = null, x, z;
      if (net.ready) link = net.sampleLink(rngGen, anchor, 9, 92, _link);
      if (link) {
        net.pointOn(link.edge, link.side, link.t, _pt);
        x = _pt.x; z = _pt.z;
      } else {
        const a = rngGen.float() * Math.PI * 2;
        const r = 26 + rngGen.float() * 52;
        x = anchor.x + Math.cos(a) * r;
        z = anchor.z + Math.sin(a) * r;
      }
      const sf = world.surfaceAt(x, z);
      if (sf === 'water') continue;
      if (!link && sf === 'asphalt') continue;
      const od = outsideDist(desc, x, z);
      cands.push({ x, z, inField: od === 0, inPerim: od > PERIM_LO && od <= PERIM_HI });
    }
  }
  return cands;
}

/** Score one A/B arm over a shared candidate list. */
function scoreArm(cands, world, applyFix, rngFix) {
  let surv = 0, fieldSurv = 0, perimSurv = 0;
  for (const c of cands) {
    if (applyFix && airfieldSpawnBlocked(world, c.x, c.z, rngFix)) continue;
    surv++;
    if (c.inField) fieldSurv++;
    if (c.inPerim) perimSurv++;
  }
  return { surv, fieldSurv, perimSurv };
}

/* ----------------------------------------------------------------- run --- */

const t0 = Date.now();
const terrain = new Terrain({ cell: 8, extent: 1792 }).bake();
const city = generateCity(terrain, new Rng(SEED));
const graph = city.graph;
finaliseAirbase(AIRBASE);

const world = worldFacade(graph, terrain);
const net = new SidewalkNet();
net.attach(graph);
check('setup', 'sidewalk net adopted the emitted road graph', net.ready,
  `${net.ready ? 'ready' : 'NOT ready'} (${graph.edges.length} edges)`);

const descs = [
  ...AIRFIELDS.filter((af) => af.pad && af.layout).map((af) => fieldDesc('airfield', af)),
];
if (AIRBASE.pad && AIRBASE.layout) descs.push(fieldDesc('airbase', AIRBASE));
check('setup', 'both civilian airfields and the airbase are built', descs.length === 3,
  `${descs.length} field(s) with a pad`);

for (const desc of descs) {
  const anchors = anchorsFor(desc);
  // ONE candidate list, shared by both arms (identical generation seed).
  const cands = candidatesFor(desc, anchors, net, world, new Rng(0xA1F ^ hash(desc.name)));
  const fieldCand = cands.filter((c) => c.inField).length;
  const perimCand = cands.filter((c) => c.inPerim).length;

  // Self-checks: the measurement is not vacuously empty.
  check(desc.name, 'candidates land INSIDE the field (else the field check is empty)',
    fieldCand > 0, `${fieldCand} of ${cands.length} candidates in the field`);
  check(desc.name, 'candidates land on the PERIMETER ring (else the ring check is empty)',
    perimCand > 0, `${perimCand} candidates in the ${PERIM_LO}..${PERIM_HI} m band`);

  const on = scoreArm(cands, world, true, new Rng(0x5EED ^ hash(desc.name)));
  const off = scoreArm(cands, world, false, null);

  // FIX ON: the field is clear, the ring is sparse.
  check(desc.name, 'FIX ON: no ambient ped survives inside the field',
    on.fieldSurv === 0, `${on.fieldSurv} of ${fieldCand} in-field candidates survived`);
  const onPerimFrac = perimCand ? on.perimSurv / perimCand : 0;
  check(desc.name, `FIX ON: the perimeter ring is sparse (<= ${(AF_PERIMETER_KEEP + 0.23).toFixed(2)})`,
    onPerimFrac <= AF_PERIMETER_KEEP + 0.23,
    `${(onPerimFrac * 100).toFixed(1)}% of ${perimCand} ring candidates survived`);

  // NEGATIVE CONTROL: fix OFF re-fills the field and the ring.
  check(desc.name, 'CONTROL: with the keep-out OFF the field re-fills (reproduction)',
    off.fieldSurv > 0, `${off.fieldSurv} in-field ambient peds return`);
  const offPerimFrac = perimCand ? off.perimSurv / perimCand : 0;
  check(desc.name, 'CONTROL: with the keep-out OFF the ring is dense (>= 0.80)',
    offPerimFrac >= 0.80, `${(offPerimFrac * 100).toFixed(1)}% of ring candidates survive un-gated`);

  if (VERBOSE) {
    console.log(`    ${desc.name}: cands ${cands.length} (field ${fieldCand}, ring ${perimCand}) ` +
      `| ON field ${on.fieldSurv} ring ${(onPerimFrac * 100).toFixed(1)}% ` +
      `| OFF field ${off.fieldSurv} ring ${(offPerimFrac * 100).toFixed(1)}%`);
  }
}

/* ---- DOWNTOWN CONTROL: the fix must not touch a normal block -------------- */
{
  const dt = DISTRICTS.find((d) => d.id === 'downtown');
  const anchor = { x: dt.x, z: dt.z };
  const cands = [];
  const rngGen = new Rng(0xD09);
  for (let i = 0; i < SAMPLES * 4; i++) {
    const link = net.ready ? net.sampleLink(rngGen, anchor, 9, 92, _link) : null;
    if (!link) continue;              // downtown is all pavement; sidewalks only
    net.pointOn(link.edge, link.side, link.t, _pt);
    const x = _pt.x, z = _pt.z;
    if (world.surfaceAt(x, z) === 'water') continue;
    cands.push({ x, z, inField: false, inPerim: false });
  }
  const nearField = cands.filter((c) => airfieldAt(c.x, c.z) || airbaseAt(c.x, c.z)).length;
  check('downtown', 'downtown candidates are far from every field (fix domain does not reach)',
    nearField === 0, `${nearField} of ${cands.length} downtown candidates in a field`);
  const on = scoreArm(cands, world, true, new Rng(0xB10));
  const kept = cands.length ? on.surv / cands.length : 0;
  check('downtown', 'FIX ON: downtown keeps ~all its crowd (not a global ped kill)',
    kept >= 0.98, `${(kept * 100).toFixed(1)}% of ${cands.length} downtown spawns survived`);
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h >>> 0; }

console.log(`\nairpedprobe: ${pass}/${pass + fail} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (fail) {
  console.log('FAILURES:');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('PASS');
