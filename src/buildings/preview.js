import * as THREE from 'three';
import { MaterialSystem } from '../materials/index.js';
import { Rng } from '../core/rng.js';
import { ProtoLibrary, TileBuilder, releaseTile } from './tile.js';
import { planBuilding, buildLot, buildLotLod, blockPalette } from './archetypes.js';
import { districtStyle } from './palette.js';
import { Skyline } from './skyline.js';
import { buildLandmark, LANDMARKS, landmarkClaims } from './landmarks.js';
import { syntheticLots, SYNTH_TILE, DISTRICT_GEO } from './debug.js';

/**
 * BUILDINGS — standalone preview (dev tool, not shipped, not part of the game
 * boot). Boots the material forge against a bare renderer and builds the
 * generators' output on its own, so facade work can be reviewed while `render`,
 * `sky` and `world` are being rewritten in parallel and the app will not boot.
 *
 *   node src/buildings/shoot.mjs --view=street --out=/tmp/b.png
 */

const params = new URLSearchParams(location.search);
const VIEW = params.get('view') ?? 'street';
const HOUR = Number(params.get('hour') ?? 14.2);
const LOD = params.get('lod') ?? 'auto';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.4, 9000);

// --------------------------------------------------------------------- sky --
// Rakes across the elevations rather than down the street, so reveal depth,
// sill shadows and cornice projections are all legible in one frame.
const sunAngle = ((HOUR - 6) / 12) * Math.PI;
const elev = Math.sin(sunAngle);
const sunDir = new THREE.Vector3(0.78, Math.max(-0.25, elev * 0.85), 0.42).normalize();
const night = sunDir.y < 0.1;

const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: { uSun: { value: sunDir }, uNight: { value: night ? 1 : 0 } },
  vertexShader: `varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    varying vec3 vD; uniform vec3 uSun; uniform float uNight;
    void main(){
      vec3 d = normalize(vD);
      float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
      vec3 day = mix(vec3(0.62,0.66,0.70), vec3(0.16,0.30,0.60), pow(h,0.75));
      vec3 dusk = mix(vec3(0.85,0.45,0.22), vec3(0.06,0.10,0.24), pow(h,0.6));
      vec3 c = mix(day, dusk, uNight);
      float s = pow(max(0.0, dot(d, normalize(uSun))), 220.0);
      c += vec3(1.0,0.82,0.6) * s * 12.0;
      float g = pow(max(0.0, dot(d, normalize(uSun))), 5.0);
      c += vec3(0.9,0.6,0.35) * g * (0.25 + uNight * 0.5);
      gl_FragColor = vec4(c, 1.0);
    }`,
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 24), skyMat);
skyDome.frustumCulled = false;
scene.add(skyDome);

const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const envScene = new THREE.Scene();
envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 24), skyMat.clone()));
const envRT = pmrem.fromScene(envScene, 0.04);
scene.environment = envRT.texture;
scene.environmentIntensity = 0.8;

const sun = new THREE.DirectionalLight(0xfff2e0, night ? 0.2 : 4.3);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 1400;
sun.shadow.camera.left = -190;
sun.shadow.camera.right = 190;
sun.shadow.camera.top = 190;
sun.shadow.camera.bottom = -190;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.06;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xa8c0dc, 0x4a4038, night ? 0.25 : 1.35));
scene.fog = new THREE.FogExp2(night ? 0x0b1020 : 0x8fa2b4, night ? 0.00025 : 0.00035);

// --------------------------------------------------------------- materials --
const materials = new MaterialSystem({ renderer });
await materials.init({ config: { q: { anisotropy: 8 }, quality: 'high' }, peek: () => null });

const lib = new ProtoLibrary(materials);
const root = new THREE.Group();
scene.add(root);

/**
 * A stand-in for `world`'s ground so the first three metres of every facade can
 * actually be judged: pavement at kerb height under the blocks, asphalt in the
 * street. Not shipped — `world` owns the real terrain and road surface.
 */
const groundG = new THREE.PlaneGeometry(6000, 6000);
groundG.rotateX(-Math.PI / 2);
const ground = new THREE.Mesh(groundG, materials.get('asphalt', { scale: 3.0 }));
ground.receiveShadow = true;
scene.add(ground);
const walkMat = materials.get('concrete_floor', { scale: 2.4, tint: 0x9c9a94 });

// ------------------------------------------------------------------- views --
const D = Object.fromEntries(DISTRICT_GEO.map((d) => [d.id, d]));
const VIEWS = {
  // Synthetic blocks sit inside each 96 m tile with a 30 m street between them,
  // so a street camera has to stand on a tile boundary.
  // Synthetic blocks sit inside each 96 m tile with a 30 m street between them,
  // so a street camera stands on a tile boundary (x ~ 0 mod 96) and looks down
  // the canyon. `at` is snapped to the grid below.
  street: { at: [0, 0], pos: [3, 5.5, 150], look: [-1, 12, -40], fov: 62, r: 2 },
  facade: { at: [0, 0], pos: [5, 9, 60], look: [42, 15, 44], fov: 42, r: 2 },
  ground: { at: [0, 0], pos: [8, 1.85, 56], look: [34, 3.4, 44], fov: 66, r: 2 },
  lawrenGround: { at: [D.lawren.x, D.lawren.z], pos: [8, 1.85, 56], look: [34, 3.6, 44], fov: 68, r: 2 },
  lawrenFacade: { at: [D.lawren.x, D.lawren.z], pos: [4, 10, 62], look: [40, 12, 40], fov: 44, r: 2 },
  shop: { at: [D.lawren.x, D.lawren.z], pos: [10, 2.6, 40], look: [30, 4.2, 62], fov: 60, r: 2 },
  lawrenRoof: { at: [D.lawren.x, D.lawren.z], pos: [-6, 34, 70], look: [40, 14, 30], fov: 55, r: 2 },
  lawren: { at: [D.lawren.x, D.lawren.z], pos: [3, 5.4, 150], look: [-1, 11, -40], fov: 62, r: 2 },
  mtwash: { at: [D.mtwash.x, D.mtwash.z], pos: [3, 5.6, 150], look: [-1, 10, -40], fov: 62, r: 2 },
  steelrow: { at: [D.steelrow.x, D.steelrow.z], pos: [3, 7.5, 150], look: [-1, 18, -40], fov: 62, r: 2 },
  southside: { at: [D.southside.x, D.southside.z], pos: [3, 6.2, 150], look: [-1, 14, -40], fov: 62, r: 2 },
  downtown: { at: [D.downtown.x, D.downtown.z], pos: [3, 6.5, 150], look: [-1, 60, -50], fov: 66, r: 2 },
  // Mt. Washington looking across the Monongahela at the Golden Triangle. In
  // DESIGN.md's coordinates that is ~520 m, not 2 km — the whole city is 3 km
  // across and these two districts are neighbours across one river.
  skyline: {
    at: [D.downtown.x, D.downtown.z],
    pos: [D.mtwash.x + 40, 150, D.mtwash.z - 30],
    look: [D.downtown.x, 55, D.downtown.z],
    fov: 46,
    abs: true,
    r: 1,
  },
  // The genuinely long look: Hazelwood across to downtown, ~1.9 km.
  long: {
    at: [D.downtown.x, D.downtown.z],
    pos: [D.hazel.x + 200, 210, D.hazel.z + 120],
    look: [D.downtown.x, 60, D.downtown.z],
    fov: 34,
    abs: true,
    r: 1,
  },
  far: {
    at: [D.downtown.x, D.downtown.z],
    pos: [D.downtown.x + 620, 150, D.downtown.z + 700],
    look: [D.downtown.x, 50, D.downtown.z],
    fov: 45,
    abs: true,
    r: 1,
  },
  tower: { at: [LANDMARKS[0].x, LANDMARKS[0].z], pos: [180, 60, 240], look: [0, 110, 0], fov: 45, r: 1 },
  stadium: { at: [LANDMARKS[1].x, LANDMARKS[1].z], pos: [220, 90, 260], look: [0, 20, 0], fov: 48, r: 1 },
  mill: { at: [LANDMARKS[2].x, LANDMARKS[2].z], pos: [110, 40, 140], look: [0, 30, 0], fov: 50, r: 1 },
  incline: { at: [LANDMARKS[3].x, LANDMARKS[3].z], pos: [130, 60, 150], look: [0, 60, -260], fov: 50, r: 1 },
  fountain: { at: [LANDMARKS[4].x, LANDMARKS[4].z], pos: [70, 24, 80], look: [0, 3, 0], fov: 50, r: 1 },
  market: { at: [LANDMARKS[5].x, LANDMARKS[5].z], pos: [90, 30, 110], look: [0, 8, 0], fov: 50, r: 1 },
};

const view = VIEWS[VIEW] ?? VIEWS.street;
const snap = (v) => Math.round(v / SYNTH_TILE) * SYNTH_TILE;
const ax = view.abs ? view.at[0] : snap(view.at[0]);
const az = view.abs ? view.at[1] : snap(view.at[1]);
camera.position.set(
  view.abs ? view.pos[0] : ax + view.pos[0],
  view.pos[1],
  view.abs ? view.pos[2] : az + view.pos[2]
);
const target = new THREE.Vector3(
  view.abs ? view.look[0] : ax + view.look[0],
  view.look[1],
  view.abs ? view.look[2] : az + view.look[2]
);
camera.fov = view.fov;
camera.lookAt(target);
camera.updateProjectionMatrix();

// ------------------------------------------------------------------- build --
const t0 = performance.now();
const stats = { tris: 0, instTris: 0, instances: 0, draws: 0, lots: 0 };
const world = { heightAt: () => 0 };

const skyline = new Skyline(lib, new Rng(0x5111e));
skyline.build(world, root);

for (const lm of LANDMARKS) {
  const T = new TileBuilder(lib, `lm_${lm.id}`);
  try {
    buildLandmark(T, lib, lm, new Rng(lm.seed), 0);
  } catch (err) {
    console.error('landmark', lm.id, err);
    continue;
  }
  const b = T.build(null);
  root.add(b.group);
  acc(b.stats);
}

const R = Number(params.get('r') ?? view.r ?? 3);
const ctx0 = Math.floor(camera.position.x / SYNTH_TILE);
const ctz0 = Math.floor(camera.position.z / SYNTH_TILE);
for (let tz = ctz0 - R; tz <= ctz0 + R; tz++) {
  for (let tx = ctx0 - R; tx <= ctx0 + R; tx++) {
    const lots = syntheticLots(tx, tz);
    if (!lots.length) continue;
    const T = new TileBuilder(lib, `t${tx}_${tz}`);
    const cx = (tx + 0.5) * SYNTH_TILE;
    const cz = (tz + 0.5) * SYNTH_TILE;
    const dist = Math.hypot(cx - camera.position.x, cz - camera.position.z);
    const useNear = LOD === 'near' ? true : LOD === 'far' ? false : dist < 175;
    const tileSeed = (Math.imul(tx | 0, 0x27d4eb2d) ^ Math.imul(tz | 0, 0x165667b1)) >>> 0;
    const blocks = new Map();
    for (const lot of lots) {
      if (landmarkClaims(lot.footprint[0][0], lot.footprint[0][1])) continue;
      const style = districtStyle(lot.district);
      const seed = lot.seed >>> 0;
      let block = blocks.get(lot.district);
      if (!block) blocks.set(lot.district, (block = blockPalette(Rng, tileSeed, style)));
      let plan;
      try {
        plan = planBuilding(lot, style, new Rng(seed), block);
      } catch (err) {
        console.error('plan', err);
        continue;
      }
      stats.lots++;
      try {
        if (useNear) buildLot(T, lib, plan, new Rng(seed ^ 0x51ed), 0);
        else buildLotLod(T, lib, plan, new Rng(seed ^ 0x9e37), 0);
      } catch (err) {
        console.error('build', err);
      }
    }
    const b = T.build(null);
    root.add(b.group);
    acc(b.stats);

    // pavement slab under the block, so buildings meet a kerb not a void
    const pw = SYNTH_TILE - 30 + 14;
    const walk = new THREE.Mesh(new THREE.BoxGeometry(pw, 0.28, pw), walkMat);
    walk.position.set(tx * SYNTH_TILE + SYNTH_TILE / 2, 0.14, tz * SYNTH_TILE + SYNTH_TILE / 2);
    walk.receiveShadow = true;
    walk.castShadow = true;
    root.add(walk);
  }
}

skyline.update(camera.position, (R + 0.5) * SYNTH_TILE);

function acc(s) {
  stats.tris += s.tris;
  stats.instTris += s.instTris;
  stats.instances += s.instances;
  stats.draws += s.draws;
}

const buildMs = performance.now() - t0;

// lit windows: match what BuildingSystem.update does with the solar altitude
const mix = 1 - Math.min(1, Math.max(0, (sunDir.y + 0.06) / 0.2));
for (const k of ['room_lit_warm', 'room_lit_cool', 'neon_amber', 'neon_teal', 'neon_red']) {
  const m = lib._mats.get(k);
  if (m) m.emissiveIntensity = (m.emissiveIntensity || 1) * (0.22 + 5.2 * mix);
}

root.traverse((o) => {
  if (o.isMesh || o.isInstancedMesh) {
    o.castShadow = o.castShadow !== false;
    o.receiveShadow = true;
  }
});
// Centre the cascade on what the shot is actually looking at.
const focus = camera.position.clone().lerp(target, 0.45);
focus.y = 20;
sun.target.position.copy(focus);
sun.position.copy(focus).add(sunDir.clone().multiplyScalar(600));
scene.add(sun.target);
sun.target.updateMatrixWorld(true);
sun.updateMatrixWorld(true);
renderer.toneMappingExposure = night ? 1.6 : 1.0;

renderer.render(scene, camera);
window.__INFO__ = {
  view: VIEW,
  buildMs: Math.round(buildMs),
  lots: stats.lots,
  staticTris: Math.round(stats.tris),
  instTris: Math.round(stats.instTris),
  instances: stats.instances,
  batches: stats.draws,
  protos: lib.protos.size,
  drawn: renderer.info.render.calls,
  drawnTris: renderer.info.render.triangles,
};
console.info('[buildings preview]', JSON.stringify(window.__INFO__));

/**
 * Debug pick grid. Raycasts through a lattice of screen points and reports the
 * mesh under each, so "what IS that pale panel" is a question with an answer
 * rather than a guess. Mesh names carry the surface key (`b_<key>` for merged
 * batches, `bi_<protoId>` for instance groups).
 */
{
  const rc = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const grid = [];
  for (let j = 0; j < 6; j++) {
    for (let i = 0; i < 8; i++) {
      const u = (i + 0.5) / 8;
      const v = (j + 0.5) / 6;
      ndc.set(u * 2 - 1, -(v * 2 - 1));
      rc.setFromCamera(ndc, camera);
      const hit = rc.intersectObject(root, true)[0];
      grid.push({
        u: +u.toFixed(2),
        v: +v.toFixed(2),
        name: hit ? hit.object.name : '-',
        d: hit ? +hit.distance.toFixed(1) : -1,
      });
    }
  }
  window.__PICK__ = grid;
}

let frames = 0;
function tick() {
  renderer.render(scene, camera);
  if (++frames === 3) window.__READY__ = true;
  requestAnimationFrame(tick);
}
tick();

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
