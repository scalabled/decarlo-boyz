import * as THREE from 'three';

/**
 * WORLD — the terrain renderer: a geometry clipmap.
 *
 * A 3 km city with a 6 km draw distance cannot be one mesh and must not be a
 * quadtree of a hundred patches (a hundred patches is a hundred draw calls
 * through the prepass and four shadow cascades). A clipmap is L nested square
 * rings centred on the camera, each with twice the spacing of the one inside
 * it: SIX rings cover the whole 3 km city at 2 m resolution under the player.
 *
 *   level 0   full 97x97 grid, 2 m spacing  -> +-96 m
 *   level 1-5 hollow rings, 4..64 m spacing -> +-3072 m
 *
 * CRACKS. Level L's hole is exactly the extent of level L-1 (both snapped to
 * their own grids, and because the vertex count is even the boundaries land on
 * the same lines). Every second vertex on the finer level's outer boundary
 * therefore has no partner on the coarser one, so it is set to the mean of its
 * two neighbours — the two boundaries then describe the identical polyline and
 * there is nothing to crack. No skirts, no stitch strips, no overdraw.
 *
 * MATERIAL. Each level owns FOUR index buffers over one shared vertex array —
 * grass, mud, river silt and exposed rock — and every quad picks one from its
 * own slope, elevation and a noise field. The thresholds are noise-perturbed,
 * so the boundary between two ground types is ragged rather than a contour
 * line, which is the tell that gives a splat map away. Empty layers set an
 * empty draw range and cost nothing.
 *
 * REBUILDS are amortised through `world.schedule()`: level L only rewrites when
 * the camera crosses a multiple of 2 * spacing(L), so the coarse rings almost
 * never move and the fine ones are ~9 k height fetches.
 */

/** Half the vertex count per side. MUST be even (see the crack note). */
const M = 48;
const N = M * 2 + 1;
const LEVELS = 6;
const BASE_SPACING = 2;
/**
 * The coarsest quad whose diagonal may still be chosen from the corner
 * heights. See the note at the flip itself.
 */
const FLIP_MAX = 16;

export class TerrainMesh {
  constructor({ terrain, materials, palette, root, rng }) {
    this.terrain = terrain;
    this.root = new THREE.Group();
    this.root.name = 'terrain';
    this.root.matrixAutoUpdate = false;
    root.add(this.root);
    this.levels = [];
    this.rng = rng;

    this.layerKeys = ['terrain_grass', 'terrain_dirt', 'terrain_silt', 'terrain_rock'];
    this.materials = this.layerKeys.map((k) => materials.get(palette[k].name, palette[k].opts));
    this.surfaces = this.layerKeys.map((k) => palette[k].surface);

    for (let l = 0; l < LEVELS; l++) this.levels.push(this._makeLevel(l));
    this._dirty = new Array(LEVELS).fill(true);
    this._pending = new Array(LEVELS).fill(false);
    this._built = 0;
  }

  _makeLevel(level) {
    const spacing = BASE_SPACING * (1 << level);
    const verts = N * N;
    const position = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    const normal = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    const uv = new THREE.BufferAttribute(new Float32Array(verts * 2), 2);
    const color = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    position.setUsage(THREE.DynamicDrawUsage);
    normal.setUsage(THREE.DynamicDrawUsage);
    color.setUsage(THREE.DynamicDrawUsage);

    const maxTris = (N - 1) * (N - 1) * 2;
    const mk = (li) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', position);
      g.setAttribute('normal', normal);
      g.setAttribute('uv', uv);
      g.setAttribute('color', color);
      const idx = new THREE.BufferAttribute(new Uint32Array(maxTris * 3), 1);
      idx.setUsage(THREE.DynamicDrawUsage);
      g.setIndex(idx);
      g.setDrawRange(0, 0);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
      const m = new THREE.Mesh(g, this.materials[li]);
      m.name = `${this.layerKeys[li]}_L${level}`;
      m.frustumCulled = true;
      m.matrixAutoUpdate = false;
      m.receiveShadow = true;
      // Only the two finest rings cast: a 1 km ring in the cascades buys
      // nothing but shadow acne and four extra draws.
      m.castShadow = level <= 1;
      if (level > 1) m.userData.owNoShadow = true;
      m.userData.collision = false;
      m.userData.surface = this.surfaces[li];
      m.renderOrder = -2;
      this.root.add(m);
      return { mesh: m, geo: g, index: idx, n: 0 };
    };

    return {
      level,
      spacing,
      cx: NaN,
      cz: NaN,
      position,
      normal,
      color,
      uv,
      layers: this.layerKeys.map((_, i) => mk(i)),
      /** vertex-grid extent of the hole, in index space; -1 = no hole */
      hole: level === 0 ? -1 : M / 2,
      holeCx: 0,
      holeCz: 0,
    };
  }

  /**
   * Snap centres, queue rebuilds. Cheap: a handful of comparisons.
   * `schedule(fn, priority)` is the world's amortised job queue.
   */
  update(camX, camZ, schedule) {
    for (let l = 0; l < LEVELS; l++) {
      const lv = this.levels[l];
      const snap = lv.spacing * 2;
      const cx = Math.round(camX / snap) * snap;
      const cz = Math.round(camZ / snap) * snap;
      // The hole must follow the level inside this one, exactly.
      let hx = 0;
      let hz = 0;
      if (l > 0) {
        const inner = this.levels[l - 1];
        const isnap = inner.spacing * 2;
        hx = Math.round(camX / isnap) * isnap;
        hz = Math.round(camZ / isnap) * isnap;
      }
      if (cx === lv.cx && cz === lv.cz && hx === lv.holeCx && hz === lv.holeCz) continue;
      if (lv.pending) continue;
      lv.pending = true;
      const nx = cx;
      const nz = cz;
      schedule(() => {
        lv.pending = false;
        this._rebuild(lv, nx, nz, hx, hz);
      }, l === 0 ? 0 : 1 + l);
    }
  }

  /** True once every level has been written at least once. */
  get ready() {
    return this._built >= LEVELS;
  }

  _rebuild(lv, cx, cz, hx, hz) {
    const first = Number.isNaN(lv.cx);
    lv.cx = cx;
    lv.cz = cz;
    lv.holeCx = hx;
    lv.holeCz = hz;
    const t = this.terrain;
    const s = lv.spacing;
    const pos = lv.position.array;
    const nrm = lv.normal.array;
    const col = lv.color.array;
    const uv = lv.uv.array;
    const x0 = cx - M * s;
    const z0 = cz - M * s;

    // Hole in index space (inclusive). Level L-1 covers +-(M/2)*s about (hx,hz).
    const h = lv.hole;
    let hi0 = -1;
    let hi1 = -1;
    let hj0 = -1;
    let hj1 = -1;
    if (h > 0) {
      hi0 = Math.round((hx - h * s - x0) / s);
      hi1 = hi0 + h * 2;
      hj0 = Math.round((hz - h * s - z0) / s);
      hj1 = hj0 + h * 2;
    }

    // ---- heights --------------------------------------------------------
    for (let j = 0; j < N; j++) {
      const z = z0 + j * s;
      const inHoleJ = h > 0 && j > hj0 && j < hj1;
      for (let i = 0; i < N; i++) {
        if (inHoleJ && i > hi0 && i < hi1) continue; // never indexed
        const x = x0 + i * s;
        const k = (j * N + i) * 3;
        pos[k] = x;
        // Tell the field how coarsely it is being sampled. Levels 0-2 pass a
        // step small enough that nothing is dropped, so the near ground — the
        // ground you can stand on and shoot at — is bit-for-bit what it was.
        pos[k + 1] = t.heightAt(x, z, s);
        pos[k + 2] = z;
        const k2 = (j * N + i) * 2;
        uv[k2] = x * 0.02;
        uv[k2 + 1] = z * 0.02;
      }
    }

    // ---- outer boundary: match the coarser ring exactly ------------------
    // Every second vertex on this ring's outer edge has no partner one level
    // up; averaging it puts both boundaries on the same polyline.
    if (lv.level < LEVELS - 1) {
      const fix = (i, j, ia, ja, ib, jb) => {
        const k = (j * N + i) * 3 + 1;
        pos[k] = (pos[(ja * N + ia) * 3 + 1] + pos[(jb * N + ib) * 3 + 1]) * 0.5;
      };
      for (let i = 1; i < N - 1; i += 2) {
        fix(i, 0, i - 1, 0, i + 1, 0);
        fix(i, N - 1, i - 1, N - 1, i + 1, N - 1);
      }
      for (let j = 1; j < N - 1; j += 2) {
        fix(0, j, 0, j - 1, 0, j + 1);
        fix(N - 1, j, N - 1, j - 1, N - 1, j + 1);
      }
    }

    // ---- normals + masks -------------------------------------------------
    const inv2s = 1 / (2 * s);
    for (let j = 0; j < N; j++) {
      const inHoleJ = h > 0 && j > hj0 && j < hj1;
      for (let i = 0; i < N; i++) {
        if (inHoleJ && i > hi0 && i < hi1) continue;
        const k = (j * N + i) * 3;
        const x = pos[k];
        const z = pos[k + 2];
        const il = i > 0 ? i - 1 : i;
        const ir = i < N - 1 ? i + 1 : i;
        const jd = j > 0 ? j - 1 : j;
        const ju = j < N - 1 ? j + 1 : j;
        // Sample the field rather than the buffer at the hole rim, where the
        // neighbour was skipped.
        const hl = this._sample(pos, il, j, x - s, z, t, s);
        const hr = this._sample(pos, ir, j, x + s, z, t, s);
        const hd = this._sample(pos, i, jd, x, z - s, t, s);
        const hu = this._sample(pos, i, ju, x, z + s, t, s);
        let nx = (hl - hr) * inv2s;
        let nz = (hd - hu) * inv2s;
        const len = Math.hypot(nx, 1, nz);
        nrm[k] = nx / len;
        nrm[k + 1] = 1 / len;
        nrm[k + 2] = nz / len;

        const slope = Math.hypot(nx, nz);
        const y = pos[k + 1];
        // r = edge wear (dries + lightens the crests), g = grime (damp hollows
        // and the ground line), b = extra AO in the folds.
        const n1 = fastNoise(x * 0.021, z * 0.021);
        col[k] = 0.10 + Math.min(0.55, slope * 0.42) + n1 * 0.22;
        col[k + 1] = 0.30 + (1 - Math.min(1, slope * 1.6)) * 0.3 + (y < 4 ? 0.28 : 0) - n1 * 0.2;
        col[k + 2] = 0.16 + Math.min(0.4, slope * 0.3);
      }
    }

    // ---- index: pick a ground layer per quad -----------------------------
    const L = lv.layers;
    for (let li = 0; li < L.length; li++) L[li].n = 0;
    for (let j = 0; j < N - 1; j++) {
      const inHoleJ = h > 0 && j >= hj0 && j < hj1;
      for (let i = 0; i < N - 1; i++) {
        if (inHoleJ && i >= hi0 && i < hi1) continue;
        const a = j * N + i;
        const b = a + 1;
        const c = a + N;
        const d = c + 1;
        const ya = pos[a * 3 + 1];
        const yb = pos[b * 3 + 1];
        const yc = pos[c * 3 + 1];
        const yd = pos[d * 3 + 1];
        const lo = Math.min(ya, yb, yc, yd);
        const slope = (Math.max(ya, yb, yc, yd) - lo) / s;
        const x = pos[a * 3];
        const z = pos[a * 3 + 2];
        // Ragged thresholds: a clean contour line between two ground materials
        // is the loudest artefact on a hillside.
        //
        // BUT THE RAG HAS TO BE BIGGER THAN THE QUAD. `nA` has a 17 m
        // wavelength, which on a 64 m ring is white noise sampled once per
        // quad — so the threshold it perturbs is redrawn for every quad and
        // neighbours flip between exposed rock and meadow at random. That is
        // the rectangular patchwork on the far rim, and it is a SHADING
        // checkerboard rather than a height one, which is why it survived the
        // height band-limiting. Stretch both noises with the quad so the rag
        // stays about six quads long at every level; the near rings, where the
        // ground is walked on, keep exactly the frequencies they had.
        const fA = s <= 8 ? 0.06 : 1 / (6 * s);
        const fB = s <= 8 ? 0.011 : Math.min(0.011, 1 / (6 * s));
        const nA = fastNoise(x * fA, z * fA);
        const nB = fastNoise(x * fB + 17, z * fB - 9);
        const urban = t.urbanAt(x, z);
        let li;
        if (slope > 0.60 + (nA - 0.5) * 0.5) li = 3;              // exposed rock
        else if (lo < 1.5 + (nA - 0.5) * 2.0) li = 2;             // river silt
        // Inside a district the ground between buildings is worn bare; out in
        // the valley it is meadow. The threshold moves with the district's own
        // density, so the Golden Triangle is grit and Troy Hill is grass.
        else if (nB > 0.86 - urban * 0.85 - (lo < 15 ? 0.14 : 0) + slope * 0.2) li = 1;
        else li = 0;
        const layer = L[li];
        const arr = layer.index.array;
        let n = layer.n;
        // Flip the diagonal to follow the dominant slope direction — but only
        // where the grid can actually resolve the slope. On the far rings the
        // quad is 32 or 64 m across and the field inside it is undersampled, so
        // the heuristic is choosing between two triangulations that differ by
        // tens of metres at the quad centre (measured: 19 of 121 quads in the
        // Ohio gorge over 10 m, worst 53.9 m) and neighbouring quads pick
        // opposite ways. That is a checkerboard by construction. Past
        // `FLIP_MAX` the diagonal alternates on a fixed parity instead, which
        // is what a regular grid should look like.
        const flip = s <= FLIP_MAX ? Math.abs(ya - yd) < Math.abs(yb - yc) : ((i + j) & 1) === 0;
        if (flip) {
          arr[n++] = a; arr[n++] = c; arr[n++] = d;
          arr[n++] = a; arr[n++] = d; arr[n++] = b;
        } else {
          arr[n++] = a; arr[n++] = c; arr[n++] = b;
          arr[n++] = b; arr[n++] = c; arr[n++] = d;
        }
        layer.n = n;
      }
    }

    lv.position.needsUpdate = true;
    lv.normal.needsUpdate = true;
    lv.color.needsUpdate = true;
    lv.uv.needsUpdate = true;
    const r = M * s * 1.45;
    for (const layer of L) {
      layer.index.needsUpdate = true;
      layer.geo.setDrawRange(0, layer.n);
      layer.mesh.visible = layer.n > 0;
      layer.geo.boundingSphere.center.set(cx, 0, cz);
      layer.geo.boundingSphere.radius = r;
    }
    if (first) this._built++;
  }

  _sample(pos, i, j, x, z, t, s = 0) {
    const k = (j * N + i) * 3;
    const y = pos[k + 1];
    // A skipped (hole) vertex still reads 0 from the buffer; fall back to the
    // field so the rim normals are right. Band-limited to the same step as the
    // vertices, or the normals describe a surface that is not the one drawn.
    return pos[k] === x && pos[k + 2] === z ? y : t.heightAt(x, z, s);
  }

  dispose() {
    for (const lv of this.levels) {
      for (const layer of lv.layers) {
        layer.geo.dispose();
        layer.mesh.parent?.remove(layer.mesh);
      }
    }
    this.levels.length = 0;
    this.root.parent?.remove(this.root);
  }
}

/** Tiny hash noise used only for mask/threshold jitter. */
function fastNoise(x, z) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  let fx = x - xi;
  let fz = z - zi;
  fx = fx * fx * (3 - 2 * fx);
  fz = fz * fz * (3 - 2 * fz);
  const hh = (a, b) => {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const a = hh(xi, zi);
  const b = hh(xi + 1, zi);
  const c = hh(xi, zi + 1);
  const d = hh(xi + 1, zi + 1);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}
