import * as THREE from 'three';
import { Accum, trs } from './geom.js';
import { SURFACES, TRANSPARENT, surfaceTagOf } from './palette.js';

/**
 * BUILDINGS — the per-tile assembler.
 *
 * Every generator writes into one of these rather than touching the scene,
 * which is how a tile holding thirty buildings and ~40 000 pieces of facade
 * furniture comes out as ~20 draw calls:
 *
 *   add(key, geo, matrix, opts)   merge into this tile's static batch for `key`
 *   proto(id, geo, key, opts)     declare a globally shared instance prototype
 *   put(id, x,y,z, ry, s, masks)  add one instance of it to this tile
 *   box(surface, ...)             an axis-aligned collision proxy
 *
 * Collision is authored separately from the visual mesh: proxies are boxes
 * generated from the same numbers that built the geometry, so a doorway is a
 * real hole in the hull and the BVH stays in the thousands of triangles instead
 * of chewing through every window chamfer.
 */

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
/**
 * Instance groups smaller than this are merged into the tile's static batch
 * instead of becoming their own InstancedMesh. See build().
 */
const MERGE_BELOW = 48;
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });

/**
 * Prototype geometry is shared by every tile in the city — a window unit built
 * once is the same forty thousand times. Instance MATRICES are per tile, so a
 * tile can be freed without touching the library.
 */
export class ProtoLibrary {
  constructor(materials) {
    this.materials = materials;
    this.protos = new Map(); // id -> { geo, key, castShadow, noPrepass }
    this._mats = new Map(); // surface key -> THREE.Material
    this._geoCache = new Map();
  }

  mat(key) {
    let m = this._mats.get(key);
    if (m) return m;
    const def = SURFACES[key];
    if (!def) {
      console.warn(`[buildings] unknown surface "${key}"`);
      return this.mat('concrete_wall');
    }
    m = this.materials.get(def.name, def.opts);
    if (TRANSPARENT.has(key)) {
      m.userData.owBuildingGlass = true;
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -1;
    }
    this._mats.set(key, m);
    return m;
  }

  /** Cache one-off geometry that several generators want (a step, a bracket). */
  cache(id, factory) {
    let g = this._geoCache.get(id);
    if (!g) {
      g = factory();
      this._geoCache.set(id, g);
    }
    return g;
  }

  /** Declare (once) an instanced prototype. Returns the id. */
  proto(id, factory, key, opts = {}) {
    if (this.protos.has(id)) return id;
    const geo = factory();
    geo.computeBoundingSphere();
    this.protos.set(id, {
      id,
      geo,
      key,
      castShadow: opts.castShadow !== false,
      receiveShadow: opts.receiveShadow !== false,
      noPrepass: !!opts.noPrepass || TRANSPARENT.has(key),
      noShadow: !!opts.noShadow || TRANSPARENT.has(key),
      tris: (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3,
    });
    return id;
  }

  has(id) {
    return this.protos.has(id);
  }

  dispose() {
    for (const p of this.protos.values()) p.geo.dispose();
    for (const g of this._geoCache.values()) g.dispose();
    this.protos.clear();
    this._geoCache.clear();
    this._mats.clear();
  }
}

export class TileBuilder {
  constructor(lib, name = 'tile') {
    this.lib = lib;
    this.name = name;
    this._static = new Map(); // surface key -> Accum
    this._detail = new Map(); // surface key -> Accum, hosted under a THREE.LOD
    this._inst = new Map(); // proto id -> { m: Matrix4[], c: masks[] }
    this._collide = new Map(); // surface tag -> Accum
    this.lights = [];
    this.stats = { tris: 0, instTris: 0, instances: 0, draws: 0, keptOut: 0 };
    /** See `setKeepOut` and `BuildingSystem._keepOutFor`. */
    this._keepOut = null;
  }

  /**
   * Refuse any piece that would stand on a drivable carriageway.
   *
   * Without this, roads end up undrivable. `_clipToStreets` trims
   * the LOT, but everything hung off the building afterwards — plinth courses,
   * silos, pipe-rack legs, stoops, and every part of every hand-authored
   * landmark — was placed with nothing checking it. This is the one chokepoint
   * all of that passes through, so it is where the check belongs: the caller
   * sets a predicate for the duration of one building and every `add`, `place`
   * and collision `box` is measured against it.
   *
   * `fn(bbox, matrix, geo) -> true to drop`. Null disables. Cleared per lot by
   * the caller, never sticky.
   */
  setKeepOut(fn) {
    this._keepOut = fn ?? null;
    this._gone = null;
    return this;
  }

  /**
   * NOTHING THE GUARD REMOVES MAY LEAVE SOMETHING HANGING IN THE AIR.
   *
   * The first cut dropped pieces individually and it produced a defect worse
   * than the one it fixed. A blast furnace's stove is one 40 m cylinder with a
   * separate cap cylinder on top of it; a mill stack is the same. Drop the
   * body — because its base is standing in a street — and the cap stays exactly
   * where it was, forty metres up, with nothing under it. The `mill` capture
   * came back with four rust-coloured funnels floating in the sky.
   *
   * So every removal is remembered as an XZ footprint and a top height, and any
   * later piece that sits ON one of those and nowhere else goes with it. The
   * result is a missing stove rather than a levitating one, which is the right
   * way round: a gap reads as "there is a street through here", and a floating
   * cone reads as a broken engine.
   *
   * The list is per building (cleared by `setKeepOut`) and never more than a few
   * dozen entries, so this is a handful of comparisons per piece.
   */
  _orphaned(x0, z0, x1, z1, y0) {
    const g = this._gone;
    if (!g) return false;
    for (let i = 0; i < g.length; i += 5) {
      // Wholly over the removed piece's plan, and starting at or above its top.
      if (x0 >= g[i] - 0.4 && x1 <= g[i + 2] + 0.4 &&
          z0 >= g[i + 1] - 0.4 && z1 <= g[i + 3] + 0.4 &&
          y0 >= g[i + 4] - 1.0) return true;
    }
    return false;
  }

  _drop(geo, matrix) {
    const f = this._keepOut;
    if (!f || !geo) return false;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    // World-space extent of this piece, needed by both the guard and the
    // orphan test.
    const lo = bb.min;
    const hi = bb.max;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z);
      if (matrix) _v.applyMatrix4(matrix);
      if (_v.x < x0) x0 = _v.x;
      if (_v.x > x1) x1 = _v.x;
      if (_v.y < y0) y0 = _v.y;
      if (_v.y > y1) y1 = _v.y;
      if (_v.z < z0) z0 = _v.z;
      if (_v.z > z1) z1 = _v.z;
    }
    if (!this._orphaned(x0, z0, x1, z1, y0) && !f(bb, matrix, geo)) return false;
    (this._gone ??= []).push(x0, z0, x1, z1, y1);
    this.stats.keptOut++;
    return true;
  }

  // ------------------------------------------------------------- static ---
  /**
   * `opts.detail` routes the geometry into the tile's DETAIL bucket, which is
   * hosted under a `THREE.LOD` whose far level is empty (see build()). Use it
   * for anything that stops resolving at range — facade banding, reveal piers,
   * sill courses. The silhouette must never go in here: the far level being
   * empty means "this disappears", and a silhouette that changes shape at a
   * distance threshold is worse than no LOD at all.
   */
  add(key, geo, matrix = null, opts = null) {
    if (this._keepOut && this._drop(geo, matrix)) return this;
    const bucket = opts?.detail === true ? this._detail : this._static;
    let a = bucket.get(key);
    if (!a) bucket.set(key, (a = new Accum(`${this.name}:${key}`)));
    a.add(geo, matrix, opts);
    return this;
  }

  /** Merge a transformed box-like geometry. */
  addAt(key, geo, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, opts = null) {
    return this.add(key, geo, trs(_m, x, y, z, ry, sx, sy, sz), opts);
  }

  /** Merge then free — for a geometry generated for exactly one placement. */
  addOnce(key, geo, matrix = null, opts = null) {
    this.add(key, geo, matrix, opts);
    geo.dispose();
    return this;
  }

  // ---------------------------------------------------------- instanced ---
  place(id, matrix, masks = null) {
    if (this._keepOut) {
      const p = this.lib.protos.get(id);
      if (p && this._drop(p.geo, matrix)) return this;
    }
    let e = this._inst.get(id);
    if (!e) this._inst.set(id, (e = { id, m: [], c: [] }));
    e.m.push(matrix.clone());
    e.c.push(masks ?? null);
    return this;
  }

  put(id, x, y, z, ry = 0, s = 1, masks = null, rx = 0, rz = 0) {
    trs(_m, x, y, z, ry, s, s, s, rx, rz);
    return this.place(id, _m, masks);
  }

  putS(id, x, y, z, ry, sx, sy, sz, masks = null, rx = 0, rz = 0) {
    trs(_m, x, y, z, ry, sx, sy, sz, rx, rz);
    return this.place(id, _m, masks);
  }

  /**
   * Place using a caller-supplied basis matrix (facade space -> world).
   * `masks` is the per-instance [wear, grime, ao] scale — no two windows in a
   * street are equally dirty, and an instance cloud with one mask value is the
   * loudest "this is a kit on a grid" tell there is.
   */
  putM(id, basis, lx, ly, lz, ry = 0, sx = 1, sy = sx, sz = sx, masks = null) {
    trs(_m, lx, ly, lz, ry, sx, sy, sz);
    _m.premultiply(basis);
    return this.place(id, _m, masks);
  }

  // ---------------------------------------------------------- collision ---
  box(surface, cx, cy, cz, sx, sy, sz, ry = 0) {
    if (this._keepOut && this._drop(UNIT_BOX, trs(_m, cx, cy, cz, ry, sx, sy, sz))) return this;
    let a = this._collide.get(surface);
    if (!a) this._collide.set(surface, (a = new Accum(`col:${surface}`)));
    a.add(UNIT_BOX, trs(_m, cx, cy, cz, ry, sx, sy, sz));
    return this;
  }

  /** A wall slab given in panel space, placed through the panel's basis. */
  slabBox(surface, basis, x, y, w, h, t) {
    trs(_m, x, y, t * 0.5, 0, w, h, t);
    _m.premultiply(basis);
    if (this._keepOut && this._drop(UNIT_BOX, _m)) return this;
    let a = this._collide.get(surface);
    if (!a) this._collide.set(surface, (a = new Accum(`col:${surface}`)));
    a.add(UNIT_BOX, _m);
    return this;
  }

  // ----------------------------------------------------------- finalize ---
  /**
   * Build the meshes into a Group. Nothing is added to the scene here — the
   * system decides when a tile becomes visible.
   */
  build(physics, opts = {}) {
    const group = new THREE.Group();
    group.name = `buildings_${this.name}`;
    group.matrixAutoUpdate = false;
    const bounds = new THREE.Box3();
    bounds.makeEmpty();

    /**
     * The detail LOD host. `render` honours `THREE.LOD` natively and rescales
     * the level distances by `q.lodBias`, FOV and resolution, so the distance
     * below is authored for a 1080p / 60-degree frame (ARCHITECTURE.md, render
     * integration). The far level is an empty Group: past the threshold the
     * facade banding simply stops being submitted, and because the banding is
     * proud of a wall that is still there, the silhouette does not move.
     *
     * The merged geometry is in world space, so the LOD node is positioned at
     * the tile centre (three measures LOD distance from the node's own world
     * position, and a node parked at the origin would measure the distance to
     * the middle of the map) and the level group is counter-translated.
     */
    let lodNode = null;
    let detailHost = group;
    const lodDist = opts.lodDistance ?? 0;
    if (this._detail.size && lodDist > 0) {
      lodNode = new THREE.LOD();
      lodNode.name = `bl_${this.name}`;
      lodNode.autoUpdate = false;
      const near = new THREE.Group();
      near.name = `bld_${this.name}`;
      near.matrixAutoUpdate = false;
      const c = opts.lodCenter ?? [0, 0, 0];
      lodNode.position.set(c[0], c[1], c[2]);
      near.position.set(-c[0], -c[1], -c[2]);
      near.updateMatrix();
      lodNode.addLevel(near, 0);
      lodNode.addLevel(new THREE.Group(), lodDist);
      lodNode.updateMatrix();
      group.add(lodNode);
      detailHost = near;
    } else if (this._detail.size) {
      // No LOD requested — fold the detail buckets back into the static ones so
      // nothing is silently dropped.
      for (const [key, acc] of this._detail) {
        const cur = this._static.get(key);
        if (!cur) this._static.set(key, acc);
        else mergeAccum(cur, acc);
      }
      this._detail.clear();
    }

    /**
     * The long tail of instance groups is the real draw-call cost of a tile:
     * one areaway, two water towers and three satellite dishes are three more
     * draw calls EACH, again through the prepass and again through every shadow
     * cascade. Below the threshold it is strictly cheaper to bake them into the
     * static batch for the same material, which already exists. This alone
     * takes a dense downtown tile from ~47 batches to ~18.
     */
    for (const [, e] of this._inst) {
      const p = this.lib.protos.get(e.id);
      if (!p || e.m.length === 0 || e.m.length >= MERGE_BELOW) continue;
      for (let i = 0; i < e.m.length; i++) {
        this.add(p.key, p.geo, e.m[i], e.c[i] ? { masks: e.c[i] } : null);
      }
      e.m.length = 0;
    }

    /**
     * `noShadow` is set for the DETAIL bucket, and it is not a saving — it is a
     * correctness fix.
     *
     * The detail bucket is the mid-LOD's facade relief: glazing bands 2 cm
     * proud, spandrel courses 17 cm proud, piers 24 cm proud. It only ever
     * draws between the full-detail ring (~130 m) and `farDetailDist` (~520 m).
     * A CSM cascade covering 500 m has a texel a metre or more across, so a
     * 2 cm slab casting into it lands entirely inside its own depth bias and
     * self-shadows in a stipple. That is what shredded every mid-distance
     * elevation in the `skyline` capture into torn, dithered horizontal bands —
     * measured as "no mullion depth, flat plane with horizontal banding",
     * because a torn band is exactly what a flat painted stripe looks like.
     *
     * The relief still reads: the massing prism underneath it casts the
     * building's own shadow, and the recess is baked into the vertex AO mask
     * (see buildLotLod), which is resolution-independent.
     */
    const emit = (bucket, host, noShadow = false) => {
      for (const [key, acc] of bucket) {
        if (acc.empty) continue;
        const geo = acc.build();
        const mesh = new THREE.Mesh(geo, this.lib.mat(key));
        mesh.name = `b_${key}`;
        mesh.castShadow = !TRANSPARENT.has(key) && !noShadow;
        mesh.receiveShadow = true;
        if (noShadow) mesh.userData.owNoShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.userData.surface = surfaceTagOf(key);
        mesh.userData.collision = false;
        // Nothing a building is made of ever moves: skip the per-frame velocity
        // bookkeeping (ARCHITECTURE.md, render integration).
        mesh.userData.owStatic = true;
        if (TRANSPARENT.has(key)) {
          mesh.userData.owNoPrepass = true;
          mesh.userData.owNoShadow = true;
          mesh.renderOrder = 2;
        }
        mesh.updateMatrix();
        host.add(mesh);
        if (geo.boundingBox === null) geo.computeBoundingBox();
        if (geo.boundingBox) bounds.union(geo.boundingBox);
        this.stats.tris += geo.index.count / 3;
        this.stats.draws++;
      }
    };
    emit(this._static, group);
    emit(this._detail, detailHost, true);

    for (const [id, e] of this._inst) {
      const p = this.lib.protos.get(id);
      if (!p || e.m.length === 0) continue;
      const im = new THREE.InstancedMesh(p.geo, this.lib.mat(p.key), e.m.length);
      im.name = `bi_${id}`;
      im.castShadow = p.castShadow && !p.noShadow;
      im.receiveShadow = p.receiveShadow;
      im.matrixAutoUpdate = false;
      im.userData.surface = surfaceTagOf(p.key);
      im.userData.collision = false;
      im.userData.owStatic = true;
      if (p.noPrepass) im.userData.owNoPrepass = true;
      if (p.noShadow) {
        im.userData.owNoShadow = true;
        im.renderOrder = 2;
      }
      let needColor = false;
      for (let i = 0; i < e.c.length; i++) if (e.c[i]) needColor = true;
      if (needColor) {
        const arr = new Float32Array(e.m.length * 3);
        for (let i = 0; i < e.m.length; i++) {
          const mk = e.c[i] ?? [0, 0, 0];
          arr[i * 3] = mk[0];
          arr[i * 3 + 1] = mk[1];
          arr[i * 3 + 2] = mk[2];
        }
        im.instanceColor = new THREE.InstancedBufferAttribute(arr, 3);
      }
      for (let i = 0; i < e.m.length; i++) im.setMatrixAt(i, e.m[i]);
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.computeBoundingBox();
      im.updateMatrix();
      group.add(im);
      if (im.boundingBox) bounds.union(im.boundingBox);
      this.stats.draws++;
      this.stats.instances += e.m.length;
      this.stats.instTris += p.tris * e.m.length;
    }

    // --- collision ---
    const handles = [];
    const colMeshes = [];
    if (this._collide.size) {
      for (const [surface, acc] of this._collide) {
        if (acc.empty) continue;
        const geo = acc.build();
        const mesh = new THREE.Mesh(geo, INVISIBLE);
        mesh.name = `bcol_${surface}`;
        mesh.visible = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.updateMatrixWorld(true);
        colMeshes.push(mesh);
        if (physics) {
          const h = physics.addStatic(mesh, surface);
          if (h >= 0) handles.push(h);
        }
      }
    }

    group.updateMatrix();
    this._static.clear();
    this._detail.clear();
    this._inst.clear();
    this._collide.clear();

    // A world-space sphere for the hierarchical cull. Derived from the geometry
    // that was actually emitted, so a tile carrying a 60 m tower is not culled
    // by a sphere sized for a two-storey terrace.
    let sphere = null;
    if (!bounds.isEmpty()) {
      sphere = new THREE.Sphere();
      bounds.getBoundingSphere(sphere);
    }
    return { group, handles, colMeshes, lod: lodNode, sphere, stats: this.stats };
  }
}

/** Append one Accum onto another (used when a detail bucket has no LOD host). */
function mergeAccum(dst, src) {
  const base = dst.verts;
  for (let i = 0; i < src.pos.length; i++) dst.pos.push(src.pos[i]);
  for (let i = 0; i < src.nrm.length; i++) dst.nrm.push(src.nrm[i]);
  for (let i = 0; i < src.uv.length; i++) dst.uv.push(src.uv[i]);
  for (let i = 0; i < src.col.length; i++) dst.col.push(src.col[i]);
  for (let i = 0; i < src.idx.length; i++) dst.idx.push(base + src.idx[i]);
  dst.verts += src.verts;
  dst.tris += src.tris;
}

/** Free a built tile: geometry, collision handles, scene attachment. */
export function releaseTile(rec, physics) {
  if (!rec) return;
  for (const h of rec.handles ?? []) physics?.removeStatic?.(h);
  for (const m of rec.colMeshes ?? []) m.geometry?.dispose();
  const g = rec.group;
  if (g) {
    g.traverse((o) => {
      if (o.isInstancedMesh) {
        o.dispose?.();
        return; // prototype geometry is owned by the library
      }
      if (o.isMesh) o.geometry?.dispose();
    });
    g.parent?.remove(g);
  }
  rec.group = null;
  rec.handles = null;
  rec.colMeshes = null;
  rec.lod = null;
  rec.sphere = null;
}

export { _v as _scratchVec };
