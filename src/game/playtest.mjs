#!/usr/bin/env node
/**
 * GAME — headless chapter harness.
 *
 * `tools/playtest.mjs` proves the engine boots and the player moves. This
 * proves the GAME works: it drives every one of the 24 story chapters from
 * `mission:start` to `mission:complete` inside a real browser running the real
 * engine, and asserts on the way through that
 *
 *   - the track spawned what it said it would (a delivery has a vehicle, a
 *     goons wave has five hostiles, a race has its checkpoints);
 *   - the objective panel is actually being driven, not left blank;
 *   - the win condition fires off real world state, not a flag;
 *   - the payout lands in the economy and `money:change` is emitted;
 *   - respect accrues and chapter progression advances;
 *   - the fail conditions fire (a wrecked delivery vehicle, an expired clock);
 *   - a save round-trips through localStorage byte for byte.
 *
 * Everything the harness does to *cause* a win goes through the same state the
 * game itself reads — killing a hostile calls the pool's damage path, taking a
 * crate walks the player into it, hitting a checkpoint teleports him through
 * the gate. The two exceptions are labelled `SIMULATED` in the output: driving
 * a mission vehicle to its drop (we move the handle rather than steering for
 * two minutes) and expiring a 95-second survival clock.
 *
 * Beyond the chapters it asserts the story-shape rules: the boss's post-death
 * ESCAPE phase completes only at zero stars,
 * a protect ward dying fails the chapter, death mid-chapter RESTARTS the
 * chapter instead of aborting it, hard difficulty puts `timedStory` clocks on
 * untimed tracks, the result card waits for the `done` dialogue beats, and
 * the final chapter ends in `ending:play` + the all-weapons unlock rather
 * than a payout card. Each of those carries its own negative control.
 *
 *   node src/game/playtest.mjs                # all 24 chapters
 *   node src/game/playtest.mjs --boy=carson   # one brother
 *   node src/game/playtest.mjs --chapter=carson:3
 *   node src/game/playtest.mjs --quick        # one chapter per track type
 *   node src/game/playtest.mjs --json
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
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

const BOYS = ['carson', 'aidan', 'dylan'];

/* ===================================================================== */

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

// A page that throws every frame will flood the CDP pipe faster than node
// drains it — measured as `ERR_STRING_TOO_LONG` inside playwright's transport,
// which looks like a harness bug and is not one. Cap hard, keep the first few.
const ERR_CAP = 60;
const pageErrors = [];
let errFlood = 0;
const noteError = (t) => {
  errFlood++;
  if (pageErrors.length < ERR_CAP) pageErrors.push(String(t).slice(0, 300));
};
page.on('pageerror', (e) => noteError(e.message));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') noteError(t);
  else if (!JSON_OUT && t.startsWith('[game]')) console.log('   ' + t);
});

await page.goto(`http://127.0.0.1:${port}/?q=low&prewarm=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__READY__===true', null, { timeout: 90000 });
await page.waitForFunction('window.__SETTLED__ ? window.__SETTLED__() : true', null, { timeout: 90000 });

/**
 * `--trace` prints the label of every page round trip to stderr BEFORE it is
 * made. A `page.evaluate` that returns a live engine object serialises the
 * whole scene graph and kills the CDP transport with `ERR_STRING_TOO_LONG`
 * from inside playwright, which gives no clue which call did it. With the
 * trace on, the last line before the crash is the culprit.
 */
const TRACE = !!args.trace;
let traceLabel = '';
const trace = (l) => { traceLabel = l; if (TRACE) console.error(`    · ${l}`); };

/* ===================================================================== */
/* FAIL FAST — a hang is a finding, not a wait                            */
/* ===================================================================== */

/**
 * THE SUITE MUST NEVER HANG. It hung for 1 h 14 m once (a wedged clock, see
 * `awaitClock` below) and that single run hid every chapter after it plus the
 * whole dylan arc — a suite that stops answering is worse than a red one,
 * because it blocks everything downstream AND reports nothing.
 *
 * Two independent stops, because they fail differently:
 *   - `STEP_MS`   — one page round trip that never comes back. Anything in the
 *                   page that awaits a condition can stop being true forever;
 *                   this catches it without the caller having to think about it.
 *   - `BUDGET_MS` — the whole run. Nothing stalls, everything is just ten times
 *                   slower than it should be — a per-call cap never fires and
 *                   the wall clock still disappears.
 *
 * Both print the last trace label and the results so far, then exit 1. They are
 * deliberately fatal: a timeout means the page is not answering questions, so
 * every verdict after it would be a guess.
 */
const STEP_MS = Number(args.steptimeout ?? 90000);
const BUDGET_MS = Number(args.budget ?? 20 * 60 * 1000);
const T_START = Date.now();
/** Declared here, not at the run block, so `bail` can print it from a timer. */
const results = [];

let bailing = false;
async function bail(why) {
  if (bailing) return;
  bailing = true;
  console.log(`\n  HARNESS TIMEOUT — ${why}`);
  console.log(`  last page round trip: ${traceLabel || '(none)'}`);
  console.log(`  ${results.length} chapter(s) finished before the stall:`);
  for (const r of results) {
    console.log(`    ${r.ok ? 'PASS' : 'FAIL'}  ${r.boy} ${r.no ?? '?'} ${r.track ?? ''} ${r.note ?? r.reason ?? ''}`);
  }
  console.log('');
  try { await browser.close(); } catch { /* the page may already be gone */ }
  server?.kill();
  process.exit(1);
}

/** Every round trip carries a deadline. `label` is what gets printed if it hits. */
function deadline(p, label) {
  if (Date.now() - T_START > BUDGET_MS) {
    bail(`the run passed its ${Math.round(BUDGET_MS / 1000)} s budget at "${label}"`);
  }
  let timer = null;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise(() => {
      timer = setTimeout(() => bail(`no answer for ${STEP_MS} ms from "${label}"`), STEP_MS);
    }),
  ]);
}

/** Advance n engine frames. */
const pump = (n = 1) => {
  trace(`pump(${n})`);
  return deadline(page.evaluate((k) => window.__PUMP__(k), n), `pump(${n})`);
};

/** Run a function inside the page with `game`, `engine` and helpers bound. */
const inGame = (fn, arg) => {
  const label = `eval ${fn.trim().split('\n')[0].slice(0, 70)}`;
  trace(label);
  return deadline(page.evaluate(
    ({ src, arg: ARG }) => {
      const engine = window.__ENGINE__;
      const game = engine.ctx.get('game');
      const player = engine.ctx.peek('player');
      const vehicles = engine.ctx.peek('vehicles');
      // `ARG`, not `a` — page snippets declare their own locals and one of them
      // used `a`, which shadowed the parameter and threw a SyntaxError.
      // eslint-disable-next-line no-new-func
      const f = new Function('engine', 'game', 'player', 'vehicles', 'ARG', src);
      return f(engine, game, player, vehicles, ARG);
    },
    { src: fn, arg: arg ?? null }
  ), label);
};

/**
 * Wait, in the page, until `cond` (a JS expression string over the same locals
 * `inGame` binds) is true or `cap` GAME seconds have passed. The suite runs
 * free-running, so timers like the 6-second pickup respawn advance on the
 * engine clock — pumped frame counts are not seconds, this is.
 *
 * The game clock is the right budget for a game-timed wait and the WRONG one to
 * bound the loop with, because a paused sim stops advancing it: `time.elapsed`
 * only grows by `raw * scale`, and a modal overlay pins `scale` at 0. Capped on game
 * seconds alone this returned never, in the page, with rAF still firing —
 * which is exactly how one wedged chapter cost a 74-minute run. `time.raw` is
 * unscaled and always moves, so it can always end the wait.
 */
const waitGame = (cond, cap) => inGame(`
  return new Promise((done) => {
    const T = () => (engine.time && engine.time.elapsed) || 0;
    const RAW = () => (engine.time && engine.time.raw) || 0;
    const t0 = T();
    const r0 = RAW();
    const tick = () => {
      let ok = false;
      try { ok = !!(${cond}); } catch { ok = false; }
      const t = T() - t0;
      const raw = RAW() - r0;
      const frozen = raw >= ARG.cap * 3 + 6;
      if (ok || t >= ARG.cap || frozen) {
        return done({ ok, t: +t.toFixed(2), raw: +raw.toFixed(2), frozen: frozen && !ok });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });`, { cap });

/* ===================================================================== */
/* the sim clock                                                          */
/* ===================================================================== */

/**
 * The overlays that hold `ctx.time.scale` at 0 (`ui._updateModalPause`), in the
 * order `ui` itself stands them down when the ending takes the screen.
 */
const MODALS = `
  const ui = engine.ctx.peek('ui');
  const modal = [];
  if (ui) {
    if (ui.ending && ui.ending.active) modal.push('ending');
    if (ui.story && ui.story.open) modal.push('story');
    if (ui.map && ui.map.open) modal.push('map');
    if (ui.phone && ui.phone.open) modal.push('phone');
    if (ui.menu && ui.menu.open) modal.push('menu');
    if (ui.bigCard && ui.bigCard.active) modal.push('card');
  }`;

/**
 * PUT THE CLOCK BACK BEFORE THE NEXT CHAPTER. The finale ends in the ending
 * sequencer, which owns the whole screen until the player presses PLAY FREE
 * ROAM — and `ui` freezes the sim for as long as it is up. Nothing here used to
 * dismiss it, so every chapter after `final` ran at `dt === 0`: spatial and
 * kill-counted wins still fired (13 of 16 chapters passed), while anything that
 * INTEGRATES time — the partner repair fill, a `survive` clock, a chapter
 * restart — sat exactly where it started, forever.
 *
 * Dismissed through the real button, not by poking `active`, so this is the
 * player's own exit and not a harness back door.
 */
const resumeSim = () => inGame(`
  ${MODALS}
  if (ui) {
    if (ui.ending && ui.ending.active) {
      if (ui.ending.btn && ui.ending.btn.click) ui.ending.btn.click();
      if (ui.ending.active) ui.ending.close();
    }
    if (ui.story && ui.story.open) ui.story.hide();
    if (ui.map && ui.map.open) ui.map.hide();
    if (ui.phone && ui.phone.open) ui.phone.hide();
    if (ui.menu && ui.menu.open) ui.menu.close();
    // The result card is a 4.6-second transient that retires itself on RAW
    // time. Hand it that time through its own update rather than sitting
    // through it — the same licence the suite already takes with subs.clear().
    if (ui.bigCard && ui.bigCard.active && typeof ui.bigCard.update === 'function') {
      ui.bigCard.update((ui.bigCard.life ?? 5) + 1);
    }
  }
  return modal;`);

/**
 * Pump n frames of LIVE simulation.
 *
 * Anything that measures a countdown, a decay or a restart timer must use this
 * rather than `pump`, because the step before it usually ended a mission — and
 * a mission that ends puts up the JOB DONE / WASTED card, which pauses the sim
 * for 4.6 seconds. Frames still tick while it is up and `time.dt` is zero, so
 * the symptom is not an error: it is a timer that simply never expired, which
 * reads as a broken fail condition. Four "systems" assertions in this file were
 * red for exactly that reason.
 */
const pumpLive = async (n = 1) => {
  await resumeSim();
  return pump(n);
};

/**
 * IS THE SIM ACTUALLY RUNNING? Asked of the emitted clock — how far
 * `time.elapsed` moved across real frames — not of `time.scale`, which is the
 * input the pause path writes and would be answering its own question.
 *
 * Bounded, and it waits rather than failing on the first frame: some of what
 * holds the clock is legitimately transient (the JOB DONE card). What is NOT
 * allowed is a clock that never starts — that is the state in which every
 * time-integrating track is uncompletable, and the whole point of asking here
 * is to say so in seconds with the guilty overlay named.
 */
const awaitClock = (capFrames = 1200) => inGame(`
  return new Promise((done) => {
    const e0 = engine.time.elapsed;
    const r0 = engine.time.raw;
    let n = 0;
    const tick = () => {
      ${MODALS}
      const adv = engine.time.elapsed - e0;
      if (adv > 0 || ++n >= ARG) {
        return done({ advanced: +adv.toFixed(4), frames: n, scale: engine.time.scale,
                      raw: +(engine.time.raw - r0).toFixed(2), modal });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });`, capFrames);

/* ---- install the event tap ------------------------------------------- */
await inGame(`
  const ev = { start: [], complete: [], fail: [], money: [], wanted: [], deaths: [],
               unlocks: [], picks: [], offers: [], diff: [], ecash: [], ending: [] };
  window.__TAP__ = ev;
  engine.events.on('mission:start',    (e) => ev.start.push({ ...e }));
  engine.events.on('mission:complete', (e) => ev.complete.push({ ...e }));
  engine.events.on('mission:fail',     (e) => ev.fail.push({ ...e }));
  engine.events.on('ending:play',      (e) => ev.ending.push({ boy: e.boy, slides: (e.slides || []).length }));
  engine.events.on('money:change',     (e) => ev.money.push({ ...e }));
  engine.events.on('wanted:change',    (e) => ev.wanted.push({ ...e }));
  engine.events.on('actor:death',      () => ev.deaths.push(1));
  engine.events.on('game:unlock',      (e) => ev.unlocks.push({ ...e }));
  engine.events.on('pickup:collect',   (e) => ev.picks.push({ ...e }));
  engine.events.on('job:offer',        (e) => ev.offers.push({ ...e }));
  engine.events.on('game:difficulty',  (e) => ev.diff.push({ ...e }));
  engine.events.on('economy:cash',     (e) => ev.ecash.push({ ...e }));
  // A clean slate every run, so a stale localStorage save cannot make a
  // chapter look already-completed.
  game.newGame();
  engine.input.enabled = false;
  return true;
`);
await pump(4);

/* ===================================================================== */
/* the per-track "how do I finish this" table                             */
/* ===================================================================== */

/**
 * Each entry runs inside the page and drives the live mission to its win
 * condition using real world state. Returns a short note for the report.
 */
const SOLVERS = {
  deliver: `
    const M = game.missions.M;
    if (!M.veh) return 'no vehicle spawned';
    game.wq.placePlayer(M.veh.position.x + 1.6, M.veh.position.z + 1.6, 0);
    return 'board';`,

  timedDeliver: null, // same as deliver

  goons: `
    const M = game.missions.M;
    let n = 0;
    for (const h of M.spawnedHostiles) { if (!h.dead) { game.hostiles.hurt(h, 99999, false, h.position); n++; } }
    return 'killed ' + n;`,

  brawl: null, // same as goons

  race: `
    const M = game.missions.M;
    return 'checkpoints ' + M.points.length + ' x' + M.laps;`,

  chase: `
    const M = game.missions.M;
    if (!M.target) return 'no target';
    vehicles.damage(M.target, M.target.health + 10, M.target.position);
    return 'wrecked target';`,

  escape: `
    game.heat.clear('harness');
    const M = game.missions.M;
    M.graceT = -1;
    return 'heat cleared';`,

  collect: `
    const M = game.missions.M;
    return 'crates ' + M.spawnedPickups.length;`,

  survive: `
    const M = game.missions.M;
    M.timer = 0.05;
    return 'SIMULATED clock expiry (' + Math.round(M.duration) + 's)';`,

  escort: `
    const M = game.missions.M;
    if (!M.ally) return 'no ally';
    M.ally.position.set(M.dest.x, M.ally.position.y, M.dest.z);
    return 'SIMULATED drive to ' + M.dest.name;`,

  rampage: `
    const M = game.missions.M;
    let n = 0;
    for (const v of M.spawnedVehicles) { if (v.isRampage && !v.destroyed) { vehicles.damage(v, v.health + 10, v.position); n++; } }
    return 'wrecked ' + n;`,

  boss: `
    const M = game.missions.M;
    if (M.bossEnt) { game.hostiles.hurt(M.bossEnt, 99999, false, M.bossEnt.position); return 'downed ' + M.B.name; }
    if (M.bossVeh) { vehicles.damage(M.bossVeh, M.bossVeh.health + 10, M.bossVeh.position); return 'wrecked ' + M.B.name; }
    return 'no boss';`,
};

/** Multi-step solvers that need frames between actions. */
async function solveMulti(track) {
  if (track === 'deliver' || track === 'timedDeliver') {
    // Board through `player`'s real enter transition, then SIMULATE the drive.
    await inGame(`return game.missions.M && game.missions.M.veh ? game.debugBoard(game.missions.M.veh) : false;`);
    await pump(50);
    let note = await inGame(`
      const M = game.missions.M;
      return game.wq.playerVehicle() === M.veh ? 'boarded' : 'NOT BOARDED';`);
    // The drop is up to a kilometre away; walk the vehicle there over a few
    // frames rather than steering it for two minutes of wall clock.
    for (let i = 0; i < 6; i++) {
      await inGame(`
        const M = game.missions.M;
        if (!M || !M.veh || M.state !== 'run') return false;
        const v = M.veh;
        v.position.x += (M.dest.x - v.position.x) * 0.55;
        v.position.z += (M.dest.z - v.position.z) * 0.55;
        return true;`);
      await pump(3);
      if (await inGame(`return !game.missions.M || game.missions.M.state !== 'run';`)) break;
    }
    return `${note} + SIMULATED drive to the drop`;
  }

  if (track === 'race') {
    // Walk the player through every gate of every lap, for real. The loop runs
    // IN THE PAGE — a round trip per frame turns a 90-second suite into a
    // 40-minute one at headless frame rates.
    const info = await inGame(SOLVERS.race);
    await inGame(`
      return new Promise((done) => {
        let n = 0;
        const tick = () => {
          const M = game.missions.M;
          if (!M || M.state !== 'run' || ++n > 400) return done(n);
          const cp = M.points[M.cpIdx];
          const v = game.wq.playerVehicle();
          if (v) v.position.set(cp.x, v.position.y, cp.z);
          game.wq.placePlayer(cp.x, cp.z, 0);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });`);
    return info + ', driven';
  }

  if (track === 'collect') {
    const info = await inGame(SOLVERS.collect);
    await inGame(`
      return new Promise((done) => {
        let n = 0;
        const tick = () => {
          const M = game.missions.M;
          if (!M || M.state !== 'run' || ++n > 400) return done(n);
          const p = game.pickups.nearestMission(game.wq.playerPos().x, game.wq.playerPos().z);
          if (p) game.wq.placePlayer(p.x, p.z, 0, p.y - 1.0);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });`);
    return info + ', walked';
  }

  if (track === 'recover') {
    // Board each marked car through the real enter transition, walk it to the
    // home ring, and record what the FIRST delivery did to the player: the
    // reference force-exits him and unmarks the car, and both would read
    // wrong (aboard=true / still marked) if that regressed.
    const facts = { deliveries: 0, forceExitOk: false, unmarkOk: false };
    for (let k = 0; k < 4; k++) {
      const picked = await inGame(`
        const M = game.missions.M;
        if (!M || M.state !== 'run') return null;
        const v = M.spawnedVehicles.find((v) => v._marked && !v.destroyed);
        if (!v) return null;
        window.__recVeh = v;
        return game.debugBoard(v);`);
      if (picked === null) break;
      await pump(50);
      for (let i = 0; i < 8; i++) {
        await inGame(`
          const M = game.missions.M;
          const v = window.__recVeh;
          if (!M || M.state !== 'run' || !v) return false;
          v.position.x += (M.dest.x - v.position.x) * 0.6;
          v.position.z += (M.dest.z - v.position.z) * 0.6;
          return true;`);
        await pump(4);
        const st = await inGame(`
          const M = game.missions.M;
          const v = window.__recVeh;
          return M ? { prog: M.progress, state: M.state, aboard: !!game.wq.playerVehicle(),
                       marked: !!(v && v._marked) } : { prog: -1, state: 'over' };`);
        if (st.prog > facts.deliveries) {
          if (facts.deliveries === 0) {
            facts.forceExitOk = !st.aboard;
            facts.unmarkOk = !st.marked;
          }
          facts.deliveries = st.prog;
          break;
        }
        if (st.state !== 'run') break;
      }
      if (await inGame(`return !game.missions.M || game.missions.M.state !== 'run';`)) break;
    }
    await inGame(`window.__TAP__.recover = ARG; return true;`, facts);
    return `recovered ${facts.deliveries}; 1st drop: exit=${facts.forceExitOk} unmark=${facts.unmarkOk}`;
  }

  if (track === 'protect') {
    // Kill the waves as they land on the ward, IN THE PAGE. `waveT` is pulled
    // forward so eight kills do not need forty real seconds of wave cadence —
    // the spawn logic, leash anchoring and kill accounting all still run.
    const r = await inGame(`
      return new Promise((done) => {
        let n = 0;
        const tick = () => {
          const M = game.missions.M;
          if (!M || M.state !== 'run' || ++n > 600) {
            return done({ kills: M ? M.kills : -1, ward: M && M.ward ? +M.ward.health.toFixed(0) : -1, n });
          }
          M.waveT = Math.min(M.waveT, 0.05);
          for (const h of M.spawnedHostiles) {
            if (h.active && !h.dead) game.hostiles.hurt(h, 99999, false, h.position);
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });`);
    return `ward held (${r.ward} hp), ${r.kills} dropped`;
  }

  if (track === 'partner') {
    // Leg 1: get to her. Leg 2: stand in the ring on foot; the fill runs for
    // real from 75% (SIMULATED head start — 6 s of fill is ~700 headless
    // frames, and the last quarter exercises the same arithmetic).
    await inGame(`
      const M = game.missions.M;
      game.wq.placePlayer(M.dest.x + 6, M.dest.z + 6, 0);
      return true;`);
    await pump(10);
    const flip = await inGame(`
      const M = game.missions.M;
      return M ? { step: M.step, hasCar: !!M.veh, timerOff: !M.hasTimer } : null;`);
    //
    // WHAT THIS ASSERTS, AND WHY IT IS NOT THE NUMBER WE SET.
    //
    // Seeding 75% is the only shortcut; everything read back is the track's own
    // output. `peak` is sampled off the LIVE mission every frame, so it can only
    // reach 100 if `M.repair += (dt / REPAIR_TIME) * 100` actually ran on a
    // running clock, and `hpEnd` is read off the VEHICLE — the car is spawned
    // wrecked (0.28 hull) and only the win writes `v.health = v.maxHealth`.
    // Asserting "we set 75, we read 75" is what let a wedged clock look like a
    // stuck mission for an hour: the fill sat at exactly the seeded value and
    // nothing in the harness was watching whether it moved.
    const fill = await inGame(`
      const M = game.missions.M;
      const out = { seeded: -1, first: -1, peak: -1, frames: 0, hp0: -1, hpEnd: -1 };
      if (!M || !M.veh) return out;
      const v = M.veh;
      out.hp0 = +(v.health / Math.max(1, v.maxHealth)).toFixed(3);
      M.repair = 75;
      out.seeded = 75;
      game.wq.placePlayer(v.position.x + 2, v.position.z + 2, 0);
      return new Promise((done) => {
        let n = 0;
        const finish = () => {
          // Read M, not game.missions.M: the runner drops its handle the moment
          // the chapter is over, and the winning frame is the one that matters.
          out.peak = Math.max(out.peak, +Number(M.repair).toFixed(2));
          out.hpEnd = +(v.health / Math.max(1, v.maxHealth)).toFixed(3);
          out.frames = n;
          done(out);
        };
        const tick = () => {
          const m = game.missions.M;
          if (!m || m !== M || M.state !== 'run' || ++n > 800) return finish();
          if (n === 2) out.first = +Number(M.repair).toFixed(2);
          out.peak = Math.max(out.peak, +Number(M.repair).toFixed(2));
          if (game.wq.playerVehicle()) player.vehicles.abort(player.movement);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });`);
    await inGame(`window.__TAP__.partner = ARG; return true;`, { ...flip, ...fill });
    return flip
      ? `arrived (step ${flip.step}, car ${flip.hasCar}, clock stopped ${flip.timerOff}), ` +
        `fill 75 -> ${fill.peak} in ${fill.frames} frames, hull ${fill.hp0} -> ${fill.hpEnd}`
      : 'no flip';
  }

  if (track === 'final') {
    return await inGame(`
      const M = game.missions.M;
      game.wq.placePlayer(M.dest.x + 4, M.dest.z + 4, 0);
      return 'drove home to ' + M.dest.name;`);
  }

  if (track === 'boss') {
    // Phase 1: put him down. Phase 2 is the ESCAPE — the win is gated on the
    // wanted level returning to zero, so shed it the way the escape solver
    // does. testStoryShape holds the phase open to prove the gate is real.
    const note = await inGame(SOLVERS.boss);
    await pump(12);
    const esc = await inGame(`
      const M = game.missions.M;
      const r = M ? { escapeOn: M.escapeOn, wanted: game.heat.wanted, state: M.state } : null;
      window.__TAP__.bossEscape = r;
      return r;`);
    await inGame(`
      game.heat.clear('harness');
      const M = game.missions.M;
      if (M) M.escapeGrace = Math.min(M.escapeGrace, 0.05);
      return true;`);
    await pump(10);
    return `${note}; escape phase ${esc && esc.escapeOn ? `on at ${esc.wanted}*` : 'MISSING'}, heat shed`;
  }

  const src = SOLVERS[track] ?? SOLVERS[FALLBACK[track]];
  if (!src) return `no solver for "${track}"`;
  const note = await inGame(src);
  await pump(6);
  return note;
}

const FALLBACK = { timedDeliver: 'deliver', brawl: 'goons' };

/* ===================================================================== */
/* one chapter, start to finish                                          */
/* ===================================================================== */

async function runChapter(boyId, index) {
  const t0 = Date.now();
  // The chapter before this one may have left the screen owned by a modal (the
  // finale always does). Dismiss it the way the player does BEFORE anything is
  // measured, and remember what was up so the report can say so.
  // 'card' is the routine 4.6 s result card and is not worth a line in the
  // report; a STICKY overlay (the ending owns the screen until it is answered)
  // is, because it means the previous chapter left the world paused.
  const dismissed = (await resumeSim()).filter((m) => m !== 'card');
  const before = await inGame(`
    window.__TAP__.start.length = 0;
    window.__TAP__.complete.length = 0;
    window.__TAP__.fail.length = 0;
    window.__TAP__.money.length = 0;
    window.__TAP__.ending.length = 0;
    window.__TAP__.recover = null;
    window.__TAP__.partner = null;
    window.__TAP__.bossEscape = null;
    if (game.character !== ARG.boy) game.characters.switchTo(ARG.boy);
    game.missions.abort();
    game.heat.clear('harness');
    game.hostiles.clear();
    const c = game.economy.char();
    c.chapter = ARG.index;
    return { cash: game.economy.cash, respect: game.economy.respect, chapter: c.chapter };`,
    { boy: boyId, index });
  await pump(3);

  const started = await inGame(`
    const M = game.startMission(ARG.index);
    return M ? { id: M.id, track: M.track, name: M.def.name, no: M.def.no, zone: M.def.zone,
                 goal: M.goal, timer: +M.timer.toFixed(1), hasTimer: M.hasTimer,
                 introLines: (M.def.intro || []).length, doneLines: (M.def.done || []).length } : null;`,
    { index });
  if (!started) return fail(boyId, index, 'startMission returned null');

  // The intro cutscene plays for real; skip past it the way the J key does.
  await pump(6);
  const introOk = await inGame(`return !!(game.missions.M && game.missions.M.phase === 'intro');`);
  await inGame(`game.missions.skipIntro(); return game.missions.forceBegin();`);
  await pump(8);

  const staged = await inGame(`
    const M = game.missions.M;
    if (!M) return null;
    const o = game.getHudState().objective;
    return {
      phase: M.phase, state: M.state,
      vehicles: M.spawnedVehicles.length,
      hostiles: M.spawnedHostiles.length,
      pickups: M.spawnedPickups.length,
      rivals: M.rivals.length,
      objective: o ? { eyebrow: o.eyebrow, text: o.text, count: o.count, timer: o.timer } : null,
      markers: M.markerCount,
      boss: M.B ? M.B.name : null,
      wanted: game.heat.wanted,
      ward: M.ward ? { name: M.ward.name, hp: M.ward.health } : null,
      hudWard: game.getHudState().ward ? game.getHudState().ward.name : null,
      marked: M.spawnedVehicles.filter((v) => v._marked).length,
    };`);
  if (!staged) return fail(boyId, index, 'mission vanished after skipIntro');
  if (staged.state !== 'run') {
    return fail(boyId, index, `mission failed during init: ${await inGame('return game.missions.M?.reason ?? "";')}`);
  }

  // FAIL FAST ON A DEAD CLOCK. Every track whose win integrates time — a repair
  // fill, a survive countdown, a wave cadence — is uncompletable with the sim
  // frozen, and the symptom (an objective that never changes) looks exactly
  // like a broken track. Ask before solving, and say WHICH overlay did it.
  const clock = await awaitClock();
  if (!(clock.advanced > 0)) {
    await inGame(`game.missions.abort(); return true;`);
    return fail(boyId, index,
      `the sim clock never started (time.scale ${clock.scale}, ${clock.frames} frames / ` +
      `${clock.raw}s of real time with no game time at all` +
      `${clock.modal.length ? `, modal up: ${clock.modal.join(',')}` : ''}) — ` +
      'nothing timed can complete');
  }

  const note = await solveMulti(started.track);
  await pump(20);

  // Wait out the outro cutscene, in the page. Bounded: a chapter that never
  // resolves is a finding, not a reason to hang the harness.
  const settled = await inGame(`
    return new Promise((done) => {
      let n = 0;
      const ui = engine.ctx.peek('ui');
      const tick = () => {
        if (ui && ui.subs) ui.subs.clear();   // skip the outro dialogue
        const M = game.missions.M;
        if (!M || M.phase === 'over' || window.__TAP__.fail.length > 0) return done({ ok: true, n });
        // The result card holds for the done-dialogue beats (up to ~8 s of
        // game time); with the subs skipped, fast-forward the hold the same
        // way the race test fast-forwards laps.
        if (M.phase === 'outro') game.missions.update(0.2);
        if (++n > 900) return done({ ok: false, n });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });`);
  await pump(4);
  if (!settled.ok) {
    // Print the clock and the modal stack next to the frozen objective. The
    // first time this fired it said only "Repairing the car — 75%", which
    // pointed the investigation at the repair arithmetic — where nothing was
    // wrong.
    const why = await inGame(`
      ${MODALS}
      const M = game.missions.M;
      const o = game.getHudState().objective;
      return 'STUCK in ' + (M ? M.track : '?') + ': ' + (o ? o.text + ' [' + o.count + ']' : 'no objective') +
        ' · time.scale ' + engine.time.scale + ' · phase ' + (M ? M.phase : '?') +
        (modal.length ? ' · modal up: ' + modal.join(',') : '');`);
    await inGame(`game.missions.abort(); return true;`);
    return { boy: boyId, index, no: started.no, name: started.name, track: started.track,
             ok: false, note: why, payout: 0, checks: [{ name: 'reached a verdict', ok: false, detail: why }] };
  }
  const after = await inGame(`
    const tap = window.__TAP__;
    return {
      cash: game.economy.cash, respect: game.economy.respect,
      chapter: game.economy.char().chapter,
      unlocked: game.economy.char().unlocked.slice(),
      complete: tap.complete.slice(), fail: tap.fail.slice(),
      money: tap.money.slice(), start: tap.start.slice(),
      ending: tap.ending.slice(), recover: tap.recover ?? null, partner: tap.partner ?? null,
      bossEscape: tap.bossEscape ?? null,
      hostiles: game.hostiles.aliveCount,
      missionPickups: game.pickups.countMission(),
      liveMissionVehicles: (engine.ctx.peek('vehicles').vehicles || []).filter(v => v.isMission).length,
      active: game.missions.active,
    };`);

  const def = started;
  const checks = [];
  const ck = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail ?? '' });

  const isFinal = def.track === 'final';
  ck('mission:start emitted', after.start.length === 1, `${after.start.length}`);
  ck('intro cutscene played', introOk && def.introLines > 0, `${def.introLines} lines`);
  ck('objective driven', !!staged.objective && staged.objective.text.length > 0,
    staged.objective ? `"${staged.objective.text}"` : 'none');
  ck('objective marker set', staged.markers > 0 || def.track === 'escape' || def.track === 'brawl',
    `${staged.markers}`);
  // A final chapter ends in `ending:play`, NOT a result card: the finale never
  // shows the win overlay and pays nothing.
  if (isFinal) {
    ck('no result card for the finale', after.complete.length === 0 && after.fail.length === 0,
      `${after.complete.length} complete, ${after.fail.length} fail`);
    ck('ending:play emitted with slides', after.ending.length >= 1 && after.ending[0].slides >= 2,
      `${after.ending.length} event(s), ${after.ending[0]?.slides ?? 0} slides`);
    ck('all weapons unlocked', WEAPONS.every((w) => after.unlocked.includes(w)),
      `${after.unlocked.length}/${WEAPONS.length}`);
    ck('story-done flag derivable', after.chapter >= DATA[boyId].length, `chapter ${after.chapter}`);
  } else {
    ck('mission:complete emitted', after.complete.length === 1 && after.fail.length === 0,
      after.fail.length ? `FAILED: ${after.fail[0]?.reason}` : `${after.complete.length}`);
  }
  const payout = after.cash - before.cash;
  ck('payout landed', payout >= chapterCash(boyId, index),
    `$${payout} (base $${chapterCash(boyId, index)})`);
  if (chapterCash(boyId, index) > 0) {
    ck('money:change emitted', after.money.some((m) => m.reason?.startsWith('chapter')), `${after.money.length} events`);
  }
  if (chapterRespect(boyId, index) > 0) {
    ck('respect awarded', after.respect > before.respect, `+${after.respect - before.respect}`);
  }
  ck('chapter advanced', after.chapter === index + 1, `${before.chapter} -> ${after.chapter}`);
  ck('world cleaned up', after.hostiles === 0 && after.missionPickups === 0,
    `${after.hostiles} hostiles, ${after.missionPickups} crates`);

  // Track-specific staging assertions.
  if (def.track === 'deliver' || def.track === 'timedDeliver') {
    ck('delivery vehicle spawned', staged.vehicles >= 1, `${staged.vehicles}`);
    ck('objective vehicle marked (glow)', staged.marked >= 1, `${staged.marked} marked`);
  }
  if (def.track === 'goons' || def.track === 'brawl') ck('crew spawned', staged.hostiles === def.goal, `${staged.hostiles}/${def.goal}`);
  if (def.track === 'race') ck('rivals on the grid', staged.rivals === 3, `${staged.rivals}`);
  if (def.track === 'collect') ck('crates placed', staged.pickups === def.goal, `${staged.pickups}/${def.goal}`);
  if (def.track === 'rampage') ck('convoy placed', staged.vehicles >= def.goal, `${staged.vehicles}/${def.goal}`);
  if (def.track === 'escape') ck('stars raised', staged.wanted >= 3, `${staged.wanted}`);
  if (def.track === 'boss') {
    ck('boss staged', !!staged.boss, staged.boss ?? 'none');
    ck('escape phase engaged after the kill',
      !!after.bossEscape && after.bossEscape.escapeOn && after.bossEscape.state === 'run' &&
      after.bossEscape.wanted >= 1,
      after.bossEscape ? `wanted ${after.bossEscape.wanted}, state ${after.bossEscape.state}` : 'never engaged');
  }
  if (def.track === 'escort') ck('ally spawned', staged.vehicles >= 1, `${staged.vehicles}`);
  if (def.track === 'survive') ck('timer armed', def.hasTimer || staged.objective?.timer > 0, `${staged.objective?.timer}`);
  if (def.track === 'recover') {
    ck('marked cars staged', staged.vehicles >= def.goal && staged.marked === def.goal,
      `${staged.marked}/${def.goal} marked`);
    ck('per-delivery force-exit + unmark', !!after.recover && after.recover.forceExitOk && after.recover.unmarkOk,
      after.recover ? `exit=${after.recover.forceExitOk} unmark=${after.recover.unmarkOk}` : 'no facts');
  }
  if (def.track === 'protect') {
    ck('named ward staged with HP on the HUD',
      !!staged.ward && staged.ward.hp > 0 && staged.hudWard === staged.ward.name,
      staged.ward ? `${staged.ward.name} ${staged.ward.hp} hp, hud "${staged.hudWard}"` : 'no ward');
  }
  if (def.track === 'partner') {
    const p = after.partner;
    ck('arrival flips to the repair leg and stops the clock',
      !!p && p.step === 1 && p.hasCar && p.timerOff,
      p ? `step ${p.step}, car ${p.hasCar}, clock off ${p.timerOff}` : 'no flip');
    // Both of these are the TRACK's output, sampled off the live mission and
    // off the car. The 75 we seeded cannot satisfy either one.
    ck('the repair fill runs on the sim clock and reaches 100%',
      !!p && p.first > p.seeded && p.peak >= 100,
      p ? `seeded ${p.seeded} -> first frame ${p.first} -> peak ${p.peak} over ${p.frames} frames` : 'no fill');
    ck('the fixed car is handed back at full health',
      !!p && p.hp0 > 0 && p.hp0 < 0.9 && p.hpEnd === 1,
      p ? `hull ${p.hp0} -> ${p.hpEnd}` : 'no car');
  }

  const unlock = chapterUnlock(boyId, index);
  if (unlock) ck('weapon unlocked', after.unlocked.includes(unlock), unlock);

  const ok = checks.every((c) => c.ok);
  return {
    boy: boyId, index, id: def.id, no: def.no, name: def.name, track: def.track,
    zone: def.zone, ok, checks, payout,
    note: dismissed.length ? `${note} [dismissed ${dismissed.join(',')} first]` : note,
    ms: Date.now() - t0,
  };
}

/** Distinct messages, first line only — a per-frame throw is one finding. */
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const e of list) {
    const k = String(e).split('\n')[0].slice(0, 120);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function fail(boy, index, reason) {
  return { boy, index, ok: false, reason, checks: [{ name: 'ran', ok: false, detail: reason }] };
}

/* ===================================================================== */
/* fail-condition + save tests                                            */
/* ===================================================================== */

async function testFailures() {
  // A section runs after the chapters, and the last chapter may have been the
  // finale — whose ending screen holds the sim at zero. Same rule as a chapter:
  // put the clock back first, or every timed assertion below is a lie.
  await resumeSim();
  const out = [];

  // 1. A wrecked delivery vehicle fails the chapter.
  await inGame(`
    game.missions.abort();
    game.characters.switchTo('aidan');
    game.economy.char().chapter = 0;
    window.__TAP__.fail.length = 0;
    game.startMission(0); game.missions.skipIntro(); game.missions.forceBegin();
    return true;`);
  await pump(10);
  const wrecked = await inGame(`
    const M = game.missions.M;
    if (!M || !M.veh) return { ok: false, why: 'no vehicle' };
    vehicles.damage(M.veh, M.veh.health + 50, M.veh.position);
    return { ok: true };`);
  await pump(10);
  const r1 = await inGame(`
    return { fails: window.__TAP__.fail.length, reason: window.__TAP__.fail[0]?.reason ?? '',
             active: game.missions.active, hostiles: game.hostiles.aliveCount };`);
  out.push({
    name: 'deliver fails when the vehicle is wrecked',
    ok: wrecked.ok && r1.fails === 1 && /wreck/i.test(r1.reason),
    detail: `${r1.fails} fail events, "${r1.reason}"`,
  });

  // 2. A timed delivery fails when the clock runs out.
  await inGame(`
    game.missions.abort();
    game.economy.char().chapter = 2;
    window.__TAP__.fail.length = 0;
    game.startMission(2); game.missions.skipIntro(); game.missions.forceBegin();
    return true;`);
  await pumpLive(10);
  await inGame(`game.missions.M.timer = 0.02; return true;`);
  await pumpLive(10);
  const r2 = await inGame(`return { fails: window.__TAP__.fail.length, reason: window.__TAP__.fail[0]?.reason ?? '' };`);
  out.push({
    name: 'timedDeliver fails on the clock',
    ok: r2.fails === 1 && /time/i.test(r2.reason),
    detail: `"${r2.reason}"`,
  });

  // 3. Dying mid-chapter is WASTED, costs 10%, and RESTARTS the chapter. The
  //    full restart flow, including heat, HP and the negative controls, lives
  //    in testStoryShape.
  await inGame(`
    game.missions.abort();
    game.economy.char().chapter = 1;
    game.economy.char().cash = 4000;
    game._deathCd = 0;
    window.__TAP__.fail.length = 0;
    window.__TAP__.start.length = 0;
    game.startMission(1); game.missions.skipIntro(); game.missions.forceBegin();
    return true;`);
  await pumpLive(10);
  await inGame(`
    // KILL HIM, do not announce him dead. Emitting the player:death event
    // leaves the health pool untouched, and _respawn floors HP at 55% of max
    // with Math.max — so a faked death respawns on 100% and the 55% rule
    // this asserts could never fail, however it was written.
    player.applyDamage(9999, game.wq.playerPos(), { type: 'melee' });
    return true;`);
  await pumpLive(10);
  await inGame(`game._restartT = Math.min(game._restartT, 0.05); return true;`);
  await pumpLive(12);
  const r3 = await inGame(`
    const M = game.missions.M;
    return { fails: window.__TAP__.fail.length, cash: game.economy.cash,
             deaths: game.economy.char().deaths, active: game.missions.active,
             restartedIdx: M ? M.idx : -1, starts: window.__TAP__.start.length,
             hostiles: game.hostiles.aliveCount };`);
  await inGame(`game.missions.abort(); game.hostiles.clear(); return true;`);
  out.push({
    name: 'player death = WASTED, 10% of cash, and the CHAPTER RESTARTS (no fail)',
    ok: r3.fails === 0 && r3.cash === 3600 && r3.deaths === 1 &&
        r3.active && r3.restartedIdx === 1 && r3.starts === 2,
    detail: `$4000 -> $${r3.cash}, deaths ${r3.deaths}, restarted idx ${r3.restartedIdx}, ` +
      `${r3.starts} mission:start, ${r3.fails} fails`,
  });

  // 4. Busted clears heat and costs 15%.
  const r4 = await inGame(`
    game.missions.abort();
    game.economy.char().cash = 2000;
    game.heat.raise(3, 0, 0);
    const before = game.heat.wanted;
    game._deathCd = 0;
    game.busted();
    return { before, after: game.heat.wanted, cash: game.economy.cash, busts: game.economy.char().busts };`);
  out.push({
    name: 'busted clears the wanted level and takes 15%',
    ok: r4.before === 3 && r4.after === 0 && r4.cash === 1700,
    detail: `${r4.before}* -> ${r4.after}*, $2000 -> $${r4.cash}`,
  });

  // 5. The respray clears heat (DESIGN.md's one cross-subsystem shop rule).
  //    Drive a real car onto the forecourt with four stars up and let whichever
  //    system owns the wanted level do its thing — `police` implements this at
  //    the same coordinates, so the test must not care which one answers.
  const r5 = await inGame(`
    game.missions.abort();
    game.heat.clear();
    const shop = game.wq.nearestShop(0, 0, 'spray').poi;
    const v = game.wq.spawnVehicle('sedan', shop.x + 4, shop.z + 4, 0);
    game._sprayVeh = v;
    game.debugBoard(v);
    return { hasCar: !!v, x: shop.x, z: shop.z, owner: game.heat.authoritative ? 'game' : 'police' };`);
  await pumpLive(50);
  const r5a = await inGame(`
    const shop = game.wq.nearestShop(0, 0, 'spray').poi;
    const v = game._sprayVeh;
    if (v) { v.position.set(shop.x, v.position.y, shop.z); v.velocity.set(0, 0, 0); }
    game.heat.raise(4, shop.x, shop.z);
    return { before: game.heat.wanted, inVeh: game.wq.playerVehicle() === v };`);
  for (let i = 0; i < 12; i++) {
    await inGame(`
      const shop = game.wq.nearestShop(0, 0, 'spray').poi;
      const v = game._sprayVeh;
      if (v) { v.position.set(shop.x, v.position.y, shop.z); v.velocity.set(0, 0, 0); }
      return true;`);
    await pumpLive(8);
    if (await inGame(`return game.heat.wanted === 0;`)) break;
  }
  const r5b = await inGame(`
    const w = game.heat.wanted;
    // Get out BEFORE despawning: a player still bound to a removed vehicle
    // reports a stale position and breaks every later proximity test.
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game._sprayVeh) { game.wq.despawnVehicle(game._sprayVeh); game._sprayVeh = null; }
    game.heat.clear();
    return { after: w };`);
  out.push({
    name: 'Rustbelt Respray clears heat',
    ok: r5a.before === 4 && r5b.after === 0,
    detail: `${r5a.before}* -> ${r5b.after}* (owner: ${r5.owner}, aboard: ${r5a.inVeh})`,
  });

  // 6. Hidden packages pay out, count, and unlock at twelve.
  const r6 = await inGame(`
    game.missions.abort();
    game.save.packages.length = 0;
    game.pickups.clear();
    game.freeroam.seedPackages();
    const seeded = game.pickups.live.length;
    const cash0 = game.economy.cash;
    for (const p of game.pickups.live.slice()) game.freeroam.collectPackage(p.id);
    return { seeded, found: game.save.packages.length, gained: game.economy.cash - cash0,
             launcher: game.economy.char().unlocked.includes('launcher') };`);
  out.push({
    name: '12 hidden packages: $600 each, all twelve unlocks the Nitro Launcher',
    ok: r6.seeded === 12 && r6.found === 12 && r6.gained === 7200 && r6.launcher,
    detail: `${r6.seeded} seeded, $${r6.gained}, launcher ${r6.launcher}`,
  });

  // 7. Standalone race circuits.
  const r7 = await inGame(`
    game.missions.abort();
    game.save.races = {};
    const M = game.freeroam.startRace('triangle');
    game.missions.skipIntro(); game.missions.forceBegin();
    return M ? { id: M.id, side: M.side, laps: M.laps, points: (M.points||[]).length } : null;`);
  await pump(6);
  let g = 0;
  for (;;) {
    const d = await inGame(`
      const M = game.missions.M;
      if (!M || M.state !== 'run') return { done: true };
      const cp = M.points[M.cpIdx];
      const v = game.wq.playerVehicle();
      if (v) v.position.set(cp.x, v.position.y, cp.z);
      game.wq.placePlayer(cp.x, cp.z, 0);
      return { done: false };`);
    await pump(3);
    if (d.done || ++g > 40) break;
  }
  await pump(10);
  const r7b = await inGame(`
    for (let i = 0; i < 200 && game.missions.M && game.missions.M.phase !== 'over'; i++) {
      const ui = engine.ctx.peek('ui'); if (ui && ui.subs) ui.subs.clear();
      game.missions.update(0.2);
    }
    return { best: game.save.races.triangle ?? null, chapter: game.economy.char().chapter };`);
  out.push({
    name: 'triangle circuit runs as a standalone activity and records a time',
    ok: !!r7 && r7.side === true && r7.points === 6 && r7b.best !== null,
    detail: r7 ? `${r7.points} gates x${r7.laps}, best ${r7b.best}s` : 'did not start',
  });

  // 8. Respect unlocks a safehouse.
  const r8 = await inGame(`
    game.save.unlocks.length = 0;
    for (const id of ['carson','aidan','dylan']) game.save.chars[id].respect = 0;
    window.__TAP__.unlocks.length = 0;
    game.economy.addRespect(350, 'test');
    return { unlocks: game.save.unlocks.slice(), events: window.__TAP__.unlocks.length,
             has: game.economy.hasUnlock('sh_dt') };`);
  out.push({
    name: 'respect ladder unlocks the Triangle Apartment at 300',
    ok: r8.has && r8.events >= 1,
    detail: `${r8.unlocks.join(', ')}`,
  });

  return out;
}

/* ===================================================================== */
/* story shape — each rule with a negative control                        */
/* ===================================================================== */

async function testStoryShape() {
  // A section runs after the chapters, and the last chapter may have been the
  // finale — whose ending screen holds the sim at zero. Same rule as a chapter:
  // put the clock back first, or every timed assertion below is a lie.
  await resumeSim();
  const out = [];

  // 1. BOSS ESCAPE PHASE. Kill the Harbormaster and assert the chapter is
  //    NOT complete while the wanted level is up — the immediate-`win` bug
  //    this replaces would show complete=1 right here — then shed the heat
  //    and assert it completes.
  await inGame(`
    game.missions.abort();
    game.heat.clear('probe');
    game.hostiles.clear();
    game.characters.switchTo('carson');
    game.economy.char().chapter = 6;
    window.__TAP__.complete.length = 0;
    window.__TAP__.fail.length = 0;
    game.startMission(6); game.missions.skipIntro(); game.missions.forceBegin();
    return true;`);
  await pump(10);
  await inGame(`
    const M = game.missions.M;
    if (M && M.bossEnt) game.hostiles.hurt(M.bossEnt, 99999, false, M.bossEnt.position);
    else if (M && M.bossVeh) vehicles.damage(M.bossVeh, M.bossVeh.health + 10, M.bossVeh.position);
    return true;`);
  await pump(20);
  const bossMid = await inGame(`
    const M = game.missions.M;
    return { state: M ? M.state : 'gone', escapeOn: M ? M.escapeOn : false,
             wanted: game.heat.wanted, completes: window.__TAP__.complete.length };`);
  await inGame(`
    game.heat.clear('probe');
    const M = game.missions.M;
    if (M) M.escapeGrace = Math.min(M.escapeGrace, 0.05);
    return true;`);
  const bossSettle = await inGame(`
    return new Promise((done) => {
      let n = 0;
      const ui = engine.ctx.peek('ui');
      const tick = () => {
        if (ui && ui.subs) ui.subs.clear();
        const M = game.missions.M;
        if (!M || M.phase === 'over' || ++n > 900) {
          return done({ completes: window.__TAP__.complete.length, n });
        }
        // The doneHold choreography is exercised by test 5; here just let the
        // outro run its floor down at page speed.
        if (M.phase === 'outro') game.missions.update(0.2);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });`);
  out.push({
    name: 'boss death flips to the ESCAPE phase — win only when wanted returns to 0',
    ok: bossMid.state === 'run' && bossMid.escapeOn && bossMid.wanted === 4 &&
        bossMid.completes === 0 && bossSettle.completes === 1,
    detail: `boss down: state=${bossMid.state} wanted=${bossMid.wanted} complete=${bossMid.completes} ` +
      `(control); heat shed: complete=${bossSettle.completes}`,
  });

  // 2. PROTECT: the ward dying fails the chapter; a low-HP ward with nobody
  //    on him survives (control). The harness stages positions only — the
  //    siege arithmetic in the track does the killing.
  await inGame(`
    game.missions.abort();
    game.heat.clear('probe');
    game.hostiles.clear();
    game.economy.char().chapter = 5;
    window.__TAP__.fail.length = 0;
    game.startMission(5); game.missions.skipIntro(); game.missions.forceBegin();
    return true;`);
  await pump(10);
  const wardCtl = await inGame(`
    const M = game.missions.M;
    if (!M || !M.ward) return null;
    M.ward.health = 6;                       // one good hit from down
    for (const h of M.spawnedHostiles) if (h.active) game.hostiles.despawn(h);
    M.waveT = 999;                           // nobody left, nobody coming
    return { hp: M.ward.health };`);
  await pump(30);
  const wardMid = await inGame(`
    const M = game.missions.M;
    return { state: M ? M.state : 'gone', hp: M && M.ward ? +M.ward.health.toFixed(1) : -1,
             fails: window.__TAP__.fail.length };`);
  const wardKill = await inGame(`
    const M = game.missions.M;
    if (!M || !M.ward) return null;
    // A wave lands ON him — the track's ward-attack arithmetic runs for real.
    M.waveT = 0.01;
    return true;`);
  const wardFail = await inGame(`
    return new Promise((done) => {
      let n = 0;
      const tick = () => {
        const M = game.missions.M;
        if (M && M.ward) {
          for (const h of M.spawnedHostiles) {
            if (h.active && !h.dead) { h.position.x = M.ward.x + 1; h.position.z = M.ward.z; h.homeX = M.ward.x; h.homeZ = M.ward.z; }
          }
        }
        if (window.__TAP__.fail.length > 0 || !game.missions.active || ++n > 900) {
          return done({ fails: window.__TAP__.fail.length,
                        reason: window.__TAP__.fail[0]?.reason ?? '', n });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });`);
  await inGame(`game.missions.abort(); game.hostiles.clear(); return true;`);
  out.push({
    name: 'protect fails when the ward goes down; a besieged-free ward survives',
    ok: !!wardCtl && wardMid.state === 'run' && wardMid.fails === 0 && wardMid.hp === 6 &&
        !!wardKill && wardFail.fails === 1 && /went down/i.test(wardFail.reason),
    detail: `control: ${wardMid.hp} hp untouched, ${wardMid.fails} fails; ` +
      `siege: "${wardFail.reason}" (${wardFail.fails} fail)`,
  });

  // 3. DEATH MID-CHAPTER: wanted cleared, 55% HP respawn, chapter restarts;
  //    a SIDE job death stays a plain fail (control).
  await inGame(`
    game.missions.abort();
    game.heat.clear('probe');
    game.economy.char().chapter = 1;
    game._deathCd = 0;
    window.__TAP__.fail.length = 0;
    window.__TAP__.start.length = 0;
    game.startMission(1); game.missions.skipIntro(); game.missions.forceBegin();
    game.heat.raise(3, game.wq.playerPos().x, game.wq.playerPos().z);
    return true;`);
  await pumpLive(10);
  await inGame(`
    // KILL HIM, do not announce him dead. Emitting the player:death event
    // leaves the health pool untouched, and _respawn floors HP at 55% of max
    // with Math.max — so a faked death respawns on 100% and the 55% rule
    // this asserts could never fail, however it was written.
    player.applyDamage(9999, game.wq.playerPos(), { type: 'melee' });
    return true;`);
  await pumpLive(8);
  const deathMid = await inGame(`
    return { wanted: game.heat.wanted, cops: game.heat.cops.length,
             hp: player && player.health ? Math.round(player.health.value / player.health.max * 100) : -1,
             fails: window.__TAP__.fail.length, armed: game._restartT > 0 };`);
  await inGame(`game._restartT = Math.min(game._restartT, 0.05); return true;`);
  await pumpLive(12);
  const deathRestart = await inGame(`
    const M = game.missions.M;
    return { active: game.missions.active, idx: M ? M.idx : -1, starts: window.__TAP__.start.length };`);
  await inGame(`game.missions.abort(); game.hostiles.clear(); game._deathCd = 0; return true;`);
  // control: death on a SIDE activity fails it and arms no restart
  const sideDeath = await inGame(`
    window.__TAP__.fail.length = 0;
    const M = game.freeroam.startRace('triangle');
    game.missions.skipIntro(); game.missions.forceBegin();
    player.applyDamage(9999, game.wq.playerPos(), { type: 'melee' });   // a real death, as above
    return { side: M ? M.side : null };`);
  await pump(8);
  const sideAfter = await inGame(`
    const r = { fails: window.__TAP__.fail.length, kind: window.__TAP__.fail[0]?.reason ?? '',
                armed: game._restartT > 0, active: game.missions.active };
    game.missions.abort(); game._restartT = 0; game._restartIdx = -1; game._deathCd = 0;
    return r;`);
  out.push({
    name: 'death mid-chapter: heat cleared, hurt-not-whole respawn, chapter auto-restarts; side job just fails',
    // `_respawn` floors HP at 55% of max and health regenerates from there, so
    // the assertion is a BAND, not the constant: at or above the floor, and
    // never back to full. Both edges bite — drop the floor and a real death
    // respawns near zero, replace it with a full heal and this reads 100.
    ok: deathMid.wanted === 0 && deathMid.cops === 0 &&
        deathMid.hp >= 55 && deathMid.hp < 100 &&
        deathMid.fails === 0 && deathMid.armed &&
        deathRestart.active && deathRestart.idx === 1 && deathRestart.starts === 2 &&
        sideDeath.side === true && sideAfter.fails === 1 && !sideAfter.armed,
    detail: `story: wanted ${deathMid.wanted}, hp ${deathMid.hp}%, restart idx ${deathRestart.idx}; ` +
      `side (control): ${sideAfter.fails} fail, restart armed ${sideAfter.armed}`,
  });

  // 4. TIMED-STORY DIFFICULTY: hard puts a 120s*0.85 clock on a plain deliver;
  //    normal leaves it untimed (control).
  const ts = await inGame(`
    game.missions.abort();
    game.setDifficulty('hard');
    game.characters.switchTo('carson');
    game.economy.char().chapter = 0;
    game.startMission(0); game.missions.skipIntro(); game.missions.forceBegin();
    const M = game.missions.M;
    const hard = M ? { hasTimer: M.hasTimer, timer: +M.timer.toFixed(1) } : null;
    game.missions.abort();
    game.setDifficulty('normal');
    game.startMission(0); game.missions.skipIntro(); game.missions.forceBegin();
    const M2 = game.missions.M;
    const normal = M2 ? { hasTimer: M2.hasTimer, timer: +M2.timer.toFixed(1) } : null;
    game.missions.abort();
    return { hard, normal };`);
  out.push({
    name: 'timedStory: hard arms 120s x timerMul on deliver; normal stays untimed',
    ok: !!ts.hard && ts.hard.hasTimer && Math.abs(ts.hard.timer - 102) < 1 &&
        !!ts.normal && !ts.normal.hasTimer,
    detail: `hard: ${ts.hard?.timer}s (expect 102); normal: hasTimer ${ts.normal?.hasTimer}`,
  });

  // 5. WIN CHOREOGRAPHY: the result card (mission:complete) waits for the
  //    `done` dialogue beats. Sampled mid-dialogue — the old emit-in-win bug
  //    reads complete=1 right there (that sample IS the negative control).
  await inGame(`
    game.missions.abort();
    game.characters.switchTo('aidan');
    game.economy.char().chapter = 0;
    window.__TAP__.complete.length = 0;
    game.startMission(0); game.missions.skipIntro(); game.missions.forceBegin();
    return true;`);
  await pump(10);
  await inGame(`return game.missions.M && game.missions.M.veh ? game.debugBoard(game.missions.M.veh) : false;`);
  await pump(50);
  for (let i = 0; i < 6; i++) {
    await inGame(`
      const M = game.missions.M;
      if (!M || !M.veh || M.state !== 'run') return false;
      M.veh.position.x += (M.dest.x - M.veh.position.x) * 0.55;
      M.veh.position.z += (M.dest.z - M.veh.position.z) * 0.55;
      return true;`);
    await pump(3);
    if (await inGame(`return !game.missions.M || game.missions.M.state !== 'run';`)) break;
  }
  await pump(6);
  const choreoMid = await inGame(`
    const M = game.missions.M;
    const ui = engine.ctx.peek('ui');
    return { state: M ? M.state : 'gone', phase: M ? M.phase : '-',
             doneHold: M ? +((M.doneHold ?? 0).toFixed(1)) : 0,
             talking: !!(ui && ui.subs && ui.subs.active),
             completes: window.__TAP__.complete.length };`);
  const choreoEnd = await inGame(`
    const ui = engine.ctx.peek('ui');
    for (let i = 0; i < 200 && game.missions.M && game.missions.M.phase !== 'over'; i++) {
      if (ui && ui.subs) ui.subs.clear();
      game.missions.update(0.2);
    }
    return { completes: window.__TAP__.complete.length };`);
  out.push({
    name: 'the JOB DONE card waits for the done dialogue beats',
    ok: choreoMid.state === 'won' && choreoMid.phase === 'outro' && choreoMid.completes === 0 &&
        choreoMid.doneHold >= 4 && choreoEnd.completes === 1,
    detail: `mid-outro: complete=${choreoMid.completes} (control), hold ${choreoMid.doneHold}s, ` +
      `talking ${choreoMid.talking}; after beats: complete=${choreoEnd.completes}`,
  });

  // 6. STORY OVERVIEW + REPLAY: statuses render, locked rows refuse, and a
  //    replayed chapter pays without regressing the frontier.
  const ov = await inGame(`
    game.missions.abort();
    game.characters.switchTo('dylan');
    game.economy.char().chapter = 3;
    const o = game.getStoryOverview();
    const sel = game.selectChapter(2);
    const locked = game.selectChapter(6);
    return {
      n: o.chapters.length, summary: o.summary, storyDone: o.storyDone,
      statuses: o.chapters.map((c) => c.status).join(','),
      playable: o.chapters.filter((c) => c.playable).length,
      sel: sel ? sel.index : null, locked,
      pending: game._pendingChapter,
    };`);
  await inGame(`
    window.__TAP__.complete.length = 0;
    game.startMission();  // no argument — honours the pending replay pick
    game.missions.skipIntro(); game.missions.forceBegin();
    return true;`);
  await pump(10);
  await inGame(`
    const M = game.missions.M;
    if (M && M.target) vehicles.damage(M.target, M.target.health + 10, M.target.position);
    return true;`);
  const replayEnd = await inGame(`
    const ui = engine.ctx.peek('ui');
    return new Promise((done) => {
      let n = 0;
      const tick = () => {
        if (ui && ui.subs) ui.subs.clear();
        const M = game.missions.M;
        if (M && M.phase === 'outro') game.missions.update(0.2);
        if (!M || M.phase === 'over' || ++n > 900) {
          return done({ completes: window.__TAP__.complete.length,
                        chapter: game.economy.char().chapter, n });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });`);
  out.push({
    name: 'story overview lists statuses; replaying a done chapter never regresses the frontier',
    ok: ov.n === 8 && ov.statuses === 'done,done,done,current,locked,locked,locked,locked' &&
        ov.playable === 4 && ov.sel === 2 && ov.locked === null && ov.pending === 2 &&
        replayEnd.completes === 1 && replayEnd.chapter === 3,
    detail: `[${ov.statuses}] pick=${ov.sel} locked-> ${ov.locked}; ` +
      `replay complete=${replayEnd.completes}, frontier still ch${replayEnd.chapter}`,
  });

  // 7. ENDING IDEMPOTENCE: the all-weapons unlock toasts once; a replayed
  //    finale replays the slides but not the unlock (control).
  const end1 = await inGame(`
    game.missions.abort();
    game.characters.switchTo('dylan');
    game.economy.char().chapter = 7;
    game.economy.char().unlocked = [];
    window.__TAP__.ending.length = 0;
    window.__TAP__.unlocks.length = 0;
    game.startMission(7); game.missions.skipIntro(); game.missions.forceBegin();
    const M = game.missions.M;
    if (M) game.wq.placePlayer(M.dest.x + 4, M.dest.z + 4, 0);
    return true;`);
  await pump(14);
  const endA = await inGame(`
    for (let i = 0; i < 60 && game.missions.M && game.missions.M.phase !== 'over'; i++) game.missions.update(0.2);
    return { endings: window.__TAP__.ending.length,
             all: window.__TAP__.unlocks.filter((u) => u.kind === 'weapons').length,
             chapter: game.economy.char().chapter,
             hudDone: game.getHudState().storyDone,
             weapons: game.economy.char().unlocked.length };`);
  // The ending is still on the screen from the first run and owns it until it
  // is answered. Replaying the finale is something the player does AFTER
  // pressing PLAY FREE ROAM, so press it — with the ending up the sim is at
  // `time.scale` 0 and the replay cannot reach its own destination.
  await resumeSim();
  // ...and the first run is still in its outro. `startMission` returns null
  // while a chapter is active, so without this the "replay" silently re-reads
  // the FIRST run and the control passes for the wrong reason.
  const retired = await inGame(`
    const ui = engine.ctx.peek('ui');
    return new Promise((done) => {
      let n = 0;
      const tick = () => {
        // The outro waits for the chapter's done-dialogue beats and the finale
        // has several; skip them the same way the chapter settle loop does, or
        // the wait below outlives its own budget.
        if (ui && ui.subs) ui.subs.clear();
        const M = game.missions.M;
        if (M && M.phase === 'outro') game.missions.update(0.2);
        if (!game.missions.active || ++n > 300) return done({ active: game.missions.active, n });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });`);
  const replayStart = await inGame(`
    const M = game.startMission(7);
    game.missions.skipIntro(); game.missions.forceBegin();
    const L = game.missions.M;
    if (L) game.wq.placePlayer(L.dest.x + 4, L.dest.z + 4, 0);
    return { started: !!M, idx: L ? L.idx : -1 };`);
  await pumpLive(14);
  const endB = await inGame(`
    for (let i = 0; i < 60 && game.missions.M && game.missions.M.phase !== 'over'; i++) game.missions.update(0.2);
    const r = { endings: window.__TAP__.ending.length,
                all: window.__TAP__.unlocks.filter((u) => u.kind === 'weapons').length };
    game.missions.abort();
    return r;`);
  out.push({
    name: 'the ending unlocks the arsenal ONCE; a replayed finale replays only the slides',
    ok: !!end1 && endA.endings === 1 && endA.all === 1 && endA.chapter === 8 &&
        endA.hudDone === true && endA.weapons >= 16 &&
        !retired.active && replayStart.started && replayStart.idx === 7 &&
        endB.endings === 2 && endB.all === 1,
    detail: `first: ${endA.endings} ending, ${endA.weapons} weapons, story-done ${endA.hudDone}; ` +
      `replay (control): started ${replayStart.started} idx ${replayStart.idx}, ` +
      `endings ${endB.endings}, unlock-all events still ${endB.all}`,
  });

  return out;
}

/* ===================================================================== */
/* the free-roam economy: pickups, kill rewards, the job feed, radio      */
/* ===================================================================== */

async function testEconomy() {
  // A section runs after the chapters, and the last chapter may have been the
  // finale — whose ending screen holds the sim at zero. Same rule as a chapter:
  // put the clock back first, or every timed assertion below is a lie.
  await resumeSim();
  const out = [];

  // Clean slate on solid ground.
  await inGame(`
    game.missions.abort();
    game.heat.clear('probe');
    game.hostiles.clear();
    if (player.inVehicle) player.vehicles.abort(player.movement);
    const s = game.wq.findRoadSpot(30, 90, 0, 0);
    game.wq.placePlayer(s.x, s.z, 0);
    return true;`);

  // 1. The consumable field stocks itself to 14 around the player.
  const stocked = await waitGame('game.pickups.countAmbient() >= 14', 12);
  const field = await inGame(`
    const kinds = new Set();
    for (const p of game.pickups.live) if (p.ambient) kinds.add(p.kind);
    return { n: game.pickups.countAmbient(), kinds: [...kinds].sort() };`);
  out.push({
    name: 'the map scatters a 14-strong consumable field, mixed kinds',
    ok: stocked.ok && field.n >= 14 && field.kinds.length >= 3,
    detail: `${field.n} standing after ${stocked.t}s: ${field.kinds.join(', ')}`,
  });

  // 2. Collect radius: 5.1 m is OUT of reach on foot (4 m) and IN reach from
  //    a car (4 x 1.6 = 6.4 m) — the drive-by sweep.
  await inGame(`
    window.__TAP__.picks.length = 0;
    window.__TAP__.money.length = 0;
    const p = game.wq.playerPos();
    window.__pkTest = game.pickups.spawn(p.x + 5.1, p.z, 'cash', { value: 77 });
    window.__cash0 = game.economy.cash;
    return true;`);
  const onFoot = await waitGame('!(window.__pkTest && window.__pkTest.active)', 1.5);
  const foot = await inGame(`
    return { live: !!(window.__pkTest && window.__pkTest.active),
             cash: game.economy.cash - window.__cash0 };`);
  out.push({
    name: 'a cash pickup 5.1 m away is out of reach on foot',
    ok: !onFoot.ok && foot.live && foot.cash === 0,
    detail: foot.live ? `still standing after ${onFoot.t}s` : 'collected on foot — radius too big',
  });

  await inGame(`
    const p = game.wq.playerPos();
    window.__pkVeh = game.wq.spawnVehicle('sedan', p.x, p.z, 0);
    if (window.__pkVeh) game.debugBoard(window.__pkVeh);
    return !!window.__pkVeh;`);
  const swept = await waitGame('!(window.__pkTest && window.__pkTest.active)', 6);
  const car = await inGame(`
    const picks = window.__TAP__.picks.filter((p) => p.kind === 'cash');
    const paid = window.__TAP__.money.filter((m) => m.reason === 'pickup' && m.amount === 77);
    const ecash = window.__TAP__.ecash.filter((m) => m.reason === 'pickup' && m.amount === 77);
    return { cash: game.economy.cash - window.__cash0, picks: picks.length,
             paid: paid.length, ecash: ecash.length,
             aboard: !!game.wq.playerVehicle() };`);
  out.push({
    name: 'the same pickup sweeps up from the car: cash lands, events fire',
    ok: swept.ok && car.cash >= 77 && car.picks >= 1 && car.paid === 1 && car.ecash === 1,
    detail: `+$${car.cash} in ${swept.t}s, pickup:collect x${car.picks}, ` +
      `money:change/economy:cash ${car.paid}/${car.ecash} (aboard: ${car.aboard})`,
  });

  // 3. Nitro pickup refills the driver's bottle (player agent's meter).
  await inGame(`
    if (player.vehicles) player.vehicles.nitro = 25;
    const v = game.wq.playerVehicle();
    const at = v ? v.position : game.wq.playerPos();
    game.pickups.spawn(at.x, at.z, 'nitro', {});
    window.__TAP__.picks.length = 0;
    return true;`);
  const nitroGot = await waitGame(
    `window.__TAP__.picks.some((p) => p.kind === 'nitro')`, 5);
  const nitro = await inGame(`return { nitro: player.vehicles ? player.vehicles.nitro : null };`);
  out.push({
    name: 'a nitro pickup refills the bottle to 100',
    ok: nitroGot.ok && nitro.nitro === 100,
    detail: `nitro 25 -> ${nitro.nitro} in ${nitroGot.t}s`,
  });

  // 4. Respawn: a collected ambient pickup is replaced ~6 s later — and NOT
  //    instantly (the 4-second read is the negative control).
  await inGame(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (window.__pkVeh) { game.wq.despawnVehicle(window.__pkVeh); window.__pkVeh = null; }
    return true;`);
  await waitGame('game.pickups.countAmbient() >= 14', 10);
  const resp0 = await inGame(`
    window.__TAP__.picks.length = 0;
    const pos = game.wq.playerPos();
    let best = null, bd = 1e9;
    for (const p of game.pickups.live) {
      if (!p.ambient) continue;
      const d = Math.hypot(p.x - pos.x, p.z - pos.z);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return null;
    game.wq.placePlayer(best.x, best.z, 0);
    return { n0: game.pickups.countAmbient() };`);
  const collected = await waitGame(`window.__TAP__.picks.length >= 1`, 4);
  const during = await waitGame(
    `game.pickups.countAmbient() >= ${resp0?.n0 ?? 14}`, 4);
  const after = await waitGame(
    `game.pickups.countAmbient() >= ${resp0?.n0 ?? 14}`, 6);
  out.push({
    name: 'a collected consumable respawns in ~6 s, not instantly',
    ok: !!resp0 && collected.ok && !during.ok && after.ok,
    detail: `collected in ${collected.t}s; still down at +${during.t}s; ` +
      `back to ${resp0?.n0} by +${(during.t + after.t).toFixed(1)}s`,
  });

  // 5. Kill rewards, goons: +6 respect each, cash drops on the pavement.
  //    All inside ONE evaluate so nothing else can move the numbers.
  //
  //    FORTY kills, in four waves of ten, because the drop is a coin
  //    (`GOON_DROP.p` is 0.5): over ten kills a FAIR coin lands outside 2..9
  //    about once in eighty runs, and a gate that goes red on a correct build
  //    1% of the time teaches everyone to re-run it. Forty samples sit inside
  //    8..32 with ~3.8 sigma of headroom and still catch a rate stuck at 0 or 1.
  //
  //    `voided` is the other hidden variable: `_dropCash` pays a won drop
  //    straight into the wallet when the 64-slot pickup pool is full, so a
  //    crowded pool reads as "the drop never happened". Stale drops are cleared
  //    first and the fallback must not fire at all.
  const goons = await inGame(`
    game.missions.abort();
    game.hostiles.clear();
    for (const p of game.pickups.live.slice()) {
      if (p.kind === 'cash' && !p.ambient) game.pickups.despawn(p);
    }
    const pos = game.wq.playerPos();
    const drops0 = game.pickups.live.filter((p) => p.kind === 'cash' && !p.ambient).length;
    const r0 = game.economy.respect;
    const k0 = game.save.totals.kills;
    const c0 = game.economy.cash;
    let killed = 0;
    for (let wave = 0; wave < 4; wave++) {
      for (let i = 0; i < 10; i++) {
        const s = game.wq.findGroundSpot(8, 20, pos.x, pos.z);
        const h = game.hostiles.spawn(s.x, s.z, { hp: 40, ranged: false, dmg: 1, leash: 90 });
        if (!h) continue;
        game.hostiles.hurt(h, 99999, false, h.position);
        killed++;
      }
      game.hostiles.clear();
    }
    const drops = game.pickups.live.filter((p) => p.kind === 'cash' && !p.ambient).length - drops0;
    const dR = game.economy.respect - r0;
    game.heat.clear('probe');
    game.hostiles.clear();
    return { killed, dR, drops, voided: game.economy.cash - c0,
             pool: game.pickups.live.length, kills: game.save.totals.kills - k0 };`);
  out.push({
    name: 'killing 40 goons pays +6 respect each and drops cash on about half',
    ok: goons.killed === 40 && goons.dR === 240 && goons.drops >= 8 && goons.drops <= 32 &&
        goons.voided === 0,
    detail: `${goons.killed} killed, +${goons.dR} respect, ${goons.drops} cash drops ` +
      `(pool ${goons.pool}/64, ${goons.voided} voided)`,
  });

  // 6. Kill rewards, cop units: +8 respect a cruiser, 70% drop — and a
  //    civilian sedan pays NOTHING (negative control).
  const cops = await inGame(`
    const pos = game.wq.playerPos();
    const r0 = game.economy.respect;
    const ck0 = game.freeroam.copKills;
    const drops0 = game.pickups.live.filter((p) => p.kind === 'cash' && !p.ambient).length;
    let wrecked = 0;
    for (let i = 0; i < 4; i++) {
      const s = game.wq.findRoadSpot(22, 30, pos.x, pos.z);
      const v = game.wq.spawnVehicle('police', s.x, s.z, 0);
      if (!v) continue;
      vehicles.damage(v, v.health + 20, v.position);
      if (v.destroyed) wrecked++;
    }
    const copR = game.economy.respect - r0;
    const drops = game.pickups.live.filter((p) => p.kind === 'cash' && !p.ambient).length - drops0;
    // negative control: a civilian wreck is worth nothing
    const r1 = game.economy.respect;
    const s2 = game.wq.findRoadSpot(22, 30, pos.x, pos.z);
    const c = game.wq.spawnVehicle('sedan', s2.x, s2.z, 0);
    if (c) vehicles.damage(c, c.health + 20, c.position);
    const civR = game.economy.respect - r1;
    game.heat.clear('probe');
    return { wrecked, copR, drops, copKills: game.freeroam.copKills - ck0, civR };`);
  out.push({
    name: 'wrecking 4 cop units pays +8 respect each with drops; a sedan pays 0',
    ok: cops.wrecked === 4 && cops.copR === 32 && cops.copKills === 4 &&
        cops.drops >= 1 && cops.civR === 0,
    detail: `${cops.wrecked} wrecked, +${cops.copR} respect, ${cops.drops} drops, ` +
      `copKills +${cops.copKills}, civilian wreck +${cops.civR}`,
  });

  // 7. Ped kills: +2 when attributed, NOTHING for a death across the city.
  const peds = await inGame(`
    const pos = game.wq.playerPos();
    const r0 = game.economy.respect;
    // a body dropping 500 m away that the player never shot at: no pay
    engine.events.emit('actor:death', {
      actor: { position: { x: pos.x + 500, y: 0, z: pos.z }, isHostile: false },
      point: { x: pos.x + 500, y: 0, z: pos.z },
      impulse: { x: 0, y: 1, z: 0 },
    });
    const farR = game.economy.respect - r0;
    // the same shape six metres away — his doing, +2
    engine.events.emit('actor:death', {
      actor: { position: { x: pos.x + 6, y: 0, z: pos.z }, isHostile: false },
      point: { x: pos.x + 6, y: 0, z: pos.z },
      impulse: { x: 0, y: 1, z: 0 },
    });
    const nearR = game.economy.respect - r0 - farR;
    return { farR, nearR };`);
  out.push({
    name: 'a ped kill pays +2 only when the player owns it',
    ok: peds.farR === 0 && peds.nearR === 2,
    detail: `unattributed +${peds.farR}, attributed +${peds.nearR}`,
  });

  // 8. The scavenge job counts the ambient field; completing it pays and the
  //    feed re-offers within seconds.
  const scav = await inGame(`
    game.missions.abort();
    window.__TAP__.offers.length = 0;
    window.__TAP__.start.length = 0;
    window.__TAP__.complete.length = 0;
    const cash0 = game.economy.cash;
    const L = game.jobs.start('pickup');
    window.__scavCash0 = cash0;
    return L ? { id: L.id, track: L.track, side: L.side, goal: L.goal, pay: L.pay,
                 active: game.jobs.lite.active,
                 started: window.__TAP__.start.some((e) => e.id === L.id) } : null;`);
  let scavDone = { ok: false, t: 0 };
  if (scav) {
    // Walk the field like the collect solver walks its crates.
    await inGame(`
      window.__scavWalk = setInterval(() => {
        const L = game.jobs.lite;
        if (!L.active) { clearInterval(window.__scavWalk); return; }
        const pos = game.wq.playerPos();
        let best = null, bd = 1e9;
        for (const p of game.pickups.live) {
          if (!p.ambient) continue;
          const d = Math.hypot(p.x - pos.x, p.z - pos.z);
          if (d < bd) { bd = d; best = p; }
        }
        if (best) game.wq.placePlayer(best.x, best.z, 0);
      }, 60);
      return true;`);
    scavDone = await waitGame('!game.jobs.lite.active', 20);
    await inGame(`clearInterval(window.__scavWalk); return true;`);
  }
  const scavAfter = await inGame(`
    return {
      paid: game.economy.cash - window.__scavCash0,
      complete: window.__TAP__.complete.filter((e) => String(e.id).startsWith('lite:')).length,
    };`);
  out.push({
    name: 'the scavenge job counts ambient pickups, completes and pays',
    ok: !!scav && scav.side === true && scav.started && scavDone.ok &&
        scavAfter.paid >= scav.pay && scavAfter.complete === 1,
    detail: scav
      ? `${scav.track} x${scav.goal} done in ${scavDone.t}s, +$${scavAfter.paid} (job $${scav.pay})`
      : 'did not start',
  });

  // ...and the feed offers the next thing without being asked.
  const reoffer = await waitGame(`window.__TAP__.offers.length >= 1`, 6);
  const offer = await inGame(`
    const o = window.__TAP__.offers[0] ?? null;
    return o ? { kind: o.kind, name: o.name } : null;`);
  out.push({
    name: 'the feed re-offers within seconds of a completion',
    ok: reoffer.ok && !!offer && !!offer.name,
    detail: offer ? `${offer.kind}: "${offer.name}" after ${reoffer.t}s` : 'no offer came',
  });

  // 9. The explore job: cruise to the pin, get paid.
  const exp = await inGame(`
    game.missions.abort();
    const cash0 = game.economy.cash;
    const L = game.jobs.start('explore');
    window.__expCash0 = cash0;
    return L ? { x: L.x, z: L.z, zone: L.zone, pay: L.pay, active: game.jobs.lite.active } : null;`);
  let expDone = { ok: false, t: 0 };
  if (exp) {
    await inGame(`game.wq.placePlayer(ARG.x, ARG.z, 0); return true;`, { x: exp.x, z: exp.z });
    expDone = await waitGame('!game.jobs.lite.active', 8);
  }
  const expAfter = await inGame(`return { paid: game.economy.cash - window.__expCash0 };`);
  out.push({
    name: 'the explore job completes at the named zone and pays',
    ok: !!exp && expDone.ok && expAfter.paid >= (exp?.pay ?? 1),
    detail: exp ? `"${exp.zone}" reached in ${expDone.t}s, +$${expAfter.paid}` : 'did not start',
  });

  // 10. The copwar job runs (police `spawnCop(crooked)` or graceful degrade)
  //     and completes off the same cop-unit ledger the rewards pay on.
  const cw = await inGame(`
    game.missions.abort();
    game.heat.clear('probe');
    const cash0 = game.economy.cash;
    const L = game.jobs.start('copwar');
    window.__cwCash0 = cash0;
    return L ? { goal: L.goal, pay: L.pay, active: game.jobs.lite.active,
                 hasSpawnCop: typeof (engine.ctx.peek('police') || {}).spawnCop === 'function' } : null;`);
  let cwDone = { ok: false, t: 0 };
  if (cw) {
    await inGame(`
      const pos = game.wq.playerPos();
      for (let i = 0; i < ARG.goal; i++) {
        const s = game.wq.findRoadSpot(22, 30, pos.x, pos.z);
        const v = game.wq.spawnVehicle('police', s.x, s.z, 0);
        if (v) vehicles.damage(v, v.health + 20, v.position);
      }
      return true;`, { goal: cw.goal });
    cwDone = await waitGame('!game.jobs.lite.active', 8);
    await inGame(`game.heat.clear('probe'); return true;`);
  }
  const cwAfter = await inGame(`return { paid: game.economy.cash - window.__cwCash0 };`);
  out.push({
    name: 'the copwar job counts downed cop units and pays out',
    ok: !!cw && cwDone.ok && cwAfter.paid >= (cw?.pay ?? 1),
    detail: cw
      ? `${cw.goal} units in ${cwDone.t}s, +$${cwAfter.paid} (spawnCop: ${cw.hasSpawnCop})`
      : 'did not start',
  });

  // 11. The speed job: hold the target and the payout lands. SIMULATED speed —
  //     the harness pins the velocity the way the deliver solver pins the drive.
  const spd = await inGame(`
    game.missions.abort();
    const cash0 = game.economy.cash;
    const L = game.jobs.start('speed');
    window.__spdCash0 = cash0;
    if (!L) return null;
    const pos = game.wq.playerPos();
    const s = game.wq.findRoadSpot(10, 40, pos.x, pos.z);
    const v = game.wq.spawnVehicle('sports', s.x, s.z, s.yaw);
    if (!v) return null;
    game.debugBoard(v);
    window.__spdVeh = v;
    return { tgt: L.tgt, pay: L.pay };`);
  let spdDone = { ok: false, t: 0 };
  if (spd) {
    await inGame(`
      const v = window.__spdVeh;
      const s = ARG.tgt + 4;
      const home = { x: v.position.x, y: v.position.y, z: v.position.z };
      window.__spdStop = false;
      // Frame-locked, and the car is held on its spawn spot.
      //
      // The pin used to run on a 16 ms wall-clock interval and let the car
      // travel: at 30 m/s it covers 90 m in the 3-second hold, so whether the
      // job paid came down to whether the randomly chosen road spot had a wall
      // that far along it. One collision drains the hold at double rate and the
      // run cannot recover inside the cap — a green or red verdict decided by
      // the spawn dice, not by the job. The speed the job reads is still the
      // vehicle's own forwardSpeed; only the scenery is taken out of it.
      const tick = () => {
        if (window.__spdStop || !game.jobs.lite.active || !v || v.destroyed) return;
        v.position.set(home.x, home.y, home.z);
        const q = v.quaternion;
        const fx = 2 * (q.x * q.z + q.w * q.y);
        const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
        if (v.velocity) v.velocity.set(fx * s, 0, fz * s);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;`, { tgt: spd.tgt });
    spdDone = await waitGame('!game.jobs.lite.active', 15);
    await inGame(`
      window.__spdStop = true;
      const v = window.__spdVeh;
      window.__spdSeen = v ? Math.round(Math.abs(v.forwardSpeed ?? 0) * 3.6) : -1;
      if (player.inVehicle) player.vehicles.abort(player.movement);
      if (window.__spdVeh) { game.wq.despawnVehicle(window.__spdVeh); window.__spdVeh = null; }
      return true;`);
  }
  const spdAfter = await inGame(`
    return { paid: game.economy.cash - window.__spdCash0, seen: window.__spdSeen ?? -1 };`);
  out.push({
    name: 'the speed job pays after holding the target (SIMULATED velocity)',
    ok: !!spd && spdDone.ok && spdAfter.paid >= (spd?.pay ?? 1),
    detail: spd ? `target ${Math.round(spd.tgt * 3.6)} km/h, held ${spdAfter.seen} km/h, ` +
                  `done in ${spdDone.t}s, +$${spdAfter.paid}`
                : 'did not start',
  });

  // 12. `dmgOut` is published on `game:difficulty` when the difficulty moves.
  await inGame(`window.__TAP__.diff.length = 0; game.setDifficulty('easy'); return true;`);
  const diffEasy = await waitGame(`window.__TAP__.diff.some((d) => d.id === 'easy')`, 3);
  await inGame(`game.setDifficulty('normal'); return true;`);
  const diffBack = await waitGame(`window.__TAP__.diff.some((d) => d.id === 'normal')`, 3);
  const diffs = await inGame(`
    const e = window.__TAP__.diff.find((d) => d.id === 'easy') ?? null;
    const n = window.__TAP__.diff.find((d) => d.id === 'normal') ?? null;
    return { easy: e && e.dmgOut, normal: n && n.dmgOut };`);
  out.push({
    name: 'difficulty publishes dmgOut for combat (easy 1.35, normal 1.0)',
    ok: diffEasy.ok && diffBack.ok && diffs.easy === 1.35 && diffs.normal === 1.0,
    detail: `easy ${diffs.easy}, normal ${diffs.normal}`,
  });

  // 13. The chosen radio station is mirrored into the save on `ui:station`.
  const radio = await inGame(`
    const ui = engine.ctx.peek('ui');
    if (!ui || typeof ui.cycleStation !== 'function') return { skip: true };
    ui.cycleStation(1);
    return { station: ui.state.station, saved: game.save.radio };`);
  out.push({
    name: 'switching the radio persists the station to the save',
    ok: radio.skip === true || (!!radio.station && radio.saved === radio.station),
    detail: radio.skip ? 'no ui in this build' : `${radio.station} -> save.radio ${radio.saved}`,
  });

  return out;
}

async function testSwitching() {
  // A section runs after the chapters, and the last chapter may have been the
  // finale — whose ending screen holds the sim at zero. Same rule as a chapter:
  // put the clock back first, or every timed assertion below is a lie.
  await resumeSim();
  const out = [];
  const r = await inGame(`
    game.missions.abort();
    game.heat.clear();
    // Give each brother a distinct fingerprint.
    game.save.chars.carson.cash = 1111;
    game.save.chars.aidan.cash = 2222;
    game.save.chars.dylan.cash = 3333;
    game.characters.switchTo('carson');
    const a = { id: game.character, cash: game.economy.cash,
                pos: game.wq.playerPos().toArray().map(n => +n.toFixed(1)),
                hp: player.health.max };
    game.wq.placePlayer(a.pos[0] + 40, a.pos[2] + 40, 0);
    const moved = game.wq.playerPos().toArray().map(n => +n.toFixed(1));
    game.characters.switchTo('dylan');
    const b = { id: game.character, cash: game.economy.cash,
                pos: game.wq.playerPos().toArray().map(n => +n.toFixed(1)),
                hp: player.health.max };
    game.characters.switchTo('carson');
    const c = { id: game.character, cash: game.economy.cash,
                pos: game.wq.playerPos().toArray().map(n => +n.toFixed(1)) };
    return { a, moved, b, c,
             dist: Math.hypot(a.pos[0]-b.pos[0], a.pos[2]-b.pos[2]),
             back: Math.hypot(moved[0]-c.pos[0], moved[2]-c.pos[2]) };`);
  out.push({
    name: 'switching moves the camera to the other brother across the city',
    ok: r.a.id === 'carson' && r.b.id === 'dylan' && r.dist > 300,
    detail: `${Math.round(r.dist)} m apart`,
  });
  out.push({
    name: 'each brother keeps his own money',
    ok: r.a.cash === 1111 && r.b.cash === 3333 && r.c.cash === 1111,
    detail: `carson $${r.a.cash}, dylan $${r.b.cash}, back to $${r.c.cash}`,
  });
  out.push({
    name: 'each brother keeps his own build (Carson 130 hp, Dylan 100 hp)',
    ok: r.a.hp === 130 && r.b.hp === 100,
    detail: `carson ${r.a.hp}, dylan ${r.b.hp}`,
  });
  out.push({
    name: 'returning to a brother finds him where you left him',
    ok: r.back < 12,
    detail: `${r.back.toFixed(1)} m from where he was left`,
  });

  const w = await inGame(`
    game.heat.clear();
    game.characters.switchTo('aidan');
    game.heat.raise(3, 0, 0);
    const hot = game.heat.wanted;
    game.characters.switchTo('dylan');
    const cool = game.heat.wanted;
    game.characters.switchTo('aidan');
    const back = game.heat.wanted;
    game.heat.clear();
    return { hot, cool, back };`);
  out.push({
    name: 'wanted level travels with the brother, not the world',
    ok: w.hot === 3 && w.cool === 0 && w.back === 3,
    detail: `aidan ${w.hot}* -> dylan ${w.cool}* -> aidan ${w.back}*`,
  });

  const ui = await inGame(`
    game.characters.switchTo('carson');
    engine.events.emit('ui:character', { id: 'dylan' });
    const after = game.character;
    game.characters.switchTo('carson');
    return { after };`);
  out.push({
    name: "the ui switch wheel's `ui:character` event drives the switch",
    ok: ui.after === 'dylan',
    detail: `-> ${ui.after}`,
  });
  return out;
}

async function testSave() {
  // A section runs after the chapters, and the last chapter may have been the
  // finale — whose ending screen holds the sim at zero. Same rule as a chapter:
  // put the clock back first, or every timed assertion below is a lie.
  await resumeSim();
  const out = [];
  const r = await inGame(`
    game.missions.abort();
    game.heat.clear();
    game.save.chars.carson.cash = 4242;
    game.save.chars.carson.respect = 175;
    game.save.chars.carson.chapter = 4;
    game.save.chars.carson.unlocked = ['flare','speargun'];
    game.save.chars.aidan.chapter = 2;
    game.save.packages = ['pk1','pk5','pk9'];
    game.save.races = { triangle: 161.5 };
    game.save.unlocks = ['sh_dt'];
    game.characters.switchTo('carson');
    game.wq.placePlayer(320, -640, 1.2);
    const before = game.snapshot();
    game.saveNow();
    const raw = localStorage.getItem('decarloboyz.save.v2');
    return { before, bytes: raw ? raw.length : 0, writes: game.writer.writes };`);
  out.push({ name: 'save writes to localStorage', ok: r.bytes > 200, detail: `${r.bytes} bytes` });

  const r2 = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('decarloboyz.save.v2'));
    return raw;
  });

  const b = r.before;
  const same =
    r2.chars.carson.cash === b.chars.carson.cash &&
    r2.chars.carson.respect === b.chars.carson.respect &&
    r2.chars.carson.chapter === b.chars.carson.chapter &&
    JSON.stringify(r2.chars.carson.unlocked) === JSON.stringify(b.chars.carson.unlocked) &&
    JSON.stringify(r2.packages) === JSON.stringify(b.packages) &&
    r2.races.triangle === b.races.triangle &&
    JSON.stringify(r2.unlocks) === JSON.stringify(b.unlocks) &&
    Array.isArray(r2.chars.carson.pos);
  out.push({
    name: 'save round-trips: money, respect, chapter, unlocks, packages, races, position',
    ok: same,
    detail: `carson $${r2.chars.carson.cash} ch${r2.chars.carson.chapter} @ ` +
      `[${(r2.chars.carson.pos ?? []).map((n) => Math.round(n)).join(', ')}], ` +
      `${r2.packages.length} packages`,
  });

  // Reload the page and confirm the save comes back.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 90000 });
  await page.waitForFunction('window.__SETTLED__ ? window.__SETTLED__() : true', null, { timeout: 90000 });
  const reloaded = await page.evaluate(() => {
    const game = window.__ENGINE__.ctx.get('game');
    const ui = window.__ENGINE__.ctx.peek('ui');
    return {
      source: game.saveSource,
      character: game.character,
      cash: game.economy.cash,
      respect: game.economy.respect,
      chapter: game.economy.char().chapter,
      packages: game.save.packages.length,
      pos: game.wq.playerPos().toArray().map((n) => Math.round(n)),
      aidan: game.save.chars.aidan.chapter,
      radio: game.save.radio ?? null,
      station: ui?.state?.station ?? null,
    };
  });
  out.push({
    name: 'a page reload restores the exact game state',
    ok: reloaded.source === 'v2' && reloaded.cash === 4242 && reloaded.chapter === 4 &&
        reloaded.packages === 3 && reloaded.character === 'carson' && reloaded.aidan === 2,
    detail: `${reloaded.character} $${reloaded.cash}, ch${reloaded.chapter}, ` +
      `${reloaded.packages} packages, at [${reloaded.pos.join(', ')}]`,
  });
  // The station chosen back in the economy tests must come back on its own —
  // the save carries it and `freeroam` re-emits `ui:station` on the first
  // frame, which is what sets `ui.state.station` here.
  const savedRadio = r2.radio ?? null;
  out.push({
    name: 'the chosen radio station survives the reload',
    ok: savedRadio == null ? reloaded.station == null : reloaded.station === savedRadio,
    detail: `saved "${savedRadio}" -> restored "${reloaded.station}"`,
  });
  return out;
}

/* ===================================================================== */
/* the authored chapter table, read from the module the game itself uses  */
/* ===================================================================== */

const { DATA, WEAPONS } = await page.evaluate(async () => {
  const mod = await import('/src/game/data.js');
  const out = {};
  for (const id of mod.BOY_ORDER) {
    out[id] = mod.BOYZ[id].story.map((c) => ({
      no: c.no, name: c.name, track: c.track, cash: c.cash, respect: c.respect, unlock: c.unlock ?? null,
    }));
  }
  return { DATA: out, WEAPONS: Object.keys(mod.WEAPON_LIB) };
});

const chapterCash = (boy, i) => DATA[boy][i].cash;
const chapterRespect = (boy, i) => DATA[boy][i].respect;
const chapterUnlock = (boy, i) => DATA[boy][i].unlock;

/* ===================================================================== */
/* run                                                                    */
/* ===================================================================== */

const plan = [];
if (args.chapter) {
  const [b, i] = String(args.chapter).split(':');
  plan.push([b, Number(i)]);
} else if (args.quick) {
  const seen = new Set();
  for (const b of BOYS) {
    DATA[b].forEach((c, i) => {
      if (seen.has(c.track)) return;
      seen.add(c.track);
      plan.push([b, i]);
    });
  }
} else {
  for (const b of args.boy ? [args.boy] : BOYS) {
    for (let i = 0; i < DATA[b].length; i++) plan.push([b, i]);
  }
}

log(`\nDECARLO BOYZ — chapter harness (${plan.length} chapters)\n`);

for (const [b, i] of plan) {
  const r = await runChapter(b, i);
  results.push(r);
  if (!JSON_OUT) {
    const mark = r.ok ? '  PASS' : '  FAIL';
    log(`${mark}  ${b.padEnd(7)} ${(r.no ?? '?').padEnd(5)} ${(r.name ?? '').padEnd(22)} ` +
      `${(r.track ?? '').padEnd(13)} $${String(r.payout ?? 0).padStart(5)}  ${r.note ?? r.reason ?? ''}`);
    for (const c of r.checks ?? []) {
      if (!c.ok) log(`          x ${c.name}: ${c.detail}`);
    }
  }
}

log('\n--- character switching -------------------------------------------');
const switching = await testSwitching();
for (const t of switching) log(`  ${t.ok ? 'PASS' : 'FAIL'}  ${t.name}  (${t.detail})`);

log('\n--- failure, economy, free roam -----------------------------------');
const failures = await testFailures();
for (const t of failures) log(`  ${t.ok ? 'PASS' : 'FAIL'}  ${t.name}  (${t.detail})`);

log('\n--- story shape: escape phase, ward, restarts, ending -------------');
const storyShape = await testStoryShape();
for (const t of storyShape) log(`  ${t.ok ? 'PASS' : 'FAIL'}  ${t.name}  (${t.detail})`);

log('\n--- pickups, kill rewards, the job feed, radio --------------------');
const economy = await testEconomy();
for (const t of economy) log(`  ${t.ok ? 'PASS' : 'FAIL'}  ${t.name}  (${t.detail})`);

log('\n--- save / load ----------------------------------------------------');
const saves = await testSave();
for (const t of saves) log(`  ${t.ok ? 'PASS' : 'FAIL'}  ${t.name}  (${t.detail})`);

const chapterPass = results.filter((r) => r.ok).length;
const otherTests = [...switching, ...failures, ...storyShape, ...economy, ...saves];
const otherPass = otherTests.filter((t) => t.ok).length;
// Errors thrown by another subsystem are reported but do not fail this suite —
// `game` cannot fix `buildings`, and a red exit code for a regression outside
// this subsystem makes the harness useless as a gate. Anything that names
// `src/game/` does fail it.
const realErrors = pageErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
const ourErrors = realErrors.filter((e) => /src\/game\//.test(e));
const foreignErrors = realErrors.filter((e) => !/src\/game\//.test(e));

const summary = {
  chapters: { total: results.length, passed: chapterPass, failed: results.length - chapterPass },
  systems: { total: otherTests.length, passed: otherPass, failed: otherTests.length - otherPass },
  pageErrors: ourErrors.slice(0, 10),
  foreignErrors: dedupe(foreignErrors).slice(0, 6),
  pageErrorCount: errFlood,
  results,
  switching,
  failures,
  storyShape,
  economy,
  saves,
};

if (JSON_OUT) console.log(JSON.stringify(summary, null, 2));
else {
  log('\n===================================================================');
  log(`  chapters   ${chapterPass}/${results.length}`);
  log(`  systems    ${otherPass}/${otherTests.length}`);
  log(`  game errors ${ourErrors.length}`);
  for (const e of ourErrors.slice(0, 6)) log(`     ! ${e.slice(0, 200)}`);
  const foreign = dedupe(foreignErrors);
  if (foreign.length) {
    log(`  other subsystems ${foreignErrors.length} error(s), ${foreign.length} distinct — NOT gated here:`);
    for (const e of foreign.slice(0, 6)) log(`     ~ ${e.slice(0, 150)}`);
  }
  log('===================================================================\n');
}

await browser.close();
server?.kill();
process.exit(chapterPass === results.length && otherPass === otherTests.length && ourErrors.length === 0 ? 0 : 1);
