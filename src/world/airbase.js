import * as THREE from 'three';
import { Accum } from './util.js';
import { AIRBASE, clamp01, smootherstep, lerp } from './plan.js';
import { padY, corridorCutAt } from './airfield.js';

/**
 * WORLD — Ridgeline AFB, the military airbase. The GROUND half.
 *
 * Follows `src/world/airfield.js` exactly — one owner for every spatial fact
 * — but the site is a different animal from the two civilian strips:
 *
 *   - the FIELD IS FENCED. The civilian fields let the city street grid run
 *     across their strips (deliberately uncut); a military perimeter cannot,
 *     so `reserveAirbase` cuts any drivable corridor that strays inside the
 *     fence line (the survey site has zero, so this is a guard, not surgery)
 *     and `airbaseAccessCorridors` lays the ONE public road in, welded into
 *     the Manchester/North Shore grid by `buildGraph`'s intersection solver
 *     — the corridor deliberately runs ~250 m past the first street it can
 *     meet so the planar solve always finds a crossing whatever the grid
 *     jitter did, the same trick the bridge approaches use.
 *   - the field is L-SHAPED: a full-length runway strip hugging the map edge
 *     and an apron block on the city side of its eastern half. The survey
 *     measured why: a rectangle deep enough for the apron along the WHOLE
 *     runway digs a 44-56 m cut into the Manchester rim at its west end;
 *     the L keeps the worst earthwork at 13-22 m.
 *
 * WHAT THIS FILE OWNS:
 *   1. `gradeAirbase(terrain)`   — stamp the bench (netgen step 0c).
 *   2. `reserveAirbase(list)`    — no through road inside the fence.
 *   3. `airbaseAccessCorridors()`— the welded base road, gate to grid.
 *   4. `levelAirbaseRoads(graph)`— the base road meets the bench flat.
 *   5. `buildAirbasePaving(ab)`  — emitted decks, markings, lamps, collision.
 *   6. `finaliseAirbase(ab)`     — the PUBLISHED layout: world-space fence
 *      polygon, gates, runway start/heading, tagged apron parking, patrol
 *      waypoints, `insidePerimeter(x, z)`. `world.airbase` is this object.
 *
 * The BUILDING half (hangars, tower, radar dome, bunkers, tanks, the fence
 * itself) is `src/buildings/airbase.js`, reading `world.airbase` and never
 * re-deriving it. `src/world/basesweep.mjs` gates the emitted result;
 * `?noairbase=1` / `OW_NO_AIRBASE=1` is the negative-control hatch, same
 * shape as `?noairfield=1`.
 */

/* ------------------------------------------------------------ constants -- */

/** Paved runway half-width, m. Military: 46 m of pavement for the jet. */
const RW_HALF = 23;
/** Deck sits this far above the graded bench (same as the civilian LIFT). */
const LIFT = 0.06;
const PAINT_LIFT = 0.028;
/** Steepest bench gradient the fit may keep — same clamp as the airfields. */
const MAX_GRADE = 0.022;
/** Metres the bench blends back into the hillside. Wider than the civilian
 *  72: the survey's worst fill is 22 m, and 100 m keeps that shoulder
 *  under ~24 degrees instead of a 17-degree-plus scarp at 72. */
const BLEND = 100;
/** Deck/collision quad size, m. */
const STEP = 8;
/** Metres of clear ground between the fence line and any kept corridor. */
const RESERVE = 12;
/** A cut corridor fragment shorter than this is dropped, not kept. */
const MINKEEP = 40;

/* Field-local layout (a along the runway, +a = takeoff run = east; d across,
 * NEGATIVE d is the city side — the fence's south face). All in metres. */
const RUNWAY = { d0: -RW_HALF, d1: RW_HALF, a0: -600, a1: 600 };
const TAXIWAY = { d0: -64, d1: -42, a0: -580, a1: 580 };
const LINK_AT = [-560, -190, 190, 560];
const LINKS = LINK_AT.map((c) => ({ d0: -42, d1: -RW_HALF + 1, a0: c - 12, a1: c + 12 }));
const APRON = { d0: -208, d1: -64, a0: 30, a1: 620 };
/** Gate throats: paved stubs from the fence gap to the taxiway / apron. */
const STUB_MAIN = { d0: -258, d1: -208, a0: 320, a1: 340 };
const STUB_BACK = { d0: -100, d1: -64, a0: -407, a1: -393 };
/** Where `buildings` stands the hangar row, behind the apron. */
const BAND = { d0: -250, d1: -212, a0: 60, a1: 620 };
/** The two rects whose union is the FIELD (bench, fence, block-drop). */
const FIELD_STRIP = { d0: -100, d1: 42, a0: -656, a1: 656 };
const FIELD_APRON = { d0: -258, d1: -100, a0: 18, a1: 656 };
/** Fence polygon, walked in order (a, d). Closed implicitly. */
const FENCE_POLY = [
  [-656, 42], [656, 42], [656, -258], [18, -258], [18, -100], [-656, -100],
];
/** Gates: gaps in the fence, field-local centre + half-width + which face. */
const GATES = [
  { id: 'main', a: 330, d: -258, half: 9, face: 'south' },
  { id: 'back', a: -400, d: -100, half: 8, face: 'south' },
];

const DECK_RECTS = [RUNWAY, TAXIWAY, ...LINKS, APRON, STUB_MAIN, STUB_BACK];

export function abDisabled() {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('noairbase') === '1') return true;
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.OW_NO_AIRBASE === '1') return true;
  } catch { /* no process */ }
  return false;
}

/* -------------------------------------------------------------- frame ---- */

/** Field-local coordinates of a world point. Same frame as `afLocal`. */
export function abLocal(ab, x, z, out = { a: 0, d: 0 }) {
  const s = Math.sin(ab.yaw);
  const c = Math.cos(ab.yaw);
  const dx = x - ab.x;
  const dz = z - ab.z;
  out.a = dx * s + dz * c;
  out.d = dx * c - dz * s;
  return out;
}

/** World point of field-local (d, a). Same frame as `afWorld`. */
export function abWorld(ab, d, a, out = { x: 0, z: 0 }) {
  const s = Math.sin(ab.yaw);
  const c = Math.cos(ab.yaw);
  out.x = ab.x + c * d + s * a;
  out.z = ab.z - s * d + c * a;
  return out;
}

const _lo = { a: 0, d: 0 };
const _w = { x: 0, z: 0 };

const inRect = (r, a, d, pad = 0) =>
  a >= r.a0 - pad && a <= r.a1 + pad && d >= r.d0 - pad && d <= r.d1 + pad;

/** Signed-ish distance OUTSIDE the field union (0 inside either rect). */
function fieldDist(a, d) {
  let best = Infinity;
  for (const f of [FIELD_STRIP, FIELD_APRON]) {
    const qa = Math.max(f.a0 - a, a - f.a1, 0);
    const qd = Math.max(f.d0 - d, d - f.d1, 0);
    best = Math.min(best, Math.hypot(qa, qd));
  }
  return best;
}

/** The layout, published on `ab.layout`. Rects are field-local metres. */
export function airbaseLayout(ab) {
  const [L, W] = ab.runway;
  return {
    s: Math.sin(ab.yaw), c: Math.cos(ab.yaw), L, W,
    runway: RUNWAY, taxiway: TAXIWAY, links: LINKS, apron: APRON,
    stubs: [STUB_MAIN, STUB_BACK], band: BAND,
    fieldStrip: FIELD_STRIP, fieldApron: FIELD_APRON,
    polygon: FENCE_POLY, gates: GATES,
  };
}

/** True when (x, z) is inside the L-shaped field. */
export function airbaseAt(x, z) {
  const ab = AIRBASE;
  if (!ab.pad) return null;
  abLocal(ab, x, z, _lo);
  return inRect(FIELD_STRIP, _lo.a, _lo.d) || inRect(FIELD_APRON, _lo.a, _lo.d) ? ab : null;
}

/** Height of the paved deck at (x, z), or null off the pavement. */
export function airbaseDeckAt(x, z) {
  const ab = AIRBASE;
  if (!ab.pad) return null;
  abLocal(ab, x, z, _lo);
  // Cheap bbox reject before the rect walk.
  if (_lo.a < -656 || _lo.a > 656 || _lo.d < -258 || _lo.d > 42) return null;
  for (const r of DECK_RECTS) {
    if (inRect(r, _lo.a, _lo.d)) return padY(ab, _lo.a) + LIFT;
  }
  return null;
}

export function airbasePavedAt(x, z) {
  return airbaseDeckAt(x, z) !== null;
}

/* ------------------------------------------------------------- grading --- */

/**
 * Stamp the graded bench into the baked heightfield. Runs in `generateCity`
 * step 0c — after `gradeAirfields`, BEFORE any corridor is laid, so the base
 * road solves its node heights against the bench. Same LS-fit-then-clamp as
 * the airfields, stamped over the L-shaped union.
 */
export function gradeAirbase(terrain) {
  const ab = AIRBASE;
  if (abDisabled()) {
    ab.pad = null;
    ab.layout = null;
    ab.padYAt = null;
    ab.localAt = null;
    ab.worldAt = null;
    ab.insidePerimeter = null;
    ab.perimeter = null;
    ab.gates = null;
    ab.runwayStart = null;
    ab.runwayEnd = null;
    ab.apronSlots = null;
    ab.patrol = null;
    return { on: false };
  }
  const lay = (ab.layout = airbaseLayout(ab));
  const { L } = lay;

  // Fit the pad plane to the raw centreline (samples symmetric about a = 0).
  const N = 25;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < N; i++) {
    const a = -L / 2 + (i / (N - 1)) * L;
    abWorld(ab, 0, a, _w);
    const h = terrain.heightAt(_w.x, _w.z);
    sy += h;
    sxx += a * a;
    sxy += a * h;
  }
  let slope = sxy / sxx;
  if (slope > MAX_GRADE) slope = MAX_GRADE;
  else if (slope < -MAX_GRADE) slope = -MAX_GRADE;
  ab.pad = { yMid: sy / N, slope };
  ab.padYAt = (a) => padY(ab, a);
  ab.localAt = (x, z, out) => abLocal(ab, x, z, out);
  ab.worldAt = (d, a, out) => abWorld(ab, d, a, out);

  // Stamp over the union bbox.
  const { cell, origin, n, grid, roadW } = terrain;
  const corners = [];
  for (const f of [FIELD_STRIP, FIELD_APRON]) {
    corners.push(
      abWorld(ab, f.d0 - BLEND, f.a0 - BLEND, {}),
      abWorld(ab, f.d1 + BLEND, f.a0 - BLEND, {}),
      abWorld(ab, f.d0 - BLEND, f.a1 + BLEND, {}),
      abWorld(ab, f.d1 + BLEND, f.a1 + BLEND, {})
    );
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of corners) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    z0 = Math.min(z0, p.z);
    z1 = Math.max(z1, p.z);
  }
  const i0 = Math.max(0, Math.floor((x0 - origin) / cell));
  const i1 = Math.min(n - 1, Math.ceil((x1 - origin) / cell));
  const j0 = Math.max(0, Math.floor((z0 - origin) / cell));
  const j1 = Math.min(n - 1, Math.ceil((z1 - origin) / cell));
  for (let j = j0; j <= j1; j++) {
    const pz = origin + j * cell;
    const row = j * n;
    for (let i = i0; i <= i1; i++) {
      const px = origin + i * cell;
      abLocal(ab, px, pz, _lo);
      const dist = fieldDist(_lo.a, _lo.d);
      if (dist >= BLEND) continue;
      let wgt = dist <= 0 ? 1 : 1 - smootherstep(dist / BLEND);
      const wd = terrain.waterDist(px, pz);
      wgt *= clamp01((wd - 12) / 34);
      if (wgt <= 0.002) continue;
      const k = row + i;
      grid[k] = lerp(grid[k], padY(ab, _lo.a), wgt);
      if (wgt > roadW[k]) roadW[k] = wgt;
    }
  }
  return { on: true };
}

/* --------------------------------------------------- corridors + reserve -- */

/**
 * No through road inside the fence. The survey site has ZERO corridors in
 * the field (that is why it was chosen), so on today's map this cuts
 * nothing; it exists so a future corridor author cannot quietly breach the
 * perimeter. Same cut-into-runs shape as `reserveLandmarks`; the base's own
 * access road (`abx_` ids) and bridges are exempt. Rail is cut too — the
 * survey guarantees none is near, and a fence with a railway through it is
 * not a fence.
 */
export function reserveAirbase(corridors) {
  const ab = AIRBASE;
  if (!ab.pad) return { corridors, cut: 0, on: false };
  const out = [];
  let cut = 0;
  const lo = { a: 0, d: 0 };
  for (const c of corridors) {
    if (c.bridge || String(c.id).startsWith('abx_')) {
      out.push(c);
      continue;
    }
    let anyIn = false;
    for (const [px, pz] of c.pts) {
      abLocal(ab, px, pz, lo);
      if (fieldDist(lo.a, lo.d) < RESERVE) {
        anyIn = true;
        break;
      }
    }
    if (!anyIn) {
      out.push(c);
      continue;
    }
    cut++;
    let run = null;
    const runs = [];
    for (const p of c.pts) {
      abLocal(ab, p[0], p[1], lo);
      if (fieldDist(lo.a, lo.d) >= RESERVE) {
        if (!run) runs.push((run = []));
        run.push(p);
      } else run = null;
    }
    let k = 0;
    for (const r of runs) {
      let len = 0;
      for (let i = 0; i < r.length - 1; i++) len += Math.hypot(r[i + 1][0] - r[i][0], r[i + 1][1] - r[i][1]);
      if (r.length < 2 || len < MINKEEP) continue;
      out.push({ ...c, id: `${c.id}#ab${k++}`, pts: r });
    }
  }
  return { corridors: out, cut, on: true };
}

/**
 * The base road: one drivable corridor from the main gate, through the
 * fence gap, ending on the apron; the other end runs ~250 m INTO the
 * Manchester/North Shore grid so `buildGraph`'s planar solver always finds
 * street crossings to weld at, whatever the jittered grid did (the same
 * guarantee the bridge-approach corridors rely on). Straight, military,
 * no wander. Points ordered from the city end to the apron so the corridor
 * "arrives" at the base.
 */
export function airbaseAccessCorridors() {
  const ab = AIRBASE;
  if (!ab.pad) return [];
  const pts = [];
  // City end: deep inside the north-shore grid's reach (survey: nodes at
  // (-200,-1086), (-141,-1109), (-626,-1090) on the emitted graph).
  pts.push([-268, -880]);
  pts.push([-280, -940]);
  pts.push([-292, -1000]);
  pts.push([-303, -1058]);
  pts.push([-312, -1112]);
  // The gate and the run to the apron, exact, in field frame.
  const g = GATES[0];
  const w0 = abWorld(ab, g.d - 12, g.a, {});
  const w1 = abWorld(ab, g.d, g.a, {});
  const w2 = abWorld(ab, APRON.d0 + 6, g.a, {});
  const w3 = abWorld(ab, APRON.d0 + 58, g.a, {});
  pts.push([w0.x, w0.z], [w1.x, w1.z], [w2.x, w2.z], [w3.x, w3.z]);
  return [{
    id: 'abx_main',
    name: 'Ridgeline Base Road',
    kind: 'street',
    lanes: 2,
    oneway: false,
    pri: 3, // PRI.connector — survives dedupe against grid streets
    pts,
    y: null,
    pin: null,
    bridge: false,
    bridgeId: null,
    district: null,
    rail: false,
  }];
}

/**
 * Pull base-road node heights onto the bench across the paved zone, exactly
 * as `levelAirfieldRoads` does for the strips: after `buildGraph`, before
 * `rasteriseRoads`, so mesh + collision + corridor floor all inherit it.
 */
export function levelAirbaseRoads(graph) {
  const ab = AIRBASE;
  if (!ab.pad) return;
  const lo = { a: 0, d: 0 };
  const A0 = FIELD_APRON.a0 - 80;
  const A1 = FIELD_STRIP.a1 + 80;
  const D0 = FIELD_APRON.d0 - 80;
  const D1 = FIELD_STRIP.d1 + 80;
  for (const nd of graph.nodes) {
    if (!nd || nd.pin || nd.pinned) continue;
    abLocal(ab, nd.x, nd.z, lo);
    if (lo.a < A0 || lo.a > A1 || lo.d < D0 || lo.d > D1) continue;
    let dist = Infinity;
    for (const r of DECK_RECTS) {
      const qa = Math.max(r.a0 - lo.a, lo.a - r.a1, 0);
      const qd = Math.max(r.d0 - lo.d, lo.d - r.d1, 0);
      const dd = Math.hypot(qa, qd);
      if (dd < dist) dist = dd;
    }
    const w = 1 - smootherstep((dist - 24) / 44);
    if (w <= 0) continue;
    nd.y += (padY(ab, lo.a) - nd.y) * w;
  }
}

/* -------------------------------------------------------------- publish --- */

/**
 * Compute and attach the PUBLISHED world-space layout. Called once by
 * `world/index.js` after the graph exists; everything an encounter, vehicle
 * or mission agent needs without ever importing this module:
 *
 *   ab.perimeter      [[x, z] ...]   fence polygon, closed implicitly
 *   ab.gates          [{ id, x, z, heading, width }]  heading points INTO the base
 *   ab.runwayStart    { x, z, heading }  jet takeoff: heading = +a (east)
 *   ab.runwayEnd      { x, z, heading }  the reciprocal
 *   ab.apronSlots     [{ x, z, heading, kind: 'jet'|'tank'|'jeep' }]
 *   ab.patrol         [[x, z] ...]   guard loop, inside the fence
 *   ab.insidePerimeter(x, z)         the encounter agent's fence test
 */
export function finaliseAirbase(ab = AIRBASE) {
  if (!ab.pad || !ab.layout) return null;
  const W = (d, a) => {
    const o = abWorld(ab, d, a, {});
    return [o.x, o.z];
  };
  ab.perimeter = FENCE_POLY.map(([a, d]) => W(d, a));
  ab.gates = GATES.map((g) => {
    const [x, z] = W(g.d, g.a);
    // Inward = +d for both gates (their fence faces look toward -d/outside).
    const inw = abWorld(ab, g.d + 1, g.a, {});
    const heading = Math.atan2(inw.x - x, inw.z - z);
    return { id: g.id, x, z, heading, width: g.half * 2 };
  });
  const toeIn = 30;
  {
    const [sx, sz] = W(0, RUNWAY.a0 + toeIn);
    const [ex, ez] = W(0, RUNWAY.a1 - toeIn);
    // +a in world is (sin yaw, cos yaw): heading straight down the runway.
    ab.runwayStart = { x: sx, z: sz, heading: ab.yaw };
    ab.runwayEnd = { x: ex, z: ez, heading: ab.yaw + Math.PI };
  }
  const slots = [];
  // Jets: the north apron row, noses toward the taxiway (+d, i.e. heading
  // out of the stand). Six stands, 90 m apart.
  for (let i = 0; i < 6; i++) {
    const [x, z] = W(-86, 90 + i * 92);
    slots.push({ x, z, heading: normYaw(ab.yaw + Math.PI / 2), kind: 'jet' });
  }
  // Tanks: two rows mid-apron, 8 stands.
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < 4; i++) {
      const [x, z] = W(-140 - r * 34, 90 + i * 52);
      slots.push({ x, z, heading: normYaw(ab.yaw + Math.PI / 2), kind: 'tank' });
    }
  }
  // Jeeps: the east end row by the gate road, 6 stands.
  for (let i = 0; i < 6; i++) {
    const [x, z] = W(-124 - i * 14, 560);
    slots.push({ x, z, heading: normYaw(ab.yaw - Math.PI / 2), kind: 'jeep' });
  }
  ab.apronSlots = slots;
  // Patrol loop, 16 m inside the fence, corners + long-edge midpoints.
  const inset = 16;
  const ring = [
    [-640, 26], [0, 26], [640, 26], [656 - inset, -120], [640, -242],
    [330, -242], [34, -242], [34, -116], [-300, -84], [-640, -84],
  ];
  ab.patrol = ring.map(([a, d]) => W(d, a));
  ab.insidePerimeter = (x, z) => {
    abLocal(ab, x, z, _lo);
    return inRect(FIELD_STRIP, _lo.a, _lo.d) || inRect(FIELD_APRON, _lo.a, _lo.d);
  };
  return ab;
}

function normYaw(y) {
  while (y > Math.PI) y -= 2 * Math.PI;
  while (y < -Math.PI) y += 2 * Math.PI;
  return y;
}

/* -------------------------------------------------------------- paving --- */

const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });

/**
 * Build the emitted paving: runway deck + parallel taxiway + links + the
 * big apron + both gate throats, white runway markings, yellow taxi lines
 * and apron stand rows, edge lamps, and an invisible collision mesh of the
 * same quads ('asphalt' / 'concrete') so wheel and gear rays find pavement.
 *
 * @param {object} ab    `AIRBASE`, graded
 * @param {object} opts  { terrain, roads, mat } — same contract as
 *                       `buildAirfieldPaving`; the gate passes a stub `mat`.
 */
export function buildAirbasePaving(ab, { terrain, roads, mat }) {
  if (abDisabled() || !ab.pad || !ab.layout) return null;
  const col = new Accum('ab_col');
  const deck = new Accum('ab_deck');
  const apron = new Accum('ab_apron');
  const paintW = new Accum('ab_paint_w');
  const paintY = new Accum('ab_paint_y');
  const lamps = new Accum('ab_lamp');
  const cut = (d, a, extra = 0) => {
    abWorld(ab, d, a, _w);
    return corridorCutAt(roads, _w.x, _w.z, extra);
  };

  /** One paved rect: deck + collision quads on the bench, skirted, hole-cut. */
  const pave = (r, acc) => {
    const nA = Math.max(1, Math.round((r.a1 - r.a0) / STEP));
    const nD = Math.max(1, Math.round((r.d1 - r.d0) / STEP));
    const va = (d, a) => {
      abWorld(ab, d, a, _w);
      const y = padY(ab, a) + LIFT;
      return {
        deck: acc.vert(_w.x, y, _w.z, 0, 1, 0, _w.x * 0.11, _w.z * 0.11, 0, 0.38, 0.12),
        col: col.vert(_w.x, y, _w.z, 0, 1, 0, 0, 0),
      };
    };
    let prev = null;
    for (let i = 0; i <= nA; i++) {
      const a = r.a0 + ((r.a1 - r.a0) * i) / nA;
      const colV = [];
      for (let j = 0; j <= nD; j++) colV.push(va(r.d0 + ((r.d1 - r.d0) * j) / nD, a));
      if (prev) {
        const aMid = a - (r.a1 - r.a0) / (2 * nA);
        for (let j = 0; j < nD; j++) {
          const dMid = r.d0 + ((r.d1 - r.d0) * (j + 0.5)) / nD;
          if (cut(dMid, aMid)) continue;
          acc.faceQuad(prev[j].deck, colV[j].deck, colV[j + 1].deck, prev[j + 1].deck, 0, 1, 0);
          col.faceQuad(prev[j].col, colV[j].col, colV[j + 1].col, prev[j + 1].col, 0, 1, 0);
        }
      }
      prev = colV;
    }
    // Perimeter skirt (hides the deck edge against the blended dirt).
    const skirt = (d0, a0, d1, a1) => {
      const len = Math.hypot(d1 - d0, a1 - a0);
      const nS = Math.max(1, Math.round(len / STEP));
      const ox = (a1 - a0) / len;
      const oz = -(d1 - d0) / len;
      let pv = null;
      for (let i = 0; i <= nS; i++) {
        const t = i / nS;
        const d = d0 + (d1 - d0) * t;
        const a = a0 + (a1 - a0) * t;
        abWorld(ab, d, a, _w);
        const yT = padY(ab, a) + LIFT;
        const top = acc.vert(_w.x, yT, _w.z, 0, 1, 0, _w.x * 0.11, _w.z * 0.11, 0, 0.4, 0.2);
        abWorld(ab, d + ox * 0.4, a + oz * 0.4, _w);
        const bot = acc.vert(_w.x, yT - 0.55, _w.z, 0, 1, 0, _w.x * 0.11, _w.z * 0.11, 0, 0.5, 0.35);
        if (pv) acc.quad(pv[0], top, bot, pv[1]);
        pv = [top, bot];
      }
    };
    skirt(r.d0, r.a0, r.d1, r.a0);
    skirt(r.d1, r.a0, r.d1, r.a1);
    skirt(r.d1, r.a1, r.d0, r.a1);
    skirt(r.d0, r.a1, r.d0, r.a0);
  };

  pave(RUNWAY, deck);
  pave(TAXIWAY, apron);
  for (const l of LINKS) pave(l, apron);
  pave(APRON, apron);
  pave(STUB_MAIN, apron);
  pave(STUB_BACK, apron);

  /** A painted rect (field-local), hole-cut like the deck. */
  const mark = (acc, dc, ac, wD, wA) => {
    if (cut(dc, ac, 0.6)) return;
    const v = (d, a) => {
      abWorld(ab, d, a, _w);
      return acc.vert(_w.x, padY(ab, a) + LIFT + PAINT_LIFT, _w.z, 0, 1, 0, _w.x * 0.7, _w.z * 0.7, 0, 0.25, 0);
    };
    acc.faceQuad(
      v(dc - wD / 2, ac - wA / 2), v(dc + wD / 2, ac - wA / 2),
      v(dc + wD / 2, ac + wA / 2), v(dc - wD / 2, ac + wA / 2), 0, 1, 0
    );
  };

  const { L } = ab.layout;
  // Runway centreline dashes: 24 m on, 18 m off (a bigger field's rhythm).
  for (let a = -L / 2 + 46; a + 24 <= L / 2 - 46; a += 42) mark(paintW, 0, a + 12, 1.0, 24);
  // Runway edge stripes, both sides, dashed so crossings can hole them.
  for (const dEdge of [-(RW_HALF - 1.4), RW_HALF - 1.4]) {
    for (let a = -L / 2 + 20; a + 14 <= L / 2 - 20; a += 16) mark(paintW, dEdge, a + 7, 0.6, 14);
  }
  // Threshold piano keys: eight bars each end for the wide strip.
  for (const end of [-1, 1]) {
    const a = end * (L / 2 - 20);
    for (let i = 0; i < 8; i++) mark(paintW, (i - 3.5) * 4.9, a, 1.5, 14);
  }
  // Heading numbers each end (same seven-segment scheme as the airfields).
  const yawDeg = ((Math.atan2(Math.sin(ab.yaw), Math.cos(ab.yaw)) * 180) / Math.PI + 360) % 360;
  const hdg = Math.round(yawDeg / 10) || 36;
  const recip = ((hdg + 17) % 36) + 1;
  const SEG = {
    t: [0, 3.2, 3.4, 0.8], m: [0, 0, 3.4, 0.8], b: [0, -3.2, 3.4, 0.8],
    tl: [-1.7, 1.7, 0.8, 2.6], tr: [1.7, 1.7, 0.8, 2.6],
    bl: [-1.7, -1.7, 0.8, 2.6], br: [1.7, -1.7, 0.8, 2.6],
  };
  const DIGIT = {
    0: ['t', 'b', 'tl', 'tr', 'bl', 'br'], 1: ['tr', 'br'],
    2: ['t', 'm', 'b', 'tr', 'bl'], 3: ['t', 'm', 'b', 'tr', 'br'],
    4: ['m', 'tl', 'tr', 'br'], 5: ['t', 'm', 'b', 'tl', 'br'],
    6: ['t', 'm', 'b', 'tl', 'bl', 'br'], 7: ['t', 'tr', 'br'],
    8: ['t', 'm', 'b', 'tl', 'tr', 'bl', 'br'], 9: ['t', 'm', 'b', 'tl', 'tr', 'br'],
  };
  const SCALE = 1.6; // the military digits are half again the civilian size
  for (const end of [-1, 1]) {
    const txt = String(end < 0 ? hdg : recip).padStart(2, '0');
    const aBase = end * (L / 2 - 40);
    for (let ch = 0; ch < 2; ch++) {
      const dc = (ch - 0.5) * 6 * SCALE * -end;
      for (const sName of DIGIT[+txt[ch]] ?? []) {
        const [sd, sa, sw, sh] = SEG[sName];
        mark(paintW, dc + sd * SCALE * -end, aBase + sa * SCALE * end, sw * SCALE, sh * SCALE);
      }
    }
  }
  // Taxiway centreline: continuous yellow, plus each link's lead-in line.
  const tc = (TAXIWAY.d0 + TAXIWAY.d1) / 2;
  for (let a = TAXIWAY.a0 + 4; a + 10 <= TAXIWAY.a1 - 4; a += 12) mark(paintY, tc, a + 5, 0.4, 10);
  for (const l of LINKS) {
    const ac = (l.a0 + l.a1) / 2;
    for (let d = l.d0 + 2; d + 5 <= l.d1 + 4; d += 6) mark(paintY, d + 2.5, ac, 5, 0.4);
  }
  // Apron edge: yellow boundary stripe inset 1.5, dashed.
  for (let a = APRON.a0 + 4; a + 8 <= APRON.a1 - 4; a += 12) {
    mark(paintY, APRON.d0 + 1.5, a + 4, 0.5, 8);
    mark(paintY, APRON.d1 - 1.5, a + 4, 0.5, 8);
  }
  // Jet stand lead-in Ts on the north apron row.
  for (let i = 0; i < 6; i++) {
    const ac = 90 + i * 92;
    mark(paintY, -78, ac, 14, 0.5);
    mark(paintY, -84, ac, 0.5, 9);
  }
  // Gate throats: yellow hazard bars across both stubs.
  for (const st of [STUB_MAIN, STUB_BACK]) {
    const ac = (st.a0 + st.a1) / 2;
    for (let d = st.d0 + 3; d + 2.2 <= st.d1 - 1; d += 5.2) mark(paintY, d + 1.1, ac, 2.2, (st.a1 - st.a0) - 4);
  }

  // Edge + threshold lamps.
  const lampGeo = new THREE.BoxGeometry(0.26, 0.32, 0.26);
  const m4 = new THREE.Matrix4();
  const putLamp = (d, a) => {
    if (cut(d, a, 0.8)) return;
    abWorld(ab, d, a, _w);
    m4.makeTranslation(_w.x, padY(ab, a) + LIFT + 0.16, _w.z);
    lamps.add(lampGeo, m4);
  };
  for (let a = -L / 2 + 12; a <= L / 2 - 12; a += 38) {
    putLamp(-(RW_HALF + 1.4), a);
    putLamp(RW_HALF + 1.4, a);
  }
  for (const end of [-1, 1]) {
    for (let i = -3; i <= 3; i++) putLamp(i * 4.6, end * (L / 2 + 1.6));
  }
  // Apron floodline lamps along the taxiway edge of the apron.
  for (let a = APRON.a0 + 20; a <= APRON.a1 - 20; a += 60) putLamp(APRON.d1 + 1.2, a);
  lampGeo.dispose();

  /* ---- meshes -------------------------------------------------------- */
  const group = new THREE.Group();
  group.name = 'airbase_ab_ridge';
  group.matrixAutoUpdate = false;
  let tris = 0;
  const emit = (acc, key, opts = {}) => {
    if (acc.empty) return;
    const geo = acc.build();
    const mesh = new THREE.Mesh(geo, mat(key));
    mesh.name = `ab_${key}`;
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.userData.owNoShadow = true;
    mesh.userData.owStatic = true;
    mesh.userData.collision = false;
    mesh.userData.surface = opts.surface ?? 'asphalt';
    if (opts.order !== undefined) mesh.renderOrder = opts.order;
    group.add(mesh);
    tris += geo.index.count / 3;
  };
  emit(deck, 'runway_mil');
  emit(apron, 'apron_mil', { surface: 'concrete' });
  emit(paintW, 'runway_paint', { order: 1 });
  emit(paintY, 'mil_paint_yellow', { order: 1 });
  emit(lamps, 'runway_lamp', { surface: 'glass' });

  let colMesh = null;
  if (!col.empty) {
    colMesh = new THREE.Mesh(col.build(), INVISIBLE);
    colMesh.name = 'ab_col';
    colMesh.visible = false;
    colMesh.matrixAutoUpdate = false;
    colMesh.userData.surface = 'asphalt';
  }
  void terrain; // the bench is analytic (padY); accepted for API parity
  return { group, colMesh, stats: { tris } };
}
