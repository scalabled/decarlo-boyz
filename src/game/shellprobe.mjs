#!/usr/bin/env node
/**
 * SHELL PROBE — the large-interior blind spot in the spawn escape test, and the
 * detector that closes it, gated against known geometry with a real negative
 * control.
 *
 *   node src/game/shellprobe.mjs
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS GUARDS
 *
 * `Director._trapped` asks its escape rays out to `ESCAPE_REACH` = 2.0 m, which
 * is right for a kerb, a stair riser or Carson's boathouse (walls within arm's
 * reach — 16 of 16 blocked, `open` collapses to 0). But a man standing in the
 * middle of a LARGE hollow shell has every wall 4-9 m away, so at 2 m every
 * ankle ray misses, every bearing counts as `open`, and `_trapped` declares open
 * ground inside a room he cannot leave. That is the reported class — "spawned
 * inside a building, could not get out" — for a shell bigger than the ankle
 * reach.
 *
 * `Director._enclosedShell` closes it: cast `SHELL_RAYS` rays to `SHELL_REACH`;
 * if NOT ONE clears, the walls close on every side and this is the inside of a
 * shell. `unstick` triggers on `_trapped OR _enclosedShell`, and relocates only
 * to a spot that is itself neither — so it can route a sealed brother to the
 * street and can never strand him somewhere worse.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A MOCK, NOT THE BROWSER (Rule 12, and honestly)
 *
 * The reported trap does NOT reproduce in the shipped city. Measured: Aidan's
 * fresh spawn resolves through the road network to open pavement (637,-457) and
 * he walks freely; and every "sealed" pocket found near the body shop turns out
 * to be a PROP RING (parked cars completing 14-15 of 16 bearings) that is gone
 * the moment the player is actually placed there via the switch path — leaving
 * 1-2 gaps he walks straight out through. A real building shell in this city has
 * ankle-height gaps (doorways, shopfronts) on some bearing, so `_enclosedShell`
 * correctly never fires on it. There is therefore no reliable in-game sealed
 * interior to seed, which is exactly why a browser gate here would be flaky, and
 * a flaky gate is worse than none (ARCHITECTURE rule 11).
 *
 * So the geometry is MOCKED — walls placed at distances this file chooses, which
 * are independent of anything the director computes (Rule 12). The assertion is
 * the EMITTED DECISION: does `_trapped`/`_enclosedShell` fire, and does `unstick`
 * move the player, and to where. The NEGATIVE CONTROL is `director.shellDetect =
 * false`: with the detector disabled, the large shell is NOT detected and the
 * brother is left where he is — trapped — which is the whole point of the case.
 * The browser side (`unstick`) still asserts the REAL emitted travel: fresh
 * Aidan walks.
 */
import { Director } from './director.js';

/* -------------------------------------------------------------------------- */
/* a fake ctx: just enough for _trapped / _enclosedShell / unstick             */
/* -------------------------------------------------------------------------- */

const MASK = { WORLD: 0b11 };

/**
 * A physics stand-in. `walls(ox, oz, angle)` returns the distance to the first
 * wall on that bearing from that point, or Infinity for a clear corridor. Ground
 * is flat at 0 unless `groundAt` says otherwise (for the staircase step-up).
 */
function makePhysics({ walls, groundAt } = {}) {
  return {
    MASK,
    raycast(a, b, c) {
      // object form only: raycast({x,y,z}, {x,y,z}, maxDist, mask)
      const ox = a.x, oz = a.z;
      const dx = b.x, dz = b.z;
      const maxDist = c;
      const angle = Math.atan2(dz, dx);
      const d = walls ? walls(ox, oz, angle) : Infinity;
      if (Number.isFinite(d) && d <= maxDist) return { hit: true, distance: d };
      return { hit: false };
    },
    groundHeight(x, z) {
      return groundAt ? groundAt(x, z) : 0;
    },
  };
}

function makeCtx(subs) {
  const bag = { sky: { setTimeOfDay() {}, hour: 9 }, ...subs };
  return {
    rng: { fork: () => ({ float: () => 0.5, fork: () => ({ float: () => 0.5 }) }) },
    events: { on: () => () => {} },
    peek: (id) => bag[id] ?? null,
    get: (id) => bag[id] ?? null,
    has: (id) => id in bag,
  };
}

/** A director wired to the given physics/world/player mocks. */
function director({ physics, world, player }) {
  const ctx = makeCtx({ physics, world, player });
  return new Director(ctx, {});
}

/* a sealed disc: inside radius r of (cx,cz), a wall at `wall` on every bearing,
 * except any bearing within `gap` radians of `gapAngle` (a doorway). */
function disc({ cx = 0, cz = 0, r, wall, gapAngle = null, gap = 0.12 }) {
  return (ox, oz, angle) => {
    if (Math.hypot(ox - cx, oz - cz) > r) return Infinity;          // outside: open
    if (gapAngle !== null) {
      let da = Math.abs(angle - gapAngle);
      da = Math.min(da, Math.PI * 2 - da);
      if (da <= gap) return Infinity;                               // the doorway
    }
    return wall;
  };
}

/* -------------------------------------------------------------------------- */
/* assertions                                                                 */
/* -------------------------------------------------------------------------- */

let pass = 0, fail = 0;
const rows = [];
function check(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  rows.push({ ok, name, got, want });
}

/* ── 1. the detector's decision, ON, against known geometry ─────────────── */

// LARGE shell: walls 5 m away on every bearing. Beyond ESCAPE_REACH (2 m), so
// `_trapped` is fooled (this is the blind spot); `_enclosedShell` catches it.
{
  const ph = makePhysics({ walls: disc({ r: 40, wall: 5 }) });
  const d = director({ physics: ph });
  check('large shell: _trapped is fooled (the blind spot)', d._trapped(0, 0, 0), false);
  check('large shell: _enclosedShell catches it', d._enclosedShell(0, 0, 0), true);
}

// SMALL shell (boathouse): walls 1.5 m away — inside the ankle reach.
{
  const ph = makePhysics({ walls: disc({ r: 40, wall: 1.5 }) });
  const d = director({ physics: ph });
  check('small shell: _trapped already catches it', d._trapped(0, 0, 0), true);
  check('small shell: _enclosedShell also true', d._enclosedShell(0, 0, 0), true);
}

// A ROOM WITH A DOORWAY: walls 5 m, but one bearing clear. He can walk out, so
// neither test should fire — a gap is a way out.
{
  const ph = makePhysics({ walls: disc({ r: 40, wall: 5, gapAngle: 0 }) });
  const d = director({ physics: ph });
  check('room with a door: _enclosedShell does NOT fire', d._enclosedShell(0, 0, 0), false);
}

// A PROP RING with two gaps (the shipped-city false alarm): 5 m walls, gaps at
// 0 and PI. Must NOT read as sealed.
{
  const ph = makePhysics({
    walls: (ox, oz, a) => {
      const g0 = Math.min(Math.abs(a), Math.PI * 2 - Math.abs(a));
      const g1 = Math.abs(Math.abs(a) - Math.PI);
      return (g0 <= 0.2 || g1 <= 0.2) ? Infinity : 5;
    },
  });
  const d = director({ physics: ph });
  check('prop ring with gaps: _enclosedShell does NOT fire', d._enclosedShell(0, 0, 0), false);
}

// OPEN GROUND: no walls anywhere.
{
  const ph = makePhysics({ walls: () => Infinity });
  const d = director({ physics: ph });
  check('open ground: _trapped false', d._trapped(0, 0, 0), false);
  check('open ground: _enclosedShell false', d._enclosedShell(0, 0, 0), false);
}

// STAIRCASE (Dylan): no walls, but the ground one pace out steps up 1.0 m,
// double what he can climb. Caught by `_trapped`, invisible to the shell test.
{
  const ph = makePhysics({ walls: () => Infinity, groundAt: () => 1.0 });
  const d = director({ physics: ph });
  check('staircase: _trapped catches the step-up', d._trapped(0, 0, 0), true);
  check('staircase: _enclosedShell does NOT (no walls)', d._enclosedShell(0, 0, 0), false);
}

/* ── 2. THE NEGATIVE CONTROL — detector OFF leaves the large shell undetected ─ */

{
  const ph = makePhysics({ walls: disc({ r: 40, wall: 5 }) });
  const d = director({ physics: ph });
  d.shellDetect = false;
  check('NEG CONTROL: large shell trapped-check OFF -> undetected',
    d._trapped(0, 0, 0) || d._enclosedShell(0, 0, 0), false);
  d.shellDetect = true;
  check('CONTROL: large shell trapped-check ON  -> detected',
    d._trapped(0, 0, 0) || d._enclosedShell(0, 0, 0), true);
}

/* ── 3. unstick RELOCATES a sealed brother to open ground, and never worse ── */

function scene({ walls, spawnPoints = [{ position: { x: 1000, y: 0, z: 0 }, yaw: 0 }] }) {
  const player = {
    feetPosition: { x: 0, y: 0, z: 0 },
    yaw: 0,
    moved: false,
    teleport(p) { this.moved = true; this.dest = { x: p.x, z: p.z }; this.feetPosition = { x: p.x, y: p.y, z: p.z }; },
  };
  const world = {
    streamingIdle: () => true,
    isWater: () => false,
    surfaceAt: () => 'asphalt',
    spawnPoints,
    roads: null,
  };
  return { player, world, physics: makePhysics({ walls }) };
}

// Sealed disc radius 15 around origin, open beyond. unstick must move him OUT.
{
  const s = scene({ walls: disc({ r: 15, wall: 5 }) });
  const d = director(s);
  const moved = d.unstick(30);
  const outside = s.player.dest && Math.hypot(s.player.dest.x, s.player.dest.z) > 15;
  check('unstick: relocates a sealed brother', moved, true);
  check('unstick: destination is OUTSIDE the shell', !!outside, true);
}

// Same scene, detector OFF: the large shell is invisible, so nothing moves —
// the brother is left trapped. THE unstick-level negative control.
{
  const s = scene({ walls: disc({ r: 15, wall: 5 }) });
  const d = director(s);
  d.shellDetect = false;
  const moved = d.unstick(30);
  check('NEG CONTROL: unstick with detector OFF does not move him', moved, false);
}

// Sealed EVERYWHERE (no open ground within reach, and the road fallback point is
// itself sealed): unstick must NOT shove him to a still-sealed spot. The guard.
{
  const s = scene({ walls: () => 5 });   // every point, every bearing, walled at 5 m
  const d = director(s);
  const moved = d.unstick(30);
  check('guard: no open spot anywhere -> unstick refuses to relocate', moved, false);
  check('guard: player was not moved into another wall', s.player.moved, false);
}

/* -------------------------------------------------------------------------- */

console.log('\n=== shell detector (the large-interior blind spot) ===\n');
const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(w)}  got=${r.got} want=${r.want}`);
}
console.log(`\nshell: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
