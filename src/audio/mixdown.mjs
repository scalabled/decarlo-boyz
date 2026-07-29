#!/usr/bin/env node
/**
 * AUDIO MIXDOWN — render the real synthesis graph offline and measure it.
 *
 * You cannot screenshot sound, so this is the audio subsystem's pixel gate. It
 * serves the repository as plain static files (no bundler: every module in
 * src/audio imports only relatives, so it needs none, and that keeps this tool
 * working while an unrelated file has the build red), renders each scene in
 * src/audio/bench.js through an OfflineAudioContext in headless Chromium, pulls
 * the PCM back into node and:
 *
 *   - writes a WAV per scene you can actually listen to
 *   - reports peak / RMS / dBFS and asserts nothing reaches 0 dBFS
 *   - tracks the SPECTRAL CENTROID over an engine load sweep, which is the
 *     measurement that proves the timbre changes with load rather than the
 *     pitch changing with rpm
 *   - tracks the dominant partial through a pass-by, which is the measurement
 *     that proves doppler is real
 *   - renders a log-frequency spectrogram PNG per scene so it can be eyeballed
 *
 * Usage:
 *   node src/audio/mixdown.mjs                     # everything
 *   node src/audio/mixdown.mjs --only=engine       # scenes matching a substring
 *   node src/audio/mixdown.mjs --out=/tmp/dcb      # where the WAVs go
 *   node src/audio/mixdown.mjs --no-png
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname, join, normalize } from 'node:path';
import { PNG } from 'pngjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const ROOT = resolve(import.meta.dirname, '../..');
const OUT = resolve(args.out ?? '/tmp/decarlo-audio');
const ONLY = args.only ? String(args.only) : null;
const DO_PNG = args.png !== '0' && !args['no-png'];
mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ */
/* static server                                                       */
/* ------------------------------------------------------------------ */

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };

const PAGE = `<!doctype html><meta charset=utf8><title>audio bench</title>
<body><script type="module">
  import * as bench from '/src/audio/bench.js';
  window.__BENCH__ = bench;
  window.__BENCH_READY__ = true;
</script></body>`;

const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
    return;
  }
  const path = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
const PORT = await new Promise((done) => {
  server.listen(0, '127.0.0.1', () => done(server.address().port));
});

/* ------------------------------------------------------------------ */
/* DSP for the analysis side                                           */
/* ------------------------------------------------------------------ */

/** In-place iterative radix-2 FFT. `re`/`im` are Float64Array of length 2^k. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

// 8192 at 48 kHz is 5.9 Hz per bin. An engine's half orders at idle are 3 Hz
// apart at the fundamental and ~25 Hz apart where the energy is, so anything
// coarser turns a harmonic stack into a smear and the spectrogram proves
// nothing.
const FFT_N = 8192;
const HOP = 2048;
const WINDOW = new Float64Array(FFT_N);
for (let i = 0; i < FFT_N; i++) WINDOW[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N);

/** Magnitude spectrogram of a mono signal: [{ t, mag: Float64Array }]. */
function spectrogram(mono, sr) {
  const frames = [];
  const re = new Float64Array(FFT_N);
  const im = new Float64Array(FFT_N);
  for (let start = 0; start + FFT_N <= mono.length; start += HOP) {
    for (let i = 0; i < FFT_N; i++) { re[i] = mono[start + i] * WINDOW[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float64Array(FFT_N / 2);
    for (let k = 0; k < FFT_N / 2; k++) mag[k] = Math.hypot(re[k], im[k]) / (FFT_N / 2);
    frames.push({ t: (start + FFT_N / 2) / sr, mag });
  }
  return frames;
}

/** Power-weighted mean frequency of one frame, above `floor` Hz. */
function centroid(mag, sr, floorHz = 40) {
  const binHz = sr / FFT_N;
  let num = 0, den = 0;
  for (let k = Math.ceil(floorHz / binHz); k < mag.length; k++) {
    const p = mag[k] * mag[k];
    num += p * k * binHz;
    den += p;
  }
  return den > 1e-14 ? num / den : 0;
}

/** Loudest bin of a frame, parabolically interpolated. */
function dominant(mag, sr, loHz = 45, hiHz = 4000) {
  const binHz = sr / FFT_N;
  let best = -1, bestV = 0;
  for (let k = Math.ceil(loHz / binHz); k < Math.min(mag.length - 1, hiHz / binHz); k++) {
    if (mag[k] > bestV) { bestV = mag[k]; best = k; }
  }
  if (best <= 0) return 0;
  const a = mag[best - 1], b = mag[best], c = mag[best + 1];
  const d = 0.5 * (a - c) / Math.max(a - 2 * b + c, 1e-12);
  return (best + Math.max(-1, Math.min(1, d))) * binHz;
}

/**
 * Fit a whole harmonic comb rather than chase the loudest bin.
 *
 * An engine's loudest single bin hops between adjacent orders frame to frame,
 * so tracking it measures nothing. Sliding a comb of `n` harmonics of `f0`
 * across a scale range and taking the best-fitting scale locks onto the entire
 * order stack at once, which is exactly the quantity doppler multiplies.
 * Returns the fitted scale factor.
 */
function combFit(mag, sr, f0, harmonics = 40, lo = 0.87, hi = 1.15) {
  const binHz = sr / FFT_N;
  let best = 1, bestV = -1;
  // The search range is deliberately narrower than an octave. Doppler at
  // highway speed is +-12%, and a comb fitter given a wider range will happily
  // lock onto half or double the true fundamental and report nonsense.
  for (let s = lo; s <= hi; s += 0.0006) {
    let v = 0;
    for (let n = 1; n <= harmonics; n++) {
      const k = Math.round((n * f0 * s) / binHz);
      if (k <= 0 || k >= mag.length) break;
      v += mag[k] * mag[k];      // power-weighted: strong orders should decide
    }
    if (v > bestV) { bestV = v; best = s; }
  }
  return best;
}

/**
 * How much MORE energy sits on multiples of `f0` than chance would put there.
 *
 * The naive version of this — "fraction of energy on the harmonic bins" —
 * measures nothing, because when the harmonics are only four bins apart the
 * harmonic bins are most of the bins, and white noise scores 0.7 on it. This
 * normalises by the coverage: 1.0 means the spectrum is indistinguishable from
 * noise, and anything above about 2.5 is an audible harmonic comb. A clean
 * synthesized engine order stack measures 6-10.
 */
function harmonicGain(mag, sr, f0, hiHz = 2500) {
  const binHz = sr / FFT_N;
  if (f0 < binHz * 2.5) return 0;
  const hiBin = Math.min(mag.length - 1, Math.floor(hiHz / binHz));
  const loBin = Math.ceil(Math.max(30, f0 * 0.5) / binHz);
  const spacing = f0 / binHz;
  const win = spacing >= 5 ? 1 : 0;      // never claim more bins than exist
  const on = new Uint8Array(hiBin + 1);
  for (let n = 1; n * f0 <= hiHz; n++) {
    const c = Math.round((n * f0) / binHz);
    for (let k = c - win; k <= c + win; k++) if (k >= loBin && k <= hiBin) on[k] = 1;
  }
  let onE = 0, onN = 0, offE = 0, offN = 0;
  for (let k = loBin; k <= hiBin; k++) {
    const p = mag[k] * mag[k];
    if (on[k]) { onE += p; onN++; } else { offE += p; offN++; }
  }
  if (!onN || !offN || offE <= 0) return 0;
  return (onE / onN) / (offE / offN);
}

/** RMS in dBFS over a window. */
function rmsDb(x, from, to) {
  let s = 0, n = 0;
  for (let i = Math.max(0, from | 0); i < Math.min(x.length, to | 0); i++) { s += x[i] * x[i]; n++; }
  return n ? 20 * Math.log10(Math.sqrt(s / n) + 1e-12) : -Infinity;
}

/* ------------------------------------------------------------------ */
/* output                                                              */
/* ------------------------------------------------------------------ */

function writeWav(path, pcm16, sr) {
  const bytes = pcm16.length * 2;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < pcm16.length; i++) buf.writeInt16LE(pcm16[i], 44 + i * 2);
  writeFileSync(path, buf);
}

/** Five-stop ramp: black - indigo - magenta - orange - white. */
const RAMP = [[0, 0, 6], [45, 12, 92], [158, 26, 118], [236, 108, 42], [255, 246, 218]];
function ramp(u, out) {
  const x = Math.max(0, Math.min(0.9999, u)) * (RAMP.length - 1);
  const i = x | 0, f = x - i;
  const a = RAMP[i], b = RAMP[i + 1];
  out[0] = a[0] + (b[0] - a[0]) * f;
  out[1] = a[1] + (b[1] - a[1]) * f;
  out[2] = a[2] + (b[2] - a[2]) * f;
}

/**
 * Log-frequency spectrogram, 20 Hz - Nyquist, 96 dB of range. This is the
 * eyeball test: an engine should show a comb of ORDER lines that fan out
 * together as the revs rise and break at each gearshift, not a noise wash.
 */
function writeSpectrogram(path, frames, sr, linearMax = 0) {
  if (!frames.length) return;
  const W = 1200;
  const H = 420;
  const png = new PNG({ width: W, height: H });
  const binHz = sr / FFT_N;
  const lMin = Math.log(20), lMax = Math.log(sr / 2);
  const rgb = [0, 0, 0];
  // Peak-normalise so quiet scenes are still readable.
  let peak = 1e-9;
  for (const f of frames) for (let k = 0; k < f.mag.length; k++) if (f.mag[k] > peak) peak = f.mag[k];
  const ref = 20 * Math.log10(peak);
  for (let x = 0; x < W; x++) {
    const f0 = Math.floor((x / W) * frames.length);
    const f1 = Math.max(f0 + 1, Math.floor(((x + 1) / W) * frames.length));
    for (let y = 0; y < H; y++) {
      // Log axis shows the whole spectrum; the linear low-band view is the one
      // that resolves an engine's order comb, because at 1 kHz two adjacent
      // orders are 1.7% apart and a log axis puts them in the same pixel.
      const hzA = linearMax ? ((H - 1 - y) / (H - 1)) * linearMax
        : Math.exp(lMin + ((H - 1 - y) / (H - 1)) * (lMax - lMin));
      const hzB = linearMax ? ((H - y) / (H - 1)) * linearMax
        : Math.exp(lMin + ((H - y) / (H - 1)) * (lMax - lMin));
      const kA = Math.max(0, Math.min(FFT_N / 2 - 1, Math.round(hzA / binHz)));
      const kB = Math.max(kA, Math.min(FFT_N / 2 - 1, Math.round(hzB / binHz)));
      let m = 0;
      for (let fi = f0; fi < f1 && fi < frames.length; fi++) {
        const mag = frames[fi].mag;
        for (let k = kA; k <= kB; k++) if (mag[k] > m) m = mag[k];
      }
      const db = 20 * Math.log10(m + 1e-12) - ref;
      ramp(Math.pow(Math.max(0, Math.min(1, (db + 96) / 96)), 1.25), rgb);
      const idx = (y * W + x) << 2;
      png.data[idx] = rgb[0] | 0; png.data[idx + 1] = rgb[1] | 0;
      png.data[idx + 2] = rgb[2] | 0; png.data[idx + 3] = 255;
    }
  }
  writeFileSync(path, PNG.sync.write(png));
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

const browser = await chromium.launch({
  headless: true,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

let exitCode = 0;
const rows = [];
const notes = [];

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__BENCH_READY__ === true', null, { timeout: 30000 });

  let names = await page.evaluate(() => window.__BENCH__.sceneNames());
  if (ONLY) names = names.filter((n) => n.includes(ONLY));
  if (!names.length) throw new Error(`no scenes match --only=${ONLY}`);
  console.log(`rendering ${names.length} scene(s) -> ${OUT}\n`);

  for (const name of names) {
    const t0 = Date.now();
    let r;
    try {
      r = await page.evaluate((n) => window.__BENCH__.renderScene(n), name);
    } catch (err) {
      rows.push({ name, error: String(err?.message ?? err).slice(0, 120) });
      exitCode = 1;
      continue;
    }
    const raw = Buffer.from(r.pcm, 'base64');
    const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    const file = name.replace(/[:]/g, '-');
    writeWav(join(OUT, `${file}.wav`), pcm, r.sampleRate);

    // Mono sum for the analysis.
    const n = pcm.length / 2;
    const mono = new Float64Array(n);
    for (let i = 0; i < n; i++) mono[i] = (pcm[i * 2] + pcm[i * 2 + 1]) / 65536;

    const frames = spectrogram(mono, r.sampleRate);
    if (DO_PNG) {
      writeSpectrogram(join(OUT, `${file}.png`), frames, r.sampleRate);
      if (/^engine|^passby|^fleet/.test(name)) {
        writeSpectrogram(join(OUT, `${file}.orders.png`), frames, r.sampleRate, 1400);
      }
    }

    let cent = 0;
    for (const f of frames) cent += centroid(f.mag, r.sampleRate);
    cent = frames.length ? cent / frames.length : 0;

    rows.push({
      name, seconds: r.seconds, peak: r.peak, dbfsPeak: r.dbfsPeak, dbfsRms: r.dbfsRms,
      centroid: Math.round(cent), nan: r.nan, clipped: r.clipped, ms: Date.now() - t0,
    });

    /* ---- per-scene deep analysis --------------------------------- */
    if (name === 'engineLoad' || name === 'engineRpm') {
      // Ironside 440: crossplane V8, mainOrder 4, so the exhaust cycle
      // frequency is rpm/120 and the firing order sits on harmonic 8 of it.
      const RPM = (s) => (name === 'engineLoad' ? 3000 : 900 + (s / 5) * (5900 - 900));
      const stages = [];
      for (let s = 0; s < 6; s++) {
        const from = s * 1.6 + 0.9, to = s * 1.6 + 1.55;
        const sel = frames.filter((f) => f.t >= from && f.t < to);
        if (!sel.length) continue;
        const f0 = RPM(s) / 120;
        let c = 0, d = 0, h = 0;
        for (const f of sel) {
          c += centroid(f.mag, r.sampleRate);
          // Track the ORDER lines, not the loudest bin anywhere: the loudest
          // bin drifts into the combustion band and says nothing about pitch.
          d += dominant(f.mag, r.sampleRate, f0 * 1.5, f0 * 26);
          h += harmonicGain(f.mag, r.sampleRate, f0);
        }
        stages.push({
          stage: s, rpm: Math.round(RPM(s)), cycleHz: +f0.toFixed(1),
          centroid: Math.round(c / sel.length),
          dominant: Math.round(d / sel.length),
          harmonicity: +(h / sel.length).toFixed(3),
          db: +rmsDb(mono, from * r.sampleRate, to * r.sampleRate).toFixed(1),
        });
      }
      notes.push({
        name,
        kind: name === 'engineLoad' ? 'load sweep (rpm HELD at 3000)' : 'rpm sweep (throttle HELD at 0.5)',
        stages,
      });
      if (stages.length >= 2) {
        const ratio = stages[stages.length - 1].centroid / Math.max(stages[0].centroid, 1);
        if (name === 'engineLoad' && ratio < 1.5) {
          console.log(`  !! engineLoad centroid only moved x${ratio.toFixed(2)} — timbre is not load dependent`);
          exitCode = 1;
        }
        if (name === 'engineRpm') {
          const df = stages[stages.length - 1].dominant / Math.max(stages[0].dominant, 1);
          notes[notes.length - 1].dominantRatio = +df.toFixed(2);
          if (df < 3) {
            console.log(`  !! engineRpm dominant order only moved x${df.toFixed(2)} for a x6.6 rpm sweep`);
            exitCode = 1;
          }
        }
        const meanH = stages.reduce((a, s) => a + s.harmonicity, 0) / stages.length;
        if (meanH < 2.5) {
          console.log(`  !! engine order comb only ${meanH.toFixed(2)}x above the noise floor — ` +
            'this is a filtered noise bed, not an order stack');
          exitCode = 1;
        }
      }
    }

    if (name === 'dopplerProbe' || name === 'passby' || name === 'sirenPass') {
      // Track the dominant partial through the pass. A siren SWEEPS, so
      // comparing instantaneous frequencies across the crossing compares two
      // arbitrary points of the wail; comparing the 90th PERCENTILE of each
      // half compares the top of the sweep with the top of the sweep, which is
      // the quantity doppler actually scales.
      // The engine is measured by fitting its whole order comb (the Ironside is
      // held at 4200 rpm, so its exhaust cycle frequency is 35 Hz and every
      // order is a multiple of that). The siren sweeps, so its comb moves for
      // reasons that are not doppler; it is tracked by the loudest partial and
      // compared at the 90th percentile of each half, which lines the top of
      // one wail up with the top of the next.
      const isEngine = name === 'passby';
      const f0 = name === 'dopplerProbe' ? 900 : 4200 / 120;
      const harmonics = name === 'dopplerProbe' ? 12 : 48;
      const mid = r.seconds / 2;
      const track = [];
      for (const f of frames) {
        const v = isEngine || name === 'dopplerProbe'
          ? combFit(f.mag, r.sampleRate, f0, harmonics) * f0
          : dominant(f.mag, r.sampleRate, 600, 3200);
        track.push({ t: +f.t.toFixed(2), f: v });
      }
      let before, after;
      if (isEngine || name === 'dopplerProbe') {
        // Average the magnitude spectra over each half BEFORE fitting. A V8's
        // combustion noise makes a single 170 ms frame ambiguous to a comb
        // fitter; averaging 40 frames drops the noise by 16 dB while the order
        // comb stays exactly where it is, and the fit becomes unambiguous.
        const mean = (lo, hi) => {
          const acc = new Float64Array(FFT_N / 2);
          let cnt = 0;
          for (const f of frames) {
            if (f.t < lo || f.t > hi) continue;
            for (let k = 0; k < acc.length; k++) acc[k] += f.mag[k];
            cnt++;
          }
          if (cnt) for (let k = 0; k < acc.length; k++) acc[k] /= cnt;
          return acc;
        };
        before = combFit(mean(0.6, mid - 1.2), r.sampleRate, f0, harmonics) * f0;
        after = combFit(mean(mid + 1.2, r.seconds - 0.6), r.sampleRate, f0, harmonics) * f0;
      } else {
        const pct = (arr, p) => {
          const s = arr.filter((v) => v > 0).sort((a, b) => a - b);
          return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
        };
        before = pct(track.filter((x) => x.t < mid - 0.8).map((x) => x.f), 0.9);
        after = pct(track.filter((x) => x.t > mid + 0.8).map((x) => x.f), 0.9);
      }
      notes.push({
        name, kind: 'doppler', approachHz: +before.toFixed(1), recedeHz: +after.toFixed(1),
        ratio: +(after / Math.max(before, 1e-6)).toFixed(3),
        track: track.filter((_, i) => i % Math.max(1, Math.floor(track.length / 16)) === 0)
          .map((x) => ({ t: x.t, f: Math.round(x.f) })),
      });
      if (after >= before) {
        console.log(`  !! ${name}: pitch did not fall through the pass — doppler is wrong or absent`);
        exitCode = 1;
      }
    }

    if (name === 'radioCabin') {
      // Getting out of a car must make the radio quieter and duller, never
      // louder. First half is on the pavement, second is in the driver's seat.
      const halfN = Math.floor(n / 2);
      const outsideDb = +rmsDb(mono, 0.5 * r.sampleRate, halfN).toFixed(1);
      const insideDb = +rmsDb(mono, halfN + 0.5 * r.sampleRate, n).toFixed(1);
      let outC = 0, outN = 0, inC = 0, inN = 0;
      for (const f of frames) {
        const c = centroid(f.mag, r.sampleRate);
        if (f.t < r.seconds / 2 - 0.5) { outC += c; outN++; } else if (f.t > r.seconds / 2 + 0.5) { inC += c; inN++; }
      }
      notes.push({
        name, kind: 'cabin', outsideDb, insideDb,
        outsideCentroid: Math.round(outC / Math.max(outN, 1)),
        insideCentroid: Math.round(inC / Math.max(inN, 1)),
      });
      if (outsideDb > insideDb) {
        console.log('  !! radio is LOUDER from outside the car than inside it');
        exitCode = 1;
      }
    }

    if (name.startsWith('radio:')) {
      // A generative station must not be a loop: correlate the first 8 s
      // against the next 8 s. A looping bed scores > 0.5 here.
      const seg = Math.floor(8 * r.sampleRate);
      if (n > seg * 2) {
        let num = 0, a2 = 0, b2 = 0;
        for (let i = 0; i < seg; i += 7) {
          const a = mono[i], b = mono[i + seg];
          num += a * b; a2 += a * a; b2 += b * b;
        }
        const corr = num / Math.sqrt(Math.max(a2 * b2, 1e-18));
        notes.push({ name, kind: 'self-similarity 0-8s vs 8-16s', corr: +corr.toFixed(4) });
        if (Math.abs(corr) > 0.35) {
          console.log(`  !! ${name} is repeating (corr ${corr.toFixed(3)})`);
          exitCode = 1;
        }
      }
    }
  }
} catch (err) {
  console.error('mixdown failed:', err);
  exitCode = 1;
} finally {
  await browser.close();
  server.close();
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
console.log(`${pad('scene', 24)}${padL('sec', 6)}${padL('peak', 8)}${padL('dBFS', 8)}${padL('rms dB', 9)}${padL('centHz', 8)}${padL('clip', 6)}${padL('nan', 5)}${padL('ms', 7)}`);
console.log('-'.repeat(81));
for (const r of rows) {
  if (r.error) { console.log(`${pad(r.name, 24)}ERROR ${r.error}`); continue; }
  console.log(
    pad(r.name, 24) + padL(r.seconds, 6) + padL(r.peak.toFixed(3), 8) +
    padL(r.dbfsPeak.toFixed(1), 8) + padL(r.dbfsRms.toFixed(1), 9) +
    padL(r.centroid, 8) + padL(r.clipped, 6) + padL(r.nan, 5) + padL(r.ms, 7)
  );
}

const bad = rows.filter((r) => r.error || r.nan > 0 || r.peak >= 0.999 || r.dbfsRms < -70);
if (bad.length) {
  exitCode = 1;
  console.log('\nFAILURES');
  for (const b of bad) console.log(' ', JSON.stringify(b));
}

if (notes.length) {
  console.log('\n=== ANALYSIS ===');
  for (const nt of notes) {
    if (nt.stages) {
      console.log(`\n${nt.name} — ${nt.kind}`);
      console.log(`  ${pad('stage', 7)}${padL('rpm', 7)}${padL('cycleHz', 9)}${padL('centroid', 10)}` +
        `${padL('order Hz', 10)}${padL('comb x', 10)}${padL('rms dB', 9)}`);
      for (const s of nt.stages) {
        console.log(`  ${pad(s.stage, 7)}${padL(s.rpm, 7)}${padL(s.cycleHz, 9)}${padL(s.centroid, 10)}` +
          `${padL(s.dominant, 10)}${padL(s.harmonicity, 10)}${padL(s.db, 9)}`);
      }
      if (nt.dominantRatio) console.log(`  dominant partial moved x${nt.dominantRatio}`);
      else {
        const f = nt.stages[0].centroid, l = nt.stages[nt.stages.length - 1].centroid;
        console.log(`  centroid moved x${(l / Math.max(f, 1)).toFixed(2)} with load at constant rpm`);
      }
    } else if (nt.kind === 'doppler') {
      console.log(`\n${nt.name} — doppler: approaching ${nt.approachHz} Hz, receding ${nt.recedeHz} Hz ` +
        `(ratio ${nt.ratio}, ${(-12 * Math.log2(Math.max(nt.ratio, 1e-3))).toFixed(1)} semitones down)`);
      console.log('  track: ' + nt.track.map((x) => `${x.t}s=${x.f}`).join(' '));
    } else if (nt.kind === 'cabin') {
      console.log(`\n${nt.name} — outside ${nt.outsideDb} dB / ${nt.outsideCentroid} Hz centroid, ` +
        `inside ${nt.insideDb} dB / ${nt.insideCentroid} Hz`);
    } else {
      console.log(`\n${nt.name} — ${nt.kind}: ${nt.corr}`);
    }
  }
}

if (logs.length) {
  console.log(`\n=== PAGE ERRORS (${logs.length}) ===`);
  for (const l of logs.slice(0, 20)) console.log(' ', l);
  exitCode = 1;
}

console.log(`\nWAVs and spectrograms in ${OUT}`);
console.log(exitCode === 0 ? 'AUDIO MIXDOWN: PASS' : 'AUDIO MIXDOWN: FAIL');
process.exit(exitCode);
