#!/usr/bin/env node
/**
 * THE CRITIC'S TEST, as a tool.
 *
 * An adversarial critic reviewed an inherited frame, contrast-stretched a
 * 300x150 patch of a concrete barrier and a patch of sunlit stucco, and found
 * "nothing but per-pixel monochrome noise" and "a couple of soft smears":
 * measured luminance std 7.3/255 on the barrier. Their verdict was that the
 * frame "does not have a material pipeline — it has tinted geometry".
 *
 * So this does exactly what they did, and reports the numbers, so a surface can
 * be judged before it is called done rather than after it is shipped.
 *
 *   node src/materials/stretch.mjs shot.png out.png [x y w h]
 *
 * Reports, over the patch:
 *   std        luminance standard deviation, 0-255. Under ~9 is a painted card.
 *   hf         HIGH-FREQUENCY std, after subtracting a 9px box blur. This is
 *              the number that matters: a smooth lighting ramp inflates `std`
 *              without putting any surface detail on the screen, and `hf` sees
 *              through that.
 *   bands      how much of the detail survives at 1px / 2px / 4px / 8px scale.
 *              A real material has energy at every one of them; a normal map
 *              that is only sub-pixel dither has energy at 1px and nothing else.
 *   dither     hf(1px) / hf(4px). Over ~2.5 means the "detail" is noise that
 *              will average to flat grey one mip level away.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [, , inp, outp, X = 0, Y = 0, W = 0, H = 0] = process.argv;
if (!inp) {
  console.error('usage: stretch.mjs in.png [out.png] [x y w h]');
  process.exit(1);
}
const src = PNG.sync.read(readFileSync(inp));
const x0 = +X | 0;
const y0 = +Y | 0;
const w = +W ? +W | 0 : src.width;
const h = +H ? +H | 0 : src.height;

const lum = new Float64Array(w * h);
for (let j = 0; j < h; j++) {
  for (let i = 0; i < w; i++) {
    const a = (Math.min(src.height - 1, y0 + j) * src.width + Math.min(src.width - 1, x0 + i)) * 4;
    lum[j * w + i] = 0.2126 * src.data[a] + 0.7152 * src.data[a + 1] + 0.0722 * src.data[a + 2];
  }
}

const stat = (arr) => {
  let s = 0;
  for (const v of arr) s += v;
  const m = s / arr.length;
  let q = 0;
  for (const v of arr) q += (v - m) * (v - m);
  return { mean: m, std: Math.sqrt(q / arr.length) };
};

/** Separable box blur, radius r, clamped at the edges. */
function blur(a, r) {
  const t = new Float64Array(w * h);
  const o = new Float64Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const ii = Math.min(w - 1, Math.max(0, i + k));
        s += a[j * w + ii];
        n++;
      }
      t[j * w + i] = s / n;
    }
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const jj = Math.min(h - 1, Math.max(0, j + k));
        s += t[jj * w + i];
        n++;
      }
      o[j * w + i] = s / n;
    }
  return o;
}

const base = stat(lum);
/** Detail at scale r = the signal that a blur of radius r removes. */
function detailStd(r) {
  const b = blur(lum, r);
  const d = new Float64Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = lum[i] - b[i];
  return stat(d).std;
}
const d1 = detailStd(1);
const d2 = detailStd(2);
const d4 = detailStd(4);
const d8 = detailStd(8);
const hf = detailStd(4);

const report = {
  file: inp.split('/').pop(),
  rect: [x0, y0, w, h],
  mean: +base.mean.toFixed(2),
  std: +base.std.toFixed(2),
  hf: +hf.toFixed(2),
  bands: { p1: +d1.toFixed(2), p2: +d2.toFixed(2), p4: +d4.toFixed(2), p8: +d8.toFixed(2) },
  dither: +(d1 / Math.max(d4, 1e-3)).toFixed(2),
  verdict:
    hf < 2.0
      ? 'FLAT — tinted geometry, no material'
      : hf < 4.0
        ? 'WEAK — reads as painted card at 2 m'
        : d1 / Math.max(d4, 1e-3) > 2.5
          ? 'DITHER — detail is sub-pixel noise, gone one mip away'
          : 'OK',
};
console.log(JSON.stringify(report, null, 2));

// ---- the stretched image, so the failure can be SEEN as well as measured ----
if (outp) {
  const b = blur(lum, 6);
  const d = new Float64Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = lum[i] - b[i];
  const st = stat(d);
  const dst = new PNG({ width: w * 2, height: h });
  const put = (i, j, v, off) => {
    const p = (j * dst.width + i + off) * 4;
    const c = Math.max(0, Math.min(255, v));
    dst.data[p] = dst.data[p + 1] = dst.data[p + 2] = c;
    dst.data[p + 3] = 255;
  };
  // left: full-range stretch. right: high-pass at 4 sigma, which is what shows
  // whether there is any structure at all.
  let lo = 1e9, hi = -1e9;
  for (const v of lum) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const k = 255 / Math.max(hi - lo, 1e-3);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      put(i, j, (lum[j * w + i] - lo) * k, 0);
      put(i, j, 128 + (d[j * w + i] / Math.max(st.std, 1e-3)) * 42, w);
    }
  writeFileSync(outp, PNG.sync.write(dst));
}
