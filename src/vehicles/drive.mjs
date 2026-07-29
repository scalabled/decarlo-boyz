#!/usr/bin/env node
/**
 * Driving harness (dev tool, not shipped).
 *
 * Boots the real game, spawns each class on a real road, scripts throttle /
 * brake / steer / handbrake inputs and logs telemetry every frame. This is how
 * the FEEL gets verified rather than asserted:
 *
 *   accel   0-100 km/h, and the REAR suspension compressing while the FRONT
 *           extends — that is weight transfer, and it is what makes the body
 *           squat under power.
 *   brake   stopping distance from 100 km/h, and the mirror image: front
 *           compresses, rear extends (dive).
 *   corner  steady-state lateral: outside wheels loaded, inside unloaded, body
 *           rolled. If the roll angle is zero the car is a hovercraft.
 *   drift   handbrake at speed: the slip angle has to go up and then COME BACK,
 *           or the car is not recoverable.
 *
 *   node src/vehicles/drive.mjs                 # all eight classes
 *   node src/vehicles/drive.mjs --type=sports --verbose
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

const PORT = Number(args.port ?? 5401);
const ROOT = resolve(import.meta.dirname, '../..');
const TYPES = args.type ? String(args.type).split(',') : null;

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let server = null;
if (!(await portOpen(PORT))) {
  server = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, OW_NO_HMR: '1' },
  });
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await portOpen(PORT);
  }
  if (!up) { server.kill(); throw new Error('vite failed to start'); }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

await page.goto(`http://127.0.0.1:${PORT}/?q=low`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });

/* ------------------------------------------------------------------ */

const result = await page.evaluate(async (typesArg) => {
  const E = window.__ENGINE__;
  const V = E.ctx.peek('vehicles');
  const W = E.ctx.peek('world');
  const P = E.ctx.peek('physics');
  E.input.frozen = true;
  E.input.enabled = false;
  E.ctx.peek('player')?.setControlEnabled?.(false);
  E.ctx.peek('traffic') && (E.ctx.peek('traffic').enabled = false);

  const THREE = E.scene.constructor === undefined ? null : null;
  const types = typesArg ?? V.classes;

  const frame0 = () => new Promise((r) => requestAnimationFrame(r));

  /**
   * The test site has to be where the world has actually STREAMED, or physics
   * has no triangles there and the car free-falls at 217 km/h while reporting a
   * beautiful 0-100 time. Pick the longest road near the player, park the
   * camera on it, and let the tiles build before spawning anything.
   */
  async function findRoad() {
    const player = E.ctx.peek('player');
    const pp = player?.position ?? player?.capsule?.position ?? E.camera.position;
    const px = pp.x, pz = pp.z;
    const roads = W?.roads;
    let best = null;
    let bestScore = -Infinity;
    if (roads?.edges?.length && roads?.nodes?.length) {
      const nodeById = new Map();
      for (const n of roads.nodes) nodeById.set(n.id ?? roads.nodes.indexOf(n), n);
      for (const e of roads.edges) {
        const a = roads.nodes[e.a] ?? nodeById.get(e.a);
        const b = roads.nodes[e.b] ?? nodeById.get(e.b);
        if (!a || !b) continue;
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        const d = Math.hypot(mx - px, mz - pz);
        if (d > 260) continue;                       // must be inside the stream radius
        const score = len - d * 0.35 + (e.kind === 'highway' ? 40 : e.kind === 'arterial' ? 20 : 0);
        if (score > bestScore) { bestScore = score; best = { a, b, len, edge: e.id }; }
      }
    }
    if (!best) return { x: px, z: pz, yaw: 0, len: 0, streamed: false };

    /**
     * A single edge is 60-100 m; 0-100 km/h needs 150 m and the car simply
     * drove off the end into a kerb. Walk the graph from the seed edge in both
     * directions, following whichever neighbour continues straightest, and
     * stop when the bend exceeds 12 degrees. That turns a chain of edges back
     * into the straight road a human would have picked.
     */
    function nodeAt(id) { return roads.nodes[id] ?? nodeById.get(id); }
    function extend(fromId, toId, dirx, dirz) {
      let total = 0;
      let cur = toId;
      let prev = fromId;
      for (let hop = 0; hop < 40; hop++) {
        const cn = nodeAt(cur);
        if (!cn?.links) break;
        let pick = null;
        let pickDot = 0.978; // cos 12 deg
        for (const eid of cn.links) {
          const e = roads.edges[eid] ?? roads.edges.find?.((x) => x.id === eid);
          if (!e) continue;
          const other = e.a === cur ? e.b : e.a;
          if (other === prev) continue;
          const on = nodeAt(other);
          if (!on) continue;
          const dx = on.x - cn.x, dz = on.z - cn.z;
          const l = Math.hypot(dx, dz) || 1;
          const dot = (dx / l) * dirx + (dz / l) * dirz;
          if (dot > pickDot) { pickDot = dot; pick = { other, on, l, dx: dx / l, dz: dz / l }; }
        }
        if (!pick) break;
        total += pick.l;
        prev = cur;
        cur = pick.other;
        dirx = pick.dx;
        dirz = pick.dz;
      }
      return { total, endId: cur };
    }

    const dx0 = (best.b.x - best.a.x) / best.len;
    const dz0 = (best.b.z - best.a.z) / best.len;
    const fwd = extend(best.a.id ?? roads.nodes.indexOf(best.a), best.b.id ?? roads.nodes.indexOf(best.b), dx0, dz0);
    const back = extend(best.b.id ?? roads.nodes.indexOf(best.b), best.a.id ?? roads.nodes.indexOf(best.a), -dx0, -dz0);
    const startN = nodeAt(back.endId) ?? best.a;
    const runLen = best.len + fwd.total + back.total;
    const yaw = Math.atan2(dx0, dz0);
    // Start 8 m in from the far end so there is room behind for the brake test.
    const site = {
      x: startN.x + dx0 * 8,
      z: startN.z + dz0 * 8,
      yaw,
      len: runLen,
      edge: best.edge ?? null,
    };
    // Walk the camera down the run so every tile along it streams and its
    // collision reaches the BVH before anything is timed.
    const steps = 6;
    for (let s2 = 0; s2 <= steps; s2++) {
      const f = s2 / steps;
      const cx = site.x + Math.sin(yaw) * runLen * f * 0.9;
      const cz = site.z + Math.cos(yaw) * runLen * f * 0.9;
      const cy = (W?.heightAt?.(cx, cz) ?? 0) + 14;
      E.camera.position.set(cx, cy, cz);
      E.camera.updateMatrixWorld(true);
      player?.teleport?.({ x: cx, y: cy - 12, z: cz }, E.camera.rotation);
      for (let i = 0; i < 45; i++) await frame0();
    }
    E.camera.position.set(site.x, (W?.heightAt?.(site.x, site.z) ?? 0) + 14, site.z);
    E.camera.updateMatrixWorld(true);
    player?.teleport?.({ x: site.x, y: (W?.heightAt?.(site.x, site.z) ?? 0) + 1.2, z: site.z }, E.camera.rotation);
    for (let i = 0; i < 60; i++) await frame0();
    return site;
  }

  const road = await findRoad();

  /**
   * Cast from just above the terrain, not from 400 m: a ray dropped from the
   * sky lands on the first bridge deck or shop roof it meets and the car gets
   * spawned on it.
   */
  function ground(x, z) {
    const t = W?.heightAt?.(x, z) ?? 0;
    const h = P.groundHeight(x, z, t + 4);
    return Number.isFinite(h) ? h : t;
  }

  const frame = () => new Promise((r) => requestAnimationFrame(r));

  /** Run `steps` frames of `input`, sampling telemetry. */
  async function run(v, steps, inputFn, sample) {
    for (let i = 0; i < steps; i++) {
      V.setInput(v, inputFn(i));
      // The world streams around the CAMERA, so it has to follow the car or the
      // road stops existing 200 m down the straight.
      E.camera.position.set(v.position.x, v.position.y + 9, v.position.z - 12);
      E.camera.updateMatrixWorld(true);
      await frame();
      if (sample) sample(i, V.telemetry(v), v);
      if (v.position.y < -80) break;
    }
  }

  const out = {};
  const probe = ground(road.x, road.z);
  out.__site = { x: +road.x.toFixed(1), z: +road.z.toFixed(1), groundY: +probe.toFixed(2), tris: P.stats.triangles };
  for (const type of types) {
    const spec = V.specOf(type);
    if (spec.kind === 'boat') { out[type] = { skipped: 'boat needs water' }; continue; }
    const gx = road.x, gz = road.z;
    const gy = ground(gx, gz);
    const v = V.spawn(type, { x: gx, y: gy + spec.comY + 0.25, z: gz }, road.yaw, { paint: 0x333333 });
    if (!v) { out[type] = { error: 'spawn failed' }; continue; }
    V.setDriver(v, { isTest: true }, 0);

    /**
     * Find a spot where the car actually sits flat. A junction node is often a
     * kerb, a bridge abutment or a camber break, and a car balanced on two
     * wheels gives numbers that mean nothing.
     */
    let rest = null;
    let startX = gx, startZ = gz;
    for (let attempt = 0; attempt < 8; attempt++) {
      const ox = gx + Math.sin(road.yaw) * attempt * 22;
      const oz = gz + Math.cos(road.yaw) * attempt * 22;
      v.setPose({ x: ox, y: ground(ox, oz) + spec.comY + 0.2, z: oz }, road.yaw);
      await run(v, 90, () => ({ throttle: 0, brake: 1, steer: 0 }));
      const t = V.telemetry(v);
      const flat = t.grounded === v.wheels.length &&
        Math.abs(t.rollDeg) < 2.5 && Math.abs(t.pitchDeg) < 3.5 &&
        t.loads.every((l) => l > spec.mass * 1.2 && l < spec.mass * 6);
      if (flat) { rest = t; startX = ox; startZ = oz; break; }
      rest = t;
    }
    out[type + '_startOffset'] = undefined;

    /**
     * Heading hold. A real driver steers; without it the car wanders off the
     * road camber into a kerb within 20 m and every acceleration number is
     * really a crash test.
     */
    const holdLine = (ox, oz) => {
      const dx = v.position.x - ox;
      const dz = v.position.z - oz;
      const sx = Math.sin(road.yaw), sz = Math.cos(road.yaw);
      const lateral = dx * sz - dz * sx;          // signed offset from the line
      const q = v.quaternion;
      const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
      let head = road.yaw - yaw;
      while (head > Math.PI) head -= Math.PI * 2;
      while (head < -Math.PI) head += Math.PI * 2;
      return Math.max(-1, Math.min(1, lateral * 0.35 - head * 1.6));
    };

    const hits = [];
    const offHit = E.events.on('vehicle:collision', (e) => {
      if (e.vehicle !== v || hits.length >= 6) return;
      hits.push({
        p: [+e.point.x.toFixed(1), +e.point.y.toFixed(2), +e.point.z.toFixed(1)],
        n: [+e.normal.x.toFixed(2), +e.normal.y.toFixed(2), +e.normal.z.toFixed(2)],
        j: Math.round(e.impulse),
        spd: +(e.speed * 3.6).toFixed(1),
        other: e.other?.name ?? String(e.other),
      });
    });

    // ---------------- acceleration ----------------------------------------
    const startPos = { x: v.position.x, z: v.position.z };
    let t0 = performance.now();
    let t100 = null, t60 = null;
    let maxSpeed = 0;
    let squatRear = 0, squatFront = 0;
    let elapsed = 0;
    await run(v, 520, () => ({ throttle: 1, brake: 0, steer: holdLine(startPos.x, startPos.z) }), (i, tm) => {
      elapsed = (performance.now() - t0) / 1000;
      if (!t60 && tm.speedKmh >= 60) t60 = elapsed;
      if (!t100 && tm.speedKmh >= 100) t100 = elapsed;
      if (tm.speedKmh > maxSpeed) maxSpeed = tm.speedKmh;
      if (i > 12 && i < 160) {
        const dF = ((rest.susp[0] + rest.susp[1]) / 2) - ((tm.susp[0] + tm.susp[1]) / 2);
        const dR = ((rest.susp[2] + rest.susp[3]) / 2) - ((tm.susp[2] + tm.susp[3]) / 2);
        if (dR > squatRear) squatRear = dR;
        if (-dF > squatFront) squatFront = -dF;
      }
    });
    const accelTele = V.telemetry(v);

    // ---------------- braking ---------------------------------------------
    const bStart = { x: v.position.x, z: v.position.z };
    const bSpeed = v.speed;
    let diveFront = 0, liftRear = 0;
    let brakeFrames = 0;
    await run(v, 700, () => ({ throttle: 0, brake: 1, steer: holdLine(bStart.x, bStart.z) }), (i, tm) => {
      if (v.speed > 0.5) brakeFrames = i;
      const dF = ((rest.susp[0] + rest.susp[1]) / 2) - ((tm.susp[0] + tm.susp[1]) / 2);
      const dR = ((rest.susp[2] + rest.susp[3]) / 2) - ((tm.susp[2] + tm.susp[3]) / 2);
      if (dF > diveFront) diveFront = dF;
      if (-dR > liftRear) liftRear = -dR;
    });
    const brakeDist = Math.hypot(v.position.x - bStart.x, v.position.z - bStart.z);

    // ---------------- cornering -------------------------------------------
    v.setPose({ x: startX, y: ground(startX, startZ) + spec.comY + 0.2, z: startZ }, road.yaw);
    await run(v, 60, () => ({ throttle: 0, brake: 1, steer: 0 }));
    let maxRoll = 0;
    let loadOut = 0, loadIn = 0;
    let maxLatSlip = 0;
    await run(v, 360, (i) => ({ throttle: i < 150 ? 1 : 0.42, brake: 0, steer: i < 150 ? 0 : 1 }),
      (i, tm) => {
        if (i > 200) {
          if (Math.abs(tm.rollDeg) > Math.abs(maxRoll)) maxRoll = tm.rollDeg;
          const l = tm.loads;
          // steering right -> left wheels are outside
          if (l[0] + l[2] > loadOut) { loadOut = l[0] + l[2]; loadIn = l[1] + l[3]; }
          if (Math.abs(tm.slipDeg) > maxLatSlip) maxLatSlip = Math.abs(tm.slipDeg);
        }
      });
    const cornerTele = V.telemetry(v);

    // ---------------- handbrake -------------------------------------------
    v.setPose({ x: startX, y: ground(startX, startZ) + spec.comY + 0.2, z: startZ }, road.yaw);
    await run(v, 60, () => ({ throttle: 0, brake: 1, steer: 0 }));
    let peakSlip = 0, recoverSlip = 0;
    await run(v, 260, (i) => ({
      throttle: i < 150 ? 1 : 0.25,
      brake: 0,
      steer: i < 150 ? 0 : 0.85,
      handbrake: i >= 150 && i < 195,
    }), (i, tm) => {
      if (i >= 150 && Math.abs(tm.slipDeg) > peakSlip) peakSlip = Math.abs(tm.slipDeg);
      if (i > 240) recoverSlip = Math.abs(tm.slipDeg);
    });

    out[type] = {
      name: spec.name,
      mass: spec.mass,
      restSusp: rest.susp,
      restLoads: rest.loads,
      restDiag: rest.diag,
      restComAboveGround: rest.comAboveGround,
      staticLoadF: Math.round(spec.staticLoadF),
      staticLoadR: Math.round(spec.staticLoadR),
      t60kmh: t60 ? +t60.toFixed(2) : null,
      t100kmh: t100 ? +t100.toFixed(2) : null,
      topKmh: +maxSpeed.toFixed(1),
      accelDist_m: +Math.hypot(v.position.x - startPos.x, v.position.z - startPos.z).toFixed(1),
      collisions: v.damage?.dents ?? 0,
      hits,
      gearAtTop: accelTele.gear,
      rpmAtTop: accelTele.rpm,
      squatRear_mm: +(squatRear * 1000).toFixed(1),
      frontLift_mm: +(squatFront * 1000).toFixed(1),
      brakeFromKmh: +(bSpeed * 3.6).toFixed(1),
      brakeDist_m: +brakeDist.toFixed(1),
      diveFront_mm: +(diveFront * 1000).toFixed(1),
      rearLift_mm: +(liftRear * 1000).toFixed(1),
      cornerRoll_deg: +maxRoll.toFixed(2),
      cornerLoadOuter_N: Math.round(loadOut),
      cornerLoadInner_N: Math.round(loadIn),
      cornerSpeedKmh: cornerTele.speedKmh,
      cornerSlip_deg: +maxLatSlip.toFixed(1),
      handbrakePeakSlip_deg: +peakSlip.toFixed(1),
      handbrakeRecovered_deg: +recoverSlip.toFixed(1),
    };
    offHit();
    V.despawn(v);
  }

  return { road: { x: +road.x.toFixed(1), z: +road.z.toFixed(1), len: +road.len.toFixed(0) }, out };
}, TYPES);

console.log(JSON.stringify(result, null, 2));
if (errs.length) console.error('PAGE ERRORS:\n' + errs.slice(0, 10).join('\n'));
await browser.close();
if (server) server.kill();
