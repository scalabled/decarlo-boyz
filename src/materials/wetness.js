import * as THREE from 'three';

/**
 * THE SHARED WETNESS STATE.
 *
 * Rain is core to Steel City, so "wet" is not a material variant — it is one
 * number that every outdoor surface in the world reads every frame. This module
 * owns that number.
 *
 * HOW IT WORKS. `extendMaterial()` puts the *same uniform objects* declared here
 * into every material's uniform set. three stores the object the
 * `onBeforeCompile` hook hands it (`materialProperties.uniforms`) and uploads
 * `uniform.value` on each draw, so mutating `.value` in place here updates every
 * material in the scene with one write and zero per-material bookkeeping. This
 * is the same trick `src/render/materialpatch.js` uses for the CSM/AO uniforms.
 *
 * HOW `sky` DRIVES IT (this is the published contract):
 *
 *   const mats = ctx.get('materials');
 *   mats.setWeather({ wetness: 0.85, rain: 0.6 });      // per weather tick
 *
 * or, if `sky` would rather own the ramp itself and write every frame:
 *
 *   mats.wetnessUniforms.owWetP.value.x = w;            // 0..1 surface wetness
 *   mats.wetnessUniforms.owWetP.value.z = rain;         // 0..1 falling rain
 *
 * `materials` advances `owWetP.w` (the ripple clock) from `ctx.time.elapsed` in
 * its own `update()`, so nobody else has to. `wetness` and `rain` are separate
 * on purpose: the street stays wet — and mirrors the sodium lamps — for minutes
 * after the rain stops, and the ripple rings must die immediately when it does.
 *
 * The `weather:change` event from ARCHITECTURE.md carries `{ wetness, rain }`,
 * and `materials` subscribes to it in `init()`, so a `sky` that simply emits the
 * canonical event needs no extra call at all.
 */

/** Uniform objects shared by reference with every extended material. */
export const WET_UNIFORMS = {
  /**
   * x — wetness 0..1. How saturated the world is. Darkens albedo, drops
   *     roughness, and raises the water line in the height field.
   * y — puddle world scale (1/metres). 0.18 puts ponds on a ~5 m period.
   * z — rain 0..1. Ripple rings on standing water + streaming on verticals.
   * w — clock, seconds. Driven by MaterialSystem.update().
   */
  owWetP: { value: new THREE.Vector4(0, 0.18, 0, 0) },
  /**
   * x — reserved (snow/ice coverage)
   * y — wind 0..1, tilts rain streaks on vertical faces
   * z — drying 0..1, how far the surface has evaporated back (unused by the
   *     shader today; kept so `sky` can ramp it without a uniform churn later)
   * w — reserved
   */
  owWetQ: { value: new THREE.Vector4(0, 0, 0, 0) },
};

/** Mirror of the uniform values, so callers can read the state back cheaply. */
const state = {
  wetness: 0,
  rain: 0,
  wind: 0,
  puddleScale: 0.18,
  time: 0,
};

/**
 * Set any subset of the weather state. Everything is clamped, so a subsystem
 * cannot push the world into a physically silly place by accident.
 * @param {{wetness?:number, rain?:number, wind?:number, puddleScale?:number}} w
 */
export function setWeather(w = {}) {
  if (w.wetness !== undefined) state.wetness = clamp01(w.wetness);
  if (w.rain !== undefined) state.rain = clamp01(w.rain);
  if (w.wind !== undefined) state.wind = clamp01(w.wind);
  if (w.puddleScale !== undefined) state.puddleScale = Math.max(0.01, w.puddleScale);
  const p = WET_UNIFORMS.owWetP.value;
  p.x = state.wetness;
  p.y = state.puddleScale;
  p.z = state.rain;
  WET_UNIFORMS.owWetQ.value.y = state.wind;
  return state;
}

/**
 * Allocation-free wetness write, for the hot path.
 *
 * `sky` drives wetness as a continuously integrating value and may call at
 * frame rate, so the primary setter must not build an options object per call.
 * The uniform itself is written by the caller; this keeps the readable mirror
 * in step.
 */
export function setWetnessValue(v) {
  state.wetness = v;
}

/** Advance the ripple clock. Call once a frame with the engine's elapsed time. */
export function setWetTime(t) {
  state.time = t;
  WET_UNIFORMS.owWetP.value.w = t;
}

/** Read-only snapshot of the current weather state. */
export function getWeather() {
  return { ...state };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Per-surface wetting response, packed into `owWetSurf`.
 *
 *   x  susceptibility 0..1 — 0 means the surface never wets (interiors, the
 *      underside of a bridge deck, a viewmodel). Scales the global wetness.
 *   y  porosity 0..1 — how much water in the pores darkens the albedo. Concrete
 *      and unsealed timber are ~1; automotive clearcoat and glass are ~0.1.
 *   z  pooling 0..1 — how readily standing water forms. A rutted road is 1, a
 *      cambered kerb stone or a car roof is ~0.15.
 *   w  sheen 0..1 — extra grazing-angle specular from the water film.
 *
 * These are the *defaults* per surface family; a library entry overrides them
 * with a `wet: [...]` parameter.
 */
export const WET_PRESETS = {
  /** Porous mineral: soaks, darkens hard, pools in every low spot. */
  mineral: [1, 1.0, 1.0, 1],
  /** Road: the reference case — the whole reason this system exists. */
  road: [1, 1.0, 1.15, 1],
  /** Vertical masonry: wets, darkens, sheds instead of pooling. */
  wall: [1, 0.9, 0.25, 1],
  /**
   * KERB. A kerb nose is the highest thing in the gutter and it is where the
   * water is being drained TO, not where it stands — so it wets and goes glossy
   * like everything else, and pools essentially not at all. Puddles sitting on
   * top of raised kerbs was one of the specific defects reported against the
   * wet pass, and no amount of shader work fixes it if the surface still says
   * it pools like a road.
   */
  kerb: [1, 1.0, 0.05, 1],
  /**
   * Pavement. Cambered to the gutter and laid in slabs, so it holds water in
   * the joints and in a settled slab, nothing like a rutted carriageway.
   */
  walk: [1, 1.0, 0.45, 1],
  /** Sealed / painted: a film on top, almost no darkening. */
  sealed: [1, 0.25, 0.5, 1],
  /** Automotive clearcoat: beads, gets glossier, barely darkens. */
  clearcoat: [1, 0.12, 0.12, 1.25],
  /** Bare metal: no porosity at all, just a film. */
  metal: [1, 0.1, 0.35, 1],
  /** Glass: already smooth; a film only adds streaks. */
  glass: [1, 0.05, 0.1, 0.6],
  /** Vegetation: darkens a little, never pools. */
  organic: [1, 0.55, 0.1, 0.8],
  /** Rubber: hydrophobic, darkens slightly, must NOT turn into a mirror. */
  rubber: [1, 0.3, 0.1, 0.35],
  /** Never wets. */
  dry: [0, 0, 0, 0],
};
