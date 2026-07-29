#!/usr/bin/env node
/**
 * INTERACTION PROBE — does the contextual-action set actually fire?
 *
 * `tools/playprobe.mjs` asks whether the game responds like a game at all.
 * This one is narrower and deeper: it walks the priority chain in
 * `src/game/freeroam.js` and checks each branch through the real key path and
 * the real DOM prompt.
 *
 * Every check is a state delta observed in a running build. Nothing here calls
 * an interaction handler directly: the point is to prove that standing in the
 * right place and pressing F does the thing, not that a method exists.
 *
 *   npm run build && node src/game/interactprobe.mjs
 *   node src/game/interactprobe.mjs --keep     leave the browser open on failure
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const KEEP = process.argv.includes('--keep');

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
const rec = (name, ok, detail) => results.push({ area, name, ok: !!ok, detail });

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

/** Run a body with `engine`, `game`, `player`, `police`, `veh`, `sky` in scope. */
const run = (body) =>
  page.evaluate(`(() => {
    const engine = window.__ENGINE__;
    const ctx = engine.ctx;
    const game = ctx.peek('game');
    const player = ctx.peek('player');
    const police = ctx.peek('police');
    const veh = ctx.peek('vehicles');
    const sky = ctx.peek('sky');
    ${body}
  })()`);

/** The prompt as the player sees it: the real HUD node, not the model. */
const prompt = () =>
  page.evaluate(() => {
    const root = document.querySelector('.ow-prompt');
    if (!root || getComputedStyle(root).display === 'none') return null;
    return {
      key: root.querySelector('.ow-key')?.textContent ?? '',
      text: root.querySelector('.ow-prompt-txt')?.textContent ?? '',
      sub: root.querySelector('.ow-prompt-sub')?.textContent ?? '',
    };
  });

const tapF = async () => {
  await page.keyboard.down('KeyF');
  await pump(3);
  await page.keyboard.up('KeyF');
  await pump(4);
};

/** Park a spawned car exactly where we want it and hold it still for N frames. */
const settle = async (frames = 20) => {
  for (let i = 0; i < frames; i += 4) {
    await run(`
      const v = game.__probeVeh;
      if (v && game.__probeAt) {
        v.position.set(game.__probeAt.x, v.position.y, game.__probeAt.z);
        v.velocity.set(0, 0, 0);
        v.forwardSpeed = 0; v.speed = 0;
      }
      return true;`);
    await pump(4);
  }
};

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  await pump(120);
  await run(`
    engine.input.enabled = true; engine.input.frozen = false;
    player.setControlEnabled?.(true);
    game.missions.abort();
    game.heat.clear('probe');
    // Tap of the whole contextual chain: what did F resolve to, every time.
    window.__ACTS__ = [];
    const fr = game.freeroam;
    const orig = fr.doAction.bind(fr);
    fr.doAction = () => { const id = fr.act.id; const r = orig(); window.__ACTS__.push(id + '->' + r); return r; };
    return true;`);
  await pump(20);
  // The FIRST synthetic keypress of a session is unreliable in a headless
  // browser — the page has never been interacted with. Burn one against
  // nothing so that every measured press below is a fair test.
  await page.keyboard.down('KeyF');
  await pump(2);
  await page.keyboard.up('KeyF');
  await pump(6);

  /* =================================================================== */
  area = 'safehouse';
  /* =================================================================== */

  const shSetup = await run(`
    const sh = game.safehouses.find((s) => s.id === 'sh_carson');
    game.missions.abort();
    game.wq.placePlayer(sh.x, sh.z, 0);
    player.health.value = 62;           // above the regen cap, so any climb is ours
    player.health.armour = 0;
    game.freeroam._atHome = false;
    game.__w0 = game.writer.writes;
    return { name: sh.name, hp: player.health.value, armour: player.armour,
             maxArmour: player.maxArmour, writes: game.__w0 };`);
  await pump(70);
  const shAfter = await run(`
    return { hp: player.health.value, armour: player.armour,
             writes: game.writer.writes, home: game.freeroam.lastSafehouse };`);
  const shPrompt = await prompt();

  rec('standing in the ring heals HP', shAfter.hp > shSetup.hp + 0.5,
    `${shSetup.hp.toFixed(1)} -> ${shAfter.hp.toFixed(1)} hp`);
  rec('standing in the ring restores armour',
    shSetup.maxArmour > 0 ? shAfter.armour > shSetup.armour + 0.5 : true,
    `${shSetup.armour.toFixed(1)} -> ${shAfter.armour.toFixed(1)} of ${shSetup.maxArmour}`);
  rec('entering autosaves once', shAfter.writes > shSetup.writes,
    `${shSetup.writes} -> ${shAfter.writes} writes`);
  rec('lastSafehouse is recorded', shAfter.home === 'sh_carson', String(shAfter.home));
  rec('prompt offers sleep', /SLEEP/.test(shPrompt?.text ?? ''),
    shPrompt ? `[${shPrompt.key}] ${shPrompt.text} · ${shPrompt.sub}` : 'no prompt');

  const beforeSleep = await run(`
    const sh = game.safehouses.find((s) => s.id === 'sh_carson');
    game.wq.placePlayer(sh.x, sh.z, 0);   // he slides on the bank; re-plant him
    player.health.value = 40;
    window.__ACTS__.length = 0;
    return { hour: sky.hour, hp: player.health.value, writes: game.writer.writes,
             act: game.getAction().id };`);
  await pump(4);
  await tapF();
  await pump(20);
  const afterSleep = await run(`
    return { hour: sky.hour, hp: player.health.value, writes: game.writer.writes,
             acts: window.__ACTS__.slice() };`);
  const slept = ((afterSleep.hour - beforeSleep.hour) + 24) % 24;
  rec('F sleeps the clock forward 8 h', Math.abs(slept - 8) < 0.9,
    `${beforeSleep.hour.toFixed(2)} -> ${afterSleep.hour.toFixed(2)} (+${slept.toFixed(2)} h)` +
    ` · action was "${beforeSleep.act}", F did [${afterSleep.acts.join(', ') || 'nothing'}]`);
  rec('F fully restores', afterSleep.hp >= 99, `${beforeSleep.hp} -> ${afterSleep.hp} hp`);
  rec('F saves', afterSleep.writes > beforeSleep.writes,
    `${beforeSleep.writes} -> ${afterSleep.writes} writes`);

  /* =================================================================== */
  area = 'take a car';
  /* =================================================================== */

  // Somewhere with no shop, pump, safehouse or start line inside 60 m, so the
  // only thing that can claim the prompt is the car.
  // Somewhere with no shop, pump, safehouse or start line inside 60 m AND well
  // off the road graph — on a lane, traffic drives into the measurement and
  // the resolver correctly offers a car that is not the one under test.
  const clear = await run(`
    const w = engine.ctx.peek('world');
    const far = (x, z) => {
      const all = [...game.shops, ...game.gasStations, ...game.safehouses,
                   ...Object.values(game.raceTracks).map((t) => t.points[0])];
      for (const p of all) if (Math.hypot(p.x - x, p.z - z) < 60) return false;
      const e = w?.roads?.nearestEdge?.(x, z, 200);
      if (e && e.edge && e.dist <= 45) return false;
      // Flat, too: surfaceAt reports 'dirt' above a 0.55 slope, and on a
      // hillside the player slides more than a metre in the few frames between
      // being planted and being measured. (No backticks in here: this string
      // is a template literal — ARCHITECTURE.md rule 10.)
      return w?.surfaceAt?.(x, z) === 'grass';
    };
    for (let i = 0; i < 300; i++) {
      const s = game.wq.findGroundSpot(150, 1100, 0, 0);
      if (s.ok && far(s.x, s.z)) { game.__clear = { x: s.x, z: s.z }; return game.__clear; }
    }
    game.__clear = { x: 0, z: 0 };
    return game.__clear;`);

  const take = await run(`
    const c = game.__clear;
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    if (player.inVehicle) player.vehicles.abort(player.movement);
    // Clear the street: a traffic car wandering past would be the thing the
    // resolver offers, and the test would be measuring the wrong vehicle.
    for (const v2 of veh.vehicles.slice()) {
      if (Math.hypot(v2.position.x - c.x, v2.position.z - c.z) < 40) veh.despawn(v2);
    }
    const v = game.wq.spawnVehicle('sedan', c.x, c.z, 0);
    game.__probeVeh = v; game.__probeAt = c;
    return { name: v && v.name, spawned: !!v };`);
  await settle(20);
  // Re-plant him just before reading: on a slope he slides, and the whole
  // point of this check is the DISTANCE at which the offer stands.
  // Build the geometry around the player rather than moving the player into
  // it, and measure it several times over.
  //
  // Two separate sources of noise had to go. Planting a player on uneven ground
  // lets him slide a metre before the read, and — the interesting one —
  // SOMETHING ELSE IN THE BUILD RE-SPAWNS A VEHICLE within a metre or two of
  // the player within a couple of frames, anywhere in the world, including a
  // grass spot 70 m from the nearest road (see the report). So each attempt
  // clears the field, builds the geometry and reads it in the tightest window
  // available; the first attempt where the car under test really is the
  // nearest one is the measurement. If all five are gatecrashed the check
  // fails, which is the right outcome.
  const TAKE_SAMPLE = `
    const p = player.position;
    const t = game.getAction().target;
    game.__offered = t;
    const root = document.querySelector('.ow-prompt');
    return {
      dist: t ? +Math.hypot(t.position.x - p.x, t.position.z - p.z).toFixed(2) : null,
      id: game.getAction().id, short: game.getAction().short,
      name: t ? t.name : null, probe: t === game.__probeVeh,
      text: root && getComputedStyle(root).display !== 'none'
        ? (root.querySelector('.ow-prompt-txt').textContent || '') : '',
    };`;
  let takeState = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await run(`
      const c = game.__clear;
      if (game.__probeVeh) veh.despawn(game.__probeVeh);
      game.wq.placePlayer(c.x, c.z, Math.PI * 0.5);
      const p = player.position;
      for (const o of veh.vehicles.slice()) {
        if (Math.hypot(o.position.x - p.x, o.position.z - p.z) < 80) veh.despawn(o);
      }
      const v = game.wq.spawnVehicle('sedan', p.x + 4.8, p.z, 0);
      game.__probeVeh = v; game.__probeAt = { x: p.x + 4.8, z: p.z };
      return { name: v && v.name };`);
    await pump(2);
    takeState = await run(TAKE_SAMPLE);
    if (takeState.probe && takeState.id === 'enter') break;
  }
  rec('a car beyond `player`’s own 3.4 m reach is still offered',
    takeState.id === 'enter' && takeState.probe && takeState.dist > 3.4,
    `${takeState.dist} m · ${takeState.text || 'no prompt'}` +
    ` · id "${takeState.id}"${takeState.probe ? '' : ' (a passing car, not the spawned one)'}`);
  rec('the prompt names the car',
    !!takeState.name && takeState.text.includes(String(takeState.name).toUpperCase()),
    `${takeState.name} -> ${takeState.text || '-'}`);
  void take;

  await tapF();
  await pump(170);
  const entered = await run(`
    return { inVehicle: !!player.inVehicle, phase: player.vehicles.phase,
             same: player.vehicles.vehicle === game.__offered,
             acts: window.__ACTS__.slice(-2) };`);
  rec('F takes it', entered.inVehicle && entered.same,
    `${entered.inVehicle ? `in ${entered.same ? 'the offered car' : 'a DIFFERENT car'}` : 'on foot'}` +
    ` (${entered.phase}) · F did [${entered.acts.join(', ')}]`);

  /* =================================================================== */
  area = 'grand theft auto';
  /* =================================================================== */

  const jack = await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    if (game.__offered) game.wq.despawnVehicle(game.__offered);
    game.heat.clear('probe');
    const c = game.__clear;
    for (const v2 of veh.vehicles.slice()) {
      if (Math.hypot(v2.position.x - c.x, v2.position.z - c.z) < 60) veh.despawn(v2);
    }
    const v = game.wq.spawnVehicle('police', c.x, c.z, 0);
    game.__probeVeh = v;
    return { before: game.heat.wanted, owner: game.heat.authoritative ? 'game' : 'police',
             police: !!v && v.type === 'police' };`);
  await settle(20);
  // Clear the field and stand on the cruiser's door, in one evaluate.
  await run(`
    const c = game.__clear, v = game.__probeVeh;
    for (const o of veh.vehicles.slice()) if (o !== v) {
      if (Math.hypot(o.position.x - c.x, o.position.z - c.z) < 60) veh.despawn(o);
    }
    v.position.set(c.x, v.position.y, c.z); v.velocity.set(0, 0, 0);
    game.wq.placePlayer(c.x + 2.6, c.z, Math.PI * 0.5);
    return true;`);
  await pump(2);
  const jackPrompt = await prompt();
  const jackTarget = await run(`
    const t = game.getAction().target;
    return { id: game.getAction().id, cruiser: t === game.__probeVeh };`);
  rec('a cruiser reads as COMMANDEER',
    jackTarget.cruiser && jackTarget.id === 'commandeer' && /COMMANDEER/.test(jackPrompt?.text ?? ''),
    `${jackPrompt?.text ?? 'no prompt'} · id "${jackTarget.id}"`);
  await tapF();
  await pump(160);
  const jacked = await run(`
    return { inVehicle: !!player.inVehicle, wanted: game.heat.wanted,
             policeLevel: police ? police.level : null };`);
  rec('stealing a police car raises the wanted level',
    jacked.inVehicle && jacked.wanted > jack.before,
    `${jack.before}* -> ${jacked.wanted}* (heat owned by ${jack.owner})`);

  /* =================================================================== */
  area = 'gas station';
  /* =================================================================== */

  const gas = await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    game.heat.clear('probe');
    const g = game.gasStations[0];
    const v = game.wq.spawnVehicle('sedan', g.x, g.z, 0);
    game.__probeVeh = v; game.__probeAt = g;
    game.debugBoard(v);
    return { station: g.name, hasFuel: typeof v.fuel === 'number', maxFuel: v.maxFuel ?? null };`);
  await pump(120);
  const gasBefore = await run(`
    const v = game.__probeVeh, g = game.__probeAt;
    v.position.set(g.x, v.position.y, g.z); v.velocity.set(0, 0, 0);
    if (typeof v.fuel === 'number') v.fuel = Math.min(v.fuel, (v.maxFuel ?? 100) * 0.2);
    return { fuel: v.fuel ?? null, aboard: game.wq.playerVehicle() === v };`);
  await settle(48);
  const gasAfter = await run(`return { fuel: game.__probeVeh.fuel ?? null };`);
  const gasPrompt = await prompt();
  rec('vehicles exposes a tank', gas.hasFuel, gas.hasFuel ? `maxFuel ${gas.maxFuel}` : 'no v.fuel yet');
  rec('stopping at the pumps refuels',
    !gas.hasFuel || (gasAfter.fuel > gasBefore.fuel + 1),
    gas.hasFuel ? `${gasBefore.fuel?.toFixed(1)} -> ${gasAfter.fuel?.toFixed(1)} at ${gas.station}`
      : 'skipped — no fuel model');
  rec('the pump prompt says what is happening', /REFUEL|TANK|STOP AT|REPAIR/.test(gasPrompt?.text ?? ''),
    gasPrompt ? `${gasPrompt.text} · ${gasPrompt.sub}` : 'no prompt');

  /* =================================================================== */
  area = 'body shop';
  /* =================================================================== */

  const shop = await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    const s = game.safehouses.find((x) => x.id === 'sh_aidan');
    const v = game.wq.spawnVehicle('sedan', s.x, s.z, 0);
    game.__probeVeh = v; game.__probeAt = s;
    game.debugBoard(v);
    return { name: s.name };`);
  await pump(120);
  const shopBefore = await run(`
    const v = game.__probeVeh, s = game.__probeAt;
    v.position.set(s.x, v.position.y, s.z); v.velocity.set(0, 0, 0);
    v.health = v.maxHealth * 0.35;
    if (typeof v.fuel === 'number') v.fuel = (v.maxFuel ?? 100) * 0.25;
    return { health: v.health, fuel: v.fuel ?? null, cash: game.economy.cash,
             aboard: game.wq.playerVehicle() === v };`);
  await settle(48);
  const shopAfter = await run(`
    const v = game.__probeVeh;
    return { health: v.health, fuel: v.fuel ?? null, cash: game.economy.cash };`);
  const shopPrompt = await prompt();
  rec('Aidan’s shop repairs the car', shopAfter.health > shopBefore.health + 1,
    `${shopBefore.health.toFixed(0)} -> ${shopAfter.health.toFixed(0)} hp`);
  rec('Aidan’s shop tops the tank',
    shopBefore.fuel == null || shopAfter.fuel > shopBefore.fuel + 1,
    shopBefore.fuel == null ? 'skipped — no fuel model'
      : `${shopBefore.fuel.toFixed(1)} -> ${shopAfter.fuel.toFixed(1)}`);
  rec('and it is free', shopAfter.cash === shopBefore.cash, `$${shopBefore.cash} -> $${shopAfter.cash}`);
  rec('with a prompt', /DENT|SOUND|PULL INTO/.test(shopPrompt?.text ?? ''),
    shopPrompt ? `${shopPrompt.text} · ${shopPrompt.sub}` : 'no prompt');

  /* =================================================================== */
  area = 'respray';
  /* =================================================================== */

  const spray = await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    const s = game.shops.find((x) => x.kind === 'spray');
    const v = game.wq.spawnVehicle('sedan', s.x, s.z, 0);
    game.__probeVeh = v; game.__probeAt = s;
    game.debugBoard(v);
    return { name: s.name };`);
  await pump(120);
  const sprayBefore = await run(`
    const v = game.__probeVeh, s = game.__probeAt;
    v.position.set(s.x, v.position.y, s.z); v.velocity.set(0, 0, 0);
    game.heat.raise(3, s.x, s.z);
    return { wanted: game.heat.wanted, paint: v.paintName, plate: v.plate,
             aboard: game.wq.playerVehicle() === v };`);
  await settle(64);
  const sprayAfter = await run(`
    const v = game.__probeVeh;
    return { wanted: game.heat.wanted, paint: v.paintName, plate: v.plate };`);
  rec('driving in clears the wanted level', sprayBefore.wanted >= 1 && sprayAfter.wanted === 0,
    `${sprayBefore.wanted}* -> ${sprayAfter.wanted}* at ${spray.name}`);
  rec('and changes the paint', sprayAfter.paint === 'resprayed',
    `${sprayBefore.paint} -> ${sprayAfter.paint}`);
  rec('and the plate', sprayAfter.plate !== sprayBefore.plate,
    `${sprayBefore.plate} -> ${sprayAfter.plate}`);

  /* =================================================================== */
  area = 'vehicle swap';
  /* =================================================================== */

  const swap = await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    if (game.__probeVeh2) game.wq.despawnVehicle(game.__probeVeh2);
    game.heat.clear('probe');
    const c = game.__clear;
    const a = game.wq.spawnVehicle('sedan', c.x, c.z, 0);
    const b2 = game.wq.spawnVehicle('muscle', c.x + 4.4, c.z, 0);
    game.__probeVeh = a; game.__probeAt = c; game.__probeVeh2 = b2;
    game.debugBoard(a);
    return { a: a && a.name, b: b2 && b2.name };`);
  await pump(130);
  await run(`
    const b2 = game.__probeVeh2, c = game.__clear;
    b2.position.set(c.x + 4.4, b2.position.y, c.z); b2.velocity.set(0, 0, 0);
    for (const v2 of veh.vehicles.slice()) {
      if (v2 === b2 || v2 === game.__probeVeh) continue;
      if (Math.hypot(v2.position.x - c.x, v2.position.z - c.z) < 40) veh.despawn(v2);
    }
    return true;`);
  await settle(16);
  // The swap is a ROLLING move — parked means EXIT — so put the player's car
  // in motion before asking what the action button says.
  await run(`
    const a = game.__probeVeh, b2 = game.__probeVeh2, c = game.__clear;
    a.position.set(c.x, a.position.y, c.z);
    b2.position.set(c.x + 4.4, b2.position.y, c.z);
    b2.velocity.set(0, 0, 0);
    a.velocity.set(0, 0, -4);
    a.sleeping = false;
    return true;`);
  await pump(6);
  const swapPrompt = await prompt();
  const swapOffer = await run(`
    game.__offered = game.getAction().target;
    return { id: game.getAction().id, name: game.__offered && game.__offered.name };`);
  rec('a car alongside is offered',
    swapOffer.id === 'swap' && /SWITCH TO THE/.test(swapPrompt?.text ?? ''),
    swapPrompt ? swapPrompt.text : 'no prompt');
  await tapF();
  await pump(170);
  const swapped = await run(`
    return { inB: player.vehicles.vehicle === game.__offered,
             name: player.vehicles.vehicle && player.vehicles.vehicle.name,
             phase: player.vehicles.phase };`);
  rec('F switches into it', swapped.inB,
    `now in ${swapped.name ?? 'nothing'} (${swapped.phase}), offered ${swapOffer.name}`);

  /* =================================================================== */
  area = 'free roam content';
  /* =================================================================== */

  const pk = await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    if (game.__probeVeh2) game.wq.despawnVehicle(game.__probeVeh2);
    game.__probeVeh = null; game.__probeVeh2 = null;
    game.missions.abort();
    game.save.packages.length = 0;
    game.pickups.clear();
    game.freeroam.seedPackages();
    const seeded = game.pickups.live.length;
    const p = game.freeroam.packages[0];
    game.wq.placePlayer(p.x + 1.2, p.z, 0);
    game.__cash0 = game.economy.cash;
    return { seeded, id: p.id };`);
  await pump(40);
  const pkAfter = await run(`
    return { found: game.save.packages.slice(), gained: game.economy.cash - game.__cash0 };`);
  rec('12 hidden packages seed', pk.seeded === 12, `${pk.seeded} live`);
  rec('walking over one collects it', pkAfter.found.includes(pk.id),
    `${pkAfter.found.length} found, +$${pkAfter.gained}`);

  const shops = await run(`
    const a = game.shops.find((s) => s.kind === 'ammo');
    game.wq.placePlayer(a.x, a.z, 0);
    const c = game.economy.char();
    for (const k in c.ammo) c.ammo[k] = 0;
    return { name: a.name };`);
  await pump(24);
  const ammoPrompt = await prompt();
  rec('an ammo counter offers a purchase', /ROUNDS|FULLY LOADED/.test(ammoPrompt?.text ?? ''),
    ammoPrompt ? `${ammoPrompt.text} · ${ammoPrompt.sub}` : `no prompt at ${shops.name}`);

  await run(`
    const f = game.shops.find((s) => s.kind === 'food');
    game.wq.placePlayer(f.x, f.z, 0);
    player.health.value = 30;
    return true;`);
  await pump(24);
  const foodPrompt = await prompt();
  const foodCash = await run(`return game.economy.cash;`);
  await tapF();
  await pump(20);
  const foodAfter = await run(`return { hp: player.health.value, cash: game.economy.cash };`);
  rec('a food counter offers a meal', /EAT|NOT HUNGRY/.test(foodPrompt?.text ?? ''),
    foodPrompt ? foodPrompt.text : 'no prompt');
  rec('F buys it and heals', foodAfter.hp > 90 && foodAfter.cash < foodCash,
    `hp 30 -> ${foodAfter.hp.toFixed(0)}, $${foodCash} -> $${foodAfter.cash}`);

  // A circuit needs a car, so the honest test is "sitting on the grid in a car,
  // does the start line offer the race". On foot at a start line the resolver
  // correctly offers whatever car is parked there instead, which is the point
  // of the priority chain.
  const races = await run(`
    const ids = Object.keys(game.raceTracks);
    const t = game.raceTracks[ids[0]];
    const s = t.points[0];
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    const v = game.wq.spawnVehicle('sports', s.x, s.z, 0);
    game.__probeVeh = v; game.__probeAt = s;
    game.debugBoard(v);
    return { count: ids.length, name: t.name };`);
  await pump(120);
  await settle(16);
  const racePrompt = await prompt();
  const raceAct = await run(`return game.getAction().id;`);
  rec('3 race circuits exist', races.count === 3, `${races.count} tracks`);
  rec('a start line offers the circuit', raceAct === 'race' || /START/.test(racePrompt?.text ?? ''),
    racePrompt ? `${racePrompt.text} · ${racePrompt.sub}` : `no prompt at ${races.name}`);
  await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    game.__probeVeh = null;
    return true;`);

  const lock = await run(`
    game.save.unlocks.length = 0;
    for (const id of ['carson', 'aidan', 'dylan']) game.save.chars[id].respect = 0;
    const sh = game.safehouses.find((s) => s.respect);
    game.wq.placePlayer(sh.x, sh.z, 0);
    return { id: sh.id, need: sh.respect };`);
  await pump(24);
  const lockedPrompt = await prompt();
  const unlocked = await run(`
    game.economy.addRespect(${'350'}, 'probe');
    return { has: game.economy.hasUnlock('sh_dt'), unlocks: game.save.unlocks.slice() };`);
  await pump(24);
  const unlockedPrompt = await prompt();
  /* =================================================================== */
  area = 'job board';
  /* =================================================================== */

  const board = await run(`
    game.missions.abort();
    const list = game.jobBoard();
    return {
      count: list.length,
      ids: list.map((j) => j.id),
      names: list.map((j) => j.name),
      pays: list.map((j) => j.pay),
      dists: list.map((j) => Math.round(j.dist)),
      tracks: list.map((j) => j.track),
    };`);
  rec('the board offers three distinct jobs',
    board.count === 3 && new Set(board.ids).size === 3,
    board.ids.join(', '));
  rec('each pays and is somewhere to drive to',
    board.pays.every((p) => p > 0) && board.dists.every((d) => d > 100),
    board.names.map((n, i) => `${n} $${board.pays[i]} @ ${board.dists[i]}m`).join(' · '));

  const took = await run(`
    const M = game.takeJob();
    return M ? { id: M.id, track: M.track, side: M.side, cash: M.def.cash,
                 poi: M.startPoi && M.startPoi.name } : null;`);
  rec('a job starts as a real mission',
    !!took && took.side === true && !!took.track,
    took ? `${took.id} · ${took.track} · $${took.cash} · staged at ${took.poi}` : 'did not start');

  const afterStory = await run(`
    game.missions.abort();
    const boy = game.characters.boy;
    game.economy.char().chapter = boy.story.length;   // arc complete
    game._announceNext();                             // which clears the pending chapter
    const M = game.startMission();
    const out = M ? { id: M.id, side: M.side } : null;
    game.missions.abort();
    game.economy.char().chapter = 0;
    return out;`);
  rec('J still gives you work after the story ends',
    !!afterStory && afterStory.side === true,
    afterStory ? afterStory.id : 'J did nothing with the arc complete');

  /* =================================================================== */
  area = 'free roam content';
  /* =================================================================== */

  rec('a locked safehouse says so', /LOCKED/.test(lockedPrompt?.text ?? ''),
    lockedPrompt ? `${lockedPrompt.text} · ${lockedPrompt.sub}` : 'no prompt');
  rec('respect unlocks it and the ring opens',
    unlocked.has && !/LOCKED/.test(unlockedPrompt?.text ?? ''),
    `${unlocked.unlocks.join(', ')} · ${unlockedPrompt?.text ?? 'no prompt'}`);

  /* ---- report ------------------------------------------------------- */
  const pass = results.filter((r) => r.ok).length;
  const w = Math.max(...results.map((r) => r.name.length));
  let cur = '';
  for (const r of results) {
    if (r.area !== cur) { cur = r.area; console.log(`\n--- ${cur} ---`); }
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail ?? ''}`);
  }
  console.log(`\n${pass}/${results.length} interactions working`);
  if (errs.length) console.log(`\nconsole errors (${errs.length}):\n  ` + [...new Set(errs)].slice(0, 8).join('\n  '));
  process.exitCode = pass === results.length ? 0 : 1;
} catch (e) {
  console.error('interactprobe failed:', e.message);
  console.error([...new Set(errs)].slice(0, 8).join('\n'));
  process.exitCode = 1;
} finally {
  if (!KEEP) await b.close();
  server?.kill();
}
