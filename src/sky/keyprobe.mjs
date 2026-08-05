#!/usr/bin/env node
/**
 * KEYPROBE — does the sun actually do anything, measured on EMITTED PIXELS.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The game read as too dark twice over. The first pass measured a
 * real improvement in the night floor (crushed pixels 1.71% -> 0.03% at eye
 * level) and it still read too dark, which means the histogram was not
 * the thing that was wrong. An adversarial critic on the same build found what
 * was: a CLEAR-SKY LATE-AFTERNOON FRAME WITH NO CAST SHADOWS IN IT, and a
 * highlight that was BLUER than its own midtones. A frame lit only by a blue
 * sky dome reads as an overcast dusk whatever its mean luma is, and no amount
 * of exposure will fix it, because exposure scales the lit and the unlit alike.
 *
 * So this probe does not measure brightness. It measures whether the frame has
 * a KEY — a single dominant directional source that (a) is warm, (b) separates
 * lit surfaces from shaded ones, and (c) casts shadows that land in frame.
 *
 * ---------------------------------------------------------------------------
 * THE MEASUREMENT, AND WHY IT IS NOT CIRCULAR (rule 12)
 * ---------------------------------------------------------------------------
 * Everything here is computed from the PNG the harness wrote. Nothing reads
 * `sunLight.intensity`, the celestial model, or any constant the renderer was
 * fed — those are exactly the inputs whose effect is in doubt. The chain from
 * "the sky publishes a 6.9-intensity directional light" to "a shadow appears on
 * the road" runs through cascade fitting, caster collection, a receiver term,
 * GTAO, the tone curve and autoexposure, and the whole point of the last two
 * reports is that it was broken SOMEWHERE in there.
 *
 * `shadowRatio` — a surface region is reduced to 12x12-pixel blocks and the
 * ratio p85/p15 of block luma is taken. The block average is what makes this a
 * LIGHTING measure rather than a texture one: albedo variation, grain and
 * dither live at 1-3 px and average out, while a cast shadow is metres across
 * and survives. A sunlit road with a pole shadow across it runs 2.5-4; a road
 * lit only by the sky dome runs 1.1-1.3 whatever its exposure.
 *
 * `keyWarmth` — mean (R - B) of the brightest fifth of blocks minus the same
 * for the darkest fifth, in code values, ON THE SAME SURFACE. Same albedo, two
 * illuminants: if the bright blocks are not warmer than the dark ones, the
 * thing lighting them is not a warm sun. This is the critic's "R-B = -34"
 * observation turned into a per-surface number, which is the honest form of it
 * — measured whole-frame it is dominated by the sky, which is blue for good
 * physical reasons and is not the defect.
 *
 * What input would make this fail? `--params=owNoSunKey=1` publishes the sky,
 * the scattering, the discs and the ambient exactly as they are and drops the
 * sun's DIRECTIONAL light 8.4 stops. Every shadow metric here must collapse in
 * that arm. If it does not, the metric is reading texture and must be thrown
 * away rather than believed. `--control` runs both arms and prints the pair.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   node src/sky/keyprobe.mjs --analyze=shots/hud.png --shot=hud
 *   node src/sky/keyprobe.mjs --shot=hud --out=/tmp/a.png        # capture+measure
 *   node src/sky/keyprobe.mjs --shot=hud --control               # both arms
 *   node src/sky/keyprobe.mjs --rmse=a.png,b.png
 *   node src/sky/keyprobe.mjs --gate                             # the gate
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';

const ROOT = resolve(import.meta.dirname, '..', '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

/**
 * NAMED SURFACES, one per shot, in frame fractions [x0, y0, x1, y1].
 *
 * Every one of these is a single, continuous, roughly planar GROUND surface —
 * asphalt, concrete plaza or dirt lot — chosen because it is the surface a
 * player walks and drives on and therefore the one whose readability the
 * report is about. They deliberately exclude the sky, the building faces and
 * the HUD: a region spanning two materials measures albedo, not light.
 *
 * The second entry of the pair is the human name that goes in the report, so a
 * number can never be quoted without saying what it is a number ABOUT.
 */
const SURFACES = {
  // The midground plaza between the kerb wall and the avenue. This is the band
  // that carries the lamp columns, the street trees, the cones and the
  // planters — i.e. the casters. If a 26-degree sun is lighting this frame,
  // their shadows land here and nowhere else in it.
  hud: [[0.1, 0.575, 0.92, 0.645], 'downtown plaza, midground (lamp columns, trees, cones stand on it)'],
  hero: [[0.1, 0.5, 0.9, 0.72], 'riverfront lot, mid-frame (poles, signs, peds stand on it)'],
  street: [[0.42, 0.55, 0.95, 0.85], 'Lawrenceville carriageway'],
  driving: [[0.05, 0.62, 0.45, 0.9], 'downtown lot beside the car'],
  point: [[0.05, 0.62, 0.55, 0.95], 'Mt. Washington street grid from the air'],
  sunset: [[0.05, 0.62, 0.55, 0.95], 'West End street grid from the ridge'],
  night: [[0.1, 0.42, 0.92, 0.68], 'riverfront lot under the moon'],
  rain: [[0.25, 0.62, 0.8, 0.92], 'downtown carriageway in the rain'],
  detail: [[0.15, 0.35, 0.85, 0.85], 'road surface close-up'],
};

/**
 * HUD EXCLUSION. The overlay is authored art at fixed screen positions and it
 * is the brightest and the most saturated thing in several frames — the money
 * counter alone is pure #7CFF7C. Letting it into a whole-frame percentile or a
 * highlight-warmth average measures typography.
 */
const HUD_BOXES = [
  [0.0, 0.0, 0.22, 0.22], // mission ticker / objective list
  [0.78, 0.0, 1.0, 0.26], // cash, stars, clock, chapter banner
  [0.0, 0.74, 0.16, 1.0], // minimap
  [0.62, 0.9, 1.0, 1.0], // weapon slug
  [0.3, 0.88, 0.7, 1.0], // subtitle line
  [0.44, 0.56, 0.58, 0.66], // contextual action prompt
];

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function read(file) {
  const png = PNG.sync.read(readFileSync(file));
  return { w: png.width, h: png.height, d: png.data };
}

function inHud(fx, fy) {
  for (const [a, b, c, e] of HUD_BOXES) if (fx >= a && fx < c && fy >= b && fy < e) return true;
  return false;
}

/** Percentile from a 256-bin histogram, in code values. */
function pct(hist, n, p) {
  let c = 0;
  const t = n * p;
  for (let i = 0; i < 256; i++) {
    c += hist[i];
    if (c >= t) return i;
  }
  return 255;
}

/** Whole-frame tonal statistics, HUD excluded. */
function frameStats(img) {
  const { w, h, d } = img;
  const hist = new Uint32Array(256);
  let n = 0;
  let below = 0;
  let above = 0;
  let min = 255;
  let max = 0;
  for (let y = 0; y < h; y++) {
    const fy = y / h;
    for (let x = 0; x < w; x++) {
      if (inHud(x / w, fy)) continue;
      const i = (y * w + x) * 4;
      const L = lum(d[i], d[i + 1], d[i + 2]);
      hist[Math.min(255, Math.round(L))]++;
      n++;
      if (L / 255 < 0.02) below++;
      if (L / 255 > 0.98) above++;
      if (L < min) min = L;
      if (L > max) max = L;
    }
  }
  // Highlight warmth, whole frame: mean (R-B) over the brightest 5% against
  // the same over the middle decile. The critic's headline number.
  const hi = pct(hist, n, 0.95);
  const m0 = pct(hist, n, 0.45);
  const m1 = pct(hist, n, 0.55);
  let hiRB = 0;
  let hiN = 0;
  let midRB = 0;
  let midN = 0;
  for (let y = 0; y < h; y++) {
    const fy = y / h;
    for (let x = 0; x < w; x++) {
      if (inHud(x / w, fy)) continue;
      const i = (y * w + x) * 4;
      const L = lum(d[i], d[i + 1], d[i + 2]);
      const rb = d[i] - d[i + 2];
      if (L >= hi) {
        hiRB += rb;
        hiN++;
      } else if (L >= m0 && L <= m1) {
        midRB += rb;
        midN++;
      }
    }
  }
  return {
    mean: sumMean(hist, n),
    p5: pct(hist, n, 0.05),
    p50: pct(hist, n, 0.5),
    p95: pct(hist, n, 0.95),
    p001: pct(hist, n, 0.001),
    p999: pct(hist, n, 0.999),
    min,
    max,
    below002: (100 * below) / n,
    above098: (100 * above) / n,
    hiRB: hiN ? hiRB / hiN : 0,
    midRB: midN ? midRB / midN : 0,
  };
}

function sumMean(hist, n) {
  let s = 0;
  for (let i = 0; i < 256; i++) s += i * hist[i];
  return s / n / 255;
}

/**
 * A FLAT CEILING is a plateau, not a highlight.
 *
 * The critic's `driving.png` finding: 5% of frame area clamped to 245-248 with
 * a per-block standard deviation of 1. Measured here as the fraction of the
 * frame in 8x8 blocks whose mean is above `lo` AND whose standard deviation is
 * under 2 code values — i.e. area that carries no information at all because
 * the tone curve ran out of room before the scene did.
 */
function ceiling(img, lo = 240) {
  const { w, h, d } = img;
  const B = 8;
  let flat = 0;
  let tot = 0;
  for (let by = 0; by + B <= h; by += B) {
    for (let bx = 0; bx + B <= w; bx += B) {
      if (inHud((bx + B / 2) / w, (by + B / 2) / h)) continue;
      let s = 0;
      let s2 = 0;
      for (let y = by; y < by + B; y++)
        for (let x = bx; x < bx + B; x++) {
          const L = lum(d[(y * w + x) * 4], d[(y * w + x) * 4 + 1], d[(y * w + x) * 4 + 2]);
          s += L;
          s2 += L * L;
        }
      const nn = B * B;
      const m = s / nn;
      const sd = Math.sqrt(Math.max(0, s2 / nn - m * m));
      tot++;
      if (m >= lo && sd < 2) flat++;
    }
  }
  return (100 * flat) / Math.max(1, tot);
}

/** Block-reduced lighting statistics over one named surface. */
function surface(img, box) {
  const { w, h, d } = img;
  const B = 12;
  const x0 = Math.floor(box[0] * w);
  const y0 = Math.floor(box[1] * h);
  const x1 = Math.floor(box[2] * w);
  const y1 = Math.floor(box[3] * h);
  const cols = Math.floor((x1 - x0) / B);
  const rows = Math.floor((y1 - y0) / B);
  const L = new Float64Array(cols * rows);
  const RB = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sl = 0;
      let srb = 0;
      for (let y = y0 + r * B; y < y0 + (r + 1) * B; y++)
        for (let x = x0 + c * B; x < x0 + (c + 1) * B; x++) {
          const i = (y * w + x) * 4;
          sl += lum(d[i], d[i + 1], d[i + 2]);
          srb += d[i] - d[i + 2];
        }
      L[r * cols + c] = sl / (B * B);
      RB[r * cols + c] = srb / (B * B);
    }
  }
  const idx = Array.from(L.keys()).sort((a, b) => L[a] - L[b]);
  const at = (p) => L[idx[Math.min(idx.length - 1, Math.floor(p * idx.length))]];
  const p15 = at(0.15);
  const p50 = at(0.5);
  const p85 = at(0.85);
  const nq = Math.max(1, Math.floor(idx.length * 0.2));
  let loRB = 0;
  let hiRB = 0;
  let loL = 0;
  let hiL = 0;
  for (let i = 0; i < nq; i++) {
    loRB += RB[idx[i]];
    loL += L[idx[i]];
    hiRB += RB[idx[idx.length - 1 - i]];
    hiL += L[idx[idx.length - 1 - i]];
  }
  // Sharpest horizontal step between neighbouring blocks, as a fraction of the
  // surface's own median. A cast shadow has an EDGE; an ambient gradient does
  // not. Reported at the 99th percentile so one bad block cannot carry it.
  const steps = [];
  for (let r = 0; r < rows; r++)
    for (let c = 1; c < cols; c++) steps.push(Math.abs(L[r * cols + c] - L[r * cols + c - 1]));
  steps.sort((a, b) => a - b);
  const step99 = steps.length ? steps[Math.floor(steps.length * 0.99)] : 0;
  return {
    blocks: idx.length,
    p15,
    p50,
    p85,
    shadowRatio: p15 > 0.5 ? p85 / p15 : Infinity,
    litL: hiL / nq,
    shadowL: loL / nq,
    keyWarmth: hiRB / nq - loRB / nq,
    litRB: hiRB / nq,
    shadowRB: loRB / nq,
    step99: step99 / Math.max(1, p50),
  };
}

function rmse(a, b) {
  const A = read(a);
  const B2 = read(b);
  if (A.w !== B2.w || A.h !== B2.h) throw new Error('size mismatch');
  let s = 0;
  const n = A.w * A.h * 3;
  for (let i = 0; i < A.w * A.h; i++) {
    for (let k = 0; k < 3; k++) {
      const dd = A.d[i * 4 + k] - B2.d[i * 4 + k];
      s += dd * dd;
    }
  }
  return Math.sqrt(s / n);
}

function report(name, file, shotKey) {
  const img = read(file);
  const f = frameStats(img);
  const surf = SURFACES[shotKey] ?? SURFACES.hero;
  const s = surface(img, surf[0]);
  const cl = ceiling(img);
  console.log(
    `${name.padEnd(22)} mean=${f.mean.toFixed(4)} p5=${f.p5} p50=${f.p50} p95=${f.p95} ` +
      `range=[${f.p001}..${f.p999}] min=${f.min.toFixed(0)} max=${f.max.toFixed(0)} ` +
      `<0.02=${f.below002.toFixed(3)}% >0.98=${f.above098.toFixed(3)}% ` +
      `flat240=${cl.toFixed(2)}% hiRB=${f.hiRB.toFixed(1)} midRB=${f.midRB.toFixed(1)}`
  );
  console.log(
    `${''.padEnd(22)} surface "${surf[1]}": lit=${s.litL.toFixed(1)} shadow=${s.shadowL.toFixed(1)} ` +
      `shadowRatio=${s.shadowRatio.toFixed(2)} step99=${s.step99.toFixed(3)} ` +
      `keyWarmth=${s.keyWarmth.toFixed(1)} (lit R-B ${s.litRB.toFixed(1)}, shadow R-B ${s.shadowRB.toFixed(1)})`
  );
  return { frame: f, surf: s, ceiling: cl };
}

function capture(shot, out, params) {
  mkdirSync(dirname(out), { recursive: true });
  const a = ['src/render/shotprobe.mjs', `--shot=${shot}`, `--out=${out}`];
  if (params) a.push(`--params=${params}`);
  const r = spawnSync(process.execPath, a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`capture ${shot} failed: ${r.stderr?.slice(-800)}`);
  return out;
}

// ---------------------------------------------------------------------------

/**
 * ---------------------------------------------------------------------------
 * `--clock` — HOW LONG AN IN-GAME DAY ACTUALLY TAKES, TIMED OFF THE RUNNING
 * CLOCK RATHER THAN READ OFF THE CONSTANT THAT SETS IT
 * ---------------------------------------------------------------------------
 * The bug this exists to catch shipped BECAUSE the constant and the comment
 * next to it disagreed: `DEFAULT_TIME_RATE = 0.5` with "48 real minutes a day"
 * beside it, consumed as `hour += rate * dt` with dt in seconds — so the real
 * answer was 48 real SECONDS and the file said otherwise for as long as it
 * existed. A gate that read `DEFAULT_TIME_RATE` would have agreed with the
 * code and reported the same wrong number in a more official voice; that is
 * precisely the failure rule 12 is about.
 *
 * So this one boots the game with NO capture flag — a normal, wall-clock,
 * non-deterministic session, the thing a player runs — samples `sky.hour`
 * twice separated by real time measured with `performance.now()` inside the
 * page, and divides. It never touches the rate, the config, or any constant.
 *
 * What input would make it fail? Any change to `DEFAULT_TIME_RATE`, to the
 * `hour += rate * dt` integration, to the units of `dt`, or to the
 * deterministic gate that decides whether the clock runs at all.
 */
if (args.clock) {
  const { chromium } = await import('playwright');
  const { startServer, stopServer } = await import('../../tools/lib/server.mjs');
  const { port, server } = await startServer({});
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  let result = null;
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });
    const seconds = Number(args.seconds ?? 20);
    result = await page.evaluate(async (secs) => {
      const sky = window.__ENGINE__.ctx.peek('sky');
      const read = () => ({ h: sky.hour, d: sky.day, t: performance.now() });
      const a = read();
      await new Promise((r) => setTimeout(r, secs * 1000));
      const b = read();
      // Unwrap midnight: the clock is modulo 24 with a day counter beside it.
      const gameHours = b.h - a.h + (b.d - a.d) * 24;
      const realSeconds = (b.t - a.t) / 1000;
      return { gameHours, realSeconds, hour: b.h, day: b.d };
    }, seconds);
  } finally {
    await browser.close();
    stopServer(server);
  }
  const perDay = (24 / result.gameHours) * (result.realSeconds / 60);
  console.log(
    `clock: ${result.gameHours.toFixed(4)} game hours in ${result.realSeconds.toFixed(2)} real s ` +
      `=> ${perDay.toFixed(1)} REAL MINUTES PER IN-GAME DAY (target 48)`
  );
  const ok = perDay > 40 && perDay < 58;
  console.log(ok ? 'clock: OK' : 'clock: FAIL');
  process.exit(ok ? 0 : 1);
}

if (args.rmse) {
  const [a, b] = String(args.rmse).split(',');
  console.log(`RMSE ${a} vs ${b} = ${rmse(a, b).toFixed(4)}`);
  process.exit(0);
}

if (args.analyze) {
  const files = String(args.analyze).split(',');
  for (const f of files) {
    const key = args.shot ?? f.replace(/.*\//, '').replace(/\.png$/, '').split('-')[0];
    if (!existsSync(f)) {
      console.log(`${f}: MISSING`);
      continue;
    }
    report(f.replace(/.*\//, ''), f, key);
  }
  process.exit(0);
}

const shot = args.shot ?? 'hud';
const dir = args.dir ?? '/tmp/keyprobe';

if (args.control) {
  const on = capture(shot, `${dir}/${shot}-key.png`, args.params || '');
  const off = capture(shot, `${dir}/${shot}-nokey.png`, `owNoSunKey=1${args.params ? '&' + args.params : ''}`);
  const A = report(`${shot} key ON`, on, shot);
  const B = report(`${shot} key OFF`, off, shot);
  console.log(
    `\n  CONTROL  shadowRatio ${A.surf.shadowRatio.toFixed(2)} -> ${B.surf.shadowRatio.toFixed(2)}, ` +
      `keyWarmth ${A.surf.keyWarmth.toFixed(1)} -> ${B.surf.keyWarmth.toFixed(1)}, ` +
      `surface lit ${A.surf.litL.toFixed(1)} -> ${B.surf.litL.toFixed(1)}, ` +
      `RMSE ${rmse(on, off).toFixed(2)}`
  );
  process.exit(0);
}

/**
 * ---------------------------------------------------------------------------
 * THE GATE
 * ---------------------------------------------------------------------------
 * Four captures: three shots plus ONE NEGATIVE CONTROL, because a gate that
 * has never gone red is not evidence of anything (rule 12's corollary).
 *
 * Every threshold below is a RATCHET (rule 13). It records where this pass got
 * to, with the measured value beside it, NOT where the bar should be. The bar
 * for `keyWarmth` is really "a sunlit surface is visibly warmer than its own
 * shadow", which is a perceptual claim no number here proves; the bar for
 * `flat240` is really zero. LOWER a ratchet when you improve it. NEVER raise
 * one to make a run go green — that turns this file into a record of decay.
 */
const GATE = [
  {
    shot: 'hero',
    why: 'clear sky, sun 26 degrees, street level — the frame that must prove there is a key at all',
    checks: [
      ['surf.shadowRatio', '>=', 2.6, 3.69, 'cast shadows on the riverfront lot'],
      ['surf.keyWarmth', '>=', 12, 25.2, 'sunlit blocks warmer than shadowed ones, same surface'],
      ['frame.hiRB', '>=', 0, 12.9, 'the brightest 5% is not BLUER than the midtones'],
    ],
  },
  {
    shot: 'sunset',
    why: 'the money shot — golden hour must keep its long shadows and its warm key',
    checks: [
      ['surf.shadowRatio', '>=', 3.5, 5.26, 'long cast shadows across the West End grid'],
      ['surf.keyWarmth', '>=', 25, 43.9, 'a golden key against a blue-shadow fill'],
    ],
  },
  {
    shot: 'driving',
    /**
     * A HOLDING RATCHET, not an achievement. 6.04% of this frame is an
     * information-free plateau and that is a DEFECT — the goal is ~0. It is
     * not fixed, deliberately: the cause is the tone curve having no shoulder
     * (`src/render/`), and the one lever this subsystem has (the overcast sky
     * knee) buys it back by darkening every other overcast frame, which is the
     * opposite of the task. See the kneeFrac note in `_updateCelestial` for
     * the measured trade. This threshold exists only so the number cannot get
     * WORSE while somebody works on the right fix. Lower it when it improves.
     */
    why: 'overcast — the sky ceiling must not get flatter than it already is',
    checks: [['ceiling', '<=', 6.5, 6.04, 'per cent of frame above code 240 with 8x8 sd under 2 (goal ~0)']],
  },
  /**
   * ---------------------------------------------------------------------------
   * THE MOON-INDEPENDENT DEEP-NIGHT GROUND FLOOR — the case this pass adds.
   * ---------------------------------------------------------------------------
   * The night ambient's whole moon term collapses to zero on any night the moon
   * has set or is new (`moonPhase`*`discM`*keyRamp), and on those nights open
   * ground away from a lamp is a near-black, faintly sodium-warm field you cannot
   * read the terrain off. `src/sky/index.js` adds a moon-INDEPENDENT cool
   * starlight/skyglow floor (NIGHT_STARFLOOR_HUE) that fills in exactly when the
   * moon is absent. This case proves it on EMITTED pixels: a downtown open street
   * at 04:00 with the moon 9 degrees BELOW the horizon must stay navigable AND
   * COOL — on the light the floor adds, not on a moon that is not there.
   *
   * The negative control is `?nonightfloor=1` (the floor disabled at the live
   * code, mirroring the debugIgnore* pattern). With the floor gone the SAME frame
   * must go RED: its median luma crushes and its ground goes WARM, because the
   * only night term left over open ground is the warm urban skyglow. A floor
   * whose failure mode is invisible needs an arm where its removal is visible.
   *
   * Note what is NOT gated here: whole-frame crushed-% (`below002`). A deep-night
   * frame is ~28% dark SKY, which the floor deliberately does not lift (the sky
   * must read as night, stars out), so a crush-% threshold would measure the sky,
   * not the ground. Median luma and the surface's own warmth measure the GROUND.
   */
  {
    shot: 'downtown moonless street',
    slug: 'moonless',
    spec: '{"pos":[-232,5,150],"look":[-232,22,-40],"fov":62,"time":4,"ground":true,"clearTraffic":34}',
    surface: 'night',
    why: 'moon 9deg BELOW the horizon — open ground stays navigable and COOL on the starlight floor, not the moon',
    checks: [
      ['frame.p50', '>=', 20, 33, 'median display luma of the open street — the floor lifts it from a crushed 11'],
      ['surf.keyWarmth', '<=', 14, 4.5, 'the ground reads COOL — it is not warmed the way the bare sodium skyglow warms it'],
    ],
    control: {
      params: 'nonightfloor=1',
      mustFail: [
        ['frame.p50', '<', 20, 11, 'floor OFF: the open street crushes to a median of 11'],
        ['surf.keyWarmth', '>', 22, 36.1, 'floor OFF: the ground goes WARM — only the sodium skyglow is left over it'],
      ],
    },
  },
  {
    shot: 'downtown moonlit street',
    slug: 'moonlit',
    spec: '{"pos":[-232,5,150],"look":[-232,22,-40],"fov":62,"time":1.5,"ground":true,"clearTraffic":34}',
    surface: 'night',
    /**
     * The MOONLIT night must still pass. The floor is a FLOOR, not an add: it is
     * faded OUT under a moon (`moonPresence`=1 at moonAlt 18deg here, so
     * `starFloor` is exactly 0), so this frame is byte-for-byte what it was before
     * the floor existed. Asserting it is navigable and cool proves the floor did
     * not touch the money night — the case cannot distinguish floor on/off, and
     * that is the point.
     */
    why: 'the moonlit night is unchanged (floor faded out under the moon) and must still read navigable + cool',
    checks: [
      ['frame.p50', '>=', 18, 26, 'moonlit median display luma (the floor is off here)'],
      ['surf.keyWarmth', '<=', 0, -18.6, 'moonlit ground is cool (blue Purkinje night)'],
    ],
  },
];

/**
 * The control arm. `owNoSunKey=1` leaves the sky, the scattering, the discs
 * and the whole published ambient alone and drops the sun's DIRECTIONAL light
 * 8.4 stops. Both of these MUST go red, or the two shadow metrics above are
 * reading texture rather than light and none of the numbers mean anything.
 */
const CONTROL = {
  shot: 'hero',
  params: 'owNoSunKey=1',
  mustFail: [
    ['surf.shadowRatio', '<', 2.6, 1.86],
    ['surf.keyWarmth', '<', 0, -12.7],
  ],
};

function pick(r, path) {
  return path.split('.').reduce((o, k) => o?.[k], r);
}

if (args.gate) {
  let bad = 0;
  for (const g of GATE) {
    // A case may either name a built-in shot (g.shot doubles as the shot id and
    // the surface key) or carry an inline `spec` (arbitrary JSON pose) with its
    // own `surface` key and human `shot` label. `slug` is the filename/report id.
    const shotArg = g.spec ?? g.shot;
    const surfKey = g.surface ?? g.shot;
    const slug = g.slug ?? g.shot;
    const f = capture(shotArg, `${dir}/gate-${slug}.png`, g.params ?? args.params ?? '');
    const r = report(slug, f, surfKey);
    console.log(`${''.padEnd(22)} ${g.why}`);
    for (const [path, op, lim, was, what] of g.checks) {
      const v = pick(r, path);
      const ok = op === '>=' ? v >= lim : v <= lim;
      if (!ok) bad++;
      console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${slug}.${path} = ${v.toFixed(2)} ${op} ${lim} ` +
          `(RATCHET, measured ${was}) — ${what}`
      );
    }
    // Per-case negative control: capture the SAME pose with the fix disabled and
    // require it to go RED. This is the arm that makes the numbers above mean
    // something — a floor that is never removed is not evidence it does anything.
    if (g.control) {
      const cf = capture(shotArg, `${dir}/gate-${slug}-control.png`, g.control.params);
      const cr = report(`${slug} CONTROL`, cf, surfKey);
      console.log(`${''.padEnd(22)} negative control: ${g.control.params} — the floor removed, this frame MUST go red`);
      for (const [path, op, lim, was, what] of g.control.mustFail) {
        const v = pick(cr, path);
        const went = op === '<' ? v < lim : v > lim;
        if (!went) bad++;
        console.log(
          `  ${went ? 'PASS' : 'FAIL'}  ${slug}.control.${path} = ${v.toFixed(2)} ${op} ${lim} ` +
            `(measured ${was}) — ${what}`
        );
      }
    }
  }
  const cf = capture(CONTROL.shot, `${dir}/gate-control.png`, CONTROL.params);
  const cr = report(`CONTROL ${CONTROL.shot}`, cf, CONTROL.shot);
  console.log(`${''.padEnd(22)} negative control: ${CONTROL.params}`);
  for (const [path, op, lim, was] of CONTROL.mustFail) {
    const v = pick(cr, path);
    const went = op === '<' ? v < lim : v > lim;
    if (!went) bad++;
    console.log(
      `  ${went ? 'PASS' : 'FAIL'}  control ${path} = ${v.toFixed(2)} ${op} ${lim} ` +
        `(measured ${was}) — the metric must collapse with the key removed`
    );
  }
  console.log(bad === 0 ? '\nkeyprobe: OK' : `\nkeyprobe: ${bad} FAILING`);
  process.exit(bad === 0 ? 0 : 1);
}

const out = args.out ?? `${dir}/${shot}.png`;
capture(shot, out, args.params || '');
report(shot, out, shot);
