#!/usr/bin/env node
/**
 * POLICE — headless behaviour harness.
 *
 *   node src/police/harness.mjs
 *   node src/police/harness.mjs --seconds=90 --level=4 --json=/tmp/chase.json
 *
 * A screenshot proves a cruiser exists. It cannot prove that the cruiser CLOSES
 * on you, that six of them do not stack into one corner, that a roadblock is
 * built in front of you rather than behind, that the meter falls only when you
 * are out of sight, or that no unit ends the chase wedged against a bollard
 * with its lightbar on. Those are the things that actually make or break a
 * pursuit, and every one of them is a time series.
 *
 * So this boots the real engine in headless Chromium (its own HMR-disabled
 * vite, per tools/lib/server.mjs), starts a scripted chase through
 * `police.debugChase()` — which drives the getaway car with the SAME controller
 * the cruisers use — samples `police.sample()` at 5 Hz, and asserts.
 *
 * Exit code is the number of failed assertions.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const SECONDS = Number(args.seconds ?? 70);
const LEVEL = Number(args.level ?? 3);
const QUALITY = args.q ?? 'high';
const HZ = 5;

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio',
    '--disable-frame-rate-limit', '--enable-gpu-rasterization',
  ],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => { if (errors.length < 40) { errors.push(String(e.message)); console.log('PAGEERROR', String(e.message).slice(0,200)); } });
let bigLog = 0;
page.on('console', (m) => {
  const t = m.text();
  if (t.length > 5000 && bigLog++ < 5) console.log('HUGECONSOLE', m.type(), t.length, t.slice(0, 200));
  if (m.type() === 'error' && errors.length < 40) errors.push(t.slice(0, 300));
});

let fails = 0;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  if (!ok) fails++;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${name}${detail !== undefined ? `  — ${detail}` : ''}`);
};

try {
  await page.goto(`http://127.0.0.1:${port}/?q=${QUALITY}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 90000 });

  // Let the first ring of tiles land so there is collision under the chase.
  await pump(page, 120);

  const started = await page.evaluate((level) => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    if (!pol) return { ok: false, reason: 'no police system' };
    e.input.frozen = true;
    e.ctx.peek('player')?.setControlEnabled?.(false);
    return pol.debugChase({ level, follow: true, maxDist: 160 });
  }, LEVEL);
  if (!started.ok) throw new Error(`debugChase failed: ${started.reason}`);
  console.log(`chase started at ${started.x}, ${started.z} (${started.type}) at ${LEVEL}*\n`);

  /* ------------------------------------------------------------------ */
  /* PHASE 1 — the pursuit                                              */
  /* ------------------------------------------------------------------ */
  const trace = await record(page, SECONDS, HZ);

  /* ------------------------------------------------------------------ */
  /* PHASE 2 — evasion: teleport the runner far away, out of every cone  */
  /* ------------------------------------------------------------------ */
  await page.evaluate(() => {
    const pol = window.__ENGINE__.ctx.peek('police');
    const r = pol._runners[0];
    if (!r?.vehicle) return;
    const roads = pol.roads;
    const s = roads.sampleSpawn(pol.rng, r.vehicle.position, 900, 1400, (e) => !e.rail);
    if (!s) return;
    r.vehicle.setPose(
      { x: s.position.x, y: pol.groundAt(s.position.x, s.position.z, s.position.y + 20) + 0.6, z: s.position.z },
      s.yaw
    );
    r.vehicle.velocity.set(0, 0, 0);
    r.path.reset();
    r.hasSearchPt = false;
    pol._teleportedAt = window.__ENGINE__.time.elapsed;
  });
  const evade = await record(page, 46, HZ);

  /* ------------------------------------------------------------------ */
  /* PHASE 3 — respray clears it instantly                              */
  /* ------------------------------------------------------------------ */
  const respray = await page.evaluate(() => {
    const pol = window.__ENGINE__.ctx.peek('police');
    pol.setWanted(4);
    const before = pol.wanted;
    pol.clearWanted('respray');
    return { before, after: pol.wanted, units: pol.units.length };
  });

  await page.evaluate(() => window.__ENGINE__.ctx.peek('police').debugChaseStop());

  /* ================================================================== */
  /* ASSERTIONS                                                         */
  /* ================================================================== */
  const all = trace;
  const late = all.slice(Math.floor(all.length * 0.25));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');

  /* --- a fleet actually turned up ---------------------------------- */
  const maxUnits = Math.max(...all.map((s) => s.units.length));
  const target = all[all.length - 1].fleetTarget;
  check('fleet reaches its dispatch target', maxUnits >= target,
    `max ${maxUnits} of target ${target}`);

  /* --- cops close distance ------------------------------------------ */
  const nearest = all.map((s) => minDist(s));
  const early = median(nearest.slice(2, Math.max(4, Math.floor(nearest.length * 0.25))));
  const settled = median(nearest.slice(Math.floor(nearest.length * 0.45)));
  check('cops close the distance', settled < early || settled < 60,
    `nearest cop: ${fmt(early)} m early -> ${fmt(settled)} m settled`);

  const everClose = Math.min(...nearest.filter(Number.isFinite));
  check('at least one cop gets on the bumper', everClose < 22, `closest ever ${fmt(everClose)} m`);

  /* --- they do not pile into each other ----------------------------- */
  let worstPair = Infinity;
  let overlapSamples = 0;
  for (const s of all) {
    const d = minPair(s);
    if (d < worstPair) worstPair = d;
    if (d < 3.2) overlapSamples++;
  }
  check('cruisers do not interpenetrate', worstPair > 2.4,
    `closest cop-to-cop ${fmt(worstPair)} m`);
  check('cruisers rarely stack', overlapSamples / all.length < 0.12,
    `${((overlapSamples / all.length) * 100).toFixed(1)}% of samples inside 3.2 m`);

  /* --- the tail is not a queue -------------------------------------- */
  const chaseHeavy = late.filter((s) => {
    const act = s.units.filter((u) => u.role !== 'leave');
    if (act.length < 3) return false;
    return act.filter((u) => u.role === 'chase').length === act.length;
  }).length;
  check('most of the fleet is not just tailing', chaseHeavy / Math.max(1, late.length) < 0.55,
    `${((chaseHeavy / Math.max(1, late.length)) * 100).toFixed(0)}% of samples were all-chase`);

  const roleSet = new Set();
  for (const s of all) for (const u of s.units) roleSet.add(u.role);
  check('tactical roles are actually used', roleSet.size >= 3,
    [...roleSet].join(','));

  /* --- nobody gets stuck forever ------------------------------------ */
  let maxStuck = 0;
  for (const s of all.concat(evade)) for (const u of s.units) maxStuck = Math.max(maxStuck, u.stuck);
  check('no cop stuck forever', maxStuck < 13, `worst stuck accumulator ${fmt(maxStuck)} s`);

  const frozen = longestFrozen(all.concat(evade));
  check('no cop parked in the road mid-chase', frozen < 12,
    `longest continuous stall by one unit ${fmt(frozen)} s`);

  /* --- roadblocks form AHEAD ---------------------------------------- */
  const blockSamples = all.concat(evade).filter((s) => s.blocks.length);
  if (LEVEL >= 3) {
    let ahead = 0;
    let behind = 0;
    for (const s of blockSamples) {
      if (!s.quarry) continue;
      const sp = Math.hypot(s.quarry.vx, s.quarry.vz);
      if (sp < 4) continue;
      for (const b of s.blocks) {
        if (b.age > 3) continue;                      // judge it when it is BUILT
        const dot = ((b.x - s.quarry.x) * s.quarry.vx + (b.z - s.quarry.z) * s.quarry.vz) / sp;
        if (dot > 0) ahead++; else behind++;
      }
    }
    check('roadblocks are built ahead, not behind', behind === 0 || ahead > behind * 3,
      `${ahead} ahead / ${behind} behind`);
    check('roadblocks are built at all', blockSamples.length > 0,
      `${blockSamples.length} samples with a live block`);
  }

  /* --- the meter only falls out of sight ---------------------------- */
  let dropsWhileSeen = 0;
  for (let i = 1; i < all.length; i++) {
    if (all[i].level < all[i - 1].level && all[i - 1].seen && all[i].seen) dropsWhileSeen++;
  }
  check('wanted never decays while they can see you', dropsWhileSeen === 0,
    `${dropsWhileSeen} star drops with eyes on`);

  const heldLevel = all.filter((s) => s.seen).every((s) => s.level >= 1);
  check('wanted holds while hunted', heldLevel, `min level while seen ${
    Math.min(...all.filter((s) => s.seen).map((s) => s.level))}`);

  /* --- evasion works ------------------------------------------------ */
  const evStart = evade[0]?.level ?? 0;
  const evEnd = evade[evade.length - 1]?.level ?? 0;
  check('wanted decays once you break contact', evEnd < evStart,
    `${evStart}* -> ${evEnd}* over ${evade.length / HZ}s out of sight`);

  const searchMoved = evade.some((s) => s.cordon > 90);
  check('the search cordon grows while they hunt', searchMoved,
    `max cordon ${fmt(Math.max(...evade.map((s) => s.cordon)))} m`);

  /* --- respray ------------------------------------------------------ */
  check('respray clears heat instantly', respray.before === 4 && respray.after === 0,
    `${respray.before}* -> ${respray.after}*`);

  /* --- sanity ------------------------------------------------------- */
  const nan = all.some((s) => s.units.some((u) => !Number.isFinite(u.x + u.z + u.v)));
  check('no NaN in any unit transform', !nan);

  const overBudget = Math.max(...all.map((s) => s.units.filter((u) => u.role !== 'leave').length));
  check('fleet respects the budget cap', overBudget <= target,
    `peak ${overBudget} vs cap ${target}`);

  /* ---- report ------------------------------------------------------ */
  const summary = {
    seconds: SECONDS,
    level: LEVEL,
    samples: all.length,
    maxUnits,
    nearestMedianEarly: +fmt(early),
    nearestMedianLate: +fmt(settled),
    closestEver: +fmt(everClose),
    closestPair: +fmt(worstPair),
    roles: [...roleSet],
    blocks: Math.max(0, ...all.concat(evade).map((s) => s.blocks.length)),
    spiked: Math.max(0, ...all.concat(evade).map((s) => s.spiked)),
    officers: Math.max(0, ...all.concat(evade).map((s) => s.officers)),
    heli: all.concat(evade).some((s) => s.heli),
    failures: fails,
    checks: results,
  };
  console.log(`\n${JSON.stringify(summary, null, 2)}`);
  if (args.json) writeFileSync(String(args.json), JSON.stringify({ summary, trace: all, evade }, null, 1));
} catch (err) {
  console.error('HARNESS ERROR', err);
  console.error(errors.slice(-8).join('\n'));
  fails++;
} finally {
  await browser.close();
  server?.kill();
}

console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
process.exit(Math.min(120, fails));

/* ====================================================================== */

function pump(p, frames) {
  return p.evaluate(
    (n) => new Promise((done) => {
      let i = 0;
      const tick = () => (++i >= n ? done(true) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    }),
    frames
  );
}

/** Sample `police.sample()` at `hz` for `seconds` of wall clock. */
async function record(p, seconds, hz) {
  const out = [];
  const steps = Math.round(seconds * hz);
  for (let i = 0; i < steps; i++) {
    out.push(await p.evaluate(() => {
      const pol = window.__ENGINE__.ctx.peek('police');
      return JSON.parse(JSON.stringify(pol.sample()));
    }));
    await pump(p, Math.round(60 / hz));
  }
  return out;
}

function minDist(s) {
  if (!s.quarry) return Infinity;
  let best = Infinity;
  for (const u of s.units) {
    if (u.role === 'leave') continue;
    const d = Math.hypot(u.x - s.quarry.x, u.z - s.quarry.z);
    if (d < best) best = d;
  }
  return best;
}

function minPair(s) {
  let best = Infinity;
  for (let i = 0; i < s.units.length; i++) {
    for (let j = i + 1; j < s.units.length; j++) {
      const d = Math.hypot(s.units[i].x - s.units[j].x, s.units[i].z - s.units[j].z);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Longest run of consecutive samples in which one unit never moved. */
function longestFrozen(trace) {
  const runs = new Map();
  let worst = 0;
  for (const s of trace) {
    const seen = new Set();
    for (const u of s.units) {
      if (u.role === 'block' || u.role === 'leave') continue;
      seen.add(u.id);
      const r = runs.get(u.id) ?? { n: 0 };
      if (Math.abs(u.v) < 0.5) r.n++;
      else r.n = 0;
      runs.set(u.id, r);
      worst = Math.max(worst, r.n);
    }
    for (const id of runs.keys()) if (!seen.has(id)) runs.delete(id);
  }
  return worst / HZ;
}

function median(a) {
  const b = a.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!b.length) return Infinity;
  return b[b.length >> 1];
}

function fmt(v) {
  return Number.isFinite(v) ? v.toFixed(1) : 'inf';
}
