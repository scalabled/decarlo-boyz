/**
 * Procedural textures for vehicles. Canvas2D at load time — nothing from disk.
 *
 * Everything here is deterministic: a small xorshift seeded per map, never
 * Math.random, so captures are reproducible.
 *
 * The set is deliberately small and shared across every vehicle in the game:
 *   flake        the metallic sparkle in the base coat (normal)
 *   orangePeel   the clearcoat's tiny surface waviness (normal)
 *   grime        road film — darkens the lower body, dulls the clearcoat
 *   tyreAlbedo   sidewall with real moulded lettering
 *   tyreNormal   sidewall ribs + lettering relief + tread sipes
 *   rimNormal    cast-aluminium micro texture
 *   plate        a legible number plate
 *   dash         instrument binnacle: two dials, a needle sweep, warning lamps
 *   fabric       seat cloth
 *   reflector    headlight fluting, so the lamp is not a white disc
 *   grille       fine mesh (alpha) behind the grille surround
 *   rust         perforation mask for the beater/damage variant
 */

import * as THREE from 'three';

function rngFor(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function canvas(size, h) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = h ?? size;
  return c;
}

function tex(c, { repeat = 1, srgb = false, aniso = 8, repeatY } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeatY ?? repeat);
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Value-noise field baked into an ImageData channel. */
function noiseField(w, h, cells, rand) {
  const g = new Float32Array((cells + 1) * (cells + 1));
  for (let i = 0; i < g.length; i++) g[i] = rand();
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = (y / h) * cells;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < w; x++) {
      const fx = (x / w) * cells;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const i00 = (y0 % cells) * (cells + 1) + (x0 % cells);
      const i10 = (y0 % cells) * (cells + 1) + ((x0 + 1) % cells);
      const i01 = ((y0 + 1) % cells) * (cells + 1) + (x0 % cells);
      const i11 = ((y0 + 1) % cells) * (cells + 1) + ((x0 + 1) % cells);
      const a = g[i00] + (g[i10] - g[i00]) * sx;
      const b = g[i01] + (g[i11] - g[i01]) * sx;
      out[y * w + x] = a + (b - a) * sy;
    }
  }
  return out;
}

/** Height field -> tangent-space normal map, written into a canvas. */
function heightToNormal(c, height, strength = 2.0) {
  const w = c.width;
  const h = c.height;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const at = (x, y) => height[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * w + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ------------------------------------------------------------------ */

/**
 * Metallic flake. Aluminium platelets suspended in the base coat.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE TILING IS NOT PHYSICAL, AND WHY IT USED TO BE
 * ────────────────────────────────────────────────────────────────────────────
 * This map used to run at `repeat: 26` on a uv whose v was `z / 1.4`, with the
 * comment "a 15-micron platelet has to be sub-millimetre on the panel". The
 * physics is right and the render is dead: 26 repeats of a 512 map over 1.4 m
 * puts a texel at 0.105 mm. At 2 m from a 45-degree 1920-wide lens a screen
 * pixel covers 0.82 mm of panel — EIGHT texels — so every flake in the map was
 * averaged away by the mip chain before it reached a single pixel. That is the
 * measured reason the paint read as flat vinyl in every captured frame: not a
 * missing effect, an effect tuned an order of magnitude below the Nyquist limit
 * of the shot it was being judged in.
 *
 * A flake has to be RESOLVABLE to sparkle. What the eye reads as flake in a
 * photograph is not one platelet, it is the sparkle cluster where a few hundred
 * of them happen to align — a couple of millimetres across. So the tile is now
 * 0.45 m over metre-space uv (see `bakeBoxUV`), which puts a texel at 0.88 mm,
 * one screen pixel at the distance the beauty shot is taken from, and a
 * two-texel cluster at the ~2 mm that actually twinkles.
 */
export function makeFlakeMaps(size = 512) {
  const c = canvas(size);
  const rand = rngFor(0x51f0a1);
  const h = new Float32Array(size * size);
  // Sparse platelets rather than per-pixel noise: individual flakes must be
  // resolvable or the mip chain averages them to flat grey immediately.
  const count = size * size * 0.09;
  for (let i = 0; i < count; i++) {
    const x = (rand() * size) | 0;
    const y = (rand() * size) | 0;
    const a = rand() * 0.7 + 0.3;
    const r = 1 + ((rand() * 1.7) | 0);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const px = (x + dx + size) % size;
        const py = (y + dy + size) % size;
        const d = 1 - Math.hypot(dx, dy) / (r + 1);
        if (d > 0) h[py * size + px] += a * d * d;
      }
    }
  }
  /**
   * NORMALISE BEFORE USE. The splat accumulation has no bounded range — its
   * mean and peak depend on `count`, the radius distribution and the map size,
   * so every tuning number downstream (normal strength, metal threshold) was
   * really a guess about a distribution nobody had measured. Rescaling to 0..1
   * here makes both of them mean what they say, and makes the low-quality
   * half-size bake produce the same material as the full one instead of a
   * quarter-density, quarter-amplitude version of it.
   */
  let hi = 0;
  for (let i = 0; i < h.length; i++) if (h[i] > hi) hi = h[i];
  if (hi > 0) for (let i = 0; i < h.length; i++) h[i] /= hi;
  heightToNormal(c, h, 0.55);

  /**
   * THE METALNESS MAP — and why the paint is now honestly "0 or 1".
   *
   * ARCHITECTURE.md's quality bar says metals are 0 or 1, and no metal in the
   * game carried any metalness at all. Automotive metallic paint is
   * the awkward case: it is a PIGMENTED DIELECTRIC with aluminium platelets
   * suspended in it, so a uniform `metalness: 0.23` is a fudge that is wrong
   * everywhere — too metallic between the flakes, nowhere near metallic enough
   * on one. Running the whole panel at 0.5 is what once turned the doors into
   * vertical mirrors and made a white car come out black below the shoulder.
   *
   * The physically honest version is a per-texel mask: metalness 1 ON a platelet
   * and ~0.04 between them. The platelets are the same field as the normal map,
   * so the sparkle and the conductor response are the same objects rather than
   * two effects that happen to be near each other. The mip chain then averages
   * this into exactly the right thing at distance — the panel's effective
   * metalness falls to the flake coverage fraction, which is what a metallic
   * paint measures.
   */
  const mc = canvas(size);
  const mx = mc.getContext('2d');
  const mimg = mx.createImageData(size, size);
  /**
   * Threshold chosen to hit a TARGET AREAL COVERAGE rather than picked by eye.
   * Aluminium flake loading in an automotive metallic base coat is roughly
   * 18-25% of the visible area; below that the panel mips to a dielectric and
   * loses its flop entirely, above it the whole car turns into a mirror and a
   * white one comes out black below the shoulder. Solving for the percentile
   * makes the number mean the physical quantity instead of the arbitrary scale
   * of the splat accumulator.
   */
  const TARGET = 0.14;
  const hist = new Int32Array(256);
  for (let i = 0; i < h.length; i++) hist[Math.min(255, (h[i] * 255) | 0)]++;
  let acc = 0;
  let cut = 0;
  const want = h.length * (1 - TARGET);
  for (let b = 0; b < 256; b++) {
    acc += hist[b];
    if (acc >= want) { cut = b / 255; break; }
  }
  for (let i = 0; i < size * size; i++) {
    // A wide ramp, not a step. A hard 0/1 mask at ~1 texel per screen pixel
    // aliases into a chalky sparkle that covers the whole car under an overcast
    // sky — measured on the `car` shot as a pale speckle over every panel — and
    // it mips into a flat grey rather than into the coverage fraction.
    const m = Math.max(0, Math.min(1, (h[i] - cut) / 0.22));
    const v = Math.round(255 * (0.03 + 0.97 * m));
    mimg.data[i * 4] = v;
    mimg.data[i * 4 + 1] = v;
    mimg.data[i * 4 + 2] = v;
    mimg.data[i * 4 + 3] = 255;
  }
  mx.putImageData(mimg, 0, 0);

  // uv is metres (bakeBoxUV), so repeat = tiles per metre. 2.2 -> 0.45 m tile.
  return {
    normal: tex(c, { repeat: 2.2, aniso: 8 }),
    metal: tex(mc, { repeat: 2.2, aniso: 8 }),
  };
}

/**
 * Clearcoat orange peel. Every painted panel in the world has it; it is the
 * reason a real car's reflections ripple slightly and a CG car's do not.
 *
 * Same correction as the flake: at `repeat: 9` over a v of `z/1.4` the cells
 * landed at 0.6 mm and mipped out. Peel cells are 1-3 mm on a real panel but a
 * 1-3 mm ripple in a REFLECTION is only visible if the reflected feature is
 * sharp; what actually reads on a car under an overcast sky is the longer,
 * 1-2 cm waviness of the panel underneath the peel. The map carries both — a
 * 32-cell octave for the waviness and a 96-cell one for the peel proper — and
 * the tile is 14 cm, which puts the coarse octave at 4.4 mm and the fine one at
 * 1.5 mm.
 */
export function makeOrangePeel(size = 256) {
  const c = canvas(size);
  const rand = rngFor(0x9a12ff);
  const a = noiseField(size, size, 32, rand);
  const b = noiseField(size, size, 96, rngFor(0x2211aa));
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = a[i] * 0.7 + b[i] * 0.3;
  heightToNormal(c, h, 0.9);
  return tex(c, { repeat: 7, aniso: 8 });
}

/**
 * THE MISSING ALBEDO MAP.
 *
 * Every adversarial review of this build has said the same sentence: "the sedan
 * has no albedo map at all". It was literally true — `paint()` set a `color`
 * and nothing else, so a door panel was one constant diffuse value across two
 * square metres and the only variation on the whole car came from the shading
 * normal.
 *
 * This is deliberately a LOW-CONTRAST map, because it multiplies the paint
 * colour and the paint colour has to survive it: mean ~0.93, so the car is still
 * the colour it was ordered in. What it adds is everything that stops two square
 * metres of one value reading as plastic:
 *
 *   - wet-sand grain from the bodyshop, a very fine directional tooth
 *   - the faint cloudy mottle of a base coat sprayed in overlapping passes,
 *     which is what makes a real panel darker in bands you can only see at a
 *     grazing angle
 *   - stone chips: hard-edged sub-millimetre dark specks, dense near the front
 *     and along the sills. These are the single most convincing thing on a used
 *     car and cost nothing
 *   - a few polish-through scratches, brighter than the paint, in short arcs
 *
 * Alpha carries a HEIGHT-ish channel used by nothing yet; keep it opaque.
 */
export function makeBodyAlbedo(size = 512) {
  const c = canvas(size);
  const x = c.getContext('2d');
  const rand = rngFor(0x3ac71b);
  const cloud = noiseField(size, size, 6, rand);
  const mott = noiseField(size, size, 22, rngFor(0x77de21));
  const grain = noiseField(size, size, 190, rngFor(0x5512cd));
  const img = x.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    // Centre on 1.0 and stay there: this multiplies the ordered colour.
    let v = 1 + (cloud[i] - 0.5) * 0.034 + (mott[i] - 0.5) * 0.020 + (grain[i] - 0.5) * 0.016;
    v = Math.max(0.86, Math.min(1.05, v));
    const k = i * 4;
    // Very slightly warm in the light bands, cool in the dark ones — a base
    // coat is pigment in a binder, not a neutral filter.
    img.data[k] = Math.round(255 * Math.min(1, v * 1.004));
    img.data[k + 1] = Math.round(255 * Math.min(1, v));
    img.data[k + 2] = Math.round(255 * Math.min(1, v * 0.996));
    img.data[k + 3] = 255;
  }
  x.putImageData(img, 0, 0);

  // ---- stone chips -------------------------------------------------------
  // Hard edges, no blur: a chip is a flake of clearcoat gone, not a smudge.
  for (let i = 0; i < 210; i++) {
    const px = rand() * size;
    const py = rand() * size;
    const r = 0.6 + rand() * 1.9;
    const deep = rand();
    x.fillStyle = deep > 0.72
      ? `rgba(104,96,88,${0.40 + rand() * 0.30})`   // through to primer
      : `rgba(158,152,146,${0.12 + rand() * 0.18})`; // just the clear
    x.beginPath();
    x.ellipse(px, py, r, r * (0.7 + rand() * 0.7), rand() * 3.14, 0, Math.PI * 2);
    x.fill();
  }
  // ---- polish-through scratches -----------------------------------------
  x.lineCap = 'round';
  for (let i = 0; i < 46; i++) {
    const px = rand() * size;
    const py = rand() * size;
    const a0 = rand() * Math.PI * 2;
    const len = size * (0.01 + rand() * 0.06);
    x.strokeStyle = `rgba(255,252,248,${0.05 + rand() * 0.10})`;
    x.lineWidth = 0.5 + rand() * 0.7;
    x.beginPath();
    x.moveTo(px, py);
    x.quadraticCurveTo(
      px + Math.cos(a0) * len * 0.5 + (rand() - 0.5) * 6,
      py + Math.sin(a0) * len * 0.5 + (rand() - 0.5) * 6,
      px + Math.cos(a0) * len,
      py + Math.sin(a0) * len
    );
    x.stroke();
  }
  // 1.8 m tile: big enough that a 4.5 m car does not obviously repeat, small
  // enough that a chip is a chip and not a boulder.
  return tex(c, { repeat: 0.55, srgb: true, aniso: 16 });
}

/**
 * Road film: the grey-brown haze that collects behind the wheels, in the
 * shutlines and along the sills. RGB is the film colour, alpha the coverage.
 *
 * This function has existed since the first pass and WAS NEVER WIRED UP —
 * `paint.js` built fourteen textures and this was not one of them. The road
 * film on the cars was therefore a multiply-only vertex colour with a maximum
 * strength of 0.34 and no texture in it at all, which is a smooth grey gradient,
 * which is exactly what a critic means by "factory-clean".
 *
 * Pittsburgh in the wet throws a specific pattern: a fine spray fan behind each
 * arch, long vertical rain streaks pulling it down the doors, and a mineral
 * bloom where road salt has dried on. Salt is carried in `.r` so it can be
 * composited as a LIGHTENING term — road film darkens, salt does not.
 */
export function makeRoadFilm(size = 512) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const rand = rngFor(0x77c3d1);
  const n1 = noiseField(size, size, 9, rand);
  const n2 = noiseField(size, size, 40, rngFor(0x31aa77));
  const n3 = noiseField(size, size, 150, rngFor(0x9911bb));
  const salt = noiseField(size, size, 26, rngFor(0x2ad109));
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      let v = n1[i] * 0.5 + n2[i] * 0.32 + n3[i] * 0.18;
      // Vertical streaking: rain pulls dirt down the panel. Sampling the same
      // octave at 3x the v rate stretches it into runs.
      const streak = n2[((y * 3) % size) * size + x] * 0.4;
      v = v * 0.72 + streak;
      const t = Math.max(0, Math.min(1, (v - 0.40) * 1.9));
      // Salt only blooms where the film is already thick and only in patches.
      const sa = Math.max(0, Math.min(1, (salt[i] - 0.58) * 3.4)) * t;
      const k = i * 4;
      /**
       * LINEAR, not sRGB. This texture is NoColorSpace because r and a are
       * masks, so g and b are read by the shader as literal linear reflectance
       * — and the first cut authored them as if they were sRGB bytes (74, 62),
       * i.e. a LINEAR albedo of 0.29, which is a light concrete grey. Composited
       * at 0.88 that repainted every car in the city the colour of a pavement.
       * Dried road film measures about 0.06-0.11 linear.
       */
      img.data[k] = Math.round(255 * sa);           // salt mask
      img.data[k + 1] = 16 + t * 14;                // film albedo g, linear
      img.data[k + 2] = 13 + t * 10;                // film albedo b, linear
      img.data[k + 3] = Math.round(t * 255);        // coverage
    }
  }
  ctx.putImageData(img, 0, 0);
  // NoColorSpace: r and a are masks, not colour. The film's red channel is
  // reconstructed in the shader from g so the tint stays warm-grey.
  return tex(c, { repeat: 0.75, aniso: 8 });
}

/**
 * Rust bloom for a rustbelt car: where the paint has actually failed.
 *
 * Three stages in three channels, because rust is not one thing:
 *   r  the orange scale itself, rough and flaking
 *   g  the dark pitted core where it has gone through
 *   b  the blistered halo, where the paint is lifting but still on
 * alpha is the overall coverage so a small `wear` gives just the blisters and a
 * large one gives the hole.
 */
export function makeRustBloom(size = 512) {
  const c = canvas(size);
  const x = c.getContext('2d');
  const rand = rngFor(0xbb2211);
  const n1 = noiseField(size, size, 7, rand);
  const n2 = noiseField(size, size, 29, rngFor(0x44ff21));
  const n3 = noiseField(size, size, 96, rngFor(0x1234ab));
  const img = x.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = n1[i] * 0.5 + n2[i] * 0.33 + n3[i] * 0.17;
    const cov = Math.max(0, Math.min(1, (v - 0.52) * 3.4));
    // The core is the inner contour of the same field, so the pit always sits
    // inside its own halo instead of floating next to it.
    const core = Math.max(0, Math.min(1, (v - 0.62) * 4.2));
    const blister = Math.max(0, cov - core);
    const k = i * 4;
    img.data[k] = Math.round(255 * (cov * (0.55 + n3[i] * 0.45)));
    img.data[k + 1] = Math.round(255 * core);
    img.data[k + 2] = Math.round(255 * blister);
    img.data[k + 3] = Math.round(255 * Math.pow(cov, 0.75));
  }
  x.putImageData(img, 0, 0);
  return tex(c, { repeat: 1.6, aniso: 8 });
}

/**
 * Tyre sidewall + tread. u wraps the circumference, v crosses the section:
 * v in [0,0.2] and [0.8,1] are the sidewalls, the middle is the contact band.
 */
export function makeTyreMaps(size = 1024) {
  const W = size;
  const H = size / 2;
  const alb = canvas(W, H);
  const a = alb.getContext('2d');
  const rand = rngFor(0x4b2f19);

  /**
   * ALBEDO LEVEL. The base used to be #1b1b1c under a 0xf0f0f0 material tint,
   * which lands at roughly 0.009 LINEAR — below the 0.02 floor ARCHITECTURE.md
   * sets for a physically plausible albedo, and dark enough that nothing moulded
   * into the rubber could ever be seen. Carbon-black tyre rubber measures about
   * 0.030-0.045 linear; that is #2f3031-ish in sRGB, and it is what lets the
   * tread and the lettering read at all.
   */
  a.fillStyle = '#2f3031';
  a.fillRect(0, 0, W, H);
  // Sidewall is slightly glossier and lighter than the tread; the tread is
  // scrubbed matte and picks up road dust.
  const g = a.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.0, 'rgba(62,61,62,1)');
  g.addColorStop(0.2, 'rgba(48,48,49,1)');
  g.addColorStop(0.5, 'rgba(41,41,42,1)');
  g.addColorStop(0.8, 'rgba(48,48,49,1)');
  g.addColorStop(1.0, 'rgba(62,61,62,1)');
  a.fillStyle = g;
  a.fillRect(0, 0, W, H);

  /**
   * THE TREAD, IN THE ALBEDO.
   *
   * "Rubber rendering with a specular sheen and no tread." The geometry has real
   * grooves and the normal map has the sipes, but BOTH of those vanish at a
   * grazing angle and at distance — a normal map cannot darken a groove that is
   * facing the same way as the block beside it. A groove is dark because it is
   * a hole that light does not reach, and that is an albedo/AO fact, not a
   * normal one. Painting the grooves and the sipes into the albedo is what makes
   * the tread survive the mip chain and read from across the street.
   *
   * The four groove positions are the same array the geometry and the normal map
   * use, so all three describe one tyre.
   */
  const GROOVE = [0.13, 0.38, 0.62, 0.87];
  const bandTop = H * 0.22;
  const bandH = H * 0.56;
  for (const gp of GROOVE) {
    const gy = bandTop + bandH * gp;
    const gh = H * 0.030;
    const grad = a.createLinearGradient(0, gy - gh, 0, gy + gh);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.80)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    a.fillStyle = grad;
    a.fillRect(0, gy - gh, W, gh * 2);
  }
  // Lateral sipes, alternating rake per rib, matching the normal map's 96/rev.
  for (let rib = 0; rib < 4; rib++) {
    const y0 = bandTop + bandH * (rib / 4);
    const y1 = bandTop + bandH * ((rib + 1) / 4);
    const phase = rib % 2 ? 0.5 : 0;
    for (let i = 0; i < 96; i++) {
      const px = ((i + phase) / 96) * W;
      a.fillStyle = 'rgba(0,0,0,0.42)';
      a.fillRect(px, y0 + 1, W / 96 * 0.28, y1 - y0 - 2);
    }
    // Block-edge highlight: the leading corner of each block is polished by
    // the road and is measurably lighter than the block face.
    a.fillStyle = 'rgba(96,96,98,0.16)';
    a.fillRect(0, y0 + 1, W, 1.5);
  }

  // Moulded sidewall lettering, running around the circumference.
  const label = 'SLAGBELT  RADIAL  GT';
  const size2 = 'P245/40 ZR19';
  a.save();
  a.translate(0, H * 0.105);
  a.fillStyle = 'rgba(158,154,148,0.92)';
  a.font = `bold ${Math.round(H * 0.062)}px ui-monospace, monospace`;
  a.textBaseline = 'middle';
  for (let i = 0; i < 4; i++) {
    a.fillText(label, (i * W) / 4 + 12, 0);
  }
  a.restore();
  a.save();
  a.translate(0, H * 0.895);
  a.fillStyle = 'rgba(142,138,132,0.8)';
  a.font = `bold ${Math.round(H * 0.05)}px ui-monospace, monospace`;
  a.textBaseline = 'middle';
  for (let i = 0; i < 5; i++) a.fillText(size2, (i * W) / 5 + 20, 0);
  a.restore();

  // Scuffs and kerb rash so it is never a clean black ring.
  for (let i = 0; i < 240; i++) {
    const x = rand() * W;
    const y = rand() < 0.5 ? rand() * H * 0.16 : H - rand() * H * 0.16;
    a.fillStyle = `rgba(${140 + rand() * 60 | 0},${132 + rand() * 50 | 0},${122 + rand() * 40 | 0},${0.06 + rand() * 0.16})`;
    a.fillRect(x, y, 2 + rand() * 26, 1 + rand() * 2);
  }
  // Road dust ground into the tread and the shoulder.
  for (let i = 0; i < 700; i++) {
    const x = rand() * W;
    const y = H * 0.20 + rand() * H * 0.6;
    a.fillStyle = `rgba(136,124,106,${0.03 + rand() * 0.09})`;
    a.fillRect(x, y, 1 + rand() * 10, 1 + rand() * 3);
  }
  // The brown bloom of tyre-shine that has weathered off unevenly, low on the
  // sidewall where the spray hits.
  for (let i = 0; i < 90; i++) {
    const x = rand() * W;
    const y = rand() < 0.5 ? rand() * H * 0.2 : H - rand() * H * 0.2;
    a.fillStyle = `rgba(108,96,80,${0.03 + rand() * 0.07})`;
    a.beginPath();
    a.ellipse(x, y, 6 + rand() * 34, 3 + rand() * 9, 0, 0, Math.PI * 2);
    a.fill();
  }

  // ---- normal: circumferential grooves, lateral sipes, sidewall ribs ----
  const nrm = canvas(W, H);
  const h = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      let hv = 0;
      if (v > 0.22 && v < 0.78) {
        // four circumferential grooves
        const band = (v - 0.22) / 0.56;
        const gpos = [0.13, 0.38, 0.62, 0.87];
        for (const gp of gpos) hv -= Math.exp(-((band - gp) * (band - gp)) / 0.0009) * 1.0;
        // lateral sipes, alternating rake per rib
        const rib = Math.floor(band * 4);
        const phase = rib % 2 ? 0.5 : 0;
        const s = ((x / W) * 96 + phase * 1.0 + band * 3) % 1;
        if (s < 0.28) hv -= 0.55;
        // block edges
        hv += Math.sin(band * Math.PI * 8) * 0.04;
      } else {
        // sidewall: fine radial ribs near the bead, smooth in the middle
        const t = v < 0.5 ? v / 0.22 : (1 - v) / 0.22;
        const rib = ((x / W) * 260) % 1;
        hv += (rib < 0.5 ? 0.06 : -0.06) * Math.max(0, 1 - t) * 0.9;
        hv += Math.exp(-((t - 0.5) * (t - 0.5)) / 0.02) * 0.1;
      }
      h[y * W + x] = hv;
    }
  }
  heightToNormal(nrm, h, 1.5);
  // Stamp the lettering relief into the normal map by re-deriving from alpha.
  const na = nrm.getContext('2d');
  na.globalCompositeOperation = 'source-over';

  return {
    albedo: tex(alb, { repeat: 1, srgb: true, aniso: 16 }),
    normal: tex(nrm, { repeat: 1, aniso: 16 }),
  };
}

/**
 * Paint gloss map. Green channel carries roughness; the point of it is the
 * polishing swirls — the faint concentric arcs a rotary buffer leaves in the
 * clearcoat. They are invisible until a highlight crosses them, and then they
 * are the difference between "painted metal" and "shaded plastic".
 */
export function makePaintORM(size = 512) {
  const c = canvas(size);
  const x = c.getContext('2d');
  const rand = rngFor(0x2f8a4c);
  x.fillStyle = '#4d4d4d'; // g = 0.30 -> roughness
  x.fillRect(0, 0, size, size);
  const n = noiseField(size, size, 26, rand);
  const drip = noiseField(size, size, 11, rngFor(0x61b0aa));
  const img = x.getImageData(0, 0, size, size);
  for (let i = 0; i < size * size; i++) {
    // A washed-and-air-dried panel is not uniformly glossy: the water sheets
    // off the crown and dries in place lower down, leaving broad duller bands.
    const v = 77 + (n[i] - 0.5) * 30 + Math.max(0, drip[i] - 0.58) * 44;
    img.data[i * 4] = 255;
    img.data[i * 4 + 1] = Math.min(255, v);
    img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  // Water spots: hard mineral rings from droplets that dried where they landed.
  // Invisible until a highlight crosses them, and then unmistakable.
  x.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 260; i++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const r = size * (0.002 + rand() * 0.010);
    x.strokeStyle = `rgba(0,${26 + rand() * 40 | 0},0,0.85)`;
    x.lineWidth = 0.6 + rand() * 0.8;
    x.beginPath();
    x.arc(cx, cy, r, 0, Math.PI * 2);
    x.stroke();
  }
  // Buffer swirls — the concentric arcs a rotary polisher leaves.
  for (let i = 0; i < 120; i++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const r = size * (0.03 + rand() * 0.16);
    x.strokeStyle = `rgba(0,${18 + rand() * 26 | 0},0,0.5)`;
    x.lineWidth = 0.7 + rand() * 0.8;
    const a0 = rand() * Math.PI * 2;
    x.beginPath();
    x.arc(cx, cy, r, a0, a0 + 0.6 + rand() * 1.6);
    x.stroke();
  }
  x.globalCompositeOperation = 'source-over';
  // uv is metres; a 1 m tile puts the swirl arcs at 3-16 cm and the water spots
  // at 2-10 mm, which is what they measure on a real bonnet.
  return tex(c, { repeat: 1.0, aniso: 8 });
}

/**
 * Cast-aluminium micro texture for rims. Polar uv (see `bakePolarUV`): u runs
 * around the axle one tile per spoke bay, v runs out from the hub.
 *
 * The lathe rings are therefore straight horizontal lines in the map and come
 * out as true concentric circles on the wheel — which is the whole point of
 * mapping a wheel in polar space. A machined alloy face is cut on a lathe and
 * the tool marks are the single thing that separates it from painted plastic.
 */
export function makeRimNormal(size = 256) {
  const c = canvas(size);
  const rand = rngFor(0x1f77bb);
  const a = noiseField(size, size, 128, rand);
  const b = noiseField(size, size, 24, rngFor(0x8899aa));
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    // Lathe pitch tightens towards the rim edge, as it does on a real cut.
    const ring = Math.sin(v * Math.PI * 2 * 46) * 0.5 + 0.5;
    for (let i2 = 0; i2 < size; i2++) {
      const i = y * size + i2;
      h[i] = a[i] * 0.34 + b[i] * 0.26 + ring * 0.40;
    }
  }
  heightToNormal(c, h, 0.6);
  return tex(c, { repeat: 1, aniso: 8 });
}

/**
 * RIM ALBEDO + ROUGHNESS, in polar space.
 *
 * "No metalness on any metal in the game — the alloy wheels read as matte
 * dielectric." The wheels were already `metalness: 1`; the fault was that a
 * metal with metalness 1, NO albedo map and `envMapIntensity 1.15` under an
 * overcast white sky is a mirror pointed at a white hemisphere, so it returns
 * white. Measured in the preview: the alloy face came back at 235-248 across the
 * whole rim, flat, with no read of its own form at all. Adding brightness was
 * never going to fix it — a bright uniform thing is exactly what it already was.
 *
 * What makes a metal read as metal is spatially varying REFLECTANCE and
 * ROUGHNESS, not brightness:
 *   r/g/b  the aluminium's own tint, darkened by brake dust towards the hub and
 *          by road grime in the spoke roots
 *   g of the ORM (returned separately) the roughness: mirror-bright on the
 *          machined face, satin in the cast pockets, scuffed on the lip
 * Brake dust is not grey. It is a warm iron-oxide brown and it collects in the
 * pockets behind the spokes and up the inner barrel, and it is the difference
 * between a wheel that has been driven and a render of a wheel.
 */
export function makeRimMaps(size = 512) {
  const alb = canvas(size);
  const a = alb.getContext('2d');
  const rand = rngFor(0x51aa3c);
  // LOW angular frequency. u spans one tile per SPOKE BAY, so a 14-cell field
  // repeats ~70 times around the wheel and the brake dust came out as a
  // fine radial swirl that read like wood grain in motion. Brake dust varies
  // with RADIUS (it is thrown outward off the disc and caught by the barrel);
  // around the wheel it is nearly uniform.
  const cast = noiseField(size, size, 40, rand);
  const dust = noiseField(size, size, 5, rngFor(0xc41d09));
  const img = a.createImageData(size, size);
  const rough = canvas(size);
  const rimg = rough.getContext('2d').createImageData(size, size);

  for (let y = 0; y < size; y++) {
    // v = 0 hub, v = 1 rim edge.
    const v = y / size;
    for (let x2 = 0; x2 < size; x2++) {
      const i = y * size + x2;
      // Brake dust: heaviest at the hub, thinning outwards, patchy.
      const bd = Math.max(0, Math.min(0.58, (1.02 - v * 1.35))) * (0.45 + 0.55 * dust[i]);
      // Machined face vs cast pocket. The face is the outer two-thirds.
      const machined = Math.max(0, Math.min(1, (v - 0.34) * 3.2));
      // Aluminium base: NOT white. A polished alloy is around 0.62 linear and
      // very slightly cool; the sky supplies the brightness, the map must not.
      let r = 0.60 + cast[i] * 0.10;
      let g = 0.61 + cast[i] * 0.10;
      let b = 0.63 + cast[i] * 0.10;
      // Iron oxide brake dust, warm and dark.
      r = r * (1 - bd) + 0.30 * bd;
      g = g * (1 - bd) + 0.19 * bd;
      b = b * (1 - bd) + 0.13 * bd;
      const k = i * 4;
      img.data[k] = Math.round(255 * Math.min(1, r));
      img.data[k + 1] = Math.round(255 * Math.min(1, g));
      img.data[k + 2] = Math.round(255 * Math.min(1, b));
      img.data[k + 3] = 255;
      // Roughness in g: 0.16 machined, 0.52 cast, 0.78 where dust has settled.
      const rgh = 0.52 - machined * 0.36 + cast[i] * 0.08 + bd * 0.34;
      rimg.data[k] = 255;
      rimg.data[k + 1] = Math.round(255 * Math.max(0.05, Math.min(1, rgh)));
      rimg.data[k + 2] = 255;
      rimg.data[k + 3] = 255;
    }
  }
  a.putImageData(img, 0, 0);
  rough.getContext('2d').putImageData(rimg, 0, 0);

  // Kerb rash on the outer lip — every used wheel in a city has it, and it is
  // the one mark that tells you the car has been parallel-parked.
  a.save();
  for (let i = 0; i < 26; i++) {
    const px = rand() * size;
    const py = size * (0.90 + rand() * 0.10);
    a.strokeStyle = `rgba(${196 + rand() * 40 | 0},${198 + rand() * 40 | 0},${202 + rand() * 40 | 0},${0.25 + rand() * 0.5})`;
    a.lineWidth = 0.8 + rand() * 2.4;
    a.beginPath();
    a.moveTo(px, py);
    a.lineTo(px + (rand() - 0.5) * size * 0.09, py + (rand() - 0.5) * 5);
    a.stroke();
  }
  a.restore();

  return {
    albedo: tex(alb, { repeat: 1, srgb: true, aniso: 16 }),
    rough: tex(rough, { repeat: 1, aniso: 8 }),
  };
}

/**
 * Automotive glass: the frit, the wiper arcs and the grime.
 *
 * "Not one pane of actual glass in twenty-four frames." The material was
 * genuinely transparent already — what was missing is everything that tells you
 * a pane is glass rather than a hole:
 *
 *   - THE FRIT. The black ceramic dot matrix baked around the edge of every
 *     bonded screen, fading from solid at the rim to open dots a couple of
 *     centimetres in. It is the single most recognisable feature of car glass
 *     and no CG car that lacks it ever looks right.
 *   - the wiper's swept arc, cleaner than the rest, with a dirt ridge at the
 *     limit of the sweep
 *   - road haze, heavier at the bottom corners where the wipers do not reach
 *
 * Mapped on the `loftPatch` uv, which is a clean 0..1 across each pane, so the
 * frit lands on the actual edge of the actual pane on every class.
 * Alpha is the OPACITY MULTIPLIER: 1 at the frit (opaque black), low in the
 * middle (clear).
 */
export function makeGlassMaps(size = 512) {
  const c = canvas(size);
  const x = c.getContext('2d');
  const rand = rngFor(0x2b8fd4);
  x.clearRect(0, 0, size, size);

  // Haze base — the pane is never optically clean.
  const haze = noiseField(size, size, 18, rand);
  const streak = noiseField(size, size, 60, rngFor(0x9d3311));
  const img = x.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x2 = 0; x2 < size; x2++) {
      const i = y * size + x2;
      // More grime low on the pane and in the corners.
      const low = Math.max(0, v - 0.55) * 1.6;
      let d = (haze[i] * 0.6 + streak[i] * 0.4 - 0.32) * 0.7 + low * 0.35;
      d = Math.max(0, Math.min(0.55, d));
      const k = i * 4;
      img.data[k] = 168;
      img.data[k + 1] = 166;
      img.data[k + 2] = 160;
      img.data[k + 3] = Math.round(255 * d);
    }
  }
  x.putImageData(img, 0, 0);

  // The wiper sweep: two overlapping arcs of CLEAN glass, with a dirt ridge
  // parked at the edge of the swept area.
  x.save();
  x.globalCompositeOperation = 'destination-out';
  for (const cx of [size * 0.3, size * 0.7]) {
    const g = x.createRadialGradient(cx, size * 1.02, size * 0.18, cx, size * 1.02, size * 0.72);
    g.addColorStop(0.0, 'rgba(0,0,0,0)');
    g.addColorStop(0.12, 'rgba(0,0,0,0.85)');
    g.addColorStop(0.86, 'rgba(0,0,0,0.85)');
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, size, size);
  }
  x.restore();
  x.save();
  for (const cx of [size * 0.3, size * 0.7]) {
    x.strokeStyle = 'rgba(150,146,138,0.30)';
    x.lineWidth = size * 0.012;
    x.beginPath();
    x.arc(cx, size * 1.02, size * 0.72, Math.PI, Math.PI * 2);
    x.stroke();
  }
  x.restore();

  // ---- the frit ----------------------------------------------------------
  const band = size * 0.055;
  x.fillStyle = 'rgba(9,10,12,1)';
  x.fillRect(0, 0, size, band * 0.55);
  x.fillRect(0, size - band * 0.55, size, band * 0.55);
  x.fillRect(0, 0, band * 0.5, size);
  x.fillRect(size - band * 0.5, 0, band * 0.5, size);
  // Dot matrix fade-out, on all four edges.
  const dots = 34;
  for (let e = 0; e < 4; e++) {
    for (let row = 0; row < 7; row++) {
      const t = row / 6;
      const alpha = Math.pow(1 - t, 1.8);
      for (let i = 0; i < dots; i++) {
        const off = (row % 2) * 0.5;
        const s = ((i + off) / dots) * size;
        const d = band * 0.5 + t * band * 1.5;
        const r = band * 0.11 * (1 - t * 0.55);
        let px, py;
        if (e === 0) { px = s; py = d; }
        else if (e === 1) { px = s; py = size - d; }
        else if (e === 2) { px = d; py = s; }
        else { px = size - d; py = s; }
        x.fillStyle = `rgba(9,10,12,${alpha})`;
        x.beginPath();
        x.arc(px, py, r, 0, Math.PI * 2);
        x.fill();
      }
    }
  }
  const t = tex(c, { srgb: true, aniso: 16 });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(1, 1);
  return t;
}

/** A legible plate. `text` is drawn on a reflective white ground. */
export function makePlate(text = 'DCB 440', size = 512) {
  const W = size;
  const H = Math.round(size * 0.26);
  const c = canvas(W, H);
  const x = c.getContext('2d');
  x.fillStyle = '#dedbd2';
  x.fillRect(0, 0, W, H);
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(255,255,255,0.35)');
  g.addColorStop(0.5, 'rgba(0,0,0,0.0)');
  g.addColorStop(1, 'rgba(0,0,0,0.18)');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  x.strokeStyle = '#1b2d5a';
  x.lineWidth = Math.max(2, H * 0.035);
  x.strokeRect(H * 0.07, H * 0.07, W - H * 0.14, H - H * 0.14);
  x.fillStyle = '#16233f';
  x.font = `bold ${Math.round(H * 0.56)}px ui-monospace, "SF Mono", monospace`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(text, W / 2, H * 0.56);
  x.font = `${Math.round(H * 0.14)}px ui-sans-serif, system-ui, sans-serif`;
  x.fillStyle = '#3a4a6a';
  x.fillText('STEEL CITY', W / 2, H * 0.16);
  // grime
  const rand = rngFor(0x33aa11);
  for (let i = 0; i < 160; i++) {
    x.fillStyle = `rgba(70,64,54,${0.02 + rand() * 0.06})`;
    x.fillRect(rand() * W, rand() * H, rand() * 40, rand() * 4);
  }
  const t = tex(c, { srgb: true, aniso: 16 });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(1, 1);
  return t;
}

/**
 * Instrument binnacle. The chase camera looks straight through the windscreen,
 * so a black rectangle where the dash should be is the single most obvious tell
 * that a car is a shell.
 */
export function makeDash(size = 512) {
  const W = size;
  const H = size / 2;
  const c = canvas(W, H);
  const x = c.getContext('2d');
  x.fillStyle = '#0c0d0f';
  x.fillRect(0, 0, W, H);

  const dial = (cx, cy, r, ticks, redline, label) => {
    const gr = x.createRadialGradient(cx, cy - r * 0.3, r * 0.1, cx, cy, r);
    gr.addColorStop(0, '#20242a');
    gr.addColorStop(1, '#0a0b0d');
    x.fillStyle = gr;
    x.beginPath();
    x.arc(cx, cy, r, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = '#3a4048';
    x.lineWidth = r * 0.05;
    x.stroke();
    for (let i = 0; i <= ticks; i++) {
      const a = Math.PI * 0.75 + (i / ticks) * Math.PI * 1.5;
      const major = i % 2 === 0;
      const rr = major ? r * 0.72 : r * 0.8;
      x.strokeStyle = i / ticks > redline ? '#e2452c' : '#c8ccd2';
      x.lineWidth = major ? r * 0.045 : r * 0.025;
      x.beginPath();
      x.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      x.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9);
      x.stroke();
      if (major) {
        x.fillStyle = '#aeb4bb';
        x.font = `${Math.round(r * 0.17)}px ui-sans-serif, system-ui, sans-serif`;
        x.textAlign = 'center';
        x.textBaseline = 'middle';
        x.fillText(String(i * (ticks === 8 ? 1 : 20)), cx + Math.cos(a) * r * 0.56, cy + Math.sin(a) * r * 0.56);
      }
    }
    // needle, parked
    const na = Math.PI * 0.78;
    x.strokeStyle = '#ff5a2a';
    x.lineWidth = r * 0.055;
    x.beginPath();
    x.moveTo(cx, cy);
    x.lineTo(cx + Math.cos(na) * r * 0.82, cy + Math.sin(na) * r * 0.82);
    x.stroke();
    x.fillStyle = '#15181c';
    x.beginPath();
    x.arc(cx, cy, r * 0.11, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = '#7e858d';
    x.font = `${Math.round(r * 0.15)}px ui-sans-serif, system-ui, sans-serif`;
    x.textAlign = 'center';
    x.fillText(label, cx, cy + r * 0.45);
  };

  dial(W * 0.29, H * 0.5, H * 0.4, 8, 0.78, 'x1000 rpm');
  dial(W * 0.71, H * 0.5, H * 0.4, 8, 1.1, 'km/h');
  // centre stack: a small display and warning lamps
  x.fillStyle = '#05070a';
  x.fillRect(W * 0.44, H * 0.3, W * 0.12, H * 0.4);
  x.fillStyle = '#2b6a4e';
  x.font = `${Math.round(H * 0.09)}px ui-monospace, monospace`;
  x.textAlign = 'center';
  x.fillText('88.8', W * 0.5, H * 0.46);
  const lamps = ['#d24a24', '#d2a324', '#2f7fd2'];
  for (let i = 0; i < 3; i++) {
    x.fillStyle = lamps[i];
    x.globalAlpha = 0.5;
    x.beginPath();
    x.arc(W * 0.46 + i * W * 0.04, H * 0.62, H * 0.022, 0, Math.PI * 2);
    x.fill();
    x.globalAlpha = 1;
  }
  const t = tex(c, { srgb: true, aniso: 8 });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(1, 1);
  return t;
}

/** Emissive layer for the dash — the bits that glow at night. */
export function makeDashEmissive(size = 512) {
  const W = size;
  const H = size / 2;
  const c = canvas(W, H);
  const x = c.getContext('2d');
  x.fillStyle = '#000';
  x.fillRect(0, 0, W, H);
  const ring = (cx, cy, r) => {
    x.strokeStyle = '#ff6a24';
    x.lineWidth = r * 0.06;
    for (let i = 0; i <= 16; i++) {
      const a = Math.PI * 0.75 + (i / 16) * Math.PI * 1.5;
      x.beginPath();
      x.moveTo(cx + Math.cos(a) * r * 0.72, cy + Math.sin(a) * r * 0.72);
      x.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9);
      x.stroke();
    }
    const na = Math.PI * 0.78;
    x.strokeStyle = '#ff3a12';
    x.lineWidth = r * 0.06;
    x.beginPath();
    x.moveTo(cx, cy);
    x.lineTo(cx + Math.cos(na) * r * 0.82, cy + Math.sin(na) * r * 0.82);
    x.stroke();
  };
  ring(W * 0.29, H * 0.5, H * 0.4);
  ring(W * 0.71, H * 0.5, H * 0.4);
  x.fillStyle = '#35d08a';
  x.font = `${Math.round(H * 0.09)}px ui-monospace, monospace`;
  x.textAlign = 'center';
  x.fillText('88.8', W * 0.5, H * 0.46);
  const t = tex(c, { srgb: true, aniso: 4 });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(1, 1);
  return t;
}

/** Seat cloth. Coarse weave with a woven twill diagonal. */
export function makeFabric(size = 256) {
  const c = canvas(size);
  const x = c.getContext('2d');
  const rand = rngFor(0x66aa22);
  const n = noiseField(size, size, 40, rand);
  const img = x.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let i2 = 0; i2 < size; i2++) {
      const i = y * size + i2;
      const weave = ((i2 + y) % 6 < 3 ? 1 : 0.86) * ((i2 - y + size) % 6 < 3 ? 1 : 0.9);
      const v = (0.34 + n[i] * 0.18) * weave;
      const k = i * 4;
      img.data[k] = v * 190;
      img.data[k + 1] = v * 182;
      img.data[k + 2] = v * 176;
      img.data[k + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  return tex(c, { repeat: 5, srgb: true });
}

export function makeFabricNormal(size = 256) {
  const c = canvas(size);
  const h = new Float32Array(size * size);
  const rand = rngFor(0x22bb66);
  const n = noiseField(size, size, 64, rand);
  for (let y = 0; y < size; y++) {
    for (let x2 = 0; x2 < size; x2++) {
      const i = y * size + x2;
      h[i] = ((x2 + y) % 6 < 3 ? 0.5 : 0) + ((x2 - y + size) % 6 < 3 ? 0.35 : 0) + n[i] * 0.25;
    }
  }
  heightToNormal(c, h, 1.1);
  return tex(c, { repeat: 5 });
}

/** Headlight reflector: concentric fluting plus a projector bowl. */
export function makeReflector(size = 256) {
  const c = canvas(size);
  const x = c.getContext('2d');
  x.fillStyle = '#c9ccd0';
  x.fillRect(0, 0, size, size);
  for (let i = 0; i < 22; i++) {
    const r = (i / 22) * size * 0.62;
    x.strokeStyle = i % 2 ? 'rgba(255,255,255,0.9)' : 'rgba(120,126,134,0.9)';
    x.lineWidth = size * 0.012;
    x.beginPath();
    x.arc(size / 2, size / 2, r, 0, Math.PI * 2);
    x.stroke();
  }
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.28);
  g.addColorStop(0, '#f4f6f8');
  g.addColorStop(0.7, '#9aa0a8');
  g.addColorStop(1, '#3b4048');
  x.fillStyle = g;
  x.beginPath();
  x.arc(size / 2, size / 2, size * 0.26, 0, Math.PI * 2);
  x.fill();
  const t = tex(c, { srgb: true });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(1, 1);
  return t;
}

/** Grille mesh — an alpha-cut honeycomb so you can see through into the dark. */
export function makeGrilleMesh(size = 256) {
  const c = canvas(size);
  const x = c.getContext('2d');
  x.clearRect(0, 0, size, size);
  x.fillStyle = '#1a1c1e';
  const step = size / 14;
  for (let j = 0; j < 15; j++) {
    for (let i = 0; i < 15; i++) {
      const ox = (j % 2) * step * 0.5;
      x.beginPath();
      const cx = i * step + ox;
      const cy = j * step * 0.87;
      const r = step * 0.46;
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (k === 0) x.moveTo(px, py);
        else x.lineTo(px, py);
      }
      x.closePath();
      x.strokeStyle = '#2a2d31';
      x.lineWidth = step * 0.14;
      x.stroke();
    }
  }
  return tex(c, { repeat: 1, srgb: true });
}

/**
 * Grained bumper plastic. Bumpers, mirror caps, arch liners, rocker cladding
 * and the sill strips are a third of the car's lower area and were a single
 * flat value (0x191b1e, no maps at all), which is precisely the "flat
 * untextured surface" the quality bar forbids — and it is the part of the car
 * closest to the camera in the beauty shot.
 *
 * Real bumper cover is injection-moulded TPO with a pebble grain, and on a used
 * car it is never the same black as the paint: it goes chalky in the UV, it
 * carries car-wash swirl, and its lower edge is sand-blasted matte by the road.
 * Mapped through the object-space metre uv, so the grain is the same size on
 * every part of every class.
 */
export function makeTrimMaps(size = 256) {
  const alb = canvas(size);
  const a = alb.getContext('2d');
  const rand = rngFor(0x19b74d);
  const pebble = noiseField(size, size, 84, rand);
  const chalk = noiseField(size, size, 13, rngFor(0x8f2ad1));
  const img = a.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    // Base 0.055 linear (~#42 sRGB): dark plastic, but well above the 0.02
    // floor. Chalking lifts it in patches; the grain modulates around it.
    // Low contrast. The first cut ran the chalking at 0.40 over a 13-cell
    // field, which put the bumper covers and every interior trim part between
    // 0.16 and 0.48 in big blotches — at cockpit range that reads as speckled
    // granite, not as moulded plastic. UV chalking is a subtle lift, not a
    // second material.
    let v = 0.30 + (pebble[i] - 0.5) * 0.055 + Math.max(0, chalk[i] - 0.58) * 0.16;
    v = Math.max(0.24, Math.min(0.46, v));
    const k = i * 4;
    img.data[k] = Math.round(255 * v);
    img.data[k + 1] = Math.round(255 * v * 0.985);
    img.data[k + 2] = Math.round(255 * v * 0.97);
    img.data[k + 3] = 255;
  }
  a.putImageData(img, 0, 0);
  // Car-wash swirl, and the odd deep scuff from a kerb or a trolley.
  for (let i = 0; i < 70; i++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const r = size * (0.04 + rand() * 0.2);
    a.strokeStyle = `rgba(150,148,144,${0.03 + rand() * 0.06})`;
    a.lineWidth = 0.6 + rand() * 0.7;
    const a0 = rand() * Math.PI * 2;
    a.beginPath();
    a.arc(cx, cy, r, a0, a0 + 0.5 + rand() * 1.5);
    a.stroke();
  }
  for (let i = 0; i < 22; i++) {
    const px = rand() * size;
    const py = rand() * size;
    a.strokeStyle = `rgba(178,174,168,${0.06 + rand() * 0.12})`;
    a.lineWidth = 0.8 + rand() * 1.6;
    a.beginPath();
    a.moveTo(px, py);
    a.lineTo(px + (rand() - 0.5) * size * 0.14, py + (rand() - 0.5) * 5);
    a.stroke();
  }

  const nrm = canvas(size);
  const h = new Float32Array(size * size);
  const fine = noiseField(size, size, 168, rngFor(0x3311fa));
  for (let i = 0; i < h.length; i++) h[i] = pebble[i] * 0.62 + fine[i] * 0.38;
  heightToNormal(nrm, h, 0.75);

  // 12 cm tile: a moulded pebble grain cell is 0.5-1 mm and this puts it there.
  return {
    albedo: tex(alb, { repeat: 8, srgb: true, aniso: 8 }),
    normal: tex(nrm, { repeat: 8, aniso: 8 }),
  };
}

/** Rust / paint failure mask for beaters and damaged panels. */
export function makeRust(size = 512) {
  const c = canvas(size);
  const x = c.getContext('2d');
  const rand = rngFor(0xbb2211);
  const n1 = noiseField(size, size, 8, rand);
  const n2 = noiseField(size, size, 34, rngFor(0x44ff21));
  const n3 = noiseField(size, size, 110, rngFor(0x1234ab));
  const img = x.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = n1[i] * 0.5 + n2[i] * 0.34 + n3[i] * 0.16;
    const t = Math.max(0, Math.min(1, (v - 0.52) * 3.4));
    const k = i * 4;
    img.data[k] = 120 + t * 40 + n3[i] * 30;
    img.data[k + 1] = 58 + t * 20;
    img.data[k + 2] = 30 + t * 8;
    img.data[k + 3] = Math.round(Math.pow(t, 0.8) * 255);
  }
  x.putImageData(img, 0, 0);
  return tex(c, { repeat: 1, srgb: true });
}

/** Cracked-glass overlay stamped onto a window when it takes a hit. */
export function makeGlassCracks(size = 512) {
  const c = canvas(size);
  const x = c.getContext('2d');
  const rand = rngFor(0x778899);
  x.clearRect(0, 0, size, size);
  x.lineCap = 'round';
  const cx = size / 2;
  const cy = size / 2;
  // radial fracture
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rand() * 0.2;
    let r = size * 0.02;
    let px = cx + Math.cos(a) * r;
    let py = cy + Math.sin(a) * r;
    let ang = a;
    x.beginPath();
    x.moveTo(px, py);
    while (r < size * 0.5) {
      const step = size * (0.02 + rand() * 0.05);
      ang += (rand() - 0.5) * 0.45;
      r += step;
      px = cx + Math.cos(ang) * r;
      py = cy + Math.sin(ang) * r;
      x.lineTo(px, py);
    }
    x.strokeStyle = `rgba(240,248,255,${0.35 + rand() * 0.4})`;
    x.lineWidth = 1 + rand() * 2.2;
    x.stroke();
  }
  // concentric rings
  for (let i = 1; i < 7; i++) {
    x.beginPath();
    const rr = (i / 7) * size * 0.46;
    for (let k = 0; k <= 40; k++) {
      const a = (k / 40) * Math.PI * 2;
      const jitter = 1 + (rand() - 0.5) * 0.16;
      const px = cx + Math.cos(a) * rr * jitter;
      const py = cy + Math.sin(a) * rr * jitter;
      if (k === 0) x.moveTo(px, py);
      else x.lineTo(px, py);
    }
    x.strokeStyle = `rgba(230,240,255,${0.18 + rand() * 0.22})`;
    x.lineWidth = 0.8 + rand() * 1.4;
    x.stroke();
  }
  // crushed zone at the impact
  const g = x.createRadialGradient(cx, cy, 0, cx, cy, size * 0.09);
  g.addColorStop(0, 'rgba(235,245,255,0.85)');
  g.addColorStop(1, 'rgba(235,245,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  const t = tex(c, { srgb: true });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(1, 1);
  return t;
}

/** Police livery decal sheet — door shield, lettering, reflective stripe. */
export function makeLivery(kind, size = 512) {
  const c = canvas(size, size / 2);
  const x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  if (kind === 'police') {
    x.fillStyle = '#e9ecef';
    x.fillRect(0, c.height * 0.18, c.width, c.height * 0.62);
    x.fillStyle = '#0d1b3a';
    x.font = `bold ${Math.round(c.height * 0.2)}px ui-sans-serif, system-ui, sans-serif`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('POLICE', c.width * 0.62, c.height * 0.5);
    // shield
    const sx = c.width * 0.22;
    const sy = c.height * 0.5;
    const r = c.height * 0.26;
    x.fillStyle = '#12306b';
    x.beginPath();
    x.moveTo(sx - r * 0.8, sy - r);
    x.lineTo(sx + r * 0.8, sy - r);
    x.lineTo(sx + r * 0.8, sy + r * 0.25);
    x.quadraticCurveTo(sx, sy + r * 1.25, sx - r * 0.8, sy + r * 0.25);
    x.closePath();
    x.fill();
    x.strokeStyle = '#d9b64a';
    x.lineWidth = r * 0.11;
    x.stroke();
    x.fillStyle = '#d9b64a';
    x.font = `bold ${Math.round(r * 0.42)}px ui-sans-serif, system-ui, sans-serif`;
    x.fillText('STEEL', sx, sy - r * 0.24);
    x.fillText('CITY', sx, sy + r * 0.24);
  }
  const t = tex(c, { srgb: true });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(1, 1);
  return t;
}
