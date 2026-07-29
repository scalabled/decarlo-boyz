import * as THREE from 'three';

/**
 * City-scale visibility: hierarchical culling + LOD selection.
 *
 * WHY THIS EXISTS
 * ---------------
 * The frame loop's scene walk used to be `scene.traverseVisible(visit)` over a
 * 120 m corridor holding a few hundred objects. A streamed 3 km city is a
 * different problem in kind, not in degree:
 *
 *   - the graph is thousands of nodes deep in tiles that are mostly BEHIND the
 *     camera or past the draw distance, and `traverseVisible` pays for every
 *     one of them before three's own per-object frustum test ever runs;
 *   - three's per-object cull is a leaf test. It cannot answer "is this entire
 *     tile off screen" in less than one test per object in the tile;
 *   - `q.lodBias` has to actually select something, and three's own `LOD` picks
 *     its level from raw camera distance with no way to bias it.
 *
 * So `world` / `buildings` / `props` register the ROOT of each streamed tile
 * once, with its world bounding sphere, and one sphere-vs-frustum test then
 * decides the fate of everything under it. A tile that fails costs 4 dot
 * products instead of a full subtree walk.
 *
 * OWNERSHIP RULE. This only ever *hides* a group it can see, and it remembers
 * that it did. If the owning subsystem hides a root itself, that is respected
 * and never undone — the same "adopt the owner's value" convention the light
 * culler uses. Nothing here writes to an object it did not hide.
 *
 * FRUSTUM CONVENTION. The four side planes are extracted straight out of the
 * view-projection matrix (rows w±x, w±y), which are IDENTICAL under reversed-Z
 * and under the conventional mapping — the reversal only touches the z row. The
 * near/far test is done separately in metres against `drawDistance`, which is
 * what we actually want to cull against anyway: the projection's far plane is a
 * precision decision, the draw distance is an art one.
 */

const _sphere = new THREE.Sphere();
const _v = new THREE.Vector3();

export class SceneCuller {
  constructor() {
    /** 4 side planes, each (a,b,c,d) normalised, packed flat. */
    this.planes = new Float32Array(16);
    this.camPos = new THREE.Vector3();
    this.camDir = new THREE.Vector3(0, 0, -1);
    this.drawDistance = 1200;
    this.lodBias = 1;
    /** Screen-space scale: pixels per metre at 1 m. Drives the LOD policy. */
    this.pixelScale = 1000;

    this.groups = [];
    this._groupIndex = new Map();

    /** Diagnostics, read by the profiler and the debug HUD. */
    this.stats = {
      groups: 0,
      groupsVisible: 0,
      groupsCulledFrustum: 0,
      groupsCulledDistance: 0,
      lods: 0,
    };

    this._lodSeen = new Set();
  }

  /**
   * Register a hierarchical cull node — normally one streamed tile.
   *
   * @param {THREE.Object3D} object root of the subtree
   * @param {object} [opts]
   * @param {THREE.Vector3|number[]} [opts.center] world centre; defaults to the
   *        object's own world position, refreshed only if `dynamic` is set
   * @param {number} [opts.radius] world bounding radius in metres. REQUIRED for
   *        anything whose geometry does not describe its own extent (an
   *        InstancedMesh tile whose instance matrices spread far past its
   *        geometry's bounding sphere is the normal case).
   * @param {number} [opts.maxDistance] override the global draw distance, in
   *        metres — the hook a landmark uses to stay visible from across the
   *        river when ordinary street dressing does not.
   * @param {boolean} [opts.dynamic] re-read the world position every frame
   * @returns {() => void} unregister
   */
  add(object, opts = {}) {
    if (!object) return () => {};
    let entry = this._groupIndex.get(object);
    if (entry === undefined) {
      entry = {
        object,
        center: new THREE.Vector3(),
        radius: 1,
        maxDistance: 0,
        dynamic: false,
        hidden: false,
      };
      this.groups.push(entry);
      this._groupIndex.set(object, entry);
    }
    if (opts.center) {
      if (Array.isArray(opts.center)) entry.center.fromArray(opts.center);
      else entry.center.copy(opts.center);
    } else {
      object.updateWorldMatrix(true, false);
      entry.center.setFromMatrixPosition(object.matrixWorld);
    }
    entry.radius = Math.max(0.5, opts.radius ?? this._autoRadius(object));
    entry.maxDistance = opts.maxDistance ?? 0;
    entry.dynamic = opts.dynamic === true;
    return () => this.remove(object);
  }

  remove(object) {
    const entry = this._groupIndex.get(object);
    if (entry === undefined) return;
    if (entry.hidden) {
      entry.object.visible = true;
      entry.hidden = false;
    }
    this._groupIndex.delete(object);
    const i = this.groups.indexOf(entry);
    if (i >= 0) this.groups.splice(i, 1);
  }

  _autoRadius(object) {
    let r = 1;
    object.traverse((o) => {
      const g = o.geometry;
      if (!g) return;
      if (g.boundingSphere === null) g.computeBoundingSphere();
      const bs = g.boundingSphere;
      if (!bs) return;
      _sphere.copy(bs).applyMatrix4(o.matrixWorld);
      r = Math.max(r, _sphere.center.distanceTo(_v.setFromMatrixPosition(object.matrixWorld)) + _sphere.radius);
    });
    return r;
  }

  /** Extract this frame's planes. `vp` must be the UNJITTERED view-projection. */
  begin(camera, vp, drawDistance, lodBias, screenHeight) {
    this.drawDistance = drawDistance;
    this.lodBias = Math.max(0.05, lodBias || 1);
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(this.camDir);

    // Pixels a 1 m sphere covers at 1 m, for the LOD policy. Uses the vertical
    // FOV so it is resolution- and lens-correct rather than a magic constant.
    const tanV = Math.tan(THREE.MathUtils.degToRad((camera.fov || 60) * 0.5));
    this.pixelScale = (screenHeight || 1080) / (2 * Math.max(1e-4, tanV));

    const m = vp.elements;
    // Rows of the row-major VP: r0 = (m0,m4,m8,m12), r1 = (m1,m5,m9,m13),
    // r3 = (m3,m7,m11,m15).  left = r3+r0, right = r3-r0, bottom = r3+r1,
    // top = r3-r1.  None of these involve the z row, so reversed-Z is a no-op.
    const p = this.planes;
    this._setPlane(p, 0, m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]);
    this._setPlane(p, 1, m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]);
    this._setPlane(p, 2, m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]);
    this._setPlane(p, 3, m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]);

    this.stats.groups = this.groups.length;
    this.stats.groupsVisible = 0;
    this.stats.groupsCulledFrustum = 0;
    this.stats.groupsCulledDistance = 0;
    this.stats.lods = 0;
  }

  _setPlane(p, i, a, b, c, d) {
    const inv = 1 / Math.max(1e-12, Math.hypot(a, b, c));
    const o = i * 4;
    p[o] = a * inv;
    p[o + 1] = b * inv;
    p[o + 2] = c * inv;
    p[o + 3] = d * inv;
  }

  /** True if a world sphere survives the four side planes. */
  sphereVisible(cx, cy, cz, radius) {
    const p = this.planes;
    for (let i = 0; i < 4; i++) {
      const o = i * 4;
      if (p[o] * cx + p[o + 1] * cy + p[o + 2] * cz + p[o + 3] < -radius) return false;
    }
    return true;
  }

  /**
   * Apply the hierarchical cull. Call immediately before the scene walk.
   *
   * Distance is measured to the sphere's SURFACE, not its centre, so a 400 m
   * tile does not vanish because its origin crossed the draw distance.
   */
  update() {
    const dd = this.drawDistance;
    for (let i = 0; i < this.groups.length; i++) {
      const g = this.groups[i];
      const o = g.object;
      // The owner hid it themselves — respect that and stay out of the way.
      if (!g.hidden && o.visible === false) continue;
      if (g.dynamic) {
        o.updateWorldMatrix(true, false);
        g.center.setFromMatrixPosition(o.matrixWorld);
      }
      const c = g.center;
      let show = true;
      const far = g.maxDistance > 0 ? g.maxDistance : dd;
      if (this.camPos.distanceTo(c) - g.radius > far) {
        show = false;
        this.stats.groupsCulledDistance++;
      } else if (!this.sphereVisible(c.x, c.y, c.z, g.radius)) {
        show = false;
        this.stats.groupsCulledFrustum++;
      } else {
        this.stats.groupsVisible++;
      }
      if (show === g.hidden) {
        o.visible = show;
        g.hidden = !show;
      }
    }
  }

  /**
   * LOD level selection for a `THREE.LOD` encountered during the scene walk.
   *
   * Three's own `LOD.update()` compares raw camera distance against the level
   * thresholds, which means (a) `q.lodBias` cannot reach it and (b) the same
   * thresholds behave differently at 50 and 80 degrees of FOV and at 720p and
   * 4K. This divides the distance by the bias and by the projected size of a
   * screen pixel instead, so the *authored* distances stay in metres at a
   * nominal 1080p/60-degree frame and every other configuration scales off
   * them correctly. `lod.autoUpdate` is turned off the first time we see one so
   * the renderer does not overwrite the choice a moment later.
   *
   * `lod.userData.owLodScale` multiplies the thresholds for one object — the
   * per-landmark override.
   */
  updateLod(lod) {
    if (lod.autoUpdate !== false) lod.autoUpdate = false;
    const levels = lod.levels;
    if (levels === undefined || levels.length === 0) return;
    this.stats.lods++;

    _v.setFromMatrixPosition(lod.matrixWorld);
    const dist = this.camPos.distanceTo(_v);
    // 1080p at 60 degrees vertical is the authoring reference.
    const REF = 1080 / (2 * Math.tan(THREE.MathUtils.degToRad(30)));
    const scale =
      (this.lodBias * REF) / this.pixelScale / (lod.userData.owLodScale || 1);
    const d = dist * scale;

    let chosen = 0;
    for (let i = 1; i < levels.length; i++) {
      if (d >= levels[i].distance) chosen = i;
      else break;
    }
    for (let i = 0; i < levels.length; i++) {
      const obj = levels[i].object;
      const want = i === chosen;
      if (obj.visible !== want) obj.visible = want;
    }
  }

  dispose() {
    for (const g of this.groups) {
      if (g.hidden) {
        g.object.visible = true;
        g.hidden = false;
      }
    }
    this.groups.length = 0;
    this._groupIndex.clear();
  }
}
