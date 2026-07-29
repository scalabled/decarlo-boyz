#!/usr/bin/env node
/**
 * MELEE HARNESS — does a swing that visually lands actually hit?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `src/player/playtest.mjs --script=melee` measures the BODY: the arc, the hand
 * speed, the counter-rotation. It cannot tell you whether the fan in
 * `weapons/melee.js` found anything, because `player` installed a fallback that
 * resolves any missed swing through `peds.nearest()` — so from the outside a
 * broken solver and a working one produce identical damage.
 *
 * This harness measures THIS subsystem's solver and nothing else:
 *
 *   1. it neutralises `player.meleeReach.update` in the page, so nothing but
 *      `MeleeSolver.strike()` can book a hit;
 *   2. it teleports the player to a MEASURED distance in front of a living
 *      pedestrian that has hit capsules, squares body and camera onto him, and
 *      re-squares before every single swing (a startled ped walks out of the
 *      arc in six frames, and then you are measuring the ped's nav, not the fan);
 *   3. it swings each of the four melee weapons at 1.0 / 1.6 / 2.4 m and reports
 *      `hits / swings` per cell plus the ray origin height and the target's own
 *      capsule extents, so a failure says WHERE the fan went, not just that it
 *      missed.
 *
 * The pass condition is per weapon: every swing inside the weapon's own reach
 * must connect. `reach` is 3.0-4.0 m across the melee set, so all three
 * distances are inside it for all four weapons and the expected result is a
 * clean 12/12.
 *
 *   npm run build && node src/weapons/meleetest.mjs
 *   node src/weapons/meleetest.mjs --json
 *   node src/weapons/meleetest.mjs --fallback   # leave `player`'s net in place
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
const KEEP_FALLBACK = !!args.fallback;
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

const WEAPONS = (args.weapon ? String(args.weapon).split(',') : ['fists', 'pipe', 'wrench', 'crowbar']);
const DISTANCES = (args.dist ? String(args.dist).split(',').map(Number) : [1.0, 1.6, 2.4]);
/**
 * Metres to raise the attacker above his target — a kerb, a step, a loading
 * dock. This is the case the old horizontal fan could never survive and the
 * reason the fan is cast at three vertical slopes: `--step=0.3` is a kerb,
 * `--step=-0.3` is standing in the gutter swinging up at the pavement.
 */
const STEP = args.step ? Number(args.step) : 0;

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

let report = null;
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 150000 });
  await pump(150);

  /* ---- arm the page: control on, fallback off, crowd resident ---------- */
  await page.evaluate((keepFallback) => {
    const e = window.__ENGINE__;
    const p = e.ctx.peek('player');
    e.ctx.input.frozen = false;
    if (p?.setControlEnabled) p.setControlEnabled(true);
    if (!keepFallback && p?.meleeReach) {
      // Neutralise WITHOUT removing it: `player.meleeStats` stays readable and
      // nothing else in the frame changes shape.
      p.meleeReach._realUpdate = p.meleeReach.update.bind(p.meleeReach);
      p.meleeReach.update = () => {};
    }
    const peds = e.ctx.peek('peds');
    if (peds) peds.crewAuto = false;
  }, KEEP_FALLBACK);
  await pump(150);

  const cells = [];
  for (const weapon of WEAPONS) {
    for (const dist of DISTANCES) {
      // Three swings per cell. Each one re-squares first.
      const swings = [];
      for (let k = 0; k < 3; k++) {
        const placed = await page.evaluate(({ weapon, dist, step }) => {
          const e = window.__ENGINE__;
          const p = e.ctx.peek('player');
          const peds = e.ctx.peek('peds');
          const phys = e.ctx.peek('physics');
          const wp = e.ctx.peek('weapons');
          if (!p || !peds || !wp) return { ok: false, why: 'missing subsystem' };

          /**
           * A ped with LIVE HIT CAPSULES, ON HIS FEET.
           *
           * Three filters, all of which cost a run of false failures to learn:
           * peds beyond body range carry no capsules at all, so a fan aimed at
           * one can only ever find the pavement behind him; a ped in STATE.DOWN
           * is following a ragdoll, so `syncColliders` has stopped and his
           * capsules are frozen wherever he fell (the tell is a torso band that
           * is identical in twelve consecutive cells and a metre under the
           * player's feet); and a body that has been beaten across earlier
           * cells is on the floor by the third weapon.
           */
          let best = null, bd = 1e9;
          for (const q of peds.peds ?? []) {
            if (!q?.active || !q.alive || q.vehicle) continue;
            if (!q.colliders?.length || !q.body) continue;
            if (q.state === 'down' || q.state === 'dead' || q.ragdoll) continue;
            /* Capsules that have stopped tracking the body are worse than no
             * capsules: they answer raycasts from wherever they froze. */
            const t = q.colliders.find((c) => c.part === 'torso');
            if (!t) continue;
            const cx = (t.ax + t.bx) * 0.5, cz = (t.az + t.bz) * 0.5;
            if (Math.hypot(cx - q.position.x, cz - q.position.z) > 0.6) continue;
            const d = (q.position.x - p.position.x) ** 2 + (q.position.z - p.position.z) ** 2;
            if (d < bd) { bd = d; best = q; }
          }
          if (!best) return { ok: false, why: 'no upright ped with live hit capsules' };

          /* Stand the player `dist` from him, on his ground, facing him. */
          const dx = p.position.x - best.position.x;
          const dz = p.position.z - best.position.z;
          const l = Math.hypot(dx, dz) || 1;
          const x = best.position.x + (dx / l) * dist;
          const z = best.position.z + (dz / l) * dist;
          /**
           * Stand him on the TARGET's floor.
           *
           * Probing from four metres up finds the awning, the fire escape or
           * the shop roof over the pavement, and the player lands on it — which
           * is how a run came back "crowbar 0/3" with the ped's torso a metre
           * and a half BELOW the attacker's boots. Probe from just above the
           * ped's own head, and if what comes back is not his floor, use his
           * floor.
           */
          const gy = phys?.groundHeight?.(x, z, best.position.y + 1.1);
          const level = Number.isFinite(gy) && Math.abs(gy - best.position.y) < 0.4;
          const y = (level ? gy + 0.02 : best.position.y) + step;
          const yaw = Math.atan2(-(best.position.x - x), -(best.position.z - z));
          p.movement.teleport(x, y, z, yaw);
          /* A stepped-up attacker would otherwise fall straight back down. */
          if (step !== 0) p.movement.velocity.set(0, 0, 0);
          p.rig.reset(p.movement.anchorHeight, p.movement.position, yaw);
          p.rig.pitch = p.rig.pitchTarget = 0;
          p.rig.applyTo(e.camera);
          e.camera.updateMatrixWorld();

          /**
           * PIN HIM. A ped that has just been punched runs, and by the contact
           * frame of the NEXT swing he is four metres away — which is how the
           * first version of this harness reported "0/3 at 2.4 m" against a
           * target that was really at 5.8 m. This rAF is registered after the
           * engine's, so it writes the position back every frame AFTER the
           * ped's own update and before the next one reads it.
           */
          /* Top him up. Twelve cells x three swings is 900 damage; without this
           * the target dies in the second cell, loses his hit capsules, and
           * every later miss is really "there was nobody there". */
          best.health = 100;
          if (window.__PIN__) window.__PIN__.on = false;
          const pin = {
            ped: best, on: true,
            x: best.position.x, y: best.position.y, z: best.position.z,
          };
          window.__PIN__ = pin;
          const tick = () => {
            if (!pin.on) return;
            pin.ped.position.set(pin.x, pin.y, pin.z);
            pin.ped.velocity.set(0, 0, 0);
            pin.ped.speed = 0;
            pin.ped.desiredSpeed = 0;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);

          wp.setWeaponImmediate(weapon);
          wp._fireTimer = 0;
          wp.rig.swingT = -1;
          window.__MT__ = { ped: best, before: { ...wp.melee.stats } };
          /* `p.position` is the INTERPOLATED render position and still holds last
           * frame's value on the teleport frame — read the physics one. */
          return { ok: true, stepY: +(p.movement.position.y - best.position.y).toFixed(3) };
        }, { weapon, dist, step: STEP });
        if (!placed.ok) { swings.push({ ok: false, why: placed.why }); continue; }

        // A few frames so the animator, the hit capsules and the pin settle.
        await pump(6);
        const fired = await page.evaluate(() => {
          const e = window.__ENGINE__;
          const wp = e.ctx.peek('weapons');
          const p = e.ctx.peek('player');
          const m = window.__MT__;
          const ped = m.ped;
          wp._fireTimer = 0;
          m.before = { ...wp.melee.stats };
          /* Everything geometric is recorded HERE, on the frame the swing is
           * booked, not fifty frames later when the world has moved on. */
          let torso = null, head = null;
          for (const c of ped.colliders ?? []) {
            const lo = Math.min(c.ay, c.by) - c.radius;
            const hi = Math.max(c.ay, c.by) + c.radius;
            if (c.part === 'torso') torso = [+lo.toFixed(3), +hi.toFixed(3), +c.radius.toFixed(3)];
            if (c.part === 'head') head = [+lo.toFixed(3), +hi.toFixed(3), +c.radius.toFixed(3)];
          }
          const dx = ped.position.x - p.position.x;
          const dz = ped.position.z - p.position.z;
          const started = wp.tryMelee();
          return {
            started,
            distance: +Math.hypot(dx, dz).toFixed(2),
            feetY: +p.position.y.toFixed(3),
            headY: +p.headPosition.y.toFixed(3),
            torso, head,
          };
        });
        await pump(45);
        const got = await page.evaluate(() => {
          const e = window.__ENGINE__;
          const wp = e.ctx.peek('weapons');
          const p = e.ctx.peek('player');
          const m = window.__MT__;
          const sol = wp.melee.stats;
          const geo = wp.melee.lastProbe ?? null;
          if (window.__PIN__) window.__PIN__.on = false;
          return {
            swings: sol.swings - m.before.swings,
            hits: sol.hits - m.before.hits,
            solids: (sol.solidHits ?? 0) - (m.before.solidHits ?? 0),
            originY: geo ? +geo.originY.toFixed(3) : null,
            lowestRayY: geo ? +geo.lowY.toFixed(3) : null,
            highestRayY: geo ? +geo.highY.toFixed(3) : null,
            cols: geo?.cols ?? null,
            rays: geo?.rays ?? null,
            fallbackHits: p.meleeStats?.fallbackHits ?? 0,
          };
        });
        swings.push({ ok: true, stepY: placed.stepY, ...fired, ...got });
      }
      const good = swings.filter((s) => s.ok);
      const hits = good.reduce((a, s) => a + (s.hits > 0 ? 1 : 0), 0);
      cells.push({
        weapon, dist,
        swings: good.length,
        hits,
        pass: good.length > 0 && hits === good.length,
        sample: good[0] ?? swings[0] ?? null,
      });
      log(
        `  ${weapon.padEnd(8)} @ ${dist.toFixed(1)} m  ` +
        `${hits}/${good.length} hits  ` +
        (good[0]
          ? `d ${good[0].distance} · step ${good[0].stepY} · origin y ${good[0].originY ?? '?'} · ` +
            `cols ${good[0].cols ?? '?'} · rays ${good[0].rays ?? '?'}`
          : (swings[0]?.why ?? ''))
      );
      /* A failing cell has to say WHY, per swing, or the next person re-derives
       * the geometry from scratch. */
      if (hits !== good.length) {
        for (const s of swings) {
          if (!s.ok) { log(`      skipped: ${s.why}`); continue; }
          log(
            `      ${s.hits ? 'HIT ' : 'MISS'} d ${s.distance} step ${s.stepY} ` +
            `origin ${s.originY} band ${s.lowestRayY}..${s.highestRayY} ` +
            `torso ${s.torso ? s.torso[0] + '..' + s.torso[1] : 'none'} ` +
            `solid ${s.solids} started ${s.started}`
          );
        }
      }
    }
  }

  const total = cells.reduce((a, c) => a + c.swings, 0);
  const hit = cells.reduce((a, c) => a + c.hits, 0);
  report = {
    fallbackDisabled: !KEEP_FALLBACK,
    cells,
    totals: { swings: total, hits: hit },
    pass: total > 0 && hit === total,
    errors: errs.slice(0, 6),
  };
} catch (e) {
  report = {
    pass: false, fallbackDisabled: !KEEP_FALLBACK,
    error: String(e).slice(0, 400), errors: errs.slice(0, 6),
  };
} finally {
  await browser.close();
  server?.kill?.();
}

if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else {
  console.log('');
  console.log(`MELEE SOLVER: ${report.totals?.hits ?? 0}/${report.totals?.swings ?? 0} swings connected` +
    (report.fallbackDisabled ? '  (player fallback DISABLED)' : '  (player fallback live)'));
  if (report.error) console.log('ERROR ' + report.error);
  for (const e of report.errors ?? []) console.log('  page error: ' + e);
  console.log(report.pass ? 'PASS' : 'FAIL');
}
process.exit(report.pass ? 0 : 1);
