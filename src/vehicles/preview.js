/**
 * Standalone vehicle preview (dev tool, not shipped, not imported by the game).
 *
 * Two jobs:
 *
 *  1. Iterate on the meshes without booting the whole city — the game's boot
 *     depends on sixteen other subsystems that are being written in parallel,
 *     and a syntax error in any of them costs an hour of review time here.
 *
 *  2. VALIDATE THE PAINT AGAINST HDR VALUES, NOT AGAINST THE COMPOSITED FRAME.
 *     Car paint is almost entirely a specular phenomenon, so a pipeline with no
 *     specular energy in it will make a physically correct clearcoat look dead
 *     and tempt you into flattening the material to compensate. This renders
 *     into a half-float target and reports the luminance histogram BEFORE tone
 *     mapping, so `window.__INFO__.hdr` says what the material actually
 *     produced: peak, p99.9, and the fraction of pixels above 1.0 (which can
 *     only be specular — no albedo reaches there under a 1.0-exposure sun).
 *
 *   node src/vehicles/shoot.mjs --view=hero --type=sports --out=/tmp/v.png
 */

import * as THREE from 'three';
import { VEHICLE_SPECS, CLASS_IDS, finalizeSpec } from './specs.js';
import { VehicleMaterials } from './paint.js';
import { buildVehicleModel, modelStats, setVehicleLod } from './build.js';
import { DamageModel } from './damage.js';
import { Rng } from '../core/rng.js';

const q = new URLSearchParams(location.search);
const VIEW = q.get('view') ?? 'hero';
const TYPE = q.get('type') ?? 'sports';
const PAINT = q.get('paint') ? Number(q.get('paint')) : undefined;
const FINISH = q.get('finish') ?? undefined;
const SUN = q.get('sun') ? Number(q.get('sun')) : 0.38;
const EXPOSURE = q.get('exposure') ? Number(q.get('exposure')) : 1.0;

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = EXPOSURE;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.08, 400);

/* ------------------------------------------------------------------ */
/* Environment: a real sky with a sun disc, PMREM'd.                    */
/* A car is 90% reflection. Reflecting a flat grey box tells you nothing */
/* about whether the paint works.                                        */
/* ------------------------------------------------------------------ */

function buildEnvScene(sunAlt) {
  const s = new THREE.Scene();
  const geo = new THREE.SphereGeometry(60, 48, 32);
  const sky = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uSun: { value: new THREE.Vector3(0.4, Math.sin(sunAlt), -0.8).normalize() } },
    vertexShader: `varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
    fragmentShader: `
      varying vec3 vD; uniform vec3 uSun;
      void main(){
        vec3 d = normalize(vD);
        float h = clamp(d.y*0.5+0.5, 0.0, 1.0);
        // Overcast-leaning rustbelt sky: cool zenith, warm haze at the horizon.
        vec3 zen = vec3(0.16, 0.26, 0.44);
        vec3 hor = vec3(0.66, 0.62, 0.58);
        vec3 c = mix(hor, zen, pow(h, 0.55)) * 1.05;
        // ground half
        if (d.y < 0.0) c = mix(vec3(0.10,0.095,0.085)*1.2, hor*0.8, pow(1.0+d.y, 3.0));
        float sd = max(0.0, dot(d, normalize(uSun)));
        c += vec3(9.0, 7.4, 5.4) * pow(sd, 900.0) * 40.0;     // the disc
        c += vec3(1.6, 1.3, 1.0) * pow(sd, 12.0) * 0.9;        // the glow
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  s.add(new THREE.Mesh(geo, sky));
  return s;
}

const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const envScene = buildEnvScene(SUN);
const envRT = pmrem.fromScene(envScene, 0.02, 0.1, 200);
scene.environment = envRT.texture;
scene.background = envRT.texture;
scene.backgroundBlurriness = 0.0;

const sun = new THREE.DirectionalLight(0xfff0d8, 6.2);
sun.position.set(18, Math.max(4, 44 * Math.sin(SUN)), -34);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -12;
sun.shadow.camera.right = 12;
sun.shadow.camera.top = 12;
sun.shadow.camera.bottom = -12;
sun.shadow.camera.far = 120;
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.02;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0x9fb4d0, 0x2a2622, 0.35));

/* ---- ground ------------------------------------------------------- */
const groundGeo = new THREE.PlaneGeometry(160, 160, 1, 1);
groundGeo.rotateX(-Math.PI / 2);
const groundMat = new THREE.MeshStandardMaterial({
  color: 0x2a2926,
  roughness: 0.86,
  metalness: 0,
  envMapIntensity: 0.7,
});
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.receiveShadow = true;
scene.add(ground);

/* ---- vehicles ------------------------------------------------------ */
const ctxStub = { config: { q: { anisotropy: 16, lodBias: 1 }, quality: 'ultra' } };
const mats = new VehicleMaterials(ctxStub).build();
const rng = new Rng(0xbeef1234);

const built = [];
function place(type, x, z, yaw, opts = {}) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const model = buildVehicleModel(spec, mats, {
    paint: opts.paint ?? PAINT,
    finish: opts.finish ?? FINISH ?? 'gloss',
    flake: opts.flake ?? 0.55,
    plate: opts.plate ?? 'DCB 440',
    livery: opts.livery ?? spec.livery ?? null,
  });
  /**
   * MATERIALISE A LEVEL. `build.js` builds nothing at all until something asks
   * to see one — a deliberate frame-rate fix in the game, and a silent trap
   * here: this preview used to rely on `buildVehicleModel` returning a
   * populated graph, so after that change it rendered an empty road and every
   * geometry review had to be done inside the full city boot.
   */
  setVehicleLod(model, Number(q.get('lod') ?? 0));
  // ?door=0..1 — swing the doors, the same transform `VehicleSystem.setDoor`
  // applies, so the enter/exit sequence can be reviewed without the city.
  const door = Number(q.get('door') ?? opts.door ?? 0);
  if (door > 0) for (const d of model.doors) d.pivot.rotation.y = -d.side * 1.08 * door;
  model.root.position.set(x, spec.comY, z);
  model.root.rotation.y = yaw;
  model.root.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  // ?only=paint,glass — isolate material groups when hunting a bad panel.
  const only = q.get('only');
  if (only) {
    const keep = new Set(only.split(','));
    model.root.traverse((o) => {
      if (o.isMesh && !keep.has(o.name) && !keep.has(o.name.split('_')[0])) o.visible = false;
    });
  }
  if (q.get('normals') === '1') {
    model.root.traverse((o) => {
      if (o.isMesh && o.name === 'paint') {
        o.material = new THREE.MeshNormalMaterial({ side: THREE.FrontSide });
      }
    });
  }
  if (q.get('wire') === '1') {
    model.root.traverse((o) => {
      if (o.isMesh) o.material = new THREE.MeshBasicMaterial({ wireframe: true, color: 0x66ff99 });
    });
  }
  scene.add(model.root);
  built.push({ spec, model });
  return { spec, model };
}

const LOOK = new THREE.Vector3();
let camPos = new THREE.Vector3();

function frame(spec, mode) {
  const L = spec.dims.L;
  const H = spec.dims.H;
  // +Z is the car's nose.
  switch (mode) {
    case 'side':
      camPos.set(L * 1.9, H * 0.55, 0.02);
      LOOK.set(0, H * 0.44, 0);
      camera.fov = 30;
      break;
    case 'rear':
      camPos.set(L * 0.62, H * 0.78, -L * 0.86);
      LOOK.set(0, H * 0.42, -L * 0.12);
      camera.fov = 40;
      break;
    case 'front':
      camPos.set(0.12, H * 0.58, L * 1.45);
      LOOK.set(0, H * 0.44, 0);
      camera.fov = 32;
      break;
    case 'detail':
      // 3 m from the shoulder line at the A-pillar: the panel-gap / clearcoat
      // review framing the critics use.
      camPos.set(1.75, H * 0.92, L * 0.72);
      LOOK.set(0.1, H * 0.52, -0.15);
      camera.fov = 40;
      break;
    case 'wheel':
      camPos.set(1.95, 0.62, spec.axleF + 0.9);
      LOOK.set(0.4, 0.34, spec.axleF);
      camera.fov = 32;
      break;
    case 'interior':
      // The chase camera looks straight through the back glass.
      camPos.set(0.32, H + 0.62, -L * 1.28);
      LOOK.set(0, spec.style.beltY ?? H * 0.62, L * 0.25);
      camera.fov = 34;
      break;
    case 'top':
      camPos.set(0.01, L * 1.45, 0.01);
      LOOK.set(0, 0, 0);
      camera.fov = 40;
      break;
    default: // hero 3/4 front
      camPos.set(L * 0.60, H * 0.72, L * 0.78);
      LOOK.set(0, H * 0.40, L * 0.02);
      camera.fov = 38;
  }
  camera.position.copy(camPos);
  camera.lookAt(LOOK);
  camera.updateProjectionMatrix();
}

let info = {};

if (VIEW === 'lineup') {
  let x = 0;
  const xs = [];
  CLASS_IDS.forEach((id) => {
    const spec = finalizeSpec(VEHICLE_SPECS[id]);
    x += spec.dims.L * 0.5 + 0.9;
    xs.push(x);
    place(id, x, 0, Math.PI * 0.5);
    x += spec.dims.L * 0.5;
  });
  const mid = x * 0.5;
  for (const b of built) b.model.root.position.x -= mid;
  camera.position.set(0, 6.2, -20.5);
  camera.lookAt(0, 0.7, 0);
  camera.fov = 46;
  camera.updateProjectionMatrix();
} else if (VIEW === 'grid') {
  const cols = 4;
  CLASS_IDS.forEach((id, i) => {
    place(id, (i % cols) * 7 - 10.5, Math.floor(i / cols) * 8 - 4, Math.PI * 0.62);
  });
  camera.position.set(-2, 13, -20);
  camera.lookAt(0, 0, -1);
  camera.fov = 52;
  camera.updateProjectionMatrix();
} else if (VIEW === 'paints') {
  const spec = finalizeSpec(VEHICLE_SPECS[TYPE]);
  const swatches = [
    { paint: 0x2b2f33, finish: 'gloss', flake: 0.55 },
    { paint: 0x6d1f1c, finish: 'gloss', flake: 0.5 },
    { paint: 0x2e4356, finish: 'gloss', flake: 0.62 },
    { paint: 0xc8c6c0, finish: 'gloss', flake: 0.18 },
    { paint: 0xc4460d, finish: 'gloss', flake: 0.62 },
    { paint: 0x6b6660, finish: 'primer', flake: 0 },
    { paint: 0x585c5e, finish: 'matte', flake: 0 },
    { paint: 0x6b4426, finish: 'matte', flake: 0 },
  ];
  swatches.forEach((s, i) => {
    place(TYPE, (i % 4) * 6.4 - 9.6, Math.floor(i / 4) * 7.4 - 3.7, Math.PI * 0.58, s);
  });
  camera.position.set(-2, 10.5, -17);
  camera.lookAt(0, 0, -0.5);
  camera.fov = 52;
  camera.updateProjectionMatrix();
  void spec;
} else {
  const b = place(TYPE, 0, 0, VIEW === 'top' ? Math.PI * 0.5 : 0);
  if (VIEW === 'damage' || q.get('damage')) {
    const dm = new DamageModel(
      { spec: b.spec, model: b.model, position: b.model.root.position, quaternion: b.model.root.quaternion, wheels: [], destroyed: false, health: 1e9, mass: b.spec.mass, sys: { physics: null } },
      mats,
      rng
    );
    const p = new THREE.Vector3();
    p.copy(b.model.root.position).add(new THREE.Vector3(0.9, 0.35, b.spec.half.z * 0.75));
    dm.dent(p, new THREE.Vector3(-0.55, -0.1, -0.83).normalize(), 0.16, 1.1);
    p.copy(b.model.root.position).add(new THREE.Vector3(-b.spec.half.x, 0.25, -0.4));
    dm.dent(p, new THREE.Vector3(0.95, -0.15, 0.2).normalize(), 0.13, 0.9);
    dm.bonnetPop = 0.75;
    dm.buckleBonnet();
    dm.crackGlass();
  }
  frame(b.spec, VIEW);
  info.stats = modelStats(b.spec);
  info.type = TYPE;
}

/* ------------------------------------------------------------------ */
/* HDR probe                                                           */
/* ------------------------------------------------------------------ */

const hdrRT = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
  type: THREE.HalfFloatType,
  colorSpace: THREE.LinearSRGBColorSpace,
  depthBuffer: true,
});

function probeHDR() {
  const prevTone = renderer.toneMapping;
  const prevCS = renderer.outputColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setRenderTarget(hdrRT);
  renderer.render(scene, camera);
  // The WHOLE frame. readRenderTargetPixels' origin is bottom-left, so a
  // 640x360 window read the dark road and reported "no specular anywhere".
  const W = innerWidth;
  const H = innerHeight;
  const buf = new Uint16Array(W * H * 4);
  try {
    renderer.readRenderTargetPixels(hdrRT, 0, 0, W, H, buf);
  } catch (e) {
    renderer.setRenderTarget(null);
    renderer.toneMapping = prevTone;
    renderer.outputColorSpace = prevCS;
    return { error: String(e) };
  }
  renderer.setRenderTarget(null);
  renderer.toneMapping = prevTone;
  renderer.outputColorSpace = prevCS;

  const lum = new Float32Array(W * H);
  let max = 0;
  let over1 = 0;
  let over4 = 0;
  let over16 = 0;
  for (let i = 0; i < W * H; i++) {
    const r = half2float(buf[i * 4]);
    const g = half2float(buf[i * 4 + 1]);
    const b = half2float(buf[i * 4 + 2]);
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum[i] = l;
    if (l > max) max = l;
    if (l > 1) over1++;
    if (l > 4) over4++;
    if (l > 16) over16++;
  }
  const sorted = Float32Array.from(lum).sort();
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    max: +max.toFixed(2),
    p50: +pct(0.5).toFixed(4),
    p99: +pct(0.99).toFixed(3),
    p999: +pct(0.999).toFixed(3),
    fracOver1: +(over1 / (W * H)).toFixed(5),
    fracOver4: +(over4 / (W * H)).toFixed(5),
    fracOver16: +(over16 / (W * H)).toFixed(6),
  };
}

function half2float(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

/* ------------------------------------------------------------------ */

let frames = 0;
function tick() {
  requestAnimationFrame(tick);
  renderer.render(scene, camera);
  frames++;
  if (frames === 4) {
    info.hdr = probeHDR();
    info.render = {
      calls: renderer.info.render.calls,
      tris: renderer.info.render.triangles,
      programs: renderer.info.programs?.length ?? 0,
    };
    window.__INFO__ = info;
    window.__READY__ = true;
  }
}
tick();

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
