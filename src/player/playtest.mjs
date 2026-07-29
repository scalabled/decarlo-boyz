#!/usr/bin/env node
/**
 * Motion test for the player subsystem.
 *
 * Motion cannot be judged from a still, so this drives the real engine through
 * a scripted input sequence and measures the four things a critic would look
 * for first. All of them are numeric, and all of them fail loudly:
 *
 *   1. FOOT SLIDING. Every frame, for each foot the animator reports as
 *      planted, we record its world IK target. While a foot stays planted that
 *      point must not move. The report gives the worst per-frame drift and the
 *      total drift across a single contact, in millimetres.
 *
 *   2. CAMERA CONTINUITY. The camera's per-frame displacement is differentiated
 *      twice. A spring/damper produces bounded jerk; a snap or a mode switch
 *      produces a spike. Anything over the threshold is listed with its frame.
 *
 *   3. CAMERA PENETRATION. Every frame we overlap-test a sphere at the camera
 *      against the static world. A single non-zero frame means the boom clipped
 *      into geometry.
 *
 *   4. SETTLING. After a sprint is released, the boom length must converge
 *      monotonically, not ring. We count sign changes in d(distance)/dt over
 *      the second following the release; more than two is an oscillation.
 *
 *   node src/player/playtest.mjs
 *   node src/player/playtest.mjs --script=alley   # camera in a tight space
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE GAMEPLAY SCRIPTS
 *
 * `run` / `turn` / `alley` are the original motion regression and their numbers
 * must not move. Four more drive the mechanics that a still frame and a gait
 * measurement both miss completely:
 *
 *   --script=views   cycle V through all four views, on foot. Reports the boom
 *                    length each view settles at and re-runs the SAME continuity
 *                    test — a view change must not register as a discontinuity.
 *   --script=melee   swing a melee weapon and measure the BODY: the signed arc,
 *                    where its peak sits relative to the weapon's contact frame,
 *                    and the world speed of the weapon hand at that frame.
 *   --script=swim    teleport into the Monongahela and measure the float line,
 *                    the stroke speed, the breath meter, drowning and the climb
 *                    back out.
 *   --script=car     walk to a car, F, drive, F, and check the exit point is not
 *                    inside geometry.
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
const PORT = Number(args.port ?? 5175);
const SCRIPT = args.script ?? 'run';

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function ensureServer() {
  if (await portOpen(PORT)) return null;
  const root = resolve(import.meta.dirname, '../..');
  const p = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root, stdio: 'ignore', env: { ...process.env, OW_NO_HMR: '1' },
  });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(PORT)) return p;
  }
  p.kill();
  throw new Error('vite failed to start');
}

/**
 * The scripted sequences. Each entry is [frames, scriptedInput|null, note].
 * `look` is a per-frame mouse delta injected straight into the camera rig.
 */
const SCRIPTS = {
  run: [
    [40, null, 'idle'],
    [90, { x: 0, y: 1 }, 'jog forward'],
    [110, { x: 0, y: 1, sprint: true }, 'sprint'],
    [70, null, 'release -> hard stop + settle'],
    [60, { x: 1, y: 0 }, 'strafe right (body turns)'],
    [50, { x: 0, y: 1 }, 'jog again'],
    // NB: no `jump` here. A scripted jump used never to fire (the harness
    // latched it as HELD only, so the buffer was never armed) and this script
    // is the standing regression, so it keeps measuring exactly what it always
    // measured. The jump now works and has its own script below.
    [40, { x: 0, y: 1 }, 'jog on'],
    [60, null, 'stop + settle'],
  ],
  jump: [
    [40, null, 'idle'],
    [70, { x: 0, y: 1 }, 'run up'],
    [4, { x: 0, y: 1, jump: true }, 'jump'],
    [50, { x: 0, y: 1 }, 'airborne'],
    [80, null, 'land + settle'],
  ],
  turn: [
    [30, null, 'idle'],
    [120, { x: 0, y: 1 }, 'jog with the camera swinging'],
    [80, null, 'stop'],
  ],
  alley: [
    [30, null, 'idle'],
    [200, { x: 0, y: 1 }, 'walk into whatever is ahead'],
    [60, null, 'stop against it'],
  ],

  /* ---- gameplay ---------------------------------------------------- */
  views: [
    [1, null, 'find open ground', 'open'],
    [90, null, 'settle'],
    [40, null, 'chase (default)'],
    [1, null, 'cycle', 'view'],
    [75, null, 'close'],
    [1, null, 'cycle', 'view'],
    [75, null, 'far'],
    [1, null, 'cycle', 'view'],
    [75, null, 'first person'],
    [1, null, 'cycle', 'view'],
    [75, null, 'back to chase'],
    [1, null, 'cycle', 'view'],
    [60, { x: 0, y: 1 }, 'close, moving'],
  ],
  melee: [
    [1, null, 'find open ground', 'open'],
    [150, null, 'let the crowd spawn', 'meleeWeapon'],
    // Square up again immediately before each swing: a startled ped clears the
    // pipe's reach in well under a second, so measuring a hit means putting the
    // target in front of the character on the frame the swing starts.
    [1, null, 'square up to a ped', 'toPed'],
    [3, null, 'settle'],
    [1, null, 'swing 1', 'swing'],
    [45, null, 'swing 1 arc'],
    [1, null, 'square up to a ped', 'toPed'],
    [3, null, 'settle'],
    [1, null, 'swing 2', 'swing'],
    [45, null, 'swing 2 arc'],
    [1, null, 'square up to a ped', 'toPed'],
    [3, null, 'settle'],
    [1, null, 'swing 3', 'swing'],
    [45, null, 'swing 3 arc'],
    [40, null, 'recover'],
  ],
  swim: [
    [20, null, 'on land'],
    [1, null, 'into the river', 'water'],
    [110, null, 'fall in and float'],
    [110, { x: 0, y: 1 }, 'swim forward'],
    [90, { x: 0, y: 1, crouch: true }, 'dive under'],
    [70, { x: 0, y: 0 }, 'surface'],
    [40, null, 'tread'],
    [1, null, 'face the bank', 'toBank'],
    [420, { x: 0, y: 1 }, 'swim out and climb the bank'],
    [60, { x: 0, y: 1 }, 'keep walking on land'],
  ],
  drown: [
    [20, null, 'on land'],
    [1, null, 'into the river', 'water'],
    [110, null, 'fall in and float'],
    // Dive FIRST: the breath meter refills whenever the head is out, so
    // emptying the lungs at the surface just watches them fill up again.
    [120, { x: 0, y: 0, crouch: true }, 'dive and hold'],
    [1, { x: 0, y: 0, crouch: true }, 'empty the lungs', 'noBreath'],
    [640, { x: 0, y: 0, crouch: true }, 'stay under'],
  ],
  jack: [
    [150, null, 'let traffic populate'],
    [1, null, 'stand at a moving car\'s door', 'toOccupied'],
    [6, null, 'settle'],
    [1, null, 'press F', 'use'],
    [220, null, 'haul the driver out and get in'],
    [90, { x: 0, y: 1 }, 'drive off in it'],
  ],
  car: [
    [20, null, 'on foot', 'toCar'],
    [40, null, 'at the door'],
    [1, null, 'press F', 'use'],
    [130, null, 'get in'],
    [120, { x: 0, y: 1 }, 'drive'],
    [1, null, 'press F', 'use'],
    [140, null, 'get out'],
    [40, null, 'stand'],
  ],
};

const server = await ensureServer();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

let failed = null;
try {
  await page.goto(`http://127.0.0.1:${PORT}/?q=medium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 90000 });

  const raw = await page.evaluate(async (steps) => {
    const e = window.__ENGINE__;
    const p = e.ctx.peek('player');
    const phys = e.ctx.peek('physics');
    e.input.enabled = true;
    e.input.frozen = true; // no real mouse; we push look deltas by hand
    p.setControlEnabled(true);

    const samples = [];
    const frame = () => new Promise((r) => requestAnimationFrame(r));

    // Find a spot that is genuinely OUTDOORS. Several of the city's spawn
    // points currently sit under decks or inside building shells, and a
    // camera-collision measurement taken from inside a building measures the
    // building rather than the camera. Search a ring around each spawn for a
    // point with solid ground, a clear capsule, and open sky above it.
    const world = e.ctx.peek('world');
    // "Open" is defined by what the test actually needs: room for the capsule,
    // a clear 3.4 m boom behind and above (which is the camera's own query),
    // and eight metres of runway ahead. An earlier version also demanded open
    // sky, which never passes — the world registers a perimeter shell.
    const openAt = (x, z, yaw) => {
      const gy = phys.groundHeight(x, z, 200);
      if (!Number.isFinite(gy)) return null;
      const pivot = { x, y: gy + 1.45, z };
      if (phys.overlapSphere(pivot, 0.8, phys.MASK.WORLD) > 0) return null;
      const back = { x: Math.sin(yaw) * 0.94, y: 0.28, z: Math.cos(yaw) * 0.94 };
      const bl = Math.hypot(back.x, back.y, back.z);
      back.x /= bl; back.y /= bl; back.z /= bl;
      if (phys.sphereCast(pivot, back, 0.3, 3.6, phys.MASK.WORLD).hit) return null;
      const fwd = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
      if (phys.sphereCast(pivot, fwd, 0.4, 9, phys.MASK.WORLD).hit) return null;
      return gy;
    };
    let found = null;
    outer:
    for (let i = 0; i < 8 && !found; i++) {
      const sp = world?.spawn?.(i);
      if (!sp?.position) continue;
      for (let r = 0; r <= 40 && !found; r += 2.5) {
        for (let a2 = 0; a2 < 16; a2++) {
          const th = (a2 / 16) * Math.PI * 2;
          const x = sp.position.x + Math.cos(th) * r;
          const z = sp.position.z + Math.sin(th) * r;
          const gy = openAt(x, z, sp.yaw ?? 0);
          if (gy !== null) { found = { x, z, gy, yaw: sp.yaw ?? 0, spawn: i, r }; break outer; }
        }
      }
    }
    if (found) {
      p.movement.teleport(found.x, found.gy + 0.05, found.z, found.yaw);
      p.rig.reset(p.movement.anchorHeight, p.movement.position, found.yaw);
    }
    // Let the drop, the streaming and every filter settle before measuring.
    for (let i = 0; i < 90; i++) await frame();

    /* The gameplay scripts need more than a stick: a key press, a teleport into
     * a river, a swing. Functions cannot cross `page.evaluate`, so a step's
     * fourth element names one of these instead. */
    const weapons = e.ctx.peek('weapons');
    const vehicles = e.ctx.peek('vehicles');
    const acts = {
      /**
       * Put the camera somewhere the CAMERA is what is being measured.
       * The default site search only asks for a clear capsule and 3.6 m of
       * boom, which in this city usually lands between two buildings — and a
       * boom that is collision-limited to 1.1 m cannot show you what four
       * views look like, nor whether a view change is continuous, because
       * every number you read is the alley's. This asks for six metres of
       * empty sphere, which is a car park, a runway or the middle of a road.
       */
      open: () => {
        const w = e.ctx.peek('world');
        const at = p.position;
        for (let r = 0; r <= 700; r += 7) {
          for (let a2 = 0; a2 < 24; a2++) {
            const th = (a2 / 24) * Math.PI * 2;
            const x = at.x + Math.cos(th) * r;
            const z = at.z + Math.sin(th) * r;
            if (w?.isWater?.(x, z)) continue;
            const gy = phys.groundHeight(x, z, 400);
            if (!Number.isFinite(gy)) continue;
            if (phys.overlapSphere({ x, y: gy + 6.2, z }, 6, phys.MASK.WORLD) > 0) continue;
            if (phys.overlapSphere({ x, y: gy + 1.45, z }, 1.0, phys.MASK.WORLD) > 0) continue;
            p.movement.teleport(x, gy + 0.05, z, 0);
            p.rig.reset(p.movement.anchorHeight, p.movement.position, 0);
            return;
          }
        }
      },
      view: () => { p.cycleCamera(); },
      /**
       * Put a living pedestrian inside the pipe's reach and point BOTH the body
       * and the camera at him — `weapons` sweeps its fan down the camera's yaw,
       * so a test that only turns the body measures nothing.
       */
      toPed: () => {
        const peds = e.ctx.peek('peds');
        const list = peds?.peds ?? [];
        const at = p.position;
        let best = null, bd = 1e9;
        for (const q of list) {
          if (!q?.active || !q.alive || q.vehicle) continue;
          const d = (q.position.x - at.x) ** 2 + (q.position.z - at.z) ** 2;
          if (d < bd) { bd = d; best = q; }
        }
        if (!best) return;
        const dx = at.x - best.position.x, dz = at.z - best.position.z;
        const l = Math.hypot(dx, dz) || 1;
        const x = best.position.x + (dx / l) * 1.25;
        const z = best.position.z + (dz / l) * 1.25;
        const gy = phys.groundHeight(x, z, best.position.y + 4);
        const yaw = Math.atan2(-(best.position.x - x), -(best.position.z - z));
        p.movement.teleport(x, Number.isFinite(gy) ? gy + 0.05 : best.position.y, z, yaw);
        p.rig.reset(p.movement.anchorHeight, p.movement.position, yaw);
        p.rig.pitch = p.rig.pitchTarget = 0;
        p.rig.applyTo(e.camera);
        window.__PED__ = best;
      },
      meleeWeapon: () => {
        // Cycle to whatever melee weapon this brother is carrying; every one of
        // them starts with fists plus a pipe / wrench / crowbar (DESIGN.md).
        if (weapons?.current?.melee) return;
        for (let i = 0; i < 20 && !weapons?.current?.melee; i++) weapons?.nextWeapon?.();
      },
      swing: () => { weapons?.tryMelee?.(); },
      water: () => {
        // Find deep water near the player and drop him three metres above it.
        const w = e.ctx.peek('world');
        const at = p.position;
        let found = null;
        for (let r = 6; r <= 900 && !found; r += 6) {
          for (let a2 = 0; a2 < 24; a2++) {
            const th = (a2 / 24) * Math.PI * 2;
            const x = at.x + Math.cos(th) * r;
            const z = at.z + Math.sin(th) * r;
            if (w?.isWater?.(x, z) && w.heightAt(x, z) < -4) { found = { x, z }; break; }
          }
        }
        if (!found) return;
        p.movement.teleport(found.x, (w.WATER_Y ?? 0) + 3, found.z, 0);
        p.rig.reset(p.movement.anchorHeight, p.movement.position, 0);
      },
      noBreath: () => { p.movement.breath = 0.02; },
      /**
       * Point him at the nearest dry land. A gentle bank needs no mechanic —
       * the depth falls under `exitDepth` and you walk out — but that IS the
       * thing to prove, because if the handoff does not happen you tread water
       * against a beach forever.
       */
      toBank: () => {
        const w = e.ctx.peek('world');
        const at = p.position;
        let best = null, bd = 1e9;
        for (let a2 = 0; a2 < 48; a2++) {
          const th = (a2 / 48) * Math.PI * 2;
          for (let r = 6; r <= 260; r += 6) {
            const x = at.x + Math.cos(th) * r;
            const z = at.z + Math.sin(th) * r;
            if (w?.isWater?.(x, z)) continue;
            if (r < bd) { bd = r; best = th; }
            break;
          }
        }
        if (best === null) return;
        const yaw = Math.atan2(-Math.cos(best), -Math.sin(best));
        p.movement.faceYaw = p.movement.moveYaw = yaw;
        p.rig.yaw = p.rig.yawTarget = yaw;
        window.__BANK__ = +bd.toFixed(1);
      },
      toCar: () => {
        const at = p.position;
        const n = vehicles?.nearest?.(at.x, at.y, at.z, 600);
        if (!n) return;
        const half = n.spec?.half ?? { x: 1, z: 2.3 };
        p.movement.teleport(
          n.position.x - (half.x + 0.9), n.position.y + 0.4, n.position.z, 0
        );
        p.rig.reset(p.movement.anchorHeight, p.movement.position, 0);
      },
      use: () => { p.movement.scriptedInput = { x: 0, y: 0, use: true }; },
      /**
       * Stand at the driver's door of a car somebody is ACTUALLY DRIVING, and
       * do it while the car is moving — a carjack against a parked car proves
       * nothing about the case the player meets on every street.
       */
      toOccupied: () => {
        const veh = e.ctx.peek('vehicles');
        const peds = e.ctx.peek('peds');
        const list = veh?.vehicles ?? [];
        const at = p.position;
        let best = null, bd = 1e9;
        const traffic = e.ctx.peek('traffic');
        for (const v of list) {
          if (!v || v.destroyed) continue;
          const driven = !!v.driver || !!peds?.driverOf?.(v) || !!traffic?.driverOf?.(v);
          if (!driven) continue;
          if ((v.speed ?? 0) < 1.5) continue;   // must actually be moving
          const d = (v.position.x - at.x) ** 2 + (v.position.z - at.z) ** 2;
          if (d < bd) { bd = d; best = v; }
        }
        if (!best) return;
        const a = veh.seatAnchor(best, 0);
        const yaw = Math.atan2(-(best.position.x - a.enter.x), -(best.position.z - a.enter.z));
        const gy = phys.groundHeight(a.enter.x, a.enter.z, a.enter.y + 3);
        p.movement.teleport(
          a.enter.x, Number.isFinite(gy) ? gy + 0.05 : best.position.y, a.enter.z, yaw
        );
        p.rig.reset(p.movement.anchorHeight, p.movement.position, yaw);
        window.__JACK__ = best;
        window.__JACKSPEED__ = best.speed ?? 0;
      },
    };

    // `physics` raises one impact per layer a melee sweep goes through; the
    // count is how we know the contact frame actually resolved against
    // something rather than the arc playing into thin air.
    let impactCount = 0;
    let pedDamage = 0;
    const offImpact = e.events.on('bullet:impact', () => { impactCount++; });
    const offDealt = e.events.on('damage:dealt', (ev) => {
      // Damage TO the player is not a melee hit; everything else here is.
      const t = ev?.target;
      if (t === p || t === 'player' || t?.isPlayer === true) return;
      pedDamage += ev?.amount ?? 0;
    });

    const actErrors = [];
    for (const [n, input, note, act] of steps) {
      if (act === 'use') p.movement.scriptedInput = null;
      else p.movement.scriptedInput = input;
      if (act && acts[act]) { try { acts[act](); } catch (err) { actErrors.push(`${act}: ${err}`); } }
      for (let i = 0; i < n; i++) {
        // A slow constant look input, so the auto-centre and the orbit filter
        // are both exercised rather than sitting at their rest value.
        if (note.includes('camera swinging')) p.rig.addLook(0.012, 0);
        await frame();
        const cam = e.camera.position;
        const f0 = p.animator.foot[0], f1 = p.animator.foot[1];
        samples.push({
          t: e.time.elapsed,
          note,
          cam: [cam.x, cam.y, cam.z],
          pos: [p.position.x, p.position.y, p.position.z],
          speed: p.horizontalSpeed,
          dist: p.rig.collideRadius,
          state: p.state,
          fov: e.camera.fov,
          feet: [
            { p: f0.planted, l: f0.locked, x: f0.target.x, y: f0.target.y, z: f0.target.z },
            { p: f1.planted, l: f1.locked, x: f1.target.x, y: f1.target.y, z: f1.target.z },
          ],
          // Non-zero means the camera sphere is inside static geometry.
          inside: phys ? phys.overlapSphere(cam, 0.18, phys.MASK.WORLD) : 0,
          // The BODY, not the camera: this is what "never drops you inside
          // geometry" actually means after a vehicle exit.
          bodyInside: phys && !p.inVehicle
            ? phys.overlapCapsule(
              { x: p.position.x, y: p.position.y + 0.34, z: p.position.z },
              { x: p.position.x, y: p.position.y + 1.44, z: p.position.z },
              0.3, phys.MASK.CHARACTER
            ) : 0,
          nan: !Number.isFinite(cam.x + cam.y + cam.z + p.position.x),

          /* ---- gameplay channels ---- */
          view: p.rig.view,
          viewId: p.rig.viewId,
          near: +p.rig.nearBlend.toFixed(3),
          swim: p.swimming,
          submerged: p.submerged,
          breath: +p.breath.toFixed(3),
          depth: +(p.movement.waterDepth ?? 0).toFixed(3),
          hp: +p.health.value.toFixed(1),
          dead: p.dead,
          swinging: !!weapons?.rig && weapons.rig.swingT >= 0,
          swingT: weapons?.rig ? +Math.max(-1, weapons.rig.swingT).toFixed(4) : -1,
          arc: +(p.meleePhase ?? 0).toFixed(4),
          hand: (() => {
            const h = p.weaponHand;
            if (!h) return null;
            h.updateWorldMatrix(true, false);
            const el = h.matrixWorld.elements;
            return [+el[12].toFixed(4), +el[13].toFixed(4), +el[14].toFixed(4)];
          })(),
          inVehicle: p.inVehicle,
          vehSpeed: p.vehicle ? +(p.vehicle.speed ?? 0).toFixed(2) : null,
          /**
           * SIGNED, along the car's own nose. `speed` is `velocity.length()`,
           * so a car being driven BACKWARDS scores exactly as well as one
           * being driven forwards — which is how "the player cannot go
           * forwards" got past this harness and `tools/playprobe.mjs` at the
           * same time. Every driving assertion below reads this one.
           */
          vehFwd: p.vehicle ? +(p.vehicle.forwardSpeed ?? 0).toFixed(2) : null,
          impacts: impactCount,
          pedDamage,
          pedDist: window.__PED__ && window.__PED__.alive
            ? +window.__PED__.position.distanceTo(p.position).toFixed(2) : null,
        });
      }
    }
    p.movement.scriptedInput = null;
    offImpact();
    offDealt();
    return {
      samples, site: found, actErrors,
      melee: weapons?.melee?.stats ? { ...weapons.melee.stats } : null,
      playerMelee: p.meleeStats ? { ...p.meleeStats } : null,
      weapon: weapons?.current?.id ?? null,
      meleeWeapon: !!weapons?.current?.melee,
      swingSpec: weapons?.rig?.swingSpec ? { ...weapons.rig.swingSpec } : null,
      pedInReach: window.__PED__
        ? +window.__PED__.position.distanceTo(p.position).toFixed(2) : null,
      pedDamage: pedDamage,
      vehicleStats: p.vehicles?.stats ? { ...p.vehicles.stats } : null,
      jackTarget: window.__JACK__ ? {
        speedAtApproach: +(window.__JACKSPEED__ ?? 0).toFixed(2),
        driverNow: !!window.__JACK__.driver,
        driverIsPlayer: window.__JACK__.driver === p,
        type: window.__JACK__.spec?.id ?? null,
      } : null,
      /* Every brother's applied stats, straight off the live systems. */
      bankDistance: window.__BANK__ ?? null,
      brothers: (() => {
        const was = p.brother.id;
        const out = {};
        for (const id of ['carson', 'aidan', 'dylan']) {
          p.setBrother(id);
          out[id] = {
            maxHealth: p.health.max,
            maxArmour: p.health.maxArmour,
            sprintSpeed: +p.movement.sprintSpeed.toFixed(2),
            bodyScale: +p.movement.bodyScale.toFixed(3),
          };
        }
        p.setBrother(was);
        return out;
      })(),
    };
  }, SCRIPTS[SCRIPT] ?? SCRIPTS.run);
  const result = raw.samples;

  /* ------------------------------------------------------ analysis ---- */
  const rep = { script: SCRIPT, frames: result.length, site: raw.site };

  // 1. foot sliding ------------------------------------------------------
  // A frame in which the BODY itself teleported (a step-up, a depenetration
  // push, a streamed collider appearing under it) drags every planted foot with
  // it. That is a physics/world event, not a foot-IK failure, so it is reported
  // separately instead of being laundered into the sliding number.
  const bodyStep = [0];
  for (let i = 1; i < result.length; i++) {
    const a0 = result[i - 1].pos, b0 = result[i].pos;
    bodyStep.push(Math.hypot(b0[0] - a0[0], b0[1] - a0[1], b0[2] - a0[2]));
  }
  const TELEPORT = 0.12; // metres in one frame — 7 m/s at 60 fps

  let worstStep = 0, worstStepAt = -1, worstContact = 0, contacts = 0;
  let teleFrames = 0, cleanSamples = 0, sumDrift = 0;
  for (let f = 0; f < 2; f++) {
    let prev = null, acc = 0;
    for (let i = 0; i < result.length; i++) {
      const s = result[i].feet[f];
      if (!s.p) {
        if (prev) { if (acc > worstContact) worstContact = acc; contacts++; }
        prev = null; acc = 0;
        continue;
      }
      if (prev) {
        const d = Math.hypot(s.x - prev.x, s.y - prev.y, s.z - prev.z);
        if (bodyStep[i] > TELEPORT) {
          if (f === 0) teleFrames++;
        } else {
          acc += d;
          cleanSamples++;
          sumDrift += d;
          if (d > worstStep) { worstStep = d; worstStepAt = i; }
        }
      }
      prev = s;
    }
  }
  // Same measurement again, restricted to the dead-static window.
  let lockWorst = 0, lockSum = 0, lockN = 0;
  for (let f = 0; f < 2; f++) {
    let prev = null;
    for (let i = 0; i < result.length; i++) {
      const s = result[i].feet[f];
      if (!s.l) { prev = null; continue; }
      if (prev && bodyStep[i] <= TELEPORT) {
        const d = Math.hypot(s.x - prev.x, s.y - prev.y, s.z - prev.z);
        lockSum += d; lockN++;
        if (d > lockWorst) lockWorst = d;
      }
      prev = s;
    }
  }

  rep.foot = {
    contacts,
    lockedMeanDriftMm: +((lockSum / Math.max(1, lockN)) * 1000).toFixed(2),
    lockedWorstDriftMm: +(lockWorst * 1000).toFixed(2),
    /** Mean and worst per-frame movement of a foot the animator calls planted. */
    meanDriftMm: +((sumDrift / Math.max(1, cleanSamples)) * 1000).toFixed(2),
    worstFrameDriftMm: +(worstStep * 1000).toFixed(2),
    worstFrameAt: worstStepAt,
    worstContactDriftMm: +(worstContact * 1000).toFixed(2),
    bodyTeleportFrames: teleFrames,
    maxBodyStepMm: +(Math.max(...bodyStep) * 1000).toFixed(0),
  };

  // 2. camera continuity --------------------------------------------------
  const jerks = [];
  let maxSpeed = 0, maxAccel = 0;
  for (let i = 2; i < result.length; i++) {
    const a = result[i - 2].cam, b = result[i - 1].cam, c = result[i].cam;
    const dt1 = result[i - 1].t - result[i - 2].t || 1 / 60;
    const dt2 = result[i].t - result[i - 1].t || 1 / 60;
    // The headless harness occasionally presents two frames a fraction of a
    // millisecond apart; dividing by that dt manufactures an acceleration
    // spike that has nothing to do with the camera. Skip those samples.
    if (dt1 < 0.004 || dt2 < 0.004 || dt1 > 0.05 || dt2 > 0.05) continue;
    const v1 = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / dt1;
    const v2 = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]) / dt2;
    const acc = Math.abs(v2 - v1) / dt2;
    if (v2 > maxSpeed) maxSpeed = v2;
    if (acc > maxAccel) maxAccel = acc;
    if (acc > 260) jerks.push({ frame: i, accel: +acc.toFixed(0), note: result[i].note });
  }
  rep.camera = {
    maxSpeed: +maxSpeed.toFixed(2),
    maxAccel: +maxAccel.toFixed(0),
    discontinuities: jerks.slice(0, 6),
    penetratedFrames: result.filter((s) => s.inside > 0).length,
    nanFrames: result.filter((s) => s.nan).length,
    fovRange: [
      +Math.min(...result.map((s) => s.fov)).toFixed(1),
      +Math.max(...result.map((s) => s.fov)).toFixed(1),
    ],
    distRange: [
      +Math.min(...result.map((s) => s.dist)).toFixed(2),
      +Math.max(...result.map((s) => s.dist)).toFixed(2),
    ],
  };

  // 3. settle after the sprint is released --------------------------------
  const rel = result.findIndex((s) => s.note.startsWith('release'));
  if (rel > 0) {
    const win = result.slice(rel, rel + 70).map((s) => s.dist);
    let signs = 0, prevD = 0;
    for (let i = 1; i < win.length; i++) {
      const d = win[i] - win[i - 1];
      if (Math.abs(d) < 1e-4) continue;
      if (prevD !== 0 && Math.sign(d) !== Math.sign(prevD)) signs++;
      prevD = d;
    }
    rep.settle = {
      reversals: signs,
      from: +win[0].toFixed(3),
      to: +win[win.length - 1].toFixed(3),
      verdict: signs <= 2 ? 'settles' : 'OSCILLATES',
    };
    // how long the body takes to actually stop
    const stopAt = result.slice(rel).findIndex((s) => s.speed < 0.3);
    rep.hardStopSeconds = stopAt > 0 ? +(result[rel + stopAt].t - result[rel].t).toFixed(2) : null;
  }

  /* ---------------------------------------------------- gameplay ------ */
  const at = (i) => result[Math.max(0, Math.min(result.length - 1, i))];

  /**
   * dt-ROBUST CONTINUITY.
   *
   * The headless harness presents frames anywhere from 4 to 50 ms apart, and
   * differentiating a position series twice against a jittering dt manufactures
   * acceleration out of nothing: a filter that is perfectly dt-correct still
   * moves 5.5 % of its gap in a 4 ms frame, which on a 4 m gap reads as 55 m/s
   * against a neighbouring 16 ms frame's 14 m/s. That artefact is invisible on
   * the locomotion scripts because no channel there moves metres in half a
   * second, and it dominates any script that deliberately dollies the boom.
   *
   * So resample the path onto a uniform 60 Hz timeline first, THEN differentiate.
   * What survives is the camera's real acceleration.
   */
  const resampledAccel = (rows) => {
    if (rows.length < 8) return { maxSpeed: 0, maxAccel: 0 };
    const t0 = rows[0].t, t1 = rows[rows.length - 1].t;
    const h = 1 / 60;
    const n = Math.floor((t1 - t0) / h);
    if (n < 6) return { maxSpeed: 0, maxAccel: 0 };
    const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = t0 + i * h;
      while (j < rows.length - 2 && rows[j + 1].t < t) j++;
      const a = rows[j], b = rows[j + 1] ?? rows[j];
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      px[i] = a.cam[0] + (b.cam[0] - a.cam[0]) * u;
      py[i] = a.cam[1] + (b.cam[1] - a.cam[1]) * u;
      pz[i] = a.cam[2] + (b.cam[2] - a.cam[2]) * u;
    }
    let maxSpeed = 0, maxAccel = 0;
    for (let i = 2; i < n; i++) {
      const v1 = Math.hypot(px[i - 1] - px[i - 2], py[i - 1] - py[i - 2], pz[i - 1] - pz[i - 2]) / h;
      const v2 = Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1], pz[i] - pz[i - 1]) / h;
      if (v2 > maxSpeed) maxSpeed = v2;
      const acc = Math.abs(v2 - v1) / h;
      if (acc > maxAccel) maxAccel = acc;
    }
    return { maxSpeed: +maxSpeed.toFixed(2), maxAccel: +maxAccel.toFixed(0) };
  };
  rep.camera.resampled60Hz = resampledAccel(result);

  if (SCRIPT === 'views') {
    // One row per view: the boom length it settles at, and whether the fourth
    // view actually arrived at the head.
    const byView = [];
    for (let v = 0; v < 4; v++) {
      const win = result.filter((s) => s.view === v);
      if (!win.length) continue;
      const tail = win.slice(Math.floor(win.length * 0.6));
      byView.push({
        view: v,
        id: tail[0].viewId,
        boom: +(tail.reduce((a, s) => a + s.dist, 0) / tail.length).toFixed(3),
        near: +(tail[tail.length - 1].near).toFixed(3),
        fov: +tail[tail.length - 1].fov.toFixed(1),
      });
    }
    const dists = byView.map((b) => b.boom);
    rep.views = {
      seen: byView,
      // Four views that all sit at the same boom length are not four views.
      distinct: new Set(dists.map((d) => d.toFixed(2))).size,
      spread: dists.length ? +(Math.max(...dists) - Math.min(...dists)).toFixed(2) : 0,
      firstPersonReached: byView.some((b) => b.id === 'near' && b.near > 0.9),
      returnedToChase: byView.length > 0 && result[result.length - 1].view === 1,
      verdict: byView.length === 4 && new Set(dists.map((d) => d.toFixed(2))).size === 4
        ? 'four distinct views' : 'VIEWS NOT DISTINCT',
    };
  }

  if (SCRIPT === 'melee') {
    const swings = [];
    let i = 0;
    while (i < result.length) {
      if (!result[i].swinging) { i++; continue; }
      const start = i;
      while (i < result.length && result[i].swinging) i++;
      swings.push([start, i]);
    }
    const spec = raw.swingSpec;
    const contactFrac = spec ? (spec.contact ?? 0.5) : 0.5;
    const detail = swings.map(([a, b]) => {
      /* Differentiate against the SWING clock, not wall time. `swingT` and the
       * hand both advance by the same engine dt, so the ratio is immune to the
       * harness's frame-timing jitter — dividing by wall dt reported the same
       * swing at 29 and at 139 m/s on consecutive runs. */
      let peakSpeed = 0, peakAtT = 0, minArc = 1, maxArc = -1, path = 0;
      const dur = Math.max(1e-4, at(b - 1).swingT);
      for (let k = a + 1; k < b; k++) {
        const h0 = at(k - 1).hand, h1 = at(k).hand;
        const ds = at(k).swingT - at(k - 1).swingT;
        if (h0 && h1) {
          const d = Math.hypot(h1[0] - h0[0], h1[1] - h0[1], h1[2] - h0[2]);
          path += d;
          if (ds > 1e-4) {
            const v = d / ds;
            if (v > peakSpeed) { peakSpeed = v; peakAtT = at(k).swingT; }
          }
        }
        minArc = Math.min(minArc, at(k).arc);
        maxArc = Math.max(maxArc, at(k).arc);
      }
      const n = Math.max(1, b - a);
      return {
        frames: n,
        // Where the hand is fastest, as a fraction of the swing. The weapon's
        // own contact frame is `swing.contact`; a body that peaks well after it
        // is following the weapon rather than driving it.
        peakHandSpeed: +peakSpeed.toFixed(2),
        handPathMetres: +path.toFixed(2),
        peakAtFraction: +(peakAtT / dur).toFixed(2),
        contactFraction: +contactFrac.toFixed(2),
        // Wind-up must be negative and follow-through positive, or the body is
        // not counter-rotating at all.
        arcRange: [+minArc.toFixed(2), +maxArc.toFixed(2)],
        impacts: at(b - 1).impacts - at(a).impacts,
        damageDealt: +(at(b - 1).pedDamage - at(a).pedDamage).toFixed(1),
        targetDistance: at(a).pedDist,
      };
    });
    rep.melee = {
      weapon: raw.weapon,
      isMeleeWeapon: raw.meleeWeapon,
      swings: detail.length,
      solverStats: raw.melee,
      playerReach: raw.playerMelee,
      detail,
      windsUp: detail.every((d) => d.arcRange[0] < -0.5),
      followsThrough: detail.every((d) => d.arcRange[1] > 0.5),
      peakNearContact: detail.every((d) => Math.abs(d.peakAtFraction - d.contactFraction) < 0.3),
      connected: (raw.melee?.hits ?? 0) > 0
        || (raw.playerMelee?.fallbackHits ?? 0) > 0
        || detail.some((d) => d.impacts > 0),
      pedDamage: raw.pedDamage ?? 0,
      verdict: detail.length >= 3 &&
        detail.every((d) => d.arcRange[0] < -0.5 && d.arcRange[1] > 0.5)
        ? 'body commits to the swing' : 'NO BODY ARC',
    };
  }

  if (SCRIPT === 'swim' || SCRIPT === 'drown') {
    const swam = result.filter((s) => s.swim);
    const floatWin = swam.slice(20, 90).filter((s) => !s.submerged);
    const meanFloat = floatWin.length
      ? floatWin.reduce((a, s) => a + s.depth, 0) / floatWin.length : null;
    const strokeWin = result.filter((s) => s.swim && s.note.startsWith('swim forward'));
    const diveWin = result.filter((s) => s.note.startsWith('dive'));
    rep.swim = {
      enteredWater: swam.length > 0,
      framesSwimming: swam.length,
      // Metres of BODY under the surface while treading. Around 1.3 keeps the
      // head and shoulders out; near 0 is the old bug where he stood on it.
      floatDepth: meanFloat === null ? null : +meanFloat.toFixed(2),
      headOut: meanFloat !== null && meanFloat > 0.9 && meanFloat < 1.7,
      strokeSpeed: strokeWin.length
        ? +(strokeWin.slice(-30).reduce((a, s) => a + s.speed, 0) / Math.min(30, strokeWin.length)).toFixed(2)
        : null,
      dived: diveWin.some((s) => s.submerged),
      maxDepth: swam.length ? +Math.max(...swam.map((s) => s.depth)).toFixed(2) : null,
      breathRange: [
        +Math.min(...result.map((s) => s.breath)).toFixed(2),
        +Math.max(...result.map((s) => s.breath)).toFixed(2),
      ],
      recovered: result[result.length - 1].breath > result[Math.floor(result.length * 0.75)].breath - 1e-6,
      bankDistance: raw.bankDistance ?? null,
      climbedOut: !result[result.length - 1].swim && swam.length > 0,
      endedGrounded: result[result.length - 1].state !== 'swim'
        && result[result.length - 1].state !== 'fall',
      endState: result[result.length - 1].state,
      // `game` respawns on death, so the LAST sample is alive again; the
      // evidence that drowning kills is that a frame in between was not.
      drowned: result.some((s) => s.dead),
      minHp: +Math.min(...result.map((s) => s.hp)).toFixed(1),
      hpLost: +(result[0].hp - Math.min(...result.map((s) => s.hp))).toFixed(1),
      firstDrownFrame: (() => {
        const i0 = result.findIndex((s) => s.breath <= 0);
        return i0 < 0 ? null : i0;
      })(),
    };
  }

  if (SCRIPT === 'jack') {
    const inVeh = result.filter((s) => s.inVehicle);
    rep.jack = {
      target: raw.jackTarget,
      stats: raw.vehicleStats,
      // The whole point: the car was moving when the player walked up to it.
      approachedMoving: (raw.jackTarget?.speedAtApproach ?? 0) > 0.5,
      pulledSomeoneOut: (raw.vehicleStats?.jacks ?? 0) > 0,
      gotIn: inVeh.length > 0,
      nowDriving: raw.jackTarget?.driverIsPlayer === true,
      droveAway: inVeh.some((s) => (s.vehFwd ?? 0) > 2),
      framesInVehicle: inVeh.length,
    };
  }

  if (SCRIPT === 'car') {
    const inVeh = result.filter((s) => s.inVehicle);
    const enterAt = result.findIndex((s) => s.inVehicle);
    const exitAt = result.length - 1 - [...result].reverse().findIndex((s) => s.inVehicle);
    const after = result.slice(Math.min(result.length - 1, exitAt + 20));
    rep.car = {
      entered: inVeh.length > 0,
      framesInVehicle: inVeh.length,
      enteredAtFrame: enterAt < 0 ? null : enterAt,
      // FORWARDS. See `vehFwd` in the snapshot above.
      drove: inVeh.some((s) => (s.vehFwd ?? 0) > 1.5),
      topSpeed: inVeh.length ? +Math.max(...inVeh.map((s) => s.vehFwd ?? 0)).toFixed(2) : null,
      worstReverse: inVeh.length ? +Math.min(...inVeh.map((s) => s.vehFwd ?? 0)).toFixed(2) : null,
      exited: inVeh.length > 0 && !result[result.length - 1].inVehicle,
      // The whole point of the exit rewrite: never leave the player in a wall.
      exitCameraInsideGeometry: after.filter((s) => s.inside > 0).length,
      exitBodyInsideGeometry: after.filter((s) => s.bodyInside > 0).length,
      stats: raw.vehicleStats,
      lastState: result[result.length - 1].state,
    };
  }
  rep.actErrors = raw.actErrors ?? [];
  rep.brothers = raw.brothers ?? null;

  // 4. states seen --------------------------------------------------------
  rep.states = [...new Set(result.map((s) => s.state))];
  rep.travelled = +Math.hypot(
    result[result.length - 1].pos[0] - result[0].pos[0],
    result[result.length - 1].pos[2] - result[0].pos[2]
  ).toFixed(2);
  rep.errors = errs.slice(0, 6);

  console.log(JSON.stringify(rep, null, 2));
} catch (e) {
  failed = e;
} finally {
  if (failed) console.error(errs.slice(-20).join('\n'));
  await browser.close();
  if (server) server.kill();
}
if (failed) {
  console.error(JSON.stringify({ ok: false, error: failed.message }));
  process.exit(1);
}
