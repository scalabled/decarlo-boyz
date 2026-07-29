import * as THREE from 'three';
import { MaterialSystem } from '../materials/index.js';
import { Rng } from '../core/rng.js';
import { WeaponMaterials } from './materials.js';
import { buildModel, MODEL_IDS } from './models/index.js';
import { instantiate } from './models/build.js';
import { WEAPON_ORDER, ALL_WEAPONS } from './lib.js';

/**
 * Standalone visual harness for the improvised arsenal.
 *
 * The city is dark, cluttered and streamed, which makes it a terrible place to
 * judge a 400 mm object. This page boots ONLY
 * `materials` plus one weapon against a studio rig, so silhouette, proportion,
 * chamfers, wear masks and material separation can be reviewed honestly and in
 * ten seconds rather than ninety.
 *
 *   /src/weapons/preview.html?w=pipe&view=hero
 *   /src/weapons/preview.html?view=contact          all sixteen on a grid
 *
 * views: hero | side | top | front | detail | contact
 * Dev tool: nothing in the game imports it.
 */
const params = new URLSearchParams(location.search);
const WEAPON = params.get('w') ?? 'pipe';
const VIEW = params.get('view') ?? 'hero';
const GRAB = Math.max(0, Math.round(Number(params.get('grab')) || 0));

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.004, 60);

/* ----------------------------------------------------------------- studio -- */
/**
 * A deliberately COOL sky over a WARM bounce. The whole improvised palette is
 * built on hue separation (rust orange, zinc green-grey, safety yellow, copper),
 * and a neutral studio would flatter it dishonestly — under a neutral dome a
 * flat grey weapon and a hue-separated one look about the same. This rig has a
 * blue key from above and an amber bounce from below, which is roughly a Steel
 * City afternoon and is what the game will actually light these with.
 */
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: { uSun: { value: new THREE.Vector3(-0.45, 0.55, 0.7).normalize() } },
  vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = (projectionMatrix * modelViewMatrix * vec4(position,1.0)).xyww; }',
  fragmentShader: [
    'varying vec3 vD; uniform vec3 uSun;',
    'void main(){',
    '  vec3 d = normalize(vD);',
    '  vec3 c = mix(vec3(0.34,0.40,0.50), vec3(0.11,0.17,0.28), smoothstep(0.0,0.75,d.y));',
    '  c = mix(vec3(0.14,0.10,0.07), c, smoothstep(-0.30,0.02,d.y));',
    '  float s = max(dot(d, normalize(uSun)), 0.0);',
    '  c += vec3(1.0,0.92,0.80) * pow(s, 48.0) * 2.2;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}',
  ].join('\n'),
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(30, 32, 16), skyMat);
sky.frustumCulled = false;
scene.add(sky);

const key = new THREE.DirectionalLight(0xfff0dc, 3.6);
key.position.set(-2.4, 3.2, 2.6);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 0.05;
key.shadow.camera.far = 8;
key.shadow.camera.left = -0.9;
key.shadow.camera.right = 0.9;
key.shadow.camera.top = 0.9;
key.shadow.camera.bottom = -0.9;
key.shadow.bias = -0.0006;
scene.add(key, key.target);
const fill = new THREE.DirectionalLight(0x8fb0dd, 1.1);
fill.position.set(3.4, 0.8, -1.4);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffc890, 1.6);
rim.position.set(0.8, -1.2, -3.2);
scene.add(rim);
scene.add(new THREE.HemisphereLight(0x8fb2ff, 0x30251c, 0.85));

/* -------------------------------------------------------------- materials -- */
const materials = new MaterialSystem({ renderer });
await materials.init({ config: { quality: 'ultra', q: { anisotropy: 16 } } });

const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const env = pmrem.fromScene(scene, 0, 0.05, 30);
scene.environment = env.texture;
scene.environmentIntensity = 1.0;

const events = {
  handlers: new Map(),
  on(t, f) { (this.handlers.get(t) ?? this.handlers.set(t, new Set()).get(t)).add(f); return () => this.handlers.get(t)?.delete(f); },
  emit(t, p) { for (const f of this.handlers.get(t) ?? []) f(p); },
};
const ctx = {
  scene, camera, viewScene: scene, viewCamera: camera, canvas,
  config: { quality: 'ultra', q: { anisotropy: 16 } },
  events,
  time: { elapsed: 0, dt: 1 / 60, frame: 0 },
  rng: new Rng(0xbeef1234),
  get: (id) => (id === 'materials' ? materials : null),
  peek: (id) => (id === 'materials' ? materials : null),
  has: (id) => id === 'materials',
};
const mats = new WeaponMaterials(ctx);
const bake = materials.bakeMasks.bind(materials);

/* ------------------------------------------------------------------ build -- */
/** A shop floor so the weapon has something to cast onto and bounce off. */
{
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 6),
    materials.get('concrete_floor', { scale: 0.5 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.30;
  floor.receiveShadow = true;
  scene.add(floor);
}

const stats = { built: [], tris: 0, calls: 0 };
const built = [];

function make(id, seed) {
  const rng = new Rng(seed >>> 0);
  const model = buildModel(id, rng);
  if (!model) return null;
  const inst = instantiate(model, mats, { rng, bakeMasks: bake });
  inst.model = model;
  inst.id = id;
  stats.built.push({ id, tris: inst.tris });
  stats.tris += inst.tris;
  built.push(inst);
  return inst;
}

let target = null;
if (VIEW === 'contact') {
  /* Sixteen weapons on a 4x4 grid, each scaled into a 0.42 m cell so the whole
   * arsenal can be compared for silhouette variety in one frame. This is the
   * shot to look at when asking "can a critic tell these apart". */
  /**
   * Cells are sized in SCREEN space, so the fit has to be measured after the
   * -90 deg yaw that turns the bore (model -Z) into screen X. Measuring the
   * un-rotated box and spacing rows by a guess is what put a 0.30 m nail gun
   * through the flare gun below it in the first pass.
   */
  const cellW = 0.52;
  const cellH = 0.30;
  WEAPON_ORDER.forEach((id, i) => {
    const inst = make(id, 0x1000 + i * 977);
    if (!inst) return;
    const holder = new THREE.Object3D();
    holder.rotation.y = -Math.PI / 2;
    holder.add(inst.group);
    holder.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(inst.group);
    const sz = bb.getSize(new THREE.Vector3());
    const c = bb.getCenter(new THREE.Vector3());
    /* The box is measured AFTER the -90 deg yaw (the holder's world matrix is
     * already up to date), so model +Z now runs along world -X: the long axis
     * of a weapon is `sz.x` here, not `sz.z`. Getting that wrong scaled every
     * weapon by its own thickness and stacked the whole arsenal in a heap. */
    const wide = Math.max(sz.x, 1e-3);
    const tall = Math.max(sz.y, 1e-3);
    const s = Math.min((cellW * 0.9) / wide, (cellH * 0.84) / tall);
    inst.group.position.set(-c.x, -c.y, -c.z);
    holder.scale.setScalar(s);
    holder.position.set((i % 4 - 1.5) * cellW, (1.5 - Math.floor(i / 4)) * cellH, 0);
    scene.add(holder);
  });
  camera.position.set(0, 0.0, 2.05);
  camera.lookAt(0, 0, 0);
  camera.fov = 46;
  camera.updateProjectionMatrix();
  key.target.position.set(0, 0, 0);
  key.target.updateMatrixWorld();
  /* The shop floor sits at -0.30 for the single-weapon views; on the grid that
   * is chest-high on the bottom row and it ate the explosives entirely. */
  const floor = scene.children.find((o) => o.isMesh && o.geometry?.type === 'PlaneGeometry');
  if (floor) floor.position.y = -0.72;
  key.shadow.camera.left = -1.4;
  key.shadow.camera.right = 1.4;
  key.shadow.camera.top = 1.4;
  key.shadow.camera.bottom = -1.4;
  key.shadow.camera.far = 12;
  key.position.set(-1.6, 2.4, 2.2);
  key.shadow.camera.updateProjectionMatrix();
} else {
  target = make(WEAPON, 0x51ee7 + MODEL_IDS.indexOf(WEAPON) * 131);
  if (target) {
    scene.add(target.group);
    target.group.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(target.group);
    const c = bb.getCenter(new THREE.Vector3());
    const sz = bb.getSize(new THREE.Vector3());
    const span = Math.max(sz.x, sz.y, sz.z);

    const frame = (dir, radius, fov = 34, at = c) => {
      camera.fov = fov;
      const halfV = (fov * 0.5 * Math.PI) / 180;
      const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
      const d = radius / Math.tan(Math.min(halfV * 2.4, halfH));
      camera.position.copy(at).addScaledVector(new THREE.Vector3().fromArray(dir).normalize(), d);
      camera.lookAt(at);
      camera.updateProjectionMatrix();
    };
    switch (VIEW) {
      case 'side': frame([1, 0.05, 0.02], span * 0.56); break;
      case 'top': frame([0.02, 1, 0.06], span * 0.56); break;
      case 'front': frame([0.05, 0.12, -1], span * 0.42, 30); break;
      case 'detail': {
        const m = new THREE.Vector3().fromArray(target.model.nodes.muzzle ?? [0, 0, 0]);
        frame([0.85, 0.42, 0.75], span * 0.16, 32, m);
        break;
      }
      case 'grip': frame([0.9, 0.25, 0.6], 0.11, 34, new THREE.Vector3(0, -0.01, 0.0)); break;
      default: frame([0.72, 0.34, 0.86], span * 0.56, 34);
    }
    // Move the floor under the weapon.
    scene.children.find((o) => o.isMesh && o.geometry?.type === 'PlaneGeometry')
      ?.position.set(c.x, bb.min.y - 0.06, c.z);
    key.target.position.copy(c);
    key.target.updateMatrixWorld();
    key.position.copy(c).add(new THREE.Vector3(-0.9, 1.4, 0.8));
    key.shadow.camera.left = -span * 0.8;
    key.shadow.camera.right = span * 0.8;
    key.shadow.camera.top = span * 0.8;
    key.shadow.camera.bottom = -span * 0.8;
    key.shadow.camera.updateProjectionMatrix();
  }
}

/* ------------------------------------------------------------------ loop --- */
let frames = 0;
function tick() {
  ctx.time.elapsed += 1 / 60;
  ctx.time.frame++;
  renderer.render(scene, camera);
  if (++frames === Math.max(4, GRAB)) {
    stats.calls = renderer.info.render.calls;
    window.__INFO__ = {
      weapon: WEAPON, view: VIEW,
      tris: stats.tris,
      perWeapon: stats.built,
      calls: stats.calls,
      drawnTris: renderer.info.render.triangles,
      lib: target ? ALL_WEAPONS[target.id]?.lib : null,
    };
    window.__READY__ = true;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
