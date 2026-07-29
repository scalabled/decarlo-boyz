#!/usr/bin/env node
/**
 * PAUSE / FREEROAM PROBE — can F still take a car from behind the pause menu?
 *
 *   node src/game/pausefreeroamprobe.mjs
 *   node src/game/pausefreeroamprobe.mjs --nc          run the negative control
 *   node src/game/pausefreeroamprobe.mjs --port=5173   reuse a running vite
 *
 * WHAT THIS MEASURES, AND WHY IT IS NOT `interactprobe.mjs`.
 *
 * `src/game/interactprobe.mjs` proves that standing in the right place and
 * pressing F does the thing. This proves the complement: that standing in the
 * right place and pressing F does NOTHING while the world is stopped.
 *
 * Today the pause gate for the whole contextual-action chain lives in the
 * CALLER — `game._update` reads `_paused(ctx)` and simply does not call
 * `freeroam.update(dt)` (`src/game/index.js:705`). That is one `if` away from
 * not working, and the failure is silent: no error, no log, just a car boarded
 * from behind the menu. So `freeroam._usePressed()` now carries the check too.
 *
 * A gate for a belt-and-braces guard has to REMOVE THE BELT, or it measures
 * the caller and not the guard. So this probe injects the exact regression it
 * defends against:
 *
 *     game.update = (dt, c) => { orig(dt, c); game.freeroam.update(dt); };
 *
 * i.e. someone re-ordered `_update` and `freeroam.update` now runs every
 * frame, paused or not. On the pre-fix build that boards the car. On the
 * shipped build it does not.
 *
 * RULE 12 — WHAT THE ASSERTION READS.
 *
 * The implementation reads `ui.isPaused()` and `input.pressed('KeyF')`. This
 * file asserts on NEITHER. It never reads `ui.isPaused()`, `ui.pause.frozen`,
 * `menu.open`, `freeroam._usePressed()` or `freeroam.act`. Every assertion is
 *
 *     ctx.peek('player').vehicles.vehicle
 *
 * — the seat state of a DIFFERENT subsystem, which is what the player sees.
 * The "is it actually paused" precondition is likewise not a flag but a
 * measurement: `time.elapsed` standing still across real frames.
 *
 * The stimulus is a real `page.keyboard` press. `Input._pressed` is a set of
 * "went down this frame", cleared once per frame and not consumed on read
 * (`src/core/input.js:60,178,242`), so the injected second call sees the very
 * same edge the engine's own call saw. Nothing here fakes an input.
 *
 * THE LIVE CONTROL IS NOT OPTIONAL. Check 1 boards the car with nothing
 * paused. Without it a probe that had lost the car, lost the prompt or lost
 * the keypress would report "did not board while paused" and pass while
 * measuring nothing — which is the failure mode rule 12 exists to name.
 *
 * The car is parked at 4.8 m, DELIBERATELY beyond `player`'s own 3.4 m
 * vehicle bind (`interactprobe.mjs` pins that boundary). Inside 3.4 m a board
 * could come from `player` and this file would be blaming the wrong subsystem.
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);
/** Negative control: flip `freeroam.debugIgnorePause`, i.e. un-fix the fix. */
const NC = 'nc' in args;

const { port, server } = await startServer({ explicitPort: args.port });
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});

const results = [];
const rec = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
let page;

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => {
      let i = 0;
      const t = () => (++i >= k ? d() : requestAnimationFrame(t));
      requestAnimationFrame(t);
    }),
    n
  );

const run = (body) =>
  page.evaluate(`(() => {
    const engine = window.__ENGINE__;
    const ctx = engine.ctx;
    const game = ctx.peek('game');
    const player = ctx.peek('player');
    const veh = ctx.peek('vehicles');
    ${body}
  })()`);

/**
 * THE ONE OBSERVABLE. What car is the player actually sitting in, and is the
 * world actually running? Both are another subsystem's state — `player.vehicles`
 * and the engine clock. Neither is a field the pause code branches on.
 */
const seat = () =>
  run(`
    const v = player?.vehicles ?? null;
    return {
      inCar: !!v?.vehicle,
      isProbeCar: !!v?.vehicle && v.vehicle === game.__probeVeh,
      phase: v?.phase ?? null,
      elapsed: engine.time.elapsed,
      raw: engine.time.raw,
    };`);

/** Simulated seconds per real second, measured — never a flag. */
const worldRan = async (frames = 24) => {
  const a = await seat();
  await pump(frames);
  const c = await seat();
  const raw = c.raw - a.raw;
  return {
    d: +(c.elapsed - a.elapsed).toFixed(4),
    raw: +raw.toFixed(4),
    rate: raw > 1e-6 ? +((c.elapsed - a.elapsed) / raw).toFixed(3) : 0,
  };
};

const tap = async (code, frames = 12) => {
  await page.keyboard.press(code);
  await pump(frames);
};

/** A real F press, held long enough to be seen and released cleanly. */
const tapF = async () => {
  await page.keyboard.down('KeyF');
  await pump(3);
  await page.keyboard.up('KeyF');
  await pump(30);
};

/**
 * Put the player on a clear pavement with ONE car parked 4.8 m away, out of
 * any vehicle, with the contextual chain warm. Returns how far the car is.
 */
const stage = async () => {
  await run(`
    // Out of whatever the last case left him in, by the owning subsystem.
    const pv = player.vehicles;
    if (pv?.vehicle) pv.abort(player.movement);
    if (game.__probeVeh) veh.despawn(game.__probeVeh);
    game.missions.abort();
    game.heat.clear('probe');
    return true;`);
  await pump(10);
  return run(`
    const c = game.__clear;
    game.wq.placePlayer(c.x, c.z, Math.PI * 0.5);
    const p = player.position;
    for (const o of veh.vehicles.slice()) {
      if (Math.hypot(o.position.x - p.x, o.position.z - p.z) < 80) veh.despawn(o);
    }
    const v = game.wq.spawnVehicle('sedan', p.x + 4.8, p.z, 0);
    game.__probeVeh = v; game.__probeAt = { x: p.x + 4.8, z: p.z };
    return { spawned: !!v, name: v && v.name,
             dist: v ? +Math.hypot(v.position.x - p.x, v.position.z - p.z).toFixed(2) : -1 };`);
};

/** Hold the parked car exactly where it was put — a sedan rolls on camber. */
const settle = async (frames = 24) => {
  for (let i = 0; i < frames; i += 4) {
    await run(`
      const v = game.__probeVeh;
      if (v && game.__probeAt) {
        v.position.set(game.__probeAt.x, v.position.y, game.__probeAt.z);
        v.velocity.set(0, 0, 0);
        v.forwardSpeed = 0; v.speed = 0;
      }
      return true;`);
    await pump(4);
  }
};

let errs = [];

try {
  page = await b.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
  await page.goto(`http://127.0.0.1:${port}/?boot=0`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await pump(90);

  const setup = await run(`
    engine.input.enabled = true;
    engine.input.frozen = false;
    player.setControlEnabled?.(true);
    game.__clear = { x: player.position.x, z: player.position.z };

    // INJECT THE REGRESSION. This is the whole point of the file: it puts the
    // tree into the state it would be in if someone moved the freeroam call
    // out from behind \`_paused\` in game._update.
    const orig = game.update.bind(game);
    game.update = (dt, c) => { orig(dt, c); game.freeroam.update(dt); };
    game.__injected = true;

    // Negative control: drop the isPaused() term back out of _usePressed.
    game.freeroam.debugIgnorePause = ${NC ? 'true' : 'false'};
    return { injected: true, nc: game.freeroam.debugIgnorePause,
             switchExists: 'debugIgnorePause' in game.freeroam };`);
  await pump(20);

  if (!setup.switchExists) {
    rec('the negative-control switch exists', false,
      'freeroam.debugIgnorePause is missing — the --nc run would be a no-op');
  }

  // The first synthetic keypress of a headless session is unreliable; the page
  // has never been interacted with. Burn one against nothing.
  await page.keyboard.down('KeyF');
  await pump(2);
  await page.keyboard.up('KeyF');
  await pump(8);

  /* ==================================================================== */
  /* 1 — LIVE CONTROL: with nothing paused, F takes the car               */
  /* ==================================================================== */

  const s1 = await stage();
  await settle();
  await pump(30);
  const before1 = await seat();
  await tapF();
  await pump(60);
  const after1 = await seat();

  rec('CONTROL — F boards the parked car when nothing is paused',
    !before1.inCar && after1.isProbeCar,
    `${s1.name ?? 'no car'} at ${s1.dist} m · seat ${before1.phase} -> ${after1.phase}` +
    ` · in the probe car: ${after1.isProbeCar}`);

  /* ==================================================================== */
  /* 2 — THE GATE: with the pause menu up, the same press does nothing    */
  /* ==================================================================== */

  const s2 = await stage();
  await settle();
  await pump(30);

  await tap('Escape');            // the real menu, by the key a player has
  const stopped = await worldRan(24);
  rec('PRECONDITION — the world is genuinely stopped',
    stopped.d === 0,
    `${stopped.d}s of sim in ${stopped.raw}s real — ${(stopped.rate * 100).toFixed(0)}% speed`);

  const before2 = await seat();
  await tapF();
  const after2 = await seat();

  rec('F does not board a car from behind the pause menu',
    !before2.inCar && !after2.inCar,
    `${s2.name ?? 'no car'} at ${s2.dist} m · seat ${before2.phase} -> ${after2.phase}` +
    ` · in a car: ${after2.inCar}${after2.isProbeCar ? ' (the probe car)' : ''}`);

  const stillStopped = await worldRan(24);
  rec('the world is still stopped after F was pressed while paused',
    stillStopped.d === 0,
    `${stillStopped.d}s of sim in ${stillStopped.raw}s real` +
    ` — ${(stillStopped.rate * 100).toFixed(0)}% speed`);

  /* ==================================================================== */
  /* 3 — AND IT COMES BACK: the guard must not outlive the menu           */
  /* ==================================================================== */

  await tap('Escape');
  const resumed = await worldRan(24);
  rec('full speed comes back when the menu comes down',
    resumed.rate > 0.9,
    `${resumed.d}s of sim in ${resumed.raw}s real — ${(resumed.rate * 100).toFixed(0)}% speed`);

  await settle();
  await pump(30);
  const before3 = await seat();
  await tapF();
  await pump(60);
  const after3 = await seat();

  rec('CONTROL — F boards again once the menu is down',
    !before3.inCar && after3.isProbeCar,
    `seat ${before3.phase} -> ${after3.phase} · in the probe car: ${after3.isProbeCar}`);

  rec('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
} finally {
  await b.close().catch(() => {});
  server?.kill?.();
}

let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  — ${r.detail}`);
}
console.log('');
if (NC) {
  // Under --nc the fix is disabled, so the gate MUST fail. A green --nc run is
  // itself a failure: it means the probe cannot see the defect it guards.
  const gate = results.find((r) => r.name.startsWith('F does not board'));
  const sawIt = gate && !gate.ok;
  console.log(sawIt
    ? 'NEGATIVE CONTROL OK — with debugIgnorePause the car IS boarded from behind the menu'
    : 'NEGATIVE CONTROL FAILED — the probe did not notice the fix was off');
  process.exit(sawIt ? 0 : 1);
}
console.log(bad === 0
  ? `${results.length}/${results.length} checks passed`
  : `${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
