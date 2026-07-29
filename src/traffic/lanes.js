/**
 * TRAFFIC — the lane layer over `world.roads`.
 *
 * The road graph gives straight edges and a lane convention; it does not have
 * an opinion about which lanes a *driver* may use, where a kerb parking bay
 * goes, or which lane you should be in to turn left. That is this file.
 *
 * LANE CONVENTION (from world/roadgraph.js, restated because every sign error
 * in a traffic system comes from getting this wrong):
 *   - `edge.forward` lanes run a -> b, indices [0 .. fw-1]. Lane 0 is nearest
 *     the centreline; lane fw-1 hugs the right-hand kerb.
 *   - lanes [fw .. lanes-1] run b -> a. Index fw is nearest the centreline,
 *     lanes-1 hugs that direction's kerb (which is the LEFT side of a -> b).
 *   - lateral offset of lane i is +(i+0.5)*w for the a->b group and
 *     -(k+0.5)*w for the b->a group, measured along right-of-(dx,dz) = (-dz,dx).
 *
 * PARKING AND USABLE LANES
 *   A kerbside parking bay is 2.3 m of carriageway plus clearance. A two-lane
 *   street is 7.4 m of carriageway total: park on it and there is physically no
 *   room for two 2.3 m-wide cars to pass. So parking is only ever placed where
 *   removing the kerb lane still leaves a lane in each direction — in practice
 *   the four-lane arterials — and the kerb lane is then removed from the set a
 *   driver may use. That is exactly what a US arterial with kerb parking is.
 *   Everything narrower is left to `props` for static dressing.
 */

import { KIND_RANK, KIND_LIMIT, hashF, wrapPi, clamp } from './tune.js';

/** Fraction of eligible edges that get a parking bay, before density weighting. */
const PARK_CHANCE = 0.55;
/** Centre of a parking bay, metres in from the kerb face. */
const PARK_INSET = 1.30;
/** Carriageway a bay eats. */
const PARK_BAND = 2.45;

export class LaneNet {
  constructor() {
    this.roads = null;
    /** 0 = unknown, 1 = computed. Parallel arrays indexed by edge id. */
    this._flags = null;
    this._rank = null;
    this._limit = null;
    /** Usable lane ranges per direction, inclusive. */
    this._fwLo = null;
    this._fwHi = null;
    this._bwLo = null;
    this._bwHi = null;
    /** Mean unit direction of every named corridor, for the green wave. */
    this.corridorAxis = new Map();
    /** Scratch reused by successor selection. */
    this._candE = new Int32Array(12);
    this._candL = new Int32Array(12);
    this._candW = new Float32Array(12);
    this._candTurn = new Float32Array(12);
    this._pick = { edge: null, lane: 0, turn: 0 };
    /**
     * Edges the fleet has learned are impassable — a building collider across
     * the carriageway, a prop in the road. Set by the system when a driver's
     * forward probe says the route is walled and it has to give up; entries
     * expire so a temporary obstruction (a wreck) is forgotten.
     */
    this.blocked = new Map();
  }

  get ready() {
    return !!this.roads;
  }

  /**
   * Bind to a graph and precompute everything per-edge. One pass, a handful of
   * typed arrays; the whole city is a few thousand edges so this is sub-ms.
   */
  attach(roads, densityAt = null) {
    if (!roads || roads === this.roads || !roads.edges?.length) return this.ready;
    this.roads = roads;
    const n = roads.edges.length;
    this._flags = new Uint8Array(n);
    this._rank = new Uint8Array(n);
    this._limit = new Float32Array(n);
    this._fwLo = new Int8Array(n);
    this._fwHi = new Int8Array(n);
    this._bwLo = new Int8Array(n);
    this._bwHi = new Int8Array(n);

    const axis = new Map();
    for (let i = 0; i < n; i++) {
      const e = roads.edges[i];
      this._rank[i] = KIND_RANK[e.kind] ?? 1;
      this._limit[i] = KIND_LIMIT[e.kind] ?? 11;

      const fw = e.forward;
      const bw = e.lanes - fw;
      // A bay may only exist where the direction it sits on keeps a lane.
      const eligible =
        !e.rail && !e.bridge && e.kind !== 'highway' && e.len > 34 && fw >= 2 && bw >= 2;
      let park = 0;
      if (eligible) {
        const d = densityAt ? densityAt(e) : 0.6;
        const p = PARK_CHANCE * clamp(0.35 + d, 0.2, 1.15);
        if (hashF(e.id * 2 + 1) < p) park |= 1; // right of a->b
        if (hashF(e.id * 2 + 77771) < p * 0.7) park |= 2; // left of a->b
      }
      this._flags[i] = park;
      this._fwLo[i] = 0;
      this._fwHi[i] = fw - 1 - (park & 1 ? 1 : 0);
      this._bwLo[i] = fw;
      this._bwHi[i] = e.lanes - 1 - (park & 2 ? 1 : 0);
      if (this._fwHi[i] < 0) this._fwHi[i] = fw - 1;
      if (this._bwHi[i] < fw) this._bwHi[i] = e.lanes - 1;

      if (e.corridor) {
        let a = axis.get(e.corridor);
        if (!a) axis.set(e.corridor, (a = { x: 0, z: 0 }));
        // Sum with a consistent sense so opposite halves do not cancel.
        const s = a.x * e.dx + a.z * e.dz >= 0 || (a.x === 0 && a.z === 0) ? 1 : -1;
        a.x += e.dx * s;
        a.z += e.dz * s;
      }
    }
    this.corridorAxis.clear();
    for (const [id, a] of axis) {
      const l = Math.hypot(a.x, a.z) || 1;
      this.corridorAxis.set(id, { x: a.x / l, z: a.z / l });
    }
    return true;
  }

  /* ------------------------------------------------------------ lanes -- */

  rank(edge) {
    return this._rank[edge.id];
  }

  limit(edge) {
    return this._limit[edge.id];
  }

  /** Carriageway half-width. */
  halfWidth(edge) {
    return edge.width * 0.5;
  }

  /** 1 when `lane` travels a -> b, -1 when it travels b -> a. */
  laneDir(edge, lane) {
    return lane < edge.forward ? 1 : -1;
  }

  /** Innermost usable lane for a direction (nearest the centreline). */
  laneLo(edge, dir) {
    return dir > 0 ? this._fwLo[edge.id] : this._bwLo[edge.id];
  }

  /** Kerb-most usable lane for a direction. "Keep right" means aim for this. */
  laneHi(edge, dir) {
    return dir > 0 ? this._fwHi[edge.id] : this._bwHi[edge.id];
  }

  laneCount(edge, dir) {
    return this.laneHi(edge, dir) - this.laneLo(edge, dir) + 1;
  }

  /** True when a driver may legally travel `dir` along this edge at all. */
  drivable(edge, dir) {
    if (edge.rail) return false;
    if (edge.oneway && dir < 0) return false;
    return this.laneHi(edge, dir) >= this.laneLo(edge, dir);
  }

  /** Bay present on the right of a->b (bit 1) / left of a->b (bit 2). */
  parkFlags(edge) {
    return this._flags[edge.id];
  }

  /** Signed lateral offset of a kerb parking bay centre. */
  parkOffset(edge, side) {
    const h = this.halfWidth(edge);
    return side > 0 ? h - PARK_INSET : -(h - PARK_INSET);
  }

  /** How wide a bay is, for spacing parked cars off the running lanes. */
  get parkBand() {
    return PARK_BAND;
  }

  /* --------------------------------------------------------- geometry -- */

  /** Length of an edge travelled in either direction. */
  length(edge) {
    return edge.len;
  }

  /** Node id a lane starts from. */
  fromNode(edge, lane) {
    return lane < edge.forward ? edge.a : edge.b;
  }

  /** Node id a lane leads to. */
  toNode(edge, lane) {
    return lane < edge.forward ? edge.b : edge.a;
  }

  /** Heading, radians, of travelling this lane. Matches atan2(fwd.x, fwd.z). */
  yaw(edge, lane) {
    const s = lane < edge.forward ? 1 : -1;
    return Math.atan2(edge.dx * s, edge.dz * s);
  }

  /**
   * World point `s` metres along a lane from where that lane STARTS, plus an
   * extra lateral offset (positive = to the driver's right). Allocation-free.
   */
  point(edge, lane, s, lateral, out) {
    const dir = lane < edge.forward ? 1 : -1;
    let t = dir > 0 ? s / edge.len : 1 - s / edge.len;
    // Clamp hard. Extrapolating a straight edge by multiples of its own length
    // put lookahead points hundreds of metres off the road whenever a driver
    // ran out of queued path, and the car chased them there.
    if (t < -0.12) t = -0.12;
    else if (t > 1.12) t = 1.12;
    this.roads.laneCenter(edge, lane, t, out);
    if (lateral) {
      // right-of-travel = (-dz, dx) * dir
      out.x += -edge.dz * dir * lateral;
      out.z += edge.dx * dir * lateral;
    }
    return out;
  }

  /**
   * A point on the edge CENTRELINE at parameter t, pushed `off` metres to the
   * right of a->b. Used for kerb parking bays, which do not sit on a lane.
   */
  centerAt(edge, t, off, out) {
    const na = this.roads.nodes[edge.a];
    const nb = this.roads.nodes[edge.b];
    out.x = na.x + (nb.x - na.x) * t - edge.dz * off;
    out.z = na.z + (nb.z - na.z) * t + edge.dx * off;
    out.y = na.y + (nb.y - na.y) * t;
    return out;
  }

  /** Signed lateral offset of a lane centre from the edge centreline (a->b right). */
  laneOffset(edge, lane) {
    const fw = edge.forward;
    return lane < fw ? (lane + 0.5) * edge.laneWidth : -(lane - fw + 0.5) * edge.laneWidth;
  }

  /**
   * Where a point sits relative to a lane: writes `{ s, lateral }` where `s` is
   * metres from the lane start along the travel direction and `lateral` is
   * metres to the driver's right of the lane centre.
   */
  project(edge, lane, x, z, out) {
    const na = this.roads.nodes[edge.a];
    const dir = lane < edge.forward ? 1 : -1;
    const off = this.laneOffset(edge, lane);
    // lane origin at t=0 (always the a end), including the lateral offset
    const ox = na.x - edge.dz * off;
    const oz = na.z + edge.dx * off;
    const px = x - ox;
    const pz = z - oz;
    const along = px * edge.dx + pz * edge.dz; // metres from a toward b
    const right = -edge.dz * px + edge.dx * pz; // right of a->b
    out.s = dir > 0 ? along : edge.len - along;
    out.lateral = right * dir;
    return out;
  }

  /* ------------------------------------------------------- successors -- */

  /**
   * Pick the lane to continue on after arriving at `nodeId` via (edge, lane).
   *
   * Weighted by how straight the turn is and by road class, with a strong bias
   * to stay on a named corridor — which is what makes AI traffic run *down*
   * Liberty Avenue instead of dissolving into the side streets after two
   * blocks. Returns a reused record `{ edge, lane, turn }` or null.
   */
  successor(edge, lane, nodeId, rng, opts) {
    const roads = this.roads;
    const node = roads.nodes[nodeId];
    if (!node) return null;
    const inYaw = this.yaw(edge, lane);
    const fromKerb = this.laneHi(edge, this.laneDir(edge, lane)) - lane;
    const wantKind = opts?.kind ?? null;
    let n = 0;
    let total = 0;

    for (let i = 0; i < node.links.length && n < this._candE.length; i++) {
      const e2 = roads.edges[node.links[i]];
      if (!e2 || e2.rail) continue;
      if (e2.id === edge.id) continue; // no U-turn unless we have nothing else
      if (this.blocked.has(e2.id)) continue;
      const dir = e2.a === nodeId ? 1 : e2.b === nodeId ? -1 : 0;
      if (dir === 0) continue;
      if (!this.drivable(e2, dir)) continue;
      const lane2 = this._chooseLane(e2, dir, inYaw, fromKerb);
      if (lane2 < 0) continue;
      const turn = wrapPi(this.yaw(e2, lane2) - inYaw);
      const at = Math.abs(turn);
      // Straight is by far the most likely; a U-turn-ish link is nearly never.
      // A junction turn sharper than ~115 degrees is a U-turn in disguise and
      // no lane geometry supports it; refuse rather than let a car try.
      if (at > 2.0) continue;
      let w = at < 0.35 ? 5.0 : at < 1.0 ? 1.8 : 0.75;
      w *= 0.55 + 0.5 * (this._rank[e2.id] + 1);
      if (e2.corridor && e2.corridor === edge.corridor) w *= 3.4;
      if (wantKind && e2.kind === wantKind) w *= 2.0;
      if (e2.kind === 'alley') w *= 0.15;
      if (e2.len < 12) w *= 0.4;
      this._candE[n] = e2.id;
      this._candL[n] = lane2;
      this._candTurn[n] = turn;
      this._candW[n] = w;
      total += w;
      n++;
    }

    if (n === 0) {
      // Dead end: turn around if the other direction of this edge is drivable.
      const back = this.laneDir(edge, lane) > 0 ? -1 : 1;
      if (this.drivable(edge, back)) {
        const l2 = this.laneHi(edge, back);
        this._pick.edge = edge;
        this._pick.lane = l2;
        this._pick.turn = Math.PI;
        return this._pick;
      }
      return null;
    }

    let r = rng.float() * total;
    let k = 0;
    for (; k < n - 1; k++) {
      r -= this._candW[k];
      if (r <= 0) break;
    }
    this._pick.edge = roads.edges[this._candE[k]];
    this._pick.lane = this._candL[k];
    this._pick.turn = this._candTurn[k];
    return this._pick;
  }

  /**
   * Which lane of `e2` to take. Right turns want the kerb lane, left turns the
   * inside lane, and going straight keeps your distance from the kerb.
   */
  _chooseLane(e2, dir, inYaw, fromKerb) {
    const lo = this.laneLo(e2, dir);
    const hi = this.laneHi(e2, dir);
    if (hi < lo) return -1;
    const straightYaw = this.yaw(e2, dir > 0 ? lo : hi);
    const turn = wrapPi(straightYaw - inYaw);
    // turn > 0 rotates the heading toward +X, which for a +Z-forward body is a
    // LEFT turn. Negative is a right turn.
    if (turn < -0.55) return hi;
    if (turn > 0.55) return lo;
    const want = hi - fromKerb;
    return want < lo ? lo : want > hi ? hi : want;
  }

  /** A lane on `edge` travelling `dir` closest to keeping `fromKerb`. */
  laneFromKerb(edge, dir, fromKerb) {
    const lo = this.laneLo(edge, dir);
    const hi = this.laneHi(edge, dir);
    const want = hi - fromKerb;
    return want < lo ? lo : want > hi ? hi : want;
  }
}
