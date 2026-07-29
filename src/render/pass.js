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
