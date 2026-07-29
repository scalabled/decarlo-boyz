import * as THREE from 'three';

import { hdrTarget, blit } from './pass.js';
import { CascadedShadowMaps } from './csm.js';
import { MaterialPatcher, shIrradiance, addHemisphereSH } from './materialpatch.js';
import { GBuffer } from './prepass.js';
import { Gtao } from './gtao.js';
import { ContactShadows } from './contact.js';
import { Ssr } from './ssr.js';
import { Taa } from './taa.js';
import { MotionBlur } from './motionblur.js';
import { DepthOfField } from './dof.js';
import { Bloom } from './bloom.js';
import { AutoExposure } from './exposure.js';
import { createGradeLut } from './lut.js';
import { createComposite, createFxaa, createDebug, createViewComposite } from './composite.js';
import { buildFallbackEnvironment } from './env.js';
import { RenderProbeScene } from './probe.js';
import { AerialPerspective } from './aerial.js';
import { SceneCuller } from './cull.js';

const QUALITY_LEVEL = { low: 0, medium: 1, high: 2, ultra: 3 };

/**
 * Registration range at or below which a punctual light counts as a room/street
 * PRACTICAL rather than as an effect flash. See `settings.practicalGain`.
 */
const PRACTICAL_RANGE = 30;

/**
 * Black zero-intensity point lights held in reserve to pin `numPointLights`.
 * See `_enforceLightCount`. Sized against the only subsystem that is known to
 * move the count (`world`'s own ballast pool is 16) with room to spare; an
 * invisible light costs nothing at all, three never even collects it.
 */
const LIGHT_BALLAST_POOL = 20;

// Full-daylight key intensity (SUN_ILLUMINANCE_TOP through a clear atmosphere).
// Only used to normalise the viewmodel rig, never to light anything.
const REF_DAYLIGHT = 4.6;

/**
 * DECARLO BOYZ renderer.
 *
 * Frame order (everything HDR, linear, float, until the very last write):
 *
 *   1  scene walk        collect draw/hide lists, patch new materials
 *   2  CSM               N stabilised cascades into one R32F array texture
 *   3  jitter            sub-pixel offset on the WORLD camera for TAA
 *   4  prepass           MRT: view normal + velocity + linear depth
 *   5  GTAO              horizon-arc AO, temporally accumulated
 *   6  contact shadows   short depth-buffer ray march toward the sun
 *   7  SSR               marched against depth, coloured from last frame
 *   8  forward world     lit with 2/5/6/7 injected into every material
 *   9  viewmodel         same lighting, into its OWN MSAA colour+depth target
 *  10  TAA               velocity reprojection + YCoCg variance clipping
 *  11  motion blur       velocity-tile reconstruction filter
 *  12  ADS depth of field gather CoC blur, only while the sights are up
 *  13  custom passes     whatever fx/ui/sky registered
 *  14  viewmodel resolve premultiplied composite over the world, FXAA'd
 *  15  metering          GPU log-luminance reduction -> EV100 -> exposure
 *  16  bloom             Karis pyramid with a soft-knee highlight threshold
 *  17  composite         AgX + LUT + vignette + CA + grain -> sRGB
 *  18  FXAA              only when TAA is off
 *
 * Why the viewmodel is resolved separately (steps 9 + 14): everything in
 * `viewScene` moves in VIEW space — the ADS transition, sway, bob, recoil — and
 * a velocity buffer built from camera view-projection matrices describes none of
 * it. Those pixels emitted zero motion, so TAA reprojected them onto a stale
 * history sample holding the static background and blended it in at ~85%. That
 * is what made the optic tube, the mount pedestal and the glove semi-transparent
 * with balcony rails and power lines legible straight through them. Compositing
 * after the resolve removes the whole failure mode instead of tuning around it,
 * and as a bonus keeps the weapon out of the volumetric fog and the ADS DOF.
 *
 * Nothing in the chain uses three's examples/jsm post stack.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC API — `const r = ctx.get('render')`
 * ---------------------------------------------------------------------------
 *   r.renderer                THREE.WebGLRenderer (do not change state mid-frame)
 *   r.screenSize              { width, height } of the internal HDR target
 *   r.displaySize             { width, height } of the canvas backbuffer
 *   r.depthTexture            R32F linear view depth in METRES (positive)
 *   r.velocityTexture         RG16F screen-space velocity as a UV delta
 *   r.normalTexture           RGBA16F oct-encoded VIEW normal (xy), coverage (z:
 *                             1 = static geometry, 0.7 = skinned/morphed, 0 =
 *                             nothing; test against 0.5 for "is there a
 *                             surface"), material id (w)
 *   r.aoTexture               R16F GTAO visibility, or null
 *   r.exposureTexture         1x1 float, .r = exposure scalar, .g = EV100
 *   r.hdrTexture              the pre-post HDR colour target
 *   r.prewarmMaterials()      compile the shadow/prepass/post programs up front
 *                             (loading screen only; advances no simulation)
 *   r.registerPass(pass)      pass.render(renderer, inTex, outTarget, r);
 *                             optional .order, .enabled, .resize(w,h).
 *                             Returns an unregister function.
 *   r.addLight(light, opts)   register a punctual light for distance culling
 *   r.requestEnvMap()         the PMREM environment currently in use
 *   r.setEnvMap(tex)          install a new PMREM (sky subsystem)
 *   r.patchMaterials(root)    force-inject shadows/AO/SSR into new materials
 *                             (happens automatically within a frame anyway)
 *   r.setExposureBias(ev)     +1 EV = one stop darker
 *   r.settings                live tuning: bloomStrength, bloomThreshold,
 *                             bloomKnee, vignette, adsVignette, grain,
 *                             chromatic, sharpen, shutter, aoRadius,
 *                             aoIntensity, contactLength, contactStrength,
 *                             shadowStrength, sunSoftness,
 *                             exposureKey, autoExposure, skyFill, groundFill,
 *                             bounceFill, viewKeyScale/Max/Gamma,
 *                             viewFillRatio, viewRimRatio, viewHemiRatio,
 *                             viewFillOcclusion, dofMaxCoc, dofNearRatio,
 *                             dofFocusMin/Max, dofFarStart, dofFarRange,
 *                             dofNearScale
 *
 * Note on colour space: chromatic aberration, bloom and the cos^4 lens vignette
 * are LINEAR-light lens effects and happen before the tone map — a vignette
 * applied to code values is a flat multiply that makes display white
 * unreachable everywhere but the centre of the frame. The composite then
 * tone-maps, encodes to sRGB, and applies the grade LUT, grain and dither in
 * DISPLAY space: the LUT is authored display-referred (additive toe and
 * split-tone offsets in code values), so anything added to that tail belongs
 * after the encode too.
 *   r.debugView               'ao'|'normal'|'velocity'|'depth'|'ssr'|'ssrmask'|
 *                             'contact'|'bloom'|'view'|'viewalpha'|null
 *                             (also ?rview=)
 *
 * Per-object opt-outs, set on the Object3D:
 *   userData.owNoPrepass = true   keep out of depth/normal/velocity (particles)
 *   userData.owNoShadow  = true   do not cast into the cascades
 *   userData.owMatId     = 0..1   written to the gbuffer alpha for custom fx
 * Transparent materials are excluded from the prepass and shadows automatically.
 */
/**
 * Exposure to fall back on when the metered value is unusable. Measured on the
 * shipped build: a daylight street meters 3.16 and night locks near 0.35, so
 * these are the two ends of the real range rather than invented numbers.
 */
const FALLBACK_DAY = 3.1;
const FALLBACK_NIGHT = 0.4;

export class RenderSystem {
  static id = 'render';
  static deps = [];

  async init(ctx) {
    this.ctx = ctx;
    const cfg = ctx.config;
    const q = cfg.q;
    this.q = q;
    this.qLevel = QUALITY_LEVEL[cfg.quality] ?? 3;
    this.rng = ctx.rng.fork();
    this.frame = 0;

    // ---- renderer -------------------------------------------------------
    const renderer = new THREE.WebGLRenderer({
      canvas: ctx.canvas,
      antialias: false, // TAA/FXAA handle this; MSAA cannot resolve HDR post
      alpha: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
      /**
       * REVERSED-Z. The single most important line in this file for an open
       * world, and the reason the far plane can be 6 km.
       *
       * A conventional depth buffer stores 1/z, so its precision is
       *   dz = q * (far-near) * z^2 / (near*far)
       * With near 0.05, far 6000 and a 24-bit fixed-point buffer that is 1.2 cm
       * at 100 m, 1.2 m at 1 km and 10.7 m at 3 km — i.e. every facade in the
       * downtown skyline occupies ONE depth value and z-fights against the one
       * behind it. Halving the far plane does nothing (the term is dominated by
       * `near`), and raising `near` breaks the third-person camera.
       *
       * Reversed-Z (near -> 1, far -> 0, depth test GREATER, clear 0) puts the
       * hyperbola's dense end where a float32's exponent is also dense, and the
       * two errors cancel almost exactly: precision becomes RELATIVE, ~2^-24 of
       * the distance, i.e. 0.2 mm at 3 km. It costs nothing — no extra pass, no
       * per-fragment work, no bandwidth — and it needs exactly two things:
       * EXT_clip_control (present on ANGLE/Metal, checked below) and a FLOATING
       * POINT depth attachment. The second half is done in `resize()`: a 24-bit
       * FIXED point buffer gains nothing from reversing, because the quantum is
       * uniform in NDC either way.
       *
       * Three flips its own projection matrices and depth funcs for this, so
       * every stock material is correct automatically. The two places that read
       * a depth value by hand are handled explicitly: the CSM array stores a
       * linear cascade-normalised depth (see csm.js) and the prepass stores
       * linear view metres (prepass.js), so neither ever sees an NDC z.
       */
      reversedDepthBuffer: !/[?&]owNoReverseZ=1/.test(location.search),
    });
    if (!renderer.capabilities.isWebGL2) {
      throw new Error('[render] WebGL2 is required');
    }
    /** True when EXT_clip_control was actually there and reversed-Z is live. */
    this.reversedZ = renderer.capabilities.reversedDepthBuffer === true;

    /**
     * One line naming what this GPU can and cannot do, logged at boot.
     *
     * It exists because a device-specific rendering fault is otherwise
     * undiagnosable from a bug report: "the lighting was too dark" on a phone
     * could be the exposure meter, the HDR colour target, a shader that failed
     * to compile or a quality tier, and none of them are distinguishable from
     * the outside. Anyone who can reach a console can now paste one line and
     * settle it. `__GPU__` holds the same record for a probe to read.
     */
    try {
      const gl = renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      this.gpu = {
        renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown'),
        floatRT: !!renderer.extensions?.has?.('EXT_color_buffer_float'),
        floatBlend: !!renderer.extensions?.has?.('EXT_float_blend'),
        floatLinear: !!renderer.extensions?.has?.('OES_texture_float_linear'),
        // A fragment shader asking for highp on hardware that only offers
        // mediump silently loses ~3 decimal digits, which HDR light values and
        // a log-luminance meter both notice.
        fragHighp: (gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision ?? 0) >= 23,
        maxTexSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        drawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
        dpr: (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1),
      };
      if (typeof window !== 'undefined') window.__GPU__ = this.gpu;
      const g = this.gpu;
      console.info(
        `[gpu] ${g.renderer} · floatRT ${g.floatRT} · fragHighp ${g.fragHighp} · ` +
        `drawBuffers ${g.drawBuffers} · maxTex ${g.maxTexSize} · dpr ${g.dpr}`
      );
    } catch {
      this.gpu = null;
    }
    renderer.autoClear = false;
    renderer.autoClearColor = false;
    renderer.autoClearDepth = false;
    renderer.info.autoReset = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping; // we tonemap in the composite
    renderer.shadowMap.enabled = true; // for spot/point lights owned by others
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.setClearColor(0x000000, 1);
    this.renderer = renderer;

    // ---- make every pre-compile see the FINAL program -----------------------
    // MEASURED: 26 of 144 live programs were unpatched duplicates of a lit
    // material — compiled once by a caller that pre-compiles the world scene
    // (src/core/prewarm.js does exactly this), then thrown away and compiled
    // again the moment the first real frame walked the scene and injected the
    // shadow/AO/SSR chunk, because `patch()` sets `needsUpdate`. That is 18% of
    // the boot's compile budget spent on programs that are never used to draw
    // anything. Patching before the compile makes the pre-compiled program the
    // one the frame loop actually wants. Restricted to the world and viewmodel
    // scenes so a subsystem baking a texture through its own scene is untouched.
    const rawCompile = renderer.compile.bind(renderer);
    renderer.compile = (target, cam, targetScene) => {
      if (target === ctx.scene) this._patchLikeFrame(ctx.scene, false);
      else if (target === ctx.viewScene) this._patchLikeFrame(ctx.viewScene, true);
      return rawCompile(target, cam, targetScene);
    };

    this.maxAnisotropy = Math.min(
      q.anisotropy,
      renderer.capabilities.getMaxAnisotropy()
    );

    // ---- subsystems of the pipeline --------------------------------------
    this.csm = new CascadedShadowMaps(renderer, {
      cascades: q.cascades,
      mapSize: q.shadowMapSize,
      maxDistance: q.shadowDistance,
    });
    this.patcher = new MaterialPatcher(this.csm.uniforms, {
      cascades: this.csm.cascades,
      quality: this.qLevel,
    });

    this.gbuffer = new GBuffer(renderer);
    this.gtao = q.gtao ? new Gtao() : null;
    this.contact = this.qLevel >= 1 ? new ContactShadows() : null;
    this.ssr = q.ssr ? new Ssr() : null;
    this.taa = q.taa ? new Taa() : null;
    this.motionBlur = q.motionBlur ? new MotionBlur() : null;
    // ADS depth of field. Cheap (half-res gather, 32 taps) and only ever runs
    // while the sights are actually up, so it costs nothing in hipfire.
    this.dof = this.qLevel >= 1 ? new DepthOfField() : null;
    this.bloom = q.bloom ? new Bloom(this.qLevel >= 2 ? 6 : 5) : null;
    this.aerial = new AerialPerspective();
    this.aerial.enabled = !/[?&]owNoAerial=1/.test(location.search);
    this.culler = new SceneCuller();
    this.exposure = new AutoExposure(renderer);
    // Headroom for a physically-scaled sky (sunlit scenes reach ~5000 cd/m2).
    // The lower limit is the night exposure lock: a moonlit street meters at
    // EV100 -5.2, and letting the meter chase that turns night into an overcast
    // afternoon. Daylight shots meter between -1 and -2.1, so this only ever
    // binds after dark.
    this.exposure.setLimits(-4.3, 20);
    this.lut = createGradeLut('steelcity');
    this.composite = createComposite(this.lut);
    this.viewComposite = createViewComposite();
    this.fxaa = q.taa ? null : createFxaa();
    // MSAA on the viewmodel target only. It is the one buffer whose geometric
    // edges no longer get a temporal filter, and 4x on a single small pass is
    // far cheaper than any spatial substitute at the same quality.
    this._viewSamples = this.qLevel >= 2 ? 4 : this.qLevel >= 1 ? 2 : 0;

    // Always on: depthTexture/velocityTexture are part of the public contract
    // (soft particles, SSR, motion blur) even when our own effects are off.
    this.needsPrepass = true;

    this.hdrRt = null;
    this.viewRt = null;
    this.ldrRt = null;
    this.pingRt = [null, null];
    this._pingIndex = 0;
    this._adsT = 0;
    this._weapons = null;

    this._tmpV3 = new THREE.Vector3();
    this._tmpV3b = new THREE.Vector3();
    this._fillHue = new THREE.Vector3();
    this._fillHue2 = new THREE.Vector3();
    this._fillSkySave = new THREE.Vector3();
    this._fillGroundSave = new THREE.Vector3();
    this._fillWrapSave = new THREE.Vector3();
    /**
     * The sky irradiance SH at full strength, before any per-pass attenuation.
     * The uniform array is written FROM this, never scaled in place: the
     * viewmodel pass multiplies the fill down and back up again, and doing that
     * to nine coefficients in situ accumulates float error every frame.
     */
    this._skySH = new Array(9);
    for (let i = 0; i < 9; i++) this._skySH[i] = new THREE.Vector3();
    this._shE = new THREE.Vector3();
    this._shE2 = new THREE.Vector3();
    this._ambLevel = 0.6;
    this._roomsReady = false;
    this._skyExposureBias = 0;

    // ---- lighting defaults ------------------------------------------------
    // The sky subsystem normally owns the sun. Until it does, we provide one
    // so the world is never lit by nothing; it hides itself the moment a
    // brighter directional light shows up in the scene.
    this.sun = new THREE.DirectionalLight(0xffe8c4, 4.3);
    this.sun.name = 'ow-fallback-sun';
    this.sun.position.set(-42, 46, 26);
    this.sun.castShadow = false;
    this.sun.target.position.set(0, 0, 0);
    ctx.scene.add(this.sun);
    ctx.scene.add(this.sun.target);
    this.activeSun = this.sun;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.sunDirView = new THREE.Vector3(0, 1, 0);

    // ---- viewmodel light rig ---------------------------------------------
    // The weapon lives in its own scene. Handing it one copy of the world sun
    // means that whenever the sun is behind the gun the camera-facing side gets
    // nothing, and weapon albedos are physically correct (anodised aluminium is
    // 0.026 linear) so it goes to a black silhouette. It gets a real 3-point
    // rig instead, with every direction fixed in VIEW space so the weapon reads
    // identically at any world sun azimuth — which is what every shipped FPS
    // does, and the reason their guns are always legible.
    this.viewSun = new THREE.DirectionalLight(0xffe8c4, 2.0);
    this.viewSun.name = 'ow-viewmodel-key';
    this.viewKeyFill = new THREE.DirectionalLight(0x9ec4ff, 0.6);
    this.viewKeyFill.name = 'ow-viewmodel-fill';
    this.viewRim = new THREE.DirectionalLight(0xffd7a8, 1.0);
    this.viewRim.name = 'ow-viewmodel-rim';
    this.viewFill = new THREE.HemisphereLight(0x8fb6ff, 0x36302a, 0.35);
    // Warm bounce off the ground/street, arriving from BELOW. Without it, any
    // part of the weapon or hands that sits in the gun's own cast shadow — the
    // support glove under the handguard is the worst case — is lit by nothing
    // but the cool sky fill, so a warm glove albedo still renders blue. A real
    // street throws a stop of warm light back up; this is that term.
    this.viewBounce = new THREE.DirectionalLight(0xffb87a, 0.5);
    this.viewBounce.name = 'ow-viewmodel-bounce';
    // View-space directions the light arrives FROM: key upper-front-left,
    // fill lower-front-right, rim from behind to catch the top edges of the
    // receiver, rail and optic body, bounce from below-front.
    this._viewKeyDir = new THREE.Vector3(-0.45, 0.75, 0.55).normalize();
    this._viewFillDir = new THREE.Vector3(0.6, -0.15, 0.5).normalize();
    this._viewRimDir = new THREE.Vector3(0.2, 0.35, -0.9).normalize();
    this._viewBounceDir = new THREE.Vector3(-0.2, -0.86, 0.47).normalize();
    this._tmpV3c = new THREE.Vector3();
    for (const l of [this.viewSun, this.viewKeyFill, this.viewRim, this.viewBounce]) {
      l.castShadow = false;
      ctx.viewScene.add(l, l.target);
    }
    ctx.viewScene.add(this.viewFill);
    // The frame loop skips the viewmodel pass when nothing but our own rig is
    // in there; remember how many children that is.
    this._viewRigChildren = ctx.viewScene.children.length;

    const env = buildFallbackEnvironment(renderer, this._dirFromLight(this.sun, this.sunDir));
    this.envTarget = env.target;
    this.envEquirect = env.equirect;
    this.envMap = this.envTarget.texture;
    if (!ctx.scene.environment) ctx.scene.environment = this.envMap;
    if (!ctx.scene.background) ctx.scene.background = this.envEquirect;
    ctx.viewScene.environment = ctx.scene.environment;
    this._assignedViewEnv = ctx.scene.environment;

    // ---- the punctual light pool -----------------------------------------
    // See ARCHITECTURE.md "The point-light count is a shader permutation key".
    // The visible point-light count is baked into every lit material's program
    // cache key, so one lamp appearing or disappearing recompiles the entire
    // scene: measured at +33 to +36 programs and 640-900 ms on that one frame.
    //
    // A night city has thousands of lamps and cannot spend that even once. So
    // the renderer owns a FIXED pool of exactly `q.lightSlots` point lights,
    // created here, added to the scene here, and NEVER removed, hidden or
    // re-added for the lifetime of the process. The count is therefore a
    // compile-time constant that the pre-warm sees and no frame can change.
    //
    // Everything else — street lamps, shop signs, brake lights, the glow in a
    // window — is emissive material plus bloom, which costs nothing per light
    // and is what actually produces the sodium pools on wet asphalt.
    // Subsystems that genuinely need a real light (headlights, muzzle flash,
    // the nearest practicals) call `submitLight()` once per frame and the
    // renderer scores them into the slots. See the note on `submitLight`.
    this.lightSlots = Math.max(0, q.lightSlots | 0);
    this._pool = [];
    for (let i = 0; i < this.lightSlots; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 1, 2);
      l.name = `ow-light-slot-${i}`;
      l.castShadow = false;
      l.visible = true; // permanently. Never conditional. This is the contract.
      l.position.set(0, -10000 - i, 0);
      ctx.scene.add(l);
      this._pool.push({ light: l, key: -1, level: 0 });
    }
    // ---- the light-count LOCK --------------------------------------------
    // The pool above makes the renderer's OWN contribution constant, but that
    // is only half the invariant: three bakes `numPointLights` — the count of
    // every VISIBLE point light in the scene, whoever owns it — into the cache
    // key of every program, including the CSM depth and MRT prepass override
    // materials, which do not even read the lights. So any subsystem toggling
    // a point light's `visible` recompiles the whole scene.
    //
    // MEASURED (tools/profile.mjs + the light probe, tier `low`): the count
    // oscillates 16 <-> 15 during ordinary play, and the FIRST transition costs
    // 1291 ms and 61 programs. Every later toggle is free because both
    // permutations are now cached — which is exactly why it reads to a player
    // as "it freezes every few seconds" and then settles, rather than as a low
    // frame rate. Pre-warm cannot fix it: it compiles at whatever count is
    // live when it runs, and the count moves afterwards.
    //
    // So the renderer pins it. `_enforceLightCount()` runs once per frame,
    // latches the first count it sees (which is the count everything was
    // pre-warmed at) and tops the scene up with black, zero-intensity,
    // 0.01 m-range point lights whenever anything else drops one. Ballast is
    // pixel-neutral by construction: `getPointLightInfo` multiplies by a black
    // colour and a zero intensity, so it adds exactly 0.0 to the accumulator.
    this._ballast = [];
    for (let i = 0; i < LIGHT_BALLAST_POOL; i++) {
      const l = new THREE.PointLight(0x000000, 0, 0.01, 2);
      l.name = `ow-light-ballast-${i}`;
      l.castShadow = false;
      l.visible = false;
      l.userData.owBallast = true;
      // Marks it as OURS, so `_visit` can count the foreign lights only and the
      // top-up is computed against a number that does not include itself.
      l.userData.owRenderBallast = true;
      l.position.set(0, -20000 - i, 0);
      ctx.scene.add(l);
      this._ballast.push(l);
    }
    /**
     * `?owNoLightLock=1` turns the pin off, so the fix can be A/B'd against
     * itself inside one build and one browser session — which is the only way
     * to measure it honestly on a shared machine, where run order is worth more
     * than the change. Same diagnostic pattern as `?gov=0` and `?prewarm=0`.
     */
    this.lightCountLockEnabled = !/[?&]owNoLightLock=1/.test(location.search);
    /** Latched on the first frame; -1 until then. See `_enforceLightCount`. */
    this._lightCountLock = -1;
    this._lightCountRaises = 0;
    /** Foreign visible point lights, counted for free during `_visit`. */
    this._nPointLights = 0;

    /** Per-frame submissions, preallocated. Never grows during a frame. */
    this._req = [];
    for (let i = 0; i < 256; i++) {
      this._req.push({
        x: 0, y: 0, z: 0, r: 1, g: 1, b: 1,
        intensity: 0, range: 20, priority: 1, key: -1, score: 0,
      });
    }
    this._nReq = 0;
    this._reqOverflow = 0;

    // ---- bookkeeping ------------------------------------------------------
    this.passes = [];
    this.lights = [];
    this._draw = [];
    this._nDraw = 0;
    this._hide = [];
    this._nHide = 0;
    /** Objects that DO cast into the cascades (see _visit). */
    this._casters = [];
    this._nCasters = 0;
    /** ...and everything that must be hidden while the cascades draw. */
    this._shadowHide = [];
    this._nShadowHide = 0;
    this._dirLights = [];
    this._nDirLights = 0;
    this._foreignMeshes = 0;

    this._currVP = new THREE.Matrix4();
    this._prevVP = new THREE.Matrix4();
    this._invVP = new THREE.Matrix4();
    this._camPos = new THREE.Vector3();
    this._jitterSaved = new THREE.Vector2();
    this._viewVisible = false;
    this._readback = new Float32Array(4);
    this._readback2 = new Float32Array(4);
    this._jittered = false;
    this._firstFrame = true;

    this.screenSize = { width: 1, height: 1 };
    this.displaySize = { width: 1, height: 1 };
    this.depthTexture = null;
    this.velocityTexture = null;
    this.normalTexture = null;
    this.aoTexture = null;
    this.exposureTexture = this.exposure.texture;

    this.settings = {
      exposureBias: 0, // EV; positive = darker
      exposureKey: 1.06,
      autoExposure: true,
      // The pyramid is ADDED now, not mixed, and it is soft-knee thresholded at
      // `bloomThreshold` in exposure-scaled linear light — so this is the gain on
      // light that is genuinely above display white (sun disc, glints, muzzle
      // flash), not a whole-frame veiling-glare percentage. 0.048 of a mix() was
      // invisible; 0.12 of an additive thresholded pyramid is a specular event.
      // 0.30, more than doubled. The panel's finding was "no bloom, no veiling
      // glare, no adaptation visible in the frame" alongside "no specular energy
      // at all" — and those two are the same finding. A sub-pixel solar
      // highlight off a railing exists in the HDR buffer and is invisible on
      // screen until the pyramid spreads it over enough pixels for the eye to
      // integrate. Bloom is not decoration here; it is how a specular EVENT
      // becomes a specular IMAGE.
      // ── EMISSIVE SPILL ───────────────────────────────────────────────────
      // 1.15, from 0.34. Street lamps and lit windows in this game are EMISSIVE
      // MATERIAL PLUS BLOOM by design (the light-slot budget is a shader
      // permutation key and must not vary), so the pyramid is not decoration
      // for them — it is the ONLY way an emitter can affect a neighbouring
      // pixel. It was not doing it.
      //
      // MEASURED on `searchlight_side`, a vertical column across the mullion
      // between two 197,204,216 lobby windows, at 1080p ultra:
      //
      //   window                            197,204,216
      //   4 px into the mullion               6, 15, 30
      //   10-25 px in, i.e. the whole gap     4,  8, 18   <- flat
      //
      // Two windows a few pixels away on either side and the mullion between
      // them was the sky's ambient and nothing else. That is the critic's
      // "14,13,18 twenty pixels from a 240-level window": a lit window in a
      // dark city that lights nothing, not even in appearance.
      //
      // The pyramid's SHAPE was fine — it falls 0.098 -> 0.005 over 12 px,
      // which is the tight skirt a lamp should have. Its AMPLITUDE was the
      // problem: 0.34 x 0.005 = 0.0017 added to a pixel already at ~0.010, an
      // eighth of a stop.
      //
      // Raising the gain is nearly free in daylight because THERE IS ALMOST
      // NOTHING IN THE PYRAMID IN A DAY FRAME — measured on `hero`, the bloom
      // buffer reads 0.00034 in the sky and exactly 0.00000 over the street
      // and the buildings. Gain multiplies zero. What it multiplies is a night
      // city, which is where the finding is.
      //
      // The one frame where it is NOT free is an overcast one whose sky is
      // genuinely above the threshold — `driving` sits at mean 228 / p99 248 —
      // and that is what `bloomSpillCap` below exists for. Measured result on
      // the mullion above: 4,8,18 -> 5,14,30, i.e. L* 2.20 -> 4.16, +0.92 stop.
      bloomStrength: 1.15,
      // 1.6, not 0.85. A daylight sky lands around 1.0-1.5 in exposure-scaled
      // linear light, so at 0.85 the SKY was the brightest thing in the pyramid
      // and the widest mip smeared it four or five pixels over every roofline and
      // every silhouette in front of it — an enemy on a balcony measured 3%
      // contrast against the cloud he was standing in front of. At 1.6 the sky is
      // below the knee and the pyramid is back to what it is for: the sun disc,
      // glints, tracers, muzzle flash.
      // 1.25, down from 1.6. At 1.6 only things more than two-thirds of a stop
      // above display white entered the pyramid, which in practice meant the
      // sun disc and nothing else. 1.25 admits real speculars — a wet kerb, a
      // galvanised pipe, a lit window at 2 km — while still sitting above a
      // daylight sky (which lands around 1.0-1.5) so the pyramid never turns
      // into the whole-frame veil the note below warns about.
      // 1.55. Lowering it to 1.25 to admit more specular events did admit them
      // — and also admitted the daylight SKY, which lands at 1.0-1.5 in
      // exposure-scaled linear light. A sky inside the pyramid is not bloom, it
      // is a halo painted around every roofline in the frame, which is the exact
      // failure the previous tuning pass documented at 0.85. The gain is taken
      // on `bloomStrength` instead, where it multiplies genuine highlights
      // without changing what counts as one.
      // 1.45, and this one is a CLIFF, so it was measured rather than picked.
      // Reading the emitted bloom buffer back through the prefilter's own
      // response gives the effective level of each thing in the pyramid:
      //
      //   `hero` daylight sky        1.56    <- exactly where 1.55 was set
      //   night lobby window         1.81
      //   the mullion beside it      1.80 (the window's own skirt)
      //
      // So 1.55 sat one hundredth of a stop under the daylight sky: a fraction
      // lower and the sky floods the pyramid (that is the roofline-halo failure
      // at 0.85 and at 1.25 in the notes above), a fraction higher and a lit
      // window contributes 0.098 where it should contribute a quarter.
      //
      // 1.20 is below the window and clear of the sky with margin. Measured at
      // 1.20 against 1.55: the window's pyramid value 0.098 -> 0.21 and the
      // mullion beside it 0.0051 -> 0.0122, while the `hero` sky goes 0.00034
      // -> 0.0088 — which at gain 1.0 is 0.9% of a sky sitting near 1.5, i.e.
      // about one code value. The ratio between a lit window and a daylight sky
      // inside the pyramid is 24:1 at this threshold.
      //   `?owNoEmissiveSpill=1` restores 1.55 / 0.34 for the A/B.
      bloomThreshold: 1.45,
      bloomKnee: 0.7,
      /**
       * Ceiling on the lift the bloom pyramid may add to a single pixel, in
       * exposure-scaled linear light. See composite.js: this is what makes the
       * gain above safe on a bright overcast sky, whose own pyramid value is a
       * large fraction of display white while a window's skirt on the mullion
       * beside it is under one percent of it.
       *
       * Swept on `driving` — the brightest sky in the shot set, already at mean
       * 228 / p99 248 / 5.13% of pixels over 245 BEFORE any of this — against
       * pixels over 250, and on `searchlight_side` against the mullion:
       *
       *   gain 0.34, no cap (as shipped)   driving >250 0.007%   mullion L* 2.2
       *   gain 1.15, no cap                driving >250 4.291%   mullion L* 3.9
       *   gain 1.15, cap 0.12              driving >250 0.000%   mullion L* 3.9
       *   gain 1.15, cap 0.30              driving >250 0.000%   mullion L* 3.9
       *
       * i.e. the whole of the sky's blow-out and none of the mullion's spill.
       * 0.30 rather than 0.12 because the cap also bites on the SUN, and at
       * 0.12 the golden-hour halo in `sunset` loses more of its outer ring than
       * it gains; at 0.30 the sun's glow reads slightly wider than before, not
       * narrower, and the frame mean is unchanged (71/44/22 both arms).
       */
      bloomSpillCap: 0.30,
      // Lateral CA. Kept small: it is a lens signature, and at 0.0018 the R/B
      // split reached most of a pixel in the corners, which the sharpen filter
      // then turned into visible fringing on every high-contrast edge.
      // 0.0016. GTA V has a visible lateral CA at the frame edge and it is part
      // of why its frames read as photographed rather than rendered. The reason
      // it had to be held at 0.0011 before was the sharpen filter amplifying the
      // shifted fetch into coloured fringing; that was fixed by making the
      // sharpen luminance-only off the UNSHIFTED centre tap, so the lens
      // signature can go back to a size you can actually see.
      chromatic: 0.00085,
      // Vignette and grain are applied in DISPLAY space (see composite.js), so
      // these are code-value amplitudes, not linear-light ones.
      vignette: 0.26,
      // Closes in while the sights are up: the frame has to tell you your eye is
      // behind a tube, not just that the gun moved.
      adsVignette: 0.34,
      // "visible film grain" is on the GTA V checklist. 0.013 reads as grain at
      // 1080p without becoming noise; the response curve in composite.js keeps
      // it out of the deep shadows where it would read as a dirty image.
      grain: 0.013,
      // ---- ADS depth of field (see dof.js) ---------------------------------
      // maxCoc is in pixels at 1080p and is reached well beyond focusMax, so
      // geometry past ~25 m goes visibly soft while the optic — composited after
      // the pass — stays pin sharp.
      // 3.3 px at 1080p, down 40%: at 5.5 the near and mid ground of an ADS frame
      // was a watercolour smear that hid the very thing the sights are pointed at.
      dofMaxCoc: 3.3,
      dofNearRatio: 0.38,
      dofFocusMin: 3.0,
      dofFocusMax: 18.0,
      dofFarStart: 1.15,
      dofFarRange: 18.0,
      dofNearScale: 0.55,
      sharpen: 0.25,
      lutStrength: 1.0,
      shutter: 0.42,
      /**
       * ──────────────────────────────────────────────────────────────────────
       * THE AO BLOCK, CALIBRATED ON EMITTED PIXELS (`?rview=ao`, ultra, 1080p)
       * ──────────────────────────────────────────────────────────────────────
       * Everything here used to carry a note saying it had never been observed:
       * `aoRadius` 1.35, `aoIntensity` 1.1, `aoFloor` 0.15 and `aoBias` 0.12
       * were all last edited while GTAO's early-out returned 1.0 for every
       * pixel in the frame, so none of them had ever changed an image. They
       * have now been swept against the buffer they drive, in one build, with
       * `?owSet=` (see the hatch below) and `?owNoAoReach=1` as the control.
       *
       * MEASURED AO on `street` (visibility, 1.0 = unoccluded), old -> new:
       *
       *   wall / pavement seam, first metre   0.771 -> 0.549
       *   window reveal                       0.609 -> 0.398
       *   under the cornice / eaves           0.844 -> 0.701
       *   open brick facade                   0.940 -> 0.843
       *   kerb / pavement junction            0.961 -> 0.725
       *   tree base in its pit                0.760 -> 0.680
       *   OPEN ROAD, foreground               1.000 -> 1.000
       *   OPEN ROAD, mid                      1.000 -> 1.000
       *
       * and on `car`:
       *
       *   ground under the floor pan          0.548 -> 0.148
       *   ground at the front tyre contact    0.172 -> 0.112
       *   ground at the rear tyre contact     0.254 -> 0.164
       *   open asphalt beside the car         1.000 -> 1.000
       *
       * The last line of each block is the one that makes the rest mean
       * something: open ground is still exactly unoccluded, so this is contact
       * occlusion getting deeper, not the buffer getting darker.
       *
       * 2.6 m rather than 1.35: the objects that have to read as touching are
       * metres across — a car is 4.5 m long, a doorway 2 m, a street tree pit
       * 1.5 m — and a 1.35 m radius cannot see past the object to the ground it
       * stands on. 2.6 m is roughly the height of a shopfront, which is the
       * scale of the contact this frame is missing. Past ~4 m it stops reading
       * as contact and starts reading as a dirty grey overlay on flat walls
       * (measured at 4.0 m: the open facade goes to 0.819 and the eaves to
       * 0.633, which is soot rather than occlusion).
       */
      aoRadius: 2.6,
      // Occlusion is a shaping tool, not a darkening tool: 1.7 with no bounce
      // fill behind it was what turned every corner into a black hole. 1.4 is
      // where the seam reaches ~0.55 while an open facade stays above 0.84.
      aoIntensity: 1.4,
      /**
       * How much indirect light survives in a fully occluded pocket.
       *
       * This is the first tuning pass in which it has ever bitten: the buffer
       * now reaches 0.11 under a car and 0.11 at a tyre contact, so `max(ao,
       * aoFloor)` is the operator deciding how dark a contact is allowed to
       * get, where before nothing in the frame ever came near it. Held at 0.15
       * — it stands in for the multiply-scattered light this engine does not
       * compute, and driving it toward zero produces a black halo rather than
       * an occlusion. Sweeping it below 0.12 crushes the tyre contacts.
       */
      aoFloor: 0.15,
      /**
       * Minimum sine above a surface's own tangent plane before a sample is
       * allowed to occlude it. See the note in gtao.js: without it a facade
       * seen at a grazing angle occludes ITSELF and reads AO 0.000, which is
       * what turned every brick rowhouse in `street` into a navy slab the
       * first time the AO pass was made to emit anything.
       *
       * Left at 0.12. Lowering it to 0.07 deepens the seam by another 0.05 but
       * it is the one number here whose failure mode is the navy-slab
       * regression, and the radius buys the same darkening without that risk.
       */
      aoBias: 0.12,
      /**
       * Ceiling on GTAO's screen-space march, as a fraction of render height.
       *
       * THIS, not `aoRadius`, is what the near field is actually marched at —
       * see the note in gtao.js. It was a hardcoded 128 px, which at 1080p and
       * fov 55 meant `aoRadius` was silently discarded for everything nearer
       * than 21 m and replaced by depth/8.1 metres. 0.30 of render height (324
       * px at 1080p) moves that crossover to 8.3 m and, being resolution
       * relative, makes `aoRadius` mean the same number of metres at 720p and
       * at 1440p. `?owNoAoReach=1` restores the old march exactly.
       */
      aoReach: 0.30,
      // Screen-space contact shadows. The length is a world-space ray in metres
      // at 1x distance scaling (see contact.js): it has to resolve the 0-40 cm
      // range, because that is the gap a cascade texel cannot see and the
      // difference between a crate sitting on the floor and a crate stickered
      // onto it. Debuggable with ?rview=contact.
      // 0.55 m, up from 0.4. The critic's finding was "pebbles and debris read
      // as decals lying on the road" — a contact ray has to be longer than the
      // object it is grounding, and the props in this game (kerbs, drains,
      // litter, tyres) are 10-50 cm. It is still short enough to stay a contact
      // term rather than a second, noisier shadow map.
      contactLength: 0.55,
      contactStrength: 1.0,
      // Hemispheric sky/ground fill, and the warm anti-sun bounce wrap, as a
      // fraction of the key's intensity (see _updateBounceFill).
      //
      // These are a *budget*, and the budget is what sets the key:fill ratio.
      // Real direct sun runs 5-8:1 against its own shade; at skyFill 0.09 /
      // groundFill 0.055 / iblDiffuse 1.0 the indirect terms were supplying 42%
      // of every lit value and the ratio collapsed to 2.4:1 — a frame with no
      // sun in it, only a bright ambient. Cut hard and let the beam carry it.
      // ---- the indirect budget, restated -----------------------------------
      // These three numbers ARE the key:fill ratio, and after the critic panel
      // measured the same shadow transition at 4.0 stops on a facade and 1.9 on
      // ground two metres away, they are now derived rather than dialled. With
      // the hemisphere visibility fixed in materialpatch.js:
      //
      //   open ground   lit 3.61  shade 0.60   ->  2.59 stops
      //   vertical wall lit 3.17  shade 0.57   ->  2.47 stops
      //
      // against a light meter's ~2.7 / ~3.5 on a real sunlit street. Consistent
      // across orientation, which was the actual defect, and no longer flat.
      //
      // `skyFill` is the sky's diffuse irradiance on a fully up-facing surface,
      // as a fraction of the sky's own published ambient reference. Measured
      // ratio to the beam at 0.14: skyLevel 0.668 against a 7.39 sun, i.e.
      // 0.090 — against the 12 klx / 90 klx = 0.13 a clear sky actually
      // delivers. 0.20 lands on 0.129, which is the real number, and it is
      // what puts enough blue in an open shadow to survive the warm bounce
      // coming back off the street.
      skyFill: 0.20,
      /**
       * How far the sky-fill HUE is pulled back toward Rayleigh blue as the sun
       * approaches the horizon. See _updateBounceFill: the sky publishes a
       * whole-sky average, which at golden hour is the sunset band and would
       * otherwise paint every shadow in the frame orange.
       */
      skyFillCoolBias: 0.7,
      /**
       * Diffuse albedo of the street, used to compute the ground bounce from
       * the horizontal illuminance rather than from a magic constant (see
       * _updateBounceFill). A wet grey-brown rustbelt street: asphalt 0.10-0.14,
       * concrete 0.25, so 0.15 for the mix. This is a MATERIAL property standing
       * in for a GI solve, so it is deliberately the real number.
       *
       * It replaces a flat `groundFill: 0.013` — a hundredth of a stop, i.e.
       * nothing, which is why the critic measured "the shadow side of the
       * street is one flat directionless grey with no warm bounce from the
       * sunlit ground opposite".
       *
       * 0.11, not 0.15: a city street is mostly asphalt (0.07-0.12) and only
       * partly concrete pavement (0.20-0.25), and this one is wet. The old
       * value made the warm band 1.7x the cool one on every vertical surface
       * in the game, which is enough to cancel the sky out of a shadow
       * completely — see _updateBounceFill.
       */
      groundAlbedo: 0.11,
      /**
       * Spectral albedo of the street and of masonry, normalised to red. Both
       * are near-neutral on purpose: they multiply light that is ALREADY the
       * sun's colour, and stacking a saturated albedo on top of a warm
       * illuminant is what turned the bounce into desert sand.
       */
      streetTint: [1.0, 0.955, 0.885],
      wallTint: [1.0, 0.96, 0.90],
      /**
       * The wrap band: the shaded side of the street lit by the SUNLIT FACADES
       * across it, arriving from the anti-sun hemisphere. Expressed as
       *   wallAlbedo x (fraction of the anti-sun hemisphere that is lit wall)
       * so the level is `bounceWrap * beam * cos(altitude)` — strongest at
       * golden hour, when a low sun is raking every wall in the city, and
       * weakest at noon when it is lighting roofs and roads instead. This is
       * the difference between a shadow that reads as shape and one that reads
       * as silhouette.
       */
      bounceWrap: 0.055,
      // The PMREM sky cubemap. Scaling its *diffuse* here is the only place the
      // total indirect budget can actually be controlled from; specular radiance
      // is left alone, because that is reflection, not fill, and it is one of
      // the few sources of genuine highlight energy in the frame.
      //
      // Kept small because the two analytic bands above now carry the indirect
      // budget with a physically consistent orientation response, which a PMREM
      // of an achromatic dome cannot. Raise this as the sky's Rayleigh gradient
      // comes back and lower skyFill by the same amount.
      iblDiffuse: 0.045,
      // Indirect floor inside a coarse interior volume. Skylight does not reach
      // the middle of a closed room; without this the doorway reads as a hole
      // cut in a card because the room is brighter than the street outside it.
      interiorIndirect: 0.035,
      // Global trim on room and street practicals (see PRACTICAL_RANGE).
      //
      // Twenty interior bulbs and twenty-two sodium lamps are the ONLY light in
      // a closed room and by far the loudest thing in a night street, so they
      // are what actually sets two of this renderer's headline ratios:
      // interior-to-exterior through a doorway, and warm-pool-to-cool-ambient
      // after dark. At unity an interior metered within 1.3 stops of the sunlit
      // facade framed in its own opening (a real one runs 4-5) and every
      // surface in the night frame took its hue from a lamp. Half a stop off
      // them buys most of both, and it is applied here rather than at the
      // source because the balance is a lighting decision, not an art one.
      practicalGain: 0.55,
      // Sky the viewmodel can actually see, past the shooter's own body.
      viewFillOcclusion: 0.45,
      // Viewmodel 3-point rig. The key is scaled off the scene's own light
      // level (see _updateViewRig); fill, rim and hemisphere are ratios of it.
      viewKeyScale: 0.55,
      viewKeyMax: 2.6,
      viewFillRatio: 0.3,
      viewRimRatio: 0.5,
      // 0.35 hemisphere against a ~2.2 daylight key, expressed as a ratio so it
      // follows the time of day instead of blowing the gun out at night.
      viewHemiRatio: 0.16,
      // Warm ground bounce from below. Sized to lift the glove out of the
      // handguard's cast shadow without competing with the key: at 0.34 of the
      // key it is ~1.5 stops down, which is about what a sand street returns.
      viewBounceRatio: 0.34,
      viewKeyGamma: 0.65,
      shadowStrength: 1.0,
      // tan(sun angular radius) used by the PCSS penumbra estimate. The real
      // sun is 0.00465; this is ~4x that, which is the standard cheat — a
      // physically exact solar penumbra is under a shadow texel at every
      // distance a cascade can resolve, so contact hardening becomes invisible
      // and the shadows read as a stencil. Brought down from 0.024 because at
      // 430 m of shadow distance the far cascades' blocker gaps are tens of
      // metres and 0.024 turned a building's own shadow into a 1 m smear.
      sunSoftness: 0.017,

      // ---- aerial perspective (see aerial.js) --------------------------------
      aerialStrength: 1.0,
      /**
       * Aerosol extinction at the base altitude, 1/m, before weather.
       *
       * This is the number that sets how far the city reads, so it is worth
       * stating the curve it produces on a horizontal street-level ray:
       *   200 m -> 5% haze,  500 m -> 13%,  1 km -> 24%,  2 km -> 42%,
       *   3 km -> 55%.
       * That is a real hazy-but-not-foggy day (about 14 km meteorological
       * visibility). Going much above this starts hiding the city rather than
       * placing it, which is the failure mode ARCHITECTURE.md calls out: "fog
       * that hides a missing city".
       */
      aerialMie: 2.05e-4,
      /**
       * Rayleigh multiplier over the sea-level coefficients. Not physical for a
       * 3 km path — it stands in for the multiple scattering a single-scattering
       * model does not compute — and the channel ratio (1 : 2.3 : 5.7) is what
       * does the real work.
       *
       * 8.5, up from 3.2, with the aerosol trimmed from 2.55e-4 to 2.05e-4.
       * The two numbers are ONE decision: what matters is not how much haze
       * there is, it is what FRACTION of the optical depth is Rayleigh, because
       * the aerosol term is grey by construction (1, 0.98, 0.94) and only the
       * Rayleigh term can make distance eat red before blue.
       *
       * At 3.2 / 2.55e-4 the aerosol was 13.7x the Rayleigh red coefficient, so
       * the per-channel transmittance was achromatic to within 5% and every
       * distant surface converged to a NEUTRAL grey no matter what the sky
       * above it was doing. Measured on the hero frame: far terrain 157,159,162
       * — 2.9% saturation, B-R +4.7 — and on the street frame a distant hill at
       * 130,134,147 against a sky at that elevation of 178,211,235. The haze
       * refused to inherit the sky's Rayleigh blue, which is the whole effect.
       *
       * On a 1 km horizontal ray the new pair gives transmittance
       * (0.78, 0.74, 0.63) against the old (0.76, 0.75, 0.71): blue now
       * converges to the sky half again as fast as red instead of 5% faster,
       * and the total haze is essentially unchanged, so the "how far can you
       * see" curve this file documents above still holds.
       */
      aerialRayleigh: 8.5,
      /** Scale heights, metres. The aerosol one is a real urban boundary layer:
       *  240 m puts the Mt. Washington clifftop (~150 m over the river) half
       *  out of the murk while downtown sits fully in it. */
      aerialRayleighHeight: 2400,
      aerialMieHeight: 240,
      /** Altitude the density profile is anchored at — river level. */
      aerialBaseY: 0,
      aerialMaxDistance: 9000,
      /** Mie asymmetry. 0.62 gives a ~10:1 forward peak: haze GLOWS toward a low
       *  sun and goes blue-grey away from it, which is the effect. */
      aerialPhaseG: 0.62,
      aerialPhaseBack: -0.28,
      aerialBackWeight: 0.22,
      /** Clamp on the sky radiance sample, so the solar disc (authored around
       *  4000) cannot light a whole hillside through the haze term. */
      aerialSkyClamp: 9.0,
      /** How far the sky sample is pulled toward the horizon band. */
      aerialHorizonBias: 0.55,
      /** How much of the phase excess is applied over the sky sample. At 0 the
       *  haze is exactly the sky colour; at 1 it is fully phase-modulated. */
      aerialSunGlow: 0.85,
      /** Fraction of the aerosol term ceded to `sky`'s own volumetric fog so
       *  the two do not attenuate the same photons twice. */
      aerialSkyShare: 0.55,
      /** Sodium-amber city glow scattered back down after dark, and its hue.
       *  DESIGN.md's palette starts with "sodium-lamp amber". */
      aerialNightGlow: 0.055,
      aerialNightTint: [1.0, 0.52, 0.22],
      /**
       * What fraction of the sky in-scatter sample survives after dark. The
       * dome does not go black at night — it keeps a bright, almost perfectly
       * achromatic band at the horizon — and the horizon bias aims the sample
       * right at it, so distance came back as a flat grey wall rather than as
       * a city seen against its own glow. 0.30 keeps enough of the real dome
       * for the haze to still agree with the sky it is standing in front of.
       */
      aerialNightSkyGain: 0.30,
      /** Trim on the haze hue. Cool, because Steel City is not Los Santos:
       *  it is a wet grey-brown river valley, not a warm basin. */
      aerialTint: [0.94, 0.99, 1.09],
    };

    /**
     * `?owSet=aoRadius:2.4,aoIntensity:1.35` — override any numeric entry in
     * `settings` from the URL, before the first frame.
     *
     * This exists because the whole AO block above was tuned blind. Every one
     * of `aoRadius`, `aoIntensity`, `aoBias` and `aoFloor` was last edited
     * while GTAO emitted 1.0 for every pixel (see gtao.js), so a sweep was the
     * only honest way to pick them — and a sweep needs one build, one browser
     * session and N captures, not N edits and N rebuilds. It is also what
     * makes the negative controls below cheap: `?owSet=aoIntensity:1.1` is the
     * pre-calibration arm of any A/B, in the SAME build as the calibrated one.
     *
     * Deliberately numbers only, and deliberately keys that already exist —
     * it can retune the renderer but it cannot invent a setting or smuggle in
     * a string, and nothing in the game reads it.
     */
    const owSet = new URLSearchParams(location.search).get('owSet');
    if (owSet) {
      for (const pair of owSet.split(',')) {
        const [k, v] = pair.split(':');
        const n = Number(v);
        if (typeof this.settings[k] === 'number' && Number.isFinite(n)) {
          this.settings[k] = n;
          console.info(`[render] owSet ${k} = ${n}`);
        } else {
          console.warn(`[render] owSet ignored "${pair}"`);
        }
      }
    }

    // Parsed BEFORE `_applySettings`, because two of them are read by it. See
    // the block below `debugView` for what each one restores.
    this._noSkySH = /[?&]owNoSkySH=1/.test(location.search);
    this._noAoFix = /[?&]owNoAoFix=1/.test(location.search);
    this._noAoReach = /[?&]owNoAoReach=1/.test(location.search);
    this._noEmissiveSpill = /[?&]owNoEmissiveSpill=1/.test(location.search);

    this._applySettings();

    this.probe = new RenderProbeScene(this.rng.fork());
    this.probeActive = false;
    // In capture mode print the metering chain so a bad exposure is obvious
    // in the harness log rather than something to guess at from the PNG.
    this._probeExposure = ctx.config.deterministic === true;
    this.debugView = new URLSearchParams(location.search).get('rview') || null;
    this._debugPass = null;

    // `?owNoCascadeCull=1` puts every caster back into every cascade. Kept as
    // the A/B switch the pixel gate was run through, and the escape hatch if a
    // subsystem ever ships geometry whose bounds lie about where it is.
    this._noCascadeCull = /[?&]owNoCascadeCull=1/.test(location.search);

    // ---- negative controls for the indirect-lighting work -------------------
    // Both restore the exact previous behaviour of one half of it, in the SAME
    // build and the SAME browser session, which is the only way to A/B a
    // lighting change on a tree that is still moving under it.
    //
    // `?owNoSkySH=1`  ignore the sky irradiance probe and fall back to a
    //                 uniform hemisphere of the published ambient hue — i.e.
    //                 the two-band model this replaced.
    // `?owNoAoFix=1`  put GTAO's early-out distance back to the zero it was
    //                 silently running at, so the AO buffer returns to white.
    //                 Proves the AO measurements are measuring the fix.
    // `?owNoAoReach=1` put GTAO's march radius ceiling back to the hardcoded
    //                 128 px, which capped the delivered radius at depth/8.1 m
    //                 for everything nearer than 21 m — i.e. discarded
    //                 `aoRadius` over the whole foreground. See gtao.js.
    // `?owNoEmissiveSpill=1` restore bloomThreshold 1.55 / bloomStrength 0.34,
    //                 i.e. the highlight-only pyramid that left a lit window's
    //                 own mullion at 4,8,18. Both halves at once, on purpose.
    //
    // (Assigned above, before `_applySettings`, which reads two of them.)
    this._visit = this._visit.bind(this);
    this._visitView = this._visitView.bind(this);

    const w = ctx.canvas.clientWidth || 1920;
    const h = ctx.canvas.clientHeight || 1080;
    this._syncCameraRange(ctx.camera);
    this.resize(w, h, ctx);

    console.info(
      `[render] WebGL2 · ${cfg.quality} · ${this.csm.cascades}x${this.csm.mapSize} CSM ` +
        `to ${q.shadowDistance}m · far ${q.drawDistance}m · ` +
        `${this.reversedZ ? 'reversed-Z f32 depth' : 'NO reversed-Z (EXT_clip_control missing)'} · ` +
        `taa:${!!this.taa} gtao:${!!this.gtao} ssr:${!!this.ssr} mb:${!!this.motionBlur} ` +
        `lightSlots:${q.lightSlots}`
    );
  }

  /**
   * Own the camera's depth RANGE (not its pose or its FOV — `player` owns
   * those). The far plane is `q.drawDistance`, because a downtown skyline four
   * kilometres away is the whole point of the genre, and the near plane is
   * raised off the engine's 0.05 m default.
   *
   * The near plane matters even with reversed-Z: not for the depth buffer,
   * which no longer cares, but because the CSM's split distribution, the GTAO
   * radius and the SSR step scale are all derived from it, and 5 cm is a
   * distance nothing in a third-person game is ever rendered at. 0.1 m keeps a
   * bumper or a doorframe out of the near plane and costs nothing.
   *
   * Re-applied every frame: another subsystem may legitimately rewrite the
   * projection (FOV kick, ADS, a cutscene lens) and would otherwise drop the
   * far plane back to whatever it assumed.
   */
  _syncCameraRange(camera) {
    const far = this.q.drawDistance ?? 1200;
    const near = Math.max(0.1, Math.min(0.25, far * 1e-5));
    if (camera.far === far && camera.near === near) return;
    camera.far = far;
    camera.near = near;
    camera.updateProjectionMatrix();
  }

  // ==========================================================================
  //  public API (see ARCHITECTURE.md "Render integration")
  // ==========================================================================

  /**
   * Insert a custom post pass.
   * `pass.render(renderer, inputTexture, outputTarget, renderSystem)` must
   * write a full-screen result into `outputTarget`.
   * `pass.order` (default 0) controls ordering; `pass.enabled !== false`.
   *
   * A PASS MUST DRAW ITS FULL-SCREEN QUAD WITH AN `OrthographicCamera`, NEVER A
   * BARE `new THREE.Camera()`. This renderer runs with reversed-Z (see init),
   * and three's `setProgram` adopts every camera into the reversed convention
   * the first time it draws with it by calling `camera.updateProjectionMatrix()`
   * — a method the base `Camera` class does not have. The resulting TypeError is
   * thrown inside `renderer.render()`, which aborts the whole composite, not
   * just that pass. Use `new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)`, or
   * simply use `Pass` from `src/render/pass.js`, which already does.
   *
   * A pass that throws is caught, logged once and DISABLED for the rest of the
   * session rather than being allowed to take the frame down with it.
   */
  registerPass(pass) {
    this.passes.push(pass);
    this.passes.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (pass.resize) pass.resize(this.screenSize.width, this.screenSize.height);
    return () => {
      const i = this.passes.indexOf(pass);
      if (i >= 0) this.passes.splice(i, 1);
    };
  }

  /**
   * Register a punctual light the CALLER owns and has already added to the
   * scene, so it participates in distance fading and the practicals trim.
   *
   * This never toggles `light.visible` — see `_cullLights`. Prefer
   * `submitLight()` for anything there can be more than a handful of.
   */
  addLight(light, opts = {}) {
    if (!light || this.lights.some((l) => l.light === light)) return light;
    this.lights.push({
      light,
      range: opts.range ?? light.distance ?? 25,
      priority: opts.priority ?? 1,
      baseIntensity: light.intensity,
    });
    return light;
  }

  removeLight(light) {
    const i = this.lights.findIndex((l) => l.light === light);
    if (i >= 0) this.lights.splice(i, 1);
  }

  /**
   * Ask for one of the renderer's `q.lightSlots` real punctual lights, THIS
   * FRAME. Call it every frame you want the light; there is no handle to
   * release and nothing to clean up.
   *
   * This is the only safe way to have thousands of candidate lights in a city.
   * The renderer scores every submission and copies the best `lightSlots` of
   * them into a pool of point lights whose count never changes, so no
   * submission can ever trigger a shader recompile no matter how the camera
   * moves. A light that loses its slot fades out over ~0.15 s instead of
   * popping, and one that wins a slot fades in, so the swap is invisible.
   *
   *   const r = ctx.get('render');
   *   for (const lamp of nearbyLamps) {
   *     r.submitLight(lamp.x, lamp.y, lamp.z, lamp.color, 40, 18, 1);
   *   }
   *   r.submitLight(mx, my, mz, FLASH, 900, 25, 8);   // muzzle flash wins
   *
   * @param {number} x world position
   * @param {number} y
   * @param {number} z
   * @param {THREE.Color|number} color
   * @param {number} intensity  candela-ish; three's physical point light units
   * @param {number} range      metres at which it is fully cut off
   * @param {number} [priority] 0..10. Higher always beats nearer. Muzzle flash
   *                            and headlights should outrank street practicals.
   * @param {number} [key]      stable id for this emitter, so the fade in/out
   *                            can follow it across frames. Defaults to a hash
   *                            of the position, which is enough for static
   *                            lamps and fine for anything that moves slowly.
   */
  submitLight(x, y, z, color, intensity, range = 20, priority = 1, key = -1) {
    if (this.lightSlots === 0 || !(intensity > 0)) return;
    if (this._nReq >= this._req.length) {
      this._reqOverflow++;
      return;
    }
    // Reject before scoring: outside its own range it contributes nothing.
    const dx = x - this._camPos.x;
    const dy = y - this._camPos.y;
    const dz = z - this._camPos.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    const cut = range + 6;
    if (d2 > cut * cut) return;

    const e = this._req[this._nReq++];
    e.x = x;
    e.y = y;
    e.z = z;
    if (typeof color === 'number') {
      e.r = ((color >> 16) & 255) / 255;
      e.g = ((color >> 8) & 255) / 255;
      e.b = (color & 255) / 255;
    } else if (color) {
      e.r = color.r;
      e.g = color.g;
      e.b = color.b;
    } else {
      e.r = e.g = e.b = 1;
    }
    e.intensity = intensity;
    e.range = range;
    e.priority = priority;
    e.key = key >= 0 ? key : (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0) >>> 1;
    // Priority dominates; within a priority band, screen-relevant illumination
    // wins. Inverse-square on the intensity is what makes a bright headlight
    // 40 m out beat a dim porch bulb 8 m out, which is the correct answer.
    e.score = priority * 1e6 + intensity / (1 + d2 * 0.02);
  }

  /** Diagnostics: how the light slots were spent last frame. */
  get lightBudget() {
    return {
      slots: this.lightSlots,
      submitted: this._nReqLast ?? 0,
      overflow: this._reqOverflow,
    };
  }

  /**
   * Per-frame visibility statistics. `world` and the profiler both want this;
   * it is the fastest way to tell "the city is slow" from "the city is being
   * drawn twice".
   */
  get stats() {
    const c = this.culler.stats;
    return {
      draw: this._nDraw,
      hidden: this._nHide,
      cullGroups: c.groups,
      cullVisible: c.groupsVisible,
      cullFrustum: c.groupsCulledFrustum,
      cullDistance: c.groupsCulledDistance,
      lods: c.lods,
      cascadeCasters: Array.from(this.csm.casterCounts),
      lightSlots: this.lightSlots,
      lightsSubmitted: this._nReqLast ?? 0,
      pointLightCount: this._lightCountLock,
      pointLightRaises: this._lightCountRaises,
      drawDistance: this.q.drawDistance,
      shadowDistance: this.q.shadowDistance,
      reversedZ: this.reversedZ,
    };
  }

  /**
   * Register a hierarchical cull node — in practice, the root Object3D of one
   * streamed tile. One bounding-sphere test then decides the whole subtree, so
   * the per-frame scene walk stops being O(everything in the city).
   *
   * `world`, `buildings` and `props` should call this from their
   * `world:tile:load` handler and call the returned function on
   * `world:tile:unload`.
   *
   *   const off = ctx.get('render').registerCullGroup(tileRoot, {
   *     center: [cx, cy, cz], radius: tileRadius,
   *   });
   *
   * @returns {() => void} unregister
   */
  registerCullGroup(object, opts) {
    return this.culler.add(object, opts);
  }

  /** Drop a cull group without keeping its unregister function around. */
  unregisterCullGroup(object) {
    this.culler.remove(object);
  }

  /** The PMREM environment currently in use. */
  requestEnvMap() {
    return this.ctx?.scene.environment ?? this.envMap;
  }

  /** Let the sky subsystem hand us its PMREM. */
  setEnvMap(texture) {
    this.ctx.scene.environment = texture;
    this.ctx.viewScene.environment = texture;
    this.envMap = texture;
  }

  /** Force every lit material in a subtree to be patched immediately. */
  patchMaterials(root) {
    root.traverse((o) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) for (const mm of m) this.patcher.patch(mm);
      else this.patcher.patch(m);
    });
  }

  /**
   * Patch exactly the set of materials the frame loop's own scene walk would
   * patch, and no more.
   *
   * `patchMaterials()` is the public, deliberately-broad version: it reaches
   * every material in a subtree. That is the wrong tool for pre-compiling,
   * because injecting the shadow/AO/fill chunk into a material the frame loop
   * never patches CHANGES HOW THAT MATERIAL SHADES — measured at 0.04% of
   * pixels, up to 26/255, when this used `traverse()`. Mirroring `_visit` /
   * `_visitView` exactly (same traversal, same object-type predicate) makes
   * pre-patching a pure reordering of *when* the identical set is patched.
   */
  _patchLikeFrame(root, isViewScene) {
    root.traverseVisible((o) => {
      if (isViewScene) {
        if (o.isMesh !== true) return;
      } else if (
        o.isMesh !== true &&
        o.isPoints !== true &&
        o.isSprite !== true &&
        o.isLine !== true
      ) {
        return;
      }
      const m = o.material;
      if (Array.isArray(m)) for (let i = 0; i < m.length; i++) this.patcher.patch(m[i]);
      else if (m) this.patcher.patch(m);
    });
  }

  setExposureBias(ev) {
    this.settings.exposureBias = ev;
  }

  /**
   * Compile every program this subsystem can reach, without drawing a gameplay
   * frame. Call it from the loading screen (src/core/prewarm.js).
   *
   * WHY THE ENGINE'S OWN PRE-WARM IS NOT ENOUGH — measured, not guessed.
   * `renderer.compileAsync(scene, camera)` only reaches the *forward lit*
   * program of each material. It does not reach:
   *
   *   - the CSM depth variant of a material (skinned / morphed / instanced /
   *     batched are four separate programs off one ShaderMaterial),
   *   - the MRT prepass variant, same four,
   *   - a single one of the ~25 full-screen post programs, because those are
   *     not in any scene graph.
   *
   * Those are exactly the ones that used to land mid-play: profiling showed up
   * to 30 programs compiling on ONE frame, and that frame took 3.1-3.9 s on a
   * cold shader cache.
   *
   * NOTHING HERE ADVANCES THE SIMULATION. It never calls `engine.step()`, never
   * touches `time`, `rng`, the TAA history, the exposure adaptation buffers,
   * the velocity history or `this.frame`. It draws into the shadow array, the
   * gbuffer and a 4x4 scratch target — all three of which the next real frame
   * overwrites in full before anything reads them — so it is invisible to the
   * pixel-diff gate.
   *
   * PIXEL GATE, measured with tools/baseline.mjs at 1920x1080 on all 11 shots:
   * the patch + `compileAsync` step and the post-chain step are bit-identical.
   * The depth/shadow step is NOT, when it is called after frames have already
   * been drawn: on the `night` shot it moves 26 pixels by 2/255, which survives
   * snapshotting and restoring the whole cascade fit and the sun takeover, so
   * the residue is in the shadow-array / gbuffer contents themselves. It is
   * therefore only ON by default at `frame === 0` — before a single frame has
   * been drawn there is no cascade fit, no gbuffer and no shadow array to
   * disturb — and has to be asked for explicitly at any other time.
   *
   * @param {object}  [opts]
   * @param {boolean} [opts.post=true]   compile the full-screen pass chain
   * @param {boolean} [opts.shadow]      compile the CSM depth + prepass variants;
   *                                     defaults to true only before frame 1
   * @returns {Promise<object>} { ok, ms, programsBefore, programsAfter, compiled }
   */
  async prewarmMaterials({ post = true, shadow = this.frame === 0 } = {}) {
    const t0 = performance.now();
    const renderer = this.renderer;
    const ctx = this.ctx;
    if (!renderer || !ctx) return { ok: false, reason: 'not initialised' };
    const programsBefore = renderer.info.programs?.length ?? 0;
    const prevTarget = renderer.getRenderTarget();

    try {
      // 1. Patch first, ALWAYS. A program compiled off an unpatched material is
      //    thrown away by the first frame that walks the scene (see the
      //    renderer.compile wrapper in init) — pure waste of the boot budget.
      this._patchLikeFrame(ctx.scene, false);
      this._patchLikeFrame(ctx.viewScene, true);

      // 2. Forward lit programs. compileAsync uses KHR_parallel_shader_compile
      //    where the driver has it, so this does not block the main thread.
      try {
        await renderer.compileAsync(ctx.scene, ctx.camera);
        await renderer.compileAsync(ctx.viewScene, ctx.viewCamera);
      } catch {
        renderer.compile(ctx.scene, ctx.camera);
        renderer.compile(ctx.viewScene, ctx.viewCamera);
      }

      // 3. Depth-only variants. There is no compile-time API for an override
      //    material, so the only way to reach them is to actually run the two
      //    depth passes once — which is cheap, writes only to buffers the next
      //    frame clears, and advances nothing.
      if (shadow) {
        const camera = ctx.camera;
        camera.updateMatrixWorld();
        // The hierarchical cull runs inside _collect and needs a real camera
        // basis, or it would hide every registered tile and the pre-warm would
        // compile the depth variants of nothing.
        this._camPos.setFromMatrixPosition(camera.matrixWorld);
        this._currVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this._collect(ctx.scene, camera);
        this._syncSun(camera);
        const bg = ctx.scene.background;
        // Fitting the cascades out of frame is not free: `update()` leaves a fit
        // behind and the next frame's refit does not fully overwrite it (see
        // CascadedShadowMaps.snapshotFit — measured at 1.3 M pixels, up to
        // 26/255). Take the fit, use it, hand it straight back.
        const fit = this.csm.snapshotFit();
        // ...and the same for the sun takeover `_syncSun` performs, so a prewarm
        // cannot hand the next frame a different active sun / fallback state
        // than the one it would have computed for itself.
        const sunSave = {
          dir: this.sunDir.clone(),
          dirView: this.sunDirView.clone(),
          active: this.activeSun,
          fallbackVisible: this.sun.visible,
          ambLevel: this._ambLevel,
        };
        ctx.scene.background = null;
        this._hideList(this._shadowHide, this._nShadowHide);
        this.csm.update(camera, this.sunDir, this.settings.sunSoftness);
        this.csm.render(renderer, ctx.scene, this._casters, this._nCasters);
        this._showList(this._shadowHide, this._nShadowHide);
        this._hideList(this._hide, this._nHide);
        this.gbuffer.render(
          renderer,
          ctx.scene,
          camera,
          this._currVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
          this._currVP,
          true
        );
        this._showList(this._hide, this._nHide);
        ctx.scene.background = bg;
        this.csm.restoreFit(fit);
        this.sunDir.copy(sunSave.dir);
        this.sunDirView.copy(sunSave.dirView);
        this.activeSun = sunSave.active;
        this.sun.visible = sunSave.fallbackVisible;
        this._ambLevel = sunSave.ambLevel;
      }

      // 4. The post chain. A pass's program does not depend on the size of what
      //    it is drawn into, so a 4x4 scratch target compiles it for free.
      if (post) {
        const scratch = hdrTarget(4, 4, { name: 'prewarm-scratch' });
        const mats = [];
        this._collectPassMaterials(mats);
        for (const m of mats) {
          try {
            blit(renderer, m, scratch);
          } catch {
            /* a pass with an unsatisfiable uniform must not stop the rest */
          }
        }
        scratch.dispose();
      }
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    } finally {
      renderer.setRenderTarget(prevTarget);
    }

    const programsAfter = renderer.info.programs?.length ?? 0;
    return {
      ok: true,
      ms: Math.round(performance.now() - t0),
      programsBefore,
      programsAfter,
      compiled: programsAfter - programsBefore,
      parallel: !!renderer.getContext().getExtension('KHR_parallel_shader_compile'),
    };
  }

  /** Every full-screen material this subsystem owns, for prewarmMaterials(). */
  _collectPassMaterials(out) {
    const add = (p) => {
      if (p && p.material) out.push(p.material);
    };
    add(this.composite);
    add(this.viewComposite);
    add(this.fxaa);
    if (this.gtao) {
      add(this.gtao.core);
      add(this.gtao.temporal);
      add(this.gtao.blur);
    }
    if (this.contact) {
      add(this.contact.pass);
      add(this.contact.blur);
    }
    if (this.ssr) {
      add(this.ssr.pass);
      add(this.ssr.blur);
    }
    if (this.taa) add(this.taa.pass);
    if (this.motionBlur) {
      add(this.motionBlur.tilePass);
      add(this.motionBlur.blurPass);
    }
    if (this.dof) {
      add(this.dof.pre);
      add(this.dof.gather);
      add(this.dof.combine);
    }
    if (this.bloom) {
      add(this.bloom.down);
      add(this.bloom.up);
    }
    if (this.aerial) add(this.aerial.pass);
    add(this.exposure.logPass);
    add(this.exposure.reducePass);
    add(this.exposure.adaptPass);
    return out;
  }

  get hdrTexture() {
    return this.hdrRt?.texture ?? null;
  }

  /**
   * Read back a block of the pre-post HDR buffer, in SCENE RADIANCE UNITS
   * (i.e. before exposure). Diagnostic only — this stalls the pipeline, so it
   * is never called from a frame. Coordinates are fractions of the screen.
   *
   * This exists because every tone/lighting argument in this subsystem is an
   * argument about *ratios of scene radiance* — key:fill, sky:sunlit-wall,
   * interior:exterior — and reading them off a graded PNG means inverting the
   * tone curve by hand and getting it wrong.
   */
  probeHdr(u0, v0, u1, v1) {
    const rt = this.hdrRt;
    if (!rt) return null;
    const W = this.screenSize.width;
    const H = this.screenSize.height;
    const x = Math.max(0, Math.round(u0 * W));
    // GL origin is bottom-left; screen v is top-down.
    const y = Math.max(0, Math.round((1 - v1) * H));
    const w = Math.max(1, Math.min(W - x, Math.round((u1 - u0) * W)));
    const h = Math.max(1, Math.min(H - y, Math.round((v1 - v0) * H)));
    const half = rt.texture.type === THREE.HalfFloatType;
    const buf = half ? new Uint16Array(w * h * 4) : new Float32Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, x, y, w, h, buf);
    const dec = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
    let r = 0;
    let g = 0;
    let b = 0;
    let mx = 0;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const cr = dec(buf[i * 4]);
      const cg = dec(buf[i * 4 + 1]);
      const cb = dec(buf[i * 4 + 2]);
      r += cr;
      g += cg;
      b += cb;
      mx = Math.max(mx, cr, cg, cb);
    }
    return { r: r / n, g: g / n, b: b / n, max: mx, n };
  }

  /** Whole HDR buffer box-downsampled to cols x rows, row 0 = top. Diagnostic. */
  probeHdrGrid(cols = 32, rows = 18) {
    const rt = this.hdrRt;
    if (!rt) return null;
    const W = this.screenSize.width;
    const H = this.screenSize.height;
    const half = rt.texture.type === THREE.HalfFloatType;
    const buf = half ? new Uint16Array(W * H * 4) : new Float32Array(W * H * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    const dec = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
    const out = new Float32Array(cols * rows * 3);
    const cnt = new Float32Array(cols * rows);
    for (let y = 0; y < H; y++) {
      const gy = Math.min(rows - 1, Math.floor(((H - 1 - y) / H) * rows));
      for (let x = 0; x < W; x++) {
        const gx = Math.min(cols - 1, Math.floor((x / W) * cols));
        const s = (y * W + x) * 4;
        const d = (gy * cols + gx) * 3;
        out[d] += dec(buf[s]);
        out[d + 1] += dec(buf[s + 1]);
        out[d + 2] += dec(buf[s + 2]);
        cnt[gy * cols + gx]++;
      }
    }
    const res = [];
    for (let i = 0; i < cols * rows; i++) {
      const c = Math.max(1, cnt[i]);
      res.push([out[i * 3] / c, out[i * 3 + 1] / c, out[i * 3 + 2] / c]);
    }
    return { cols, rows, cells: res };
  }

  _applySettings() {
    const s = this.settings;
    const cu = this.composite.uniforms;
    // The negative control restores BOTH halves of the emissive-spill change
    // at once — a skirt is its threshold and its gain together, and an A/B
    // that reverted one of them would be measuring neither.
    this._bloomGain = this._noEmissiveSpill ? 0.34 : s.bloomStrength;
    cu.uLens.value.set(s.chromatic, s.vignette, s.grain, 0);
    cu.uGrade.value.set(this._bloomGain, s.lutStrength, this.taa ? s.sharpen : 0, this.lut.size);
    this.csm.setStrength(s.shadowStrength);
    if (this.bloom) {
      this.bloom.threshold = this._noEmissiveSpill ? 1.55 : s.bloomThreshold;
      this.bloom.knee = s.bloomKnee;
    }
    if (this.gtao) {
      this.gtao.setRadius(s.aoRadius);
      this.gtao.setIntensity(s.aoIntensity);
      this.gtao.setBias(s.aoBias);
      this.gtao.reachFraction = s.aoReach;
    }
    this.patcher.uniforms.owAoStrength.value.z = s.aoFloor;
    if (this.contact) {
      this.contact.setLength(s.contactLength);
      this.contact.setStrength(s.contactStrength);
    }
  }

  // ==========================================================================
  //  sizing
  // ==========================================================================

  resize(w, h, ctx) {
    const pr = Math.min(globalThis.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);

    const dw = Math.max(1, Math.floor(w * pr));
    const dh = Math.max(1, Math.floor(h * pr));
    const rw = Math.max(1, Math.floor(dw * this.q.renderScale));
    const rh = Math.max(1, Math.floor(dh * this.q.renderScale));

    this.displaySize.width = dw;
    this.displaySize.height = dh;
    if (this.screenSize.width === rw && this.screenSize.height === rh && this.hdrRt) return;
    this.screenSize.width = rw;
    this.screenSize.height = rh;

    this.hdrRt?.dispose();
    this.hdrRt = hdrTarget(rw, rh, {
      depthBuffer: true,
      // Float depth: the other half of reversed-Z. Without it the reversal is
      // a no-op and the skyline z-fights. See the note in init().
      floatDepth: this.reversedZ,
      name: 'hdr',
    });
    // The viewmodel gets its own colour+depth buffer with 4x MSAA, cleared to
    // TRANSPARENT black so the composite has real coverage to work with.
    this.viewRt?.dispose();
    this.viewRt = hdrTarget(rw, rh, {
      depthBuffer: true,
      samples: this._viewSamples,
      name: 'viewmodel',
    });
    this.pingRt[0]?.dispose();
    this.pingRt[1]?.dispose();
    this.pingRt[0] = hdrTarget(rw, rh, { name: 'ping0' });
    this.pingRt[1] = hdrTarget(rw, rh, { name: 'ping1' });
    // Only the no-TAA path composites through an LDR intermediate; with TAA on,
    // `fxaa` is null and this was a full-resolution RGBA8 target (13 MB at 3.34
    // MP) allocated on every resize and never sampled once.
    this.ldrRt?.dispose();
    this.ldrRt = null;
    if (this.fxaa) this.ldrRt = new THREE.WebGLRenderTarget(rw, rh, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    this.gbuffer.setSize(rw, rh, this.reversedZ);
    this.gtao?.setSize(rw, rh);
    this.contact?.setSize(rw, rh);
    this.ssr?.setSize(rw, rh);
    this.taa?.setSize(rw, rh);
    this.motionBlur?.setSize(rw, rh);
    this.dof?.setSize(rw, rh);
    this.bloom?.setSize(rw, rh);

    this.patcher.setScreenSize(rw, rh);
    this.viewComposite.uniforms.uTexel.value.set(1 / rw, 1 / rh);
    this.composite.uniforms.uTexel.value.set(1 / rw, 1 / rh);
    this.composite.uniforms.uResolution.value.set(rw, rh);
    if (this.fxaa) this.fxaa.uniforms.uTexel.value.set(1 / rw, 1 / rh);

    this.depthTexture = this.gbuffer.depthTexture;
    this.velocityTexture = this.gbuffer.velocityTexture;
    this.normalTexture = this.gbuffer.normalTexture;

    for (const p of this.passes) p.resize?.(rw, rh);
    this.taa?.reset();
    this.exposure.reset();
  }

  // ==========================================================================
  //  scene walk
  // ==========================================================================

  /**
   * Does this transparent material still occlude enough to belong in the
   * cascades?
   *
   * `alphaTest > 0` is a CUTOUT — a chain-link fence, a leaf card, a grille.
   * Wherever it passes the test it is fully opaque, and the cascade depth
   * material honours that (see csm.js). Those objects are half the shadow
   * detail in a street.
   *
   * `opacity > 0.75` covers the tarpaulin/awning case: alpha-blended for a
   * little translucency at the edges, but optically a solid sheet, and the
   * thing that decides whether the crates under a market canopy are in shade.
   */
  static _castsShadow(m) {
    return m.alphaTest > 0 || (m.opacity ?? 1) > 0.75;
  }

  _visit(o) {
    // LOD nodes are resolved DURING the walk, and it works because
    // `traverseVisible` invokes the callback on a node before it recurses into
    // that node's children: the level we pick here is the one the walk then
    // descends into, and `autoUpdate = false` stops the renderer picking a
    // different (unbiased) one a moment later. See SceneCuller.updateLod.
    if (o.isLOD === true) {
      this.culler.updateLod(o);
      return;
    }
    if (o.isMesh === true || o.isPoints === true || o.isSprite === true || o.isLine === true) {
      const mat = o.material;
      let transparent = false;
      let casts = o.isMesh === true;
      if (Array.isArray(mat)) {
        for (let i = 0; i < mat.length; i++) {
          this.patcher.patch(mat[i]);
          if (mat[i] && mat[i].transparent === true) transparent = true;
        }
        if (transparent && !mat.some((m) => m && RenderSystem._castsShadow(m))) casts = false;
      } else if (mat) {
        this.patcher.patch(mat);
        transparent = mat.transparent === true;
        if (transparent && !RenderSystem._castsShadow(mat)) casts = false;
      }

      if (o.isMesh !== true) transparent = true;
      if (o.userData.owProbe !== true) this._foreignMeshes++;

      const ud = o.userData;
      if (ud.owNoShadow === true) casts = false;

      // Two INDEPENDENT classifications. They used to be one, and that single
      // conflation is what the critic found: "cables, stall posts and awnings
      // cast nothing, so boxes directly under a canopy are as bright as open
      // sand". A material was excluded from the depth/normal prepass for being
      // transparent, and the prepass list was ALSO used as the shadow-caster
      // list — so every alpha-tested fence, every tarpaulin, every wire and
      // every leaf silently stopped casting. Those are exactly the objects that
      // produce a dappled, busy shadow.
      //
      //   prepass  — needs opaque depth. Alpha-blended geometry genuinely
      //              cannot participate; it has no single depth.
      //   shadow   — needs occlusion. An alpha-TESTED cutout occludes
      //              completely wherever it passes the test, and a 90%-opaque
      //              awning occludes for all practical purposes.
      if (transparent || ud.owNoPrepass === true) this._hide[this._nHide++] = o;
      else this._draw[this._nDraw++] = o;

      if (casts) this._casters[this._nCasters++] = o;
      else this._shadowHide[this._nShadowHide++] = o;
    } else if (o.isDirectionalLight === true) {
      this._dirLights[this._nDirLights++] = o;
    } else if (o.isPointLight === true) {
      // Counted here rather than by a `scene.traverse` of its own, and the count
      // is exact rather than approximate: this walk is `traverseVisible` over
      // the same scene three's `projectObject` is about to walk, and it skips
      // an invisible subtree for the same reason three does. Our own ballast is
      // excluded so `_enforceLightCount` is not chasing its own tail.
      if (o.userData.owRenderBallast !== true) this._nPointLights++;
    }
  }

  /**
   * The per-frame scene walk.
   *
   * Order matters and is the whole scaling story: the hierarchical cull runs
   * FIRST and hides whole streamed tiles, so `traverseVisible` never descends
   * into them at all. A tile that is behind the camera or past the draw
   * distance costs four dot products instead of a subtree walk plus one
   * frustum test per object inside it.
   */
  _collect(scene, camera) {
    this._nDraw = 0;
    this._nHide = 0;
    this._nCasters = 0;
    this._nShadowHide = 0;
    this._nDirLights = 0;
    this._foreignMeshes = 0;
    this._nPointLights = 0;
    if (camera !== undefined) {
      this.culler.begin(
        camera,
        this._currVP,
        this.q.drawDistance ?? 1200,
        this.q.lodBias ?? 1,
        this.screenSize.height
      );
      this.culler.update();
    }
    scene.traverseVisible(this._visit);
  }

  _hideList(list, n) {
    for (let i = 0; i < n; i++) list[i].visible = false;
  }
  _showList(list, n) {
    for (let i = 0; i < n; i++) list[i].visible = true;
  }

  _dirFromLight(light, out) {
    light.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(light.matrixWorld);
    if (light.target) {
      light.target.updateWorldMatrix(true, false);
      this._tmpV3b.setFromMatrixPosition(light.target.matrixWorld);
      out.sub(this._tmpV3b);
    }
    if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
    return out.normalize();
  }

  /**
   * Pick whichever directional light is acting as the sun and take it over.
   *
   * Also the frame's NaN firewall. A single non-finite `intensity` on a
   * directional light multiplies into `directionalLights[i].color`, which every
   * lit material reads, so ONE bad number anywhere in the engine turns EVERY
   * lit pixel in the HDR buffer into NaN — the tone map clamps NaN to zero and
   * the whole screen goes black with no error, no warning and nothing in the
   * frame to say where it came from. (Observed: the sky's key light briefly
   * published NaN and took the entire game down with it.) Eleven subsystems
   * write light intensities in parallel; the renderer is the single point they
   * all pass through, so it is the right place to catch this, name the light
   * and keep drawing.
   */
  _syncSun(camera) {
    let best = null;
    let bestI = -1;
    for (let i = 0; i < this._nDirLights; i++) {
      const l = this._dirLights[i];
      if (!(l.intensity >= 0) && l.intensity !== 0) {
        this._reportBadLight(l);
        l.intensity = 0;
      }
      if (l === this.sun) continue;
      if (l.intensity > bestI) {
        best = l;
        bestI = l.intensity;
      }
    }

    if (best && bestI > 0.01) {
      // Somebody else (the sky) owns the sun now: drop ours and take over its
      // shadowing, because three's single-frustum shadow map cannot compete
      // with cascades.
      if (this.sun.visible) this.sun.visible = false;
      if (best.castShadow) best.castShadow = false;
      this.activeSun = best;
    } else {
      this.sun.visible = true;
      this.activeSun = this.sun;
    }

    this._dirFromLight(this.activeSun, this.sunDir);
    this.sunDirView.copy(this.sunDir).transformDirection(camera.matrixWorldInverse).normalize();
  }

  /**
   * Point the viewmodel's 3-point rig. Directions are authored in VIEW space
   * and rotated into the viewmodel scene every frame, so the weapon's key/fill/
   * rim separation is invariant to where the world sun happens to be.
   */
  _updateViewRig(viewCamera) {
    const s = this.settings;
    // Reference light level for the rig. It has to include the ambient, not just
    // the key: at night the key IS the moon at 0.075, and a rig with an absolute
    // floor would put a glowing white rifle in a moonlit street. Everything in
    // the rig — hemisphere included — is a ratio of this, so autoexposure keeps
    // the weapon at a constant relative brightness at every time of day.
    const ref = Math.max(this.activeSun.intensity, this._ambLevel / 0.15);
    // Sub-linear in the scene level: the meter is exposure-locked after dark, so
    // a rig that tracked the light exactly would put the weapon back in
    // silhouette at night. Every shipped shooter biases the viewmodel up in the
    // dark; gamma 0.65 is that bias, and it is a no-op in full daylight.
    const shaped = REF_DAYLIGHT * Math.pow(Math.min(ref / REF_DAYLIGHT, 1), s.viewKeyGamma);
    const keyI = Math.min(shaped * s.viewKeyScale, s.viewKeyMax);
    this.viewSun.color.copy(this.activeSun.color);
    this.viewSun.intensity = keyI;

    // Fill takes the cool sky hue, rim the warm key hue, so the gun sits in the
    // same light as the street rather than looking like a studio render.
    const h = this._fillHue;
    this.viewKeyFill.color.setRGB(h.x, h.y, h.z);
    this.viewKeyFill.intensity = keyI * s.viewFillRatio;
    const sc = this.activeSun.color;
    this.viewRim.color.setRGB(sc.r, sc.g * 0.94, sc.b * 0.82);
    this.viewRim.intensity = keyI * s.viewRimRatio;
    this.viewFill.intensity = keyI * s.viewHemiRatio;

    // Warm bounce takes the ground-bounce hue the world's own lower fill band
    // uses (_updateBounceFill writes it into _fillHue2), so the gun and gloves
    // pick up the same sand-off-the-street colour the buildings do.
    const g = this._fillHue2;
    if (Math.max(g.x, g.y, g.z) > 1e-5) {
      this.viewBounce.color.setRGB(g.x, g.y * 0.86, g.z * 0.62);
    }
    this.viewBounce.intensity = keyI * s.viewBounceRatio;

    this._placeViewLight(this.viewSun, this._viewKeyDir, viewCamera);
    this._placeViewLight(this.viewKeyFill, this._viewFillDir, viewCamera);
    this._placeViewLight(this.viewRim, this._viewRimDir, viewCamera);
    this._placeViewLight(this.viewBounce, this._viewBounceDir, viewCamera);
  }

  _placeViewLight(light, dirView, viewCamera) {
    const d = this._tmpV3c.copy(dirView).transformDirection(viewCamera.matrixWorld);
    light.target.position.setFromMatrixPosition(viewCamera.matrixWorld);
    light.position.copy(light.target.position).addScaledVector(d, 4);
    light.updateMatrixWorld(true);
    light.target.updateMatrixWorld(true);
  }

  /**
   * Drive the two-band bounce fill from the live sky.
   *
   * The engine has exactly one indirect term — the PMREM sky cubemap — and
   * GTAO multiplies it, so a wall in shade received almost nothing. This adds
   * the two things a real street has: a cool hemisphere of skylight, and the
   * warm light the sunlit side of the street throws back at the shaded side.
   * Both are scaled off the key's intensity so they follow time of day for
   * free, and both are colour-matched to the sky's own published ambient.
   */
  _updateBounceFill() {
    const s = this.settings;
    const u = this.patcher.uniforms;
    const sunI = Math.max(0, this.activeSun.intensity);

    // Hue of the whole-sky band. `sky.ambientColor` is the sky subsystem's own
    // CPU stand-in for it; without a sky system we fall back to the key colour.
    const sky = this.ctx.peek('sky');
    const amb = sky?.ambientColor;
    const hue = this._fillHue;
    if (amb && Math.max(amb.r, amb.g, amb.b) > 1e-5) {
      hue.set(amb.r, amb.g, amb.b);
      // Published whole-sky level, ~15% of the beam. Used as the "how much light
      // is in this scene at all" reference for the viewmodel rig.
      this._ambLevel = Math.max(hue.x, hue.y, hue.z);
    } else {
      hue.set(0.36, 0.56, 1.0);
      this._ambLevel = 0.15 * sunI;
    }
    hue.divideScalar(Math.max(hue.x, hue.y, hue.z));

    // The cool band rides the sky's own published irradiance, NOT the key: at
    // night the key is a 0.05 moon and a band scaled off it is nothing, which is
    // how a night frame ends up with a fifth of its pixels under code value 12.
    // `skyFill` stays a fraction of the *beam* by construction, because the sky
    // publishes its ambient as 15% of the beam in daylight.
    const skyRef = this._ambLevel / 0.15;
    const skyLevel = s.skyFill * skyRef;
    this._buildSkySH(sky, skyLevel, hue);

    // --- the ground bounce, PER CHANNEL --------------------------------------
    // Ground exitance is albedo times the horizontal irradiance, and BOTH of
    // those are spectral. The old form took only the sun's hue, normalised it,
    // and warmed it further with a hand-tuned (0.33, 0.29, 0.225) — a desert
    // sand albedo. That is what neutralised every shaded wall in the game:
    //
    //   noon, before:  skyFill (0.137, 0.303, 0.668)   groundFill (1.115, 0.877, 0.572)
    //   a vertical surface sees half of each, i.e. (0.626, 0.590, 0.620)
    //
    // which is grey to within a percent. Sky and ground sum to 1 on a vertical
    // by construction (see materialpatch.js), so if the warm band is 1.7x the
    // cool one and equally saturated the two cancel exactly and there is no
    // skylight in the shadows at all — which is precisely the critic's
    // measurement of a cast shadow marginally WARMER than the surface casting
    // it under a clear blue sky.
    //
    // The fix is not a tint, it is doing the integral per channel:
    //
    //   E_h(c)     = sunColour(c) * beam * sin(alt)  +  skyHue(c) * skyDiffuse
    //   exitance(c)= streetAlbedo * streetTint(c) * E_h(c)
    //
    // With a near-neutral wet grey-brown street tint the warm channel no longer
    // outruns the cool one, and the term keeps every property the old one had:
    // it follows the sun down (sin(alt) -> 0 at dusk), and at blue hour it goes
    // BLUE on its own, because by then the only thing lighting the street is
    // the sky.
    const sc = this.activeSun.color;
    const sunH = sunI * Math.max(0, this.sunDir.y); // direct horizontal irradiance
    const t = s.streetTint;
    const a = s.groundAlbedo;
    const gr = a * t[0] * (sc.r * sunH + hue.x * skyLevel);
    const gg = a * t[1] * (sc.g * sunH + hue.y * skyLevel);
    const gb = a * t[2] * (sc.b * sunH + hue.z * skyLevel);
    u.owGroundFill.value.set(gr, gg, gb);
    // Normalised hue of the bounce, for the viewmodel rig.
    this._fillHue2.set(gr, gg, gb).divideScalar(Math.max(gr, gg, gb, 1e-6));

    // --- the warm wrap: light bounced off SUNLIT FACADES ---------------------
    // A separate band, not a fraction of the ground one, because the two peak
    // at opposite ends of the day. The ground bounce is proportional to
    // sin(altitude) and dies at dusk; light bounced off the vertical face of
    // the building across the street is proportional to COS(altitude) and is at
    // its strongest exactly at golden hour, when a low sun is raking every
    // west-facing wall in the city. Collapsing them into one number is why the
    // shaded side of a golden-hour street had no warm return in it at all.
    //
    // It arrives from the anti-sun hemisphere (see owSunBounce) and carries the
    // SUN's hue through a masonry albedo, so at sunset a wall looking at the
    // lit facades opposite goes warm while a wall looking at the sun's own
    // side of the street — shadowed, seeing only sky — goes blue. That
    // separation is the whole difference between a lighting model and an
    // ambient multiply.
    const cosAlt = Math.sqrt(Math.max(0, 1 - this.sunDir.y * this.sunDir.y));
    const above = THREE.MathUtils.smoothstep(this.sunDir.y, -0.09, 0.01);
    const wl = s.bounceWrap * sunI * cosAlt * above;
    const wt = s.wallTint;
    u.owWrapFill.value.set(sc.r * wt[0] * wl, sc.g * wt[1] * wl, sc.b * wt[2] * wl);
    u.owFillGain.value.set(1, 1);
    // The sky publishes an elevation-dependent indirect budget so the key:fill
    // ratio does not invert at golden hour (see SkySystem.indirectScale).
    u.owIndirect.value.x = s.iblDiffuse * (sky?.indirectScale ?? 1);
    u.owIndirect.value.y = s.interiorIndirect;
    this._skyExposureBias = sky?.exposureBias ?? 0;
  }

  /**
   * -------------------------------------------------------------------------
   * THE SKY BAND: A MEASUREMENT OF THE SKY, NOT A COLOUR STANDING IN FOR ONE
   * -------------------------------------------------------------------------
   *
   * What this replaced was a chain of guesses. `sky.ambientColor` — which the
   * sky subsystem's own comment describes as a CPU stand-in "not used for
   * lighting" — was normalised so its largest channel was 1, given a fallback
   * hue whenever it looked too grey, pulled toward Rayleigh blue at low sun,
   * and finally had its chroma pushed out by 1.55x. Four hand corrections
   * stacked on a value that was never the answer to begin with.
   *
   * MEASURED against the sky's own emitted environment map, the result was
   * wrong in both directions at once (B/R of the cosine-weighted up-facing
   * irradiance):
   *
   *   frame     old model     the actual sky
   *   hero      4.88          2.63
   *   car       4.88          2.71
   *   street    1.30          0.84    <- overcast: the real dome is WARM
   *   detail    1.30          0.82
   *
   * On a clear day every shaded surface in the city was being lit by something
   * nearly twice as blue as the sky above it, which is what "shade-side
   * surfaces crush to a saturated cobalt and the material read dies with it"
   * means in numbers. Under the overcast this game is supposed to lean into,
   * the model tinted shadows BLUE while the real dome integrates warm.
   *
   * `sky.irradiance` now projects the emitted equirect onto an order-2 SH
   * basis, which is the standard exact-to-1% representation of diffuse
   * irradiance. This routine takes shape and hue from it, and keeps the LEVEL
   * where it was — see below, that split is the whole safety argument.
   */
  _buildSkySH(sky, skyLevel, hueOut) {
    const s = this.settings;
    const sh = this._skySH;
    for (let i = 0; i < 9; i++) sh[i].set(0, 0, 0);

    // THE LEVEL THIS MUST REPRODUCE, decided before anything else touches it.
    //
    // It is the up-facing sky irradiance the two-band model delivers for this
    // frame — the published ambient hue, scaled to a peak of 1, times the
    // calibrated `skyLevel` — expressed as a LUMINANCE.
    //
    // Luminance, and not the peak channel, and this is the whole ballgame. The
    // first cut of this normalised on the peak channel because that is the
    // scale the old code happened to write its vector on, while the skyglow was
    // mixed in by its luminance share. Two metrics, one blend: with the probe's
    // truer (bluer) night hue the peak sat in blue, so pinning blue dropped red
    // and green and the night sky band quietly lost 11% of its LIGHT — measured
    // at the `night` shot as crushed pixels 2.13% -> 3.29%, i.e. most of the
    // night pass's headline result handed back. ARCHITECTURE.md already has the
    // general form of that mistake written down: a stabiliser that measures a
    // different quantity from the one it is stabilising manufactures the
    // instability it was meant to prevent.
    //
    // One metric everywhere. The probe then changes the colour of the light and
    // the direction it arrives from, and provably not how much of it there is.
    const refLuma =
      (0.2126 * hueOut.x + 0.7152 * hueOut.y + 0.0722 * hueOut.z) * skyLevel;

    const probe = this._noSkySH ? null : sky?.irradiance;
    if (probe?.valid) for (let i = 0; i < 9; i++) sh[i].copy(probe.sh[i]);
    // Normalise the DOME's own contribution to unit up-facing luminance, so what
    // survives from it is only shape and hue. If there is no probe yet — the
    // first frames, or no sky subsystem at all — fall back to a uniform
    // hemisphere of the published hue, which is EXACTLY the old two-band model.
    // So boot and prewarm are unchanged and there is no pop when the probe
    // lands on a flat sky.
    if (this._normaliseSH(sh, 1) === 0) {
      for (let i = 0; i < 9; i++) sh[i].set(0, 0, 0);
      addHemisphereSH(sh, hueOut.x, hueOut.y, hueOut.z);
      this._normaliseSH(sh, 1);
    }

    // --- the part of the ambient the dome does not render ---------------------
    // Urban skyglow is not in any atmosphere model — it is a thousand sodium
    // lamps scattering off a cloud base — so it is added here as what it
    // physically is: an extra uniform hemisphere, in the same basis, mixed in by
    // its own share of the published ambient. Without this the night pass would
    // be silently undone: the probe would hand back the moonlit dome's 3.4:1
    // blue and the warm-neutral floor that took the 21:21 frame from 1.71% to
    // 0.03% crushed pixels would be gone.
    const glow = sky?.skyglowColor;
    let wGlow = 0;
    if (glow && sky?.ambientColor) {
      const a = sky.ambientColor;
      const la = 0.2126 * a.r + 0.7152 * a.g + 0.0722 * a.b;
      const lg = 0.2126 * glow.r + 0.7152 * glow.g + 0.0722 * glow.b;
      wGlow = la > 1e-9 ? THREE.MathUtils.clamp(lg / la, 0, 1) : 0;
    }
    if (wGlow > 1e-4) {
      for (let i = 0; i < 9; i++) sh[i].multiplyScalar(1 - wGlow);
      // A uniform hemisphere of radiance L gives E(+Y) = PI*L, so dividing by
      // the hue's own luminance and by PI makes the added lobe carry exactly
      // `wGlow` on the same unit-luminance scale the dome half was just
      // normalised onto.
      const lg = 0.2126 * glow.r + 0.7152 * glow.g + 0.0722 * glow.b;
      const k = wGlow / Math.max(lg * Math.PI, 1e-9);
      addHemisphereSH(sh, glow.r * k, glow.g * k, glow.b * k);
    }

    // --- the one surviving art control ---------------------------------------
    // At golden hour the whole western half of the dome is the sunset band, and
    // a cosine-weighted integral of it comes back warm — MEASURED B/R 0.88 on
    // the `sunset` frame. That is arguably what the dome really delivers, but it
    // paints every shadow in a low-sun frame the same hue as the key, and a
    // golden-hour photograph reads as golden hour precisely because it does not.
    // So the low-sun cool bias is kept, at its original strength and on its
    // original ramp — but it is now applied as a per-channel GAIN on a measured
    // integral rather than as one of four corrections to a guess, and it is a
    // hard zero above 0.34 of sun elevation, so no daylight frame can see it.
    const lowSun = 1 - THREE.MathUtils.smoothstep(this.sunDir.y, 0.02, 0.34);
    const w = lowSun * s.skyFillCoolBias;
    if (w > 0.001) {
      const e = shIrradiance(sh, 0, 1, 0, this._shE);
      const mx = Math.max(e.x, e.y, e.z, 1e-9);
      const hx = e.x / mx;
      const hy = e.y / mx;
      const hz = e.z / mx;
      const tx = hx + (0.40 - hx) * w;
      const ty = hy + (0.60 - hy) * w;
      const tz = hz + (1.0 - hz) * w;
      for (let i = 0; i < 9; i++) {
        sh[i].set(
          sh[i].x * (tx / Math.max(hx, 1e-4)),
          sh[i].y * (ty / Math.max(hy, 1e-4)),
          sh[i].z * (tz / Math.max(hz, 1e-4))
        );
      }
    }

    // --- and finally, the LEVEL, which does not come from the probe -----------
    // This is deliberate and it is the reason the change is safe. The dome does
    // not know about skyglow, and the renderer's key:fill ratio, its shadow
    // depth in stops and the night floor were all calibrated against
    // `sky.ambientColor`. So the probe is renormalised to deliver EXACTLY the
    // up-facing luminance the old two-band model delivered, and supplies only
    // what it is uniquely able to supply: hue, and directional shape.
    //
    // The old form is the l <= 1 special case of this one — a uniform
    // hemisphere's irradiance is linear in dot(N,up) — so for a flat dome the
    // two are identical rather than merely close.
    //
    // `refLuma`, computed at the top from the published ambient before anything
    // in here touched it: the exact amount of light the two-band model would
    // have delivered to an up-facing surface in this frame.
    this._normaliseSH(sh, refLuma);

    // Publish the up-facing irradiance under the old name. It is what the
    // exposure log prints, and the ground band uses it as the sky's share of
    // the horizontal illuminance, so both keep meaning what they meant.
    const e = shIrradiance(sh, 0, 1, 0, this._shE);
    this.patcher.uniforms.owSkyFill.value.copy(e);
    hueOut.copy(e).divideScalar(Math.max(e.x, e.y, e.z, 1e-9));
    this._uploadSkySH(1);
  }

  /**
   * Scale `sh` so the LUMINANCE of its up-facing irradiance is `target`.
   * Returns the scale applied, or 0 if the set carries no light at all — which
   * the caller treats as "no probe yet" rather than uploading a black sky.
   */
  _normaliseSH(sh, target) {
    const e = shIrradiance(sh, 0, 1, 0, this._shE);
    const m = 0.2126 * e.x + 0.7152 * e.y + 0.0722 * e.z;
    if (!(m > 1e-9)) return 0;
    const k = target / m;
    for (let i = 0; i < 9; i++) sh[i].multiplyScalar(k);
    return k;
  }

  /** Write the SH uniform array from `_skySH`, scaled. Never scales in place. */
  _uploadSkySH(scale) {
    const dst = this.patcher.uniforms.owSkySH.value;
    const src = this._skySH;
    for (let i = 0; i < 9; i++) dst[i].copy(src[i]).multiplyScalar(scale);
  }

  /**
   * Drive the aerial perspective from the live sky.
   *
   * Everything here is read through `ctx.peek('sky')` at runtime — no import,
   * no hard dependency, and sane numbers when there is no sky subsystem.
   *
   * The one genuinely tricky part is not double-counting. `sky` owns volumetric
   * fog and applies its own extinction in a registered pass, over a shallow
   * boundary layer (its `heightScale`, ~18 m) and out to its own maxDistance.
   * This pass owns the kilometre-scale atmosphere. Both attenuate the same
   * photons, so the aerosol coefficient here cedes up to `aerialSkyShare` of
   * itself to whatever the sky publishes. It never cedes ALL of it, because the
   * part this pass contributes that the sky's cannot is exactly the part that
   * matters at city scale: the vertical gradient that puts a hilltop above the
   * haze, and everything past the sky's own distance clamp.
   */
  _updateAerial() {
    const s = this.settings;
    const u = this.aerial.pass.uniforms;
    const sky = this.ctx.peek('sky');

    // In-scatter colour comes from the sky's own equirectangular environment,
    // so the haze can never disagree with the dome the player is looking at.
    this._aerialSkyTex = sky?.envEquirect?.texture ?? this.envEquirect;

    // --- weather ------------------------------------------------------------
    // Turbidity is an aerosol multiplier by definition; wetness adds the
    // river-valley murk this city is supposed to have (DESIGN.md: "Weather
    // leans wet: overcast, river fog at dawn").
    const w = sky?.weather;
    const turbidity = w?.turbidity ?? 1.35;
    const wet = THREE.MathUtils.clamp(w?.rain ?? w?.wetness ?? 0, 0, 1);
    const aerosol = s.aerialMie * (0.62 + 0.38 * turbidity) * (1 + 1.15 * wet);

    // --- cede the overlap with the sky's own fog ----------------------------
    const skyExt = sky?.fog?.extinction ?? 0;
    const ceded = Math.min(skyExt * s.aerialSkyShare, aerosol * s.aerialSkyShare);
    const betaM = Math.max(aerosol - ceded, aerosol * (1 - s.aerialSkyShare));

    // Rayleigh at sea level, in 1/m, scaled. This is what makes distance eat
    // red before blue; the absolute level is small next to the aerosol but the
    // RATIO between the channels is the whole "far bank goes blue" effect.
    const kr = s.aerialRayleigh;
    u.uBetaR.value.set(5.802e-6 * kr, 13.558e-6 * kr, 33.1e-6 * kr);
    // Aerosol is close to grey but not quite: soot and mill dust absorb blue
    // slightly more than red, which warms the near haze and is the difference
    // between a rustbelt valley and a clean alpine one.
    u.uBetaM.value.set(betaM * 1.0, betaM * 0.98, betaM * 0.94);

    u.uHeights.value.set(
      s.aerialRayleighHeight,
      s.aerialMieHeight * (1 + 0.5 * wet),
      s.aerialBaseY,
      Math.min(this.q.drawDistance ?? 1200, s.aerialMaxDistance)
    );

    u.uSunDir.value.copy(this.sunDir);
    u.uPhase.value.set(s.aerialPhaseG, s.aerialPhaseBack, s.aerialBackWeight, s.aerialSkyClamp);
    u.uParams.value.set(s.aerialStrength, s.aerialHorizonBias, s.aerialSunGlow, 0);
    u.uTint.value.set(s.aerialTint[0], s.aerialTint[1], s.aerialTint[2]);

    // --- the night city -----------------------------------------------------
    // Below the horizon the sky sample is nearly black, so without this every
    // distant building at night crushes to zero and the skyline disappears.
    // Real cities glow: sodium and mercury light scattered off the aerosol is
    // what a night skyline is actually seen against, and it is what makes lit
    // windows read at 2 km rather than floating in a void.
    const night = THREE.MathUtils.smoothstep(-this.sunDir.y, -0.06, 0.10);
    // ...and fade the SKY SAMPLE out over the same ramp. See the uSkyGain note
    // in aerial.js: the glow term replaces the sky sample after dark, it does
    // not add to it, and letting both run put a flat grey wall across the night
    // horizon.
    u.uSkyGain.value = THREE.MathUtils.lerp(1, s.aerialNightSkyGain, night);
    const g = s.aerialNightGlow * night;
    u.uNightGlow.value.set(
      g * s.aerialNightTint[0],
      g * s.aerialNightTint[1],
      g * s.aerialNightTint[2]
    );
  }

  /**
   * Publish the coarse interior volumes the indirect gate tests against.
   *
   * The level is authored on one yaw, so a world position reaches level space
   * through a 2D rotation — cheap enough to do per fragment. The volumes are
   * the enterable buildings' own footprints, which the world subsystem already
   * publishes as `world.buildings[].spec`; we do not need per-room geometry
   * because the gate keys off *depth inside the footprint*, and a wall's outer
   * skin is at depth 0 while its inner skin is one thickness in.
   *
   * Runs once, when the world first appears, and then never again.
   */
  _updateRooms() {
    if (this._roomsReady) return;
    const world = this.ctx.peek('world');
    const list = world?.buildings;
    if (!list || !world.levelToWorld) return;
    this._roomsReady = true;

    // Recover the level->world yaw from two transformed level-space points, so
    // this stays correct if the world subsystem re-authors its transform.
    const o = world.levelToWorld(0, 0, 0, this._tmpV3);
    const ox = o.x;
    const oz = o.z;
    const ex = world.levelToWorld(1, 0, 0, this._tmpV3b);
    const c = ex.x - ox;
    const sn = ex.z - oz;
    const inv = 1 / Math.max(1e-6, Math.hypot(c, sn));
    const cs = c * inv;
    const sni = sn * inv;
    // world -> level: p' = R^T (p - o)
    this.patcher.uniforms.owRoomXf.value.set(
      cs,
      sni,
      -(ox * cs + oz * sni),
      -(-ox * sni + oz * cs)
    );

    const rooms = this.patcher.rooms;
    const roomsY = this.patcher.roomsY;
    let n = 0;
    for (const b of list) {
      const sp = b?.spec;
      if (!sp || sp.enterable !== true) continue;
      // A collapsed or ruined shell is open to the sky: it must keep its
      // skylight, or the one room in the level with a hole in its roof is the
      // one that reads as a cave.
      if (sp.collapse === true || sp.ruin === true) continue;
      if (n >= rooms.length) break;
      rooms[n].set(sp.x, sp.z, sp.w * 0.5, sp.d * 0.5);
      // From below the ground slab (so the floor plate counts as interior) up to
      // just under the roof deck — or under a setback, whose terrace is outdoors
      // and sits inside the footprint.
      let top = (b.roofY ?? 12) - 0.06;
      const sb = sp.setback?.from;
      if (sb !== undefined && b.floorY?.[sb] !== undefined) top = b.floorY[sb] - 0.06;
      roomsY[n].set(-0.8, top, 0, 0);
      n++;
    }
    this.patcher.uniforms.owIndirect.value.z = n;
    if (n > 0) console.info(`[render] indirect gate: ${n} interior volumes`);
  }

  _ensureProbe(ctx) {
    // A couple of foreign meshes means another subsystem is still using its
    // own placeholder; the probe only steps aside for a real level.
    const FOREIGN_LIMIT = 6;
    if (this.probeActive) {
      if (this._foreignMeshes >= FOREIGN_LIMIT) {
        ctx.scene.remove(this.probe.group);
        this.probe.dispose();
        this.probeActive = false;
        this.taa?.reset();
      }
      return;
    }
    if (this.frame > 4 || this._foreignMeshes >= FOREIGN_LIMIT) return;
    const g = this.probe.build();
    g.traverse((o) => {
      o.userData.owProbe = true;
    });
    ctx.scene.add(g);
    this.probeActive = true;
  }

  /** Name a light that published a non-finite value, once per light. */
  _reportBadLight(light) {
    if (!this._badLights) this._badLights = new Set();
    const key = light.name || light.uuid;
    if (this._badLights.has(key)) return;
    this._badLights.add(key);
    console.error(
      `[render] light "${key}" published a non-finite intensity/position ` +
        `(${light.intensity}). Clamped to 0 — a NaN here turns EVERY lit pixel ` +
        `in the frame into NaN and the screen goes black. Fix it at the source.`
    );
  }

  _cullLights(camPos) {
    const s = this.settings;
    for (let i = 0; i < this.lights.length; i++) {
      const e = this.lights[i];
      // If the owner animated the intensity since we last wrote it, adopt the
      // new value as the base rather than fighting them (flickering lamps).
      if (e.applied !== undefined && e.light.intensity !== e.applied) {
        e.baseIntensity = e.light.intensity;
      }
      // Same firewall as _syncSun, one step earlier: a non-finite base or
      // position here would be laundered into `applied` and written straight
      // back into the light.
      if (!(e.baseIntensity >= 0) && e.baseIntensity !== 0) {
        this._reportBadLight(e.light);
        e.baseIntensity = 0;
      }
      const d = e.light.position.distanceTo(camPos);
      if (!(d >= 0)) {
        this._reportBadLight(e.light);
        e.light.position.set(0, 0, 0);
        e.light.intensity = 0;
        e.applied = 0;
        continue;
      }
      const fade = 1 - THREE.MathUtils.smoothstep(d, e.range * 0.75, e.range * 1.15);
      // Practicals are held against the sun by the renderer, because the
      // renderer is what owns the key:fill ratio. A "practical" here is a light
      // that asked to be distance-culled inside a room-or-street radius; the FX
      // flash pool deliberately registers at 90 m so the fade never bites it,
      // and a muzzle flash must not be dimmed by a room-lighting control.
      const gain = e.range <= PRACTICAL_RANGE ? s.practicalGain : 1;
      e.applied = e.baseIntensity * fade * gain;
      e.light.intensity = e.applied;
      // `light.visible` is DELIBERATELY not touched. It used to be set to
      // `fade > 0.002`, which is the exact bug ARCHITECTURE.md warns about:
      // three bakes the number of VISIBLE point lights into every lit
      // material's program cache key, so a single lamp crossing its fade radius
      // recompiled every lit material in the scene — +33 to +36 programs and
      // 640-900 ms, on one frame, every time the player walked past a lamp
      // post. A zero-intensity light shades to exactly the same pixels and
      // costs one lighting-loop iteration; a recompile costs the frame.
      if (e.light.visible !== true) e.light.visible = true;
    }
  }

  /**
   * Hold `numPointLights` at the value everything was compiled against.
   *
   * This is the enforcement half of the contract declared where `_pool` is
   * built. `_pool` guarantees the RENDERER never moves the count; this
   * guarantees nobody else does either, without needing every subsystem to
   * cooperate — which is the only version of the invariant that actually holds,
   * because the count is global state and a single stray `visible = false`
   * anywhere in the engine invalidates every program in the cache.
   *
   * MEASURED before this existed (tier `low`, 900 frames of walking + firing):
   * the visible count oscillated 16 <-> 15 and the first crossing cost 1291 ms
   * while three recompiled 61 programs — the forward variant of every material
   * on screen plus the `csm-depth` and `ow-prepass` override variants, which
   * carry the light count in their cache key even though they never read a
   * light. The oscillation itself is one light coming into range: firing a shot
   * after walking somewhere new is enough.
   *
   * The lock is latched on the first frame rather than configured, because the
   * number that matters is not any particular value — it is whatever value the
   * pre-warm happened to compile at. Latching it here means the frame loop
   * agrees with the pre-warm by construction.
   */
  _enforceLightCount() {
    if (!this.lightCountLockEnabled) return;
    const n = this._nPointLights;
    if (this._lightCountLock < 0) this._lightCountLock = n;
    let want = this._lightCountLock - n;
    if (want > this._ballast.length) {
      // More ballast needed than we own. Cannot happen with the shipped
      // subsystems; if it ever does, the count moves and something recompiles,
      // so say so rather than let it be a mystery stall.
      if (this._lightCountRaises++ === 0) {
        console.warn(`[render] point-light ballast exhausted: need ${want}, have ${this._ballast.length}`);
      }
      want = this._ballast.length;
    } else if (want < 0) {
      // Somebody added a point light. One recompile is now unavoidable; adopt
      // the higher count so it happens once instead of on every crossing.
      if (this._lightCountRaises++ < 4) {
        console.warn(`[render] visible point lights ${this._lightCountLock} -> ${n}; every material recompiles this frame`);
      }
      this._lightCountLock = n;
      want = 0;
    }
    for (let i = 0; i < this._ballast.length; i++) {
      const v = i < want;
      if (this._ballast[i].visible !== v) this._ballast[i].visible = v;
    }
  }

  /**
   * Score this frame's `submitLight()` calls into the fixed pool.
   *
   * Selection is a partial sort — the pool is 4-8 entries, so an insertion pass
   * over the submissions is cheaper than sorting them and allocates nothing.
   * Each slot then cross-fades between whatever it held and whatever it won, so
   * a light losing its slot to a passing car dims out over ~0.15 s rather than
   * blinking. The pool's `visible` flags are never touched.
   */
  _assignLightSlots(dt) {
    const n = this.lightSlots;
    this._nReqLast = this._nReq;
    if (n === 0) {
      this._nReq = 0;
      return;
    }
    const req = this._req;
    const nReq = this._nReq;
    const best = this._bestReq || (this._bestReq = new Int32Array(8));
    let count = 0;
    for (let i = 0; i < nReq; i++) {
      const s = req[i].score;
      let j = count < n ? count++ : n;
      // shift down while the incoming score beats the one already there
      while (j > 0 && req[best[j - 1]].score < s) {
        if (j < n) best[j] = best[j - 1];
        j--;
      }
      if (j < n) best[j] = i;
    }

    const k = 1 - Math.exp(-dt * 14); // ~0.15 s to swap a slot
    const gain = this.settings.practicalGain;
    for (let i = 0; i < n; i++) {
      const slot = this._pool[i];
      const l = slot.light;
      if (i < count) {
        const e = req[best[i]];
        if (slot.key !== e.key) {
          // A different emitter wants this slot. Fade the old one out first,
          // then take the position over, so nothing ever teleports lit.
          slot.level = Math.max(0, slot.level - k * 2);
          if (slot.level < 0.02) slot.key = e.key;
          l.intensity = slot.level * slot.applied;
          continue;
        }
        // Distance fade at the light's own range, so a slot handover at the
        // edge of relevance is between two near-zero values.
        const dx = e.x - this._camPos.x;
        const dy = e.y - this._camPos.y;
        const dz = e.z - this._camPos.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const fade = 1 - THREE.MathUtils.smoothstep(d, e.range * 0.72, e.range);
        l.position.set(e.x, e.y, e.z);
        l.color.setRGB(e.r, e.g, e.b);
        l.distance = e.range;
        slot.applied = e.intensity * fade * (e.priority >= 5 ? 1 : gain);
        slot.level += (1 - slot.level) * k;
        l.intensity = slot.level * slot.applied;
      } else {
        slot.level = Math.max(0, slot.level - k);
        l.intensity = slot.level * (slot.applied ?? 0);
        if (slot.level < 0.02) slot.key = -1;
      }
    }
    this._nReq = 0;
  }

  // ==========================================================================
  //  the frame
  // ==========================================================================

  render(ctx) {
    const renderer = this.renderer;
    const { scene, camera, viewScene, viewCamera } = ctx;
    const dt = Math.min(0.1, Math.max(1 / 480, ctx.time.dt || 1 / 60));
    this.frame++;
    renderer.info.reset();

    this._syncCameraRange(camera);
    camera.updateMatrixWorld();
    viewCamera.updateMatrixWorld();

    // Camera position and the unjittered view-projection are needed by the
    // hierarchical cull, so they are computed BEFORE the scene walk rather than
    // after it.
    this._camPos.setFromMatrixPosition(camera.matrixWorld);
    this._currVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    this._collect(scene, camera);
    this._ensureProbe(ctx);
    this._syncSun(camera);
    this._updateRooms();
    this._updateBounceFill();
    this._updateAerial();
    this._updateViewRig(viewCamera);
    this._cullLights(this._camPos);
    this._assignLightSlots(dt);
    // After the scene walk (which counted) and after everything that could have
    // touched a light, but before anything is submitted to three.
    this._enforceLightCount();
    this._adsT = this._readAds();

    if (ctx.scene.environment !== this.envMap) {
      // somebody installed a better environment — adopt it everywhere
      this.envMap = ctx.scene.environment;
    }
    // Mirror the world environment onto the viewmodel scene so the weapon is
    // lit by the same IBL, but never stomp an environment the weapons
    // subsystem chose for itself.
    if (
      ctx.viewScene.environment !== ctx.scene.environment &&
      (ctx.viewScene.environment === null ||
        ctx.viewScene.environment === this._assignedViewEnv)
    ) {
      ctx.viewScene.environment = ctx.scene.environment;
      this._assignedViewEnv = ctx.scene.environment;
    }

    // ---- unjittered matrices for velocity + reprojection ------------------
    this._invVP.copy(this._currVP).invert();
    if (this._firstFrame) this._prevVP.copy(this._currVP);

    // ---- 2. cascaded shadow maps -----------------------------------------
    const bg = scene.background;
    if (this.csm.enabled) {
      this.csm.update(camera, this.sunDir, this.settings.sunSoftness, this.frame);
      // Frame index for the golden-ratio rotation of the shadow sample disc.
      // Wrapped at 64 rather than 8: the sequence is fract(k*phi), so it only
      // repeats when k does, and 8 frames is shorter than the TAA history.
      this.csm.setJitter(this.taa ? this.frame % 64 : 0);
      scene.background = null;
      this._hideList(this._shadowHide, this._nShadowHide);
      this.csm.render(
        renderer,
        scene,
        this._noCascadeCull ? null : this._casters,
        this._nCasters
      );
      this._showList(this._shadowHide, this._nShadowHide);
      scene.background = bg;
    }

    // ---- 3. TAA jitter ----------------------------------------------------
    // World camera only. The viewmodel is not temporally resolved any more, so
    // jittering its projection would just make it shimmer with nothing to
    // accumulate the offsets back out.
    if (this.taa) this._applyJitter(camera);

    // ---- 4. prepass -------------------------------------------------------
    const gb = this.gbuffer;
    if (this.needsPrepass) {
      scene.background = null;
      this._hideList(this._hide, this._nHide);
      gb.render(renderer, scene, camera, this._currVP, this._prevVP, true);
      this._showList(this._hide, this._nHide);
      scene.background = bg;
    }

    const feat = this.patcher.uniforms.owFeat.value;
    feat.set(0, 0, 0, 1);

    // ---- 5/6/7. AO, contact shadows, reflections --------------------------
    if (this.gtao && this.needsPrepass) {
      this.gtao.noEarlyOutFix = this._noAoFix;
      this.gtao.noReachFix = this._noAoReach;
      this.patcher.uniforms.owAoTex.value = this.gtao.render(
        renderer,
        gb,
        camera,
        this.frame,
        !!this.taa
      );
      this.aoTexture = this.patcher.uniforms.owAoTex.value;
      feat.x = 1;
    }
    if (this.contact && this.needsPrepass) {
      this.patcher.uniforms.owContactTex.value = this.contact.render(
        renderer,
        gb,
        camera,
        this.sunDirView,
        this.frame
      );
      feat.y = 1;
    }
    if (this.ssr && this.needsPrepass && !this._firstFrame) {
      // Previous frame's resolved colour. Without TAA the HDR target still
      // holds last frame at this point in the schedule, which is exactly what
      // we want to reflect.
      const src = this.taa ? this.taa.previousTexture : this.hdrRt.texture;
      this.patcher.uniforms.owSsrTex.value = this.ssr.render(renderer, gb, src, camera, this.frame);
      feat.z = 1;
    }

    // ---- 8. forward world pass -------------------------------------------
    this.csm.uniforms.owSunDirView.value.copy(this.sunDirView);
    renderer.setRenderTarget(this.hdrRt);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    // ---- 9. viewmodel into its OWN colour+depth target --------------------
    // NOT into the world buffer: see the header note. The gbuffer is left
    // describing the world alone, which is what TAA, motion blur, the ADS DOF
    // and the volumetric fog all need it to be.
    this._viewVisible = viewScene.children.length > this._viewRigChildren;
    if (this._viewVisible) {
      // The viewmodel is only in the cascades if its camera shares the world
      // camera's position; otherwise the world-space lookup would be nonsense.
      this._tmpV3.setFromMatrixPosition(viewCamera.matrixWorld);
      const coherent = this._tmpV3.distanceToSquared(this._camPos) < 0.25;
      const prevStrength = this.csm.uniforms.owCsmParams.value.x;
      const prevFeat = feat.y;
      if (!coherent) this.csm.uniforms.owCsmParams.value.x = 0;
      feat.y = 0; // contact shadows are a world-space buffer; not for the gun
      this.csm.uniforms.owSunDirView.value
        .copy(this.sunDir)
        .transformDirection(viewCamera.matrixWorldInverse)
        .normalize();

      // A weapon at the shoulder sees maybe half the sky — the shooter's own
      // head, chest and arms take the rest — so the hemispheric fill is
      // occluded for the viewmodel exactly the way its envMapIntensity is.
      // Without this the gun floats in more indirect light than the street.
      const uSky = this.patcher.uniforms.owSkyFill.value;
      const uGnd = this.patcher.uniforms.owGroundFill.value;
      const uWrap = this.patcher.uniforms.owWrapFill.value;
      this._fillSkySave.copy(uSky);
      this._fillGroundSave.copy(uGnd);
      this._fillWrapSave.copy(uWrap);
      uSky.multiplyScalar(this.settings.viewFillOcclusion);
      uGnd.multiplyScalar(this.settings.viewFillOcclusion);
      uWrap.multiplyScalar(this.settings.viewFillOcclusion);
      // The sky band is nine coefficients now, and it is the one the world
      // actually reads — scaling only owSkyFill would leave the gun sitting in
      // the FULL skylight while every band beside it was occluded.
      this._uploadSkySH(this.settings.viewFillOcclusion);
      // The interior gate is a WORLD-space volume test and the viewmodel's
      // world position is the camera's, so standing in a shop would drop the
      // weapon's whole indirect term at once. The gun has its own rig; skip it.
      const roomN = this.patcher.uniforms.owIndirect.value.z;
      this.patcher.uniforms.owIndirect.value.z = 0;

      // Still walked every frame — that is where new weapon/hand materials get
      // the shadow/AO/fill injection. It just no longer feeds the gbuffer.
      this._collectViewScene(viewScene);

      renderer.setRenderTarget(this.viewRt);
      // Transparent clear: the composite needs coverage, and the MSAA resolve
      // turns partially covered edge pixels into premultiplied fractional alpha.
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.render(viewScene, viewCamera);
      renderer.setClearColor(0x000000, 1);

      this.csm.uniforms.owCsmParams.value.x = prevStrength;
      feat.y = prevFeat;
      uSky.copy(this._fillSkySave);
      uGnd.copy(this._fillGroundSave);
      uWrap.copy(this._fillWrapSave);
      this._uploadSkySH(1);
      this.patcher.uniforms.owIndirect.value.z = roomN;
    }

    // ---- 9b. aerial perspective -------------------------------------------
    // Before TAA on purpose. The haze is a smooth, low-frequency field and the
    // temporal filter costs nothing to run over it, but more importantly SSR
    // reflects the PREVIOUS resolved frame — so putting aerial perspective
    // ahead of the resolve is what makes a wet road reflect a hazed skyline
    // instead of a crisp one. Also before the jitter is removed, because the
    // depth buffer it reconstructs its rays from was rasterised jittered.
    let color = this.hdrRt.texture;
    if (this.aerial && this.aerial.enabled && this.needsPrepass) {
      const out = this.pingRt[this._pingIndex];
      color = this.aerial.render(
        renderer,
        color,
        gb,
        camera,
        this._aerialSkyTex ?? this.envEquirect,
        out,
        this.hdrRt.depthTexture ?? null,
        this.reversedZ
      );
      this._pingIndex ^= 1;
    }

    if (this.taa) this._removeJitter(camera);

    // ---- 10. TAA ----------------------------------------------------------
    if (this.taa) {
      color = this.taa.render(renderer, color, gb, this._invVP, this._prevVP);
    }

    // ---- 11. motion blur --------------------------------------------------
    if (this.motionBlur) {
      const shutter = this.settings.shutter * (1 / 60 / dt);
      color = this.motionBlur.render(renderer, color, gb, this.frame, shutter);
    }

    // ---- 12. ADS depth of field ------------------------------------------
    // World only, and only while the sights are actually up. The viewmodel is
    // composited afterwards, so the optic body and the reticle stay sharp by
    // construction rather than by masking.
    if (this.dof && this._adsT > 0.01 && this.needsPrepass) {
      const dofOut = this.pingRt[this._pingIndex];
      color = this.dof.render(
        renderer,
        color,
        gb,
        dofOut,
        this._adsT,
        this.settings,
        this.frame
      );
      this._pingIndex ^= 1;
    }

    // ---- 13. registered passes -------------------------------------------
    // Guarded, because eleven subsystems register passes into this loop in
    // parallel and an exception from any one of them used to abort every pass
    // after it, the viewmodel composite, the metering, the bloom and the final
    // composite — a total blackout with nothing in the log naming the culprit.
    // (That is exactly what happened when reversed-Z landed and three started
    // calling `updateProjectionMatrix()` on the bare `THREE.Camera` several
    // subsystems used for their full-screen quad.) One bad pass should cost one
    // effect and one console line.
    for (let i = 0; i < this.passes.length; i++) {
      const p = this.passes[i];
      if (p.enabled === false) continue;
      const out = this.pingRt[this._pingIndex];
      try {
        p.render(renderer, color, out, this);
      } catch (err) {
        p.enabled = false;
        console.error(
          `[render] pass "${p.name ?? p.constructor?.name ?? `#${i}`}" threw and has been ` +
            `disabled for the rest of this session:`,
          err
        );
        renderer.setRenderTarget(null);
        continue;
      }
      color = out.texture;
      this._pingIndex ^= 1;
    }

    // ---- 14. viewmodel composite -----------------------------------------
    // After the registered passes on purpose: the volumetric fog and haze pass
    // are depth-driven and the gbuffer now holds the WORLD depth at the gun's
    // pixels, so compositing earlier would bury the weapon in 40 m of aerial
    // perspective. Before metering and bloom, so the muzzle flash still meters
    // and still blooms.
    if (this._viewVisible) {
      const vu = this.viewComposite.uniforms;
      const out = this.pingRt[this._pingIndex];
      vu.tColor.value = color;
      vu.tView.value = this.viewRt.texture;
      this.viewComposite.render(renderer, out);
      color = out.texture;
      this._pingIndex ^= 1;
    }

    // ---- 15. metering -----------------------------------------------------
    const s = this.settings;
    const exposureTex = this.exposure.update(
      renderer,
      color,
      this.screenSize.width,
      this.screenSize.height,
      s.autoExposure ? dt : 1e3,
      // The sky publishes a metering compensation for the current sun elevation:
      // a street canyon under a four-degree sun is entirely in shade, and a meter
      // weighted onto that geometry opens up two stops and flattens the sky it is
      // lit by. See SkySystem.exposureBias.
      s.exposureBias + this._skyExposureBias,
      s.exposureKey,
      this.needsPrepass ? this.depthTexture : null
    );
    this.exposureTexture = exposureTex;

    // ---- 16. bloom --------------------------------------------------------
    let bloomTex = null;
    if (this.bloom) {
      bloomTex = this.bloom.render(
        renderer,
        color,
        this.screenSize.width,
        this.screenSize.height,
        exposureTex
      );
    }

    // ---- 17/18. composite -------------------------------------------------
    const cu = this.composite.uniforms;
    cu.tColor.value = color;
    cu.tBloom.value = bloomTex ?? color;
    cu.uBloomCap.value = this._noEmissiveSpill ? 1e4 : s.bloomSpillCap;
    cu.tExposure.value = exposureTex;
    cu.uGrade.value.x = bloomTex ? this._bloomGain : 0;
    cu.uGrade.value.z = this.taa ? s.sharpen : 0;
    // Vignette closes in with the sight picture.
    cu.uLens.value.y = s.vignette + (s.adsVignette - s.vignette) * this._adsT;
    cu.uLens.value.w = ctx.time.elapsed;
    cu.uLook.value.w = this.ctx.config.exposure ?? 1;
    // What the meter WOULD have said, from the sun angle alone. Only consumed
    // when the metered texture reads back invalid — which is what a GPU that
    // cannot render the float exposure target produces, and which used to take
    // the whole image to black.
    const alt = this.ctx.peek('sky')?.sunAltitude;
    cu.uFallbackExp.value = Number.isFinite(alt)
      ? FALLBACK_NIGHT + (FALLBACK_DAY - FALLBACK_NIGHT) * Math.min(1, Math.max(0, (alt + 0.10) / 0.45))
      : FALLBACK_DAY;

    if (this.debugView) {
      this._renderDebug(renderer, color);
    } else if (this.fxaa) {
      this.composite.render(renderer, this.ldrRt);
      this.fxaa.uniforms.tColor.value = this.ldrRt.texture;
      this.fxaa.render(renderer, null);
    } else {
      this.composite.render(renderer, null);
    }

    // ---- bookkeeping ------------------------------------------------------
    // Only world objects are in the gbuffer now, so only their transforms need
    // remembering for next frame's velocity.
    gb.beginRecord();
    gb.recordMatrices(this._draw, this._nDraw);
    gb.endRecord();
    this._prevVP.copy(this._currVP);
    this._firstFrame = false;
    renderer.setRenderTarget(null);

    if (this._probeExposure) this._logExposure();
  }

  /**
   * The viewmodel scene walk. Its only job now is material patching — the
   * viewmodel is no longer in the gbuffer, so nothing needs its transform
   * remembered for a velocity difference.
   */
  _visitView(o) {
    if (o.isMesh === true) {
      const m = o.material;
      if (Array.isArray(m)) for (let i = 0; i < m.length; i++) this.patcher.patch(m[i]);
      else if (m) this.patcher.patch(m);
    }
  }

  /**
   * Dev aid: show an intermediate buffer full-screen.
   * `ctx.get('render').debugView = 'ao' | 'normal' | 'velocity' | 'depth' |
   *  'ssr' | 'ssrmask' | 'contact' | 'bloom' | null`
   */
  _renderDebug(renderer, color) {
    if (!this._debugPass) this._debugPass = createDebug();
    const u = this._debugPass.uniforms;
    const gb = this.gbuffer;
    const map = {
      ao: [this.aoTexture, 0],
      normal: [gb.normalTexture, 1],
      velocity: [gb.velocityTexture, 2],
      depth: [gb.depthTexture, 3],
      ssr: [this.ssr?.texture, 4],
      ssrmask: [this.ssr?.texture, 5],
      contact: [this.contact?.texture, 0],
      bloom: [this.bloom?.texture, 4],
      view: [this.viewRt?.texture, 4],
      viewalpha: [this.viewRt?.texture, 5],
      color: [color, 4],
    };
    const entry = map[this.debugView] ?? map.color;
    u.tSrc.value = entry[0] ?? color;
    u.uMode.value = entry[1];
    this._debugPass.render(renderer, null);
  }

  /** Dev aid: dump the metering chain. `render.debugExposure()` in console. */
  debugExposure() {
    const buf = this._readback;
    this.renderer.readRenderTargetPixels(this.exposure.rt1, 0, 0, 1, 1, buf);
    const avgLog = buf[0] / Math.max(buf[1], 1e-4);
    const out = this._readback2;
    this.renderer.readRenderTargetPixels(
      this.exposure.adapt[this.exposure._flip],
      0,
      0,
      1,
      1,
      out
    );
    return { avgLum: Math.pow(2, avgLog), ev100: out[1], exposure: out[0] };
  }

  _logExposure() {
    if (this.frame % 90 !== 0) return;
    const d = this.debugExposure();
    const u = this.patcher.uniforms;
    const v3 = (x) => `${x.x.toFixed(3)},${x.y.toFixed(3)},${x.z.toFixed(3)}`;
    console.info(
      `[render] frame ${this.frame} avgLum ${d.avgLum.toFixed(4)} ev100 ${d.ev100.toFixed(2)} exposure ${d.exposure.toFixed(4)} ` +
        `sun=${this.activeSun.intensity.toFixed(3)} skyFill=${v3(u.owSkyFill.value)} gndFill=${v3(u.owGroundFill.value)} ` +
        `ibl=${u.owIndirect.value.x.toFixed(3)} indoor=${u.owIndirect.value.y.toFixed(3)} rooms=${u.owIndirect.value.z}`
    );
  }

  _collectViewScene(viewScene) {
    viewScene.traverseVisible(this._visitView);
  }

  /**
   * Sub-pixel offset for the TAA accumulation. WORLD camera only — the
   * viewmodel has its own MSAA target and no temporal history, so a jitter on
   * `viewCamera` would be a permanent sub-pixel wobble with nothing to resolve
   * it back out.
   */
  _applyJitter(camera) {
    const j = this.taa.nextJitter();
    const jx = (j.x * 2) / this.screenSize.width;
    const jy = (j.y * 2) / this.screenSize.height;
    this._jitterSaved.set(camera.projectionMatrix.elements[8], camera.projectionMatrix.elements[9]);
    camera.projectionMatrix.elements[8] += jx;
    camera.projectionMatrix.elements[9] += jy;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    this._jittered = true;
  }

  _removeJitter(camera) {
    if (!this._jittered) return;
    camera.projectionMatrix.elements[8] = this._jitterSaved.x;
    camera.projectionMatrix.elements[9] = this._jitterSaved.y;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    this._jittered = false;
  }

  /**
   * ADS engagement, 0..1. The weapons subsystem owns the transition; we only
   * read it, and never require it to exist.
   */
  _readAds() {
    if (!this._weapons) this._weapons = this.ctx.peek('weapons') || null;
    const w = this._weapons;
    if (!w) return 0;
    const t = w.adsProgress;
    return typeof t === 'number' && t === t ? Math.min(1, Math.max(0, t)) : 0;
  }

  dispose() {
    this.csm.dispose();
    this.gbuffer.dispose();
    this.gtao?.dispose();
    this.contact?.dispose();
    this.ssr?.dispose();
    this.taa?.dispose();
    this.motionBlur?.dispose();
    this.dof?.dispose();
    this.bloom?.dispose();
    this.aerial?.dispose();
    this.culler?.dispose();
    this.exposure.dispose();
    this.composite.dispose();
    this.viewComposite.dispose();
    this.fxaa?.dispose();
    this.lut.texture.dispose();
    this.envEquirect?.dispose();
    this.hdrRt?.dispose();
    this.viewRt?.dispose();
    this.ldrRt?.dispose();
    this.pingRt[0]?.dispose();
    this.pingRt[1]?.dispose();
    this.envTarget?.dispose();
    if (this.probeActive) {
      this.ctx?.scene.remove(this.probe.group);
      this.probe.dispose();
    }
    this._debugPass?.dispose();
    // The pinning ballast and the punctual pool are the only Object3Ds this
    // subsystem parks in somebody else's scene graph; a hot reload that left
    // them behind would raise the light count on the next boot and recompile
    // everything, which is precisely what they exist to prevent.
    for (const l of this._ballast ?? []) this.ctx?.scene.remove(l);
    for (const s of this._pool ?? []) this.ctx?.scene.remove(s.light);
    this.patcher.dispose();
    this.renderer.dispose();
  }
}
