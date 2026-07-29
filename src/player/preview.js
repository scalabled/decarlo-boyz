/**
 * Standalone studio for the player character and animator.
 *
 * The game scene belongs to fifteen other agents and is frequently mid-edit;
 * this page boots ONLY the character rig + the animator against a neutral
 * studio, so silhouette, proportion, garment separation, face readability and
 * every locomotion pose can be judged honestly and in about two seconds.
 *
 *   /src/player/preview.html?boy=carson&pose=jog&view=hero
 *
 * views  hero | front | back | side | face | feet | tps | ots | grid
 * poses  idle | walk | jog | sprint | stop | turn | crouch | aim | jump |
 *        fall | drive | stairs
 *
 * `pose=stairs` walks him up a synthetic staircase through the same foot-IK
 * path the game uses, against a stub physics that raycasts an analytic step
 * field — that is the only way to see foot planting on a slope without the
 * whole engine.
 *
 * Dev tool. Nothing in the game imports it.
 */
import * as THREE from 'three';
import { CharacterRig } from './character/index.js';
import { Animator } from './anim/animator.js';
import { BROTHERS } from './brothers.js';

const params = new URLSearchParams(location.search);
const BOY = params.get('boy') ?? 'carson';
const POSE = params.get('pose') ?? 'idle';
const VIEW = params.get('view') ?? 'hero';
const PHASE = Number(params.get('phase') ?? 0.18); // seconds of animation to run
const GRID = params.get('view') === 'grid';

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
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.02, 120);

/* ------------------------------------------------------------------ sky -- */
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(60, 32, 24),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uSun: { value: new THREE.Vector3(-0.4, 0.55, 0.73).normalize() } },
    vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = (projectionMatrix * modelViewMatrix * vec4(position,1.0)).xyww; }',
    fragmentShader: `
      varying vec3 vD; uniform vec3 uSun;
      void main(){
        vec3 d = normalize(vD);
        float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 top = vec3(0.10, 0.20, 0.42);
        vec3 hor = vec3(0.52, 0.53, 0.55);
        vec3 gnd = vec3(0.16, 0.14, 0.12);
        vec3 c = mix(hor, top, pow(max(d.y,0.0), 0.55));
        c = mix(gnd, c, smoothstep(-0.08, 0.06, d.y));
        float s = pow(max(dot(d, normalize(uSun)), 0.0), 220.0);
        c += vec3(2.2, 1.7, 1.2) * s;
        c += vec3(0.9, 0.72, 0.5) * pow(max(dot(d, normalize(uSun)), 0.0), 5.0) * 0.16;
        gl_FragColor = vec4(c, 1.0);
      }`,
  })
);
sky.frustumCulled = false;
scene.add(sky);

const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
scene.environment = pmrem.fromScene(scene, 0.04).texture;

/* -------------------------------------------------------------- lighting -- */
const key = new THREE.DirectionalLight(0xfff0dc, 3.1);
key.position.set(-4.2, 6.0, 5.4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 24;
key.shadow.camera.left = -3;
key.shadow.camera.right = 3;
key.shadow.camera.top = 4;
key.shadow.camera.bottom = -1;
key.shadow.bias = -0.0006;
key.shadow.normalBias = 0.018;
scene.add(key, key.target);

const rim = new THREE.DirectionalLight(0x9dc6ff, 1.5);
rim.position.set(4.4, 2.6, -5.2);
scene.add(rim);

const fill = new THREE.HemisphereLight(0x8fb2d8, 0x3a3128, 0.9);
scene.add(fill);

/* ---------------------------------------------------------------- ground -- */
const groundTex = (() => {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const img = g.createImageData(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const n = ((Math.sin(x * 0.7) * Math.cos(y * 0.9) + Math.sin(x * 3.1 + y * 2.3)) * 0.25 + 0.5);
      const v = 92 + n * 34;
      img.data[i] = v * 0.98; img.data[i + 1] = v; img.data[i + 2] = v * 0.94; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(24, 24);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.94, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

/* ------------------------------------------------- stub ctx + stub physics -- */
/**
 * An analytic "world" the animator can trace against: flat, or a staircase
 * with 0.17 m risers when `pose=stairs`. Enough to prove that feet plant on
 * treads and that the pelvis drops when a leg cannot reach.
 */
const STAIRS = POSE === 'stairs';
function heightAt(x, z) {
  if (!STAIRS) return 0;
  const t = -z; // walking down -Z
  if (t < 1.0) return 0;
  return Math.min(8, Math.floor((t - 1.0) / 0.30)) * 0.17;
}
if (STAIRS) {
  const g = new THREE.Group();
  for (let i = 0; i < 9; i++) {
    const step = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 0.17, 0.30),
      new THREE.MeshStandardMaterial({ color: 0x6a6560, roughness: 0.9 })
    );
    step.position.set(0, i * 0.17 + 0.085, -(1.0 + i * 0.30 + 0.15));
    step.castShadow = step.receiveShadow = true;
    g.add(step);
  }
  scene.add(g);
}

const hitRec = {
  hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
  distance: 0, surface: 'concrete',
};
const stubPhysics = {
  MASK: { WORLD: 0xffff, CHARACTER: 0xffff },
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    const y = heightAt(ox, oz);
    hitRec.hit = dy < 0 && oy - y <= maxDist && oy >= y - 0.01;
    hitRec.point.set(ox, y, oz);
    hitRec.normal.set(0, 1, 0);
    hitRec.distance = oy - y;
    return hitRec;
  },
  sphereCast() { hitRec.hit = false; return hitRec; },
};

const ctx = {
  peek: (id) => (id === 'physics' ? stubPhysics : null),
  get: (id) => ctx.peek(id),
  config: { q: { anisotropy: 8 }, fov: 80 },
  time: { elapsed: 0, dt: 1 / 60, alpha: 1, frame: 0 },
  events: { on: () => () => {}, emit: () => {} },
};

/* ------------------------------------------------------------- character -- */
const rig = new CharacterRig(ctx);
rig.setBrother(BROTHERS[BOY] ?? BROTHERS.carson, scene);
const animator = new Animator(ctx, rig);

function makeCharacter(id) {
  rig.setBrother(BROTHERS[id] ?? BROTHERS.carson, scene);
  animator.rig = rig;
  animator._cacheRest();
  animator.reset();
}

/* ------------------------------------------------------------------ pose -- */
const POSES = {
  idle: { speed: 0, aim: 0 },
  walk: { speed: 1.7, aim: 0 },
  jog: { speed: 3.35, aim: 0 },
  sprint: { speed: 6.6, aim: 0 },
  stop: { speed: 0.6, aim: 0, lean: -0.25 },
  turn: { speed: 0, aim: 0, turning: 1, yawRate: 2.4 },
  crouch: { speed: 1.3, aim: 0, crouch: true },
  aim: { speed: 0, aim: 1, aimYaw: 0.0 },
  aimwalk: { speed: 1.6, aim: 1, aimYaw: 0.7 },
  jump: { speed: 3.0, aim: 0, air: 1, vy: 4.5 },
  fall: { speed: 3.0, aim: 0, air: 1, vy: -7 },
  land: { speed: 1.2, aim: 0, land: 1.6 },
  drive: { speed: 0, aim: 0, driving: true, steer: -0.55, lateral: 0.5 },
  stairs: { speed: 1.5, aim: 0 },
  bind: { speed: 0, aim: 0 },
};
const P = POSES[POSE] ?? POSES.idle;

const req = {
  x: 0, y: 0, z: 0, faceYaw: 0, aimYaw: 0, aimPitch: 0,
  speed: 0, grounded: true, crouch: false, aim: 0, swim: false, driving: false,
  stumble: 0, turning: 0, strafe: 0, forwardSign: 1, verticalVel: 0,
  landImpulse: 0, steer: 0, lateral: 0, surface: 'concrete', groundDist: 0,
};

let simT = 0;
function stepSim(dt) {
  simT += dt;
  req.speed = P.speed;
  req.grounded = !P.air;
  req.crouch = !!P.crouch;
  req.aim = P.aim;
  req.driving = !!P.driving;
  req.turning = P.turning ?? 0;
  req.verticalVel = P.vy ?? 0;
  req.steer = P.steer ?? 0;
  req.lateral = P.lateral ?? 0;
  req.aimYaw = (P.aimYaw ?? 0);
  req.aimPitch = 0;
  req.landImpulse = P.land && simT < dt * 1.5 ? P.land : 0;

  if (POSE === 'bind') { rig.root.updateMatrixWorld(true); return; }
  if (P.yawRate) req.faceYaw += P.yawRate * dt;
  if (!P.driving) {
    req.z -= P.speed * dt;
    req.y = heightAt(req.x, req.z);
    if (P.air) req.y += 0.6;
  }
  animator.update(dt, req);
  ctx.time.elapsed += dt;
  ctx.time.frame++;
}

/* ----------------------------------------------------------------- views -- */
const scale = (BROTHERS[BOY] ?? BROTHERS.carson).build.scale;
function frameCamera() {
  const cx = req.x, cz = req.z, cy = req.y;
  const at = new THREE.Vector3(cx, cy + 0.95 * scale, cz);
  switch (VIEW) {
    case 'front':
      camera.fov = 30;
      camera.position.set(cx, cy + 0.98 * scale, cz - 4.2);
      break;
    case 'back':
      camera.fov = 30;
      camera.position.set(cx, cy + 0.98 * scale, cz + 4.2);
      break;
    case 'side':
      camera.fov = 30;
      camera.position.set(cx + 4.2, cy + 0.98 * scale, cz);
      break;
    case 'face':
      // A long lens at head height: a wide lens 0.9 m from a face invents
      // distortion that has nothing to do with the model.
      camera.fov = 15;
      at.set(cx, cy + 1.655 * scale, cz);
      camera.position.set(cx, cy + 1.655 * scale, cz - 1.9);
      break;
    case 'face34':
      camera.fov = 15;
      at.set(cx, cy + 1.655 * scale, cz);
      camera.position.set(cx - 1.15, cy + 1.68 * scale, cz - 1.5);
      break;
    case 'profile':
      camera.fov = 15;
      at.set(cx, cy + 1.655 * scale, cz);
      camera.position.set(cx - 1.9, cy + 1.655 * scale, cz);
      break;
    case 'feet':
      camera.fov = 32;
      at.set(cx, cy + 0.18 * scale, cz);
      camera.position.set(cx + 0.9, cy + 0.55 * scale, cz - 1.25);
      break;
    case 'tps':
      // The framing the in-game boom produces at rest.
      camera.fov = 62;
      at.set(cx, cy + 1.44 * scale, cz);
      camera.position.set(cx - 0.2, cy + 1.90 * scale, cz + 3.4);
      break;
    case 'ots':
      camera.fov = 47;
      at.set(cx, cy + 1.44 * scale, cz);
      camera.position.set(cx - 0.62, cy + 1.64 * scale, cz + 1.62);
      break;
    default: // hero
      camera.fov = 32;
      camera.position.set(cx + 2.35, cy + 1.28 * scale, cz - 2.9);
      break;
  }
  camera.updateProjectionMatrix();
  camera.lookAt(at);
  key.target.position.copy(at);
  key.target.updateMatrixWorld();
  key.position.set(at.x - 4.2, at.y + 5.0, at.z + 5.4);
}

/* ------------------------------------------------------------------ grid -- */
// `view=grid` lines up all three brothers for a build comparison.
const clones = [];
if (GRID) {
  const ids = Object.keys(BROTHERS);
  for (let i = 0; i < ids.length; i++) {
    const r = new CharacterRig(ctx);
    r.setBrother(BROTHERS[ids[i]], scene);
    const a = new Animator(ctx, r);
    r.root.position.x = (i - 1) * 1.15;
    clones.push({ rig: r, anim: a, x: (i - 1) * 1.15 });
  }
  rig.setVisible(false);
}

/* ------------------------------------------------------------------ loop -- */
const hud = document.getElementById('hud');
let warmed = 0;

function render() {
  const dt = 1 / 60;
  if (GRID) {
    for (const c of clones) {
      req.x = c.x;
      c.anim.update(dt, req);
    }
    req.x = 0;
    camera.fov = 34;
    camera.position.set(0.1, 1.35, -4.6);
    camera.updateProjectionMatrix();
    camera.lookAt(0, 0.92, 0);
  } else {
    stepSim(dt);
    frameCamera();
  }
  renderer.render(scene, camera);
  warmed++;
  hud.textContent =
    `${BOY} · ${POSE} · ${VIEW}\n` +
    `t ${simT.toFixed(2)}s  phase ${(animator.phase / (Math.PI * 2)).toFixed(3)}\n` +
    `pelvisDrop ${animator.pelvisDrop.toFixed(3)}  landDip ${animator.landDip.toFixed(3)}\n` +
    `tris ${renderer.info.render.triangles}  calls ${renderer.info.render.calls}`;
  if (warmed * dt < PHASE) requestAnimationFrame(render);
  else window.__PREVIEW_READY__ = true;
}
requestAnimationFrame(render);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

window.__PREVIEW__ = { rig, animator, scene, camera, renderer, makeCharacter, req };
