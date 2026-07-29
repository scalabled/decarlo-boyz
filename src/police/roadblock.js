/**
 * POLICE — roadblocks, spike strips and bridge closures.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY BRIDGES
 * ────────────────────────────────────────────────────────────────────────────
 * Steel City is three landmasses separated by three rivers, and `world` marks
 * every crossing edge with `edge.bridge` / `edge.bridgeId`. Eleven bridges are
 * the ONLY road links between the three sides, which makes them the map's
 * chokepoints in the literal graph-theoretic sense: cut one and a third of the
 * city becomes unreachable by car.
 *
 * So at five stars the police stop chasing and start closing crossings. That is
 * what turns the geography from scenery into a mechanic — you can feel the map
 * shrink, and the decision "do I commit to the Birmingham Bridge or double back
 * into Steel Row" is the whole five-star game.
 *
 * A block is always built AHEAD of the quarry on its predicted route, never
 * where it currently is, and it is abandoned once the quarry is `blockStale`
 * metres past it — a block behind you is scenery.
 */

import * as THREE from 'three';
import { predictNode } from './path.js';
import { blockPoseAt } from './tactics.js';
import { ROLE } from './unit.js';
import { TUNE, clamp } from './tune.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

let _nextBlockId = 1;

export class BlockManager {
  constructor(sys) {
    this.sys = sys;
    this.blocks = [];
    this.root = new THREE.Group();
    this.root.name = 'police_blocks';
    /** vehicle -> seconds of shredded tyre left. */
    this.spiked = new Map();
    this._geo = null;
    this._mats = null;
    this._pool = [];
    this._timer = 0;
    this._bridges = null;
    this.stats = { blocks: 0, spiked: 0, bridgesClosed: 0 };
  }

  attach(ctx) {
    ctx.scene.add(this.root);
  }

  /* ==================================================================== */
  /* Bridge index                                                         */
  /* ==================================================================== */

  /**
   * Group every `edge.bridge` edge by `bridgeId` and find the two ends of each
   * crossing. The ends are the nodes that only one bridge edge touches — the
   * abutments, where a block seals the whole deck.
   */
  _indexBridges(roads) {
    if (this._bridges || !roads?.edges?.length) return this._bridges;
    const groups = new Map();
    for (const e of roads.edges) {
      if (!e.bridge) continue;
      const id = e.bridgeId ?? 'bridge';
      let g = groups.get(id);
      if (!g) groups.set(id, (g = { id, edges: [], count: new Map() }));
      g.edges.push(e);
      g.count.set(e.a, (g.count.get(e.a) ?? 0) + 1);
      g.count.set(e.b, (g.count.get(e.b) ?? 0) + 1);
    }
    const out = [];
    for (const g of groups.values()) {
      const ends = [];
      let cx = 0;
      let cz = 0;
      for (const [nodeId, c] of g.count) {
        if (c === 1) ends.push(roads.nodes[nodeId]);
      }
      for (const e of g.edges) {
        cx += (roads.nodes[e.a].x + roads.nodes[e.b].x) * 0.5;
        cz += (roads.nodes[e.a].z + roads.nodes[e.b].z) * 0.5;
      }
      if (ends.length < 1) continue;
      out.push({
        id: g.id,
        ends,
        x: cx / g.edges.length,
        z: cz / g.edges.length,
        length: g.edges.reduce((s, e) => s + e.len, 0),
      });
    }
    this._bridges = out;
    return out;
  }

  get bridges() {
    return this._bridges ?? [];
  }

  /* ==================================================================== */
  /* Frame                                                                */
  /* ==================================================================== */

  update(dt, ctx) {
    const sys = this.sys;
    this._indexBridges(sys.roads);
    this._ageSpikes(dt);

    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      b.age += dt;
      if (this._stale(b)) this._retire(i);
    }

    this._timer -= dt;
    if (this._timer <= 0) {
      this._timer = 1.4;
      const want = TUNE.blocks[sys.level] ?? 0;
      if (this.blocks.length < want && sys.quarry.valid) this._build(ctx);
    }

    this._spikeSweep(dt);
    this.stats.blocks = this.blocks.length;
    this.stats.spiked = this.spiked.size;
    this.stats.bridgesClosed = this.blocks.reduce((n, b) => n + (b.bridgeId ? 1 : 0), 0);
  }

  /** A block behind you, or one whose cars are all gone, is scenery. */
  _stale(b) {
    const sys = this.sys;
    if (sys.level < 3) return true;
    const w = sys.meter;
    const ref = sys.searchAnchor;
    if (!ref) return b.age > 40;
    // Measured against the belief like everything else here, which means a
    // block outlives the sighting that justified it. Give it a life: once they
    // have been searching this long with nothing to show, the cars are worth
    // more back in the sweep than parked across a road nobody has driven down.
    if (w.sinceSeen > 20 && b.age > 25) return true;
    const dx = ref.x - b.x;
    const dz = ref.z - b.z;
    const d = Math.hypot(dx, dz);
    if (d > TUNE.blockStale * 2.2) return true;
    // Past it: the dot of (quarry - block) with the direction the quarry was
    // expected to arrive from. Positive and far means they went through.
    const past = dx * -b.dirX + dz * -b.dirZ;
    if (past > TUNE.blockStale) return true;
    let live = 0;
    for (const u of b.units) if (u.active && u.vehicle && !u.vehicle.destroyed) live++;
    return live === 0 && b.age > 6;
  }

  _retire(i) {
    const b = this.blocks[i];
    this.blocks.splice(i, 1);
    for (const u of b.units) {
      if (u.active && u.role === ROLE.BLOCK) {
        u.role = ROLE.RESPOND;
        u.holdPose = null;
        u.blockId = -1;
        u._replan = 0;
      }
    }
    for (const o of b.officers) this.sys.officers.retire(o);
    b.officers.length = 0;
    if (b.spikeMesh) {
      this.root.remove(b.spikeMesh);
      this._pool.push(b.spikeMesh);
    }
  }

  /* ==================================================================== */
  /* Building a block                                                     */
  /* ==================================================================== */

  _build(ctx) {
    const sys = this.sys;
    const site = this._site();
    if (!site) return null;

    const n = TUNE.blockCars[sys.level] ?? 2;
    const poses = [];
    const from = sys.searchAnchor;
    for (let k = 0; k < n; k++) {
      const lateral = (k - (n - 1) / 2) * 3.0;
      const p = blockPoseAt(sys, site.node, from, lateral);
      if (p) poses.push(p);
    }
    if (!poses.length) return null;

    const b = {
      id: _nextBlockId++,
      x: poses[0].x,
      z: poses[0].z,
      y: site.node.y ?? 0,
      dirX: poses[0].dirX,
      dirZ: poses[0].dirZ,
      yaw: poses[0].yaw,
      edge: poses[0].edge,
      node: site.node,
      bridgeId: site.bridgeId ?? null,
      units: [],
      officers: [],
      poses,
      age: 0,
      spikeMesh: null,
      spike: null,
    };

    const units = sys.claimUnitsForBlock(b, poses.length);
    if (!units.length) return null;
    for (let i = 0; i < units.length; i++) {
      units[i].holdPose = poses[i % poses.length];
      units[i].blockId = b.id;
      b.units.push(units[i]);
    }

    if (sys.level >= 3) this._addSpikes(ctx, b);
    this.blocks.push(b);
    return b;
  }

  /**
   * Where to put it. Bridges first at five stars — closing a crossing is worth
   * far more than another junction. Otherwise a junction on the quarry's
   * predicted route, far enough ahead that the block is standing before they
   * arrive.
   */
  /**
   * A block is built ahead of the BELIEF — `police.searchAnchor` and the last
   * heading anybody actually observed (`meter.knownVX/VZ`) — never ahead of the
   * quarry's true, unobserved position. A roadblock standing across the road a
   * kilometre away, on the street you took after you lost them, is the same
   * cheat as spawning a cruiser in your mirror; it is just harder to see,
   * because what it does is put a pair of eyes back on you.
   */
  _site() {
    const sys = this.sys;
    const w = sys.meter;
    const roads = sys.roads;
    if (!roads) return null;

    if (sys.level >= TUNE.bridgeFromLevel) {
      const br = this._pickBridge();
      if (br) return br;
    }

    const from = sys.searchAnchor;
    if (!from) return null;
    const speed = Math.hypot(w.knownVX, w.knownVZ);
    const lead = clamp(
      Math.max(speed, 12) * (TUNE.interceptLead * 1.9),
      TUNE.blockLeadMin,
      TUNE.blockLead[sys.level] ?? 240
    );
    const node = predictNode(
      roads, from.x, from.z, w.knownVX, w.knownVZ,
      lead / Math.max(6, speed)
    );
    if (!node) return null;
    const d = Math.hypot(node.x - from.x, node.z - from.z);
    if (d < TUNE.blockLeadMin * 0.55) return null;
    if (this._occupied(node.x, node.z)) return null;
    return { node, bridgeId: null };
  }

  /**
   * The crossing they are most likely to need. Scored on: is it ahead of the
   * quarry's heading, how far (too near and they are already on it, too far and
   * they will never see it), and is it already closed.
   */
  _pickBridge() {
    const sys = this.sys;
    const w = sys.meter;
    const from = sys.searchAnchor;
    const list = this.bridges;
    if (!list.length || !from) return null;
    let best = null;
    let bestScore = -1e9;
    const bs = Math.hypot(w.knownVX, w.knownVZ);
    const hx = bs > 2 ? w.knownVX / bs : sys.quarry.forward.x;
    const hz = bs > 2 ? w.knownVZ / bs : sys.quarry.forward.z;

    for (const br of list) {
      if (this._closed(br.id)) continue;
      for (const end of br.ends) {
        const dx = end.x - from.x;
        const dz = end.z - from.z;
        const d = Math.hypot(dx, dz);
        if (d < 55 || d > 900) continue;
        const ahead = (dx / d) * hx + (dz / d) * hz;
        // AHEAD, full stop — the promise at the top of this file is that a block
        // is built ahead of the quarry on its predicted route, and a crossing is
        // not an exception to it. The scoring alone let a bridge slightly behind
        // the quarry win on distance: the harness counted 5 blocks built behind
        // against 9 ahead, all of them bridge closures at five stars.
        if (ahead < 0.15) continue;
        const score = ahead * 620 - Math.abs(d - 260) * 0.85;
        if (score > bestScore) {
          bestScore = score;
          best = { node: end, bridgeId: br.id };
        }
      }
    }
    return bestScore > -260 ? best : null;
  }

  _closed(bridgeId) {
    for (const b of this.blocks) if (b.bridgeId === bridgeId) return true;
    return false;
  }

  _occupied(x, z) {
    for (const b of this.blocks) {
      if ((b.x - x) ** 2 + (b.z - z) ** 2 < 140 * 140) return true;
    }
    return false;
  }

  /* ==================================================================== */
  /* Spike strips                                                         */
  /* ==================================================================== */

  _addSpikes(ctx, b) {
    const width = clamp((b.edge?.width ?? 9) * 0.95, 5, 20);
    const mesh = this._takeMesh(ctx, width);
    if (!mesh) return;
    // In front of the cars, on the side the quarry arrives from.
    const px = b.x + b.dirX * TUNE.spikeAhead;
    const pz = b.z + b.dirZ * TUNE.spikeAhead;
    const y = this.sys.groundAt(px, pz, b.y + 12) + 0.015;
    mesh.position.set(px, y, pz);
    mesh.rotation.y = Math.atan2(b.dirX, b.dirZ);
    mesh.updateMatrixWorld(true);
    this.root.add(mesh);
    b.spikeMesh = mesh;
    // The crossing test is a 2-D segment across the carriageway.
    const rx = -b.dirZ;
    const rz = b.dirX;
    b.spike = {
      ax: px - rx * width * 0.5, az: pz - rz * width * 0.5,
      bx: px + rx * width * 0.5, bz: pz + rz * width * 0.5,
    };
  }

  _takeMesh(ctx, width) {
    if (!this._geo) this._buildAssets(ctx);
    if (!this._geo) return null;
    const m = this._pool.pop() ?? new THREE.Mesh(this._geo, this._mats);
    m.scale.set(width / SPIKE_REF_WIDTH, 1, 1);
    m.castShadow = false;
    m.receiveShadow = true;
    m.userData.owNoShadow = true;
    m.frustumCulled = true;
    return m;
  }

  _buildAssets(ctx) {
    const mats = ctx.peek('materials');
    const base = mats?.get?.('rubber', { scale: 0.5 }) ??
      new THREE.MeshStandardMaterial({ color: 0x121214, roughness: 0.88, metalness: 0 });
    const steel = mats?.get?.('metal_brushed', { scale: 0.35 }) ??
      new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.34, metalness: 1 });
    // Materials from the shared library are owned by `materials` and must NOT
    // be disposed here; only the geometry below is ours.
    this._ownMats = !mats?.get;
    this._mats = [base, steel];
    this._geo = buildSpikeGeometry();
    ctx.peek('render')?.patchMaterials?.(this.root);
  }

  /** Segment-vs-segment sweep of every non-police vehicle against every strip. */
  _spikeSweep(dt) {
    const list = this.sys.vehicles?.vehicles;
    if (!list || !this.blocks.length) return;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.isPolice || v.destroyed) continue;
      if (this.spiked.has(v)) continue;
      const px = v.prevPosition.x;
      const pz = v.prevPosition.z;
      const cx = v.position.x;
      const cz = v.position.z;
      if ((cx - px) ** 2 + (cz - pz) ** 2 < 1e-4) continue;
      for (let k = 0; k < this.blocks.length; k++) {
        const s = this.blocks[k].spike;
        if (!s) continue;
        if (segCross(px, pz, cx, cz, s.ax, s.az, s.bx, s.bz)) {
          this._puncture(v);
          break;
        }
      }
    }
  }

  _puncture(v) {
    this.spiked.set(v, TUNE.spikeDrag);
    this.sys.vehicles.damage(v, 30, v.position);
    // Announce it — `fx` and `audio` can hang a blowout off a collision, and
    // the crowd should hear it.
    this.sys.ctx.events.emit('vehicle:collision', {
      vehicle: v,
      other: null,
      point: v.position.clone(),
      normal: _v.set(0, 1, 0).clone(),
      impulse: v.mass * 0.9,
      speed: v.speed,
      damage: 30,
    });
  }

  /**
   * A shredded tyre is not a handbrake: it is a steady drag plus a pull to one
   * side that gets worse the faster you are going. Applied to the velocity
   * directly because `vehicles` owns the tyre model and this system must not
   * reach into it.
   */
  _ageSpikes(dt) {
    if (!this.spiked.size) return;
    for (const [v, t] of this.spiked) {
      const left = t - dt;
      if (left <= 0 || v.destroyed) { this.spiked.delete(v); continue; }
      this.spiked.set(v, left);
      const sp = v.speed;
      if (sp > 0.6) {
        const k = Math.min(1, sp / 18);
        const drop = TUNE.spikeDecel * dt * k;
        v.velocity.multiplyScalar(Math.max(0, 1 - drop / Math.max(0.5, sp)));
        v.angularVelocity.y += (v.id % 2 ? 1 : -1) * dt * 0.55 * k;
      }
    }
  }

  isSpiked(v) {
    return this.spiked.has(v);
  }

  /* ==================================================================== */

  clear() {
    for (let i = this.blocks.length - 1; i >= 0; i--) this._retire(i);
    this.spiked.clear();
  }

  dispose() {
    this.clear();
    for (const m of this._pool) m.geometry = null;
    this._pool.length = 0;
    this._geo?.dispose();
    this._geo = null;
    if (this._ownMats && this._mats) for (const m of this._mats) m.dispose();
    this._mats = null;
    this.root.parent?.remove(this.root);
  }
}

/* ====================================================================== */
/* Geometry                                                               */
/* ====================================================================== */

const SPIKE_REF_WIDTH = 10;
const TEETH = 34;

/**
 * A stinger: a rubber spine with two staggered rows of hollow steel quills.
 * Two material groups — group 0 is the rubber base, group 1 the steel — so the
 * strip is not one flat-shaded colour, which is exactly the defect the review
 * log keeps finding on small props.
 */
function buildSpikeGeometry() {
  const g = new THREE.BufferGeometry();
  const pos = [];
  const nrm = [];
  const uv = [];

  const halfW = SPIKE_REF_WIDTH * 0.5;
  const depth = 0.13;
  const h = 0.035;

  // ---- base slab (a flattened box, top + two long sides + two ends) -----
  const box = (x0, x1, y0, y1, z0, z1) => {
    const F = [
      // +y
      [x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1, 0, 1, 0],
      // -y
      [x0, y0, z1, x1, y0, z1, x1, y0, z0, x0, y0, z0, 0, -1, 0],
      // +z
      [x0, y0, z1, x0, y1, z1, x1, y1, z1, x1, y0, z1, 0, 0, 1],
      // -z
      [x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z0, 0, 0, -1],
      // +x
      [x1, y0, z1, x1, y1, z1, x1, y1, z0, x1, y0, z0, 1, 0, 0],
      // -x
      [x0, y0, z0, x0, y1, z0, x0, y1, z1, x0, y0, z1, -1, 0, 0],
    ];
    for (const f of F) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz] = f;
      const quad = [ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz];
      for (let i = 0; i < 6; i++) {
        pos.push(quad[i * 3], quad[i * 3 + 1], quad[i * 3 + 2]);
        nrm.push(nx, ny, nz);
        uv.push((quad[i * 3] + halfW) / SPIKE_REF_WIDTH, quad[i * 3 + 2] / depth);
      }
    }
  };
  box(-halfW, halfW, 0, h, -depth * 0.5, depth * 0.5);
  const baseCount = pos.length / 3;

  // ---- quills -----------------------------------------------------------
  const quill = (cx, cz, len, lean) => {
    const r = 0.016;
    const tipX = cx + lean * 0.012;
    const tipY = h + len;
    const tipZ = cz - len * 0.30;
    const ring = [
      [cx - r, h, cz - r], [cx + r, h, cz - r], [cx + r, h, cz + r], [cx - r, h, cz + r],
    ];
    for (let i = 0; i < 4; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % 4];
      const ex = (a[0] + b[0]) * 0.5 - cx;
      const ez = (a[2] + b[2]) * 0.5 - cz;
      const el = Math.hypot(ex, ez) || 1;
      const nx = ex / el;
      const nz = ez / el;
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2], tipX, tipY, tipZ);
      for (let k = 0; k < 3; k++) {
        nrm.push(nx * 0.72, 0.62, nz * 0.72);
        uv.push(k * 0.5, k === 2 ? 1 : 0);
      }
    }
  };
  for (let i = 0; i < TEETH; i++) {
    const t = (i + 0.5) / TEETH;
    const x = -halfW + t * SPIKE_REF_WIDTH;
    const row = i % 2 === 0 ? -0.028 : 0.028;
    // Alternating length so the row is not a perfect comb.
    const len = 0.055 + ((i * 7919) % 13) * 0.0016;
    quill(x, row, len, i % 2 === 0 ? 1 : -1);
  }

  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.addGroup(0, baseCount, 0);
  g.addGroup(baseCount, pos.length / 3 - baseCount, 1);
  g.computeBoundingSphere();
  return g;
}

/** 2-D segment intersection. */
function segCross(ax, az, bx, bz, cx, cz, dx, dz) {
  const r1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const r2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  if (r1 * r2 > 0) return false;
  const r3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const r4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return r3 * r4 <= 0;
}

export { buildSpikeGeometry };
