import * as THREE from 'three';
import { UNITS } from '../core/config.js';
import { buildParticleAtlas, buildDecalAtlas, P, D } from './atlas.js';
import { ParticleLayer, resetSpawn, disposeQuadSource } from './particles.js';
import { DecalSystem } from './decals.js';
import { HazeSystem } from './haze.js';
import { LightPool } from './lights.js';
import { ShellSystem } from './shells.js';
import { Ambience } from './ambience.js';
import { SkidSystem } from './skid.js';
import { RainSystem } from './rain.js';
import { FountainFx } from './fountain.js';
import { VehicleFx, objOf, posOf, velOf } from './vehiclefx.js';
import { WorldFx } from './worldfx.js';
import { spawnImpact } from './impacts.js';
import { muzzleFlash } from './muzzle.js';
import { spawnTracer } from './tracers.js';
import { explode } from './explosions.js';
import { Hitstop } from './hitstop.js';
import { V, cone } from './util.js';

/**
 * FX — GPU particles, impacts, decals, muzzle flash, tracers, shells,
 * explosions, refraction and ambience.
 *
 * Everything visible here is built from two procedurally baked atlases and a
 * handful of instanced draw calls:
 *
 *   world additive particles   1 draw   sparks, flash, fire, tracers, embers
 *   world lit particles        1 draw   smoke, dust, blood, debris, splinters
 *   dust motes                 1 draw   always-on atmosphere
 *   decals                     1 draw   projected onto the physics BVH
 *   shell casings              1 draw   instanced rigid bodies
 *   refraction sprites         1 draw   + one half-res post pass
 *
 * The simulation is entirely in the vertex shader (see particles.js), so the
 * per-frame CPU cost of ten thousand live particles is six uniform writes and
 * one buffer sub-upload of whatever was spawned this frame. Budgets come from
 * `config.q.particleBudget` / `decalBudget` and are hard caps: every layer is a
 * ring, and a ring never allocates.
 */
export class FxSystem {
  static id = 'fx';
  static deps = ['render', 'materials'];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    this.render = ctx.peek('render');
    this._physics = ctx.peek('physics');
    this._audio = ctx.peek('audio');
    this.gravity = UNITS.gravity;
    this.now = 0;

    const q = ctx.config.q;
    const budget = q.particleBudget ?? 6000;
    const big = budget >= 10000;

    const t0 = performance.now();
    // 5 columns x 256 px tiles. The tile resolution is what governs how a
    // smoke silhouette reads at 3 m, so the atlas grew with the tile count
    // rather than subdividing the same sheet.
    const atlasSize = big ? 1280 : 640;
    const particleAtlas = buildParticleAtlas(this.rng.fork(), atlasSize);
    const decalAtlas = buildDecalAtlas(this.rng.fork(), atlasSize);
    this._atlas = particleAtlas;
    this._decalAtlas = decalAtlas;
    const bakeMs = performance.now() - t0;

    const mote = clampI(Math.round(budget * 0.05), 96, 500);
    const hazeCap = clampI(Math.round(budget * 0.04), 48, 320);
    const viewAdd = clampI(Math.round(budget * 0.03), 48, 400);
    const viewLit = clampI(Math.round(budget * 0.02), 32, 256);
    // `sky` owns the falling rain streaks (they have to be lit by its
    // scattering and driven by its wind vector); this system owns what the
    // water does when it ARRIVES — splashes, road spray, drips, puddle strikes,
    // windscreen beads — and those all come out of the shared lit ring.
    //
    // `q.particleBudget` is the budget for the WHOLE frame, not for this
    // subsystem, so a quarter of it is left unclaimed and published on
    // `fx.skyParticleHeadroom` for `sky` to spend on its storm. Claiming the
    // lot here and letting `sky` allocate on top would put the frame over
    // budget while both subsystems could truthfully say they respected it.
    const skyReserve = clampI(Math.round(budget * 0.25), 200, 6000);
    /** Particles deliberately NOT allocated here, for `sky` to use for rain. */
    this.skyParticleHeadroom = skyReserve;
    const rest = Math.max(256, budget - mote - hazeCap - viewAdd - viewLit - skyReserve);
    const litCap = Math.round(rest * 0.62);
    const addCap = rest - litCap;

    /** Particles spawned per impact scale with the budget. */
    this.pScale = clamp(budget / 12000, 0.4, 1.25);

    const mk = (capacity, modeName, renderOrder) =>
      new ParticleLayer({
        capacity,
        mode: modeName,
        atlas: particleAtlas.texture,
        cols: particleAtlas.cols,
        renderOrder,
      });

    this.lit = mk(litCap, 'lit', 10);
    this.add = mk(addCap, 'additive', 12);
    this.motes = mk(mote, 'additive', 9);
    this.layers = [this.lit, this.add, this.motes];
    for (const l of this.layers) ctx.scene.add(l.mesh);

    // Viewmodel-space layers. Attached at the end of init() when the game HAS a
    // viewmodel (see the pre-warm note there), and otherwise on the first
    // first-person effect — so a game with no viewmodel never gets objects in
    // viewScene and never triggers the viewmodel pass.
    this.viewAdd = mk(viewAdd, 'additive', 12);
    this.viewLit = mk(viewLit, 'lit', 10);
    this.viewAdd.uniforms.uSoftEnable.value.x = 0;
    this.viewLit.uniforms.uSoftEnable.value.x = 0;
    this._viewAttached = false;

    this.decals = new DecalSystem({
      capacity: q.decalBudget ?? 128,
      albedo: decalAtlas.albedo,
      normal: decalAtlas.normal,
      orm: decalAtlas.orm,
      cols: decalAtlas.cols,
    });
    ctx.scene.add(this.decals.mesh);

    this.hazeSys = new HazeSystem({
      capacity: hazeCap,
      atlas: particleAtlas.texture,
      cols: particleAtlas.cols,
    });
    this._hazeOff = this.render?.registerPass?.(this.hazeSys.pass) ?? null;

    this.lights = new LightPool(ctx.scene, 4);
    if (this.render?.addLight) this.lights.register(this.render);
    /** Mirrored pool inside viewScene; built with the view layers on first use. */
    this.viewLights = null;

    this.shells = new ShellSystem(this);
    ctx.scene.add(this.shells.mesh);

    this.ambience = new Ambience(this, {
      motes: mote,
      shimmer: budget >= 4000,
    });

    // ---- open-world systems ----------------------------------------------
    // Skid ribbons get their own segment budget derived from the decal budget:
    // a drift is one long mark, so the count that matters is metres of ribbon,
    // not number of decals.
    this.skid = new SkidSystem(this, {
      capacity: clampI(Math.round((q.decalBudget ?? 128) * 6), 256, 4096),
    });
    ctx.scene.add(this.skid.mesh);

    this.rain = new RainSystem(this);

    // The Point Fountain's water — anchored at runtime to the emitted basin,
    // budgeted out of the shared lit ring. See fountain.js.
    this.fountain = new FountainFx(this, { budget });

    this.vehicleFx = new VehicleFx(this);
    this.worldFx = new WorldFx(this, { enabled: budget >= 1500 });

    // ---- shared world state other recipes read ---------------------------
    /** Global wind velocity in m/s. Drives smoke, rain, litter and steam. */
    this.windVec = new THREE.Vector3(1.6, 0, 0.9);
    /** 0..1 surface wetness, mirrored from `weather:change`. */
    this.wetness = 0;
    /** 0..1 how cold the air is — gates visible exhaust and breath. */
    this.coldAir = 0.35;
    /** 0..1 river-mist strength; peaks at dawn and after rain. */
    this.mistGain = 0.35;
    /** Fallback body colour for paint flakes and panel debris (linear). */
    this.paintTint = new THREE.Vector3(0.36, 0.09, 0.055);
    this._skidDt = 1 / 60;

    // ---- lighting inputs (overridable by `sky` via setAmbient) ------------
    this._ambTop = new THREE.Vector3(0.42, 0.5, 0.66);
    this._ambBot = new THREE.Vector3(0.2, 0.17, 0.14);
    this._sunCol = new THREE.Vector3(1, 0.93, 0.82);
    this._sunView = new THREE.Vector3(0, 1, 0);
    this._upView = new THREE.Vector3(0, 1, 0);
    this._fog = new THREE.Vector4(0.62, 0.66, 0.72, 0);
    this._ambientOverride = false;
    // The two dynamic point lights handed to the lit-particle shader.
    this._pt0 = new THREE.Vector4(0, 0, 0, 0.01);
    this._pt1 = new THREE.Vector4(0, 0, 0, 0.01);
    this._ptc0 = new THREE.Vector3();
    this._ptc1 = new THREE.Vector3();
    this._smokeLights = null;

    // ---- scratch ---------------------------------------------------------
    this._p = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._p2 = new THREE.Vector3();
    this._d2 = new THREE.Vector3();
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._tmpC = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._decalOpts = {
      point: this._p,
      normal: this._n,
      size: 0.15,
      tile: 0,
      roll: 0,
      life: 60,
      fade: 0.72,
      opacity: 1,
      maxAngle: 62,
      depth: 0.08,
      flip: false,
      world: null,
      mask: 0xffff,
      now: 0,
    };

    // ---- events ----------------------------------------------------------
    const on = (type, fn) => {
      const off = ctx.events.on(type, fn);
      this._off.push(off);
    };
    this._off = [];
    on('bullet:impact', (e) => this.onImpact(e));
    on('bullet:tracer', (e) => this.tracer(e.from, e.to, e.speed));
    on('weapon:fire', (e) => this.onWeaponFire(e));
    on('weapon:shell', (e) => this.spawnShell(e.position, e.velocity, e));
    on('explosion', (e) => this.explosion(e));
    on('actor:death', (e) => this.onActorDeath(e));
    on('player:land', (e) => this.onLand(e));
    on('player:footstep', (e) => this.onFootstep(e));
    // ---- open world ----
    on('vehicle:skid', (e) => this.onSkid(e));
    on('vehicle:collision', (e) => this.onVehicleCollision(e));
    on('vehicle:destroyed', (e) => this.onVehicleDestroyed(e));
    on('vehicle:engine', (e) => this.onVehicleEngine(e));
    on('vehicle:enter', (e) => this.onVehicleEnter(e));
    on('vehicle:exit', (e) => this.onVehicleExit(e));
    on('weather:change', (e) => this.onWeather(e));
    on('time:hour', (e) => this.onHour(e));

    // ---- dev burst script ------------------------------------------------
    this._script = [];
    this._scriptTime = 0;
    this._scriptPeriod = 0;
    this._scriptCursor = 0;

    this.stats = { spawned: 0, decals: 0, live: 0 };

    /**
     * HITSTOP. Backs `fx.stop(t)` — see `hitstop.js` for why this is a time
     * claim rather than a camera effect, and why it is so careful with
     * `ctx.time.scale`.
     */
    this.hitstop = new Hitstop(ctx);

    // ---- shader pre-warm -------------------------------------------------
    // MEASURED: the first trigger pull compiled 12 WebGL programs in one frame
    // (80-160 ms), and not one of them belonged to a particle. Attaching the
    // viewmodel-space layers adds this.viewLights to viewScene, which changes
    // that scene's *light count*, and three bakes the light counts into every
    // program cache key — so the whole viewmodel (weapon, gloves, optic glass,
    // lens rings) recompiled on the frame the player first shot.
    //
    // Attaching here instead means the viewmodel's programs are built once, with
    // their final light count, by the boot-time compile that already happens
    // before the first rendered frame. Nothing is spawned and both meshes stay
    // invisible, so this is pixel-neutral by construction: the two pooled lights
    // sit at intensity 0 (an exactly-zero contribution) until something flashes.
    //
    // Gated on a viewmodel already existing: `render` decides whether to run the
    // viewmodel pass at all by counting viewScene's children, and in an FX-only
    // scene (src/fx/preview.js) adding ours would turn that pass on. In that case
    // the lazy attach on first use still applies.
    this._warmTicks = 0;
    this._warmed = false;
    if (this._viewmodelPresent()) this._attachView();

    console.info(
      `[fx] atlases ${atlasSize}px in ${bakeMs.toFixed(0)}ms · particles ` +
        `lit ${litCap} add ${addCap} motes ${mote} haze ${hazeCap} · ` +
        `decals ${this.decals.capacity} skid ${this.skid.capacity} · ` +
        `${skyReserve} left unclaimed for sky rain`
    );
  }

  /* ===================================================================== */
  /*  emit helpers (bound so recipe modules can pass them around)          */
  /* ===================================================================== */

  emitAdd = (s) => this.add.emit(s, this.now);
  emitLit = (s) => this.lit.emit(s, this.now);
  emitMote = (s) => this.motes.emit(s, this.now);
  emitViewAdd = (s) => {
    this._attachView();
    return this.viewAdd.emit(s, this.now);
  };
  emitViewLit = (s) => {
    this._attachView();
    return this.viewLit.emit(s, this.now);
  };

  _attachView() {
    if (this._viewAttached) return;
    this._viewAttached = true;
    this.ctx.viewScene.add(this.viewAdd.mesh);
    this.ctx.viewScene.add(this.viewLit.mesh);
    // The viewmodel scene has its own light rig and never sees ctx.scene's
    // punctual lights, so the muzzle flash needs a mirrored pool in there or the
    // weapon is the one object in frame a flash cannot light. Two lights, added
    // once and left at zero between shots: the shader permutation count has to
    // stay constant or every weapon material recompiles mid-firefight.
    if (!this.viewLights) {
      this.viewLights = new LightPool(this.ctx.viewScene, 2);
      // NOT registered with render.addLight: that budgets/culls against world
      // positions, and these live in view space.
    }
  }

  /** Does viewScene already draw something of its own (i.e. is there a weapon)? */
  _viewmodelPresent() {
    let found = false;
    this.ctx.viewScene?.traverse((o) => {
      if (found || !o.isMesh) return;
      if (o === this.viewAdd?.mesh || o === this.viewLit?.mesh) return;
      found = true;
    });
    return found;
  }

  /* ===================================================================== */
  /*  shader pre-warm                                                      */
  /* ===================================================================== */

  /**
   * Build and compile every particle / decal / flash / refraction program
   * WITHOUT spawning anything into the world.
   *
   * Safe to call more than once and from anywhere: it spawns no particle, moves
   * no camera, touches no uniform and leaves every mesh exactly as visible as it
   * found it. All it does is ask the renderer for the programs those materials
   * will need, early, so the frame that first draws a spark is not also the frame
   * that compiles a shader.
   *
   * Two details are load-bearing, both measured:
   *
   *  1. A RENDER TARGET MUST BE BOUND. three folds `outputColorSpace` and
   *     `toneMapping` into the program cache key, and both are read off the
   *     *currently bound* target — so a compile with the canvas bound produces an
   *     `srgb` + tone-mapped program, while every FX draw actually happens inside
   *     the HDR target and needs the `srgb-linear` + NoToneMapping variant. A
   *     boot-time compile without a target bound therefore builds programs that
   *     are never used and the real ones still compile during play. A 1x1 target
   *     is enough to get the right key; nothing is rendered into it.
   *  2. THE REAL MESHES ARE COMPILED, not stand-ins. `renderer.compile` walks
   *     `scene.children` for materials and only uses `targetScene` for lights,
   *     fog and environment, so borrowing the meshes into a scratch scene (never
   *     re-parenting them — `parent` is untouched) is what guarantees the key is
   *     identical to the one the real draw will ask for, down to
   *     InstancedMesh-ness and the geometry's attribute set.
   *
   * @returns {{ok: boolean, compiled: number}}
   */
  prewarmMaterials() {
    const renderer = this.render?.renderer;
    if (!renderer) return { ok: false, compiled: 0, reason: 'no renderer' };
    const ctx = this.ctx;
    const before = renderer.info.programs?.length ?? 0;

    // Reaching the viewmodel layers means attaching them; see the note in init().
    if (!this._viewAttached && this._viewmodelPresent()) this._attachView();

    const prevRt = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace?.() ?? 0;
    const prevMip = renderer.getActiveMipmapLevel?.() ?? 0;
    const rt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false });
    const scratch = (this._warmScene ??= new THREE.Scene());
    const compile = (meshes, camera, targetScene) => {
      scratch.children.length = 0;
      for (const m of meshes) if (m) scratch.children.push(m);
      if (!scratch.children.length) return;
      try {
        renderer.compile(scratch, camera, targetScene);
      } catch (err) {
        console.warn('[fx] prewarm compile failed', err);
      }
      scratch.children.length = 0;
    };

    try {
      renderer.setRenderTarget(rt);
      compile(
        [
          this.lit.mesh,
          this.add.mesh,
          this.motes.mesh,
          this.decals.mesh,
          this.shells.mesh,
          this.skid.mesh,
        ],
        ctx.camera,
        ctx.scene
      );
      if (this._viewAttached) {
        compile([this.viewAdd.mesh, this.viewLit.mesh], ctx.viewCamera, ctx.viewScene);
      }
      // The refraction sprites and the warp pass live in the haze system's own
      // private scenes, which no scene-graph walk from outside can reach.
      this.hazeSys.prewarm(renderer);
    } finally {
      renderer.setRenderTarget(prevRt, prevFace, prevMip);
      rt.dispose();
    }

    this._warmed = true;
    const compiled = (renderer.info.programs?.length ?? 0) - before;
    return { ok: true, compiled };
  }

  /**
   * Flash light inside the viewmodel scene.
   *
   * Peak is derived from the renderer's viewmodel key so the kick is a fixed
   * number of stops at any time of day: ~2.6x the key at the handguard (0.3 m
   * back down the bore), which 1/d^2 turns into a blown rim at the crown and a
   * soft warm wash by the magwell. Held for 55 ms with a slow temporal decay so
   * it survives 3-4 frames — a flash that dies inside one frame is a flash the
   * player never sees.
   */
  viewFlash(x, y, z, r, g, b, strength = 1) {
    this._attachView();
    const pool = this.viewLights;
    if (!pool) return;
    const key = this.render?.viewSun?.intensity ?? 2.5;
    // 0.72 cd per unit of key puts ~19 W/m^2 on the handguard 0.3 m back down the
    // bore. That is what it takes to land the front third of the handguard and the
    // top of the hand in the L 190-235 band on the flash frame, with 1/d^2 giving
    // the warm falloff back to the magwell for free. At the old 0.26 the kick was
    // under a stop and measured as "zero warm gradient anywhere".
    const peak = Math.max(0.04, key * 0.72 * clamp(strength, 0.05, 2.2));
    // Lifted off the bore axis: a source sitting exactly on the axis rakes the
    // top of the receiver at N.L ~ 0.15 and the kick disappears. Real flash gas
    // is a ball around the crown, so 4 cm of height buys the whole top surface.
    //
    // 90 ms at decay 8, matched to the world light: a view flash that is dead
    // after one 33 ms frame is a flash the capture never photographs.
    pool.flash(x, y + 0.04, z, r, g, b, peak, 0.09, 8, 1.6, 2);
  }

  get physics() {
    if (!this._physics) this._physics = this.ctx.peek('physics');
    return this._physics;
  }

  /* ===================================================================== */
  /*  public API                                                           */
  /* ===================================================================== */

  /**
   * Handle a `bullet:impact` payload.
   *
   * `e.damage` IS IN ACTOR POINTS — the ~100-point scale a weapon's own
   * `def.damage` is authored in (nail 20, SMG 16, rivet 40, harpoon 90). The
   * knee below is authored against that scale and nothing else: 55 points is
   * where the burst saturates, so anything at or above ~55 emits the identical
   * maximal burst and the whole arsenal above that point looks the same.
   *
   * THAT CEILING IS A TRAP FOR ANY EMITTER THAT KEEPS SCORES IN ANOTHER
   * CURRENCY, and it has been sprung once. `vehicles` prices a body 90-3000 and
   * `ACTOR_TO_VEHICLE` is 10, so when `weapons` handed this slot the number it
   * had just given `vehicles.damage()`, every round and every swing on every
   * car in the city came out at the ceiling — a nail (0.99 on this scale) and a
   * harpoon (1.7) threw the identical spark burst, while every other surface
   * still varied with the round. Nothing threw, nothing logged, and the fault
   * was 300 lines away in `weapons/vehiclehit.js`.
   *
   * So: DO NOT clamp, rescale or sanity-check the incoming number here. A slot
   * that quietly absorbs a 10x error is how the error survives. Emitters carry
   * their own scale (see `VehicleHitTest.dealt`), and `src/fx/sparkprobe.mjs`
   * gates the emitted particles across weapons and surfaces so a future one
   * that does not is caught in a second rather than in a screenshot.
   */
  onImpact(e) {
    if (!e || !e.point) return;
    this.now = this.ctx.time.elapsed;
    if (!e.normal) return;
    let energy = clamp(0.7 + (e.damage ?? 25) / 55, 0.7, 1.7);
    if (e.exit === true) energy *= 0.75;
    spawnImpact(this, e.point, e.normal, e.incident ?? this._defaultIncident(e), e.surface, energy);
    this.stats.spawned++;
  }

  _defaultIncident(e) {
    this._d2.set(-e.normal.x, -e.normal.y, -e.normal.z);
    return this._d2;
  }

  /** `weapon:fire` — set `e.fx === false` to suppress and drive FX yourself. */
  onWeaponFire(e) {
    if (!e || e.fx === false || !e.origin || !e.dir) return;
    this.now = this.ctx.time.elapsed;
    this._camPos.setFromMatrixPosition(this.ctx.camera.matrixWorld);
    const firstPerson = this._camPos.distanceToSquared(e.origin) < 2.25;
    this.muzzleFlash({
      position: e.origin,
      direction: e.dir,
      weapon: e.weapon,
      view: firstPerson,
      intensity: e.intensity,
      light: e.light,
      scale: e.flashScale,
    });
  }

  /**
   * Muzzle flash + barrel smoke + light + heat haze.
   * `view: true` emits into the viewmodel scene (converted through the two
   * cameras) so the flash composites over the weapon rather than under it.
   */
  muzzleFlash(o) {
    this.now = this.ctx.time.elapsed;
    let pos = o.position;
    let dir = o.direction;
    // The light always lives in the world, even when the sprites are drawn in
    // viewmodel space, because it is the world it has to illuminate.
    if (o.viewSpace) {
      // Caller handed us a point already in viewmodel space (the usual case for
      // a weapon whose muzzle is a bone in viewScene): map it back out for the
      // light and leave the sprites where they are.
      this._fromView(pos);
      this._lightPos.copy(this._p2);
      o = this._viewArg(o);
    } else {
      this._lightPos.copy(pos);
      if (o.view) {
        this._toView(pos, dir);
        pos = this._p2;
        dir = this._d2;
      }
    }
    this._flashArg.position = pos;
    this._flashArg.direction = dir;
    this._flashArg.lightPos = this._lightPos;
    this._flashArg.weapon = o.weapon;
    this._flashArg.intensity = o.intensity;
    this._flashArg.light = o.light;
    this._flashArg.scale = o.scale;
    this._flashArg.view = o.view === true || o.viewSpace === true;
    return muzzleFlash(this, this._flashArg);
  }

  _flashArg = {
    position: null,
    direction: null,
    lightPos: null,
    weapon: null,
    intensity: 1,
    light: 1,
    scale: undefined,
    view: false,
  };
  _lightPos = new THREE.Vector3();

  /** Mark an options object as already being in viewmodel space. */
  _viewArg(o) {
    this._flashArg.view = true;
    return o;
  }

  /** Viewmodel-scene point -> world space (for the punctual light). */
  _fromView(pos) {
    const cam = this.ctx.camera;
    const vcam = this.ctx.viewCamera;
    cam.updateMatrixWorld();
    vcam.updateMatrixWorld();
    this._p2.copy(pos);
    vcam.worldToLocal(this._p2);
    cam.localToWorld(this._p2);
    return this._p2;
  }

  /** Convert a world-space point+dir into viewmodel-scene space. */
  _toView(pos, dir) {
    const cam = this.ctx.camera;
    const vcam = this.ctx.viewCamera;
    cam.updateMatrixWorld();
    vcam.updateMatrixWorld();
    this._p2.copy(pos);
    cam.worldToLocal(this._p2);
    vcam.localToWorld(this._p2);
    this._d2.copy(dir).transformDirection(cam.matrixWorldInverse).transformDirection(vcam.matrixWorld);
    this._d2.normalize();
  }

  /** A travelling tracer round. */
  tracer(from, to, speed) {
    if (!from || !to) return;
    this.now = this.ctx.time.elapsed;
    spawnTracer(this, from, to, speed);
  }

  /** Full explosion: fireball, shockwave, debris, smoke column, light, scorch. */
  explosion(e) {
    this.now = this.ctx.time.elapsed;
    explode(this, e);
  }

  /** Eject a brass casing as a physics body. */
  spawnShell(position, velocity, opts) {
    if (!position) return;
    this.now = this.ctx.time.elapsed;
    this.shells.spawn(position, velocity, opts);
  }

  /**
   * Project a decal onto the static world.
   * @param {THREE.Vector3} point
   * @param {THREE.Vector3} normal
   */
  addDecal(point, normal, opts) {
    if (this._suppressDecals) return false;
    const o = this._decalOpts;
    this._p.copy(point);
    this._n.copy(normal);
    o.size = opts.size ?? 0.15;
    o.tile = opts.tile ?? 0;
    o.roll = opts.roll ?? this.rng.float() * Math.PI * 2;
    o.life = opts.life ?? 60;
    o.fade = opts.fade ?? 0.72;
    o.opacity = opts.opacity ?? 1;
    o.maxAngle = opts.maxAngle ?? 62;
    o.depth = opts.depth ?? Math.max(0.04, o.size * 0.32);
    o.flip = opts.flip ?? this.rng.float() < 0.5;
    o.now = this.now;
    const ph = this.physics;
    o.world = ph?.staticWorld ?? null;
    o.mask = ph?.MASK?.WORLD ?? 0xffff;
    if (opts.noFallback && !o.world) return false;
    const ok = this.decals.add(o);
    if (ok) this.stats.decals++;
    return ok;
  }

  /**
   * Scalar-argument decal, so a recipe can place one without touching a
   * Vector3. Everything in the open-world set goes through this: at 60 skid
   * events a second a `new THREE.Vector3()` per decal is a bug (hard rule 5).
   */
  addDecal2(x, y, z, nx, ny, nz, opts) {
    this._tmpA.set(x, y, z);
    this._tmpB.set(nx, ny, nz);
    return this.addDecal(this._tmpA, this._tmpB, opts);
  }

  /* ===================================================================== */
  /*  open-world reactions                                                 */
  /* ===================================================================== */

  /** `vehicle:skid` — the ribbon and everything the contact patch throws up. */
  onSkid(e) {
    this.now = this.ctx.time.elapsed;
    this.skid.onSkid(e, this.now, this._skidDt);
  }

  /** `vehicle:collision` — sparks, debris, glass, scrapes, a light flash. */
  onVehicleCollision(e) {
    this.now = this.ctx.time.elapsed;
    this._readPaint(e?.vehicle);
    this.vehicleFx.onCollision(e, this.now);
  }

  /** `vehicle:destroyed` — the full wreck sequence. */
  onVehicleDestroyed(e) {
    this.now = this.ctx.time.elapsed;
    this._readPaint(e?.vehicle);
    this.vehicleFx.onDestroyed(e, this.now);
    this.worldFx.startle(
      e?.point?.x ?? 0,
      e?.point?.y ?? 0,
      e?.point?.z ?? 0,
      1.4,
      this.now
    );
  }

  /**
   * `vehicle:engine` — exhaust, and the smoke a wounded engine makes.
   *
   * Payload is `{ vehicle, rpm, throttle, gear, load, speed }`. We only need
   * `load` and a position, and if the handle exposes a health field we take
   * that too so the damage stages advance without a dedicated event.
   */
  onVehicleEngine(e) {
    if (!e?.vehicle) return;
    const veh = e.vehicle;
    this.now = this.ctx.time.elapsed;
    const health = veh.health ?? veh.hp ?? veh.condition;
    if (typeof health === 'number') {
      // Accept 0..1 or 0..100.
      this.vehicleFx.setHealth(veh, health > 1.5 ? health / 100 : health, this.now);
    }
    // Exhaust is emitted from the `update` sweep so it is rate-limited across
    // every vehicle at once rather than per event.
    veh.__fxLoad = clamp(e.load ?? e.throttle ?? 0.15, 0, 1);
  }

  onVehicleEnter(e) {
    if (e?.actor && e.actor !== 'player' && e.actor?.isPlayer !== true) return;
    this.rain.wipePeriod = 2.35;
    this.rain._inVehicle = true;
  }

  onVehicleExit(e) {
    if (e?.actor && e.actor !== 'player' && e.actor?.isPlayer !== true) return;
    this.rain._inVehicle = false;
  }

  /**
   * `weather:change { state, wetness, rain, wind }`.
   *
   * `wind` is accepted either as a scalar 0..1 (which is what `materials`
   * consumes) or as a vector — a scalar is turned into a wind velocity on a
   * direction that only changes slowly, because a wind that swings around
   * between weather ticks makes every plume in the city snap sideways at once.
   */
  onWeather(e) {
    if (!e) return;
    this.rain.onWeather(e);
    if (e.wetness !== undefined) this.wetness = clamp(e.wetness, 0, 1);
    const w = e.wind;
    if (w && typeof w === 'object') {
      this.windVec.set(w.x ?? 0, w.y ?? 0, w.z ?? 0);
    } else if (typeof w === 'number') {
      // 0..1 -> 0..14 m/s. The bearing drifts with the weather seed, not per call.
      const speed = clamp(w, 0, 1) * 14;
      const a = this._windAngle ?? (this._windAngle = this.rng.float() * Math.PI * 2);
      this.windVec.set(Math.cos(a) * speed, 0, Math.sin(a) * speed);
    }
    // A storm blows harder even if nobody told us a wind.
    if (w === undefined && e.rain !== undefined) {
      const speed = 1.2 + clamp(e.rain, 0, 1) * 9;
      const a = this._windAngle ?? (this._windAngle = this.rng.float() * Math.PI * 2);
      this.windVec.set(Math.cos(a) * speed, 0, Math.sin(a) * speed);
    }
  }

  /** `time:hour` — cold air (visible exhaust) and dawn river mist. */
  onHour(e) {
    const h = e?.hour;
    if (typeof h !== 'number') return;
    // Coldest just before dawn, warmest mid-afternoon.
    const t = ((h - 15) / 24) * Math.PI * 2;
    this.coldAir = clamp(0.42 + 0.42 * Math.cos(t), 0, 1);
    // River mist wants cold air over warm water: dawn, and only dawn.
    const dawn = Math.exp(-((h - 6.2) ** 2) / 3.2);
    this.mistGain = clamp(dawn * 0.9 + this.wetness * 0.3, 0, 1);
  }

  /** Ask a vehicle handle what colour it is, for paint flakes and debris. */
  _readPaint(veh) {
    const c = veh?.color ?? veh?.paint ?? veh?.bodyColor ?? veh?.tint;
    if (!c) return;
    if (typeof c === 'number') {
      _col.setHex(c, THREE.SRGBColorSpace);
      this.paintTint.set(_col.r, _col.g, _col.b);
    } else if (c.isColor) {
      this.paintTint.set(c.r, c.g, c.b);
    } else if (c.r !== undefined) {
      this.paintTint.set(c.r, c.g, c.b);
    }
  }

  /** Put a flock of birds up. Anything loud can call it. */
  startleBirds(x, y, z, strength = 1) {
    return this.worldFx.startle(x, y, z, strength, this.now);
  }

  /** Register a persistent steam vent (a street grate, a mill stack). */
  addSteamVent(x, y, z, o = {}) {
    this._tmpA.set(x, y, z);
    return this.ambience.addSource(this._tmpA, {
      radius: o.radius ?? 0.32,
      rate: o.rate ?? 5,
      rise: o.rise ?? 2.0,
      dark: o.dark ?? 0.68,
      life: o.life ?? 2.4,
      growth: o.growth ?? 4.4,
      haze: o.haze ?? 0.14,
      steam: true,
      wind: o.wind ?? 0.85,
      alpha: o.alpha ?? 0.34,
      duration: o.duration ?? Infinity,
      cull: o.cull ?? 150,
      object: o.object,
    });
  }

  /** Register a heat-shimmer source (blast furnace, flare stack, hot roof). */
  addHeatSource(x, y, z, o = {}) {
    this._tmpA.set(x, y, z);
    return this.ambience.addHeat(this._tmpA, o, o.object ?? null);
  }

  /** Soot ring under an explosion. */
  scorch(x, y, z, radius) {
    const ph = this.physics;
    this._tmpA.set(x, y + 0.4, z);
    this._tmpB.set(0, -1, 0);
    let px = x;
    let py = y;
    let pz = z;
    let nx = 0;
    let ny = 1;
    let nz = 0;
    if (ph?.raycast) {
      const hit = ph.raycast(this._tmpA, this._tmpB, radius * 1.5 + 1, ph.MASK.WORLD);
      if (hit?.hit) {
        px = hit.point.x;
        py = hit.point.y;
        pz = hit.point.z;
        nx = hit.normal.x;
        ny = hit.normal.y;
        nz = hit.normal.z;
      }
    }
    this._tmpA.set(px, py, pz);
    this._tmpB.set(nx, ny, nz);
    this.addDecal(this._tmpA, this._tmpB, {
      tile: D.SCORCH,
      size: radius * 1.05,
      life: 120,
      fade: 0.55,
      opacity: 0.9,
      maxAngle: 80,
      depth: radius * 0.35,
    });
  }

  /** Blood on whatever is behind the body we just hit. */
  bloodSpatterBehind(point, incident) {
    const ph = this.physics;
    if (!ph?.raycast) return;
    this._tmpA.copy(point);
    this._tmpB.copy(incident);
    const hit = ph.raycast(this._tmpA, this._tmpB, 2.6, ph.MASK.WORLD);
    if (!hit?.hit) return;
    this.addDecal(hit.point, hit.normal, {
      tile: this.rng.float() < 0.5 ? D.BLOOD_A : D.BLOOD_B,
      size: this.rng.range(0.32, 0.62),
      life: 90,
      fade: 0.8,
      opacity: this.rng.range(0.7, 1),
      maxAngle: 70,
    });
  }

  /**
   * World-space direction toward the sun, for self-shadowing a particle cluster.
   *
   * The lit-particle shader already shades each sprite, but every sub-puff of a
   * dust cloud gets the same treatment, so the cloud has no lit side. Recipes use
   * this to bias the *authored* colour of each sub-puff by which way it was
   * thrown: the ones going into the light start pale, the ones going away start
   * in their own shadow. Falls back to straight up before `sky` reports in.
   */
  sunWorld() {
    const d = this.render?.sunDir;
    const o = this._sunW ?? (this._sunW = { x: 0, y: 1, z: 0 });
    if (d) {
      o.x = d.x;
      o.y = d.y;
      o.z = d.z;
    }
    return o;
  }

  /** Refraction sprite (hot gas, shimmer). */
  haze(x, y, z, radius, grow, life, strength, tile = P.SMOKE_A) {
    this.hazeSys.emit(this.now, x, y, z, radius, grow, life, strength, tile, this.rng.float());
  }

  /** Expanding shockwave ring in the refraction buffer. */
  hazeRing(x, y, z, radius, grow, life, strength) {
    this.hazeSys.emit(this.now, x, y, z, radius, grow, life, strength, P.RING, this.rng.float());
  }

  addSmokeColumn(x, y, z, o) {
    return this.ambience.addColumn(x, y, z, o);
  }

  /** Persistent smoke source — pass `{ object }` to have it follow a prop. */
  addSmokeSource(position, o) {
    return this.ambience.addSource(position, o);
  }

  removeSmokeSource(tag) {
    this.ambience.remove(tag);
  }

  /** Let `sky` drive the values smoke and dust are lit with. */
  setAmbient(topColor, bottomColor, sunColor) {
    if (topColor) this._ambTop.set(topColor.r ?? topColor.x, topColor.g ?? topColor.y, topColor.b ?? topColor.z);
    if (bottomColor)
      this._ambBot.set(bottomColor.r ?? bottomColor.x, bottomColor.g ?? bottomColor.y, bottomColor.b ?? bottomColor.z);
    if (sunColor) this._sunCol.set(sunColor.r ?? sunColor.x, sunColor.g ?? sunColor.y, sunColor.b ?? sunColor.z);
    this._ambientOverride = true;
  }

  /**
   * FREEZE THE WORLD FOR `seconds` OF WALL CLOCK.
   *
   * `stop(heavy ? 0.075 : 0.04)` on a connecting swing, `stop(0.09)` on a
   * parry. Extends a live stall, never sums with it.
   *
   * @returns {boolean} true if the world is being held
   */
  stop(seconds) {
    return this.hitstop.request(seconds);
  }

  /** Long-form alias — `fx.stop` reads like "shut the system down" out of context. */
  hitStop(seconds) {
    return this.hitstop.request(seconds);
  }

  /**
   * A one-shot spatialised voice, routed through `audio`'s public `play()`.
   *
   * The melee kit has no voices of its own in `src/audio/` and that file is not
   * ours to extend, so each beat borrows the nearest authored one and says so
   * here rather than in three call sites:
   *
   *   whiff   'cloth'   the swish of a sleeve through air — a swing that met
   *                     nothing is exactly that sound and nothing else
   *   parry   'impact' on `metal` + the 'armour' sting, which is the mix's
   *                     existing "a plate stopped that" cue
   *
   * When `audio` grows real `whiff`/`parry` voices this routes to them by name
   * with no change here: `play()` falls through to `uiSound` for any kind it
   * does not know, so passing the semantic name is already forward-compatible.
   */
  meleeSound(kind, position, level = 1) {
    const a = this._audio ?? (this._audio = this.ctx.peek('audio'));
    if (!a) return false;
    if (kind === 'whiff') {
      if (!position) return a.play?.('cloth', { level });
      return a.play?.('cloth', position, { level });
    }
    if (kind === 'parry') {
      if (position) a.play?.('impact', position, { surface: 'metal', energy: 1.2 });
      return a.ui?.('armour', level) ?? false;
    }
    return a.play?.(kind, position, { level }) ?? false;
  }

  audioPing(x, y, z, gain) {
    const a = this._audio ?? (this._audio = this.ctx.peek('audio'));
    if (!a) return;
    this._tmpA.set(x, y, z);
    if (typeof a.playShell === 'function') a.playShell(this._tmpA, gain);
    else if (typeof a.play === 'function') a.play('shell', this._tmpA, gain);
  }

  /* ===================================================================== */
  /*  gameplay reactions                                                   */
  /* ===================================================================== */

  onActorDeath(e) {
    if (!e?.point) return;
    this.now = this.ctx.time.elapsed;
    const rng = this.rng;
    // a heavier burst of mist than a body shot, plus spatter on the ground
    this._n.set(0, 1, 0);
    for (let i = 0; i < Math.round(8 * this.pScale) + 3; i++) {
      cone(V, rng, 0, 1, 0, 1.4, 0.7);
      const s = resetSpawn();
      s.x = e.point.x; s.y = e.point.y; s.z = e.point.z;
      s.vx = V.x * rng.range(0.6, 2.4);
      s.vy = V.y * rng.range(0.4, 1.6);
      s.vz = V.z * rng.range(0.6, 2.4);
      s.tile = i % 2 ? P.MIST : P.SMOKE_A;
      s.size0 = rng.range(0.05, 0.1);
      s.size1 = rng.range(0.2, 0.4);
      s.sizeCurve = 0.5;
      s.life = rng.range(0.4, 0.8);
      s.drag = 5;
      s.gravity = -3.5;
      s.rot = rng.float() * 6.283;
      s.r0 = 0.3; s.g0 = 0.03; s.b0 = 0.026;
      s.r1 = 0.15; s.g1 = 0.015; s.b1 = 0.013;
      s.alpha = rng.range(0.4, 0.75);
      s.alphaCurve = 1.5;
      s.soft = 0.2;
      s.seed = rng.float();
      this.emitLit(s);
    }
    const ph = this.physics;
    if (ph?.groundHeight) {
      const gy = ph.groundHeight(e.point.x, e.point.z, e.point.y + 1);
      if (Number.isFinite(gy)) {
        this._tmpA.set(e.point.x, gy, e.point.z);
        this._tmpB.set(0, 1, 0);
        this.addDecal(this._tmpA, this._tmpB, {
          tile: this.rng.float() < 0.5 ? D.BLOOD_A : D.BLOOD_B,
          size: this.rng.range(0.5, 0.9),
          life: 120,
          fade: 0.85,
          maxAngle: 80,
        });
      }
    }
  }

  onLand(e) {
    const v = Math.abs(e?.velocity ?? 0);
    if (v < 3.2) return;
    this.now = this.ctx.time.elapsed;
    const rng = this.rng;
    const cam = this.ctx.camera;
    const ph = this.physics;
    const x = cam.position.x;
    const z = cam.position.z;
    let y = cam.position.y - UNITS.playerHeight + UNITS.eyeOffset;
    if (ph?.groundHeight) {
      const gy = ph.groundHeight(x, z, cam.position.y + 1);
      if (Number.isFinite(gy)) y = gy;
    }
    const strength = clamp((v - 3) / 7, 0.2, 1.3);
    for (let i = 0; i < Math.round(7 * this.pScale * strength) + 2; i++) {
      const a = rng.float() * 6.283;
      const sp = rng.range(0.7, 2.4) * strength;
      const s = resetSpawn();
      s.x = x + Math.cos(a) * 0.22;
      s.y = y + 0.03;
      s.z = z + Math.sin(a) * 0.22;
      s.vx = Math.cos(a) * sp;
      s.vy = rng.range(0.1, 0.6);
      s.vz = Math.sin(a) * sp;
      s.tile = P.DUST;
      s.size0 = rng.range(0.05, 0.1);
      s.size1 = rng.range(0.3, 0.55);
      s.sizeCurve = 0.45;
      s.life = rng.range(0.5, 1.0);
      s.drag = 3.2;
      s.gravity = -0.6;
      s.rot = rng.float() * 6.283;
      s.spin = rng.signed() * 1.2;
      s.r0 = 0.48; s.g0 = 0.44; s.b0 = 0.39;
      s.r1 = 0.4; s.g1 = 0.37; s.b1 = 0.33;
      s.alpha = rng.range(0.25, 0.5) * strength;
      s.alphaCurve = 1.6;
      s.soft = 0.3;
      s.turb = 0.05; s.turbFreq = 2;
      s.seed = rng.float();
      this.emitLit(s);
    }
  }

  onFootstep(e) {
    if (!e?.running || !e.position) return;
    if (this.rng.float() > 0.55) return;
    this.now = this.ctx.time.elapsed;
    const rng = this.rng;
    const s = resetSpawn();
    s.x = e.position.x + rng.signed() * 0.08;
    s.y = e.position.y + 0.02;
    s.z = e.position.z + rng.signed() * 0.08;
    s.vy = rng.range(0.1, 0.35);
    s.vx = rng.signed() * 0.3;
    s.vz = rng.signed() * 0.3;
    s.tile = P.DUST;
    s.size0 = 0.04;
    s.size1 = rng.range(0.18, 0.32);
    s.sizeCurve = 0.45;
    s.life = rng.range(0.4, 0.75);
    s.drag = 3.4;
    s.gravity = -0.5;
    s.rot = rng.float() * 6.283;
    s.r0 = 0.46; s.g0 = 0.42; s.b0 = 0.37;
    s.r1 = 0.4; s.g1 = 0.36; s.b1 = 0.32;
    s.alpha = rng.range(0.1, 0.22);
    s.alphaCurve = 1.7;
    s.soft = 0.25;
    s.seed = rng.float();
    this.emitLit(s);
  }

  /* ===================================================================== */
  /*  frame                                                                */
  /* ===================================================================== */

  update(dt, ctx) {
    this.now = ctx.time.elapsed;
    /* Before anything else reads the clock this frame. `fx` sorts after
     * `player` and `weapons`, so a swing that connected earlier in THIS frame
     * has its stall standing on `time.scale` by the time the frame ends — and
     * `engine.step` samples the scale at the top of the next frame. */
    this.hitstop.update();
    this._skidDt = dt > 1e-4 ? dt : 1 / 60;
    this._syncLighting(ctx);
    this.lights.update(dt);
    this.viewLights?.update(dt);
    this._runScript(dt);
    this._driveStageCar(dt);
    this.ambience.sunFactor = this._sunFactor;
    this.ambience.update(dt, this.now, ctx.camera, ctx.scene);
    this.skid.update(dt, this.now);
    this.vehicleFx.update(dt, this.now);
    this.rain.update(dt, this.now, ctx.camera);
    this.fountain.update(dt, this.now, ctx.camera);
    this.worldFx.update(dt, this.now, ctx.camera);
    this._traffic(dt, ctx);
  }

  /**
   * Everything that has to be read OFF the vehicle list rather than pushed to
   * us by an event: road spray behind a moving car and exhaust from an idling
   * one. `vehicles` publishes neither as an event and should not have to.
   *
   * The whole sweep is budgeted as one: the per-vehicle `dt` is divided by the
   * number of cars actually being serviced, so 30 cars in frame cost the same
   * particle spend as 3. That is what keeps a traffic jam in the rain from
   * eating the entire ring in one frame.
   */
  _traffic(dt, ctx) {
    const vs = ctx.peek('vehicles');
    const list = vs?.vehicles;
    if (!list || !list.length) return;
    const cam = ctx.camera;
    const wetEnough = Math.max(this.rain.wetness, this.rain.rain * 0.8) > 0.12;
    const coldEnough = this.coldAir > 0.08;
    if (!wetEnough && !coldEnough) return;

    // First pass: how many are close enough to matter?
    let serviced = 0;
    const R2 = 62 * 62;
    for (let i = 0; i < list.length && serviced < 24; i++) {
      const v = list[i];
      if (!v) continue;
      posOf(v, this._tmpA);
      if (this._tmpA.distanceToSquared(cam.position) > R2) continue;
      serviced++;
    }
    if (!serviced) return;
    const share = dt / serviced;

    let done = 0;
    for (let i = 0; i < list.length && done < 24; i++) {
      const v = list[i];
      if (!v) continue;
      posOf(v, this._tmpA);
      const d2 = this._tmpA.distanceToSquared(cam.position);
      if (d2 > R2) continue;
      done++;
      velOf(v, this._tmpB);
      const speed = this._tmpB.length();
      // Falls off with distance so a car 60 m away is not spending as much as
      // the one filling the frame.
      const gain = 1 - Math.min(1, d2 / R2) * 0.7;

      if (wetEnough && speed > 3) {
        // One plume per axle, at the rear of each, offset behind the centre.
        const inv = 1 / speed;
        const dx = this._tmpB.x * inv;
        const dz = this._tmpB.z * inv;
        const wheels = wheelsOf(v);
        if (wheels && wheels.length) {
          for (let k = 0; k < wheels.length; k++) {
            const w = wheels[k];
            if (!wheelPos(w, this._tmpC)) continue;
            this.rain.wheelSpray(
              this._tmpC.x, this._tmpC.y, this._tmpC.z,
              this._tmpB.x, this._tmpB.y, this._tmpB.z,
              speed, share / wheels.length, this.now, gain
            );
          }
        } else {
          // No wheel list published: two plumes behind the body is close enough
          // at any distance a critic can see it from.
          for (let k = -1; k <= 1; k += 2) {
            this.rain.wheelSpray(
              this._tmpA.x - dx * 1.6 - dz * 0.75 * k,
              this._tmpA.y - 0.45,
              this._tmpA.z - dz * 1.6 + dx * 0.75 * k,
              this._tmpB.x, this._tmpB.y, this._tmpB.z,
              speed, share * 0.5, this.now, gain
            );
          }
        }

        // Standing water is a different effect entirely: displaced water thrown
        // sideways in a sheet, not mist. `world` is the authority on where it is.
        const w = this._world ?? (this._world = ctx.peek('world'));
        if (w?.isWater && speed > 4) {
          const fx2 = this._tmpA.x - dx * 1.5;
          const fz2 = this._tmpA.z - dz * 1.5;
          if (w.isWater(fx2, fz2)) {
            this.rain.puddleHit(
              fx2, this._tmpA.y - 0.5, fz2,
              this._tmpB.x, this._tmpB.y, this._tmpB.z,
              speed, share, this.now, gain
            );
          }
        }
      }

      if (coldEnough && speed < 26) {
        const load = v.__fxLoad ?? 0.16;
        // Tailpipe: behind and low. Uses the object frame when there is one so
        // it stays on the pipe through a turn.
        const obj = objOf(v);
        if (obj) {
          obj.updateWorldMatrix(true, false);
          this._tmpC.set(0.34, 0.22, 2.05).applyMatrix4(obj.matrixWorld);
        } else {
          const inv = speed > 0.2 ? 1 / speed : 0;
          this._tmpC.set(
            this._tmpA.x - this._tmpB.x * inv * 2.05,
            this._tmpA.y - 0.42,
            this._tmpA.z - this._tmpB.z * inv * 2.05
          );
        }
        this.worldFx.exhaust(
          this._tmpC.x, this._tmpC.y, this._tmpC.z,
          this._tmpB.x * 0.35, 0.2, this._tmpB.z * 0.35,
          load, share * gain, this.now
        );
      }
    }
  }

  lateUpdate(dt, ctx) {
    this.now = ctx.time.elapsed;
    this.shells.update(dt, this.now);
    const r = this.render;
    const depth = r?.depthTexture ?? null;
    const w = r?.screenSize?.width ?? 1920;
    const h = r?.screenSize?.height ?? 1080;
    for (const l of this.layers) {
      l.uniforms.uDepth.value = depth;
      l.uniforms.uSoftEnable.value.x = depth ? 1 : 0;
      l.uniforms.uRes.value.set(w, h);
      l.flush(this.now);
    }
    if (this._viewAttached) {
      this.viewAdd.flush(this.now);
      this.viewLit.flush(this.now);
    }
    this.decals.flush(this.now);
    this.skid.flush(this.now);
    this.hazeSys.update(this.now, depth, ctx.camera);
    this.stats.live = this.add.spawned + this.lit.spawned;
    this.stats.skid = this.skid.laid;

    // Self-scheduled pre-warm, on the second frame.
    //
    // It cannot run any earlier and be useful: the program cache key carries the
    // number of *visible* lights, and the renderer only settles that when it
    // culls punctual lights inside its first rendered frame. Compiling before
    // that (which is where `src/core/prewarm.js` would call this from) builds a
    // permutation the frame loop never asks for and the real one still compiles
    // later, on whichever frame first draws a spark or a bullet hole. One frame
    // in, the light set is the one gameplay will use.
    if (!this._warmed && ++this._warmTicks > 1) this.prewarmMaterials();
  }

  _syncLighting(ctx) {
    const r = this.render;
    const cam = ctx.camera;
    // Sun direction and colour come from whatever light the renderer decided is
    // the sun, so smoke is lit by the same key as the world.
    const sun = r?.activeSun;
    if (r?.sunDir) {
      this._sunView.copy(r.sunDir).transformDirection(cam.matrixWorldInverse).normalize();
    }
    let sunI = 4.3;
    if (sun) {
      sunI = sun.intensity;
      if (!this._ambientOverride) {
        this._sunCol.set(sun.color.r * sunI, sun.color.g * sunI, sun.color.b * sunI);
      }
    }
    this._sunFactor = clamp(sunI / 4.3, 0, 1.6);

    if (!this._ambientOverride) {
      // Clear-sky irradiance is roughly a fifth of direct sun, blue above and
      // bounced-warm below. `sky` can override this wholesale.
      const a = clamp(sunI * 0.22, 0.02, 3.0);
      this._ambTop.set(a * 0.78, a * 0.92, a * 1.25);
      this._ambBot.set(a * 0.5, a * 0.44, a * 0.38);
    }
    this._upView.set(0, 1, 0).transformDirection(cam.matrixWorldInverse).normalize();
    this._syncPointLights(ctx);

    const fog = ctx.scene.fog;
    if (fog) {
      this._fog.set(fog.color.r, fog.color.g, fog.color.b, fog.density ?? 1 / Math.max(1, fog.far ?? 400));
    } else {
      this._fog.w = 0;
    }

    for (const l of this.layers) this._pushLighting(l);
    if (this._viewAttached) {
      // The viewmodel camera has its own basis; recompute against it.
      const vcam = this.ctx.viewCamera;
      this._pushLighting(this.viewAdd);
      this._pushLighting(this.viewLit);
      if (r?.sunDir) {
        this.viewLit.uniforms.uSunDir.value
          .copy(r.sunDir)
          .transformDirection(vcam.matrixWorldInverse)
          .normalize();
        this.viewAdd.uniforms.uSunDir.value.copy(this.viewLit.uniforms.uSunDir.value);
      }
      this.viewLit.uniforms.uUpView.value.set(0, 1, 0).transformDirection(vcam.matrixWorldInverse).normalize();
    }
  }

  _pushLighting(l) {
    l.uniforms.uSunDir.value.copy(this._sunView);
    l.uniforms.uSunCol.value.copy(this._sunCol);
    l.uniforms.uAmbTop.value.copy(this._ambTop);
    l.uniforms.uAmbBot.value.copy(this._ambBot);
    l.uniforms.uUpView.value.copy(this._upView);
    l.uniforms.uFog.value.copy(this._fog);
    l.uniforms.uWind.value.copy(this.windVec);
    const p = l.uniforms.uPtPos.value;
    const c = l.uniforms.uPtCol.value;
    p[0].copy(this._pt0);
    p[1].copy(this._pt1);
    c[0].copy(this._ptc0);
    c[1].copy(this._ptc1);
  }

  /**
   * Pick the two brightest dynamic lights and hand them to the smoke shader in
   * VIEW space.
   *
   * This is what makes a burnout at night look like a burnout: the plume is lit
   * from inside by the car's own lights and by any spark burst going off in it.
   * Two is the number, fixed forever — the array length is a shader permutation
   * key exactly like the scene light count (ARCHITECTURE.md), so it can never
   * vary at runtime. Unused slots are zero-colour and cost one multiply.
   *
   * Candidates are the FX flash pool plus anything a subsystem registered with
   * `fx.registerSmokeLight(light)` (headlights are the intended caller).
   */
  _syncPointLights(ctx) {
    const cam = ctx.camera;
    // Ranking state lives on `this`, and the two helpers are methods, not
    // closures created here. Two arrow functions per frame is still an
    // allocation per frame (hard rule 5) even though they are small.
    this._b0 = -1;
    this._b1 = -1;
    this._l0 = null;
    this._l1 = null;
    for (const e of this.lights.lights) this._considerLight(e.light, cam);
    const ext = this._smokeLights;
    if (ext) for (let i = 0; i < ext.length; i++) this._considerLight(ext[i], cam);
    this._writeLight(this._l0, this._pt0, this._ptc0, cam);
    this._writeLight(this._l1, this._pt1, this._ptc1, cam);
  }

  _considerLight(light, cam) {
    if (!light || light.intensity <= 0.0001) return;
    this._tmpC.setFromMatrixPosition(light.matrixWorld ?? light.matrix);
    if (!Number.isFinite(this._tmpC.x)) return;
    const d2 = Math.max(1, this._tmpC.distanceToSquared(cam.position));
    // Rank on apparent brightness at the camera, not raw intensity: a 900 cd
    // fireball 200 m away must not evict a headlight two metres in front.
    const score = light.intensity / d2;
    if (score > this._b0) {
      this._b1 = this._b0;
      this._l1 = this._l0;
      this._b0 = score;
      this._l0 = light;
    } else if (score > this._b1) {
      this._b1 = score;
      this._l1 = light;
    }
  }

  _writeLight(light, pos, col, cam) {
    if (!light) {
      col.set(0, 0, 0);
      pos.set(0, 0, 0, 0.01);
      return;
    }
    this._tmpC.setFromMatrixPosition(light.matrixWorld);
    this._tmpC.applyMatrix4(cam.matrixWorldInverse);
    const range = light.distance > 0 ? light.distance : 40;
    pos.set(this._tmpC.x, this._tmpC.y, this._tmpC.z, 1 / (range * range));
    const i = light.intensity;
    col.set(light.color.r * i, light.color.g * i, light.color.b * i);
  }

  /**
   * Let another subsystem donate a light that smoke should be lit by — the
   * intended caller is `vehicles`, for headlights.
   *
   * We never take ownership: the light stays in the caller's scene graph and
   * under the caller's culling. All we do is read its world position, colour and
   * intensity once a frame. Registering therefore cannot change the scene's
   * visible-light count and cannot trigger a recompile.
   */
  registerSmokeLight(light) {
    const list = (this._smokeLights ??= []);
    if (light && !list.includes(light)) list.push(light);
    return () => {
      const i = list.indexOf(light);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /* ===================================================================== */
  /*  debug staging                                                        */
  /* ===================================================================== */

  /**
   * Stage a photogenic moment for the screenshot harness.
   *
   * The capture pumps ~90 fixed frames after applying a shot, so a single burst
   * would be long gone by the time the PNG is written. Instead we run a looping
   * timeline: old hits that have left decals and hanging dust, a couple of hits
   * caught mid-expansion, and one hit two frames old with its flash and sparks
   * still hot — which is what a real combat frame looks like.
   */
  debugBurst(kind = 'wall') {
    // 'none' stops a previously staged loop. The capture harness applies shots
    // back to back in one session, so a burst staged for `impacts` would
    // otherwise still be walking rounds across a wall during every later shot.
    if (kind === 'none' || kind === 'clear' || kind === 'off') {
      this._script.length = 0;
      this._scriptCursor = 0;
      this._scriptTime = 0;
      this._scriptPeriod = 0;
      this._stageRain(0);
      this._stageCar = null;
      this._clearStageVents();
      return { staged: 'none' };
    }
    this.now = this.ctx.time.elapsed;
    const staged = this._stageOpenWorld(kind);
    if (staged) return staged;
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    this._camPos.setFromMatrixPosition(cam.matrixWorld);
    const target = this._findTarget();
    this._script.length = 0;
    this._scriptCursor = 0;
    this._scriptTime = 0;
    this._scriptPeriod = 1.56;

    const rng = this.rng;
    const at = (t, fn) => this._script.push({ t, fn });

    if (kind === 'explosion') {
      // Two detonations per loop, half a period apart, so whenever the harness
      // presses the shutter one of them is inside its first half second —
      // fireball and shockwave rather than only the smoke afterwards.
      this._scriptPeriod = 1.1;
      const boom = (side) => {
        this._tmpA
          .copy(target.point)
          .addScaledVector(target.normal, 1.1)
          .addScaledVector(target.tangent, side * 1.6);
        this.explosion({ position: this._tmpA, radius: 3.6, damage: 120 });
      };
      at(0.02, () => boom(-1));
      at(0.56, () => boom(1));
      this._stageWallHits(at, target, 6, 0.1, 0.95);
      return { staged: 'explosion', at: target.point.toArray() };
    }

    if (kind === 'muzzle') {
      // Cyclic rate shorter than the flash lifetime: a flash is always lit.
      this._scriptPeriod = 0.44;
      for (let i = 0; i < 8; i++) {
        const t = i * 0.055;
        at(t, () => this._stageMuzzle());
        if (i % 3 === 0) at(t + 0.01, () => this._stageShell());
        if (i % 2 === 0) at(t + 0.004, () => this._stageTracer(target));
      }
      return { staged: 'muzzle' };
    }

    if (kind === 'combat' || kind === 'firefight') {
      this._scriptPeriod = 1.6;
      this._stageWallHits(at, target, 9, 0.04, 1.2);
      at(1.3, () => this._impactAt(target, rng.signed() * 0.7, rng.range(-0.2, 0.5), 'metal'));
      at(1.42, () => this._impactAt(target, rng.signed() * 0.6, rng.range(-0.2, 0.5), null));
      at(1.5, () => this._impactAt(target, rng.signed() * 0.5, rng.range(-0.1, 0.6), 'metal'));
      at(1.36, () => this._stageTracer(target));
      at(1.44, () => this._stageCrossfire());
      at(1.12, () => this._stageShell());
      at(1.34, () => this._stageShell());
      at(1.52, () => this._stageMuzzle());
      return { staged: 'combat' };
    }

    // Default: the 'impacts' shot — sustained fire walking across a wall.
    //
    // The cadence matters more than the choreography. The harness decides when
    // it presses the shutter, so rounds land every 60 ms on a 0.9 s loop: at any
    // phase the newest hit is younger than one cadence (flash and sparks still
    // hot), the ones before it are mid-expansion, and several loops' worth of
    // decals and hanging dust have already built up behind them.
    this._scriptPeriod = 0.9;
    // 50 ms cadence against a 75 ms flash: strictly shorter than the flash
    // lifetime, so there is *always* a hot impact somewhere in the frame.
    this._stageWallHits(at, target, 18, 0.0, 0.85);
    console.info(
      `[fx] burst target ${target.surface} at ${target.distance.toFixed(2)}m ` +
        `n=(${target.normal.x.toFixed(2)},${target.normal.y.toFixed(2)},${target.normal.z.toFixed(2)}) ` +
        `support=${this._targetSupport ?? -1} span=${target.spanU.toFixed(2)}x${target.spanV.toFixed(2)}`
    );
    at(0.30, () => this._stageCrossfire());
    at(0.74, () => this._stageCrossfire());
    at(0.18, () => this._stageShell());
    at(0.52, () => this._stageShell());
    return { staged: kind, at: target.point.toArray(), surface: target.surface };
  }

  /* ---------------------------------------------------------------- */
  /*  open-world debug stages                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Stages for the driving/weather set, so each effect can be reviewed on its
   * own: 'skid', 'rain', 'sparks', 'steam', 'wreck'.
   *
   * These do NOT depend on `vehicles` being implemented. They synthesise the
   * events the contract says `vehicles` will emit and drive a virtual car on a
   * real arc across the real ground, which means the effect under review is
   * exactly the production path — the same listener, the same ribbon, the same
   * smoke — and not a bespoke preview.
   */
  _stageOpenWorld(kind) {
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    this._camPos.setFromMatrixPosition(cam.matrixWorld);
    this._tmpB.set(0, 0, -1).transformDirection(cam.matrixWorld);
    this._tmpB.y = 0;
    if (this._tmpB.lengthSq() < 1e-6) this._tmpB.set(0, 0, -1);
    this._tmpB.normalize();

    if (kind === 'skid' || kind === 'drift' || kind === 'burnout') {
      this._stageRain(0);
      this._script.length = 0;
      this._scriptPeriod = 0;
      this._startStageCar(kind === 'burnout' ? 'burnout' : 'drift');
      return { staged: kind };
    }

    if (kind === 'rain' || kind === 'storm' || kind === 'wet') {
      this._script.length = 0;
      this._scriptPeriod = 0;
      this._stageRain(1);
      // A car driving through it, so the road spray is in frame too — the spray
      // is the part that sells rain, and it cannot be reviewed without traffic.
      this._startStageCar('cruise');
      return { staged: 'rain' };
    }

    if (kind === 'sparks' || kind === 'grind' || kind === 'scrape') {
      this._stageRain(0);
      this._script.length = 0;
      this._scriptPeriod = 0;
      this._startStageCar('grind');
      return { staged: 'sparks' };
    }

    if (kind === 'steam' || kind === 'vents' || kind === 'ambience') {
      this._stageRain(0);
      this._script.length = 0;
      this._scriptPeriod = 0;
      this._stageCar = null;
      this._clearStageVents();
      const rng = this.rng;
      const ph = this.physics;
      const vents = (this._stageVents ??= []);
      for (let i = 0; i < 9; i++) {
        const d = 2.6 + i * 1.9;
        const off = rng.signed() * 2.8;
        const x = this._camPos.x + this._tmpB.x * d - this._tmpB.z * off;
        const z = this._camPos.z + this._tmpB.z * d + this._tmpB.x * off;
        let y = this._camPos.y - 1.7;
        if (ph?.groundHeight) {
          const g = ph.groundHeight(x, z, this._camPos.y + 5);
          if (Number.isFinite(g)) y = g;
        }
        // Per-instance variation: radius, rate and rise all scatter, so seven
        // grates are not seven copies of one plume.
        vents.push(
          this.addSteamVent(x, y + 0.04, z, {
            radius: rng.range(0.22, 0.48),
            rate: rng.range(5, 13),
            rise: rng.range(1.8, 3.4),
            alpha: rng.range(0.3, 0.55),
            life: rng.range(2.0, 3.6),
            growth: rng.range(3.8, 6.0),
          })
        );
      }
      // and the blast furnace shimmer, out beyond them
      this._stageHeat = this.addHeatSource(
        this._camPos.x + this._tmpB.x * 13,
        this._camPos.y - 1.2,
        this._camPos.z + this._tmpB.z * 13,
        { radius: 2.6, strength: 0.5, rate: 9, cull: 300 }
      );
      // Litter on the wind. ACROSS the view: the emitter seeds upwind of the
      // camera, so a wind blowing straight away from the eye puts every scrap
      // behind the lens and none of it in the shot.
      this.windVec.set(-this._tmpB.z * 6, 0, this._tmpB.x * 6);
      this.worldFx.litter = 1;
      return { staged: 'steam', vents: vents.length };
    }

    if (kind === 'wreck' || kind === 'vexplosion' || kind === 'carbomb') {
      this._stageRain(0);
      this._stageCar = null;
      this._script.length = 0;
      this._scriptCursor = 0;
      this._scriptTime = 0;
      // Two detonations per loop, offset, so whenever the shutter falls one of
      // them is inside its first half second — fireball and shock ring, not
      // only the smoke afterwards.
      this._scriptPeriod = 2.6;
      const ph = this.physics;
      const spot = (side) => {
        const d = 9 + side * 3;
        const x = this._camPos.x + this._tmpB.x * d - this._tmpB.z * side * 3.2;
        const z = this._camPos.z + this._tmpB.z * d + this._tmpB.x * side * 3.2;
        let y = this._camPos.y - 1.7;
        if (ph?.groundHeight) {
          const g = ph.groundHeight(x, z, this._camPos.y + 5);
          if (Number.isFinite(g)) y = g;
        }
        this._stagePt.set(x, y, z);
        return this._stagePt;
      };
      this._stagePt ??= new THREE.Vector3();
      const at = (t, fn) => this._script.push({ t, fn });
      at(0.02, () => {
        this.paintTint.set(0.34, 0.07, 0.05);
        this.onVehicleDestroyed({ vehicle: null, point: spot(-1) });
      });
      at(1.3, () => {
        this.paintTint.set(0.05, 0.11, 0.2);
        this.onVehicleDestroyed({ vehicle: null, point: spot(1) });
      });
      return { staged: 'wreck' };
    }

    return null;
  }

  _clearStageVents() {
    if (this._stageVents) {
      for (const t of this._stageVents) this.ambience.remove(t);
      this._stageVents.length = 0;
    }
    if (this._stageHeat !== undefined && this._stageHeat !== null) {
      this.ambience.heat.length = 0;
      this._stageHeat = null;
    }
  }

  _stageRain(level) {
    this.rain.setImmediate(level, level > 0 ? 0.9 : 0);
    this.wetness = level > 0 ? 0.9 : 0;
    // `sky` owns the falling streaks, so the stage asks IT for the storm rather
    // than drawing its own. Guarded: the FX-only rig has no sky, and there the
    // stage still exercises everything this system owns.
    const sky = this.ctx.peek('sky');
    if (sky?.setWeather) {
      try {
        sky.setWeather(level > 0 ? 'storm' : 'clear', { immediate: true });
      } catch {
        /* a sky with a different setWeather signature: not our business */
      }
    }
    if (level > 0) {
      // ACROSS the view, not along it. A storm blowing directly away from the
      // camera foreshortens its own lean to nothing and photographs as vertical
      // rain, which is the one thing wind-driven rain must not look like.
      const d = this._tmpB;
      this.windVec.set(-d.z * 8.5, 0, d.x * 8.5);
    }
  }

  /**
   * A virtual car for the driving stages.
   *
   * It drives a real arc over the real ground and publishes the exact
   * `vehicle:skid` / `vehicle:collision` payloads the contract specifies, so
   * what a critic photographs here is the shipping code path.
   */
  _startStageCar(mode) {
    const cam = this.ctx.camera;
    const d = this._tmpB;
    const c = (this._stageCar ??= {
      veh: { id: 'fx-stage-car', velocity: { x: 0, y: 0, z: 0 } },
      light: null,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
    });
    c.mode = mode;
    c.t = 0;
    // Centre the arc on a point ahead of the camera so the marks sweep across
    // the frame rather than running away down the middle of it.
    c.cx = this._camPos.x + d.x * 14;
    c.cz = this._camPos.z + d.z * 14;
    c.r = mode === 'cruise' ? 26 : 9;
    c.speed = mode === 'cruise' ? 21 : mode === 'burnout' ? 1.2 : 11;
    c.omega = c.speed / c.r;
    // Phase the arc so that at t = 2.25 s — the middle of the harness's settle
    // window — the car is on the FAR side of the circle from the camera, and the
    // lap is long enough (5.1 s at r=9) that it stays within +-53 deg of there
    // for the whole window. Two things fall out of that: it has already laid
    // ~25 m of mark by the time the shutter falls, and it is never sitting on
    // top of the lens. A shot whose subject wanders out of frame depending on
    // the settle count is not a reviewable shot.
    const back = Math.atan2(this._camPos.z - c.cz, this._camPos.x - c.cx);
    c.a0 = back + Math.PI - c.omega * 2.25;
    c.surface = 'asphalt';
    if (!c.light) {
      // A stand-in headlight for the smoke shader. Deliberately NOT a scene
      // light: `registerSmokeLight` only reads it, so this cannot change the
      // renderer's visible-light count or trigger a recompile.
      c.light = {
        matrixWorld: new THREE.Matrix4(),
        color: new THREE.Color(1, 0.93, 0.82),
        // Stand-in only. Real values come from `vehicles` via
        // registerSmokeLight(); 200 cd / 40 m is a dipped beam in the same
        // units the muzzle flash (90) and an explosion (420) already use.
        intensity: 200,
        distance: 40,
      };
      this.registerSmokeLight(c.light);
    }
    return c;
  }

  /** Per-frame driver for the staged car. Called from update(). */
  _driveStageCar(dt) {
    const c = this._stageCar;
    if (!c) return;
    c.t += dt;
    const ph = this.physics;
    const a = c.a0 + c.t * c.omega;
    const px = c.cx + Math.cos(a) * c.r;
    const pz = c.cz + Math.sin(a) * c.r;
    // heading is the tangent to the arc
    const hx = -Math.sin(a);
    const hz = Math.cos(a);
    // right-hand lateral
    const lx = hz;
    const lz = -hx;
    const speed = c.mode === 'burnout' ? 1.0 : c.speed;
    c.pos.set(px, 0, pz);
    c.vel.set(hx * speed, 0, hz * speed);
    c.veh.velocity.x = c.vel.x;
    c.veh.velocity.y = 0;
    c.veh.velocity.z = c.vel.z;

    let gy = this.ctx.camera.position.y - 1.7;
    if (ph?.groundHeight) {
      const g = ph.groundHeight(px, pz, this.ctx.camera.position.y + 6);
      if (Number.isFinite(g)) gy = g;
    }
    c.pos.y = gy;
    // Headlight: on the nose, at bumper height, aimed the way we are going.
    c.light.matrixWorld.makeTranslation(px + hx * 1.9, gy + 0.62, pz + hz * 1.9);

    if (c.mode === 'cruise') {
      // Rain stage: no skid, just spray off four wheels.
      const share = dt / 4;
      for (let w = 0; w < 4; w++) {
        const side = w % 2 ? 1 : -1;
        const front = w < 2 ? 1.28 : -1.28;
        this.rain.wheelSpray(
          px + lx * side * 0.78 + hx * front,
          gy + 0.16,
          pz + lz * side * 0.78 + hz * front,
          c.vel.x, 0, c.vel.z,
          speed, share, this.now, 1
        );
      }
      return;
    }

    if (c.mode === 'grind') {
      // Panel dragging along a wall: a contact point on the car's flank moving
      // with it, publishing the real `vehicle:collision` payload.
      const gx = px + lx * 1.05;
      const gz = pz + lz * 1.05;
      this._stagePt ??= new THREE.Vector3();
      this._stagePt.set(gx, gy + 0.55, gz);
      this._stageN ??= { x: 0, y: 0, z: 0 };
      this._stageN.x = -lx;
      this._stageN.y = 0.12;
      this._stageN.z = -lz;
      this.onVehicleCollision({
        vehicle: c.veh,
        other: null,
        point: this._stagePt,
        normal: this._stageN,
        impulse: 900 + Math.sin(c.t * 7) * 500,
        speed,
        surface: 'concrete',
      });
      return;
    }

    // drift / burnout: both rear wheels laying mark
    const slip = c.mode === 'burnout' ? 1.5 : 0.7 + 0.55 * (0.5 + 0.5 * Math.sin(c.t * 1.7));
    this._stageSkid ??= { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
    const p = this._stageSkid;
    p.velocity.x = c.vel.x;
    p.velocity.z = c.vel.z;
    for (let w = 0; w < 2; w++) {
      const side = w ? 1 : -1;
      const wx = px + lx * side * 0.79 - hx * 1.3;
      const wz = pz + lz * side * 0.79 - hz * 1.3;
      let wy = gy;
      if (ph?.groundHeight) {
        const g = ph.groundHeight(wx, wz, this.ctx.camera.position.y + 6);
        if (Number.isFinite(g)) wy = g;
      }
      p.point.x = wx;
      p.point.y = wy;
      p.point.z = wz;
      this.onSkid({
        vehicle: c.veh,
        wheel: w,
        point: p.point,
        normal: p.normal,
        velocity: p.velocity,
        // The outside wheel of a drift is loaded harder and marks darker.
        slip: slip * (side > 0 ? 1.12 : 0.86),
        surface: c.surface,
      });
    }
  }

  _stageWallHits(at, target, count, t0, t1) {
    const rng = this.rng;
    for (let i = 0; i < count; i++) {
      const f = i / Math.max(1, count - 1);
      const t = t0 + (t1 - t0) * f;
      // A gunner walking rounds across the wall: a broad sweep with a wobble,
      // so the group reads as aimed fire rather than a scatter plot.
      const su = Math.min(1.35, target.spanU * 0.88);
      const sv = Math.min(0.36, target.spanV * 0.7);
      const u = Math.sin(f * 3.9 + 0.4) * su + rng.signed() * su * 0.13;
      const v = Math.cos(f * 2.4) * sv + rng.signed() * sv * 0.35;
      const surf = i % 3 === 2 ? 'metal' : null;
      at(t, () => this._impactAt(target, u, v, surf));
    }
  }

  /** Fake a bullet:impact at an offset on the staged surface. */
  _impactAt(target, u, v, surfaceOverride) {
    this._p.copy(target.point).addScaledVector(target.tangent, u).addScaledVector(target.bitangent, v);
    this._n.copy(target.normal);
    if (target.world && this.physics?.raycast) {
      // Re-trace so the hit sits on the real surface (and picks up its normal
      // and material) rather than on the plane through the first hit.
      this._tmpA.copy(this._p).addScaledVector(this._n, 1.2);
      this._tmpB.copy(this._n).multiplyScalar(-1);
      const hit = this.physics.raycast(this._tmpA, this._tmpB, 2.6, this.physics.MASK.WORLD);
      if (hit?.hit) {
        this._p.copy(hit.point);
        this._n.copy(hit.normal);
      }
    }
    this._d.copy(this._n).multiplyScalar(-1);
    // give the incoming round a believable oblique angle
    this._d.x += this.rng.signed() * 0.35;
    this._d.y -= 0.18;
    this._d.z += this.rng.signed() * 0.35;
    this._d.normalize();
    this._suppressDecals = target.world === null;
    spawnImpact(this, this._p, this._n, this._d, surfaceOverride ?? target.surface, 1.15);
    this._suppressDecals = false;
  }

  /**
   * Staged muzzle flash for the capture harness.
   *
   * `view: true`, because that is the path a real trigger pull takes
   * (`onWeaponFire` sets it for anything inside 1.5 m of the eye) and it is the
   * only path that reaches `viewFlash` — i.e. the only one that lights the
   * weapon. Staging this at `view: false` meant the harness photographed a flash
   * that could not, by construction, put any warm light on the handguard.
   *
   * The crown comes from the weapon's own muzzle transform when there is a
   * weapon, so the flash is welded to the bore rather than to a hardcoded offset
   * from the eye. The offset is only the fallback for an FX-only scene.
   */
  _stageMuzzle() {
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    const wp = this.ctx.peek('weapons');
    let welded = false;
    if (typeof wp?.muzzleWorld === 'function') {
      wp.muzzleWorld(this._tmpA);
      welded = this._tmpA.lengthSq() > 1e-6;
    }
    if (!welded) this._tmpA.set(0.16, -0.13, -0.72).applyMatrix4(cam.matrixWorld);
    this._tmpB.set(0, 0, -1).transformDirection(cam.matrixWorld);
    this.muzzleFlash({
      position: this._tmpA,
      direction: this._tmpB,
      weapon: 'rifle',
      view: true,
    });
  }

  _stageShell() {
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    this._tmpA.set(0.2, -0.1, -0.45).applyMatrix4(cam.matrixWorld);
    this._tmpB.set(this.rng.range(1.3, 2.1), this.rng.range(1.2, 2.0), this.rng.range(-0.4, 0.4));
    this._tmpB.applyMatrix4(cam.matrixWorld).sub(cam.position);
    this.spawnShell(this._tmpA, this._tmpB);
  }

  _stageTracer(target) {
    const cam = this.ctx.camera;
    this._tmpA.set(0.18, -0.12, -0.7).applyMatrix4(cam.matrixWorld);
    // Fire past the staged surface: a tracer that only travels three metres is
    // over in a sixtieth of a second and can never be photographed.
    this._tmpB
      .set(this.rng.range(-3, 3), this.rng.range(-0.6, 1.4), -46)
      .applyMatrix4(cam.matrixWorld);
    this.tracer(this._tmpA, this._tmpB, 250);
  }

  /** Incoming round crossing the frame — reads as a firefight, not a range. */
  _stageCrossfire() {
    const cam = this.ctx.camera;
    const rng = this.rng;
    this._tmpA.set(rng.range(-14, -9), rng.range(-1.2, 1.4), rng.range(-16, -8)).applyMatrix4(cam.matrixWorld);
    this._tmpB.set(rng.range(9, 15), rng.range(-1.4, 1.2), rng.range(-18, -9)).applyMatrix4(cam.matrixWorld);
    this.tracer(this._tmpA, this._tmpB, 280);
  }

  /** Surface name per probe hit; sized once, reused (see `_findTarget`). */
  _probeSurf = new Array(63).fill('concrete');
  _probeCount = 0;

  _findTarget() {
    const cam = this.ctx.camera;
    const t = (this._target ??= {
      point: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      tangent: new THREE.Vector3(),
      bitangent: new THREE.Vector3(),
      surface: 'concrete',
      world: null,
      distance: 0,
      spanU: 3,
      spanV: 1.2,
    });
    this._camPos.setFromMatrixPosition(cam.matrixWorld);
    const ph = this.physics;
    let best = null;
    let bestDist = Infinity;
    if (ph?.raycast && ph.staticWorld?.triCount > 0) {
      // Fan of probes: prefer something in the 1.5-9 m band, which is where a
      // wall being shot at actually lives in a screenshot.
      //
      // The fan has to be *dense*. A 5x5 grid on 0.14/0.10 rad steps stepped
      // straight over the facing wall in the `impacts` framing and only ever
      // landed grazing hits on tabletops and awnings (face < 0.3), which fell
      // through to the decal-less virtual plane below — an impacts shot with no
      // bullet holes in it. 9x7 on ~0.075/0.08 rad finds it.
      // Two passes. The first records every probe hit; the second scores each one
      // by how many of the OTHERS lie on the same plane.
      //
      // Distance-and-centredness alone is not enough: as soon as the level gains
      // a lamp post or a 12 cm pillar between the camera and the wall, the fan
      // scores the pillar highest and the whole burst — the point of the shot —
      // gets walked across a sliver of geometry 20 px wide where the decals
      // cannot be read at all. Planarity support is what distinguishes "a wall"
      // from "a prop that happens to be 5 m away".
      const probes = this._probes ?? (this._probes = new Float32Array(63 * 8));
      let np = 0;
      for (let i = 0; i < 63; i++) {
        const yaw = ((i % 9) - 4) * 0.075;
        const pitch = (Math.floor(i / 9) - 3) * 0.08;
        this._tmpB.set(0, 0, -1).applyAxisAngle(_axisX, pitch).applyAxisAngle(_axisY, yaw);
        this._tmpB.transformDirection(cam.matrixWorld);
        const hit = ph.raycast(this._camPos, this._tmpB, 40, ph.MASK.WORLD);
        if (!hit?.hit) continue;
        const d = hit.distance;
        // A grazing hit on a thin prop makes a poor showcase.
        const face = -this._tmpB.dot(hit.normal);
        if (d < 1.2 || face < 0.3) continue;
        const b = np * 8;
        probes[b] = hit.point.x;
        probes[b + 1] = hit.point.y;
        probes[b + 2] = hit.point.z;
        probes[b + 3] = hit.normal.x;
        probes[b + 4] = hit.normal.y;
        probes[b + 5] = hit.normal.z;
        probes[b + 6] = d;
        probes[b + 7] = Math.abs(d - 5) + (Math.abs(yaw) + Math.abs(pitch)) * 7 + (1 - face) * 3;
        this._probeSurf[np] = hit.surface ?? 'concrete';
        np++;
      }
      this._probeCount = np;
      for (let i = 0; i < np; i++) {
        const a = i * 8;
        const nx = probes[a + 3];
        const ny = probes[a + 4];
        const nz = probes[a + 5];
        const pd = probes[a] * nx + probes[a + 1] * ny + probes[a + 2] * nz;
        let support = 0;
        for (let j = 0; j < np; j++) {
          if (j === i) continue;
          const c = j * 8;
          if (probes[c + 3] * nx + probes[c + 4] * ny + probes[c + 5] * nz < 0.96) continue;
          const off = probes[c] * nx + probes[c + 1] * ny + probes[c + 2] * nz - pd;
          if (off > -0.12 && off < 0.12) support++;
        }
        // Each co-planar neighbour is worth a metre of framing error: 6+ of them
        // (a broad face) beats a perfectly centred sliver every time.
        const score = probes[a + 7] - Math.min(support, 12) * 1.0;
        if (score < bestDist) {
          bestDist = score;
          this._targetSupport = support;
          best = best ?? { point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: '', distance: 0 };
          best.point.set(probes[a], probes[a + 1], probes[a + 2]);
          best.normal.set(nx, ny, nz);
          best.surface = this._probeSurf[i];
          best.distance = probes[a + 6];
        }
      }
    }
    // Real geometry always beats the virtual plane: decals at 20 m still read as
    // bullet holes, a burst with no decals at all does not.
    if (best && best.distance < 22) {
      t.point.copy(best.point);
      t.normal.copy(best.normal);
      t.surface = best.surface;
      t.world = ph.staticWorld;
      t.distance = best.distance;
    } else {
      // Nothing close enough to shoot: stage the burst on a virtual plane in
      // front of the camera and skip decals (there is nothing to stick to).
      this._tmpB.set(0, 0, -1).transformDirection(cam.matrixWorld);
      t.point.copy(this._camPos).addScaledVector(this._tmpB, 3.2);
      t.normal.copy(this._tmpB).multiplyScalar(-1);
      t.surface = 'concrete';
      t.world = null;
      t.distance = 3.2;
    }
    // tangent frame on the surface, biased so 'up' on the wall is world up
    this._tmpA.set(0, 1, 0);
    if (Math.abs(t.normal.y) > 0.9) this._tmpA.set(1, 0, 0);
    t.bitangent.copy(this._tmpA).addScaledVector(t.normal, -t.normal.dot(this._tmpA)).normalize();
    t.tangent.crossVectors(t.bitangent, t.normal).normalize();

    // How big is the thing we picked? Measure the co-planar probe hits in the
    // surface's own frame so the burst can be walked across whatever we found
    // rather than across a fixed 2.7 m. Sweeping 2.7 m over a 0.4 m pilaster
    // threw fifteen of eighteen rounds off it and onto whatever was behind,
    // which is how an "impacts" shot ends up with its decals scattered over the
    // far side of a market street.
    t.spanU = 0.35;
    t.spanV = 0.25;
    const pr = this._probes;
    if (pr && this._probeCount > 0 && t.world) {
      const pd = t.point.dot(t.normal);
      let uMin = 0;
      let uMax = 0;
      let vMin = 0;
      let vMax = 0;
      for (let i = 0; i < this._probeCount; i++) {
        const b = i * 8;
        if (pr[b + 3] * t.normal.x + pr[b + 4] * t.normal.y + pr[b + 5] * t.normal.z < 0.96) continue;
        const off = pr[b] * t.normal.x + pr[b + 1] * t.normal.y + pr[b + 2] * t.normal.z - pd;
        if (off < -0.12 || off > 0.12) continue;
        this._tmpA.set(pr[b], pr[b + 1], pr[b + 2]).sub(t.point);
        const u = this._tmpA.dot(t.tangent);
        const v = this._tmpA.dot(t.bitangent);
        if (u < uMin) uMin = u;
        if (u > uMax) uMax = u;
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
      }
      t.spanU = Math.max(0.35, Math.min(uMax, -uMin));
      t.spanV = Math.max(0.25, Math.min(vMax, -vMin));
    }
    return t;
  }

  _runScript(dt) {
    if (!this._script.length) return;
    const period = this._scriptPeriod;
    const prev = this._scriptTime;
    let now = prev + dt;
    if (now < period) {
      this._fire(prev, now);
    } else {
      // Fire the tail of this loop and the head of the next one, so a wrap
      // never silently swallows the events that straddle it.
      this._fire(prev, period);
      now -= period;
      this._fire(-1e-6, now);
    }
    this._scriptTime = now;
  }

  _fire(from, to) {
    const list = this._script;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.t > from && e.t <= to) e.fn();
    }
  }

  /* ===================================================================== */

  dispose() {
    // One owner, one hand-back: a subsystem torn down mid-stall must not leave
    // the world running at an eighth speed.
    this.hitstop?.release();
    for (const off of this._off ?? []) off();
    this._off = [];
    this._hazeOff?.();
    for (const l of [this.lit, this.add, this.motes, this.viewAdd, this.viewLit]) {
      l.mesh.parent?.remove(l.mesh);
      l.dispose();
    }
    this.decals.mesh.parent?.remove(this.decals.mesh);
    this.decals.dispose();
    this.shells.mesh.parent?.remove(this.shells.mesh);
    this.shells.dispose();
    this.skid.mesh.parent?.remove(this.skid.mesh);
    this.skid.dispose();
    this.rain.dispose();
    this.fountain.dispose();
    this.vehicleFx.dispose();
    this._smokeLights = null;
    this.hazeSys.dispose();
    this.lights.dispose();
    this.viewLights?.dispose();
    this.viewLights = null;
    this._atlas.texture.dispose();
    this._decalAtlas.albedo.dispose();
    this._decalAtlas.normal.dispose();
    this._decalAtlas.orm.dispose();
    disposeQuadSource();
  }
}

/** Peak candela per weapon class, used when the caller only gives us a name. */
const MUZZLE_LIGHT = {
  rifle: 90,
  carbine: 78,
  smg: 60,
  pistol: 44,
  shotgun: 150,
  sniper: 130,
  lmg: 105,
  suppressed: 16,
};

function weaponKey(weapon) {
  if (!weapon) return 'rifle';
  const key = typeof weapon === 'string' ? weapon : weapon.class ?? weapon.kind ?? weapon.name ?? '';
  const k = String(key).toLowerCase();
  for (const name in MUZZLE_LIGHT) if (k.includes(name)) return name;
  return 'rifle';
}

const _axisX = new THREE.Vector3(1, 0, 0);
const _axisY = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();

/** Wheel list off a `vehicles` handle, whatever it chose to call it. */
function wheelsOf(v) {
  return v?.wheels ?? v?.tyres ?? v?.tires ?? null;
}

/** World position of one wheel into `out`; false if it has none. */
function wheelPos(w, out) {
  if (!w) return false;
  if (w.isObject3D) {
    w.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(w.matrixWorld);
    return true;
  }
  const o = w.object ?? w.mesh;
  if (o) {
    o.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(o.matrixWorld);
    return true;
  }
  const p = w.contact ?? w.position ?? w.pos ?? w.worldPos;
  if (p && Number.isFinite(p.x)) {
    out.set(p.x, p.y, p.z);
    return true;
  }
  return false;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clampI = (v, a, b) => Math.round(clamp(v, a, b));
