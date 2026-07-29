import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { Accum, chamferBox, plainBox, trs, fbm3 } from './geom.js';
import { DISTRICTS } from './palette.js';
import { DISTRICT_GEO } from './debug.js';

/**
 * BUILDINGS — the skyline field (LOD 2).
 *
 * The signature view of this city is downtown seen from Mt. Washington at 2 km.
 * That is four times the stream radius, so it cannot come from streamed tiles:
 * it has to be a resident, city-wide silhouette.
 *
 * It is three InstancedMeshes per material — nine draw calls for the whole
 * city — and instances inside the stream radius are collapsed to zero scale so
 * the real geometry is never doubled. Instance visibility is recomputed only
 * when the camera has moved far enough to change the answer.
 */

const _m = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const CELL = 78;
const RECOMPUTE_MOVE = 40;

/**
 * Seating an impostor on a hill.
 *
 * THE DEFECT THIS EXISTS FOR, and it is worth stating precisely because the
 * previous invariant looked like it covered it.
 *
 * Every placement test in `build()` used to be a POINT test at the instance
 * centre — `heightAt(x, z)`, `isWater(x, z)`, `districtAt(x, z)` — while the
 * thing being placed is a box up to 71 m across. Steel City has a 120 m hill in
 * the middle of it and three rivers cut 10-20 m below grade, so the terrain
 * under one impostor is not one number. Measured by `skyprobe.mjs` before this
 * change: **53 of 57 visible impostors on `farview` had daylight under part of
 * their own footprint**, 171 of 215 on `skyline`, worst gap 57.3 m — and a
 * third of them had terrain more than 8 m up their own wall, buried to the
 * eaves, so the only thing left above the hill was the roof and its rooftop
 * plant. That is the "rooftop box hanging in open sky with a thin stub of mast
 * below it" the reviews kept reporting: it is a whole building, with all of it
 * except the roof inside the hillside — or nothing but air underneath.
 *
 * The old gate said "every visible impostor's base is exactly on terrain", and
 * it was true, and it was worthless: it re-sampled `heightAt` at the same x/z
 * the placement had used, so it compared a number to itself and could never
 * fail. A check has to sample the footprint, not the anchor.
 *
 * So: sample the ROTATED footprint, shrink the plan until the ground under it
 * is something a building could stand on and is dry, then sit on the LOWEST
 * point (nothing can hang) and add the fall back onto the height (so the
 * roofline still clears the HIGHEST point by the height the generator chose,
 * and the silhouette is unchanged). Same rule `index.js` already applies to
 * real lots in `_plans`, which is not a coincidence — it is the same hill.
 *
 * `districtAt` stays a centre test deliberately: a block that straddles a
 * district boundary is a block on a boundary, not a defect.
 *
 * The samples are taken over a footprint 10% LARGER than the plan, so the base
 * this returns is at or below the true minimum under the walls. That is on
 * purpose — `skyprobe.mjs` measures a different, tighter grid over the emitted
 * geometry's own bounds, so the gate cannot pass merely by agreeing with the
 * arithmetic here.
 */
const SEAT_N = 5; // samples per axis across the plan
const SEAT_PAD = 1.1; // sample slightly WIDER than the plan: strictly conservative
const SEAT_FALL = 10; // metres of fall a plan may absorb before it is shrunk
const SEAT_SHRINK = 0.75;
const SEAT_TRIES = 3;
const SEAT_MIN = 18; // never shrink a block below this, in metres

function seat(x, z, w, d, ry, heightAt, isWater) {
  const cos = Math.cos(ry);
  const sin = Math.sin(ry);
  for (let attempt = 0; ; attempt++) {
    let lo = Infinity;
    let hi = -Infinity;
    let wet = false;
    for (let i = 0; i < SEAT_N; i++) {
      for (let j = 0; j < SEAT_N; j++) {
        const lx = (i / (SEAT_N - 1) - 0.5) * w * SEAT_PAD;
        const lz = (j / (SEAT_N - 1) - 0.5) * d * SEAT_PAD;
        // Matches the Y rotation `trs` composes: world = (c*lx + s*lz, -s*lx + c*lz).
        const wx = x + lx * cos + lz * sin;
        const wz = z - lx * sin + lz * cos;
        if (isWater(wx, wz)) wet = true;
        const t = heightAt(wx, wz);
        if (t < lo) lo = t;
        if (t > hi) hi = t;
      }
    }
    const fall = hi - lo;
    const tight = w * SEAT_SHRINK < SEAT_MIN && d * SEAT_SHRINK < SEAT_MIN;
    if ((!wet && fall <= SEAT_FALL) || attempt >= SEAT_TRIES || tight) {
      // A plan that is still standing in the river after it has been shrunk as
      // far as it may go is not a building, it is a boat. Drop it.
      if (wet) return null;
      return { w, d, base: lo, fall };
    }
    w *= SEAT_SHRINK;
    d *= SEAT_SHRINK;
  }
}

/**
 * Floor-line relief.
 *
 * The critic finding this answers is "beyond roughly 60 m the entire city is
 * untextured grey cuboids with a single grey cuboid on the roof, repeated
 * hundreds of times". Half of that is silhouette (see the prototype list) and
 * half is that a cuboid at 1.5 km has no INTERNAL value structure at all: real
 * distant architecture is read as a stack of horizontal lines, because floor
 * slabs, spandrels and window heads all catch the sun differently.
 *
 * `n` ribs standing proud by `d` of the unit box. Because instances are scaled
 * non-uniformly, the rib depth in metres tracks the building's own width, which
 * is the correct behaviour: a 70 m slab gets a 0.4 m course and a 20 m block
 * gets a 0.12 m one.
 */
function ribs(a, b, y0, y1, n, halfW = 0.5, halfD = 0.5, d = 0.008, cx = 0, cz = 0) {
  if (n < 1) return;
  const span = y1 - y0;
  for (let i = 0; i < n; i++) {
    const y = y0 + ((i + 0.62) / n) * span;
    a.add(b, trs(_m, cx, y, cz, 0, halfW * 2 + d * 2, span / n / 3.2, halfD * 2 + d * 2));
  }
}

/** A flat-roofed block: body, cornice ledge, roof plant. Unit box, base at y=0. */
function blockGeo() {
  const a = new Accum('sky_block');
  const b = plainBox();
  a.add(b, trs(_m, 0, 0.5, 0, 0, 1, 1, 1));
  ribs(a, b, 0.06, 0.94, 5);
  // A parapet lip rather than a stacked cap: at 1 km the cornice is one pixel
  // of horizontal, and a fat one turns every block into a wedding cake.
  a.add(b, trs(_m, 0, 1.008, 0, 0, 1.02, 0.03, 1.02));
  // roof plant, off centre so the silhouette is not symmetrical
  a.add(b, trs(_m, 0.19, 1.045, -0.14, 0, 0.3, 0.055, 0.26));
  a.add(b, trs(_m, -0.26, 1.08, 0.2, 0, 0.13, 0.12, 0.13));
  b.dispose();
  const g = a.build();
  return paint(g);
}

/**
 * The same block with a corner taken out of it and a lift overrun on the high
 * part. Two masses at different heights is the cheapest silhouette variation
 * there is and it is what actually breaks a repeated-prefab read.
 */
function blockNotchGeo() {
  const a = new Accum('sky_notch');
  const b = plainBox();
  // The course lines have to be centred on the mass they wrap, not on the
  // prototype origin: the low wing sits at x = +0.33 and the tall slab at
  // x = -0.16, so a rib drawn at x = 0 hung half a bay clear of the wall on one
  // side and stopped short of it on the other.
  a.add(b, trs(_m, -0.16, 0.5, 0, 0, 0.68, 1, 1));
  ribs(a, b, 0.06, 0.94, 5, 0.34, 0.5, 0.008, -0.16, 0);
  a.add(b, trs(_m, -0.16, 1.01, 0, 0, 0.7, 0.026, 1.02));
  a.add(b, trs(_m, 0.33, 0.36, 0.1, 0, 0.34, 0.72, 0.78));
  ribs(a, b, 0.05, 0.66, 3, 0.17, 0.39, 0.008, 0.33, 0.1);
  a.add(b, trs(_m, 0.33, 0.735, 0.1, 0, 0.36, 0.026, 0.8));
  a.add(b, trs(_m, -0.3, 1.075, -0.2, 0, 0.16, 0.13, 0.18));
  b.dispose();
  return paint(a.build());
}

/** A stepped tower: two setbacks and a crown. */
function towerGeo() {
  const a = new Accum('sky_tower');
  const b = plainBox();
  a.add(b, trs(_m, 0, 0.34, 0, 0, 1, 0.68, 1));
  ribs(a, b, 0.03, 0.65, 9);
  a.add(b, trs(_m, 0, 0.685, 0, 0, 0.84, 0.025, 0.84));
  a.add(b, trs(_m, 0, 0.855, 0, 0, 0.8, 0.31, 0.8));
  ribs(a, b, 0.71, 1.0, 4, 0.4, 0.4);
  a.add(b, trs(_m, 0, 1.012, 0, 0, 0.64, 0.025, 0.64));
  a.add(b, trs(_m, 0, 1.05, 0, 0, 0.58, 0.06, 0.58));
  a.add(b, trs(_m, 0.0, 1.2, 0, 0, 0.07, 0.24, 0.07));
  b.dispose();
  return paint(a.build());
}

/**
 * A thin slab tower turned across its plot, with a flat mechanical crown. The
 * post-war office slab — the thing that stops every tall building in the city
 * being a stepped 1920s wedding cake.
 */
function slabGeo() {
  const a = new Accum('sky_slab');
  const b = plainBox();
  a.add(b, trs(_m, 0, 0.48, 0, 0, 1, 0.96, 0.46));
  ribs(a, b, 0.03, 0.93, 13, 0.5, 0.23, 0.01);
  a.add(b, trs(_m, 0, 0.972, 0, 0, 1.03, 0.03, 0.49));
  a.add(b, trs(_m, 0.1, 1.03, 0, 0, 0.42, 0.09, 0.4));
  a.add(b, trs(_m, -0.34, 1.005, 0, 0, 0.11, 0.05, 0.42));
  b.dispose();
  return paint(a.build());
}

/** A low industrial shed with a ridge and a stack. */
function shedGeo() {
  const a = new Accum('sky_shed');
  const b = plainBox();
  a.add(b, trs(_m, 0, 0.42, 0, 0, 1, 0.84, 1));
  a.add(b, trs(_m, 0, 0.9, 0, 0, 1.02, 0.14, 0.55, 0, 0));
  a.add(b, trs(_m, -0.32, 1.25, 0.24, 0, 0.14, 0.86, 0.14));
  b.dispose();
  return paint(a.build());
}

/**
 * A pitched-roof terrace: three gables in a row. Steel City's hillsides are
 * mostly two-storey housing, and a hillside made of flat-topped boxes is the
 * single loudest "this is generated" tell in a wide shot.
 */
function gableGeo() {
  const a = new Accum('sky_gable');
  const b = plainBox();
  const roof = new THREE.BufferGeometry();
  // one unit-wide gable prism, ridge along +x, base at y=0, height 1
  const P = [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 1, 0, 0.5, 1, 0];
  const I = [0, 1, 4, 1, 5, 4, 3, 4, 5, 3, 5, 2, 0, 4, 3, 1, 2, 5];
  roof.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  roof.setIndex(I);
  roof.computeVertexNormals();
  a.add(b, trs(_m, 0, 0.34, 0, 0, 1, 0.68, 1));
  ribs(a, b, 0.1, 0.62, 2);
  for (let i = 0; i < 3; i++) {
    a.add(roof, trs(_m, 0, 0.68, (i - 1) * 0.335, 0, 1.04, 0.26, 0.34));
  }
  a.add(b, trs(_m, 0.24, 0.86, -0.34, 0, 0.09, 0.3, 0.09));
  roof.dispose();
  b.dispose();
  return paint(a.build());
}

/** A block with a timber water tower on it — the New York-ism, used sparingly. */
function waterGeo() {
  const a = new Accum('sky_water');
  const b = plainBox();
  a.add(b, trs(_m, 0, 0.46, 0, 0, 1, 0.92, 1));
  ribs(a, b, 0.06, 0.86, 4);
  a.add(b, trs(_m, 0, 0.928, 0, 0, 1.02, 0.03, 1.02));
  // legs, tank, conical cap approximated by a narrow box
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      a.add(b, trs(_m, sx * 0.11, 0.99, sz * 0.11, 0, 0.022, 0.13, 0.022));
    }
  }
  a.add(b, trs(_m, 0, 1.13, 0, 0.4, 0.26, 0.17, 0.26));
  a.add(b, trs(_m, 0, 1.225, 0, 0.4, 0.12, 0.05, 0.12));
  b.dispose();
  return paint(a.build());
}

function paint(g) {
  const pa = g.getAttribute('position');
  const na = g.getAttribute('normal');
  const arr = new Float32Array(pa.count * 3);
  for (let i = 0; i < pa.count; i++) {
    const y = pa.getY(i);
    const ny = na.getY(i);
    arr[i * 3] = 0.2;
    arr[i * 3 + 1] = Math.min(1, 0.3 + Math.max(0, -ny) * 0.4 + Math.max(0, 1 - y * 1.6) * 0.25);
    arr[i * 3 + 2] = Math.max(0, -ny) * 0.35;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return g;
}

export class Skyline {
  constructor(lib, rng) {
    this.lib = lib;
    this.rng = rng;
    this.meshes = [];
    this._groups = [];
    this._last = new THREE.Vector3(1e9, 0, 1e9);
    this._suppress = 0;
    this._enabled = true;
    this._tiles = 0;
    this._dirty = false;
    this._cells = null;
  }

  build(world, root) {
    /**
     * Seven prototypes, not one. The critic panel's finding was "the skyline is
     * one prefab (box + dark roof slab + one white rooftop cube) stamped dozens
     * of times with no silhouette variation" — measured against a field that
     * really did have three prototypes of which one (the shed) was rare and two
     * were flat-topped boxes of the same proportions. Kind is chosen from the
     * district's character below, so downtown is towers and slabs, the
     * hillsides are gables and blocks, and the mill flats are sheds.
     */
    const kinds = [
      { geo: blockGeo(), name: 'block' },
      { geo: towerGeo(), name: 'tower' },
      { geo: shedGeo(), name: 'shed' },
      { geo: blockNotchGeo(), name: 'notch' },
      { geo: slabGeo(), name: 'slab' },
      { geo: gableGeo(), name: 'gable' },
      { geo: waterGeo(), name: 'water' },
    ];
    // The impostor tier's own surfaces — same hues, a quarter of the texture
    // frequency and a fraction of the weathering. See `sky_concrete` in
    // palette.js for why.
    const mats = ['sky_concrete', 'sky_brick', 'sky_glass'];
    const NM = mats.length;

    // Bucket every generated block by (kind, material) so the whole city comes
    // out as at most 21 instanced draws.
    const buckets = new Map();
    for (let k = 0; k < kinds.length; k++) {
      for (let m = 0; m < NM; m++) buckets.set(k * NM + m, []);
    }

    const at = (x, z) => {
      const h = world?.heightAt?.(x, z);
      return Number.isFinite(h) ? h : 0;
    };
    const wet = (x, z) => world?.isWater?.(x, z) === true;
    this.stats = { placed: 0, shrunk: 0, dropped: 0, worstFall: 0 };
    const districtOf = (x, z) => {
      if (typeof world?.districtAt === 'function') {
        const d = world.districtAt(x, z);
        if (d) return typeof d === 'string' ? d : d.id;
      }
      return null;
    };

    for (const d of DISTRICT_GEO) {
      const style = DISTRICTS[d.id];
      if (!style) continue;
      const rng = new Rng(hash(d.id));
      const cells = Math.max(2, Math.round((d.r * 2) / CELL));
      for (let iz = 0; iz < cells; iz++) {
        for (let ix = 0; ix < cells; ix++) {
          const jx = (ix + 0.5) / cells - 0.5;
          const jz = (iz + 0.5) / cells - 0.5;
          const x = d.x + jx * d.r * 2 + rng.range(-CELL * 0.2, CELL * 0.2);
          const z = d.z + jz * d.r * 2 + rng.range(-CELL * 0.2, CELL * 0.2);
          if (Math.hypot(x - d.x, z - d.z) > d.r) continue;
          // Let `world` overrule the synthetic geography wherever it can.
          const real = districtOf(x, z);
          if (real && real !== d.id) continue;
          if (world?.isWater?.(x, z)) continue;
          if (rng.float() > 0.86) continue;

          const tall = style.tall;
          const noise = fbm3(x * 0.004, 0.5, z * 0.004, 3);
          // Height falls off toward the edge of a district: real skylines peak
          // at a centre and taper, they are not a plateau.
          const core = 1 - Math.min(1, Math.hypot(x - d.x, z - d.z) / d.r);
          // Skewed, not uniform: a real skyline is mostly low with a handful of
          // tall ones. A flat distribution produces a hedge, which is exactly
          // what a generated city looks like from a hill.
          const skew = Math.pow(rng.float(), 2.1);
          let h = (8 + tall * 122 * (0.18 + 0.9 * noise) * (0.35 + 1.15 * skew)) * (0.4 + 0.9 * core);
          h *= rng.range(0.8, 1.2);
          if (tall > 0.8 && rng.float() < 0.06) h *= rng.range(1.35, 1.85);
          let w = CELL * rng.range(0.46, 0.9);
          let dd = CELL * rng.range(0.46, 0.9);

          /**
           * Kind selection. `r` is one roll per instance so the mix inside a
           * district is stable but not periodic — the previous version picked
           * from a two-way branch, which is how a whole district ends up as one
           * prefab.
           */
          const r = rng.float();
          let kind;
          if (tall > 0.75 && h > 55) {
            kind = r < 0.42 ? 1 : r < 0.72 ? 4 : 3; // tower / slab / notched block
          } else if (style.archetypes.mill && r < 0.55) {
            kind = 2; // shed
          } else if (tall < 0.33 && h < 15 && r < 0.72) {
            kind = 5; // gabled terrace
          } else if (r < 0.16) {
            kind = 6; // water tower
          } else if (r < 0.52) {
            kind = 3; // notched block
          } else {
            kind = 0; // flat block
          }
          // A slab is thin across and long down the street; a gabled terrace is
          // a ROW, so it is long and shallow. Proportion is silhouette.
          if (kind === 4) {
            dd *= 0.55;
            w *= 1.15;
            h *= 1.12;
          } else if (kind === 5) {
            w *= 1.3;
            dd *= 0.72;
            h = Math.min(h, 13) * 0.85;
          }
          const mat = kind === 1 || kind === 4 ? (rng.float() < 0.6 ? 2 : 0) : tall > 0.7 ? 0 : rng.float() < 0.5 ? 1 : 0;

          /**
           * Sit the plan on the ground BEFORE the rotation is thrown away —
           * a 71 m box turned 40 degrees covers different ground from the same
           * box square on, so the roll has to happen first and be reused.
           */
          const ry = rng.range(0, Math.PI);
          const st = seat(x, z, w, dd, ry, at, wet);
          if (!st) {
            this.stats.dropped++;
            continue;
          }
          if (st.w < w) this.stats.shrunk++;
          if (st.fall > this.stats.worstFall) this.stats.worstFall = st.fall;
          this.stats.placed++;
          w = st.w;
          dd = st.d;
          // Base on the LOWEST ground under the plan so nothing can hang, and
          // put the fall back on the height so the roofline still clears the
          // HIGHEST ground by the height the generator asked for. A floor,
          // because the shortest blocks the distribution produces are 3 m and
          // three metres of anything reads as debris at a kilometre.
          const y = st.base;
          const hh = Math.max(7, h) + st.fall;
          const mtx = new THREE.Matrix4();
          trs(mtx, x, y, z, ry, w, hh, dd);
          buckets.get(kind * NM + mat).push({ mtx, x, z });
        }
      }
    }

    for (let k = 0; k < kinds.length; k++) {
      for (let m = 0; m < NM; m++) {
        const list = buckets.get(k * NM + m);
        if (!list || !list.length) continue;
        const im = new THREE.InstancedMesh(kinds[k].geo, this.lib.mat(mats[m]), list.length);
        im.name = `skyline_${kinds[k].name}_${mats[m]}`;
        im.matrixAutoUpdate = false;
        im.castShadow = false;
        im.receiveShadow = true;
        im.userData.owNoShadow = true;
        im.userData.collision = false;
        im.frustumCulled = false;
        for (let i = 0; i < list.length; i++) im.setMatrixAt(i, list[i].mtx);
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        root.add(im);
        this.meshes.push({
          im,
          list,
          shown: new Uint8Array(list.length).fill(1),
          // How many loaded tiles currently cover this instance. A count, not a
          // flag: two neighbouring tiles can both claim one, and the instance
          // must not come back when only the first of them unloads.
          hide: new Int16Array(list.length),
        });
      }
    }
    this.geos = kinds.map((k) => k.geo);
    this._index();
  }

  /**
   * Bucket every instance by 128 m cell so a tile load touches four cells
   * instead of four thousand instances.
   */
  _index() {
    this._cells = new Map();
    for (let m = 0; m < this.meshes.length; m++) {
      const e = this.meshes[m];
      for (let i = 0; i < e.list.length; i++) {
        const k = cellKey(e.list[i].x, e.list[i].z);
        let l = this._cells.get(k);
        if (!l) this._cells.set(k, (l = []));
        l.push(m, i);
      }
    }
  }

  /**
   * A streamed tile now covers this ground: collapse the impostors under it.
   *
   * THE DEFECT THIS FIXES. The previous version replaced per-tile suppression
   * with a single radius test around the camera — collapse everything within
   * `midRadius`. That is not the same set. `world` streams a tile whose CENTRE
   * is inside the radius, so real geometry reaches roughly a tile's
   * half-diagonal FURTHER than the radius, and in that annulus a skyline
   * impostor and a real building stand in the same place. Measured on the
   * `skyline` capture: **61 impostors drawn on top of a built lot, nearest pair
   * 0.9 m apart** — two buildings interpenetrating, which is what shredded
   * every mid-distance elevation in that frame into a torn, dithered mess. It
   * reads exactly like z-fighting because it IS z-fighting, just between two
   * different buildings.
   */
  suppress(cx, cz, size) {
    this._mark(cx, cz, size, 1);
    this._tiles++;
  }

  restore(cx, cz, size) {
    this._mark(cx, cz, size, -1);
    this._tiles--;
  }

  _mark(cx, cz, size, delta) {
    if (!this._cells || !Number.isFinite(cx) || !Number.isFinite(size)) return;
    // A skyline block is placed on a 78 m lattice and can be 70 m across, so a
    // small allowance past the tile edge stops one poking through the outermost
    // row of real buildings. Kept small: over-reaching would open a gap between
    // the streamed city and the impostor field.
    const h = size * 0.5 + 8;
    const c0 = Math.floor((cx - h) / 128);
    const c1 = Math.floor((cx + h) / 128);
    const d0 = Math.floor((cz - h) / 128);
    const d1 = Math.floor((cz + h) / 128);
    for (let d = d0; d <= d1; d++) {
      for (let c = c0; c <= c1; c++) {
        const l = this._cells.get(c * 73856093 ^ (d * 19349663));
        if (!l) continue;
        for (let k = 0; k < l.length; k += 2) {
          const e = this.meshes[l[k]];
          const it = e.list[l[k + 1]];
          if (Math.abs(it.x - cx) > h || Math.abs(it.z - cz) > h) continue;
          e.hide[l[k + 1]] += delta;
          this._dirty = true;
        }
      }
    }
  }

  /**
   * Push the suppression state into the instance matrices. Costs nothing on a
   * frame where no tile loaded or unloaded.
   */
  update(cam, radius) {
    if (!this.meshes.length) return;
    // No tile stream has ever reported in (the standalone preview): fall back
    // to the camera radius so the field is still hole-free there.
    if (!this._tiles) {
      if (this._last.distanceToSquared(cam) < RECOMPUTE_MOVE * RECOMPUTE_MOVE && this._suppress === radius) return;
      this._last.copy(cam);
      this._suppress = radius;
      const r2 = radius * radius;
      for (const e of this.meshes) {
        let changed = false;
        for (let i = 0; i < e.list.length; i++) {
          const it = e.list[i];
          const dx = it.x - cam.x;
          const dz = it.z - cam.z;
          const show = dx * dx + dz * dz > r2 ? 1 : 0;
          if (show === e.shown[i]) continue;
          e.shown[i] = show;
          e.im.setMatrixAt(i, show ? it.mtx : _zero);
          changed = true;
        }
        if (changed) e.im.instanceMatrix.needsUpdate = true;
      }
      return;
    }
    if (!this._dirty) return;
    this._dirty = false;
    for (const e of this.meshes) {
      let changed = false;
      for (let i = 0; i < e.list.length; i++) {
        const show = e.hide[i] > 0 ? 0 : 1;
        if (show === e.shown[i]) continue;
        e.shown[i] = show;
        e.im.setMatrixAt(i, show ? e.list[i].mtx : _zero);
        changed = true;
      }
      if (changed) e.im.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    for (const e of this.meshes) {
      e.im.dispose();
      e.im.parent?.remove(e.im);
    }
    for (const g of this.geos ?? []) g.dispose();
    this.meshes.length = 0;
    this._cells = null;
    this._tiles = 0;
  }
}

function cellKey(x, z) {
  return Math.floor(x / 128) * 73856093 ^ (Math.floor(z / 128) * 19349663);
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
