#!/usr/bin/env node
/**
 * CROWD GATE — the mechanical answer to "is that a person or a black blob?".
 *
 * Renders nothing, exactly like `src/player/character/headprobe.mjs`. It takes
 * the geometry `buildOutfit()` actually emits and the palette `makeOutfit()`
 * actually draws, reproduces the fragment shader's albedo resolve on the CPU,
 * and gates five properties that have each been shipped broken:
 *
 *   1 ALBEDO     a whole pedestrian's AREA-WEIGHTED diffuse reflectance. This
 *                is the number behind the "featureless black silhouette on
 *                clearly-lit pavement" defect: the lighting path is
 *                fine (lightprobe.mjs measures the ped tracking the indirect
 *                budget at ~100%), the PERSON was 2-3 stops darker than the
 *                pavement because the wardrobe's linear albedos ran down to
 *                0.014 — under the 0.02 floor ARCHITECTURE.md sets, and that
 *                is before the 0.76 map modulation and the baked vertex AO.
 *   2 GARMENT    the DARKEST large garment, not just the body average. A coat
 *                at 0.02 over trousers at 0.25 averages out fine and still
 *                reads as a floating pair of legs.
 *   3 CONTRAST   value separation between the top and the bottom half of the
 *                outfit. A person whose coat and trousers sit at the same
 *                albedo is a onesie, whatever the hue.
 *   4 VARIETY    silhouette spread across a spawned crowd: standing height,
 *                shoulder width, hip width, torso bulk and hem line, each as a
 *                coefficient of variation over N drawn pedestrians. This is
 *                "do they read as different people, or one mesh in different
 *                colours" turned into a number.
 *   5 HUE        colour spread, so the answer to 4 cannot be "make them all
 *                different shades of the same brown".
 *
 * Why not a screenshot: a screenshot only proves the peds that happened to
 * spawn in front of that camera at that hour. This walks every archetype and
 * every silhouette the wardrobe can produce.
 *
 *   node src/peds/crowdprobe.mjs
 *   node src/peds/crowdprobe.mjs --n=400 --verbose
 */
import { Rng } from '../core/rng.js';
import { makeOutfit, ARCHETYPES, SHAPES, SHAPE_IDS } from './wardrobe.js';
import { buildOutfit } from './builder.js';
import { PedMaterials, GRIME, PALE, MATERIAL_SLOTS } from './materials.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const N = Number(args.n ?? 240);

/* ------------------------------------------------------------------ */
/* Targets                                                             */
/* ------------------------------------------------------------------ */
/**
 * A clothed human's area-weighted diffuse reflectance. Skin is 0.18-0.45,
 * denim 0.10-0.18, black wool 0.045-0.06 (a true 0.02 surface is charcoal
 * powder, not a coat), so a whole rustbelt pedestrian lands around 0.10-0.22
 * and the darkest person on a winter street lands near 0.055. These are the
 * numbers a light meter reads, not a preference.
 */
const T = {
  albedoP50: [0.085, 0.26],   // median pedestrian, luminance albedo
  albedoMin: 0.048,           // the darkest pedestrian in the crowd
  garmentMin: 0.038,          // the darkest large garment on anybody
  contrastMin: 0.12,          // median |log2(top/bottom)| in stops
  cvMin: 0.045,               // silhouette CV, per metric
  hueSpreadMin: 0.055,        // median pairwise chroma distance between tops
};

/** Palette slots that are cloth or leather on a person: see makeOutfit(). */
const GARMENT_SLOTS = new Set([2, 3, 4, 5, 6, 7, 11]);

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/* ------------------------------------------------------------------ */
/* The baked albedo maps are a MODULATION, so measure their real mean  */
/* ------------------------------------------------------------------ */
const pm = new PedMaterials(new Rng(0x51ee7), { size: 128, anisotropy: 1 });
const MAP_MEAN = {};
const RAW_MEAN = {};
for (const k of MATERIAL_SLOTS) {
  const d = pm.sets[k].albedo.image.data;
  const gain = pm.sets[k].albedoGain;
  const n = d.length / 4;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < n; i++) {
    r += s2l(d[i * 4] / 255);
    g += s2l(d[i * 4 + 1] / 255);
    b += s2l(d[i * 4 + 2] / 255);
  }
  RAW_MEAN[k] = [r / n, g / n, b / n];
  // exactly what the fragment shader applies: map texel * owPedGain
  MAP_MEAN[k] = [(r / n) * gain[0], (g / n) * gain[1], (b / n) * gain[2]];
}
pm.dispose();

/* ------------------------------------------------------------------ */
/* One pedestrian, resolved exactly as the fragment shader resolves it */
/* ------------------------------------------------------------------ */

/**
 * diffuseColor = mapTexel * vertexColor * mix(mix(palette[slot], GRIME, tint.y), PALE, tint.z)
 * — see PedMaterials._attach. Area-weighted over the real triangles.
 */
function measure(outfit, geometry) {
  const pos = geometry.attributes.position.array;
  const col = geometry.attributes.color.array;
  const tint = geometry.attributes.owTint.array;
  const idx = geometry.index.array;
  const pal = outfit.palette;

  const at = (v, slotName) => {
    const s = Math.max(0, Math.min(pal.length - 1, Math.round(tint[v * 3])));
    let p = pal[s];
    p = mix3(p, GRIME, Math.max(0, Math.min(1, tint[v * 3 + 1])));
    p = mix3(p, PALE, Math.max(0, Math.min(1, tint[v * 3 + 2])));
    const m = MAP_MEAN[slotName];
    return [
      m[0] * col[v * 3] * p[0],
      m[1] * col[v * 3 + 1] * p[1],
      m[2] * col[v * 3 + 2] * p[2],
    ];
  };

  let area = 0;
  const sum = [0, 0, 0];
  let topArea = 0, topSum = 0, botArea = 0, botSum = 0;
  // per palette slot, so the darkest LARGE garment can be found
  const slotArea = new Float64Array(pal.length);
  const slotSum = new Float64Array(pal.length);
  let minY = Infinity, maxY = -Infinity;

  for (const g of geometry.groups) {
    const slotName = MATERIAL_SLOTS[g.materialIndex] ?? 'cloth';
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
      const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
      const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const A = 0.5 * Math.hypot(nx, ny, nz);
      if (!(A > 0)) continue;
      const ca = at(a, slotName), cb = at(b, slotName), cc = at(c, slotName);
      const e = [(ca[0] + cb[0] + cc[0]) / 3, (ca[1] + cb[1] + cc[1]) / 3, (ca[2] + cb[2] + cc[2]) / 3];
      area += A;
      sum[0] += e[0] * A; sum[1] += e[1] * A; sum[2] += e[2] * A;
      const my = (ay + by + cy) / 3;
      minY = Math.min(minY, ay, by, cy);
      maxY = Math.max(maxY, ay, by, cy);
      if (my > 1.00) { topArea += A; topSum += lum(e) * A; }
      else if (my > 0.20 && my < 0.90) { botArea += A; botSum += lum(e) * A; }
      const s = Math.max(0, Math.min(pal.length - 1, Math.round(tint[a * 3])));
      slotArea[s] += A;
      slotSum[s] += lum(e) * A;
    }
  }

  const mean = [sum[0] / area, sum[1] / area, sum[2] / area];
  // The darkest GARMENT covering at least 6% of the body. Clothing slots only:
  // hair (1) and the eye/rubber-sole slot (9) are legitimately down at 0.03 —
  // that is what those materials measure — and folding them in would either
  // make the gate unpassable or force hair the colour of straw.
  let garmentMin = Infinity, garmentSlot = -1;
  for (let s = 0; s < slotArea.length; s++) {
    if (!GARMENT_SLOTS.has(s)) continue;
    if (slotArea[s] < area * 0.06) continue;
    const v = slotSum[s] / slotArea[s];
    if (v < garmentMin) { garmentMin = v; garmentSlot = s; }
  }
  const top = topArea > 0 ? topSum / topArea : 0;
  const bot = botArea > 0 ? botSum / botArea : 0;
  return {
    albedo: lum(mean),
    rgb: mean,
    garmentMin: Number.isFinite(garmentMin) ? garmentMin : lum(mean),
    garmentSlot,
    contrast: Math.abs(Math.log2(Math.max(top, 1e-6) / Math.max(bot, 1e-6))),
    height: maxY - minY,
  };
}

/** Silhouette metrics from the emitted geometry: what survives at 30 m. */
function silhouette(geometry, scale) {
  const pos = geometry.attributes.position.array;
  const n = geometry.attributes.position.count;
  let minY = Infinity, maxY = -Infinity;
  let shoulderW = 0, hipW = 0, chestD = 0, hemY = Infinity;
  let bulkArea = 0;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (y > 1.30 && y < 1.42) shoulderW = Math.max(shoulderW, Math.abs(x) * 2);
    if (y > 0.92 && y < 1.02) hipW = Math.max(hipW, Math.abs(x) * 2);
    if (y > 1.05 && y < 1.25) chestD = Math.max(chestD, Math.abs(z) * 2);
    // the hem: the lowest ring of the outer garment, which is what reads as
    // "long coat" vs "jacket" at distance
    if (Math.abs(x) > 0.10 && y > 0.45 && y < 1.05) hemY = Math.min(hemY, y);
    if (y > 0.95 && y < 1.40) bulkArea = Math.max(bulkArea, Math.hypot(x, z));
  }
  return {
    height: (maxY - minY) * scale,
    shoulderW: shoulderW * scale,
    hipW: hipW * scale,
    chestD: chestD * scale,
    hem: (Number.isFinite(hemY) ? hemY : 1.05) * scale,
    bulk: bulkArea * scale,
  };
}

/* ------------------------------------------------------------------ */
/* Draw a crowd                                                        */
/* ------------------------------------------------------------------ */
const rng = new Rng(0xC0FFEE);
const ARCH_IDS = Object.keys(ARCHETYPES);
const geoCache = new Map();
const people = [];
for (let i = 0; i < N; i++) {
  const arch = ARCH_IDS[i % ARCH_IDS.length];
  const outfit = makeOutfit(rng.fork(), arch, {});
  if (!geoCache.has(outfit.shape)) {
    geoCache.set(outfit.shape, buildOutfit(outfit.shape, { rng: new Rng(0xBEEF + SHAPE_IDS.indexOf(outfit.shape)) }));
  }
  const built = geoCache.get(outfit.shape);
  const m = measure(outfit, built.geometry);
  const s = silhouette(built.geometry, outfit.scale);
  people.push({ arch, outfit, ...m, sil: s });
}

const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.max(0, Math.min(s.length - 1, Math.round(p * (s.length - 1))))];
};
const cv = (a) => {
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length);
  return mean > 1e-9 ? sd / mean : 0;
};

const alb = people.map((p) => p.albedo);
const gar = people.map((p) => p.garmentMin);
const con = people.map((p) => p.contrast);
const sil = {
  height: people.map((p) => p.sil.height),
  shoulderW: people.map((p) => p.sil.shoulderW),
  hipW: people.map((p) => p.sil.hipW),
  chestD: people.map((p) => p.sil.chestD),
  hem: people.map((p) => p.sil.hem),
  bulk: people.map((p) => p.sil.bulk),
};

/** Chroma distance between two linear colours, normalised by their level. */
function chroma(c) {
  const l = Math.max(1e-6, lum(c));
  return [c[0] / l, c[1] / l, c[2] / l];
}
const tops = people.map((p) => chroma(p.outfit.palette[2]));
const hueD = [];
for (let i = 0; i < Math.min(tops.length, 120); i++) {
  for (let j = i + 1; j < Math.min(tops.length, 120); j++) {
    const a = tops[i], b = tops[j];
    hueD.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  }
}

const R = {
  albedoP05: pct(alb, 0.05),
  albedoP50: pct(alb, 0.5),
  albedoP95: pct(alb, 0.95),
  albedoMin: Math.min(...alb),
  garmentP05: pct(gar, 0.05),
  garmentMin: Math.min(...gar),
  contrastP50: pct(con, 0.5),
  contrastP05: pct(con, 0.05),
  hueSpread: pct(hueD, 0.5),
  cv: Object.fromEntries(Object.entries(sil).map(([k, v]) => [k, cv(v)])),
};

console.log(`=== crowd gate — ${N} pedestrians, ${geoCache.size}/${SHAPE_IDS.length} silhouettes, ${ARCH_IDS.length} archetypes ===`);
console.log(
  `  map modulation, raw -> after owPedGain: ` +
    MATERIAL_SLOTS.map((k) => `${k} ${lum(RAW_MEAN[k]).toFixed(3)}->${lum(MAP_MEAN[k]).toFixed(3)}`).join('  ')
);
console.log('');
console.log(`  1 ALBEDO   whole-body area-weighted reflectance`);
console.log(`               p05 ${R.albedoP05.toFixed(4)}  p50 ${R.albedoP50.toFixed(4)}  p95 ${R.albedoP95.toFixed(4)}  min ${R.albedoMin.toFixed(4)}`);
console.log(`               (want p50 in ${T.albedoP50[0]}..${T.albedoP50[1]}, min >= ${T.albedoMin})`);
console.log(`  2 GARMENT  darkest garment covering >= 6% of the body`);
console.log(`               p05 ${R.garmentP05.toFixed(4)}  min ${R.garmentMin.toFixed(4)}   (want min >= ${T.garmentMin})`);
console.log(`  3 CONTRAST top-half vs bottom-half value separation, stops`);
console.log(`               p05 ${R.contrastP05.toFixed(3)}  p50 ${R.contrastP50.toFixed(3)}   (want p50 >= ${T.contrastMin})`);
console.log(`  4 VARIETY  silhouette coefficient of variation`);
for (const [k, v] of Object.entries(R.cv)) {
  console.log(`               ${k.padEnd(10)} ${v.toFixed(4)}  (want >= ${T.cvMin})`);
}
console.log(`  5 HUE      median pairwise chroma distance between tops`);
console.log(`               ${R.hueSpread.toFixed(4)}   (want >= ${T.hueSpreadMin})`);

if (args.verbose) {
  const worst = [...people].sort((a, b) => a.albedo - b.albedo).slice(0, 10);
  console.log('\n  darkest ten:');
  for (const p of worst) {
    console.log(
      `    ${p.arch.padEnd(10)} ${String(p.outfit.shape).padEnd(10)} albedo ${p.albedo.toFixed(4)} ` +
        `garment ${p.garmentMin.toFixed(4)} (slot ${p.garmentSlot}) contrast ${p.contrast.toFixed(2)} st`
    );
  }
  const byShape = new Map();
  for (const p of people) {
    if (!byShape.has(p.outfit.shape)) byShape.set(p.outfit.shape, []);
    byShape.get(p.outfit.shape).push(p.albedo);
  }
  console.log('\n  per silhouette: count, median albedo, height, shoulder');
  for (const id of SHAPE_IDS) {
    const a = byShape.get(id);
    if (!a) { console.log(`    ${id.padEnd(11)} NEVER DRAWN`); continue; }
    const s = people.find((p) => p.outfit.shape === id).sil;
    console.log(
      `    ${id.padEnd(11)} n=${String(a.length).padStart(3)}  alb ${pct(a, 0.5).toFixed(4)}  ` +
        `h ${s.height.toFixed(2)}  sh ${s.shoulderW.toFixed(3)}  hip ${s.hipW.toFixed(3)}  hem ${s.hem.toFixed(2)}`
    );
  }
}

const bad = [];
if (R.albedoP50 < T.albedoP50[0] || R.albedoP50 > T.albedoP50[1]) bad.push(`ALBEDO p50 ${R.albedoP50.toFixed(4)}`);
if (R.albedoMin < T.albedoMin) bad.push(`ALBEDO min ${R.albedoMin.toFixed(4)}`);
if (R.garmentMin < T.garmentMin) bad.push(`GARMENT ${R.garmentMin.toFixed(4)}`);
if (R.contrastP50 < T.contrastMin) bad.push(`CONTRAST ${R.contrastP50.toFixed(3)}`);
for (const [k, v] of Object.entries(R.cv)) if (v < T.cvMin) bad.push(`VARIETY ${k} ${v.toFixed(4)}`);
if (R.hueSpread < T.hueSpreadMin) bad.push(`HUE ${R.hueSpread.toFixed(4)}`);

console.log('');
if (bad.length) {
  console.log(`FAIL: ${bad.join(', ')}`);
  process.exit(1);
}
console.log('PASS');
