#!/usr/bin/env node
/**
 * Why is `clearTraffic` not clearing the frame?
 *
 * The `detail` and `hero` shots declare `clearTraffic` and still photograph a
 * pile-up. Reports what the pre-shutter hook actually sees.
 */
import { chromium } from 'playwright';
import { startServer } from './lib/server.mjs';

const { port, server } = await startServer({});
const b = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
const pump = (n) => p.evaluate((k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }), n);

try {
  await p.goto(`http://127.0.0.1:${port}/?capture=1&shot=hero`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  await p.evaluate(() => window.__APPLY_SHOT__?.('hero', { grabFrame: 60 }));
  await pump(400);

  console.log(JSON.stringify(await p.evaluate(() => {
    const e = window.__ENGINE__;
    const veh = e.ctx.peek('vehicles');
    const cam = e.camera.position;
    const near = [];
    for (const v of veh?.vehicles ?? []) {
      const d = Math.hypot(v.position.x - cam.x, v.position.z - cam.z);
      if (d < 40) near.push({
        type: v.spec?.id, d: +d.toFixed(1), destroyed: !!v.destroyed,
        staged: !!v._staged, health: Math.round(v.health ?? -1),
      });
    }
    near.sort((a, b) => a.d - b.d);
    return {
      hasPreshutter: typeof window.__PRESHUTTER__ === 'function',
      totalVehicles: veh?.vehicles?.length ?? null,
      within40m: near.length,
      nearest: near.slice(0, 8),
      preshutterCleared: window.__PRESHUTTER__ ? window.__PRESHUTTER__() : 'no hook',
      afterCount: veh?.vehicles?.length ?? null,
    };
  }), null, 2));
  if (errs.length) console.log('errors:', [...new Set(errs)].slice(0, 4));
} catch (e) {
  console.error('clearprobe failed:', e.message);
} finally {
  await b.close();
  server?.kill();
}
