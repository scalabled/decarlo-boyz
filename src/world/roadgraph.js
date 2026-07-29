import * as THREE from 'three';
import { ROAD_KIND, roadHalfWidth, segDist2 } from './plan.js';

/**
 * WORLD — the road graph.
 *
 * The spine of traffic, police, peds, the minimap and every mission that says
 * "drive there". A planar graph: nodes are junctions and bends, edges are
 * straight segments between them, so a lane centre is a lerp and a heading is a
 * constant — which is exactly what an AI driver wants at 120 Hz.
 *
 * LANE CONVENTION
 *   `edge.lanes` is the TOTAL lane count. Lanes [0 .. fw-1] run a -> b and sit
 *   on the right-hand side of that direction; lanes [fw .. lanes-1] run b -> a.
 *   For a one-way edge fw === lanes. Lateral offset of lane i from the
 *   centreline is (k + 0.5) * laneWidth on the travel direction's right, where
 *   k is the lane's index within its own direction. Right of (dx,0,dz) is
 *   (-dz, 0, dx).
 *
 * ALL PUBLIC METHODS ARE ALLOCATION-FREE on the hot path — pass an `out`.
 */

const _v = new THREE.Vector3();
const _seg = { d2: 0, t: 0 };

/** Uniform-grid index over edges. Cell is a couple of blocks. */
const CELL = 64;

class Heap {
  constructor(cap = 1024) {
    this.idx = new Int32Array(cap);
    this.key = new Float32Array(cap);
    this.n = 0;
  }
  clear() {
    this.n = 0;
  }
  grow() {
    const idx = new Int32Array(this.idx.length * 2);
    const key = new Float32Array(this.key.length * 2);
    idx.set(this.idx);
    key.set(this.key);
    this.idx = idx;
    this.key = key;
  }
  push(i, k) {
    if (this.n >= this.idx.length) this.grow();
    let c = this.n++;
    this.idx[c] = i;
    this.key[c] = k;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p] <= this.key[c]) break;
      const ti = this.idx[p];
      const tk = this.key[p];
      this.idx[p] = this.idx[c];
      this.key[p] = this.key[c];
      this.idx[c] = ti;
      this.key[c] = tk;
      c = p;
    }
  }
  pop() {
    const top = this.idx[0];
    this.n--;
    if (this.n > 0) {
      this.idx[0] = this.idx[this.n];
      this.key[0] = this.key[this.n];
      let c = 0;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        if (l < this.n && this.key[l] < this.key[m]) m = l;
        if (r < this.n && this.key[r] < this.key[m]) m = r;
        if (m === c) break;
        const ti = this.idx[m];
        const tk = this.key[m];
        this.idx[m] = this.idx[c];
        this.key[m] = this.key[c];
        this.idx[c] = ti;
        this.key[c] = tk;
        c = m;
      }
    }
    return top;
  }
}

export class RoadGraph {
  constructor() {
    /** { id, x, z, y, kind:'junction'|'bend', links:[edgeId] } */
    this.nodes = [];
    /** { id, a, b, lanes, width, kind, oneway, ... } */
    this.edges = [];
    this._cells = new Map();
    this._nodeCells = new Map();
    this._heap = new Heap();
    this._g = null;
    this._came = null;
    this._stamp = null;
    this._epoch = 0;
    this._out = new THREE.Vector3();
    this._near = { edge: null, t: 0, lane: 0, dist: Infinity, dy: 0, y: 0 };
    this._spawn = {
      position: new THREE.Vector3(),
      yaw: 0,
      edge: null,
      lane: 0,
      t: 0,
      dir: 1,
    };
  }

  // ------------------------------------------------------------ building --

  addNode(x, z, y = 0, kind = 'bend') {
    const n = { id: this.nodes.length, x, z, y, kind, links: [] };
    this.nodes.push(n);
    return n;
  }

  addEdge(a, b, opts = {}) {
    const na = this.nodes[a];
    const nb = this.nodes[b];
    if (!na || !nb || a === b) return null;
    const dx = nb.x - na.x;
    const dz = nb.z - na.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.5) return null;
    const kind = opts.kind ?? 'street';
    const lanes = opts.lanes ?? 2;
    const k = ROAD_KIND[kind] ?? ROAD_KIND.street;
    const e = {
      id: this.edges.length,
      a,
      b,
      lanes,
      width: opts.width ?? roadHalfWidth(kind, lanes) * 2,
      kind,
      oneway: !!opts.oneway,
      // derived, cached — traffic reads these every frame
      len,
      dx: dx / len,
      dz: dz / len,
      laneWidth: k.laneWidth,
      forward: opts.oneway ? lanes : Math.max(1, lanes >> 1),
      speed: opts.speed ?? k.speed,
      bridge: !!opts.bridge,
      bridgeId: opts.bridgeId ?? null,
      corridor: opts.corridor ?? null,
      name: opts.name ?? null,
      district: opts.district ?? null,
      rail: !!opts.rail,
    };
    this.edges.push(e);
    na.links.push(e.id);
    nb.links.push(e.id);
    return e;
  }

  /** Build the spatial indices. Call once after all edges are in. */
  finalise() {
    this._cells.clear();
    this._nodeCells.clear();
    for (const e of this.edges) {
      const na = this.nodes[e.a];
      const nb = this.nodes[e.b];
      const x0 = Math.floor(Math.min(na.x, nb.x) / CELL);
      const x1 = Math.floor(Math.max(na.x, nb.x) / CELL);
      const z0 = Math.floor(Math.min(na.z, nb.z) / CELL);
      const z1 = Math.floor(Math.max(na.z, nb.z) / CELL);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const k = cx * 73856093 ^ cz * 19349663;
          let list = this._cells.get(k);
          if (!list) this._cells.set(k, (list = []));
          list.push(e.id);
        }
      }
    }
    for (const n of this.nodes) {
      const k = Math.floor(n.x / CELL) * 73856093 ^ Math.floor(n.z / CELL) * 19349663;
      let list = this._nodeCells.get(k);
      if (!list) this._nodeCells.set(k, (list = []));
      list.push(n.id);
      n.kind = n.links.length > 2 ? 'junction' : n.links.length === 0 ? 'orphan' : 'bend';
    }
    this._g = new Float32Array(this.nodes.length);
    this._came = new Int32Array(this.nodes.length);
    this._stamp = new Int32Array(this.nodes.length);
    /** Total centreline length, for the record. */
    this.totalLength = this.edges.reduce((s, e) => s + e.len, 0);
    return this;
  }

  // --------------------------------------------------------------- lanes --

  /** Lateral offset (metres, right of a->b) and travel sign for a lane. */
  laneInfo(edge, lane, out = { offset: 0, dir: 1 }) {
    const fw = edge.forward;
    if (lane < fw) {
      out.dir = 1;
      out.offset = (lane + 0.5) * edge.laneWidth;
    } else {
      out.dir = -1;
      out.offset = -(lane - fw + 0.5) * edge.laneWidth;
    }
    return out;
  }

  _laneOffset(edge, lane) {
    const fw = edge.forward;
    return lane < fw
      ? (lane + 0.5) * edge.laneWidth
      : -(lane - fw + 0.5) * edge.laneWidth;
  }

  /**
   * World position at parameter `t` (0..1, always a -> b) along `lane`.
   * @returns {THREE.Vector3}
   */
  laneCenter(edgeId, lane = 0, t = 0.5, out = this._out) {
    const e = typeof edgeId === 'number' ? this.edges[edgeId] : edgeId;
    if (!e) return out.set(0, 0, 0);
    const na = this.nodes[e.a];
    const nb = this.nodes[e.b];
    const o = this._laneOffset(e, lane);
    // right of (dx,dz) is (-dz, dx)
    out.x = na.x + (nb.x - na.x) * t - e.dz * o;
    out.z = na.z + (nb.z - na.z) * t + e.dx * o;
    out.y = na.y + (nb.y - na.y) * t;
    return out;
  }

  /** Heading, in radians, of travelling along `lane` (respects direction). */
  laneYaw(edgeId, lane = 0) {
    const e = typeof edgeId === 'number' ? this.edges[edgeId] : edgeId;
    if (!e) return 0;
    const s = lane < e.forward ? 1 : -1;
    return Math.atan2(e.dx * s, e.dz * s);
  }

  laneCount(edge) {
    return edge.lanes;
  }

  // ------------------------------------------------------------- queries --

  /**
   * Nearest edge to a point. Returns a REUSED record — copy what you need.
   *
   * `y` IS NOT OPTIONAL DECORATION. Steel City has eleven bridges and every one
   * of them flies directly over a riverfront quay: in plan view a car on the
   * Sixth Street deck is two metres from the Allegheny Quay and eighteen metres
   * ABOVE it. A purely 2D query hands that car the quay, which puts it tens of
   * metres from "its" lane, which is what `traffic`'s harness measured as a
   * p90-p99 lateral error of 50-130 m and 13.9% of samples off the carriageway.
   * The same applies under a bridge, on a hillside switchback stacked over its
   * own lower leg, and on a parkway running beside a quay at a different level.
   *
   * When `y` is finite the winner is chosen by a 3D-ish score — horizontal
   * distance plus a stiff penalty on the height disagreement — while `dist`
   * still reports the plan distance every existing caller expects. `dy` carries
   * the signed height error so a caller can reject a hopeless projection.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} [maxDist]
   * @param {number} [y] world height of the query point; omit for a plan query
   */
  nearestEdge(x, z, maxDist = 220, y = NaN) {
    const out = this._near;
    out.edge = null;
    out.dist = Infinity;
    out.t = 0;
    out.lane = 0;
    out.dy = 0;
    out.y = 0;
    const useY = Number.isFinite(y);
    let bestScore = Infinity;
    const rings = Math.max(1, Math.ceil(maxDist / CELL));
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let ring = 0; ring <= rings; ring++) {
      // Everything in ring N is at least (N-1)*CELL away, so once the best hit
      // cannot be beaten by anything further out we are done. The old test —
      // "stop at the first ring after any hit" — could stop while the true
      // nearest edge was still one cell away.
      if (bestScore < Math.max(0, ring - 1) * CELL) break;
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
          const list = this._cells.get((cx + dx) * 73856093 ^ (cz + dz) * 19349663);
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const e = this.edges[list[i]];
            const na = this.nodes[e.a];
            const nb = this.nodes[e.b];
            segDist2(x, z, na.x, na.z, nb.x, nb.z, _seg);
            const d = Math.sqrt(_seg.d2);
            let score = d;
            let dy = 0;
            if (useY) {
              dy = na.y + (nb.y - na.y) * _seg.t - y;
              // A metre and a half of slack absorbs camber, suspension travel
              // and the 8 m terrain grid; past that a wrong deck is rejected
              // hard enough that no plan distance can win it back.
              const over = Math.abs(dy) - 1.5;
              if (over > 0) score += over * 12;
            }
            if (score < bestScore) {
              bestScore = score;
              out.dist = d;
              out.edge = e;
              out.t = _seg.t;
              out.dy = dy;
              out.y = na.y + (nb.y - na.y) * _seg.t;
            }
          }
        }
      }
    }
    if (out.edge) {
      // Which lane the point actually falls in.
      const e = out.edge;
      const na = this.nodes[e.a];
      const px = x - (na.x + (this.nodes[e.b].x - na.x) * out.t);
      const pz = z - (na.z + (this.nodes[e.b].z - na.z) * out.t);
      const lat = -e.dz * px + e.dx * pz; // signed right offset
      const fw = e.forward;
      if (lat >= 0) {
        out.lane = Math.min(fw - 1, Math.max(0, Math.floor(lat / e.laneWidth)));
      } else {
        const k = Math.min(e.lanes - fw - 1, Math.max(0, Math.floor(-lat / e.laneWidth)));
        out.lane = fw + k;
      }
    }
    return out;
  }

  nearestNode(x, z, maxDist = 320) {
    let best = null;
    let bd = maxDist * maxDist;
    const rings = Math.max(1, Math.ceil(maxDist / CELL));
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let dz = -rings; dz <= rings; dz++) {
      for (let dx = -rings; dx <= rings; dx++) {
        const list = this._nodeCells.get((cx + dx) * 73856093 ^ (cz + dz) * 19349663);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const n = this.nodes[list[i]];
          const d = (n.x - x) ** 2 + (n.z - z) ** 2;
          if (d < bd) {
            bd = d;
            best = n;
          }
        }
      }
    }
    return best;
  }

  /** Every edge whose bounding box overlaps the rect. Appends into `out`. */
  edgesInRect(x0, z0, x1, z1, out = []) {
    const cx0 = Math.floor(x0 / CELL);
    const cx1 = Math.floor(x1 / CELL);
    const cz0 = Math.floor(z0 / CELL);
    const cz1 = Math.floor(z1 / CELL);
    const seen = out._seen ?? (out._seen = new Set());
    seen.clear();
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = this._cells.get(cx * 73856093 ^ cz * 19349663);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const id = list[i];
          if (seen.has(id)) continue;
          seen.add(id);
          out.push(this.edges[id]);
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- A* ----

  /**
   * Shortest route between two nodes. Returns an array of node ids (including
   * both ends) or null. Cost is time, so a highway beats a back street.
   */
  route(fromNodeId, toNodeId, opts = {}) {
    const nodes = this.nodes;
    if (fromNodeId === toNodeId) return [fromNodeId];
    const from = nodes[fromNodeId];
    const to = nodes[toNodeId];
    if (!from || !to) return null;
    const g = this._g;
    const came = this._came;
    const stamp = this._stamp;
    const epoch = ++this._epoch;
    const heap = this._heap;
    heap.clear();
    const avoid = opts.avoidBridges ? true : false;
    const invMax = 1 / 34;
    g[fromNodeId] = 0;
    came[fromNodeId] = -1;
    stamp[fromNodeId] = epoch;
    heap.push(fromNodeId, Math.hypot(to.x - from.x, to.z - from.z) * invMax);
    const closed = new Set();
    let guard = 0;
    while (heap.n > 0) {
      if (++guard > 60000) break;
      const cur = heap.pop();
      if (cur === toNodeId) break;
      if (closed.has(cur)) continue;
      closed.add(cur);
      const n = nodes[cur];
      for (let i = 0; i < n.links.length; i++) {
        const e = this.edges[n.links[i]];
        if (avoid && e.bridge) continue;
        const other = e.a === cur ? e.b : e.a;
        // Respect one-ways when they point the wrong way.
        if (e.oneway && e.a !== cur) continue;
        if (closed.has(other)) continue;
        const cost = e.len / e.speed;
        const ng = g[cur] + cost;
        if (stamp[other] === epoch && ng >= g[other]) continue;
        stamp[other] = epoch;
        g[other] = ng;
        came[other] = cur;
        const on = nodes[other];
        heap.push(other, ng + Math.hypot(to.x - on.x, to.z - on.z) * invMax);
      }
    }
    if (stamp[toNodeId] !== epoch) return null;
    const path = [];
    let c = toNodeId;
    let guard2 = 0;
    while (c !== -1 && guard2++ < 20000) {
      path.push(c);
      if (c === fromNodeId) break;
      c = came[c];
    }
    path.reverse();
    return path[0] === fromNodeId ? path : null;
  }

  /**
   * True when two nodes are in the same connected component. `netgen` fills
   * `mainComponent` in `pruneIslands`; this is the cheap "can a car get from
   * here to there at all" test that `route()` would otherwise cost an A* for.
   */
  sameComponent(a, b) {
    const c = this.mainComponent;
    if (!c) return true;
    return c[a] !== -1 && c[a] === c[b];
  }

  /** The edge connecting two adjacent nodes on a route, or null. */
  edgeBetween(a, b) {
    const n = this.nodes[a];
    if (!n) return null;
    for (let i = 0; i < n.links.length; i++) {
      const e = this.edges[n.links[i]];
      if (e.a === b || e.b === b) return e;
    }
    return null;
  }

  // ------------------------------------------------------------- spawning --

  /**
   * A legal pose on a lane, in an annulus around `nearXZ`.
   * Returns a REUSED record `{ position, yaw, edge, lane, t, dir }` or null.
   */
  sampleSpawn(rng, nearXZ, minDist = 40, maxDist = 200, filter = null) {
    const cx = nearXZ?.x ?? 0;
    const cz = nearXZ?.z ?? 0;
    const pool = this._spawnPool ?? (this._spawnPool = []);
    pool.length = 0;
    const r = maxDist;
    const cellR = Math.ceil(r / CELL);
    const gx = Math.floor(cx / CELL);
    const gz = Math.floor(cz / CELL);
    const seen = this._spawnSeen ?? (this._spawnSeen = new Set());
    seen.clear();
    for (let dz = -cellR; dz <= cellR; dz++) {
      for (let dx = -cellR; dx <= cellR; dx++) {
        const list = this._cells.get((gx + dx) * 73856093 ^ (gz + dz) * 19349663);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const id = list[i];
          if (seen.has(id)) continue;
          seen.add(id);
          const e = this.edges[id];
          if (e.len < 14) continue;
          // Mill trackage is in the graph so the mesh builder can draw it. It
          // is not a road: nothing may ever be spawned on ballast.
          if (e.rail) continue;
          if (filter && !filter(e)) continue;
          const na = this.nodes[e.a];
          const nb = this.nodes[e.b];
          const mx = (na.x + nb.x) * 0.5 - cx;
          const mz = (na.z + nb.z) * 0.5 - cz;
          const d = Math.hypot(mx, mz);
          if (d < minDist || d > maxDist) continue;
          pool.push(e);
        }
      }
    }
    if (!pool.length) return null;
    const e = pool[rng.int(0, pool.length - 1)];
    const lane = rng.int(0, e.lanes - 1);
    const t = rng.range(0.12, 0.88);
    const out = this._spawn;
    this.laneCenter(e, lane, t, out.position);
    out.yaw = this.laneYaw(e, lane);
    out.edge = e;
    out.lane = lane;
    out.t = t;
    out.dir = lane < e.forward ? 1 : -1;
    return out;
  }

  /** Bulk stats for logs and the dev overlay. */
  stats() {
    const byKind = {};
    for (const e of this.edges) byKind[e.kind] = (byKind[e.kind] ?? 0) + e.len;
    return {
      nodes: this.nodes.length,
      edges: this.edges.length,
      km: this.totalLength / 1000,
      byKindKm: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, +(v / 1000).toFixed(2)])),
    };
  }
}
