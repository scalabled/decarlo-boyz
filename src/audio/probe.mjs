#!/usr/bin/env node
/**
 * AUDIO PROBE — headless verification for the audio subsystem.
 *
 * Screenshots say nothing about sound, so this is the audio equivalent of the
 * capture harness. It does two independent things:
 *
 *  1. OFFLINE RENDER — imports src/audio/selftest.js in the page and renders
 *     every voice through the real mixer in an OfflineAudioContext, then checks
 *     each one for silence, NaNs, DC offset and clipping. No gesture needed.
 *
 *  2. LIVE GRAPH — clicks the canvas to satisfy the autoplay policy, waits for
 *     the AudioContext to be running, fires `debugStorm()` (one of every event
 *     through the real event bus), pumps frames, and asserts that nothing threw
 *     and no console error appeared.
 *
 * Usage:
 *   node src/audio/probe.mjs --port=5213            # both checks
 *   node src/audio/probe.mjs --port=5213 --verbose  # per-case table
 *   node src/audio/probe.mjs --port=5213 --live=0   # offline only
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, join, normalize } from 'node:path';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const PORT = Number(args.port ?? 5213);
const TIMEOUT = Number(args.timeout ?? 120000);
const VERBOSE = !!args.verbose;
const DO_LIVE = args.live !== '0';

const ROOT = resolve(import.meta.dirname, '../..');
const DIST = join(ROOT, 'dist');

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

/**
 * Serve the PRODUCTION BUILD, not the dev server.
 *
 * Ten agents edit this repository at the same time, and every one of their
 * saves makes vite full-reload the page. A reload in the middle of a probe run
 * destroys the execution context and the run fails for a reason that has
 * nothing to do with audio — which happened on every attempt before this
 * change. A plain static server over `dist/` has no HMR and no dependency
 * optimizer, so a probe run is reproducible no matter who else is typing.
 *
 * `/src/...` is additionally mapped straight at the source tree so the offline
 * self-test can still be imported: everything under src/audio is dependency
 * free ESM that a browser loads directly, no bundler involved.
 */
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html',
  '.json': 'application/json', '.map': 'application/json', '.css': 'text/css',
};

async function ensureServer() {
  if (await portOpen(PORT)) return null;
  if (!existsSync(join(DIST, 'index.html'))) {
    console.log('[probe] no dist/ — running vite build');
    await new Promise((done, fail) => {
      const b = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['build'], { cwd: ROOT, stdio: 'inherit' });
      b.on('exit', (c) => (c === 0 ? done() : fail(new Error(`vite build exited ${c}`))));
    });
  }
  const srv = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const rel = normalize(url).replace(/^(\.\.[/\\])+/, '');
    const path = url === '/' ? join(DIST, 'index.html')
      : rel.startsWith('/src/') || rel.startsWith('/node_modules/') ? join(ROOT, rel)
        : join(DIST, rel);
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((done) => srv.listen(PORT, '127.0.0.1', done));
  return { kill: () => srv.close() };
}

const server = await ensureServer();

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

/** The live game graph: real events, real frames, nothing may throw. */
async function liveGraph() {
    // --- ui:station BEFORE the first gesture -------------------------------
    // The save system re-emits the stored station on load, which lands before
    // any user gesture exists to build the AudioContext. The listener must
    // queue it, not drop it: emit through the real event bus while the graph
    // provably does not exist, and check the request was recorded.
    const early = await page.evaluate(() => {
      const a = window.__AUDIO__;
      if (!a) return { err: 'no __AUDIO__' };
      const wasRunning = a.running;
      a.ctx.events.emit('ui:station', { id: 'furnace' });
      return { wasRunning, pending: a._pendingStation ?? null };
    });
    console.log('pre-gesture ui:station:', JSON.stringify(early));
    if (early.err || early.pending !== 'furnace') {
      console.log('  !! ui:station before audio start was dropped, not queued');
      exitCode = 1;
    }
    if (early.wasRunning) {
      console.log('  (audio was already running — queue path not exercised)');
    }

    // A keypress satisfies the autoplay gesture without triggering the game's
    // pointer-lock request (which headless Chromium refuses, noisily).
    await page.keyboard.press('KeyP');
    await page.evaluate(() => window.__AUDIO__?.start?.());
    const live = await page.waitForFunction(
      () => (window.__AUDIO__?.running ? window.__AUDIO__.report() : false),
      null, { timeout: 20000 }
    ).then((h) => h.jsonValue()).catch(() => null);

    if (!live) {
      console.log('\n=== LIVE GRAPH — could not start (autoplay blocked?) ===');
      exitCode = 1;
    } else {
      console.log(`\n=== LIVE GRAPH — ${live.state} @ ${live.sampleRate} Hz ===`);
      // Pump a second of frames so beds/probes run, then storm the event bus.
      const pump = (n) => page.evaluate(
        (k) => new Promise((done) => {
          let i = 0;
          const tick = () => (++i >= k ? done() : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }), n);
      await pump(60);

      // The station queued before the gesture must now be AUDIBLY tuned:
      // read the radio's own current station, not the queue we wrote.
      const tuned = await page.evaluate(() => ({
        current: window.__AUDIO__.radio?.current ?? null,
        stats: window.__AUDIO__.radio?.stats.station,
      }));
      console.log('queued station after start:', JSON.stringify(tuned));
      if (tuned.current !== 'furnace') {
        console.log('  !! the pre-gesture ui:station was not applied when the graph came up');
        exitCode = 1;
      }

      const storm = await page.evaluate(() => window.__AUDIO__.debugStorm());
      await pump(120);
      const storm2 = await page.evaluate(() => window.__AUDIO__.debugStorm());
      await pump(180);
      const after = await page.evaluate(() => window.__AUDIO__.report());
      console.log('storm 1:', JSON.stringify(storm));
      console.log('storm 2:', JSON.stringify(storm2));
      console.log('report :', JSON.stringify(after, null, 1));
      if (after.errors > 0) exitCode = 1;

      /* --- the open world: engines, radio, wanted --------------------- */
      console.log('\n=== OPEN WORLD ===');
      await page.evaluate(() => window.__AUDIO__.debugDrive('muscle', 4));
      await pump(150);
      const driving = await page.evaluate(() => window.__AUDIO__.report());
      console.log('driving:', JSON.stringify({
        vehicles: driving.vehicles, tracked: driving.tracked, voices: driving.voices,
        cabin: driving.cabin, inVehicle: driving.inVehicle, errors: driving.errors,
      }));
      for (const id of ['grease', 'gold', 'redline', 'slack', 'furnace', 'incline', null]) {
        await page.evaluate((s) => window.__AUDIO__.setRadioStation(s), id);
        await pump(30);
      }
      await page.evaluate(() => window.__AUDIO__.setRadioStation('redline'));
      await pump(90);
      const radio = await page.evaluate(() => ({
        station: window.__AUDIO__.radioStation, report: window.__AUDIO__.report(),
      }));
      console.log('radio  :', JSON.stringify(radio.station), '| bar', radio.report.radio?.bar);
      console.log('city   :', JSON.stringify(radio.report.city));
      console.log('police :', JSON.stringify(radio.report.police));
      if (radio.report.errors > after.errors) {
        console.log('  !! errors appeared while driving/tuning');
        exitCode = 1;
      }
      if (!radio.report.radio || radio.report.radio.bar < 1) {
        console.log('  !! the radio never advanced a bar — the scheduler is not running');
        exitCode = 1;
      }

      // The HUD's cycle path: ui:station retunes the audible station, and OFF
      // (published as id -1) is a real stop on the dial. Read Radio.current —
      // the tuner's own state — after each emit.
      const cycle = await page.evaluate(() => {
        const a = window.__AUDIO__;
        const ev = a.ctx.events;
        const out = [];
        ev.emit('ui:station', { id: 'gold' });
        out.push(a.radio.current);
        ev.emit('ui:station', { id: -1 });
        out.push(a.radio.current);
        ev.emit('ui:station', { id: 'redline' });
        out.push(a.radio.current);
        return out;
      });
      console.log('ui:station cycle gold / -1 / redline ->', JSON.stringify(cycle));
      if (cycle[0] !== 'gold' || cycle[1] !== null || cycle[2] !== 'redline') {
        console.log('  !! ui:station did not retune the audible radio (incl. OFF)');
        exitCode = 1;
      }

      /* --- 3. does the space probe actually read the level? --------- */
      // The gunshot tail is only environmental if this classification tracks
      // the geometry, so walk the camera through the named shots and print it.
      console.log('\n=== SPACE PROBE PER SHOT ===');
      for (const shot of ['hero', 'interior', 'detail', 'sunset']) {
        await page.evaluate((s) => window.__APPLY_SHOT__(s), shot);
        await pump(45);
        const r = await page.evaluate(() => window.__AUDIO__.report());
        const w = r.spaceWeights ?? {};
        const fmt = (v) => (v ?? 0).toFixed(2);
        console.log(
          `${shot.padEnd(10)} -> ${r.space.padEnd(7)}` +
          ` tight ${fmt(w.tight)} room ${fmt(w.room)} street ${fmt(w.street)}` +
          ` tunnel ${fmt(w.tunnel)} open ${fmt(w.open)}` +
          ` | enclosure ${r.enclosure.toFixed(2)} meanFree ${r.meanFree.toFixed(1)}m`
        );
      }

      await jingleDistinctness(pump);
    }

}

/**
 * GAMEPLAY JINGLES — every id must fire a DISTINCT voice, not the generic
 * 1200 Hz blip everything used to collapse onto.
 *
 * The assertion is on the EMITTED ARTEFACT, per ARCHITECTURE.md rule 12: the
 * probe wraps createOscillator on the live AudioContext (instrumentation lives
 * here, not in src/, so the production code cannot answer its own question)
 * and fingerprints every oscillator actually SCHEDULED — waveform @ creation
 * pitch — for each stimulus. Event emission is synchronous end-to-end, so one
 * evaluate() captures exactly the nodes that stimulus scheduled: nothing async
 * (radio bars, ambience one-shots on rAF) can leak into the window.
 *
 * What would make this fail: a missing listener (empty fingerprint — the
 * original radio bug's shape), an id falling through to the default case
 * (fingerprint === blip), two ids sharing one voice (duplicate fingerprint),
 * or the default case being removed (negative control stops matching).
 */
async function jingleDistinctness(pump) {
  console.log('\n=== GAMEPLAY JINGLES ===');
  const before = await page.evaluate(() => window.__AUDIO__.report().errors);

  await page.evaluate(() => {
    const actx = window.__AUDIO__.actx;
    const log = [];
    const orig = actx.createOscillator.bind(actx);
    actx.createOscillator = () => {
      const node = orig();
      const start = node.start.bind(node);
      node.start = (...s) => {
        log.push(node.type + '@' + Math.round(node.frequency.value));
        return start(...s);
      };
      return node;
    };
    window.__VOICELOG__ = log;
  });

  const fingerprint = (stim) => page.evaluate((s) => {
    const a = window.__AUDIO__;
    window.__VOICELOG__.length = 0;
    if (s.emit) a.ctx.events.emit(s.emit, s.payload ?? {});
    else a.playUi(s.ui, 1);
    return window.__VOICELOG__.slice().sort().join('|');
  }, stim);

  // Negative control FIRST: an unknown id must still get the generic blip —
  // one sine at 1200 Hz — so a brand-new caller is audible before it is styled.
  const BLIP = await fingerprint({ ui: '__no_such_jingle__' });
  console.log(`  ${'negative control (unknown id)'.padEnd(30)} -> ${BLIP}`);
  if (BLIP !== 'sine@1200') {
    console.log('  !! unknown ids no longer reach the generic blip');
    exitCode = 1;
  }

  const CASES = [
    // Through the EVENT BUS: proves the listener exists and reaches a voice.
    { name: 'economy:cash', emit: 'economy:cash', payload: { amount: 250, total: 1200, reason: 'probe' } },
    { name: 'pickup:collect cash', emit: 'pickup:collect', payload: { kind: 'cash' } },
    { name: 'pickup:collect health', emit: 'pickup:collect', payload: { kind: 'health' } },
    { name: 'pickup:collect armor', emit: 'pickup:collect', payload: { kind: 'armor' } },
    { name: 'pickup:collect ammo', emit: 'pickup:collect', payload: { kind: 'ammo' } },
    { name: 'pickup:collect nitro', emit: 'pickup:collect', payload: { kind: 'nitro' } },
    { name: 'game:service start', emit: 'game:service', payload: { kind: 'repair', phase: 'start', progress: 0 } },
    { name: 'game:service done', emit: 'game:service', payload: { kind: 'repair', phase: 'done', progress: 1 } },
    { name: 'mission:start', emit: 'mission:start', payload: { id: 'probe', name: 'PROBE' } },
    { name: 'nitro engage', emit: 'player:state', payload: { nitroOn: true } },
    // The ids the HUD plays through playUi — its exact call-site contract.
    { name: 'ui mission_pass', ui: 'mission_pass' },
    { name: 'ui mission_fail', ui: 'mission_fail' },
    { name: 'ui title_card', ui: 'title_card' },
    { name: 'ui wanted_up', ui: 'wanted_up' },
    { name: 'ui wanted_clear', ui: 'wanted_clear' },
    { name: 'ui ui_confirm', ui: 'ui_confirm' },
    { name: 'ui ui_deny', ui: 'ui_deny' },
    { name: 'ui wheel_open', ui: 'wheel_open' },
    { name: 'ui ui_alert', ui: 'ui_alert' },
    // These two mutate game state (bail, respawn), so they go last.
    { name: 'police:busted', emit: 'police:busted', payload: {} },
    { name: 'player:wasted', emit: 'player:wasted', payload: { cause: 'probe' } },
  ];

  const seen = new Map([[BLIP, 'generic blip']]);
  for (const c of CASES) {
    const fp = await fingerprint(c);
    console.log(`  ${c.name.padEnd(30)} -> ${fp || '(silence)'}`);
    if (!fp) {
      console.log(`  !! ${c.name}: no voice fired — the listener is missing`);
      exitCode = 1;
      continue;
    }
    if (fp === BLIP) {
      console.log(`  !! ${c.name}: fired the generic blip, not its own voice`);
      exitCode = 1;
      continue;
    }
    if (seen.has(fp)) {
      console.log(`  !! ${c.name}: identical voice to '${seen.get(fp)}' — not distinct`);
      exitCode = 1;
    }
    seen.set(fp, c.name);
  }

  // Release the nitro edge so the sustain layer does not run forever.
  await page.evaluate(() => window.__AUDIO__.ctx.events.emit('player:state', { nitroOn: false }));
  await pump(30);

  const after = await page.evaluate(() => window.__AUDIO__.report().errors);
  if (after > before) {
    console.log(`  !! ${after - before} audio error(s) appeared during the jingle sweep`);
    exitCode = 1;
  }
}

let exitCode = 0;
try {
  await page.goto(`http://127.0.0.1:${PORT}/?capture=1&shot=hero`, {
    waitUntil: 'domcontentloaded', timeout: TIMEOUT,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: TIMEOUT });

  // The live section runs FIRST and the offline self-test second, deliberately.
  // Importing selftest.js dynamically makes vite re-run its dependency
  // optimizer, and the full page reload that follows lands asynchronously —
  // typically a couple of seconds later, i.e. in the middle of whatever comes
  // next. Doing the long-running live test before that import means the reload
  // can only ever interrupt the very last thing this script does.
  if (DO_LIVE) await liveGraph();

  /* ---------------- 2. offline synthesis self-test ---------------- */
  // The first dynamic import of selftest.js can make vite's dep optimizer
  // full-reload the page, which kills the execution context mid-evaluate.
  // Retry: the reload is a one-off, and it is not a failure of the audio.
  //
  // For the heavyweight measurements (engine order combs, doppler, spectral
  // centroid over a load sweep, per-scene WAVs) use src/audio/mixdown.mjs
  // instead — it serves the tree as plain files and never involves vite.
  const runOffline = () => page.evaluate(async () => {
    const mod = await import('/src/audio/selftest.js');
    return mod.runAudioSelfTest();
  });
  let offline = null, lastErr = null;
  for (let attempt = 0; attempt < 4 && !offline; attempt++) {
    try {
      offline = await runOffline();
    } catch (err) {
      lastErr = err;
      if (!/Execution context was destroyed|__READY__|Target closed/.test(String(err?.message))) throw err;
      logs.push(`[probe] page reloaded during import (attempt ${attempt + 1}) — retrying`);
      await page.waitForFunction('window.__READY__ === true', null, { timeout: TIMEOUT }).catch(() => {});
      await page.waitForTimeout(1200);
    }
  }
  if (!offline) throw lastErr ?? new Error('offline self-test never ran');

  console.log(`\n=== OFFLINE SELF TEST — ${offline.cases} cases, ${offline.ok ? 'PASS' : 'FAIL'} ===`);
  if (VERBOSE) {
    const rows = offline.results ?? [];
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`${pad('case', 26)}${pad('peak', 9)}${pad('rms', 10)}${pad('dc', 10)}${pad('centroidHz', 12)}ms`);
    for (const r of rows) {
      if (r.error) { console.log(`${pad(r.name, 26)}ERROR ${r.error}`); continue; }
      console.log(`${pad(r.name, 26)}${pad(r.peak, 9)}${pad(r.rms, 10)}${pad(r.dc, 10)}${pad(r.centroid, 12)}${r.ms}`);
    }
    console.log('\nspace classifier:', JSON.stringify(offline.spaces, null, 1));
  }
  if (offline.failures.length) {
    exitCode = 1;
    console.log('\nFAILURES:');
    for (const f of offline.failures) console.log(' ', JSON.stringify(f));
  }

  const IGNORE = /not valid for pointer lock/;
  const bad = logs.filter((l) => /\[error\]|\[pageerror\]|\[audio\]/.test(l) && !IGNORE.test(l));
  console.log(`\n=== CONSOLE (${logs.length} lines, ${bad.length} of interest) ===`);
  for (const l of bad.slice(0, 40)) console.log(' ', l);
  if (bad.some((l) => /\[error\]|\[pageerror\]/.test(l))) exitCode = 1;
} catch (err) {
  console.error('probe failed:', err);
  for (const l of logs.slice(-40)) console.log(' ', l);
  exitCode = 1;
} finally {
  await browser.close();
  server?.kill();
}

console.log(exitCode === 0 ? '\nAUDIO PROBE: PASS' : '\nAUDIO PROBE: FAIL');
process.exit(exitCode);
