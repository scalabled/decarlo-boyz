import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { floatDepth, floatType } from './pass.js';

/**
 * Depth / normal / velocity prepass.
 *
 * Three MRT attachments:
 *   0  RGBA16F  octahedral view normal (xy), coverage (z), material id (w)
 *   1  RG16F    screen-space velocity as a UV delta (current - previous)
 *   2  R32F     linear view depth in metres (positive)
 *
 * Coverage is 1.0 for ordinary geometry and OW_COVERAGE_DYNAMIC (0.7) for
 * geometry whose *vertices* move independently of its transform — skinned
 * characters and morphed meshes. Every consumer only ever tests coverage
 * against 0.5, so both still read as "there is a surface here", but TAA uses the
 * distinction to reject history on exactly the pixels whose motion no
 * matrix-difference velocity can describe. Without it a running enemy's arms and
 * legs emit zero motion and the temporal filter drags the background through
 * them — the smear on the character silhouettes.
 *
 * Velocity is computed from *unjittered* view-projection matrices for both
 * frames, so the TAA jitter never leaks into the motion vectors — which is
 * the single most common reason browser TAA implementations smear.
 *
 * Per-object previous world matrices are pushed through
 * `material.onBeforeRender`, which the renderer calls once per draw; setting
 * `uniformsNeedUpdate` forces the re-upload. This is what makes the velocity
 * buffer *per object* rather than camera-only.
 */
/** Coverage written for skinned / morphed geometry. See the class note. */
export const OW_COVERAGE_DYNAMIC = 0.7;

/**
 * Bound in the alpha slot whenever the object being drawn is opaque.
 *
 * A null sampler binds three's own placeholder, whose alpha is not guaranteed,
 * and this one decides whether a fragment is discarded — so it gets a texel of
 * certainty rather than an assumption. Same reasoning as the empty cloud
 * texture in src/sky/dome.js.
 */
function opaqueTexel() {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  t.name = 'ow-prepass-opaque';
  t.needsUpdate = true;
  return t;
}

export class GBuffer {
  constructor(renderer) {
    /**
     * The linear-depth channel below is a float target. Where full float is not
     * RENDERABLE — most mobile GPUs — it has to be half, or the whole gbuffer
     * framebuffer is incomplete. Half-float depth costs precision at range; an
     * incomplete gbuffer costs the frame.
     */
    this._floatType = floatType(renderer);
    this.rt = null;
    this.width = 1;
    this.height = 1;
    this.prev = new Map();
    this._seen = new Set();
    this._opaque = opaqueTexel();
    this._alphaXf = new THREE.Matrix3();
    this._lastAlphaTex = null;

    this.material = new THREE.ShaderMaterial({
      name: 'ow-prepass',
      glslVersion: THREE.GLSL3,
      side: THREE.FrontSide,
      uniforms: {
        owPrevModelMatrix: { value: new THREE.Matrix4() },
        owCurrVP: { value: new THREE.Matrix4() },
        owPrevVP: { value: new THREE.Matrix4() },
        owMatId: { value: 0 },
        owCoverage: { value: 1 },
        // ---- alpha cutout, see the note on owAlphaCut below -----------------
        owAlphaTex: { value: this._opaque },
        owAlphaXf: { value: new THREE.Matrix3() },
        owAlphaCut: { value: 0 },
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <batching_pars_vertex>
        #include <skinning_pars_vertex>
        #include <morphtarget_pars_vertex>

        uniform mat4 owPrevModelMatrix;
        uniform mat4 owCurrVP;
        uniform mat4 owPrevVP;
        uniform mat3 owAlphaXf;

        varying vec3 vNrm;
        varying vec4 vCurrClip;
        varying vec4 vPrevClip;
        varying float vViewDepth;
        varying vec2 vAlphaUv;
        varying vec3 vViewPos;

        void main() {
          #include <batching_vertex>
          #include <beginnormal_vertex>
          #include <morphinstance_vertex>
          #include <morphnormal_vertex>
          #include <skinbase_vertex>
          #include <skinnormal_vertex>
          #include <defaultnormal_vertex>
          #include <begin_vertex>
          #include <morphtarget_vertex>
          #include <skinning_vertex>
          #include <project_vertex>

          vNrm = transformedNormal;
          vViewDepth = -mvPosition.z;
          vViewPos = mvPosition.xyz;
          vAlphaUv = ( owAlphaXf * vec3( uv, 1.0 ) ).xy;

          vec4 objPos = vec4( transformed, 1.0 );
          #ifdef USE_BATCHING
            objPos = batchingMatrix * objPos;
          #endif
          #ifdef USE_INSTANCING
            objPos = instanceMatrix * objPos;
          #endif
          vCurrClip = owCurrVP * ( modelMatrix * objPos );
          vPrevClip = owPrevVP * ( owPrevModelMatrix * objPos );
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${COMMON}
        uniform float owMatId;
        uniform float owCoverage;
        uniform sampler2D owAlphaTex;
        uniform float owAlphaCut;

        varying vec3 vNrm;
        varying vec4 vCurrClip;
        varying vec4 vPrevClip;
        varying float vViewDepth;
        varying vec2 vAlphaUv;
        varying vec3 vViewPos;

        layout(location = 0) out vec4 gNormal;
        layout(location = 1) out vec4 gVelocity;
        layout(location = 2) out vec4 gDepth;

        void main() {
          // ---- ALPHA CUTOUT --------------------------------------------------
          // The override material carries no albedo map, so until this existed
          // every alpha-cutout leaf card wrote its ENTIRE QUAD into depth,
          // normal and velocity. The forward pass then discarded the holes, the
          // background failed the depth test in them, and what came back was a
          // pale blob inside every tree canopy — measured at RGB(220,217,203),
          // which is the hazed skyline showing
          // through a hole the prepass had already filled in.
          //
          // It was proved to be this pass and not the leaf material by tinting
          // every foliage surface a different primary and watching the blobs not
          // change colour, and worked around by tagging foliage
          // owNoPrepass — which buys correctness at the cost of the canopy's
          // motion vectors, so TAA can no longer resolve it and mid-distance
          // foliage sparkles against bright sky.
          //
          // This is also load-bearing for OCCLUSION now. GTAO reads this depth
          // and normal buffer, and it was returning 1.0 everywhere so nobody
          // could see the damage; with the AO pass actually running, a canopy
          // that is solid in depth but transparent in the image would darken
          // everything behind it with occlusion from geometry that is not there.
          if ( owAlphaCut > 0.0 && texture( owAlphaTex, vAlphaUv ).a < owAlphaCut ) discard;

          vec3 n = normalize( vNrm );
          if ( !gl_FrontFacing ) n = -n;
          // ---- A VISIBLE SURFACE'S NORMAL MUST FACE THE VIEWER ---------------
          // gl_FrontFacing is about WINDING, and winding and the vertex normal
          // can disagree: an object with a mirrored (negative determinant)
          // transform has its faces re-wound by the renderer while its normals
          // are carried through the normal matrix, and geometry that is extruded
          // inside-out has the same property. The forward pass never notices,
          // because three flips the shading normal per fragment for
          // double-sided materials. A DEFERRED normal buffer has no such
          // recovery: whatever is written here is what every screen-space
          // consumer believes.
          //
          // MEASURED: every building facade in the 'street' frame wrote a
          // view-space normal of about (-0.72, 0.04, -0.69) — pointing AWAY from
          // the camera that could plainly see it — with coverage 1.0, while the
          // road and pavement in the same frame were correct. GTAO computes its
          // visibility arc about that normal, so the arc closed and the facades
          // came back AO 0.000, which shaded every brick rowhouse to a navy slab
          // (RGB 65,46,57 -> 30,38,58, the red channel more than halved).
          //
          // The camera is at the origin in view space, so the vector from the
          // fragment to the eye is -vViewPos, and a normal that faces the eye
          // satisfies dot(n, vViewPos) < 0. This is a no-op on every surface
          // that was already correct, and on a silhouette pixel — where the dot
          // is near zero by definition — the flip it applies is near zero too.
          if ( dot( n, normalize( vViewPos ) ) > 0.0 ) n = -n;
          gNormal = vec4( owEncodeNormal( n ), owCoverage, owMatId );

          vec2 a = vCurrClip.xy / max( 1e-6, vCurrClip.w );
          vec2 b = vPrevClip.xy / max( 1e-6, vPrevClip.w );
          gVelocity = vec4( ( a - b ) * 0.5, 0.0, 0.0 );

          gDepth = vec4( vViewDepth, 0.0, 0.0, 0.0 );
        }
      `,
    });

    this.material.onBeforeRender = (renderer, scene, camera, geometry, object) => {
      const u = this.material.uniforms;
      const p = this.prev.get(object.id);
      if (p !== undefined) u.owPrevModelMatrix.value.copy(p);
      else u.owPrevModelMatrix.value.copy(object.matrixWorld);
      u.owMatId.value = object.userData !== undefined ? object.userData.owMatId || 0 : 0;
      // Skinned and morphed geometry deforms *inside* its transform, so the
      // matrix difference above describes none of the motion its pixels actually
      // have. Flag it so TAA can reject history there instead of smearing.
      u.owCoverage.value =
        object.isSkinnedMesh === true ||
        (object.morphTargetInfluences !== undefined && object.morphTargetInfluences !== null)
          ? OW_COVERAGE_DYNAMIC
          : 1;

      // Honour the object's OWN alphaTest. The override material replaces the
      // material, not the geometry, so the cutout has to be re-derived here or
      // the depth buffer describes a different silhouette from the image.
      //
      // `alphaMap` wins over `map` because that is three's own precedence for
      // where cutout alpha lives; if neither exists there is nothing to cut
      // against and the fragment stays opaque.
      const om = object.material;
      const src = om !== undefined && om !== null && !Array.isArray(om) ? om : null;
      const cut = src !== null ? src.alphaTest : 0;
      let tex = null;
      if (cut > 0) tex = src.alphaMap ?? src.map ?? null;
      if (tex !== null) {
        u.owAlphaCut.value = cut;
        u.owAlphaTex.value = tex;
        // three only refreshes a texture's UV matrix for the material that owns
        // it, and this is not that material.
        if (tex.matrixAutoUpdate === true) tex.updateMatrix();
        u.owAlphaXf.value.copy(tex.matrix);
      } else {
        u.owAlphaCut.value = 0;
        u.owAlphaTex.value = this._opaque;
        u.owAlphaXf.value.identity();
      }
      this.material.uniformsNeedUpdate = true;
    };
  }

  setSize(w, h, useFloatDepth = true) {
    w = Math.max(1, w | 0);
    h = Math.max(1, h | 0);
    if (this.rt && this.width === w && this.height === h) return;
    this.width = w;
    this.height = h;
    if (this.rt) this.rt.dispose();

    const rt = new THREE.WebGLRenderTarget(w, h, {
      count: 3,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      // The prepass rasterises the same world as the forward pass and has to
      // resolve the same 0.5 m .. 5 km range, so it needs the same reversed-Z
      // float depth attachment — a 24-bit fixed-point buffer here would decide
      // which facade is in front by a different rule than the colour pass and
      // the normal/velocity buffers would disagree with the image.
      ...(useFloatDepth ? { depthTexture: floatDepth(w, h, 'gb-hw-depth') } : null),
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.textures[0].name = 'gb-normal';

    rt.textures[1].format = THREE.RGFormat;
    rt.textures[1].type = THREE.HalfFloatType;
    rt.textures[1].name = 'gb-velocity';

    rt.textures[2].format = THREE.RedFormat;
    rt.textures[2].type = this._floatType;
    rt.textures[2].name = 'gb-depth';

    for (const t of rt.textures) {
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
    }

    this.rt = rt;
  }

  get normalTexture() {
    return this.rt.textures[0];
  }
  get velocityTexture() {
    return this.rt.textures[1];
  }
  get depthTexture() {
    return this.rt.textures[2];
  }

  /**
   * @param {boolean} clear  clear colour+depth (world pass) or depth only
   *                         (viewmodel pass, composited over the same buffer)
   */
  render(renderer, scene, camera, currVP, prevVP, clear) {
    const u = this.material.uniforms;
    u.owCurrVP.value.copy(currVP);
    u.owPrevVP.value.copy(prevVP);

    const prevOverride = scene.overrideMaterial;
    scene.overrideMaterial = this.material;
    renderer.setRenderTarget(this.rt);
    if (clear) renderer.clear(true, true, false);
    else renderer.clear(false, true, false);
    renderer.render(scene, camera);
    scene.overrideMaterial = prevOverride;
  }

  beginRecord() {
    this._seen.clear();
  }

  /**
   * Remember this frame's transforms so next frame can difference them.
   *
   * `userData.owStatic === true` opts an object out entirely. A streamed city
   * is overwhelmingly static — kerbs, road paint, facades, wires, every merged
   * tile — and for those the previous world matrix is the current one by
   * definition, so storing it is a Matrix4 allocation, a Map insert and a
   * 16-float copy per object per frame to compute a velocity of exactly zero.
   * An object with no recorded matrix already falls back to `object.matrixWorld`
   * in `onBeforeRender`, which produces that same zero, so skipping is
   * pixel-identical. `world`, `buildings` and `props` should set it on
   * everything they build from a tile.
   */
  recordMatrices(objects, count) {
    for (let i = 0; i < count; i++) {
      const o = objects[i];
      if (o.userData !== undefined && o.userData.owStatic === true) continue;
      this._seen.add(o.id);
      let m = this.prev.get(o.id);
      if (m === undefined) {
        m = new THREE.Matrix4();
        this.prev.set(o.id, m);
      }
      m.copy(o.matrixWorld);
    }
  }

  /** Drop entries for objects that went away, so the map cannot grow forever. */
  endRecord() {
    if (this.prev.size > this._seen.size * 2 + 64) {
      for (const id of this.prev.keys()) if (!this._seen.has(id)) this.prev.delete(id);
    }
  }

  dispose() {
    if (this.rt) this.rt.dispose();
    this.material.dispose();
    this._opaque.dispose();
    this.prev.clear();
  }
}
