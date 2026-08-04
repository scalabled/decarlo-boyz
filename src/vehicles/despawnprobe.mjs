#!/usr/bin/env node
/**
 * THE CAR NOBODY MAY DESPAWN — the mission-vehicle-despawn bug, as a gate.
 *
 * ---------------------------------------------------------------------------
 * THE BUG (reproduced below, scenario A)
 * ---------------------------------------------------------------------------
 * A mission delivery vehicle vanished out from under the player WHILE HE WAS
 * DRIVING IT: stranded, crouched on an empty road, with "LEAVE THE MILLHAND 6"
 * still on the HUD. It breaks every driving mission (deliver / timedDeliver /
 * escort / race).
 *
 * Root cause: `vehicles.despawn(v)` is the single chokepoint every cull path
 * funnels through (traffic recycle, props stream-out, police retire, dev shots,
 * and `game.cleanup`) and it had NO guard for the player's own car. The
 * protection was delegated to each caller, keyed on `game.playerVehicle()`
 * (`mission.cleanup`, `characters._parkCar`) or a private `_playerCar`
 * (`traffic`). `game.playerVehicle()` returns
 * `player?.inVehicle ? player.vehicle : null`, so it yields NULL whenever
 * `player` is unavailable or the derived `inVehicle` flag is out of step with
 * the seat — and the guard then despawns the car under a seated player. Nothing
 * steps a handle that has left `this.vehicles`, so the car freezes;
 * `player/vehicle.js` reacts only to `.destroyed`, never to "streamed out", so
 * the player is left seated in limbo with "LEAVE THE <car>" still on the HUD.
 *
 * Fix: the guard now lives at the chokepoint (`VehicleSystem.despawn`), where
 * every caller passes through, and reads the vehicle handle the player is in
 * (`player.vehicle`) plus the seat/occupant list — the authority on occupancy
 * across the whole enter/drive/exit lifetime, strictly wider than the
 * `inVehicle`-gated check. A live mission tag (`v.isMission`) is pinned too.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT IS ASSERTED, AND THE NEGATIVE CONTROL
 * ---------------------------------------------------------------------------
 * Every assertion reads the EMITTED result of the REAL `VehicleSystem.despawn`
 * / `TrafficSystem.recycle` running: is the handle still in the live
 * `vehicles[]` array, and is `model.root` still parented into the scene graph.
 * Nothing re-reads the guard's own boolean.
 *
 * The negative control is built in and runs every time: the SAME vehicle in the
 * SAME occupied/mission state is removed the moment the authorized-teardown
 * door is opened (`{ hard: true }` for the occupied car, `{ force: true }` for a
 * non-occupied mission car). That the removal machinery fires on demand is what
 * proves the "survives" assertions are not passing vacuously — strip the guard
 * and the unforced call would behave exactly like the forced one and the car
 * would vanish, which is the shipped bug.
 *
 *   node src/vehicles/despawnprobe.mjs [--verbose]
 */

import * as THREE from 'three';
import { VehicleSystem } from './index.js';
import { TrafficSystem } from '../traffic/index.js';

const VERBOSE = process.argv.includes('--verbose');

let failed = 0;
const rows = [];
function check(section, name, ok, detail = '') {
  rows.push({ section, name, ok, detail });
  if (!ok) failed++;
}

/* ------------------------------------------------------------------ */
/* A vehicle handle with exactly the surface `despawn` touches.        */
/* ------------------------------------------------------------------ */
function stubVeh() {
  const parent = new THREE.Group();
  const root = new THREE.Group();
  parent.add(root); // so `root.parent` is non-null until despawn nulls it
  return {
    model: { root, panels: [], lampMats: {} },
    damage: { _cloned: new Set() },
    occupants: [],
    driver: null,
    isMission: false,
  };
}

/** EMITTED state: the handle is live AND still in the scene graph. */
function present(sys, v) {
  return sys.vehicles.includes(v) && v.model.root.parent !== null;
}
function gone(sys, v) {
  return !sys.vehicles.includes(v) && v.model.root.parent === null;
}

/* ------------------------------------------------------------------ */
/* A VehicleSystem that is REAL on every path under test.              */
/* ------------------------------------------------------------------ */
function makeSys() {
  let playerVeh = null;
  const player = { isPlayer: true, get vehicle() { return playerVeh; } };
  const ctx = { peek: (id) => (id === 'player' ? player : null) };
  const sys = {
    ctx,
    vehicles: [],
    _hidden: [],
    despawn: VehicleSystem.prototype.despawn,
    _playerAboard: VehicleSystem.prototype._playerAboard,
    _playerVehicle: VehicleSystem.prototype._playerVehicle,
    _isPlayerActor: VehicleSystem.prototype._isPlayerActor,
    seat(v) { playerVeh = v; },
    clearSeat() { playerVeh = null; },
    player,
  };
  return sys;
}

function add(sys) {
  const v = stubVeh();
  sys.vehicles.push(v);
  return v;
}

/* ================================================================== */
/* SECTION: chokepoint                                                 */
/* ================================================================== */

// -- A. THE REPORTED BUG: an occupied mission car is despawned by a caller ----
// whose `game.playerVehicle()`-keyed guard read null (player unavailable, or the
// inVehicle flag out of step with the seat). `player.vehicle` still points at
// the car, so the chokepoint must refuse the unforced despawn.
{
  const sys = makeSys();
  const v = add(sys);
  v.isMission = true;
  sys.seat(v);                 // player.vehicle === v (set from tryEnter onward)
  sys.despawn(v);              // exactly what game.cleanup issues, unforced
  check('chokepoint', 'A: occupied mission car survives an unforced cull',
    present(sys, v), `present=${present(sys, v)}`);

  // Negative control: open the hard-teardown door on the identical state and
  // the very same machinery removes it — so the assertion above is real.
  sys.despawn(v, { hard: true });
  check('chokepoint', 'A(neg): hard teardown DOES remove the same car',
    gone(sys, v), `gone=${gone(sys, v)}`);
}

// -- B. occupied via occupants[] even if player.vehicle is momentarily null --
{
  const sys = makeSys();
  const v = add(sys);
  sys.clearSeat();
  v.occupants = [sys.player];
  sys.despawn(v);
  check('chokepoint', 'B: occupied-by-occupants survives', present(sys, v));
}

// -- C. occupied via v.driver -----------------------------------------------
{
  const sys = makeSys();
  const v = add(sys);
  sys.clearSeat();
  v.driver = sys.player;
  sys.despawn(v);
  check('chokepoint', 'C: occupied-by-driver survives', present(sys, v));
}

// -- D. a live mission car the player is NOT in survives culls ---------------
{
  const sys = makeSys();
  const v = add(sys);
  v.isMission = true;          // not occupied
  sys.despawn(v);              // a stream/distance cull
  check('chokepoint', 'D: unoccupied mission car survives cull', present(sys, v));

  // Negative control: mission cleanup forces it and it goes.
  sys.despawn(v, { force: true });
  check('chokepoint', 'D(neg): force teardown removes mission car', gone(sys, v));
}

// -- E. force tears down a mission but STILL will not evict a seated player ---
{
  const sys = makeSys();
  const v = add(sys);
  v.isMission = true;
  sys.seat(v);
  sys.despawn(v, { force: true });   // cleanup racing the boarding animation
  check('chokepoint', 'E: force keeps a car the player occupies', present(sys, v));
  sys.despawn(v, { hard: true });
  check('chokepoint', 'E(neg): hard override finally removes it', gone(sys, v));
}

// -- F. an ordinary car (not player, not mission) still culls normally --------
{
  const sys = makeSys();
  const v = add(sys);
  sys.despawn(v);
  check('chokepoint', 'F: ordinary car still despawns (no over-block)', gone(sys, v));
}

/* ================================================================== */
/* SECTION: traffic — the recycle path funnels here too               */
/* ================================================================== */
function makeTraffic(vehSys, playerVeh) {
  return {
    ctx: { peek: () => null },
    drivers: [],
    _byVehicle: new Map(),
    _stats: { despawns: 0, recycled: 0 },
    parking: { forget() {} },
    vehicles: vehSys,
    _playerCar: null,
    playerVehicle: () => playerVeh,
    _unseatPed() {},
    isPlayerVehicle: TrafficSystem.prototype.isPlayerVehicle,
    recycle: TrafficSystem.prototype.recycle,
  };
}

// -- traffic recycle refuses the player's car -------------------------------
{
  const sys = makeSys();
  const v = add(sys);
  const t = makeTraffic(sys, v);
  const driver = { vehicle: v, release() {} };
  t.drivers.push(driver);
  const ret = t.recycle(driver, 'far');
  check('traffic', 'recycle refuses the player car',
    ret === false && present(sys, v) && t.drivers.includes(driver),
    `ret=${ret} present=${present(sys, v)}`);
}

// -- traffic recycle refuses a mission car ----------------------------------
{
  const sys = makeSys();
  const v = add(sys);
  v.isMission = true;
  const t = makeTraffic(sys, null); // player not in it
  const driver = { vehicle: v, release() {} };
  t.drivers.push(driver);
  const ret = t.recycle(driver, 'far');
  check('traffic', 'recycle refuses a mission car',
    ret === false && present(sys, v), `ret=${ret} present=${present(sys, v)}`);
}

// -- traffic recycle STILL culls an ordinary AI car (negative control) -------
{
  const sys = makeSys();
  const v = add(sys);
  const t = makeTraffic(sys, null);
  const driver = { vehicle: v, release() {} };
  t.drivers.push(driver);
  const ret = t.recycle(driver, 'far');
  check('traffic', 'recycle still culls an ordinary car',
    ret === true && gone(sys, v) && !t.drivers.includes(driver),
    `ret=${ret} gone=${gone(sys, v)}`);
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */
const bySection = new Map();
for (const r of rows) {
  if (!bySection.has(r.section)) bySection.set(r.section, []);
  bySection.get(r.section).push(r);
}
for (const [section, list] of bySection) {
  const pass = list.filter((r) => r.ok).length;
  console.log(`\n${section}: ${pass}/${list.length}`);
  for (const r of list) {
    if (!r.ok || VERBOSE) {
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
    }
  }
}

const total = rows.length;
const passed = total - failed;
console.log(`\ndespawnprobe: ${passed}/${total} ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
