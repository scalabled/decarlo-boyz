#!/usr/bin/env node
/**
 * CLOCK OWNER PROBE — one owner of `ctx.time.scale`, proven on the clock itself.
 *
 *   node src/ui/clockownerprobe.mjs
 *   node src/ui/clockownerprobe.mjs --port=5173      (reuse a running vite)
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASURES, AND WHY IT IS NOT THE CLAIM TABLE
 * ---------------------------------------------------------------------------
 * `src/ui/pauseprobe.mjs` proves the player can get back OUT of a modal.
 * `src/ui/pausearbiterprobe.mjs` proves the world is stopped while he is IN
 * one. Neither of them touches the arbiter's EXTERNAL claim interface, which is
 * the door `src/fx/hitstop.js` and the cutscene player come through — and the
 * defects that door was opened to close are all about who hands the clock back,
 * and at what speed.
 *
 * ARCHITECTURE.md rule 12 — a gate must not re-use the code's own inputs. So
 * every behavioural assertion here is a ratio taken off the ENGINE's clock:
 *
 *     rate = (time.elapsed after - before) / (time.raw after - before)
 *
 * simulated seconds per real second. `time.raw` is wall clock and no pause code
 * anywhere touches it; `time.elapsed` is accumulated by `Engine.step` from
 * `time.scale` (`src/core/engine.js:164`), one layer below anything under test.
 * The arbiter's `held`, `base`, `count`, `external` and `frozen`, `ui.isPaused()`
 * and `ui._wants` are NEVER asserted on — a build that keeps a perfect claim
 * table and forgets the clock fails every case below.
 *
 * The one exception is declared as such: `caseOneName` asserts a STRUCTURAL
 * fact (nothing on `ui` resolves to two different things under one name),
 * because that is what the defect WAS — a field shadowing a method. It is
 * paired with a behavioural half that drives the object it finds.
 *
 * Ratios, not deltas: an earlier cut of this file asserted bullet time as "under
 * 0.2 s of sim in 26 frames", which is a statement about the HARNESS's frame
 * rate and flapped between machines. See the same note in pausearbiterprobe.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE THINGS THAT WERE WRONG OR UNGUARDED
 * ---------------------------------------------------------------------------
 *   1. `ui.pause` was a method AND a field. The field won, `ui.pause()` threw
 *      `is not a function` for every caller outside the class, and `ui.resume()`
 *      went on working — which is what made it survive review.
 *   2. Nothing outside `ui` could claim the clock, so `src/fx/hitstop.js` wrote
 *      `time.scale` itself and `src/ui/mission.js` banked its own `_prevScale`:
 *      three writers, which is the disease the arbiter was built to cure.
 *   3. The cutscene was one of those writers.
 *   4. The arbiter banked `base = t.scale` ON THE FRAME the first claim landed.
 *      MEASURED before the fix, with a 0.12 stall live and a modal opened one
 *      frame into it: base banked 0.12, and thirty frames after the modal came
 *      down the world was still running at 0.12 simulated seconds per real
 *      second. `hitstop._heal` rescued the one writer that knew the trick.
 *      Nothing rescued anyone else.
 *   5. A minimum that is only taken over the derived claims lets an external 1
 *      out-vote a modal's 0 for a frame, depending on arrival order.
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
 * Everything the harness does to the game, in one page-side helper, so a case
 * is a sequence of steps rather than a stack of round trips. Steps run between
 * `requestAnimationFrame` callbacks, i.e. exactly where a DOM listener or a
 * lifecycle event lands — which is the window the one-frame leaks live in.
 *
 *   ['frames', n]        let n frames go by
 *   ['raw', s]           let s seconds of UNSCALED time go by (never scaled:
 *                        every claim here can stop `elapsed` dead)
 *   ['menu', bool]       the pause menu, the modal a player actually reaches
 *   ['claim', name, s]   the external interface under test
 *   ['release', name]    ... and its counterpart. `['release']` is teardown.
 *   ['scale', s]         a DIRECT writer that is not the arbiter and not
 *                        hitstop — a stand-in for any subsystem or harness that
 *                        parks the clock. Nothing heals this one.
 *   ['hitstop', s]       the real `src/fx/hitstop.js`, via its own request()
 *   ['hitstopHold', s]   ... refreshed every frame for s seconds of raw time,
 *                        so the stall is continuously live while it is measured
 *   ['cut', bool]        start / cancel a real cutscene through `ui.subs.cut`
 *   ['measure', tag, n]  Δelapsed / Δraw over n frames, recorded under `tag`
 */
const run = (steps) =>
  page.evaluate(async (script) => {
    const e = window.__ENGINE__;
    const ui = e.ctx.peek('ui');
    const hs = e.ctx.peek('fx')?.hitstop ?? null;
    const frame = () => new Promise((d) => requestAnimationFrame(d));
    const out = {};

    const CUT_LINES = [
      { who: 'carson', text: 'A line long enough to hold the screen for the whole of a measurement window, with room to spare either side.' },
      { who: 'aidan', text: 'And a second one behind it, so the scene cannot expire underneath the case that is running.' },
    ];

    for (const st of script) {
      const [op, a, c] = st;
      if (op === 'frames') { for (let i = 0; i < a; i++) await frame(); }
      else if (op === 'raw') {
        const t0 = e.time.raw;
        // Bounded: a stopped `elapsed` is the point, but a stopped `raw` would
        // mean the tab is not animating and the case should fail, not hang.
        for (let i = 0; i < 900 && e.time.raw - t0 < a; i++) await frame();
      } else if (op === 'menu') { if (a) ui.menu.show(); else ui.menu.close(); }
      /**
       * Feature-detected, not assumed. A probe that throws on a build without
       * the interface reports NOTHING — no score, no failing line, just a
       * stack trace — and "the harness crashed" is indistinguishable from "the
       * harness is broken". Missing means the step is a no-op and the
       * assertions below fail on their own terms, which is the report wanted.
       */
      else if (op === 'claim') { if (typeof ui.pause?.claim === 'function') ui.pause.claim(a, c); }
      else if (op === 'release') {
        if (typeof ui.pause?.release !== 'function') { /* nothing to drop */ }
        else if (a === undefined) ui.pause.release();
        else ui.pause.release(a);
      }
      else if (op === 'scale') e.time.scale = a;
      else if (op === 'hitstop') hs?.request(a);
      else if (op === 'hitstopHold') {
        const t0 = e.time.raw;
        for (let i = 0; i < 900 && e.time.raw - t0 < a; i++) { hs?.request(0.12); await frame(); }
      } else if (op === 'cut') {
        if (a) ui.subs.cut.play(CUT_LINES, { ctx: e.ctx, ui, context: 'clock probe' });
        else ui.subs.cut.cancel();
      } else if (op === 'measure') {
        const p = { e: e.time.elapsed, r: e.time.raw };
        for (let i = 0; i < c; i++) await frame();
        const q = { e: e.time.elapsed, r: e.time.raw };
        const d = q.e - p.e;
        const raw = q.r - p.r;
        out[a] = { d: +d.toFixed(5), raw: +raw.toFixed(4), rate: raw > 1e-6 ? +(d / raw).toFixed(3) : -1 };
      } else if (op === 'measureHitstop') {
        // Same as `measure`, but keeping the stall alive across the window.
        const p = { e: e.time.elapsed, r: e.time.raw };
        for (let i = 0; i < c; i++) { hs?.request(0.12); await frame(); }
        const q = { e: e.time.elapsed, r: e.time.raw };
        const d = q.e - p.e;
        const raw = q.r - p.r;
        out[a] = { d: +d.toFixed(5), raw: +raw.toFixed(4), rate: raw > 1e-6 ? +(d / raw).toFixed(3) : -1 };
      }
    }
    return out;
  }, steps);

/** Put the screen and the clock back to plain free play between cases. */
const clean = async () => {
  await page.evaluate(async () => {
    const e = window.__ENGINE__;
    const ui = e.ctx.peek('ui');
    const frame = () => new Promise((d) => requestAnimationFrame(d));
    ui.subs.cut.cancel();
    ui.menu.close();
    ui.cheats?.hide?.();
    e.ctx.peek('fx')?.hitstop?.release?.();
    if (typeof ui.pause?.release === 'function') {
      for (const n of ['probe', 'probeB', 'hitstop']) ui.pause.release(n);
      ui.pause.release();
    }
    e.time.scale = 1;
    // Long enough for the arbiter to re-adopt 1 as free play whatever the case
    // left behind, so no case can inherit the previous one's banked base.
    const t0 = e.time.raw;
    for (let i = 0; i < 300 && e.time.raw - t0 < 0.7; i++) await frame();
  });
};

const at = (r) => `${r.d}s of sim in ${r.raw}s real — ${(r.rate * 100).toFixed(0)}% speed`;

async function boot() {
  page = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
  await page.goto(`http://127.0.0.1:${port}/?boot=0&cheats=1`, {
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
/* 0 — one name, one thing                                                  */
/* ======================================================================== */

async function caseOneName() {
  const A = '0 — ui.pause resolves to exactly one thing';
  const s = await page.evaluate(() => {
    const ui = window.__ENGINE__.ctx.peek('ui');
    // Walk the whole prototype chain: the defect was a field on the instance
    // hiding a method declared on the class, and only the chain shows both.
    const decls = [];
    if (Object.prototype.hasOwnProperty.call(ui, 'pause')) decls.push(`own:${typeof ui.pause}`);
    for (let p = Object.getPrototypeOf(ui); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      if (Object.prototype.hasOwnProperty.call(p, 'pause')) decls.push(`proto:${typeof p.pause}`);
    }
    return {
      decls,
      claim: typeof ui.pause?.claim,
      release: typeof ui.pause?.release,
      // What `src/fx/hitstop.js:118-121` does to find the arbiter. If this stops
      // being the arbiter, hitstop silently refuses for ever.
      hitstopFinds: typeof (ui?.pause ?? null)?.claim,
    };
  });
  rec(A, 'nothing on ui declares `pause` twice', s.decls.length === 1,
    `declarations: ${s.decls.join(' + ') || 'none'}`);
  rec(A, 'the object hitstop reaches at ui.pause has the claim interface',
    s.hitstopFinds === 'function' && s.release === 'function',
    `claim ${s.claim}, release ${s.release}, via ui?.pause -> ${s.hitstopFinds}`);

  // The behavioural half: the object found there really drives the clock.
  await clean();
  const r = await run([
    ['measure', 'free', 26],
    ['claim', 'probe', 0], ['frames', 2],
    ['measure', 'claimed', 26],
    ['release', 'probe'], ['frames', 2],
    ['measure', 'released', 26],
  ]);
  rec(A, 'CONTROL — the world runs at full speed with nothing claiming',
    r.free.rate > 0.85, at(r.free));
  rec(A, 'a claim on that object stops the world dead', r.claimed.d === 0, at(r.claimed));
  rec(A, 'releasing it hands the clock back at full speed',
    r.released.rate > 0.85, at(r.released));
}

/* ======================================================================== */
/* 1 — hitstop, through the arbiter, on its own                             */
/* ======================================================================== */

async function caseHitstopAlone() {
  const A = '1 — hitstop alone';
  await clean();
  const r = await run([
    ['measureHitstop', 'stall', 30],
    ['raw', 0.4],
    ['measure', 'after', 26],
  ]);
  // The band is wide on purpose: the point is to tell "stalled" apart from
  // "stopped" and "full speed", not to re-assert the 0.12 the code holds.
  rec(A, 'a live impact stall slows the world without stopping it',
    r.stall.rate > 0.02 && r.stall.rate < 0.45, at(r.stall));
  rec(A, 'the stall hands the clock back at full speed when it expires',
    r.after.rate > 0.85, at(r.after));
}

/* ======================================================================== */
/* 2 — THE RACE: a modal opened one frame into a live impact stall          */
/* ======================================================================== */

async function caseHitstopUnderModal() {
  const A = '2 — modal opened inside a live stall';
  await clean();
  const r = await run([
    ['hitstop', 0.15], ['frames', 1],
    ['menu', true], ['frames', 2],
    ['measure', 'paused', 26],
    ['raw', 0.4],
    ['measure', 'stillPaused', 20],
    ['menu', false], ['frames', 2],
    ['measure', 'resumed', 30],
  ]);
  rec(A, 'the modal stops the world outright, stall or no stall',
    r.paused.d === 0, at(r.paused));
  rec(A, 'the world stays stopped after the stall would have expired',
    r.stillPaused.d === 0, at(r.stillPaused));
  // THE DEFECT. Before the fix the arbiter banked 0.12 as free play here and
  // handed 0.12 back; measured 0.12 simulated seconds per real second, for ever.
  rec(A, 'closing the modal returns FULL speed, not the stall speed',
    r.resumed.rate > 0.85, at(r.resumed));

  // The other order, which must be indistinguishable at the clock.
  await clean();
  const r2 = await run([
    ['menu', true], ['frames', 2],
    ['hitstop', 0.15], ['frames', 2],
    ['measure', 'paused', 26],
    ['menu', false], ['raw', 0.4],
    ['measure', 'resumed', 30],
  ]);
  rec(A, 'a stall requested from behind the modal cannot restart the world',
    r2.paused.d === 0, at(r2.paused));
  rec(A, 'and the world is at full speed once the modal comes down',
    r2.resumed.rate > 0.85, at(r2.resumed));
}

/* ======================================================================== */
/* 3 — the arbiter's own immunity, with no help from hitstop                */
/* ======================================================================== */

async function caseStalledBase() {
  const A = '3 — a foreign stall must not be banked as free play';
  await clean();
  // A DIRECT writer that is not the arbiter and not hitstop, so nothing in the
  // build knows how to heal it. This is the case `hitstop._heal` cannot cover
  // and the reason the fix had to move into the arbiter.
  const r = await run([
    ['scale', 0.12], ['frames', 1],
    ['menu', true], ['frames', 2],
    ['measure', 'paused', 20],
    ['menu', false], ['frames', 3],
    ['measure', 'resumed', 30],
  ]);
  rec(A, 'the modal stops the world over a foreign stall', r.paused.d === 0, at(r.paused));
  rec(A, 'a foreign stall is not handed back as free play',
    r.resumed.rate > 0.85, at(r.resumed));

  /**
   * THE PAIRED POSITIVE. Without this, "always restore 1" would score full
   * marks above — and that would be a different bug, not a fix: the demo driver
   * runs free play at 0.28 and `tools/capture.mjs` parks it, so an arbiter that
   * insists on 1 fights them both. A scale that has STOOD for longer than any
   * legal stall IS free play and must come back.
   */
  await clean();
  const r2 = await run([
    ['scale', 0.37], ['raw', 0.8],
    ['menu', true], ['frames', 2],
    ['measure', 'paused', 20],
    ['menu', false], ['frames', 3],
    ['measure', 'resumed', 30],
  ]);
  rec(A, 'CONTROL — the modal still stops a slowed world', r2.paused.d === 0, at(r2.paused));
  rec(A, 'CONTROL — a settled free-play scale IS handed back',
    r2.resumed.rate > 0.25 && r2.resumed.rate < 0.5,
    `${at(r2.resumed)} (free play was set to 37%)`);
  await clean();
}

/* ======================================================================== */
/* 4 — order independence: a 0 can never be out-voted                       */
/* ======================================================================== */

async function caseOrders() {
  const A = '4 — claim / release order';
  await clean();
  const r = await run([
    ['claim', 'probe', 0.5], ['frames', 2],
    ['measure', 'slow', 26],
    ['menu', true], ['frames', 2],
    ['measure', 'slowThenModal', 26],
    ['release', 'probe'], ['frames', 2],
    ['measure', 'modalOnly', 26],
    ['menu', false], ['frames', 3],
    ['measure', 'free', 26],
  ]);
  rec(A, 'an external claim of 0.5 halves the world', r.slow.rate > 0.3 && r.slow.rate < 0.7,
    at(r.slow));
  rec(A, 'a modal opened over it stops the world outright',
    r.slowThenModal.d === 0, at(r.slowThenModal));
  rec(A, 'dropping the 0.5 from behind the modal does not restart the world',
    r.modalOnly.d === 0, at(r.modalOnly));
  rec(A, 'the world is at full speed when the last claim goes',
    r.free.rate > 0.85, at(r.free));

  await clean();
  const r2 = await run([
    ['menu', true], ['frames', 2],
    ['claim', 'probe', 0.5], ['frames', 2],
    ['measure', 'modalThenSlow', 26],
    ['menu', false], ['frames', 3],
    ['measure', 'claimSurvives', 26],
    ['release', 'probe'], ['frames', 3],
    ['measure', 'free', 26],
  ]);
  rec(A, 'a 0.5 arriving UNDER a modal cannot out-vote its 0',
    r2.modalThenSlow.d === 0, at(r2.modalThenSlow));
  rec(A, 'the modal closing leaves the external claim standing',
    r2.claimSurvives.rate > 0.3 && r2.claimSurvives.rate < 0.7, at(r2.claimSurvives));
  rec(A, 'and releasing it hands the clock back at full speed',
    r2.free.rate > 0.85, at(r2.free));

  // Two external claims at once, dropped in the wrong order.
  await clean();
  const r3 = await run([
    ['claim', 'probe', 0], ['claim', 'probeB', 0.5], ['frames', 2],
    ['measure', 'both', 26],
    ['release', 'probe'], ['frames', 2],
    ['measure', 'onlySlow', 26],
    ['release', 'probeB'], ['frames', 3],
    ['measure', 'free', 26],
  ]);
  rec(A, 'a 0 and a 0.5 together stop the world', r3.both.d === 0, at(r3.both));
  rec(A, 'dropping the 0 leaves the 0.5 running the clock',
    r3.onlySlow.rate > 0.3 && r3.onlySlow.rate < 0.7, at(r3.onlySlow));
  rec(A, 'dropping the last one restores full speed', r3.free.rate > 0.85, at(r3.free));

  // The no-argument form is teardown — `ui.dispose()`'s only exit.
  await clean();
  const r4 = await run([
    ['claim', 'probe', 0], ['claim', 'probeB', 0], ['frames', 2],
    ['measure', 'held', 20],
    ['release'], ['frames', 3],
    ['measure', 'tornDown', 26],
  ]);
  rec(A, 'CONTROL — two claims hold the world still', r4.held.d === 0, at(r4.held));
  rec(A, 'release() with no argument tears every external claim down',
    r4.tornDown.rate > 0.85, at(r4.tornDown));
}

/* ======================================================================== */
/* 5 — the cutscene is a claim, not a second writer                         */
/* ======================================================================== */

async function caseCutscene() {
  const A = '5 — a live cutscene';
  await clean();
  const r = await run([
    ['cut', true], ['frames', 3],
    ['measure', 'cut', 26],
    /**
     * THE ONE-FRAME LEAK. A claim raised and dropped BETWEEN frames while the
     * cut is up. If the cut is not in the arbiter's own table, the arbiter
     * resolves this claim's 1 as the winner, writes it, and the engine steps
     * once at full speed before the cutscene's `update()` can re-assert its
     * zero — one frame of a world the player was told was stopped.
     */
    ['claim', 'probe', 1], ['frames', 2],
    ['measure', 'claimUp', 20],
    ['release', 'probe'], ['frames', 2],
    ['measure', 'claimGone', 20],
    ['cut', false], ['frames', 3],
    ['measure', 'after', 26],
  ]);
  rec(A, 'a cutscene stops the world', r.cut.d === 0, at(r.cut));
  rec(A, 'an external claim of full speed cannot restart it',
    r.claimUp.d === 0, at(r.claimUp));
  rec(A, 'and dropping that claim leaks not one frame of simulation',
    r.claimGone.d === 0, at(r.claimGone));
  rec(A, 'the world runs at full speed when the scene ends',
    r.after.rate > 0.85, at(r.after));

  // A modal over a cut, and the cut ending underneath it.
  await clean();
  const r2 = await run([
    ['cut', true], ['frames', 3],
    ['menu', true], ['frames', 2],
    ['measure', 'both', 20],
    ['cut', false], ['frames', 2],
    ['measure', 'modalOnly', 20],
    ['menu', false], ['frames', 3],
    ['measure', 'free', 26],
  ]);
  rec(A, 'a modal over a cutscene keeps the world stopped', r2.both.d === 0, at(r2.both));
  rec(A, 'the cut ending under the modal does not restart the world',
    r2.modalOnly.d === 0, at(r2.modalOnly));
  rec(A, 'closing the modal afterwards returns full speed',
    r2.free.rate > 0.85, at(r2.free));
  await clean();
}

/* ======================================================================== */

try {
  const errs = await boot();
  await caseOneName();
  await caseHitstopAlone();
  await caseHitstopUnderModal();
  await caseStalledBase();
  await caseOrders();
  await caseCutscene();

  const final = await run([['measure', 'end', 30]]);
  rec('invariant', 'the world is at full speed at the end of the whole run',
    final.end.rate > 0.85, at(final.end));
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
  console.log(`\n${pass}/${results.length} clock-owner behaviours working`);
  if (pass !== results.length) process.exitCode = 1;
} catch (e) {
  console.error('clockownerprobe failed:', e.message);
  process.exitCode = 1;
} finally {
  await page?.close().catch(() => {});
  await b.close();
  server?.kill();
}
