/**
 * AUDIO / GAMEPLAY JINGLES
 *
 * The musical grammar of the game: cash registers, pickup chimes, mission
 * arpeggios, wanted stings, service ticks and menu clicks. Everything in
 * foley.js models a PHYSICAL event; everything here is a SIGN — a deliberate,
 * pitched, non-diegetic phrase that tells the player what just happened. Each
 * of these has a distinct voice and that distinctness is the point: pass and
 * fail must be tellable apart with your eyes shut.
 *
 * Authoring rules, which the audio probe depends on:
 *  - every jingle contains at least one OscillatorNode, and every oscillator
 *    is CREATED at its exact note pitch (sweeps ramp away from it afterwards).
 *    The probe fingerprints the scheduled node graph as 'type@hz' multisets,
 *    which is what proves each id gets its own voice rather than the generic
 *    1200 Hz blip — so no rng on note pitches. Jitter lives in levels and
 *    timing only.
 *  - the pitches themselves are fixed (cash 880/1320, win 523/659/784/1047,
 *    dead 330/262/196/131, ...) so the game keeps one musical identity even as
 *    the synthesis around them gets richer.
 *
 * Contract: jingle(actx, bank, rng, kind, { when, level, spend }) returns
 * { node, end, send } exactly like every voice in foley.js.
 */

import {
  ad, biquad, gain, hit, osc, saturationCurve, series, shaper, struckResonator,
  sweep,
} from './dsp.js';

/**
 * One enveloped note. Created AT f0 (see the fingerprint rule above); an
 * optional slide ramps away from it. Returns when the note is finished.
 */
function tone(actx, dest, wave, f0, t, dur, level, o = {}) {
  const n = osc(actx, wave, f0);
  const g = gain(actx, 0);
  n.connect(g);
  g.connect(dest);
  if (o.f1) sweep(n.frequency, t, f0, o.f1, o.slide ?? dur);
  if (o.attack) ad(g.gain, t, level, o.attack, dur);
  else hit(g.gain, t, level, dur);
  const end = t + Math.max(dur, o.slide ?? 0) + 0.08;
  n.start(t);
  n.stop(end);
  return end;
}

/** A short filtered noise gesture — swishes, puffs, sparkle, register slides. */
function breath(actx, bank, rng, dest, t, o) {
  const src = bank.source(o.kind ?? 'white', rng, rng.range(0.85, 1.2));
  const f = biquad(actx, o.type ?? 'bandpass', o.f, o.q ?? 0.8);
  const g = gain(actx, 0);
  series(src, f, g).connect(dest);
  if (o.f1) sweep(f.frequency, t, o.f, o.f1, o.dur);
  ad(g.gain, t, o.level, o.attack ?? 0.008, o.dur);
  src.start(t, src._offset, o.dur * 2 + 0.05);
  return t + o.dur * 2 + 0.05;
}

/**
 * Each builder: (actx, bank, rng, t0, lvl, out, o) -> end time.
 * Keys are the ids the rest of the game already uses (src/ui, game events).
 */
const JINGLES = {
  /* ---------------------------------------------------------------- */
  /* money                                                            */
  /* ---------------------------------------------------------------- */

  /** The till: two bright bell dings (reference: 880/1320), the mechanism
      clacking, and the drawer hitting its stop. Spends get one muted ding. */
  cash(actx, bank, rng, t0, lvl, out, o) {
    if (o?.spend) {
      const lp = biquad(actx, 'lowpass', 1900, 0.8);
      lp.connect(out);
      tone(actx, lp, 'square', 620, t0, 0.06, 0.3 * lvl);
      struckResonator(actx, bank, rng, t0 + 0.02, [
        { f: 2450, q: 24, g: 0.06 * lvl, decay: 0.03 },
      ], 0.0015).connect(out);
      return t0 + 0.3;
    }
    const bell = biquad(actx, 'lowpass', 5600, 0.7);
    bell.connect(out);
    tone(actx, bell, 'square', 880, t0, 0.055, 0.26 * lvl);
    tone(actx, bell, 'square', 1320, t0 + 0.062, 0.1, 0.26 * lvl);
    // The key strike, then the drawer: a metallic clack and a low wooden stop.
    struckResonator(actx, bank, rng, t0, [
      { f: 2450, q: 26, g: 0.1 * lvl, decay: 0.045 },
      { f: 5100, q: 18, g: 0.05 * lvl, decay: 0.025 },
    ], 0.002).connect(out);
    breath(actx, bank, rng, out, t0 + 0.08,
      { f: 1900, f1: 900, q: 0.8, dur: 0.1, level: 0.1 * lvl });
    tone(actx, out, 'sine', 72, t0 + 0.11, 0.1, 0.24 * lvl, { f1: 48, slide: 0.09 });
    return t0 + 0.45;
  },

  /* ---------------------------------------------------------------- */
  /* pickups — one chime per kind (pickup:collect)                    */
  /* ---------------------------------------------------------------- */

  /** Coin tink: two very short high dings, lighter than the register. */
  pickup_cash(actx, bank, rng, t0, lvl, out) {
    tone(actx, out, 'square', 1320, t0, 0.045, 0.2 * lvl);
    tone(actx, out, 'square', 1760, t0 + 0.05, 0.07, 0.17 * lvl);
    struckResonator(actx, bank, rng, t0, [
      { f: 5200, q: 30, g: 0.04 * lvl, decay: 0.04 },
    ], 0.0012).connect(out);
    return t0 + 0.25;
  },

  /** Warm rising swell (reference: 440 -> 880 sine) with a soft octave halo. */
  pickup_health(actx, bank, rng, t0, lvl, out) {
    tone(actx, out, 'sine', 440, t0, 0.24, 0.3 * lvl, { f1: 880, slide: 0.2, attack: 0.012 });
    tone(actx, out, 'triangle', 880, t0 + 0.12, 0.14, 0.1 * lvl, { attack: 0.02 });
    return t0 + 0.5;
  },

  /** Plate clunk-chime (reference: 330 -> 440 + 660): solid, a little metal. */
  pickup_armor(actx, bank, rng, t0, lvl, out) {
    tone(actx, out, 'triangle', 330, t0, 0.16, 0.28 * lvl, { f1: 440, slide: 0.14 });
    tone(actx, out, 'triangle', 660, t0 + 0.1, 0.1, 0.18 * lvl);
    struckResonator(actx, bank, rng, t0, [
      { f: 1900, q: 24, g: 0.05 * lvl, decay: 0.07 },
      { f: 3800, q: 18, g: 0.03 * lvl, decay: 0.05 },
    ], 0.002).connect(out);
    return t0 + 0.4;
  },

  /** Two flat taps (reference: 500/500) plus a mag-seat click. */
  pickup_ammo(actx, bank, rng, t0, lvl, out) {
    tone(actx, out, 'square', 500, t0, 0.05, 0.22 * lvl);
    tone(actx, out, 'square', 500, t0 + 0.08, 0.05, 0.22 * lvl);
    struckResonator(actx, bank, rng, t0 + 0.08, [
      { f: 2800, q: 28, g: 0.07 * lvl, decay: 0.03 },
    ], 0.0018).connect(out);
    return t0 + 0.3;
  },

  /** Pressurised bottle: a rising whine under a hiss of escaping gas. */
  pickup_nitro(actx, bank, rng, t0, lvl, out) {
    const bp = biquad(actx, 'bandpass', 1400, 1.1);
    bp.connect(out);
    tone(actx, bp, 'sawtooth', 300, t0, 0.2, 0.34 * lvl, { f1: 900, slide: 0.18, attack: 0.01 });
    breath(actx, bank, rng, out, t0,
      { type: 'highpass', f: 2600, dur: 0.16, level: 0.14 * lvl, attack: 0.012 });
    return t0 + 0.4;
  },

  /** Generic pickup (packages, crates): a 600 -> 1200 chirp. */
  pickup(actx, bank, rng, t0, lvl, out) {
    tone(actx, out, 'triangle', 600, t0, 0.16, 0.28 * lvl, { f1: 1200, slide: 0.14 });
    return t0 + 0.35;
  },

  /* ---------------------------------------------------------------- */
  /* missions                                                         */
  /* ---------------------------------------------------------------- */

  /** Three rising majors (reference: 392/523/659) over a quiet root pad. */
  mission_start(actx, bank, rng, t0, lvl, out) {
    const lp = biquad(actx, 'lowpass', 5200, 0.7);
    lp.connect(out);
    const notes = [392, 523, 659];
    for (let i = 0; i < notes.length; i++) {
      tone(actx, lp, 'triangle', notes[i], t0 + i * 0.09, 0.16, 0.24 * lvl, { attack: 0.004 });
    }
    tone(actx, out, 'sine', 98, t0, 0.42, 0.1 * lvl, { attack: 0.05 });
    return t0 + 0.75;
  },

  /** The win: a full major arpeggio to the octave (523/659/784/1047), a low
      C pad underneath and a sparkle of air over the last note. */
  mission_pass(actx, bank, rng, t0, lvl, out) {
    const lp = biquad(actx, 'lowpass', 6500, 0.7);
    lp.connect(out);
    const notes = [523, 659, 784, 1047];
    for (let i = 0; i < notes.length; i++) {
      const last = i === notes.length - 1;
      tone(actx, lp, 'triangle', notes[i], t0 + i * 0.1, last ? 0.5 : 0.28,
        (last ? 0.3 : 0.24) * lvl, { attack: 0.004 });
    }
    tone(actx, out, 'sine', 262, t0, 0.85, 0.11 * lvl, { attack: 0.1 });
    breath(actx, bank, rng, out, t0 + 0.28,
      { type: 'highpass', f: 6000, dur: 0.5, level: 0.05 * lvl, attack: 0.12 });
    return t0 + 1.2;
  },

  /** The fail: three grim descending saws (440/349/262) through a dark
      lowpass with a little drive, ending in a low thud. */
  mission_fail(actx, bank, rng, t0, lvl, out) {
    const lp = biquad(actx, 'lowpass', 1400, 0.9);
    const drv = shaper(actx, saturationCurve(2, 0.3), '2x');
    series(lp, drv).connect(out);
    const notes = [440, 349, 262];
    for (let i = 0; i < notes.length; i++) {
      tone(actx, lp, 'sawtooth', notes[i], t0 + i * 0.14, 0.26, 0.22 * lvl, { attack: 0.006 });
    }
    tone(actx, out, 'sine', 90, t0 + 0.28, 0.32, 0.24 * lvl, { f1: 45, slide: 0.3, attack: 0.004 });
    return t0 + 0.95;
  },

  /** The chapter card: not a melody — a sub boom, a dull bell strike and a
      breath of air. Cinematic punctuation that sits UNDER mission_start
      rather than fighting it when both fire on mission:start. */
  title_card(actx, bank, rng, t0, lvl, out) {
    tone(actx, out, 'sine', 82, t0, 0.5, 0.32 * lvl, { f1: 41, slide: 0.45, attack: 0.004 });
    tone(actx, out, 'triangle', 220, t0, 0.32, 0.16 * lvl);
    struckResonator(actx, bank, rng, t0, [
      { f: 520, q: 14, g: 0.07 * lvl, decay: 0.3 },
      { f: 1240, q: 18, g: 0.03 * lvl, decay: 0.15 },
    ], 0.003).connect(out);
    breath(actx, bank, rng, out, t0,
      { kind: 'pink', type: 'highpass', f: 900, dur: 0.4, level: 0.06 * lvl, attack: 0.15 });
    return t0 + 0.9;
  },

  /* ---------------------------------------------------------------- */
  /* the law                                                          */
  /* ---------------------------------------------------------------- */

  /** Star gained: two bright rising saw buzzes (reference: 600 -> 900 twice).
      Deliberately all top end — the siren-side stinger (sirens.js Tension)
      already swells 90 -> 460 Hz underneath this, so this cue lives an octave
      above it and reads as one sound with it, not an argument. */
  wanted_up(actx, bank, rng, t0, lvl, out) {
    const bp = biquad(actx, 'bandpass', 1500, 1.2);
    const drv = shaper(actx, saturationCurve(4, 0.3), '2x');
    series(bp, drv).connect(out);
    for (let i = 0; i < 2; i++) {
      tone(actx, bp, 'sawtooth', 600, t0 + i * 0.16, 0.14, 0.3 * lvl, { f1: 900, slide: 0.13 });
    }
    return t0 + 0.5;
  },

  /** Heat lost: a soft resolving pair falling to rest, with the air going
      out of it. The opposite gesture to wanted_up in every way. */
  wanted_clear(actx, bank, rng, t0, lvl, out) {
    tone(actx, out, 'triangle', 659, t0, 0.22, 0.22 * lvl, { attack: 0.01 });
    tone(actx, out, 'triangle', 523, t0 + 0.18, 0.34, 0.22 * lvl, { attack: 0.01 });
    breath(actx, bank, rng, out, t0,
      { f: 1200, f1: 500, dur: 0.4, level: 0.07 * lvl, attack: 0.05 });
    return t0 + 0.85;
  },

  /** BUSTED: four deadpan chromatic steps down (392/370/349/330) — the
      handcuffs version of a sad trombone — over a final cell-door thump. */
  busted(actx, bank, rng, t0, lvl, out) {
    const lp = biquad(actx, 'lowpass', 2400, 0.8);
    lp.connect(out);
    const notes = [392, 370, 349, 330];
    for (let i = 0; i < notes.length; i++) {
      tone(actx, lp, 'square', notes[i], t0 + i * 0.14, 0.2, 0.2 * lvl, { attack: 0.005 });
    }
    tone(actx, out, 'sine', 65, t0 + 0.42, 0.28, 0.26 * lvl, { attack: 0.004 });
    return t0 + 1.0;
  },

  /** WASTED: a four-note minor fall (330/262/196/131), saws
      under a lowpass that closes as it goes — the light going out. */
  wasted(actx, bank, rng, t0, lvl, out) {
    const lp = biquad(actx, 'lowpass', 2600, 0.9);
    const drv = shaper(actx, saturationCurve(1.5, 0.2), '2x');
    series(lp, drv).connect(out);
    sweep(lp.frequency, t0, 2600, 700, 1.0);
    const notes = [330, 262, 196, 131];
    for (let i = 0; i < notes.length; i++) {
      const last = i === notes.length - 1;
      tone(actx, lp, 'sawtooth', notes[i], t0 + i * 0.16, last ? 0.55 : 0.28,
        0.22 * lvl, { attack: 0.008 });
    }
    return t0 + 1.35;
  },

  /* ---------------------------------------------------------------- */
  /* services (game:service)                                          */
  /* ---------------------------------------------------------------- */

  /** One wrench stroke: an 1100 -> 700 chirp plus a real clink. */
  service_repair(actx, bank, rng, t0, lvl, out) {
    tone(actx, out, 'square', 1100, t0, 0.06, 0.16 * lvl, { f1: 700, slide: 0.055 });
    struckResonator(actx, bank, rng, t0 + 0.008, [
      { f: 3400, q: 30, g: 0.05 * lvl, decay: 0.03 },
    ], 0.0015).connect(out);
    return t0 + 0.2;
  },

  /** One pump stroke: a low glug and a soft puff of vapour. */
  service_fuel(actx, bank, rng, t0, lvl, out) {
    tone(actx, out, 'sine', 260, t0, 0.09, 0.22 * lvl, { f1: 170, slide: 0.08 });
    breath(actx, bank, rng, out, t0 + 0.01,
      { kind: 'brown', type: 'lowpass', f: 700, dur: 0.12, level: 0.12 * lvl, attack: 0.02 });
    return t0 + 0.3;
  },

  /** The receipt: two quick rising taps — done, paid, drive off. */
  service_done(actx, bank, rng, t0, lvl, out) {
    tone(actx, out, 'triangle', 660, t0, 0.06, 0.22 * lvl);
    tone(actx, out, 'triangle', 880, t0 + 0.07, 0.13, 0.24 * lvl);
    return t0 + 0.35;
  },

  /* ---------------------------------------------------------------- */
  /* HUD clicks — three SMALL, three DIFFERENT                        */
  /* ---------------------------------------------------------------- */

  /** Yes: a 520 -> 760 up-chirp. Bright, rising, done. */
  ui_confirm(actx, bank, rng, t0, lvl, out) {
    tone(actx, out, 'triangle', 520, t0, 0.08, 0.24 * lvl, { f1: 760, slide: 0.07 });
    return t0 + 0.2;
  },

  /** No: a low double bonk, flat and slightly falling. Nothing rises. */
  ui_deny(actx, bank, rng, t0, lvl, out) {
    const lp = biquad(actx, 'lowpass', 1200, 0.8);
    lp.connect(out);
    tone(actx, lp, 'square', 220, t0, 0.05, 0.22 * lvl);
    tone(actx, lp, 'square', 196, t0 + 0.07, 0.08, 0.22 * lvl);
    return t0 + 0.25;
  },

  /** The weapon wheel sliding open: a swish with a soft detent underneath. */
  wheel_open(actx, bank, rng, t0, lvl, out) {
    tone(actx, out, 'sine', 300, t0, 0.1, 0.16 * lvl, { f1: 520, slide: 0.09, attack: 0.012 });
    breath(actx, bank, rng, out, t0,
      { f: 900, f1: 3200, dur: 0.12, level: 0.1 * lvl, attack: 0.015 });
    return t0 + 0.3;
  },

  /** Attention without danger: a two-note high tap, below grenade_warn's
      three-beep panic in both count and contour. */
  ui_alert(actx, bank, rng, t0, lvl, out) {
    const lp = biquad(actx, 'lowpass', 5000, 0.8);
    lp.connect(out);
    tone(actx, lp, 'square', 1150, t0, 0.06, 0.2 * lvl);
    tone(actx, lp, 'square', 1450, t0 + 0.09, 0.06, 0.16 * lvl);
    return t0 + 0.25;
  },

  /* ---------------------------------------------------------------- */
  /* nitro                                                            */
  /* ---------------------------------------------------------------- */

  /** Engage: a 120 -> 900 saw scream through an opening filter,
      with the bottle hiss on top. The SUSTAIN while the button is held is a
      separate looped layer owned by index.js (_ensureNitroLoop); this is only
      the ignition transient. */
  nitro(actx, bank, rng, t0, lvl, out) {
    const bp = biquad(actx, 'bandpass', 400, 1.0);
    const drv = shaper(actx, saturationCurve(5, 0.4), '2x');
    series(bp, drv).connect(out);
    sweep(bp.frequency, t0, 400, 2400, 0.5);
    tone(actx, bp, 'sawtooth', 120, t0, 0.5, 0.4 * lvl, { f1: 900, slide: 0.5, attack: 0.01 });
    breath(actx, bank, rng, out, t0,
      { type: 'highpass', f: 2400, dur: 0.4, level: 0.14 * lvl, attack: 0.01 });
    return t0 + 0.9;
  },
};

/** Reverb send per id — the HUD clicks stay bone dry, the cards get air. */
const SEND = {
  mission_pass: 0.25, mission_fail: 0.25, mission_start: 0.2, title_card: 0.35,
  busted: 0.2, wasted: 0.25, wanted_clear: 0.15, nitro: 0.1,
};

export const JINGLE_IDS = Object.keys(JINGLES);

export function hasJingle(kind) {
  return Object.prototype.hasOwnProperty.call(JINGLES, kind);
}

/**
 * Build one jingle voice.
 * @param {object} o { when, level, spend }
 */
export function jingle(actx, bank, rng, kind, o = {}) {
  const t0 = o.when ?? actx.currentTime;
  const lvl = o.level ?? 1;
  const out = gain(actx, 1);
  const end = JINGLES[kind](actx, bank, rng, t0, lvl, out, o);
  return { node: out, end: end + 0.05, send: SEND[kind] ?? 0 };
}
