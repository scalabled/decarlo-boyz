#!/usr/bin/env node
/**
 * AIRCRAFT-BODY PROBE — is the player's OWN character mesh hidden while he rides
 * a plane/jet or a heli, and shown again everywhere else?
 *
 *   npm run build && node src/player/aircraftbodyprobe.mjs
 *   node src/player/aircraftbodyprobe.mjs --port=5173      (reuse a running vite)
 *   node src/player/aircraftbodyprobe.mjs --verbose
 *   node src/player/aircraftbodyprobe.mjs --keep
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The seated driver pose is authored for a CAR cabin — it is meant to read
 * through the windows. In a plane cockpit or a heli bubble it does not fit: the
 * body clips out of the fuselage/canopy ("the player's body hangs out of the
 * jet"). `src/player/index._updateVisibility` therefore hides the player's own
 * character mesh while `_inAircraft()`, and only then — cars, bikes and boats
 * keep the seated driver.
 *
 * WHAT IT ASSERTS, on the EMITTED render decision (rule 12) — the world-visible
 * flag the renderer actually consults for `character.root`, never the input the
 * hide logic reads (`vehicles.seated` + `spec.kind`):
 *   - PLANE: seated in a jet on a real runway, the body is NOT drawn.
 *   - CAR:   seated in a car, the body IS drawn (so this is aircraft-specific
 *            hiding, not a global kill of the mesh).
 *   - EXIT:  step out of the aircraft and the body is drawn again.
 *   - HELI:  the same hide covers helicopters, not just fixed-wing.
 *   - NEGATIVE CONTROL: flip `debugHideInAircraft = false` on the LIVE player
 *            and the SAME jet seat leaves the body VISIBLE — which is what proves
 *            the check is what removes the body and the gate is not decorative.
 *
 * The body is expressed as WORLD visibility: root.visible AND every ancestor's,
 * AND a non-zero material opacity — i.e. whether three.js would put the mesh in
 * the render list at all. `setOpacity(0)` sets `root.visible = false`, which is
 * exactly the flag `WebGLRenderer.projectObject` culls on.
 *
 * Two screenshots are written next to the probe run for the record: the jet with
 * the hide DISABLED (body clipping out of the canopy) and ENABLED (gone).
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);
const VERBOSE = 'verbose' in args;
const KEEP = 'keep' in args;
const SHOTDIR = args.shotdir || '/tmp';

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

/**
 * The EMITTED render state of the player's own body. `worldVisible` is the AND
 * of `root.visible` up the whole ancestor chain — the flag the renderer culls
 * on — plus a real material opacity, so a faded-to-zero body reads as not drawn.
 * `drawn` is the single verdict the gate asserts on.
 */
const readBody = () => run(`
  const rig = player.character;
  const root = rig?.root ?? null;
  if (!root) return { err: 'no character root' };
  let worldVisible = true;
  for (let o = root; o; o = o.parent) { if (o.visible === false) { worldVisible = false; break; } }
  let meshVisible = true, maxOpacity = 0;
  root.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      if (o.visible === false) meshVisible = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mm of mats) { if (mm && typeof mm.opacity === 'number') maxOpacity = Math.max(maxOpacity, mm.opacity); }
    }
  });
  const opacity = +(rig._opacity ?? 0).toFixed(3);
  const drawn = worldVisible && meshVisible && opacity > 0.01;
  const vh = player.vehicles;
  return {
    drawn, worldVisible, meshVisible, opacity, maxOpacity: +maxOpacity.toFixed(3),
    rootVisible: root.visible === true,
    inVehicle: player.inVehicle === true,
    seated: !!vh?.seated,
    phase: vh?.phase ?? null,
    kind: vh?.vehicle?.spec?.kind ?? null,
    id: vh?.vehicle?.spec?.id ?? null,
    brother: rig?.brother?.name ?? rig?.brother?.id ?? null,
  };`);

/** Board a fresh `type` at the threshold of the longest real runway. */
const boardAtRunway = (type) => run(`
  if (player.inVehicle) player.vehicles.abort(player.movement);
  if (window.__V__) { try { veh.despawn(window.__V__); } catch(e){} window.__V__ = null; }
  const fields = world?.airfields;
  if (!fields || !fields.length) return { err: 'no airfields' };
  let af = fields[0];
  for (const f of fields) { if ((f.runway?.[0] ?? 0) > (af.runway?.[0] ?? 0)) af = f; }
  const c = Math.cos(af.yaw), s = Math.sin(af.yaw);
  const len = af.runway?.[0] ?? 400;
  const back = 0.42;
  const px = af.x + s * (-len * back);
  const pz = af.z + c * (-len * back);
  for (const o of veh.vehicles.slice()) {
    if (Math.hypot(o.position.x - px, o.position.z - pz) < 70) { try { veh.despawn(o); } catch(e){} }
  }
  const v = game.wq.spawnVehicle('${type}', px, pz, af.yaw);
  if (!v) return { err: 'spawn failed for ${type}' };
  window.__V__ = v;
  const boarded = game.debugBoard(v);
  return { field: af.name, runway: +len.toFixed(0), kind: v.spec?.kind ?? null, boarded };`);

/** Board a fresh `type` right next to where the player is standing (cars). */
const boardHere = (type) => run(`
  if (player.inVehicle) player.vehicles.abort(player.movement);
  if (window.__V__) { try { veh.despawn(window.__V__); } catch(e){} window.__V__ = null; }
  const p = player.movement.position;
  const yaw = player.movement.faceYaw ?? 0;
  const v = game.wq.spawnVehicle('${type}', p.x + 3, p.z, yaw);
  if (!v) return { err: 'spawn failed for ${type}' };
  window.__V__ = v;
  const boarded = game.debugBoard(v);
  return { kind: v.spec?.kind ?? null, boarded };`);

/** Toggle the live negative-control flag on the player. */
const setHide = (on) => run(`player.debugHideInAircraft = ${!!on}; return player.debugHideInAircraft;`);

const shot = async (name) => {
  const buf = await page.screenshot();
  const path = `${SHOTDIR}/${name}`;
  writeFileSync(path, buf);
  return path;
};

let code = 0;
try {
  await page.goto(`http://127.0.0.1:${port}/?boot=0&cheats=1`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await pump(90);
  await run(`
    engine.input.enabled = true;
    engine.input.frozen = false;
    player?.setControlEnabled?.(true);
    game?.missions?.abort?.();
    game?.heat?.clear?.('probe');
    return true;`);

  /* ================================================================= */
  area = '1 PLANE — the player body is NOT drawn in the cockpit';
  /* ================================================================= */
  const setup = await boardAtRunway('jet');
  await pump(200);                                  // let the seat settle
  const inJet = await readBody();
  if (VERBOSE) console.log('   jet:', JSON.stringify(inJet));
  rec('the jet is boarded on a real runway (control condition)',
    inJet && !setup.err && inJet.inVehicle && inJet.kind === 'plane',
    setup.err ? `SETUP FAILED: ${setup.err}` : `${setup.field} · phase ${inJet?.phase} · kind ${inJet?.kind}`);
  rec('the player character mesh is NOT drawn while in the jet',
    inJet && inJet.drawn === false && inJet.worldVisible === false,
    `drawn ${inJet?.drawn} · worldVisible ${inJet?.worldVisible} · rootVisible ${inJet?.rootVisible} · opacity ${inJet?.opacity}`);

  const afterShot = await shot('aircraftbody_jet_AFTER_hidden.png');

  /* ================================================================= */
  area = '2 NEGATIVE CONTROL — hide disabled leaves the body clipping out';
  /* ================================================================= */
  // Same jet seat, flip the fix off on the LIVE player. The body must come back,
  // which is the state the report describes and the exact thing the gate catches.
  await setHide(false);
  await pump(30);
  const jetNoHide = await readBody();
  if (VERBOSE) console.log('   jet(no hide):', JSON.stringify(jetNoHide));
  rec('NEG CONTROL — with debugHideInAircraft=false the body IS drawn in the jet',
    jetNoHide && jetNoHide.drawn === true && jetNoHide.worldVisible === true,
    `drawn ${jetNoHide?.drawn} · worldVisible ${jetNoHide?.worldVisible} · opacity ${jetNoHide?.opacity}`);
  const beforeShot = await shot('aircraftbody_jet_BEFORE_clipping.png');
  await setHide(true);
  await pump(30);
  const jetReHidden = await readBody();
  rec('re-enabling the hide removes the body again (same seat, no re-board)',
    jetReHidden && jetReHidden.drawn === false,
    `drawn ${jetReHidden?.drawn} · worldVisible ${jetReHidden?.worldVisible}`);

  /* ================================================================= */
  area = '3 CAR — the seated driver stays drawn (aircraft-specific hide)';
  /* ================================================================= */
  // Drop out of the jet onto the runway, then board a car and confirm the body
  // is drawn. Proves this is not a global kill of the player mesh.
  await run(`if (player.inVehicle) player.vehicles.abort(player.movement); return true;`);
  await pump(30);
  const carSetup = await boardHere('sedan');
  await pump(200);
  const inCar = await readBody();
  if (VERBOSE) console.log('   car:', JSON.stringify(inCar));
  rec('a car is boarded (control condition)',
    inCar && !carSetup.err && inCar.inVehicle && inCar.kind !== 'plane' && inCar.kind !== 'heli',
    carSetup.err ? `SETUP FAILED: ${carSetup.err}` : `kind ${inCar?.kind} · id ${inCar?.id} · phase ${inCar?.phase}`);
  rec('the player character mesh IS drawn while in the car',
    inCar && inCar.drawn === true && inCar.worldVisible === true,
    `drawn ${inCar?.drawn} · worldVisible ${inCar?.worldVisible} · opacity ${inCar?.opacity}`);

  /* ================================================================= */
  area = '4 EXIT — the body is drawn again once out of the aircraft';
  /* ================================================================= */
  await boardAtRunway('plane');
  await pump(200);
  const inPlane2 = await readBody();
  rec('seated again in a plane, the body is hidden (pre-exit condition)',
    inPlane2 && inPlane2.drawn === false,
    `drawn ${inPlane2?.drawn} · kind ${inPlane2?.kind}`);
  // Real exit through the handler, not an abort, so the exit path is what restores it.
  await run(`player.vehicles.tryExit(player.movement); return true;`);
  await pump(120);
  await run(`if (player.inVehicle) player.vehicles.abort(player.movement); return true;`);
  await pump(60);
  const afterExit = await readBody();
  if (VERBOSE) console.log('   after exit:', JSON.stringify(afterExit));
  rec('after leaving the plane the body is drawn again and on foot',
    afterExit && afterExit.drawn === true && afterExit.inVehicle === false,
    `drawn ${afterExit?.drawn} · worldVisible ${afterExit?.worldVisible} · inVehicle ${afterExit?.inVehicle} · opacity ${afterExit?.opacity}`);

  /* ================================================================= */
  area = '5 HELI — the same hide covers helicopters';
  /* ================================================================= */
  const heliSetup = await boardHere('heli');
  await pump(200);
  const inHeli = await readBody();
  if (VERBOSE) console.log('   heli:', JSON.stringify(inHeli));
  rec('a helicopter is boarded (control condition)',
    inHeli && !heliSetup.err && inHeli.inVehicle && inHeli.kind === 'heli',
    heliSetup.err ? `SETUP FAILED: ${heliSetup.err}` : `kind ${inHeli?.kind} · id ${inHeli?.id}`);
  rec('the player character mesh is NOT drawn while in the heli',
    inHeli && inHeli.drawn === false && inHeli.worldVisible === false,
    `drawn ${inHeli?.drawn} · worldVisible ${inHeli?.worldVisible} · opacity ${inHeli?.opacity}`);

  await run(`if (player.inVehicle) player.vehicles.abort(player.movement); return true;`);
  await pump(20);

  rec('0 boot — no script error', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'clean');

  let last = '';
  let failed = 0;
  for (const r of results) {
    if (r.area !== last) { last = r.area; console.log(`\n=== ${last} ===`); }
    if (!r.ok) failed++;
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
    if (!r.ok || VERBOSE) console.log(`       ${r.detail}`);
  }
  console.log(`\nscreenshots:\n  BEFORE (hide off, body clipping): ${beforeShot}\n  AFTER  (hide on, body hidden):    ${afterShot}`);
  console.log(`\naircraftbody: ${results.length - failed}/${results.length}`);
  code = failed ? 1 : 0;
} catch (err) {
  console.error('probe threw:', err);
  code = 2;
} finally {
  if (!KEEP || !code) await b.close();
  server?.kill();
}
process.exit(code);
