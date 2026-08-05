#!/usr/bin/env node
/**
 * AIRCRAFT PROBE — can the player actually FLY the plane with the keys the
 * pause screen names, through the REAL input path?
 *
 *   npm run build && node src/ui/aircraftprobe.mjs
 *   node src/ui/aircraftprobe.mjs --port=5173      (reuse a running vite)
 *   node src/ui/aircraftprobe.mjs --verbose
 *   node src/ui/aircraftprobe.mjs --keep
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY `flightprobe` IS NOT ENOUGH (RULE 12)
 * ---------------------------------------------------------------------------
 * `src/vehicles/flightprobe.mjs` is 68/68 and it flies the aeroplane beautifully
 * — because it writes `v.input.boost = 1` STRAIGHT ONTO THE VEHICLE, at the
 * `Vehicle.fixedStep` layer, bypassing everything between the keyboard and the
 * wing. That proves the aerodynamic model, and nothing about whether a PLAYER
 * can reach it. It is the classic rule-12 trap: the gate feeds the code the very
 * input it is supposed to be testing the delivery of.
 *
 * MEASURED through the real key path (this probe's whole reason to exist):
 * holding SHIFT in a Skylark — the throttle, per `plane.js`'s own header, "hold
 * SHIFT down the runway, watch the airspeed build" — delivered `input.boost 0`
 * for ten seconds and the aeroplane never rolled. `player/vehicle.js` routed the
 * sprint press through the NITRO BOTTLE, which only opens above a throttle pedal
 * and drains in 3.6 s; on an aeroplane the "throttle pedal" is the elevator, so
 * the bottle never opened. That is the "airplane does not take off or move"
 * report, and no amount of relabelling the pause screen fixes a dead channel.
 *
 * So this drives the keyboard for real — `page.keyboard.down('ShiftLeft')`,
 * through `Input`, through `player/vehicle.js`, through `setInput`, into
 * `stepPlane` — and asserts the EMITTED body motion: the airspeed the wing
 * actually builds and the altitude the gear actually leaves. Never `input`,
 * never the lever, never a commanded rate.
 *
 * ---------------------------------------------------------------------------
 * THE RUNWAY IS REAL
 * ---------------------------------------------------------------------------
 * The plane is spawned at the threshold of a REAL airfield — the pose is READ
 * from `world.airfields` (the same source `game/freeroam._seedAirportVehicles`
 * parks the fleet from), never duplicated here — so "it leaves the runway" is a
 * claim about the shipped world, not a synthetic flat plane.
 *
 * NEGATIVE CONTROL: an identical plane on the same runway with NO throttle held
 * must sit on its gear. The contrast is what makes the positive mean something —
 * a build that let the plane trundle off on its own would fail it.
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);
const VERBOSE = 'verbose' in args;
const KEEP = 'keep' in args;

const { port, server } = await startServer({ explicitPort: args.port });
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

const results = [];
let area = '';
const rec = (name, ok, detail) => results.push({ area, name, ok: !!ok, detail: String(detail) });

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

const run = (body) =>
  page.evaluate(`(() => {
    const engine = window.__ENGINE__;
    const ctx = engine.ctx;
    const ui = ctx.peek('ui');
    const game = ctx.peek('game');
    const player = ctx.peek('player');
    const veh = ctx.peek('vehicles');
    const world = ctx.peek('world');
    ${body}
  })()`);

/** Emitted plane state — airspeed along the nose, altitude, contacts. Never a control. */
const readPlane = () => run(`
  const v = window.__PLANE__;
  if (!v) return null;
  const q = v.quaternion;
  const fx = 2*(q.x*q.z + q.w*q.y), fy = 2*(q.y*q.z - q.w*q.x), fz = 1-2*(q.x*q.x + q.y*q.y);
  const fwd = v.velocity.x*fx + v.velocity.y*fy + v.velocity.z*fz;
  return {
    airspeed: +fwd.toFixed(2),
    speed: +v.speed.toFixed(2),
    altitude: +(v.altitude ?? 0).toFixed(2),
    grounded: v.grounded,
    lever: +(v.throttleLever ?? 0).toFixed(3),
    inputBoost: +(v.input.boost ?? 0).toFixed(2),
    inVehicle: player.inVehicle === true,
    phase: player.vehicles?.phase ?? null,
  };`);

/**
 * Spawn a fresh Skylark at a real airfield's runway threshold, board it through
 * the same enter sequence F uses (`game.debugBoard`), and wait for the seat.
 * Returns the field it used, or an error string.
 */
const boardAtRunway = () => run(`
  if (player.inVehicle) player.vehicles.abort(player.movement);
  if (window.__PLANE__) { try { veh.despawn(window.__PLANE__); } catch(e){} window.__PLANE__ = null; }
  const fields = world?.airfields;
  if (!fields || !fields.length) return { err: 'no airfields' };
  const af = fields[0];
  const c = Math.cos(af.yaw), s = Math.sin(af.yaw);
  const len = af.runway?.[0] ?? 400;
  // The same threshold pose freeroam parks the fleet at: backed up 32% of the
  // runway from centre, nose pointing down it (+yaw).
  const px = af.x + s * (-len * 0.32);
  const pz = af.z + c * (-len * 0.32);
  // Clear anything nearby so the scan/board lands on our plane, not traffic.
  for (const o of veh.vehicles.slice()) {
    if (Math.hypot(o.position.x - px, o.position.z - pz) < 60) { try { veh.despawn(o); } catch(e){} }
  }
  const v = game.wq.spawnVehicle('plane', px, pz, af.yaw);
  if (!v) return { err: 'spawn failed' };
  window.__PLANE__ = v;
  const boarded = game.debugBoard(v);
  return { field: af.name, x: +px.toFixed(0), z: +pz.toFixed(0), yaw: +af.yaw.toFixed(2), boarded };`);

/** Hold a set of keys for ~seconds of sim, sampling the emitted plane. */
async function holdFor(keys, seconds, sampleEvery = 3) {
  for (const k of keys) await page.keyboard.down(k);
  const samples = [];
  const chunks = Math.ceil(seconds / sampleEvery);
  for (let i = 0; i < chunks; i++) {
    await pump(sampleEvery * 60);
    samples.push(await readPlane());
  }
  for (const k of keys) await page.keyboard.up(k);
  await pump(6);
  return samples;
}

let code = 0;
try {
  await page.goto(`http://127.0.0.1:${port}/?boot=0`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await pump(90);
  await run(`
    engine.input.enabled = true;
    engine.input.frozen = false;
    player?.setControlEnabled?.(true);
    game?.missions?.abort?.();
    game?.heat?.clear?.('probe');
    return true;`);
  // First synthetic keypress of a headless session is unreliable — burn one.
  await page.keyboard.press('KeyF');
  await pump(8);

  /* ================================================================= */
  area = '1 the aeroplane is boardable on a real runway';
  /* ================================================================= */
  const setup = await boardAtRunway();
  await pump(180);
  const seated = await readPlane();
  rec('a Skylark spawns on an airfield runway and the player takes the seat',
    seated && seated.inVehicle && !setup.err,
    setup.err ? `SETUP FAILED: ${setup.err}` : `${setup.field} @ ${setup.x},${setup.z} yaw ${setup.yaw} · phase ${seated?.phase}`);

  /* ================================================================= */
  area = '2 SHIFT (the throttle) flies it — the real key path';
  /* ================================================================= */
  // Hold the throttle down the runway. `plane.js`: SHIFT winds the lever up,
  // thrust builds airspeed, and past flying speed the wing lifts the gear off.
  const climb = await holdFor(['ShiftLeft'], 27, 3);
  const peakV = Math.max(0, ...climb.map((c) => c?.airspeed ?? 0));
  const peakAlt = Math.max(0, ...climb.map((c) => c?.altitude ?? 0));
  const last = climb[climb.length - 1] ?? {};
  const boostReached = climb.some((c) => (c?.inputBoost ?? 0) > 0.5);
  const leverWound = climb.some((c) => (c?.lever ?? 0) > 0.9);

  rec('holding SHIFT actually delivers throttle to the wing (input.boost > 0)',
    boostReached,
    boostReached ? 'the sprint press reaches input.boost' : 'DEAD CHANNEL: input.boost stayed 0 — the nitro gate is back');
  rec('the throttle lever winds up to full on SHIFT alone',
    leverWound, `peak lever ${Math.max(0, ...climb.map((c) => c?.lever ?? 0)).toFixed(2)}`);
  rec('airspeed builds past flying speed (~28 m/s)',
    peakV > 32, `peak airspeed ${peakV.toFixed(1)} m/s over ${climb.length} samples`);
  rec('the aeroplane LEAVES THE RUNWAY — altitude rises and the gear comes off',
    peakAlt > 8 && climb.some((c) => c?.grounded === 0),
    `peak altitude ${peakAlt.toFixed(1)} m, last grounded ${last.grounded}`);

  if (VERBOSE) for (let i = 0; i < climb.length; i++) console.log(`   t≈${(i + 1) * 3}s`, JSON.stringify(climb[i]));

  /* ================================================================= */
  area = '3 NEGATIVE CONTROL — no throttle, it stays on the runway';
  /* ================================================================= */
  await boardAtRunway();
  await pump(180);
  const idle = await holdFor([], 24, 3);
  const idleV = Math.max(0, ...idle.map((c) => c?.airspeed ?? 0));
  const idleAlt = Math.max(0, ...idle.map((c) => c?.altitude ?? 0));
  const idleLast = idle[idle.length - 1] ?? {};
  rec('with nothing held, airspeed never builds',
    idleV < 3, `peak airspeed ${idleV.toFixed(2)} m/s`);
  rec('with nothing held, it never leaves the runway',
    idleAlt < 0.6 && (idleLast.grounded ?? 0) >= 3,
    `peak altitude ${idleAlt.toFixed(2)} m, last grounded ${idleLast.grounded}`);

  /* ================================================================= */
  area = '4 SPACE brakes the throttle back down (the raw channel)';
  /* ================================================================= */
  // Wind the lever up, then hold SPACE and watch it wind DOWN. handbrake is
  // forwarded raw already, so this half worked even before the boost fix — it
  // is here as the contrast that pins WHICH channel each key owns.
  await boardAtRunway();
  await pump(180);
  await holdFor(['ShiftLeft'], 6, 6);
  const wound = (await readPlane())?.lever ?? 0;
  const downSamples = await holdFor(['Space'], 6, 3);
  const backDown = downSamples[downSamples.length - 1]?.lever ?? 1;
  rec('SPACE winds the throttle lever back down',
    wound > 0.5 && backDown < wound - 0.3,
    `lever ${wound.toFixed(2)} -> ${backDown.toFixed(2)} on SPACE`);

  // Get out for the panel check.
  await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (window.__PLANE__) { try { veh.despawn(window.__PLANE__); } catch(e){} }
    ui.menu.close();
    return true;`);
  await pump(20);

  /* ================================================================= */
  area = '5 the pause screen NAMES the aircraft controls (emitted DOM)';
  /* ================================================================= */
  // Rule 12: harvest the RENDERED panel, not `CONTROL_GROUPS`. Open the menu,
  // read the visible group headings and their rows out of the live document.
  await page.keyboard.press('Escape');
  await pump(24);
  const panel = await page.evaluate(() => {
    const menu = document.querySelector('.ow-menu');
    if (!menu) return { open: false, groups: [] };
    const vis = (n) => {
      for (let el = n; el && el !== document.documentElement; el = el.parentElement) {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        if (parseFloat(s.opacity || '1') < 0.5) return false;
      }
      return true;
    };
    const groups = [];
    for (const g of menu.querySelectorAll('.ow-ctl-g')) {
      if (!vis(g)) continue;
      const title = g.querySelector('.ow-ctl-gt')?.textContent.trim() ?? '';
      const rows = [...g.querySelectorAll('.ow-ctl-r')].map((r) => ({
        keys: [...r.querySelectorAll('kbd')].map((k) => k.textContent.trim()),
        action: r.querySelector('.ow-ctl-a')?.textContent.trim() ?? '',
      }));
      groups.push({ title, rows });
    }
    return { open: !!document.querySelector('.ow-menu')?.parentElement, groups };
  });

  const findGroup = (re) => panel.groups.find((g) => re.test(g.title));
  const air = findGroup(/AEROPLANE|PLANE|AIRCRAFT/);
  const heli = findGroup(/HELICOPTER|HELI/);

  rec('an AEROPLANE control set is rendered on the pause screen',
    !!air, air ? `"${air.title}" with ${air.rows.length} rows` : `groups: ${panel.groups.map((g) => g.title).join(', ')}`);
  // The throttle row must name SHIFT and describe it as throttle/power — the
  // exact thing that was mislabelled "Climb · descend" (heli language) before.
  const throttleRow = air?.rows.find((r) => r.keys.includes('SHIFT') && /THROTTLE|POWER|SPEED/.test(r.action.toUpperCase()));
  rec('the AEROPLANE set names SHIFT as the throttle (not "climb")',
    !!throttleRow, throttleRow ? `SHIFT -> "${throttleRow.action}"` : `SHIFT rows: ${(air?.rows ?? []).filter((r) => r.keys.includes('SHIFT')).map((r) => r.action).join(' | ') || 'none'}`);
  // And S must be named as pull-back / nose-up / take-off — how it actually flies.
  const pullRow = air?.rows.find((r) => r.keys.includes('S') && /UP|PULL|TAKE|NOSE/.test(r.action.toUpperCase()));
  rec('the AEROPLANE set names S as pull-back / nose-up (how it rotates)',
    !!pullRow, pullRow ? `S -> "${pullRow.action}"` : `S rows: ${(air?.rows ?? []).filter((r) => r.keys.includes('S')).map((r) => r.action).join(' | ') || 'none'}`);
  rec('a HELICOPTER control set is also rendered, kept separate',
    !!heli, heli ? `"${heli.title}" with ${heli.rows.length} rows` : `groups: ${panel.groups.map((g) => g.title).join(', ')}`);

  await run('ui.menu.close(); return true;');

  rec('0 boot — no script error', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'clean');

  let last2 = '';
  let failed = 0;
  for (const r of results) {
    if (r.area !== last2) { last2 = r.area; console.log(`\n=== ${last2} ===`); }
    if (!r.ok) failed++;
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
    if (!r.ok || VERBOSE) console.log(`       ${r.detail}`);
  }
  console.log(`\naircraft: ${results.length - failed}/${results.length}`);
  code = failed ? 1 : 0;
} catch (err) {
  console.error('probe threw:', err);
  code = 2;
} finally {
  if (!KEEP || !code) await b.close();
  server?.kill();
}
process.exit(code);
