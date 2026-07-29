import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { EventBus } from '../core/registry.js';
import { createConfig } from '../core/config.js';
import { FxSystem } from './index.js';
import { Noise } from './noise.js';

/**
 * DEV ONLY — standalone FX rig.
 *
 * Boots the FX subsystem against a minimal stand-in for `render` (HDR target,
 * linear depth prepass, bloom, ACES composite) and `physics` (a brute-force
 * triangle soup with the same `queryAabb` contract as the BVH) so impacts,
 * decals, soft particles and the refraction pass can be iterated on and
 * screenshotted without waiting for ten other subsystems. Nothing here ships.
 */

const canvas = document.getElementById('fx');
const W = () => canvas.clientWidth || 1920;
const H = () => canvas.clientHeight || 1080;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(W(), H(), false);
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, W() / H(), 0.05, 400);
camera.rotation.order = 'YXZ';
camera.position.set(1.7, 1.58, 0.75);
camera.lookAt(-0.5, 1.45, -3.0);

const viewScene = new THREE.Scene();
const viewCamera = new THREE.PerspectiveCamera(60, W() / H(), 0.005, 12);

/* ---------------------------------------------------------------- lighting */
const sun = new THREE.DirectionalLight(0xffe9c8, 4.3);
sun.position.set(9, 11, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 40;
sun.shadow.camera.left = -14;
sun.shadow.camera.right = 14;
sun.shadow.camera.top = 14;
sun.shadow.camera.bottom = -14;
sun.shadow.bias = -0.0006;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0x9fc0ff, 0x3a3128, 0.5));

// a cheap sky gradient turned into an IBL so metals have something to reflect
{
  const size = 64;
  const data = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = y / (size - 1);
    const up = 1 - v;
    const r = 0.35 + 0.5 * up * up;
    const g = 0.45 + 0.55 * up * up;
    const b = 0.62 + 0.75 * up * up;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = up > 0.5 ? r : 0.22;
      data[i + 1] = up > 0.5 ? g : 0.19;
      data[i + 2] = up > 0.5 ? b : 0.16;
      data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(tex).texture;
  scene.background = new THREE.Color(0.24, 0.3, 0.4);
  tex.dispose();
  pmrem.dispose();
}

/* ------------------------------------------------------------- stand-in art */
const rng = new Rng(0x51ce77);
function surfaceMaps(seed, opts) {
  const n = new Noise(new Rng(seed));
  const S = 256;
  const alb = new Uint8Array(S * S * 4);
  const nrm = new Uint8Array(S * S * 4);
  const h = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x / S) * opts.scale;
      const v = (y / S) * opts.scale;
      let f = n.fbm(u, v, 5);
      f = f * 0.7 + n.fbm(u * 5.5, v * 5.5, 3) * 0.3;
      const crack = Math.pow(1 - Math.min(1, n.worleyEdge(u * 0.9, v * 0.9) * 8), 4);
      h[y * S + x] = f - crack * 0.5;
      const i = (y * S + x) * 4;
      const tint = 0.82 + 0.36 * f - crack * 0.35;
      alb[i] = Math.min(255, opts.color[0] * tint * 255);
      alb[i + 1] = Math.min(255, opts.color[1] * tint * 255);
      alb[i + 2] = Math.min(255, opts.color[2] * tint * 255);
      alb[i + 3] = 255;
      nrm[i + 3] = 255;
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const at = (dx, dy) => h[(((y + dy) % S) + S) % S * S + ((((x + dx) % S) + S) % S)];
      const gx = (at(1, 0) - at(-1, 0)) * opts.relief;
      const gy = (at(0, 1) - at(0, -1)) * opts.relief;
      const l = Math.hypot(-gx, -gy, 1);
      const i = (y * S + x) * 4;
      nrm[i] = (-gx / l * 0.5 + 0.5) * 255;
      nrm[i + 1] = (-gy / l * 0.5 + 0.5) * 255;
      nrm[i + 2] = (1 / l * 0.5 + 0.5) * 255;
    }
  }
  const mk = (data, srgb) => {
    const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(alb, true), normalMap: mk(nrm, false) };
}

const concreteMaps = surfaceMaps(11, { color: [0.44, 0.43, 0.4], scale: 5, relief: 5 });
const groundMaps = surfaceMaps(29, { color: [0.17, 0.16, 0.15], scale: 9, relief: 6 });
for (const t of [concreteMaps.map, concreteMaps.normalMap]) t.repeat.set(2.5, 1.4);
for (const t of [groundMaps.map, groundMaps.normalMap]) t.repeat.set(10, 10);

const wallMat = new THREE.MeshStandardMaterial({
  ...concreteMaps,
  roughness: 0.86,
  metalness: 0,
  normalScale: new THREE.Vector2(1.4, 1.4),
});
const groundMat = new THREE.MeshStandardMaterial({
  ...groundMaps,
  roughness: 0.72,
  metalness: 0,
  normalScale: new THREE.Vector2(1.2, 1.2),
});
const steelMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color(0.52, 0.53, 0.55),
  roughness: 0.42,
  metalness: 1,
  normalMap: concreteMaps.normalMap,
  normalScale: new THREE.Vector2(0.35, 0.35),
});

const collide = [];
function addMesh(geo, mat, x, y, z, ry = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.y = ry;
  m.castShadow = true;
  m.receiveShadow = true;
  scene.add(m);
  collide.push(m);
  return m;
}

const ground = addMesh(new THREE.BoxGeometry(160, 0.4, 160), groundMat, 0, -0.2, 0);
ground.castShadow = false;
addMesh(new THREE.BoxGeometry(7.5, 3.4, 0.45), wallMat, -0.4, 1.7, -3.2);
addMesh(new THREE.BoxGeometry(0.45, 3.4, 4), wallMat, 3.1, 1.7, -1.4);
addMesh(new THREE.BoxGeometry(1.1, 0.9, 0.75), steelMat, 1.5, 0.45, -2.1, 0.4);
addMesh(new THREE.BoxGeometry(0.5, 1.4, 0.5), steelMat, -2.8, 0.7, -2.4, -0.3);

/* --------------------------------------------------- a road to skid on ---- */
// The driving FX cannot be judged over a 60 m dirt pad: skid marks read against
// tarmac, kerbs give the eye a scale reference, and the ribbon has to be seen
// crossing lane paint to know whether it is really continuous.
// NOTE: `surfaceMaps` writes its `color` STRAIGHT into an sRGB-tagged texture,
// so these numbers are sRGB, not linear. 0.30 sRGB decodes to ~0.073 linear,
// which is what real asphalt is. Feeding it 0.055 (the linear value) produced a
// road at 0.004 linear — effectively black — and made every mark laid on it look
// like it was glowing.
const asphaltMaps = surfaceMaps(53, { color: [0.245, 0.24, 0.238], scale: 14, relief: 4 });
for (const t of [asphaltMaps.map, asphaltMaps.normalMap]) t.repeat.set(18, 18);
const asphaltMat = new THREE.MeshStandardMaterial({
  ...asphaltMaps,
  roughness: 0.82,
  metalness: 0,
  normalScale: new THREE.Vector2(1.1, 1.1),
});
// Road sits ON TOP: its deck is y=0, the dirt apron is 4 cm below it.
const road = addMesh(new THREE.BoxGeometry(120, 0.4, 120), asphaltMat, 0, -0.2, -18);
road.castShadow = false;
ground.position.y = -0.24;
// kerbs and a couple of blocks for scale / occlusion
const kerbMat = new THREE.MeshStandardMaterial({
  ...concreteMaps,
  roughness: 0.9,
  metalness: 0,
  normalScale: new THREE.Vector2(1.1, 1.1),
});
for (let i = -3; i <= 3; i++) {
  if (i === 0) continue;
  addMesh(new THREE.BoxGeometry(3.6, 0.14, 0.4), kerbMat, i * 4.2, 0.06, -30);
}
addMesh(new THREE.BoxGeometry(4, 6, 4), wallMat, -16, 3, -34, 0.2);
addMesh(new THREE.BoxGeometry(5, 9, 4.5), wallMat, 15, 4.5, -38, -0.15);
// an awning to shed drips off in the rain stage
addMesh(new THREE.BoxGeometry(6, 0.18, 2.2), steelMat, -13.5, 3.2, -31);

/* ------------------------------- physics stand-in: a brute-force tri soup */
class MiniWorld {
  constructor(meshes) {
    const tris = [];
    const v = new THREE.Vector3();
    for (const m of meshes) {
      m.updateWorldMatrix(true, false);
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
      const pos = g.getAttribute('position');
      for (let i = 0; i < pos.count; i += 3) {
        const t = [];
        for (let k = 0; k < 3; k++) {
          v.fromBufferAttribute(pos, i + k).applyMatrix4(m.matrixWorld);
          t.push(v.x, v.y, v.z);
        }
        tris.push(t);
      }
      if (g !== m.geometry) g.dispose();
    }
    this.triCount = tris.length;
    this.pos = new Float32Array(this.triCount * 9);
    this.nrm = new Float32Array(this.triCount * 3);
    this.mask = new Uint16Array(this.triCount).fill(0xffff);
    this.aabbs = new Float32Array(this.triCount * 6);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let i = 0; i < this.triCount; i++) {
      this.pos.set(tris[i], i * 9);
      a.set(tris[i][0], tris[i][1], tris[i][2]);
      b.set(tris[i][3], tris[i][4], tris[i][5]);
      c.set(tris[i][6], tris[i][7], tris[i][8]);
      b.sub(a);
      c.sub(a);
      b.cross(c).normalize();
      this.nrm[i * 3] = b.x;
      this.nrm[i * 3 + 1] = b.y;
      this.nrm[i * 3 + 2] = b.z;
      const t = tris[i];
      for (let k = 0; k < 3; k++) {
        this.aabbs[i * 6 + k] = Math.min(t[k], t[3 + k], t[6 + k]);
        this.aabbs[i * 6 + 3 + k] = Math.max(t[k], t[3 + k], t[6 + k]);
      }
    }
    this._cand = new Int32Array(2048);
    this.candidates = this._cand;
  }

  queryAabb(minx, miny, minz, maxx, maxy, maxz) {
    let n = 0;
    const A = this.aabbs;
    for (let i = 0; i < this.triCount && n < this._cand.length; i++) {
      const b = i * 6;
      if (A[b] > maxx || A[b + 3] < minx) continue;
      if (A[b + 1] > maxy || A[b + 4] < miny) continue;
      if (A[b + 2] > maxz || A[b + 5] < minz) continue;
      this._cand[n++] = i;
    }
    return n;
  }
}

const miniWorld = new MiniWorld(collide);
const raycaster = new THREE.Raycaster();
const _hitOut = {
  hit: false,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  distance: 0,
  surface: 'concrete',
};
const physicsStub = {
  staticWorld: miniWorld,
  MASK: { WORLD: 0xffff },
  raycast(origin, dir, maxDist) {
    raycaster.set(origin, _tmpDir.copy(dir).normalize());
    raycaster.far = maxDist ?? 100;
    const hits = raycaster.intersectObjects(collide, false);
    _hitOut.hit = hits.length > 0;
    if (_hitOut.hit) {
      _hitOut.point.copy(hits[0].point);
      _hitOut.normal.copy(hits[0].face.normal).transformDirection(hits[0].object.matrixWorld);
      _hitOut.distance = hits[0].distance;
      _hitOut.surface = hits[0].object.material === steelMat ? 'metal' : 'concrete';
    }
    return _hitOut;
  },
  groundHeight(x, z) {
    // The rig has a road slab at y=0 out to +-60 and a ground slab beyond it.
    return 0;
  },
  addRigidBody: null,
};
const _tmpDir = new THREE.Vector3();

/* ------------------------------------------------------------ render stub */
let hdrRt = null;
let depthRt = null;
let pingRt = null;
const depthMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: `varying float vZ;
    void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `precision highp float; varying float vZ;
    layout(location=0) out vec4 o; void main(){ o = vec4(vZ,0.0,0.0,1.0); }`,
});

function fsQuad(frag, uniforms) {
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: `varying vec2 vUvq; void main(){ vUvq = uv; gl_Position = vec4(position.xy*2.0,0.0,1.0);} `,
    fragmentShader: frag,
    depthTest: false,
    depthWrite: false,
  });
  const q = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
  q.frustumCulled = false;
  const s = new THREE.Scene();
  s.add(q);
  // OrthographicCamera, not a bare THREE.Camera — see the note in haze.js:
  // under a reversed-Z depth buffer three calls camera.updateProjectionMatrix()
  // from setProgram, which the base Camera class does not implement.
  return { scene: s, mat: m, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
}

const bright = fsQuad(
  `precision highp float; uniform sampler2D t; uniform vec2 texel; varying vec2 vUvq;
   layout(location=0) out vec4 o;
   void main(){
     vec3 c = vec3(0.0);
     c += texture(t, vUvq + texel*vec2(-1.0,-1.0)).rgb;
     c += texture(t, vUvq + texel*vec2( 1.0,-1.0)).rgb;
     c += texture(t, vUvq + texel*vec2(-1.0, 1.0)).rgb;
     c += texture(t, vUvq + texel*vec2( 1.0, 1.0)).rgb;
     c *= 0.25;
     float l = max(max(c.r,c.g),c.b);
     o = vec4(c * smoothstep(1.0, 2.2, l), 1.0);
   }`,
  { t: { value: null }, texel: { value: new THREE.Vector2() } }
);
const blur = fsQuad(
  `precision highp float; uniform sampler2D t; uniform vec2 dir; varying vec2 vUvq;
   layout(location=0) out vec4 o;
   void main(){
     vec3 c = texture(t, vUvq).rgb * 0.227;
     c += (texture(t, vUvq + dir*1.38).rgb + texture(t, vUvq - dir*1.38).rgb) * 0.316;
     c += (texture(t, vUvq + dir*3.23).rgb + texture(t, vUvq - dir*3.23).rgb) * 0.07;
     o = vec4(c, 1.0);
   }`,
  { t: { value: null }, dir: { value: new THREE.Vector2() } }
);
const composite = fsQuad(
  `precision highp float; uniform sampler2D t; uniform sampler2D b; uniform vec2 p; varying vec2 vUvq;
   layout(location=0) out vec4 o;
   vec3 aces(vec3 x){
     const mat3 m1 = mat3(0.59719,0.07600,0.02840,0.35458,0.90834,0.13383,0.04823,0.01566,0.83777);
     const mat3 m2 = mat3(1.60475,-0.10208,-0.00327,-0.53108,1.10813,-0.07276,-0.07367,-0.00605,1.07602);
     vec3 v = m1*x; vec3 a = v*(v+0.0245786)-0.000090537; vec3 d = v*(0.983729*v+0.4329510)+0.238081;
     return clamp(m2*(a/d), 0.0, 1.0);
   }
   void main(){
     vec3 c = texture(t, vUvq).rgb + texture(b, vUvq).rgb * p.y;
     c = aces(c * p.x);
     c = pow(c, vec3(1.0/2.2));
     o = vec4(c, 1.0);
   }`,
  { t: { value: null }, b: { value: null }, p: { value: new THREE.Vector2(1.0, 0.06) } }
);
let bloomA = null;
let bloomB = null;

const passes = [];
const renderStub = {
  renderer,
  depthTexture: null,
  velocityTexture: null,
  screenSize: { width: 1, height: 1 },
  sunDir: new THREE.Vector3(),
  activeSun: sun,
  registerPass(p) {
    passes.push(p);
    p.resize?.(renderStub.screenSize.width, renderStub.screenSize.height);
    return () => passes.splice(passes.indexOf(p), 1);
  },
  addLight() {},
  requestEnvMap: () => scene.environment,
};

function resize() {
  const w = Math.max(1, W());
  const h = Math.max(1, H());
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderStub.screenSize.width = w;
  renderStub.screenSize.height = h;
  hdrRt?.dispose();
  depthRt?.dispose();
  pingRt?.dispose();
  bloomA?.dispose();
  bloomB?.dispose();
  hdrRt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true, samples: 4 });
  pingRt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
  depthRt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType,
    format: THREE.RedFormat,
    depthBuffer: true,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  const bw = Math.max(1, w >> 2);
  const bh = Math.max(1, h >> 2);
  bloomA = new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, depthBuffer: false });
  bloomB = new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, depthBuffer: false });
  renderStub.depthTexture = depthRt.texture;
  bright.mat.uniforms.texel.value.set(1 / w, 1 / h);
  for (const p of passes) p.resize?.(w, h);
}

/* --------------------------------------------------------------- fake ctx */
const config = createConfig({ quality: 'ultra', deterministic: true });
const events = new EventBus();
const time = { elapsed: 0, raw: 0, dt: 1 / 60, fixed: 1 / 120, alpha: 0, scale: 1, frame: 0 };
const systems = { render: renderStub, physics: physicsStub };
const ctx = {
  scene,
  camera,
  viewScene,
  viewCamera,
  canvas,
  config,
  events,
  input: { frozen: true },
  time,
  rng: new Rng(0xfeed),
  get: (id) => systems[id] ?? null,
  peek: (id) => systems[id] ?? null,
  has: (id) => !!systems[id],
};

const fx = new FxSystem();
resize();
addEventListener('resize', resize);
await fx.init(ctx);
systems.fx = fx;

const params = new URLSearchParams(location.search);
let KIND = params.get('kind') ?? 'wall';

/**
 * Default framing per stage. A skid ribbon 25 m long and a wall of rain need
 * completely different cameras from a bullet hole at 3 m, and getting the
 * framing wrong is indistinguishable from getting the effect wrong.
 * Overridable with ?cam=x,y,z&look=x,y,z&fov=.
 */
const CAMS = {
  wall: [[1.7, 1.58, 0.75], [-0.5, 1.45, -3.0], 60],
  closeup: [[0.35, 1.55, -1.55], [-0.35, 1.5, -3.0], 60],
  // The driving / weather stages place themselves 14-20 m down the camera's
  // forward axis, so they are framed looking AWAY from the impacts wall — with
  // it in the way the car spent half of every lap behind 3.4 m of concrete.
  skid: [[10.0, 3.2, 22.0], [2.0, 0.2, 6.0], 58],
  drift: [[10.0, 3.2, 22.0], [2.0, 0.2, 6.0], 58],
  burnout: [[5.0, 1.7, 16.0], [1.0, 0.6, 6.0], 55],
  rain: [[9.0, 2.6, 22.0], [1.0, 1.2, 4.0], 62],
  sparks: [[5.5, 1.9, 14.0], [1.5, 0.8, 4.0], 55],
  steam: [[1.5, 1.6, 16.0], [1.0, 1.4, 3.0], 62],
  wreck: [[9.0, 2.8, 24.0], [1.0, 1.5, 8.0], 58],
  explosion: [[4.0, 2.0, 5.0], [-1.0, 1.2, -5.0], 60],
};
{
  const preset = CAMS[KIND];
  if (preset) {
    camera.position.fromArray(preset[0]);
    camera.lookAt(preset[1][0], preset[1][1], preset[1][2]);
    camera.fov = preset[2];
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
}
if (KIND === 'closeup') KIND = 'wall';

// ?sun=elevation,azimuth (degrees) — judging smoke lighting needs the key moved.
{
  const s = params.get('sun');
  if (s) {
    const [el, az] = s.split(',').map(Number);
    const e = (el * Math.PI) / 180;
    const a = ((az ?? 40) * Math.PI) / 180;
    sun.position.set(Math.cos(e) * Math.cos(a) * 14, Math.sin(e) * 14, Math.cos(e) * Math.sin(a) * 14);
  }
  const si = params.get('suni');
  if (si) sun.intensity = Number(si);
}

// Stage FIRST from the preset framing (the stages place themselves relative to
// the camera, exactly as they do in the game), THEN move the reviewing eye. That
// way ?cam= orbits the effect instead of dragging it around.
fx.debugBurst(KIND);

// RIG ONLY. In the game `sky` emits `weather:change` and `materials` turns the
// whole world wet — darker albedo, low roughness, sodium lamps mirrored in the
// road. The rig has no material system, so without this the rain FX are judged
// against a bone-dry desert and every reviewer reaches the same (correct, but
// misattributed) conclusion: "white streaks over a scene that looks dry".
if (fx.rain.rain > 0.01 || fx.rain.wetness > 0.01) {
  const w = Math.max(fx.rain.rain, fx.rain.wetness);
  for (const m of [asphaltMat, groundMat, wallMat, kerbMat]) {
    m.color.multiplyScalar(1 - 0.42 * w);
    m.roughness = Math.max(0.18, m.roughness - 0.36 * w);
    m.envMapIntensity = 1 + 0.7 * w;
    m.needsUpdate = true;
  }
}

{
  const cp = params.get('cam');
  const lk = params.get('look');
  const fv = params.get('fov');
  if (cp) camera.position.fromArray(cp.split(',').map(Number));
  if (lk) {
    const a = lk.split(',').map(Number);
    camera.lookAt(a[0], a[1], a[2]);
  }
  if (fv) {
    camera.fov = Number(fv);
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
}
window.__FX__ = fx;
window.__BURST__ = (k) => fx.debugBurst(k);

// Atlas inspector: ?kind=atlas | patlas | natlas draws a baked atlas
// full-screen so every tile can be judged on its own.
const atlasView = fsQuad(
  `precision highp float; uniform sampler2D t; uniform float showAlpha; varying vec2 vUvq;
   layout(location=0) out vec4 o;
   void main(){
     vec4 c = texture(t, vec2(vUvq.x, vUvq.y));
     vec3 rgb = showAlpha > 0.5 ? vec3(c.a) : c.rgb;
     // checker under the alpha so coverage is legible
     float ck = mod(floor(vUvq.x*64.0)+floor(vUvq.y*36.0),2.0)*0.12+0.06;
     if (showAlpha < 0.5) rgb = mix(vec3(ck), c.rgb, c.a);
     o = vec4(rgb, 1.0);
   }`,
  { t: { value: null }, showAlpha: { value: 0 } }
);
const ATLAS_VIEWS = {
  atlas: () => fx._decalAtlas.albedo,
  atlasa: () => fx._decalAtlas.albedo,
  natlas: () => fx._decalAtlas.normal,
  ormatlas: () => fx._decalAtlas.orm,
  patlas: () => fx._atlas.texture,
  patlasa: () => fx._atlas.texture,
  satlas: () => fx.skid.textures.albedo,
  satlasa: () => fx.skid.textures.albedo,
  sorm: () => fx.skid.textures.orm,
  snrm: () => fx.skid.textures.normal,
};

function frame() {
  time.frame++;
  time.elapsed += time.dt;
  time.raw += time.dt;

  renderStub.sunDir.copy(sun.position).normalize();
  camera.updateMatrixWorld();
  viewCamera.updateMatrixWorld();

  fx.update(time.dt, ctx);
  fx.lateUpdate(time.dt, ctx);

  // linear-depth prepass over opaque geometry only
  const hidden = [];
  scene.traverse((o) => {
    if (o.isMesh && o.material && o.material.transparent) {
      hidden.push(o);
      o.visible = false;
    }
  });
  const bg = scene.background;
  scene.background = null;
  scene.overrideMaterial = depthMat;
  renderer.setRenderTarget(depthRt);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, false);
  renderer.render(scene, camera);
  scene.overrideMaterial = null;
  for (const o of hidden) o.visible = true;
  scene.background = bg;

  renderer.setRenderTarget(hdrRt);
  renderer.clear(true, true, false);
  renderer.render(scene, camera);
  if (viewScene.children.length) {
    renderer.clear(false, true, false);
    renderer.render(viewScene, viewCamera);
  }

  let color = hdrRt.texture;
  for (const p of passes) {
    if (p.enabled === false) continue;
    p.render(renderer, color, pingRt, renderStub);
    color = pingRt.texture;
  }

  bright.mat.uniforms.t.value = color;
  renderer.setRenderTarget(bloomA);
  renderer.render(bright.scene, bright.cam);
  blur.mat.uniforms.t.value = bloomA.texture;
  blur.mat.uniforms.dir.value.set(1 / bloomA.width, 0);
  renderer.setRenderTarget(bloomB);
  renderer.render(blur.scene, blur.cam);
  blur.mat.uniforms.t.value = bloomB.texture;
  blur.mat.uniforms.dir.value.set(0, 1 / bloomA.height);
  renderer.setRenderTarget(bloomA);
  renderer.render(blur.scene, blur.cam);

  if (params.get('log') && time.frame % 30 === 0) {
    console.info(
      `f${time.frame} add=${fx.add.spawned} lit=${fx.lit.spawned} mote=${fx.motes.spawned} ` +
        `haze=${fx.hazeSys.layer.spawned} decals=${fx.stats.decals} impacts=${fx.stats.spawned} ` +
        `addVis=${fx.add.mesh.visible} litVis=${fx.lit.mesh.visible} inst=${fx.add.geometry.instanceCount} ` +
        `skid=${fx.skid.laid} skidVis=${fx.skid.mesh.visible} skidRange=${fx.skid.geometry.drawRange.count} ` +
        `skidP=${fx.skid.pos[0]?.toFixed(2)},${fx.skid.pos[1]?.toFixed(2)},${fx.skid.pos[2]?.toFixed(2)} ` +
        `rainVis=${fx.rain.mesh.visible} rainN=${fx.rain.geometry.instanceCount} ` +
        `pt0=${fx.lit.uniforms.uPtPos.value[0].toArray().map(v=>v.toFixed(2))} c0=${fx.lit.uniforms.uPtCol.value[0].toArray().map(v=>v.toFixed(2))} wind=${fx.windVec.toArray().map(v=>v.toFixed(1))}`
    );
  }
  const av = ATLAS_VIEWS[params.get('kind')];
  if (av) {
    atlasView.mat.uniforms.t.value = av();
    atlasView.mat.uniforms.showAlpha.value = params.get('kind').endsWith('a') ? 1 : 0;
    renderer.setRenderTarget(null);
    renderer.render(atlasView.scene, atlasView.cam);
    requestAnimationFrame(frame);
    return;
  }
  composite.mat.uniforms.t.value = color;
  composite.mat.uniforms.b.value = bloomA.texture;
  renderer.setRenderTarget(null);
  renderer.render(composite.scene, composite.cam);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

let warm = 0;
const ready = () => {
  if (++warm > 3) window.__READY__ = true;
  else requestAnimationFrame(ready);
};
requestAnimationFrame(ready);
