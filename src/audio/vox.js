/**
 * AUDIO / VOICE — formant synthesis for enemy barks
 *
 * No speech samples, so barks are built the way a vocal tract works:
 *
 *   glottal pulse train (PeriodicWave, 1/n^1.15 harmonics)
 *     + aspiration noise
 *     ─► three parallel band-passes at the formant frequencies F1..F3
 *     ─► chest/throat shaping, presence peak, mild saturation (shouting)
 *     + separately mixed consonant bursts (plosives and fricatives)
 *
 * The formant centres are ramped between vowels, the f0 follows a per-syllable
 * pitch contour, and both are jittered every ~25 ms. That jitter is the single
 * most important ingredient: without it the result is a Speak&Spell, with it a
 * player reads it as a human shouting a word they cannot quite make out — which
 * is exactly the goal for enemy chatter at 30 m.
 */

import { ad, adsr, biquad, clamp, gain, hit, saturationCurve, series, shaper, sweep } from './dsp.js';

/** F1, F2, F3 (Hz) and their bandwidths, adult male, shouted register. */
const VOWELS = {
  a: [730, 1090, 2440, 110, 130, 180],  // "father"
  e: [530, 1840, 2480, 90, 120, 170],   // "bed"
  i: [300, 2290, 3010, 70, 130, 190],   // "see"
  o: [570, 840, 2410, 90, 110, 170],    // "law"
  u: [325, 700, 2530, 70, 100, 170],    // "boot"
  ah: [640, 1200, 2500, 110, 140, 190],
  ehr: [490, 1350, 1690, 100, 130, 180], // "her"
  ohh: [450, 900, 2300, 95, 115, 175],
};

/**
 * Bark scripts. Each syllable: v vowel, d duration, a amplitude, p pitch
 * multiplier, on onset consonant ('p' plosive, 'f' fricative, 'n' nasal),
 * g gap after the syllable.
 */
export const BARKS = {
  /* "CONTACT!" */
  contact: {
    f0: 1.18, drive: 1.25, syl: [
      { v: 'o', d: 0.13, a: 1.0, p: 1.06, on: 'p', g: 0.012 },
      { v: 'a', d: 0.19, a: 1.0, p: 1.16, on: 'p', g: 0 },
    ],
  },
  /* "ENEMY SPOTTED" */
  spotted: {
    f0: 1.1, drive: 1.1, syl: [
      { v: 'e', d: 0.1, a: 0.9, p: 1.05, g: 0.01 },
      { v: 'a', d: 0.08, a: 0.7, p: 1.0, on: 'n', g: 0.01 },
      { v: 'i', d: 0.1, a: 0.8, p: 0.95, g: 0.06 },
      { v: 'a', d: 0.12, a: 1.0, p: 1.1, on: 'f', g: 0.02 },
      { v: 'e', d: 0.13, a: 0.75, p: 0.9, on: 'p', g: 0 },
    ],
  },
  /* "RELOADING!" */
  reloading: {
    f0: 1.05, drive: 1.0, syl: [
      { v: 'i', d: 0.09, a: 0.8, p: 1.0, g: 0.01 },
      { v: 'ohh', d: 0.16, a: 1.0, p: 1.12, g: 0.015 },
      { v: 'i', d: 0.13, a: 0.7, p: 0.9, on: 'p', g: 0 },
    ],
  },
  /* "GRENADE!" — panicked, pitch climbs hard */
  grenade: {
    f0: 1.3, drive: 1.5, syl: [
      { v: 'e', d: 0.1, a: 0.9, p: 1.0, on: 'p', g: 0.012 },
      { v: 'a', d: 0.26, a: 1.15, p: 1.35, on: 'n', g: 0 },
    ],
  },
  /* "FLANKING!" */
  flanking: {
    f0: 1.12, drive: 1.2, syl: [
      { v: 'a', d: 0.16, a: 1.0, p: 1.1, on: 'f', g: 0.015 },
      { v: 'i', d: 0.13, a: 0.8, p: 0.95, on: 'n', g: 0 },
    ],
  },
  /* "SUPPRESSING FIRE!" */
  suppressing: {
    f0: 1.08, drive: 1.15, syl: [
      { v: 'u', d: 0.09, a: 0.75, p: 0.98, on: 'f', g: 0.01 },
      { v: 'e', d: 0.14, a: 1.0, p: 1.12, on: 'p', g: 0.02 },
      { v: 'i', d: 0.1, a: 0.7, p: 0.9, g: 0.05 },
      { v: 'a', d: 0.18, a: 0.95, p: 1.05, on: 'f', g: 0 },
    ],
  },
  /* "MOVE UP!" */
  moveup: {
    f0: 1.1, drive: 1.2, syl: [
      { v: 'u', d: 0.16, a: 1.0, p: 1.08, on: 'n', g: 0.03 },
      { v: 'a', d: 0.14, a: 0.9, p: 1.0, g: 0 },
    ],
  },
  /* wordless taking-fire grunt */
  hit: {
    f0: 1.25, drive: 1.6, breath: 0.5, syl: [
      { v: 'ah', d: 0.16, a: 1.1, p: 1.2, on: 'p', g: 0 },
    ],
  },
  /* pain, longer, wavering */
  pain: {
    f0: 1.15, drive: 1.3, breath: 0.65, tremolo: 14, syl: [
      { v: 'ah', d: 0.34, a: 0.95, p: 1.0, g: 0 },
    ],
  },
  /* death: pitch collapses, breath takes over, ends in an exhale */
  death: {
    f0: 1.05, drive: 1.4, breath: 1.0, tremolo: 22, dying: true, syl: [
      { v: 'ah', d: 0.3, a: 1.0, p: 1.15, g: 0.02 },
      { v: 'ehr', d: 0.42, a: 0.6, p: 0.62, g: 0 },
    ],
  },
  /* short affirmative, for squad chatter */
  copy: {
    f0: 1.0, drive: 0.9, syl: [
      { v: 'a', d: 0.1, a: 0.85, p: 1.0, on: 'p', g: 0.02 },
      { v: 'i', d: 0.12, a: 0.7, p: 0.88, on: 'p', g: 0 },
    ],
  },
};

const WAVE_CACHE = new WeakMap();

/**
 * Glottal-ish pulse, with an EFFORT-DEPENDENT spectral tilt.
 *
 * A 1/n^1.15 rolloff kept a lot of energy on the high harmonics, and a hard
 * periodic source that bright is exactly the buzzy, "Speak&Spell" edge that
 * reads as alien. A real glottal flow falls off steeper — but by how much
 * depends on vocal EFFORT: a relaxed chest voice has a steep source (little
 * high-harmonic energy, warm), a shout drives the folds harder and the source
 * flattens (more high harmonics, brighter, carries at distance). Real speech
 * modulates this "spectral tilt" with loudness, and doing it at the SOURCE is
 * more honest than only brightening the output filter.
 *
 * So the rolloff exponent `tilt` is chosen by the caller from the bark's drive:
 * ~1.85 for calm squad talk (warm), ~1.45 for a panicked yell (bright). Waves
 * are cached per exponent bucket. The even harmonics are pulled down a little
 * (a rounder pulse, less reedy) at every tilt.
 */
function glottalWave(actx, tilt = 1.6) {
  let byCtx = WAVE_CACHE.get(actx);
  if (!byCtx) WAVE_CACHE.set(actx, (byCtx = new Map()));
  const bucket = Math.round(tilt * 20) / 20; // 0.05 resolution keeps the cache small
  let w = byCtx.get(bucket);
  if (w) return w;
  const N = 48; // reach ~4.8 kHz at f0=100 so F4 has harmonics to excite
  const real = new Float32Array(N);
  const imag = new Float32Array(N);
  for (let n = 1; n < N; n++) {
    imag[n] = (1 / Math.pow(n, bucket)) * (n % 2 === 0 ? -0.6 : 1);
  }
  w = actx.createPeriodicWave(real, imag, { disableNormalization: false });
  byCtx.set(bucket, w);
  return w;
}

/**
 * Synthesize a bark.
 *
 * @param {object} o { when, bark, f0 (base Hz), tract (0.9..1.1), level,
 *                     radio (bool), distance }
 */
export function bark(actx, bank, rng, o = {}) {
  const t0 = o.when ?? actx.currentTime;
  const spec = BARKS[o.bark] ?? BARKS.contact;
  const tract = o.tract ?? rng.range(0.94, 1.07);
  const f0 = (o.f0 ?? rng.range(96, 132)) * spec.f0;
  const level = o.level ?? 1;
  const out = gain(actx, 0.2); // VOICE TRIM

  // Vocal effort. Calm squad chatter sits ~0.9, a panicked yell ~1.5. It drives
  // three things at once — the source spectral tilt (here), the formant
  // sharpness, and the presence/saturation downstream — so the whole voice
  // brightens together as it gets louder, which is what a real one does.
  const dr = spec.drive ?? 1;
  // Straddle the old fixed 1.55: calm talk warmer (~1.75), a yell brighter.
  const tiltExp = clamp(1.7 - 0.5 * (dr - 1), 1.45, 1.9);
  // Formant Q: sharpen the calm voice for clear vowels; leave the shout broad
  // and rough (it needs to carry, not to be pretty). Never below ~0.9 so a yell
  // stays intelligible.
  const qScale = clamp(1.35 - 0.6 * (dr - 0.9), 0.9, 1.35);

  const total = spec.syl.reduce((s, x) => s + x.d + (x.g ?? 0), 0);

  /* ---- source ---------------------------------------------------- */
  const src = actx.createOscillator();
  src.setPeriodicWave(glottalWave(actx, tiltExp));
  const srcGain = gain(actx, 0);
  src.connect(srcGain);

  // Humanise the pitch. A formant voice on a dead-steady fundamental is the
  // single biggest "alien / robot" tell; a real larynx never holds a note
  // perfectly. Two slow, incommensurate LFOs sum into the frequency param on
  // TOP of the scheduled syllable contour: a ~5 Hz vibrato and a slower drift,
  // together under ~2% so it warms rather than warbles. Skip on the death line,
  // where the pitch is meant to collapse cleanly.
  if (!spec.dying) {
    const lfoEnd = t0 + total + 0.5;
    const vibHz = rng.range(4.6, 5.8);
    const vib = actx.createOscillator();
    vib.type = 'sine'; vib.frequency.value = vibHz;
    const vg = gain(actx, f0 * 0.010);
    vib.connect(vg); vg.connect(src.frequency);
    const drift = actx.createOscillator();
    drift.type = 'sine'; drift.frequency.value = rng.range(0.7, 1.3);
    const dg = gain(actx, f0 * 0.012);
    drift.connect(dg); dg.connect(src.frequency);
    // Fast flutter (~9-12 Hz). A real larynx has a fine cycle-to-cycle jitter
    // above the vibrato band; the reference synth builds it from 7.1 + 12.7 Hz
    // components. Adding this third, faster, shallow term is what stops the
    // pitch reading as a clean sine-modulated tone and pushes it toward a
    // living voice. Kept tiny (~0.4%) so it textures rather than warbles.
    const flut = actx.createOscillator();
    flut.type = 'sine'; flut.frequency.value = rng.range(8.5, 12.5);
    const fg = gain(actx, f0 * 0.004);
    flut.connect(fg); fg.connect(src.frequency);
    vib.start(t0); vib.stop(lfoEnd);
    drift.start(t0); drift.stop(lfoEnd);
    flut.start(t0); flut.stop(lfoEnd);
  }

  // Aspiration: always a little, a lot when hurt or dying.
  const breathLevel = (spec.breath ?? 0.16) * rng.range(0.8, 1.25);
  const noise = bank.source('white', rng, rng.range(0.9, 1.2));
  const noiseBP = biquad(actx, 'bandpass', 1400, 0.6);
  const noiseGain = gain(actx, 0);
  series(noise, noiseBP, noiseGain);

  const excite = gain(actx, 1);
  srcGain.connect(excite);
  noiseGain.connect(excite);

  /* ---- formant bank ---------------------------------------------- */
  const first = VOWELS[spec.syl[0].v] ?? VOWELS.a;
  const fs = [];
  for (let i = 0; i < 3; i++) {
    const f = first[i] * tract;
    const bw = first[i + 3];
    const bp = biquad(actx, 'bandpass', f, clamp((f / bw) * qScale, 1.5, 14));
    const g = gain(actx, [1.0, 0.55, 0.24][i]);
    excite.connect(bp);
    bp.connect(g);
    fs.push({ bp, g });
  }
  // F4 — a fixed high resonance. Real adult voices carry a 4th (and 5th)
  // formant clustered around 3.3-3.7 kHz; the 3-formant model has none, which
  // is a large part of why a pure source+F1F2F3 vowel reads thin and slightly
  // synthetic. F4 barely moves across vowels, so it is built once and held for
  // the whole bark (the per-vowel glide loop below only touches fs[0..2]). It
  // is pushed into `fs` only so it feeds `throat` with the others.
  {
    const f4Hz = clamp(3350 * tract, 2600, 4200);
    // A parallel bank (unlike a cascade) does not inherit the lower formants'
    // energy, so a high formant fed a source that already rolls off steeply
    // comes out near-silent without makeup gain — the same compensation
    // struckResonator() applies to its high-Q partials. 0.34 puts F4 at a
    // believable "ring" level next to F3 (0.24). Its EXCITATION still scales
    // with vocal effort for free: the calm voice's steep source barely lights
    // it, a bright yell lights it fully — so F4 adds cut to a shout and only a
    // little air to talk, which is exactly right.
    const bp = biquad(actx, 'bandpass', f4Hz, f4Hz / 360);
    const g = gain(actx, 0.34);
    excite.connect(bp);
    bp.connect(g);
    fs.push({ bp, g });
  }

  /* ---- vocal tract output shaping -------------------------------- */
  // The presence peak and the saturation are what separate "someone talking"
  // from "a robot shouting". Both now scale with the bark's own drive: a calm
  // squad line (drive ~0.9) gets a gentle 2.2 dB presence and light saturation
  // so it reads as a person; a panicked enemy yell (drive ~1.5) keeps a bright,
  // cutting 4.0 dB peak and more grit so it still punches through at 30 m.
  const throat = biquad(actx, 'peaking', 470, 1.0, 4.2);          // chest warmth
  const presence = biquad(actx, 'peaking', 2550, 1.2, clamp(dr * 3.0 - 0.5, 1.6, 5)); // presence
  const hp = biquad(actx, 'highpass', 140, 0.7);
  const lp = biquad(actx, 'lowpass', 5000, 0.7);
  const drv = shaper(actx, saturationCurve(1.25 * dr, 0.32), '2x');
  const bodyGain = gain(actx, 1.5 * level);
  for (const f of fs) f.g.connect(throat);
  series(throat, presence, hp, lp, drv, bodyGain).connect(out);

  /* ---- tremolo (pain / death gargle) ----------------------------- */
  let trem = null;
  if (spec.tremolo) {
    trem = actx.createOscillator();
    trem.type = 'sine';
    trem.frequency.value = spec.tremolo * rng.range(0.85, 1.15);
    const tg = gain(actx, 0.35);
    trem.connect(tg);
    tg.connect(bodyGain.gain);
    trem.start(t0);
    trem.stop(t0 + total + 0.4);
  }

  /* ---- per-syllable automation ----------------------------------- */
  // Declination: across a spoken phrase the pitch drifts gently DOWN, and a
  // voice that holds a flat baseline across syllables is a classic robot tell.
  // Applied only where it won't fight the authored contour — skip it when the
  // bark is meant to climb (a panicked yell), is a single syllable, or is the
  // death line (which collapses on its own).
  const nSyl = spec.syl.length;
  const rising = spec.syl[nSyl - 1].p >= spec.syl[0].p;
  const declines = !spec.dying && !rising && nSyl > 1;
  const declAt = (i) => (declines ? 1 - 0.07 * (i / (nSyl - 1)) : 1);

  let t = t0;
  src.frequency.setValueAtTime(f0 * spec.syl[0].p * declAt(0), t0);
  for (let i = 0; i < spec.syl.length; i++) {
    const s = spec.syl[i];
    const v = VOWELS[s.v] ?? VOWELS.a;
    const amp = s.a * 0.5;

    /* onset consonant, mixed straight to the output */
    if (s.on) {
      // Onsets lead the vowel; never let that run off the start of the timeline.
      const ct = Math.max(t - (s.on === 'f' ? 0.055 : 0.018), 0);
      const cs = bank.source('white', rng, rng.range(0.9, 1.3));
      const cbp = biquad(actx, s.on === 'f' ? 'bandpass' : 'highpass',
        s.on === 'f' ? rng.range(3800, 6500) : rng.range(1400, 2600),
        s.on === 'f' ? 1.1 : 0.7);
      const cg = gain(actx, 0);
      series(cs, cbp, cg).connect(out);
      if (s.on === 'f') {
        ad(cg.gain, ct, 0.1 * level, 0.012, 0.05);
        cs.start(ct, cs._offset, 0.12);
      } else if (s.on === 'n') {
        // Nasal: hum through a low formant instead of a burst.
        ad(cg.gain, ct, 0.02 * level, 0.01, 0.04);
        cs.start(ct, cs._offset, 0.08);
        fs[0].bp.frequency.setValueAtTime(260 * tract, ct);
      } else {
        hit(cg.gain, ct, 0.16 * level, 0.014);
        cs.start(ct, cs._offset, 0.05);
      }
    }

    /* formant glide into this vowel — 35 ms transition reads as articulation */
    for (let k = 0; k < 3; k++) {
      const f = v[k] * tract * (1 + rng.range(-0.02, 0.02));
      const bw = v[k + 3];
      fs[k].bp.frequency.setTargetAtTime(f, Math.max(t - 0.03, t0), 0.014);
      fs[k].bp.Q.setTargetAtTime(clamp((f / bw) * qScale, 1.5, 14), Math.max(t - 0.03, t0), 0.02);
    }

    /* pitch contour: rise into the stressed syllable, sag at the end */
    const pTarget = f0 * s.p * declAt(i);
    src.frequency.setTargetAtTime(pTarget, t, 0.03);
    if (spec.dying && i === spec.syl.length - 1) {
      sweep(src.frequency, t + 0.05, pTarget, pTarget * 0.45, s.d);
    } else {
      src.frequency.setTargetAtTime(pTarget * 0.94, t + s.d * 0.6, 0.06);
    }

    /* amplitude: fast onset, held, quick release; last syllable decays longer */
    const last = i === spec.syl.length - 1;
    const rel = last ? (spec.dying ? s.d * 0.9 : 0.055) : 0.028;
    adsr(srcGain.gain, t, amp * level, 0.014, s.d * 0.22, s.d * 0.5, 0.72, rel);
    ad(noiseGain.gain, t, amp * breathLevel * level, 0.02, s.d + rel);

    t += s.d + (s.g ?? 0);
  }

  /* ---- dying exhale ---------------------------------------------- */
  if (spec.dying) {
    const et = t + 0.05;
    const es = bank.source('white', rng, rng.range(0.6, 0.9));
    const ebp = biquad(actx, 'bandpass', 700, 0.55);
    const eg = gain(actx, 0);
    series(es, ebp, eg).connect(out);
    sweep(ebp.frequency, et, 900, 380, 0.6);
    ad(eg.gain, et, 0.16 * level, 0.08, 0.6);
    es.start(et, es._offset, 0.9);
    t = et + 0.7;
  }

  const end = t + 0.35;
  const srcStart = Math.max(t0 - 0.01, 0);
  src.start(srcStart);
  src.stop(end);
  noise.start(srcStart, noise._offset, end - srcStart + 0.05);

  /* ---- radio treatment (squad comms) ----------------------------- */
  if (o.radio) {
    const rbp1 = biquad(actx, 'highpass', 420, 0.8);
    const rbp2 = biquad(actx, 'lowpass', 3200, 0.9);
    const rdrv = shaper(actx, saturationCurve(7, 0.3), '2x');
    const rg = gain(actx, 1.1);
    const radioOut = gain(actx, 1);
    series(out, rbp1, rbp2, rdrv, rg).connect(radioOut);
    // Squelch click at both ends of the transmission.
    for (const st of [Math.max(t0 - 0.05, 0), end - 0.2]) {
      const cs = bank.source('white', rng, 1.1);
      const cbp = biquad(actx, 'bandpass', 2600, 1.6);
      const cg = gain(actx, 0);
      series(cs, cbp, cg).connect(radioOut);
      hit(cg.gain, st, 0.09, 0.03);
      cs.start(st, cs._offset, 0.06);
    }
    return { node: radioOut, end: end + 0.1, send: 0.05 };
  }

  return { node: out, end: end + 0.1, send: 0.45 };
}

/** Pick a plausible bark for an AI event without the ai agent knowing our list. */
export function barkFor(kind, rng) {
  switch (kind) {
    case 'spot': return rng.float() < 0.5 ? 'contact' : 'spotted';
    case 'reload': return 'reloading';
    case 'grenade': return 'grenade';
    case 'flank': return 'flanking';
    case 'suppress': return 'suppressing';
    case 'advance': return 'moveup';
    case 'hurt': return rng.float() < 0.5 ? 'hit' : 'pain';
    case 'death': return 'death';
    case 'copy': return 'copy';
    default: return 'contact';
  }
}
