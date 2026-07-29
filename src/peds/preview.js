/**
 * DEV ONLY — standalone crowd rig for iterating on pedestrians without booting
 * the whole game. Studio lighting, a real PMREM environment, and the SAME
 * wardrobe, builder, materials and animator the game uses, so what is judged
 * here is what ships.
 *
 *   /src/peds/preview.html?view=close&shape=overcoatM&clip=walk&phase=0.3
 *
 * Views: close (2 m) · face · hands · line (every silhouette) · group (10 m) ·
 *        street (40 m) · gait (one shape, six people walking)
 */

import * as THREE from 'three';
import { Rng } from '../core/rng.js';
import { PedMaterials, MATERIAL_SLOTS } from './materials.js';
import { buildOutfit } from './builder.js';
import { SHAPE_IDS, makeOutfit, ARCHETYPE_IDS } from './wardrobe.js';
import { RIG } from './rig.js';
import { PedAnimator } from './animator.js';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.05, 400);

/* ---- environment: an overcast rustbelt sky through PMREM ---- */
const envScene = new THREE.Scene();
{
  const g = new THREE.SphereGeometry(60, 32, 24);
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader:
      'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `
      varying vec3 vP;
      void main(){
        vec3 d = normalize(vP);
        vec3 sky = mix(vec3(0.62,0.68,0.78), vec3(0.24,0.30,0.40), clamp(d.y*1.5,0.0,1.0));
        vec3 ground = vec3(0.12,0.115,0.108);
        vec3 c = mix(ground, sky, smoothstep(-0.10, 0.12, d.y));
        float s = max(0.0, dot(d, normalize(vec3(-0.42,0.55,0.42))));
        c += vec3(4.2,3.9,3.4) * pow(s, 700.0);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  envScene.add(new THREE.Mesh(g, m));
}
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(envScene, 0.05).texture;
scene.background = new THREE.Color(0x2b3038);

const key = new THREE.DirectionalLight(0xfff0dc, 2.6);
key.position.set(-4.2, 5.4, 3.2);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -8;
key.shadow.camera.right = 8;
key.shadow.camera.top = 6;
key.shadow.camera.bottom = -1;
key.shadow.camera.far = 40;
key.shadow.bias = -0.0006;
scene.add(key);
const rim = new THREE.DirectionalLight(0xa8c4e6, 0.9);
rim.position.set(3.0, 2.4, -4.0);
scene.add(rim);
scene.add(new THREE.HemisphereLight(0x9fb2c8, 0x241f19, 0.5));

{
  const g = new THREE.CircleGeometry(200, 64).rotateX(-Math.PI / 2);
  const m = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.93, metalness: 0 });
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  scene.add(mesh);
}

/* ---- the crowd ---- */
const rng = new Rng(Number(q.get('seed') ?? 0xc17e));
const materials = new PedMaterials(rng.fork(), { size: 512, anisotropy: 8 });
const cache = new Map();
const variantOf = (id) => {
  let v = cache.get(id);
  if (!v) cache.set(id, (v = buildOutfit(id, { rng: rng.fork() })));
  return v;
};

const view = q.get('view') ?? 'close';
const clipName = q.get('clip') ?? (view === 'close' || view === 'line' ? 'idle' : view === 'panic' ? 'run' : 'walk');
const phase = Number(q.get('phase') ?? 0);
const actors = [];

const probe = (x, z, fromY, out) => {
  out.y = 0; out.nx = 0; out.ny = 1; out.nz = 0; out.hit = true;
  return true;
};

function makePed(shapeId, archetype, x, z, yaw, speed) {
  const v = variantOf(shapeId);
  const outfit = makeOutfit(rng.fork(), archetype, { shape: shapeId });
  const { bones, skeleton, root } = RIG.createSkeleton();
  const palette = materials.createPalette();
  const fabric = materials.createFabric();
  const set = materials.createSet(palette, fabric);
  const matArr = v.materialNames.map((n) => set[MATERIAL_SLOTS.indexOf(n)]);
  const pal = palette.value;
  for (let i = 0; i < pal.length; i++) {
    pal[i].setRGB(outfit.palette[i][0], outfit.palette[i][1], outfit.palette[i][2]);
  }
  const fab = fabric.value;
  for (let i = 0; i < fab.length && outfit.fabric; i++) {
    const f = outfit.fabric[i];
    fab[i].set(f[0], f[1], f[2], f[3]);
  }
  const mesh = new THREE.SkinnedMesh(v.geometry, matArr);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const group = new THREE.Group();
  group.add(root);
  group.add(mesh);
  mesh.bind(skeleton);
  group.position.set(x, 0, z);
  group.rotation.y = yaw;
  group.scale.setScalar(outfit.scale);
  scene.add(group);
  const an = new PedAnimator(RIG, bones, {
    gait: outfit.gait, height: outfit.height, scale: outfit.scale, probe,
  });
  an.phase = rng.float();
  an.idlePhase = rng.float();
  // a spread of the behaviour layers, so a still frame shows what a crowd does
  const roll = rng.float();
  if (view === 'panic') {
    if (roll < 0.34) an.setAct('flee', 1);
    else if (roll < 0.52) an.setAct('gawk', 1);
    else if (roll < 0.66) an.setAct('film', 1);
    else if (roll < 0.80) an.setAct('hurt', 0.8);
  } else if (roll < 0.18) an.setAct('phone', 1, rng.float() < 0.5 ? 1 : -1);
  else if (roll < 0.28) an.setAct('smoke', 1, -1);
  else if (roll < 0.42) an.setAct('talk', 1);
  else if (roll < 0.55) an.setAct('pockets', 1);
  else if (roll < 0.62) an.setAct('folded', 1);
  else if (roll < 0.72) an.setAct('carry', 0.8, 1);
  for (const k in an.act) an.act[k] = an.actTarget[k];
  actors.push({ group, mesh, an, outfit, speed, v });
  return actors[actors.length - 1];
}

const VIEWS = {
  close: { pos: [1.05, 1.10, 2.45], look: [0, 0.92, 0], fov: 46 },
  face: { pos: [0.30, 1.62, 0.72], look: [0, 1.52, 0.02], fov: 24 },
  hands: { pos: [0.52, 0.94, 0.62], look: [-0.16, 0.88, 0.02], fov: 26 },
  back: { pos: [0.5, 1.10, -2.6], look: [0, 0.92, 0], fov: 46 },
  line: { pos: [0, 1.5, 13.5], look: [0, 1.0, 0], fov: 42 },
  group: { pos: [0.5, 1.65, 9.5], look: [0, 1.0, -1.5], fov: 45 },
  street: { pos: [0, 2.4, 40], look: [0, 1.2, -6], fov: 42 },
  gait: { pos: [0, 1.5, 9.0], look: [0, 1.0, 0], fov: 45 },
  panic: { pos: [0.5, 1.7, 10.5], look: [0, 1.0, -2.0], fov: 48 },
};

const shapeArg = q.get('shape');
const archArg = q.get('arch') ?? 'street';

if (view === 'line') {
  const ids = SHAPE_IDS;
  const cols = Math.ceil(ids.length / 2);
  ids.forEach((id, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    makePed(id, archArg, (col - (cols - 1) / 2) * 1.05, -row * 2.4, 0, 0);
  });
  VIEWS.line.pos = [0, 2.2, 11.5];
  VIEWS.line.look = [0, 1.0, -2.4];
} else if (view === 'group' || view === 'panic') {
  for (let i = 0; i < 12; i++) {
    const id = shapeArg ?? SHAPE_IDS[rng.u32() % SHAPE_IDS.length];
    const a = archArg === 'mixed' ? ARCHETYPE_IDS[rng.u32() % ARCHETYPE_IDS.length] : archArg;
    makePed(id, a, rng.range(-3.4, 3.4), rng.range(-5.5, 1.5), rng.range(-Math.PI, Math.PI), 1.4);
  }
} else if (view === 'street') {
  for (let i = 0; i < 44; i++) {
    const id = shapeArg ?? SHAPE_IDS[rng.u32() % SHAPE_IDS.length];
    const a = archArg === 'mixed' ? ARCHETYPE_IDS[rng.u32() % ARCHETYPE_IDS.length] : archArg;
    makePed(id, a, rng.range(-9, 9), rng.range(-30, 12), rng.range(-Math.PI, Math.PI), 1.4);
  }
} else if (view === 'gait') {
  const id = shapeArg ?? 'jacketM';
  for (let i = 0; i < 6; i++) makePed(id, archArg, (i - 2.5) * 1.1, 0, 0.35, 1.4);
} else {
  makePed(shapeArg ?? 'overcoatM', archArg, 0, 0, Number(q.get('yaw') ?? 0.28), Number(q.get('speed') ?? 0));
}

const V = VIEWS[view] ?? VIEWS.close;
camera.position.fromArray(V.pos);
camera.lookAt(new THREE.Vector3().fromArray(V.look));
camera.fov = V.fov;
camera.updateProjectionMatrix();

let tris = 0;
let verts = 0;
for (const v of cache.values()) { tris += v.stats.triangles; verts += v.stats.vertices; }
console.info(
  `[peds/preview] ${cache.size} silhouettes · ${(verts / 1000).toFixed(1)}k verts · ` +
    `${(tris / 1000).toFixed(1)}k tris · ${actors.length} actors`
);
window.__PEDSTATS__ = { shapes: cache.size, verts, tris, actors: actors.length };

const DT = 1 / 60;
let frameIndex = 0;
const lookTarget = new THREE.Vector3(0.6, 1.55, 8);

function loop() {
  requestAnimationFrame(loop);
  frameIndex++;
  const t = phase + frameIndex * DT;
  for (const a of actors) {
    const sp = a.speed;
    a.an.setState({
      clip: clipName,
      speed: sp,
      lookTarget: view === 'face' || view === 'close' ? lookTarget : null,
      lookWeight: 0.8,
    });
    a.an.update(DT, t);
    a.group.updateMatrixWorld(true);
  }
  renderer.render(scene, camera);
  if (frameIndex === 6) window.__READY__ = true;
}
requestAnimationFrame(loop);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
