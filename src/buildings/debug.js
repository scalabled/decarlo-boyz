import { Rng } from '../core/rng.js';
import { DISTRICTS } from './palette.js';

/**
 * BUILDINGS — synthetic lots.
 *
 * A stand-in for the `world` lot stream while `world` is being rewritten in
 * parallel. It emits the EXACT `Lot` shape documented in ARCHITECTURE.md
 * through the same `world:tile:load` handler, so nothing downstream of it
 * knows the difference — and the moment `world` exposes `lotsInTile()` this
 * file stops being used.
 *
 * The district geography is the real one from DESIGN.md (legacy coordinates
 * multiplied by four), so a synthetic capture of Lawrenceville is looking at
 * the same brick rowhouses the shipped city will put there.
 */

export const SYNTH_TILE = 96;
const S = 4; // DESIGN.md: multiply every legacy coordinate by 4

/** id, x, z, radius — DESIGN.md district table, scaled to world metres. */
export const DISTRICT_GEO = [
  ['point', -168, 4, 62],
  ['downtown', -58, 16, 100],
  ['strip', 62, -46, 86],
  ['lawren', 170, -138, 96],
  ['northsh', -40, -150, 104],
  ['troy', 130, -258, 90],
  ['southside', 40, 152, 108],
  ['mtwash', -132, 116, 92],
  ['steelrow', 196, 96, 100],
  ['westend', -258, 92, 96],
  ['northside', -246, -142, 92],
  ['hazel', 246, -14, 86],
].map(([id, x, z, r]) => ({ id, x: x * S, z: z * S, r: r * S }));

/** Nearest district, weighted by how far inside its radius the point sits. */
export function districtAt(x, z) {
  let best = null;
  let bestScore = Infinity;
  for (const d of DISTRICT_GEO) {
    const dist = Math.hypot(x - d.x, z - d.z);
    const score = dist / d.r;
    if (score < bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best ? best.id : 'lawren';
}

/** The lot kind a district mostly wants, before the archetype weighting. */
function kindFor(id, rng, ringDepth) {
  const s = DISTRICTS[id];
  if (!s) return 'block';
  if (id === 'downtown') return rng.float() < 0.62 ? 'tower' : 'block';
  if (id === 'steelrow' || id === 'southside') return rng.float() < 0.7 ? 'industrial' : 'block';
  if (id === 'mtwash' || id === 'troy') return rng.float() < 0.85 ? 'house' : 'block';
  if (id === 'westend' || id === 'northside') return rng.float() < 0.55 ? 'house' : 'block';
  if (id === 'lawren') return rng.float() < 0.35 ? 'shop' : 'block';
  if (id === 'strip') return rng.float() < 0.4 ? 'industrial' : 'shop';
  if (id === 'point') return 'park';
  return 'block';
}

/**
 * One tile: a perimeter block with lots facing the four streets, which is how
 * a real block subdivides and what makes a street wall rather than a scatter
 * of freestanding boxes.
 */
export function syntheticLots(tx, tz, opts = {}) {
  if (opts.exhaustive) return exhaustiveLots();
  const x0 = tx * SYNTH_TILE;
  const z0 = tz * SYNTH_TILE;
  const road = 15;
  const bx0 = x0 + road;
  const bz0 = z0 + road;
  const span = SYNTH_TILE - road * 2;
  const seed = (Math.imul(tx | 0, 0x27d4eb2d) ^ Math.imul(tz | 0, 0x165667b1)) >>> 0;
  const rng = new Rng(seed || 7);
  const lots = [];

  const cx = bx0 + span / 2;
  const cz = bz0 + span / 2;
  const id = districtAt(cx, cz);
  const style = DISTRICTS[id] ?? DISTRICTS.lawren;
  if (id === 'point' && rng.float() < 0.75) return lots;

  // depth of the perimeter ring, and the frontage width of each lot
  const depth = style.tall > 0.8 ? 34 : style.tall > 0.5 ? 26 : 18;
  const wide = style.tall > 0.8 ? 34 : style.tall > 0.5 ? 22 : 9;

  const sides = [
    { ax: bx0, az: bz0, bx: bx0 + span, bz: bz0, nx: 0, nz: -1 },
    { ax: bx0 + span, az: bz0, bx: bx0 + span, bz: bz0 + span, nx: 1, nz: 0 },
    { ax: bx0 + span, az: bz0 + span, bx: bx0, bz: bz0 + span, nx: 0, nz: 1 },
    { ax: bx0, az: bz0 + span, bx: bx0, bz: bz0, nx: -1, nz: 0 },
  ];

  let n = 0;
  for (const s of sides) {
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const len = Math.hypot(dx, dz);
    const ux = dx / len;
    const uz = dz / len;
    const count = Math.max(1, Math.round(len / wide));
    const w = len / count;
    for (let i = 0; i < count; i++) {
      const t0 = i * w + 0.35;
      const t1 = (i + 1) * w - 0.35;
      const d = depth * rng.range(0.82, 1.06);
      // outward is -normal (the block's outside face is the street)
      const ox = s.nx;
      const oz = s.nz;
      const p0 = [s.ax + ux * t0, s.az + uz * t0];
      const p1 = [s.ax + ux * t1, s.az + uz * t1];
      const q1 = [p1[0] - ox * d, p1[1] - oz * d];
      const q0 = [p0[0] - ox * d, p0[1] - oz * d];
      const foot = [p0, p1, q1, q0];
      const kind = kindFor(id, rng, depth);
      if (kind === 'park') continue;
      lots.push({
        id: `s${tx}_${tz}_${n++}`,
        tx,
        tz,
        footprint: foot,
        frontage: [p0, p1],
        district: id,
        height: 0,
        floors: 0,
        kind,
        seed: (seed ^ Math.imul(n + 1, 0x9e3779b9)) >>> 0,
      });
    }
  }
  return lots;
}

export function syntheticTiles(tx, tz) {
  const x0 = tx * SYNTH_TILE;
  const z0 = tz * SYNTH_TILE;
  return {
    tx,
    tz,
    lots: syntheticLots(tx, tz),
    bounds: { x0, z0, x1: x0 + SYNTH_TILE, z1: z0 + SYNTH_TILE },
  };
}

/**
 * Every district crossed with every lot kind — the set `prewarmMaterials`
 * builds so no material can compile lazily during play.
 */
function exhaustiveLots() {
  const kinds = ['tower', 'block', 'shop', 'house', 'industrial'];
  const lots = [];
  let i = 0;
  let x = 0;
  for (const id of Object.keys(DISTRICTS)) {
    for (const kind of kinds) {
      const w = 16;
      const d = 14;
      x += 40;
      lots.push({
        id: `pw${i}`,
        tx: 0,
        tz: 0,
        footprint: [
          [x, 0],
          [x + w, 0],
          [x + w, d],
          [x, d],
        ],
        frontage: [
          [x, 0],
          [x + w, 0],
        ],
        district: id,
        height: 0,
        floors: kind === 'tower' ? 14 : 4,
        kind,
        seed: (0x1234 + i * 7919) >>> 0,
      });
      i++;
    }
  }
  return lots;
}
