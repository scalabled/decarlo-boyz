#!/usr/bin/env node
/**
 * CAPTURE WITH ARBITRARY QUERY PARAMS — the negative-control harness.
 *
 * `tools/capture.mjs` builds its own URL and offers no way to add a query
 * parameter, so every `?owNoXxx=1` A/B switch in `src/render/` was
 * unphotographable: the switches existed, and nothing could ever take the
 * "reverted" arm of the pair that ARCHITECTURE.md rule 12 asks for. This is
 * that harness. It is a deliberate copy of `tools/capture.mjs`'s settle /
 * freeze / converge sequence — the whole point is that the two produce the
 * same frame for the same shot with no extra params, which `--selftest`
 * checks by RMSE against a `tools/capture.mjs` frame.
 *
 *   node src/render/shotprobe.mjs --shot=car --out=/tmp/a.png
 *   node src/render/shotprobe.mjs --shot=car --out=/tmp/b.png --params=owNoCarShadow=1
 *   node src/render/shotprobe.mjs --shot=car --out=/tmp/c.png --params=owNoAoFix=1&rview=ao
 *
 * `--params` is appended verbatim, so it can carry several separated by '&'.
 * `--json` also dumps `window.__RENDER_INFO__`.
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

const W = Number(args.w ?? 1920);
const H = Number(args.h ?? 1080);
const SHOT = args.shot ?? 'hero';
const OUT = resolve(args.out ?? `shots/${SHOT}.png`);
const TIMEOUT = Number(args.timeout ?? 120000);
const SETTLE = Number(args.settle ?? 90);
const EXTRA = typeof args.params === 'string' && args.params.length ? `&${args.params}` : '';

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

/** Private, HMR-disabled server per run — same reasoning as tools/capture.mjs. */
async function freePort() {
  for (let i = 0; i < 200; i++) {
    const p = 5900 + Math.floor(Math.random() * 600);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

const PORT = await freePort();
const root = resolve(import.meta.dirname, '..', '..');
const server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
  env: { ...process.env, OW_NO_HMR: '1' },
});
let up = false;
for (let i = 0; i < 160; i++) {
  await new Promise((r) => setTimeout(r, 250));
  if (await portOpen(PORT)) { up = true; break; }
}
if (!up) { server.kill(); throw new Error('vite failed to start'); }

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal',
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
    '--disable-frame-rate-limit',
    '--force-color-profile=srgb',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    '--mute-audio',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

const pump = (n) =>
  page.evaluate(
    (k) =>
      window.__PUMP__
        ? window.__PUMP__(k)
        : new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

let failed = null;
let info = null;
try {
  const url =
    `http://127.0.0.1:${PORT}/?capture=1&shot=${encodeURIComponent(SHOT)}&lockstep=1${EXTRA}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: TIMEOUT });

  await page.evaluate(
    ({ s, settle }) => (window.__APPLY_SHOT__ ? window.__APPLY_SHOT__(s, { grabFrame: settle }) : 'no-shot-api'),
    { s: SHOT, settle: SETTLE }
  );

  let frames = 0;
  while (frames < 1200) {
    if (await page.evaluate(() => window.__SETTLED__?.() === true)) break;
    await pump(20);
    frames += 20;
  }
  await pump(SETTLE);
  const cleaned = await page.evaluate(() => window.__PRESHUTTER__?.() ?? 0);
  if (cleaned) await pump(20);
  await page.evaluate(() => {
    window.__PRESHUTTER__?.();
    const e = window.__ENGINE__;
    if (!e?.time) return false;
    e.time.scale = 0;
    const shotDef = window.__SHOTS__?.[window.__LAST_SHOT__ ?? ''] ?? null;
    if (shotDef?.time !== undefined) e.ctx.peek('sky')?.setTimeOfDay?.(shotDef.time);
    const taa = e.ctx.peek('render')?.taa;
    if (taa) { taa.index = 0; taa.reset?.(); }
    return true;
  });
  await pump(Number(args.converge ?? 32));

  if (args.eval) {
    // Diagnostic hatch: run an expression against the FROZEN, settled world.
    // Never used by a gate — a gate reads emitted pixels (rule 12) — but the
    // only way to answer "why is this pool not on screen" without guessing.
    const r = await page.evaluate(`(() => { try { return JSON.stringify(${args.eval}); } catch (e) { return 'ERR ' + e.message; } })()`);
    console.log(r);
  }
  if (!args.noshot) {
    mkdirSync(dirname(OUT), { recursive: true });
    await page.screenshot({ path: OUT, type: 'png' });
  }
  info = await page.evaluate('window.__RENDER_INFO__ ?? null');
} catch (e) {
  failed = e;
} finally {
  if (failed) console.error(logs.slice(-60).join('\n'));
  await browser.close();
  server.kill();
}

if (failed) {
  console.error(JSON.stringify({ ok: false, error: failed.message }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, out: OUT, shot: SHOT, params: EXTRA.slice(1), info: args.json ? info : undefined }));
