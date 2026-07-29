/**
 * Static world: triangle soup + a TWO-LEVEL binned-SAH BVH.
 *
 * `world` registers meshes through PhysicsSystem.addStatic(); they are baked
 * into world space once, copied into flat typed arrays, and a BVH is kept over
 * the result. Nothing here allocates after build() — queries run on preallocated
 * stacks and write into caller-supplied records.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT IS TWO LEVELS: THE 139 ms FREEZE
 * ────────────────────────────────────────────────────────────────────────────
 * This used to be one flat tree over every triangle in the world, rebuilt from
 * scratch whenever ANY object changed. The city streams, so something changes
 * constantly, and a streamed 4 000-triangle road sector bought a full rebuild
 * of all 329 000. Measured at tier `low`: standing still, 31 rebuilds in 18.1 s
 * — one every 0.58 s, median 139 ms, max 201 ms — and 6-8 of the ten worst
 * hitches in every run were this. Driving: 80 rebuilds, 12.8 s of stall.
 *
 * A global rebuild for a local change is the mistake. So:
 *
 *   BLAS  one subtree per registered object, over that object's own triangles,
 *         built ONCE when the object is registered and never touched again.
 *   TLAS  a small tree over the object bounding boxes, rebuilt whenever the
 *         object SET changes. A few hundred boxes, well under a millisecond.
 *
 * The two levels live in ONE node array and the TLAS leaves are *spliced* — a
 * TLAS leaf copies its object's BLAS root meta, so the joint is invisible to a
 * traversal. Query code is therefore identical to the flat version apart from
 * starting at `rootNode` instead of node 0.
 *
 * The third case is a mesh whose geometry is rewritten in place — `world`'s
 * terrain collision patch does this every 48 m of camera movement, 12 800
 * triangles, via removeStatic() + addStatic() of the SAME THREE.Mesh. That is
 * detected here and answered with a bottom-up REFIT of the existing subtree
 * (bounds only, no re-split, no SAH), which is ~20x cheaper than rebuilding it
 * and loses no quality because the tree is the same combinatorial partition of
 * a translated grid.
 *
 * `?owbvh=flat` (or OW_BVH=flat in node) restores the old single-tree,
 * full-rebuild behaviour, so the fix can be un-applied and measured. See
 * `src/physics/colbench.mjs`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Layout
 *   pos      Float32Array, 9 floats per triangle SLOT (a.xyz b.xyz c.xyz)
 *   nrm      Float32Array, 3 floats per slot (unit geometric normal)
 *   surface  Uint8Array,   surface enum index per slot
 *   mask     Uint16Array,  collision layer bits per slot
 *   object   Int32Array,   owner object id per slot
 *
 * Triangle slots are allocated to objects in contiguous runs out of an arena
 * with a free list, so a slot index is stable for as long as its object lives
 * and `out.tri` / `contacts.tri` / `candidates` keep meaning what they meant.
 *
 * Nodes
 *   nodeBounds Float32Array, 6 per node
 *   nodeMeta   Int32Array,   2 per node — [leftFirst, count]
 *                            count > 0 : leaf, triIndex[leftFirst .. +count)
 *                            count = 0 : interior, children at leftFirst, +1
 *   rootNode                 where a traversal starts (NOT necessarily 0)
 */

import * as THREE from 'three';
import {
  rayAabb,
  rayTriangle,
  segTriangleClosest,
  makeClosest,
  EPS,
} from './math.js';
import { surfaceIndex, guessSurface, LAYER } from './surfaces.js';

const BINS = 12;
const LEAF_SIZE = 6;
const TRAV_COST = 1.0;
const TRI_COST = 1.35;
/** Conservative-advancement tolerance, metres. */
const CA_TOL = 1e-4;
const CA_ITERS = 48;

/**
 * How many times a subtree may be refitted in place before it is rebuilt.
 * A refit keeps the split planes of the geometry it was built for; a patch that
 * has slid a kilometre has drifted far enough that the SAH would choose
 * differently, so one real build is paid occasionally to stop quality decaying.
 */
const REFIT_LIMIT = 24;

/**
 * Compact (one full rebuild) when the arena high-water mark exceeds this much
 * more than the live triangle count. Fragmentation only reaches here if the
 * streamer's object sizes vary wildly; instrumented as `compactions` so a run
 * that never trips it can prove it.
 */
const COMPACT_SLACK = 1 << 17;

/**
 * Largest triangle run that gets a single subtree.
 *
 * `world` registers a road-collision sector as ONE mesh of 15 000 to 29 000
 * triangles, so "one object, one subtree" still meant a 10-30 ms build landing
 * whole on one frame. Chunking to this size makes the build interruptible: a
 * part is ~2 ms, the budget can stop between parts, and nothing is published
 * until every part of an object is in.
 */
const MAX_PART = 4096;

/** Shared immutable stand-in so an unbuilt object allocates no array. */
const EMPTY_PARTS = [];

function makePart(slot, count) {
  return { slot, count, nodeBlock: -1, nodeUsed: 0, root: -1, depth: 0 };
}

const _m4 = new THREE.Matrix4();

/**
 * The pre-fix single-tree path, for A/B. Three ways in, because the arm has to
 * be selectable from wherever the measurement is being taken:
 *   ?owbvh=flat        a browser URL (tools that take a --query)
 *   OW_BVH=flat        node, for selftest.js and colprobe.mjs
 *   VITE_OW_BVH=flat   the environment, so a tool with NO query hook — such as
 *                      `tools/playprobe.mjs` — can still be run on both arms
 */
const FLAT = (() => {
  try {
    if (typeof location !== 'undefined' && typeof location.search === 'string') {
      if (new URLSearchParams(location.search).get('owbvh') === 'flat') return true;
    }
  } catch { /* not a browser */ }
  try {
    if (import.meta.env && import.meta.env.VITE_OW_BVH === 'flat') return true;
  } catch { /* not a vite build */ }
  try {
    if (typeof process !== 'undefined' && process.env && process.env.OW_BVH === 'flat') return true;
  } catch { /* not node */ }
  return false;
})();

/* ------------------------------------------------------------------ */
/* Range arena — contiguous runs with a coalescing free list            */
/* ------------------------------------------------------------------ */

/**
 * Hands out contiguous [start, start+count) runs out of a linear space.
 * Best fit, so a dropped 4 000-triangle road sector is reused by the next one
 * instead of growing the arena forever. No allocation per call: the free list
 * is two Int32Arrays that only ever grow.
 */
class RangeArena {
  constructor() {
    this.cap = 0;
    this.top = 0;
    this.freeTotal = 0;
    this._s = new Int32Array(64);
    this._c = new Int32Array(64);
    this.n = 0;
  }

  reset() {
    this.top = 0;
    this.n = 0;
    this.freeTotal = 0;
  }

  get used() {
    return this.top - this.freeTotal;
  }

  /** Returns the run start, or -1 when the arena must grow first. */
  alloc(count) {
    if (count <= 0) return 0;
    let best = -1;
    let bestC = 0x7fffffff;
    for (let i = 0; i < this.n; i++) {
      const c = this._c[i];
      if (c >= count && c < bestC) {
        best = i;
        bestC = c;
        if (c === count) break;
      }
    }
    if (best >= 0) {
      const s = this._s[best];
      if (bestC === count) this._erase(best);
      else {
        this._s[best] = s + count;
        this._c[best] = bestC - count;
      }
      this.freeTotal -= count;
      return s;
    }
    if (this.top + count <= this.cap) {
      const s = this.top;
      this.top += count;
      return s;
    }
    return -1;
  }

  free(start, count) {
    if (count <= 0) return;
    if (start + count === this.top) {
      // Abuts the high-water mark: give it straight back, then absorb any
      // free block that has just become trailing.
      this.top = start;
      while (this.n > 0 && this._s[this.n - 1] + this._c[this.n - 1] === this.top) {
        this.top = this._s[this.n - 1];
        this.freeTotal -= this._c[this.n - 1];
        this.n--;
      }
      return;
    }
    let i = 0;
    while (i < this.n && this._s[i] < start) i++;
    this._insert(i, start, count);
    this.freeTotal += count;
    if (i + 1 < this.n && this._s[i] + this._c[i] === this._s[i + 1]) {
      this._c[i] += this._c[i + 1];
      this._erase(i + 1);
    }
    if (i > 0 && this._s[i - 1] + this._c[i - 1] === this._s[i]) {
      this._c[i - 1] += this._c[i];
      this._erase(i);
      i--;
    }
    if (this._s[i] + this._c[i] === this.top) {
      this.top = this._s[i];
      this.freeTotal -= this._c[i];
      this._erase(i);
    }
  }

  _insert(i, s, c) {
    if (this.n >= this._s.length) {
      const ns = new Int32Array(this._s.length * 2);
      ns.set(this._s);
      this._s = ns;
      const nc = new Int32Array(this._c.length * 2);
      nc.set(this._c);
      this._c = nc;
    }
    this._s.copyWithin(i + 1, i, this.n);
    this._c.copyWithin(i + 1, i, this.n);
    this._s[i] = s;
    this._c[i] = c;
    this.n++;
  }

  _erase(i) {
    this._s.copyWithin(i, i + 1, this.n);
    this._c.copyWithin(i, i + 1, this.n);
    this.n--;
  }
}

/* ------------------------------------------------------------------ */
/* Shared binned-SAH builder                                           */
/* ------------------------------------------------------------------ */

const _binCount = new Int32Array(BINS);
const _binB = new Float32Array(BINS * 6);
const _leftArea = new Float32Array(BINS);
const _leftCnt = new Int32Array(BINS);
let _bstack = new Int32Array(3 * 4096);
const _buildOut = { nodes: 0, depth: 0 };

function boundsFromRange(outB, node, idx, aabb, start, count) {
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = start; i < start + count; i++) {
    const b = idx[i] * 6;
    if (aabb[b] < mnx) mnx = aabb[b];
    if (aabb[b + 1] < mny) mny = aabb[b + 1];
    if (aabb[b + 2] < mnz) mnz = aabb[b + 2];
    if (aabb[b + 3] > mxx) mxx = aabb[b + 3];
    if (aabb[b + 4] > mxy) mxy = aabb[b + 4];
    if (aabb[b + 5] > mxz) mxz = aabb[b + 5];
  }
  // Float32 storage can round a bound inwards; pad by a hair so a primitive
  // that actually straddles the plane is never rejected.
  const p = 1e-5;
  const o = node * 6;
  outB[o] = mnx - p;
  outB[o + 1] = mny - p;
  outB[o + 2] = mnz - p;
  outB[o + 3] = mxx + p;
  outB[o + 4] = mxy + p;
  outB[o + 5] = mxz + p;
}

/**
 * Binned-SAH BVH over `idx[start .. start+count)`, written 0-based into
 * `outB` / `outM` (which must hold at least 2*count+8 nodes). `idx` is
 * permuted in place, only within that range.
 *
 * `forceSplit` is the TLAS mode: keep splitting until every leaf holds exactly
 * one primitive, falling back to a median split when the SAH declines or the
 * centroids are degenerate. The TLAS splice depends on that guarantee.
 *
 * Returns the shared `_buildOut` — read it before calling again.
 */
function buildBvhInto(idx, aabb, cent, start, count, outB, outM, leafSize, forceSplit) {
  let nodeCount = 1;
  outM[0] = start;
  outM[1] = count;
  boundsFromRange(outB, 0, idx, aabb, start, count);

  const need = 4 * (2 * Math.ceil(count / Math.max(1, leafSize)) + 64);
  if (_bstack.length < need) _bstack = new Int32Array(need);
  const stack = _bstack;
  let sp = 0;
  stack[sp++] = 0; stack[sp++] = start; stack[sp++] = count; stack[sp++] = 0;

  let maxDepth = 0;
  const depthCap = forceSplit ? 32 : 60;

  while (sp > 0) {
    const depth = stack[--sp];
    const cnt = stack[--sp];
    const st = stack[--sp];
    const node = stack[--sp];
    if (depth > maxDepth) maxDepth = depth;
    if (cnt <= leafSize) continue;

    let splitAt = -1;
    if (depth <= depthCap) {
      // centroid bounds
      let cminx = Infinity, cminy = Infinity, cminz = Infinity;
      let cmaxx = -Infinity, cmaxy = -Infinity, cmaxz = -Infinity;
      for (let i = st; i < st + cnt; i++) {
        const t = idx[i] * 3;
        const x = cent[t], y = cent[t + 1], z = cent[t + 2];
        if (x < cminx) cminx = x; if (x > cmaxx) cmaxx = x;
        if (y < cminy) cminy = y; if (y > cmaxy) cmaxy = y;
        if (z < cminz) cminz = z; if (z > cmaxz) cmaxz = z;
      }
      const ex = cmaxx - cminx, ey = cmaxy - cminy, ez = cmaxz - cminz;
      let axis = 0, extent = ex, cmin = cminx;
      if (ey > extent) { axis = 1; extent = ey; cmin = cminy; }
      if (ez > extent) { axis = 2; extent = ez; cmin = cminz; }

      if (extent >= 1e-7) {
        const scale = BINS / extent;
        _binCount.fill(0);
        for (let b = 0; b < BINS; b++) {
          const o = b * 6;
          _binB[o] = _binB[o + 1] = _binB[o + 2] = Infinity;
          _binB[o + 3] = _binB[o + 4] = _binB[o + 5] = -Infinity;
        }
        for (let i = st; i < st + cnt; i++) {
          const prim = idx[i];
          let b = ((cent[prim * 3 + axis] - cmin) * scale) | 0;
          if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
          _binCount[b]++;
          const o = b * 6, tb = prim * 6;
          if (aabb[tb] < _binB[o]) _binB[o] = aabb[tb];
          if (aabb[tb + 1] < _binB[o + 1]) _binB[o + 1] = aabb[tb + 1];
          if (aabb[tb + 2] < _binB[o + 2]) _binB[o + 2] = aabb[tb + 2];
          if (aabb[tb + 3] > _binB[o + 3]) _binB[o + 3] = aabb[tb + 3];
          if (aabb[tb + 4] > _binB[o + 4]) _binB[o + 4] = aabb[tb + 4];
          if (aabb[tb + 5] > _binB[o + 5]) _binB[o + 5] = aabb[tb + 5];
        }

        // sweep left
        let axmin = Infinity, aymin = Infinity, azmin = Infinity;
        let axmax = -Infinity, aymax = -Infinity, azmax = -Infinity;
        let acc = 0;
        for (let b = 0; b < BINS - 1; b++) {
          const o = b * 6;
          if (_binCount[b] > 0) {
            if (_binB[o] < axmin) axmin = _binB[o];
            if (_binB[o + 1] < aymin) aymin = _binB[o + 1];
            if (_binB[o + 2] < azmin) azmin = _binB[o + 2];
            if (_binB[o + 3] > axmax) axmax = _binB[o + 3];
            if (_binB[o + 4] > aymax) aymax = _binB[o + 4];
            if (_binB[o + 5] > azmax) azmax = _binB[o + 5];
          }
          acc += _binCount[b];
          _leftCnt[b] = acc;
          _leftArea[b] = acc > 0 ? surfaceArea(axmin, aymin, azmin, axmax, aymax, azmax) : 0;
        }
        // sweep right + pick
        axmin = aymin = azmin = Infinity;
        axmax = aymax = azmax = -Infinity;
        let rAcc = 0;
        // Cost of making this a leaf. In TLAS mode a leaf is not an option
        // below, so start from +inf and take the best split there is.
        let bestCost = forceSplit ? Infinity : TRI_COST * cnt;
        let bestSplit = -1;
        const nb = node * 6;
        const parentArea = surfaceArea(
          outB[nb], outB[nb + 1], outB[nb + 2],
          outB[nb + 3], outB[nb + 4], outB[nb + 5]
        );
        const invParent = parentArea > 0 ? 1 / parentArea : 0;
        for (let b = BINS - 1; b > 0; b--) {
          const o = b * 6;
          if (_binCount[b] > 0) {
            if (_binB[o] < axmin) axmin = _binB[o];
            if (_binB[o + 1] < aymin) aymin = _binB[o + 1];
            if (_binB[o + 2] < azmin) azmin = _binB[o + 2];
            if (_binB[o + 3] > axmax) axmax = _binB[o + 3];
            if (_binB[o + 4] > aymax) aymax = _binB[o + 4];
            if (_binB[o + 5] > azmax) azmax = _binB[o + 5];
          }
          rAcc += _binCount[b];
          const lc = _leftCnt[b - 1];
          if (lc === 0 || rAcc === 0) continue;
          const rArea = surfaceArea(axmin, aymin, azmin, axmax, aymax, azmax);
          const cost = TRAV_COST + TRI_COST * invParent * (_leftArea[b - 1] * lc + rArea * rAcc);
          if (cost < bestCost) {
            bestCost = cost;
            bestSplit = b;
          }
        }

        if (bestSplit >= 0) {
          const splitPos = cmin + extent * (bestSplit / BINS);
          let i = st, j = st + cnt - 1;
          while (i <= j) {
            const prim = idx[i];
            if (cent[prim * 3 + axis] < splitPos) i++;
            else { idx[i] = idx[j]; idx[j] = prim; j--; }
          }
          const leftCount = i - st;
          if (leftCount > 0 && leftCount < cnt) splitAt = i;
        }
      }
    }

    if (splitAt < 0) {
      // No usable split. A BLAS is happy to stop here; the TLAS must not, or a
      // leaf would hold two objects and the splice below would drop one.
      if (!forceSplit) continue;
      splitAt = st + (cnt >> 1);
    }

    const leftCount = splitAt - st;
    const l = nodeCount;
    nodeCount += 2;
    outM[node * 2] = l;
    outM[node * 2 + 1] = 0;
    outM[l * 2] = st; outM[l * 2 + 1] = leftCount;
    outM[(l + 1) * 2] = splitAt; outM[(l + 1) * 2 + 1] = cnt - leftCount;
    boundsFromRange(outB, l, idx, aabb, st, leftCount);
    boundsFromRange(outB, l + 1, idx, aabb, splitAt, cnt - leftCount);

    stack[sp++] = l; stack[sp++] = st; stack[sp++] = leftCount; stack[sp++] = depth + 1;
    stack[sp++] = l + 1; stack[sp++] = splitAt; stack[sp++] = cnt - leftCount; stack[sp++] = depth + 1;
  }

  _buildOut.nodes = nodeCount;
  _buildOut.depth = maxDepth;
  return _buildOut;
}

/* ------------------------------------------------------------------ */

export class StaticWorld {
  constructor() {
    this.objects = []; // { id, name, mesh, surface, mask, tris, triCount, alive, slot, ... }
    this._freeIds = [];
    /** Object ids registered but not yet resident in the arena. */
    this._pending = [];
    /** Removed object records whose arena runs are freed on the next build(). */
    this._dead = [];
    /** mesh -> index in `_dead`, reused (cleared) once per build. */
    this._twinIndex = new Map();

    this.triCount = 0;
    this.pos = new Float32Array(0);
    this.nrm = new Float32Array(0);
    this.surface = new Uint8Array(0);
    this.mask = new Uint16Array(0);
    this.object = new Int32Array(0);

    this.triIndex = new Uint32Array(0);
    this.nodeBounds = new Float32Array(0);
    this.nodeMeta = new Int32Array(0);
    /** Where a traversal starts. NOT necessarily 0 — see the TLAS. */
    this.rootNode = -1;
    this.nodeCount = 0;
    this.maxDepth = 0;

    this._tri = new RangeArena();
    this._node = new RangeArena();
    this._tlasBlock = -1;
    this._tlasUsed = 0;

    this.dirty = false;
    this.buildMs = 0;
    this.version = 0;
    /** Live objects / subtrees actually published, for stats. */
    this.objectCount = 0;
    this.partCount = 0;
    /**
     * Per-call ceiling on NEW-object work, milliseconds. 0 disables it.
     * `physics` sets it from `q.tileBuildBudgetMs`. Re-registrations (the
     * terrain patch sliding) and a world with no collision at all are never
     * budgeted — see `_buildIncremental`.
     */
    this.budgetMs = 0;
    /** Objects the last budgeted build left for the next one. */
    this.deferred = 0;
    /** True when the old flat single-tree path is in force (A/B hatch). */
    this.flat = FLAT;

    // scratch
    this._cent = new Float32Array(0);
    this._taabb = new Float32Array(0);
    this._stackNode = new Int32Array(128);
    this._stackT = new Float32Array(128);
    this._sbB = new Float32Array(0);
    this._sbM = new Int32Array(0);
    this._objList = [];
    this._objIndex = new Uint32Array(0);
    this._objAabb = new Float32Array(0);
    this._objCent = new Float32Array(0);
    this._chunkStack = new Int32Array(256);
    this._cl = makeClosest();
    this._cl2 = makeClosest();
    this._cand = new Int32Array(4096);
    this._candCount = 0;

    // shared contact buffer for overlap queries
    this.contacts = {
      count: 0,
      capacity: 256,
      nx: new Float32Array(256),
      ny: new Float32Array(256),
      nz: new Float32Array(256),
      px: new Float32Array(256),
      py: new Float32Array(256),
      pz: new Float32Array(256),
      depth: new Float32Array(256),
      /** Parameter along the query segment where the contact sits, 0..1. */
      s: new Float32Array(256),
      tri: new Int32Array(256),
    };

    this.aabb = { minx: 0, miny: 0, minz: 0, maxx: 0, maxy: 0, maxz: 0 };
    this.stats = { rayTests: 0, nodeTests: 0, triTests: 0 };
    /**
     * Build accounting. `builtTris + refitTris` is the load-independent number
     * to compare arms with: triangles the BVH actually processed. The flat path
     * pays `triCount` on EVERY build; this one pays only what changed.
     */
    this.buildStats = {
      builds: 0, skipped: 0, blasBuilds: 0, refits: 0, tlasBuilds: 0,
      builtTris: 0, refitTris: 0, compactions: 0, grows: 0, lastTris: 0,
      deferrals: 0,
    };
    /**
     * Places where a query quietly returns an INCOMPLETE answer. Both of these
     * used to be bare `break`s with a comment asserting they never happen; an
     * assertion nobody counts is not evidence. A dropped contact is how a car
     * ends up resting on the wrong surface, and an abandoned traversal is how a
     * sweep misses a wall — neither would raise anything anywhere.
     */
    this.truncations = { contacts: 0, traversal: 0, tlas: 0 };
    this._truncLogged = { contacts: false, traversal: false, tlas: false };
  }

  /* ---------------------------------------------------------------- */
  /* Registration                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Bake a mesh (or InstancedMesh) into world-space triangles.
   * Returns the object id, or -1 if the mesh had no usable geometry.
   */
  addMesh(mesh, surface, mask = LAYER.STATIC, opts = {}) {
    if (!mesh) return -1;
    const baked = bakeMesh(mesh, surface, opts);
    if (!baked || baked.count === 0) return -1;

    const id = this._freeIds.length ? this._freeIds.pop() : this.objects.length;
    this.objects[id] = this._makeObject(id, {
      name: mesh.name || mesh.type,
      mesh,
      surface: baked.uniformSurface,
      surfaces: baked.surfaces,
      mask,
      tris: baked.pos,
      triCount: baked.count,
      userData: opts.userData ?? null,
    });
    this._pending.push(id);
    this.dirty = true;
    return id;
  }

  /** Register raw world-space triangles (Float32Array, 9 floats each). */
  addTriangles(positions, count, surface, mask = LAYER.STATIC, name = 'raw') {
    const id = this._freeIds.length ? this._freeIds.pop() : this.objects.length;
    const s = surfaceIndex(surface);
    const surfaces = new Uint8Array(count);
    surfaces.fill(s);
    this.objects[id] = this._makeObject(id, {
      name, mesh: null, surface: s, surfaces, mask,
      tris: positions, triCount: count, userData: null,
    });
    this._pending.push(id);
    this.dirty = true;
    return id;
  }

  _makeObject(id, o) {
    return {
      id,
      name: o.name,
      mesh: o.mesh,
      surface: o.surface,
      surfaces: o.surfaces,
      mask: o.mask,
      tris: o.tris,
      triCount: o.triCount,
      alive: true,
      userData: o.userData,
      /** Arena residency. -1 until the next build() makes it collidable. */
      slot: -1,
      /** Sub-runs of [slot, slot+triCount), each with its own subtree. */
      parts: EMPTY_PARTS,
      built: 0,
      /** Only a fully built object is published into the TLAS. */
      ready: false,
      refits: 0,
      /** Set by build() when this re-registration inherited a live subtree. */
      _adopted: false,
    };
  }

  removeObject(id) {
    const o = this.objects[id];
    if (!o || !o.alive) return false;
    o.alive = false;
    o.tris = null;
    o.surfaces = null;
    this.objects[id] = null;
    // The arena run is NOT freed here: the TLAS still points into it and a
    // query can happen at any moment between now and the next build(). Both
    // the free and the re-publish happen inside build(), which no query can
    // interleave with. The id is recycled there too, so a new object can never
    // inherit an id whose triangles are still being traversed.
    this._dead.push(o);
    this.dirty = true;
    return true;
  }

  findByMesh(mesh) {
    for (let i = 0; i < this.objects.length; i++) {
      const o = this.objects[i];
      if (o && o.alive && o.mesh === mesh) return i;
    }
    return -1;
  }

  /* ---------------------------------------------------------------- */
  /* Build                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Make the tree current. Cheap and idempotent: a call with nothing dirty
   * returns immediately, so N callers marking dirty in one frame produce at
   * most ONE rebuild no matter how many of them ask for it.
   */
  build() {
    if (!this.dirty) {
      this.buildStats.skipped++;
      this.buildMs = 0;
      return;
    }
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    this.buildStats.builds++;
    this.buildStats.lastTris = 0;

    if (this.flat) this._buildFlat();
    else this._buildIncremental(t0);

    // A budgeted build can leave arrivals for the next call. `dirty` stays
    // true until they are all in, which is what makes `props`'s "is a query
    // current" test and `physics`'s drain loop keep working.
    this.deferred = this._pending.length;
    this.dirty = this.deferred > 0;
    this.version++;
    this.buildMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  }

  _buildIncremental(t0) {
    // 1. Claim the subtree of anything being re-registered under the same mesh
    //    (a geometry rewritten in place). Must run before the dead list is
    //    retired, or its arena runs are gone.
    if (this._dead.length && this._pending.length) {
      const byMesh = this._twinIndex;
      byMesh.clear();
      for (let i = 0; i < this._dead.length; i++) {
        const d = this._dead[i];
        if (d.mesh && d.slot >= 0) byMesh.set(d.mesh, i);
      }
      for (let i = 0; i < this._pending.length; i++) {
        const o = this.objects[this._pending[i]];
        if (!o || !o.alive || o.slot >= 0 || !o.mesh) continue;
        const di = byMesh.get(o.mesh);
        if (di === undefined) continue;
        const d = this._dead[di];
        if (!d || d.slot < 0 || d.triCount !== o.triCount) continue;
        byMesh.delete(o.mesh);
        // Take the runs over now, and blank them on the dead record so the
        // retirement pass below cannot free memory this object is now using.
        o.slot = d.slot;
        o.parts = d.parts;
        o.built = d.built;
        o.ready = d.ready;
        o.refits = d.refits + 1;
        o._adopted = true;
        d.slot = -1;
        d.parts = EMPTY_PARTS;
      }
    }

    // 2. Retire what is really gone. Frees arena runs and recycles ids.
    this._retireDead();

    // 3. Re-registrations first, unbudgeted. They are a refit, which is cheap,
    //    and one of them is `world`'s terrain collision patch — the floor under
    //    the player. Deferring that behind a queue of streamed road sectors is
    //    exactly how "spawned and dropped through the world" happens.
    for (let i = 0; i < this._pending.length; i++) {
      const o = this.objects[this._pending[i]];
      if (!o || !o.alive || !o._adopted) continue;
      o._adopted = false;
      this._adopt(o);
    }

    // 4. New arrivals, against the frame budget. Objects are chunked into parts
    //    of at most MAX_PART triangles, so the loop can stop between parts
    //    rather than being stuck inside a 29 000-triangle road sector. A part
    //    is never published on its own: an object joins the tree only when all
    //    of its parts are built, because half a wall is worse than no wall.
    const budget = this.budgetMs;
    const clock = typeof performance !== 'undefined' ? performance : Date;
    let done = 0;
    for (let i = 0; i < this._pending.length; i++, done++) {
      const o = this.objects[this._pending[i]];
      if (!o || !o.alive) continue;
      if (o.ready) continue;
      // Boot has no collision world at all yet; never leave it that way.
      const unlimited = budget <= 0 || this.triCount === 0;
      if (!unlimited && i > 0 && clock.now() - t0 > budget) break;
      if (o.slot < 0) this._residentise(o);
      while (o.built < o.parts.length) {
        this._buildPart(o, o.parts[o.built]);
        o.built++;
        if (!unlimited && clock.now() - t0 > budget) break;
      }
      o.ready = o.built === o.parts.length;
      if (!o.ready) break;
    }
    if (done > 0) this._pending.splice(0, done);
    if (this._pending.length) this.buildStats.deferrals++;

    // 5. Fragmentation backstop. A compaction is a full rebuild — the thing
    //    this file exists to avoid — so it is deliberately hard to reach and it
    //    never runs mid-drain, where it would undo the budget. Never seen to
    //    fire in a play session; counted so that claim stays checkable.
    if (this._pending.length === 0 && this._tri.used > 0 &&
        this._tri.top > 2 * this._tri.used + COMPACT_SLACK) {
      this._compact();
    }

    // 6. Republish: one small tree over the part boxes.
    this._buildTlas();
  }

  _retireDead() {
    for (let i = 0; i < this._dead.length; i++) {
      const d = this._dead[i];
      if (d.slot >= 0) this._tri.free(d.slot, d.triCount);
      for (let p = 0; p < d.parts.length; p++) {
        const part = d.parts[p];
        if (part.nodeBlock >= 0) this._freeNodes(part.nodeBlock, part.nodeUsed);
      }
      d.slot = -1;
      d.parts = EMPTY_PARTS;
      this._freeIds.push(d.id);
    }
    this._dead.length = 0;
  }

  /** Allocate triangle slots, bake the per-triangle data, chunk into parts. */
  _residentise(o) {
    const n = o.triCount;
    let slot = this._tri.alloc(n);
    if (slot < 0) {
      this._growTri(n);
      slot = this._tri.alloc(n);
    }
    o.slot = slot;
    o.refits = 0;
    o.built = 0;
    o.ready = false;
    this._writeTris(o, true);
    this._chunk(o);
  }

  /**
   * Same mesh, same triangle count, new vertex positions — `world`'s terrain
   * collision patch sliding with the camera. Keep the slots AND the split
   * planes, and only recompute bounds bottom-up. O(n) with no sorting, and
   * no quality lost: a translated grid is the same combinatorial partition.
   */
  _adopt(o) {
    this._writeTris(o, false); // keep the existing triIndex permutation
    if (o.refits > REFIT_LIMIT || !o.ready) {
      // Enough drift that the SAH would choose differently. Pay one real build.
      for (let p = 0; p < o.parts.length; p++) {
        const part = o.parts[p];
        if (part.nodeBlock >= 0) this._freeNodes(part.nodeBlock, part.nodeUsed);
      }
      o.refits = 0;
      o.built = 0;
      o.ready = false;
      for (let i = 0; i < o.triCount; i++) this.triIndex[o.slot + i] = o.slot + i;
      this._chunk(o);
      while (o.built < o.parts.length) this._buildPart(o, o.parts[o.built++]);
      o.ready = true;
      return;
    }
    for (let p = 0; p < o.parts.length; p++) this._refitPart(o.parts[p]);
    this.buildStats.refits++;
    this.buildStats.refitTris += o.triCount;
    this.buildStats.lastTris += o.triCount;
  }

  /**
   * Split an object's triangle run into spatially coherent parts of at most
   * MAX_PART triangles, by repeated median splits on the longest centroid axis.
   * Three passes over the range for a 30k-triangle sector — a fraction of what
   * the SAH build of even one of the resulting parts costs — and it is what
   * makes the build interruptible at all.
   */
  _chunk(o) {
    const parts = o.parts === EMPTY_PARTS ? (o.parts = []) : o.parts;
    parts.length = 0;
    if (o.triCount <= MAX_PART) {
      parts.push(makePart(o.slot, o.triCount));
      return;
    }
    const idx = this.triIndex;
    const cent = this._cent;
    let stack = this._chunkStack;
    let sp = 0;
    stack[sp++] = o.slot; stack[sp++] = o.triCount;
    while (sp > 0) {
      const count = stack[--sp];
      const start = stack[--sp];
      if (count <= MAX_PART) {
        parts.push(makePart(start, count));
        continue;
      }
      let cminx = Infinity, cminy = Infinity, cminz = Infinity;
      let cmaxx = -Infinity, cmaxy = -Infinity, cmaxz = -Infinity;
      for (let i = start; i < start + count; i++) {
        const t = idx[i] * 3;
        const x = cent[t], y = cent[t + 1], z = cent[t + 2];
        if (x < cminx) cminx = x; if (x > cmaxx) cmaxx = x;
        if (y < cminy) cminy = y; if (y > cmaxy) cmaxy = y;
        if (z < cminz) cminz = z; if (z > cmaxz) cmaxz = z;
      }
      const ex = cmaxx - cminx, ey = cmaxy - cminy, ez = cmaxz - cminz;
      let axis = 0, mid = (cminx + cmaxx) * 0.5, extent = ex;
      if (ey > extent) { axis = 1; mid = (cminy + cmaxy) * 0.5; extent = ey; }
      if (ez > extent) { axis = 2; mid = (cminz + cmaxz) * 0.5; extent = ez; }
      let left = count >> 1;
      if (extent >= 1e-7) {
        let i = start, j = start + count - 1;
        while (i <= j) {
          const tri = idx[i];
          if (cent[tri * 3 + axis] < mid) i++;
          else { idx[i] = idx[j]; idx[j] = tri; j--; }
        }
        const n = i - start;
        // A degenerate split would loop forever; halve by index instead.
        if (n > 0 && n < count) left = n;
      }
      if (sp + 4 > stack.length) {
        const bigger = new Int32Array(stack.length * 2);
        bigger.set(stack);
        this._chunkStack = stack = bigger;
      }
      stack[sp++] = start; stack[sp++] = left;
      stack[sp++] = start + left; stack[sp++] = count - left;
    }
  }

  /** Positions, normals, per-triangle AABB/centroid and the owner tags. */
  _writeTris(o, initIndex) {
    const s = o.slot;
    const n = o.triCount;
    const pos = this.pos;
    const nrm = this.nrm;
    const cent = this._cent;
    const ta = this._taabb;
    pos.set(o.tris.subarray(0, n * 9), s * 9);
    for (let i = 0; i < n; i++) {
      const t = s + i;
      const p = t * 9;
      const ax = pos[p], ay = pos[p + 1], az = pos[p + 2];
      const bx = pos[p + 3], by = pos[p + 4], bz = pos[p + 5];
      const cx = pos[p + 6], cy = pos[p + 7], cz = pos[p + 8];
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz);
      if (l > EPS) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 1; nz = 0; }
      nrm[t * 3] = nx; nrm[t * 3 + 1] = ny; nrm[t * 3 + 2] = nz;

      const mnx = Math.min(ax, bx, cx), mny = Math.min(ay, by, cy), mnz = Math.min(az, bz, cz);
      const mxx = Math.max(ax, bx, cx), mxy = Math.max(ay, by, cy), mxz = Math.max(az, bz, cz);
      const b = t * 6;
      ta[b] = mnx; ta[b + 1] = mny; ta[b + 2] = mnz;
      ta[b + 3] = mxx; ta[b + 4] = mxy; ta[b + 5] = mxz;
      cent[t * 3] = (mnx + mxx) * 0.5;
      cent[t * 3 + 1] = (mny + mxy) * 0.5;
      cent[t * 3 + 2] = (mnz + mxz) * 0.5;

      this.surface[t] = o.surfaces ? o.surfaces[i] : o.surface;
      this.mask[t] = o.mask;
      this.object[t] = o.id;
      if (initIndex) this.triIndex[t] = t;
    }
  }

  /** One part's SAH subtree, relocated into a right-sized node-arena block. */
  _buildPart(o, part) {
    const n = part.count;
    this._ensureScratch(n);
    const r = buildBvhInto(
      this.triIndex, this._taabb, this._cent, part.slot, n,
      this._sbB, this._sbM, LEAF_SIZE, false
    );
    const used = r.nodes;
    const depth = r.depth;
    let blk = this._node.alloc(used);
    if (blk < 0) {
      this._growNodes(used);
      blk = this._node.alloc(used);
    }
    const nb = this.nodeBounds, meta = this.nodeMeta;
    const sb = this._sbB, sm = this._sbM;
    for (let i = 0; i < used; i++) {
      const src = i * 6, dst = (blk + i) * 6;
      nb[dst] = sb[src];
      nb[dst + 1] = sb[src + 1];
      nb[dst + 2] = sb[src + 2];
      nb[dst + 3] = sb[src + 3];
      nb[dst + 4] = sb[src + 4];
      nb[dst + 5] = sb[src + 5];
      const c = sm[i * 2 + 1];
      const m = (blk + i) * 2;
      meta[m + 1] = c;
      // Leaf `first` is an absolute triIndex position and is already global;
      // an interior `leftFirst` is a node id and has to be relocated.
      meta[m] = c > 0 ? sm[i * 2] : sm[i * 2] + blk;
    }
    part.nodeBlock = blk;
    part.nodeUsed = used;
    part.root = blk;
    part.depth = depth;
    this.buildStats.blasBuilds++;
    this.buildStats.builtTris += n;
    this.buildStats.lastTris += n;
  }

  /**
   * Bottom-up bounds refresh over an existing subtree. Node ids inside a block
   * are allocated parent-before-children, so a descending sweep always sees a
   * child before the parent that unions it.
   */
  _refitPart(part) {
    const nb = this.nodeBounds;
    const meta = this.nodeMeta;
    const idx = this.triIndex;
    const ta = this._taabb;
    for (let i = part.nodeBlock + part.nodeUsed - 1; i >= part.nodeBlock; i--) {
      const c = meta[i * 2 + 1];
      if (c > 0) {
        boundsFromRange(nb, i, idx, ta, meta[i * 2], c);
        continue;
      }
      const l = meta[i * 2];
      const lo = l * 6, ro = (l + 1) * 6, dst = i * 6;
      nb[dst] = Math.min(nb[lo], nb[ro]);
      nb[dst + 1] = Math.min(nb[lo + 1], nb[ro + 1]);
      nb[dst + 2] = Math.min(nb[lo + 2], nb[ro + 2]);
      nb[dst + 3] = Math.max(nb[lo + 3], nb[ro + 3]);
      nb[dst + 4] = Math.max(nb[lo + 4], nb[ro + 4]);
      nb[dst + 5] = Math.max(nb[lo + 5], nb[ro + 5]);
    }
  }

  /**
   * The top level: a tree over the PART boxes whose leaves are SPLICED — each
   * leaf takes on its part's subtree root meta, so a traversal walks straight
   * through the joint and every query below is unchanged.
   */
  _buildTlas() {
    if (this._tlasBlock >= 0) {
      this._freeNodes(this._tlasBlock, this._tlasUsed);
      this._tlasBlock = -1;
      this._tlasUsed = 0;
    }
    const list = this._objList;
    list.length = 0;
    let tris = 0, maxD = 0, liveNodes = 0, objects = 0;
    for (let i = 0; i < this.objects.length; i++) {
      const o = this.objects[i];
      // A partially built object is NOT published: half a wall is worse than
      // no wall, and the next build finishes it.
      if (!o || !o.alive || o.slot < 0 || !o.ready) continue;
      objects++;
      tris += o.triCount;
      for (let p = 0; p < o.parts.length; p++) {
        const part = o.parts[p];
        list.push(part);
        liveNodes += part.nodeUsed;
        if (part.depth > maxD) maxD = part.depth;
      }
    }
    this.triCount = tris;
    this.objectCount = objects;
    this.partCount = list.length;
    const N = list.length;
    if (N === 0) {
      this.rootNode = -1;
      this.nodeCount = 0;
      this.maxDepth = 0;
      this.aabb.minx = this.aabb.miny = this.aabb.minz = 0;
      this.aabb.maxx = this.aabb.maxy = this.aabb.maxz = 0;
      return;
    }

    if (this._objIndex.length < N) {
      const cap = N * 2;
      this._objIndex = new Uint32Array(cap);
      this._objAabb = new Float32Array(cap * 6);
      this._objCent = new Float32Array(cap * 3);
    }
    const oa = this._objAabb, oc = this._objCent, oi = this._objIndex;
    const nb = this.nodeBounds;
    for (let i = 0; i < N; i++) {
      const r = list[i].root * 6;
      const b = i * 6;
      oa[b] = nb[r]; oa[b + 1] = nb[r + 1]; oa[b + 2] = nb[r + 2];
      oa[b + 3] = nb[r + 3]; oa[b + 4] = nb[r + 4]; oa[b + 5] = nb[r + 5];
      oc[i * 3] = (oa[b] + oa[b + 3]) * 0.5;
      oc[i * 3 + 1] = (oa[b + 1] + oa[b + 4]) * 0.5;
      oc[i * 3 + 2] = (oa[b + 2] + oa[b + 5]) * 0.5;
      oi[i] = i;
    }

    this._ensureScratch(N);
    const res = buildBvhInto(oi, oa, oc, 0, N, this._sbB, this._sbM, 1, true);
    const used = res.nodes;
    let blk = this._node.alloc(used);
    if (blk < 0) {
      this._growNodes(used);
      blk = this._node.alloc(used);
    }
    // `_growNodes` may have swapped the arrays out from underneath.
    const NB = this.nodeBounds, MT = this.nodeMeta;
    const sb = this._sbB, sm = this._sbM;
    for (let i = 0; i < used; i++) {
      const src = i * 6, dst = (blk + i) * 6;
      NB[dst] = sb[src];
      NB[dst + 1] = sb[src + 1];
      NB[dst + 2] = sb[src + 2];
      NB[dst + 3] = sb[src + 3];
      NB[dst + 4] = sb[src + 4];
      NB[dst + 5] = sb[src + 5];
      const c = sm[i * 2 + 1];
      const m = (blk + i) * 2;
      if (c === 0) {
        MT[m] = sm[i * 2] + blk;
        MT[m + 1] = 0;
        continue;
      }
      // A TLAS leaf. `forceSplit` guarantees exactly one part in it; splice
      // the part's subtree root in so the joint disappears.
      if (c !== 1) {
        this._noteTruncation('tlas', `TLAS leaf holds ${c} parts — only the first would collide`);
      }
      const r2 = list[oi[sm[i * 2]]].root * 2;
      MT[m] = MT[r2];
      MT[m + 1] = MT[r2 + 1];
    }

    this._tlasBlock = blk;
    this._tlasUsed = used;
    this.rootNode = blk;
    this.nodeCount = liveNodes + used;
    this.maxDepth = res.depth + maxD + 1;
    this.buildStats.tlasBuilds++;

    const r = blk * 6;
    this.aabb.minx = NB[r]; this.aabb.miny = NB[r + 1]; this.aabb.minz = NB[r + 2];
    this.aabb.maxx = NB[r + 3]; this.aabb.maxy = NB[r + 4]; this.aabb.maxz = NB[r + 5];

    const needStack = Math.max(64, this.maxDepth * 2 + 8);
    if (this._stackNode.length < needStack) {
      this._stackNode = new Int32Array(needStack);
      this._stackT = new Float32Array(needStack);
    }
  }

  /**
   * The pre-fix path, kept so the fix can be un-applied: one tree over every
   * triangle in the world, rebuilt from scratch. `?owbvh=flat`.
   */
  _buildFlat() {
    for (let i = 0; i < this._dead.length; i++) this._freeIds.push(this._dead[i].id);
    this._dead.length = 0;
    this._pending.length = 0;

    const list = this._objList;
    list.length = 0;
    let total = 0;
    for (let i = 0; i < this.objects.length; i++) {
      const o = this.objects[i];
      if (!o || !o.alive) continue;
      list.push(o);
      total += o.triCount;
    }
    this.triCount = total;
    this.objectCount = list.length;
    this.partCount = list.length ? 1 : 0;
    this._tri.reset();
    this._node.reset();
    this._tlasBlock = -1;
    this._tlasUsed = 0;
    if (total === 0) {
      this.rootNode = -1;
      this.nodeCount = 0;
      this.maxDepth = 0;
      for (const o of list) { o.slot = -1; o.parts = EMPTY_PARTS; o.ready = false; }
      return;
    }
    this._ensureTriCap(total);
    this._ensureNodeCap(2 * total + 8);

    let w = 0;
    for (const o of list) {
      o.slot = w;
      o.parts = EMPTY_PARTS;
      o.built = 0;
      o.ready = true;
      o.refits = 0;
      this._writeTris(o, true);
      w += o.triCount;
    }
    this._tri.top = total;

    const r = buildBvhInto(
      this.triIndex, this._taabb, this._cent, 0, total,
      this.nodeBounds, this.nodeMeta, LEAF_SIZE, false
    );
    this._node.top = r.nodes;
    this.rootNode = 0;
    this.nodeCount = r.nodes;
    this.maxDepth = r.depth;
    this.buildStats.blasBuilds++;
    this.buildStats.builtTris += total;
    this.buildStats.lastTris = total;

    this.aabb.minx = this.nodeBounds[0]; this.aabb.miny = this.nodeBounds[1];
    this.aabb.minz = this.nodeBounds[2]; this.aabb.maxx = this.nodeBounds[3];
    this.aabb.maxy = this.nodeBounds[4]; this.aabb.maxz = this.nodeBounds[5];

    const needStack = Math.max(64, this.maxDepth * 2 + 8);
    if (this._stackNode.length < needStack) {
      this._stackNode = new Int32Array(needStack);
      this._stackT = new Float32Array(needStack);
    }
  }

  /** Rebuild every subtree into a fresh arena. Only for runaway fragmentation. */
  _compact() {
    const live = [];
    for (let i = 0; i < this.objects.length; i++) {
      const o = this.objects[i];
      if (!o || !o.alive || !o.tris) continue;
      o.slot = -1;
      o.parts = EMPTY_PARTS;
      o.built = 0;
      o.ready = false;
      o.refits = 0;
      live.push(o);
    }
    this._tri.reset();
    this._node.reset();
    this._tlasBlock = -1;
    this._tlasUsed = 0;
    for (const o of live) {
      this._residentise(o);
      while (o.built < o.parts.length) this._buildPart(o, o.parts[o.built++]);
      o.ready = true;
    }
    this.buildStats.compactions++;
  }

  /* ---------------------------------------------------------------- */
  /* Arena growth                                                      */
  /* ---------------------------------------------------------------- */

  _ensureTriCap(cap) {
    if (this._tri.cap >= cap) return;
    const n = Math.max(cap, 8192);
    const pos = new Float32Array(n * 9); pos.set(this.pos);
    const nrm = new Float32Array(n * 3); nrm.set(this.nrm);
    const surface = new Uint8Array(n); surface.set(this.surface);
    const mask = new Uint16Array(n); mask.set(this.mask);
    const object = new Int32Array(n); object.set(this.object);
    const triIndex = new Uint32Array(n); triIndex.set(this.triIndex);
    const cent = new Float32Array(n * 3); cent.set(this._cent);
    const taabb = new Float32Array(n * 6); taabb.set(this._taabb);
    this.pos = pos; this.nrm = nrm; this.surface = surface; this.mask = mask;
    this.object = object; this.triIndex = triIndex; this._cent = cent; this._taabb = taabb;
    this._tri.cap = n;
    this.buildStats.grows++;
  }

  _growTri(need) {
    this._ensureTriCap(Math.max(this._tri.top + need, Math.ceil(this._tri.cap * 1.6), 8192));
  }

  _ensureNodeCap(cap) {
    if (this._node.cap >= cap) return;
    const n = Math.max(cap, 4096);
    const b = new Float32Array(n * 6); b.set(this.nodeBounds);
    const m = new Int32Array(n * 2); m.set(this.nodeMeta);
    this.nodeBounds = b;
    this.nodeMeta = m;
    this._node.cap = n;
    this.buildStats.grows++;
  }

  _growNodes(need) {
    this._ensureNodeCap(Math.max(this._node.top + need, Math.ceil(this._node.cap * 1.6), 4096));
  }

  /** Freed nodes read as empty interior nodes, so the debug view skips them. */
  _freeNodes(start, count) {
    if (count > 0) this.nodeMeta.fill(0, start * 2, (start + count) * 2);
    this._node.free(start, count);
  }

  _ensureScratch(prims) {
    const cap = 2 * prims + 8;
    if (this._sbB.length >= cap * 6) return;
    this._sbB = new Float32Array(cap * 6);
    this._sbM = new Int32Array(cap * 2);
  }

  /* ---------------------------------------------------------------- */
  /* Queries                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Closest-hit ray query. `out` is a hit record (see math.makeHitRecord).
   * Returns true on hit. Both faces are tested — bullet penetration needs the
   * backface exit hit.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, mask, out, ignoreObject = -1) {
    out.hit = false;
    if (this.rootNode < 0 || this.triCount === 0) return false;
    const ix = 1 / (dx !== 0 ? dx : 1e-30);
    const iy = 1 / (dy !== 0 ? dy : 1e-30);
    const iz = 1 / (dz !== 0 ? dz : 1e-30);
    const nb = this.nodeBounds;
    const meta = this.nodeMeta;
    const idx = this.triIndex;
    const pos = this.pos;
    const stackNode = this._stackNode;
    const stackT = this._stackT;
    const root = this.rootNode;
    const rb = root * 6;

    let best = maxDist;
    let bestTri = -1;
    let bestFront = true;

    if (rayAabb(ox, oy, oz, ix, iy, iz, nb[rb], nb[rb + 1], nb[rb + 2], nb[rb + 3], nb[rb + 4], nb[rb + 5], best) === Infinity)
      return false;

    let sp = 0;
    stackNode[sp] = root;
    stackT[sp] = 0;
    sp++;

    while (sp > 0) {
      sp--;
      if (stackT[sp] >= best) continue;
      let node = stackNode[sp];
      for (;;) {
        const count = meta[node * 2 + 1];
        if (count > 0) {
          const start = meta[node * 2];
          for (let i = start; i < start + count; i++) {
            const tri = idx[i];
            if ((this.mask[tri] & mask) === 0) continue;
            if (ignoreObject >= 0 && this.object[tri] === ignoreObject) continue;
            const p = tri * 9;
            const t = rayTriangle(
              ox, oy, oz, dx, dy, dz,
              pos[p], pos[p + 1], pos[p + 2],
              pos[p + 3], pos[p + 4], pos[p + 5],
              pos[p + 6], pos[p + 7], pos[p + 8],
              out
            );
            if (t >= 0 && t < best) {
              best = t;
              bestTri = tri;
              bestFront = out.frontFace; // written by rayTriangle
            }
          }
          break;
        }
        const l = meta[node * 2];
        const r = l + 1;
        const lo = l * 6, ro = r * 6;
        const tl = rayAabb(ox, oy, oz, ix, iy, iz, nb[lo], nb[lo + 1], nb[lo + 2], nb[lo + 3], nb[lo + 4], nb[lo + 5], best);
        const tr = rayAabb(ox, oy, oz, ix, iy, iz, nb[ro], nb[ro + 1], nb[ro + 2], nb[ro + 3], nb[ro + 4], nb[ro + 5], best);
        if (tl === Infinity && tr === Infinity) break;
        if (tl <= tr) {
          if (tr !== Infinity) { stackNode[sp] = r; stackT[sp] = tr; sp++; }
          node = l;
        } else {
          if (tl !== Infinity) { stackNode[sp] = l; stackT[sp] = tl; sp++; }
          node = r;
        }
      }
    }

    if (bestTri < 0) return false;
    this._fillHit(out, bestTri, best, ox, oy, oz, dx, dy, dz);
    out.frontFace = bestFront;
    // Face the normal against the incoming ray so callers can always use it
    // directly for reflection / decal orientation.
    if (out.nx * dx + out.ny * dy + out.nz * dz > 0) {
      out.nx = -out.nx; out.ny = -out.ny; out.nz = -out.nz;
    }
    return true;
  }

  _fillHit(out, tri, t, ox, oy, oz, dx, dy, dz) {
    out.hit = true;
    out.t = t;
    out.px = ox + dx * t;
    out.py = oy + dy * t;
    out.pz = oz + dz * t;
    out.nx = this.nrm[tri * 3];
    out.ny = this.nrm[tri * 3 + 1];
    out.nz = this.nrm[tri * 3 + 2];
    out.tri = tri;
    out.surface = this.surface[tri];
    out.object = this.object[tri];
    out.body = null;
  }

  /** Any-hit shadow/visibility ray. Cheaper: no ordering, first hit wins. */
  raycastAny(ox, oy, oz, dx, dy, dz, maxDist, mask) {
    if (this.rootNode < 0) return false;
    const ix = 1 / (dx !== 0 ? dx : 1e-30);
    const iy = 1 / (dy !== 0 ? dy : 1e-30);
    const iz = 1 / (dz !== 0 ? dz : 1e-30);
    const nb = this.nodeBounds;
    const meta = this.nodeMeta;
    const idx = this.triIndex;
    const pos = this.pos;
    const stack = this._stackNode;
    const root = this.rootNode;
    const rb = root * 6;
    let sp = 0;
    if (rayAabb(ox, oy, oz, ix, iy, iz, nb[rb], nb[rb + 1], nb[rb + 2], nb[rb + 3], nb[rb + 4], nb[rb + 5], maxDist) === Infinity)
      return false;
    stack[sp++] = root;
    while (sp > 0) {
      const node = stack[--sp];
      const count = meta[node * 2 + 1];
      if (count > 0) {
        const start = meta[node * 2];
        for (let i = start; i < start + count; i++) {
          const tri = idx[i];
          if ((this.mask[tri] & mask) === 0) continue;
          const p = tri * 9;
          const t = rayTriangle(
            ox, oy, oz, dx, dy, dz,
            pos[p], pos[p + 1], pos[p + 2],
            pos[p + 3], pos[p + 4], pos[p + 5],
            pos[p + 6], pos[p + 7], pos[p + 8],
            null
          );
          if (t >= 0 && t < maxDist) return true;
        }
        continue;
      }
      const l = meta[node * 2];
      const r = l + 1;
      const lo = l * 6, ro = r * 6;
      if (rayAabb(ox, oy, oz, ix, iy, iz, nb[lo], nb[lo + 1], nb[lo + 2], nb[lo + 3], nb[lo + 4], nb[lo + 5], maxDist) !== Infinity)
        stack[sp++] = l;
      if (rayAabb(ox, oy, oz, ix, iy, iz, nb[ro], nb[ro + 1], nb[ro + 2], nb[ro + 3], nb[ro + 4], nb[ro + 5], maxDist) !== Infinity)
        stack[sp++] = r;
    }
    return false;
  }

  /** Gather triangle indices whose AABB overlaps the query box. */
  queryAabb(minx, miny, minz, maxx, maxy, maxz, mask) {
    this._candCount = 0;
    if (this.rootNode < 0) return 0;
    const nb = this.nodeBounds;
    const meta = this.nodeMeta;
    const idx = this.triIndex;
    const ta = this._taabb;
    const stack = this._stackNode;
    const root = this.rootNode;
    const rb = root * 6;
    let sp = 0;
    if (nb[rb] > maxx || nb[rb + 3] < minx || nb[rb + 1] > maxy || nb[rb + 4] < miny || nb[rb + 2] > maxz || nb[rb + 5] < minz)
      return 0;
    stack[sp++] = root;
    let n = 0;
    let cand = this._cand;
    while (sp > 0) {
      const node = stack[--sp];
      const count = meta[node * 2 + 1];
      if (count > 0) {
        const start = meta[node * 2];
        for (let i = start; i < start + count; i++) {
          const tri = idx[i];
          if ((this.mask[tri] & mask) === 0) continue;
          const b = tri * 6;
          if (ta[b] > maxx || ta[b + 3] < minx) continue;
          if (ta[b + 1] > maxy || ta[b + 4] < miny) continue;
          if (ta[b + 2] > maxz || ta[b + 5] < minz) continue;
          if (n >= cand.length) {
            const bigger = new Int32Array(cand.length * 2);
            bigger.set(cand);
            this._cand = cand = bigger;
          }
          cand[n++] = tri;
        }
        continue;
      }
      const l = meta[node * 2];
      const r = l + 1;
      const lo = l * 6, ro = r * 6;
      const hitL = !(nb[lo] > maxx || nb[lo + 3] < minx || nb[lo + 1] > maxy || nb[lo + 4] < miny || nb[lo + 2] > maxz || nb[lo + 5] < minz);
      const hitR = !(nb[ro] > maxx || nb[ro + 3] < minx || nb[ro + 1] > maxy || nb[ro + 4] < miny || nb[ro + 2] > maxz || nb[ro + 5] < minz);
      if (hitL) stack[sp++] = l;
      if (hitR) stack[sp++] = r;
      if (sp >= stack.length - 2) {
        // The traversal stack is sized from the tree depth, so this should be
        // unreachable — but an abandoned traversal returns a SHORT candidate
        // list and every caller treats that as "nothing else is there".
        this._noteTruncation('traversal', `AABB query stack full at ${sp} of ${stack.length}`);
        break;
      }
    }
    this._candCount = n;
    return n;
  }

  get candidates() {
    return this._cand;
  }
  get candidateCount() {
    return this._candCount;
  }

  /**
   * Swept capsule against the static world. The capsule translates linearly;
   * each candidate triangle gets conservative advancement on the exact
   * segment/triangle distance function, which is convex under linear motion —
   * so the result is a true time of impact with no tunnelling at any speed.
   */
  sweepCapsule(p0x, p0y, p0z, p1x, p1y, p1z, radius, dx, dy, dz, maxDist, mask, out) {
    out.hit = false;
    if (this.rootNode < 0) return false;
    const ex = dx * maxDist, ey = dy * maxDist, ez = dz * maxDist;
    const r = radius + 0.002;
    const minx = Math.min(p0x, p1x, p0x + ex, p1x + ex) - r;
    const miny = Math.min(p0y, p1y, p0y + ey, p1y + ey) - r;
    const minz = Math.min(p0z, p1z, p0z + ez, p1z + ez) - r;
    const maxx = Math.max(p0x, p1x, p0x + ex, p1x + ex) + r;
    const maxy = Math.max(p0y, p1y, p0y + ey, p1y + ey) + r;
    const maxz = Math.max(p0z, p1z, p0z + ez, p1z + ez) + r;
    const n = this.queryAabb(minx, miny, minz, maxx, maxy, maxz, mask);
    if (n === 0) return false;

    const cand = this._cand;
    const pos = this.pos;
    const nrm = this.nrm;
    const cl = this._cl;
    let best = maxDist;
    let bestTri = -1;
    let bnx = 0, bny = 1, bnz = 0;
    let bpx = 0, bpy = 0, bpz = 0;

    for (let c = 0; c < n; c++) {
      const tri = cand[c];
      const p = tri * 9;
      const ax = pos[p], ay = pos[p + 1], az = pos[p + 2];
      const bx = pos[p + 3], by = pos[p + 4], bz = pos[p + 5];
      const cx = pos[p + 6], cy = pos[p + 7], cz = pos[p + 8];

      // Cheap plane-slab prefilter. The min signed distance over the capsule
      // axis is linear in t, so the whole sweep can be rejected with two dots.
      const tnx = nrm[tri * 3], tny = nrm[tri * 3 + 1], tnz = nrm[tri * 3 + 2];
      const sdA = (p0x - ax) * tnx + (p0y - ay) * tny + (p0z - az) * tnz;
      const sdB = (p1x - ax) * tnx + (p1y - ay) * tny + (p1z - az) * tnz;
      const vd = (dx * tnx + dy * tny + dz * tnz) * best;
      const lo = Math.min(sdA, sdB) + Math.min(0, vd);
      const hi = Math.max(sdA, sdB) + Math.max(0, vd);
      if (lo > radius || hi < -radius) continue;

      let t = 0;
      let hitT = -1;
      for (let iter = 0; iter < CA_ITERS; iter++) {
        const ox = dx * t, oy = dy * t, oz = dz * t;
        segTriangleClosest(
          p0x + ox, p0y + oy, p0z + oz,
          p1x + ox, p1y + oy, p1z + oz,
          ax, ay, az, bx, by, bz, cx, cy, cz,
          cl
        );
        const dist = Math.sqrt(cl.d2) - radius;
        // separating axis: capsule axis point -> triangle point
        let sx = cl.bx - cl.ax, sy = cl.by - cl.ay, sz = cl.bz - cl.az;
        const sl = Math.hypot(sx, sy, sz);
        if (sl < 1e-12) { hitT = t; break; } // axis passes through the face
        sx /= sl; sy /= sl; sz /= sl;
        const closing = dx * sx + dy * sy + dz * sz;
        if (dist <= CA_TOL) {
          // Already touching. Only a *blocking* contact counts — a capsule
          // resting on the floor must still be able to slide along it, or the
          // controller stalls the instant it stands on anything.
          if (closing > 1e-6) hitT = t;
          break;
        }
        if (closing <= 1e-7) break; // convex distance is non-decreasing -> miss
        const step = dist / closing;
        t += step > 1e-7 ? step : 1e-7;
        if (t >= best) break;
      }
      if (hitT < 0 || hitT >= best) continue;

      // Recover the contact normal at the impact configuration.
      const ox = dx * hitT, oy = dy * hitT, oz = dz * hitT;
      segTriangleClosest(
        p0x + ox, p0y + oy, p0z + oz,
        p1x + ox, p1y + oy, p1z + oz,
        ax, ay, az, bx, by, bz, cx, cy, cz,
        cl
      );
      let nx = cl.ax - cl.bx, ny = cl.ay - cl.by, nz = cl.az - cl.bz;
      const nl = Math.hypot(nx, ny, nz);
      if (nl > 1e-7) { nx /= nl; ny /= nl; nz /= nl; }
      else { nx = tnx; ny = tny; nz = tnz; }
      // Never return a normal pointing away from the direction of travel.
      if (nx * dx + ny * dy + nz * dz > 0) {
        if (tnx * dx + tny * dy + tnz * dz < 0) { nx = tnx; ny = tny; nz = tnz; }
        else { nx = -tnx; ny = -tny; nz = -tnz; }
      }
      best = hitT;
      bestTri = tri;
      bnx = nx; bny = ny; bnz = nz;
      bpx = cl.bx; bpy = cl.by; bpz = cl.bz;
    }

    if (bestTri < 0) return false;
    out.hit = true;
    out.t = best;
    out.px = bpx; out.py = bpy; out.pz = bpz;
    out.nx = bnx; out.ny = bny; out.nz = bnz;
    out.tri = bestTri;
    out.surface = this.surface[bestTri];
    out.object = this.object[bestTri];
    out.frontFace = true;
    out.body = null;
    return true;
  }

  /**
   * Collect penetration contacts for a capsule at rest. Fills `this.contacts`
   * (shared, valid until the next overlap query). Normals point out of the
   * surface, towards the capsule.
   */
  overlapCapsule(p0x, p0y, p0z, p1x, p1y, p1z, radius, mask, margin = 0) {
    const cts = this.contacts;
    cts.count = 0;
    if (this.rootNode < 0) return 0;
    const r = radius + margin;
    const n = this.queryAabb(
      Math.min(p0x, p1x) - r, Math.min(p0y, p1y) - r, Math.min(p0z, p1z) - r,
      Math.max(p0x, p1x) + r, Math.max(p0y, p1y) + r, Math.max(p0z, p1z) + r,
      mask
    );
    if (n === 0) return 0;
    const cand = this._cand;
    const pos = this.pos;
    const nrm = this.nrm;
    const cl = this._cl2;
    const r2 = r * r;
    let k = 0;
    for (let c = 0; c < n && k < cts.capacity; c++) {
      const tri = cand[c];
      const p = tri * 9;
      const d2 = segTriangleClosest(
        p0x, p0y, p0z, p1x, p1y, p1z,
        pos[p], pos[p + 1], pos[p + 2],
        pos[p + 3], pos[p + 4], pos[p + 5],
        pos[p + 6], pos[p + 7], pos[p + 8],
        cl
      );
      if (d2 >= r2) continue;
      const d = Math.sqrt(d2);
      let nx, ny, nz;
      if (d > 1e-6) {
        nx = (cl.ax - cl.bx) / d;
        ny = (cl.ay - cl.by) / d;
        nz = (cl.az - cl.bz) / d;
        // Deep contacts can pick a normal pointing into the solid; fall back to
        // the face normal when the closest-point direction disagrees with it.
        const fn = nx * nrm[tri * 3] + ny * nrm[tri * 3 + 1] + nz * nrm[tri * 3 + 2];
        if (fn < 0.05) {
          nx = nrm[tri * 3]; ny = nrm[tri * 3 + 1]; nz = nrm[tri * 3 + 2];
        }
      } else {
        nx = nrm[tri * 3]; ny = nrm[tri * 3 + 1]; nz = nrm[tri * 3 + 2];
      }
      cts.nx[k] = nx; cts.ny[k] = ny; cts.nz[k] = nz;
      cts.px[k] = cl.bx; cts.py[k] = cl.by; cts.pz[k] = cl.bz;
      cts.depth[k] = r - d;
      cts.s[k] = cl.s;
      cts.tri[k] = tri;
      k++;
    }
    cts.count = k;
    if (k >= cts.capacity) {
      this._noteTruncation(
        'contacts',
        `overlapCapsule filled all ${cts.capacity} contact slots at ` +
        `(${p0x.toFixed(1)}, ${p0y.toFixed(1)}, ${p0z.toFixed(1)}) r=${r.toFixed(2)} — ` +
        'contacts beyond that were dropped, so the deepest one may not be in the list'
      );
    }
    return k;
  }

  /** Count and name an incomplete answer. Once per kind, then just counted. */
  _noteTruncation(kind, detail) {
    this.truncations[kind]++;
    if (this._truncLogged[kind]) return;
    this._truncLogged[kind] = true;
    console.warn(`[physics] TRUNCATED QUERY (${kind}): ${detail}`);
  }

  surfaceOf(tri) {
    return this.surface[tri] ?? 0;
  }

  objectOf(tri) {
    return this.objects[this.object[tri]] ?? null;
  }

  dispose() {
    this.objects.length = 0;
    this._pending.length = 0;
    this._dead.length = 0;
    this._freeIds.length = 0;
    this._objList.length = 0;
    this._twinIndex.clear();
    this.pos = new Float32Array(0);
    this.nrm = new Float32Array(0);
    this.surface = new Uint8Array(0);
    this.mask = new Uint16Array(0);
    this.object = new Int32Array(0);
    this.triIndex = new Uint32Array(0);
    this._cent = new Float32Array(0);
    this._taabb = new Float32Array(0);
    this.nodeBounds = new Float32Array(0);
    this.nodeMeta = new Int32Array(0);
    this._tri = new RangeArena();
    this._node = new RangeArena();
    this._tlasBlock = -1;
    this._tlasUsed = 0;
    this.rootNode = -1;
    this.nodeCount = 0;
    this.triCount = 0;
    this.dirty = false;
  }
}

function surfaceArea(minx, miny, minz, maxx, maxy, maxz) {
  const dx = maxx - minx, dy = maxy - miny, dz = maxz - minz;
  if (dx < 0 || dy < 0 || dz < 0) return 0;
  return 2 * (dx * dy + dy * dz + dz * dx);
}

/* ------------------------------------------------------------------ */
/* Mesh baking                                                         */
/* ------------------------------------------------------------------ */

/**
 * Flatten a Mesh / InstancedMesh into world-space triangles.
 * Handles indexed and non-indexed geometry, multi-material groups (each group
 * can carry its own surface, inferred from the material name), and instancing.
 */
export function bakeMesh(mesh, surfaceOverride, opts = {}) {
  const geo = mesh.geometry;
  if (!geo || !geo.attributes || !geo.attributes.position) return null;
  const posAttr = geo.attributes.position;
  const index = geo.index;
  const triPerInstance = (index ? index.count : posAttr.count) / 3 | 0;
  if (triPerInstance === 0) return null;

  const isInstanced = mesh.isInstancedMesh === true && mesh.count > 0;
  const instances = isInstanced ? mesh.count : 1;
  const total = triPerInstance * instances;

  const out = new Float32Array(total * 9);
  const surfaces = new Uint8Array(total);

  mesh.updateWorldMatrix(true, false);

  // Per-group surface resolution.
  const groups = geo.groups && geo.groups.length ? geo.groups : null;
  const baseSurface = surfaceOverride !== undefined && surfaceOverride !== null
    ? surfaceIndex(surfaceOverride)
    : surfaceIndex(
        mesh.userData?.surface ?? materialName(mesh.material) ?? mesh.name,
        guessSurface(mesh.name)
      );
  const groupSurface = groups
    ? groups.map((g, gi) => {
        if (surfaceOverride !== undefined && surfaceOverride !== null) return baseSurface;
        const mat = Array.isArray(mesh.material) ? mesh.material[g.materialIndex ?? gi] : mesh.material;
        return surfaceIndex(mat?.userData?.surface ?? mat?.name ?? mesh.name, baseSurface);
      })
    : null;

  const pos = posAttr.array;
  const stride = posAttr.itemSize;
  const idxArr = index ? index.array : null;

  for (let inst = 0; inst < instances; inst++) {
    if (isInstanced) {
      mesh.getMatrixAt(inst, _m4);
      _m4.premultiply(mesh.matrixWorld);
    } else {
      _m4.copy(mesh.matrixWorld);
    }
    const e = _m4.elements;
    const base = inst * triPerInstance;
    for (let t = 0; t < triPerInstance; t++) {
      const o = (base + t) * 9;
      for (let v = 0; v < 3; v++) {
        const vi = idxArr ? idxArr[t * 3 + v] : t * 3 + v;
        const px = pos[vi * stride];
        const py = pos[vi * stride + 1];
        const pz = pos[vi * stride + 2];
        out[o + v * 3] = e[0] * px + e[4] * py + e[8] * pz + e[12];
        out[o + v * 3 + 1] = e[1] * px + e[5] * py + e[9] * pz + e[13];
        out[o + v * 3 + 2] = e[2] * px + e[6] * py + e[10] * pz + e[14];
      }
      let s = baseSurface;
      if (groupSurface) {
        const vStart = t * 3;
        for (let gi = 0; gi < geo.groups.length; gi++) {
          const g = geo.groups[gi];
          if (vStart >= g.start && vStart < g.start + g.count) { s = groupSurface[gi]; break; }
        }
      }
      surfaces[base + t] = s;
    }
  }

  // Drop degenerate triangles (zero area) — they poison normals and SAH bins.
  let w = 0;
  for (let t = 0; t < total; t++) {
    const p = t * 9;
    const e1x = out[p + 3] - out[p], e1y = out[p + 4] - out[p + 1], e1z = out[p + 5] - out[p + 2];
    const e2x = out[p + 6] - out[p], e2y = out[p + 7] - out[p + 1], e2z = out[p + 8] - out[p + 2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    if (cx * cx + cy * cy + cz * cz < 1e-14) continue;
    if (w !== t) {
      out.copyWithin(w * 9, p, p + 9);
      surfaces[w] = surfaces[t];
    }
    w++;
  }

  return { pos: out, count: w, surfaces, uniformSurface: baseSurface };
}

function materialName(m) {
  if (!m) return null;
  if (Array.isArray(m)) return m[0]?.name ?? null;
  return m.userData?.surface ?? m.name ?? null;
}
