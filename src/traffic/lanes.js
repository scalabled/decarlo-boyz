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

/**
 * The sharpest junction turn a driver will attempt. Mirrors the refusal in
 * `successor()`: anything past ~115 degrees is a U-turn in disguise and no
 * junction lane geometry supports it.
 */
const MAX_TURN = 2.0;

export class LaneNet {
  constructor() {
    this.roads = null;
    /** 0 = unknown, 1 = computed. Parallel arrays indexed by edge id. */
    this._flags = null;
    this._rank = null;
    this._limit = null;
    /** Per-edge lane-data sanity, computed once in attach(). */
    this._sane = null;
    /** Per-DIRECTED-edge trap flag (edge.id*2 + (dir>0?0:1)), see _computeTraps. */
    this._trap = null;
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
    /** Scratch for candidates that lead into a trap — used only as a last resort. */
    this._trapE = new Int32Array(12);
    this._trapL = new Int32Array(12);
    this._trapW = new Float32Array(12);
    this._trapTurn = new Float32Array(12);
    this._pick = { edge: null, lane: 0, turn: 0 };
    /**
     * Edges the fleet has learned are impassable — a building collider across
     * the carriageway, a prop in the road. Set by the system when a driver's
     * forward probe says the route is walled and it has to give up; entries
     * expire so a temporary obstruction (a wreck) is forgotten.
     */
    this.blocked = new Map();
    /**
     * NEGATIVE-CONTROL hatch for the harness: disables the trap refusal in
     * `successor()` against the live code, no edit needed. Same pattern as
     * `debugIgnorePause` in freeroam/weapons (see ARCHITECTURE.md).
     */
    this.debugNoTrapGuard = false;
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
    this._sane = new Uint8Array(n);
    this._fwLo = new Int8Array(n);
    this._fwHi = new Int8Array(n);
    this._bwLo = new Int8Array(n);
    this._bwHi = new Int8Array(n);

    const axis = new Map();
    for (let i = 0; i < n; i++) {
      const e = roads.edges[i];
      this._rank[i] = KIND_RANK[e.kind] ?? 1;
      this._limit[i] = KIND_LIMIT[e.kind] ?? 11;
      /**
       * LANE-DATA SANITY, once per edge. A driver steered by garbage geometry
       * — a zero laneWidth, a NaN direction, a lane centre off in space —
       * produces garbage steering with no error anywhere, so an edge that
       * fails this is simply never routed onto, never spawned onto, and never
       * chosen by a successor. `world` welds new link edges onto the graph
       * (`lm_*_link`); this is the traffic-side guarantee that whatever
       * arrives, a driver only ever steers to finite, plausible lane data.
       */
      const na = roads.nodes[e.a];
      const nb = roads.nodes[e.b];
      this._sane[i] =
        Number.isFinite(e.len) && e.len > 0.5 &&
        Number.isFinite(e.laneWidth) && e.laneWidth > 1.5 && e.laneWidth < 8 &&
        Number.isFinite(e.width) && e.width > 2.5 &&
        e.lanes >= 1 && e.forward >= (e.oneway ? e.lanes : 1) &&
        Number.isFinite(e.dx) && Number.isFinite(e.dz) &&
        Math.abs(Math.hypot(e.dx, e.dz) - 1) < 0.01 &&
        !!na && !!nb &&
        Number.isFinite(na.x + na.z + na.y) && Number.isFinite(nb.x + nb.z + nb.y)
          ? 1 : 0;

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
    this._computeTraps();
    return true;
  }

  /**
   * TRANSITIVE TRAP MAP, one bit per directed edge, computed once per graph.
   *
   * A directed edge is a TRAP when driving it commits the car to a dead-end
   * U-turn somewhere ahead with no junction offering a way out in between: its
   * far node has no acceptable continuation (degree-1, or every arm sharper
   * than MAX_TURN or not drivable), or every acceptable continuation is itself
   * a trap. The transitive half is the whole point — the north half of the
   * Fort Duquesne deck is ~400 m of degree-2 bends ending at a degree-1 node,
   * so a one-step test at the entry junction sees "an exit" nine times in a
   * row and still delivers the car to a pi-turn over the river.
   *
   * Monotone fixpoint: flags only ever flip false -> true, so it terminates in
   * at most (longest cul-de-sac chain) passes; the whole city settles in a
   * handful. `blocked` is deliberately NOT consulted here — it is dynamic and
   * expires; `successor()` already skips blocked candidates live.
   */
  _computeTraps() {
    const roads = this.roads;
    const n = roads.edges.length;
    this._trap = new Uint8Array(n * 2);
    const trap = this._trap;
    const yawOf = (e, d) => Math.atan2(e.dx * d, e.dz * d);
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 200) {
      changed = false;
      for (let i = 0; i < n; i++) {
        const e = roads.edges[i];
        if (e.rail || !this._sane[i]) continue;
        for (let k = 0; k < 2; k++) {
          const dir = k === 0 ? 1 : -1;
          const idx = i * 2 + k;
          if (trap[idx]) continue;
          if (!this.drivable(e, dir)) continue;
          const far = dir > 0 ? e.b : e.a;
          const node = roads.nodes[far];
          let out = false;
          if (node) {
            const inYaw = yawOf(e, dir);
            for (let j = 0; j < node.links.length; j++) {
              const e3 = roads.edges[node.links[j]];
              if (!e3 || e3 === e || e3.rail) continue;
              const d3 = e3.a === far ? 1 : e3.b === far ? -1 : 0;
              if (d3 === 0 || !this.drivable(e3, d3)) continue;
              if (Math.abs(wrapPi(yawOf(e3, d3) - inYaw)) > MAX_TURN) continue;
              if (trap[e3.id * 2 + (d3 > 0 ? 0 : 1)]) continue;
              out = true;
              break;
            }
          }
          if (!out) {
            trap[idx] = 1;
            changed = true;
          }
        }
      }
    }
  }

  /** Does driving (edge, dir) commit the car to a dead-end U-turn ahead? */
  isTrap(edge, dir) {
    if (!this._trap) return false;
    return this._trap[edge.id * 2 + (dir > 0 ? 0 : 1)] === 1;
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
    if (this._sane && !this._sane[edge.id]) return false;
    if (edge.oneway && dir < 0) return false;
    return this.laneHi(edge, dir) >= this.laneLo(edge, dir);
  }

  /** Did this edge pass the once-per-attach lane-data sanity screen? */
  sane(edge) {
    return !this._sane || !!this._sane[edge.id];
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
    let trapN = 0;
    let trapTotal = 0;

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
      if (at > MAX_TURN) continue;
      let w = at < 0.35 ? 5.0 : at < 1.0 ? 1.8 : 0.75;
      w *= 0.55 + 0.5 * (this._rank[e2.id] + 1);
      if (e2.corridor && e2.corridor === edge.corridor) w *= 3.4;
      if (wantKind && e2.kind === wantKind) w *= 2.0;
      if (e2.kind === 'alley') w *= 0.15;
      if (e2.len < 12) w *= 0.4;
      /**
       * Never route INTO a trap while any other way exists — see
       * `_computeTraps`. A trap delivers the car to a dead-end U-turn: a
       * pi-turn at full lock is a ~4.2 m-radius arc, wider than a street's
       * half-carriageway. MEASURED before this guard: 32% of off-carriageway
       * samples and ~36% of collision events carried a queued U-turn
       * (downtown, 3 min, budget 38) — cars arcing off the terminal halves of
       * the Fort Pitt / Fort Duquesne decks and shuttling through a welded
       * stub whose only continuation is 2.18 rad. Kept as a separate
       * last-resort pool rather than simply skipped: a car whose every
       * candidate is a trap still needs to move, and entering one slowly
       * beats stopping dead in the junction.
       */
      if (!this.debugNoTrapGuard && this.isTrap(e2, dir)) {
        if (trapN < this._trapE.length) {
          this._trapE[trapN] = e2.id;
          this._trapL[trapN] = lane2;
          this._trapTurn[trapN] = turn;
          this._trapW[trapN] = w;
          trapTotal += w;
          trapN++;
        }
        continue;
      }
      this._candE[n] = e2.id;
      this._candL[n] = lane2;
      this._candTurn[n] = turn;
      this._candW[n] = w;
      total += w;
      n++;
    }

    if (n === 0 && trapN > 0) {
      // Last resort: every acceptable arm leads into a trap. Take one anyway.
      this._candE.set(this._trapE.subarray(0, trapN));
      this._candL.set(this._trapL.subarray(0, trapN));
      this._candTurn.set(this._trapTurn.subarray(0, trapN));
      this._candW.set(this._trapW.subarray(0, trapN));
      n = trapN;
      total = trapTotal;
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
