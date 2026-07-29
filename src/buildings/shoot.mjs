#!/usr/bin/env node
/**
 * Screenshot the standalone buildings preview (dev tool, not shipped).
 *
 *   node src/buildings/shoot.mjs --view=street --out=/tmp/b-street.png
 *   node src/buildings/shoot.mjs --view=skyline --hour=19 --out=/tmp/b-sky.png
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const PORT = Number(args.port ?? 5211);
const W = Number(args.w ?? 1600);
const H = Number(args.h ?? 900);
const VIEW = args.view ?? 'street';
const OUT = resolve(args.out ?? `/tmp/b-${VIEW}.png`);
const ROOT = resolve(import.meta.dirname, '../..');

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let server = null;
if (!(await portOpen(PORT))) {
  server = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, OW_NO_HMR: '1' },
  });
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await portOpen(PORT);
  }
  if (!up) {
    server.kill();
    throw new Error('vite failed to start');
  }
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--disable-frame-rate-limit',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

let failed = null;
try {
  const extra = (args.hour ? `&hour=${args.hour}` : '') + (args.lod ? `&lod=${args.lod}` : '');
  await page.goto(`http://127.0.0.1:${PORT}/src/buildings/preview.html?view=${VIEW}${extra}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });
  await page.evaluate(
    () =>
      new Promise((d) => {
        let i = 0;
        const t = () => (++i >= 8 ? d() : requestAnimationFrame(t));
        requestAnimationFrame(t);
      })
  );
  mkdirSync(dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT, type: 'png' });
  const info = await page.evaluate('window.__INFO__ ?? null');
  const pick = args.pick ? await page.evaluate('window.__PICK__ ?? null') : null;
  console.log(JSON.stringify({ ok: true, out: OUT, view: VIEW, info, pick }, null, 2));
} catch (e) {
  failed = e;
}
const errs = logs.filter((l) => /error|Error|THREE\./.test(l));
if (failed || args.verbose) console.error((errs.length ? errs : logs).slice(0, 40).join('\n'));
await browser.close();
if (server) server.kill();
if (failed) {
  console.error(JSON.stringify({ ok: false, error: failed.message }));
  process.exit(1);
}
