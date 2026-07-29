import * as THREE from 'three';

import { blit, hdrTarget } from './fullscreen.js';
import {
  ATMO,
  SCENE_LUX,
  SUN_ILLUMINANCE_TOP,
  MOON_ILLUMINANCE_NIGHT,
  transmittanceToSpace,
} from './atmosphere.js';
import { SkyLuts } from './luts.js';
import { SkyDome } from './dome.js';
import { Volumetrics } from './volumetrics.js';
import { Celestial, twilightBand } from './celestial.js';
import { cloudSunOcclusion } from './clouds.js';
import { CloudRenderer } from './cloudpass.js';
import { WeatherModel, WEATHER_STATES, WEATHER_NAMES } from './weather.js';
import { RainSystem } from './rain.js';
import { ValleyFog } from './valleyfog.js';
import { SkyIrradianceProbe } from './irradiance.js';

/**
 * Floor on the beam's *luminous* transmittance, as a fraction of unity — see
 * the beam-floor note in `_updateCelestial`. 0.35 puts a 4-degree sun about a
 * stop of luminance under a noon sun (whose luminous transmittance is 0.77)
 * while leaving its physical hue untouched, which is what keeps a golden hour
 * reading as a key light instead of as an ambient wash.
 */
const SUN_LUM_FLOOR = 0.35;

/**
 * Gain on the sun's DIRECTIONAL LIGHT only — not on the irradiance the
 * atmosphere scatters, and not on the sky.
 *
 * The photometric chain in atmosphere.js is right, and it predicts a sunlit
 * stucco wall at ~0.32 radiance units. The level's albedos are darker than that
 * assumption, so the frame's key:fill ratio comes out about a stop flat.
 * Correcting it in the albedos is the right fix and belongs to src/materials.
 * Until then this is the one place the deficit can be paid, and paying it here
 * is at least honest: it moves the key and nothing else, so the sky, the
 * scattering, the aureole and the discs stay on the physical scale, and
 * autoexposure absorbs the level change so what actually moves is the ratio.
 */
const SUN_KEY_GAIN = 1.55;

/**
 * Whole-sky diffuse illuminance as a fraction of the beam under a CLEAR sky.
 * Real clear-sky daylight runs 12-18% of the direct component. Under an
 * overcast it is the other way round and the sky is the only light there is —
 * see `_updateCelestial`, where this is interpolated up to 0.55.
 */
const SKY_AMBIENT_FRACTION = 0.15;

/** Cool night hue for the published ambient — moonlight after the Purkinje shift. */
const NIGHT_AMBIENT_HUE = [0.35, 0.5, 1.0];

/**
 * ---------------------------------------------------------------------------
 * URBAN SKYGLOW — the reason a real city night is READABLE and this one was not
 * ---------------------------------------------------------------------------
 *
 * Before this term the entire night ambient was `0.9 * moonI` plus a residual
 * twilight that is numerically dead by nautical dusk. So at 21:21 under a 97%
 * overcast — the frame this term exists for — the ONLY thing lighting a
 * surface that could not see a lamp was a moon behind a solid cloud deck, and
 * the published ambient came to (0.053, 0.076, 0.152). Measured consequences in
 * that frame: the two-band fill delivered (0.042, 0.079, 0.202) to an up-facing
 * surface, so a road at albedo 0.10 wrote 0.002 into the HDR buffer and landed
 * on code value 11; road, kerb, pavement and grass all sat inside code 6..22
 * with no separation between them; and because the ambient was 4.8:1 blue over
 * red, every material in the frame lost its own hue. 18% of the deep-night
 * clear frame sat under display 0.02 and could carry no information at all.
 *
 * The physics the model was missing is not the moon. It is that A CITY LIGHTS
 * ITS OWN SKY. Sodium lamps, shopfronts, mill flares and headlights scatter off
 * the aerosol column and — far more strongly — off the base of a cloud deck,
 * and that light comes back down as a broad, low-contrast, slightly warm
 * hemisphere over the whole valley. It is why you can read a newspaper by the
 * sky in downtown Pittsburgh on an overcast night and why an overcast urban
 * night is BRIGHTER than a clear one, which is the opposite of the countryside.
 *
 * That is also the cheapest possible answer to "street lamps are emissive and
 * therefore cast no light": the aggregate of a thousand lamps is not a thousand
 * punctual lights, it is an ambient term. This one costs zero light slots, zero
 * draw calls and zero shader permutations — it rides the two-band hemispheric
 * fill the renderer already drives off `ambientColor` (see
 * RenderSystem._updateBounceFill), so it lands on every surface in the city
 * oriented by the same cosine-visibility integral as daylight.
 *
 * Three properties this term MUST have, all of them load-bearing:
 *
 *  1. IT IS GATED ON `1 - beamAlive`, EXACTLY LIKE THE NIGHT HUE. `beamAlive`
 *     is 1 for any sun altitude above -1 degree, so this is provably, exactly
 *     zero for every daylight, golden-hour and civil-twilight frame. The day
 *     scene cannot move, and it is measured that it does not.
 *  2. IT RISES WITH THE OVERCAST. A cloud base is a huge diffuse reflector
 *     hanging 600 m over a lit city; a clear sky returns only the thin aerosol
 *     column. `SKYGLOW_CLEAR` -> `SKYGLOW_OVERCAST` is that ratio, and it is
 *     what makes a wet Pittsburgh overcast night the READABLE one, which is
 *     both true and the money shot in DESIGN.md.
 *  3. IT IS NEARLY NEUTRAL, LEANING WARM — NOT SODIUM. The failure mode on the
 *     other side is documented in atmosphere.js: an ambient that takes the
 *     lamps' hue makes the whole frame warm edge to edge and there is no cool
 *     content left in the world. Night reads as night when the AMBIENT is cool
 *     and the lamps are warm POOLS inside it. But the old ambient was 4.8:1
 *     blue over red, which starves every material's red channel until brick,
 *     rust, timber and skin all read as the same blue-grey — that is how
 *     materials lose their identity at night. A slightly warm grey
 *     restores the red without tipping the frame sodium, and the renderer's own
 *     `skyFillCoolBias` pulls it 70% back toward Rayleigh blue on the way out,
 *     so what lands is cool-neutral with the reds alive.
 */
const SKYGLOW_HUE = [1.0, 0.93, 0.86];

/**
 * Live tunables for the night floor, in scene light units (1 unit = 25 000 lux;
 * see atmosphere.js). Kept on the instance so they can be swept in one browser
 * session without a rebuild, which is how these numbers were chosen.
 *
 *  glowClear     skyglow under a clear night sky: the aerosol column over a lit
 *                city, plus the lamps on the far bank. Small.
 *  glowOvercast  ...and under a solid deck, which is a 600 m ceiling of diffuse
 *                reflector hanging over every sodium lamp in the valley. 3.9x
 *                the clear value. Swept at 0.44 / 0.58 / 0.66 / 0.72 on the
 *                21:21 overcast street frame; 0.62 is the
 *                smallest that clears both crush targets (see below), and
 *                smaller is better because every unit of this is ambient that
 *                is NOT coming from a direction.
 *  moonAmbient   the moon's share of the whole-sky irradiance. Was 0.9, and it
 *                is faded in with `night` so it is exactly 0.9 whenever the sun
 *                is up. A moonlit sky is a far larger fraction of its own key
 *                than a daylit one, and after dark it is the only thing
 *                separating a moon SHADOW from black: at 0.9 the deep-night
 *                01:30 frame put 18.1% of its pixels under display 0.02, which
 *                is the shadowed half of the frame containing no information at
 *                all. 1.8 takes that to 1.5% while leaving the moonlit half and
 *                its cast shadows plainly visible.
 *
 * Measured on preset `low`, HUD masked, A/B in ONE browser session on ONE build
 * (these are runtime tunables precisely so the two halves cannot differ by
 * anything else), with wanted level 0, no helicopter and no searchlight in any
 * frame — the beam is a separate, since-fixed bug that dragged the meter by
 * 0.8 EV, and none of these numbers may contain it:
 *
 *   21:21 overcast, eye level   p50 0.080 -> 0.130   <0.02  1.71% ->  0.03%
 *   21:21 overcast, elevated    p50 0.064 -> 0.113   <0.02  1.45% ->  0.30%
 *   21:21 overcast, rowhouses   p50 0.070 -> 0.099   <0.02 14.12% ->  1.63%
 *   01:30 clear, moonlit        p50 0.047 -> 0.085   <0.02 18.41% ->  1.66%
 *   21:21 pavement + peds       p50 0.076 -> 0.137   >0.98 0.312% -> 0.170%
 *
 * The last row is the one that matters for the "do not trade blacks for clipped
 * whites" test: because this is LIGHT and not EXPOSURE, the metered average
 * rises with it and the meter stops DOWN, so the frame gets brighter in the
 * shadows and LESS clipped in the highlights at the same time. An exposure-only
 * fix of the same size does the opposite — swept, +0.18 stops of exposure took
 * that frame's clipped fraction from 0.141% to 0.518% while leaving the unlit
 * pavement exactly as flat as it was.
 *
 * The day shot set does not move. Same session, same build, A/B:
 *
 *   hero 17:24     mean 0.3983 -> 0.3980   p50 0.336 -> 0.339   exp 1.18 -> 1.17
 *   street 15:00   mean 0.3482 -> 0.3481   p50 0.287 -> 0.287   exp 1.96 -> 1.96
 *   sunset 19:36   mean 0.2159 -> 0.2166   p50 0.127 -> 0.127   exp 1.64 -> 1.64
 *
 * i.e. inside the run-to-run noise of a living city, because every term here is
 * behind a ramp that is identically zero while the sun is above the horizon.
 */
const NIGHT_FILL_DEFAULTS = {
  glowClear: 0.16,
  glowOvercast: 0.62,
  moonAmbient: 1.8,
};

/**
 * Game hours per real SECOND when the clock is running.
 *
 * ---------------------------------------------------------------------------
 * THIS WAS 0.5, AND THE COMMENT NEXT TO IT SAID "48 REAL MINUTES A DAY"
 * ---------------------------------------------------------------------------
 * It is consumed as `this.hour += this.timeRate * dt` with `dt` in SECONDS, so
 * 0.5 game-hours per real second is 24 / 0.5 = **48 real SECONDS** for a full
 * 24-hour cycle. The intent in the comment was right and the number was out by
 * a factor of 60: the game ran a complete dawn-noon-dusk-midnight cycle every
 * 48 seconds, i.e. 75 sunrises in an hour of play.
 *
 * That is the whole of "day to night transitions happen too often", and it is
 * also half of "darkness is still too dark": at 48 s a day
 * the player spends ~19 s of every 48 below civil dusk, so better than a third
 * of every session was night no matter what they were doing. Slowing the clock
 * cuts the number of night MINUTES a player sees per session by exactly the
 * same factor it cuts the number of transitions.
 *
 * 48 real minutes per in-game day is GTA V's rate and it is the right one here
 * for the same reason it is there: it is long enough that a mission runs at one
 * time of day (a chapter is 3-8 minutes, i.e. 1.5-4 game hours, so the light
 * shifts within it but does not turn over), and short enough that a player who
 * wants to see the wet downtown night in DESIGN.md does not have to wait out a
 * real evening for it. 24 game hours / (48 * 60 real seconds) = 1/120.
 *
 * Nothing else in this subsystem is phase-locked to the old rate: the weather
 * scheduler, the wetness attack/decay integral, the cloud drift and the fog
 * advection are all driven by REAL seconds (`dt` / `ctx.time.elapsed`) and
 * their tuning is written in real minutes, so they are unchanged by this. The
 * two gates that ARE written against solar motion — the sky-view LUT rebake
 * (`_lutSunDir` vs cos 0.0012) and the env rebake (0.35 degrees) — are
 * thresholds on how far the sun has MOVED, so a slower sun crosses them less
 * often and they get cheaper, never staler. `_lastHourEvent` is a floor() edge,
 * so `time:hour` now fires once every 2 real minutes instead of once every 2
 * real seconds, which is what every listener (`game`, `traffic`, `peds`,
 * `audio`, `ui`) was written expecting.
 */
const DEFAULT_TIME_RATE = 24 / (48 * 60);

/** Real minutes per in-game day implied by DEFAULT_TIME_RATE, for diagnostics. */
export const MINUTES_PER_GAME_DAY = 24 / DEFAULT_TIME_RATE / 60;

/**
 * SKY — atmosphere, time of day, weather, precipitation and global lighting.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS OWNS
 * ---------------------------------------------------------------------------
 *   - A Hillaire/Bruneton atmosphere (Rayleigh + Mie + ozone + multiple
 *     scattering) through three LUTs, drawn as a full-screen dome with a
 *     limb-darkened solar disc and an analytic circumsolar aureole.
 *                                                               dome.js luts.js
 *   - A continuous 24-hour cycle on real spherical astronomy, with a moon on a
 *     first-order lunar orbit whose phase and position agree.    celestial.js
 *   - A starfield with a magnitude power law, blackbody colours, airmass
 *     extinction, scintillation, and a Milky Way with dust lanes.    stars.js
 *   - A volumetric cloud deck: a slab raymarch with a light march, rendered at
 *     half resolution and temporally accumulated, plus a ground shadow map so
 *     the deck throws moving shadow patches across the city.
 *                                                        clouds.js cloudpass.js
 *   - Six weather states that blend continuously over minutes.    weather.js
 *   - Wind-driven rain, splashes, ripples, ledge drips, vehicle spray and
 *     lightning.                                                     rain.js
 *   - Raymarched ground fog with shadow-mapped light shafts, pooled in the
 *     river valleys at dawn.                          volumetrics.js valleyfog.js
 *   - A PMREM environment map that tracks the sun and the weather, regenerated
 *     across two frames so no single frame pays for the whole thing.
 *   - The sun/moon `DirectionalLight`s the renderer's cascades follow.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC API — `const sky = ctx.get('sky')`
 * ---------------------------------------------------------------------------
 * TIME
 *   sky.setTimeOfDay(hours)      0..24 clock time. Snaps and rebakes everything.
 *   sky.timeOfDay                current hour
 *   sky.setTimeRate(hoursPerSec) 0 freezes; default 1/120 — 48 REAL MINUTES per
 *                                in-game day. See DEFAULT_TIME_RATE: this used
 *                                to be 0.5, which is 48 real SECONDS.
 *   sky.day                      whole days elapsed; advances the moon phase
 *   sky.twilight                 'day'|'civil'|'nautical'|'astronomical'|'night'
 *   sky.sunDirection             Vector3 pointing AT the sun   (read only)
 *   sky.moonDirection            Vector3 pointing AT the moon  (read only)
 *   sky.sunAltitude              radians above the horizon
 *   sky.moonPhase                illuminated fraction, 0..1
 *
 * WEATHER
 *   sky.setWeather(name, secs?)  'clear'|'scattered'|'overcast'|'rain'|
 *                                'storm'|'fog' — blends over `secs`
 *   sky.setWeather({ ... })      patch individual fields (art direction/debug)
 *   sky.snapWeather(name)        no transition
 *   sky.setAutoWeather(bool)     let the scheduler drive it
 *   sky.weatherState             the current state name
 *   sky.weather                  the live blended parameter vector
 *   sky.wetness                  0..1 surface wetness (drives `materials`)
 *   sky.rain                     0..1 precipitation rate
 *   sky.wind                     Vector3, m/s
 *   sky.lightningFlash           0..1 this frame
 *   sky.spray(x, y, z, strength) throw wheel spray (called by `vehicles`)
 *   sky.states                   the list of weather names
 *
 * LIGHTING
 *   sky.keyLight                 whichever of sun/moon the cascades follow
 *   sky.sunLight  sky.moonLight  THREE.DirectionalLight
 *   sky.envMap                   the PMREM currently published
 *   sky.ambientColor             Color: the sky's own model of whole-sky
 *                                irradiance, hue AND level
 *   sky.skyglow                  the urban night-sky floor published this frame
 *   sky.nightFill                { glowClear, glowOvercast, moonAmbient } —
 *                                live tunables for it, see SKYGLOW_HUE
 *   sky.indirectScale            indirect-light budget for this sun elevation
 *   sky.exposureBias             EV of metering compensation (+ is darker)
 *   sky.cloudShadowAt(x, z)      0..1 direct sunlight reaching a ground point
 *   sky.fog                      live fog tuning object
 *
 * Events emitted on `ctx.events`:
 *   `weather:change` { state, wetness, rain, wind, windAngle, windX, windZ,
 *                      lightning, cloudCoverage, fogDensity, transition }
 *   `time:hour`      { hour, day, twilight, sunAltitude }
 *   `sky:changed`    { hour, sunDir, sunIntensity, moonIntensity }
 *   `sky:env`        { envMap, sunDir }
 *   `sky:lightning`  { flash, dir }   fires once per strike, for audio/fx
 *
 * ---------------------------------------------------------------------------
 * THE WETNESS CONTRACT
 * ---------------------------------------------------------------------------
 * `materials` publishes the global wetness uniform; this subsystem drives it.
 * Per ARCHITECTURE.md rule 2 the module is never imported — it is reached at
 * runtime and every call is guarded, so the sky boots whether or not the API
 * exists yet. The names tried, in order: `setWetness(w)`, then a `wetness`
 * property. The value is also on every `weather:change` payload, so a consumer
 * that prefers to listen rather than be pushed at can.
 */
export class SkySystem {
  static id = 'sky';
  static deps = ['render', 'materials'];

  async init(ctx) {
    this.ctx = ctx;
    const r = ctx.get('render');
    this.render = r;
    this.renderer = r.renderer;
    const q = ctx.config.q;
    this.rng = ctx.rng.fork();

    /**
     * A/B switches, per ARCHITECTURE.md rule 12's corollary: every claim this
     * subsystem makes about the light has to have an arm where it goes red.
     * Read once, off the URL, so `src/render/shotprobe.mjs --params=...` can
     * photograph either arm of the pair without a rebuild.
     *
     *   ?owNoSunKey=1   the sun's DIRECTIONAL light only, forced to zero. The
     *                   sky, the scattering, the discs and the ambient are
     *                   untouched, so this isolates "what does the beam do to
     *                   this frame" from "what does daylight do to this frame".
     *                   It is the control for every cast-shadow measurement:
     *                   with the key gone there is nothing to cast one, so a
     *                   shadow metric that does not collapse here is measuring
     *                   texture, not light.
     *   ?owSkyOld=1     put the golden-hour exposure compensation back on its
     *                   old `beamAlive` gate — see the note on `goldenShutter`
     *                   in `_updateCelestial`. It is the only thing this pass
     *                   changed that a photograph can see, so this one switch
     *                   is a complete before/after in one build and one
     *                   browser session. (The day-length fix is invisible to
     *                   `tools/capture.mjs` by construction: capture mode sets
     *                   `timeRate = 0`, so `DEFAULT_TIME_RATE` is never read.
     *                   `--clock` in `src/sky/keyprobe.mjs` is what tests it.)
     */
    const _q = typeof location !== 'undefined' ? location.search : '';
    this.debugNoSunKey = /[?&]owNoSunKey=1/.test(_q);
    this.debugOldSky = /[?&]owSkyOld=1/.test(_q);

    this.celestial = new Celestial();
    this.hour = 16.5;
    this.day = 0;
    this._lastHourEvent = -1;
    // Capture mode must not move the sun or the weather between frames.
    this.timeRate = ctx.config.deterministic === true ? 0 : DEFAULT_TIME_RATE;

    // ---- weather ----------------------------------------------------------
    this.model = new WeatherModel(this.rng.fork ? this.rng.fork() : this.rng);
    this.model.snap('scattered');
    this.model.auto = ctx.config.deterministic !== true;
    this._wind = new THREE.Vector3();
    this._windKm = new THREE.Vector3();
    this._lastPublished = { wetness: -1, rain: -1, wind: -1, state: '' };

    /**
     * Ground fog.
     *
     * -----------------------------------------------------------------------
     * THE SINGLE-SCATTERING ALBEDO, AND WHY IT IS NOW 1.07 AND NOT 2.48
     * -----------------------------------------------------------------------
     * `scatter` and `extinction` are separate uniforms so the visibility down a
     * street and the readability of a shaft can be set independently. They used
     * to be 3.6e-3 and 1.45e-3, an albedo of 2.48 — a medium that scatters two
     * and a half times more light than it removes, which is not a medium, it is
     * an emitter.
     *
     * What that bought was readable shafts. What it cost was a NEUTRAL VEIL
     * PROPORTIONAL TO THE ISOTROPIC FLOOR OF THE PHASE FUNCTION over every pixel
     * of the frame, sky included — and that veil is what an adversarial review
     * measured as an achromatic sky. Numbers, at 19:20 looking at the zenith:
     * the in-scatter came to (0.0090, 0.0061, 0.0036) against a twilight zenith
     * whose own radiance is about (0.008, 0.014, 0.030). It doubled the red
     * channel of the darkest, bluest part of the sky and left the blue almost
     * alone, which took the zenith from a 3.75:1 blue-to-red ratio to 2.0:1 —
     * a violet-blue turned into slate grey, and no Rayleigh column left in the
     * frame at all.
     *
     * The correct place to pay for shaft readability is `shaftGain`, because
     * that multiplier is applied to the ANISOTROPIC EXCESS ONLY (see
     * skFogInscatterPhase in volumetrics.js) — it lifts the forward lobe, which
     * is where a shaft is, and does not touch the 1/4pi floor, which is where
     * the veil is. So: albedo down to roughly physical, shaft gain up to keep
     * the shafts within a few percent of where they were, and the frame loses
     * 2.3x of grey wash for nothing.
     */
    this._fog = {
      scatter: 1.55e-3,
      extinction: 1.45e-3,
      heightScale: 20.0,
      baseY: -2.0,
      maxDistance: 1400.0,
      shaftGain: 5.5,
      ambientGain: 0.22,
      noise: 0.55,
      noiseScale: 0.045,
      phaseForward: 0.76,
      phaseBackward: -0.36,
      phaseBackWeight: 0.34,
      /** Blue-biased so distant geometry loses red first, as Rayleigh does. */
      extinctionTint: new THREE.Vector3(0.94, 1.02, 1.24),
    };
    this._fogBase = { scatter: 1.55e-3, extinction: 1.45e-3 };

    // ---- shared uniform objects -------------------------------------------
    // Every pass and the dome reference these same objects, so one write per
    // frame updates the entire subsystem.
    const viewR = ATMO.groundRadiusMM + ATMO.viewAltitudeMM;
    this.shared = {
      uMieScale: { value: 1.35 },
      uViewPos: { value: new THREE.Vector3(0, viewR, 0) },
      /** Camera position in the planet frame; the cloud deck parallaxes off it. */
      uSkyOrigin: { value: new THREE.Vector3(0, viewR, 0) },

      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunIrradiance: { value: new THREE.Vector3() },
      uMoonIrradiance: { value: new THREE.Vector3() },
      uSunDiscRadiance: { value: new THREE.Vector3() },
      uMoonDiscRadiance: { value: new THREE.Vector3() },
      uSunAltitude: { value: 0 },
      uMoonAltitude: { value: 0 },
      uMoonRelAz: { value: 0 },
      // x/y are the true angular radii of the sun and moon; z/w scale them up for
      // readability. skSunDisc divides by z*z so enlarging it adds no energy.
      uDisc: { value: new THREE.Vector4(0.004654, 0.004516, 3.0, 4.2) },
      /**
       * Lower hemisphere of the IBL. A wet rustbelt city is grey-brown asphalt,
       * soot brick and slag, not sand: 0.19 with a warm bias is what a street
       * actually bounces, and it is the only warm fill a shaded alley gets once
       * the sun is off it.
       */
      uGroundAlbedo: { value: new THREE.Vector3(0.215, 0.196, 0.176) },
      uHorizonMurk: { value: 0.16 },
      // Sky highlight roll-off: knee in scene radiance, overshoot exponent.
      uSkyRolloff: { value: new THREE.Vector2(0.3, 1.5) },

      uStarParams: { value: new THREE.Vector4(0, 0.5, 0, 0) },
      uCelestial: { value: new THREE.Matrix3() },

      // x coverage, y density, z detail gain, w time (seconds)
      uCloudParams: { value: new THREE.Vector4(0.4, 2.15, 1, 0) },
      // x cirrus coverage, y cirrus opacity, z wind x (km/s), w wind z (km/s)
      uCloudParams2: { value: new THREE.Vector4(0.22, 0.28, 0.004, 0.0016) },
      // x base km, y top km, z stratus blend, w shear km per unit height
      uCloudShape: { value: new THREE.Vector4(1.25, 2.6, 0.05, 0.42) },
      // x absorption, y ambient gain, z powder, w evolution seconds
      uCloudLight: { value: new THREE.Vector4(1.05, 1.0, 1.0, 0) },
      // x/y world XZ of the shadow square's corner, z 1/extent, w extent
      uCloudShadowRect: { value: new THREE.Vector4(0, 0, 1 / 2400, 2400) },
      uCloudShadowMap: { value: null },
      /**
       * How much of the frame's light is the direct beam, 0..1. The screen-space
       * cloud shadow patch scales by it, so an overcast (where nothing is direct)
       * gets no patches and a clear noon gets strong ones.
       */
      uCloudShadowStrength: { value: 0 },

      uFlash: { value: new THREE.Vector4(0, 0, 0, 0) },
      uFlashDir: { value: new THREE.Vector3(0, 1, 0) },

      // volumetric / camera
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uFog: { value: new THREE.Vector4() },
      uFog2: { value: new THREE.Vector4() },
      uFogExt: { value: new THREE.Vector3() },
      uPhase: { value: new THREE.Vector4() },
      uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
      uKeyIrr: { value: new THREE.Vector3() },
      uFogDrift: { value: new THREE.Vector3() },
      // x valley fog amount, y diurnal gain, z fog top y, w unused
      uValley: { value: new THREE.Vector4(0.14, 1, 90, 0) },
      uValleyMap: { value: null },
      // x/y world XZ origin, z 1/extent
      uValleyRect: { value: new THREE.Vector4(-1500, -1500, 1 / 3000, 3000) },
    };

    // ---- LUTs -------------------------------------------------------------
    this.luts = new SkyLuts(this.renderer, this.shared);
    this.luts.bakeStatic();

    // ---- visible sky ------------------------------------------------------
    this.dome = new SkyDome(this.shared);
    ctx.scene.add(this.dome.mesh);
    // We paint the sky ourselves; drop the renderer's fallback background so it
    // is not drawn underneath us every frame for nothing.
    ctx.scene.background = null;

    // ---- clouds -----------------------------------------------------------
    // Step count follows the quality preset. Temporal accumulation means eight
    // steps a frame converges to roughly what thirty-two would give statically,
    // so the low preset is a softer deck rather than a different one.
    // `config.cloudSteps` overrides the preset — a tuning/diagnosis knob, and the
    // only way to tell an undersampled march apart from a badly shaped density
    // field without rebuilding.
    const cloudSteps =
      ctx.config.cloudSteps ?? (ctx.config.quality === 'ultra' ? 20 : q.volumetrics ? 14 : 8);
    this.clouds = new CloudRenderer(this.shared, {
      scale: ctx.config.quality === 'low' ? 0.4 : 0.5,
      steps: cloudSteps,
      shadowSize: ctx.config.quality === 'low' ? 256 : 384,
      shadowExtent: 2400,
    });
    this.shared.uCloudShadowMap.value = this.clouds.rtShadow.texture;

    // ---- lights -----------------------------------------------------------
    // The renderer takes over shadowing for whichever directional light is
    // brightest (see render/index.js _syncSun), so castShadow stays off.
    this.sunLight = new THREE.DirectionalLight(0xffffff, 4.0);
    this.sunLight.name = 'sky-sun';
    this.sunLight.castShadow = false;
    this.sunLight.target.name = 'sky-sun-target';
    ctx.scene.add(this.sunLight, this.sunLight.target);
    r.addLight(this.sunLight, { range: 1e9, priority: 10 });

    this.moonLight = new THREE.DirectionalLight(0x9fc0ff, 0.0);
    this.moonLight.name = 'sky-moon';
    this.moonLight.castShadow = false;
    ctx.scene.add(this.moonLight, this.moonLight.target);
    r.addLight(this.moonLight, { range: 1e9, priority: 9 });

    this.keyLight = this.sunLight;

    /**
     * Lightning is an AmbientLight and not a directional one, deliberately.
     *
     * `render._syncSun` takes over whichever foreign DirectionalLight is
     * brightest and refits its cascades to it. A 40-intensity bolt would win
     * that contest for two frames, refit four cascades to a new direction, and
     * re-render every shadow caster in the scene — for a flash. An ambient term
     * lights everything at once, which is also what a sheet of cloud lighting up
     * five hundred metres across actually does to a street, and it costs one
     * uniform. The directional character of the strike is carried by the cloud
     * emission in the dome instead.
     *
     * Created once at init and never removed: three folds every AmbientLight
     * into one uniform, so this does not touch the shader permutation count.
     */
    this.flashLight = new THREE.AmbientLight(0xcfe0ff, 0);
    this.flashLight.name = 'sky-lightning';
    ctx.scene.add(this.flashLight);

    // ---- IBL --------------------------------------------------------------
    // 512x256 equirect -> PMREM. Baked from the *same* shader and the *same*
    // uniform objects as the visible sky, so the IBL can never disagree with it.
    this.envEquirect = hdrTarget(512, 256, { name: 'sky-equirect' });
    this.envEquirect.texture.mapping = THREE.EquirectangularReflectionMapping;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();
    this._pmremTarget = null;
    this.envMap = null;
    // ...and the DIFFUSE half of the same environment. PMREM answers "what does
    // a mirror see"; this answers "how much light does a surface facing this way
    // receive", which is the question the shading model asks and the one nothing
    // was measuring. See src/sky/irradiance.js.
    this.irradiance = new SkyIrradianceProbe();

    // ---- volumetrics ------------------------------------------------------
    const steps = q.volumetrics ? (ctx.config.quality === 'ultra' ? 56 : q.ssr ? 44 : 28) : 0;
    this.volumetrics = new Volumetrics(this.shared, r, {
      volumetrics: q.volumetrics,
      steps: Math.max(8, steps),
      scale: 0.5,
    });
    this._unregisterPass = r.registerPass(this.volumetrics);

    // ---- river fog --------------------------------------------------------
    this.valley = new ValleyFog(this.shared);

    // ---- rain -------------------------------------------------------------
    this.rainFx = new RainSystem(ctx);
    ctx.scene.add(this.rainFx.group);

    // ---- bookkeeping ------------------------------------------------------
    this.ambientColor = new THREE.Color(0, 0, 0);
    /** See NIGHT_FILL_DEFAULTS. Sweepable at runtime; re-read every sun move. */
    this.nightFill = { ...NIGHT_FILL_DEFAULTS };
    /** Skyglow irradiance published this frame, for diagnostics. */
    this.skyglow = 0;
    /**
     * The skyglow's own contribution to `ambientColor`, as a colour.
     *
     * Published because the renderer's sky probe has to know which part of the
     * published ambient the DOME accounts for and which part it does not. The
     * dome renders no urban skyglow — a thousand sodium lamps scattering off a
     * cloud base is not in any atmosphere model — so a probe of the dome alone
     * is 17x too dark at night (measured: dome integral 0.009,0.016,0.030
     * against a published ambient of 0.234,0.254,0.348 at the `night` shot).
     * Splitting it out is what lets the probe supply shape and hue for the part
     * it can see, while this term keeps the night floor the night pass measured.
     */
    this.skyglowColor = new THREE.Color(0, 0, 0);
    this.indirectScale = 1;
    this.exposureBias = 0;
    this.twilight = 'day';
    this._beamGain = 1;
    this._beamLuminance = 0;
    this._sunT = [0, 0, 0];
    this._moonT = [0, 0, 0];
    this._envSunDir = new THREE.Vector3(0, -1, 0);
    this._lutSunDir = new THREE.Vector3(0, -1, 0);
    this._tmp = new THREE.Vector3();
    this._keyColor = new THREE.Color();
    this._cloudOcclusion = 1;
    this._cloudOccTarget = 1;
    this._baseSunIntensity = 0;
    this._envAge = 1e9;
    this._envPhase = 0;
    this._skyDirty = true;
    this._envDirty = true;
    this._cloudTime = 0;
    this._occParams = { coverage: 0, density: 0, windX: 0, windZ: 0, time: 0, baseKM: 1.25 };
    this._materials = ctx.peek('materials');
    this._pushedWetness = -1;
    this._wetnessApi = null;
    this._sprayAccum = 0;
    this._lastFlash = 0;

    this._applyWeatherVector();
    this._applyFog();
    this.setTimeOfDay(this.hour);
    this._publishWeather(true);

    console.info(
      `[sky] ready · lat ${this.celestial.site.latitudeDeg} · ` +
        `clouds ${cloudSteps} steps @${this.clouds.scale} · ` +
        `vol ${q.volumetrics ? steps + ' steps @1/2' : 'analytic'} · ` +
        `rain ${this.rainFx.streakCount} streaks · 1 unit = ${SCENE_LUX} lx`
    );

    if (ctx.config.deterministic === true) {
      // Capture-only handle so an inline shot can drive the weather without the
      // lead-owned shot table having to know about it.
      window.__SKY__ = this;
    }
  }

  // =========================================================================
  //  public API
  // =========================================================================

  get timeOfDay() {
    return this.hour;
  }
  get sunDirection() {
    return this.celestial.sun;
  }
  get moonDirection() {
    return this.celestial.moon;
  }
  get sunAltitude() {
    return this.celestial.sunAlt;
  }
  get moonPhase() {
    return this.celestial.moonPhase;
  }
  get fog() {
    return this._fog;
  }
  get weather() {
    return this.model.current;
  }
  get weatherState() {
    return this.model.state;
  }
  get wetness() {
    return this.model.wetness;
  }
  get rain() {
    return this.model.current.rain;
  }
  get wind() {
    return this._wind;
  }
  get lightningFlash() {
    return this.model.flash;
  }
  get states() {
    return WEATHER_NAMES;
  }

  /** Hour of day, 0..24 clock time. Rebakes the sky and the IBL immediately. */
  setTimeOfDay(hours) {
    const h = Number(hours);
    if (!Number.isFinite(h)) return this;
    this.hour = ((h % 24) + 24) % 24;
    this._skyDirty = true;
    this._envDirty = true;
    this._updateCelestial();
    this._bakeSky();
    this._bakeEnvNow();
    this.volumetrics.reset();
    this.clouds.reset();
    this._lastHourEvent = Math.floor(this.hour);
    this.ctx.events.emit('sky:changed', {
      hour: this.hour,
      sunDir: this.celestial.sun,
      sunIntensity: this.sunLight.intensity,
      moonIntensity: this.moonLight.intensity,
    });
    if (this.ctx.config.deterministic === true) {
      const c = this.celestial;
      const sc = this.sunLight.color;
      console.info(
        `[sky] t=${this.hour.toFixed(2)} ${this.twilight} sunAlt=${((c.sunAlt * 180) / Math.PI).toFixed(1)} ` +
          `sunI=${this.sunLight.intensity.toFixed(3)} sunCol=${sc.r.toFixed(2)},${sc.g.toFixed(2)},${sc.b.toFixed(2)} ` +
          `moonI=${this.moonLight.intensity.toFixed(4)} beamLum=${(this._beamLuminance ?? 0).toFixed(3)} ` +
          `amb=${this.ambientColor.r.toFixed(3)},${this.ambientColor.g.toFixed(3)},${this.ambientColor.b.toFixed(3)} ` +
          `glow=${this.skyglow.toFixed(3)} ` +
          `indirect=${this.indirectScale.toFixed(2)} evBias=${this.exposureBias.toFixed(2)} ` +
          `knee=${this.shared.uSkyRolloff.value.x.toFixed(3)} w=${this.model.state} wet=${this.model.wetness.toFixed(2)}`
      );
    }
    return this;
  }

  /** Hours of sky time per second of wall clock. 0 freezes the sun. */
  setTimeRate(hoursPerSecond) {
    this.timeRate = hoursPerSecond || 0;
    return this;
  }

  /**
   * `setWeather('storm')` blends to a named state; `setWeather({ turbidity: 3 })`
   * patches individual fields of the live vector.
   *
   * The second argument accepts THREE forms, because three different callers
   * already exist:
   *   `setWeather('storm', 90)`                 — blend over 90 seconds
   *   `setWeather('storm', { seconds: 90 })`    — the same, named
   *   `setWeather('storm', { immediate: true })`— snap, no transition. This is
   *     what `src/dev/shots.js` sends, and it has to snap: the live system
   *     blends over minutes and a 90-frame capture would never reach the state
   *     it asked for.
   */
  setWeather(nameOrPatch, seconds) {
    if (typeof nameOrPatch === 'string') {
      const o = seconds;
      if (o && typeof o === 'object') {
        if (o.immediate === true) return this.snapWeather(nameOrPatch);
        this.model.set(nameOrPatch, Number(o.seconds ?? o.transition));
      } else {
        this.model.set(nameOrPatch, seconds);
      }
    } else if (nameOrPatch && typeof nameOrPatch === 'object') {
      // Legacy field names from the fixed-time sky map onto the vector.
      const p = { ...nameOrPatch };
      if (p.cloudCoverage === undefined && p.coverage !== undefined) p.cloudCoverage = p.coverage;
      if (p.cirrus !== undefined) p.cirrusCoverage = p.cirrus;
      if (p.fogHeight !== undefined) p.fogHeightM = p.fogHeight;
      if (p.windSpeed !== undefined && p.windSpeed < 0.1) p.windSpeed *= 1000; // km/s -> m/s
      if (p.windAngle !== undefined) this.model.windAngle = p.windAngle;
      this.model.patch(p);
      this._applyWeatherVector();
      this._skyDirty = true;
      this._envDirty = true;
      if (p.turbidity !== undefined) this.luts.bakeStatic();
    }
    return this;
  }

  /** Jump straight to a state with no transition. */
  snapWeather(name) {
    this.model.snap(name);
    this._applyWeatherVector();
    this.luts.bakeStatic();
    this._skyDirty = true;
    this._envDirty = true;
    this._updateCelestial();
    this._bakeSky();
    this._bakeEnvNow();
    this.clouds.reset();
    this.volumetrics.reset();
    this._publishWeather(true);
    return this;
  }

  setAutoWeather(on) {
    this.model.auto = !!on;
    return this;
  }

  /** Fraction of direct sunlight reaching a ground point through the clouds. */
  cloudShadowAt(x, z) {
    const p = this._occParams;
    const w = this.model.current;
    p.coverage = w.cloudCoverage;
    p.density = w.cloudDensity * w.cloudAbsorb;
    p.windX = this.shared.uCloudParams2.value.z;
    p.windZ = this.shared.uCloudParams2.value.w;
    p.time = this._cloudTime;
    p.baseKM = w.cloudBaseKM;
    return cloudSunOcclusion(x, z, this.celestial.sun, p);
  }

  /** Wheel spray. `vehicles` calls this; the sky also scans for vehicles itself. */
  spray(x, y, z, strength = 1) {
    this.rainFx.spray(x, y, z, strength);
  }

  // =========================================================================
  //  frame
  // =========================================================================

  update(dt, ctx) {
    // Cloud drift is deterministic (driven by ctx.time.elapsed) so capture mode
    // reproduces the exact same sky every run.
    this._cloudTime = ctx.time.elapsed;
    this.shared.uCloudParams.value.w = this._cloudTime;
    this.shared.uStarParams.value.z = this._cloudTime;
    // The cloud field evolves in its own noise domain as well as drifting, so a
    // billow changes shape rather than merely translating.
    this.shared.uCloudLight.value.w = this._cloudTime * 0.045;
    // Fog advects slower than the cloud deck and mostly horizontally, so the
    // wisps drift rather than boil.
    this.shared.uFogDrift.value.set(
      this._cloudTime * 0.09,
      this._cloudTime * 0.015,
      this._cloudTime * 0.045
    );

    // ---- clock ------------------------------------------------------------
    if (this.timeRate !== 0) {
      this.hour += this.timeRate * dt;
      while (this.hour >= 24) {
        this.hour -= 24;
        this.day++;
      }
      while (this.hour < 0) {
        this.hour += 24;
        this.day--;
      }
      this._updateCelestial();
      const h = Math.floor(this.hour);
      if (h !== this._lastHourEvent) {
        this._lastHourEvent = h;
        ctx.events.emit('time:hour', {
          hour: h,
          day: this.day,
          twilight: this.twilight,
          sunAltitude: this.celestial.sunAlt,
        });
      }
    }

    // ---- weather ----------------------------------------------------------
    // Pushed EVERY frame, not only during a transition. Three things in the
    // vector move continuously even when the named state is holding: the wind
    // gust (which drives the cloud drift and the rain slant), the diurnal
    // envelope on the river fog (which is a function of the sun, not of the
    // weather), and the cloud evolution clock. Gating this on the blend left all
    // three frozen for the four to seven minutes a state holds, which is exactly
    // long enough to read as a still image.
    const moved = this.model.update(dt);
    this._applyWeatherVector();
    if (moved) {
      // Turbidity is baked into all three LUTs. Rebaking them every frame of a
      // two-minute transition is 1 ms a frame for nothing, so it is gated on a
      // meaningful move — 0.02 of aerosol is well under a just-noticeable
      // difference in the sky it produces.
      if (Math.abs(this.shared.uMieScale.value - this._bakedTurbidity) > 0.02) {
        this.luts.bakeStatic();
        this._bakedTurbidity = this.shared.uMieScale.value;
        this._skyDirty = true;
      }
      this._envDirty = true;
    }
    this._publishWeather(false);
    this._pushWetness();

    // ---- lightning --------------------------------------------------------
    const flash = this.model.flash;
    // A strike lights the whole sky sheet, so the ambient it adds is large; the
    // number is a fraction of a noon sun rather than an absolute, so a bolt is
    // always about the same number of stops over the scene it interrupts.
    this.flashLight.intensity = flash * 3.4;
    const fu = this.shared.uFlash.value;
    const fl = flash * 42.0;
    fu.set(fl * 0.86, fl * 0.93, fl, flash);
    this.shared.uFlashDir.value.copy(this.model.strikeDir);
    if (flash > 0.35 && this._lastFlash <= 0.35) {
      ctx.events.emit('sky:lightning', { flash, dir: this.model.strikeDir });
    }
    this._lastFlash = flash;

    // ---- cloud occlusion of the key ---------------------------------------
    // A cloud crossing the sun is a real, large-scale lighting change. Sampled
    // on the CPU from the same macro field the shader draws and eased hard,
    // because a snapping key light reads as a bug.
    const cam = ctx.camera;
    this._cloudOccTarget = this.cloudShadowAt(cam.position.x, cam.position.z);
    const k = Math.min(1, dt * 0.9);
    this._cloudOcclusion += (this._cloudOccTarget - this._cloudOcclusion) * k;
    this._applyLightIntensities();

    // ---- sky-view LUT -----------------------------------------------------
    // Gated on real solar movement: at the default rate the sun crosses 0.06
    // degrees a frame, and rebaking a 384x192 LUT for that is 0.6 ms of nothing.
    if (this._skyDirty || this._lutSunDir.dot(this.celestial.sun) < Math.cos(0.0012)) {
      this._bakeSky();
    }

    // ---- rain -------------------------------------------------------------
    this.model.windKmPerSec(this._windKm);
    this._wind.set(this._windKm.x * 1000, 0, this._windKm.z * 1000);
    this.rainFx.setConditions(
      this.model.current.rain,
      this.model.wetness,
      this._wind,
      this.ambientColor,
      this._keyColor
    );
    this.rainFx.update(dt, cam);
    this._updateSpray(dt);

    // ---- river fog map ----------------------------------------------------
    this.valley.update(ctx, cam);

    // ---- IBL --------------------------------------------------------------
    this._envAge += dt;
    this._stepEnv();
  }

  lateUpdate(dt, ctx) {
    // The renderer applies the TAA jitter after lateUpdate and removes it again
    // before custom passes run, so these unjittered matrices are exactly what
    // the volumetric and cloud passes want. The dome takes the jittered ones
    // itself, in its own onBeforeRender.
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    this.shared.uInvProj.value.copy(cam.projectionMatrixInverse);
    this.shared.uCamWorld.value.copy(cam.matrixWorld);
    this.shared.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);

    // The cloud deck is 1.2 km up over a 3 km city, so it has to parallax off
    // the camera or it is a skybox. One metre is 1e-6 megametres.
    const p = this.shared.uCamPos.value;
    this.shared.uSkyOrigin.value.set(
      p.x * 1e-6,
      ATMO.groundRadiusMM + Math.max(0, p.y) * 1e-6,
      p.z * 1e-6
    );
    this.clouds.updateShadowRect(p.x, p.z, this.shared.uCloudShadowRect.value);

    // Render this frame's cloud buffer and its ground shadow map. This happens
    // before the renderer takes the frame, and it leaves the render target
    // unbound the way every other bake in this subsystem does.
    const sz = this.render.screenSize;
    if (sz.width > 1 && sz.height > 1) {
      this.clouds.render(this.renderer, cam, sz.width, sz.height);
      this.dome.uniforms.uCloudTex.value = this.clouds.texture;
      this.dome.uniforms.uCloudTexel.value.set(1 / sz.width, 1 / sz.height);
      this.renderer.setRenderTarget(null);
    }
  }

  // =========================================================================
  //  internals
  // =========================================================================

  /** Push the blended weather vector into every uniform that reads it. */
  _applyWeatherVector() {
    const w = this.model.current;
    const s = this.shared;
    s.uMieScale.value = w.turbidity;
    if (this._bakedTurbidity === undefined) this._bakedTurbidity = w.turbidity;
    s.uHorizonMurk.value = w.horizonMurk;

    const cp = s.uCloudParams.value;
    cp.x = w.cloudCoverage;
    cp.y = w.cloudDensity;
    cp.z = w.cloudDetail;

    this.model.windKmPerSec(this._windKm);
    const cp2 = s.uCloudParams2.value;
    cp2.x = w.cirrusCoverage;
    cp2.y = w.cirrusOpacity;
    cp2.z = this._windKm.x;
    cp2.w = this._windKm.z;

    s.uCloudShape.value.set(w.cloudBaseKM, w.cloudTopKM, w.cloudStratus, w.cloudShear);
    const cl = s.uCloudLight.value;
    cl.x = w.cloudAbsorb;
    // Ambient gain on the deck. Under an overcast the cloud IS the light source
    // and its own base is lit almost entirely by multiple scattering within the
    // sheet, which a single light march under-reports badly — a stratus deck lit
    // only by the march comes out as a black ceiling.
    cl.y = 1.0 + 0.8 * w.cloudStratus * w.cloudCoverage;
    cl.z = 1.0 - 0.55 * w.cloudStratus;

    // Ground fog scales off the base tuning.
    this._fog.scatter = this._fogBase.scatter * w.fogDensity;
    this._fog.extinction = this._fogBase.extinction * w.fogDensity;
    this._fog.heightScale = w.fogHeightM;
    this._fog.shaftGain = w.shaftGain;
    this._applyFog();

    // River fog: the amount, and the diurnal envelope that decides when it is
    // there at all. Radiation fog forms overnight in a cold river valley and
    // burns off within a couple of hours of sunrise, which is exactly the window
    // the dawn shot lives in.
    const altDeg = THREE.MathUtils.radToDeg(this.celestial.sunAlt);
    // Peak from an hour before sunrise to two hours after; gone by mid morning;
    // creeping back after sunset.
    const morning = this.hour < 12;
    const diurnal = morning
      ? 1 - THREE.MathUtils.smoothstep(altDeg, 2, 19)
      : 0.35 * THREE.MathUtils.smoothstep(-altDeg, -4, 6);
    s.uValley.value.set(w.riverFog, 0.25 + 0.95 * diurnal, this._fog.baseY + w.fogHeightM * 2.6, 0);
  }

  _applyFog() {
    const f = this._fog;
    this.shared.uFog.value.set(f.scatter, 1 / f.heightScale, f.baseY, f.maxDistance);
    this.shared.uFog2.value.set(f.extinction, f.shaftGain, f.ambientGain, f.noise);
    this.shared.uFogExt.value.copy(f.extinctionTint).multiplyScalar(f.extinction);
    this.shared.uPhase.value.set(
      f.phaseForward,
      f.phaseBackward,
      f.phaseBackWeight,
      f.noiseScale
    );
  }

  /**
   * Emit `weather:change`. Fires immediately on a state change, and otherwise
   * at 4 Hz while anything a consumer cares about is actually moving — a
   * transition is two minutes long and listeners (materials, fx, audio, props)
   * want the continuous values, not a single edge.
   */
  _publishWeather(force) {
    const m = this.model;
    const last = this._lastPublished;
    const stateChanged = m.state !== last.state;
    const drift =
      Math.abs(m.wetness - last.wetness) > 0.01 ||
      Math.abs(m.current.rain - last.rain) > 0.01 ||
      Math.abs(m.current.windSpeed * m.gust - last.wind) > 0.3;
    if (!force && !stateChanged && !drift) return;

    last.state = m.state;
    last.wetness = m.wetness;
    last.rain = m.current.rain;
    last.wind = m.current.windSpeed * m.gust;

    this.ctx.events.emit('weather:change', {
      state: m.state,
      wetness: m.wetness,
      rain: m.current.rain,
      wind: last.wind,
      windAngle: m.windAngle,
      windX: Math.cos(m.windAngle) * last.wind,
      windZ: Math.sin(m.windAngle) * last.wind,
      lightning: m.current.lightningRate,
      cloudCoverage: m.current.cloudCoverage,
      fogDensity: m.current.fogDensity,
      transition: m.blend,
    });
  }

  /**
   * Drive the global wetness uniform published by `materials`.
   *
   * Resolved once and cached: the API is reached at runtime (never imported)
   * and guarded, so this subsystem boots and runs identically whether or not
   * `materials` has shipped it yet. The value also rides on every
   * `weather:change` payload for consumers that would rather listen.
   */
  _pushWetness() {
    const w = this.model.wetness;
    if (Math.abs(w - this._pushedWetness) < 0.002) return;
    this._pushedWetness = w;
    const m = this._materials ?? (this._materials = this.ctx.peek('materials'));
    if (!m) return;
    if (this._wetnessApi === null) {
      this._wetnessApi =
        typeof m.setWetness === 'function' ? 'fn' : 'wetness' in m ? 'prop' : 'none';
      if (this._wetnessApi === 'none') {
        console.info(
          '[sky] materials.setWetness() not present yet — wetness is published on ' +
            'weather:change and readable as sky.wetness'
        );
      }
    }
    if (this._wetnessApi === 'fn') m.setWetness(w);
    else if (this._wetnessApi === 'prop') m.wetness = w;
  }

  /**
   * Spray off moving vehicles. `vehicles` is expected to call `sky.spray()`
   * itself, but the sky also scans whatever list it can find so wet roads throw
   * spray whether or not that call has been wired up yet. Budgeted, guarded and
   * allocation free.
   */
  _updateSpray(dt) {
    if (this.model.wetness < 0.12) return;
    this._sprayAccum += dt;
    if (this._sprayAccum < 0.05) return;
    this._sprayAccum = 0;
    const veh = this.ctx.peek('vehicles');
    const list = veh?.vehicles;
    if (!Array.isArray(list) || list.length === 0) return;
    const cam = this.ctx.camera.position;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const p = v?.position ?? v?.object3D?.position ?? v?.mesh?.position;
      if (!p) continue;
      const dx = p.x - cam.x;
      const dz = p.z - cam.z;
      if (dx * dx + dz * dz > 3600) continue; // 60 m
      const speed = v.speed ?? v.velocity?.length?.() ?? 0;
      if (speed < 4) continue;
      this.rainFx.spray(p.x, p.y - 0.4, p.z, Math.min(1, (speed - 4) / 22) * this.model.wetness);
    }
  }

  /** Sun/moon geometry, colours and intensities for the current hour. */
  _updateCelestial() {
    const c = this.celestial.setHour(this.hour, this.day);
    const s = this.shared;

    s.uSunDir.value.copy(c.sun);
    s.uMoonDir.value.copy(c.moon);
    s.uSunAltitude.value = c.sunAlt;
    s.uMoonAltitude.value = c.moonAlt;
    // The sky-view LUT is baked with the sun at azimuth 0, so the moon only
    // needs its azimuth *relative* to the sun.
    let rel = c.moonAz - c.sunAz;
    while (rel > Math.PI) rel -= 2 * Math.PI;
    while (rel < -Math.PI) rel += 2 * Math.PI;
    s.uMoonRelAz.value = rel;
    c.celestialMatrix(s.uCelestial.value);

    /**
     * TURBIDITY IS THE ROOT OF THE SUN'S COLOUR, SO IT IS CHECKED HERE.
     *
     * `transmittanceToSpace` integrates the aerosol column with this as a
     * multiplier; a non-finite value comes back as exp(-NaN) in all three
     * channels, `smax` becomes NaN, and the DirectionalLight's intensity and
     * colour both go with it. Every lit pixel in the frame is then NaN and the
     * screen is black — which is exactly what one caller passing an options
     * object where a number was expected did to the whole project.
     *
     * The weather vector is now guarded at its own writer (WeatherModel.set),
     * so this is the second line of defence rather than the first. It stays
     * because the consequence of missing it is total and the cost is one
     * comparison per sun move.
     */
    let mie = this.model.current.turbidity;
    if (!Number.isFinite(mie) || mie <= 0) {
      this._reportNonFinite('turbidity', mie);
      mie = 1.35;
      this.model.snap(this.model.state in WEATHER_STATES ? this.model.state : 'scattered');
    }
    const altDeg = THREE.MathUtils.radToDeg(c.sunAlt);
    this.twilight = twilightBand(altDeg);

    // ---- sun ---------------------------------------------------------------
    const muS = Math.sin(c.sunAlt);
    // Fraction of the solar disc above the horizon: without this the key light
    // snaps off at sunset instead of dimming through the last half degree.
    const discS = THREE.MathUtils.clamp(0.5 + muS / (2 * 0.004654), 0, 1);
    transmittanceToSpace(Math.max(muS, 0.0008), mie, this._sunT);
    // The solar spectrum is a touch warm of D65 even before the atmosphere.
    const tint = [1.0, 0.975, 0.94];
    const T = this._sunT;
    // ---- the key is the disc PLUS its aureole -------------------------------
    // Transmittance alone is the extinction of the *disc*, and at four degrees of
    // elevation it is (0.51, 0.23, 0.06) — a beam with essentially no blue in it.
    // But a surface at golden hour is not lit by the disc alone: the aerosol
    // forward peak puts a solar aureole ten to fifteen degrees wide around it,
    // and that light is far less reddened because it was scattered out of the
    // column near the observer rather than travelling the whole of it. Raising
    // the transmittance to a power below one is the cheap, monotonic way to say
    // "the effective key is the disc convolved with its aureole".
    const aureoleP = THREE.MathUtils.lerp(
      0.55,
      1.0,
      THREE.MathUtils.smoothstep(altDeg, 0, 16)
    );
    const sr = Math.pow(T[0], aureoleP) * tint[0];
    const sg = Math.pow(T[1], aureoleP) * tint[1];
    const sb = Math.pow(T[2], aureoleP) * tint[2];
    const smax = Math.max(1e-6, sr, sg, sb);
    this.sunLight.color.setRGB(sr / smax, sg / smax, sb / smax);

    // ---- beam floor --------------------------------------------------------
    // The beam at 4 degrees keeps its red channel but loses two thirds of its
    // LUMINANCE while the whole west sky is at its brightest. Left alone that
    // inverts the frame — the shaded wall comes out brighter than the sunlit
    // one. So: the beam's HUE stays exactly on the physical transmittance curve
    // and only its luminance is floored, for as long as any part of the disc can
    // see the scene. Below that it releases into blue hour normally.
    const lumT = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;
    const beamAlive = THREE.MathUtils.smoothstep(altDeg, -6.0, -1.0);
    const lumFloor = SUN_LUM_FLOOR * beamAlive;
    const beamGain = Math.max(1, lumFloor / Math.max(lumT, 1e-5));
    this._beamGain = beamGain;
    this._baseSunIntensity = SUN_ILLUMINANCE_TOP * smax * discS * beamGain;
    this._beamLuminance = SUN_ILLUMINANCE_TOP * Math.max(lumT * beamGain, 1e-6) * discS;

    // Irradiance handed to the sky LUT is the *extraterrestrial* value: the
    // scattering raymarch applies the transmittance itself.
    s.uSunIrradiance.value.set(
      SUN_ILLUMINANCE_TOP * tint[0],
      SUN_ILLUMINANCE_TOP * tint[1],
      SUN_ILLUMINANCE_TOP * tint[2]
    );

    // Solar disc radiance is E/omega = 75000 units, which overflows a half-float
    // target once bloom touches it. Clamped to 4000: still six stops above
    // anything else in the frame, so it tone-maps to white and blooms hard.
    const discRad = 4000;
    s.uSunDiscRadiance.value.set(discRad * tint[0], discRad * tint[1], discRad * tint[2]);

    // ---- night ramps -------------------------------------------------------
    // Key handover: the moon may only become the brightest light once the sun is
    // genuinely gone, or the renderer would fit its cascades to the wrong one.
    const keyRamp = THREE.MathUtils.smoothstep(-altDeg, -3, 5);
    // Presentation ramp for stars, Milky Way and the moon disc.
    const nightRamp = THREE.MathUtils.smoothstep(-altDeg, 0, 9);

    // ---- moon --------------------------------------------------------------
    const muM = Math.sin(c.moonAlt);
    const discM = THREE.MathUtils.clamp(0.5 + muM / (2 * 0.004516), 0, 1);
    transmittanceToSpace(Math.max(muM, 0.0008), mie, this._moonT);
    const MT = this._moonT;
    // Moonlight is physically warm (lunar regolith is reddish) but reads cool
    // because scotopic vision peaks blue — the Purkinje shift. Cinema has
    // rendered night blue for a century; we follow it, and modulate that tint by
    // the real atmospheric reddening so a low moon still goes amber.
    const cool = [0.66, 0.8, 1.0];
    const mr = MT[0] * cool[0];
    const mg = MT[1] * cool[1];
    const mb = MT[2] * cool[2];
    const mmax = Math.max(1e-6, mr, mg, mb);
    this.moonLight.color.setRGB(mr / mmax, mg / mmax, mb / mmax);
    let moonI = MOON_ILLUMINANCE_NIGHT * c.moonPhase * mmax * discM * keyRamp;

    // The renderer switches its own 4.3-intensity fallback sun back on if no
    // foreign directional light is brighter than 0.01. Keep a floor so that
    // never happens during the handover minute.
    if (Math.max(this._baseSunIntensity, moonI) < 0.03) moonI = 0.03;
    this.moonLight.intensity = moonI;
    this._moonIntensity = moonI;

    const moonIrr = MOON_ILLUMINANCE_NIGHT * c.moonPhase * keyRamp;
    s.uMoonIrradiance.value.set(moonIrr * cool[0], moonIrr * cool[1], moonIrr * cool[2]);

    // Day: a pale disc a little above the daytime sky. Night: far enough above
    // the night sky to clip to white and bloom, the way every photograph does.
    const moonDisc = THREE.MathUtils.lerp(0.35, 3.5, nightRamp);
    s.uMoonDiscRadiance.value.set(moonDisc, moonDisc * 0.985, moonDisc * 0.95);

    // ---- how much of the sky is a solid sheet ------------------------------
    // The single most important weather number for the LIGHTING, as opposed to
    // for the look of the sky: a broken deck still has a key light and shadows,
    // a solid one has neither and the sky becomes the source.
    const w = this.model.current;
    const overcast = THREE.MathUtils.clamp(
      w.cloudStratus * w.cloudCoverage * 1.15,
      0,
      1
    );
    this._overcast = overcast;

    // ---- ambient colour (published, not used for lighting) -----------------
    // The real ambient is the PMREM; this is a cheap CPU stand-in so the HUD and
    // gameplay code can ask "what colour is the daylight right now" without a
    // GPU readback.
    //
    // Two things this must NOT do. It must not go warm at night: below the
    // horizon the sun's transmittance normalises to pure sodium orange, so an
    // unguarded lerp toward "the beam's colour" publishes a street-lamp-coloured
    // night ambient and every shadow in the frame comes out the hue of the
    // practicals. And the warm swing at sunset belongs to the sun's own HUE, not
    // to a dead beam, so it is gated on the beam still being alive.
    const warm = (1 - THREE.MathUtils.smoothstep(altDeg, 1, 22)) * beamAlive * (1 - overcast);
    const night = 1 - beamAlive;
    const nh = NIGHT_AMBIENT_HUE;
    // Overcast light is neutral to slightly cool — a bright grey dome, not blue
    // sky. Pulling the daytime hue toward grey with the overcast is what stops a
    // rainy Pittsburgh afternoon reading as a blue-filtered sunny one.
    const dayR = THREE.MathUtils.lerp(0.36, 0.74, overcast);
    const dayG = THREE.MathUtils.lerp(0.56, 0.79, overcast);
    const dayB = THREE.MathUtils.lerp(1.0, 0.86, overcast);
    const ar = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(dayR, nh[0], night),
      this.sunLight.color.r,
      warm
    );
    const ag = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(dayG, nh[1], night),
      this.sunLight.color.g,
      warm
    );
    const ab = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(dayB, nh[2], night),
      this.sunLight.color.b,
      warm
    );
    // The sky's share of the total. 15% of the beam under a clear sky; under an
    // overcast the beam is essentially gone and the sky is carrying everything,
    // so the fraction goes to 55% of what the beam WOULD have been.
    const skyFrac = THREE.MathUtils.lerp(SKY_AMBIENT_FRACTION, 0.55, overcast);
    // The moon term is deliberately generous against the day term: a moonlit sky
    // is a much larger fraction of its own key than a daylit one, and it is the
    // only thing separating a night shadow from black.
    // The twilight sky is a real source and it is the ONLY one between sunset
    // and moonrise. Modelled off the same exponential the roll-off knee uses, so
    // the two cannot disagree about how bright the blue hour is.
    const twilightSky = 0.055 * Math.exp(-Math.max(0, -altDeg) * 0.34);
    const nf = this.nightFill;

    /**
     * THE DUSK RAMP, AND THE HOLE IT CLOSES.
     *
     * Everything that only exists once the sun has set is faded in with this,
     * and it is EXACTLY ZERO for any sun altitude at or above the horizon — so
     * no daylight and no golden-hour frame can see any of it. (The disc itself
     * is only fully set at -0.27 degrees, where this has reached 0.002.)
     *
     * It is NOT `1 - beamAlive`, and that difference is a measured bug.
     * `beamAlive` ramps over -6 .. -1 degrees, so between -0.3 and -1 the sun's
     * DISC IS ALREADY BELOW THE HORIZON — `discS` is 0, so `_baseSunIntensity`
     * is 0 and `skyFrac * _baseSunIntensity` contributes nothing — while every
     * night term was still gated off. For roughly three quarters of a degree of
     * solar altitude the model therefore published an ambient of 0.043 with no
     * key light at all, and kept the full 1.35 EV golden-hour stop-down on top
     * of it. Under a clear sky the dome is bright enough to hide it; under an
     * overcast, which is exactly when the dome is not, it is a hole: measured at
     * 19:48 overcast, 27.3% of the frame under display 0.02 — worse than 21:21
     * and worse than midnight.
     *
     * Tying the night terms to the DISC instead of to the beam floor removes the
     * hole by construction, because the two conditions ("the sun has set" and
     * "the night model is in charge") become the same condition.
     */
    const duskRamp = THREE.MathUtils.smoothstep(-altDeg, 0.0, 6.0);

    /**
     * ...AND THE OTHER HALF OF THAT HOLE: A DISC SHUTTER ON THE SKY.
     *
     * `_baseSunIntensity` carries `discS`, the fraction of the solar disc above
     * the horizon. That is exactly right for a DIRECTIONAL key — the beam is
     * gone when the disc is gone — and it is exactly wrong for the SKY, which
     * stays lit for another half hour. Because the sky's share of the ambient
     * was `skyFrac * _baseSunIntensity`, whole-sky irradiance fell off a cliff
     * as the disc crossed the horizon: MEASURED at 19:48 under an overcast,
     * where `skyFrac` is 0.55 and the sky IS the light, the published ambient
     * went from ~1.65 to 0.057 across the half degree the disc takes to set —
     * 4.8 stops in about two minutes of game clock, with nothing replacing it.
     * That is why an overcast civil dusk measured DARKER than midnight.
     *
     * So the sky gets its own shutter: unity while any disc is up (so every
     * daylight frame is bit-identical — `skyShutter` is 1 and `discS` is 1, and
     * the expression reduces to the old one term for term), then an exponential
     * decay in solar altitude below the horizon. 0.95 per degree is the
     * standard twilight falloff: about 2.5 stops from sunset to -3 degrees and
     * 8 stops to civil dusk at -6, by which point the urban skyglow above has
     * taken over as the source. The two hand off smoothly and the cliff is gone.
     */
    const skyShutter = Math.max(discS, Math.exp(-Math.max(0, -altDeg) * 0.95));
    const daySky = skyFrac * SUN_ILLUMINANCE_TOP * smax * beamGain * skyShutter;

    // The raised moon share is itself faded in with the dusk ramp, so a
    // golden-hour frame — where the moon is already up at intensity 0.01 and the
    // sun is still the key — keeps the original 0.9 exactly and cannot move.
    const moonAmb = THREE.MathUtils.lerp(0.9, nf.moonAmbient, duskRamp);
    const aLevel = daySky + moonAmb * moonI + 2.6 * twilightSky * duskRamp;

    // ---- urban skyglow ------------------------------------------------------
    // See SKYGLOW_HUE. Gated on the dusk ramp, so this term cannot reach a
    // daylight, golden-hour or civil-twilight-with-a-disc frame — which is
    // proved by capture, not asserted: the day shot set does not move.
    const glow = THREE.MathUtils.lerp(nf.glowClear, nf.glowOvercast, overcast) * duskRamp;
    this.skyglow = glow;
    const gh = SKYGLOW_HUE;
    this.skyglowColor.setRGB(gh[0] * glow, gh[1] * glow, gh[2] * glow);
    // ADDED as its own coloured source rather than mixed into the hue: the moon
    // and the city are two different illuminants with two different spectra, and
    // lerping between their hues loses the level of whichever one is smaller.
    this.ambientColor.setRGB(
      ar * aLevel + gh[0] * glow,
      ag * aLevel + gh[1] * glow,
      ab * aLevel + gh[2] * glow
    );

    // ---- sky shoulder -------------------------------------------------------
    // The knee tracks the beam's luminance because autoexposure does, so a
    // daylight zenith (2% of the beam) passes through untouched while a sunset
    // horizon glow (200%+ of it) is rolled off into a gradient instead of a
    // plateau. The knee comes down as the sun does: at 30 degrees the only thing
    // over it is a sunlit cumulus top, which SHOULD be near white; at 5 degrees
    // the whole western half of the dome is over it.
    //
    // The floor is what protects twilight. Once the beam is gone `beamLuminance`
    // goes to zero and a knee proportional to it would roll off the entire blue
    // hour to nothing — so the floor tracks the moon AND the residual twilight
    // sky, which is what is actually in the frame at 20:30.
    /**
     * -----------------------------------------------------------------------
     * THE FLAT OVERCAST SKY CEILING: DIAGNOSED HERE, TRIED HERE, AND
     * DELIBERATELY NOT FIXED HERE. IT BELONGS TO THE TONE CURVE.
     * -----------------------------------------------------------------------
     * A critic measured `driving` (17:12, overcast, deck 0.98 coverage / 0.86
     * stratus) as "5% of frame area clamped to a flat 245-248 sky ceiling with
     * a per-block standard deviation of 1". Reproduced and quantified:
     * **6.04% of that frame is 8x8 blocks whose mean is above code 240 and
     * whose standard deviation is under 2** — an eighth of the picture with no
     * information in it. The altitude ramp above is why: it assumes the thing
     * over the knee is a small sunlit cumulus TOP against a darker blue dome,
     * and under a solid stratus sheet the thing over the knee is the WHOLE
     * SKY, within a few per cent of itself edge to edge.
     *
     * Halving the knee under the overcast was tried, and it works — and it is
     * still the wrong place. A/B on one build, `?owSkyOld=1`, knee x1.0 vs
     * x0.5 under a full overcast:
     *
     *   driving  flat-above-240  6.04% -> 0.91%   mean 0.4709 -> 0.4519
     *   street   flat-above-240  0.02% -> 0.02%   mean 0.4345 -> 0.4263
     *                            carriageway lit 100.2 -> 96.6
     *
     * `street` has no plateau to recover, so it pays 0.07 stops on the road
     * surface and is handed nothing — and the task this was found under is
     * "the game is too dark". A knob that darkens a grey Pittsburgh afternoon
     * to buy back highlight detail in a DIFFERENT frame is not a fix, it is a
     * trade made in the wrong subsystem: the critic's own diagnosis is that
     * THE TONE CURVE HAS NEITHER TOE NOR SHOULDER, and a shoulder is where a
     * highlight this broad should be compressed, once, for every frame. That
     * lives in `src/render/` (composite.js / lut.js). The numbers above are
     * handed over so whoever builds it has the before/after already measured.
     */
    const kneeFrac = THREE.MathUtils.lerp(
      0.045,
      0.11,
      THREE.MathUtils.smoothstep(altDeg, 2.0, 15.0)
    );
    // Residual twilight: the sky at -6 degrees is ~1/400 of daylight, at -12
    // ~1/6000, and it is the only thing in frame. Model it off the same curve
    // the scattering uses so the knee never crushes it.
    const twilightLum = 0.055 * Math.exp(-Math.max(0, -altDeg) * 0.34);
    s.uSkyRolloff.value.set(
      Math.max(kneeFrac * this._beamLuminance, twilightLum + 6.0 * moonI),
      0.34
    );

    // ---- exposure compensation for the time of day --------------------------
    // At four degrees of elevation a street canyon is ENTIRELY in shadow, so a
    // meter that is (correctly) weighted onto the geometry opens up two stops
    // and puts the sky, which has not moved, on the flat top of the tone curve.
    // Every stills photographer shooting a golden hour stops down for the sky
    // and lets the street go dark. This is that decision, on a curve.
    /**
     * The night stop-down assumes there IS something to expose for.
     *
     * Half a stop under is right for a moonlit street with twenty sodium lamps
     * in it — every night frame ever shot is underexposed on purpose. It is
     * wrong for a MOONLESS pre-dawn, where the only light in the sky is the
     * residual twilight and the same compensation takes "deep blue with stars"
     * to "black with stars". At 05:00 that put 73% of the frame under code value
     * 12, which is not a night frame, it is an empty one.
     *
     * So the bias tracks how much night light there actually is.
     */
    /**
     * ...AND IT IS NOW SMALLER, BECAUSE THE NIGHT FLOOR PAYS FOR IT.
     *
     * (0.12 + 0.43) was one stop and a bit of deliberate under-exposure stacked
     * ON TOP of the metering curve's own 1.8-1.9 stops, for a total night
     * stop-down of ~2.4 stops. That is a stills exposure, not a game one: it is
     * defensible when the frame contains a lit subject and it is fatal when the
     * subject is a pedestrian on an unlit pavement, which is the frame a player
     * actually has to navigate. Measured at 21:21 overcast on preset `low`: p50
     * display 0.063, i.e. a median code value of 16.
     *
     * (0.08 + 0.20) leaves the frame roughly two stops under a metered mid grey
     * — still unmistakably night, still darker than any daylight frame in the
     * shot set by four stops — and hands the readability back. Because the whole
     * term is multiplied by `1 - beamAlive` it is EXACTLY ZERO while any part of
     * the solar disc is above the horizon, so no daylight or golden-hour frame
     * can move; that is measured, not assumed.
     */
    /**
     * -----------------------------------------------------------------------
     * ...AND THE SAME HOLE AS THE DUSK RAMP, IN THE OTHER TERM. THE FIX FOR
     * "CIVIL DUSK IS DARKER THAN MIDNIGHT" WAS ONLY HALF APPLIED.
     * -----------------------------------------------------------------------
     * The golden-hour stop-down used to be gated on `beamAlive`, exactly as
     * the night ambient terms used to be — and `beamAlive` ramps over -6..-1
     * degrees, so it is still 0.98 at a solar altitude of -1.4 where `discS`
     * is already ZERO. For the whole of that band the model applied a FULL
     * 1.35 STOPS of deliberate under-exposure to a frame that has no key light
     * left to have stopped down for. The ambient half of this was found and
     * fixed (see the dusk-ramp and sky-shutter notes above, and the 19:48
     * OVERCAST frame that measured 27.3% of pixels under display 0.02); the
     * exposure half was not, and under a CLEAR or SCATTERED sky — where
     * `skyFrac` is 0.15 rather than 0.55, so the sky-shutter fix buys 3.7x
     * less — the hole is still wide open.
     *
     * MEASURED, one fixed downtown street pose, `scattered`, sun altitude in
     * brackets. A/B on ONE build in ONE session — `?owSkyOld=1` is this term's
     * old gate and NOTHING ELSE, so the two halves cannot differ by anything
     * but this, and every hour where the gate agrees comes out BYTE-IDENTICAL
     * rather than merely "within noise":
     *
     *                       mean            p50        <0.02             RMSE
     *   06:00  ( +2.7)  0.1719 -> 0.1719   17 -> 17   5.851 -> 5.851%   0.0000
     *   18:30  (+13.7)  0.4269 -> 0.4269   81 -> 81   0.000 -> 0.000%   0.0000
     *   19:12  ( +6.5)  0.2781 -> 0.2781   33 -> 33   0.163 -> 0.163%   0.0000
     *   19:48  ( -0.5)  0.1148 -> 0.1944   10 -> 24  11.831 -> 0.965%  25.9715
     *   20:24  ( -8.0)  0.1778 -> 0.1778   37 -> 37   0.897 -> 0.897%   0.0000
     *   02:00  (night)  0.1477 -> 0.1477   29 -> 29   1.357 -> 1.357%   0.0000
     *
     * ...and the whole shot set with it: `sunset` (the money shot), `night`,
     * `hero`, `street`, `driving`, `rain` and `point` are all RMSE 0.0000
     * across the same A/B. The only frames this touches are the ones between
     * the disc setting and the night model taking over, which is the band the
     * defect was in.
     *
     * 19:48 was 1.5 stops darker at the median than MIDNIGHT and put nine
     * times as many pixels below display 0.02. That is the frame the player
     * photographed: a full sunset sky over a ground with no information in it.
     * Of the ~1.9 stops of that inversion, 1.07 is this term alone (1.35 stops
     * here against 0.28 at 20:24).
     *
     * AND IT IS NOT AN EXPOSURE RAISE, which is the thing this must not be:
     * clipped pixels over the same A/B went 0.037% -> 0.044%, i.e. nowhere,
     * while crushed pixels fell 12.2x. An earlier agent measured the exposure
     * path properly and rejected it — +0.18 EV took clipping 0.141% -> 0.518%
     * and recovered no separation at all. What is removed here is not exposure
     * headroom, it is a stop-down whose stated precondition (a sun in the sky
     * that the street is standing in the shadow of) is FALSE in the band it
     * was still being applied in.
     *
     * The gate is now the same physical condition the sentence describing the
     * term uses: "stop down FOR THE SKY while the street is in the sun's
     * shadow" only means anything WHILE THERE IS A SUN. `discS` is that
     * condition and it is what `_baseSunIntensity` already carries — but the
     * disc crosses the horizon in half a degree, and a 1.35-stop step in ~4
     * real seconds reads as somebody pulling the exposure. So this is the same
     * shutter widened to +/-1.2 degrees of altitude, which is ~26 real seconds
     * at the shipped clock rate and slow enough to be invisible under the
     * meter's own adaptation.
     *
     * The widening also guarantees the signed-off frame cannot move: `sunset`
     * is authored at 19.6, where the sun is +1.67 degrees up and this
     * expression clamps to exactly 1.0 — the same value `beamAlive` had — so
     * the money shot is unchanged term for term, which is measured, not
     * asserted. Every daylight shot in the set has altitude 26-66 degrees,
     * where the smoothstep in front has already taken the whole term to zero.
     */
    const GOLDEN_SHUTTER_DEG = 1.2;
    const goldenShutter = this.debugOldSky
      ? beamAlive
      : THREE.MathUtils.clamp(
          0.5 + Math.sin(c.sunAlt) / (2 * Math.sin(GOLDEN_SHUTTER_DEG * (Math.PI / 180))),
          0,
          1
        );
    const nightLight = THREE.MathUtils.clamp(moonI / 0.12, 0, 1);
    this.exposureBias =
      1.35 * (1 - THREE.MathUtils.smoothstep(altDeg, 1.0, 13.0)) * goldenShutter +
      (0.08 + 0.20 * nightLight) * (1 - beamAlive) -
      // ...and back off under an overcast. There is no bright sky to protect —
      // the whole dome is within a stop of the street — so holding the golden
      // hour compensation there just makes a grey day a dark one.
      //
      // Deliberately still on `beamAlive` and NOT on the shutter above: this
      // term is NEGATIVE, i.e. it makes an overcast BRIGHTER, and retiring it
      // at the disc would re-open the hole on the overcast side that the
      // sky-shutter work closed.
      0.45 * overcast * beamAlive;

    /**
     * Released — and then some — once the beam is gone. After dark the moonlit
     * sky is the ONLY fill there is, and a night frame with a fifth of its
     * pixels under code value 12 is not a night frame, it is an empty one.
     *
     * MEASURED AND REJECTED, so nobody spends the afternoon on it twice: the
     * 0.45 day-side floor looks like the obvious lever for the dark civil-dusk
     * frame — it is the sky's own diffuse contribution, halved at exactly the
     * hour when the sky is the only source — and it does essentially nothing.
     * A/B on one build, one session, the same downtown street pose, floor
     * 0.45 vs 0.80:
     *
     *   06:00  <0.02  5.743% -> 5.709%   p50 17 -> 17
     *   19:12  p50 33 -> 33              mean 0.2764 -> 0.2776
     *   19:48  <0.02 11.711% -> 11.784%  mean 0.1141 -> 0.1148
     *
     * i.e. inside the noise floor everywhere, and the day-hour RMSE of that
     * pair (0.32-0.40 at 09:00/12:42/15:00/17:00, where the change is exactly
     * zero by construction) says what the noise floor IS. The reason it does
     * nothing is worth knowing: `owIndirect.x` multiplies the PMREM diffuse,
     * GTAO multiplies that, and GTAO only started emitting anything other than
     * 1.0 very recently — so this term is a small share of the fill a shaded
     * surface actually receives, and doubling a small share is still small.
     * The lever that DOES move a civil-dusk frame is `exposureBias` below.
     */
    this.indirectScale = THREE.MathUtils.lerp(
      // Moonless is the hardest case for the IBL: the twilight sky is the only
      // source in the world and the budget has to reach further to find it.
      THREE.MathUtils.lerp(3.1, 2.2, nightLight),
      THREE.MathUtils.lerp(0.45, 1.0, THREE.MathUtils.smoothstep(altDeg, 0.0, 14.0)) *
        // Under an overcast the IBL is the light. Budget goes up, not down.
        THREE.MathUtils.lerp(1.0, 1.75, overcast),
      beamAlive
    );

    // ---- stars -------------------------------------------------------------
    // Calibrated against the moonlit sky the LUT actually produces: the
    // brightest first-magnitude stars sit about two stops above the zenith
    // radiance, the Milky Way's spine about half a stop below it.
    s.uStarParams.value.x = 0.07 * nightRamp;
    s.uStarParams.value.y = 0.55;
    s.uStarParams.value.w = 0.16 * nightRamp;

    // ---- light transforms --------------------------------------------------
    // Clamp the light direction just above the horizon: a directional light at
    // exactly 0 degrees degenerates the cascade fit.
    this._placeLight(this.sunLight, c.sun, 0.006);
    this._placeLight(this.moonLight, c.moon, 0.026);

    this._applyLightIntensities();
    this._skyDirty = true;
    if (this._envSunDir.dot(c.sun) < Math.cos(0.35 * (Math.PI / 180))) this._envDirty = true;
  }

  /**
   * Report a non-finite value once per key, loudly, with the state that made it.
   *
   * This subsystem publishes two DirectionalLights that the renderer fits its
   * cascades to and that every lit material multiplies by. A NaN in either one
   * turns every lit pixel in the frame into NaN, the screen goes black, and the
   * metering — which is downstream of the same pixels — winds to its ceiling
   * chasing an image that is not there. There is no graceful degradation and no
   * partial symptom: it is total, and it looks like somebody else's bug.
   *
   * So the sky says so itself, with the hour and the weather state, because
   * that is the pair that identifies which frame introduced it.
   */
  _reportNonFinite(what, value) {
    this._badKeys ??= new Set();
    if (this._badKeys.has(what)) return;
    this._badKeys.add(what);
    console.error(
      `[sky] NON-FINITE ${what} = ${value} at hour ${this.hour?.toFixed?.(2)} ` +
        `weather "${this.model?.state}" blend ${this.model?.blend?.toFixed?.(3)} ` +
        `— clamped at the publish point. A NaN on a directional light blacks out ` +
        `the whole frame, so this must be fixed at its source, not here.`
    );
  }

  _placeLight(light, dir, minY) {
    this._tmp.copy(dir);
    if (this._tmp.y < minY) {
      this._tmp.y = minY;
      this._tmp.normalize();
    }
    light.position.copy(this._tmp).multiplyScalar(600);
    // Firewall. `dir` comes out of spherical astronomy and a normalise; a
    // zero-length vector or a NaN anywhere upstream lands here, and here is the
    // last place this subsystem owns before `render` reads it.
    const p = light.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      this._reportNonFinite(`${light.name}.position`, `${p.x},${p.y},${p.z}`);
      p.set(0, 600, 0);
    }
    light.target.position.set(0, 0, 0);
    light.updateMatrixWorld(true);
    light.target.updateMatrixWorld(true);
  }

  _applyLightIntensities() {
    /**
     * How far the key is allowed to fall when cloud crosses the sun.
     *
     * Under a BROKEN deck this light is global while the cloud is not, so a hard
     * 4x drop reads as somebody pulling the exposure rather than as weather —
     * real broken cover swings maybe a stop on the ground, which is 0.58..1.0.
     * The per-pixel patches that make it read as cloud come from the shadow map
     * instead (see the composite in volumetrics.js).
     *
     * Under a SOLID deck none of that applies: there is no direct beam at all,
     * and clamping it at 58% is what makes every overcast in every hobby
     * renderer look like a slightly dim sunny day. So the clamp is released in
     * proportion to how continuous the sheet is.
     */
    // `_cloudOcclusion` is an exponentially smoothed accumulator, and NaN is
    // sticky: once one enters it, it never washes out and every subsequent frame
    // publishes a dead sun. Catch it on the way in rather than on the way out.
    if (!Number.isFinite(this._cloudOcclusion)) {
      this._reportNonFinite('cloudOcclusion', this._cloudOcclusion);
      this._cloudOcclusion = 1;
    }
    const occ = THREE.MathUtils.lerp(
      this._cloudOcclusion,
      0.58 + 0.42 * this._cloudOcclusion,
      1 - (this._overcast ?? 0)
    );
    let intensity = this._baseSunIntensity * occ * SUN_KEY_GAIN;
    // NOT zero: `render._syncSun` switches its OWN 4.3-intensity fallback sun
    // back on the moment no foreign directional light clears 0.01, so a control
    // that published a true zero would photograph a different sun rather than
    // no sun. 0.02 is 8.4 stops under the real key and still holds the takeover.
    if (this.debugNoSunKey) intensity = 0.02;
    if (!Number.isFinite(intensity)) {
      this._reportNonFinite('sunLight.intensity', intensity);
      intensity = 0;
      this._baseSunIntensity = 0;
    }
    this.sunLight.intensity = intensity;
    if (!Number.isFinite(this.moonLight.intensity)) {
      this._reportNonFinite('moonLight.intensity', this.moonLight.intensity);
      this.moonLight.intensity = 0.03;
    }
    // The colours are published to `render` too, and a NaN channel propagates
    // through the same multiply as the intensity does.
    for (const l of [this.sunLight, this.moonLight]) {
      const cc = l.color;
      if (!Number.isFinite(cc.r) || !Number.isFinite(cc.g) || !Number.isFinite(cc.b)) {
        this._reportNonFinite(`${l.name}.color`, `${cc.r},${cc.g},${cc.b}`);
        cc.setRGB(1, 1, 1);
      }
    }

    const sunI = this.sunLight.intensity;
    const moonI = this.moonLight.intensity;
    const moonKey = moonI > sunI;
    this.keyLight = moonKey ? this.moonLight : this.sunLight;

    // The fog's key must be the light the renderer fitted its cascades to, or
    // the shafts would be masked by shadows cast from another direction.
    const key = this.keyLight;
    const dir = moonKey ? this.celestial.moon : this.celestial.sun;
    this.shared.uKeyDir.value.copy(dir);
    const i = key.intensity;
    this.shared.uKeyIrr.value.set(key.color.r * i, key.color.g * i, key.color.b * i);
    this._keyColor.setRGB(key.color.r * i, key.color.g * i, key.color.b * i);

    // Fraction of the frame's light that is the direct beam. The screen-space
    // cloud-shadow patch is scaled by this, so it fades out honestly at dusk and
    // under an overcast instead of painting grey blobs on a scene with no sun.
    const ambLevel = Math.max(1e-5, (this.ambientColor.r + this.ambientColor.g + this.ambientColor.b) / 3);
    const beam = Math.max(0, sunI - moonI);
    this.shared.uCloudShadowStrength.value =
      THREE.MathUtils.clamp((beam / (beam + ambLevel * 6.0)) * (1 - (this._overcast ?? 0)), 0, 1);
  }

  _bakeSky() {
    this.luts.bakeSkyView();
    this._skyDirty = false;
    this._lutSunDir.copy(this.celestial.sun);
    this.renderer.setRenderTarget(null);
  }

  // ---- IBL ----------------------------------------------------------------

  /**
   * Amortised PMREM regeneration.
   *
   * The two halves cost very different amounts — the equirect draw is one
   * full-screen evaluation of the sky shader at 512x256 (~0.3 ms), the PMREM is
   * a cube render plus a six-level roughness convolution (~1.4 ms) — and paying
   * both on one frame is a visible hitch when the clock is running. Splitting
   * them across consecutive frames halves the worst case and costs nothing,
   * because the equirect target is not read until the PMREM step runs.
   *
   * There is no cross-fade and none is needed: at the default clock rate the sun
   * moves 0.35 degrees in 0.7 s and the weather blends over two minutes, so
   * consecutive environments differ by far less than the dither floor. A pop
   * would only be possible on a hard `setTimeOfDay`, which takes the immediate
   * path below on purpose.
   *
   * There are now THREE phases, not two. The diffuse irradiance probe is a
   * readback, and a readback is a pipeline stall — so it gets its own frame
   * rather than being bolted onto the PMREM's, which is the frame that already
   * costs the most. It reads the equirect the phase-0 blit produced, and the
   * equirect is not overwritten until the next phase 0, so the three steps
   * never contend for it.
   */
  _stepEnv() {
    if (this._envPhase === 1) {
      this._pmremStep();
      return;
    }
    if (this._envPhase === 2) {
      this._irradianceStep();
      return;
    }
    if (this._envDirty && this._envAge > 0.2) {
      blit(this.renderer, this.dome.envMaterial, this.envEquirect);
      this.renderer.setRenderTarget(null);
      this._envPhase = 1;
      this._envDirty = false;
      this._envAge = 0;
    }
  }

  _irradianceStep() {
    this.irradiance.update(this.renderer, this.envEquirect.texture);
    this.renderer.setRenderTarget(null);
    this._envPhase = 0;
  }

  _pmremStep() {
    this._pmremTarget = this.pmrem.fromEquirectangular(
      this.envEquirect.texture,
      this._pmremTarget
    );
    this._pmremTarget.texture.name = 'sky-env';
    this.envMap = this._pmremTarget.texture;
    this.render.setEnvMap(this.envMap);
    this.renderer.setRenderTarget(null);
    this._envSunDir.copy(this.celestial.sun);
    this._envPhase = 2;
    this.ctx.events.emit('sky:env', { envMap: this.envMap, sunDir: this.celestial.sun });
  }

  /**
   * All three at once — only for a hard time/weather snap.
   *
   * The probe MUST be included here. `__APPLY_SHOT__` snaps the clock, and a
   * capture that photographed the new sky lit by the old sky's irradiance is
   * exactly the sort of frame a reviewer would report as a lighting bug.
   */
  _bakeEnvNow() {
    blit(this.renderer, this.dome.envMaterial, this.envEquirect);
    this._pmremStep();
    this._irradianceStep();
    this._envDirty = false;
    this._envAge = 0;
  }

  dispose() {
    this._unregisterPass?.();
    this.volumetrics.dispose();
    this.clouds.dispose();
    this.valley.dispose();
    this.ctx.scene.remove(this.rainFx.group);
    this.rainFx.dispose();
    this.ctx.scene.remove(this.dome.mesh);
    this.dome.dispose();
    this.luts.dispose();
    this.envEquirect.dispose();
    this._pmremTarget?.dispose();
    this.pmrem.dispose();
    this.irradiance.dispose();
    this.ctx.scene.remove(this.sunLight, this.sunLight.target);
    this.ctx.scene.remove(this.moonLight, this.moonLight.target);
    this.ctx.scene.remove(this.flashLight);
    this.render.removeLight?.(this.sunLight);
    this.render.removeLight?.(this.moonLight);
    this.sunLight.dispose();
    this.moonLight.dispose();
    if (typeof window !== 'undefined' && window.__SKY__ === this) delete window.__SKY__;
  }
}

export { WEATHER_STATES, WEATHER_NAMES };
