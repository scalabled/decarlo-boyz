#!/usr/bin/env node
/**
 * CHASE CAMERA GATE — is the camera composed against the car that is DRAWN?
 * ...and is the DRIVER'S BODY?
 *
 *   node src/player/camlagtest.mjs
 *   node src/player/camlagtest.mjs --verbose
 *   node src/player/camlagtest.mjs --control=source   (negative control 1)
 *   node src/player/camlagtest.mjs --control=order    (negative control 2)
 *   node src/player/camlagtest.mjs --control=both     (the true original build)
 *   node src/player/camlagtest.mjs --control=seat     (negative control 3)
 *   node src/player/camlagtest.mjs --control=seatlerp (negative control 4)
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG, MEASURED — this file's previous version got it backwards
 * ---------------------------------------------------------------------------
 *
 * There are two independent things the chase camera can get wrong, and they
 * used to be conflated. Both were re-measured here from scratch, with all four
 * code states built and run:
 *
 *   SOURCE  — which pose the camera reads. `_solveChase` duck-types the vehicle
 *             through `v.object3D ?? v.mesh ?? v.root ?? v.model?.root`. A live
 *             `Vehicle` has only the LAST of those, and until recently the list
 *             stopped one entry short, so the camera fell through to
 *             `v.position` — the raw physics pose. The renderer draws
 *             `lerp(prevPosition, position, alpha)`, so the camera framed a car
 *             (1 - alpha) fixed steps AHEAD of the one on screen. Bounded by
 *             FIXED_DT * v = v/120 regardless of frame time, and it OSCILLATES
 *             with alpha, so it is judder, not an offset.
 *
 *   PHASE   — when the camera is applied. `vehicles.update()` writes the drawn
 *             pose (`syncTransforms`) and the registry topo-sorts `player`
 *             before `vehicles`, so a camera applied from `player.update()`
 *             cannot see this frame's drawn pose at all.
 *
 * The two interact, which is the part that was missed. MEASURED (kinematic
 * drive, dt = 1.5 * FIXED, 300 warm + 60 frames; two repeat runs identical to
 * every printed digit) — the drawn car's Z in the emitted camera basis:
 *
 *   reads         applied in       @54 km/h    @108 km/h
 *   v.position    player.update    -8.35709    -10.18376   <- the true original
 *   v.position    cameraUpdate     -8.35709    -10.18376   <- IDENTICAL
 *   model.root    player.update    -8.63611    -10.74371   <- a WHOLE frame late
 *   model.root    cameraUpdate     -8.39095    -10.37060   <- shipping
 *
 * So: the phase on its own moved the camera by exactly zero — it was never a
 * fix for anything that shipped. What it is, is the PRECONDITION for the source
 * fix: read the drawn transform from `player.update()` and you get last frame's,
 * which is 0.245 m / 0.373 m adrift — one frame of travel, v*dt, and worse than
 * the bug you set out to fix. Deleting the phase while keeping the source fix
 * gives row 3, the worst build of the four.
 *
 * The real correction the fix bought is row 4 minus row 1: 0.034 m at 54 km/h
 * and 0.187 m at 108 km/h, plus the removal of the cadence judder this file
 * gates on. It is NOT "0.55 m at 120 km/h and worse the worse the frame rate
 * gets"; that claim described row 3, which never shipped. Re-measured at 34 fps
 * the framing correction is 0.025 m / 0.061 m — SMALLER than at 80 fps, and the
 * sign flips. The error is bounded by one fixed step of travel, not by v*dt.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE ASSERTS, AND WHY IT CAN FAIL (hard rule 12)
 * ---------------------------------------------------------------------------
 *
 * The previous version asserted one thing: sample the car's world matrix when
 * the camera moves, sample it again at the end of the frame, require them
 * equal. Once the camera reads `model.root` from `cameraUpdate` that residual
 * cannot be anything but zero — it re-reads the very matrix the solver just
 * consumed, through the same `updateWorldMatrix` call. It advertised "an exact
 * zero rather than a tuned tolerance"; an exact zero by construction is an
 * identity, not a measurement. It also passed row 2 above — the shipped bug —
 * with flying colours.
 *
 * So there are now TWO checks, and the failing input for each is named:
 *
 *  1. FRAMING HAS NO PHYSICS-CADENCE BEAT.  Drive the car so that its DRAWN
 *     motion is exactly uniform (below). Express the drawn car in the FINAL
 *     emitted camera basis every frame, then phase-lock-average those vectors
 *     by interpolation cadence and difference the buckets. A camera composed
 *     against the drawn pose sees a perfectly uniform subject and settles to a
 *     constant offset: the difference is 0. A camera composed against
 *     `v.position` sees a subject that advances in 1-step and 2-step jumps, and
 *     the beat survives its smoothing.
 *
 *     WHAT INPUT MAKES THIS FAIL: any pose source that is not the drawn one and
 *     carries the fixed-step cadence. MEASURED 0.000000 m shipped, 0.005196 m
 *     at 54 km/h and 0.010393 m at 108 km/h under `--control=source`. Nothing
 *     in it is a number the camera computed: the two quantities are
 *     `camera.matrixWorld` and `model.root.matrixWorld`, both read after the
 *     frame has been drawn, and the assertion is a property of their RELATIVE
 *     motion rather than an equality between them.
 *
 *  2. NOTHING MOVES THE DRAWN CAR AFTER THE CAMERA IS PLACED.  This is the old
 *     check, kept, but described honestly: it is an ORDERING guard with no
 *     headroom on a correctly ordered build, and its job is to stop the
 *     `cameraUpdate` phase being deleted — which check 1 cannot see, because a
 *     camera that is a whole frame late still frames a uniform subject
 *     uniformly. MEASURED 0.000000 m shipped, 0.1875 m / 0.375 m under
 *     `--control=order` (exactly one frame of travel).
 *
 *     It reads `root.position` — the value `syncTransforms` writes — and NOT
 *     `root.matrixWorld`, deliberately: `updateWorldMatrix` is a call the
 *     camera itself makes, so sampling through it makes the answer depend on
 *     whether the camera happened to touch the object rather than on when the
 *     pose was written. `posedGap` below asserts the two agree, so the
 *     substitution is checked rather than assumed.
 *
 * Between them: build A fails both, B fails 1, C fails 2, D passes both. Every
 * arm has a negative control that has been watched go red.
 *
 * ---------------------------------------------------------------------------
 * TEST CONDITIONS — owned by this file, on purpose
 * ---------------------------------------------------------------------------
 *
 * The car is driven KINEMATICALLY: after `vehicles.fixedUpdate`, its pose,
 * velocity and spin are overwritten to put it on a straight line at exactly
 * `speed`. `prevPosition` is captured at the top of `fixedStep`, i.e. before
 * the overwrite, so it holds the PREVIOUS forced pose and the render
 * interpolation sees a genuinely uniform trajectory. Suspension bob, lane
 * curvature, camber and drivetrain ripple are then not in the measurement, and
 * check 1's residual on a correct build is float noise rather than road.
 *
 * The line is flown CLEAR_AIR_M above the spawn. Not decoration: a straight
 * line at street level drives the car through buildings, and MEASURED, the
 * first attempt at ground level ended with the probe car destroyed and the
 * player ejected before the second block started. Altitude also empties the
 * boom's `sphereCast`, which is the only other thing that moves the framing —
 * with it, check 1's shipped residual is exactly 0.
 *
 * TWO SPEEDS, always: the error is proportional to speed, so a single-speed
 * gate can be satisfied by a tolerance that merely happens to exceed the error
 * at the speed that was tested. 15 and 30 m/s, same budget at both.
 *
 * dt IS 1.5 FIXED STEPS, deliberately not a whole number of them: the engine
 * then runs 1 and 2 physics steps on alternate frames and the interpolation
 * alpha alternates, which is the beat check 1 looks for. A whole number of
 * steps pins alpha to one value and the beat has nowhere to live.
 *
 * ---------------------------------------------------------------------------
 * CHECK 3 — THE DRIVER'S BODY, which used to be reported and is now ASSERTED
 * ---------------------------------------------------------------------------
 *
 * This file already measured the driver's body and printed it as INFO on the
 * grounds that the fix belonged to another file. It does not: this probe and
 * `src/player/vehicle.js` sit together, so the measurement is a gate.
 *
 * It turned out to be TWO faults stacked, not one, and the second was invisible
 * until the first was fixed. MEASURED — the drawn body in the DRAWN car's own
 * frame, phase-locked by interpolation cadence:
 *
 *   seat composed from   seated body        54 km/h    108 km/h
 *   v.position           re-lerped          0.1250 m   0.2500 m  <- what shipped
 *   v.position           used as written    0.0625     0.1250    --control=seat
 *   the drawn pose       re-lerped          0.0938     0.1875    --control=seatlerp
 *   the drawn pose       used as written    0.000000   0.000000  <- now
 *
 *   1. THE SOURCE. `vehicle.js` composed the seat from `v.position` /
 *      `v.quaternion` — the physics pose, one whole fixed step ahead of the car
 *      the renderer draws. Exactly the camera's bug, in the body.
 *   2. THE DOUBLE INTERPOLATION. `movement.sampleRender` then lerped that seat
 *      against LAST FRAME's seat by the FIXED-STEP alpha. The two endpoints are
 *      a frame apart and alpha is a fraction of a step, so it is not an
 *      interpolation of anything: at dt = 1.5 steps alpha alternates 0.5 / 1.0
 *      and the body was drawn half a frame of travel behind the seat on every
 *      other frame. Worth more than fault 1 on its own (row 3).
 *
 * Both ALTERNATE with alpha, so what the player sees is a beat — the driver's
 * head swimming fore and aft through the seat back at speed — rather than a
 * static offset nobody would ever notice.
 *
 * The metric is the same phase-locked split checks 1 and 2 use, applied to the
 * body instead of the camera, and both of its inputs are matrices read after
 * the frame was drawn — not a field the seat solver set. Each control turns
 * exactly this check red and leaves checks 1 and 2 green.
 */
import { chromium } from 'playwright';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const VERBOSE = !!args.verbose;
const CONTROL = args.control ? String(args.control) : null;
if (CONTROL && !['source', 'order', 'both', 'seat', 'seatlerp'].includes(CONTROL)) {
  console.error(
    `camlagtest: unknown --control=${CONTROL} (source | order | both | seat | seatlerp)`
  );
  process.exit(1);
}

/** Physics step, from src/core/config.js. The frame dt is deliberately NOT a
 *  whole multiple of it. */
const FIXED_DT = 1 / 120;
const FRAME_DT = FIXED_DT * 1.5;
/** Frames to settle the rig before measuring. The slowest chase time constant
 *  is CHASE.yawTauFast = 0.42 s; 300 frames is 3.75 s, ~9 of those. */
const WARM = 300;
const TAKE = 60;
/** Metres of clear air above the spawn — see the header. */
const CLEAR_AIR_M = 200;

/** Speeds to assert at, m/s (54 and 108 km/h). */
const SPEEDS = [15, 30];

/**
 * RATCHET (rule 13 — lower these when the camera improves, NEVER raise one to
 * make a run go green).
 *
 * Check 1. MEASURED 0.000000 m at both speeds on the shipping build (float
 * noise; the framing is constant to 4e-6 m peak-to-peak), against 0.005196 m at
 * 54 km/h and 0.010393 m at 108 km/h with `--control=source`. The budget sits
 * 13x above the pass and 5x below the failure. The goal is 0 and the build is
 * already there — this records a floor, not an allowance.
 */
const MAX_CADENCE_M = 0.001;
/**
 * Check 2. MEASURED 0.000000 m shipped — it is structurally zero while the
 * ordering holds — against 0.1875 m / 0.375 m with `--control=order`, i.e.
 * exactly one frame of travel at dt = 1.5/120 s.
 */
const MAX_AFTER_M = 0.005;
/**
 * Check 3, the driver's body. MEASURED 0.000000 m at both speeds with both
 * halves of the fix in, against 0.1250 / 0.2500 m on the build that shipped and
 * 0.0625 / 0.1250 and 0.0938 / 0.1875 with each half reverted on its own — see
 * the table above. Same 0.001 m floor as check 1, for the same reason: the
 * correct answer is an exact zero and this records where the build already is.
 */
const MAX_SEAT_M = 0.001;

const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
};

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text().slice(0, 200)); });

let exitCode = 1;
try {
  // `capture=1` for the deterministic path (fixed rng seed, no wall-clock step
  // budget), `lockstep=1` so the engine never schedules a frame of its own and
  // every frame in this file is one this file asked for.
  await page.goto(`http://127.0.0.1:${port}/?capture=1&lockstep=1&q=low&prewarm=0&gov=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 180000 });
  await page.evaluate(() => window.__PUMP__(60));

  /* ---- put a car on a lane and get in it ------------------------------- */
  const placed = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const veh = e.ctx.peek('vehicles');
    const roads = e.ctx.peek('world')?.roads;
    const p = pl.position;
    if (!roads?.nearestEdge || !roads.laneCenter) return { err: 'no road graph' };
    const hit = roads.nearestEdge(p.x, p.z, 400);
    if (hit?.edge == null) return { err: 'no lane within 400 m' };
    const V = Object.getPrototypeOf(p).constructor;
    const id = hit.edge.id ?? hit.edge;
    const lane = hit.lane ?? 0;
    const t0 = Math.min(0.5, hit.t ?? 0.5);
    const a = new V(), ahead = new V();
    roads.laneCenter(id, lane, t0, a);
    roads.laneCenter(id, lane, Math.min(0.99, t0 + 0.06), ahead);
    // A vehicle's nose is +Z, so a heading d needs yaw = atan2(d.x, d.z).
    const yaw = Math.atan2(ahead.x - a.x, ahead.z - a.z);
    if (!Number.isFinite(a.x)) return { err: 'lane centre is NaN' };
    // Own the test site: the player's entry scan takes the NEAREST car, not ours.
    for (const other of (veh?.active ?? veh?.vehicles ?? []).slice()) {
      if (!other?.position) continue;
      const dx = other.position.x - a.x, dz = other.position.z - a.z;
      if (dx * dx + dz * dz < 30 * 30) veh?.despawn?.(other);
    }
    const car = veh?.spawn?.('sedan', { x: a.x, y: a.y + 0.6, z: a.z }, yaw, {});
    if (!car) return { err: 'vehicles.spawn returned nothing' };
    car._probeCar = true;
    window.__SITE__ = { x: a.x, y: a.y + 0.6, z: a.z, yaw };
    pl.teleport?.(
      { x: a.x + Math.cos(yaw) * 2.4, y: a.y + 1.0, z: a.z - Math.sin(yaw) * 2.4 },
      { x: 0, y: 0, z: 0 }
    );
    return { at: [+a.x.toFixed(1), +a.z.toFixed(1)], yaw: +((yaw * 180) / Math.PI).toFixed(0) };
  });
  if (placed.err) throw new Error(`could not stage a car: ${placed.err}`);
  await page.evaluate(() => window.__PUMP__(40));

  const seated = await page.evaluate(async () => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    pl.vehicles.tryEnter?.(pl.movement);
    for (let i = 0; i < 40 && !pl.vehicles.seated; i++) await window.__PUMP__(10);
    return {
      seated: !!pl.vehicles.seated,
      chase: !!pl.rig.vehicle,
      probeCar: pl.vehicles.vehicle?._probeCar === true,
    };
  });
  if (!seated.seated || !seated.chase) {
    throw new Error(`player never got behind the wheel: ${JSON.stringify(seated)}`);
  }
  if (!seated.probeCar) throw new Error('entered a bystander, not the probe car — site not clear');

  /* ---- negative controls -----------------------------------------------
   *
   * A gate nobody has watched fail is not evidence of anything. Both controls
   * are installed at RUNTIME so neither needs a shipping file edited, and each
   * reproduces exactly one of the two historical states:
   *
   *   source — hide `model` from the camera's view of the vehicle, so
   *            `_solveChase` falls through to `v.position`. That IS the bug
   *            that shipped. Everything else about the vehicle forwards
   *            untouched, so nothing but the camera's pose source changes.
   *   order  — apply the camera at the end of `player.update()`, i.e. delete
   *            the `cameraUpdate` phase.
   *   both   — the true original build.
   *   seat   — compose the driver's seat from `v.position`/`v.quaternion`
   *            again (`vehicle.js`'s own `debugSeatDrawnPose`). Independent of
   *            the camera: it turns check 3 red and leaves 1 and 2 green.
   */
  if (CONTROL) {
    const applied = await page.evaluate((which) => {
      const e = window.__ENGINE__;
      const pl = e.ctx.peek('player');
      const notes = [];
      if (which === 'source' || which === 'both') {
        if (typeof pl.rig?.setVehicle !== 'function') return 'rig has no setVehicle to intercept';
        const map = new WeakMap();
        const wrap = (v) => {
          if (!v) return v;
          let p = map.get(v);
          if (!p) {
            p = new Proxy(v, {
              // Receiver is the TARGET, so the vehicle's own getters still see
              // their real `this`.
              get: (t, k) => (k === 'model' ? undefined : Reflect.get(t, k, t)),
              has: (t, k) => (k === 'model' ? false : Reflect.has(t, k)),
            });
            map.set(v, p);
          }
          return p;
        };
        const orig = pl.rig.setVehicle.bind(pl.rig);
        // Wrap BEFORE the original runs, so `rig.vehicle` is the proxy and
        // `player.update`'s once-per-frame `setVehicle(realCar)` still hits the
        // `v === this.vehicle` early-out instead of re-resolving the framing.
        pl.rig.setVehicle = (v) => orig(wrap(v));
        pl.rig.setVehicle(pl.vehicles.vehicle);
        if (pl.rig.vehicle?.model !== undefined) return 'the model proxy did not take';
        notes.push('camera cannot see model.root — falls through to v.position');
      }
      if (which === 'order' || which === 'both') {
        if (typeof pl.cameraUpdate !== 'function') return 'player has no cameraUpdate to move';
        const cam = pl.cameraUpdate.bind(pl);
        const upd = pl.update.bind(pl);
        pl.update = (dt, ctx) => { upd(dt, ctx); cam(dt, ctx); };
        pl.cameraUpdate = () => {};
        e.registry.invalidate();
        notes.push('camera applied at the end of player.update()');
      }
      if (which === 'seat') {
        if (pl.vehicles?.debugSeatDrawnPose !== true) {
          return 'MISSING: the vehicle handler has no debugSeatDrawnPose to turn off';
        }
        pl.vehicles.debugSeatDrawnPose = false;
        notes.push('driver seated on v.position — the raw physics pose');
      }
      if (which === 'seatlerp') {
        if (pl.movement?.debugSeatNoLerp !== true) {
          return 'MISSING: the movement machine has no debugSeatNoLerp to turn off';
        }
        pl.movement.debugSeatNoLerp = false;
        notes.push('seated body re-interpolated by the fixed-step alpha');
      }
      return notes.join(' + ');
    }, CONTROL);
    console.log(`\n[negative control: ${CONTROL}] ${applied}\n`);
    if (/^(rig has no|player has no|the model proxy|MISSING:)/.test(applied)) {
      throw new Error(applied);
    }
  }

  /* ---- measure --------------------------------------------------------- */
  for (const speed of SPEEDS) {
    const m = await page.evaluate(async ({ speed, frameDt, fixedDt, lift, warm, take }) => {
      const e = window.__ENGINE__;
      const pl = e.ctx.peek('player');
      const car = pl.vehicles.vehicle;
      const root = car.model.root;
      const site = window.__SITE__;

      /* THE TWO SAMPLED QUANTITIES. Both are emitted transforms read after the
       * frame has been drawn; neither is a field the chase solver set. */
      const drawn = () => {
        const t = root.matrixWorld.elements;
        return [t[12], t[13], t[14]];
      };
      /** The pose `vehicles.syncTransforms` writes, read WITHOUT refreshing any
       *  matrix — see the header note on check 2. */
      const posed = () => [root.position.x, root.position.y, root.position.z];
      const camPos = () => [e.camera.position.x, e.camera.position.y, e.camera.position.z];
      /** The drawn car in the FINAL camera basis. Rigid inverse by hand, so the
       *  number does not depend on three's matrixWorldInverse bookkeeping. */
      const inCam = () => {
        const m2 = e.camera.matrixWorld.elements;
        const d = drawn();
        const dx = d[0] - m2[12], dy = d[1] - m2[13], dz = d[2] - m2[14];
        return [
          m2[0] * dx + m2[1] * dy + m2[2] * dz,
          m2[4] * dx + m2[5] * dy + m2[6] * dz,
          m2[8] * dx + m2[9] * dy + m2[10] * dz,
        ];
      };
      /** Check 3: the driver's drawn body in the DRAWN car's own frame.
       *  Constant if the body rides the car it is drawn in. */
      const bodyRoot = pl.character3D;
      const inCar = () => {
        if (!bodyRoot) return null;
        bodyRoot.updateWorldMatrix(true, false);
        const b = bodyRoot.matrixWorld.elements;
        const m2 = root.matrixWorld.elements;
        const dx = b[12] - m2[12], dy = b[13] - m2[13], dz = b[14] - m2[14];
        return [
          m2[0] * dx + m2[1] * dy + m2[2] * dz,
          m2[4] * dx + m2[5] * dy + m2[6] * dz,
          m2[8] * dx + m2[9] * dy + m2[10] * dz,
        ];
      };

      /* KINEMATIC DRIVE — see the header. Straight line, exact speed, clear
       * air, written AFTER the vehicle's own fixed step so `prevPosition` holds
       * the previous forced pose and the render interpolation is uniform. */
      const V = Object.getPrototypeOf(car.position).constructor;
      const yaw = site.yaw;
      const nx = Math.sin(yaw), nz = Math.cos(yaw);   // the nose is +Z
      const y0 = site.y + lift;
      let travelled = 0;
      car.setPose(new V(site.x, y0, site.z), yaw);
      const q0 = {
        x: car.quaternion.x, y: car.quaternion.y, z: car.quaternion.z, w: car.quaternion.w,
      };

      /* Intra-frame instrument. Wraps EVERY phase method on EVERY subsystem —
       * it does not know or care which one moves the camera, so it keeps
       * working if the camera is applied somewhere else entirely. */
      const PHASES = ['fixedUpdate', 'update', 'cameraUpdate', 'lateUpdate'];
      const wrapped = [];
      const st = { cam: camPos(), posedAtCam: null, where: null };
      for (const sys of e.registry.ordered) {
        for (const ph of PHASES) {
          if (typeof sys[ph] !== 'function') continue;
          /* RESTORE, never `delete`. Tearing the instrument down by deleting the
           * own property also deletes anything else that had been installed on
           * the instance — which silently disarmed the negative control after
           * the first speed block and reported it as a PASS. */
          const had = Object.prototype.hasOwnProperty.call(sys, ph);
          const prev = sys[ph];
          const orig = sys[ph].bind(sys);
          const id = sys.constructor.id;
          sys[ph] = (...a) => {
            const r = orig(...a);
            if (ph === 'fixedUpdate' && id === 'vehicles') {
              travelled += speed * fixedDt;
              car.position.set(site.x + nx * travelled, y0, site.z + nz * travelled);
              car.quaternion.set(q0.x, q0.y, q0.z, q0.w);
              car.velocity.set(nx * speed, 0, nz * speed);
              car.angularVelocity.set(0, 0, 0);
            } else if (ph !== 'fixedUpdate') {
              const c = camPos();
              if (Math.abs(c[0] - st.cam[0]) + Math.abs(c[1] - st.cam[1]) + Math.abs(c[2] - st.cam[2]) > 1e-9) {
                st.cam = c;
                st.posedAtCam = posed();
                st.where = `${id}.${ph}`;
              }
            }
            return r;
          };
          wrapped.push([sys, ph, had, prev]);
        }
      }

      /* Step the engine here, on a private clock.
       *
       * `?capture=1` replaces `engine.step` with a virtual-clock wrapper that
       * pins dt to EXACTLY 1/60 for reproducibility — which is two whole fixed
       * steps, i.e. one alpha on every single frame, the one cadence this gate
       * must NOT be measured at. The wrapper is an own property; the class
       * method underneath still honours the timestamp it is given. */
      const rawStep = Object.getPrototypeOf(e).step;
      let t = 1e6;
      e._last = t;
      const step = () => new Promise((res) => requestAnimationFrame(() => {
        st.posedAtCam = null;
        st.where = null;
        t += frameDt * 1000;
        rawStep.call(e, t);
        res();
      }));

      const rows = [];
      for (let i = 0; i < warm + take; i++) {
        await step();
        const d1 = drawn();
        const l1 = posed();
        if (i < warm) continue;
        rows.push({
          where: st.where,
          p: inCam(),
          b: inCar(),
          alpha: e.time.alpha,
          spd: Math.hypot(car.velocity.x, car.velocity.z),
          /* Check 2: how far the pose the renderer draws moved AFTER the camera
           * was placed. */
          after: st.posedAtCam
            ? Math.hypot(l1[0] - st.posedAtCam[0], l1[1] - st.posedAtCam[1], l1[2] - st.posedAtCam[2])
            : null,
          /* The substitution check for check 2: `root.position` is only a stand-in
           * for the drawn translation while the root's parent chain is identity. */
          posedGap: Math.hypot(d1[0] - l1[0], d1[1] - l1[1], d1[2] - l1[2]),
          camDist: Math.hypot(
            d1[0] - e.camera.position.x, d1[1] - e.camera.position.y, d1[2] - e.camera.position.z
          ),
        });
      }
      for (const [sys, ph, had, prev] of wrapped) {
        if (had) sys[ph] = prev;
        else delete sys[ph];
      }
      e.registry.invalidate();

      const n = rows.length;
      let missing = 0, afterMax = 0, gapMax = 0;
      for (const r of rows) {
        if (r.after == null) missing++;
        else afterMax = Math.max(afterMax, r.after);
        gapMax = Math.max(gapMax, r.posedGap);
      }

      /* PHASE-LOCKED AVERAGE by interpolation cadence.
       *
       * alpha ~= 1 after N steps and alpha ~= 0 after N+1 steps are the SAME
       * instant on the trajectory, so they belong in one bucket; fp drift in the
       * accumulator walks the value across that boundary over a long run and
       * would otherwise split one cadence phase into two. */
      const bucket = (a) => String(Math.round(a * 2) % 2);
      const camG = new Map(), bodyG = new Map();
      const add = (into, key, vec) => {
        let g = into.get(key);
        if (!g) into.set(key, (g = { n: 0, s: [0, 0, 0] }));
        g.n++;
        for (let k = 0; k < 3; k++) g.s[k] += vec[k];
      };
      for (const r of rows) {
        add(camG, bucket(r.alpha), r.p);
        if (r.b) add(bodyG, bucket(r.alpha), r.b);
      }
      const splitOf = (map2) => {
        const ms = [...map2.values()].map((g) => g.s.map((x) => x / g.n));
        let out = 0;
        for (let i = 0; i < ms.length; i++) {
          for (let j = i + 1; j < ms.length; j++) {
            out = Math.max(out, Math.hypot(ms[i][0] - ms[j][0], ms[i][1] - ms[j][1], ms[i][2] - ms[j][2]));
          }
        }
        return out;
      };

      let p2p = 0;
      for (let k = 0; k < 3; k++) {
        let lo = Infinity, hi = -Infinity;
        for (const r of rows) { lo = Math.min(lo, r.p[k]); hi = Math.max(hi, r.p[k]); }
        p2p = Math.max(p2p, hi - lo);
      }
      const mean = [0, 0, 0];
      for (const r of rows) for (let k = 0; k < 3; k++) mean[k] += r.p[k] / n;

      return {
        where: rows.at(-1)?.where ?? null,
        missing,
        cadence: splitOf(camG),
        buckets: [...camG.values()].map((g) => g.n),
        p2p,
        afterMax,
        gapMax,
        bodyCadence: bodyG.size ? splitOf(bodyG) : null,
        mean,
        speed: rows.reduce((a, r) => a + r.spd, 0) / n,
        perFrame: (rows.reduce((a, r) => a + r.spd, 0) / n) * frameDt,
        camDist: rows.at(-1)?.camDist ?? null,
      };
    }, { speed, frameDt: FRAME_DT, fixedDt: FIXED_DT, lift: CLEAR_AIR_M, warm: WARM, take: TAKE });

    if (VERBOSE) console.log(JSON.stringify(m));
    const kmh = (m.speed * 3.6).toFixed(0);

    /* ---- preconditions: a broken rig must not read as a pass ---- */
    if (m.missing) {
      rec(`the camera is placed every frame @ ${kmh} km/h`, false,
        `the camera did not move on ${m.missing} of ${TAKE} frames — nothing to measure`);
      continue;
    }
    if (m.buckets.length < 2) {
      rec(`both interpolation cadences are exercised @ ${kmh} km/h`, false,
        `only ${m.buckets.length} alpha bucket(s) seen (${JSON.stringify(m.buckets)}); ` +
        `the cadence beat check 1 looks for cannot appear`);
      continue;
    }
    if (m.gapMax > 1e-6) {
      rec(`root.position is the drawn translation @ ${kmh} km/h`, false,
        `model.root sits under a non-identity parent (gap ${m.gapMax.toFixed(6)} m) — ` +
        `check 2's stand-in is invalid, fix it before trusting the run`);
      continue;
    }
    if (Math.abs(m.speed - speed) > 0.01) {
      rec(`the car holds the commanded speed @ ${kmh} km/h`, false,
        `asked ${speed} m/s, measured ${m.speed.toFixed(3)} m/s`);
      continue;
    }

    rec(
      `camera framing has no physics-cadence beat @ ${kmh} km/h`,
      m.cadence <= MAX_CADENCE_M,
      `cadence-locked framing split ${m.cadence.toFixed(6)} m (budget ${MAX_CADENCE_M} m); ` +
      `framing peak-to-peak ${m.p2p.toFixed(6)} m over ${TAKE} frames, car at ` +
      `[${m.mean.map((x) => x.toFixed(3)).join(', ')}] in camera space, boom ${m.camDist.toFixed(2)} m. ` +
      `One frame of travel is ${m.perFrame.toFixed(3)} m, one fixed step is ${(m.speed * FIXED_DT).toFixed(3)} m.`
    );
    rec(
      `nothing moves the drawn car after the camera is placed @ ${kmh} km/h`,
      m.afterMax <= MAX_AFTER_M,
      `the drawn pose moved ${m.afterMax.toFixed(6)} m after the camera was placed in ` +
      `${m.where}; budget ${MAX_AFTER_M} m, one frame of travel is ${m.perFrame.toFixed(3)} m.`
    );
    rec(
      `the driver's body rides the car that is DRAWN @ ${kmh} km/h`,
      m.bodyCadence != null && m.bodyCadence <= MAX_SEAT_M,
      m.bodyCadence == null
        ? 'no drawn body to sample — pl.character3D is null, nothing was measured'
        : `the drawn body slides ${m.bodyCadence.toFixed(6)} m fore/aft inside the drawn ` +
          `car on the physics cadence (budget ${MAX_SEAT_M} m). One fixed step of travel is ` +
          `${(m.speed * FIXED_DT).toFixed(3)} m, one frame is ${m.perFrame.toFixed(3)} m. ` +
          `Both inputs are matrices read after the frame was drawn.`
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (pageErrors.length) console.log('page errors:', pageErrors.slice(0, 6));
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error(`camlagtest: ${err.message}`);
  if (pageErrors.length) console.error('page errors:', pageErrors.slice(0, 6));
  exitCode = 1;
} finally {
  await browser.close();
  stopServer(server);
}

process.exit(exitCode);
