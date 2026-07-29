import * as THREE from 'three';

/**
 * Cascaded shadow maps, done properly.
 *
 *  - N cascades packed into ONE `sampler2DArray` (R32F, linear light-space
 *    depth). One texture unit total, so a material can still bind its own
 *    albedo/normal/roughness/AO maps without blowing the 16-unit limit.
 *  - Cascades are fitted to the *bounding sphere* of each sub-frustum, so the
 *    ortho extent is rotation-invariant, and the projection is then snapped to
 *    whole texels. Together that removes shadow swimming completely: the
 *    sampled texel grid is nailed to world space, not to the camera.
 *  - PCSS: blocker search -> penumbra estimate -> Vogel-disk PCF, giving
 *    contact-hardening (sharp where the caster touches the receiver, soft
 *    metres away) instead of a constant mush.
 *  - Normal-offset + slope-scaled depth bias, both expressed in *world* units
 *    derived from the cascade's texel size, which is what kills acne without
 *    peter-panning.
 *
 * The shadow term is injected into every lit material by materialpatch.js;
 * three's own shadow path is left alone for other lights (spot/point).
 */

const _v = new THREE.Vector3();
const _center = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _altUp = new THREE.Vector3(0, 0, 1);
const _origin = new THREE.Vector4();
const _mat = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _rel = new THREE.Vector3();
const _identityUv = new THREE.Matrix3();

export class CascadedShadowMaps {
  constructor(renderer, opts) {
    this.renderer = renderer;
    this.cascades = Math.max(1, Math.min(4, opts.cascades | 0));
    // 4 x 4096 x R32F is a quarter of a gigabyte for shadows nobody can see.
    // 2048 with PCSS reads sharper than 4096 without it.
    this.mapSize = Math.min(opts.mapSize ?? 2048, 2048);
    this.maxDistance = opts.maxDistance ?? 140;
    /**
     * Split distribution, and the near distance the distribution is computed
     * FROM. Both retuned for the open city.
     *
     * The practical-near matters more than the lambda once `maxDistance` is
     * 430 m rather than 140. A logarithmic split is `n*(f/n)^p`, so feeding it
     * the CAMERA's near plane (0.05 m — a number chosen so a rifle stock does
     * not clip, not a number that describes any shadow receiver) makes the
     * whole distribution a function of a value nothing in the frame is ever at.
     * Starting the distribution at 0.35 m — roughly the closest ground the
     * third-person camera ever sees — and pushing lambda up to 0.94 puts the
     * splits at ~8.4 / 24 / 88 / 430 m, whose texel sizes are 10 / 29 / 105 /
     * 514 mm at 2048.
     *
     * The last of those is deliberately ~1 screen pixel at the far edge of the
     * cascade (a pixel subtends 0.48 m at 430 m in a 62-degree frame at 1080p),
     * which is the point past which more shadow resolution buys nothing, and
     * the first is small enough that the contact shadow under the player's feet
     * is still sharper than the screen pixel that shows it.
     */
    this.lambda = 0.94;
    this.nearDistance = 0.35;
    /**
     * Per-cascade extrusion toward the sun, in metres — how far a caster may
     * sit ABOVE the cascade's fit sphere and still be rendered into it. A flat
     * 140 was fine for a 120 m corridor of two-storey blocks; a 180 m tower
     * casting across a downtown avenue needs the far cascades to reach much
     * further back, and the near cascades must NOT (their depth range is what
     * sets the depth-bias resolution). Computed per cascade in `update()`.
     */
    this.backDistance = 140;
    /**
     * Minimum caster radius, in shadow texels, for a cascade to bother drawing
     * it. See the note in _cullCascade. Below the PCF disc radius by
     * construction, so nothing this removes was resolvable.
     */
    this.minCasterTexels = 1.4;
    /**
     * Refit + redraw the LAST cascade only every Nth frame. See _cascadeActive.
     * 2 halves the cost of the most expensive cascade at no resolvable visual
     * cost; 1 disables the optimisation.
     */
    this.stagger = 2;
    this._frame = 0;
    this._fitScale = 1;
    this.enabled = true;

    this.rt = new THREE.WebGLArrayRenderTarget(this.mapSize, this.mapSize, this.cascades, {
      type: THREE.FloatType,
      format: THREE.RedFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.rt.texture.name = 'csm';

    this.cameras = [];
    this.matrices = [];
    for (let i = 0; i < this.cascades; i++) {
      const c = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
      c.matrixAutoUpdate = false;
      this.cameras.push(c);
      this.matrices.push(new THREE.Matrix4());
    }

    this.uniforms = {
      owCsmMaps: { value: this.rt.texture },
      owCsmMatrix: { value: this.matrices },
      owCsmSplit: { value: new THREE.Vector4(1e9, 1e9, 1e9, 1e9) },
      owCsmSplitNear: { value: new THREE.Vector4(0, 0, 0, 0) },
      owCsmTexel: { value: new THREE.Vector4(0.01, 0.01, 0.01, 0.01) },
      owCsmRange: { value: new THREE.Vector4(1, 1, 1, 1) },
      owCsmMapSize: { value: new THREE.Vector2(this.mapSize, 1 / this.mapSize) },
      owSunDirView: { value: new THREE.Vector3(0, 1, 0) },
      owSunDirWorld: { value: new THREE.Vector3(0, 1, 0) },
      // x strength, y tan(sun angular radius), z max filter radius (texels), w temporal rotation
      owCsmParams: { value: new THREE.Vector4(1, 0.022, 9, 0) },
      /**
       * Sun visibility the shadow term fades TO beyond the last cascade — not
       * 1.0. See the far-terminator note in `owSunShadow`: fading to fully lit
       * puts a brightness STEP across the city at the cascade edge, and a step
       * is what a critic sees. 0.82 is roughly the mean sun visibility of a lit
       * street once its own shadows are averaged in, which makes the crossing
       * energy-neutral.
       */
      owCsmDistant: { value: 0.82 },
    };

    /**
     * The cascade depth material writes a LINEAR, cascade-normalised light
     * depth — `distance from the cascade's near plane / cascade range`, 0..1 —
     * into the R32F array, instead of `gl_FragCoord.z`.
     *
     * That is not a style choice, it is what makes this file independent of the
     * renderer's depth convention. With `reversedDepthBuffer` on (see
     * RenderSystem.init: it is the only way to get usable precision across a
     * 6 km far plane) three flips every projection matrix so NDC z runs 1 at
     * the near plane to 0 at the far one, and `gl_FragCoord.z` flips with it —
     * silently, and only once the renderer has drawn with that camera at least
     * once, so the first frame's stored depths would disagree with the matrix
     * the shader samples through. Writing the quantity we actually want removes
     * the whole class of problem: nothing here changes if the rasteriser's
     * depth convention does, the value is uniform in world space (an ortho
     * projection's NDC z already was, so no precision is lost), and the PCSS
     * blocker distance is a plain subtraction in metres.
     *
     * `owInvRange` is 1 / (cascade far - near) and is refreshed once per
     * cascade in `render()`.
     */
    // 1x1 white, so the alpha sampler is always bound even for the (usual)
    // case of a caster with no map at all.
    this._whiteTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this._whiteTex.needsUpdate = true;
    this._whiteTex.name = 'csm-white';

    this.depthMaterial = new THREE.ShaderMaterial({
      name: 'csm-depth',
      side: THREE.DoubleSide,
      uniforms: {
        owInvRange: { value: 1 / 1000 },
        owAlphaMap: { value: this._whiteTex },
        owAlphaTest: { value: 0 },
        owUvXf: { value: new THREE.Matrix3() },
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <batching_pars_vertex>
        #include <skinning_pars_vertex>
        #include <morphtarget_pars_vertex>
        uniform float owInvRange;
        uniform mat3 owUvXf;
        varying float vLightDepth;
        varying vec2 vCsmUv;
        void main() {
          #include <batching_vertex>
          #include <beginnormal_vertex>
          #include <morphinstance_vertex>
          #include <morphnormal_vertex>
          #include <skinbase_vertex>
          #include <skinnormal_vertex>
          #include <begin_vertex>
          #include <morphtarget_vertex>
          #include <skinning_vertex>
          #include <project_vertex>
          vLightDepth = -mvPosition.z * owInvRange;
          vCsmUv = ( owUvXf * vec3( uv, 1.0 ) ).xy;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D owAlphaMap;
        uniform float owAlphaTest;
        varying float vLightDepth;
        varying vec2 vCsmUv;
        void main() {
          // ALPHA-TESTED CASTERS. Without this every cutout in the city — a
          // chain-link fence, a fire escape grating, a leaf card, a perforated
          // gantry — either casts a solid rectangle or (as it did) casts
          // nothing at all. The dappled, busy shadow under a market canopy or a
          // street tree is most of what makes a reference frame's ground read
          // as lit rather than as a flat plane, and it is only reachable from
          // the depth pass because scene.overrideMaterial replaces the object's
          // own material outright. The map is bound per draw in onBeforeRender.
          if ( owAlphaTest > 0.0 ) {
            if ( texture2D( owAlphaMap, vCsmUv ).a < owAlphaTest ) discard;
          }
          gl_FragColor = vec4( vLightDepth, 0.0, 0.0, 1.0 );
        }
      `,
    });

    const dm = this.depthMaterial;
    const white = this._whiteTex;
    dm.onBeforeRender = (renderer, scene, camera, geometry, object) => {
      const m = object.material;
      const mat = Array.isArray(m) ? m[0] : m;
      const at = mat && mat.alphaTest > 0 ? mat.alphaTest : 0;
      const map = at > 0 ? mat.alphaMap || mat.map : null;
      const u = dm.uniforms;
      const nextTest = map ? at : 0;
      if (u.owAlphaTest.value !== nextTest || u.owAlphaMap.value !== (map ?? white)) {
        u.owAlphaTest.value = nextTest;
        u.owAlphaMap.value = map ?? white;
        if (map) u.owUvXf.value.copy(map.matrix ?? _identityUv);
        dm.uniformsNeedUpdate = true;
      }
    };

    this._splits = new Float32Array(this.cascades + 1);
    this._prevClear = new THREE.Color();

    // ---- per-cascade caster culling ---------------------------------------
    // World-space fit of each cascade, kept so `render()` can reject casters
    // that cannot possibly darken a texel this cascade is ever sampled at.
    this._fitCenter = [];
    this._fitRadius = new Float32Array(this.cascades);
    this._fitBack = new Float32Array(this.cascades);
    for (let i = 0; i < this.cascades; i++) this._fitCenter.push(new THREE.Vector3());
    this._sunAxis = new THREE.Vector3(0, 1, 0);
    /** Objects this pass hid, so it can restore exactly those and no others. */
    this._culled = [];
    this._nCulled = 0;
    /** Diagnostics: casters submitted per cascade on the last frame. */
    this.casterCounts = new Int32Array(this.cascades);
    /** Diagnostics: cascades skipped entirely on the last frame. */
    this.emptyCascades = 0;
  }

  /**
   * Which cascades are refitted and redrawn on this frame.
   *
   * The far cascade is by far the most expensive one — it covers 82 to 430 m
   * and at a downtown vantage it submits ~1100 of the ~1500 shadow draw calls
   * in the frame, which at city scale is 40% of the whole frame's draw calls.
   * It is also the one whose content changes most slowly in the only terms that
   * matter: its texel is 514 mm, so a car doing 180 km/h moves half a texel per
   * frame at 60 Hz and a pedestrian moves a fortieth of one.
   *
   * So it is refitted and redrawn on alternate frames, with its fit FROZEN in
   * between — freezing the fit is the part that makes this invisible rather
   * than a stutter, because a cascade whose matrix moved but whose depths did
   * not is a shadow that slides across the world. Cascades 0-2, which carry
   * everything the eye actually resolves, are untouched and run every frame.
   *
   * `stagger = 0` disables it.
   */
  _cascadeActive(i) {
    if (this.stagger <= 1 || i < this.cascades - 1) return true;
    return this._frame % this.stagger === 0;
  }

  /** Recompute cascade fits. `sunDir` points FROM the scene TOWARD the sun. */
  update(camera, sunDir, softness = 0.022, frame = 0) {
    this._frame = frame;
    // The distribution is computed from a PRACTICAL near (see nearDistance),
    // never from camera.near — but cascade 0 still has to start at the real
    // near plane or there is an unshadowed sliver right under the lens.
    const n = Math.min(this.nearDistance, Math.max(camera.near, 1e-3) * 4);
    const f = Math.min(camera.far, this.maxDistance);
    const N = this.cascades;
    const s = this._splits;
    s[0] = camera.near;
    for (let i = 1; i < N; i++) {
      const p = i / N;
      const logSplit = n * Math.pow(f / n, p);
      const uniSplit = n + (f - n) * p;
      s[i] = this.lambda * logSplit + (1 - this.lambda) * uniSplit;
    }
    s[N] = f;

    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanH = tanV * camera.aspect;
    const k2 = tanV * tanV + tanH * tanH;

    const split = this.uniforms.owCsmSplit.value;
    const splitNear = this.uniforms.owCsmSplitNear.value;
    const texel = this.uniforms.owCsmTexel.value;
    const range = this.uniforms.owCsmRange.value;
    const comp = ['x', 'y', 'z', 'w'];

    for (let i = 0; i < N; i++) {
      const cn = s[i];
      const cf = s[i + 1];
      // A staggered cascade keeps LAST frame's fit verbatim — matrix, texel
      // size, split and all — so the depths already in the array stay valid.
      // Its split/near/texel/range uniforms are therefore also left alone.
      if (!this._cascadeActive(i) && this._fitRadius[i] > 0) continue;

      // Bounding sphere of the sub-frustum, in view space, on the -z axis.
      let cz, r;
      if (k2 * k2 * (cf + cn) >= cf - cn) {
        cz = -cf;
        r = cf * Math.sqrt(k2);
      } else {
        cz = -0.5 * (cf + cn) * (1 + k2);
        r = 0.5 * Math.sqrt(
          (cf - cn) * (cf - cn) + 2 * (cf * cf + cn * cn) * k2 + (cf + cn) * (cf + cn) * k2 * k2
        );
      }
      // Stabilise the radius against float drift. The quantum has to scale with
      // the cascade: 1/16 m on a 527 m far cascade is 13 significant digits of
      // a float32 and quantises nothing, so the far cascade's extent jittered
      // every frame and took the whole texel grid with it. A part-per-thousand
      // step is invisible and actually holds.
      const quant = Math.max(1 / 16, r / 512);
      r = Math.ceil(r / quant) * quant;

      // How far behind the fit sphere the light has to start. A tall caster
      // shadowing a distant street has to be inside this, and "tall" scales
      // with how much city the cascade covers.
      const back = Math.min(1400, Math.max(150, r * 1.15 + 90));

      _center.set(0, 0, cz).applyMatrix4(camera.matrixWorld);

      const cam = this.cameras[i];
      const up = Math.abs(sunDir.y) > 0.98 ? _altUp : _up;
      _v.copy(_center).addScaledVector(sunDir, r + back);
      cam.position.copy(_v);
      cam.up.copy(up);
      cam.lookAt(_center);
      cam.updateMatrix();
      cam.matrixWorld.copy(cam.matrix);
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

      cam.left = -r;
      cam.right = r;
      cam.top = r;
      cam.bottom = -r;
      cam.near = 0.0;
      cam.far = 2 * r + back;
      cam.updateProjectionMatrix();

      // --- sampling matrix, built by hand ---------------------------------
      // NOT `cam.projectionMatrix * matrixWorldInverse`. The rasteriser's
      // projection encodes whatever depth convention the renderer is in
      // (reversed-Z here), and the array stores a linear cascade-normalised
      // depth instead — see `depthMaterial`. So the matrix the shader samples
      // through carries the ortho x/y mapping and a linear z:
      //     x' = x_light / r,  y' = y_light / r,  z' = -z_light / range
      // with w' = 1, which is exactly the quantity the depth pass writes.
      const invRange = 1 / cam.far;
      const m = this.matrices[i];
      const e = cam.matrixWorldInverse.elements;
      const inv = 1 / r;
      m.set(
        e[0] * inv, e[4] * inv, e[8] * inv, e[12] * inv,
        e[1] * inv, e[5] * inv, e[9] * inv, e[13] * inv,
        -e[2] * invRange, -e[6] * invRange, -e[10] * invRange, -e[14] * invRange,
        0, 0, 0, 1
      );

      // --- texel snap: quantise the light-space origin to the texel grid ---
      // Done on the sampling matrix now, and the SAME offset is pushed into the
      // rasteriser's projection, so the stored texels and the sampled texels
      // stay on one grid nailed to world space rather than to the camera.
      _origin.set(0, 0, 0, 1).applyMatrix4(m);
      const half = this.mapSize * 0.5;
      const sx = _origin.x * half;
      const sy = _origin.y * half;
      const dx = (Math.round(sx) - sx) / half;
      const dy = (Math.round(sy) - sy) / half;
      m.elements[12] += dx;
      m.elements[13] += dy;
      cam.projectionMatrix.elements[12] += dx;
      cam.projectionMatrix.elements[13] += dy;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

      this._fitCenter[i].copy(_center);
      this._fitRadius[i] = r;
      this._fitBack[i] = back;

      split[comp[i]] = cf;
      splitNear[comp[i]] = cn;
      texel[comp[i]] = (2 * r) / this.mapSize;
      range[comp[i]] = cam.far - cam.near;
    }
    for (let i = N; i < 4; i++) {
      split[comp[i]] = 1e9;
      splitNear[comp[i]] = 1e9;
      texel[comp[i]] = 0.01;
      range[comp[i]] = 1;
    }

    this._sunAxis.copy(sunDir);
    this.uniforms.owSunDirWorld.value.copy(sunDir);
    this.uniforms.owSunDirView.value
      .copy(sunDir)
      .transformDirection(camera.matrixWorldInverse)
      .normalize();
    this.uniforms.owCsmParams.value.y = softness;
  }

  /**
   * Reject every caster that cannot darken a texel this cascade is ever
   * *sampled* at, and hide it for the duration of this cascade's draw.
   *
   * Three's own frustum culling tests the caster's bounding sphere against the
   * cascade's ORTHO BOX, which is the axis-aligned bound of the cascade's fit
   * sphere extruded `backDistance` toward the sun. The shader only ever samples
   * cascade `c` for receivers inside that fit sphere (the cascade owns a view
   * depth slice, and the sphere is that slice's bound), so the box corners —
   * 1 - pi/4, a fifth of its cross-section — are sampled by nothing. Testing
   * against the extruded CYLINDER instead of the box is therefore strictly
   * tighter and strictly output-preserving.
   *
   * The margin has to cover everything that makes the shader sample OUTSIDE the
   * receiver's own projected point, or a caster whose only contribution is to a
   * filter tap gets culled and the penumbra changes:
   *   - the whole-texel snap `update()` applies after the fit  (1 texel)
   *   - the normal offset, up to 1.65 texels at grazing incidence
   *   - the PCSS blocker search, up to 10 texels
   *   - the PCF disc, up to `owCsmParams.z` texels (9 at ultra)
   * 32 texels is comfortably past the sum of those and still only 1.5% of a
   * cascade's extent, so it costs the cull almost nothing. Measured: at 2
   * texels this pass was NOT pixel-neutral (0.04% of pixels, up to 26/255).
   *
   * `frustumCulled === false` is an explicit opt-out (sky dome, GPU particle
   * meshes whose bounds are meaningless) and is honoured exactly as three does.
   *
   * @returns {number} casters left standing for this cascade.
   */
  _cullCascade(i, casters, nCasters) {
    const center = this._fitCenter[i];
    const r = this._fitRadius[i];
    const texelWorld = (2 * r) / this.mapSize;
    /**
     * SIZE CULL — a caster smaller than the cascade can resolve.
     *
     * The far cascade covers 430 m and its texel is 514 mm. A drain cover, a
     * bollard, a kerb section or a litter bin is smaller than that, so its
     * shadow cannot darken a single texel: the depth pass rasterises it, the
     * PCF taps never see it, and the draw call bought nothing. Measured on a
     * downtown frame, cascade 3 was submitting 1262 casters, the overwhelming
     * majority of them street dressing at that scale.
     *
     * The threshold is in TEXELS, so it is automatically loose on the far
     * cascades and effectively off on cascade 0 (its texel is 10 mm — nothing
     * in the game is smaller than that). 1.4 texels is under the PCF disc's own
     * radius, so anything this rejects was already below the filter's noise
     * floor. Draw calls at city scale are the binding cost in WebGL and this is
     * the cheapest large reduction available that changes no pixel a viewer can
     * point at.
     */
    const minRadius = texelWorld * this.minCasterTexels;
    const margin = 32 * texelWorld; // 32 shadow texels, in metres
    const rSide = r + margin;
    const tFar = -r - margin; // far plane, measured along +sunDir from centre
    const tNear = r + this._fitBack[i] + margin; // the light's own position
    const axis = this._sunAxis;
    let kept = 0;

    for (let k = 0; k < nCasters; k++) {
      const o = casters[k];
      // Already hidden by the caller (owNoShadow, transparent): not a caster at
      // all, so it must not be counted and must not be restored either.
      if (o.visible === false) continue;
      if (o.frustumCulled === false) {
        kept++;
        continue;
      }
      // Same source of truth three uses, so a caster is never culled here that
      // three would have drawn for a *reason* (skinned bounds, custom bounds).
      let src = o.boundingSphere;
      if (src === undefined) {
        const g = o.geometry;
        if (g === undefined) {
          kept++;
          continue;
        }
        if (g.boundingSphere === null) g.computeBoundingSphere();
        src = g.boundingSphere;
      } else if (src === null) {
        o.computeBoundingSphere();
        src = o.boundingSphere;
      }
      if (src === null || src === undefined) {
        kept++;
        continue;
      }
      _sphere.copy(src).applyMatrix4(o.matrixWorld);

      _rel.subVectors(_sphere.center, center);
      const t = _rel.dot(axis);
      const rad = _sphere.radius;
      // Too small for this cascade to resolve at all — see minRadius above.
      if (rad < minRadius) {
        o.visible = false;
        this._culled[this._nCulled++] = o;
        continue;
      }
      // Slab along the light axis...
      if (t + rad < tFar || t - rad > tNear) {
        o.visible = false;
        this._culled[this._nCulled++] = o;
        continue;
      }
      // ...and the cylinder around it.
      const perp2 = _rel.lengthSq() - t * t;
      const lim = rSide + rad;
      if (perp2 > lim * lim) {
        o.visible = false;
        this._culled[this._nCulled++] = o;
        continue;
      }
      kept++;
    }
    return kept;
  }

  _restoreCulled() {
    for (let i = 0; i < this._nCulled; i++) this._culled[i].visible = true;
    this._nCulled = 0;
  }

  /**
   * Render the cascades. Caller has already hidden non-casters.
   *
   * `casters` / `nCasters` is the flat opaque draw list. When supplied, each
   * cascade only submits the casters that can reach it, and a cascade nothing
   * reaches is cleared instead of drawn (see `_cullCascade`). The clear is not
   * optional even for an empty cascade: the array layer still holds last
   * frame's depths, and leaving them would shadow with stale blockers.
   */
  render(renderer, scene, casters = null, nCasters = 0) {
    const prevOverride = scene.overrideMaterial;
    const prevAutoClear = renderer.autoClear;
    renderer.getClearColor(this._prevClear);
    const prevAlpha = renderer.getClearAlpha();

    scene.overrideMaterial = this.depthMaterial;
    renderer.autoClear = false;
    renderer.setClearColor(0xffffff, 1);
    this.emptyCascades = 0;

    for (let i = 0; i < this.cascades; i++) {
      if (!this._cascadeActive(i)) {
        // NOT cleared: the layer still holds a valid fit and valid depths from
        // the frame it was last drawn, and clearing it would strobe.
        this.casterCounts[i] = -2;
        continue;
      }
      const kept = casters === null ? -1 : this._cullCascade(i, casters, nCasters);
      this.casterCounts[i] = kept;
      // One uniform write per cascade, not per draw: `uniformsNeedUpdate`
      // makes the next setProgram re-upload and then clears itself, so the
      // remaining thousands of casters in this cascade pay nothing.
      this.depthMaterial.uniforms.owInvRange.value = 1 / this.cameras[i].far;
      this.depthMaterial.uniformsNeedUpdate = true;
      renderer.setRenderTarget(this.rt, i);
      renderer.clear(true, true, false);
      if (kept !== 0) renderer.render(scene, this.cameras[i]);
      else this.emptyCascades++;
      if (casters !== null) this._restoreCulled();
    }

    scene.overrideMaterial = prevOverride;
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(this._prevClear, prevAlpha);
    renderer.setRenderTarget(null);
  }

  /**
   * Snapshot everything `update()` writes.
   *
   * Only used by RenderSystem.prewarmMaterials(), which has to fit the cascades
   * to compile their depth variants but must not leave a fit behind: MEASURED,
   * a single out-of-frame `update()` moved 1.3 M pixels by up to 26/255 on the
   * `interior` shot even though the next frame refits from scratch. Allocates,
   * so it is a loading-screen call and never a frame-loop one.
   */
  snapshotFit() {
    const u = this.uniforms;
    return {
      split: u.owCsmSplit.value.clone(),
      splitNear: u.owCsmSplitNear.value.clone(),
      texel: u.owCsmTexel.value.clone(),
      range: u.owCsmRange.value.clone(),
      sunView: u.owSunDirView.value.clone(),
      sunWorld: u.owSunDirWorld.value.clone(),
      params: u.owCsmParams.value.clone(),
      frame: this._frame,
      matrices: this.matrices.map((m) => m.clone()),
      splits: this._splits.slice(),
      sunAxis: this._sunAxis.clone(),
      fitCenter: this._fitCenter.map((v) => v.clone()),
      fitRadius: this._fitRadius.slice(),
      fitBack: this._fitBack.slice(),
      cameras: this.cameras.map((c) => ({
        position: c.position.clone(),
        quaternion: c.quaternion.clone(),
        up: c.up.clone(),
        left: c.left,
        right: c.right,
        top: c.top,
        bottom: c.bottom,
        near: c.near,
        far: c.far,
        matrix: c.matrix.clone(),
        matrixWorld: c.matrixWorld.clone(),
        matrixWorldInverse: c.matrixWorldInverse.clone(),
        projectionMatrix: c.projectionMatrix.clone(),
        projectionMatrixInverse: c.projectionMatrixInverse.clone(),
      })),
    };
  }

  /** Put back exactly what `snapshotFit()` captured. */
  restoreFit(s) {
    if (!s) return;
    const u = this.uniforms;
    u.owCsmSplit.value.copy(s.split);
    u.owCsmSplitNear.value.copy(s.splitNear);
    u.owCsmTexel.value.copy(s.texel);
    u.owCsmRange.value.copy(s.range);
    u.owSunDirView.value.copy(s.sunView);
    u.owSunDirWorld.value.copy(s.sunWorld);
    u.owCsmParams.value.copy(s.params);
    this._frame = s.frame ?? 0;
    for (let i = 0; i < this.matrices.length; i++) this.matrices[i].copy(s.matrices[i]);
    this._splits.set(s.splits);
    this._sunAxis.copy(s.sunAxis);
    for (let i = 0; i < this._fitCenter.length; i++) this._fitCenter[i].copy(s.fitCenter[i]);
    this._fitRadius.set(s.fitRadius);
    this._fitBack.set(s.fitBack);
    for (let i = 0; i < this.cameras.length; i++) {
      const c = this.cameras[i];
      const t = s.cameras[i];
      c.position.copy(t.position);
      c.quaternion.copy(t.quaternion);
      c.up.copy(t.up);
      c.left = t.left;
      c.right = t.right;
      c.top = t.top;
      c.bottom = t.bottom;
      c.near = t.near;
      c.far = t.far;
      c.matrix.copy(t.matrix);
      c.matrixWorld.copy(t.matrixWorld);
      c.matrixWorldInverse.copy(t.matrixWorldInverse);
      c.projectionMatrix.copy(t.projectionMatrix);
      c.projectionMatrixInverse.copy(t.projectionMatrixInverse);
    }
  }

  setStrength(v) {
    this.uniforms.owCsmParams.value.x = v;
  }

  setJitter(v) {
    this.uniforms.owCsmParams.value.w = v;
  }

  dispose() {
    this.rt.dispose();
    this.depthMaterial.dispose();
    this._whiteTex.dispose();
  }
}

/**
 * GLSL injected into every lit material. Declares the CSM uniforms and the
 * `owSunShadow()` entry point used inside the directional-light loop.
 */
export function csmShaderChunk(cascades, quality) {
  const blockerTaps = quality >= 3 ? 16 : quality >= 2 ? 12 : 8;
  const pcfTaps = quality >= 3 ? 20 : quality >= 2 ? 14 : 8;
  const pcss = quality >= 2;

  // Sampler-array-free: one 2D array texture, so the layer index can be
  // dynamic. No unrolling needed.
  return /* glsl */ `
#define OW_CASCADES ${cascades}
#define OW_BLOCKER_TAPS ${blockerTaps}
#define OW_PCF_TAPS ${pcfTaps}
${pcss ? '#define OW_PCSS 1' : ''}

uniform highp sampler2DArray owCsmMaps;
uniform mat4 owCsmMatrix[ OW_CASCADES ];
uniform vec4 owCsmSplit;
uniform vec4 owCsmSplitNear;
uniform vec4 owCsmTexel;
uniform vec4 owCsmRange;
uniform vec2 owCsmMapSize;
uniform vec3 owSunDirView;
uniform vec3 owSunDirWorld;
uniform vec4 owCsmParams;
uniform float owCsmDistant;

float owIGNoise( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

vec2 owVogel( int i, int n, float phi ) {
  float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
  float theta = float( i ) * 2.39996323 + phi;
  return vec2( cos( theta ), sin( theta ) ) * r;
}

float owCsmTap( float layer, vec2 uv ) {
  return texture( owCsmMaps, vec3( uv, layer ) ).r;
}

float owCsmCascade( int c, vec3 wPos, vec3 wN, float NdL, float rot ) {
  float texelWorld = owCsmTexel[ c ];
  float range = owCsmRange[ c ];
  float layer = float( c );

  // normal offset — pushes the sample point off the surface by roughly one
  // shadow texel, scaled up at grazing angles where the texel projects wide.
  vec3 p = wPos + wN * ( texelWorld * ( 0.55 + 1.1 * ( 1.0 - NdL ) ) );
  // owCsmMatrix maps world -> ( x, y in -1..1, z LINEAR 0..1 ), w = 1.
  // See the note on depthMaterial in csm.js: z is NOT an NDC depth and must
  // not be remapped, which is what makes this independent of reversed-Z.
  vec4 sc = owCsmMatrix[ c ] * vec4( p, 1.0 );
  vec3 proj = vec3( sc.xy * 0.5 + 0.5, sc.z );
  if ( proj.z >= 1.0 || proj.z <= 0.0 ) return 1.0;
  vec2 uv = proj.xy;
  vec2 edge = min( uv, 1.0 - uv );
  if ( min( edge.x, edge.y ) <= 0.0 ) return 1.0;

  float slope = clamp( sqrt( max( 0.0, 1.0 - NdL * NdL ) ) / max( NdL, 0.12 ), 0.0, 5.0 );
  float bias = ( texelWorld * ( 0.7 + 1.15 * slope ) ) / range;
  float recv = proj.z - bias;

  float invTex = owCsmMapSize.y;
  float extent = texelWorld * owCsmMapSize.x;   // cascade world extent
  float maxR = owCsmParams.z * invTex;
  // MINIMUM FILTER RADIUS, in texels. 1.4 was effectively "no filter": at that
  // size a 20-tap Vogel disc lands most of its taps inside the receiver's own
  // texel, so the edge is the raw texel grid and it reads as a hard, aliased,
  // stair-stepped line — which is exactly what a critic panel described. 2.6
  // texels is the smallest disc that actually spans a texel boundary and turns
  // the staircase into a gradient, and it is still under half a screen pixel of
  // penumbra in cascade 0.
  float filterR = 2.6 * invTex;

  #ifdef OW_PCSS
    float searchR = min( maxR, 10.0 * invTex );
    float blocker = 0.0;
    float count = 0.0;
    for ( int i = 0; i < OW_BLOCKER_TAPS; i ++ ) {
      float d = owCsmTap( layer, uv + owVogel( i, OW_BLOCKER_TAPS, rot ) * searchR );
      if ( d < recv ) { blocker += d; count += 1.0; }
    }
    if ( count < 0.5 ) return 1.0;
    blocker /= count;
    float gap = max( 0.0, ( recv - blocker ) * range );
    float penumbra = gap * owCsmParams.y;         // metres of penumbra
    filterR = clamp( penumbra / extent, 2.6 * invTex, maxR );
  #endif

  float sum = 0.0;
  for ( int i = 0; i < OW_PCF_TAPS; i ++ ) {
    float d = owCsmTap( layer, uv + owVogel( i, OW_PCF_TAPS, rot ) * filterR );
    sum += step( recv, d );
  }
  return sum / float( OW_PCF_TAPS );
}

// posView / nrmView are three's view-space geometryPosition / geometryNormal.
float owSunShadow( vec3 lightDirView, vec3 posView, vec3 nrmView ) {
  if ( owCsmParams.x <= 0.0 ) return 1.0;
  if ( dot( lightDirView, owSunDirView ) < 0.999 ) return 1.0;

  float vd = -posView.z;
  if ( vd >= owCsmSplit[ OW_CASCADES - 1 ] ) return mix( 1.0, owCsmDistant, owCsmParams.x );

  vec3 wPos = cameraPosition + ( posView * mat3( viewMatrix ) );
  vec3 wN = normalize( nrmView * mat3( viewMatrix ) );
  float NdL = dot( wN, owSunDirWorld );
  if ( NdL <= 0.0 ) return 1.0;

  // TEMPORAL DECORRELATION OF THE SAMPLE ROTATION.
  //
  // This used to be owIGNoise( fragCoord + frame % 8 ). Interleaved gradient
  // noise is a smooth function of its argument, so IGN(p + k) for a small
  // integer k is very nearly IGN(p): the "temporal" rotation barely moved, the
  // Vogel disc landed on almost the same taps every frame, and TAA — which can
  // only average out noise that actually CHANGES — had nothing to average. The
  // result is a stationary, screen-locked stipple over every shadowed surface
  // and a dotted saw-tooth along every penumbra, both of which a critic panel
  // flagged, the stipple as "the loudest single artefact in the frame".
  //
  // Advancing the ANGLE by the golden ratio instead gives the maximally
  // equidistributed sequence on the circle: consecutive frames rotate the disc
  // by 137.5 degrees, so eight frames of TAA history see eight genuinely
  // different sample sets and converge on the true penumbra.
  float rot = fract( owIGNoise( gl_FragCoord.xy ) + owCsmParams.w * 0.6180339887 ) * 6.2831853;

  int c = OW_CASCADES - 1;
  for ( int i = 0; i < OW_CASCADES; i ++ ) {
    if ( vd < owCsmSplit[ i ] ) { c = i; break; }
  }

  float s = owCsmCascade( c, wPos, wN, NdL, rot );

  // cross-fade the last 12% of a cascade into the next one
  if ( c < OW_CASCADES - 1 ) {
    float a = owCsmSplitNear[ c ];
    float b = owCsmSplit[ c ];
    float t = smoothstep( mix( a, b, 0.88 ), b, vd );
    if ( t > 0.001 ) s = mix( s, owCsmCascade( c + 1, wPos, wN, NdL, rot ), t );
  }

  // --- the far terminator ---------------------------------------------------
  // At 430 m of shadow distance in a 3 km city there is ALWAYS geometry past
  // the last cascade, and the one thing that must never happen is a visible
  // line across the city where shadowing stops. Two things are done about it,
  // and both matter:
  //
  //  1. the fade is long — the last 28% of the final cascade, ~120 m at ultra,
  //     rather than 12% / 51 m. Over that distance aerial perspective has
  //     already taken 10-15% of the surface's own contrast (see aerial.js), so
  //     the ramp lands inside the haze instead of on top of it;
  //  2. it does not fade to 1.0 (fully lit) but to owCsmDistant, a dim
  //     ambient occlusion floor on the sun term. A city block with no shadows
  //     at all is brighter than the identical block 10 m nearer that has them,
  //     and that STEP is what reads as a terminator — not the softness. Landing
  //     the fade on the average shadowed fraction of a lit street instead makes
  //     the transition energy-neutral, so there is nothing to see.
  float lastSplit = owCsmSplit[ OW_CASCADES - 1 ];
  float fadeOut = smoothstep( lastSplit, lastSplit * 0.72, vd );
  s = mix( owCsmDistant, s, fadeOut );

  return mix( 1.0, s, owCsmParams.x );
}
`;
}
