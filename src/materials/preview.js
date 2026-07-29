/**
 * Standalone visual harness for the materials subsystem.
 *
 * The rest of the engine may be stubbed at any
 * moment, so this page boots *only* materials against a minimal renderer,
 * physical sun/sky and a PMREM environment. It is a development tool: nothing
 * in the game imports it and it is not part of the production bundle.
 *
 *   /src/materials/preview.html?view=<view>&...
 *
 * Views:
 *   board     every surface on a sphere + a bevelled panel  (&page=0..N)
 *   graze     THE TEST THAT MATTERS. One surface, a big flat plane plus a
 *             chamfered block, lit by a hard low sun raking across it, camera
 *             near-grazing. A missing normal map is invisible under a studio
 *             dome and unmissable here.  (&m=<name>)
 *   pair      the same surface dry and wet, side by side, low sun
 *   cars      the layered car-paint finishes plus glass, chrome, trim, tyre
 *   river     the water surface with a bank, a pier and a wake
 *   street    a road corner: carriageway, markings, kerb, sidewalk, drain
 *   wall      a building corner (the legacy view, kept for regression)
 *   flat      unlit albedo | normal | ORM channel inspection  (&m=a,b,c)
 *
 * Modifiers:  &wet=0..1  &rain=0..1  &sun=low|noon|dusk  &fov=  &dbg=
 */
import * as THREE from 'three';
import { MaterialSystem } from './index.js';

const params = new URLSearchParams(location.search);
const VIEW = params.get('view') ?? 'board';
const SUN = params.get('sun') ?? 'noon';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 400);
/** The camera actually handed to render(); the `tiling` view swaps in an ortho. */
let renderCam = camera;

// ---------------------------------------------------------------- sky ------
/**
 * Sun elevation presets. `low` is the one that matters: a 9-degree sun raking
 * across a surface is the single most punishing light for a missing or weak
 * normal map, and it is also the light DESIGN.md calls the money shot.
 */
const SUNS = {
  noon: { dir: [0.42, 0.42, 0.8], int: 2.6, col: 0xfff0dc, zen: [0.16, 0.31, 0.62], hor: [0.72, 0.74, 0.72], amb: 1.0 },
  low: { dir: [0.94, 0.158, 0.30], int: 4.2, col: 0xffd7a0, zen: [0.13, 0.24, 0.50], hor: [0.86, 0.68, 0.48], amb: 0.55 },
  dusk: { dir: [0.97, 0.06, -0.22], int: 3.0, col: 0xff9a52, zen: [0.09, 0.15, 0.34], hor: [0.78, 0.44, 0.26], amb: 0.4 },
};
const S = SUNS[SUN] ?? SUNS.noon;
const sunDir = new THREE.Vector3(...S.dir).normalize();

const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    uSun: { value: sunDir.clone() },
    uZenith: { value: new THREE.Color(...S.zen) },
    uHorizon: { value: new THREE.Color(...S.hor) },
    uGround: { value: new THREE.Color(0.19, 0.16, 0.13) },
    uGain: { value: S.amb * 1.35 },
  },
  vertexShader: `varying vec3 vD; void main(){ vD = position; gl_Position = (projectionMatrix * modelViewMatrix * vec4(position,1.0)).xyww; }`,
  fragmentShader: `
    varying vec3 vD; uniform vec3 uSun, uZenith, uHorizon, uGround; uniform float uGain;
    void main(){
      vec3 d = normalize(vD);
      float t = d.y;
      vec3 c = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, t));
      c = mix(uGround, c, smoothstep(-0.12, 0.02, t));
      float s = max(dot(d, normalize(uSun)), 0.0);
      c += vec3(1.0, 0.82, 0.6) * pow(s, 8.0) * 0.6;
      c += vec3(1.0, 0.95, 0.85) * pow(s, 900.0) * 40.0;
      gl_FragColor = vec4(c * uGain, 1.0);
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(200, 32, 16), skyMat);
sky.frustumCulled = false;
scene.add(sky);

const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();

// -------------------------------------------------------------- lights -----
const sun = new THREE.DirectionalLight(S.col, S.int);
sun.position.copy(sunDir).multiplyScalar(24);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 80;
sun.shadow.camera.left = -14;
sun.shadow.camera.right = 14;
sun.shadow.camera.top = 14;
sun.shadow.camera.bottom = -14;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);
scene.add(sun.target);

const bounce = new THREE.DirectionalLight(0x88a0c0, 0.35 * S.amb);
bounce.position.set(-8, 3, -10);
scene.add(bounce);

// ------------------------------------------------------------ materials ----
const materials = new MaterialSystem({ renderer, noDilate: params.get('nodilate') === '1',
  noZone: params.get('nozone') === '1',
});
await materials.init({ config: { quality: 'ultra', q: { anisotropy: 16 } } });
materials.setGroundLevel(0);
// ?wet / ?rain drive the shared wetness uniforms exactly as `sky` will.
// This is the exact call the `sky` subsystem makes, so the harness exercises
// the published contract rather than a private path.
materials.setWetness(Number(params.get('wet') ?? 0));
materials.setWeather({
  rain: Number(params.get('rain') ?? 0),
  wind: Number(params.get('wind') ?? 0.3),
});
console.info('[preview] wetness ->', materials.wetness, JSON.stringify(materials.weather));

const env = pmrem.fromScene(scene, 0, 0.1, 300);
scene.environment = env.texture;
scene.environmentIntensity = 1.0;

// --------------------------------------------------------------- scenes ----
const disposables = [];
function mesh(geo, mat, pos, rot, parent) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.fromArray(pos);
  if (rot) m.rotation.fromArray(rot);
  m.castShadow = true;
  m.receiveShadow = true;
  (parent ?? scene).add(m);
  disposables.push(geo);
  return m;
}

function groundPlane(name = 'asphalt', size = 60, opts) {
  const g = new THREE.PlaneGeometry(size, size, 60, 60);
  g.rotateX(-Math.PI / 2);
  return mesh(g, materials.get(name, opts), [0, 0, 0]);
}

/** A chamfered block: the shape that exposes a bad normal map at every angle. */
function block(w, h, d, seg = 10) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  materials.bakeMasks(g, { wear: 1, grime: 1 });
  return g;
}

if (VIEW === 'board') {
  const page = Number(params.get('page') ?? 0);
  const perPage = Number(params.get('per') ?? 25);
  const cols = Number(params.get('cols') ?? 5);
  const all = materials.names();
  const names = all.slice(page * perPage, (page + 1) * perPage);
  const group = new THREE.Group();
  const sphere = new THREE.SphereGeometry(0.42, 64, 48);
  const panel = new THREE.BoxGeometry(0.92, 0.92, 0.14, 10, 10, 3);
  materials.bakeMasks(panel, { wear: 1, grime: 0.9 });
  names.forEach((name, i) => {
    const x = (i % cols) * 1.35;
    const y = -Math.floor(i / cols) * 1.35;
    const s = new THREE.Mesh(sphere, materials.get(name, { vertexMasks: false }));
    s.position.set(x, y, 0);
    s.castShadow = s.receiveShadow = true;
    group.add(s);
    const b = new THREE.Mesh(panel, materials.get(name, { vertexMasks: true, localSpace: true }));
    b.position.set(x, y, -0.9);
    b.castShadow = b.receiveShadow = true;
    group.add(b);
  });
  const rows = Math.ceil(names.length / cols);
  group.position.set((-(cols - 1) * 1.35) / 2, 0.85 + (rows - 1) * 1.35, 0);
  scene.add(group);
  groundPlane('concrete_floor', 40);
  camera.position.set(0, 0.85 + ((rows - 1) * 1.35) / 2, 7.6);
  camera.lookAt(0, 0.85 + ((rows - 1) * 1.35) / 2, 0);
  window.__NAMES__ = names;
  window.__PAGES__ = Math.ceil(all.length / perPage);
} else if (VIEW === 'graze' || VIEW === 'pair') {
  /**
   * THE GRAZING TEST.
   *
   * A big flat plane of one surface plus a chamfered block standing on it, lit
   * by a hard low sun coming in almost along the plane, with the camera close
   * to the surface and looking along it. Every failure the critic named shows
   * up here and nowhere else: a flat normal map gives a plane with a single
   * smooth luminance ramp and a block with four perfectly clean faces.
   */
  const name = params.get('m') ?? 'road_asphalt';
  const wet = Number(params.get('wet') ?? 0);
  const cases = VIEW === 'pair' ? [0, Math.max(wet, 0.9)] : [wet];

  cases.forEach((w, i) => {
    const root = new THREE.Group();
    root.position.x = (i - (cases.length - 1) / 2) * 9;
    scene.add(root);
    const g = new THREE.PlaneGeometry(8.4, 14, 40, 60);
    g.rotateX(-Math.PI / 2);
    const gm = new THREE.Mesh(g, materials.get(name));
    gm.receiveShadow = true;
    root.add(gm);
    // A chamfered block and a cylinder: flats, arrises and a continuous curve.
    const b = block(1.6, 1.0, 1.6, 12);
    const bm = new THREE.Mesh(b, materials.get(name, { vertexMasks: true }));
    bm.position.set(-1.5, 0.5, -1.2);
    bm.castShadow = bm.receiveShadow = true;
    root.add(bm);
    const cyl = new THREE.CylinderGeometry(0.55, 0.55, 1.5, 48, 6);
    materials.bakeMasks(cyl, { wear: 1, grime: 1 });
    const cm = new THREE.Mesh(cyl, materials.get(name, { vertexMasks: true }));
    cm.position.set(1.4, 0.75, -1.0);
    cm.castShadow = cm.receiveShadow = true;
    root.add(cm);
    root.userData.wet = w;
  });
  if (VIEW === 'pair') {
    // Two wetness values cannot coexist in one shared uniform, so `pair` shows
    // the same geometry twice and the shot harness takes two frames.
    materials.setWeather({ wetness: cases[1] });
  }
  camera.fov = Number(params.get('fov') ?? 34);
  camera.position.set(0, 0.62, 5.4);
  camera.lookAt(0, 0.20, -3.2);
  camera.updateProjectionMatrix();
} else if (VIEW === 'cars') {
  groundPlane('road_lane', 40, { uvMode: 'planar', scale: 4 });
  const finishes = ['gloss', 'metallic', 'matte', 'primer', 'faded', 'rusted', 'dirty'];
  const colours = [0xb2231a, 0x1c4f8b, 0x2b2f33, 0x6d6a68, 0x9c4f3a, 0x7c5c4a, 0x2f5d78];
  // A panel with a real curve: car paint is read off a highlight sweeping a
  // crown, so a flat swatch tells you nothing.
  const crown = new THREE.SphereGeometry(0.62, 96, 64);
  finishes.forEach((f, i) => {
    const m = materials.carPaint(colours[i], { finish: f });
    const x = (i - 3) * 1.62;
    mesh(crown, m, [x, 0.75, 0]);
    const fender = new THREE.CylinderGeometry(0.46, 0.46, 1.2, 64, 4, false, 0, Math.PI);
    mesh(fender, m, [x, 0.10, 2.1], [0, 0, Math.PI / 2]);
  });
  // the rest of the vehicle kit
  const kit = ['auto_glass_tinted', 'chrome', 'trim_plastic', 'tyre_tread', 'alloy'];
  kit.forEach((n, i) => {
    const x = (i - 2) * 1.62;
    mesh(new THREE.SphereGeometry(0.48, 64, 48), materials.get(n), [x, 0.70, -2.6]);
  });
  const wheel = new THREE.CylinderGeometry(0.42, 0.42, 0.30, 64, 3);
  mesh(wheel, materials.get('tyre'), [3.4, 0.62, -2.6], [0, 0, Math.PI / 2]);
  camera.fov = 46;
  camera.position.set(0, 2.6, 8.6);
  camera.lookAt(0, 0.45, -0.6);
  camera.updateProjectionMatrix();
} else if (VIEW === 'river') {
  // A bank of silt, a stone pier and the water between them.
  const bank = new THREE.PlaneGeometry(60, 30, 60, 30);
  bank.rotateX(-Math.PI / 2);
  const pos = bank.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    // The bank falls AWAY from the camera into the channel: high at negative z,
    // crossing the waterline around z = -2, and shelving off below it.
    const y = Math.max(-3.0, Math.min(2.6, -(z + 2) * 0.26));
    pos.setY(i, y + Math.sin(x * 0.4) * 0.09 + Math.cos(z * 0.7) * 0.05);
  }
  bank.computeVertexNormals();
  mesh(bank, materials.get('river_silt'), [0, -0.4, -6]);

  const water = materials.water({ flow: [1, 0.25], speed: 1.2, turbidity: 0.72 });
  const wg = new THREE.PlaneGeometry(80, 60, 1, 1);
  wg.rotateX(-Math.PI / 2);
  const wm = new THREE.Mesh(wg, water);
  wm.position.set(0, 0, 6);
  wm.receiveShadow = false;
  scene.add(wm);
  // a bridge pier standing in it
  const pier = new THREE.CylinderGeometry(1.4, 1.7, 7, 32, 6);
  mesh(pier, materials.get('stone_clad'), [-4, 2.0, 6]);
  const pier2 = new THREE.CylinderGeometry(1.4, 1.7, 7, 32, 6);
  mesh(pier2, materials.get('stone_clad_sooted'), [7, 2.0, 12]);
  // a wake, as `vehicles` would drive it
  // A hull running away from the camera: one source per frame along its track,
  // which is exactly the call pattern `vehicles` will use.
  const w = water.userData.owWater;
  for (let i = 0; i < 5; i++) {
    w.addWake(1.5 + i * 0.9, 4 + i * 3.2, 1.0 - i * 0.14, 1.1 + i * 0.55, 1.6);
  }
  camera.fov = 46;
  camera.position.set(-3.5, 4.4, -12);
  camera.lookAt(2.0, -1.0, 10);
  camera.updateProjectionMatrix();
} else if (VIEW === 'street') {
  // The road corner: everything a wheel touches, in one frame.
  const road = new THREE.PlaneGeometry(24, 40, 48, 80);
  road.rotateX(-Math.PI / 2);
  // the road is cambered, which is what puts the puddles in the gutter
  const rp = road.getAttribute('position');
  for (let i = 0; i < rp.count; i++) {
    const x = rp.getX(i);
    rp.setY(i, -Math.abs(x) * 0.022);
  }
  road.computeVertexNormals();
  mesh(road, materials.get('road_lane', { uvMode: 'planar', scale: 4.2 }), [0, 0, 0]);

  // markings
  const line = new THREE.PlaneGeometry(0.5, 40);
  line.rotateX(-Math.PI / 2);
  mesh(line, materials.get('road_line_dash', { uvMode: 'mesh', scale: 1 }), [0, 0.004, 0]);
  const yellow = new THREE.PlaneGeometry(0.6, 40);
  yellow.rotateX(-Math.PI / 2);
  mesh(yellow, materials.get('road_line_double'), [-5.6, 0.004, 0]);
  const cross = new THREE.PlaneGeometry(11, 3.4);
  cross.rotateX(-Math.PI / 2);
  mesh(cross, materials.get('road_crossing'), [0, 0.005, -9]);
  const stopb = new THREE.PlaneGeometry(5.4, 0.9);
  stopb.rotateX(-Math.PI / 2);
  mesh(stopb, materials.get('road_stopbar'), [2.8, 0.005, -11.4]);
  const arrow = new THREE.PlaneGeometry(2.6, 5.2);
  arrow.rotateX(-Math.PI / 2);
  mesh(arrow, materials.get('road_arrow'), [2.8, 0.005, -4.5]);

  // kerb + sidewalk
  const kerbG = new THREE.BoxGeometry(0.42, 0.34, 40, 2, 2, 60);
  materials.bakeMasks(kerbG, { wear: 1, grime: 1 });
  mesh(kerbG, materials.get('kerb'), [7.0, 0.10, 0]);
  const walk = new THREE.BoxGeometry(4.4, 0.30, 40, 8, 1, 60);
  materials.bakeMasks(walk, { wear: 1, grime: 1 });
  mesh(walk, materials.get('sidewalk'), [9.4, 0.12, 0]);

  // drains and covers
  const q = new THREE.PlaneGeometry(0.95, 0.95);
  q.rotateX(-Math.PI / 2);
  mesh(q, materials.get('manhole'), [-2.0, 0.006, 3]);
  const gq = new THREE.PlaneGeometry(1.1, 0.7);
  gq.rotateX(-Math.PI / 2);
  mesh(gq, materials.get('drain_grate'), [6.5, 0.004, -2]);

  // a facade behind it, for the district read
  const fac = block(0.6, 9, 20, 10);
  mesh(fac, materials.get('pgh_brick_old'), [12.2, 4.5, 2]);
  const fac2 = block(0.6, 7, 14, 10);
  mesh(fac2, materials.get('brick_sooted'), [-9.0, 3.5, -4]);

  camera.fov = Number(params.get('fov') ?? 40);
  camera.position.set(3.6, 1.55, 12);
  camera.lookAt(0.5, 0.4, -6);
  camera.updateProjectionMatrix();
} else if (VIEW === 'tiling') {
  /**
   * THE MEASUREMENT SCENE FOR `tilecheck.mjs`.
   *
   * One material, one flat plane, straight down through an ORTHOGRAPHIC camera
   * at an exact metres-to-pixels ratio, with no shadow caster and a directional
   * key that is identical at every point on the plane. Under ortho the view
   * vector is constant too, so Fresnel and NdV do not vary across the frame.
   *
   * That matters because the gate compares two windows of this image: if
   * anything except the material could differ between them, the number it
   * produces is about the lighting, not about tiling. See tilecheck.mjs for
   * what is done with it and for the negative control.
   */
  const name = params.get('m') ?? 'road_lane';
  const ppm = Number(params.get('ppm') ?? 96); // pixels per metre
  const uvM = Number(params.get('uvm') ?? 4); // metres per mesh-uv unit
  const opts = { vertexMasks: true };
  if (params.get('detile') === '0') {
    opts.detile = 0;
    opts.detileLane = false;
  }
  if (params.get('detset') !== null) opts.detailSet = Number(params.get('detset'));
  if (params.get('detrot') !== null) opts.detailRot = Number(params.get('detrot'));
  if (params.get('macro') === '0') {
    opts.macro = [0.045, 0, 0, 0];
    opts.macroBig = [1, 0, 0.03, 0];
    opts.macroRelief = 0;
  }
  /**
   * The micro-correlation half of the gate has to put two surfaces on the
   * IDENTICAL mapping first. Two materials whose detail layers simply run at
   * different frequencies decorrelate for a reason that has nothing to do with
   * whether they share a texture, and a gate that measured that would report a
   * pass it had not earned.
   */
  if (params.get('scale') !== null) {
    opts.uvMode = 'planar';
    opts.scale = Number(params.get('scale'));
    opts.detailWorld = 0;
    opts.parallax = 0;
  }
  if (params.get('dtl') !== null) {
    opts.detail = [Number(params.get('dtl')), 1.0, 1.3, 400];
    opts.meso = [0.055, 0, 0, 0];
  }
  const PW = innerWidth / ppm;
  const PH = innerHeight / ppm;
  const g = new THREE.PlaneGeometry(PW, PH, 1, 1);
  g.rotateX(-Math.PI / 2);
  // World-metre UVs, so a mesh-uv surface (a carriageway) lands at exactly the
  // mapping `roadmesh` gives it: 1 uv unit = 4 m.
  const uvA = g.attributes.uv;
  const posA = g.attributes.position;
  for (let i = 0; i < uvA.count; i++) uvA.setXY(i, posA.getX(i) / uvM, posA.getZ(i) / uvM);
  uvA.needsUpdate = true;
  materials.bakeMasks(g, { wear: 0, grime: 0 });
  const plane = new THREE.Mesh(g, materials.get(name, opts));
  plane.castShadow = false;
  plane.receiveShadow = false;
  scene.add(plane);
  disposables.push(g);
  renderer.shadowMap.enabled = false;
  const oc = new THREE.OrthographicCamera(-PW / 2, PW / 2, PH / 2, -PH / 2, 0.1, 200);
  oc.position.set(0, 40, 0);
  oc.up.set(0, 0, -1);
  oc.lookAt(0, 0, 0);
  oc.updateProjectionMatrix();
  renderCam = oc;
  window.__TILING__ = { name, ppm, uvM };
} else if (VIEW === 'detailmap') {
  /**
   * One of the shared micro sets, unlit and unfiltered, filling the frame.
   *
   * This exists so `tilecheck.mjs` can cross-correlate the micro FIELDS
   * themselves rather than inferring their similarity from two lit surfaces
   * whose base textures would dominate the statistic. `&i=` picks the set,
   * `&rot=` applies the same rotation the material shader would.
   */
  const i = Number(params.get('i') ?? 0);
  const rot = Number(params.get('rot') ?? 0) * Math.PI * 2;
  const which = params.get('ch') === 'normal' ? materials.detailNormals : materials.detailAlbedos;
  const tex = which[Math.min(i, which.length - 1)];
  // The rotation goes on the GEOMETRY's uvs, not on the texture: these are
  // render-target textures shared with every material in the scene, and giving
  // one of them its own offset/rotation would move it for all of them.
  const qg = new THREE.PlaneGeometry(2, 2, 1, 1);
  const qu = qg.attributes.uv;
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  for (let k = 0; k < qu.count; k++) {
    const x = (qu.getX(k) - 0.5) * 3;
    const y = (qu.getY(k) - 0.5) * 3;
    qu.setXY(k, x * cr - y * sr + 0.5, x * sr + y * cr + 0.5);
  }
  qu.needsUpdate = true;
  const qd = new THREE.Mesh(qg, new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  scene.remove(sky);
  scene.background = new THREE.Color(0x000000);
  scene.add(qd);
  renderCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
  renderCam.position.set(0, 0, 2);
  renderCam.lookAt(0, 0, 0);
  renderCam.updateProjectionMatrix();
} else if (VIEW === 'flat') {
  const which = (params.get('m') ?? 'road_asphalt,pgh_brick,grass,carpaint').split(',');
  const quad = new THREE.PlaneGeometry(1, 1);
  which.forEach((name, row) => {
    const set = materials.getTextureSet(name);
    [set.albedo, set.normal, set.orm].forEach((tex, col) => {
      const m = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
      const qd = new THREE.Mesh(quad, m);
      qd.position.set(col * 1.06 - 1.06, -row * 1.06, 0);
      scene.add(qd);
    });
  });
  scene.remove(sky);
  scene.background = new THREE.Color(0x101010);
  camera.position.set(0, -((which.length - 1) * 1.06) / 2, 2.4 + which.length * 0.55);
  camera.lookAt(0, -((which.length - 1) * 1.06) / 2, 0);
} else if (VIEW === 'wall' || VIEW === 'closeup' || VIEW === 'grazing') {
  groundPlane('asphalt', 60);
  const dbg = params.get('dbg') ?? '';
  const M = { vertexMasks: true };
  if (dbg.includes('nopom')) M.parallax = 0;
  if (dbg.includes('nodetile')) M.detile = 0;
  if (dbg.includes('noweather')) M.weather = [0, 0, 0, 0];
  if (dbg.includes('nodetail')) M.detail = [11, 0, 0, 16];
  let brick = materials.get('brick', M);
  if (dbg.includes('nograd')) brick = materials.get('brick', { ...M, noGrad: true });
  if (dbg.includes('meshuv')) brick = materials.get('brick', { ...M, uvMode: 'mesh', scale: 4 });
  const concrete = materials.get('concrete', M);
  const plaster = materials.get('plaster', M);
  const wood = materials.get('wood', M);
  const corr = materials.get('corrugated', M);
  const painted = materials.get('metal_painted', M);
  const rust = materials.get('metal_rust');
  const sandbagMat = materials.get('burlap');

  mesh(block(7, 4.2, 0.42, 14), brick, [0, 2.45, 0]);
  mesh(block(0.42, 4.2, 6, 10), plaster, [-3.29, 2.45, -3.2]);
  mesh(block(7.4, 0.72, 0.62, 14), concrete, [0, 0.36, 0.02]);
  mesh(block(0.55, 3.4, 0.55, 8), concrete, [3.9, 1.7, 1.4]);
  const crate = block(0.78, 0.62, 0.62, 6);
  mesh(crate, wood, [1.55, 0.31, 1.5], [0, 0.34, 0]);
  mesh(crate.clone(), wood, [1.35, 0.93, 1.62], [0, -0.2, 0.03]);
  mesh(new THREE.BoxGeometry(2.6, 2.0, 0.05, 8, 8, 1), corr, [-2.0, 1.35, 1.3], [0, 0.22, 0.04]);
  mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.9, 40, 3), rust, [2.9, 0.45, 1.9], [0, 0, 0.02]);
  mesh(block(0.1, 1.9, 0.1, 4), painted, [-0.5, 0.95, 1.9]);
  const bag = new THREE.SphereGeometry(0.34, 24, 16);
  bag.scale(1.5, 0.6, 0.9);
  for (let i = 0; i < 5; i++) mesh(bag.clone(), sandbagMat, [-3.0 + i * 0.62, 0.2, 2.3], [0, i * 0.13, 0]);

  if (VIEW === 'wall') {
    camera.position.set(4.4, 1.7, 5.6);
    camera.lookAt(-0.4, 1.5, 0.2);
  } else if (VIEW === 'closeup') {
    camera.fov = 40;
    camera.position.set(0.4, 1.35, 1.05);
    camera.lookAt(0.1, 1.15, 0.0);
  } else {
    camera.fov = 38;
    camera.position.set(3.2, 1.25, 0.62);
    camera.lookAt(-3.2, 1.15, 0.35);
  }
  camera.updateProjectionMatrix();
} else {
  // legacy 'street'-style scene, kept so old shot names still resolve
  groundPlane('asphalt', 80);
  mesh(new THREE.BoxGeometry(60, 0.18, 3.2, 30, 1, 3), materials.get('concrete_floor'), [0, 0.09, 6.5]);
  mesh(block(9, 7, 0.5, 16), materials.get('brick'), [-6, 3.5, 9]);
  mesh(block(11, 8.5, 0.5, 18), materials.get('plaster'), [6.5, 4.25, 9.2]);
  camera.position.set(9, 1.75, 15);
  camera.lookAt(-3, 2.0, -2);
}

sun.target.position.set(0, 0.4, -3);
sun.target.updateMatrixWorld();

// --------------------------------------------------------------- loop ------
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  if (renderCam.isPerspectiveCamera) {
    renderCam.aspect = innerWidth / innerHeight;
    renderCam.updateProjectionMatrix();
  }
});

if ((params.get('dbg') ?? '').includes('noshadow')) renderer.shadowMap.enabled = false;

let frames = 0;
const t0 = performance.now();
function tick() {
  const t = (performance.now() - t0) / 1000;
  materials.update(0.016);
  materials.wetnessUniforms.owWetP.value.w = t;
  if (materials.waterSurface) materials.waterSurface.uniforms.owFlow.value.w = t;
  renderer.render(scene, renderCam);
  if (++frames === 3) {
    window.__READY__ = true;
    window.__INFO__ = {
      calls: renderer.info.render.calls,
      tris: renderer.info.render.triangles,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0,
      surfaces: materials.names().length,
    };
  }
  requestAnimationFrame(tick);
}
tick();

window.__RENDERER__ = renderer;
window.__MATERIALS__ = materials;
