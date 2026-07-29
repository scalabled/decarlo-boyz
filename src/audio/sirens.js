/**
 * AUDIO / POLICE — sirens, dispatch chatter, and the pursuit layer
 *
 * A siren is a compression driver in an exponential horn, so it is modelled as
 * one: a harmonically rich carrier swept by a low-frequency shape, pushed
 * through the horn's passband and a pair of resonances, saturated by the driver
 * itself. That is why it cuts through a city the way a filtered sine never
 * does.
 *
 * The carrier frequency comes from a summing node:
 *
 *   centre (ConstantSource) ─┐
 *   sweep LFO -> depth      ─┴─► freqSum ─► doppler (gain) ─► carrier.frequency
 *
 * so the doppler ratio from the tracked emitter is ONE gain value and it scales
 * the whole sweep coherently — a cruiser passing you at 120 km/h drops a
 * musical third exactly as it should, and every harmonic drops with it.
 *
 * The pattern changes with the wanted level, the way a real unit escalates:
 *
 *   1*  wail          slow 0.28 Hz sweep, one unit
 *   2*  wail + yelp   yelp on the approach
 *   3*  yelp          3.6 Hz, urgent
 *   4*  yelp + hi-lo  alternating two-tone across units
 *   5*  + air horn    they are trying to move you off the road
 */

import {
  ad, biquad, clamp, gain, hit, lerp, mtof, osc, saturationCurve, series, shaper, sweep, to,
} from './dsp.js';
import { bark, barkFor } from './vox.js';

/** Horn driver: strong odd and even harmonics, rolled off hard past the 6th. */
const HORN_CACHE = new WeakMap();
function hornWave(actx) {
  let w = HORN_CACHE.get(actx);
  if (w) return w;
  const amps = [0, 1, 0.62, 0.44, 0.26, 0.16, 0.1, 0.06, 0.035, 0.02];
  const real = new Float32Array(amps.length);
  const imag = new Float32Array(amps.length);
  for (let k = 1; k < amps.length; k++) imag[k] = amps[k];
  w = actx.createPeriodicWave(real, imag, { disableNormalization: false });
  HORN_CACHE.set(actx, w);
  return w;
}

const PATTERNS = {
  wail: { rate: 0.28, shape: 'triangle', centre: 1050, depth: 420, duty: 1 },
  yelp: { rate: 3.6, shape: 'triangle', centre: 1150, depth: 380, duty: 1 },
  hilo: { rate: 1.9, shape: 'square', centre: 1000, depth: 300, duty: 1 },
  piercer: { rate: 8.5, shape: 'sawtooth', centre: 1350, depth: 260, duty: 1 },
};

/** One unit's siren. Built once and reused from a pool. */
class SirenVoice {
  constructor(actx, bank, rng) {
    this.actx = actx;
    this.rng = rng;
    this.nodes = [];
    this.out = gain(actx, 0);

    /* ---- frequency drive ------------------------------------------- */
    const centre = actx.createConstantSource();
    centre.offset.value = PATTERNS.wail.centre;
    const lfo = osc(actx, 'triangle', PATTERNS.wail.rate);
    const depth = gain(actx, PATTERNS.wail.depth);
    lfo.connect(depth);
    const freqSum = gain(actx, 1);
    centre.connect(freqSum);
    depth.connect(freqSum);
    const dop = gain(actx, 1);
    freqSum.connect(dop);
    centre.start(0);
    lfo.start(0);
    this._centre = centre;
    this._lfo = lfo;
    this._depth = depth;
    this._dop = dop;
    this.nodes.push(centre, lfo, depth, freqSum, dop);

    /* ---- two drivers, slightly apart -------------------------------- */
    const horn = gain(actx, 1);
    for (let i = 0; i < 2; i++) {
      const o = actx.createOscillator();
      o.setPeriodicWave(hornWave(actx));
      o.frequency.value = 0;
      o.detune.value = i === 0 ? -7 : 9;
      dop.connect(o.frequency);
      const g = gain(actx, i === 0 ? 0.6 : 0.45);
      o.connect(g); g.connect(horn);
      o.start(0);
      this.nodes.push(o, g);
    }

    /* ---- horn body -------------------------------------------------- */
    // Exponential horn: nothing below the cutoff gets out at all, and there are
    // two strong throat resonances that stay put while the tone sweeps under
    // them. That fixed formant over a moving tone is the sound.
    const hp = biquad(actx, 'highpass', 620, 0.9);
    const r1 = biquad(actx, 'peaking', 1500, 2.2, 9);
    const r2 = biquad(actx, 'peaking', 3100, 2.8, 6);
    const lp = biquad(actx, 'lowpass', 6800, 0.7);
    const drv = shaper(actx, saturationCurve(3.5, 0.4), '2x');
    series(horn, hp, r1, r2, lp, drv, this.out);
    this.nodes.push(horn, hp, r1, r2, lp);
    this._body = { r1, r2, hp };
    this._hornIn = horn;

    /* ---- air horn: a separate, much lower blast --------------------- */
    const air = osc(actx, 'sawtooth', 235);
    const airBP = biquad(actx, 'bandpass', 620, 1.1);
    const airG = gain(actx, 0);
    series(air, airBP, airG).connect(this.out);
    air.start(0);
    this._air = { osc: air, g: airG };
    this.nodes.push(air, airBP, airG);

    this.pattern = 'wail';
    this._level = 0;
    this.airTimer = 0;
    this.bank = bank;
  }

  setPattern(name, t) {
    const p = PATTERNS[name] ?? PATTERNS.wail;
    if (this.pattern === name) return;
    this.pattern = name;
    this._lfo.type = p.shape;
    to(this._lfo.frequency, p.rate, t, 0.05);
    to(this._centre.offset, p.centre, t, 0.08);
    to(this._depth.gain, p.depth, t, 0.08);
  }

  /** @param {number} doppler ratio from the tracked emitter */
  setState(level, doppler, dt, t) {
    this._level = level;
    to(this.out.gain, level, t, 0.08);
    to(this._dop.gain, doppler, t, 0.03);
    // The horn's throat resonances are a property of the horn, not the tone, so
    // they doppler-shift with it but do not sweep with the pattern.
    to(this._body.r1.frequency, 1500 * doppler, t, 0.05);
    to(this._body.r2.frequency, 3100 * doppler, t, 0.05);
    to(this._body.hp.frequency, 620 * doppler, t, 0.05);
    if (this.airTimer > 0) this.airTimer -= dt;
  }

  /** Two short blasts on the low horn. */
  airHorn(t, level = 1) {
    if (this.airTimer > 0) return;
    this.airTimer = this.rng.range(3.5, 9);
    for (let i = 0; i < 2; i++) {
      const st = t + i * 0.34;
      ad(this._air.g.gain, st, 0.55 * level, 0.02, 0.22);
    }
  }

  stop() {
    this._level = 0;
    to(this.out.gain, 0, this.actx.currentTime, 0.12);
  }

  dispose() {
    for (const n of this.nodes) {
      try { n.stop?.(); } catch { /* not a source */ }
      try { n.disconnect(); } catch { /* gone */ }
    }
    this.nodes.length = 0;
    try { this.out.disconnect(); } catch { /* noop */ }
  }
}

/* ------------------------------------------------------------------ */
/* Pursuit layer                                                       */
/* ------------------------------------------------------------------ */

/**
 * The music that arrives with the stars. A drone, a pulse and a top layer, all
 * driven continuously by the wanted level rather than switched between cues, so
 * losing a star is a decay and not an edit.
 */
class Tension {
  constructor(actx, bank, mixer, rng) {
    this.actx = actx;
    this.bank = bank;
    this.rng = rng;
    this.nodes = [];
    this.out = gain(actx, 0);
    this.out.connect(mixer.bus('music'));
    this.level = 0;
    this.target = 0;

    const root = 41; // F1 — the Furnace 101 root, so the city has one tonic

    /* drone: three detuned saws through a filter that opens with the level */
    const droneG = gain(actx, 0);
    const droneLP = biquad(actx, 'lowpass', 200, 3.5);
    series(droneG, droneLP).connect(this.out);
    for (let i = 0; i < 3; i++) {
      const o = osc(actx, 'sawtooth', mtof(root + (i === 2 ? 7 : 0)));
      o.detune.value = (i - 1) * 11;
      const g = gain(actx, i === 2 ? 0.3 : 0.5);
      o.connect(g); g.connect(droneG);
      o.start(0);
      this.nodes.push(o, g);
    }
    this._droneG = droneG;
    this._droneLP = droneLP;
    this.nodes.push(droneG, droneLP);

    /* a tritone above, only at 4 stars and up: the "they are serious" note */
    const dissG = gain(actx, 0);
    const dissLP = biquad(actx, 'lowpass', 2600, 1);
    series(dissG, dissLP).connect(this.out);
    for (const semi of [6, 13]) {
      const o = osc(actx, 'sawtooth', mtof(root + 24 + semi));
      o.detune.value = this.rng.range(-9, 9);
      const g = gain(actx, 0.3);
      o.connect(g); g.connect(dissG);
      o.start(0);
      this.nodes.push(o, g);
    }
    this._dissG = dissG;
    this.nodes.push(dissG, dissLP);

    /* pulse: scheduled, not an LFO, so its rate can step with the level */
    this.pulseTimer = 0;
    this.pulseOut = gain(actx, 1);
    this.pulseOut.connect(this.out);
    this.nodes.push(this.pulseOut);
  }

  setWanted(level) {
    this.target = clamp(level / 5, 0, 1);
  }

  /** A rising hit when a star is added — the only one-shot in the layer. */
  stinger(up) {
    const { actx, rng } = this;
    const t = actx.currentTime;
    const o = osc(actx, 'sawtooth', 110);
    const g = gain(actx, 0);
    const bp = biquad(actx, 'bandpass', 500, 1.2);
    const drv = shaper(actx, saturationCurve(5, 0.4), '2x');
    o.connect(g); series(g, bp, drv).connect(this.out);
    if (up) {
      sweep(o.frequency, t, 90, 460, 0.55);
      sweep(bp.frequency, t, 300, 2600, 0.55);
      ad(g.gain, t, 0.5, 0.3, 0.35);
    } else {
      sweep(o.frequency, t, 300, 70, 0.8);
      sweep(bp.frequency, t, 1800, 260, 0.8);
      ad(g.gain, t, 0.35, 0.02, 0.8);
    }
    o.start(t); o.stop(t + 1.5);
    void rng;
  }

  update(dt) {
    const t = this.actx.currentTime;
    // Rises fast, falls slowly: escaping should feel like it takes a while.
    const k = this.target > this.level ? dt * 1.1 : dt * 0.35;
    this.level += clamp(this.target - this.level, -k, k);
    const l = this.level;

    to(this.out.gain, l > 0.02 ? 0.5 : 0, t, 0.2);
    to(this._droneG.gain, 0.32 * l, t, 0.3);
    to(this._droneLP.frequency, lerp(90, 720, l), t, 0.4);
    to(this._dissG.gain, 0.10 * clamp((l - 0.55) * 2.4, 0, 1), t, 0.5);

    if (l < 0.12) return;
    this.pulseTimer -= dt;
    if (this.pulseTimer <= 0) {
      // 100 bpm at one star up to 168 at five, on the eighth.
      const bpm = lerp(100, 168, l);
      this.pulseTimer = 30 / bpm;
      const st = t + 0.02;
      const o = osc(this.actx, 'sine', 92);
      const g = gain(this.actx, 0);
      o.connect(g); g.connect(this.pulseOut);
      sweep(o.frequency, st, 110, 44, 0.06);
      ad(g.gain, st, 0.34 * l, 0.002, 0.12);
      o.start(st); o.stop(st + 0.25);
      if (l > 0.5 && this.rng.float() < 0.5) {
        const src = this.bank.source('white', this.rng, 1.1);
        const hp = biquad(this.actx, 'highpass', 5200, 0.8);
        const ng = gain(this.actx, 0);
        series(src, hp, ng).connect(this.pulseOut);
        hit(ng.gain, st + 30 / bpm, 0.06 * l, 0.03);
        src.start(st, src._offset, 0.4);
      }
    }
  }

  dispose() {
    for (const n of this.nodes) {
      try { n.stop?.(); } catch { /* noop */ }
      try { n.disconnect(); } catch { /* noop */ }
    }
    this.nodes.length = 0;
    try { this.out.disconnect(); } catch { /* noop */ }
  }
}

/* ------------------------------------------------------------------ */
/* Manager                                                             */
/* ------------------------------------------------------------------ */

const MAX_SIRENS = 4;

export class PoliceAudio {
  constructor(actx, bank, mixer, field, rng) {
    this.actx = actx;
    this.bank = bank;
    this.mixer = mixer;
    this.field = field;
    this.rng = rng;
    this.wanted = 0;
    this.tension = new Tension(actx, bank, mixer, rng.fork());
    this._pool = [];
    /** vehicle -> { voice, em, ttl } */
    this.units = new Map();
    this._chatterTimer = 6;
    this._nearest = 1e9;
    this.stats = { sirens: 0, wanted: 0 };
  }

  setWanted(level, prev) {
    const l = clamp(level | 0, 0, 5);
    if (l === this.wanted) return;
    const up = l > this.wanted;
    this.wanted = l;
    this.tension.setWanted(l);
    this.stats.wanted = l;
    if (l !== (prev ?? 0)) this.tension.stinger(up);
    if (l === 0) {
      for (const u of this.units.values()) u.voice.stop();
    } else if (up) {
      // Dispatch calls it in.
      this._chatterTimer = this.rng.range(0.6, 1.6);
    }
  }

  /** The siren pattern for this wanted level and this unit's index. */
  _pattern(i) {
    const w = this.wanted;
    if (w <= 1) return 'wail';
    if (w === 2) return i === 0 ? 'wail' : 'yelp';
    if (w === 3) return 'yelp';
    if (w === 4) return i % 2 === 0 ? 'yelp' : 'hilo';
    return i % 3 === 0 ? 'piercer' : i % 3 === 1 ? 'yelp' : 'hilo';
  }

  _take() {
    return this._pool.pop() ?? new SirenVoice(this.actx, this.bank, this.rng.fork());
  }

  _give(voice) {
    voice.stop();
    try { voice.out.disconnect(); } catch { /* noop */ }
    if (this._pool.length < MAX_SIRENS) this._pool.push(voice);
    else voice.dispose();
  }

  /**
   * @param {Array} units  vehicle records from VehicleAudio: {vehicle,x,y,z,dist}
   */
  update(dt, units) {
    const t = this.actx.currentTime;
    this.tension.update(dt);

    /* ---- retire units that are gone -------------------------------- */
    for (const [veh, u] of this.units) {
      u.seen = false;
      void veh;
    }

    let assigned = 0;
    this._nearest = 1e9;
    if (this.wanted > 0 && units) {
      for (let i = 0; i < units.length && assigned < MAX_SIRENS; i++) {
        const r = units[i];
        if (r.kind !== 'police') continue;
        if (r.dist > 220) continue;
        assigned++;
        this._nearest = Math.min(this._nearest, r.dist);
        let u = this.units.get(r.vehicle);
        if (!u) {
          const voice = this._take();
          const em = this.field.acquireTracked({
            x: r.x, y: r.y, z: r.z, bus: 'sirens', send: 0.5, gain: 1, priority: 0.9,
          });
          if (!em) { this._give(voice); continue; }
          this.field.attach(em, voice.out);
          u = { voice, em, seen: true };
          this.units.set(r.vehicle, u);
        }
        u.seen = true;
        u.voice.setPattern(this._pattern(assigned - 1), t);
        const ratio = this.field.motion(u.em, r.x, r.y, r.z, dt);
        u.voice.setState(0.5, ratio, dt, t);
        if (this.wanted >= 5 && r.dist < 40 && this.rng.float() < dt * 0.25) {
          u.voice.airHorn(t, 1);
        }
      }
    }

    for (const [veh, u] of this.units) {
      if (u.seen) continue;
      this.field.releaseTracked(u.em);
      this._give(u.voice);
      this.units.delete(veh);
    }
    this.stats.sirens = this.units.size;

    /* ---- the radio ducks under a close siren ----------------------- */
    if (this._nearest < 90) {
      this.mixer.duckBus('music', clamp(0.6 * (1 - this._nearest / 90), 0, 0.6), 0.25);
    }

    /* ---- dispatch chatter ------------------------------------------ */
    if (this.wanted > 0) {
      this._chatterTimer -= dt;
      if (this._chatterTimer <= 0) {
        this._chatterTimer = this.rng.range(7, 22) / clamp(this.wanted * 0.5, 0.5, 2.5);
        this._chatter();
      }
    }
  }

  /** Unit-to-dispatch traffic, over a filtered comms channel. */
  _chatter() {
    const kinds = ['spot', 'flank', 'advance', 'copy', 'suppress'];
    const kind = this.rng.pick(kinds);
    const v = bark(this.actx, this.bank, this.rng, {
      when: this.actx.currentTime + 0.05,
      bark: barkFor(kind, this.rng),
      f0: 96 + (this.rng.u32() % 34),
      radio: true,
      level: 0.9,
    });
    // Dispatch comes out of the dashboard, not out of the world.
    const g = gain(this.actx, 0.85);
    v.node.connect(g);
    g.connect(this.mixer.bus('voice'));
    this.mixer.duckBus('music', 0.45, 0.4);
    setTimeout(() => { try { g.disconnect(); } catch { /* noop */ } }, (v.end - this.actx.currentTime + 1) * 1000);
  }

  dispose() {
    for (const u of this.units.values()) {
      this.field.releaseTracked(u.em);
      u.voice.dispose();
    }
    this.units.clear();
    for (const v of this._pool) v.dispose();
    this._pool.length = 0;
    this.tension.dispose();
  }
}
