/**
 * Procedural texture forge for the player character.
 *
 * Nothing is loaded from disk. Every map is rasterised into a canvas at load
 * time from deterministic value noise (`hash2`) — no Math.random, so a capture
 * is reproducible.
 *
 * Each surface produces a triple: albedo (sRGB), a tangent-space normal derived
 * from a height field by Sobel, and a linear roughness map. That is the minimum
 * the quality bar asks for: "albedo variation, a normal map, roughness
 * variation, and a detail layer visible at 0.5 m".
 *
 * Sizes are small on purpose — a 256 px weave tiled four times across a sleeve
 * has a higher texel density than a 1k map stretched over the whole body, and
 * the whole set costs about 1.5 MB of VRAM.
 */

import * as THREE from 'three';

/* ---------------------------------------------------------------- noise */

function hash2(x, y, seed) {
  let n = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ (seed | 0);
  n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
  n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}

/** Tiling value noise: wraps every `period` so the texture repeats seamlessly. */
function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const w = (a, b) => ((a % b) + b) % b;
  const x0 = w(xi, period), x1 = w(xi + 1, period);
  const y0 = w(yi, period), y1 = w(yi + 1, period);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

function fbm(x, y, period, seed, octaves = 4, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(x * f, y * f, period * f, seed + o * 977) * amp;
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/* -------------------------------------------------------------- helpers */

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function texFromCanvas(c, srgb, aniso) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Sobel a height field into a tangent-space normal map.
 * `strength` scales the gradient; 1 is a gentle relief, 6 is coarse fabric.
 */
function normalFromHeight(height, size, strength, aniso) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        at(x + 1, y - 1) - 2 * at(x + 1, y) - at(x + 1, y + 1);
      const gy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        at(x - 1, y + 1) - 2 * at(x, y + 1) - at(x + 1, y + 1);
      let nx = -gx * strength, ny = -gy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return texFromCanvas(c, false, aniso);
}

function grayTexture(values, size, aniso) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.min(255, values[i] * 255)) | 0;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return texFromCanvas(c, false, aniso);
}

function rgbTexture(rgb, size, aniso) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    d[i * 4] = Math.max(0, Math.min(255, rgb[i * 3] * 255)) | 0;
    d[i * 4 + 1] = Math.max(0, Math.min(255, rgb[i * 3 + 1] * 255)) | 0;
    d[i * 4 + 2] = Math.max(0, Math.min(255, rgb[i * 3 + 2] * 255)) | 0;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return texFromCanvas(c, true, aniso);
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Unpack a hex colour into linear-light RGB so blends are physical. */
function unpack(hex, out) {
  out[0] = srgbToLinear(((hex >> 16) & 255) / 255);
  out[1] = srgbToLinear(((hex >> 8) & 255) / 255);
  out[2] = srgbToLinear((hex & 255) / 255);
  return out;
}

const _c0 = [0, 0, 0];
const _c1 = [0, 0, 0];

/* ------------------------------------------------------------- surfaces */

/**
 * Skin. Mottled dermal colour with a red low-frequency layer (blood under the
 * surface), fine pores in the normal, and a roughness that goes shinier on the
 * high points — that specular break-up is what stops CG skin reading as vinyl.
 */
function makeSkin(base, shadow, seed, size, aniso, stubble) {
  const n = size * size;
  const rgb = new Float32Array(n * 3);
  const rough = new Float32Array(n);
  const height = new Float32Array(n);
  unpack(base, _c0);
  unpack(shadow, _c1);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * 8, v = (y / size) * 8;
      // three scales of mottling
      const blotch = fbm(u * 0.9, v * 0.9, 8, seed, 3);
      const capillary = fbm(u * 3.5, v * 3.5, 28, seed + 31, 3);
      const pore = vnoise(u * 26, v * 26, 208, seed + 77);
      const fine = hash2(x * 3, y * 7, seed + 5);

      // Blend toward the shadow tone in the blotchy lows; push red in the highs.
      const t = 0.14 + blotch * 0.2 + capillary * 0.12;
      const red = (capillary - 0.5) * 0.055;
      let r = _c0[0] * (1 - t) + _c1[0] * t + red;
      let g = _c0[1] * (1 - t) + _c1[1] * t - red * 0.35;
      let b = _c0[2] * (1 - t) + _c1[2] * t - red * 0.3;
      // pore speckle darkens fractionally
      const sp = (pore - 0.5) * 0.014 + (fine - 0.5) * 0.006;
      r += sp; g += sp * 0.95; b += sp * 0.9;

      // stubble: dark high-frequency dots, only where the caller asks for it
      if (stubble > 0) {
        const st = hash2(x * 11 + 3, y * 13 + 7, seed + 191);
        if (st > 1 - stubble * 0.30) {
          const k = 1 - stubble * 0.22;
          r *= k; g *= k * 1.01; b *= k * 1.04;
        }
      }

      rgb[i * 3] = linearToSrgb(Math.max(0, r));
      rgb[i * 3 + 1] = linearToSrgb(Math.max(0, g));
      rgb[i * 3 + 2] = linearToSrgb(Math.max(0, b));

      height[i] = pore * 0.28 + fine * 0.06 + capillary * 0.66;
      // Shinier where the skin bulges, drier in the creases.
      rough[i] = 0.62 - (pore - 0.5) * 0.16 - (blotch - 0.5) * 0.1;
    }
  }
  return {
    map: rgbTexture(rgb, size, aniso),
    normalMap: normalFromHeight(height, size, 0.5, aniso),
    roughnessMap: grayTexture(rough, size, aniso),
  };
}

/**
 * Woven cotton / workshirt. A real weave: two interleaved thread families whose
 * crossings alternate, plus slubs (thick threads), plus a grime gradient so it
 * never reads as a flat colour field.
 */
function makeCloth(base, dark, seed, size, aniso) {
  const n = size * size;
  const rgb = new Float32Array(n * 3);
  const rough = new Float32Array(n);
  const height = new Float32Array(n);
  unpack(base, _c0);
  unpack(dark, _c1);
  const THREADS = 40;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const tx = (x / size) * THREADS;
      const ty = (y / size) * THREADS;
      const cellX = Math.floor(tx), cellY = Math.floor(ty);
      const fx = tx - cellX, fy = ty - cellY;
      // plain weave: warp on top when (cellX+cellY) is even
      const warpTop = ((cellX + cellY) & 1) === 0;
      const warp = Math.sin(fx * Math.PI);
      const weft = Math.sin(fy * Math.PI);
      const h = warpTop ? warp * 0.85 + weft * 0.3 : weft * 0.85 + warp * 0.3;

      const slub = vnoise((x / size) * 9, (y / size) * 60, 60, seed + 13);
      const grime = fbm((x / size) * 3, (y / size) * 3, 6, seed + 61, 4);
      const dust = fbm((x / size) * 14, (y / size) * 14, 28, seed + 101, 3);

      // Fabric absorbs less light in the crossings than in the valleys. Kept
      // SHALLOW on purpose: a high-contrast weave in the albedo turns into a
      // moire screen door once it is minified, and the relief belongs in the
      // normal map where mipping resolves it correctly.
      const shade = 0.90 + h * 0.10;
      const t = 0.06 + grime * 0.26 + (1 - shade) * 0.8;
      let r = (_c0[0] * (1 - t) + _c1[0] * t) * shade;
      let g = (_c0[1] * (1 - t) + _c1[1] * t) * shade;
      let b = (_c0[2] * (1 - t) + _c1[2] * t) * shade;
      // dusty bloom lifts and desaturates
      const dl = (dust - 0.45) * 0.06;
      const lum = (r + g + b) / 3;
      r += (lum - r) * 0.25 * dust + dl;
      g += (lum - g) * 0.25 * dust + dl;
      b += (lum - b) * 0.25 * dust + dl;

      rgb[i * 3] = linearToSrgb(Math.max(0, r));
      rgb[i * 3 + 1] = linearToSrgb(Math.max(0, g));
      rgb[i * 3 + 2] = linearToSrgb(Math.max(0, b));

      height[i] = h * 0.75 + slub * 0.25;
      rough[i] = 0.86 - h * 0.09 + (dust - 0.5) * 0.08;
    }
  }
  return {
    map: rgbTexture(rgb, size, aniso),
    normalMap: normalFromHeight(height, size, 2.6, aniso),
    roughnessMap: grayTexture(rough, size, aniso),
  };
}

/** Denim: 2/1 twill, so the diagonal rib is the read, plus abrasion whitening. */
function makeDenim(base, seed, size, aniso) {
  const n = size * size;
  const rgb = new Float32Array(n * 3);
  const rough = new Float32Array(n);
  const height = new Float32Array(n);
  unpack(base, _c0);
  const THREADS = 46;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const tx = (x / size) * THREADS;
      const ty = (y / size) * THREADS;
      const cx = Math.floor(tx), cy = Math.floor(ty);
      // 2/1 twill: warp floats over two, under one, shifting one per row
      const phase = (cx - cy * 1 + 300) % 3;
      const warpTop = phase < 2;
      const fx = tx - cx, fy = ty - cy;
      const h = warpTop ? Math.sin(fx * Math.PI) : Math.sin(fy * Math.PI) * 0.8;

      const wear = fbm((x / size) * 2.5, (y / size) * 2.5, 5, seed + 7, 4);
      const fuzz = vnoise((x / size) * 90, (y / size) * 90, 90, seed + 44);

      // Indigo is dyed only on the warp; the weft stays pale. That contrast is
      // the whole look of denim.
      const paleness = warpTop ? 0.0 : 0.07;
      const abrasion = Math.max(0, wear - 0.66) * 1.1;
      const t = paleness + abrasion * 0.55;
      const shade = 0.94 + h * 0.06;
      let r = (_c0[0] + (0.55 - _c0[0]) * t) * shade;
      let g = (_c0[1] + (0.56 - _c0[1]) * t) * shade;
      let b = (_c0[2] + (0.6 - _c0[2]) * t) * shade;
      const f = (fuzz - 0.5) * 0.03;
      r += f; g += f; b += f;

      rgb[i * 3] = linearToSrgb(Math.max(0, r));
      rgb[i * 3 + 1] = linearToSrgb(Math.max(0, g));
      rgb[i * 3 + 2] = linearToSrgb(Math.max(0, b));
      height[i] = h * 0.8 + fuzz * 0.2;
      rough[i] = 0.9 - abrasion * 0.12 + (fuzz - 0.5) * 0.06;
    }
  }
  return {
    map: rgbTexture(rgb, size, aniso),
    normalMap: normalFromHeight(height, size, 3.0, aniso),
    roughnessMap: grayTexture(rough, size, aniso),
  };
}

/** Scuffed work-boot leather: Voronoi-ish crease cells + polished high points. */
function makeLeather(base, seed, size, aniso) {
  const n = size * size;
  const rgb = new Float32Array(n * 3);
  const rough = new Float32Array(n);
  const height = new Float32Array(n);
  unpack(base, _c0);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x / size) * 14, v = (y / size) * 14;
      // cheap cellular: distance to the nearest jittered lattice point
      let best = 9, second = 9;
      const cx = Math.floor(u), cy = Math.floor(v);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox, gy = cy + oy;
          const jx = gx + hash2(((gx % 14) + 14) % 14, ((gy % 14) + 14) % 14, seed);
          const jy = gy + hash2(((gx % 14) + 14) % 14, ((gy % 14) + 14) % 14, seed + 9);
          const d = Math.hypot(u - jx, v - jy);
          if (d < best) { second = best; best = d; }
          else if (d < second) second = d;
        }
      }
      const crease = Math.min(1, (second - best) * 2.2);
      const grain = fbm(u * 4, v * 4, 56, seed + 21, 3);
      const scuff = fbm(u * 0.8, v * 0.8, 12, seed + 55, 4);

      const shade = 0.62 + crease * 0.38;
      const dust = Math.max(0, scuff - 0.6) * 0.9;
      let r = _c0[0] * shade + dust * 0.06;
      let g = _c0[1] * shade + dust * 0.055;
      let b = _c0[2] * shade + dust * 0.048;
      rgb[i * 3] = linearToSrgb(Math.max(0, r));
      rgb[i * 3 + 1] = linearToSrgb(Math.max(0, g));
      rgb[i * 3 + 2] = linearToSrgb(Math.max(0, b));
      height[i] = crease * 0.7 + grain * 0.3;
      rough[i] = 0.46 + (1 - crease) * 0.34 + dust * 0.25;
    }
  }
  return {
    map: rgbTexture(rgb, size, aniso),
    normalMap: normalFromHeight(height, size, 2.2, aniso),
    roughnessMap: grayTexture(rough, size, aniso),
  };
}

/** Hair: strand streaks along V, dark, with a low-roughness sheen band. */
function makeHair(base, seed, size, aniso) {
  const n = size * size;
  const rgb = new Float32Array(n * 3);
  const rough = new Float32Array(n);
  const height = new Float32Array(n);
  unpack(base, _c0);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const strand = vnoise((x / size) * 120, (y / size) * 5, 120, seed);
      const clump = fbm((x / size) * 16, (y / size) * 3, 32, seed + 17, 3);
      const shade = 0.55 + strand * 0.5 + clump * 0.25;
      rgb[i * 3] = linearToSrgb(Math.max(0, _c0[0] * shade));
      rgb[i * 3 + 1] = linearToSrgb(Math.max(0, _c0[1] * shade));
      rgb[i * 3 + 2] = linearToSrgb(Math.max(0, _c0[2] * shade));
      height[i] = strand * 0.7 + clump * 0.3;
      rough[i] = 0.34 + (1 - strand) * 0.28;
    }
  }
  return {
    map: rgbTexture(rgb, size, aniso),
    normalMap: normalFromHeight(height, size, 3.4, aniso),
    roughnessMap: grayTexture(rough, size, aniso),
  };
}

/**
 * The eye. One texture, laid out so that the iris lands on the front of the
 * eyeball when the sphere is UV-mapped: u wraps around, v is the polar axis.
 * The sclera carries capillaries — without them an eye is a ping-pong ball.
 */
function makeEye(iris, seed, size, aniso) {
  const n = size * size;
  const rgb = new Float32Array(n * 3);
  const rough = new Float32Array(n);
  unpack(iris, _c0);
  // Iris centre in uv. The body builder's sphere puts u = 0.5 on -Z, which is
  // the direction the character faces, so that is where the iris has to land.
  const CU = 0.5, CV = 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = x / size, v = y / size;
      let du = u - CU;
      if (du > 0.5) du -= 1;
      if (du < -0.5) du += 1;
      const d = Math.hypot(du * 2.0, (v - CV) * 1.0);
      let r, g, b;
      if (d < 0.062) {
        r = g = b = 0.005; // pupil
      } else if (d < 0.215) {
        // iris: radial fibres, darker limbal ring at the edge
        const ang = Math.atan2(v - CV, du);
        const fib = vnoise(ang * 9, d * 40, 64, seed) * 0.55 + 0.55;
        const limbal = d > 0.185 ? 0.28 : 1;
        r = _c0[0] * fib * limbal;
        g = _c0[1] * fib * limbal;
        b = _c0[2] * fib * limbal;
      } else {
        // sclera with capillaries
        const cap = Math.max(0, fbm(u * 26, v * 26, 52, seed + 3, 3) - 0.56) * 2.4;
        r = 0.82 - cap * 0.02;
        g = 0.78 - cap * 0.28;
        b = 0.74 - cap * 0.3;
      }
      rgb[i * 3] = linearToSrgb(Math.max(0, r));
      rgb[i * 3 + 1] = linearToSrgb(Math.max(0, g));
      rgb[i * 3 + 2] = linearToSrgb(Math.max(0, b));
      rough[i] = d < 0.22 ? 0.06 : 0.16;
    }
  }
  return {
    map: rgbTexture(rgb, size, aniso),
    roughnessMap: grayTexture(rough, size, aniso),
  };
}

/* ------------------------------------------------------------------ api */

/**
 * Build the whole texture set for one brother. Returns plain records; the
 * caller wires them onto materials and owns disposal.
 */
export function buildTextures(palette, opts = {}) {
  const aniso = opts.anisotropy ?? 8;
  const seed = opts.seed ?? 1337;
  const S = opts.size ?? 256;
  return {
    skin: makeSkin(palette.skin, palette.skinShadow, seed, S, aniso, 0),
    face: makeSkin(palette.skin, palette.skinShadow, seed + 3, S, aniso, opts.stubble ?? 0.3),
    shirt: makeCloth(palette.shirt, palette.shirtDark, seed + 11, S, aniso),
    pants: makeDenim(palette.pants, seed + 19, S, aniso),
    leather: makeLeather(palette.shoe, seed + 23, S, aniso),
    belt: makeLeather(palette.belt, seed + 29, S >> 1, aniso),
    hair: makeHair(palette.hair, seed + 31, S, aniso),
    eye: makeEye(palette.eye, seed + 37, S, aniso),
  };
}

export function disposeTextures(set) {
  for (const k of Object.keys(set ?? {})) {
    const m = set[k];
    if (!m) continue;
    m.map?.dispose();
    m.normalMap?.dispose();
    m.roughnessMap?.dispose();
  }
}
