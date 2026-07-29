import * as THREE from 'three';
import { NOISE_GLSL } from './glsl/noise.js';
import { RUST_HELPERS } from './glsl/surfaces-metal.js';
import { ROAD_HELPERS } from './glsl/surfaces-road.js';

/**
 * GPU procedural texture forge.
 *
 * Every surface is one fragment program evaluated four times into four render
 * targets — height (16F, scratch), albedo+height (sRGB8), ORM (linear8) and a
 * tangent-space normal derived from the height field with a Sobel filter.
 * Nothing is read back to the CPU; the render targets *are* the textures, so a
 * full 1K set costs one framebuffer bind and four full-screen draws.
 *
 * Channel packing (this is the contract the material shader relies on):
 *   albedo.rgb = base colour (sRGB encoded by the hardware)
 *   albedo.a   = height 0..1  (or the cutout mask for alpha-tested surfaces)
 *   orm.r      = ambient occlusion / cavity
 *   orm.g      = roughness      (matches three's ORM convention)
 *   orm.b      = metalness
 *   orm.a      = 1
 *   normal.rgb = tangent-space normal, OpenGL convention (+Y up)
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const HEADER = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uSeed;
uniform int   uOutput;
uniform vec3  uTintA;
uniform vec3  uTintB;
uniform vec4  uParam;
`;

const FOOTER = /* glsl */ `
void main(){
  vec3 alb = vec3(0.5);
  float h = 0.5, rough = 0.5, metal = 0.0, ao = 1.0;
  owSurface(vUv, alb, h, rough, metal, ao);
  if (uOutput == 0)      gl_FragColor = vec4(h, h, h, 1.0);
  else if (uOutput == 1) gl_FragColor = vec4(alb, h);
  else                   gl_FragColor = vec4(ao, rough, metal, 1.0);
}
`;

const SOBEL = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uHeight;
uniform vec2 uTexel;
uniform float uStrength;

float H(vec2 o){ return texture2D(uHeight, vUv + o * uTexel).r; }

void main(){
  float tl = H(vec2(-1.0,  1.0)), t = H(vec2(0.0,  1.0)), tr = H(vec2(1.0,  1.0));
  float l  = H(vec2(-1.0,  0.0)),                          r = H(vec2(1.0,  0.0));
  float bl = H(vec2(-1.0, -1.0)), b = H(vec2(0.0, -1.0)), br = H(vec2(1.0, -1.0));

  // Sobel over the height field; the 1/8 normalises the kernel weight.
  float dx = ((tr + 2.0 * r + br) - (tl + 2.0 * l + bl)) * 0.125;
  float dy = ((tl + 2.0 * t + tr) - (bl + 2.0 * b + br)) * 0.125;

  // dx/dy are per-texel; convert to a slope over the whole tile.
  float sx = dx / uTexel.x;
  float sy = dy / uTexel.y;

  vec3 n = normalize(vec3(-sx * uStrength, -sy * uStrength, 1.0));
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}
`;

/**
 * ALPHA DILATION for cutout surfaces.
 *
 * A leaf card is rendered with the leaf colour inside the cutout and whatever
 * the generator happened to leave outside it — for LEAF_CARD, albedo clamped to
 * 0.02, i.e. black. That is invisible at mip 0 because alphaTest throws those
 * texels away, and catastrophic three mip levels down, where the hardware box
 * filter averages each surviving leaf texel against its own dead margin. The
 * measured result was distant foliage roughly 1.5 stops too dark, getting worse
 * with distance as the margin's share of each texel grows.
 *
 * The fix is the standard one: flood the opaque colour outward past the cutout
 * boundary before the mip chain is built, so the margin carries the colour of
 * the nearest leaf rather than black. Alpha itself is untouched — it is the
 * cutout and the whole point is that it still cuts.
 *
 * Two shaders: SEED copies rgb and turns alpha into a validity flag, DILATE
 * pushes valid colour outward one jump at a time, and MERGE writes the dilated
 * colour back under the ORIGINAL alpha.
 */
const SEED = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uCut;
void main(){
  vec4 c = texture2D(uSrc, vUv);
  gl_FragColor = vec4(c.rgb, step(uCut, c.a));
}
`;

const DILATE = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uStep;
void main(){
  vec4 c = texture2D(uSrc, vUv);
  if (c.a > 0.5) { gl_FragColor = c; return; }
  vec3 acc = vec3(0.0);
  float w = 0.0;
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 o = vec2(float(x), float(y)) * uStep * uTexel;
      vec4 s = texture2D(uSrc, vUv + o);
      float k = s.a > 0.5 ? 1.0 : 0.0;
      acc += s.rgb * k;
      w += k;
    }
  }
  gl_FragColor = w > 0.0 ? vec4(acc / w, 1.0) : vec4(c.rgb, 0.0);
}
`;

const MERGE = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uDil;
uniform float uCut;
void main(){
  vec4 c = texture2D(uSrc, vUv);
  vec4 d = texture2D(uDil, vUv);
  // Inside the cutout nothing changes. Outside it, the dead margin takes the
  // flooded colour so the mip chain has something honest to average.
  gl_FragColor = vec4(c.a >= uCut ? c.rgb : d.rgb, c.a);
}
`;

/**
 * Micro surface detail — the layer that stops close-ups looking like plastic.
 *
 * NYQUIST. The tile is 1024 px across 0.25 m, so one texel is 0.244 mm. With
 * 'p = uv * 8', a term written at 'p * K' puts 8K feature cells across 1024
 * texels, i.e. 128/K texels per cell. Anything past K≈24 is under five texels
 * and bakes as white noise: at mip 0 it is salt-and-pepper dither and one mip
 * down it has averaged to flat grey, which is exactly the "sandpaper close up,
 * featureless at 2 m" failure. Every band here is therefore capped at K = 20
 * (6.4 texels, 1.6 mm) and given real amplitude instead.
 */
const DETAIL_SRC = /* glsl */ `
/**
 * THREE MICRO FAMILIES, selected by uParam.x.
 *
 * There used to be exactly one, and an adversarial critic's sharpest single
 * observation was that the same grey speckle was serving as ground aggregate,
 * a shirt weave, weapon rust and asphalt binder at once — "matchable blob for
 * blob at 5x across four unrelated surface classes". That is what happens when
 * every material in the game multiplies the same 1K noise field over itself.
 *
 *   0  mineral aggregate  concrete, asphalt, stone, brick, plaster, ground
 *   1  woven fibre        canvas, hessian, upholstery, clothing, webbing
 *   2  machined metal     plate, rolled steel, alloy, rust, painted steel
 *
 * They are baked separately, not tinted variants of one another: a weave has
 * orthogonal threads and a directional sheen, a rolled plate has unidirectional
 * grind and pitting, and aggregate has rounded proud grains and pores. Nothing
 * in family 1 or 2 can be matched to family 0 by eye at any magnification.
 */
void owDetailWeave(vec2 p, vec2 P, out vec3 alb, out float h, out float rough, out float ao){
  // Warp threads run along x, weft along y; ~1.4 mm pitch at the 0.25 m tile.
  float wobbleU = owFbm01(p * 5.0, P * 5.0, 3, 0.5) - 0.5;
  float wobbleV = owFbm01(p * 5.0 + 21.0, P * 5.0, 3, 0.5) - 0.5;
  vec2 q = p * 18.0 + vec2(wobbleU, wobbleV) * 1.1;
  vec2 cell = floor(q);
  vec2 f = fract(q);
  // Plain weave: on a chequerboard the warp is on top, elsewhere the weft is.
  float over = mod(cell.x + cell.y, 2.0);
  // Each thread is a rounded cylinder, so it is proud in the middle and sinks
  // where it dives under its neighbour.
  float warp = sin(f.y * 3.14159265);
  float weft = sin(f.x * 3.14159265);
  float top = mix(weft, warp, over);
  float bot = mix(warp, weft, over);
  // slubs: real yarn is not a constant diameter
  float slub = owFbm01(q * 0.35 + 7.0, P * 6.3, 3, 0.55);
  float thick = 0.72 + 0.55 * slub;
  h = 0.5 + (top * thick - 0.5) * 0.46 + (bot - 0.5) * 0.10;
  // fibre fuzz standing off the yarn
  float fuzz = owFbm01(p * 46.0, P * 46.0, 2, 0.5);
  h += (fuzz - 0.5) * 0.09;
  // The crossing points are the shadowed holes in the cloth.
  float gap = (1.0 - warp) * (1.0 - weft);
  h -= gap * 0.22;
  ao = 1.0 - gap * 0.55 - max(0.0, 0.5 - top) * 0.35;
  alb = vec3(0.5 + (top * thick - 0.5) * 0.30 - gap * 0.20 + (slub - 0.5) * 0.16);
  // A thread's crown is where the sheen lives, its trough is matte.
  rough = 0.62 - top * 0.22 + (1.0 - slub) * 0.10;
}

void owDetailMetal(vec2 p, vec2 P, out vec3 alb, out float h, out float rough, out float ao){
  // Rolled and ground plate: unidirectional lay, at a slight angle so it never
  // sits exactly on a texel row.
  vec2 g = owShear(p * 3.0, 1.0, 26.0);
  vec2 gper = owShearPer(P * 3.0, 26.0);
  float lay = owFbm01(g, gper, 4, 0.52);
  float lay2 = owFbm01(g * 2.6 + 3.3, gper * 2.6, 3, 0.5);
  // Corrosion pitting: small, deep, round, and clustered rather than uniform.
  vec4 pit = owWorley(p * 17.0, P * 17.0, 1.0);
  float cluster = smoothstep(0.42, 0.85, owFbm01(p * 2.2 + 13.0, P * 2.2, 4, 0.55));
  float pits = smoothstep(0.30, 0.02, pit.x) * step(0.55, pit.w) * cluster;
  // A handful of deeper gouges from handling.
  float gouge = owScratches(p * 1.6 + 9.0, P * 1.6, 22.0, 3.0, 0.74);
  h = 0.5 + (lay - 0.5) * 0.30 + (lay2 - 0.5) * 0.16;
  h -= pits * 0.42 + clamp(gouge, 0.0, 1.0) * 0.20;
  ao = 1.0 - pits * 0.55 - clamp(gouge, 0.0, 1.0) * 0.15;
  // Ground metal is nearly uniform in colour; the read is all specular.
  alb = vec3(0.5 + (lay - 0.5) * 0.10 - pits * 0.22 + clamp(gouge, 0.0, 1.0) * 0.08);
  rough = 0.5 + (lay2 - 0.5) * 0.42 + pits * 0.30;
}

void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed;
  metal = 0.0;
  if (uParam.x > 1.5) {
    owDetailMetal(p, P, alb, h, rough, ao);
    h = clamp(h, 0.0, 1.0);
    return;
  }
  if (uParam.x > 0.5) {
    owDetailWeave(p, P, alb, h, rough, ao);
    h = clamp(h, 0.0, 1.0);
    return;
  }
  // ~10 mm swell, ~3.5 mm tooth
  float a = owFbm01(p * 3.0, P * 3.0, 4, 0.55);
  float b = owFbm01(p * 9.0, P * 9.0, 4, 0.52);
  // 3.9 mm pits and 1.6 mm grains — both wide enough to survive two mip levels
  vec4 pores = owWorley(p * 8.0, P * 8.0, 1.0);
  vec4 grit  = owWorley(p * 20.0, P * 20.0, 1.0);
  float scr = owScratches(p * 2.5, P * 2.5, 16.0, 1.0, 0.66)
            + owScratches(p * 4.0 + 5.0, P * 4.0, 11.0, -2.0, 0.70) * 0.8;
  // Proud grains: a solid, rounded bump rather than a threshold speck.
  float gritA = smoothstep(0.34, 0.08, pores.x) * step(0.38, pores.z);
  float gritB = smoothstep(0.30, 0.06, grit.x) * step(0.34, grit.z);
  float pit   = smoothstep(0.26, 0.0, pores.x) * step(0.72, pores.w);
  h = 0.5 + (a - 0.5) * 0.34 + (b - 0.5) * 0.26;
  h -= pit * 0.38;
  h += gritA * 0.26 * (0.5 + grit.z) + gritB * 0.20;
  h -= clamp(scr, 0.0, 1.0) * 0.18;
  // Albedo tracks the grain so a proud grain reads light and its trough reads
  // dark; the shader scales this by the per-surface detail albedo amount.
  alb = vec3(0.5 + (a - 0.5) * 0.22 + (b - 0.5) * 0.15
           + gritA * 0.16 + gritB * 0.10 - pit * 0.14);
  rough = 0.5 + (b - 0.5) * 0.5;
  metal = 0.0;
  ao = 1.0 - pit * 0.45 - gritB * 0.10;
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * Four bands of low-frequency variation used by every material to break up
 * tiling: R = very low fbm, G = warped blotches, B = mid fbm, A = fine fbm.
 */
const MACRO_SRC = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(6.0);
  vec2 p = uv * P + uSeed * 3.0;
  float a = owFbm01(p * 0.5, P * 0.5, 4, 0.62);
  float b = owFbm01(owWarp(p * 1.0, P, 1.1, 3), P, 4, 0.58);
  float c = owFbm01(p * 2.5, P * 2.5, 4, 0.55);
  float d = owFbm01(p * 7.0, P * 7.0, 4, 0.5);
  alb = vec3(a, b, c);
  h = d;
  rough = 0.5; metal = 0.0; ao = 1.0;
}
`;

export class TextureForge {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{anisotropy?:number}} [opts]
   */
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.anisotropy = Math.min(
      opts.anisotropy ?? 8,
      renderer.capabilities.getMaxAnisotropy?.() ?? 8
    );

    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._geo = new THREE.PlaneGeometry(2, 2);
    this._scene = new THREE.Scene();
    this._mesh = new THREE.Mesh(this._geo, null);
    this._mesh.frustumCulled = false;
    this._scene.add(this._mesh);

    this._sobelMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: SOBEL,
      uniforms: {
        uHeight: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uStrength: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this._seedMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: SEED,
      uniforms: { uSrc: { value: null }, uCut: { value: 0.5 } },
      depthTest: false,
      depthWrite: false,
    });
    this._dilateMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: DILATE,
      uniforms: {
        uSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uStep: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this._mergeMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: MERGE,
      uniforms: { uSrc: { value: null }, uDil: { value: null }, uCut: { value: 0.5 } },
      depthTest: false,
      depthWrite: false,
    });

    /** scratch height targets keyed by size */
    this._heightRTs = new Map();
    /** scratch dilation ping-pong targets keyed by size:index */
    this._dilateRTs = new Map();
    this._owned = [];
    this._programs = new Map();
  }

  _dilateRT(size, i) {
    const k = `${size}:${i}`;
    let rt = this._dilateRTs.get(k);
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(size, size, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.SRGBColorSpace,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        generateMipmaps: false,
        depthBuffer: false,
        stencilBuffer: false,
      });
      this._dilateRTs.set(k, rt);
    }
    return rt;
  }

  /**
   * Flood `srcRT`'s opaque colour outward past its cutout and write the result
   * into `dstRT`, preserving alpha exactly. Jump sizes go coarse then fine so
   * a wide margin is covered without leaving unreached texels behind.
   */
  _dilateInto(srcRT, dstRT, size, cut) {
    const r = this.renderer;
    let a = this._dilateRT(size, 0);
    let b = this._dilateRT(size, 1);

    this._seedMat.uniforms.uSrc.value = srcRT.texture;
    this._seedMat.uniforms.uCut.value = cut;
    this._mesh.material = this._seedMat;
    r.setRenderTarget(a);
    r.render(this._scene, this._camera);

    this._mesh.material = this._dilateMat;
    this._dilateMat.uniforms.uTexel.value.set(1 / size, 1 / size);
    const STEPS = [16, 16, 8, 8, 4, 4, 2, 2, 1, 1, 1, 1];
    for (const s of STEPS) {
      this._dilateMat.uniforms.uSrc.value = a.texture;
      this._dilateMat.uniforms.uStep.value = s;
      r.setRenderTarget(b);
      r.render(this._scene, this._camera);
      const t = a;
      a = b;
      b = t;
    }

    this._mergeMat.uniforms.uSrc.value = srcRT.texture;
    this._mergeMat.uniforms.uDil.value = a.texture;
    this._mergeMat.uniforms.uCut.value = cut;
    this._mesh.material = this._mergeMat;
    r.setRenderTarget(dstRT);
    r.render(this._scene, this._camera);
  }

  _heightRT(size) {
    let rt = this._heightRTs.get(size);
    if (!rt) {
      // Half-float keeps the Sobel free of the stair-stepping an 8-bit height
      // field produces. Fall back to 8-bit if the context can't render to it.
      const canHalf =
        this.renderer.extensions.has('EXT_color_buffer_float') ||
        this.renderer.extensions.has('EXT_color_buffer_half_float');
      rt = new THREE.WebGLRenderTarget(size, size, {
        type: canHalf ? THREE.HalfFloatType : THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        generateMipmaps: false,
        depthBuffer: false,
        stencilBuffer: false,
      });
      this._heightRTs.set(size, rt);
    }
    return rt;
  }

  _target(size, { srgb = false, track = true } = {}) {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      generateMipmaps: true,
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt.texture.anisotropy = this.anisotropy;
    if (track) this._owned.push(rt);
    return rt;
  }

  _material(key, glsl) {
    let mat = this._programs.get(key);
    if (!mat) {
      mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: HEADER + NOISE_GLSL + RUST_HELPERS + ROAD_HELPERS + glsl + FOOTER,
        uniforms: {
          uSeed: { value: 0 },
          uOutput: { value: 0 },
          uTintA: { value: new THREE.Color(1, 1, 1) },
          uTintB: { value: new THREE.Color(1, 1, 1) },
          uParam: { value: new THREE.Vector4() },
        },
        depthTest: false,
        depthWrite: false,
      });
      this._programs.set(key, mat);
    }
    return mat;
  }

  /**
   * Build one texture set.
   * @param {object} def
   * @param {string} def.key      cache key / program key
   * @param {string} def.glsl     surface source implementing owSurface()
   * @param {number} def.size     square resolution
   * @param {number} def.seed
   * @param {number} def.worldSize   metres the tile spans (drives normal slope)
   * @param {number} def.relief      peak-to-trough depth in metres
   * @param {THREE.Color} [def.tintA]
   * @param {THREE.Color} [def.tintB]
   * @param {boolean} [def.orm=true]     allocate + render the ORM output
   * @param {boolean} [def.normal=true]  allocate + render the tangent normal
   *
   * A surface set needs all three outputs, but the two shared maps do not: the
   * material shader only ever samples the detail *albedo* and *normal* and the
   * macro *albedo* (see shader.js — owDetailTex / owDetailNrm / owMacroTex).
   * Baking the outputs nobody reads cost a 1K RGBA8 mip chain (5.6 MB), two
   * 256px ones, and four full-screen evaluations of the noise stack at boot.
   */
  build(def) {
    const r = this.renderer;
    const size = def.size;
    const wantOrm = def.orm !== false;
    const wantNormal = def.normal !== false;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;

    const mat = this._material(def.key, def.glsl);
    mat.uniforms.uSeed.value = def.seed ?? 0;
    if (def.tintA) mat.uniforms.uTintA.value.copy(def.tintA);
    if (def.tintB) mat.uniforms.uTintB.value.copy(def.tintB);
    if (def.param) mat.uniforms.uParam.value.copy(def.param);
    this._mesh.material = mat;

    const albedoRT = this._target(size, { srgb: def.linearAlbedo !== true });
    const ormRT = wantOrm ? this._target(size) : null;
    const normalRT = wantNormal ? this._target(size) : null;

    // The height pass exists only to feed the Sobel, so it is skipped with it.
    let heightRT = null;
    if (wantNormal) {
      heightRT = this._heightRT(size);
      mat.uniforms.uOutput.value = 0;
      r.setRenderTarget(heightRT);
      r.render(this._scene, this._camera);
    }

    // Cutout surfaces render their albedo into a throwaway target first, get
    // their dead margin flooded, and only then land in the mip-generating one.
    const wantDilate = def.dilate === true && def.linearAlbedo !== true;
    const srcRT = wantDilate ? this._target(size, { srgb: true, track: false }) : albedoRT;
    mat.uniforms.uOutput.value = 1;
    r.setRenderTarget(srcRT);
    r.render(this._scene, this._camera);
    if (wantDilate) {
      this._dilateInto(srcRT, albedoRT, size, def.alphaCut ?? 0.5);
      srcRT.dispose();
      this._mesh.material = mat;
    }

    if (ormRT) {
      mat.uniforms.uOutput.value = 2;
      r.setRenderTarget(ormRT);
      r.render(this._scene, this._camera);
    }

    // Height -> normal. Slope is (relief metres / worldSize metres) so the
    // normal map is physically consistent with the mapping scale used later.
    if (normalRT) {
      this._mesh.material = this._sobelMat;
      this._sobelMat.uniforms.uHeight.value = heightRT.texture;
      this._sobelMat.uniforms.uTexel.value.set(1 / size, 1 / size);
      this._sobelMat.uniforms.uStrength.value = (def.relief ?? 0.02) / (def.worldSize ?? 2);
      r.setRenderTarget(normalRT);
      r.render(this._scene, this._camera);
    }

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;

    return {
      albedo: albedoRT.texture,
      orm: ormRT?.texture ?? null,
      normal: normalRT?.texture ?? null,
      size,
      worldSize: def.worldSize ?? 2,
      relief: def.relief ?? 0.02,
    };
  }

  /**
   * Free the scratch height targets.
   *
   * They are pure intermediates — the Sobel pass reads one and nothing else
   * ever does — but at 16F RGBA they are the single largest allocation the
   * forge makes (a 1K one is 8 MB, and the 1K/512/256 set is ~10.5 MB) and they
   * were being held for the whole session for the sake of bakes that all happen
   * during boot. '_heightRT()' recreates on demand, so a late bake still works;
   * it just pays for the allocation again.
   */
  releaseScratch() {
    let freed = 0;
    for (const rt of this._heightRTs.values()) {
      rt.dispose();
      freed++;
    }
    this._heightRTs.clear();
    this._sobelMat.uniforms.uHeight.value = null;
    for (const rt of this._dilateRTs.values()) {
      rt.dispose();
      freed++;
    }
    this._dilateRTs.clear();
    this._seedMat.uniforms.uSrc.value = null;
    this._dilateMat.uniforms.uSrc.value = null;
    this._mergeMat.uniforms.uSrc.value = null;
    this._mergeMat.uniforms.uDil.value = null;
    return freed;
  }

  /**
   * Shared micro-detail normal + a matching micro albedo/roughness.
   * `family` selects the character: 0 mineral, 1 woven, 2 machined metal.
   */
  buildDetail(size = 1024, seed = 1, family = 0) {
    return this.build({
      key: '__detail',
      glsl: DETAIL_SRC,
      size,
      seed,
      param: new THREE.Vector4(family, 0, 0, 0),
      worldSize: 0.25,
      // 1.6 mm grain standing ~0.4 mm proud: a real tooth, not a bump-map hint
      relief: 0.0034,
      // The detail map is DATA, not colour. Stored sRGB-encoded, a value of
      // 0.5 came back as 0.21 linear, so the shader's 'dTex.r - 0.5' term was
      // biased to -0.29 and could only ever darken — half the micro layer was
      // a constant tint rather than a texture.
      linearAlbedo: true,
      // Only the albedo (micro albedo/roughness in rgb, height in a) and the
      // derived normal are sampled; the ORM output was never bound anywhere.
      orm: false,
    });
  }

  /** Shared 4-band low-frequency variation map. */
  buildMacro(size = 256, seed = 2) {
    // Macro is data, not colour — it must be stored and sampled linearly.
    return this.build({
      key: '__macro',
      glsl: MACRO_SRC,
      size,
      seed,
      worldSize: 32,
      relief: 0.5,
      linearAlbedo: true,
      // Four bands packed into the albedo output is the whole map; the macro
      // ORM and macro normal were baked and then never sampled.
      orm: false,
      normal: false,
    });
  }

  dispose() {
    for (const rt of this._heightRTs.values()) rt.dispose();
    for (const rt of this._dilateRTs.values()) rt.dispose();
    for (const rt of this._owned) rt.dispose();
    for (const m of this._programs.values()) m.dispose();
    this._heightRTs.clear();
    this._dilateRTs.clear();
    this._owned.length = 0;
    this._programs.clear();
    this._sobelMat.dispose();
    this._seedMat.dispose();
    this._dilateMat.dispose();
    this._mergeMat.dispose();
    this._geo.dispose();
  }
}
