import * as THREE from 'three';
import { Accum } from './util.js';
import {
  AIRFIELDS, ROAD_KIND, roadHalfWidth, clamp01, smootherstep, lerp,
} from './plan.js';

/**
 * WORLD — the two regional airfields, realised.
 *
 * `plan.js` has always published `AIRFIELDS` — a centre, a yaw and a
 * `runway: [length, width]` per field — and `game/freeroam` parks the flyable
 * fleet off exactly those numbers. But nothing ever BUILT them: both sites
 * were raw hillside (measured before this file existed: the af_county
 * centreline runs 65.6 m -> 88.9 m -> 26.2 m over its 600 m, af_rivers
 * 82.6 -> 95.0 -> 16.0 over 512 m), with the district street grids laid
 * straight across (20+ drivable edges strictly inside each field rect). The
 * SKYLARK spawned "on the runway" of an airport that was neither flat nor
 * paved nor visible.
 *
 * WHAT THIS FILE OWNS — the GROUND HALF of an airport, in `world`'s remit
 * (terrain, paving, static collision, surface tags):
 *
 *   1. `gradeAirfields(terrain)` — stamp a gently-graded bench into the baked
 *      heightfield under each field, fitted to the terrain along the runway
 *      axis and clamped to a runway-plausible gradient. Runs INSIDE
 *      `generateCity`, after `orientLandmarkSites` and BEFORE a single
 *      corridor is laid, so every road that crosses the field solves its node
 *      heights against the graded bench and lies flat ON it — the strips
 *      sever nothing (railsweep/drivesweep stay green by construction).
 *   2. `buildAirfieldPaving(af, ...)` — the emitted geometry: a paved runway
 *      strip with centreline dashes, threshold stripes, painted heading
 *      numbers and edge lamps; two taxiway links; a parking apron sized so
 *      the fleet freeroam parks (plane on the centreline at -0.32 L, heli at
 *      `wid/2 + 12` beside it) sits ON pavement; and an INVISIBLE collision
 *      mesh of the same quads, registered as 'asphalt' so a wheel ray and a
 *      gear ray find pavement, not dirt.
 *
 * The BUILDING half (hangars, terminal, windsock, beacon, fence) is
 * `src/buildings/airfield.js`, which reads the layout PUBLISHED here off
 * `world.airfields[i].layout` — one owner for every spatial fact, the same
 * contract as `world.landmarks[].site` (ARCHITECTURE.md rule 12's spatial
 * corollary).
 *
 * ROADS ARE NOT CUT. Unlike the six landmarks, the fields do not reserve
 * their ground: cutting 20 corridors per field (one of them the Allegheny
 * Parkway, a highway) risks exactly the islanding `lmsweep` ratchets, and the
 * assignment's contract is that the strips must not sever roads or rails. So
 * where a drivable corridor crosses a paved rect the paving YIELDS: deck,
 * paint, lamp and collision quads inside the corridor (plus kerb and footway)
 * are dropped, the road keeps its own surface and collision, and the crossing
 * reads as an old city street cut across a working strip. The graded bench is
 * what keeps that crossing drivable at speed — road and runway share one
 * plane. `src/world/airsweep.mjs` gates the result, including rolling the
 * real flight model down the emitted collision.
 */

/* ------------------------------------------------------------ constants -- */

/** Paved runway half-width, m. The Skylark spans 11.4 m; 30 m of pavement. */
const RUNWAY_HALF = 15;
/** Runway/apron deck sits this far above the graded terrain bench. */
const LIFT = 0.06;
/** Paint quads ride this far above the deck; lamps stand on the deck. */
const PAINT_LIFT = 0.028;
/** Steepest pad gradient the fit may keep. 2.2% is a plausible hill strip. */
const MAX_GRADE = 0.022;
/** Metres the graded bench blends back into the hillside over. */
const BLEND = 72;
/** Deck/collision quad size, m. The bench is planar so this is not fidelity. */
const STEP = 8;
/**
 * Extra clearance beyond a crossing corridor's kerb-and-footway line before
 * paving resumes. Wider than `buildings`' KERB_MARGIN so the guard there can
 * only fire after this has already failed.
 */
const CUT_MARGIN = 0.9;

function afDisabled() {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('noairfield') === '1') return true;
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.OW_NO_AIRFIELD === '1') return true;
  } catch { /* no process */ }
  return false;
}

/* -------------------------------------------------------------- layout --- */

/**
 * The full site layout, derived from the authored centre/yaw/runway only.
 * Rects are in field-local metres: `a` along the runway (+a is the direction
 * `freeroam`'s `along()` walks and the take-off run), `d` across it (+d is
 * `freeroam`'s `beside()` — the apron side). All published on `af.layout`.
 */
export function airfieldLayout(af) {
  const [L, W] = af.runway;
  const s = Math.sin(af.yaw);
  const c = Math.cos(af.yaw);
  const apron = { d0: W / 2 - 6, d1: W / 2 + 46, a0: 0.02 * L, a1: 0.30 * L };
  return {
    s, c, L, W,
    runway: { d0: -RUNWAY_HALF, d1: RUNWAY_HALF, a0: -L / 2, a1: L / 2 },
    apron,
    taxis: [
      { d0: RUNWAY_HALF, d1: apron.d0 + 1, a0: 0.045 * L - 6, a1: 0.045 * L + 6 },
      { d0: RUNWAY_HALF, d1: apron.d0 + 1, a0: 0.26 * L - 6, a1: 0.26 * L + 6 },
    ],
    /** The whole graded field: bench, block-drop and the fence line. */
    field: { d0: -(W / 2 + 30), d1: W / 2 + 84, a0: -(L / 2 + 36), a1: L / 2 + 36 },
    /** Where `buildings` stands its hangars/terminal, behind the apron. */
    band: { d0: W / 2 + 50, d1: W / 2 + 78 },
  };
}

/** Field-local coordinates of a world point. `out` = { a, d }. */
export function afLocal(af, x, z, out = { a: 0, d: 0 }) {
  const lay = af.layout ?? (af.layout = airfieldLayout(af));
  const dx = x - af.x;
  const dz = z - af.z;
  out.a = dx * lay.s + dz * lay.c;
  out.d = dx * lay.c - dz * lay.s;
  return out;
}

/** World point of field-local (d, a). */
export function afWorld(af, d, a, out = { x: 0, z: 0 }) {
  const lay = af.layout ?? (af.layout = airfieldLayout(af));
  out.x = af.x + lay.c * d + lay.s * a;
  out.z = af.z - lay.s * d + lay.c * a;
  return out;
}

/** Graded bench height at along-coordinate `a` (plane, flat past the ends). */
export function padY(af, a) {
  const p = af.pad;
  if (!p) return 0;
  const L = af.runway[0];
  const t = a < -L / 2 ? -L / 2 : a > L / 2 ? L / 2 : a;
  return p.yMid + p.slope * t;
}

const _lo = { a: 0, d: 0 };

/** The airfield whose FIELD rect contains (x, z), or null. */
export function airfieldAt(x, z) {
  for (const af of AIRFIELDS) {
    if (!af.pad) continue;
    const f = af.layout.field;
    afLocal(af, x, z, _lo);
    if (_lo.a >= f.a0 && _lo.a <= f.a1 && _lo.d >= f.d0 && _lo.d <= f.d1) return af;
  }
  return null;
}

/** True where (x, z) is on emitted airfield pavement (runway/taxiway/apron). */
export function airfieldPavedAt(x, z) {
  return airfieldDeckAt(x, z) !== null;
}

/**
 * Height of the paved deck at (x, z), or null off the pavement.
 *
 * THE DECK IS THE WALKABLE SURFACE ON A PAVED RECT, and `world` must say so
 * everywhere it answers a ground question, for the same reason
 * `walkableHeightAt` exists at all: the deck rides `LIFT` above the bench, so
 * anything placed from the terrain stands under the pavement. Worse, the
 * aircraft CONTACT models (heli skids, plane gear) cast their rays from the
 * contact point itself — a gear leg pressed a spring-compression under the
 * deck casts from BELOW it, misses it, finds the terrain collider 0.12 m
 * further down, and the machine comes to rest with its wheels rim-deep in the
 * pavement. MEASURED in `airsweep`'s first run: the parked RIVERHOP settled
 * with zero skid contacts and the SKYLARK sat pressed into the terrain sheet
 * under the strip. `walkableHeightAt` and the streamed terrain collider both
 * consult this so the surfaces under the deck can never out-bid it.
 */
export function airfieldDeckAt(x, z) {
  for (const af of AIRFIELDS) {
    if (!af.pad) continue;
    const lay = af.layout;
    afLocal(af, x, z, _lo);
    const f = lay.field;
    if (_lo.a < f.a0 || _lo.a > f.a1 || _lo.d < f.d0 || _lo.d > f.d1) continue;
    for (const r of [lay.runway, lay.apron, lay.taxis[0], lay.taxis[1]]) {
      if (_lo.a >= r.a0 && _lo.a <= r.a1 && _lo.d >= r.d0 && _lo.d <= r.d1) {
        return padY(af, _lo.a) + LIFT;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------- grading --- */

/**
 * Stamp the graded bench for both fields into the baked heightfield.
 *
 * Must run AFTER `terrain.bake()` and `orientLandmarkSites` (which reads the
 * raw hills) and BEFORE any corridor is laid, so roads crossing the field are
 * solved against the bench. The pad plane is a least-squares fit of the
 * PRE-GRADE terrain along the centreline with the gradient clamped to
 * `MAX_GRADE` — both authored runways point downhill, so the fit keeps a
 * gentle descending grade instead of a table top with 60 m embankments at one
 * end only.
 *
 * Two guards:
 *   - the stamp weight fades to zero within ~46 m of a waterline, so a bench
 *     shoulder can never fill a river channel;
 *   - `roadW` is raised with the stamp weight, which suppresses the terrain
 *     detail band exactly the way a road corridor does — the bench inside the
 *     field rect is EXACTLY planar, so an 8 m bilinear fetch reproduces it
 *     with zero error and the deck can sit `LIFT` above it with no poke-through.
 */
export function gradeAirfields(terrain) {
  if (afDisabled()) {
    for (const af of AIRFIELDS) {
      af.pad = null;
      af.layout = null;
      af.padYAt = null;
      af.localAt = null;
    }
    return { on: false };
  }
  for (const af of AIRFIELDS) {
    const lay = (af.layout = airfieldLayout(af));
    const { L } = lay;

    // Fit the pad plane to the raw centreline. Samples are symmetric about
    // a = 0, so the LS intercept is the plain mean.
    const N = 17;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    const w = { x: 0, z: 0 };
    for (let i = 0; i < N; i++) {
      const a = -L / 2 + (i / (N - 1)) * L;
      afWorld(af, 0, a, w);
      const h = terrain.heightAt(w.x, w.z);
      sy += h;
      sxx += a * a;
      sxy += a * h;
    }
    let slope = sxy / sxx;
    if (slope > MAX_GRADE) slope = MAX_GRADE;
    else if (slope < -MAX_GRADE) slope = -MAX_GRADE;
    af.pad = { yMid: sy / N, slope };
    // Published helpers, so `buildings` (and any other consumer of
    // `world.airfields`) reads the bench arithmetic instead of re-deriving it.
    af.padYAt = (a) => padY(af, a);
    af.localAt = (x, z, out) => afLocal(af, x, z, out);

    // Stamp. Iterate the terrain cells inside the rotated field bbox.
    const f = lay.field;
    const { cell, origin, n, grid, roadW } = terrain;
    const corners = [
      afWorld(af, f.d0 - BLEND, f.a0 - BLEND, {}),
      afWorld(af, f.d1 + BLEND, f.a0 - BLEND, {}),
      afWorld(af, f.d0 - BLEND, f.a1 + BLEND, {}),
      afWorld(af, f.d1 + BLEND, f.a1 + BLEND, {}),
    ];
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
        afLocal(af, px, pz, _lo);
        // Signed distance outside the field rect (0 inside).
        const qa = Math.max(f.a0 - _lo.a, _lo.a - f.a1, 0);
        const qd = Math.max(f.d0 - _lo.d, _lo.d - f.d1, 0);
        const dist = Math.hypot(qa, qd);
        if (dist >= BLEND) continue;
        let wgt = dist <= 0 ? 1 : 1 - smootherstep(dist / BLEND);
        // Never bench into a river: fade out approaching any waterline.
        const wd = terrain.waterDist(px, pz);
        wgt *= clamp01((wd - 12) / 34);
        if (wgt <= 0.002) continue;
        const k = row + i;
        grid[k] = lerp(grid[k], padY(af, _lo.a), wgt);
        if (wgt > roadW[k]) roadW[k] = wgt;
      }
    }
  }
  return { on: true };
}

/**
 * Pull road-graph node heights onto the bench across the paved zone.
 *
 * Node heights are solved from the (benched) terrain, but `limitGrades` /
 * `relaxHeights` then smooth along each route, and a street descending the
 * surrounding hill onto the bench drags some of that hill with it — MEASURED
 * before this pass: crossings up to 1.34 m off the pad plane, which is a
 * humpback the SKYLARK hits at 40 m/s on its take-off roll. Runs after
 * `buildGraph` and BEFORE `rasteriseRoads`, so the corridor height field, the
 * terrain sink, the road mesh and the corridor floor all inherit the level
 * crossing. Blend fades over ~56 m outside the paved union so no new step is
 * created at the field edge (the terrain there is the bench anyway).
 */
export function levelAirfieldRoads(graph) {
  const lo = { a: 0, d: 0 };
  for (const af of AIRFIELDS) {
    if (!af.pad) continue;
    const lay = af.layout;
    const f = lay.field;
    const rects = [lay.runway, lay.apron, lay.taxis[0], lay.taxis[1]];
    for (const nd of graph.nodes) {
      if (!nd || nd.pin || nd.pinned) continue;
      afLocal(af, nd.x, nd.z, lo);
      if (lo.a < f.a0 - 60 || lo.a > f.a1 + 60 || lo.d < f.d0 - 60 || lo.d > f.d1 + 60) continue;
      let dist = Infinity;
      for (const r of rects) {
        const qa = Math.max(r.a0 - lo.a, lo.a - r.a1, 0);
        const qd = Math.max(r.d0 - lo.d, lo.d - r.d1, 0);
        const dd = Math.hypot(qa, qd);
        if (dd < dist) dist = dd;
      }
      // Full weight to 24 m past the pavement, then fade: a crossing edge
      // often has its nearest node just OFF the strip, and a half-levelled
      // node there interpolates a hump back across the deck.
      const w = 1 - smootherstep((dist - 24) / 44);
      if (w <= 0) continue;
      nd.y += (padY(af, lo.a) - nd.y) * w;
    }
  }
}

/* -------------------------------------------------------------- paving --- */

/**
 * True where paving must yield to a crossing drivable corridor: within the
 * corridor's kerb-and-footway line plus `CUT_MARGIN` of any non-rail edge.
 * Rail also cuts — ballast through a paved apron is as real a surface clash
 * as a carriageway (neither field has rail today; cheap future-proofing).
 */
export function corridorCutAt(roads, x, z, extra = 0) {
  const ne = roads.nearestEdge(x, z, 46);
  const e = ne.edge;
  if (!e) return false;
  const k = ROAD_KIND[e.kind] ?? ROAD_KIND.street;
  const lim = roadHalfWidth(e.kind, e.lanes) + 0.33 + (k.sidewalk ?? 0) + CUT_MARGIN + extra;
  return ne.dist <= lim;
}

const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });
const _w = { x: 0, z: 0 };

/**
 * Build one airfield's emitted paving.
 *
 * @param {object} af    an `AIRFIELDS` entry that has been graded
 * @param {object} opts  { terrain, roads, mat } — `mat(key)` maps a
 *                       `world/palette.js` key to a THREE.Material. The
 *                       headless gate passes a stub; `world/index.js` passes
 *                       the road mesh's own palette lookup.
 * @returns {{group: THREE.Group, colMesh: THREE.Mesh, stats: object}|null}
 */
export function buildAirfieldPaving(af, { terrain, roads, mat }) {
  if (afDisabled() || !af.pad || !af.layout) return null;
  const lay = af.layout;
  const col = new Accum(`af_col_${af.id}`);
  const deck = new Accum(`af_deck_${af.id}`);
  const apron = new Accum(`af_apron_${af.id}`);
  const paint = new Accum(`af_paint_${af.id}`);
  const lamps = new Accum(`af_lamp_${af.id}`);
  const cut = (d, a, extra = 0) => {
    afWorld(af, d, a, _w);
    return corridorCutAt(roads, _w.x, _w.z, extra);
  };

  /** One paved rect: deck + collision quads on the bench, skirted, hole-cut. */
  const pave = (r, acc) => {
    const nA = Math.max(1, Math.round((r.a1 - r.a0) / STEP));
    const nD = Math.max(1, Math.round((r.d1 - r.d0) / STEP));
    const va = (d, a) => {
      afWorld(af, d, a, _w);
      const y = padY(af, a) + LIFT;
      return {
        deck: acc.vert(_w.x, y, _w.z, 0, 1, 0, _w.x * 0.11, _w.z * 0.11, 0, 0.38, 0.12),
        col: col.vert(_w.x, y, _w.z, 0, 1, 0, 0, 0),
      };
    };
    // Vertex grid is shared per column pair so the deck is watertight; a quad
    // whose centre lies in a crossing corridor is simply not emitted.
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
    // Perimeter skirt, dropped 0.55 m and flared 0.4 m out: hides the deck
    // edge where the bench blend or a crossing corridor sinks the dirt.
    const skirt = (d0, a0, d1, a1) => {
      const len = Math.hypot(d1 - d0, a1 - a0);
      const nS = Math.max(1, Math.round(len / STEP));
      // Outward normal in field space (rect perimeter walked CCW).
      const ox = (a1 - a0) / len;
      const oz = -(d1 - d0) / len;
      let pv = null;
      for (let i = 0; i <= nS; i++) {
        const t = i / nS;
        const d = d0 + (d1 - d0) * t;
        const a = a0 + (a1 - a0) * t;
        afWorld(af, d, a, _w);
        const yT = padY(af, a) + LIFT;
        const top = acc.vert(_w.x, yT, _w.z, 0, 1, 0, _w.x * 0.11, _w.z * 0.11, 0, 0.4, 0.2);
        afWorld(af, d + ox * 0.4, a + oz * 0.4, _w);
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

  pave(lay.runway, deck);
  pave(lay.apron, apron);
  for (const t of lay.taxis) pave(t, apron);

  /** A painted rect on the runway (field-local), hole-cut like the deck. */
  const mark = (dc, ac, wD, wA) => {
    if (cut(dc, ac, 0.6)) return;
    const y = (d, a) => padY(af, a) + LIFT + PAINT_LIFT;
    const v = (d, a) => {
      afWorld(af, d, a, _w);
      return paint.vert(_w.x, y(d, a), _w.z, 0, 1, 0, _w.x * 0.7, _w.z * 0.7, 0, 0.25, 0);
    };
    paint.faceQuad(
      v(dc - wD / 2, ac - wA / 2), v(dc + wD / 2, ac - wA / 2),
      v(dc + wD / 2, ac + wA / 2), v(dc - wD / 2, ac + wA / 2), 0, 1, 0
    );
  };

  const { L } = lay;
  // Centreline dashes: 12 m on, 12 m off, clear of both thresholds.
  for (let a = -L / 2 + 34; a + 12 <= L / 2 - 34; a += 24) mark(0, a + 6, 0.9, 12);
  // Threshold stripes: six bars each end (the "piano keys").
  for (const end of [-1, 1]) {
    const a = end * (L / 2 - 16);
    for (let i = 0; i < 6; i++) {
      const d = (i - 2.5) * 3.4;
      mark(d, a, 1.3, 11);
    }
  }
  // Heading numbers, one per end, read on approach. Seven-segment strokes.
  const yawDeg = ((Math.atan2(lay.s, lay.c) * 180) / Math.PI + 360) % 360;
  const hdg = Math.round(yawDeg / 10) || 36;
  const recip = ((hdg + 17) % 36) + 1;
  const SEG = {
    // seg: [dcx, acy, wD, wA] in digit-local units (digit is 4 wide, 7 tall)
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
  for (const end of [-1, 1]) {
    // Rolling out in +a you cross the -a threshold, which is painted with the
    // +a heading; the far end carries the reciprocal.
    const txt = String(end < 0 ? hdg : recip).padStart(2, '0');
    const aBase = end * (L / 2 - 30);
    for (let ch = 0; ch < 2; ch++) {
      const dc = (ch - 0.5) * 6 * -end; // read correctly from the approach
      for (const sName of DIGIT[+txt[ch]] ?? []) {
        const [sd, sa, sw, sh] = SEG[sName];
        mark(dc + sd * -end, aBase + sa * end, sw, sh);
      }
    }
  }

  // Edge and threshold lamps: low boxes just off the pavement edge.
  const lampGeo = new THREE.BoxGeometry(0.24, 0.3, 0.24);
  const m4 = new THREE.Matrix4();
  const putLamp = (d, a) => {
    if (cut(d, a, 0.8)) return;
    afWorld(af, d, a, _w);
    m4.makeTranslation(_w.x, padY(af, a) + LIFT + 0.15, _w.z);
    lamps.add(lampGeo, m4);
  };
  for (let a = -L / 2 + 10; a <= L / 2 - 10; a += 36) {
    putLamp(-(RUNWAY_HALF + 1), a);
    putLamp(RUNWAY_HALF + 1, a);
  }
  for (const end of [-1, 1]) {
    for (let i = -2; i <= 2; i++) putLamp(i * 4.4, end * (L / 2 + 1.4));
  }
  lampGeo.dispose();

  /* ---- meshes -------------------------------------------------------- */
  const group = new THREE.Group();
  group.name = `airfield_${af.id}`;
  group.matrixAutoUpdate = false;
  let tris = 0;
  const emit = (acc, key, opts = {}) => {
    if (acc.empty) return;
    const geo = acc.build();
    const mesh = new THREE.Mesh(geo, mat(key));
    mesh.name = `af_${key}_${af.id}`;
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
  emit(deck, 'runway');
  emit(apron, 'apron_slab', { surface: 'concrete' });
  emit(paint, 'runway_paint', { order: 1 });
  emit(lamps, 'runway_lamp', { surface: 'glass' });

  let colMesh = null;
  if (!col.empty) {
    colMesh = new THREE.Mesh(col.build(), INVISIBLE);
    colMesh.name = `af_col_${af.id}`;
    colMesh.visible = false;
    colMesh.matrixAutoUpdate = false;
    colMesh.userData.surface = 'asphalt';
  }
  return { group, colMesh, stats: { tris } };
}
