#!/usr/bin/env node
/**
 * Empirical steering-sign check.
 *
 * `src/player/vehicle.js` feeds `moveVector().x` straight into
 * `vehicles.setInput({steer})`, and positive steer is claimed to yaw LEFT —
 * which would mean the D key steers the player left. That is a claim about a
 * sign convention, and sign conventions are exactly the thing to measure rather
 * than reason about.
 *
 * Spawns a car, holds a fixed steer input, and reports which way it actually
 * went, in world space.
 *
 *   npm run build && node tools/steercheck.mjs
 */
import { chromium } from 'playwright';
import { startServer } from './lib/server.mjs';

const { port, server } = await startServer({});
const b = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1024, height: 640 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));

try {
  await p.goto(`http://127.0.0.1:${port}/?capture=1`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction('window.__READY__===true', null, { timeout: 120000 });

  const probe = async (steer) =>
    p.evaluate(
      async ({ steer }) => {
        const e = window.__ENGINE__;
        const veh = e.ctx.peek('vehicles');
        const w = e.ctx.peek('world');
        const sp = w?.spawnPoints?.[0]?.position ?? { x: 0, y: 2, z: 0 };
        const car = veh.spawn('sedan', { x: sp.x, y: sp.y + 1.2, z: sp.z }, 0, {});
        if (!car) return { error: 'spawn failed' };

        const yaw0 = Math.atan2(
          2 * (car.quaternion.x * car.quaternion.z + car.quaternion.w * car.quaternion.y),
          1 - 2 * (car.quaternion.x ** 2 + car.quaternion.y ** 2)
        );
        const p0 = { x: car.position.x, z: car.position.z };

        // Get it rolling, then hold the steer.
        await new Promise((d) => { let i = 0; const t = () => { veh.setInput(car, { throttle: 1, brake: 0, steer: 0, handbrake: false }); return ++i >= 120 ? d() : requestAnimationFrame(t); }; requestAnimationFrame(t); });
        await new Promise((d) => { let i = 0; const t = () => { veh.setInput(car, { throttle: 0.75, brake: 0, steer, handbrake: false }); return ++i >= 150 ? d() : requestAnimationFrame(t); }; requestAnimationFrame(t); });

        const yaw1 = Math.atan2(
          2 * (car.quaternion.x * car.quaternion.z + car.quaternion.w * car.quaternion.y),
          1 - 2 * (car.quaternion.x ** 2 + car.quaternion.y ** 2)
        );
        let d = yaw1 - yaw0;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;

        // Also express it as lateral displacement relative to the initial heading.
        const dx = car.position.x - p0.x, dz = car.position.z - p0.z;
        const fx = Math.sin(yaw0), fz = Math.cos(yaw0);
        const rightX = fz, rightZ = -fx;          // right-hand normal of forward
        const lateral = dx * rightX + dz * rightZ; // +ve = moved to its own RIGHT
        veh.despawn(car);
        return { steer, yawDeltaDeg: +(d * 180 / Math.PI).toFixed(1), lateral: +lateral.toFixed(2) };
      },
      { steer }
    );

  const right = await probe(+1);
  console.log(JSON.stringify({ inputSteerPlus1: right }, null, 2));
  if (right.error) throw new Error(right.error);
  const wentRight = right.lateral > 0.5;
  const wentLeft = right.lateral < -0.5;
  console.log(
    wentRight
      ? '\nsteer=+1 turns RIGHT. Player mapping (D -> +x -> steer) is CORRECT.'
      : wentLeft
        ? '\nsteer=+1 turns LEFT. Player mapping is INVERTED — D steers left. Negate it.'
        : '\nInconclusive: the car barely moved laterally. Check it is actually driving.'
  );
} catch (e) {
  console.error('steercheck failed:', e.message);
  console.error(errs.slice(0, 6).join('\n'));
} finally {
  await b.close();
  server?.kill();
}
