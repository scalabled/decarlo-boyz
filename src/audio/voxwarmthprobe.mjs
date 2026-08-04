#!/usr/bin/env node
/**
 * AUDIO / VOICE-WARMTH + RADIO-TEMPO PROBE
 *
 * Two owned tuning claims, measured on the EMITTED audio (rule 12), not on the
 * inputs:
 *
 *   1. RADIO TEMPO. Renders each station's drums solo through an
 *      OfflineAudioContext, driving the real Radio.update() scheduler, and
 *      recovers the beat period by autocorrelating the amplitude envelope. This
 *      is the trigger interval the player actually hears — it is derived from
 *      rendered pixels-of-sound, so if the scheduler ever stopped using bpm
 *      linearly the number would not move with bpm. Asserts every station's
 *      recovered tempo sits in the "background, not a rave" band.
 *
 *   2. VOICE WARMTH. Renders barks and measures, on the rendered buffer:
 *        - spectral centroid (Hz): buzz/brightness. Lower = warmer. This is the
 *          responsive axis — the vox chain lowpasses at 5 kHz, so the "buzzy
 *          robot" edge lives in the harmonic weight below that, which the
 *          centroid tracks; a raw >3.5 kHz ratio is near zero and measures
 *          nothing (presenceTilt is printed for reference only).
 *        - recovered f0 (Hz): the pitched register. Uncanny if too high.
 *      Asserts the talky squad bark ('copy') is warmer than a hard ceiling, the
 *      enemy shout ('contact') stays bright enough to read at distance, and the
 *      shout sits above the talk (the drive-scaled split holds).
 *
 * Usage:
 *   node src/audio/voxwarmthprobe.mjs            # run the gate
 *   node src/audio/voxwarmthprobe.mjs --wav=/tmp # also dump WAVs to listen
 *
 * NEGATIVE CONTROL: the thresholds are set so that reverting radio.js bpm to the
 * old values, or removing the vox.js warmth changes, drives a row RED. See the
 * report for the demonstrated red numbers.
 */
import { chromium } from 'playwright';
import { startServer, stopServer } from '../../tools/lib/server.mjs';
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const WAV_DIR = args.wav ? String(args.wav) : null;

/* ------------------------------------------------------------------ */
/* analysis (node side)                                                 */
/* ------------------------------------------------------------------ */

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Averaged magnitude spectrum over the loud portion of a mono signal. */
function avgSpectrum(x, sr) {
  const N = 4096;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const acc = new Float64Array(N / 2);
  let frames = 0;
  for (let s = 0; s + N <= x.length; s += N / 2) {
    // Skip near-silent frames so the measure reflects the voice, not the tail.
    let e = 0; for (let i = 0; i < N; i++) e += x[s + i] * x[s + i];
    if (Math.sqrt(e / N) < 0.01) continue;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) acc[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  if (frames) for (let k = 0; k < acc.length; k++) acc[k] /= frames;
  return { mag: acc, binHz: sr / N };
}

function centroid(mag, binHz, loHz = 120, hiHz = 8000) {
  let num = 0, den = 0;
  for (let k = Math.ceil(loHz / binHz); k < Math.min(mag.length, hiHz / binHz); k++) {
    const p = mag[k] * mag[k];
    num += p * k * binHz; den += p;
  }
  return den > 1e-14 ? num / den : 0;
}

/**
 * Presence/edge tilt: power in the 1.5-3.5 kHz band (F2/F3 + the shout presence
 * peak — the "buzzy, robotic" region) over power in the 150-800 Hz body (the
 * warm fundamental + F1). Higher = edgier/buzzier; lower = warmer. This band
 * pair, not "energy above 3.5 kHz", is where the vox chain actually lives: the
 * output lowpass sits at 5.2 kHz so there is almost nothing up top.
 */
function presenceTilt(mag, binHz) {
  let body = 0, pres = 0;
  for (let k = 0; k < mag.length; k++) {
    const f = k * binHz, p = mag[k] * mag[k];
    if (f >= 150 && f < 800) body += p;
    else if (f >= 1500 && f < 3500) pres += p;
  }
  return body > 1e-14 ? pres / body : 0;
}

/** Fundamental via low-lag autocorrelation of the raw signal. */
function estimateF0(x, sr, loHz = 90, hiHz = 320) {
  const loLag = Math.floor(sr / hiHz), hiLag = Math.ceil(sr / loHz);
  // Use the loud middle third.
  const a = Math.floor(x.length * 0.2), b = Math.floor(x.length * 0.6);
  let best = 0, bestLag = 0;
  for (let lag = loLag; lag <= hiLag; lag++) {
    let s = 0;
    for (let i = a; i < b; i++) s += x[i] * x[i - lag >= 0 ? i - lag : 0];
    if (s > best) { best = s; bestLag = lag; }
  }
  return bestLag ? sr / bestLag : 0;
}

/** Beat period (s) via envelope autocorrelation. */
function beatPeriod(x, sr, loBpm = 40, hiBpm = 200) {
  // Downsampled rectified envelope.
  const ds = 200; // Hz
  const step = Math.floor(sr / ds);
  const env = [];
  for (let s = 0; s + step <= x.length; s += step) {
    let e = 0; for (let i = 0; i < step; i++) e += Math.abs(x[s + i]);
    env.push(e / step);
  }
  const mean = env.reduce((a, b) => a + b, 0) / env.length;
  for (let i = 0; i < env.length; i++) env[i] -= mean;
  const loLag = Math.floor((60 / hiBpm) * ds), hiLag = Math.ceil((60 / loBpm) * ds);
  let best = 0, bestLag = 0;
  for (let lag = loLag; lag <= hiLag; lag++) {
    let s = 0; for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    if (s > best) { best = s; bestLag = lag; }
  }
  return bestLag ? bestLag / ds : 0;
}

function writeWav(path, mono, sr) {
  const pcm = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i++) pcm[i] = Math.max(-1, Math.min(1, mono[i])) * 32767;
  const bytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  writeFileSync(path, buf);
}

/* ------------------------------------------------------------------ */
/* in-page render                                                      */
/* ------------------------------------------------------------------ */

const PAGE_RENDER = `(async () => {
  const { Rng } = await import('/src/core/rng.js');
  const { NoiseBank } = await import('/src/audio/dsp.js');
  const { Mixer } = await import('/src/audio/mixer.js');
  const { SpatialField } = await import('/src/audio/spatial.js');
  const { Radio } = await import('/src/audio/radio.js');
  const vox = await import('/src/audio/vox.js');
  const SR = 48000;

  /* ---- voice: render one bark to mono ---- */
  async function renderBark(name, f0) {
    const seconds = 2.0;
    const actx = new OfflineAudioContext(1, Math.ceil(SR * seconds), SR);
    const rng = new Rng(1234);
    const bank = new NoiseBank(actx, rng.fork(), 2.0);
    const v = vox.bark(actx, bank, rng.fork(), { bark: name, when: 0.05, f0, level: 1, tract: 1.0 });
    v.node.connect(actx.destination);
    const buf = await actx.startRendering();
    return Array.from(buf.getChannelData(0));
  }

  /* ---- music: drive Radio, render one station's bed to mono ---- */
  const QUANTUM = 128, TICK = (QUANTUM * 12) / SR;
  async function renderStation(id) {
    const seconds = 8.0;
    const actx = new OfflineAudioContext(1, Math.ceil(SR * seconds), SR);
    const rng = new Rng(99);
    const bank = new NoiseBank(actx, rng.fork(), 2.0);
    const mixer = new Mixer(actx, rng.fork(), {});
    mixer.buildReverbs();
    mixer.setSpace({ tight: 0, room: 0, street: 0.4, tunnel: 0, open: 0.3 }, 0.001);
    // Route the music bus straight to the destination.
    mixer.bus('music').connect(actx.destination);
    const field = new SpatialField(actx, mixer, null);
    field.occlusionEnabled = false;
    field.setListener(0, 1.6, 0, 0, 0, -1, 0, 1, 0, 0);
    const radio = new Radio(actx, bank, mixer, field, rng.fork());
    radio.setRotation([id]);
    radio.setCabin(1, 0.001);
    radio.tune(id);
    const steps = Math.floor(seconds / TICK);
    const pending = [];
    for (let i = 1; i < steps; i++) { const t = i * TICK; pending.push({ t, p: actx.suspend(t) }); }
    const rendered = actx.startRendering();
    for (const s of pending) { await s.p; radio.update(TICK); actx.resume(); }
    const buf = await rendered;
    return Array.from(buf.getChannelData(0));
  }

  const out = { barks: {}, stations: {} };
  for (const [name, f0] of [['copy', 104], ['contact', 116], ['moveup', 108]]) {
    out.barks[name] = await renderBark(name, f0);
  }
  for (const id of ['grease', 'gold', 'redline', 'slack', 'furnace', 'incline']) {
    out.stations[id] = await renderStation(id);
  }
  return out;
})()`;

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

const SR = 48000;
// "Background, not a rave": recovered beat period must be at least this long.
// 130 bpm = 0.4615 s/beat; a firm rustbelt ceiling is ~0.44 s (<=136 bpm).
// Voice ceilings/floors, tuned around the measured warmed values with headroom.
// Warmth is read off the spectral centroid of the rendered bark. Lower = warmer
// (less of the buzzy upper-harmonic edge). Baselines before the vox.js warming:
// copy 421 Hz, contact 609 Hz. After: copy 334, contact 477.
const COPY_CENTROID_MAX = 400;    // squad talk must be warm  (RATCHET; NC: revert -> 421 RED)
const CONTACT_CENTROID_MIN = 430; // enemy shout must stay bright enough to read (NC: over-warm -> RED)
const SHOUT_OVER_TALK_MIN = 80;   // shout centroid must sit above talk: proves the drive split

const { port, server } = await startServer({});
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));

let fail = false;
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  const data = await page.evaluate(PAGE_RENDER);

  console.log('\n=== RADIO TEMPO (recovered from rendered envelope) ===');
  // The two formerly-frantic 130+ stations must now measure in the "background,
  // not a rave" band. This reads the beat off the RENDERED envelope, so it only
  // moves if the scheduler actually plays slower — the negative control is to
  // restore bpm 146/132, which pushes both back over the ceiling (RED).
  const RAVE_CEIL_BPM = 125;
  const foldedFor = {};
  for (const id of Object.keys(data.stations)) {
    const x = Float64Array.from(data.stations[id]);
    if (WAV_DIR) writeWav(`${WAV_DIR}/station_${id}.wav`, x, SR);
    const period = beatPeriod(x, SR);
    const bpm = period ? 60 / period : 0;
    // The recovered lag can lock to 1, 2 or 4 beats; fold to a per-beat estimate.
    let perBeat = period;
    while (perBeat > 0.75) perBeat /= 2;
    const foldedBpm = perBeat ? 60 / perBeat : 0;
    foldedFor[id] = foldedBpm;
    console.log(`  ${id.padEnd(8)} beat=${period.toFixed(3)}s  perBeat=${perBeat.toFixed(3)}s (~${foldedBpm.toFixed(0)} bpm)`);
  }
  console.log('');
  // Gate the two formerly-frantic stations on a beat-range-constrained search
  // (95-175 bpm) so an irregular kick pattern can't let the autocorrelation lock
  // onto a bar-length harmonic instead of the beat.
  for (const id of ['redline', 'furnace']) {
    const x = Float64Array.from(data.stations[id]);
    const p = beatPeriod(x, SR, 95, 175);
    const bpm = p ? 60 / p : 0;
    const ok = bpm > 0 && bpm < RAVE_CEIL_BPM;
    if (!ok) fail = true;
    console.log(`  [${ok ? 'OK ' : 'RED'}] ${id} recovered tempo < ${RAVE_CEIL_BPM} bpm  (got ${bpm.toFixed(0)}, configured ${id === 'redline' ? 116 : 112})`);
  }

  console.log('\n=== VOICE WARMTH (rendered bark spectra) ===');
  const rows = {};
  for (const name of Object.keys(data.barks)) {
    const x = Float64Array.from(data.barks[name]);
    if (WAV_DIR) writeWav(`${WAV_DIR}/bark_${name}.wav`, x, SR);
    const { mag, binHz } = avgSpectrum(x, SR);
    const c = centroid(mag, binHz);
    const hb = presenceTilt(mag, binHz);
    const f0 = estimateF0(x, SR);
    rows[name] = { c, hb, f0 };
    console.log(`  ${name.padEnd(8)} centroid=${c.toFixed(0)}Hz  prestilt=${hb.toFixed(3)}  f0=${f0.toFixed(1)}Hz`);
  }
  const copy = rows.copy, contact = rows.contact;
  const checks = [
    ['copy centroid < ' + COPY_CENTROID_MAX + ' (warm talk)', copy.c < COPY_CENTROID_MAX, copy.c.toFixed(0)],
    ['contact centroid > ' + CONTACT_CENTROID_MIN + ' (shout still cuts)', contact.c > CONTACT_CENTROID_MIN, contact.c.toFixed(0)],
    ['contact - copy > ' + SHOUT_OVER_TALK_MIN + ' (drive split holds)', (contact.c - copy.c) > SHOUT_OVER_TALK_MIN, (contact.c - copy.c).toFixed(0)],
  ];
  console.log('');
  for (const [label, ok, val] of checks) {
    if (!ok) fail = true;
    console.log(`  [${ok ? 'OK ' : 'RED'}] ${label}  (got ${val})`);
  }
} catch (e) {
  console.error('probe error:', e);
  fail = true;
} finally {
  if (errs.length) console.error('page errors:', errs.slice(0, 4));
  await browser.close();
  stopServer(server);
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}`);
process.exit(fail ? 1 : 0);
