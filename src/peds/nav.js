/**
 * PEDS — sidewalk navigation on the city's road graph.
 *
 * `world.roads` is a planar graph of straight edges with a width and a kind.
 * Sidewalks are not in that graph, but they are completely determined by it: a
 * pavement runs down each side of every street at `width/2 + inset`, and the
 * places two pavements meet are exactly the graph's junctions. So instead of a
 * second authored network (which would have to be streamed, stored and kept in
 * sync), a pedestrian carries a LINK — `{ edge, side, dir }` — and a parameter
 * `t`, and the whole crowd navigates by walking that link to its node and
 * choosing the next one.
 *
 * Choosing the next link keeps the walker on the same physical corner: for each
 * candidate edge we evaluate both of its pavements at the shared node and take
 * the nearer one. Turning a corner therefore never teleports anybody across a
 * road. Crossing is an explicit, separate decision with its own state, its own
 * light check (`traffic.lightAt(nodeId)`) and its own exposure to vehicles —
 * which is what makes a crossing read as a crossing.
 *
 * Everything guards `world` and `traffic` being absent: they are built in
 * parallel with this system, and a missing road graph must degrade to a wander,
 * never to a crash.
 */

import * as THREE from 'three';

/** Pavement inset from the kerb, by road kind. Highways have no pavement. */
const INSET = {
  highway: null,
  arterial: 2.3,
  street: 1.9,
  alley: 1.15,
  service: 1.4,
};

const _v = new THREE.Vector3();

export class SidewalkNet {
  constructor() {
    this.roads = null;
    this.ready = false;
    this._edgeCount = -1;
    this._walkable = [];
    this._out = new THREE.Vector3();
    this._out2 = new THREE.Vector3();
  }

  /**
   * Adopt (or re-adopt) a road graph. Cheap and idempotent — call it every so
   * often while `world` is still streaming its network in.
   */
  attach(roads) {
    if (!roads || !Array.isArray(roads.edges) || !Array.isArray(roads.nodes)) {
      this.ready = false;
      return false;
    }
    if (roads === this.roads && roads.edges.length === this._edgeCount) return this.ready;
    this.roads = roads;
    this._edgeCount = roads.edges.length;
    this._walkable.length = 0;
    for (const e of roads.edges) {
      if (!e || e.rail) continue;
      const inset = INSET[e.kind] ?? INSET.street;
      if (inset === null) continue;
      if (!(e.len > 6)) continue;
      this._walkable.push(e);
    }
    this.ready = this._walkable.length > 0;
    return this.ready;
  }

  /** Half the road width plus the pavement inset — the pavement centreline. */
  offsetOf(edge) {
    const inset = INSET[edge.kind] ?? INSET.street;
    return (edge.width ?? 7) * 0.5 + (inset ?? 1.9);
  }

  /** World point at parameter t (always measured a -> b) on one pavement. */
  pointOn(edge, side, t, out = this._out) {
    const roads = this.roads;
    const na = roads.nodes[edge.a];
    const nb = roads.nodes[edge.b];
    const o = this.offsetOf(edge) * side;
    out.x = na.x + (nb.x - na.x) * t - edge.dz * o;
    out.z = na.z + (nb.z - na.z) * t + edge.dx * o;
    out.y = (na.y ?? 0) + ((nb.y ?? 0) - (na.y ?? 0)) * t;
    return out;
  }

  /** Heading, radians, of walking this link. */
  headingOf(link) {
    const e = link.edge;
    const s = link.dir;
    return Math.atan2(e.dx * s, e.dz * s);
  }

  /** The node a link is walking toward. */
  endNode(link) {
    return link.dir > 0 ? link.edge.b : link.edge.a;
  }

  startNode(link) {
    return link.dir > 0 ? link.edge.a : link.edge.b;
  }

  /** A random legal pavement pose in an annulus around a point. */
  sampleLink(rng, near, minDist = 12, maxDist = 180, out = {}) {
    if (!this.ready) return null;
    const list = this._walkable;
    const n = list.length;
    if (!n) return null;
    const cx = near?.x ?? 0;
    const cz = near?.z ?? 0;
    const min2 = minDist * minDist;
    const max2 = maxDist * maxDist;
    // 24 tries against the annulus, then give up rather than scan the city
    for (let i = 0; i < 24; i++) {
      const e = list[rng.u32() % n];
      const na = this.roads.nodes[e.a];
      const nb = this.roads.nodes[e.b];
      const mx = (na.x + nb.x) * 0.5 - cx;
      const mz = (na.z + nb.z) * 0.5 - cz;
      const d2 = mx * mx + mz * mz;
      if (d2 < min2 || d2 > max2) continue;
      out.edge = e;
      out.side = rng.float() < 0.5 ? 1 : -1;
      out.dir = rng.float() < 0.5 ? 1 : -1;
      out.t = rng.range(0.08, 0.92);
      return out;
    }
    return null;
  }

  /** The nearest pavement to a world point, or null. */
  nearestLink(x, z, out = {}) {
    if (!this.ready || typeof this.roads.nearestEdge !== 'function') return null;
    const near = this.roads.nearestEdge(x, z, 160);
    if (!near || !near.edge) return null;
    const e = near.edge;
    if ((INSET[e.kind] ?? INSET.street) === null) return null;
    const na = this.roads.nodes[e.a];
    const px = x - (na.x + (this.roads.nodes[e.b].x - na.x) * near.t);
    const pz = z - (na.z + (this.roads.nodes[e.b].z - na.z) * near.t);
    const lat = -e.dz * px + e.dx * pz;
    out.edge = e;
    out.side = lat >= 0 ? 1 : -1;
    out.dir = 1;
    out.t = near.t;
    return out;
  }

  /**
   * Pick the next link at the end of the current one, staying on the same
   * corner. Returns null at a dead end (the caller reverses).
   */
  next(link, rng, out = {}) {
    const roads = this.roads;
    const nodeId = this.endNode(link);
    const node = roads.nodes[nodeId];
    if (!node) return null;
    // where the walker physically is, at the end of this pavement
    const here = this._here ?? (this._here = new THREE.Vector3());
    here.copy(this.pointOn(link.edge, link.side, link.dir > 0 ? 1 : 0, this._out2));

    const best = this._best ?? (this._best = { edge: null, dir: 1 });
    let found = false;
    let bestScore = -Infinity;
    const heading = this.headingOf(link);
    for (let i = 0; i < node.links.length; i++) {
      const e = roads.edges[node.links[i]];
      if (!e || e === link.edge) continue;
      if ((INSET[e.kind] ?? INSET.street) === null) continue;
      const dir = e.a === nodeId ? 1 : -1;
      const h = Math.atan2(e.dx * dir, e.dz * dir);
      let dh = h - heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      // strong preference for carrying straight on, then for a turn, never a
      // U-turn; plus a deterministic jitter so a crowd fans out at a junction
      let score = 1.6 * Math.cos(dh) + rng.float() * 0.9;
      if (Math.abs(dh) > 2.7) score -= 2.0;
      if (score > bestScore) {
        bestScore = score;
        best.edge = e;
        best.dir = dir;
        found = true;
      }
    }
    if (!found) {
      // dead end: turn round on the other pavement
      out.edge = link.edge;
      out.side = -link.side;
      out.dir = -link.dir;
      out.t = link.dir > 0 ? 1 : 0;
      return out;
    }
    // stay on the corner we are standing on: take the nearer of the two
    // pavements of the chosen edge
    const tNear = best.dir > 0 ? 0 : 1;
    const pA = this.pointOn(best.edge, 1, tNear, this._out);
    const dA = (pA.x - here.x) ** 2 + (pA.z - here.z) ** 2;
    const pB = this.pointOn(best.edge, -1, tNear, this._out);
    const dB = (pB.x - here.x) ** 2 + (pB.z - here.z) ** 2;
    out.edge = best.edge;
    out.side = dA <= dB ? 1 : -1;
    out.dir = best.dir;
    out.t = tNear;
    return out;
  }

  /**
   * Where a crossing of this link's road ends up: the same t on the opposite
   * pavement. Returns the target point and the node whose light governs it.
   */
  crossTarget(link, t, out = new THREE.Vector3()) {
    this.pointOn(link.edge, -link.side, t, out);
    return out;
  }

  /** Metres of open road a crossing has to traverse. */
  crossWidth(link) {
    return this.offsetOf(link.edge) * 2;
  }
}

/**
 * Fallback navigation for when `world.roads` does not exist yet, or the
 * pedestrian is somewhere with no road near it.
 *
 * A wander is not a fallback nobody sees: it is what a ped does in a park, on
 * a plaza and inside a lot, so it has to look deliberate. Each walker keeps a
 * destination inside a disc around its anchor, walks to it, pauses, picks
 * another. The pause distribution is what stops a wander reading as a random
 * walk.
 */
export class Wander {
  constructor() {
    this.target = new THREE.Vector3();
    this.anchor = new THREE.Vector3();
    this.radius = 26;
    this.pause = 0;
  }

  reset(rng, anchor, radius = 26) {
    this.anchor.copy(anchor);
    this.radius = radius;
    this.pick(rng);
    this.pause = rng.range(0, 2);
  }

  pick(rng) {
    const a = rng.float() * Math.PI * 2;
    const r = Math.sqrt(rng.float()) * this.radius;
    this.target.set(this.anchor.x + Math.cos(a) * r, this.anchor.y, this.anchor.z + Math.sin(a) * r);
  }

  /** @returns true when the walker should keep moving toward `target`. */
  step(rng, position, dt) {
    if (this.pause > 0) {
      this.pause -= dt;
      return false;
    }
    const dx = this.target.x - position.x;
    const dz = this.target.z - position.z;
    if (dx * dx + dz * dz < 1.2) {
      this.pick(rng);
      this.pause = rng.float() < 0.42 ? rng.range(1.5, 7) : 0;
      return this.pause <= 0;
    }
    return true;
  }
}

/**
 * A tiny uniform grid over the live crowd, rebuilt every frame from the ped
 * positions. Local avoidance, "who is near the incident" and `nearest()` all
 * go through it, so the crowd is O(n) rather than O(n^2) — at 110 peds the
 * naive version is 12,100 distance tests per frame and this is about 900.
 */
export class CrowdGrid {
  constructor(cell = 4) {
    this.cell = cell;
    this.map = new Map();
    this._out = [];
  }

  _key(cx, cz) {
    return cx * 73856093 ^ cz * 19349663;
  }

  rebuild(peds) {
    this.map.clear();
    const c = 1 / this.cell;
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      if (!p.active) continue;
      const k = this._key(Math.floor(p.position.x * c), Math.floor(p.position.z * c));
      let list = this.map.get(k);
      if (!list) this.map.set(k, (list = []));
      list.push(p);
    }
  }

  /** Everyone within `radius` of (x,z). Returns a REUSED array. */
  query(x, z, radius) {
    const out = this._out;
    out.length = 0;
    const c = 1 / this.cell;
    const r = Math.ceil(radius * c);
    const cx = Math.floor(x * c);
    const cz = Math.floor(z * c);
    const r2 = radius * radius;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const list = this.map.get(this._key(cx + dx, cz + dz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          const ddx = p.position.x - x;
          const ddz = p.position.z - z;
          if (ddx * ddx + ddz * ddz <= r2) out.push(p);
        }
      }
    }
    return out;
  }
}

export { INSET as SIDEWALK_INSET };
