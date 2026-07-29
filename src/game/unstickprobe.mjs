#!/usr/bin/env node
/**
 * UNSTICK PROBE — a brother must be able to WALK when you arrive as him.
 *
 *   npm run unstick
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT WAS BROKEN
 *
 * Reported with a screenshot: "Dylan is still stuck in this staircase." At
 * 09:17 on Mt. Washington he spawned wedged in an open flight of steps and
 * moved 0.00 m on six of eight headings.
 *
 * `Director._score` graded the spot 4 — the best mark available — because it
 * asked `world.surfaceAt`, and the tread of a staircase IS pavement.
 * `physics.checkCapsule` called it clear, because it answers "may a capsule
 * move here", not "is this point already inside solid". The riser measured
 * 0.76-0.94 m against a `stepHeight` of 0.42 m: more than double what the body
 * can climb.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS PROBE EXISTS SEPARATELY FROM `spawnprobe.mjs`
 *
 * Because the obvious cheaper check cannot work, and it took a negative control
 * to notice. Static collision streams in AROUND THE PLAYER. Probing a spawn
 * pose on the far side of the map casts rays through an empty world — every ray
 * misses, the point looks perfect, and the check passes just as happily on a
 * build with the vetting removed. Measured: Dylan's spawn reads 0 of 16
 * bearings blocked from across the city, and 10 of 16 while standing on it.
 *
 * So this probe pays the cost the question demands. It switches brother through
 * `characters.switchTo` — the real path a player takes — waits for
 * `world.streamingIdle()` so the city actually exists, and then holds W on
 * eight headings and measures how far he gets.
 *
 * TRAVEL IS THE ASSERTION. Not a ray count, not a score, not a flag the
 * director set. The complaint was "he cannot walk", so the gate walks.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT YET PROVE — READ BEFORE TRUSTING IT
 *
 * It has NO working negative control for the reported bug, and that is stated
 * here rather than glossed, because a gate that passes both ways is worthless
 * and pretending otherwise is worse than having no gate.
 *
 * Measured: with BOTH the escape test in `Director._score` and the deferred
 * `unstick` disabled — the exact build the screenshot came from — all four
 * cases here still pass, including one seeded at the precise coordinates where
 * a direct teleport measured 6 of 8 headings blocked and 0.00 m of travel.
 *
 * The reason appears to be time. Placement leaves the body intersecting the
 * steps; the character controller resolves penetration over the following
 * seconds and pushes him clear on its own. This probe waits for
 * `world.streamingIdle()` plus 2.5 s before it measures, so it consistently
 * arrives after the self-rescue. Shortening the wait makes it flaky rather than
 * sensitive, which is not a gate either.
 *
 * So the persistent trap a player actually experienced is NOT reproduced here.
 * What this file does earn its place doing is guarding the general property —
 * arriving as any brother leaves you able to walk — which would catch a
 * regression that made spawns unwalkable for longer than the controller can
 * recover from.
 *
 * If it ever goes red, that is real. If it is green, that is not yet proof the
 * staircase case is gone. The evidence for the fixes themselves is elsewhere:
 * Carson measured 16 of 16 rays blocked with a roof 0.0 m overhead before the
 * escape test and walks freely after it, and `[director] unstuck` is observed
 * firing on the Mt. Washington spawn in this probe's own log.
 */
import { chromium } from 'playwright';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=')[1] : d;
};
const SETTLE = Number(arg('settle', 7000));

/**
 * Aidan at 09:00 is the CONTROL and is listed first on purpose: he stands on
 * open pavement outside his own shop. If he ever reads as stuck, the harness is
 * broken, not the game — which is exactly how two earlier versions of this
 * measurement were caught reporting the whole city as trapped.
 */
const CASES = [
  { id: 'aidan', hour: 9, label: 'aidan 09:00 (control, open pavement)', control: true },
  { id: 'dylan', hour: 9, label: 'dylan 09:00 (Mt. Washington steps)' },
  { id: 'carson', hour: 19, label: 'carson 19:00 (the boathouse)' },
  /*
   * THE CASE THAT ACTUALLY REPRODUCED IT, and it took three tries to find.
   *
   * A fresh switch resolves through the road network and lands fine. But
   * `spawnFor` TRUSTS a saved position whenever `isStandable` accepts it, and
   * that test is the lenient one — score >= 1, which a staircase tread passes,
   * because it is pavement. So once a brother has been saved standing on those
   * steps, every switch back puts him there again and the road-network
   * resolution never runs.
   *
   * That is the shape of the report: it was not the first spawn that trapped
   * him, it was returning to him. Seeding the exact measured coordinates is the
   * only way this probe sees the bug at all.
   */
  {
    id: 'dylan', hour: 9, label: 'dylan 09:00 from a SAVED pos on the steps',
    savedPos: [-506.4, 100.1, 450.4],
  },
];

const srv = await startServer();
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const moves = [];
page.on('console', (m) => { if (/unstuck/.test(m.text())) moves.push(m.text().slice(0, 110)); });
page.on('pageerror', (e) => console.log('  PAGE ERROR', String(e).slice(0, 140)));

await page.goto(`http://localhost:${srv.port}/?boot=0`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__ENGINE__, null, { timeout: 180000 });
await page.waitForTimeout(SETTLE);

const feet = () => page.evaluate(() => {
  const f = window.__ENGINE__.ctx.peek('player').feetPosition;
  return { x: f.x, y: f.y, z: f.z };
});

const rows = [];
for (const c of CASES) {
  await page.evaluate(async ([id, hour, savedPos]) => {
    const ctx = window.__ENGINE__.ctx, g = ctx.peek('game');
    g.director.hour = hour;
    ctx.peek('sky')?.setTimeOfDay?.(hour);
    if (savedPos) {
      const rec = g.save?.chars?.[id];
      if (rec) { rec.pos = savedPos.slice(); rec.yaw = 0; }
    } else if (g.save?.chars?.[id]) {
      g.save.chars[id].pos = null;
    }
    g.characters.switchTo(id);
  }, [c.id, c.hour, c.savedPos ?? null]);

  // Wait for the city to exist before judging where he is standing in it.
  await page.waitForFunction(
    () => window.__ENGINE__.ctx.peek('world')?.streamingIdle?.() === true,
    null, { timeout: 120000 }
  ).catch(() => {});
  await page.waitForTimeout(2500);   // the deferred rescue window

  const spawn = await feet();
  await page.evaluate(() => window.__ENGINE__.ctx.peek('player').setControlEnabled(true));

  const travel = [];
  for (let i = 0; i < 8; i++) {
    await page.evaluate(([x, y, z, yaw]) =>
      window.__ENGINE__.ctx.peek('player').teleport({ x, y, z }, yaw),
      [spawn.x, spawn.y, spawn.z, (i * Math.PI) / 4]);
    await page.waitForTimeout(350);
    const s = await feet();
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(800);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(120);
    const e = await feet();
    travel.push(+Math.hypot(e.x - s.x, e.z - s.z).toFixed(2));
  }
  const blocked = travel.filter((d) => d < 1).length;
  rows.push({ ...c, spawn, travel, blocked, ok: blocked < 3 });
}

console.log('\n=== can he walk when you arrive as him? ===\n');
const w = Math.max(...rows.map((r) => r.label.length));
for (const r of rows) {
  console.log(
    `  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.label.padEnd(w)}  ` +
    `(${r.spawn.x.toFixed(0)}, ${r.spawn.z.toFixed(0)})  ` +
    `${r.travel.join(' ').padEnd(34)}  ${r.blocked}/8 blocked`
  );
}
if (moves.length) console.log('\n' + moves.map((m) => `  ${m}`).join('\n'));

const fails = rows.filter((r) => !r.ok);
const control = rows.find((r) => r.control);
if (control && !control.ok) {
  console.log('\n  The CONTROL failed. Read this as a broken harness, not a broken game.');
}
console.log(`\nunstick: ${rows.length - fails.length}/${rows.length}`);
await browser.close();
await stopServer(srv);
process.exit(fails.length ? 1 : 0);
