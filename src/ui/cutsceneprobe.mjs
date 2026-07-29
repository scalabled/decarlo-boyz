#!/usr/bin/env node
/**
 * CUTSCENE PROBE — is a chapter's dialogue a MODE, or a caption?
 *
 *   node src/ui/cutsceneprobe.mjs
 *   node src/ui/cutsceneprobe.mjs --port=5173      (reuse a running vite)
 *   node src/ui/cutsceneprobe.mjs --keep           (leave the browser open)
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASURES, AND WHY IT NEVER ASKS THE CUTSCENE
 * ---------------------------------------------------------------------------
 * ARCHITECTURE.md rule 12: a gate must not re-use the code's own inputs. So
 * nothing in here reads `subs.cut.active`, `ui.subs`, `Cutscene.idx`,
 * `time.scale`, or any other flag the cutscene branches on. `time.scale` in
 * particular is the cutscene's OWN WRITE — asserting it would be asking the
 * code to confirm its own assignment. Every assertion below is against an
 * emitted artefact:
 *
 *   "the sim does not advance"  -> `time.elapsed` across N REAL frames, divided
 *       by `time.raw` across the same frames. `elapsed` is what every subsystem
 *       integrates; the ENGINE produces it from `scale`. A build that sets a
 *       flag and forgets the clock fails here. Cross-checked against the
 *       PLAYER'S WORLD POSITION and the CITY CLOCK's hour, which are two more
 *       independent consumers of the same clock.
 *   "the HUD is not visible"    -> composited visibility of the real HUD nodes
 *       (the ring dock and the top-right column): display, visibility and the
 *       product of every ancestor's opacity, i.e. what a player would see.
 *   "the camera fov is 44"      -> recovered from `camera.projectionMatrix`,
 *       NOT from `camera.fov`. The matrix is what three actually renders with;
 *       writing the property and never calling updateProjectionMatrix() is a
 *       real and invisible failure, and this is the only reading that catches
 *       it.
 *   "the camera orbits"         -> the camera's world position over time, and
 *       its distance to the player. A static camera and an orbiting one are
 *       different numbers.
 *   "the line is typed out"     -> the rendered text in the DOM, sampled over
 *       time, compared against the AUTHORED string in `src/game/data.js`. The
 *       comparison target is the content file, not anything the presentation
 *       computed.
 *   "SKIP ALL lands in gameplay"-> the sim rate, the HUD, the fov and the
 *       OBJECTIVE PANEL TEXT the player reads, after clicking the button.
 *
 * Each refusal is paired with a LIVE CONTROL taken in plain free roam, because
 * "the HUD is hidden during a cut" is trivially true of a build with no HUD.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------------
 * The chapters' dialogue was a two-line caption bar over a LIVE, RUNNING world:
 * full simulation, full HUD, gameplay fov, the whole line dumped at once and
 * held on a length-derived timer. A cutscene has to be a MODE — no simulation,
 * no HUD, an orbiting camera at fov 44, 46 cps typing, a per-speaker portrait,
 * the rival's name for the `boss` speaker, click-to-advance and SKIP ALL.
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);

/**
 * HEADLESS CHROMIUM NEVER GRANTS POINTER LOCK — verified in the header of
 * `src/ui/pauseprobe.mjs`, which is where this model comes from. Without it,
 * `document.pointerLockElement` is null for the whole run and the entire
 * lock-related half of the cutscene (case 7) tests nothing at all: it would
 * pass on a build that never released the lock and never disarmed the latch.
 *
 * Two behaviours, both of which a real browser has and headless omits:
 *   1. `requestPointerLock()` succeeds and fires `pointerlockchange`.
 *   2. While locked, the user agent EATS Escape to exit the lock and never
 *      dispatches the keydown to the page.
 */
function installPointerLockModel() {
  let lockEl = null;
  const fire = () => document.dispatchEvent(new Event('pointerlockchange', { bubbles: true }));
  Object.defineProperty(Document.prototype, 'pointerLockElement', {
    configurable: true, get: () => lockEl,
  });
  Element.prototype.requestPointerLock = function requestPointerLock() {
    return new Promise((resolve) => {
      setTimeout(() => { lockEl = this; fire(); resolve(); }, 8);
    });
  };
  Document.prototype.exitPointerLock = function exitPointerLock() {
    if (!lockEl) return;
    lockEl = null;
    fire();
  };
  window.__LOCK__ = {
    get locked() { return !!lockEl; },
    grab() { return document.getElementById('game').requestPointerLock(); },
  };
}

const { port, server } = await startServer({ explicitPort: args.port });
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});

const results = [];
const rec = (area, name, ok, detail) => results.push({ area, name, ok, detail });
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

/**
 * One reading of everything a player can see or is actually playing.
 *
 * The DOM selectors are deliberately the CLASS NAMES A PLAYER'S BROWSER WOULD
 * SHOW, resolved from `ui.root`, never object references handed over by the
 * subsystem.
 */
const snap = () =>
  page.evaluate(() => {
    const e = window.__ENGINE__;
    const ui = e.ctx.peek('ui');
    const g = e.ctx.peek('game');
    const q = (sel) => ui?.root?.querySelector(sel) ?? null;

    /** Composited visibility: display, visibility and EVERY ancestor opacity. */
    const vis = (n) => {
      if (!n || !n.isConnected) return 0;
      let a = 1;
      for (let el = n; el && el !== document.documentElement; el = el.parentElement) {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return 0;
        a *= parseFloat(s.opacity || '1');
      }
      return +a.toFixed(3);
    };

    // FOV recovered from the projection matrix three actually renders with.
    // element[5] is 1 / tan(fovY/2) for a PerspectiveCamera.
    const m = e.camera.projectionMatrix.elements[5];
    const fov = m > 0.01 ? +((2 * Math.atan(1 / m) * 180) / Math.PI).toFixed(2) : -1;

    const p = e.ctx.peek('player');
    const pp = p?.position ?? p?.getPosition?.() ?? null;
    const M = g?.missions?.M ?? null;

    // The authored line, straight out of the content file, for the typing test.
    let authored = null;
    let speaker = null;
    try {
      const intro = M?.def?.intro;
      if (Array.isArray(intro) && intro.length) {
        speaker = intro[0][0];
        authored = intro[0][1];
      }
    } catch { /* a chapter with no intro is a legitimate state */ }

    const cut = q('.ow-cut');
    const port = q('.ow-cut-port');
    const svg = port?.querySelector('svg') ?? null;
    const fills = svg
      ? Array.from(svg.querySelectorAll('[fill]'))
        .map((n) => n.getAttribute('fill'))
        .filter((s) => s && s !== 'none')
      : [];

    return {
      elapsed: e.time.elapsed,
      raw: e.time.raw,
      fov,
      camX: +e.camera.position.x.toFixed(3),
      camY: +e.camera.position.y.toFixed(3),
      camZ: +e.camera.position.z.toFixed(3),
      playerX: pp ? +pp.x.toFixed(3) : 0,
      playerZ: pp ? +pp.z.toFixed(3) : 0,
      // Two HUD readouts a player looks at: the ring dock and the top-right
      // column. Either one visible means the HUD is up.
      hud: Math.max(vis(q('.ow-dock')), vis(q('.ow-topright'))),
      clock: (q('.ow-clock-time')?.textContent ?? q('.ow-clock')?.textContent ?? '').trim(),
      // The cutscene, as the browser composites it.
      cutVis: vis(cut),
      who: (q('.ow-cut-who')?.textContent ?? '').trim(),
      line: (q('.ow-cut-line')?.textContent ?? '').trim(),
      skipVis: vis(q('.ow-cut-skip')),
      portraitFills: fills.length,
      portraitInk: fills.join(','),
      // The old caption bar, so a build without a cutscene still reports what
      // it DID put on screen instead of a row of blanks.
      barVis: vis(q('.ow-subs')),
      bar: (q('.ow-subs-line')?.textContent ?? '').trim(),
      // Mission state and the objective text the player reads.
      mission: M && g?.missions?.active ? M.id : null,
      phase: M && g?.missions?.active ? M.phase : null,
      objective: (q('.ow-obj-text')?.textContent ?? '').trim(),
      authored,
      speaker,
      rival: g?.characters?.boy?.rival ?? null,
      menuVis: vis(q('.ow-menu')),
      mapVis: vis(q('.ow-map')),
      cardVis: vis(q('.ow-card')),
      // Which brother is live, read two ways: the game's own answer and the
      // colour the whole HUD is drawn in.
      character: g?.character ?? null,
      accent: getComputedStyle(ui.root).getPropertyValue('--accent').trim(),
    };
  });

/**
 * How fast is the world actually running? Scaled seconds per unscaled second,
 * i.e. simulated time over the real time the same frames took. The RATIO, not
 * the delta: a delta is a statement about the harness's frame rate.
 */
const worldRan = async (frames = 26) => {
  const a = await snap();
  await pump(frames);
  const c = await snap();
  const d = c.elapsed - a.elapsed;
  const rawD = c.raw - a.raw;
  return {
    d: +d.toFixed(4),
    raw: +rawD.toFixed(4),
    rate: rawD > 1e-6 ? +(d / rawD).toFixed(3) : 0,
    moved: +Math.hypot(c.playerX - a.playerX, c.playerZ - a.playerZ).toFixed(3),
    camMoved: +Math.hypot(c.camX - a.camX, c.camZ - a.camZ).toFixed(3),
  };
};

const at = (r) => `${r.d}s of sim in ${r.raw}s real — ${(r.rate * 100).toFixed(0)}% speed`;

const tap = async (code, frames = 12) => {
  await page.keyboard.press(code);
  await pump(frames);
};

async function boot() {
  page = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(installPointerLockModel);
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${port}/?boot=0`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await pump(80);
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.input.enabled = true;
    e.input.frozen = false;
    e.ctx.peek('player')?.setControlEnabled?.(true);
  });
  await pump(20);
  return errs;
}

/* ======================================================================== */
/* 0 — the live control: what plain free roam looks like                     */
/* ======================================================================== */

let FREE = null;

async function caseControl() {
  const A = '0 · CONTROL — plain free roam';
  FREE = await snap();
  const ran = await worldRan();
  rec(A, 'the world runs at full speed with no chapter', ran.rate > 0.85, at(ran));
  rec(A, 'the HUD is on screen in free roam', FREE.hud > 0.5, `hud opacity ${FREE.hud}`);
  rec(A, 'the gameplay fov is NOT the cutscene fov', Math.abs(FREE.fov - 44) > 2,
    `projection fov ${FREE.fov} deg`);
  rec(A, 'no cutscene is on screen in free roam', FREE.cutVis < 0.02,
    `cut opacity ${FREE.cutVis}`);
}

/* ======================================================================== */
/* 1 — the chapter starts, and the screen changes hands                     */
/* ======================================================================== */

let CUT = null;

async function caseStart() {
  const A = '1 · J — the chapter intro';
  await tap('KeyJ', 24);
  CUT = await snap();
  rec(A, 'J starts a chapter', !!CUT.mission,
    `mission ${CUT.mission}, phase ${CUT.phase}`);
  rec(A, 'the cutscene is on screen', CUT.cutVis > 0.5,
    `cut opacity ${CUT.cutVis} (caption bar was ${CUT.barVis})`);
}

/* ======================================================================== */
/* 2 — the writing is TYPED, and all of it arrives                          */
/* ======================================================================== */

/**
 * Cheap sample: just the rendered line and the unscaled clock. `snap()` is a
 * heavy round trip and 46 cps is fast enough that the sampler's own cost is
 * part of the measurement.
 */
const typed = () =>
  page.evaluate(() => {
    const e = window.__ENGINE__;
    const n = e.ctx.peek('ui')?.root?.querySelector('.ow-cut-line');
    return { raw: e.time.raw, text: (n?.textContent ?? '') };
  });

/**
 * RUNS IMMEDIATELY AFTER THE CHAPTER STARTS, before anything else spends real
 * time. Typing 45 characters at 46 cps takes under a second, so a
 * sampler that arrives late measures a finished line and cannot tell typing
 * from dumping — which is exactly what the first version of this probe did.
 */
async function caseTyping() {
  const A = '2 · the line is typed out';
  const s0 = await snap();
  const authored = s0.authored;
  if (!authored) {
    rec(A, 'the chapter has authored intro dialogue', false, 'no intro lines found');
    return;
  }

  const samples = [];
  for (let i = 0; i < 40; i++) {
    const s = await typed();
    samples.push({ raw: +s.raw.toFixed(3), n: s.text.length, text: s.text });
    if (s.text === authored) break;
    await pump(2);
  }
  const first = samples[0];
  const full = samples.find((x) => x.text === authored);

  // A build that dumps the whole string shows authored.length on sample one.
  rec(A, 'the line is NOT dumped whole on the first sample',
    first.n > 0 && first.n < authored.length,
    `${first.n} of ${authored.length} chars, ${first.raw - samples[0].raw}s in`);
  rec(A, 'what is on screen is a PREFIX of the authored line, not a paraphrase',
    authored.startsWith(first.text), `"${first.text}"`);
  rec(A, 'the whole authored line eventually appears', !!full,
    full
      ? `"${authored.slice(0, 46)}${authored.length > 46 ? '…' : ''}" (${authored.length} chars)`
      : `stuck at ${samples[samples.length - 1].n} of ${authored.length}`);

  if (full) {
    // The target is 46 characters per second. The band is wide because the
    // point is to tell "typed" from "dumped", not to re-assert a constant — and
    // the sampler's own round-trip time is inside the measurement.
    const dt = full.raw - first.raw;
    const cps = dt > 1e-3 ? (full.n - first.n) / dt : 999;
    rec(A, 'it types at roughly 46 cps',
      cps > 20 && cps < 90, `${cps.toFixed(1)} chars/sec`);
  }

  const s = await snap();
  rec(A, 'the speaker is named', s.who.length > 0, `"${s.who}"`);
  if (s.speaker === 'boss') {
    rec(A, "the boss speaker wears the hero's RIVAL name",
      !!s.rival && s.who.toUpperCase() === String(s.rival).toUpperCase(),
      `"${s.who}" vs rival "${s.rival}"`);
  }
}

/* ======================================================================== */
/* 2b — the intro is a MODE: no sim, no HUD, its own camera                  */
/* ======================================================================== */

async function caseMode() {
  const A = '2b · the cutscene is a MODE';

  // THE HEADLINE. Everything else is dressing on top of this.
  const frozen = await worldRan(30);
  rec(A, 'NO SIMULATION RUNS during the cutscene', frozen.d === 0,
    `${at(frozen)}; player moved ${frozen.moved} m`);
  rec(A, 'the player does not move during the cutscene', frozen.moved === 0,
    `${frozen.moved} m over ${frozen.raw}s real`);

  const during = await snap();
  rec(A, 'the HUD is hidden during the cutscene', during.hud < 0.02,
    `hud opacity ${during.hud} (was ${FREE.hud} in free roam)`);
  rec(A, 'the city clock does not tick during the cutscene',
    during.clock === CUT.clock, `${CUT.clock} -> ${during.clock}`);
  rec(A, 'the camera is at the authored cutscene fov 44',
    Math.abs(during.fov - 44) < 0.25,
    `projection fov ${during.fov} deg (free roam ${FREE.fov})`);
  rec(A, 'the camera ORBITS while the world stands still',
    frozen.camMoved > 0.05,
    `camera moved ${frozen.camMoved} m while the player moved ${frozen.moved} m`);
  rec(A, 'a SKIP ALL control is offered', during.skipVis > 0.4,
    `skip button opacity ${during.skipVis}`);
  rec(A, 'a per-speaker portrait is drawn', during.portraitFills >= 4,
    `${during.portraitFills} filled SVG shapes: ${during.portraitInk.slice(0, 70)}`);
}

/* ======================================================================== */
/* 2c — the cutscene owns the KEYBOARD as well as the clock                 */
/* ======================================================================== */

/**
 * A stopped clock is only half of "no simulation at all". The engine keeps
 * delivering input EDGES at full rate however slow the clock is, and every one
 * of these keys acts on an edge — that is exactly how `K` used to abandon a
 * chapter from behind the pause menu. A cutscene that only zeroed `time.scale`
 * would let the player throw the chapter away while watching its own intro.
 *
 * Live controls for all three are in case 6, at the end, where wrecking the
 * state costs nothing.
 */
async function caseKeysStandDown() {
  const A = '2c · the cutscene owns the keyboard';
  const before = await snap();
  await tap('KeyU', 14);
  await tap('KeyM', 14);
  await tap('KeyK', 14);
  const after = await snap();

  rec(A, 'U does not switch brother during a cutscene',
    after.character === before.character && after.accent === before.accent,
    `${before.character} (${before.accent}) -> ${after.character} (${after.accent})`);
  rec(A, 'M does not open the map during a cutscene', after.mapVis < 0.02,
    `map opacity ${after.mapVis}`);
  rec(A, 'K DOES NOT ABANDON THE CHAPTER during a cutscene',
    after.mission === before.mission && after.mission !== null,
    `mission ${before.mission} -> ${after.mission}`);
  rec(A, 'the cutscene is still up after the hotkeys', after.cutVis > 0.5,
    `cut opacity ${after.cutVis}`);
  const stillFrozen = await worldRan(20);
  rec(A, 'the world is still stopped after the hotkeys', stillFrozen.d === 0,
    at(stillFrozen));
}

/* ======================================================================== */
/* 3 — click to advance                                                     */
/* ======================================================================== */

async function caseAdvance() {
  const A = '3 · click advances the scene';
  const before = await snap();
  // Click the letterbox, not the skip button: the whole stage is a tap target.
  await page.mouse.click(640, 200);
  await pump(10);
  const mid = await snap();
  // Either the line completed (first click fills a half-typed line) or the
  // scene moved on to the next speaker. Both are "the click did something".
  const advanced = mid.line !== before.line || mid.who !== before.who;
  rec(A, 'clicking the stage advances the scene', advanced,
    `"${before.who}: ${before.line.slice(0, 28)}" -> "${mid.who}: ${mid.line.slice(0, 28)}"`);

  const stillFrozen = await worldRan(20);
  rec(A, 'the world is still stopped after a click', stillFrozen.d === 0,
    at(stillFrozen));
}

/* ======================================================================== */
/* 4 — SKIP ALL puts you back in the game, with the chapter live            */
/* ======================================================================== */

async function caseSkipAll() {
  const A = '4 · SKIP ALL';
  const before = await snap();
  rec(A, 'the cutscene is still up before SKIP is pressed', before.cutVis > 0.5,
    `cut opacity ${before.cutVis}, phase ${before.phase}`);

  await page.click('.ow-cut-skip', { timeout: 4000 }).catch(() => {});
  await pump(40);
  const after = await snap();

  rec(A, 'SKIP ALL takes the cutscene off screen', after.cutVis < 0.02,
    `cut opacity ${after.cutVis}`);
  rec(A, 'SKIP ALL gives the HUD back', after.hud > 0.5,
    `hud opacity ${after.hud}`);
  rec(A, 'SKIP ALL gives the gameplay camera back',
    Math.abs(after.fov - FREE.fov) < 0.6,
    `projection fov ${after.fov} vs free roam ${FREE.fov}`);

  const ran = await worldRan();
  rec(A, 'the world runs at full speed again after SKIP ALL', ran.rate > 0.85,
    at(ran));

  rec(A, 'the chapter is past its intro and RUNNING', !!after.mission &&
    after.phase !== 'intro' && after.phase !== 'over',
    `mission ${after.mission}, phase ${after.phase}`);
  rec(A, 'the objective panel tells the player what to do',
    after.objective.length > 0, `"${after.objective}"`);
  rec(A, 'SKIP ALL leaves no pause menu behind', after.menuVis < 0.02,
    `menu opacity ${after.menuVis}`);
}

/* ======================================================================== */
/* 5 — the invariant: nothing is left holding the clock                     */
/* ======================================================================== */

async function caseInvariant() {
  const A = '5 · invariant';
  // Escape must still open the pause menu once the cutscene is gone — proof
  // the cut released the keyboard as well as the clock.
  await tap('Escape', 16);
  const p = await snap();
  rec(A, 'ESC works again after the cutscene', p.menuVis > 0.5,
    `menu opacity ${p.menuVis}`);
  await tap('Escape', 16);
  const out = await snap();
  rec(A, 'ESC resumes cleanly', out.menuVis < 0.02, `menu opacity ${out.menuVis}`);
  const ran = await worldRan();
  rec(A, 'the world is at full speed at the end of the run', ran.rate > 0.85, at(ran));
}

/* ======================================================================== */
/* 6 — the live controls for case 2c                                        */
/* ======================================================================== */

/**
 * "K did not abandon the chapter during a cutscene" is trivially true of a
 * build with no K at all. LAST, because these deliberately wreck the state.
 */
async function caseLiveControls() {
  const A = '6 · CONTROL — the same keys, in play';

  await tap('KeyM', 16);
  const m = await snap();
  rec(A, 'CONTROL — M opens the map in play', m.mapVis > 0.5, `map opacity ${m.mapVis}`);
  await tap('KeyM', 16);

  const u0 = await snap();
  await tap('KeyU', 24);
  const u1 = await snap();
  rec(A, 'CONTROL — U switches brother in play',
    u1.character !== u0.character && u1.accent !== u0.accent,
    `${u0.character} (${u0.accent}) -> ${u1.character} (${u1.accent})`);

  // Arm a chapter if the brother switch dropped the one that was running, so
  // the control can never pass on a null -> null no-op.
  let armed = (await snap()).mission;
  if (!armed) {
    await tap('KeyJ', 40);
    armed = (await snap()).mission;
    // Get out of the intro so K is abandoning a real chapter, not a scene.
    await page.click('.ow-cut-skip', { timeout: 3000 }).catch(() => {});
    await pump(30);
  }
  await tap('KeyK', 30);
  const gone = await snap();
  rec(A, 'CONTROL — K abandons the chapter in play',
    armed !== null && gone.mission === null, `mission ${armed} -> ${gone.mission}`);
}

/* ======================================================================== */
/* 7 — the mouse: the lock, the button, and the latch behind it             */
/* ======================================================================== */

/**
 * A player watching a cutscene arrives POINTER LOCKED — that is how he was
 * steering a second ago. Two things follow, and both are invisible to a probe
 * that does not model the lock:
 *
 *   - while locked the cursor is hidden and every click goes to the canvas, so
 *     SKIP ALL and click-to-advance cannot be reached with a mouse at all;
 *   - `ui._input` reads "we had the lock and no longer do" as the player asking
 *     to pause, so releasing the lock arms a pause menu that springs open the
 *     instant the scene ends.
 *
 * Measured against what a real click would hit (`elementFromPoint`) and against
 * the pause menu's composited visibility, not against any flag.
 */
async function casePointerLock() {
  const A = '7 · the mouse and the pointer lock';
  // Case 6's K abandoned a chapter, which legitimately puts the FAILED card up
  // and holds the world for its own 4.6 s. Wait it out on the UNSCALED clock
  // before doing anything, or this case measures a frozen screen.
  await page.evaluate(() => window.__ENGINE__.ctx.peek('game')?.abortMission?.());
  for (let i = 0; i < 60 && (await snap()).cardVis > 0.02; i++) await pump(12);

  await page.evaluate(() => window.__LOCK__.grab());
  await pump(20);
  const locked = await page.evaluate(() => window.__LOCK__.locked);
  rec(A, 'CONTROL — the model grants pointer lock in play', locked === true,
    `pointerLockElement ${locked ? 'set' : 'null'}`);

  // Chapter 1 BY INDEX, not by J. Case 6 left the brother switched and the
  // chapter frontier moved, so `J` ("give me the next thing to do") can
  // legitimately hand back a side job instead of a story chapter — and this
  // case is about the mouse, not about what J picks.
  await page.evaluate(() => window.__ENGINE__.ctx.peek('game')?.startMission?.(0));
  await pump(30);
  const s = await snap();
  const up = !!s.mission && s.cutVis > 0.5;
  rec(A, 'the chapter started from a locked pointer', up,
    `mission ${s.mission}, cut opacity ${s.cutVis}, card ${s.cardVis}`);
  if (!up) {
    // Refuse to report on a scene that never ran. Everything below would be
    // trivially true with no cutscene on screen.
    rec(A, 'the cutscene RELEASES the pointer lock', false, 'no cutscene to measure');
    rec(A, 'a click at the SKIP button lands ON the SKIP button', false, 'no cutscene to measure');
    rec(A, 'the scene does NOT end in an unasked-for pause menu', false, 'no cutscene to measure');
    return;
  }

  rec(A, 'the cutscene RELEASES the pointer lock',
    (await page.evaluate(() => window.__LOCK__.locked)) === false,
    'pointerLockElement is null');

  // What would a real click at the SKIP button's centre actually hit?
  const hit = await page.evaluate(() => {
    const b = window.__ENGINE__.ctx.peek('ui').root.querySelector('.ow-cut-skip');
    if (!b) return 'missing';
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el === b ? 'the SKIP button' : (el?.className || el?.id || el?.tagName || 'nothing');
  });
  rec(A, 'a click at the SKIP button lands ON the SKIP button',
    hit === 'the SKIP button', `elementFromPoint -> ${hit}`);

  await page.click('.ow-cut-skip', { timeout: 4000 }).catch(() => {});
  await pump(40);
  const after = await snap();
  rec(A, 'the scene does NOT end in an unasked-for pause menu',
    after.menuVis < 0.02 && after.cutVis < 0.02,
    `menu opacity ${after.menuVis}, cut opacity ${after.cutVis}`);
  const ran = await worldRan();
  rec(A, 'the world is running after a lock-released cutscene', ran.rate > 0.85, at(ran));
}

/* ======================================================================== */

try {
  const errs = await boot();
  await caseControl();
  await caseStart();
  await caseTyping();
  await caseMode();
  await caseKeysStandDown();
  await caseAdvance();
  await caseSkipAll();
  await caseInvariant();
  await caseLiveControls();
  await casePointerLock();

  if (errs.length) {
    rec('7 · the mouse and the pointer lock', 'no console errors', false,
      [...new Set(errs)].slice(0, 3).join(' | '));
  }

  const pass = results.filter((r) => r.ok).length;
  const w = Math.max(...results.map((r) => r.name.length));
  let area = '';
  for (const r of results) {
    if (r.area !== area) { area = r.area; console.log(`\n--- ${area} ---`); }
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail ?? ''}`);
  }
  console.log(`\n${pass}/${results.length} cutscene behaviours working`);
  if (pass !== results.length) process.exitCode = 1;
} catch (e) {
  console.error('cutsceneprobe failed:', e.message);
  process.exitCode = 1;
} finally {
  if (!args.keep) {
    await page?.close().catch(() => {});
    await b.close();
  }
  server?.kill();
}
