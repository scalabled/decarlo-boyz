/**
 * AUDIO / RADIO — six generative stations
 *
 * Every station is a piece of music being COMPOSED as you drive, not a loop
 * being played back. There is no bar of audio anywhere in this file; there is a
 * lookahead scheduler, a per-station arrangement model and a set of synthesized
 * instruments.
 *
 * The structure, top down:
 *
 *   song     32-48 bars in a key. When it ends the station picks a new key a
 *            fifth/second/minor-third away, a new progression, a new tempo
 *            within 3% and a new set of section densities. Every ~90 seconds
 *            the listener therefore hears a genuinely different piece.
 *   section  4-8 bars carrying which voices are allowed to play and how busy
 *            they are: intro / A / B / lift / break / outro. This is what stops
 *            a generative bed from being a flat wall for ten minutes.
 *   bar      one chord from the progression.
 *   step     a 16th. Every voice is asked, per step, whether it plays, with
 *            probabilities that come from the section and the beat position.
 *
 * The six voices are per-station and genuinely different synths — a garage-rock
 * guitar amp is a pair of detuned saws into a waveshaper into a cabinet
 * bandpass; a soul Rhodes is real 2-operator FM; an acid bass is a resonant
 * lowpass with a per-note envelope; a pedal steel is a portamento between chord
 * tones. Nothing is shared except the drum machine primitives.
 *
 * Scales, tempi, waveforms and roots are the canonical per-station values in
 * `STATIONS_BASE` below.
 */

import {
  ad, adsr, biquad, clamp, gain, hit, lerp, mtof, osc, saturationCurve, series, shaper,
  struckResonator, sweep, to,
} from './dsp.js';

const LOOKAHEAD = 0.45;   // seconds of music scheduled ahead of the clock
const STEPS_PER_BAR = 16;

/* ------------------------------------------------------------------ */
/* Stations                                                            */
/* ------------------------------------------------------------------ */

/**
 * `scale`, `bpm`, `wave` and `root` are each station's fixed identity.
 * Everything else is the arrangement and voicing model built on top.
 */
export const STATIONS = {
  grease: {
    id: 'grease', name: 'GREASE FM', tag: 'garage rock',
    scale: [0, 3, 5, 6, 7, 10], bpm: 110, wave: 'sawtooth', root: 45,
    swing: 0.07, level: 0.79, tone: { hp: 70, lp: 12000, tilt: 2, drive: 1.6, noise: 0.0015 },
    // Degrees (in semitones from the root) a bar can sit on, and how often the
    // progression turns. A blues turnaround with a flat-seven lift.
    progs: [[0, 0, 5, 0], [0, 0, 5, 5, 0, 0, 7, 5], [0, 10, 0, 5], [0, 0, 0, 0, 5, 5, 0, 7]],
    songBars: 32, chordKind: 'power',
  },
  gold: {
    id: 'gold', name: 'BLACK & GOLD', tag: 'soul',
    scale: [0, 2, 4, 7, 9], bpm: 88, wave: 'triangle', root: 48,
    swing: 0.19, level: 1.10, tone: { hp: 55, lp: 13500, tilt: 1, drive: 1.0, noise: 0.0008 },
    progs: [[0, 9, 5, 7], [0, 5, 9, 7], [9, 5, 0, 7], [0, 0, 5, 5, 9, 9, 7, 7]],
    songBars: 32, chordKind: 'seventh',
  },
  redline: {
    id: 'redline', name: 'REDLINE', tag: 'drum machine',
    scale: [0, 2, 3, 5, 7, 10], bpm: 116, wave: 'square', root: 43,
    swing: 0.0, level: 1.11, tone: { hp: 40, lp: 15000, tilt: 0, drive: 1.3, noise: 0.0006 },
    progs: [[0, 0, 10, 10], [0, 0, 5, 3], [0, 10, 8, 10], [0, 0, 0, 0, 5, 5, 10, 10]],
    songBars: 48, chordKind: 'stab',
  },
  slack: {
    id: 'slack', name: 'SLACKWATER', tag: 'ambient',
    scale: [0, 4, 7, 11, 14], bpm: 66, wave: 'sine', root: 52,
    swing: 0.0, level: 1.13, tone: { hp: 32, lp: 11000, tilt: -2, drive: 0.8, noise: 0.0004 },
    progs: [[0, 0, 5, 5], [0, 0, 9, 9], [0, 5, 9, 4], [0, 0, 0, 0, 7, 7, 5, 5]],
    songBars: 24, chordKind: 'pad',
  },
  furnace: {
    id: 'furnace', name: 'FURNACE 101', tag: 'industrial',
    scale: [0, 1, 5, 6, 8], bpm: 112, wave: 'sawtooth', root: 41,
    swing: 0.0, level: 0.97, tone: { hp: 45, lp: 14000, tilt: 1, drive: 2.4, noise: 0.0022 },
    progs: [[0, 0, 1, 0], [0, 0, 6, 5], [0, 1, 0, 8], [0, 0, 0, 0, 1, 1, 6, 6]],
    songBars: 32, chordKind: 'cluster',
  },
  incline: {
    id: 'incline', name: 'INCLINE AM', tag: 'old country',
    scale: [0, 2, 4, 5, 7, 9], bpm: 80, wave: 'triangle', root: 50,
    swing: 0.14, level: 2.90, tone: { hp: 260, lp: 3400, tilt: 0, drive: 1.1, noise: 0.006 },
    progs: [[0, 0, 5, 7], [0, 5, 0, 7], [0, 0, 7, 7, 5, 5, 0, 7], [0, 9, 5, 7]],
    songBars: 32, chordKind: 'open',
  },
};

export const STATION_IDS = Object.keys(STATIONS);

/**
 * Section templates. `d` drums, `b` bass, `c` chords, `l` lead, each 0..1 as a
 * density/level; `bars` is the length. An arrangement is assembled from these
 * per song so no two runs through a station are laid out the same way.
 */
const SECTIONS = {
  intro: { bars: 4, d: 0.35, b: 0.6, c: 0.7, l: 0.0 },
  a: { bars: 8, d: 0.85, b: 1.0, c: 0.8, l: 0.35 },
  b: { bars: 8, d: 1.0, b: 1.0, c: 1.0, l: 0.9 },
  lift: { bars: 4, d: 1.0, b: 0.9, c: 1.0, l: 1.0 },
  brk: { bars: 4, d: 0.25, b: 0.4, c: 0.55, l: 0.5 },
  outro: { bars: 4, d: 0.6, b: 0.7, c: 0.6, l: 0.2 },
};

/* ------------------------------------------------------------------ */
/* Drum machine primitives                                             */
/* ------------------------------------------------------------------ */

function kick(actx, dst, t, o = {}) {
  const lvl = o.level ?? 1;
  const f0 = o.f0 ?? 150, f1 = o.f1 ?? 44;
  const b = osc(actx, 'sine', f0);
  const g = gain(actx, 0);
  const drv = shaper(actx, saturationCurve(o.drive ?? 2, 0.3), '2x');
  b.connect(g); series(g, drv).connect(dst);
  sweep(b.frequency, t, f0, f1, o.pitchT ?? 0.045);
  ad(g.gain, t, 0.62 * lvl, 0.002, o.decay ?? 0.24);
  b.start(t); b.stop(t + (o.decay ?? 0.24) + 0.1);
  if (o.click !== false) {
    const c = osc(actx, 'triangle', 1800);
    const cg = gain(actx, 0);
    c.connect(cg); cg.connect(dst);
    hit(cg.gain, t, 0.07 * lvl, 0.008);
    c.start(t); c.stop(t + 0.03);
  }
}

function snare(actx, bank, rng, dst, t, o = {}) {
  const lvl = o.level ?? 1;
  // Two tuned shell modes plus the snare wires. Brushes swap the wire burst for
  // a long soft sweep, which is the whole difference between a kit and a
  // country kit.
  const modes = o.modes ?? [185, 330];
  for (let i = 0; i < modes.length; i++) {
    const b = osc(actx, 'triangle', modes[i] * rng.range(0.98, 1.02));
    const g = gain(actx, 0);
    b.connect(g); g.connect(dst);
    ad(g.gain, t, (0.24 / (1 + i)) * lvl, 0.001, o.shell ?? 0.09);
    b.start(t); b.stop(t + 0.25);
  }
  const src = bank.source('white', rng, rng.range(0.9, 1.2));
  const f = biquad(actx, o.brush ? 'bandpass' : 'highpass', o.brush ? 2600 : 1400, o.brush ? 0.7 : 0.7);
  const g = gain(actx, 0);
  series(src, f, g).connect(dst);
  if (o.brush) ad(g.gain, t, 0.16 * lvl, 0.02, o.decay ?? 0.16);
  else ad(g.gain, t, 0.34 * lvl, 0.001, o.decay ?? 0.13);
  src.start(t, src._offset, (o.decay ?? 0.16) + 0.1);
}

function hat(actx, bank, rng, dst, t, open, level = 1, colour = 8000) {
  const src = bank.source('white', rng, rng.range(0.95, 1.3));
  const hp = biquad(actx, 'highpass', colour, 0.8);
  const bp = biquad(actx, 'bandpass', colour * 1.35, 1.2);
  const g = gain(actx, 0);
  series(src, hp, bp, g).connect(dst);
  const d = open ? 0.24 : 0.032;
  ad(g.gain, t, (open ? 0.13 : 0.17) * level, 0.001, d);
  src.start(t, src._offset, d + 0.05);
}

function clap(actx, bank, rng, dst, t, level = 1) {
  // Four bursts a few ms apart is what makes a clap a clap.
  for (let i = 0; i < 4; i++) {
    const src = bank.source('white', rng, rng.range(0.95, 1.2));
    const bp = biquad(actx, 'bandpass', 1500, 1.1);
    const g = gain(actx, 0);
    series(src, bp, g).connect(dst);
    const st = t + i * 0.011 * rng.range(0.8, 1.3);
    ad(g.gain, st, (i === 3 ? 0.28 : 0.16) * level, 0.001, i === 3 ? 0.14 : 0.02);
    src.start(st, src._offset, 0.2);
  }
}

function crash(actx, bank, rng, dst, t, level = 1) {
  const src = bank.source('white', rng, rng.range(0.8, 1.1));
  const hp = biquad(actx, 'highpass', 3800, 0.6);
  const g = gain(actx, 0);
  series(src, hp, g).connect(dst);
  ad(g.gain, t, 0.2 * level, 0.004, 1.4);
  src.start(t, src._offset, 1.7);
  struckResonator(actx, bank, rng, t, [
    { f: 620, q: 12, g: 0.05 * level, decay: 0.9 },
    { f: 1470, q: 14, g: 0.04 * level, decay: 0.7 },
  ], 0.003).connect(dst);
}

/** A hammer on cold steel — Furnace 101's percussion. */
function anvil(actx, bank, rng, dst, t, level = 1) {
  struckResonator(actx, bank, rng, t, [
    { f: 340 * rng.range(0.9, 1.1), q: 30, g: 0.18 * level, decay: 0.6 },
    { f: 910 * rng.range(0.95, 1.05), q: 26, g: 0.13 * level, decay: 0.4 },
    { f: 2150, q: 22, g: 0.08 * level, decay: 0.25 },
    { f: 4700, q: 16, g: 0.04 * level, decay: 0.12 },
  ], 0.0025).connect(dst);
}

function tamb(actx, bank, rng, dst, t, level = 1) {
  for (let i = 0; i < 5; i++) {
    struckResonator(actx, bank, rng, t + rng.range(0, 0.012), [
      { f: rng.range(5200, 9500), q: 26, g: 0.018 * level, decay: rng.range(0.02, 0.09) },
    ], 0.0015).connect(dst);
  }
}

/* ------------------------------------------------------------------ */
/* Tonal instruments                                                   */
/* ------------------------------------------------------------------ */

/** Bass with a per-note filter envelope. `res` high enough is an acid line. */
function bassNote(actx, dst, t, f, dur, o = {}) {
  const lvl = o.level ?? 1;
  const a = osc(actx, o.wave ?? 'sawtooth', f);
  const b = o.sub === false ? null : osc(actx, 'sine', f * 0.5);
  const g = gain(actx, 0);
  const lp = biquad(actx, 'lowpass', 200, o.res ?? 1);
  const drv = shaper(actx, saturationCurve(o.drive ?? 1.6, 0.35), '2x');
  a.connect(g);
  if (b) { const bg = gain(actx, 0.5); b.connect(bg); bg.connect(g); }
  series(g, lp, drv).connect(dst);
  const env = o.env ?? 1;
  lp.frequency.setValueAtTime(clamp(f * (2 + env * 12), 60, 9000), t);
  lp.frequency.exponentialRampToValueAtTime(clamp(f * (1.4 + env * 1.4), 50, 9000), t + Math.min(dur, 0.4));
  adsr(g.gain, t, 0.34 * lvl, 0.004, dur * 0.2, dur * 0.55, 0.7, o.rel ?? 0.07);
  const end = t + dur + (o.rel ?? 0.07) + 0.05;
  a.start(t); a.stop(end);
  if (b) { b.start(t); b.stop(end); }
}

/** Detuned-pair oscillator through an amp: garage guitar and furnace leads. */
function ampVoice(actx, dst, t, f, dur, o = {}) {
  const lvl = o.level ?? 1;
  const n = o.voices ?? 2;
  const g = gain(actx, 0);
  const drv = shaper(actx, saturationCurve(o.drive ?? 8, 0.5), '4x');
  // A guitar cabinet is a bandpass with a hard shelf off the top; without it a
  // distorted saw is a wasp.
  const cab1 = biquad(actx, 'highpass', o.cabLo ?? 110, 0.7);
  const cab2 = biquad(actx, 'lowpass', o.cabHi ?? 3800, 0.9);
  const pres = biquad(actx, 'peaking', 2100, 1.2, o.pres ?? 4);
  const oscs = [];
  for (let i = 0; i < n; i++) {
    const a = osc(actx, o.wave ?? 'sawtooth', f);
    a.detune.value = (i - (n - 1) / 2) * (o.detune ?? 9);
    a.connect(g);
    oscs.push(a);
  }
  series(g, drv, cab1, cab2, pres).connect(dst);
  adsr(g.gain, t, (0.2 / Math.sqrt(n)) * lvl, o.atk ?? 0.006, dur * 0.25, dur * 0.5, 0.75, o.rel ?? 0.09);
  const end = t + dur + (o.rel ?? 0.09) + 0.06;
  for (const a of oscs) { a.start(t); a.stop(end); }
  if (o.bend) {
    for (const a of oscs) sweep(a.frequency, t, f * o.bend, f, Math.min(dur * 0.5, 0.16));
  }
  if (o.vib) {
    const v = osc(actx, 'sine', o.vib);
    const vg = gain(actx, f * 0.012);
    v.connect(vg);
    for (const a of oscs) vg.connect(a.frequency);
    v.start(t); v.stop(end);
  }
}

/** Two-operator FM — the Rhodes on Black & Gold and the bells on Slackwater. */
function fmVoice(actx, dst, t, f, dur, o = {}) {
  const lvl = o.level ?? 1;
  const car = osc(actx, 'sine', f);
  const mod = osc(actx, 'sine', f * (o.ratio ?? 2));
  const mg = gain(actx, 0);
  mod.connect(mg);
  mg.connect(car.frequency);
  const g = gain(actx, 0);
  car.connect(g);
  g.connect(dst);
  // The index falls faster than the amplitude: that decaying brightness is the
  // entire character of an electric piano.
  ad(mg.gain, t, f * (o.index ?? 2.4), 0.002, dur * 0.35);
  adsr(g.gain, t, 0.2 * lvl, o.atk ?? 0.004, dur * 0.3, dur * 0.5, 0.4, o.rel ?? 0.35);
  const end = t + dur + (o.rel ?? 0.35) + 0.1;
  car.start(t); car.stop(end);
  mod.start(t); mod.stop(end);
}

/** Slow, wide pad. Several detuned partials with independent slow envelopes. */
function padVoice(actx, dst, t, f, dur, o = {}) {
  const lvl = o.level ?? 1;
  const g = gain(actx, 0);
  const lp = biquad(actx, 'lowpass', 900, 0.8);
  series(g, lp).connect(dst);
  const n = o.voices ?? 3;
  const oscs = [];
  for (let i = 0; i < n; i++) {
    const a = osc(actx, o.wave ?? 'sine', f * (i === 2 ? 2 : 1));
    a.detune.value = (i - 1) * (o.detune ?? 7);
    const ag = gain(actx, i === 2 ? 0.3 : 0.6);
    a.connect(ag); ag.connect(g);
    oscs.push(a);
  }
  const atk = o.atk ?? dur * 0.3;
  adsr(g.gain, t, 0.16 * lvl, atk, dur * 0.2, dur * 0.4, 0.8, o.rel ?? dur * 0.6);
  sweep(lp.frequency, t, 500, clamp(f * 6, 700, 6000), dur * 0.7);
  const end = t + dur + (o.rel ?? dur * 0.6) + 0.2;
  for (const a of oscs) { a.start(t); a.stop(end); }
}

/** Plucked string: a hard attack transient plus a fast-decaying tone. */
function pluck(actx, bank, rng, dst, t, f, dur, o = {}) {
  const lvl = o.level ?? 1;
  const a = osc(actx, o.wave ?? 'triangle', f);
  const g = gain(actx, 0);
  const lp = biquad(actx, 'lowpass', clamp(f * 8, 600, 9000), 0.8);
  a.connect(g); series(g, lp).connect(dst);
  ad(g.gain, t, 0.26 * lvl, 0.003, dur);
  a.start(t); a.stop(t + dur + 0.1);
  // Pick noise.
  const src = bank.source('white', rng, rng.range(0.9, 1.3));
  const bp = biquad(actx, 'bandpass', clamp(f * 6, 900, 7000), 1.4);
  const ng = gain(actx, 0);
  series(src, bp, ng).connect(dst);
  hit(ng.gain, t, 0.05 * lvl, 0.02);
  src.start(t, src._offset, 0.05);
}

/** Pedal steel: a tone that SLIDES into its note. The signature of Incline AM. */
function steelVoice(actx, dst, t, fromF, toF, dur, o = {}) {
  const lvl = o.level ?? 1;
  const g = gain(actx, 0);
  const lp = biquad(actx, 'lowpass', 3200, 0.8);
  series(g, lp).connect(dst);
  for (let i = 0; i < 2; i++) {
    const a = osc(actx, 'triangle', fromF);
    a.detune.value = i === 0 ? -5 : 5;
    a.connect(g);
    sweep(a.frequency, t, fromF, toF, Math.min(dur * 0.45, 0.5));
    a.start(t); a.stop(t + dur + 0.4);
  }
  const v = osc(actx, 'sine', 5.4);
  const vg = gain(actx, toF * 0.006);
  v.connect(vg); vg.connect(lp.frequency);
  v.start(t); v.stop(t + dur + 0.4);
  adsr(g.gain, t, 0.16 * lvl, 0.09, dur * 0.2, dur * 0.5, 0.7, 0.3);
}

/* ------------------------------------------------------------------ */
/* Station generator                                                   */
/* ------------------------------------------------------------------ */

class Station {
  /**
   * @param {BaseAudioContext} actx
   * @param {object} spec one of STATIONS
   * @param {AudioNode} dst where the finished mix goes
   */
  constructor(actx, bank, rng, spec, dst) {
    this.actx = actx;
    this.bank = bank;
    this.rng = rng;
    this.spec = spec;
    this.nodes = [];

    /* ---- station mix bus ------------------------------------------ */
    // Each station has its own tone stack, which is a big part of why they do
    // not blur into one another: Incline AM is a 260 Hz - 3.4 kHz band with
    // audible hiss; Redline is full range and bone dry.
    this.out = gain(actx, 0);
    const hp = biquad(actx, 'highpass', spec.tone.hp, 0.7);
    const lp = biquad(actx, 'lowpass', spec.tone.lp, 0.7);
    const tilt = biquad(actx, 'highshelf', 3000, 0.7, spec.tone.tilt);
    const comp = actx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 14;
    comp.ratio.value = 3.2; comp.attack.value = 0.008; comp.release.value = 0.22;
    this.in = gain(actx, 1);
    series(this.in, hp, lp, tilt, comp, this.out).connect(dst);
    this.nodes.push(this.in, hp, lp, tilt, comp, this.out);

    /* ---- per-voice sub-buses with a shared delay ------------------- */
    this.drumBus = gain(actx, 1);
    this.bassBus = gain(actx, 1);
    this.chordBus = gain(actx, 1);
    this.leadBus = gain(actx, 1);
    for (const b of [this.drumBus, this.bassBus, this.chordBus, this.leadBus]) {
      b.connect(this.in);
      this.nodes.push(b);
    }
    // A tempo-synced delay on chords and lead. Cheap, and it is most of what
    // makes a two-voice sequence sound like a production.
    const dl = actx.createDelay(2);
    dl.delayTime.value = (60 / spec.bpm) * 0.75;
    const fb = gain(actx, 0.32);
    const dlLP = biquad(actx, 'lowpass', 3200, 0.7);
    const dlSend = gain(actx, spec.id === 'redline' ? 0.3 : spec.id === 'slack' ? 0.45 : 0.16);
    this.leadBus.connect(dlSend);
    this.chordBus.connect(dlSend);
    dlSend.connect(dl);
    dl.connect(dlLP); dlLP.connect(fb); fb.connect(dl);
    dl.connect(this.in);
    this.delay = dl;
    this.nodes.push(dl, fb, dlLP, dlSend);

    /* ---- broadcast noise floor ------------------------------------ */
    if (spec.tone.noise > 0) {
      const ns = bank.source('pink', rng, 1, true);
      const nbp = biquad(actx, 'bandpass', 2000, 0.5);
      const ng = gain(actx, spec.tone.noise);
      series(ns, nbp, ng).connect(this.in);
      ns.start(0, ns._offset);
      this.nodes.push(ns, nbp, ng);
    }

    /* ---- transport ------------------------------------------------- */
    this.bpm = spec.bpm;
    this.stepDur = 60 / this.bpm / 4;
    this.nextTime = 0;
    this.step = 0;
    this.bar = 0;
    this.song = null;
    this.playing = false;
    this._newSong(0);
  }

  /* ---------------------------------------------------------------- */

  _newSong(shiftFrom = null) {
    const r = this.rng;
    const s = this.spec;
    // Key: move by a musically sane interval so consecutive songs relate.
    const shift = shiftFrom === 0 ? 0 : r.pick([0, 0, 2, 5, 7, -3, -5]);
    const prevKey = this.song?.key ?? s.root;
    const key = shiftFrom === 0 ? s.root : clamp(prevKey + shift, s.root - 7, s.root + 7);

    // Arrangement: always intro/outro, with the middle assembled from the
    // section pool. Lengths vary so the listener never learns the shape.
    const middle = ['a', 'b', 'a', 'lift', 'brk', 'b'];
    const plan = ['intro'];
    let bars = SECTIONS.intro.bars;
    while (bars < s.songBars - SECTIONS.outro.bars) {
      const pick = middle[r.u32() % middle.length];
      plan.push(pick);
      bars += SECTIONS[pick].bars;
    }
    plan.push('outro');

    this.song = {
      key,
      prog: s.progs[r.u32() % s.progs.length],
      plan,
      bars,
      // Tempo drift within 3%: different takes, different rooms.
      bpm: s.bpm * r.range(0.975, 1.025),
      // Per-song voicing choices.
      octave: r.pick([0, 0, 0, 12]),
      leadReg: r.pick([12, 12, 24]),
      hatBusy: r.range(0.3, 1),
      fill: r.range(0.25, 0.8),
    };
    this.bpm = this.song.bpm;
    this.stepDur = 60 / this.bpm / 4;
    this.delay.delayTime.setTargetAtTime((60 / this.bpm) * 0.75, this.actx.currentTime, 0.4);
    this.bar = 0;
    this.step = 0;
  }

  /** Which section covers the current bar, and how far into it we are. */
  _section() {
    let b = this.bar % Math.max(this.song.bars, 1);
    for (const name of this.song.plan) {
      const sec = SECTIONS[name];
      if (b < sec.bars) return { name, sec, bar: b };
      b -= sec.bars;
    }
    return { name: 'a', sec: SECTIONS.a, bar: 0 };
  }

  /** Chord root for a bar, in MIDI. */
  _chordRoot(bar) {
    const p = this.song.prog;
    return this.song.key + p[bar % p.length];
  }

  /** Scale note `deg` steps above a chord root, wrapped through the scale. */
  _note(root, deg) {
    const sc = this.spec.scale;
    const oct = Math.floor(deg / sc.length) * 12;
    const idx = ((deg % sc.length) + sc.length) % sc.length;
    return root + sc[idx] + oct;
  }

  start(t) {
    this.playing = true;
    this.nextTime = Math.max(this.nextTime, t);
  }

  stop() {
    this.playing = false;
  }

  /**
   * `v` is 0..1 tuned-in-ness; the station's own `level` normalises the six
   * stations to within about 3 dB of each other, the way a real dial does.
   * Measured before this: 9.6 dB between GREASE FM and INCLINE AM, which meant
   * changing station changed the volume of the game.
   */
  setLevel(v, smooth = 0.05) {
    to(this.out.gain, v * (this.spec.level ?? 1), this.actx.currentTime, smooth);
  }

  /** Schedule every step that starts before `until`. */
  schedule(until) {
    if (!this.playing) return;
    if (this.nextTime < this.actx.currentTime) this.nextTime = this.actx.currentTime + 0.02;
    let guard = 0;
    while (this.nextTime < until && guard++ < 256) {
      const sw = (this.step % 2 === 1) ? this.stepDur * this.spec.swing : 0;
      this._emit(this.nextTime + sw);
      this.nextTime += this.stepDur;
      this.step++;
      if (this.step >= STEPS_PER_BAR) {
        this.step = 0;
        this.bar++;
        if (this.bar >= this.song.bars) this._newSong();
      }
    }
  }

  /** One 16th of music. */
  _emit(t) {
    const { actx, bank, rng } = this;
    const s = this.spec;
    const { sec, bar } = this._section();
    const step = this.step;
    const beat = step / 4;
    const root = this._chordRoot(this.bar) + this.song.octave;
    const last = bar === sec.bars - 1;
    const fill = last && step >= 12 && rng.float() < this.song.fill;

    switch (s.id) {
      case 'grease': this._grease(t, step, beat, sec, root, fill, last); break;
      case 'gold': this._gold(t, step, beat, sec, root, fill, last); break;
      case 'redline': this._redline(t, step, beat, sec, root, fill, last); break;
      case 'slack': this._slack(t, step, beat, sec, root, fill, last); break;
      case 'furnace': this._furnace(t, step, beat, sec, root, fill, last); break;
      default: this._incline(t, step, beat, sec, root, fill, last); break;
    }
    void actx; void bank; void rng;
  }

  /* ------------------------------------------------------------ */
  /* GREASE FM — garage rock                                       */
  /* ------------------------------------------------------------ */
  _grease(t, step, beat, sec, root, fill, last) {
    const { actx, bank, rng } = this;
    const d = sec.d, sd = this.stepDur;

    if (d > 0.1) {
      if (step === 0 || step === 6 || (step === 10 && rng.float() < 0.4)) {
        kick(actx, this.drumBus, t, { level: 0.95 * d, f0: 160, f1: 48, decay: 0.2 });
      }
      if (step === 4 || step === 12) snare(actx, bank, rng, this.drumBus, t, { level: 0.9 * d });
      if (step % 2 === 0) hat(actx, bank, rng, this.drumBus, t, step === 14, 0.9 * d * this.song.hatBusy, 7200);
      if (fill && step >= 12) snare(actx, bank, rng, this.drumBus, t, { level: 0.55 * d, decay: 0.07 });
      if (last && step === 0 && sec.l > 0.5) crash(actx, bank, rng, this.drumBus, t, 0.7);
    }

    // Bass: root on the beat with a driving eighth push.
    if (sec.b > 0.2 && (step % 4 === 0 || step === 6 || step === 14)) {
      const n = step === 6 ? this._note(root, 2) : root;
      bassNote(actx, this.bassBus, t, mtof(n - 12), sd * 3.2, {
        wave: 'sawtooth', level: sec.b, drive: 2.2, res: 3, env: 0.5,
      });
    }

    // Guitar: root+fifth power chords, palm-muted eighths under the section.
    if (sec.c > 0.3 && step % 4 === 0) {
      const long = step === 0 ? sd * 6 : sd * 2.2;
      for (const iv of [0, 7, 12]) {
        ampVoice(actx, this.chordBus, t, mtof(root + iv), long, {
          level: sec.c * (iv === 12 ? 0.45 : 0.75), drive: 9, detune: 11, cabHi: 3600,
        });
      }
    } else if (sec.c > 0.6 && step % 2 === 0 && rng.float() < 0.5) {
      ampVoice(actx, this.chordBus, t, mtof(root), sd * 0.6, {
        level: sec.c * 0.35, drive: 7, atk: 0.002, rel: 0.03, cabHi: 3000,
      });
    }

    // Lead: pentatonic phrases with bends, only in the busy sections.
    if (sec.l > 0.3 && step % 2 === 0 && rng.float() < sec.l * 0.55) {
      const deg = 2 + (rng.u32() % 6);
      ampVoice(actx, this.leadBus, t, mtof(this._note(root, deg) + 12), sd * rng.range(1.4, 3.4), {
        level: sec.l * 0.7, drive: 11, detune: 5, cabHi: 4200, pres: 6,
        bend: rng.float() < 0.35 ? 0.945 : 0, vib: 5.6,
      });
    }
  }

  /* ------------------------------------------------------------ */
  /* BLACK & GOLD — soul                                           */
  /* ------------------------------------------------------------ */
  _gold(t, step, beat, sec, root, fill, last) {
    const { actx, bank, rng } = this;
    const d = sec.d, sd = this.stepDur;

    if (d > 0.1) {
      if (step === 0 || step === 7 || step === 10) {
        kick(actx, this.drumBus, t, { level: 0.75 * d, f0: 130, f1: 42, decay: 0.26, drive: 1.2 });
      }
      if (step === 4 || step === 12) {
        snare(actx, bank, rng, this.drumBus, t, { level: 0.72 * d, brush: false, modes: [200, 360] });
      }
      if (step % 2 === 0) hat(actx, bank, rng, this.drumBus, t, false, 0.55 * d, 9000);
      if (step === 6 || step === 14) tamb(actx, bank, rng, this.drumBus, t, 0.7 * d);
      if (fill) snare(actx, bank, rng, this.drumBus, t, { level: 0.4 * d, brush: true });
    }

    // Bass: syncopated, with a chromatic approach into the next bar.
    if (sec.b > 0.2) {
      const hits = [0, 3, 6, 11];
      if (hits.includes(step)) {
        const deg = step === 0 ? 0 : step === 6 ? 2 : 4;
        bassNote(actx, this.bassBus, t, mtof(this._note(root, deg) - 24), sd * 2.6, {
          wave: 'triangle', level: sec.b * 0.95, drive: 1.4, res: 1.2, env: 0.35, sub: false,
        });
      } else if (step === 15 && rng.float() < 0.5) {
        bassNote(actx, this.bassBus, t, mtof(root - 25), sd * 0.9, { wave: 'triangle', level: sec.b * 0.7 });
      }
    }

    // Rhodes: 7th/9th voicings, laid back off the beat.
    if (sec.c > 0.3 && (step === 2 || step === 8 || step === 11)) {
      const voicing = [0, 4, 7, 10, 14];
      for (let i = 0; i < voicing.length; i++) {
        if (i > 2 && rng.float() < 0.35) continue;
        fmVoice(actx, this.chordBus, t + i * 0.004, mtof(root + voicing[i]), sd * 3.5, {
          level: sec.c * (0.7 - i * 0.09), ratio: 2, index: 1.6, rel: 0.5,
        });
      }
    }

    // Horn stabs and a sung lead line.
    if (sec.l > 0.6 && (step === 8 || (step === 14 && rng.float() < 0.4))) {
      for (const iv of [0, 4, 7]) {
        ampVoice(actx, this.leadBus, t, mtof(root + iv + 12), sd * 1.6, {
          wave: 'sawtooth', level: sec.l * 0.42, drive: 1.4, detune: 6,
          cabLo: 260, cabHi: 4200, atk: 0.03, pres: 3,
        });
      }
    }
    if (sec.l > 0.3 && step % 4 === 2 && rng.float() < sec.l * 0.4) {
      const deg = rng.u32() % 5;
      fmVoice(actx, this.leadBus, t, mtof(this._note(root, deg) + this.song.leadReg), sd * rng.range(2, 5), {
        level: sec.l * 0.5, ratio: 1, index: 0.7, atk: 0.05, rel: 0.4,
      });
    }
    void last;
  }

  /* ------------------------------------------------------------ */
  /* REDLINE — drum machine                                        */
  /* ------------------------------------------------------------ */
  _redline(t, step, beat, sec, root, fill, last) {
    const { actx, bank, rng } = this;
    const d = sec.d, sd = this.stepDur;

    if (d > 0.1) {
      if (step % 4 === 0) kick(actx, this.drumBus, t, { level: 1.0 * d, f0: 190, f1: 38, decay: 0.34, pitchT: 0.03, drive: 3 });
      if (step === 4 || step === 12) clap(actx, bank, rng, this.drumBus, t, 0.85 * d);
      if (step % 2 === 0 || (sec.d > 0.9 && step % 2 === 1 && rng.float() < 0.3)) {
        hat(actx, bank, rng, this.drumBus, t, step === 14, 0.7 * d * this.song.hatBusy, 9500);
      }
      if (fill && step >= 12) {
        kick(actx, this.drumBus, t, { level: 0.7 * d, decay: 0.1 });
        hat(actx, bank, rng, this.drumBus, t + sd * 0.5, false, 0.5 * d, 11000);
      }
    }

    // Acid bass: 16ths with a resonant filter envelope and octave jumps.
    if (sec.b > 0.2 && (step % 2 === 0 || rng.float() < 0.35)) {
      const deg = rng.float() < 0.65 ? 0 : rng.u32() % 4;
      const oct = rng.float() < 0.2 ? 12 : 0;
      bassNote(actx, this.bassBus, t, mtof(this._note(root, deg) - 12 + oct), sd * 0.85, {
        wave: 'sawtooth', level: sec.b * 0.9, drive: 2.6, res: 11,
        env: 0.35 + (step % 4 === 0 ? 0.6 : 0), rel: 0.02, sub: false,
      });
    }

    // Stabs and a 16th arpeggio through the delay.
    if (sec.c > 0.4 && (step === 2 || step === 10)) {
      for (const iv of [0, 3, 7, 10]) {
        ampVoice(actx, this.chordBus, t, mtof(root + iv + 12), sd * 0.7, {
          wave: 'sawtooth', level: sec.c * 0.3, drive: 3, detune: 14, atk: 0.002, rel: 0.04, cabHi: 6000,
        });
      }
    }
    if (sec.l > 0.5) {
      const arp = [0, 2, 4, 2, 5, 4, 2, 0];
      if (step % 2 === 0 || sec.l > 0.85) {
        const deg = arp[(step + this.bar) % arp.length];
        ampVoice(actx, this.leadBus, t, mtof(this._note(root, deg) + this.song.leadReg), sd * 0.55, {
          wave: 'square', level: sec.l * 0.3, drive: 2, detune: 4, atk: 0.002, rel: 0.05,
          cabLo: 300, cabHi: 7000, pres: 2,
        });
      }
    }
    void last;
  }

  /* ------------------------------------------------------------ */
  /* SLACKWATER — ambient                                          */
  /* ------------------------------------------------------------ */
  _slack(t, step, beat, sec, root, fill, last) {
    const { actx, bank, rng } = this;
    const sd = this.stepDur;

    // No kit. A soft pulse marks time without being a beat.
    if (sec.d > 0.5 && step === 0 && this.bar % 2 === 0) {
      kick(actx, this.drumBus, t, { level: 0.22 * sec.d, f0: 90, f1: 38, decay: 0.5, click: false, drive: 0.8 });
    }
    if (sec.d > 0.8 && step === 8 && rng.float() < 0.4) {
      hat(actx, bank, rng, this.drumBus, t, true, 0.1, 6000);
    }

    // Sub bass: one long note per bar.
    if (sec.b > 0.2 && step === 0) {
      bassNote(actx, this.bassBus, t, mtof(root - 24), sd * 15, {
        wave: 'sine', level: sec.b * 0.8, drive: 0.6, res: 0.7, env: 0.1, rel: 1.2, sub: false,
      });
    }

    // Pad: a full chord held across the bar, revoiced each time.
    if (sec.c > 0.2 && step === 0) {
      const voicing = [0, 7, 11, 14, 16];
      for (let i = 0; i < voicing.length; i++) {
        if (rng.float() < 0.25) continue;
        padVoice(actx, this.chordBus, t + rng.range(0, 0.09), mtof(root + voicing[i]), sd * 15, {
          level: sec.c * 0.55, wave: i > 2 ? 'triangle' : 'sine', detune: 6 + i * 2, atk: sd * 5,
        });
      }
    }

    // Lead: a rare bell, placed off the grid.
    if (sec.l > 0.3 && step % 8 === 0 && rng.float() < sec.l * 0.45) {
      const deg = rng.u32() % 5;
      fmVoice(actx, this.leadBus, t + rng.range(0, 0.12), mtof(this._note(root, deg) + 12), sd * 6, {
        level: sec.l * 0.4, ratio: 3.5, index: 1.1, atk: 0.01, rel: 1.6,
      });
    }
    void fill; void last; void beat;
  }

  /* ------------------------------------------------------------ */
  /* FURNACE 101 — industrial                                      */
  /* ------------------------------------------------------------ */
  _furnace(t, step, beat, sec, root, fill, last) {
    const { actx, bank, rng } = this;
    const d = sec.d, sd = this.stepDur;

    if (d > 0.1) {
      if (step === 0 || step === 3 || step === 8 || step === 11) {
        kick(actx, this.drumBus, t, { level: 1.0 * d, f0: 210, f1: 34, decay: 0.28, drive: 6 });
      }
      if (step === 4 || step === 12) anvil(actx, bank, rng, this.drumBus, t, 0.9 * d);
      if (step % 2 === 1 && rng.float() < 0.7 * this.song.hatBusy) {
        hat(actx, bank, rng, this.drumBus, t, false, 0.4 * d, 5200);
      }
      // A steam release on the turnaround.
      if (last && step === 14) {
        const src = bank.source('white', rng, 1);
        const bp = biquad(actx, 'bandpass', 3400, 0.9);
        const g = gain(actx, 0);
        series(src, bp, g).connect(this.drumBus);
        ad(g.gain, t, 0.12 * d, 0.02, 0.5);
        src.start(t, src._offset, 0.7);
      }
      if (fill) anvil(actx, bank, rng, this.drumBus, t, 0.5 * d);
    }

    // Bass: relentless distorted eighths on the root.
    if (sec.b > 0.2 && step % 2 === 0) {
      bassNote(actx, this.bassBus, t, mtof(root - 12), sd * 1.7, {
        wave: 'sawtooth', level: sec.b * 1.0, drive: 5, res: 5, env: 0.3, rel: 0.03,
      });
    }

    // Clusters: minor second stacks, which is where the menace lives.
    if (sec.c > 0.3 && (step === 0 || step === 6)) {
      for (const iv of [0, 1, 8, 13]) {
        ampVoice(actx, this.chordBus, t, mtof(root + iv), sd * 3, {
          wave: 'sawtooth', level: sec.c * 0.3, drive: 6, detune: 18, cabLo: 160, cabHi: 4600,
        });
      }
    }

    // Lead: a harsh square through heavy drive, ring-modulated by the kick rate.
    if (sec.l > 0.5 && step % 4 === 2 && rng.float() < sec.l * 0.7) {
      const deg = rng.u32() % 5;
      ampVoice(actx, this.leadBus, t, mtof(this._note(root, deg) + 12), sd * rng.range(1, 3), {
        wave: 'square', level: sec.l * 0.4, drive: 14, detune: 22, cabHi: 5200, pres: 7,
      });
    }
    void beat;
  }

  /* ------------------------------------------------------------ */
  /* INCLINE AM — old country                                      */
  /* ------------------------------------------------------------ */
  _incline(t, step, beat, sec, root, fill, last) {
    const { actx, bank, rng } = this;
    const d = sec.d, sd = this.stepDur;

    if (d > 0.1) {
      // Train beat: kick on 1 and 3, brushed snare on the eighths.
      if (step === 0 || step === 8) kick(actx, this.drumBus, t, { level: 0.6 * d, f0: 110, f1: 46, decay: 0.2, drive: 0.9, click: false });
      if (step % 2 === 0) {
        snare(actx, bank, rng, this.drumBus, t, {
          level: (step === 4 || step === 12 ? 0.6 : 0.22) * d, brush: true, decay: 0.1, shell: 0.05,
        });
      }
      if (fill) snare(actx, bank, rng, this.drumBus, t, { level: 0.3 * d, brush: true });
    }

    // Upright bass: root and fifth, plucked.
    if (sec.b > 0.2 && (step === 0 || step === 8)) {
      const n = step === 0 ? root : this._note(root, 4);
      pluck(actx, bank, rng, this.bassBus, t, mtof(n - 24), sd * 5, { level: sec.b * 1.1, wave: 'triangle' });
    }

    // Acoustic guitar: an arpeggio across the chord.
    if (sec.c > 0.3 && step % 2 === 0) {
      const shape = [0, 7, 12, 16, 12, 7];
      const iv = shape[(step / 2 + this.bar) % shape.length];
      pluck(actx, bank, rng, this.chordBus, t, mtof(root + iv), sd * 3, {
        level: sec.c * 0.55, wave: rng.float() < 0.5 ? 'triangle' : 'sawtooth',
      });
    }

    // Pedal steel: slides into a chord tone, once or twice a bar.
    if (sec.l > 0.3 && (step === 4 || (step === 12 && rng.float() < 0.4))) {
      const target = this._note(root, 2 + (rng.u32() % 3)) + 12;
      steelVoice(actx, this.leadBus, t, mtof(target - rng.pick([2, 3, 5])), mtof(target), sd * 6, {
        level: sec.l * 0.8,
      });
    }
    void beat; void last;
  }

  dispose() {
    for (const n of this.nodes) {
      try { n.stop?.(); } catch { /* not a source */ }
      try { n.disconnect(); } catch { /* gone */ }
    }
    this.nodes.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Station idents and the DJ                                           */
/* ------------------------------------------------------------------ */

/** Vowel formants for the announcer. Same physics as vox.js, radio register. */
const DJ_VOWELS = {
  a: [700, 1180, 2500], e: [520, 1800, 2500], i: [320, 2200, 3000],
  o: [560, 900, 2450], u: [340, 760, 2500],
};

/**
 * A station announcer. There is no speech corpus in this project, so this is a
 * formant-synthesized voice with the prosody of a station ID — a rising phrase
 * over the call sign and a settled close — pushed through a 400 Hz - 3.2 kHz
 * broadcast chain with heavy compression. It reads as "the DJ is talking over
 * the intro", which is the job; it is not intelligible speech and does not
 * pretend to be.
 */
function announcer(actx, bank, rng, dst, t, spec, bright) {
  const out = gain(actx, 0.9);
  const bp1 = biquad(actx, 'highpass', 380, 0.8);
  const bp2 = biquad(actx, 'lowpass', 3200, 0.9);
  const comp = actx.createDynamicsCompressor();
  comp.threshold.value = -26; comp.knee.value = 6; comp.ratio.value = 7;
  comp.attack.value = 0.004; comp.release.value = 0.09;
  const drv = shaper(actx, saturationCurve(2.2, 0.3), '2x');
  series(out, bp1, bp2, comp, drv).connect(dst);

  const f0 = bright ? rng.range(118, 142) : rng.range(88, 104);
  const syls = 5 + (rng.u32() % 4);
  const vowelKeys = Object.keys(DJ_VOWELS);
  let tt = t;
  const src = osc(actx, 'sawtooth', f0);
  const srcG = gain(actx, 0);
  src.connect(srcG);
  const fs = [];
  for (let i = 0; i < 3; i++) {
    const bp = biquad(actx, 'bandpass', 600, 6);
    const g = gain(actx, [1, 0.6, 0.3][i]);
    srcG.connect(bp); bp.connect(g); g.connect(out);
    fs.push(bp);
  }
  for (let i = 0; i < syls; i++) {
    const v = DJ_VOWELS[vowelKeys[rng.u32() % vowelKeys.length]];
    const dur = rng.range(0.09, 0.19);
    // Prosody: rise through the call sign, fall on the last syllable.
    const p = i === syls - 1 ? 0.78 : lerp(0.95, 1.22, i / Math.max(syls - 1, 1)) * rng.range(0.96, 1.05);
    src.frequency.setTargetAtTime(f0 * p, tt, 0.028);
    for (let k = 0; k < 3; k++) fs[k].frequency.setTargetAtTime(v[k] * rng.range(0.97, 1.03), tt, 0.016);
    adsr(srcG.gain, tt, 0.22, 0.014, dur * 0.2, dur * 0.5, 0.8, 0.04);
    tt += dur + rng.range(0.01, 0.05);
  }
  const end = tt + 0.25;
  src.start(t); src.stop(end);
  void bank; void spec;
  return end;
}

/** The station's musical logo: a short motif in its own scale and timbre. */
function ident(actx, bank, rng, dst, t, spec) {
  const sc = spec.scale;
  const root = spec.root + 12;
  const motif = [0, 2, 4, 2];
  const beat = 60 / spec.bpm;
  let end = t;
  for (let i = 0; i < motif.length; i++) {
    const n = root + sc[motif[i] % sc.length];
    const st = t + i * beat * 0.42;
    if (spec.id === 'slack') {
      fmVoice(actx, dst, st, mtof(n), beat * 1.2, { level: 0.7, ratio: 3.5, index: 1.4, rel: 1 });
    } else if (spec.id === 'incline') {
      pluck(actx, bank, rng, dst, st, mtof(n), beat * 0.9, { level: 0.9 });
    } else {
      ampVoice(actx, dst, st, mtof(n), beat * 0.5, {
        wave: spec.wave, level: 0.55, drive: spec.id === 'furnace' ? 10 : 5, detune: 10,
      });
    }
    end = st + beat * 1.2;
  }
  // A sub sweep under the logo, the way every real jingle does it.
  const b = osc(actx, 'sine', mtof(spec.root - 12));
  const g = gain(actx, 0);
  b.connect(g); g.connect(dst);
  sweep(b.frequency, t, mtof(spec.root - 5), mtof(spec.root - 17), beat * 1.4);
  ad(g.gain, t, 0.3, 0.01, beat * 1.6);
  b.start(t); b.stop(t + beat * 2);
  return end;
}

/* ------------------------------------------------------------------ */
/* The receiver                                                        */
/* ------------------------------------------------------------------ */

/**
 * The radio as a physical object: a tuner with static between stations, a
 * speaker in a door card, and a car body between it and the player when they
 * are standing outside.
 */
export class Radio {
  constructor(actx, bank, mixer, field, rng) {
    this.actx = actx;
    this.bank = bank;
    this.mixer = mixer;
    this.field = field;
    this.rng = rng;
    this.nodes = [];

    /* ---- receiver chain -------------------------------------------- */
    this.programme = gain(actx, 1);       // all stations sum here
    this.tuner = gain(actx, 1);           // muted during a retune
    this.programme.connect(this.tuner);

    // Speaker: a small paper cone in a door card. Band-limited, resonant, and
    // it distorts when you turn it up.
    this.speakerHP = biquad(actx, 'highpass', 95, 0.8);
    this.speakerLP = biquad(actx, 'lowpass', 9000, 0.7);
    this.speakerRes = biquad(actx, 'peaking', 2400, 1.4, 3.5);
    this.speakerBox = biquad(actx, 'peaking', 160, 1.6, 4);
    this.speakerDrv = shaper(actx, saturationCurve(1.4, 0.2), '2x');
    this.out = gain(actx, 1);
    series(this.tuner, this.speakerHP, this.speakerLP, this.speakerRes, this.speakerBox,
      this.speakerDrv, this.out);

    // Two destinations: dry into the music bus (you are in the car) and a
    // tracked emitter at the car (you are stood next to it).
    this.dry = gain(actx, 1);
    this.out.connect(this.dry);
    this.dry.connect(mixer.bus('music'));
    this.wetOut = gain(actx, 0);
    this.out.connect(this.wetOut);
    this.emitter = null;

    /* ---- static / tuning ------------------------------------------- */
    this.staticGain = gain(actx, 0);
    const ns = bank.source('white', rng, 1, true);
    const nhp = biquad(actx, 'highpass', 500, 0.7);
    const nlp = biquad(actx, 'lowpass', 5200, 0.7);
    series(ns, nhp, nlp, this.staticGain).connect(this.speakerHP);
    ns.start(0, ns._offset);
    this._staticLP = nlp;
    // Heterodyne: the whistle you get sweeping past a carrier.
    this.hetOsc = osc(actx, 'sine', 1200);
    this.hetGain = gain(actx, 0);
    this.hetOsc.connect(this.hetGain);
    this.hetGain.connect(this.speakerHP);
    this.hetOsc.start(0);
    this.nodes.push(ns, nhp, nlp, this.staticGain, this.hetOsc, this.hetGain);

    /* ---- stations --------------------------------------------------- */
    this.stations = {};
    this.current = null;          // station id, or null for OFF
    this.rotation = STATION_IDS.slice();
    this.enabled = false;
    this.identTimer = 90;
    this._tuning = 0;
    this._powered = false;
    this._level = 1;
    this.stats = { station: 'off', bar: 0, song: 0 };
  }

  _station(id) {
    let s = this.stations[id];
    if (!s) {
      s = new Station(this.actx, this.bank, this.rng.fork(), STATIONS[id], this.programme);
      this.stations[id] = s;
    }
    return s;
  }

  /** The station list for the active brother (DESIGN.md: `BOYZ.*.radio`). */
  setRotation(list) {
    const ids = (list ?? []).filter((x) => STATIONS[x]);
    this.rotation = ids.length ? ids : STATION_IDS.slice();
  }

  /** Cycle: station 1 .. station N, then OFF, then back to 1. */
  next() {
    const idx = this.current === null ? -1 : this.rotation.indexOf(this.current);
    const nextIdx = idx + 1;
    this.tune(nextIdx >= this.rotation.length ? null : this.rotation[nextIdx]);
    return this.current;
  }

  /**
   * Tune to a station id, or null for off. The transition is a real retune:
   * the programme drops, static comes up under a swept band, a neighbouring
   * carrier bleeds through for a moment, then the new station locks in with a
   * hair of drift.
   */
  tune(id) {
    if (id !== null && !STATIONS[id]) id = null;
    if (id === this.current) return;
    const t = this.actx.currentTime;
    const prev = this.current;
    this.current = id;
    this.stats.station = id ?? 'off';

    if (prev) this._station(prev).setLevel(0, 0.03);

    // Static sweep.
    const dur = id === null ? 0.28 : this.rng.range(0.42, 0.72);
    this._tuning = dur;
    this.tuner.gain.cancelScheduledValues(t);
    this.tuner.gain.setTargetAtTime(0.12, t, 0.02);
    this.staticGain.gain.cancelScheduledValues(t);
    this.staticGain.gain.setValueAtTime(0.001, t);
    this.staticGain.gain.exponentialRampToValueAtTime(0.09, t + 0.05);
    this.staticGain.gain.setValueAtTime(0.09, t + dur * 0.72);
    this.staticGain.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    sweep(this._staticLP.frequency, t, 1800, 6200, dur * 0.8);
    // Heterodyne whistle sweeping down onto the carrier.
    this.hetGain.gain.cancelScheduledValues(t);
    ad(this.hetGain.gain, t + dur * 0.25, 0.02, 0.05, dur * 0.5);
    sweep(this.hetOsc.frequency, t + dur * 0.25, 3400, 380, dur * 0.55);

    if (id === null) {
      this.tuner.gain.setTargetAtTime(0, t + dur, 0.05);
      for (const k in this.stations) this.stations[k].stop();
      return;
    }

    // Bleed: half a second of a neighbouring station, quiet and detuned.
    const others = this.rotation.filter((x) => x !== id);
    if (others.length && this.rng.float() < 0.75) {
      const bleed = this._station(this.rng.pick(others));
      bleed.start(t);
      bleed.setLevel(0.10, 0.05);
      bleed.setLevel(0, dur * 0.35);
      setTimeout(() => { if (this.current !== bleed.spec.id) bleed.stop(); }, dur * 900);
    }

    const st = this._station(id);
    st.start(t + dur * 0.55);
    // Explicit: hard-zero now, then ramp in as the carrier is found. Stacking
    // two setTargetAtTime calls on the same instant and hoping the second wins
    // is how a station ends up fading in from whatever it happened to be at.
    st.out.gain.cancelScheduledValues(t);
    st.out.gain.setValueAtTime(0, t);
    st.setLevel(1, dur * 0.25);
    this.tuner.gain.setTargetAtTime(1, t + dur * 0.78, 0.08);
    // Ident on the first bar of a fresh tune-in: that is how you know where you
    // are, and it is the cue GTA trained everyone to expect.
    this.identTimer = this.rng.range(2.5, 5);
  }

  /** 0 = the player is outside the car, 1 = sitting in it. */
  setCabin(amount, smooth = 0.25) {
    const a = clamp(amount, 0, 1);
    const t = this.actx.currentTime;
    // Outside, all you hear is the bass through the doors. The box resonance is
    // lifted to sell that — but it has to be paid for with level, or the radio
    // gets LOUDER when you get out of the car, which is what the first version
    // of this did (+9 dB, measured).
    to(this.speakerLP.frequency, lerp(900, 9500, a), t, smooth);
    to(this.speakerHP.frequency, lerp(70, 95, a), t, smooth);
    to(this.speakerBox.gain, lerp(7, 4, a), t, smooth);
    to(this.dry.gain, a, t, smooth);
    to(this.wetOut.gain, (1 - a) * 0.62, t, smooth);
  }

  /** Where the car is, for when the player is stood outside it. */
  setSource(x, y, z, dt) {
    if (!Number.isFinite(x + y + z)) return;
    if (!this.emitter) {
      this.emitter = this.field.acquireTracked({
        x, y, z, bus: 'music', send: 0.35, gain: 1, priority: 0.55,
      });
      if (this.emitter) this.field.attach(this.emitter, this.wetOut);
    }
    if (this.emitter) this.field.motion(this.emitter, x, y, z, dt);
  }

  clearSource() {
    if (this.emitter) {
      this.field.releaseTracked(this.emitter);
      this.emitter = null;
    }
  }

  setLevel(v) {
    this._level = clamp(v, 0, 1.5);
    to(this.out.gain, this._level, this.actx.currentTime, 0.08);
  }

  update(dt) {
    if (this._tuning > 0) this._tuning -= dt;
    const st = this.current ? this.stations[this.current] : null;
    if (!st) return;
    st.schedule(this.actx.currentTime + LOOKAHEAD);
    this.stats.bar = st.bar;

    this.identTimer -= dt;
    if (this.identTimer <= 0) {
      this.identTimer = this.rng.range(115, 240);
      this._ident(st);
    }
  }

  /** Logo, then the DJ over the top of the music, with the music ducked. */
  _ident(st) {
    const t = this.actx.currentTime + 0.2;
    const bus = st.leadBus;
    const end = ident(this.actx, this.bank, this.rng, bus, t, st.spec);
    const bright = st.spec.bpm > 110;
    // Duck the programme so the announcer sits on top of it, exactly the way a
    // real station's voice-over ducks the bed.
    const g = st.in.gain;
    const tt = this.actx.currentTime;
    g.cancelScheduledValues(tt);
    g.setTargetAtTime(0.45, t, 0.12);
    g.setTargetAtTime(1, end + 0.9, 0.5);
    announcer(this.actx, this.bank, this.rng, this.tuner, end - 0.2, st.spec, bright);
  }

  dispose() {
    this.clearSource();
    for (const k in this.stations) this.stations[k].dispose();
    this.stations = {};
    for (const n of this.nodes) {
      try { n.stop?.(); } catch { /* noop */ }
      try { n.disconnect(); } catch { /* noop */ }
    }
    for (const n of [this.programme, this.tuner, this.speakerHP, this.speakerLP, this.speakerRes,
      this.speakerBox, this.speakerDrv, this.out, this.dry, this.wetOut]) {
      try { n.disconnect(); } catch { /* noop */ }
    }
  }
}
