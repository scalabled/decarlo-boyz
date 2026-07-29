#!/usr/bin/env node
/**
 * PEDS — THE CREW: headless behaviour harness.
 *
 * A still frame cannot tell you that a brother trails at five metres, that he
 * deals seven damage every second and a half, or that he picks himself up eight
 * seconds after he goes down. Those are the numbers the feature IS, so they get
 * asserted in a real browser running the real engine, against the real sidewalk
 * network, the real ragdoll solver and the real `game` hostile pool.
 *
 * Every timing assertion measures `engine.time.elapsed`, not frame counts: the
 * page runs free and a frame is whatever the GPU gave us that instant.
 *
 *   node src/peds/crewtest.mjs
 *   node src/peds/crewtest.mjs --json
 *   node src/peds/crewtest.mjs --only=follow,damage
 *   node src/peds/crewtest.mjs --png=/tmp/crew.png     # LOOK at them
 *
 * `--png` is not a staged tableau: it settles a normal street, asks
 * `crewState()` where the two brothers actually ended up, and points the camera
 * at that. If they are not in the frame, they were not there.
 */

import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const JSON_OUT = !!args.json;
const ONLY = typeof args.only === 'string' ? args.only.split(',').map((s) => s.trim()) : null;
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

const results = [];
let group = '';
const rec = (name, ok, detail) => {
  results.push({ group, name, ok: !!ok, detail: String(detail ?? '') });
  if (!JSON_OUT) log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail ?? ''}`);
};

/* ===================================================================== */

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const pageErrors = [];
let errFlood = 0;
page.on('pageerror', (e) => { errFlood++; if (pageErrors.length < 40) pageErrors.push(String(e.message).slice(0, 240)); });
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  errFlood++;
  if (pageErrors.length < 40) pageErrors.push(m.text().slice(0, 240));
});

const Q = typeof args.q === 'string' ? args.q : 'low';
await page.goto(`http://127.0.0.1:${port}/?q=${Q}&prewarm=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__READY__===true', null, { timeout: 90000 });
await page.waitForFunction('window.__SETTLED__ ? window.__SETTLED__() : true', null, { timeout: 90000 });

const pump = (n = 1) => page.evaluate((k) => window.__PUMP__(k), n);

/** Run `src` inside the page with the systems bound. */
const run = (src, arg = null) =>
  page.evaluate(
    ({ s, a }) => {
      const engine = window.__ENGINE__;
      const ctx = engine.ctx;
      // eslint-disable-next-line no-new-func
      const f = new Function('engine', 'ctx', 'peds', 'crew', 'player', 'game', 'ARG', s);
      return f(engine, ctx, ctx.peek('peds'), ctx.peek('peds')?.crew, ctx.peek('player'), ctx.peek('game'), a);
    },
    { s: src, a: arg }
  );

/** Advance the simulation by `sec` seconds of engine time, sampling as we go. */
async function advance(sec, sampleSrc = null, hz = 4) {
  const t0 = await run('return engine.time.elapsed;');
  const samples = [];
  const step = Math.max(4, Math.round(60 / hz));
  for (let guard = 0; guard < 4000; guard++) {
    await pump(step);
    if (sampleSrc) samples.push(await run(sampleSrc));
    const t = await run('return engine.time.elapsed;');
    if (t - t0 >= sec) return { dt: t - t0, samples };
  }
  return { dt: (await run('return engine.time.elapsed;')) - t0, samples };
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/**
 * Wait for the city to arrive. Teleporting the player two hundred metres and
 * walking immediately is how the SOLO arm of the spacing A/B covered 0 m
 * against the crew arm's 193: `world` keeps triangle collision within 320 m of
 * the CAMERA, so a capsule dropped where the tiles have not streamed yet has
 * only the coarse clip shell under it and spends the first seconds settling
 * rather than walking. `streamingIdle()` is the engine's own answer to "is the
 * ground here yet" — `tools/capture.mjs` gates the shutter on it for the same
 * reason.
 */
const settle = async (maxSec = 8) => {
  for (let i = 0; i < 10; i++) {
    await advance(0.8);
    const idle = await run('const w = ctx.peek("world"); return w?.streamingIdle ? !!w.streamingIdle() : true;');
    if (idle && i >= 1) return true;
    if ((i + 1) * 0.8 >= maxSec) break;
  }
  return false;
};

/**
 * A DETERMINISTIC STAGE, and the reason the staged groups need one.
 *
 * `spacing`, `cars` and `stranded` all build a scenario around wherever the
 * player happens to be. Run in isolation that is the spawn point; run in the
 * full suite it is wherever the previous group left him — so the same three
 * gates scored 25 m / -0.29 m / 62 m alone and 42 m / -0.93 m / 3 m together.
 * Every one of those numbers was honest about a DIFFERENT street.
 *
 * So each of them starts here: THE GAME'S OWN SPAWN POSE, captured once before
 * any group runs, snapped to the nearest lane centre by the road graph. Same
 * street, same junction spacing, same parked cars, every run — which is what
 * makes a RATCHET on any of them mean something.
 *
 * A hardcoded world coordinate from DESIGN.md was tried first and was worse:
 * (632,-464) is the body shop, the road graph snapped it to an arterial 25 m
 * away, and the player could not walk a single metre from where it put him.
 * The spawn point is the one place in the map the game itself guarantees is
 * stand-up-able, and it costs nothing to ask.
 */
const STAGE_XZ = { x: 0, z: 0 };
/**
 * AND IT VALIDATES ITSELF. Snapping to a lane centre is not enough: the same
 * fixed query point snapped to a spot the player could walk 189 m from on one
 * run and 5 m from on the next, because the spawn pose is not identical across
 * runs and the lane parameter lands against a railing or a shopfront a metre
 * either side. Every downstream number was then honest about a wall.
 *
 * So the stage is TRIED: teleport, hold full stick for a second, and keep the
 * first candidate the player can actually walk away from. It returns which one
 * it used, so a report can say where the numbers came from.
 */
const stageAt = async (dx = 0, dz = 0) => {
  /**
   * A WIDE SEARCH, because some ground in this city cannot be walked on at all.
   *
   * Measured directly: teleported to (-20.4, 247.9) the player reports
   * `grounded: true` and `movement.state: "jog"` and translates 0.1 m in five
   * seconds of full stick — the state machine is jogging and the capsule is
   * not moving. `tools/playprobe.mjs` hits the same condition and reports
   * "W walks 0.01 m" on a build where W plainly works. It is an engine
   * condition in player/physics/world, it is position-dependent, and it is not
   * this directory's to fix — but it WILL silently poison any measurement
   * staged on top of it, and it has: a spacing A/B read "145 m with the crew,
   * 4 m alone" and scored the crew a 4200% mobility bonus.
   *
   * So: twelve candidates over four nearby lanes, first one that walks 12 m
   * wins, and `best.walk` is returned so callers can refuse to grade a run
   * that never found walkable ground.
   */
  const OFFS = [[0, 0], [30, 0], [0, 30], [-30, 0], [0, -30], [45, 45]];
  const T = [0.35, 0.6];
  const CAND = [];
  for (const [ox, oz] of OFFS) for (const t of T) CAND.push({ ox, oz, t });
  let best = null;
  for (let i = 0; i < CAND.length; i++) {
    const at = await run(`
      const w = ctx.peek('world');
      const gx = ARG.x, gz = ARG.z;
      const n = w?.roads?.nearestEdge?.(gx, gz);
      let a = null, b = null;
      if (n && n.edge) {
        a = w.roads.laneCenter(n.edge.id, n.lane ?? 0, ARG.t, { x: 0, y: 0, z: 0 });
        b = w.roads.laneCenter(n.edge.id, n.lane ?? 0, Math.min(0.98, ARG.t + 0.1), { x: 0, y: 0, z: 0 });
      }
      if (!a) { a = { x: gx, y: w.walkableHeightAt(gx, gz), z: gz }; b = { x: gx + 1, y: a.y, z: gz }; }
      const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));   // FACE down the road
      player.teleport({ x: a.x, y: a.y + 1.0, z: a.z }, yaw);
      player.rig.yaw = yaw;
      game.hostiles.clear();
      peds.spawnCrew();
      /* NO stick yet. Holding forward across the streaming settle below walked
         the probe 26 m into whatever was there, and the 4 s measurement then
         started AT the wall and scored 0 — for every candidate, so the "best"
         one was whichever noise won. Stand still until the ground exists. */
      player.movement.scriptedInput = null;
      return { x: +a.x.toFixed(1), y: +a.y.toFixed(1), z: +a.z.toFixed(1), yaw: +yaw.toFixed(3),
               kind: n?.edge?.kind ?? 'none', t: ARG.t };
    `, { x: STAGE_XZ.x + dx + CAND[i].ox, z: STAGE_XZ.z + dz + CAND[i].oz, t: CAND[i].t });
    await settle();
    await run(`
      window.__STAGE0__ = { x: player.position.x, z: player.position.z };
      player.rig.yaw = ARG;
      player.movement.scriptedInput = { x: 0, y: 1, sprint: false, walk: false, crouch: false };
      return true;
    `, at.yaw);
    /* Validate over the distance the tests actually need, not a token step.
       A 1.2 s probe covers 3 m and happily accepts a spot with a wall 4 m
       further on — which then read as "two brothers standing in the doorway
       stopped him dead, 0 m in 4 s". The doorway case and the car control both
       walk for 4 s, so the probe walks for 4 s. */
    await advance(4.2);
    const moved = await run(`
      const s = window.__STAGE0__;
      const p = player.position;
      player.movement.scriptedInput = null;
      return +Math.hypot(p.x - s.x, p.z - s.z).toFixed(2);
    `);
    at.walk = moved;
    at.tries = i + 1;
    if (!best || moved > best.walk) best = at;
    if (moved > 12) break;
    /* A candidate that clears 12 m is good enough and we stop; otherwise every
       one is tried and the LONGEST wins. The legs below need a corridor, not a
       doorstep — an earlier version accepted the first candidate over a 12 m
       bar measured across only 1.2 s, which cleared 3 m and then hit a wall at
       20, and read "195 m one run, 21 m the next". */
  }
  // settle back onto the winning candidate, standing still
  await run(`
    const w = ctx.peek('world');
    const y = w.walkableHeightAt(ARG.x, ARG.z);
    player.teleport({ x: ARG.x, y: y + 1.0, z: ARG.z }, ARG.yaw);
    player.rig.yaw = ARG.yaw;
    player.movement.scriptedInput = null;
    peds.spawnCrew();
    return true;
  `, best);
  await advance(3);
  return best;
};
const want = (g) => !ONLY || ONLY.includes(g);

/* ---- a clean, quiet stage ------------------------------------------- */
await run(`
  engine.input.enabled = false;
  window.__CREWTAP__ = { down: [], revive: [], line: [], board: [], exit: [], hurt: [], deaths: [] };
  const T = window.__CREWTAP__;
  engine.events.on('crew:down',   (e) => T.down.push({ ...e }));
  engine.events.on('crew:revive', (e) => T.revive.push({ ...e }));
  engine.events.on('crew:line',   (e) => T.line.push({ ...e, t: engine.time.elapsed }));
  engine.events.on('crew:board',  (e) => T.board.push({ count: e.count }));
  engine.events.on('crew:exit',   (e) => T.exit.push({ count: e.count }));
  engine.events.on('crew:hurt',   (e) => T.hurt.push({ ...e }));
  engine.events.on('actor:death', (e) => T.deaths.push(e?.actor?.isCrew === true));
  peds.spawnCrew();
  return true;
`);
await advance(2.5);

/* The spawn pose, captured BEFORE any group has moved him. Every staged group
   returns here — see `stageAt`. */
const SPAWN = await run('return { x: player.position.x, z: player.position.z };');
STAGE_XZ.x = SPAWN.x;
STAGE_XZ.z = SPAWN.z;

/** The numbers `crew.js` ships, mirrored here. */
const TUNING = { follow: 5, engage: 20, strike: 9, damage: 7, cycle: 1.5, revive: 8, guardHold: 2, board: 30 };

/* ===================================================================== */
/* 1 — the roster                                                        */
/* ===================================================================== */
if (want('roster')) {
  group = 'roster';
  log('\n--- roster ---------------------------------------------------------');
  const r = await run(`
    const active = peds.crew.activeBrother();
    const st = peds.crewState().map((s) => ({ id: s.id, up: s.up, hp: s.hp, maxHp: s.maxHp, d: +s.distance.toFixed(1) }));
    return {
      active,
      ids: st.map((s) => s.id),
      count: st.length,
      allUp: st.every((s) => s.up),
      bodies: peds.crew.members.filter((m) => m.ped && m.ped.body).length,
      state: st,
      budget: ctx.config.q.pedBudget,
      live: peds.stats.live,
      target: peds.stats.target,
    };
  `);
  rec('two brothers follow the player', r.count === 2, `${r.ids.join(' + ')} (playing ${r.active})`);
  rec('the crew is the two you are NOT playing', !r.ids.includes(r.active), `active=${r.active}`);
  // Not `hp === maxHp`: on a busy ultra street a passing car clips a brother
  // inside the first couple of seconds, which is the system working.
  rec('both are on their feet and healthy', r.allUp && r.state.every((s) => s.hp > s.maxHp * 0.5),
    r.state.map((s) => `${s.id} ${Math.round(s.hp)}/${s.maxHp}`).join(', '));
  rec('both hold a skinned body (never a capsule)', r.bodies === 2, `${r.bodies}/2 skinned`);
  /**
   * THE BUDGET CONTRACT, asserted as three separate claims because they are
   * three separate things and only the first two are the crew's business.
   *
   * `stats.live` is not the quantity to gate on: it counts everyone active,
   * INCLUDING the drivers `traffic` and `police` borrow through
   * `attachDriver()`, which is a documented overspend that has nothing to do
   * with companions. Gating on it made this line report "live 9 / budget 8"
   * on a busy street and "live 7 / budget 8" on a quiet one, for the same
   * build. What the crew owes the budget is exactly this:
   *
   *   1. the AMBIENT target shrinks by the crew size — two brothers are two
   *      fewer strangers, so a quality preset means what it says;
   *   2. the crew NEVER takes a slot from `peds.peds`, the pool that
   *      `attachDriver` draws from — so it can never starve `spawnCop`, which
   *      is the bug `police` had in the other direction;
   *   3. and it still gets its own skinned-body slots, so a brother is never
   *      demoted to a capsule. (Asserted above.)
   */
  const budget = await run(`
    const inAmbient = peds.crew.members.filter((m) => peds.peds.indexOf(m.ped) >= 0).length;
    return {
      target: peds.stats.target, budget: ctx.config.q.pedBudget,
      crew: peds.crew.members.length, inAmbient,
      poolIsSeparate: peds.crew.pool.every((p) => peds.peds.indexOf(p) < 0),
      ambientActive: peds.peds.filter((p) => p.active).length,
      maxBodies: peds.maxBodies, ambientBodies: peds.ambientBodies,
      hostileBodies: peds.maxBodies - peds.ambientBodies - 2,
      hostilePoolIsSeparate: peds.hostiles.pool.every((p) => peds.peds.indexOf(p) < 0),
    };
  `);
  rec('the crew is charged to the ped budget', budget.target <= budget.budget - budget.crew,
    `ambient target ${budget.target} <= ${budget.budget} - ${budget.crew} crew`);
  rec('the crew never borrows from the pool cops come from',
    budget.inAmbient === 0 && budget.poolIsSeparate,
    `${budget.inAmbient} brothers inside peds.peds (attachDriver draws from there); ` +
    `crew pool is separate: ${budget.poolIsSeparate}`);
  /**
   * The crew's two slots are ADDED to the ambient share, never taken out of it.
   * `hostile.js` now makes the same bargain on the same terms — its reservation
   * is the remainder — so the assertion is that the crowd's own share is
   * untouched by either, which is what "a brother is never demoted to make room
   * for a stranger" actually depends on.
   */
  rec('and it gets its own body slots on top',
    budget.maxBodies === budget.ambientBodies + 2 + budget.hostileBodies && budget.hostileBodies >= 0,
    `maxBodies ${budget.maxBodies} = ambient ${budget.ambientBodies} + CREW_MAX 2 ` +
    `+ ${budget.hostileBodies} reserved for mission hostiles, ` +
    'so a brother is never demoted to a capsule to make room for a stranger');
  rec('mission hostiles never borrow from the pool cops come from',
    budget.hostilePoolIsSeparate,
    'peds.hostiles.pool is disjoint from peds.peds, so a firefight cannot starve spawnCop ' +
    '— the same contract the crew pool keeps');
}

/* ===================================================================== */
/* 2 — following                                                         */
/* ===================================================================== */
if (want('follow')) {
  group = 'follow';
  log('\n--- follow ---------------------------------------------------------');
  // shove the player 55 m down the street; they have to walk it back
  await run(`
    const p = player.position;
    peds.crew.members.forEach((m) => { m.hasGuard = false; m.noRevive = false; });
    player.teleport({ x: p.x + 40, y: p.y, z: p.z + 38 }, 0);
    return true;
  `);
  const start = await run(`
    return peds.crewState().map((s) => +s.distance.toFixed(1));
  `);
  const walk = await advance(26, `
    const st = peds.crewState();
    return {
      d: st.map((s) => +s.distance.toFixed(2)),
      bodies: peds.crew.members.filter((m) => m.ped && m.ped.body).length,
      water: peds.crew.members.some((m) => m.ped && peds.isWaterAt(m.ped.position.x, m.ped.position.z)),
      lod: peds.crew.members.map((m) => m.ped ? m.ped.lod : 9),
    };
  `, 3);
  const last = walk.samples[walk.samples.length - 1];
  const settled = walk.samples.slice(-4);
  const worst = Math.max(...settled.flatMap((s) => s.d));
  const everCapsule = walk.samples.some((s) => s.bodies < 2);
  const everWater = walk.samples.some((s) => s.water);

  rec('they start far behind after a teleport', Math.max(...start) > 25, `${start.join(' / ')} m`);
  rec(`they close to the ${TUNING.follow} m trail distance`, worst <= TUNING.follow + 3.2,
    `settled at ${settled[settled.length - 1].d.join(' / ')} m (tolerance ${TUNING.follow + 3.2})`);
  rec('neither ever drops to the capsule LOD', !everCapsule, `min bodies ${Math.min(...walk.samples.map((s) => s.bodies))}/2`);
  rec('neither ever walks into the river', !everWater, everWater ? 'a brother was standing on water' : 'dry the whole way');
  rec('both stay at the near animation LOD', last.lod.every((l) => l <= 1), `lod ${last.lod.join('/')}`);
}

/* ===================================================================== */
/* 2b — A LONG WALK: the spacing DISTRIBUTION, and the liability A/B      */
/* ===================================================================== */
/**
 * "They settled at 4.8 m" is one sample of one moment and says nothing about
 * what following FEELS like. This puts the player on a real lane centre and
 * walks him up and down it for eighty seconds under scripted input, turning as
 * he goes, and reports the whole spacing distribution — median, p90, worst.
 *
 * Then it asks the only question that matters about a companion: DOES HE COST
 * YOU ANYTHING? The identical walk is run twice from the identical pose, once
 * with the crew live and once with `despawnCrew()`, and the two ground-covered
 * figures are compared.
 *
 * That A/B is the design. An absolute "he never stalls" threshold was tried
 * first and was worthless: it fired at 69% on a run where the player had walked
 * into a BUILDING, which is not the crew's fault and not something the crew
 * could fix. The differential cancels every wall, kerb and railing in the city
 * because both arms hit the same ones, and it is the number a player would
 * actually notice.
 *
 *   CROWDING is still absolute — a brother inside `PERSONAL` metres of the
 *   player. Brushing past is fine; living there is not, so it is capped as a
 *   fraction of the walk AND as the longest unbroken run of samples.
 */
if (want('spacing')) {
  group = 'spacing';
  log('\n--- spacing over a long walk ---------------------------------------');
  const PERSONAL = 1.6;

  await run('engine.input.enabled = false; return true;');
  const staged = await stageAt();
  if (!staged || staged.walk < 6) {
    /* Refuse to grade the crew on ground the player cannot walk on. This is
       the engine condition documented on `stageAt`; saying so is the only
       honest output, and blaming the companions for it is what the first
       version of this group did. */
    rec('a walkable stage was found', false,
      staged
        ? `best of ${staged.tries} candidates walked only ${staged.walk} m in 4 s ` +
          '(the player-cannot-translate condition — see stageAt; not a crew result)'
        : 'world.roads gave no edge');
  } else {
    rec('a walkable stage was found', true,
      `candidate ${staged.tries} on a ${staged.kind} at ${staged.x},${staged.z} ` +
      `walked ${staged.walk} m in 4 s`);
    // Out and back along the road, with two off-axis legs. `yaw` here is the
    // CAMERA yaw the movement code steers by; the scripted stick is always
    // forward, so turning the camera turns the walk.
    /* Out and back in SHORT hops. Ten-second legs ran ~30 m down a street the
       stage probe had only cleared 12 m of, wedged the player against whatever
       was there, and spent the rest of the route standing still. Five-second
       hops that keep reversing stay inside the validated corridor and still
       turn the follower twelve times, which is the thing being measured. */
    const LEGS = [0, Math.PI, 0.45, Math.PI + 0.45, -0.45, Math.PI - 0.45]
      .map((d) => staged.yaw + d);
    const start = await run(`
      return { x: player.position.x, y: player.position.y, z: player.position.z };
    `);

    /** One arm of the A/B. Returns ground covered plus the spacing samples. */
    const walkLegs = async (withCrew) => {
      const out = { travelled: 0, spacing: [], frames: 0, close: 0, closeRunMax: 0,
                    startedOk: false, recovered: 0, lastLeg: 99 };
      /* Re-solve the ground height rather than reusing the y captured before
         the other arm ran. Tiles stream, terrain collision comes and goes, and
         teleporting to a stale y drops the capsule either into the road or a
         metre under it — where it cannot walk at all. That is how the SOLO arm
         of this A/B once covered 4 m against the crew arm's 198 and reported
         the crew as a 98% mobility tax. */
      await run(`
        if (ARG) peds.spawnCrew(); else peds.despawnCrew();
        const w = ctx.peek('world');
        const g = w.walkableHeightAt(window.__W0__.x, window.__W0__.z);
        player.teleport({ x: window.__W0__.x, y: g + 1.0, z: window.__W0__.z }, window.__W0__.yaw);
        player.rig.yaw = window.__W0__.yaw;
        player.movement.scriptedInput = null;
        /* Put the crew back beside him too. The player teleports 160 m between
           ABBA arms and the brothers do not — so without this every arm opens
           with a 160 m catch-up jog, and those samples land in the spacing
           distribution and drag p99 from 5 m to 50. The teleport is a harness
           artefact; the thing being measured is steady-state following. */
        const f = player.forward;
        const n = Math.hypot(f.x, f.z) || 1;
        peds.crew.members.forEach((m, i) => {
          if (!m.ped) return;
          const s = i ? 1.2 : -1.2;
          m.ped.position.set(player.position.x - (f.x / n) * 4.5 - (f.z / n) * s,
                             player.position.y,
                             player.position.z - (f.z / n) * 4.5 + (f.x / n) * s);
          m.ped.position.y = peds.groundAt(m.ped.position.x, m.ped.position.z, m.ped.position.y + 8);
          m.ped.groundY = m.ped.position.y;
          m.ped.speed = 0;
          m.hasWp = false;
        });
        return true;
      `, withCrew);
      await settle();
      /**
       * AND THEN CHECK HE CAN MOVE, up to three times.
       *
       * A capsule dropped by a teleport is intermittently unable to walk for a
       * few seconds — `tools/playprobe.mjs` hits the same thing and reports
       * "W walks 0.01 m" on a build where W obviously works. It is not the
       * crew's doing and it must not be allowed to become a crew result: with
       * one arm of this A/B affected the pair read "138 m with the crew, 3 m
       * alone", which is a 4200% score for having companions.
       */
      let ok = false;
      for (let tries = 0; tries < 3 && !ok; tries++) {
        await run(`
          window.__PROBE0__ = { x: player.position.x, z: player.position.z };
          player.movement.scriptedInput = { x: 0, y: 1, sprint: false, walk: false, crouch: false };
          return true;
        `);
        await advance(1.5);
        const step = await run(`
          const a = window.__PROBE0__;
          const p = player.position;
          return +Math.hypot(p.x - a.x, p.z - a.z).toFixed(2);
        `);
        if (step > 2) { ok = true; break; }
        await run(`
          const w = ctx.peek('world');
          player.movement.scriptedInput = null;
          const g = w.walkableHeightAt(window.__W0__.x, window.__W0__.z);
          player.teleport({ x: window.__W0__.x, y: g + 1.2, z: window.__W0__.z }, window.__W0__.yaw);
          player.rig.yaw = window.__W0__.yaw;
          return true;
        `);
        await settle();
      }
      out.startedOk = ok;
      let px = null; let pz = null; let closeRun = 0;
      for (const yaw of LEGS) {
        /**
         * RECOVER, DON'T GIVE UP. A leg that covers nothing has walked into
         * the "grounded, jogging, not translating" ground documented on
         * `stageAt`; it is not a crew result and it must not be allowed to
         * become one. If the previous leg went nowhere, put him back on the
         * validated pose (with the crew beside him) and carry on. The count is
         * reported so a run that needed a lot of them says so.
         */
        if (out.frames > 0 && out.lastLeg < 3) {
          out.recovered++;
          await run(`
            const w = ctx.peek('world');
            const g = w.walkableHeightAt(window.__W0__.x, window.__W0__.z);
            player.movement.scriptedInput = null;
            player.teleport({ x: window.__W0__.x, y: g + 1.0, z: window.__W0__.z }, window.__W0__.yaw);
            const f = player.forward;
            const n = Math.hypot(f.x, f.z) || 1;
            peds.crew.members.forEach((m, i) => {
              if (!m.ped) return;
              const s = i ? 1.2 : -1.2;
              m.ped.position.set(player.position.x - (f.x / n) * 4.5 - (f.z / n) * s,
                                 player.position.y,
                                 player.position.z - (f.z / n) * 4.5 + (f.x / n) * s);
              m.ped.position.y = peds.groundAt(m.ped.position.x, m.ped.position.z, m.ped.position.y + 8);
              m.ped.groundY = m.ped.position.y;
              m.hasWp = false;
            });
            return true;
          `);
          await advance(1.5);
          await run('player.movement.scriptedInput = { x: 0, y: 1, sprint: false, walk: false, crouch: false }; return true;');
          px = null; pz = null;
        }
        const legStart = out.travelled;
        await run('player.rig.yaw = ARG; return true;', yaw);
        const seg = await advance(5, `
          const st = peds.crewState();
          return { d: st.map((s) => +s.distance.toFixed(2)),
                   px: +player.position.x.toFixed(2), pz: +player.position.z.toFixed(2) };
        `, 10);
        for (const s of seg.samples) {
          out.frames++;
          if (px !== null) {
            const step = Math.hypot(s.px - px, s.pz - pz);
            if (step < 25) out.travelled += step;      // never count a teleport
          }
          px = s.px; pz = s.pz;
          if (!s.d.length) { closeRun = 0; continue; }
          for (const d of s.d) out.spacing.push(d);
          if (Math.min(...s.d) < PERSONAL) {
            out.close++; closeRun++;
            if (closeRun > out.closeRunMax) out.closeRunMax = closeRun;
          } else closeRun = 0;
        }
        out.lastLeg = out.travelled - legStart;
      }
      await run('player.movement.scriptedInput = null; return true;');
      return out;
    };

    await run('window.__W0__ = { ...ARG, yaw: ARG.yaw }; return true;', { ...start, yaw: staged.yaw });

    /**
     * COUNTERBALANCED, A-B-B-A. Run plainly as [crew, solo] the second arm was
     * reliably the worse one — 137 m then 17 m, 145 then 4, 195 then 5 — and
     * the difference was NOT the crew: it is the same position-dependent
     * "grounded, jogging, not translating" condition documented on `stageAt`,
     * which the route wanders into and which then persists. Whatever the drift
     * is, it is monotonic in run order, so ABBA cancels it: each arm gets one
     * early half and one late half.
     *
     * This is the same reasoning ARCHITECTURE.md records for the light-count
     * A/B ("seven counterbalanced runs, no overlap between arms"). An
     * uncounterbalanced A/B of two sequential arms measures the order as much
     * as the treatment.
     */
    const a1 = await walkLegs(true);
    const b1 = await walkLegs(false);
    const b2 = await walkLegs(false);
    const a2 = await walkLegs(true);
    const merge = (x, y) => ({
      travelled: x.travelled + y.travelled,
      spacing: x.spacing.concat(y.spacing),
      frames: x.frames + y.frames,
      close: x.close + y.close,
      closeRunMax: Math.max(x.closeRunMax, y.closeRunMax),
      startedOk: x.startedOk && y.startedOk,
      recovered: x.recovered + y.recovered,
    });
    const withCrew = merge(a1, a2);
    const solo = merge(b1, b2);
    await run('peds.spawnCrew(); return true;');
    await advance(2);

    const sp = withCrew.spacing.slice().sort((a, b) => a - b);
    const q = (f) => sp[Math.min(sp.length - 1, Math.floor(sp.length * f))];
    const median = q(0.5);
    const p90 = q(0.9);
    const worstSpace = sp[sp.length - 1];
    const ratio = solo.travelled > 1 ? withCrew.travelled / solo.travelled : 0;
    const closeFrac = withCrew.frames ? withCrew.close / withCrew.frames : 1;

    /* 25 m, not 60. This bar exists to prove somebody MOVED — the meaning of
       the group is carried by the ratio below, which compares the two arms
       over the identical route. How much total ground a run covers depends on
       how many legs landed on the dead ground documented on `stageAt` (the
       count is reported), and a run that covered 42 m in both arms is just as
       valid a comparison as one that covered 169 m in both. */
    rec('the walk actually happened',
      withCrew.startedOk && solo.startedOk && withCrew.frames > 60 && sp.length > 120 && solo.travelled > 25,
      `${withCrew.frames} samples, ${withCrew.travelled.toFixed(0)} m with the crew / ` +
      `${solo.travelled.toFixed(0)} m alone, from a ${staged.kind} at ${staged.x},${staged.z}; ` +
      `${withCrew.recovered}/${solo.recovered} legs restarted off dead ground`);
    rec(`median spacing sits at the ${TUNING.follow} m trail`, median >= 2.0 && median <= TUNING.follow + 3.0,
      `median ${median.toFixed(2)} m (want 2.0-${(TUNING.follow + 3).toFixed(1)})`);
    rec('p90 spacing stays inside a street width', p90 <= TUNING.follow + 7,
      `p90 ${p90.toFixed(2)} m (want <= ${TUNING.follow + 7})`);
    /* RATCHET. The goal is a worst case at a street width; this records what a
       real 80 s road walk gave. LOWER it when the pavement waypointing
       improves — never raise it to make a run go green. The leash is 92 m, so
       anything at or above that is a brother who was abandoned. */
    /**
     * TWO assertions, because the two failure modes are different sizes.
     *
     * ABANDONMENT is absolute and is the one that matters: the leash is 92 m,
     * so a brother at or past it has been left behind and the follow is
     * broken. That never has to be tuned.
     *
     * The EXCURSION is a RATCHET on p99, not on the max. The max is genuinely
     * noisy — five runs of this same walk gave 5.0, 24.1, 25.3, 32.0 and
     * 42.4 m — because it is one brother taking the pavement waypoint round a
     * block the player cut the corner of, and whether that happens depends on
     * which junction the walk reached. p99 is stable across the same runs.
     * Lower it when the waypointing learns to cut corners; never raise it.
     */
    const p99 = q(0.99);
    rec('no brother is ever abandoned', worstSpace < 92,
      `worst single sample ${worstSpace.toFixed(1)} m against a ${92} m leash`);
    rec('spacing excursions stay short', p99 <= 16,
      `p99 ${p99.toFixed(1)} m (RATCHET 16; max this run ${worstSpace.toFixed(1)} m, ` +
      `which is noisy by nature; goal ~${TUNING.follow + 5})`);
    /* THE LIABILITY A/B — the headline number of this group. */
    rec('the crew costs the player no ground', ratio > 0.92,
      `${(ratio * 100).toFixed(1)}% of the solo distance over the same route ` +
      `(${withCrew.travelled.toFixed(0)} m vs ${solo.travelled.toFixed(0)} m, want > 92%)`);
    /* Sampled at ~10 Hz, so the run length is expressed in SECONDS. Counting
       raw samples made the threshold depend on how fast the page happened to
       be running, and 11 samples read as a failure where 8 of the same brush
       read as a pass. Brushing past for a second is what walking together
       looks like; living there is not. */
    const closeSec = withCrew.closeRunMax * (withCrew.frames > 0 ? 10 / 10 : 1) * 0.1;
    rec(`nobody lives inside ${PERSONAL} m of the player`, closeFrac < 0.20 && closeSec <= 2.0,
      `${(closeFrac * 100).toFixed(1)}% of samples, longest unbroken brush ` +
      `${closeSec.toFixed(1)} s (${withCrew.closeRunMax} samples at ~10 Hz)`);

    /**
     * THE DOORWAY CASE, staged rather than waited for. Both brothers are put
     * DIRECTLY in the player's path, two metres ahead, and he is given full
     * stick straight at them. The quantity is the ground he actually covers —
     * his own emitted position, which nothing in `crew.js` computes. The
     * POSITIVE CONTROL for this same odometer, a parked car that genuinely
     * does stop him, is in the `cars` group below: without it, "he covered
     * 20 m" would not prove the measurement could ever say otherwise.
     */
    /* Back to THE stage this group already validated — not a fresh `stageAt`,
       which searches again and can settle on a different, worse candidate. The
       12 m this exact pose cleared is the reason the 2 s walk below means
       anything. */
    await run(`
      const w = ctx.peek('world');
      const g = w.walkableHeightAt(window.__W0__.x, window.__W0__.z);
      player.teleport({ x: window.__W0__.x, y: g + 1.0, z: window.__W0__.z }, window.__W0__.yaw);
      player.rig.yaw = window.__W0__.yaw;
      player.movement.scriptedInput = null;
      peds.spawnCrew();
      return true;
    `);
    await settle();
    await advance(2);
    await run(`
      const p = player.position;
      const f = player.forward;
      const n = Math.hypot(f.x, f.z) || 1;
      const fx = f.x / n, fz = f.z / n;
      peds.crew.members.forEach((m, i) => {
        const side = i === 0 ? -0.35 : 0.35;
        m.ped.position.set(p.x + fx * 2.0 + fz * side, p.y, p.z + fz * 2.0 - fx * side);
        m.ped.position.y = peds.groundAt(m.ped.position.x, m.ped.position.z, m.ped.position.y + 6);
        m.ped.groundY = m.ped.position.y;
      });
      player.movement.scriptedInput = { x: 0, y: 1, sprint: false, walk: false, crouch: false };
      window.__WALK0__ = { x: p.x, z: p.z, fx, fz };
      return true;
    `);
    /* TWO seconds, matched to the car control below. Four was too long for the
       control to mean anything: a capsule stopped by a car slides along the
       panels, rounds the 2.4 m end and carries on, so it still logged 8 m of
       forward progress and "blocked" and "clear" stopped being distinguishable.
       Inside two seconds a blocked walk gets ~2 m and a clear one ~6.5 m. */
    await advance(2);
    // progress ALONG the heading, the same quantity the car control measures
    const through = await run(`
      const p = player.position;
      const a = window.__WALK0__;
      player.movement.scriptedInput = null;
      return { moved: +((p.x - a.x) * a.fx + (p.z - a.z) * a.fz).toFixed(1) };
    `);
    rec('two brothers standing in the doorway do not stop him', through.moved > 4.5,
      `${through.moved} m of forward progress in 2 s walking straight through them ` +
      '(want > 4.5; the same measurement against a car reads under 2.5)');
  }
}

/* ===================================================================== */
/* 3 — engagement range and the damage rate                              */
/* ===================================================================== */
if (want('fight') || want('damage')) {
  group = 'fight';
  log('\n--- fight ----------------------------------------------------------');

  // one brother only, so the damage arithmetic has one term in it
  await run(`
    peds.spawnCrew(['carson']);
    game.hostiles.clear();
    return true;
  `);
  await advance(1.5);

  /* --- out of range: 34 m away, nothing happens --- */
  const far = await run(`
    const p = player.position;
    game.hostiles.clear();
    const h = game.hostiles.spawn(p.x + 34, p.z + 4, { hp: 900, dmg: 0, speed: 0, leash: 400 });
    window.__H__ = h;
    return { hp: h.health, d: +Math.hypot(h.position.x - p.x, h.position.z - p.z).toFixed(1) };
  `);
  await advance(5);
  const farAfter = await run(`
    const h = window.__H__;
    const m = peds.crew.members[0];
    return { hp: h.health, engaged: m.engaged,
             d: +Math.hypot(h.position.x - m.ped.position.x, h.position.z - m.ped.position.z).toFixed(1) };
  `);
  rec(`no engagement beyond ${TUNING.engage} m`, farAfter.hp === far.hp && !farAfter.engaged,
    `hostile at ${farAfter.d} m, hp ${far.hp} -> ${farAfter.hp}`);

  /* --- in range: a FRESH hostile eight metres away. Moving the far one by
     hand leaves the pool's own state pointing at where it used to be, which
     made the first version of this test measure a brother stuck at 7 m. --- */
  await run(`
    const p = player.position;
    game.hostiles.clear();
    const h = game.hostiles.spawn(p.x + 8, p.z, { hp: 2000, dmg: 0, speed: 0, leash: 900 });
    window.__H__ = h;
    return true;
  `);
  const fight = await advance(15, `
    const h = window.__H__;
    const m = peds.crew.members[0];
    return { hp: h.health, engaged: m.engaged, hits: m.hits, t: engine.time.elapsed,
             d: +Math.hypot(h.position.x - m.ped.position.x, h.position.z - m.ped.position.z).toFixed(2) };
  `, 3);
  const f0 = fight.samples[0];
  const f1 = fight.samples[fight.samples.length - 1];
  const dealt = f0.hp - f1.hp;
  const window_s = f1.t - f0.t;
  const dps = dealt / Math.max(0.01, window_s);
  const expectDps = TUNING.damage / TUNING.cycle;      // 4.67
  const hitsDone = f1.hits - f0.hits;
  const perHit = hitsDone ? dealt / hitsDone : 0;

  rec(`one brother engages inside ${TUNING.engage} m`, f1.engaged || hitsDone > 0,
    `closed to ${f1.d} m, ${hitsDone} hits`);
  rec(`he deals exactly ${TUNING.damage} damage a hit`, near(perHit, TUNING.damage, 0.35),
    `${perHit.toFixed(2)} damage/hit over ${hitsDone} hits`);
  rec(`on a ${TUNING.cycle} s cycle`, near(window_s / Math.max(1, hitsDone), TUNING.cycle, 0.45),
    `${(window_s / Math.max(1, hitsDone)).toFixed(2)} s between hits`);
  rec('he chips in but never carries the fight', near(dps, expectDps, expectDps * 0.4),
    `${dps.toFixed(2)} dps vs ${expectDps.toFixed(2)} expected — ${(900 / Math.max(0.01, dps)).toFixed(0)} s to solo a 900 hp target`);

  /**
   * --- AND HE TAKES IT BACK. A companion who deals damage and cannot receive
   * it is a turret, not a brother: `noRevive` means nothing, the `protect`
   * chapter cannot be lost, and no fight ever has a cost. `game`'s hostiles
   * only ever swing at the player, so the return fire is `Crew._think`'s own
   * `TUNING.incoming` on `incomingCycle` — which means the thing to assert is
   * that his HP ACTUALLY FELL and that `crew:hurt` reached `game`, not that
   * some number was configured.
   */
  await run(`
    const p = player.position;
    game.hostiles.clear();
    window.__CREWTAP__.hurt.length = 0;
    const m = peds.crew.members[0];
    m.hp = m.maxHp;
    const h = game.hostiles.spawn(p.x + 5, p.z + 1, { hp: 4000, dmg: 0, speed: 0, leash: 900 });
    window.__H__ = h;
    return true;
  `);
  const brawl = await advance(14, `
    const m = peds.crew.members[0];
    return { hp: +m.hp.toFixed(1), hurt: window.__CREWTAP__.hurt.length, up: m.up };
  `, 3);
  const b0 = brawl.samples[0];
  const b1 = brawl.samples[brawl.samples.length - 1];
  rec('a brawling brother takes damage back', b1.hp < b0.hp - 4,
    `${b0.hp} -> ${b1.hp} hp over ${brawl.dt.toFixed(0)} s toe to toe`);
  rec('`crew:hurt` reaches `game` for the HUD', b1.hurt > 0, `${b1.hurt} crew:hurt events`);
  rec('a stand-up fight does not instantly floor him', b1.up,
    `still on his feet at ${b1.hp}/${await run('return peds.crew.members[0].maxHp;')} hp`);

  /* --- NEGATIVE CONTROL for the whole fight group: no hostile, no damage.
     Without this, every number above would also be produced by a build that
     damaged the crew on a timer regardless of who was standing there. --- */
  await run(`
    game.hostiles.clear();
    window.__CREWTAP__.hurt.length = 0;
    const m = peds.crew.members[0];
    m.hp = m.maxHp;
    return true;
  `);
  const quiet = await advance(9, `
    const m = peds.crew.members[0];
    return { hp: +m.hp.toFixed(1), hurt: window.__CREWTAP__.hurt.length, hits: m.hits };
  `, 3);
  const q1 = quiet.samples[quiet.samples.length - 1];
  const q0 = quiet.samples[0];
  rec('NEGATIVE CONTROL: an empty street costs him nothing', q1.hp >= q0.hp - 0.01 && q1.hurt === 0,
    `${q0.hp} -> ${q1.hp} hp, ${q1.hurt} hurt events over ${quiet.dt.toFixed(0)} s`);
  rec('NEGATIVE CONTROL: and he swings at nothing', q1.hits === q0.hits,
    `${q1.hits - q0.hits} strikes with no hostile alive`);

  /* --- restore the pair --- */
  await run(`game.hostiles.clear(); peds.spawnCrew(); return true;`);
  await advance(2);
}

/* ===================================================================== */
/* 3b — THE FIRING LANE: he does not stand in front of your gun          */
/* ===================================================================== */
/**
 * The single most common way a companion ruins a firefight. Two halves, and
 * both are asserted because either alone is a half-fix:
 *
 *   BEHAVIOUR   `Crew._yield` walks him out of a corridor along the player's
 *               aim. Measured as the fraction of aiming frames a brother spends
 *               inside that corridor — recomputed HERE from the player's own
 *               forward vector and the ped's own position, never read off
 *               `m.inLane`, which is the code's own opinion of itself.
 *   SAFETY NET  `Ped.applyDamage` charges a tenth for a round that lands
 *               within `ffWindow` of the player firing, so the frame before he
 *               clears the lane cannot floor him.
 *
 * Negative controls for both: `fireLaneEnabled = false` restores the build
 * where he stands in the barrel, and `friendlyFireScale = 1` restores the one
 * where your own burst puts your brother on the pavement.
 */
if (want('firelane')) {
  group = 'firelane';
  log('\n--- the firing lane ------------------------------------------------');

  /** Hold the player aiming down a fixed heading with a hostile out in front,
   *  park both brothers ON the aim axis, and watch who is where. */
  const stage = `
    game.hostiles.clear();
    peds.spawnCrew();
    const p = player.position;
    const f = player.forward;
    const n = Math.hypot(f.x, f.z) || 1;
    const fx = f.x / n, fz = f.z / n;
    game.hostiles.spawn(p.x + fx * 16, p.z + fz * 16, { hp: 6000, dmg: 0, speed: 0, leash: 900 });
    peds.crew.members.forEach((m, i) => {
      const at = 5 + i * 3;
      m.hp = m.maxHp;
      m.laneSide = 0;
      m.ped.position.set(p.x + fx * at, p.y, p.z + fz * at);
      m.ped.position.y = peds.groundAt(m.ped.position.x, m.ped.position.z, m.ped.position.y + 6);
      m.ped.groundY = m.ped.position.y;
    });
    player.movement.aiming = true;
    peds.playerShotAt = engine.time.elapsed;
    return true;
  `;
  /** Recomputed from first principles: the player's forward, the ped's
   *  position, and the corridor's own geometry. `crew.js` never sees this. */
  const sampleLane = `
    peds.playerShotAt = engine.time.elapsed;   // keep the lane hot
    player.movement.aiming = true;
    const p = player.position;
    const f = player.forward;
    const n = Math.hypot(f.x, f.z) || 1;
    const fx = f.x / n, fz = f.z / n;
    let inLane = 0, total = 0, worst = 9e9;
    for (const m of peds.crew.members) {
      if (!m.ped || m.inCar || !m.up) continue;
      total++;
      const dx = m.ped.position.x - p.x, dz = m.ped.position.z - p.z;
      const along = dx * fx + dz * fz;
      const perp = Math.abs(dx * fz - dz * fx);
      if (along > 0.5 && along < 22 && perp < 1.6) inLane++;
      if (along > 0.5 && along < 22 && perp < worst) worst = perp;
    }
    return { inLane, total, worst: worst > 8e9 ? null : +worst.toFixed(2) };
  `;

  const measure = async (on) => {
    await run('peds.crew.fireLaneEnabled = ARG; return true;', on);
    await run(stage);
    const s = await advance(7, sampleLane, 12);
    let inLane = 0; let total = 0; let worst = 0;
    for (const r of s.samples) {
      inLane += r.inLane; total += r.total;
      if (r.worst !== null && r.worst > worst) worst = r.worst;
    }
    return { frac: total ? inLane / total : 0, total, worst };
  };

  const off = await measure(false);
  const on = await measure(true);
  await run(`
    peds.crew.fireLaneEnabled = true;
    player.movement.aiming = false;
    game.hostiles.clear();
    return true;
  `);

  rec('the staged brothers really did start in the barrel', off.frac > 0.25,
    `NEGATIVE CONTROL (fireLaneEnabled=false): ${(off.frac * 100).toFixed(1)}% of ` +
    `${off.total} brother-frames inside the corridor`);
  rec('with the yield on, he clears the firing lane', on.frac < off.frac * 0.5 && on.frac < 0.2,
    `${(on.frac * 100).toFixed(1)}% vs ${(off.frac * 100).toFixed(1)}% off — ` +
    `he ends up ${on.worst.toFixed(2)} m off the axis (lane half-width 1.6)`);
}

/* ===================================================================== */
/* 3c — FRIENDLY FIRE: your own burst cannot floor your brother          */
/* ===================================================================== */
if (want('friendly')) {
  group = 'friendly';
  log('\n--- friendly fire --------------------------------------------------');

  /** Forty rounds of the player's own into a brother, through the REAL path:
   *  `weapon:fire` then `damage:dealt` with his ped as the target, which is
   *  exactly what `physics.emitImpact` raises when a round lands on him. */
  const burst = `
    const m = peds.crew.members[0];
    peds.reviveCrew(m.id);
    m.hp = m.maxHp;
    window.__CREWTAP__.down.length = 0;
    window.__FF__ = 0;
    const off = engine.events.on('crew:friendlyfire', () => { window.__FF__++; });
    for (let i = 0; i < ARG; i++) {
      engine.events.emit('weapon:fire', {
        weapon: 'nailgun', origin: player.position, dir: { x: 0, y: 0, z: 1 }, seed: i,
      });
      engine.events.emit('damage:dealt', {
        target: m.ped, amount: 25, headshot: false, killed: false, point: m.ped.position,
      });
    }
    off();
    return { id: m.id, hp: +m.hp.toFixed(1), maxHp: m.maxHp, up: m.up,
             ff: window.__FF__, downs: window.__CREWTAP__.down.length };
  `;

  const safe = await run(burst, 40);
  rec('forty of the player\'s own rounds do not floor him', safe.up && safe.downs === 0,
    `${safe.id} took ${safe.ff} friendly rounds, ${safe.maxHp} -> ${safe.hp} hp, still up`);
  rec('but the hits are real and reported', safe.ff === 40 && safe.hp < safe.maxHp,
    `${safe.ff} crew:friendlyfire events, ${(safe.maxHp - safe.hp).toFixed(0)} damage taken ` +
    `(a tenth of the ${40 * 25} that landed)`);

  /* NEGATIVE CONTROL — the build without the attenuation. */
  await run('peds.crew.friendlyFireScale = 1; return true;');
  const unsafe = await run(burst, 40);
  await run(`
    peds.crew.friendlyFireScale = ${0.10};
    peds.reviveCrew(peds.crew.members[0].id);
    peds.crew.members[0].hp = peds.crew.members[0].maxHp;
    return true;
  `);
  rec('NEGATIVE CONTROL: at full damage the same burst floors him',
    !unsafe.up && unsafe.downs > 0,
    `friendlyFireScale=1 -> ${unsafe.id} down after the same 40 rounds (${unsafe.downs} crew:down)`);

  /* And the window has to be a window: a round that is NOT the player's must
     still hurt, or the crew is invulnerable to the police as well. */
  const hostileRound = await run(`
    const m = peds.crew.members[0];
    peds.reviveCrew(m.id);
    m.hp = m.maxHp;
    peds.playerShotAt = -1e9;             // nobody has fired
    window.__FF__ = 0;
    const off = engine.events.on('crew:friendlyfire', () => { window.__FF__++; });
    engine.events.emit('damage:dealt', {
      target: m.ped, amount: 25, headshot: false, killed: false, point: m.ped.position,
    });
    off();
    return { hp: +m.hp.toFixed(1), maxHp: m.maxHp, ff: window.__FF__ };
  `);
  rec('a round that is NOT the player\'s costs full price',
    hostileRound.ff === 0 && near(hostileRound.maxHp - hostileRound.hp, 25, 0.5),
    `${(hostileRound.maxHp - hostileRound.hp).toFixed(1)} damage, 0 friendly-fire events`);
}

/* ===================================================================== */
/* 3d — PARKED CARS: he walks round the bodywork, not through it         */
/* ===================================================================== */
/**
 * `physics` blocks capsules against vehicles (`src/physics/carblock.mjs`) but
 * `Ped._move` integrates position directly and is not a capsule, so a brother
 * used to walk clean through a parked sedan. He now reads the same
 * `physics.blockers` snapshot the character controller does.
 *
 * WHAT IS MEASURED, AND WHY IT IS NOT THE CODE'S OWN INPUT. The avoidance
 * pushes on a CIRCLE — `blockers.r[i]`, which is `max(W,L)/2 * 0.72 + 0.25` and
 * knows nothing about which way the car is pointing. The gate measures
 * horizontal distance to the true ORIENTED BOX, solved from the vehicle's own
 * quaternion and half extents, exactly as `carblock.mjs` does and for the same
 * reason: two independent descriptions of "where the car is", and only a real
 * avoidance makes them agree. A negative overlap is a man inside the bodywork.
 *
 * The car is SPAWNED rather than hunted for. A test that depends on where the
 * AI happened to park reports a different number every run — and the first
 * version of this one did exactly that, missing the body by 9 cm.
 */
if (want('cars')) {
  group = 'cars';
  log('\n--- parked cars ----------------------------------------------------');
  // 40 m down the same fixed street the spacing walk uses, so the crossing is
  // the same crossing every run and the RATCHET below means something.
  await stageAt(40, 0);
  /**
   * The car is laid ACROSS the corridor `stageAt` has just proved the player
   * can walk twelve metres down, six metres along it, broadside on. That
   * corridor is the only ground in this test known to be walkable, and using
   * it removes the whole class of "nobody crossed" results: an earlier version
   * put the player on the car's own lateral axis nine metres out, which on
   * some runs was inside a shopfront, and the brothers stopped four metres
   * short of a car they were supposed to walk into.
   */
  const made = await run(`
    const veh = ctx.peek('vehicles');
    const w = ctx.peek('world');
    const p = player.position;
    const f = player.forward;
    const fn = Math.hypot(f.x, f.z) || 1;
    const ux = f.x / fn, uz = f.z / fn;
    const cx = p.x + ux * 6, cz = p.z + uz * 6;
    // broadside: the car's own forward (sin yaw, cos yaw) perpendicular to the walk
    const yaw = Math.atan2(uz, -ux);
    let car = null;
    try { car = veh?.spawn?.('sedan', { x: cx, y: w.walkableHeightAt(cx, cz) + 0.6, z: cz }, yaw); } catch { car = null; }
    if (!car || !car.spec?.half) return null;
    window.__CAR__ = car;
    window.__WALKDIR__ = { ux, uz };
    return { half: { x: +car.spec.half.x.toFixed(2), z: +car.spec.half.z.toFixed(2) }, id: car.spec.id ?? 'sedan' };
  `);
  if (!made) {
    rec('a car was available to walk into', false, 'vehicles.spawn and vehicles.nearest both came back empty');
  } else {
    /* Distance to the true OBB, in the page. Negative = inside the bodywork. */
    const OBB = `
      const obb = (v, x, z) => {
        const h = v.spec.half; const q = v.quaternion;
        const dx = x - v.position.x, dz = z - v.position.z;
        const ix = -q.x, iy = -q.y, iz = -q.z, iw = q.w;
        const tx = 2 * (iy * dz), ty = 2 * (iz * dx - ix * dz), tz = -2 * (iy * dx);
        const lx = dx + iw * tx + (iy * tz - iz * ty);
        const lz = dz + iw * tz + (ix * ty - iy * tx);
        const ox = Math.max(0, Math.abs(lx) - h.x), oz = Math.max(0, Math.abs(lz) - h.z);
        if (ox > 0 || oz > 0) return Math.hypot(ox, oz);
        return -Math.min(h.x - Math.abs(lx), h.z - Math.abs(lz));
      };
    `;

    /**
     * Player 9 m past the car, brothers 9 m short of it, all three on the line
     * that crosses the car's SHORT axis — so a follower on the crow flies
     * straight through the doors. Nine metres is deliberately inside
     * `SIDEWALK_AT` (13 m), or the pavement waypoint takes over and the test
     * measures the road network instead of the avoidance.
     */
    const drive = async (avoid) => {
      await run(`
        ${OBB}
        const v = window.__CAR__;
        const u = window.__WALKDIR__;
        peds.crew.carAvoidEnabled = ARG;
        peds.spawnCrew();
        // a guard anchor or a downed brother from an earlier group means
        // nobody crosses, and the depth reading is then about an empty street
        peds.crew.members.forEach((m) => {
          m.hasGuard = false; m.noRevive = false; m.isWard = false;
          if (!m.up) peds.reviveCrew(m.id);
        });
        window.__AXIS__ = { ux: u.ux, uz: u.uz };
        // player 5 m BEHIND the car along the corridor, brothers 6 m beyond it,
        // so following him means walking straight through the bodywork
        const px = v.position.x - u.ux * 5, pz = v.position.z - u.uz * 5;
        // rig.forward is (0,0,-1) rotated by yaw, i.e. (-sin y, -cos y): to
        // FACE (dx,dz) the yaw is atan2(-dx,-dz). Getting this backwards is how
        // the first run of this test walked the player AWAY from the car and
        // reported 12 m of clear ground as a failure to block.
        const pyaw = Math.atan2(-u.ux, -u.uz);
        player.teleport({ x: px, y: v.position.y + 1.2, z: pz }, pyaw);
        player.rig.yaw = pyaw;
        peds.crew.members.forEach((m, i) => {
          const s = i ? 0.7 : -0.7;
          m.ped.position.set(v.position.x + u.ux * 6 - u.uz * s, v.position.y, v.position.z + u.uz * 6 + u.ux * s);
          m.ped.position.y = peds.groundAt(m.ped.position.x, m.ped.position.z, m.ped.position.y + 8);
          m.ped.groundY = m.ped.position.y;
          m.hasWp = false;
        });
        return true;
      `, avoid);
      const s = await advance(10, `
        ${OBB}
        const v = window.__CAR__;
        const h = v.spec.half;
        const core = Math.min(h.x, h.z);
        let worst = 9e9, nearest = 9e9;
        for (const m of peds.crew.members) {
          if (!m.ped || m.inCar) continue;
          const d = obb(v, m.ped.position.x, m.ped.position.z);
          if (d < worst) worst = d;
          const r = Math.hypot(m.ped.position.x - v.position.x, m.ped.position.z - v.position.z);
          if (r < nearest) nearest = r;
        }
        return { d: +worst.toFixed(3), r: +nearest.toFixed(3), core: +core.toFixed(3) };
      `, 20);
      let inCore = 0;
      let closest = 9e9;
      let deepest = 9e9;
      const core = s.samples[0]?.core ?? 0;
      for (const r of s.samples) {
        if (r.r < r.core) inCore++;
        if (r.r < closest) closest = r.r;
        if (r.d < deepest) deepest = r.d;
      }
      /* Did anybody actually try to cross? Without this the whole group can
         report a confident -0.9 / -0.2 pair on a run where neither brother got
         within seven metres of the car, which is a reading about an empty
         street. Asserted below so a non-crossing run says so. */
      return { inCore, frames: s.samples.length, closest, deepest, core,
               crossed: closest < 4.0 };
    };

    const off = await drive(false);
    const on = await drive(true);
    await run('peds.crew.carAvoidEnabled = true; return true;');

    /* The control's job is to show the measurement CAN see a man in a car.
       Depth past the panels is the sensitive quantity — the inscribed core is
       a small target and a brother crossing near the wing misses it while
       still being most of a metre inside the bodywork. */
    rec('both arms actually walked at the car', off.crossed && on.crossed,
      `closest approach: ${off.closest.toFixed(2)} m with the avoidance off, ` +
      `${on.closest.toFixed(2)} m with it on (want both under 4 m, or nobody crossed)`);
    rec('NEGATIVE CONTROL: without the avoidance he walks through the car',
      off.crossed && off.deepest < -0.4,
      `carAvoidEnabled=false: ${off.deepest.toFixed(2)} m inside the ${made.id} panels, ` +
      `closest ${off.closest.toFixed(2)} m from the centre, ${off.inCore}/${off.frames} ` +
      `samples inside the ${off.core.toFixed(2)} m core`);
    /* HARD. The inscribed circle of the body box is unambiguously in the
       bodywork on every heading, and `Crew.depenetrate` guarantees it. */
    rec('with it on, he is never inside the bodywork core',
      on.crossed && on.inCore === 0 && on.closest > off.closest + 0.5,
      `${on.inCore}/${on.frames} samples inside the ${on.core.toFixed(2)} m core; ` +
      `closest approach ${on.closest.toFixed(2)} m from the centre ` +
      `(vs ${off.closest.toFixed(2)} m with the avoidance off)`);
    /* RATCHET, and the reason it is not zero. `blockers.r` is a CIRCLE of
       max(W,L)/2 * 0.72 — deliberately shorter than the nose — so a corner
       graze is what the PLAYER's own capsule gets too and is documented in
       src/physics/carblock.mjs. Lower this when the blocker set gains a real
       OBB; never raise it. */
    rec('and his worst corner graze stays shallow', on.deepest > -0.55,
      `worst OBB overlap ${on.deepest.toFixed(2)} m (RATCHET -0.55; ` +
      `${off.deepest.toFixed(2)} m with the avoidance off; goal 0 once blockers are boxes)`);
    rec('and he still gets past it', on.frames > 20, `${on.frames} samples over the crossing`);

    /**
     * POSITIVE CONTROL for the doorway odometer in the `spacing` group: the
     * same "full stick for four seconds, how far did he get" measurement, run
     * against something that genuinely does stop a capsule. Without it, "he
     * covered 11 m through two brothers" would prove nothing, because nothing
     * would show the odometer can ever read small.
     */
    await run(`
      const v = window.__CAR__;
      const h = v.spec.half;
      const a = window.__WALKDIR__;
      // stand off along the corridor and walk straight at the broadside
      const back = h.x + 3.4;
      // stand off at -u and face +u, i.e. at the car: yaw = atan2(-dx, -dz)
      const yaw = Math.atan2(-a.ux, -a.uz);
      player.teleport({ x: v.position.x - a.ux * back, y: v.position.y + 1.2, z: v.position.z - a.uz * back }, yaw);
      player.rig.yaw = yaw;
      return true;
    `);
    await advance(1.5);
    /* Verify the stage before trusting the measurement: if he is not actually
       pointing at the bodywork, "12 m of clear ground" says nothing at all —
       which is exactly what the first version of this test reported. */
    const aimed = await run(`
      const v = window.__CAR__;
      const p = player.position;
      const f = player.forward;
      const n = Math.hypot(f.x, f.z) || 1;
      const tx = v.position.x - p.x, tz = v.position.z - p.z;
      const td = Math.hypot(tx, tz) || 1;
      window.__WALK1__ = { x: p.x, z: p.z, fx: f.x / n, fz: f.z / n };
      player.movement.scriptedInput = { x: 0, y: 1, sprint: false, walk: false, crouch: false };
      return { dot: +((f.x / n) * (tx / td) + (f.z / n) * (tz / td)).toFixed(3), d: +td.toFixed(2) };
    `);
    await advance(2);
    /* PROGRESS ALONG THE APPROACH, not path length. A blocked capsule slides
       sideways along the panels and round the back of the car — 7.1 m of
       travel and not one metre closer to where it was going. Path length said
       "he walked freely"; the projection says "he got 1.9 m and stopped",
       which is what blocked means and what the doorway case must beat. */
    const intoCar = await run(`
      const p = player.position;
      const a = window.__WALK1__;
      player.movement.scriptedInput = null;
      return +((p.x - a.x) * a.fx + (p.z - a.z) * a.fz).toFixed(1);
    `);
    rec('the positive control is aimed at the car at all', aimed.dot > 0.9,
      `player forward . car bearing = ${aimed.dot} from ${aimed.d} m out`);
    /* 3.0, not 2.5: a blocked walk still covers the stand-off gap before the
       push takes hold, which measures 1.9-2.5 m depending on where the capsule
       started, and one run landed exactly on a 2.5 threshold. The separation
       that matters is against the doorway's 4.5 m floor and its 6.5-6.9 m
       readings, which is still better than 2:1. */
    rec('POSITIVE CONTROL: the same odometer sees a car stop him', intoCar < 3.0,
      `${intoCar} m of forward progress in 2 s walking into the ${made.id} — the ` +
      'doorway test reads 6.5-6.9 m through two brothers on the same measurement ' +
      'and the same clock, so it can read both ways');

    /* Take the test car away again. Leaving a sedan parked on the stage made
       the NEXT group's revived brother sidestep it (9.4 m from the player
       instead of 2.4) and then get clipped by it for 8 damage — two failures
       in a group that has nothing to do with cars. */
    await run(`
      const veh = ctx.peek('vehicles');
      if (window.__CAR__) { try { veh.despawn(window.__CAR__); } catch { /* fine */ } }
      window.__CAR__ = null;
      return true;
    `);
    await advance(1);
  }
}


/* ===================================================================== */
/* 4 — down and revive                                                   */
/* ===================================================================== */
if (want('down')) {
  group = 'down';
  log('\n--- down and revive ------------------------------------------------');
  // Clean street, known ground: a revive puts him 2-3.6 m from the player, and
  // whether that spot has a parked car in it decides both where he ends up and
  // whether something runs him over on the way.
  await stageAt();
  const id = await run(`
    const T = window.__CREWTAP__;
    T.down.length = 0; T.revive.length = 0; T.deaths.length = 0; T.line.length = 0;
    const m = peds.crew.members[0];
    if (!m.up) peds.reviveCrew(m.id);      // a car may already have clipped him
    T.down.length = 0; T.line.length = 0;
    peds.hurtCrew(m.id, 9999);
    return { id: m.id, up: m.up, state: m.ped.state, ragdoll: !!m.ped.ragdoll, t: engine.time.elapsed };
  `);
  const ID = id.id;
  rec('a brother goes DOWN, not dead', !id.up && id.state === 'down', `${id.id} state=${id.state}`);
  rec('he ragdolls where he stood', id.ragdoll, id.ragdoll ? 'physics ragdoll built' : 'no ragdoll');

  const noDeath = await run(`return window.__CREWTAP__.deaths.length;`);
  rec('no actor:death is emitted for a brother', noDeath === 0,
    `${noDeath} actor:death events (police would charge a wanted star for each)`);

  const downEv = await run(`return window.__CREWTAP__.down.length;`);
  rec('crew:down fires for `game`', downEv === 1, `${downEv} event(s)`);

  const linesAtDown = await run(`return window.__CREWTAP__.line.length;`);
  rec('he says something on the way down', linesAtDown > 0, `${linesAtDown} line(s) queued`);

  // wait it out
  /**
   * Sampled AT the moment he stands up, not four seconds later. The condition
   * being asserted is what `revive()` leaves behind — full health, on his feet,
   * beside the player, ragdoll released — and all four of those are things the
   * living world is then entitled to change. Reading them after a settle
   * measured a brother who had got up correctly and was promptly clipped by a
   * passing sedan for 8 damage and shoved 7 m up the pavement, and reported
   * that as a broken revive.
   */
  const rev = await advance(TUNING.revive + 4, `
    const m = peds.crew.byId(${JSON.stringify(ID)});
    const p = player.position;
    return { up: m.up, t: engine.time.elapsed, hp: m.hp, maxHp: m.maxHp,
             state: m.ped.state, ragdoll: !!m.ped.ragdoll,
             d: +Math.hypot(m.ped.position.x - p.x, m.ped.position.z - p.z).toFixed(2) };
  `, 12);
  const upAt = rev.samples.find((s) => s.up);
  const downAt = id.t;
  const delay = upAt ? upAt.t - downAt : null;
  rec(`he picks himself up after ~${TUNING.revive} s`, delay !== null && near(delay, TUNING.revive, 1.6),
    delay === null ? 'never got up' : `${delay.toFixed(2)} s`);

  const where = upAt ?? rev.samples[rev.samples.length - 1] ?? { d: 99, hp: 0, maxHp: 1, state: '?', ragdoll: true };
  rec('he gets up NEXT TO the player', where.d < 8, `${where.d} m from the player, on the frame he stood up`);
  rec('at full health, on his feet, ragdoll released',
    where.hp === where.maxHp && where.state === 'crew' && !where.ragdoll,
    `${where.hp}/${where.maxHp}, state=${where.state}`);

  /* --- noRevive: failing has to be possible --- */
  const wardId = await run(`
    const m = peds.crew.members.find((x) => x.id !== ${JSON.stringify(ID)}) ?? peds.crew.members[0];
    peds.setCrewWard(m.id, { noRevive: true });
    peds.hurtCrew(m.id, 9999);
    return m.id;
  `);
  await advance(TUNING.revive + 5);
  const stillDown = await run(`
    const m = peds.crew.byId(ARG);
    return { up: m.up, noRevive: m.noRevive, ward: m.isWard };
  `, wardId);
  rec('a noRevive ward stays down — the chapter is losable', !stillDown.up && stillDown.noRevive,
    `${wardId} up=${stillDown.up} noRevive=${stillDown.noRevive}`);

  await run(`peds.clearCrewWard(); peds.reviveCrew(ARG); return true;`, wardId);
  await advance(1);
  const back = await run(`return peds.crewAlive().length;`);
  rec('clearing the ward brings him back', back === 2, `${back}/2 on their feet`);
}

/* ===================================================================== */
/* 5 — the guard anchor                                                  */
/* ===================================================================== */
if (want('guard')) {
  group = 'guard';
  log('\n--- guard anchor ---------------------------------------------------');
  const anchor = await run(`
    const m = peds.crew.members[0];
    const p = player.position;
    const ax = p.x + 6, az = p.z + 6;
    peds.setCrewGuard(m.id, ax, az);
    return { id: m.id, ax, az };
  `);
  await advance(4);
  await run(`
    const p = player.position;
    player.teleport({ x: p.x + 34, y: p.y, z: p.z - 30 }, 0);
    return true;
  `);
  const held = await advance(9, `
    const m = peds.crew.byId(ARG_ID);
    return { d: +Math.hypot(m.ped.position.x - ARG_AX, m.ped.position.z - ARG_AZ).toFixed(2) };
  `.replace('ARG_ID', JSON.stringify(anchor.id))
    .replace('ARG_AX', anchor.ax).replace('ARG_AZ', anchor.az), 3);
  const finalD = held.samples[held.samples.length - 1].d;
  const other = await run(`
    const m = peds.crew.members.find((x) => !x.hasGuard);
    const p = player.position;
    return m ? +Math.hypot(m.ped.position.x - p.x, m.ped.position.z - p.z).toFixed(2) : null;
  `);
  rec(`a guarding brother holds his post (<= ${TUNING.guardHold + 3} m)`, finalD <= TUNING.guardHold + 3,
    `${finalD} m from the anchor while the player is 45 m away`);
  /* The claim here is "one being pinned does not pin the other" — he came the
     45 m. How TIGHTLY he trails is the `spacing` group's business, measured
     over 1500 samples of a real walk; asserting a tight number off one sample
     taken the instant a pavement detour happens to end is how this line read
     9.5 m against a 9.0 m threshold on an otherwise identical build. */
  rec('the other brother still follows', other !== null && other < 14,
    `${other} m behind after closing 45 m (the trail quality itself is the ` +
    'spacing group: median ~5 m, p99 under 16)');

  await run(`peds.setCrewGuard(peds.crew.members[0].id, null); return true;`);
}

/* ===================================================================== */
/* 6 — the advice system                                                 */
/* ===================================================================== */
if (want('advice')) {
  group = 'advice';
  log('\n--- advice ---------------------------------------------------------');

  /* the timer law, ticked deterministically: 18-32 s, 55% */
  const cadence = await run(`
    const crewSys = peds.crew;
    const m = crewSys.members[0];
    const realAdvise = crewSys.advise.bind(crewSys);
    let fires = 0, expiries = 0;
    const gaps = [];
    let last = 0, t = 0;
    crewSys.advise = () => { fires++; return true; };
    const prevCd = m.talkCd;
    m.talkCd = 0;
    const dt = 0.02;
    /**
     * 4 million ticks, not 400 thousand. At dt=0.02 the smaller loop is 8 000
     * simulated seconds and yields ~321 intervals — and 321 Bernoulli trials at
     * p=0.55 have a standard error of 0.028, so the +/-0.04 band below is only
     * 1.4 sigma and goes red roughly one run in six on a perfectly correct
     * build. It did: 0.592 (190/321). A gate that fails at random teaches
     * people to re-run it, which is worse than not having it.
     *
     * 80 000 s gives ~3 200 intervals, SE 0.0088, and the same band is 4.5
     * sigma. The loop runs in the page in well under a second.
     */
    for (let i = 0; i < 4000000; i++) {
      const before = m.talkCd;
      crewSys._tickTalk(m, dt);
      t += dt;
      if (m.talkCd > before) { expiries++; gaps.push(t - last); last = t; }
    }
    crewSys.advise = realAdvise;
    m.talkCd = prevCd;
    gaps.shift();                     // the primed first tick is not an interval
    const mean = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
    return { fires, expiries, mean: +mean.toFixed(2),
             min: +Math.min(...gaps).toFixed(2), max: +Math.max(...gaps).toFixed(2),
             rate: +(fires / Math.max(1, expiries)).toFixed(3), seconds: +t.toFixed(0) };
  `);
  rec('the advice timer is 18-32 s', cadence.min >= 17.9 && cadence.max <= 32.1,
    `${cadence.expiries} intervals over ${cadence.seconds} s, ${cadence.min}-${cadence.max} s, mean ${cadence.mean}`);
  rec('mean interval sits at 25 s', near(cadence.mean, 25, 0.6), `${cadence.mean} s`);
  rec('55% of them produce a line', near(cadence.rate, 0.55, 0.04),
    `${cadence.rate} (${cadence.fires}/${cadence.expiries})`);

  /* routing: it must go through `ui`, not through a DOM node of our own */
  const routed = await run(`
    const ui = ctx.peek('ui');
    if (!ui || typeof ui.say !== 'function') return { ok: false, why: 'ui.say missing' };
    const seen = [];
    const real = ui.say.bind(ui);
    ui.say = (who, text) => { seen.push({ who, text }); return real(who, text); };
    const id = peds.crew.members[0].id;
    for (let i = 0; i < 6; i++) peds.crewAdvise(id);
    ui.say = real;
    return { ok: true, seen, id };
  `);
  rec('advice is routed through ui.say (no bespoke HUD)', routed.ok && routed.seen.length === 6,
    routed.ok ? `${routed.seen.length} lines, speaker "${routed.seen[0]?.who}"` : routed.why);
  const distinct = new Set((routed.seen ?? []).map((s) => s.text)).size;
  rec('a shuffled deck — no repeats inside one lap', distinct === (routed.seen ?? []).length,
    `${distinct} distinct of ${routed.seen?.length ?? 0}`);
  rec('the lines are in the right brother\'s voice',
    (routed.seen ?? []).every((s) => s.who === routed.id), `all attributed to ${routed.id}`);

  /**
   * NEVER THE SAME LINE TWICE RUNNING — which is a stronger claim than "no
   * repeats inside a lap", and the one the player actually hears. A shuffled
   * deck is only unique WITHIN a lap: the last card of one deck and the first
   * of the next are consecutive, and about one reshuffle in `pool.length` used
   * to deal the same line twice in a row. 600 draws is fifty laps of the
   * longest pool, so it crosses the boundary plenty of times.
   */
  const longRun = await run(`
    const ui = ctx.peek('ui');
    const seen = [];
    const real = ui.say.bind(ui);
    ui.say = (who, text) => { seen.push(text); };
    const id = peds.crew.members[0].id;
    for (let i = 0; i < 600; i++) peds.crewAdvise(id);
    ui.say = real;
    let backToBack = 0, laps = 0;
    const pool = peds.crew.linesFor(id) ?? [];
    for (let i = 1; i < seen.length; i++) if (seen[i] === seen[i - 1]) backToBack++;
    laps = Math.floor(seen.length / Math.max(1, pool.length));
    return { n: seen.length, backToBack, laps, pool: pool.length,
             distinct: new Set(seen).size };
  `);
  rec('never the same line twice running', longRun.backToBack === 0,
    `${longRun.backToBack} back-to-back repeats in ${longRun.n} draws ` +
    `(${longRun.laps} laps of a ${longRun.pool}-line pool)`);
  rec('and the whole pool gets used', longRun.distinct === longRun.pool,
    `${longRun.distinct} of ${longRun.pool} lines heard`);

  /* the content bar: teach a mechanic, teach a control, be a family */
  const content = await run(`
    const out = {};
    for (const id of ['carson', 'aidan', 'dylan']) out[id] = peds.crew.linesFor(id) ?? [];
    return out;
  `);
  const KEYS = /\b(F|E|Q|V|H|M|X|P|Tab|Shift)\b/;
  const MECHANIC = /minimap|map\b|ring|pickup|respray|heat|wanted|nitro|sprint|armour|health|gas|fuel|weapon|camera|horn|switch|radius/i;
  const FAMILY = /Kali|Mom|Gabby|Lauren|Mike|Jessica|Bubfather|Don\b|brother|DeCarlo|Sunday|birthday|family|Primanti/i;
  for (const id of Object.keys(content)) {
    const uniq = [...new Set(content[id])];
    rec(`${id}: at least 8 distinct lines`, uniq.length >= 8, `${uniq.length} lines`);
    rec(`${id}: lines teach a control`, uniq.filter((l) => KEYS.test(l)).length >= 2,
      `${uniq.filter((l) => KEYS.test(l)).length} name a key`);
    rec(`${id}: lines teach a mechanic`, uniq.filter((l) => MECHANIC.test(l)).length >= 3,
      `${uniq.filter((l) => MECHANIC.test(l)).length} explain a system`);
    rec(`${id}: lines characterise the family`, uniq.filter((l) => FAMILY.test(l)).length >= 2,
      `${uniq.filter((l) => FAMILY.test(l)).length} are about the DeCarlos`);
  }
}

/* ===================================================================== */
/* 7 — boarding a vehicle                                                */
/* ===================================================================== */
if (want('vehicle')) {
  group = 'vehicle';
  log('\n--- vehicles -------------------------------------------------------');
  /**
   * THE ENTER EDGE, which is the one the player feels: the crew is at its
   * normal trail distance, you press F, everyone is in. So the car comes to
   * the crew, not the other way round.
   *
   * This used to teleport the player to `vehicles.nearest(..., 600)` — up to
   * six hundred metres, stranding both brothers by construction — and then
   * assert they hopped in. It measured the CATCH-UP path while claiming to
   * measure the enter edge, and scored 2/2, 1/2 or 0/2 depending on how far
   * away the traffic sim had parked something. The stranded-while-you-drive
   * group below is where the catch-up belongs, and it has its own control.
   */
  await stageAt();
  const placed = await run(`
    const veh = ctx.peek('vehicles');
    const w = ctx.peek('world');
    const p = player.position;
    /* The car comes to the player, four metres to his side. Spawning it at a
       lane parameter instead put it anywhere along the edge and then teleported
       the player to it — which strands the crew all over again and turns the
       enter-edge test back into a catch-up test. It scored 1/2. */
    const f = player.forward;
    const fn = Math.hypot(f.x, f.z) || 1;
    /* 2.6 m, not 4: player/vehicle.js only offers [F] inside its ENTER_REACH,
       and at 4 m the press did nothing and the group reported "the player got
       into the car: false" with a perfectly healthy crew standing 5 m back. */
    const sx = p.x - (f.z / fn) * 2.6;
    const sz = p.z + (f.x / fn) * 2.6;
    const gy = w.walkableHeightAt(sx, sz);
    const yaw = Math.atan2(-f.x / fn, -f.z / fn);
    let car = null;
    try { car = veh.spawn('sedan', { x: sx, y: gy + 0.6, z: sz }, yaw); } catch { car = null; }
    if (!car) car = veh?.nearest?.(p.x, p.y, p.z, 60);
    if (!car) return null;
    window.__VCAR__ = car;
    return { x: +car.position.x.toFixed(1), z: +car.position.z.toFixed(1),
             d: +Math.hypot(car.position.x - p.x, car.position.z - p.z).toFixed(1) };
  `);
  if (!placed) {
    rec('a vehicle was reachable', false, 'could not spawn or find a car');
  } else {
    // let them close to the 5 m trail BEFORE the door opens — that is the
    // scenario being measured
    await advance(6);
    await run(`
      window.__CREWTAP__.board.length = 0;
      window.__CREWTAP__.exit.length = 0;
      return true;
    `);
    const before = await run(`
      const veh = ctx.peek('vehicles');
      const p = player.position;
      const n = veh?.nearest?.(p.x, p.y, p.z, 60);
      return { crew: peds.crewState().map((s) => +s.distance.toFixed(1)),
               car: n ? +Math.hypot(n.position.x - p.x, n.position.z - p.z).toFixed(1) : null };
    `);
    // `movement.scriptedInput.use` is the documented harness edge for the
    // contextual action — a held KeyF exits and re-enters on the same press.
    const useF = async () => {
      await run(`
        const m = player.movement;
        m.scriptedInput = { ...(m.scriptedInput ?? { x: 0, y: 0, sprint: false, walk: false, crouch: false }), use: true };
        return true;
      `);
      await pump(6);
      await run('if (player.movement.scriptedInput) player.movement.scriptedInput.use = false; return true;');
    };
    await useF();
    await pump(190);
    const inCar = await run(`
      const liveHasCrew = peds.live.some((p) => p.isCrew);
      return {
        driving: !!player.inVehicle,
        crew: peds.crewState().map((s) => ({ id: s.id, inCar: s.inCar, x: +s.x.toFixed(1) })),
        bodies: peds.crew.members.filter((m) => m.ped && m.ped.body).length,
        inLive: liveHasCrew,
        board: window.__CREWTAP__.board.slice(),
        vx: player.vehicle ? +player.vehicle.position.x.toFixed(1) : null,
      };
    `);
    rec('the player got into the car', inCar.driving,
      `car ${before.car} m away, crew ${before.crew.join(' / ')} m behind`);
    if (inCar.driving) {
      const boarded = inCar.crew.filter((c) => c.inCar).length;
      rec(`the crew hops in (within ${TUNING.board} m)`, boarded === 2, `${boarded}/2 aboard, event ${JSON.stringify(inCar.board)}`);
      rec('a boarded brother releases his body', inCar.bodies === 0, `${inCar.bodies} skinned bodies still held`);
      rec('and leaves the crowd grid', !inCar.inLive, inCar.inLive ? 'still in peds.live' : 'out of peds.live');
      const tracking = await run(`
        const v = player.vehicle;
        return peds.crewState().every((s) => Math.hypot(s.x - v.position.x, s.z - v.position.z) < 1.5);
      `);
      rec('their map dots ride with the car', tracking, 'positions tracked to the vehicle');

      await useF();
      await pump(220);
      const out = await run(`
        const p = player.position;
        return {
          driving: !!player.inVehicle,
          pv: !!peds.crew._playerVehicle,
          crew: peds.crewState().map((s) => ({ id: s.id, inCar: s.inCar,
            d: +Math.hypot(s.x - p.x, s.z - p.z).toFixed(1) })),
          bodies: peds.crew.members.filter((m) => m.ped && m.ped.body).length,
          exit: window.__CREWTAP__.exit.slice(),
        };
      `);
      rec('they climb out beside you', !out.driving && out.crew.every((c) => !c.inCar),
        `driving=${out.driving} tracked=${out.pv} · ` +
        out.crew.map((c) => `${c.id} inCar=${c.inCar} ${c.d} m`).join(', '));
      rec('and get their bodies back', out.bodies === 2, `${out.bodies}/2 skinned`);
    }
    await run(`
      engine.input.enabled = false;
      player.movement.scriptedInput = null;
      const veh = ctx.peek('vehicles');
      if (window.__VCAR__) { try { veh.despawn(window.__VCAR__); } catch { /* fine */ } }
      window.__VCAR__ = null;
      return true;
    `);
  }
}

/* ===================================================================== */
/* 7b — STRANDED: drive away and he is never dumped on the carriageway    */
/* ===================================================================== */
/**
 * Boarding anyone within 30 m on the instant you get in and abandoning the
 * rest forever is not a rounding error in a 3 km city, and the first build
 * here did something worse than abandon them: the follow leash
 * fired at 92 m, the anchor it warped to was THE PLAYER, and the player was a
 * moving car — so a brother was teleported onto the tarmac four metres in front
 * of it, hit, and teleported back, on a loop.
 *
 * This drives the car away from a standing start and asserts the two things
 * that matter:
 *
 *   he is never ON THE ROAD next to the moving car (the warp bug), and
 *   he is aboard within `catchUp` seconds (he is not abandoned either).
 *
 * NEGATIVE CONTROL: `catchUpEnabled = false` is the abandon-forever build.
 */
if (want('stranded')) {
  group = 'stranded';
  log('\n--- stranded while you drive ---------------------------------------');
  const CATCH = 5.0;

  const stage = async (catchUp) => {
    // Same fixed street every run: "the car covered 3 m in 11 s" was not a
    // drivetrain finding, it was a cul-de-sac the previous group had left the
    // player standing in.
    await stageAt(0, 0);
    const ok = await run(`
      const veh = ctx.peek('vehicles');
      const w = ctx.peek('world');
      const p = player.position;
      peds.crew.catchUpEnabled = ARG;
      peds.spawnCrew();
      /*
       * SPAWN the car on a lane centre, pointing down the lane. Taking
       * vehicles.nearest() gave whatever the traffic sim had parked within
       * 600 m — on separate runs that was a car boxed in by two others, a
       * truck facing a wall, and once something in a cul-de-sac. The reported
       * numbers were 62 m, 10.6 m and 2 m of travel in the same 11 seconds,
       * none of which were about the crew. Ours, on a lane, every time.
       */
      const n = w?.roads?.nearestEdge?.(p.x, p.z);
      let sx = p.x + 5, sz = p.z, yaw = 0, gy = w.walkableHeightAt(sx, sz);
      if (n && n.edge) {
        const a = w.roads.laneCenter(n.edge.id, n.lane ?? 0, 0.30, { x: 0, y: 0, z: 0 });
        const b = w.roads.laneCenter(n.edge.id, n.lane ?? 0, 0.60, { x: 0, y: 0, z: 0 });
        sx = a.x; sz = a.z; gy = a.y;
        yaw = Math.atan2(b.x - a.x, b.z - a.z);
      }
      let car = null;
      try { car = veh.spawn('sedan', { x: sx, y: gy + 0.6, z: sz }, yaw); } catch { car = null; }
      if (!car) car = veh?.nearest?.(p.x, p.y, p.z, 600);
      if (!car) return null;
      player.teleport({ x: car.position.x + 2.2, y: car.position.y + 1.0, z: car.position.z }, yaw);
      player.rig.yaw = yaw;
      window.__CAR2__ = car;
      window.__CREWTAP__.board.length = 0;
      window.__CREWTAP__.hurt.length = 0;
      return true;
    `, catchUp);
    if (!ok) return null;
    await advance(1.2);
    // get in, then put both brothers a long way behind so the enter edge
    // cannot pick them up, and drive
    await run(`
      const m = player.movement;
      m.scriptedInput = { ...(m.scriptedInput ?? { x: 0, y: 0, sprint: false, walk: false, crouch: false }), use: true };
      return true;
    `);
    await advance(0.4);
    await run('if (player.movement.scriptedInput) player.movement.scriptedInput.use = false; return true;');
    await advance(0.6);
    const driving = await run(`
      if (!player.inVehicle) return false;
      const v = player.vehicle;
      peds.crew.members.forEach((m, i) => {
        if (m.inCar) { m.inCar = false; m.vehicle = null; m.ped.vehicle = null; m.ped.seat = -1; m.ped.state = 'crew'; }
        m.catchUp = 0;
        /* 120 m, not 55. At 55 m a brother closes the gap on foot before the
           catch-up timer expires — he runs at 7.4 m/s and a car pulling away
           down a city street averages about 3 — so BOTH arms of the A/B ended
           with him aboard through the 30 m door and the control proved nothing.
           At 120 m the walk cannot close it inside the window, so the only way
           in is the catch-up. It is also past the 92 m leash, which is the
           branch that used to teleport him onto the carriageway. */
        m.ped.position.set(v.position.x - 120 - i * 6, v.position.y, v.position.z - 12);
        m.ped.position.y = peds.groundAt(m.ped.position.x, m.ped.position.z, m.ped.position.y + 20);
        m.ped.groundY = m.ped.position.y;
      });
      window.__CREWTAP__.board.length = 0;
      window.__CREWTAP__.hurt.length = 0;
      window.__CARP0__ = { x: v.position.x, z: v.position.z };
      /*
       * Throttle goes through player.movement.scriptedInput, NOT
       * vehicles.setInput. VehicleHandler pushes its own resolved pedals to
       * setInput every single frame while the player is seated, so a direct
       * call is overwritten before the next step — the first version of this
       * test did exactly that and reported a top speed of 0.6 m/s, which is
       * "the car rolled", not "the car drove".
       */
      player.movement.scriptedInput = { x: 0, y: 1, sprint: true, walk: false, crouch: false };
      return true;
    `);
    if (!driving) return null;
    /** Every sample: how far each ON-FOOT brother is from the moving car. A
     *  man on foot inside `DANGER` of a car under power is the warp bug. */
    const s = await advance(11, `
      const v = player.vehicle;
      if (!v) return null;
      let nearestOnFoot = 9e9, onFoot = 0, aboard = 0;
      for (const m of peds.crew.members) {
        if (m.inCar) { aboard++; continue; }
        onFoot++;
        const d = Math.hypot(m.ped.position.x - v.position.x, m.ped.position.z - v.position.z);
        if (d < nearestOnFoot) nearestOnFoot = d;
      }
      const a = window.__CARP0__;
      return { aboard, onFoot, near: nearestOnFoot > 8e9 ? null : +nearestOnFoot.toFixed(1),
               // DISPLACEMENT, not velocity.length(): unsigned speed scored a
               // build that could only reverse. This is where the car IS.
               moved: +Math.hypot(v.position.x - a.x, v.position.z - a.z).toFixed(1),
               t: engine.time.elapsed,
               hurt: window.__CREWTAP__.hurt.length, board: window.__CREWTAP__.board.length };
    `, 8);
    const samples = s.samples.filter(Boolean);
    await run('player.movement.scriptedInput = null; return true;');
    return { samples, dt: s.dt };
  };

  const on = await stage(true);
  if (!on) {
    rec('a car was reachable to drive off in', false, 'no vehicle, or the player never got in');
  } else {
    const drove = Math.max(...on.samples.map((r) => r.moved));
    const aboardAt = on.samples.findIndex((r) => r.aboard === 2);
    // only the frames where he is genuinely stranded AND the car has left:
    // standing next to the car in the first second is not the warp bug
    const dumped = on.samples.filter((r) => r.onFoot > 0 && r.near !== null &&
      r.near < 12 && r.moved > 20).length;
    const hurt = on.samples[on.samples.length - 1]?.hurt ?? 0;

    rec('the car actually drove off', drove > 25,
      `the car covered ${drove} m in ${on.dt.toFixed(0)} s — a city street with ` +
      'traffic and junctions on it, not a drag strip');
    rec('nobody is ever dumped on the road beside the moving car', dumped === 0,
      `${dumped} samples with a brother on foot inside 12 m of the car after it ` +
      'had already covered 20 m (this is the warp bug: the leash used to teleport ' +
      'him to the player, and the player was the car)');
    rec('and the car never runs one of them over', hurt === 0,
      `${hurt} crew:hurt events while driving away`);
    rec(`both catch up and are aboard inside ${CATCH} s`, aboardAt >= 0,
      aboardAt >= 0
        ? `aboard by ${(on.samples[aboardAt].t - on.samples[0].t).toFixed(1)} s ` +
          `(catchUp ${CATCH} s), ${on.samples[aboardAt].board} crew:board events`
        : 'never boarded');
  }

  const off = await stage(false);
  if (off) {
    const everAboard = off.samples.some((r) => r.aboard > 0);
    const far = Math.max(...off.samples.map((r) => r.near ?? 0));
    const stillOut = off.samples[off.samples.length - 1]?.near ?? 0;
    rec('NEGATIVE CONTROL: without the catch-up they are simply abandoned',
      !everAboard,
      `catchUpEnabled=false: 0 aboard after ${off.dt.toFixed(0)} s, ` +
      `still ${stillOut} m behind (peaked at ${far.toFixed(0)} m) — and note he ` +
      'is on his feet running, never teleported into traffic');
  }
  await run(`
    peds.crew.catchUpEnabled = true;
    if (player.inVehicle) { const v = player.vehicle; ctx.peek('vehicles').setInput(v, { throttle: 0, brake: 1 }); }
    player.movement.scriptedInput = null;
    return true;
  `);
  await advance(2);
  await run(`
    if (player.inVehicle) {
      const m = player.movement;
      m.scriptedInput = { x: 0, y: 0, sprint: false, walk: false, crouch: false, use: true };
    }
    return true;
  `);
  await advance(0.5);
  await run('player.movement.scriptedInput = null; peds.spawnCrew(); return true;');
  await advance(2);
}

/* ===================================================================== */
/* 8 — cost                                                              */
/* ===================================================================== */
if (want('cost')) {
  group = 'cost';
  log('\n--- cost -----------------------------------------------------------');
  // Back to a real street with a real crowd on it first. By this point the
  // suite has teleported the player a dozen times and the streamer has been
  // chasing him; one run sampled a cost of "33 µs/ped over 3 live peds versus
  // 0 µs over 1", which is a measurement of an empty city, not of the crew.
  await stageAt();
  await advance(6);
  // Sampled with the crew live, then again with them despawned, so the delta
  // is the honest cost of the feature rather than whatever the street was
  // doing that second.
  const sample = `
    return { peds: +peds.stats.ms.toFixed(4), crew: +peds.crew.stats.ms.toFixed(4),
             live: peds.stats.live, bodies: peds.stats.bodies };
  `;
  const withCrew = await advance(7, sample, 12);
  await run('peds.despawnCrew(); return true;');
  await advance(2);
  const without = await advance(7, sample, 12);
  await run('peds.spawnCrew(); return true;');

  const med = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const s = withCrew.samples;
  const pedMs = med(s.map((x) => x.peds));
  const crewMs = med(s.map((x) => x.crew));
  const live = med(s.map((x) => x.live));
  const soloMs = med(without.samples.map((x) => x.peds));
  const soloLive = med(without.samples.map((x) => x.live));
  rec('the crew brain is under 0.05 ms', crewMs < 0.05, `${crewMs.toFixed(4)} ms p50 for 2 brothers`);
  rec('the whole ped system stays in budget', pedMs < 1.1,
    `${pedMs.toFixed(3)} ms p50 for ${live} peds (${(pedMs * 1000 / Math.max(1, live)).toFixed(1)} µs each), q=${Q}`);
  /**
   * PER-PED, not per-frame. `performance.now()` in this browser is quantised to
   * 100 µs, so a raw "with minus without" of two numbers that are themselves
   * one or two quanta is a coin toss dressed as a measurement — it read 0 µs on
   * one run and exactly 100 µs on the next, against a 100 µs threshold, with
   * the two arms carrying DIFFERENT populations (9 peds vs 5) because the
   * streamer refills the street while the crew is away.
   *
   * Dividing by the live count normalises the population out, and comparing
   * per-ped costs is the honest question: does a brother cost more to run than
   * a pedestrian? He should not — same rig, same animator, a different brain.
   */
  const perWith = pedMs * 1000 / Math.max(1, live);
  const perSolo = soloMs * 1000 / Math.max(1, soloLive);
  /**
   * ...AND ONLY WHEN THERE IS A CROWD TO COMPARE AGAINST. On a quiet street
   * the streamer's target can be two or three people, and `0.1 ms / 2 peds`
   * versus `0.1 ms / 4 peds` is a comparison between two single ticks of a
   * 100 µs clock. It read "25.0 µs/ped with the crew vs 0.0 without" and went
   * red on a build whose cost had not changed.
   *
   * Below six live peds in either arm the ratio is not evidence and is not
   * asserted. What IS asserted in that case is the absolute bound, which never
   * stops meaning something — and the crew's own brain time is gated
   * separately above, independently of the population entirely.
   */
  const enough = live >= 6 && soloLive >= 6;
  rec('a brother costs no more to run than a stranger',
    enough ? perWith <= perSolo + 12 : pedMs < 1.1,
    enough
      ? `${perWith.toFixed(1)} µs/ped with the crew (${live} live) vs ${perSolo.toFixed(1)} µs/ped ` +
        `without (${soloLive} live); timer quantum is 100 µs, so the tolerance is ` +
        `~half a quantum spread over ${live} peds`
      : `street too quiet to divide by (${live} / ${soloLive} live, need 6); ` +
        `falling back to the absolute bound: ${pedMs.toFixed(3)} ms for the whole system`);
}

/* ===================================================================== */
/* 9 — a photograph of wherever they actually are                        */
/* ===================================================================== */
if (args.png) {
  group = 'photo';
  log('\n--- photograph -----------------------------------------------------');
  // A quiet Lawrenceville street with the pile-up cleared, so the frame is
  // about the brothers and not about traffic.
  await run(`
    peds.spawnCrew();
    return window.__APPLY_SHOT__(JSON.stringify({
      pos: [680, 4.5, -520], look: [640, 4, -600], fov: 58, time: 16.8,
      ground: true, clearTraffic: 48,
    }));
  `);
  await pump(40);
  await advance(14);            // let them walk in from wherever they were
  await run(`ctx.peek('sky')?.setTimeOfDay?.(16.8); return true;`);
  await pump(30);
  const framed = await run(`
    const st = peds.crewState();
    if (st.length < 1) return null;
    const cam = engine.camera;
    // midpoint of the two brothers, and a camera 7.5 m back from it on the
    // side the player is standing — no repositioning of anybody
    let cx = 0, cz = 0, cy = 0;
    for (const s of st) { cx += s.x; cz += s.z; cy += s.y; }
    cx /= st.length; cz /= st.length; cy /= st.length;
    const p = player.position;
    let dx = cx - p.x, dz = cz - p.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    cam.position.set(cx - dx * 7.5, cy + 1.85, cz - dz * 7.5);
    cam.lookAt(cx, cy + 1.05, cz);
    cam.fov = 46; cam.updateProjectionMatrix();
    window.__PRESHUTTER__?.();
    return { crew: st.map((s) => ({ id: s.id, x: +s.x.toFixed(1), z: +s.z.toFixed(1),
      d: +s.distance.toFixed(1), up: s.up })),
      cam: [+cam.position.x.toFixed(1), +cam.position.y.toFixed(1), +cam.position.z.toFixed(1)] };
  `);
  await pump(6);
  await page.screenshot({ path: args.png, type: 'png' });
  rec('a frame with the crew in it', !!framed,
    framed ? `${framed.crew.map((c) => `${c.id} ${c.d} m behind`).join(', ')} -> ${args.png}` : 'no crew');
}

/* ===================================================================== */

const passed = results.filter((r) => r.ok).length;
const ours = pageErrors.filter((e) => /src\/peds\//.test(e));
const foreign = [...new Set(pageErrors.filter((e) => !/src\/peds\//.test(e) && !/favicon/i.test(e)))];

const summary = {
  passed, total: results.length,
  pedsErrors: ours.slice(0, 8),
  foreignErrors: foreign.slice(0, 6),
  errorCount: errFlood,
  results,
};

if (JSON_OUT) console.log(JSON.stringify(summary, null, 2));
else {
  log('\n===================================================================');
  log(`  crew behaviour   ${passed}/${results.length}`);
  log(`  peds errors      ${ours.length}`);
  for (const e of ours.slice(0, 5)) log(`     ! ${e}`);
  if (foreign.length) {
    log(`  other subsystems ${foreign.length} distinct error(s) — not gated here`);
    for (const e of foreign.slice(0, 4)) log(`     ~ ${e.slice(0, 140)}`);
  }
  log('===================================================================\n');
}

await browser.close();
server?.kill();
process.exit(passed === results.length && ours.length === 0 ? 0 : 1);
