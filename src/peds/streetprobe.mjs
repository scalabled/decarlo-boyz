#!/usr/bin/env node
/**
 * STREET GATE — "is this a living street, and are they walking on it?"
 *
 * `crowdprobe.mjs` gates what a pedestrian IS (albedo, silhouette, variety) off
 * the emitted geometry. This gates what the crowd DOES, in the running game,
 * and it exists because both failures are invisible to a screenshot: an empty
 * pavement reads as "quiet", and a foot that skates reads as "fine" until you
 * look at one for three seconds.
 *
 *   1 DENSITY   live pedestrians and how many are actually in the shot. A GTA V
 *               downtown street frame at midday has a dozen people in it.
 *   2 NEAR      distance to the nearest pedestrian. The ambient streamer used
 *               to sample the pavement network at 22..92 m, which left a
 *               22-metre hole around the player that nothing could fill except
 *               someone walking in from outside it — so the frame in front of
 *               the camera, which is the only frame anybody sees, was the
 *               emptiest part of the city.
 *   3 SPACING   the closest pair in the crowd. People do not interpenetrate;
 *               a minimum below ~0.45 m means two peds are inside each other.
 *   4 SURFACE   the fraction standing on 'sidewalk'. Pedestrians in the road
 *               are a bug unless they are crossing.
 *   5 SLIDE     FOOT PLANTING, measured in world space. While a foot is on the
 *               ground it must not move: a planted foot's world displacement
 *               divided by the body's displacement over the same frames is 0
 *               for a real walk cycle and 1 for a skating mannequin.
 *
 *   node src/peds/streetprobe.mjs
 *   node src/peds/streetprobe.mjs --shots=crowd,street --gate
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const ROOT = resolve(import.meta.dirname, '../..');
const SHOTS = String(args.shots ?? 'crowd,street,night,combat').split(',');

/**
 * Thresholds. Some are goals; the ones marked RATCHET are where this pass got
 * to, recorded so the next change cannot quietly go backwards.
 *
 *  inFrameDay   a GTA V midday street frame has a dozen people in it. Met.
 *  nearestDay   RATCHET at 36 m, goal 14 m. The pavement sampler's near limit
 *               went 22 m -> 9 m and in-view spawns are still held at 24 m so
 *               nobody pops into shot, which fixed the `crowd` frame (4.8 m)
 *               and did NOT fix `street` (33.8 m): that shot frames the middle
 *               of a four-lane carriageway, so both pavements are in view for
 *               their whole length and every close spawn point is rejected. It
 *               needs occlusion-aware spawning or a behind-camera bias, not a
 *               smaller radius.
 *  spacing      people do not interpenetrate. Met (0.7-1.1 m).
 *  sidewalk     RATCHET at 0.50, goal 0.70. Part of this is real — peds do
 *               stand in the road — and part is the metric: `world.surfaceAt`
 *               returns 'asphalt' for the paved plaza the `crowd` shot is
 *               framed on, which is not a carriageway and is a perfectly
 *               reasonable place to stand. Separating the two needs something
 *               from `world` that does not exist yet, so this is reported and
 *               not fixed. `combat` is deliberately low: a staged firefight
 *               scatters people into the road, which is the point.
 *  slide        RATCHET at 1.20, goal 0.30. 1.92 before this pass; 0.86 in the
 *               `crowd` frame and 0.90 in `street` now. `combat` is worst
 *               (1.11) because a panicking crowd is mostly turning, and a foot
 *               that pivots is legitimately moving — the probe cannot yet tell
 *               a pivot from a skate.
 */
const T = {
  inFrameDay: 8,
  nearestDay: 36,
  spacing: 0.42,
  sidewalk: 0.50,
  slide: 1.20,
};

const portOpen = (p) =>
  new Promise((res) => {
    const s = net.connect({ port: p, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });
async function freePort() {
  for (let i = 0; i < 200; i++) {
    const p = 6000 + Math.floor(Math.random() * 90);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

const PORT = args.port ? Number(args.port) : await freePort();
let server = null;
if (!(await portOpen(PORT))) {
  server = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, OW_NO_HMR: '1' },
  });
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(PORT)) break;
  }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/?capture=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

const rows = [];
for (const shot of SHOTS) {
  await page.evaluate((s) => window.__APPLY_SHOT__(s, { grabFrame: 60 }), shot);
  await page.evaluate(
    () => new Promise((d) => { let i = 0; const t = () => (window.__SETTLED__?.() || ++i > 900 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); })
  );
  // Let the ambient streamer reach its target. It tops up 6 peds every 0.28 s,
  // so a full population takes several seconds of game time to assemble and
  // measuring before that measures the ramp, not the design.
  await pump(420);

  const census = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const peds = e.ctx.peek('peds');
    const cam = e.camera;
    cam.updateMatrixWorld(true);
    const q = cam.quaternion;
    const rot = (v) => {
      const { x, y, z, w } = q;
      const ix = w * v.x + y * v.z - z * v.y;
      const iy = w * v.y + z * v.x - x * v.z;
      const iz = w * v.z + x * v.y - y * v.x;
      const iw = -x * v.x - y * v.y - z * v.z;
      return {
        x: ix * w + iw * -x + iy * -z - iz * -y,
        y: iy * w + iw * -y + iz * -x - ix * -z,
        z: iz * w + iw * -z + ix * -y - iy * -x,
      };
    };
    const F = rot({ x: 0, y: 0, z: -1 });
    const half = Math.tan(((cam.fov * 0.5) * Math.PI) / 180) * cam.aspect;

    const live = peds.live ?? [];
    let inFrame = 0, nearest = Infinity, onWalk = 0, known = 0;
    const pos = [];
    for (const p of live) {
      const dx = p.position.x - cam.position.x;
      const dz = p.position.z - cam.position.z;
      const depth = dx * F.x + dz * F.z;
      const lat = Math.abs(dx * F.z - dz * F.x);
      const d = Math.hypot(dx, dz);
      if (depth > 1 && depth < 90 && lat < depth * half * 1.05) {
        inFrame++;
        if (d < nearest) nearest = d;
      }
      pos.push([p.position.x, p.position.z]);
      let s = null;
      try { s = peds.world?.surfaceAt?.(p.position.x, p.position.z); } catch { s = null; }
      if (s) { known++; if (s === 'sidewalk' || s === 'grass' || s === 'dirt') onWalk++; }
    }
    let spacing = Infinity;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const d = Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1]);
        if (d < spacing) spacing = d;
      }
    }
    return {
      stats: { ...peds.stats },
      live: live.length,
      inFrame,
      nearest: Number.isFinite(nearest) ? nearest : -1,
      spacing: Number.isFinite(spacing) ? spacing : -1,
      sidewalk: known > 0 ? onWalk / known : -1,
      hour: e.ctx.peek('sky')?.timeOfDay ?? null,
    };
  });

  /* ---- 5 SLIDE: track every foot bone in world space, frame by frame ---- */
  await page.evaluate(() => {
    const peds = window.__ENGINE__.ctx.peek('peds');
    window.__FOOT__ = { samples: [], subjects: [] };
    for (const p of peds.live ?? []) {
      if (!p.body || !p.alive) continue;
      if ((p.speed ?? 0) < 0.4) continue;
      window.__FOOT__.subjects.push(p);
      if (window.__FOOT__.subjects.length >= 14) break;
    }
  });
  const slide = await page.evaluate(async () => {
    const F = window.__FOOT__;
    const grab = () => {
      const out = [];
      for (const p of F.subjects) {
        const b = p.body;
        if (!b) { out.push(null); continue; }
        b.group.updateMatrixWorld(true);
        const get = (n) => {
          const bone = b.bones[b.bones.findIndex((x) => x.name === n)];
          bone.updateWorldMatrix(true, false);
          const e = bone.matrixWorld.elements;
          return [e[12], e[13], e[14]];
        };
        // The body reference is the HIPS BONE, not `ped.position`. Both the
        // feet and the hips then live in the same world matrix, so any
        // smoothing or interpolation between the simulated root and the
        // rendered group cancels instead of showing up as fake foot drift.
        const hip = get('Hips');
        const an = p.animator;
        out.push({
          lod: p.lod,
          lockW: (an?._lock?.[0]?.w ?? 0) + (an?._lock?.[1]?.w ?? 0),
          clip: an?.state?.clip ?? '?',
          groundY: p.position.y,
          R: get('ToeR'), L: get('ToeL'),
          AR: get('FootR'), AL: get('FootL'),
          body: [hip[0], p.position.y, hip[2]],
          speed: p.speed ?? 0,
        });
      }
      return out;
    };
    const frames = [];
    for (let i = 0; i < 90; i++) {
      frames.push(grab());
      await new Promise((d) => requestAnimationFrame(d));
    }

    /**
     * A PLANTED STANCE FRAME, defined so it cannot accidentally catch a swing
     * foot: find the contiguous RUNS of frames where a toe is within 5 cm of
     * the ped's own ground height and is the lower of the two feet, then keep
     * only the middle 60% of each run. That throws away heel strike and toe
     * off — where a real foot is genuinely rolling and genuinely moving — and
     * measures only the interval where the sole is flat on the pavement and
     * must not move at all.
     */
    let footDrift = 0, bodyDrift = 0, plantedFrames = 0, worst = 0, used = 0;
    const perPed = [];
    for (let s = 0; s < F.subjects.length; s++) {
      let sFoot = 0, sBody = 0, sN = 0;
      for (const [toe, ank] of [['R', 'AR'], ['L', 'AL']]) {
        const other = toe === 'R' ? 'L' : 'R';
        // PLANTED is measured on the ANKLE, at an absolute height above the
        // ped's own ground, and matches `gaitprobe.mjs`'s definition exactly.
        // The toe leaves the ground well before the heel does — that is what
        // toe-off means — so a toe test straddles the roll and reports the one
        // part of stance where the foot is legitimately moving.
        const ah = toe === 'R' ? 'AR' : 'AL';
        const oh = toe === 'R' ? 'AL' : 'AR';
        const down = frames.map((fr) => {
          const a = fr[s];
          if (!a) return false;
          return a[ah][1] - a.groundY < 0.115 && a[ah][1] <= a[oh][1] + 0.010;
        });
        void other;
        let i = 0;
        while (i < down.length) {
          if (!down[i]) { i++; continue; }
          let j = i;
          while (j < down.length && down[j]) j++;
          const len = j - i;
          if (len >= 5) {
            const lo = i + Math.floor(len * 0.2);
            const hi = j - Math.floor(len * 0.2);
            for (let k = lo + 1; k < hi; k++) {
              const a = frames[k - 1][s], b = frames[k][s];
              if (!a || !b) continue;
              const bd = Math.hypot(b.body[0] - a.body[0], b.body[2] - a.body[2]);
              if (bd < 1e-4) continue;
              sFoot += Math.hypot(b[ank][0] - a[ank][0], b[ank][2] - a[ank][2]);
              sBody += bd;
              sN++;
            }
          }
          i = j;
        }
      }
      if (sN > 6 && sBody > 1e-4) {
        const r = sFoot / sBody;
        perPed.push(+r.toFixed(3));
        worst = Math.max(worst, r);
        footDrift += sFoot; bodyDrift += sBody; plantedFrames += sN;
        used++;
      }
    }
    perPed.sort((a, b) => a - b);
    let lockSum = 0, lockN = 0, walkN = 0;
    for (const fr of frames) for (const a of fr) { if (!a) continue; lockSum += a.lockW; lockN++; if (a.clip === 'walk') walkN++; }
    return {
      lock: lockN ? lockSum / lockN : -1,
      walkFrac: lockN ? walkN / lockN : -1,
      lods: [...new Set(frames[0].filter(Boolean).map((a) => a.lod))],
      mmFoot: plantedFrames ? (footDrift / plantedFrames) * 1000 : 0,
      mmBody: plantedFrames ? (bodyDrift / plantedFrames) * 1000 : 0,
      speed: F.subjects.length ? F.subjects[0].speed : 0,
      subjects: F.subjects.length,
      used,
      plantedFrames,
      ratio: bodyDrift > 1e-6 ? footDrift / bodyDrift : -1,
      median: perPed.length ? perPed[Math.floor(perPed.length / 2)] : -1,
      worst,
      perPed,
    };
  });

  rows.push({ shot, ...census, slide });
}

console.log('shot     hour   live  target  inFrame  nearest  spacing  sidewalk  ms   footSlide (worst)');
for (const r of rows) {
  console.log(
    `${r.shot.padEnd(8)} ${String(r.hour?.toFixed?.(1) ?? '?').padStart(5)}  ` +
      `${String(r.live).padStart(4)}  ${String(r.stats.target ?? '?').padStart(6)}  ` +
      `${String(r.inFrame).padStart(7)}  ${r.nearest.toFixed(1).padStart(7)}  ` +
      `${r.spacing.toFixed(2).padStart(7)}  ${(r.sidewalk * 100).toFixed(0).padStart(7)}%  ` +
      `${r.slide.ratio >= 0 ? r.slide.ratio.toFixed(3) : '  n/a'} (${r.slide.worst.toFixed(3)}) ` +
      `over ${r.slide.plantedFrames} planted frames on ${r.slide.used}/${r.slide.subjects} peds ` +
      `[foot ${r.slide.mmFoot?.toFixed(1)} mm/f vs body ${r.slide.mmBody?.toFixed(1)} mm/f, ` +
      `lock ${r.slide.lock?.toFixed(2)} walk ${(r.slide.walkFrac * 100).toFixed(0)}% lods ${r.slide.lods}]`
  );
}
if (errs.length) console.log(`page errors: ${errs.slice(0, 3).join(' | ')}`);

await browser.close();
if (server) server.kill();

if (args.gate) {
  const bad = [];
  for (const r of rows) {
    const day = (r.hour ?? 12) > 7 && (r.hour ?? 12) < 20;
    if (day && r.inFrame < T.inFrameDay) bad.push(`${r.shot} inFrame ${r.inFrame}`);
    if (day && r.nearest > T.nearestDay) bad.push(`${r.shot} nearest ${r.nearest.toFixed(1)} m`);
    if (r.spacing >= 0 && r.spacing < T.spacing) bad.push(`${r.shot} spacing ${r.spacing.toFixed(2)} m`);
    // A staged firefight puts people in the road on purpose.
    if (r.shot !== 'combat' && r.live > 12 && r.sidewalk >= 0 && r.sidewalk < T.sidewalk) {
      bad.push(`${r.shot} sidewalk ${(r.sidewalk * 100).toFixed(0)}%`);
    }
    if (r.slide.ratio > T.slide) bad.push(`${r.shot} footSlide ${r.slide.ratio.toFixed(3)}`);
  }
  console.log(bad.length ? `\nFAIL: ${bad.join(', ')}` : '\nPASS');
  process.exit(bad.length ? 1 : 0);
}
