/**
 * AUDIO / OFFLINE BENCH
 *
 * Renders the REAL synthesis graph — the same Mixer, the same SpatialField, the
 * same EngineVoice, the same station generators — through an
 * OfflineAudioContext, and hands the PCM back so it can be measured.
 *
 * The trick that makes this possible for the continuous systems (engines,
 * tyres, sirens, the radio scheduler) is `OfflineAudioContext.suspend()`. A
 * game system expects to be ticked at 60 Hz against a clock that is moving;
 * offline, `currentTime` is frozen at 0 while you build the graph, so every
 * `setTargetAtTime` would land on top of every other one and an rpm sweep would
 * render as a step. Suspending at each render quantum, running one simulation
 * tick with `currentTime` correctly parked at that instant, and resuming, gives
 * exactly the automation the live game produces — deterministically, at many
 * times real speed, with no speaker and no user gesture.
 *
 * Used by src/audio/mixdown.mjs, which pulls the PCM into node, writes WAVs and
 * runs the FFT analysis.
 */

import { Rng } from '../core/rng.js';
import { NoiseBank, clamp } from './dsp.js';
import { Mixer } from './mixer.js';
import { SpatialField } from './spatial.js';
import { EngineVoice, ENGINE_PROFILES, resolveEngine } from './engine.js';
import { VehicleAudio } from './vehicles.js';
import { Radio, STATION_IDS } from './radio.js';
import { CityAmbience } from './city.js';
import { PoliceAudio } from './sirens.js';
import { WEAPON_PROFILES, weaponShot } from './weapons.js';
import { explosion, footstep } from './foley.js';

const SR = 48000;
const QUANTUM = 128;

/** Simulation tick, quantised to render blocks so suspend() accepts it. */
const TICK_BLOCKS = 12;                     // 1536 samples = 32 ms = 31.25 Hz
const TICK = (QUANTUM * TICK_BLOCKS) / SR;

/**
 * Render `actx`, running `fn(t, dt)` every 32 ms of RENDERED time with the
 * context's currentTime correctly parked at `t`.
 *
 * Order matters and is not obvious: every suspend has to be REGISTERED before
 * `startRendering()` is called, and only then awaited. Await one before the
 * render is running and it can never resolve, because nothing will ever reach
 * that timestamp — the render is what advances the clock.
 */
async function renderDriven(actx, seconds, fn) {
  const steps = Math.floor(seconds / TICK);
  const pending = [];
  for (let i = 1; i < steps; i++) {
    const t = i * TICK;
    pending.push({ t, p: actx.suspend(t) });
  }
  const rendered = actx.startRendering();
  for (const s of pending) {
    // eslint-disable-next-line no-await-in-loop
    await s.p;
    fn(s.t, TICK);
    actx.resume();
  }
  return rendered;
}

/** Everything a scene needs, wired the way the live system wires it. */
function harness(actx, seed) {
  const rng = new Rng(seed);
  const bank = new NoiseBank(actx, rng.fork(), 2.0);
  const mixer = new Mixer(actx, rng.fork(), {});
  mixer.buildReverbs();
  mixer.setSpace({ tight: 0, room: 0, street: 0.55, tunnel: 0, open: 0.45 }, 0.001);
  const field = new SpatialField(actx, mixer, null);
  field.occlusionEnabled = false;             // no physics offline
  field.setListener(0, 1.6, 0, 0, 0, -1, 0, 1, 0, 0);
  return { rng, bank, mixer, field };
}

/** Mute every bus but one, so a scene can be measured in isolation. */
function soloBus(mixer, name) {
  if (!name) return;
  for (const k in mixer.buses) {
    if (k !== name) mixer.buses[k].trim.gain.value = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Scenes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Every scene: { seconds, build({actx, rng, bank, mixer, field}) -> tick(t,dt) }
 * `tick` may be null for scenes that are entirely scheduled up front.
 */
export const SCENES = {};

/* ---- engines ------------------------------------------------------ */

/**
 * A full drive cycle for one class: idle, blip, launch, four upshifts to the
 * limiter, then a trailing-throttle overrun back to idle. This is the scene the
 * RPM/centroid analysis runs on.
 */
for (const kind of Object.keys(ENGINE_PROFILES)) {
  SCENES[`engine:${kind}`] = {
    seconds: 14,
    build({ actx, rng, bank, mixer }) {
      const p = ENGINE_PROFILES[kind];
      const v = new EngineVoice(actx, bank, rng.fork(), p, true);
      v.out.connect(mixer.bus('vehicles'));
      const sendG = actx.createGain();
      sendG.gain.value = 0.12;
      v.out.connect(sendG);
      sendG.connect(mixer.reverbSend);
      v.start(1);
      const idle = p.idle, red = p.redline;
      const st = { rpm: idle, throttle: 0, gear: 1, load: 0, speed: 0, redline: red, idle };
      return (t, dt) => {
        // 0-2 idle | 2-3 blip | 3-11 four gears to the limiter | 11-14 overrun
        if (t < 2) {
          st.rpm = idle; st.throttle = 0; st.load = 0; st.gear = 1; st.speed = 0;
        } else if (t < 3) {
          const u = (t - 2);
          st.throttle = u < 0.35 ? 1 : 0;
          st.rpm = idle + Math.sin(Math.min(u, 1) * Math.PI) * (red - idle) * 0.55;
          st.load = u < 0.35 ? 1 : -0.7;
          st.speed = 0;
        } else if (t < 11) {
          const u = (t - 3) / 8;
          const gearU = (u * 4) % 1;
          st.gear = 1 + Math.floor(u * 4);
          st.throttle = gearU > 0.94 ? 0.25 : 1;
          st.load = gearU > 0.94 ? 0 : 1;
          st.rpm = idle * 1.6 + gearU * (red * 1.005 - idle * 1.6);
          st.speed = 4 + u * 46;
        } else {
          const u = (t - 11) / 3;
          st.throttle = 0; st.load = -1; st.gear = Math.max(1, 4 - Math.floor(u * 4));
          st.rpm = Math.max(idle, red * 0.85 * (1 - u));
          st.speed = Math.max(0, 50 * (1 - u));
        }
        v.setState(st, dt, 1);
      };
    },
  };
}

/**
 * Diagnostic: the bare order stack with no combustion noise, no induction and
 * no drive, held at a constant 3000 rpm. Its spectrogram must be a clean comb
 * of lines 25 Hz apart. If this is clean and `engineLoad` is not, the noise
 * layers are too loud; if this is a wash too, the wave itself is wrong.
 */
SCENES.engineBare = {
  seconds: 5,
  build({ actx, rng, bank, mixer }) {
    const p = ENGINE_PROFILES.muscle;
    const v = new EngineVoice(actx, bank, rng.fork(), p, false);   // LOD: no noise
    v.out.connect(mixer.bus('vehicles'));
    v.start(1);
    const st = { rpm: 3000, throttle: 0.8, gear: 3, load: 0.8, speed: 22, redline: p.redline, idle: p.idle };
    return (t, dt) => v.setState(st, dt, 1);
  },
};

/**
 * The load test. Constant 3000 rpm; throttle steps 0 -> 1 in six 1.5 s plateaux.
 * If the spectral centroid does not climb across the plateaux then the engine is
 * a pitch-shifted sample with a volume knob, and this is the measurement that
 * proves it is not.
 */
SCENES.engineLoad = {
  seconds: 9.6,
  build({ actx, rng, bank, mixer }) {
    const p = ENGINE_PROFILES.muscle;
    const v = new EngineVoice(actx, bank, rng.fork(), p, true);
    v.out.connect(mixer.bus('vehicles'));
    v.start(1);
    const st = { rpm: 3000, throttle: 0, gear: 3, load: 0, speed: 22, redline: p.redline, idle: p.idle };
    return (t, dt) => {
      const stage = Math.min(5, Math.floor(t / 1.6));
      st.throttle = stage / 5;
      st.load = stage / 5;
      st.rpm = 3000;                      // held: only the LOAD changes
      v.setState(st, dt, 1);
    };
  },
};

/** The same, but only the rpm moves, at a constant part throttle. */
SCENES.engineRpm = {
  seconds: 9.6,
  build({ actx, rng, bank, mixer }) {
    const p = ENGINE_PROFILES.muscle;
    const v = new EngineVoice(actx, bank, rng.fork(), p, true);
    v.out.connect(mixer.bus('vehicles'));
    v.start(1);
    const st = { rpm: 800, throttle: 0.5, gear: 3, load: 0.5, speed: 22, redline: p.redline, idle: p.idle };
    return (t, dt) => {
      const stage = Math.min(5, Math.floor(t / 1.6));
      st.rpm = 900 + (stage / 5) * (p.redline - 900);
      v.setState(st, dt, 1);
    };
  },
};

/** A car at 30 m/s passing 4 m to the listener's right. Doppler, in one scene. */
SCENES.passby = {
  seconds: 8,
  build({ actx, rng, bank, mixer, field }) {
    const va = new VehicleAudio(actx, bank, mixer, field, rng.fork(), null);
    const veh = { id: 'passby', kind: 'muscle', position: { x: 4, y: 0.6, z: 120 } };
    return (t, dt) => {
      const z = 120 - t * 30;
      veh.position.z = z;
      va.onEngine({
        vehicle: veh, class: 'muscle', rpm: 4200, throttle: 0.7, gear: 4, load: 0.7,
        speed: 30, position: veh.position,
      });
      field.setListener(0, 1.6, 0, 0, 0, -1, 0, 1, 0, dt);
      va.update(dt);
    };
  },
};

/**
 * A calibration source: one 900 Hz sine on a tracked emitter, moved past the
 * listener at 30 m/s and pitched by whatever ratio `field.motion` returns.
 * This isolates the doppler machinery from the engine model, so when a pass-by
 * measurement looks odd it is obvious which half is at fault. The expected
 * observed ratio across the pass is (343-30)/(343+30) x (343+30)/(343-30)
 * inverted = 0.839, i.e. three semitones.
 */
SCENES.dopplerProbe = {
  seconds: 8,
  build({ actx, rng, bank, mixer, field }) {
    const src = actx.createOscillator();
    src.type = 'sawtooth';
    src.frequency.value = 900;
    const g = actx.createGain();
    g.gain.value = 0.5;
    src.connect(g);
    src.start(0);
    const em = field.acquireTracked({ x: 4, y: 1, z: 120, bus: 'vehicles', send: 0, gain: 1, priority: 1 });
    field.attach(em, g);
    void rng; void bank; void mixer;
    return (t, dt) => {
      const z = 120 - t * 30;
      field.setListener(0, 1.6, 0, 0, 0, -1, 0, 1, 0, dt);
      const ratio = field.motion(em, 4, 1, z, dt);
      src.frequency.setTargetAtTime(900 * ratio, actx.currentTime, 0.02);
      field.update(dt);
    };
  },
};

/** Eight classes at once, spread across the street: the A/B comparison scene. */
SCENES.fleet = {
  seconds: 10,
  build({ actx, rng, bank, mixer, field }) {
    const va = new VehicleAudio(actx, bank, mixer, field, rng.fork(), null);
    const kinds = Object.keys(ENGINE_PROFILES);
    const vs = kinds.map((k, i) => ({
      id: `f${i}`, kind: k, position: { x: (i - 3.5) * 6, y: 0.6, z: -12 },
    }));
    return (t, dt) => {
      const u = (t % 10) / 10;
      for (let i = 0; i < vs.length; i++) {
        const p = resolveEngine(vs[i].kind);
        va.onEngine({
          vehicle: vs[i], class: vs[i].kind,
          rpm: p.idle + u * (p.redline - p.idle) * 0.92,
          throttle: 0.85, gear: 2, load: 0.85, speed: u * 30, position: vs[i].position,
        });
      }
      field.setListener(0, 1.6, 0, 0, 0, -1, 0, 1, 0, dt);
      va.update(dt);
    };
  },
};

/* ---- radio -------------------------------------------------------- */

for (const id of STATION_IDS) {
  SCENES[`radio:${id}`] = {
    seconds: 24,
    build({ actx, rng, bank, mixer, field }) {
      const r = new Radio(actx, bank, mixer, field, rng.fork());
      r.setCabin(1, 0.001);
      r.tune(id);
      return (t, dt) => r.update(dt);
    },
  };
}

/** A retune: 3 s of one station, the static sweep, 5 s of the next. */
SCENES.radioTune = {
  seconds: 12,
  build({ actx, rng, bank, mixer, field }) {
    const r = new Radio(actx, bank, mixer, field, rng.fork());
    r.setCabin(1, 0.001);
    r.tune('redline');
    let done = 0;
    return (t, dt) => {
      if (done === 0 && t > 3.5) { r.tune('incline'); done = 1; }
      if (done === 1 && t > 8) { r.tune('slack'); done = 2; }
      r.update(dt);
    };
  },
};

/** The radio heard from the pavement, then from the driver's seat. */
SCENES.radioCabin = {
  seconds: 12,
  build({ actx, rng, bank, mixer, field }) {
    const r = new Radio(actx, bank, mixer, field, rng.fork());
    r.tune('grease');
    r.setCabin(0, 0.001);
    let inside = false;
    return (t, dt) => {
      if (!inside && t > 6) { r.setCabin(1, 0.15); inside = true; }
      if (!inside) r.setSource(3, 1.0, -4, dt);
      r.update(dt);
    };
  },
};

/* ---- city --------------------------------------------------------- */

const CITY_PRESETS = {
  downtownDay: { x: -232, z: 64, hour: 13, rain: 0, wind: 0.3 },
  downtownNight: { x: -232, z: 64, hour: 2.5, rain: 0, wind: 0.25 },
  steelRow: { x: 784, z: 384, hour: 10, rain: 0, wind: 0.35 },
  riverside: { x: -672, z: 16, hour: 6.5, rain: 0, wind: 0.5 },
  hillResidential: { x: -528, z: 464, hour: 23, rain: 0, wind: 0.6 },
  downpour: { x: -232, z: 64, hour: 17, rain: 0.9, wind: 0.8 },
};

for (const name of Object.keys(CITY_PRESETS)) {
  SCENES[`city:${name}`] = {
    seconds: 16,
    build({ actx, rng, bank, mixer, field }) {
      const p = CITY_PRESETS[name];
      const c = new CityAmbience(actx, bank, mixer, field, rng.fork(), null);
      c.start();
      c.setHour(p.hour);
      c.setWeather({ rain: p.rain, wind: p.wind, wetness: p.rain });
      field.setListener(p.x, 1.6, p.z, 0, 0, -1, 0, 1, 0, 0);
      const api = { cityEvent: () => {}, thunder: () => {} };
      return (t, dt) => {
        c.update(dt, api);
        field.update(dt);
      };
    },
  };
}

/**
 * One bed layer at a time. These exist so BED_TRIM is set from measurements
 * rather than from guesses: every layer should land within a few dB of the
 * others when soloed, and the mix balance then comes from the district and
 * hour weights alone.
 */
for (const layer of ['traffic', 'crowd', 'mill', 'river', 'resi', 'hvac', 'wind']) {
  SCENES[`cityLayer:${layer}`] = {
    seconds: 8,
    build({ actx, rng, bank, mixer, field }) {
      const c = new CityAmbience(actx, bank, mixer, field, rng.fork(), null);
      c.start();
      c.debugSolo = layer;
      c.setHour(13);
      c.setWeather({ rain: 0, wind: 0.5, wetness: 0 });
      const api = { cityEvent: () => {}, thunder: () => {} };
      // Jump the smoother straight to the target so 8 s is all steady state.
      for (let i = 0; i < 200; i++) c.update(0.05, api);
      return (t, dt) => c.update(dt, api);
    },
  };
}

/* ---- police -------------------------------------------------------- */

/** A cruiser closing at 35 m/s and passing: the doppler test for sirens. */
SCENES.sirenPass = {
  seconds: 9,
  build({ actx, rng, bank, mixer, field }) {
    const pa = new PoliceAudio(actx, bank, mixer, field, rng.fork());
    pa.setWanted(3, 0);
    const unit = { vehicle: { id: 'cop' }, kind: 'police', x: 5, y: 1, z: 150, dist: 150 };
    const units = [unit];
    return (t, dt) => {
      unit.z = 150 - t * 35;
      unit.dist = Math.hypot(unit.x, unit.y - 1.6, unit.z);
      field.setListener(0, 1.6, 0, 0, 0, -1, 0, 1, 0, dt);
      pa.update(dt, units);
      field.update(dt);
    };
  },
};

/** Wanted escalation 0 -> 5, to hear the pursuit layer build. */
SCENES.wanted = {
  seconds: 20,
  build({ actx, rng, bank, mixer, field }) {
    const pa = new PoliceAudio(actx, bank, mixer, field, rng.fork());
    const unit = { vehicle: { id: 'cop' }, kind: 'police', x: 8, y: 1, z: -25, dist: 27 };
    let lvl = 0;
    return (t, dt) => {
      const want = Math.min(5, Math.floor(t / 3.2));
      if (want !== lvl) { pa.setWanted(want, lvl); lvl = want; }
      field.setListener(0, 1.6, 0, 0, 0, -1, 0, 1, 0, dt);
      pa.update(dt, [unit]);
      field.update(dt);
    };
  },
};

/* ---- the whole mix -------------------------------------------------- */

/**
 * Everything at once, which is the only honest limiter test: a full-throttle
 * V8 in the cabin, the radio, the city in the rain, three sirens, gunfire and
 * an explosion. If the master peaks at 1.0 here, the mix is broken.
 */
SCENES.mixstress = {
  seconds: 12,
  build({ actx, rng, bank, mixer, field }) {
    const va = new VehicleAudio(actx, bank, mixer, field, rng.fork(), null);
    const radio = new Radio(actx, bank, mixer, field, rng.fork());
    const city = new CityAmbience(actx, bank, mixer, field, rng.fork(), null);
    const police = new PoliceAudio(actx, bank, mixer, field, rng.fork());
    city.start();
    city.setHour(19);
    city.setWeather({ rain: 0.8, wind: 0.7, wetness: 0.9 });
    radio.setCabin(1, 0.001);
    radio.tune('furnace');
    police.setWanted(4, 0);
    va.setCabin(1);
    va.setWeather(0.9);

    const own = { id: 'own', kind: 'muscle', position: { x: 0, y: 0.6, z: -1 } };
    va.onEngine({ vehicle: own, class: 'muscle', rpm: 1000, throttle: 0, gear: 1, load: 0, speed: 0, position: own.position });
    va.onEnter({ vehicle: own, actor: 'player', seat: 0 });
    const traffic = [];
    for (let i = 0; i < 6; i++) {
      traffic.push({
        id: `t${i}`, kind: ['sedan', 'van', 'truck', 'sports', 'bike', 'police'][i],
        position: { x: (i - 3) * 7, y: 0.6, z: -18 - i * 9 },
      });
    }
    const units = [{ vehicle: { id: 'c1' }, kind: 'police', x: 12, y: 1, z: -30, dist: 32 },
      { vehicle: { id: 'c2' }, kind: 'police', x: -22, y: 1, z: -50, dist: 55 }];
    const api = { cityEvent: () => {}, thunder: () => {} };
    let shotTimer = 0, boomed = false;

    return (t, dt) => {
      const u = clamp(t / 10, 0, 1);
      va.onEngine({
        vehicle: own, class: 'muscle', rpm: 900 + u * 4900, throttle: 1,
        gear: 1 + Math.floor(u * 4), load: 1, speed: u * 48, position: own.position,
      });
      for (let i = 0; i < traffic.length; i++) {
        const tv = traffic[i];
        tv.position.z += dt * 14;
        const p = resolveEngine(tv.kind);
        va.onEngine({
          vehicle: tv, class: tv.kind, rpm: p.idle + u * (p.redline - p.idle) * 0.8,
          throttle: 0.8, gear: 3, load: 0.8, speed: 24, position: tv.position,
        });
      }
      if (t > 3 && t < 3.1) {
        va.onSkid({ vehicle: own, slip: 0.9, surface: 'asphalt' });
        va.onCollision({ vehicle: own, point: { x: 1, y: 0.7, z: -3 }, impulse: 16000, speed: 12 });
      }
      shotTimer -= dt;
      if (t > 5 && shotTimer <= 0) {
        shotTimer = 0.09;
        const v = weaponShot(actx, bank, rng, WEAPON_PROFILES.rifle, {
          when: actx.currentTime + 0.005, distance: 2, firstPerson: true,
        });
        v.node.connect(mixer.bus('weapons'));
        mixer.duck(0.5, 0.1);
      }
      if (t > 7.5 && !boomed) {
        boomed = true;
        const v = explosion(actx, bank, rng, { when: actx.currentTime + 0.01, distance: 6, radius: 10 });
        v.node.connect(mixer.bus('weapons'));
        mixer.duck(0.85, 0.35);
      }
      field.setListener(0, 1.6, 0, 0, 0, -1, 0, 1, 0, dt);
      va.update(dt);
      police.update(dt, units);
      radio.update(dt);
      city.update(dt, api);
      mixer.update(dt);
      field.update(dt);
    };
  },
};

/** On foot in the rain at night: the quiet end of the dynamic range. */
SCENES.onfoot = {
  seconds: 10,
  build({ actx, rng, bank, mixer, field }) {
    const city = new CityAmbience(actx, bank, mixer, field, rng.fork(), null);
    city.start();
    city.setHour(1.5);
    city.setWeather({ rain: 0.45, wind: 0.5, wetness: 0.8 });
    field.setListener(680, 1.6, -552, 0, 0, -1, 0, 1, 0, 0);
    const api = { cityEvent: () => {}, thunder: () => {} };
    let step = 0;
    return (t, dt) => {
      step -= dt;
      if (step <= 0) {
        step = 0.52;
        const v = footstep(actx, bank, rng, {
          when: actx.currentTime + 0.01, surface: 'sidewalk', gait: 'walk',
        });
        v.node.connect(mixer.bus('foley'));
      }
      city.update(dt, api);
      mixer.update(dt);
      field.update(dt);
    };
  },
};

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

/**
 * Render a scene and return its PCM as base64 interleaved Int16 plus a summary.
 * Called from mixdown.mjs inside the page.
 */
export async function renderScene(name, opts = {}) {
  const scene = SCENES[name];
  if (!scene) throw new Error(`no such scene: ${name}`);
  const seconds = opts.seconds ?? scene.seconds;
  const actx = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
  const h = harness(actx, opts.seed ?? 0xB0A7 + name.length * 7919);
  const tick = scene.build({ actx, ...h });
  if (opts.solo) soloBus(h.mixer, opts.solo);
  const buf = tick ? await renderDriven(actx, seconds, tick) : await actx.startRendering();

  const n = buf.length;
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const pcm = new Int16Array(n * 2);
  let peak = 0, sumSq = 0, nan = 0, clipped = 0;
  for (let i = 0; i < n; i++) {
    const l = L[i], r = R[i];
    if (!Number.isFinite(l) || !Number.isFinite(r)) { nan++; continue; }
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    sumSq += l * l + r * r;
    pcm[i * 2] = Math.max(-32768, Math.min(32767, Math.round(l * 32767)));
    pcm[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(r * 32767)));
  }
  const rms = Math.sqrt(sumSq / (n * 2));

  // base64 without allocating a 6 MB JS string per chunk.
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return {
    name, sampleRate: SR, frames: n, seconds: +(n / SR).toFixed(2),
    peak: +peak.toFixed(5), rms: +rms.toFixed(6),
    dbfsPeak: +(20 * Math.log10(Math.max(peak, 1e-9))).toFixed(2),
    dbfsRms: +(20 * Math.log10(Math.max(rms, 1e-9))).toFixed(2),
    nan, clipped,
    pcm: btoa(bin),
  };
}

export function sceneNames() {
  return Object.keys(SCENES);
}

if (typeof window !== 'undefined') {
  window.__AUDIO_BENCH__ = { renderScene, sceneNames };
}
