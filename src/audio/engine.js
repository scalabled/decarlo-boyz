/**
 * AUDIO / VEHICLE ENGINES
 *
 * A physical-ish engine model, not a pitch-shifted sample. The whole thing is
 * built from what an internal combustion engine actually radiates:
 *
 *   1. EXHAUST — a periodic pressure wave at the *cycle* frequency
 *      f_cycle = rpm / 120 (a four-stroke completes one cycle every two
 *      revolutions). Every partial of that wave is an engine ORDER: harmonic k
 *      of f_cycle is order k/2. A cylinder fires once per cycle, so an engine
 *      with C cylinders has its dominant order at C/2 — order 4 for a V8,
 *      order 3 for an inline six, order 2 for an inline four. THAT is what
 *      makes the eight classes sound like different machines rather than the
 *      same machine at different pitches:
 *
 *        Ironside 440   crossplane V8   order 4 + strong HALF orders  -> burble
 *        Peregrine GT   flat-plane V8   order 4, half orders killed   -> flat wail
 *        Slagbolt       inline 4 @13k   order 2, huge upper content   -> scream
 *        Millhand 6     inline 6 diesel order 3, low, huge combustion -> lug
 *
 *      The half orders are the crossplane V8's signature: its crank fires two
 *      cylinders on the same bank back to back, so each bank's pulse train
 *      repeats only once per two revolutions. Set `halfLevel` to 0.55 and you
 *      get a Detroit V8; set it to 0.06 and you get a Ferrari.
 *
 *   2. COMBUSTION NOISE — broadband, gated by the firing pulse train. This is
 *      the clatter of a diesel and the chuff of an idle. Without it an engine
 *      is a synth pad; with it, it has a mechanism.
 *
 *   3. INDUCTION — noise through a resonant band that tracks rpm and opens
 *      with throttle: the airbox roar.
 *
 *   4. TURBO / BLOWER — a whistle locked to a multiple of crank speed, with
 *      boost that lags load, plus a blow-off chuff when the throttle shuts.
 *
 *   5. TRANSMISSION — a mesh whine at gear-tooth frequency, level tracking
 *      load, pitch changing with the selected gear.
 *
 * Load-dependent timbre is deliberately produced FOUR different ways, because
 * a single crossfade is audible as a crossfade:
 *   - three PeriodicWaves (idle / on-power / overrun) blended by load,
 *   - a muffler lowpass that opens with throttle,
 *   - pre-drive gain into a saturator, so the pipe distorts under load,
 *   - combustion and intake noise levels.
 * Measured: spectral centroid at a fixed 3000 rpm moves by more than an octave
 * between closed and full throttle (see src/audio/bench.js `engineLoad`).
 *
 * Every oscillator's frequency is driven from ONE ConstantSourceNode carrying
 * f_cycle through per-partial gain multipliers. One parameter write per frame
 * per vehicle moves the entire engine, and doppler is a single multiply that is
 * automatically coherent across every partial.
 */

import {
  biquad, clamp, gain, hit, lerp, osc, pulseWave, saturationCurve, series, shaper,
  struckResonator, to,
} from './dsp.js';

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} EngineProfile
 * @property {number} mainOrder   dominant engine order (cylinders / 2)
 * @property {number} halfLevel   level of half orders — the crossplane burble
 * @property {number} interLevel  level of integer orders that are not multiples
 *                                of mainOrder
 * @property {number} mainBoost   reinforcement on multiples of mainOrder
 * @property {number} disperse    phase dispersion; 0 = a hard impulse train
 *                                (open header), 1 = smeared (long muffler)
 * @property {number[]} tilt      spectral rolloff exponent [idle, load, over]
 * @property {object[]} pipe      exhaust resonances {f, q, g(dB)}
 * @property {number[]} muffler   lowpass cutoff at closed / full throttle
 * @property {number[]} drive     saturator input gain at closed / full throttle
 */
export const ENGINE_PROFILES = {
  /* Peregrine GT — flat-plane V8. Even firing across both banks kills the half
     orders, so it is a hard flat wail that climbs forever. Short pipes. */
  sports: {
    label: 'flat-plane V8', mainOrder: 4, K: 110,
    halfLevel: 0.06, interLevel: 0.20, mainBoost: 2.6, disperse: 0.35,
    tilt: [2.5, 1.05, 1.75],
    pipe: [{ f: 175, q: 1.5, g: 6 }, { f: 780, q: 1.8, g: 5 }, { f: 2400, q: 1.2, g: 3 }],
    muffler: [1700, 8600], drive: [1.1, 5.2], level: 0.90,
    idle: 900, redline: 7400,
    combustion: { level: 0.13, f: 2200, q: 0.7, duty: 0.09 },
    intake: { level: 0.34, f: 380, q: 1.5, track: 0.6 },
    turbo: null, blower: null,
    trans: { level: 0.075, mesh: 11.5 },
    pop: 0.55, lope: 0.05, sub: 0.55,
  },

  /* Ironside 440 — crossplane big-block. Half orders at 0.55 give the lope and
     the burble; the muffler stays shut so it is all chest and no top end. */
  muscle: {
    label: 'crossplane V8', mainOrder: 4, K: 96,
    halfLevel: 0.55, interLevel: 0.38, mainBoost: 2.2, disperse: 0.72,
    tilt: [3.1, 1.35, 2.0],
    pipe: [{ f: 92, q: 1.1, g: 9 }, { f: 250, q: 1.7, g: 6 }, { f: 620, q: 2.4, g: 3.5 }],
    muffler: [1100, 5200], drive: [1.5, 7.0], level: 1.16,
    idle: 750, redline: 5900,
    combustion: { level: 0.20, f: 1400, q: 0.6, duty: 0.13 },
    intake: { level: 0.40, f: 300, q: 1.2, track: 0.5 },
    turbo: null,
    blower: { ratio: 2.35, level: 0.115, f: 3200, q: 5 },
    trans: { level: 0.05, mesh: 8.5 },
    pop: 1.0, lope: 0.85, sub: 1.0,
  },

  /* Allegheny 4dr — transverse V6, twin mufflers, resonator in the pipe. The
     traffic default: deliberately characterless, which is its character. */
  sedan: {
    label: 'V6', mainOrder: 3, K: 72,
    halfLevel: 0.10, interLevel: 0.26, mainBoost: 1.9, disperse: 0.85,
    tilt: [3.4, 1.8, 2.4],
    pipe: [{ f: 130, q: 1.3, g: 5 }, { f: 430, q: 2.0, g: 3 }],
    muffler: [900, 3400], drive: [1.0, 3.0], level: 0.62,
    idle: 800, redline: 6300,
    combustion: { level: 0.09, f: 1600, q: 0.8, duty: 0.10 },
    intake: { level: 0.20, f: 340, q: 1.6, track: 0.55 },
    turbo: null, blower: null,
    trans: { level: 0.04, mesh: 10.5 },
    pop: 0.10, lope: 0.10, sub: 0.5,
  },

  /* Foundry Van — 2.5 turbodiesel inline four. Hard combustion clatter, low
     redline, audible spool and a blow-off chuff on every lift. */
  van: {
    label: 'turbodiesel I4', mainOrder: 2, K: 80,
    halfLevel: 0.22, interLevel: 0.44, mainBoost: 2.0, disperse: 0.6,
    tilt: [2.9, 1.7, 2.2],
    pipe: [{ f: 118, q: 1.2, g: 6 }, { f: 340, q: 1.9, g: 4 }, { f: 1150, q: 2.5, g: 2.5 }],
    muffler: [1000, 3800], drive: [1.4, 4.2], level: 0.86,
    idle: 720, redline: 4400,
    combustion: { level: 0.92, f: 2600, q: 0.5, duty: 0.055 },
    intake: { level: 0.16, f: 300, q: 1.3, track: 0.4 },
    turbo: { ratio: 6.2, level: 0.075, f: 3600, q: 9, hiss: 0.05, spool: 1.1 },
    blower: null,
    trans: { level: 0.10, mesh: 7.5 },
    pop: 0.06, lope: 0.30, sub: 0.85,
  },

  /* Millhand 6 — 12 litre inline six through a vertical stack. Order 3 at
     1500 rpm is 75 Hz, so almost all of its energy is below 400 Hz; what you
     hear above that is combustion clatter, straight-cut gears and the turbo. */
  truck: {
    label: 'turbodiesel I6', mainOrder: 3, K: 96,
    halfLevel: 0.16, interLevel: 0.42, mainBoost: 2.3, disperse: 0.5,
    tilt: [2.4, 1.25, 1.9],
    pipe: [{ f: 74, q: 1.0, g: 10 }, { f: 205, q: 1.5, g: 6 }, { f: 560, q: 2.2, g: 4 }],
    muffler: [1300, 4600], drive: [1.6, 5.0], level: 1.15,
    idle: 620, redline: 2900,
    combustion: { level: 1.25, f: 2200, q: 0.45, duty: 0.05 },
    intake: { level: 0.24, f: 210, q: 1.1, track: 0.35 },
    turbo: { ratio: 5.4, level: 0.16, f: 3100, q: 11, hiss: 0.09, spool: 1.9 },
    blower: null,
    trans: { level: 0.26, mesh: 5.2 },
    pop: 0.04, lope: 0.42, sub: 1.35,
  },

  /* Precinct Cruiser — police-package crossplane V8. Half orders present but
     tamed, dual exhaust, and a brighter top than the Ironside so you can pick
     it out of traffic behind you. */
  police: {
    label: 'police V8', mainOrder: 4, K: 100,
    halfLevel: 0.34, interLevel: 0.28, mainBoost: 2.4, disperse: 0.55,
    tilt: [2.8, 1.2, 1.85],
    pipe: [{ f: 128, q: 1.3, g: 7 }, { f: 520, q: 2.0, g: 4.5 }, { f: 1800, q: 1.4, g: 2.5 }],
    muffler: [1500, 6800], drive: [1.2, 5.6], level: 1.0,
    idle: 780, redline: 6600,
    combustion: { level: 0.15, f: 1900, q: 0.7, duty: 0.10 },
    intake: { level: 0.32, f: 360, q: 1.4, track: 0.55 },
    turbo: null, blower: null,
    trans: { level: 0.09, mesh: 9.5 },
    pop: 0.4, lope: 0.35, sub: 0.8,
  },

  /* Slagbolt — 13,000 rpm inline four. Order 2 at redline is 433 Hz and the
     upper orders run to 8 kHz, so almost nothing rolls off: it is a scream, and
     an open airbox roars over the top of it under throttle. */
  bike: {
    label: 'inline 4 superbike', mainOrder: 2, K: 128,
    halfLevel: 0.09, interLevel: 0.17, mainBoost: 2.8, disperse: 0.2,
    tilt: [2.0, 0.72, 1.45],
    pipe: [{ f: 320, q: 1.4, g: 6 }, { f: 1250, q: 1.7, g: 5 }, { f: 3600, q: 1.1, g: 4 }],
    muffler: [2600, 12000], drive: [1.1, 6.4], level: 0.78,
    idle: 1300, redline: 13000,
    combustion: { level: 0.10, f: 3400, q: 0.7, duty: 0.08 },
    intake: { level: 0.85, f: 900, q: 1.8, track: 0.8 },
    turbo: null, blower: null,
    trans: { level: 0.13, mesh: 6.5 },
    pop: 0.8, lope: 0.02, sub: 0.22,
  },

  /* Riverjack — outboard V6 exhausting through the hub, under water. At idle
     the note is drowned and gurgling; on the plane the prop clears and it
     opens up. The water damping is applied by vehicles.js from hull speed. */
  boat: {
    label: 'outboard V6', mainOrder: 3, K: 64,
    halfLevel: 0.20, interLevel: 0.34, mainBoost: 2.0, disperse: 0.9,
    tilt: [3.0, 1.5, 2.2],
    pipe: [{ f: 105, q: 1.2, g: 7 }, { f: 300, q: 1.8, g: 4 }],
    muffler: [520, 4200], drive: [1.3, 4.6], level: 0.82,
    idle: 850, redline: 6000,
    combustion: { level: 0.24, f: 1200, q: 0.55, duty: 0.11 },
    intake: { level: 0.26, f: 320, q: 1.3, track: 0.5 },
    turbo: null, blower: null,
    trans: { level: 0.03, mesh: 4.0 },
    pop: 0.15, lope: 0.25, sub: 1.1,
  },
};

/** Anything we do not recognise drives like a sedan and should sound like one. */
export function resolveEngine(kind) {
  if (!kind) return ENGINE_PROFILES.sedan;
  const k = String(kind).toLowerCase();
  if (ENGINE_PROFILES[k]) return ENGINE_PROFILES[k];
  if (/bike|moto|slag/.test(k)) return ENGINE_PROFILES.bike;
  if (/truck|mill|lorry|rig/.test(k)) return ENGINE_PROFILES.truck;
  if (/van|foundry/.test(k)) return ENGINE_PROFILES.van;
  if (/cop|police|cruiser|precinct/.test(k)) return ENGINE_PROFILES.police;
  if (/muscle|ironside/.test(k)) return ENGINE_PROFILES.muscle;
  if (/sport|peregrine|super/.test(k)) return ENGINE_PROFILES.sports;
  if (/boat|river|jack/.test(k)) return ENGINE_PROFILES.boat;
  return ENGINE_PROFILES.sedan;
}

/* ------------------------------------------------------------------ */
/* Order spectra                                                       */
/* ------------------------------------------------------------------ */

/** Per-variant multipliers on the profile's own order levels. */
const VARIANTS = {
  // Cold, closed throttle: dull, half orders relatively loud (that is the lope).
  idle: { ti: 0, half: 1.7, inter: 1.05, main: 0.75 },
  // Wide open: bright, firing order dominant, half orders masked.
  load: { ti: 1, half: 0.45, inter: 0.85, main: 1.30 },
  // Trailing throttle: no combustion energy at the firing order, so the note
  // hollows out and the pumping (half and inter) orders come forward.
  over: { ti: 2, half: 1.35, inter: 1.45, main: 0.50 },
};

const WAVE_CACHE = new WeakMap();

/**
 * Build the PeriodicWave for one profile/variant. Harmonic k of the wave is
 * engine order k/2, so half orders are the odd harmonics.
 */
export function orderWave(actx, profile, variant) {
  let byCtx = WAVE_CACHE.get(actx);
  if (!byCtx) WAVE_CACHE.set(actx, (byCtx = new Map()));
  const key = `${profile.label}:${variant}`;
  let w = byCtx.get(key);
  if (w) return w;

  const v = VARIANTS[variant];
  const tilt = profile.tilt[v.ti];
  const m = profile.mainOrder;
  const K = Math.min(profile.K ?? 96, 512);
  const real = new Float32Array(K + 1);
  const imag = new Float32Array(K + 1);

  for (let k = 1; k <= K; k++) {
    const order = k / 2;
    const isHalf = (k & 1) === 1;
    const rel = order / m;

    // Spectral envelope of the pipe: flat to the firing order, then rolls off.
    let a = 1 / (1 + Math.pow(rel, tilt));

    if (isHalf) {
      a *= profile.halfLevel * v.half;
    } else if (Math.abs(order / m - Math.round(order / m)) < 1e-9) {
      a *= profile.mainBoost * v.main;
    } else {
      a *= profile.interLevel * v.inter;
    }

    // Displacement: big engines put real energy below the firing order.
    if (order < m) a *= lerp(1, profile.sub ?? 0.7, 1 - order / m);

    // Dispersive phase. A straight pipe delays high frequencies less than the
    // Helmholtz-loaded low end, which smears the impulse into a note instead of
    // a click. k^1.3 is the shape that stops it sounding like a buzzer.
    const phase = profile.disperse * Math.pow(k, 1.3) * 0.55;
    real[k] = a * Math.cos(phase);
    imag[k] = a * Math.sin(phase);
  }

  w = actx.createPeriodicWave(real, imag, { disableNormalization: false });
  byCtx.set(key, w);
  return w;
}

/* ------------------------------------------------------------------ */
/* Voice                                                               */
/* ------------------------------------------------------------------ */

const IDLE_SMOOTH = 0.035;

/**
 * Global scale on every engine. `profile.level` is the RELATIVE balance between
 * the eight classes and should be read as "how loud is a Millhand next to a
 * Peregrine"; this is the one number that decides how loud engines are next to
 * everything else in the game. Set from the bench: at 0.24 a single vehicle at
 * full throttle solos at about -10 dBFS peak, which leaves the room the rest of
 * the mix needs.
 */
const ENGINE_TRIM = 0.24;

/**
 * One running engine. Built once per active vehicle and reused from a pool —
 * `setState` is the only thing called per frame and it allocates nothing.
 *
 * Connect `out` wherever you want it; the voice knows nothing about panning,
 * distance or reverb, which is what lets the same code serve the player's own
 * car (dry, in-cabin EQ) and thirty metres of traffic (spatialised).
 */
export class EngineVoice {
  /**
   * @param {BaseAudioContext} actx
   * @param {import('./dsp.js').NoiseBank} bank
   * @param {object} rng
   * @param {EngineProfile} profile
   * @param {boolean} full  false builds the cheap LOD voice for distant traffic
   */
  constructor(actx, bank, rng, profile, full = true) {
    this.actx = actx;
    this.bank = bank;
    this.rng = rng;
    this.profile = profile;
    this.full = full;
    this.nodes = [];
    this.running = false;

    this.out = gain(actx, 0);
    this.popOut = gain(actx, 1);
    this.popOut.connect(this.out);

    /* ---- the crank: one source of truth for every partial --------- */
    // offset carries f_cycle = rpm / 120, already multiplied by doppler.
    const rev = actx.createConstantSource();
    rev.offset.value = profile.idle / 120;
    this.rev = rev;
    this.nodes.push(rev);

    /* ---- exhaust: three order spectra crossfaded by load ---------- */
    const exhaust = gain(actx, 1);
    this.blend = {};
    for (const variant of ['idle', 'load', 'over']) {
      const o = actx.createOscillator();
      o.setPeriodicWave(orderWave(actx, profile, variant));
      o.frequency.value = 0;                 // driven entirely by `rev`
      rev.connect(o.frequency);
      const g = gain(actx, variant === 'idle' ? 1 : 0);
      o.connect(g);
      g.connect(exhaust);
      o.start(0);
      this.blend[variant] = g;
      this.nodes.push(o, g);
    }

    /* ---- combustion: broadband, gated by the firing pulse train ---- */
    if (full) {
      const c = profile.combustion;
      const src = bank.source('white', rng, rng.range(0.85, 1.2), true);
      const bp = biquad(actx, 'bandpass', c.f, c.q);
      const gate = gain(actx, 0);          // base level, AM'd by the pulse
      const pulse = osc(actx, 'sine', 0);
      pulse.setPeriodicWave(pulseWave(actx, c.duty, 28));
      // Firing frequency = mainOrder x rpm/60 = mainOrder x 2 x f_cycle.
      const mul = gain(actx, profile.mainOrder * 2);
      rev.connect(mul);
      mul.connect(pulse.frequency);
      const depth = gain(actx, 0);
      pulse.connect(depth);
      depth.connect(gate.gain);
      series(src, bp, gate).connect(exhaust);
      src.start(0, src._offset);
      pulse.start(0);
      this._combGate = gate;
      this._combDepth = depth;
      this._combBP = bp;
      this.nodes.push(src, bp, gate, pulse, mul, depth);
    }

    /* ---- pipe resonances + muffler + saturation -------------------- */
    let tail = exhaust;
    for (const p of profile.pipe) {
      const f = biquad(actx, 'peaking', p.f, p.q, p.g);
      tail.connect(f);
      tail = f;
      this.nodes.push(f);
    }
    const preDrive = gain(actx, profile.drive[0]);
    const drv = shaper(actx, saturationCurve(3.2, 0.55), '2x');
    const muffler = biquad(actx, 'lowpass', profile.muffler[0], 0.8);
    const rumbleHP = biquad(actx, 'highpass', 26, 0.6);
    // Rev limiter: ignition cut chops the exhaust at ~15 Hz. Base gain plus a
    // square LFO whose depth is only raised on the limiter.
    const limit = gain(actx, 1);
    const limOsc = osc(actx, 'square', 15.5);
    const limDepth = gain(actx, 0);
    limOsc.connect(limDepth);
    limDepth.connect(limit.gain);
    limOsc.start(0);
    const exhaustGain = gain(actx, 1);
    series(tail, preDrive, drv, muffler, rumbleHP, limit, exhaustGain).connect(this.out);
    this._preDrive = preDrive;
    this._muffler = muffler;
    this._limit = limit;
    this._limDepth = limDepth;
    this._exhaustGain = exhaustGain;
    this.nodes.push(preDrive, drv, muffler, rumbleHP, limit, limOsc, limDepth, exhaustGain);

    /* ---- induction roar -------------------------------------------- */
    if (full) {
      const i = profile.intake;
      const src = bank.source('pink', rng, rng.range(0.9, 1.15), true);
      const bp = biquad(actx, 'bandpass', i.f, i.q);
      const g = gain(actx, 0);
      series(src, bp, g).connect(this.out);
      src.start(0, src._offset);
      this._intakeBP = bp;
      this._intakeGain = g;
      this.nodes.push(src, bp, g);
    }

    /* ---- forced induction ------------------------------------------ */
    if (full && profile.turbo) {
      const t = profile.turbo;
      const o = osc(actx, 'sawtooth', 0);
      const mul = gain(actx, t.ratio * 2);
      rev.connect(mul);
      mul.connect(o.frequency);
      const bp = biquad(actx, 'bandpass', t.f, t.q);
      const g = gain(actx, 0);
      series(o, bp, g).connect(this.out);
      o.start(0);
      // Compressor hiss rides with boost and is what sells a big turbo.
      const hs = bank.source('white', rng, 1, true);
      const hbp = biquad(actx, 'bandpass', 5200, 1.1);
      const hg = gain(actx, 0);
      series(hs, hbp, hg).connect(this.out);
      hs.start(0, hs._offset);
      this._turbo = { g, bp, hg, spec: t };
      this.nodes.push(o, mul, bp, g, hs, hbp, hg);
    }
    if (full && profile.blower) {
      const b = profile.blower;
      const o = osc(actx, 'sawtooth', 0);
      const mul = gain(actx, b.ratio * 2);
      rev.connect(mul);
      mul.connect(o.frequency);
      const bp = biquad(actx, 'bandpass', b.f, b.q);
      const g = gain(actx, 0);
      series(o, bp, g).connect(this.out);
      o.start(0);
      this._blower = { g, spec: b };
      this.nodes.push(o, mul, bp, g);
    }

    /* ---- transmission whine ---------------------------------------- */
    if (full && profile.trans.level > 0) {
      const o = osc(actx, 'triangle', 0);
      const mul = gain(actx, profile.trans.mesh * 2);
      rev.connect(mul);
      mul.connect(o.frequency);
      const bp = biquad(actx, 'bandpass', 2200, 2.2);
      const g = gain(actx, 0);
      series(o, bp, g).connect(this.out);
      o.start(0);
      this._trans = { o, mul, g };
      this.nodes.push(o, mul, bp, g);
    }

    rev.start(0);

    /* ---- per-frame state (never reallocated) ----------------------- */
    this.gear = 1;
    this.rpm = profile.idle;
    this.throttle = 0;
    this.boost = 0;
    this.lopePhase = rng.range(0, 6.283);
    this.popTimer = 0;
    this._shiftUntil = -1;
    this._muffle = 1;      // extra damping, 1 = clear (boats under water use it)
    this._level = 1;
    this._prevRpm = profile.idle;
  }

  /** Fade the voice in. Idempotent. */
  start(level = 1) {
    this._level = level;
    this.running = true;
    to(this.out.gain, level * this.profile.level * ENGINE_TRIM, this.actx.currentTime, 0.06);
  }

  /** Fade out; the caller returns the voice to the pool after ~0.3 s. */
  stop() {
    this.running = false;
    to(this.out.gain, 0, this.actx.currentTime, 0.08);
  }

  setLevel(level) {
    this._level = level;
    if (this.running) to(this.out.gain, level * this.profile.level * ENGINE_TRIM, this.actx.currentTime, 0.05);
  }

  /**
   * Damping applied by the world: 1 = open air, 0.15 = an outboard's exhaust
   * under water, ~0.5 = heard from inside a closed cabin.
   */
  setMuffle(v) {
    this._muffle = clamp(v, 0.05, 1);
  }

  /**
   * The per-frame update. `s` is the `vehicle:engine` payload plus a doppler
   * ratio; nothing here allocates.
   */
  setState(s, dt, dopplerRatio = 1) {
    const p = this.profile;
    const actx = this.actx;
    const t = actx.currentTime;

    const redline = s.redline ?? p.redline;
    const idleRpm = s.idle ?? p.idle;
    let rpm = clamp(s.rpm ?? idleRpm, idleRpm * 0.35, redline * 1.12);
    const throttle = clamp(s.throttle ?? 0, 0, 1);
    // `load` may arrive signed (negative on the overrun). Treat the sign as the
    // thing that matters and fall back to throttle when it is absent.
    const rawLoad = s.load === undefined ? throttle : s.load;
    const rpmN = clamp((rpm - idleRpm) / Math.max(redline - idleRpm, 1), 0, 1.1);

    /* ---- idle lope: uneven combustion wobbles the crank ------------ */
    if (p.lope > 0.01 && rpm < idleRpm * 1.5) {
      this.lopePhase += dt * 6.6;
      const wob = Math.sin(this.lopePhase) * 0.5 + Math.sin(this.lopePhase * 0.37 + 1.1) * 0.5;
      rpm *= 1 + wob * 0.028 * p.lope * (1 - rpmN * 2);
    }
    this.rpm = rpm;

    /* ---- the crank ------------------------------------------------- */
    to(this.rev.offset, (rpm / 120) * dopplerRatio, t, IDLE_SMOOTH);

    /* ---- load blend ------------------------------------------------ */
    const overrun = clamp((0.16 - throttle) * 6, 0, 1) * clamp((rpm / idleRpm - 1.45) * 1.2, 0, 1) *
      clamp(rawLoad < 0 ? 1 : 0.75, 0, 1);
    const power = clamp(throttle * (0.5 + 0.5 * rpmN), 0, 1) * (1 - overrun * 0.85);
    const idleW = clamp(1 - power - overrun, 0, 1);
    const sm = 0.05;
    to(this.blend.idle.gain, idleW, t, sm);
    to(this.blend.load.gain, power, t, sm);
    to(this.blend.over.gain, overrun, t, sm);

    /* ---- muffler + saturation: the load-timbre lever ---------------- */
    const open = clamp(throttle * 0.75 + rpmN * 0.45, 0, 1);
    to(this._muffler.frequency,
      clamp(lerp(p.muffler[0], p.muffler[1], open) * this._muffle, 60, 19000), t, 0.05);
    to(this._preDrive.gain, lerp(p.drive[0], p.drive[1], clamp(throttle * 0.85 + rpmN * 0.3, 0, 1)), t, 0.05);

    // Exhaust level: a closed throttle at 6000 rpm is far quieter than an open
    // one, which is the single most important dynamic in a driving mix.
    const lvl = (0.30 + 0.70 * throttle) * (0.55 + 0.55 * rpmN) * (1 - overrun * 0.30);
    to(this._exhaustGain.gain, lvl, t, 0.04);

    /* ---- rev limiter ----------------------------------------------- */
    const overRev = clamp((rpm - redline * 0.985) / (redline * 0.05), 0, 1);
    to(this._limDepth.gain, overRev * 0.55, t, 0.012);
    to(this._limit.gain, 1 - overRev * 0.55, t, 0.012);

    /* ---- combustion ------------------------------------------------ */
    if (this._combGate) {
      const c = p.combustion;
      // Clatter is loudest under load and at low rpm, where the individual
      // firings are still resolvable events rather than a tone.
      const cl = c.level * (0.45 + 0.75 * throttle) * (1.25 - 0.5 * rpmN) * this._muffle;
      to(this._combGate.gain, cl * 0.55, t, 0.05);
      to(this._combDepth.gain, cl * 0.9, t, 0.05);
      to(this._combBP.frequency, clamp(c.f * (0.75 + 0.55 * open), 100, 16000), t, 0.06);
    }

    /* ---- induction -------------------------------------------------- */
    if (this._intakeGain) {
      const i = p.intake;
      to(this._intakeGain.gain, i.level * throttle * (0.25 + 0.9 * rpmN) * this._muffle, t, 0.05);
      to(this._intakeBP.frequency,
        clamp(i.f * (1 + rpmN * 2.6 * i.track), 60, 16000), t, 0.06);
    }

    /* ---- boost ------------------------------------------------------ */
    if (this._turbo) {
      const spec = this._turbo.spec;
      // First-order spool: boost chases load, slowly, and bleeds off fast.
      const target = clamp(throttle * (0.25 + 0.9 * rpmN), 0, 1);
      const k = target > this.boost ? dt / Math.max(spec.spool, 0.05) : dt * 4.5;
      this.boost += (target - this.boost) * clamp(k, 0, 1);
      to(this._turbo.g.gain, spec.level * Math.pow(this.boost, 0.7) * this._muffle, t, 0.05);
      to(this._turbo.hg.gain, (spec.hiss ?? 0) * this.boost * this._muffle, t, 0.06);
      to(this._turbo.bp.frequency, clamp(spec.f * (0.7 + 0.6 * this.boost), 200, 16000), t, 0.08);
    }
    if (this._blower) {
      // A blower is crank-driven: it screams with rpm, not with boost.
      to(this._blower.g.gain,
        this._blower.spec.level * (0.15 + 0.95 * rpmN) * (0.35 + 0.65 * throttle) * this._muffle, t, 0.05);
    }

    /* ---- transmission ---------------------------------------------- */
    if (this._trans) {
      const gearN = Math.max(1, s.gear ?? this.gear);
      // Lower gears mesh faster relative to the crank.
      this._trans.mul.gain.setTargetAtTime(
        p.trans.mesh * 2 * (1 + Math.max(0, 4 - gearN) * 0.28), t, 0.08);
      const whine = p.trans.level * clamp(Math.abs(rawLoad) * 0.7 + 0.3, 0, 1) *
        (0.2 + 0.8 * rpmN) * this._muffle;
      to(this._trans.g.gain, whine, t, 0.06);
    }

    /* ---- gear change ------------------------------------------------ */
    const gear = s.gear ?? this.gear;
    if (gear !== this.gear) {
      this._shift(gear > this.gear, throttle, rpmN, t);
      this.gear = gear;
    }

    /* ---- exhaust pops on the overrun -------------------------------- */
    if (p.pop > 0.02 && overrun > 0.35 && rpm > idleRpm * 2.2) {
      this.popTimer -= dt * (2 + rpmN * 9) * overrun;
      if (this.popTimer <= 0) {
        this.popTimer = this.rng.range(0.35, 1.4);
        this._pop(t + this.rng.range(0, 0.05), p.pop * this.rng.range(0.4, 1) * overrun);
      }
    }
    this._prevRpm = rpm;
  }

  /**
   * The torque interrupt. A real upshift is: throttle closes, clutch drops the
   * driveline, revs fall, clutch bites, load slams back on. Half a beat of
   * silence in the middle of full throttle is the whole effect.
   */
  _shift(up, throttle, rpmN, t) {
    const p = this.profile;
    const dur = up ? 0.11 : 0.09;
    const cut = up ? 0.24 + throttle * 0.45 : 0.16;
    const g = this._exhaustGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(g.value, 0.02), t);
    g.linearRampToValueAtTime(Math.max(0.02, g.value * (1 - cut)), t + 0.012);
    g.linearRampToValueAtTime(Math.max(0.02, g.value), t + dur);
    // Mechanical: the selector and the driveline taking up slack.
    struckResonator(this.actx, this.bank, this.rng, t, [
      { f: 240 * this.rng.range(0.9, 1.1), q: 9, g: 0.11, decay: 0.05 },
      { f: 760 * this.rng.range(0.9, 1.1), q: 14, g: 0.07, decay: 0.03 },
    ], 0.0022).connect(this.popOut);
    // Upshift at high load: the closed throttle dumps unburnt fuel into a hot
    // pipe. Cars that pop, pop here.
    if (up && throttle > 0.5 && p.pop > 0.1) this._pop(t + 0.055, p.pop * (0.5 + rpmN * 0.7));
    if (this._turbo && !up) this.boost *= 0.55;
    if (this._turbo && up) this._blowoff(t + 0.01);
    this._shiftUntil = t + dur;
  }

  /** Unburnt fuel igniting in the exhaust: a crack with a pipe-shaped tail. */
  _pop(t, level) {
    const { actx, bank, rng } = this;
    const src = bank.source('white', rng, rng.range(0.9, 1.3));
    const bp = biquad(actx, 'bandpass', rng.range(320, 900), 1.4);
    const g = gain(actx, 0);
    const drv = shaper(actx, saturationCurve(6, 0.7), '2x');
    series(src, bp, g, drv).connect(this.popOut);
    hit(g.gain, t, clamp(level, 0, 1) * 0.85, rng.range(0.02, 0.06));
    src.start(t, src._offset, 0.12);
    // The pipe rings after the crack.
    const r = osc(actx, 'sine', this.profile.pipe[0].f * rng.range(0.9, 1.15));
    const rg = gain(actx, 0);
    r.connect(rg); rg.connect(this.popOut);
    hit(rg.gain, t, level * 0.2, 0.09);
    r.start(t); r.stop(t + 0.16);
  }

  /** Compressor bypass valve: a short pressurised hiss when the throttle shuts. */
  _blowoff(t) {
    const spec = this._turbo?.spec;
    if (!spec || this.boost < 0.25) return;
    const { actx, bank, rng } = this;
    const src = bank.source('white', rng, 1);
    const bp = biquad(actx, 'bandpass', 2600, 1.6);
    const g = gain(actx, 0);
    series(src, bp, g).connect(this.popOut);
    hit(g.gain, t, this.boost * 0.16, 0.14);
    src.start(t, src._offset, 0.25);
    this.boost *= 0.3;
  }

  /** A pothole, a kerb, a landing: the chassis and the springs answer. */
  knock(level, t = this.actx.currentTime) {
    const l = clamp(level, 0, 1.6);
    if (l < 0.03) return;
    const { actx, bank, rng } = this;
    struckResonator(actx, bank, rng, t, [
      { f: rng.range(52, 78), q: 4, g: 0.34 * l, decay: 0.09 },
      { f: rng.range(150, 240), q: 7, g: 0.20 * l, decay: 0.06 },
      { f: rng.range(430, 700), q: 11, g: 0.09 * l, decay: 0.035 },
      { f: rng.range(1300, 2200), q: 16, g: 0.045 * l, decay: 0.02 },
    ], 0.003).connect(this.popOut);
    // Spring/damper: a short low thud that follows the knock.
    const o = osc(actx, 'sine', rng.range(38, 56));
    const g = gain(actx, 0);
    o.connect(g); g.connect(this.popOut);
    hit(g.gain, t, 0.22 * l, 0.13);
    o.start(t); o.stop(t + 0.2);
  }

  dispose() {
    for (const n of this.nodes) {
      try { n.stop?.(); } catch { /* not a source */ }
      try { n.disconnect(); } catch { /* already gone */ }
    }
    this.nodes.length = 0;
    try { this.out.disconnect(); } catch { /* noop */ }
    try { this.popOut.disconnect(); } catch { /* noop */ }
  }
}
