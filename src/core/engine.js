import * as THREE from 'three';
import { Registry, EventBus } from './registry.js';
import { FIXED_DT, MAX_SUBSTEPS, MAX_CATCHUP_STEPS, FIXED_STEP_BUDGET_MS } from './config.js';
import { Input } from './input.js';
import { Rng } from './rng.js';

/**
 * The Engine owns the frame loop and the shared context handed to every
 * subsystem. It does NOT know what any subsystem does — it only sequences them.
 *
 * Frame order:
 *   1. input.beginFrame()
 *   2. fixedUpdate(FIXED_DT) xN   — physics, deterministic gameplay
 *   3. update(dt)                 — animation, AI decisions, render transforms
 *   4. cameraUpdate(dt)           — place the camera, after everything that
 *                                   moves what it frames has finished moving
 *   5. lateUpdate(dt)             — anything that must observe final transforms
 *                                   INCLUDING the camera
 *   6. render subsystem draws
 *   7. input.endFrame()
 *
 * WHY THE CAMERA GETS ITS OWN PHASE.
 *
 * A camera is the one thing in the frame that is BOTH a consumer of every other
 * subsystem's output and a producer that half of them read back. The only place
 * it can be placed correctly is last, after everything it frames has moved.
 *
 * THE RECORD, CORRECTED. This comment used to claim the chase camera "framed
 * the car one whole frame late; v*dt, so ~0.55 m at 120 km/h at 60 fps, and
 * worse the worse the frame rate gets", and that the phase fixed it. Both
 * halves are wrong and the second one matters more.
 *
 * Re-measured with all four code states built and run (kinematic uniform drive,
 * dt = 1.5 * FIXED, 300 warm + 60 frames, two repeat runs identical to every
 * printed digit) — the drawn car's Z in the emitted camera basis:
 *
 *   camera reads   applied in       @54 km/h    @108 km/h
 *   v.position     player.update    -8.35709    -10.18376   <- the true original
 *   v.position     cameraUpdate     -8.35709    -10.18376   <- IDENTICAL
 *   model.root     player.update    -8.63611    -10.74371   <- a WHOLE frame late
 *   model.root     cameraUpdate     -8.39095    -10.37060   <- shipping
 *
 * Rows 1 and 2 agree in every digit: introducing this phase, on the code as it
 * stood, moved the camera by exactly ZERO. It could not do anything, because
 * the broken camera read `v.position` — which physics finalises before any
 * `update()` runs — so `vehicles.update()` writing the render transform
 * afterwards was invisible to it. There was no frame-late camera to fix.
 *
 * WHAT THE PHASE IS ACTUALLY FOR is row 3. `vehicles.update()` writes the pose
 * the renderer draws (`syncTransforms`, lerping the last two fixed steps), and
 * the registry topo-sorts `player` before `vehicles`. So a camera that reads
 * the DRAWN transform — which is the only correct thing to read, and what the
 * camera now does — gets LAST frame's if it is applied from `update()`: 0.245 m
 * at 54 km/h and 0.373 m at 108 km/h adrift, one frame of travel, v*dt, and
 * this time genuinely worse the worse the frame rate gets. That is the bug this
 * phase prevents. It is a precondition for the pose-source fix, not a fix in
 * itself, and deleting it while keeping that fix produces row 3 — the worst of
 * the four builds. `node src/player/camlagtest.mjs --control=order` reproduces
 * it; `--control=both` reproduces the true original (row 1) and fails 4/4.
 *
 * Neither of the two obvious alternatives states the invariant:
 *
 *   - moving the apply into `lateUpdate` only makes it late enough by ACCIDENT
 *     of where `player` lands in the topo sort. `sky` resolves ahead of it and
 *     `sky.lateUpdate` copies the camera's world matrix into the volumetric and
 *     cloud passes, so those would go one frame stale instead — the same bug,
 *     moved to the weather.
 *   - expressing it as `static deps` orders INITIALISATION as well, and buys
 *     ordering against exactly one subsystem. The next system to move something
 *     the camera looks at has to know to add itself to that list.
 *
 * WHAT THE PHASE COSTS, MEASURED. The half of the rule that holds absolutely is
 * the first: nothing may move a rendered transform after `cameraUpdate` has
 * begun. The second half — "nothing that reads the camera may run before it has
 * finished" — is the GOAL, and four shipping subsystems currently break it,
 * because they read the camera inside their own `update()`:
 *
 *   vehicles/index.js  LOD selection and a 90 m ground-shadow cull
 *   traffic/index.js   the spawn anchor (and a 30 m player-proximity test)
 *   fx/index.js        ambience, rain and worldFx volume placement
 *   audio/index.js     the listener
 *
 * They see LAST frame's camera. MEASURED at the entry of every subsystem's
 * `update()`, against end-of-frame: 0.187 m at 54 km/h, 0.371 m at 108 km/h —
 * one frame of camera travel. Before the phase existed the same staleness fell
 * on the six subsystems that sort AHEAD of `player` (materials, sky, physics,
 * world, buildings, props) instead; it was never zero for everybody.
 *
 * That trade is taken deliberately: every consumer above is a distance decision
 * with a tolerance of tens of metres (0.37 m is 0.4% of the 90 m shadow cull),
 * while the framing it buys is what the player looks at 100% of the time. If
 * one of those consumers ever needs the live camera, the fix is to move that
 * read into `lateUpdate`, not to delete the phase.
 *
 * The phase is also the fix for the class of bug where `game.update` ran last
 * only because `GameSystem` happened to be the last import in main.js — an
 * ordering that matters is an ordering that is declared.
 */
export class Engine {
  constructor({ canvas, config }) {
    this.canvas = canvas;
    this.config = config;
    this.registry = new Registry();
    this.events = new EventBus();
    this.input = new Input(canvas, config);
    this.rng = new Rng(config.deterministic ? 0x5eed1234 : (Math.random() * 2 ** 32) >>> 0);

    this.scene = new THREE.Scene();
    // Far plane comes from the quality preset, not a constant. The inherited
    // value was 1200 m, sized for a 120 m corridor map; Steel City is 3 km
    // across and its signature view is downtown read from the Mt. Washington
    // clifftop 2 km away, so anything short of `q.drawDistance` clips the city
    // out of its own hero shot. `render` owns the depth-precision handling that
    // makes a 6 km far plane survive (reversed-Z).
    this.camera = new THREE.PerspectiveCamera(config.fov, 1, 0.05, config.q.drawDistance ?? 1200);
    this.camera.rotation.order = 'YXZ';

    /** Separate scene+camera for the first-person viewmodel, drawn with its own
     *  near plane so hands/weapon never clip into world geometry. */
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(60, 1, 0.005, 12);

    this.time = {
      /** Seconds since start, scaled. */ elapsed: 0,
      /** Unscaled wall-clock seconds since start. */ raw: 0,
      /** Last frame delta, scaled and clamped. */ dt: 0,
      /** Fixed step. */ fixed: FIXED_DT,
      /** Interpolation alpha between the last two physics steps, 0..1. */ alpha: 0,
      scale: 1,
      frame: 0,
    };

    this.ctx = {
      engine: this,
      scene: this.scene,
      camera: this.camera,
      viewScene: this.viewScene,
      viewCamera: this.viewCamera,
      canvas,
      config,
      events: this.events,
      input: this.input,
      time: this.time,
      rng: this.rng,
      get: (id) => this.registry.get(id),
      peek: (id) => this.registry.peek(id),
      has: (id) => this.registry.has(id),
    };

    this._accum = 0;
    this._last = 0;
    this._running = false;
    this._onResize = () => this.resize();
  }

  add(SystemClass, opts) {
    this.registry.add(new SystemClass(opts));
    return this;
  }

  async init() {
    const order = this.registry.resolve();
    for (const sys of order) {
      const t0 = performance.now();
      await sys.init?.(this.ctx);
      const ms = performance.now() - t0;
      if (ms > 50) console.info(`[engine] ${sys.constructor.id} init ${ms.toFixed(0)}ms`);
    }
    this.input.attach();
    addEventListener('resize', this._onResize);
    this.resize();
    return this;
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth || innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    for (const sys of this.registry.with('resize')) sys.resize(w, h, this.ctx);
    this.events.emit('resize', { width: w, height: h });
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  stop() {
    this._running = false;
  }

  _loop(now) {
    if (!this._running) return;
    requestAnimationFrame(this._loop);
    this.step(now);
  }

  /** Advance one frame. Exposed so the capture harness can pump frames by hand. */
  step(now = performance.now()) {
    const t = this.time;
    // Clamp so a tab-switch or a breakpoint doesn't teleport the simulation.
    const rawDt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    t.raw += rawDt;
    t.dt = rawDt * t.scale;
    t.elapsed += t.dt;
    t.frame++;

    this.input.beginFrame();

    // Bound the BACKLOG, not just the step count. See MAX_CATCHUP_STEPS: with
    // only a step-count cap, a frame that overran kept asking for the maximum
    // number of steps, those steps overran too, and the stall sustained itself
    // across frames. Refusing to make up lost time is the correct trade — a
    // dropped 30 ms of simulation is invisible, a half-second freeze is not.
    this._accum = Math.min(this._accum + t.dt, MAX_CATCHUP_STEPS * FIXED_DT);
    let steps = 0;
    const fixedSystems = this.registry.with('fixedUpdate');
    const stepStart = performance.now();
    while (this._accum >= FIXED_DT && steps < MAX_SUBSTEPS) {
      for (const sys of fixedSystems) sys.fixedUpdate(FIXED_DT, this.ctx);
      this._accum -= FIXED_DT;
      steps++;
      // Second, independent guard: a single step that goes long (a static
      // collision rebuild lands inside one) must not be multiplied by whatever
      // backlog happens to be pending.
      //
      // Wall-clock, so it is skipped under `deterministic` (capture mode): how
      // many steps a budget allows is machine- and load-dependent, and the
      // pixel gate needs the capture path to resolve identically every run. The
      // backlog cap above is a pure function of dt and stays on everywhere.
      if (!this.config.deterministic && performance.now() - stepStart > FIXED_STEP_BUDGET_MS) {
        this._accum = 0;
        break;
      }
    }
    // Unreachable while MAX_CATCHUP_STEPS < MAX_SUBSTEPS — the backlog cap binds
    // first. Kept as the hard ceiling so raising the cap can never reintroduce
    // an unbounded catch-up burst.
    if (steps === MAX_SUBSTEPS) this._accum = 0;
    t.alpha = this._accum / FIXED_DT;

    for (const sys of this.registry.with('update')) sys.update(t.dt, this.ctx);
    // Cameras only. Everything that MOVES a rendered transform is behind us.
    // Four subsystems still read the camera in their own `update()` and so see
    // last frame's — named, measured and justified in the note at the top.
    for (const sys of this.registry.with('cameraUpdate')) sys.cameraUpdate(t.dt, this.ctx);
    for (const sys of this.registry.with('lateUpdate')) sys.lateUpdate(t.dt, this.ctx);

    const renderSystem = this.registry.peek('render');
    if (typeof renderSystem?.render === 'function') renderSystem.render(this.ctx);

    this.input.endFrame();
  }

  dispose() {
    this.stop();
    removeEventListener('resize', this._onResize);
    this.input.detach();
    for (const sys of [...this.registry.ordered].reverse()) sys.dispose?.();
    this.events.clear();
  }
}
