#!/usr/bin/env node
/**
 * Draw-call attribution by subsystem.
 *
 * The adaptive governor walked the game all the way down to the `low` preset at
 * 62% resolution and it was still only managing 26 fps with 3714 draw calls —
 * which means resolution and post are NOT the bottleneck, submission is. This
 * says which scene-graph root is responsible.
 *
 *   npm run build && node tools/drawbreak.mjs
 */
import { chromium } from 'playwright';
import { startServer } from './lib/server.mjs';

const { port, server } = await startServer({});
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));

try {
  await p.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  await p.evaluate(() => new Promise((d) => { let i = 0; const t = () => (++i >= 300 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }));

  const out = await p.evaluate(() => {
    const e = window.__ENGINE__;
    const cam = e.camera;
    const frustum = new (Object.getPrototypeOf(cam).constructor.name ? window.__THREE_FRUSTUM__ ?? Object : Object)();

    // Walk the top-level groups and count drawable, visible descendants.
    const rows = [];
    let totalVisible = 0;
    for (const child of e.scene.children) {
      let meshes = 0, visible = 0, tris = 0, instanced = 0;
      child.traverse?.((o) => {
        if (!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isPoints || o.isLine)) return;
        meshes++;
        // `visible` alone is not the whole story (a parent may be hidden).
        let v = o.visible, q = o.parent;
        while (v && q) { v = q.visible; q = q.parent; }
        if (!v) return;
        visible++;
        if (o.isInstancedMesh) instanced += o.count ?? 0;
        const g = o.geometry;
        const n = g?.index ? g.index.count : g?.attributes?.position?.count ?? 0;
        tris += (n / 3) * (o.isInstancedMesh ? (o.count ?? 1) : 1);
      });
      if (!meshes) continue;
      totalVisible += visible;
      rows.push({
        name: child.name || child.type,
        meshes, visible, instances: instanced, ktris: +(tris / 1000).toFixed(0),
      });
    }
    rows.sort((a, b) => b.visible - a.visible);

    const info = e.ctx.peek('render')?.renderer?.info;
    const r = e.ctx.peek('render');
    return {
      tier: e.config.quality,
      renderScale: +(e.config.q.renderScale ?? 1).toFixed(3),
      drawDistance: e.config.q.drawDistance,
      streamRadius: e.config.q.streamRadius,
      reportedCalls: info?.render?.calls ?? null,
      reportedTris: info?.render?.triangles ?? null,
      totalVisibleDrawables: totalVisible,
      renderStats: r?.stats ?? null,
      rows,
    };
  });

  console.log(JSON.stringify(out, null, 2));
  if (errs.length) console.error('\nerrors:\n' + errs.slice(0, 5).join('\n'));
} catch (e) {
  console.error('drawbreak failed:', e.message);
} finally {
  await b.close();
  server?.kill();
}
