import * as THREE from 'three';
import { FS_VERT } from './glsl.js';

/**
 * Full-screen triangle infrastructure. One shared geometry, one shared scene,
 * one shared camera — a pass is just a material we swap in. No allocation per
 * frame, no examples/jsm EffectComposer.
 */

const _geometry = new THREE.BufferGeometry();
_geometry.setAttribute(
  'position',
  new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
);
_geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
_geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e8);

const _scene = new THREE.Scene();
_scene.matrixAutoUpdate = false;
/**
 * MUST be an OrthographicCamera, NEVER a bare `new THREE.Camera()`.
 *
 * The full-screen triangle writes clip-space coordinates straight out of the
 * vertex shader and never reads the camera at all, so a bare `Camera` was
 * enough for years. It is not enough with reversed-Z: when
 * `renderer.capabilities.reversedDepthBuffer` is on, three's `setProgram`
 * adopts each camera into the reversed convention the first time it draws with
 * it —
 *
 *     if ( reversedDepthBuffer && camera.reversedDepth !== true ) {
 *       camera._reversedDepth = true;
 *       camera.updateProjectionMatrix();
 *     }
 *
 * — and the base `Camera` class has no `updateProjectionMatrix`. The TypeError
 * is thrown inside `renderer.render()`, so it does not just skip one pass: it
 * aborts the rest of the composite and the frame goes black with nothing in the
 * log to say which pass did it.
 *
 * Any subsystem writing its own full-screen pass has the same constraint. See
 * the note on `RenderSystem.registerPass`.
 */
const _camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const _mesh = new THREE.Mesh(_geometry, null);
_mesh.frustumCulled = false;
_mesh.matrixAutoUpdate = false;
_scene.add(_mesh);

/** Draw `material` over `target` (null = canvas). */
export function blit(renderer, material, target, clear = false, layer = 0) {
  _mesh.material = material;
  renderer.setRenderTarget(target, layer);
  if (clear) renderer.clear(true, false, false);
  renderer.render(_scene, _camera);
}

export function disposeFullScreen() {
  _geometry.dispose();
}

/** A post-processing pass: a ShaderMaterial plus the uniforms it owns. */
export class Pass {
  constructor(name, fragmentShader, uniforms, opts = {}) {
    this.name = name;
    this.uniforms = uniforms;
    this.material = new THREE.ShaderMaterial({
      name,
      uniforms,
      vertexShader: FS_VERT,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: opts.blending ?? THREE.NoBlending,
      defines: opts.defines ?? {},
      glslVersion: opts.glslVersion ?? null,
      transparent: opts.blending !== undefined && opts.blending !== THREE.NoBlending,
    });
  }
  render(renderer, target, clear = false) {
    blit(renderer, this.material, target, clear);
  }
  dispose() {
    this.material.dispose();
  }
}

/**
 * A 32-bit FLOAT depth attachment.
 *
 * Required by reversed-Z: reversing the depth mapping only buys precision if
 * the buffer's quantisation is non-uniform in NDC, which a fixed-point buffer's
 * is not. Three picks DEPTH_COMPONENT32F for a `FloatType` DepthTexture, and
 * float32 + reversed-Z is the combination that turns "10 metres of depth
 * ambiguity at 3 km" into "0.2 millimetres". See RenderSystem.init.
 */
export function floatDepth(w, h, name = 'depth') {
  const t = new THREE.DepthTexture(Math.max(1, w), Math.max(1, h), THREE.FloatType);
  t.format = THREE.DepthFormat;
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.name = name;
  return t;
}

/**
 * Can this device RENDER INTO a 32-bit float target, as opposed to merely
 * sampling one?
 *
 * The two are different capabilities and WebGL2 grants the first only with
 * `EXT_color_buffer_float`. Desktop has it universally; a great many mobile
 * GPUs do not, offering `EXT_color_buffer_half_float` instead.
 *
 * This mattered because nothing checked. The auto-exposure chain allocated
 * five `FloatType` targets and rendered into them, and on a device without the
 * extension those framebuffers are simply incomplete — the 1x1 exposure texture
 * reads back as ZERO, `composite.js` multiplies the entire scene by it, and the
 * game boots to a black screen with working controls and a working HUD. It was
 * reported as "too dark to see anything", and it survived teleporting and
 * switching brother because it was never about the place.
 *
 * Half-float is ample for everything here: an EV100 sits in single digits and
 * the exposure scalar in the low hundreds, against a half-float range of
 * +-65504. Precision, not range, is what we give up, and the meter averages
 * over a 64x64 pyramid where it does not show.
 *
 * Cached per renderer — `extensions.has` is a live GL query and this is called
 * per target.
 */
const _floatRT = new WeakMap();
export function canRenderFloat(renderer) {
  if (!renderer) return false;
  let v = _floatRT.get(renderer);
  if (v === undefined) {
    v = !!renderer.extensions?.has?.('EXT_color_buffer_float');
    _floatRT.set(renderer, v);
    if (!v) console.info('[render] no EXT_color_buffer_float — float targets fall back to half');
  }
  return v;
}

/**
 * The widest float type this device can actually render into.
 * Pass it wherever `THREE.FloatType` was about to be hard-coded.
 */
export function floatType(renderer) {
  return canRenderFloat(renderer) ? THREE.FloatType : THREE.HalfFloatType;
}

/** Half-float colour target with sane defaults for HDR post. */
export function hdrTarget(w, h, opts = {}) {
  const { floatDepth: wantFloatDepth, ...rest } = opts;
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    ...rest,
    ...(wantFloatDepth ? { depthTexture: floatDepth(w, h, `${opts.name ?? 'hdr'}-depth`) } : null),
  });
  rt.texture.name = opts.name ?? 'hdr';
  return rt;
}
