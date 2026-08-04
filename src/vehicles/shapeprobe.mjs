#!/usr/bin/env node
/**
 * SHAPE PROBE — "does it look like the car" as a measurement instead of an
 * opinion.
 *
 *   node src/vehicles/shapeprobe.mjs
 *   node src/vehicles/shapeprobe.mjs --verbose
 *   node src/vehicles/shapeprobe.mjs --control=notch      (negative control)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY IT RASTERISES
 * ────────────────────────────────────────────────────────────────────────────
 * "Does it read as a K5" is a judgement and cannot be gated. What CAN be gated
 * is the handful of geometric facts that judgement is made of: whether the roof
 * falls in one line or in three, how long the backlight is against the boot,
 * how much of the flank is glass, and whether the tail lamps are in front of
 * their own housing or inside it.
 *
 * It measures the EMITTED TRIANGLES, and that distinction is not academic. The
 * first version of this read `geometry.attributes.position` and reported a
 * clean roofline on a body whose roof panel was largely cut away — `loftBody`
 * builds a full vertex grid and then chooses which quads to INDEX, so every
 * vertex of every hole is still sitting in the buffer. Reading the attribute is
 * reading the input the mesh was made from, not the mesh. Hard rule 12.
 *
 * So: rasterise the indexed triangles into a 4 mm side elevation and read the
 * silhouette off the pixels, the same way an eye does.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NEGATIVE CONTROLS
 * ────────────────────────────────────────────────────────────────────────────
 * A gate that has never failed is not evidence of anything. Each control
 * perturbs the STYLE DATA only — no debug hooks in the shipping path — and each
 * one is a defect this file has actually seen:
 *
 *   --control=notch    a 30 cm ducktail. Reproduces a top line that stops
 *                      falling and climbs again, which is what the rear-arch
 *                      stations used to do to the Kessel by 15 cm.
 *   --control=slab     build the Kessel as a three-box saloon. Everything about
 *                      the fastback proportion assertions should go red while
 *                      the continuity assertions stay green, because a saloon
 *                      roof is continuous too — it is just a different shape.
 *   --control=buriedlamp
 *                      `taillight.recess` back to the -6 mm it shipped with.
 *                      Reproduces the lens sealed inside its own unlit housing
 *                      on EVERY car in the fleet, which is what it was.
 *   --control=coupe    two shutlines instead of three: the four-door test.
 *   --control=slabroof build Carson's SUV as a low three-box saloon (roof
 *                      dropped to 1.44 m, boot restored). The boxy tall-roof and
 *                      near-vertical-rear assertions must all go red — this is
 *                      the "SUV built as a sedan" control the assignment asks for.
 *   --control=nobed    raise the pickup's bed floor to cab-roof height and drop
 *                      the bed builder: no step down behind the cab, so the
 *                      "it has a bed" assertions go red.
 *   --control=repaint  paint every brother's car the WRONG hue (Dylan's K5 red,
 *                      Aidan's Ranger white, Carson's 4Runner grey). The colour
 *                      assertions go red; nothing else moves.
 *
 * Scores with the fix in and with each control out are in the header of the
 * summary. If a control does not go red, the assertion it targets is decorative.
 */

import { VEHICLE_SPECS, finalizeSpec, PAINTS } from './specs.js';
import { buildCarBody } from './body.js';
import { BOYZ } from '../game/data.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const VERBOSE = !!args.verbose;
const CONTROL = args.control ?? null;

const PX = 0.004; // 4 mm — a shutline is 9 mm, so nothing real falls through

let pass = 0;
let fail = 0;
const fails = [];

function ok(name, cond, detail) {
  if (cond) { pass++; if (VERBOSE) console.log(`  ok   ${name}  ${detail ?? ''}`); }
  else { fail++; fails.push(`${name}  ${detail ?? ''}`); console.log(`  FAIL ${name}  ${detail ?? ''}`); }
}

function near(name, v, lo, hi, unit = '') {
  ok(name, v >= lo && v <= hi, `${v.toFixed(3)}${unit} (want ${lo}..${hi})`);
}

/* ------------------------------------------------------------------ */
/* Rasteriser                                                          */
/* ------------------------------------------------------------------ */

/** Emitted triangles -> a (z, y) coverage bitmap. Indexed geometry only. */
function elevation(geos, b) {
  const W = Math.max(1, Math.ceil((b.z1 - b.z0) / PX));
  const H = Math.max(1, Math.ceil((b.y1 - b.y0) / PX));
  const grid = new Uint8Array(W * H);
  for (const g of geos) {
    if (!g) continue;
    const p = g.getAttribute('position');
    const index = g.index;
    const n = index ? index.count : p.count;
    for (let t = 0; t + 2 < n; t += 3) {
      const ia = index ? index.getX(t) : t;
      const ib = index ? index.getX(t + 1) : t + 1;
      const ic = index ? index.getX(t + 2) : t + 2;
      const ax = (p.getZ(ia) - b.z0) / PX, ay = (p.getY(ia) - b.y0) / PX;
      const bx = (p.getZ(ib) - b.z0) / PX, by = (p.getY(ib) - b.y0) / PX;
      const cx = (p.getZ(ic) - b.z0) / PX, cy = (p.getY(ic) - b.y0) / PX;
      const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(d) < 1e-12) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / d;
          const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / d;
          if (w0 >= -1e-6 && w1 >= -1e-6 && 1 - w0 - w1 >= -1e-6) grid[y * W + x] = 1;
        }
      }
    }
  }
  return {
    grid, W, H,
    zOf: (i) => b.z0 + (i + 0.5) * PX,
    yOf: (j) => b.y0 + (j + 0.5) * PX,
    iOf: (z) => Math.round((z - b.z0) / PX - 0.5),
    area: () => { let a = 0; for (let i = 0; i < grid.length; i++) a += grid[i]; return a * PX * PX; },
  };
}

/** Highest covered y at each z column, or NaN where nothing is emitted. */
function topLineOf(E) {
  const top = new Float64Array(E.W).fill(NaN);
  for (let x = 0; x < E.W; x++) {
    for (let y = E.H - 1; y >= 0; y--) if (E.grid[y * E.W + x]) { top[x] = E.yOf(y); break; }
  }
  return top;
}

/**
 * The largest UPWARD excursion of the top line across a z window, walking nose
 * to tail — i.e. how far the roof climbs again after it has started to fall.
 * This is the number that was 0.152 m on the Kessel and is the whole reason the
 * car read as "a greenhouse sitting on a slab body".
 *
 * Measured from each running minimum rather than between neighbours, so a slow
 * 15 cm climb over half a metre counts exactly as much as an abrupt one. A
 * per-sample derivative would score that as 30 clean 5 mm steps.
 */
function maxRise(E, top, zFrom, zTo) {
  let lo = Infinity;
  let rise = 0;
  let at = 0;
  const a = Math.max(0, E.iOf(zTo));
  const b = Math.min(E.W - 1, E.iOf(zFrom));
  for (let x = b; x >= a; x--) {
    const y = top[x];
    if (Number.isNaN(y)) continue;
    if (y < lo) lo = y;
    else if (y - lo > rise) { rise = y - lo; at = E.zOf(x); }
  }
  return { rise, at };
}

/* ------------------------------------------------------------------ */
/* Per-class measurement                                               */
/* ------------------------------------------------------------------ */

/**
 * Negative controls, keyed by the class each one perturbs. Every one edits STYLE
 * DATA only — no debug hook in the shipping path — and each reproduces a defect
 * this fleet has actually shown or the assignment names explicitly. `repaint` is
 * handled in the colour section (it is a paint fault, not a geometry one).
 */
const CONTROLS = {
  notch: { id: 'kessel', apply: (s) => { s.ducktail = 0.30; } },
  slab: { id: 'kessel', apply: (s) => { s.shape = 'sedan'; } },
  buriedlamp: { id: 'kessel', apply: (s) => { s.taillight = { ...s.taillight, recess: -0.006 }; } },
  coupe: { id: 'kessel', apply: (s) => { s.doorSplit = [0.64, -1.065]; } },
  slabroof: {
    id: 'suv',
    apply: (s) => {
      s.shape = 'sedan';
      s.roofY = 1.44;
      s.roofRearZ = -1.05;
      s.backlightBaseZ = -1.52;
      s.tailY = 0.94;
      s.roofRails = false;
    },
  },
  nobed: { id: 'pickup', apply: (s) => { s.tailY = s.roofY - 0.02; s.bed = null; } },
  repaint: { id: null, apply: () => {} },
};

if (CONTROL && !CONTROLS[CONTROL]) throw new Error(`unknown control ${CONTROL}`);

function styleOf(id) {
  const src = VEHICLE_SPECS[id];
  const spec = { ...src, style: { ...src.style } };
  const c = CONTROL ? CONTROLS[CONTROL] : null;
  if (c && c.id === id) c.apply(spec.style, spec);
  return finalizeSpec(spec);
}

function measure(id) {
  const spec = styleOf(id);
  const st = spec.style;
  const out = buildCarBody(spec, 0);
  const doorGeo = out.doors.map((d) => d.geo);
  const b = { z0: st.tailZ - 0.4, z1: st.noseZ + 0.4, y0: 0, y1: st.roofY + 0.35 };

  const solid = elevation([...out.paint, ...out.trim, ...out.chrome, ...doorGeo], b);
  const glass = elevation(out.glass, b);
  const all = elevation([...out.paint, ...out.trim, ...out.chrome, ...out.glass, ...doorGeo], b);
  const top = topLineOf(all);

  // ---- feature z positions, read off the line rather than off the style ----
  // The crest is the LAST column (walking aft) within 8 mm of the roof peak.
  let peak = -Infinity;
  for (let x = 0; x < all.W; x++) if (!Number.isNaN(top[x]) && top[x] > peak) peak = top[x];
  let crestF = null;
  let crestR = null;
  for (let x = all.W - 1; x >= 0; x--) {
    if (Number.isNaN(top[x])) continue;
    if (top[x] >= peak - 0.008) { if (crestF === null) crestF = all.zOf(x); crestR = all.zOf(x); }
  }

  /**
   * Where the backlight stops and the boot lid starts — taken from THE REAR
   * EDGE OF THE EMITTED GLASS, not from `backlightBaseZ`.
   *
   * Two wrong ways to get this number. Reading the style block back out is
   * rule 12 (the assertion would restate its own input and could never fail).
   * Thresholding the top line — "the first column within 3 cm of deck height" —
   * is worse than it looks: the whole POINT of the fastback sweep is that it
   * eases into the boot with no break, so a threshold slides a long way for a
   * small tolerance change and reported the deck as 0.82 m at 30 mm and 0.74 m
   * at 10 mm. The glass edge is a real feature with a real position, and if the
   * backlight ever fails to build, this moves.
   */
  let deckStart = st.backlightBaseZ;
  for (let x = 0; x < glass.W; x++) {
    let any = false;
    for (let y = 0; y < glass.H; y++) if (glass.grid[y * glass.W + x]) { any = true; break; }
    if (any) { deckStart = glass.zOf(x); break; }
  }
  const deckH0 = (() => {
    const i = all.iOf(st.tailZ + 0.30);
    return top[Math.max(0, Math.min(all.W - 1, i))];
  })();

  const tris = [...out.paint, ...out.trim, ...out.chrome, ...out.glass, ...out.cavity, ...doorGeo]
    .reduce((n, g) => n + (g.index ? g.index.count : g.getAttribute('position').count) / 3, 0);

  return {
    spec, st, out, all, glass, solid, top, peak, crestF, crestR, tris,
    bonnet: st.noseZ - st.cowlZ,
    screen: st.cowlZ - st.windscreenTopZ,
    crest: (crestF ?? 0) - (crestR ?? 0),
    deckStart,
    sweep: (crestR ?? st.roofRearZ) - deckStart,
    deck: deckStart - st.tailZ,
    roofH: peak,
    deckH: deckH0,
    sideArea: solid.area() + glass.area(),
    glassArea: glass.area(),
  };
}

/**
 * Are the lit lenses in front of their own housing?
 *
 * Signed, in metres, and it has to be signed: the tail is capped at `tailZ` and
 * everything on it is placed with a NEGATIVE z offset, so "outboard" is -z and a
 * lamp that is 5 mm short of the housing face looks identical in a bounding-box
 * summary to one that is 5 mm proud. Positive here means the lens is outside
 * the dark channel and can be seen; negative means it is sealed inside it, and
 * the car photographs with a black rectangle where its tail lights are.
 */
function lampProud(out, tailZ) {
  const outerZ = (geos) => {
    let m = Infinity;
    for (const g of geos ?? []) {
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) if (p.getZ(i) < m) m = p.getZ(i);
    }
    return m;
  };
  // Only the housings behind the tail cap, never the exhaust holes or the
  // arch liners, which are `cavity` too and live elsewhere on the body.
  const rearCavity = (out.cavity ?? []).filter((g) => {
    const p = g.getAttribute('position');
    let mz = Infinity;
    for (let i = 0; i < p.count; i++) if (p.getZ(i) < mz) mz = p.getZ(i);
    return mz < tailZ + 0.02 && mz > tailZ - 0.25;
  });
  const lens = outerZ([...(out.lamps.brake ?? []), ...(out.lamps.tail ?? [])]);
  const housing = outerZ(rearCavity);
  if (!Number.isFinite(lens) || !Number.isFinite(housing)) return null;
  return housing - lens; // > 0 => the lens is further outboard than the housing
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

const K = measure('kessel');
const S = measure('sedan');
const P = measure('sports');
const PU = measure('pickup');
const SUV = measure('suv');

/* ------------------------------------------------------------------ */
/* Archetype metrics — read off the EMITTED side elevation             */
/* ------------------------------------------------------------------ */

/** Highest emitted top-line y with its z between zLo and zHi, or -Inf. */
function maxTopIn(m, zLo, zHi) {
  let mx = -Infinity;
  for (let x = 0; x < m.all.W; x++) {
    const z = m.all.zOf(x);
    if (z < zLo || z > zHi) continue;
    const y = m.top[x];
    if (!Number.isNaN(y) && y > mx) mx = y;
  }
  return mx;
}

/** Rearmost z at which any glass is emitted (the back edge of the glasshouse). */
function rearmostGlassZ(m) {
  for (let x = 0; x < m.glass.W; x++) {
    for (let y = 0; y < m.glass.H; y++) {
      if (m.glass.grid[y * m.glass.W + x]) return m.glass.zOf(x);
    }
  }
  return NaN;
}

/**
 * How far (in z) the top line falls from the roof peak before it has dropped by
 * `drop` metres, walking away from the crest. A near-vertical windscreen or
 * tailgate returns a SMALL number; a fastback sweep or a long bonnet a large
 * one. `dir` is -1 to walk aft (rear), +1 to walk forward (front).
 */
function faceRun(m, fromZ, dir, drop = 0.20) {
  const peak = m.peak;
  const target = peak - drop;
  let run = 0;
  for (let x = 0; x < m.all.W; x++) {
    const z = m.all.zOf(x);
    if (dir < 0 && z > fromZ) continue;   // aft of the rear crest only
    if (dir > 0 && z < fromZ) continue;   // forward of the front crest only
    const y = m.top[x];
    if (Number.isNaN(y)) continue;
    if (y <= target) {
      const d = Math.abs(z - fromZ);
      if (run === 0 || d < run) run = d;
    }
  }
  return run;
}

/** The pickup: cab-roof peak, bed-wall top, and the step between them. */
function bedMetrics(m) {
  const st = m.st;
  const cabTop = maxTopIn(m, st.backlightBaseZ, st.cowlZ + 0.3); // over the cab
  const bedTop = maxTopIn(m, st.tailZ + 0.15, st.backlightBaseZ - 0.15); // over the bed
  return {
    cabTop,
    bedTop,
    step: cabTop - bedTop,
    bedLen: st.backlightBaseZ - st.tailZ,
    rearGlassZ: rearmostGlassZ(m),
  };
}

/** The SUV: how long the roof runs flat and how steep its two ends are. */
function suvMetrics(m) {
  return {
    roofH: m.peak,
    roofRun: m.crest, // length within 8 mm of the peak — the flat roof
    rearRun: faceRun(m, m.crestR ?? m.st.roofRearZ, -1, 0.20),
    frontRun: faceRun(m, m.crestF ?? m.st.windscreenTopZ, +1, 0.20),
  };
}

const PUm = bedMetrics(PU);
const SUVm = suvMetrics(SUV);

console.log(`shapeprobe${CONTROL ? `  [CONTROL: ${CONTROL}]` : ''}`);
console.log('');
console.log('                      kessel     sedan    sports');
const row = (n, f, u = '') => console.log(
  `  ${n.padEnd(20)}${f(K).toFixed(3).padStart(7)}${u.padEnd(2)}${f(S).toFixed(3).padStart(8)}${u.padEnd(2)}${f(P).toFixed(3).padStart(8)}${u}`
);
row('bonnet run', (m) => m.bonnet, 'm');
row('windscreen run', (m) => m.screen, 'm');
row('roof crest', (m) => m.crest, 'm');
row('backlight sweep', (m) => m.sweep, 'm');
row('deck', (m) => m.deck, 'm');
row('roof height', (m) => m.roofH, 'm');
row('deck height', (m) => m.deckH, 'm');
row('side elevation', (m) => m.sideArea, 'm2');
row('glass', (m) => m.glassArea, 'm2');
row('glass fraction', (m) => m.glassArea / m.sideArea);
row('sweep / deck', (m) => m.sweep / m.deck);
row('LOD0 triangles', (m) => m.tris);
console.log('');

/* ---- 1. THE LINE ------------------------------------------------- */
// From the back of the roof crest to the base of the backlight, a car's top
// line only goes one way. This is the assertion the whole file is for.
console.log('roofline continuity');
for (const [id, m] of [['kessel', K], ['sedan', S], ['sports', P]]) {
  const r = maxRise(m.all, m.top, m.crestR, m.deckStart);
  ok(`${id} roof->backlight monotone`, r.rise <= 0.015,
    `rise ${(r.rise * 1000).toFixed(0)} mm at z ${r.at.toFixed(2)} (limit 15)`);
}
// The deck is allowed to lift — that is what a ducktail is — but not by the
// height of a spoiler.
for (const [id, m] of [['kessel', K], ['sedan', S], ['sports', P]]) {
  const r = maxRise(m.all, m.top, m.deckStart, m.st.tailZ);
  ok(`${id} deck lift is a ducktail`, r.rise <= 0.09,
    `${(r.rise * 1000).toFixed(0)} mm (limit 90)`);
}

/* ---- 2. THE PROPORTIONS ------------------------------------------ */
console.log('fastback proportions');
// A fastback is a car whose backlight is longer than its boot. A three-box
// saloon is the opposite, and the sedan is measured here as the contrast.
ok('kessel is a fastback', K.sweep > K.deck * 2.2,
  `sweep/deck ${(K.sweep / K.deck).toFixed(2)} (want > 2.2; sedan ${(S.sweep / S.deck).toFixed(2)})`);
ok('kessel roof crest is short', K.crest < 0.62,
  `${K.crest.toFixed(2)} m (want < 0.62; sedan ${S.crest.toFixed(2)})`);
near('kessel bonnet run', K.bonnet, 1.55, 1.95, 'm');
near('kessel deck', K.deck, 0.30, 0.55, 'm');
ok('kessel deck is higher than the sedan\'s', K.deckH > S.deckH + 0.06,
  `${K.deckH.toFixed(3)} vs ${S.deckH.toFixed(3)}`);
ok('kessel roof is no taller than the sedan\'s', K.roofH <= S.roofH + 0.06,
  `${K.roofH.toFixed(3)} vs ${S.roofH.toFixed(3)}`);

/* ---- 3. THE GLASSHOUSE ------------------------------------------- */
console.log('glasshouse');
// Not an absolute: a fastback trades glass AREA for glass LENGTH, so the honest
// test is that it is in the same country as the two classes that already render
// as credible cars.
for (const [id, m] of [['kessel', K], ['sedan', S], ['sports', P]]) {
  const f = m.glassArea / m.sideArea;
  ok(`${id} glass fraction`, f >= 0.16 && f <= 0.32, `${(f * 100).toFixed(1)}%`);
}

/* ---- 4. THE TAIL LAMPS ------------------------------------------- */
console.log('tail lamps');
for (const id of Object.keys(VEHICLE_SPECS)) {
  const sp = VEHICLE_SPECS[id];
  if (sp.kind !== 'car' || !sp.style?.taillight) continue;
  const m = id === 'kessel' ? K : null;
  const spec = m ? m.spec : finalizeSpec({ ...sp, style: { ...sp.style } });
  const o = m ? m.out : buildCarBody(spec, 0);
  const d = lampProud(o, spec.style.tailZ);
  if (d === null) continue;
  ok(`${id} lens is proud of its housing`, d > 0.001,
    `${(d * 1000).toFixed(1)} mm`);
}

/* ---- 5. FOUR DOORS ----------------------------------------------- */
console.log('doors');
for (const id of ['kessel', 'sedan']) {
  const sp = id === 'kessel' ? K.spec : S.spec;
  const n = (sp.style.doorSplit ?? []).length;
  ok(`${id} declares ${sp.doors} doors and cuts ${n} shutlines`,
    sp.doors < 4 || n >= 3, `${n} shutlines`);
}

/* ---- 6. THE PICKUP: A CAB AND AN OPEN BED ------------------------ */
// Aidan's Ranger is a cab plus a separate bed box. The signature is the STEP:
// the top line is high over the cab and drops to the bed walls behind it, and
// the glasshouse stops at the cab so the bed is open. All read off the emitted
// side elevation — the bed walls are real paint geometry in the raster.
console.log('');
console.log('pickup');
{
  const L = PU.spec.dims.L;
  if (VERBOSE) {
    console.log(`  cabTop ${PUm.cabTop.toFixed(2)}  bedTop ${PUm.bedTop.toFixed(2)}  ` +
      `step ${PUm.step.toFixed(2)}  bedLen ${PUm.bedLen.toFixed(2)}  rearGlassZ ${PUm.rearGlassZ.toFixed(2)}`);
  }
  ok('pickup steps down from cab to bed', PUm.step > 0.30,
    `${(PUm.step * 1000).toFixed(0)} mm cab->bed (want > 300; the SUV, one box, is ${((SUV.peak - maxTopIn(SUV, SUV.st.tailZ + 0.15, SUV.st.tailZ + 0.6)) * 1000).toFixed(0)})`);
  ok('pickup bed is a long open box', PUm.bedLen / L > 0.40,
    `bed ${PUm.bedLen.toFixed(2)} m = ${((PUm.bedLen / L) * 100).toFixed(0)}% of L (want > 40%)`);
  ok('pickup glasshouse stops at the cab', PUm.rearGlassZ > PU.st.backlightBaseZ - 0.20,
    `rear glass z ${PUm.rearGlassZ.toFixed(2)} (bed opens at ${PU.st.backlightBaseZ.toFixed(2)})`);
}

/* ---- 7. THE SUV: A TALL BOXY TWO-BOX ----------------------------- */
// Carson's 4Runner is tall, its roof runs long and flat, and both ends are
// near-vertical. `roofRun` is the length of top line within 8 mm of the peak —
// a sedan's is ~1 m, a fastback's ~0.15 m, an SUV's the length of its roof.
// `rearRun`/`frontRun` are how far the line has to travel to fall 20 cm off the
// peak: small means steep, which is a windscreen and a tailgate, not a sweep.
console.log('');
console.log('suv');
{
  const L = SUV.spec.dims.L;
  const ratio = SUVm.roofH / L;
  const kesselRear = faceRun(K, K.crestR ?? K.st.roofRearZ, -1, 0.20);
  if (VERBOSE) {
    console.log(`  roofH ${SUVm.roofH.toFixed(2)}  roofH/L ${ratio.toFixed(3)}  ` +
      `roofRun ${SUVm.roofRun.toFixed(2)}  rearRun ${SUVm.rearRun.toFixed(2)}  frontRun ${SUVm.frontRun.toFixed(2)}`);
  }
  ok('suv roof is in the SUV height band', ratio > 0.34,
    `roofH/L ${ratio.toFixed(3)} (want > 0.34; sedan ${(S.roofH / S.spec.dims.L).toFixed(3)})`);
  ok('suv roof runs long and flat', SUVm.roofRun > 1.6,
    `flat roof ${SUVm.roofRun.toFixed(2)} m (want > 1.6; sedan ${S.crest.toFixed(2)}, kessel ${K.crest.toFixed(2)})`);
  ok('suv rear is near-vertical (a tailgate, not a sweep)', SUVm.rearRun > 0 && SUVm.rearRun < 0.55,
    `${(SUVm.rearRun * 100).toFixed(0)} cm of run for a 20 cm drop (want < 55; kessel sweep ${(kesselRear * 100).toFixed(0)})`);
  ok('suv front screen is steep', SUVm.frontRun > 0 && SUVm.frontRun < 0.90,
    `${(SUVm.frontRun * 100).toFixed(0)} cm of run for a 20 cm drop (want < 90)`);
}

/* ---- 8. HERO COLOURS + WIRING ------------------------------------ */
// The three brothers' cars must be grey / red / white, and the right archetype
// must be wired to the right brother. Colour is resolved through the SAME pool
// the spawner reads (`spec.paints` -> `PAINTS`), classified by HSL family, so a
// mis-wired pool or a repaint fails. Geometry is already gated by sections 1-7,
// which measure the emitted `kessel` / `pickup` / `suv` directly; here we only
// confirm each brother is pointed at the class that owns that geometry.
console.log('');
console.log('hero colours + wiring');
function toHSL(hex) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  const s = d === 0 ? 0 : l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}
function family(hex) {
  const { h, s, l } = toHSL(hex);
  if (s < 0.15 && l > 0.72) return 'white';
  if (s < 0.20 && l >= 0.30 && l <= 0.72) return 'grey';
  if ((h >= 340 || h <= 22) && s > 0.35 && l >= 0.20 && l <= 0.62) return 'red';
  return 'other';
}
const CAR = { dylan: 'kessel', aidan: 'pickup', carson: 'suv' };
const WANT = { dylan: 'grey', aidan: 'red', carson: 'white' };
// The repaint control: each brother's car in a plausible but WRONG hue.
const WRONG = { dylan: 0xa72c22, aidan: 0xdedcd6, carson: 0x828890 };
for (const b of ['dylan', 'aidan', 'carson']) {
  const carId = BOYZ[b].car;
  ok(`${b} drives the ${CAR[b]}`, carId === CAR[b], `car = ${carId}`);
  const sp = VEHICLE_SPECS[carId];
  let colors = [];
  for (const pn of sp.paints ?? ['common']) for (const p of PAINTS[pn] ?? []) colors.push(p.color);
  if (CONTROL === 'repaint') colors = [WRONG[b]];
  const fams = colors.map(family);
  ok(`${b}'s ${carId} is painted ${WANT[b]}`, colors.length > 0 && fams.every((f) => f === WANT[b]),
    `${colors.map((c) => '0x' + c.toString(16)).join(',')} -> ${fams.join(',')} (want ${WANT[b]})`);
}

console.log('');
console.log(`${pass}/${pass + fail} shape assertions pass`);
if (fail) {
  console.log('');
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(fail ? 1 : 0);
