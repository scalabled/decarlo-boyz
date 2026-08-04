import * as THREE from 'three';
import { Accum } from './util.js';
import { vnoise } from './terrain.js';
import { ROAD_KIND, roadHalfWidth, SECTOR, clamp01, lerp, smoothstep } from './plan.js';

/**
 * WORLD — the road surface.
 *
 * In a driving game the tarmac fills most of the screen, so this is the file
 * that decides whether a frame looks like a game or like a diagram. Everything
 * the critics look for is generated here, per 512 m sector, amortised across
 * frames:
 *
 *   • cambered carriageway (a 2 % crown, sagged wheel ruts, settle noise)
 *   • kerbs as individual stones — each one settles a couple of centimetres,
 *     one in fourteen is chipped, all of them have a chamfered arris
 *   • pavements with slab joints, cross-fall, and grime banked against the kerb
 *   • lane paint that WEARS: every dash is thinned or erased by its own noise,
 *     and the erosion is cranked up in the last twelve metres before a junction
 *     where the wheels actually cross it
 *   • stop bars, zebra crossings, gully gratings, manhole covers
 *   • patched asphalt: darker cut-and-fill rectangles and pothole scabs
 *   • ballasted rail through the mill districts
 *
 * Junctions are real: every node gets a pad the connecting carriageways stop
 * short of, plus pavement corner fillets between them, so two roads meet in a
 * junction rather than in a pile of overlapping quads.
 */

/** Fine surface noise, ±1 cm class. */
function n1(x, z) {
  return vnoise(x, z) - 0.5;
}

/** Height of a kerb stone above the channel. Shared by mesh and collision. */
const KERB_H = 0.152;
/** Width of the kerb stone, face to back. */
const KERB_W = 0.33;
/**
 * How far the pavement's back edge is allowed to bulge past the junction pad
 * boundary before it is cut off. A dead end has one arm, so the "corner" sweeps
 * the whole 360 degrees and the analytic fillet radius runs to infinity behind
 * it; this is what turns that into a turning head instead of a disc the size of
 * a city block.
 */
const PAD_RMAX = 1.7;

/**
 * Height of the kerb IN THE COLLISION WORLD, which is not the height of the
 * kerb you can see.
 *
 * The stone stands 15 cm proud of the channel but the top 3 cm of it is the
 * chamfered arris, so the vertical face a tyre actually meets is 12 cm — and
 * that matters, because `dynamics` reads the wheel ray as a finite difference
 * and a step it cannot climb reads as several m/s of strut velocity.
 *
 * Measured, one simulated minute at the downtown site, everything else equal:
 *
 *   no kerb collider at all   33.7% of samples off the carriageway, 22.5% moving,
 *                             2.33% stopped against world geometry, 54 junction
 *                             crossings
 *   with the kerb             22.2%,  29.4% moving, 0.07% stopped against world
 *                             geometry, 108 junction crossings
 *
 * A kerb is not scenery. It is the thing that makes a lane a lane.
 */
const KERB_COL_H = KERB_H - 0.03;

/**
 * A dropped kerb at every arm of a real junction: the last `DROP_RUN` metres
 * before the carriageway mouth ease down to `DROP_MUL` of full height, which is
 * where the crossing meets the footway. It is deliberately a shallow drop
 * rather than a flush ramp — `physics` measured what a junction with no kerb at
 * all costs (see `KERB_COL_H`), so the lip has to survive.
 */
const DROP_RUN = 1.35;
const DROP_MUL = 0.4;

/**
 * THE SKIRT — what goes where a footway is suppressed, instead of NOTHING.
 *
 * `_edgeCollision` and `_node` both refuse to lay a footway where it would
 * stand in somebody else's lane or on somebody else's pavement, and that is
 * right: a raised footway collider lying across a carriageway is a kerb a car
 * meets in the middle of the road. What was wrong was the ALTERNATIVE. The
 * strip was simply not emitted, and the only collider left under it was the
 * terrain — which `netgen.rasteriseRoads` deliberately sinks 0.55 m below the
 * corridor, with the footway another 0.15 m above that.
 *
 * So every suppressed strip was a TRENCH 0.70 m deep and up to 3.7 m wide,
 * walled by the carriageway on one side and by the neighbouring corridor's
 * pavement on the other. Measured with `src/physics/walksweep.mjs` on the
 * downtown site before this change: 15 of 40 walkers stopped dead inside one,
 * 19 fell 0.5-1.6 m, and only 76.4% of commanded pavement was walkable. That
 * is floating sidewalks with holes between them that a walker gets stuck in,
 * exactly, and it is also a car reversing off a kerb into a slot it cannot
 * climb out of.
 *
 * The fix is not to emit the footway anyway — that reintroduces the kerb in
 * the lane. It is to emit a GRADED SKIRT over the same ground: the same three
 * columns, no kerb rise, descending from just under the carriageway edge to
 * the sunk ground. Two properties make it safe by construction:
 *
 *   at or below every surface   it starts `SKIRT_LIP` under our own road edge
 *                               and only descends, so it can never win a
 *                               downward query against a real carriageway,
 *                               footway or pad — no new lip for anything on
 *                               wheels, which is the whole reason the strip
 *                               was suppressed in the first place
 *   never a wall                the drop is spread over the footway's full
 *                               width, so the steepest skirt in the city is
 *                               about 8 degrees and a capsule walks out of it
 *
 * It is the same argument the `LAYER.CLIP` ground shell makes in
 * `src/world/index.js` — a sheet provably at or below real ground can only
 * ever ADD a floor — applied to the real-triangle layer.
 */
const SKIRT_LIP = 0.02;
/** Deepest the skirt may reach below the carriageway. Matches the road sink. */
const SKIRT_MAX = 0.6;

/** 0..1 easing of the kerb height `d` metres from a junction mouth. */
function kerbDrop(d, drop) {
  if (!drop || d >= DROP_RUN) return 1;
  return DROP_MUL + (1 - DROP_MUL) * smoothstep(Math.max(0, d) / DROP_RUN);
}

/* ---------------------------------------------------------------------------
 * POSITION-PURE SURFACE NOISE — why every one of these takes (x, z) and
 * nothing else.
 *
 * The junction fillet and the straight run that meets it are built by two
 * different routines walking two different parameters, and they have to agree
 * to the millimetre on the shared cross section or the joint tears open. Any
 * term derived from a ROW INDEX ("every other row dips 13 mm", "one stone in
 * fourteen is chipped") cannot agree, because the two routines do not share a
 * row index — and that is most of what made the pavement read as a pile of
 * loose slabs. Derive the variation from world position instead and the two
 * builders produce identical numbers at the same point by construction.
 * ------------------------------------------------------------------------- */

/** The carriageway's own settle wobble. Must match `_edge`'s `pt()` exactly. */
function roadWob(x, z) {
  return n1(x * 0.31, z * 0.31) * 0.016 + n1(x * 0.075, z * 0.075) * 0.036;
}

/** How far this kerb stone has settled into the channel, +-3 cm. */
function kerbSettle(x, z) {
  return n1(x * 0.7, z * 0.7) * 0.03;
}

/** One stone in fourteen has lost its corner. Quantised near the stone pitch. */
function kerbChipped(x, z) {
  const cx = Math.floor(x * 0.62) | 0;
  const cz = Math.floor(z * 0.62) | 0;
  return (((cx * 2654435761) ^ (cz * 2246822519)) >>> 0) % 14 === 0;
}

/** Slab settle across the footway, +-9 mm. */
function slabDip(x, z) {
  return n1(x * 0.55, z * 0.55) * 0.018;
}

/** Lateral wander of the kerb line, +-3.5 cm; tapered to nothing at a joint. */
function kerbBow(x, z) {
  return n1(x * 0.4 + 3, z * 0.4) * 0.035;
}

/**
 * A/B hatch for the junction footway, same shape as `netgen`'s `?nodedup=1`
 * and `physics`' `?nogroundproxy=1`: a fix you cannot un-apply is a fix you
 * cannot prove. `?paveold=1` in the browser, or `OW_PAVE_LEGACY=1` for the
 * headless harnesses, restores the radial fillet this file used to build — the
 * one that put a loose slab in the mouth of every junction in the city. It is
 * the negative control for `src/world/pavesweep.mjs` and is never reachable in
 * normal play.
 */
let _legacyPave = null;
function legacyPave() {
  if (_legacyPave !== null) return _legacyPave;
  _legacyPave = false;
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('paveold') === '1') {
      _legacyPave = true;
    }
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.OW_PAVE_LEGACY === '1') _legacyPave = true;
  } catch { /* no process */ }
  if (_legacyPave) console.warn('[world] LEGACY junction footway — radial fillet, pre-fix');
  return _legacyPave;
}

/**
 * A/B hatch for the junction-pad union — see the long note on `_place`.
 * `?nopadfix=1`, or `OW_NO_PAD_FIX=1`, puts back the `min` that made the pad
 * the INTERSECTION of the arms it joins instead of their union, which left a
 * notch in the approach to every junction in the city. It is the negative
 * control for `src/world/drivesweep.mjs` and is never reachable in play.
 */
/**
 * A/B hatch for the kerb-containment fix — see `_kerbBlocked`. `?nokerbfix=1`,
 * or `OW_NO_KERB_FIX=1`, goes back to cancelling the kerb whenever anything
 * touches the back of the footway behind it. It is the negative control for
 * `drivesweep`'s containment assertion.
 */
let _legacyKerb = null;
function legacyKerb() {
  if (_legacyKerb !== null) return _legacyKerb;
  _legacyKerb = false;
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('nokerbfix') === '1') {
      _legacyKerb = true;
    }
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.OW_NO_KERB_FIX === '1') _legacyKerb = true;
  } catch { /* no process */ }
  if (_legacyKerb) console.warn('[world] KERB CONTAINMENT FIX DISABLED — the kerb yields to the footway again');
  return _legacyKerb;
}

let _legacyPad = null;
function legacyPad() {
  if (_legacyPad !== null) return _legacyPad;
  _legacyPad = false;
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('nopadfix') === '1') {
      _legacyPad = true;
    }
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.OW_NO_PAD_FIX === '1') _legacyPad = true;
  } catch { /* no process */ }
  if (_legacyPad) console.warn('[world] JUNCTION PAD FIX DISABLED — pad is the intersection of its arms again');
  return _legacyPad;
}

/**
 * A/B hatch for the junction DRIVE-SURFACE coverage fix — the negative control
 * for the hole assertion in `src/world/drivesweep.mjs`. `?nocapfix=1`, or
 * `OW_NO_CAP_FIX=1` headless, reverts BOTH halves of that fix, which target the
 * same defect (a wheel dropping into a junction pad):
 *
 *   1. the union cap. The old cap clipped the pad boundary at `1.7 * maxArmInset`
 *      regardless of arm width, so a wide arm whose mouth corner
 *      `sqrt(R^2 + hw^2)` sat outside `1.7 * maxR` had the pad neck in short of
 *      it. The live cap follows the WIDEST arm's mouth corner, which the union
 *      can never exceed.
 *   2. the full collision mouth. A non-live (mitred) corner truncates each arm's
 *      mouth to the bisector to keep the VISIBLE fan from folding; that also
 *      orphaned a wedge of a wide-short arm's own carriageway in the COLLISION
 *      shell, where overlap is harmless. The live path runs each collision mouth
 *      to its full `atan2(hw, R)`. MEASURED with `drivesweep`: every surviving
 *      hole sample was inside a junction pad, the bulk at 4+-arm nodes.
 */
let _legacyCap = null;
function legacyCap() {
  if (_legacyCap !== null) return _legacyCap;
  _legacyCap = false;
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('nocapfix') === '1') {
      _legacyCap = true;
    }
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.OW_NO_CAP_FIX === '1') _legacyCap = true;
  } catch { /* no process */ }
  if (_legacyCap) console.warn('[world] JUNCTION PAD CAP FIX DISABLED — cap clips the union at 1.7x pad radius again');
  return _legacyCap;
}

/**
 * A/B hatch for the junction NOTCH FILL — the negative control for the 4+-arm
 * hole assertion in `src/world/drivesweep.mjs`. `?nonotchfix=1`, or
 * `OW_NO_NOTCH_FIX=1` headless, reverts the wedge fill so the COLLISION pad is
 * the bare union of its arms again.
 *
 * The union cap + full collision mouth (`legacyCap`) got the drive surface to
 * follow each arm's own carriageway, but the pad it builds is still only the
 * UNION of the arms — a plus/cross of asphalt with an EMPTY WEDGE in every
 * corner where two arms splay apart. At a 4+-arm crossing those wedges are the
 * bulk of the junction area, and a lane the graph routes through a corner (or a
 * car cutting one) drops straight through the re-entrant notch into the terrain
 * `netgen` sinks below the tarmac. MEASURED with `drivesweep`: 366 of 430 hole
 * samples were at 4+-arm nodes, every one inside a junction pad.
 *
 * The fill is collision-only and geometry-free: the boundary ring is already
 * the arm mouth corners, so the CONVEX HULL of that ring is the true outline of
 * the crossing. Each hull edge that skips a re-entrant boundary point spans a
 * notch, and one centre-fan triangle across it covers the wedge. A downward ray
 * finds the top surface, so this double coverage over the union is harmless; it
 * never touches the visible pad, which keeps its exact union outline.
 */
let _noNotchFix = null;
function noNotchFix() {
  if (_noNotchFix !== null) return _noNotchFix;
  _noNotchFix = false;
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('nonotchfix') === '1') {
      _noNotchFix = true;
    }
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.OW_NO_NOTCH_FIX === '1') _noNotchFix = true;
  } catch { /* no process */ }
  if (_noNotchFix) console.warn('[world] JUNCTION NOTCH FILL DISABLED — the collision pad is the bare union of its arms again');
  return _noNotchFix;
}

/**
 * A/B hatch for the hole fix, and the negative control for
 * `src/physics/walksweep.mjs`. `?nogapfix=1`, or `OW_NO_GAP_FIX=1` headless,
 * puts back the two things that dug the trench: the suppressed footway strip
 * is emitted as NOTHING again instead of as a skirt, and `world` skips the
 * `LAYER.CLIP` corridor floor. Reverted, the walk sweep must go red — that
 * pairing is the only reason the green numbers mean anything.
 */
let _noGapFix = null;
export function noGapFix() {
  if (_noGapFix !== null) return _noGapFix;
  _noGapFix = false;
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('nogapfix') === '1') {
      _noGapFix = true;
    }
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.OW_NO_GAP_FIX === '1') _noGapFix = true;
  } catch { /* no process */ }
  if (_noGapFix) console.warn('[world] GAP FIX DISABLED — no footway skirt, no corridor floor');
  return _noGapFix;
}

export class RoadMeshBuilder {
  constructor({ graph, terrain, materials, palette, rng }) {
    this.graph = graph;
    this.terrain = terrain;
    this.materials = materials;
    this.palette = palette;
    this.rng = rng;
    this._padR = new Float32Array(graph.nodes.length);
    for (let i = 0; i < graph.nodes.length; i++) {
      const n = graph.nodes[i];
      let r = 3;
      for (const eid of n.links) {
        const e = graph.edges[eid];
        r = Math.max(r, roadHalfWidth(e.kind, e.lanes) * (n.links.length > 2 ? 1.3 : 1.05));
      }
      this._padR[i] = r;
    }
    this._buildLaneIndex();
    // Which sector owns which edge / node.
    this._edgesBySector = new Map();
    this._nodesBySector = new Map();
    for (const e of graph.edges) {
      const na = graph.nodes[e.a];
      const nb = graph.nodes[e.b];
      const key = sectorKey(Math.floor(((na.x + nb.x) / 2) / SECTOR), Math.floor(((na.z + nb.z) / 2) / SECTOR));
      let l = this._edgesBySector.get(key);
      if (!l) this._edgesBySector.set(key, (l = []));
      l.push(e);
    }
    for (const n of graph.nodes) {
      if (!n.links.length) continue;
      const key = sectorKey(Math.floor(n.x / SECTOR), Math.floor(n.z / SECTOR));
      let l = this._nodesBySector.get(key);
      if (!l) this._nodesBySector.set(key, (l = []));
      l.push(n);
    }
  }

  /**
   * A hash grid of every DRIVABLE lane band in the city.
   *
   * THE SECOND REASON THE PAVEMENT WAS IN THE ROAD, and it is not a junction
   * bug at all. Corridors are laid by twelve independent authors and
   * `netgen.dedupeCorridors` only merges pairs that are near-PARALLEL
   * (cos > 0.86) and cover each other for 60 m or more. Everything else — two
   * streets crossing at 40 degrees, a quay clipping the corner of a grid, a
   * ramp threading between two blocks — is left as authored, and each corridor
   * then lays a 3.4 m footway and a kerb wherever its own cross section says,
   * including straight down the middle of its neighbour's carriageway.
   * Measured on the emitted triangles: 17.1% of footway and kerb AREA inside a
   * lane a driver may legally use, and 60% of that area more than 1.5 m in.
   *
   * The graph must not be re-cut here — `traffic`, `police`, `peds` and the
   * minimap all key off it — so the footway yields instead: a cross section
   * that would stand in someone else's lane is not emitted, and the strip
   * simply ends there, square, the way a footway ends at any other kerb line.
   */
  _buildLaneIndex() {
    const CELL = 48;
    this._laneCell = CELL;
    this._lanes = new Map();
    for (const e of this.graph.edges) {
      if (e.rail) continue;
      const na = this.graph.nodes[e.a];
      const nb = this.graph.nodes[e.b];
      const k = ROAD_KIND[e.kind] ?? ROAD_KIND.street;
      const sw = e.bridge
        ? Math.min(Math.max(k.sidewalk, 1.0), (e.kind === 'highway' ? 1.6 : 2.5) - 0.78)
        : k.sidewalk;
      const s = {
        ax: na.x, az: na.z, ay: na.y, bx: nb.x, bz: nb.z, by: nb.y,
        // The DRIVABLE half width. The shoulder is not a lane, and a kerb
        // stone standing in the shoulder is a kerb stone in the right place.
        lh: (e.lanes * k.laneWidth) / 2,
        // The whole corridor out to the back of the footway, and the arc range
        // over which this edge actually lays one — a footway does not exist
        // inside its own junction pads, so a corridor must not be treated as
        // paved there.
        fw: sw > 0 ? roadHalfWidth(e.kind, e.lanes) + KERB_W + sw : 0,
        s0: this._insetAt(e, e.a), s1: e.len - this._insetAt(e, e.b), len: e.len,
        id: e.id, a: e.a, b: e.b,
      };
      const pad = Math.max(s.lh, s.fw);
      const x0 = Math.floor((Math.min(s.ax, s.bx) - pad) / CELL);
      const x1 = Math.floor((Math.max(s.ax, s.bx) + pad) / CELL);
      const z0 = Math.floor((Math.min(s.az, s.bz) - pad) / CELL);
      const z1 = Math.floor((Math.max(s.az, s.bz) + pad) / CELL);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const key = (x * 73856093) ^ (z * 19349663);
          let l = this._lanes.get(key);
          if (!l) this._lanes.set(key, (l = []));
          l.push(s);
        }
      }
    }
  }

  /**
   * How far inside somebody's drivable lane this point is. 0 = clear.
   *
   * `skip` is the edge whose own footway is being laid: a strip is never inside
   * its own lanes, but excluding it costs nothing and keeps the answer honest
   * if the cross section is ever widened.
   */
  laneDepth(x, y, z, skip) {
    const CELL = this._laneCell;
    const l = this._lanes.get((Math.floor(x / CELL) * 73856093) ^ (Math.floor(z / CELL) * 19349663));
    if (!l) return 0;
    let worst = 0;
    for (let i = 0; i < l.length; i++) {
      const s = l[i];
      if (skip && s.a === skip.a && s.b === skip.b) continue;
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz;
      if (l2 < 1e-9) continue;
      const t = ((x - s.ax) * dx + (z - s.az) * dz) / l2;
      if (t < 0 || t > 1) continue;
      const qx = s.ax + dx * t;
      const qz = s.az + dz * t;
      const d = s.lh - Math.hypot(x - qx, z - qz);
      if (d <= worst) continue;
      // A bridge deck eighteen metres over a quay is not paving the quay.
      if (Math.abs(y - (s.ay + (s.by - s.ay) * t)) > 2.0) continue;
      worst = d;
    }
    return worst;
  }

  /**
   * Is a LOWER-numbered corridor already paving this ground?
   *
   * The same overlap that puts a footway in a lane also puts two footways on
   * top of each other, a metre or so apart in height, wherever a pair of
   * corridors runs 8-14 m apart — close enough that each one's 3.4 m footway
   * reaches into the other's. Two coplanar-ish concrete surfaces fighting for
   * the same depth value is what a critic reported in the plaza as "dark seams
   * wandering across it at random angles".
   *
   * One of the two has to yield and it has to be the SAME one every time, or
   * the seam simply moves; the lower edge id wins, which is arbitrary but
   * total and stable. Edges that share a node are exempt — a footway meeting
   * its own junction corner is not an overlap — and so is the stretch of a
   * corridor inside its own junction pads, where it lays no footway at all.
   */
  footPaved(x, y, z, id, nodeA, nodeB) {
    const CELL = this._laneCell;
    const l = this._lanes.get((Math.floor(x / CELL) * 73856093) ^ (Math.floor(z / CELL) * 19349663));
    if (!l) return false;
    for (let i = 0; i < l.length; i++) {
      const s = l[i];
      if (s.fw <= 0 || s.id >= id) continue;
      if (s.a === nodeA || s.b === nodeA || s.a === nodeB || s.b === nodeB) continue;
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz;
      if (l2 < 1e-9) continue;
      const t = ((x - s.ax) * dx + (z - s.az) * dz) / l2;
      const arc = t * s.len;
      if (arc < s.s0 || arc > s.s1) continue;
      if (Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t)) > s.fw - 0.15) continue;
      if (Math.abs(y - (s.ay + (s.by - s.ay) * t)) > 2.0) continue;
      return true;
    }
    return false;
  }

  hasWork(sx, sz) {
    const k = sectorKey(sx, sz);
    return this._edgesBySector.has(k) || this._nodesBySector.has(k);
  }

  /**
   * How far from `nodeId` this edge's carriageway, kerb and footway all start.
   *
   * THE JUNCTION AND THE STRAIGHT RUN MUST AGREE ON THIS NUMBER OR THEY CANNOT
   * MEET. `_edge` shrinks both insets when two pads would eat a short edge
   * whole, and the node builder used to know nothing about that — so on every
   * short edge the fillet began at `_padR` while the straight run began
   * somewhere inside it, and the two overlapped by the difference.
   */
  _insetAt(e, nodeId) {
    let iA = this._padR[e.a];
    let iB = this._padR[e.b];
    if (iA + iB > e.len - 1.2) {
      const k = Math.max(0, (e.len - 1.2) / (iA + iB));
      iA *= k;
      iB *= k;
    }
    return Math.max(0.6, e.a === nodeId ? iA : iB);
  }

  /**
   * Start an incremental build. Call `step()` until it returns true.
   *
   * `mode` is `'visual'` or `'collision'`. THEY ARE SEPARATE STREAMS ON
   * PURPOSE. Collision used to be a by-product of the visible sector, which
   * tied "a car can drive on this road" to "this road is drawn at full detail"
   * — two questions with different right answers and, as `physics` measured,
   * different radii: the visible set is a DISC of sector centres inside
   * `SECTOR_RADIUS_MAX`, while collision was taken over the 3x3 CHEBYSHEV
   * neighbourhood, so the four diagonal sectors were asked for a collider they
   * had never been built to produce. That is most of the 5-8% of carriageway
   * inside 512 m of the camera that had no road collision at all.
   */
  begin(sx, sz, mode = 'visual') {
    const k = sectorKey(sx, sz);
    return new SectorBuild(
      this, sx, sz, this._edgesBySector.get(k) ?? [], this._nodesBySector.get(k) ?? [], mode
    );
  }

  /**
   * The far representation: every carriageway in the sector as a flat ribbon,
   * one merged mesh, no kerbs or paint. This is what keeps the road network
   * visible out to the horizon for the price of a single draw call.
   */
  buildFar(sx, sz) {
    const k = sectorKey(sx, sz);
    const edges = this._edgesBySector.get(k);
    if (!edges || !edges.length) return null;
    const acc = new Accum('road_far');
    const nodes = this.graph.nodes;
    for (const e of edges) {
      if (e.rail) continue;
      const na = nodes[e.a];
      const nb = nodes[e.b];
      const hw = roadHalfWidth(e.kind, e.lanes);
      const rx = -e.dz * hw;
      const rz = e.dx * hw;
      const steps = Math.max(1, Math.ceil(e.len / 32));
      let prevL = -1;
      let prevR = -1;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = lerp(na.x, nb.x, t);
        const z = lerp(na.z, nb.z, t);
        const y = lerp(na.y, nb.y, t) + 0.03;
        const a = acc.vert(x - rx, y, z - rz, 0, 1, 0, (x - rx) * 0.05, (z - rz) * 0.05, 0, 0.35, 0.1);
        const b = acc.vert(x + rx, y, z + rz, 0, 1, 0, (x + rx) * 0.05, (z + rz) * 0.05, 0, 0.35, 0.1);
        if (prevL >= 0) acc.faceQuad(prevL, a, b, prevR, 0, 1, 0);
        prevL = a;
        prevR = b;
      }
    }
    if (acc.empty) return null;
    const geo = acc.build();
    const mesh = new THREE.Mesh(geo, this._mat('road_pad'));
    mesh.name = `road_far_${sx}_${sz}`;
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.userData.owNoShadow = true;
    mesh.userData.collision = false;
    mesh.userData.surface = 'asphalt';
    mesh.renderOrder = -1;
    return mesh;
  }

  _mat(key) {
    this._mats ??= new Map();
    let m = this._mats.get(key);
    if (!m) {
      const def = this.palette[key];
      m = this.materials.get(def.name, def.opts);
      this._mats.set(key, m);
    }
    return m;
  }

  surfaceOf(key) {
    return this.palette[key]?.surface ?? 'concrete';
  }
}

function sectorKey(sx, sz) {
  return `${sx},${sz}`;
}

/** Scratch for the collision-only cross section. Builds are never re-entrant. */
const _colP = { x: 0, y: 0, z: 0 };
const _colQ = { x: 0, y: 0, z: 0 };

/* ==================================================================== */
/* One sector, built a few items per frame                              */
/* ==================================================================== */

class SectorBuild {
  constructor(owner, sx, sz, edges, nodes, mode = 'visual') {
    this.o = owner;
    this.sx = sx;
    this.sz = sz;
    this.edges = edges;
    this.nodes = nodes;
    this.ei = 0;
    this.ni = 0;
    this.colOnly = mode === 'collision';
    this.acc = new Map();
    this.col = this.colOnly ? new Accum(`road_col_${sx}_${sz}`) : null;
    this.rng = owner.rng.fork();
    this.done = false;
    this.total = edges.length + nodes.length;
  }

  _a(key) {
    let a = this.acc.get(key);
    if (!a) this.acc.set(key, (a = new Accum(`road_${key}`)));
    return a;
  }

  /** Process up to `n` items. Returns true when the sector is complete. */
  step(n = 10) {
    let done = 0;
    while (done < n && this.ei < this.edges.length) {
      this._edge(this.edges[this.ei++]);
      done++;
    }
    while (done < n && this.ni < this.nodes.length) {
      this._node(this.nodes[this.ni++]);
      done++;
    }
    if (this.ei >= this.edges.length && this.ni >= this.nodes.length) {
      this.done = true;
    }
    return this.done;
  }

  finish() {
    if (this.colOnly) {
      let colMesh = null;
      if (!this.col.empty) {
        colMesh = new THREE.Mesh(this.col.build(), INVISIBLE);
        colMesh.name = `road_col_${this.sx}_${this.sz}`;
        colMesh.visible = false;
        colMesh.matrixAutoUpdate = false;
        colMesh.userData.surface = 'asphalt';
      }
      return { group: null, colMesh, tris: 0 };
    }
    const group = new THREE.Group();
    group.name = `sector_${this.sx}_${this.sz}`;
    group.matrixAutoUpdate = false;
    let tris = 0;
    for (const [key, acc] of this.acc) {
      if (acc.empty) continue;
      const geo = acc.build();
      const mesh = new THREE.Mesh(geo, this.o._mat(key));
      mesh.name = `road_${key}_${this.sx}_${this.sz}`;
      mesh.matrixAutoUpdate = false;
      mesh.receiveShadow = true;
      mesh.castShadow =
        key === 'kerb' || key === 'walk' || key === 'rail_steel' || key === 'verge' || key === 'verge_riser';
      if (!mesh.castShadow) mesh.userData.owNoShadow = true;
      mesh.userData.collision = false;
      mesh.userData.surface = this.o.surfaceOf(key);
      if (key.startsWith('line_') || key.startsWith('mark_') || key === 'drain' || key === 'cover') mesh.renderOrder = 1;
      group.add(mesh);
      tris += geo.index.count / 3;
    }
    this.acc.clear();
    return { group, colMesh: null, tris };
  }

  /* ------------------------------------------------------------ edge -- */

  _edge(e) {
    const g = this.o.graph;
    const na = g.nodes[e.a];
    const nb = g.nodes[e.b];
    // Mill trackage is drawn, never driven, and has never had a collider.
    if (e.rail) return this.colOnly ? undefined : this._rail(e, na, nb);

    const kind = ROAD_KIND[e.kind] ?? ROAD_KIND.street;
    const hw = roadHalfWidth(e.kind, e.lanes);
    const L = e.len;
    /**
     * Effective footway width.
     *
     * A bridge deck is only `roadHalfWidth + 1.6` (highway) or `+ 2.5` metres
     * wide to the outside of its edge beam, and the parapet stands 0.28 m
     * inside that. An arterial's 3.4 m pavement therefore hung 1.2 m PAST the
     * parapet and out over the river, and the verge behind it dropped to
     * whatever `terrain.heightAt` said — which under a bridge is the river bed,
     * twenty-odd metres down. Every crossing in the city wore a grass curtain.
     * Clamp the footway inside the structure; a highway bridge gets the safety
     * kerb it would have in reality instead of a graded shoulder over water.
     */
    const SW = e.bridge
      ? Math.min(Math.max(kind.sidewalk, 1.0), (e.kind === 'highway' ? 1.6 : 2.5) - 0.45 - 0.33)
      : kind.sidewalk;
    // Never drop the carriageway entirely: if the two junction pads would eat
    // the whole edge, shrink both insets instead so the road still connects.
    // `_insetAt` is the single source of that number — the node builder reads
    // the same one, which is what lets the fillet meet this run exactly.
    const s0 = this.o._insetAt(e, e.a);
    const s1 = L - this.o._insetAt(e, e.b);
    if (s1 - s0 < 0.5) return;

    const dx = e.dx;
    const dz = e.dz;
    const rx = -dz;
    const rz = dx;
    const ya = na.y;
    const yb = nb.y;
    const ax = na.x;
    const az = na.z;
    const crown = hw * 0.021;
    const rng = this.rng;

    // Surface height at (arc s, lateral o).
    const pt = (s, o, out) => {
      const x = ax + dx * s + rx * o;
      const z = az + dz * s + rz * o;
      const base = ya + ((yb - ya) * s) / L;
      const u = o / hw;
      const cam = crown * (1 - u * u);
      // wheel ruts, ~0.45 of the half width
      const rut = -0.014 * Math.exp(-((Math.abs(u) - 0.46) ** 2) / 0.028);
      out.x = x;
      out.y = base + cam + rut + roadWob(x, z);
      out.z = z;
      return out;
    };

    if (this.colOnly) {
      // The collision stream wants the cross section and nothing else: no
      // carriageway rows, no kerb stones, no paint, no gullies. That is ~12% of
      // the work of a visible sector, which is what makes it affordable to keep
      // collision resident over a wider radius than the geometry you can see.
      this._edgeCollision(e, pt, hw, SW, s0, s1, _colP, _colQ);
      return;
    }

    const COLS = [-1, -0.78, -0.5, -0.24, 0, 0.24, 0.5, 0.78, 1];
    const step = 2.7;
    const rows = Math.max(2, Math.ceil((s1 - s0) / step));
    const road = this._a('road');
    const ring = [];
    const P = { x: 0, y: 0, z: 0 };
    const Pn = { x: 0, y: 0, z: 0 };

    // slight normal tilt from grade + camber, so specular reads the crown
    const grade = (yb - ya) / L;

    for (let r = 0; r <= rows; r++) {
      const s = lerp(s0, s1, r / rows);
      const row = [];
      for (let c = 0; c < COLS.length; c++) {
        const o = COLS[c] * hw;
        pt(s, o, P);
        const u = o / hw;
        const nl = (-2 * crown * u) / hw; // d(camber)/d(o)
        let nx = -(rx * nl + dx * grade);
        let ny = 1;
        let nz = -(rz * nl + dz * grade);
        const inv = 1 / Math.hypot(nx, ny, nz);
        const gutter = clamp01((Math.abs(u) - 0.62) / 0.38);
        const polish = Math.exp(-((Math.abs(u) - 0.46) ** 2) / 0.03);
        const nn = n1(P.x * 0.045, P.z * 0.045);
        const grime = clamp01(0.10 + gutter * 0.42 - polish * 0.12 + nn * 0.26);
        const ao = clamp01(0.06 + gutter * 0.3);
        // `road_lane` wants 1 uv unit = 4 m, u ACROSS and v ALONG: that is
        // what puts the wheel-polish bands, the oil line and the cold joint
        // where the traffic actually put them.
        row.push(road.vert(P.x, P.y, P.z, nx * inv, ny * inv, nz * inv, (o + hw) * 0.25, s * 0.25, 0, grime, ao));
      }
      ring.push(row);
      if (r > 0) {
        const prev = ring[r - 1];
        for (let c = 0; c < COLS.length - 1; c++) road.faceQuad(prev[c], row[c], row[c + 1], prev[c + 1], 0, 1, 0);
      }
    }

    // ---- collision is a SEPARATE STREAM ----------------------------------
    //
    // Built by `begin(sx, sz, 'collision')` over its own, wider radius — see
    // the note on `begin`. What follows describes the cross section that
    // stream emits, and stays here because this is where the surface it has to
    // agree with is authored.
    //
    // IT USED TO BE ONE FLAT QUAD FROM PAVEMENT EDGE TO PAVEMENT EDGE, and
    // that single fact is most of why the city's cars were on the pavement:
    // there was no kerb in the collision world AT ALL, so nothing physically
    // separated the carriageway from the footway and a driver that drifted
    // simply kept going, over the kerb line, through whatever `props` had put
    // on the pavement. `traffic` measured 13.6% of samples with a wheel past
    // the kerb and `props` 88 impacts a minute on colliders BEHIND the kerb
    // face; both are the same missing 15 cm of geometry.
    //
    // The cross section is now the real one — channel, vertical kerb face,
    // pavement — sampled at the SAME `pt()` the visible carriageway uses, so
    // the surface a wheel raycast finds is the surface you can see. (The old
    // strip interpolated across |u| > 1, where the camber term goes strongly
    // negative, and ended up ~10 cm UNDER the visible crown.)

    // ---- kerbs + pavements, or a graded shoulder where there are none ---
    for (const side of [-1, 1]) {
      if (SW > 0) this._kerb(e, pt, hw, SW, s0, s1, side, rx, rz, dx, dz);
      else this._shoulder(pt, hw, s0, s1, side, rx * side, rz * side);
    }

    // ---- paint ----------------------------------------------------------
    this._paint(e, pt, hw, kind, s0, s1, L);

    // ---- junction furniture at each end ---------------------------------
    const nlA = na.links.length;
    const nlB = nb.links.length;
    if (SW > 0) {
      if (nlA > 2) this._crossing(e, pt, hw, s0, +1);
      if (nlB > 2) this._crossing(e, pt, hw, s1, -1);
    }

    // ---- gullies, manholes, patches -------------------------------------
    if (SW > 0 && !e.bridge) {
      for (let s = s0 + rng.range(6, 20); s < s1 - 4; s += rng.range(26, 46)) {
        const side = rng.float() < 0.5 ? -1 : 1;
        this._gully(pt, s, side * (hw - 0.24), dx, dz, rx, rz);
      }
    }
    for (let s = s0 + rng.range(8, 30); s < s1 - 5; s += rng.range(38, 78)) {
      this._manhole(pt, s, rng.range(-0.45, 0.45) * hw);
    }
    const patchN = Math.max(0, Math.round((s1 - s0) / rng.range(13, 30)));
    for (let i = 0; i < patchN; i++) {
      this._patch(pt, rng.range(s0 + 1, s1 - 1), rng.range(-0.86, 0.86) * hw, rng.range(0.5, 2.6), dx, dz, rx, rz);
    }
  }

  /**
   * The physical cross section of one carriageway run.
   *
   * Columns, left to right: back of pavement, kerb back, kerb TOP at the road
   * edge, road edge, crown, road edge, kerb top, kerb back, back of pavement.
   * The two coincident pairs at +-hw are what make the kerb a vertical face
   * rather than a ramp — six quads a row, twelve triangles per 11 m of road.
   */
  _edgeCollision(e, pt, hw, sw, s0, s1, P, Pn) {
    const col = this.col;
    const g = this.o.graph;
    const dropA = g.nodes[e.a].links.length > 2;
    const dropB = g.nodes[e.b].links.length > 2;
    const cs = Math.max(1, Math.ceil((s1 - s0) / 11));
    const walkOut = hw + (sw > 0 ? KERB_W + sw : 0);
    // Nine columns with a kerb, five without (a highway shoulder or a mill
    // alley is graded, not kerbed — driving off it is legal there).
    const N = sw > 0 ? 9 : 5;
    const prev = this._colRow ?? (this._colRow = new Int32Array(9));
    const cur = this._colRow2 ?? (this._colRow2 = new Int32Array(9));
    // 11 m rows cannot describe a 1.35 m dropped kerb, so pin a row at the end
    // of each drop run. Without this the ramp reads as an 11 m stretch of
    // half-height kerb, which is a worse defect than the one it is fixing.
    const ss = this._colS ?? (this._colS = new Float64Array(256));
    let ns = 0;
    if (sw > 0 && dropA) ss[ns++] = s0 + DROP_RUN;
    if (sw > 0 && dropB) ss[ns++] = s1 - DROP_RUN;
    const nExtra = ns;
    for (let i = 0; i <= cs && ns < 250; i++) ss[ns++] = lerp(s0, s1, i / cs);
    if (nExtra) {
      const view = ss.subarray(0, ns);
      view.sort();
    }
    let have = false;
    let nx = 0;
    let nz = 0;
    let okL = true;
    let okR = true;
    let kL = true;
    let kR = true;
    let pokL = true;
    let pokR = true;
    const gapOld = noGapFix();
    const o = this.o;
    for (let i = 0; i < ns; i++) {
      const s = ss[i];
      if (i > 0 && s - ss[i - 1] < 1e-4) continue;
      if (sw > 0) {
        pt(s, -hw, P);
        pt(s, hw, Pn);
        // The footway yields to somebody else's lane in the collision world for
        // the same reason it does in the visible one — see `_buildLaneIndex`.
        // A raised footway collider lying across a carriageway is a kerb a car
        // hits in the middle of the road.
        const ux = (Pn.x - P.x) / (2 * hw);
        const uz = (Pn.z - P.z) / (2 * hw);
        okL = okR = true;
        kL = kR = true;
        if (!legacyPave()) {
          for (let k = 0; k <= 2; k++) {
            const dd = ((KERB_W + sw) * k) / 2;
            const lx2 = P.x - ux * dd;
            const lz2 = P.z - uz * dd;
            const rx2 = Pn.x + ux * dd;
            const rz2 = Pn.z + uz * dd;
            if (okL && (o.laneDepth(lx2, P.y, lz2, e) > 0.05 || o.footPaved(lx2, P.y, lz2, e.id, e.a, e.b))) okL = false;
            if (okR && (o.laneDepth(rx2, Pn.y, rz2, e) > 0.05 || o.footPaved(rx2, Pn.y, rz2, e.id, e.a, e.b))) okR = false;
          }
          // ...and separately, whether the STONE fits, over its own 0.33 m and
          // against carriageways only. `_kerbBlocked` carries the argument and
          // the numbers; this is the same test written in this routine's own
          // coordinates because the collision stream has no `_place` placer.
          if (legacyKerb()) {
            kL = okL;
            kR = okR;
          } else {
            for (let k = 0; k <= 2 && (!okL || !okR); k++) {
              const dd = (KERB_W * k) / 2;
              if (!okL && kL && o.laneDepth(P.x - ux * dd, P.y, P.z - uz * dd, e) > 0.05) kL = false;
              if (!okR && kR && o.laneDepth(Pn.x + ux * dd, Pn.y, Pn.z + uz * dd, e) > 0.05) kR = false;
            }
          }
        }
        // Unit vector across the road, left to right of a->b.
        nx = (Pn.x - P.x) / (2 * hw);
        nz = (Pn.z - P.z) / (2 * hw);
        // Pavement cross-fall matches `_kerb`: kerb top, then rising outward.
        // The dropped kerb at a junction mouth is in the collision world too —
        // a lip you can see but cannot feel, or feel but cannot see, is worse
        // than either.
        const kh = KERB_COL_H * kerbDrop(Math.min(dropA ? s - s0 : 1e9, dropB ? s1 - s : 1e9), true);
        const lTop = P.y + kh;
        const rTop = Pn.y + kh;
        const lx = P.x;
        const lz = P.z;
        const ly = P.y;
        // Suppressed sides become a graded SKIRT rather than a hole — see the
        // note on SKIRT_LIP. The outer column drops to the sunk ground and the
        // inner one interpolates, so the strip is a ramp rather than a shelf
        // with a cliff at the road edge.
        const kf = KERB_W / (KERB_W + sw);
        const l0 = okL ? lTop + sw * 0.02
          : this._skirtY(lx - nx * (KERB_W + sw), lz - nz * (KERB_W + sw), ly);
        const l1 = okL || kL ? lTop : ly - SKIRT_LIP + (l0 - (ly - SKIRT_LIP)) * kf;
        const r0 = okR ? rTop + sw * 0.02
          : this._skirtY(Pn.x + nx * (KERB_W + sw), Pn.z + nz * (KERB_W + sw), Pn.y);
        const r1 = okR || kR ? rTop : Pn.y - SKIRT_LIP + (r0 - (Pn.y - SKIRT_LIP)) * kf;
        // The lip at the carriageway edge. Where the footway yields but the
        // stone fits (`kL`/`kR`, see `_kerbBlocked`) this is the kerb top, and
        // the stone gets its flat 0.33 m top (`l1`) so a car RIDES a kerb
        // rather than climbing a 31-degree ramp off the edge of one.
        //
        // The only ground this raises is the strip from the carriageway edge to
        // the back of the stone, and `kL`/`kR` have just proved that strip clear
        // of every drivable lane. Outboard of it the skirt still descends to the
        // same `l0` it always did, so it arrives at the sunk ground at the same
        // place; the most it is ever lifted in between is one kerb height,
        // decaying to zero, which is a kerb — the thing `vehicles`' climb assist
        // exists to ride over — and never a wall. The steepest skirt in the city
        // goes from about 8 degrees to about 14.
        const lEdge = okL || kL ? lTop : ly - SKIRT_LIP;
        const rEdge = okR || kR ? rTop : Pn.y - SKIRT_LIP;
        cur[0] = col.vert(lx - nx * (KERB_W + sw), l0, lz - nz * (KERB_W + sw), 0, 1, 0, 0, 0);
        cur[1] = col.vert(lx - nx * KERB_W, l1, lz - nz * KERB_W, 0, 1, 0, 0, 0);
        cur[2] = col.vert(lx, lEdge, lz, 0, 1, 0, 0, 0);
        cur[3] = col.vert(lx, ly, lz, 0, 1, 0, 0, 0);
        pt(s, 0, P);
        cur[4] = col.vert(P.x, P.y, P.z, 0, 1, 0, 0, 0);
        cur[5] = col.vert(Pn.x, Pn.y, Pn.z, 0, 1, 0, 0, 0);
        cur[6] = col.vert(Pn.x, rEdge, Pn.z, 0, 1, 0, 0, 0);
        cur[7] = col.vert(Pn.x + nx * KERB_W, r1, Pn.z + nz * KERB_W, 0, 1, 0, 0, 0);
        cur[8] = col.vert(Pn.x + nx * (KERB_W + sw), r0, Pn.z + nz * (KERB_W + sw), 0, 1, 0, 0, 0);
      } else {
        okL = okR = true;
        for (let c = 0; c < 5; c++) {
          const o2 = (c / 4 - 0.5) * 2 * walkOut;
          pt(s, o2, P);
          cur[c] = col.vert(P.x, P.y, P.z, 0, 1, 0, 0, 0);
        }
      }
      if (have) {
        for (let c = 0; c < N - 1; c++) {
          // Columns 0-2 are the left footway and its kerb, 3-4 the carriageway,
          // 5-7 the right. EVERY column is now unconditional: where the footway
          // yields, columns 0-2 carry the skirt instead of vanishing, so the
          // emitted surface is continuous from one crown to the other with no
          // hole anywhere along the run. That is the whole point — the two
          // `continue`s that used to be here are what dug the trench, and
          // `?nogapfix=1` puts them back as the negative control.
          if (gapOld && sw > 0 && c < 3 && !(okL && pokL)) continue;
          if (gapOld && sw > 0 && c > 4 && !(okR && pokR)) continue;
          // Columns 2-3 and 5-6 are the two kerb faces: coincident in plan, so
          // the quad is vertical and its outward normal looks at the
          // carriageway. Everything else is a horizontal strip. The physics BVH
          // falls back to the FACE normal on a deep contact, so a kerb wound
          // the wrong way would push a car INTO the pavement instead of off it.
          if (sw > 0 && (c === 2 || c === 5)) {
            const s2 = c === 2 ? 1 : -1;
            col.faceQuad(prev[c], cur[c], cur[c + 1], prev[c + 1], nx * s2, 0, nz * s2);
          } else {
            col.faceQuad(prev[c], cur[c], cur[c + 1], prev[c + 1], 0, 1, 0);
          }
        }
      }
      prev.set(cur);
      pokL = okL;
      pokR = okR;
      have = true;
    }
  }

  /**
   * Where the outer edge of a suppressed footway's skirt sits: the sunk ground,
   * clamped so the skirt is always at least `SKIRT_LIP` under the carriageway
   * it leaves (it must never win a downward query against a real surface) and
   * never more than `SKIRT_MAX` under it (it must never become a cliff of its
   * own). On a hillside cut the terrain runs away far faster than the footway
   * is wide, which is what the lower clamp is for.
   */
  _skirtY(x, z, roadY) {
    const t = this.o.terrain.heightAt(x, z);
    const lo = roadY - SKIRT_MAX;
    const hi = roadY - SKIRT_LIP;
    return t < lo ? lo : t > hi ? hi : t;
  }

  /* ------------------------------------------------------------ kerb -- */

  /**
   * Place a point `d` metres OUTSIDE the kerb line, for whichever kind of run
   * the placer describes.
   *
   * THIS IS THE HINGE OF THE WHOLE FILE, so it is worth being explicit about
   * what it replaced. The junction used to extrude its footway RADIALLY from
   * the node: back-of-pavement at `r + KERB_W + sw` along the same ray as the
   * kerb. A radial offset of a STRAIGHT line is not a parallel line — at
   * angle `a` off the arm it only moves the boundary `d * sin(a)` sideways —
   * so the corner footway was 1.85 m wide where it met a 3.03 m straight run,
   * and its back edge started 3.9 m further down the arm than the run's did.
   * Every junction corner in the city therefore had a wedge of overlap on one
   * side and a wedge of bare pad on the other, and what a player saw was a
   * loose slab lying in the road with the kerb stopping dead beside it.
   *
   * The true offset of the junction boundary at width `d` is the same
   * expression with `d` added to every half width: take the two arms' offset
   * kerb lines and the offset turning-head arc. Because the mouth angle
   * `atan((hw + d) / R)` is taken at the SAME `d`, the ends of that curve land
   * exactly on the straight run's cross section at arc `R` — offsets 0,
   * KERB_W, KERB_W + sw and so on, all of them, to the millimetre. The fillet
   * and the run are then one surface rather than two that nearly touch.
   *
   * UNION, NOT INTERSECTION — AND THAT ONE WORD WAS THE HOLE IN EVERY JUNCTION
   * IN THE CITY.
   *
   * A ray leaving the node at angle `t` is inside arm A's carriageway until it
   * crosses A's kerb line at `ra = (hwA + d) / sin(t - a0)`, and inside B's
   * until `rb`. The asphalt a junction is made of is the UNION of the arms it
   * joins, so the boundary along that ray is `max(ra, rb)` — the FARTHER of the
   * two exits. This took `min`, which is the INTERSECTION: the boundary
   * collapsed onto whichever kerb line came first, which on any junction whose
   * arms are not identical is a boundary lying deep inside the wider arm's own
   * carriageway.
   *
   * `_node` builds the drivable pad as a fan out to this same boundary, so the
   * pad was a wedge that necked from full width at the mouth down to nothing at
   * the node — while the carriageway itself stops `_insetAt` metres short,
   * expecting the pad to carry it. MEASURED on the emitted collision triangles
   * with `src/world/drivesweep.mjs`, over every lane centre and lane edge in
   * the city: 16.8 km of lane line standing on no road collision at all, 9301
   * separate holes, worst 19.2 m, and 87% of them at nodes with four or more
   * arms — the mixed-width junctions where `min` and `max` differ most. On the
   * Allegheny quay at (1006, -903) the carriageway simply stopped 9.7 m short
   * of the junction and the pad met it 3 m narrower on each side.
   *
   * With `max` the two ends of the corner land on the two mouth corners by
   * construction, which is what the paragraph above always claimed and never
   * did. `?nopadfix=1` (or `OW_NO_PAD_FIX=1`) restores the `min` and is the
   * negative control `drivesweep` is proved against.
   *
   * The re-entrant notch this leaves where two carriageways cross is the real
   * outline of two crossing streets. A rounded kerb corner belongs OUTSIDE it,
   * cutting that notch off; that is content work, and it must not be done by
   * shrinking the asphalt underneath it.
   */
  _place(pl, d, T) {
    if (pl.mode === 0) {
      T.x = pl.bx + pl.ox * d;
      T.z = pl.bz + pl.oz * d;
      T.nx = pl.ox;
      T.nz = pl.oz;
      return T;
    }
    const c = pl.c;
    const a1 = c.a0 + c.phi;
    if (c.legacy) {
      // The defect, preserved for the A/B: extrude RADIALLY from the node, so
      // the offset of a straight kerb line is not parallel to it.
      const t0 = lerp(c.a0 + c.hA, a1 - c.hB, pl.p);
      const s0 = Math.max(1e-3, Math.sin(t0 - c.a0));
      const s1 = Math.max(1e-3, Math.sin(a1 - t0));
      const r0 = Math.min(c.hwA / s0, c.hwB / s1, c.rmax) + d;
      T.x = pl.cx + Math.cos(t0) * r0;
      T.z = pl.cz + Math.sin(t0) * r0;
      T.nx = Math.cos(t0);
      T.nz = Math.sin(t0);
      T.r = r0;
      T.ang = t0;
      return T;
    }
    const t = lerp(c.a0 + Math.atan2(c.hwA + d, c.ra), a1 - Math.atan2(c.hwB + d, c.rb), pl.p);
    const sA = Math.max(1e-3, Math.sin(t - c.a0));
    const sB = Math.max(1e-3, Math.sin(a1 - t));
    const ra = (c.hwA + d) / sA;
    const rb = (c.hwB + d) / sB;
    const rc = c.rmax + d;
    // The union of the two arms, capped by the turning head. See the note above
    // for what `min` here cost and how it was measured.
    const rU = legacyPad() ? Math.min(ra, rb) : Math.max(ra, rb);
    const r = Math.min(rU, rc);
    const cs = Math.cos(t);
    const sn = Math.sin(t);
    T.x = pl.cx + cs * r;
    T.z = pl.cz + sn * r;
    // The outward normal belongs to whichever constraint won: an arm's kerb
    // line has the arm's own normal, the turning head is radial. A kerb face
    // wound off the wrong one pushes a car INTO the footway (see the note in
    // `_edgeCollision`), so this is not only a shading detail.
    if (rc <= rU) {
      T.nx = cs;
      T.nz = sn;
    } else if (ra === rU) {
      T.nx = -Math.sin(c.a0);
      T.nz = Math.cos(c.a0);
    } else {
      T.nx = Math.sin(a1);
      T.nz = -Math.cos(a1);
    }
    T.r = r;
    T.ang = t;
    return T;
  }

  /**
   * One cross section of kerb + footway + riser + verge, written into `S`.
   *
   * Eleven vertices: kerb base at the channel, top of the kerb face, outer top
   * of the chamfered arris, back of the stone, then the footway in two steps
   * with its cross-fall, then the retaining riser and the verge behind it.
   * A straight run and a junction corner both go through here, which is what
   * makes them agree — the only difference between them is `_place`.
   */
  _section(pl, roadY, h, SW, v, S, walkOn = true) {
    const kerb = this._a('kerb');
    const walk = this._a('walk');
    const verge = this._a('verge');
    const riser = this._a('verge_riser');
    const T = this._secT ?? (this._secT = { x: 0, z: 0, nx: 0, nz: 0, r: 0, ang: 0 });
    const topY = roadY + h;

    this._place(pl, 0, T);
    const bx = T.x;
    const bz = T.z;
    const ox = T.nx;
    const oz = T.nz;
    const grimeK = clamp01(0.42 + n1(bx * 0.2, bz * 0.2) * 0.4);
    S.ox = ox;
    S.oz = oz;
    S.v0 = kerb.vert(bx, roadY - 0.02, bz, ox, 0.06, oz, v, 0, 0.15, clamp01(grimeK + 0.25), 0.5);
    S.v1 = kerb.vert(bx, topY - 0.028 * (h / KERB_H), bz, ox, 0.06, oz, v, h, 0.75, grimeK, 0.18);
    this._place(pl, 0.036, T);
    S.v2 = kerb.vert(T.x, topY, T.z, ox * 0.7, 0.7, oz * 0.7, v, h, 1.0, grimeK * 0.7, 0.1);
    this._place(pl, KERB_W, T);
    const kx = T.x;
    const kz = T.z;
    S.v3 = kerb.vert(kx, topY - 0.004, kz, 0, 1, 0, v, h, 0.55, grimeK * 0.8, 0.08);

    // footway: cross-fall up toward the building line, slabs settled.
    //
    // `walkOn` is false where `_blocked` refused the pavement but `_kerbBlocked`
    // allowed the stone: the kerb still stands and the ground behind it is
    // graded away by the riser and the verge, with no footway between them.
    // That is a kerb with a verge behind it, which is what a road edge looks
    // like anywhere the pavement has yielded to a neighbouring corridor — and
    // it is emitted in the visible world for the same reason it is emitted in
    // the collision one, because a lip you can feel and cannot see is exactly
    // as bad as the reverse.
    const SWe = walkOn ? SW : 0;
    this._place(pl, KERB_W + SWe, T);
    const wx = T.x;
    const wz = T.z;
    const dip = slabDip(wx, wz);
    const gy = this.o.terrain.heightAt(wx, wz);
    const wy = walkOn
      ? Math.max(topY + SW * 0.02 + dip, Math.min(topY + 0.6, gy + 0.05))
      : topY - 0.004;
    S.hasWalk = walkOn ? 1 : 0;
    if (walkOn) {
      const gW = clamp01(0.3 + n1(wx * 0.13, wz * 0.13) * 0.45);
      S.v4 = walk.vert(kx, topY - 0.004 + dip * 0.3, kz, 0, 1, 0, kx * 0.35, kz * 0.35, 0.62, clamp01(gW + 0.2), 0.22);
      this._place(pl, KERB_W + SW * 0.5, T);
      S.v5 = walk.vert(T.x, (topY + wy) * 0.5 + dip, T.z, 0, 1, 0, T.x * 0.35, T.z * 0.35, 0.4, gW, 0.1);
      S.v6 = walk.vert(wx, wy, wz, 0, 1, 0, wx * 0.35, wz * 0.35, 0.3, clamp01(gW + 0.18), 0.24);
    }

    // The back of the pavement steps DOWN to whatever the ground is doing.
    // `netgen.rasteriseRoads` sinks that ground 0.55 m under the corridor and
    // the footway stands 0.15 m over the channel, so in a dense district the
    // step is 0.7 m across less than a metre — a face at 40-70 degrees, which
    // is a retaining wall, not a lawn. Take the drop in a short concrete riser
    // and let the grass lie flat at the bottom of it; and never let either hang
    // more than DROP, or a bridge deck grows a curtain to the river bed.
    //
    // The verge width follows how urban the block is, sampled AT THE POINT
    // rather than once per edge: a per-edge value cannot agree with the node's
    // at the joint, and a verge that steps 1.7 m wider halfway round a corner
    // is one more torn seam.
    const VERGE = lerp(2.6, 0.85, clamp01(this.o.terrain.urbanAt(wx, wz) * 1.3));
    const RISE = Math.min(0.3, VERGE * 0.32);
    const DROP = 1.15;
    this._place(pl, KERB_W + SWe + RISE, T);
    const mx = T.x;
    const mz = T.z;
    const my = clamp(this.o.terrain.heightAt(mx, mz), wy - DROP, wy - 0.02);
    this._place(pl, KERB_W + SWe + VERGE, T);
    const ex = T.x;
    const ez = T.z;
    const ey = clamp(this.o.terrain.heightAt(ex, ez), my - 0.6, wy - 0.03);
    const gW2 = clamp01(0.42 + n1(mx * 0.11, mz * 0.11) * 0.4);
    S.r0 = riser.vert(wx, wy - 0.012, wz, ox, 0.25, oz, wx * 0.4, wy * 0.4, 0.35, gW2, 0.3);
    S.r1 = riser.vert(mx, my, mz, ox, 0.25, oz, mx * 0.4, my * 0.4, 0.2, clamp01(gW2 + 0.2), 0.6);
    S.g0 = verge.vert(mx, my - 0.004, mz, 0, 1, 0, mx * 0.2, mz * 0.2, 0.3, 0.55, 0.35);
    S.g1 = verge.vert(ex, ey, ez, 0, 1, 0, ex * 0.2, ez * 0.2, 0.25, 0.4, 0.15);
    return S;
  }

  /** The seven quad strips between two consecutive cross sections. */
  _stitch(P, Q) {
    const kerb = this._a('kerb');
    const walk = this._a('walk');
    const verge = this._a('verge');
    const riser = this._a('verge_riser');
    // The kerb face and its chamfer look OUT at the carriageway; every other
    // strip here is horizontal. `faceQuad` picks the winding from that, so the
    // -1 and +1 sides need no mirrored copy of this code.
    const ox = P.ox;
    const oz = P.oz;
    kerb.faceQuad(P.v0, Q.v0, Q.v1, P.v1, ox, 0, oz);
    kerb.faceQuad(P.v1, Q.v1, Q.v2, P.v2, ox * 0.7, 0.7, oz * 0.7);
    kerb.faceQuad(P.v2, Q.v2, Q.v3, P.v3, 0, 1, 0);
    // A kerb-only section has no footway vertices at all. Where one meets a
    // full section the strip simply ends, square, the way a footway ends at any
    // other kerb line — a quad to vertices that were never written would be a
    // triangle stretched to whatever was in the slot last time round.
    if (P.hasWalk && Q.hasWalk) {
      walk.faceQuad(P.v4, Q.v4, Q.v5, P.v5, 0, 1, 0);
      walk.faceQuad(P.v5, Q.v5, Q.v6, P.v6, 0, 1, 0);
    }
    riser.faceQuad(P.r0, Q.r0, Q.r1, P.r1, ox, 0.35, oz);
    verge.faceQuad(P.g0, Q.g0, Q.g1, P.g1, 0, 1, 0);
  }

  /**
   * Would this cross section stand in somebody else's carriageway?
   *
   * Tested at the kerb line, the middle of the footway and its back edge —
   * three points, because a corridor crossing at a shallow angle clips the back
   * of the footway long before it reaches the kerb, and a single point test at
   * the centre is exactly the mistake that put 71 m impostors in mid-air.
   */
  _blocked(pl, SW, skip, id, nodeA, nodeB) {
    if (legacyPave()) return false;
    const T = this._blkT ?? (this._blkT = { x: 0, z: 0, nx: 0, nz: 0, r: 0, ang: 0 });
    const o = this.o;
    const W = KERB_W + SW;
    for (let k = 0; k <= 2; k++) {
      this._place(pl, (W * k) / 2, T);
      if (o.laneDepth(T.x, this._blkY, T.z, skip) > 0.05) return true;
      if (o.footPaved(T.x, this._blkY, T.z, id, nodeA, nodeB)) return true;
    }
    return false;
  }

  /**
   * MAY A KERB STAND HERE, EVEN THOUGH THE FOOTWAY MAY NOT?
   *
   * `_blocked` above is a test on the WHOLE cross section, out to the back of
   * the footway — and it has to be, because a corridor crossing at a shallow
   * angle clips the back of the pavement long before it reaches the kerb. But
   * the answer it returns was being applied to the KERB as well, and that is a
   * different question with a different answer: the kerb stone is 0.33 m wide
   * and sits ON the carriageway edge. A neighbour that clips the back of a
   * 3.4 m footway says nothing about whether there is room for the stone.
   *
   * What that cost, measured on the emitted collision triangles by
   * `src/world/drivesweep.mjs` over every kerbed carriageway in the city:
   * 11 615 of 98 826 kerb-line samples (11.75%) had NO lip at the road edge at
   * all — the surface simply ran off the carriageway and down the skirt. Broken
   * down by what was actually outboard of those kerb lines:
   *
   *   932    another edge's drivable LANE. Correct, and it stays: a kerb there
   *          is a kerb in the middle of a road
   *   1010   another edge's FOOTWAY
   *   9673   OPEN GROUND — nobody's lane, nobody's pavement, nothing there at
   *          all. The kerb was cancelled by a neighbour three metres behind it
   *
   * That is 92% of the missing kerb line in the city, and a carriageway with no
   * kerb is a car that drifts off the sides — `_edgeCollision`'s own note
   * measured what removing the kerb does (33.7% of samples off the carriageway
   * instead of 22.2%, 2.33% of cars stopped dead against world geometry instead
   * of 0.07%).
   *
   * So: THE KERB YIELDS TO A CARRIAGEWAY AND TO NOTHING ELSE. `footPaved` is
   * not consulted — two footways fighting for the same ground is a seam, and a
   * seam is not a reason to open the side of a road. `?nokerbfix=1` (or
   * `OW_NO_KERB_FIX=1`) restores the old behaviour and is the negative control.
   */
  _kerbBlocked(pl, skip) {
    if (legacyPave() || legacyKerb()) return true;
    const T = this._blkT ?? (this._blkT = { x: 0, z: 0, nx: 0, nz: 0, r: 0, ang: 0 });
    const o = this.o;
    for (let k = 0; k <= 2; k++) {
      this._place(pl, (KERB_W * k) / 2, T);
      if (o.laneDepth(T.x, this._blkY, T.z, skip) > 0.05) return true;
    }
    return false;
  }

  /** A free cross-section slot; two are alive at once while stitching. */
  _slot(i) {
    const k = `_sec${i & 1}`;
    return this[k] ?? (this[k] = { ox: 0, oz: 0, v0: 0, v1: 0, v2: 0, v3: 0, v4: 0, v5: 0, v6: 0, r0: 0, r1: 0, g0: 0, g1: 0 });
  }

  _kerb(e, pt, hw, SW, s0, s1, side, rx, rz, dx, dz) {
    const g = this.o.graph;
    // A dropped kerb belongs at a real junction mouth, which is where the
    // crossing lands. A bend or a mid-block split is not one.
    const dropA = g.nodes[e.a].links.length > 2;
    const dropB = g.nodes[e.b].links.length > 2;
    const pl = this._pl ?? (this._pl = { mode: 0, bx: 0, bz: 0, ox: 0, oz: 0, cx: 0, cz: 0, c: null, p: 0 });
    pl.mode = 0;
    pl.ox = rx * side;
    pl.oz = rz * side;
    const P = this._kp ?? (this._kp = { x: 0, y: 0, z: 0 });
    const ss = this._krow ?? (this._krow = new Float64Array(512));
    // One kerb stone per row, but with the run either side of a junction mouth
    // subdivided: the dropped kerb is 1.35 m long and a 1.55 m row cannot show
    // a ramp at all.
    let ns = 0;
    const step = 1.55;
    const mid0 = s0 + (dropA ? DROP_RUN : 0);
    const mid1 = s1 - (dropB ? DROP_RUN : 0);
    if (dropA) {
      ss[ns++] = s0;
      ss[ns++] = s0 + DROP_RUN * 0.34;
      ss[ns++] = s0 + DROP_RUN * 0.67;
    }
    const rows = Math.max(1, Math.ceil((mid1 - mid0) / step));
    if (mid1 > mid0) for (let r = 0; r <= rows && ns < 500; r++) ss[ns++] = lerp(mid0, mid1, r / rows);
    else if (!dropA) ss[ns++] = s0;
    if (dropB) {
      ss[ns++] = s1 - DROP_RUN * 0.67;
      ss[ns++] = s1 - DROP_RUN * 0.34;
      ss[ns++] = s1;
    } else if (ss[ns - 1] < s1 - 1e-6) ss[ns++] = s1;

    let prev = null;
    for (let r = 0; r < ns; r++) {
      const s = ss[r];
      pt(s, side * hw, P);
      // The lateral wander is tapered to nothing at both ends: the fillet round
      // the corner has no bow of its own there, and 3 cm of disagreement at the
      // joint is a 3 cm crack you can see from a car.
      const bow = kerbBow(P.x, P.z) * smoothstep(clamp01(Math.min(s - s0, s1 - s) / 2.2));
      pl.bx = P.x + pl.ox * bow;
      pl.bz = P.z + pl.oz * bow;
      this._blkY = P.y;
      const walkOn = !this._blocked(pl, SW, e, e.id, e.a, e.b);
      // The pavement may be refused and the stone still fit. See `_kerbBlocked`.
      if (!walkOn && this._kerbBlocked(pl, e)) {
        prev = null;
        continue;
      }
      const dm = Math.min(dropA ? s - s0 : 1e9, dropB ? s1 - s : 1e9);
      const h = (KERB_H + kerbSettle(P.x, P.z) - (kerbChipped(P.x, P.z) ? 0.055 : 0)) * kerbDrop(dm, true);
      const cur = this._section(pl, P.y, h, SW, s * 0.4, this._slot(r), walkOn);
      if (prev) this._stitch(prev, cur);
      prev = cur;
    }
  }

  /**
   * Graded shoulder for a road with no pavement — a motorway or a mill alley.
   * Same job as the verge: close the step down to the sunk ground.
   */
  _shoulder(pt, hw, s0, s1, side, ox, oz) {
    const verge = this._a('verge');
    const rows = Math.max(2, Math.ceil((s1 - s0) / 6));
    const P = { x: 0, y: 0, z: 0 };
    let prev = null;
    for (let r = 0; r <= rows; r++) {
      const s = lerp(s0, s1, r / rows);
      pt(s, side * hw, P);
      const ex = P.x + ox * 3.2;
      const ez = P.z + oz * 3.2;
      // Clamped for the same reason as the verge: a shoulder on a viaduct or
      // along the top of the Mt. Washington cut must not reach for the valley.
      const ey = clamp(this.o.terrain.heightAt(ex, ez), P.y - 1.6, P.y - 0.06);
      const a = verge.vert(P.x, P.y - 0.02, P.z, 0, 1, 0, P.x * 0.2, P.z * 0.2, 0.3, 0.6, 0.4);
      const b = verge.vert(ex, ey, ez, 0, 1, 0, ex * 0.2, ez * 0.2, 0.25, 0.4, 0.15);
      if (prev) verge.faceQuad(prev[0], a, b, prev[1], 0, 1, 0);
      prev = [a, b];
    }
  }

  /* ----------------------------------------------------------- paint -- */

  /**
   * Road markings.
   *
   * The `road_line*` surfaces are alpha-masked decals that already contain the
   * glyph (solid / 3 m dash / double), the bead grit, the thinning at the edges
   * and — the point of the whole family — the wear-through where the wheel line
   * crosses them. So one quad per line is the RIGHT amount of geometry: the
   * dashes, the erosion and the junction scrub all come out of the surface, and
   * they vary along the road instead of repeating per dash.
   */
  _paint(e, pt, hw, kind, s0, s1, L) {
    if (kind.paint === 'none') return;
    const fw = e.forward;
    const lw = e.laneWidth;
    const LINE = 0.5; // quad width; the glyph occupies the middle 28 %
    const DBL = 0.62;

    if (e.oneway || fw === e.lanes) {
      for (let k = 1; k < fw; k++) this._stripe(pt, s0, s1, (k - fw / 2) * lw, LINE, 'line_dash', 48);
    } else if (kind.paint === 'highway') {
      this._stripe(pt, s0, s1, -hw + 0.65, LINE, 'line_yellow', 9);
      this._stripe(pt, s0, s1, hw - 0.65, LINE, 'line_white', 9);
      for (let k = 1; k < fw; k++) {
        this._stripe(pt, s0, s1, k * lw, LINE, 'line_dash', 48);
        this._stripe(pt, s0, s1, -k * lw, LINE, 'line_dash', 48);
      }
    } else {
      const arterial = kind.paint === 'arterial';
      if (arterial || this.rng.float() < 0.62) {
        this._stripe(pt, s0, s1, 0, arterial ? DBL : LINE, arterial ? 'line_yellow' : 'line_dash', arterial ? 9 : 48);
      }
      if (arterial) {
        this._stripe(pt, s0, s1, -hw + 0.4, LINE, 'line_white', 9);
        this._stripe(pt, s0, s1, hw - 0.4, LINE, 'line_white', 9);
      }
      for (let k = 1; k < fw; k++) this._stripe(pt, s0, s1, k * lw, LINE, 'line_dash', 48);
      for (let k = 1; k < e.lanes - fw; k++) this._stripe(pt, s0, s1, -k * lw, LINE, 'line_dash', 48);
    }
  }

  /** One painted ribbon lying on the cambered surface. u across, v along. */
  _stripe(pt, sA, sB, offset, width, key, vMetres) {
    if (sB - sA < 1.2) return;
    const a = this._a(key);
    const half = width * 0.5;
    const segs = Math.max(1, Math.ceil((sB - sA) / 4.5));
    const P = { x: 0, y: 0, z: 0 };
    let pl = -1;
    let pr = -1;
    for (let i = 0; i <= segs; i++) {
      const s = lerp(sA, sB, i / segs);
      const v = s / vMetres;
      pt(s, offset - half, P);
      const l = a.vert(P.x, P.y + 0.011, P.z, 0, 1, 0, 0, v, 0.1, 0.4, 0.02);
      pt(s, offset + half, P);
      const r = a.vert(P.x, P.y + 0.011, P.z, 0, 1, 0, 1, v, 0.1, 0.4, 0.02);
      if (pl >= 0) a.faceQuad(pl, l, r, pr, 0, 1, 0);
      pl = l;
      pr = r;
    }
  }

  /**
   * Junction approach: a continental crossing then the stop bar, in that order
   * out from the junction, which is how they are actually laid.
   */
  _crossing(e, pt, hw, sEnd, sign) {
    const rng = this.rng;
    if (rng.float() < 0.32) return;
    const inner = hw - 0.3;
    if (rng.float() < 0.62) {
      // 5 bars per uv unit at a 1 m pitch: a 4 m crossing is v 0 .. 0.8
      const depth = rng.range(3.2, 4.4);
      this._mark(pt, sEnd + sign * 0.6, sEnd + sign * (0.6 + depth), -inner, inner, 'mark_cross', depth / 5);
      const s = sEnd + sign * (0.6 + depth + 0.8);
      const from = sign > 0 ? -inner : 0.25;
      const to = sign > 0 ? -0.25 : inner;
      this._mark(pt, s, s + sign * 1.6, from, to, 'mark_stop', 1);
    } else {
      const s = sEnd + sign * 1.6;
      const from = sign > 0 ? -inner : 0.25;
      const to = sign > 0 ? -0.25 : inner;
      this._mark(pt, s, s + sign * 1.6, from, to, 'mark_stop', 1);
    }
  }

  /** A marking whose u runs ACROSS the carriageway (crossings, stop bars). */
  _mark(pt, sA, sB, oA, oB, key, vSpan) {
    const a = this._a(key);
    const P = { x: 0, y: 0, z: 0 };
    const cols = Math.max(2, Math.ceil(Math.abs(oB - oA) / 2.2));
    const rows = Math.max(1, Math.ceil(Math.abs(sB - sA) / 2.2));
    const grid = [];
    for (let j = 0; j <= rows; j++) {
      const s = lerp(sA, sB, j / rows);
      const row = [];
      for (let i = 0; i <= cols; i++) {
        const o = lerp(oA, oB, i / cols);
        pt(s, o, P);
        row.push(a.vert(P.x, P.y + 0.011, P.z, 0, 1, 0, i / cols, (j / rows) * vSpan, 0.1, 0.4, 0.02));
      }
      grid.push(row);
      if (j > 0) {
        const prev = grid[j - 1];
        for (let i = 0; i < cols; i++) a.faceQuad(prev[i], row[i], row[i + 1], prev[i + 1], 0, 1, 0);
      }
    }
  }

  /* -------------------------------------------------------- furniture -- */

  /** Gully grating in the channel at the kerb face. Mesh UVs, 0..1 over it. */
  _gully(pt, s, o, dx, dz, rx, rz) {
    const a = this._a('drain');
    const P = pt(s, o, { x: 0, y: 0, z: 0 });
    const hl = 0.34;
    const hd = 0.23;
    const y = P.y - 0.024;
    const q = [
      [-hl, -hd, 0, 0], [hl, -hd, 1, 0], [hl, hd, 1, 1], [-hl, hd, 0, 1],
    ].map(([u, v, tu, tv]) =>
      a.vert(P.x + dx * u + rx * v, y, P.z + dz * u + rz * v, 0, 1, 0, tu, tv, 0.8, 0.85, 0.55)
    );
    a.faceQuad(q[0], q[1], q[2], q[3], 0, 1, 0);
  }

  /** Cast-iron cover, sunk a centimetre into the wearing course. */
  _manhole(pt, s, o) {
    const a = this._a('cover');
    const P = pt(s, o, { x: 0, y: 0, z: 0 });
    const R = 0.35;
    const y = P.y - 0.008;
    const q = [
      [-R, -R, 0, 0], [R, -R, 1, 0], [R, R, 1, 1], [-R, R, 0, 1],
    ].map(([u, v, tu, tv]) => a.vert(P.x + u, y, P.z + v, 0, 1, 0, tu, tv, 0.6, 0.6, 0.1));
    a.faceQuad(q[0], q[1], q[2], q[3], 0, 1, 0);
  }

  _patch(pt, s, o, r, dx, dz, rx, rz) {
    const a = this._a('road_patch');
    const rng = this.rng;
    const P = pt(s, o, { x: 0, y: 0, z: 0 });
    const N = 7;
    const c = a.vert(P.x, P.y + 0.007, P.z, 0, 1, 0, 0.5, 0.5, 0.2, 0.55, 0.05);
    const ring = [];
    const rot = rng.float() * 6.283;
    for (let i = 0; i < N; i++) {
      const t = rot + (i / N) * Math.PI * 2;
      const rr = r * rng.range(0.6, 1.25);
      const u = Math.cos(t) * rr;
      const v = Math.sin(t) * rr * 0.75;
      const x = P.x + dx * u + rx * v;
      const z = P.z + dz * u + rz * v;
      const y = pt(s + u, o + v, { x: 0, y: 0, z: 0 }).y;
      ring.push(a.vert(x, y + 0.006, z, 0, 1, 0, u, v, 0.35, clamp01(0.4 + rng.range(-0.2, 0.3)), 0.12));
    }
    for (let i = 0; i < N; i++) a.faceTri(c, ring[i], ring[(i + 1) % N], 0, 1, 0);
  }

  /* ------------------------------------------------------------ rail -- */

  _rail(e, na, nb) {
    const bal = this._a('ballast');
    const steel = this._a('rail_steel');
    const wood = this._a('sleeper');
    const dx = e.dx;
    const dz = e.dz;
    const rx = -dz;
    const rz = dx;
    const L = e.len;
    const HW = 2.5;
    const steps = Math.max(2, Math.ceil(L / 3));
    let prev = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = lerp(na.x, nb.x, t);
      const z = lerp(na.z, nb.z, t);
      const y = lerp(na.y, nb.y, t);
      const gy = y + 0.06;
      const g = clamp01(0.5 + n1(x * 0.2, z * 0.2) * 0.6);
      const v0 = bal.vert(x - rx * HW, gy - 0.16, z - rz * HW, 0, 1, 0, x * 0.3, z * 0.3, 0.3, g, 0.3);
      const v1 = bal.vert(x - rx * (HW - 0.9), gy, z - rz * (HW - 0.9), 0, 1, 0, x * 0.3, z * 0.3, 0.25, g, 0.1);
      const v2 = bal.vert(x + rx * (HW - 0.9), gy, z + rz * (HW - 0.9), 0, 1, 0, x * 0.3, z * 0.3, 0.25, g, 0.1);
      const v3 = bal.vert(x + rx * HW, gy - 0.16, z + rz * HW, 0, 1, 0, x * 0.3, z * 0.3, 0.3, g, 0.3);
      if (prev) {
        bal.faceQuad(prev[0], v0, v1, prev[1], 0, 1, 0);
        bal.faceQuad(prev[1], v1, v2, prev[2], 0, 1, 0);
        bal.faceQuad(prev[2], v2, v3, prev[3], 0, 1, 0);
      }
      prev = [v0, v1, v2, v3];
    }
    // sleepers
    for (let s = 0; s < L; s += 0.78) {
      const t = s / L;
      const x = lerp(na.x, nb.x, t);
      const z = lerp(na.z, nb.z, t);
      const y = lerp(na.y, nb.y, t) + 0.06;
      box(wood, x, y + 0.055, z, dx, dz, 0.13, 1.35, 0.11, 0.35, clamp01(0.55 + n1(x, z) * 0.5), 0.35);
    }
    // rails
    for (const side of [-0.7175, 0.7175]) {
      let pl = null;
      const rs = Math.max(2, Math.ceil(L / 6));
      for (let i = 0; i <= rs; i++) {
        const t = i / rs;
        const x = lerp(na.x, nb.x, t) + rx * side;
        const z = lerp(na.z, nb.z, t) + rz * side;
        const y = lerp(na.y, nb.y, t) + 0.06 + 0.11;
        const a0 = steel.vert(x - rx * 0.035, y, z - rz * 0.035, 0, 1, 0, 0, t * 20, 0.85, 0.35, 0.05);
        const a1 = steel.vert(x + rx * 0.035, y, z + rz * 0.035, 0, 1, 0, 1, t * 20, 0.9, 0.3, 0.05);
        const a2 = steel.vert(x + rx * 0.035, y - 0.08, z + rz * 0.035, rx, 0, rz, 1, t * 20, 0.4, 0.75, 0.4);
        const a3 = steel.vert(x - rx * 0.035, y - 0.08, z - rz * 0.035, -rx, 0, -rz, 0, t * 20, 0.4, 0.75, 0.4);
        if (pl) {
          steel.faceQuad(pl[0], a0, a1, pl[1], 0, 1, 0);
          steel.faceQuad(pl[1], a1, a2, pl[2], rx, 0, rz);
          steel.faceQuad(pl[3], a3, a0, pl[0], -rx, 0, -rz);
        }
        pl = [a0, a1, a2, a3];
      }
    }
  }

  /* ------------------------------------------------------------ node -- */

  /**
   * The boundary of a junction, as an ordered ring of samples.
   *
   * THE OLD PAD WAS A CIRCLE OF RADIUS R AND THE CARRIAGEWAYS STOPPED SQUARE AT
   * ARC R, so at lateral offset `o` the pad reached only sqrt(R^2 - o^2) and the
   * road began at R: an uncovered crescent up to 1.7 m deep at EVERY corner of
   * EVERY junction in the city, through which you saw — and drove into — the
   * ground, which `netgen` deliberately sinks 0.55 m below the tarmac. Four
   * crescents per crossroads, a wheel dropping half a metre into each.
   *
   * The true boundary is analytic and has two regimes:
   *
   *   inside an arm's mouth  |theta - a| <= atan(hw/R):  r = R / cos(theta - a)
   *       — the straight end of that carriageway, at constant arc R;
   *   in the corner between two arms: r = min(hwA/sin(theta-aA), hwB/sin(aB-theta))
   *       — the two kerb lines extended until they cross.
   *
   * They agree exactly at the join, both giving sqrt(R^2 + hw^2), so the pad,
   * the carriageways and the pavement fillets tile with no gap and no overlap.
   *
   * The HEIGHT is carried the same way. A flat disc at `n.y` was a step of
   * `grade * R` against every arm that ramps away from it — 38 cm on an 8%
   * street, over a metre on a Mt. Washington switchback. Across an arm's mouth
   * the height is exactly that arm's own profile at arc R; through a corner it
   * eases from one to the next.
   *
   * TWO THINGS ABOUT THAT DESCRIPTION WERE WRONG, and between them they were
   * the single most visible defect in the game.
   *
   * 1. **Each arm has its OWN stop line.** `_edge` shrinks both insets when two
   *    pads would eat a short edge whole, so the arc the carriageway actually
   *    stops at is `_insetAt(e, node)`, not `_padR[node]`. The node builder used
   *    the node's radius for every arm and so began its fillet somewhere the
   *    straight run had already covered.
   *
   * 2. **Two arms closer together than `atan(hw/R)` each have overlapping
   *    mouths**, and the ring then ran BACKWARDS between them: A's mouth ended
   *    at a larger angle than B's mouth began. The pad is drawn as a fan from
   *    the node, so a ring that reverses folds the fan back over itself — two
   *    coplanar layers of asphalt fighting for the same depth value. That is
   *    what the plaza seams "wandering at random angles" were. Where the mouths
   *    overlap there is no room for a kerb between the arms at all, so the
   *    honest answer is to mitre the two mouths together at their bisector and
   *    emit no kerb in that corner.
   *
   * Writes into `out` (reused): { ang, r, dy, sw, kerb, ci, p }. `ci` indexes
   * `this._cors` for the corner a sample belongs to and `p` is its parameter
   * along that corner — together they are what `_place` needs to re-derive the
   * boundary at any offset width.
   */
  _junction(n, out) {
    const g = this.o.graph;
    const arms = this._arms ?? (this._arms = []);
    const cors = this._cors ?? (this._cors = []);
    arms.length = 0;
    cors.length = 0;
    for (const eid of n.links) {
      const e = g.edges[eid];
      if (e.rail) continue;
      const k = ROAD_KIND[e.kind] ?? ROAD_KIND.street;
      const other = e.a === n.id ? g.nodes[e.b] : g.nodes[e.a];
      const hw = roadHalfWidth(e.kind, e.lanes);
      const R = legacyPave() ? this.o._padR[n.id] : this.o._insetAt(e, n.id);
      arms.push({
        ang: Math.atan2(other.z - n.z, other.x - n.x),
        hw,
        sw: e.bridge
          ? Math.min(Math.max(k.sidewalk, 1.0), (e.kind === 'highway' ? 1.6 : 2.5) - 0.78)
          : k.sidewalk,
        R,
        eid: e.id,
        grade: (other.y - n.y) / Math.max(1, e.len),
        dy: ((other.y - n.y) / Math.max(1, e.len)) * R,
        half: Math.atan2(hw, R),
      });
    }
    out.length = 0;
    if (!arms.length) return arms;
    arms.sort((a, b) => a.ang - b.ang);
    const na = arms.length;
    let rmax = 0;
    for (let i = 0; i < na; i++) rmax = Math.max(rmax, arms[i].R);
    rmax *= PAD_RMAX;
    // The `1.7 * maxR` cap is a turning-head radius, not a carriageway one, and
    // on a node whose arms differ enormously in width it clips the union short.
    // A ray leaving the node at the mouth of arm A reaches that arm's own kerb
    // corner at `sqrt(R^2 + hw^2)` — the point where the straight run's edge
    // ends — and if that sits outside `1.7 * maxR` the pad necks in before it,
    // leaving a hole between pad and carriageway (drivesweep: 666 samples, all
    // 4+-arm pads). So the cap must reach the WIDEST arm's mouth corner. Raising
    // it can only let `r = min(rU, rc)` follow the true union `rU` more
    // faithfully — by the triangle inequality `sqrt(R^2 + (hw+d)^2) <=
    // sqrt(R^2 + hw^2) + d`, so the mouth is never clipped at any offset `d`,
    // and nothing that was unclipped before becomes clipped.
    if (!legacyCap()) {
      for (let i = 0; i < na; i++) {
        rmax = Math.max(rmax, Math.hypot(arms[i].R, arms[i].hw));
      }
    }

    for (let i = 0; i < na; i++) {
      const A = arms[i];
      const B = arms[(i + 1) % na];
      // A dead end has one arm, so its "corner" sweeps the whole turn.
      let phi = B.ang - A.ang;
      while (phi <= 1e-6) phi += Math.PI * 2;
      const legacy = legacyPave();
      // The old rule dropped the corner whenever the two mouths overlapped and
      // left the ring running backwards through the gap; the new one mitres the
      // mouths together at their bisector so the fan can never fold over.
      const live = legacy ? A.half + B.half < phi - 0.04 : A.half + B.half < phi - 0.02;
      cors.push({
        A, B, phi, live, legacy,
        a0: A.ang, hwA: A.hw, hwB: B.hw, ra: A.R, rb: B.R, rmax,
        // The mouth half-angles this corner allows its two arms. When the
        // mouths overlap they are mitred to the bisector instead.
        hA: legacy ? A.half : live ? A.half : phi / 2,
        hB: legacy ? B.half : live ? B.half : phi / 2,
      });
    }

    for (let i = 0; i < na; i++) {
      const A = arms[i];
      // A mouth is a STRAIGHT line — the arm's end cross-section at arc R — so it
      // covers the arm's carriageway all the way out to ±atan2(hw, R). The mitre
      // truncates that on a non-live corner (`hA/hB = phi/2`) to stop the VISIBLE
      // fan folding where two mouths overlap. But the COLLISION pad does not care
      // about a fold: a downward ray finds the top surface, so two overlapping
      // mouths are harmless double coverage. Truncating the mouth there, on the
      // other hand, orphans a wedge of real carriageway a car drives on — most
      // visibly a wide arm on a short inset, whose 60-degree mouth is cut to
      // ~24 degrees by a narrow neighbour 48 degrees away (drivesweep node 16).
      // So in the collision pass each mouth runs to its OWN full half-angle; the
      // visible pass keeps the mitre. This never reintroduces the fold anyone can
      // see, because it only widens the invisible collision shell.
      const fullMouth = this.colOnly && !legacyCap();
      const back = fullMouth ? A.half : cors[(i - 1 + na) % na].hB;
      const fwd = fullMouth ? A.half : cors[i].hA;
      // --- A's mouth: constant arc R, so the camber is the only shape in it.
      const M = 2;
      for (let k = 0; k <= M; k++) {
        const t = lerp(-back, fwd, k / M);
        const u = (A.R * Math.tan(t)) / A.hw; // lateral / hw, in -1..1
        out.push({
          ang: A.ang + t,
          r: A.R / Math.cos(t),
          dy: A.dy + A.hw * 0.021 * (1 - u * u),
          sw: A.sw,
          kerb: false,
          ci: -1,
          p: 0,
        });
      }
      // --- the corner from A round to B, on the boundary at offset zero.
      const C = cors[i];
      if (!C.live) continue;
      const span = C.phi - C.hA - C.hB;
      const kerbed = A.sw > 0.05 || C.B.sw > 0.05;
      // Enough segments to carry the mitre: the old code took `span / 0.2`
      // capped at 14, which on an ordinary crossroads is a 15-degree corner in
      // TWO quads.
      const segs = C.legacy
        ? Math.max(2, Math.min(14, Math.ceil(span / 0.2)))
        : Math.max(4, Math.min(30, Math.ceil(span / 0.075)));
      const T = this._jt ?? (this._jt = { x: 0, z: 0, nx: 0, nz: 0, r: 0, ang: 0 });
      const pl = this._jpl ?? (this._jpl = { mode: 1, bx: 0, bz: 0, ox: 0, oz: 0, cx: 0, cz: 0, c: null, p: 0 });
      pl.mode = 1;
      pl.cx = n.x;
      pl.cz = n.z;
      pl.c = C;
      for (let k = 0; k <= segs; k++) {
        const p = k / segs;
        pl.p = p;
        this._place(pl, 0, T);
        // Height follows whichever arm the sample is nearest, by that arm's own
        // grade at the sample's own arc along it — not one number for the whole
        // corner. At p = 0 that is exactly arc R on A, which is exactly where
        // `_kerb` starts, so the two agree to the millimetre.
        const yA = A.grade * (T.r * Math.cos(T.ang - A.ang));
        const yB = C.B.grade * (T.r * Math.cos(C.a0 + C.phi - T.ang));
        out.push({
          ang: T.ang,
          r: T.r,
          dy: lerp(yA, yB, smoothstep(p)),
          sw: lerp(A.sw, C.B.sw, p),
          kerb: kerbed,
          ci: i,
          p,
        });
      }
    }
    return arms;
  }

  _node(n) {
    if (!n.links.length) return;
    const ring = this._ring ?? (this._ring = []);
    const arms = this._junction(n, ring);
    if (!arms.length || ring.length < 3) return;

    const vis = !this.colOnly;
    const road = vis ? this._a('road_pad') : null;
    const N = ring.length;

    // --- pad: a fan out to the analytic boundary --------------------------
    const c = vis ? road.vert(n.x, n.y + 0.03, n.z, 0, 1, 0, n.x * 0.18, n.z * 0.18, 0, 0.34, 0.05) : 0;
    const inA = this._padIn ?? (this._padIn = []);
    const outA = this._padOut ?? (this._padOut = []);
    const colOut = this._padCol ?? (this._padCol = []);
    const colPos = this._padColPos ?? (this._padColPos = []);
    inA.length = 0;
    outA.length = 0;
    colOut.length = 0;
    colPos.length = 0;
    const cc = vis ? 0 : this.col.vert(n.x, n.y + 0.03, n.z, 0, 1, 0, 0, 0);
    for (let i = 0; i < N; i++) {
      const s = ring[i];
      const cs = Math.cos(s.ang);
      const sn = Math.sin(s.ang);
      const ox = n.x + cs * s.r;
      const oz = n.z + sn * s.r;
      const oy = n.y + s.dy;
      if (vis) {
        const ix = n.x + cs * s.r * 0.55;
        const iz = n.z + sn * s.r * 0.55;
        const iy = n.y + s.dy * 0.55 + 0.012;
        const gi = clamp01(0.3 + n1(ix * 0.05, iz * 0.05) * 0.5);
        const go = clamp01(0.42 + n1(ox * 0.05, oz * 0.05) * 0.5);
        inA.push(road.vert(ix, iy, iz, 0, 1, 0, ix * 0.18, iz * 0.18, 0, gi, 0.05));
        outA.push(road.vert(ox, oy + 0.004, oz, 0, 1, 0, ox * 0.18, oz * 0.18, 0, go, 0.12));
      } else {
        colOut.push(this.col.vert(ox, oy, oz, 0, 1, 0, 0, 0));
        colPos.push(ox, oz, i);
      }
    }
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      if (vis) {
        road.faceTri(c, inA[i], inA[j], 0, 1, 0);
        road.faceQuad(inA[i], outA[i], outA[j], inA[j], 0, 1, 0);
      } else {
        this.col.faceTri(cc, colOut[i], colOut[j], 0, 1, 0);
      }
    }
    // --- notch fill: close the re-entrant wedges of a 4+-arm crossing ------
    //
    // The fan above is the bare UNION of the arms — a plus/cross with an empty
    // wedge in every corner two arms splay apart. The CONVEX HULL of the ring
    // is the true outline of the crossing; every hull edge that skips a ring
    // point spans a notch the union necked past, and one centre-fan triangle
    // across it carries collision over the wedge. Collision-only: a downward ray
    // finds the top surface, so this double coverage over the union is harmless,
    // and the visible pad keeps its exact union outline. See `noNotchFix`.
    if (!vis && arms.length >= 3 && !noNotchFix()) {
      const hull = convexHullIdx(colPos);
      for (let h = 0; h < hull.length; h++) {
        const i = hull[h];
        const j = hull[(h + 1) % hull.length];
        // A hull edge whose endpoints are adjacent on the ring is already a fan
        // triangle; only the ones that skip ring points bridge a notch.
        if (j === (i + 1) % N || i === (j + 1) % N) continue;
        this.col.faceTri(cc, colOut[i], colOut[j], 0, 1, 0);
      }
    }

    // --- kerb, footway and verge round the corners -------------------------
    //
    // Emitted only where the ring is a KERB sample. Across a carriageway mouth
    // there is no kerb — running one there would wall the junction off, which
    // is exactly what the old code did to every alley mouth, because it
    // dropped alley arms from the fillet solve entirely and then swept the
    // pavement straight across their entrances.
    //
    // The corner is a SWEEP OF THE SAME CROSS SECTION the straight run uses,
    // along the same offset boundary, starting on the run's own end section.
    // That is the whole fix: `_section` and `_place` are shared, so "does the
    // fillet meet the pavement" stops being a question anyone can get wrong.
    const pl = this._jpl ?? (this._jpl = { mode: 1, bx: 0, bz: 0, ox: 0, oz: 0, cx: 0, cz: 0, c: null, p: 0 });
    const T = this._jt ?? (this._jt = { x: 0, z: 0, nx: 0, nz: 0, r: 0, ang: 0 });
    pl.cx = n.x;
    pl.cz = n.z;
    // A dropped kerb belongs at a real junction mouth, where the crossing is.
    let roadArms = 0;
    for (const eid of n.links) if (!this.o.graph.edges[eid].rail) roadArms++;
    const drop = roadArms > 2;
    const cslot = this._cslot ?? (this._cslot = [
      { top: 0, back: 0, nx: 0, nz: 0 },
      { top: 0, back: 0, nx: 0, nz: 0 },
    ]);
    let prev = null;
    let prevIdx = -1;
    let slot = 0;
    for (let i = 0; i < N; i++) {
      const s = ring[i];
      if (!(s.kerb && s.ci >= 0 && s.sw >= 0.05)) {
        prev = null;
        prevIdx = -1;
        continue;
      }
      const C = this._cors[s.ci];
      pl.mode = 1;
      pl.c = C;
      pl.p = s.p;
      const roadY = n.y + s.dy;
      this._blkY = roadY;
      // A blocked corner still has to have a FLOOR. In the visible world it is
      // right to emit nothing — the other corridor's pavement is drawn there.
      // In the collision world "nothing" means the sunk terrain 0.70 m down,
      // which is the trench described at SKIRT_LIP, and a junction corner is
      // exactly where a player walking round a block meets it. So the collision
      // stream lays the skirt instead and only the visible one skips.
      const blocked = this._blocked(pl, s.sw, null, Math.min(C.A.eid, C.B.eid), n.id, -1);
      if (blocked && (vis || noGapFix())) {
        prev = null;
        prevIdx = -1;
        continue;
      }
      // Distance from the nearer carriageway mouth, measured along that arm —
      // the same quantity `_kerb` feeds `kerbDrop`, so the ramp is continuous
      // across the joint instead of stepping at it.
      const dm = drop
        ? Math.min(
          Math.abs(s.r * Math.cos(s.ang - C.a0) - C.ra),
          Math.abs(s.r * Math.cos(C.a0 + C.phi - s.ang) - C.rb)
        )
        : 1e9;
      this._place(pl, 0, T);
      if (vis) {
        const h = (KERB_H + kerbSettle(T.x, T.z) - (kerbChipped(T.x, T.z) ? 0.055 : 0)) * kerbDrop(dm, true);
        const v = (C.ra + s.p * C.phi * Math.max(C.hwA, C.hwB)) * 0.4;
        const cur = this._section(pl, roadY + roadWob(T.x, T.z), h, s.sw, v, this._slot(slot++));
        if (prev && prevIdx === i - 1) this._stitch(prev, cur);
        prev = cur;
        prevIdx = i;
      } else {
        // Collision: the kerb wall and the footway top behind it. A kerb wall
        // with nothing on top of it is a corner you fall off — the only
        // collider left behind a junction was the terrain proxy, which `netgen`
        // sinks 0.55 m under the corridor, so a pedestrian standing on a
        // visible corner pavement was standing on dirt most of a metre below
        // it, and a spawn placed there dropped through the world.
        const ty = blocked ? roadY - SKIRT_LIP : roadY + KERB_COL_H * kerbDrop(dm, true);
        const cur = cslot[slot++ & 1];
        cur.top = this.col.vert(T.x, ty, T.z, 0, 1, 0, 0, 0);
        cur.nx = T.nx;
        cur.nz = T.nz;
        this._place(pl, KERB_W + s.sw, T);
        const by = blocked ? this._skirtY(T.x, T.z, roadY) : ty + s.sw * 0.02;
        cur.back = this.col.vert(T.x, by, T.z, 0, 1, 0, 0, 0);
        if (prev && prevIdx === i - 1) {
          this.col.faceQuad(colOut[i - 1], colOut[i], cur.top, prev.top, prev.nx, 0, prev.nz);
          this.col.faceQuad(prev.top, cur.top, cur.back, prev.back, 0, 1, 0);
        }
        prev = cur;
        prevIdx = i;
      }
    }
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Convex hull (monotone chain) of `pts` — flat `[x, z, idx, x, z, idx, ...]` —
 * returned as the list of `idx` in CCW order. Used to close the re-entrant
 * notches of a junction pad: the hull is the true outline of the crossing, and
 * the ring points the hull skips are exactly the ones a splayed corner necks in
 * past. Degenerate inputs (< 3 distinct points) return every idx as given.
 */
function convexHullIdx(pts) {
  const m = pts.length / 3;
  if (m < 3) { const r = []; for (let i = 0; i < m; i++) r.push(pts[i * 3 + 2]); return r; }
  const P = [];
  for (let i = 0; i < m; i++) P.push([pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]]);
  P.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const p of P) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  const hi = [];
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop();
    hi.push(p);
  }
  lo.pop();
  hi.pop();
  return lo.concat(hi).map((p) => p[2]);
}

/** An axis-aligned-ish box laid along a direction; used for sleepers. */
function box(acc, x, y, z, dx, dz, hl, hw, hh, r, g, b) {
  const rx = -dz;
  const rz = dx;
  const p = (u, v, w) => [x + dx * u + rx * v, y + w, z + dz * u + rz * v];
  const c = [
    p(-hl, -hw, hh), p(hl, -hw, hh), p(hl, hw, hh), p(-hl, hw, hh),
    p(-hl, -hw, -hh), p(hl, -hw, -hh), p(hl, hw, -hh), p(-hl, hw, -hh),
  ];
  const v = c.map((q, i) => acc.vert(q[0], q[1], q[2], 0, i < 4 ? 1 : -1, 0, q[0], q[2], r, g, b));
  acc.faceQuad(v[0], v[1], v[2], v[3], 0, 1, 0);
  acc.faceQuad(v[7], v[6], v[5], v[4], 0, -1, 0);
  acc.faceQuad(v[4], v[5], v[1], v[0], rx, 0, rz);
  acc.faceQuad(v[3], v[2], v[6], v[7], -rx, 0, -rz);
  acc.faceQuad(v[0], v[3], v[7], v[4], -dx, 0, -dz);
  acc.faceQuad(v[5], v[6], v[2], v[1], dx, 0, dz);
}

const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });
