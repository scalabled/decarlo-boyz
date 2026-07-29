import * as THREE from 'three';
import { Accum, trs } from './geom.js';
import { SURFACES, EMISSIVE, SURFACE_TAG } from './palette.js';

/**
 * PROPS — the per-tile assembler.
 *
 * No generator in this subsystem touches the scene graph. They write into one
 * of these, and the batcher decides whether a family becomes an InstancedMesh
 * or gets merged into the tile's static batch for its surface. That is what
 * turns a tile carrying eight hundred pieces of street furniture into a couple
 * of dozen draw calls (ARCHITECTURE.md rule 7).
 *
 *   proto(id, factory, surface, opts)   declare a globally shared prototype
 *   put(id, matrix, mask)               one instance of it in this tile
 *   add(surface, geo, matrix, ...)      merge one-off geometry
 *
 * PER-INSTANCE VARIATION. Instances carry an `instanceColor`, which the shared
 * material shader reads as the weathering mask triple (wear, grime, extra AO)
 * — see the vertex-colour mask contract in `materials/shader.js`. So one lamp
 * post prototype produces posts that are individually more or less rusted,
 * greasy and worn, on top of per-instance yaw, lean and scale. A critic called
 * out "every instance of every asset is at the same yaw" on the last build;
 * this is the machinery that answers it.
 */

/** Instance groups smaller than this are merged instead of instanced. */
const MERGE_BELOW = 8;

/**
 * Surfaces that stop being readable at distance. They go under a `THREE.LOD`
 * whose far level is empty, so a tile at the outer edge of the near radius
 * stops paying for its oil stains, its flyposting and its bin bags while
 * keeping its lamps, trees, poles and signage. `render` rescales the level
 * distances by `q.lodBias`, FOV and resolution, so this is authored for a
 * 1080p/60-degree frame.
 */
const DETAIL_SURFACES = new Set([
  'oil', 'tarpatch', 'puddle', 'decal_paint', 'decal_yellow', 'decal_arrow',
  'decal_arrow_turn', 'decal_hatch', 'poster_a', 'poster_b', 'poster_c',
  'poster_d', 'tag_a', 'tag_b', 'tag_c', 'tag_d', 'bag', 'cardboard',
  'grass_tuft', 'grass_blade', 'scrub', 'sodium_glow', 'chalkboard', 'ghost', 'ghost_ink',
]);
const DETAIL_DISTANCE = 145;

/**
 * FOLIAGE STAYS OUT OF THE DEPTH/NORMAL/VELOCITY PREPASS.
 *
 * `render`'s prepass draws with `scene.overrideMaterial`, and that override
 * carries no albedo map — so it cannot honour `alphaTest`. Every leaf card
 * therefore wrote its WHOLE octagon into the prepass depth buffer, including
 * the ~75 % of it that the lit pass then discards. The sky and the background
 * behind a canopy fail the depth test against that phantom depth, so the holes
 * in the foliage came out as pale neutral blobs — measured at (220,217,203),
 * the colour of the hazed skyline behind the tree and provably NOT the leaf:
 * tinting every foliage surface a different primary left the blobs unchanged.
 *
 * That reads exactly like the "black and very dark speckle / missing texels"
 * defect from the other side, and no amount of leaf authoring can touch it.
 * `owNoPrepass` is the documented opt-out (ARCHITECTURE.md, render integration)
 * and costs foliage its motion vectors, which is the right trade: a static
 * artefact visible in every paused frame against a little TAA softening on a
 * canopy that is already high-frequency.
 */
const NO_PREPASS_SURFACES = new Set([
  'leaf_a', 'leaf_b', 'leaf_c', 'leaf_autumn', 'leaf_needle', 'scrub',
  'grass_blade', 'grass_tuft',
]);

const _m = new THREE.Matrix4();
const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });

export class ProtoLibrary {
  constructor(materials) {
    this.materials = materials;
    this.protos = new Map();
    this._mats = new Map();
    this._emissive = new Map();
    this._geoCache = new Map();
    this.emissiveList = [];
  }

  /** A library surface, resolved through `materials` and cached. */
  mat(key) {
    let m = this._mats.get(key);
    if (m) return m;
    const def = SURFACES[key];
    if (!def) {
      console.warn(`[props] unknown surface "${key}"`);
      return this.mat('concrete_prop');
    }
    m = this.materials.get(def.name, def.opts ?? {});
    this._mats.set(key, m);
    return m;
  }

  /**
   * A pure emissive. Neon and sodium are light SOURCES, so they are not PBR
   * surfaces — they are unlit colour plus bloom, which is the only way a night
   * city with thousands of signs fits inside `q.lightSlots`.
   */
  emissive(key) {
    let m = this._emissive.get(key);
    if (m) return m;
    const def = EMISSIVE[key] ?? EMISSIVE.neon_amber;
    if (def.additive) {
      // `vertexColors` is what makes the falloff work: the light pool bakes a
      // smootherstep to ZERO at its rim into the mask triple, and an additive
      // surface multiplied to black contributes nothing. Without it the disc
      // has a hard edge and reads as painted geometry.
      m = new THREE.MeshBasicMaterial({
        color: def.color,
        transparent: true,
        opacity: 0.04,
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        toneMapped: true,
        polygonOffset: true,
        polygonOffsetFactor: -6,
        polygonOffsetUnits: -6,
      });
    } else {
      m = new THREE.MeshStandardMaterial({
        color: 0x0a0a0a,
        emissive: new THREE.Color(def.color),
        emissiveIntensity: def.base,
        roughness: def.rough ?? 0.45,
        metalness: 0,
      });
    }
    m.name = `props_em_${key}`;
    m.userData.owEmissive = {
      key, base: def.base, night: def.night, additive: !!def.additive,
      peak: def.peak, nightOnly: !!def.nightOnly,
    };
    this._emissive.set(key, m);
    this.emissiveList.push(m);
    return m;
  }

  isEmissive(key) {
    return EMISSIVE[key] !== undefined;
  }

  matFor(key) {
    return this.isEmissive(key) ? this.emissive(key) : this.mat(key);
  }

  /** Cache one-off geometry several generators want (a bolt, a bracket). */
  cache(id, factory) {
    let g = this._geoCache.get(id);
    if (!g) {
      g = factory();
      this._geoCache.set(id, g);
    }
    return g;
  }

  /**
   * Declare (once) an instanced prototype. The geometry is built exactly once
   * for the whole city; only the matrices are per tile.
   */
  /**
   * Declare (once) an instanced prototype. The geometry is built exactly once
   * for the whole city; only the matrices are per tile.
   *
   * `opts.geo` hands in a geometry that is ALREADY BUILT and may be SHARED with
   * other prototypes — the tree kit uses it so that one canopy mesh can be
   * painted four different greens instead of building four identical crowns.
   * Sharing is safe for everything downstream (`InstancedMesh` and `Accum` both
   * only read), and `dispose` de-duplicates so a shared geometry is freed once.
   */
  proto(id, factory, surface, opts = {}) {
    if (this.protos.has(id)) return id;
    const geo = opts.geo ?? (factory ? factory() : null);
    if (!geo) return id;
    geo.computeBoundingSphere();
    const idx = geo.getIndex();
    this.protos.set(id, {
      id,
      geo,
      surface,
      castShadow: opts.castShadow !== false,
      receiveShadow: opts.receiveShadow !== false,
      noShadow: !!opts.noShadow,
      noPrepass: !!opts.noPrepass,
      renderOrder: opts.renderOrder ?? 0,
      collide: opts.collide ?? null,
      tris: (idx ? idx.count : geo.getAttribute('position').count) / 3,
    });
    return id;
  }

  has(id) {
    return this.protos.has(id);
  }

  get(id) {
    return this.protos.get(id);
  }

  stats() {
    let tris = 0;
    const seen = new Set();
    for (const p of this.protos.values()) {
      if (seen.has(p.geo)) continue;
      seen.add(p.geo);
      tris += p.tris;
    }
    return { protos: this.protos.size, tris, materials: this._mats.size + this._emissive.size };
  }

  dispose() {
    const freed = new Set();
    for (const p of this.protos.values()) {
      if (freed.has(p.geo)) continue;
      freed.add(p.geo);
      p.geo.dispose();
    }
    for (const g of this._geoCache.values()) g.dispose();
    for (const m of this._emissive.values()) m.dispose();
    this.protos.clear();
    this._geoCache.clear();
    this._mats.clear();
    this._emissive.clear();
    this.emissiveList.length = 0;
  }
}

export class TileBatch {
  constructor(lib, name = 'proptile') {
    this.lib = lib;
    this.name = name;
    this._static = new Map(); // surface -> Accum
    this._inst = new Map(); // protoId -> { m: Matrix4[], c: number[] }
    this._collide = new Map(); // surface tag -> Accum
    /** Lamp head positions, for the small pool of real lights near the camera. */
    this.lamps = [];
    this.stats = { tris: 0, instTris: 0, instances: 0, draws: 0, props: 0 };
  }

  /** Merge one-off geometry into this tile's batch for `surface`. */
  add(surface, geo, matrix = null, maskMul = null, maskAdd = null) {
    let a = this._static.get(surface);
    if (!a) this._static.set(surface, (a = new Accum(`${this.name}:${surface}`)));
    a.add(geo, matrix, maskMul, maskAdd);
    this.stats.props++;
    return this;
  }

  /**
   * One instance of a prototype. `mask` is [wear, grime, ao] multipliers —
   * the per-instance weathering that stops a kit reading as stamped clones.
   */
  put(id, matrix, mask = null) {
    const p = this.lib.protos.get(id);
    if (!p) return this;
    let e = this._inst.get(id);
    if (!e) this._inst.set(id, (e = { m: [], c: [] }));
    e.m.push(matrix.clone ? matrix.clone() : matrix);
    e.c.push(mask ? mask[0] : 1, mask ? mask[1] : 1, mask ? mask[2] : 1);
    this.stats.props++;
    return this;
  }

  /** Shorthand: place a prototype from a pose instead of a matrix. */
  place(id, x, y, z, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0, mask = null) {
    return this.put(id, trs(new THREE.Matrix4(), x, y, z, ry, sx, sy, sz, rx, rz), mask);
  }

  /** An axis-aligned collision proxy. Physics eats these, not the visual mesh. */
  box(tag, x, y, z, w, h, d, ry = 0) {
    let a = this._collide.get(tag);
    if (!a) this._collide.set(tag, (a = new Accum(`${this.name}:col:${tag}`)));
    const g = new THREE.BoxGeometry(w, h, d);
    a.add(g, trs(_m, x, y + h / 2, z, ry));
    g.dispose();
    return this;
  }

  get empty() {
    return this._static.size === 0 && this._inst.size === 0;
  }

  /**
   * Emit meshes into `root`. Small instance groups are merged so a family with
   * three members in this tile does not cost a whole draw call.
   */
  build(root, opts = {}) {
    const out = [];
    const lib = this.lib;

    /**
     * `render` honours `THREE.LOD` natively and rescales the level distances by
     * `q.lodBias`, FOV and resolution. The detail layer — road stains, litter,
     * flyposting, aerosol, weeds, the light pools — is authored to switch off at
     * `DETAIL_DISTANCE`, where none of it resolves anyway. Structure (lamps,
     * trees, poles, wire, signage) never switches.
     */
    let lod = null;
    let detailRoot = root;
    if (opts.lod !== false) {
      lod = new THREE.LOD();
      lod.name = `${this.name}:detail`;
      lod.autoUpdate = true;
      const near = new THREE.Group();
      near.name = `${this.name}:detail_on`;
      lod.addLevel(near, 0);
      lod.addLevel(new THREE.Group(), DETAIL_DISTANCE);
      lod.position.copy(opts.center ?? new THREE.Vector3());
      near.position.copy(lod.position).negate();
      detailRoot = near;
      root.add(lod);
    }
    const hostFor = (surface) =>
      (lod && DETAIL_SURFACES.has(surface) ? detailRoot : root);

    for (const [id, e] of this._inst) {
      const p = lib.protos.get(id);
      if (!p || !e.m.length) continue;
      if (e.m.length < MERGE_BELOW) {
        let a = this._static.get(p.surface);
        if (!a) this._static.set(p.surface, (a = new Accum(`${this.name}:${p.surface}`)));
        for (let i = 0; i < e.m.length; i++) {
          a.add(p.geo, e.m[i], [e.c[i * 3], e.c[i * 3 + 1], e.c[i * 3 + 2]]);
        }
        continue;
      }
      const n = e.m.length;
      const mesh = new THREE.InstancedMesh(p.geo, lib.matFor(p.surface), n);
      mesh.name = `${this.name}:${id}`;
      for (let i = 0; i < n; i++) mesh.setMatrixAt(i, e.m[i]);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(e.c), 3);
      mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = p.castShadow;
      mesh.receiveShadow = p.receiveShadow;
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      if (p.noShadow) mesh.userData.owNoShadow = true;
      if (p.noPrepass || NO_PREPASS_SURFACES.has(p.surface)) mesh.userData.owNoPrepass = true;
      if (p.renderOrder) mesh.renderOrder = p.renderOrder;
      mesh.computeBoundingSphere();
      hostFor(p.surface).add(mesh);
      out.push(mesh);
      this.stats.instances += n;
      this.stats.instTris += n * p.tris;
      this.stats.draws++;
    }

    for (const [surface, a] of this._static) {
      if (a.empty) continue;
      const geo = a.build();
      const isEm = lib.isEmissive(surface);
      const mesh = new THREE.Mesh(geo, lib.matFor(surface));
      mesh.name = `${this.name}:${surface}`;
      mesh.castShadow = !isEm;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = true;
      // small instance groups land here instead — same rule, same reason
      if (NO_PREPASS_SURFACES.has(surface)) mesh.userData.owNoPrepass = true;
      if (isEm && EMISSIVE[surface]?.additive) {
        mesh.userData.owNoShadow = true;
        mesh.userData.owNoPrepass = true;
        mesh.renderOrder = 3;
      }
      if (surface === 'oil' || surface === 'decal_paint' || surface === 'decal_yellow') {
        mesh.renderOrder = 2;
        mesh.userData.owNoShadow = true;
        mesh.userData.owNoPrepass = true;
      }
      hostFor(surface).add(mesh);
      out.push(mesh);
      this.stats.tris += a.tris;
      this.stats.draws++;
    }

    const cols = [];
    for (const [tag, a] of this._collide) {
      if (a.empty) continue;
      const geo = a.build();
      const mesh = new THREE.Mesh(geo, INVISIBLE);
      mesh.name = `${this.name}:col:${tag}`;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      mesh.userData.surface = tag;
      cols.push({ mesh, tag });
    }

    this._static.clear();
    this._inst.clear();
    this._collide.clear();
    return { meshes: out, colliders: cols, lod, lamps: this.lamps, stats: this.stats };
  }
}

/** Free everything a built tile owns. Prototype geometry is shared — untouched. */
export function releaseTile(tile) {
  for (const m of tile.meshes ?? []) {
    if (m.isInstancedMesh) {
      m.dispose();
      m.instanceColor = null;
    } else {
      m.geometry?.dispose();
    }
    m.parent?.remove(m);
  }
  for (const c of tile.colliders ?? []) {
    c.mesh.geometry?.dispose();
    c.mesh.parent?.remove(c.mesh);
  }
  tile.meshes = null;
  tile.colliders = null;
}

export { SURFACE_TAG, MERGE_BELOW };
