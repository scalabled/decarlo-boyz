#!/usr/bin/env node
/**
 * STATIC COLLISION BENCH — what the BVH costs a real play session.
 *
 *   node src/physics/colbench.mjs                # A/B/B/A, both scenarios
 *   node src/physics/colbench.mjs --frames=900
 *   node src/physics/colbench.mjs --arms=A,B     # one pass each
 *   node src/physics/colbench.mjs --quality=low
 *
 * ARM A is `?owbvh=flat`: the pre-fix single tree over all 329k triangles,
 * rebuilt from scratch on every change. ARM B is the shipped two-level tree.
 * Both run in the SAME invocation, interleaved A/B/B/A, because this checkout
 * is shared with several other agents and the load average moves every absolute
 * millisecond. The numbers to trust are the COUNTS and the TRIANGLES PROCESSED
 * PER SECOND OF PLAY, which no amount of background load can change.
 *
 * Two scenarios, both scripted so the two arms do identical work:
 *   walk    on foot with the camera turning and bursts of fire — exactly what
 *           `tools/profile.mjs` drives, and what the periodic freeze was
 *           measured against. Slow streaming, the terrain collider re-snapping
 *           on its 48 m grid, props and building tiles moving in and out.
 *   drive   the player is teleported along a 1.6 km route at ~45 m/s, which is
 *           the streaming rate of a car at speed.
 *
 * Note the counters this leans on: `staticWorld.buildStats.lastTris` is how
 * many triangles the LAST rebuild actually processed. On the flat path that is
 * always the whole world; on the two-level path it is only what changed, and
 * the ratio between them is the fix.
 */
import { chromium } from 'playwright';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const FRAMES = Number(args.frames ?? 900);
const QUALITY = String(args.quality ?? 'low');
const ARMS = String(args.arms ?? 'A,B,B,A').split(',').map((s) => s.trim());

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio',
         '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};
const q = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2);

/**
 * One arm: boot, settle, instrument `StaticWorld.build`, run both scenarios.
 * The instrumentation wraps the method rather than reading `buildMs`, so a
 * build triggered twice in one frame is counted twice — which is exactly the
 * failure mode being measured.
 */
async function runArm(arm) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));

  const flat = arm === 'A';
  const url = `http://127.0.0.1:${port}/?q=${QUALITY}${flat ? '&owbvh=flat' : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  // Let the first ring finish so the measurement is steady-state streaming, not boot.
  await page.evaluate(() => new Promise((d) => {
    let i = 0;
    const t = () => (++i >= 240 ? d() : requestAnimationFrame(t));
    requestAnimationFrame(t);
  }));

  const out = await page.evaluate(async ({ FRAMES }) => {
    const e = window.__ENGINE__;
    const phys = e.ctx.peek('physics');
    const world = e.ctx.peek('world');
    const player = e.ctx.peek('player');
    const W = phys.staticWorld;

    const rec = { builds: [], tris: [], frames: [] };
    const orig = W.build.bind(W);
    let active = null;
    W.build = function patched() {
      const wasDirty = this.dirty;
      const t0 = performance.now();
      orig();
      const ms = performance.now() - t0;
      if (active && wasDirty) {
        active.builds.push(ms);
        active.tris.push(this.buildStats.lastTris);
        active.frame.push(e.ctx.time.frame);
      }
    };

    const pump = (n, onFrame) => new Promise((done) => {
      let i = 0;
      let last = performance.now();
      const t = () => {
        const now = performance.now();
        active.frames.push(now - last);
        last = now;
        if (onFrame) onFrame(i);
        if (++i >= n) return done();
        requestAnimationFrame(t);
      };
      requestAnimationFrame(t);
    });

    const scenario = async (name, onFrame) => {
      active = { name, builds: [], tris: [], frame: [], frames: [], t0: performance.now() };
      await pump(FRAMES, onFrame);
      active.wallMs = performance.now() - active.t0;
      const r = active;
      active = null;
      return r;
    };

    // 1. WALK. What `tools/profile.mjs` drives, and what the every-few-seconds
    //    freeze was measured against: on foot, looking around.
    e.input.enabled = true;
    e.input.frozen = false;
    player?.setControlEnabled?.(true);
    const walk = await scenario('walk', (i) => {
      e.camera.rotation.y += 0.006;
      try { e.input.down.add('KeyW'); } catch { /* input not ready */ }
      if (i % 90 < 30) e.input.down.add('Mouse0'); else e.input.down.delete('Mouse0');
    });
    try { e.input.down.delete('KeyW'); e.input.down.delete('Mouse0'); } catch { /* */ }

    // 2. DRIVE. A scripted 1.6 km route at driving speed, same for both arms.
    const sp = world.spawn ? world.spawn(0) : null;
    const base = sp?.position ?? e.ctx.camera.position.clone();
    const SPEED = 45 / 60; // metres per frame at 60 Hz
    const drive = await scenario('drive', (i) => {
      const d = i * SPEED;
      // An L-shaped route so the stream ring sweeps two axes.
      const x = base.x + Math.min(d, 800) + Math.max(0, d - 800) * 0.15;
      const z = base.z + Math.max(0, d - 800) * 0.99;
      const y = (world.walkableHeightAt ? world.walkableHeightAt(x, z) : 0) + 1.7;
      player?.teleport?.({ x, y, z }, 0);
    });

    W.build = orig;
    return {
      scenarios: [walk, drive].map((s) => ({
        name: s.name,
        builds: s.builds,
        tris: s.tris,
        frames: s.frames,
        wallMs: s.wallMs,
        // The five most expensive rebuilds and how much geometry each one
        // actually processed — the pair that says whether a spike is the
        // structure or just a big tile.
        worst: s.builds
          .map((ms, i) => ({ ms: +ms.toFixed(2), tris: s.tris[i] }))
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 5),
        doubleFrames: (() => {
          let n = 0;
          for (let i = 1; i < s.frame.length; i++) if (s.frame[i] === s.frame[i - 1]) n++;
          return n;
        })(),
      })),
      resident: {
        triangles: W.triCount,
        objects: phys.stats.staticObjects,
        nodes: W.nodeCount,
        flat: W.flat,
        parts: W.partCount,
        compactions: W.buildStats.compactions,
        refits: W.buildStats.refits,
        deferrals: W.buildStats.deferrals,
        budgetMs: W.budgetMs,
        truncations: { ...W.truncations },
      },
      holes: phys.worldHolesAfterReady,
      rejected: phys.rejectedStatics,
    };
  }, { FRAMES });

  await page.close();
  return { arm, flat, errs, ...out };
}

const results = [];
for (const arm of ARMS) {
  process.stderr.write(`  running arm ${arm} (${arm === 'A' ? 'flat rebuild' : 'two-level'})...\n`);
  results.push(await runArm(arm));
}

/* ------------------------------------------------------------------ */

const rows = [];
for (const r of results) {
  for (const s of r.scenarios) {
    const secs = s.wallMs / 1000;
    const total = s.builds.reduce((a, b) => a + b, 0);
    const tris = s.tris.reduce((a, b) => a + b, 0);
    rows.push({
      arm: r.arm,
      mode: r.flat ? 'flat' : 'two-level',
      scenario: s.name,
      seconds: +secs.toFixed(1),
      rebuilds: s.builds.length,
      rebuildsPerSec: +(s.builds.length / secs).toFixed(2),
      trisPerSecOfPlay: Math.round(tris / secs),
      buildMsTotal: +total.toFixed(1),
      buildMsMedian: +median(s.builds).toFixed(2),
      buildMsP95: +q(s.builds, 0.95).toFixed(2),
      buildMsMax: +Math.max(0, ...s.builds).toFixed(2),
      pctOfWallClock: +((total / s.wallMs) * 100).toFixed(2),
      framesPayingTwice: s.doubleFrames,
      frameMsP50: +median(s.frames).toFixed(2),
      frameMsP99: +q(s.frames, 0.99).toFixed(2),
      frameMsMax: +Math.max(0, ...s.frames).toFixed(2),
      worst: s.worst,
      buildsOver5ms: s.builds.filter((x) => x > 5).length,
      buildsOver16ms: s.builds.filter((x) => x > 16).length,
    });
  }
}

console.log(JSON.stringify({
  quality: QUALITY,
  frames: FRAMES,
  armOrder: ARMS,
  resident: results.map((r) => ({ arm: r.arm, ...r.resident })),
  correctness: results.map((r) => ({
    arm: r.arm, worldHolesAfterReady: r.holes, rejectedStatics: r.rejected,
    errors: r.errs.slice(0, 4),
  })),
  rows,
}, null, 2));

// A compact human summary under the JSON, per scenario, paired by arm.
for (const sc of ['walk', 'drive']) {
  const a = rows.filter((r) => r.arm === 'A' && r.scenario === sc);
  const b = rows.filter((r) => r.arm === 'B' && r.scenario === sc);
  if (!a.length || !b.length) continue;
  console.error(`\n${sc}:`);
  for (const r of [...a, ...b]) {
    console.error(
      `  ${r.mode.padEnd(9)} ${String(r.rebuilds).padStart(4)} rebuilds in ${r.seconds}s  ` +
      `median ${f2(r.buildMsMedian).padStart(7)} ms  max ${f2(r.buildMsMax).padStart(7)} ms  ` +
      `${(r.trisPerSecOfPlay / 1000).toFixed(0).padStart(6)}k tris/s of play  ` +
      `${f2(r.pctOfWallClock).padStart(6)}% of wall clock  ` +
      `${String(r.buildsOver5ms).padStart(3)} over 5 ms / ${String(r.buildsOver16ms).padStart(3)} over 16 ms`
    );
  }
}

await browser.close();
stopServer(server);
