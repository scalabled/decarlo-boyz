import { DISTRICT_BY_ID, LANDMARKS, TILE, lerp, clamp01 } from './plan.js';

/**
 * WORLD — block subdivision.
 *
 * Turns the blocks `netgen` cut out of the street grid into the `Lot` records
 * `buildings` consumes (ARCHITECTURE.md):
 *
 *   { id, tx, tz, footprint:[x,z][], frontage:[[ax,az],[bx,bz]],
 *     district, height, floors, kind, seed }
 *
 * Rules of thumb baked in here, because they are what makes a skyline read:
 *   - a lot always fronts a street; the frontage edge is the one facing it
 *   - lot width follows the district (9 m rowhouses, 40 m mill sheds)
 *   - the Golden Triangle gets deep, wide lots so towers have a footprint
 *   - every district reserves some blocks for parks and surface parking, which
 *     is what stops a procedural city reading as solid extruded mass
 */

const KIND_HEIGHT = {
  tower: [46, 168],
  block: [12, 34],
  shop: [8, 17],
  house: [6, 11],
  industrial: [9, 26],
  park: [0, 0],
  lot: [0, 0],
};

/** Lot depth and frontage width per district family. */
const SUBDIV = {
  downtown: { depth: 46, width: [26, 54], park: 0.05, park2: 0.07 },
  grid: { depth: 30, width: [11, 24], park: 0.06, park2: 0.10 },
  hill: { depth: 24, width: [9, 16], park: 0.09, park2: 0.08 },
  mill: { depth: 62, width: [34, 78], park: 0.05, park2: 0.16 },
  park: { depth: 40, width: [22, 44], park: 0.62, park2: 0.12 },
};

/**
 * Lateral setback from the side boundary, per kind, metres.
 *
 * WHY A TOWER NEEDS ONE AND A ROWHOUSE DOES NOT. Lots inside a block were laid
 * edge to edge with no gap at all — 1646 neighbouring pairs across the city
 * touching within 5 cm — which is exactly right for a Lawrenceville terrace,
 * where the party wall IS the boundary, and exactly wrong for a glass tower,
 * whose entire facade is then buried by whatever the neighbour extrudes.
 * `buildings` measured the symptom from the other side: far-LOD glazing tagged
 * emissive leaked through in slivers only, roughly 95% occluded by masonry
 * standing in front of it, and guessed a neighbouring flank about 20 cm off the
 * tower face. Measured here: 10 of the 18 tower-adjacent lot pairs in the city
 * stood closer than 0.6 m and one of them at 0.18 m.
 */
const SIDE_SETBACK = { tower: 1.4, block: 0.35, industrial: 0.6, shop: 0, house: 0, park: 0, lot: 0 };

/**
 * How much of a lot may be covered by a lot that was accepted before it.
 *
 * BLOCKS CAN OVERLAP, AND SO THEREFORE CAN LOTS. Twelve district grids are laid
 * on twelve different angles and the connectors are drawn straight through all
 * of them (see `netgen`'s dedup note); `subdivideBlock` is a pure function of
 * ONE block and has never been able to see that another block already claimed
 * the same ground. Measured over the whole city before this check: 600
 * overlapping lot pairs, 146 692 m2 of doubled ground, and a worst case of
 * 1.00 — lot 14 lying entirely inside lot 912 at (-230, 415). A building on
 * each of those is a building inside a building, and the taller one wins every
 * pixel of the shorter one's facade.
 */
const MAX_COVER = 0.25;

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

/** Force counter-clockwise winding in the XZ plane (positive signed area). */
function ccw(poly) {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

/** Sutherland-Hodgman: the part of `subject` inside convex CCW `window`. */
function clipPoly(subject, win) {
  let out = subject;
  for (let i = 0; i < win.length && out.length; i++) {
    const a = win[i];
    const b = win[(i + 1) % win.length];
    const side = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const inp = out;
    out = [];
    for (let k = 0; k < inp.length; k++) {
      const P = inp[k];
      const Q = inp[(k + 1) % inp.length];
      const dp = side(P);
      const dq = side(Q);
      if (dp >= 0) out.push(P);
      if (dp >= 0 !== dq >= 0) {
        const t = dp / (dp - dq);
        out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
      }
    }
  }
  return out;
}

/**
 * A hash grid of accepted footprints, so a lot can ask whether the ground it
 * wants is already someone's. Rebuilt per `subdivide` call.
 */
class LotIndex {
  constructor() {
    this.cell = 48;
    this.map = new Map();
  }

  _key(x, z) {
    return (x * 73856093) ^ (z * 19349663);
  }

  _bounds(poly) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const p of poly) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < z0) z0 = p[1];
      if (p[1] > z1) z1 = p[1];
    }
    return [x0, x1, z0, z1];
  }

  /** True when `poly` is more than `MAX_COVER` on top of an accepted lot. */
  covered(poly, area) {
    const [x0, x1, z0, z1] = this._bounds(poly);
    const c = this.cell;
    const seen = new Set();
    for (let z = Math.floor(z0 / c); z <= Math.floor(z1 / c); z++) {
      for (let x = Math.floor(x0 / c); x <= Math.floor(x1 / c); x++) {
        const list = this.map.get(this._key(x, z));
        if (!list) continue;
        for (const other of list) {
          if (seen.has(other)) continue;
          seen.add(other);
          const inter = Math.abs(signedArea(clipPoly(poly.slice(), other.poly)));
          if (inter > MAX_COVER * Math.min(area, other.area)) return true;
        }
      }
    }
    return false;
  }

  add(poly, area) {
    const [x0, x1, z0, z1] = this._bounds(poly);
    const c = this.cell;
    const rec = { poly, area };
    for (let z = Math.floor(z0 / c); z <= Math.floor(z1 / c); z++) {
      for (let x = Math.floor(x0 / c); x <= Math.floor(x1 / c); x++) {
        const k = this._key(x, z);
        let list = this.map.get(k);
        if (!list) this.map.set(k, (list = []));
        list.push(rec);
      }
    }
  }
}

let _lotId = 0;

/**
 * @param {object[]} blocks from netgen
 * @param {Terrain} terrain
 * @param {Rng} rng
 * @returns {{ lots: Lot[], byTile: Map<string, Lot[]> }}
 */
export function subdivide(blocks, terrain, rng) {
  const lots = [];
  const index = new LotIndex();
  for (const b of blocks) subdivideBlock(b, terrain, rng, lots, index);

  const byTile = new Map();
  for (const l of lots) {
    const key = `${l.tx},${l.tz}`;
    let list = byTile.get(key);
    if (!list) byTile.set(key, (list = []));
    list.push(l);
  }
  return { lots, byTile };
}

function subdivideBlock(b, terrain, rng, out, index) {
  const d = DISTRICT_BY_ID[b.district];
  const sub = SUBDIV[b.kind] ?? SUBDIV.grid;
  const yaw = b.yaw ?? 0;
  const ca = Math.cos(yaw);
  const sa = Math.sin(yaw);
  const L2W = (u, v) => [b.cx + u * ca - v * sa, b.cz + u * sa + v * ca];

  const W = b.w;
  const D = b.d;
  if (W < 14 || D < 12) return;

  // Whole-block uses: a park, a surface car park, or a single big footprint.
  const roll = rng.float();
  if (roll < sub.park) {
    push(out, b, d, ccw([L2W(-W / 2, -D / 2), L2W(W / 2, -D / 2), L2W(W / 2, D / 2), L2W(-W / 2, D / 2)]),
      [L2W(-W / 2, -D / 2), L2W(W / 2, -D / 2)], 'park', 0, terrain, rng, index);
    return;
  }
  if (roll < sub.park + sub.park2) {
    push(out, b, d, ccw([L2W(-W / 2, -D / 2), L2W(W / 2, -D / 2), L2W(W / 2, D / 2), L2W(-W / 2, D / 2)]),
      [L2W(-W / 2, -D / 2), L2W(W / 2, -D / 2)], 'lot', 0, terrain, rng, index);
    return;
  }

  // How deep a lot can be before the block needs two back-to-back rows.
  const depth = Math.min(sub.depth, D * 0.5 - 1);
  const twoRow = D > depth * 2 + 8;

  const rows = twoRow ? [-1, 1] : [0];
  for (const side of rows) {
    // v-extent of this row and which edge is the street frontage
    let v0;
    let v1;
    let frontV;
    if (side === 0) {
      v0 = -D / 2;
      v1 = D / 2;
      frontV = -D / 2;
    } else if (side < 0) {
      v0 = -D / 2;
      v1 = -D / 2 + depth;
      frontV = -D / 2;
    } else {
      v0 = D / 2 - depth;
      v1 = D / 2;
      frontV = D / 2;
    }

    let u = -W / 2;
    let guard = 0;
    while (u < W / 2 - 6 && guard++ < 64) {
      let w = rng.range(sub.width[0], sub.width[1]);
      const remain = W / 2 - u;
      if (remain - w < sub.width[0] * 0.8) w = remain;
      const u0 = u;
      const u1 = u + w;
      u = u1 + (b.kind === 'hill' ? 0 : rng.float() < 0.10 ? rng.range(3, 9) : 0);

      // Nothing is a perfect rectangle: nudge the back line and shave a corner.
      // The rng is drawn in exactly the order it always was — the setback is
      // applied afterwards — so the city plan does not reshuffle under the
      // other subsystems for the sake of a 1.4 m gap.
      const back = frontV === v0 ? v1 - rng.range(0, 3.2) : v0 + rng.range(0, 3.2);
      const shaveR = rng.range(0, 1.6);
      const shaveL = rng.range(0, 1.6);
      const fv = frontV;
      const area = Math.abs(w * (back - fv));
      const kind = pickKind(b, d, area, rng);
      // Side setback, so a tower's facade is not somebody else's party wall.
      // Never enough to leave a slot too thin to build on.
      const g = Math.min(SIDE_SETBACK[kind] ?? 0, Math.max(0, (u1 - u0 - 5) / 2));
      const a0 = u0 + g;
      const a1 = u1 - g;
      const poly = ccw([
        L2W(a0, fv),
        L2W(a1, fv),
        L2W(a1 - shaveR, back),
        L2W(a0 + shaveL, back),
      ]);
      const frontage = [L2W(a0, fv), L2W(a1, fv)];
      push(out, b, d, poly, frontage, kind, area, terrain, rng, index);
    }
  }
}

function pickKind(b, d, area, rng) {
  const r = rng.float();
  switch (b.kind) {
    case 'downtown':
      return area > 1500 && r < 0.55 ? 'tower' : 'block';
    case 'mill':
      return r < 0.82 ? 'industrial' : 'block';
    case 'hill':
      return r < 0.86 ? 'house' : 'shop';
    case 'park':
      return r < 0.5 ? 'park' : 'house';
    default:
      if (r < 0.30) return 'shop';
      if (r < 0.86) return 'block';
      return 'house';
  }
}

const TOWER_FOCUS = LANDMARKS.find((l) => l.id === 'lm_tower');

function push(out, b, d, poly, frontage, kind, area, terrain, rng, index) {
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p[0];
    cz += p[1];
  }
  cx /= poly.length;
  cz /= poly.length;
  if (terrain.waterDist(cx, cz) < 4) return;
  // One piece of ground, one lot. See the note on MAX_COVER — this is the only
  // place in the plan that can see two blocks at once, so it is the only place
  // the question can be asked.
  const foot = Math.abs(signedArea(poly));
  if (index) {
    if (index.covered(poly, foot)) return;
    index.add(poly, foot);
  }

  const range = KIND_HEIGHT[kind] ?? KIND_HEIGHT.block;
  let height = 0;
  if (range[1] > 0) {
    const tall = d?.tall ?? 0.4;
    let t = rng.float();
    t *= t * 0.6 + 0.4; // skew low; a few tall ones carry the skyline
    if (kind === 'tower') {
      // Height falls off from the Steel Tower, so downtown has a real peak
      // instead of a plateau of identical boxes.
      const dd = Math.hypot(cx - TOWER_FOCUS.x, cz - TOWER_FOCUS.z);
      const focus = 1 - clamp01(dd / 460);
      t = clamp01(t * 0.55 + focus * focus * 0.75);
    }
    height = lerp(range[0], range[1], t) * (0.55 + tall * 0.62);
    // Bigger footprint carries more mass.
    height *= 0.82 + clamp01(area / 1400) * 0.45;
  }
  const floors = height > 0 ? Math.max(1, Math.round(height / 3.65)) : 0;

  const id = _lotId++;
  out.push({
    id,
    tx: Math.floor(cx / TILE),
    tz: Math.floor(cz / TILE),
    footprint: poly,
    frontage,
    district: b.district,
    height,
    floors,
    kind,
    seed: (Math.imul(id + 1, 0x9e3779b1) ^ 0x5bf03635) >>> 0,
    // Extras beyond the contract — free for `buildings` to use or ignore.
    cx,
    cz,
    y: terrain.heightAt(cx, cz),
    area,
    yaw: b.yaw ?? 0,
    wealth: d?.wealth ?? 0.5,
    density: d?.density ?? 0.5,
    tint: d?.tint ?? [0.38, 0.36, 0.34],
  });
}

export function resetLotIds() {
  _lotId = 0;
}
