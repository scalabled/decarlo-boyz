#!/usr/bin/env node
/**
 * Baked-texture memory against the PRODUCTION build (dev tool, not shipped).
 *
 * `materials.textureMemory` counts what the forge actually allocated for the
 * surfaces the level ASKED FOR, including mip chains, rather than what the
 * library could theoretically bake — the library holds 117 surfaces and baking
 * all of them would be 1.4 GiB, so the only meaningful number is the resident
 * one. `renderer.info.memory.textures` is reported alongside it as the
 * independent, engine-side count: if the two ever disagree in direction,
 * believe three's.
 *
 *   node src/materials/memcheck.mjs --q=low
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = 4700 + Math.floor(Math.random() * 200);
const qArg = process.argv.find((a) => a.startsWith('--q='));
const query = qArg ? `?q=${qArg.slice(4)}` : '';

const portOpen = (p) =>
  new Promise((res) => {
    const s = net.connect({ port: p, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

const server = spawn(
  resolve(ROOT, 'node_modules/.bin/vite'),
  ['preview', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: 'ignore' }
);
for (let i = 0; i < 160; i++) {
  await new Promise((r) => setTimeout(r, 250));
  if (await portOpen(PORT)) break;
}

const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
try {
  await p.goto(`http://127.0.0.1:${PORT}/${query}`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await p.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  // let the first ring of tiles settle so the level has asked for its palette
  await p.waitForFunction('window.__SETTLED__ === true', null, { timeout: 120000 }).catch(() => {});
  const out = await p.evaluate(() => {
    const e = window.__ENGINE__;
    const m = e.ctx.peek('materials');
    const r = e.ctx.peek('render')?.renderer;
    return {
      baked: m?.textureMemory ?? null,
      threeTextures: r?.info?.memory?.textures ?? null,
      threeGeometries: r?.info?.memory?.geometries ?? null,
      programs: r?.info?.programs?.length ?? null,
    };
  });
  console.log(JSON.stringify(out, null, 2));
} finally {
  await b.close();
  server.kill();
}
