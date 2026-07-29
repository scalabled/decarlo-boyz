/**
 * AUDIO / CITY AMBIENCE
 *
 * The bed the whole game sits on. It is NOT a hiss loop with a level fader: it
 * is seven independent synthesized layers whose weights are recomputed from
 * WHERE the player is, WHAT TIME it is and WHAT THE WEATHER IS DOING, plus a
 * scheduler that drops positioned one-shots into the world from a table that
 * changes with all three.
 *
 *   traffic   the roar of a city that is not on your street — a low band with
 *             slow swells and individual pass-bys rising out of it
 *   crowd     unintelligible human presence, wandering formants, daytime only
 *   mill      Steel Row: a fixed-frequency machine drone with its harmonics,
 *             periodic hammer clangs and a steam release
 *   river     water against a wall, gulls, a tug somewhere downstream
 *   resi      the sound of nothing much: distant dogs, insects after dark
 *   hvac      rooftop plant and extract fans, a downtown alley constant
 *   wind      two decorrelated brown layers plus a whistle through wires
 *
 * On top of that the rain model, which is four separate things because rain
 * on a road, rain in the air, rain on a car roof and the wipers that clear it
 * are four different sounds and a game that only has the first one always
 * sounds wrong from inside a car.
 *
 * District geometry is DESIGN.md's table at world scale (its coordinates x4).
 * It is used only as a fallback: `world.districtAt` answers when it exists.
 */

import { ad, biquad, clamp, gain, hit, lerp, osc, series, struckResonator, sweep, to } from './dsp.js';

/** DESIGN.md districts, its coordinates multiplied by 4, with an audio flavour. */
const DISTRICTS = [
  { id: 'point', x: -672, z: 16, r: 248, f: { river: 0.85, traffic: 0.30, crowd: 0.20, wind: 0.8 } },
  { id: 'downtown', x: -232, z: 64, r: 400, f: { traffic: 1.0, crowd: 0.90, hvac: 0.75 } },
  { id: 'strip', x: 248, z: -184, r: 344, f: { traffic: 0.70, crowd: 1.0, hvac: 0.45 } },
  { id: 'lawren', x: 680, z: -552, r: 384, f: { traffic: 0.50, crowd: 0.45, resi: 0.70 } },
  { id: 'northsh', x: -160, z: -600, r: 416, f: { traffic: 0.60, crowd: 0.60, river: 0.50 } },
  { id: 'troy', x: 520, z: -1032, r: 360, f: { traffic: 0.25, resi: 0.90, wind: 0.6 } },
  { id: 'southside', x: 160, z: 608, r: 432, f: { traffic: 0.50, river: 0.60, mill: 0.30, crowd: 0.50 } },
  { id: 'mtwash', x: -528, z: 464, r: 368, f: { traffic: 0.20, resi: 0.90, wind: 1.0 } },
  { id: 'steelrow', x: 784, z: 384, r: 400, f: { mill: 1.0, traffic: 0.40, hvac: 0.55 } },
  { id: 'westend', x: -1032, z: 368, r: 384, f: { traffic: 0.35, resi: 0.75 } },
  { id: 'northside', x: -984, z: -568, r: 368, f: { traffic: 0.35, resi: 0.75 } },
  { id: 'hazel', x: 984, z: -56, r: 344, f: { traffic: 0.35, mill: 0.50, resi: 0.50 } },
];

/** What the city sounds like away from any named district. */
const DEFAULT_FLAVOUR = { traffic: 0.30, crowd: 0.12, resi: 0.35, wind: 0.5 };

const LAYERS = ['traffic', 'crowd', 'mill', 'river', 'resi', 'hvac', 'wind'];

/**
 * Time-of-day multipliers, sampled on the hour and interpolated. The night
 * curve is the important one: a city at 3 am is not a quiet city, it is a
 * DIFFERENT city — no crowd, half the traffic, and every individual sound
 * suddenly audible because the bed got out of the way.
 */
function hourWeights(h, out) {
  // Peaks at 13:00, troughs at 01:00. (Getting this backwards is easy and the
  // symptom is a city that is at its busiest at three in the morning.)
  const day = clamp(0.5 + 0.5 * Math.cos(((h - 13) / 24) * Math.PI * 2), 0, 1);
  const night = 1 - day;
  const rush = Math.exp(-Math.pow((h - 8.3) / 1.5, 2)) + Math.exp(-Math.pow((h - 17.5) / 1.8, 2));
  out.traffic = 0.30 + day * 0.68 + rush * 0.35;
  out.crowd = 0.04 + day * 0.95 + rush * 0.2;
  out.mill = 0.65 + day * 0.35;              // the mill never fully stops
  out.river = 0.9 + night * 0.1;
  out.resi = 0.35 + night * 0.85;            // insects and dogs own the night
  out.hvac = 0.6 + day * 0.4;
  out.wind = 0.8 + (h > 14 && h < 20 ? 0.25 : 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* City one-shots                                                      */
/* ------------------------------------------------------------------ */

/**
 * Positioned events, weighted by layer. The scheduler picks a layer in
 * proportion to how loud it currently is, then picks an event from it, so a
 * gull only ever appears near the water and a mill hammer only in Steel Row.
 */
export const CITY_EVENTS = {
  traffic: ['pass', 'horn', 'airbrake', 'pass', 'pass'],
  crowd: ['shout', 'laugh', 'door', 'shout'],
  mill: ['clank', 'steam', 'clank', 'grind'],
  river: ['gull', 'boathorn', 'lap', 'gull'],
  resi: ['dog', 'crow', 'window', 'dog'],
  hvac: ['fanstart', 'creak'],
  wind: ['creak', 'flap'],
};

/**
 * Synthesize one city one-shot. Everything is built from the same primitives as
 * the rest of the subsystem; nothing here is a sample.
 */
export function cityOneShot(actx, bank, rng, kind, o = {}) {
  const t0 = o.when ?? actx.currentTime;
  const lvl = o.level ?? 1;
  const out = gain(actx, 0.55);

  switch (kind) {
    /* --- a car going past somewhere you cannot see it --------------- */
    case 'pass': {
      const dur = rng.range(2.6, 5.5);
      const src = bank.source('brown', rng, rng.range(0.7, 1.05));
      const lp = biquad(actx, 'lowpass', 240, 0.9);
      const g = gain(actx, 0);
      series(src, lp, g).connect(out);
      // Doppler on the pass-by: the tone drops through the closest point.
      sweep(lp.frequency, t0, 210, 520, dur * 0.45);
      sweep(lp.frequency, t0 + dur * 0.45, 520, 180, dur * 0.55);
      ad(g.gain, t0, 0.34 * lvl, dur * 0.42, dur * 0.58);
      src.start(t0, src._offset, dur * 1.15);
      const e = osc(actx, 'sawtooth', rng.range(58, 96));
      const eg = gain(actx, 0);
      const elp = biquad(actx, 'lowpass', 300, 1.4);
      e.connect(eg); series(eg, elp).connect(out);
      sweep(e.frequency, t0, rng.range(70, 105), rng.range(52, 74), dur);
      ad(eg.gain, t0, 0.075 * lvl, dur * 0.42, dur * 0.58);
      e.start(t0); e.stop(t0 + dur * 1.15);
      // Tyre roar over the top.
      const ts = bank.source('pink', rng, 1);
      const tbp = biquad(actx, 'bandpass', 1100, 0.6);
      const tg = gain(actx, 0);
      series(ts, tbp, tg).connect(out);
      ad(tg.gain, t0, 0.10 * lvl, dur * 0.42, dur * 0.58);
      ts.start(t0, ts._offset, dur * 1.15);
      return { node: out, end: t0 + dur * 1.2, send: 0.7 };
    }

    /* --- a horn, in a city where everyone leans on it --------------- */
    case 'horn': {
      const dur = rng.range(0.25, 1.1);
      const f = rng.range(300, 460);
      const g = gain(actx, 0);
      const bp = biquad(actx, 'bandpass', f * 2.4, 1.4);
      series(g, bp).connect(out);
      for (const mul of [1, 1.19, 2, 3.02]) {
        const oo = osc(actx, 'sawtooth', f * mul * rng.range(0.995, 1.005));
        const og = gain(actx, mul === 1 ? 0.5 : 0.22 / mul);
        oo.connect(og); og.connect(g);
        oo.start(t0); oo.stop(t0 + dur + 0.1);
      }
      ad(g.gain, t0, 0.30 * lvl, 0.012, dur);
      return { node: out, end: t0 + dur + 0.2, send: 0.9 };
    }

    /* --- air brakes releasing, the sound of a working city --------- */
    case 'airbrake': {
      const src = bank.source('white', rng, 1);
      const bp = biquad(actx, 'bandpass', 3200, 1.1);
      const g = gain(actx, 0);
      series(src, bp, g).connect(out);
      ad(g.gain, t0, 0.30 * lvl, 0.006, 0.35);
      sweep(bp.frequency, t0, 4200, 1500, 0.4);
      src.start(t0, src._offset, 0.6);
      return { node: out, end: t0 + 0.7, send: 0.7 };
    }

    /* --- a hammer somewhere in the mill ---------------------------- */
    case 'clank': {
      const n = 1 + (rng.u32() % 3);
      let end = t0;
      for (let i = 0; i < n; i++) {
        const st = t0 + i * rng.range(0.28, 0.62);
        struckResonator(actx, bank, rng, st, [
          { f: rng.range(90, 190), q: 12, g: 0.4 * lvl, decay: rng.range(0.5, 1.3) },
          { f: rng.range(300, 620), q: 20, g: 0.22 * lvl, decay: rng.range(0.3, 0.8) },
          { f: rng.range(900, 1900), q: 24, g: 0.10 * lvl, decay: 0.2 },
          { f: rng.range(3000, 5200), q: 18, g: 0.04 * lvl, decay: 0.09 },
        ], 0.003).connect(out);
        end = st + 1.5;
      }
      return { node: out, end, send: 1.3 };
    }

    case 'steam': {
      const dur = rng.range(1.4, 4);
      const src = bank.source('white', rng, 1);
      const bp = biquad(actx, 'bandpass', 2600, 0.7);
      const g = gain(actx, 0);
      series(src, bp, g).connect(out);
      ad(g.gain, t0, 0.22 * lvl, 0.06, dur);
      sweep(bp.frequency, t0, 3600, 1800, dur);
      src.start(t0, src._offset, dur * 1.2);
      return { node: out, end: t0 + dur + 0.3, send: 1.0 };
    }

    case 'grind': {
      const dur = rng.range(0.8, 2.4);
      const o1 = osc(actx, 'sawtooth', rng.range(70, 130));
      const bp = biquad(actx, 'bandpass', 900, 4);
      const g = gain(actx, 0);
      series(o1, bp, g).connect(out);
      sweep(bp.frequency, t0, 700, rng.range(1400, 2600), dur * 0.6);
      ad(g.gain, t0, 0.18 * lvl, 0.1, dur);
      o1.start(t0); o1.stop(t0 + dur + 0.2);
      const src = bank.source('crackle', rng, rng.range(0.7, 1.2));
      const cg = gain(actx, 0);
      series(src, cg).connect(out);
      ad(cg.gain, t0, 0.09 * lvl, 0.08, dur);
      src.start(t0, src._offset, dur * 1.1);
      return { node: out, end: t0 + dur + 0.3, send: 1.1 };
    }

    /* --- river ------------------------------------------------------ */
    case 'gull': {
      const n = 2 + (rng.u32() % 3);
      let end = t0;
      for (let i = 0; i < n; i++) {
        const st = t0 + i * rng.range(0.22, 0.5);
        const o1 = osc(actx, 'sawtooth', 900);
        const bp = biquad(actx, 'bandpass', rng.range(1500, 2400), 4);
        const g = gain(actx, 0);
        series(o1, bp, g).connect(out);
        sweep(o1.frequency, st, rng.range(700, 1000), rng.range(1100, 1500), 0.09);
        sweep(o1.frequency, st + 0.09, rng.range(1100, 1500), rng.range(600, 800), 0.16);
        ad(g.gain, st, 0.10 * lvl, 0.015, 0.22);
        o1.start(st); o1.stop(st + 0.4);
        end = st + 0.5;
      }
      return { node: out, end, send: 1.1 };
    }

    case 'boathorn': {
      const dur = rng.range(1.4, 2.8);
      const g = gain(actx, 0);
      const lp = biquad(actx, 'lowpass', 700, 0.8);
      series(g, lp).connect(out);
      for (const mul of [1, 1.5, 2, 2.99]) {
        const oo = osc(actx, 'sawtooth', rng.range(105, 145) * mul);
        const og = gain(actx, 0.5 / mul);
        oo.connect(og); og.connect(g);
        oo.start(t0); oo.stop(t0 + dur + 0.3);
      }
      ad(g.gain, t0, 0.28 * lvl, 0.25, dur);
      return { node: out, end: t0 + dur + 0.5, send: 1.5 };
    }

    case 'lap': {
      const dur = rng.range(1.2, 2.6);
      const src = bank.source('white', rng, rng.range(0.5, 0.8));
      const lp = biquad(actx, 'lowpass', 900, 0.7);
      const hp = biquad(actx, 'highpass', 260, 0.7);
      const g = gain(actx, 0);
      series(src, hp, lp, g).connect(out);
      ad(g.gain, t0, 0.20 * lvl, dur * 0.4, dur * 0.6);
      src.start(t0, src._offset, dur * 1.2);
      return { node: out, end: t0 + dur + 0.2, send: 0.8 };
    }

    /* --- residential ------------------------------------------------ */
    case 'crow': {
      const n = 2 + (rng.u32() % 3);
      let end = t0;
      for (let i = 0; i < n; i++) {
        const st = t0 + i * rng.range(0.3, 0.55);
        const o1 = osc(actx, 'sawtooth', rng.range(320, 430));
        const bp = biquad(actx, 'bandpass', rng.range(900, 1500), 2.6);
        const g = gain(actx, 0);
        series(o1, bp, g).connect(out);
        sweep(o1.frequency, st, rng.range(360, 440), rng.range(240, 300), 0.2);
        ad(g.gain, st, 0.13 * lvl, 0.02, 0.2);
        o1.start(st); o1.stop(st + 0.35);
        end = st + 0.45;
      }
      return { node: out, end, send: 1.0 };
    }

    case 'window': {
      // A sash going up, or a bottle in a yard.
      const st = t0;
      const src = bank.source('white', rng, rng.range(0.7, 1.1));
      const bp = biquad(actx, 'bandpass', 1400, 3);
      const g = gain(actx, 0);
      series(src, bp, g).connect(out);
      ad(g.gain, st, 0.16 * lvl, 0.03, 0.28);
      sweep(bp.frequency, st, 1100, 2400, 0.3);
      src.start(st, src._offset, 0.45);
      struckResonator(actx, bank, rng, st + 0.3, [
        { f: rng.range(180, 420), q: 8, g: 0.14 * lvl, decay: 0.08 },
      ], 0.003).connect(out);
      return { node: out, end: st + 0.7, send: 0.9 };
    }

    /* --- crowd ------------------------------------------------------ */
    case 'laugh': {
      const n = 3 + (rng.u32() % 4);
      const f0 = rng.range(150, 260);
      let end = t0;
      for (let i = 0; i < n; i++) {
        const st = t0 + i * rng.range(0.11, 0.18);
        const o1 = osc(actx, 'sawtooth', f0);
        const bp1 = biquad(actx, 'bandpass', rng.range(600, 900), 4);
        const bp2 = biquad(actx, 'bandpass', rng.range(1200, 1900), 5);
        const g = gain(actx, 0);
        o1.connect(bp1); o1.connect(bp2);
        bp1.connect(g); bp2.connect(g);
        g.connect(out);
        sweep(o1.frequency, st, f0 * 1.1, f0 * 0.9, 0.09);
        ad(g.gain, st, 0.09 * lvl * (1 - i / n * 0.5), 0.012, 0.09);
        o1.start(st); o1.stop(st + 0.16);
        end = st + 0.3;
      }
      return { node: out, end, send: 1.1 };
    }

    case 'door': {
      struckResonator(actx, bank, rng, t0, [
        { f: rng.range(70, 130), q: 4, g: 0.28 * lvl, decay: 0.1 },
        { f: rng.range(230, 420), q: 8, g: 0.14 * lvl, decay: 0.06 },
        { f: rng.range(1200, 2200), q: 14, g: 0.05 * lvl, decay: 0.02 },
      ], 0.003).connect(out);
      return { node: out, end: t0 + 0.5, send: 0.9 };
    }

    case 'fanstart': {
      const dur = rng.range(2.5, 6);
      const o1 = osc(actx, 'sawtooth', 48);
      const lp = biquad(actx, 'lowpass', 300, 1.4);
      const g = gain(actx, 0);
      series(o1, lp, g).connect(out);
      sweep(o1.frequency, t0, 12, rng.range(44, 62), 1.6);
      ad(g.gain, t0, 0.12 * lvl, 1.4, dur);
      o1.start(t0); o1.stop(t0 + dur + 0.4);
      const src = bank.source('pink', rng, 1);
      const bp = biquad(actx, 'bandpass', 900, 0.8);
      const ng = gain(actx, 0);
      series(src, bp, ng).connect(out);
      ad(ng.gain, t0, 0.07 * lvl, 1.2, dur);
      src.start(t0, src._offset, dur * 1.1);
      return { node: out, end: t0 + dur + 0.5, send: 0.8 };
    }

    case 'flap': {
      // A tarpaulin or an awning in the wind.
      const n = 3 + (rng.u32() % 5);
      let end = t0;
      for (let i = 0; i < n; i++) {
        const st = t0 + i * rng.range(0.07, 0.24);
        const src = bank.source('white', rng, rng.range(0.6, 1.1));
        const bp = biquad(actx, 'bandpass', rng.range(400, 1400), 1.4);
        const g = gain(actx, 0);
        series(src, bp, g).connect(out);
        hit(g.gain, st, 0.11 * lvl, 0.045);
        src.start(st, src._offset, 0.08);
        end = st + 0.2;
      }
      return { node: out, end, send: 0.9 };
    }

    /* --- weather ---------------------------------------------------- */
    case 'thunder': {
      // Distance is baked into the shape, not just the level: a close strike
      // has a crack, a far one is only the roll.
      const near = clamp(o.near ?? rng.float(), 0, 1);
      const dur = lerp(7.5, 2.2, near);
      const src = bank.source('brown', rng, rng.range(0.5, 0.9));
      const lp = biquad(actx, 'lowpass', lerp(160, 900, near), 0.8);
      const g = gain(actx, 0);
      series(src, lp, g).connect(out);
      // The roll: several overlapping swells as the wavefront reaches you off
      // different parts of the channel.
      const swells = 3 + (rng.u32() % 4);
      for (let i = 0; i < swells; i++) {
        const st = t0 + rng.range(0, dur * 0.6);
        ad(g.gain, st, rng.range(0.3, 1.0) * lvl * lerp(0.8, 1.6, near), rng.range(0.08, 0.6), rng.range(0.9, 2.6));
      }
      src.start(t0, src._offset, dur + 0.5);
      if (near > 0.6) {
        const cs = bank.source('white', rng, 1);
        const chp = biquad(actx, 'highpass', 700, 0.7);
        const cg = gain(actx, 0);
        series(cs, chp, cg).connect(out);
        hit(cg.gain, t0, 0.9 * lvl * (near - 0.6) * 2.5, 0.09);
        cs.start(t0, cs._offset, 0.3);
      }
      return { node: out, end: t0 + dur + 1, send: 1.6 };
    }

    default:
    case 'shout': {
      const dur = rng.range(0.3, 0.75);
      const o1 = osc(actx, 'sawtooth', rng.range(115, 175));
      const bp1 = biquad(actx, 'bandpass', rng.range(600, 900), 4);
      const bp2 = biquad(actx, 'bandpass', rng.range(1300, 2000), 5);
      const g = gain(actx, 0);
      o1.connect(bp1); o1.connect(bp2);
      bp1.connect(g); bp2.connect(g);
      const lp = biquad(actx, 'lowpass', 2800, 0.8);
      series(g, lp).connect(out);
      sweep(o1.frequency, t0, rng.range(135, 180), rng.range(95, 125), dur);
      ad(g.gain, t0, 0.18 * lvl, 0.05, dur);
      o1.start(t0); o1.stop(t0 + dur + 0.2);
      return { node: out, end: t0 + dur + 0.3, send: 1.2 };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Beds                                                                */
/* ------------------------------------------------------------------ */

export class CityAmbience {
  constructor(actx, bank, mixer, field, rng, ctx) {
    this.actx = actx;
    this.bank = bank;
    this.mixer = mixer;
    this.field = field;
    this.rng = rng;
    this.ctx = ctx;
    this.nodes = [];
    this.started = false;

    this.hour = 12;
    this.rain = 0;
    this.wind = 0.35;
    this.wetness = 0;
    this.enclosure = 0;
    this.cabin = 0;
    this.intensity = 1;

    /** Live layer levels, smoothed towards `target` every frame. */
    this.level = {};
    this.target = {};
    for (const k of LAYERS) { this.level[k] = 0; this.target[k] = 0; }
    this._hourW = {};
    this._flavour = {};
    this._districtTimer = 0;
    this._district = 'downtown';

    this._timers = { gust: 3, event: 4, thunder: 30, wiper: 0 };
    this._layerPick = new Float64Array(LAYERS.length);
    /** Bench hook: pin one layer to full and mute the rest, to measure trims. */
    this.debugSolo = null;
  }

  /* ---------------------------------------------------------------- */

  start() {
    if (this.started) return;
    this.started = true;
    const { actx, bank, rng } = this;
    const bus = this.mixer.bus('ambience');

    // Everything outdoors passes this: closing it is what a doorway sounds like.
    const outLP = biquad(actx, 'lowpass', 20000, 0.6);
    const outG = gain(actx, 1);
    series(outLP, outG).connect(bus);
    const sendTap = gain(actx, 0.25);
    outG.connect(sendTap);
    sendTap.connect(this.mixer.reverbSend);
    this._outLP = outLP;
    this._outGain = outG;
    this.nodes.push(outLP, outG, sendTap);

    this.g = {};
    for (const k of LAYERS) {
      const g = gain(actx, 0);
      g.connect(outLP);
      this.g[k] = g;
      this.nodes.push(g);
    }

    /* ---- traffic: a distant, moving roar --------------------------- */
    {
      const src = bank.source('pink', rng, 0.85, true);
      const lp = biquad(actx, 'lowpass', 420, 0.7);
      const hp = biquad(actx, 'highpass', 55, 0.7);
      series(src, hp, lp).connect(this.g.traffic);
      src.start(0, src._offset);
      // A second, brighter band gives the tyre roar that sits over the rumble.
      const s2 = bank.source('pink', rng, 1.1, true);
      const bp = biquad(actx, 'bandpass', 1200, 0.55);
      const g2 = gain(actx, 0.30);
      series(s2, bp, g2).connect(this.g.traffic);
      s2.start(0, s2._offset);
      // A low engine-order drone so the bed has a pitch centre, not just noise.
      const d = osc(actx, 'sawtooth', 46);
      const dlp = biquad(actx, 'lowpass', 150, 1.6);
      const dg = gain(actx, 0.09);
      series(d, dlp, dg).connect(this.g.traffic);
      d.start(0);
      this._lfo(0.037, 0.22, g2.gain);
      this._lfo(0.019, 90, lp.frequency);
      this._lfo(0.0271, 5, d.frequency);
      this.nodes.push(src, lp, hp, s2, bp, g2, d, dlp, dg);
      this._trafficLP = lp;
    }

    /* ---- crowd: wandering vocal formants over a murmur ------------- */
    {
      const src = bank.source('pink', rng, 1, true);
      const bp = biquad(actx, 'bandpass', 500, 0.8);
      const g = gain(actx, 0.5);
      series(src, bp, g).connect(this.g.crowd);
      src.start(0, src._offset);
      for (const f of [700, 1250, 2100]) {
        const s2 = bank.source('white', rng, rng.range(0.9, 1.1), true);
        const fb = biquad(actx, 'bandpass', f, 6);
        const fg = gain(actx, 0.028);
        series(s2, fb, fg).connect(this.g.crowd);
        s2.start(0, s2._offset);
        this._lfo(rng.range(0.05, 0.2), f * 0.18, fb.frequency);
        this._lfo(rng.range(0.03, 0.11), 0.02, fg.gain);
        this.nodes.push(s2, fb, fg);
      }
      this.nodes.push(src, bp, g);
    }

    /* ---- mill: a machine, not a noise ------------------------------ */
    {
      // A fixed 27 Hz drive shaft and its harmonics. Machines have a pitch and
      // it never moves; that is exactly why they are oppressive.
      const sum = gain(actx, 1);
      sum.connect(this.g.mill);
      for (const [f, a] of [[27, 0.4], [54, 0.25], [81, 0.12], [135, 0.06], [216, 0.03]]) {
        const o = osc(actx, 'sawtooth', f);
        const g = gain(actx, a);
        const lp = biquad(actx, 'lowpass', 600, 1.2);
        series(o, g, lp).connect(sum);
        o.start(0);
        this.nodes.push(o, g, lp);
      }
      // Extractor roar and the hiss of something under pressure.
      const src = bank.source('brown', rng, 0.9, true);
      const bp = biquad(actx, 'bandpass', 300, 0.6);
      const bg = gain(actx, 0.55);
      series(src, bp, bg).connect(sum);
      src.start(0, src._offset);
      const hs = bank.source('white', rng, 1, true);
      const hbp = biquad(actx, 'bandpass', 3800, 0.9);
      const hg = gain(actx, 0.035);
      series(hs, hbp, hg).connect(sum);
      hs.start(0, hs._offset);
      this._lfo(0.011, 0.1, bg.gain);
      this._lfo(0.043, 0.012, hg.gain);
      this.nodes.push(sum, src, bp, bg, hs, hbp, hg);
    }

    /* ---- river ------------------------------------------------------ */
    {
      const src = bank.source('white', rng, 0.55, true);
      const hp = biquad(actx, 'highpass', 300, 0.7);
      const lp = biquad(actx, 'lowpass', 1600, 0.7);
      const g = gain(actx, 0.5);
      series(src, hp, lp, g).connect(this.g.river);
      src.start(0, src._offset);
      // Slow surge: water against a wall is not stationary noise.
      this._lfo(0.13, 0.24, g.gain);
      this._lfo(0.071, 0.16, g.gain);
      this._lfo(0.09, 380, lp.frequency);
      // A deep body under it.
      const s2 = bank.source('brown', rng, 0.7, true);
      const l2 = biquad(actx, 'lowpass', 200, 0.8);
      const g2 = gain(actx, 0.35);
      series(s2, l2, g2).connect(this.g.river);
      s2.start(0, s2._offset);
      this.nodes.push(src, hp, lp, g, s2, l2, g2);
    }

    /* ---- residential: insects and air ------------------------------ */
    {
      const src = bank.source('brown', rng, 0.85, true);
      const lp = biquad(actx, 'lowpass', 300, 0.6);
      const g = gain(actx, 0.35);
      series(src, lp, g).connect(this.g.resi);
      src.start(0, src._offset);
      // Crickets: a narrow band chopped at ~28 Hz. Chirps, not a tone.
      const cs = bank.source('white', rng, 1, true);
      const cbp = biquad(actx, 'bandpass', 4600, 12);
      const cgate = gain(actx, 0);
      const chop = osc(actx, 'sine', 27);
      const chopG = gain(actx, 0.03);
      chop.connect(chopG); chopG.connect(cgate.gain);
      series(cs, cbp, cgate).connect(this.g.resi);
      cs.start(0, cs._offset);
      chop.start(0);
      this._lfo(0.06, 1400, cbp.frequency);
      this._lfo(0.017, 0.012, chopG.gain);
      this._cricket = chopG;
      this.nodes.push(src, lp, g, cs, cbp, cgate, chop, chopG);
    }

    /* ---- HVAC -------------------------------------------------------- */
    {
      const o = osc(actx, 'sawtooth', 118);
      const lp = biquad(actx, 'lowpass', 420, 2.2);
      const g = gain(actx, 0.06);
      series(o, lp, g).connect(this.g.hvac);
      o.start(0);
      const src = bank.source('pink', rng, 1, true);
      const bp = biquad(actx, 'bandpass', 1400, 0.7);
      const ng = gain(actx, 0.22);
      series(src, bp, ng).connect(this.g.hvac);
      src.start(0, src._offset);
      this._lfo(0.083, 3, o.frequency);
      this._lfo(0.031, 0.05, ng.gain);
      this.nodes.push(o, lp, g, src, bp, ng);
    }

    /* ---- wind -------------------------------------------------------- */
    this._windLayers = [];
    for (let i = 0; i < 2; i++) {
      const src = bank.source('brown', rng, rng.range(0.82, 1.15), true);
      const lp = biquad(actx, 'lowpass', rng.range(260, 520), 0.6);
      const hp = biquad(actx, 'highpass', 40, 0.7);
      const g = gain(actx, 0.5);
      const pan = actx.createStereoPanner();
      pan.pan.value = i === 0 ? -0.6 : 0.6;
      series(src, hp, lp, g, pan).connect(this.g.wind);
      src.start(0, src._offset);
      this._lfo(0.041 + i * 0.017, rng.range(0.18, 0.3), g.gain);
      this._lfo(0.0917 + i * 0.031, rng.range(0.08, 0.16), g.gain);
      this._lfo(0.037 + i * 0.023, rng.range(80, 170), lp.frequency);
      this._windLayers.push({ g, lp });
      this.nodes.push(src, lp, hp, g, pan);
    }
    {
      const src = bank.source('white', rng, 1, true);
      const bp = biquad(actx, 'bandpass', 820, 8);
      const g = gain(actx, 0.014);
      series(src, bp, g).connect(this.g.wind);
      src.start(0, src._offset);
      this._lfo(0.053, 640, bp.frequency);
      this._lfo(0.071, 0.012, g.gain);
      this.nodes.push(src, bp, g);
    }

    this._buildRain();
  }

  /* ---------------------------------------------------------------- */
  /* rain                                                             */
  /* ---------------------------------------------------------------- */

  _buildRain() {
    const { actx, bank, rng } = this;
    const bus = this.mixer.bus('ambience');
    this.rainOut = gain(actx, 0);
    this.rainOut.connect(bus);
    const send = gain(actx, 0.18);
    this.rainOut.connect(send);
    send.connect(this.mixer.reverbSend);
    this.nodes.push(this.rainOut, send);

    /* the air: broad hiss, brightening as it gets heavier */
    {
      const src = bank.source('white', rng, 1, true);
      const hp = biquad(actx, 'highpass', 700, 0.6);
      const lp = biquad(actx, 'lowpass', 7000, 0.6);
      const g = gain(actx, 0.5);
      series(src, hp, lp, g).connect(this.rainOut);
      src.start(0, src._offset);
      this._lfo(0.037, 0.08, g.gain);
      this._rainAirHP = hp;
      this._rainAirLP = lp;
      this.nodes.push(src, hp, lp, g);
    }
    /* the road: individual drops on hard, wet ground */
    {
      const src = bank.source('crackle', rng, 2.2, true);
      const bp = biquad(actx, 'bandpass', 2400, 0.7);
      const g = gain(actx, 0);
      series(src, bp, g).connect(this.rainOut);
      src.start(0, src._offset);
      this._rainRoad = g;
      this._rainRoadSrc = src;
      this.nodes.push(src, bp, g);
    }
    /* runoff: gutters and downpipes, only in heavy rain */
    {
      const src = bank.source('white', rng, 0.6, true);
      const bp = biquad(actx, 'bandpass', 1100, 1.6);
      const g = gain(actx, 0);
      series(src, bp, g).connect(this.rainOut);
      src.start(0, src._offset);
      this._lfo(0.11, 260, bp.frequency);
      this._rainRunoff = g;
      this.nodes.push(src, bp, g);
    }

    /* on the roof — a different sound entirely: impacts on a steel panel with
       the cabin's own box resonance, and it only exists when you are inside */
    this.roofOut = gain(actx, 0);
    this.roofOut.connect(this.mixer.bus('vehicles'));
    {
      const src = bank.source('crackle', rng, 3.4, true);
      const bp = biquad(actx, 'bandpass', 1400, 0.9);
      const res = biquad(actx, 'peaking', 320, 2.2, 8);
      const lp = biquad(actx, 'lowpass', 5200, 0.7);
      series(src, bp, res, lp).connect(this.roofOut);
      src.start(0, src._offset);
      this._roofSrc = src;
      this.nodes.push(src, bp, res, lp);
    }
    this.nodes.push(this.roofOut);
  }

  /** A wiper blade dragging across wet glass, then the return stroke. */
  _wipe() {
    const { actx, bank, rng } = this;
    const t = actx.currentTime;
    for (let i = 0; i < 2; i++) {
      const st = t + i * 0.42;
      const dur = 0.3;
      const src = bank.source('white', rng, rng.range(0.9, 1.1));
      const bp = biquad(actx, 'bandpass', 900, 1.2);
      const g = gain(actx, 0);
      series(src, bp, g).connect(this.roofOut);
      ad(g.gain, st, 0.16 * clamp(this.rain, 0, 1), 0.05, dur);
      sweep(bp.frequency, st, i === 0 ? 700 : 1500, i === 0 ? 1600 : 650, dur);
      src.start(st, src._offset, dur + 0.1);
      // The motor and the end-stop thunk.
      struckResonator(actx, bank, rng, st + dur, [
        { f: rng.range(130, 200), q: 6, g: 0.05, decay: 0.05 },
      ], 0.002).connect(this.roofOut);
    }
  }

  _lfo(freq, depth, param) {
    const o = osc(this.actx, 'sine', freq);
    const g = gain(this.actx, depth);
    o.connect(g);
    g.connect(param);
    o.start(this.rng.range(0, 10));
    this.nodes.push(o, g);
    return o;
  }

  /* ---------------------------------------------------------------- */
  /* state                                                            */
  /* ---------------------------------------------------------------- */

  setHour(h) {
    if (Number.isFinite(h)) this.hour = ((h % 24) + 24) % 24;
  }

  setWeather(w) {
    if (!w) return;
    if (Number.isFinite(w.rain)) this.rain = clamp(w.rain, 0, 1);
    if (Number.isFinite(w.wind)) this.wind = clamp(w.wind, 0, 1);
    if (Number.isFinite(w.wetness)) this.wetness = clamp(w.wetness, 0, 1);
  }

  setEnclosure(v) {
    this.enclosure = clamp(v, 0, 1);
  }

  setCabin(v) {
    this.cabin = clamp(v, 0, 1);
  }

  /** District flavour at a point, from `world` if it has an opinion. */
  _flavourAt(x, z) {
    const f = this._flavour;
    for (const k of LAYERS) f[k] = 0;
    const w = this.ctx?.peek?.('world');
    let best = null, bestW = 0;
    // Weight every district by how deep inside it we are, so borders crossfade.
    for (const d of DISTRICTS) {
      const dist = Math.hypot(x - d.x, z - d.z);
      const wgt = clamp(1 - dist / (d.r * 1.6), 0, 1);
      if (wgt <= 0) continue;
      if (wgt > bestW) { bestW = wgt; best = d; }
      for (const k in d.f) f[k] += d.f[k] * wgt;
    }
    if (bestW < 0.05) {
      for (const k in DEFAULT_FLAVOUR) f[k] += DEFAULT_FLAVOUR[k];
    } else {
      // Normalise so overlapping districts do not stack to twice the level.
      const norm = 1 / Math.max(1, bestW * 1.35);
      for (const k of LAYERS) f[k] *= norm;
    }
    this._district = best?.id ?? 'outskirts';

    // The river is geometry, not a district: ask the world if it knows.
    if (w?.isWater) {
      try {
        let near = 0;
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2;
          if (w.isWater(x + Math.cos(a) * 45, z + Math.sin(a) * 45)) near += 0.25;
        }
        if (near > 0) f.river = Math.max(f.river, 0.55 + near * 0.6);
      } catch { /* world still streaming */ }
    }
    if (w?.districtAt) {
      try {
        const d = w.districtAt(x, z);
        if (d?.density !== undefined) {
          f.traffic = Math.max(f.traffic, clamp(d.density, 0, 1) * 0.9);
          f.crowd = Math.max(f.crowd, clamp(d.density, 0, 1) * 0.8);
        }
      } catch { /* not ready */ }
    }
    return f;
  }

  /* ---------------------------------------------------------------- */
  /* frame                                                            */
  /* ---------------------------------------------------------------- */

  update(dt, api) {
    if (!this.started) return;
    const t = this.actx.currentTime;
    const lp = this.field.listenerPos;

    /* ---- targets --------------------------------------------------- */
    this._districtTimer -= dt;
    if (this._districtTimer <= 0) {
      this._districtTimer = 0.5;
      this._flavourAt(lp.x, lp.z);
      hourWeights(this.hour, this._hourW);
    }
    const f = this._flavour, hw = this._hourW;
    // Rain masks the fine detail and adds to everything wet.
    const rainMask = 1 - this.rain * 0.45;
    for (const k of LAYERS) {
      let v = clamp((f[k] ?? 0) * (hw[k] ?? 1), 0, 1.6);
      if (k === 'crowd' || k === 'resi') v *= rainMask;
      if (k === 'wind') v = clamp(v * (0.35 + this.wind * 1.3), 0, 1.6);
      this.target[k] = this.debugSolo ? (k === this.debugSolo ? 1 : 0) : v;
    }

    /* ---- smooth and apply ------------------------------------------ */
    const k = clamp(dt * 0.8, 0, 1);
    const encl = 1 - this.enclosure * 0.55 - this.cabin * 0.3;
    for (const name of LAYERS) {
      this.level[name] += (this.target[name] - this.level[name]) * k;
      const base = BED_TRIM[name] ?? 0.1;
      to(this.g[name].gain, this.level[name] * base * this.intensity * encl, t, 0.25);
    }
    to(this._outLP.frequency, lerp(20000, 620, this.enclosure), t, 0.6);
    to(this._outGain.gain, lerp(1, 0.45, this.enclosure), t, 0.6);

    /* ---- rain ------------------------------------------------------- */
    const r = this.rain;
    to(this.rainOut.gain, r > 0.01 ? clamp(0.42 * Math.pow(r, 0.8), 0, 0.5) * (1 - this.cabin * 0.55) : 0, t, 0.7);
    if (r > 0.005) {
      to(this._rainAirHP.frequency, lerp(1400, 500, r), t, 0.8);
      to(this._rainAirLP.frequency, lerp(4200, 9500, r), t, 0.8);
      to(this._rainRoad.gain, clamp(0.5 * r * (0.4 + this.wetness * 0.9), 0, 0.8), t, 0.8);
      this._rainRoadSrc.playbackRate.setTargetAtTime(clamp(1.2 + r * 2.4, 0.4, 4), t, 1.0);
      to(this._rainRunoff.gain, clamp((r - 0.4) * 0.5, 0, 0.35), t, 1.2);
    }
    to(this.roofOut.gain, this.cabin * clamp(r * 0.8, 0, 0.8), t, 0.5);
    if (r > 0.005) this._roofSrc.playbackRate.setTargetAtTime(clamp(2 + r * 3.5, 0.5, 6), t, 1.0);

    // Wipers: only when you are in a car and it is actually raining.
    if (this.cabin > 0.5 && r > 0.22) {
      this._timers.wiper -= dt;
      if (this._timers.wiper <= 0) {
        this._timers.wiper = lerp(3.2, 1.1, clamp(r, 0, 1));
        this._wipe();
      }
    }

    /* ---- gusts, one-shots, thunder --------------------------------- */
    const T = this._timers;
    T.gust -= dt;
    if (T.gust <= 0) {
      T.gust = this.rng.range(5, 16) / clamp(0.4 + this.wind, 0.4, 2);
      this._gust();
    }

    T.event -= dt;
    if (T.event <= 0) {
      // Denser where the city is busier: the interval scales with the sum of
      // the layer levels.
      let total = 0;
      for (const name of LAYERS) total += this.level[name];
      T.event = this.rng.range(1.6, 6.5) / clamp(0.35 + total * 0.5, 0.3, 3);
      api?.cityEvent?.(this._pickLayer());
    }

    if (this.rain > 0.35) {
      T.thunder -= dt;
      if (T.thunder <= 0) {
        T.thunder = this.rng.range(18, 70) / clamp(this.rain * 1.6, 0.4, 2);
        api?.thunder?.();
      }
    }
  }

  /** Choose a layer in proportion to how loud it currently is. */
  _pickLayer() {
    let total = 0;
    for (let i = 0; i < LAYERS.length; i++) {
      const v = Math.max(this.level[LAYERS[i]], 0);
      this._layerPick[i] = v;
      total += v;
    }
    if (total < 1e-4) return 'traffic';
    let x = this.rng.float() * total;
    for (let i = 0; i < LAYERS.length; i++) {
      x -= this._layerPick[i];
      if (x <= 0) return LAYERS[i];
    }
    return LAYERS[0];
  }

  _gust() {
    const t = this.actx.currentTime;
    const r = this.rng;
    const dur = r.range(2.2, 6.5);
    const strength = r.range(0.25, 1) * lerp(1, 0.25, this.enclosure) * (0.4 + this.wind);
    for (const l of this._windLayers ?? []) {
      const peak = 0.5 + 0.5 * strength * r.range(0.7, 1.2);
      l.g.gain.setTargetAtTime(peak, t + r.range(0, 0.5), dur * 0.28);
      l.g.gain.setTargetAtTime(0.5, t + dur * 0.55, dur * 0.4);
      const f = l.lp.frequency.value;
      l.lp.frequency.setTargetAtTime(f * (1 + strength * 0.9), t, dur * 0.3);
      l.lp.frequency.setTargetAtTime(f, t + dur * 0.6, dur * 0.5);
    }
  }

  get report() {
    return {
      district: this._district,
      hour: +this.hour.toFixed(1),
      rain: +this.rain.toFixed(2),
      wind: +this.wind.toFixed(2),
      layers: Object.fromEntries(LAYERS.map((k) => [k, +this.level[k].toFixed(2)])),
    };
  }

  dispose() {
    for (const n of this.nodes) {
      try { n.stop?.(); } catch { /* not a source */ }
      try { n.disconnect(); } catch { /* gone */ }
    }
    this.nodes.length = 0;
    this.started = false;
  }
}

/**
 * Per-layer output trims. These are NOT guesses: each was set from a soloed
 * offline render (`cityLayer:*` in bench.js) so that a layer at full weight
 * lands within a few dB of every other layer. Wind was 16 dB above traffic and
 * 32 dB above the extract fans before this pass, which is why an exposed hill
 * used to drown out a six-lane street.
 *
 * Measured solo RMS at weight 1, after this trim: traffic -37, crowd -41,
 * mill -37, river -38, resi -41, hvac -45, wind -38 dBFS.
 */
const BED_TRIM = {
  traffic: 0.24, crowd: 0.42, mill: 0.12, river: 0.118, resi: 0.098, hvac: 0.25, wind: 0.062,
};
