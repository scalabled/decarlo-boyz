/**
 * WORLD — the rail line as a 1-D track, and a mover that runs stock along it.
 *
 * The mill trackage is emitted by `netgen` as ordinary graph edges carrying
 * `rail: true` and a `corridor` tag ('rail_strip_0' is the Strip ->
 * Lawrenceville line, the one `railsweep` proves continuous end to end).
 * `roadmesh._rail` draws exactly one ballast+sleeper+rail run per emitted rail
 * edge, straight from that edge's two node positions — so the polyline built
 * here from the same nodes IS the drawn track, and anything that follows it
 * sits on the rails the player can see.
 *
 * OWNERSHIP / RULE 2. This module is a pure function library: it imports
 * NOTHING (not even three) and never touches the `world` subsystem's innards.
 * Its input is the road graph HANDED TO IT — in the game that is
 * `ctx.peek('world').roads`, in a node probe it is `generateCity(...).graph` —
 * so it cannot reach across a subsystem boundary however it is loaded. It
 * lives in `src/world/` because "where does the rail line run" is world-domain
 * knowledge; it is consumed by `src/vehicles/tram.js` (the trolley) and by
 * `src/vehicles/tramprobe.mjs` (its gate).
 *
 * Everything is plain numbers and preallocated arrays: no per-frame
 * allocation (hard rule 5), no rng (hard rule 4 — the tram runs the same
 * timetable in every capture).
 */

/**
 * Height of the RAIL HEAD above a rail edge's node `y`.
 *
 * Measured off the emitted geometry in `roadmesh._rail`: the ballast crown
 * sits at `node.y + 0.06` and the railtop at `+ 0.11` above that. A wheel
 * (and therefore the tram's wheel-contact plane) rides here. If `_rail` ever
 * changes its section, this is the one number to move.
 */
export const RAIL_TOP = 0.06 + 0.11;

/** Two drawn ballast runs meet when their endpoints are this close (m) —
 *  same weld the railsweep gate uses, and for the same reason: continuity is
 *  decided by where the geometry is, not by node ids. */
const WELD_EPS = 1.5;

/**
 * Pull one authored rail line out of an emitted road graph as an ordered
 * polyline with cumulative arc length.
 *
 * @param {{nodes:Array, edges:Array}} roads  the emitted graph — `world.roads`
 *        in the game, `generateCity(...).graph` in a probe. Only `.nodes[i]
 *        .x/.y/.z` and `.edges[i].a/.b/.rail/.corridor` are read.
 * @param {string} prefix  corridor id prefix, e.g. 'rail_strip'.
 * @returns {{pts:Array<{x:number,y:number,z:number}>, cum:Float64Array,
 *            length:number}|null}  null when no such line is emitted or it is
 *        too short to run stock on.
 */
export function extractRailLine(roads, prefix = 'rail_strip') {
  if (!roads?.nodes?.length || !roads?.edges?.length) return null;

  // 1. Collect the line's segments, endpoint COORDINATES only (node ids in
  //    the graph are not trusted for continuity — two edges can meet in space
  //    without sharing a node, exactly the case the weld below repairs).
  const segs = [];
  for (const e of roads.edges) {
    if (!e || !e.rail) continue;
    if (!(typeof e.corridor === 'string' && e.corridor.startsWith(prefix))) continue;
    const na = roads.nodes[e.a];
    const nb = roads.nodes[e.b];
    if (!na || !nb) continue;
    segs.push({ ax: na.x, ay: na.y ?? 0, az: na.z, bx: nb.x, by: nb.y ?? 0, bz: nb.z });
  }
  if (segs.length < 2) return null;

  // 2. Weld endpoints into shared points.
  const pts = [];
  const grid = new Map();
  const key = (gx, gz) => gx * 73856093 ^ gz * 19349663;
  const findOrAdd = (x, y, z) => {
    const gx = Math.floor(x / WELD_EPS);
    const gz = Math.floor(z / WELD_EPS);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = grid.get(key(gx + dx, gz + dz));
        if (!list) continue;
        for (const pi of list) {
          const p = pts[pi];
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < WELD_EPS * WELD_EPS) return pi;
        }
      }
    }
    const pi = pts.length;
    pts.push({ x, y, z });
    const k = key(gx, gz);
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(pi);
    return pi;
  };

  // 3. Adjacency over welded points.
  const adj = new Map(); // pi -> [pi]
  for (const s of segs) {
    const pa = findOrAdd(s.ax, s.ay, s.az);
    const pb = findOrAdd(s.bx, s.by, s.bz);
    if (pa === pb) continue;
    if (!adj.has(pa)) adj.set(pa, []);
    if (!adj.has(pb)) adj.set(pb, []);
    if (!adj.get(pa).includes(pb)) adj.get(pa).push(pb);
    if (!adj.get(pb).includes(pa)) adj.get(pb).push(pa);
  }
  if (adj.size < 2) return null;

  // 4. Walk from an extremity (degree 1). The line railsweep certifies is a
  //    simple polyline; tolerate a branch by always continuing STRAIGHTEST,
  //    which is what a railway turnout does too.
  let start = -1;
  for (const [pi, nbrs] of adj) if (nbrs.length === 1) { start = pi; break; }
  if (start < 0) start = adj.keys().next().value; // a loop: start anywhere
  const lineIdx = [start];
  const used = new Set();
  let prev = -1;
  let cur = start;
  for (let guard = 0; guard < segs.length + 2; guard++) {
    const nbrs = adj.get(cur);
    let next = -1;
    let bestDot = -Infinity;
    for (const nb of nbrs) {
      const ek = cur < nb ? cur * 65536 + nb : nb * 65536 + cur;
      if (used.has(ek)) continue;
      if (prev < 0) { next = nb; break; }
      // straightest continuation
      const a = pts[prev]; const b = pts[cur]; const c = pts[nb];
      const d1x = b.x - a.x, d1z = b.z - a.z;
      const d2x = c.x - b.x, d2z = c.z - b.z;
      const dot = (d1x * d2x + d1z * d2z) / (Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z) + 1e-9);
      if (dot > bestDot) { bestDot = dot; next = nb; }
    }
    if (next < 0) break;
    used.add(cur < next ? cur * 65536 + next : next * 65536 + cur);
    lineIdx.push(next);
    prev = cur;
    cur = next;
  }
  if (lineIdx.length < 3) return null;

  // 5. Ordered polyline + cumulative arc length (3D, so grade counts).
  const line = lineIdx.map((pi) => ({ x: pts[pi].x, y: pts[pi].y, z: pts[pi].z }));
  const cum = new Float64Array(line.length);
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    cum[i] = cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  const length = cum[cum.length - 1];
  if (length < 200) return null; // a stub, not a route
  return { pts: line, cum, length };
}

/**
 * Runs a rail vehicle end to end along an extracted line: accelerate, cruise,
 * brake into the terminus, dwell with the doors open, run back. Pure 1-D
 * kinematics — the OUTPUT is an arc position `s` plus `sampleAt`, and the
 * consumer poses its body from two bogie samples so it corners like a rail
 * vehicle instead of yawing about its own centre.
 */
export class RailMover {
  /**
   * @param {{pts,cum,length}} line  from `extractRailLine`.
   * @param {object} [opts]  vmax m/s, accel m/s^2, brake m/s^2, dwell s,
   *        margin m (setback from each rail end — the buffer stop).
   */
  constructor(line, opts = {}) {
    this.line = line;
    this.vmax = opts.vmax ?? 9.0;    // ~32 km/h — interurban street-running pace
    this.accel = opts.accel ?? 1.0;  // a loaded trolley, not a sports car
    this.brake = opts.brake ?? 1.3;
    this.dwell = opts.dwell ?? 5.0;  // seconds stopped at each terminus
    const margin = Math.max(2, opts.margin ?? 8);
    this.sMin = Math.min(margin, line.length * 0.25);
    this.sMax = Math.max(line.length - margin, line.length * 0.75);
    this.s = opts.s0 ?? this.sMin;
    this.dir = 1;
    this.v = 0;
    this.wait = opts.startWait ?? 0;
    /** True while decelerating for (or standing at) a terminus — brake lamps. */
    this.braking = false;
    this._lo = 0; // sampleAt search hint, so sampling is O(1) while rolling
  }

  /** Advance the timetable by `dt` seconds. dt <= 0 is a no-op (a paused clock). */
  step(dt) {
    if (!(dt > 0)) return;
    if (this.wait > 0) {
      this.wait -= dt;
      this.v = 0;
      this.braking = true;
      return;
    }
    const distEnd = this.dir > 0 ? this.sMax - this.s : this.s - this.sMin;
    // Highest speed from which the service brake still stops at the mark.
    const vAllow = Math.min(this.vmax, Math.sqrt(Math.max(0, 2 * this.brake * distEnd)));
    if (this.v > vAllow) {
      this.v = Math.max(vAllow, this.v - this.brake * dt);
      this.braking = true;
    } else {
      this.v = Math.min(vAllow, this.v + this.accel * dt);
      this.braking = false;
    }
    this.s += this.v * this.dir * dt;
    if (this.dir > 0 && this.s >= this.sMax) {
      this.s = this.sMax;
      this.dir = -1;
      this.v = 0;
      this.wait = this.dwell;
      this.braking = true;
    } else if (this.dir < 0 && this.s <= this.sMin) {
      this.s = this.sMin;
      this.dir = 1;
      this.v = 0;
      this.wait = this.dwell;
      this.braking = true;
    }
  }

  /**
   * World position of the RAIL HEAD at arc `s`, written into `out {x,y,z}`.
   * (`RAIL_TOP` is included, so `out.y` is where a wheel tread touches.)
   */
  sampleAt(s, out) {
    const { pts, cum } = this.line;
    const n = pts.length;
    const sc = s < 0 ? 0 : s > cum[n - 1] ? cum[n - 1] : s;
    // Walk the hint forward/backward — the mover moves a fraction of a segment
    // per step, so this is a couple of comparisons, not a search.
    let i = this._lo;
    if (i > n - 2) i = n - 2;
    while (i > 0 && sc < cum[i]) i--;
    while (i < n - 2 && sc > cum[i + 1]) i++;
    this._lo = i;
    const a = pts[i];
    const b = pts[i + 1];
    const span = cum[i + 1] - cum[i];
    const t = span > 1e-9 ? (sc - cum[i]) / span : 0;
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t + RAIL_TOP;
    out.z = a.z + (b.z - a.z) * t;
    return out;
  }
}
