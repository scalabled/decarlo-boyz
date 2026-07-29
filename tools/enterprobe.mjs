#!/usr/bin/env node
/**
 * Why doesn't F get you into the car?
 *
 * The prompt renders ("F ENTER ALLEGHENY 4DR") but the player stays on foot.
 * Walks the whole chain one link at a time: does the key reach `input`, does
 * `action('use')` see it, does the edge survive into `cmd.usePressed`, is the
 * gate open, and does `tryEnter` find a vehicle.
 */
import { chromium } from 'playwright';
import { startServer } from './lib/server.mjs';

const { port, server } = await startServer({});
const b = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'] });
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));

const pump = (n) => page.evaluate((k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }), n);

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  await pump(120);

  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.input.enabled = true; e.input.frozen = false;
    e.ctx.peek('player')?.setControlEnabled?.(true);
    const pl = e.ctx.peek('player');
    const veh = e.ctx.peek('vehicles');
    const p = pl.position;
    const n = veh?.nearest?.(p.x, p.y, p.z, 400);
    if (n) pl.teleport?.({ x: n.position.x + 2.0, y: n.position.y + 1.0, z: n.position.z }, { x: 0, y: 0, z: 0 });
    // Record every use-edge the movement machine sees.
    window.__USEHITS__ = 0;
    const mv = pl.movement;
    const origUpdate = mv.update?.bind(mv);
    if (origUpdate) {
      mv.update = (...a) => { const r = origUpdate(...a); if (mv.cmd?.usePressed) window.__USEHITS__++; return r; };
    }
  });
  await pump(40);

  const before = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const veh = e.ctx.peek('vehicles');
    const p = pl.position;
    const n = veh?.nearest?.(p.x, p.y, p.z, 12);
    return {
      bindings: Object.entries(e.input.binds ?? e.input.bindings ?? {}).filter(([, v]) => String(v).includes('KeyF')),
      controlEnabled: pl.controlEnabled,
      dead: pl.health?.dead ?? null,
      vehPhase: pl.vehicles?.phase ?? null,
      vehBusy: pl.vehicles?.busy ?? null,
      nearestDist: n ? +n.position.distanceTo(p).toFixed(2) : null,
      enterRadius: pl.vehicles?.ENTER_RADIUS ?? pl.vehicles?.enterRadius ?? null,
    };
  });

  // Hold F across several frames and sample the chain.
  await page.keyboard.down('KeyF');
  const during = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    return {
      rawHeldKeyF: e.input.held?.('KeyF') ?? null,
      actionUse: e.input.action?.('use') ?? null,
      cmdUsePressed: pl.movement?.cmd?.usePressed ?? null,
    };
  });
  await pump(10);
  await page.keyboard.up('KeyF');
  await pump(90);

  const after = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    return {
      useEdgesSeen: window.__USEHITS__,
      inVehicle: !!(pl.vehicle ?? pl.currentVehicle),
      vehPhase: pl.vehicles?.phase ?? null,
    };
  });

  // Bypass input entirely: call tryEnter directly. If THIS works, the defect is
  // in the input chain; if it doesn't, it is in the entry logic itself.
  const direct = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    let threw = null;
    try { pl.vehicles.tryEnter(pl.movement); } catch (err) { threw = String(err.message); }
    return { threw, phase: pl.vehicles?.phase ?? null };
  });
  await pump(120);
  const directAfter = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    return { inVehicle: !!(pl.vehicle ?? pl.currentVehicle), phase: pl.vehicles?.phase ?? null };
  });

  console.log(JSON.stringify({ before, during, after, direct, directAfter, errs: [...new Set(errs)].slice(0, 5) }, null, 2));
} catch (e) {
  console.error('enterprobe failed:', e.message);
  console.error([...new Set(errs)].slice(0, 6).join('\n'));
} finally {
  await b.close();
  server?.kill();
}
