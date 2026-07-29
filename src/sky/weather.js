import * as THREE from 'three';

/**
 * Weather states and the machine that blends between them.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL
 * ---------------------------------------------------------------------------
 * A weather state is a *vector of continuous parameters*, not a mode. There is
 * no switch anywhere in this subsystem: `setWeather('storm')` snapshots the
 * current vector, sets the target vector, and runs a smoothstep between them
 * over a couple of minutes. Everything the sky owns — cloud coverage, cloud
 * base and top, the stratus/cumulus blend, aerosol turbidity, ground fog,
 * river fog, wind, rain rate, lightning rate — is one component of that vector,
 * so a front arriving looks like a front arriving: the cirrus thickens first,
 * the cumulus bases drop and flatten, the light goes grey, the wind gets up,
 * and only then does it start to rain.
 *
 * Two parameters are NOT interpolated with the rest because they are integrals
 * rather than states:
 *
 *   wetness   puddles build over minutes of rain and dry over minutes after it
 *             — a different time constant in each direction (asymmetric, and
 *             that asymmetry is the whole point: a street that dries as fast as
 *             it wets reads as a shader parameter being tweened).
 *   lightning a Poisson process whose rate is the interpolated `lightningRate`.
 *
 * ---------------------------------------------------------------------------
 * THE PALETTE  (DESIGN.md: "weather leans wet")
 * ---------------------------------------------------------------------------
 * Steel City is a wet industrial river valley, so the distribution is skewed:
 * `clear` is the rare one, `overcast` and `scattered` are the base state, and
 * `fog` is what the rivers do at dawn.
 */

/**
 * @typedef {object} WeatherVector
 * @property {number} cloudCoverage  0..1 coverage of the cumulus/stratus deck
 * @property {number} cloudDensity   optical density multiplier
 * @property {number} cloudAbsorb    extinction gain — storm cloud is near-black
 * @property {number} cloudBaseKM    deck base above the ground
 * @property {number} cloudTopKM     deck top; the difference is the vertical
 *                                   development, and it is what separates a fair
 *                                   weather cumulus from a thunderhead
 * @property {number} cloudStratus   0 = discrete billows, 1 = one flat sheet
 * @property {number} cloudShear     km of downwind lag from base to top
 * @property {number} cloudDetail    3D erosion strength
 * @property {number} cirrusCoverage
 * @property {number} cirrusOpacity
 * @property {number} turbidity      aerosol multiplier — 1 clear, 3 industrial
 * @property {number} horizonMurk
 * @property {number} fogDensity     multiplier on the base ground fog
 * @property {number} fogHeightM     e-folding height of the ground fog
 * @property {number} riverFog       0..1 extra fog pooled in the river valleys
 * @property {number} shaftGain      inscatter gain on the key light
 * @property {number} windSpeed      m/s at the deck
 * @property {number} rain           0..1 precipitation rate
 * @property {number} lightningRate  strikes per minute
 */

/** @type {Record<string, WeatherVector>} */
export const WEATHER_STATES = {
  /**
   * Clear. Not empty: even a clear day over a mill town has a thin fair-weather
   * cumulus field and enough aerosol to warm the horizon. A genuinely cloudless
   * sky is the "flat blue gradient" failure the whole subsystem exists to avoid.
   */
  clear: {
    cloudCoverage: 0.20,
    cloudDensity: 4.60,
    cloudAbsorb: 1.0,
    cloudBaseKM: 1.45,
    cloudTopKM: 2.12,
    cloudStratus: 0.0,
    cloudShear: 0.14,
    cloudDetail: 1.0,
    cirrusCoverage: 0.17,
    cirrusOpacity: 0.26,
    turbidity: 1.30,
    horizonMurk: 0.12,
    fogDensity: 0.85,
    fogHeightM: 20.0,
    riverFog: 0.10,
    shaftGain: 5.0,
    windSpeed: 3.2,
    rain: 0.0,
    lightningRate: 0.0,
  },

  /** Scattered cumulus — the default. Deep discrete billows, blue between. */
  scattered: {
    cloudCoverage: 0.36,
    cloudDensity: 5.10,
    cloudAbsorb: 1.05,
    cloudBaseKM: 1.25,
    cloudTopKM: 2.15,
    cloudStratus: 0.05,
    cloudShear: 0.11,
    cloudDetail: 1.0,
    cirrusCoverage: 0.22,
    cirrusOpacity: 0.28,
    turbidity: 1.55,
    horizonMurk: 0.16,
    fogDensity: 1.0,
    fogHeightM: 20.0,
    riverFog: 0.14,
    shaftGain: 6.1,
    windSpeed: 5.0,
    rain: 0.0,
    lightningRate: 0.0,
  },

  /**
   * Overcast. One stratus sheet with a low ragged base, and the light goes
   * completely soft: no key, no shadows worth the name, everything lit by a
   * bright grey dome. Turbidity up because the mill haze has nothing to burn off
   * it. This is the Pittsburgh default and it is a LOOK, not an absence of one.
   */
  overcast: {
    cloudCoverage: 0.98,
    cloudDensity: 5.60,
    cloudAbsorb: 1.45,
    cloudBaseKM: 0.80,
    cloudTopKM: 1.95,
    cloudStratus: 0.86,
    cloudShear: 0.10,
    cloudDetail: 0.72,
    cirrusCoverage: 0.05,
    cirrusOpacity: 0.10,
    turbidity: 2.30,
    horizonMurk: 0.30,
    fogDensity: 1.6,
    fogHeightM: 34.0,
    riverFog: 0.22,
    shaftGain: 3.2,
    windSpeed: 6.0,
    rain: 0.0,
    lightningRate: 0.0,
  },

  /** Light rain — a nimbostratus base, drizzle, mirror-wet asphalt. */
  rain: {
    cloudCoverage: 1.0,
    cloudDensity: 6.60,
    cloudAbsorb: 1.75,
    cloudBaseKM: 0.62,
    cloudTopKM: 2.30,
    cloudStratus: 0.92,
    cloudShear: 0.18,
    cloudDetail: 0.62,
    cirrusCoverage: 0.0,
    cirrusOpacity: 0.0,
    turbidity: 2.7,
    horizonMurk: 0.40,
    fogDensity: 2.4,
    fogHeightM: 44.0,
    riverFog: 0.30,
    shaftGain: 2.6,
    windSpeed: 7.5,
    rain: 0.42,
    lightningRate: 0.0,
  },

  /**
   * Storm. A deep cumulonimbus: base almost on the rooftops, top at 5 km, and
   * an absorption high enough that the underside is three stops under the
   * sunlit horizon. Wind-driven rain, and lightning.
   */
  storm: {
    cloudCoverage: 1.0,
    cloudDensity: 8.20,
    cloudAbsorb: 2.25,
    cloudBaseKM: 0.50,
    cloudTopKM: 4.60,
    cloudStratus: 0.60,
    cloudShear: 0.45,
    cloudDetail: 0.90,
    cirrusCoverage: 0.0,
    cirrusOpacity: 0.0,
    turbidity: 3.2,
    horizonMurk: 0.52,
    fogDensity: 3.2,
    fogHeightM: 60.0,
    riverFog: 0.35,
    shaftGain: 2.2,
    windSpeed: 10.5,
    rain: 1.0,
    lightningRate: 5.5,
  },

  /**
   * River fog. Three rivers at dawn in a valley: the fog is IN the valley, so
   * `riverFog` is high and `fogHeightM` is low — the layer has a top, and the
   * Mt. Washington clifftop is above it looking down on a city that is gone.
   * The sky over it is nearly clear, which is what makes the shot.
   */
  fog: {
    cloudCoverage: 0.22,
    cloudDensity: 3.60,
    cloudAbsorb: 1.0,
    cloudBaseKM: 1.10,
    cloudTopKM: 1.90,
    cloudStratus: 0.30,
    cloudShear: 0.08,
    cloudDetail: 0.9,
    cirrusCoverage: 0.14,
    cirrusOpacity: 0.22,
    turbidity: 2.0,
    horizonMurk: 0.46,
    fogDensity: 5.5,
    fogHeightM: 26.0,
    riverFog: 1.0,
    shaftGain: 8.8,
    windSpeed: 1.2,
    rain: 0.0,
    lightningRate: 0.0,
  },
};

export const WEATHER_NAMES = Object.keys(WEATHER_STATES);

/** Field list, cached once — the blend runs every frame and must not allocate. */
const FIELDS = Object.keys(WEATHER_STATES.clear);

/**
 * Where the weather can go next, and how likely.
 *
 * Skewed wet and, more importantly, *ordered*: a clear sky cannot become a
 * storm without going through scattered and overcast first, which is what makes
 * the transitions read as weather rather than as a menu selection.
 */
const TRANSITIONS = {
  clear: [['scattered', 0.72], ['fog', 0.16], ['clear', 0.12]],
  scattered: [['overcast', 0.42], ['clear', 0.26], ['scattered', 0.18], ['rain', 0.14]],
  overcast: [['rain', 0.40], ['scattered', 0.30], ['storm', 0.14], ['overcast', 0.16]],
  rain: [['overcast', 0.44], ['storm', 0.26], ['rain', 0.20], ['scattered', 0.10]],
  storm: [['rain', 0.66], ['overcast', 0.28], ['storm', 0.06]],
  fog: [['clear', 0.46], ['scattered', 0.34], ['overcast', 0.20]],
};

/** Seconds a state holds before the scheduler picks the next one. */
const DWELL = { clear: [180, 420], scattered: [180, 420], overcast: [150, 360],
  rain: [120, 300], storm: [70, 170], fog: [90, 210] };

/** Seconds a transition takes. Fronts are slow; a storm breaking is not. */
const TRANSITION_TIME = { clear: 150, scattered: 130, overcast: 120, rain: 90, storm: 55, fog: 200 };

/**
 * Continuous weather state with real transitions.
 *
 * `current` is the live blended vector every shader uniform is driven from.
 * Nothing outside this class ever sees a discrete state except as a label.
 */
export class WeatherModel {
  constructor(rng) {
    this.rng = rng;
    this.state = 'scattered';
    this.previous = 'scattered';
    /** 0..1 through the current transition. */
    this.blend = 1;
    this.transitionTime = 1;

    this.current = { ...WEATHER_STATES.scattered };
    this.from = { ...WEATHER_STATES.scattered };
    this.to = { ...WEATHER_STATES.scattered };

    /** Wind bearing, radians. Drifts slowly; gusts ride on top of it. */
    this.windAngle = 0.7;
    this._windTargetAngle = 0.7;
    /** Multiplier on windSpeed, 0.7..1.5, that breathes over ~20 s. */
    this.gust = 1;
    this._gustPhase = 0;

    /**
     * Surface wetness, 0..1. NOT a blended field — an integral of the rain
     * rate with an asymmetric time constant. See WET_UP / WET_DOWN.
     */
    this.wetness = 0;

    /** Seconds until the scheduler picks a new state. 0 = manual control. */
    this.auto = false;
    this._dwell = 0;

    /** Lightning: strike bookkeeping for the current frame. */
    this.flash = 0; // 0..1 envelope of the current strike
    this.strikeDir = new THREE.Vector3(0.4, 0.35, -0.85).normalize();
    this._strikeTime = -1e9;
    this._strikeGap = 1e9;
    this._nextStrike = 1e9;
    this._boltCount = 0;
    this._time = 0;
  }

  /**
   * Blend toward a named state. `seconds` overrides the default pace.
   *
   * The Number() coercion and the isFinite guard are not defensive padding —
   * they are a fix for a real outage. `src/dev/shots.js` calls
   * `sky.setWeather(name, { immediate: true })`, and `Math.max(0.001, {})` is
   * NaN. That NaN went into `transitionTime`, `dt / NaN` put NaN into `blend`,
   * and the blend writes EVERY field of the weather vector — including
   * `turbidity`, which the CPU transmittance integral runs on, which is where
   * the sun's colour and therefore its intensity come from. One object literal
   * in a caller turned the whole frame black, and the sky's own telemetry
   * printed a healthy sun because it logged before the weather call landed.
   *
   * A number is a number. Anything else takes the default.
   */
  set(name, seconds) {
    const target = WEATHER_STATES[name];
    if (!target) return this;
    if (name === this.state && this.blend >= 1) return this;
    for (const k of FIELDS) this.from[k] = this.current[k];
    for (const k of FIELDS) this.to[k] = target[k];
    this.previous = this.state;
    this.state = name;
    const s = Number(seconds);
    this.transitionTime = Number.isFinite(s) && s > 0 ? s : (TRANSITION_TIME[name] ?? 120);
    this.blend = 0;
    // A front comes from a new bearing. 55 degrees is enough to notice in the
    // cloud drift without spinning the sky.
    this._windTargetAngle = this.windAngle + (this.rng.float() - 0.5) * 1.9;
    this._dwell = this._dwellFor(name);
    return this;
  }

  /** Snap with no transition — used by setTimeOfDay and by the capture harness. */
  snap(name) {
    const target = WEATHER_STATES[name];
    if (!target) return this;
    for (const k of FIELDS) {
      this.from[k] = target[k];
      this.to[k] = target[k];
      this.current[k] = target[k];
    }
    this.previous = name;
    this.state = name;
    this.blend = 1;
    this.wetness = target.rain > 0 ? Math.min(1, target.rain * 1.6) : 0;
    this._dwell = this._dwellFor(name);
    return this;
  }

  _dwellFor(name) {
    const d = DWELL[name] ?? [180, 360];
    return this.rng.range(d[0], d[1]);
  }

  /** Overwrite individual fields of the live vector (debug / art direction). */
  patch(fields) {
    for (const k in fields) {
      if (k in this.current) {
        this.current[k] = fields[k];
        this.to[k] = fields[k];
        this.from[k] = fields[k];
      }
    }
    return this;
  }

  /**
   * Advance the blend, the wetness integral, the wind and the lightning.
   * @returns {boolean} true when a field moved enough to be worth republishing
   */
  update(dt) {
    this._time += dt;
    let moved = false;

    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / this.transitionTime);
      // Smoothstep, not linear: a front does not start and stop instantly, and
      // the ends of a linear ramp are exactly where a tween shows itself.
      const k = this.blend * this.blend * (3 - 2 * this.blend);
      for (const f of FIELDS) this.current[f] = this.from[f] + (this.to[f] - this.from[f]) * k;
      moved = true;
    }

    // ---- wind -------------------------------------------------------------
    // The bearing chases its target slowly; the gust is a two-tone breathing on
    // top so the cloud drift and the rain slant are never constant.
    this.windAngle += (this._windTargetAngle - this.windAngle) * Math.min(1, dt * 0.05);
    this._gustPhase += dt;
    this.gust =
      1 +
      0.22 * Math.sin(this._gustPhase * 0.41) +
      0.13 * Math.sin(this._gustPhase * 1.07 + 1.9);

    // ---- wetness ----------------------------------------------------------
    // Asymmetric, and the asymmetry is the feature. Puddles fill in about three
    // minutes of steady rain and take five to eight to go, which is roughly what
    // asphalt does. Both constants are scaled by the rain rate so a drizzle
    // never produces standing water.
    const rain = this.current.rain;
    const target = Math.min(1, rain * 1.35);
    if (target > this.wetness) {
      // Attack: faster in heavy rain.
      const k = 1 - Math.exp(-dt / (150 / Math.max(0.15, rain)));
      this.wetness += (target - this.wetness) * k;
    } else {
      // Decay: slower, and slower still while the air is humid (high fog).
      const humid = 1 + this.current.fogDensity * 0.35;
      const k = 1 - Math.exp(-dt / (260 * humid));
      this.wetness += (target - this.wetness) * k;
    }
    this.wetness = THREE.MathUtils.clamp(this.wetness, 0, 1);

    // ---- lightning --------------------------------------------------------
    this._updateLightning(dt);

    // ---- scheduler --------------------------------------------------------
    if (this.auto && this.blend >= 1) {
      this._dwell -= dt;
      if (this._dwell <= 0) {
        this.set(this._pickNext());
        moved = true;
      }
    }
    return moved;
  }

  _pickNext() {
    const table = TRANSITIONS[this.state] ?? TRANSITIONS.scattered;
    let r = this.rng.float();
    for (const [name, p] of table) {
      r -= p;
      if (r <= 0) return name;
    }
    return table[table.length - 1][0];
  }

  /**
   * Lightning as a Poisson process. A strike is not one flash: it is a leader,
   * a main return stroke and one to three restrikes over ~350 ms, which is what
   * makes it read as lightning and not as a screen wipe.
   */
  _updateLightning(dt) {
    const rate = this.current.lightningRate;
    if (rate <= 0.001) {
      this.flash *= Math.exp(-dt * 14);
      if (this.flash < 1e-4) this.flash = 0;
      this._nextStrike = 1e9;
      return;
    }
    if (this._nextStrike > 1e8) {
      // Mean interval from the rate, exponentially distributed.
      this._nextStrike = this._time - Math.log(Math.max(1e-6, this.rng.float())) * (60 / rate);
    }
    if (this._time >= this._nextStrike) {
      this._strikeTime = this._time;
      this._boltCount = 1 + (this.rng.u32() % 3);
      this._strikeGap = this.rng.range(0.055, 0.12);
      this._nextStrike = this._time - Math.log(Math.max(1e-6, this.rng.float())) * (60 / rate);
      // A bolt is somewhere in the deck, not overhead: bias it low and put it in
      // a random bearing so the key direction of the flash changes every time.
      const a = this.rng.float() * Math.PI * 2;
      const el = this.rng.range(0.12, 0.5);
      this.strikeDir.set(Math.cos(a) * (1 - el), el, Math.sin(a) * (1 - el)).normalize();
    }

    const age = this._time - this._strikeTime;
    if (age < 0 || age > 0.55) {
      this.flash = 0;
      return;
    }
    // Envelope: each restroke is a 12 ms rise and a ~90 ms decay.
    let f = 0;
    for (let i = 0; i < this._boltCount; i++) {
      const t = age - i * this._strikeGap;
      if (t < 0) continue;
      const amp = i === 0 ? 1 : 0.55 / (1 + i);
      f = Math.max(f, amp * Math.min(1, t / 0.012) * Math.exp(-t / 0.09));
    }
    this.flash = f;
  }

  /** Wind vector in km/s on the cloud deck, for the drift uniforms. */
  windKmPerSec(out) {
    const s = (this.current.windSpeed * this.gust) / 1000; // m/s -> km/s
    return out.set(Math.cos(this.windAngle) * s, 0, Math.sin(this.windAngle) * s);
  }
}
