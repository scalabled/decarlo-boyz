#!/usr/bin/env node
/**
 * BOOT AUDIO GATE — does a MOUSE-ONLY boot leave the city audible?
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE BUG THIS EXISTS TO CATCH
 * ───────────────────────────────────────────────────────────────────────────
 * Web Audio is illegal until a user gesture. `AudioSystem.init` arms a handler
 * on `pointerdown / mousedown / keydown / touchstart / wheel` and the first one
 * to land builds the graph — but the boot overlay (`.ow-boot`, position:fixed
 * inset:0, covering the whole viewport for the entire boot flow) installs
 * `stopPropagation` handlers for mousedown/mouseup/pointerdown/pointerup, and
 * the audio unlock listened in the BUBBLE phase. So on a mouse-only desktop the
 * player picked a brother, pressed START, and every pointer event died in the
 * overlay before it reached window.
 *
 * `audio.running` stayed false, every voice was dropped at the top of
 * `_playAt` / `_playDry`, and the city came up in TOTAL SILENCE — no ambience,
 * no traffic, no wind, no radio, no footsteps — until the player happened to
 * press a key or scroll. keydown and touchstart were unaffected (boot does not
 * stopPropagation those), which is why nobody noticed: every probe in the repo
 * drives the page with the keyboard.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY IT IS MEASURED THIS WAY (ARCHITECTURE.md rule 12)
 * ───────────────────────────────────────────────────────────────────────────
 * It would be worthless to assert that boot.js "called resume()". That asserts
 * the code's own input. This asserts the EMITTED RESULT, twice over:
 *
 *   1. the real AudioContext reports state === 'running' and its currentTime
 *      actually advances (a suspended context's clock is frozen);
 *   2. an AnalyserNode tapped onto `mixer.masterGain` — the last node before
 *      `actx.destination`, i.e. literally the samples the speakers get — sees
 *      a non-silent signal for a second and a half. Nothing in this file plays
 *      that sound: it is the city ambience bed the game brings up on its own.
 *
 * And the gesture is proved to be mouse-only: a capture-phase witness installed
 * before any page script counts every keydown / touchstart / wheel, and the run
 * fails if any of them fired. The probe never touches page.keyboard.
 *
 * A pre-click assertion that `audio.running === false` keeps the run honest —
 * if the graph were already up before the mouse touched anything, the click
 * would not be what proved anything, and the gate reports INCONCLUSIVE.
 *
 *   node src/audio/bootaudioprobe.mjs
 *   node src/audio/bootaudioprobe.mjs --headed --verbose
 */
import { chromium } from 'playwright';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const VERBOSE = !!args.verbose;

/**
 * RATCHET (ARCHITECTURE.md rule 13). Measured on the fixed build: the city bed
 * alone, with nothing else happening, sits at peak ~0.09 / rms ~0.017 at the
 * master tap. These floors are an order of magnitude under that, so they mean
 * "not silence" and nothing more — a quieter mix must not trip them, and they
 * come DOWN when the measurement improves, never up.
 */
const MIN_PEAK = 0.004;
const MIN_RMS = 0.0008;
/** The context clock must move; a suspended context's currentTime is frozen. */
const MIN_CLOCK_ADVANCE = 0.4;

const SAMPLE_MS = 1500;

let exitCode = 0;
const fail = (msg) => { console.log(`  !! ${msg}`); exitCode = 1; };
const ok = (msg) => console.log(`  ok ${msg}`);

const { port, server } = await startServer({ explicitPort: args.port });

const browser = await chromium.launch({
  headless: !args.headed,
  args: [
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--mute-audio',
    '--hide-scrollbars',
    // NOTE: --autoplay-policy is deliberately NOT overridden. The whole point
    // is that the graph must be unlocked by a real gesture; handing the page a
    // free pass would make this gate measure nothing.
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

/**
 * Gesture witness. Installed before a single page script runs, in the CAPTURE
 * phase on window, so nothing downstream can hide an event from it.
 */
await page.addInitScript(() => {
  const w = { keydown: 0, touchstart: 0, wheel: 0, pointerdown: 0, mousedown: 0 };
  window.__GESTURE_WITNESS__ = w;
  for (const ev of Object.keys(w)) {
    addEventListener(ev, () => { w[ev]++; }, { capture: true, passive: true });
  }
});

try {
  // ?boot=1 forces the boot flow on under automation — `bootEnabled()` turns it
  // off for navigator.webdriver so the other probes keep booting straight into
  // the world. This is the ONLY probe that wants the real player's path.
  await page.goto(`http://127.0.0.1:${port}/?boot=1`, { waitUntil: 'domcontentloaded' });

  console.log('=== BOOT: waiting for the brother-select screen ===');
  await page.waitForFunction(() => window.__BOOT__?.phase === 'select', null, { timeout: 180000 });

  /* --- 1. nothing has gestured yet, so the graph must NOT be up --------- */
  const before = await page.evaluate(() => {
    const a = window.__AUDIO__;
    return {
      present: !!a,
      running: !!a?.running,
      state: a?.actx?.state ?? 'none',
      witness: { ...window.__GESTURE_WITNESS__ },
    };
  });
  console.log('before any click:', JSON.stringify(before));
  if (!before.present) {
    fail('no window.__AUDIO__ — the audio subsystem never initialised');
    throw new Error('audio subsystem missing');
  }
  if (before.running) {
    fail('audio was ALREADY running before the mouse touched anything — '
      + 'this run proves nothing about the boot gesture (INCONCLUSIVE)');
  } else {
    ok('graph is locked before the first gesture, as the autoplay policy demands');
  }

  /* --- 2. MOUSE ONLY: pick a brother ----------------------------------- */
  console.log('\n=== MOUSE-ONLY BOOT ===');
  const card = page.locator('.ow-boot-card').first();
  await card.waitFor({ state: 'visible', timeout: 20000 });
  await card.click();

  // The card click is the gesture the audio graph resumes on. It must come
  // up from THAT — no keypress, no scroll, no touch anywhere in this file.
  const wokeOnCard = await page
    .waitForFunction(() => window.__AUDIO__?.running === true, null, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  console.log('audio.running after the card click:', wokeOnCard);
  if (!wokeOnCard) fail('the brother-card click did not wake the audio graph');

  /* --- 3. tap the master output ---------------------------------------- */
  // AnalyserNode on mixer.masterGain: the last node before actx.destination.
  // This is the signal the speakers receive, not any value the mix computed.
  const tapped = await page.evaluate(() => {
    const a = window.App?.audio ?? window.__AUDIO__;
    if (!a?.actx || !a.mixer?.masterGain) return false;
    const an = a.actx.createAnalyser();
    an.fftSize = 2048;
    a.mixer.masterGain.connect(an);
    window.__MASTER_TAP__ = {
      an, buf: new Float32Array(an.fftSize), peak: 0, sumSq: 0, n: 0,
      t0: a.actx.currentTime,
    };
    return true;
  });
  if (!tapped) fail('could not tap mixer.masterGain — there is no live graph to listen to');

  /* --- 4. MOUSE ONLY: START -------------------------------------------- */
  const start = page.locator('.ow-boot-intro .ow-btn.primary');
  await start.waitFor({ state: 'visible', timeout: 20000 });
  await start.click();

  /* --- 5. listen ------------------------------------------------------- */
  console.log(`\n=== LISTENING FOR ${SAMPLE_MS} ms AT THE MASTER OUTPUT ===`);
  const heard = await page.evaluate((ms) => new Promise((done) => {
    const t = window.__MASTER_TAP__;
    if (!t) return done(null);
    const wall = performance.now();
    const step = () => {
      t.an.getFloatTimeDomainData(t.buf);
      for (let i = 0; i < t.buf.length; i++) {
        const v = t.buf[i];
        const av = v < 0 ? -v : v;
        if (av > t.peak) t.peak = av;
        t.sumSq += v * v;
        t.n++;
      }
      if (performance.now() - wall < ms) requestAnimationFrame(step);
      else {
        const a = window.__AUDIO__;
        done({
          peak: t.peak,
          rms: Math.sqrt(t.sumSq / Math.max(1, t.n)),
          frames: t.n,
          clock: a.actx.currentTime - t.t0,
          state: a.actx.state,
          running: a.running,
          sampleRate: a.actx.sampleRate,
        });
      }
    };
    requestAnimationFrame(step);
  }), SAMPLE_MS);

  const witness = await page.evaluate(() => ({ ...window.__GESTURE_WITNESS__ }));
  console.log('gesture witness:', JSON.stringify(witness));
  if (witness.keydown || witness.touchstart || witness.wheel) {
    fail(`a non-mouse gesture fired (keydown ${witness.keydown}, touchstart `
      + `${witness.touchstart}, wheel ${witness.wheel}) — this run did not test `
      + 'the mouse-only path');
  } else if (witness.pointerdown || witness.mousedown) {
    ok('mouse only: no keydown, no touchstart, no wheel');
  }

  if (!heard) {
    fail('no master tap — nothing was measured');
  } else {
    console.log('master tap:', JSON.stringify({
      peak: +heard.peak.toFixed(5), rms: +heard.rms.toFixed(6),
      clock: +heard.clock.toFixed(3), state: heard.state,
      samples: heard.frames, sampleRate: heard.sampleRate,
    }));

    if (heard.state !== 'running') fail(`AudioContext.state is '${heard.state}', not 'running'`);
    else ok("AudioContext.state === 'running'");

    if (!(heard.clock >= MIN_CLOCK_ADVANCE)) {
      fail(`the context clock advanced only ${heard.clock.toFixed(3)} s in `
        + `${SAMPLE_MS} ms — a suspended graph renders nothing `
        + `(need >= ${MIN_CLOCK_ADVANCE})`);
    } else ok(`context clock advanced ${heard.clock.toFixed(2)} s`);

    if (!(heard.peak >= MIN_PEAK) || !(heard.rms >= MIN_RMS)) {
      fail(`THE CITY IS SILENT: peak ${heard.peak.toFixed(6)} (need >= ${MIN_PEAK}), `
        + `rms ${heard.rms.toFixed(7)} (need >= ${MIN_RMS}) at the master output`);
    } else {
      ok(`the city is audible: peak ${heard.peak.toFixed(4)}, rms ${heard.rms.toFixed(5)}`);
    }
  }

  const report = await page.evaluate(() => window.__AUDIO__?.report?.() ?? null);
  if (VERBOSE) console.log('\nreport:', JSON.stringify(report, null, 1));
  else if (report) {
    console.log('report:', JSON.stringify({
      running: report.running, state: report.state, voices: report.voices,
      errors: report.errors, city: report.city,
    }));
  }
} catch (err) {
  console.log(`\n!! probe threw: ${err?.message ?? err}`);
  exitCode = 1;
} finally {
  if (VERBOSE && logs.length) console.log('\n--- page log ---\n' + logs.join('\n'));
  else {
    const bad = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
    if (bad.length) console.log('\npage errors:\n' + bad.slice(0, 12).join('\n'));
  }
  await browser.close().catch(() => {});
  stopServer(server);
}

console.log(exitCode === 0
  ? '\nBOOT AUDIO GATE: PASS — a mouse-only boot comes up with the city audible'
  : '\nBOOT AUDIO GATE: FAIL');
process.exit(exitCode);
