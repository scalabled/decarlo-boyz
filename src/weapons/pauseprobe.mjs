#!/usr/bin/env node
/**
 * WEAPON PAUSE PROBE — can the arsenal be operated from behind a menu?
 *
 *   node src/weapons/pauseprobe.mjs
 *   node src/weapons/pauseprobe.mjs --port=5173      (reuse a running vite)
 *   node src/weapons/pauseprobe.mjs --nc             (NEGATIVE CONTROL: revert
 *                                                     the fix at runtime)
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `src/ui/pausearbiterprobe.mjs` proves the CLOCK stops and that `game`'s own
 * hotkeys (U / J / K) refuse to act while a modal is up. It says nothing about
 * `weapons`, and `weapons` is its own subsystem: `game._update`'s pause gate
 * does not cover it, and `time.scale = 0` does not stop anybody reading input —
 * `src/core/engine.js` calls `update(dt)` on every subsystem every frame however
 * slow the clock is, and input EDGES arrive at full rate regardless.
 *
 * So the player-visible bug was: open the pause menu, press a key, close the
 * menu, and be holding a different weapon. MEASURED on the shipped tree, menu at
 * opacity 1 and `time.scale 0` asserted in the same snapshot — Digit1 swapped
 * the weapon, E and Q cycled the loadout, I played the inspect animation, and
 * the HUD chip changed under the menu to prove it.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT THIS ASSERTS ON, AND WHAT IT REFUSES TO LOOK AT
 * ---------------------------------------------------------------------------
 * This file never reads the predicate the fix introduces. It never calls
 * `weapons._paused()`, never asks `ui.isPaused()`, and never reads `ui.pause`,
 * `menu.open` or any other flag the pause code branches on. Those are the code's
 * own inputs; comparing them to themselves would measure nothing.
 *
 * Every assertion is against an EMITTED artefact:
 *
 *   - which weapon is in his hands -> the text a player reads in the HUD chip,
 *     `.ow-weap-name` (`src/ui/vitals.js`). That string is produced by a
 *     separate pipeline — `weapons.getHudState()` -> `ui._pullState` ->
 *     `ui/data.js`'s name table -> DOM — so it cannot agree with the input gate
 *     by construction. `weapons.activeId` rides along as a second conjunct: a
 *     case fails if EITHER moved.
 *   - a reload happened            -> the canonical `weapon:reload` events.
 *   - a shot happened              -> the canonical `weapon:fire` events, filtered
 *     to this system's own sixteen ids (a cop's return fire raises the same
 *     event — see the long note in `arsenalprobe.mjs`).
 *   - an inspect happened          -> the animation clip the rig is playing.
 *   - the fire mode changed        -> the mode `ui` is handed for the HUD.
 *   - the menu really is up        -> composited DOM opacity, i.e. what a player
 *     would see, plus `time.scale` in the same snapshot. Asserted immediately
 *     before EVERY refusal, so no refusal can score green because the menu
 *     quietly failed to open.
 *
 * EVERY refusal is paired with a LIVE CONTROL that presses the same key with
 * nothing paused and requires it to work. Without those, deleting the keybinds
 * outright would score 100%.
 *
 * And the LAST case is the opposite guard: the weapon wheel claims bullet time,
 * not a freeze, so the number row must still work under it. A fix that gated on
 * "any overlay is visible" rather than on the arbiter's predicate passes
 * everything above and fails there.
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);
const NC = 'nc' in args;

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
 * One reading of everything the player can see or hear happen. Nothing in here
 * is a field the pause gate branches on.
 */
const snap = () =>
  page.evaluate(() => {
    const e = window.__ENGINE__;
    const ui = e.ctx.peek('ui');
    const wp = e.ctx.peek('weapons');

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
    const r = window.__WPREC__;
    return {
      scale: e.time.scale,
      menu: vis(ui.root.querySelector('.ow-menu')),
      map: vis(ui.root.querySelector('.ow-map')),
      phone: vis(ui.root.querySelector('.ow-phone')),
      story: vis(ui.root.querySelector('.ow-story')),
      wheel: Math.max(vis(ui.root.querySelector('.ow-wheel-weapons')),
        vis(ui.root.querySelector('.ow-wheel-chars'))),
      card: vis(ui.root.querySelector('.ow-card')),
      /* THE EMITTED WEAPON: the words in the HUD chip, bottom right. */
      chip: (ui.root.querySelector('.ow-weap-name')?.textContent ?? '').trim(),
      id: wp?.activeId ?? null,
      mode: wp?.getHudState?.().mode ?? null,
      clip: wp?.rig?.clipName ?? null,
      fires: r.fire,
      reloads: r.reload,
    };
  });

/** A weapon identity, as a player would describe it. */
const held = (s) => `${s.chip} [${s.id}]`;
const same = (a, c) => a.chip === c.chip && a.id === c.id;

const tap = async (code, frames = 16) => {
  await page.keyboard.press(code);
  await pump(frames);
};

/** Any overlay showing at all? Returns the list, so a failure names the culprit. */
const showing = (s) =>
  ['menu', 'map', 'phone', 'story', 'wheel', 'card'].filter((k) => s[k] > 0.02);

/**
 * Back to plain play with the same key a player has — ESC, up to six times.
 * Cases must not inherit each other's wreckage: on a broken build the previous
 * case can end with a modal still up, which changes what the NEXT case is even
 * testing. Returns how many presses it took — 0 on a sound build.
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

/**
 * Open the pause menu and PROVE it is open in the same breath — composited
 * opacity over 0.5 and a stopped clock, read out of ONE snapshot.
 *
 * The open is retried because the menu fades in on the UNSCALED clock and this
 * tree is worked on by several agents at once: under load a frame can be long
 * enough that twenty pumped frames land mid-fade. Retrying to GET the menu up
 * cannot weaken anything — whether ESC opens the menu at all is
 * `src/ui/pausearbiterprobe.mjs`'s gate, not this one — while the assertion
 * that it IS up, in the same snapshot as `time.scale`, is what every refusal
 * below rests on and is never retried away.
 */
const openMenu = async (A) => {
  let s = await snap();
  for (let i = 0; i < 4 && !(s.menu > 0.5 && s.scale === 0); i++) {
    if (showing(s).length === 0) await tap('Escape', 20);
    else await pump(20);
    s = await snap();
  }
  rec(A, 'the pause menu is genuinely up before the key is pressed',
    s.menu > 0.5 && s.scale === 0, `menu opacity ${s.menu}, time.scale ${s.scale}`);
  return s;
};

/**
 * Take the menu down and wait until the world is actually running again.
 * `reset` presses ESC; this additionally requires the clock back, because a
 * check that reads "what is in his hands after the menu closes" is meaningless
 * while the menu is still fading.
 */
const closeMenu = async () => {
  for (let i = 0; i < 6; i++) {
    const s = await snap();
    if (showing(s).length === 0 && s.scale === 1) return s;
    if (showing(s).length) await tap('Escape', 20);
    else await pump(20);
  }
  return snap();
};

async function boot() {
  page = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
  await page.goto(`http://127.0.0.1:${port}/?boot=0`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 240000 });
  await pump(90);

  await page.evaluate((nc) => {
    const e = window.__ENGINE__;
    e.input.enabled = true;
    e.input.frozen = false;
    e.ctx.peek('player')?.setControlEnabled?.(true);

    /* Somewhere flat, open and away from traffic, and no stars — a probe that
     * ends up in a firefight is measuring somebody else's `weapon:fire`. */
    const pl = e.ctx.peek('player');
    const w = e.ctx.peek('world');
    const gy = w?.walkableHeightAt?.(-60, 250) ?? 1;
    pl?.teleport?.({ x: -60, y: gy + 1.2, z: 250 }, 0);
    e.ctx.peek('police')?.clearWanted?.('probe');

    const wp = e.ctx.peek('weapons');
    /* THE NEGATIVE CONTROL: drop `ui.isPaused()` back out of `live`, which is
     * the shipped-tree behaviour this gate was written for. */
    if (nc) wp.debugIgnorePause = true;

    /**
     * A FULL LOADOUT. On a fresh save the brother carries two MELEE tools, and
     * R, B and the trigger are all legitimate no-ops on a length of dock pipe —
     * so the live controls could never go green and the refusals would be
     * decorative. `unlockEverything` is the story-completion state, not a
     * fiction: it is the same `setLoadout` path a finished save takes.
     */
    wp.unlockEverything();
    wp.refillAll();

    /* The emitted-event recorder. `weapon:fire` is EVERYONE's event — a cop
     * firing raises it too, with a string `weapon` and `police: true` — so only
     * this system's own descriptor objects are counted. */
    const MINE = new Set(wp.weaponIds);
    const r = { fire: 0, reload: 0, foreign: 0 };
    window.__WPREC__ = r;
    window.__WPRESET__ = () => { r.fire = 0; r.reload = 0; };
    e.ctx.events.on('weapon:fire', (p) => {
      const id = typeof p?.weapon === 'object' ? p.weapon?.id : null;
      if (p?.police || !id || !MINE.has(id)) return void r.foreign++;
      r.fire++;
    });
    e.ctx.events.on('weapon:reload', () => { r.reload++; });
  }, NC);
  await pump(30);
  return errs;
}

const zero = () => page.evaluate(() => window.__WPRESET__());

/** Which digit key selects a loadout slot that is NOT what he is holding now? */
const otherSlot = () =>
  page.evaluate(() => {
    const wp = window.__ENGINE__.ctx.peek('weapons');
    const i = wp.loadout.findIndex((w) => w !== wp.activeId);
    return i >= 0 && i < 6 ? `Digit${i + 1}` : null;
  });

/**
 * Put a magazine weapon with more than one fire mode in his hands. Carson's six
 * are all single-mode, so this switches brother — the same `setBrother` call
 * `game:character` makes. Everything after case 2 runs on it.
 */
const equipMagWeapon = () =>
  page.evaluate(() => {
    const wp = window.__ENGINE__.ctx.peek('weapons');
    for (const boy of ['aidan', 'dylan', 'carson']) {
      wp.setBrother(boy, true);
      wp.unlockEverything();
      const id = wp.loadout.find((w) => {
        const s = wp.states.get(w);
        return s && !s.def.melee && s.def.magSize > 4 && s.def.modes.length > 1;
      });
      if (id) {
        wp.setWeapon(id, true);
        wp.refillAll();
        return id;
      }
    }
    return null;
  });

/* ======================================================================== */
/* 1 — the number row                                                       */
/* ======================================================================== */

async function caseDigits() {
  const A = '1..6 — the loadout keys';
  await reset();

  // ---- LIVE CONTROLS ----------------------------------------------------
  const a0 = await snap();
  const k1 = await otherSlot();
  await tap(k1, 26);
  const a1 = await snap();
  rec(A, `CONTROL — ${k1} switches weapon in play`, !same(a0, a1),
    `${held(a0)} -> ${held(a1)}`);

  const k2 = await otherSlot();
  await tap(k2, 26);
  const a2 = await snap();
  rec(A, `CONTROL — ${k2} switches back in play`, !same(a1, a2),
    `${held(a1)} -> ${held(a2)}`);

  // ---- THE REFUSAL ------------------------------------------------------
  const k3 = await otherSlot();
  const p0 = await openMenu(A);
  await tap(k3, 26);
  const p1 = await snap();
  rec(A, `${k3} must NOT switch weapon while paused`, same(p0, p1),
    `${held(p0)} -> ${held(p1)}`);
  rec(A, 'the menu is still up and the clock still stopped after the press',
    p1.menu > 0.5 && p1.scale === 0, `menu opacity ${p1.menu}, time.scale ${p1.scale}`);

  const p2 = await closeMenu();
  rec(A, 'the SAME weapon is in his hands after the menu closes', same(p0, p2),
    `had ${held(p0)} before, has ${held(p2)} after`);
}

/* ======================================================================== */
/* 2 — E and Q, the documented cycle keys (CONTROLS.md:30)                  */
/* ======================================================================== */

async function caseCycle() {
  const A = 'E / Q — next / previous weapon';
  await reset();

  const a0 = await snap();
  await tap('KeyE', 26);
  const a1 = await snap();
  rec(A, 'CONTROL — E cycles to the next weapon in play', !same(a0, a1),
    `${held(a0)} -> ${held(a1)}`);
  await tap('KeyQ', 26);
  const a2 = await snap();
  rec(A, 'CONTROL — Q cycles back in play', !same(a1, a2),
    `${held(a1)} -> ${held(a2)}`);

  const p0 = await openMenu(A);
  await tap('KeyE', 26);
  const p1 = await snap();
  rec(A, 'E must NOT cycle while paused', same(p0, p1), `${held(p0)} -> ${held(p1)}`);
  /* TWICE, and then Q once. On a loadout of six that nets +1, so the
   * after-the-menu check below cannot pass by the presses cancelling out. */
  await tap('KeyE', 26);
  await tap('KeyQ', 26);
  const p2 = await snap();
  rec(A, 'Q must NOT cycle while paused', same(p0, p2), `${held(p1)} -> ${held(p2)}`);

  const p3 = await closeMenu();
  rec(A, 'the weapon survived E, E, Q behind the menu',
    same(p0, p3), `had ${held(p0)} before, has ${held(p3)} after`);
}

/* ======================================================================== */
/* 3 — R, the reload                                                        */
/* ======================================================================== */

async function caseReload(wid) {
  const A = 'R — reload';
  await reset();

  /* A part-spent magazine with reserve behind it, or R is a legitimate no-op
   * and the live control could never go green. */
  const spend = () =>
    page.evaluate((id) => {
      const wp = window.__ENGINE__.ctx.peek('weapons');
      wp.setWeapon(id, true);
      const s = wp.states.get(id);
      s.mag = 1;
      s.chambered = true;
      s.reserve = Math.max(s.reserve, 40);
    }, wid);

  await spend();
  await pump(40);
  await zero();
  await tap('KeyR', 40);
  const a = await snap();
  rec(A, 'CONTROL — R reloads in play', a.reloads > 0,
    `${a.reloads} weapon:reload events on ${wid}`);
  await pump(140);

  await spend();
  await pump(30);
  await openMenu(A);
  await zero();
  await tap('KeyR', 40);
  const p = await snap();
  rec(A, 'R must NOT start a reload while paused', p.reloads === 0,
    `${p.reloads} weapon:reload events on ${wid}`);
  await closeMenu();
  await pump(140);
}

/* ======================================================================== */
/* 4 — B (fire mode) and I (inspect)                                        */
/* ======================================================================== */

async function caseModeAndInspect(wid) {
  const A = 'B / I — fire mode and inspect';
  await reset();
  await page.evaluate((id) => {
    window.__ENGINE__.ctx.peek('weapons').setWeapon(id, true);
  }, wid);
  await pump(40);

  const a0 = await snap();
  await tap('KeyB', 16);
  const a1 = await snap();
  rec(A, 'CONTROL — B cycles the fire mode in play', a1.mode !== a0.mode,
    `${a0.mode} -> ${a1.mode}`);

  const p0 = await openMenu(A);
  await tap('KeyB', 16);
  const p1 = await snap();
  rec(A, 'B must NOT cycle the fire mode while paused', p1.mode === p0.mode,
    `${p0.mode} -> ${p1.mode}`);
  await closeMenu();

  // ---- I, the inspect animation ----------------------------------------
  await pump(60);
  await tap('KeyI', 8);
  const a = await snap();
  rec(A, 'CONTROL — I plays the inspect animation in play', a.clip === 'inspect',
    `rig clip ${a.clip ?? 'none'}`);
  await pump(160);

  await openMenu(A);
  await tap('KeyI', 8);
  const p = await snap();
  rec(A, 'I must NOT play the inspect animation while paused', p.clip !== 'inspect',
    `rig clip ${p.clip ?? 'none'}`);
  await closeMenu();
}

/* ======================================================================== */
/* 5 — the trigger. A gun fired from behind the pause menu.                 */
/* ======================================================================== */

/**
 * HOW THE TRIGGER IS DELIVERED, AND WHY IT IS NOT A PLAYWRIGHT CLICK.
 *
 * `ui/index.js:431` stops propagation of mousedown/mouseup on the WHOLE HUD
 * root, so any click whose target is inside it never reaches `Input` at all.
 * The pause menu is inside that root and covers the screen, so a real click
 * with the menu up is swallowed in the DOM before this subsystem could refuse
 * it — MEASURED: with the fix reverted, a playwright click at (1274, 714) with
 * the menu at opacity 1 produced 0 `weapon:fire`. A check written that way
 * cannot fail, which by rule 12 makes it decorative, and it would have been
 * reporting `ui`'s DOM guard as if it were this file's gate.
 *
 * The claim that CAN fail is the one that matters: a pause claim whose overlay
 * does not cover the click point (the result `card`, a phone or story panel
 * that leaves canvas exposed) leaves the mouse landing on the canvas, where
 * `Input`'s window-level listener takes it exactly like this. So the trigger is
 * delivered by dispatching on `window` — the same listener, the same
 * `_pendingDown`, the same `firePressed` edge that a canvas click produces —
 * and the live control uses the identical delivery, plus a real playwright
 * click alongside it to prove the two are equivalent.
 */
const mouseFire = (frames = 8) =>
  page.evaluate((k) => new Promise((done) => {
    const ev = (t) => window.dispatchEvent(
      new MouseEvent(t, { button: 0, buttons: t === 'mousedown' ? 1 : 0, bubbles: true }));
    ev('mousedown');
    let i = 0;
    const tick = () => {
      if (++i >= k) { ev('mouseup'); return void done(); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), frames);

async function caseTrigger(wid) {
  const A = 'LMB — the trigger';
  await reset();
  await page.evaluate((id) => {
    const wp = window.__ENGINE__.ctx.peek('weapons');
    wp.setWeapon(id, true);
    wp.refillAll();
  }, wid);
  await pump(50);

  // ---- CONTROL 1: a real click on the canvas ---------------------------
  await zero();
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await pump(8);
  await page.mouse.up();
  await pump(20);
  const a = await snap();
  rec(A, 'CONTROL — a real click fires the weapon in play', a.fires > 0,
    `${a.fires} weapon:fire events on ${wid}`);
  await page.evaluate(() => window.__ENGINE__.ctx.peek('police')?.clearWanted?.('probe'));
  await pump(40);

  // ---- CONTROL 2: the same delivery the refusal below uses -------------
  await zero();
  await mouseFire();
  await pump(20);
  const a2 = await snap();
  rec(A, 'CONTROL — the window-level trigger fires in play', a2.fires > 0,
    `${a2.fires} weapon:fire events on ${wid}`);
  await page.evaluate(() => window.__ENGINE__.ctx.peek('police')?.clearWanted?.('probe'));
  await pump(60);

  // ---- THE REFUSAL ------------------------------------------------------
  await openMenu(A);
  await zero();
  await mouseFire();
  await pump(20);
  const p = await snap();
  rec(A, 'the trigger must NOT fire while paused', p.fires === 0,
    `${p.fires} weapon:fire events`);
  rec(A, 'the menu is still up and the clock still stopped after the trigger',
    p.menu > 0.5 && p.scale === 0, `menu opacity ${p.menu}, time.scale ${p.scale}`);
  await closeMenu();
  await page.evaluate(() => window.__ENGINE__.ctx.peek('police')?.clearWanted?.('probe'));
}

/* ======================================================================== */
/* 6 — the wheel must still work. It is bullet time, NOT a freeze.          */
/* ======================================================================== */

async function caseWheelStillWorks() {
  const A = 'TAB — the weapon wheel is not a pause';
  await reset();
  /* Off slot 1 — slot 2 is the brother's melee tool and is never `fists` — so
   * the Digit1 below has somewhere to go and cannot pass as a no-op. */
  await tap('Digit2', 30);

  const a0 = await snap();
  await page.keyboard.down('Tab');
  await pump(22);
  const w = await snap();
  rec(A, 'holding TAB brings the weapon wheel up', w.wheel > 0.5,
    `wheel opacity ${w.wheel}, time.scale ${w.scale}`);
  /**
   * The wheel claims SLOW (0.22), not 0 — so the arbiter's `isPaused()` is
   * FALSE under it and the number row must go on working. This is the check
   * that fails if anyone re-gates the arsenal on "an overlay is visible".
   */
  await tap('Digit1', 22);
  await page.keyboard.up('Tab');
  await pump(26);
  const a1 = await snap();
  rec(A, 'the number row still works under the wheel', a1.id === 'fists' && !same(a0, a1),
    `${held(a0)} -> ${held(a1)}`);
  await closeMenu();
}

/* ======================================================================== */

try {
  const errs = await boot();
  await caseDigits();
  await caseCycle();
  /* Carson's six are all single-mode melee-or-single-shot, so R / B / the
   * trigger need a magazine weapon: switch to the brother who carries one. */
  const wid = await equipMagWeapon();
  if (!wid) throw new Error('no multi-mode magazine weapon in any loadout');
  await pump(40);
  await caseReload(wid);
  await caseModeAndInspect(wid);
  await caseTrigger(wid);
  await caseWheelStillWorks();

  const final = await snap();
  rec('invariant', 'nothing is left on screen at the end of the run',
    showing(final).length === 0, showing(final).join(', ') || 'clean');
  rec('invariant', 'the world is running again at the end of the run',
    final.scale === 1, `time.scale ${final.scale}`);
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
  console.log(`\n${pass}/${results.length} weapon-pause behaviours working${NC ? '  (NEGATIVE CONTROL — must be red)' : ''}`);
  if (pass !== results.length) process.exitCode = 1;
} catch (e) {
  console.error('weapons pauseprobe failed:', e.message);
  process.exitCode = 1;
} finally {
  await page?.close().catch(() => {});
  await b.close();
  server?.kill();
}
