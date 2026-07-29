import * as THREE from 'three';
import { Accum, trs, newTrs, clamp01, lerp, TAU, hash3i, smoothNoise } from './geom.js';
import { DISTRICT_STYLE, DEFAULT_STYLE, DISTRICT_NEON, SURFACE_TAG } from './palette.js';
import { polesOnEdge, armHeight, buildSpan, buildDrop, buildGuy, buildTrolley } from './wires.js';

/**
 * PROPS — the placement solver.
 *
 * Two hard requirements shape everything in this file.
 *
 * 1. TILE-INDEPENDENCE. A prop must not appear twice because two tiles both
 *    thought they owned it, and must not vanish because neither did. So every
 *    street-side prop is generated from a PURE FUNCTION OF THE ROAD EDGE — the
 *    whole edge, every time — and the tile then keeps only what falls inside
 *    its own bounds. Recomputing a 200 m edge three times costs microseconds
 *    and removes a whole class of streaming seam.
 *
 * 2. NOTHING REPEATS. A critic called out "every instance of every asset is at
 *    the same yaw", which read the street as "a kit laid on a grid rather than
 *    a place". Every emit() below carries yaw jitter, non-uniform scale, a lean,
 *    and a per-instance weathering mask triple. Spacings are drawn from the
 *    edge seed, not from a constant, so two streets never share a rhythm.
 *
 * The pavement cross-section is measured from `world` at runtime rather than
 * assumed: `_measureWalk` steps outward from the kerb face asking
 * `world.surfaceAt` until the answer stops being 'sidewalk'. That keeps props
 * on the pavement even if `world` retunes its road kinds.
 */

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
/** Scratch for the wall-backing probe — build time only, never per frame. */
const _wv = new THREE.Vector3();

/** How far a prop may stand from the kerb face before it is in the way. */
const KERB_LANE = 0.62;

/**
 * Footprint radius assumed when asking "is this piece of furniture in the road?"
 *
 * Deliberately one modest number rather than a per-prototype measurement: the
 * guard exists to catch a bin standing in a running lane, not to shave
 * centimetres off a bollard, and because `_clearOff` PUSHES before it drops,
 * erring generous costs at most a 0.25 m nudge back across a footway that is
 * 3.2 m wide. A straight street leaves 1.1 m of slack, so on the overwhelming
 * majority of the network this never fires at all.
 */
const KERB_CLEAR = 0.45;

/**
 * Junction furniture — signal masts, stop signs, street blades, hydrants.
 * Smaller than `KERB_CLEAR` because these are posts, and because a corner is
 * where the pavement is tightest and an over-generous rule deletes the sign
 * instead of moving it.
 */
const SIGN_CLEAR = 0.3;

/** Tree pit: the grate is ~1 m across, so half of it plus the kerb nib. */
const TREE_CLEAR = 0.55;

/**
 * Anything scattered inside a lot polygon. Generous on purpose — a skip in a
 * running lane is the worst thing this file can emit, there is no sensible
 * direction to nudge a lot-interior prop in, and a real yard keeps its road
 * frontage clear anyway.
 */
const LOT_CLEAR = 0.9;

/** Signboard colourways, rotated per shop unit. */
const PANELS = ['panel_cream', 'panel_navy', 'panel_maroon', 'panel_forest'];

/**
 * Pavement widths by corridor kind, used only when the runtime probe of
 * `world.surfaceAt` comes back empty. These mirror what `world` publishes
 * through `edge.kind`; the probe is still the authority when it answers.
 */
const FALLBACK_WALK = { arterial: 4.0, street: 3.2, highway: 0, alley: 0 };

/**
 * KERB PARKING GEOMETRY. These mirror `traffic/lanes.js` and `traffic/parking.js`
 * — the same 1.30 m inset from the kerb face to the centre of a parked car, so
 * a car this system stands at a bay and a car `traffic` stands at one line up
 * with each other instead of arguing over the same three metres of road.
 */
const PARK_INSET = 1.30;
/** Manoeuvring gap between two parked cars. Under this they interpenetrate. */
const BAY_GAP = 1.25;
/** Kerb kept clear at each end of the block — no parking in a junction throat. */
const BAY_END_CLEAR = 9;

/**
 * What stands at a kerb, with the LENGTH each one needs. The slot pitch is
 * derived from this rather than from a constant: a 6.2 m pitch cannot hold a
 * 7.2 m box truck, and `traffic` measured exactly that as 1.7 m of parked cars
 * intersecting each other.
 */
const KERB_TYPES = [
  { t: 'sedan', L: 4.8, w: 3.4 },
  { t: 'muscle', L: 5.1, w: 1.5 },
  { t: 'sports', L: 4.6, w: 1.1 },
  { t: 'van', L: 5.6, w: 1.4 },
  { t: 'truck', L: 7.2, w: 0.6 },
];
const KERB_TOTAL = KERB_TYPES.reduce((a, b) => a + b.w, 0);

function pickKerbType(u) {
  let r = u * KERB_TOTAL;
  for (const k of KERB_TYPES) {
    r -= k.w;
    if (r <= 0) return k;
  }
  return KERB_TYPES[0];
}

export class Layout {
  constructor({ world, lib, peek, q }) {
    this.world = world;
    this.lib = lib;
    /** Runtime access to other subsystems — never an import (rule 2). */
    this.peek = peek ?? (() => null);
    /**
     * `q.grassDensity` was declared in `src/core/config.js` for all four tiers
     * and read by nobody, so the ground cover cost the same on `low` as on
     * `ultra`. It scales the verge and park scatter, which is where every blade
     * of grass in the game comes from.
     */
    this.grassDensity = q?.grassDensity ?? 0.6;
    this._laneNet = null;
    this._walkCache = new Map(); // edge.id -> { hw, sw, padA, padB }
    this._poles = [];
    this._edges = [];
    this.trolleyDistricts = new Set(['downtown', 'strip', 'point']);
  }

  /* ================================================================== */
  /* world queries                                                      */
  /* ================================================================== */

  styleOf(x, z) {
    const d = this.world.districtAt?.(x, z);
    return (d && DISTRICT_STYLE[d.id]) || DEFAULT_STYLE;
  }

  districtIdAt(x, z) {
    return this.world.districtAt?.(x, z)?.id ?? 'lawren';
  }

  /**
   * Measure this edge's cross-section once. `edge.width` is published by the
   * world contract; the pavement width is not, so it is probed.
   */
  _walk(edge) {
    let rec = this._walkCache.get(edge.id);
    if (rec) return rec;
    const g = this.world.roads;
    const na = g.nodes[edge.a];
    const nb = g.nodes[edge.b];
    const hw = edge.width * 0.5;
    const mx = (na.x + nb.x) * 0.5;
    const mz = (na.z + nb.z) * 0.5;
    const rx = -edge.dz;
    const rz = edge.dx;
    let sw = 0;
    if (this.world.surfaceAt) {
      for (let d = hw + 0.45; d < hw + 6.2; d += 0.35) {
        if (this.world.surfaceAt(mx + rx * d, mz + rz * d) !== 'sidewalk') break;
        sw = d - hw - 0.33;
      }
    }
    // The probe can miss — a midpoint that happens to fall inside a junction
    // pad answers 'asphalt' and the whole street would come out bare. Fall
    // back to the corridor's own kind rather than dressing nothing.
    if (sw < 1.1 && FALLBACK_WALK[edge.kind]) sw = FALLBACK_WALK[edge.kind];

    /**
     * Junction clearance. `world` stops the carriageway short of a node by
     * roughly the widest connecting road; furniture has to clear the same
     * circle plus a little for the corner fillet — but no more than that. An
     * over-generous pad is why a first pass left every short block completely
     * bare: at 14 m per end, a 40 m block has 12 m of usable kerb.
     */
    const pad = (nodeId) => {
      const n = g.nodes[nodeId];
      let r = 3;
      for (const eid of n.links) r = Math.max(r, g.edges[eid].width * 0.5);
      return r * (n.links.length > 2 ? 1.18 : 1.02) + 1.2;
    };
    rec = { hw, sw, padA: pad(edge.a), padB: pad(edge.b) };
    this._walkCache.set(edge.id, rec);
    return rec;
  }

  /** World position on the pavement: `off` metres out from the kerb face. */
  _pos(edge, s, side, off, out = _v) {
    const g = this.world.roads;
    const na = g.nodes[edge.a];
    const nb = g.nodes[edge.b];
    const t = s / edge.len;
    const w = this._walk(edge);
    const lat = (w.hw + 0.33 + off) * side;
    out.x = na.x + (nb.x - na.x) * t - edge.dz * lat;
    out.z = na.z + (nb.z - na.z) * t + edge.dx * lat;
    // road level at the kerb + kerb height + the pavement's cross-fall
    out.y = na.y + (nb.y - na.y) * t + 0.150 + off * 0.02;
    return out;
  }

  /** Yaw that faces the carriageway from `side`. */
  _facing(edge, side) {
    return Math.atan2(-edge.dz * side, edge.dx * side);
  }

  /** Yaw along the street. */
  _along(edge) {
    return Math.atan2(edge.dx, edge.dz);
  }

  /* ================================================================== */
  /* the tile entry point                                               */
  /* ================================================================== */

  /**
   * @param {TileBatch} B
   * @param {{x0,z0,x1,z1}} bx tile bounds in XZ
   * @param {number} lod 0 = full detail, 1 = the far skeleton
   */
  buildTile(B, bx, lots, lod, rng, parked) {
    const roads = this.world.roads;
    if (!roads) return;
    const edges = this._edges;
    edges.length = 0;
    roads.edgesInRect(bx.x0 - 40, bx.z0 - 40, bx.x1 + 40, bx.z1 + 40, edges);

    for (const e of edges) {
      if (e.rail) continue;
      this._edgeFurniture(B, e, bx, lod, parked);
      this._edgeWires(B, e, bx, lod);
      if (lod === 0) this._edgeDecals(B, e, bx);
    }
    for (const lot of lots ?? []) this._lot(B, lot, bx, lod, rng, parked);
    if (lod === 0) this._wasteGround(B, bx, lots, rng);
  }

  _in(bx, x, z) {
    return x >= bx.x0 && x < bx.x1 && z >= bx.z0 && z < bx.z1;
  }

  /* ================================================================== */
  /* street furniture along an edge                                     */
  /* ================================================================== */

  _edgeFurniture(B, edge, bx, lod, parked) {
    const w = this._walk(edge);
    if (w.sw < 1.1 && edge.kind !== 'alley') return;
    const L = edge.len;
    const s0 = w.padA;
    const s1 = L - w.padB;
    if (s1 - s0 < 6) return;
    const eSeed = (edge.id * 2654435761) >>> 0;

    for (const side of [-1, 1]) {
      const mid = this._pos(edge, L * 0.5, side, 1.0, new THREE.Vector3());
      const style = this.styleOf(mid.x, mid.z);
      const district = this.districtIdAt(mid.x, mid.z);
      const sSeed = (eSeed ^ (side > 0 ? 0x5bf03635 : 0x27d4eb2d)) >>> 0;

      this._lampRun(B, edge, side, s0, s1, sSeed, style, bx, lod);
      this._treeRun(B, edge, side, s0, s1, sSeed, style, bx, lod, w);
      this._cornerKit(B, edge, side, s0, s1, sSeed, style, bx, lod);
      if (lod === 0) {
        this._kerbClutter(B, edge, side, s0, s1, sSeed, style, bx, w, district);
        this._wallClutter(B, edge, side, s0, s1, sSeed, style, bx, w, district);
      }
      if (parked) this._parking(edge, side, s0, s1, sSeed, style, bx, parked);
    }
  }

  /* -------------------------------------------------------- lamp posts -- */

  _lampRun(B, edge, side, s0, s1, seed, style, bx, lod) {
    // Lamps stagger: one side gets them at 0, the other at half a pitch, which
    // is what a real street does and what stops a corridor of paired columns.
    const kind = style.lampKind;
    const pitch = (kind === 'acorn' || kind === 'park' ? 21 : 29) * (0.86 + hash3i(seed, 1, 1) * 0.3);
    const phase = side > 0 ? 0.5 : 0;
    // Alleys get a wall bracket, not a column.
    if (edge.kind === 'alley') return;
    const both = edge.kind === 'arterial' || edge.kind === 'highway' || style.lampKind === 'twin';
    if (!both && side < 0) return;

    const wk = this._walk(edge);
    const maxOff = Math.max(KERB_LANE + 0.2, wk.sw - 0.45);
    let i = 0;
    for (let s = s0 + pitch * phase; s < s1; s += pitch, i++) {
      const h = hash3i(seed, i, 11);
      if (h > 0.94) continue; // one column in sixteen was never replaced
      const p = this._clearOff(edge, s + (h - 0.5) * 2.4, side, KERB_LANE + h * 0.18,
        SIGN_CLEAR, maxOff, new THREE.Vector3());
      if (!p || !this._in(bx, p.x, p.z)) continue;
      const face = this._facing(edge, side);
      const yaw = face + (hash3i(seed, i, 12) - 0.5) * 0.14;
      const lean = (hash3i(seed, i, 13) - 0.5) * 0.035;
      const sc = 0.94 + hash3i(seed, i, 14) * 0.14;
      const mask = [
        0.55 + hash3i(seed, i, 15) * 0.75,
        0.5 + hash3i(seed, i, 16) * 0.85,
        0.6 + hash3i(seed, i, 17) * 0.5,
      ];
      const M = trs(new THREE.Matrix4(), p.x, p.y, p.z, yaw, sc, sc, sc, lean, lean * 0.6);

      if (kind === 'acorn' || kind === 'park') {
        const tag = kind;
        B.put(`lamp_${tag}`, M, mask);
        B.put(`lamp_${tag}_globe`, M, mask);
        if (lod === 0) B.put(`lamp_${tag}_glow`, M, null);
      } else if (kind === 'twin') {
        B.put('lamp_twin', M, mask);
        B.put('lamp_twin_head', M, mask);
        B.put('lamp_twin_lens', M, mask);
        if (lod === 0) B.put('lamp_twin_glow', M, null);
      } else {
        // Not `i % 3`: a cycle of three down a 29 m pitch is a repeat every 87 m,
        // and a critic logged "the same lamp" down one block.
        const v = Math.floor(hash3i(seed, i, 111) * 3) % 3;
        B.put(`lamp_cobra_${v}`, M, mask);
        B.put(`lamp_cobra_head_${v}`, M, mask);
        B.put(`lamp_cobra_lens_${v}`, M, mask);
        if (lod === 0) B.put(`lamp_cobra_glow_${v}`, M, null);
      }
      if (lod === 0) {
        B.box('metal', p.x, p.y, p.z, 0.26, 3.0, 0.26);
        /**
         * Record where the light actually IS. Street lighting is emissive plus
         * bloom (ARCHITECTURE.md is explicit that a punctual light per lamp is
         * not affordable), but `render.submitLight` scores a handful of nearby
         * requests into a FIXED pool, so the two or three lamps closest to the
         * camera can be real — which is what puts a moving sodium pool on wet
         * asphalt instead of a painted one.
         */
        const armR = kind === 'acorn' || kind === 'park' ? 0 : 2.1 * sc;
        B.lamps.push({
          x: p.x - Math.sin(yaw) * 0 + Math.cos(yaw) * 0 + (kind === 'twin' ? 0 : Math.cos(yaw) * 0),
          y: p.y + (kind === 'acorn' ? 4.3 : kind === 'park' ? 3.2 : 8.9) * sc,
          z: p.z,
          r: armR,
          yaw,
        });
        // the things that end up bolted to a lamp column
        const r = hash3i(seed, i, 18);
        if (r < 0.22) {
          // Bolted to the column but 0.11 m off it, on the road-facing side —
          // enough to cross a lane edge the column itself just cleared.
          const px = p.x - Math.sin(yaw) * 0.11;
          const pz = p.z - Math.cos(yaw) * 0.11;
          if (this._clearsLanes(px, p.y, pz, SIGN_CLEAR)) {
            B.put('sign_plate_small', trs(new THREE.Matrix4(), px, p.y + 2.1, pz, yaw), mask);
          }
        }
        if (r > 0.80 && style.signage > 0.5) {
          B.put('banner_pair', trs(new THREE.Matrix4(),
            p.x, p.y + 4.6, p.z, yaw + Math.PI / 2, 1, 1, 1), mask);
        }
        if (hash3i(seed, i, 19) < 0.30) {
          B.put('sticker_cluster', trs(new THREE.Matrix4(),
            p.x - Math.sin(yaw) * 0.105, p.y, p.z - Math.cos(yaw) * 0.105, yaw), null);
        }
      }
    }
  }

  /* ------------------------------------------------------------ trees -- */

  _treeRun(B, edge, side, s0, s1, seed, style, bx, lod, w) {
    if (style.trees <= 0.02) return;
    if (w.sw < 2.0) return;
    const pitch = (9.5 / Math.max(0.25, style.trees)) * (0.85 + hash3i(seed, 2, 1) * 0.35);
    /**
     * Four street species, not three. A boulevard of forty trees showed each
     * crown seven times; the callery pear is columnar and half the width of a
     * plane, so it also breaks the SKYLINE of a run of trees, which is what the
     * eye actually counts.
     */
    const SP = ['plane', 'maple', 'locust', 'pear'];
    let i = 0;
    for (let s = s0 + pitch * (0.3 + hash3i(seed, 3, 1) * 0.5); s < s1; s += pitch, i++) {
      const h = hash3i(seed, i, 21);
      if (h > 0.86) continue; // a dead pit, or one nobody replanted
      const off = Math.min(w.sw - 0.95, 0.95 + hash3i(seed, i, 22) * 0.45);
      if (off < 0.7) continue;
      // A tree pit is 1 m of grate and a trunk; it cannot straddle a kerb line.
      const p = this._clearOff(edge, s + (h - 0.5) * 3.2, side, off,
        TREE_CLEAR, Math.max(off, w.sw - 0.85), new THREE.Vector3());
      if (!p || !this._in(bx, p.x, p.z)) continue;
      const young = hash3i(seed, i, 23) < 0.20;
      /**
       * NO CYCLES. `SP[(i + seed) % 3]` walked plane-maple-locust-plane down
       * every block, and with three canopy variants that is a visible period of
       * three — a critic counted "the same autumn tree six times" on one street.
       * Species, canopy and leaf are now three independent hashes.
       */
      const sp = young ? 'young' : SP[Math.floor(hash3i(seed, i, 24) * SP.length) % SP.length];
      /**
       * Past the near horizon the tree switches to the FAR crown: a third of
       * the cards at nearly twice the size. A skeleton tile used to instance
       * the full 190-card canopy for a tree that resolves to twenty pixels,
       * which is most of what vegetation costs in a driving frame.
       */
      const v = lod !== 0 ? 'far' : Math.floor(hash3i(seed, i, 224) * 4) % 4;
      /**
       * Autumn is ONE species turning, not a quarter of the street. It rides on
       * the species so a block reads as a planting scheme rather than a random
       * draw, and it is rare enough that the eye does not pair two of them up.
       */
      const aut = sp === 'maple' ? 0.34 : sp === 'locust' ? 0.10 : 0.03;
      const lh = hash3i(seed, i, 25);
      const li = lod !== 0 ? 0 : lh < aut ? 3 : Math.floor((lh - aut) / (1 - aut) * 3) % 3;
      const yaw = hash3i(seed, i, 26) * TAU;
      const sc = 0.74 + hash3i(seed, i, 27) * 0.58;
      const scz = sc * (0.9 + hash3i(seed, i, 28) * 0.2);
      const lean = (hash3i(seed, i, 29) - 0.5) * 0.10;
      const mask = [0.5 + hash3i(seed, i, 30), 0.4 + hash3i(seed, i, 31) * 0.9, 0.7];
      // nobody plants a plane tree under a viaduct deck — see `_headroom`
      if (!this._headroom(p.x, p.y, p.z, 8.5 * sc)) continue;
      const M = trs(new THREE.Matrix4(), p.x, p.y - 0.02, p.z, yaw, sc, sc * (0.9 + hash3i(seed, i, 32) * 0.25), scz, lean, lean * 0.7);
      B.put(`tree_${sp}_${v}_wood`, M, mask);
      B.put(`tree_${sp}_${v}_leaf${li}`, M, [mask[0], mask[1] * 0.8, 0.8]);
      if (lod === 0) {
        B.put('tree_grate', trs(new THREE.Matrix4(), p.x, p.y + 0.01, p.z, yaw * 0.7, 0.86 + sc * 0.2), null);
        B.box('wood', p.x, p.y, p.z, 0.34, 2.4, 0.34);
        // The companion weed takes the tree's random yaw, so half the time it
        // is thrown 0.55 m toward the carriageway from a pit already at the kerb.
        if (hash3i(seed, i, 33) < 0.35) {
          const wx = p.x + Math.cos(yaw) * 0.55;
          const wz = p.z + Math.sin(yaw) * 0.55;
          if (this._clearsLanes(wx, p.y, wz, 0.3)) {
            B.put('weed_tuft', trs(new THREE.Matrix4(),
              wx, p.y, wz, yaw * 1.7, 0.8 + hash3i(seed, i, 34) * 0.6), null);
          }
        }
        // a tree guard on the young ones
        if (young && hash3i(seed, i, 35) < 0.5) {
          B.put('rail_guard', trs(new THREE.Matrix4(), p.x, p.y, p.z, yaw, 0.42, 0.7, 0.42), mask);
        }
      }
    }
  }

  /* ----------------------------------------------------- junction kit -- */

  /**
   * A CORNER PROP HAS TO CLEAR EVERY ARM OF ITS JUNCTION, NOT JUST ITS OWN.
   *
   * This is the bug that put a stop sign in the middle of the road, and the
   * measurement is unambiguous. Edge 716 (Sycamore,
   * 27.6 m) ends at node 719, a five-way; edge 717 leaves that same node and
   * folds back at 43 degrees over an 11 m stub. The stop sign for 716 was placed
   * at `s0 - 0.5` — half a metre INTO the junction throat — and 4.55 m out from
   * 716's own centreline, which put it 0.06 m from the centreline of 717. Dead
   * in the road, and legal by every test the old code ran,
   * because every test it ran was about edge 716.
   *
   * Two changes. The kit now starts at `s0` rather than inside the throat, and
   * when a spot still fouls a lane it RETREATS ALONG THE APPROACH before giving
   * up: at an acute fork no amount of pushing sideways helps, because sideways
   * is further into the other road. Backing off down your own kerb does.
   */
  _clearCorner(edge, end, s0, s1, side, off, clearance, out = new THREE.Vector3()) {
    const wk = this._walk(edge);
    const maxOff = Math.max(off, wk.sw - 0.4);
    for (let back = 0; back <= 8.001; back += 1.0) {
      const s = end === 0 ? s0 + back : s1 - back;
      if (s < 0 || s > edge.len) continue;
      if (this._clearOff(edge, s, side, off, clearance, maxOff, out)) return out;
    }
    return null;
  }

  _cornerKit(B, edge, side, s0, s1, seed, style, bx, lod) {
    const g = this.world.roads;
    for (const end of [0, 1]) {
      const node = g.nodes[end === 0 ? edge.a : edge.b];
      const busy = node.links.length;
      if (busy < 3) continue;
      const nSeed = (Math.imul(node.id + 1, 0x9e3779b1) ^ (side > 0 ? 7 : 13) ^ Math.imul(edge.id + 1, 31)) >>> 0;
      const p = this._clearCorner(edge, end, s0, s1, side, KERB_LANE + 0.15, SIGN_CLEAR);
      if (!p || !this._in(bx, p.x, p.z)) continue;
      const face = this._facing(edge, side);
      const toward = end === 0 ? this._along(edge) : this._along(edge) + Math.PI;
      const mask = [0.6 + hash3i(nSeed, 1, 1) * 0.7, 0.55 + hash3i(nSeed, 2, 1) * 0.8, 0.6];

      // Real cities signalise a minority of junctions; the rest get a stop
      // sign or nothing at all. At 62% of every 3-way this kit was putting
      // twenty-two signal masts in a 128 m tile.
      const signalise = edge.kind === 'arterial' ? busy >= 3 : busy >= 4;
      if (signalise && hash3i(nSeed, 3, 1) < 0.30) {
        const yaw = toward + Math.PI + (hash3i(nSeed, 4, 1) - 0.5) * 0.1;
        const M = trs(new THREE.Matrix4(), p.x, p.y, p.z, yaw, 1, 0.96 + hash3i(nSeed, 5, 1) * 0.1, 1,
          (hash3i(nSeed, 6, 1) - 0.5) * 0.03);
        B.put('signal_post', M, mask);
        B.put('signal_head_main', M, mask);
        B.put('signal_head_side', M, mask);
        // Which aspect burns is a function of the junction, so opposing
        // approaches are not both green.
        const phase = Math.floor(hash3i(nSeed, 7, 1) * 3);
        const tag = ['red', 'amber', 'green'][((phase + (end === 0 ? 0 : 1)) % 3)];
        if (lod === 0) {
          B.put(`signal_lit_${tag}_main`, M, null);
          B.put(`signal_lit_${tag}_side`, M, null);
        }
        if (lod === 0) B.box('metal', p.x, p.y, p.z, 0.24, 3.2, 0.24);
      } else if (lod === 0 && hash3i(nSeed, 8, 1) < 0.55) {
        const yaw = toward + Math.PI + (hash3i(nSeed, 9, 1) - 0.5) * 0.28;
        const sc = 0.94 + hash3i(nSeed, 10, 1) * 0.14;
        const M = trs(new THREE.Matrix4(), p.x, p.y, p.z, yaw, sc, sc, sc,
          (hash3i(nSeed, 11, 1) - 0.5) * 0.09, (hash3i(nSeed, 12, 1) - 0.5) * 0.07);
        B.put('sign_stop', M, mask);
        B.put('sign_stop_face', M, mask);
        if (lod === 0 && hash3i(nSeed, 13, 1) < 0.3) B.put('sticker_cluster', M, null);
      }

      // Street name blades on one corner of every junction.
      if (lod === 0 && hash3i(nSeed, 14, 1) < 0.42) {
        // Was `s0 - 1.6` — 1.6 m further into the junction than the stop sign.
        const p2 = this._clearCorner(edge, end, s0 + 1.6, s1 - 1.6, side, KERB_LANE + 0.5, SIGN_CLEAR);
        if (p2 && this._in(bx, p2.x, p2.z)) {
          const yaw = this._along(edge) + (hash3i(nSeed, 15, 1) - 0.5) * 0.2;
          const sc = 0.95 + hash3i(nSeed, 16, 1) * 0.12;
          const M = trs(new THREE.Matrix4(), p2.x, p2.y, p2.z, yaw, sc, sc, sc, (hash3i(nSeed, 17, 1) - 0.5) * 0.05);
          B.put('sign_street_post', M, mask);
          B.put('sign_street_blades', M, mask);
        }
      }

      if (lod !== 0) continue;

      // Pedestrian signal, hydrant and a bin cluster at the corner.
      if (signalise && hash3i(nSeed, 18, 1) < 0.7) {
        const p3 = this._clearCorner(edge, end, s0 + 1.4, s1 - 1.4, side, KERB_LANE + 0.05, SIGN_CLEAR);
        if (p3 && this._in(bx, p3.x, p3.z)) {
          const M = trs(new THREE.Matrix4(), p3.x, p3.y, p3.z, face + Math.PI + (hash3i(nSeed, 19, 1) - 0.5) * 0.2);
          B.put('ped_signal', M, mask);
          B.put('ped_signal_lens', M, null);
        }
      }
      if (hash3i(nSeed, 20, 1) < style.hydrant * 0.45) {
        const p4 = this._clearCorner(edge, end, s0 + 3.4, s1 - 3.4, side, KERB_LANE + 0.1, SIGN_CLEAR);
        if (p4 && this._in(bx, p4.x, p4.z)) {
          const sc = 0.92 + hash3i(nSeed, 21, 1) * 0.18;
          B.put(hash3i(nSeed, 22, 1) < 0.75 ? 'hydrant_a' : 'hydrant_b',
            trs(new THREE.Matrix4(), p4.x, p4.y, p4.z, hash3i(nSeed, 23, 1) * TAU, sc, sc, sc,
              (hash3i(nSeed, 24, 1) - 0.5) * 0.08), mask);
        }
      }
    }
  }

  /* ---------------------------------------------------- kerb clutter --- */

  _kerbClutter(B, edge, side, s0, s1, seed, style, bx, w, district) {
    const usable = s1 - s0;
    if (usable < 8) return;
    const face = this._facing(edge, side);
    const along = this._along(edge);
    /** How far back across the footway a fouled prop may be pushed. */
    const maxOff = Math.max(KERB_LANE + 0.3, w.sw - 0.5);

    // Parking meters: a metronome by design, so they get the jitter instead.
    if (style.meters > 0.08 && edge.kind !== 'alley' && hash3i(seed, 41, 1) < style.meters) {
      const pitch = 5.8 + hash3i(seed, 42, 1) * 1.4;
      let i = 0;
      for (let s = s0 + 3; s < s1 - 3; s += pitch, i++) {
        const h = hash3i(seed, i, 43);
        if (h > 0.88) continue;
        const p = this._clearOff(edge, s + (h - 0.5) * 0.8, side, KERB_LANE - 0.1,
          KERB_CLEAR, maxOff, new THREE.Vector3());
        if (!p || !this._in(bx, p.x, p.z)) continue;
        const id = hash3i(seed, i, 44) < 0.55 ? 'meter_single' : 'meter_twin';
        const sc = 0.94 + hash3i(seed, i, 45) * 0.12;
        B.put(id, trs(new THREE.Matrix4(), p.x, p.y, p.z,
          face + (hash3i(seed, i, 46) - 0.5) * 0.4, sc, sc, sc,
          (hash3i(seed, i, 47) - 0.5) * 0.12, (hash3i(seed, i, 48) - 0.5) * 0.10),
          [0.6 + h, 0.5 + hash3i(seed, i, 49) * 0.9, 0.6]);
      }
    }

    // Everything else: a Poisson-ish walk down the kerb, family drawn by weight.
    const FAMS = [
      { id: ['bin_mesh'], w: 0.9, len: 0.7, tag: 'metal' },
      { id: ['bin_drum'], w: 0.5, len: 0.8, tag: 'metal' },
      { id: ['bin_concrete'], w: 0.4, len: 0.9, tag: 'concrete' },
      { id: ['bollard_steel'], w: 0.8, len: 0.4, tag: 'metal' },
      { id: ['bollard_iron'], w: 0.6, len: 0.4, tag: 'metal' },
      { id: ['bollard_concrete'], w: 0.4, len: 0.5, tag: 'concrete' },
      { id: ['bollard_flex'], w: 0.3, len: 0.3, tag: 'plastic' },
      { id: ['bench_slat', 'bench_ends'], w: 0.55, len: 2.0, tag: 'wood', bench: true },
      { id: ['bench_concrete'], w: 0.3, len: 2.0, tag: 'concrete', bench: true },
      { id: ['postbox_us'], w: 0.22, len: 0.8, tag: 'metal' },
      { id: ['postbox_relay'], w: 0.18, len: 0.7, tag: 'metal' },
      { id: ['newsbox_a', 'newsbox_b'], w: 0.3, len: 1.1, tag: 'metal', row: true },
      { id: ['newsbox_c', 'newsbox_d'], w: 0.25, len: 1.1, tag: 'metal', row: true },
      { id: ['phone_hood'], w: 0.2, len: 0.9, tag: 'metal' },
      { id: ['phone_booth_frame', 'phone_booth_glass'], w: 0.14, len: 1.1, tag: 'metal' },
      { id: ['cabinet_util'], w: 0.28, len: 1.2, tag: 'metal' },
      { id: ['meter_kiosk'], w: 0.14, len: 0.6, tag: 'metal' },
      { id: ['planter_concrete', 'planter_soil', 'shrub_a'], w: 0.45, len: 1.4, tag: 'concrete', planter: true },
      { id: ['planter_timber', 'planter_soil', 'shrub_c'], w: 0.3, len: 1.6, tag: 'wood', planter: true },
      { id: ['bike_chained'], w: 0.4, len: 1.3, tag: 'metal', bike: true },
      { id: ['cone'], w: 0.35, len: 0.4, tag: 'plastic', cone: true },
      { id: ['sign_reg', 'sign_reg_face'], w: 0.4, len: 0.4, tag: 'metal', sign: true },
      { id: ['sign_reg', 'sign_reg_face2'], w: 0.28, len: 0.4, tag: 'metal', sign: true },
      { id: ['sign_warn', 'sign_warn_face'], w: 0.22, len: 0.4, tag: 'metal', sign: true },
      { id: ['sign_reg', 'sign_oneway_face'], w: 0.2, len: 0.4, tag: 'metal', sign: true },
      { id: ['standpipe'], w: 0.12, len: 0.5, tag: 'metal' },
      { id: ['rail_guard'], w: 0.35, len: 2.0, tag: 'metal', rail: true },
    ];
    let total = 0;
    for (const f of FAMS) total += f.w;

    const density = 0.85 + style.litter * 0.45 + (style.kind === 'core' ? 0.30 : 0);
    let s = s0 + 1.5 + hash3i(seed, 50, 1) * 4;
    let i = 0;
    while (s < s1 - 2 && i < 140) {
      i++;
      const h = hash3i(seed, i, 51);
      const gap = 1.6 + h * 6.4 / Math.max(0.2, density);
      s += gap;
      if (s > s1 - 2) break;
      /**
       * Family FIRST, then the spot. A bench is 2 m long and a bollard is
       * 0.15 m, and asking the same clearance for both either leaves half a
       * bench in the lane or pushes every bollard to the back of the footway.
       * `len` is already the family's along-street footprint, so it is also the
       * radius to keep clear when the kerb it stands on runs at an angle to the
       * lane it must not foul.
       */
      let r = hash3i(seed, i, 53) * total;
      let fam = FAMS[0];
      for (const f of FAMS) {
        r -= f.w;
        if (r <= 0) {
          fam = f;
          break;
        }
      }
      /**
       * A planter is measured by its SHRUB, not by its tub. `planter_concrete`
       * is 1.4 m across but `shrub_c` on top of it spreads past 1.3 m, and it is
       * the foliage that ends up over the running lane — 810 of them, which is
       * enough to read as a planted central reservation rather than a kerb.
       */
      const clear = fam.planter ? 1.35 : Math.max(KERB_CLEAR, fam.len * 0.5);
      const p = this._clearOff(edge, s, side, KERB_LANE + hash3i(seed, i, 52) * 0.22,
        clear, maxOff, new THREE.Vector3());
      if (!p || !this._in(bx, p.x, p.z)) continue;
      /**
       * NINETY DEGREES OUT. `along` was chosen for the families that "run along
       * the kerb" — but every one of those prototypes is authored X-LONG
       * (`bench_slat` is 1.82 m on X, `rail_guard` 2.0 m on X, its posts at
       * x=±1.0), and a yaw of `_along` maps local +Z to the street, so their
       * length was being laid ACROSS the footway. Half of each one stood in the
       * carriageway: 3551 guardrails and 246 benches, up to 1.44 m into a live
       * lane. `_facing` maps local +X along the street and local +Z at the
       * carriageway, which is what these were modelled for. A bench then gets a
       * further half-turn so the seat looks at the street and the backrest is
       * against the building, instead of the reverse.
       */
      const yawBase = fam.bench ? face + Math.PI : face;
      const yaw = yawBase + (hash3i(seed, i, 54) - 0.5) * (fam.sign ? 0.5 : 0.35);
      const sc = 0.88 + hash3i(seed, i, 55) * 0.26;
      const tiltA = (hash3i(seed, i, 56) - 0.5) * (fam.cone ? 0.3 : 0.09);
      const tiltB = (hash3i(seed, i, 57) - 0.5) * (fam.cone ? 0.3 : 0.08);
      const mask = [
        0.4 + hash3i(seed, i, 58) * 1.0,
        0.35 + hash3i(seed, i, 59) * 1.0,
        0.5 + hash3i(seed, i, 60) * 0.6,
      ];
      const M = trs(new THREE.Matrix4(), p.x, p.y, p.z, yaw, sc,
        sc * (0.94 + hash3i(seed, i, 61) * 0.13), sc, tiltA, tiltB);
      for (const id of fam.id) B.put(id, M, mask);
      if (fam.cone) {
        B.put('cone_band', M, null);
        // cones come in threes
        for (let k = 1; k < 3; k++) {
          const p2 = this._clearOff(edge, s + k * (0.9 + hash3i(seed, i, 62 + k) * 0.7), side,
            KERB_LANE - 0.25 + hash3i(seed, i, 65 + k) * 0.5, KERB_CLEAR, maxOff, new THREE.Vector3());
          if (!p2 || !this._in(bx, p2.x, p2.z)) continue;
          const M2 = trs(new THREE.Matrix4(), p2.x, p2.y, p2.z, hash3i(seed, i, 68 + k) * TAU, sc,
            sc, sc, (hash3i(seed, i, 71 + k) - 0.5) * 0.4, (hash3i(seed, i, 74 + k) - 0.5) * 0.4);
          B.put('cone', M2, mask);
          B.put('cone_band', M2, null);
        }
      }
      if (fam.row) {
        for (let k = 1; k < 2 + Math.floor(hash3i(seed, i, 77) * 3); k++) {
          const p2 = this._clearOff(edge, s + k * 0.52, side, KERB_LANE + hash3i(seed, i, 78 + k) * 0.2,
            KERB_CLEAR, maxOff, new THREE.Vector3());
          if (!p2 || !this._in(bx, p2.x, p2.z)) continue;
          B.put(fam.id[k % fam.id.length], trs(new THREE.Matrix4(), p2.x, p2.y, p2.z,
            yaw + (hash3i(seed, i, 81 + k) - 0.5) * 0.2, sc), mask);
        }
      }
      if (fam.rail) {
        // Continues the run started above, so it takes the same corrected yaw.
        for (let k = 1; k < 3; k++) {
          const p2 = this._clearOff(edge, s + k * 2.0, side, KERB_LANE + 0.05,
            clear, maxOff, new THREE.Vector3());
          if (!p2 || !this._in(bx, p2.x, p2.z)) continue;
          B.put('rail_guard', trs(new THREE.Matrix4(), p2.x, p2.y, p2.z, face, 1, 1, 1), mask);
        }
      }
      if (fam.tag) B.box(fam.tag, p.x, p.y, p.z, 0.6 * sc, 0.9, 0.6 * sc, yaw);
      s += fam.len * sc;
    }

    // Bus shelters: rare, and only on a road wide enough to stop on.
    if (w.sw > 2.6 && edge.kind !== 'alley' && hash3i(seed, 90, 1) < 0.26 && usable > 22) {
      const s2 = s0 + 6 + hash3i(seed, 91, 1) * (usable - 14);
      /**
       * A shelter is 3.9 m wide on X and 1.5 m deep on Z, with its back panel
       * at -Z and its opening at +Z — so `_facing` is the yaw it was modelled
       * for, and the old `_along + (side>0 ? 0 : PI)` was both ninety degrees
       * out and a hand-rolled version of the side term `_facing` already
       * carries. It stood across the footway with its open front looking down
       * the street and 2 m of it in the bus lane.
       */
      const p = this._clearOff(edge, s2, side, Math.min(w.sw - 0.85, 1.5),
        0.85, Math.max(1.5, w.sw - 0.85), new THREE.Vector3());
      if (p && this._in(bx, p.x, p.z)) {
        const yaw = face + (hash3i(seed, 92, 1) - 0.5) * 0.06;
        const M = trs(new THREE.Matrix4(), p.x, p.y, p.z, yaw);
        const mask = [0.7, 0.8, 0.6];
        B.put('shelter_frame', M, mask);
        B.put('shelter_glass', M, null);
        B.put('shelter_ad', M, null);
        B.put('shelter_flag', M, mask);
        B.box('metal', p.x, p.y, p.z, 4.0, 2.4, 1.6, yaw);
      }
    }
  }

  /* ---------------------------------------------------- wall clutter --- */

  _wallClutter(B, edge, side, s0, s1, seed, style, bx, w, district) {
    if (w.sw < 1.8) return;
    const off = w.sw - 0.55;
    const face = this._facing(edge, side);
    const along = this._along(edge);
    const FAMS = [
      { id: ['binbag_0'], w: 1.0, stack: 3 },
      { id: ['binbag_1'], w: 0.9, stack: 3 },
      { id: ['binbag_2'], w: 0.8, stack: 2 },
      { id: ['bin_wheelie'], w: 0.7 },
      { id: ['pallet'], w: 0.5 },
      { id: ['crate_wood'], w: 0.4 },
      { id: ['crate_milk'], w: 0.45, stack: 2 },
      { id: ['box_card'], w: 0.5, stack: 2 },
      { id: ['a_board'], w: 0.5 },
      { id: ['aircon_ground'], w: 0.35 },
      { id: ['hatch_twin'], w: 0.35, flat: true },
      { id: ['hatch_round'], w: 0.3, flat: true },
      { id: ['gully_walk'], w: 0.4, flat: true },
      { id: ['utility_lid'], w: 0.45, flat: true },
      { id: ['vent_grate'], w: 0.25, flat: true },
      { id: ['drum_oil'], w: 0.2 },
      { id: ['tyre_stack'], w: 0.14 },
      { id: ['weed_tuft'], w: 0.6, weed: true },
    ];
    let total = 0;
    for (const f of FAMS) total += f.w;
    const density = 0.75 + style.litter * 0.85;
    let s = s0 + 1 + hash3i(seed, 100, 1) * 5;
    let i = 0;
    while (s < s1 - 1 && i < 130) {
      i++;
      s += 1.4 + hash3i(seed, i, 101) * 6.5 / Math.max(0.2, density);
      if (s > s1 - 1) break;
      /**
       * Wall clutter sits at the BACK of the footway, so it is never in the
       * road because of its own offset — but at an acute fork, or where two
       * corridors overlap, the back of one footway is the middle of the next
       * street. Same guard, pushing further from the kerb rather than nearer.
       */
      const p = this._clearOff(edge, s, side, off - hash3i(seed, i, 102) * 0.35,
        KERB_CLEAR, Math.max(off, w.sw - 0.2), new THREE.Vector3());
      if (!p || !this._in(bx, p.x, p.z)) continue;
      let r = hash3i(seed, i, 103) * total;
      let fam = FAMS[0];
      for (const f of FAMS) {
        r -= f.w;
        if (r <= 0) {
          fam = f;
          break;
        }
      }
      const yaw = (fam.flat ? along : face + Math.PI) + (hash3i(seed, i, 104) - 0.5) * (fam.flat ? 0.2 : 1.1);
      const sc = 0.85 + hash3i(seed, i, 105) * 0.34;
      const mask = [0.4 + hash3i(seed, i, 106), 0.5 + hash3i(seed, i, 107), 0.6];
      const y = fam.flat ? p.y + 0.012 : p.y;
      B.put(fam.id[0], trs(new THREE.Matrix4(), p.x, y, p.z, yaw, sc,
        sc * (0.9 + hash3i(seed, i, 108) * 0.2), sc,
        fam.flat ? 0 : (hash3i(seed, i, 109) - 0.5) * 0.12,
        fam.flat ? 0 : (hash3i(seed, i, 110) - 0.5) * 0.12), mask);
      const n = fam.stack ? 1 + Math.floor(hash3i(seed, i, 111) * fam.stack) : 0;
      for (let k = 0; k < n; k++) {
        const dx = (hash3i(seed, i, 112 + k) - 0.5) * 0.9;
        const dz = (hash3i(seed, i, 115 + k) - 0.5) * 0.5;
        const p2x = p.x + Math.cos(along) * dx - Math.sin(along) * dz;
        const p2z = p.z + Math.sin(along) * dx + Math.cos(along) * dz;
        if (!this._in(bx, p2x, p2z)) continue;
        const sc2 = sc * (0.8 + hash3i(seed, i, 118 + k) * 0.4);
        // The stack jitters up to 0.45 m off its parent in an unconstrained
        // direction, which is enough to walk a bin bag off a narrow footway.
        // Checked at the height it is actually placed at, because the height
        // gate in `laneIntrusion` is what decides whether a road below counts.
        const p2y = p.y + (hash3i(seed, i, 121 + k) < 0.35 ? 0.34 * sc2 : 0);
        if (!this._clearsLanes(p2x, p2y, p2z, 0.3)) continue;
        B.put(fam.id[0], trs(new THREE.Matrix4(), p2x, p2y, p2z,
          hash3i(seed, i, 124 + k) * TAU, sc2, sc2 * 0.92, sc2,
          (hash3i(seed, i, 127 + k) - 0.5) * 0.4, (hash3i(seed, i, 130 + k) - 0.5) * 0.4), mask);
      }
    }
  }

  /* ================================================================== */
  /* overhead                                                            */
  /* ================================================================== */

  _edgeWires(B, edge, bx, lod) {
    const poles = polesOnEdge(this.world.roads, edge, this.world, (x, z) => this.styleOf(x, z), this._poles);
    if (poles.length === 0) return;
    const wireAcc = this._wireAcc(B);

    for (let i = 0; i < poles.length; i++) {
      const p = poles[i];
      if (this._in(bx, p.x, p.z)) {
        const yaw = this._along(edge) + (hash3i(p.seed, 40, 1) - 0.5) * 0.10 + Math.PI / 2;
        const sc = 0.96 + hash3i(p.seed, 41, 1) * 0.1;
        const M = trs(new THREE.Matrix4(), p.x, p.y, p.z, yaw, sc, sc, sc);
        const mask = [0.5 + hash3i(p.seed, 42, 1) * 0.8, 0.5 + hash3i(p.seed, 43, 1) * 0.8, 0.6];
        B.put(`pole_${p.variant}_${p.arms}`, M, mask);
        if (lod === 0) {
          B.put(`pole_${p.variant}_ins${p.arms}`, M, null);
          if (p.xfmr) B.put(`pole_${p.variant}_xfmr`, M, mask);
        }
        if (lod === 0) B.box('wood', p.x, p.y, p.z, 0.30, 4.0, 0.30);
        // guy wires where the line turns or ends
        if (lod === 0 && (i === 0 || i === poles.length - 1) && hash3i(p.seed, 44, 1) < 0.6) {
          const d = i === 0 ? -1 : 1;
          buildGuy(wireAcc, p, edge.dx * d, edge.dz * d, p.seed);
        }
      }
      // --- SPANS. Only ever between consecutive authored poles.
      if (i + 1 < poles.length) {
        const q = poles[i + 1];
        const mx = (p.x + q.x) * 0.5;
        const mz = (p.z + q.z) * 0.5;
        if (this._in(bx, mx, mz)) {
          buildSpan(wireAcc, p, q, (p.seed ^ Math.imul(q.seed, 31)) >>> 0);
        }
      }
    }

    if (lod !== 0) return;

    // Service drops: pole to an AUTHORED wall bracket. No bracket, no drop.
    for (const p of poles) {
      if (!this._in(bx, p.x, p.z)) continue;
      if (hash3i(p.seed, 50, 1) > 0.55) continue;
      const w = this._walk(edge);
      const lat = (w.hw + 0.33 + w.sw + 1.2) * p.side;
      const t = p.s / edge.len;
      const g = this.world.roads;
      const na = g.nodes[edge.a];
      const nb = g.nodes[edge.b];
      const wx = na.x + (nb.x - na.x) * t - edge.dz * lat + (hash3i(p.seed, 51, 1) - 0.5) * 5;
      const wz = na.z + (nb.z - na.z) * t + edge.dx * lat + (hash3i(p.seed, 52, 1) - 0.5) * 5;
      if (this.world.isWater?.(wx, wz)) continue;
      const wy = p.y + 4.4 + hash3i(p.seed, 53, 1) * 2.6;
      const yaw = this._facing(edge, p.side) + Math.PI;
      B.put('wire_bracket', trs(new THREE.Matrix4(), wx, wy, wz, yaw), [0.7, 0.8, 0.5]);
      B.put('wire_junction', trs(new THREE.Matrix4(), wx, wy - 1.5, wz, yaw), [0.7, 0.8, 0.5]);
      buildDrop(this._wireAcc(B), p, wx, wy + 0.28, wz, p.seed);
    }
  }

  _wireAcc(B) {
    let a = B._static.get('wire');
    if (!a) B._static.set('wire', (a = new Accum('wire')));
    return a;
  }

  /* ================================================================== */
  /* road decals — only what `world` does not already paint              */
  /* ================================================================== */

  setDecalGlyphs(set) {
    this.decalGlyphs = set;
  }

  _edgeDecals(B, edge, bx) {
    if (edge.kind === 'alley' || edge.rail) return;
    const g = this.world.roads;
    const na = g.nodes[edge.a];
    const nb = g.nodes[edge.b];
    const w = this._walk(edge);
    const L = edge.len;
    const seed = (edge.id * 0x9e3779b1) >>> 0;
    const allow = this.decalGlyphs ?? {};

    const put = (surf, cx, cz, y, yaw, halfW, halfL, vSpan) => {
      let a = B._static.get(surf);
      if (!a) B._static.set(surf, (a = new Accum(surf)));
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const q = [];
      for (const [u, v, tu, tv] of [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, vSpan], [-1, 1, 0, vSpan]]) {
        const dx = u * halfW;
        const dz = v * halfL;
        q.push(a.vert(cx + dx * c - dz * s, y, cz + dx * s + dz * c, 0, 1, 0, tu, tv, 0.15, 0.5, 0.05));
      }
      a.quad(q[0], q[1], q[2], q[3]);
    };

    const at = (t, lat) => {
      const x = na.x + (nb.x - na.x) * t - edge.dz * lat;
      const z = na.z + (nb.z - na.z) * t + edge.dx * lat;
      const y = na.y + (nb.y - na.y) * t + 0.016;
      return { x, y, z };
    };
    const along = this._along(edge);

    // ---- lane arrows on the approach to a busy junction ------------------
    if (allow.arrow) {
      for (const end of [0, 1]) {
        const node = g.nodes[end === 0 ? edge.a : edge.b];
        if (node.links.length < 3) continue;
        if (hash3i(seed, end, 61) > 0.55) continue;
        const fw = edge.forward;
        for (let k = 0; k < fw; k++) {
          const lat = (k + 0.5) * edge.laneWidth * (end === 0 ? -1 : 1);
          const t = end === 0 ? (w.padA + 7) / L : 1 - (w.padB + 7) / L;
          if (t < 0.05 || t > 0.95) continue;
          const p = at(t, lat);
          if (!this._in(bx, p.x, p.z)) continue;
          const turn = k === 0 && hash3i(seed, k, 62) < 0.5;
          put(turn && allow.arrowTurn ? 'decal_arrow_turn' : 'decal_arrow',
            p.x, p.z, p.y, along + (end === 0 ? Math.PI : 0), 1.5, 2.4, 1);
        }
      }
    }

    // ---- kerbside parking-bay ticks and a double yellow -------------------
    for (const side of [-1, 1]) {
      const mid = at(0.5, 0);
      const style = this.styleOf(mid.x, mid.z);
      if (hash3i(seed, side > 0 ? 3 : 4, 63) < 0.34 && allow.yellow) {
        // a continuous no-parking line hugging the channel
        const segs = Math.max(1, Math.round((L - w.padA - w.padB) / 8));
        for (let i = 0; i < segs; i++) {
          const t0 = (w.padA + i * 8) / L;
          const p = at(t0 + 4 / L, (w.hw - 0.28) * side);
          if (!this._in(bx, p.x, p.z)) continue;
          put('decal_yellow', p.x, p.z, p.y, along, 0.28, 4.0, 8 / 9);
        }
      } else if (style.meters > 0.2) {
        const pitch = 6.4 + hash3i(seed, 5, 64) * 1.8;
        for (let s = w.padA + 4; s < L - w.padB - 4; s += pitch) {
          const p = at(s / L, (w.hw - 1.15) * side);
          if (!this._in(bx, p.x, p.z)) continue;
          put('decal_paint', p.x, p.z, p.y, along + Math.PI / 2, 0.25, 1.15, 0.26);
        }
      }
    }

    // ---- hatched keep-clear box outside a junction -----------------------
    if (allow.hatch && hash3i(seed, 6, 65) < 0.14) {
      const t = 0.5 + (hash3i(seed, 7, 66) - 0.5) * 0.4;
      const p = at(t, 0);
      if (this._in(bx, p.x, p.z)) put('decal_hatch', p.x, p.z, p.y, along, w.hw * 0.9, 3.4, 1);
    }

    // ---- oil, skid scuff, tar seams, standing water ----------------------
    const n = Math.max(1, Math.round(L / 26));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.2 + hash3i(seed, i, 67) * 0.6) / n;
      const lat = (hash3i(seed, i, 68) - 0.5) * 1.7 * w.hw;
      const p = at(t, lat);
      if (!this._in(bx, p.x, p.z)) continue;
      const r = hash3i(seed, i, 69);
      if (r < 0.34) {
        const sx = 0.5 + hash3i(seed, i, 70) * 1.3;
        const sz = 0.4 + hash3i(seed, i, 71) * 2.4;
        put('oil', p.x, p.z, p.y, along + (hash3i(seed, i, 72) - 0.5) * 0.6, sx, sz, 1);
      } else if (r < 0.58) {
        put('tarpatch', p.x, p.z, p.y - 0.004, along + (hash3i(seed, i, 73) - 0.5) * 1.4,
          0.16 + hash3i(seed, i, 74) * 0.18, w.hw * (0.5 + hash3i(seed, i, 75) * 0.55), 1);
      } else if (r < 0.72) {
        // standing water gathers in the channel, not in the crown
        const p2 = at(t, (w.hw - 0.55) * (hash3i(seed, i, 76) < 0.5 ? -1 : 1));
        if (!this._in(bx, p2.x, p2.z)) continue;
        const sc = 0.7 + hash3i(seed, i, 77) * 1.3;
        B.put(`puddle_${i % 3}`, trs(new THREE.Matrix4(), p2.x, p2.y - 0.006, p2.z,
          along + (hash3i(seed, i, 78) - 0.5) * 0.5, sc, 1, sc * 0.7), null);
      } else if (r < 0.86) {
        // utility spray marks — the coloured squiggles nobody ever cleans off
        const tag = ['tag_a', 'tag_b', 'tag_c'][i % 3];
        let a = B._static.get(tag);
        if (!a) B._static.set(tag, (a = new Accum(tag)));
        const id = `tag_${i % 4}_${tag}`;
        const proto = this.lib.protos.get(id);
        if (proto) {
          a.add(proto.geo, trs(new THREE.Matrix4(), p.x, p.y + 0.004, p.z,
            along + (hash3i(seed, i, 79) - 0.5) * 1.2, 0.55, 0.55, 0.55, -Math.PI / 2),
            [0.3, 0.6, 0.1]);
        }
      }
    }
  }

  /* ================================================================== */
  /* per-lot dressing                                                    */
  /* ================================================================== */

  /**
   * The ground the BUILDING sits on, not the ground under the lot centre.
   * `buildings` pads to the LOWEST footprint corner minus 12 cm precisely
   * because Steel City is built on hills, and a prop keyed off the centroid
   * floats a whole storey clear of the wall on the downhill side.
   */
  _lotGround(lot) {
    let gy = Infinity;
    for (const c of lot.footprint) gy = Math.min(gy, this.world.heightAt(c[0], c[1]));
    if (!Number.isFinite(gy)) gy = lot.y ?? this.world.heightAt(lot.cx, lot.cz);
    return gy - 0.12;
  }

  /**
   * WHERE IS THE WALL, ACTUALLY?
   *
   * Everything below is placed off the LOT FOOTPRINT, and the footprint is not
   * the building. `buildings` insets, steps and plinths its ground volume, so a
   * sign keyed off the polygon hangs in space wherever it inset and sinks into
   * brick wherever it did not — the "two floating illegible billboards in
   * mid-air" a critic found in `mill.png` were a poster cluster and a tag on a
   * lot whose building is nowhere near its footprint edge.
   *
   * So: fire a ray at the wall, at the prop's own height, and use what it finds.
   * Returns metres to push along the outward normal, or null for "there is no
   * wall here" — in which case the prop is not drawn at all. A wall prop with
   * nothing behind it is the defect; not drawing it is the fix.
   */
  _phys() {
    if (this._physSys === undefined) this._physSys = this.peek?.('physics') ?? null;
    return this._physSys;
  }

  _wallPush(x, y, z, nx, nz) {
    const phys = this._phys();
    if (!phys?.raycast) return 0; // no physics at all: nominal placement
    const OUT = 1.9;
    const h = phys.raycast(
      x + nx * OUT, y, z + nz * OUT, -nx, 0, -nz, OUT + 2.6,
      phys.MASK?.WORLD
    );
    /**
     * A MISS IS ONLY EVIDENCE IF THE BUILDING IS IN THE COLLISION WORLD.
     * `buildings` registers colliders for its LIVE ring only, and our near
     * radius is wider than theirs — so out at the edge a miss means "nobody
     * told physics about this building", not "there is no wall". Dropping the
     * prop then would quietly strip the shopfronts off the outer ring of every
     * tile. `_wallKnown` is set per lot by a single roof probe.
     */
    if (!h?.hit) return this._wallKnown ? null : 0;
    const push = OUT - h.distance;
    if (push < -2.6 || push > 1.9) return this._wallKnown ? null : 0;
    return push;
  }

  /**
   * Is this lot's building actually in the static BVH? One ray, straight down
   * the middle from above the roof. If it comes back with something well above
   * the ground then `buildings` has registered this lot and a wall query here
   * is trustworthy; if not, we are placing blind and must not throw props away.
   */
  _probeLotKnown(lot, baseY) {
    const phys = this._phys();
    if (!phys?.raycast) return false;
    const hgt = lot.height ?? 10;
    const h = phys.raycast(lot.cx, baseY + hgt + 8, lot.cz, 0, -1, 0, hgt + 16, phys.MASK?.WORLD);
    return !!h?.hit && h.point.y > baseY + 1.2;
  }

  /**
   * EVERY WALL-MOUNTED CARD MUST HAVE A WALL BEHIND ITS OWN CORNERS.
   *
   * `_wallPush` probes ONE point at the middle of a wall and, on a miss, falls
   * back to nominal placement so the outer ring of tiles does not lose its
   * shopfronts. That is right for a poster at eye level and catastrophic for a
   * ghost sign, which is up to 18 m wide, is hung from `lot.height` — the LOT
   * RECORD, not the building `buildings` actually built — and therefore ends up
   * hanging in clear sky when the two disagree. One was found 14.6 m from the
   * lens at y 19.6 with nothing under it.
   *
   * This gate is deliberately NOT another version of the placement arithmetic.
   * It reads the PROTOTYPE'S OWN BOUNDING BOX, pushes its four front-face
   * corners through the final instance matrix, and asks `physics` — a different
   * subsystem, holding geometry this file never produced — whether there is
   * something behind each of them. An invariant that re-derives its expectation
   * from the same inputs as the code it is checking cannot fail; this one fails
   * the moment a card's own emitted corners are over open air.
   *
   * @param {number} need how many of the four corners must be backed
   */
  _wallBacked(id, M, nx, nz, need = 4) {
    const phys = this._phys();
    if (!phys?.raycast) return true;
    const p = this.lib.get?.(id);
    if (!p?.geo) return true;
    let bb = p._bb;
    if (bb === undefined) {
      p.geo.computeBoundingBox();
      bb = p._bb = p.geo.boundingBox ?? null;
    }
    if (!bb) return true;
    // 8 % inset, so a card that legitimately runs to the arris of its wall is
    // not failed by a corner sitting exactly on the edge
    const ix = (bb.max.x - bb.min.x) * 0.08;
    const iy = (bb.max.y - bb.min.y) * 0.08;
    const zf = bb.max.z;
    const OUT = 1.9;
    let hits = 0;
    for (let k = 0; k < 4; k++) {
      _wv.set(
        (k & 1) ? bb.max.x - ix : bb.min.x + ix,
        (k & 2) ? bb.max.y - iy : bb.min.y + iy,
        zf
      ).applyMatrix4(M);
      const h = phys.raycast(
        _wv.x + nx * OUT, _wv.y, _wv.z + nz * OUT, -nx, 0, -nz, OUT + 2.6,
        phys.MASK?.WORLD
      );
      if (h?.hit && OUT - h.distance > -2.6) hits++;
    }
    return hits >= need;
  }

  _lot(B, lot, bx, lod, rng, parked = null, wallOut = null) {
    const foot = lot.footprint;
    if (!foot || foot.length < 3) return;
    const seed = lot.seed >>> 0;
    const style = this.styleOf(lot.cx, lot.cz);
    const district = lot.district ?? this.districtIdAt(lot.cx, lot.cz);

    /**
     * A lot belongs to exactly one tile — `world.lotsInTile` assigns it by its
     * centroid — so lot-derived props are already unique and must NOT be gated
     * on the tile bounds. Doing that threw away the dressing of every lot whose
     * frontage crossed a tile edge, which is most of them, and is why the first
     * pass had no shopfronts at all.
     */
    if (lot.kind === 'park') {
      this._park(B, lot, bx, lod, seed, style);
      return;
    }
    if (lot.kind === 'lot') {
      this._surfaceLot(B, lot, bx, lod, seed, style);
      if (parked && lod === 0) this._lotParking(lot, seed, parked, bx);
      return;
    }
    // Shopfront dressing is a dozen materials per tile and none of it resolves
    // beyond the near radius. The skeleton tier plants and lights only.
    if (lod !== 0) return;

    /**
     * Everything from here down needs a wall query, and `physics` cannot answer
     * one for a building whose colliders are still in this frame's build queue.
     * So the caller takes the lot now and hands it back once the static BVH has
     * been rebuilt — see `PropSystem._drainWalls`.
     */
    if (wallOut) {
      wallOut.push(lot);
      return;
    }
    this._lotDressing(B, lot, bx, seed, style, district);
  }

  /** Deferred entry point: everything on a lot that needed the wall to exist. */
  lotWalls(B, lot, bx) {
    const foot = lot.footprint;
    if (!foot || foot.length < 3) return;
    this._wallKnown = this._probeLotKnown(lot, this._lotGround(lot));
    this._lotDressing(B, lot, bx, lot.seed >>> 0,
      this.styleOf(lot.cx, lot.cz),
      lot.district ?? this.districtIdAt(lot.cx, lot.cz));
  }

  /** The wall-mounted half of a lot. Runs only when a wall query is possible. */
  _lotDressing(B, lot, bx, seed, style, district) {
    const foot = lot.footprint;
    const lod = 0;

    // ---- the frontage: shopfront signage --------------------------------
    const fr = lot.frontage;
    if (fr && fr.length === 2) {
      this._frontage(B, lot, fr, bx, lod, seed, style, district);
    }

    if (lod !== 0) return;

    // ---- the other walls: ghost signs, ivy, tags, posters, scaffolding ---
    for (let i = 0; i < foot.length; i++) {
      const a = foot[i];
      const b = foot[(i + 1) % foot.length];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 4) continue;
      const isFront = fr && Math.hypot((a[0] + b[0]) / 2 - (fr[0][0] + fr[1][0]) / 2,
        (a[1] + b[1]) / 2 - (fr[0][1] + fr[1][1]) / 2) < 2.5;
      const ux = dx / len;
      const uz = dz / len;
      let nx = uz;
      let nz = -ux;
      const emx = (a[0] + b[0]) * 0.5;
      const emz = (a[1] + b[1]) * 0.5;
      if (nx * (emx - lot.cx) + nz * (emz - lot.cz) < 0) {
        nx = -nx;
        nz = -nz;
      }
      const wSeed = (seed ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0;
      const yaw = Math.atan2(nx, nz);
      const cx = (a[0] + b[0]) / 2 + nx * 0.06;
      const cz = (a[1] + b[1]) / 2 + nz * 0.06;
      const baseY = this._lotGround(lot);

      /**
       * Probe the wall at the height each family actually hangs at. A gable sign
       * three storeys up and a poster at eye level are on different planes the
       * moment `buildings` steps the volume, so one probe per lot is not enough.
       */
      const at = (t, off) => ({
        x: a[0] + dx * t + nx * off,
        z: a[1] + dz * t + nz * off,
      });

      /**
       * A gable big enough to have carried a painted advert.
       *
       * THIS IS THE ONE THAT FLOATED. The sign is hung off `lot.height`, which
       * is what `world` asked for and not necessarily what `buildings` built,
       * and it is the only card in the kit mounted three storeys up — so when
       * the two disagree it hangs in open sky, which is what a critic found at
       * y 19.6 in the searchlight frame. Two defences, both against the emitted
       * card rather than the arithmetic that produced it: the whole family is
       * skipped unless the roof probe proved this building is really in the
       * collision world, and the card is then only kept if all four of its own
       * corners have a wall behind them. It also walks DOWN the wall first, so
       * a sign whose top overhangs the roof is lowered rather than dropped.
       */
      if (!isFront && len > 9 && (lot.height ?? 0) > 9 && hash3i(wSeed, 1, 1) < 0.30
          && this._wallKnown) {
        const gw = Math.min(len - 2.4, 10 + hash3i(wSeed, 2, 1) * 8);
        const gh = Math.min((lot.height ?? 10) - 4.5, 5 + hash3i(wSeed, 3, 1) * 6);
        const gy0 = baseY + 3.4 + hash3i(wSeed, 4, 1) * ((lot.height ?? 10) - gh - 4.5);
        for (let step = 0; step < 6; step++) {
          const gy = gy0 - step * gh * 0.35;
          if (gy < baseY + 2.6) break;
          const push = this._wallPush(cx, gy + gh / 2, cz, nx, nz);
          if (push === null) continue;
          const M = trs(new THREE.Matrix4(), cx + nx * push, gy + gh / 2, cz + nz * push,
            yaw, gw, gh, 1);
          if (!this._wallBacked('ghost_field', M, nx, nz, 4)) continue;
          B.put('ghost_field', M, [0.6 + hash3i(wSeed, 5, 1) * 0.6, 0.6, 0.3]);
          B.put('ghost_letters', M, null);
          break;
        }
      }
      // ivy up a side wall
      if (!isFront && hash3i(wSeed, 6, 1) < 0.22) {
        const n = 1 + Math.floor(hash3i(wSeed, 7, 1) * Math.min(3, len / 4));
        for (let k = 0; k < n; k++) {
          const p = at((k + 0.5) / n, 0.12);
          const sc = 0.8 + hash3i(wSeed, k, 8) * 0.7;
          const push = this._wallPush(p.x, baseY + 1.4, p.z, nx, nz);
          if (push === null) continue;
          const M = trs(new THREE.Matrix4(), p.x + nx * push, baseY, p.z + nz * push,
            yaw, sc, 0.7 + hash3i(wSeed, k, 9) * 0.8, sc);
          // ivy climbs 3 m: the lower corners are enough, the top may be free
          if (!this._wallBacked('ivy_panel', M, nx, nz, 2)) continue;
          B.put('ivy_panel', M, null);
        }
      }
      // aerosol at street level, flyposting on the blank stretches
      if (hash3i(wSeed, 10, 1) < 0.34 * (0.5 + style.litter)) {
        const p = at(0.2 + hash3i(wSeed, 11, 1) * 0.6, 0.05);
        const ty = baseY + 1.1 + hash3i(wSeed, 15, 1) * 0.8;
        const push = this._wallPush(p.x, ty, p.z, nx, nz);
        if (push !== null) {
          const v = Math.floor(hash3i(wSeed, 12, 1) * 4);
          const key = ['tag_a', 'tag_b', 'tag_c', 'tag_d'][Math.floor(hash3i(wSeed, 13, 1) * 4)];
          const sc = 0.8 + hash3i(wSeed, 14, 1) * 0.9;
          const id = `tag_${v}_${key}`;
          const M = trs(new THREE.Matrix4(), p.x + nx * push, ty, p.z + nz * push,
            yaw, sc, sc * (0.8 + hash3i(wSeed, 16, 1) * 0.5), sc);
          if (this._wallBacked(id, M, nx, nz, 3)) B.put(id, M, null);
        }
      }
      if (hash3i(wSeed, 17, 1) < 0.28 * (0.4 + style.litter)) {
        const p = at(0.15 + hash3i(wSeed, 18, 1) * 0.7, 0.05);
        const push = this._wallPush(p.x, baseY + 1.2, p.z, nx, nz);
        if (push !== null) {
          const key = ['poster_a', 'poster_b', 'poster_c', 'poster_d'][Math.floor(hash3i(wSeed, 19, 1) * 4)];
          const id = `poster_cluster_${key}`;
          const M = trs(new THREE.Matrix4(), p.x + nx * push, baseY, p.z + nz * push,
            yaw, 0.8 + hash3i(wSeed, 20, 1) * 0.5);
          if (this._wallBacked(id, M, nx, nz, 3)) B.put(id, M, null);
        }
      }
      // scaffolding on the odd building
      if (isFront && hash3i(wSeed, 21, 1) < 0.10 * style.scaffold && (lot.height ?? 0) > 8) {
        const bays = Math.max(1, Math.floor(len / 2.1));
        const lifts = Math.min(5, Math.max(2, Math.floor((lot.height ?? 8) / 2)));
        const base = this._wallPush(cx, baseY + 2.0, cz, nx, nz);
        if (base !== null) {
          for (let k = 0; k < bays; k++) {
            const p = at((k + 0.5) / bays, 0.75 + base);
            for (let l = 0; l < lifts; l++) {
              B.put('scaffold_bay', trs(new THREE.Matrix4(), p.x, baseY + l * 2.0, p.z, yaw), [0.7, 0.8, 0.5]);
            }
          }
          const p = at(0.5, 0.9 + base);
          B.put('ladder', trs(new THREE.Matrix4(), p.x, baseY, p.z, yaw + 0.1, 1, 1, 1, -0.12), [0.7, 0.8, 0.5]);
        }
      }
    }
  }

  /* -------------------------------------------------------- frontage --- */

  _frontage(B, lot, fr, bx, lod, seed, style, district) {
    const a = fr[0];
    const b = fr[1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 3.5) return;
    const ux = dx / len;
    const uz = dz / len;
    /**
     * WHICH WAY IS OUT. `lots.js` emits the frontage as u0 -> u1 for BOTH rows
     * of a two-row block, so the edge winding alone puts the outward normal
     * into the building for half of every block in the city — which is why the
     * first pass had no shopfronts on one side of every street. Decide it from
     * the lot centroid instead; that cannot be wrong.
     */
    let nx = uz;
    let nz = -ux;
    const mx = (a[0] + b[0]) * 0.5;
    const mz = (a[1] + b[1]) * 0.5;
    if (nx * (mx - lot.cx) + nz * (mz - lot.cz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const yaw = Math.atan2(nx, nz);
    const baseY = this._lotGround(lot);
    const shopish = lot.kind === 'shop' || lot.kind === 'block' || lot.kind === 'industrial';
    const units = Math.max(1, Math.round(len / (7 + hash3i(seed, 1, 2) * 4)));
    const neon = DISTRICT_NEON[district] ?? DISTRICT_NEON.lawren;
    const pOff = seed % 4;

    for (let u = 0; u < units; u++) {
      const uSeed = (seed ^ Math.imul(u + 1, 0x27d4eb2d)) >>> 0;
      const t0 = u / units;
      const t1 = (u + 1) / units;
      const tc = (t0 + t1) * 0.5;
      const cw = len / units;
      /**
       * ONE PROBE PER SHOP UNIT, at first-floor height, and every prop in the
       * unit moves with it. The frontage polygon is where `world` said the lot
       * faces the street; the shopfront is where `buildings` actually put the
       * wall, and on a stepped or inset ground floor those differ by up to a
       * metre — which is a fascia floating clear of its own building.
       */
      const pcx = a[0] + dx * tc;
      const pcz = a[1] + dz * tc;
      const push = this._wallPush(pcx, baseY + 2.6, pcz, nx, nz);
      if (push === null) continue;
      const cx = pcx + nx * (0.10 + push);
      const cz = pcz + nz * (0.10 + push);
      const trades = shopish && hash3i(uSeed, 2, 2) < 0.62 + style.signage * 0.25;

      // --- the fascia board ---------------------------------------------
      if (trades) {
        const fw = cw * (0.72 + hash3i(uSeed, 3, 2) * 0.2);
        const fy = baseY + 3.15 + hash3i(uSeed, 4, 2) * 0.55;
        const M = trs(new THREE.Matrix4(), cx, fy, cz, yaw + (hash3i(uSeed, 5, 2) - 0.5) * 0.02,
          fw, 0.85 + hash3i(uSeed, 6, 2) * 0.35, 1);
        const fmask = [0.6 + hash3i(uSeed, 7, 2) * 0.7, 0.6 + hash3i(uSeed, 8, 2) * 0.6, 0.5];
        B.put('fascia_board', M, fmask);
        B.put(`fascia_face_${PANELS[(u + pOff) % PANELS.length]}`, M,
          [0.5 + hash3i(uSeed, 40, 2) * 0.8, 0.5 + hash3i(uSeed, 41, 2) * 0.8, 0.4]);
        // The gooseneck lamps go on at UNIFORM scale, at the board's own ends.
        for (const sgn of [-1, 1]) {
          const lx = cx + ux * (sgn * fw * 0.30);
          const lz = cz + uz * (sgn * fw * 0.30);
          B.put('fascia_lamp', trs(new THREE.Matrix4(), lx, fy, lz, yaw), fmask);
        }
        /**
         * The word goes on at UNIFORM scale. Riding the board's x-stretch turned
         * 4 cm strokes into 25 cm slabs and the sign read as a row of lit panels
         * rather than as lettering.
         *
         * It also goes on ALMOST ALWAYS, and it is sized to the board. The
         * prototype word is ~1.45 m across, so the scale that fills 60% of a
         * frontage is fw*0.6/1.45 — under the old cap of 1.35 a five-metre
         * fascia carried a 0.9 m smudge in the middle of a blank cream panel,
         * which is the "blank rectangles standing in for signage" finding.
         */
        if (hash3i(uSeed, 9, 2) < 0.88) {
          const ls = Math.min(2.3, Math.max(0.72, (fw * 0.62) / 1.45));
          B.put(`fascia_letters_${neon[u % neon.length]}`,
            trs(new THREE.Matrix4(), cx, fy, cz, yaw, ls, ls, 1), null);
        }
      }

      // --- a projecting blade sign --------------------------------------
      if (trades && hash3i(uSeed, 10, 2) < 0.42 * (0.5 + style.signage)) {
        const px = a[0] + dx * (t0 + 0.25 / units) + nx * (0.05 + push);
        const pz = a[1] + dz * (t0 + 0.25 / units) + nz * (0.05 + push);
        const py = baseY + 3.3 + hash3i(uSeed, 11, 2) * 1.4;
        const sc = 0.9 + hash3i(uSeed, 12, 2) * 0.4;
        const M = trs(new THREE.Matrix4(), px, py, pz, yaw, sc, sc, sc);
        B.put('blade_bracket', M, [0.7, 0.8, 0.5]);
        B.put('blade_panel', M, [0.7, 0.8, 0.5]);
        B.put(`blade_face_${neon[(u + 1) % neon.length]}`, M, null);
      }

      // --- a big neon on the wall ---------------------------------------
      if (trades && hash3i(uSeed, 13, 2) < 0.30 * (0.4 + style.signage)) {
        const py = baseY + 4.6 + hash3i(uSeed, 14, 2) * 2.4;
        const sc = 0.8 + hash3i(uSeed, 15, 2) * 0.7;
        const M = trs(new THREE.Matrix4(), cx, py, cz, yaw, sc, sc, sc);
        B.put('neon_backer', M, [0.7, 0.85, 0.5]);
        B.put(`neon_${Math.floor(hash3i(uSeed, 16, 2) * 6)}_${neon[(u + 2) % neon.length]}`, M, null);
      }

      /**
       * A tall vertical hotel/theatre sign, rare and load-bearing.
       *
       * ONE sign, authored to fill the frame. The first pass stacked five copies
       * of a small prototype at a 0.65 m pitch when the prototype was 0.87 m
       * tall, so they overlapped into a single column of symmetrical blobs —
       * "five untextured purple crosses down a wall" in three separate reviews.
       * If a sign needs five of anything, the FIVE belong inside the prototype
       * where they can be composed, not in the placement loop.
       */
      if (trades && (lot.height ?? 0) > 14 && hash3i(uSeed, 17, 2) < 0.07 * (0.4 + style.signage)) {
        const py = baseY + 12 + hash3i(uSeed, 18, 2) * 5;
        const M = trs(new THREE.Matrix4(), cx, py, cz, yaw);
        B.put('blade_tall_frame', M, [0.8, 0.9, 0.5]);
        // the frame is a ladder 0.95 m deep, hung off the wall: the sign sits on
        // its centre plane, facing along the street rather than out of the wall.
        B.put(`neon_vert_${neon[u % neon.length]}`,
          trs(new THREE.Matrix4(), cx + nx * 0.575, py - 1.80, cz + nz * 0.575,
            yaw + Math.PI / 2), null);
      }

      if (lod !== 0) continue;

      // --- awning --------------------------------------------------------
      if (trades && hash3i(uSeed, 19, 2) < 0.40) {
        const aw = cw * (0.68 + hash3i(uSeed, 20, 2) * 0.22);
        const ay = baseY + 2.95 + hash3i(uSeed, 21, 2) * 0.3;
        const key = ['awning_red', 'awning_green', 'awning_cream'][Math.floor(hash3i(uSeed, 22, 2) * 3)];
        const M = trs(new THREE.Matrix4(), cx, ay, cz, yaw + (hash3i(uSeed, 23, 2) - 0.5) * 0.03,
          aw, 1, 0.9 + hash3i(uSeed, 24, 2) * 0.35);
        B.put('awning_frame', M, [0.7, 0.85, 0.5]);
        B.put(`awning_canvas_${key}`, M, null);
        for (const sgn of [-1, 1]) {
          const lx = cx + ux * (sgn * aw * 0.48);
          const lz = cz + uz * (sgn * aw * 0.48);
          B.put('awning_rib', trs(new THREE.Matrix4(), lx, ay, lz, yaw, 1, 1,
            0.9 + hash3i(uSeed, 24, 2) * 0.35), [0.7, 0.85, 0.5]);
        }
      }

      // --- the lit window and the shutter -------------------------------
      if (trades) {
        const closed = hash3i(uSeed, 25, 2) < 0.22;
        if (closed) {
          const n = Math.max(1, Math.round(cw / 1.4));
          for (let k = 0; k < n; k++) {
            const t = t0 + (k + 0.5) / n / units;
            const px = a[0] + dx * t + nx * (0.09 + push);
            const pz = a[1] + dz * t + nz * (0.09 + push);
            B.put('shutter_unit', trs(new THREE.Matrix4(), px, baseY + 0.05, pz, yaw,
              cw / n, 2.5 + hash3i(uSeed, k, 26) * 0.4, 1), [0.8, 0.9, 0.5]);
            if (hash3i(uSeed, k, 27) < 0.4) {
              B.put(`tag_${k % 4}_${['tag_a', 'tag_b', 'tag_c'][k % 3]}`,
                trs(new THREE.Matrix4(), px, baseY + 1.2, pz, yaw, 0.7, 0.7, 0.7), null);
            }
          }
        } else {
          B.put('shop_glow', trs(new THREE.Matrix4(), cx, baseY + 1.5, cz, yaw,
            cw * 0.72, 2.1, 1), null);
        }
        // menu case beside the door
        if (hash3i(uSeed, 28, 2) < 0.3) {
          const px = a[0] + dx * (t1 - 0.18 / units) + nx * (0.08 + push);
          const pz = a[1] + dz * (t1 - 0.18 / units) + nz * (0.08 + push);
          const M = trs(new THREE.Matrix4(), px, baseY + 1.25, pz, yaw);
          B.put('menu_case', M, [0.7, 0.8, 0.5]);
          B.put('menu_lit', M, null);
        }
      }

      // --- house frontage: a stoop, and the bins beside it ----------------
      if (!trades && (lot.kind === 'house' || lot.kind === 'block') && hash3i(uSeed, 29, 2) < 0.7) {
        const px = cx + nx * 0.35;
        const pz = cz + nz * 0.35;
        {
          const sc = 0.9 + hash3i(uSeed, 30, 2) * 0.25;
          const M = trs(new THREE.Matrix4(), px, baseY, pz, yaw + (hash3i(uSeed, 31, 2) - 0.5) * 0.05, sc, sc, sc);
          B.put('stoop_steps', M, [0.7 + hash3i(uSeed, 32, 2) * 0.6, 0.8, 0.6]);
          if (hash3i(uSeed, 33, 2) < 0.7) B.put('stoop_rail', M, [0.8, 0.85, 0.5]);
          B.box('concrete', px, baseY, pz, 1.6, 0.7, 1.3, yaw);
        }
      }
    }
  }

  /* ------------------------------------------------------------ parks --- */

  _park(B, lot, bx, lod, seed, style) {
    const foot = lot.footprint;
    const b = polyBounds(foot);
    const n = Math.max(4, Math.round((b.w * b.d) / 95));
    for (let i = 0; i < n; i++) {
      const h0 = hash3i(seed, i, 1);
      const h1 = hash3i(seed, i, 2);
      const x = b.x0 + h0 * b.w;
      const z = b.z0 + h1 * b.d;
      if (!pointInPoly(x, z, foot, 2.0)) continue;
      const y = this.world.heightAt(x, z);
      // `_lotParking` already learned this: a lot polygon can run up to — and
      // over — the kerb, so "inside the lot" is not "off the road".
      if (!this._clearsLanes(x, y, z, LOT_CLEAR)) continue;
      const h2 = hash3i(seed, i, 3);
      const yaw = hash3i(seed, i, 4) * TAU;
      const sc = 0.85 + hash3i(seed, i, 5) * 0.6;
      const mask = [0.5 + h0, 0.5 + h1 * 0.8, 0.7];
      if (h2 < 0.42 && this._headroom(x, y, z, 9 * sc)) {
        const sp = ['plane', 'maple', 'locust', 'pear'][Math.floor(hash3i(seed, i, 16) * 4) % 4];
        const v = lod !== 0 ? 'far' : Math.floor(hash3i(seed, i, 17) * 4) % 4;
        const li = lod !== 0 ? 0 : Math.floor(hash3i(seed, i, 6) * 4) % 4;
        const M = trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc * (0.9 + h1 * 0.3), sc,
          (h0 - 0.5) * 0.09, (h1 - 0.5) * 0.09);
        B.put(`tree_${sp}_${v}_wood`, M, mask);
        B.put(`tree_${sp}_${v}_leaf${li}`, M, mask);
        if (lod === 0) B.box('wood', x, y, z, 0.36, 2.5, 0.36);
      } else if (h2 < 0.58 && this._headroom(x, y, z, 9 * sc)) {
        const M = trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc);
        B.put('tree_pine_wood', M, mask);
        B.put('tree_pine_leaf', M, mask);
      } else if (lod === 0 && h2 < 0.80) {
        B.put(['shrub_a', 'shrub_b', 'shrub_c'][i % 3],
          trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
      } else if (lod === 0) {
        /**
         * A lawn is not one tuft every ten metres. Grass is the cheapest thing
         * in the kit (56 triangles, no shadow, gone at 145 m) and the thing a
         * park most obviously lacks, so a grass hit seeds a small drift of them
         * rather than a single clump — scaled by `q.grassDensity`, which is
         * 0.18 on `low` and 1.0 on `ultra`.
         */
        const gn = Math.max(1, Math.round(5 * this.grassDensity));
        for (let k = 0; k < gn; k++) {
          const g0 = hash3i(seed, i * 11 + k, 41);
          const g1 = hash3i(seed, i * 11 + k, 42);
          const gx = x + (g0 - 0.5) * 2.2;
          const gz = z + (g1 - 0.5) * 2.2;
          const gy = this.world.heightAt(gx, gz);
          if (!this._clearsLanes(gx, gy, gz, LOT_CLEAR)) continue;
          const gs = sc * (0.7 + 0.8 * g0);
          B.put('grass_clump', trs(new THREE.Matrix4(),
            gx, gy, gz, g1 * TAU, gs * 1.5, gs, gs * 1.5), mask);
        }
      }
    }
    if (lod !== 0) return;
    // benches and bins on the paths
    for (let i = 0; i < Math.max(2, Math.round(b.w / 22)); i++) {
      const x = b.x0 + hash3i(seed, i, 11) * b.w;
      const z = b.z0 + hash3i(seed, i, 12) * b.d;
      if (!pointInPoly(x, z, foot, 3)) continue;
      const y = this.world.heightAt(x, z);
      if (!this._clearsLanes(x, y, z, LOT_CLEAR)) continue;
      const yaw = hash3i(seed, i, 13) * TAU;
      const M = trs(new THREE.Matrix4(), x, y, z, yaw, 1, 1, 1, 0, (hash3i(seed, i, 14) - 0.5) * 0.03);
      B.put('bench_slat', M, [0.8, 0.7, 0.5]);
      B.put('bench_ends', M, [0.8, 0.9, 0.5]);
      // The bin is thrown 2.2 m from the bench on the bench's random yaw, so it
      // can clear the lot boundary the bench itself was checked against.
      if (hash3i(seed, i, 15) < 0.5) {
        const bxp = x + Math.cos(yaw) * 2.2;
        const bzp = z + Math.sin(yaw) * 2.2;
        if (this._clearsLanes(bxp, y, bzp, 0.4)) {
          B.put('bin_mesh', trs(new THREE.Matrix4(), bxp, y, bzp,
            hash3i(seed, i, 16) * TAU), [0.9, 0.9, 0.6]);
        }
      }
    }
  }

  /* ----------------------------------------------- surface car parks ---- */

  _surfaceLot(B, lot, bx, lod, seed, style) {
    const foot = lot.footprint;
    const b = polyBounds(foot);
    const y0 = this._lotGround(lot);
    // the chain-link and the weeds that grow through it
    if (lod === 0) {
      const n = Math.max(3, Math.round((b.w * b.d) / 55));
      for (let i = 0; i < n; i++) {
        const x = b.x0 + hash3i(seed, i, 21) * b.w;
        const z = b.z0 + hash3i(seed, i, 22) * b.d;
        if (!pointInPoly(x, z, foot, 1.2)) continue;
        const y = this.world.heightAt(x, z);
        // A skip or a jersey barrier standing in the running lane is the single
        // worst thing this file can emit; a surface lot's boundary is exactly
        // where that happens.
        if (!this._clearsLanes(x, y, z, LOT_CLEAR)) continue;
        const r = hash3i(seed, i, 23);
        const yaw = hash3i(seed, i, 24) * TAU;
        const sc = 0.8 + hash3i(seed, i, 25) * 0.7;
        const mask = [0.5, 0.8, 0.6];
        if (r < 0.32) B.put('weed_tuft', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
        else if (r < 0.5) B.put('scrub_clump', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
        else if (r < 0.60) B.put('pallet', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
        else if (r < 0.68) B.put('tyre_stack', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
        else if (r < 0.74) B.put('drum_oil', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
        else if (r < 0.80) B.put('cone', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc,
          (hash3i(seed, i, 26) - 0.5) * 0.5), mask);
        else if (r < 0.86) B.put('barrier_jersey', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
        else if (r < 0.93) B.put('skip', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
        else B.put('dumpster', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
      }
    }
    // a billboard facing the street
    if (hash3i(seed, 30, 1) < 0.30 && lot.frontage) {
      const fr = lot.frontage;
      const cx = (fr[0][0] + fr[1][0]) / 2;
      const cz = (fr[0][1] + fr[1][1]) / 2;
      const ux = (fr[1][0] - fr[0][0]);
      const uz = (fr[1][1] - fr[0][1]);
      const l = Math.hypot(ux, uz) || 1;
      const yaw = Math.atan2(uz / l, -ux / l) + Math.PI / 2;
      /**
       * The billboard is deliberately shoved 3.5 m off the frontage line TOWARD
       * the street so it reads from the road — which on a lot whose frontage
       * already sits on the kerb puts a 6 m hoarding in the near-side lane.
       * Walk it back onto the plot until it clears.
       */
      let px = 0;
      let pz = 0;
      let ok = false;
      for (let d = 3.5; d >= -1.0; d -= 0.75) {
        px = cx + (uz / l) * d;
        pz = cz - (ux / l) * d;
        if (this._clearsLanes(px, this.world.heightAt(px, pz), pz, 3.0)) {
          ok = true;
          break;
        }
      }
      if (!ok) return;
      const M = trs(new THREE.Matrix4(), px, this.world.heightAt(px, pz), pz,
        yaw + (hash3i(seed, 31, 1) - 0.5) * 0.2);
      B.put('billboard_frame', M, [0.8, 0.9, 0.5]);
      B.put('billboard_face', M, [0.8, 0.8, 0.3]);
      B.put('billboard_art', M, [0.75, 0.85, 0.3]);
      B.put('billboard_lit', M, null);
    }
  }

  /* -------------------------------------------- verges and waste ground -- */

  /**
   * A drift of grass rather than one tuft. Scaled by `q.grassDensity` so `low`
   * places one and `ultra` places six, which is the whole point of that number
   * existing — it had never been read.
   */
  _grassDrift(B, x, y, z, seed, i, sc, mask) {
    const n = Math.max(1, Math.round(6 * this.grassDensity));
    for (let k = 0; k < n; k++) {
      const g0 = hash3i(seed, i * 13 + k, 51);
      const g1 = hash3i(seed, i * 13 + k, 52);
      const gx = x + (g0 - 0.5) * 2.6;
      const gz = z + (g1 - 0.5) * 2.6;
      const gy = this.world.heightAt(gx, gz);
      if (!this._clearsLanes(gx, gy, gz, LOT_CLEAR)) continue;
      const gs = sc * (0.65 + 0.85 * g0);
      B.put('grass_clump', trs(new THREE.Matrix4(),
        gx, gy, gz, g1 * TAU, gs * 1.6, gs, gs * 1.6), mask);
    }
  }

  /**
   * IS THERE ROOM FOR A TREE HERE, OR IS THERE A BRIDGE OVER IT?
   *
   * Without this, a canopy floats against a viaduct girder with no trunk under
   * it. Scatter vegetation is planted at `world.heightAt` — the TERRAIN — and
   * the terrain runs on underneath every viaduct and embankment in the city, so
   * a tree can be planted in the dark under a deck with its trunk swallowed by
   * the structure and only the top of its crown poking through. Nothing in the
   * placement arithmetic can see that; only the geometry can.
   *
   * A HIT is positive evidence and vetoes the tree. A MISS is not evidence of
   * anything — `physics` only holds triangles within 320 m of the camera and a
   * tile can be built outside that — so a miss plants as before. That asymmetry
   * is deliberate: it can only ever remove a tree that provably has a roof.
   */
  _headroom(x, y, z, need) {
    const phys = this._phys();
    if (!phys?.raycast) return true;
    const h = phys.raycast(x, y + 0.6, z, 0, 1, 0, need, phys.MASK?.WORLD);
    return !(h?.hit);
  }

  _wasteGround(B, bx, lots, rng) {
    // Scatter on whatever the world calls dirt or grass inside this tile: the
    // verge behind the kerb, the batter of an embankment, the gaps nobody owns.
    const N = 44;
    const seed = (Math.imul(bx.x0 | 0, 0x9e3779b1) ^ Math.imul(bx.z0 | 0, 0x85ebca6b)) >>> 0;
    for (let i = 0; i < N; i++) {
      const x = bx.x0 + hash3i(seed, i, 1) * (bx.x1 - bx.x0);
      const z = bx.z0 + hash3i(seed, i, 2) * (bx.z1 - bx.z0);
      const surf = this.world.surfaceAt?.(x, z);
      if (surf !== 'grass' && surf !== 'dirt') continue;
      const y = this.world.heightAt(x, z);
      // A verge inside a road corridor is still road.
      if (!this._clearsLanes(x, y, z, LOT_CLEAR)) continue;
      const yaw = hash3i(seed, i, 3) * TAU;
      const sc = 0.7 + hash3i(seed, i, 4) * 0.9;
      const r = hash3i(seed, i, 5);
      const mask = [0.4, 0.55, 0.5];
      /**
       * WATER'S EDGE. Three rivers and forty bridges, and the banks were bare
       * mown terrain right down to the waterline. Within ~7 m of water the
       * scatter switches to the willow-scrub form, which is taller, looser and
       * hangs over — the read that says "riverbank" from a boat or a bridge.
       */
      const bank = this.world.isWater
        ? (this.world.isWater(x + 7, z) || this.world.isWater(x - 7, z)
          || this.world.isWater(x, z + 7) || this.world.isWater(x, z - 7))
        : false;
      if (bank) {
        if (r < 0.52) B.put('scrub_bank', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc * (0.8 + r), sc), mask);
        else if (r < 0.86) B.put('scrub_clump', trs(new THREE.Matrix4(), x, y, z, yaw, sc * 1.2, sc, sc * 1.2), mask);
        else this._grassDrift(B, x, y, z, seed, i, sc, mask);
        continue;
      }
      if (r < 0.45) this._grassDrift(B, x, y, z, seed, i, sc, mask);
      else if (r < 0.72) B.put('weed_tuft', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
      else if (r < 0.90) B.put('scrub_clump', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
      else if (this._headroom(x, y, z, 9 * sc)) {
        const sp = ['plane', 'maple', 'locust', 'pear'][Math.floor(hash3i(seed, i, 7) * 4) % 4];
        const v = Math.floor(hash3i(seed, i, 8) * 4) % 4;
        const M = trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc, (hash3i(seed, i, 6) - 0.5) * 0.12);
        B.put(`tree_${sp}_${v}_wood`, M, mask);
        B.put(`tree_${sp}_${v}_leaf${(i + 2) % 4}`, M, mask);
      } else {
        B.put('scrub_clump', trs(new THREE.Matrix4(), x, y, z, yaw, sc, sc, sc), mask);
      }
    }
  }

  /* ================================================================== */
  /* parked cars — coordinated with `vehicles` at runtime                */
  /* ================================================================== */

  /**
   * The lane layer `traffic` publishes, or null until it exists. Read at build
   * time, never imported (ARCHITECTURE.md rule 2), and re-read while it is not
   * ready because the first tiles are dressed before `traffic` has attached.
   */
  _lanes() {
    if (this._laneNet?.ready) return this._laneNet;
    this._laneNet = this.peek?.('traffic')?.lanes ?? null;
    return this._laneNet?.ready ? this._laneNet : null;
  }

  /**
   * WHERE A KERB BAY IS LEGAL — a pure function of the edge, so `traffic` can
   * ask it the same question (`props.parkedOnEdge`) and get the same answer
   * without either of us keeping state.
   *
   * The rule is `traffic/lanes.js`'s, restated rather than guessed at: a bay
   * eats ~2.45 m of carriageway, so it may only exist where giving up the kerb
   * lane still leaves a running lane in each direction. On the 7.2 m two-lane
   * streets that is never true.
   */
  parksOn(edge, side) {
    if (!edge || edge.rail || edge.bridge) return false;
    if (edge.kind === 'highway' || edge.kind === 'alley') return false;
    if (edge.len < 40) return false;
    const L = this._lanes();
    if (L) {
      const flags = L.parkFlags(edge);
      return side > 0 ? !!(flags & 1) : !!(flags & 2);
    }
    // No traffic system: fall back to the same geometric test it uses.
    const fw = edge.forward;
    return fw >= 2 && edge.lanes - fw >= 2;
  }

  /**
   * FINAL GUARD: does a thing standing here clear every lane a driver may use?
   *
   * `parksOn` reasons about ONE edge, and that is not enough in a real graph —
   * downtown has an at-grade highway running alongside an arterial, so a bay
   * that is perfectly legal on its own edge can still sit in the middle of the
   * six-lane road next to it. Ten of the first pass's fifty-one slots did. This
   * asks the question the fleet actually cares about: is there any drivable
   * lane, at this height, within a car's half-width of me?
   *
   * This was originally only ever asked about PARKED CARS, which is why a real
   * player found a stop sign standing in a live lane: `_cornerKit`,
   * `_kerbClutter`, `_lampRun` and `_treeRun` all place from an offset measured
   * off `edge.width`, and `edge.width` is not the same number as "where the
   * outermost drivable lane ends" at a junction, on a flared approach, or
   * anywhere a second corridor runs close by. Every family now goes through
   * `_clearOff` / `_clearsLanes`.
   */
  _clearsLanes(x, y, z, clearance) {
    return this.laneIntrusion(x, y, z, clearance) <= 0;
  }

  /**
   * HOW FAR INTO a drivable lane a disc of radius `clearance` at (x,y,z) reaches,
   * in metres. <= 0 is clear.
   *
   * `_clearsLanes` is this thresholded, and `src/props/lanesweep.mjs` calls it
   * directly, so the shipped guard and the assertion that polices it are the
   * same arithmetic and cannot drift apart.
   *
   * `edges` may be a pre-gathered candidate list (see `_nearEdgesFor`); without
   * one it does its own broad-phase. `out`, when given, receives the edge that
   * produced the worst reading — which is the difference between "this prop's
   * own offset is wrong" and "a second corridor is lying on top of this one",
   * and those two have completely different fixes.
   */
  laneIntrusion(x, y, z, clearance, edges = null, out = null) {
    const roads = this.world.roads;
    if (!roads?.edgesInRect) return -1;
    let list = edges;
    if (!list) {
      list = this._nearEdges ??= [];
      list.length = 0;
      roads.edgesInRect(x - 30, z - 30, x + 30, z + 30, list);
    }
    const L = this._lanes();
    let worst = -1e9;
    for (const ed of list) {
      if (ed.rail) continue;
      const na = roads.nodes[ed.a];
      const nb = roads.nodes[ed.b];
      const px = x - na.x;
      const pz = z - na.z;
      const tRaw = px * ed.dx + pz * ed.dz;
      /**
       * A CARRIAGEWAY IS A BAND, NOT A CAPSULE.
       *
       * This used to clamp `t` to the segment and measure the euclidean
       * distance to the clamped point — a capsule, whose round cap projects a
       * disc of radius `laneEdge` past the end node. On a 28.6 m highway that
       * is fourteen metres of phantom road hanging off the end of every
       * segment, and it made furniture standing on a perfectly ordinary
       * pavement near a highway junction measure as 9 m deep in a lane. It also
       * made the reading DISCONTINUOUS: 7 cm of movement crossed the old
       * `len + 6` cutoff and swung the answer by 10 m.
       *
       * Edges meet end to end, so the neighbour owns the ground past the node
       * and the cap was never needed for coverage — only a short slop, so a
       * prop just past a dead end still respects the road it is standing in.
       */
      const over = tRaw < 0 ? -tRaw : tRaw > ed.len ? tRaw - ed.len : 0;
      if (over > 2.0) continue;
      const t = tRaw < 0 ? 0 : tRaw > ed.len ? ed.len : tRaw;
      const ey = na.y + (nb.y - na.y) * (t / Math.max(1e-3, ed.len));
      // A viaduct overhead is not an obstruction; only same-level road is.
      if (Math.abs(ey - y) > 3.0) continue;
      const lat = -ed.dz * px + ed.dx * pz;
      const dir = lat >= 0 ? 1 : -1;
      let laneEdge;
      if (L) {
        if (!L.drivable(ed, dir)) continue;
        laneEdge = Math.abs(L.laneOffset(ed, L.laneHi(ed, dir))) + ed.laneWidth * 0.5;
      } else {
        const fw = ed.forward;
        const k = dir > 0 ? fw - 1 : ed.lanes - fw - 1;
        if (k < 0) continue;
        laneEdge = (k + 1) * ed.laneWidth;
      }
      // Perpendicular distance to the centreline — `lat` already is exactly
      // that, because an edge is straight.
      const dist = Math.abs(lat);
      const d = laneEdge + 0.15 - (dist - clearance);
      if (d > worst) {
        worst = d;
        if (out) {
          out.edge = ed;
          out.laneEdge = laneEdge;
          out.dist = dist;
        }
      }
    }
    return worst === -1e9 ? -1 : worst;
  }

  /**
   * Broad-phase for a whole edge, cached.
   *
   * The guard used to run its own `edgesInRect` per candidate. That is fine for
   * fifty parked cars and ruinous for the ~40 pieces of furniture on every side
   * of every edge in the city — it is the same query, from points a couple of
   * metres apart, tens of thousands of times. One query per edge, sized to the
   * edge's own bounds plus the 30 m the point query used, is identical in
   * result and roughly two orders of magnitude cheaper.
   */
  _nearEdgesFor(edge) {
    let rec = (this._nearCache ??= new Map()).get(edge.id);
    if (rec) return rec;
    const g = this.world.roads;
    const na = g.nodes[edge.a];
    const nb = g.nodes[edge.b];
    rec = [];
    g.edgesInRect?.(
      Math.min(na.x, nb.x) - 30, Math.min(na.z, nb.z) - 30,
      Math.max(na.x, nb.x) + 30, Math.max(na.z, nb.z) + 30, rec
    );
    this._nearCache.set(edge.id, rec);
    return rec;
  }

  /**
   * PUSH, THEN DROP. Street furniture belongs at the kerb, so a piece that
   * fouls a lane is almost always a piece whose offset was measured off the
   * wrong number rather than a piece that should not exist.
   *
   * Rejecting outright is what left "every short block completely bare" the
   * last time a clearance rule went in here, so this walks the prop outward
   * across the pavement in 0.25 m steps first and only gives up when even the
   * back of the footway is inside a lane (which means the pavement itself is
   * under the road — a `world` problem, not something to dress).
   *
   * @returns {THREE.Vector3|null} a cleared position, or null to skip.
   */
  _clearOff(edge, s, side, off, clearance, maxOff, out = new THREE.Vector3()) {
    const near = this._nearEdgesFor(edge);
    for (let o = off; o <= maxOff + 1e-6; o += 0.25) {
      this._pos(edge, s, side, o, out);
      if (this.laneIntrusion(out.x, out.y, out.z, clearance, near) <= 0) return out;
    }
    return null;
  }

  /** Signed lateral offset of the bay centre from the edge centreline. */
  _bayOffset(edge, side) {
    const L = this._lanes();
    if (L) return L.parkOffset(edge, side);
    return side > 0 ? edge.width * 0.5 - PARK_INSET : -(edge.width * 0.5 - PARK_INSET);
  }

  /**
   * PARKED CARS STAND ON THE CARRIAGEWAY, SO THE CARRIAGEWAY DECIDES.
   *
   * The first pass put a car at `width*0.5 - 1.05` on every street and arterial
   * in the city. On a 7.2 m two-lane street the running lane centre is 1.65 m
   * out from the crown and the parked car sat at 2.55 +/- 1.0 m — parked ON the
   * lane, all the way across it. `traffic` measured ~200 heavy impacts per
   * simulated minute and had to write a static-obstruction swerve to survive us.
   * The slots also collided with each other: a 6.2 m pitch cannot hold a 7.2 m
   * truck, which is the 1.7 m of interpenetration `traffic/parking.js` logged.
   *
   * Now: only where `traffic` says a bay exists (it has already taken that lane
   * out of the drivable set), at the offset it publishes, and the pitch is the
   * length of the vehicle THIS slot will actually receive plus a manoeuvring
   * gap — so two slots cannot overlap however the types fall out.
   */
  _parking(edge, side, s0, s1, seed, style, bx, out) {
    if (!this.parksOn(edge, side)) return;
    const lat = this._bayOffset(edge, side);
    const g = this.world.roads;
    const na = g.nodes[edge.a];
    const nb = g.nodes[edge.b];
    // Keep clear of the junction: a car standing in the throat of a turn is the
    // one place a parked car actually does block traffic that has nowhere else
    // to go.
    const a0 = Math.max(s0, 0) + BAY_END_CLEAR;
    const a1 = Math.min(s1, edge.len) - BAY_END_CLEAR;
    if (a1 - a0 < 8) return;
    const occupancy = 0.34 + style.meters * 0.34 + style.litter * 0.12;
    const along = Math.atan2(edge.dx, edge.dz);

    let s = a0 + hash3i(seed, 0, 200) * 3.5;
    let i = 0;
    while (i < 40) {
      i++;
      const kind = pickKerbType(hash3i(seed, i, 206));
      const step = kind.L + BAY_GAP;
      if (s + kind.L > a1) break;
      const cs = s + kind.L * 0.5;
      if (hash3i(seed, i, 201) <= occupancy) {
        const t = cs / edge.len;
        const x = na.x + (nb.x - na.x) * t - edge.dz * lat;
        const z = na.z + (nb.z - na.z) * t + edge.dx * lat;
        const y = na.y + (nb.y - na.y) * t;
        if (this._in(bx, x, z) && this._clearsLanes(x, y, z, 1.15)) {
          out.push({
            x, y, z,
            yaw: along + (side > 0 ? Math.PI : 0) + (hash3i(seed, i, 203) - 0.5) * 0.07,
            type: kind.t,
            half: kind.L * 0.5,
            src: 'kerb',
            seed: (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0,
          });
        }
      }
      s += step;
    }
  }

  /**
   * OFF-STREET PARKING. Two-lane streets cannot carry a parked car and an empty
   * kerb reads as a film set, so the density has to come from somewhere that is
   * not the running lane: the surface car parks `world` marks as `kind: 'lot'`.
   * Bays run in rows off the lot's long axis, which is what a real lot does and
   * what makes a row of cars read as parked rather than abandoned.
   */
  _lotParking(lot, seed, out, bx) {
    const foot = lot.footprint;
    const b = polyBounds(foot);
    if (b.w < 12 || b.d < 12) return;
    // Rows run along the lot's longer axis; bays are perpendicular to them.
    const alongX = b.w >= b.d;
    const rowPitch = 6.4;
    const bayPitch = 2.85;
    const rows = Math.floor((alongX ? b.d : b.w) / rowPitch);
    const bays = Math.floor((alongX ? b.w : b.d) / bayPitch);
    /**
     * A car in a bay stands ACROSS its row, never along it. Bays are 2.85 m
     * apart and a sedan is 4.8 m long: get this ninety degrees wrong and every
     * car in the lot is buried in the two beside it.
     */
    const yaw0 = alongX ? 0 : Math.PI / 2;
    const occupancy = 0.34 + hash3i(seed, 0, 301) * 0.28;
    for (let r = 0; r < rows; r++) {
      const u = (alongX ? b.z0 : b.x0) + (r + 0.5) * rowPitch;
      const flip = r % 2 === 0 ? 0 : Math.PI;
      for (let k = 0; k < bays; k++) {
        if (hash3i(seed, r * 41 + k, 302) > occupancy) continue;
        const v = (alongX ? b.x0 : b.z0) + (k + 0.5) * bayPitch;
        const x = alongX ? v : u;
        const z = alongX ? u : v;
        if (!pointInPoly(x, z, foot, 3.4)) continue;
        if (!this._in(bx, x, z)) continue;
        if (this.world.isWater?.(x, z)) continue;
        /**
         * A lot polygon can run right up to — and sometimes over — the kerb, so
         * "inside the lot" is not the same as "off the road". Ask the graph.
         * Eight bays in the first pass landed 2 m from an arterial crown.
         */
        const kind = pickKerbType(hash3i(seed, r * 41 + k, 303));
        if (kind.L > 6) continue; // a box truck does not fit a 5.5 m bay
        const y = this.world.heightAt(x, z);
        // A bay stands ACROSS its row, so it is its LENGTH that reaches toward
        // whatever road the lot happens to back onto.
        if (!this._clearsLanes(x, y, z, kind.L * 0.5 + 0.4)) continue;
        out.push({
          x, y, z,
          yaw: yaw0 + flip + (hash3i(seed, r * 41 + k, 304) - 0.5) * 0.09,
          type: kind.t,
          half: kind.L * 0.5,
          src: 'lot',
          seed: (seed ^ Math.imul(r * 41 + k + 1, 0x85ebca6b)) >>> 0,
        });
      }
    }
  }
}

/* ---------------------------------------------------------------- utils -- */

function polyBounds(poly) {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const p of poly) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < z0) z0 = p[1];
    if (p[1] > z1) z1 = p[1];
  }
  return { x0, z0, x1, z1, w: x1 - x0, d: z1 - z0, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
}

function pointInPoly(x, z, poly, margin = 0) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  if (!inside || margin <= 0) return inside;
  // crude erosion: stay `margin` away from every edge
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    let t = l2 > 1e-9 ? ((x - a[0]) * dx + (z - a[1]) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = a[0] + dx * t - x;
    const qz = a[1] + dz * t - z;
    if (qx * qx + qz * qz < margin * margin) return false;
  }
  return true;
}

export { polyBounds, pointInPoly };
