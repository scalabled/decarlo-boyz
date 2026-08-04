#!/usr/bin/env node
/**
 * AUDIO / MUTE + VOLUME GATE
 *
 * You cannot screenshot silence, so this is the gate for the global audio
 * controls. It renders the REAL synthesis graph offline through
 * `src/audio/bench.js` in headless Chromium, applies the SAME Mixer calls the
 * pause menu makes (`setMasterVolume`, `setBusVolume` — see src/ui/menu.js), and
 * measures the EMITTED buffer, not the gain values it set (rule 12).
 *
 * For a siren, an engine, a weapon and the radio it asserts:
 *   - MUTE (master -> 0) drives the rendered output to silence.
 *   - the relevant slider at 0 (Effects for SFX, Music for the radio) drives the
 *     rendered output to silence too.
 *
 * The bug this exists for: the reverb send used to be PRE-fader, so a source's
 * wet tail bypassed its bus volume and a siren stayed audible with Effects at 0.
 * The mute path (master) always worked; the slider path did not. The negative
 * control restores the pre-fader send (`preFaderSend`) and proves the slider
 * assertions go RED — a gate that stays green there is measuring nothing.
 *
 * Browser probe (Web Audio needs a real AudioContext), ~15-25 s, deterministic
 * (fixed seed, OfflineAudioContext). NOT gate-tier — it boots a browser — so it
 * is chained into `soak` (`npm run mute`). Run it when you touch src/audio.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, join, normalize } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };

const PAGE = `<!doctype html><meta charset=utf8><title>mute gate</title>
<body><script type="module">
  import * as bench from '/src/audio/bench.js';
  window.__BENCH__ = bench;
  window.__READY__ = true;
</script></body>`;

const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return;
  }
  const path = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
const PORT = await new Promise((d) => server.listen(0, '127.0.0.1', () => d(server.address().port)));

/** RMS in dBFS over a tail window [startFrac, endFrac) of the interleaved PCM. */
function tailDbfs(r, startFrac = 0.4, endFrac = 0.98) {
  const raw = Buffer.from(r.pcm, 'base64');
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const frames = pcm.length / 2;
  const a = Math.floor(frames * startFrac);
  const b = Math.floor(frames * endFrac);
  let sumSq = 0;
  for (let i = a; i < b; i++) {
    const l = pcm[i * 2] / 32768, rr = pcm[i * 2 + 1] / 32768;
    sumSq += l * l + rr * rr;
  }
  const n = Math.max(1, (b - a) * 2);
  const rms = Math.sqrt(sumSq / n);
  return 20 * Math.log10(Math.max(rms, 1e-9));
}

const browser = await chromium.launch({
  headless: true,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));

let pass = 0, fail = 0;
const say = (ok, msg) => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}`); ok ? pass++ : fail++; };

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 30000 });

  const render = async (name, opts) =>
    tailDbfs(await page.evaluate(([n, o]) => window.__BENCH__.renderScene(n, o), [name, opts]));

  // Every audible source, with the slider that must scale it. `base` is merged
  // into every render for that source. The siren scene is soloed onto the
  // `sirens` bus because PoliceAudio ALSO emits the pursuit tension layer on the
  // MUSIC bus — that is music, correctly untouched by the Effects slider, and it
  // would otherwise mask the siren's own path.
  const SOURCES = [
    { scene: 'sirenStatic', label: 'siren', slider: 'sfx', base: { solo: 'sirens' } },
    { scene: 'engineSteady', label: 'engine', slider: 'sfx', base: {} },
    { scene: 'weaponLoop', label: 'weapon', slider: 'sfx', base: {} },
    { scene: 'radio:furnace', label: 'radio', slider: 'music', base: {} },
  ];

  // Thresholds are RATCHETs: the fix drives every source far past them (see the
  // measured drops printed below). Lower them if you improve; never raise one to
  // go green (rule 13). A muted/zeroed source must also be quiet in absolute
  // terms, not merely relatively.
  const MUTE_DROP_DB = 30;      // measured worst ~37 dB (weapon); siren ~78
  const SLIDER_DROP_DB = 24;    // measured worst ~26 dB (radio); siren/engine >40
  const SILENT_DBFS = -60;      // absolute ceiling for a silenced source

  console.log('\n=== controls reach the emitted buffer (tail-window dBFS RMS) ===\n');
  const off = (s) => (s.slider === 'sfx' ? { sfx: 0 } : { music: 0 });
  const sirenFull = {};

  for (const s of SOURCES) {
    const full = await render(s.scene, { ...s.base });
    const muted = await render(s.scene, { ...s.base, mute: true });
    const sliderOff = await render(s.scene, { ...s.base, ...off(s) });
    if (s.label === 'siren') { sirenFull.full = full; sirenFull.sliderOff = sliderOff; }
    const muteDrop = full - muted;
    const sliderDrop = full - sliderOff;
    console.log(`${s.label.padEnd(7)} full ${full.toFixed(1)}  mute ${muted.toFixed(1)} (Δ${muteDrop.toFixed(1)})  ${s.slider}=0 ${sliderOff.toFixed(1)} (Δ${sliderDrop.toFixed(1)})`);

    say(muteDrop >= MUTE_DROP_DB && muted <= SILENT_DBFS,
      `${s.label}: MUTE silences it (drop ${muteDrop.toFixed(1)} dB >= ${MUTE_DROP_DB}, floor ${muted.toFixed(1)} <= ${SILENT_DBFS})`);
    say(sliderDrop >= SLIDER_DROP_DB && sliderOff <= SILENT_DBFS,
      `${s.label}: ${s.slider}=0 silences it (drop ${sliderDrop.toFixed(1)} dB >= ${SLIDER_DROP_DB}, floor ${sliderOff.toFixed(1)} <= ${SILENT_DBFS})`);
  }

  // Halved slider must roughly halve the source (scales, not just on/off).
  const halfSiren = await render('sirenStatic', { solo: 'sirens', sfx: 0.5 });
  const halfDrop = sirenFull.full - halfSiren;
  console.log(`\nsiren sfx=0.5 -> ${halfSiren.toFixed(1)} dBFS (Δ${halfDrop.toFixed(1)} from full ${sirenFull.full.toFixed(1)})`);
  say(halfDrop >= 3 && halfDrop <= 12, `siren scales with the slider (Δ${halfDrop.toFixed(1)} dB in [3,12])`);

  // --- NEGATIVE CONTROL: pre-fader send restored; the slider must FAIL ---
  console.log('\n=== negative control: pre-fader send restored ===\n');
  const ncFull = await render('sirenStatic', { solo: 'sirens', preFaderSend: true });
  const ncOff = await render('sirenStatic', { solo: 'sirens', sfx: 0, preFaderSend: true });
  const ncDrop = ncFull - ncOff;
  console.log(`siren (pre-fader) full ${ncFull.toFixed(1)}  sfx=0 ${ncOff.toFixed(1)} (Δ${ncDrop.toFixed(1)})`);
  say(ncDrop < SLIDER_DROP_DB && ncOff > SILENT_DBFS,
    `pre-fader siren stays audible under sfx=0 (Δ${ncDrop.toFixed(1)} dB < ${SLIDER_DROP_DB}, floor ${ncOff.toFixed(1)} > ${SILENT_DBFS}) — gate has teeth`);

  if (pageErrors.length) {
    console.log('\npage errors:'); for (const e of pageErrors.slice(0, 5)) console.log('  ', e);
  }
} catch (err) {
  console.error('mutegate crashed:', err?.message ?? err);
  fail++;
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} checks`);
process.exit(fail === 0 ? 0 : 1);
