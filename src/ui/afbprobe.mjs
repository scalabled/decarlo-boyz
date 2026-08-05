#!/usr/bin/env node
/**
 * AFB PROBE — Ridgeline AFB is FINDABLE on the map and cheat menu, and
 * REACHABLE by the teleport, measured on EMITTED state.
 *
 *   npm run build && node src/ui/afbprobe.mjs
 *   node src/ui/afbprobe.mjs --json
 *
 * A player reported the military airbase could not be found on the pause map or
 * in the cheat teleport list. The data (the `MILITARY` table + `POI_STYLE`
 * entry in src/ui/data.js, published `world.airbase`) was all present, so this
 * probe pins the three views the player actually looks at and asserts the base
 * shows up in each, plus that the teleport lands somewhere a car can drive.
 *
 * ---------------------------------------------------------------------------
 * RULE 12: ASSERT THE EMITTED VIEW, NOT THE TABLE IT WAS BUILT FROM
 * ---------------------------------------------------------------------------
 *   map     -> the pin lives in `ui.map.pois` (the model the pause map iterates
 *              to draw) at the MAIN GATE (~-321,-1166), styled 'military'.
 *   cheat   -> `ui.cheats._teleportTargets()` carries a RIDGELINE AFB row under
 *              the MILITARY group, and its destination has been resolved to the
 *              drivable APPROACH outside the wire (not the raw gate pin).
 *   reach   -> click the real DOM teleport row, let the sim run, then read the
 *              player's feet vs `world.airbase.insidePerimeter` and the surface
 *              underneath — near the gate, on drivable ground, OUTSIDE the fence.
 *   minimap -> render the Slag Ring with the player at the base and count the
 *              base pin's olive (#8aa062) pixels on the EMITTED canvas.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROL — proves each presence check measures presence
 * ---------------------------------------------------------------------------
 * A second boot with `?nomilitary=1` drops the AFB pin from all three consumers
 * (pausemap.js / cheats.js / radar.js honour the flag). The map model, the
 * teleport list and the minimap olive pixels must all go to ZERO. If they do
 * not, the positive checks above are asserting a constant, not a presence —
 * exactly the failure ARCHITECTURE.md rule 12 exists to catch.
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

const GATE = { x: -321, z: -1166 };   // the authored main-gate pin
const results = [];
const rec = (area, name, ok, detail) => {
  results.push({ area, name, ok: !!ok, detail: String(detail ?? '') });
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(60)} ${detail ?? ''}`);
};

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio', '--disable-frame-rate-limit'],
});

const pageErrors = [];
let page;

async function boot(query) {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => { if (pageErrors.length < 20) pageErrors.push(String(e.message).slice(0, 200)); });
  page.on('console', (m) => {
    if (m.type() === 'error' && pageErrors.length < 20) pageErrors.push(m.text().slice(0, 200));
  });
  await page.goto(`http://127.0.0.1:${port}/${query}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await page.waitForFunction('window.__SETTLED__ ? window.__SETTLED__() : true', null, { timeout: 180000 });
  await pump(30);
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.input.enabled = true;
    e.input.frozen = false;
    e.ctx.peek('player')?.setControlEnabled?.(true);
  });
  await pump(10);
}

const pump = (n = 1) => page.evaluate((k) => window.__PUMP__(k), n);
const cheatOpen = () => page.evaluate(() => !!window.__ENGINE__.ctx.peek('ui').cheats?.open);

/** Advance REAL sim time — closing the panel first, which freezes the clock. */
const settle = async (seconds = 1) => {
  if (await cheatOpen()) { await page.keyboard.press('Escape'); await pump(6); }
  const t0 = await page.evaluate(() => window.__ENGINE__.time.elapsed);
  for (let i = 0; i < 400; i++) {
    await pump(10);
    const t = await page.evaluate(() => window.__ENGINE__.time.elapsed);
    if (t - t0 >= seconds) return +(t - t0).toFixed(2);
  }
  return -1;
};

/** The state the three views expose, read in one evaluate (no cross-frame reads). */
const model = () => page.evaluate((gate) => {
  const e = window.__ENGINE__;
  const ui = e.ctx.peek('ui');
  const world = e.ctx.peek('world');
  const ab = world?.airbase;
  const near = (p) => Math.abs(p.x - gate.x) < 8 && Math.abs(p.z - gate.z) < 8;
  const mapMil = (ui.map?.pois ?? []).filter((p) => p.kind === 'military');
  let tp = [];
  try { tp = ui.cheats._teleportTargets(); } catch { tp = []; }
  const tpMil = tp.filter((t) => t.group === 'MILITARY' || /RIDGELINE/.test(t.name));
  return {
    mapMil: mapMil.map((p) => ({ x: +p.x.toFixed(1), z: +p.z.toFixed(1), name: p.name, atGate: near(p) })),
    tpMil: tpMil.map((t) => ({
      x: +t.x.toFixed(1), z: +t.z.toFixed(1), name: t.name, group: t.group,
      inside: typeof ab?.insidePerimeter === 'function' ? ab.insidePerimeter(t.x, t.z) : null,
    })),
    gateInside: typeof ab?.insidePerimeter === 'function' ? ab.insidePerimeter(gate.x, gate.z) : null,
  };
}, GATE);

/** Where the player's boots ended up, and the fence/surface underneath them. */
const landing = () => page.evaluate((gate) => {
  const e = window.__ENGINE__;
  const player = e.ctx.peek('player');
  const world = e.ctx.peek('world');
  const ab = world?.airbase;
  const f = player?.feetPosition ?? player?.position;
  if (!f) return null;
  let inside = null;
  try { inside = ab?.insidePerimeter?.(f.x, f.z); } catch { inside = 'err'; }
  return {
    pos: [+f.x.toFixed(1), +f.z.toFixed(1)],
    dist: +Math.hypot(f.x - gate.x, f.z - gate.z).toFixed(1),
    surface: world?.surfaceAt?.(f.x, f.z) ?? null,
    inside,
    grounded: !!(player.movement?.grounded ?? player.grounded),
  };
}, GATE);

/** Olive (#8aa062) pixels on the EMITTED minimap canvas — the base's blip. */
const minimapOlive = () => page.evaluate(() => {
  const cvs = document.querySelector('.ow-radar-inner canvas');
  if (!cvs) return { olive: -1, painted: 0 };
  const g = cvs.getContext('2d');
  const { width, height } = cvs;
  const d = g.getImageData(0, 0, width, height).data;
  let olive = 0;
  let painted = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]; const gg = d[i + 1]; const b = d[i + 2]; const a = d[i + 3];
    if (a > 20) painted++;
    if (a > 60 && Math.abs(r - 138) < 45 && Math.abs(gg - 160) < 45 && Math.abs(b - 98) < 45) olive++;
  }
  return { olive, painted };
});

/**
 * Stand the player on the drivable approach beside the gate (NOT on the pin —
 * the player chevron is drawn over the disc centre and would hide a pin sitting
 * under it). Same vantage in both the positive and the negative boot, so the
 * only thing that differs between them is whether the base pin exists.
 */
const goNearBase = () => page.evaluate(() => {
  const c = window.__ENGINE__.ctx.peek('ui').cheats;
  const spot = c._airbaseGateSpot() ?? { x: -318, z: -1157 };
  c._teleport(spot.x, spot.z);
});

/** Click the named action on the row whose name starts with `name`. */
const clickRow = async (name, action) => {
  const out = await page.evaluate(([n, a]) => {
    const rows = [...document.querySelectorAll('.ow-cheat-row')];
    const row = rows.find((r) => (r.querySelector('.name')?.textContent ?? '').trim().toUpperCase().startsWith(n));
    if (!row) return { ok: false, status: 'no row starting "' + n + '"' };
    const btn = [...row.querySelectorAll('.ow-cheat-act')].find((b) => b.textContent.trim().toUpperCase() === a);
    if (!btn) return { ok: false, status: 'no "' + a + '" button' };
    if (btn.disabled) return { ok: false, status: 'button disabled' };
    btn.click();
    return { ok: true, status: (document.querySelector('.ow-cheat-status')?.textContent ?? '').trim() };
  }, [name.toUpperCase(), action.toUpperCase()]);
  await pump(6);
  return out;
};

/* ==================================================================== run == */

/* ---- POSITIVE: the base is on the map, in the menu, and reachable -------- */
log('\n--- the airbase is FINDABLE and REACHABLE ---');
await boot('?cheats=1&boot=0&q=low&prewarm=0');

const m = await model();
rec('map', 'the pause map model carries a military pin at the main gate',
  m.mapMil.length === 1 && m.mapMil[0].atGate,
  `map military pins: ${JSON.stringify(m.mapMil)}`);
rec('cheat', 'RIDGELINE AFB is a teleport target under the MILITARY group',
  m.tpMil.length >= 1 && m.tpMil.some((t) => /RIDGELINE/.test(t.name) && t.group === 'MILITARY'),
  `tp military: ${JSON.stringify(m.tpMil)}`);
rec('cheat', 'the teleport destination is the drivable approach OUTSIDE the wire',
  m.gateInside === true && m.tpMil.length >= 1 && m.tpMil.every((t) => t.inside === false),
  `gate pin inside=${m.gateInside}, tp destinations inside=${JSON.stringify(m.tpMil.map((t) => t.inside))}`);

// Open the teleport tab and click the real RIDGELINE row.
await page.keyboard.press('Backquote'); await pump(6);
await page.evaluate(() => document.querySelector('.ow-cheat-tab[data-tab="tp"]')?.click()); await pump(6);
const tpClick = await clickRow('RIDGELINE', 'TELEPORT');
const drove = await settle(1.0);
const land = await landing();
rec('reach', 'the TELEPORT row is wired and moves the player to the base',
  tpClick.ok && drove > 0 && land && land.dist < 70,
  `${tpClick.status} · ${land ? land.dist : 'n/a'} m from the gate (${drove}s of sim)`);
rec('reach', 'the player lands on drivable ground, grounded, OUTSIDE the fence',
  !!land && land.grounded && land.inside === false && (land.surface === 'asphalt' || land.surface === 'sidewalk'),
  land ? `surface ${land.surface}, insidePerimeter ${land.inside}, grounded ${land.grounded} at ${JSON.stringify(land.pos)}` : 'no landing');

// Stand on the approach beside the gate — the minimap should carry the blip.
await goNearBase();
await pump(40);
const olivePos = await minimapOlive();
rec('minimap', 'the base draws a blip on the Slag Ring when the player is near',
  olivePos.olive > 0, `${olivePos.olive} olive pixels on the disc (painted ${olivePos.painted})`);

await page.close();

/* ---- NEGATIVE CONTROL: hide the AFB, every presence check must go red ---- */
log('\n--- NEGATIVE CONTROL: ?nomilitary=1 removes the base from all three views ---');
await boot('?cheats=1&boot=0&q=low&prewarm=0&nomilitary=1');
const nm = await model();
rec('map', 'N: with the AFB hidden, the map model has NO military pin',
  nm.mapMil.length === 0, `${nm.mapMil.length} military pins (want 0)`);
rec('cheat', 'N: with the AFB hidden, the teleport list has NO RIDGELINE AFB',
  nm.tpMil.length === 0, `${nm.tpMil.length} military tp rows (want 0)`);
await goNearBase();
await pump(40);
const oliveNeg = await minimapOlive();
rec('minimap', 'N: with the AFB hidden, the minimap draws NO base blip',
  oliveNeg.olive === 0, `${oliveNeg.olive} olive pixels (want 0)`);
await page.close();

const uniqueErrors = [...new Set(pageErrors)];
rec('clean', 'no page errors during the whole run', uniqueErrors.length === 0,
  uniqueErrors.slice(0, 3).join(' | ') || 'clean');

/* ------------------------------------------------------------------ report */
await browser.close();
stopServer(server);

const pass = results.filter((r) => r.ok).length;
if (JSON_OUT) {
  console.log(JSON.stringify({ pass, total: results.length, results }, null, 2));
} else {
  console.log(`\n  ${pass}/${results.length} checks passed`);
  const fails = results.filter((r) => !r.ok);
  if (fails.length) {
    console.log('\n  FAILURES');
    for (const f of fails) console.log(`    [${f.area}] ${f.name} — ${f.detail}`);
  }
}
process.exit(pass === results.length ? 0 : 1);
