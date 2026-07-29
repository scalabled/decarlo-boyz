#!/usr/bin/env node
/**
 * LIVE VEHICLE PROBE — the three things `drivetest.mjs` cannot see.
 *
 * `src/vehicles/drivetest.mjs` runs the real `Vehicle` against synthetic ground
 * in Node, which is what makes it deterministic and fast. Three questions are
 * outside its reach by construction, and all three have shipped broken:
 *
 *   SEAT   is the driver's body BOTH in the right place AND actually on screen?
 *          The old check (`tools/playprobe.mjs`, "root - seatAnchor ~= -0.79")
 *          measured placement only, which is exactly why the driver could be
 *          invisible in the seat against a green probe. Placement without
 *          visibility is not a seated driver, and neither is visibility
 *          without placement.
 *   SIDE   Steel City is Pittsburgh. The driver, the door he walks to and the
 *          steering wheel must be on the car's LEFT.
 *   SPEED  what a car actually does on a REAL street, against the same numbers
 *          `bench.mjs` measures on a synthetic plane. The gap between the two
 *          is the city — surface tags, wetness, road roughness, traction cut —
 *          and it is the only way to tell "the model is slow" from "the road
 *          is".
 *
 * All of it is measured off emitted state and world-space geometry: the right
 * vector is derived from three's camera basis, never from `DRIVER_SIDE`, and
 * the speed is signed along the car's own nose.
 *
 *   node src/vehicles/liveprobe.mjs
 *   node src/vehicles/liveprobe.mjs --type=sports --seconds=25
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const opts = {};
for (const a of process.argv.slice(2)) {
  const [k, v] = a.replace(/^--/, '').split('=');
  opts[k] = v ?? true;
}
const TYPE = opts.type ?? 'sedan';
const SECONDS = Number(opts.seconds ?? 22);

const results = [];
let failed = 0;
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  if (!ok) failed++;
};

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
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await pump(120);

  /* ------------------------------------------------------------------ */
  /* Put the player on a lane centre and in a car — the playprobe spawn. */
  /* ------------------------------------------------------------------ */
  const spawned = await page.evaluate((type) => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const veh = e.ctx.peek('vehicles');
    const w = e.ctx.peek('world');
    pl.setControlEnabled?.(true);
    e.ctx.peek('sky')?.setTimeRate?.(0);
    const V = Object.getPrototypeOf(e.ctx.camera.position).constructor;
    const p = pl.position;
    /**
     * THE LONGEST STRAIGHT WITHIN REACH, not simply the nearest lane.
     *
     * A top-speed run down a 40 m residential street measures the street. Score
     * every edge near the player on how long it is AND how straight it is —
     * chord length over the sampled arc length — and take the best. A car that
     * runs out of road is a car whose "top speed" is really its cornering
     * speed, and the first cut of this probe reported exactly that: 21% of the
     * samples on asphalt and a peak of 52 km/h in second gear.
     */
    const V2 = new V(), V3 = new V();
    let best = null;
    for (const edge of w.roads.edges) {
      if (!edge || edge.kind === 'alley') continue;
      const id0 = edge.id ?? edge;
      w.roads.laneCenter(id0, 0, 0.02, V2);
      if (Math.hypot(V2.x - p.x, V2.z - p.z) > 900) continue;
      w.roads.laneCenter(id0, 0, 0.98, V3);
      const chord = Math.hypot(V3.x - V2.x, V3.z - V2.z);
      if (chord < 90) continue;
      let arc = 0;
      let px = V2.x, pz = V2.z;
      for (let s = 1; s <= 8; s++) {
        w.roads.laneCenter(id0, 0, 0.02 + (0.96 * s) / 8, V3);
        arc += Math.hypot(V3.x - px, V3.z - pz);
        px = V3.x; pz = V3.z;
      }
      const straight = chord / Math.max(1e-3, arc);
      if (straight < 0.985) continue;
      const score = chord * straight;
      if (!best || score > best.score) best = { id: id0, score, chord, kind: edge.kind, lanes: edge.lanes };
    }
    const hit = best ? null : w.roads.nearestEdge(p.x, p.z, 600);
    if (!best && !hit?.edge) return { error: 'no lane near the player' };
    const id = best ? best.id : (hit.edge.id ?? hit.edge);
    const lane = best ? 0 : (hit.lane ?? 0);
    const t0 = best ? 0.04 : Math.min(0.55, (hit.t ?? 0.5) + 0.02);
    const a = new V(), ahead = new V();
    w.roads.laneCenter(id, lane, t0, a);
    w.roads.laneCenter(id, lane, Math.min(0.98, t0 + 0.05), ahead);
    const yaw = Math.atan2(ahead.x - a.x, ahead.z - a.z);
    // Teleport FIRST: collision, LOD and the build queue are all camera-relative
    // and a car spawned into an unstreamed tile is testing the streamer.
    pl.teleport?.({ x: a.x + 2.4, y: a.y + 1.2, z: a.z }, 0);
    window.__SPAWN__ = { type, x: a.x, y: a.y + 0.6, z: a.z, yaw };
    window.__LANE__ = { id, lane };
    return {
      at: [+a.x.toFixed(1), +a.z.toFixed(1)],
      kind: best ? best.kind : hit.edge.kind,
      lanes: best ? best.lanes : hit.edge.lanes,
      straightM: best ? +best.chord.toFixed(0) : null,
    };
  }, TYPE);
  if (spawned.error) throw new Error(spawned.error);
  await pump(150);
  const ok = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const s = window.__SPAWN__;
    const v = e.ctx.peek('vehicles').spawn(s.type, { x: s.x, y: s.y, z: s.z }, s.yaw, {});
    if (!v) return false;
    window.__V__ = v;
    return true;
  });
  if (!ok) throw new Error(`spawn(${TYPE}) failed`);
  await pump(90);

  const entered = await page.evaluate(async () => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const v = window.__V__;
    const wait = (n) => new Promise((d) => { let i = 0; const t = () => (++i >= n ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); });
    const veh = e.ctx.peek('vehicles');
    /**
     * Stand at the driver's door and press F — but re-derive the door EVERY
     * attempt. A car spawned on a Pittsburgh gradient rolls while the player is
     * settling, and the first cut of this probe teleported to where the door
     * had been a second earlier and then reported "the player never got in"
     * from 11 m away.
     */
    let before = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      veh.setInput(v, { throttle: 0, brake: 1, steer: 0, handbrake: true });
      await wait(20);
      const a = veh.seatAnchor(v, 0);
      pl.teleport?.({ x: a.enter.x, y: a.enter.y + 1.0, z: a.enter.z }, 0);
      await wait(12);
      before = {
        player: pl.position.toArray().map((n) => +n.toFixed(1)),
        car: v.position.toArray().map((n) => +n.toFixed(1)),
        dist: +pl.position.distanceTo(v.position).toFixed(2),
        attempt,
      };
      pl.vehicles.tryEnter(pl.movement);
      for (let i = 0; i < 400 && pl.vehicles.phase !== 'drive'; i++) await wait(1);
      if (pl.vehicles.phase === 'drive') break;
    }
    veh.setInput(v, { throttle: 0, brake: 0, steer: 0, handbrake: false });
    return { ...before, phase: pl.vehicles.phase };
  });
  if (entered.phase !== 'drive') {
    throw new Error(`the player never got in: ${JSON.stringify(entered)}`);
  }
  await pump(60);

  /* ------------------------------------------------------------------ */
  /* SEAT + SIDE                                                        */
  /* ------------------------------------------------------------------ */
  const seat = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const veh = e.ctx.peek('vehicles');
    const v = pl.vehicle ?? pl.currentVehicle;
    if (!v) return { error: 'the player never got in' };
    const V = Object.getPrototypeOf(e.ctx.camera.position).constructor;
    const ch = pl.character;
    const root = ch?.root ?? null;
    if (!root) return { error: 'no character root' };

    /**
     * The car's RIGHT, from three's own camera basis: a camera yawed by PI looks
     * along world +Z and shows world -X on the right of the screen, so a body
     * whose forward is +Z has its right along -X. Nothing here reads
     * `DRIVER_SIDE`, so a mirrored fleet cannot pass by agreeing with itself.
     */
    const right = new V(-1, 0, 0).applyQuaternion(v.quaternion);

    const wp = root.getWorldPosition(new V());
    const anchor = veh.seatAnchor(v, 0);
    const rel = wp.clone().sub(v.position);

    // Every mesh under the root, and whether it survives to the frame.
    let meshes = 0, visible = 0, minOpacity = 9;
    root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      meshes++;
      let vis = o.visible;
      let p = o.parent;
      while (p && vis) { vis = p.visible; p = p.parent; }
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      let op = 1;
      for (const m of mats) if (m && typeof m.opacity === 'number') op = Math.min(op, m.opacity);
      minOpacity = Math.min(minOpacity, op);
      if (vis && op > 0.004) visible++;
    });

    return {
      rootVisible: root.visible === true,
      charOpacity: ch._opacity,
      meshes, visible,
      minOpacity: minOpacity === 9 ? 1 : +minOpacity.toFixed(4),
      rootMinusSeatY: +(wp.y - anchor.position.y).toFixed(3),
      planErr: +Math.hypot(wp.x - anchor.position.x, wp.z - anchor.position.z).toFixed(3),
      seatAlongRight: +anchor.local.dot(new V(-1, 0, 0)).toFixed(3),
      bodyAlongRight: +rel.dot(right).toFixed(3),
      enterAlongRight: +anchor.enter.clone().sub(v.position).dot(right).toFixed(2),
      headAboveBelt: +(anchor.local.y + v.spec.comY - (v.spec.style.beltY ?? 0)).toFixed(3),
      crownUnderRoof: +((v.spec.style.roofY ?? 0) - (anchor.local.y + v.spec.comY) - 0.242).toFixed(3),
      phase: pl.vehicles?.phase ?? null,
    };
  });
  if (seat.error) throw new Error(seat.error);

  check('driver is PLACED: root sits a seated head below the anchor',
    seat.rootMinusSeatY < -0.6 && seat.rootMinusSeatY > -0.95 && seat.planErr < 0.25,
    `root - seatAnchor = ${seat.rootMinusSeatY} m, ${seat.planErr} m off in plan`);
  check('driver is VISIBLE: root.visible and a non-zero material opacity',
    seat.rootVisible && seat.charOpacity > 0.004 && seat.visible > 0 && seat.minOpacity > 0.004,
    `root.visible ${seat.rootVisible}, character opacity ${seat.charOpacity}, ` +
    `${seat.visible}/${seat.meshes} meshes drawable, min material opacity ${seat.minOpacity}`);
  check('driver sits on the car\'s LEFT (Pittsburgh is right-hand traffic)',
    seat.bodyAlongRight < -0.15 && seat.seatAlongRight < -0.15,
    `body ${seat.bodyAlongRight} m and anchor ${seat.seatAlongRight} m along the car's own ` +
    `right vector (want both < -0.15)`);
  check('he gets in through the door on that same side',
    seat.enterAlongRight < 0,
    `entry point ${seat.enterAlongRight} m along the car's right`);
  check('his head is in the glass, not on the sill',
    seat.headAboveBelt > 0.08 && seat.crownUnderRoof > 0,
    `head ${seat.headAboveBelt} m over the belt line, crown ${seat.crownUnderRoof} m under the roof`);

  /* ------------------------------------------------------------------ */
  /* SPEED — flat out on a real street.                                  */
  /* ------------------------------------------------------------------ */
  const speed = await page.evaluate(async (secs) => {
    const e = window.__ENGINE__;
    const pl = e.ctx.peek('player');
    const v = pl.vehicle ?? pl.currentVehicle;
    if (!v) return { error: 'the player is no longer in a car' };
    const w = e.ctx.peek('world');
    const V = Object.getPrototypeOf(e.ctx.camera.position).constructor;
    // Put it back at the start of the straight: the steering runs above leave
    // it wherever they finished, and a top-speed run needs the whole road.
    {
      const L = window.__LANE__;
      const a = new V(), ahead = new V();
      w.roads.laneCenter(L.id, L.lane, 0.04, a);
      w.roads.laneCenter(L.id, L.lane, 0.09, ahead);
      v.setPose(new V(a.x, a.y + 0.35 + v.spec.comY, a.z), Math.atan2(ahead.x - a.x, ahead.z - a.z));
      await new Promise((d) => { let i = 0; const t = () => (++i >= 60 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); });
    }
    const look = new V();
    const samples = [];
    const t0 = e.ctx.time.elapsed;
    const w0 = performance.now();
    const p0 = v.position.clone();
    /**
     * COUNT THE FIXED STEPS THE CAR ACTUALLY GETS.
     *
     * `ctx.time.elapsed` advances by the wall-clock frame time, but `engine.js`
     * caps the physics backlog at `MAX_CATCHUP_STEPS` per frame — so on a slow
     * frame the clock moves and the simulation does not. A 0-60 time measured
     * against `elapsed` therefore measures the FRAME RATE as much as the car,
     * and would blame the drivetrain for a renderer stall. Counting the steps
     * the vehicle is handed gives a "physics seconds" axis that is directly
     * comparable to `bench.mjs`, which runs the same class at a guaranteed
     * 120 Hz.
     */
    let steps = 0;
    const realStep = v.fixedStep.bind(v);
    v.fixedStep = (dt, ctx) => { steps++; return realStep(dt, ctx); };
    /**
     * HOLD THE LANE, through the PLAYER'S OWN CONTROL AXIS.
     *
     * A car with the throttle pinned and no steering leaves the first bend, and
     * a "top speed" measured with two wheels in the dirt is a measurement of the
     * verge. Steering here is `scriptedInput.x`, the same axis the keyboard
     * writes, so this is also an end-to-end check of the steering sign: if +1
     * did not mean right, the very first correction would put the car off the
     * road and every number below would collapse.
     */
    const steerToLane = () => {
      const hit = w.roads.nearestEdge(v.position.x, v.position.z, 60);
      if (!hit?.edge) return 0;
      const id = hit.edge.id ?? hit.edge;
      const t = Math.min(0.99, (hit.t ?? 0.5) + 0.035 + Math.abs(v.forwardSpeed) * 0.0016);
      w.roads.laneCenter(id, hit.lane ?? 0, t, look);
      const q = v.quaternion;
      const fx = 2 * (q.x * q.z + q.w * q.y);
      const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
      const dx = look.x - v.position.x;
      const dz = look.z - v.position.z;
      // right = forward x up = (-fz, 0, fx)
      const right = dx * -fz + dz * fx;
      const ahead = dx * fx + dz * fz;
      const alpha = Math.atan2(right, Math.max(1.5, ahead));
      // Positive alpha = the lane is to the car's RIGHT = push the axis RIGHT (+1).
      return Math.max(-1, Math.min(1, alpha * 2.4));
    };
    await new Promise((done) => {
      const tick = () => {
        const t = e.ctx.time.elapsed - t0;
        pl.movement.scriptedInput = { x: steerToLane(), y: 1 };
        let down = 0;
        let grip = 0;
        let surf = '?';
        for (const wh of v.wheels) {
          if (!wh.grounded) continue;
          down++;
          grip += wh.grip?.mu ?? 0;
          surf = wh.surface;
        }
        samples.push({
          t: +t.toFixed(3),
          pt: +(steps / 120).toFixed(3),
          fwd: +v.forwardSpeed.toFixed(3),
          gear: v.drivetrain.gearLabel,
          rpm: Math.round(v.drivetrain.rpm),
          throttle: +v.control.throttle.toFixed(2),
          traction: +v.traction.toFixed(3),
          contacts: v.diag?.contacts ?? 0,
          y: +v.position.y.toFixed(2),
          down,
          mu: down ? +(grip / down).toFixed(3) : 0,
          surf,
        });
        if (t < secs) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
    pl.movement.scriptedInput = { x: 0, y: 0 };
    v.fixedStep = realStep;
    const travelled = +v.position.distanceTo(p0).toFixed(1);
    const climbed = +(v.position.y - p0.y).toFixed(2);
    const wallSec = (performance.now() - w0) / 1000;
    const frames = samples.length;
    const kmh = (s) => s.fwd * 3.6;
    const timeTo = (target, key) => {
      for (const s of samples) if (kmh(s) >= target) return +s[key].toFixed(2);
      return null;
    };
    let peak = samples[0];
    for (const s of samples) if (s.fwd > peak.fwd) peak = s;
    const late = samples.filter((s) => s.t > secs * 0.6);
    const surfaces = {};
    for (const s of samples) surfaces[s.surf] = (surfaces[s.surf] ?? 0) + 1;
    const onRoad = samples.filter((s) => s.surf === 'asphalt' || s.surf === 'concrete');
    /**
     * THE LAUNCH WINDOW, on its own. A 0-60 that includes a trip through the
     * verge is a measurement of the verge; these are the conditions the car
     * actually had while it was accelerating, so a gap against `bench.mjs`
     * (flat, dry, four wheels down, mu 1.0) can be attributed rather than
     * guessed at.
     */
    let li = samples.findIndex((s) => s.fwd * 3.6 >= 60);
    if (li < 0) li = samples.length - 1;
    const win = samples.slice(0, li + 1);
    const mean = (f) => +(win.reduce((a, s) => a + f(s), 0) / Math.max(1, win.length)).toFixed(3);
    const launch = {
      wheelsDown: mean((s) => s.down),
      mu: mean((s) => s.mu),
      tractionCut: mean((s) => s.traction),
      contacts: mean((s) => s.contacts),
      climbed: +(win[win.length - 1].y - win[0].y).toFixed(2),
      onRoadPct: Math.round((win.filter((s) => s.surf === 'asphalt' || s.surf === 'concrete').length / Math.max(1, win.length)) * 100),
    };
    return {
      wetness: +(e.ctx.peek('sky')?.wetness ?? 0).toFixed(3),
      travelled, climbed, launch,
      onRoadPct: Math.round((onRoad.length / samples.length) * 100),
      meanContacts: +(samples.reduce((a, s) => a + s.contacts, 0) / samples.length).toFixed(2),
      fps: +(frames / wallSec).toFixed(1),
      physicsHzActual: +(steps / wallSec).toFixed(1),
      /** How much simulated time the car got per second of game clock. */
      simRate: +((steps / 120) / Math.max(1e-6, samples[samples.length - 1].t)).toFixed(3),
      // Against the game clock (what a player experiences)...
      t0_60kmh: timeTo(60, 't'),
      t0_100kmh: timeTo(100, 't'),
      // ...and against the steps the car was actually given, which is the axis
      // `bench.mjs` measures on.
      t0_60kmh_physics: timeTo(60, 'pt'),
      t0_100kmh_physics: timeTo(100, 'pt'),
      peakKmh: +(peak.fwd * 3.6).toFixed(1),
      peakGear: peak.gear,
      peakRpm: peak.rpm,
      meanLateKmh: +(late.reduce((a, s) => a + s.fwd, 0) / Math.max(1, late.length) * 3.6).toFixed(1),
      meanWheelsDown: +(samples.reduce((a, s) => a + s.down, 0) / samples.length).toFixed(2),
      meanMu: +(samples.reduce((a, s) => a + s.mu, 0) / samples.length).toFixed(3),
      meanTraction: +(samples.reduce((a, s) => a + s.traction, 0) / samples.length).toFixed(3),
      surfaces,
      samples: samples.filter((_, i) => i % 30 === 0).slice(0, 40),
    };
  }, SECONDS);

  /* ------------------------------------------------------------------ */
  /* STEERING, end to end through the PLAYER'S OWN INPUT PATH.           */
  /* ------------------------------------------------------------------ */
  /**
   * `drivetest.mjs` asserts the sign inside `vehicles`, which is where the fix
   * is — but the defect spans two subsystems: the movement
   * axis is produced in `src/core/input.js`, carried by `src/player/vehicle.js`
   * and consumed here. Only a live run covers the whole chain, and the chain is
   * where a convention mismatch lives. `scriptedInput.x` is the same field the
   * keyboard writes, so this is the a/d keys in everything but name.
   */
  for (const [key, axis, wantRight] of [['d', +1, true], ['a', -1, false]]) {
    const r = await page.evaluate(async ([ax, secs]) => {
      const e = window.__ENGINE__;
      const pl = e.ctx.peek('player');
      const v = pl.vehicle ?? pl.currentVehicle;
      const V = Object.getPrototypeOf(e.ctx.camera.position).constructor;
      const wait = (n) => new Promise((d) => { let i = 0; const t = () => (++i >= n ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); });
      // Get it rolling first: a stationary car does not turn.
      {
        /**
         * Back to the start of the straight, in one piece and with fuel in it.
         * The top-speed run above finishes wherever it finishes — often bent,
         * dry, or off the carriageway — and a steering test on a car that
         * cannot move reports "no turn", which is indistinguishable from a sign
         * error. Both repairs go through the public API rather than poking
         * `health` and `fuel`, so this cannot drift from what the game does.
         */
        const L = window.__LANE__;
        const veh2 = e.ctx.peek('vehicles');
        const w2b = e.ctx.peek('world');
        veh2.repair(v, v.maxHealth);
        veh2.refuel(v, v.maxFuel);
        const a2 = new V(), ah2 = new V();
        w2b.roads.laneCenter(L.id, L.lane, 0.04, a2);
        w2b.roads.laneCenter(L.id, L.lane, 0.09, ah2);
        v.setPose(new V(a2.x, a2.y + 0.35 + v.spec.comY, a2.z), Math.atan2(ah2.x - a2.x, ah2.z - a2.z));
        await wait(60);
      }
      /**
       * The run-up STEERS ITSELF DOWN THE LANE. A car driven at a real street
       * with the wheel straight leaves it at the first bend, and a lock applied
       * to a car that is stationary in a ditch turns nothing at all — which
       * reads exactly like a sign error and is not one. Two runs of this probe
       * disagreed with each other before the run-up followed the road.
       */
      const w2 = e.ctx.peek('world');
      const look = new V();
      const laneAxis = () => {
        const h = w2.roads.nearestEdge(v.position.x, v.position.z, 60);
        if (!h?.edge) return 0;
        const t = Math.min(0.99, (h.t ?? 0.5) + 0.04 + Math.abs(v.forwardSpeed) * 0.0016);
        w2.roads.laneCenter(h.edge.id ?? h.edge, h.lane ?? 0, t, look);
        const q = v.quaternion;
        const fx = 2 * (q.x * q.z + q.w * q.y);
        const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
        const dx = look.x - v.position.x;
        const dz = look.z - v.position.z;
        return Math.max(-1, Math.min(1,
          Math.atan2(dx * -fz + dz * fx, Math.max(1.5, dx * fx + dz * fz)) * 2.4));
      };
      let ready = false;
      for (let i = 0; i < 2000; i++) {
        pl.movement.scriptedInput = { x: laneAxis(), y: 1 };
        await wait(1);
        if (v.forwardSpeed > 8) { ready = true; break; }
      }
      const q0 = v.quaternion.clone();
      const p0 = v.position.clone();
      // right = -X for a +Z-forward body; derived in the seat section above.
      const right0 = new V(-1, 0, 0).applyQuaternion(q0);
      const f0 = new V(0, 0, 1).applyQuaternion(q0);
      const yaw0 = Math.atan2(f0.x, f0.z);
      const entry = v.forwardSpeed;
      pl.movement.scriptedInput = { x: ax, y: 0.55 };
      await wait(Math.round(secs * 60));
      pl.movement.scriptedInput = { x: 0, y: 0 };
      const f1 = new V(0, 0, 1).applyQuaternion(v.quaternion);
      let d = Math.atan2(f1.x, f1.z) - yaw0;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const disp = v.position.clone().sub(p0);
      await wait(120);
      return {
        ready,
        entry: +entry.toFixed(1),
        yawDeg: +((d * 180) / Math.PI).toFixed(1),
        lateralRight: +disp.dot(right0).toFixed(2),
        travelled: +disp.length().toFixed(1),
      };
    }, [axis, 2.2]);
    // The car has to have been MOVING for the answer to mean anything; a lock
    // held on a stationary car turns nothing and would read as a sign error.
    const moved = r.ready && Math.abs(r.yawDeg) > 4 && Math.abs(r.lateralRight) > 0.2;
    const wentRight = moved && r.yawDeg < 0 && r.lateralRight > 0;
    const wentLeft = moved && r.yawDeg > 0 && r.lateralRight < 0;
    check(`holding ${key} turns the car ${wantRight ? 'RIGHT' : 'LEFT'} (live, whole chain)`,
      wantRight ? wentRight : wentLeft,
      `entered the corner at ${r.entry} m/s, heading ${r.yawDeg} deg, ${r.lateralRight} m along ` +
      `the car's own right vector over ${r.travelled} m ` +
      `(want ${wantRight ? 'heading < 0, right > 0' : 'heading > 0, right < 0'})`);
  }

  if (!speed.error) {
    /**
     * A car is only as quick as the number of physics steps it is handed.
     * `engine.js` caps the backlog at `MAX_CATCHUP_STEPS` (6) per frame, so
     * below 20 fps the whole simulation runs in slow motion against the game
     * clock — which is a `core` property, not a vehicle one, but it is the
     * difference between "the model is slow" and "the frame is". Reported, and
     * gated only loosely, because a probe machine's frame rate is not the game.
     */
    check('the car gets the physics time the clock says it did',
      speed.fps < 25 || speed.simRate > 0.9,
      `${speed.simRate} of real time (${speed.physicsHzActual} Hz of physics at ` +
      `${speed.fps} fps; engine.js caps the backlog at 6 steps of 1/120 s per frame, ` +
      `so anything under 20 fps runs the whole sim in slow motion)`);
  }

  console.log(JSON.stringify({ spawned, seat, speed }, null, 2));

  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n          ${r.detail}`);
  console.log(`\n${results.length - failed}/${results.length} live vehicle assertions pass`);
  if (errs.length) console.log('page errors:', [...new Set(errs)].slice(0, 4).join('\n'));
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error('liveprobe failed:', e.message);
  console.error([...new Set(errs)].slice(0, 6).join('\n'));
  process.exitCode = 1;
} finally {
  await b.close();
  server?.kill();
}
