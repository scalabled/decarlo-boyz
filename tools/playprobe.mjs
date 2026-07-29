#!/usr/bin/env node
/**
 * PLAYABILITY PROBE — does the game actually respond like a game?
 *
 * The critic harness reviews still frames. It cannot tell you that F does
 * nothing, that the car has no fuel gauge, or that standing in a safehouse
 * never saves. This drives the build the way a player does and reports, per
 * interaction, whether it produced an observable effect.
 *
 * The interaction set:
 *   F  enter / exit / carjack / swap vehicle / sleep at a safehouse
 *   E/Q cycle weapon      V camera      R radio      H horn      M map
 *   Space jump            Shift sprint
 * plus: fuel + gas stations, the body shop repairing, the respray clearing
 * heat, safehouses healing and autosaving, and walk-over pickups.
 *
 *   npm run build && node tools/playprobe.mjs
 */
import { chromium } from 'playwright';
import { startServer } from './lib/server.mjs';

const { port, server } = await startServer({});
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });

const results = [];
const rec = (area, name, ok, detail) => results.push({ area, name, ok, detail });

/** Pump n animation frames in the page. */
const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

const snap = () =>
  page.evaluate(() => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const veh = e.ctx.peek('vehicles');
    const game = e.ctx.peek('game');
    const police = e.ctx.peek('police');
    const p = pl?.position;
    const v = pl?.vehicle ?? pl?.currentVehicle ?? null;
    return {
      pos: p ? [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)] : null,
      inVehicle: !!v,
      vehType: v?.spec?.id ?? null,
      vehSpeed: v ? +(v.speed ?? 0).toFixed(2) : null,
      vehFwd: v ? +(v.forwardSpeed ?? v.speed ?? 0).toFixed(2) : null,
      vehFuel: v ? (v.fuel ?? null) : null,
      vehHealth: v ? +(v.health ?? 0).toFixed(0) : null,
      health: typeof pl?.health === 'number' ? +pl.health.toFixed(0) : (typeof pl?.health?.hp === 'number' ? +pl.health.hp.toFixed(0) : null),
      wanted: police?.level ?? null,
      money: game?.cash ?? game?.money ?? null,
      weapon: e.ctx.peek('weapons')?.current?.id ?? e.ctx.peek('weapons')?.activeId ?? null,
      prompt: document.querySelector('.ow-prompt, [class*="prompt"]')?.textContent?.trim()?.slice(0, 60) || null,
      nearestVehDist: (() => {
        if (!veh?.nearest || !p) return null;
        const n = veh.nearest(p.x, p.y, p.z, 150);
        return n ? +n.position.distanceTo(p).toFixed(2) : null;
      })(),

      /*
       * GEOMETRY OF THE DRIVING RIG.
       *
       * Everything above this point measures THE CAR, and the car was never the
       * problem. The driver sat on the roof, facing backwards, able to drive
       * only in reverse — and this probe scored 20/20 straight through all
       * three, because a correctly-behaving car is exactly what it checks.
       * The chase camera had been solved 180 degrees out, so holding W drove the
       * car AT the lens and the world scrolled the wrong way; forwardSpeed was
       * +5.9 m/s the whole time.
       *
       * So: measure the RELATIONSHIPS, not just the car. Convention, stated once
       * because a sign error here is what caused the bug — a vehicle's nose is
       * +Z (dynamics.js takes forwardSpeed along +Z), while a camera's own basis
       * is -Z. They are not interchangeable.
       *
       * Anything unmeasurable returns null, and the caller REPORTS that rather
       * than passing. A check that silently skips is how this got shipped.
       */
      rig: (() => {
        try {
          if (!v) return null;
          const carPos = v.position, carQ = v.quaternion;
          if (!carPos || !carQ) return { err: 'vehicle has no position/quaternion' };

          // Rotate +Z by a quaternion, by hand. THREE is not exposed on window
          // and this probe must not need it — a rig check that cannot run is a
          // rig check that silently stops catching the bug it exists for.
          const zAxis = (q) => {
            const { x, y, z, w } = q;
            return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
          };
          const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

          const nose = zAxis(carQ);
          const cam = e.camera;
          const out = {};

          // Camera must sit BEHIND the nose. car->camera dotted with the nose is
          // negative when the camera trails the car, +1 when it is parked in
          // front of the windscreen looking back, which is the defect.
          if (cam?.position) {
            const d = [cam.position.x - carPos.x, cam.position.y - carPos.y, cam.position.z - carPos.z];
            const len = Math.hypot(d[0], d[1], d[2]);
            out.camDist = +len.toFixed(2);
            if (len > 1e-3) out.camDotNose = +(dot([d[0] / len, d[1] / len, d[2] / len], nose)).toFixed(3);
          }

          // The body must face the same way as the car, not the opposite way.
          //
          // THE TWO CONVENTIONS ARE OPPOSITE, and this is the exact confusion
          // that put the driver in backwards in the first place. The car's nose
          // is +Z. The ACTOR's forward is -Z: animator.js builds the root
          // quaternion straight from faceYaw about Y (line 183) but derives its
          // forward as (-sin yaw, 0, -cos yaw) (line 185), so at faceYaw 0 the
          // root's +Z points at the actor's BACK.
          //
          // So the body's forward is the NEGATED z-axis of its quaternion.
          // Comparing raw z-axes reads a correctly seated driver as 169 degrees
          // out, which is an easy way to file an already-fixed seat as a
          // regression.
          const actor = pl?.actor ?? pl?.body ?? pl?.character ?? null;
          const bodyQ = actor?.quaternion ?? actor?.root?.quaternion ?? null;
          if (bodyQ) {
            const bz = zAxis(bodyQ);
            const bd = dot([-bz[0], -bz[1], -bz[2]], nose);
            out.bodyDotNose = +bd.toFixed(3);
            out.bodyYawErrDeg = +((Math.acos(Math.max(-1, Math.min(1, bd))) * 180) / Math.PI).toFixed(1);
          }

          // The body ROOT must sit below the seat, not on top of the car. The
          // seat anchor publishes where the HEAD goes; copying it into the root
          // lifts the whole body by a head height and puts the driver on the
          // roof.
          const rootPos = actor?.position ?? actor?.root?.position ?? null;
          if (rootPos && typeof veh?.seatAnchor === 'function') {
            const seat = veh.seatAnchor(v);
            if (seat) out.rootMinusSeatY = +(rootPos.y - (seat.y ?? seat.position?.y ?? 0)).toFixed(3);
          }
          if (rootPos) out.rootAboveCarY = +(rootPos.y - carPos.y).toFixed(3);

          // Drivetrain state, so "the car did not move" is a diagnosis rather
          // than an observation. Gear 0 is reverse, 1 is neutral, 2 is first.
          const dt = v.drivetrain ?? v.dt ?? null;
          if (dt) {
            out.gear = dt.gearLabel ?? dt.gear;
            out.rpm = typeof dt.rpm === 'number' ? +dt.rpm.toFixed(0) : null;
            out.clutch = typeof dt.clutch === 'number' ? +dt.clutch.toFixed(2) : null;
          }
          // RESOLVED PEDALS LIVE ON `v.control`, SINGULAR.
          //
          // This used to read `v[k] ?? v.controls?.[k] ?? v.input?.[k]`. A
          // Vehicle has no `v.brake` and no `v.controls`, so every reading fell
          // through to `v.input` — the raw KEY state. That reads as a brake
          // pinned at 1 while reversing, and diagnoses the car as braking
          // against itself. It is not: `control.brake` is 0.00 throughout, and
          // what was being read was "the S key is held", which it obviously
          // was. Same family as the `w.contact` truthiness bug.
          //
          // Keep both, clearly labelled — `input` is what the player asked for,
          // `control` is what the drivetrain resolved, and the gap between them
          // is exactly where control bugs live.
          for (const k of ['throttle', 'brake', 'handbrake', 'steer']) {
            const c = v.control?.[k];
            if (typeof c === 'number') out[k] = +c.toFixed(2);
            const i = v.input?.[k];
            if (typeof i === 'number') out['in_' + k] = +i.toFixed(2);
          }
          out.grounded = v.grounded ?? v.onGround ?? null;
          // `w.contact` is a PREALLOCATED Vector3, so it is always truthy — the
          // old `w.grounded || w.contact` counted 4 wheels down on a car lying
          // on its side with nothing touching the road. Both frozen-car samples
          // in the stuck-car investigation reported `wheelsDown 4` and neither
          // reading meant anything. Only `grounded` is the real field.
          out.wheelsDown = Array.isArray(v.wheels)
            ? v.wheels.filter((w) => w?.grounded === true || w?.grounded > 0).length
            : null;

          // Is the car the right way up? A probe that grades a vehicle lying on
          // its side is reporting the roll, not the drivetrain.
          const up = [2 * (carQ.x * carQ.y - carQ.w * carQ.z), 1 - 2 * (carQ.x * carQ.x + carQ.z * carQ.z), 2 * (carQ.y * carQ.z + carQ.w * carQ.x)];
          out.upDot = +up[1].toFixed(3);

          // Did the probe actually get into the car it spawned? `player`'s
          // entry scan takes the NEAREST vehicle, which on one run was an
          // overturned truck parked beside the test car.
          out.isProbeCar = v._probeCar === true;

          /*
           * WHAT THE CAR IS ACTUALLY STANDING ON — and a dead check, found the
           * same way as the `w.contact` one above.
           *
           * This used to be `v.surface ?? v.groundSurface ?? null`. A Vehicle
           * has NEITHER property, so it read `null` on every run this probe has
           * ever made, and the guard built on it —
           *
           *     'still on drivable ground', ... rig.surface !== 'water'
           *
           * — was `null !== 'water'`, which is true forever. It has never once
           * been able to fire. MEASURED behind it: the W phase drives blind for
           * up to 400 frames down whatever heading the lane had at the spawn,
           * and on some sites that ends in the Allegheny — a run captured with
           * `inWater: true, submerged 0.59` scored "still on drivable ground:
           * PASS" and then reported the buoyancy as a drivetrain failure
           * (`rpm 6319, throttle 1, gear 1, wheelsDown 0, fwd 1.03`). That is
           * ARCHITECTURE.md rule 12 in its purest form: a guard that reports a
           * guarantee it never checked.
           *
           * So take it off the EMITTED contacts — the surface tag each grounded
           * wheel wrote from the triangle it is actually touching — plus the
           * vehicle's own water state, which is what buoyancy is computed from.
           * `air` when nothing is touching, never `null`: unmeasurable is a
           * result, not a skip.
           */
          out.inWater = v.inWater === true || (v.submerged ?? 0) > 0.15;
          const tally = {};
          if (Array.isArray(v.wheels)) {
            for (const w of v.wheels) {
              if (w?.grounded !== true || !w.surface) continue;
              tally[w.surface] = (tally[w.surface] ?? 0) + 1;
            }
          }
          let top = null, topN = 0;
          for (const k in tally) if (tally[k] > topN) { topN = tally[k]; top = k; }
          out.surface = out.inWater ? 'water' : (top ?? 'air');
          // Paved: carriageway, footway, and a bridge deck (`world` tags its
          // bridge collider `metal`). Anything else — dirt, grass, sand, water,
          // or nothing at all — means the test car has left the road network,
          // and the drive phase stops there rather than grading a river bank as
          // a gearbox.
          out.onRoad = out.surface === 'asphalt' || out.surface === 'sidewalk' ||
            out.surface === 'concrete' || out.surface === 'metal';

          return out;
        } catch (err) {
          return { err: String(err && err.message ? err.message : err) };
        }
      })(),
    };
  });

const key = async (code, ms = 90) => { await page.keyboard.down(code); await pump(4); await page.keyboard.up(code); await pump(Math.max(2, ms / 16 | 0)); };
const hold = async (code, frames) => { await page.keyboard.down(code); await pump(frames); await page.keyboard.up(code); await pump(4); };

/**
 * Hold a key until the world satisfies `pred`, or the budget runs out.
 *
 * A FIXED frame count is not a test, it is a race. Holding S for 110 frames
 * scored 24/24, 23/24 and 22/24 on three consecutive runs of an unchanged
 * build: entry speed varies run to run (10.4, 10.7, 13.7 m/s — the car enters
 * in gear 1, 2 or 3 depending on where the sim happens to be), and braking from
 * 13.7 simply needs longer than braking from 10.4. The car was correct every
 * time; the probe was reporting its own timing jitter as a game defect.
 *
 * A flaky gate is worse than no gate, because the first thing anyone does with
 * one is learn to ignore it.
 */
const holdUntil = async (code, pred, { maxFrames = 900, chunk = 20 } = {}) => {
  await page.keyboard.down(code);
  let s = await snap();
  let f = 0;
  while (f < maxFrames && !pred(s)) { await pump(chunk); f += chunk; s = await snap(); }
  await page.keyboard.up(code);
  await pump(4);
  return { ...s, _frames: f, _settled: pred(s) };
};

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  await pump(120);

  // Give the player control (capture mode / menus can freeze input).
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.input.enabled = true; e.input.frozen = false;
    e.ctx.peek('player')?.setControlEnabled?.(true);
  });
  await pump(30);

  const start = await snap();
  rec('boot', 'player exists with a position', !!start.pos, JSON.stringify(start.pos));
  rec('boot', 'player has health', start.health != null, `hp ${start.health}`);

  // ---- locomotion ----
  await hold('KeyW', 60);
  const walked = await snap();
  const dWalk = start.pos && walked.pos ? Math.hypot(walked.pos[0] - start.pos[0], walked.pos[2] - start.pos[2]) : 0;
  rec('move', 'W walks', dWalk > 1.0, `${dWalk.toFixed(2)} m`);

  const beforeSprint = await snap();
  await page.keyboard.down('ShiftLeft');
  await hold('KeyW', 60);
  await page.keyboard.up('ShiftLeft');
  const sprinted = await snap();
  const dSprint = Math.hypot(sprinted.pos[0] - beforeSprint.pos[0], sprinted.pos[2] - beforeSprint.pos[2]);
  rec('move', 'Shift sprints faster than walk', dSprint > dWalk * 1.15, `walk ${dWalk.toFixed(2)} vs sprint ${dSprint.toFixed(2)} m`);

  const preJump = (await snap()).pos[1];
  await key('Space');
  // Sample the PEAK of the arc, not a snapshot at one arbitrary frame. Reading
  // height exactly 8 frames after the keypress lands wherever the apex happens
  // to fall on that run: measured +0.15 m against a `> 0.15` threshold, so an
  // unchanged build passed or failed on frame-timing noise alone. Same class of
  // mistake as timing the brake test by a fixed frame count — see `holdUntil`.
  let peak = preJump;
  for (let i = 0; i < 12; i++) {
    await pump(4);
    peak = Math.max(peak, (await snap()).pos[1]);
  }
  await pump(40);
  rec('move', 'Space jumps', peak - preJump > 0.15, `peak +${(peak - preJump).toFixed(2)} m`);

  // ---- vehicle entry ----
  const near = await snap();
  rec('vehicle', 'traffic is present near the player', near.nearestVehDist != null, near.nearestVehDist != null ? `nearest ${near.nearestVehDist} m` : 'none within 150 m — city is empty');

  // Spawn a DEDICATED test car on a real lane rather than borrowing ambient traffic.
  //
  // This used to teleport to `vehicles.nearest(...)`. That was only ever reliable
  // because `traffic` had a scratch-vector aliasing bug that spawned every car AT
  // THE CAMERA — so there was always one within arm's reach. With that fixed
  // (correctly), the probe started reporting "no vehicle within 30 m", and when
  // it did find one it was often a PARKED car wedged against the kerb, which
  // reads as "W does not drive". Both were the harness depending on a bug.
  //
  // Placing the car on a lane centre from the road graph makes the drive and
  // brake tests deterministic and measures the thing they are named for.
  const moved = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const veh = e.ctx.peek('vehicles');
    const w = e.ctx.peek('world');
    const p = pl.position;

    let spot = null;
    let yaw = 0;
    const roads = w?.roads;
    if (roads?.nearestEdge && roads.laneCenter) {
      const hit = roads.nearestEdge(p.x, p.z, 300);
      if (hit?.edge != null) {
        const V = Object.getPrototypeOf(p).constructor;
        const id = hit.edge.id ?? hit.edge, lane = hit.lane ?? 0;
        const t0 = Math.min(0.88, (hit.t ?? 0.5) + 0.02);
        const a = new V(), bAhead = new V();
        roads.laneCenter(id, lane, t0, a);
        // ALIGN THE CAR WITH THE ROAD.
        //
        // This spawned on a lane centre but at yaw 0 — the lane's direction was
        // never asked for. So the test car pointed wherever world +Z happened to
        // be: sometimes down the street, sometimes at a kerb or a wall. That is
        // the whole of the intermittent "W does not drive the car, 0.02 m/s"
        // failure, on four runs of an identical build — the car was faithfully
        // driving into a building. Sample a second point further along the lane
        // and face the car down it.
        //
        // A vehicle's nose is +Z, so a heading d needs yaw = atan2(d.x, d.z).
        roads.laneCenter(id, lane, Math.min(0.96, t0 + 0.06), bAhead);
        const dx = bAhead.x - a.x, dz = bAhead.z - a.z;
        if (Math.hypot(dx, dz) > 0.05) yaw = Math.atan2(dx, dz);
        if (Number.isFinite(a.x)) spot = a;
      }
    }
    if (!spot) return null;

    // CLEAR THE TEST SITE FIRST.
    //
    // `player`'s entry scan takes the NEAREST vehicle, not the probe's — so on
    // a site with ambient traffic the probe can spawn a clean sedan, walk past
    // it, and grade whatever happened to be parked closer. Measured once: it
    // entered a truck lying on its side (roll ~110 degrees) and scored "W does
    // not drive the car". Three of the residual failures in a 10-run sample
    // were the probe grading the wrong car, a car straddling a kerb, or a car
    // in the river.
    //
    // A gate has to own its test conditions, or its failures are noise that has
    // to be re-diagnosed every time.
    const near = [];
    for (const other of veh?.active ?? veh?.vehicles ?? []) {
      if (!other?.position) continue;
      const dx = other.position.x - spot.x, dz = other.position.z - spot.z;
      if (dx * dx + dz * dz < 26 * 26) near.push(other);
    }
    for (const other of near) veh?.despawn?.(other);

    const car = veh?.spawn?.('sedan', { x: spot.x, y: spot.y + 0.6, z: spot.z }, yaw, {});
    if (!car) return null;
    car._probeCar = true;
    // Stand the player beside the car, offset ACROSS the road (right of the
    // car's nose) so they are on the verge rather than in the lane ahead of it.
    pl.teleport?.(
      { x: spot.x + Math.cos(yaw) * 2.4, y: spot.y + 1.0, z: spot.z - Math.sin(yaw) * 2.4 },
      { x: 0, y: 0, z: 0 }
    );
    return [+spot.x.toFixed(1), +spot.z.toFixed(1), +((yaw * 180) / Math.PI).toFixed(0)];
  });
  await pump(40);
  const atCar = await snap();
  rec('vehicle', 'walking up to a car shows a prompt', !!atCar.prompt, atCar.prompt ?? 'no prompt element found');

  await hold('KeyF', 10);
  await pump(150);
  const entered = await snap();
  rec('vehicle', 'F enters the vehicle', entered.inVehicle, entered.inVehicle ? `in ${entered.vehType}` : 'still on foot');

  if (entered.inVehicle) {
    // Grade the test, not the site. Each of these was a real false failure in a
    // measured 10-run sample, and each one produces a wrong diagnosis.
    rec('vehicle', 'entered THE test car, not a bystander',
      entered.rig?.isProbeCar !== false,
      entered.rig?.isProbeCar === false ? `entered some other ${entered.vehType} — site not clear` : 'ok');
    rec('vehicle', 'the test car is upright and on the road',
      (entered.rig?.upDot ?? 1) > 0.85 && (entered.rig?.wheelsDown ?? 4) >= 3,
      `up ${entered.rig?.upDot}, wheels down ${entered.rig?.wheelsDown}/4${entered.rig?.surface ? `, on ${entered.rig.surface}` : ''}`);

    /*
     * STOP AT THE KERB, not 400 frames later.
     *
     * The car is aimed down its lane and then W is held with no steering, so it
     * travels in a straight line while the lane curves: on a long enough hold
     * it leaves the carriageway, crosses the verge and — measured, repeatedly —
     * ends up floating in the river with the engine on the limiter. Everything
     * graded after that is a measurement of buoyancy.
     *
     * The `rig.onRoad` term ends the drive phase the moment the contact patches
     * stop reporting tarmac, which is the verge, a good 20-30 m before the
     * water. The brake test then runs from wherever the car legitimately got
     * to, on ground a car can be on.
     */
    const driving = await holdUntil('KeyW', (s) => (s.vehFwd ?? 0) > 8 || s.rig?.onRoad === false, { maxFrames: 400 });
    // SIGNED, always. `vehSpeed` is velocity.length() — unsigned — so a car
    // being driven backwards at 4 m/s scored 4.0 and passed. That single word
    // is why this probe scored 20/20 on a build where the player could only
    // travel in reverse.
    rec('vehicle', 'W drives the car FORWARD', (driving.vehFwd ?? -99) > 1.5, `fwd ${driving.vehFwd} m/s (unsigned ${driving.vehSpeed}) ${JSON.stringify(driving.rig)}`);
    // RE-ASSERT THE SITE. The W phase just drove for up to 400 frames wherever
    // the lane went, so the upright/on-road checks made at entry are stale by
    // now. One measured failure ended on a 12.5 degree river bank on `water`
    // (mu 0.22), where a car genuinely cannot climb out — that is terrain, and
    // scoring it as a drivetrain failure is how a harness manufactures ghosts.
    const preBrake = driving;
    rec('vehicle', 'still on drivable ground before the brake test',
      (preBrake.rig?.upDot ?? 1) > 0.85 && preBrake.rig?.surface !== 'water' && preBrake.rig?.surface != null,
      `up ${preBrake.rig?.upDot}, surface ${preBrake.rig?.surface ?? 'NOT MEASURED'}` +
      ` (${preBrake.rig?.wheelsDown ?? '?'}/4 wheels down)`);

    // Brake through the stop and into reverse. 450 frames, not 900: the worst
    // measured case across every surface and gradient is 291 frames INCLUDING
    // braking from 8.5 m/s, so a 900-frame budget is generous enough to hide
    // the exact latch it exists to catch — a real one took ~600 frames and
    // still scored as a pass.
    const braked = await holdUntil('KeyS', (s) => (s.vehFwd ?? 99) < -0.5, { maxFrames: 450 });
    // Assert the ABSOLUTE sign, not a delta against W. Relative to a forward
    // speed that was itself negative, "went down by 0.5" passes while the car
    // does entirely the wrong thing.
    rec('vehicle', 'S brakes then reverses', (braked.vehFwd ?? 99) < -0.5,
      `fwd ${driving.vehFwd} -> ${braked.vehFwd} m/s after ${braked._frames} frames` +
      ` [on ${braked.rig?.surface ?? 'unknown'}, gear ${braked.rig?.gear}, brake ${braked.rig?.brake}]`);

    // ASSERT THE MECHANISM, not just the outcome. A timeout only tells you the
    // car ended up slow; it does not say why, and it passes whenever the bug
    // happens to resolve by luck. Naming the latch directly — reverse selected,
    // brake released — is what distinguishes "the gearbox refused the gear and
    // held full brake" from "this surface has no grip". The real defect was
    // exactly that: a car rolling backwards fell through the gear guard and got
    // full brake with no gear, and on flat ground it escaped by chance.
    rec('vehicle', 'reverse is SELECTED and the brake lets go',
      braked.rig?.gear === 'R' && (braked.rig?.brake ?? 1) < 0.02,
      `gear ${braked.rig?.gear}, resolved brake ${braked.rig?.brake} (S key still held: in_brake ${braked.rig?.in_brake})`);

    // The three defects that make the car unplayable, none of which are
    // properties of the car itself. Unmeasurable is a FAILURE, not a skip.
    const rig = driving.rig;
    rec('vehicle', 'driving rig is measurable', !!rig && !rig.err, rig?.err ? `cannot measure: ${rig.err}` : 'ok');
    if (rig && !rig.err) {
      rec('vehicle', 'chase camera sits BEHIND the car',
        rig.camDotNose != null && rig.camDotNose < -0.5,
        rig.camDotNose == null ? 'not measured' : `car->cam · nose = ${rig.camDotNose} (want < -0.5; +1 = parked in front of the windscreen)`);
      rec('vehicle', 'driver faces the same way as the car',
        rig.bodyDotNose != null && rig.bodyDotNose > 0.5,
        rig.bodyDotNose == null ? 'not measured' : `body · nose = ${rig.bodyDotNose}, yaw error ${rig.bodyYawErrDeg}deg`);
      rec('vehicle', 'driver sits IN the car, not on the roof',
        rig.rootMinusSeatY == null || rig.rootMinusSeatY < -0.3,
        rig.rootMinusSeatY == null ? `not measured (root ${rig.rootAboveCarY}m above car origin)` : `root - seatAnchor = ${rig.rootMinusSeatY}m (want about -0.8; 0 = standing on the roof)`);
    }
    rec('vehicle', 'vehicle has a fuel value', driving.vehFuel != null, driving.vehFuel != null ? `fuel ${driving.vehFuel}` : 'no fuel property (fuel + gas stations are specified)');
    await key('KeyH');
    await key('KeyR');
    await key('KeyV');
    await hold('KeyF', 10);
    await pump(180);
    const exited = await snap();
    rec('vehicle', 'F exits the vehicle', !exited.inVehicle, exited.inVehicle ? 'still inside' : 'on foot');
  }

  // ---- combat ----
  const preFire = await snap();
  const fired = await page.evaluate(() => new Promise((done) => {
    const e = window.__ENGINE__;
    let n = 0;
    const off = e.events.on('weapon:fire', () => n++);
    let i = 0;
    const t = () => (++i >= 60 ? (off(), done(n)) : requestAnimationFrame(t));
    requestAnimationFrame(t);
    const c = document.querySelector('canvas');
    // Input.fire is down.has('Mouse0'), fed by a REAL mousedown. Poking internals
    // does not work — the weapons agent had to point this out.
    c?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    setTimeout(() => c?.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true })), 600);
  }));
  rec('combat', 'LMB fires the weapon', fired > 0, `${fired} weapon:fire events`);
  rec('combat', 'a weapon is equipped', !!preFire.weapon, preFire.weapon ?? 'none reported');

  await key('KeyE'); await pump(20);
  const swapped = await snap();
  rec('combat', 'E cycles weapon', swapped.weapon !== preFire.weapon || preFire.weapon == null, `${preFire.weapon} -> ${swapped.weapon}`);

  // ---- wanted / police ----
  const wantedRes = await page.evaluate(() => new Promise((done) => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    const before = pol?.level ?? null;
    const pl = e.ctx.peek('player');
    pol?.reportCrime?.('killPed', pl.position, 3, { witnessed: true });
    let i = 0;
    const t = () => (++i >= 90 ? done({ before, after: pol?.level ?? null }) : requestAnimationFrame(t));
    requestAnimationFrame(t);
  }));
  rec('police', 'a crime raises the wanted level', (wantedRes.after ?? 0) > (wantedRes.before ?? 0), `${wantedRes.before} -> ${wantedRes.after}`);

  // ---- world interactions ----
  const inter = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const g = e.ctx.peek('game');
    return {
      hasShops: !!(g?.freeroam?.shops ?? g?.shops),
      hasSafehouses: !!(g?.freeroam?.safehouses ?? g?.safehouses),
      hasPackages: !!(g?.freeroam?.packages ?? g?.save?.packages),
      hasRadio: !!e.ctx.peek('audio')?.radio,
      chapter: g?.getHudState?.()?.chapter ?? null,
      money: g?.cash ?? null,
    };
  });
  rec('world', 'shops exist', inter.hasShops, String(inter.hasShops));
  rec('world', 'safehouses exist', inter.hasSafehouses, String(inter.hasSafehouses));
  rec('world', 'hidden packages exist', inter.hasPackages, String(inter.hasPackages));
  rec('world', 'radio exists', inter.hasRadio, String(inter.hasRadio));

  // ---- report ----
  const pass = results.filter((r) => r.ok).length;
  const w = Math.max(...results.map((r) => r.name.length));
  let area = '';
  for (const r of results) {
    if (r.area !== area) { area = r.area; console.log(`\n--- ${area} ---`); }
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail ?? ''}`);
  }
  console.log(`\n${pass}/${results.length} interactions working`);
  if (errs.length) console.log(`\nconsole errors (${errs.length}):\n  ` + [...new Set(errs)].slice(0, 6).join('\n  '));
} catch (e) {
  console.error('playprobe failed:', e.message);
  console.error([...new Set(errs)].slice(0, 8).join('\n'));
} finally {
  await b.close();
  server?.kill();
}
