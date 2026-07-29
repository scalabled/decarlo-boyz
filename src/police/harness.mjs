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
/**
 * Keep the STACK, not just the message. A page error that says
 * `Cannot read properties of null (reading 'position')` names neither the file
 * nor the line, and the two crashes this suite has caught so far (`unit.js`
 * `_ram` on a foot cop, `officer.js` on a recycled ped) each cost an
 * investigation that the top stack frame would have ended in one line.
 */
const stacks = [];
const noteStack = (s) => {
  const top = String(s ?? '').split('\n').slice(0, 4).join('\n    ');
  if (top && !stacks.includes(top)) {
    stacks.push(top);
    console.log(`PAGEERROR STACK\n    ${top}`);
  }
};
page.on('pageerror', (e) => { errors.push(String(e.message)); noteStack(e.stack ?? e.message); });
page.on('console', (m) => {
  if (m.type() === 'error') {
    errors.push(m.text());
    const loc = m.location?.();
    noteStack(loc ? `${m.text()}\n at ${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : m.text());
  }
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
  /**
   * `capture=1` IS THE DETERMINISM SWITCH, and this suite needs it more than
   * the pixel gate does.
   *
   * Without it `Engine` seeds `ctx.rng` from `Math.random()`, so every boot
   * generates a DIFFERENT CITY — different roads under the chase, different
   * junctions to intercept, a different place for the player to stand — and
   * `step()` advances on the wall clock, so how much simulation happens between
   * two round trips depends on machine load. Four consecutive runs of this file
   * on one unchanged build scored 2, 4, 6 and 9 failures, and the same check
   * read "closest cop 3.7 m" in one and "70.6 m" in the next. A gate that
   * reports a different verdict every run cannot be used to accept or reject a
   * change, which is the only thing a gate is for.
   *
   * `capture=1` fixes the engine seed AND pins the timestep to exactly 1/60
   * (src/dev/shots.js), so a pumped frame is a unit of SIMULATION rather than a
   * unit of wall clock. `q` is still ours: main.js only forces `ultra` when no
   * explicit quality is given.
   *
   * It is not bit-identical and does not claim to be — the engine still free-
   * runs its own rAF between the driver's round trips, so a few frames land
   * where they land. What it buys is the same CITY, the same chase, and the
   * same verdicts: two consecutive runs of the fixed build agreed on all 38
   * checks with the reported numbers within a few percent (runner 67 vs 68 m,
   * evade clock 32.8 vs 32.9 s), against 2/4/6/9 failures across four runs of
   * one unchanged build without it.
   */
  await page.goto(`http://127.0.0.1:${port}/?q=${QUALITY}&capture=1`, { waitUntil: 'domcontentloaded' });
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
  const jump = await page.evaluate(() => {
    const pol = window.__ENGINE__.ctx.peek('police');
    const r = pol._runners[0];
    if (!r?.vehicle) return { ok: false, reason: 'no runner' };
    const roads = pol.roads;
    const from = { x: r.vehicle.position.x, z: r.vehicle.position.z };
    // Widen the ring until the graph offers something. One legal pose 900-1400 m
    // away is not guaranteed on every map — and when the sample failed, the old
    // code returned silently, the runner never moved, and the evade phase
    // measured a chase that was still in contact while reporting it as a
    // wanted-decay failure.
    let s = null;
    for (const [lo, hi] of [[900, 1400], [600, 1800], [400, 2400]]) {
      s = roads.sampleSpawn(pol.rng, r.vehicle.position, lo, hi, (e) => !e.rail);
      if (s) break;
    }
    if (!s) return { ok: false, reason: 'no pose' };
    r.vehicle.setPose(
      { x: s.position.x, y: pol.groundAt(s.position.x, s.position.z, s.position.y + 20) + 0.6, z: s.position.z },
      s.yaw
    );
    r.vehicle.velocity.set(0, 0, 0);
    r.path.reset();
    r.hasSearchPt = false;
    pol._teleportedAt = window.__ENGINE__.time.elapsed;
    return {
      ok: true,
      dist: +Math.hypot(s.position.x - from.x, s.position.z - from.z).toFixed(0),
      nearestCop: +(pol.units.reduce((m, u) => (u.vehicle
        ? Math.min(m, Math.hypot(u.vehicle.position.x - s.position.x, u.vehicle.position.z - s.position.z))
        : m), Infinity)).toFixed(0),
    };
  });
  console.log(`runner teleported ${jump.ok ? `${jump.dist} m away, nearest cruiser ${jump.nearestCop} m` : `FAILED: ${jump.reason}`}`);
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
  /**
   * ...but first: DID THE TEST SUBJECT DRIVE?
   *
   * Every proximity assertion below is about closing on a moving car. When the
   * runner wedges — and it can, on a kerb or a lane the road mesh disagrees
   * with — the cops have a stationary target 200 m away that they are already
   * converging on slowly, and the suite reports "cops never got closer than
   * 70 m" as a pursuit failure. State the precondition separately so the next
   * reader is told which of the two things broke.
   */
  const runSpeeds = all.map((s) => Math.abs(s.runner?.v ?? 0));
  const runMoving = runSpeeds.filter((v) => v > 2).length / Math.max(1, runSpeeds.length);
  // Stated as GROUND COVERED, not as instantaneous speed: what the proximity
  // assertions need is a quarry that goes places, and a car that spends half
  // its samples braking for junctions in a grid still does. Teleports are
  // excluded by ignoring any single step over 60 m.
  let runDist = 0;
  let runEarly = 0;
  const earlyN = Math.floor(all.length * 0.25);
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1].runner;
    const b = all[i].runner;
    if (!a || !b) continue;
    const step = Math.hypot(b.x - a.x, b.z - a.z);
    if (step > 60) continue;                       // a teleport is not driving
    runDist += step;
    if (i <= earlyN) runEarly += step;
  }
  /**
   * Judged on the EARLY window, before the fleet arrives. Later in the run a
   * stationary runner is the correct outcome — at five stars eight cruisers ram
   * it, PIT it and box it in, and "the quarry stopped moving" is the pursuit
   * working. What this precondition is for is the other case: a runner that
   * never drove anywhere at all, which makes every proximity number below a
   * measurement of a parked car.
   */
  check('the runner actually drove', runEarly > 60,
    `covered ${runEarly.toFixed(0)} m in the first ${(earlyN / HZ).toFixed(0)}s, ` +
    `${runDist.toFixed(0)} m over the chase (moving in ${(runMoving * 100).toFixed(0)}% of ` +
    `samples, median ${fmt(median(runSpeeds))} m/s)`);

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
  check('no cop parked in the road mid-chase', frozen.seconds < 12,
    `longest continuous stall by one unit ${fmt(frozen.seconds)} s` +
    (frozen.why ? ` (unit ${frozen.id}: ${frozen.why})` : ''));

  /* --- roadblocks form AHEAD ---------------------------------------- */
  const blockSamples = all.concat(evade).filter((s) => s.blocks.length);
  if (LEVEL >= 3) {
    let ahead = 0;
    let behind = 0;
    for (const s of blockSamples) {
      if (!s.quarry) continue;
      const sp = Math.hypot(s.quarry.vx, s.quarry.vz);
      if (sp < 4) continue;
      /**
       * ...judged only while the police actually know where you are. A block is
       * sited on the BELIEF (`police.searchAnchor` and the last heading anybody
       * observed), so once contact is four seconds cold the question "is it
       * ahead of the quarry's true velocity" is asking the police to be
       * clairvoyant, which is the cheat this suite exists to catch rather than
       * a property to demand. While they have eyes on you the belief IS your
       * position, and this stays the strict test it was: predict backwards and
       * it goes red.
       */
      if (s.sinceSeen > 4) continue;
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
  // Print the evade clock beside the verdict: a meter that will not fall is
  // either being re-sighted (`seen`, and by whom) or being told where you are
  // by something that is not an observation at all.
  const evSeen = evade.filter((s) => s.seen).length;
  const evBy = {};
  for (const s of evade) if (s.seen) evBy[s.seenBy || '?'] = (evBy[s.seenBy || '?'] ?? 0) + 1;
  const evByStr = Object.entries(evBy).map(([k, n]) => `${k} x${n}`).join(', ') || 'nobody';
  // How far the runner stayed from the cordon it is trying to escape. A small
  // number means the search is sitting on top of it (the police cheating, or
  // the runner driving back into the cordon), and either way the star count
  // was never going to fall.
  const evAway = median(evade.map((s) => (s.quarry
    ? Math.hypot(s.quarry.x - s.knownX, s.quarry.z - s.knownZ) : 0)));
  // ...and WHERE the first re-acquisition came from. A cruiser that drove a
  // kilometre to a place nobody told it about is a different bug from one that
  // was standing on the road the runner happened to arrive on.
  // Crimes reported DURING the escape: each one is heat, and a witnessed one
  // also relocates the search and resets the clock, so a check that says the
  // meter would not fall has to say whether anything was topping it up.
  const evCrimes = [];
  for (let i = 1; i < evade.length; i++) {
    if (evade[i].crimes > evade[i - 1].crimes) evCrimes.push(evade[i].lastCrime || '?');
  }
  let firstSeen = 'never re-sighted';
  for (let i = 0; i < evade.length; i++) {
    const s = evade[i];
    if (!s.seen || !s.quarry) continue;
    const u = s.units.find((x) => x.los) ?? null;
    firstSeen = `first re-sight at ${(i / HZ).toFixed(1)}s by ${s.seenBy || '?'}` +
      (u ? ` (unit ${u.id} ${u.role}, ${fmt(Math.hypot(u.x - s.quarry.x, u.z - s.quarry.z))} m from the ` +
        `runner and ${fmt(Math.hypot(u.x - s.knownX, u.z - s.knownZ))} m from the search centre)` : '');
    break;
  }
  // The phase is only meaningful if the runner actually left. Assert the setup,
  // so a failed teleport reads as a broken test rather than as a police bug.
  check('the evasion phase actually broke contact', jump.ok && jump.dist > 400,
    jump.ok ? `runner jumped ${jump.dist} m` : `teleport failed: ${jump.reason}`);
  /**
   * MEASURED ON THE LOWEST STAR THE METER REACHED, not on the level at the
   * final sample.
   *
   * The promise is "break contact and stay out of the cordon for `evadeNeed`
   * seconds and you lose a star". The final level answers a different question,
   * because the runner is an AI driving a city at speed for 46 s and it commits
   * fresh crimes while it escapes — clipping a parked car is worth heat whether
   * or not anybody could have told them where you are. One run demoted 5* -> 4*
   * on schedule at 33 s and was back at five before the window closed, which is
   * the meter working correctly in both directions and would have been recorded
   * as "the player cannot escape the police". The detail line still prints the
   * re-sight count and who did the sighting, so the failure this check exists
   * to catch — the meter pinned because the police never actually lost you —
   * still reads straight off it.
   */
  const evMin = Math.min(...evade.map((s) => s.level));
  check('wanted decays once you break contact', evMin < evStart,
    `${evStart}* -> ${evMin}* (ended ${evEnd}*) over ${evade.length / HZ}s out of sight ` +
    `(re-sighted in ${evSeen}/${evade.length} samples by ${evByStr}, median ${fmt(evAway)} m ` +
    `from the search centre, evade clock peaked ${fmt(Math.max(0, ...evade.map((s) => s.evade)))}s; ` +
    `${firstSeen}; crimes during the escape: ${evCrimes.join(',') || 'none'})`);

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

  /* ================================================================== */
  /* PHASE 4 — combat: gunfire, crooked cops, the ram, the arrest       */
  /*                                                                    */
  /* Rule-12 discipline: every assertion below reads EMITTED state — the */
  /* player's own health pool, events observed on the bus, a vehicle's   */
  /* health as `vehicles` keeps it — never the numbers police fed in.    */
  /* Each positive has a negative control that flips a kill-switch and   */
  /* proves the assertion CAN fail.                                      */
  /* ================================================================== */

  const staging = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    const player = e.ctx.peek('player');
    // The crew returns fire on police — two brothers executing every test
    // subject would make this suite measure the crew, not the cops.
    e.ctx.peek('peds')?.despawnCrew?.();
    pol.clearWanted('harness');

    /* ---- put the fight IN THE OPEN, which is what 4a claims to measure ----
     * The city is regenerated from a fresh seed on every boot, so where the
     * player boots is not a fixed place: on some seeds he stands inside one of
     * `game`'s free-roam service rings (a safehouse heals 24 HP/s, the body
     * shop 14) and no amount of officer fire can win against that. One run
     * measured the player GAINING 30 HP under sustained fire and reported it as
     * a police failure. Move him onto a lane first; the negative control below
     * now also proves nothing is topping him up.
     */
    /* ...and IN THE OPEN literally, not just on a lane. A pose under an
     * overpass, in a yard or between two long facades is a legal lane pose that
     * no officer can shoot from: one run staged there and reported 3 officers
     * spawned, 0 with a clear sightline, 0 shots — a measurement of masonry.
     * Score candidates by how many bearings at 15 m can actually see the spot
     * and take the best of ten. */
    const moved = { ok: false, clear: 0 };
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    let best = null;
    for (let i = 0; i < 10; i++) {
      const s = pol.roads?.sampleSpawn?.(pol.rng, player.position, 90, 260, (ed) => !ed.rail);
      if (!s) break;
      const py = pol.groundAt(s.position.x, s.position.z, s.position.y + 20);
      b.x = s.position.x; b.y = py + 1.0; b.z = s.position.z;
      let clear = 0;
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2;
        a.x = b.x + Math.sin(ang) * 15;
        a.z = b.z + Math.cos(ang) * 15;
        a.y = pol.groundAt(a.x, a.z, b.y + 8) + 0.6;
        if (pol.rayVisible(a, b, 0.5)) clear++;
      }
      if (!best || clear > best.clear) best = { x: b.x, y: py, z: b.z, yaw: s.yaw, clear };
      if (clear >= 6) break;
    }
    if (best && player.teleport) {
      player.teleport({ x: best.x, y: best.y + 1.7, z: best.z }, best.yaw);
      moved.ok = true;
      moved.clear = best.clear;
      moved.x = +best.x.toFixed(1);
      moved.z = +best.z.toFixed(1);
    }

    // Park the camera over the player so streaming, collision and the spawn
    // legality tests all happen where the fight will be.
    const p = player.position;
    e.ctx.camera.position.set(p.x + 14, p.y + 10, p.z + 14);
    e.ctx.camera.lookAt(p.x, p.y + 1, p.z);
    e.ctx.camera.updateMatrixWorld(true);
    const rec = (window.__COPREC = {
      tracers: 0, copShots: 0, shakes: 0, downs: [], taken: [], busted: 0,
    });
    e.ctx.events.on('bullet:tracer', () => rec.tracers++);
    e.ctx.events.on('weapon:fire', (ev) => { if (ev?.police) rec.copShots++; });
    e.ctx.events.on('camera:shake', () => rec.shakes++);
    e.ctx.events.on('police:officer:down', (ev) => rec.downs.push({ crooked: !!ev.crooked }));
    e.ctx.events.on('police:busted', () => rec.busted++);
    e.ctx.events.on('damage:taken', (ev) => {
      const pp = player.position;
      const d = ev?.from ? Math.hypot(ev.from.x - pp.x, ev.from.z - pp.z) : -1;
      rec.taken.push({ amount: +(ev?.amount ?? 0).toFixed(2), dist: +d.toFixed(1) });
    });
    return moved;
  });
  console.log(`combat staged ${staging.ok
    ? `on a lane at ${staging.x}, ${staging.z} (${staging.clear}/8 bearings can see it)`
    : 'AT THE BOOT POSE (no lane found)'}`);
  await page.waitForFunction(
    () => window.__ENGINE__.ctx.peek('world').streamingIdle(),
    null, { timeout: 90000 }
  ).catch(() => {});

  /* ---- 4a: at three stars, officers shoot and the player bleeds ----- */
  const rangedSetup = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    const player = e.ctx.peek('player');
    const rec = window.__COPREC;
    // Start FULL, not at 100. Three established shooters land ~110 HP over the
    // window, and a player who dies mid-test is teleported to a safehouse and
    // restored by `game`'s death/chapter-restart path — which is what turned a
    // clean kill into a reported "+30 hp under fire".
    player.health.hp = player.health.max;
    rec.snap = { hp: player.health.hp, tracers: rec.tracers, shots: rec.copShots, taken: rec.taken.length };
    pol.setWanted(3);
    let made = 0;
    const placed = [];
    for (let i = 0; i < 8 && made < 3; i++) {
      const r = pol.spawnCop(false, { minDist: 12, maxDist: 44 });
      if (r) { made++; placed.push(r.officer); }
    }
    /* Stage the shooters onto a ring so the 25 s window measures FIRE, not
     * walking speed — the same direct placement `debugStage('busted')` uses.
     * The spawn path itself was just exercised above.
     *
     * Each one is placed on the first bearing with a CLEAR SIGHTLINE to the
     * player. Dropping them on fixed bearings put officers inside buildings and
     * behind walls, where `_combat` correctly refuses to shoot through
     * masonry — so the test measured occlusion and reported it as rate of fire.
     */
    const p = player.position;
    let clear = 0;
    for (let k = 0; k < placed.length; k++) {
      const o = placed[k];
      const base = (k / Math.max(1, placed.length)) * Math.PI * 2 + 0.6;
      let best = null;
      for (let t = 0; t < 16 && !best; t++) {
        const a = base + (t % 8) * (Math.PI / 4) * 0.25 * (t & 8 ? -1 : 1);
        const r = t < 8 ? 15 : 10;
        const x = p.x + Math.sin(a) * r;
        const z = p.z + Math.cos(a) * r;
        const y = pol.groundAt(x, z, p.y + 6);
        o.ped.position.set(x, y, z);
        if (pol.rayVisible(o.ped.position, p, 1.15)) best = { x, y, z };
      }
      const at = best ?? { x: p.x + Math.sin(base) * 15, y: p.y, z: p.z + Math.cos(base) * 15 };
      if (best) clear++;
      o.ped.position.set(at.x, at.y, at.z);
      o.ped.groundY = o.ped.position.y;
    }
    return { made, clear, hp0: player.health.hp };
  });
  await pump(page, 25 * 60);
  const ranged = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const player = e.ctx.peek('player');
    const rec = window.__COPREC;
    const taken = rec.taken.slice(rec.snap.taken);
    return {
      hp: player.health.hp,
      hpDrop: +(rec.snap.hp - player.health.hp).toFixed(1),
      applied: +taken.filter((t) => t.dist > 6).reduce((s, t) => s + t.amount, 0).toFixed(1),
      tracers: rec.tracers - rec.snap.tracers,
      copShots: rec.copShots - rec.snap.shots,
      rangedHits: taken.filter((t) => t.dist > 6).length,
      maxHit: Math.max(0, ...taken.map((t) => t.amount)),
      died: !!player.health.dead || player.health.hp > rec.snap.hp,
    };
  });
  check('foot cops spawn on demand at three stars', rangedSetup.made >= 1,
    `${rangedSetup.made} spawned, ${rangedSetup.clear} with a clear sightline`);
  /**
   * STATED AS DAMAGE THE PLAYER'S OWN POOL ABSORBED, not as a net HP delta.
   *
   * The net delta is not a measurement of officer fire: it is a measurement of
   * officer fire PLUS everything else that touches the pool over 25 s, and the
   * things that touch it are large. `game` heals 24 HP/s inside a safehouse
   * ring, and its death path restores the player to FULL and teleports him
   * home — so the run where three officers shot the player to death reported
   * `+30 hp` and failed. `damage:taken` is emitted by the PLAYER when it
   * applies a round (after armour), which is a different number from the one
   * police handed it, and it survives a respawn.
   */
  check('officer fire takes real HP off the player (wanted 3, in the open)',
    ranged.applied >= 6,
    `${fmt(ranged.applied)} hp applied from range in 25 s ` +
    `(pool ${fmt(rangedSetup.hp0)} -> ${fmt(ranged.hp)}${ranged.died ? ', player died and was restored' : ''})`);
  check('the damage is RANGED, not contact', ranged.rangedHits > 0,
    `${ranged.rangedHits} hits arrived from >6 m away`);
  check('officer fire is visible and audible (weapon:fire + tracer)',
    ranged.copShots > 0 && ranged.tracers > 0,
    `${ranged.copShots} police muzzle events, ${ranged.tracers} tracers`);
  check('no single round beats the 45% single-impact cap', ranged.maxHit <= 45.01,
    `worst hit ${fmt(ranged.maxHit)} hp`);

  /* ---- 4b: negative control — fire kill-switch really kills it ------ */
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    const player = e.ctx.peek('player');
    const rec = window.__COPREC;
    pol.clearWanted('harness');
    player.health.hp = 100;
    pol.fireEnabled = false;
    rec.snap = { hp: player.health.hp, shots: rec.copShots, taken: rec.taken.length };
    pol.setWanted(3);
    for (let i = 0; i < 6; i++) pol.spawnCop(false, { minDist: 12, maxDist: 34 });
  });
  await pump(page, 12 * 60);
  const noFire = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    const player = e.ctx.peek('player');
    const rec = window.__COPREC;
    const taken = rec.taken.slice(rec.snap.taken);
    const out = {
      hpDrop: +(rec.snap.hp - player.health.hp).toFixed(1),
      applied: +taken.filter((t) => t.dist > 6).reduce((s, t) => s + t.amount, 0).toFixed(1),
      copShots: rec.copShots - rec.snap.shots,
    };
    pol.fireEnabled = true;
    pol.clearWanted('harness');
    player.health.hp = 100;
    return out;
  });
  // Same six officers, same window, same measurement as the positive above —
  // one flag apart. Stated in applied damage rather than in HP for the same
  // reason: what is being controlled for is police rounds landing, and the pool
  // has other things happening to it.
  check('NEGATIVE: fireEnabled=false stops all officer fire',
    noFire.copShots === 0 && noFire.applied === 0,
    `${noFire.copShots} shots, ${fmt(noFire.applied)} hp applied from range`);

  /* ---- 4c: a crooked cop dies for free ------------------------------ */
  const crooked = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    const rec = window.__COPREC;
    rec.snap = { downs: rec.downs.length, heat: pol.meter.heat, wanted: pol.wanted };
    const r = pol.spawnCop(true, { minDist: 10, maxDist: 34 });
    if (!r) return { ok: false };
    // Kill through the canonical path: `peds`' own damage listener applies it,
    // the ragdoll death emits actor:death, the pool reports the down.
    e.ctx.events.emit('damage:dealt', {
      target: r.ped, amount: 600, headshot: false, killed: false, point: r.ped.position,
    });
    return { ok: true, crooked: r.crooked };
  });
  await pump(page, 3 * 60);
  const crookedAfter = await page.evaluate(() => {
    const pol = window.__ENGINE__.ctx.peek('police');
    const rec = window.__COPREC;
    return {
      wanted: pol.wanted,
      heat: +pol.meter.heat.toFixed(1),
      heatDelta: +(pol.meter.heat - rec.snap.heat).toFixed(1),
      downs: rec.downs.slice(rec.snap.downs),
    };
  });
  check('spawnCop(true) spawns a crooked cop', crooked.ok === true && crooked.crooked === true);
  check('killing a crooked cop emits police:officer:down {crooked:true}',
    crookedAfter.downs.length === 1 && crookedAfter.downs[0].crooked === true,
    JSON.stringify(crookedAfter.downs));
  check('killing a crooked cop raises NO wanted heat',
    crookedAfter.wanted === 0 && crookedAfter.heatDelta <= 0.01,
    `wanted ${crookedAfter.wanted}, heat +${crookedAfter.heatDelta}`);

  /* ---- 4d: negative control — a REAL cop's death is expensive ------- */
  const straight = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    const rec = window.__COPREC;
    rec.snap = { downs: rec.downs.length };
    const r = pol.spawnCop(false, { minDist: 10, maxDist: 34, force: true });
    if (!r) return { ok: false };
    e.ctx.events.emit('damage:dealt', {
      target: r.ped, amount: 600, headshot: false, killed: false, point: r.ped.position,
    });
    return { ok: true };
  });
  await pump(page, 3 * 60);
  const straightAfter = await page.evaluate(() => {
    const pol = window.__ENGINE__.ctx.peek('police');
    const rec = window.__COPREC;
    const out = {
      wanted: pol.wanted,
      downs: rec.downs.slice(rec.snap.downs),
    };
    pol.clearWanted('harness');
    return out;
  });
  check('NEGATIVE: killing a straight cop still prices killCop',
    straight.ok && straightAfter.wanted >= 3,
    `wanted ${straightAfter.wanted} after the kill`);
  check('straight cop death still emits police:officer:down {crooked:false}',
    straightAfter.downs.length === 1 && straightAfter.downs[0].crooked === false,
    JSON.stringify(straightAfter.downs));

  /* ---- 4e/4f: the scripted ram, with its own negative control ------- */
  const ramRun = async (enabled) => {
    const setup = await page.evaluate((on) => {
      const e = window.__ENGINE__;
      const pol = e.ctx.peek('police');
      const veh = e.ctx.peek('vehicles');
      const rec = window.__COPREC;
      pol.clearWanted('harness');
      pol.ramEnabled = on;
      const cam = e.ctx.camera.position;
      const s = pol.roads.sampleSpawn(pol.rng, { x: cam.x, z: cam.z }, 25, 90,
        (ed) => !ed.rail && ed.len > 40);
      if (!s) return { ok: false, reason: 'no road' };
      const pos = pol.meter.known.clone();       // any Vector3 to borrow
      const sx = s.position.x;
      const sz = s.position.z;
      pos.set(sx, pol.groundAt(sx, sz, s.position.y + 20) + veh.specOf('muscle').comY + 0.03, sz);
      const sedan = veh.spawn('muscle', pos, s.yaw, { rng: pol.rng });
      if (!sedan) return { ok: false, reason: 'sedan spawn' };
      const bx = sx - Math.sin(s.yaw) * 26;
      const bz = sz - Math.cos(s.yaw) * 26;
      pos.set(bx, pol.groundAt(bx, bz, s.position.y + 20) + veh.specOf('police').comY + 0.03, bz);
      const cruiser = veh.spawn('police', pos, s.yaw, { rng: pol.rng });
      if (!cruiser) { veh.despawn(sedan); return { ok: false, reason: 'cruiser spawn' }; }
      pol.setQuarry({ vehicle: sedan });
      pol.quarry.refresh(pol, 0);
      // FIVE stars, because that is the level at which ramming is the designed
      // behaviour (TUNE.ramFromLevel). Below it the driver is deliberately
      // trying NOT to hit you: the quarry is still an obstacle to brake for
      // (`_obstacles`) and `closein` caps the approach at quarry speed + 1.5,
      // so whether contact happens at all comes down to whether the shove
      // breaker fires first. Staged at two stars this test was a coin toss —
      // one run measured 518 HP of ram damage and the next measured zero.
      pol.setWanted(5);
      // Isolate: this test measures ONE cruiser's ram, not the dispatcher.
      pol.dispatch._timer = 1e9;
      pol.dispatch._footTimer = 1e9;
      const u = pol.takeUnit();
      u.bind(cruiser, 'chase');
      u.los = true;
      window.__RAMTEST = { sedan, cruiser, unit: u };
      rec.snap = { hp: sedan.health, shakes: rec.shakes };
      return { ok: true, hp0: sedan.health };
    }, enabled);
    if (!setup.ok) return { ok: false, reason: setup.reason };
    await pump(page, 18 * 60);
    return page.evaluate(() => {
      const e = window.__ENGINE__;
      const pol = e.ctx.peek('police');
      const veh = e.ctx.peek('vehicles');
      const rec = window.__COPREC;
      const t = window.__RAMTEST;
      const out = {
        ok: true,
        drop: +(rec.snap.hp - t.sedan.health).toFixed(1),
        shakes: rec.shakes - rec.snap.shakes,
        destroyed: !!t.sedan.destroyed,
      };
      pol.retireUnit(t.unit, 'far');
      veh.despawn(t.sedan);
      pol.setQuarry(null);
      pol.clearWanted('harness');
      pol.ramEnabled = true;
      window.__RAMTEST = null;
      return out;
    });
  };
  const ramOn = await ramRun(true);
  const ramOff = await ramRun(false);
  check('cruiser contact rams the quarry vehicle (damage + camera:shake)',
    ramOn.ok && ramOn.shakes >= 1 && ramOn.drop >= 60,
    `-${fmt(ramOn.drop)} hp, ${ramOn.shakes} shakes in 18 s`);
  check('NEGATIVE: ramEnabled=false leaves only physics damage',
    ramOff.ok && ramOff.shakes === 0 && ramOn.drop > ramOff.drop + 50,
    `on -${fmt(ramOn.drop)} vs off -${fmt(ramOff.drop)} hp, ${ramOff.shakes} shakes`);

  /* ---- 4g: the arrest still works at low stars, guns holstered ------ */
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    const player = e.ctx.peek('player');
    const rec = window.__COPREC;
    pol.clearWanted('harness');
    player.health.hp = 100;
    rec.snap = { hp: player.health.hp, shots: rec.copShots, busted: rec.busted, taken: rec.taken.length };
    pol.setWanted(1);
    pol.dispatch._timer = 1e9;
    pol.dispatch._footTimer = 1e9;
    // 12-40 m, not 10-26: `_footPose` rejects a pose inside the camera cone
    // nearer than 60 m unless it is genuinely occluded — the pop-in rule, and
    // it is right — so a tight ring around a player the camera is looking
    // straight at can legitimately find nowhere legal to stand and `spawnCop`
    // correctly returns null. Measured as "0 busts from 0 officers". They walk
    // in from 40 m in about ten seconds; the window is sixty.
    let made = 0;
    for (let i = 0; i < 10 && made < 2; i++) {
      if (pol.spawnCop(false, { minDist: 12, maxDist: 40 })) made++;
    }
    rec.arrestSpawned = made;
  });
  await page.waitForFunction(
    () => window.__COPREC.busted > window.__COPREC.snap.busted,
    null, { timeout: 60000 }
  ).catch(() => {});
  const arrest = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    const player = e.ctx.peek('player');
    const rec = window.__COPREC;
    const taken = rec.taken.slice(rec.snap.taken);
    return {
      spawned: rec.arrestSpawned,
      busted: rec.busted - rec.snap.busted,
      wanted: pol.wanted,
      hpDrop: +(rec.snap.hp - player.health.hp).toFixed(1),
      shots: rec.copShots - rec.snap.shots,
      rangedHits: taken.filter((t) => t.dist > 6).length,
      contactHits: taken.filter((t) => t.dist >= 0 && t.dist <= 6).length,
    };
  });
  check('an officer still arrests at one star', arrest.spawned >= 1 && arrest.busted >= 1 && arrest.wanted === 0,
    `${arrest.busted} busts from ${arrest.spawned} officers, wanted ${arrest.wanted}`);
  /**
   * The promise is "the cuffs, not the gun" — an arrest team does not SHOOT the
   * man it is cuffing, which is the thing that would otherwise make one star
   * lethal. It is not "nobody lays a hand on you": `peds`' own fight state,
   * which is what an officer closing to arrest range rides on, lands 7 HP
   * punches inside 2.2 m, and that scuffle is the arrest. So the control is
   * stated in the terms that separate the two — zero muzzle events and zero
   * damage arriving from beyond contact range — rather than as an HP threshold,
   * which cannot tell a punch from a bullet.
   */
  check('NEGATIVE: the arrest team held fire', arrest.shots === 0 && arrest.rangedHits === 0,
    `${arrest.shots} shots, ${arrest.rangedHits} hits from >6 m, ${arrest.contactHits} at contact ` +
    `(-${arrest.hpDrop} hp)`);

  check('no page errors after combat phases', errors.length === 0,
    errors.slice(-3).join(' | ') || 'none');

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
    seenFracChase: +(all.filter((s) => s.seen).length / Math.max(1, all.length)).toFixed(2),
    seenFracEvade: +(evade.filter((s) => s.seen).length / Math.max(1, evade.length)).toFixed(2),
    stall: frozen,
    blocks: Math.max(0, ...all.concat(evade).map((s) => s.blocks.length)),
    spiked: Math.max(0, ...all.concat(evade).map((s) => s.spiked)),
    officers: Math.max(0, ...all.concat(evade).map((s) => s.officers)),
    heli: all.concat(evade).some((s) => s.heli),
    combat: { ranged, noFire, crooked: crookedAfter, ramOn, ramOff, arrest },
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

/**
 * Longest run of consecutive samples in which one unit never moved, plus WHAT
 * IT SAID IT WAS DOING while it sat there. The bare number says a cop is parked
 * in the road; the role/mode/reason histogram says whether it is wedged against
 * a kerb, holding an intercept it should have abandoned, or braking for an
 * obstacle that will never move — which are three different bugs.
 */
function longestFrozen(trace) {
  const runs = new Map();
  let worst = { n: 0, id: -1, why: [] };
  for (const s of trace) {
    const seen = new Set();
    for (const u of s.units) {
      if (u.role === 'block' || u.role === 'leave') continue;
      seen.add(u.id);
      const r = runs.get(u.id) ?? { n: 0, why: [] };
      if (Math.abs(u.v) < 0.5) {
        r.n++;
        const tag = `${u.role}/${u.mode}/${u.reason}`;
        if (r.why[r.why.length - 1] !== tag) r.why.push(tag);
      } else {
        r.n = 0;
        r.why.length = 0;
      }
      runs.set(u.id, r);
      if (r.n > worst.n) worst = { n: r.n, id: u.id, why: r.why.slice(0, 6) };
    }
    for (const id of runs.keys()) if (!seen.has(id)) runs.delete(id);
  }
  return { seconds: worst.n / HZ, id: worst.id, why: worst.why.join(' -> ') };
}

function median(a) {
  const b = a.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!b.length) return Infinity;
  return b[b.length >> 1];
}

function fmt(v) {
  return Number.isFinite(v) ? v.toFixed(1) : 'inf';
}
