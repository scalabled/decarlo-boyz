#!/usr/bin/env node
/**
 * Driver for src/player/preview.html — the character studio.
 *
 *   node src/player/preview.mjs --pose=jog --view=hero --out=/tmp/p.png
 *   node src/player/preview.mjs --sheet --out=/tmp/sheet     # every pose
 *   node src/player/preview.mjs --view=grid --out=/tmp/boyz.png
 *
 * A development tool only; nothing in the game imports it.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const PORT = Number(args.port ?? 5233);
const W = Number(args.w ?? 1280);
const H = Number(args.h ?? 1280);
const OUT = resolve(args.out ?? '/tmp/player.png');

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function ensureServer() {
  if (await portOpen(PORT)) return null;
  const root = resolve(import.meta.dirname, '../..');
  const p = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, OW_NO_HMR: '1' },
  });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(PORT)) return p;
  }
  p.kill();
  throw new Error('vite failed to start');
}

const server = await ensureServer();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

const SHEET = [
  ['idle', 'hero'], ['idle', 'face'], ['walk', 'side'], ['jog', 'hero'],
  ['sprint', 'side'], ['crouch', 'hero'], ['aim', 'ots'], ['jump', 'side'],
  ['drive', 'hero'], ['stairs', 'feet'],
];

async function shoot(pose, view, out, extra = '') {
  const q = new URLSearchParams({
    boy: args.boy ?? 'carson',
    pose, view,
    phase: String(args.phase ?? 0.7),
  });
  const url = `http://127.0.0.1:${PORT}/src/player/preview.html?${q}${extra}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__PREVIEW_READY__ === true', null, { timeout: 60000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out, type: 'png' });
  return out;
}

let failed = null;
try {
  if (args.sheet) {
    const base = OUT.replace(/\.png$/, '');
    for (const [pose, view] of SHEET) {
      const f = `${base}-${pose}-${view}.png`;
      await shoot(pose, view, f);
      console.log(f);
    }
  } else {
    await shoot(args.pose ?? 'idle', args.view ?? 'hero', OUT);
    console.log(JSON.stringify({ ok: true, out: OUT }));
  }
} catch (e) {
  failed = e;
} finally {
  if (failed || args.verbose) console.error(logs.slice(-40).join('\n'));
  await browser.close();
  if (server) server.kill();
}
if (failed) {
  console.error(JSON.stringify({ ok: false, error: failed.message }));
  process.exit(1);
}
