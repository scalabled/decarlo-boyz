#!/usr/bin/env node
/**
 * BLAST PROBE — "what does an explosion do to the people in the street?", as a
 * gate.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The canonical model does radial damage in one pass and it splits four ways:
 *
 *   enemies   inside radius        damage * (1 - d / radius)
 *   peds      inside radius        killed outright       -- NO FALLOFF
 *   vehicles  inside radius * 1.2  damage * (1 - d / (r * 1.2))
 *   player    inside radius        damage * 0.55 * (1 - d / r), and
 *                                  only when NOT in a vehicle
 *
 * Ours lives in four separate `explosion` listeners in four subsystems, which
 * is the right shape for this engine and also four separate opportunities to
 * drift. The ped listener had drifted furthest: `dmg * f * f` into a 100 HP
 * body, a SQUARED falloff on the one population the model applies no falloff
 * to at all. MEASURED through the real listener with the real payloads,
 * before the fix:
 *
 *   Scrap Rocket (200 dmg / 10 m splash)   lethal out to 2.9 m — 8% of the
 *                                          area the model clears
 *   car wreck (55 dmg / 7 m)               lethal NOWHERE: 47.4 of 100 HP at
 *                                          half a metre, 1.1 HP at 6 m
 *
 * An explosion in a crowded street did nothing to the crowd.
 *
 * A second defect was found while measuring the first, and it is the one that
 * would have made the fix worse than the bug: `CrowdGrid.query` returns ONE
 * array which it clears and refills on every call, `Ped._down` ends in
 * `sys.panic()`, and `panic` is a `grid.query`. So a death inside the listener
 * rewrote the array the listener was walking. Measured on the old code, one
 * 200 / 10 m blast into 24 people: five `grid.query` calls for one explosion,
 * and 5 of the 21 in range took the blast twice. Deaths were rare enough for
 * that to stay an oddity; once every civilian in the radius dies, EVERY
 * iteration re-enters.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT IS MEASURED, AND WHAT IS DELIBERATELY NOT
 * ---------------------------------------------------------------------------
 * Nothing here evaluates a falloff. There is no `1 - d / radius` in this file
 * and no copy of any damage constant `peds` owns. Every assertion reads what
 * the blast EMITTED:
 *
 *   - `ped.alive` after the real `explosion` event went through the real
 *     `PedSystem` listener, the real `Ped.applyDamage` / `Ped.die` and the
 *     real ragdoll hand-off;
 *   - `actor:death` events observed on the bus, which is the signal `police`
 *     prices, `game` counts and `ui` draws;
 *   - `ped.health`, the pool the rest of the engine reads.
 *
 * The two payloads are NOT written here either, because a probe that invents
 * its own numbers can only prove the code agrees with the probe:
 *
 *   - the Scrap Rocket's 200 damage and 10 m splash are read out of
 *     `src/weapons/lib.js`, a table this subsystem does not own or author;
 *   - the car wreck's payload is whatever `src/vehicles/damage.js` EMITS when
 *     a real `DamageModel` burns down its own fuse. This file never states 55
 *     or 7; it starts a wreck and listens.
 *
 * So the whole gate is a relationship between three independently owned
 * things, and re-tuning any one of them on its own is exactly what should
 * make it speak up.
 *
 * The lethal-radius assertions compare the measured lethal distance to the
 * PAYLOAD'S OWN radius, which is the rule stated as an outcome
 * ("everyone inside the blast dies, nobody outside it is touched"), not as an
 * echo of the arithmetic that produced it.
 *
 *   node src/peds/blastprobe.mjs
 *   node src/peds/blastprobe.mjs --verbose
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROL — a gate nobody has seen fail is not a gate
 * ---------------------------------------------------------------------------
 * Deliberately no `--break` flag: a flag that emulates the old behaviour is one
 * more thing that can accidentally agree with the code. Revert for real. The
 * three one-line reverts in `src/peds/index.js`, each of which turns a
 * different section red, with the output each produced:
 *
 *   civilian branch -> `p.applyDamage(dmg * f * f, ...)`   (the shipped bug)
 *       14/20.  CIVILIANS 4/6 — rocket kills 3 of 9 in range, lethal to 2.0 m
 *       of 10 m; wreck kills 0 of 9. CROWD 2/3 — 14 of 34 killed, 20 skipped.
 *   the `isHostile || isPolice || isCrew` test -> `false`  (no enemy split)
 *       14/20.  ENEMIES 2/6 — a 400 HP boss goes 400 -> 0 at 8 m, an officer
 *       100 -> 0 at 9.5 m, and the falloff is flat at -400 across the radius.
 *       CREW 1/3 — the brother is killed outright.
 *   the snapshot -> walk `near` (the grid's own reused array) directly
 *       19/20.  CROWD 2/3 — 24 of 34 in range killed, 10 never touched. Note
 *       how narrow that is: four of the five sections stay green, because the
 *       defect only shows in a crowd big enough to refill the buffer with a
 *       different set. A three-person test cannot see it.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { PedSystem } from './index.js';
import { Ped } from './ped.js';
import { CrowdGrid } from './nav.js';
import { makeOutfit } from './wardrobe.js';
import { DamageModel } from '../vehicles/damage.js';
import { ALL_WEAPONS } from '../weapons/lib.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const VERBOSE = !!args.verbose;

const results = [];
let failed = 0;
function check(section, name, ok, detail) {
  results.push({ section, name, ok, detail });
  if (!ok) failed++;
}

const NOOP = () => {};

/* ------------------------------------------------------------------ */
/* A headless city just rich enough for the real classes to run in.    */
/* ------------------------------------------------------------------ */

function makeCtx() {
  const listeners = new Map();
  return {
    time: { elapsed: 0 },
    events: {
      on(k, fn) {
        if (!listeners.has(k)) listeners.set(k, []);
        listeners.get(k).push(fn);
        return NOOP;
      },
      off: NOOP,
      emit(k, p) {
        const l = listeners.get(k);
        if (l) for (const fn of l.slice()) fn(p);
      },
    },
    peek: () => null,
    get: () => null,
  };
}

/**
 * A `PedSystem` that is REAL where it matters — the `explosion` listener under
 * test is installed by the production `_wireEvents`, `panic` is the production
 * method, the crowd index is the production `CrowdGrid` — and inert where the
 * city would otherwise have to exist. No damage arithmetic is restated.
 *
 * `_blast` is the listener's snapshot buffer, a constructor field rather than a
 * prototype one, so like `damageprobe.mjs` with `actorDamageScale` the harness
 * has to mirror it. Plumbing only: no assertion reads it.
 */
function makeSys(ctx) {
  const sys = {
    ctx,
    peds: [],
    grid: new CrowdGrid(4),
    _v: new THREE.Vector3(),
    _blast: [],
    crew: null,
    crewAuto: false,
    _crewTimer: 0,
    playerShotAt: -1e9,
    phys: null,
    probeFn: null,
    _hour: 12,
    _rain: 0,
    _off: [],
    _acquireBody: () => false,
    onPedPunch: NOOP,
    groundAt: () => 0,
    panic: PedSystem.prototype.panic,
    inRadius: PedSystem.prototype.inRadius,
  };
  PedSystem.prototype._wireEvents.call(sys, ctx);
  return sys;
}

let _seed = 20260728;

/**
 * One real pedestrian, through the real `wardrobe` and the real `Ped.spawn`.
 * `kind` picks which of the four populations he belongs to, exactly the way
 * the systems that own them mark their own people:
 *
 *   civilian   nothing set              — the ambient crowd
 *   hostile    `isHostile`, own hp      — `hostile.js` spawn()
 *   police     `isPolice`               — `police/officer.js` adopt()
 *   crew       `crew` record + `isCrew` — `crew.js` _adopt()
 *   driver     `vehicle`                — `PedSystem.attachDriver()`
 */
function addPed(sys, x, z, kind = 'civilian', opts = {}) {
  const rng = new Rng(_seed++);
  const p = new Ped(sys);
  p.spawn(makeOutfit(rng.fork(), 'street', { rain: 0 }), new THREE.Vector3(x, 0, z), 0, rng.fork());
  if (kind === 'hostile') {
    p.isHostile = true;
    p.maxHealth = opts.hp ?? 100;
    p.health = opts.hp ?? 100;
  } else if (kind === 'police') {
    p.isPolice = true;
  } else if (kind === 'crew') {
    p.isCrew = true;
    p.crew = { id: opts.id ?? 'aidan', friendlyHits: 0 };
  } else if (kind === 'driver') {
    p.vehicle = opts.vehicle ?? { isVehicle: true };
    p.seat = 0;
    p.isDriver = true;
  }
  p.kind = kind;
  sys.peds.push(p);
  return p;
}

/** A staged street: peds placed, grid built, `actor:death` recorded. */
function street() {
  const ctx = makeCtx();
  const sys = makeSys(ctx);
  const deaths = [];
  ctx.events.on('actor:death', (e) => deaths.push(e.actor));
  return {
    ctx,
    sys,
    deaths,
    add: (x, z, kind, opts) => addPed(sys, x, z, kind, opts),
    ready: () => sys.grid.rebuild(sys.peds),
    boom: (payload, x = 0, z = 0) => ctx.events.emit('explosion', {
      position: new THREE.Vector3(x, 0, z),
      radius: payload.radius,
      damage: payload.damage,
      source: payload.source ?? 'probe',
    }),
  };
}

/* ------------------------------------------------------------------ */
/* The two payloads, both taken from their owners, neither written here */
/* ------------------------------------------------------------------ */

/** The Scrap Rocket, as `src/weapons/lib.js` defines it. */
function rocketPayload() {
  const d = ALL_WEAPONS.rocket;
  if (!d) throw new Error('weapons/lib.js has no `rocket` — the probe cannot source a payload');
  return { radius: d.splash, damage: d.damage, source: 'rocket' };
}

/**
 * A car wreck, as `src/vehicles/damage.js` EMITS it. A real `DamageModel` on a
 * destroyed body, stepped on its own clock until its own fuse fires. Nothing
 * about the blast is stated here.
 */
function wreckPayload() {
  const ctx = makeCtx();
  let got = null;
  ctx.events.on('explosion', (e) => { got = { radius: e.radius, damage: e.damage, source: 'wreck' }; });
  const v = {
    destroyed: true, burning: 0.5, health: 0, maxHealth: 1000, smoke: 0,
    position: new THREE.Vector3(),
  };
  const dm = new DamageModel(v, {}, new Rng(7));
  for (let i = 0; i < 1200 && !got; i++) dm.update(1 / 60, ctx);
  if (!got) throw new Error('vehicles/damage.js never emitted a wreck blast — the probe cannot source a payload');
  return got;
}

const ROCKET = rocketPayload();
const WRECK = wreckPayload();

/* ================================================================== */
/* 1. CIVILIANS — everyone inside the blast dies, nobody outside is    */
/*    touched. The kill-outright branch, as an outcome.                */
/* ================================================================== */

/**
 * A line of civilians from the epicentre outwards, at fractions of the
 * payload's own radius plus two just outside it. Returns the measured lethal
 * distance and the untouched distance, in metres.
 */
function civilianLine(payload) {
  const r = payload.radius;
  const fr = [0.02, 0.1, 0.2, 0.3, 0.45, 0.6, 0.75, 0.9, 0.985, 1.0, 1.05, 1.4];
  const s = street();
  const peds = fr.map((f) => s.add(r * f, 0, 'civilian'));
  s.ready();
  const hp0 = peds.map((p) => p.health);
  s.boom(payload);
  const rows = fr.map((f, i) => ({
    d: r * f,
    inside: f < 1,
    alive: peds[i].alive,
    lost: hp0[i] - peds[i].health,
  }));
  return { rows, deaths: s.deaths.length, r };
}

for (const payload of [ROCKET, WRECK]) {
  const tag = payload.source === 'rocket' ? 'rocket' : 'wreck';
  const { rows, deaths, r } = civilianLine(payload);
  const insideRows = rows.filter((x) => x.inside);
  const outsideRows = rows.filter((x) => !x.inside);
  const killed = insideRows.filter((x) => !x.alive);
  const lethalTo = killed.length ? Math.max(...killed.map((x) => x.d)) : 0;
  const survivedOutside = outsideRows.every((x) => x.alive && x.lost === 0);

  check('CIVILIANS', `${tag}: every civilian inside the blast dies`,
    killed.length === insideRows.length,
    `${killed.length}/${insideRows.length} killed, lethal out to ${lethalTo.toFixed(1)} m of ${r} m`);
  check('CIVILIANS', `${tag}: nobody outside the blast is scratched`,
    survivedOutside,
    outsideRows.map((x) => `${x.d.toFixed(1)}m ${x.alive ? 'alive' : 'DEAD'} -${x.lost.toFixed(1)}`).join(' '));
  check('CIVILIANS', `${tag}: one actor:death emitted per body`,
    deaths === killed.length,
    `${deaths} events, ${killed.length} dead`);
  if (VERBOSE) {
    console.log(`\n  ${tag} ${payload.damage} dmg / ${r} m`);
    for (const x of rows) {
      console.log(`    ${x.d.toFixed(2).padStart(5)} m  ${x.inside ? 'in ' : 'out'}  ${x.alive ? 'alive' : 'DEAD '}  -${x.lost.toFixed(1)}`);
    }
  }
}

/* ================================================================== */
/* 2. ENEMIES — a hostile or an officer takes a FALLOFF, not a         */
/*    guillotine. The linear-falloff branch.                           */
/* ================================================================== */

{
  /* A boss is a `Ped` on this same path. If enemies were killed outright like
   * civilians, one rocket would be the answer to every chapter in the game. */
  const s = street();
  const boss = s.add(ROCKET.radius * 0.8, 0, 'hostile', { hp: 400 });
  const nearGoon = s.add(0.2, 0, 'hostile', { hp: 100 });
  const rimGoon = s.add(ROCKET.radius * 0.95, 0, 'hostile', { hp: 100 });
  const cop = s.add(ROCKET.radius * 0.95, 3, 'police');
  const civilian = s.add(ROCKET.radius * 0.8, -3, 'civilian');
  s.ready();
  const bossHp0 = boss.health;
  const copHp0 = cop.health;
  s.boom(ROCKET);

  check('ENEMIES', 'a 400 HP boss survives a rocket at 80% of its radius',
    boss.alive && boss.health > 0 && boss.health < bossHp0,
    `${bossHp0} -> ${boss.health.toFixed(1)} hp`);
  check('ENEMIES', '...while a civilian at the same distance is killed',
    !civilian.alive, `civilian alive=${civilian.alive}`);
  check('ENEMIES', 'a 100 HP goon at the epicentre still dies',
    !nearGoon.alive, `alive=${nearGoon.alive}, hp ${nearGoon.health.toFixed(1)}`);
  check('ENEMIES', 'a 100 HP goon at the rim walks away hurt',
    rimGoon.alive && rimGoon.health > 0 && rimGoon.health < 100,
    `hp ${rimGoon.health.toFixed(1)}`);
  check('ENEMIES', 'an officer takes the enemy falloff, not the civilian kill',
    cop.alive && cop.health < copHp0,
    `hp ${copHp0} -> ${cop.health.toFixed(1)}`);
}

{
  /* The falloff is a falloff: damage taken must fall monotonically with
   * distance. Measured as emitted HP loss on six bodies of equal health, never
   * as the expression that produced it. */
  const s = street();
  const at = [0.05, 0.2, 0.4, 0.6, 0.8, 0.95].map((f) => ROCKET.radius * f);
  const goons = at.map((d, i) => s.add(d, i * 0.01, 'hostile', { hp: 400 }));
  s.ready();
  s.boom(ROCKET);
  const lost = goons.map((g) => 400 - g.health);
  let monotone = true;
  for (let i = 1; i < lost.length; i++) if (lost[i] >= lost[i - 1]) monotone = false;
  check('ENEMIES', 'blast damage falls with distance for every step out',
    monotone && lost[0] > 0,
    lost.map((v, i) => `${at[i].toFixed(1)}m:-${v.toFixed(1)}`).join(' '));
}

/* ================================================================== */
/* 3. CREW — a brother is not liquidated by every grenade.             */
/* ================================================================== */

{
  const s = street();
  /* `Ped.applyDamage` routes a brother into `crew.hurt` and NEVER into `die`;
   * `crew.js` owns what happens next. What is asserted here is the routing and
   * the outcome — he is on his feet and no `actor:death` was raised for him —
   * plus the ratio between the two branches of the ally term. The absolute
   * amount is deliberately not asserted: that is `crew.js`'s number. */
  const seen = [];
  s.sys.crew = {
    ffWindow: 0,
    friendlyFireScale: 1,
    hurt: (rec, amount) => seen.push(amount),
  };
  /* All three at EXACTLY the same distance — on three different bearings, so
   * the only thing that differs between them is which population they are. */
  const d = ROCKET.radius * 0.5;
  const brother = s.add(d, 0, 'crew');
  const goon = s.add(-d, 0, 'hostile', { hp: 1000 });
  const civilian = s.add(0, d, 'civilian');
  s.ready();
  s.boom(ROCKET);
  const goonLost = 1000 - goon.health;

  check('CREW', 'a brother in the blast stays on his feet',
    brother.alive && seen.length === 1,
    `alive=${brother.alive}, crew.hurt calls ${seen.length}`);
  check('CREW', 'no actor:death is raised for a brother',
    !s.deaths.includes(brother) && s.deaths.includes(civilian),
    `${s.deaths.length} deaths, brother in them: ${s.deaths.includes(brother)}`);
  check('CREW', 'the ally share halves what an enemy takes at the same range',
    seen.length === 1 && Math.abs(seen[0] / goonLost - 0.5) < 1e-6,
    `brother ${seen[0]?.toFixed(1)} vs enemy ${goonLost.toFixed(1)}`);
}

/* ================================================================== */
/* 4. OCCUPANTS — in a car the blast does not touch you, because the   */
/*    car is taking it. The same rule the player gets.                 */
/* ================================================================== */

{
  const s = street();
  const d = WRECK.radius * 0.3;
  const driver = s.add(d, 0, 'driver');
  const walker = s.add(d, 1.5, 'civilian');
  s.ready();
  s.boom(WRECK);
  check('OCCUPANTS', 'a ped in a car is untouched by a blast at 30% of its radius',
    driver.alive && driver.health === 100,
    `alive=${driver.alive}, hp ${driver.health}`);
  check('OCCUPANTS', '...while the man standing beside the car is killed',
    !walker.alive, `alive=${walker.alive}`);
}

/* ================================================================== */
/* 5. CROWD INTEGRITY — every person in range is resolved exactly once. */
/*                                                                     */
/*    This is the snapshot. `grid.query` hands back one reused array,   */
/*    and every death in the loop re-enters it through `sys.panic`. The */
/*    crowd deliberately extends well past the panic radius, because    */
/*    that is what makes the refilled array SHORTER than the one the    */
/*    loop started on.                                                  */
/* ================================================================== */

{
  const s = street();
  const rng = new Rng(31337);
  const R = ROCKET.radius;
  const inRange = [];
  const outRange = [];
  /* Two rings and a scatter, none of it axis-aligned, so grid cell order is
   * not the same for the blast's query and for a death's panic query. */
  for (let i = 0; i < 34; i++) {
    const a = (i / 34) * Math.PI * 2 + 0.37;
    const rad = 0.4 + (i % 7) * 1.35;                 // 0.4 .. 8.5 m
    const p = s.add(Math.cos(a) * rad + 1.9, Math.sin(a) * rad - 1.3, 'civilian');
    inRange.push(p);
  }
  for (let i = 0; i < 26; i++) {
    const a = rng.range(0, Math.PI * 2);
    const rad = rng.range(R + 2, 46);                  // out past the 22 m panic
    s.add(Math.cos(a) * rad + 1.9, Math.sin(a) * rad - 1.3, 'civilian');
  }
  s.ready();
  const centre = new THREE.Vector3(1.9, 0, -1.3);
  const expect = s.sys.peds.filter((p) => p.position.distanceTo(centre) < R);
  const hp0 = new Map(s.sys.peds.map((p) => [p, p.health]));
  s.boom(ROCKET, centre.x, centre.z);

  const dead = s.sys.peds.filter((p) => !p.alive);
  const missed = expect.filter((p) => p.alive);
  const strays = s.sys.peds.filter((p) => p.position.distanceTo(centre) >= R && hp0.get(p) !== p.health);

  check('CROWD', 'every civilian inside the radius is killed, none skipped',
    missed.length === 0 && dead.length === expect.length,
    `${dead.length} killed of ${expect.length} in range, ${missed.length} skipped`);
  check('CROWD', 'nobody outside the radius loses health',
    strays.length === 0, `${strays.length} strays`);
  check('CROWD', 'actor:death count matches the bodies',
    s.deaths.length === dead.length, `${s.deaths.length} events, ${dead.length} bodies`);
  if (VERBOSE) {
    console.log(`\n  crowd ${s.sys.peds.length}, in range ${expect.length}, killed ${dead.length}`);
  }
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

const bySection = new Map();
for (const r of results) {
  if (!bySection.has(r.section)) bySection.set(r.section, []);
  bySection.get(r.section).push(r);
}

console.log('\nBLAST PROBE — explosions vs the street');
console.log(`  rocket payload  ${ROCKET.damage} dmg / ${ROCKET.radius} m   (weapons/lib.js)`);
console.log(`  wreck payload   ${WRECK.damage} dmg / ${WRECK.radius} m   (emitted by vehicles/damage.js)`);
for (const [section, rows] of bySection) {
  const pass = rows.filter((r) => r.ok).length;
  console.log(`\n${section}  ${pass}/${rows.length}`);
  for (const r of rows) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    if (!r.ok || VERBOSE) console.log(`        ${r.detail}`);
  }
}
const total = results.length;
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
