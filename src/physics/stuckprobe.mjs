#!/usr/bin/env node
/**
 * STUCK-CAR PROBE — why does a car at full throttle not move?
 *
 *   node src/physics/stuckprobe.mjs
 *   node src/physics/stuckprobe.mjs --at=-156,127 --at=-102,188
 *   node src/physics/stuckprobe.mjs --lane=8          # the playprobe drive test
 *   node src/physics/stuckprobe.mjs --lane=8 --flat   # ...on the pre-fix BVH
 *
 * `--lane` reproduces what `tools/playprobe.mjs` does — spawn a sedan on a lane
 * centre, ALIGNED down the lane, pin the throttle, and see whether it reaches a
 * sane speed — and repeats it N times from different places, because the
 * failure it is chasing is intermittent. Every trial that does not move is
 * dissected the same way as a fixed site: what, if anything, is the chassis
 * inside. Paired with `--flat` this says whether a stuck car is the collision
 * structure or something else.
 *
 * `traffic` reproduced this at x=-156,z=127 · x=-102,z=188 · x=-172,z=-11:
 * `throttle 0.89`, four wheels grounded on asphalt, `slip 0.1`, nothing in the
 * forward probe, `forwardSpeed 0.01`. Low slip with high throttle and no
 * motion means the drivetrain is NOT spinning the tyres — something is holding
 * the body. The two candidates sit on opposite sides of the fence:
 *
 *   drivetrain (`vehicles`)  torque never reaches the wheels
 *   contacts   (`physics`)   the chassis is intersecting a collider, and the
 *                            penetration push + Coulomb friction in
 *                            `dynamics._collide` cancel the drive every step
 *
 * They are distinguishable from the outside: `dynamics.diag` already counts
 * chassis contacts per step, and physics can be asked directly what the
 * chassis probes are touching and what it is called. This spawns a car at each
 * site, pins the throttle, and prints both.
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = [];
const opts = {};
for (const a of process.argv.slice(2)) {
  const [k, v] = a.replace(/^--/, '').split('=');
  if (k === 'at') args.push(v.split(',').map(Number));
  else opts[k] = v ?? true;
}
// The two sites `vehicles` could not explain from the drivetrain side, plus
// the three original ones as controls now that the gearbox fix has landed.
const SITES = args.length ? args : [[-201, 50], [-97, 56], [-156, 127], [-102, 188], [-172, -11]];
/** A control site: the middle of the road nearest the spawn, which works. */

const { port, server } = await startServer({ explicitPort: opts.port });
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

try {
  // `--flat` boots the pre-fix single-tree BVH (src/physics/bvh.js) so a stuck
  // site can be paired against the collision structure it was first seen in.
  await page.goto(`http://127.0.0.1:${port}/${opts.flat ? '?owbvh=flat' : ''}`,
    { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await pump(120);

  const results = [];
  for (const [x, z] of SITES) {
    // Keep the camera on top of the site: collision, LOD and the traffic
    // budget are all camera-relative, and a car tested from 800 m away is not
    // the car `traffic` was complaining about.
    await page.evaluate(([px, pz]) => {
      const e = window.__ENGINE__;
      e.ctx.peek('player')?.teleport?.({ x: px, y: (e.ctx.peek('world')?.walkableHeightAt?.(px, pz) ?? 0) + 1.6, z: pz }, 0);
    }, [x, z]);
    await pump(90);

    const r = await page.evaluate(
      ([px, pz]) => {
        const e = window.__ENGINE__;
        const veh = e.ctx.peek('vehicles');
        const phys = e.ctx.peek('physics');
        const world = e.ctx.peek('world');
        if (!veh || !phys) return { error: 'no vehicles/physics' };
        const y = (world.walkableHeightAt?.(px, pz) ?? world.heightAt(px, pz)) + 0.9;
        const v = veh.spawn('sedan', { x: px, y, z: pz }, 0);
        if (!v) return { error: 'spawn failed' };
        v.aiControlled = false;
        window.__V__ = v;
        return { id: 0, y };
      },
      [x, z]
    );
    if (r.error) { results.push({ x, z, error: r.error }); continue; }

    // Settle on the suspension, then pin the throttle for two seconds.
    await pump(60);
    await page.evaluate(() => {
      const veh = window.__ENGINE__.ctx.peek('vehicles');
      const v = window.__V__;
      v.aiControlled = false;
      window.__STUCK__ = () => { veh.setInput(v, { throttle: 0.89, steer: 0, brake: 0 }); };
      window.__STUCKI__ = setInterval(window.__STUCK__, 4);
    });
    await pump(150);

    const out = await page.evaluate(
      () => {
        clearInterval(window.__STUCKI__);
        const e = window.__ENGINE__;
        const veh = e.ctx.peek('vehicles');
        const phys = e.ctx.peek('physics');
        const v = window.__V__;
        const d = v.dynamics ?? v;
        const q = d.quaternion;
        const fwd = { x: 0, y: 0, z: 1 };
        // rotate (0,0,1) by q
        const rot = (p) => {
          const { x, y, z, w } = q;
          const ix = w * p.x + y * p.z - z * p.y;
          const iy = w * p.y + z * p.x - x * p.z;
          const iz = w * p.z + x * p.y - y * p.x;
          const iw = -x * p.x - y * p.y - z * p.z;
          return {
            x: ix * w + iw * -x + iy * -z - iz * -y,
            y: iy * w + iw * -y + iz * -x - ix * -z,
            z: iz * w + iw * -z + ix * -y - iy * -x,
          };
        };
        const f = rot(fwd);

        // Ask physics directly what each chassis probe is inside.
        const cts = phys.staticWorld.contacts;
        const touching = [];
        for (let p = 0; p < d.probes.length; p++) {
          const lp = d.probes[p];
          const wp = rot({ x: lp.x, y: lp.y, z: lp.z });
          const px2 = d.position.x + wp.x, py2 = d.position.y + wp.y, pz2 = d.position.z + wp.z;
          const n = phys.staticWorld.overlapCapsule(
            px2, py2, pz2, px2, py2, pz2, d.probeR, phys.MASK.WORLD, 0
          );
          if (!n) continue;
          let best = -1, bd = 0;
          for (let c = 0; c < n; c++) if (cts.depth[c] > bd) { bd = cts.depth[c]; best = c; }
          if (best < 0) continue;
          touching.push({
            probe: p,
            local: [+lp.x.toFixed(2), +lp.y.toFixed(2), +lp.z.toFixed(2)],
            contacts: n,
            depth: +bd.toFixed(3),
            normal: [+cts.nx[best].toFixed(2), +cts.ny[best].toFixed(2), +cts.nz[best].toFixed(2)],
            object: phys.staticWorld.objectOf?.(cts.tri[best])?.name
              ?? phys.staticWorld.objects[phys.staticWorld.object[cts.tri[best]]]?.name ?? '?',
            surface: phys.SURFACE_NAMES[phys.staticWorld.surfaceOf(cts.tri[best])],
            // Where is the thing the capsule is stuck on, relative to the running
            // lane? "a metal prop" is not actionable; "a metal prop 1.2 m
            // inside the carriageway" is.
            lane: (() => {
              const w = e.ctx.peek('world');
              const ne = w?.roads?.nearestEdge?.(cts.px[best], cts.pz[best], 60);
              if (!ne?.edge) return null;
              return {
                dist: +ne.dist.toFixed(2),
                kind: ne.edge.kind,
                lanes: ne.edge.lanes,
                halfWidth: +((ne.edge.lanes ?? 2) * 1.75).toFixed(2),
              };
            })(),
          });
        }

        const wheels = d.wheels.map((w) => ({
          grounded: w.grounded,
          surface: w.surface,
          len: +w.len.toFixed(3),
          max: +w.hp.max.toFixed(3),
          load: +(w.load ?? 0).toFixed(0),
          slip: +(w.slipRatio ?? w.slip ?? 0).toFixed(3),
        }));

        const res = {
          pos: [+d.position.x.toFixed(2), +d.position.y.toFixed(2), +d.position.z.toFixed(2)],
          speed: +(d.speed ?? 0).toFixed(3),
          forwardSpeed: +(d.velocity.x * f.x + d.velocity.z * f.z).toFixed(3),
          throttle: +(d.input.throttle ?? 0).toFixed(2),
          rpm: Math.round(d.rpm ?? 0),
          gear: d.gear,
          grounded: d.grounded,
          diagContacts: d.diag?.contacts ?? null,
          diagPushY: +(d.diag?.pushY ?? 0).toFixed(4),
          diagRayObj: d.diag?.rayObj ?? null,
          diagRaySurface: d.diag?.raySurface ?? null,
          diagGroundY: d.diag?.groundY != null ? +d.diag.groundY.toFixed(2) : null,
          wheels,
          touching,
          probeR: +d.probeR.toFixed(3),
          probeCount: d.probes.length,
        };
        if (veh.despawn) veh.despawn(v); else veh.remove?.(v);
        window.__V__ = null;
        return res;
      }
    );
    results.push({ x, z, ...out });
  }

  const bar = '─'.repeat(70);
  console.log(bar);
  console.log('STUCK-CAR PROBE — full throttle for 2.5 s at each site');
  console.log(bar);
  for (const s of results) {
    console.log(`\n(${s.x}, ${s.z})`);
    if (s.error) { console.log(`  ERROR ${s.error}`); continue; }
    console.log(`  moved to ${s.pos}  speed ${s.speed} m/s  forward ${s.forwardSpeed} m/s`);
    console.log(`  throttle ${s.throttle}  rpm ${s.rpm}  gear ${s.gear}  wheels grounded ${s.grounded}`);
    console.log(`  ground under it: ${s.diagRayObj ?? 'null (analytic)'} · ${s.diagRaySurface} · y=${s.diagGroundY}`);
    console.log(`  CHASSIS contacts this step: ${s.diagContacts}   positional pushY ${s.diagPushY}`);
    if (s.touching.length === 0) {
      console.log('  chassis probes are touching NOTHING — not a contact problem');
    } else {
      for (const t of s.touching) {
        console.log(
          `    probe ${t.probe} at ${t.local}: ${t.contacts} contacts, deepest ${t.depth} m, ` +
          `n=${t.normal}, "${t.object}" (${t.surface})` +
          (t.lane ? `  — ${t.lane.dist} m from the centre of a ${t.lane.lanes}-lane ${t.lane.kind}` +
            ` (carriageway half-width ~${t.lane.halfWidth} m)` : '')
        );
      }
    }
    console.log(`  wheels: ${s.wheels.map((w) => `${w.grounded ? 'G' : '-'}${w.surface}/${w.len}of${w.max}`).join('  ')}`);
  }
  console.log(`\n${bar}`);
  const stuck = results.filter((s) => !s.error && Math.abs(s.forwardSpeed) < 0.5);
  const contactBound = stuck.filter((s) => s.touching.length > 0);
  console.log(
    `${stuck.length}/${results.length} sites did not move. ` +
    `${contactBound.length} of those have the chassis inside a collider ` +
    `(=> physics), ${stuck.length - contactBound.length} do not (=> drivetrain).`
  );
  if (errs.length) console.log(`page errors: ${errs.slice(0, 3).join(' | ')}`);

  /* ---------------------------------------------------------------- */
  /* LANE DRIVE — `tools/playprobe.mjs`'s test, repeated                */
  /* ---------------------------------------------------------------- */
  let laneFail = 0;
  const TRIALS = Number(opts.lane === true ? 6 : (opts.lane ?? 0));
  if (TRIALS > 0) {
    console.log(`\n${bar}`);
    console.log(`LANE DRIVE — sedan on an aligned lane centre, full throttle, ${TRIALS} trials`);
    console.log(bar);
    const trials = [];
    for (let k = 0; k < TRIALS; k++) {
      // Move the player somewhere new each trial to sample different
      // streaming states — the failure being chased is intermittent.
      await page.evaluate((seed) => {
        const e = window.__ENGINE__;
        const w = e.ctx.peek('world');
        const a = seed * 1.7;
        const x = Math.cos(a) * (120 + seed * 60);
        const z = Math.sin(a) * (120 + seed * 60);
        const hit = w.roads.nearestEdge(x, z, 600);
        const p = { x, z };
        if (hit?.edge != null) {
          const V = Object.getPrototypeOf(e.ctx.camera.position).constructor;
          const c = new V();
          w.roads.laneCenter(hit.edge.id ?? hit.edge, hit.lane ?? 0, hit.t ?? 0.5, c);
          p.x = c.x; p.z = c.z;
        }
        e.ctx.peek('player')?.teleport?.(
          { x: p.x, y: (w.walkableHeightAt?.(p.x, p.z) ?? 0) + 1.6, z: p.z }, 0
        );
      }, k);
      await pump(120);

      const t = await page.evaluate(() => {
        const e = window.__ENGINE__;
        const pl = e.ctx.peek('player');
        const veh = e.ctx.peek('vehicles');
        const w = e.ctx.peek('world');
        const p = pl.position;
        const hit = w.roads.nearestEdge(p.x, p.z, 300);
        if (!hit?.edge) return { error: 'no lane' };
        const V = Object.getPrototypeOf(p).constructor;
        const id = hit.edge.id ?? hit.edge, lane = hit.lane ?? 0;
        const t0 = Math.min(0.88, (hit.t ?? 0.5) + 0.02);
        const a = new V(), ahead = new V();
        w.roads.laneCenter(id, lane, t0, a);
        w.roads.laneCenter(id, lane, Math.min(0.96, t0 + 0.06), ahead);
        const dx = ahead.x - a.x, dz = ahead.z - a.z;
        const yaw = Math.hypot(dx, dz) > 0.05 ? Math.atan2(dx, dz) : 0;
        const v = veh.spawn('sedan', { x: a.x, y: a.y + 0.6, z: a.z }, yaw, {});
        if (!v) return { error: 'spawn failed' };
        v.aiControlled = false;
        window.__V__ = v;
        window.__V0__ = [a.x, a.z];
        return { at: [+a.x.toFixed(1), +a.z.toFixed(1)], yaw: +((yaw * 180) / Math.PI).toFixed(0), kind: hit.edge.kind };
      });
      if (t.error) { trials.push({ ...t }); continue; }

      await pump(50);
      await page.evaluate(() => {
        const veh = window.__ENGINE__.ctx.peek('vehicles');
        const v = window.__V__;
        v.aiControlled = false;
        window.__STUCKI__ = setInterval(() => veh.setInput(v, { throttle: 1, steer: 0, brake: 0 }), 4);
      });
      await pump(240);

      const out = await page.evaluate(() => {
        clearInterval(window.__STUCKI__);
        const e = window.__ENGINE__;
        const veh = e.ctx.peek('vehicles');
        const phys = e.ctx.peek('physics');
        const v = window.__V__;
        const d = v.dynamics ?? v;
        const q = d.quaternion;
        const rot = (p) => {
          const { x, y, z, w } = q;
          const ix = w * p.x + y * p.z - z * p.y;
          const iy = w * p.y + z * p.x - x * p.z;
          const iz = w * p.z + x * p.y - y * p.x;
          const iw = -x * p.x - y * p.y - z * p.z;
          return {
            x: ix * w + iw * -x + iy * -z - iz * -y,
            y: iy * w + iw * -y + iz * -x - ix * -z,
            z: iz * w + iw * -z + ix * -y - iy * -x,
          };
        };
        const f = rot({ x: 0, y: 0, z: 1 });
        const cts = phys.staticWorld.contacts;
        const touching = [];
        for (let p = 0; p < d.probes.length; p++) {
          const lp = d.probes[p];
          const wp = rot({ x: lp.x, y: lp.y, z: lp.z });
          const px2 = d.position.x + wp.x, py2 = d.position.y + wp.y, pz2 = d.position.z + wp.z;
          const n = phys.staticWorld.overlapCapsule(px2, py2, pz2, px2, py2, pz2, d.probeR, phys.MASK.WORLD, 0);
          if (!n) continue;
          let best = -1, bd = 0;
          for (let c = 0; c < n; c++) if (cts.depth[c] > bd) { bd = cts.depth[c]; best = c; }
          if (best < 0) continue;
          touching.push({
            probe: p,
            depth: +bd.toFixed(3),
            object: phys.staticWorld.objectOf?.(cts.tri[best])?.name ?? '?',
            surface: phys.SURFACE_NAMES[phys.staticWorld.surfaceOf(cts.tri[best])],
          });
        }
        const res = {
          forwardSpeed: +(d.velocity.x * f.x + d.velocity.z * f.z).toFixed(3),
          travelled: +Math.hypot(d.position.x - window.__V0__[0], d.position.z - window.__V0__[1]).toFixed(2),
          throttle: +(d.input.throttle ?? 0).toFixed(2),
          rpm: Math.round(d.rpm ?? 0),
          gear: d.gear,
          grounded: d.grounded,
          wheelsDown: d.wheels.filter((w) => w.grounded).length,
          contacts: d.diag?.contacts ?? null,
          touching,
          // Was the collision tree mid-flight while this car was being driven?
          bvh: {
            dirty: phys.staticWorld.dirty,
            deferred: phys.staticWorld.deferred,
            builds: phys.staticWorld.buildStats.builds,
            flat: phys.staticWorld.flat,
          },
        };
        if (veh.despawn) veh.despawn(v); else veh.remove?.(v);
        window.__V__ = null;
        return res;
      });
      trials.push({ ...t, ...out });
    }

    for (const t of trials) {
      if (t.error) { console.log(`  ERROR ${t.error}`); continue; }
      const bad = t.forwardSpeed < 1.5;
      if (bad) laneFail++;
      console.log(
        `  ${bad ? 'STUCK' : ' ok  '}  at ${t.at} yaw ${t.yaw} (${t.kind})  ` +
        `fwd ${String(t.forwardSpeed).padStart(7)} m/s  travelled ${String(t.travelled).padStart(6)} m  ` +
        `rpm ${String(t.rpm).padStart(4)} gear ${t.gear} wheels ${t.wheelsDown}/4  ` +
        `chassis contacts ${t.contacts}  bvh ${t.bvh.flat ? 'flat' : 'two-level'} dirty=${t.bvh.dirty} deferred=${t.bvh.deferred}`
      );
      if (t.touching.length) {
        for (const c of t.touching) {
          console.log(`         probe ${c.probe} inside "${c.object}" (${c.surface}) by ${c.depth} m`);
        }
      }
    }
    console.log(
      `\n  ${trials.length - laneFail}/${trials.length} lane trials drove away ` +
      `(${laneFail} stuck, ${trials.filter((t) => !t.error && t.forwardSpeed < 1.5 && t.touching.length).length} of those with the chassis inside a collider)`
    );
  }

  process.exitCode = stuck.length || laneFail ? 1 : 0;
} catch (e) {
  console.error('stuckprobe failed:', e.message);
  if (errs.length) console.error(errs.slice(0, 6).join('\n'));
  process.exitCode = 2;
} finally {
  await b.close();
  server?.kill();
}
