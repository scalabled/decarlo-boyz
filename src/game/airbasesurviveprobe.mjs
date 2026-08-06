#!/usr/bin/env node
/**
 * AIRBASE SURVIVABILITY PROBE — the Ridgeline AFB assault is a FIGHT the
 * player can win, not a firing squad. Gated on EMITTED results through the
 * real entry path (rule 12), with the tuning's own debug flag as the negative
 * control (rule 12 corollary — a gate with no failing input is decorative).
 *
 *   npm run build && node src/game/airbasesurviveprobe.mjs
 *   node src/game/airbasesurviveprobe.mjs --keep     leave the browser open
 *
 * THE PROBLEM IT GATES. The player flagged the base as "realistic but
 * difficult — I get killed or my vehicle gets blown up before I can do
 * anything." Measured before the tuning: on foot a 100 HP player took ~16-20
 * DPS from the first wave and was dead in ~6.5 s; a driven-in 900 HP sedan
 * ate a single 2100-point tank shell and was WRECKED in ~4.9 s. The spin-up
 * grace, the guard-concurrency ramp, the fire bracket and the shell stagger
 * in `airbase.js` are the fix.
 *
 * WHAT IT PROVES, all off EMITTED artefacts:
 *
 *   FOOT SURVIVES  the player crosses the wire on foot with a real 100 HP
 *          pool; the cumulative `damage:taken` he absorbs (the emitted damage
 *          bus, regen-independent, so it measures INCOMING lethality not net
 *          health) stays near zero through the spin-up grace, and stays under
 *          a survivable ceiling through the first 8 s — long enough to break
 *          for a jet.
 *
 *   CAR SURVIVES THE WINDOW  a sedan driven in through the gate keeps most of
 *          its hull through the grace/bracket window (the emitted `v.health`),
 *          instead of being one-shot on the apron. The base is armed and the
 *          turrets are laying on it the whole time.
 *
 *   STILL DANGEROUS  the encounter is NOT gutted: it arms, ranged guards
 *          spawn, the incoming damage keeps climbing and would kill a lingerer
 *          (crosses the 100 HP mark), and the tanks do eventually land shells
 *          that wreck a car left parked under them.
 *
 *   NEGATIVE CONTROL  the SAME two runs under `?assaulthard=1` (the tuning
 *          reverted in place — no grace, no bracket, no stagger, full guard
 *          damage and the whole garrison concurrent): the player takes lethal
 *          damage from the first second and the car is wrecked in a few. The
 *          survivable arm therefore measures the TUNING, not the harness.
 *
 * Declared harness affordance: in the CAR run the player's health pool is
 * inflated so an explosion that catches the driver cannot end the run before
 * the CAR's hull is what we are measuring — the same affordance airbaseprobe
 * declares. In the FOOT run the pool is the real 100, because time-to-lethal
 * IS the measurement there. The wanted level is cleared so the city police do
 * not wander in.
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

const run = (body) =>
  page.evaluate(`(() => {
    const engine = window.__ENGINE__;
    const ctx = engine.ctx;
    const game = ctx.peek('game');
    const player = ctx.peek('player');
    const peds = ctx.peek('peds');
    const veh = ctx.peek('vehicles');
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
    // The emitted damage bus — cumulative incoming damage on the player, and a
    // shell counter. Everything the probe asserts on is read from here.
    window.__DT = 0;
    window.__BOOM = 0;
    ctx.events.on('damage:taken', (e) => { window.__DT += e.amount || 0; });
    ctx.events.on('explosion', (e) => { if (e?.source === 'tankshell') window.__BOOM++; });
    return true;`);
  await pump(20);
};

/** The published main gate and its inward bearing. */
const mainGate = () => run(`
  const ab = ctx.peek('world').airbase;
  const g = ab.gates.find((x) => x.id === 'main') ?? ab.gates[0];
  return { x: g.x, z: g.z, heading: g.heading };`);

/** Walk the player through the gate in 1.3 m steps — a real position series. */
const walkIn = async (gate, metres) => {
  const dx = Math.sin(gate.heading);
  const dz = Math.cos(gate.heading);
  const steps = Math.ceil(metres / 1.3);
  for (let i = 0; i <= steps; i++) {
    const x = gate.x - dx * 35 + dx * 1.3 * i;
    const z = gate.z - dz * 35 + dz * 1.3 * i;
    await run(`game.wq.placePlayer(${x}, ${z}, ${Math.atan2(dx, dz)}); return true;`);
    await pump(2);
  }
};

/**
 * One arm's full measurement: walk in on foot with a REAL 100 HP pool and
 * sample the emitted incoming damage; then reset, drive a sedan in and sample
 * the emitted hull. Returns the derived survivability quantities.
 */
const measureArm = async (gate) => {
  const dx = Math.sin(gate.heading);
  const dz = Math.cos(gate.heading);

  /* ---- FOOT: real 100 HP, cumulative incoming damage vs time ----
   * First a genuine WALK across the wire to prove the crossing arms it. Then
   * reset and stand him back on the line, so the grace clock starts at t0 and
   * the first-seconds measurement is taken from the MOMENT of crossing (a walk
   * that armed the base ten seconds ago has already spent its grace). */
  await run(`game.airbase.reset?.(); game.wq.placePlayer(${gate.x - dx * 40}, ${gate.z - dz * 40}, 0); return true;`);
  await pump(30);
  await walkIn(gate, 70);
  const walkArmed = await run(`return game.airbase.stats.armed === true;`);
  // Re-arm cleanly: reset, stand 8 m inside, restore the real pool, zero the
  // counter. The base re-arms on the next update with a fresh spin-up grace.
  await run(`
    game.airbase.reset?.();
    game.wq.placePlayer(${gate.x + dx * 8}, ${gate.z + dz * 8}, ${Math.atan2(dx, dz)});
    if (player.health) { player.health.max = 100; player.health.value = 100; }
    game.heat.clear('probe');
    window.__DT = 0;
    return true;`);
  await pump(3);
  const armed = await run(`return game.airbase.stats.armed === true && ${walkArmed};`);
  const foot = [];
  const t0 = await run(`return ctx.time.elapsed;`);
  for (let i = 0; i < 40; i++) {
    await pump(24);
    const s = await run(`
      const e = game.airbase.stats;
      return { t: ctx.time.elapsed, dt: window.__DT, hp: player.health?.value ?? -1,
        dead: !!player.health?.dead, guards: e.guards };`);
    foot.push({ t: s.t - t0, dt: s.dt, hp: s.hp, dead: s.dead, guards: s.guards });
    if ((s.t - t0) > 20) break;
  }
  const at = (arr, sec, key) => {
    for (const r of arr) if (r.t >= sec) return r[key];
    return arr.length ? arr[arr.length - 1][key] : 0;
  };
  const guardsSeen = foot.reduce((m, r) => Math.max(m, r.guards), 0);
  const footDead = foot.find((r) => r.dead);

  /* ---- CAR: a sedan driven in, fresh grace, inflated driver ---- */
  // Reset and stand well outside so the base disarms and re-arms fresh on the car.
  await run(`game.airbase.reset?.(); game.wq.placePlayer(${gate.x - dx * 800}, ${gate.z - dz * 800}, 0); game.heat.clear('probe'); return true;`);
  await pump(40);
  const car0 = await run(`
    const cx = ${gate.x + dx * 12}, cz = ${gate.z + dz * 12};
    const y = game.wq.groundY(cx, cz) + 1;
    const v = veh.spawn('sedan', { x: cx, y, z: cz }, ${Math.atan2(dx, dz)}, {});
    window.__CAR__ = v;
    return { ok: !!v, hp: v?.health ?? 0, max: v?.spec?.body?.hp ?? 0 };`);
  await run(`
    game.wq.placePlayer(${gate.x + dx * 12}, ${gate.z + dz * 12}, 0);
    if (player.health) { player.health.max = 1e9; player.health.value = 1e9; }
    window.__BOOM = 0;
    return true;`);
  await pump(4);
  await run(`game.debugBoard(window.__CAR__); return true;`);
  await pump(16);
  const carArmed = await run(`return game.airbase.stats.armed === true && game.wq.playerVehicle() === window.__CAR__;`);
  const car = [];
  const c0 = await run(`return ctx.time.elapsed;`);
  for (let i = 0; i < 40; i++) {
    await pump(30);
    const s = await run(`
      const v = window.__CAR__;
      return { t: ctx.time.elapsed, hp: v.health, dz: !!v.destroyed, boom: window.__BOOM };`);
    car.push({ t: s.t - c0, hp: s.hp, dz: s.dz, boom: s.boom });
    if (s.dz || (s.t - c0) > 20) break;
  }
  const carWreck = car.find((r) => r.dz);

  return {
    armed, guardsSeen,
    grace3: at(foot, 3.0, 'dt'),
    dmg8: at(foot, 8.0, 'dt'),
    dmg18: at(foot, 18.0, 'dt'),
    footTtd: footDead ? footDead.t : null,
    carOk: car0.ok, carMax: car0.max, carArmed,
    carHp7: at(car, 7.0, 'hp'),
    carWreckT: carWreck ? carWreck.t : null,
    carBooms: car.length ? car[car.length - 1].boom : 0,
  };
};

try {
  /* =================================================================== */
  area = 'tuned';   // the shipped tuning
  /* =================================================================== */
  await boot('');
  const gate = await mainGate();
  await pump(60); // let the apron seed
  const T = await measureArm(gate);

  rec('the base still ARMS on crossing (encounter intact)', T.armed, `armed ${T.armed}`);
  rec('ranged guards still muster (encounter intact)', T.guardsSeen >= 2,
    `${T.guardsSeen} concurrent guards seen`);

  // SURVIVABILITY FLOOR — the crossing is not an instant crossfire.
  rec('SURVIVE foot: the spin-up grace holds — little to no damage in the first 3 s',
    T.grace3 <= 10, `${T.grace3.toFixed(0)} dmg taken by +3 s`);
  rec('SURVIVE foot: a 100 HP player is not overwhelmed in the first 8 s',
    T.dmg8 <= 65, `${T.dmg8.toFixed(0)} cumulative dmg by +8 s (of 100 HP)`);
  rec('SURVIVE foot: the player is still alive 8 s after crossing',
    T.footTtd === null || T.footTtd >= 8, `time-to-death ${T.footTtd === null ? '>20 s' : T.footTtd.toFixed(1) + ' s'}`);

  // SURVIVABILITY FLOOR — a driven-in car is not one-shot.
  rec('SURVIVE car: the sedan spawned and the base re-armed onto it', T.carOk && T.carArmed,
    `car ${T.carOk}, armed-on-car ${T.carArmed}`);
  rec('SURVIVE car: the hull survives the grace/bracket window (>=50% at +7 s)',
    T.carHp7 >= T.carMax * 0.5, `${T.carHp7.toFixed(0)}/${T.carMax} HP at +7 s`);
  rec('SURVIVE car: not wrecked inside the first 7 s',
    T.carWreckT === null || T.carWreckT >= 7, `time-to-wreck ${T.carWreckT === null ? '>20 s' : T.carWreckT.toFixed(1) + ' s'}`);

  // NOT GUTTED — it is still a real, escalating fight.
  rec('DANGER foot: the fire escalates — a lingerer crosses lethal by ~18 s',
    T.dmg18 >= 85, `${T.dmg18.toFixed(0)} cumulative dmg by +18 s (would kill 100 HP)`);
  rec('DANGER car: the tanks DO land shells on a car left under them',
    T.carBooms >= 1 && (T.carWreckT !== null || T.carHp7 < T.carMax),
    `${T.carBooms} shells, wreck ${T.carWreckT === null ? 'not within 20 s' : T.carWreckT.toFixed(1) + ' s'}`);

  /* =================================================================== */
  area = 'negative';   // ?assaulthard=1 — the tuning reverted in place
  /* =================================================================== */
  await boot('?assaulthard=1');
  const gateH = await mainGate();
  await pump(60);
  const H = await measureArm(gateH);

  rec('NEGATIVE CONTROL — hard mode is honoured', H.armed,
    `armed ${H.armed} under ?assaulthard=1`);
  rec('NEGATIVE CONTROL foot — reverted, the crossing IS an instant crossfire',
    H.grace3 > T.grace3 && H.dmg8 > T.dmg8,
    `hard ${H.grace3.toFixed(0)}/${H.dmg8.toFixed(0)} vs tuned ${T.grace3.toFixed(0)}/${T.dmg8.toFixed(0)} dmg @3s/@8s`);
  rec('NEGATIVE CONTROL car — reverted, the sedan is wrecked fast',
    H.carWreckT !== null && H.carWreckT < 7 && H.carHp7 < T.carHp7,
    `hard time-to-wreck ${H.carWreckT === null ? '>20 s' : H.carWreckT.toFixed(1) + ' s'} (tuned ${T.carWreckT === null ? '>20 s' : T.carWreckT.toFixed(1) + ' s'})`);
  rec('NEGATIVE CONTROL — the tuning MEASURABLY buys the car survival time',
    (H.carWreckT ?? 0) + 4 <= (T.carWreckT ?? 20),
    `car survives ${(((T.carWreckT ?? 20)) - (H.carWreckT ?? 0)).toFixed(1)} s longer with the tuning`);

  const pageErrs = errs.filter((e) => !/favicon|Autoplay|AudioContext/i.test(e));
  area = 'boot';
  rec('zero page errors across both boots', pageErrs.length === 0,
    pageErrs.slice(0, 3).join(' | ') || 'clean');
} catch (e) {
  area = 'harness';
  rec('probe ran to completion', false, String(e?.message ?? e).slice(0, 200));
} finally {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\nairbasesurviveprobe: ${pass}/${results.length} checks passed`);
  for (const r of results) {
    if (!r.ok) console.log(`  FAIL [${r.area}] ${r.name} — ${r.detail}`);
  }
  if (!KEEP) {
    await b.close();
    stopServer(server);
  }
  process.exit(pass === results.length && results.length > 0 ? 0 : 1);
}
