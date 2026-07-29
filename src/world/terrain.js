import {
  RIVERS, DISTRICTS, HILLS, BLUFF,
  WATER_Y, RIVER_BED, RIVER_SHORE, RIVER_BANK,
  clamp01, smoothstep, smootherstep, lerp, segDist2,
} from './plan.js';

/**
 * WORLD — the heightfield.
 *
 * Steel City is three river valleys meeting at The Point, a 104 m bluff on the
 * south bank (Mt. Washington), hilltop neighbourhoods north and west, and flat
 * dredged riverfront where the mills are. All of that is one analytic function,
 * `rawHeight`, composed in a fixed order:
 *
 *   rolling country  ->  radial hills  ->  the Mt. Washington bluff
 *      ->  district pads (flat tops)  ->  river carve  ->  road corridors
 *
 * `rawHeight` costs ~0.6 us, which is too much for the tens of thousands of
 * queries a frame of traffic + peds + vehicles makes, so it is baked ONCE into
 * an 8 m grid at init and `heightAt` is a bilinear fetch plus a cheap two-octave
 * detail term. Everything (terrain mesh, physics proxies, road profiles, lot
 * placement) reads `heightAt`, so there is exactly one answer in the system.
 *
 * Outside the baked extent the analytic function is used directly, which is
 * where the rim hills that give the horizon a silhouette live.
 */

/* ------------------------------------------------------------------ noise -- */

/** 2D integer hash -> [0,1). Deterministic, no Math.random. */
function h2(ix, iz) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 2D value noise, unit period. Four hashes — the hot path. */
function vnoise(x, z) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  let fx = x - xi;
  let fz = z - zi;
  fx = fx * fx * (3 - 2 * fx);
  fz = fz * fz * (3 - 2 * fz);
  const a = h2(xi, zi);
  const b = h2(xi + 1, zi);
  const c = h2(xi, zi + 1);
  const d = h2(xi + 1, zi + 1);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

function fbm2(x, z, oct = 4, lac = 2.07, gain = 0.5) {
  let a = 1;
  let s = 0;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    s += vnoise(x, z) * a;
    n += a;
    a *= gain;
    x *= lac;
    z *= lac;
  }
  return s / n;
}

/**
 * Where a river channel starts and finishes dissolving into the rim hills,
 * as a Chebyshev radius from the origin. Both are well past `HALF_CITY`, so no
 * navigable water, no bridge and no bank is inside the fade.
 */
const RIVER_FADE0 = 1700;
const RIVER_FADE1 = 2200;

/**
 * Band limits, both in metres of wavelength. `DETAIL_NYQUIST` is the sample
 * step past which `_detail` is pure aliasing; `RIM_OCT0` is the wavelength of
 * the rim's first ridged octave, from which the rest fall by the 2.11 lacunarity.
 */
const DETAIL_NYQUIST = 14;
const RIM_OCT0 = 625;

/** Ridged noise — sharper crests, for the rim hills that close the horizon. */
function ridge2(x, z, oct = 3) {
  let a = 1;
  let s = 0;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    const v = 1 - Math.abs(vnoise(x, z) * 2 - 1);
    s += v * v * a;
    n += a;
    a *= 0.52;
    x *= 2.11;
    z *= 2.03;
  }
  return s / n;
}

/* ------------------------------------------------------------------ river -- */

/** Flattened segment table: [ax, az, bx, bz, halfWidth, riverIndex] per row. */
const RSEG = [];
for (let r = 0; r < RIVERS.length; r++) {
  const riv = RIVERS[r];
  const hw = riv.width / 2;
  for (let i = 0; i < riv.pts.length - 1; i++) {
    const a = riv.pts[i];
    const b = riv.pts[i + 1];
    RSEG.push(a[0], a[1], b[0], b[1], hw, r);
  }
}
const RSEG_N = RSEG.length / 6;

const _seg = { d2: 0, t: 0 };

/**
 * Nearest river. `out.s` is the signed distance to the waterline (negative in
 * the water), `out.d` distance to the centreline, `out.hw` the half width and
 * `out.river` the index. The confluence is handled by taking the most-inside
 * river, so three overlapping channels merge into one basin rather than a
 * ridge where their banks cross.
 */
export function riverAt(x, z, out = { s: 1e9, d: 1e9, hw: 0, river: -1 }) {
  let bestS = 1e9;
  let bestD = 1e9;
  let bestHw = 0;
  let bestR = -1;
  for (let i = 0; i < RSEG_N; i++) {
    const o = i * 6;
    const ax = RSEG[o];
    // Cheap reject: the segment's bounding box padded by the widest shore.
    const bx = RSEG[o + 2];
    if (x < (ax < bx ? ax : bx) - 300 || x > (ax > bx ? ax : bx) + 300) continue;
    const az = RSEG[o + 1];
    const bz = RSEG[o + 3];
    if (z < (az < bz ? az : bz) - 300 || z > (az > bz ? az : bz) + 300) continue;
    segDist2(x, z, ax, az, bx, bz, _seg);
    const hw = RSEG[o + 4];
    const d = Math.sqrt(_seg.d2);
    const s = d - hw;
    if (s < bestS) {
      bestS = s;
      bestD = d;
      bestHw = hw;
      bestR = RSEG[o + 5];
    }
  }
  out.s = bestS;
  out.d = bestD;
  out.hw = bestHw;
  out.river = bestR;
  return out;
}

const _riv = { s: 0, d: 0, hw: 0, river: -1 };

/* ------------------------------------------------------------------ bluff -- */

const BSEG = [];
for (let i = 0; i < BLUFF.line.length - 1; i++) {
  const a = BLUFF.line[i];
  const b = BLUFF.line[i + 1];
  BSEG.push(a[0], a[1], b[0], b[1]);
}
let BLUFF_LEN = 0;
const BSEG_S = [];
for (let i = 0; i < BSEG.length; i += 4) {
  BSEG_S.push(BLUFF_LEN);
  BLUFF_LEN += Math.hypot(BSEG[i + 2] - BSEG[i], BSEG[i + 3] - BSEG[i + 1]);
}

/**
 * Signed distance south of the bluff line, and the arc length along it.
 * Positive `s` means inland (up the hill).
 */
function bluffAt(x, z, out) {
  let bd2 = 1e18;
  let bs = 0;
  let bside = 1;
  let barc = 0;
  for (let i = 0, k = 0; i < BSEG.length; i += 4, k++) {
    const ax = BSEG[i];
    const az = BSEG[i + 1];
    const bx = BSEG[i + 2];
    const bz = BSEG[i + 3];
    segDist2(x, z, ax, az, bx, bz, _seg);
    if (_seg.d2 < bd2) {
      bd2 = _seg.d2;
      const dx = bx - ax;
      const dz = bz - az;
      // Cross product sign: positive => the point lies to the south-east of the
      // ridge, i.e. up the hill.
      bside = dx * (z - az) - dz * (x - ax) > 0 ? 1 : -1;
      barc = BSEG_S[k] + _seg.t * Math.hypot(dx, dz);
      bs = Math.sqrt(bd2);
    }
  }
  out.s = bs * bside;
  out.arc = barc;
  return out;
}

const _bl = { s: 0, arc: 0 };

/* ----------------------------------------------------------------- height -- */

const PAD = DISTRICTS.filter((d) => d.pad !== null);

/**
 * The analytic heightfield, before roads. Everything else in the file is a
 * cache in front of this.
 */
export function rawHeight(x, z, spacing = 0) {
  // ---- rolling country -------------------------------------------------
  let h =
    2 +
    (fbm2(x * 0.00085, z * 0.00085, 4) - 0.5) * 62 +
    (fbm2(x * 0.0042 + 31, z * 0.0042 - 17, 3) - 0.5) * 13;

  // ---- radial hills ----------------------------------------------------
  for (let i = 0; i < HILLS.length; i++) {
    const hl = HILLS[i];
    const dx = x - hl.x;
    const dz = z - hl.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < hl.r) h += hl.h * smootherstep(1 - d / hl.r);
  }

  // ---- the rim: hills beyond the city, so the horizon has a silhouette --
  const rr = Math.max(Math.abs(x), Math.abs(z));
  if (rr > 1180) {
    const t = smootherstep((rr - 1180) / 900);
    // The rim's four ridged octaves sit at wavelengths of roughly 625, 296,
    // 140 and 66 m. A 64 m LOD grid advances 0.46 cycles per sample through
    // the 140 m octave — within 5% of Nyquist, the textbook recipe for a
    // checkerboard with a slow beat — and the 66 m octave is folded outright.
    // Both carry +-29 m and +-15 m, which is why the far rim reads as
    // rectangular patches disagreeing by tens of metres. Drop the octaves the
    // caller's grid cannot carry; the silhouette is in the first two.
    const oct = spacing > 0 ? Math.max(1, Math.min(4, Math.floor(Math.log2(RIM_OCT0 / (2.2 * spacing)) / 1.078) + 1)) : 4;
    h += t * (26 + ridge2(x * 0.0016, z * 0.0016, oct) * 210);
  }

  // ---- Mt. Washington --------------------------------------------------
  bluffAt(x, z, _bl);
  if (_bl.s > -60 && _bl.arc > -BLUFF.taper && _bl.arc < BLUFF_LEN + BLUFF.taper) {
    const climb = smootherstep(_bl.s / BLUFF.run);
    const back = 1 - smootherstep((_bl.s - BLUFF.depth) / BLUFF.fall);
    const endA = smootherstep(_bl.arc / BLUFF.taper);
    const endB = 1 - smootherstep((_bl.arc - (BLUFF_LEN - BLUFF.taper)) / BLUFF.taper);
    const w = climb * back * endA * endB;
    if (w > 0) {
      // A cliff is not a smooth ramp: break the face up with steeper noise so
      // the exposed rock has ledges in it.
      const rough = (fbm2(x * 0.012, z * 0.012, 3) - 0.5) * 16 * climb * (1 - climb) * 4;
      h = h * (1 - w * 0.55) + (BLUFF.rise + rough) * w;
    }
  }

  // ---- district pads: flat tops for the neighbourhoods -----------------
  for (let i = 0; i < PAD.length; i++) {
    const d = PAD[i];
    const dx = x - d.x;
    const dz = z - d.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > d.r) continue;
    const w = smootherstep((d.r - dist) / d.edge);
    if (w <= 0) continue;
    // The pad is not a table: keep a metre or two of local relief in it.
    const wobble = (fbm2(x * 0.0031 + 7, z * 0.0031 + 3, 2) - 0.5) * 5.5;
    h = lerp(h, d.pad + wobble, w * 0.94);
  }

  // ---- the rivers ------------------------------------------------------
  riverAt(x, z, _riv);
  if (_riv.s < RIVER_SHORE) {
    let ry;
    let w;
    if (_riv.s <= 0) {
      const t = _riv.d / _riv.hw;
      ry = WATER_Y + RIVER_BED * (1 - t * t);
      w = 1;
    } else {
      const t = _riv.s / RIVER_SHORE;
      ry = WATER_Y + RIVER_BANK * smootherstep(t);
      w = 1 - smootherstep(t);
    }
    // FADE THE CARVE OUT PAST THE MAP EDGE. `segDist2` clamps its parameter,
    // so beyond a river's last vertex the channel becomes a DISC of radius
    // `hw + RIVER_SHORE` — and the carve is unconditional, so that disc is cut
    // to RIVER_BED whatever the ground around it is doing. Out in the rim-hill
    // band that ground is 100-155 m up, and the result was the elliptical
    // crater on the right of `farview`. Nothing out here is reachable, water is
    // only drawn to the map edge, and the horizon wants a ridge rather than a
    // gorge, so let the channel dissolve back into the hills.
    const rr = Math.max(Math.abs(x), Math.abs(z));
    if (rr > RIVER_FADE0) w *= 1 - smootherstep((rr - RIVER_FADE0) / (RIVER_FADE1 - RIVER_FADE0));
    if (w > 0) h = lerp(h, ry, w);
  }

  return h;
}

/* ------------------------------------------------------------------ class -- */

export class Terrain {
  /**
   * @param {object} opts { cell, extent } — extent is the half-size of the
   *   baked grid; outside it `rawHeight` is used directly.
   */
  constructor(opts = {}) {
    this.cell = opts.cell ?? 6;
    this.extent = opts.extent ?? 1792;
    this.n = Math.round((this.extent * 2) / this.cell) + 1;
    this.origin = -this.extent;
    this.grid = new Float32Array(this.n * this.n);
    /** 0..1 how completely a cell has been taken over by a road corridor. */
    this.roadW = new Float32Array(this.n * this.n);
    this.baked = false;
    this._min = 0;
    this._max = 0;
  }

  /** Bake the analytic field. ~200 k samples; measured at 90-160 ms. */
  bake() {
    const { n, cell, origin, grid } = this;
    let mn = 1e9;
    let mx = -1e9;
    for (let j = 0; j < n; j++) {
      const z = origin + j * cell;
      const row = j * n;
      for (let i = 0; i < n; i++) {
        const h = rawHeight(origin + i * cell, z);
        grid[row + i] = h;
        if (h < mn) mn = h;
        if (h > mx) mx = h;
      }
    }
    this._min = mn;
    this._max = mx;
    this.baked = true;
    return this;
  }

  /**
   * Fold a road corridor height field into the terrain. Called once, after the
   * road graph is solved, so that the ground meets the kerb line instead of
   * cutting through it. `field` and `weight` are same-shaped grids produced by
   * `netgen.rasteriseRoads`.
   */
  applyRoads(field, weight) {
    const { grid, roadW } = this;
    for (let i = 0; i < grid.length; i++) {
      const w = weight[i];
      if (w <= 0) continue;
      // Sink the ground well under the carriageway. The road mesh is built on
      // the solved node heights, so anything less than the sum of the bilinear
      // error of this 8 m grid and the detail band below lets dirt poke through
      // the tarmac at a grazing angle — which is the one artefact you cannot
      // miss in a driving game.
      grid[i] = lerp(grid[i], field[i] - 0.55 * w, w);
      roadW[i] = w;
    }
    return this;
  }

  /**
   * Stamp a flat pad into the baked field.
   *
   * `GAMEPLAY.md` asks for a body-shop ring you stand in, pumps you pull onto
   * and a respray you drive into, and `game` triggers all three at 11 m. A
   * service that is triggered by STANDING STILL cannot sit on a 20% hillside:
   * the player slides out of his own trigger, which is exactly what
   * `src/game/interactprobe.mjs` caught at the safehouses. Every point of
   * interest therefore gets a level forecourt, and `roadW` is raised with it so
   * the two-octave detail band — worth nearly a metre of ripple — is suppressed
   * across the pad the same way it is across a carriageway.
   */
  flattenDisc(cx, cz, y, r, blend) {
    const { n, cell, origin, grid, roadW } = this;
    const rad = r + blend;
    const i0 = Math.max(0, Math.floor((cx - rad - origin) / cell));
    const i1 = Math.min(n - 1, Math.ceil((cx + rad - origin) / cell));
    const j0 = Math.max(0, Math.floor((cz - rad - origin) / cell));
    const j1 = Math.min(n - 1, Math.ceil((cz + rad - origin) / cell));
    for (let j = j0; j <= j1; j++) {
      const pz = origin + j * cell;
      const row = j * n;
      for (let i = i0; i <= i1; i++) {
        const px = origin + i * cell;
        const d = Math.hypot(px - cx, pz - cz);
        if (d > rad) continue;
        const w = d <= r ? 1 : 1 - smootherstep((d - r) / blend);
        if (w <= 0.002) continue;
        const k = row + i;
        // NEVER move ground that a carriageway already owns. `applyRoads` sank
        // it half a metre under the tarmac on purpose; a forecourt lifting it
        // back to deck level would bring dirt up through the road surface at a
        // grazing angle, which is the one artefact you cannot miss from a car.
        const we = w * (1 - Math.min(1, roadW[k]));
        if (we > 0.002) grid[k] = lerp(grid[k], y, we);
        if (w > roadW[k]) roadW[k] = w;
      }
    }
    return this;
  }

  /** Bilinear grid fetch. Returns NaN-free values everywhere. */
  _fetch(x, z) {
    const { n, cell, origin, grid } = this;
    const fx = (x - origin) / cell;
    const fz = (z - origin) / cell;
    let i = Math.floor(fx);
    let j = Math.floor(fz);
    if (i < 0) i = 0;
    else if (i > n - 2) i = n - 2;
    if (j < 0) j = 0;
    else if (j > n - 2) j = n - 2;
    const tx = clamp01(fx - i);
    const tz = clamp01(fz - j);
    const r0 = j * n + i;
    const r1 = r0 + n;
    const a = grid[r0];
    const b = grid[r0 + 1];
    const c = grid[r1];
    const d = grid[r1 + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  _fetchRoad(x, z) {
    const { n, cell, origin, roadW } = this;
    const fx = (x - origin) / cell;
    const fz = (z - origin) / cell;
    let i = Math.floor(fx);
    let j = Math.floor(fz);
    if (i < 0 || j < 0 || i > n - 2 || j > n - 2) return 0;
    const tx = fx - i;
    const tz = fz - j;
    const r0 = j * n + i;
    const r1 = r0 + n;
    const a = roadW[r0];
    const b = roadW[r0 + 1];
    const c = roadW[r1];
    const d = roadW[r1 + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  /**
   * THE height query. Bilinear base plus a two-octave detail band that is
   * suppressed under road corridors so the carriageway stays true.
   *
   * `spacing` is the sample step of the caller's grid, in metres, and it is
   * OPTIONAL AND ONLY EVER A HINT — omit it and nothing changes, which is why
   * physics, gameplay and every existing caller are unaffected.
   *
   * WHAT IT IS FOR. `terrainMesh` point-samples this at 2, 4, 8, 16, 32 and
   * 64 m with no prefiltering whatsoever, so every band of the field shorter
   * than twice the step aliases. Measured on the far ring: `_detail`'s second
   * octave has a 32.3 m wavelength, which at LOD4 lands 0.99 cycles per sample
   * and at LOD5 1.98 — both fold down to a near-DC offset that is DIFFERENT
   * per level, biasing LOD4 by -0.60 m and LOD5 by +0.31 m in one box and
   * +0.01 / +2.21 m in another. That per-level offset is a visible step at
   * every ring boundary, and it is where the "checkerboard patches" and the
   * "2.4 m at 2.4 km" figure both come from. A band the caller cannot resolve
   * contributes nothing but noise, so drop it.
   */
  heightAt(x, z, spacing = 0) {
    const det = spacing >= DETAIL_NYQUIST ? 0 : 1;
    if (!this.baked) return rawHeight(x, z, spacing);
    const e = this.extent - this.cell;
    if (x < -e || x > e || z < -e || z > e) {
      // Outside the bake: analytic, cross-faded over one cell so there is no
      // seam where the two definitions meet.
      const raw = rawHeight(x, z, spacing);
      const over = Math.max(Math.abs(x), Math.abs(z)) - e;
      if (over > this.cell) return raw;
      const t = clamp01(over / this.cell);
      return lerp(this._fetch(x, z) + this._detail(x, z) * det, raw, t);
    }
    return this._fetch(x, z) + this._detail(x, z) * det;
  }

  _detail(x, z) {
    const rw = this._fetchRoad(x, z);
    if (rw > 0.6) return 0;
    const k = 1 - rw / 0.6;
    const a = (vnoise(x * 0.084, z * 0.084) - 0.5) * 0.55;
    const b = (vnoise(x * 0.031 + 11, z * 0.031 - 5) - 0.5) * 1.35;
    return (a + b) * k * k;
  }

  /** How much of this point is road corridor, 0..1. */
  roadWeightAt(x, z) {
    return this.baked ? this._fetchRoad(x, z) : 0;
  }

  /**
   * 0 = open country, 1 = the middle of the densest district. The terrain
   * renderer uses it to stop the Golden Triangle being carpeted in meadow: what
   * shows between buildings in a city is bare ground, grit and worn dirt.
   */
  urbanAt(x, z) {
    let best = 0;
    for (let i = 0; i < DISTRICTS.length; i++) {
      const d = DISTRICTS[i];
      const dx = x - d.x;
      const dz = z - d.z;
      const t = 1 - Math.sqrt(dx * dx + dz * dz) / (d.r * 1.25);
      if (t <= 0) continue;
      const v = smootherstep(t) * d.density;
      if (v > best) best = v;
    }
    return best;
  }

  /** Central-difference normal. `out` is [x,y,z]. */
  normalAt(x, z, out = [0, 1, 0]) {
    const e = 2.5;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const nx = -hx;
    const nz = -hz;
    const ny = 2 * e;
    const inv = 1 / Math.hypot(nx, ny, nz);
    out[0] = nx * inv;
    out[1] = ny * inv;
    out[2] = nz * inv;
    return out;
  }

  /** 0 = flat, 1 = vertical. Cheap: two height fetches. */
  slopeAt(x, z, e = 3) {
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const g = Math.hypot(hx, hz) / (2 * e);
    return g / Math.sqrt(1 + g * g);
  }

  /** True where the point is inside a river channel below the pool level. */
  isWater(x, z) {
    riverAt(x, z, _riv);
    if (_riv.s > 6) return false;
    return this.heightAt(x, z) < WATER_Y - 0.25;
  }

  /** Signed distance to the nearest waterline, negative in the water. */
  waterDist(x, z) {
    riverAt(x, z, _riv);
    return _riv.s;
  }
}

export { vnoise, fbm2, ridge2, h2 };
