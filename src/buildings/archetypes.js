import * as THREE from 'three';
import {
  polyPrism,
  polyInset,
  polyCentroid,
  polyBounds,
  polyArea,
  clipHalfPlane,
  chamferBox,
  plainBox,
  quad,
  cylinderY,
  moulding,
  fillMasks,
  weather,
  trs,
  fbm3,
} from './geom.js';
import { Kit } from './kit.js';
import { buildElevation, makeProgramme, outwardNormal, wallBasis } from './facade.js';
import { archetypeFor, districtStyle, surfaceTagOf } from './palette.js';

/**
 * BUILDINGS — archetypes.
 *
 * A `Lot` from `world` comes in, a building goes out. The plan is computed
 * first (massing, setbacks, floor table, facade programme) and BOTH levels of
 * detail are generated from that same plan, so the near mesh and the far mesh
 * are the same building — a silhouette that changes shape when you walk toward
 * it is worse than no LOD at all.
 */

const _m = new THREE.Matrix4();
/** Wall basis for the collision shell; never live across a `_m` user. */
const _shell = new THREE.Matrix4();
const _n = [0, 0];
const TAU = Math.PI * 2;

/** Deterministic per-lot stream. */
function lotRng(RngCtor, seed) {
  return new RngCtor((seed ?? 1) >>> 0);
}

// ------------------------------------------------------------------ plan --
/**
 * The dressing palette a whole block shares. Derived from the tile, not the
 * lot, so it is stable for every building on it. See makeProgramme.
 */
const PAINTS = [
  'paint_red',
  'paint_green',
  'paint_blue',
  'paint_teal',
  'paint_cream',
  'paint_black',
  'paint_ochre',
  'paint_slag',
];

export function blockPalette(RngCtor, seed, style) {
  const r = new RngCtor((seed ^ 0x5eed17) >>> 0);
  // Three shopfront colours per block. Every unit picks one of the three: enough
  // that no two neighbours match, few enough that a tile does not pay eight
  // extra merged batches for it.
  const paints = [];
  while (paints.length < 3) {
    const c = r.pick(PAINTS);
    if (!paints.includes(c)) paints.push(c);
  }
  return {
    paints,
    /** A whole block is either a shopping street or a residential one. */
    commercial: r.float() < 0.5,
    trim: r.pick(['trim_white', 'trim_dark', 'trim_green', 'alu_dark', 'timber_dark']),
    techTrim: r.pick(['alu_dark', 'trim_dark', 'alu_bright']),
    sillMat: r.pick(['stone_grey', 'stone_warm', 'precast']),
    signMat: r.pick(['sign_board', 'trim_dark', 'trim_red', 'trim_green']),
    awning: r.pick(['awning_canvas', 'awning_green', 'awning_navy']),
    neon: r.pick(['neon_amber', 'neon_teal', 'neon_red']),
    door: r.pick(['door_wood', 'door_paint']),
    roof: r.pick(style.roof),
    glass: r.pick(style.glass),
  };
}

export function planBuilding(lot, style, rng, block = null) {
  const arch = archetypeFor(rng, lot.kind, style);
  let foot = normaliseFootprint(lot);
  const c = polyCentroid(foot);
  /**
   * Nothing in a real street is square to anything else. Half a degree of yaw
   * and a few centimetres of slump are invisible on one building and are the
   * whole difference between a terrace and a row of clones.
   */
  const yaw = rng.range(-0.011, 0.011);
  if (yaw !== 0) {
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    foot = foot.map(([px, pz]) => {
      const dx = px - c[0];
      const dz = pz - c[1];
      return [c[0] + dx * cs - dz * sn, c[1] + dx * sn + dz * cs];
    });
  }
  const b = polyBounds(foot);

  // Frontage direction and which side of the lot the street is on.
  let fx = 1;
  let fz = 0;
  let frontDir = [1, 0];
  if (lot.frontage && lot.frontage.length === 2) {
    const [a, bb] = lot.frontage;
    const dx = bb[0] - a[0];
    const dz = bb[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    frontDir = [dx / l, dz / l];
    fx = (a[0] + bb[0]) / 2 - c[0];
    fz = (a[1] + bb[1]) / 2 - c[1];
  } else {
    fx = b.cx - c[0] || 1;
    fz = 0;
  }
  const fl = Math.hypot(fx, fz) || 1;
  const toStreet = [fx / fl, fz / fl];

  const prog = makeProgramme(rng, style, arch, { block });
  prog.style = style;

  // Floors. `world` is authoritative when it says how tall the lot is.
  const districtTall = style.tall ?? 0.4;
  let floors = lot.floors ?? 0;
  let height = lot.height ?? 0;
  if (!floors) {
    if (!height) {
      const base = arch === 'curtain' || arch === 'tower' ? 60 : arch === 'mill' ? 22 : 14;
      height = base * (0.45 + districtTall) * rng.range(0.65, 1.4);
    }
    floors = Math.max(1, Math.round((height - prog.groundH) / prog.floorH) + 1);
  }
  // Hillside timber houses are two or three storeys, never nine.
  const cap = arch === 'curtain' || arch === 'tower' ? 62 : arch === 'house' ? 3 : arch === 'deco' ? 22 : 9;
  floors = Math.max(1, Math.min(cap, floors));
  height = prog.groundH + (floors - 1) * prog.floorH;

  // --- massing: setbacks -------------------------------------------------
  const volumes = [];
  const tall = arch === 'curtain' || arch === 'tower' || arch === 'deco';

  /**
   * ERA. A downtown is not one generation of building, and the era is what
   * decides the crown, the plan and the rhythm at the same time — which is why
   * it is decided ONCE here rather than three times in three places.
   *
   * The critic finding this exists to answer is "silhouettes are near-identical
   * rectangular prisms; a skyline should have variety in height, footprint,
   * crown and era". Steel City's downtown really would be: a handful of 1900s
   * masonry towers with heavy cornices, a 1930s deco set-back cluster with
   * ziggurat crowns, the 1970s slabs that replaced the mills' offices, and two
   * or three 1990s postmodern hats.
   */
  const era = tall
    ? arch === 'deco'
      ? 'deco'
      : rng.pick(['deco', 'midcentury', 'modern', 'modern', 'postmodern'])
    : 'plain';
  if (tall) prog.era = era;

  /**
   * The plan itself. A chamfered or shaved plan costs nothing at runtime and is
   * the difference between a skyline and a bar chart, because it changes the
   * SILHOUETTE — the one property that survives every LOD, every distance and
   * every weather state.
   */
  if (tall && rng.float() < 0.62) foot = shapePlan(foot, rng, era);

  const setbacks = tall && floors > 12 ? rng.int(1, 3) : tall && floors > 7 ? rng.int(0, 1) : 0;

  let poly = foot;
  let y = 0;
  let remaining = floors;
  const nVol = setbacks + 1;
  for (let v = 0; v < nVol; v++) {
    const share =
      v === nVol - 1 ? remaining : Math.max(2, Math.round(remaining * rng.range(0.42, 0.68)));
    const n = Math.min(remaining, share);
    const fl2 = [];
    for (let i = 0; i < n; i++) {
      const isGround = v === 0 && i === 0;
      fl2.push({
        y: 0,
        h: isGround ? prog.groundH : prog.floorH,
        kind: isGround ? 'ground' : i === n - 1 && v === nVol - 1 ? 'top' : 'upper',
      });
    }
    const h = fl2.reduce((s, f) => s + f.h, 0);
    volumes.push({ poly, y0: y, h, floors: fl2, level: v });
    y += h + (v < nVol - 1 ? prog.parapet + 0.2 : 0);
    remaining -= n;
    if (remaining <= 0) break;
    /**
     * ASYMMETRIC setbacks. `polyInset` alone is a concentric shrink, and a
     * stack of concentric shrinks is a wedding cake seen from directly above —
     * from the street it is a perfectly centred telescope, which no real tower
     * is. A deco tower steps back off its street frontages and runs its rear
     * elevation straight up the lot line; a modern one puts the whole setback
     * on one face. Shaving one or two sides after the inset produces both, and
     * the polygon stays convex so the wall normals stay honest.
     */
    poly = polyInset(poly, rng.range(1.0, 2.4));
    const extra = era === 'deco' ? rng.int(1, 2) : rng.int(0, 2);
    for (let s2 = 0; s2 < extra; s2++) {
      poly = shaveSide(poly, rng.range(0, TAU), rng.range(1.2, 4.0));
    }
  }

  // A stepped crown on the tallest towers: the thing that gives a skyline a
  // profile instead of a row of ruled lines.
  const crowns = [];
  const topVol = volumes[volumes.length - 1];
  let cp = topVol.poly;
  let cy = topVol.y0 + topVol.h + prog.parapet;
  if (tall && floors > 13) {
    if (era === 'deco') {
      // The wedding cake: three or four hard steps, each shorter than the last.
      const steps = rng.int(2, 4);
      let hh = rng.range(4.0, 7.0);
      for (let i = 0; i < steps; i++) {
        cp = polyInset(cp, rng.range(1.5, 3.0));
        if (cp.length < 3) break;
        crowns.push({ poly: cp, y0: cy, h: hh, kind: 'step' });
        cy += hh;
        hh *= rng.range(0.62, 0.82);
      }
    } else if (era === 'postmodern') {
      // A hat: one broad chamfered drum, then a pyramid over it.
      cp = polyInset(cp, rng.range(0.8, 1.8));
      const hh = rng.range(3.5, 6.0);
      crowns.push({ poly: cp, y0: cy, h: hh, kind: 'step' });
      cy += hh;
      crowns.push({ poly: polyInset(cp, 0.6), y0: cy, h: rng.range(6, 13), kind: 'pyramid' });
      cy += 0;
    } else if (era === 'midcentury') {
      // The open lantern: a colonnade of piers with a cap slab over it, lit
      // from inside after dark. This is the one that reads from Mt Washington.
      cp = polyInset(cp, rng.range(1.6, 3.2));
      const hh = rng.range(5.0, 9.0);
      crowns.push({ poly: cp, y0: cy, h: hh, kind: 'lantern' });
      cy += hh;
    } else {
      // Modern: no decorative crown at all — the whole read is the mechanical
      // penthouse and the mast, which buildTopWorks adds to every tower.
      if (rng.float() < 0.45) {
        cp = polyInset(cp, rng.range(2.2, 4.5));
        const hh = rng.range(3.0, 5.5);
        crowns.push({ poly: cp, y0: cy, h: hh, kind: 'step' });
        cy += hh;
      }
    }
  }

  const top = volumes[volumes.length - 1];
  const lastCrown = crowns[crowns.length - 1];
  /**
   * What sits on the roof, decided in the PLAN so both LOD meshes build the
   * same silhouette from the same numbers. A flat-topped box reads as a
   * placeholder at any distance, and unlike a facade this is not something a
   * distance LOD may drop: it IS the outline.
   */
  const roofY = lastCrown ? lastCrown.y0 + lastCrown.h : top.y0 + top.h;
  const roofPoly = lastCrown ? lastCrown.poly : top.poly;
  const rb = polyBounds(roofPoly);
  const works = {
    y: roofY,
    poly: roofPoly,
    mech: null,
    bulk: null,
    mast: 0,
    tanks: 0,
  };
  if (tall && Math.min(rb.w, rb.d) > 6) {
    works.mech = {
      w: rb.w * rng.range(0.34, 0.62),
      d: rb.d * rng.range(0.34, 0.62),
      h: rng.range(3.4, 6.4),
      dx: rb.w * rng.range(-0.1, 0.1),
      dz: rb.d * rng.range(-0.1, 0.1),
    };
    works.bulk = { w: rng.range(2.6, 4.2), d: rng.range(2.4, 3.6), h: rng.range(2.6, 4.0) };
    works.tanks = rng.int(0, 3);
    // Aircraft warning masts belong on the genuinely tall ones. A 30 m mast on
    // an eight-storey block is the tell that the generator has one recipe.
    works.mast = floors > 22 ? rng.range(10, 26) : floors > 15 ? rng.range(4, 11) : 0;
  } else if (!tall && Math.min(rb.w, rb.d) > 7 && rng.float() < 0.55) {
    works.bulk = { w: rng.range(2.2, 3.4), d: rng.range(2.0, 3.0), h: rng.range(2.3, 3.2) };
  }

  /**
   * The opaque glazing key both LODs use for window fields and crown recesses.
   * Picked once so the near mesh, the far mesh and the crown cannot disagree,
   * and kept to two variants city-wide because every distinct surface in a tile
   * is one more merged draw call.
   */
  const glazeKey = /bronze|grimy/.test(prog.glass) ? 'glass_solid_warm' : 'glass_solid';

  return {
    arch,
    prog,
    style,
    era,
    glazeKey,
    foot,
    volumes,
    crowns,
    works,
    toStreet,
    frontDir,
    centroid: c,
    bounds: b,
    floors,
    height: roofY + prog.parapet + (works.mech?.h ?? 0) + works.mast,
    pitched: arch === 'house' && rng.float() < 0.85,
    yaw,
  };
}

/**
 * Cut a convex plan back on ONE side.
 *
 * `angle` is the direction the shaved face looks in; `amount` is how far the
 * supporting line moves inwards. Convexity is preserved, so `outwardNormal`'s
 * centroid test stays valid on every resulting edge — which is the reason this
 * is a half-plane clip rather than the L- and U-plans the review asked for. A
 * reflex corner flips the sign of that test and turns one elevation inside out,
 * and a facade facing into its own building is a much louder defect than a
 * missing light well.
 */
function shaveSide(poly, angle, amount) {
  if (!poly || poly.length < 3) return poly;
  const nx = Math.cos(angle);
  const nz = Math.sin(angle);
  let sup = -Infinity;
  for (const p of poly) sup = Math.max(sup, nx * p[0] + nz * p[1]);
  const out = clipHalfPlane(poly, -nx, -nz, -(sup - amount));
  return out.length >= 3 && Math.abs(polyArea(out)) > 20 ? out : poly;
}

/**
 * Give a tower plan a shape other than "the lot".
 *
 * Chamfered and shaved plans are what make a downtown silhouette legible: an
 * octagonal shaft catches the sun on two faces instead of one, and a plan
 * shaved on one side gives the tower a narrow and a broad elevation, so it
 * changes width as you drive around it. Both are convex, both cost four
 * vertices, and both survive to the impostor tier.
 */
function shapePlan(foot, rng, era) {
  const b = polyBounds(foot);
  const small = Math.min(b.w, b.d);
  if (small < 9) return foot;
  let p = foot;
  const roll = rng.float();
  if (roll < 0.45 || era === 'deco') {
    // Chamfer: cut the four diagonals. Deco towers were nearly always chamfered
    // or stepped at the corner, and a chamfer is what stops a 60 m shaft from
    // reading as an extruded rectangle from every single angle.
    const c = small * rng.range(0.1, 0.22);
    for (let i = 0; i < 4; i++) {
      p = shaveSide(p, Math.PI * 0.25 + (i * Math.PI) / 2, c);
    }
  } else if (roll < 0.78) {
    // One long shaved face: gives the tower a front and a flank.
    p = shaveSide(p, rng.range(0, TAU), small * rng.range(0.12, 0.26));
  } else {
    // Two adjacent shaves — a wedge plan, the one that never reads as a box.
    const a = rng.range(0, TAU);
    p = shaveSide(p, a, small * rng.range(0.1, 0.2));
    p = shaveSide(p, a + Math.PI / 2, small * rng.range(0.08, 0.18));
  }
  return p.length >= 3 ? p : foot;
}

function normaliseFootprint(lot) {
  let foot = lot.footprint;
  if (!Array.isArray(foot) || foot.length < 3) {
    const w = lot.w ?? 18;
    const d = lot.d ?? 14;
    const x = lot.x ?? 0;
    const z = lot.z ?? 0;
    foot = [
      [x - w / 2, z - d / 2],
      [x + w / 2, z - d / 2],
      [x + w / 2, z + d / 2],
      [x - w / 2, z + d / 2],
    ];
  }
  // Drop degenerate edges — a 4 cm sliver produces a wall panel that costs a
  // full ExtrudeGeometry and covers nothing.
  const out = [foot[0]];
  for (let i = 1; i < foot.length; i++) {
    const p = out[out.length - 1];
    if (Math.hypot(foot[i][0] - p[0], foot[i][1] - p[1]) > 0.35) out.push(foot[i]);
  }
  if (out.length >= 3) {
    const a = out[0];
    const z = out[out.length - 1];
    if (Math.hypot(a[0] - z[0], a[1] - z[1]) < 0.35) out.pop();
  }
  if (out.length < 3) return foot;
  if (polyArea(out) < 0) out.reverse();
  return out;
}

/**
 * THE NEGATIVE CONTROL SWITCH, and the only thing that reads it is a probe.
 *
 * Set `volumeShell` false and collision reverts, exactly, to what the city
 * shipped: the facade kit authors it per elevation and the ground floor's
 * glazed openings are holes in the hull. `src/buildings/solidprobe.mjs
 * --legacy` flips this and nothing else, and its run is only counted as a
 * control if the SEALED and SOLID gates go red under it.
 */
export const collisionOpts = { volumeShell: true };

/**
 * THE COLLISION SHELL OF ONE MASSING VOLUME.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS HERE AND NOT IN THE FACADE
 * ─────────────────────────────────────────────────────────────────────────────
 * Collision used to be authored by the FACADE KIT, one `slabBox` per elevation
 * plus, on the ground floor, `solidSlabs(len, h, holes)` — the rectangles left
 * over once the openings were cut. That is exactly right for a DOOR and exactly
 * wrong for everything else the kit calls an opening, because the ground floor's
 * "holes" are the shopfront, the lobby colonnade's glazed bays and the mill's
 * loading dock: 5-10 m of GLASS, cut out of the collision hull as if it were
 * fresh air. The upshot was a city whose ground storey is missing its walls
 * wherever it is glazed — which is most of it.
 *
 * MEASURED by `solidprobe.mjs` over every lot in the city — 1521 buildings,
 * 23 147 bearings, a man-capsule swept inward against the shell alone with the
 * DRAWN massing as ground truth. Percentage of bearings on which something
 * stopped him:
 *
 *   ground floor   archetype     as shipped    with this shell
 *   lobby          tower             73.3%          100.0%
 *   lobby          deco              75.0%          100.0%
 *   lobby          curtain           75.5%           99.5%
 *   dock           warehouse         77.8%           98.9%
 *   dock           mill              83.7%           99.1%
 *   lobby          pavilion          89.4%          100.0%
 *   shop/stoop     block             95.0%          100.0%
 *   shop           market            95.0%          100.0%
 *   shop/stoop     rowhouse          97.2%           99.9%
 *   ---            all              93.04%          98.47%
 *
 * The ordering is the whole diagnosis: it tracks the GROUND-FLOOR STYLE and
 * nothing else. The three that open onto a colonnade of glazed bays were the
 * worst in the city, the two that open onto a loading dock next, and the two
 * that are mostly solid masonry at street level barely moved. On many of those
 * bearings the capsule was not merely late, it never hit anything at all: in
 * through one glazed bay and out of the one opposite. That is the report
 * `src/peds/coverprobe.mjs` raised as "42 of ~60 crossings failed a solidity
 * test", and it is not an archetype forgetting to call something — it is
 * collision being derived from the picture's HOLES instead of the building's
 * MASS.
 *
 * So the shell is now a property of the MASSING, authored here, once, from the
 * volume polygon that every archetype emits — the same polygon `buildElevation`
 * hangs its wall on, through the same `wallBasis`, so the proxy's outer face is
 * the drawn wall's outer face to the centimetre. An archetype cannot join the
 * city without one, because a volume without a polygon is not a building.
 *
 * It also costs a THIRTIETH of what it replaces: one box per edge per volume
 * instead of one box plus a ground-floor fragment per pier, per mullion and per
 * dock opening. Measured on one house, 1428 collision triangles before and 48
 * after, and that is BVH every character query walks.
 *
 * There are no enterable interiors in this game — a "doorway" in the hull led
 * into an unlit hollow shell, which is the defect, not the feature.
 */
function volumeShell(T, plan, vol, groundY) {
  const poly = vol.poly;
  const c = polyCentroid(poly);
  const t = plan.prog.wallT;
  const surface = surfaceTagOf(plan.prog.masonry);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    // Mirror `buildElevation` exactly: an edge it refuses to build a wall on
    // must not get a collider either, or the player is stopped by nothing.
    // Two 0.68 m capsules cannot pass through the sub-0.6 m notch that leaves.
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.6) continue;
    outwardNormal(a[0], a[1], b[0], b[1], c[0], c[1], _n);
    const len = wallBasis(_shell, a[0], a[1], b[0], b[1], _n[0], _n[1], groundY + vol.y0, t);
    T.slabBox(surface, _shell, 0, vol.h / 2, len, vol.h, t);
  }
}

// -------------------------------------------------------------- full LOD --
export function buildLot(T, lib, plan, rng, groundY = 0) {
  const { prog, volumes, crowns } = plan;
  const partyWalls = plan.arch === 'rowhouse' || plan.arch === 'block';

  for (const vol of volumes) {
    const poly = vol.poly;
    const c = polyCentroid(poly);
    /**
     * The shell goes down FIRST, so that when the kerb guard drops a wall
     * standing in a live carriageway it drops the proxy with it and records the
     * removal once, rather than leaving an invisible slab across the road.
     */
    if (collisionOpts.volumeShell) volumeShell(T, plan, vol, groundY);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      outwardNormal(a[0], a[1], b[0], b[1], c[0], c[1], _n);
      const dotStreet = _n[0] * plan.toStreet[0] + _n[1] * plan.toStreet[1];
      const front = dotStreet > 0.45;
      const side = Math.abs(dotStreet) < 0.55;
      const blank = partyWalls && side && vol.level === 0 && rng.float() < 0.8;

      buildElevation(T, lib, {
        ax: a[0],
        az: a[1],
        bx: b[0],
        bz: b[1],
        nx: _n[0],
        nz: _n[1],
        y0: groundY + vol.y0,
        floors: vol.floors,
        prog,
        rng,
        style: plan.style,
        front,
        blank,
        blankSurface: prog.masonry,
        /**
         * The facade kit no longer authors collision: `volumeShell` above owns
         * it for the whole volume. Leaving both on would double every wall in
         * the BVH and re-open the glazed holes at the same time.
         */
        collide: !collisionOpts.volumeShell,
      });
    }

    // roof deck of this volume
    const deck = polyPrism(poly, 0.35);
    trs(_m, 0, groundY + vol.y0 + vol.h - 0.35, 0, 0);
    T.addOnce(prog.roof, deck, _m, { masks: [0.35, 0.5, 0.25] });
  }

  buildCrowns(T, lib, plan, rng, groundY);
  buildTopWorks(T, lib, plan, rng, groundY, true);
  buildPlinth(T, plan, groundY, prog.sillMat ?? 'stone_grey');
  if (plan.pitched) buildPitchedRoof(T, lib, plan, rng, groundY);
  if (plan.arch === 'mill' || plan.arch === 'warehouse') dressIndustrial(T, lib, plan, rng, groundY);
  dressRoof(T, lib, plan, rng, groundY);
}

// ---------------------------------------------------------------- crowns --
/**
 * The top forty metres of a tower.
 *
 * WHAT THIS FIXES. The critic finding was, verbatim, "no setbacks, no crown, no
 * roof plant, no mechanical penthouse, no parapet" and "a flat-topped box reads
 * as a placeholder". It was accurate: a crowned tower was a stack of plain
 * inset prisms with a band round the top, and — because `dressRoof` skipped any
 * volume that had a crown over it — a crowned tower was also the ONE class of
 * building in the city that got no roof furniture at all. The taller the
 * building, the emptier its roof.
 *
 * Everything here is SILHOUETTE, so it goes in the static bucket, it is built
 * identically by both LODs, and it is never dropped by a distance test. A crown
 * that appears when you walk towards it is worse than no crown.
 */
function buildCrowns(T, lib, plan, rng, groundY) {
  const { prog, crowns } = plan;
  const stone = prog.sillMat ?? 'stone_grey';
  for (const cr of crowns) {
    if (cr.kind === 'pyramid') {
      // A postmodern hat. Four sides, so it is a hard-edged pitched cap, not a
      // cone — the silhouette that made a 1990s tower recognisable at 2 km.
      const b = polyBounds(cr.poly);
      const r = Math.max(b.w, b.d) * 0.5;
      const g = cylinderY(r * 1.06, cr.h, 4, { rTop: 0.35 });
      trs(_m, b.cx, groundY + cr.y0 + cr.h * 0.5, b.cz, Math.PI * 0.25, 1, 1, 1);
      T.addOnce(rng.float() < 0.4 ? 'roof_metal' : prog.masonry, g, _m, {
        masks: [0.4, 0.35, 0.2],
      });
      // the finial the pyramid comes to
      const f = cylinderY(0.28, 2.6, 6);
      trs(_m, b.cx, groundY + cr.y0 + cr.h + 1.3, b.cz, 0, 1, 1, 1);
      T.addOnce(stone, f, _m, { masks: [0.5, 0.3, 0.2] });
      continue;
    }

    if (cr.kind === 'lantern') {
      /**
       * An open crown: a colonnade of piers carrying a cap slab, with the plant
       * deck visible through it. This is the crown that reads best at range,
       * because the sky comes THROUGH it — a silhouette with a hole in it is
       * unmistakably a building and unmistakably not a box.
       */
      const b = polyBounds(cr.poly);
      const cap = polyPrism(polyInset(cr.poly, -0.5), 1.0);
      trs(_m, 0, groundY + cr.y0 + cr.h - 1.0, 0, 0);
      T.addOnce(stone, cap, _m, { masks: [0.45, 0.4, 0.25] });
      const base = polyPrism(cr.poly, 0.5);
      trs(_m, 0, groundY + cr.y0, 0, 0);
      T.addOnce(stone, base, _m, { masks: [0.4, 0.5, 0.3] });
      // the piers, one on each plan edge, plus one at every corner
      const box = plainBox();
      const hgt = cr.h - 1.5;
      for (let i = 0; i < cr.poly.length; i++) {
        const a = cr.poly[i];
        const bb = cr.poly[(i + 1) % cr.poly.length];
        const len = Math.hypot(bb[0] - a[0], bb[1] - a[1]);
        const n = Math.max(2, Math.round(len / 3.6));
        const ang = Math.atan2(bb[1] - a[1], bb[0] - a[0]);
        for (let k = 0; k <= n; k++) {
          const tt = k / n;
          trs(
            _m,
            a[0] + (bb[0] - a[0]) * tt,
            groundY + cr.y0 + 0.5 + hgt * 0.5,
            a[1] + (bb[1] - a[1]) * tt,
            -ang,
            0.62,
            hgt,
            0.62
          );
          T.add(stone, box, _m, { masks: [0.4, 0.35, 0.2] });
        }
      }
      // the lit plant deck the colonnade stands around: at night this is the
      // glow behind the piers, which is the entire point of a lantern crown
      /**
       * Set well back behind the colonnade and only two thirds of its height,
       * with the cap slab oversailing it. At 1.6 m of inset and 70% height the
       * deck stood almost flush with the piers, so by day the crown read as a
       * row of blank cream boxes rather than as a shadowed recess with a glow
       * in it — a lantern has to be dark before it can be lit.
       */
      const deck = polyPrism(polyInset(cr.poly, 2.9), hgt * 0.6);
      trs(_m, 0, groundY + cr.y0 + 0.6, 0, 0);
      T.addOnce('room_lit_warm', deck, _m, { masks: [0, 0.35, 0.55] });
      box.dispose();
      continue;
    }

    // 'step' — a hard setback tier. Shaft, a projecting band at its head, and a
    // coping, so each step of a wedding cake has its own cornice line.
    const g = polyPrism(cr.poly, cr.h);
    trs(_m, 0, groundY + cr.y0, 0, 0);
    T.addOnce(prog.masonry, g, _m, { masks: [0.3, 0.35, 0.2] });
    const b2 = polyPrism(polyInset(cr.poly, -0.34), 0.46);
    trs(_m, 0, groundY + cr.y0 + cr.h - 0.46, 0, 0);
    T.addOnce(stone, b2, _m, { masks: [0.5, 0.4, 0.25] });
    // a shallow recessed band a third of the way up: deco towers are covered in
    // them and they are what keeps a 7 m step from reading as a plain block
    if (cr.h > 3.5) {
      const b3 = polyPrism(polyInset(cr.poly, 0.22), 0.9);
      trs(_m, 0, groundY + cr.y0 + cr.h * 0.32, 0, 0);
      T.addOnce(plan.glazeKey ?? 'glass_solid', b3, _m, { masks: [0.2, 0.5, 0.7] });
    }
  }
}

/**
 * Parapet, mechanical penthouse, stair bulkhead, cooling plant, mast.
 *
 * `near` adds the small stuff (louvre blades, handrails, the warning lamp);
 * the massing is identical either way so the outline never changes with
 * distance.
 */
function buildTopWorks(T, lib, plan, rng, groundY, near) {
  const wk = plan.works;
  if (!wk) return;
  const { prog } = plan;
  const stone = prog.sillMat ?? 'stone_grey';
  const b = polyBounds(wk.poly);
  const y = groundY + wk.y;
  const box = plainBox();
  const cham = near ? chamferBox(1, 1, 1, 0.03) : box;

  // --- parapet round the topmost roof ------------------------------------
  if (prog.parapet > 0.05 && wk.poly.length >= 3) {
    const outer = polyPrism(polyInset(wk.poly, -0.06), prog.parapet);
    trs(_m, 0, y, 0, 0);
    T.addOnce(prog.masonry, outer, _m, { masks: [0.35, 0.45, 0.25] });
    const cap = polyPrism(polyInset(wk.poly, -0.2), 0.16);
    trs(_m, 0, y + prog.parapet, 0, 0);
    T.addOnce(stone, cap, _m, { masks: [0.5, 0.45, 0.25] });
  }

  // --- mechanical penthouse ----------------------------------------------
  if (wk.mech) {
    const m = wk.mech;
    const mx = b.cx + m.dx;
    const mz = b.cz + m.dz;
    trs(_m, mx, y + m.h * 0.5, mz, plan.yaw, m.w, m.h, m.d);
    T.add(rng.float() < 0.5 ? 'concrete_wall' : prog.masonry, cham, _m, {
      masks: [0.3, 0.45, 0.25],
    });
    // coping over it
    trs(_m, mx, y + m.h + 0.1, mz, plan.yaw, m.w + 0.4, 0.2, m.d + 0.4);
    T.add(stone, box, _m, { masks: [0.45, 0.4, 0.25] });
    /**
     * Louvre blades on the long faces. A plant room is 60% intake, and the
     * blade bands are the only thing that stops the penthouse reading as a
     * second, smaller version of the box it stands on.
     */
    if (near) {
      const nB = Math.max(3, Math.round(m.h / 0.42));
      for (let i = 0; i < nB; i++) {
        const ly = y + 0.5 + ((i + 0.5) / nB) * (m.h - 0.9);
        for (const s of [-1, 1]) {
          trs(_m, mx, ly, mz + (s * m.d) / 2, plan.yaw, m.w * 0.82, 0.2, 0.1);
          T.add('alu_dark', box, _m, { masks: [0.4, 0.5, 0.35] });
        }
      }
    } else {
      /**
       * One recessed band is enough to break the penthouse at 300 m — and it
       * is drawn in the GLAZING key, not in `alu_dark`, because the far tile
       * already carries a glazing batch and does not carry a metal one. A new
       * surface key in a streamed tile is a new merged draw call in the colour
       * pass, again in the prepass and again in every shadow cascade; four of
       * them across fifty resident far tiles is two hundred draws for detail
       * nobody can resolve.
       */
      trs(_m, mx, y + m.h * 0.55, mz, plan.yaw, m.w * 0.86, m.h * 0.42, m.d + 0.06);
      T.add(plan.glazeKey ?? 'glass_solid', box, _m, { masks: [0.4, 0.5, 0.4] });
    }

    // cooling plant on the penthouse roof
    const plantKey = near ? 'alu_dark' : 'concrete_wall';
    for (let i = 0; i < wk.tanks; i++) {
      const r = rng.range(0.9, 1.8);
      const g = cylinderY(r, rng.range(1.8, 3.2), near ? 12 : 6);
      trs(
        _m,
        mx + rng.range(-m.w * 0.3, m.w * 0.3),
        y + m.h + 1.4,
        mz + rng.range(-m.d * 0.3, m.d * 0.3),
        0,
        1,
        1,
        1
      );
      T.addOnce(plantKey, g, _m, { masks: [0.45, 0.55, 0.3] });
    }
  }

  // --- stair bulkhead / lift overrun --------------------------------------
  if (wk.bulk) {
    const s = wk.bulk;
    const sx = b.cx + b.w * rng.range(-0.3, 0.3);
    const sz = b.cz + b.d * rng.range(-0.3, 0.3);
    trs(_m, sx, y + s.h * 0.5, sz, plan.yaw + rng.range(-0.1, 0.1), s.w, s.h, s.d);
    T.add('concrete_wall', cham, _m, { masks: [0.35, 0.5, 0.3] });
    trs(_m, sx, y + s.h + 0.08, sz, plan.yaw, s.w + 0.3, 0.16, s.d + 0.3);
    T.add(prog.roof, box, _m, { masks: [0.4, 0.5, 0.3] });
    if (near) {
      // the door out onto the roof, and the run of handrail beside it
      trs(_m, sx, y + 1.05, sz + s.d / 2 + 0.02, plan.yaw, 0.9, 2.05, 0.08);
      T.add('alu_dark', box, _m, { masks: [0.6, 0.55, 0.3] });
    }
  }

  // --- the mast ------------------------------------------------------------
  if (wk.mast > 0.5) {
    const mh = wk.mast;
    const mx = b.cx + b.w * rng.range(-0.12, 0.12);
    const mz = b.cz + b.d * rng.range(-0.12, 0.12);
    const base = wk.mech ? wk.mech.h : 0;
    // A tapering lattice, faked as three stacked tubes: at the range a mast is
    // ever visible the taper is the entire read and the lattice is not.
    for (let i = 0; i < 3; i++) {
      const seg = mh / 3;
      const r0 = 0.42 * (1 - i * 0.28);
      const g = cylinderY(r0, seg, near ? 8 : 5, { rTop: 0.42 * (1 - (i + 1) * 0.28) });
      trs(_m, mx, y + base + seg * (i + 0.5), mz, 0, 1, 1, 1);
      T.addOnce(near ? 'alu_dark' : stone, g, _m, { masks: [0.5, 0.5, 0.2] });
      if (near) {
        // guy collar
        const c = cylinderY(r0 * 1.7, 0.12, 8);
        trs(_m, mx, y + base + seg * (i + 1), mz, 0, 1, 1, 1);
        T.addOnce('alu_dark', c, _m, { masks: [0.6, 0.5, 0.3] });
      }
    }
    // The aircraft warning lamp. Emissive, tiny, and worth it: a red point at
    // the top of every tall silhouette is one of the loudest "this is a real
    // city" signals there is, by day and by night.
    if (mh > 9) {
      const lamp = cylinderY(0.36, 0.5, 8);
      trs(_m, mx, y + base + mh + 0.3, mz, 0, 1, 1, 1);
      T.addOnce('neon_red', lamp, _m, { masks: [0, 0, 0] });
    }
  }

  if (cham !== box) cham.dispose();
  box.dispose();
}

/**
 * A mill site is not a shed with windows: it is a shed with a stack, a bank of
 * silos, a pipe rack and a conveyor going somewhere. Steel Row has to read as
 * a working (well — formerly working) industrial site from one frame.
 */
function dressIndustrial(T, lib, plan, rng, groundY) {
  const vol = plan.volumes[plan.volumes.length - 1];
  const b = polyBounds(vol.poly);
  const top = groundY + vol.y0 + vol.h;
  const rust = rng.float() < 0.6 ? 'corrugated_rust' : 'rust';

  // a monitor along the ridge — the sawtooth clerestory every mill shed has
  if (b.w > 14 && b.d > 10) {
    const mw = Math.min(b.w * 0.34, 9);
    const box = plainBox();
    trs(_m, b.cx, top + 1.5, b.cz, plan.yaw, mw, 3.0, b.d * 0.86);
    T.add(plan.prog.masonry, box, _m, { masks: [0.3, 0.5, 0.25] });
    trs(_m, b.cx, top + 3.15, b.cz, plan.yaw, mw + 1.1, 0.3, b.d * 0.9);
    T.add('roof_metal', box, _m, { masks: [0.45, 0.5, 0.25] });
    for (const s of [-1, 1]) {
      trs(_m, b.cx + s * mw * 0.5, top + 1.9, b.cz, plan.yaw, 0.14, 1.7, b.d * 0.8);
      T.add('glass_grimy', box, _m, { masks: [0, 0.5, 0] });
    }
    box.dispose();
  }

  // the stack. Jittered inside the PLAN, not inside its bounding box: on a lot
  // rotated off the world axes those are different places, and `b.cx +- 32% of
  // b.w` is routinely outside the building and out over the pavement.
  if (plan.arch === 'mill' || rng.float() < 0.35) {
    const sc = polyCentroid(vol.poly);
    let sx = sc[0] + rng.range(-b.w * 0.22, b.w * 0.22);
    let sz = sc[1] + rng.range(-b.d * 0.22, b.d * 0.22);
    if (!pointInPoly(vol.poly, sx, sz)) {
      sx = sc[0];
      sz = sc[1];
    }
    const h = rng.range(18, 46);
    const g = cylinderY(rng.range(1.1, 2.1), h, 14, { rTop: rng.range(0.8, 1.5) });
    trs(_m, sx, groundY + h / 2, sz, 0, 1, 1, 1);
    T.addOnce(rng.float() < 0.5 ? 'brick_dark' : rust, g, _m, { masks: [0.5, 0.6, 0.3] });
    const cap = cylinderY(rng.range(1.0, 1.7), 0.5, 14);
    trs(_m, sx, groundY + h + 0.25, sz, 0, 1, 1, 1);
    T.addOnce('rust_deep', cap, _m, { masks: [0.8, 0.6, 0.3] });
  }

  /**
   * Silos and the pipe rack used to be placed OUTSIDE the footprint's bounding
   * box — `b.x0 - r * 1.2` and `b.z0 - 2.4`. Two things are wrong with that,
   * and together they were the single worst source of building geometry in a
   * live carriageway that `roadsweep.mjs` found: 16.25 m past `plan.foot`,
   * against a plinth's 0.34 m.
   *
   * First, deliberately stepping outside the plan puts a 3 m silo on whatever
   * is there, and what is there is the pavement. Second — and this is the part
   * that makes it much worse than it looks — `b` is an axis-aligned bounding
   * BOX and Steel City's twelve district grids run at twelve different angles,
   * so on a typical mill lot `b.x0` is already several metres outside the
   * footprint before the offset is applied at all.
   *
   * Both now sit INSIDE the plan, on the flank furthest from the street, which
   * is where a real mill puts them: you unload from the yard, not the road.
   * `_lateral` measures in the plan's own frame rather than the world's, so a
   * rotated lot gets the same answer as a square one.
   */
  const away = [-plan.toStreet[0], -plan.toStreet[1]];
  const inset = (frac, along) => {
    // A point `frac` of the way from the centroid toward the back of the plan,
    // slid `along` metres across it.
    const c = polyCentroid(vol.poly);
    const half = Math.min(b.w, b.d) * 0.5;
    return [
      c[0] + away[0] * half * frac - away[1] * along,
      c[1] + away[1] * half * frac + away[0] * along,
    ];
  };

  // silos against the back flank, inside the plan
  const nS = rng.int(0, 3);
  for (let i = 0; i < nS; i++) {
    const r = rng.range(1.8, 3.2);
    const h = rng.range(9, 17);
    const p = inset(0.82, (i - (nS - 1) * 0.5) * (r * 2.4));
    if (!pointInPoly(vol.poly, p[0], p[1])) continue;
    T.putS(Kit.silo(lib, rust), p[0], groundY, p[1], rng.range(0, 6.28), r, h, r);
  }

  // pipe rack running across the back of the shed on stubby legs
  if (rng.float() < 0.5 && b.w > 16) {
    const py = groundY + rng.range(3.5, 6.5);
    const n = Math.max(2, Math.round(b.w / 4));
    const legs = plainBox();
    for (let i = 0; i < n; i++) {
      const p = inset(0.7, (i + 0.5 - n * 0.5) * 4);
      if (!pointInPoly(vol.poly, p[0], p[1])) continue;
      T.put(Kit.truss(lib, rust), p[0], py, p[1], 0, 1);
      if (i % 2 === 0) {
        trs(_m, p[0], groundY + (py - groundY) * 0.5, p[1], 0, 0.35, py - groundY, 0.35);
        T.add('rust_deep', legs, _m, { masks: [0.85, 0.6, 0.35] });
      }
    }
    legs.dispose();
  }
}

/** A gable roof over the topmost volume, aligned to the frontage. */
function buildPitchedRoof(T, lib, plan, rng, groundY) {
  const vol = plan.volumes[plan.volumes.length - 1];
  const poly = vol.poly;
  const c = polyCentroid(poly);
  // measure the footprint in frontage space
  const fx = plan.frontDir[0];
  const fz = plan.frontDir[1];
  let hw = 0;
  let hd = 0;
  for (const p of poly) {
    const dx = p[0] - c[0];
    const dz = p[1] - c[1];
    hw = Math.max(hw, Math.abs(dx * fx + dz * fz));
    hd = Math.max(hd, Math.abs(-dx * fz + dz * fx));
  }
  const y = groundY + vol.y0 + vol.h;
  const rise = Math.min(hd * 0.95, rng.range(1.8, 3.2));
  const over = 0.32;
  const yaw = Math.atan2(fz, fx);

  const a = new THREE.BufferGeometry();
  const pos = [];
  const nrm = [];
  const uv = [];
  const col = [];
  const idx = [];
  const push = (x, yy, z, u, v, m) => {
    pos.push(x, yy, z);
    nrm.push(0, 1, 0);
    uv.push(u, v);
    col.push(m[0], m[1], m[2]);
  };
  const W = hw + over;
  const D = hd + over;
  const mk = [0.35, 0.45, 0.15];
  // two slopes
  push(-W, 0, -D, 0, 0, mk);
  push(W, 0, -D, 1, 0, mk);
  push(W, rise, 0, 1, 1, mk);
  push(-W, rise, 0, 0, 1, mk);
  push(-W, 0, D, 0, 0, mk);
  push(W, 0, D, 1, 0, mk);
  idx.push(0, 1, 2, 0, 2, 3);
  idx.push(3, 2, 5, 3, 5, 4);
  a.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  a.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  a.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  a.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  a.setIndex(idx);
  a.computeVertexNormals();
  trs(_m, c[0], y, c[1], -yaw);
  T.addOnce(plan.prog.roof, a, _m, null);

  // gable ends, so the roof is not a floating plane
  const gab = new THREE.BufferGeometry();
  const gp = [];
  const gi = [];
  const gc = [];
  const gn = [];
  const gu = [];
  for (const s of [-1, 1]) {
    const base = gp.length / 3;
    gp.push(-W + over, 0, s * hd, W - over, 0, s * hd, 0, rise, s * hd);
    for (let i = 0; i < 3; i++) {
      gn.push(0, 0, s);
      gu.push(0, 0);
      gc.push(0.2, 0.3, 0.1);
    }
    if (s > 0) gi.push(base, base + 1, base + 2);
    else gi.push(base + 2, base + 1, base);
  }
  gab.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
  gab.setAttribute('normal', new THREE.Float32BufferAttribute(gn, 3));
  gab.setAttribute('uv', new THREE.Float32BufferAttribute(gu, 2));
  gab.setAttribute('color', new THREE.Float32BufferAttribute(gc, 3));
  gab.setIndex(gi);
  trs(_m, c[0], y, c[1], -yaw);
  T.addOnce(plan.prog.masonry, gab, _m, null);

  // fascia boards at the eaves
  const fascia = plainBox();
  for (const s of [-1, 1]) {
    trs(_m, c[0], y, c[1], -yaw);
    const t2 = new THREE.Matrix4().makeTranslation(0, -0.09, s * D);
    t2.multiply(new THREE.Matrix4().makeScale(W * 2, 0.24, 0.1));
    T.add('trim_white', fascia, _m.clone().multiply(t2), { masks: [0.6, 0.5, 0.3] });
  }
  fascia.dispose();

  if (rng.float() < 0.75) {
    const cid = Kit.chimney(lib, rng.float() < 0.6 ? 'brick_red' : 'brick_brown');
    T.put(cid, c[0] + rng.range(-W * 0.5, W * 0.5), y + rise * 0.45, c[1] + rng.range(-0.4, 0.4), -yaw, 1);
  }
}

// ----------------------------------------------------------------- roofs --
/**
 * Roof furniture. A GTA V roof is never empty — plant rooms, condensers,
 * flues, dishes, a water tower, a hatch, a mast. It is also the first thing
 * you see from a hill, so this is where a lot of the skyline character lives.
 */
function dressRoof(T, lib, plan, rng, groundY) {
  const { prog, style } = plan;
  if (plan.pitched) return;
  const clutter = style.clutter ?? 0.6;
  for (const vol of plan.volumes) {
    const poly = vol.poly;
    const b = polyBounds(poly);
    const y = groundY + vol.y0 + vol.h;
    const area = Math.abs(polyArea(poly));
    const inset = 1.6;
    const rx = Math.max(0.5, b.w / 2 - inset);
    const rz = Math.max(0.5, b.d / 2 - inset);
    /**
     * Rejection-sample inside the actual polygon. An L-shaped or triangular lot
     * has a bounding box much larger than its roof, and sampling the box hangs
     * condensers and water towers in mid-air off the side of the building.
     */
    const at = () => {
      for (let k = 0; k < 8; k++) {
        const px = b.cx + rng.range(-rx, rx);
        const pz = b.cz + rng.range(-rz, rz);
        if (pointInPoly(poly, px, pz)) return [px, pz];
      }
      return null;
    };

    /**
     * The topmost roof of a CROWNED tower used to be skipped entirely, on the
     * reasoning that the crown stands on it. What that actually produced was
     * the emptiest roofs in the city belonging to the tallest buildings — the
     * only ones anybody sees from Mt Washington. It is now dressed like any
     * other setback roof; `buildTopWorks` owns the plant on top of the crown
     * itself, so the two do not collide.
     */
    const isTop = vol === plan.volumes[plan.volumes.length - 1];

    // plant room / stair head
    if (area > 90 && rng.float() < 0.75 * clutter + 0.15) {
      const p = at();
      if (!p) continue;
      const w = rng.range(2.6, Math.min(7, b.w * 0.45));
      const d = rng.range(2.4, Math.min(6, b.d * 0.45));
      T.putS(
        Kit.plantRoom(lib, rng.float() < 0.5 ? prog.masonry : 'concrete_wall'),
        p[0],
        y,
        p[1],
        rng.range(-0.2, 0.2),
        w,
        rng.range(2.4, 3.6),
        d
      );
    }

    // condensers
    const nAc = Math.round(Math.min(9, area / 120) * clutter * rng.range(0.5, 1.6));
    const acId = Kit.acRoof(lib, 'alu_dark');
    for (let i = 0; i < nAc; i++) {
      const p = at();
      if (!p) continue;
      T.put(acId, p[0], y, p[1], rng.range(0, Math.PI), rng.range(0.75, 1.25));
    }

    // flues, cowls, extract boxes
    const nV = Math.round(Math.min(8, area / 90) * clutter * rng.range(0.4, 1.5));
    for (let i = 0; i < nV; i++) {
      const p = at();
      if (!p) continue;
      const kind = rng.float() < 0.4 ? 'stack' : rng.float() < 0.5 ? 'cowl' : 'box';
      T.put(
        Kit.vent(lib, 'steel_dark', kind),
        p[0],
        y,
        p[1],
        rng.range(0, Math.PI),
        rng.range(0.8, 1.35)
      );
    }

    // dishes and masts, mostly on residential
    if (rng.float() < 0.5 * clutter) {
      const p = at();
      if (p) T.put(Kit.dish(lib, 'alu_dark'), p[0], y, p[1], rng.range(0, 6.28), rng.range(0.7, 1.2));
    }
    if (rng.float() < 0.3 * clutter) {
      const p = at();
      if (p) T.put(Kit.antenna(lib, 'steel_dark'), p[0], y, p[1], rng.range(0, 6.28), rng.range(0.7, 1.4));
    }

    // the water tower — one per few blocks, and worth every triangle
    if (isTop && area > 200 && b.w > 12 && b.d > 12 && rng.float() < 0.3 * clutter) {
      const p = at();
      if (p) T.put(Kit.waterTower(lib, 'timber'), p[0], y, p[1], rng.range(0, 6.28), rng.range(0.85, 1.15));
    }

    // roof access ladder up the parapet
    if (rng.float() < 0.4 * clutter) {
      const p = at();
      if (p) T.putS(Kit.ladder(lib, 'steel_dark'), p[0], y, p[1], rng.range(0, 6.28), 1, 2.2, 1);
    }
  }
}

// --------------------------------------------------------------- far LOD --
/**
 * The mid/far mesh. Same massing, same crown, same colours — but the windows
 * are a recessed band rather than 40 instanced units, and the roof carries two
 * boxes instead of twenty. Roughly 2% of the near cost.
 */
/**
 * How far the mid-LOD's piers, spandrels and courses stand PROUD of the massing
 * face. This number is the whole LOD.
 *
 * THE BUG IT REPLACES. The bands used to be authored at z = -0.06 with a
 * thickness of 0.12 in a wall basis whose origin is the OUTER face with +Z
 * pointing out of the building — so every one of them spanned z in [-0.12, 0],
 * i.e. entirely inside a solid extruded prism, with its front face exactly
 * coplanar with the wall. The result was a city that beyond the full-detail
 * ring was untextured solid-colour boxes with a z-fighting stripe here and
 * there, which is precisely what the critic panel measured. Relief on a mid-LOD
 * has to be ADDITIVE — you cannot recess into a solid you are not cutting.
 */
const LOD_RELIEF = 0.32;
/**
 * The piers stand proud of the SPANDRELS, not level with them.
 *
 * THE SECOND HALF OF THE SAME BUG. Once the relief was made additive, the
 * spandrel courses ran the full length of the elevation and the piers ran its
 * full height — so every crossing of the two was a pair of boxes occupying the
 * same volume with EXACTLY COPLANAR front faces, in the same merged batch, in
 * the same material. Every mid-distance building in the `skyline` frame came
 * back shredded: the stone/glass boundary was a torn, dithered, stippled line
 * rather than an edge. Reading it as "untextured extruded cuboids" was
 * generous. 7 cm of extra projection makes the pier unambiguously in front and
 * turns the artefact into the reveal shadow it was always meant to be.
 */
const LOD_PIER = 0.48;
/**
 * THE THIRD HALF OF THE SAME BUG, and the one that was actually still on screen.
 *
 * Fixing the FRONT faces left every relief box's BACK face sitting at exactly
 * z = 0 in the wall basis — which is exactly where the massing prism's own
 * front face is. Front-face culling hides that in the colour pass, but the
 * depth/normal prepass and the shadow cascades do not necessarily cull the same
 * way, so the depth buffer over every banded elevation was a per-pixel coin
 * flip between two coincident planes. Measured in the `skyline` capture as
 * torn, ragged, stippled horizontal bands with bites taken out of them — read
 * by the critic panel, reasonably, as "a single flat plane with horizontal
 * banding, no mullion depth".
 *
 * So every relief box is now BURIED: it starts 45 cm inside the solid prism and
 * only its projection sticks out. Nothing is coplanar with anything, at any
 * distance, in any pass. Triangle count is unchanged — the same box, longer in
 * one axis.
 */
const LOD_SINK = 0.45;
/**
 * How far the GLAZING band stands out of the massing face — and why it is a
 * whole 13 cm rather than the 1.2 cm it used to be.
 *
 * The mid LOD draws from the full-detail ring (~130 m) out to `farDetailDist`
 * (520 m) and, for the massing and glazing, beyond that to the draw distance.
 * Depth resolution at the far end of that range is on the order of a decimetre,
 * so a band 1.2 cm proud of the prism it is drawn against does not reliably win
 * the depth test: measured, it vanished outright at 450 m, leaving a downtown
 * of blank tan slabs. Every relief tier is now separated by at least 13 cm:
 *
 *   glazing   0.13   (STATIC — the window pattern must outlive the detail LOD,
 *                     or a tower changes colour when its relief drops out)
 *   spandrel  0.32   (detail)
 *   pier      0.48   (detail, corners 0.60)
 *   cornice   0.50   (static — silhouette)
 */
const LOD_GLASS = 0.13;

/**
 * One buried relief box: `proud` metres out of the wall face, LOD_SINK metres
 * into it. `out` is filled in wall-basis local space; the caller premultiplies.
 */
function relief(out, x, y, w, h, proud, sink = LOD_SINK) {
  return trs(out, x, y, (proud - sink) * 0.5, 0, w, h, proud + sink);
}

export function buildLotLod(T, lib, plan, rng, groundY = 0) {
  const { prog, volumes, crowns } = plan;
  const band = plainBox();
  const box = plainBox();
  /**
   * The mid LOD is ALWAYS opaque glazing, including on a curtain wall — which
   * used to reach for the building's real transparent glass. A transparent band
   * at 300 m costs a depth-sorted draw, keeps the tile out of the prepass and,
   * worst of all, lets the sky through the window field so a tower dissolves
   * into the sky it is supposed to be silhouetted against.
   */
  const glassKey = plan.glazeKey ?? 'glass_solid';
  const stone = prog.sillMat ?? 'stone_grey';

  for (const vol of volumes) {
    const poly = vol.poly;
    const c = polyCentroid(poly);
    const body = polyPrism(poly, vol.h);
    trs(_m, 0, groundY + vol.y0, 0, 0);
    T.addOnce(prog.masonry, body, _m, { masks: [0, prog.age * 0.3, 0] });

    // Where the glazing sits on each floor of this volume. Computed once and
    // shared by the glass, the spandrels and the piers so the three cannot
    // disagree about where a window is.
    const wins = [];
    let yc = 0;
    for (let f = 0; f < vol.floors.length; f++) {
      const fl = vol.floors[f];
      const wh = Math.min(prog.winH, fl.h * 0.55);
      const cy = yc + (f === 0 ? fl.h * 0.45 : prog.sillH + wh / 2);
      wins.push([cy - wh / 2, cy + wh / 2]);
      yc += fl.h;
    }

    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      outwardNormal(a[0], a[1], b[0], b[1], c[0], c[1], _n);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1.5) continue;
      const basis = new THREE.Matrix4();
      wallBasis(basis, a[0], a[1], b[0], b[1], _n[0], _n[1], groundY + vol.y0, 0);

      // 1. Glazing. 2 cm proud of the massing face, so it is never coplanar
      //    with it, and it sits at the BOTTOM of a 19 cm groove between the
      //    spandrels above and below — which is what actually reads as a
      //    recessed window from 200 m under a raking sun. The AO mask is the
      //    reveal shadow: the cascades cannot resolve 19 cm at 400 m (see
      //    tile.js) so the recess is painted in, not lit in.
      /**
       * Segmented, and some of the segments are LIT.
       *
       * The mid LOD used to lay one unbroken opaque band per floor, which meant
       * that everything past the full-detail ring — i.e. the entire downtown as
       * seen from Mt Washington, which is this city's signature view — had
       * exactly zero lit windows after dark. A night skyline whose towers are
       * uniformly black slabs is not a night skyline. The near mesh had lit
       * rooms all along; they simply stopped at 130 m.
       *
       * `room_lit_warm` is already in this tile for the lantern crowns, and
       * `BuildingSystem.update` ramps its emissive off the solar altitude, so
       * this costs no new batch and no new uniform — one more box per floor.
       */
      const segW = prog.arch === 'curtain' ? 11 : 8;
      for (const [y0, y1] of wins) {
        const nSeg = Math.max(1, Math.round(len / segW));
        const sw = len / nSeg;
        for (let sg = 0; sg < nSeg; sg++) {
          const lit = rng.float() < prog.litRate * 0.55;
          relief(_m, -len / 2 + (sg + 0.5) * sw, (y0 + y1) * 0.5, sw * 0.995, y1 - y0, LOD_GLASS);
          _m.premultiply(basis);
          T.add(lit ? 'room_lit_warm' : glassKey, band, _m, {
            masks: [0, prog.age * 0.3, lit ? 0.1 : 0.62],
          });
        }
      }

      // 2. Spandrels: the solid course under each window and over the one below
      //    it, standing proud. One box per gap, plus the base and the head.
      const edges = [0];
      for (const [y0, y1] of wins) {
        edges.push(y0, y1);
      }
      edges.push(vol.h);
      for (let k = 0; k < edges.length; k += 2) {
        const y0 = edges[k];
        const y1 = edges[k + 1];
        if (y1 - y0 < 0.06) continue;
        relief(_m, 0, (y0 + y1) * 0.5, len, y1 - y0, LOD_RELIEF);
        _m.premultiply(basis);
        T.add(prog.masonry, band, _m, { masks: [0.12, prog.age * 0.35, 0.1], detail: true });
      }

      // 3. Piers.
      //
      //    A continuous ribbon of glass is a 1970s office block and nothing
      //    else. Every archetype gets its vertical rhythm back — INCLUDING the
      //    curtain wall, which used to be skipped entirely and is exactly why
      //    the `hero` towers read as "a single flat plane with horizontal
      //    banding, no structural expression".
      //
      //    The spacing is chosen against the PIXEL, not against the building.
      //    At 300 m in a 1080p/60-degree frame one metre is ~5.5 px, so a 0.45 m
      //    mullion fin is sub-pixel and contributes nothing but shimmer, while a
      //    1.1 m structural pier every 8 m is 6 px of hard vertical edge with a
      //    30 cm shadow behind it. A glass tower gets the second, plus a heavy
      //    corner column, which is what actually reads as structure at range.
      {
        const curtain = prog.arch === 'curtain';
        const spacing = curtain ? 8.2 : Math.max(4.2, prog.bayW * 1.35);
        const nB = Math.max(1, Math.round(len / spacing));
        const pierW = curtain
          ? Math.max(0.75, Math.min(1.3, len / nB * 0.14))
          : Math.max(0.5, Math.min(1.7, prog.bayW * 0.46));
        const pierProud = curtain ? LOD_PIER * 0.72 : LOD_PIER;
        for (let k = 0; k <= nB; k++) {
          const px = -len / 2 + (k / nB) * len;
          const corner = k === 0 || k === nB;
          const ww = corner ? pierW * 1.9 : pierW;
          relief(_m, px, vol.h * 0.5, ww, vol.h, corner ? pierProud * 1.25 : pierProud);
          _m.premultiply(basis);
          T.add(corner ? stone : prog.masonry, band, _m, {
            masks: [0.18, prog.age * 0.3, 0.1],
            detail: true,
          });
        }
      }

      // 4. Cornice and parapet — silhouette, so NOT under the detail LOD.
      relief(_m, 0, vol.h - 0.34, len, 0.44, LOD_RELIEF + 0.14);
      _m.premultiply(basis);
      T.add(stone, band, _m, { masks: [0.35, 0.4, 0.2] });
      if (prog.parapet > 0.05) {
        relief(_m, 0, vol.h + prog.parapet / 2, len, prog.parapet, LOD_RELIEF * 0.5, 0.16);
        _m.premultiply(basis);
        T.add(prog.masonry, band, _m, { masks: [0.3, 0.35, 0.2] });
        relief(_m, 0, vol.h + prog.parapet + 0.06, len + 0.1, 0.16, LOD_RELIEF * 0.75, 0.2);
        _m.premultiply(basis);
        T.add(stone, band, _m, { masks: [0.45, 0.5, 0.25] });
      }
    }

    const deck = polyPrism(poly, 0.3);
    trs(_m, 0, groundY + vol.y0 + vol.h - 0.3, 0, 0);
    T.addOnce(prog.roof, deck, _m, { masks: [0.35, 0.5, 0.25] });
  }
  buildPlinth(T, plan, groundY, stone);
  buildCrowns(T, lib, plan, rng, groundY);
  buildTopWorks(T, lib, plan, rng, groundY, false);

  if (plan.pitched) buildPitchedRoof(T, lib, plan, rng, groundY);
  else {
    /**
     * Roof plant on the intermediate setback roofs. `buildTopWorks` owns the
     * topmost one; these are the shoulders, and leaving them bare is what made
     * the mid-distance city read as a set of clean prisms. Two or three boxes
     * per roof is enough to break a 300 m silhouette and costs 36 triangles.
     */
    for (let vi = 0; vi < volumes.length; vi++) {
      const vol = volumes[vi];
      const isTop = vi === volumes.length - 1 && !crowns.length;
      const bb = polyBounds(vol.poly);
      const y = groundY + vol.y0 + vol.h;
      if (bb.w < 7 || bb.d < 7) continue;
      const n = isTop && plan.works?.mech ? 0 : rng.int(1, 3);
      for (let i = 0; i < n; i++) {
        const w2 = Math.min(bb.w * rng.range(0.16, 0.4), 7);
        const d2 = Math.min(bb.d * rng.range(0.16, 0.4), 6);
        trs(
          _m,
          bb.cx + bb.w * rng.range(-0.24, 0.24),
          y + rng.range(0.9, 2.0),
          bb.cz + bb.d * rng.range(-0.24, 0.24),
          rng.range(-0.3, 0.3),
          w2,
          rng.range(1.8, 3.8),
          d2
        );
        T.add(rng.float() < 0.5 ? 'concrete_wall' : 'precast', box, _m, {
          masks: [0.3, 0.45, 0.2],
        });
      }
    }
  }
  band.dispose();
  box.dispose();
}

/**
 * Where the building meets the ground.
 *
 * The critic panel's finding was "every building meets the ground by
 * intersecting it — no plinth, no kerb, no gutter, no threshold; they are
 * extrusions pushed through a terrain plane", and it was correct: the massing
 * prism started at `groundY` and that was the whole detail.
 *
 * Two courses, both stepped OUT from the wall line, both starting well below
 * `groundY` so they stay buried on the uphill side of a lot instead of
 * revealing a floating gap — Steel City is built on hills and a plinth authored
 * for flat ground is worse than none. The step also gives the contact shadow
 * something to land on, which is what actually sells the join.
 */
function buildPlinth(T, plan, groundY, stone) {
  const vol = plan.volumes[0];
  if (!vol) return;
  const poly = vol.poly;
  const b = polyBounds(poly);
  if (b.w < 1.4 || b.d < 1.4) return;
  const grubby = { masks: [0.55, 0.72, 0.45] };

  // The plinth proper: 14 cm proud, from 0.9 m under grade to 0.42 m over it.
  const p1 = polyPrism(polyInset(poly, -0.14), 1.32);
  trs(_m, 0, groundY - 0.9, 0, 0);
  T.addOnce(stone, p1, _m, { masks: [0.42, 0.55, 0.35] });

  // The kerb/step course under it: 34 cm proud, only 0.16 m of it above grade,
  // so it reads as the pavement stepping up to the threshold rather than as a
  // second wall. Deliberately a DIFFERENT surface from the plinth: the tonal
  // break is what makes the join legible in a wide shot.
  const p2 = polyPrism(polyInset(poly, -0.34), 0.86);
  trs(_m, 0, groundY - 0.7, 0, 0);
  T.addOnce(plan.prog.age > 0.55 ? 'concrete_wall' : 'precast', p2, _m, grubby);
}

/** Even-odd point-in-polygon for [x,z] pairs. */
function pointInPoly(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const zi = pts[i][1];
    const xj = pts[j][0];
    const zj = pts[j][1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export { lotRng };
