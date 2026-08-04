#!/usr/bin/env node
/**
 * WORLD — "does the rail form a continuous line a trolley could run end to end,
 * or does a track dead-end in the middle of an intersection?"
 *
 * SYMPTOM. In Lawrenceville the mill track stopped in the road: the `rail_strip`
 * line — authored from the Strip through Lawrenceville to the far mill — came out
 * of the planar solver in SEVEN disconnected pieces, one dangling rail end at
 * (675,-500), another 7.2 m away at (681,-504), and five more like them, every
 * one sitting inside a road junction with no rail continuation across it. A
 * subway/trolley cannot run on that; it is a stub that stops in mid-road.
 *
 * ROOT CAUSE (fixed in `netgen.buildGraph`). Mill trackage runs within the 7 m
 * node-weld radius of the road grid, so each rail chain node welds onto a road
 * junction. Where two consecutive welded nodes already carried a ROAD edge, the
 * corridor loop's "skip a duplicate edge between the same pair" test ate the
 * rail edge — a trolley cannot run on the arterial that shares its ground, so
 * dropping it severs the line. The dup test is now keyed on `rail`-ness.
 *
 * WHAT THIS MEASURES, AND WHY IT IS NOT CIRCULAR (ARCHITECTURE.md rule 12)
 *
 * The rail geometry `roadmesh._rail` draws is exactly one ballast+sleeper+rail
 * run per EMITTED rail edge, straight from that edge's two node positions
 * (`roadmesh.js:1602-1660`). So the set of emitted rail edges IS the set of
 * drawn rail segments, and a gap between two edges is a literal gap in the drawn
 * ballast. This gate reads that set — `generateCity(...).graph`, the OUTPUT of
 * the planar solver — and never looks at `railLines()`, the corridor polylines
 * that go IN. Those inputs are continuous by construction (three unbroken
 * polylines); asserting on them would be the rule-12 trap of comparing the
 * code's input to itself. The defect lives entirely in the transform between
 * the two — `dedupeCorridors`, `buildGraph`'s split/weld/dup pass,
 * `pruneIslands` — which is what is measured here.
 *
 * And it does not trust the solver's own node bookkeeping either. Continuity is
 * rebuilt from the SEGMENT ENDPOINT POSITIONS in world space, welded at
 * `WELD_EPS`, so "these two drawn ballast runs meet" is decided by where the
 * geometry actually is, not by whether two edges happen to share a node id.
 *
 * Assertions, per emitted rail line (grouped by the emitted `corridor` tag):
 *
 *   connected   the line's drawn segments join, endpoint to endpoint, into ONE
 *               component. Seven pieces is the Lawrenceville bug in its
 *               measurable form.
 *   no-stub     no rail component is a short orphan standing on its own — the
 *               debris the severing left behind (a 19 m tail at (784..800)).
 *   endpoints   the Lawrenceville line (`rail_strip`) is a simple polyline: its
 *               only two extremities sit on OPEN GROUND, not inside a road
 *               intersection. An extremity is "in an intersection" when >= 2
 *               road (non-rail) segments also end within `JUNCTION_R` of it —
 *               i.e. the ballast stops where the roads cross.
 *   length      the Lawrenceville line spans a reasonable distance end to end
 *               (RATCHET, see below): a connected line that is 200 m long is a
 *               surviving stub, not a route.
 *
 * ...plus a SELF-CHECK that fires before any of them: the same continuity
 * checker is run on a deliberately SEVERED copy of the line (one bridging
 * segment removed at a junction) and the run aborts unless it reports exactly
 * the defect this gate exists to catch — two components and a dangling end in an
 * intersection. A gate that cannot be made to fail is decorative.
 *
 * Usage
 *   node src/world/railsweep.mjs
 *   node src/world/railsweep.mjs --json=/tmp/rail.json
 *
 * NEGATIVE CONTROL (the real one, not the synthetic self-check): revert the
 * one-line `rail`-keyed dup test in `netgen.buildGraph` and re-run. `rail_strip`
 * falls back to 7 components with 6 dangling ends inside junctions and this goes
 * red on `connected`, `no-stub` and `endpoints` at once.
 */

import { Terrain } from './terrain.js';
import { generateCity } from './netgen.js';
import { Rng } from '../core/rng.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

/** Two drawn ballast runs "meet" when their endpoints are this close (m). Well
 *  under the 7.2 m gap the Lawrenceville severing left, so a severed line reads
 *  as two components, not one. */
const WELD_EPS = 1.5;
/** A rail extremity is inside an intersection when this many road segments also
 *  end within JUNCTION_R of it. A crossing has >= 3 arms; a line passing a road
 *  has none right at the point. */
const JUNCTION_R = 7.0;
const ROAD_ARMS_FOR_JUNCTION = 2;
/** A standalone rail component shorter than this is orphan debris, not a line. */
const MIN_COMPONENT_M = 80;
/**
 * RATCHET (ARCHITECTURE.md rule 13). End-to-end span the Lawrenceville line must
 * cover. MEASURED on the fixed build: `rail_strip` is 1082 m over 33 segments,
 * one connected polyline from (-160,-80) to (800,-570). The bar records that we
 * reached a whole line, not a target — the goal is simply "the authored line,
 * unbroken". LOWER IT if terrain clipping ever legitimately shortens the line;
 * never RAISE it to make a severed run pass.
 */
const MIN_STRIP_LEN_M = 1000;
/** The emitted corridor id of the Lawrenceville line (Strip -> Lawrenceville). */
const STRIP_ID = 'rail_strip';

/* --------------------------------------------------------- measurement --- */

/**
 * Given a flat list of rail SEGMENTS ({ ax,az,bx,bz,corridor,len }) and a list
 * of ROAD segment endpoints, decide continuity purely from geometry.
 *
 * Returns, per corridor: component count, total length, and every extremity
 * (a welded endpoint touched by exactly one segment) tagged with how many road
 * segments end near it. Nothing in here reads a node id or a corridor polyline.
 */
function analyse(railSegs, roadEnds) {
  // Weld segment endpoints into shared points by position.
  const pts = []; // { x, z }
  const cellR = new Map();
  const key = (gx, gz) => gx * 73856093 ^ gz * 19349663;
  const findOrAdd = (x, z) => {
    const gx = Math.floor(x / WELD_EPS);
    const gz = Math.floor(z / WELD_EPS);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = cellR.get(key(gx + dx, gz + dz));
        if (!list) continue;
        for (const pi of list) {
          const p = pts[pi];
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < WELD_EPS * WELD_EPS) return pi;
        }
      }
    }
    const pi = pts.length;
    pts.push({ x, z });
    const k = key(gx, gz);
    let list = cellR.get(k);
    if (!list) cellR.set(k, (list = []));
    list.push(pi);
    return pi;
  };

  // Per-corridor: welded-point adjacency + degree.
  const corridors = new Map();
  for (const s of railSegs) {
    const pa = findOrAdd(s.ax, s.az);
    const pb = findOrAdd(s.bx, s.bz);
    if (pa === pb) continue;
    let c = corridors.get(s.corridor);
    if (!c) corridors.set(s.corridor, (c = { adj: new Map(), len: 0, segs: 0 }));
    if (!c.adj.has(pa)) c.adj.set(pa, new Set());
    if (!c.adj.has(pb)) c.adj.set(pb, new Set());
    c.adj.get(pa).add(pb);
    c.adj.get(pb).add(pa);
    c.len += s.len;
    c.segs++;
  }

  // Spatial index of road endpoints, for the intersection test.
  const roadCell = new Map();
  for (const r of roadEnds) {
    const gx = Math.floor(r.x / JUNCTION_R);
    const gz = Math.floor(r.z / JUNCTION_R);
    const k = key(gx, gz);
    let list = roadCell.get(k);
    if (!list) roadCell.set(k, (list = []));
    list.push(r);
  }
  const roadArmsNear = (x, z) => {
    const gx = Math.floor(x / JUNCTION_R);
    const gz = Math.floor(z / JUNCTION_R);
    let n = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = roadCell.get(key(gx + dx, gz + dz));
        if (!list) continue;
        for (const r of list) if ((r.x - x) ** 2 + (r.z - z) ** 2 < JUNCTION_R * JUNCTION_R) n++;
      }
    }
    return n;
  };

  // Reduce each corridor.
  const out = [];
  for (const [id, c] of corridors) {
    // Connected components over the welded adjacency.
    const seen = new Set();
    let comps = 0;
    const compSizeLen = [];
    for (const start of c.adj.keys()) {
      if (seen.has(start)) continue;
      comps++;
      let clen = 0;
      const stack = [start];
      seen.add(start);
      const members = new Set([start]);
      while (stack.length) {
        const u = stack.pop();
        for (const v of c.adj.get(u)) {
          if (!members.has(v)) members.add(v);
          if (!seen.has(v)) { seen.add(v); stack.push(v); }
        }
      }
      // Component length = sum of half-edges / 2 restricted to members.
      for (const u of members) for (const v of c.adj.get(u)) if (members.has(v)) clen += dist(pts[u], pts[v]);
      compSizeLen.push(clen / 2);
    }
    // Extremities: welded points of degree 1.
    const extremities = [];
    for (const [pi, nbrs] of c.adj) {
      if (nbrs.size === 1) {
        const p = pts[pi];
        extremities.push({ x: p.x, z: p.z, roadArms: roadArmsNear(p.x, p.z) });
      }
    }
    out.push({ id, comps, len: c.len, segs: c.segs, extremities, compLen: compSizeLen });
  }
  return out;
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

/** Pull the emitted rail segments and road endpoints out of a built graph. */
function emit(graph) {
  const railSegs = [];
  const roadEnds = [];
  for (const e of graph.edges) {
    const na = graph.nodes[e.a];
    const nb = graph.nodes[e.b];
    if (e.rail) {
      railSegs.push({ ax: na.x, az: na.z, bx: nb.x, bz: nb.z, corridor: e.corridor, len: e.len });
    } else {
      roadEnds.push({ x: na.x, z: na.z }, { x: nb.x, z: nb.z });
    }
  }
  return { railSegs, roadEnds };
}

/* ------------------------------------------------------------- self-check */

/**
 * Prove the checker can fail. Sever the Lawrenceville line by dropping the
 * shortest segment that bridges two would-be junction extremities, then confirm
 * `analyse` reports the very defect this gate exists to catch.
 */
function selfCheck(railSegs, roadEnds) {
  const strip = railSegs.filter((s) => s.corridor.startsWith(STRIP_ID));
  if (!strip.length) return { ok: false, why: 'no rail_strip segments to sever' };
  // Drop a short interior segment whose two ends both sit in road junctions —
  // exactly the segment the fix restores.
  const armsAt = (x, z) => roadEnds.reduce((n, r) => n + ((r.x - x) ** 2 + (r.z - z) ** 2 < JUNCTION_R * JUNCTION_R ? 1 : 0), 0);
  let victim = -1;
  let best = Infinity;
  for (let i = 0; i < railSegs.length; i++) {
    const s = railSegs[i];
    if (!s.corridor.startsWith(STRIP_ID)) continue;
    if (armsAt(s.ax, s.az) >= ROAD_ARMS_FOR_JUNCTION && armsAt(s.bx, s.bz) >= ROAD_ARMS_FOR_JUNCTION && s.len < best) {
      best = s.len; victim = i;
    }
  }
  if (victim < 0) return { ok: false, why: 'no interior junction-to-junction segment to sever' };
  const severed = railSegs.filter((_, i) => i !== victim);
  const res = analyse(severed, roadEnds).find((r) => r.id.startsWith(STRIP_ID));
  const brokeIntoTwo = res && res.comps >= 2;
  const danglingInJunction = res && res.extremities.some((e) => e.roadArms >= ROAD_ARMS_FOR_JUNCTION);
  return { ok: brokeIntoTwo && danglingInJunction, comps: res?.comps, dangles: res?.extremities.filter((e) => e.roadArms >= ROAD_ARMS_FOR_JUNCTION).length };
}

/* ---------------------------------------------------------------- run --- */

const terrain = new Terrain({ cell: 8, extent: 1792 });
const city = generateCity(terrain, new Rng(0x5eed1234).fork().fork());
const { railSegs, roadEnds } = emit(city.graph);

const checks = [];
const fail = (name, msg) => checks.push({ name, ok: false, msg });
const pass = (name, msg) => checks.push({ name, ok: true, msg });

// SELF-CHECK first.
const sc = selfCheck(railSegs, roadEnds);
if (!sc.ok) {
  console.error(`SELF-CHECK FAILED — the continuity checker did not flag a severed line (${sc.why ?? `comps=${sc.comps}, dangles=${sc.dangles}`}). The gate proves nothing; aborting.`);
  process.exit(2);
}
console.log(`self-check: severing one junction segment -> ${sc.comps} components, ${sc.dangles} dangling end(s) in a junction. checker CAN fail. ok`);

const lines = analyse(railSegs, roadEnds);
if (!lines.length) fail('rail-present', 'no rail segments emitted at all');

for (const line of lines) {
  // connected: one component per authored line.
  if (line.comps === 1) pass('connected', `${line.id}: 1 component, ${line.segs} segs, ${line.len.toFixed(0)} m`);
  else fail('connected', `${line.id}: ${line.comps} components (severed line) — ${line.compLen.map((l) => l.toFixed(0)).join('/')} m`);

  // no-stub: nothing standing alone below the orphan threshold.
  const stubs = line.compLen.filter((l) => l < MIN_COMPONENT_M);
  if (line.comps > 1 && stubs.length) fail('no-stub', `${line.id}: orphan stub(s) ${stubs.map((l) => l.toFixed(0)).join(', ')} m < ${MIN_COMPONENT_M}`);
}

// The Lawrenceville line, by name: simple polyline, both ends on open ground.
const strip = lines.find((l) => l.id.startsWith(STRIP_ID));
if (!strip) {
  fail('endpoints', `no ${STRIP_ID}* line emitted`);
} else {
  const inJunction = strip.extremities.filter((e) => e.roadArms >= ROAD_ARMS_FOR_JUNCTION);
  if (inJunction.length === 0) pass('endpoints', `${strip.id}: ${strip.extremities.length} extremities, all on open ground`);
  else fail('endpoints', `${strip.id}: ${inJunction.length} rail end(s) dead-ending inside a road junction — ${inJunction.map((e) => `(${e.x.toFixed(0)},${e.z.toFixed(0)}) ${e.roadArms} arms`).join('; ')}`);

  if (strip.len >= MIN_STRIP_LEN_M) pass('length', `${strip.id}: ${strip.len.toFixed(0)} m end to end (>= ${MIN_STRIP_LEN_M})`);
  else fail('length', `${strip.id}: only ${strip.len.toFixed(0)} m (< ${MIN_STRIP_LEN_M}) — a surviving stub, not a route`);
}

/* -------------------------------------------------------------- report --- */

if (args.json) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(String(args.json)), { recursive: true });
  writeFileSync(String(args.json), JSON.stringify({ lines, checks, selfCheck: sc }, null, 2));
}

console.log('');
for (const line of lines) {
  const ext = line.extremities.map((e) => `(${e.x.toFixed(0)},${e.z.toFixed(0)}${e.roadArms >= ROAD_ARMS_FOR_JUNCTION ? ` !${e.roadArms}arms` : ''})`).join(' ');
  console.log(`  ${line.id.padEnd(16)} comps=${line.comps} segs=${line.segs} ${line.len.toFixed(0).padStart(5)} m  ends=${ext}`);
}
console.log('');
let ok = 0;
for (const c of checks) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name.padEnd(11)} ${c.msg}`);
  if (c.ok) ok++;
}
const allOk = checks.length > 0 && ok === checks.length;
console.log(`\n${allOk ? 'ALL PASSED' : 'FAILED'} — ${ok}/${checks.length}`);
process.exit(allOk ? 0 : 1);
