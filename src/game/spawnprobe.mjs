#!/usr/bin/env node
/**
 * SPAWN PROBE — you must never start the game in the river.
 *
 * The player intermittently spawned swimming in the Monongahela, and on the
 * runs that "passed" he started on `sand`: a riverbank, not a street. It
 * survived one fix because it is a ONE-IN-N failure — `ctx.rng.fork()` is
 * seeded differently every boot, so a single green run proves nothing. This
 * boots the world N times and fails if ANY of them puts a brother somewhere he
 * should not be standing.
 *
 * Three populations, because they take different code paths through
 * `Director.spawnFor`:
 *   1. fresh saves       — the routine POI (Carson's is a BOATHOUSE)
 *   2. every brother     — switch to each in turn, at several hours
 *   3. a poisoned save   — a saved position in the middle of the river, which
 *                          must be rescued rather than trusted
 *
 *   npm run build && node src/game/spawnprobe.mjs [--runs=12]
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=')[1] : d;
};
const RUNS = Number(arg('runs', 10));

/** Anything that is not a place a man stands at the start of a GTA game. */
const BAD = new Set(['water', 'mud', 'river_silt', 'sand', null, undefined]);

const { port, server } = await startServer({});
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await b.newPage({ viewport: { width: 960, height: 540 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));

const pump = (n) =>
  page.evaluate((k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }), n);

/** Where is the player standing, and on what? */
const sample = (label) =>
  page.evaluate((l) => {
    const e = window.__ENGINE__;
    const w = e.ctx.peek('world');
    const p = e.ctx.peek('player');
    const g = e.ctx.peek('game');
    const pos = p?.position;
    if (!pos) return { label: l, ok: false, surface: null, note: 'no player' };
    const surface = w?.surfaceAt?.(pos.x, pos.z) ?? null;
    const water = w?.isWater?.(pos.x, pos.z) ?? false;
    const road = w?.roads?.nearestEdge?.(pos.x, pos.z, 300);
    return {
      label: l,
      surface,
      water,
      roadDist: road?.edge ? +road.dist.toFixed(1) : null,
      pos: [+pos.x.toFixed(1), +pos.y.toFixed(1), +pos.z.toFixed(1)],
      character: g?.character ?? null,
    };
  }, label);

const rows = [];
const check = (s) => {
  const ok = !s.water && !BAD.has(s.surface) && s.roadDist != null && s.roadDist < 60;
  rows.push({ ...s, ok });
  return ok;
};

try {
  for (let run = 0; run < RUNS; run++) {
    // A fresh save every time: this is the path a new player takes, and it is
    // the one that was drowning him.
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* private mode */ } });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
    await pump(60);
    check(await sample(`boot ${run + 1}`));

    // Each brother, at his own routine hour, on the first run only — twelve
    // full boots plus nine switches is enough signal without a ten-minute run.
    if (run === 0) {
      for (const hour of [6, 13, 21]) {
        for (const id of ['aidan', 'dylan', 'carson']) {
          await page.evaluate(([h, who]) => {
            const e = window.__ENGINE__;
            const g = e.ctx.peek('game');
            e.ctx.peek('sky')?.setTimeOfDay?.(h);
            g.director.hour = h;
            // Forget where he was so the ROUTINE path is the one under test.
            g.save.chars[who].pos = null;
            g.characters.switchTo(who);
          }, [hour, id]);
          await pump(20);
          check(await sample(`${id} @ ${hour}:00`));
        }
      }

      // A save written while SWIMMING must be rescued, not obeyed. Points are
      // found by asking `world` where the water actually is rather than being
      // hardcoded — a POI that merely sounds wet (The Point Fountain) is dry
      // sand, and a saved position on dry land must be honoured exactly,
      // because "returning to a brother finds him where you left him" is a
      // promise the switch makes.
      const wet = await page.evaluate(() => {
        const w = window.__ENGINE__.ctx.peek('world');
        const out = [];
        for (let i = 0; i < 4000 && out.length < 3; i++) {
          const x = (i * 137.5) % 2000 - 1000;
          const z = (i * 271.3) % 2000 - 1000;
          if (w?.isWater?.(x, z)) out.push([Math.round(x), Math.round(z)]);
        }
        return out;
      });
      for (const [x, z] of wet) {
        await page.evaluate(([px, pz]) => {
          const e = window.__ENGINE__;
          const g = e.ctx.peek('game');
          g.save.chars.carson.pos = [px, 0, pz];
          g.save.chars.carson.yaw = 0;
          g.characters.activeId = 'aidan';
          g.characters.switchTo('carson');
        }, [x, z]);
        await pump(20);
        check(await sample(`rescued from water ${x},${z}`));
      }

      // ...and the converse: a saved position on legal DRY ground is obeyed to
      // the metre. Over-eager relocation is its own bug and it broke the
      // switch harness the first time this validation went in.
      const kept = await page.evaluate(() => {
        const e = window.__ENGINE__;
        const g = e.ctx.peek('game');
        // `findRoadSpot` returns a REUSED record and `restore` -> `_parkCar`
        // calls it again to place the courtesy car, so the numbers have to be
        // copied out before the switch or the comparison is against whatever
        // the LAST caller wanted. (`util.js` warns about exactly this.)
        const s = g.wq.findRoadSpot(80, 400, 0, 0);
        const wantX = s.x, wantZ = s.z;
        g.save.chars.carson.pos = [wantX, 0, wantZ];
        g.characters.activeId = 'aidan';
        g.characters.switchTo('carson');
        const p = e.ctx.peek('player').position;
        return +Math.hypot(p.x - wantX, p.z - wantZ).toFixed(1);
      });
      rows.push({ label: 'a dry saved position is obeyed', surface: `${kept} m drift`,
        roadDist: 0, pos: [], ok: kept < 4 });
    }
  }

  const bad = rows.filter((r) => !r.ok);
  const w = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    console.log(
      `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(w)}  ${String(r.surface).padEnd(9)}` +
      ` road ${r.roadDist ?? '-'} m  [${(r.pos ?? []).join(', ')}]`
    );
  }
  console.log(`\n${rows.length - bad.length}/${rows.length} spawns on solid, road-connected ground`);
  if (bad.length) {
    console.log(`\nBAD SPAWNS:\n  ` + bad.map((r) => `${r.label}: ${r.surface}${r.water ? ' (IN WATER)' : ''}`).join('\n  '));
  }
  if (errs.length) console.log(`\nconsole errors:\n  ` + [...new Set(errs)].slice(0, 5).join('\n  '));
  process.exitCode = bad.length ? 1 : 0;
} catch (e) {
  console.error('spawnprobe failed:', e.message);
  console.error([...new Set(errs)].slice(0, 6).join('\n'));
  process.exitCode = 1;
} finally {
  await b.close();
  server?.kill();
}
