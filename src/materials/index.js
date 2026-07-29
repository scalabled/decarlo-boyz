import * as THREE from 'three';
import { TextureForge } from './generator.js';
import { LIBRARY, resolveName } from './library.js';
import { extendMaterial, DEFAULT_PARAMS } from './shader.js';
import { bakeMasks, setMask } from './masks.js';
import {
  WET_UNIFORMS,
  WET_PRESETS,
  setWeather as setWeatherState,
  setWetTime,
  setWetnessValue,
  getWeather,
} from './wetness.js';
import { WaterSurface } from './water.js';

/**
 * Procedural PBR texture generation and the shared material library.
 *
 * There are no art assets in this project: every texel is rendered on the GPU
 * at boot from the noise stack in glsl/, packed into three 8-bit textures per
 * surface (albedo+height / ORM / tangent normal) and handed to a
 * MeshStandardMaterial extended with projection, parallax, detail, macro
 * variation and weathering (see shader.js).
 *
 * Public API — reach it with `ctx.get('materials')`:
 *
 *   get(name, opts?)          -> THREE.Material (cached; same opts, same instance)
 *   getTextureSet(name, opts?)-> { albedo, normal, orm, size, worldSize }
 *   variant(name, opts)       -> alias for get() with a fresh cache entry
 *   names()                   -> string[]
 *   surfaceOf(name)           -> one of the ARCHITECTURE.md surface tags
 *   bakeMasks(geometry, opts) -> geometry with wear/grime/AO vertex masks
 *   setGroundLevel(y)         -> where the ground-splash weathering starts
 *   detailNormal / macroTexture -> the shared micro/macro maps
 *
 * `opts` accepts anything in DEFAULT_PARAMS (scale, tint, uvMode, parallax,
 * weather, …) plus `three` for raw THREE material properties and `bake` to
 * force a distinct texture bake (a different paint colour, for example).
 *
 * THE WETNESS SYSTEM (read this if you own `sky`):
 *
 *   materials.setWeather({ wetness, rain, wind })   // 0..1 each
 *   materials.weather                               // read it back
 *   materials.wetnessUniforms                       // the raw shared uniforms
 *
 * One call updates every outdoor material in the world, because all of them
 * share the same uniform objects by reference. `materials` also listens for the
 * canonical `weather:change` event, so a `sky` that emits
 * `{ state, wetness, rain, wind }` needs no direct call at all. Wetness and
 * rain are deliberately separate: a street stays wet — and keeps mirroring the
 * sodium lamps — for minutes after the last drop, but the ripple rings must
 * stop the instant the rain does.
 *
 * VEHICLES: `materials.carPaint(0xb2231a, { finish: 'metallic' })` returns a
 * fully layered paint material (metallic flake, view-dependent flop, clearcoat
 * with its own orange peel). `finish` is one of gloss | metallic | matte |
 * primer | faded | rusted | dirty.
 *
 * WATER: `materials.water(opts)` returns the river surface material; its
 * `userData.owWater` carries `{ addWake(x, z, strength, radius), setFlow(...) }`
 * for `vehicles` to drive.
 */
export class MaterialSystem {
  static id = 'materials';
  static deps = ['render'];

  constructor(opts = {}) {
    /** Allows a standalone harness to drive the system without the engine. */
    this._injectedRenderer = opts.renderer ?? null;
    this._sets = new Map(); // bakeKey -> texture set
    this._materials = new Map(); // matKey  -> THREE.Material
    this._forge = null;
    this._shared = null;
    this._groundY = 0;
    this._built = false;
    this._warned = false;
    this._quality = 1;
    /** seconds since the last bake, for the scratch-target release below */
    this._idle = 0;
    this._scratchFreed = false;
    this._clock = 0;
    this._water = null;
    this._onWeather = null;
    /** Baked texture bytes, and a soft cap that warns rather than fails. */
    this._bytes = 0;
    this._budget = (opts.textureBudgetMB ?? 640) * 1048576;
    this._overBudget = false;
    /**
     * A/B switch for the cutout alpha dilation (see generator.js). Off means
     * "bake the way the build did before dilation existed", which is the only
     * way to measure what it is worth — `props` has to retune its foliage tint
     * against a real number, not against a description.
     * `?nodilate=1` on the game URL, or `{ noDilate: true }` in a harness.
     */
    this._noDilate =
      opts.noDilate === true ||
      (typeof location !== 'undefined' &&
        new URLSearchParams(location.search).has('nodilate'));
    /**
     * A/B switch for the building-zone layer, for the same reason: three other
     * subsystems change the lighting under this one from hour to hour, so a
     * before/after taken from two game frames an hour apart cannot attribute a
     * value change to a material. Toggling the layer inside the materials-only
     * preview, where the light is fixed, can. `?nozone=1`.
     */
    this._noZone =
      opts.noZone === true ||
      (typeof location !== 'undefined' &&
        new URLSearchParams(location.search).has('nozone'));
  }

  async init(ctx) {
    this.ctx = ctx;
    const q = ctx?.config?.q;
    this._anisotropy = q?.anisotropy ?? 8;
    // Texture budget scales with the quality preset; 1K is the reference.
    this._quality =
      ctx?.config?.quality === 'low' ? 0.5 : ctx?.config?.quality === 'medium' ? 0.75 : 1;
    this._tryBuild();

    // `sky` owns the weather; ARCHITECTURE.md already defines the event, so
    // listening for it means a correct `sky` needs no materials-specific call.
    if (ctx?.events?.on) {
      this._onWeather = (e) => {
        if (!e) return;
        setWeatherState({ wetness: e.wetness, rain: e.rain, wind: e.wind });
      };
      ctx.events.on('weather:change', this._onWeather);
    }
  }

  // ------------------------------------------------------------- internals --
  _renderer() {
    if (this._injectedRenderer) return this._injectedRenderer;
    const r = this.ctx?.peek?.('render');
    return r?.renderer ?? r?.getRenderer?.() ?? null;
  }

  _tryBuild() {
    if (this._built) return true;
    const renderer = this._renderer();
    if (!renderer) {
      if (!this._warned) {
        console.warn('[materials] no WebGLRenderer available yet — deferring texture bake');
        this._warned = true;
      }
      return false;
    }
    const t0 = performance.now();
    this._forge = new TextureForge(renderer, { anisotropy: this._anisotropy });
    // 1K, not 512: the micro tooth is 1.6-4 mm over a 0.25 m tile, which needs
    // ~6 texels per grain to survive mip 1 instead of averaging to flat grey.
    /**
     * THREE micro sets, not one.
     *
     * The single most damaging thing a critic said about this build was that
     * one grey speckle was serving as ground aggregate, a shirt weave, weapon
     * rust and asphalt binder at once, "matchable blob for blob at 5x". It was
     * true: every material multiplied the same 1K field over itself. Mineral,
     * woven and machined-metal families are now baked separately and a surface
     * picks one with `detailSet`; `detailRot` then rotates the lookup per
     * surface so two members of the SAME family still cannot be matched.
     *
     * Cost is two extra sets: 11.2 MiB each at 1K, 2.8 MiB each at the 512 the
     * low preset bakes at.
     */
    const dSize = this._size(1024);
    const detail = [
      this._forge.buildDetail(dSize, 1, 0),
      this._forge.buildDetail(dSize, 37, 1),
      this._forge.buildDetail(dSize, 71, 2),
    ];
    const macro = this._forge.buildMacro(256);
    this._shared = {
      detailNormal: detail.map((d) => d.normal),
      detailAlbedo: detail.map((d) => d.albedo),
      macro: macro.albedo,
    };
    this._bytes += dSize * dSize * 4 * (4 / 3) * 2 * detail.length;
    this._built = true;
    const ms = performance.now() - t0;
    if (ms > 30) console.info(`[materials] shared maps ${ms.toFixed(0)}ms`);
    return true;
  }

  _size(base) {
    const s = Math.max(128, Math.round((base * this._quality) / 128) * 128);
    // keep it a power of two so mip chains stay clean
    return 1 << Math.round(Math.log2(s));
  }

  /**
   * Names resolve through the alias table. An unknown name warns and falls back
   * to concrete rather than throwing — a typo in one subsystem must not take
   * the whole boot down.
   */
  _resolve(name) {
    const key = resolveName(name);
    if (LIBRARY[key]) return key;
    if (!this._missing) this._missing = new Set();
    if (!this._missing.has(name)) {
      this._missing.add(name);
      console.warn(`[materials] unknown surface "${name}" — falling back to concrete`);
    }
    return 'concrete';
  }

  _bakeKey(name, bake) {
    return `${name}|${bake.size}|${bake.seed}|${bake.tintA ?? ''}|${bake.tintB ?? ''}|${(
      bake.param ?? []
    ).join('_')}`;
  }

  /** Build (or fetch) the three packed textures for a surface. */
  getTextureSet(name, opts = {}) {
    const key = this._resolve(name);
    const def = LIBRARY[key];
    if (!this._tryBuild()) return null;

    const bake = { ...def.bake, ...(opts.bake ?? {}) };
    bake.size = this._size(bake.size);
    const cacheKey = this._bakeKey(key, bake);
    let set = this._sets.get(cacheKey);
    if (set) return set;

    const t0 = performance.now();
    this._idle = 0;
    this._scratchFreed = false;
    set = this._forge.build({
      key,
      glsl: def.glsl,
      size: bake.size,
      seed: bake.seed ?? 1,
      worldSize: bake.worldSize,
      relief: bake.relief,
      // Alpha-cutout surfaces get their dead margin flooded before mipping —
      // see the ALPHA DILATION note in generator.js. Derived from the material
      // rather than restated per bake so a new cutout surface cannot forget it.
      dilate: !this._noDilate && (bake.dilate ?? def.mat?.alphaMask === true),
      /**
       * Deliberately far BELOW the material's alphaTest. The cut here decides
       * what counts as "dead margin whose colour is a lie"; anything the
       * runtime might still draw must keep the colour the generator gave it.
       * `props` currently runs foliage at alphaTest 0.21 and could go lower, so
       * flooding at 0.42 would overwrite real leaf-edge texels.
       */
      alphaCut: bake.alphaCut ?? 0.05,
      tintA: bake.tintA !== undefined ? new THREE.Color(bake.tintA) : undefined,
      tintB: bake.tintB !== undefined ? new THREE.Color(bake.tintB) : undefined,
      param: bake.param ? new THREE.Vector4().fromArray(bake.param) : undefined,
    });
    set.name = key;
    this._sets.set(cacheKey, set);

    /**
     * TEXTURE BUDGET.
     *
     * A surface set is three RGBA8 textures with mip chains: 16 MiB at 1024,
     * 4 MiB at 512. The library now holds 117 surfaces, so baking all of them
     * would cost 1.4 GiB — which is exactly why bakes are lazy and why every
     * variant a level does not use is free. This counter exists so the number
     * is visible rather than discovered on a low-end GPU: a level should sit
     * around 30-40 distinct sets.
     */
    this._bytes +=
      bake.size * bake.size * 4 * (4 / 3) * (1 + (set.orm ? 1 : 0) + (set.normal ? 1 : 0));
    if (this._bytes > this._budget && !this._overBudget) {
      this._overBudget = true;
      console.warn(
        `[materials] texture set over budget: ${(this._bytes / 1048576) | 0} MiB in ` +
          `${this._sets.size} surfaces (soft cap ${(this._budget / 1048576) | 0} MiB). ` +
          `Reuse variants or drop bake sizes.`
      );
    }

    const ms = performance.now() - t0;
    if (ms > 40) console.info(`[materials] bake ${key} ${bake.size}px ${ms.toFixed(0)}ms`);
    return set;
  }

  /** Baked texture memory in MiB, and how many distinct sets are resident. */
  get textureMemory() {
    return { mib: +(this._bytes / 1048576).toFixed(1), sets: this._sets.size };
  }

  /**
   * Every bake happens while the level is loading, but the half-float scratch
   * height targets the Sobel pass reads were being held for the whole session
   * (~10.5 MB of VRAM for 1K/512/256). Release them once the bake burst has
   * clearly finished; `TextureForge._heightRT()` recreates on demand, so a late
   * bake still produces exactly the same texture, it just re-allocates first.
   *
   * Nothing here touches a material, a uniform or a texture that is sampled, so
   * it cannot move a pixel — it only changes when a scratch buffer is freed.
   */
  update(dt) {
    // The ripple clock. Taken off the engine clock rather than accumulated
    // locally so captures stay reproducible; falls back to the local sum when
    // the system is driven by a standalone harness with no engine.
    this._clock = this.ctx?.time?.elapsed ?? this._clock + (dt > 0.25 ? 0.25 : dt);
    setWetTime(this._clock);
    if (this._water) this._water.update(this._clock, dt, this.ctx);

    if (this._scratchFreed || !this._forge) return;
    this._idle += dt > 0.25 ? 0.25 : dt; // ignore load-hitch dt spikes
    if (this._idle < 5) return;
    this._scratchFreed = true;
    this._forge.releaseScratch();
  }

  // ------------------------------------------------------------- weather --
  /**
   * Drive the global wetness. THIS IS THE `sky` ENTRY POINT.
   * @param {{wetness?:number, rain?:number, wind?:number, puddleScale?:number}} w
   */
  setWeather(w) {
    return setWeatherState(w);
  }

  /**
   * THE PRIMARY `sky` ENTRY POINT. Set the global surface wetness, 0..1.
   *
   * `sky` models wetness as an INTEGRAL with asymmetric attack and decay
   * (~2.5 min to saturate, 4-8 min to dry), so this arrives as a smoothly
   * varying value at up to frame rate, not as discrete weather steps. It is
   * therefore allocation-free: it writes the shared uniform in place and does
   * not build an options object, and every intermediate value is meaningful —
   * 0.3 is a damp street that has darkened and gained a sheen but has not
   * pooled anywhere, and standing water only starts to gather past about 0.45
   * because the water line rises with the SQUARE of this number.
   *
   * @param {number} w 0..1
   */
  setWetness(w) {
    const v = w > 1 ? 1 : w < 0 ? 0 : w || 0;
    WET_UNIFORMS.owWetP.value.x = v;
    setWetnessValue(v);
    return v;
  }

  /** Current weather state — `{ wetness, rain, wind, puddleScale, time }`. */
  get weather() {
    return getWeather();
  }

  get wetness() {
    return getWeather().wetness;
  }

  /**
   * The raw shared uniform objects, for a `sky` that would rather write them
   * every frame than call through. Mutate `.value` in place — never replace it.
   */
  get wetnessUniforms() {
    return WET_UNIFORMS;
  }

  /** The per-surface-family wetting response presets (see wetness.js). */
  get wetPresets() {
    return WET_PRESETS;
  }

  // ------------------------------------------------------------------ API --
  /**
   * Fetch a material. Identical (name, opts) return the identical instance so
   * meshes batch; pass any override to get a distinct variant.
   */
  get(name, opts = {}) {
    const key = this._resolve(name);
    const def = LIBRARY[key];

    const matKey = key + '|' + stableKey(opts);
    const cached = this._materials.get(matKey);
    if (cached) return cached;

    const set = this.getTextureSet(key, opts);
    const p = { ...DEFAULT_PARAMS, ...def.mat, ...opts };
    if (this._noZone) p.zone = [0, 9, 0, 0];
    delete p.three;
    delete p.bake;
    p.groundY = opts.groundY ?? this._groundY;

    const threeProps = { ...(def.three ?? {}), ...(opts.three ?? {}) };
    const usePhysical = threeProps.physical === true;
    delete threeProps.physical;

    const Ctor = usePhysical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    const mat = new Ctor({
      color: 0xffffff,
      roughness: 1,
      metalness: 1,
      dithering: true,
    });
    mat.name = matKey;

    if (set) {
      mat.map = set.albedo;
      mat.normalMap = set.normal;
      mat.normalScale.set(1, 1);
      mat.roughnessMap = set.orm;
      // The height in albedo.a is only meaningful with the extension; keep the
      // stock alpha path off unless the surface is actually alpha-masked.
      if (!(p.alphaMask || threeProps.transparent)) mat.transparent = false;
    } else if (!this._warned) {
      console.warn(`[materials] "${key}" built without textures (no renderer)`);
    }

    if (p.vertexMasks) mat.vertexColors = true;
    applyProps(mat, threeProps);

    if (set) extendMaterial(mat, p, this._shared);

    this._materials.set(matKey, mat);
    return mat;
  }

  /** Explicit variant request — same as get(), reads better at the call site. */
  variant(name, opts = {}) {
    return this.get(name, opts);
  }

  /** All library names (aliases and internal bakes excluded). */
  names() {
    return Object.keys(LIBRARY).filter((k) => !LIBRARY[k].internal);
  }

  // ------------------------------------------------------------ vehicles --
  /**
   * A fully layered automotive paint material.
   *
   * @param {number|string} color  the base coat, sRGB
   * @param {object} [opts]
   * @param {'gloss'|'metallic'|'matte'|'primer'|'faded'|'rusted'|'dirty'} [opts.finish]
   * @param {number} [opts.dirt]   0..1 road film, overrides the finish default
   * @param {number} [opts.wear]   0..1 swirls, chips and scratches
   * @param {number} [opts.flake]  0..1 metallic flake amount
   *
   * Identical arguments return the identical material, so a whole traffic
   * stream of one colour batches into one draw call. A distinct colour costs
   * one 512 bake (~4.2 MB) — cache colours, do not generate one per car.
   */
  carPaint(color = 0xb2231a, opts = {}) {
    const FINISH = {
      gloss: { key: 'carpaint', finish: 0, flake: 0.0, dirt: 0.25, wear: 0.25 },
      metallic: { key: 'carpaint', finish: 1, flake: 0.85, dirt: 0.25, wear: 0.3 },
      matte: { key: 'carpaint_matte', finish: 2, flake: 0, dirt: 0.3, wear: 0.3 },
      primer: { key: 'carpaint_primer', finish: 3, flake: 0, dirt: 0.5, wear: 0.55 },
      faded: { key: 'carpaint_faded', finish: 4, flake: 0.3, dirt: 0.5, wear: 0.8 },
      rusted: { key: 'carpaint_rusted', finish: 5, flake: 0.15, dirt: 0.6, wear: 0.9 },
      dirty: { key: 'carpaint_dirty', finish: 6, flake: 0.55, dirt: 0.95, wear: 0.55 },
    };
    const f = FINISH[opts.finish ?? 'metallic'] ?? FINISH.metallic;
    const base = LIBRARY[f.key];
    const wear = opts.wear ?? f.wear;
    const dirt = opts.dirt ?? f.dirt;
    const flake = opts.flake ?? f.flake;

    const o = {
      bake: { ...base.bake, tintA: color, param: [f.finish, wear, dirt, 0] },
    };
    if (flake !== base.mat.carPaint?.[0]) {
      o.carPaint = [flake, ...base.mat.carPaint.slice(1)];
    }
    if (opts.opts) Object.assign(o, opts.opts);
    return this.get(f.key, o);
  }

  // --------------------------------------------------------------- water --
  /**
   * The river surface. One instance is shared by every water mesh in the world;
   * pass `fresh: true` for a second one (a fountain, a flooded basement) with
   * its own flow and turbidity.
   *
   * `vehicles` drives it through `material.userData.owWater`:
   *   const w = ctx.get('materials').water().userData.owWater;
   *   w.addWake(hull.x, hull.z, speed / planingSpeed, 2.4);
   */
  water(opts = {}) {
    if (!opts.fresh && this._water) return this._water.material;
    if (!this._tryBuild()) return null;
    const nrm = this.getTextureSet('water_normal');
    const foam = this.getTextureSet('water_foam');
    if (!nrm || !foam) return null;
    const w = new WaterSurface({ flowNormal: nrm.normal, foam: foam.albedo }, opts);
    if (!opts.fresh) this._water = w;
    return w.material;
  }

  /** The WaterSurface controller, if one has been created. */
  get waterSurface() {
    return this._water;
  }

  /**
   * Pre-warm hook (see ARCHITECTURE.md). Bakes and compiles every surface the
   * subsystem can produce WITHOUT spawning gameplay objects, so no program
   * lands during play. Bakes are the expensive half and they are unconditional;
   * the compile half needs a bound render target to get the right cache key,
   * which `core/prewarm.js` has already arranged before it calls this.
   */
  async prewarmMaterials(ctx) {
    if (!this._tryBuild()) return { ok: false, reason: 'no renderer' };
    const t0 = performance.now();
    let baked = 0;
    for (const name of this.names()) {
      // Only the surfaces something has already asked for: baking all ~70 up
      // front would cost several hundred megabytes for a level that uses a
      // third of them. This warms what the level actually built.
      if (!this._materials.has(name + '|')) continue;
      this.get(name);
      baked++;
    }
    return { ok: true, baked, ms: Math.round(performance.now() - t0) };
  }

  /** The ARCHITECTURE.md surface tag for impact FX / audio / footsteps. */
  surfaceOf(name) {
    return LIBRARY[resolveName(name)]?.surface ?? 'concrete';
  }

  /** Live-update a material's uniforms after creation. */
  tune(material, changes = {}) {
    const u = material.userData?.owUniforms;
    if (!u) return material;
    if (changes.scale !== undefined) {
      const s = material.userData.owParams.uvMode === 'mesh' ? changes.scale : 1 / changes.scale;
      u.owTile.value.x = s;
      u.owTile.value.y = s;
    }
    if (changes.tint !== undefined) u.owTintCol.value.set(changes.tint);
    if (changes.parallax !== undefined) u.owParallaxP.value.x = changes.parallax;
    if (changes.groundY !== undefined) u.owGroundY.value = changes.groundY;
    if (changes.normalStrength !== undefined) u.owNormalAmp.value = changes.normalStrength;
    if (changes.weather !== undefined) u.owWeatherP.value.fromArray(changes.weather);
    if (changes.wet !== undefined && u.owWetSurf) u.owWetSurf.value.fromArray(changes.wet);
    if (changes.grime !== undefined && u.owGrimeP) u.owGrimeP.value.fromArray(changes.grime);
    if (changes.carPaint !== undefined && u.owCarP) u.owCarP.value.fromArray(changes.carPaint);
    if (changes.carFlop !== undefined && u.owCarFlop) u.owCarFlop.value.fromArray(changes.carFlop);
    return material;
  }

  /** Where the ground-splash weathering band sits, in world Y. */
  setGroundLevel(y) {
    this._groundY = y;
    for (const m of this._materials.values()) {
      const u = m.userData?.owUniforms;
      if (u) u.owGroundY.value = y;
    }
  }

  /** The mineral micro-detail normal (set 0). `detailNormals` gives all three. */
  get detailNormal() {
    const d = this._shared?.detailNormal;
    return (Array.isArray(d) ? d[0] : d) ?? null;
  }

  /** All shared micro-detail normals: [ mineral, woven, machined metal ]. */
  get detailNormals() {
    return this._shared?.detailNormal ?? null;
  }

  /** All shared micro-detail albedo/height maps, same order. */
  get detailAlbedos() {
    return this._shared?.detailAlbedo ?? null;
  }

  get macroTexture() {
    return this._shared?.macro ?? null;
  }

  bakeMasks(geometry, opts) {
    return bakeMasks(geometry, opts);
  }

  setMask(geometry, opts) {
    return setMask(geometry, opts);
  }

  /** Debug: a grid of spheres/panels showing every surface in the library. */
  debugBoard(opts = {}) {
    return buildDebugBoard(this, opts);
  }

  dispose() {
    if (this._onWeather) this.ctx?.events?.off?.('weather:change', this._onWeather);
    this._onWeather = null;
    this._water?.dispose();
    this._water = null;
    for (const m of this._materials.values()) m.dispose();
    this._materials.clear();
    this._sets.clear();
    this._bytes = 0;
    this._overBudget = false;
    this._forge?.dispose();
    this._forge = null;
    this._shared = null;
    this._built = false;
  }
}

/**
 * Assigning a hex number over a THREE.Color property silently replaces the
 * Color object and produces NaN uniforms (a black material), so colour-valued
 * properties have to go through .set().
 */
function applyProps(mat, props) {
  for (const k in props) {
    const cur = mat[k];
    const v = props[k];
    if (cur && cur.isColor && !(v && v.isColor)) cur.set(v);
    else if (cur && cur.isVector2 && Array.isArray(v)) cur.fromArray(v);
    else mat[k] = v;
  }
  return mat;
}

function stableKey(opts) {
  const keys = Object.keys(opts).sort();
  if (!keys.length) return '';
  return keys.map((k) => `${k}=${JSON.stringify(opts[k])}`).join(',');
}

/**
 * A material test board — one sphere plus one bevelled panel per surface.
 * Lives here rather than in a test file so the capture harness and any other
 * subsystem can ask for it.
 */
function buildDebugBoard(system, { columns = 6, spacing = 1.25, radius = 0.42 } = {}) {
  const group = new THREE.Group();
  const names = system.names();
  const sphere = new THREE.SphereGeometry(radius, 64, 48);
  const panel = new THREE.BoxGeometry(0.92, 0.92, 0.14, 8, 8, 2);
  system.bakeMasks(panel, { wear: 1, grime: 0.9 });

  names.forEach((name, i) => {
    const x = (i % columns) * spacing;
    const y = -Math.floor(i / columns) * spacing;
    const mat = system.get(name, { vertexMasks: false });
    const s = new THREE.Mesh(sphere, mat);
    s.position.set(x, y, 0);
    s.castShadow = s.receiveShadow = true;
    group.add(s);

    const pm = system.get(name, { vertexMasks: true, localSpace: true });
    const b = new THREE.Mesh(panel, pm);
    b.position.set(x, y, -0.9);
    b.castShadow = b.receiveShadow = true;
    group.add(b);
  });
  group.userData.names = names;
  return group;
}

export { bakeMasks, setMask, LIBRARY };
