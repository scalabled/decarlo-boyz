import * as THREE from 'three';
import {
  Accum, box, cyl, lathe, tube, catenary, combine, weather, newTrs,
  clamp01, lerp, TAU, hash3i,
} from './geom.js';

/**
 * PROPS — the overhead network.
 *
 * THE ANCHOR RULE. A critic on an earlier build found wires "terminating in a
 * small grey cube attached to nothing". That is not a rendering bug, it is an
 * authoring bug: a span was drawn between two computed points without checking
 * that anything was actually built at either end. So the rule here is
 * structural, not a runtime check that can be forgotten —
 *
 *   `polesOnEdge(edge)` is a PURE function of the edge. It returns the complete,
 *   ordered list of poles that exist on that edge, having already dropped every
 *   candidate that fails (water, junction pad, bridge, no district appetite for
 *   overhead plant). Spans are then only ever generated BETWEEN CONSECUTIVE
 *   ENTRIES OF THAT LIST. A span therefore cannot exist unless both of its
 *   anchors exist, and if a pole is dropped its two spans vanish with it.
 *
 * Everything else here is about sag. Real conductors hang; how much depends on
 * span, tension, temperature and what the conductor is. A primary at 2 % and a
 * telephone drop at 6 % on the same poles is most of what makes a street of
 * wires read as wires rather than as a wireframe.
 */

/** Poles are wanted every 32-46 m; the exact spacing is per-edge. */
const POLE_SPACING = 38;

function P(K, id, factory, surface, opts) {
  K.proto(id, factory, surface, opts);
  return id;
}

/* ====================================================================== */
/* PROTOTYPES                                                             */
/* ====================================================================== */

/** A ceramic insulator: three stacked skirts on a pin. */
function insulator(scale = 1) {
  const g = lathe([
    [0.014, 0], [0.014, 0.05], [0.042, 0.06], [0.030, 0.075],
    [0.048, 0.088], [0.032, 0.104], [0.052, 0.118], [0.020, 0.135],
    [0.024, 0.155], [0, 0.16],
  ], 7);
  g.scale(scale, scale, scale);
  return g;
}

function utilityPole(h, seed, opts = {}) {
  const parts = [];
  const lean = (hash3i(seed, 3, 1) - 0.5) * 0.05;
  const pts = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    pts.push({ x: lean * h * t * t, y: t * h, z: (hash3i(seed, i, 2) - 0.5) * 0.06 * t });
  }
  parts.push([tube(pts, 0.135, 7, { taper: 0.72, mg: 0.6 }), null]);
  // the split top cap
  parts.push([lathe([[0.098, 0], [0.098, 0.03], [0.05, 0.08], [0, 0.1]], 7), newTrs(lean * h, h, 0)]);

  // crossarms: one, or two on the busier poles
  const arms = opts.arms ?? 1;
  for (let k = 0; k < arms; k++) {
    const ay = h - 0.35 - k * 0.85;
    const ax = lean * h * ((ay / h) ** 2);
    parts.push([box(2.45, 0.10, 0.115), newTrs(ax, ay, 0)]);
    // knee braces
    parts.push([box(0.65, 0.035, 0.035), newTrs(ax - 0.30, ay - 0.22, 0.07, 0, 1, 1, 1, 0, 0.62)]);
    parts.push([box(0.65, 0.035, 0.035), newTrs(ax + 0.30, ay - 0.22, 0.07, 0, 1, 1, 1, 0, -0.62)]);
  }
  // pole steps, one side, alternating
  for (let i = 0; i < 5; i++) {
    parts.push([cyl(0.012, 0.012, 0.22, 4),
      newTrs(lean * h * 0.4, 2.2 + i * 0.6, 0, 0, 1, 1, 1, 0, Math.PI / 2)]);
  }
  const g = combine(parts, 'utilpole');
  weather(g, { grimeBase: 0.6, grimeHeight: 3.0, wear: 0.7, seed, up: 0.35 });
  return g;
}

export function registerWireKit(K) {
  // Three pole heights x two arm counts. The layout picks by district and seed.
  const HS = [8.2, 9.4, 10.6];
  HS.forEach((h, i) => {
    P(K, `pole_${i}_1`, () => utilityPole(h, 2000 + i, { arms: 1 }), 'wood_grey');
    P(K, `pole_${i}_2`, () => utilityPole(h, 2100 + i, { arms: 2 }), 'wood_grey');
    P(K, `pole_${i}_ins1`, () => {
      const parts = [];
      for (const x of [-1.0, -0.34, 0.34, 1.0]) parts.push([insulator(1), newTrs(x, h - 0.30, 0)]);
      return combine(parts, 'ins');
    }, 'glass_prop', { castShadow: false });
    P(K, `pole_${i}_ins2`, () => {
      const parts = [];
      for (const x of [-1.0, -0.34, 0.34, 1.0]) {
        parts.push([insulator(1), newTrs(x, h - 0.30, 0)]);
        parts.push([insulator(0.9), newTrs(x, h - 1.15, 0)]);
      }
      return combine(parts, 'ins2');
    }, 'glass_prop', { castShadow: false });
    // A pole-mounted distribution transformer, on some poles only.
    P(K, `pole_${i}_xfmr`, () => {
      const parts = [];
      parts.push([cyl(0.31, 0.31, 0.82, 10), newTrs(0.32, h - 2.6, 0)]);
      parts.push([lathe([[0.31, 0], [0.33, 0.03], [0.26, 0.08], [0.09, 0.11], [0, 0.12]], 10), newTrs(0.32, h - 1.78, 0)]);
      parts.push([box(0.12, 0.9, 0.10), newTrs(0.03, h - 2.62, 0)]);
      for (const s of [-1, 1]) {
        parts.push([cyl(0.03, 0.035, 0.20, 6), newTrs(0.32 + s * 0.14, h - 1.68, 0)]);
        parts.push([insulator(0.55), newTrs(0.32 + s * 0.14, h - 1.62, 0)]);
      }
      // the cutout fuse and its stalk
      parts.push([box(0.05, 0.42, 0.05), newTrs(-0.22, h - 1.5, 0.05, 0, 1, 1, 1, 0, 0.25)]);
      const g = combine(parts, 'xfmr');
      weather(g, { grimeBase: 0.8, grimeHeight: 8.0, wear: 0.8, seed: 2200 + i, up: 0.6 });
      return g;
    }, 'galv');
  });

  /** A trolley-line span pole: a steel column with a bracket arm. */
  P(K, 'trolley_pole', () => {
    const parts = [];
    parts.push([cyl(0.085, 0.13, 8.4, 10), null]);
    parts.push([lathe([[0.10, 0], [0.13, 0.04], [0.09, 0.10], [0.04, 0.16], [0, 0.18]], 8), newTrs(0, 8.4, 0)]);
    parts.push([box(0.13, 0.13, 0.9), newTrs(0, 7.55, 0.42)]);
    parts.push([tube([{ x: 0, y: 6.6, z: 0.10 }, { x: 0, y: 7.5, z: 0.78 }], 0.028, 5), null]);
    parts.push([box(0.24, 0.30, 0.06), newTrs(0, 1.2, 0.14)]);
    const g = combine(parts, 'trolleypole');
    weather(g, { grimeBase: 0.7, grimeHeight: 3.0, wear: 0.7, seed: 2301 });
    return g;
  }, 'pole_dark');

  /**
   * THE ANCHOR at the building end of a service drop. This exists so the drop
   * has something authored to land on — see the anchor rule at the top.
   */
  P(K, 'wire_bracket', () => {
    const parts = [];
    parts.push([box(0.10, 0.34, 0.06), newTrs(0, 0, 0.03)]);
    parts.push([tube([{ x: 0, y: 0.24, z: 0.05 }, { x: 0, y: 0.30, z: 0.32 }], 0.018, 5), null]);
    parts.push([insulator(0.7), newTrs(0, 0.28, 0.34)]);
    parts.push([box(0.16, 0.06, 0.05), newTrs(0, -0.16, 0.03)]);
    parts.push([box(0.07, 0.62, 0.05), newTrs(0.0, -0.52, 0.02)]);
    const g = combine(parts, 'wirebracket');
    weather(g, { grimeBase: 0.75, grimeHeight: 6.0, wear: 0.8, seed: 2401 });
    return g;
  }, 'galv');

  /** A junction box / drip loop cluster at the bottom of a drop. */
  P(K, 'wire_junction', () => {
    const parts = [];
    parts.push([box(0.20, 0.26, 0.10), newTrs(0, 0, 0.05)]);
    parts.push([cyl(0.028, 0.028, 0.5, 6), newTrs(0.0, -0.5, 0.05)]);
    const g = combine(parts, 'wirejunction');
    weather(g, { grimeBase: 0.8, grimeHeight: 5.0, wear: 0.7, seed: 2411 });
    return g;
  }, 'galv');
}

/* ====================================================================== */
/* THE POLE FIELD — pure, deterministic, and the source of anchor truth    */
/* ====================================================================== */

/**
 * The complete ordered set of poles on one road edge. Pure: same edge in, same
 * list out, from any tile, in any order, forever. Every span in the city is
 * generated from consecutive entries of one of these lists, which is what makes
 * "no wire without two authored anchors" true by construction.
 *
 * @returns {Array<{x,y,z,s,side,seed,variant,arms,xfmr,light}>}
 */
export function polesOnEdge(graph, edge, world, styleOf, out = []) {
  out.length = 0;
  if (edge.rail || edge.bridge || edge.kind === 'highway') return out;
  const na = graph.nodes[edge.a];
  const nb = graph.nodes[edge.b];
  const L = edge.len;
  if (L < 18) return out;

  const eSeed = (edge.id * 2654435761) >>> 0;
  const spacing = POLE_SPACING * (0.82 + hash3i(eSeed, 0, 1) * 0.42);
  const inset = 7 + hash3i(eSeed, 1, 1) * 5;
  const usable = L - inset * 2;
  if (usable < spacing * 0.5) return out;
  const n = Math.max(1, Math.round(usable / spacing));
  const step = usable / n;

  // Which side of the street the plant runs down. It never swaps mid-block.
  const side = hash3i(eSeed, 2, 1) < 0.5 ? -1 : 1;
  const lateral = edge.width * 0.5 + 1.55 + hash3i(eSeed, 3, 1) * 0.7;

  for (let i = 0; i <= n; i++) {
    const s = inset + i * step;
    const t = s / L;
    const x = na.x + (nb.x - na.x) * t - edge.dz * lateral * side;
    const z = na.z + (nb.z - na.z) * t + edge.dx * lateral * side;

    // --- the culls. A pole that fails any of these does not exist, and its
    // --- two spans go with it.
    if (world.isWater?.(x, z)) continue;
    const st = styleOf(x, z);
    if (!st || st.wires <= 0.05) continue;
    const seed = (eSeed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
    if (hash3i(seed, 9, 3) > st.wires) continue;

    const y = na.y + (nb.y - na.y) * t;
    const gy = world.heightAt ? Math.max(world.heightAt(x, z), y - 0.6) : y;
    const variant = hash3i(seed, 4, 1) < 0.34 ? 0 : hash3i(seed, 4, 1) < 0.74 ? 1 : 2;
    out.push({
      x, y: Math.min(gy, y + 0.35), z, s, side, seed, variant,
      arms: hash3i(seed, 5, 1) < 0.30 ? 2 : 1,
      xfmr: hash3i(seed, 6, 1) < 0.22,
      light: hash3i(seed, 7, 1) < 0.30,
      edge,
    });
  }
  return out;
}

const POLE_H = [8.2, 9.4, 10.6];

/** The world-space height of a pole's crossarm, for span endpoints. */
export function armHeight(pole, k = 0) {
  return pole.y + POLE_H[pole.variant] - 0.30 - k * 0.85;
}

/* ====================================================================== */
/* SPANS                                                                  */
/* ====================================================================== */

const _pts = [];

/**
 * Build the conductor bundle of one span into `acc`.
 *
 * Six wires on a distribution span, and no two of them hang the same: the
 * primaries are tight (1.6-2.6 % of span), the neutral a shade looser, and the
 * telecom bundle underneath is slack enough to be obvious (4-7 %). That spread
 * is what a photograph of a real American street shows and it is the single
 * cheapest thing that makes an overhead network look right.
 */
export function buildSpan(acc, a, b, seed, opts = {}) {
  const ax = a.x;
  const az = a.z;
  const bx = b.x;
  const bz = b.z;
  const span = Math.hypot(bx - ax, bz - az);
  if (span < 4 || span > 90) return 0;

  // The crossarm runs across the street, so the conductors sit at offsets along
  // the arm's own axis, not along the road.
  const dx = (bx - ax) / span;
  const dz = (bz - az) / span;
  const rx = -dz;
  const rz = dx;

  let tris = 0;
  const segs = span > 34 ? 12 : span > 20 ? 9 : 7;
  const arms = Math.min(a.arms, b.arms);

  const line = (ox, ay, by, sagPct, r, mg) => {
    const sag = span * sagPct;
    catenary(ax + rx * ox, ay, az + rz * ox, bx + rx * ox, by, bz + rz * ox, sag, segs, _pts);
    const g = tube(_pts, r, 3, { mg });
    acc.add(g, null);
    tris += (g.getIndex()?.count ?? 0) / 3;
    g.dispose();
  };

  // primaries on the top arm
  const ya = armHeight(a, 0) + 0.14;
  const yb = armHeight(b, 0) + 0.14;
  for (let i = 0; i < 3; i++) {
    const ox = [-1.0, 0, 1.0][i];
    line(ox, ya, yb, 0.016 + hash3i(seed, i, 1) * 0.011, 0.021, 0.5);
  }
  // the fourth pin: a spare / street-lighting circuit
  line(-1.0 + 2.0 * (hash3i(seed, 8, 1) > 0.5 ? 1 : 0), ya - 0.02, yb - 0.02,
    0.020 + hash3i(seed, 4, 1) * 0.012, 0.018, 0.55);

  if (arms > 1) {
    const y2a = armHeight(a, 1) + 0.14;
    const y2b = armHeight(b, 1) + 0.14;
    for (let i = 0; i < 3; i++) {
      line([-1.0, 0, 1.0][i], y2a, y2b, 0.021 + hash3i(seed, i + 10, 1) * 0.013, 0.019, 0.5);
    }
  }

  // the neutral, on the pole itself, well below the arm
  const nA = armHeight(a, 0) - 1.55;
  const nB = armHeight(b, 0) - 1.55;
  line(0, nA, nB, 0.026 + hash3i(seed, 5, 1) * 0.014, 0.020, 0.6);

  // telecom: two lashed bundles, slack, with a spiral wrap read as thickness
  const cA = nA - 0.62;
  const cB = nB - 0.62;
  line(-0.10, cA, cB, 0.042 + hash3i(seed, 6, 1) * 0.030, 0.032, 0.75);
  if (opts.telecom !== false && hash3i(seed, 7, 1) > 0.3) {
    line(0.14, cA - 0.34, cB - 0.34, 0.050 + hash3i(seed, 11, 1) * 0.032, 0.028, 0.8);
  }
  return tris;
}

/**
 * A service drop: pole to an authored wall bracket. Two conductors twisted
 * together, with the drip loop every real drop has at the house end.
 */
export function buildDrop(acc, pole, wx, wy, wz, seed) {
  const ax = pole.x;
  const ay = armHeight(pole, 0) - 1.55;
  const az = pole.z;
  const span = Math.hypot(wx - ax, wz - az);
  if (span < 2 || span > 40) return 0;
  let tris = 0;
  for (let i = 0; i < 2; i++) {
    const off = (i - 0.5) * 0.06;
    catenary(ax, ay - i * 0.05, az, wx, wy - i * 0.05, wz, span * (0.055 + hash3i(seed, i, 1) * 0.035), 8, _pts);
    for (const p of _pts) {
      p.x += off * 0.5;
      p.z += off * 0.5;
    }
    // the drip loop: the last two points dive below the bracket and come back
    _pts.push({ x: wx + (wx - ax) / span * 0.10, y: wy - 0.34, z: wz + (wz - az) / span * 0.10 });
    _pts.push({ x: wx + (wx - ax) / span * 0.18, y: wy - 0.12, z: wz + (wz - az) / span * 0.18 });
    const g = tube(_pts, 0.014, 3, { mg: 0.7 });
    acc.add(g, null);
    tris += (g.getIndex()?.count ?? 0) / 3;
    g.dispose();
  }
  return tris;
}

/** A guy wire from high on a pole down to an anchor rod in the ground. */
export function buildGuy(acc, pole, dirX, dirZ, seed) {
  const top = armHeight(pole, 0) - 0.4;
  const reach = 3.4 + hash3i(seed, 1, 5) * 1.8;
  const gx = pole.x + dirX * reach;
  const gz = pole.z + dirZ * reach;
  const g = tube([
    { x: pole.x, y: top, z: pole.z },
    { x: lerp(pole.x, gx, 0.5), y: lerp(top, pole.y + 0.1, 0.5) + 0.05, z: lerp(pole.z, gz, 0.5) },
    { x: gx, y: pole.y + 0.05, z: gz },
  ], 0.018, 3, { mg: 0.6 });
  acc.add(g, null);
  const tris = (g.getIndex()?.count ?? 0) / 3;
  g.dispose();
  return tris;
}

/**
 * A trolley contact wire strung across the street between two authored poles,
 * with the two running wires hung from it. Downtown and the Strip only.
 */
export function buildTrolley(acc, a, b, seed) {
  const span = Math.hypot(b.x - a.x, b.z - a.z);
  if (span < 8 || span > 40) return 0;
  let tris = 0;
  const ya = a.y + 7.55;
  const yb = b.y + 7.55;
  catenary(a.x, ya, a.z, b.x, yb, b.z, span * 0.035, 10, _pts);
  const cross = _pts.map((p) => ({ ...p }));
  let g = tube(cross, 0.014, 3, { mg: 0.55 });
  acc.add(g, null);
  tris += (g.getIndex()?.count ?? 0) / 3;
  g.dispose();
  // two contact wires hanging under it, offset along the span
  const dx = (b.x - a.x) / span;
  const dz = (b.z - a.z) / span;
  for (const o of [0.36, 0.62]) {
    const px = lerp(a.x, b.x, o);
    const pz = lerp(a.z, b.z, o);
    const py = lerp(ya, yb, o) - span * 0.035 * 0.9 - 0.55;
    const along = 14;
    g = tube([
      { x: px - dz * along, y: py - 0.10, z: pz + dx * along },
      { x: px, y: py, z: pz },
      { x: px + dz * along, y: py - 0.10, z: pz - dx * along },
    ], 0.012, 3, { mg: 0.5 });
    acc.add(g, null);
    tris += (g.getIndex()?.count ?? 0) / 3;
    g.dispose();
    // the hanger
    g = tube([
      { x: px, y: lerp(ya, yb, o) - span * 0.035 * 0.9, z: pz },
      { x: px, y: py, z: pz },
    ], 0.008, 3, { mg: 0.5 });
    acc.add(g, null);
    tris += (g.getIndex()?.count ?? 0) / 3;
    g.dispose();
  }
  return tris;
}
