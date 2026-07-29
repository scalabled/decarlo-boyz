/**
 * POLICE — the squad brain.
 *
 * One cruiser following you is a chase. Six cruisers all following you is a
 * parade, and it is the single most obvious tell of bad pursuit AI. This file
 * exists to make sure that at any moment most of the fleet is doing something
 * OTHER than driving at your back bumper:
 *
 *   slot 0        the tail. Exactly one car, ever.
 *   PIT           the nearest car that is already alongside your rear quarter,
 *                 in the speed window where a PIT actually works.
 *   INTERCEPT     the cars that are FURTHEST behind — they have the time to
 *                 take a different road and be standing across a junction on
 *                 your predicted route when you arrive. This is the behaviour
 *                 that makes the road graph matter.
 *   FLANK         at three stars and above, once you are slowed down, two cars
 *                 come up either side and box you.
 *   everyone else a numbered bearing slot around you, so the tail is a fan
 *                 rather than a queue.
 *
 * Roles are re-cut at `TUNE.tacticsHz`. Assignment is stable: a unit keeps its
 * role unless something better is available, because a car that changes its
 * mind twice a second reads as indecisive rather than tactical.
 */

import * as THREE from 'three';
import { ROLE } from './unit.js';
import { predictNode } from './path.js';
import { TUNE, clamp } from './tune.js';

const _v = new THREE.Vector3();
const _sorted = [];

/** Rough speed a cruiser averages across town, for ETA comparisons. */
const CRUISE = 19;

export function assignRoles(sys) {
  const q = sys.quarry;
  const level = sys.level;
  const units = sys.units;

  if (level === 0) {
    for (const u of units) if (u.active && u.role !== ROLE.LEAVE) setRole(u, ROLE.LEAVE);
    return;
  }

  /* ---- who is available for tactical assignment? --------------------- */
  _sorted.length = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (!u.active || !u.vehicle) continue;
    if (u.role === ROLE.BLOCK || u.role === ROLE.LEAVE) continue;
    _sorted.push(u);
  }
  if (!_sorted.length) return;

  // A cop who lost sight of you five seconds ago drives to where you WERE; he
  // does not immediately start sweeping a random cordon. The switch used to
  // come after 4 s, and with contact flickering at 83% through a normal chase
  // that meant the fleet kept dropping the pursuit to go and search — measured
  // as a fleet that closed from 181 m to 117 m over 70 s and never arrived.
  // `_chooseGoal` drives at `meter.known` while a unit has no line of sight, so
  // this window is a real pursuit of the last known position, not clairvoyance.
  if (!q.valid || (!sys.meter.seen && sys.meter.sinceSeen > TUNE.searchAfter)) {
    // Contact lost: everyone sweeps the cordon. Units that are already close to
    // the last known position keep pushing in; the rest fan out into it.
    for (const u of _sorted) if (u.role !== ROLE.SEARCH) setRole(u, ROLE.SEARCH);
    return;
  }

  for (const u of _sorted) {
    u._d = Math.hypot(
      u.vehicle.position.x - q.position.x,
      u.vehicle.position.z - q.position.z
    );
  }
  _sorted.sort(byDist);

  const n = _sorted.length;
  let maxIntercept = level >= 4 ? 2 : level >= 2 ? 1 : 0;
  // Never send everybody off to intercept — somebody has to stay on you.
  maxIntercept = Math.min(maxIntercept, Math.max(0, n - 1));
  const wantBox = level >= 3 && q.speed < 14 && n >= 3;
  const wantPit = level >= TUNE.pitFromLevel &&
    q.speed > TUNE.pitSpeedMin && q.speed < TUNE.pitSpeedMax;

  let pitDone = 0;
  const maxPit = level >= 4 ? 2 : 1;
  let interceptDone = 0;
  let boxLeft = false;
  let boxRight = false;
  let slot = 0;

  /* ---- 1. the tail ---------------------------------------------------- */
  // The closest unit that can actually see you takes the tail; if nobody can,
  // the closest one does.
  let tail = _sorted[0];
  for (const u of _sorted) {
    if (u.los) { tail = u; break; }
  }
  setRole(tail, ROLE.CHASE);
  tail.slot = 0;
  tail.holdPose = null;

  /* ---- 2. everyone else ---------------------------------------------- */
  for (let i = n - 1; i >= 0; i--) {
    const u = _sorted[i];
    if (u === tail) continue;

    // PIT: only from close behind and to one side, in the speed window.
    if (wantPit && pitDone < maxPit && u._d < 22 && behindAndBeside(u, q)) {
      setRole(u, ROLE.PIT);
      u.pitSide = sideOf(u, q);
      u.holdPose = null;
      pitDone++;
      continue;
    }

    // INTERCEPT: the furthest-back cars get to be clever. Only commit if we
    // can plausibly BEAT the quarry to the junction — arriving second is just
    // a slower tail. A unit that has just given up on a junction is on
    // cooldown, or the next tick sends it straight back to the corner it was
    // right to leave (its own ETA from the kerb it is standing on is zero, so
    // the test below re-passes trivially).
    if (interceptDone < maxIntercept && u._d > 40 && !(u._interceptCool > 0)) {
      const lead = TUNE.interceptLead * (1 + interceptDone * 0.75);
      const node = predictNode(sys.roads, q.position.x, q.position.z, q.velocity.x, q.velocity.z, lead);
      if (node) {
        const ours = Math.hypot(node.x - u.vehicle.position.x, node.z - u.vehicle.position.z) / CRUISE;
        const theirs = Math.hypot(node.x - q.position.x, node.z - q.position.z) /
          Math.max(6, q.speed);
        if (ours + TUNE.interceptMargin < theirs) {
          setRole(u, ROLE.INTERCEPT);
          u.holdPose = blockPoseAt(sys, node, q.position);
          interceptDone++;
          continue;
        }
      }
    }

    // BOX: come up either side of a slowed quarry and squeeze.
    if (wantBox && u._d < 46) {
      if (!boxLeft) { boxLeft = true; setRole(u, ROLE.FLANK); u.pitSide = -1; u.holdPose = null; continue; }
      if (!boxRight) { boxRight = true; setRole(u, ROLE.FLANK); u.pitSide = 1; u.holdPose = null; continue; }
    }

    // Hysteresis on the responding/chasing boundary: without it a car sitting
    // at the threshold flips role every tactics tick, which resets its plan
    // every 400 ms and makes it drive like it cannot make up its mind.
    const wasResponding = u.role === ROLE.RESPOND;
    const responding = wasResponding ? u._d > TUNE.respondOut : u._d > TUNE.respondIn;
    setRole(u, responding ? ROLE.RESPOND : ROLE.CHASE);
    u.slot = 1 + (slot++ % (TUNE.slotBearing.length - 1));
    u.holdPose = null;
  }
}

function byDist(a, b) {
  return a._d - b._d;
}

function setRole(u, role) {
  if (u.role === role) return;
  u.role = role;
  // A role change invalidates the plan; force a replan on the next tick.
  u._replan = 0;
  u.hasSearchPt = false;
}

/** Is this unit in the geometric window where a PIT is even possible? */
function behindAndBeside(u, q) {
  const dx = u.vehicle.position.x - q.position.x;
  const dz = u.vehicle.position.z - q.position.z;
  const along = dx * q.forward.x + dz * q.forward.z;
  q.right(_v);
  const lat = dx * _v.x + dz * _v.z;
  return along > -q.halfLength - 5 && along < 1.5 && Math.abs(lat) < TUNE.pitLateral + 2;
}

function sideOf(u, q) {
  q.right(_v);
  const dx = u.vehicle.position.x - q.position.x;
  const dz = u.vehicle.position.z - q.position.z;
  return dx * _v.x + dz * _v.z >= 0 ? 1 : -1;
}

/**
 * A pose that parks a car ACROSS the road at `node`, facing the direction the
 * quarry will arrive from. Used by both interceptors and roadblocks: the
 * approach edge is the link at the node that best points back at `from`, which
 * is the one they are going to come up.
 *
 * `from` is a position, not the quarry, because a roadblock is built against
 * where the police BELIEVE the quarry is (`police.searchAnchor`) while an
 * interceptor with eyes on it uses the real thing.
 */
export function blockPoseAt(sys, node, from, lateral = 0) {
  const roads = sys.roads;
  if (!roads || !node || !from) return null;
  let ex = from.x - node.x;
  let ez = from.z - node.z;
  const l = Math.hypot(ex, ez);
  if (l < 1e-3) return null;
  ex /= l;
  ez /= l;

  let best = null;
  let bestDot = -2;
  for (let i = 0; i < node.links.length; i++) {
    const e = roads.edges[node.links[i]];
    const other = e.a === node.id ? e.b : e.a;
    const on = roads.nodes[other];
    const dx = on.x - node.x;
    const dz = on.z - node.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) continue;
    const dot = (dx / d) * ex + (dz / d) * ez;
    if (dot > bestDot) { bestDot = dot; best = { e, dx: dx / d, dz: dz / d }; }
  }
  if (!best) return null;

  // Sit a car's length up the approach edge, offset laterally so several cars
  // make a line across rather than a stack.
  const rx = -best.dz;
  const rz = best.dx;
  const setback = clamp(best.e.width * 0.35 + 5, 5, 14);
  return {
    x: node.x + best.dx * setback + rx * lateral,
    z: node.z + best.dz * setback + rz * lateral,
    // Across the road: perpendicular to the approach, with a slight skew so a
    // block reads as a chevron rather than a fence.
    yaw: Math.atan2(rx, rz) + (lateral === 0 ? 0 : Math.sign(lateral) * 0.22),
    edge: best.e,
    dirX: best.dx,
    dirZ: best.dz,
  };
}
