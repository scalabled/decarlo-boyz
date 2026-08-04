#!/usr/bin/env node
/**
 * ONBOARD PROBE — a first-time player MUST be told how to play story mode.
 *
 * The reported bug: "I started story mode as Aidan and I respawned but nothing
 * happened — how do I play?" The 24-chapter playtest harness is green because it
 * drives missions PROGRAMMATICALLY (`game.startMission`, `missions.forceBegin`).
 * It never exercises the one path a human takes: pick a brother on the boot
 * screen, press START, and land in the city. On that path nothing STARTED the
 * chapter — the boot flow armed `_pendingChapter` and toasted "PRESS J", a cue
 * that is gone by the time the city has streamed in and never returns after a
 * respawn, and `game.getHudState().objective` stayed null with no waypoint.
 *
 * This drives the REAL entry gesture — `window.__BOOT__.choose(id)` then
 * `.start()`, which is exactly what the START button calls and which emits
 * `ui:boot { phase:'play' }` — and asserts on EMITTED, player-facing state
 * (rule 12):
 *
 *   - a story mission is ACTIVE and in an ACTIONABLE phase (travel/run, not
 *     stuck in the intro cutscene);
 *   - `game.getHudState().objective.text` is a non-empty actionable line — the
 *     value `ui/index.js:_pullState` feeds straight into the ObjectivePanel;
 *   - a world waypoint marker exists (`ui._objectives`, the list the world-space
 *     diamonds are drawn from) pointing at the first objective.
 *
 * NEGATIVE CONTROLS, so the assertion is not decorative:
 *   1. NO-ENTRY — replicate everything boot's START does EXCEPT emit `ui:boot`
 *      (control enabled, HUD up, clock running). This is the pre-fix experience
 *      and the observable state a build without the auto-start listener lands a
 *      player in: it MUST read NOT-GUIDED. If it reads guided, the checker is
 *      an always-pass and is worthless.
 *   2. INTRO — sample the checker the instant the mission is in its intro
 *      cutscene. A mission that never leaves intro MUST read NOT-GUIDED; this is
 *      the "build where the mission never leaves intro should fail" control.
 *
 * To confirm it has teeth against the code itself: comment out the `ui:boot`
 * listener in `src/game/index.js` and the GUIDED arm goes red.
 *
 *   npm run build && node src/game/onboardprobe.mjs
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const BOY = 'aidan';
const ENTER_TIMEOUT_S = 22; // budget for intro cutscene -> actionable phase

const { port, server } = await startServer({});
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await b.newPage({ viewport: { width: 960, height: 540 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));

const pump = (n) => page.evaluate((k) => new Promise((d) => {
  let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t);
}), n);

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };

/**
 * The EMITTED, player-facing guidance state. Everything here is read off the
 * artefacts `ui` actually draws from, never off the arithmetic that produced
 * them (rule 12): the HUD objective the panel is fed, the world-marker list the
 * diamonds are projected from, and the mission phase the player is living in.
 */
const CHECK = (boy) => page.evaluate((wantBoy) => {
  const e = window.__ENGINE__;
  const g = e.ctx.peek('game');
  const ui = e.ctx.peek('ui');
  const M = g?.missions?.M ?? null;
  const active = !!(M && M.phase !== 'over');
  const phase = M ? M.phase : null;
  const actionable = active && (phase === 'travel' || phase === 'run');

  // The objective line drawn top-right — the exact object `_pullState` passes to
  // `ObjectivePanel.set`, read here off the same `getHudState()` `ui` polls.
  const hud = g?.getHudState?.() ?? {};
  const obj = hud.objective ?? null;
  const text = (obj && typeof obj.text === 'string') ? obj.text.trim() : '';
  const objOk = text.length >= 4;

  // The world-space marker list `ui` projects the objective diamonds from, plus
  // the minimap waypoint. Either is a "go here" cue the player can follow.
  const markers = Array.isArray(ui?._objectives) ? ui._objectives.length : 0;
  const waypoint = !!ui?.state?.waypoint;
  const firstMarker = (markers && ui._objectives[0]?.position)
    ? { x: +ui._objectives[0].position.x.toFixed(1), z: +ui._objectives[0].position.z.toFixed(1) } : null;

  const guided = actionable && objOk && (markers > 0 || waypoint);
  return {
    character: g?.character ?? null, wantBoy,
    active, phase, actionable,
    objectiveText: text, objOk,
    markers, waypoint, firstMarker,
    guided,
  };
}, boy);

try {
  // ---- boot: webdriver disables the boot flow, so the game comes up straight
  // into free roam. Wait for the streamed city to settle.
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ENGINE__?.ctx?.peek?.('game'), null, { timeout: 60000 });
  await page.waitForFunction(() => window.__SETTLED__ === true, null, { timeout: 60000 }).catch(() => {});
  await pump(30);

  // ===================================================================
  // NEGATIVE CONTROL 1 — entered the world, but nothing auto-started.
  // Do everything boot.start() does EXCEPT emit ui:boot. This is the
  // pre-fix experience; it MUST read NOT-GUIDED.
  // ===================================================================
  await page.evaluate((id) => {
    const e = window.__ENGINE__;
    const g = e.ctx.peek('game');
    const ui = e.ctx.peek('ui');
    if (g.character !== id) g.switchTo(id);
    ui?.setCharacter?.(id);
    e.ctx.peek('player')?.setControlEnabled?.(true);
    ui?.setHudVisible?.(true);
    if (e.ctx.time && !(e.ctx.time.scale > 0)) e.ctx.time.scale = 1;
  }, BOY);
  await pump(120); // ~2 s of real frames — a player would have read a toast by now
  const neg = await CHECK(BOY);
  console.log('NO-ENTRY :', JSON.stringify(neg));
  ok(neg.character === BOY, `switched to ${BOY} (got ${neg.character})`);
  ok(neg.guided === false, 'NO-ENTRY reads NOT-GUIDED (the reported bug / pre-fix state)');

  // ===================================================================
  // REAL ENTRY — bring up the actual boot flow and press its buttons.
  // `__BOOT_API__.create()` builds the real BootFlow on the already-booted
  // page; choose()+start() is the exact sequence the START button runs and
  // emits ui:boot { phase:'play' }.
  // ===================================================================
  await page.evaluate((id) => {
    const flow = window.__BOOT_API__.create();
    flow.choose(id);
    flow.start();
  }, BOY);

  // The instant after START the mission should exist but be in its intro
  // cutscene — NEGATIVE CONTROL 2: intro is not yet actionable.
  await pump(4);
  const intro = await CHECK(BOY);
  console.log('INTRO    :', JSON.stringify(intro));
  ok(intro.active === true, 'a story mission STARTED on entering the world');
  ok(intro.guided === false && intro.phase === 'intro',
    'INTRO reads NOT-GUIDED while the cutscene holds the screen');

  // A player skips the cutscene (or watches it out); either way it hands off to
  // gameplay. SKIP button and Escape both call skipAll — do the same, then poll
  // for the actionable, guided state.
  await page.evaluate(() => {
    const ui = window.__ENGINE__.ctx.peek('ui');
    ui?.subs?.cut?.skipAll?.();
  });

  let guided = null;
  const frames = Math.ceil(ENTER_TIMEOUT_S * 60);
  for (let waited = 0; waited < frames; waited += 30) {
    await pump(30);
    guided = await CHECK(BOY);
    if (guided.guided) break;
    // Keep skipping in case a multi-line cut re-armed a line.
    await page.evaluate(() => window.__ENGINE__.ctx.peek('ui')?.subs?.cut?.skipAll?.());
  }
  console.log('GUIDED   :', JSON.stringify(guided));
  ok(guided.active === true, 'the mission is still live after the intro');
  ok(guided.actionable === true, `mission reached an ACTIONABLE phase (got ${guided.phase})`);
  ok(guided.objOk === true, `HUD objective is a real line: "${guided.objectiveText}"`);
  ok(guided.markers > 0 || guided.waypoint, 'a waypoint / world marker points at the first objective');
  ok(guided.guided === true, 'GUIDED: a first-time player is told what to do and where to go');

  ok(errs.length === 0, `no page errors (${errs.length})`);
  if (errs.length) errs.slice(0, 6).forEach((m) => console.log('   pageerror:', m));
} catch (err) {
  fail++;
  console.log('FAIL  threw:', String(err?.stack ?? err).slice(0, 400));
}

console.log(`\n${pass}/${pass + fail} onboard checks passed`);
await b.close();
stopServerSafe(server);
process.exit(fail ? 1 : 0);

function stopServerSafe(s) { try { s?.kill?.(); } catch { /* reaped on exit */ } }
