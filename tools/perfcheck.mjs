#!/usr/bin/env node
/**
 * Playability check against the PRODUCTION build.
 *
 * Runs long enough for the adaptive governor to converge, then reports the
 * settled frame time, the tier it landed on, and where the player spawned —
 * which is the other thing that made the first playtest unplayable (the spawn
 * point was in the middle of the Monongahela).
 *
 *   npm run build && node tools/perfcheck.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 4173 + Math.floor(Math.random() * 300);

const portOpen = (p) =>
  new Promise((res) => {
    const s = net.connect({ port: p, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

const server = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['preview', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, stdio: 'ignore',
});
for (let i = 0; i < 160; i++) {
  await new Promise((r) => setTimeout(r, 250));
  if (await portOpen(PORT)) break;
}

const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio', '--disable-frame-rate-limit'],
});
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

try {
  const qArg = process.argv.find((a) => a.startsWith('--q='));
  const query = qArg ? `?q=${qArg.slice(4)}` : '';
  await p.goto(`http://127.0.0.1:${PORT}/${query}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction('window.__READY__===true', null, { timeout: 120000 });

  // Let the governor converge, then measure a clean window.
  const run = async (frames) =>
    p.evaluate(
      (n) =>
        new Promise((done) => {
          const t = [];
          let last = performance.now();
          let i = 0;
          const tick = () => {
            const now = performance.now();
            t.push(now - last);
            last = now;
            if (++i >= n) return done(t);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      frames
    );

  await run(240);              // converge
  const times = await run(240); // measure
  const sorted = times.slice().sort((a, b) => a - b);
  const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

  const state = await p.evaluate(() => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const w = e.ctx.peek('world');
    const pos = pl?.position;
    const inWater = pos && typeof w?.isWater === 'function' ? w.isWater(pos.x, pos.z) : null;
    return {
      tier: e.config.quality,
      renderScale: +(e.config.q.renderScale ?? 1).toFixed(3),
      govActions: (window.__GOV__?.actions ?? []).map((a) => `${a.kind}:${a.from}->${a.to}`),
      spawn: pos ? [+pos.x.toFixed(1), +pos.y.toFixed(1), +pos.z.toFixed(1)] : null,
      spawnInWater: inWater,
      surface: pos && w?.surfaceAt ? w.surfaceAt(pos.x, pos.z) : null,
      draws: e.ctx.peek('render')?.renderer?.info?.render?.calls ?? null,
    };
  });

  console.log(
    JSON.stringify(
      {
        fps: { p50: +(1000 / pct(0.5)).toFixed(1), p95: +(1000 / pct(0.95)).toFixed(1) },
        frameMs: { p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2), p99: +pct(0.99).toFixed(2) },
        ...state,
        errors: errs.slice(0, 6),
      },
      null,
      2
    )
  );
} catch (e) {
  console.error('perfcheck failed:', e.message);
  console.error(errs.slice(0, 10).join('\n'));
} finally {
  await b.close();
  server.kill();
}
