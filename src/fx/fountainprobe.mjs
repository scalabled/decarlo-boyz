#!/usr/bin/env node
/**
 * THE POINT FOUNTAIN GATE — is there real water on the fountain, does it arc,
 * and does it stay inside its share of the particle budget?
 *
 * =============================================================================
 * WHAT IT MEASURES (hard rule 12)
 * =============================================================================
 * Everything asserted here is read off the EMITTED artefact, not off
 * fountain.js's own intermediates:
 *
 *   the water        the interleaved ring `fx.lit.array` — the exact bytes the
 *                    GPU draws from (particles.js uploads this buffer verbatim).
 *                    A record is "live" when `now - birth` is inside its life,
 *                    which is the same predicate the vertex shader clips on.
 *
 *   the arc          each live jet record's trajectory is integrated
 *                    NUMERICALLY in this file from the spawn state in that
 *                    buffer (dv/dt = -k(v - vm) + g, forward Euler at 2.5 ms),
 *                    never by calling the shader's closed form — so "rises then
 *                    falls" cannot pass by re-evaluating the code's own maths.
 *                    Turbulence is ignored: the jet's authored amplitude is
 *                    0.12 m against thresholds of metres.
 *
 *   the basin        the probe runs its OWN raycast against MASK.WORLD at the
 *                    landmark centre and asserts particle heights against THAT,
 *                    not against `fountain.waterY` (which is then separately
 *                    checked to agree with the measurement it claims to be).
 *
 *   the budget       the live count attributed to the fountain (within 20 m of
 *                    `world.landmarks` lm_point — world's fact, not the
 *                    fountain's copy) must not exceed `fountain.cap`, and cap
 *                    itself must respect config.q.particleBudget's 4.5% share.
 *
 * Boots `?capture=1&lockstep=1`: fixed 1/60 dt, seeded rng, work-denominated
 * streaming — so the run is the same emitted stream the marketing captures see.
 *
 * =============================================================================
 * NEGATIVE CONTROL
 * =============================================================================
 * `fountain.debugDisable` (the authored no-edit hatch, same pattern as
 * `debugIgnorePause`) is flipped LIVE mid-session, the max particle life is
 * waited out, and the jet-region assertions must go RED — zero live records
 * above the basin, zero jet records, spawn counter frozen. Then the hatch is
 * released and the water must come back. A control that leaves the region
 * populated proves the probe is not measuring the fountain at all.
 *
 *   node src/fx/fountainprobe.mjs           # npm run fountain
 *   node src/fx/fountainprobe.mjs --json
 */

import { chromium } from 'playwright';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const JSON_OUT = !!args.json;
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

/** Where the camera stands: ~85 m from lm_point, inside NEAR_FULL (180 m) and
 *  ANCHOR_RANGE (300 m), so every stream runs at full rate and the anchor is
 *  the MEASURED one, not the far-vista provisional. `ground: true` keeps the
 *  eye height honest whatever the heightfield does. Clear weather, so nothing
 *  rain spawns can contaminate the attribution region. */
const SHOT = { pos: [-392, 6, 106], look: [-452, 9, 46], fov: 55, time: 11, weather: 'clear', ground: true };

/* ========================================================================= */
/*  page side                                                                */
/* ========================================================================= */

/**
 * Snapshot the emitted state. Runs INSIDE the page — passed as a function,
 * never a template literal (hard rule 10's second habitat).
 */
function extractInPage() {
  const e = window.__ENGINE__;
  const ctx = e.ctx;
  const fx = ctx.peek('fx');
  const world = ctx.peek('world');
  const out = { errors: [] };
  if (!fx || !world) { out.errors.push('missing fx/world'); return out; }
  const f = fx.fountain;
  if (!f) { out.errors.push('fx.fountain missing'); return out; }
  const lm = world.landmarks?.find?.((l) => l.id === 'lm_point') ?? null;
  if (!lm) { out.errors.push('world has no lm_point landmark'); return out; }

  out.lm = { x: lm.x, z: lm.z };
  out.budget = ctx.config.q.particleBudget ?? null;
  out.quality = ctx.config.quality ?? null;
  out.now = ctx.time.elapsed;
  out.f = {
    cap: f.cap, mist: f.mist, anchored: f.anchored, provisional: f.provisional,
    waterY: f.waterY, nozzleY: f.nozzleY, cx: f.cx, cz: f.cz,
    spawned: f.spawned, debugDisable: f.debugDisable,
    rates: [f.rateJet, f.rateRing, f.rateMist, f.rateSplash, f.rateCascade].map((r) => +r.toFixed(2)),
  };
  out.wind = { x: fx.windVec.x, y: fx.windVec.y, z: fx.windVec.z };

  // The probe's OWN basin measurement: terrain from world, one ray straight
  // down against the emitted collision. Scratch vectors borrowed from fx so
  // the snapshot allocates nothing in the page.
  const ph = fx.physics;
  out.terrain = world.heightAt?.(lm.x, lm.z) ?? null;
  out.basinTop = null;
  if (ph?.raycast && Number.isFinite(out.terrain)) {
    const o = fx._tmpA.set(lm.x, out.terrain + 25, lm.z);
    const d = fx._tmpB.set(0, -1, 0);
    const hit = ph.raycast(o, d, 60, ph.MASK.WORLD);
    if (hit?.hit) out.basinTop = hit.point.y;
  }

  // EMITTED records out of the lit ring — see particles.js for the layout.
  const layer = fx.lit;
  const a = layer.array;
  const STRIDE = 36;
  const count = layer._wrapped ? layer.capacity : layer.highWater;
  const now = out.now;
  const recs = [];
  let liveTotal = 0;
  for (let i = 0; i < count; i++) {
    const b = i * STRIDE;
    const birth = a[b + 8];
    const life = 1 / a[b + 9];
    const age = now - birth;
    if (!(age >= 0 && age < life)) continue;
    liveTotal++;
    const x = a[b], y = a[b + 1], z = a[b + 2];
    const dx = x - lm.x, dz = z - lm.z;
    if (dx * dx + dz * dz > 400) continue; // spawned > 20 m out: not ours
    //          x  y  z  vx        vy        vz        drag       gravity    birth  life  windGain
    recs.push([x, y, z, a[b + 4], a[b + 5], a[b + 6], a[b + 10], a[b + 11], birth, life, a[b + 32]]);
  }
  out.liveTotal = liveTotal;
  out.litCapacity = layer.capacity;
  out.recs = recs;
  return out;
}

/* ========================================================================= */
/*  node side: independent trajectory integration + scoring                  */
/* ========================================================================= */

const H = 1 / 400; // Euler step, seconds

/** March one record forward `t` seconds from its spawn state. */
function integrate(r, t, wind) {
  const k = Math.max(r[6], 0.02);
  const g = r[7];
  const w = r[10];
  const vmx = wind.x * w, vmy = wind.y * w, vmz = wind.z * w;
  let x = r[0], y = r[1], z = r[2];
  let vx = r[3], vy = r[4], vz = r[5];
  const n = Math.max(1, Math.round(t / H));
  const dt = t / n;
  for (let i = 0; i < n; i++) {
    vx += -k * (vx - vmx) * dt;
    vy += (-k * (vy - vmy) + g) * dt;
    vz += -k * (vz - vmz) * dt;
    x += vx * dt; y += vy * dt; z += vz * dt;
  }
  return { x, y, z };
}

/** y sampled at N points across the record's whole life, one continuous march. */
function arcSamples(r, wind, N) {
  const k = Math.max(r[6], 0.02);
  const g = r[7];
  const w = r[10];
  const vmy = wind.y * w;
  let y = r[1], vy = r[4];
  const life = r[9];
  const ys = [y];
  const per = life / (N - 1);
  const steps = Math.max(1, Math.round(per / H));
  const dt = per / steps;
  for (let i = 1; i < N; i++) {
    for (let s = 0; s < steps; s++) {
      vy += (-k * (vy - vmy) + g) * dt;
      y += vy * dt;
    }
    ys.push(y);
  }
  return ys;
}

function analyse(snap) {
  const r = {
    live: snap.liveTotal, region: 0, above: 0, jets: 0,
    arcOK: 0, apexMedian: NaN, basinDelta: NaN,
  };
  const basinTop = snap.basinTop;
  if (basinTop == null || !Number.isFinite(snap.terrain)) return r;
  r.basinDelta = basinTop - snap.terrain;
  const wind = snap.wind;
  const apexes = [];
  for (const rec of snap.recs) {
    const age = snap.now - rec[8];
    const cur = integrate(rec, age, wind);
    const rr = Math.hypot(cur.x - snap.lm.x, cur.z - snap.lm.z);
    if (rr > 20) continue; // drifted out of the basin's neighbourhood
    if (cur.y > basinTop - 0.5) r.region++;
    if (cur.y > basinTop + 1.5) r.above++;
    // Jet records: spawned on the nozzle (r < 1 m) going hard up. The ring
    // jets launch at 6.8-8.6 m/s from r = 5.4, so vy > 12 cannot catch them.
    if (Math.hypot(rec[0] - snap.lm.x, rec[2] - snap.lm.z) < 1.0 && rec[4] > 12) {
      r.jets++;
      const ys = arcSamples(rec, wind, 40);
      let apex = -Infinity, ai = 0;
      for (let i = 0; i < ys.length; i++) if (ys[i] > apex) { apex = ys[i]; ai = i; }
      const interior = ai > 0 && ai < ys.length - 1;
      if (interior && apex - ys[0] > 8 && apex - ys[ys.length - 1] > 3) r.arcOK++;
      apexes.push(apex - basinTop);
    }
  }
  if (apexes.length) {
    apexes.sort((a, b) => a - b);
    r.apexMedian = apexes[apexes.length >> 1];
  }
  return r;
}

/* ========================================================================= */
/*  driver                                                                   */
/* ========================================================================= */

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
let raw = null;

try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errs = [];
  page.on('pageerror', (ev) => errs.push(String(ev.message).slice(0, 200)));

  await page.goto(`http://127.0.0.1:${port}/?capture=1&lockstep=1`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  const pump = (n) => page.evaluate((k) => window.__PUMP__(k), n);

  const applied = await page.evaluate((s) => window.__APPLY_SHOT__(s), JSON.stringify(SHOT));
  log(`[fountain] shot ${JSON.stringify(applied)}`);

  // Streaming settle: the shot teleported the camera to the Point, the tiles
  // (and the basin's COLLISION) have to be built before anything can anchor.
  let frames = 0;
  let settled = false;
  while (frames < 1600) {
    if (await page.evaluate(() => window.__SETTLED__?.() === true)) { settled = true; break; }
    await pump(20);
    frames += 20;
  }
  log(`[fountain] streaming settled=${settled} after ${frames} frames`);

  // Wait for the MEASURED anchor (f.anchored, not provisional).
  let anchored = false;
  for (let i = 0; i < 60; i++) {
    anchored = await page.evaluate(() => {
      const f = window.__ENGINE__.ctx.peek('fx')?.fountain;
      return !!(f && f.anchored && !f.provisional);
    });
    if (anchored) break;
    await pump(15);
  }
  add('the fountain anchored to a measured basin', anchored, `anchored=${anchored} after settle`);

  // Steady state: max authored life is 3.75 s; 450 fixed frames is 7.5 s.
  await pump(450);
  const main = analyse((raw = await page.evaluate(extractInPage)));
  const cap = raw.f?.cap ?? 0;

  add('boot and snapshot are clean', raw.errors.length === 0 && errs.length === 0,
    [...raw.errors, ...errs].join(' | ') || 'no errors');
  add('the basin collider is where the anchor contract says (delta 0.7..2.5 m over terrain)',
    main.basinDelta > 0.7 && main.basinDelta < 2.5,
    `measured basin ${raw.basinTop?.toFixed(3)} = terrain ${raw.terrain?.toFixed(3)} + ${main.basinDelta.toFixed(3)}`);
  add('the anchor adopted the measured basin, not an authored height',
    raw.basinTop != null && Math.abs((raw.f?.waterY ?? 1e9) - raw.basinTop) <= 0.05,
    `fountain.waterY ${raw.f?.waterY?.toFixed(3)} vs probe ray ${raw.basinTop?.toFixed(3)}`);
  add('live water stands above the basin (>= 40 records over basin+1.5)',
    main.above >= 40, `${main.above} live above basin+1.5 m`);
  add('the fountain is actually flowing (>= 500 live in its region)',
    main.region >= 500, `${main.region} live within 20 m of lm_point`);
  add('the emitted population respects the cap', main.region <= cap,
    `${main.region} live <= cap ${cap}`);
  add('cap respects the tier budget (<= 4.5% of q.particleBudget, 60..900)',
    cap <= Math.max(60, Math.min(900, Math.round((raw.budget ?? 0) * 0.045))),
    `cap ${cap} of budget ${raw.budget} (q=${raw.quality}); rates/s ${raw.f?.rates?.join('/')}`);
  add('enough live jet records to judge the arc (>= 15)', main.jets >= 15, `${main.jets} jet records`);
  add('jet particles arc: rise > 8 m to an interior apex, then fall > 3 m (>= 90%)',
    main.jets > 0 && main.arcOK / main.jets >= 0.9, `${main.arcOK}/${main.jets} arc`);
  add('median jet apex sits 12..28 m over the basin',
    main.apexMedian > 12 && main.apexMedian < 28, `median apex +${main.apexMedian.toFixed(1)} m`);

  /* ---- negative control: hold the water, wait out the longest life ------- */
  await page.evaluate(() => { window.__ENGINE__.ctx.peek('fx').fountain.debugDisable = true; });
  await pump(280); // 4.7 s > 3.75 s max life
  const ncRaw = await page.evaluate(extractInPage);
  const nc = analyse(ncRaw);
  add('CONTROL: debugDisable empties the jet region', nc.above === 0 && nc.jets === 0,
    `${nc.above} above basin, ${nc.jets} jets (want 0/0)`);
  add('CONTROL: the emitter really held (spawn counter frozen)',
    ncRaw.f?.spawned === raw.f?.spawned,
    `spawned ${raw.f?.spawned} -> ${ncRaw.f?.spawned}`);

  /* ---- and release: the control, not a dead page, was holding it --------- */
  await page.evaluate(() => { window.__ENGINE__.ctx.peek('fx').fountain.debugDisable = false; });
  await pump(400);
  const back = analyse(await page.evaluate(extractInPage));
  add('the water comes back when the control is released',
    back.above >= 40 && back.region >= 500, `${back.region} live, ${back.above} above basin`);

  raw._main = main; raw._nc = nc; raw._back = back;
  raw.recs = raw.recs.length; // don't dump 800 records into the report
  await page.close();
} catch (e) {
  add('probe ran to completion', false, String(e?.message ?? e).slice(0, 300));
} finally {
  await browser.close();
  stopServer(server);
}

/* ---- report --------------------------------------------------------------- */
const passN = checks.filter((c) => c.pass).length;
log('');
log('=== POINT FOUNTAIN GATE ===');
if (raw?.f) {
  log(`  q=${raw.quality} budget=${raw.budget} cap=${raw.f.cap} mist=${raw.f.mist} · lit ring ${raw.liveTotal}/${raw.litCapacity} live`);
  log(`  main: region ${raw._main?.region} above ${raw._main?.above} jets ${raw._main?.jets} arc ${raw._main?.arcOK} apex ~${raw._main?.apexMedian?.toFixed(1)} m`);
  log(`  nc:   region ${raw._nc?.region} above ${raw._nc?.above} jets ${raw._nc?.jets} · back: region ${raw._back?.region} above ${raw._back?.above}`);
}
for (const c of checks) log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}  [${c.detail}]`);
log(`  ${passN}/${checks.length}`);
if (JSON_OUT) console.log(JSON.stringify({ checks, raw }, null, 2));
log(passN === checks.length ? 'PASS' : 'FAIL');
process.exit(passN === checks.length ? 0 : 1);
