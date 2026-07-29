/**
 * POLICE — road-graph paths for a pursuit driver.
 *
 * A civilian AI follows the lane. A cop follows the ROAD: it takes the
 * centre-most lane of its direction, and it pulls the racing line toward the
 * centreline by `cut` so that a junction is clipped rather than rounded. That
 * one number is most of the difference between a cruiser that looks like
 * traffic wearing a lightbar and one that looks like it is chasing you.
 *
 * Everything is a flat polyline in a preallocated Float32Array. Planning
 * allocates one node array inside `roads.route()` (at ~1 Hz per unit, six
 * units); nothing on the per-frame path does.
 */

const CAP = 160;

const _tmp = { offset: 0, dir: 1 };

export class RoutePath {
  constructor() {
    /** x, y, z triples. */
    this.pts = new Float32Array(CAP * 3);
    /** Cumulative arc length at each point. */
    this.arc = new Float32Array(CAP);
    this.n = 0;
    /** Index of the segment we are currently on. */
    this.i = 0;
    /** Distance travelled along segment `i`. */
    this.s = 0;
    /** Set when the plan could not reach the goal on the road network. */
    this.direct = false;
    this.goalX = 0;
    this.goalZ = 0;
    this.length = 0;
  }

  reset() {
    this.n = 0;
    this.i = 0;
    this.s = 0;
    this.length = 0;
    this.direct = false;
  }

  get valid() {
    return this.n >= 2;
  }

  /** Arc length still ahead of us. */
  get remaining() {
    if (this.n < 2) return 0;
    return Math.max(0, this.length - (this.arc[this.i] + this.s));
  }

  _push(x, y, z) {
    if (this.n >= CAP) return;
    const k = this.n * 3;
    // Skip a duplicate — a zero-length segment breaks every projection below.
    if (this.n > 0) {
      const dx = x - this.pts[k - 3];
      const dz = z - this.pts[k - 1];
      if (dx * dx + dz * dz < 0.36) return;
      this.arc[this.n] = this.arc[this.n - 1] + Math.hypot(dx, dz);
    } else {
      this.arc[0] = 0;
    }
    this.pts[k] = x;
    this.pts[k + 1] = y;
    this.pts[k + 2] = z;
    this.n++;
    this.length = this.arc[this.n - 1];
  }

  /**
   * Plan a route from (x,z) to (tx,tz).
   *
   * `opts.cut` 0..1 pulls the line toward the road centreline (1 = straight
   * down the middle, ignoring lane discipline). `opts.fromX/fromZ` seed the
   * polyline with the unit's actual position so the first segment is never a
   * sideways jump onto a lane.
   *
   * Returns true when a real road route was found.
   */
  plan(roads, x, z, tx, tz, opts = {}) {
    this.reset();
    this.goalX = tx;
    this.goalZ = tz;
    if (!roads || !roads.nodes?.length) {
      this._push(x, 0, z);
      this._push(tx, 0, tz);
      this.direct = true;
      return false;
    }
    const cut = opts.cut ?? 0.55;
    const hx = opts.hx ?? 0;
    const hz = opts.hz ?? 0;
    // START NODE: the end of the edge we are ALREADY ON, in the direction we
    // are already pointing — not simply the nearest node.
    //
    // This is not a micro-optimisation. `nearestNode` returns the junction
    // behind you as often as the one in front, the route then begins with a
    // segment that doubles back, and a pure-pursuit controller handed a target
    // 170 degrees off its nose at 15 m/s will throw the car at it. That is what
    // put the first version of this driver into a wall on every third corner.
    let a = null;
    if (hx || hz) {
      const hit = roads.nearestEdge(x, z, 200);
      if (hit?.edge) {
        const e = hit.edge;
        a = roads.nodes[e.dx * hx + e.dz * hz >= 0 ? e.b : e.a];
      }
    }
    if (!a) a = roads.nearestNode(x, z, 260);
    const b = roads.nearestNode(tx, tz, 320);
    this._push(x, 0, z);
    if (!a || !b) {
      this._push(tx, 0, tz);
      this.direct = true;
      return false;
    }
    if (a.id === b.id) {
      this._push(b.x, b.y, b.z);
      this._push(tx, 0, tz);
      this.direct = true;
      return false;
    }
    const route = roads.route(a.id, b.id);
    if (!route || route.length < 2) {
      // A* found nothing: the two ends are on different landmasses, or the
      // one-way network does not connect them from here. DO NOT fall back to a
      // straight line — that drives the car off the carriageway and into a
      // building, and the headless harness showed it as the single largest
      // source of "cop stuck forever". Follow the road greedily instead and
      // re-plan next tick from wherever that got us.
      return this._greedy(roads, a, tx, tz, cut, hx, hz);
    }
    for (let k = 0; k < route.length - 1; k++) {
      const e = roads.edgeBetween(route[k], route[k + 1]);
      if (!e) continue;
      const forward = e.a === route[k];
      const lane = forward ? 0 : e.forward;
      roads.laneInfo(e, Math.min(lane, e.lanes - 1), _tmp);
      const off = _tmp.offset * (1 - cut);
      const na = roads.nodes[e.a];
      const nb = roads.nodes[e.b];
      // Two samples per edge, entry and exit in the direction of travel. The
      // junction itself is deliberately NOT sampled: leaving the gap is what
      // lets the pure-pursuit controller clip the corner.
      const t0 = forward ? 0.12 : 0.88;
      const t1 = forward ? 0.9 : 0.1;
      this._sample(na, nb, e, t0, off);
      this._sample(na, nb, e, t1, off);
      /**
       * ...EXCEPT WHERE THE CORNER IS A BUILDING.
       *
       * Clipping is right for a shallow bend: the chord across the gap stays on
       * the carriageway. At a right-angle junction in a downtown grid the same
       * chord cuts up to ten metres INSIDE the corner, and what stands there is
       * a shopfront. `_obstacles` scans vehicles, not walls, so nothing brakes,
       * and the car buries its nose in the masonry at full throttle with all
       * four wheels down — measured on the harness's own runner as a median
       * speed of 1.6 m/s and 89% of samples stationary, which made every
       * pursuit-proximity assertion in the suite a measurement of a parked car.
       *
       * So a sharp turn gets the junction node itself as a waypoint: drive
       * THROUGH the junction, and keep the clip for everything under 60 degrees.
       */
      const nx = roads.nodes[route[k + 1]];
      if (nx && k + 2 < route.length) {
        const e2 = roads.edgeBetween(route[k + 1], route[k + 2]);
        if (e2) {
          const f2 = e2.a === route[k + 1];
          const d1x = forward ? e.dx : -e.dx;
          const d1z = forward ? e.dz : -e.dz;
          const d2x = f2 ? e2.dx : -e2.dx;
          const d2z = f2 ? e2.dz : -e2.dz;
          if (d1x * d2x + d1z * d2z < 0.5) this._push(nx.x, nx.y, nx.z);
        }
      }
    }
    // Finish on the actual goal rather than a lane centre 8 m from it.
    this._push(tx, 0, tz);
    if (hx || hz) this._trimBehind(x, z, hx, hz);
    return this.n >= 2;
  }

  /**
   * Greedy road following: from `node`, repeatedly take the link that most
   * reduces the bearing to the target, for a handful of hops. Always stays on
   * the network, always produces a drivable path, never needs the graph to be
   * connected.
   */
  _greedy(roads, node, tx, tz, cut, hx, hz) {
    let cur = node;
    let prev = -1;
    let phx = hx;
    let phz = hz;
    for (let hop = 0; hop < 10; hop++) {
      let best = null;
      let bestScore = -1e9;
      for (let i = 0; i < cur.links.length; i++) {
        const e = roads.edges[cur.links[i]];
        if (e.id === prev) continue;
        const other = e.a === cur.id ? e.b : e.a;
        const on = roads.nodes[other];
        const dx = on.x - cur.x;
        const dz = on.z - cur.z;
        const l = Math.hypot(dx, dz) || 1;
        const gx = tx - cur.x;
        const gz = tz - cur.z;
        const gl = Math.hypot(gx, gz) || 1;
        // Toward the goal, with a penalty for doubling back on ourselves.
        const toward = ((dx / l) * gx + (dz / l) * gz) / gl;
        const straight = (dx / l) * phx + (dz / l) * phz;
        const score = toward * 3 + straight;
        if (score > bestScore) { bestScore = score; best = { e, on }; }
      }
      if (!best) break;
      const e = best.e;
      const forward = e.a === cur.id;
      const lane = forward ? 0 : e.forward;
      roads.laneInfo(e, Math.min(lane, e.lanes - 1), _tmp);
      const off = _tmp.offset * (1 - cut);
      const na = roads.nodes[e.a];
      const nb = roads.nodes[e.b];
      this._sample(na, nb, e, forward ? 0.12 : 0.88, off);
      this._sample(na, nb, e, forward ? 0.9 : 0.1, off);
      const l2 = Math.hypot(best.on.x - cur.x, best.on.z - cur.z) || 1;
      phx = (best.on.x - cur.x) / l2;
      phz = (best.on.z - cur.z) / l2;
      prev = e.id;
      cur = best.on;
      if (Math.hypot(cur.x - tx, cur.z - tz) < 30) break;
    }
    if (hx || hz) this._trimBehind(this.pts[0], this.pts[2], hx, hz);
    this.direct = false;
    return this.n >= 2;
  }

  /**
   * Drop leading waypoints that sit BEHIND the car, so the first thing the
   * controller aims at is never over its own shoulder. Never removes the last
   * point: when the goal really is behind us the driver has to turn round, and
   * it does that by slowing down (see `_longitudinal`), not by being handed a
   * shorter path.
   */
  _trimBehind(x, z, hx, hz) {
    let drop = 0;
    for (let k = 1; k < this.n - 1; k++) {
      const o = k * 3;
      const dx = this.pts[o] - x;
      const dz = this.pts[o + 2] - z;
      const d = Math.hypot(dx, dz);
      if (d > 34) break;
      if ((dx / Math.max(1e-4, d)) * hx + (dz / Math.max(1e-4, d)) * hz > -0.15) break;
      drop = k;
    }
    if (!drop) return;
    // Keep the car's own position as point 0 and splice the rest down.
    let w = 1;
    for (let k = drop + 1; k < this.n; k++) {
      const src = k * 3;
      const dst = w * 3;
      this.pts[dst] = this.pts[src];
      this.pts[dst + 1] = this.pts[src + 1];
      this.pts[dst + 2] = this.pts[src + 2];
      w++;
    }
    this.n = w;
    this.arc[0] = 0;
    for (let k = 1; k < this.n; k++) {
      const o = k * 3;
      this.arc[k] = this.arc[k - 1] + Math.hypot(this.pts[o] - this.pts[o - 3], this.pts[o + 2] - this.pts[o - 1]);
    }
    this.length = this.arc[this.n - 1];
    this.i = 0;
    this.s = 0;
  }

  /** A straight-line plan — used when we can see the quarry and just go. */
  planDirect(x, z, tx, tz) {
    this.reset();
    this.goalX = tx;
    this.goalZ = tz;
    this._push(x, 0, z);
    this._push(tx, 0, tz);
    this.direct = true;
    return true;
  }

  _sample(na, nb, e, t, off) {
    this._push(
      na.x + (nb.x - na.x) * t - e.dz * off,
      na.y + (nb.y - na.y) * t,
      na.z + (nb.z - na.z) * t + e.dx * off
    );
  }

  /**
   * Slide the cursor to the closest point on the path to (x,z), searching a
   * few segments forward. A cop that has cut a corner is genuinely closer to a
   * later segment, and without this it would turn round and go back for the
   * one it skipped — the single ugliest failure mode of a waypoint follower.
   */
  advance(x, z) {
    if (this.n < 2) return;
    let bestI = this.i;
    let bestS = this.s;
    let bestD = Infinity;
    const last = Math.min(this.n - 2, this.i + 4);
    for (let k = this.i; k <= last; k++) {
      const o = k * 3;
      const ax = this.pts[o];
      const az = this.pts[o + 2];
      const bx = this.pts[o + 3];
      const bz = this.pts[o + 5];
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz;
      if (len2 < 1e-6) continue;
      let t = ((x - ax) * dx + (z - az) * dz) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const px = ax + dx * t;
      const pz = az + dz * t;
      const d = (px - x) * (px - x) + (pz - z) * (pz - z);
      // Bias toward staying on the current segment: only jump forward when the
      // later one is meaningfully closer.
      const bias = k === this.i ? 0 : 4;
      if (d + bias < bestD) {
        bestD = d + bias;
        bestI = k;
        bestS = t * Math.sqrt(len2);
      }
    }
    this.i = bestI;
    this.s = bestS;
    this.lateral = Math.sqrt(Math.max(0, bestD));
  }

  /** Signed lateral error: metres to the RIGHT of the path at the cursor. */
  crossTrack(x, z) {
    if (this.n < 2) return 0;
    const o = this.i * 3;
    const ax = this.pts[o];
    const az = this.pts[o + 2];
    const dx = this.pts[o + 3] - ax;
    const dz = this.pts[o + 5] - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-5) return 0;
    const nx = dx / len;
    const nz = dz / len;
    // right of (nx,nz) is (-nz, nx)
    return (x - ax) * -nz + (z - az) * nx;
  }

  /** Point at `dist` metres ahead along the path. Clamps to the end. */
  ahead(dist, out) {
    if (this.n < 2) {
      out.set(this.goalX, 0, this.goalZ);
      return out;
    }
    let target = this.arc[this.i] + this.s + dist;
    if (target >= this.length) {
      const o = (this.n - 1) * 3;
      out.set(this.pts[o], this.pts[o + 1], this.pts[o + 2]);
      return out;
    }
    let k = this.i;
    while (k < this.n - 2 && this.arc[k + 1] < target) k++;
    const seg = Math.max(1e-5, this.arc[k + 1] - this.arc[k]);
    const t = (target - this.arc[k]) / seg;
    const o = k * 3;
    out.set(
      this.pts[o] + (this.pts[o + 3] - this.pts[o]) * t,
      this.pts[o + 1] + (this.pts[o + 4] - this.pts[o + 1]) * t,
      this.pts[o + 2] + (this.pts[o + 5] - this.pts[o + 2]) * t
    );
    return out;
  }

  /**
   * Sharpest corner within `horizon` metres, as { angle, dist }. The driver
   * turns this into a speed it is willing to arrive at.
   */
  corner(horizon, out) {
    out.angle = 0;
    out.dist = horizon;
    if (this.n < 3) return out;
    const s0 = this.arc[this.i] + this.s;
    for (let k = this.i + 1; k < this.n - 1; k++) {
      const d = this.arc[k] - s0;
      if (d > horizon) break;
      if (d < 0) continue;
      const o = k * 3;
      const ax = this.pts[o] - this.pts[o - 3];
      const az = this.pts[o + 2] - this.pts[o - 1];
      const bx = this.pts[o + 3] - this.pts[o];
      const bz = this.pts[o + 5] - this.pts[o + 2];
      const la = Math.hypot(ax, az);
      const lb = Math.hypot(bx, bz);
      if (la < 1e-4 || lb < 1e-4) continue;
      const dot = (ax * bx + az * bz) / (la * lb);
      const ang = Math.acos(dot < -1 ? -1 : dot > 1 ? 1 : dot);
      // Weight by proximity: a hairpin 100 m away should not stop us now.
      if (ang > out.angle && ang > 0.14) {
        out.angle = ang;
        out.dist = Math.max(1, d);
      }
    }
    return out;
  }
}

/**
 * Where the quarry will be in `lead` seconds if it keeps doing what it is
 * doing: walk the road graph from its current edge, always taking the link
 * that best matches the current heading. Returns a node, or null.
 *
 * This is the function that lets police get AHEAD of you instead of trailing
 * you, which is the difference between a chase and a parade.
 */
export function predictNode(roads, x, z, vx, vz, lead) {
  if (!roads?.nodes?.length) return null;
  const speed = Math.hypot(vx, vz);
  if (speed < 1.5) return roads.nearestNode(x, z, 200);
  let hx = vx / speed;
  let hz = vz / speed;
  const want = Math.max(30, Math.min(420, speed * lead));

  const hit = roads.nearestEdge(x, z, 160);
  if (!hit?.edge) return null;
  const e = hit.edge;
  // Start from the end of the current edge we are heading toward.
  const fwd = e.dx * hx + e.dz * hz >= 0;
  let node = roads.nodes[fwd ? e.b : e.a];
  let travelled = e.len * (fwd ? 1 - hit.t : hit.t);
  let prev = e.id;
  let guard = 0;
  while (travelled < want && guard++ < 24) {
    let best = null;
    let bestDot = -2;
    for (let i = 0; i < node.links.length; i++) {
      const le = roads.edges[node.links[i]];
      if (le.id === prev) continue;
      const other = le.a === node.id ? le.b : le.a;
      const on = roads.nodes[other];
      const dx = on.x - node.x;
      const dz = on.z - node.z;
      const l = Math.hypot(dx, dz);
      if (l < 1e-4) continue;
      const dot = (dx / l) * hx + (dz / l) * hz;
      // A straight-on continuation wins; a hard left is a last resort.
      if (dot > bestDot) {
        bestDot = dot;
        best = { edge: le, node: on };
      }
    }
    if (!best || bestDot < -0.25) break;
    travelled += best.edge.len;
    prev = best.edge.id;
    const dx = best.node.x - node.x;
    const dz = best.node.z - node.z;
    const l = Math.max(1e-4, Math.hypot(dx, dz));
    hx = dx / l;
    hz = dz / l;
    node = best.node;
  }
  return node;
}
