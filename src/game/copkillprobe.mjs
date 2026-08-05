#!/usr/bin/env node
/**
 * COP-KILL REWARD PROBE — the playtest's cop-kill reward check, run enough
 * times to make its old flake impossible to miss, with a negative control
 * that reintroduces the defect every run.
 *
 * THE DEFECT THIS GATES. The playtest's copwar/cop-respect checks flaked
 * roughly 1-in-3 (measured 6 failures in 18 focused runs, 33%). The wreck
 * rewards themselves were never wrong: `WorldQuery.findRoadSpot(22, 30)`
 * hands the check a lane-SNAPPED point, and the snap (`roads.nearestEdge`
 * searches 40 m) used to pull the answer outside the annulus that was asked
 * for — measured answers from 1.5 m to 52.7 m on requests for 22-30 m. Any
 * spot past the 35 m `ATTRIB_VEH_NEAR` window staged a wreck the reward path
 * correctly refuses to attribute (the anti-clairvoyance rule the suite's own
 * ped-kill check asserts), and the check read +24/3 instead of +32/4.
 * `findRoadSpot` now re-measures the snapped point against the caller's own
 * annulus; this probe is the ratchet on that seam.
 *
 * WHAT A RUN DOES, both arms every time (ARCHITECTURE rule 12 — every
 * assertion below is on the EMITTED result: economy.respect, the copKills
 * ledger, pickups on the street; staged distances are printed as diagnosis
 * only):
 *
 *   arm 1 — FIXED:  30 iterations of the scenario (4 cruisers wrecked at a
 *           spot asked for at 22-30 m, then a civilian sedan) at 30 different
 *           road positions across the map. Every iteration must pay exactly
 *           +8 respect / +1 copKills per cruiser and 0 for the sedan.
 *           The math: at the old 1-in-3 rate, 30 clean iterations happen with
 *           probability (2/3)^30 ~= 5.2e-6 — a green here is evidence, not
 *           luck. Drops are asserted in AGGREGATE (>= 1 across 120 kills at
 *           p=0.7; miss chance 0.3^120) — per-iteration 0.3^4 = 0.8% is an
 *           rng tail, not a defect.
 *
 *   arm 2 — NEGATIVE CONTROL: `wq.findRoadSpot` is monkey-patched back to
 *           the pre-fix algorithm (verbatim: sample the annulus, snap to the
 *           lane centre, accept whatever distance results) and the same 30
 *           iterations run again. At the measured 1-in-3 rate the arm misses
 *           with probability (2/3)^30, so at least one red iteration is
 *           REQUIRED — if the reintroduced defect no longer turns this probe
 *           red, the probe has stopped watching the seam and the run fails.
 *
 *   node src/game/copkillprobe.mjs [--iters=30]
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=')[1] : d;
};
const ITERS = Number(arg('iters', 30));

const { port, server } = await startServer({});
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await b.newPage({ viewport: { width: 960, height: 540 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));

const pump = (n) => page.evaluate(
  (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
  n
);

/**
 * One iteration of the scenario, at a fresh road position keyed off `seed`.
 * `legacy` swaps the staging back to the pre-fix `findRoadSpot` for the
 * duration of the iteration — the scenario body itself is identical.
 */
const runOnce = (seed, legacy) => page.evaluate(([seed, legacy]) => {
  const engine = window.__ENGINE__;
  const game = engine.ctx.get('game');
  const vehicles = engine.ctx.peek('vehicles');
  const fr = game.freeroam;
  const wq = game.wq;

  /**
   * The pre-fix `findRoadSpot`, verbatim: accepts the lane-snapped point at
   * whatever distance the snap produced. Installed only for the negative-
   * control arm, restored in the finally below.
   */
  const legacySpot = function (min, max, cx, cz, out = this._spot) {
    const roads = this.world?.roads;
    const TAU = Math.PI * 2;
    out.ok = false;
    for (let i = 0; i < 120; i++) {
      const a = this.rng.float() * TAU;
      const r = min + (max - min) * this.rng.float();
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (!this.inBounds(x, z) || this.isWater(x, z)) continue;
      if (!roads?.nearestEdge) {
        out.x = x; out.z = z; out.y = this.groundY(x, z); out.yaw = a; out.ok = true;
        return out;
      }
      const hit = roads.nearestEdge(x, z, 40);
      if (!hit?.edge) continue;
      if (roads.laneCenter) {
        const t = Math.max(0, Math.min(1, typeof hit.t === 'number' ? hit.t : 0.5));
        roads.laneCenter(hit.edge.id ?? hit.edge, hit.lane ?? 0, t, this._v);
        if (this.isWater(this._v.x, this._v.z)) continue;
        out.x = this._v.x;
        out.z = this._v.z;
        out.yaw = roads.laneYaw ? roads.laneYaw(hit.edge, hit.lane ?? 0) : a;
      } else {
        out.x = x; out.z = z; out.yaw = a;
      }
      out.y = this.groundY(out.x, out.z);
      out.ok = true;
      return out;
    }
    const a = this.rng.float() * TAU;
    out.x = cx + Math.cos(a) * min;
    out.z = cz + Math.sin(a) * min;
    out.y = this.groundY(out.x, out.z);
    out.yaw = a;
    out.ok = false;
    return out;
  };

  const realSpot = wq.findRoadSpot;
  if (legacy) wq.findRoadSpot = legacySpot;
  const spawned = [];
  try {
    // A different neighbourhood every iteration, the way the real suite runs
    // this check wherever the previous chapter happened to leave the player.
    const a = (seed * 2.399963) % (Math.PI * 2);
    const r = 120 + (seed * 97) % 900;
    const home = realSpot.call(wq, r * 0.8, r, Math.cos(a) * 400, Math.sin(a) * 400);
    wq.placePlayer(home.x, home.z, 0);
    game.missions.abort();
    game.hostiles.clear();
    game.heat.clear('probe');
    // 30 iterations of drops outlive a 64-slot pool (45 s TTL); the pool
    // filling up is the harness's own weather, not the system under test.
    for (const p of game.pickups.live.slice()) {
      if (p.kind === 'cash' && !p.ambient) game.pickups.despawn(p);
    }

    const pos = wq.playerPos();
    const px0 = pos.x, pz0 = pos.z;
    const r0 = game.economy.respect;
    const ck0 = fr.copKills;
    let wrecked = 0;
    const dists = [];
    for (let i = 0; i < 4; i++) {
      const s = wq.findRoadSpot(22, 30, pos.x, pos.z);
      const v = wq.spawnVehicle('police', s.x, s.z, 0);
      if (!v) { dists.push(null); continue; }
      spawned.push(v);
      dists.push(+Math.hypot(v.position.x - px0, v.position.z - pz0).toFixed(1));
      vehicles.damage(v, v.health + 20, v.position);
      if (v.destroyed) wrecked++;
    }
    const copR = game.economy.respect - r0;
    const copKills = fr.copKills - ck0;
    const drops = game.pickups.live.filter((p) => p.kind === 'cash' && !p.ambient).length;

    // negative control inside the scenario: a civilian wreck pays nothing
    const r1 = game.economy.respect;
    const s2 = wq.findRoadSpot(22, 30, pos.x, pos.z);
    const c = wq.spawnVehicle('sedan', s2.x, s2.z, 0);
    if (c) { spawned.push(c); vehicles.damage(c, c.health + 20, c.position); }
    const civR = game.economy.respect - r1;

    const ok = wrecked === 4 && copR === 32 && copKills === 4 && civR === 0;
    return {
      ok, wrecked, copR, copKills, drops, civR, dists,
      home: [Math.round(home.x), Math.round(home.z)],
    };
  } finally {
    wq.findRoadSpot = realSpot;
    game.heat.clear('probe');
    for (const v of spawned) wq.despawnVehicle(v, { force: true });
  }
}, [seed, legacy]);

const runArm = async (name, legacy) => {
  let bad = 0;
  let drops = 0;
  for (let i = 0; i < ITERS; i++) {
    const r = await runOnce(i + (legacy ? 1000 : 0), legacy);
    drops += r.drops;
    if (!r.ok) {
      bad++;
      console.log(
        `    red #${String(i + 1).padStart(2)} @[${r.home}] wrecked=${r.wrecked} ` +
        `copR=${r.copR} copKills=${r.copKills} civR=${r.civR} staged at [${r.dists}] m`
      );
    }
    await pump(20);
  }
  console.log(`  ${name}: ${ITERS - bad}/${ITERS} iterations clean, ${drops} cash drops on the street`);
  return { bad, drops };
};

try {
  await page.goto(`http://127.0.0.1:${port}/?q=low&prewarm=0`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  await page.waitForFunction('window.__SETTLED__ ? window.__SETTLED__() : true', null, { timeout: 120000 });

  console.log(`\nCOP-KILL REWARD probe — ${ITERS} iterations per arm\n`);
  const fixed = await runArm('fixed staging   ', false);
  const nc = await runArm('NEGATIVE CONTROL', true);

  const gateOk = fixed.bad === 0 && fixed.drops >= 1;
  const ncOk = nc.bad >= 1;
  console.log(
    `\n  gate ${gateOk ? 'GREEN' : 'RED'} — ${ITERS - fixed.bad}/${ITERS} clean ` +
    `(at the old 1-in-3 rate, P(all clean) = (2/3)^${ITERS} ~= ${((2 / 3) ** ITERS).toExponential(1)})`
  );
  console.log(
    `  negative control ${ncOk ? 'red as required' : 'FAILED TO GO RED'} — ` +
    `${nc.bad}/${ITERS} iterations red with the pre-fix staging reinstalled`
  );
  if (errs.length) console.log('\npage errors:\n  ' + [...new Set(errs)].slice(0, 6).join('\n  '));
  process.exitCode = gateOk && ncOk && errs.length === 0 ? 0 : 1;
} catch (e) {
  console.error('copkillprobe failed:', e.message);
  console.error([...new Set(errs)].slice(0, 6).join('\n'));
  process.exitCode = 1;
} finally {
  await b.close();
  server?.kill();
}
