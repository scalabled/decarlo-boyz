/**
 * TRAFFIC — traffic lights and junction arbitration.
 *
 * Two mechanisms, because a city has two kinds of junction:
 *
 *   SIGNALISED — anything with a four-way crossing or an arterial/highway
 *   approach. Two phases split by approach bearing, amber, and an all-red
 *   pedestrian window. Junctions on the same named corridor are offset by
 *   their distance along that corridor divided by a wave speed, which is a
 *   green wave: drive Liberty Avenue at the limit and you keep catching greens.
 *
 *   UNSIGNALISED — everything else. A single-occupancy reservation on the
 *   junction box, granted by road-class priority and then by who asked first.
 *   That reads as an all-way stop, which is what a residential grid junction
 *   in an American city actually is, and — unlike a pure "give way to the
 *   right" rule — it cannot deadlock four cars against each other.
 *
 * `lightAt(nodeId)` is the contract `peds` consumes. It answers from the
 * PEDESTRIAN's point of view: 'green' means green for traffic (do not cross),
 * 'red' means traffic is stopped everywhere at this node (cross now), and null
 * means there is no signal here and the ped must judge the gap itself.
 */

import { TUNE, KIND_RANK, hashF, wrapPi } from './tune.js';

/** Phase table, seconds. Index order: A green, A amber, ped, B green, B amber, ped. */
const AMBER = 3.0;
const PED = 2.6;
/** Metres per second the green wave travels. Matches an arterial cruise. */
const WAVE_SPEED = 13.5;

export class SignalNet {
  constructor(lanes) {
    this.lanes = lanes;
    /** nodeId -> signal record, built on demand. */
    this._sig = new Map();
    /** nodeId -> { driver, until, rank } reservation on an unsignalised box. */
    this._claim = new Map();
    this.time = 0;
    this._stats = { signals: 0, claims: 0 };
  }

  reset() {
    this._sig.clear();
    this._claim.clear();
    this.time = 0;
  }

  update(dt) {
    this.time += dt;
    if (this._claim.size) {
      for (const [id, c] of this._claim) {
        if (this.time > c.until) this._claim.delete(id);
      }
    }
  }

  /* ---------------------------------------------------------- signals -- */

  /**
   * Build (once) the signal record for a node, or null when the node is not
   * signalised. A signal needs at least three approaches and either four of
   * them or one that is an arterial/highway.
   */
  signalAt(nodeId) {
    const cached = this._sig.get(nodeId);
    if (cached !== undefined) return cached;
    const roads = this.lanes.roads;
    const node = roads?.nodes[nodeId];
    if (!node || node.links.length < 3) {
      this._sig.set(nodeId, null);
      return null;
    }
    let maxRank = 0;
    let real = 0;
    for (const eid of node.links) {
      const e = roads.edges[eid];
      if (!e || e.rail) continue;
      real++;
      maxRank = Math.max(maxRank, KIND_RANK[e.kind] ?? 1);
    }
    /**
     * NOT every junction gets lights. Signalising a whole residential grid
     * measured out at 39% of car-frames stopped and a mean speed of 9 km/h —
     * technically correct, visually dead. A street-on-street crossing runs on
     * give-way (see the reservation below), which is demand-driven and flows;
     * lights are for where an arterial is involved, or a genuinely big node.
     */
    if (real < 3 || (maxRank < 2 && real < 5)) {
      this._sig.set(nodeId, null);
      return null;
    }

    // Reference axis: the bearing of the highest-ranked, longest approach.
    let ref = 0;
    let bestScore = -1;
    for (const eid of node.links) {
      const e = roads.edges[eid];
      if (!e || e.rail) continue;
      const score = (KIND_RANK[e.kind] ?? 1) * 1000 + e.len;
      if (score > bestScore) {
        bestScore = score;
        ref = Math.atan2(e.dx, e.dz);
      }
    }

    // Group approaches into the two phases by axis. Anything within 45 deg of
    // the reference axis (mod 180 deg) is phase A.
    const group = new Uint8Array(node.links.length);
    let rankA = 0;
    let rankB = 0;
    for (let i = 0; i < node.links.length; i++) {
      const e = roads.edges[node.links[i]];
      if (!e) { group[i] = 0; continue; }
      const d = Math.abs(wrapPi(Math.atan2(e.dx, e.dz) - ref));
      const axis = Math.min(d, Math.PI - d); // fold to (0, PI/2]
      group[i] = axis < Math.PI / 4 ? 0 : 1;
      const r = KIND_RANK[e.kind] ?? 1;
      if (group[i] === 0) rankA = Math.max(rankA, r);
      else rankB = Math.max(rankB, r);
    }

    /**
     * Split green time by class: the arterial gets the long phase — but the
     * short phase is FLOORED AT 9 s (swing capped at 6, was 9). At the old
     * cap a street crossing a highway got a 6 s green against a 39 s red,
     * which is a starvation plan: a queue of three cannot clear 6 s of green,
     * so its tail misses the green entirely and stands through the next full
     * red. MEASURED (downtown, 3 min, budget 38): continuous stops of 46-62 s
     * at exactly such approaches — a car 19 s behind a slow head during its
     * own green, then `timeToGreen` 35 as the amber lands. The cycle length
     * is unchanged (the swing is symmetric), so the green wave's offsets are
     * untouched.
     */
    const spread = rankA - rankB;
    const gA = 19 + Math.max(-6, Math.min(6, spread * 5));
    const gB = 15 - Math.max(-6, Math.min(6, spread * 5));
    const cycle = gA + AMBER + PED + gB + AMBER + PED;

    // Green wave: nodes on a corridor are offset by their projection onto the
    // corridor's axis over the wave speed. Nodes with no corridor get a stable
    // hash so a grid of them is not in lockstep.
    let offset = hashF(nodeId * 2654435761) * cycle;
    let corridor = null;
    for (const eid of node.links) {
      const e = roads.edges[eid];
      if (e?.corridor && this.lanes.corridorAxis.has(e.corridor)) {
        corridor = e.corridor;
        break;
      }
    }
    if (corridor) {
      const ax = this.lanes.corridorAxis.get(corridor);
      const proj = node.x * ax.x + node.z * ax.z;
      offset = ((proj / WAVE_SPEED) % cycle + cycle) % cycle;
      // Corridors run their own axis on the long phase.
      const cd = Math.abs(wrapPi(Math.atan2(ax.x, ax.z) - ref));
      const cAxis = Math.min(cd, Math.PI - cd);
      if (cAxis >= Math.PI / 4) {
        // The corridor is on phase B — swap so the corridor gets the long green.
        for (let i = 0; i < group.length; i++) group[i] ^= 1;
      }
    }

    const sig = {
      node: nodeId,
      group,
      gA,
      gB,
      cycle,
      offset,
      corridor,
      /** boundaries within the cycle */
      t1: gA,
      t2: gA + AMBER,
      t3: gA + AMBER + PED,
      t4: gA + AMBER + PED + gB,
      t5: gA + AMBER + PED + gB + AMBER,
    };
    this._sig.set(nodeId, sig);
    this._stats.signals++;
    return sig;
  }

  /** Cycle position in seconds for a node. */
  _phaseTime(sig) {
    const t = (this.time + sig.offset) % sig.cycle;
    return t < 0 ? t + sig.cycle : t;
  }

  /**
   * Phase for one approach: 'green' | 'amber' | 'red'.
   * `edgeId` is the edge the driver is arriving on.
   */
  phaseFor(nodeId, edgeId) {
    const sig = this.signalAt(nodeId);
    if (!sig) return null;
    const node = this.lanes.roads.nodes[nodeId];
    let g = -1;
    for (let i = 0; i < node.links.length; i++) {
      if (node.links[i] === edgeId) { g = sig.group[i]; break; }
    }
    if (g < 0) return 'red';
    const t = this._phaseTime(sig);
    if (g === 0) {
      if (t < sig.t1) return 'green';
      if (t < sig.t2) return 'amber';
      return 'red';
    }
    if (t < sig.t3) return 'red';
    if (t < sig.t4) return 'green';
    if (t < sig.t5) return 'amber';
    return 'red';
  }

  /**
   * Seconds until this approach turns green again. Used so a driver can decide
   * whether to creep or settle, and by the harness to detect a stalled cycle.
   */
  timeToGreen(nodeId, edgeId) {
    const sig = this.signalAt(nodeId);
    if (!sig) return 0;
    const node = this.lanes.roads.nodes[nodeId];
    let g = -1;
    for (let i = 0; i < node.links.length; i++) {
      if (node.links[i] === edgeId) { g = sig.group[i]; break; }
    }
    if (g < 0) return sig.cycle;
    const t = this._phaseTime(sig);
    if (g === 0) return t < sig.t1 ? 0 : sig.cycle - t;
    return t >= sig.t3 && t < sig.t4 ? 0 : t < sig.t3 ? sig.t3 - t : sig.cycle - t + sig.t3;
  }

  /**
   * THE `peds` CONTRACT. 'green' = traffic is moving, do not cross.
   * 'red' = every approach is stopped, cross now. null = no signal here.
   */
  lightAt(nodeId) {
    const sig = this.signalAt(nodeId);
    if (!sig) return null;
    const t = this._phaseTime(sig);
    // The two all-red windows are the pedestrian phases.
    const ped = (t >= sig.t2 && t < sig.t3) || t >= sig.t5;
    return ped ? 'red' : 'green';
  }

  /** True when this node runs signals at all. */
  isSignalised(nodeId) {
    return this.signalAt(nodeId) !== null;
  }

  /* ------------------------------------------------------ reservations -- */

  /**
   * Ask to occupy an unsignalised junction box. Priority is road class, then
   * first-come. The claim self-expires so a driver that is destroyed or
   * despawned inside the box can never wedge the junction shut.
   */
  claim(nodeId, driverId, rank) {
    const c = this._claim.get(nodeId);
    // A live claim is NEVER stolen, whatever the road class. Pre-emption would
    // mean granting the box to a second car while the first is still crossing
    // it, which is a T-bone. Class priority is expressed by the fact that a
    // faster road reaches the line first, and claims only last a second or two.
    if (c && c.driver !== driverId && this.time <= c.until) return false;
    this._claim.set(nodeId, {
      driver: driverId,
      rank,
      since: c && c.driver === driverId ? c.since : this.time,
      until: this.time + TUNE.claimTimeout,
    });
    this._stats.claims++;
    return true;
  }

  holds(nodeId, driverId) {
    const c = this._claim.get(nodeId);
    return !!c && c.driver === driverId && this.time <= c.until;
  }

  release(nodeId, driverId) {
    const c = this._claim.get(nodeId);
    if (c && c.driver === driverId) this._claim.delete(nodeId);
  }

  releaseAll(driverId) {
    for (const [id, c] of this._claim) if (c.driver === driverId) this._claim.delete(id);
  }

  get stats() {
    this._stats.live = this._claim.size;
    this._stats.cached = this._sig.size;
    return this._stats;
  }
}
