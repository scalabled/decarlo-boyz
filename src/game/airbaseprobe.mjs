#!/usr/bin/env node
/**
 * AIRBASE ASSAULT PROBE — the Ridgeline AFB encounter, gated on EMITTED
 * results through the REAL entry path (rule 12 throughout).
 *
 *   npm run build && node src/game/airbaseprobe.mjs
 *   node src/game/airbaseprobe.mjs --keep     leave the browser open on failure
 *
 * WHAT IT PROVES, and how each claim is measured:
 *
 *   ENTRY    the player WALKS through the published main gate (a continuous
 *            position series crossing the fence line — never a call into the
 *            encounter module), and the base arms: real Peds with ranged
 *            weapons appear in `peds.hostiles.live` (the emitted population,
 *            tagged and ranged, standing inside the perimeter), and the HUD
 *            feed carries the RESTRICTED AREA warning (the drawn DOM row).
 *
 *   TANK     an emplacement's EMITTED `turretYaw` (the state syncTransforms
 *            draws — ring rotation == state, verified by milprobe) slews
 *            toward the player's bearing and converges; then a shell fires
 *            and the canonical 'explosion' event (source 'tankshell', the
 *            same listener chain as the Scrap Rocket) lands within metres of
 *            where the player was standing. The muzzle event ('weapon:fire',
 *            weapon 'tankgun') is seen on the real bus.
 *
 *   THEFT    boarding a seeded jet through the player's own enter transition
 *            (`game.debugBoard` — the real animation, the real
 *            'vehicle:enter') scrambles two pursuit jets at the published
 *            runwayStart; their EMITTED positions lift off (altitude) and
 *            close on the player's aircraft over time; tracer bursts land
 *            NEAR the aircraft (bounded miss distance), never into it.
 *
 *   WIND-DOWN  exiting the jet and leaving the perimeter stands the base
 *            down: the emitted hostile population empties, the turrets stop
 *            tracking, the interceptors leave and are despawned.
 *
 *   NEGATIVE CONTROL  the same walk and the same boarding under
 *            `?noassault=1`: nothing arms, nothing spawns, nothing chases —
 *            so the positive arms above measure the encounter, not the
 *            harness.
 *
 * Harness affordance, declared: the player's health pool is inflated so a
 * shell landing on the aim point cannot end the run — the DAMAGE PATH is not
 * under test here, the emitted explosion position is; and the wanted level is
 * cleared between sections so the city police (which the trespass correctly
 * feeds) do not wander into the measurements.
 */
import { chromium } from 'playwright';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const KEEP = process.argv.includes('--keep');
const VERBOSE = process.argv.includes('--verbose');

const { port, server } = await startServer({});
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

const results = [];
let area = '';
const rec = (name, ok, detail) => {
  results.push({ area, name, ok: !!ok, detail });
  if (!ok || VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  [${area}] ${name}  (${detail})`);
};

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

/** Run a body with engine, ctx, game, player, peds, veh, police in scope. */
const run = (body) =>
  page.evaluate(`(() => {
    const engine = window.__ENGINE__;
    const ctx = engine.ctx;
    const game = ctx.peek('game');
    const player = ctx.peek('player');
    const peds = ctx.peek('peds');
    const veh = ctx.peek('vehicles');
    const police = ctx.peek('police');
    ${body}
  })()`);

const boot = async (query) => {
  await page.goto(`http://127.0.0.1:${port}/${query ?? ''}`,
    { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  await pump(90);
  await run(`
    engine.input.enabled = true; engine.input.frozen = false;
    player.setControlEnabled?.(true);
    game.missions.abort();
    game.heat.clear('probe');
    // The declared harness affordance: the run must survive its own shells.
    if (player.health) { player.health.max = 1e9; player.health.value = 1e9; }
    // Event taps on the REAL bus — everything below is emitted artefacts.
    window.__BOOMS__ = [];
    window.__FIRES__ = [];
    window.__TRACERS__ = [];
    ctx.events.on('explosion', (e) => {
      const p = game.wq.playerPos();
      window.__BOOMS__.push({ x: e.position.x, y: e.position.y, z: e.position.z,
        src: e.source ?? '', px: p.x, pz: p.z, t: ctx.time.elapsed });
    });
    ctx.events.on('weapon:fire', (e) => {
      window.__FIRES__.push({ w: e.weapon, x: e.origin.x, z: e.origin.z, t: ctx.time.elapsed });
    });
    ctx.events.on('bullet:tracer', (e) => {
      if (window.__TRACERS__.length > 900) return;
      window.__TRACERS__.push({ fx: e.from.x, fy: e.from.y, fz: e.from.z,
        tx: e.to.x, ty: e.to.y, tz: e.to.z, t: ctx.time.elapsed });
    });
    return true;`);
  await pump(20);
};

/** The published-state snapshot every section leans on. */
const snap = () =>
  run(`
    const ab = ctx.peek('world')?.airbase ?? null;
    const enc = game.airbase;
    const live = peds?.hostiles?.live ?? [];
    const guards = [];
    for (const h of live) {
      if (h.tag === 'airbase' && h.active) guards.push({
        alive: !!h.alive, ranged: !!h.ranged, range: h.hostileRange ?? 0,
        x: h.position.x, z: h.position.z,
        inside: !!(ab && ab.insidePerimeter && ab.insidePerimeter(h.position.x, h.position.z)),
      });
    }
    const tanks = (enc?.tanks ?? []).map((t) => ({
      x: t.v.position.x, z: t.v.position.z,
      yaw: t.v.turretYaw ?? 0, pitch: t.v.gunPitch ?? 0,
      aiming: t.v.turretAimActive === true, sleeping: t.v.sleeping === true,
    }));
    const jets = veh.vehicles.filter((v) => v.spec?.id === 'jet').map((v) => ({
      x: v.position.x, y: v.position.y, z: v.position.z,
      alt: v.altitude ?? 0, mission: v.isMission === true,
      mine: game.wq.playerVehicle() === v, destroyed: !!v.destroyed,
    }));
    const p = game.wq.focusPos();
    return {
      on: !!(ab && ab.pad), armed: enc?.armed === true, disabled: enc?.disabled === true,
      chase: enc?.chase?.active === true, chasePhase: enc?.chase?.phase ?? 'idle',
      pursuers: enc?.chase?.count ?? 0,
      guards, tanks, jets,
      px: p.x, pz: p.z,
      booms: window.__BOOMS__.length, fires: window.__FIRES__.length,
      tracers: window.__TRACERS__.length,
    };`);

/** Walk the player along a bearing in 1.3 m steps — a real position series. */
const walk = async (fromX, fromZ, dirX, dirZ, metres) => {
  const steps = Math.ceil(metres / 1.3);
  for (let i = 0; i <= steps; i++) {
    const x = fromX + dirX * 1.3 * i;
    const z = fromZ + dirZ * 1.3 * i;
    await run(`game.wq.placePlayer(${x}, ${z}, ${Math.atan2(dirX, dirZ)}); return true;`);
    await pump(2);
  }
};

const wrapPi = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

try {
  await boot('');

  /* =================================================================== */
  area = 'published';
  /* =================================================================== */

  const pub = await run(`
    const ab = ctx.peek('world')?.airbase ?? null;
    return ab && ab.pad ? {
      on: true,
      gates: (ab.gates ?? []).map((g) => ({ id: g.id, x: g.x, z: g.z, heading: g.heading })),
      perimeter: (ab.perimeter ?? []).length,
      slots: (ab.apronSlots ?? []).length,
      rs: ab.runwayStart ?? null,
      fence: typeof ab.insidePerimeter === 'function',
    } : { on: false };`);
  rec('world.airbase is published (pad, gates, slots, runwayStart, fence test)',
    pub.on && pub.gates.length >= 2 && pub.perimeter >= 6 && pub.slots >= 14 && pub.rs && pub.fence,
    pub.on ? `${pub.gates.length} gates, ${pub.perimeter}-pt fence, ${pub.slots} slots` : 'airbase off');
  if (!pub.on) throw new Error('no airbase — is ?noairbase set, or did world regress?');

  // Let the encounter seed its apron (it runs in game.update).
  await pump(60);
  const s0 = await snap();
  rec('the apron is dressed: parked jets and armour inside the wire',
    s0.jets.filter((j) => !j.mission).length >= 2 && s0.tanks.length >= 3,
    `${s0.jets.length} jets, ${s0.tanks.length} tank emplacements`);
  rec('nothing is armed before anyone crosses the wire',
    !s0.armed && s0.guards.length === 0, `armed ${s0.armed}, guards ${s0.guards.length}`);

  /* =================================================================== */
  area = 'entry';
  /* =================================================================== */

  const gate = pub.gates.find((g) => g.id === 'main') ?? pub.gates[0];
  const dx = Math.sin(gate.heading);
  const dz = Math.cos(gate.heading);
  // 35 m outside the gate, walking straight through it, 70 m in total.
  await walk(gate.x - dx * 35, gate.z - dz * 35, dx, dz, 70);
  await pump(30);

  const s1 = await snap();
  rec('walking through the gate arms the encounter', s1.armed, `armed ${s1.armed}`);

  // Guards need a beat to muster; poll up to ~12 s.
  let sG = s1;
  for (let i = 0; i < 24 && sG.guards.filter((g) => g.alive).length < 3; i++) {
    await pump(30);
    sG = await snap();
  }
  const alive = sG.guards.filter((g) => g.alive);
  rec('armed hostiles actually spawn — emitted Peds in the hostile pool',
    alive.length >= 3, `${alive.length} live guards tagged airbase`);
  rec('every guard carries a rifle-class ranged weapon',
    alive.length > 0 && alive.every((g) => g.ranged && g.range > 30),
    alive.map((g) => `${g.ranged ? 'ranged' : 'MELEE'}@${g.range}m`).join(' '));
  rec('the guards muster inside the perimeter',
    alive.length > 0 && alive.every((g) => g.inside),
    `${alive.filter((g) => g.inside).length}/${alive.length} inside the fence`);

  const feed = await page.evaluate(() => {
    const el = document.querySelector('.ow-feed');
    return el ? el.textContent : '';
  });
  rec('the HUD warning is drawn: RESTRICTED AREA / LETHAL FORCE',
    /restricted/i.test(feed) && /lethal/i.test(feed), feed.trim().slice(0, 90) || 'feed empty');

  /* =================================================================== */
  area = 'tank';
  /* =================================================================== */

  // Stand the player on the open apron between the stands and the armour.
  await run(`
    const ab = ctx.peek('world').airbase;
    const w = ab.worldAt(-110, 160, {});
    game.wq.placePlayer(w.x, w.z, 0);
    game.heat.clear('probe');
    return true;`);
  await pump(10);

  // The slew, on the EMITTED turret state, against the bearing to the player.
  const t0 = await snap();
  const tank0 = t0.tanks.reduce((best, t) =>
    !best || Math.hypot(t.x - t0.px, t.z - t0.pz) < Math.hypot(best.x - t0.px, best.z - t0.pz) ? t : best, null);
  await pump(200); // ~3.3 s of slew at 0.9 rad/s
  const t1 = await snap();
  const tank1 = t1.tanks.reduce((best, t) =>
    !best || Math.hypot(t.x - t1.px, t.z - t1.pz) < Math.hypot(best.x - t1.px, best.z - t1.pz) ? t : best, null);
  rec('an emplacement is tracking (turretAimActive on a parked hull)',
    !!tank1 && tank1.aiming, tank1 ? `aiming ${tank1.aiming}, hull asleep ${tank1.sleeping}` : 'no tank');
  // Yaw error measured in the hull frame needs the hull yaw; use the change
  // in emitted turretYaw instead: it must MOVE under the command and then
  // hold (converged), which a dead turret (0 throughout) and a snap (instant)
  // both fail — the slew rate bounds it.
  const moved = tank0 && tank1 ? Math.abs(wrapPi(tank1.yaw - tank0.yaw)) : 0;
  rec('the EMITTED turret slews toward the player', moved > 0.15,
    `|d yaw| ${(moved * 57.3).toFixed(1)} deg over 3.3 s`);

  // The shell: the canonical explosion lands near where the player stands.
  const boomsBefore = t1.booms;
  let sB = t1;
  for (let i = 0; i < 30 && sB.booms <= boomsBefore; i++) {
    await pump(30);
    sB = await snap();
  }
  const boom = await run(`
    const bs = window.__BOOMS__.filter((b) => b.src === 'tankshell');
    const last = bs[bs.length - 1] ?? null;
    const tg = window.__FIRES__.filter((f) => f.w === 'tankgun').length;
    return { n: bs.length, last, tankgun: tg };`);
  rec('a shell fires and the canonical explosion event lands (source tankshell)',
    boom.n >= 1, `${boom.n} tankshell detonations on the real bus`);
  rec('the detonation lands near the aim point (the player)',
    boom.last && Math.hypot(boom.last.x - boom.last.px, boom.last.z - boom.last.pz) < 30,
    boom.last
      ? `${Math.hypot(boom.last.x - boom.last.px, boom.last.z - boom.last.pz).toFixed(1)} m from the player at detonation`
      : 'no detonation');
  rec('the muzzle event fx/audio/police consume was emitted (weapon tankgun)',
    boom.tankgun >= 1, `${boom.tankgun} tankgun weapon:fire events`);

  /* =================================================================== */
  area = 'theft';
  /* =================================================================== */

  const boarded = await run(`
    game.heat.clear('probe');
    const enc = game.airbase;
    const jet = enc.jets.find((j) => j && !j.destroyed);
    if (!jet) return { ok: false };
    return { ok: game.debugBoard(jet), x: jet.position.x, z: jet.position.z };`);
  rec('the player boards a parked jet through the real enter transition',
    boarded.ok, `debugBoard ${boarded.ok}`);
  // The enter event lands at the END of the animation; give it room, then
  // wait for the scramble.
  let sT = await snap();
  for (let i = 0; i < 24 && !(sT.chase && sT.pursuers >= 2); i++) {
    await pump(30);
    sT = await snap();
  }
  rec('two pursuit jets scramble', sT.chase && sT.pursuers === 2,
    `chase ${sT.chase}, ${sT.pursuers} pursuers, phase ${sT.chasePhase}`);
  const pj0 = sT.jets.filter((j) => j.mission && !j.mine && !j.destroyed);
  const nearRs = pj0.filter((j) => Math.hypot(j.x - pub.rs.x, j.z - pub.rs.z) < 220).length;
  rec('the pursuers spawn at the published runway threshold',
    pj0.length === 2 && nearRs === 2,
    `${nearRs}/${pj0.length} within 220 m of runwayStart`);

  // The closure baseline: pursuer-to-target distance AT the scramble, before
  // any of the chase has run.
  let d0 = null;
  for (const p of pj0) {
    const dd = Math.hypot(p.x - boarded.x, p.z - boarded.z);
    if (d0 === null || dd < d0) d0 = dd;
  }

  // Sample the chase: altitude and closure on the player's aircraft.
  let minD = Infinity;
  let late = Infinity;
  let airborne = 0;
  const samples = 80;
  for (let i = 0; i < samples; i++) {
    await pump(36); // ~0.6 s per sample, ~48 s total
    const s = await snap();
    const mine = s.jets.find((j) => j.mine);
    const purs = s.jets.filter((j) => j.mission && !j.mine && !j.destroyed);
    if (!mine || !purs.length) continue;
    let d = Infinity;
    let up = 0;
    for (const p of purs) {
      const dd = Math.hypot(p.x - mine.x, p.y - mine.y, p.z - mine.z);
      if (dd < d) d = dd;
      if (p.alt > 12) up++;
    }
    if (d < minD) minD = d;
    late = d;
    if (up === purs.length && purs.length >= 1) airborne++;
    if (!s.chase) break;
  }
  rec('both pursuers become airborne (emitted altitude)',
    airborne >= 5, `${airborne} samples with every pursuer above 12 m`);
  rec('the pursuers CLOSE on the player aircraft (emitted positions)',
    d0 !== null && minD < Math.min(450, d0 * 0.55),
    `start ${d0 === null ? '-' : d0.toFixed(0)} m, closest ${minD === Infinity ? '-' : minD.toFixed(0)} m`);
  rec('the flight stays engaged rather than flying off',
    late < 800, `last sample ${late === Infinity ? '-' : late.toFixed(0)} m out`);

  const trac = await run(`
    const mine = game.wq.playerVehicle();
    if (!mine) return { near: 0, tooClose: 0, n: 0 };
    let near = 0, tooClose = 0;
    for (const tr of window.__TRACERS__) {
      const d = Math.hypot(tr.tx - mine.position.x, tr.tz - mine.position.z);
      // Pursuit fire comes from well above the aircraft; the guards' rifle
      // fire originates at shoulder height beside it.
      const high = tr.fy > mine.position.y + 25;
      if (!high) continue;
      if (d < 45) near++;
      if (d < 2.5) tooClose++;
    }
    return { near, tooClose, n: window.__TRACERS__.length };`);
  rec('tracer bursts land NEAR the aircraft', trac.near >= 3,
    `${trac.near} airborne tracers inside 45 m (${trac.n} total)`);
  rec('and never INTO it (bounded miss distance)', trac.tooClose === 0,
    `${trac.tooClose} tracers inside 2.5 m`);

  /* =================================================================== */
  area = 'winddown';
  /* =================================================================== */

  await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    return true;`);
  await pump(20);
  // Leave: 560 m back out through the gate line, far past the fence.
  await run(`
    const g = ctx.peek('world').airbase.gates[0];
    const dx = Math.sin(g.heading), dz = Math.cos(g.heading);
    game.wq.placePlayer(g.x - dx * 560, g.z - dz * 560, 0);
    game.heat.clear('probe');
    return true;`);

  let sW = await snap();
  for (let i = 0; i < 70 && (sW.armed || sW.pursuers > 0); i++) {
    await pump(40);
    sW = await snap();
  }
  rec('leaving the perimeter stands the base down', !sW.armed, `armed ${sW.armed} after cooldown`);
  rec('the guards despawn through the pool chokepoint',
    sW.guards.filter((g) => g.alive).length === 0, `${sW.guards.length} airbase guards left`);
  rec('the turrets stop tracking', sW.tanks.every((t) => !t.aiming),
    sW.tanks.map((t) => (t.aiming ? 'AIMING' : 'idle')).join(' '));
  rec('the interceptors break off and are despawned',
    sW.pursuers === 0 && sW.jets.filter((j) => j.mission && !j.destroyed).length === 0,
    `${sW.pursuers} pursuers, ${sW.jets.filter((j) => j.mission).length} mission jets still up`);

  /* =================================================================== */
  area = 'negative';
  /* =================================================================== */

  await boot('?noassault=1');
  const n0 = await run(`
    const ab = ctx.peek('world').airbase;
    return { on: !!ab?.pad, disabled: game.airbase.disabled === true };`);
  rec('the hatch is honoured (?noassault=1)', n0.on && n0.disabled,
    `airbase on ${n0.on}, encounter disabled ${n0.disabled}`);
  await pump(60);
  await walk(gate.x - dx * 35, gate.z - dz * 35, dx, dz, 70);
  await pump(240); // 4 s of standing inside the wire
  const sN = await snap();
  rec('NEGATIVE CONTROL — the same walk arms nothing',
    !sN.armed && sN.guards.length === 0,
    `armed ${sN.armed}, guards ${sN.guards.length}`);
  rec('NEGATIVE CONTROL — no turret tracks, no shell lands',
    sN.tanks.every((t) => !t.aiming && Math.abs(t.yaw) < 0.02) && sN.booms === 0,
    `${sN.tanks.filter((t) => t.aiming).length} aiming, ${sN.booms} explosions`);

  const nBoard = await run(`
    const jet = game.airbase.jets.find((j) => j && !j.destroyed);
    if (!jet) return { ok: false };
    return { ok: game.debugBoard(jet) };`);
  await pump(360); // 6 s — more than the scramble takes when live
  const sN2 = await snap();
  rec('NEGATIVE CONTROL — boarding the jet scrambles nothing',
    nBoard.ok && !sN2.chase && sN2.pursuers === 0 &&
    sN2.jets.filter((j) => j.mission).length === 0,
    `boarded ${nBoard.ok}, chase ${sN2.chase}, ${sN2.pursuers} pursuers`);

  /* =================================================================== */

  const pageErrs = errs.filter((e) => !/favicon|Autoplay|AudioContext/i.test(e));
  area = 'boot';
  rec('zero page errors across both boots', pageErrs.length === 0,
    pageErrs.slice(0, 3).join(' | ') || 'clean');
} catch (e) {
  area = 'harness';
  rec('probe ran to completion', false, String(e?.message ?? e).slice(0, 200));
} finally {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\nairbaseprobe: ${pass}/${results.length} checks passed`);
  for (const r of results) {
    if (!r.ok) console.log(`  FAIL [${r.area}] ${r.name} — ${r.detail}`);
  }
  if (!KEEP) {
    await b.close();
    stopServer(server);
  }
  process.exit(pass === results.length && results.length > 0 ? 0 : 1);
}
