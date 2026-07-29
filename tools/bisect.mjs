#!/usr/bin/env node
/**
 * Ownership bisection: capture the same shot with one subsystem's scene root
 * hidden. Whatever disappears belongs to that subsystem.
 *
 *   node tools/tmp/bisect.mjs --shot=skyline --hide=props --out=/tmp/x.png
 *   node tools/tmp/bisect.mjs --shot=skyline --hide=buildings,props --out=/tmp/y.png
 *   node tools/tmp/bisect.mjs --shot=skyline --list        (name every scene root)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

const portOpen = (p) => new Promise((r) => {
  const s = net.connect({ port: p, host: '127.0.0.1' }, () => (s.destroy(), r(true)));
  s.on('error', () => r(false));
  s.setTimeout(400, () => (s.destroy(), r(false)));
});
let PORT = 0;
for (let i = 0; i < 300; i++) { const p = 7100 + Math.floor(Math.random() * 700); if (!(await portOpen(p))) { PORT = p; break; } }
const R = resolve(import.meta.dirname, '..');
const server = spawn(resolve(R, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'],
  { cwd: R, stdio: 'ignore', env: { ...process.env, OW_NO_HMR: '1' } });
for (let i = 0; i < 200; i++) { await new Promise((r) => setTimeout(r, 200)); if (await portOpen(PORT)) break; }

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--force-color-profile=srgb', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: Number(args.w ?? 1920), height: Number(args.h ?? 1080) } });
try {
  await p.goto(`http://127.0.0.1:${PORT}/?capture=1&shot=${args.shot ?? 'skyline'}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await p.evaluate((s) => window.__APPLY_SHOT__?.(s, { grabFrame: 90 }), String(args.shot ?? 'skyline'));
  await p.evaluate(() => new Promise((d) => { let i = 0; const t = () => (window.__SETTLED__?.() === true || ++i >= 1200 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }));
  await p.evaluate(() => new Promise((d) => { let i = 0; const t = () => (++i >= 90 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }));

  if (args.list) {
    console.log(JSON.stringify(await p.evaluate(() => window.__ENGINE__.scene.children.map((c) => ({
      name: c.name || c.type, visible: c.visible, kids: c.children?.length ?? 0,
    }))), null, 1));
  } else {
    const hid = await p.evaluate((names) => {
      const e = window.__ENGINE__;
      const want = names.split(',').filter(Boolean);
      const out = [];
      for (const n of want) {
        if (n === 'skyline') {
          const B = e.ctx.peek('buildings');
          for (const m of B?.skyline?.meshes ?? []) m.im.visible = false;
          out.push(`skyline(${B?.skyline?.meshes?.length ?? 0} meshes)`);
          continue;
        }
        if (n === 'far') {
          const B = e.ctx.peek('buildings');
          let k = 0;
          B?.root?.traverse?.((o) => { if (/_far_|bld_far|bl_far/.test(o.name || '')) { o.visible = false; k++; } });
          out.push(`far(${k})`);
          continue;
        }
        const sys = e.ctx.peek(n);
        if (sys?.root) { sys.root.visible = false; out.push(`${n}.root`); continue; }
        const c = e.scene.children.find((k2) => k2.name === n);
        if (c) { c.visible = false; out.push(`scene/${n}`); }
      }
      return out;
    }, String(args.hide ?? ''));
    await p.evaluate(() => new Promise((d) => { let i = 0; const t = () => (++i >= 30 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }));
    await p.evaluate(() => window.__PRESHUTTER__?.());
    await p.screenshot({ path: resolve(String(args.out ?? '/tmp/bisect.png')), type: 'png' });
    console.log(JSON.stringify({ ok: true, hid, out: args.out }));
  }
} catch (e) {
  console.error('bisect failed:', e.message);
} finally { await b.close(); server.kill(); }
