import { Engine } from '../core/engine.js';
import { createConfig } from '../core/config.js';
import { RenderSystem } from '../render/index.js';
import { MaterialSystem } from '../materials/index.js';
import { SkySystem } from '../sky/index.js';
import { PhysicsSystem } from '../physics/index.js';
import { WorldSystem } from './index.js';

/**
 * DEV ONLY — standalone Steel City rig.
 *
 * Boots the REAL engine with only `render`, `materials`, `sky`, `physics` and
 * `world`, so the terrain, roads, bridges and water can be framed and
 * screenshotted through the actual HDR pipeline while nine other subsystems are
 * being rewritten in parallel. Nothing here ships; `src/main.js` is the game.
 *
 * Drive it with the same inline-JSON shot syntax as the real harness:
 *   /src/world/preview.html?shot={"pos":[...],"look":[...],"fov":60,"time":17}
 */

const params = new URLSearchParams(location.search);
const config = createConfig({ quality: params.get('q') ?? 'ultra', deterministic: true });
const canvas = document.getElementById('game');
const engine = new Engine({ canvas, config });

engine
  .add(RenderSystem)
  .add(MaterialSystem)
  .add(SkySystem)
  .add(PhysicsSystem)
  .add(WorldSystem);

await engine.init();
engine.input.frozen = true;

const shot = JSON.parse(params.get('shot') ?? '{"pos":[-232,6,150],"look":[-260,14,-40],"fov":62,"time":16.5}');
// `onRoad:[x,z,eye,ahead]` snaps the camera onto the nearest lane and looks
// down it — the framing that actually shows a road surface.
if (Array.isArray(shot.onRoad)) {
  const w = engine.ctx.peek('world');
  const ne = w.roads.nearestEdge(shot.onRoad[0], shot.onRoad[1], 400);
  const eye = shot.onRoad[2] ?? 1.7;
  const ahead = shot.onRoad[3] ?? 60;
  const t0 = 0.15;
  const p0 = w.roads.laneCenter(ne.edge, ne.lane, t0).clone();
  const yaw = w.roads.laneYaw(ne.edge, ne.lane);
  shot.pos = [p0.x, p0.y + eye, p0.z];
  shot.look = [p0.x + Math.sin(yaw) * ahead, p0.y + eye * 0.55, p0.z + Math.cos(yaw) * ahead];
}
const cam = engine.camera;
cam.position.fromArray(shot.pos);
cam.lookAt(shot.look[0], shot.look[1], shot.look[2]);
if (shot.fov) {
  cam.fov = shot.fov;
  cam.updateProjectionMatrix();
}
engine.ctx.peek('sky')?.setTimeOfDay?.(shot.time ?? 16.5);

// Deterministic shutter: the page never free-runs, the driver pumps frames.
let fake = 0;
const orig = engine.step.bind(engine);
engine.step = () => {
  fake += 1000 / 60;
  engine._last = fake - 1000 / 60;
  return orig(fake);
};

window.__PUMP__ = (n = 1) =>
  new Promise((resolve) => {
    let i = 0;
    const tick = () => {
      engine.step();
      // Hold the shot camera: nothing else owns it here, but `render` may have
      // resized the projection.
      cam.position.fromArray(shot.pos);
      cam.lookAt(shot.look[0], shot.look[1], shot.look[2]);
      if (++i >= n) resolve(engine.time.frame);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

window.__WORLD__ = engine.ctx.peek('world');
window.__DIAG__ = () => {
  const w = engine.ctx.peek('world');
  const m = w.water.mesh;
  m.geometry.computeBoundingBox();
  const bb = m.geometry.boundingBox;
  const out = {
    water: {
      visible: m.visible,
      inScene: !!m.parent,
      tris: m.geometry.index.count / 3,
      bbox: [bb.min.toArray().map(Math.round), bb.max.toArray().map(Math.round)],
      matVisible: m.material.visible,
      program: !!m.material.program,
    },
    heights: {},
  };
  for (const [n, x, z] of [['confluence', -600, 40], ['ohio', -900, -60], ['mon', -232, 239], ['alleg', -232, -160]]) {
    out.heights[n] = { h: +w.heightAt(x, z).toFixed(2), water: w.isWater(x, z), surf: w.surfaceAt(x, z) };
  }
  return out;
};
window.__ENGINE__ = engine;
window.__SETTLED__ = () => engine.ctx.peek('world')?.streamingIdle?.() ?? true;
window.__INFO__ = () => {
  const r = engine.ctx.peek('render');
  const w = engine.ctx.peek('world');
  return {
    frame: engine.time.frame,
    calls: r?.renderer?.info.render.calls ?? 0,
    tris: r?.renderer?.info.render.triangles ?? 0,
    programs: r?.renderer?.info.programs?.length ?? 0,
    world: w?.stats ?? null,
  };
};

await window.__PUMP__(3);
window.__READY__ = true;
