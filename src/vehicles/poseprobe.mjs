#!/usr/bin/env node
/**
 * POSE PROBE — is the beauty shot's subject actually standing in a clear spot?
 *
 *   node src/vehicles/poseprobe.mjs
 *   node src/vehicles/poseprobe.mjs --control    (the A/B, expected to go red)
 *   node src/vehicles/poseprobe.mjs --shot=car --type=sports
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT MEASURES AND WHY IT IS NOT THE SAME QUESTION `debugPose` ASKS
 * ────────────────────────────────────────────────────────────────────────────
 * `vehicles.debugPose('beauty')` nudges the subject along the camera's forward
 * ray until it has room. For a long time "room" meant `this.vehicles` and
 * nothing else — and traffic is the one thing in a street that moves out of the
 * way. A lamp column stood through the roof of the Kessel in both framings of
 * `mkt_kessel`, and the search never looked at it.
 *
 * The obvious gate would re-run the same `overlapCapsule` the fix uses, which
 * would be a gate comparing a number to itself (hard rule 12) — it would pass
 * on any build where the query is wired up, including one where the SEARCH is
 * broken and the capsule merely reports what it was handed.
 *
 * So this asks a DIFFERENT question of a different query: after everything has
 * settled, fire a fan of horizontal rays out of the body at three heights and
 * measure how far the nearest static surface is. Rays, not capsule overlaps;
 * the settled body, not the candidate; and the answer is a DISTANCE, so a
 * regression shows up as a number shrinking rather than as a boolean flipping.
 *
 * It also checks the body is LEVEL. A spot with a kerb under one flank is
 * clear and still ruins the frame, because `frameVehicle` has already aimed at
 * where a level car would have been.
 *
 * NEGATIVE CONTROL: `--control` loads with `?owNoPoseClear=1`, which reverts
 * the search to the traffic-only test the bug shipped with. Same convention as
 * `?owNoLightLock=1` in `src/render/`. If the control does not go red, the fix
 * is not the thing making the green.
 *
 *   MEASURED, `mkt_kessel`:  fixed  nearest static 2.02 m, roll 0.3 deg
 *                            control  nearest static 0.38 m (a lamp column
 *                            0.38 m off the centreline, i.e. inside the body)
 */

import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const SHOT = args.shot ?? 'mkt_kessel';
const CONTROL = !!args.control;

/**
 * RATCHET. The subject's body must have this much air around it.
 *
 * 0.9 m is where the fix got to on `mkt_kessel`, not where the bar is: the goal
 * is that nothing static is inside the body's own footprint at all, which means
 * ~1.0 m from the centreline for a 2 m car and more for the ends. It is a
 * ratchet because the spiral is a fixed 15-candidate search over one street and
 * a denser pavement can legitimately leave less room; widening the search or
 * scoring the free space rather than a hit count would raise this.
 *
 * LOWER A RATCHET WHEN YOU IMPROVE IT. Never raise one to make a run go green.
 */
const MIN_STATIC_M = 0.9;
/** Same. A chocked car on a flat slab settles under 1 degree. */
const MAX_ROLL_DEG = 3.0;

const { port, server } = await startServer({});
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
const pump = (n) =>
  page.evaluate((k) => new Promise((d) => {
    let i = 0;
    const t = () => (++i >= k ? d() : requestAnimationFrame(t));
    requestAnimationFrame(t);
  }), n);

let r = null;
let failed = null;
try {
  const q = `?capture=1&shot=${SHOT}${CONTROL ? '&owNoPoseClear=1' : ''}`;
  await page.goto(`http://127.0.0.1:${port}/${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await page.evaluate((s) => window.__APPLY_SHOT__?.(s, { grabFrame: 60 }), SHOT);
  await pump(300);

  r = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const veh = e.ctx.peek('vehicles');
    const ph = e.ctx.peek('physics');
    const v = veh?._debugSpawned?.[0];
    if (!v || !ph) return { err: !v ? 'no staged subject' : 'no physics' };

    const P = v.position;
    const gy = P.y - v.spec.comY;
    const mask = ph.MASK.WORLD;

    /**
     * Rays OUT of the body, not a capsule around a candidate. Three heights
     * through the cabin and the boot, 32 bearings each. The nearest hit is the
     * clearance the picture actually has.
     */
    let nearest = Infinity;
    let what = null;
    const H = v.spec.dims.H;
    for (const h of [0.35, H * 0.55, H * 0.92]) {
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        const hit = ph.raycast(P.x, gy + h, P.z, Math.cos(a), 0, Math.sin(a), 6, mask);
        if (hit.hit && hit.distance < nearest) {
          nearest = hit.distance;
          what = { at: +h.toFixed(2), bearing: Math.round(a * 57.2958), obj: hit.object?.name ?? hit.object?.type ?? '?', surface: hit.surface };
        }
      }
    }
    // And straight up out of the roof: a column that starts above the body and
    // comes down through it never crosses a horizontal fan near the ground.
    for (const [dx, dz] of [[0, 0], [0.55, 0], [-0.55, 0], [0, 0.9], [0, -0.9]]) {
      const hit = ph.raycast(P.x + dx, gy + H * 0.98, P.z + dz, 0, 1, 0, 8, mask);
      if (hit.hit) { nearest = Math.min(nearest, 0); what = { at: 'overhead', obj: hit.object?.name ?? '?', surface: hit.surface }; }
    }

    // Roll, from the body's own right vector — not from the terrain normal the
    // spawn used.
    const q = v.quaternion;
    const rx = 1 - 2 * (q.y * q.y + q.z * q.z);
    const ry = 2 * (q.x * q.y + q.w * q.z);
    const rz = 2 * (q.x * q.z - q.w * q.y);
    const rl = Math.hypot(rx, ry, rz) || 1;
    const roll = Math.asin(Math.max(-1, Math.min(1, ry / rl))) * 57.2958;

    return {
      type: v.type,
      pos: [+P.x.toFixed(2), +P.y.toFixed(2), +P.z.toFixed(2)],
      nearestStatic: Number.isFinite(nearest) ? +nearest.toFixed(2) : null,
      what,
      rollDeg: +roll.toFixed(2),
      scan: veh._poseScan ?? null,
      staticTris: ph.stats?.triangles ?? null,
    };
  });
} catch (e) {
  failed = e;
}
await browser.close();
server.close?.();

console.log(`poseprobe --shot=${SHOT}${CONTROL ? '  [CONTROL: owNoPoseClear=1]' : ''}`);
if (failed || !r || r.err) {
  console.log(`  ERROR ${failed?.message ?? r?.err ?? 'unknown'}`);
  if (errs.length) console.log(errs.slice(0, 4).join('\n'));
  process.exit(1);
}
console.log(JSON.stringify(r, null, 2));

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}  ${detail}`);
  cond ? pass++ : fail++;
};
check('nothing static inside the body (RATCHET)',
  r.nearestStatic === null || r.nearestStatic >= MIN_STATIC_M,
  `nearest ${r.nearestStatic ?? 'none'} m (min ${MIN_STATIC_M})`);
check('subject is level (RATCHET)',
  Math.abs(r.rollDeg) <= MAX_ROLL_DEG,
  `roll ${r.rollDeg} deg (max ${MAX_ROLL_DEG})`);
check('the search ran and reported a scan', !!r.scan?.scan?.length,
  `${r.scan?.scan?.length ?? 0} candidates, chose blocked=${r.scan?.blocked}`);

console.log(`\n${pass}/${pass + fail} pose assertions pass`);
process.exit(fail ? 1 : 0);
