#!/usr/bin/env node
/**
 * In-game head check — the exact conditions the hairline defect shows under.
 *
 * The studio (headshots.mjs) proves the geometry; this proves what is actually
 * on screen: the real engine, the real sky, quality preset
 * `low` (renderScale 0.7, no TAA, no GTAO, lodBias 2.4), daytime overcast, the
 * camera behind and slightly above a brother on a pavement.
 *
 *   node src/player/character/ingame.mjs --out=/tmp/ingame
 *   node src/player/character/ingame.mjs --q=ultra
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const W = Number(args.w ?? 1280);
const H = Number(args.h ?? 720);
const Q = args.q ?? 'low';
const OUT = resolve(args.out ?? '/tmp/ingame');
const BOYS = (args.boy ?? 'carson,aidan,dylan').split(',');
/** name, azimuth deg relative to the character's facing, elevation, distance, fov */
const BEARINGS = [
  ['tps', 180, 14, 3.6, 55], // the third-person play framing the bug came from
  ['backhigh', 180, 24, 1.7, 34],
  ['back', 180, 6, 1.6, 34],
  ['topback', 180, 55, 1.7, 34],
  ['back34', 140, 20, 1.7, 34],
  ['profile', 90, 8, 1.6, 34],
];

const portOpen = (p) =>
  new Promise((res) => {
    const s = net.connect({ port: p, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });
async function freePort() {
  for (let i = 0; i < 200; i++) {
    const p = 6000 + Math.floor(Math.random() * 90);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

const PORT = await freePort();
const root = resolve(import.meta.dirname, '../../..');
const server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root, stdio: 'ignore', env: { ...process.env, OW_NO_HMR: '1' },
});
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 250));
  if (await portOpen(PORT)) break;
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

mkdirSync(OUT, { recursive: true });
let failed = null;
try {
  await page.goto(`http://127.0.0.1:${PORT}/?capture=1&q=${Q}&shot=character`, {
    waitUntil: 'domcontentloaded', timeout: 120000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });
  await page.evaluate(() => window.__APPLY_SHOT__('character', { grabFrame: 60 }));
  await page.evaluate(
    () => new Promise((d) => { let i = 0; const t = () => (window.__SETTLED__?.() || ++i > 900 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); })
  );
  await pump(60);

  const q = await page.evaluate(() => ({
    quality: window.__ENGINE__.ctx.config.quality,
    renderScale: window.__ENGINE__.ctx.config.q.renderScale,
    lodBias: window.__ENGINE__.ctx.config.q.lodBias,
    taa: window.__ENGINE__.ctx.config.q.taa,
    hour: window.__ENGINE__.ctx.peek('sky')?.hour ?? null,
  }));
  console.log(`preset ${JSON.stringify(q)}`);

  // Stand him where the sim already put him — a legal, streamed piece of the
  // city — and keep that spot for every brother so the frames are comparable.
  const spot = await page.evaluate(() => {
    const p = window.__ENGINE__.ctx.peek('player');
    const m = p.movement.position;
    return { at: [m.x, m.y, m.z] };
  });
  // Face him along -Z (yaw 0) so "behind him" is +Z; the shot's `player` block
  // teleports and poses him, which is also what un-hides the body.
  const YAW = 0;
  const fwd = [-Math.sin(YAW), 0, -Math.cos(YAW)];

  for (const boy of BOYS) {
    for (const [name, az, el, dist, fov] of BEARINGS) {
      const a = (az * Math.PI) / 180, ev = (el * Math.PI) / 180;
      // az 0 = in front of him, so rotate his forward vector by `az` about +Y.
      const dx = fwd[0] * Math.cos(a) - fwd[2] * Math.sin(a);
      const dz = fwd[0] * Math.sin(a) + fwd[2] * Math.cos(a);
      const shot = {
        pos: [0, 0, 0],
        look: [0, 0, 0],
        fov,
        time: 13.5,
        player: { at: spot.at, yaw: YAW, state: 'idle', brother: boy, camera: false },
      };
      // Head height: hips 0.945 + 0.603 to the skull centre, times build scale.
      await page.evaluate((s) => window.__APPLY_SHOT__(s, { grabFrame: 30 }), JSON.stringify(shot));
      await pump(10);
      const head = await page.evaluate(() => {
        const rig = window.__ENGINE__.ctx.peek('player').character;
        rig.root.updateMatrixWorld(true);
        const e = rig.bones.head.matrixWorld.elements;
        const hs = (rig.spec.build.headScale ?? 1) * (rig.spec.build.scale ?? 1);
        return [e[12], e[13] + 0.096 * hs, e[14]];
      });
      shot.pos = [
        head[0] + dx * Math.cos(ev) * dist,
        head[1] + Math.sin(ev) * dist,
        head[2] + dz * Math.cos(ev) * dist,
      ];
      shot.look = name === 'tps' ? [head[0], head[1] - 0.45, head[2]] : head;
      await page.evaluate((s) => window.__APPLY_SHOT__(s, { grabFrame: 30 }), JSON.stringify(shot));
      await pump(50);
      await page.screenshot({ path: `${OUT}/${boy}-${Q}-${name}.png`, type: 'png' });
    }
    console.log(`${boy}: ${BEARINGS.length} frames -> ${OUT}`);
  }
} catch (e) {
  failed = e;
} finally {
  if (failed || args.verbose) console.error(logs.slice(-40).join('\n'));
  await browser.close();
  server.kill();
}
if (failed) { console.error(failed.message); process.exit(1); }
