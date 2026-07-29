#!/usr/bin/env node
/**
 * STUCK-CAR DIAGNOSTIC (dev tool, not shipped).
 *
 * Reproduces `tools/playprobe.mjs`'s driving sequence EXACTLY — including the
 * walk / sprint / jump that moves the player before the car is spawned, because
 * that is what makes the spawn spot vary run to run — and then dumps everything
 * about the vehicle the player actually ended up in: which car it is, what is
 * under its wheels, what the drivetrain is doing, and whether anything is
 * touching it.
 *
 * This is what turned "the car does not move, about half the time" into
 * something reproducible. `playprobe` reports one line; this reports the frozen
 * state, and the state it caught was unambiguous — full reverse throttle, four
 * wheels down on dirt, engine on the limiter, front wheels at -49.5 rad/s with
 * a slip ratio of -7.5, forward speed -0.007 m/s. A burnout, not a collision.
 * `src/vehicles/drivetest.mjs` is the deterministic gate that came out of it;
 * this stays because the failure only appears through the PLAYER path (the car
 * has to be driven off the road first) and no headless bench can find that.
 *
 *   node src/vehicles/stuckdiag.mjs            # one run
 *   node src/vehicles/stuckdiag.mjs --runs=6   # six, reporting the pass rate
 */
import { chromium } from 'playwright';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const RUNS = Number(args.runs ?? 1);

const { port, server } = await startServer({ explicitPort: args.port });
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});

/** Everything worth knowing about the player's car, in one page evaluate. */
const DUMP = () => {
  const e = window.__ENGINE__;
  const pl = e.ctx.peek('player');
  const veh = e.ctx.peek('vehicles');
  const w = e.ctx.peek('world');
  const v = pl?.vehicle ?? pl?.currentVehicle ?? null;
  const p = pl?.position;
  const r3 = (n) => (typeof n === 'number' ? +n.toFixed(3) : n);
  const out = {
    playerPos: p ? [r3(p.x), r3(p.y), r3(p.z)] : null,
    inVehicle: !!v,
    fleet: veh?.vehicles?.length ?? null,
  };
  if (!v) return out;
  const dt = v.drivetrain;
  out.veh = {
    type: v.type,
    id: v.id,
    probeCar: !!v._probeCar,
    parked: !!v.parked,
    staged: !!v._staged,
    sleeping: !!v.sleeping,
    sleepTimer: r3(v._sleepTimer),
    pos: [r3(v.position.x), r3(v.position.y), r3(v.position.z)],
    vel: [r3(v.velocity.x), r3(v.velocity.y), r3(v.velocity.z)],
    angVel: [r3(v.angularVelocity.x), r3(v.angularVelocity.y), r3(v.angularVelocity.z)],
    fwdSpeed: r3(v.forwardSpeed),
    speed: r3(v.speed),
    // Orientation: `upDotY` is 1 upright, 0 on its side, -1 on its roof.
    upDotY: r3(1 - 2 * (v.quaternion.x * v.quaternion.x + v.quaternion.z * v.quaternion.z)),
    tiltDeg: r3((Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (v.quaternion.x * v.quaternion.x + v.quaternion.z * v.quaternion.z)))) * 180) / Math.PI),
    grounded: v.grounded,
    airborne: r3(v.airborne),
    mass: v.mass,
    invMass: r3(v.invMass),
    engineOn: v.engineOn,
    fuel: r3(v.fuel),
    fuelDry: v.fuelDry,
    destroyed: v.destroyed,
    health: r3(v.health),
    driver: v.driver ? (v.driver === pl ? 'player' : 'other') : null,
    lod: v.lod,
    input: { ...v.input },
    control: { ...v.control },
    autoReverse: v.autoReverse,
    traction: r3(v.traction),
    steerAngle: r3(v.steerAngle),
    dt: {
      gear: dt.gear, label: dt.gearLabel, rpm: r3(dt.rpm), omega: r3(dt.omega),
      clutch: r3(dt.clutch), locked: dt.locked, driveTorque: r3(dt.driveTorque),
      clutchTorque: r3(dt.clutchTorque), reflectedInertia: r3(dt.reflectedInertia),
      reversing: dt.reversing, shiftTimer: r3(dt.shiftTimer), revHold: r3(dt._revHold),
      revIdle: r3(dt._revIdle), ignition: dt.ignition, stalled: dt.stalled,
    },
    diag: { ...v.diag },
    wheels: v.wheels.map((wh) => ({
      g: wh.grounded, len: r3(wh.len), min: r3(wh.hp.min), max: r3(wh.hp.max),
      rest: r3(wh.hp.rest), load: r3(wh.load), omega: r3(wh.omega),
      fx: r3(wh.fx), fy: r3(wh.fy), slipR: r3(wh.slipRatio), slipA: r3(wh.slipAngle),
      comb: r3(wh.combined), mu: r3(wh.mu), surf: wh.surface, broken: wh.broken,
      contactY: r3(wh.contact.y), braked: r3(wh.hp.braked), handbrake: r3(wh.hp.handbrake),
    })),
  };
  if (w?.walkableHeightAt) out.veh.walkableY = r3(w.walkableHeightAt(v.position.x, v.position.z));
  if (w?.heightAt) out.veh.terrainY = r3(w.heightAt(v.position.x, v.position.z));
  if (w?.surfaceAt) out.veh.surface = w.surfaceAt(v.position.x, v.position.z);
  // Neighbours that could be holding it.
  out.veh.neighbours = (veh?.vehicles ?? [])
    .filter((o) => o !== v && o.position.distanceTo(v.position) < 12)
    .map((o) => ({ type: o.type, d: r3(o.position.distanceTo(v.position)), sleeping: !!o.sleeping }));
  return out;
};

/** Everything within reach of the player, ranked the way `_scan` ranks it. */
const NEARBY = () => {
  const e = window.__ENGINE__;
  const pl = e.ctx.peek('player');
  const veh = e.ctx.peek('vehicles');
  const p = pl.position;
  const list = [];
  for (const v of veh.vehicles) {
    const dx = v.position.x - p.x, dz = v.position.z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 196) continue;
    const half = v.spec.half;
    const q = v.quaternion.clone().invert();
    const l = v.position.clone().sub(p).multiplyScalar(-1).applyQuaternion(q);
    const bd = Math.hypot(
      Math.max(0, Math.abs(l.x) - half.x),
      Math.max(0, Math.abs(l.y) - half.y) * 0.5,
      Math.max(0, Math.abs(l.z) - half.z)
    );
    const up = 1 - 2 * (v.quaternion.x * v.quaternion.x + v.quaternion.z * v.quaternion.z);
    list.push({
      type: v.type, probe: !!v._probeCar, parked: !!v.parked,
      origin: +Math.sqrt(d2).toFixed(2), box: +bd.toFixed(2),
      dy: +(v.position.y - p.y).toFixed(2), up: +up.toFixed(3),
      grounded: v.grounded, sleeping: !!v.sleeping,
    });
  }
  list.sort((a, c) => a.box - c.box);
  return list;
};

let pass = 0;
for (let run = 1; run <= RUNS; run++) {
  const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  const pump = (n) =>
    page.evaluate((k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }), n);
  const hold = async (code, frames) => { await page.keyboard.down(code); await pump(frames); await page.keyboard.up(code); await pump(4); };

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
    await pump(120);
    await page.evaluate(() => {
      const e = window.__ENGINE__;
      e.input.enabled = true; e.input.frozen = false;
      e.ctx.peek('player')?.setControlEnabled?.(true);
    });
    await pump(30);

    // Same pre-amble as playprobe: it is what moves the player around.
    await hold('KeyW', 60);
    await page.keyboard.down('ShiftLeft');
    await hold('KeyW', 60);
    await page.keyboard.up('ShiftLeft');
    await page.keyboard.down('Space'); await pump(4); await page.keyboard.up('Space');
    await pump(88);

    const spawned = await page.evaluate(() => {
      const e = window.__ENGINE__;
      const pl = e.ctx.peek('player');
      const veh = e.ctx.peek('vehicles');
      const w = e.ctx.peek('world');
      const p = pl.position;
      let spot = null, yaw = 0;
      const roads = w?.roads;
      if (roads?.nearestEdge && roads.laneCenter) {
        const hit = roads.nearestEdge(p.x, p.z, 300);
        if (hit?.edge != null) {
          const V = Object.getPrototypeOf(p).constructor;
          const id = hit.edge.id ?? hit.edge, lane = hit.lane ?? 0;
          const t0 = Math.min(0.88, (hit.t ?? 0.5) + 0.02);
          const a = new V(), bA = new V();
          roads.laneCenter(id, lane, t0, a);
          roads.laneCenter(id, lane, Math.min(0.96, t0 + 0.06), bA);
          const dx = bA.x - a.x, dz = bA.z - a.z;
          if (Math.hypot(dx, dz) > 0.05) yaw = Math.atan2(dx, dz);
          if (Number.isFinite(a.x)) spot = a;
        }
      }
      if (!spot) return null;
      const car = veh?.spawn?.('sedan', { x: spot.x, y: spot.y + 0.6, z: spot.z }, yaw, {});
      if (!car) return null;
      car._probeCar = true;
      pl.teleport?.({ x: spot.x + Math.cos(yaw) * 2.4, y: spot.y + 1.0, z: spot.z - Math.sin(yaw) * 2.4 }, { x: 0, y: 0, z: 0 });
      return { id: car.id, spot: [+spot.x.toFixed(2), +spot.y.toFixed(2), +spot.z.toFixed(2)], yaw: +((yaw * 180) / Math.PI).toFixed(1) };
    });
    await pump(40);
    const near = await page.evaluate(NEARBY);

    await hold('KeyF', 10);
    await pump(150);

    // ---- W, exactly as playprobe holds it -------------------------------
    await page.keyboard.down('KeyW');
    let drive = null;
    for (let f = 0; f < 400; f += 20) {
      await pump(20);
      drive = await page.evaluate(DUMP);
      if ((drive.veh?.fwdSpeed ?? 0) > 8) break;
    }
    await page.keyboard.up('KeyW');
    await pump(4);
    const droveOk = (drive?.veh?.fwdSpeed ?? -99) > 1.5;

    // ---- S, through the stop and into reverse ---------------------------
    await page.keyboard.down('KeyS');
    const trail = [];
    let brake = null;
    for (let f = 0; f < 900; f += 20) {
      await pump(20);
      brake = await page.evaluate(DUMP);
      const b = brake.veh;
      if (b) trail.push(`${f + 20}:fwd=${b.fwdSpeed} g=${b.dt.label} rev=${b.dt.reversing ? 1 : 0} thr=${b.control.throttle?.toFixed?.(2)} brk=${b.control.brake?.toFixed?.(2)} rawT=${b.input.throttle?.toFixed?.(2)} rawB=${b.input.brake?.toFixed?.(2)} hold=${b.dt.revHold} idle=${b.dt.revIdle} gnd=${b.grounded} rpm=${b.dt.rpm}`);
      if ((brake.veh?.fwdSpeed ?? 99) < -0.5) break;
    }
    await page.keyboard.up('KeyS');
    await pump(4);
    const revOk = (brake?.veh?.fwdSpeed ?? 99) < -0.5;

    const ok = droveOk && revOk;
    if (ok) pass++;
    console.log(`\n================ run ${run} : ${ok ? 'PASS' : 'FAIL'}  (drive ${droveOk ? 'ok' : 'STUCK'}, reverse ${revOk ? 'ok' : 'STUCK'}) ===========`);
    console.log('spawned  ', JSON.stringify(spawned));
    console.log('nearby   ', JSON.stringify(near.slice(0, 5)));
    console.log('after W  ', JSON.stringify(drive, null, 1));
    if (!ok) {
      console.log('after S  ', JSON.stringify(brake, null, 1));
      console.log('S trail  \n  ' + trail.slice(-14).join('\n  '));
    }
    if (errs.length) console.log('errors   ', [...new Set(errs)].slice(0, 4).join(' | '));
  } catch (err) {
    console.log(`\nrun ${run} threw: ${err.message}`);
  } finally {
    await page.close();
  }
}
console.log(`\n${pass}/${RUNS} runs drove forward`);
await b.close();
stopServer(server);
