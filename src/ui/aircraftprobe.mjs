#!/usr/bin/env node
/**
 * AIRCRAFT PROBE — can the player actually FLY the airplane with the keys the
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
 * `src/vehicles/flightprobe.mjs` is green and it flies the airplane
 * beautifully — because it writes `v.input.boost = 1` STRAIGHT ONTO THE
 * VEHICLE, at the `Vehicle.fixedStep` layer, bypassing everything between the
 * keyboard and the wing. That proves the aerodynamic model, and nothing about
 * whether a PLAYER can reach it, or whether the key the panel calls "nose up"
 * actually raises the nose. It is the classic rule-12 trap: the gate feeds the
 * code the very input it is supposed to be testing the delivery of.
 *
 * So this drives the keyboard for real — `page.keyboard.down('KeyS')`, through
 * `Input`, through `player/vehicle.js`, through `setInput`, into `stepPlane` —
 * and asserts the EMITTED body motion: the airspeed the wing builds, the
 * altitude the gear leaves, and the ATTITUDE (pitch, bank, heading) the body
 * actually reaches. Never `input`, never the lever, never a commanded rate.
 *
 * WHAT IT NAILS DOWN, all on emitted motion:
 *   - SUSTAINED, CONTROLLED CLIMB, EVERY airplane. Build speed on SHIFT, then
 *     HOLD SHIFT + S for a FULL 20 s and gate FIVE things at once, because the
 *     prior gate held S for only 9-12 s and passed on "a rising run + gear up",
 *     which STOPPED BEFORE the over-the-top and the crash and so green-lit
 *     planes that looped and dived into the terrain: (1) altitude reaches a real
 *     height and HOLDS it (final near the peak — no porpoise); (2) airspeed
 *     never drops below 1.1x the plane's own stall floor (no stall); (3) pitch
 *     stays bounded, never over the top; (4) bank stays bounded (no roll-off —
 *     and over-the-top snaps bank to ~180, caught here); (5) the gear never
 *     touches down again once up. TWO NEGATIVE CONTROLS: no throttle never
 *     leaves the ground, AND — the load-bearing one — with the airspeed
 *     protection DISABLED on the live model (`debugNoSpeedProtect`, mirroring
 *     debugFlipPitch) the exact same hold MUST go RED, proving the five checks
 *     catch the broken flight the old window walked past.
 *   - NON-INVERSION, per axis, and this is the load-bearing new coverage.
 *     Press the key the PANEL names for a direction and assert the EMITTED
 *     attitude goes that way: S -> nose UP and climbing, W -> nose DOWN;
 *     D -> banks RIGHT (right wing drops) and the heading swings right,
 *     A -> banks LEFT; on the ground A/D steer the nosewheel the matching way.
 *     Each carries a NEGATIVE CONTROL: `plane.js` exposes `debugFlipPitch` /
 *     `debugFlipRoll`, and with a sign flipped in, the very same assertion MUST
 *     turn red — which is what proves the check measures the sign and is not
 *     just agreeing with whatever the code does.
 *     The climb gate is parametrized over the Skylark, the Slipstream and the
 *     two NEW airplanes (the Grizzly bush STOL and the Meridian twin), each
 *     spawned on a real runway — every plane flies on the same keys.
 *   - THE ROSTER. The cheat menu's own EMITTED spawn rows are read out of the
 *     live document and asserted to contain every flyable — heli, newsheli,
 *     plane, sportplane, bushplane, twinplane, jet — plus the tank, and each
 *     one spawned through the real cheat action yields a live vehicle of its
 *     kind. NEGATIVE CONTROL: a class that is not in the fleet is absent.
 *
 * ---------------------------------------------------------------------------
 * THE RUNWAY IS REAL
 * ---------------------------------------------------------------------------
 * Planes are spawned at the threshold of a REAL airfield — the pose is READ
 * from `world.airfields` (the same source `game/freeroam._seedAirportVehicles`
 * parks the fleet from), never duplicated here — so "it leaves the runway" is a
 * claim about the shipped world, not a synthetic flat plane.
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);
const VERBOSE = 'verbose' in args;
const KEEP = 'keep' in args;
const DEG = 180 / Math.PI;

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
 * Emitted plane state — airspeed along the nose, altitude, and the full
 * attitude (pitch / bank / heading / sideslip) read off the body quaternion.
 * Never a control.
 */
const readPlane = () => run(`
  const v = window.__PLANE__;
  if (!v) return null;
  const q = v.quaternion;
  const fx = 2*(q.x*q.z + q.w*q.y), fy = 2*(q.y*q.z - q.w*q.x), fz = 1-2*(q.x*q.x + q.y*q.y);
  const rx = 1-2*(q.y*q.y + q.z*q.z), ry = 2*(q.x*q.y + q.w*q.z), rz = 2*(q.x*q.z - q.w*q.y);
  const uy = 1-2*(q.x*q.x + q.z*q.z);
  const fwd = v.velocity.x*fx + v.velocity.y*fy + v.velocity.z*fz;
  const lat = v.velocity.x*rx + v.velocity.y*ry + v.velocity.z*rz;
  const clamp1 = (n) => n < -1 ? -1 : n > 1 ? 1 : n;
  return {
    airspeed: +fwd.toFixed(2),
    speed: +v.speed.toFixed(2),
    altitude: +(v.altitude ?? 0).toFixed(2),
    grounded: v.grounded,
    lever: +(v.throttleLever ?? 0).toFixed(3),
    inputBoost: +(v.input.boost ?? 0).toFixed(2),
    pitch: +(Math.asin(clamp1(fy))*180/Math.PI).toFixed(2),
    bank: +(Math.atan2(ry, uy)*180/Math.PI).toFixed(2),
    heading: +(Math.atan2(fx, fz)*180/Math.PI).toFixed(2),
    sideslip: +(Math.atan2(lat, Math.max(Math.abs(fwd), 2))*180/Math.PI).toFixed(2),
    kind: v.spec?.kind ?? null,
    id: v.spec?.id ?? null,
    vref: v.spec?.flight?.Vref ?? null,
    airborneT: +(v.airborne ?? 0).toFixed(2),
    inVehicle: player.inVehicle === true,
    phase: player.vehicles?.phase ?? null,
  };`);

/**
 * The EMITTED exhaust-flame node — its length in metres, whether it is lit, and
 * the actual mesh scale/visibility read straight off `plane.js`'s child mesh.
 * Never a control: `exhaustLen` is the drawn plume length the throttle produced.
 */
const readFlame = () => run(`
  const v = window.__PLANE__;
  if (!v) return null;
  const fl = v._exhaust || null;
  return {
    len: +(v.exhaustLen ?? 0).toFixed(3),
    lit: v.exhaustLit ?? 0,
    hasNode: !!fl,
    visible: fl ? !!fl.visible : false,
    scaleZ: fl ? +fl.scale.z.toFixed(3) : 0,
    scaleR: fl ? +fl.scale.x.toFixed(3) : 0,
    ab: +(v.afterburner ?? 0).toFixed(3),
    lever: +(v.throttleLever ?? 0).toFixed(3),
    jet: !!v._exhaustJet,
  };`);

/**
 * Emitted position plus the body's nose axis and the signed body-forward speed,
 * for the reverse-taxi check: displacement dotted with the nose is + forward,
 * - aft, so "moves BACKWARD" is a claim about the real emitted position.
 */
const readPos = () => run(`
  const v = window.__PLANE__;
  if (!v) return null;
  const q = v.quaternion;
  const fx = 2*(q.x*q.z + q.w*q.y), fz = 1-2*(q.x*q.x + q.y*q.y);
  return {
    x: +v.position.x.toFixed(3), z: +v.position.z.toFixed(3),
    fwdx: fx, fwdz: fz,
    grounded: v.grounded,
    speed: +v.speed.toFixed(2),
    fwdSpeed: +(v.velocity.x*fx + v.velocity.z*fz).toFixed(3),
    alt: +(v.altitude ?? 0).toFixed(2),
  };`);

/**
 * Spawn a fresh aircraft at a real airfield's runway threshold, board it
 * through the same enter sequence F uses (`game.debugBoard`), and wait for the
 * seat. `type` is the class id. Picks the LONGEST runway (the jet needs it).
 */
const boardAtRunway = (type) => run(`
  if (player.inVehicle) player.vehicles.abort(player.movement);
  if (window.__PLANE__) { try { veh.despawn(window.__PLANE__); } catch(e){} window.__PLANE__ = null; }
  const fields = world?.airfields;
  if (!fields || !fields.length) return { err: 'no airfields' };
  let af = fields[0];
  for (const f of fields) { if ((f.runway?.[0] ?? 0) > (af.runway?.[0] ?? 0)) af = f; }
  const c = Math.cos(af.yaw), s = Math.sin(af.yaw);
  const len = af.runway?.[0] ?? 400;
  // Back up from centre so there is runway ahead: the jet wants the whole
  // strip, the props are off in a fraction of it.
  const back = 0.42;
  const px = af.x + s * (-len * back);
  const pz = af.z + c * (-len * back);
  for (const o of veh.vehicles.slice()) {
    if (Math.hypot(o.position.x - px, o.position.z - pz) < 70) { try { veh.despawn(o); } catch(e){} }
  }
  const v = game.wq.spawnVehicle('${type}', px, pz, af.yaw);
  if (!v) return { err: 'spawn failed for ${type}' };
  window.__PLANE__ = v;
  const boarded = game.debugBoard(v);
  return { field: af.name, runway: +len.toFixed(0), x: +px.toFixed(0), z: +pz.toFixed(0), yaw: +af.yaw.toFixed(2), boarded };`);

/** Hold a set of keys for ~seconds of sim, sampling the emitted plane. */
async function holdFor(keys, seconds, sampleEvery = 1.5) {
  for (const k of keys) await page.keyboard.down(k);
  const samples = [];
  const chunks = Math.max(1, Math.ceil(seconds / sampleEvery));
  for (let i = 0; i < chunks; i++) {
    await pump(Math.round(sampleEvery * 60));
    samples.push(await readPlane());
  }
  for (const k of keys) await page.keyboard.up(k);
  await pump(6);
  return samples;
}

/** Set/clear the plane.js negative-control sign flips on the live plane. */
const setFlip = (pitch, roll) => run(`
  const v = window.__PLANE__;
  if (v) { v.debugFlipPitch = ${!!pitch}; v.debugFlipRoll = ${!!roll}; }
  return true;`);

/** Set/clear the airspeed-protection negative-control flag on the live plane. */
const setNoProtect = (on) => run(`
  const v = window.__PLANE__;
  if (v) { v.debugNoSpeedProtect = ${!!on}; }
  return true;`);

/**
 * THE STRENGTHENED CLIMB RUN. Board `type` on a real runway, build flying speed
 * on SHIFT until the wing is genuinely airborne AND a healthy step above its
 * own stall floor (you do not rotate at stall speed), then HOLD SHIFT + S — the
 * panel's "pull back — nose up" — for `hold` seconds, sampling the EMITTED body
 * once a second. Returns the whole sample train so the caller can gate the five
 * failure modes the old 9-12 s window walked straight past: over-the-top, stall,
 * porpoise, roll-off and flying into the ground. `noProtect` flips the airspeed
 * protection OFF on the LIVE plane (the negative control) so the exact same hold
 * can be proven to go RED.
 */
async function climbRun(type, { noProtect = false, hold = 20 } = {}) {
  const setup = await boardAtRunway(type);
  if (setup.err) return { err: setup.err };
  await pump(150);
  const vref = (await readPlane())?.vref ?? 30;
  await setNoProtect(noProtect);
  // BUILD — hold SHIFT down the runway until airborne with margin over the
  // floor. debugNoSpeedProtect is inert here (no back-stick), so both arms
  // reach the air the same way.
  await page.keyboard.down('ShiftLeft');
  let built = null;
  let buildS = 0;
  for (let i = 0; i < 44; i++) {
    await pump(30);                       // 0.5 s of sim
    buildS += 0.5;
    const s = await readPlane();
    if (s && s.grounded === 0 && s.airborneT > 0.4 && s.airspeed > vref * 1.2 && s.altitude > 3) {
      built = s; break;
    }
  }
  // HOLD S — pull back and climb, for the full window.
  await page.keyboard.down('KeyS');
  const samples = [];
  for (let i = 0; i < hold; i++) { await pump(60); samples.push(await readPlane()); }
  await page.keyboard.up('KeyS');
  await page.keyboard.up('ShiftLeft');
  await setNoProtect(false);
  await pump(6);
  return { vref, built, buildS, samples: samples.filter(Boolean) };
}

/** Reduce a climb sample train to the emitted quantities the gate asserts on. */
function climbMetrics(r) {
  const s = r.samples;
  const alt = s.map((x) => x.altitude);
  const peakAlt = Math.max(0, ...alt);
  const finalAlt = alt.length ? alt[alt.length - 1] : 0;
  const minAs = s.length ? Math.min(...s.map((x) => x.airspeed)) : 0;
  const maxAbsPitch = Math.max(0, ...s.map((x) => Math.abs(x.pitch)));
  const maxBank = Math.max(0, ...s.map((x) => Math.abs(x.bank)));
  // Ground contact once already airborne — a wheel back on the deck mid-hold.
  const touched = s.some((x, i) => i > 1 && (x.grounded ?? 0) >= 1);
  // Held = the final altitude has not collapsed back off the peak (no porpoise).
  const holdBand = Math.max(12, 0.12 * peakAlt);
  const held = peakAlt > 40 && finalAlt >= peakAlt - holdBand;
  return { peakAlt, finalAlt, minAs, maxAbsPitch, maxBank, touched, held, holdBand };
}

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
  // First synthetic keypress of a headless session is unreliable — burn one.
  await page.keyboard.press('KeyF');
  await pump(8);

  /* ================================================================= */
  area = '1 the airplane is boardable on a real runway';
  /* ================================================================= */
  const setup = await boardAtRunway('plane');
  await pump(180);
  const seated = await readPlane();
  rec('a Skylark spawns on an airfield runway and the player takes the seat',
    seated && seated.inVehicle && !setup.err,
    setup.err ? `SETUP FAILED: ${setup.err}` : `${setup.field} (${setup.runway} m) @ ${setup.x},${setup.z} · phase ${seated?.phase}`);

  /* ================================================================= */
  area = '2 SHIFT then S — a SUSTAINED, CONTROLLED climb, EVERY airplane';
  /* ================================================================= */
  // The load-bearing rewrite. For each of the four airplanes: build flying
  // speed on SHIFT, then HOLD SHIFT + S (the panel's "pull back — nose up") for
  // a FULL 20 s and gate the five ways the old 9-12 s window let a broken climb
  // through — because it stopped BEFORE the over-the-top and the crash. Every
  // assertion is on the EMITTED body state (altitude, airspeed, pitch, bank,
  // gear), never a control or a commanded rate.
  //   (1) altitude reaches a real height and is HELD (final near the peak — no
  //       porpoise back onto the deck);
  //   (2) airspeed never drops below ~1.1x that plane's own stall floor (Vref) —
  //       no stall, the whole point of the airspeed protection;
  //   (3) pitch stays bounded (never past ~33 deg, never over the top);
  //   (4) bank stays bounded through the straight climb (no roll-off, and a
  //       plane that goes over the top snaps bank to ~180 — caught here);
  //   (5) the gear NEVER touches the ground again once it is up.
  const climbRuns = {};
  for (const type of ['plane', 'sportplane', 'bushplane', 'twinplane']) {
    const r = await climbRun(type);
    if (r.err) {
      rec(`${type} — climb setup`, false, r.err);
      continue;
    }
    climbRuns[type] = r;
    const m = climbMetrics(r);
    const vfloor = r.vref * 1.1;
    if (VERBOSE) r.samples.forEach((c, i) => console.log(`   ${type} t${i + 1}s`, JSON.stringify(c)));

    rec(`${type}: SHIFT builds flying speed and rotates off the runway (built in ${r.buildS?.toFixed(0)}s)`,
      !!r.built && r.built.airspeed > r.vref * 1.15,
      r.built ? `airborne at ${r.built.airspeed.toFixed(1)} m/s, ${r.built.altitude.toFixed(1)} m` : 'never got airborne');
    rec(`${type}: (1) the climb reaches a real height and HOLDS it (no porpoise)`,
      m.held,
      `peak ${m.peakAlt.toFixed(0)} m, final ${m.finalAlt.toFixed(0)} m (must be >= peak - ${m.holdBand.toFixed(0)})`);
    rec(`${type}: (2) airspeed never drops below 1.1x stall (${vfloor.toFixed(0)} m/s) — no stall`,
      m.minAs > vfloor,
      `min airspeed ${m.minAs.toFixed(1)} m/s vs floor ${vfloor.toFixed(1)} m/s (Vref ${r.vref})`);
    rec(`${type}: (3) pitch stays bounded, never over the top`,
      m.maxAbsPitch < 33,
      `peak |pitch| ${m.maxAbsPitch.toFixed(1)} deg`);
    rec(`${type}: (4) bank stays bounded through the straight climb (no roll-off)`,
      m.maxBank < 20,
      `peak |bank| ${m.maxBank.toFixed(1)} deg`);
    rec(`${type}: (5) never touches the ground once airborne`,
      !m.touched,
      m.touched ? 'a wheel came back down mid-climb' : 'stayed airborne the whole hold');
  }

  /* ================================================================= */
  area = '3 NEGATIVE CONTROLS for the climb gate';
  /* ================================================================= */
  // (a) NO THROTTLE: the plane never builds speed and never leaves the runway,
  // so there is nothing for the climb gate to pass by accident.
  await boardAtRunway('plane');
  await pump(180);
  const idle = await holdFor([], 16, 2);
  const idleAlt = Math.max(0, ...idle.map((c) => c?.altitude ?? 0));
  const idleV = Math.max(0, ...idle.map((c) => c?.airspeed ?? 0));
  const idleLast = idle[idle.length - 1] ?? {};
  rec('NO THROTTLE — it never builds speed and never climbs',
    idleV < 3 && idleAlt < 0.6 && (idleLast.grounded ?? 0) >= 3,
    `peak airspeed ${idleV.toFixed(2)} m/s, peak altitude ${idleAlt.toFixed(2)} m, ${idleLast.grounded} wheels down`);

  // (b) AIRSPEED PROTECTION DISABLED (`debugNoSpeedProtect`, mirrors
  // debugFlipPitch): the SAME 20 s SHIFT + S hold, on the SAME Skylark, with the
  // fix switched off in the LIVE model, MUST go RED — it is exactly the broken
  // flight the old gate green-lit. We assert the five-way climb predicate FAILS
  // and name which failure fired, which is what proves the checks above catch
  // the failure the prior gate missed and are not merely agreeing with the code.
  const bad = await climbRun('plane', { noProtect: true });
  if (bad.err) {
    rec('NEG CONTROL — protection-off climb', false, bad.err);
  } else {
    const bm = climbMetrics(bad);
    const vfloor = bad.vref * 1.1;
    const stalled = bm.minAs <= vfloor;
    const porpoised = !bm.held;
    const overTop = bm.maxAbsPitch >= 33 || bm.maxBank >= 20;
    const goesRed = stalled || porpoised || overTop || bm.touched;
    const why = [stalled && `stall (min ${bm.minAs.toFixed(1)} <= ${vfloor.toFixed(1)})`,
      porpoised && `porpoise (final ${bm.finalAlt.toFixed(0)} vs peak ${bm.peakAlt.toFixed(0)})`,
      overTop && `over-the-top (|pitch| ${bm.maxAbsPitch.toFixed(0)}, |bank| ${bm.maxBank.toFixed(0)})`,
      bm.touched && 'flew into the ground'].filter(Boolean).join(' + ');
    rec('DISABLE the airspeed protection — the same hold goes RED (proves the gate)',
      goesRed, goesRed ? `RED as required: ${why}` : `stayed green with protection off (min ${bm.minAs.toFixed(1)}, peak ${bm.peakAlt.toFixed(0)}, final ${bm.finalAlt.toFixed(0)})`);
  }

  /* ================================================================= */
  area = '4 NON-INVERSION — PITCH (S nose up, W nose down), + neg control';
  /* ================================================================= */
  // Board and get airborne with speed in hand for a clean, level-ish datum.
  await boardAtRunway('plane');
  await pump(180);
  await holdFor(['ShiftLeft'], 18, 6);           // airborne, ballooning gently
  const pBase = (await readPlane())?.pitch ?? 0;
  const pS = (await holdFor(['ShiftLeft', 'KeyS'], 1.6, 1.6))[0]?.pitch ?? 0;   // pull back
  const aftS = await readPlane();
  await holdFor(['ShiftLeft'], 1.5, 1.5);        // release, settle
  const pW = (await holdFor(['ShiftLeft', 'KeyW'], 2.2, 2.2))[0]?.pitch ?? 0;   // push
  rec('S (panel: "pull back — nose up") RAISES the nose and climbs',
    pS > pBase + 4 && (aftS?.altitude ?? 0) > 0,
    `pitch ${pBase.toFixed(1)} -> ${pS.toFixed(1)} deg on S, altitude ${(aftS?.altitude ?? 0).toFixed(1)} m`);
  rec('W (panel: "push — nose down") LOWERS the nose (opposite of S)',
    pW < pS - 4,
    `pitch ${pS.toFixed(1)} -> ${pW.toFixed(1)} deg on W`);

  // NEGATIVE CONTROL: flip the pitch sign in the live model. Now S must LOWER
  // the nose — the same assertion above must go red, which proves it measures
  // the emitted sign and is not decorative.
  await holdFor(['ShiftLeft'], 2, 2);
  const pBase2 = (await readPlane())?.pitch ?? 0;
  await setFlip(true, false);
  const pSflip = (await holdFor(['ShiftLeft', 'KeyS'], 1.6, 1.6))[0]?.pitch ?? 0;
  await setFlip(false, false);
  rec('NEG CONTROL — with debugFlipPitch, S now LOWERS the nose (would go red)',
    pSflip < pBase2 - 3,
    `flipped: pitch ${pBase2.toFixed(1)} -> ${pSflip.toFixed(1)} deg on S`);

  /* ================================================================= */
  area = '5 NON-INVERSION — ROLL (D right, A left) + heading + neg control';
  /* ================================================================= */
  await boardAtRunway('plane');
  await pump(180);
  await holdFor(['ShiftLeft'], 18, 6);           // airborne
  const hD0 = (await readPlane())?.heading ?? 0;
  const dS = (await holdFor(['ShiftLeft', 'KeyD'], 1.3, 1.3))[0];   // D = roll right
  const bankD = dS?.bank ?? 0;
  let dHD = (dS?.heading ?? 0) - hD0; if (dHD > 180) dHD -= 360; else if (dHD < -180) dHD += 360;
  const slipD = dS?.sideslip ?? 0;
  await holdFor(['ShiftLeft'], 2, 2);            // wings level again
  const hA0 = (await readPlane())?.heading ?? 0;
  const aS = (await holdFor(['ShiftLeft', 'KeyA'], 1.3, 1.3))[0];   // A = roll left
  const bankA = aS?.bank ?? 0;
  let dHA = (aS?.heading ?? 0) - hA0; if (dHA > 180) dHA -= 360; else if (dHA < -180) dHA += 360;

  // THE PLAYER-SIDE SWAP (plane.js `if (v.autoReverse) ail = -ail`). The player
  // reported the roll as inverted and wants D to bank the SAME way the heli does
  // (D = left). So for a HUMAN pilot D now drops the LEFT wing and swings the
  // heading LEFT; A mirrors it. Convention: right wing drops => bank < 0, left
  // wing drops => bank > 0 (see plane.js / flightprobe).
  rec('D (panel: roll) drops the LEFT wing and swings the heading left (the swapped, un-inverted direction)',
    bankD > 10 && dHD < -3,
    `bank ${bankD.toFixed(1)} deg, heading ${dHD > 0 ? '+' : ''}${dHD.toFixed(1)} deg`);
  rec('A drops the RIGHT wing and swings the heading right (opposite of D)',
    bankA < -10 && dHA > 3,
    `bank ${bankA.toFixed(1)} deg, heading ${dHA.toFixed(1)} deg`);
  rec('the banked turn stays coordinated (sideslip bounded, not reversed)',
    Math.abs(slipD) < 25,
    `sideslip ${slipD.toFixed(1)} deg during the left turn`);

  // NEGATIVE CONTROL: flip the roll sign on the LIVE plane. With debugFlipRoll
  // in, D must go back to dropping the RIGHT wing — the same assertion above must
  // turn red, which proves it measures the emitted sign and is not decorative.
  await holdFor(['ShiftLeft'], 2.5, 2.5);
  await setFlip(false, true);
  const dFlip = (await holdFor(['ShiftLeft', 'KeyD'], 1.3, 1.3))[0];
  await setFlip(false, false);
  rec('NEG CONTROL — with debugFlipRoll, D drops the RIGHT wing again (would go red)',
    (dFlip?.bank ?? 0) < -8,
    `flipped: bank ${(dFlip?.bank ?? 0).toFixed(1)} deg on D`);

  // AND: the swap is scoped to the LOCAL PLAYER (the DRIVER), not to
  // `autoReverse` — jetchase's interceptors set `autoReverse = true` too, so
  // keying off it would invert their roll and fly them off the chase. Proven on
  // the EMITTED aileron (plane.js publishes `v._ailOut`, the aileron actually
  // flown after the swap) through the REAL model. Hold D and read what the plane
  // flies as a PLAYER (driver.isPlayer); then swap the DRIVER to a jetchase-shaped
  // NPC pilot (`{ npc:true, pilot:true }`) on the same live, still-flying model
  // — the exact interceptor condition — keep D held, step, and read again. The
  // player path must be SWAPPED (ail same sign as control.steer, D rolls left);
  // the AI path must be UNCHANGED (ail = -control.steer, the old sign) even though
  // autoReverse is identical — so airbaseprobe's AI jet is byte-identical.
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyD');
  await pump(48);
  const plEmit = await run(`
    const pl = window.__PLANE__; const d = pl && pl.driver;
    return pl ? { isPlayer: d === 'player' || d?.isPlayer === true, cs: +(pl.control.steer ?? 0).toFixed(3), ail: +(pl._ailOut ?? 0).toFixed(3) } : null;`);
  // Swap the driver to the AI condition on the same live plane; keep it flying.
  await run(`const v = window.__PLANE__; v.__savedDriver = v.driver; v.driver = { npc: true, pilot: true }; return true;`);
  await pump(40);
  const aiEmit = await run(`
    const pl = window.__PLANE__; const d = pl && pl.driver;
    return pl ? { isPlayer: d === 'player' || d?.isPlayer === true, cs: +(pl.control.steer ?? 0).toFixed(3), ail: +(pl._ailOut ?? 0).toFixed(3) } : null;`);
  await run(`const v = window.__PLANE__; v.driver = v.__savedDriver; delete v.__savedDriver; return true;`);   // restore the player
  await page.keyboard.up('KeyD');
  await page.keyboard.up('ShiftLeft');
  await pump(6);
  // Player under D: swapped -> ail SAME sign as control.steer, and D rolls left.
  const plSwapped = plEmit && plEmit.isPlayer === true && Math.abs(plEmit.cs) > 0.05 &&
    Math.sign(plEmit.ail) === Math.sign(plEmit.cs) && plEmit.ail < 0;
  // AI (npc driver, autoReverse still true) under the same D: unswapped -> ail
  // OPPOSITE sign to control.steer — byte-identical to the pre-swap AI.
  const aiUnswapped = aiEmit && aiEmit.isPlayer === false && Math.abs(aiEmit.cs) > 0.05 &&
    Math.sign(aiEmit.ail) === -Math.sign(aiEmit.cs);
  rec('AI SCOPING — emitted aileron: the local PLAYER is swapped, a jetchase-shaped NPC pilot is NOT (airbaseprobe untouched)',
    plSwapped && aiUnswapped,
    `player D: control.steer ${plEmit?.cs} -> ail ${plEmit?.ail} (swapped, rolls left); npc pilot same D: control.steer ${aiEmit?.cs} -> ail ${aiEmit?.ail} (old sign, unswapped)`);

  /* ================================================================= */
  area = '6 NON-INVERSION — nosewheel steering on the ground';
  /* ================================================================= */
  await boardAtRunway('plane');
  await pump(180);
  // A slow taxi where the plane stays firmly on all three wheels: brief throttle
  // to get it creeping, then steer. After the PLAYER roll swap, D swings the nose
  // to the LEFT (heading decreases) — matching the in-air bank direction, so
  // ground and air agree on which way D turns the aircraft. Sampled repeatedly
  // and read on the last GROUNDED sample, so a bump that skips a wheel does not
  // decide the axis.
  await page.keyboard.down('ShiftLeft');
  await pump(90);                                    // ~1.5 s: a slow taxi
  await page.keyboard.up('ShiftLeft');
  const gBase = await readPlane();
  await page.keyboard.down('KeyD');
  const gsamp = [];
  for (let i = 0; i < 4; i++) { await pump(30); gsamp.push(await readPlane()); }
  await page.keyboard.up('KeyD');
  await pump(6);
  const grounded = gsamp.filter((s) => s && s.grounded >= 3);
  const useD = grounded.length ? grounded[grounded.length - 1] : gsamp[gsamp.length - 1];
  let dGD = (useD?.heading ?? 0) - (gBase?.heading ?? 0); if (dGD > 180) dGD -= 360; else if (dGD < -180) dGD += 360;
  rec('on the ground D steers the nosewheel left (heading swings left, matching the swapped bank)',
    grounded.length >= 2 && dGD < -1.5,
    `heading ${dGD > 0 ? '+' : ''}${dGD.toFixed(1)} deg on D over ${grounded.length}/4 grounded samples`);

  // Park it. Every airplane's take-off-and-climb is gated in depth in area 2.
  await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (window.__PLANE__) { try { veh.despawn(window.__PLANE__); } catch(e){} }
    return true;`);
  await pump(20);

  /* ================================================================= */
  area = '6b EXHAUST FLAME — the plume scales with the throttle';
  /* ================================================================= */
  // The player asked for "fire coming out of the jet when the throttle is on so
  // the user can tell if they need more throttle". Assert on the EMITTED flame
  // node (plane.js's `_exhaust` child mesh + published `exhaustLen`): unlit at
  // idle, clearly longer at full throttle, longer still with the jet's
  // afterburner. NEGATIVE CONTROL: at zero throttle it is not lit.
  await boardAtRunway('plane');
  await pump(180);                                   // engine spools up
  const flIdle = await readFlame();
  rec('the plane builds a flame node parented to the body',
    !!flIdle && flIdle.hasNode,
    flIdle ? `node ${flIdle.hasNode}` : 'no flame reader');
  rec('NEG CONTROL — at idle throttle the flame is unlit (~0 length, node hidden)',
    flIdle && flIdle.lit === 0 && flIdle.scaleZ < 0.1 && !flIdle.visible,
    flIdle ? `lit ${flIdle.lit}, scaleZ ${flIdle.scaleZ}, visible ${flIdle.visible}, lever ${flIdle.lever}` : 'null');
  // Wind the throttle up on SHIFT and read the plume again.
  await page.keyboard.down('ShiftLeft');
  await pump(150);                                   // ~2.5 s: lever winds up
  const flFull = await readFlame();
  await page.keyboard.up('ShiftLeft');
  rec('full throttle: the flame lights and is clearly longer than idle',
    flFull && flFull.visible && flFull.scaleZ > 0.4 && flFull.len > flIdle.len + 0.4,
    flFull ? `idle len ${flIdle.len} -> full len ${flFull.len} (scaleZ ${flFull.scaleZ}, lever ${flFull.lever})` : 'null');
  // Wind it back to idle (SPACE) and confirm it unlights again.
  await page.keyboard.down('Space');
  await pump(180);
  await page.keyboard.up('Space');
  const flBack = await readFlame();
  rec('winding the throttle back to idle unlights the flame again',
    flBack && flBack.lit === 0 && !flBack.visible,
    flBack ? `back to lever ${flBack.lever}, lit ${flBack.lit}, visible ${flBack.visible}` : 'null');
  await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (window.__PLANE__) { try { veh.despawn(window.__PLANE__); } catch(e){} }
    return true;`);
  await pump(20);

  // THE JET — the afterburner plume is longer and brighter still. Board the jet,
  // hold SHIFT to firewall the lever, and let the burner light; sample the flame
  // when it is dry (partial) and again once the afterburner is up.
  await boardAtRunway('jet');
  await pump(150);
  await page.keyboard.down('ShiftLeft');
  let jetDry = null;
  let jetAb = null;
  for (let i = 0; i < 60; i++) {
    await pump(20);
    const f = await readFlame();
    if (f && f.lever > 0.4 && f.ab < 0.2 && !jetDry) jetDry = f;
    if (f && f.ab > 0.6) { jetAb = f; break; }
  }
  await page.keyboard.up('ShiftLeft');
  rec('the jet lights its afterburner and the plume grows longest + brightest',
    jetAb && jetAb.visible && jetAb.ab > 0.6 && jetAb.scaleZ > 3 &&
      (!jetDry || jetAb.len > jetDry.len) && jetAb.len > (flFull?.len ?? 0),
    jetAb ? `afterburner len ${jetAb.len} (dry ${jetDry ? jetDry.len : 'n/a'}, prop full ${flFull?.len}), ab ${jetAb.ab}, scaleZ ${jetAb.scaleZ}` : 'afterburner never lit');
  await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (window.__PLANE__) { try { veh.despawn(window.__PLANE__); } catch(e){} }
    return true;`);
  await pump(20);

  /* ================================================================= */
  area = '6c GROUND REVERSE TAXI — back off a wall, never in the air';
  /* ================================================================= */
  // A plane has no reverse gear; nosing into a wall trapped it. plane.js now
  // drives a small bounded aft ground speed while a pilot holds SPACE on the
  // ground with the lever closed. Assert the EMITTED position moves AFT (along
  // -nose) and the aft speed stays bounded; and the AIRBORNE negative control:
  // the same key never produces a reverse in the air.
  await boardAtRunway('plane');
  await pump(200);                                   // settle firmly on the gear
  const p0 = await readPos();
  await page.keyboard.down('Space');
  const revSamples = [];
  for (let i = 0; i < 8; i++) { await pump(30); revSamples.push(await readPos()); }
  await page.keyboard.up('Space');
  const p1 = revSamples[revSamples.length - 1];
  const dx = (p1?.x ?? 0) - (p0?.x ?? 0);
  const dz = (p1?.z ?? 0) - (p0?.z ?? 0);
  // Displacement along the nose axis: + is forward, - is aft (backed up).
  const alongDisp = dx * (p0?.fwdx ?? 0) + dz * (p0?.fwdz ?? 0);
  const maxAftSpeed = Math.max(0, ...revSamples.map((s) => -Math.min(0, s?.fwdSpeed ?? 0)));
  rec('grounded + SPACE: the plane moves BACKWARD (emitted position moves aft)',
    alongDisp < -0.5 && (p1?.grounded ?? 0) > 0,
    `along-nose displacement ${alongDisp.toFixed(2)} m (negative = aft), ${p1?.grounded} wheels down`);
  rec('the reverse taxi self-limits to a slow pushback speed (bounded)',
    maxAftSpeed > 0.2 && maxAftSpeed < 3.6,
    `peak aft speed ${maxAftSpeed.toFixed(2)} m/s (cap ~2.6)`);
  await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (window.__PLANE__) { try { veh.despawn(window.__PLANE__); } catch(e){} }
    return true;`);
  await pump(20);

  // AIRBORNE NEGATIVE CONTROL: get airborne, then hold SPACE (the reverse key)
  // WITH shift to stay flying, and confirm the body never drives aft.
  await boardAtRunway('plane');
  await pump(180);
  await page.keyboard.down('ShiftLeft');
  let airborne = null;
  for (let i = 0; i < 50; i++) {
    await pump(30);
    const s = await readPos();
    if (s && s.grounded === 0 && s.alt > 4) { airborne = s; break; }
  }
  await page.keyboard.down('Space');                 // the reverse key, in the air
  const airSamples = [];
  for (let i = 0; i < 8; i++) { await pump(30); airSamples.push(await readPos()); }
  await page.keyboard.up('Space');
  await page.keyboard.up('ShiftLeft');
  const airborneAll = airSamples.length > 0 && airSamples.every((s) => s && s.grounded === 0);
  const minFwd = airSamples.length ? Math.min(...airSamples.map((s) => s?.fwdSpeed ?? 0)) : -99;
  rec('airborne + SPACE never produces a reverse (no aft ground drive in the air)',
    !!airborne && airborneAll && minFwd > -0.2,
    airborne ? `airborne throughout ${airborneAll}, min body-forward speed ${minFwd.toFixed(2)} m/s` : 'never got airborne');
  await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (window.__PLANE__) { try { veh.despawn(window.__PLANE__); } catch(e){} }
    return true;`);
  await pump(20);

  /* ================================================================= */
  area = '7 THE ROSTER — the cheat menu enumerates every flyable + the tank';
  /* ================================================================= */
  // Rule 12: read the RENDERED spawn rows out of the live document, not the
  // source table. Open the cheat menu on its spawn tab and harvest the rows.
  const roster = await page.evaluate(() => {
    const ui = window.__ENGINE__.ctx.peek('ui');
    if (!ui?.cheats) return { err: 'no cheat menu (cheats=1 not honoured)' };
    ui.cheats.show();
    ui.cheats.setTab('spawn');
    const rows = [];
    for (const r of document.querySelectorAll('.ow-cheat-row')) {
      const sub = r.querySelector('.sub')?.textContent?.trim() ?? '';
      const tag = r.querySelector('.name .tag')?.textContent?.trim() ?? '';
      const id = sub.split('·')[0]?.trim() ?? '';
      if (id) rows.push({ id, kind: (sub.split('·')[1] ?? '').trim(), tag });
    }
    return { rows };
  });
  if (roster.err) {
    rec('the cheat menu is present and enumerates spawn rows', false, roster.err);
  } else {
    const ids = new Set(roster.rows.map((r) => r.id));
    const want = ['heli', 'newsheli', 'plane', 'sportplane', 'bushplane', 'twinplane', 'jet', 'tank'];
    for (const id of want) {
      rec(`the cheat menu lists a SPAWN row for '${id}'`,
        ids.has(id), ids.has(id) ? `present` : `missing — rows: ${[...ids].join(',')}`);
    }
    rec('NEGATIVE CONTROL — a class not in the fleet is absent from the menu',
      !ids.has('gunship') && !ids.has('nonesuch'),
      `bogus ids absent (roster has ${ids.size} classes)`);

    // Spawn each flyable/military class through the real cheat action and
    // confirm a live vehicle of the right kind appears.
    for (const id of ['plane', 'sportplane', 'bushplane', 'twinplane', 'jet', 'heli', 'newsheli', 'tank']) {
      const got = await page.evaluate((cls) => {
        const ctx = window.__ENGINE__.ctx;
        const ui = ctx.peek('ui');
        const veh = ctx.peek('vehicles');
        const before = veh.vehicles.length;
        let msg = '';
        try { msg = ui.cheats._spawnVehicle(cls, false); } catch (e) { msg = 'threw: ' + e.message; }
        const live = veh.vehicles.filter((v) => v.spec?.id === cls && !v.destroyed);
        return { ok: veh.vehicles.length > before && live.length > 0, kind: live[0]?.spec?.kind ?? null, msg: String(msg).slice(0, 60) };
      }, id);
      const expectKind = id === 'heli' || id === 'newsheli' ? 'heli' : id === 'tank' ? 'tank' : 'plane';
      rec(`spawning '${id}' from the cheat action yields a live ${expectKind}`,
        got.ok && got.kind === expectKind,
        `kind ${got.kind}, "${got.msg}"`);
    }
    await page.evaluate(() => {
      const ui = window.__ENGINE__.ctx.peek('ui');
      try { ui.cheats._clearSpawned?.(); } catch (e) {}
      ui.cheats.hide();
    });
    await pump(10);
  }

  /* ================================================================= */
  area = '8 the pause screen NAMES the aircraft controls (emitted DOM)';
  /* ================================================================= */
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
  const air = findGroup(/AIRPLANE|PLANE|AIRCRAFT/);
  const heli = findGroup(/HELICOPTER|HELI/);
  rec('an AIRPLANE control set is rendered on the pause screen',
    !!air, air ? `"${air.title}" with ${air.rows.length} rows` : `groups: ${panel.groups.map((g) => g.title).join(', ')}`);
  const throttleRow = air?.rows.find((r) => r.keys.includes('SHIFT') && /THROTTLE|POWER|SPEED/.test(r.action.toUpperCase()));
  rec('the AIRPLANE set names SHIFT as the throttle (not "climb")',
    !!throttleRow, throttleRow ? `SHIFT -> "${throttleRow.action}"` : `SHIFT rows: ${(air?.rows ?? []).filter((r) => r.keys.includes('SHIFT')).map((r) => r.action).join(' | ') || 'none'}`);
  const pullRow = air?.rows.find((r) => r.keys.includes('S') && /UP|PULL|TAKE|NOSE/.test(r.action.toUpperCase()));
  rec('the AIRPLANE set names S as pull-back / nose-up (how it rotates)',
    !!pullRow, pullRow ? `S -> "${pullRow.action}"` : `S rows: ${(air?.rows ?? []).filter((r) => r.keys.includes('S')).map((r) => r.action).join(' | ') || 'none'}`);
  const pushRow = air?.rows.find((r) => r.keys.includes('W') && /DOWN|PUSH|NOSE/.test(r.action.toUpperCase()));
  rec('the AIRPLANE set names W as push / nose-down (the opposite of S)',
    !!pushRow, pushRow ? `W -> "${pushRow.action}"` : `W rows: ${(air?.rows ?? []).filter((r) => r.keys.includes('W')).map((r) => r.action).join(' | ') || 'none'}`);
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
