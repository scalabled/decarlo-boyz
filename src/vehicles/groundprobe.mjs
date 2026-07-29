#!/usr/bin/env node
/**
 * GROUND PROBE — "does a car sitting on the real city have anything to push
 * against?"
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS EXISTS FOR
 * ────────────────────────────────────────────────────────────────────────────
 * A car backing over a kerb gets stuck on it and floats in the air. The
 * telemetry from two frozen cars, holding W with the throttle pinned:
 *
 *     fwd 1.42 m/s  rpm 6256  throttle 1  clutch 1  gear 1  wheelsDown 1
 *     fwd 1.44 m/s  rpm 6297  throttle 1  clutch 1  gear 1  wheelsDown 0
 *
 * Level (`upDot` 0.98), in gear, clutch home, engine on the limiter — and
 * nothing under the tyres. `_stepWheels` used to search for ground to exactly
 * the end of the suspension's droop and no further, so a wheel one millimetre
 * past that limit was declared AIRBORNE: no spring, no load, and therefore no
 * tyre force at all. The sedan is front-wheel drive, so two front wheels going
 * 2 cm light is 100% of the drive gone. See `GROUND_REACH` in `dynamics.js`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE EXISTING GATES CANNOT SEE IT (and why this one can)
 * ────────────────────────────────────────────────────────────────────────────
 *   `drivetest.mjs`  runs the real `Vehicle` at 120 Hz against a SYNTHETIC
 *                    plane. That is what makes it deterministic, and it is also
 *                    why it scores 83/83 on a build where a third of the city's
 *                    kerb lines will beach a car: a plane has no camber break,
 *                    no junction pad and no verge lip, so no wheel is ever
 *                    asked to reach past its droop stop.
 *   `world/drivesweep.mjs`  measures the emitted road TRIANGLES. It answers
 *                    "is there a surface here", which is a different question
 *                    from "can a car's suspension reach it".
 *   `tools/playprobe.mjs`  drives ONE car from wherever the player happens to
 *                    be standing. It found this about one run in three, which
 *                    is precisely what makes it useless as the gate for it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS ASSERTED, AND WHY IT IS NOT CIRCULAR (ARCHITECTURE.md rule 12)
 * ────────────────────────────────────────────────────────────────────────────
 * Nothing below asks the vehicle where it thinks the ground is. The three
 * numbers are:
 *
 *   DENIED    the one this file exists for. Per wheel, an INDEPENDENT ray:
 *             vertical, from 12 m above the hub, 60 m long, `MASK.WORLD`.
 *             `_stepWheels` casts 0.6 m from the strut top along the car's own
 *             -up — different origin, different direction, different length.
 *             A wheel that reports AIRBORNE while that ray finds the road
 *             within `--deny` of the bottom of the tyre is being denied a
 *             contact it has, and that is the defect stated as a number.
 *             Sampled EVERY FRAME of the launch, not just at the ends: the
 *             defect flickers, and two snapshots per site under-count it by
 *             two orders of magnitude (see the negative control below).
 *   DOWN      `wheelsDown` after settling — the EMITTED contact count, which is
 *             the artefact the fix produces, not an input it consumed. Counted
 *             on `w.grounded === true` only: `w.contact` is a preallocated
 *             Vector3 and is always truthy, which is how "4 wheels down" got
 *             printed in two frozen-car investigations and meant nothing.
 *   HOVER     the literal complaint. The LOWEST of the four corners, against
 *             the same independent rays, must be on the road: a car with every
 *             tyre in the air is floating whatever else is true of it.
 *   LAUNCH    the signed, physical outcome: full throttle from rest, and the
 *             peak forward speed reached, projected on the car's own nose in
 *             world space, so a car rolling backwards down a hill scores
 *             negative rather than full marks.
 *
 * The only thing taken from another subsystem is WHERE a lane is, from
 * `world.roads` — the one fact the vehicle cannot know, and the same division
 * `drivesweep.mjs` and `pavesweep.mjs` draw.
 *
 * Sites that cannot answer the question are CLASSIFIED AND COUNTED, never
 * silently skipped — in water, tipped past `--upright`, steeper than `--grade`,
 * or run into something during the launch. Each exclusion is printed with the
 * totals, so a run that quietly stopped measuring anything says so.
 *
 * A SELF-CHECK fires first: the same launch, on the first lane site, must pass.
 * If the rig cannot drive a car on a road at all, the site numbers below are
 * noise, and the run aborts rather than reporting them.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NEGATIVE CONTROL — a gate that has never failed is not evidence
 * ────────────────────────────────────────────────────────────────────────────
 * Revert the fix in `src/vehicles/dynamics.js` — one line, both halves of the
 * band at once:
 *
 *     const GROUND_REACH = 0.15;   ->   const GROUND_REACH = 0.0;
 *
 * and re-run. MEASURED, `--n=60`, sedan:
 *
 *   GROUND_REACH 0.15   4/4 PASS
 *     denied      0 wheel-frames of 8197 upright frames, over all 60 sites
 *                 (0.02% on a `--n=40` run: 1 frame in 5177 — see DENY_RATE)
 *     wheels down 56/56 upright sites at >= 3 of 4
 *     launch      29/29 unobstructed sites under 10% grade
 *     hover       lowest corner 0.013 m at the worst site
 *   GROUND_REACH 0.0    2/4 FAIL
 *     denied      304 wheel-frames on 22 OF 60 SITES, of 8284 upright frames —
 *                 every one of them reading `len 0.25 / max 0.25`, i.e. pinned
 *                 at the droop stop, with this probe's independent vertical ray
 *                 finding the road between 0.001 m and 0.033 m below the tyre
 *     wheels down 55/57 — two sites settle on 2 of 4 wheels on level ground
 *
 * 0 against 304 is the number that makes the green run mean something, and the
 * ratio 22-of-60 is the answer to "how much of the city does this touch".
 *
 * Note WHY the count is in wheel-FRAMES. The wheels do not stay lost: they
 * flicker over the droop boundary as the body breathes, so a front-wheel-drive
 * car loses and regains its only driven axle several times a second. Two
 * snapshots per site found ONE such wheel in the whole city and made the
 * negative control look marginal; sampling every frame found 304 and made it
 * unarguable. Sample where the defect lives.
 *
 * Usage
 *   npm run ground
 *   node src/vehicles/groundprobe.mjs --n=60 --type=sedan
 *   node src/vehicles/groundprobe.mjs --verbose        list every site
 *   node src/vehicles/groundprobe.mjs --deny=0.06      denied-contact tolerance
 *   node src/vehicles/groundprobe.mjs --grade=0.10     steepest graded launch
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const opts = {};
for (const a of process.argv.slice(2)) {
  const [k, v] = a.replace(/^--/, '').split('=');
  opts[k] = v ?? true;
}
const N = Number(opts.n ?? 40);
const TYPE = opts.type ?? 'sedan';
const VERBOSE = !!opts.verbose;
/** Settle frames from a cold spawn before anything is measured. */
const SETTLE = Number(opts.settle ?? 150);
/** Frames of full throttle in the launch phase. */
const DRIVE = Number(opts.drive ?? 150);

/**
 * How far the LOWEST tyre may sit off the surface an independent ray finds, m.
 *
 * The literal reading of "floating in the air": a settled car must have at
 * least one tyre genuinely on the road. Deliberately the MINIMUM across the
 * four corners, not the maximum — with `GROUND_REACH` a light corner may sit up
 * to 0.15 m up and still (correctly) drive, so a maximum would be a test of the
 * forgiveness band rather than of the car's height. The worst corner is
 * reported next to it either way, because that number is the road surface's and
 * somebody should be watching it.
 */
const HOVER_TOL = Number(opts.hover ?? 0.05);
/**
 * Peak SIGNED forward speed the launch must reach, m/s.
 *
 * `DRIVE` frames is ~2.5 s. A healthy sedan is past 8 m/s. The frozen cars
 * measured before the fix sat at 0.30, 0.31, 0.45 and 1.03 m/s with the engine
 * on the limiter, so this sits in the empty gap between the two populations and
 * no amount of timing jitter, camber or loose surface reaches across it.
 */
const MIN_PEAK = Number(opts.peak ?? 2.0);
/** Wheels that must be in contact after settling, of four. */
const MIN_DOWN = Number(opts.down ?? 3);
/**
 * How close the road may be under a wheel that claims to be airborne, metres.
 *
 * The direct statement of the defect. Sized between the two things it must
 * separate: comfortably inside `GROUND_REACH` (0.15 m in `dynamics.js`), so a
 * wheel that has genuinely left the ground never trips it, and comfortably
 * outside the ~0.02 m by which a vertical ray and a ray along the body's -up
 * can disagree at `UPRIGHT_DOT`.
 */
const DENY_TOL = Number(opts.deny ?? 0.06);
/**
 * Denied wheel-frames tolerated, as a fraction of upright frames sampled.
 *
 * RATCHET. The goal is 0 and the residue is NOT the suspension — it is the two
 * queries sampling different points. This probe's ray is vertical; the car's is
 * along the body's -up, and at `UPRIGHT_DOT` that is 14 degrees, which over the
 * 0.735 m the strut ray covers puts the two ray ends up to 0.18 m apart in plan.
 * A wheel poised exactly on a kerb lip therefore has one ray on the carriageway
 * and the other in the gutter for a frame or two, and the disagreement is real
 * but it is between the rays, not about the wheel.
 *
 * MEASURED either side of it: the fix in, 1 denied wheel-frame in 5177 (0.02%)
 * and 0 in 8197 on a wider sweep; the fix out, 304 in 8284 (3.7%) across 22 of
 * 60 sites. This threshold sits two orders of magnitude below the broken arm
 * and five times above the healthy one.
 *
 * LOWER IT when the sampling is tightened; never raise it to make a run green.
 */
const DENY_RATE = Number(opts.denyrate ?? 0.001);
/** A body this level lets a vertical ray stand in for one along the body -up. */
const UPRIGHT_DOT = Number(opts.upright ?? 0.97);
/**
 * Steepest ground the launch is graded on, rise over the wheelbase.
 *
 * Pittsburgh, so the map genuinely carries 1-in-4 streets. A front-wheel-drive
 * sedan that cannot pull away up one of those is a tyre-model question and it
 * belongs to `drivetest.mjs` section 3, which owns gradient on a surface it
 * controls. Scoring it here would report the hill as a contact-patch defect.
 */
const MAX_GRADE = Number(opts.grade ?? 0.10);

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
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

/**
 * Run one site in the page: teleport the camera there so the world streams,
 * clear the site, cold-spawn, settle, measure, launch, measure again.
 *
 * Everything it returns is either a world-space physical quantity or an
 * independently-cast ray. Nothing is read back out of the suspension.
 */
const RUN_SITE = async ({ s, TYPE, SETTLE, DRIVE, UPRIGHT_DOT, DENY_TOL }) => {
  const e = window.__ENGINE__;
  const veh = e.ctx.peek('vehicles');
  const w = e.ctx.peek('world');
  const phys = e.ctx.peek('physics');
  const pl = e.ctx.peek('player');
  const frames = (k) =>
    new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); });

  // Stand the camera at the site. Collision streams around the CAMERA, so a
  // spawn measured from across the city would be measuring the streamer.
  pl.teleport?.({ x: s.x + 4, y: w.walkableHeightAt(s.x, s.z) + 1.0, z: s.z + 4 }, { x: 0, y: 0, z: 0 });
  await frames(50);

  // Own the test site. Ambient traffic parked on the spawn is a collision test,
  // not a ground test.
  for (const o of [...(veh.vehicles ?? [])]) {
    if (!o?.position) continue;
    const dx = o.position.x - s.x, dz = o.position.z - s.z;
    if (dx * dx + dz * dz < 30 * 30) veh.despawn(o);
  }

  const car = veh.spawn(TYPE, { x: s.x, y: s.y + 0.6, z: s.z }, s.yaw, {});
  if (!car) return { err: 'spawn refused' };
  car.engineOn = true;
  await frames(SETTLE);

  const V = car.position.constructor;
  const hub = new V();
  const measure = () => {
    let worst = -Infinity;
    let down = 0;
    let frontY = 0, rearY = 0, frontN = 0, rearN = 0, frontZ = 0, rearZ = 0;
    const wheels = [];
    for (const wh of car.wheels) {
      const hp = wh.hp;
      // The hub, in world space, from the vehicle's own pose — a POSE, not a
      // ground opinion. Where the ground is comes from the ray below.
      hub.set(hp.x, hp.top, hp.z).applyQuaternion(car.quaternion).add(car.position);
      const tyreBottom = hub.y - wh.len - hp.radius;
      // INDEPENDENT: vertical, from 12 m up, 60 m long. `_stepWheels` casts
      // 0.6 m from the strut top along the body's -up.
      const r = phys.raycast(hub.x, hub.y + 12, hub.z, 0, -1, 0, 60, phys.MASK.WORLD);
      const hover = r.hit ? tyreBottom - r.point.y : Infinity;
      if (wh.grounded === true) down++;
      if (hover > worst) worst = hover;
      // Axle-average ground height, for the site's grade. Taken off the same
      // independent rays, never off `world.heightAt` or the road graph.
      if (r.hit) {
        if (hp.front) { frontY += r.point.y; frontN++; } else { rearY += r.point.y; rearN++; }
      }
      if (hp.front) frontZ = hp.z; else rearZ = hp.z;
      wheels.push({
        g: wh.grounded === true,
        len: +wh.len.toFixed(3),
        max: +hp.max.toFixed(3),
        hover: r.hit ? +hover.toFixed(3) : null,
        obj: r.hit ? (r.object?.name ?? 'analytic') : 'MISS',
      });
    }
    // Grade along the car, rise over the wheelbase. Positive = nose uphill.
    const base = Math.abs(frontZ - rearZ) || 1;
    const grade = frontN && rearN ? (frontY / frontN - rearY / rearN) / base : 0;
    let best = Infinity;
    for (const wh of wheels) if (wh.hover != null && wh.hover < best) best = wh.hover;
    return {
      down,
      /** The corner that is DOWN. A car with any tyre on the road has this ~0. */
      minHover: Number.isFinite(best) ? +best.toFixed(3) : null,
      worstHover: Number.isFinite(worst) ? +worst.toFixed(3) : null,
      grade: +grade.toFixed(3),
      y: +car.position.y.toFixed(3),
      upDot: +new V(0, 1, 0).applyQuaternion(car.quaternion).y.toFixed(3),
      inWater: !!car.inWater,
      wheels,
    };
  };

  const settled = measure();
  const from = car.position.clone();

  // ---- launch: full throttle, and measure the WORLD, not the drivetrain ----
  //
  // PEAK forward speed, not just the distance covered. An alley that bends into
  // a wall two metres ahead stops a perfectly healthy car dead, and scoring
  // that as "the axle is dead" is grading the site. A car that got up to speed
  // and then hit something is a car whose tyres worked; a car whose driven axle
  // is airborne never gets there at all. Signed, so a car rolling backwards
  // down a hill can never satisfy it.
  veh.setInput(car, { throttle: 1, brake: 0, steer: 0, handbrake: false });
  let peak = -Infinity;
  let bumped = 0;
  let denied = 0;
  let deniedWorst = null;
  let samples = 0;
  const upRef = new V();
  // EVERY frame, not every tenth, and this is load-bearing twice over.
  //
  // `diag.contacts` is written per 120 Hz step and read here at frame rate, so
  // a wall the car is leaning on is seen on roughly every other step; sampling
  // every tenth frame missed one entirely and reported a car pinned against a
  // building as a dead axle. An under-sampled exclusion is a flaky gate.
  //
  // And the defect itself FLICKERS. A wheel poised on the droop boundary reads
  // grounded and airborne on alternate steps as the body breathes, so two
  // snapshots — settled, and at the end of the launch — catch it only by luck.
  // Reverting the fix and sampling twice put ONE wheel in the report; sampling
  // every frame puts hundreds. Sample where the defect lives.
  for (let k = 0; k < DRIVE; k++) {
    await frames(1);
    if (car.forwardSpeed > peak) peak = car.forwardSpeed;
    // Did the BODY hit static geometry on the way? A lane centre that runs at a
    // wall, a bollard or a skip stops a perfectly healthy car in a metre, and
    // that is a collision result, not a contact-patch one. Counted, reported,
    // and excluded from the launch assertion only — never from the per-wheel
    // one, which is where a high-centred car is caught.
    if (car.diag.contacts > 0) bumped++;

    // ---- the denied-contact test, live ----------------------------------
    upRef.set(0, 1, 0).applyQuaternion(car.quaternion);
    if (upRef.y < UPRIGHT_DOT) continue;    // vertical ray only stands in while level
    samples++;
    for (let i = 0; i < car.wheels.length; i++) {
      const wh = car.wheels[i];
      if (wh.grounded === true) continue;
      const hp = wh.hp;
      hub.set(hp.x, hp.top, hp.z).applyQuaternion(car.quaternion).add(car.position);
      const r = phys.raycast(hub.x, hub.y + 12, hub.z, 0, -1, 0, 60, phys.MASK.WORLD);
      if (!r.hit) continue;
      const hover = hub.y - wh.len - hp.radius - r.point.y;
      // Below the tyre and close: a contact this wheel has and is not being
      // given. A ray that lands ABOVE the tyre found an overhang — a bridge
      // soffit, an awning — which is the two queries disagreeing about which
      // surface is meant, not a denied contact, so it is excluded by the lower
      // bound rather than counted as a spectacular one.
      if (hover < -0.05 || hover > DENY_TOL) continue;
      denied++;
      if (!deniedWorst || hover < deniedWorst.hover) {
        deniedWorst = { w: i, hover: +hover.toFixed(3), len: +wh.len.toFixed(3), max: +hp.max.toFixed(3) };
      }
    }
  }
  const nose = new V(0, 0, 1).applyQuaternion(car.quaternion);
  const moved = car.position.clone().sub(from);
  const launch = moved.dot(nose);           // SIGNED, along the car's own nose
  const driven = measure();
  veh.setInput(car, { throttle: 0, brake: 0, steer: 0, handbrake: false });
  veh.despawn(car);

  return {
    settled,
    driven,
    launch: +launch.toFixed(2),
    peak: +peak.toFixed(2),
    bumped,
    denied,
    deniedWorst,
    samples,
    travel: +moved.length().toFixed(2),
  };
};

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await pump(120);

  // ---- sites: from the ROAD GRAPH, evenly across the whole city -----------
  const sites = await page.evaluate((n) => {
    const e = window.__ENGINE__;
    const roads = e.ctx.peek('world').roads;
    const V = e.camera.position.constructor;
    const a = new V(), ahead = new V();
    const out = [];
    const step = Math.max(1, Math.floor(roads.edges.length / n));
    for (let i = 0; i < roads.edges.length && out.length < n; i += step) {
      const ed = roads.edges[i];
      if (!ed) continue;
      const id = ed.id ?? i;
      roads.laneCenter(id, 0, 0.5, a);
      roads.laneCenter(id, 0, 0.56, ahead);
      const dx = ahead.x - a.x, dz = ahead.z - a.z;
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
      // A vehicle's nose is +Z, so a heading d needs yaw = atan2(d.x, d.z).
      out.push({
        id, x: a.x, y: a.y, z: a.z, kind: ed.kind,
        yaw: Math.hypot(dx, dz) > 0.05 ? Math.atan2(dx, dz) : 0,
      });
    }
    return out;
  }, N);

  if (sites.length < 8) throw new Error(`only ${sites.length} lane sites — the road graph is empty`);

  // ---- self-check: the rig can drive a car at all -------------------------
  //
  // Without this, a build where `setInput` silently did nothing would report
  // every site red and read as a catastrophic world defect.
  const control = await page.evaluate(RUN_SITE, { s: sites[0], TYPE, SETTLE, DRIVE, UPRIGHT_DOT, DENY_TOL });
  if (control.err || !(control.peak > MIN_PEAK) || control.settled.down < MIN_DOWN) {
    console.log(`SELF-CHECK FAILED on ${TYPE} at the first lane site: ` +
      `peak ${control.peak} m/s over ${control.launch} m, wheels down ${control.settled?.down}. ` +
      `The rig cannot drive a car on a road, so the site numbers below would be noise.`);
    console.log(JSON.stringify(control, null, 1));
    process.exitCode = 1;
    throw new Error('self-check');
  }

  const rows = [];
  for (const s of sites) {
    const r = await page.evaluate(RUN_SITE, { s, TYPE, SETTLE, DRIVE, UPRIGHT_DOT, DENY_TOL });
    rows.push({ s, r });
    const odd = !!r.err || r.settled.down < MIN_DOWN ||
      (Math.abs(r.settled.grade) <= MAX_GRADE && r.bumped === 0 && r.peak <= MIN_PEAK);
    if (VERBOSE || odd) {
      console.log(
        `  ${odd ? 'BAD ' : 'ok  '}` +
        `edge${String(s.id).padStart(4)} ${String(s.kind).padEnd(9)} (${s.x.toFixed(0)}, ${s.z.toFixed(0)})  ` +
        (r.err ? r.err : `settled ${r.settled.down}/4 hover ${r.settled.worstHover} up ${r.settled.upDot} grade ${(r.settled.grade * 100).toFixed(0)}%` +
          ` | peak ${r.peak} m/s over ${r.launch} m, ${r.driven.down}/4, bumped ${r.bumped}` +
          (r.settled.inWater ? ' [IN WATER]' : ''))
      );
      if (odd && r.settled) console.log('        ' + JSON.stringify(r.settled.wheels));
    }
  }

  /*
   * WHAT EACH SITE IS ALLOWED TO BE GRADED ON.
   *
   * A gate has to own its test conditions or its failures are noise every
   * future agent re-diagnoses. Three classes, and every one of them is counted
   * out loud below rather than silently skipped:
   *
   *   WATER      the car is floating. Buoyancy is not a suspension result, and
   *              grading it as one is exactly the ghost `tools/playprobe.mjs`
   *              manufactured for months behind a `surface !== 'water'` guard
   *              that could never fire.
   *   STEEP      the ground under the car, measured by THIS probe's own rays,
   *              rises more than `MAX_GRADE` over the wheelbase. Steel City has
   *              Pittsburgh's hills; a front-wheel-drive sedan sliding back down
   *              a 1-in-4 is terrain, not a contact patch.
   *   TIPPED     the car did not settle upright. The strict per-wheel test
   *              compares a VERTICAL ray against a ray cast along the BODY's
   *              -up, and those two only agree while the body is near level;
   *              asserting across a 35 degree lean would be measuring the angle
   *              between the two queries, not the defect.
   *
   * The first assertion — the one this file exists for — runs on every upright
   * sample, settled AND after the launch, which is where a car that has just
   * climbed a kerb is found.
   */
  const dry = rows.filter((x) => !x.r.err && !x.r.settled?.inWater);
  const wet = rows.filter((x) => x.r.settled?.inWater).length;
  const errored = rows.filter((x) => x.r.err).length;
  const upright = (m) => m && m.upDot >= UPRIGHT_DOT;
  const flat = dry.filter((x) => Math.abs(x.r.settled.grade) <= MAX_GRADE);
  const level = dry.filter((x) => upright(x.r.settled));
  const tipped = dry.length - level.length;

  /*
   * THE DEFECT, STATED AS A MEASUREMENT.
   *
   * A wheel that reports airborne while an independent vertical ray finds the
   * road within `DENY_TOL` of the bottom of the tyre is a wheel being DENIED a
   * contact it has. That is the whole bug: pre-fix these read `len === max`
   * exactly, with the road 1-6 cm further down, and contributed no spring and
   * no tyre force — which on a front-wheel-drive car is all of the drive.
   *
   * `DENY_TOL` is well inside `GROUND_REACH` (0.15 m) so a genuinely airborne
   * wheel — a jump, a ledge, a bridge edge — never registers, and well outside
   * the ~2 cm the two ray directions can disagree by at `UPRIGHT_DOT`.
   */
  const denied = [];
  let deniedFrames = 0;
  let deniedSamples = 0;
  for (const x of dry) {
    deniedSamples += x.r.samples ?? 0;
    if (!(x.r.denied > 0)) continue;
    deniedFrames += x.r.denied;
    const d = x.r.deniedWorst;
    denied.push(`edge${x.s.id}@(${x.s.x.toFixed(0)},${x.s.z.toFixed(0)}) ${x.r.denied} wheel-frames, worst w${d.w} hover ${d.hover} m at len ${d.len}/${d.max}`);
  }

  const noDown = level.filter((x) => x.r.settled.down < MIN_DOWN);
  const hovering = level.filter((x) => (x.r.settled.minHover ?? 0) > HOVER_TOL);
  const openRoad = flat.filter((x) => x.r.bumped === 0);
  const blocked = flat.length - openRoad.length;
  const noLaunch = openRoad.filter((x) => !(x.r.peak > MIN_PEAK));

  const denyBudget = Math.max(1, Math.round(deniedSamples * DENY_RATE));
  check('no wheel is denied a contact it has',
    deniedFrames <= denyBudget,
    `${deniedFrames} wheel-frames airborne with the road inside ${DENY_TOL} m, of ${deniedSamples} upright frames ` +
    `on ${dry.length} sites (${(100 * deniedFrames / Math.max(1, deniedSamples)).toFixed(3)}%, RATCHET <= ${(DENY_RATE * 100).toFixed(1)}% = ${denyBudget})` +
    (denied.length ? ` — ${denied.slice(0, 6).join('; ')}` : ''));

  check(`a settled car has >= ${MIN_DOWN} wheels down`,
    noDown.length === 0,
    `${level.length - noDown.length}/${level.length} upright sites` +
    (noDown.length ? ` — floating: ${noDown.map((x) => `edge${x.s.id}@(${x.s.x.toFixed(0)},${x.s.z.toFixed(0)}) ${x.r.settled.down}/4`).join(', ')}` : ''));

  check('a car on drivable ground can put power down',
    noLaunch.length === 0,
    `${openRoad.length - noLaunch.length}/${openRoad.length} unobstructed sites under ${(MAX_GRADE * 100).toFixed(0)}% grade reached ${MIN_PEAK} m/s forward in ${DRIVE} frames` +
    (noLaunch.length ? ` — dead: ${noLaunch.map((x) => `edge${x.s.id}@(${x.s.x.toFixed(0)},${x.s.z.toFixed(0)}) peak ${x.r.peak} m/s, ${x.r.launch} m on ${(x.r.settled.grade * 100).toFixed(0)}%`).join(', ')}` : ''));

  check('a settled car has a tyre on the road',
    hovering.length === 0,
    `lowest corner: worst site ${Math.max(0, ...level.map((x) => x.r.settled.minHover ?? 0)).toFixed(3)} m up (want <= ${HOVER_TOL})` +
    `; highest corner anywhere ${Math.max(0, ...level.map((x) => x.r.settled.worstHover ?? 0)).toFixed(3)} m (road-surface residue, reported not gated)` +
    (hovering.length ? ` — floating: ${hovering.map((x) => `edge${x.s.id} ${x.r.settled.minHover} m`).join(', ')}` : ''));

  console.log(`\nsites: ${rows.length} total · ${level.length} upright · ${flat.length} under ${(MAX_GRADE * 100).toFixed(0)}% grade` +
    ` · excluded: ${wet} in water, ${tipped} tipped, ${blocked} run into something, ${errored} errored`);

  const w = Math.max(...results.map((r) => r.name.length));
  console.log('');
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`);
  console.log(`\n${results.length - failed}/${results.length} checks pass over ${dry.length} lane sites` +
    (wet ? ` (${wet} site${wet > 1 ? 's' : ''} in water, excluded)` : ''));
  if (errs.length) console.log(`\nconsole errors (${errs.length}):\n  ` + [...new Set(errs)].slice(0, 6).join('\n  '));
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  if (e.message !== 'self-check') {
    console.error('groundprobe failed:', e.message);
    console.error([...new Set(errs)].slice(0, 8).join('\n'));
    process.exitCode = 1;
  }
} finally {
  await b.close();
  server?.kill();
}
