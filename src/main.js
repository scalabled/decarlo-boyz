import { Engine } from './core/engine.js';
import { createConfig } from './core/config.js';

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { WorldSystem } from './world/index.js';
import { BuildingSystem } from './buildings/index.js';
import { PropSystem } from './props/index.js';
import { PhysicsSystem } from './physics/index.js';
import { PlayerSystem } from './player/index.js';
import { VehicleSystem } from './vehicles/index.js';
import { TrafficSystem } from './traffic/index.js';
import { PedSystem } from './peds/index.js';
import { PoliceSystem } from './police/index.js';
import { WeaponSystem } from './weapons/index.js';
import { FxSystem } from './fx/index.js';
// The inherited Call of Duty soldier AI (src/ai/) has been retired. src/peds/
// supersedes it and carries the skinned character generation, navigation and
// PBD ragdoll integration across.
import { UiSystem } from './ui/index.js';
import { HudSystem } from './ui/hud.js';
import { AudioSystem } from './audio/index.js';
import { GameSystem } from './game/index.js';

import { installShotApi } from './dev/shots.js';
import { prewarm } from './core/prewarm.js';
import { Governor, detectTier } from './core/governor.js';

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
// Deterministic shutter for the pixel gate: the engine does not schedule its own
// frames, the driver advances exactly N of them through window.__PUMP__. Opt-in,
// because tools that measure real frame pacing (tools/perf.mjs) need the loop to
// free-run. See the long comment in src/dev/shots.js.
const lockstep = capture && params.get('lockstep') === '1';

// Quality: capture pins `ultra` so review frames are always the best the engine
// can do; PLAY auto-detects and then lets the governor tune to the machine.
// Defaulting play to `ultra` made the game too slow to play — that preset is a
// 6 km draw distance, 4096 shadow maps, 24k particles and a 1 km stream radius.
// It is a benchmark setting.
const explicitQ = params.get('q');
const config = createConfig({
  quality: explicitQ ?? (capture ? 'ultra' : detectTier()),
  deterministic: capture,
});

const canvas = document.getElementById('game');

const engine = new Engine({ canvas, config });

// Registration order is irrelevant — Registry topo-sorts on static deps.
engine
  .add(RenderSystem)
  .add(MaterialSystem)
  .add(SkySystem)
  .add(WorldSystem)
  .add(BuildingSystem)
  .add(PropSystem)
  .add(PhysicsSystem)
  .add(PlayerSystem)
  .add(VehicleSystem)
  .add(TrafficSystem)
  .add(PedSystem)
  .add(PoliceSystem)
  .add(WeaponSystem)
  .add(FxSystem)
  // There is deliberately no combat-AI system here. The upstream fork carried a
  // squad AI for riflemen holding cover, which is the wrong game for an open
  // city; `src/peds/` replaced it outright, taking over the skinned character
  // generation, navigation and PBD ragdolls.
  .add(UiSystem)
  // HUD readouts that `game` publishes state for and `ui` does not yet draw —
  // today, the protect chapter's ward health bar. Registered as its own
  // subsystem (deps ['ui','game']) rather than folded into UiSystem so it can
  // be owned, and dropped, independently. See src/ui/hud.js.
  .add(HudSystem)
  .add(AudioSystem)
  .add(GameSystem);

try {
  await engine.init();
} catch (err) {
  console.error('[boot] init failed', err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;inset:0;padding:2rem;color:#f66;background:#000;
       font:12px/1.5 ui-monospace,monospace;overflow:auto;z-index:9999;white-space:pre-wrap">
BOOT FAILURE\n\n${err.stack ?? err.message}</pre>`
  );
  throw err;
}

const shotApi = installShotApi(engine, { capture, lockstep });

// Compile every shader permutation before the frame loop starts. Measured: without
// this, 86 programs compile lazily during play, up to 30 on one frame, producing
// 3.1-3.9 SECOND stalls. See src/core/prewarm.js.
//
// ON BY DEFAULT since the capture path was made frame-deterministic; opt out with
// `?prewarm=0`. It is now PROVEN pixel-neutral: `tools/baseline.mjs` with
// `--query=prewarm=0` vs `--query=prewarm=1` reports identical:true on all 11
// shots (0 changed pixels, maxDelta 0). The two things that previously made the
// ~1.4 s pre-warm spend look like a visual change were both boot-duration
// couplings OUTSIDE the subsystems: (1) the shutter frame index was latency-bound
// because the engine kept stepping through the driver's round trips — fixed by
// lockstep in src/dev/shots.js; (2) `will-change: transform` on the compass strip
// cached a composited-layer raster taken at a wall-clock-dependent moment — fixed
// in src/ui/style.js.
const warmup = params.get('prewarm') === '0' ? { ok: false, reason: 'disabled by ?prewarm=0' } : await prewarm(engine);
console.info('[boot] prewarm', warmup);
window.__PREWARM__ = warmup;

// Adaptive performance governor — off during capture (a shifting renderScale
// would make screenshots non-reproducible and break the pixel gate).
if (!capture && params.get('gov') !== '0') {
  const gov = new Governor({ allowTierChange: !explicitQ });
  engine.governor = gov;
  window.__GOV__ = gov;
  const _origStep = engine.step.bind(engine);
  engine.step = (now) => {
    const r = _origStep(now);
    gov.update(engine.time.dt * 1000, engine);
    return r;
  };
  console.info(`[boot] quality ${config.quality}${explicitQ ? ' (pinned by ?q=)' : ' (auto)'} · governor on`);
}

engine.start();

// Capture harness handshake: only flag ready once a frame has actually landed.
//
// BOOT_FRAMES is deliberately a frame COUNT, not a rAF race. In lockstep mode the
// engine has no loop of its own, so we hand-pump exactly this many frames and only
// then raise __READY__; the shot is therefore always applied at engine frame 3, no
// matter how long boot (or pre-warm) took in wall-clock terms.
const BOOT_FRAMES = 3;
if (lockstep) {
  await shotApi.pump(BOOT_FRAMES);
  window.__READY__ = true;
} else {
  let warm = 0;
  const readyProbe = () => {
    if (++warm >= BOOT_FRAMES) {
      window.__READY__ = true;
      return;
    }
    requestAnimationFrame(readyProbe);
  };
  requestAnimationFrame(readyProbe);
}

window.__ENGINE__ = engine;

/* ========================================================================= */
/* PAGE LIFECYCLE — leaving the tab must not cost you the run                */
/* ========================================================================= */
/**
 * Neither a `beforeunload` save nor a `visibilitychange` pause existed anywhere
 * in `src/`. What that cost: alt-tab out of a chase and the city kept running —
 * cops kept shooting, fuel kept burning, the mission clock kept counting down at
 * a screen nobody was looking at; and closing the tab threw away everything
 * since the last event that happened to touch the debounced writer.
 *
 * They live here, in the page entry, because this is the only file that owns the
 * WINDOW. Both reach their subsystem through `ctx.peek` (rule 2 — never an
 * import), and both are no-ops if that subsystem is missing.
 *
 *   beforeunload / pagehide  -> flush the save. `pagehide` is not decoration:
 *                               iOS Safari does not fire `beforeunload` when a
 *                               tab is swiped away, and that is exactly the
 *                               device where the tab gets swiped away.
 *   visibilitychange(hidden) -> flush AND pause.
 *
 * THE PAUSE GOES THROUGH `ui` AND NOWHERE ELSE. `ui`'s PauseArbiter is the
 * single owner of `ctx.time.scale`; writing the scale from here would be a
 * fourth claimant with its own private restore, which is the exact defect that
 * arbiter was built to end. `ui.isPaused()` is likewise the only thing asked
 * whether the world is already stopped.
 *
 * ...WITH ONE LIVE CAVEAT, MEASURED HERE. `UiSystem.pause()` is
 * declared on the prototype but `UiSystem.init()` assigns
 * `this.pause = new PauseArbiter(ctx)` — an instance field that SHADOWS the
 * method. `ui.pause()` therefore throws `ui.pause is not a function` for every
 * caller outside the class (`ui.resume()` is untouched and still works, which
 * is what makes the asymmetry easy to miss). Until `src/ui/index.js` renames
 * one of the two, this falls back to `ui.menu.show()` — which is exactly what
 * `ui.pause()` itself does, and it announces itself through `menu.onToggle`,
 * so the arbiter still derives the scale. The `typeof` test is not defensive
 * padding: it is what makes this line correct again the moment that file is
 * fixed, with no further edit here.
 */
const lifecycleOffs = [];
{
  const sysSave = () => {
    try {
      engine.ctx.peek('game')?.saveNow?.();
    } catch (err) {
      console.warn('[lifecycle] save failed', err);
    }
  };

  const autoPause = () => {
    // Capture and the demo driver own the clock in free play; a hidden
    // headless tab must not stop a shot midway through being photographed.
    if (config.deterministic) return;
    try {
      const ui = engine.ctx.peek('ui');
      // Not over the boot flow (the player is on the select screen, not in the
      // world), and not on top of an overlay that has already stopped it.
      if (!ui || ui.boot?.active || ui.isPaused?.() === true) return;
      if (typeof ui.pause === 'function') ui.pause();
      else ui.menu?.show?.();
    } catch (err) {
      console.warn('[lifecycle] auto-pause failed', err);
    }
  };

  const onHide = () => {
    if (!document.hidden) return;
    sysSave();
    autoPause();
  };

  const add = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    lifecycleOffs.push(() => target.removeEventListener(type, fn, opts));
  };
  add(window, 'beforeunload', sysSave);
  add(window, 'pagehide', sysSave);
  add(document, 'visibilitychange', onHide);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const off of lifecycleOffs) off();
    engine.dispose();
  });
}
