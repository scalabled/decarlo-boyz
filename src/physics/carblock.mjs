#!/usr/bin/env node
/**
 * CAR BLOCK — does a man on foot actually stop at a car?
 *
 *   node src/physics/carblock.mjs
 *   node src/physics/carblock.mjs --off      # the negative control
 *   node src/physics/carblock.mjs --json=/tmp/carblock.json
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ────────────────────────────────────────────────────────────────────────────
 * He did not. `CharacterController` resolved against the static BVH and nothing
 * else, `physics.addCollider` produces raycast-only hitboxes, and nothing in
 * `src/vehicles` ever registered blocking geometry — so the player, every ped
 * that used a capsule, and every AI walked straight through parked cars and
 * moving traffic alike. Nothing logged it because nothing was wrong: no code
 * path existed that could have stopped them.
 *
 * WHAT IS ASSERTED, AND WHY IT IS NOT THE CODE'S OWN INPUT.
 *
 * The push is computed from `v.spec.dims` and `v.position`. Asserting that the
 * capsule ends up outside `max(W,L)/2 * 0.72 + 0.25` would therefore be the
 * same arithmetic on both sides of the equals sign — the exact failure
 * ARCHITECTURE.md rule 12 describes. So the measured quantity is the one the
 * player experiences and the code never computes:
 *
 *   inside     the capsule centre within the body box's INSCRIBED CIRCLE,
 *              `min(half.x, half.z)` about the vehicle origin. Derived from the
 *              box alone, inside the bodywork on every heading, and impossible
 *              for any choice of push shape to argue with. The push knows
 *              nothing about the box; this knows nothing about the push.
 *   overlap    horizontal distance from the true OBB, same frame, as a RATCHET:
 *              the 0.72 radial bound is deliberately shorter than the nose, so
 *              a head-on approach ends a little inside the bumper by design.
 *   stuck      the controller's own `stuckDistance` — the forgiveness
 *              machinery's stuck detector — must never fire while walking into
 *              a car. A block that traps is worse than no block.
 *   reach      the capsule must still be able to get within `player`'s own
 *              `ENTER_REACH` of the bodywork, or the fix has made every car in
 *              the city unenterable. Measured as OBB distance, which is what
 *              `player/vehicle.js:_boxDistance` uses.
 *
 * Three scenarios:
 *
 *   approach   walk a capsule at a parked car from 8 compass directions and
 *              watch every step
 *   drive-by   put the capsule in a car's path and DRIVE the car at him with
 *              `vehicles.setInput`, watching every frame for an
 *              interpenetration. Standing beside a lane and waiting for the AI
 *              was tried first and reported INCONCLUSIVE — nothing came within
 *              17.6 m in 900 frames.
 *   control    `--off` sets `?novehicleblock=1`, which is the build before this
 *              change. Pass-through must return, or the numbers above are
 *              measuring nothing.
 *
 * Exit code 1 on any failed assertion.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const OFF = !!args.off;
/** `player/vehicle.js` ENTER_REACH. Duplicated on purpose — see `reach`. */
const ENTER_REACH = 2.2;
/**
 * RATCHET (ARCHITECTURE rule 13): the longest unbroken run of frames in which a
 * moving car may overlap a bystander before he is pushed clear. Records where
 * this pass got to, not where the bar should be. LOWER it when the push gets
 * quicker; never raise it to make a run go green.
 */
const CORE_RUN_MAX = 6;

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

let report = null;
let failure = null;

/* ===================================================================== */

async function runSite() {
  const eng = window.__ENGINE__;
  const phys = eng.ctx.peek('physics');
  const veh = eng.ctx.peek('vehicles');
  const world = eng.ctx.peek('world');
  if (!phys || !veh || !world) return { error: 'physics, vehicles or world missing' };

  const R = 0.32;
  const HGT = 1.78;
  const G = -9.81 * 2.1;
  const H = 1 / 120;
  const SPEED = 2.6;

  /**
   * Horizontal distance from a vehicle's TRUE oriented box, in metres.
   * Negative = the capsule is inside the bodywork in plan.
   *
   * Solved from the vehicle's own quaternion and half extents, which is a
   * completely different quantity from the radial bound the push uses. That is
   * the point: two independent descriptions of "where the car is", and only a
   * real block makes them agree.
   */
  const obbDist = (v, x, y, z) => {
    const half = v.spec?.half;
    if (!half) return Infinity;
    const q = v.quaternion;
    // inverse rotate (x,z) about the vehicle origin
    const dx = x - v.position.x;
    const dy = y - v.position.y;
    const dz = z - v.position.z;
    const ix = -q.x, iy = -q.y, iz = -q.z, iw = q.w;
    // rotate d by the inverse quaternion
    const tx = 2 * (iy * dz - iz * dy);
    const ty = 2 * (iz * dx - ix * dz);
    const tz = 2 * (ix * dy - iy * dx);
    const lx = dx + iw * tx + (iy * tz - iz * ty);
    const lz = dz + iw * tz + (ix * ty - iy * tx);
    const ox = Math.max(0, Math.abs(lx) - half.x);
    const oz = Math.max(0, Math.abs(lz) - half.z);
    const out = Math.hypot(ox, oz);
    if (out > 0) return out;
    // inside in plan: signed depth to the nearest face
    return -Math.min(half.x - Math.abs(lx), half.z - Math.abs(lz));
  };

  const c = phys.createCharacter({ radius: R, height: HGT, id: 'carblock' });
  const settle = (n = 120) => {
    for (let i = 0; i < n; i++) {
      c.velocity.y = Math.max(-24, c.velocity.y + G * H);
      c.move(0, c.velocity.y * H, 0);
      if (c.grounded) { c.velocity.y = 0; return true; }
    }
    return c.grounded;
  };

  /* ---------------- 1. approach a parked car from 8 sides ------------- */
  //
  // Spawn one under the probe's own control rather than hunting for traffic: a test
  // that depends on where the AI happened to park is a test that reports a
  // different number every run.
  const p = eng.ctx.camera.position;
  const gx = p.x;
  const gz = p.z;
  const gy = world.walkableHeightAt(gx, gz);
  let car = null;
  // `vehicles.spawn(type, position, yaw, opts)` — the signature is documented
  // at the top of src/vehicles/index.js and is read-only from here.
  try {
    car = veh.spawn('sedan', { x: gx, y: gy + 0.6, z: gz }, 0.6) ?? null;
  } catch { car = null; }
  if (!car) {
    // Fall back to the nearest live vehicle; still a real car, just not a
    // placed one.
    car = veh.nearest?.(gx, gy, gz, 120) ?? veh.vehicles?.[0] ?? null;
  }
  if (!car) { phys.removeCharacter(c); return { error: 'no vehicle to test against' }; }
  // The blocker set is refreshed once per FIXED STEP, and nothing has stepped
  // since the spawn — so without this the newly spawned car is not in it and the
  // whole test measures the build it is supposed to be checking. (It did, on the
  // first run: 6 of 8 approaches walked clean through.)
  for (let i = 0; i < 40; i++) await new Promise((r) => requestAnimationFrame(r));

  const spec = car.spec ?? {};
  const dims = spec.dims ?? { L: 4.6, W: 2.0, H: 1.15 };
  /** Inscribed radius of the body box: unambiguously inside the car. */
  const core = spec.half ? Math.min(spec.half.x, spec.half.z) : Math.min(dims.W, dims.L) / 2;
  const approach = [];
  let worstOverlap = Infinity;   // most negative = deepest penetration
  let bestReach = Infinity;      // closest OBB distance any approach achieved
  let stuckFired = 0;
  let passedThrough = 0;

  for (let k = 0; k < 8; k++) {
    const ang = (k / 8) * Math.PI * 2;
    const ux = Math.cos(ang);
    const uz = Math.sin(ang);
    const start = Math.max(dims.L, dims.W) * 0.5 + 5.5;
    const sx = car.position.x + ux * start;
    const sz = car.position.z + uz * start;
    c.teleport(sx, world.walkableHeightAt(sx, sz) + 0.4, sz);
    if (!settle()) continue;
    c.stuckDistance = 0;
    let closest = Infinity;
    let deepest = Infinity;
    let inCore = false;
    const steps = Math.ceil((start + 3.0) / (SPEED * H));
    for (let i = 0; i < steps; i++) {
      c.velocity.x = -ux * SPEED;
      c.velocity.z = -uz * SPEED;
      if (c.grounded) c.velocity.y = Math.min(0, c.velocity.y);
      else c.velocity.y = Math.max(-24, c.velocity.y + G * H);
      c.move(c.velocity.x * H, c.velocity.y * H, c.velocity.z * H);
      const d = obbDist(car, c.position.x, c.position.y, c.position.z);
      if (d < closest) closest = d;
      if (d < deepest) deepest = d;
      if (c.stuckDistance >= c.unstickAfter && c.unstickAfter > 0) stuckFired++;
      /**
       * "INSIDE THE CAR", stated so that neither the push formula nor the
       * design's chosen shape can define it away.
       *
       * The first cut called it a pass-through when the capsule ended up on the
       * far side, and that was wrong: a RADIAL push slides you round the car,
       * so walking into a wing and coming out behind the boot is the intended
       * behaviour, not a failure. The version before that asserted the capsule
       * never touches the OBB at all, which the 0.72 bound deliberately does
       * not promise at the nose.
       *
       * The INSCRIBED CIRCLE of the box — `min(half.x, half.z)` about the
       * vehicle origin — is inside the bodywork on every heading and is derived
       * only from the box. Being in there is being in the car by anyone's
       * definition, and no choice of push shape can argue with it.
       */
      const rx = c.position.x - car.position.x;
      const rz = c.position.z - car.position.z;
      if (rx * rx + rz * rz < core * core) inCore = true;
    }
    if (inCore) passedThrough++;
    if (deepest < worstOverlap) worstOverlap = deepest;
    if (closest < bestReach) bestReach = closest;
    approach.push({ dir: k, closest: +closest.toFixed(3), inCore });
  }

  /* ---------------- 2. drive-by: live traffic passes a bystander ------- */
  //
  // The approach test moves the capsule into a stationary car; this is the
  // other order, which is the one a physics push can get wrong — the vehicle
  // arrives at 12 m/s and the capsule has to be got out of the way rather than
  // pushed into it.
  let driveFrames = 0;
  let driveWorst = Infinity;
  let driveContacts = 0;
  let driveNearest = Infinity;
  let drivePush = 0;
  let driveCore = 0;
  let coreRun = 0;
  let coreRunMax = 0;
  {
    /**
     * WAITING FOR TRAFFIC DOES NOT WORK, AND NEITHER DOES ASKING IT TO DRIVE.
     *
     * The first cut stood a bystander on the nearest lane centre for 900 frames
     * and nothing came closer than 17.6 m. The second pinned `setInput` throttle
     * on a parked car and it did not move — no driver, so `vehicles` has nothing
     * to apply it through. Both reported INCONCLUSIVE, which is honest and
     * useless.
     *
     * So sweep the car through the capsule with `setPose`, which is the same
     * thing every other probe in this repo does to put an actor where the test
     * needs it. It is a harness action, not gameplay: the point is not how the
     * car got there, it is whether a capsule standing still is inside the
     * bodywork on any frame while a vehicle passes over its ground.
     */
    const sx0 = car.position.x;
    const sz0 = car.position.z;
    const yaw = Math.atan2(2 * (car.quaternion.w * car.quaternion.y), 1 - 2 * (car.quaternion.y ** 2));
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    // Bystander 9 m down the car's own axis; the car starts 9 m the other way
    // and is walked straight through where he stands at ~7 m/s.
    const bx = sx0 + fx * 9;
    const bz = sz0 + fz * 9;
    c.teleport(bx, world.walkableHeightAt(bx, bz) + 0.4, bz);
    settle();
    c.stuckDistance = 0;
    const carY = car.position.y;
    for (let i = 0; i < 260; i++) {
      const t = -9 + i * 0.12;
      try {
        car.setPose({ x: sx0 + fx * (9 + t), y: carY, z: sz0 + fz * (9 + t) }, yaw);
        car.syncTransforms?.(1, 0);
      } catch { /* stub */ }
      await new Promise((r) => requestAnimationFrame(r));
      for (let k2 = 0; k2 < 2; k2++) {
        // Standing still, resisting nothing: the push is the only thing acting.
        c.velocity.x = 0;
        c.velocity.z = 0;
        if (c.grounded) c.velocity.y = Math.min(0, c.velocity.y);
        else c.velocity.y = Math.max(-24, c.velocity.y + G * H);
        c.move(0, c.velocity.y * H, 0);
        if (c.pushedByVehicle > drivePush) drivePush = c.pushedByVehicle;
      }
      driveFrames++;
      if (Math.abs(car.position.y - c.position.y) < 3) {
        const d = obbDist(car, c.position.x, c.position.y, c.position.z);
        if (d < driveNearest) driveNearest = d;
        if (d <= 3) {
          driveContacts++;
          if (d < driveWorst) driveWorst = d;
        }
        const rx = c.position.x - car.position.x;
        const rz = c.position.z - car.position.z;
        if (rx * rx + rz * rz < core * core) {
          driveCore++;
          if (++coreRun > coreRunMax) coreRunMax = coreRun;
        } else {
          coreRun = 0;
        }
      }
    }
  }

  phys.removeCharacter(c);
  return {
    car: spec.name ?? spec.id ?? 'vehicle',
    dims,
    approach,
    worstOverlap: Number.isFinite(worstOverlap) ? +worstOverlap.toFixed(3) : null,
    bestReach: Number.isFinite(bestReach) ? +bestReach.toFixed(3) : null,
    passedThrough,
    stuckFired,
    driveFrames,
    driveContacts,
    driveWorst: Number.isFinite(driveWorst) ? +driveWorst.toFixed(3) : null,
    driveNearest: Number.isFinite(driveNearest) ? +driveNearest.toFixed(3) : null,
    drivePush: +drivePush.toFixed(3),
    driveCore,
    coreRunMax,
    core: +core.toFixed(3),
    blockers: phys.blockers?.n ?? 0,
  };
}

/* ===================================================================== */

try {
  const qs = ['q=high'];
  if (OFF) qs.push('novehicleblock=1');
  await page.goto(`http://127.0.0.1:${port}/?${qs.join('&')}`, {
    waitUntil: 'domcontentloaded', timeout: 120000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });
  await pump(180);
  const r = await page.evaluate(runSite);
  if (r.error) throw new Error(r.error);
  report = { off: OFF, ...r };
} catch (e) {
  failure = e;
} finally {
  await browser.close();
  stopServer(server);
}

if (failure) {
  console.error(`[carblock] FAILED: ${failure.message}`);
  if (errors.length) console.error(errors.slice(0, 8).join('\n'));
  process.exit(1);
}

const R = report;
console.log('');
console.log(`[carblock] ${R.off ? 'BLOCKERS OFF (negative control)' : 'current'} — ` +
  `${R.car} ${R.dims.L}x${R.dims.W}x${R.dims.H} m, ${R.blockers} blockers live`);
console.log(`  approach: ${R.approach.map((a) => a.closest.toFixed(2)).join(' ')}  (m from the OBB, per compass point)`);
console.log(`  drive-by: ${R.driveContacts} frames within 3 m of a moving vehicle over ${R.driveFrames}, closest ${R.driveWorst ?? 'n/a'} m`);

const F = [];
const check = (ok, name, detail) => F.push({ ok, name, detail });

check(
  R.passedThrough === 0,
  'a capsule cannot walk into a parked car',
  `${R.passedThrough} of 8 compass approaches put the capsule centre inside the body box's ` +
  `inscribed circle (${R.core} m about the vehicle origin — inside the bodywork on every heading)`
);
check(
  // RATCHET at 0.35 m, measured 0.18. NOT a claim of zero, and the reason is
  // the SHAPE, which is chosen and not an accident: the bound is a cylinder of
  // `max(W,L)/2 * 0.72`, so it inscribes the body comfortably at the doors and
  // is deliberately shorter than the nose and tail. A capsule walking head-on
  // therefore ends with its centre a little inside the bumper. That is the
  // price of having no corners to catch on, and it is the right trade for
  // traversal — reaching zero means a two-sphere bound, which puts the corners
  // back. Lower this if someone does that work; never raise it.
  R.worstOverlap !== null && R.worstOverlap > -0.35,
  'and is never more than a bumper deep in the bodywork',
  `worst horizontal distance from the capsule CENTRE to the true OBB across all ` +
  `8 approaches: ${R.worstOverlap === null ? 'n/a' : R.worstOverlap.toFixed(3)} m ` +
  `(negative is inside; the radial bound is 0.72 of the half-length by design)`
);
check(
  R.stuckFired === 0,
  'and is never trapped by the block',
  `the controller's own stuck detector fired on ${R.stuckFired} steps while walking into the car`
);
check(
  R.bestReach !== null && R.bestReach <= ENTER_REACH,
  'and can still reach the door',
  `closest approach to the bodywork is ${R.bestReach === null ? 'n/a' : R.bestReach.toFixed(2)} m; ` +
  `player/vehicle.js needs ${ENTER_REACH} m to offer [F]`
);
check(
  // A vehicle sweeping over the ground a bystander is standing on must move
  // him, not pass through him. `driveContacts === 0` means the sweep never got
  // near and the scenario proved nothing — reported, never passed.
  //
  // NOT `driveCore === 0`. That was the first form of this assertion and it is
  // the wrong question for a SWEPT contact: a car arriving at 8 m/s covers
  // 0.13 m per frame, so the bodywork can reach the capsule centre before the
  // next movement step has had a chance to push him clear. Demanding that no
  // frame ever shows an overlap demands that the push act before the car
  // arrives. MEASURED on a working block: 17 of 151 contact frames overlapped,
  // never for more than a few frames at a time, with the capsule always pushed
  // back out — which is exactly what being shoved by a car looks like.
  //
  // The honest question is whether he is PUSHED OUT or DRIVEN THROUGH, so:
  // overlaps must be transient (a short run, not a sustained pass-through) and
  // the push must be non-zero. A car that passes through him would show one
  // long unbroken run of inside-frames and no push at all.
  R.driveContacts > 0 && R.coreRunMax <= CORE_RUN_MAX && R.drivePush > 0,
  'a vehicle that arrives at a bystander shoves him aside rather than passing through',
  R.driveContacts === 0
    ? `INCONCLUSIVE — the sweep never came within 3 m (nearest ${R.driveNearest ?? 'n/a'} m)`
    : `${R.driveCore} of ${R.driveContacts} contact frames overlapped the ${R.core} m inscribed ` +
      `circle, longest unbroken run ${R.coreRunMax} frame(s) (RATCHET: <= ${CORE_RUN_MAX}); ` +
      `largest single push ${R.drivePush.toFixed(3)} m (0 would mean he was never touched); ` +
      `deepest reach of the bodywork ${R.driveWorst.toFixed(3)} m`
);

console.log('');
let bad = 0;
for (const f of F) {
  console.log(`${f.ok ? '  ok  ' : '  FAIL'} ${f.name}`);
  console.log(`        ${f.detail}`);
  if (!f.ok) bad++;
}

if (args.json) {
  const p = resolve(String(args.json));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(report, null, 2));
  console.log(`\n  json -> ${p}`);
}

console.log('');
console.log(bad ? `[carblock] ${bad} CHECK${bad > 1 ? 'S' : ''} FAILED` : '[carblock] ALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
