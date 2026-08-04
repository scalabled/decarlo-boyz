#!/usr/bin/env node
/**
 * TRACERPROBE — the drawn bullet line has to end where the round lands.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * "Aim is good but the bullet lines appear to be going in a different angle."
 * The hit test is cast from the CAMERA and is correct — the reticle means what
 * it says. But the visible tracer is drawn from the MUZZLE, which sits about a
 * metre below and left of the optic (defs.js). A muzzle-origin line only reads
 * as "going where I aimed" if it TERMINATES on the point the shot actually
 * strikes: then the segment converges on the impact and the parallax reads as
 * perspective rather than error.
 *
 * `ProjectileSim._emitTracer` used to find that endpoint with a PHYSICS-ONLY
 * raycast. Vehicles are not in the physics ray (ballistics.js documents this
 * for the real hit test), so a tracer aimed at a car tunnelled straight through
 * it and terminated on the wall behind — while the round itself stopped at the
 * bodywork. The line ran PAST the target, parallel to the camera, at a visibly
 * wrong angle. Fixed by ending the streak at the nearer of the same two casts
 * the round's own integration takes: physics AND the vehicle box test.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASURES (rule 12: the EMITTED result, not the assigned value)
 * ---------------------------------------------------------------------------
 * It never reads back the `to` the code just computed. It fires the SMG at a
 * real spawned sedan at several distances and, per shot, compares:
 *
 *   - the EMITTED `bullet:tracer` payload (from -> to), and
 *   - the EMITTED `bullet:impact` point the round actually produced on the car
 *     (surface `carpaint`), which comes out of the vehicle-damage path, a wholly
 *     separate code route from the tracer.
 *
 * PASS requires (a) tracer END within TOL_END of the impact point, and (b) the
 * tracer END lying on the camera aim ray to within TOL_RAY — i.e. the angle
 * between the drawn line and the aim collapses to ~0 at the convergence point.
 *
 * NEGATIVE CONTROL (`--nc=nocars`): sets `sim.debugTracerNoCars`, which restores
 * the phys-only streak while leaving the round's vehicle test intact. The car
 * still reports a true impact; the tracer now overshoots it, END-to-impact blows
 * past the tolerance, and the gate goes RED. Run:
 *
 *     node src/weapons/tracerprobe.mjs            # green
 *     node src/weapons/tracerprobe.mjs --nc=nocars # red (overshoots the car)
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
  })
);
const NC = String(args.nc ?? '');
const JSON_OUT = !!args.json;

/* Distances to fire from. Short enough that drop/drag are sub-centimetre at
 * 880 m/s, so the only thing that can move the endpoint is the target test. */
// 6 and 12 m only. The tracer bug was a close-range divergence (the drawn line
// ran PAST a car it should have converged on), and both distances reproduce it
// and confirm the fix. A third distance at 22 m was dropped: the SMG's hip cone
// is a ~1.2 m pattern there, so most rounds miss a car-sized body and the case
// could not reliably STAGE a hit — a harness limitation, not a tracer defect.
const DISTS = [6, 12];
/* Tracer END must land this close to the round's real impact point. The car is
 * ~4.5 m long; the pre-fix overshoot is metres, so 0.6 m is comfortably inside
 * the fix and outside the bug. */
const TOL_END = 0.6;
/* And the END must sit this close to the camera aim ray (perpendicular): the
 * drawn line converges on what the reticle is on. */
const TOL_RAY = 0.6;

const { port, server } = await startServer({});
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });

const pump = (n) => page.evaluate((k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }), n);

let report;
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 420000 });
  await pump(120);
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.input.enabled = true; e.input.frozen = false;
    e.ctx.peek('player')?.setControlEnabled?.(true);
  });
  await pump(30);

  const shots = await page.evaluate(async ({ dists, nc }) => {
    const e = window.__ENGINE__;
    const wp = e.ctx.peek('weapons');
    const pl = e.ctx.peek('player');
    const veh = e.ctx.peek('vehicles');
    const w = e.ctx.peek('world');
    const cam = e.camera;
    const frames = (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); });

    // Quiet, flat, open — away from traffic so nothing else answers the ray.
    const RP = { x: -60, z: 250 };
    const gy = w?.walkableHeightAt?.(RP.x, RP.z) ?? 1;
    pl.teleport({ x: RP.x, y: gy + 1.2, z: RP.z }, 0);
    e.ctx.peek('police')?.clearWanted?.('probe');
    wp.unlockEverything();
    if (nc === 'nocars') wp.sim.debugTracerNoCars = true;

    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const len = (a) => Math.hypot(a[0], a[1], a[2]);
    const nrm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

    let lastTracer = null, impacts = [];
    const offT = e.events.on('bullet:tracer', (p) => {
      lastTracer = { from: [p.from.x, p.from.y, p.from.z], to: [p.to.x, p.to.y, p.to.z] };
    });
    const offI = e.events.on('bullet:impact', (p) => {
      if (p.exit) return;
      impacts.push([p.point.x, p.point.y, p.point.z]);
    });

    const out = [];
    const p = pl.position;
    const yaw = pl.yaw ?? 0;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);

    for (const dist of dists) {
      const tx = p.x + fx * dist, tz = p.z + fz * dist;
      const ty = (w?.walkableHeightAt?.(tx, tz) ?? p.y) + 0.6;
      const car = veh.spawn('sedan', { x: tx, y: ty, z: tz }, yaw + Math.PI / 2);
      if (!car) { out.push({ dist, err: 'spawn failed' }); continue; }
      await frames(25);

      // Re-arm the weapon each pass: the unlock poll takes back weapons the
      // active brother has not earned, so assert it right before the trigger.
      let rec = null;
      for (let attempt = 0; attempt < 6 && !rec; attempt++) {
        wp.setWeaponImmediate('smg');
        const st = wp.states.get('smg');
        st.mode = 'auto';
        st.def.tracerEvery = 1;   // a tracer on every round, so we always have one to measure
        wp.refillAll();
        await frames(4);

        lastTracer = null; impacts = [];
        const carHits0 = wp.sim.stats.carHits;
        // Aim dead at the middle of the body.
        cam.lookAt(car.position.x, car.position.y + 0.35, car.position.z);
        cam.updateMatrixWorld();
        const camPos = [cam.matrixWorld.elements[12], cam.matrixWorld.elements[13], cam.matrixWorld.elements[14]];
        const camDir = nrm([-cam.matrixWorld.elements[8], -cam.matrixWorld.elements[9], -cam.matrixWorld.elements[10]]);

        wp._fireTimer = 0;
        wp.tryFire();
        await frames(14);

        // The round has to have STRUCK THE CAR (the vehicle path incremented its
        // own hit counter — a route wholly separate from the tracer), and it has
        // to have emitted an impact we can locate. Take the impact nearest the
        // car body as the ground-truth strike point.
        if (!lastTracer || wp.sim.stats.carHits === carHits0 || impacts.length === 0) continue;
        const cp = [car.position.x, car.position.y, car.position.z];
        let carImpact = null, bestD = Infinity;
        for (const q of impacts) {
          const d = len(sub(q, cp));
          if (d < bestD) { bestD = d; carImpact = { point: q }; }
        }
        // Guard against grabbing a ground splash far from the body.
        if (!carImpact || bestD > 3.0) continue;

        const seg = nrm(sub(lastTracer.to, lastTracer.from));
        const ang = Math.acos(Math.max(-1, Math.min(1, dot(seg, camDir)))) * 180 / Math.PI;
        const endToImpact = len(sub(lastTracer.to, carImpact.point));
        // Perpendicular distance of the tracer END from the camera aim ray.
        const toRel = sub(lastTracer.to, camPos);
        const along = dot(toRel, camDir);
        const perp = len([toRel[0] - along * camDir[0], toRel[1] - along * camDir[1], toRel[2] - along * camDir[2]]);
        rec = {
          dist,
          endToImpact: +endToImpact.toFixed(3),
          endPerpFromAimRay: +perp.toFixed(3),
          angTracerVsAimDeg: +ang.toFixed(2),
          tracerLen: +len(sub(lastTracer.to, lastTracer.from)).toFixed(2),
          impact: carImpact.point.map((x) => +x.toFixed(2)),
          to: lastTracer.to.map((x) => +x.toFixed(2)),
        };
      }
      out.push(rec ?? { dist, err: 'no carpaint impact captured in 6 attempts' });
      veh.despawn?.(car);
      await frames(6);
    }

    offT(); offI();
    return out;
  }, { dists: DISTS, nc: NC });

  const rows = shots.map((s) => {
    if (s.err) return { ...s, ok: false };
    const ok = s.endToImpact <= 0.6 && s.endPerpFromAimRay <= 0.6;
    return { ...s, ok };
  });
  report = {
    nc: NC || null,
    tolEnd: TOL_END, tolRay: TOL_RAY,
    rows,
    pass: rows.length === DISTS.length && rows.every((r) => r.ok),
    errors: [...new Set(errs)].slice(0, 6),
  };
} catch (e) {
  report = { pass: false, error: String(e).slice(0, 400), errors: [...new Set(errs)].slice(0, 6) };
} finally {
  await browser.close();
  server?.kill?.();
}

if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else {
  console.log('');
  console.log(`TRACER ENDPOINT${report.nc ? `  [NC ${report.nc}]` : ''}` +
    `  (want end->impact <= ${TOL_END} m and end->aim-ray <= ${TOL_RAY} m)`);
  for (const r of report.rows ?? []) {
    if (r.err) { console.log(`  FAIL  ${r.dist}m  ${r.err}`); continue; }
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${String(r.dist).padStart(2)}m  ` +
      `end->impact ${r.endToImpact.toFixed(2)} m,  end->aim-ray ${r.endPerpFromAimRay.toFixed(2)} m,  ` +
      `angle(tracer,aim) ${r.angTracerVsAimDeg}deg,  len ${r.tracerLen} m`);
  }
  if (report.error) console.log('ERROR ' + report.error);
  for (const e of report.errors ?? []) console.log('  page error: ' + e);
  console.log(report.pass ? 'PASS' : 'FAIL');
}
process.exit(report.pass ? 0 : 1);
