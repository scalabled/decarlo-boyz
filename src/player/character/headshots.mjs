#!/usr/bin/env node
/**
 * Head turntable — renders every brother's head from a sphere of camera
 * bearings through the real character studio (src/player/preview.html), so the
 * hair can be judged from behind and above, not only from the front.
 *
 *   node src/player/character/headshots.mjs --out=/tmp/head
 *   node src/player/character/headshots.mjs --boy=aidan --pose=jog
 *
 * Bearings are (azimuth, elevation) in the CHARACTER's frame: az 0 is straight
 * in front of him, az 180 straight behind, elevation is the camera's height
 * above the head. The bearing that exposes the hairline defect is
 * az 180 / el 25.
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

const W = Number(args.w ?? 512);
const H = Number(args.h ?? 512);
const OUT = resolve(args.out ?? '/tmp/head');
const POSE = args.pose ?? 'idle';
const BOYS = (args.boy ?? 'carson,aidan,dylan').split(',');
const FOV = Number(args.fov ?? 26);

/** name, azimuth deg (0 = front), elevation deg, distance m */
const BEARINGS = [
  ['front', 0, 5, 0.75],
  ['profileR', 90, 5, 0.75],
  ['profileL', -90, 5, 0.75],
  ['back', 180, 5, 0.75],
  ['backhigh', 180, 25, 0.95], // the third-person play angle the bug came from
  ['back34R', 145, 20, 0.9],
  ['back34L', -145, 20, 0.9],
  ['top', 0, 85, 0.85],
  ['topback', 180, 60, 0.85],
  ['front34', 35, 12, 0.8],
];

const portOpen = (p) =>
  new Promise((res) => {
    const s = net.connect({ port: p, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function freePort() {
  for (let i = 0; i < 200; i++) {
    const p = 5900 + Math.floor(Math.random() * 90);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

const PORT = await freePort();
const root = resolve(import.meta.dirname, '../../..');
const server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root, stdio: 'ignore', env: { ...process.env, OW_NO_HMR: '1' },
});
for (let i = 0; i < 160; i++) {
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

mkdirSync(OUT, { recursive: true });
let failed = null;
try {
  for (const boy of BOYS) {
    const url = `http://127.0.0.1:${PORT}/src/player/preview.html?boy=${boy}&pose=${POSE}&view=face&phase=0.7`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction('window.__PREVIEW_READY__ === true', null, { timeout: 60000 });
    for (const [name, az, el, dist] of BEARINGS) {
      await page.evaluate(({ az, el, dist, fov }) => {
        const P = window.__PREVIEW__;
        const { rig, camera, renderer, scene } = P;
        const head = rig.bones.head;
        rig.root.updateMatrixWorld(true);
        const e = head.matrixWorld.elements;
        const cx = e[12];
        let cy = e[13];
        const cz = e[14];
        // The head bone sits at the base of the skull; the skull centre is
        // about 9.6 cm above it (see buildHead).
        cy += 0.096 * (rig.spec.build.headScale ?? 1) * (rig.spec.build.scale ?? 1);
        const a = (az * Math.PI) / 180, ev = (el * Math.PI) / 180;
        // az 0 = in front of the character, i.e. -Z.
        camera.position.set(
          cx + Math.sin(a) * Math.cos(ev) * dist,
          cy + Math.sin(ev) * dist,
          cz - Math.cos(a) * Math.cos(ev) * dist
        );
        camera.fov = fov;
        camera.updateProjectionMatrix();
        camera.lookAt(cx, cy, cz);
        renderer.render(scene, camera);
      }, { az, el, dist, fov: FOV });
      await page.screenshot({ path: `${OUT}/${boy}-${name}.png`, type: 'png' });
    }
    console.log(`${boy}: ${BEARINGS.length} frames -> ${OUT}`);
  }
} catch (e) {
  failed = e;
} finally {
  if (failed || args.verbose) console.error(logs.slice(-30).join('\n'));
  await browser.close();
  server.kill();
}
if (failed) { console.error(failed.message); process.exit(1); }
