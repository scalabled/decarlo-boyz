#!/usr/bin/env node
/**
 * Cross-subsystem integration probe.
 *
 * Boots the game in GPU-backed headless Chromium, applies a shot, and dumps the
 * state that sits BETWEEN subsystems — sun, exposure, environment, fog, camera,
 * and a readback of the actual pixels. That seam is where nobody's unit of
 * ownership reaches, so when the frame goes black this is what tells you which
 * agent's boundary broke rather than which file threw.
 *
 *   node tools/diag.mjs --shot=hero
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const PORT = Number(args.port ?? 5173);
const SHOT = args.shot ?? 'hero';

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let server = null;
if (!(await portOpen(PORT))) {
  const root = resolve(import.meta.dirname, '..');
  server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root, stdio: 'ignore', env: { ...process.env, OW_NO_HMR: '1' },
  });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(PORT)) break;
  }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--force-color-profile=srgb', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack ?? '').split('\n').slice(0, 12).join('\n')}`));

try {
  await page.goto(`http://127.0.0.1:${PORT}/?capture=1&shot=${encodeURIComponent(SHOT)}`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 90000 });
  await page.evaluate((s) => window.__APPLY_SHOT__?.(s, { grabFrame: 60 }), SHOT);
  await page.evaluate(
    () => new Promise((d) => { let i = 0; const t = () => (++i >= 120 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); })
  );

  const dump = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const ctx = e.ctx;
    const out = {};
    const num = (v) => (typeof v === 'number' ? +v.toFixed(4) : v);

    const cam = e.camera;
    out.camera = {
      pos: cam.position.toArray().map((v) => +v.toFixed(2)),
      near: cam.near, far: cam.far, fov: cam.fov,
    };

    const sky = ctx.peek('sky');
    if (sky) {
      out.sky = {
        keys: Object.keys(sky).filter((k) => !k.startsWith('_')).slice(0, 40),
        hour: num(sky.hour ?? sky.timeOfDay ?? sky._hour),
        sunIntensity: num(sky.sunIntensity ?? sky.sun?.intensity),
        sunDir: sky.sunDirection?.toArray?.().map((v) => +v.toFixed(3)) ?? sky.sunDir?.toArray?.().map((v) => +v.toFixed(3)),
        weather: sky.weather ?? sky.state,
      };
    }

    const r = ctx.peek('render');
    if (r) {
      out.render = {
        exposure: num(r.exposure ?? r.renderer?.toneMappingExposure),
        ev100: num(r.ev100 ?? r._ev100),
        toneMapping: r.renderer?.toneMapping,
        outputColorSpace: r.renderer?.outputColorSpace,
        passes: (r.passes ?? []).map((p) => p?.constructor?.name ?? p?.name).slice(0, 30),
        screenSize: r.screenSize ? { width: r.screenSize.width, height: r.screenSize.height } : null,
      };
    }

    // Every directional/ambient light actually in the scene, and its intensity.
    const lights = [];
    e.scene.traverse((o) => {
      if (o.isLight) lights.push({
        type: o.type, intensity: num(o.intensity), visible: o.visible,
        color: o.color?.getHexString?.(),
      });
    });
    out.lights = lights.slice(0, 20);
    out.lightCount = lights.length;

    out.scene = {
      environment: !!e.scene.environment,
      envIntensity: num(e.scene.environmentIntensity),
      background: e.scene.background ? (e.scene.background.isTexture ? 'texture' : e.scene.background.getHexString?.()) : null,
      fog: e.scene.fog ? { type: e.scene.fog.type ?? 'Fog', near: num(e.scene.fog.near), far: num(e.scene.fog.far), density: num(e.scene.fog.density) } : null,
      children: e.scene.children.length,
    };

    // Count what is actually visible and lit.
    let meshes = 0, visible = 0;
    e.scene.traverse((o) => { if (o.isMesh || o.isInstancedMesh || o.isSkinnedMesh) { meshes++; if (o.visible) visible++; } });
    out.meshes = { total: meshes, visible };

    out.info = window.__RENDER_INFO__;

    // Read the centre of the canvas back. This is the ground truth: if the
    // renderer drew 12M triangles and this is still 0,0,0, the geometry is fine
    // and the light/exposure/composite path is not.
    const c = document.querySelector('canvas');
    const gl = c.getContext('webgl2');
    const px = new Uint8Array(4 * 9);
    if (gl) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(Math.floor(c.width / 2) - 1, Math.floor(c.height / 2) - 1, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    out.centrePixels = Array.from(px);
    out.canvas = { w: c.width, h: c.height };
    return out;
  });

  // Guard against cycles: `render` exposes render targets whose
  // `renderTarget.textures[0]` points back at the target, and a plain
  // JSON.stringify threw before printing anything at all.
  const seen = new WeakSet();
  console.log(
    JSON.stringify(
      dump,
      (k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        return v;
      },
      2
    )
  );
  const interesting = logs.filter((l) => /error|warn|fail|NaN|undefined|black|exposure/i.test(l));
  if (interesting.length) console.log('\n--- notable console ---\n' + interesting.slice(-25).join('\n'));
} catch (e) {
  console.error('DIAG FAILED:', e.message);
  console.error(logs.slice(-30).join('\n'));
} finally {
  await browser.close();
  if (server) server.kill();
}
