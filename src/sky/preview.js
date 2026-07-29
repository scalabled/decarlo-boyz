import * as THREE from 'three';
import { Engine } from '../core/engine.js';
import { createConfig } from '../core/config.js';
import { RenderSystem } from '../render/index.js';
import { SkySystem } from './index.js';

/**
 * `materials` is loaded DYNAMICALLY and falls back to a stub.
 *
 * Not defensiveness for its own sake: a
 * half-saved file in src/materials/glsl takes this rig down as surely as it
 * takes the game down, and the whole point of the rig is that it keeps working
 * when the game does not. The stub satisfies the registry (SkySystem declares
 * `materials` as a dep) and hands back plain standard materials, which is
 * enough: what this rig has to reproduce faithfully is the RENDER pipeline —
 * the tone curve, the exposure, the cascades — not the texture forge.
 */
class StubMaterials {
  static id = 'materials';
  static deps = ['render'];
  async init() {}
  get(name, opts) {
    const key = `${name}`;
    this._cache ??= new Map();
    let m = this._cache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color: name === 'asphalt' ? 0x3d3b37 : 0x8c8678,
        roughness: name === 'asphalt' ? 0.88 : 0.82,
        metalness: 0,
      });
      this._cache.set(key, m);
    }
    return m;
  }
  names() {
    return ['asphalt', 'concrete'];
  }
  dispose() {
    this._cache?.forEach((m) => m.dispose());
  }
}

let MaterialSystem = StubMaterials;
try {
  const mod = await import('../materials/index.js');
  if (mod?.MaterialSystem) MaterialSystem = mod.MaterialSystem;
} catch (e) {
  console.warn('[sky-preview] materials unavailable, using stub:', e.message);
}

/**
 * DEV ONLY — standalone sky rig. Nothing here ships; it is not imported by
 * src/main.js and is served straight off the vite dev server at
 * /src/sky/preview.html.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two reasons, and the second is the important one.
 *
 *  1  The game's level is a street canyon with a rifle in the lower third. That
 *     is the right frame for judging materials and weapons and the wrong one
 *     for judging a sky: two thirds of the dome is behind a building and the
 *     part you can see is a slot. This rig is a bare plaza with a horizon, a
 *     terrace of blocks to catch shadows and a cliff to stand on, so the whole
 *     hemisphere and its gradient are visible in one frame.
 *
 *  2  ISOLATION. A syntax error in any other
 *     subsystem takes the whole page down, and with it every screenshot this
 *     subsystem needs to iterate against. This rig boots render + materials +
 *     sky and nothing else, so the sky can be verified while the rest of the
 *     tree is red.
 *
 * It uses the REAL RenderSystem, deliberately. A stand-in renderer would grade
 * differently — no AgX, no TAA, no cascade fit, no autoexposure — and a sky
 * tuned against a different tone curve is a sky tuned against nothing.
 *
 * Same harness API as the game (`__READY__`, `__APPLY_SHOT__`, `__PUMP__`) so
 * tools/capture.mjs and the sweep scripts drive it unchanged, plus `time` and
 * `weather` fields on an inline shot.
 */

const canvas = document.getElementById('sky');
const params = new URLSearchParams(location.search);

const config = createConfig({
  quality: params.get('q') ?? 'ultra',
  deterministic: true,
});
if (params.has('csteps')) config.cloudSteps = Number(params.get('csteps'));

const engine = new Engine({ canvas, config });
engine.add(RenderSystem).add(MaterialSystem).add(SkySystem);

/**
 * A stand-in for `world`: enough ground and enough vertical relief to read the
 * light, and a valley so the river-fog map has something to pool in.
 *
 * Registered as a real subsystem so it initialises in dependency order and gets
 * the same ctx everything else does — including `heightAt` / `isWater`, which
 * is the contract ValleyFog queries.
 */
class PreviewWorld {
  static id = 'world';
  static deps = ['render', 'materials'];

  /**
   * A river trench along z = 0 with a Mt. Washington analogue on the west bank.
   *
   * The shape is not decoration: it is what the river-fog map has to find. The
   * trench gives the valley floor the fog pools into, and the 150 m ridge gives
   * a clifftop that has to end up ABOVE the layer looking down on a city that
   * has vanished — which is the DESIGN.md dawn shot and the only way to check
   * the fog has a top at all.
   */
  heightAt(x, z) {
    const river = Math.exp(-(z * z) / (2 * 90 * 90));
    const ridge = 150 * Math.exp(-((x + 620) * (x + 620)) / (2 * 250 * 250));
    const roll = 9 * Math.sin(x * 0.0035) * Math.cos(z * 0.0029) + 5 * Math.sin(z * 0.006);
    return ridge * (1 - 0.75 * river) + roll * (1 - river) - 30 * river;
  }
  groundHeight(x, z) {
    return this.heightAt(x, z);
  }
  isWater(x, z) {
    return this.heightAt(x, z) < -22;
  }
  get CITY_SIZE() {
    return 3000;
  }

  async init(ctx) {
    this.ctx = ctx;
    const materials = ctx.get('materials');
    // The material library's names move over time. This rig must never be the
    // thing that breaks, so an unknown name falls back.
    const mats = {
      get(name, opts, fallback) {
        try {
          return materials.get(name, opts) ?? fallback;
        } catch {
          return fallback;
        }
      },
    };
    this.root = new THREE.Group();
    this.root.name = 'preview-world';
    ctx.scene.add(this.root);

    // ---- terrain ----------------------------------------------------------
    const N = 220;
    const SPAN = 2600;
    const geo = new THREE.PlaneGeometry(SPAN, SPAN, N, N);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.heightAt(pos.getX(i), pos.getZ(i)));
    }
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(
      geo,
      mats.get(
        'asphalt',
        { scale: 0.05 },
        new THREE.MeshStandardMaterial({ color: 0x4a4740, roughness: 0.95 })
      )
    );
    ground.name = 'preview-ground';
    // The render patch gates the cascade lookup on the three built-in
    // `receiveShadow`, so a mesh that does not opt in gets no sun shadow at all.
    ground.receiveShadow = true;
    ground.castShadow = true;
    this.root.add(ground);

    // ---- a terrace of blocks, to catch shadows and give the frame scale ----
    const rng = ctx.rng.fork();
    const box = new THREE.BoxGeometry(1, 1, 1);
    const mat = mats.get(
      'concrete',
      undefined,
      new THREE.MeshStandardMaterial({ color: 0x8a8477, roughness: 0.8 })
    );
    const inst = new THREE.InstancedMesh(box, mat, 160);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    // A block of "city" on the east bank of the trench: something for the sun to
    // throw shadows across, for the cloud shadows to crawl over, and for the
    // fog to swallow from the bottom up.
    for (let i = 0; i < 160; i++) {
      const a = rng.float() * Math.PI * 2;
      const r = 40 + 380 * Math.sqrt(rng.float());
      const h = rng.range(8, 78);
      p.set(120 + Math.cos(a) * r, 0, 190 + Math.sin(a) * r * 0.75);
      p.y = this.heightAt(p.x, p.z) + h * 0.5;
      s.set(rng.range(10, 30), h, rng.range(10, 30));
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.float() * Math.PI);
      inst.setMatrixAt(i, m.compose(p, q, s));
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.name = 'preview-blocks';
    inst.receiveShadow = true;
    inst.castShadow = true;
    this.root.add(inst);
    this._geo = [geo, box];
  }

  dispose() {
    for (const g of this._geo) g.dispose();
  }
}

engine.add(PreviewWorld);

await engine.init();

// Deterministic shutter, exactly as src/dev/shots.js does it for the game.
let fake = 0;
engine.step = ((orig) =>
  function () {
    this._last = fake;
    fake += 1000 / 60;
    return orig.call(this, fake);
  })(engine.step);

const sky = engine.ctx.get('sky');

window.__SHOTS__ = {};
window.__APPLY_SHOT__ = (name) => {
  let shot;
  if (typeof name === 'string' && name.trim().startsWith('{')) {
    try {
      shot = JSON.parse(name);
    } catch (e) {
      return { error: `inline shot is not valid JSON: ${e.message}` };
    }
  } else {
    return { error: 'preview only accepts inline JSON shots' };
  }
  const cam = engine.camera;
  cam.position.fromArray(shot.pos);
  cam.lookAt(new THREE.Vector3().fromArray(shot.look));
  if (shot.fov) {
    cam.fov = shot.fov;
    cam.updateProjectionMatrix();
  }
  // Weather first: setTimeOfDay does the full rebake, so ordering it second
  // means one snap instead of two.
  if (shot.weather) sky.snapWeather(shot.weather);
  if (shot.patch) sky.setWeather(shot.patch);
  if (shot.wetness !== undefined) sky.model.wetness = shot.wetness;
  if (shot.time !== undefined) sky.setTimeOfDay(shot.time);
  return { applied: 'inline', pos: shot.pos, time: shot.time, weather: sky.weatherState };
};

engine.start();
window.__READY__ = true;
window.__SKY__ = sky;
