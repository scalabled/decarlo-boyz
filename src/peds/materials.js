/**
 * PEDS — the crowd's material set.
 *
 * THREE baked tiling PBR sets (cloth, skin, gear) plus two high-frequency
 * detail tiles, and one shader hook that turns them into hundreds of distinct
 * people.
 *
 * THE PALETTE TRICK. A crowd needs, at minimum, a different coat, trousers,
 * shoes, hair and skin tone on every person in frame; it cannot afford one
 * skinned geometry per person, and a per-material `color` can only give each
 * *draw call* one colour. So the geometry carries a per-vertex palette SLOT
 * (`owTint.x`, see geo.js) and each pedestrian owns a `owPalette[12]` uniform
 * array. Geometry is shared by silhouette; colour is per person; the cost is
 * three draw calls each and one 12-vec3 uniform upload.
 *
 * The baked albedo maps are therefore deliberately near-white *modulation*
 * (mean ~0.84, range 0.6-1.05): they carry weave, print, nap and dye pooling,
 * and the palette carries the actual reflectance. That keeps every ped's
 * albedo physically stateable — a wet-wool black overcoat at 0.032, a hi-vis
 * vest at 0.52 — instead of the product of two guesses.
 *
 * `owTint.y` is crevice grime and ground splash, `owTint.z` is settled dust and
 * abrasion; both blend the palette entry toward the two shared soil colours, so
 * a hem is dirty on every ped without being the same dirty colour on all of
 * them.
 */

import * as THREE from 'three';
import { PALETTE_SIZE } from './geo.js';

/* ------------------------------------------------------------------ */
/* Tileable value noise                                                */
/* ------------------------------------------------------------------ */

export class TileNoise {
  constructor(rng) {
    this.tab = new Float32Array(4096);
    for (let i = 0; i < 4096; i++) this.tab[i] = rng.float();
    this.perm = new Uint16Array(4096);
    for (let i = 0; i < 4096; i++) this.perm[i] = rng.int(0, 4095);
  }

  _h(ix, iy, period) {
    const p = period | 0;
    const x = ((ix % p) + p) % p;
    const y = ((iy % p) + p) % p;
    return this.tab[(this.perm[(x * 73 + y * 151) & 4095] + x * 31 + y * 17) & 4095];
  }

  n2(u, v, period) {
    const x = u * period, y = v * period;
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = this._h(ix, iy, period), b = this._h(ix + 1, iy, period);
    const c = this._h(ix, iy + 1, period), d = this._h(ix + 1, iy + 1, period);
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  }

  fbm(u, v, period, oct = 4, gain = 0.5) {
    let a = 1, s = 0, norm = 0, p = period;
    for (let i = 0; i < oct; i++) {
      s += a * this.n2(u, v, p);
      norm += a;
      a *= gain;
      p *= 2;
    }
    return s / norm;
  }

  ridge(u, v, period, oct = 3) {
    let a = 1, s = 0, norm = 0, p = period;
    for (let i = 0; i < oct; i++) {
      s += a * (1 - Math.abs(this.n2(u, v, p) * 2 - 1));
      norm += a;
      a *= 0.55;
      p *= 2;
    }
    return s / norm;
  }
}

const srgb = (v) => {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255;
};

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const mix = (a, b, t) => a + (b - a) * t;
const cellDist = (x) => Math.abs((((x % 1) + 1) % 1) - 0.5);
const ridgeLine = (d, w) => smooth(w, 0, d);

function dataTexture(buf, size, srgbSpace, aniso) {
  const t = new THREE.DataTexture(buf, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgbSpace ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

function bake(size, fn, aniso, normalScale = 1) {
  const alb = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const nrm = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const out = { r: 0.85, g: 0.85, b: 0.85, h: 0, rough: 0.8, metal: 0, ao: 1 };
  // Running mean of the DECODED (clamped, linear) albedo, so the modulation
  // can be normalised to exactly 1.0 — see `albedoGain` below.
  let mr = 0, mg = 0, mb = 0;
  const clamp01 = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      out.r = out.g = out.b = 0.85;
      out.h = 0;
      out.rough = 0.8;
      out.metal = 0;
      out.ao = 1;
      fn(x / size, y / size, out, x, y);
      mr += clamp01(out.r);
      mg += clamp01(out.g);
      mb += clamp01(out.b);
      alb[i * 4] = srgb(out.r);
      alb[i * 4 + 1] = srgb(out.g);
      alb[i * 4 + 2] = srgb(out.b);
      alb[i * 4 + 3] = 255;
      orm[i * 4] = out.ao * 255;
      orm[i * 4 + 1] = out.rough * 255;
      orm[i * 4 + 2] = out.metal * 255;
      orm[i * 4 + 3] = 255;
      height[i] = out.h;
    }
  }
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const k = normalScale * 0.17;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const dy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      let nx = -dx * k, ny = -dy * k, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const i = y * size + x;
      nrm[i * 4] = (nx / l * 0.5 + 0.5) * 255;
      nrm[i * 4 + 1] = (ny / l * 0.5 + 0.5) * 255;
      nrm[i * 4 + 2] = (nz / l * 0.5 + 0.5) * 255;
      nrm[i * 4 + 3] = 255;
    }
  }
  const n = size * size;
  return {
    albedo: dataTexture(alb, size, true, aniso),
    orm: dataTexture(orm, size, false, aniso),
    normal: dataTexture(nrm, size, false, aniso),
    /**
     * THE MODULATION HAS TO AVERAGE ONE, AND IT DID NOT.
     *
     * This header says the baked albedo is "deliberately near-white
     * MODULATION (mean ~0.84) ... the palette carries the actual
     * reflectance". The intent was right and the arithmetic was not: the
     * linear mean of the cloth bake measured 0.760, the skin 0.918 and the
     * gear 0.853, so every palette entry was being quietly multiplied by
     * 0.76-0.92 before it ever met a photon — and then again by the baked
     * vertex AO (mean 0.90). A wardrobe authored in true reflectance came
     * out 24-32% dark, which is 0.4-0.5 stops off every pedestrian in the
     * city and most of why they read as silhouettes.
     *
     * The map cannot simply be brightened: it is an 8-bit sRGB texture, so
     * anything over 1.0 clips and the weave goes with it. So the DC is
     * carried as a scalar instead, and the texture keeps its full range.
     * `albedoGain` is measured from the baked data, not asserted, so it
     * stays correct if the bake is ever retuned.
     */
    albedoGain: [n / Math.max(1e-6, mr), n / Math.max(1e-6, mg), n / Math.max(1e-6, mb)],
  };
}

/** Detail tile: rgb = tangent normal, a = signed roughness delta about 0.5. */
function bakeDetail(size, fn, aniso, normalScale = 1) {
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const out = { h: 0, rough: 0 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out.h = 0;
      out.rough = 0;
      fn(x / size, y / size, out);
      const i = y * size + x;
      height[i] = out.h;
      rough[i] = out.rough;
    }
  }
  const buf = new Uint8Array(size * size * 4);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const k = normalScale * 0.17;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const dy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      let nx = -dx * k, ny = -dy * k, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const i = y * size + x;
      buf[i * 4] = (nx / l * 0.5 + 0.5) * 255;
      buf[i * 4 + 1] = (ny / l * 0.5 + 0.5) * 255;
      buf[i * 4 + 2] = (nz / l * 0.5 + 0.5) * 255;
      buf[i * 4 + 3] = Math.max(0, Math.min(255, (rough[i] * 0.5 + 0.5) * 255));
    }
  }
  return dataTexture(buf, size, false, aniso);
}

/**
 * Metres of surface per texture tile, per material set. `cloth` is 0.42 m over
 * 512 px = 0.8 mm/texel, which resolves a twill line; the 0.25 mm fibre it
 * cannot resolve comes from the detail tile.
 */
export const TILE = { cloth: 0.42, skin: 0.20, gear: 0.24 };
const DETAIL_TILE = 0.05;

/**
 * MATERIAL SLOT ORDER IS LOAD-BEARING. `THREE.Material` hands out globally
 * incrementing ids and three sorts the opaque render list by `material.id`
 * (`painterSortStable`), including the groups *within* one pedestrian. Create
 * them in a different order and a coplanar surface loses the equal-depth test
 * against the depth prepass in front of it. `PedMaterials.createSet()` always
 * builds in this order and `builder.js` asserts the groups come out matching.
 */
export const MATERIAL_SLOTS = Object.freeze(['cloth', 'skin', 'gear']);

/**
 * VIEW-DEPENDENT EDGE DARKENING — the same trick the soldier materials use.
 * A person against a bright overcast sky loses their outline; a real body is a
 * closed surface, so at the silhouette you look through the full thickness of
 * nap and self-shadowing and almost nothing returns. Confining the band to the
 * outer sliver of every curved surface reads as form shading, not as an
 * outline, and it takes the grazing specular with it.
 */
const RIM = { strength: 0.46, edge: 0.46, power: 2.0 };

/**
 * Crevice grime and settled pale dust, shared by every pedestrian.
 * Exported so `crowdprobe.mjs` can reproduce the shader's albedo resolve
 * exactly, without a GL context.
 */
export const GRIME = [0.052, 0.045, 0.038];
export const PALE = [0.235, 0.228, 0.214];

export class PedMaterials {
  constructor(rng, opts = {}) {
    const size = opts.size ?? 512;
    const aniso = opts.anisotropy ?? 8;
    const nz = new TileNoise(rng.fork());
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;

    this.sets = {};
    this._disposables = [];
    this._materials = [];

    /* ---------------- woven cloth ---------------------------------- */
    // Wool twill / cotton drill at 0.42 m per tile. The map is a MODULATION:
    // weave shading, dye pooling in the valleys, sun-bleach on the crowns, felled
    // seams and topstitching. Mean 0.84 so the palette owns the reflectance.
    this.sets.cloth = bake(
      size,
      (u, v, out) => {
        // 2/2 twill running on the bias, ~1.6 mm repeat
        const th = 260;
        const tu = u * th, tv = v * th;
        const diag = Math.sin((tu + tv) * Math.PI * 0.5);
        const wu = Math.sin(tu * Math.PI);
        const wv = Math.sin(tv * Math.PI);
        let h = (diag > 0 ? wu * 0.6 + wv * 0.2 : wv * 0.6 + wu * 0.2) * 0.42;
        // slubs: a heavier yarn every few centimetres, what makes wool read wool
        h += (nz.fbm(u, v, 90, 2) - 0.5) * 0.34;
        // felled panel seams every ~10 cm, drifting so nothing is a straight line
        const dr = (nz.fbm(u, v, 3, 2) - 0.5) * 0.20;
        const sa = cellDist(v * 4 + dr);
        h += -ridgeLine(sa, 0.012) * 0.55 + (ridgeLine(sa, 0.028) - ridgeLine(sa, 0.015)) * 0.32;
        const dr2 = (nz.fbm(v + 4.1, u, 3, 2) - 0.5) * 0.24;
        const sb = cellDist(u * 2.5 + dr2);
        h += -ridgeLine(sb, 0.008) * 0.40 + (ridgeLine(sb, 0.020) - ridgeLine(sb, 0.010)) * 0.20;
        // topstitching along the seams, 3 mm pitch
        const onSeam = Math.max(ridgeLine(sa, 0.018), ridgeLine(sb, 0.013));
        h += onSeam * (0.5 + 0.5 * Math.sin((u + v) * 560)) * 0.24;
        // creases: the 1-2 cm scale that separates a sleeve from a rendered tube
        const crease = nz.ridge(u + 3.1, v - 2.2, 46, 2);
        h += (crease - 0.55) * 0.44;
        h += (nz.fbm(u, v, 11, 3) - 0.5) * 0.70;
        out.h = h;

        // value modulation only — hue lives in the palette
        const pool = smooth(-0.9, 0.6, -h);           // dye pools in the valleys
        const bleach = smooth(-0.1, 1.0, h);          // crowns are sun-bleached
        const macro = nz.fbm(u + 7.3, v + 1.1, 5, 3); // panel-to-panel dye lot
        let s = 0.84 + 0.14 * bleach - 0.16 * pool + 0.10 * (macro - 0.5);
        // occasional lint / a pale thread pulled loose
        s += ridgeLine(cellDist(u * 3 + 0.31), 0.004) * 0.10;
        out.r = s * 1.01;
        out.g = s;
        out.b = s * 0.985;
        out.rough = 0.885 - 0.055 * bleach + 0.05 * pool + 0.03 * (nz.fbm(u, v, 9, 3) - 0.5);
        out.metal = 0;
        out.ao = 0.80 + 0.20 * smooth(-0.7, 0.7, h);
      },
      aniso,
      0.95
    );

    /* ---------------- skin ----------------------------------------- */
    this.sets.skin = bake(
      size,
      (u, v, out) => {
        const pores = nz.fbm(u, v, 150, 3);
        const macro = nz.fbm(u, v, 11, 3);
        const fine = nz.fbm(u, v, 320, 2);
        const cap = nz.fbm(u + 2.9, v + 5.1, 26, 2); // capillary flush
        out.h = (pores - 0.5) * 0.48 + (fine - 0.5) * 0.24;
        // modulation about 0.94: freckling, flush and shadow in the pores
        let s = 0.94 + 0.055 * (macro - 0.5) - 0.10 * smooth(0.55, 0.85, pores);
        const freck = smooth(0.70, 0.80, nz.fbm(u * 1.3, v * 1.3, 130, 2));
        s -= freck * 0.10;
        out.r = s * (1.0 + 0.055 * (cap - 0.5));
        out.g = s * (1.0 - 0.020 * (cap - 0.5));
        out.b = s * (1.0 - 0.045 * (cap - 0.5));
        out.rough = 0.50 + 0.16 * macro - 0.10 * pores;
        out.metal = 0;
        out.ao = 0.90 + 0.10 * pores;
      },
      aniso,
      0.75
    );

    /* ---------------- gear: leather, rubber, plastic ---------------- */
    // One bake for shoes, bags, belts, hard hats, phones and umbrella shafts.
    // Pebbled leather grain with a resin sheen on the crowns; the scuffs are
    // what make a shoe read as a shoe rather than a moulded lump.
    this.sets.gear = bake(
      size,
      (u, v, out) => {
        const grain = nz.fbm(u, v, 110, 3);
        const peb = smooth(0.42, 0.64, nz.fbm(u, v, 46, 2));
        const scuff = smooth(0.74, 0.96, nz.ridge(u * 0.7, v * 2.6, 24, 3));
        let h = (grain - 0.5) * 0.55 + peb * 0.30 - scuff * 0.16;
        // welt stitching around the sole line
        const st = cellDist(v * 3 + 0.2);
        h += ridgeLine(st, 0.010) * (0.4 + 0.6 * Math.sin(u * 320)) * 0.26;
        out.h = h;
        let s = 0.80 + 0.13 * peb - 0.10 * smooth(0.5, 0.9, grain);
        s = mix(s, 1.02, scuff * 0.55); // abrasion goes pale
        out.r = s * 1.005;
        out.g = s;
        out.b = s * 0.99;
        out.rough = 0.52 + 0.24 * grain - 0.20 * peb + 0.22 * scuff;
        out.metal = 0;
        out.ao = 0.84 + 0.16 * smooth(-0.6, 0.8, h);
      },
      aniso,
      1.1
    );

    /* ---------------- detail tiles --------------------------------- */
    this.details = {};
    const dsize = Math.min(512, size);
    // 0.25 mm fibre + the 6 mm twill line, over 5 cm
    this.details.cloth = bakeDetail(
      dsize,
      (u, v, out) => {
        const threads = 40;
        const tu = u * threads, tv = v * threads;
        const over = Math.sin((tu + tv) * Math.PI * 0.5) > 0;
        const wu = Math.sin(tu * Math.PI * 2);
        const wv = Math.sin(tv * Math.PI * 2);
        let h = (over ? wu * 0.6 + wv * 0.22 : wv * 0.6 + wu * 0.22) * 0.5;
        h += (nz.fbm(u, v, 190, 2) - 0.5) * 0.32; // fibre fuzz
        out.h = h;
        out.rough = 0.30 * h - 0.18 * (nz.fbm(u + 2.7, v, 96, 2) - 0.5);
      },
      aniso,
      1.0
    );
    // leather pebble at 0.2 mm
    this.details.gear = bakeDetail(
      dsize,
      (u, v, out) => {
        const peb = nz.fbm(u, v, 70, 3);
        const fine = nz.fbm(u, v, 200, 2);
        out.h = (peb - 0.5) * 0.8 + (fine - 0.5) * 0.3;
        out.rough = -0.45 * (peb - 0.5) + 0.08 * (fine - 0.5);
      },
      aniso,
      1.2
    );
    // skin pores at 0.1 mm
    this.details.skin = bakeDetail(
      dsize,
      (u, v, out) => {
        const pores = nz.fbm(u, v, 240, 3);
        out.h = (pores - 0.5) * 0.7;
        out.rough = 0.22 * (pores - 0.5);
      },
      aniso,
      0.8
    );

    this.bakeMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    for (const k in this.sets) {
      const s = this.sets[k];
      this._disposables.push(s.albedo, s.normal, s.orm);
    }
    for (const k in this.details) this._disposables.push(this.details[k]);
  }

  /** A fresh palette uniform block: 12 colours, one pedestrian. */
  createPalette() {
    const arr = [];
    for (let i = 0; i < PALETTE_SIZE; i++) arr.push(new THREE.Color(0.5, 0.5, 0.5));
    return { value: arr };
  }

  /**
   * A fresh FABRIC uniform block: 12 vec4s, one pedestrian.
   *
   * The palette gives a garment its colour; this gives it its MATERIAL. It
   * rides the same per-vertex slot index the palette does (`owTint.x`), so
   * denim, leather, nylon, knit and retroreflective tape cost nothing but one
   * more 12-vec4 upload per person and no extra geometry, no extra draw call
   * and no extra shader program.
   *
   *   x  roughness multiplier      leather 0.5 -> wool 1.0
   *   y  detail-normal gain        nylon smooth 0.5 -> chunky knit 1.6
   *   z  detail tile multiplier    coarse denim twill 0.7 -> fine poplin 1.4
   *   w  sheen                     0 matte, 0.2 waxed leather, 0.55 tape
   *
   * `w` also drives the silhouette term: a matte wool coat loses its edge to
   * nap extinction (full RIM darkening), a waxed jacket or a hi-vis band gains
   * a bright grazing highlight instead. That one number is most of what makes
   * two identically-cut coats read as two different materials.
   */
  createFabric() {
    const arr = [];
    for (let i = 0; i < PALETTE_SIZE; i++) arr.push(new THREE.Vector4(1, 1, 1, 0));
    return { value: arr };
  }

  /**
   * One pedestrian's three materials, IN `MATERIAL_SLOTS` ORDER. All three
   * share the baked textures and the same shader program (the cache key does
   * not mention the palette, which is a uniform), so a hundred of these cost a
   * hundred uniform blocks and zero extra compiles.
   */
  createSet(palette, fabric = null) {
    const fab = fabric ?? this.createFabric();
    return MATERIAL_SLOTS.map((slot) => this._make(slot, palette, fab));
  }

  _make(slot, palette, fabric) {
    const set = this.sets[slot];
    const detail = this.details[slot];
    const m = new THREE.MeshStandardMaterial({
      map: set.albedo,
      normalMap: set.normal,
      roughnessMap: set.orm,
      metalnessMap: set.orm,
      aoMap: set.orm,
      vertexColors: true,
      roughness: slot === 'skin' ? 1.0 : slot === 'gear' ? 1.0 : 1.0,
      metalness: 1,
      color: 0xffffff,
      dithering: true,
    });
    const ns = slot === 'skin' ? 0.75 : slot === 'gear' ? 1.05 : 1.15;
    m.normalScale.set(ns, ns);
    m.aoMapIntensity = 0.8;
    m.name = `ped_${slot}`;
    this._attach(m, slot, detail, palette, fabric);
    this._materials.push(m);
    return m;
  }

  _attach(m, slot, detailTex, palette, fabric) {
    const g = this.sets[slot].albedoGain;
    const uni = {
      owPedPalette: palette,
      owPedFabric: fabric,
      // xyz: the measured 1/mean of the baked albedo map, which turns it into
      // an exact unit modulation so `owPedPalette` really is the reflectance.
      owPedGain: { value: new THREE.Vector4(g[0], g[1], g[2], 0) },
      owPedSoil: { value: new THREE.Vector4(GRIME[0], GRIME[1], GRIME[2], 0) },
      owPedPale: { value: new THREE.Vector4(PALE[0], PALE[1], PALE[2], 0) },
      owPedDetail: { value: detailTex ?? null },
      owPedDetailP: {
        value: new THREE.Vector3(
          TILE[slot] / DETAIL_TILE,
          slot === 'skin' ? 0.45 : slot === 'gear' ? 0.55 : 0.55,
          slot === 'skin' ? 0.10 : 0.18
        ),
      },
      owPedRim: { value: new THREE.Vector4(RIM.strength, RIM.edge, RIM.power, 0) },
    };
    m.userData.owPedUniforms = uni;
    const tag = `peds-${slot}`;
    m.customProgramCacheKey = () => tag;
    m.onBeforeCompile = (shader) => {
      for (const k in uni) shader.uniforms[k] = uni[k];

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        attribute vec3 owTint;
        varying vec3 vOwTint;`
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vOwTint = owTint;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        uniform vec3 owPedPalette[ ${PALETTE_SIZE} ];
        uniform vec4 owPedFabric[ ${PALETTE_SIZE} ];
        uniform vec4 owPedGain;
        uniform vec4 owPedSoil;
        uniform vec4 owPedPale;
        uniform vec4 owPedRim;
        uniform sampler2D owPedDetail;
        uniform vec3 owPedDetailP;
        varying vec3 vOwTint;`
      );

      // palette + fabric resolve: slot colour blended toward grime and dust,
      // and the slot's MATERIAL parameters hoisted for the chunks below.
      // `owFab` is declared at function scope, not inside the block, because
      // the roughness, normal and silhouette injections all read it.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        int owSlot = int( clamp( vOwTint.x, 0.0, ${(PALETTE_SIZE - 1).toFixed(1)} ) + 0.5 );
        vec4 owFab = owPedFabric[ owSlot ];
        {
          vec3 owPal = owPedPalette[ owSlot ];
          owPal = mix( owPal, owPedSoil.rgb, clamp( vOwTint.y, 0.0, 1.0 ) );
          owPal = mix( owPal, owPedPale.rgb, clamp( vOwTint.z, 0.0, 1.0 ) );
          // owPedGain normalises the baked map to a unit-mean modulation, so
          // the palette entry IS the surface reflectance. Clamped to the
          // physical ceiling: nothing a person wears reflects more than 90%.
          diffuseColor.rgb = min( diffuseColor.rgb * owPal * owPedGain.rgb, vec3( 0.9 ) );
        }`
      );

      if (detailTex) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          roughnessFactor = clamp( roughnessFactor * owFab.x +
            ( texture2D( owPedDetail, vNormalMapUv * owPedDetailP.x * owFab.z ).w - 0.5 )
              * owPedDetailP.z * owFab.y,
            0.04, 1.0 );`
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          `vec3 owMapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
          owMapN.xy *= normalScale;
          owMapN.xy += ( texture2D( owPedDetail, vNormalMapUv * owPedDetailP.x * owFab.z ).xy * 2.0 - 1.0 )
            * owPedDetailP.y * owFab.y;
          normal = normalize( tbn * normalize( owMapN ) );`
        );
      }

      // silhouette: darken the grazing sliver, using the geometric normal so the
      // band cannot crawl with the detail tile
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `{
          float owF = 1.0 - abs( dot( normalize( vViewPosition ), nonPerturbedNormal ) );
          float owEdge = pow( smoothstep( owPedRim.y, 1.0, owF ), owPedRim.z );
          // THE SILHOUETTE IS A MATERIAL PROPERTY, NOT A CONSTANT.
          // Nap extinction is why a wool coat's outline goes dark, and it is
          // exactly what a waxed jacket, a nylon puffa or a strip of
          // retroreflective tape does NOT do — those get brighter at grazing
          // angles, which is how you tell them apart at 20 m in the rain.
          // One number (owFab.w) drives both halves so they can never
          // disagree: full extinction at 0, none plus a sheen at 0.5.
          outgoingLight *= 1.0 - owPedRim.x * owEdge * clamp( 1.0 - owFab.w * 1.9, 0.15, 1.1 );
          outgoingLight += owFab.w * owEdge *
            ( reflectedLight.directDiffuse + reflectedLight.indirectDiffuse ) * 0.75;
        }
        #include <opaque_fragment>`
      );
    };
  }

  dispose() {
    for (const t of this._disposables) t.dispose();
    for (const m of this._materials) m.dispose();
    this._materials.length = 0;
    this._disposables.length = 0;
  }
}
