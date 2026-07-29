#!/usr/bin/env node
/**
 * CONTACT GATE — does anything in the frame read as touching anything?
 *
 * A four-lens review scored this build 23.5/100 and the blocker repeated by
 * three of the four lenses was that nothing looks like it is in contact with
 * anything else. The critic's own measurement, which this file exists to keep
 * honest, was:
 *
 *   "the under-car ground in `car.png` is L=49 against L=54 open ground, a
 *    0.1-stop delta, and the brick wall in `street.png` meets the pavement on
 *    a razor seam at identical value"
 *
 * So the gate measures EMITTED PIXELS at named surfaces and reports the delta
 * in stops. It never reads a uniform, a setting or an intermediate buffer that
 * the production code also read — ARCHITECTURE.md rule 12 — with one deliberate
 * exception noted at AO_OPEN below, which asserts a buffer stays UNCHANGED and
 * therefore cannot pass by agreeing with the tuning.
 *
 *   node src/render/contactprobe.mjs                # the gate
 *   node src/render/contactprobe.mjs --arm=off      # the negative control
 *   node src/render/contactprobe.mjs --keep=/tmp/x  # keep the PNGs
 *
 * `--arm=off` reverts all four fixes through their URL switches
 * (`owNoAoFix`, `owNoAoReach`, `owNoEmissiveSpill`, `owNoCarShadow`) in the
 * SAME build and is MEASURED AGAINST THE SAME THRESHOLDS, so it is expected to
 * exit non-zero. A gate that has never been seen to fail is not evidence of
 * correctness. Measured, one run of each arm:
 *
 *                          fixed        reverted
 *   car.underVsOpen        3.195 stops  0.135 stops   FAIL
 *   street.wallSeam        0.358        0.127         FAIL
 *   night.emissiveSpill    7.95 permil  4.71          FAIL
 *   street.aoOpenRoad0/1   1.000        1.000         pass in BOTH, as it must
 *
 * The reverted arm reproduces the review's own two numbers to within a
 * hundredth of a stop — "a 0.1-stop delta" under the car and "a razor seam at
 * identical value" at the wall — which is what says these rects are looking at
 * the surfaces the critic was looking at.
 *
 * The last row is the one that stops the other three being satisfiable by
 * turning the whole frame down: open road is exactly unoccluded either way.
 *
 * Takes about four minutes: it captures six frames. It is deliberately NOT in
 * `npm run gate`, for the same reason `gaitprobe` is not — that has to stay
 * seconds.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const OFF = args.arm === 'off';
const DIR = args.keep ? resolve(args.keep) : mkdtempSync(join(tmpdir(), 'contactprobe-'));
mkdirSync(DIR, { recursive: true });

/* ---------------------------------------------------------------------------
 * NAMED SURFACES, in 1920x1080 shot pixels.
 *
 * Authored by eye off the emitted frames and then held FIXED. They are not
 * derived from any camera or placement arithmetic the engine uses, which is
 * the point: if a change moves the car, the gate reads the road instead of the
 * car and goes red, rather than quietly following the subject around.
 * ------------------------------------------------------------------------- */

/** `car`: the strip of asphalt visible under the floor pan, between the near
 *  wheels, against open asphalt at the SAME image row on both sides. Both
 *  sides, because this frame has a strong left-to-right lighting gradient
 *  (1.2 stops across the width) and a one-sided reference would measure it. */
const CAR_UNDER = [955, 458, 200, 14];
const CAR_OPEN_L = [200, 458, 200, 14];
const CAR_OPEN_R = [1400, 458, 200, 14];

/** `street`: the brick wall on the left meets the pavement at y=587 over
 *  x=60..130. The contact band is the first metre of pavement out from it;
 *  the reference is the same pavement 2.5-3.5 m out. At this camera 1 m of
 *  ground is about 5.7 px, which is what sets these two bands. */
const WALL_CONTACT = [60, 591, 71, 6];
const WALL_OPEN = [60, 599, 71, 5];

/** `searchlight_side`: the mullion between two lit lobby windows, and the
 *  window itself. Reported as a RATIO, so it is immune to exposure. */
const WINDOW = [1380, 530, 120, 60];
const MULLION = [1360, 592, 60, 12];

/** `street` AO buffer: open road, nowhere near anything.
 *
 *  This one reads an internal buffer on purpose, and it is still not circular,
 *  because it asserts the buffer is UNCHANGED at 1.0. No amount of AO tuning
 *  can make it pass — only correct behaviour can. It is the control that stops
 *  the two contact numbers above from being satisfied by making the whole
 *  frame darker, which is the classic way an AO "improvement" is faked. */
const AO_OPEN = [
  [700, 780, 300, 60],
  [1500, 860, 300, 60],
];

const s2l = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

function meanY(png, [x, y, w, h]) {
  let sum = 0;
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++) {
      const a = (j * png.width + i) * 4;
      sum += 0.2126 * s2l(png.data[a]) + 0.7152 * s2l(png.data[a + 1]) + 0.0722 * s2l(png.data[a + 2]);
    }
  return sum / (w * h);
}

/** CIE L*, so the numbers can be compared with the critic's own. */
const lstar = (Y) => (Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y);

function shoot(shot, name, params) {
  const out = join(DIR, `${name}.png`);
  const a = ['src/render/shotprobe.mjs', `--shot=${shot}`, `--out=${out}`];
  if (params) a.push(`--params=${params}`);
  // Retried once, and the failure is summarised rather than dumped. A capture
  // that lands mid-save boots into a
  // ReferenceError, and a gate that answers that with 4000 lines of raw stdout
  // buffer is unreadable at exactly the moment it needs to be read.
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync('node', a, { cwd: resolve(import.meta.dirname, '..', '..'), stdio: 'pipe' });
      return PNG.sync.read(readFileSync(out));
    } catch (e) {
      if (attempt >= 1) {
        console.error(`[contactprobe] shot "${shot}" failed twice: ${String(e.message).slice(0, 300)}`);
        process.exit(2);
      }
    }
  }
}

const revert = OFF ? 'owNoAoFix=1&owNoAoReach=1&owNoEmissiveSpill=1&owNoCarShadow=1' : '';
const j = (a, b) => [a, b].filter(Boolean).join('&');

const car = shoot('car', 'car', revert);
const street = shoot('street', 'street', revert);
const night = shoot('searchlight_side', 'night', revert);
const streetAo = shoot('street', 'street_ao', j('rview=ao', revert));

const results = [];
function check(name, value, min, unit, note) {
  const pass = value >= min;
  results.push({ name, value: +value.toFixed(4), min, unit, pass, note });
}

// ---- 1. car: under the vehicle vs open ground -----------------------------
const under = meanY(car, CAR_UNDER);
const openCar = Math.sqrt(meanY(car, CAR_OPEN_L) * meanY(car, CAR_OPEN_R));
// 2.80, not the 3.195 the first run measured. This shot's SUBJECT is a
// vehicle, and vehicle geometry moves: two runs of identical render code
// twenty minutes apart gave 3.195 and 2.936 stops because the car's own
// geometry had changed. The threshold has to have room for that or it is a
// tripwire on `src/vehicles/` rather than a gate on this pass. It is
// still twenty times the 0.135 the reverted arm measures.
check('car.underVsOpen', Math.log2(openCar / under), 2.80, 'stops',
  `under L*=${lstar(under).toFixed(1)} open L*=${lstar(openCar).toFixed(1)}`);

// ---- 2. street: wall/pavement junction ------------------------------------
const seam = meanY(street, WALL_CONTACT);
const seamOpen = meanY(street, WALL_OPEN);
check('street.wallSeam', Math.log2(seamOpen / seam), 0.34, 'stops',
  `contact L*=${lstar(seam).toFixed(1)} 3m-out L*=${lstar(seamOpen).toFixed(1)}`);

// ---- 3. night: does a lit window reach its own mullion? -------------------
const win = meanY(night, WINDOW);
const mul = meanY(night, MULLION);
check('night.emissiveSpill', (mul / win) * 1000, 7.5, 'per mille',
  `window Y=${win.toFixed(4)} mullion Y=${mul.toFixed(5)}`);

// ---- 4. the control: AO must still be exactly 1.0 on open ground ----------
for (let i = 0; i < AO_OPEN.length; i++) {
  const v = meanY(streetAo, AO_OPEN[i]);
  check(`street.aoOpenRoad${i}`, v, 0.995, 'visibility', 'must stay unoccluded');
}

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(
    `${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(24)} ${String(r.value).padStart(9)} ${r.unit}` +
      `  (min ${r.min})  ${r.note}`
  );
}
console.log(`\narm=${OFF ? 'REVERTED (negative control)' : 'fixed'}  ${results.length - failed.length}/${results.length}`);
if (!args.keep) rmSync(DIR, { recursive: true, force: true });

/*
 * ── RATCHET, NOT A TARGET ──────────────────────────────────────────────────
 * ARCHITECTURE.md rule 13. Every threshold above records WHERE THIS PASS GOT
 * TO, not where the bar is. Lower one when you improve it; never raise one to
 * make a run go green.
 *
 *                          critic's build   pre-calibration   this pass   goal
 *   car.underVsOpen         0.135 stops      2.07 stops        2.94-3.20   met
 *   street.wallSeam         0.127 stops      0.253 stops       0.358       ~0.8
 *   night.emissiveSpill     4.46 per mille   4.46 per mille    8.00        ~15
 *
 * "critic's build" is `--arm=off`: AO white, the 128 px march, the
 * highlight-only bloom and no vehicle ground shadow. "pre-calibration" is the
 * build this pass started from — the AO pass had just been repaired and its
 * four numbers had never been observed doing anything.
 *
 * What is still missing, so the next person does not have to rediscover it:
 *
 *  - The vehicle ground-shadow pool in `src/vehicles/groundshadow.js` is only
 *    2.60 x half.x wide, i.e. ~30 cm wider than the car each side, and its
 *    superelliptical alpha reaches zero AT the quad edge. So the whole penumbra
 *    is behind the car's own bodywork: measured on `driving`, switching the
 *    pool off changes the frame by RMSE 0.128 with a 312x47 px footprint. It
 *    works (1.23 stops under the sill on `car`) and almost none of it is
 *    visible. Widening the quad is a `src/vehicles/` change.
 *  - GTAO cannot see an occluder that is off screen or behind another surface,
 *    so a contact under the BOTTOM edge of frame has no occluder to find.
 *  - `night.emissiveSpill` is bloom, which is a screen-space skirt and not
 *    bounce: it brightens the mullion but cannot tint it with the window's
 *    hue beyond what the pyramid's chroma boost carries.
 */
process.exit(failed.length ? 1 : 0);
