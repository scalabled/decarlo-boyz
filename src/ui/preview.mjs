#!/usr/bin/env node
/**
 * UI-only dev harness for `src/ui/` (mirrors tools/capture.mjs).
 *
 *   node src/ui/preview.mjs --state=combat --bg=night --out=/tmp/ui-combat.png
 *   node src/ui/preview.mjs --all --out=/tmp/hud            # every debug state
 *   node src/ui/preview.mjs --all --w=2560 --h=1080         # 21:9
 *   node src/ui/preview.mjs --engine --state=wanted5        # the real game page
 *   node src/ui/preview.mjs --fonts
 *
 * By default it shoots `src/ui/sandbox.html`, which mounts ONLY this subsystem
 * against a stub ctx over a painted backdrop. That keeps HUD iteration at ~2 s
 * a frame, and keeps it working however the other sixteen directories change.
 * `--engine` switches to the real boot for the final check, which is the one
 * that matters.
 *
 * `--bg` picks the backplate the sandbox paints: `day` (blown noon sky, white
 * concrete) or `night` (wet black street, sodium pools). Legibility has to
 * survive both.
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

const PORT = Number(args.port ?? 5212);
const W = Number(args.w ?? 1920);
const H = Number(args.h ?? 1080);
const BG = args.bg ?? 'day';
const STATE = args.state ?? 'combat';
const SETTLE = Number(args.settle ?? 24);
const ENGINE = !!args.engine;

const ALL = [
  'clean', 'combat', 'wanted3', 'wanted5', 'mission',
  'map', 'wheel', 'switch', 'radio', 'phone', 'passed', 'wasted', 'busted', 'menu',
];

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

const root = resolve(import.meta.dirname, '../..');
let server = null;
if (!(await portOpen(PORT))) {
  server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, OW_NO_HMR: '1' },
  });
  for (let i = 0; i < 160; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(PORT)) break;
  }
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal', '--ignore-gpu-blocklist', '--force-color-profile=srgb',
    '--force-device-scale-factor=1', '--hide-scrollbars', '--mute-audio',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const pump = (n) =>
  page.evaluate(
    (k) =>
      new Promise((done) => {
        let i = 0;
        const tick = () => (++i >= k ? done() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n
  );

try {
  if (args.fonts) {
    await page.goto(`http://127.0.0.1:${PORT}/src/ui/sandbox.html`, { waitUntil: 'domcontentloaded' });
    const report = await page.evaluate(() => {
      const probe = (family) => {
        const c = document.createElement('canvas').getContext('2d');
        c.font = `700 64px ${family}, monospace`;
        const a = c.measureText('HANDGUN 1830').width;
        c.font = '700 64px monospace';
        const b = c.measureText('HANDGUN 1830').width;
        return { family, width: Math.round(a), differs: Math.abs(a - b) > 1 };
      };
      return [
        'DIN Alternate', 'DIN Condensed', 'Avenir Next Condensed', 'Roboto Condensed',
        'Helvetica Neue', 'Oswald', 'Bahnschrift Condensed', 'Inter', 'system-ui',
        'PT Sans Narrow', 'Arial Narrow', 'Impact', 'Haettenschweiler',
      ].map(probe);
    });
    console.log(JSON.stringify(report, null, 2));
  } else if (ENGINE) {
    await page.goto(`http://127.0.0.1:${PORT}/?capture=1&shot=hud`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });
    const states = args.all ? ALL : [STATE];
    for (const s of states) {
      await page.evaluate((n) => window.__ENGINE__?.ctx.peek('ui')?.debugState(n), s);
      await pump(SETTLE);
      const out = resolve(args.out ? `${args.out}-${s}.png` : `/tmp/ui-${s}.png`);
      mkdirSync(dirname(out), { recursive: true });
      await page.screenshot({ path: out, type: 'png' });
      console.log(JSON.stringify({ ok: true, out, state: s, engine: true }));
    }
  } else {
    const states = args.all ? ALL : [STATE];
    for (const s of states) {
      await page.goto(
        `http://127.0.0.1:${PORT}/src/ui/sandbox.html?state=${s}&bg=${BG}`,
        { waitUntil: 'domcontentloaded' }
      );
      await page.waitForFunction('window.__READY__ === true', null, { timeout: 30000 });
      await pump(SETTLE);
      const out = resolve(args.out ? `${args.out}-${s}.png` : `/tmp/ui-${s}.png`);
      mkdirSync(dirname(out), { recursive: true });
      await page.screenshot({ path: out, type: 'png' });
      console.log(JSON.stringify({ ok: true, out, state: s, bg: BG, w: W, h: H }));
    }
  }
} catch (e) {
  console.error('FAILED', e.message);
  console.error(logs.slice(-30).join('\n'));
  process.exitCode = 1;
} finally {
  if (args.verbose || process.exitCode) console.error(logs.slice(-40).join('\n'));
  await browser.close();
  server?.kill();
}
