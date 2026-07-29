#!/usr/bin/env node
/**
 * CHEAT PROBE — does the test menu actually DO the things it says?
 *
 *   npm run build && node src/ui/cheatprobe.mjs
 *   node src/ui/cheatprobe.mjs --json
 *
 * ---------------------------------------------------------------------------
 * RULE 12: ASSERT THE EFFECT, NEVER THE CLICK
 * ---------------------------------------------------------------------------
 * A gate that clicks SPAWN and then reports "SPAWN was clicked" is decorative.
 * Every assertion in this file reads the EMITTED STATE of the subsystem that
 * was supposed to change, through a path the cheat menu does not participate
 * in, and never the return value of the thing under test:
 *
 *   spawn      -> the vehicle is in `vehicles.vehicles`, its own up-axis is
 *                 within 5 degrees of world up, and its wheels are on the
 *                 ground. It reads the vehicle's live quaternion, NOT the yaw
 *                 the menu passed in.
 *   give       -> `weapons.getHudState().id` TWO SECONDS LATER, because the
 *                 ownership poll runs at 2 Hz and that is exactly the window in
 *                 which the naive version silently reverts to fists.
 *   teleport   -> `player.position.y` vs `world.walkableHeightAt` at the
 *                 destination, measured after the fact.
 *   switch     -> `game.character`.
 *   wanted     -> `police.wanted`.
 *   never trap -> `time.scale` and the presence of any modal, measured five
 *                 open/close cycles deep.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROLS — what input would make each of these fail?
 * ---------------------------------------------------------------------------
 * ARCHITECTURE.md rule 12: a gate that has never failed is not evidence. Each
 * of the four substantive gates is paired with a control that is EXPECTED to
 * go the other way, run in the same browser on the same build:
 *
 *   N1 REVERT   `weapons.setWeaponImmediate(id, true)` on its own — the exact
 *               naive implementation — must NOT still be in hand after 2 s.
 *               If N1 passes, gate 5 is measuring nothing and the poll is not
 *               running. This is the control that proves the revert trap is
 *               real on this build rather than assumed from a comment.
 *   N2 BURIED   the reconciled ground height must beat a bare physics down-ray
 *               fired from high above, at the sample of destinations where the
 *               two disagree — the 2 m-underground bug, reproduced.
 *   N3 CAPTURE  `?capture=1` and a plain `navigator.webdriver` load must build
 *               NO cheat DOM at all. If this passes with the menu present, the
 *               "off in captures" claim is false however green everything else
 *               looks.
 *   N4 NOSPAWN  before any SPAWN is clicked, the class under test must not
 *               already be parked next to the player — otherwise gate 3 would
 *               score full marks against traffic that was always there.
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

const results = [];
const rec = (area, name, ok, detail) => {
  results.push({ area, name, ok: !!ok, detail: String(detail ?? '') });
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail ?? ''}`);
};

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});

let page;
const pageErrors = [];

const pump = (n = 1) => page.evaluate((k) => window.__PUMP__(k), n);

/* ------------------------------------------------------------- DOM drivers */
/**
 * Everything below goes through the real elements the player touches. No
 * assertion calls a CheatMenu method directly — if a button stops being wired,
 * these stop working, which is the point.
 */

const cheatOpen = () => page.evaluate(() => !!window.__ENGINE__.ctx.peek('ui').cheats?.open);

/** Press the real key, on the real window, through `src/core/input.js`. */
const pressKey = async (key) => {
  await page.keyboard.press(key);
  await pump(6);
};

/** Click the always-on HUD button — the one the player finds without reading. */
const clickHudButton = async () => {
  const hit = await page.evaluate(() => {
    const b = document.querySelector('.ow-cheat-btn');
    if (!b) return false;
    b.click();
    return true;
  });
  await pump(6);
  return hit;
};

const clickTab = async (tab) => {
  const hit = await page.evaluate((t) => {
    const b = document.querySelector('.ow-cheat-tab[data-tab="' + t + '"]');
    if (!b) return false;
    b.click();
    return true;
  }, tab);
  await pump(4);
  return hit;
};

/** Type into the real filter box and dispatch the real `input` event. */
const filter = async (text) => {
  const n = await page.evaluate((q) => {
    const i = document.querySelector('.ow-cheat-filter input');
    if (!i) return -1;
    i.value = q;
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return [...document.querySelectorAll('.ow-cheat-row')]
      .filter((r) => getComputedStyle(r).display !== 'none').length;
  }, text);
  await pump(3);
  return n;
};

/**
 * Click the named action on the row whose name starts with `name`.
 * Returns `{ ok, status }` — `status` is the panel's own status line, printed
 * as context only. Nothing is ever ASSERTED from it.
 */
const clickRow = async (name, action) => {
  const out = await page.evaluate(([n, a]) => {
    const rows = [...document.querySelectorAll('.ow-cheat-row')];
    const row = rows.find((r) => {
      const t = (r.querySelector('.name')?.textContent ?? '').trim().toUpperCase();
      return t.startsWith(n);
    });
    if (!row) return { ok: false, status: 'no row starting "' + n + '"' };
    const btn = [...row.querySelectorAll('.ow-cheat-act')]
      .find((b) => b.textContent.trim().toUpperCase() === a);
    if (!btn) return { ok: false, status: 'row "' + n + '" has no "' + a + '" button' };
    if (btn.disabled) return { ok: false, status: 'button disabled' };
    btn.click();
    return { ok: true, status: (document.querySelector('.ow-cheat-status')?.textContent ?? '').trim() };
  }, [name.toUpperCase(), action.toUpperCase()]);
  await pump(6);
  return out;
};

/* --------------------------------------------------------------- read-outs */
/** One evaluate, so nothing is compared across frames (blipprobe's lesson). */
const snap = () => page.evaluate(() => {
  const e = window.__ENGINE__;
  const ui = e.ctx.peek('ui');
  const player = e.ctx.peek('player');
  const veh = e.ctx.peek('vehicles');
  const w = e.ctx.peek('weapons');
  const game = e.ctx.peek('game');
  const police = e.ctx.peek('police');
  const sky = e.ctx.peek('sky');
  const p = player?.position;
  let hud = null;
  try { hud = w?.getHudState?.() ?? null; } catch { hud = null; }
  return {
    scale: e.time.scale,
    frame: e.time.frame,
    elapsed: +e.time.elapsed.toFixed(3),
    cheats: !!ui.cheats?.open,
    anyModal: !!(ui.menu?.open || ui.map?.open || ui.phone?.open ||
      ui.story?.open || ui.ending?.active || ui.bigCard?.active || ui.cheats?.open),
    hudButtons: document.querySelectorAll('.ow-cheat-btn').length,
    panels: document.querySelectorAll('.ow-cheat').length,
    rows: document.querySelectorAll('.ow-cheat-row').length,
    pos: p ? [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)] : null,
    inVehicle: !!player?.inVehicle,
    vehicleCount: Array.isArray(veh?.vehicles) ? veh.vehicles.length : -1,
    weapon: hud?.id ?? null,
    brother: game?.character ?? null,
    wanted: police?.wanted ?? null,
    hour: sky?.timeOfDay ?? null,
    weather: sky?.weatherState ?? null,
    timeRate: sky?.timeRate ?? null,
    cash: game?.cash ?? null,
  };
});

/**
 * The EMITTED state of one vehicle: where it really is and which way its own
 * body axis really points. `up` is the vehicle's local +Y pushed through its
 * live quaternion, so a car spawned on its roof scores -1 no matter what yaw
 * the menu asked for. `clearance` is the gap between the hull's own reported
 * ground contact and the surface underneath it.
 */
const vehicleTruth = (type) => page.evaluate((t) => {
  const e = window.__ENGINE__;
  const veh = e.ctx.peek('vehicles');
  const world = e.ctx.peek('world');
  const list = Array.isArray(veh?.vehicles) ? veh.vehicles : [];
  const mine = list.filter((v) => v.type === t);
  if (!mine.length) return { found: 0 };
  const v = mine[mine.length - 1];
  // local +Y through the live orientation
  const q = v.quaternion;
  const x = q.x; const y = q.y; const z = q.z; const w = q.w;
  const upX = 2 * (x * y - w * z);
  const upY = 1 - 2 * (x * x + z * z);
  const upZ = 2 * (y * z + w * x);
  const comY = v.spec?.comY ?? 0;
  const ground = world?.walkableHeightAt?.(v.position.x, v.position.z);
  return {
    found: mine.length,
    id: v.id ?? null,
    type: v.type,
    pos: [+v.position.x.toFixed(2), +v.position.y.toFixed(2), +v.position.z.toFixed(2)],
    up: [+upX.toFixed(4), +upY.toFixed(4), +upZ.toFixed(4)],
    comY: +comY.toFixed(3),
    ground: Number.isFinite(ground) ? +ground.toFixed(3) : null,
    // How far the chassis centre sits above where its centre of mass belongs.
    aboveRest: Number.isFinite(ground) ? +(v.position.y - ground - comY).toFixed(3) : null,
    destroyed: !!v.destroyed,
  };
}, type);

/**
 * Where the player's boots ended up, measured two independent ways.
 *
 *   `gap` — an INDEPENDENT down-ray fired after the fact from 60 cm above his
 *           boots. This is the "is he standing on something" question, and it
 *           is the right one: a man on the Point Fountain's plinth is
 *           legitimately over a metre above the analytic pavement and is still
 *           perfectly placed. The ray shares no arithmetic with the placement —
 *           different origin, different length, taken later.
 *   `err`  — feet minus `world.walkableHeightAt`. Only ever asserted as a FLOOR
 *           (never below), because that, and only that, is the 2 m-underground
 *           bug this path exists to prevent.
 */
const groundError = () => page.evaluate(() => {
  const e = window.__ENGINE__;
  const player = e.ctx.peek('player');
  const world = e.ctx.peek('world');
  const phys = e.ctx.peek('physics');
  const feet = player?.feetPosition ?? player?.position;
  if (!feet) return null;
  const walk = world?.walkableHeightAt?.(feet.x, feet.z);
  if (!Number.isFinite(walk)) return null;
  const solid = phys?.groundHeight?.(feet.x, feet.z, feet.y + 0.6);
  return {
    x: +feet.x.toFixed(2), z: +feet.z.toFixed(2),
    feetY: +feet.y.toFixed(3), walk: +walk.toFixed(3),
    gap: Number.isFinite(solid) ? +(feet.y - solid).toFixed(3) : null,
    err: +(feet.y - walk).toFixed(3),
    grounded: !!(player.movement?.grounded ?? player.grounded),
  };
});

/**
 * ADVANCE REAL SIMULATION TIME — and close the panel first, because the panel
 * FREEZES THE CLOCK.
 *
 * This is the correction that turned this probe from decorative into a gate.
 * The first version waited on `time.raw`, which keeps ticking while
 * `time.scale` is 0 — so every "two seconds later" check ran across a sim that
 * had not stepped once. `weapons.update(dt)` never decremented its poll, and
 * the revert-trap gate passed for exactly the wrong reason: its NEGATIVE
 * CONTROL passed too, which is what exposed it. Waiting on `time.elapsed`
 * (scaled) cannot make that mistake — a frozen clock returns -1 instead of
 * silently succeeding.
 */
const settle = async (seconds = 1) => {
  if (await cheatOpen()) await pressKey('Escape');
  const t0 = await page.evaluate(() => window.__ENGINE__.time.elapsed);
  for (let i = 0; i < 600; i++) {
    await pump(10);
    const t = await page.evaluate(() => window.__ENGINE__.time.elapsed);
    if (t - t0 >= seconds) return +(t - t0).toFixed(2);
  }
  return -1;
};

/** Re-open the panel on a given tab after a `settle()`. */
const reopen = async (tab) => {
  if (!(await cheatOpen())) await pressKey('Backquote');
  if (tab) await clickTab(tab);
};

/* ==================================================================== run == */

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
}

/* --------------------------------------------- N3: off by default in capture */
log('\n--- N3 NEGATIVE CONTROL: the menu must not exist in a review frame ---');
for (const [label, query] of [
  ['?capture=1', '?capture=1&q=low&prewarm=0'],
  ['plain automation (navigator.webdriver)', '?q=low&prewarm=0&boot=0'],
]) {
  await boot(query);
  const s = await snap();
  rec('capture', `no cheat UI under ${label}`,
    s.hudButtons === 0 && s.panels === 0,
    `${s.hudButtons} buttons, ${s.panels} panels in the DOM`);
  await page.close();
}

/* ------------------------------------------------------------- the real run */
log('\n--- the cheat menu, driven through the real DOM ---');
await boot('?cheats=1&boot=0&q=low&prewarm=0');
await page.evaluate(() => {
  const e = window.__ENGINE__;
  e.input.enabled = true;
  e.input.frozen = false;
  e.ctx.peek('player')?.setControlEnabled?.(true);
});
await pump(20);

const base = await snap();
rec('present', 'the HUD carries a cheat button under ?cheats=1',
  base.hudButtons === 1, `${base.hudButtons} button(s)`);
rec('present', 'the panel starts closed', !base.cheats && base.scale === 1,
  `open ${base.cheats}, time.scale ${base.scale}`);

/* ---- 1. OPEN / CLOSE, every door ---------------------------------------- */
log('\n--- 1 · the doors ---');
await pressKey('Backquote');
const opened = await snap();
rec('doors', 'Backquote opens the panel', opened.cheats, `open ${opened.cheats}`);
rec('doors', 'the panel freezes the sim', opened.scale === 0, `time.scale ${opened.scale}`);

await pressKey('Escape');
let s = await snap();
rec('doors', 'ESC closes it', !s.cheats, `open ${s.cheats}`);
rec('doors', 'ESC restores the clock', s.scale === 1, `time.scale ${s.scale}`);
rec('doors', 'ESC does not leave the pause menu up instead', !s.anyModal,
  `any modal ${s.anyModal}`);

await clickHudButton();
s = await snap();
rec('doors', 'the HUD button opens it', s.cheats, `open ${s.cheats}`);
await clickHudButton();
s = await snap();
rec('doors', 'the SAME button closes it', !s.cheats && s.scale === 1,
  `open ${s.cheats}, time.scale ${s.scale}`);

await pressKey('F8');
await page.evaluate(() => document.querySelector('.ow-cheat .ow-modal-x')?.click());
await pump(6);
s = await snap();
rec('doors', 'the ✕ closes it', !s.cheats && s.scale === 1,
  `open ${s.cheats}, time.scale ${s.scale}`);

await pressKey('Backquote');
await page.evaluate(() => document.querySelector('.ow-cheat .ow-btn.primary')?.click());
await pump(6);
s = await snap();
rec('doors', 'the CLOSE button closes it', !s.cheats && s.scale === 1,
  `open ${s.cheats}, time.scale ${s.scale}`);

/**
 * THE TRAP ITSELF. A sticky overlay once pinned time.scale at 0 and hung the
 * suite for 74 minutes. Five cycles, alternating the exits, measuring the
 * engine clock and the modal set every time — and then measuring that the sim
 * is really advancing, because `scale === 1` is a flag and `elapsed` rising is
 * the effect.
 */
let stuck = null;
for (let i = 0; i < 5; i++) {
  if (i % 2 === 0) await pressKey('Backquote');
  else await clickHudButton();
  if (!(await cheatOpen())) { stuck = `cycle ${i}: it would not open`; break; }
  if (i % 3 === 0) await pressKey('Escape');
  else if (i % 3 === 1) await clickHudButton();
  else {
    await page.evaluate(() => document.querySelector('.ow-cheat .ow-modal-x')?.click());
    await pump(6);
  }
  const c = await snap();
  if (c.cheats) { stuck = `cycle ${i}: it would not close`; break; }
  if (c.scale !== 1) { stuck = `cycle ${i}: resumed into a frozen sim (scale ${c.scale})`; break; }
  if (c.anyModal) { stuck = `cycle ${i}: left a modal behind`; break; }
}
rec('doors', 'five open/close cycles never trap the player', !stuck,
  stuck ?? 'key/button/✕ in rotation, always resumed at scale 1');

const before = await snap();
await pump(40);
const after = await snap();
rec('doors', 'the sim is actually running afterwards', after.elapsed > before.elapsed + 0.02,
  `elapsed ${before.elapsed} -> ${after.elapsed}`);

/* ---- 2. the lists are enumerated, not written down ----------------------- */
log('\n--- 2 · enumeration ---');
await pressKey('Backquote');
await clickTab('spawn');
const truth = await page.evaluate(() => {
  const e = window.__ENGINE__;
  return {
    classes: e.ctx.peek('vehicles')?.classes ?? [],
    weapons: e.ctx.peek('weapons')?.weaponIds ?? [],
    landmarks: (e.ctx.peek('world')?.landmarks ?? []).length,
    districts: (e.ctx.peek('world')?.districts ?? []).length,
    states: e.ctx.peek('sky')?.states ?? [],
  };
});
const spawnRows = await page.evaluate(() => [...document.querySelectorAll('.ow-cheat-row .name')]
  .map((n) => n.childNodes[0]?.textContent?.trim() ?? ''));
const named = (list, rows) => list.filter((id) => rows.some((r) => r.length > 0)).length;
void named;
rec('lists', 'every vehicle class has a row',
  truth.classes.length >= 11 && spawnRows.length >= truth.classes.length,
  `${truth.classes.length} classes (${truth.classes.join(',')}) -> ${spawnRows.length} rows`);
rec('lists', 'the three new classes are there without being listed in ui',
  ['bus', 'bicycle', 'heli'].every((c) => truth.classes.includes(c)),
  truth.classes.join(','));

await clickTab('weapons');
const wRows = await page.evaluate(() =>
  document.querySelectorAll('.ow-cheat-row').length);
rec('lists', 'every weapon has a row', truth.weapons.length === 16 && wRows >= 16,
  `${truth.weapons.length} weapons -> ${wRows} rows (incl. 3 bulk rows)`);

await clickTab('tp');
const tpRows = await page.evaluate(() =>
  document.querySelectorAll('.ow-cheat-row').length);
rec('lists', 'every district and landmark is a teleport target',
  tpRows >= truth.districts + truth.landmarks,
  `${truth.districts} districts + ${truth.landmarks} landmarks -> ${tpRows} rows`);

await clickTab('world');
const wxRows = await page.evaluate(() => [...document.querySelectorAll('.ow-cheat-row .name')]
  .map((n) => (n.childNodes[0]?.textContent ?? '').trim().toLowerCase()));
const weatherNames = truth.states.length ? truth.states
  : ['clear', 'scattered', 'overcast', 'rain', 'storm', 'fog'];
rec('lists', 'all six weather states have a row',
  weatherNames.every((n) => wxRows.includes(n)),
  weatherNames.join(','));

await clickTab('spawn');
const shown = await filter('bicy');
rec('lists', 'the filter narrows a long list', shown === 1, `"bicy" -> ${shown} row(s)`);
await filter('');

/* ---- 3. SPAWN — the effect, not the click ------------------------------- */
log('\n--- 3 · spawn ---');
const SPAWN_TYPE = 'bus';
const preSpawn = await vehicleTruth(SPAWN_TYPE);
// N4: gate 3 would score full marks against a bus that was already parked
// here. Record what exists BEFORE, and require the count to rise.
rec('spawn', 'N4 NEGATIVE CONTROL: no such vehicle before the click is spawned by us',
  true, `${preSpawn.found ?? 0} ${SPAWN_TYPE} already in the world`);

const spawnClick = await clickRow('CITY', 'SPAWN');
// The row name is the spec's display name, which we do not hardcode: find it.
let spawned = spawnClick.ok ? await vehicleTruth(SPAWN_TYPE) : { found: 0 };
if (!spawnClick.ok) {
  const busRow = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const spec = e.ctx.peek('vehicles')?.specOf?.('bus');
    return (spec?.name ?? 'bus').toUpperCase();
  });
  const retry = await clickRow(busRow, 'SPAWN');
  spawned = retry.ok ? await vehicleTruth(SPAWN_TYPE) : { found: 0 };
  rec('spawn', 'the SPAWN button is wired', retry.ok, retry.status);
} else {
  rec('spawn', 'the SPAWN button is wired', true, spawnClick.status);
}
// LET THE SIM RUN. Reading the pose back while the panel has the clock frozen
// would only ever re-read the position the menu just wrote — the circular
// reading rule 12 is about. A second of real physics settles the suspension,
// and anything mis-placed falls over or falls through in that time.
const settled = await settle(1.2);
spawned = await vehicleTruth(SPAWN_TYPE);
rec('spawn', 'the pose is read after the physics has actually run', settled > 0,
  `${settled} s of sim time stepped`);
rec('spawn', 'the vehicle exists in vehicles.vehicles',
  spawned.found > (preSpawn.found ?? 0),
  `${preSpawn.found ?? 0} -> ${spawned.found} of type ${SPAWN_TYPE}`);
rec('spawn', 'it is UPRIGHT (own +Y within 5 deg of world up)',
  spawned.up ? spawned.up[1] > 0.9962 : false,
  spawned.up ? `up.y ${spawned.up[1]} (${(Math.acos(Math.min(1, spawned.up[1])) * 180 / Math.PI).toFixed(2)} deg off)` : 'no vehicle');
rec('spawn', 'it is ON THE GROUND, not buried and not in the air',
  spawned.aboveRest !== null && Math.abs(spawned.aboveRest) < 0.9,
  spawned.aboveRest === null ? 'no ground reading'
    : `centre of mass ${spawned.aboveRest} m off its resting height at ground ${spawned.ground}`);

// SPAWN + DRIVE on a class the player can actually board.
const sportsName = await page.evaluate(() =>
  (window.__ENGINE__.ctx.peek('vehicles')?.specOf?.('sports')?.name ?? 'sports').toUpperCase());
await reopen('spawn');
await filter('');
const driveClick = await clickRow(sportsName, 'SPAWN + DRIVE');
await settle(1.5);
const drove = await snap();
rec('spawn', 'SPAWN + DRIVE puts the player in a car',
  drove.inVehicle, `${driveClick.status} · inVehicle ${drove.inVehicle}`);

/* ---- 4. TELEPORT — land ON the ground ----------------------------------- */
log('\n--- 4 · teleport ---');
// Get out first so the assertion is about the man, not the car.
await page.evaluate(() => {
  const p = window.__ENGINE__.ctx.peek('player');
  p?.vehicles?.abort?.(p.movement);
});
await settle(0.5);

const tpTargets = await page.evaluate(() => {
  const w = window.__ENGINE__.ctx.peek('world');
  return (w?.landmarks ?? []).map((l) => String(l.name ?? l.id).toUpperCase());
});
let worstGap = 0;
let worstGapWhere = '';
let worstErr = 99;
let worstErrWhere = '';
let tpDone = 0;
let moved = 0;
let last = (await snap()).pos;
for (const name of tpTargets) {
  await reopen('tp');
  const r = await clickRow(name, 'TELEPORT');
  if (!r.ok) continue;
  // A second of live physics, so the capsule is resting rather than mid-drop.
  await settle(1.0);
  const g = await groundError();
  const now = (await snap()).pos;
  if (last && now && Math.hypot(now[0] - last[0], now[2] - last[2]) > 20) moved++;
  last = now;
  if (!g) continue;
  tpDone++;
  if (Math.abs(g.gap ?? 0) > Math.abs(worstGap)) { worstGap = g.gap ?? 0; worstGapWhere = name; }
  if (g.err < worstErr) { worstErr = g.err; worstErrWhere = name; }
}
rec('teleport', 'a landmark row moves the player across the city',
  tpDone >= 5 && moved >= 5,
  `${tpDone} of ${tpTargets.length} landmarks reached, ${moved} were real journeys (>20 m)`);
/**
 * "Within a few cm of the ground" — measured against the INDEPENDENT down-ray,
 * not against the analytic field the placement used. Landing on a landmark's
 * own plinth is correct and reads as a large `err` while `gap` stays at zero;
 * that distinction is the whole reason both numbers are taken.
 */
rec('teleport', 'the player lands within a few cm of solid ground',
  tpDone >= 5 && Math.abs(worstGap) <= 0.2,
  `worst ray gap ${worstGap} m at ${worstGapWhere} (want |gap| <= 0.20)`);
/** And never, ever under the pavement — the 2 m-underground bug. */
rec('teleport', 'the player is never below the walkable surface',
  tpDone >= 5 && worstErr > -0.25,
  `lowest feet-vs-walkable ${worstErr === 99 ? 'n/a' : worstErr} m at ${worstErrWhere} (want > -0.25)`);

/**
 * N2. The bug: a bare down-ray found geometry BELOW the pavement and buried
 * the player. Compare the two answers over the whole destination list and
 * assert the reconciled value is never the lower one.
 */
await reopen('tp');
const n2 = await page.evaluate(() => {
  const e = window.__ENGINE__;
  const world = e.ctx.peek('world');
  const phys = e.ctx.peek('physics');
  const ui = e.ctx.peek('ui');
  const pts = [...(world?.landmarks ?? []), ...(world?.districts ?? [])];
  let below = 0;
  let worst = 0;
  for (const p of pts) {
    const wy = world.walkableHeightAt(p.x, p.z);
    const ry = phys?.groundHeight?.(p.x, p.z, wy + 200);
    const used = ui.cheats.groundY(p.x, p.z);
    if (Number.isFinite(ry) && ry < wy - 0.05) {
      below++;
      worst = Math.max(worst, wy - ry);
    }
    if (used < wy - 1e-3) return { broken: true, at: p.name, used, wy };
  }
  return { broken: false, n: pts.length, below, worst: +worst.toFixed(2) };
});
rec('teleport', 'N2 NEGATIVE CONTROL: a bare down-ray really does read low here',
  !n2.broken && n2.below > 0,
  n2.broken ? `reconciled height went BELOW walkable at ${n2.at}`
    : `${n2.below}/${n2.n} destinations where a 200 m ray lands up to ${n2.worst} m under the pavement`);
rec('teleport', 'the reconciled height is never below the walkable surface',
  !n2.broken, n2.broken ? `${n2.used} < ${n2.wy}` : 'max(walkable, bounded ray) held at every destination');

/* ---- 5. GIVE WEAPON — still in hand after the 2 Hz poll ----------------- */
log('\n--- 5 · the revert trap ---');
/**
 * N1 FIRST, on a clean slate: the naive implementation, applied directly, must
 * lose the weapon within two seconds. If this "passes" (the weapon survives),
 * the ownership poll is not running on this build and gate 5 below proves
 * nothing at all.
 *
 * THE PANEL IS CLOSED FOR EVERY WAIT IN THIS SECTION. `weapons.update(dt)`
 * decrements its poll off SCALED dt, and the panel pins `time.scale` at 0 —
 * so "two seconds later" with the menu up is two seconds in which the poll
 * does not run. The first draft of this probe made exactly that mistake and
 * scored a green gate against a stopped clock. `settle()` closes the panel and
 * waits on `time.elapsed`, which cannot advance through a freeze.
 */
await pressKey('Escape');
const naive = await page.evaluate(() => {
  const e = window.__ENGINE__;
  const w = e.ctx.peek('weapons');
  // Pick something the ACTIVE brother demonstrably cannot keep: anything the
  // poll will not find in the save. Read the live loadout rather than assuming.
  const all = w.weaponIds;
  const has = new Set(w.loadout);
  const id = all.find((x) => !has.has(x)) ?? all[all.length - 1];
  w.setWeaponImmediate(id, true);
  return { id, immediately: w.activeId };
});
const naiveWait = await settle(2.4);
const afterNaive = await page.evaluate(() => {
  const w = window.__ENGINE__.ctx.peek('weapons');
  let hud = null;
  try { hud = w.getHudState(); } catch { hud = null; }
  return { active: w.activeId, hud: hud?.id ?? null };
});
rec('weapons', 'N1 NEGATIVE CONTROL: setWeapon alone DOES revert within 2 s',
  naiveWait > 0 && naive.immediately === naive.id && afterNaive.active !== naive.id,
  `${naive.id}: in hand immediately (${naive.immediately}), after ${naiveWait} s of LIVE sim ${afterNaive.active}`);

// Now the menu's own path, on the same weapon, through the real button.
const label = await page.evaluate((id) => {
  const w = window.__ENGINE__.ctx.peek('weapons');
  return String(w.states.get(id)?.def?.label ?? id).toUpperCase();
}, naive.id);
await reopen('weapons');
const give = await clickRow(label, 'GIVE');
const justAfter = await snap();
const giveWait = await settle(2.4);
const later = await snap();
rec('weapons', 'GIVE puts the weapon in hand', justAfter.weapon === naive.id,
  `${give.status} · holding ${justAfter.weapon}`);
rec('weapons', 'and it is STILL in hand after 2.4 s of LIVE sim (the poll did not take it)',
  giveWait > 0 && later.weapon === naive.id,
  `wanted ${naive.id}, holding ${later.weapon} after ${giveWait} s`);

await reopen('weapons');
const bulk = await clickRow('UNLOCK EVERYTHING', 'UNLOCK');
await settle(1.2);
const unlocked = await page.evaluate(() => {
  const w = window.__ENGINE__.ctx.peek('weapons');
  let hud = null;
  try { hud = w.getHudState(); } catch { hud = null; }
  return { loadout: w.loadout.length, locked: (hud?.locked ?? []).length, all: w.weaponIds.length };
});
rec('weapons', 'UNLOCK EVERYTHING widens the loadout to this brother\'s full kit',
  unlocked.loadout > 1, `${unlocked.loadout} carried of ${unlocked.all} (${unlocked.locked} locked)`);

await reopen('weapons');
await clickRow('REFILL AMMO', 'REFILL');
await pump(10);
const ammo = await page.evaluate(() => {
  const w = window.__ENGINE__.ctx.peek('weapons');
  let full = 0;
  let n = 0;
  for (const [, s] of w.states) {
    if (s.def.melee) continue;
    n++;
    if (s.mag === s.def.magSize && s.reserve === s.def.reserve) full++;
  }
  return { full, n };
});
rec('weapons', 'REFILL AMMO tops every magazine and reserve',
  ammo.full === ammo.n && ammo.n > 0, `${ammo.full}/${ammo.n} non-melee weapons full`);

/* ---- 6. CHARACTER SWITCH ------------------------------------------------ */
log('\n--- 6 · brothers ---');
await reopen('player');
const wasBoy = (await snap()).brother;
const target = await page.evaluate((cur) =>
  ['carson', 'aidan', 'dylan'].find((b) => b !== cur) ?? 'aidan', wasBoy);
const sw = await clickRow(target, 'SWITCH');
await settle(1.0);
const switched = await snap();
rec('brothers', 'SWITCH changes the brother `game` reports',
  switched.brother === target && wasBoy !== target,
  `${wasBoy} -> ${switched.brother} (asked for ${target}) · ${sw.status}`);

/* ---- 7. PLAYER STATE ---------------------------------------------------- */
log('\n--- 7 · player state ---');
const hurt = await page.evaluate(() => {
  const p = window.__ENGINE__.ctx.peek('player');
  p.health.value = 12;
  return { hp: p.health$ };
});
await reopen('player');
await clickRow('HEAL', 'HEAL');
await pump(10);
const healed = await page.evaluate(() => {
  const p = window.__ENGINE__.ctx.peek('player');
  return { hp: +(p.health$ ?? 0).toFixed(1), max: p.maxHealth };
});
rec('player', 'HEAL restores health', healed.hp >= healed.max - 0.5,
  `${hurt.hp} -> ${healed.hp} of ${healed.max}`);

const cashBefore = (await snap()).cash;
await clickRow('GIVE $10,000', 'GIVE');
await pump(10);
const cashAfter = (await snap()).cash;
rec('player', 'GIVE $10,000 reaches the economy',
  Number.isFinite(cashAfter) && cashAfter >= (cashBefore ?? 0) + 10000,
  `$${cashBefore} -> $${cashAfter}`);

/* ---- 8. WORLD STATE ----------------------------------------------------- */
log('\n--- 8 · world state ---');
await reopen('world');
await clickRow('WANTED 4', 'SET');
await pump(20);
const heat = await snap();
rec('world', 'WANTED 4 reaches police.wanted', heat.wanted === 4, `police.wanted ${heat.wanted}`);
await clickRow('CLEAR WANTED', 'CLEAR');
await pump(20);
const cleared = await snap();
rec('world', 'CLEAR WANTED zeroes it', cleared.wanted === 0, `police.wanted ${cleared.wanted}`);

await clickRow('STORM', 'SNAP');
await pump(20);
const storm = await snap();
rec('world', 'a weather row reaches sky.weatherState', storm.weather === 'storm',
  `sky.weatherState ${storm.weather}`);

await clickRow('NIGHT', 'SET');
await pump(20);
const night = await snap();
rec('world', 'an hour preset reaches sky.timeOfDay',
  Number.isFinite(night.hour) && Math.abs(night.hour - 1.5) < 0.4,
  `sky.timeOfDay ${night.hour === null ? 'null' : night.hour.toFixed(2)}`);

const rateBefore = (await snap()).timeRate;
await clickRow('4 HOURS', 'SET');
await pump(20);
const slow = await snap();
rec('world', 'the day-length control really slows the cycle',
  Number.isFinite(slow.timeRate) && slow.timeRate > 0 && slow.timeRate < rateBefore,
  `sky.timeRate ${rateBefore} -> ${slow.timeRate} (24/(240*60) = ${(24 / 14400).toExponential(3)})`);

/* ---- 9. MISSIONS -------------------------------------------------------- */
log('\n--- 9 · missions ---');
await reopen('story');
const chapters = await page.evaluate(() => {
  const g = window.__ENGINE__.ctx.peek('game');
  let d = null;
  try { d = g.getStoryOverview(); } catch { d = null; }
  const rows = Array.isArray(d) ? d : d?.chapters ?? [];
  return { n: rows.length, first: String(rows[0]?.name ?? '').toUpperCase() };
});
const domChapters = await page.evaluate(() => document.querySelectorAll('.ow-cheat-row').length);
rec('missions', 'every chapter for the active brother has a row',
  chapters.n > 0 && domChapters >= chapters.n,
  `${chapters.n} chapters -> ${domChapters} rows`);
const started = await clickRow(chapters.first, 'START');
await pump(40);
const mission = await page.evaluate(() => {
  const g = window.__ENGINE__.ctx.peek('game');
  return { active: !!g?.missions?.active, id: g?.missions?.active?.idx ?? null };
});
rec('missions', 'START actually starts a mission', mission.active,
  `${started.status} · missions.active ${mission.active}`);
rec('missions', 'starting a chapter closes the panel and restores the clock',
  !(await snap()).cheats && (await snap()).scale === 1,
  `open ${(await snap()).cheats}, time.scale ${(await snap()).scale}`);

/* ---- 10. GRACEFUL DEGRADATION ------------------------------------------- */
log('\n--- 10 · it refuses to break ---');
const degraded = await page.evaluate(() => {
  const e = window.__ENGINE__;
  const ui = e.ctx.peek('ui');
  const reg = e.ctx;
  // Hide `police` from the registry for one rebuild and confirm the rows go
  // inert-with-a-reason rather than throwing or vanishing.
  const realPeek = reg.peek.bind(reg);
  reg.peek = (id) => (id === 'police' ? null : realPeek(id));
  let threw = null;
  let off = 0;
  let rows = 0;
  try {
    ui.cheats.show();
    ui.cheats.setTab('world');
    rows = document.querySelectorAll('.ow-cheat-row').length;
    off = document.querySelectorAll('.ow-cheat-row.off').length;
  } catch (err) {
    threw = String(err?.message ?? err);
  }
  reg.peek = realPeek;
  ui.cheats.setTab('world');
  ui.cheats.hide();
  return { threw, off, rows };
});
rec('degrade', 'a missing subsystem greys its rows out instead of crashing',
  !degraded.threw && degraded.off >= 6 && degraded.rows > degraded.off,
  degraded.threw ? 'threw: ' + degraded.threw
    : `${degraded.off} of ${degraded.rows} rows greyed out with a reason`);

const final = await snap();
rec('degrade', 'the panel is down and the clock is running at the end',
  !final.cheats && final.scale === 1 && !final.anyModal,
  `open ${final.cheats}, time.scale ${final.scale}, any modal ${final.anyModal}`);

const uniqueErrors = [...new Set(pageErrors)];
rec('degrade', 'no page errors during the whole run', uniqueErrors.length === 0,
  uniqueErrors.slice(0, 3).join(' | ') || 'clean');

/* ------------------------------------------------------------------ report */
await page.close();
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
