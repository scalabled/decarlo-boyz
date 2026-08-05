import { RoadGraph } from './roadgraph.js';
import {
  RIVERS, DISTRICTS, BRIDGES, BLUFF, ROAD_KIND,
  SAFEHOUSES, SERVICES, DOCKS, LANDMARKS, POI_PAD, LANDMARK_RESERVE,
  corridorHalfWidth, roadHalfWidth, clamp01, smoothstep, smootherstep, lerp, segDist2,
  nearestSiteDist,
} from './plan.js';
import { gradeAirfields, airfieldAt, levelAirfieldRoads } from './airfield.js';
import {
  gradeAirbase, airbaseAt, levelAirbaseRoads, reserveAirbase, airbaseAccessCorridors,
} from './airbase.js';

/**
 * WORLD — city layout generation.
 *
 * Produces, in one pass at init (data only — no geometry):
 *   • a set of CORRIDORS: polylines with a road class, authored to give Steel
 *     City its shape — riverfront arterials on all six banks, three parkways,
 *     eleven bridges, a downtown grid on the river's angle, and switchbacks
 *     climbing Mt. Washington, Troy Hill and the West End;
 *   • the planar ROAD GRAPH those corridors intersect into;
 *   • the BLOCKS between the streets, which `lots.js` subdivides;
 *   • a road CORRIDOR HEIGHT FIELD the terrain is flattened against, so the
 *     ground meets the kerb instead of cutting through it.
 *
 * Nothing here is perfectly straight: every generated street carries a low
 * amplitude bend, grid angles vary per district, and spacing is jittered.
 */

const MAP_EDGE = 1420;
const _seg = { d2: 0, t: 0 };

/* ------------------------------------------------------------- polylines -- */

/** Offset a polyline sideways by `d` (positive = right of travel). */
function offsetPath(pts, d) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    let nx = 0;
    let nz = 0;
    if (i > 0) {
      const q = pts[i - 1];
      const dx = p[0] - q[0];
      const dz = p[1] - q[1];
      const l = Math.hypot(dx, dz) || 1;
      nx += -dz / l;
      nz += dx / l;
    }
    if (i < n - 1) {
      const q = pts[i + 1];
      const dx = q[0] - p[0];
      const dz = q[1] - p[1];
      const l = Math.hypot(dx, dz) || 1;
      nx += -dz / l;
      nz += dx / l;
    }
    const l = Math.hypot(nx, nz) || 1;
    out.push([p[0] + (nx / l) * d, p[1] + (nz / l) * d]);
  }
  return out;
}

/** Resample a polyline at roughly `step` metres, adding a gentle wander. */
function resample(pts, step, wander = 0, seed = 0) {
  const out = [];
  let acc = 0;
  let idx = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      let x = a[0] + (b[0] - a[0]) * t;
      let z = a[1] + (b[1] - a[1]) * t;
      if (wander > 0) {
        const dx = (b[0] - a[0]) / len;
        const dz = (b[1] - a[1]) / len;
        const w = Math.sin(acc * 0.0032 + seed) * 0.6 + Math.sin(acc * 0.0091 + seed * 2.3) * 0.4;
        x += -dz * w * wander;
        z += dx * w * wander;
      }
      out.push([x, z]);
      acc += len / n;
      idx++;
    }
  }
  out.push(pts[pts.length - 1].slice());
  return out;
}

function pathLength(pts) {
  let l = 0;
  for (let i = 0; i < pts.length - 1; i++) l += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return l;
}

/**
 * Split a polyline into the runs that are on dry land inside the map.
 * `margin` metres of setback from the waterline.
 */
function clipToLand(pts, terrain, margin = 12, maxSlope = 1) {
  const runs = [];
  let cur = null;
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i];
    const ok =
      Math.abs(x) < MAP_EDGE &&
      Math.abs(z) < MAP_EDGE &&
      terrain.waterDist(x, z) > margin &&
      (maxSlope >= 1 || terrain.slopeAt(x, z, 8) < maxSlope);
    if (ok) {
      if (!cur) runs.push((cur = []));
      cur.push([x, z]);
    } else cur = null;
  }
  return runs.filter((r) => r.length >= 2 && pathLength(r) > 34);
}

/* -------------------------------------------------------------- corridor -- */

/**
 * Who wins when two corridors want the same ground. Lower is more important.
 *
 * Twelve district grids on twelve angles overlap each other, ten named
 * connectors are drawn straight through all of them, and the quays and
 * parkways share the same banks — so a third of the network used to be paved
 * TWICE by a near-parallel corridor. Two carriageways a couple of metres apart
 * pave over each other's kerbs, verges and lane paint, which is why downtown
 * read as an apron rather than a street, and it gave `nearestEdge` two equally
 * good answers to every question `traffic` asked it.
 *
 * `dedupeCorridors` below resolves it in this order. See the note there for why
 * the first attempt at it — which simply cut the covered stretches out — had to
 * be reverted, and what the merge taper does about it.
 */
const PRI = {
  bridge: 1,
  approach: 2,
  connector: 3,
  waterfront: 4,
  /** The road round a landmark: it is the thing every cut street merges into. */
  ring: 4.5,
  hill: 5,
  grid: 6,
  alley: 7,
};

let _cid = 0;
function corridor(pts, kind, lanes, opts = {}) {
  return {
    id: opts.id ?? `c${_cid++}`,
    name: opts.name ?? null,
    kind,
    lanes,
    oneway: !!opts.oneway,
    pri: opts.pri ?? PRI.grid,
    pts,
    /** parallel to pts; null = follow the ground */
    y: opts.y ?? null,
    /** parallel to pts; which vertices may NOT be moved by height relaxation */
    pin: opts.pin ?? null,
    bridge: !!opts.bridge,
    bridgeId: opts.bridgeId ?? null,
    district: opts.district ?? null,
    rail: !!opts.rail,
  };
}

/* ----------------------------------------------------- landmark reserve -- */

/**
 * RESERVE THE LANDMARK SITES — no drivable road through the Steel Bowl.
 *
 * Twelve district grids, six riverfront quays, three parkways and ten
 * connectors are laid by authors that know nothing about each other and
 * nothing about the six hand-authored landmarks, whose coordinates this file
 * has imported from `plan.js` all along and never looked at. The result,
 * measured by `src/buildings/roadsweep.mjs` against emitted building
 * triangles: 114 drivable directions with EVERY lane blocked at one station —
 * three highway segments and an alley through the Steel Bowl's pier ring, a
 * street 4.4 m from the centre of the Strip Market, a parkway whose lane edge
 * is 2.2 m INSIDE the Steel Tower's podium.
 *
 * That is a road the graph promises and the geometry refuses, and it is this
 * file's defect: `buildings` can only clear it by cutting holes in the
 * landmarks (its `landmarkGuard`, shipped off — it deletes two 40 m hot-blast
 * stoves out of the mill).
 *
 * TWO HALVES, AND THE SECOND IS WHAT MAKES THE FIRST SAFE.
 *
 *   1. CUT. Every drivable corridor is split into the runs that stay
 *      `LANDMARK_RESERVE` metres clear of every site. This is the same shape
 *      as `clipToLand` — a street simply does not cross a stadium — and it is
 *      what `landmarkClaims` has always done to LOTS.
 *
 *   2. RING. Each site gets a road round it, laid exactly on the isoline the
 *      cuts were made at. Cutting alone is what the dedup pass' own note warns
 *      about: a fragment that ends in open ground is a stub, and a stub whose
 *      other end is also cut is an island. Here every cut end lands ON the
 *      ring and is pushed `LM_SPUR` metres past it, so `buildGraph`'s
 *      intersection solver splits the ring there and joins them — the street
 *      does not stop at the stadium, it runs into the road round it. It also
 *      keeps a carriageway within reach of the landmark, which `resolvePoi`
 *      requires (it rejects a POI with no drivable edge inside 70 m) and which
 *      is the difference between a stadium you can drive to and a hole in the
 *      map.
 *
 * Bridges, pinned decks and mill trackage are exempt: a deck is the map's
 * chokepoint and a siding into a mill is the point of a mill. Nothing
 * downstream would notice if one of them did cross a site, so this counts them
 * and says so.
 */
const LM_SPUR = 4;
/** A fragment shorter than this is a stub you can drive to the end of. */
const LM_MINKEEP = 34;

/**
 * Solve the bearing of every landmark whose site is oriented by the hill
 * rather than by an authored angle — today, the Duquesne Incline.
 *
 * WHICH WAY IS UP, DECIDED ONCE. Score 48 bearings by what the ground does
 * along the whole run, rewarding climb and punishing any descent, so a bearing
 * that crosses a dip to reach high ground loses to one that climbs steadily.
 * That is the same criterion `buildings`' `incline()` used to apply for
 * itself; the difference is that this runs on the RAW terrain before a single
 * corridor is laid, and the answer is then PUBLISHED — `world.landmarks[].site`
 * and `[].uphill.dir` — so the trestle, the reserved capsule and the ring road
 * are all built from one number instead of three guesses at it.
 *
 * It has to be this way round. `incline()` probes `walkableHeightAt`, which
 * includes the 0.55 m the road corridors sink the ground by; reserving the
 * ground under the trestle therefore MOVED the bearing it discovered, by 30
 * degrees, straight out of the capsule reserved for it.
 */
export function orientLandmarkSites(terrain) {
  for (const lm of LANDMARKS) {
    const up = lm.uphill;
    const s = lm.site;
    if (!up || !s) continue;
    const RUN = up.run ?? 180;
    const base = terrain.heightAt(lm.x, lm.z);
    let bestScore = -Infinity;
    let dirX = 0;
    let dirZ = 1;
    let bestRise = 0;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const sx = Math.sin(a);
      const sz = Math.cos(a);
      let score = 0;
      let prev = base;
      let h = base;
      for (let k = 1; k <= 8; k++) {
        h = terrain.heightAt(lm.x + sx * (k / 8) * RUN, lm.z + sz * (k / 8) * RUN);
        score += h - prev - Math.max(0, prev - h) * 3;
        prev = h;
      }
      if (score > bestScore) {
        bestScore = score;
        dirX = sx;
        dirZ = sz;
        bestRise = h - base;
      }
    }
    up.dir = [dirX, dirZ];
    up.rise = bestRise;
    // The capsule's local +z is the climb: zhat = (-sin yaw, cos yaw).
    s.yaw = Math.atan2(-dirX, dirZ);
    s.ox = dirX * s.hz;
    s.oz = dirZ * s.hz;
  }
}

/**
 * A/B hatch, same shape as `?nodedup=1`: a fix you cannot un-apply is a fix
 * you cannot prove. `?nolmreserve=1` on the page is the one that works from a
 * harness — `src/world/lmsweep.mjs --noreserve` appends it, and that is the
 * negative control the gate is proved with. `OW_NO_LMRESERVE=1` only reaches
 * this if `netgen` is ever driven from Node: `vite.config.js` defines no
 * `process.env` shim, so the browser never sees an environment variable.
 */
function reserveDisabled() {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('nolmreserve') === '1') return true;
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.OW_NO_LMRESERVE === '1') return true;
  } catch { /* no process */ }
  return false;
}

/**
 * A/B hatch for the landmark dead-end weld (`weldLandmarkDeadEnds`), same shape
 * as `reserveDisabled`. `?noringweld=1` on the page — `drivesweep.mjs
 * --noringweld` appends it — lays the graph without the weld so the orphan
 * count climbs back, which is the negative control the ring-orphan ratchet is
 * proved with.
 */
function ringWeldDisabled() {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('noringweld') === '1') return true;
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.OW_NO_RINGWELD === '1') return true;
  } catch { /* no process */ }
  return false;
}

/**
 * The point on the segment `p -> beyond` where the reserve isoline is crossed,
 * pushed `LM_SPUR` metres further in so the last segment CROSSES the ring's
 * centreline instead of stopping on it — `intersect()` needs a crossing, and a
 * corridor end welds to nothing beyond `WELD` = 7 m.
 *
 * `nearestSiteDist` is the min of several exact rounded-box fields, so it is
 * 1-Lipschitz but not monotone along an arbitrary chord; bisection on the
 * bracket [outside, inside] is what is safe here, not a Newton march.
 */
function reserveEnd(p, beyond) {
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 20; k++) {
    const m = (lo + hi) * 0.5;
    const d = nearestSiteDist(p[0] + (beyond[0] - p[0]) * m, p[1] + (beyond[1] - p[1]) * m);
    if (d >= LANDMARK_RESERVE) lo = m;
    else hi = m;
  }
  const ex = p[0] + (beyond[0] - p[0]) * lo;
  const ez = p[1] + (beyond[1] - p[1]) * lo;
  const dx = beyond[0] - p[0];
  const dz = beyond[1] - p[1];
  const l = Math.hypot(dx, dz) || 1;
  return [ex + (dx / l) * LM_SPUR, ez + (dz / l) * LM_SPUR];
}

function reserveLandmarks(corridors) {
  if (reserveDisabled()) {
    console.warn('[world] landmark reservation DISABLED — roads laid through the authored sites');
    return { corridors, on: false, cut: 0, cutKm: 0, dropped: 0, exempt: 0 };
  }
  const out = [];
  let cut = 0;
  let cutLen = 0;
  let dropped = 0;
  let exempt = 0;
  for (const c of corridors) {
    if (c.bridge || c.y || c.rail) {
      for (const p of c.pts) {
        if (nearestSiteDist(p[0], p[1]) < 0) {
          exempt++;
          break;
        }
      }
      out.push(c);
      continue;
    }
    const n = c.pts.length;
    const d = new Array(n);
    let hit = false;
    for (let i = 0; i < n; i++) {
      d[i] = nearestSiteDist(c.pts[i][0], c.pts[i][1]);
      if (d[i] < LANDMARK_RESERVE) hit = true;
    }
    if (!hit) {
      out.push(c);
      continue;
    }
    const runs = [];
    let i = 0;
    while (i < n) {
      if (d[i] < LANDMARK_RESERVE) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && d[j] >= LANDMARK_RESERVE) j++;
      const pts = c.pts.slice(i, j).map((p) => p.slice());
      if (i > 0) pts.unshift(reserveEnd(c.pts[i], c.pts[i - 1]));
      if (j < n) pts.push(reserveEnd(c.pts[j - 1], c.pts[j]));
      if (pts.length >= 2 && pathLength(pts) >= LM_MINKEEP) runs.push(pts);
      else dropped++;
      i = j;
    }
    cut++;
    const before = pathLength(c.pts);
    let after = 0;
    for (const r of runs) after += pathLength(r);
    cutLen += Math.max(0, before - after);
    for (let k = 0; k < runs.length; k++) {
      out.push({ ...c, id: runs.length > 1 ? `${c.id}~${k}` : c.id, pts: runs[k] });
    }
  }
  return { corridors: out, on: true, cut, cutKm: cutLen / 1000, dropped, exempt };
}

/**
 * The road round each site: the `LANDMARK_RESERVE` isoline of the site field,
 * which for a rounded box is exactly another rounded box with the corner
 * radius grown by the reserve. Emitted as a closed loop and then run through
 * `clipToLand`, so the parts that would stand in the Allegheny (the Point) or
 * up a 39-degree face (the Incline) censor themselves.
 */
function landmarkRings(terrain) {
  if (reserveDisabled()) return [];
  const out = [];
  for (const lm of LANDMARKS) {
    const s = lm.site;
    if (!s) continue;
    const R = s.r + LANDMARK_RESERVE;
    const cx = lm.x + s.ox;
    const cz = lm.z + s.oz;
    const ca = Math.cos(s.yaw);
    const sa = Math.sin(s.yaw);
    // Four quarter-arcs about the four corners. Consecutive arcs meet across
    // the straight edges, so the chords between them ARE the box's sides.
    const corners = [[s.hx, s.hz], [-s.hx, s.hz], [-s.hx, -s.hz], [s.hx, -s.hz]];
    const STEP = 8 * (Math.PI / 180);
    const per = Math.max(3, Math.ceil(Math.PI / 2 / STEP));
    const loop = [];
    for (let k = 0; k < 4; k++) {
      const [kx, kz] = corners[k];
      for (let i = 0; i <= per; i++) {
        const a = (k + i / per) * (Math.PI / 2);
        const lx = kx + Math.cos(a) * R;
        const lz = kz + Math.sin(a) * R;
        loop.push([cx + lx * ca - lz * sa, cz + lx * sa + lz * ca]);
      }
    }
    loop.push(loop[0].slice());
    const runs = clipToLand(resample(loop, 22, 0), terrain, 12, 0.5);
    for (let i = 0; i < runs.length; i++) {
      out.push(corridor(runs[i], 'street', 2, {
        id: runs.length > 1 ? `ring_${lm.id}_${i}` : `ring_${lm.id}`,
        name: `${lm.name} Circle`,
        pri: PRI.ring,
      }));
    }
  }
  return out;
}

/* ----------------------------------------------------------------- dedup -- */

/**
 * DEDUP — one piece of ground, one road.
 *
 * Corridors are laid down by twelve independent authors (a grid per district,
 * a quay and a parkway per river bank, ten cross-town connectors, the hill
 * switchbacks) and none of them looks to see whether the ground is already a
 * street. Where two end up near-parallel and a few metres apart, both get a
 * full carriageway and the pair paves over everything between them: no kerb, no
 * verge, no lane line. That is the "airport apron" the critics reported
 * downtown, and it is also why cars leave the carriageway there — a kerb that
 * has been paved over cannot stop anything.
 *
 * WHY THE FIRST ATTEMPT AT THIS WAS REVERTED. Cutting the covered stretch out
 * of the lower-priority corridor removes 20 km of doubled road and clears every
 * kerb-overlap sample, and it also TRIPLES the stranded-node count. The reason
 * is connectivity, and it is not subtle once you see it: the two corridors are
 * near-parallel but not coincident, so when a run of corridor A is cut, the
 * piece of A that survives ends in open ground several metres to one side of B.
 * `buildGraph` connects corridors by INTERSECTION, and two near-parallel
 * segments have no intersection — `intersect()` rejects them on the determinant
 * — while the 7 m weld only fires if the cut happens to land near one of B's
 * nodes, which are up to 72 m apart. So every cut left a dead-end stub, and a
 * dead end is an island the moment its other end is cut too.
 *
 * THE MERGE TAPER is the fix. Every cut end gets one extra vertex: the foot of
 * the perpendicular onto the corridor that covers it, pushed `taper` metres
 * PAST the centreline. That last segment crosses B at 60-90 degrees instead of
 * running alongside it, so `intersect()` fires, `buildGraph` splits B there,
 * and the surviving piece of A is joined to the street that took its ground.
 * Geometrically it is what a real network does where two streets merge: a short
 * taper into the through road.
 *
 * Three more rules keep the grid whole:
 *   • a covered stretch shorter than `minCover` is a CROSSING, not a duplicate,
 *     and is left alone — this is what stops the pass shattering every corridor
 *     at every junction it passes through;
 *   • a surviving fragment shorter than `minKeep` is dropped rather than left
 *     as a stub;
 *   • corridors with a pinned height — bridges and their decks — are never cut
 *     and never even considered. The bridges are the map's chokepoints and a
 *     detoured crossing is the single most expensive defect on the list.
 */
const DEDUP = {
  /** Headings must agree to this closely for it to be the same street. */
  cos: 0.86,
  /** Metres that must remain between two carriageways for both to be real. */
  gap: 5,
  /** Height disagreement that makes it a different road (a deck over a quay). */
  dy: 3.5,
  /** A covered stretch shorter than this is a crossing, not a duplicate. */
  minCover: 60,
  /** A surviving fragment shorter than this is a stub, not a street. */
  minKeep: 72,
  /** How far past the covering centreline the merge taper reaches. */
  taper: 2.5,
  /** Length of the merge run as a multiple of the offset it has to close. */
  mergeRatio: 2.2,
};

/**
 * A/B hatch, same shape as `physics`' `?nogroundproxy=1`: a fix you cannot
 * un-apply is a fix you cannot prove. `?nodedup=1` in the browser, or
 * `OW_NO_DEDUP=1` for the headless harnesses, lays every corridor as authored.
 * Never reachable in normal play.
 */
function dedupDisabled() {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('nodedup') === '1') return true;
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.OW_NO_DEDUP === '1') return true;
  } catch { /* no process */ }
  return false;
}

function dedupeCorridors(corridors, terrain) {
  if (dedupDisabled()) {
    console.warn('[world] corridor dedup DISABLED — every corridor laid as authored');
    return { corridors, cut: 0, cutKm: 0, rawKm: 0, netKm: 0, totalKm: 0 };
  }
  const CELL = 64;
  const cells = new Map();
  const key = (cx, cz) => cx * 73856093 ^ cz * 19349663;

  /** Height of corridor `c` at vertex `i` — pinned decks know their own. */
  const yAt = (c, i) => (c.y ? c.y[i] : terrain.heightAt(c.pts[i][0], c.pts[i][1]));

  /** Unit heading at vertex `i`, from the segment either side of it. */
  const head = (c, i, out) => {
    const p = c.pts[Math.max(0, i - 1)];
    const q = c.pts[Math.min(c.pts.length - 1, i + 1)];
    const dx = q[0] - p[0];
    const dz = q[1] - p[1];
    const l = Math.hypot(dx, dz) || 1;
    out[0] = dx / l;
    out[1] = dz / l;
    return out;
  };

  const index = (c) => {
    const hw = roadHalfWidth(c.kind, c.lanes);
    for (let i = 0; i < c.pts.length - 1; i++) {
      const a = c.pts[i];
      const b = c.pts[i + 1];
      const seg = { c, i, ax: a[0], az: a[1], bx: b[0], bz: b[1], hw };
      const x0 = Math.floor((Math.min(a[0], b[0]) - CELL) / CELL);
      const x1 = Math.floor((Math.max(a[0], b[0]) + CELL) / CELL);
      const z0 = Math.floor((Math.min(a[1], b[1]) - CELL) / CELL);
      const z1 = Math.floor((Math.max(a[1], b[1]) + CELL) / CELL);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const k = key(cx, cz);
          let l = cells.get(k);
          if (!l) cells.set(k, (l = []));
          l.push(seg);
        }
      }
    }
  };

  const hA = [0, 0];
  const hB = [0, 0];
  const pool = [];
  /**
   * Is this vertex already paved by an accepted corridor running the same way?
   * Returns the foot of the perpendicular on the winner, or null.
   */
  const coveredBy = (c, i, hwC) => {
    const [x, z] = c.pts[i];
    head(c, i, hA);
    const y = yAt(c, i);
    pool.length = 0;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const l = cells.get(key(cx + dx, cz + dz));
        if (l) for (let k = 0; k < l.length; k++) pool.push(l[k]);
      }
    }
    let best = null;
    let bd = Infinity;
    for (let k = 0; k < pool.length; k++) {
      const s = pool[k];
      if (s.c === c) continue;
      segDist2(x, z, s.ax, s.az, s.bx, s.bz, _seg);
      const d = Math.sqrt(_seg.d2);
      if (d >= bd) continue;
      // THE TEST IS "IS THERE ROOM FOR A KERB BETWEEN THEM", not "does the
      // centreline fall inside the other carriageway". Two 4-lane carriageways
      // can clear each other by a metre and still be an apron: each needs a
      // kerb, a footway and a verge on this side, and there is nowhere to put
      // any of it. `gap` is the width the pair of kerb lines would need.
      if (d > hwC + s.hw + DEDUP.gap) continue;
      const dxs = s.bx - s.ax;
      const dzs = s.bz - s.az;
      const ls = Math.hypot(dxs, dzs) || 1;
      hB[0] = dxs / ls;
      hB[1] = dzs / ls;
      if (Math.abs(hA[0] * hB[0] + hA[1] * hB[1]) < DEDUP.cos) continue;
      // A deck eighteen metres over a quay is not paving the quay.
      const yb = lerp(yAt(s.c, s.i), yAt(s.c, s.i + 1), _seg.t);
      if (Math.abs(yb - y) > DEDUP.dy) continue;
      bd = d;
      best = {
        x: s.ax + dxs * _seg.t, z: s.az + dzs * _seg.t, d,
        tx: hB[0], tz: hB[1],
        ax: s.ax, az: s.az, bx: s.bx, bz: s.bz,
      };
    }
    return best;
  };

  // Bridges, decks and anything with a pinned height are laid first and are
  // never candidates: they define where the crossings are.
  const order = corridors
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.pri - b.c.pri || pathLength(b.c.pts) - pathLength(a.c.pts) || a.i - b.i);

  const runsById = new Map();
  let cut = 0;
  let cutLen = 0;
  let rawCovered = 0;
  let netCovered = 0;
  let totalLen = 0;
  for (const { c } of order) {
    if (c.rail || c.bridge || c.y) {
      index(c);
      runsById.set(c, [c.pts]);
      continue;
    }
    const n = c.pts.length;
    const hwC = roadHalfWidth(c.kind, c.lanes);
    const cov = new Array(n);
    for (let i = 0; i < n; i++) cov[i] = coveredBy(c, i, hwC);
    totalLen += pathLength(c.pts);
    for (let k = 0; k < n - 1; k++) {
      if (cov[k] && cov[k + 1]) {
        rawCovered += Math.hypot(c.pts[k + 1][0] - c.pts[k][0], c.pts[k + 1][1] - c.pts[k][1]);
      }
    }

    // Collapse short covered stretches back to uncovered: a corridor crossing
    // another at a shallow angle is covered for a vertex or two and that is a
    // junction, not a duplicate.
    let i = 0;
    while (i < n) {
      if (!cov[i]) { i++; continue; }
      let j = i;
      while (j < n && cov[j]) j++;
      let len = 0;
      for (let k = i; k < j - 1; k++) {
        len += Math.hypot(c.pts[k + 1][0] - c.pts[k][0], c.pts[k + 1][1] - c.pts[k][1]);
      }
      if (len < DEDUP.minCover) for (let k = i; k < j; k++) cov[k] = null;
      else netCovered += len;
      i = j;
    }

    // Cut into the runs that are not already paved, tapering each cut end onto
    // the corridor that took the ground.
    const runs = [];
    i = 0;
    while (i < n) {
      if (cov[i]) { i++; continue; }
      let j = i;
      while (j < n && !cov[j]) j++;
      const pts = c.pts.slice(i, j).map((p) => p.slice());
      let joined = 0;
      if (i > 0) {
        const t = taperPoint(c.pts[i], c.pts[i - 1], cov[i - 1], terrain);
        if (t) { pts.unshift(t); joined++; }
      }
      if (j < n) {
        const t = taperPoint(c.pts[j - 1], c.pts[j], cov[j], terrain);
        if (t) { pts.push(t); joined++; }
      }
      // A fragment that merges into the through road at BOTH ends is joined by
      // construction — it is a slip road, and length does not come into it.
      // `minKeep` is only about not leaving a stub you can drive to the end of.
      if (pts.length >= 2 && (joined === 2 || pathLength(pts) >= DEDUP.minKeep)) runs.push(pts);
      i = j;
    }

    const before = pathLength(c.pts);
    let after = 0;
    for (const r of runs) after += pathLength(r);
    if (runs.length !== 1 || after < before - 1) {
      cut++;
      cutLen += Math.max(0, before - after);
    }
    runsById.set(c, runs);
    // Only what SURVIVES paves the ground for everything after it.
    for (const r of runs) index({ ...c, pts: r });
  }

  // Emit in the original order so node ids stay stable run to run.
  const out = [];
  for (const c of corridors) {
    const runs = runsById.get(c) ?? [c.pts];
    if (runs.length === 1 && runs[0] === c.pts) {
      out.push(c);
      continue;
    }
    for (let k = 0; k < runs.length; k++) {
      out.push({ ...c, id: runs.length > 1 ? `${c.id}#${k}` : c.id, pts: runs[k] });
    }
  }
  return {
    corridors: out,
    /** Corridors that lost ground. */ cut,
    /** Net kilometres removed, merge tapers already added back. */ cutKm: cutLen / 1000,
    /** Kilometres found doubled before the short-crossing collapse. */ rawKm: rawCovered / 1000,
    /** ...and after it — the difference is junctions, correctly kept. */ netKm: netCovered / 1000,
    /** Kilometres of cuttable corridor considered. */ totalKm: totalLen / 1000,
  };
}

/**
 * The extra vertex that turns a cut end into a merge. `p` is the last surviving
 * point of the corridor being cut, `beyond` is the point it used to continue to
 * (so `p -> beyond` is the direction of the ground that was taken away), and
 * `foot` is the point on the corridor that took it. The taper reaches
 * `DEDUP.taper` metres past that centreline so the final segment CROSSES it and
 * `buildGraph` makes a node there.
 *
 * IT MUST BE A MERGE, NOT A JOG. The first version put the vertex on the
 * perpendicular foot, which is a right-angle corner at the end of a street, and
 * `traffic` drove it exactly as badly as that sounds: wheel-past-kerb went from
 * 4.9% to 9.2% and the worst lane error to 23.6 m, on a build whose kerbs were
 * otherwise measurably BETTER. Running the taper on down the through road for a
 * couple of times its own offset makes it a 20-25 degree merge — which is both
 * what a real network does here and something a car can take at speed.
 */
function taperPoint(p, beyond, foot, terrain) {
  let dx = foot.x - p[0];
  let dz = foot.z - p[1];
  let l = Math.hypot(dx, dz);
  if (l < 0.75) {
    // The cut landed ON the through road's centreline. There is no direction to
    // taper along, but the run still has to be JOINED — and a corridor end
    // sitting in the middle of another carriageway welds to nothing, because
    // `nodeAt` only welds within 7 m and the through road's nodes are up to
    // 72 m apart. Cross it square instead, with the shortest spur that makes a
    // node: the determinant a shallow merge would produce here is zero.
    dx = -foot.tz;
    dz = foot.tx;
    l = 1;
    return [p[0] + dx * DEDUP.taper, p[1] + dz * DEDUP.taper];
  }
  const off = (l + DEDUP.taper) / l;
  const px = p[0] + dx * off;
  const pz = p[1] + dz * off;
  // Merge the way the street was going, not back against itself.
  const ax = beyond[0] - p[0];
  const az = beyond[1] - p[1];
  const s = ax * foot.tx + az * foot.tz >= 0 ? 1 : -1;
  const run = Math.min(Math.max(l * DEDUP.mergeRatio, 16), 46);
  // Shorten the merge until the taper provably CROSSES the segment it is
  // merging into, because the whole point of the taper is that `buildGraph`
  // makes a node there. Run it too far and it can overshoot the end of that
  // segment onto ground the through road has already turned away from, which
  // is a stub — measured as exactly one two-node island in the far south.
  // A run of zero is the perpendicular foot, which crosses by construction.
  for (const k of [1, 0.5, 0.25, 0]) {
    const mx = px + foot.tx * s * run * k;
    const mz = pz + foot.tz * s * run * k;
    if (Math.abs(mx) > MAP_EDGE || Math.abs(mz) > MAP_EDGE) continue;
    if (terrain.waterDist(mx, mz) < 6) continue;
    if (k > 0 && !crosses(p[0], p[1], mx, mz, foot.ax, foot.az, foot.bx, foot.bz)) continue;
    return [mx, mz];
  }
  return [px, pz];
}

/** Do segments p-q and a-b properly cross? Same test `buildGraph` will apply. */
function crosses(px, pz, qx, qz, ax, az, bx, bz) {
  const rx = qx - px;
  const rz = qz - pz;
  const sx = bx - ax;
  const sz = bz - az;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return false;
  const ox = ax - px;
  const oz = az - pz;
  const t = (ox * sz - oz * sx) / den;
  const u = (ox * rz - oz * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/* ---------------------------------------------------------------- blocks -- */

function blockFromQuad(p0, p1, p2, p3, district, kind) {
  const cx = (p0[0] + p1[0] + p2[0] + p3[0]) / 4;
  const cz = (p0[1] + p1[1] + p2[1] + p3[1]) / 4;
  return { poly: [p0, p1, p2, p3], cx, cz, district, kind };
}

/* ============================================================== generator = */

export function generateCity(terrain, rng) {
  const corridors = [];
  const blocks = [];
  const bridgeSpecs = [];

  /* ---- 0. which way does a hill-oriented landmark face? ---------------- */
  // Before anything is laid, so the answer is a fact about the terrain and not
  // about the roads. Everything downstream — the reservation, the ring, and
  // `buildings`' trestle — reads it off `plan.js`.
  orientLandmarkSites(terrain);

  /* ---- 0b. bench the two airfields into the heightfield ----------------- */
  // BEFORE any corridor is laid, so a road crossing a field solves its node
  // heights against the graded bench and lies flat ON it — the runway can
  // then coexist with the street grid instead of reserving 600 x 140 m of
  // city. See `src/world/airfield.js`.
  const airfieldGrade = gradeAirfields(terrain);

  /* ---- 0c. bench the military airbase --------------------------------- */
  // Same moment and same reason as 0b: the base road must solve its node
  // heights against the bench. The site was surveyed to hold zero existing
  // corridors, so unlike the strips the fence may close (see
  // `src/world/airbase.js`); `?noairbase=1` / OW_NO_AIRBASE=1 is the hatch.
  const airbaseGrade = gradeAirbase(terrain);

  /* ---- 1. river banks: the long arterials that define the waterfront ---- */
  for (const riv of RIVERS) {
    const hw = riv.width / 2;
    for (const side of [-1, 1]) {
      // Quay road, tight to the water.
      const quay = clipToLand(resample(offsetPath(riv.pts, side * (hw + 74)), 46, 5, riv.id.length), terrain, 42, 0.34);
      for (const run of quay) {
        corridors.push(
          corridor(run, 'arterial', 4, { name: `${riv.name} Quay`, id: `quay_${riv.id}_${side}`, pri: PRI.waterfront })
        );
      }
      // Parkway, set back and faster.
      const park = clipToLand(resample(offsetPath(riv.pts, side * (hw + 178)), 60, 9, 3.1), terrain, 26, 0.3);
      for (const run of park) {
        if (pathLength(run) < 420) continue;
        corridors.push(corridor(run, 'highway', 6, { name: `${riv.name} Parkway`, id: `pkwy_${riv.id}_${side}`, pri: PRI.waterfront }));
      }
    }
  }

  /* ---- 2. bridges ------------------------------------------------------ */
  for (const b of BRIDGES) {
    const spec = buildBridge(b, terrain);
    if (!spec) continue;
    bridgeSpecs.push(spec);
    corridors.push(
      corridor(spec.pts, b.kind, b.lanes, {
        id: b.id,
        name: b.name,
        y: spec.y,
        pin: spec.pin,
        bridge: true,
        bridgeId: b.id,
        pri: PRI.bridge,
      })
    );
    /**
     * APPROACHES — without these, most of the bridges are dead ends.
     *
     * A bridge's ramp stops 132 m back from the abutment, wherever that lands.
     * Nothing guarantees a street happens to cross there, and `world.probe`
     * measured the consequence: eight of the eleven crossings had a bank whose
     * ramp terminated in open ground with no other edge on it, and `route()`
     * detoured around them — round the whole city, in the West End's case, 123
     * nodes to cross one river. `DESIGN.md` makes the bridges the map's
     * chokepoints for roadblocks and missions, so a bridge that police cannot
     * be routed onto is the single most expensive thing on this list.
     *
     * The fix is at the CORRIDOR stage, not the graph stage: run an ordinary
     * street on out from each ramp tip along the bridge's own line and let the
     * planar solver intersect it with whatever it crosses. It is not flagged
     * `bridge`, so `e.bridge` still means "on the structure or its ramp".
     */
    const [adx, adz] = spec.dir;
    const ends = [[spec.pts[0], -1], [spec.pts[spec.pts.length - 1], 1]];
    for (const [tip, sgn] of ends) {
      const raw = [];
      for (let s = 0; s <= 340; s += 34) raw.push([tip[0] + adx * sgn * s, tip[1] + adz * sgn * s]);
      const runs = clipToLand(resample(raw, 34, 5, b.id.length), terrain, 10, 0.6);
      for (let i = 0; i < runs.length; i++) {
        corridors.push(
          corridor(runs[i], b.kind === 'highway' ? 'arterial' : b.kind, Math.max(2, b.lanes - 2), {
            id: `${b.id}_app${sgn > 0 ? 1 : 0}_${i}`,
            name: `${b.name} Approach`,
            pri: PRI.approach,
          })
        );
      }
    }
  }

  /* ---- 3. hill climbs -------------------------------------------------- */
  for (const sb of switchbacks(terrain)) corridors.push(sb);

  /* ---- 4. the ridge road along the top of Mt. Washington ---------------- */
  {
    const ridge = offsetPath(BLUFF.line, 96);
    const runs = clipToLand(resample(ridge, 48, 7, 5.7), terrain, 20, 0.45);
    for (const run of runs) {
      corridors.push(corridor(run, 'arterial', 2, { name: 'Grandview Avenue', id: 'grandview', pri: PRI.hill }));
    }
  }

  /* ---- 5. district street grids + blocks ------------------------------- */
  for (const d of DISTRICTS) {
    gridDistrict(d, terrain, rng.fork(), corridors, blocks);
  }

  /* ---- 6. cross-town connectors so no district is an island ------------ */
  for (const c of connectors(terrain)) corridors.push(c);

  /* ---- 7. industrial rail ---------------------------------------------- */
  for (const r of railLines(terrain)) corridors.push(r);

  /* ---- 7b. guarantee every bridge tip meets the network ----------------- */
  for (const c of linkBridgeTips(corridors, bridgeSpecs, terrain)) corridors.push(c);

  /* ---- 7c. no drivable road through a hand-authored landmark ------------ */
  const lr = reserveLandmarks(corridors);
  const reserved = lr.corridors;
  for (const c of landmarkRings(terrain)) reserved.push(c);

  /* ---- 7c2. the airbase: perimeter reserve + the welded base road ------- */
  // Cut anything inside the fence line (zero on the surveyed map — a guard),
  // then lay the one public road in: it runs from the main gate deep into
  // the Manchester/North Shore grid so `buildGraph` welds it at real street
  // crossings, the same guarantee the bridge approaches use.
  const abr = reserveAirbase(reserved);
  const withBase = abr.corridors;
  if (airbaseGrade.on) for (const c of airbaseAccessCorridors()) withBase.push(c);

  /* ---- 7d. one piece of ground, one road ------------------------------- */
  const dd = dedupeCorridors(withBase, terrain);

  /* ---- 8. solve the planar graph --------------------------------------- */
  const graph = buildGraph(dd.corridors, terrain);
  graph.dedup = dd;
  graph.landmarkReserve = lr;

  /* ---- 8b. level every road crossing an airfield's paved zone ----------- */
  // Before `rasteriseRoads`, so the corridor field, the terrain sink, the
  // road mesh and the corridor floor all inherit the level crossing.
  if (airfieldGrade.on) levelAirfieldRoads(graph);
  if (airbaseGrade.on) levelAirbaseRoads(graph);

  /* ---- 9. corridor height field the terrain is flattened against -------- */
  const { field, weight } = rasteriseRoads(graph, terrain);
  terrain.applyRoads(field, weight);

  // NOTE: node heights are NOT re-read from the terrain here. `applyRoads`
  // deliberately sinks the ground under the corridor, so reading it back would
  // walk the carriageway down by that offset every time and leave the tarmac
  // level with — or under — the dirt beside it. The solved heights are the
  // authority; the ground is what moves.
  for (const e of graph.edges) {
    const na = graph.nodes[e.a];
    const nb = graph.nodes[e.b];
    e.grade = Math.abs(nb.y - na.y) / Math.max(1, e.len);
  }

  // Drop blocks that ended up in the water, on a cliff, under a road, or on a
  // landmark site — the streets that used to bound them there no longer exist,
  // and a rowhouse block under the Steel Bowl is not a block.
  const keep = [];
  for (const b of blocks) {
    if (Math.abs(b.cx) > MAP_EDGE || Math.abs(b.cz) > MAP_EDGE) continue;
    if (lr.on && nearestSiteDist(b.cx, b.cz) < 6) continue;
    if (terrain.waterDist(b.cx, b.cz) < 8) continue;
    if (terrain.slopeAt(b.cx, b.cz, 10) > 0.52) continue;
    let wet = false;
    for (const p of b.poly) if (terrain.waterDist(p[0], p[1]) < -2) wet = true;
    if (wet) continue;
    // An airfield is open ground: no rowhouse block on the bench. Corner
    // check as well as centre — a block can straddle the field boundary.
    if (airfieldGrade.on || airbaseGrade.on) {
      let onField = !!airfieldAt(b.cx, b.cz) || !!airbaseAt(b.cx, b.cz);
      if (!onField) {
        for (const p of b.poly) {
          if (airfieldAt(p[0], p[1]) || airbaseAt(p[0], p[1])) {
            onField = true;
            break;
          }
        }
      }
      if (onField) continue;
    }
    keep.push(b);
  }

  /* ---- 10. flat, kerbside forecourts at every point of interest --------- */
  const pois = applyPoiPads(graph, terrain);

  return { graph, blocks: keep, corridors: dd.corridors, bridges: bridgeSpecs, pois };
}

/* ---------------------------------------------------------------- POIs --- */

/**
 * Resolve every point of interest to somewhere a player can actually USE it,
 * and level the ground there.
 *
 * `DESIGN.md` puts the shops, pumps, resprays and safehouses at fixed
 * coordinates ported from the legacy 700 m map. On a 3 km map with real terrain
 * some of those land on a 30% slope, in a lot with no road frontage, or — in
 * Carson's case, because his safehouse IS a boathouse — on the waterline. A
 * service you trigger by standing still needs three things and `game` cannot
 * provide any of them: level ground, dry ground, and a carriageway you can
 * arrive on. That is `world`'s job.
 *
 * For each POI: find the nearest drivable edge, take the kerbside forecourt on
 * the POI's own side of it, walk inland if that is wet, stamp a flat pad at the
 * road's height, and record the approach heading so a mission can park a car
 * facing the right way.
 */
export function applyPoiPads(graph, terrain) {
  const out = [];
  const groups = [
    [SERVICES, null],
    [SAFEHOUSES, 'safehouse'],
    [DOCKS, 'dock'],
    [LANDMARKS, 'landmark'],
  ];
  for (const [list, kind] of groups) {
    for (const p of list) {
      const spot = resolvePoi(p, graph, terrain, kind ?? p.kind ?? 'service');
      out.push(spot);
      // A landmark is scenery — flattening the fountain plaza into the Point
      // would put a table top where the confluence is. Everything you walk up
      // to or drive onto gets a level forecourt.
      if (spot.pad) terrain.flattenDisc(spot.x, spot.z, spot.y, POI_PAD.r, POI_PAD.blend);
    }
  }
  return out;
}

/**
 * Nearest edge a CAR may use. `graph.nearestEdge` will happily hand back mill
 * trackage — it is in the graph so `roadmesh` can draw ballast and sleepers —
 * and a respray whose approach is a railway is a respray you cannot reach.
 */
function nearestDrivable(graph, x, z, maxDist) {
  const out = { edge: null, t: 0, dist: Infinity };
  const pool = [];
  for (let r = 64; r <= maxDist; r *= 2) {
    pool.length = 0;
    graph.edgesInRect(x - r, z - r, x + r, z + r, pool);
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (e.rail) continue;
      const na = graph.nodes[e.a];
      const nb = graph.nodes[e.b];
      segDist2(x, z, na.x, na.z, nb.x, nb.z, _seg);
      const d = Math.sqrt(_seg.d2);
      if (d < out.dist) {
        out.dist = d;
        out.edge = e;
        out.t = _seg.t;
      }
    }
    if (out.edge && out.dist < r) break;
  }
  return out;
}

/**
 * Search outward from an authored coordinate for somewhere the place could
 * plausibly be, and score the candidates.
 *
 * `DESIGN.md`'s coordinates are legacy 700 m map numbers multiplied by four,
 * and the rivers and hills of the 3 km map were authored independently, so
 * three of them land somewhere impossible: Rustbelt Respray is ON the
 * Monongahela's centreline, Dylan's Garage is pinned to the 39-degree face of
 * the Mt. Washington bluff, and the Point Marina is mid-channel in the Ohio.
 * Rejecting them is not an option — they are story locations — so `world`
 * finds the nearest place that satisfies what the place needs to BE.
 */
function resolvePoi(p, graph, terrain, kind) {
  const dock = kind === 'dock';
  const scenery = kind === 'landmark';
  const spot = {
    id: p.id,
    name: p.name,
    kind,
    x: p.x,
    z: p.z,
    y: terrain.heightAt(p.x, p.z),
    yaw: 0,
    roadDist: Infinity,
    edge: null,
    node: -1,
    pad: !scenery,
    moved: 0,
    ok: false,
  };

  let best = null;
  let bestCost = Infinity;
  const consider = (x, z, moved) => {
    if (Math.abs(x) > 1400 || Math.abs(z) > 1400) return;
    const wd = terrain.waterDist(x, z);
    if (wd < 7) return; // in the river, or on the very lip of the bank
    // The whole FORECOURT has to be shallow, not just the middle of it: a
    // safehouse whose door is level but whose apron falls away at 48% two car
    // lengths out is a safehouse you slide out of while the save is running.
    let slope = terrain.slopeAt(x, z, 7);
    if (slope > 0.26) return;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const s2 = terrain.slopeAt(x + Math.cos(a) * 10, z + Math.sin(a) * 10, 6);
      if (s2 > slope) slope = s2;
      if (slope > 0.34) return;
    }
    // A dock has to touch the water; everything else has to touch a road.
    if (dock && wd > 34) return;
    const hit = nearestDrivable(graph, x, z, 300);
    if (!hit.edge) return;
    const e = hit.edge;
    const na = graph.nodes[e.a];
    const nb = graph.nodes[e.b];
    const cx = na.x + (nb.x - na.x) * hit.t;
    const cz = na.z + (nb.z - na.z) * hit.t;
    const cy = na.y + (nb.y - na.y) * hit.t;
    const off = corridorHalfWidth(e.kind, e.lanes) + 3.0;
    if (hit.dist < off) return; // standing in the carriageway
    if (!dock && hit.dist > 70) return;
    const cost = moved * 1.0 + hit.dist * 0.6 + slope * 260 + (dock ? Math.max(0, wd - 18) * 2 : 0);
    if (cost >= bestCost) return;
    bestCost = cost;
    best = { x, z, cx, cz, cy, edge: e, dist: hit.dist, moved };
  };

  consider(p.x, p.z, 0);
  for (let r = 12; r <= 168 && !(best && bestCost < 26); r += 12) {
    const n = Math.max(8, Math.round((r / 12) * 8));
    for (let k = 0; k < n; k++) {
      const a = ((k / n) * Math.PI * 2) + r * 0.37;
      consider(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, r);
    }
  }

  if (!best) {
    // Nothing legal anywhere near. Keep the authored point, do not stamp a pad
    // into a hillside, and let the probe report it.
    spot.pad = false;
    return spot;
  }

  const gy = terrain.heightAt(best.x, best.z);
  // Sit level with the carriageway when it is plausibly the same shelf — that
  // is what makes a forecourt something you can drive onto — and settle for
  // merely level when it is not.
  spot.x = best.x;
  spot.z = best.z;
  spot.y = !dock && Math.abs(gy - best.cy) < 3.5 ? best.cy : gy;
  spot.yaw = Math.atan2(best.cx - best.x, best.cz - best.z); // face the road
  spot.roadDist = best.dist;
  spot.edge = best.edge.id;
  spot.node = (graph.nearestNode(best.cx, best.cz, 260) ?? graph.nodes[best.edge.a]).id;
  spot.moved = best.moved;
  spot.ok = true;
  return spot;
}

/* ------------------------------------------------------------- bridges --- */

/**
 * Turn a bridge anchor pair into a polyline with pinned deck heights: land,
 * abutment, level deck across the channel, abutment, land.
 */
function buildBridge(b, terrain) {
  const ax = b.a[0];
  const az = b.a[1];
  const bx = b.b[0];
  const bz = b.b[1];
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 40) return null;
  const dx = (bx - ax) / len;
  const dz = (bz - az) / len;

  // Where the water actually is along the line.
  let w0 = -1;
  let w1 = -1;
  const step = 4;
  for (let s = 0; s <= len; s += step) {
    const wet = terrain.waterDist(ax + dx * s, az + dz * s) < 4;
    if (wet && w0 < 0) w0 = s;
    if (wet) w1 = s;
  }
  if (w0 < 0) return null;

  const s0 = Math.max(0, w0 - 30);
  const s1 = Math.min(len, w1 + 30);
  const deck = b.deckY;

  /**
   * RAMP LENGTH IS SOLVED, NOT ASSUMED.
   *
   * It used to be a flat 132 m on both sides, and where the bank is high that
   * is a wall: the Thirty-First Street Bridge lands on Troy Hill, 42 m above
   * its own deck, so its approach was a 32% average with a 60% peak in the
   * middle of the easing curve — and `world.probe` measured an edge of it at
   * 293%. Nothing drives up that, so the bridge was decorative. Size each ramp
   * for a target average grade instead, and let it run past the authored
   * anchor if it needs to; the anchors are a hint about where the crossing
   * goes, not a property boundary. `smoothstep` rather than `smootherstep`
   * because the peak grade of the latter is 1.875x the mean and this one's is
   * 1.5x, which is the difference between a hill and a ski jump.
   */
  const TARGET_GRADE = 0.075;
  const rampFor = (s, sign) => {
    /**
     * LAND WHERE THE LAND IS AT DECK HEIGHT.
     *
     * Sizing the ramp from the ground height at a fixed distance is fine on a
     * flat bank and catastrophic on a bluff: the Fort Pitt Bridge's south
     * abutment is at the foot of Mt. Washington, so a ramp of any length runs
     * further UP a hill that climbs faster than the ramp does, and the solver
     * pinned it at the 30% grade cap. `traffic` measured the result at
     * x ~ -362, z ~ 100-109 — a car on a legal lane with its wheels spinning at
     * 113% slip and a road collider inside its own length, which is what
     * "stuck against a wall made of road" looks like from the driver's side.
     *
     * Walk out from the abutment and stop where the terrain first comes up to
     * meet the deck. That is where a real approach ends, and the grade falls
     * out of the geometry instead of being clamped.
     */
    let bestS = 120;
    let bestGrade = Infinity;
    for (let L2 = 60; L2 <= 460; L2 += 10) {
      const t = s + sign * L2;
      const diff = Math.abs(terrain.heightAt(ax + dx * t, az + dz * t) - deck);
      if (diff < 1.5) return L2; // the ground has come up to meet the deck
      const grade = diff / L2;
      // The SHORTEST ramp that is comfortable, not the longest. A "smallest
      // grade" rule always picks the longest run, which throws the tip half a
      // kilometre past the abutment and out of reach of the street network —
      // measured as the Fort Pitt approach becoming a dead end again.
      if (grade <= TARGET_GRADE) return L2;
      if (grade < bestGrade) {
        bestGrade = grade;
        bestS = L2;
      }
    }
    return bestS;
  };
  const a0 = s0 - rampFor(s0, -1);
  const a1 = s1 + rampFor(s1, 1);

  const pts = [];
  const y = [];
  const pin = [];
  /**
   * Only the SPAN is pinned. The deck has to be exactly where `bridges.js` puts
   * its piers and trusses, but an approach ramp is a road on the ground and
   * should be allowed to negotiate with `relaxHeights` and `limitGrades` like
   * any other. Pinning the whole corridor is what left the Fort Pitt approach
   * at 27% with nothing able to touch it.
   */
  const push = (s, yy, p) => {
    pts.push([ax + dx * s, az + dz * s]);
    y.push(yy);
    pin.push(p);
  };

  const gA = terrain.heightAt(ax + dx * a0, az + dz * a0);
  const gB = terrain.heightAt(ax + dx * a1, az + dz * a1);
  // Sampled densely enough that `simplify` has real vertical shape to keep.
  const rampN = 8;
  push(a0, gA, false);
  for (let k = 1; k < rampN; k++) {
    const t = k / rampN;
    push(lerp(a0, s0, t), lerp(gA, deck, smoothstep(t)), false);
  }
  push(s0, deck, true);
  const spanN = Math.max(2, Math.round((s1 - s0) / 46));
  for (let k = 1; k < spanN; k++) push(lerp(s0, s1, k / spanN), deck, true);
  push(s1, deck, true);
  for (let k = 1; k < rampN; k++) {
    const t = k / rampN;
    push(lerp(s1, a1, t), lerp(deck, gB, smoothstep(t)), false);
  }
  push(a1, gB, false);

  return {
    id: b.id,
    name: b.name,
    style: b.style,
    kind: b.kind,
    lanes: b.lanes,
    deckY: deck,
    width: roadHalfWidth(b.kind, b.lanes) * 2 + (b.kind === 'highway' ? 3.2 : 5.0),
    pts,
    y,
    pin,
    /** arc-length range of the free span (used to place piers and trusses) */
    span: [s0, s1],
    dir: [dx, dz],
    origin: [ax, az],
    river: b.river,
  };
}

/**
 * Last resort for a bridge whose straight-on approach cannot exist.
 *
 * The Fort Duquesne Bridge lands on The Point, a wedge of land 250 m wide with
 * the Allegheny on one side and the Monongahela on the other, so its approach
 * runs straight out of one river and into the other and `clipToLand` — quite
 * correctly — throws the whole thing away. The real bridge solves this with a
 * curved ramp along the shore, and so does this: find the nearest vertex of any
 * corridor that is NOT part of a bridge, and lay a short link to it that stays
 * on dry land. A bridge nobody can reach is not a chokepoint, it is scenery.
 */
function linkBridgeTips(corridors, specs, terrain) {
  const out = [];
  // A short shore link may run closer to the water than a quay would; it only
  // has to be on land. The Point is a 250 m wedge with a river down each side
  // and two bridges landing on it, so 9 m of setback rejected every path.
  const dry = (x, z) => Math.abs(x) < MAP_EDGE && Math.abs(z) < MAP_EDGE && terrain.waterDist(x, z) > 3;
  for (const spec of specs) {
    const tips = [spec.pts[0], spec.pts[spec.pts.length - 1]];
    for (const tip of tips) {
      // Anything non-bridge already close enough to weld or intersect?
      let near = Infinity;
      let best = null;
      let bestD = Infinity;
      for (const c of [...corridors, ...out]) {
        if (c.bridge) continue;
        for (const p of c.pts) {
          const d = Math.hypot(p[0] - tip[0], p[1] - tip[1]);
          if (d < near) near = d;
          if (d > 14 && d < bestD && d < 420) {
            bestD = d;
            best = p;
          }
        }
      }
      // The old threshold was 46 m, which is not "already connected" — it is
      // "there is a road two houses away that this ramp never touches". The
      // planar solver only makes a junction where two corridors CROSS or weld
      // (7 m), so anything further than a weld radius needs a real link laid.
      if (near < 12 || !best) continue;
      // A straight link, nudged sideways at the middle so it reads as a road
      // rather than a ruler, sampled to check it never crosses water.
      const mx = (tip[0] + best[0]) * 0.5;
      const mz = (tip[1] + best[1]) * 0.5;
      const nx = -(best[1] - tip[1]) / bestD;
      const nz = (best[0] - tip[0]) / bestD;
      let chosen = null;
      for (const bow of [0, 0.16, -0.16, 0.34, -0.34, 0.55, -0.55, 0.8, -0.8]) {
        const cx = mx + nx * bestD * bow;
        const cz = mz + nz * bestD * bow;
        const pts = [];
        let ok = true;
        for (let k = 0; k <= 10; k++) {
          const t = k / 10;
          const u = 1 - t;
          const x = u * u * tip[0] + 2 * u * t * cx + t * t * best[0];
          const z = u * u * tip[1] + 2 * u * t * cz + t * t * best[1];
          if (!dry(x, z)) {
            ok = false;
            break;
          }
          pts.push([x, z]);
        }
        if (ok && pts.length > 2) {
          chosen = pts;
          break;
        }
      }
      if (chosen) {
        out.push(corridor(chosen, 'arterial', 2, { id: `${spec.id}_link`, name: `${spec.name} Approach`, pri: PRI.approach }));
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------- switchbacks -- */

/** The hill climbs. Nothing else gets you up a 40-degree bluff. */
function switchbacks(terrain) {
  const out = [];

  // --- Mt. Washington: three climbs off the Mon quay ---------------------
  const climbs = [
    { at: 0.30, legs: 5, len: 210, id: 'sycamore', name: 'Sycamore Street' },
    { at: 0.56, legs: 5, len: 190, id: 'shiloh', name: 'Shiloh Street' },
    { at: 0.80, legs: 4, len: 170, id: 'bailey', name: 'Bailey Avenue' },
  ];
  /**
   * A switchback is a shape, not a route, so these were pushed straight into
   * the corridor list without `clipToLand` — and the Troy Hill climb's first
   * traverse runs 60 m out into the Allegheny. `rasteriseRoads` then dutifully
   * stamped the road's height over the channel and raised 100 m of river bed to
   * +3 m, which is an island in the middle of a river with a street on it.
   * Every other corridor in this file is clipped; these are now too.
   */
  const push = (path, id, name) => {
    for (const run of clipToLand(resample(path, 26, 0), terrain, 12, 0.72)) {
      out.push(corridor(run, 'street', 2, { id, name, pri: PRI.hill }));
    }
  };
  for (const c of climbs) {
    const p = alongPath(BLUFF.line, c.at);
    push(zigzag(p.x, p.z, p.tx, p.tz, -p.nx, -p.nz, c.legs, c.len, 250, terrain), c.id, c.name);
  }

  // --- Troy Hill and the West End ---------------------------------------
  const hillClimbs = [
    { x: 470, z: -790, dirx: 0.94, dirz: -0.34, legs: 5, len: 190, id: 'rialto' },
    { x: -930, z: -300, dirx: -0.2, dirz: 0.98, legs: 4, len: 180, id: 'steuben' },
    { x: -1120, z: 96, dirx: 0.1, dirz: 0.99, legs: 4, len: 200, id: 'greentree' },
    { x: 1010, z: -300, dirx: 0.24, dirz: -0.97, legs: 3, len: 180, id: 'hazelclimb' },
  ];
  for (const c of hillClimbs) {
    const tx = -c.dirz;
    const tz = c.dirx;
    push(zigzag(c.x, c.z, tx, tz, c.dirx, c.dirz, c.legs, c.len, 190, terrain), c.id, null);
  }
  return out;
}

/** Point, tangent and left normal at parameter `t` of a polyline. */
function alongPath(pts, t) {
  const total = pathLength(pts);
  let want = total * t;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (want <= l || i === pts.length - 2) {
      const u = clamp01(want / l);
      const tx = (b[0] - a[0]) / l;
      const tz = (b[1] - a[1]) / l;
      return { x: a[0] + (b[0] - a[0]) * u, z: a[1] + (b[1] - a[1]) * u, tx, tz, nx: tz, nz: -tx };
    }
    want -= l;
  }
  return { x: pts[0][0], z: pts[0][1], tx: 1, tz: 0, nx: 0, nz: -1 };
}

/**
 * A switchback road: `legs` traverses along (tx,tz), each advancing `step`
 * metres up the fall line (ux,uz), joined by hairpins.
 */
function zigzag(x, z, tx, tz, ux, uz, legs, legLen, totalClimb, terrain) {
  const step = totalClimb / legs;
  const pts = [[x - ux * 40, z - uz * 40], [x, z]];
  let sign = 1;
  let cx = x;
  let cz = z;
  for (let i = 0; i < legs; i++) {
    // Traverse: mostly across the slope, drifting inland as it climbs.
    const segs = 4;
    for (let k = 1; k <= segs; k++) {
      const t = k / segs;
      const px = cx + tx * sign * legLen * t + ux * step * t * 0.62;
      const pz = cz + tz * sign * legLen * t + uz * step * t * 0.62;
      pts.push([px, pz]);
    }
    cx = cx + tx * sign * legLen + ux * step * 0.62;
    cz = cz + tz * sign * legLen + uz * step * 0.62;
    // Hairpin: swing inland before reversing.
    cx += ux * step * 0.38;
    cz += uz * step * 0.38;
    pts.push([cx + tx * sign * 20, cz + tz * sign * 20]);
    pts.push([cx, cz]);
    sign = -sign;
  }
  pts.push([cx + ux * 70, cz + uz * 70]);
  return pts;
}

/* ----------------------------------------------------------- connectors -- */

/** Long cross-town routes: these are what make the map drivable end to end. */
function connectors(terrain) {
  const paths = [
    { id: 'liberty', name: 'Liberty Avenue', kind: 'arterial', lanes: 4, pts: [[-430, 60], [-250, 20], [-40, -70], [200, -190], [430, -320], [640, -470], [830, -640]] },
    { id: 'fifth', name: 'Fifth Avenue', kind: 'arterial', lanes: 4, pts: [[-410, 150], [-220, 110], [10, 30], [250, -80], [500, -190], [760, -300], [1010, -330]] },
    { id: 'grant', name: 'Grant Street', kind: 'arterial', lanes: 4, pts: [[-330, -80], [-280, 40], [-240, 160], [-215, 275]] },
    { id: 'smallman', name: 'Smallman Street', kind: 'street', lanes: 2, pts: [[-140, -140], [110, -260], [360, -390], [590, -520]] },
    { id: 'carson', name: 'Carson Street', kind: 'arterial', lanes: 4, pts: [[-420, 430], [-190, 520], [60, 610], [330, 700], [590, 790], [820, 880]] },
    { id: 'brighton', name: 'Brighton Road', kind: 'arterial', lanes: 4, pts: [[-980, -380], [-820, -450], [-620, -520], [-400, -560], [-180, -600], [60, -680], [300, -790]] },
    { id: 'butler', name: 'Butler Street', kind: 'arterial', lanes: 4, pts: [[330, -300], [480, -400], [640, -510], [800, -620], [960, -760]] },
    { id: 'sawmill', name: 'Saw Mill Run', kind: 'arterial', lanes: 4, pts: [[-1140, 220], [-940, 340], [-720, 470], [-500, 600], [-260, 700], [0, 770]] },
    { id: 'streets_run', name: 'Steel Row Approach', kind: 'arterial', lanes: 4, pts: [[500, 300], [660, 340], [820, 400], [960, 500], [1060, 640]] },
    { id: 'troyroad', name: 'Troy Hill Road', kind: 'arterial', lanes: 2, pts: [[260, -880], [380, -960], [520, -1010], [680, -1030], [820, -990]] },
  ];
  const out = [];
  for (const p of paths) {
    const runs = clipToLand(resample(p.pts, 42, 6, p.id.length * 1.7), terrain, 14, 0.5);
    for (let i = 0; i < runs.length; i++) {
      out.push(corridor(runs[i], p.kind, p.lanes, { id: `${p.id}_${i}`, name: p.name, pri: PRI.connector }));
    }
  }
  return out;
}

/* ----------------------------------------------------------------- rail -- */

/** Mill trackage. Drawn as rail, never used by traffic. */
function railLines(terrain) {
  const paths = [
    { id: 'rail_south', pts: [[-330, 500], [-60, 590], [230, 686], [520, 782], [800, 878], [1040, 950]] },
    { id: 'rail_mill', pts: [[440, 250], [620, 292], [800, 352], [950, 448], [1070, 570]] },
    { id: 'rail_strip', pts: [[-160, -80], [90, -196], [340, -318], [580, -442], [800, -570]] },
  ];
  const out = [];
  for (const p of paths) {
    const runs = clipToLand(resample(p.pts, 40, 4, 2.2), terrain, 18, 0.28);
    for (let i = 0; i < runs.length; i++) {
      out.push(corridor(runs[i], 'alley', 1, { id: `${p.id}_${i}`, rail: true, pri: PRI.alley }));
    }
  }
  return out;
}

/* ------------------------------------------------------- district grids -- */

/** Per-district street grid parameters. */
const GRID_STYLE = {
  downtown: { a: 82, b: 112, alleys: 0.42, wander: 3.5, kind: 'street', lanes: 2 },
  grid: { a: 98, b: 126, alleys: 0.3, wander: 7, kind: 'street', lanes: 2 },
  hill: { a: 104, b: 138, alleys: 0.2, wander: 14, kind: 'street', lanes: 2 },
  mill: { a: 156, b: 208, alleys: 0.15, wander: 9, kind: 'street', lanes: 2 },
  park: { a: 176, b: 232, alleys: 0, wander: 17, kind: 'street', lanes: 2 },
};

/** Per-district grid rotations, so no two neighbourhoods share an angle. */
const DISTRICT_YAW = {
  point: 0.18,
  downtown: -0.52,
  strip: -0.64,
  lawren: -0.62,
  northsh: -0.38,
  troy: 0.22,
  southside: 0.34,
  mtwash: 0.28,
  steelrow: 0.42,
  westend: -0.14,
  northside: -0.26,
  hazel: -0.86,
};

function gridDistrict(d, terrain, rng, corridors, blocks) {
  const st = GRID_STYLE[d.grid] ?? GRID_STYLE.grid;
  const yaw = DISTRICT_YAW[d.id] ?? 0;
  const ca = Math.cos(yaw);
  const sa = Math.sin(yaw);
  const R = d.r * 1.12;
  const na = Math.ceil((R * 2) / st.a);
  const nb = Math.ceil((R * 2) / st.b);

  const L2W = (u, v) => [d.x + u * ca - v * sa, d.z + u * sa + v * ca];

  // Jittered rail positions in the district's local frame.
  const us = [];
  for (let i = 0; i <= na; i++) us.push(-R + i * st.a + rng.range(-st.a * 0.17, st.a * 0.17));
  const vs = [];
  for (let j = 0; j <= nb; j++) vs.push(-R + j * st.b + rng.range(-st.b * 0.17, st.b * 0.17));

  // Which cross-block rows get a service alley down the middle.
  const alley = [];
  for (let j = 0; j < vs.length - 1; j++) {
    alley.push(vs[j + 1] - vs[j] > 78 && rng.float() < st.alleys);
  }

  // The streets themselves bend, so a block cut on the straight rail would
  // overlap the carriageway; the inset carries the bend amplitude.
  const hw = corridorHalfWidth(st.kind, st.lanes) + st.wander * 0.55;
  const ahw = corridorHalfWidth('alley', 2) + 2;

  // Streets along v (constant u) and along u (constant v).
  for (let i = 0; i < us.length; i++) {
    const pts = [];
    for (let k = 0; k <= 14; k++) {
      const v = lerp(-R, R, k / 14);
      pts.push(L2W(us[i] + Math.sin(v * 0.0042 + i * 1.7) * st.wander, v));
    }
    for (const run of clipToLand(resample(pts, 30, 0), terrain, 14, 0.62)) {
      corridors.push(corridor(run, st.kind, st.lanes, { district: d.id, id: `${d.id}_u${i}`, pri: PRI.grid }));
    }
  }
  for (let j = 0; j < vs.length; j++) {
    const pts = [];
    for (let k = 0; k <= 14; k++) {
      const u = lerp(-R, R, k / 14);
      pts.push(L2W(u, vs[j] + Math.sin(u * 0.0038 + j * 2.3) * st.wander));
    }
    for (const run of clipToLand(resample(pts, 30, 0), terrain, 14, 0.62)) {
      corridors.push(corridor(run, st.kind, st.lanes, { district: d.id, id: `${d.id}_v${j}`, pri: PRI.grid }));
    }
  }
  for (let j = 0; j < alley.length; j++) {
    if (!alley[j]) continue;
    const v = (vs[j] + vs[j + 1]) * 0.5;
    const pts = [];
    for (let k = 0; k <= 12; k++) {
      const u = lerp(-R, R, k / 12);
      pts.push(L2W(u, v + Math.sin(u * 0.004 + j) * 2.5));
    }
    for (const run of clipToLand(resample(pts, 38, 0), terrain, 16, 0.5)) {
      corridors.push(corridor(run, 'alley', 2, { district: d.id, id: `${d.id}_a${j}`, pri: PRI.alley }));
    }
  }

  // Blocks: the quads between adjacent rails, inset by the corridor width and
  // split again where a service alley runs through the middle of the row.
  for (let i = 0; i < us.length - 1; i++) {
    const u0 = us[i] + hw;
    const u1 = us[i + 1] - hw;
    if (u1 - u0 < 20) continue;
    for (let j = 0; j < vs.length - 1; j++) {
      const rows = alley[j]
        ? [
            [vs[j] + hw, (vs[j] + vs[j + 1]) * 0.5 - ahw],
            [(vs[j] + vs[j + 1]) * 0.5 + ahw, vs[j + 1] - hw],
          ]
        : [[vs[j] + hw, vs[j + 1] - hw]];
      for (const [v0, v1] of rows) {
        if (v1 - v0 < 18) continue;
        const cu = (u0 + u1) * 0.5;
        const cv = (v0 + v1) * 0.5;
        if (Math.hypot(cu, cv) > d.r * 1.04) continue;
        const bl = blockFromQuad(
          L2W(u0, v0), L2W(u1, v0), L2W(u1, v1), L2W(u0, v1),
          d.id, d.grid
        );
        bl.yaw = yaw;
        bl.w = u1 - u0;
        bl.d = v1 - v0;
        bl.alley = alley[j];
        blocks.push(bl);
      }
    }
  }
}

/* ------------------------------------------------------ planar graph ----- */

const WELD = 7;

function buildGraph(corridors, terrain) {
  const graph = new RoadGraph();

  // --- segment soup with a spatial hash --------------------------------
  const CELL = 72;
  const cells = new Map();
  const segs = [];
  for (let ci = 0; ci < corridors.length; ci++) {
    const c = corridors[ci];
    for (let i = 0; i < c.pts.length - 1; i++) {
      const a = c.pts[i];
      const b = c.pts[i + 1];
      const s = { ci, i, ax: a[0], az: a[1], bx: b[0], bz: b[1], splits: null };
      const id = segs.length;
      segs.push(s);
      const x0 = Math.floor(Math.min(s.ax, s.bx) / CELL);
      const x1 = Math.floor(Math.max(s.ax, s.bx) / CELL);
      const z0 = Math.floor(Math.min(s.az, s.bz) / CELL);
      const z1 = Math.floor(Math.max(s.az, s.bz) / CELL);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const k = cx * 73856093 ^ cz * 19349663;
          let list = cells.get(k);
          if (!list) cells.set(k, (list = []));
          list.push(id);
        }
      }
    }
  }

  // --- intersections ----------------------------------------------------
  // A pair that spans two cells is tested twice; the duplicate split parameter
  // welds onto the same node and the zero-length edge is dropped, which is far
  // cheaper than carrying a million-entry "seen" set.
  for (const list of cells.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const ia = list[a];
        const ib = list[b];
        const sa = segs[ia];
        const sb = segs[ib];
        if (sa.ci === sb.ci) continue;
        const ca = corridors[sa.ci];
        const cb = corridors[sb.ci];
        // A bridge deck flies over everything except its own approaches.
        if ((ca.bridge || cb.bridge) && ca.bridgeId !== cb.bridgeId) {
          if (!approachOverlap(ca, cb, sa, sb)) continue;
        }
        const hit = intersect(sa, sb);
        if (!hit) continue;
        (sa.splits ?? (sa.splits = [])).push(hit.ta);
        (sb.splits ?? (sb.splits = [])).push(hit.tb);
      }
    }
  }

  // --- node welding grid ------------------------------------------------
  const ncells = new Map();
  /**
   * WELDING IS 3D WHERE A HEIGHT IS PINNED.
   *
   * A bridge deck passes directly over a riverfront quay — that is what a
   * bridge is — and the plan distance between the deck's centreline and the
   * quay's can easily be under the 7 m weld radius. Welding them made ONE node
   * at two different elevations, and because the bridge is pinned it won the
   * argument: the quay node was dragged 13 m into the air and every street
   * edge hanging off it became a ramp to nowhere. That is a 107% "bridge"
   * grade at the Fort Pitt approach, an 8 m step in the junction pad beside it,
   * and — seen from across the river — a deck that appears to float in
   * disconnected pieces, which is exactly what a critic panel reported of the
   * skyline. Two roads at different levels are two roads.
   */
  const nodeAt = (x, z, y, pinned) => {
    const gx = Math.floor(x / WELD);
    const gz = Math.floor(z / WELD);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = ncells.get((gx + dx) * 73856093 ^ (gz + dz) * 19349663);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const n = graph.nodes[list[i]];
          if ((n.x - x) ** 2 + (n.z - z) ** 2 < WELD * WELD) {
            if ((pinned || n.pinned) && Math.abs(n.y - y) > 4) continue;
            if (pinned && !n.pinned) {
              n.y = y;
              n.pinned = true;
            }
            return n;
          }
        }
      }
    }
    const n = graph.addNode(x, z, y);
    n.pinned = !!pinned;
    const k = gx * 73856093 ^ gz * 19349663;
    let list = ncells.get(k);
    if (!list) ncells.set(k, (list = []));
    list.push(n.id);
    return n;
  };

  // --- rebuild each corridor as a node chain ----------------------------
  //
  // A node is only created where the road actually does something: an
  // intersection, an end, a real bend, or every ~70 m so a long straight still
  // has somewhere to hang a junction. Keeping every resample vertex made the
  // median edge 18 m long — shorter than the two junction pads at its ends —
  // so `roadmesh` had nothing left to draw between them and the city rendered
  // as a field of disconnected intersections.
  let si = 0;
  for (let ci = 0; ci < corridors.length; ci++) {
    const c = corridors[ci];
    const raw = [];
    for (let i = 0; i < c.pts.length - 1; i++) {
      const s = segs[si++];
      const ax = s.ax;
      const az = s.az;
      const bx = s.bx;
      const bz = s.bz;
      const ya = c.y ? c.y[i] : null;
      const yb = c.y ? c.y[i + 1] : null;
      // A split lands between two vertices, so it is only pinned when both are.
      const pa = c.pin ? c.pin[i] : c.y !== null;
      const pb = c.pin ? c.pin[i + 1] : c.y !== null;
      const ts = [[0, i === 0]];
      if (s.splits) {
        s.splits.sort((p, q) => p - q);
        for (const t of s.splits) if (t > 0.02 && t < 0.98) ts.push([t, true]);
      }
      for (const [t, forced] of ts) {
        raw.push({
          x: ax + (bx - ax) * t,
          z: az + (bz - az) * t,
          y: ya !== null ? lerp(ya, yb, t) : null,
          pin: t <= 0 ? pa : pa && pb,
          forced,
        });
      }
    }
    const last = c.pts[c.pts.length - 1];
    raw.push({
      x: last[0],
      z: last[1],
      y: c.y ? c.y[c.y.length - 1] : null,
      pin: c.pin ? c.pin[c.pin.length - 1] : c.y !== null,
      forced: true,
    });

    const keep = simplify(raw, c.y !== null ? 0.45 : 1.6, 72);
    const chain = [];
    for (const p of keep) {
      chain.push(nodeAt(p.x, p.z, p.y !== null ? p.y : terrain.heightAt(p.x, p.z), !!p.pin));
    }

    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      if (a === b) continue;
      // Skip a duplicate edge between the same pair — but ONLY one of the same
      // kind. A rail edge is not a duplicate of a coincident ROAD edge: a
      // trolley cannot run on the arterial that shares its ground, so dropping
      // it here severs the line. Mill trackage runs within WELD (7 m) of the
      // road grid, so its chain nodes weld onto road junctions; where two
      // consecutive welded nodes already carried a road edge, this test used to
      // eat the rail edge and dead-end the track mid-intersection (the
      // Lawrenceville break: `rail_strip` fell into 7 disconnected pieces, one
      // dangling end at every crossing). Keying the dup on `rail`-ness keeps the
      // track continuous through the junction while still collapsing genuine
      // road-on-road and rail-on-rail doubles.
      let dup = false;
      for (let k = 0; k < a.links.length; k++) {
        const e = graph.edges[a.links[k]];
        if ((e.a === b.id || e.b === b.id) && !!e.rail === !!c.rail) dup = true;
      }
      if (dup) continue;
      graph.addEdge(a.id, b.id, {
        kind: c.kind,
        lanes: c.lanes,
        name: c.name,
        oneway: c.oneway,
        bridge: c.bridge,
        bridgeId: c.bridgeId,
        corridor: c.id,
        district: c.district,
        rail: c.rail,
      });
    }
  }

  // --- weld landmark feeder stubs onto the ring (or each other) ---------
  // Every cut street was pushed LM_SPUR past the reserve isoline so that
  // `intersect()` would split the ring there and join it. That only fires where
  // a ring SEGMENT actually sits at the cut point; where the nearest surviving
  // ring segment is metres along the loop — or the ring is clipped away by the
  // river (the Point) or a cliff (the Incline) — the stub lands in the gap and
  // stays a degree-1 dead end. This closes those gaps with a short, flat,
  // dry-ground link, which is exactly the taper a real street makes into the
  // road round a plaza. See `drivesweep.mjs`'s ring-orphan assertion.
  weldLandmarkDeadEnds(graph, terrain);

  // --- height relaxation ------------------------------------------------
  relaxHeights(graph, 3);
  // Steel City is steep. Steel City is not vertical: 32% is Canton Avenue,
  // which is the steepest street in the United States.
  limitGrades(graph, 0.30, 160);

  graph.finalise();

  // Prune stranded fragments: anything not reachable from the largest island.
  pruneIslands(graph);

  return graph;
}

/**
 * How far a stub is allowed to reach for the ring or its neighbour. A grid
 * street's nodes are up to 72 m apart, so a stub that missed the ring can be a
 * fair way from the nearest surviving ring node; but a link longer than this
 * stops being a taper into a plaza and starts being a road of its own, laid
 * blind across whatever is between the two ends. Measured: 42 m catches every
 * stub at the Point, the Steel Bowl, the Tower and the Market and the reachable
 * ones on the Incline, and the ones it does not catch are up a cliff where a
 * link would be an unclimbable step, not a road.
 */
const RING_WELD_GAP = 42;

/**
 * Close the gaps the ring left open: weld every degree-1 stub near a landmark
 * onto the nearest node it can safely reach.
 *
 * A stub is a cut feeder street that landed in a gap in the landmark ring — the
 * ring segment it was aimed at was clipped by water or slope, or the nearest
 * one is metres away along the loop. The intended target is the ring; where the
 * ring vanished entirely (the Point sits in the Allegheny, so its ring clips to
 * nothing) the target is the OTHER feeder stubs meeting at the same plaza, which
 * is the same junction a real street network makes there.
 *
 * A link is laid only when it is a road a car can take: dry ground the whole
 * way, clear of the reserved site, a grade under the city limit, and its own
 * surface within a low tolerance of the terrain it crosses so it neither floats
 * nor buries — i.e. it will not trade an orphan for a hole or a step in the
 * `drivesweep` sense. Run before `relaxHeights`/`pruneIslands`, so a welded stub
 * rides the height solve with everything else and survives the island prune.
 */
function weldLandmarkDeadEnds(graph, terrain) {
  if (reserveDisabled() || ringWeldDisabled()) return;
  const deg = (n) => n.links.reduce((s, i) => s + (graph.edges[i].rail ? 0 : 1), 0);
  const onRing = (n) =>
    n.links.some((i) => String(graph.edges[i].corridor ?? '').startsWith('ring_'));
  const neighbourOf = (n) => {
    const e = graph.edges[n.links.find((i) => !graph.edges[i].rail)];
    return e ? (e.a === n.id ? e.b : e.a) : -1;
  };
  // A candidate link is only laid if every sample along it is dry, clear of the
  // site, and near enough to the straight height interpolation to sit flat.
  const linkOk = (a, b) => {
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    if (dist < 0.5 || dist > RING_WELD_GAP) return false;
    if (Math.abs(b.y - a.y) / dist > 0.20) return false;
    const steps = Math.max(3, Math.ceil(dist / 4));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      if (terrain.waterDist(x, z) <= 8) return false;
      if (nearestSiteDist(x, z) <= 8) return false;
      const yLin = a.y + (b.y - a.y) * t;
      if (Math.abs(terrain.heightAt(x, z) - yLin) > 1.6) return false;
    }
    return true;
  };
  const hasEdge = (a, b) =>
    a.links.some((i) => {
      const e = graph.edges[i];
      return e.a === b.id || e.b === b.id;
    });

  let welded = 0;
  for (const lm of LANDMARKS) {
    const s = lm.site;
    if (!s) continue;
    const cx = lm.x + (s.ox ?? 0);
    const cz = lm.z + (s.oz ?? 0);
    const reach = (s.r ?? 0) + (s.hx ?? 0) + (s.hz ?? 0) + 24 + 14;
    // Nodes near this site, split into the stubs that need help and the targets
    // that can receive them (the ring, and any through node — never a rail
    // node, never a stub's own single neighbour).
    const near = [];
    for (const nd of graph.nodes) {
      if (Math.hypot(nd.x - cx, nd.z - cz) > reach) continue;
      near.push(nd);
    }
    for (const d of near) {
      // Re-read the degree each pass: an earlier weld may already have rescued
      // this node, and a stub welded to it stops being a valid target as a stub.
      if (deg(d) !== 1 || onRing(d)) continue;
      const skip = neighbourOf(d);
      let best = null;
      let bestScore = Infinity;
      for (const t of near) {
        if (t === d || t.id === skip) continue;
        if (hasEdge(d, t)) continue;
        const dist = Math.hypot(t.x - d.x, t.z - d.z);
        if (dist > RING_WELD_GAP) continue;
        // Prefer the ring, then a through junction, then another stub — and
        // among equals, the nearest. The class bonus is larger than any gap so
        // a ring node 40 m off still beats a stub 5 m off. Within a class, bias
        // toward a LOW-degree target: welding onto a degree-2 ring bend makes a
        // T, welding onto an already-busy crossing makes a 4+ node, and the
        // re-entrant notch a 4+ crossing leaves is exactly the junction-pad hole
        // `drivesweep` counts. Keep the new junctions as simple as the geometry
        // allows so the weld does not trade an orphan for a hole.
        const cls = onRing(t) ? 0 : deg(t) >= 2 ? 100 : 200;
        const score = cls + dist + deg(t) * 4;
        if (score < bestScore && linkOk(d, t)) {
          bestScore = score;
          best = t;
        }
      }
      if (!best) continue;
      graph.addEdge(d.id, best.id, {
        kind: 'street',
        lanes: 2,
        corridor: `${lm.id}_link`,
        name: `${lm.name} Approach`,
      });
      welded++;
    }
  }
  if (welded) console.log(`[world] welded ${welded} landmark feeder stub(s) onto the ring`);
}

/**
 * Drop vertices that do not change the road's shape. `forced` points (ends,
 * intersections) always survive; the rest go if they lie within `tol` metres of
 * the chord and the run since the last kept point is under `maxRun`.
 *
 * THE TEST HAS TO INCLUDE HEIGHT. A bridge approach is dead straight in plan —
 * its entire shape is vertical — so a purely horizontal deviation test scored
 * every ramp sample at zero and kept one point per `maxRun` metres, collapsing
 * a graded climb into two chords and turning the easing curve into a step. The
 * vertical tolerance is tighter than the horizontal one because a 30 cm bump
 * you cannot see in plan is a bump you feel through the suspension.
 */
function simplify(pts, tol, maxRun, ytol = 0.35) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  let anchor = pts[0];
  let run = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    run += Math.hypot(p.x - anchor.x, p.z - anchor.z);
    let keep = p.forced || run > maxRun;
    if (!keep) {
      segDist2(p.x, p.z, anchor.x, anchor.z, q.x, q.z, _seg);
      keep = Math.sqrt(_seg.d2) > tol;
    }
    if (!keep && anchor.y !== null && p.y !== null && q.y !== null) {
      // Height of the chord anchor->q at p's arc position.
      const la = Math.hypot(q.x - anchor.x, q.z - anchor.z);
      const lp = Math.hypot(p.x - anchor.x, p.z - anchor.z);
      const t = la > 1e-6 ? clamp01(lp / la) : 0;
      keep = Math.abs(p.y - lerp(anchor.y, q.y, t)) > ytol;
    }
    if (keep) {
      out.push(p);
      anchor = p;
      run = 0;
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Cap the grade of every unpinned edge.
 *
 * Steel City is Pittsburgh, so steep is the point — Canton Avenue is a real 37%
 * street. A NINETY-TWO percent street is not steep, it is a wall with lane
 * paint on it, and the router will happily send police up it. The generator
 * produced 3 km of them, because a grid rail laid across the Mt. Washington
 * face follows the terrain wherever it goes.
 *
 * Iterative relaxation: any edge over `maxGrade` pulls its two ends toward each
 * other's height by half the excess each, pinned nodes never move, and the
 * whole thing converges in a handful of passes because each edge only ever
 * reduces its own error. `rasteriseRoads` runs afterwards and brings the ground
 * up to whatever this settles on.
 */
function limitGrades(graph, maxGrade, passes) {
  const nodes = graph.nodes;
  for (let p = 0; p < passes; p++) {
    let worst = 0;
    // Gauss-Seidel: apply each correction immediately so it propagates along a
    // chain of steps within one pass. Jacobi averaging stalls on a switchback,
    // where every node on the climb is over the limit against both neighbours.
    for (const e of graph.edges) {
      const na = nodes[e.a];
      const nb = nodes[e.b];
      const d = nb.y - na.y;
      const over = Math.abs(d) - maxGrade * e.len;
      if (over <= 0) continue;
      if (over > worst) worst = over;
      const s = Math.sign(d) * over;
      const ma = na.pinned ? 0 : 1;
      const mb = nb.pinned ? 0 : 1;
      if (ma + mb === 0) continue;
      na.y += (s * ma) / (ma + mb);
      nb.y -= (s * mb) / (ma + mb);
    }
    if (worst < 0.02) break;
  }
}

function approachOverlap(ca, cb, sa, sb) {
  // Allow a bridge's ramp ends (first/last two segments) to meet the network.
  const endA = !ca.bridge || sa.i < 3 || sa.i > ca.pts.length - 5;
  const endB = !cb.bridge || sb.i < 3 || sb.i > cb.pts.length - 5;
  return endA && endB;
}

function intersect(sa, sb) {
  const r_x = sa.bx - sa.ax;
  const r_z = sa.bz - sa.az;
  const s_x = sb.bx - sb.ax;
  const s_z = sb.bz - sb.az;
  const den = r_x * s_z - r_z * s_x;
  if (Math.abs(den) < 1e-9) return null;
  const qpx = sb.ax - sa.ax;
  const qpz = sb.az - sa.az;
  const ta = (qpx * s_z - qpz * s_x) / den;
  const tb = (qpx * r_z - qpz * r_x) / den;
  if (ta < 0 || ta > 1 || tb < 0 || tb > 1) return null;
  return { ta, tb };
}

/**
 * Smooth node heights along the graph so a street does not chase every ripple
 * in the terrain, while pinned bridge decks stay exactly where they were put.
 */
function relaxHeights(graph, passes) {
  const nodes = graph.nodes;
  const acc = new Float32Array(nodes.length);
  const wsum = new Float32Array(nodes.length);
  for (let p = 0; p < passes; p++) {
    acc.fill(0);
    wsum.fill(0);
    for (const e of graph.edges) {
      const w = 1 / Math.max(6, e.len);
      acc[e.a] += nodes[e.b].y * w;
      wsum[e.a] += w;
      acc[e.b] += nodes[e.a].y * w;
      wsum[e.b] += w;
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.pinned || wsum[i] === 0) continue;
      n.y = n.y * 0.68 + (acc[i] / wsum[i]) * 0.32;
    }
  }
}

function pruneIslands(graph) {
  const n = graph.nodes.length;
  const comp = new Int32Array(n).fill(-1);
  const stack = [];
  let best = -1;
  let bestSize = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (comp[i] !== -1 || graph.nodes[i].links.length === 0) continue;
    let size = 0;
    stack.length = 0;
    stack.push(i);
    comp[i] = c;
    while (stack.length) {
      const cur = stack.pop();
      size++;
      const node = graph.nodes[cur];
      for (let k = 0; k < node.links.length; k++) {
        const e = graph.edges[node.links[k]];
        const o = e.a === cur ? e.b : e.a;
        if (comp[o] === -1) {
          comp[o] = c;
          stack.push(o);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = c;
    }
    c++;
  }
  graph.mainComponent = comp;
  graph.mainComponentId = best;
  let stranded = 0;
  for (let i = 0; i < n; i++) if (comp[i] !== -1 && comp[i] !== best) stranded++;
  graph.strandedNodes = stranded;
}

/* ------------------------------------------------- road height rasteriser */

/**
 * Stamp the road corridors into a grid matching the terrain bake, so the ground
 * can be pulled up (or cut down) to meet them. Bridge decks are excluded — the
 * terrain must stay at the bottom of the valley under a bridge.
 */
export function rasteriseRoads(graph, terrain) {
  const { n, cell, origin } = terrain;
  const field = new Float32Array(n * n).fill(Infinity);
  const wmax = new Float32Array(n * n);
  const BLEND = 20;

  for (const e of graph.edges) {
    const na = graph.nodes[e.a];
    const nb = graph.nodes[e.b];
    if (e.bridge) {
      const gy = Math.min(terrain.heightAt(na.x, na.z), terrain.heightAt(nb.x, nb.z));
      if (Math.max(na.y, nb.y) - gy > 5) continue; // free span: leave the valley
    }
    const half = corridorHalfWidth(e.kind, e.lanes) + (e.rail ? -1 : 4);
    const rad = half + BLEND;
    const x0 = Math.floor((Math.min(na.x, nb.x) - rad - origin) / cell);
    const x1 = Math.ceil((Math.max(na.x, nb.x) + rad - origin) / cell);
    const z0 = Math.floor((Math.min(na.z, nb.z) - rad - origin) / cell);
    const z1 = Math.ceil((Math.max(na.z, nb.z) + rad - origin) / cell);
    for (let j = Math.max(0, z0); j <= Math.min(n - 1, z1); j++) {
      const pz = origin + j * cell;
      const row = j * n;
      for (let i = Math.max(0, x0); i <= Math.min(n - 1, x1); i++) {
        const px = origin + i * cell;
        segDist2(px, pz, na.x, na.z, nb.x, nb.z, _seg);
        const d = Math.sqrt(_seg.d2);
        if (d > rad) continue;
        const w = d <= half ? 1 : 1 - smootherstep((d - half) / BLEND);
        if (w <= 0.002) continue;
        const k = row + i;
        // Nearest road wins; ties go to the LOWER of them. Not a weighted mean:
        // two roads crossing at different levels averaged to a height above one
        // of them and the ground then came up through the tarmac, which is the
        // one artefact you cannot miss from a car. And not a plain minimum
        // either — that let a road 20 m away drag the ground into a trench.
        const y = lerp(na.y, nb.y, _seg.t);
        if (w > wmax[k] + 1e-3) {
          wmax[k] = w;
          field[k] = y;
        } else if (w > wmax[k] - 1e-3 && y < field[k]) {
          field[k] = y;
        }
      }
    }
  }
  for (let i = 0; i < field.length; i++) if (field[i] === Infinity) field[i] = 0;
  return { field, weight: wmax };
}
