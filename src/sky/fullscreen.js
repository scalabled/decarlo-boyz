import * as THREE from 'three';

/**
 * Full-screen triangle plumbing, local to the sky subsystem.
 *
 * `src/render/pass.js` has an equivalent, but ARCHITECTURE.md forbids importing
 * another subsystem's module, so we keep our own tiny copy. One shared
 * geometry / scene / camera, and a mesh whose material we swap — no allocation
 * per frame, no EffectComposer.
 *
 * Everything here is GLSL ES 3.00 (`glslVersion: THREE.GLSL3`) so the
 * volumetric pass can dynamically index the CSM matrix array and sample the
 * `sampler2DArray` cascade atlas without relying on ES 1.00 leniency.
 */

const _geometry = new THREE.BufferGeometry();
_geometry.setAttribute(
  'position',
  new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
);
_geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e8);

const _scene = new THREE.Scene();
_scene.matrixAutoUpdate = false;
/**
 * An OrthographicCamera, not a bare `THREE.Camera`, and this is load bearing.
 *
 * Every vertex shader in this subsystem writes `gl_Position` directly and never
 * reads the projection, so the camera is pure ceremony for `renderer.render()`.
 * But `render` runs a REVERSED-Z depth buffer, and three's `setProgram` reacts
 * to that by calling `camera.updateProjectionMatrix()` on whatever camera it
 * was handed — a method the base `Camera` class does not have. The result is a
 * TypeError thrown from inside the renderer the first time any pass in here
 * blits while the reversed-depth state is live.
 *
 * That was survivable when the sky was baked once at boot, before the render
 * system had drawn a frame. It is not survivable now: with the clock running,
 * `bakeSkyView` fires every time the sun moves a fifth of a degree, and
 * `bakeStatic` fires on every weather transition that moves the aerosol.
 */
const _camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const _mesh = new THREE.Mesh(_geometry, null);
_mesh.frustumCulled = false;
_mesh.matrixAutoUpdate = false;
_scene.add(_mesh);

/** The geometry is shared by the sky dome too, so it is never disposed here. */
export function fullScreenGeometry() {
  return _geometry;
}

export const SKY_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/** Draw `material` over the whole of `target` (null = canvas). */
export function blit(renderer, material, target) {
  _mesh.material = material;
  renderer.setRenderTarget(target);
  renderer.render(_scene, _camera);
}

/** A full-screen shader step. Uniform objects may be shared between passes. */
export class SkyPass {
  constructor(name, fragmentShader, uniforms, defines = {}) {
    this.uniforms = uniforms;
    this.material = new THREE.ShaderMaterial({
      name,
      uniforms,
      defines,
      vertexShader: SKY_VERT,
      fragmentShader,
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
  }
  render(renderer, target) {
    blit(renderer, this.material, target);
  }
  dispose() {
    this.material.dispose();
  }
}

/**
 * Half-float colour target. Sky radiance is HDR and physically scaled — the sun
 * disc alone is four orders of magnitude above the zenith — so nothing in this
 * subsystem is ever allowed to touch an 8-bit buffer.
 */
export function hdrTarget(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    ...opts,
  });
  rt.texture.name = opts.name ?? 'sky-hdr';
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt;
}

/**
 * Can this device RENDER INTO a 32-bit float colour target?
 *
 * Rendering into a float texture and sampling one are different capabilities,
 * and WebGL2 grants the first only with 'EXT_color_buffer_float' — universal
 * on desktop, missing on a great many mobile GPUs, which offer
 * 'EXT_color_buffer_half_float' instead. Same capability gap, same fallback
 * pattern as src/render/pass.js (rule 2 forbids importing it, so this file
 * keeps its own tiny copy, like everything else in it).
 *
 * Nothing in this subsystem checked. The transmittance LUT was the sky's ONE
 * Float32 colour target; on those devices its framebuffer came up incomplete,
 * the bake wrote nothing, the texture sampled as zero, and every scattering
 * term downstream multiplied through it — sky-view LUT black, ambient LUT
 * black, dome black, sun disc gone. A player reported it from a phone as "the
 * sky is black (with clouds)": the clouds survive because their ground-bounce
 * term is plain CPU uniforms (cloudpass.js), which is what made this an
 * atmosphere defect rather than a screen one. MEASURED by skyfallbackprobe on
 * the emitted sky band at noon: control 83.7 mean luma, denied 4.3 with 99.2%
 * of the band under 8.
 *
 * Cached per renderer — 'extensions.has' is a live GL query.
 */
const _floatOk = new WeakMap();
function canRenderFloat(renderer) {
  if (!renderer) return true; // nothing to ask: keep the old allocation
  let v = _floatOk.get(renderer);
  if (v === undefined) {
    v = !!renderer.extensions?.has?.('EXT_color_buffer_float');
    _floatOk.set(renderer, v);
  }
  return v;
}
const _halfOk = new WeakMap();
function canRenderHalf(renderer) {
  if (!renderer) return true;
  let v = _halfOk.get(renderer);
  if (v === undefined) {
    v = !!(
      renderer.extensions?.has?.('EXT_color_buffer_float') ||
      renderer.extensions?.has?.('EXT_color_buffer_half_float')
    );
    _halfOk.set(renderer, v);
  }
  return v;
}

/**
 * The widest float type this device can actually render into, for LUT-class
 * targets whose payload fits in [0,1] (the transmittance LUT stores
 * exp(-opticalDepth), so every channel is a transmittance). The ladder ends at
 * 8-bit UNORM rather than at failure because the payload is representable
 * there and a banded sky beats a black one; a device that can render into none
 * of these cannot run the HDR pipeline at all, so an analytic-sky fallback
 * behind that condition would be dead code guarding a frame that is already
 * black everywhere.
 *
 * '?owSkyFloatLUT=1' reverts to the unconditional Float32 allocation — the
 * pre-fix behaviour — so skyfallbackprobe.mjs can run its negative control
 * against live code with no edit (the debugIgnorePause pattern). On a capable
 * device the hatch and the capability check pick the same Float32, which is
 * the probe's pixel-neutrality arm.
 */
export function lutFloatType(renderer) {
  const force = typeof location !== 'undefined' && /[?&]owSkyFloatLUT=1/.test(location.search);
  if (force || canRenderFloat(renderer)) return THREE.FloatType;
  const t = canRenderHalf(renderer) ? THREE.HalfFloatType : THREE.UnsignedByteType;
  console.info(
    '[sky] no EXT_color_buffer_float — LUT falls back to ' +
      (t === THREE.HalfFloatType ? 'half float' : '8-bit')
  );
  return t;
}

/**
 * Float target for the LUT bakes — Float32 where the device can render into it
 * (the transmittance LUT is where banding would show), degrading per
 * lutFloatType() where it cannot. The renderer parameter is load-bearing: an
 * unconditional Float32 here is exactly the black-sky-on-mobile defect
 * described above.
 */
export function floatTarget(renderer, w, h, opts = {}) {
  return hdrTarget(w, h, { type: lutFloatType(renderer), ...opts });
}
