#!/usr/bin/env node
/**
 * PAGE LIFECYCLE PROBE — what happens to the run when you leave the tab?
 *
 *   node src/ui/lifecycleprobe.mjs
 *   node src/ui/lifecycleprobe.mjs --port=5173     (reuse a running vite)
 *   node src/ui/lifecycleprobe.mjs --verbose
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------------
 * `grep -rn "beforeunload\|visibilitychange" src/` returned NOTHING. Both need
 * wiring — one to save, one to pause. Without them:
 *
 *   - alt-tab out of a chase and Steel City kept running at full speed. Cops
 *     kept shooting, the mission clock kept counting down, fuel kept burning,
 *     all at a screen nobody was looking at.
 *   - close the tab and everything since the last event that happened to touch
 *     the debounced writer was gone.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT THIS MEASURES
 * ---------------------------------------------------------------------------
 *   "the world stopped"  -> `time.elapsed` across N real frames, i.e. the
 *                           quantity every subsystem integrates against. Never
 *                           `time.scale`, never `ui.isPaused()`, never a flag
 *                           the pause code itself branches on.
 *   "the menu came up"   -> composited visibility of the DOM node: display,
 *                           visibility, and every ancestor's opacity.
 *   "the run was saved"  -> the STRING in `localStorage`, re-parsed, and then
 *                           again after a REAL page navigation — the same
 *                           bytes the player's next session will read.
 *
 * The save value is a number nothing in the game writes on its own
 * (`totals.crashes`, set by hand with the debounced writer explicitly clean),
 * and the probe first asserts that it is NOT yet on disk. Without that step
 * "it is on disk afterwards" could be satisfied by an autosave that was going
 * to happen anyway, which would be a gate measuring the thing it is not about.
 *
 * ONE SEAM, NAMED. Headless Chromium will not change a page's visibility state
 * for any input this harness can give it — `bringToFront()` on a second tab
 * leaves `document.hidden === false` (measured). So `document.hidden` is
 * overridden on the document instance and a REAL `visibilitychange` event is
 * dispatched at it. The handler under test reads the property and the event
 * for real; what is faked is the browser's own bit, which is browser behaviour
 * rather than ours. The control below — dispatch the same event while visible
 * and require that NOTHING pauses — is what stops that seam from turning into
 * "any visibilitychange pauses the game", which would pause on the way BACK.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROL
 * ---------------------------------------------------------------------------
 * Three reverts in `src/main.js`, applied for real and measured. Green is
 * 10/10:
 *
 *   delete the `visibilitychange` listener   -> 7/10
 *   delete `beforeunload` + `pagehide`       -> 7/10
 *   `onHide` drops its `document.hidden` test -> 9/10 (the visible control)
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);
const VERBOSE = 'verbose' in args;
const SAVE_KEY = 'decarloboyz.save.v2';

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

const snap = () =>
  page.evaluate(() => {
    const e = window.__ENGINE__;
    const ui = e.ctx.peek('ui');
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
    return {
      elapsed: e.time.elapsed,
      raw: e.time.raw,
      menu: vis(ui?.root?.querySelector('.ow-menu')),
      hidden: document.hidden,
    };
  });

/** Simulated seconds per real second across `frames` real frames. */
const worldRan = async (frames = 30) => {
  const a = await snap();
  await pump(frames);
  const c = await snap();
  const d = c.elapsed - a.elapsed;
  const rawD = c.raw - a.raw;
  return { d: +d.toFixed(4), raw: +rawD.toFixed(4), rate: rawD > 1e-6 ? +(d / rawD).toFixed(3) : 0 };
};
const at = (r) => `${r.d}s of sim in ${r.raw}s real — ${(r.rate * 100).toFixed(0)}% speed`;

const stored = () =>
  page.evaluate((k) => {
    try {
      return JSON.parse(localStorage.getItem(k) ?? 'null');
    } catch {
      return null;
    }
  }, SAVE_KEY);

async function boot(first = true) {
  if (first) {
    page = await b.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
    await page.goto(`http://127.0.0.1:${port}/?boot=0`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  }
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await pump(80);
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.input.enabled = true;
    e.input.frozen = false;
  });
  await pump(20);
}
const errs = [];

/** Fake the browser's visibility bit; the event dispatched at it is real. */
const setHidden = (v) =>
  page.evaluate((hide) => {
    if (!window.__HIDDEN_PATCHED__) {
      window.__HIDDEN_PATCHED__ = true;
      window.__FAKE_HIDDEN__ = false;
      Object.defineProperty(document, 'hidden', {
        configurable: true, get: () => window.__FAKE_HIDDEN__ === true,
      });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true, get: () => (window.__FAKE_HIDDEN__ === true ? 'hidden' : 'visible'),
      });
    }
    window.__FAKE_HIDDEN__ = hide;
    document.dispatchEvent(new Event('visibilitychange'));
  }, v);

/* ======================================================================== */
/* 1 — alt-tab stops the city                                               */
/* ======================================================================== */

async function caseAutoPause() {
  const A = '1 leaving the tab';

  const before = await worldRan();
  rec(A, 'the world runs at full speed while the tab is in front',
    before.rate > 0.85, at(before));

  // CONTROL, and it has to come first: a visibilitychange that is not a HIDE
  // must change nothing. Without it, "pause on any visibilitychange" scores
  // full marks here and then pauses the game the instant you come back.
  await setHidden(false);
  await pump(10);
  const visibleEvent = await worldRan();
  const s0 = await snap();
  rec(A, 'a visibilitychange that is not a hide does nothing at all',
    visibleEvent.rate > 0.85 && s0.menu < 0.02,
    `${at(visibleEvent)}, menu opacity ${s0.menu}`);

  await setHidden(true);
  await pump(10);
  const s1 = await snap();
  rec(A, 'going away puts the pause menu on screen',
    s1.menu > 0.5, `menu opacity ${s1.menu}, document.hidden ${s1.hidden}`);

  const frozen = await worldRan();
  rec(A, 'and the city does not advance one frame while nobody is watching',
    frozen.d === 0 && frozen.raw > 0.05,
    at(frozen));

  // CONTROL: it has to be possible to come back. An auto-pause that cannot be
  // dismissed is worse than none.
  await setHidden(false);
  await pump(10);
  await page.keyboard.press('Escape');
  await pump(20);
  const backAgain = await worldRan();
  const s2 = await snap();
  rec(A, 'coming back and pressing ESC starts it again',
    backAgain.rate > 0.85 && s2.menu < 0.02,
    `${at(backAgain)}, menu opacity ${s2.menu}`);
}

/* ======================================================================== */
/* 2 — closing the tab does not cost the run                                */
/* ======================================================================== */

/**
 * Mark the live game with a value nothing writes on its own, and make sure the
 * debounced writer is not about to flush it for unrelated reasons.
 */
const mark = (crashes, chapter) =>
  page.evaluate(([c, ch]) => {
    const g = window.__ENGINE__.ctx.peek('game');
    g.save.totals.crashes = c;
    g.economy.char().chapter = ch;
    g.writer.dirty = false;
    g.writer.pending = 0;
    return { crashes: g.save.totals.crashes, chapter: g.economy.char().chapter, writes: g.writer.writes };
  }, [crashes, chapter]);

async function caseSaveOnLeave() {
  const A = '2 closing the tab';

  const m1 = await mark(4242, 7);
  await pump(30);
  const beforeUnload = await stored();
  rec(A, 'the unsaved progress really is unsaved to start with',
    (beforeUnload?.totals?.crashes ?? null) !== 4242,
    `in memory ${m1.crashes} crashes / chapter ${m1.chapter}; on disk ${beforeUnload?.totals?.crashes ?? 'nothing'}`);

  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
  await pump(4);
  const afterUnload = await stored();
  rec(A, 'beforeunload flushes it',
    afterUnload?.totals?.crashes === 4242 && afterUnload?.chars?.carson?.chapter === 7,
    `on disk: ${afterUnload?.totals?.crashes} crashes, carson chapter ${afterUnload?.chars?.carson?.chapter}`);

  // The one that is not a simulation: a value put in memory and then a REAL
  // navigation. If nothing listens, the reload loses it and the disk still
  // reads 4242 from the step above.
  await mark(777, 5);
  await pump(20);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await boot(false);
  const afterReload = await stored();
  rec(A, 'a real page navigation carries the run across',
    afterReload?.totals?.crashes === 777,
    `on disk after reload: ${afterReload?.totals?.crashes} crashes (4242 = the unload never fired)`);

  const live = await page.evaluate(() => {
    const g = window.__ENGINE__.ctx.peek('game');
    return { crashes: g.save.totals.crashes, chapter: g.economy.char().chapter };
  });
  rec(A, 'and the next session boots holding it',
    live.crashes === 777 && live.chapter === 5,
    `rebuilt: ${live.crashes} crashes, carson chapter ${live.chapter}`);
}

/* ======================================================================== */

let code = 0;
try {
  await boot(true);
  await caseAutoPause();
  await caseSaveOnLeave();
  rec('0 boot', 'the page booted without a script error', errs.length === 0,
    errs.length ? errs.slice(0, 3).join(' | ') : 'clean');

  let area = '';
  let failed = 0;
  for (const r of results.sort((a, x) => a.area.localeCompare(x.area))) {
    if (r.area !== area) {
      area = r.area;
      console.log(`\n=== ${area} ===`);
    }
    if (!r.ok) failed++;
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
    if (!r.ok || VERBOSE) console.log(`       ${r.detail}`);
  }
  console.log(`\nlifecycle: ${results.length - failed}/${results.length}`);
  code = failed ? 1 : 0;
} catch (err) {
  console.error('probe threw:', err);
  code = 2;
} finally {
  await b.close();
  server?.kill();
}
process.exit(code);
