#!/usr/bin/env node
/**
 * PAUSE ARBITER PROBE — does PAUSED actually mean paused?
 *
 *   node src/ui/pausearbiterprobe.mjs
 *   node src/ui/pausearbiterprobe.mjs --port=5173      (reuse a running vite)
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASURES, AND WHY IT DOES NOT ASK THE UI
 * ---------------------------------------------------------------------------
 * `src/ui/pauseprobe.mjs` already proves the player can get back OUT of the
 * pause menu. This one proves the opposite direction: that while he is IN it,
 * the world is stopped and nothing he touches reaches the game.
 *
 * ARCHITECTURE.md rule 12 — a gate must not re-use the code's own inputs. So
 * this file never reads `ui.pause`, `ui.isPaused()`, `menu.open`, `map.open` or
 * any other flag the pause code itself branches on. Every assertion is against
 * an EMITTED result:
 *
 *   - "the world is stopped"  -> `time.elapsed` measured across N real frames.
 *     `elapsed` is what every subsystem integrates against; the arbiter writes
 *     `scale`, the ENGINE produces `elapsed` from it. A build that sets the
 *     flag and forgets the clock fails here.
 *   - "the overlay is up"     -> composited visibility of the DOM node: display,
 *     visibility and the product of every ancestor's opacity, i.e. whether a
 *     player would see it.
 *   - "the brother changed"   -> the active character AND the `--accent` colour
 *     the whole HUD is drawn in.
 *   - "the chapter survived"  -> the live mission id and phase, and the text in
 *     the objective panel the player reads.
 *
 * Each refusal case is paired with a LIVE CONTROL that presses the same key
 * with nothing paused and requires it to work. Without those, deleting the
 * keybinds entirely would score 100%.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR SEQUENCES THAT WERE BROKEN
 * ---------------------------------------------------------------------------
 *   1. ESC                      -> menu up, world must stop
 *   2. ESC, M, ESC              -> the map must not open behind the menu, and
 *                                  resuming must not leave one over a live world
 *   3. hold TAB, ESC, release   -> the wheel's bullet-time claim must not
 *                                  restore full speed under the pause menu
 *   4. ESC, U / J / K           -> no hotkey may switch brother, consume the
 *                                  chapter's intro, or ABANDON THE CHAPTER
 *                                  while the player is looking at the menu
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);

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
 * One reading of everything a player can actually see or is actually playing.
 * Nothing in here is a field the pause code branches on.
 */
const snap = () =>
  page.evaluate(() => {
    const e = window.__ENGINE__;
    const ui = e.ctx.peek('ui');
    const g = e.ctx.peek('game');

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
    const M = g?.missions?.M ?? null;
    return {
      scale: e.time.scale,
      elapsed: e.time.elapsed,
      raw: e.time.raw,
      menu: vis(ui.root.querySelector('.ow-menu')),
      map: vis(ui.root.querySelector('.ow-map')),
      phone: vis(ui.root.querySelector('.ow-phone')),
      story: vis(ui.root.querySelector('.ow-story')),
      wheel: Math.max(vis(ui.root.querySelector('.ow-wheel-weapons')),
        vis(ui.root.querySelector('.ow-wheel-chars'))),
      card: vis(ui.root.querySelector('.ow-card')),
      character: g?.character ?? null,
      accent: getComputedStyle(ui.root).getPropertyValue('--accent').trim(),
      mission: M && g.missions.active ? M.id : null,
      phase: M && g.missions.active ? M.phase : null,
      objective: (ui.root.querySelector('.ow-obj-text')?.textContent ?? '').trim(),
    };
  });

/**
 * How fast is the world actually running? Measured off the engine clock, not a
 * flag: `rate` is scaled seconds per unscaled second, i.e. simulated time
 * divided by real time across the same frames.
 *
 * The ratio matters rather than the raw delta. A first cut asserted bullet time
 * as "under 0.2 s of elapsed over 26 frames", which is a statement about the
 * HARNESS's frame rate, not the game's clock: the same correct build scored
 * 0.117 s on one run and 0.224 s on a slower one and the check flapped. Divided
 * by the real time those frames took, bullet time is 0.22 on every machine.
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
  };
};

/** Simulated seconds per real second, as a readable detail line. */
const at = (r) => `${r.d}s of sim in ${r.raw}s real — ${(r.rate * 100).toFixed(0)}% speed`;

const tap = async (code, frames = 12) => {
  await page.keyboard.press(code);
  await pump(frames);
};

/**
 * Let `secs` of UNSCALED time go by. `time.raw` is wall clock — the pause
 * system never touches it — so this is a wait that cannot be defined in terms
 * of the thing under test, and it does not race a fading overlay the way
 * polling for "nothing visible" does.
 */
const untilRaw = async (secs) => {
  const raw = () => page.evaluate(() => window.__ENGINE__.time.raw);
  const t0 = await raw();
  for (let i = 0; i < 80; i++) {
    await pump(20);
    const d = (await raw()) - t0;
    if (d >= secs) return +d.toFixed(2);
  }
  return -1;
};

/** Any overlay showing at all? Returns the list, so a failure names the culprit. */
const showing = (s) =>
  ['menu', 'map', 'phone', 'story', 'wheel', 'card'].filter((k) => s[k] > 0.02);

/**
 * Put the screen back to plain play with the same key a player has — ESC, up
 * to six times. Cases must not inherit each other's wreckage: on a broken
 * build the previous case can end with a map still up, which changes what the
 * NEXT case is even testing (a live map suppresses the weapon wheel, so
 * "holding TAB opens the wheel" would fail for a reason that is not the one
 * being measured). Returns how many presses it took — 0 on a sound build.
 */
const reset = async () => {
  let n = 0;
  for (; n < 6; n++) {
    if (showing(await snap()).length === 0) break;
    await tap('Escape');
  }
  await pump(12);
  return n;
};

async function boot() {
  page = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
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
/* 1 — ESC stops the world, ESC starts it again                             */
/* ======================================================================== */

async function caseEscape() {
  const A = 'ESC — the pause menu';
  const before = await worldRan();
  rec(A, 'the world runs at full speed before anything is pressed',
    before.rate > 0.85, at(before));

  await tap('Escape');
  const p = await snap();
  rec(A, 'ESC puts the pause menu on screen', p.menu > 0.5, `menu opacity ${p.menu}`);
  const frozen = await worldRan();
  rec(A, 'the paused world does not advance one frame', frozen.d === 0,
    `${at(frozen)} (time.scale ${(await snap()).scale})`);

  await tap('Escape');
  const r = await snap();
  rec(A, 'ESC again takes the menu off screen', r.menu < 0.02, `menu opacity ${r.menu}`);
  const ran = await worldRan();
  rec(A, 'the world runs at full speed again after resuming', ran.rate > 0.85, at(ran));
  rec(A, 'resuming leaves nothing on screen', showing(r).length === 0,
    showing(r).join(', ') || 'clean');
}

/* ======================================================================== */
/* 2 — ESC then M: no second modal behind the menu, and none left behind    */
/* ======================================================================== */

async function caseMapUnderMenu() {
  const A = 'ESC then M — the map';
  await reset();

  // LIVE CONTROL first: M must genuinely work when nothing is paused, or the
  // refusal below would pass on a build where M was simply deleted.
  await tap('KeyM');
  const live = await snap();
  rec(A, 'CONTROL — M opens the map in play', live.map > 0.5, `map opacity ${live.map}`);
  const mapFroze = await worldRan();
  rec(A, 'CONTROL — the open map stops the world', mapFroze.d === 0, at(mapFroze));
  await tap('KeyM');
  await pump(14);
  const closed = await snap();
  rec(A, 'CONTROL — M closes the map again', closed.map < 0.02, `map opacity ${closed.map}`);

  // The failing sequence.
  await tap('Escape');
  await tap('KeyM');
  const s = await snap();
  rec(A, 'M does not open the map from behind the pause menu', s.map < 0.02,
    `map opacity ${s.map}, menu opacity ${s.menu}`);
  const stillFrozen = await worldRan();
  rec(A, 'the world is still stopped after M was pressed while paused',
    stillFrozen.d === 0, at(stillFrozen));

  await tap('Escape');
  await pump(16);
  const out = await snap();
  rec(A, 'resuming leaves NO overlay over the live world', showing(out).length === 0,
    showing(out).join(', ') || 'clean');
  const ran = await worldRan();
  rec(A, 'the world runs at full speed after ESC / M / ESC', ran.rate > 0.85, at(ran));
}

/* ======================================================================== */
/* 3 — hold TAB, press ESC: bullet time must not out-rank the pause menu    */
/* ======================================================================== */

async function caseWheelThenEscape() {
  const A = 'TAB held then ESC — the wheel';
  await reset();

  await page.keyboard.down('Tab');
  await pump(16);
  const w = await snap();
  rec(A, 'CONTROL — holding TAB brings the weapon wheel up', w.wheel > 0.5,
    `wheel opacity ${w.wheel}`);
  // Bullet time is SLOW = 0.22 in `wheels.js`. The band is wide because the
  // point is to tell three states apart — stopped, slowed, full speed — not to
  // re-assert the constant the code already holds.
  const slow = await worldRan();
  rec(A, 'CONTROL — the wheel slows the world without stopping it',
    slow.rate > 0.08 && slow.rate < 0.5, `${at(slow)} (bullet time)`);

  // THE BUG: line 1642 opened the menu, line 1751 handed the clock back.
  await page.keyboard.press('Escape');
  await pump(14);
  const p = await snap();
  rec(A, 'ESC with TAB still held opens the pause menu', p.menu > 0.5,
    `menu opacity ${p.menu}`);
  const frozen = await worldRan();
  rec(A, 'the world is STOPPED, not restored to full speed, under the menu',
    frozen.d === 0, `${at(frozen)} (time.scale ${p.scale})`);

  await page.keyboard.up('Tab');
  await pump(16);
  const rel = await snap();
  rec(A, 'releasing TAB leaves the pause menu up', rel.menu > 0.5,
    `menu opacity ${rel.menu}`);
  const stillFrozen = await worldRan();
  rec(A, 'the world is still stopped after TAB is released', stillFrozen.d === 0,
    at(stillFrozen));

  await tap('Escape');
  await pump(18);
  const out = await snap();
  rec(A, 'ESC resumes cleanly out of the TAB+ESC trap', showing(out).length === 0,
    showing(out).join(', ') || 'clean');
  // Not just "moving": the old code left the clock stuck in bullet time for the
  // rest of the session once this sequence had been run.
  const ran = await worldRan();
  rec(A, 'full speed comes back, not bullet time', ran.rate > 0.85, at(ran));
}

/* ======================================================================== */
/* 4 — the game's own hotkeys must not fire from behind the menu            */
/* ======================================================================== */

async function caseGameHotkeys() {
  const A = 'ESC then U / J / K — game hotkeys';
  await page.keyboard.up('Tab').catch(() => {});
  await reset();

  // ---- U, the brother switch -------------------------------------------
  const b0 = await snap();
  await tap('KeyU', 20);
  const b1 = await snap();
  rec(A, 'CONTROL — U switches brother in play',
    b1.character !== b0.character && b1.accent !== b0.accent,
    `${b0.character} (${b0.accent}) -> ${b1.character} (${b1.accent})`);

  await tap('Escape');
  await tap('KeyU', 20);
  const b2 = await snap();
  rec(A, 'U does not switch brother while paused',
    b2.character === b1.character && b2.accent === b1.accent,
    `${b1.character} -> ${b2.character}`);
  await tap('Escape');
  await pump(14);

  // ---- J, the chapter -------------------------------------------------
  await tap('KeyJ', 40);
  const m0 = await snap();
  rec(A, 'CONTROL — J starts the chapter in play', !!m0.mission,
    `mission ${m0.mission}, phase ${m0.phase}, objective "${m0.objective}"`);

  await tap('Escape');
  const paused = await snap();
  await tap('KeyJ', 30);
  const m1 = await snap();
  rec(A, 'J does not consume the intro cutscene while paused',
    m1.phase === paused.phase && m1.mission === paused.mission,
    `phase ${paused.phase} -> ${m1.phase}`);

  // ---- K, the one that destroys progress -------------------------------
  await tap('KeyK', 30);
  const m2 = await snap();
  rec(A, 'K DOES NOT ABANDON THE CHAPTER while paused',
    m2.mission === paused.mission && m2.mission !== null,
    `mission ${paused.mission} -> ${m2.mission}`);

  await tap('Escape');
  await pump(20);
  const back = await snap();
  rec(A, 'the chapter is still there when the menu comes down',
    back.mission === paused.mission && back.mission !== null,
    `mission ${back.mission}, objective "${back.objective}"`);
  rec(A, 'nothing is left on screen after the hotkey sequence',
    showing(back).length === 0, showing(back).join(', ') || 'clean');

  // LIVE CONTROL for K — it has to still work when the game is running, or
  // "K did not abandon the chapter" would be true of a build with no K at all.
  // Arm a chapter first if the broken build already threw this one away, so
  // the control can never pass on a null -> null no-op.
  let armed = back.mission;
  if (!armed) {
    await tap('KeyJ', 40);
    armed = (await snap()).mission;
  }
  await tap('KeyK', 30);
  const gone = await snap();
  rec(A, 'CONTROL — K abandons the chapter in play',
    armed !== null && gone.mission === null,
    `mission ${armed} -> ${gone.mission}`);
}

/* ======================================================================== */

try {
  const errs = await boot();
  await caseEscape();
  await caseMapUnderMenu();
  await caseWheelThenEscape();
  await caseGameHotkeys();

  /**
   * The last K failed a chapter, which puts the FAILED card up — and that card
   * legitimately holds the world still for its own 4.6 s. It runs on the RAW
   * clock, which is what lets it fade while the sim is frozen, so it takes
   * itself down without anyone pressing anything.
   *
   * That makes it the one claim nobody releases by hand: if the arbiter only
   * handed the clock back on a key press, the world would stay stopped here
   * forever. Wait it out and require full speed on a clean screen.
   */
  const waited = await untilRaw(6.5);
  const final = await snap();
  rec('invariant', 'a claim that expires by itself hands the clock back',
    final.scale === 1 && showing(final).length === 0,
    `after ${waited}s of unscaled time: time.scale ${final.scale}, ` +
    `showing ${showing(final).join(', ') || 'nothing'}`);
  const ran = await worldRan();
  rec('invariant', 'the world is at full speed at the end of the whole run',
    ran.rate > 0.85, at(ran));
  if (errs.length) {
    rec('invariant', 'no console errors', false, [...new Set(errs)].slice(0, 3).join(' | '));
  }

  const pass = results.filter((r) => r.ok).length;
  const w = Math.max(...results.map((r) => r.name.length));
  let area = '';
  for (const r of results) {
    if (r.area !== area) { area = r.area; console.log(`\n--- ${area} ---`); }
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail ?? ''}`);
  }
  console.log(`\n${pass}/${results.length} pause-arbiter behaviours working`);
  if (pass !== results.length) process.exitCode = 1;
} catch (e) {
  console.error('pausearbiterprobe failed:', e.message);
  process.exitCode = 1;
} finally {
  await page?.close().catch(() => {});
  await b.close();
  server?.kill();
}
