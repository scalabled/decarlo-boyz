#!/usr/bin/env node
/**
 * STOLEN CRUISER — can you escape in a car the police still own?
 *
 *   node src/police/stolenprobe.mjs
 *   node src/police/stolenprobe.mjs --seconds=32 --keep
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS EXISTS TO CATCH
 *
 * `police/index.js` subscribed to eight events and NOT to `vehicle:enter`, so
 * commandeering a cruiser left the `Unit` bound to the car the player was now
 * driving. `_sight()` then did
 *
 *     u.los = this.rayVisible(u.vehicle.position, q.position, 1.0)
 *
 * with both arguments the SAME Vector3: d = 0, the rear-arc test skipped, and
 * an occlusion ray cast from a point to itself. `seen` was pinned true for the
 * rest of the session, so `sinceSeen` and `evade` never left zero and the star
 * could never fall. Fresh cruisers kept arriving on top of the player because
 * the search anchor tracked him exactly.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT ASSERTS WHAT IT ASSERTS  (ARCHITECTURE.md rule 12)
 *
 * It would be worthless to ask `police` whether it thinks it released the unit
 * — that is the implementation reporting on itself. So the setup goes through
 * the REAL prompt (`game.getAction()` must say `commandeer`, `game.doAction()`
 * performs it, `player.vehicles` runs the real entry animation), the getaway
 * goes through the REAL driving path (`movement.scriptedInput`), and every
 * assertion is an EMITTED result the player can see:
 *
 *   · the star count read off the HUD's own SVG, `.ow-wanted path.fill`
 *     opacity — the pixels, not `police.wanted`;
 *   · the `wanted:change` events actually published on the bus;
 *   · the distance to the nearest police car that EXISTS in `vehicles.vehicles`
 *     — "are fresh cruisers landing on top of me", measured off the world, not
 *     off `police.units`;
 *   · whether the car the player is sitting in is still in the world at all
 *     (`retireUnit`'s 'far' path despawns with no player guard).
 *
 * `police.sample()` is printed as diagnosis so a failure names the cause, but
 * NOTHING is gated on it.
 *
 * Exit code is the number of failed checks.
 */

import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const SECONDS = Number(args.seconds ?? 32);
const HZ = 5;
const KEEP = !!args.keep;
/** Star level to stage the theft at. evadeNeed[3] = 20 s, [2] = 15 s. */
const LEVEL = 2;

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 240)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 240)); });

let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  — ${detail}` : ''}`);
};

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

/** Run a body with engine/ctx/game/player/police/veh in scope. */
const run = (body) =>
  page.evaluate(`(() => {
    const engine = window.__ENGINE__;
    const ctx = engine.ctx;
    const game = ctx.peek('game');
    const player = ctx.peek('player');
    const police = ctx.peek('police');
    const veh = ctx.peek('vehicles');
    ${body}
  })()`);

/**
 * THE STARS THE PLAYER ACTUALLY SEES. `WantedStars.update` writes an inline
 * opacity onto each `path.fill`: damped to 1 when lit, to 0 when not, with a
 * 0.45 floor while the top star flickers. Read the DOM, not the model.
 */
const HUD_STARS = `
  const gs = document.querySelectorAll('.ow-wanted .ow-stars g');
  let lit = 0;
  for (const g of gs) {
    const f = g.querySelector('path.fill');
    if (!f) continue;
    if (parseFloat(getComputedStyle(f).opacity || '0') > 0.4) lit++;
  }`;

const hudStars = () => run(`${HUD_STARS}
  return lit;`);

try {
  /* `capture=1` fixes the engine seed and pins the timestep to 1/60 — see the
   * long note in harness.mjs. Without it this file measures a different city
   * every run. */
  await page.goto(`http://127.0.0.1:${port}/?q=high&capture=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 90000 });
  await pump(150);

  /* ================================================================== */
  /* STAGE — a real dispatched cruiser, parked, with the player at its   */
  /* door. Everything here is SETUP; nothing is asserted off it.         */
  /* ================================================================== */
  /**
   * Stand the theft somewhere EMPTY — off the road graph, clear of shops and
   * of the pedestrian stream. The first draft staged it where the player
   * happened to be standing, and pinning a 1.5-tonne cruiser 3 m away for
   * forty frames mowed down the pavement: `woundPed`/`killPed` walked the meter
   * from two stars to five before the theft even happened, and "taking a
   * cruiser costs a star" cannot be read off a meter that is already pinned.
   */
  const spot = await run(`
    const w = ctx.peek('world');
    const far = (x, z) => {
      const all = [...game.shops, ...game.gasStations, ...game.safehouses];
      for (const p of all) if (Math.hypot(p.x - x, p.z - z) < 60) return false;
      const e = w && w.roads && w.roads.nearestEdge ? w.roads.nearestEdge(x, z, 200) : null;
      if (e && e.edge && e.dist <= 45) return false;
      return w && w.surfaceAt ? w.surfaceAt(x, z) === 'grass' : true;
    };
    for (let i = 0; i < 300; i++) {
      const s = game.wq.findGroundSpot(150, 1100, 0, 0);
      if (s.ok && far(s.x, s.z)) { window.__SPOT__ = { x: s.x, z: s.z }; return window.__SPOT__; }
    }
    return null;`);
  if (!spot) throw new Error('no clear staging spot found');

  await run(`
    engine.input.frozen = true;
    window.__WCH__ = [];
    ctx.events.on('wanted:change', (e) => window.__WCH__.push({ level: e.level, prev: e.prev }));
    return true;`);

  /**
   * Hold the target cruiser still while the player walks to the door: the Unit
   * is still driving it and the entry animation takes ~1.5 s. Foot cops are
   * cleared each pass — a cruiser parked next to a player ON FOOT is exactly
   * the `_deployOfficers` standoff, and an arrest mid-stage would call
   * `clearWanted` and quietly turn the whole run into a test of a zero-star
   * drive.
   */
  const pin = async (frames) => {
    for (let i = 0; i < frames; i += 3) {
      await run(`
        const v = window.__STOLEN__, k = window.__PARK__;
        police.officers.clear();
        if (v && k && !window.__TOOK__) { v.setPose({ x: k.x, y: k.y, z: k.z }, k.yaw); v.velocity.set(0, 0, 0); }
        return true;`);
      await pump(3);
    }
  };

  /**
   * Stage and perform one theft at `level`, entirely through the shipped path:
   * the dispatcher puts a cruiser on the street, it is parked at the player's
   * door, and the car is taken with `game.doAction()` off `game.getAction()`.
   * Returns the prompt, what F did, and the HUD star count either side.
   */
  const theft = async (level) => {
    await run(`
      const s = window.__SPOT__;
      window.__TOOK__ = 0;
      if (player.inVehicle) player.vehicles.abort(player.movement);
      game.wq.placePlayer(s.x, s.z, 0);
      police.setWanted(${level});
      return true;`);
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await pump(30);
      up = await run('return police.units.some((u) => u.active && !!u.vehicle);');
    }
    if (!up) return { dispatched: false };

    await run(`
      const u = police.units.find((x) => x.active && x.vehicle);
      const v = u.vehicle;
      const p = player.position;
      const y = police.groundAt(p.x + 3.2, p.z, p.y + 20) + (v.spec && v.spec.comY ? v.spec.comY : 0.5) + 0.05;
      v.setPose({ x: p.x + 3.2, y, z: p.z }, Math.PI * 0.5);
      v.velocity.set(0, 0, 0);
      for (const o of veh.vehicles.slice()) {
        if (o !== v && Math.hypot(o.position.x - p.x, o.position.z - p.z) < 45) veh.despawn(o);
      }
      window.__STOLEN__ = v;
      window.__PARK__ = { x: v.position.x, y: v.position.y, z: v.position.z, yaw: Math.PI * 0.5 };
      return true;`);
    await pin(24);

    // Normalise the meter immediately before the door, so the star the theft is
    // worth is read against a known baseline rather than against whatever the
    // staging happened to leave behind.
    await run(`police.setWanted(${level}); return true;`);
    await pump(24);
    const offer = await run(`
      const a = game.getAction();
      const root = document.querySelector('.ow-prompt');
      return { id: a.id, mine: a.target === window.__STOLEN__,
               text: root && getComputedStyle(root).display !== 'none'
                 ? (root.querySelector('.ow-prompt-txt').textContent || '') : '' };`);
    const before = await hudStars();
    const did = await run('return game.doAction();');
    await pin(90);
    await run('window.__TOOK__ = 1; return true;');
    await pump(60);
    const took = await run(`
      return { inVehicle: !!player.inVehicle, stolen: player.vehicle === window.__STOLEN__,
               phase: player.vehicles.phase };`);
    const after = await hudStars();
    return { dispatched: true, offer, did, took, before, after };
  };

  /* ================================================================== */
  /* THEFT 1 — at two stars, the car this run escapes in                */
  /* ================================================================== */
  const t1 = await theft(LEVEL);
  check('a dispatched cruiser exists to steal', t1.dispatched, `staged at ${LEVEL}* near ${spot.x | 0}, ${spot.z | 0}`);
  if (!t1.dispatched) throw new Error('no cruiser was dispatched — cannot stage the theft');

  check('the cruiser reads as COMMANDEER and F takes it',
    t1.offer.id === 'commandeer' && t1.offer.mine && t1.did === 'commandeer' &&
    t1.took.inVehicle && t1.took.stolen,
    `prompt "${t1.offer.text}" (id ${t1.offer.id}, mine ${t1.offer.mine}) · doAction "${t1.did}" · ` +
    `${t1.took.inVehicle ? (t1.took.stolen ? 'in the cruiser' : 'in a DIFFERENT car') : 'on foot'} (${t1.took.phase})`);
  if (!t1.took.stolen) throw new Error('the theft did not happen — nothing below would mean anything');

  /* ================================================================== */
  /* THE GETAWAY — drive it, then break contact                         */
  /* ================================================================== */
  const drove = await run(`
    const v = window.__STOLEN__;
    window.__FROM__ = { x: v.position.x, z: v.position.z };
    player.movement.scriptedInput = { x: 0, y: 1 };
    return true;`);
  void drove;
  await pump(200);
  const driven = await run(`
    const v = window.__STOLEN__, f = window.__FROM__;
    player.movement.scriptedInput = null;
    return { m: +Math.hypot(v.position.x - f.x, v.position.z - f.z).toFixed(1),
             mine: player.vehicle === v };`);
  check('the player really drives the stolen cruiser', driven.mine && driven.m > 12,
    `${driven.m} m under throttle in ~3.3 s`);

  /**
   * Break contact. Every other cruiser is retired first so the ONLY thing that
   * could still have eyes on the player is the unit bound to the car he is
   * sitting in — which is the defect under test. Then jump ~1 km, exactly as
   * `harness.mjs`'s evasion phase does.
   */
  const jump = await run(`
    const v = window.__STOLEN__;
    for (const u of police.units.slice()) if (u.vehicle !== v) police.retireUnit(u, 'far');
    police.officers.clear();
    police.heli.stand(ctx);
    let s = null;
    for (const r of [[900, 1400], [600, 1800], [400, 2400]]) {
      s = police.roads.sampleSpawn(police.rng, v.position, r[0], r[1], (e) => !e.rail);
      if (s) break;
    }
    if (!s) return { ok: false, reason: 'no pose' };
    // Only demotions published FROM HERE ON count — staging moved the meter.
    window.__WCH__.length = 0;
    const from = { x: v.position.x, z: v.position.z };
    v.setPose({ x: s.position.x, y: police.groundAt(s.position.x, s.position.z, s.position.y + 20) + 0.6, z: s.position.z }, s.yaw);
    v.velocity.set(0, 0, 0);
    return { ok: true, dist: +Math.hypot(s.position.x - from.x, s.position.z - from.z).toFixed(0),
             fromAnchor: +Math.hypot(s.position.x - police.searchCentre.x, s.position.z - police.searchCentre.z).toFixed(0),
             units: police.units.length };`);
  check('the getaway actually happened', jump.ok && jump.dist > 350,
    jump.ok ? `${jump.dist} m, ${jump.fromAnchor} m from the search anchor` : `FAILED: ${jump.reason}`);

  /* ================================================================== */
  /* MEASURE                                                            */
  /* ================================================================== */
  const trace = [];
  const N = Math.round(SECONDS * HZ);
  for (let i = 0; i < N; i++) {
    trace.push(await run(`${HUD_STARS}
      const v = window.__STOLEN__;
      const p = v.position;
      let near = Infinity;
      for (const o of veh.vehicles) {
        if (o === v || o.destroyed) continue;
        const id = String((o.spec && o.spec.id) || o.type || '');
        if (id !== 'police') continue;
        near = Math.min(near, Math.hypot(o.position.x - p.x, o.position.z - p.z));
      }
      const s = police.sample();
      return {
        t: +engine.time.elapsed.toFixed(2), stars: lit,
        alive: veh.vehicles.indexOf(v) >= 0 && !v.destroyed,
        aboard: player.vehicle === v,
        nearCop: Number.isFinite(near) ? +near.toFixed(0) : -1,
        seen: s.seen, seenBy: s.seenBy, sinceSeen: s.sinceSeen, evade: s.evade,
        level: s.level, units: s.units.length,
      };`));
    await pump(Math.round(60 / HZ));
  }

  const first = trace[0];
  const last = trace[trace.length - 1];
  const tail = trace.slice(Math.floor(trace.length * 0.4));
  const changes = await run('return window.__WCH__.slice();');
  const droppedEvents = changes.filter((c) => c.level < c.prev);

  console.log(
    `\nescape trace (${SECONDS}s @ ${HZ}Hz) — first/last:\n` +
    `  t=${first.t} stars=${first.stars} seen=${first.seen} by="${first.seenBy}" ` +
    `sinceSeen=${first.sinceSeen} evade=${first.evade} units=${first.units} nearCop=${first.nearCop}m\n` +
    `  t=${last.t} stars=${last.stars} seen=${last.seen} by="${last.seenBy}" ` +
    `sinceSeen=${last.sinceSeen} evade=${last.evade} units=${last.units} nearCop=${last.nearCop}m\n` +
    `  peak evade ${Math.max(...trace.map((s) => s.evade)).toFixed(1)}s · ` +
    `seen in ${trace.filter((s) => s.seen).length}/${trace.length} samples · ` +
    `wanted:change [${changes.map((c) => `${c.prev}->${c.level}`).join(' ')}]\n`
  );

  /* ---- 1. THE STARS COME OFF. The HUD's own pixels. ----------------- */
  check('stars actually come off while you drive a stolen cruiser',
    last.stars < first.stars,
    `HUD ${first.stars}* -> ${last.stars}* over ${SECONDS}s out of contact`);

  /* ---- 2. ...and the bus says so. ---------------------------------- */
  check('a wanted:change demotion is published',
    droppedEvents.length > 0,
    droppedEvents.length
      ? droppedEvents.map((c) => `${c.prev}->${c.level}`).join(', ')
      : `no demotion in [${changes.map((c) => `${c.prev}->${c.level}`).join(' ')}]`);

  /* ---- 3. Fresh cruisers do not land on top of you. ------------------
   * RATCHET (rule 13). Broken build: the search anchor tracked the player
   * exactly, so the dispatcher put a replacement 90-260 m out and it closed
   * from there. Fixed: the anchor is frozen a kilometre back and the nearest
   * cruiser that EXISTS in the world stays out there with it. Lower this
   * number when the fix improves; never raise it. */
  const worstNear = Math.min(...tail.map((s) => (s.nearCop < 0 ? Infinity : s.nearCop)));
  check('no cruiser materialises on top of the escape',
    !Number.isFinite(worstNear) || worstNear > 300,
    Number.isFinite(worstNear) ? `nearest police car ${worstNear} m over the tail of the run`
      : 'no police car anywhere near');

  /* ---- 4. The car is not deleted out from under the player. --------- */
  check('the stolen cruiser survives the escape',
    last.alive && last.aboard,
    `${last.alive ? 'in the world' : 'DESPAWNED'} · ${last.aboard ? 'player aboard' : 'player NOT aboard'}`);

  /* ---- 5. retireUnit must never delete the player's car. -------------
   * The 'far' cull path calls `vehicles.despawn(v)`; only `dispatch._cull`'s
   * in-view test happened to stand between it and the car the player is
   * driving. Drive the path directly and look at the WORLD afterwards. */
  const guard = await run(`
    const v = player.vehicle;
    if (!v) return { ok: false, reason: 'player is not in a car' };
    const u = police.takeUnit();
    u.bind(v, 0);
    police.retireUnit(u, 'far');
    return { ok: true,
             alive: veh.vehicles.indexOf(v) >= 0,
             aboard: player.vehicle === v,
             bound: police.units.some((x) => x.vehicle === v) };`);
  check("retireUnit('far') never despawns the car the player is in",
    guard.ok && guard.alive && guard.aboard && !guard.bound,
    guard.ok ? `${guard.alive ? 'car survived' : 'CAR DESPAWNED'} · ${guard.aboard ? 'player aboard' : 'player ejected'}`
      : guard.reason);

  /* ---- 6. THE OTHER HALF: taking a cruiser is a star. ----
   * Releasing the unit and raising the wanted level are two halves of the same
   * rule, and this is the half the fleet bookkeeping above does not cover.
   *
   * STAGED AT FOUR STARS ON PURPOSE. `game`'s heat half prices the theft at
   * carjack x 2.2, and a cop standing at the door makes it witnessed, so it is
   * worth ~28.7 heat. Against STAR_HEAT that clears the next star at 1, 2 and 3
   * unaided — but four to five is a 31-heat step, so at four stars the heat
   * half alone CANNOT deliver the promotion and only an explicit +1 can. This
   * is the one staging where the check can tell the two apart.
   */
  const t2 = await theft(4);
  check('taking a cruiser costs a star even where heat alone cannot',
    t2.dispatched && t2.took.stolen && t2.after >= t2.before + 1,
    t2.dispatched
      ? `HUD ${t2.before}* -> ${t2.after}* on the door (${t2.took.stolen ? 'took it' : 'THEFT FAILED'})`
      : 'no cruiser dispatched');

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');
} catch (e) {
  console.error(`\nPROBE ERROR: ${e.message}`);
  fails++;
} finally {
  if (!(KEEP && fails)) await browser.close();
  server?.kill();
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : `${fails} FAILED`}`);
process.exit(fails);
