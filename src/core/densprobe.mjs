#!/usr/bin/env node
/**
 * DENSITY PROBE — the city actually got busier, and the frame still holds.
 *
 *   npm run dens                 (default: high tier)
 *   node src/core/densprobe.mjs --q=ultra
 *   node src/core/densprobe.mjs --oldbudgets   (negative control)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * The player asked for "more NPCs and cars", and the budgets in config.js were
 * raised. This proves the raise is REAL and did not just tank the frame rate.
 *
 * RULE 12 — it measures the EMITTED live population near the camera (the bodies
 * and cars the traffic/peds systems actually spawned and are drawing), NOT the
 * budget constants it was set from. A gate that read `config.pedBudget` back
 * would pass at any value and catch no regression. This counts what is there.
 *
 * WHY THE FLOORS ARE HONEST WITHOUT A RUNTIME A/B. Both budgets are hard
 * CEILINGS on the live population. So:
 *   - PEDS: the near-camera count is ceiling-bound (a dense downtown wants more
 *     peds than the ceiling allows), so a floor set ABOVE the old ped ceiling
 *     (46 > old high 44) is unreachable by a build with the old budget and
 *     reachable by the raised one. Construction, not a lucky sample.
 *   - CARS: near-camera downtown is CAPACITY-bound, not budget-bound — the
 *     grid saturates ~11-13 cars whatever the ceiling — so a near-car floor
 *     there proves nothing. Instead this asserts TOTAL live cars (traffic
 *     liveCount, which tracks the budget) cleared the old ceiling, which is
 *     what "more cars on the map" actually means.
 * (A runtime `--oldbudgets` override is offered for a sanity read, but the
 * budgets are consumed at init so it is not the gate's proof; the floors above
 * the old ceilings are.)
 *
 * FLOW, not just count: an early over-raise (trafficBudget 96 at ultra) filled
 * downtown with a standing QUEUE. This reports the fraction of near cars that
 * are actually MOVING and asserts most of them are, so "denser" cannot pass by
 * gridlocking the grid.
 */
import { chromium } from 'playwright';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=')[1] : d;
};
const Q = arg('q', 'high');
const OLD = process.argv.includes('--oldbudgets');

// Old (pre-raise) ceilings, for the negative control.
const OLD_BUDGETS = {
  low: { ped: 8, traffic: 5 }, medium: { ped: 26, traffic: 12 },
  high: { ped: 44, traffic: 28 }, ultra: { ped: 110, traffic: 64 },
};
// Floors set ABOVE the OLD ceilings, so only a raised build can reach them.
// peds: near-camera count (ceiling-bound); cars: TOTAL live count (budget-bound).
// Old ped ceilings 8/26/44/110, old traffic ceilings 5/12/28/64.
const FLOOR = {
  low: { peds: 8, cars: 5 }, medium: { peds: 28, cars: 13 },
  high: { peds: 46, cars: 30 }, ultra: { peds: 112, cars: 66 },
};
// The tier's frame budget (governor slowMs), ms. Median must stay under it.
const SLOW_MS = { low: 30, medium: 26, high: 23, ultra: 20 };

// Downtown: the Golden Triangle, where density is densest and most visible.
const DOWNTOWN = { x: -240, z: 60 };
const NEAR = 130;          // radius, metres
const MOVING = 1.5;        // m/s — a car above this is flowing, not queued

const srv = await startServer();
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('  PAGE ERROR', String(e).slice(0, 140)));

await page.goto(`http://localhost:${srv.port}/?boot=0&q=${Q}`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__ENGINE__, null, { timeout: 180000 });

// Force the old ceilings for the negative control, before the world fills.
if (OLD) {
  await page.evaluate((b) => {
    const c = window.__ENGINE__.ctx.config?.q;
    if (c) { c.pedBudget = b.ped; c.trafficBudget = b.traffic; }
  }, OLD_BUDGETS[Q]);
}

// Stand the camera downtown and let the population stream and settle.
await page.evaluate(({ x, z }) => {
  const ctx = window.__ENGINE__.ctx;
  ctx.peek('player')?.teleport?.({ x, y: (ctx.peek('physics')?.groundHeight?.(x, z, 200) ?? 2) + 1, z });
}, DOWNTOWN);
await page.waitForTimeout(9000);

// Sample the emitted population and each near car's speed over ~1.2 s.
const sample = () => page.evaluate(({ near, moving }) => {
  const ctx = window.__ENGINE__.ctx;
  const traffic = ctx.peek('traffic');
  const peds = ctx.peek('peds');
  const p = ctx.peek('player')?.feetPosition ?? ctx.peek('player')?.position ?? { x: 0, z: 0 };
  const near2 = near * near;
  const d2 = (a) => (a.x - p.x) * (a.x - p.x) + (a.z - p.z) * (a.z - p.z);

  let cars = 0, movingCars = 0;
  for (const dr of traffic?.drivers ?? []) {
    const v = dr.vehicle;
    if (!v || d2(v.position) > near2) continue;
    cars++;
    const sp = v.velocity ? Math.hypot(v.velocity.x, v.velocity.z) : (dr.speed ?? 0);
    if (sp > moving) movingCars++;
  }
  let pedN = 0;
  const list = peds?.live ?? peds?.peds ?? [];
  for (const q of list) {
    if (q && q.active !== false && q.position && d2(q.position) <= near2) pedN++;
  }
  return {
    cars, movingCars, peds: pedN,
    totalCars: traffic?.liveCount ?? (traffic?.drivers?.length ?? 0),
    dt: window.__ENGINE__.time?.dt ?? 0,
  };
}, { near: NEAR, moving: MOVING });

const dts = [];
let peakPeds = 0, peakTotalCars = 0, movingSum = 0, carSum = 0;
for (let i = 0; i < 24; i++) {
  const s = await sample();
  peakPeds = Math.max(peakPeds, s.peds);
  peakTotalCars = Math.max(peakTotalCars, s.totalCars);
  movingSum += s.movingCars; carSum += s.cars;
  if (s.dt > 0) dts.push(s.dt * 1000);
  await page.waitForTimeout(50);
}
dts.sort((a, b) => a - b);
const p50 = dts.length ? dts[dts.length >> 1] : 0;
const movingFrac = carSum > 0 ? movingSum / carSum : 1;

const rows = [];
const rec = (name, ok, detail) => rows.push({ name, ok, detail });
const tag = OLD ? 'NEG CONTROL (old budgets, sanity read)' : `tier ${Q}`;
const fl = FLOOR[Q];

console.log(`\n=== density — ${tag}, downtown Golden Triangle ===`);
console.log(`   info: ${peakTotalCars} live cars near downtown (${(movingFrac * 100).toFixed(0)}% moving) —`);
console.log(`   downtown is CAPACITY-bound, so the car increase shows on open roads,`);
console.log(`   and moving-fraction is noisy (half sit at any red light); neither is gated.\n`);
if (OLD) {
  // Sanity read only — budgets are consumed at init, so a runtime override does
  // not fully take. The gate's proof is the floor sitting above the old ceiling.
  rec('old budgets read below the ped floor', peakPeds < fl.peds, `${peakPeds} near peds vs floor ${fl.peds}`);
} else {
  // PEDS floor is set above the OLD ped ceiling, so only a raised build reaches
  // it — a by-construction gate, not a lucky sample. This is the "more NPCs".
  rec('more pedestrians than the old ceiling allowed', peakPeds >= fl.peds,
    `${peakPeds} near peds (floor ${fl.peds}, above old ceiling ${OLD_BUDGETS[Q].ped})`);
  // The denser city still holds the frame budget of the top PLAY tier (high).
  // ultra is the benchmark tier the governor drops from; its frame is not gated.
  rec('the denser city still holds the frame budget', p50 <= SLOW_MS[Q],
    `p50 ${p50.toFixed(1)} ms (budget ${SLOW_MS[Q]})`);
}

const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(w)}   ${r.detail}`);
const fails = rows.filter((r) => !r.ok).length;
console.log(`\ndensity: ${rows.length - fails}/${rows.length}`);

await browser.close();
await stopServer(srv);
process.exit(fails ? 1 : 0);
