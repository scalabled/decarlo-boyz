#!/usr/bin/env node
/**
 * PAUSE PROBE — can the player get back OUT of the pause menu?
 *
 *   npm run build && node src/ui/pauseprobe.mjs
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHY IT SHIMS THE BROWSER
 * ---------------------------------------------------------------------------
 * The failure this gates: the ESC menu does not let you click Resume or press
 * ESC to close it, and a page refresh is the only way out. Every automated probe
 * in the repo passed while that was true, and so did driving the menu by hand
 * through Playwright.
 *
 * The reason is that **headless Chromium never grants pointer lock**. Verified:
 * with `--headless=new`, with `--allow-pointer-lock-without-user-gesture`, after
 * a real user-gesture click, `document.pointerLockElement` stays null forever.
 * The entire bug lives in the pointer-lock path, so no harness that runs against
 * stock headless can see it — which is exactly how it shipped.
 *
 * So this probe installs a small, faithful model of the two pointer-lock
 * behaviours a real browser has and headless omits:
 *
 *   1. `requestPointerLock()` actually succeeds, ASYNCHRONOUSLY, and fires
 *      `pointerlockchange`.
 *   2. While the pointer is locked, Escape is CONSUMED by the user agent to
 *      exit the lock and is never dispatched to the page, and mouse events are
 *      delivered to the lock element rather than to whatever is under the
 *      (hidden) cursor.
 *
 * Clicks are then driven with a human's ~90 ms between mousedown and mouseup,
 * because that gap is the whole bug: an instantaneous synthetic click beats the
 * lock request and passes, a human's click does not.
 *
 * Against the unfixed code this probe fails on
 * "clicking Resume closes the menu" and on both ESC cases. Against the fix it
 * passes.
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);

/* ------------------------------------------------------------------ shim -- */

/**
 * Runs before any page script. Replaces the pointer-lock API with a working
 * model of Chrome's, and exposes `__LOCK__` / `__CLICK__` for the probe to
 * drive the player's hands through.
 */
function installPointerLockModel() {
  let lockEl = null;
  const fire = () => document.dispatchEvent(new Event('pointerlockchange', { bubbles: true }));

  Object.defineProperty(Document.prototype, 'pointerLockElement', {
    configurable: true,
    get: () => lockEl,
  });

  Element.prototype.requestPointerLock = function requestPointerLock() {
    // Real Chrome resolves this asynchronously. That latency is why a human's
    // click loses its mouseup to the canvas and a synthetic one does not.
    return new Promise((resolve) => {
      setTimeout(() => {
        lockEl = this;
        window.__LOCK__.grants++;
        fire();
        resolve();
      }, 8);
    });
  };

  Document.prototype.exitPointerLock = function exitPointerLock() {
    if (!lockEl) return;
    lockEl = null;
    window.__LOCK__.exits++;
    fire();
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.__LOCK__ = {
    grants: 0,
    exits: 0,
    get el() { return lockEl; },
    get locked() { return !!lockEl; },
    /** The user agent's own Escape handling: eat the key, drop the lock. */
    escape() {
      if (!lockEl) return false;
      lockEl = null;
      window.__LOCK__.exits++;
      fire();
      return true;
    },
  };

  /** A human click: press, hold ~90 ms, release. Models lock retargeting. */
  window.__CLICK__ = async (x, y, holdMs = 90) => {
    const target = document.elementFromPoint(x, y);
    if (!target) return { error: 'nothing at ' + x + ',' + y };
    const name = (el) => (el ? (el.className || el.tagName) : 'null');
    const mk = (type, el) => el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' ? 0 : 1,
    }));
    const lockBefore = lockEl;
    mk('mousedown', target);
    await sleep(holdMs);
    // Chrome delivers mouse events to the LOCK ELEMENT while locked, so a lock
    // acquired during the hold steals the rest of the click from the button.
    const dest = lockEl ?? target;
    mk('mouseup', dest);
    mk('click', dest);
    return {
      target: name(target),
      landedOn: name(dest),
      stolen: dest !== target,
      lockBefore: !!lockBefore,
      lockAfter: !!lockEl,
    };
  };
}

/* ------------------------------------------------------------------ probe -- */

const { port, server } = await startServer({ explicitPort: args.port });
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});

const results = [];
const rec = (area, name, ok, detail) => results.push({ area, name, ok, detail });
let page;

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

const snap = () =>
  page.evaluate(() => {
    const e = window.__ENGINE__;
    const ui = e.ctx.peek('ui');
    const pl = e.ctx.peek('player');
    const r = ui.menu.resumeBtn.getBoundingClientRect();
    return {
      open: !!ui.menu.open,
      scale: e.time.scale,
      elapsed: +e.time.elapsed.toFixed(3),
      locked: !!document.pointerLockElement,
      grants: window.__LOCK__.grants,
      hadLock: !!ui._hadPointerLock,
      control: pl?.controlEnabled !== false,
      pos: pl?.position ? [+pl.position.x.toFixed(2), +pl.position.z.toFixed(2)] : null,
      resume: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2),
        Math.round(r.width), Math.round(r.height)],
      closeX: (() => {
        const c = ui.menu.closeBtn?.getBoundingClientRect();
        return c ? [Math.round(c.left + c.width / 2), Math.round(c.top + c.height / 2),
          Math.round(c.width), Math.round(c.height)] : null;
      })(),
      hud: getComputedStyle(ui.menu.root).display,
    };
  });

/** The player presses Escape. If the pointer is locked the browser eats it. */
const playerEsc = async () => {
  const eaten = await page.evaluate(() => window.__LOCK__.escape());
  if (!eaten) await page.keyboard.press('Escape');
  await pump(14);
  return eaten ? 'eaten by the browser (lock exit)' : 'delivered to the page';
};

/** Does the world actually tick? Measured, not asserted from a flag. */
const simRuns = async () => {
  const a = await snap();
  await pump(24);
  const c = await snap();
  return { ran: c.elapsed > a.elapsed + 0.02, from: a.elapsed, to: c.elapsed };
};

async function run(label, viewport, touch) {
  page = await b.newPage({ viewport, hasTouch: touch, isMobile: touch });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
  await page.addInitScript(installPointerLockModel);

  await page.goto(`http://127.0.0.1:${port}/?boot=0`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  await pump(90);
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.input.enabled = true; e.input.frozen = false;
    e.ctx.peek('player')?.setControlEnabled?.(true);
  });
  await pump(20);

  // The player clicks into the world, the way every mouse-look game starts.
  // On a phone that click lands on the camera-drag zone, which must NOT lock —
  // touch look is a drag, and a locked pointer there would be a bug of its own.
  await page.evaluate(() => window.__CLICK__(innerWidth / 2, innerHeight / 2));
  await pump(20);
  const playing = await snap();
  rec(label,
    touch ? 'clicking the world does not lock the pointer on touch'
      : 'clicking the world locks the pointer',
    touch ? !playing.locked : playing.locked,
    `locked ${playing.locked}, grants ${playing.grants}`);

  // ---- ESC #1: open ------------------------------------------------------
  const how1 = await playerEsc();
  await pump(20);
  const paused = await snap();
  rec(label, 'ESC opens the pause menu', paused.open, `${how1} · open ${paused.open}`);
  rec(label, 'pausing freezes the sim', paused.scale === 0, `time.scale ${paused.scale}`);
  rec(label, 'the menu is not pointer-locked', !paused.locked,
    `locked ${paused.locked} — a locked pointer makes the browser eat ESC`);

  // ---- Resume, by click --------------------------------------------------
  const click = await page.evaluate(
    ([x, y]) => window.__CLICK__(x, y), paused.resume.slice(0, 2)
  );
  await pump(20);
  const resumed = await snap();
  rec(label, 'the Resume click is not stolen by a pointer-lock grab', !click.stolen,
    `pressed "${click.target}", released on "${click.landedOn}"`);
  rec(label, 'clicking Resume closes the menu', !resumed.open, `open ${resumed.open}`);
  rec(label, 'clicking Resume restores the clock', resumed.scale === 1,
    `time.scale ${resumed.scale}`);
  const ranA = await simRuns();
  rec(label, 'the sim is actually running after Resume', ranA.ran,
    `elapsed ${ranA.from} -> ${ranA.to}`);
  rec(label, 'the player has control back after Resume', (await snap()).control,
    `controlEnabled ${(await snap()).control}`);

  // The Resume button has to be a real target, not a 24 px sliver on a phone.
  const tgt = paused.resume;
  rec(label, 'Resume is a reachable tap target', tgt[2] >= 88 && tgt[3] >= 40,
    `${tgt[2]}x${tgt[3]} px at ${tgt[0]},${tgt[1]}`);
  const x = paused.closeX;
  rec(label, 'there is a second way out (the ✕)', !!x && x[2] >= 36 && x[3] >= 36,
    x ? `${x[2]}x${x[3]} px at ${x[0]},${x[1]}` : 'missing');

  // ---- ESC twice must end up back in the game ---------------------------
  // Open it, press ESC again, be playing.
  const how2 = await playerEsc();
  await pump(20);
  const paused2 = await snap();
  rec(label, 'ESC re-opens the menu after a resume', paused2.open,
    `${how2} · open ${paused2.open}`);

  const how3 = await playerEsc();
  await pump(20);
  const back = await snap();
  rec(label, 'ESC pressed twice puts the player back in the game', !back.open,
    `${how3} · open ${back.open}`);
  rec(label, 'the clock is running after the ESC exit', back.scale === 1,
    `time.scale ${back.scale}`);
  const ranB = await simRuns();
  rec(label, 'the sim is actually running after the ESC exit', ranB.ran,
    `elapsed ${ranB.from} -> ${ranB.to}`);

  // ---- and W still walks -------------------------------------------------
  const p0 = (await snap()).pos;
  await page.keyboard.down('KeyW');
  await pump(70);
  await page.keyboard.up('KeyW');
  await pump(6);
  const p1 = (await snap()).pos;
  const walked = p0 && p1 ? Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) : 0;
  rec(label, 'W walks again once resumed', walked > 0.8, `${walked.toFixed(2)} m`);

  // ---- the trap itself: never end a cycle stuck --------------------------
  // Five open/close cycles alternating the two exits. A stale `_hadPointerLock`
  // or a lock re-acquired under the menu shows up here as a menu that will not
  // stay shut.
  let stuck = null;
  for (let i = 0; i < 5; i++) {
    await playerEsc();
    await pump(14);
    if (!(await snap()).open) { stuck = `cycle ${i}: ESC did not open the menu`; break; }
    if (i % 2 === 0) {
      const s = await snap();
      await page.evaluate(([px, py]) => window.__CLICK__(px, py), s.resume.slice(0, 2));
    } else {
      await playerEsc();
    }
    await pump(14);
    const s2 = await snap();
    if (s2.open) { stuck = `cycle ${i}: menu would not close`; break; }
    if (s2.scale !== 1) { stuck = `cycle ${i}: resumed into a frozen sim (scale ${s2.scale})`; break; }
  }
  rec(label, 'five open/close cycles never trap the player', !stuck,
    stuck ?? 'clicked out 3x, ESC out 2x, always resumed');

  /* ---- PAUSE-ON-MODAL: the map and the phone, through the real keys ------ */
  // The audit finding: only the pause menu froze the sim — you could be
  // attacked while reading the full map. These cases drive the real input
  // path (KeyM / KeyP) and measure the engine clock, not a ui flag.
  const modal = async (key, openSel, name) => {
    await page.keyboard.press(key);
    await pump(14);
    const o = await page.evaluate((sel) => {
      const e = window.__ENGINE__;
      const ui = e.ctx.peek('ui');
      return { open: !!(sel === 'map' ? ui.map.open : ui.phone.open), scale: e.time.scale };
    }, openSel);
    rec(label, `${key} opens the ${name}`, o.open, `open ${o.open}`);
    rec(label, `the ${name} freezes the sim`, o.scale === 0, `time.scale ${o.scale}`);
    await page.keyboard.press(key);
    await pump(14);
    const c = await page.evaluate((sel) => {
      const e = window.__ENGINE__;
      const ui = e.ctx.peek('ui');
      return { open: !!(sel === 'map' ? ui.map.open : ui.phone.open), scale: e.time.scale };
    }, openSel);
    rec(label, `${key} again closes the ${name} and restores the clock`,
      !c.open && c.scale === 1, `open ${c.open}, time.scale ${c.scale}`);
    const ran = await simRuns();
    rec(label, `the sim is actually running after the ${name}`, ran.ran,
      `elapsed ${ran.from} -> ${ran.to}`);
  };
  await modal('KeyM', 'map', 'full map');
  await modal('KeyP', 'phone', 'phone');

  if (errs.length) rec(label, 'no console errors', false, [...new Set(errs)].slice(0, 3).join(' | '));
  await page.close();
}

/**
 * The whole journey a real player takes, once: loader → select → intro → play.
 * It belongs in THIS file rather than the touch probe because the boot screens
 * are made of the same clickable DOM over the same canvas, and so they are
 * subject to the same pointer-lock click theft that made Resume dead. A START
 * button nobody can press is a game nobody can start.
 */
async function runBoot() {
  const label = 'boot journey';
  page = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  await page.addInitScript(installPointerLockModel);
  await page.goto(`http://127.0.0.1:${port}/?boot=1`, { waitUntil: 'domcontentloaded', timeout: 90000 });

  const early = await page.evaluate(() => ({
    up: !!document.querySelector('.ow-boot'),
    engine: !!window.__ENGINE__,
    bar: !!document.querySelector('.ow-boot-bar > i'),
  }));
  rec(label, 'the loader is up before the engine exists', early.up && !early.engine,
    `overlay ${early.up}, engine ${early.engine}`);
  rec(label, 'the loader has a progress bar', early.bar, String(early.bar));

  // It has to MOVE during init, when there is no frame loop to drive it.
  const a = await page.evaluate(() => window.__BOOT__.p);
  await page.waitForTimeout(2500);
  const c = await page.evaluate(() => window.__BOOT__.p);
  rec(label, 'the bar advances while the city is still loading', c > a,
    `${(a * 100).toFixed(0)}% -> ${(c * 100).toFixed(0)}%`);

  await page.waitForFunction('window.__BOOT__ && window.__BOOT__.phase === "select"',
    null, { timeout: 240000 });
  rec(label, 'the loader hands over to the character select', true, 'phase select');

  const target = await page.evaluate(() => {
    const now = window.__ENGINE__?.ctx?.peek?.('game')?.character ?? 'carson';
    return ['carson', 'aidan', 'dylan'].find((id) => id !== now) ?? 'aidan';
  });
  const at = (sel) => page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r ? [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] : null;
  }, sel);

  const pick = await page.evaluate(
    ([x, y]) => window.__CLICK__(x, y), await at(`.ow-boot-card[data-boy="${target}"]`)
  );
  await page.waitForTimeout(300);
  const onIntro = await page.evaluate(() => ({
    phase: window.__BOOT__.phase, pick: window.__BOOT__.pick,
    name: document.querySelector('.ow-boot-intro h1')?.textContent,
  }));
  rec(label, 'clicking a brother is not stolen by a pointer-lock grab', !pick.stolen,
    `pressed "${pick.target}", released on "${pick.landedOn}"`);
  rec(label, 'clicking a brother opens his intro card',
    onIntro.phase === 'intro' && onIntro.pick === target, `${onIntro.name}`);

  const go = await page.evaluate(
    ([x, y]) => window.__CLICK__(x, y), await at('.ow-boot-intro .ow-btn.primary')
  );
  await page.waitForTimeout(600);

  // START now drops a first-time player straight into the chapter's INTRO
  // CUTSCENE (the reference does the same; it is what makes story mode legible
  // — the player cannot miss what he is being asked to do). The sim is held by
  // the arbiter's `cut` claim while it plays, which is CORRECT: you do not
  // simulate the world during a narrative beat. Skip it the way a player does
  // (SKIP ALL) and let the clock be handed back, so the pause-menu assertions
  // below test the running game, not the cutscene. If the save has no pending
  // chapter (story done) there is no cutscene and this is a no-op.
  const skippedIntro = await page.evaluate(() => {
    const c = window.__ENGINE__.ctx.peek('ui')?.subs?.cut;
    if (c?.active) { c.skipAll?.(); return true; }
    return false;
  });
  if (skippedIntro) {
    await page.waitForFunction(() => window.__ENGINE__.time.scale === 1, null, { timeout: 8000 })
      .catch(() => {});
  }

  const playing = await page.evaluate(() => {
    const e = window.__ENGINE__;
    return {
      active: !!window.__BOOT__.active,
      character: e.ctx.peek('game')?.character ?? null,
      scale: e.time.scale,
      control: e.ctx.peek('player')?.controlEnabled !== false,
      elapsed: e.time.elapsed,
      locked: !!document.pointerLockElement,
    };
  });
  rec(label, 'the START click is not stolen by a pointer-lock grab', !go.stolen,
    `pressed "${go.target}", released on "${go.landedOn}"`);
  rec(label, 'START enters the game as the brother you picked',
    !playing.active && playing.character === target,
    `overlay gone ${!playing.active} · playing ${playing.character}`);
  rec(label, 'START opens the chapter intro (the onboarding a player cannot miss)',
    skippedIntro,
    skippedIntro ? 'intro cutscene played and was skippable' : 'no intro cutscene appeared on START');
  rec(label, 'the game runs with control once the intro is skipped',
    playing.scale === 1 && playing.control,
    `time.scale ${playing.scale}, control ${playing.control}`);
  // START lands in the intro CUTSCENE, which deliberately frees the cursor so
  // SKIP is clickable — so the lock is NOT held at this point, by design. The
  // real player journey is: skip the intro, click the world, and mouse-look
  // works. Assert that journey: a canvas click after the skip takes the lock.
  rec(label, 'the cutscene left the cursor free (SKIP was clickable)',
    !playing.locked, `locked ${playing.locked}`);
  await page.evaluate(() => window.__CLICK__(innerWidth / 2, innerHeight / 2));
  await page.waitForTimeout(300);
  const relocked = await page.evaluate(() => !!document.pointerLockElement);
  rec(label, 'clicking the world after the intro takes pointer lock',
    relocked, `locked ${relocked}`);

  // And the pause menu still behaves after arriving through the boot flow.
  const esc = async () => {
    const eaten = await page.evaluate(() => window.__LOCK__.escape());
    if (!eaten) await page.keyboard.press('Escape');
    await page.waitForTimeout(240);
  };
  await esc();
  const p1 = await page.evaluate(() => !!window.__ENGINE__.ctx.peek('ui').menu.open);
  await esc();
  const p2 = await page.evaluate(() => ({
    open: !!window.__ENGINE__.ctx.peek('ui').menu.open,
    scale: window.__ENGINE__.time.scale,
  }));
  rec(label, 'ESC twice still returns to the game after the boot flow',
    p1 && !p2.open && p2.scale === 1,
    `opened ${p1} · closed ${!p2.open} · time.scale ${p2.scale}`);

  if (errs.length) rec(label, 'no console errors', false, [...new Set(errs)].slice(0, 3).join(' | '));
  await page.close();
}

/**
 * Settings must survive a reload: every change is written to localStorage the
 * moment it happens and restored on load. The assertion is
 * against the LIVE ENGINE after a fresh boot (camera.fov, config.sensitivity,
 * game.missions.difficulty, the mixer's master gain) — never against the
 * localStorage contents, which would just re-read the probe's own input
 * (ARCHITECTURE.md rule 12).
 */
async function runSettings() {
  const label = 'settings persistence';

  // ONE browser context for both pages — `browser.newPage()` mints a fresh
  // context (and a fresh localStorage) every call, which would test nothing.
  const cx = await b.newContext({ viewport: { width: 1280, height: 720 } });

  // Page one: change things through the menu's real controls.
  page = await cx.newPage();
  await page.addInitScript(installPointerLockModel);
  await page.goto(`http://127.0.0.1:${port}/?boot=0`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  await pump(30);
  const setTo = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const ui = e.ctx.peek('ui');
    // The rendered FOV before any change — the player camera derives it from
    // config.fov every frame, so this is the physical baseline the restored
    // value has to visibly move.
    const camBefore = e.ctx.camera?.fov ?? null;
    ui.menu.show();
    ui.menu.fov.set(104);            // slider api: paint -> apply -> persist
    ui.menu.sens.set(1.6);
    ui.menu.master.set(0.35);
    ui.menu.music.set(0.6);
    ui.menu.setDifficulty('hard');
    ui.menu.close();
    return {
      camBefore,
      fov: e.ctx.config.fov,
      sens: +e.ctx.config.sensitivity.toFixed(6),
    };
  });
  rec(label, 'the sliders drive the live config before the reload',
    setTo.fov === 104 && Math.abs(setTo.sens - 0.0022 * 1.6) < 1e-6,
    `fov ${setTo.fov}, sensitivity ${setTo.sens}`);
  await page.close();

  // Page two: a cold boot in the same browser profile. Everything must come
  // back, measured from the running engine.
  //
  // `cx.newPage()`, NOT `b.newPage()`. This block spent its whole life on the
  // latter, which is the exact mistake the comment above `cx` warns about:
  // `browser.newPage()` mints a FRESH CONTEXT with a fresh, empty
  // localStorage, so page two could never see anything page one saved and
  // three of these four checks could not pass on any build, correct or not.
  // Verified by A/B: with `b.newPage()` they are red on an unmodified tree;
  // with `cx.newPage()` they go green on the same tree. A gate that cannot
  // pass is worth less than no gate, because it teaches people to skim past a
  // red line — ARCHITECTURE.md rule 12, in its cheapest possible form.
  page = await cx.newPage();
  await page.addInitScript(installPointerLockModel);
  await page.goto(`http://127.0.0.1:${port}/?boot=0`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  await pump(40);
  const back = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const g = e.ctx.peek('game');
    const a = e.ctx.peek('audio');
    const ui = e.ctx.peek('ui');
    return {
      fov: e.ctx.config.fov,
      camFov: e.ctx.camera?.fov ?? null,
      sens: +e.ctx.config.sensitivity.toFixed(6),
      difficulty: g?.difficulty ?? null,
      missionDifficulty: g?.missions?.difficulty ?? null,
      mixer: !!a?.mixer,
      master: a?.mixer?.masterVolume ?? null,
      audioPending: ui?.menu?._audioDirty ?? null,
    };
  });
  // The player camera scales config.fov per view (third person ~0.775x) and
  // rewrites camera.fov every frame — so the honest check is that the RENDERED
  // fov moved with the restored config, not that it equals it. 104/80 = 1.3;
  // require most of that ratio to show up in the drawn frustum.
  rec(label, 'FOV came back and reaches the live camera',
    back.fov === 104 && setTo.camBefore != null && back.camFov != null &&
      back.camFov > setTo.camBefore * 1.15,
    `config ${back.fov}, camera ${setTo.camBefore} -> ${back.camFov}`);
  rec(label, 'sensitivity came back into the live config',
    Math.abs(back.sens - 0.0022 * 1.6) < 1e-6, `sensitivity ${back.sens}`);
  rec(label, 'difficulty came back into the live mission system',
    back.difficulty === 'hard' && back.missionDifficulty === 'hard',
    `game ${back.difficulty}, missions ${back.missionDifficulty}`);
  // Headless may never build the mixer (it waits on a user gesture). Either
  // the live master gain carries the stored value, or the retry is still
  // armed to deliver it the moment the mixer exists.
  rec(label, 'master volume came back (or is armed for the mixer)',
    back.mixer ? Math.abs((back.master ?? -1) - 0.35) < 1e-6 : back.audioPending === true,
    back.mixer ? `mixer.masterVolume ${back.master}` : `no mixer yet, retry armed ${back.audioPending}`);
  await page.close();
  await cx.close();
}

try {
  await run('desktop', { width: 1280, height: 720 }, false);
  await run('phone', { width: 390, height: 844 }, true);
  await runBoot();
  await runSettings();

  const pass = results.filter((r) => r.ok).length;
  const w = Math.max(...results.map((r) => r.name.length));
  let area = '';
  for (const r of results) {
    if (r.area !== area) { area = r.area; console.log(`\n--- ${area} ---`); }
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail ?? ''}`);
  }
  console.log(`\n${pass}/${results.length} pause-menu behaviours working`);
  if (pass !== results.length) process.exitCode = 1;
} catch (e) {
  console.error('pauseprobe failed:', e.message);
  process.exitCode = 1;
} finally {
  await b.close();
  server?.kill();
}
