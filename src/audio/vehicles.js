/**
 * AUDIO / VEHICLES
 *
 * Everything a moving vehicle radiates, and the bookkeeping that keeps a city
 * full of them inside the voice budget.
 *
 * Per vehicle:
 *   engine      EngineVoice (see engine.js) — the harmonic order model
 *   tyres       roll noise: broadband coloured by the surface, plus a tread
 *               tone at the block-passing frequency, plus wet spray
 *   wind        speed^2 noise, only worth synthesizing for the car you are in
 *               and for open vehicles (the bike, the boat)
 *   chassis     suspension and body knocks, triggered from vertical jerk
 *   skid        a stick-slip squeal that RAMPS with `vehicle:skid` rather than
 *               firing a one-shot per event — a car in a long drift emits
 *               dozens of skid events a second and one-shots would machine-gun
 *   impacts     `vehicle:collision`, scaled by impulse: panel deformation,
 *               glass, and debris
 *
 * Budget: the nearest `FULL_VOICES` vehicles get the complete model, the next
 * `LOD_VOICES` get a cheap two-oscillator version with equal-power panning, and
 * everything past that is silent. The player's own vehicle is always full
 * detail and is routed dry through a cabin EQ rather than through a panner,
 * because a HRTF-panned source 40 cm from the listener's head is a mess.
 */

import {
  biquad, clamp, gain, hit, lerp, osc, saturationCurve, series, shaper, struckResonator, to,
} from './dsp.js';
import { EngineVoice, resolveEngine } from './engine.js';

const FULL_VOICES = 5;
const LOD_VOICES = 6;
const MAX_TRACKED = FULL_VOICES + LOD_VOICES;
const CULL_DIST = 165;

/**
 * Tyre/road coupling per surface. `f` is the roll-noise centre, `q` its
 * width, `grit` the amount of impulsive grain, `squeal` how much the surface
 * can actually squeal (gravel cannot), `roar` the broadband level.
 */
const ROAD = {
  asphalt: { f: 900, q: 0.55, grit: 0.10, squeal: 1.0, roar: 1.0, tread: 1.0 },
  concrete: { f: 1250, q: 0.5, grit: 0.14, squeal: 0.9, roar: 1.1, tread: 1.15 },
  sidewalk: { f: 1100, q: 0.6, grit: 0.2, squeal: 0.7, roar: 0.95, tread: 1.0 },
  metal: { f: 1800, q: 0.9, grit: 0.05, squeal: 0.5, roar: 0.85, tread: 1.6 },
  wood: { f: 620, q: 0.7, grit: 0.24, squeal: 0.35, roar: 0.9, tread: 0.7 },
  gravel: { f: 1500, q: 0.35, grit: 1.0, squeal: 0.06, roar: 1.35, tread: 0.15 },
  dirt: { f: 620, q: 0.45, grit: 0.7, squeal: 0.05, roar: 1.15, tread: 0.1 },
  sand: { f: 480, q: 0.4, grit: 0.55, squeal: 0.02, roar: 1.05, tread: 0.05 },
  grass: { f: 700, q: 0.5, grit: 0.45, squeal: 0.03, roar: 0.85, tread: 0.08 },
  foliage: { f: 900, q: 0.5, grit: 0.6, squeal: 0.02, roar: 0.8, tread: 0.05 },
  water: { f: 420, q: 0.35, grit: 0.2, squeal: 0, roar: 1.5, tread: 0 },
  rubber: { f: 800, q: 0.6, grit: 0.05, squeal: 1.1, roar: 0.9, tread: 0.9 },
  glass: { f: 2400, q: 0.8, grit: 0.02, squeal: 0.8, roar: 0.7, tread: 1.2 },
};
function road(s) {
  return ROAD[s] ?? ROAD.asphalt;
}

/** Per-class tyre and body character. Scales what the shared model produces. */
const CHASSIS = {
  sports: { tyreW: 1.25, radius: 0.345, blocks: 58, roll: 1.0, wind: 1.15, body: 'steel', mass: 1.0 },
  muscle: { tyreW: 1.35, radius: 0.37, blocks: 52, roll: 1.15, wind: 1.0, body: 'steel', mass: 1.25 },
  sedan: { tyreW: 1.0, radius: 0.33, blocks: 62, roll: 0.9, wind: 0.9, body: 'steel', mass: 1.1 },
  van: { tyreW: 1.1, radius: 0.36, blocks: 56, roll: 1.2, wind: 1.35, body: 'panel', mass: 1.6 },
  truck: { tyreW: 1.9, radius: 0.52, blocks: 38, roll: 1.8, wind: 1.5, body: 'panel', mass: 2.6 },
  police: { tyreW: 1.1, radius: 0.34, blocks: 60, roll: 0.95, wind: 0.95, body: 'steel', mass: 1.15 },
  bike: { tyreW: 0.42, radius: 0.31, blocks: 34, roll: 0.45, wind: 2.2, body: 'thin', mass: 0.45 },
  boat: { tyreW: 0, radius: 1, blocks: 0, roll: 0, wind: 1.4, body: 'hull', mass: 1.4 },
};
function chassis(kind) {
  return CHASSIS[kind] ?? CHASSIS.sedan;
}

/* ------------------------------------------------------------------ */
/* Rolling / wind / skid voice                                         */
/* ------------------------------------------------------------------ */

/**
 * The non-engine half of a vehicle: everything driven by road speed rather
 * than by crank speed. Built once, reused, and silent when parked.
 */
class RollVoice {
  constructor(actx, bank, rng, spec) {
    this.actx = actx;
    this.rng = rng;
    this.spec = spec;
    this.nodes = [];
    this.out = gain(actx, 1);

    /* ---- roll: the contact patch shearing the road ---------------- */
    const src = bank.source('pink', rng, rng.range(0.9, 1.1), true);
    const bp = biquad(actx, 'bandpass', 900, 0.55);
    const g = gain(actx, 0);
    series(src, bp, g).connect(this.out);
    src.start(0, src._offset);
    this._rollBP = bp;
    this._rollGain = g;
    this.nodes.push(src, bp, g);

    /* ---- tread: the block-passing tone ----------------------------- */
    // A tyre's tread blocks slap the road at speed/(2*pi*r) * blocks Hz. It is
    // why a lorry hums and a slick does not, and it is the cheapest way to make
    // rolling read as rolling rather than as hiss.
    const ts = bank.source('white', rng, rng.range(0.9, 1.15), true);
    const tbp = biquad(actx, 'bandpass', 300, 7);
    const tg = gain(actx, 0);
    series(ts, tbp, tg).connect(this.out);
    ts.start(0, ts._offset);
    this._treadBP = tbp;
    this._treadGain = tg;
    this.nodes.push(ts, tbp, tg);

    /* ---- grit: loose surfaces spitting stones --------------------- */
    const gs = bank.source('crackle', rng, rng.range(0.8, 1.2), true);
    const gbp = biquad(actx, 'bandpass', 2600, 0.8);
    const gg = gain(actx, 0);
    series(gs, gbp, gg).connect(this.out);
    gs.start(0, gs._offset);
    this._gritRate = gs;
    this._gritGain = gg;
    this.nodes.push(gs, gbp, gg);

    /* ---- spray: standing water off the tread ---------------------- */
    const ws = bank.source('white', rng, rng.range(0.9, 1.1), true);
    const whp = biquad(actx, 'highpass', 2200, 0.6);
    const wg = gain(actx, 0);
    series(ws, whp, wg).connect(this.out);
    ws.start(0, ws._offset);
    this._sprayHP = whp;
    this._sprayGain = wg;
    this.nodes.push(ws, whp, wg);

    /* ---- wind: pressure over the screen and the mirrors ----------- */
    const nd = bank.source('brown', rng, rng.range(0.85, 1.15), true);
    const nhp = biquad(actx, 'highpass', 140, 0.6);
    const nlp = biquad(actx, 'lowpass', 2400, 0.7);
    const ng = gain(actx, 0);
    series(nd, nhp, nlp, ng).connect(this.out);
    nd.start(0, nd._offset);
    // Buffeting: an open window or a bike helmet booms at a few Hz.
    const buf = osc(actx, 'sine', 3.7);
    const bufG = gain(actx, 0);
    buf.connect(bufG); bufG.connect(ng.gain);
    buf.start(0);
    this._windHP = nhp;
    this._windLP = nlp;
    this._windGain = ng;
    this._windBuffet = bufG;
    this.nodes.push(nd, nhp, nlp, ng, buf, bufG);

    /* ---- skid: stick-slip on the limit ---------------------------- */
    // Two high-Q bands (a tyre squeals with a fundamental and a strong upper
    // partial) plus an amplitude flutter — the stick-slip cycle — which is
    // what makes it a squeal instead of a whistle.
    const ss = bank.source('white', rng, 1, true);
    const sk1 = biquad(actx, 'bandpass', 1150, 17);
    const sk2 = biquad(actx, 'bandpass', 2600, 12);
    const sm = gain(actx, 1);
    const sg = gain(actx, 0);
    ss.connect(sk1); ss.connect(sk2);
    sk1.connect(sm); sk2.connect(sm);
    const sdrv = shaper(actx, saturationCurve(3, 0.3), '2x');
    series(sm, sdrv, sg).connect(this.out);
    ss.start(0, ss._offset);
    const flut = osc(actx, 'sawtooth', 34);
    const flutG = gain(actx, 0);
    flut.connect(flutG); flutG.connect(sm.gain);
    flut.start(0);
    this._skid = { k1: sk1, k2: sk2, g: sg, flut, flutG };
    this.nodes.push(ss, sk1, sk2, sm, sdrv, sg, flut, flutG);

    this.skid = 0;         // 0..1, driven by vehicle:skid, decays on its own
    this.skidPitch = 1;
    this._surface = ROAD.asphalt;
  }

  setSurface(s) {
    this._surface = road(s);
  }

  /**
   * @param {number} speed  m/s
   * @param {number} wet    0..1 road wetness
   * @param {number} inCabin 0..1 — cabin glass kills the tyre top end
   */
  setState(speed, wet, dt, inCabin = 0, dopplerRatio = 1) {
    const t = this.actx.currentTime;
    const c = this.spec;
    const r = this._surface;
    const v = clamp(speed, 0, 90);
    const vn = clamp(v / 40, 0, 2.2);
    const cab = 1 - inCabin * 0.55;

    /* roll */
    const rollLvl = c.tyreW * r.roar * 0.30 * Math.pow(vn, 1.35) * cab;
    to(this._rollGain.gain, rollLvl, t, 0.06);
    to(this._rollBP.frequency, clamp(r.f * (0.55 + vn * 0.55) * dopplerRatio, 60, 16000), t, 0.08);
    this._rollBP.Q.setTargetAtTime(r.q, t, 0.2);

    /* tread tone */
    const treadF = (v / (2 * Math.PI * c.radius)) * c.blocks * dopplerRatio;
    to(this._treadGain.gain, c.tyreW * r.tread * 0.055 * clamp(vn, 0, 1.4) * (1 - wet * 0.5) * cab, t, 0.07);
    to(this._treadBP.frequency, clamp(treadF, 40, 15000), t, 0.05);

    /* grit + spray */
    to(this._gritGain.gain, r.grit * c.tyreW * 0.20 * Math.pow(vn, 1.2) * cab, t, 0.08);
    this._gritRate.playbackRate.setTargetAtTime(clamp(0.5 + vn * 1.1, 0.2, 3), t, 0.1);
    to(this._sprayGain.gain, wet * c.tyreW * 0.12 * Math.pow(vn, 1.5) * cab, t, 0.1);
    to(this._sprayHP.frequency, clamp(1600 + vn * 2600, 400, 14000), t, 0.15);

    /* wind */
    const windLvl = c.wind * 0.055 * Math.pow(vn, 2.0);
    to(this._windGain.gain, windLvl, t, 0.08);
    to(this._windHP.frequency, clamp(110 + vn * 260, 60, 4000), t, 0.12);
    to(this._windLP.frequency, clamp(900 + vn * 4200, 300, 16000), t, 0.12);
    to(this._windBuffet.gain, windLvl * 0.45 * (c.wind > 1.3 ? 1 : 0.3), t, 0.2);

    /* skid */
    this.skid = Math.max(0, this.skid - dt * 2.6);
    const sq = this.skid * r.squeal;
    to(this._skid.g.gain, sq * 0.34, t, sq > 0.02 ? 0.02 : 0.09);
    if (sq > 0.005) {
      // Squeal pitch climbs with slip and with speed; the flutter rate with it.
      const f = clamp((820 + this.skidPitch * 620 + v * 9) * dopplerRatio, 300, 5200);
      to(this._skid.k1.frequency, f, t, 0.05);
      to(this._skid.k2.frequency, f * 2.31, t, 0.05);
      to(this._skid.flut.frequency, clamp(22 + this.skidPitch * 46, 8, 140), t, 0.06);
      to(this._skid.flutG.gain, 0.55, t, 0.05);
    }
  }

  /** A `vehicle:skid` event: push the squeal up rather than firing a one-shot. */
  addSkid(slip, dt) {
    const s = clamp(slip, 0, 1);
    this.skid = clamp(Math.max(this.skid, s * 0.9) + s * dt * 3, 0, 1);
    this.skidPitch = lerp(this.skidPitch, s, 0.25);
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
/* Manager                                                             */
/* ------------------------------------------------------------------ */

export class VehicleAudio {
  constructor(actx, bank, mixer, field, rng, ctx) {
    this.actx = actx;
    this.bank = bank;
    this.mixer = mixer;
    this.field = field;
    this.rng = rng;
    this.ctx = ctx;

    /** vehicle handle -> record. Entries are created on first event only. */
    this.records = new Map();
    this._pool = new Map();          // `${label}:${full}` -> EngineVoice[]
    this._rollPool = new Map();      // kind -> RollVoice[]
    this._order = [];                // scratch: records sorted by distance
    this._scratch = { x: 0, y: 0, z: 0 };
    // Voices are faded before they are unplugged. Cutting a running oscillator
    // out of the graph is a step discontinuity, and at city scale that is a
    // click every time a car crosses an LOD boundary.
    this._deferred = [];

    this.own = null;                 // the vehicle the player is in
    this.wet = 0;
    this.cabin = 0;                  // 0..1, how sealed the player's cabin is
    this._surfCursor = 0;
    this._collideBudget = 0;

    /* The player's own vehicle bypasses the panner: dry, with the firewall and
       the seat between them and the engine. */
    this.cabinIn = gain(actx, 1);
    this._cabinLP = biquad(actx, 'lowpass', 4200, 0.7);
    this._cabinLS = biquad(actx, 'lowshelf', 160, 0.7, 5);
    this._cabinNotch = biquad(actx, 'peaking', 340, 1.1, -4);
    this._cabinGain = gain(actx, 1);
    series(this.cabinIn, this._cabinLP, this._cabinLS, this._cabinNotch, this._cabinGain)
      .connect(mixer.bus('vehicles'));
    const send = gain(actx, 0.06);
    this._cabinGain.connect(send);
    send.connect(mixer.busSend('vehicles'));
    this._cabinSend = send;

    this.stats = { records: 0, full: 0, lod: 0, silent: 0 };
  }

  /* ---------------------------------------------------------------- */
  /* records                                                          */
  /* ---------------------------------------------------------------- */

  _kindOf(vehicle, payload) {
    return (
      payload?.class ?? payload?.kind ?? vehicle?.audio ??
      vehicle?.spec?.id ?? vehicle?.type ?? vehicle?.kind ?? vehicle?.id ?? 'sedan'
    );
  }

  /** Best-effort world position of a vehicle handle from any subsystem shape. */
  _posOf(v, out) {
    const p = v?.position ?? v?.object3D?.position ?? v?.mesh?.position ?? v?.body?.position ??
      v?.root?.position ?? v?.pos;
    if (p && Number.isFinite(p.x + p.y + p.z)) {
      out.x = p.x; out.y = p.y; out.z = p.z;
      return true;
    }
    return false;
  }

  _record(vehicle, payload) {
    if (!vehicle) return null;
    let r = this.records.get(vehicle);
    if (r) return r;
    const kindRaw = this._kindOf(vehicle, payload);
    const kind = String(kindRaw).toLowerCase();
    r = {
      vehicle,
      kind,
      profile: resolveEngine(kindRaw),
      // The chassis table is keyed by the same ids as the engine profiles, so
      // an unrecognised vehicle gets sedan chassis and a sedan engine together.
      chassis: chassis(kind),
      engine: null, roll: null, em: null, detail: 'silent',
      x: 0, y: 0, z: 0, dist: 1e9, hasPos: false,
      state: { rpm: 0, throttle: 0, gear: 1, load: 0, speed: 0, redline: undefined, idle: undefined },
      surface: 'asphalt', prevVy: 0, prevY: 0, knockCool: 0,
      idleTimeout: 0, own: false, doppler: 1,
    };
    this.records.set(vehicle, r);
    return r;
  }

  /* ---------------------------------------------------------------- */
  /* events                                                           */
  /* ---------------------------------------------------------------- */

  onEngine(p) {
    if (!p?.vehicle) return;
    const r = this._record(p.vehicle, p);
    if (!r) return;
    const s = r.state;
    if (Number.isFinite(p.rpm)) s.rpm = p.rpm;
    if (Number.isFinite(p.throttle)) s.throttle = p.throttle;
    if (Number.isFinite(p.gear)) s.gear = p.gear;
    if (Number.isFinite(p.load)) s.load = p.load;
    if (Number.isFinite(p.speed)) s.speed = Math.abs(p.speed);
    if (Number.isFinite(p.redline)) s.redline = p.redline;
    if (Number.isFinite(p.idle)) s.idle = p.idle;
    if (p.position && Number.isFinite(p.position.x)) {
      r.x = p.position.x; r.y = p.position.y; r.z = p.position.z; r.hasPos = true;
    }
    r.idleTimeout = 1.5;
  }

  onSkid(p) {
    if (!p?.vehicle) return;
    const r = this.records.get(p.vehicle);
    if (!r?.roll) return;
    if (p.surface) r.roll.setSurface(p.surface);
    r.roll.addSkid(p.slip ?? 0.5, 1 / 60);
    r.idleTimeout = Math.max(r.idleTimeout, 1.0);
  }

  onEnter(p) {
    if (!p?.vehicle) return;
    const r = this._record(p.vehicle, p);
    if (!r) return;
    // Only the local player claims the cabin; a ped getting into a car does not
    // put the camera inside it.
    if (p.actor && p.actor !== 'player' && p.actor?.isPlayer !== true) {
      const player = this.ctx?.peek?.('player');
      if (player && p.actor !== player) return;
    }
    if (this.own && this.own !== r) this._setOwn(this.own, false);
    this.own = r;
    this._setOwn(r, true);
    this.doorSound(r, true);
  }

  onExit(p) {
    if (!p?.vehicle) return;
    const r = this.records.get(p.vehicle);
    if (r && this.own === r) {
      this._setOwn(r, false);
      this.own = null;
      this.doorSound(r, false);
    }
  }

  /** Door open/close: latch, hinge, and the body absorbing the slam. */
  doorSound(r, entering) {
    const { actx, bank, rng } = this;
    const t = actx.currentTime + (entering ? 0.02 : 0.05);
    const out = gain(actx, 0.6);
    out.connect(this.mixer.bus('foley'));
    const heavy = (r?.chassis?.mass ?? 1) > 1.4;
    struckResonator(actx, bank, rng, t, [
      { f: heavy ? 78 : 108, q: 3.5, g: 0.5, decay: 0.1 },
      { f: heavy ? 190 : 265, q: 6, g: 0.3, decay: 0.07 },
      { f: 620, q: 9, g: 0.16, decay: 0.04 },
      { f: 1900, q: 13, g: 0.07, decay: 0.02 },
    ], 0.0035).connect(out);
    // Latch click a beat before the panel note.
    struckResonator(actx, bank, rng, t - 0.02, [
      { f: 3200, q: 18, g: 0.05, decay: 0.012 },
    ], 0.0015).connect(out);
    setTimeout(() => { try { out.disconnect(); } catch { /* noop */ } }, 900);
  }

  onCollision(p) {
    if (!p) return;
    if (this._collideBudget++ > 3) return;
    const pt = p.point;
    const lp = this.field.listenerPos;
    const x = pt?.x ?? lp.x, y = pt?.y ?? lp.y, z = pt?.z ?? lp.z;
    const dist = Math.hypot(x - lp.x, y - lp.y, z - lp.z);
    if (dist > 190) return;
    const r = p.vehicle ? this.records.get(p.vehicle) : null;
    // Impulse arrives in N.s from a rigid body; normalise against a 1.2 t car
    // hitting something at 10 m/s = 12000 N.s.
    const raw = Number.isFinite(p.impulse) ? p.impulse : (Math.abs(p.speed ?? 4) * 1200);
    const e = clamp(raw / 12000, 0.03, 2.2);
    this.crunch(x, y, z, e, r?.chassis?.body ?? 'steel', dist);
    if (e > 0.5) this.mixer.duck(clamp(e * 0.35, 0, 0.6), 0.12);
  }

  /**
   * Sheet metal deforming. Not a "crash sample": a broadband strike, a set of
   * panel modes whose decay shortens as the impact gets harder (a hard hit
   * deforms the panel and kills its ring), glass at the top end and debris
   * scattered through the tail.
   */
  crunch(x, y, z, energy, body, dist = 0) {
    const { actx, bank, rng, mixer } = this;
    const t = actx.currentTime + Math.min(dist / 343, 0.6);
    const e = clamp(energy, 0.02, 2.2);
    const out = gain(actx, 0.5);

    // Route through the field so it doppler/occludes like everything else.
    const em = this.field.acquire({
      x, y, z, when: t, bus: 'foley', priority: 0.85,
      send: 0.4, gain: 1, endTime: t + 2.2,
    });
    if (em) this.field.hold(em, out, t + 2.2);
    else out.connect(mixer.bus('foley'));

    /* the strike itself */
    const src = bank.source('white', rng, rng.range(0.8, 1.2));
    const lp = biquad(actx, 'lowpass', clamp(900 + e * 4200, 400, 12000), 0.7);
    const g = gain(actx, 0);
    const drv = shaper(actx, saturationCurve(4 + e * 6, 0.6), '2x');
    series(src, lp, g, drv).connect(out);
    hit(g.gain, t, clamp(0.7 * e, 0, 1.1), 0.03 + e * 0.05);
    src.start(t, src._offset, 0.3);

    /* mass */
    const b = osc(actx, 'sine', 88);
    const bg = gain(actx, 0);
    b.connect(bg); bg.connect(out);
    b.frequency.setValueAtTime(120 * (0.7 + e * 0.5), t);
    b.frequency.exponentialRampToValueAtTime(38, t + 0.12);
    hit(bg.gain, t, clamp(0.55 * e, 0, 1), 0.16);
    b.start(t); b.stop(t + 0.4);

    /* panel modes — the ring dies as the panel folds */
    const modes = body === 'thin' ? 5 : body === 'hull' ? 3 : 6;
    const ringDecay = clamp(0.34 / (1 + e * 1.8), 0.03, 0.34);
    const parts = [];
    for (let i = 0; i < modes; i++) {
      parts.push({
        f: rng.range(140, 2600) * (body === 'thin' ? 1.6 : 1),
        q: rng.range(8, 26),
        g: (0.22 / (1 + i * 0.5)) * e,
        decay: ringDecay * rng.range(0.6, 1.4),
      });
    }
    struckResonator(actx, bank, rng, t, parts, 0.004).connect(out);

    /* glass */
    if (e > 0.55 && body !== 'hull' && rng.float() < clamp(e * 0.6, 0, 0.9)) {
      const gs = bank.source('crackle', rng, rng.range(1.1, 1.6));
      const ghp = biquad(actx, 'highpass', 3600, 0.7);
      const gg = gain(actx, 0);
      series(gs, ghp, gg).connect(out);
      hit(gg.gain, t + 0.02, 0.30 * clamp(e, 0, 1.4), 0.55);
      gs.start(t + 0.02, gs._offset, 0.8);
      struckResonator(actx, bank, rng, t + 0.02, [
        { f: 5200, q: 30, g: 0.10, decay: 0.10 },
        { f: 8100, q: 24, g: 0.06, decay: 0.07 },
      ], 0.002).connect(out);
    }

    /* debris */
    const grains = Math.min(14, Math.round(3 + e * 8));
    for (let i = 0; i < grains; i++) {
      struckResonator(actx, bank, rng, t + rng.range(0.05, 0.9 + e * 0.4), [
        { f: rng.range(700, 5200), q: rng.range(9, 26), g: rng.range(0.015, 0.06) * e, decay: rng.range(0.01, 0.06) },
      ], 0.002).connect(out);
    }
    setTimeout(() => { try { out.disconnect(); } catch { /* noop */ } }, 3000);
  }

  onDestroyed(p) {
    const pt = p?.point;
    if (!pt) return;
    const r = p.vehicle ? this.records.get(p.vehicle) : null;
    this.crunch(pt.x, pt.y, pt.z, 1.6, r?.chassis?.body ?? 'steel');
    if (r) this.release(r);
  }

  /* ---------------------------------------------------------------- */
  /* voice assignment                                                 */
  /* ---------------------------------------------------------------- */

  _takeEngine(profile, full) {
    const key = `${profile.label}:${full}`;
    const pool = this._pool.get(key);
    if (pool?.length) return pool.pop();
    return new EngineVoice(this.actx, this.bank, this.rng.fork(), profile, full);
  }

  _giveEngine(profile, full, voice) {
    const key = `${profile.label}:${full}`;
    let pool = this._pool.get(key);
    if (!pool) this._pool.set(key, (pool = []));
    voice.stop();
    try { voice.out.disconnect(); } catch { /* noop */ }
    if (pool.length < 4) pool.push(voice);
    else voice.dispose();
  }

  _takeRoll(kind) {
    const pool = this._rollPool.get(kind);
    if (pool?.length) return pool.pop();
    return new RollVoice(this.actx, this.bank, this.rng.fork(), chassis(kind));
  }

  _giveRoll(kind, voice) {
    let pool = this._rollPool.get(kind);
    if (!pool) this._rollPool.set(kind, (pool = []));
    try { voice.out.disconnect(); } catch { /* noop */ }
    voice.skid = 0;
    if (pool.length < 4) pool.push(voice);
    else voice.dispose();
  }

  /** Give a record the voices for `detail`, freeing whatever it had. */
  _setDetail(r, detail) {
    if (r.detail === detail) return;
    const wasOwn = r.own;
    this._teardown(r);
    r.detail = detail;
    if (detail === 'silent') return;

    const full = detail === 'full';
    r.engine = this._takeEngine(r.profile, full);
    r.roll = full ? this._takeRoll(r.kind) : null;

    if (wasOwn) {
      this._wireOwn(r);
    } else {
      const em = this.field.acquireTracked({
        x: r.x, y: r.y, z: r.z, bus: 'vehicles',
        send: 0.22, gain: 1, priority: 0.7, hrtf: full,
      });
      if (!em) {
        // No emitter left — stay silent rather than leaking a voice.
        this._teardown(r);
        r.detail = 'silent';
        return;
      }
      r.em = em;
      this.field.attach(em, r.engine.out);
      if (r.roll) r.roll.out.connect(em.input);
      r.engine.start(1);
    }
  }

  _wireOwn(r) {
    r.engine.out.connect(this.cabinIn);
    if (r.roll) r.roll.out.connect(this.cabinIn);
    r.engine.start(1);
  }

  /**
   * Move a vehicle between the spatialised path and the dry cabin path. Rather
   * than rewiring a running voice — which is a hard discontinuity on every
   * partial at once — the old routing is faded out and a fresh voice is faded
   * in on the new one. The overlap is 220 ms, so getting into a car is a
   * crossfade from "engine across the street" to "engine through the firewall".
   */
  _setOwn(r, own) {
    if (!r || r.own === own) return;
    r.own = own;
    const detail = r.detail;
    if (detail === 'silent') {
      if (own) this._setDetail(r, 'full');
      return;
    }
    this._setDetail(r, 'silent');
    this._setDetail(r, own ? 'full' : detail);
  }

  /** Run `fn` once `seconds` of audio time have passed. Flushed in update(). */
  _defer(seconds, fn) {
    this._deferred.push({ at: this.actx.currentTime + seconds, fn });
  }

  _teardown(r) {
    const em = r.em, engine = r.engine, roll = r.roll;
    const profile = r.profile, kind = r.kind, wasFull = r.detail === 'full';
    r.em = null; r.engine = null; r.roll = null; r.detail = 'silent';
    if (!engine && !roll && !em) return;
    engine?.stop();                         // 80 ms fade before anything moves
    if (roll) roll.skid = 0;
    this._defer(0.22, () => {
      if (em) this.field.releaseTracked(em);
      if (engine) this._giveEngine(profile, wasFull, engine);
      if (roll) this._giveRoll(kind, roll);
    });
  }

  release(vehicleOrRecord) {
    const r = this.records.get(vehicleOrRecord) ?? vehicleOrRecord;
    if (!r?.vehicle) return;
    if (this.own === r) this.own = null;
    this._teardown(r);
    this.records.delete(r.vehicle);
  }

  /* ---------------------------------------------------------------- */
  /* frame                                                            */
  /* ---------------------------------------------------------------- */

  setWeather(wet) {
    this.wet = clamp(wet, 0, 1);
  }

  update(dt) {
    const lp = this.field.listenerPos;
    const world = this.ctx?.peek?.('world');
    this._collideBudget = 0;

    /* ---- retire faded-out voices ----------------------------------- */
    if (this._deferred.length) {
      const now = this.actx.currentTime;
      for (let i = this._deferred.length - 1; i >= 0; i--) {
        if (this._deferred[i].at > now) continue;
        const d = this._deferred[i];
        this._deferred.splice(i, 1);
        try { d.fn(); } catch { /* the voice is going away anyway */ }
      }
    }

    /* ---- refresh positions, drop dead records ---------------------- */
    this._order.length = 0;
    for (const r of this.records.values()) {
      r.idleTimeout -= dt;
      if (r.idleTimeout < -4 && !r.own) {
        // Nothing has spoken for this vehicle in four seconds: it despawned.
        this._teardown(r);
        this.records.delete(r.vehicle);
        continue;
      }
      // Prefer the live handle; fall back to whatever the last event carried.
      if (this._posOf(r.vehicle, r)) r.hasPos = true;
      if (!r.hasPos || !Number.isFinite(r.x + r.y + r.z)) {
        r.x = lp.x; r.y = lp.y; r.z = lp.z;
      }
      r.dist = r.own ? 0 : Math.hypot(r.x - lp.x, r.y - lp.y, r.z - lp.z);
      this._order.push(r);
    }
    this._order.sort(byDistance);

    /* ---- surface lookup, one vehicle per frame --------------------- */
    if (world?.surfaceAt && this._order.length) {
      this._surfCursor = (this._surfCursor + 1) % this._order.length;
      const r = this._order[this._surfCursor];
      try {
        const s = world.surfaceAt(r.x, r.z);
        if (s) { r.surface = s; r.roll?.setSurface(s); }
      } catch { /* world still streaming */ }
    }

    /* ---- assign detail and drive the voices ------------------------ */
    let full = 0, lod = 0, silent = 0;
    for (let i = 0; i < this._order.length; i++) {
      const r = this._order[i];
      let want;
      if (r.own) want = 'full';
      else if (r.dist > CULL_DIST || r.idleTimeout < -0.5) want = 'silent';
      else if (i < FULL_VOICES) want = 'full';
      else if (i < MAX_TRACKED) want = 'lod';
      else want = 'silent';
      if (want !== r.detail) this._setDetail(r, want);
      if (r.detail === 'silent') { silent++; continue; }
      if (r.detail === 'full') full++; else lod++;

      /* position + doppler */
      let ratio = 1;
      if (r.em) ratio = this.field.motion(r.em, r.x, r.y, r.z, dt);
      r.doppler = ratio;

      /* engine */
      const s = r.state;
      r.engine.setState(s, dt, ratio);
      if (r.kind === 'boat') {
        // The outboard's exhaust exits below the waterline until it planes.
        r.engine.setMuffle(clamp(0.22 + Math.min(s.speed, 12) / 12 * 0.7, 0.2, 1));
      } else if (r.own) {
        r.engine.setMuffle(lerp(1, 0.62, this.cabin));
      }

      /* rolling */
      if (r.roll) {
        r.roll.setState(s.speed, this.wet, dt, r.own ? this.cabin : 0, ratio);
      }

      /* suspension: vertical jerk from the body's own motion */
      r.knockCool -= dt;
      if (dt > 1e-4 && r.detail === 'full') {
        const vy = (r.y - r.prevY) / dt;
        const ay = (vy - r.prevVy) / dt;
        r.prevY = r.y;
        r.prevVy = clamp(vy, -60, 60);
        if (r.knockCool <= 0 && Math.abs(ay) > 26 && Math.abs(ay) < 900 && s.speed > 1.2) {
          r.knockCool = 0.08;
          const l = clamp((Math.abs(ay) - 26) / 90, 0.05, 1.3) * clamp(r.chassis.mass / 1.2, 0.5, 1.8);
          r.engine.knock(l * (r.own ? 1 : 0.7));
        }
      }
    }

    this.stats.records = this.records.size;
    this.stats.full = full;
    this.stats.lod = lod;
    this.stats.silent = silent;
  }

  /** Player entered/left a cabin: 0 on foot, 1 sealed. */
  setCabin(v) {
    this.cabin = clamp(v, 0, 1);
    const t = this.actx.currentTime;
    // In-cabin the engine is heard through the firewall: bass up, top gone.
    to(this._cabinLP.frequency, lerp(16000, 2600, this.cabin), t, 0.2);
    to(this._cabinLS.gain, lerp(0, 7, this.cabin), t, 0.2);
    to(this._cabinNotch.gain, lerp(0, -5, this.cabin), t, 0.2);
  }

  dispose() {
    for (const r of this.records.values()) this._teardown(r);
    for (const d of this._deferred) { try { d.fn(); } catch { /* noop */ } }
    this._deferred.length = 0;
    this.records.clear();
    for (const pool of this._pool.values()) for (const v of pool) v.dispose();
    for (const pool of this._rollPool.values()) for (const v of pool) v.dispose();
    this._pool.clear();
    this._rollPool.clear();
    for (const n of [this.cabinIn, this._cabinLP, this._cabinLS, this._cabinNotch, this._cabinGain, this._cabinSend]) {
      try { n.disconnect(); } catch { /* noop */ }
    }
  }
}

function byDistance(a, b) {
  return a.dist - b.dist;
}
