#!/usr/bin/env node
/**
 * Blind A/B composites.
 *
 * Takes two directories of shots (same filenames) and writes, for each shot,
 * one side-by-side PNG with the two versions in a RANDOMISED left/right order,
 * labelled only "A" and "B". The mapping is written to a separate key file that
 * the critic must not be shown.
 *
 * This is what makes a critic's "which one looks better" verdict worth
 * anything: it cannot favour the newer build because it cannot tell which side
 * is the newer build.
 *
 *   node tools/ab.mjs --left=shots/iter3 --right=shots/iter4 --out=shots/ab-4
 *   node tools/ab.mjs --left=shots/iter3 --right=shots/iter4 --out=shots/ab-4 --seed=7
 *
 * Then hand the critic ONLY `--out`, and read `<out>/_key.json` yourself to
 * decode the verdict.
 *
 * `--scale=0.5` halves each panel; the default keeps 1200 px per side, which is
 * enough for a critic to judge and small enough to actually look at.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { PNG } from 'pngjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const LEFT = resolve(args.left ?? 'shots/a');
const RIGHT = resolve(args.right ?? 'shots/b');
const OUT = resolve(args.out ?? 'shots/ab');
const PANEL_W = Number(args.panelWidth ?? 1200);
const GAP = 16;
const LABEL_H = 44;

if (!existsSync(LEFT)) throw new Error(`missing --left dir ${LEFT}`);
if (!existsSync(RIGHT)) throw new Error(`missing --right dir ${RIGHT}`);
mkdirSync(OUT, { recursive: true });

/** Deterministic PRNG so a rerun with the same seed produces the same blinding. */
let seed = (Number(args.seed ?? 1) >>> 0) || 1;
const rand = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
};

/** Nearest-neighbour box resample — good enough to judge, no dependencies. */
function resize(src, w, h) {
  const dst = new PNG({ width: w, height: h });
  const sx = src.width / w, sy = src.height / h;
  for (let y = 0; y < h; y++) {
    const py = Math.min(src.height - 1, (y * sy) | 0);
    for (let x = 0; x < w; x++) {
      const px = Math.min(src.width - 1, (x * sx) | 0);
      const s = (py * src.width + px) * 4;
      const d = (y * w + x) * 4;
      dst.data[d] = src.data[s];
      dst.data[d + 1] = src.data[s + 1];
      dst.data[d + 2] = src.data[s + 2];
      dst.data[d + 3] = 255;
    }
  }
  return dst;
}

function blit(dst, src, ox, oy) {
  for (let y = 0; y < src.height; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      const d = (dy * dst.width + dx) * 4;
      dst.data[d] = src.data[s];
      dst.data[d + 1] = src.data[s + 1];
      dst.data[d + 2] = src.data[s + 2];
      dst.data[d + 3] = 255;
    }
  }
}

/**
 * A 5x7 bitmap font, just enough for "A" and "B". Drawing the label into the
 * pixels (rather than relying on a filename) is deliberate: the critic sees the
 * letter in the image it is judging and cannot correlate it with anything else.
 */
const GLYPHS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
};

function drawLabel(png, ch, ox, oy, scale, rgb) {
  const g = GLYPHS[ch];
  if (!g) return;
  for (let r = 0; r < g.length; r++) {
    for (let c = 0; c < g[r].length; c++) {
      if (g[r][c] !== '1') continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = ox + c * scale + dx, y = oy + r * scale + dy;
          if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
          const i = (y * png.width + x) * 4;
          png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = 255;
        }
      }
    }
  }
}

/**
 * Drop any shot whose CAMERA MOVED between the two sets.
 *
 * `onRoad` shots re-derive their camera from the road graph at apply time, so
 * when the graph changes — new lots, a re-cut corridor, a different nearest
 * edge — the shot silently relocates. The two sets then photograph different
 * PLACES, and a blind A/B measures the relocation rather than the work.
 *
 * MEASURED: after a pass that changed lot layout, `street` moved to a different
 * block. Comparing the two would have told a critic that a build had lost all
 * its street trees, when in fact 875 trees were resident and the camera was
 * simply somewhere else. That is a wrong verdict presented with full
 * confidence, which is the worst thing a harness can produce.
 *
 * Requires `camPose` in each set's report.json (recorded by `__RENDER_INFO__`).
 * If either set predates that, nothing is dropped and a warning is printed —
 * silently comparing is never the safe default here.
 */
const poseOf = (dir) => {
  const p = resolve(dir, 'report.json');
  if (!existsSync(p)) return null;
  try {
    const r = JSON.parse(readFileSync(p, 'utf8'));
    const out = {};
    for (const s of r.shots ?? []) if (s?.info?.camPose) out[`${s.shot}.png`] = s.info.camPose;
    return Object.keys(out).length ? out : null;
  } catch { return null; }
};
const POSE_L = poseOf(LEFT);
const POSE_R = poseOf(RIGHT);
const MOVE_M = Number(args.maxMove ?? 3);      // metres
const TURN_R = Number(args.maxTurn ?? 0.08);   // radians, ~4.6 degrees

const moved = [];
const shots = readdirSync(LEFT)
  .filter((f) => f.endsWith('.png') && !f.startsWith('_'))
  .filter((f) => existsSync(resolve(RIGHT, f)))
  .filter((f) => {
    if (!POSE_L || !POSE_R) return true;
    const a = POSE_L[f], b = POSE_R[f];
    if (!a || !b) return true;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const t = Math.max(Math.abs(a[3] - b[3]), Math.abs(a[4] - b[4]), Math.abs(a[5] - b[5]));
    if (d <= MOVE_M && t <= TURN_R) return true;
    moved.push(`${f} moved ${d.toFixed(1)}m / ${t.toFixed(3)}rad`);
    return false;
  })
  .sort();

if (!POSE_L || !POSE_R) {
  console.error(
    '[ab] WARNING: one or both sets have no camPose in report.json, so shots that\n' +
    '     RELOCATED between builds cannot be detected and are being compared anyway.\n' +
    '     Any verdict here may be measuring a camera move rather than a change.'
  );
}
if (moved.length) {
  console.error(`[ab] dropped ${moved.length} relocated shot(s) — comparing them would measure the move:`);
  for (const m of moved) console.error(`       ${m}`);
}

if (!shots.length) throw new Error('no comparable shots present in BOTH directories');

/**
 * COUNTERBALANCING (`--counterbalance`, on by default).
 *
 * The first real A/B run came back 5-0 for side "A" — and the critic itself
 * pointed out that a clean sweep to one LABEL is indistinguishable from simple
 * position bias. It was right, and that made the result worthless as evidence.
 *
 * So every pair is now emitted TWICE, as `<shot>__1.png` and `<shot>__2.png`,
 * with the sides swapped between them. Then:
 *   - picks the same BUILD in both  -> a real preference, count it
 *   - picks the same SIDE in both   -> position bias, discard that pair
 * The two copies are interleaved among the other shots by filename, so they are
 * not adjacent in a directory listing.
 */
const COUNTERBALANCE = args.counterbalance !== 'false' && args.counterbalance !== false;

const key = {
  left: LEFT,
  right: RIGHT,
  seed: Number(args.seed ?? 1),
  counterbalanced: COUNTERBALANCE,
  note: COUNTERBALANCE
    ? 'Each shot appears twice with sides swapped. Same BUILD twice = real preference. Same SIDE twice = position bias, discard.'
    : 'Single presentation — vulnerable to position bias. Prefer --counterbalance.',
  pairs: {},
};

for (const f of shots) {
  const a = PNG.sync.read(readFileSync(resolve(LEFT, f)));
  const b = PNG.sync.read(readFileSync(resolve(RIGHT, f)));

  const ph = Math.round(PANEL_W * (a.height / a.width));
  const pa = resize(a, PANEL_W, ph);
  const pb = resize(b, PANEL_W, ph);

  // Coin flip decides which SOURCE goes on which SIDE for presentation 1.
  const flip = rand() < 0.5;
  const stem = basename(f, '.png');

  const emit = (leftIsFirstDir, suffix) => {
    const panelLeft = leftIsFirstDir ? pa : pb;
    const panelRight = leftIsFirstDir ? pb : pa;

    const W = PANEL_W * 2 + GAP;
    const H = ph + LABEL_H;
    const out = new PNG({ width: W, height: H });
    // Neutral mid-grey surround: a black or white gutter biases perceived contrast.
    for (let i = 0; i < out.data.length; i += 4) {
      out.data[i] = 24; out.data[i + 1] = 24; out.data[i + 2] = 26; out.data[i + 3] = 255;
    }
    blit(out, panelLeft, 0, LABEL_H);
    blit(out, panelRight, PANEL_W + GAP, LABEL_H);
    drawLabel(out, 'A', PANEL_W / 2 - 12, 8, 5, [235, 235, 235]);
    drawLabel(out, 'B', PANEL_W + GAP + PANEL_W / 2 - 12, 8, 5, [235, 235, 235]);

    const name = suffix ? `${stem}${suffix}.png` : f;
    writeFileSync(resolve(OUT, name), PNG.sync.write(out));
    key.pairs[basename(name, '.png')] = {
      shot: stem,
      A: leftIsFirstDir ? LEFT : RIGHT,
      B: leftIsFirstDir ? RIGHT : LEFT,
    };
  };

  if (COUNTERBALANCE) {
    emit(flip, '__1');
    emit(!flip, '__2');   // same pair, sides swapped
  } else {
    emit(flip, '');
  }
}

writeFileSync(resolve(OUT, '_key.json'), JSON.stringify(key, null, 2));
console.log(
  JSON.stringify({ ok: true, out: OUT, shots: shots.length, key: resolve(OUT, '_key.json') }, null, 2)
);
console.log('\nHand the critic ONLY the PNGs in', OUT, '— never _key.json.');
