import * as THREE from 'three';
import {
  Accum,
  chamferBox,
  plainBox,
  quad,
  cylinderY,
  moulding,
  polyPrism,
  fillMasks,
  weather,
  trs,
  fbm3,
} from './geom.js';
import { Kit } from './kit.js';

/**
 * BUILDINGS — the six landmarks (DESIGN.md).
 *
 * Hand-authored, always resident, never generated. These are the city's
 * silhouette: the Steel Tower and the Steel Bowl are what you read from across
 * the rivers, the Blast Furnace is what tells you Steel Row is Steel Row, and
 * the Incline is the reason Mt. Washington exists as a place you go.
 *
 * WHERE A LANDMARK IS IS NOT THIS FILE'S DECISION.
 *
 * `world` is the authority on where everything is, and it publishes the table
 * as `world.landmarks`. This file used to keep its own copy — DESIGN.md's
 * legacy coordinates times four — and the copy DISAGREED: it put The Point
 * Fountain at `(-712, 32)`, where `heightAt` is -8.68 m and `isWater` is true.
 * The fountain was on the bed of the Ohio, 112 m downstream of the confluence,
 * because a x4 scale of a 700 m map does not survive rivers that were widened
 * to match. `world/plan.js`, `src/game/data.js` and `src/ui/data.js` all say
 * `(-452, 46)` — the tip of the triangle, dry at +3.56 m — and they are right.
 *
 * So `BuildingSystem.init` calls `adoptLandmarkSites(world.landmarks)` before
 * anything reads this table, and the numbers below are only what the
 * standalone `preview.html` sees when there is no `world` to ask. They are
 * kept in world metres, identical to `plan.js`, so a diff between the two is
 * visible rather than hidden behind an arithmetic conversion.
 */

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

export const LANDMARKS = [
  { id: 'lm_tower', name: 'Steel Tower', x: -208, z: -16, kind: 'tower', seed: 0x51ee1 },
  { id: 'lm_stadium', name: 'Steel Bowl', x: -416, z: -512, kind: 'stadium', seed: 0xb0417 },
  { id: 'lm_mill', name: 'Old Blast Furnace', x: 872, z: 248, kind: 'mill', seed: 0xf0e2 },
  { id: 'lm_incline', name: 'Duquesne Incline', x: -488, z: 296, kind: 'incline', seed: 0x1c11 },
  { id: 'lm_point', name: 'The Point Fountain', x: -452, z: 46, kind: 'fountain', seed: 0x9011 },
  { id: 'lm_market', name: 'Strip Market', x: 352, z: -224, kind: 'market', seed: 0x3a12 },
];

/**
 * Take the coordinates from `world.landmarks`, in place, so nothing that has
 * already captured a reference to `LANDMARKS` (or to one of its entries) can
 * end up reading the stale pair. `seed` stays ours — it is what makes each
 * landmark's weathering deterministic — and so does the build code; only
 * WHERE is adopted. Returns how many entries moved, so a divergence is
 * reported rather than silently absorbed.
 */
export function adoptLandmarkSites(published) {
  if (!Array.isArray(published)) return 0;
  let moved = 0;
  for (const lm of LANDMARKS) {
    const src = published.find((p) => p.id === lm.id);
    if (!src) continue;
    if (lm.x !== src.x || lm.z !== src.z) {
      console.warn(
        `[buildings] ${lm.id} moved to world's coordinate ` +
          `(${lm.x}, ${lm.z}) -> (${src.x}, ${src.z})`
      );
      moved++;
    }
    lm.x = src.x;
    lm.z = src.z;
    // The reserved footprint `world` keeps roads out of, when it publishes
    // one, and the uphill bearing it solved for a hill-oriented landmark.
    if (src.site) lm.site = src.site;
    if (src.uphill) lm.uphill = src.uphill;
    /**
     * The funicular TRACK DESCRIPTOR (`src/world/incline.js`), when `world`
     * has solved one. Adopted BY REFERENCE, deliberately: `incline()` emits
     * its trestle and rails from these exact arrays, and the `funicular`
     * subsystem poses its moving cars by sampling the same object off
     * `world.landmarks` — one authority, so the cars cannot drift off the
     * rails. `src/vehicles/funicularprobe.mjs` gates that.
     */
    if (src.funicular) lm.funicular = src.funicular;
  }
  return moved;
}

export function landmarksInBounds(x0, z0, x1, z1) {
  return LANDMARKS.filter((l) => l.x >= x0 && l.x < x1 && l.z >= z0 && l.z < z1);
}

/**
 * How much ground each landmark claims. Generated lots inside this are skipped
 * — a lot subdivision that does not know the Steel Bowl is there will happily
 * put a rowhouse through the middle of it, and the landmark is the one thing
 * in the city that must never be interpenetrated.
 */
const CLAIM = {
  lm_tower: 46,
  lm_stadium: 150,
  lm_mill: 92,
  lm_incline: 60,
  lm_point: 62,
  lm_market: 78,
};

export function landmarkClaims(x, z) {
  for (const l of LANDMARKS) {
    const r = CLAIM[l.id] ?? 40;
    /**
     * The incline is a long diagonal, so its claim is a corridor up the hill —
     * and this function has no terrain, while `incline()` now DISCOVERS which
     * way the hill is at build time. So the claim is symmetric about the
     * station: it used to reserve the −z corridor only, which is the direction
     * the trestle was wrongly built in, and once the trestle was turned round
     * to face the actual bluff the generated lots would have been subdivided
     * straight through it.
     */
    if (l.id === 'lm_incline') {
      if (x > l.x - 26 && x < l.x + 26 && z > l.z - 200 && z < l.z + 200) return true;
      continue;
    }
    if ((x - l.x) * (x - l.x) + (z - l.z) * (z - l.z) < r * r) return true;
  }
  return false;
}

// ------------------------------------------------------------------ utils --
function box(T, key, x, y, z, sx, sy, sz, ry = 0, masks = null, geo = null) {
  const g = geo ?? _sharedBox();
  trs(_m, x, y, z, ry, sx, sy, sz);
  T.add(key, g, _m, masks ? { masks } : null);
}

let _bx = null;
function _sharedBox() {
  if (!_bx) _bx = plainBox();
  return _bx;
}
let _cbx = null;
function _sharedChamfer() {
  if (!_cbx) _cbx = chamferBox(1, 1, 1, 0.02);
  return _cbx;
}

function cyl(T, key, x, y, z, r, h, seg = 16, masks = null, rTop = null) {
  const g = cylinderY(r, h, seg, rTop !== null ? { rTop } : {});
  trs(_m, x, y + h / 2, z, 0, 1, 1, 1);
  T.addOnce(key, g, _m, masks ? { masks } : null);
}

export function buildLandmark(T, lib, lm, rng, groundY = 0, groundAt = null) {
  const ga = groundAt ?? (() => groundY);
  switch (lm.kind) {
    case 'tower':
      return steelTower(T, lib, lm, rng, groundY);
    case 'stadium':
      return steelBowl(T, lib, lm, rng, groundY);
    case 'mill':
      return blastFurnace(T, lib, lm, rng, groundY);
    case 'incline':
      return incline(T, lib, lm, rng, groundY, ga);
    case 'fountain':
      return pointFountain(T, lib, lm, rng, groundY);
    case 'market':
      return stripMarket(T, lib, lm, rng, groundY);
    default:
      return null;
  }
}

// ------------------------------------------------------------ Steel Tower --
/**
 * The tallest building in Steel City: 64 storeys of dark steel and bronze
 * glass, chamfered corners, three setbacks and a lit mast. It is the one
 * silhouette every long view of downtown has to contain.
 */
function steelTower(T, lib, lm, rng, gy) {
  const x = lm.x;
  const z = lm.z;
  const floorH = 3.9;
  const stages = [
    { w: 52, d: 44, floors: 4, mat: 'stone_grey' },
    { w: 44, d: 38, floors: 26 },
    { w: 36, d: 31, floors: 18 },
    { w: 27, d: 24, floors: 12 },
  ];
  let y = gy;
  const glass = 'glass_bronze';
  const skin = 'steel_dark';

  for (let s = 0; s < stages.length; s++) {
    const st = stages[s];
    const h = st.floors * floorH;
    if (s === 0) {
      // podium: solid stone with a deep colonnade, so the tower has a base
      box(T, st.mat, x, y + h / 2, z, st.w, h, st.d, 0, [0.25, 0.35, 0.2], _sharedChamfer());
      const n = 9;
      for (let i = 0; i < n; i++) {
        const px = x - st.w / 2 + ((i + 0.5) / n) * st.w;
        box(T, 'stone_warm', px, y + h / 2, z + st.d / 2 + 0.9, 1.5, h, 1.5, 0, [0.35, 0.45, 0.25], _sharedChamfer());
      }
      box(T, 'stone_warm', x, y + h - 0.7, z, st.w + 3.4, 1.4, st.d + 3.4, 0, [0.4, 0.4, 0.2], _sharedChamfer());
      // glazed lobby behind the colonnade
      for (const sz of [-1, 1]) {
        box(T, glass, x, y + h * 0.45, z + sz * (st.d / 2 - 0.2), st.w - 4, h * 0.7, 0.2, 0, [0, 0.15, 0]);
        box(T, 'room_lit_cool', x, y + h * 0.45, z + sz * (st.d / 2 - 0.9), st.w - 4, h * 0.7, 0.2, 0, [0, 0.1, 0.4]);
      }
      y += h;
      continue;
    }

    // banded curtain wall on all four faces
    for (let f = 0; f < st.floors; f++) {
      const fy = y + f * floorH;
      // spandrel
      box(T, skin, x, fy + 0.55, z, st.w + 0.12, 1.1, st.d + 0.12, 0, [0.28, 0.3, 0.15]);
      // glazing
      box(T, glass, x, fy + 1.1 + (floorH - 1.1) / 2, z, st.w, floorH - 1.1, st.d, 0, [0, 0.15, 0]);
      box(T, 'room_office', x, fy + 1.1 + (floorH - 1.1) / 2, z, st.w - 1.6, floorH - 1.3, st.d - 1.6, 0, [0, 0.1, 0.45]);
    }
    // vertical fins on a 2.4 m module
    const finsW = Math.round(st.w / 2.4);
    const finsD = Math.round(st.d / 2.4);
    for (let i = 0; i <= finsW; i++) {
      const px = x - st.w / 2 + (i / finsW) * st.w;
      for (const sz of [-1, 1]) {
        box(T, 'alu_dark', px, y + h / 2, z + sz * (st.d / 2 + 0.14), 0.17, h, 0.42, 0, [0.35, 0.2, 0.1]);
      }
    }
    for (let i = 0; i <= finsD; i++) {
      const pz = z - st.d / 2 + (i / finsD) * st.d;
      for (const sx of [-1, 1]) {
        box(T, 'alu_dark', x + sx * (st.w / 2 + 0.14), y + h / 2, pz, 0.42, h, 0.17, 0, [0.35, 0.2, 0.1]);
      }
    }
    // chamfered corner piers — the tower's signature in profile
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        box(T, skin, x + sx * (st.w / 2 - 0.6), y + h / 2, z + sz * (st.d / 2 - 0.6), 2.6, h, 2.6, Math.PI / 4, [0.3, 0.3, 0.15], _sharedChamfer());
      }
    }
    // setback ledge
    box(T, 'concrete_dark', x, y + h + 0.35, z, st.w + 2.2, 0.7, st.d + 2.2, 0, [0.4, 0.45, 0.25], _sharedChamfer());
    y += h + 0.7;
  }

  // crown: stepped setbacks, a plant deck and the mast
  let cw = 22;
  let cd = 20;
  for (let i = 0; i < 3; i++) {
    box(T, 'steel_dark', x, y + 2.2, z, cw, 4.4, cd, 0, [0.35, 0.4, 0.2], _sharedChamfer());
    box(T, 'alu_dark', x, y + 4.6, z, cw + 1.2, 0.5, cd + 1.2, 0, [0.5, 0.35, 0.2]);
    y += 4.9;
    cw *= 0.76;
    cd *= 0.76;
  }
  cyl(T, 'alu_bright', x, y, z, 1.5, 6, 12, [0.4, 0.2, 0.1]);
  cyl(T, 'steel_dark', x, y + 6, z, 0.55, 22, 8, [0.4, 0.2, 0.1], 0.16);
  for (let i = 0; i < 4; i++) {
    box(T, 'neon_red', x, y + 8 + i * 5.2, z, 0.9, 0.5, 0.9, 0, [0, 0, 0]);
  }
  // roof plant on the podium
  T.put(Kit.acRoof(lib, 'alu_dark'), x + 16, gy + 4 * floorH, z + 14, 0.4, 2.2);
  T.put(Kit.vent(lib, 'steel_dark', 'stack'), x - 15, gy + 4 * floorH, z - 12, 0, 2.0);

  T.box('concrete', x, gy + 60, z, 46, 120, 40);
}

// -------------------------------------------------------------- Steel Bowl --
/** A 60 000-seat bowl: raked deck, ring of piers, cantilever canopy, masts. */
function steelBowl(T, lib, lm, rng, gy) {
  const x = lm.x;
  const z = lm.z;
  const RA = 108;
  const RB = 86;
  const N = 56;
  const bowlH = 32;

  const pier = _sharedChamfer();
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2;
    const a1 = ((i + 1) / N) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const ca = Math.cos(am);
    const sa = Math.sin(am);
    const segW = ((Math.PI * 2) / N) * ((RA + RB) / 2) * 1.02;

    // outer wall: a pier and a recessed bay, all the way round
    box(T, 'precast', x + ca * RA, gy + bowlH / 2, z + sa * RB, 3.4, bowlH, 3.0, -am, [0.3, 0.45, 0.25], pier);
    box(T, 'concrete_dark', x + ca * (RA - 1.4), gy + bowlH / 2 - 1, z + sa * (RB - 1.4), segW * 0.72, bowlH - 3, 2.0, -am, [0.2, 0.55, 0.45]);
    // concourse glazing at ground level
    box(T, 'glass_plain', x + ca * (RA - 1.2), gy + 4.2, z + sa * (RB - 1.2), segW * 0.7, 6.4, 0.4, -am, [0, 0.2, 0]);
    box(T, 'room_lit_cool', x + ca * (RA - 2.4), gy + 4.2, z + sa * (RB - 2.4), segW * 0.7, 6.4, 0.4, -am, [0, 0.1, 0.4]);

    // the raked seating deck, as a wedge sloping in toward the pitch
    const inner = 0.46;
    const rise = bowlH - 9;
    const geo = new THREE.BufferGeometry();
    const p0 = [x + Math.cos(a0) * RA, z + Math.sin(a0) * RB];
    const p1 = [x + Math.cos(a1) * RA, z + Math.sin(a1) * RB];
    const q0 = [x + Math.cos(a0) * RA * inner, z + Math.sin(a0) * RB * inner];
    const q1 = [x + Math.cos(a1) * RA * inner, z + Math.sin(a1) * RB * inner];
    const pos = [p0[0], gy + rise, p0[1], p1[0], gy + rise, p1[1], q1[0], gy + 2.4, q1[1], q0[0], gy + 2.4, q0[1]];
    const col = [0.2, 0.35, 0.2, 0.2, 0.35, 0.2, 0.1, 0.5, 0.6, 0.1, 0.5, 0.6];
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex([0, 2, 1, 0, 3, 2]);
    geo.computeVertexNormals();
    T.addOnce(i % 3 === 0 ? 'steel_green' : 'concrete_wall', geo, null);

    // canopy: a cantilever ring with a truss edge
    box(T, 'alu_dark', x + ca * (RA * 0.78), gy + bowlH + 5.5, z + sa * (RB * 0.78), segW * 0.98, 0.5, RA * 0.44, -am, [0.4, 0.3, 0.15]);
    box(T, 'steel_dark', x + ca * (RA + 1.2), gy + bowlH + 3.2, z + sa * (RB + 1.2), 0.55, 5.4, 0.55, -am, [0.4, 0.25, 0.12]);
    box(T, 'steel_dark', x + ca * (RA * 0.9), gy + bowlH + 4.4, z + sa * (RB * 0.9), 0.4, 0.4, RA * 0.34, -am, [0.4, 0.25, 0.12]);
  }

  // the pitch
  const pitch = new THREE.CircleGeometry(1, 40);
  pitch.rotateX(-Math.PI / 2);
  const pa = pitch.getAttribute('position');
  pitch.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pa.count * 3), 3));
  trs(_m, x, gy + 0.35, z, 0, RA * 0.44, 1, RB * 0.44);
  T.addOnce('render_green', pitch, _m, { masks: [0, 0.2, 0.1] });

  // floodlight masts
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.5;
    const mx = x + Math.cos(a) * (RA + 6);
    const mz = z + Math.sin(a) * (RB + 6);
    cyl(T, 'steel_dark', mx, gy, mz, 0.75, 52, 10, [0.4, 0.3, 0.15], 0.4);
    box(T, 'alu_dark', mx, gy + 54, mz, 9, 5, 1.4, -a, [0.4, 0.2, 0.1], pier);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 6; c++) {
        box(T, 'neon_amber', mx + (c - 2.5) * 1.4 * Math.sin(-a), gy + 52.6 + r * 1.5, mz + (c - 2.5) * 1.4 * Math.cos(-a), 1.1, 1.1, 0.3, -a, [0, 0, 0]);
      }
    }
  }
  /**
   * COLLISION IS THE RING, NOT THE SITE.
   *
   * This used to be one 224 x 180 x 32 m box over the whole bowl, and it is
   * what `roadsweep.mjs` blamed for more impassable directions than anything
   * else in the city. Three consequences, all bad: the pitch and the concourse
   * were solid, so nothing could ever be inside the stadium; a single hull that
   * size cannot be dropped or trimmed by the kerb keep-out without deleting the
   * stadium's collision entirely; and it swallowed every road that crosses the
   * site — which, because `world` lays its district grids without reserving the
   * landmark sites, is three highway segments and an alley.
   *
   * A ring of per-segment hulls matching the piers is the same barrier where
   * there IS a wall, lets the keep-out remove only the segments a carriageway
   * runs through, and leaves the bowl enterable.
   */
  for (let i = 0; i < N; i++) {
    const am = ((i + 0.5) / N) * Math.PI * 2;
    const ca = Math.cos(am);
    const sa = Math.sin(am);
    const segW = ((Math.PI * 2) / N) * ((RA + RB) / 2) * 1.02;
    T.box('concrete', x + ca * (RA - 0.7), gy + bowlH / 2, z + sa * (RB - 0.7),
      segW * 1.02, bowlH, 3.4, -am);
  }
}

// -------------------------------------------------------- Old Blast Furnace --
/**
 * The mill. A blast furnace is a vertical machine: the stack, four hot-blast
 * stoves beside it, the dust catcher, the skip hoist running up the side and a
 * conveyor bridge out to the ore yard. Rust everywhere.
 */
function blastFurnace(T, lib, lm, rng, gy) {
  const x = lm.x;
  const z = lm.z;

  // --- the furnace stack ---
  cyl(T, 'rust_deep', x, gy, z, 6.5, 12, 20, [0.7, 0.6, 0.3]);
  cyl(T, 'rust', x, gy + 12, z, 7.4, 16, 20, [0.75, 0.55, 0.3], 5.4);
  cyl(T, 'rust_deep', x, gy + 28, z, 5.4, 20, 20, [0.7, 0.6, 0.3], 4.4);
  cyl(T, 'rust', x, gy + 48, z, 4.4, 8, 20, [0.7, 0.5, 0.25], 3.2);
  cyl(T, 'corrugated_rust', x, gy + 56, z, 3.4, 10, 16, [0.75, 0.6, 0.3]);
  // bustle pipe
  const ring = new THREE.TorusGeometry(7.6, 0.85, 8, 24);
  ring.rotateX(Math.PI / 2);
  ring.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(new Float32Array(ring.getAttribute('position').count * 3).fill(0.4), 3)
  );
  trs(_m, x, gy + 20, z, 0, 1, 1, 1);
  T.addOnce('rust_deep', ring, _m);
  // tuyere downcomers
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    box(T, 'rust', x + Math.cos(a) * 7.0, gy + 16, z + Math.sin(a) * 7.0, 0.75, 8, 0.75, -a, [0.7, 0.6, 0.3], _sharedChamfer());
  }

  // --- four hot-blast stoves ---
  for (let i = 0; i < 4; i++) {
    const sx = x + 20 + (i % 2) * 15;
    const sz = z - 12 + Math.floor(i / 2) * 16;
    cyl(T, 'rust_deep', sx, gy, sz, 4.6, 40, 18, [0.7, 0.55, 0.3]);
    cyl(T, 'rust', sx, gy + 40, sz, 4.6, 5.5, 18, [0.7, 0.5, 0.25], 2.2);
    cyl(T, 'rust_deep', sx, gy + 45, sz, 1.1, 12, 10, [0.7, 0.5, 0.25]);
    for (let r = 0; r < 5; r++) {
      const rg = cylinderY(4.75, 0.5, 18, { open: true });
      trs(_m, sx, gy + 5 + r * 8, sz, 0, 1, 1, 1);
      T.addOnce('rust', rg, _m, { masks: [0.85, 0.55, 0.3] });
    }
    T.putS(Kit.ladder(lib, 'rust'), sx + 4.7, gy, sz, -Math.PI / 2, 1, 44, 1);
  }

  // --- dust catcher ---
  cyl(T, 'rust', x - 20, gy + 8, z + 6, 5.2, 14, 16, [0.75, 0.6, 0.3]);
  cyl(T, 'rust_deep', x - 20, gy + 2, z + 6, 5.2, 6, 16, [0.75, 0.6, 0.3], 1.4);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.7;
    box(T, 'rust_deep', x - 20 + Math.cos(a) * 4, gy + 1, z + 6 + Math.sin(a) * 4, 0.7, 2, 0.7, 0, [0.8, 0.6, 0.3]);
  }
  // downcomer from the stack top to the dust catcher
  box(T, 'rust', x - 10.5, gy + 44, z + 3, 22, 2.4, 2.4, 0, [0.75, 0.55, 0.3], _sharedChamfer());
  box(T, 'rust', x - 20, gy + 32, z + 6, 2.4, 24, 2.4, 0, [0.75, 0.55, 0.3], _sharedChamfer());

  // --- cast house ---
  const chW = 34;
  const chD = 20;
  box(T, 'corrugated_rust', x - 4, gy + 7, z + 24, chW, 14, chD, 0, [0.6, 0.65, 0.3], _sharedChamfer());
  for (let i = 0; i < 5; i++) {
    box(T, 'rust_deep', x - 4 - chW / 2 + (i / 4) * chW, gy + 15.6, z + 24, 1.1, 3.2, chD + 1, 0, [0.8, 0.6, 0.3]);
  }
  box(T, 'roof_metal', x - 4, gy + 14.4, z + 24, chW + 1.5, 0.7, chD + 1.5, 0, [0.5, 0.6, 0.3]);

  // --- skip hoist: the inclined bridge up the side of the furnace ---
  const hl = 46;
  const ang = 0.72;
  for (const s of [-1, 1]) {
    box(T, 'rust_deep', x - 16, gy + 20, z - 18 + s * 1.6, 2.0, 1.0, hl, 0, [0.8, 0.6, 0.3], _sharedChamfer());
  }
  trs(_m, x - 15, gy + 22, z - 20, 0, 1, 1, 1);
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    T.put(Kit.truss(lib, 'rust_deep'), x - 15 + t * 12, gy + 6 + t * 34, z - 34 + t * 22, Math.PI / 2, 1);
  }

  // --- stacks and gantries ---
  for (let i = 0; i < 3; i++) {
    cyl(T, 'brick_dark', x - 34 - i * 9, gy, z - 20 - i * 5, 2.6 - i * 0.3, 44 - i * 6, 14, [0.6, 0.65, 0.35], 2.0 - i * 0.25);
  }
  for (let i = 0; i < 8; i++) {
    T.put(Kit.truss(lib, 'rust'), x - 44 + i * 4, gy + 15, z + 40, 0, 1);
    box(T, 'rust_deep', x - 44 + i * 4, gy + 7.5, z + 40, 1.2, 15, 1.2, 0, [0.85, 0.6, 0.3]);
  }
  // silos in the ore yard
  for (let i = 0; i < 4; i++) {
    T.putS(Kit.silo(lib, 'corrugated_rust'), x + 46, gy, z + 20 + i * 9.5, 0, 4.2, 18, 4.2);
  }

  /**
   * COLLISION. The stack and the cast house were the only two things here with
   * a shell, so a man walked through four 40 m hot-blast stoves, the dust
   * catcher, three brick stacks and the ore-yard silos as if they were smoke —
   * measured by `solidprobe.mjs` at 10 of 14 bearings sealed. Every vessel
   * below is a solid steel pressure shell in the picture and gets one box; the
   * gantries, the skip hoist and the tuyere pipework deliberately do NOT,
   * because you can walk under all three and a proxy there would be an
   * invisible wall across the yard.
   */
  T.box('metal', x, gy + 30, z, 18, 60, 18);
  T.box('metal', x - 4, gy + 7, z + 24, chW, 14, chD);
  for (let i = 0; i < 4; i++) {
    const sx = x + 20 + (i % 2) * 15;
    const sz = z - 12 + Math.floor(i / 2) * 16;
    T.box('metal', sx, gy + 22.5, sz, 8.4, 45, 8.4);
  }
  T.box('metal', x - 20, gy + 9, z + 6, 9.4, 20, 9.4);
  for (let i = 0; i < 3; i++) {
    const r = 2.6 - i * 0.3;
    T.box('concrete', x - 34 - i * 9, gy + (44 - i * 6) / 2, z - 20 - i * 5, r * 1.8, 44 - i * 6, r * 1.8);
  }
  for (let i = 0; i < 4; i++) T.box('metal', x + 46, gy + 9, z + 20 + i * 9.5, 7.6, 18, 7.6);
}

// --------------------------------------------------------- Duquesne Incline --
/**
 * A working funicular. Two station houses, a timber trestle up the cliff and
 * two cars that pass each other in the middle — the car meshes are static
 * here; `world` or `game` can drive them along the track later.
 *
 * THIS RAN THE WRONG WAY UP THE WRONG HILL.
 *
 * The old code took ONE ground sample at the lower station and then
 * extrapolated a straight ramp of a hardcoded `rise = 122` over `run = 168` in
 * the −z direction, with bents standing on fixed 4–7 m legs. At this landmark's
 * authored position (−488, 296) the hill is at INCREASING z — the ground climbs
 * from y=8.1 at z=300 to y=104.4 at z=480 — so the trestle set off in exactly
 * the opposite direction, straight out over the Monongahela. Measured along its
 * own run: t=0.63 already over water, and by the top of the run the track sat
 * 141.6 m above the terrain and 130 m above open water.
 *
 * That single bug produced all three artifacts:
 *   - "a bridge rendered as disconnected floating truss frames with no deck" —
 *     the bents, every 9 m, on stub legs, over the river;
 *   - two cables hanging in mid-air — the rails;
 *   - "floating cubes in the sky" — the upper station and the two cars, 130 m
 *     up over the water.
 * Hiding `buildings.root` removed all of it and left a clean `world` bridge, so
 * the earlier conclusion that "the bridges are `world`'s" was right about the
 * bridge and wrong about what was floating over it.
 *
 * Now: the uphill bearing is FOUND by probing the terrain rather than assumed,
 * the rise is whatever the hill actually does, and every bent stands on the
 * real ground under it. A funicular on a bench-shaped bluff cannot be a single
 * straight chord — a chord across this one is a 40 m stilt in the middle and
 * buried 10 m further up — so the track is a graded polyline that follows the
 * hill, which is also what a timber trestle is.
 */
/**
 * FALLBACK track solve for the two callers that have no `world` to ask: the
 * standalone `preview.html` and `prewarmMaterials`' scratch build (which
 * passes a flat groundAt — its geometry only exists to touch materials).
 *
 * The SHIPPED path never runs this. `world` solves the descriptor once in
 * `src/world/incline.js` (`publishInclineTracks`, called from
 * `WorldSystem.init` after `orientLandmarkSites`) and publishes it as
 * `world.landmarks[].funicular.track`; `adoptLandmarkSites` copies the
 * reference and `incline()` emits from it, so the trestle, the rails and the
 * moving cars all read the same arrays. This copy of the math exists ONLY so
 * the preview keeps working without a world, and it reproduces the historical
 * behaviour verbatim — including the bearing scan `netgen.orientLandmarkSites`
 * superseded (see the long note there for why the scan must not be primary).
 */
function _fallbackInclineTrack(lm, gy, groundAt) {
  const x = lm.x;
  const z = lm.z;
  const RUN = lm.uphill?.run ?? 180;
  const MIN_CLEAR = 2.2;
  const MAX_LEG = 15;

  let dirX = lm.uphill?.dir?.[0] ?? 0;
  let dirZ = lm.uphill?.dir?.[1] ?? 0;
  if (!Number.isFinite(dirX) || !Number.isFinite(dirZ) || (dirX === 0 && dirZ === 0)) {
    let bestScore = -Infinity;
    dirX = 0;
    dirZ = 1;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const sx = Math.sin(a);
      const sz = Math.cos(a);
      let score = 0;
      let prev = gy;
      for (let k = 1; k <= 8; k++) {
        const h = groundAt(x + sx * (k / 8) * RUN, z + sz * (k / 8) * RUN);
        // Reward climbing, punish any descent — an incline goes UP the whole way.
        score += (h - prev) - Math.max(0, prev - h) * 3;
        prev = h;
      }
      if (score > bestScore) {
        bestScore = score;
        dirX = sx;
        dirZ = sz;
      }
    }
  }

  // The track profile: one node per bent, riding MIN_CLEAR above the ground and
  // then smoothed, so the rails read as a graded ramp rather than a terrain
  // sample. Monotonic, because a funicular does not go back downhill.
  const bents = Math.max(6, Math.round(RUN / 9));
  const px = new Array(bents + 1);
  const pz = new Array(bents + 1);
  const gnd = new Array(bents + 1);
  const py = new Array(bents + 1);
  for (let i = 0; i <= bents; i++) {
    const t = i / bents;
    px[i] = x + dirX * t * RUN;
    pz[i] = z + dirZ * t * RUN;
    gnd[i] = groundAt(px[i], pz[i]);
    py[i] = gnd[i] + MIN_CLEAR;
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < bents; i++) py[i] = (py[i - 1] + py[i] * 2 + py[i + 1]) * 0.25;
    for (let i = 0; i <= bents; i++) {
      if (py[i] < gnd[i] + MIN_CLEAR) py[i] = gnd[i] + MIN_CLEAR;
      if (i && py[i] < py[i - 1]) py[i] = py[i - 1];
      if (py[i] > gnd[i] + MAX_LEG) py[i] = gnd[i] + MAX_LEG;
    }
  }
  py[0] = gy + MIN_CLEAR;

  const rx = dirZ;
  const rz = -dirX;
  const yaw = Math.atan2(dirX, dirZ);
  const at = (r, a, out) => {
    out = out ?? { x: 0, z: 0 };
    out.x = x + rx * r + dirX * a;
    out.z = z + rz * r + dirZ * a;
    return out;
  };
  const trackY = (a) => {
    const f = Math.max(0, Math.min(bents, (a / RUN) * bents));
    const i = Math.min(bents - 1, Math.floor(f));
    return py[i] + (py[i + 1] - py[i]) * (f - i);
  };
  const pitchAt = (a, h = 4) => -Math.atan2(trackY(a + h) - trackY(a - h), 2 * h);
  return { x, z, dirX, dirZ, rx, rz, run: RUN, yaw, bents, px, pz, gnd, py, gauge: 3.2, carLift: 1.2, at, trackY, pitchAt };
}

function incline(T, lib, lm, rng, gy, groundAt) {
  const x = lm.x;
  const z = lm.z;

  /**
   * THE TRACK IS NOT THIS FUNCTION'S DECISION ANY MORE. `world` publishes the
   * solved descriptor (`src/world/incline.js`) and everything here EMITS from
   * its arrays — the same arrays the `funicular` subsystem samples every frame
   * to move the two cars. The fallback solve only runs where no world exists
   * (preview, prewarm); see `_fallbackInclineTrack`.
   */
  const trk = lm.funicular?.track ?? _fallbackInclineTrack(lm, gy, groundAt);
  const { px, pz, gnd, py, bents } = trk;
  const RUN = trk.run;
  /** Yaw that puts a box's local +Z along the climb. */
  const yawUp = trk.yaw;
  /** World point `r` metres right of the track and `a` metres up the run. */
  const at = (r, a) => trk.at(r, a);
  /** Track height at along-distance `a`, interpolated between bents. */
  const trackY = trk.trackY;

  // lower station, square to the track
  box(T, 'brick_dark', x, gy + 5, z, 16, 10, 12, yawUp, [0.4, 0.5, 0.3], _sharedChamfer());
  box(T, 'roof_shingle', x, gy + 10.6, z, 18, 1.2, 14, yawUp, [0.4, 0.5, 0.25], _sharedChamfer());
  box(T, 'trim_red', x, gy + 11.6, z, 6, 1.4, 6, yawUp, [0.5, 0.4, 0.2], _sharedChamfer());
  for (const s of [-1, 1]) {
    const q = at(s * 4, -6.1);
    box(T, 'glass_plain', q.x, gy + 5.5, q.z, 4.5, 5, 0.2, yawUp, [0, 0.25, 0]);
    const q2 = at(s * 4, -5.4);
    box(T, 'room_lit_warm', q2.x, gy + 5.5, q2.z, 4.5, 5, 0.2, yawUp, [0, 0.1, 0.4]);
  }

  // upper station, standing on the ground the track actually reaches
  const up = at(0, RUN);
  const ux = up.x;
  const uz = up.z;
  const uy = gnd[bents];
  box(T, 'timber_dark', ux, uy + 6, uz, 18, 12, 14, yawUp, [0.5, 0.5, 0.3], _sharedChamfer());
  box(T, 'roof_shingle', ux, uy + 12.6, uz, 20, 1.4, 16, yawUp, [0.4, 0.5, 0.25], _sharedChamfer());
  box(T, 'trim_white', ux, uy + 13.8, uz, 4.5, 3.2, 4.5, yawUp, [0.5, 0.4, 0.2], _sharedChamfer());

  // trestle: a bent every 9 m, each one standing on the ground beneath IT
  for (let i = 0; i <= bents; i++) {
    const a = (i / bents) * RUN;
    const top = py[i];
    const gh = Math.max(1.2, top - gnd[i]);
    for (const s of [-1, 1]) {
      const q = at(s * 3.2, a);
      box(T, 'timber_dark', q.x, top - gh / 2, q.z, 0.55, gh, 0.55, yawUp, [0.7, 0.6, 0.35]);
    }
    const c = at(0, a);
    box(T, 'timber_dark', c.x, top - gh + 0.3, c.z, 7.4, 0.5, 0.5, yawUp, [0.7, 0.6, 0.35]);
  }
  /**
   * Rails and stringers as ONE BOX PER BAY rather than one long scaled box.
   * The track is a polyline now, and a single box across a bench-shaped bluff
   * is exactly the "two cables hanging in mid-air" the critics photographed.
   */
  const bay = RUN / bents;
  for (let i = 0; i < bents; i++) {
    const a0 = i * bay;
    const a1 = a0 + bay;
    const y0 = py[i];
    const y1 = py[i + 1];
    const seg = Math.hypot(bay, y1 - y0);
    const pitch = -Math.atan2(y1 - y0, bay);
    const mid = at(0, (a0 + a1) * 0.5);
    for (const s of [-1, 1]) {
      const q = at(s * 3.2, (a0 + a1) * 0.5);
      const rm = new THREE.Matrix4()
        .makeTranslation(q.x, (y0 + y1) * 0.5 + 0.2, q.z)
        .multiply(new THREE.Matrix4().makeRotationY(yawUp))
        .multiply(new THREE.Matrix4().makeRotationX(pitch))
        .multiply(new THREE.Matrix4().makeScale(0.34, 0.34, seg));
      T.add('steel_light', _sharedBox(), rm, { masks: [0.9, 0.3, 0.1] });
    }
    // longitudinal stringer under the deck
    const sm = new THREE.Matrix4()
      .makeTranslation(mid.x, (y0 + y1) * 0.5 - 0.6, mid.z)
      .multiply(new THREE.Matrix4().makeRotationY(yawUp))
      .multiply(new THREE.Matrix4().makeRotationX(pitch))
      .multiply(new THREE.Matrix4().makeScale(0.4, 0.4, seg));
    T.add('timber', _sharedChamfer(), sm, { masks: [0.7, 0.6, 0.35] });
  }
  // sleepers
  for (let i = 0; i < bents * 3; i++) {
    const a = (i / (bents * 3)) * RUN;
    const q = at(0, a);
    box(T, 'timber_dark', q.x, trackY(a), q.z, 8, 0.22, 0.5, yawUp, [0.8, 0.7, 0.4]);
  }

  /**
   * NO STATIC CARS. Two counterweighted cars used to be baked in here,
   * frozen mid-pass at t = 0.34 and 0.66. They are now LIVE: the `funicular`
   * subsystem (`src/vehicles/funicular.js`) builds the red-and-yellow cars
   * and runs them up and down this exact track every frame, sampling the same
   * published descriptor these rails were just emitted from. Baking a third
   * pair here would put ghost cars inside the moving ones.
   */

  T.box('wood', x, gy + 5, z, 16, 10, 12);
  T.box('wood', ux, uy + 6, uz, 18, 12, 14);
}

// ------------------------------------------------------- The Point Fountain --
/** A 60 m basin, a raised plinth and a nozzle ring, with a granite apron. */
function pointFountain(T, lib, lm, rng, gy) {
  const x = lm.x;
  const z = lm.z;
  const R = 30;

  const apron = new THREE.RingGeometry(R, R + 14, 64, 1);
  apron.rotateX(-Math.PI / 2);
  apron.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(new Float32Array(apron.getAttribute('position').count * 3).fill(0.25), 3)
  );
  trs(_m, x, gy + 0.06, z, 0, 1, 1, 1);
  T.addOnce('stone_grey', apron, _m);

  // basin wall
  const wall = cylinderY(R, 1.1, 64, { open: true });
  trs(_m, x, gy + 0.55, z, 0, 1, 1, 1);
  T.addOnce('stone_warm', wall, _m, { masks: [0.55, 0.6, 0.3] });
  const cap = new THREE.TorusGeometry(R, 0.34, 8, 64);
  cap.rotateX(Math.PI / 2);
  cap.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(new Float32Array(cap.getAttribute('position').count * 3).fill(0.45), 3)
  );
  trs(_m, x, gy + 1.12, z, 0, 1, 1, 1);
  T.addOnce('stone_grey', cap, _m);

  // water plane
  const water = new THREE.CircleGeometry(R - 0.4, 64);
  water.rotateX(-Math.PI / 2);
  water.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(new Float32Array(water.getAttribute('position').count * 3), 3)
  );
  trs(_m, x, gy + 0.75, z, 0, 1, 1, 1);
  T.addOnce('glass_sky', water, _m, { masks: [0, 0.1, 0] });

  // centre plinth and nozzle
  cyl(T, 'stone_grey', x, gy + 0.4, z, 6.5, 1.6, 32, [0.5, 0.55, 0.3]);
  cyl(T, 'stone_warm', x, gy + 2.0, z, 4.2, 1.2, 32, [0.5, 0.55, 0.3], 3.4);
  cyl(T, 'alu_bright', x, gy + 3.2, z, 0.55, 2.6, 12, [0.5, 0.25, 0.1], 0.3);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    cyl(T, 'alu_bright', x + Math.cos(a) * 5.4, gy + 1.9, z + Math.sin(a) * 5.4, 0.11, 0.55, 6, [0.6, 0.3, 0.1]);
  }
  // bollard ring and benches
  const bol = Kit.bollard(lib, 'steel_dark');
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    T.put(bol, x + Math.cos(a) * (R + 12), gy, z + Math.sin(a) * (R + 12), 0, 1);
  }
  T.box('concrete', x, gy + 0.55, z, R * 2, 1.1, R * 2);
}

// ------------------------------------------------------------ Strip Market --
/**
 * A market shed: a long steel-trussed hall open on both sides, a brick head
 * building at one end, and a row of awninged stalls down each side.
 */
function stripMarket(T, lib, lm, rng, gy) {
  const x = lm.x;
  const z = lm.z;
  const L = 96;
  const W = 30;
  const H = 11;

  // head building
  box(T, 'brick_red', x, gy + 7, z - L / 2 - 8, W + 6, 14, 16, 0, [0.35, 0.5, 0.3], _sharedChamfer());
  box(T, 'stone_grey', x, gy + 14.4, z - L / 2 - 8, W + 8, 1.1, 18, 0, [0.5, 0.5, 0.3], _sharedChamfer());
  for (let i = 0; i < 5; i++) {
    const px = x - 12 + i * 6;
    box(T, 'glass_grimy', px, gy + 8.5, z - L / 2 - 0.2, 3.4, 4.2, 0.3, 0, [0, 0.3, 0]);
    box(T, 'room_dark', px, gy + 8.5, z - L / 2 - 0.9, 3.4, 4.2, 0.3, 0, [0, 0.1, 0.5]);
  }
  box(T, 'sign_board', x, gy + 12.4, z - L / 2 - 0.1, 20, 2.4, 0.5, 0, [0.5, 0.5, 0.3], _sharedChamfer());
  T.putS(Kit.signFace(lib, 'neon_amber'), x, gy + 12.4, z - L / 2 + 0.25, 0, 16, 1.4, 1);

  // the hall: portal frames every 6 m
  const bays = Math.round(L / 6);
  for (let i = 0; i <= bays; i++) {
    const pz = z - L / 2 + (i / bays) * L;
    for (const s of [-1, 1]) {
      box(T, 'steel_green', x + s * (W / 2), gy + H / 2, pz, 0.7, H, 0.7, 0, [0.6, 0.5, 0.25], _sharedChamfer());
      box(T, 'steel_green', x + s * (W / 4), gy + H + 1.3, pz, W / 2, 0.4, 0.4, 0, [0.6, 0.4, 0.2]);
    }
    T.putS(Kit.truss(lib, 'steel_green'), x, gy + H, pz, 0, W / 8.1, 1, 1);
  }
  // roof: two pitches with a raised monitor
  for (const s of [-1, 1]) {
    const rm = new THREE.Matrix4()
      .makeTranslation(x + s * (W / 4), gy + H + 2.5, z)
      .multiply(new THREE.Matrix4().makeRotationZ(s * 0.16))
      .multiply(new THREE.Matrix4().makeScale(W / 2 + 1.5, 0.3, L + 2));
    T.add('roof_metal', _sharedBox(), rm, { masks: [0.45, 0.5, 0.25] });
  }
  box(T, 'roof_metal', x, gy + H + 4.6, z, 6, 0.3, L, 0, [0.45, 0.5, 0.25]);
  for (const s of [-1, 1]) {
    box(T, 'glass_grimy', x + s * 3, gy + H + 3.6, z, 0.3, 2, L, 0, [0, 0.35, 0]);
  }

  // stalls down both sides
  const awn = Kit.awning(lib, rng.pick(['awning_canvas', 'awning_green', 'awning_navy']));
  const awnF = Kit.awningFrame(lib, 'steel_dark');
  for (let i = 0; i < bays; i++) {
    const pz = z - L / 2 + ((i + 0.5) / bays) * L;
    for (const s of [-1, 1]) {
      const sx = x + s * (W / 2 - 2.4);
      box(T, 'timber', sx, gy + 0.9, pz, 3.2, 1.8, 4.6, 0, [0.7, 0.6, 0.3], _sharedChamfer());
      box(T, 'timber_dark', sx, gy + 1.86, pz, 3.6, 0.14, 5.0, 0, [0.75, 0.6, 0.3]);
      const rot = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      T.putS(awn, sx - s * 1.8, gy + 3.4, pz, rot, 4.6, 1, 1);
      T.putS(awnF, sx - s * 1.8, gy + 3.4, pz, rot, 4.6, 1, 1);
      if ((i + (s > 0 ? 0 : 1)) % 3 === 0) {
        T.putS(Kit.signFace(lib, rng.pick(['neon_amber', 'neon_teal', 'neon_red'])), sx - s * 1.6, gy + 4.2, pz, rot, 2.6, 0.6, 1);
      }
    }
  }
  T.box('concrete', x, gy + 7, z - L / 2 - 8, W + 6, 14, 16);
  for (let i = 0; i <= bays; i++) {
    const pz = z - L / 2 + (i / bays) * L;
    for (const s of [-1, 1]) T.box('metal', x + s * (W / 2), gy + H / 2, pz, 0.7, H, 0.7);
  }
}
