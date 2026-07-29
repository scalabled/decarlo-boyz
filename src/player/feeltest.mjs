#!/usr/bin/env node
/**
 * Player feel bench — the only honest way to review a movement controller.
 *
 * Boots the real game in Chromium, disables the renderer, and drives the engine
 * one deterministic 1/60 step at a time while faking keyboard input. Then it
 * measures what actually happened.
 *
 *   node src/player/feeltest.mjs --port=5209
 *   node src/player/feeltest.mjs --port=5209 --json
 *
 * Nothing in the game depends on this file; it is a review tool. It is NOT in
 * `npm run gate` — see "WHY THIS IS NOT IN THE GATE" below.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * HOW THIS FILE DIED, AND THE RULE THAT KEEPS IT ALIVE (hard rule 12)
 *
 * It sat dead for a long time and nobody noticed, because nothing ran it. When
 * it was revived it scored 22/47, and almost every failure was the bench being
 * wrong rather than the game:
 *
 *   - `clearAhead` read `p.character.position`. `p.character` is the VISUAL
 *     `CharacterRig` and carries no position, so the whole bench threw before
 *     producing a single row.
 *   - the bob section read `rig.bobOffset.x/.y`, a field the two-solver rewrite
 *     deleted in favour of `bobPhase`.
 *   - `walk time to 90%` and `health refill time` both PASSED on a -1 sentinel
 *     that means "this never happened". A check that reports success for an
 *     event that did not occur is worse than no check.
 *   - the whole CoD-era block — lean, prone, slide, tactical sprint — asserted
 *     mechanics this game deliberately dropped when the controls were remapped
 *     to a GTA layout. `src/core/input.js` binds `leanLeft`/`leanRight`/`prone`
 *     to empty arrays; `PlayerSystem.sliding` is `get sliding() { return false }`.
 *     The lean rows were worse than dead: they pressed `KeyE`, which is now
 *     NEXT WEAPON, so the "lean" test was silently cycling the arsenal.
 *   - `bob amplitude` measured `ctx.camera.position` against `p.eyePosition`,
 *     and `CameraRig.applyTo` copies `rig.position` straight onto the camera —
 *     so it compared the camera to ITSELF and could only ever read 0.000.
 *
 * So the rule this file now follows everywhere:
 *
 *   MEASURE THE EMITTED ARTEFACT, AND MAKE SURE IT IS NOT THE SAME OBJECT THE
 *   CODE HANDED THE CAMERA.
 *
 * FOV comes off `ctx.camera.fov`. Camera kick comes off the emitted
 * `ctx.camera.quaternion`, differenced against a matched control run that got
 * no kick. Stance is proven by walking under a soffit, not by reading
 * `rig.eye`. Traversal limits are proven by where the body ends up, not by the
 * kind string. Nothing here reads a tuning constant.
 *
 * Every remaining threshold is either a literal from `tuning.js`'s authored
 * design intent (with the number written out, not imported) or is labelled
 * RATCHET with its goal beside it (hard rule 13): lower a RATCHET when you
 * improve it, never raise one to make a run go green.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * NEGATIVE CONTROL — what makes the 54 mean something
 *
 * Three real bugs were fixed alongside this rewrite. Reverting all three and
 * changing nothing else scores **46/54**, and the eight rows that go red are
 * exactly the eight that describe them:
 *
 *   reverted `LedgeProbe` reach clamp (movement.js supportY + mantle.js reachY)
 *     2.6 m wall refuses a jump      false -> TRUE   (he ends up on top)
 *     2.6 m wall: no ledge event     none  -> mantle@1.83
 *     2.6 m wall: peak rise          0.94  -> 3.56 m
 *   reverted `LedgeProbe._standable` step-height lift
 *     auto-vault reports vault       vault -> mantle
 *     auto-vault crossing time       0.650 -> 0.817 s
 *     auto-vault keeps momentum      1     -> 12 stalled frames
 *   reverted the damage bearing origin (health.js)
 *     damage bearing: right          1.560 -> 0.857 rad
 *     damage bearing: left          -1.560 -> -0.901 rad
 *     damage bearing: behind         3.136 -> 2.884 rad
 *
 * `damage bearing: front` stays green in BOTH arms and is not a control: a
 * shooter directly ahead is almost collinear with the camera-to-body axis, so
 * that is the one direction the parallax bug could not corrupt.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT IN THE GATE
 *
 * `npm run gate` is lint (0.1 s) + syntaxcheck (1 s) + headprobe (5 s), and is
 * run constantly. This bench boots vite, boots the whole engine, and then steps
 * ~9 000 deterministic frames of gameplay; it cannot be made to take "a few
 * seconds" because the boot alone is ~12 s. Putting 45 s on every gate run is a
 * tax paid all day.
 *
 * It is therefore on the PRE-HANDOFF list instead. `npm run handoff` is
 *
 *     gate  ->  camtest (32)  ->  drivetest (83)  ->  feeltest (54)
 *
 * about 2.5 minutes end to end, and `npm run feel` is this file on its own.
 * Run `handoff` before you hand work back if you touched `src/player/`.
 *
 * `playprobe` and `playtest` are deliberately NOT in that chain even though
 * they are on the must-pass list. Both are INTERMITTENT: over eight runs of one
 * unchanged build, `playprobe` scored 28/28 five times and 25-27/28 three
 * times, with three unrelated symptom families (a car reporting
 * `wheelsDown: 0, surface: null`; a player who never leaves the spawn). The
 * same distribution appears with player changes reverted, so it is not
 * player-side. Chaining a harness that fails on its own two runs in five with
 * `&&` teaches everyone to ignore the chain, which is the exact failure mode
 * this file is a monument to. Run them separately and re-run before believing
 * a failure.
 *
 * `moveprobe.mjs` is not in the chain either — it takes 14.5 minutes. Its own
 * header explains why and how to cut it down while iterating.
 *
 * The rot vector that actually killed it — the file silently ceasing to PARSE —
 * is closed separately and mechanically: `npm run gate` runs
 * `tools/syntaxcheck.mjs`, which `node --check`s every `.mjs` under `src/` and
 * `tools/`, this file included.
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
const PORT = Number(args.port ?? 5209);

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
    cwd: root,
    stdio: 'ignore',
  });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(PORT)) return p;
  }
  p.kill();
  throw new Error('vite failed to start');
}

const t0 = Date.now();
const server = await ensureServer();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

let result = null;
let failed = null;
try {
  await page.goto(`http://127.0.0.1:${PORT}/?capture=1`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 90000 });
  result = await page.evaluate(runBench);
} catch (e) {
  failed = e;
} finally {
  await browser.close();
  if (server) server.kill();
}

if (failed) {
  console.error(logs.slice(-30).join('\n'));
  console.error(String(failed.message ?? failed));
  process.exit(1);
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  report(result, (Date.now() - t0) / 1000);
}

/* ===================================================================== */

function report(r, wallSeconds) {
  const rows = [];
  const fmt = (v) => (typeof v === 'number' ? (Math.abs(v) < 100 ? v.toFixed(3) : v.toFixed(1)) : String(v));
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  /** `note` is printed under the table; prefix it RATCHET when it is one. */
  const row = (name, got, want, ok, note = null) => {
    rows.push({ test: name, measured: fmt(got), expected: want, ok: ok ? 'PASS' : 'FAIL', note });
  };

  /* ---- gaits. GTA model: no sprint key = JOG, and the character re-faces
   * instead of strafing, so every direction runs at the same speed. The old
   * 4.57 / 4.2 / 3.66 / 7.01 / 8.38 / 2.44 numbers were the inherited CoD
   * ladder and are gone. tuning.js authors walk 1.72 / jog 3.35 / crouch 1.48
   * / aim 1.9, and DESIGN.md gives the sprint per brother. ------------------ */
  row('jog top speed', r.gait.jog, '3.35 m/s', near(r.gait.jog, 3.35, 0.12));
  row('sprint top speed', r.gait.sprint, '6.4 m/s (Carson)', near(r.gait.sprint, 6.4, 0.15),
    'DESIGN.md run speed for the DEFAULT brother. Fails loudly if the default changes — which is a review, not a bug.');
  row('right = jog speed', r.gait.right, '= jog +-0.1', near(r.gait.right, r.gait.jog, 0.1),
    'GTA re-facing: the body turns and runs, there is no strafe penalty unless aiming.');
  row('back = jog speed', r.gait.back, '= jog +-0.1', near(r.gait.back, r.gait.jog, 0.1));
  row('crouch speed', r.gait.crouch, '1.48 m/s', near(r.gait.crouch, 1.48, 0.12));
  row('aim speed', r.gait.aim, '1.90 m/s', near(r.gait.aim, 1.9, 0.12));
  row('time to 3.0 m/s', r.gait.t30, '0.09-0.30 s', r.gait.t30 > 0.09 && r.gait.t30 < 0.3,
    'Replaces a "time to 90%" row that measured -1 (never reached) and PASSED on the sentinel.');
  row('stop time from jog', r.gait.stopJog, '0.08-0.30 s', r.gait.stopJog > 0.08 && r.gait.stopJog < 0.3);
  row('stop time from sprint', r.gait.stopSprint, '0.40-0.85 s',
    r.gait.stopSprint > 0.4 && r.gait.stopSprint < 0.85);
  row('sprint stop has weight', r.gait.stopSprint - r.gait.stopJog, '> +0.20 s',
    r.gait.stopSprint - r.gait.stopJog > 0.2,
    'A sprint must roll off, not stop dead — the difference IS the weight.');
  row('air control ratio', r.air.controlRatio, '0.15-0.40', r.air.controlRatio > 0.15 && r.air.controlRatio < 0.4);

  /* ---- FOV, read off the EMITTED camera. Third person wants ~62 deg from an
   * 80 deg first-person config value; the old 57.6 / >82 rows were the
   * first-person ladder. ---------------------------------------------------- */
  row('rest fov (emitted)', r.fov.rest, '62.0 deg', near(r.fov.rest, 62.0, 0.8));
  row('aim fov (emitted)', r.fov.aim, '47.4 deg', near(r.fov.aim, 47.4, 1.0));
  row('aim narrows the frame', r.fov.rest - r.fov.aim, '> 12 deg', r.fov.rest - r.fov.aim > 12);
  row('sprint widens the frame', r.fov.sprint - r.fov.rest, '+4 to +12 deg',
    r.fov.sprint - r.fov.rest > 4 && r.fov.sprint - r.fov.rest < 12);

  /* ---- jump -------------------------------------------------------------- */
  row('jump apex', r.jump.apex, '0.95 m', near(r.jump.apex, 0.95, 0.07),
    'Authored in tuning.js and independently measured by moveprobe.mjs over 60+ jumps.');
  row('air time', r.jump.airTime, '0.52-0.70 s', r.jump.airTime > 0.52 && r.jump.airTime < 0.7,
    'Solved value is 0.61 s; the band is wide because a 60 Hz sampler quantises the first and last airborne frames.');
  row('sprint jump keeps speed', r.jump.sprintJumpSpeed, '> 5.5 m/s', r.jump.sprintJumpSpeed > 5.5,
    'Was "slide cancel speed kept". Slide is gone; jumping out of a sprint is the surviving mechanic and is worth gating.');

  /* ---- landing. The positional dip channel is NOT the artefact a player
   * sees here — see the RATCHET note. The emitted camera PITCH is. --------- */
  row('landing kick (emitted pitch)', r.land.kickDeg, '> 0.50 deg', r.land.kickDeg > 0.5,
    'RATCHET. Goal: a landing should also SETTLE the camera vertically. It barely does — ' +
    'CAMERA.land.dipImpulse through a 3.2 Hz / 0.56 spring can only ever emit ~0.033 m, and an ' +
    '11.3 m/s landing measured 0.021 m. Almost all of the felt impact is this pitch kick plus trauma. ' +
    'Raising the dip is a camera.js change and camera.js is gated at 32/32 by camtest.mjs by another ' +
    'agent, so it is deliberately NOT touched here. Lower this number only by raising the real dip.');
  row('landing kick settles', r.land.settleDeg, '< noise + 0.10 deg',
    Math.abs(r.land.settleDeg) < r.land.idleSpread + 0.1,
    'Measured against the idle run\'s own drift rather than against zero: the boom keeps easing for ' +
    'seconds after any teleport, so a fixed 0.10 deg bar would be gating that drift, not the kick.');
  row('idle camera is still', r.land.idleSpread, '< 0.25 deg', r.land.idleSpread < 0.25,
    'NEGATIVE CONTROL for the two rows above, and the noise floor the row above is measured against: ' +
    'same window, same settle, no fall.');
  row('land event speed', r.land.eventSpeed, '> 4 m/s', r.land.eventSpeed > 4);

  /* ---- footsteps + camera bob ------------------------------------------- */
  row('footsteps / 10 m jog', r.steps.jog, '9-12', r.steps.jog >= 9 && r.steps.jog <= 12,
    'The old 6-8 band was a 4.57 m/s CoD walk. A 3.35 m/s jog has a 1.86 m stride, i.e. ~10.8 steps per 10 m.');
  row('footsteps / 10 m sprint', r.steps.sprint, '6-10', r.steps.sprint >= 6 && r.steps.sprint <= 10);
  row('jog step gap', r.steps.jogGap, '0.75-1.20 m', r.steps.jogGap > 0.75 && r.steps.jogGap < 1.2,
    'RATCHET on the upper bound. Goal is 0.93 m — GAIT.jog authors a 1.86 m stride, i.e. two plants per ' +
    'stride. The emitted plants come 1.07 m apart, ~15 % long, which means the foot is covering more ' +
    'ground between plants than the gait says it should: the same family as the foot-slide RATCHETs in ' +
    'src/peds/gaitprobe.mjs, and content work rather than maths. Lower the 1.20 as the plants tighten. ' +
    'The measurement itself (mean distance between consecutive EMITTED footstep positions) is far ' +
    'steadier than a raw count, which gains or loses a whole step at the 10 m cutoff.');
  row('sprint step gap is longer', r.steps.sprintGap - r.steps.jogGap, '> +0.20 m',
    r.steps.sprintGap - r.steps.jogGap > 0.2,
    'Two emitted signals against each other: the footstep event stream against the emitted body position. ' +
    'Authored strides are 1.86 m jogging and 2.64 m sprinting, i.e. gaps of 0.93 and 1.32.');
  row('footstep surfaces', r.steps.surfaces.join(','), 'non-empty', r.steps.surfaces.length > 0);
  row('camera bob while jogging', r.bob.jog, '0.005-0.05 m', r.bob.jog > 0.005 && r.bob.jog < 0.05,
    'Emitted camera height over the emitted feet, detrended with a 21-frame moving average so road camber cancels.');
  row('no bob standing still', r.bob.idle, '< 0.004 m', r.bob.idle < 0.004,
    'NEGATIVE CONTROL for the row above.');

  /* ---- stance, proven behaviourally instead of by reading rig.eye -------- */
  row('standing blocked by 1.35 m soffit', r.stance.standTravel, 'stops short', r.stance.standBlocked,
    'A 1.78 m capsule cannot fit under a 1.35 m soffit. Replaces a row that read the internal `rig.eye`.');
  row('crouched passes under it', r.stance.crouchTravel, 'gets through', r.stance.crouchPassed,
    'POSITIVE CONTROL: the same slab, the same run, a 1.12 m capsule.');
  row('crouch lowers the head', r.stance.headDrop, '> 0.35 m', r.stance.headDrop > 0.35,
    '`headPosition` is the published point every line-of-sight, blast and near-miss test in the game uses.');

  /* ---- traversal --------------------------------------------------------- */
  row('auto-vault clears 0.55 m', r.vault.cleared, 'true', r.vault.cleared === true);
  row('auto-vault keeps momentum', r.vault.stallFrames, '< 6 frames', r.vault.stallFrames < 6,
    'Longest run of consecutive frames whose EMITTED ground speed (differenced body position, 3-frame ' +
    'mean) is under 1 m/s while crossing the barrier at a sprint. This is the observable form of the old ' +
    '"auto-vault fired: vault" row and cannot be fooled by a kind string. `horizontalSpeed` is useless ' +
    'here: `_beginLedge` zeroes the velocity vector for BOTH kinds, so it reads 0.00 either way. The ' +
    'MINIMUM speed is useless too — both curves have zero derivative at their joins, on purpose. The ' +
    'DURATION of the stall is what differs: a vault only touches zero at the two joins, a mantle rises ' +
    'first and parks the body for a third of a second. Measured 1 frame vaulting vs 12 mantling.');
  row('auto-vault crossing time', r.vault.crossTime, '< 0.75 s', r.vault.crossTime > 0 && r.vault.crossTime < 0.75,
    'The same event in the time domain. Unobstructed sprint over the 3 m window is 0.47 s.');
  row('auto-vault reports vault', r.vault.kinds.join(',') || 'none', 'vault', r.vault.kinds.includes('vault'),
    'The vault/mantle distinction still exists (`ledgeKindName`), so the classification is still worth gating — ' +
    'but the row above is the one that would catch a regression the naming survived.');
  row('mantle 1.15 m', r.mantle.ok, 'on top', r.mantle.ok);
  row('mantle duration', r.mantle.duration, '0.40-1.05 s', r.mantle.duration > 0.4 && r.mantle.duration < 1.05,
    'A rooted climb, not a teleport and not a cutscene. The band is wide on purpose: the motion picks a ' +
    'fast or a slow profile at MOVE.mantle.autoVaultMax (0.85 m ABOVE THE FEET), and where the feet are ' +
    'depends on the local camber under the runway, so the same 1.15 m slab can land either side of it. ' +
    'The measured obstacle height is printed in the notes.');
  row('1.95 m wall IS climbable', r.reach.lowClimbed, 'true', r.reach.lowClimbed === true,
    'POSITIVE CONTROL for the two rows below: proves the rejection is a height limit and not a broken mantle.');
  row('2.6 m wall refuses a jump', r.reach.highClimbed, 'false', r.reach.highClimbed === false,
    'THE traversal exploit. MOVE.mantle.maxHeight is 2.0 m, but reach was measured from the airborne feet, ' +
    'so a 0.95 m jump bought a 2.95 m ceiling. Before the fix: 2.4 m wall -> mantle@1.63, 2.6 m -> mantle@1.83, ' +
    'player standing on top of both. Run at the wall and TAP jump — holding it only jumps once and misses this.');
  row('2.6 m wall: no ledge event', r.reach.highKinds.join(',') || 'none', 'none', r.reach.highKinds.length === 0);
  row('2.6 m wall: peak rise is a jump', r.reach.highRise, '< 1.15 m', r.reach.highRise < 1.15,
    'The old row asked for feet above 0.9 m, which JUMP_APEX 0.95 clears on flat ground — so it read FAIL ' +
    'on a build that was rejecting the wall correctly. Any threshold here must sit above the free jump.');
  row('stairs climbed', r.stairs.climbed, '> 0.5 m', r.stairs.climbed > 0.5);
  row('stairs not vaulted', r.stairs.ledgeEvents.join(',') || 'none', 'none', r.stairs.ledgeEvents.length === 0);

  /* ---- health ------------------------------------------------------------ */
  row('regen holds off', r.health.at45, 'no gain by 4.5 s', r.health.at45 === false,
    'The delay is authored 5.0 s. The old 4.4-5.2 window read 5.267 only because the low-health-pass ' +
    'probe two lines above it had ASSIGNED health = 55, so the number it gated was an accident.');
  row('regen delay', r.health.regenStart, '4.8-5.4 s', r.health.regenStart > 4.8 && r.health.regenStart < 5.4);
  row('regen caps at half', r.health.plateauFrac, '0.48-0.52', r.health.plateauFrac > 0.48 && r.health.plateauFrac < 0.52,
    'Replaces "health refill time < 4 s", which PASSED on a -1 sentinel. GTA regenerates to half and stops; ' +
    'this asserts the plateau, so it fails if regen ever runs away to full.');
  row('damage bearing: right', r.health.right, '+1.571 rad', near(r.health.right, 1.5708, 0.06),
    'Was 0.857. The bearing was taken from the CAMERA POSITION, 3.4 m behind the body, so parallax turned ' +
    '90 deg into 49 deg. Frame is still the camera YAW (the arc is drawn in screen space); only the origin moved.');
  row('damage bearing: left', r.health.left, '-1.571 rad', near(r.health.left, -1.5708, 0.06));
  row('damage bearing: front', Math.abs(r.health.front), '< 0.10 rad', Math.abs(r.health.front) < 0.1);
  row('damage bearing: behind', Math.abs(r.health.behind), '> 3.05 rad', Math.abs(r.health.behind) > 3.05,
    'The worst case of the old bug: a hit from directly behind read -2.886 rad, and the camera punch is ' +
    'aimed with sin(angle), so it kicked sideways for a shot that should kick straight.');
  row('low-health pass on', r.health.passEnabled, 'true', r.health.passEnabled === true);

  /* ---- recoil, differenced against a matched no-kick run ----------------- */
  row('recoil peak (emitted)', r.recoil.peak, '> 1.0 deg', r.recoil.peak > 1.0,
    'A/B on the emitted camera quaternion: identical 100-frame run with and without the kick, differenced ' +
    'frame by frame. The rig spring is never read, so a rename cannot silence this.');
  row('recoil returns (emitted)', r.recoil.residual, '< 0.05 deg', r.recoil.residual < 0.05);

  const pad = (s, n) => String(s).padEnd(n);
  console.log('');
  console.log(pad('TEST', 32) + pad('MEASURED', 14) + pad('EXPECTED', 20) + 'RESULT');
  console.log('-'.repeat(78));
  for (const x of rows) {
    console.log(pad(x.test, 32) + pad(x.measured, 14) + pad(x.expected, 20) + x.ok);
  }
  const fails = rows.filter((x) => x.ok === 'FAIL');
  console.log('-'.repeat(78));
  console.log(`${rows.length - fails.length}/${rows.length} pass    (${wallSeconds.toFixed(1)} s wall clock)`);

  const ratchets = rows.filter((x) => x.note?.startsWith('RATCHET'));
  if (ratchets.length) {
    console.log('\nRATCHET thresholds — lower them when you improve them, never raise them:');
    for (const x of ratchets) console.log(`  ${x.test}\n    ${wrap(x.note, 4)}`);
  }
  const annotated = rows.filter((x) => x.note && !x.note.startsWith('RATCHET'));
  if (annotated.length) {
    console.log('\nwhy these thresholds:');
    for (const x of annotated) console.log(`  ${x.test}\n    ${wrap(x.note, 4)}`);
  }
  if (r.notes?.length) console.log('\nnotes:\n  ' + r.notes.join('\n  '));
  if (fails.length) process.exitCode = 1;
}

function wrap(s, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  let line = '';
  for (const w of s.split(' ')) {
    if (line.length + w.length > 92) { out.push(line); line = ''; }
    line += (line ? ' ' : '') + w;
  }
  if (line) out.push(line);
  return out.join('\n' + pad);
}

/* ===================================================================== */
/* everything below runs inside the page                                 */
/* ===================================================================== */

function runBench() {
  const eng = window.__ENGINE__;
  const p = eng.ctx.get('player');
  const phys = eng.ctx.get('physics');
  const notes = [];
  eng.stop();

  // Renderer off: this bench steps thousands of frames and does not look at one.
  const render = eng.ctx.peek('render');
  const realRender = render.render;
  render.render = () => {};

  const input = eng.input;
  const DT = 1 / 60;
  const dn = (c) => input._pendingDown.add(c);
  const up = (c) => input._pendingUp.add(c);
  const release = () => {
    for (const c of [...input.down]) input._pendingUp.add(c);
    input._pendingDown.clear();
  };
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) eng.step();
  };
  const settle = (n = 40) => {
    release();
    step(n);
  };

  /**
   * THE EMITTED CAMERA. Not `p.cameraRig`, and not `p.eyePosition` — which is
   * `rig.position`, the very vector `CameraRig.applyTo` copies onto the camera.
   * Comparing those two is comparing a value to itself; it is how the old bob
   * rows could only ever print 0.000.
   */
  const cam = eng.ctx.camera;
  /** Emitted camera pitch, radians, from the quaternion the renderer will use. */
  const camPitch = () => {
    const q = cam.quaternion;
    return Math.asin(Math.max(-1, Math.min(1, -2 * (q.y * q.z - q.w * q.x))));
  };
  const DEG = 180 / Math.PI;

  // A flat, open piece of the level to test on.
  const world = eng.ctx.peek('world');
  const base = { x: 0, y: 0, z: 0, yaw: 0, fx: 0, fz: -1 };
  const place = (lane = 0, index = 0, pitchYaw = null) => {
    const sp = world?.spawn?.(index);
    // Face the way the spawn faces: that is the one direction with a long clear
    // runway. Walking on a world axis from here goes straight into a facade.
    const yaw = pitchYaw ?? (sp?.yaw ?? 0);
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const gx = (sp ? sp.position.x : 0) + rx * lane;
    const gz = (sp ? sp.position.z : 0) + rz * lane;
    const gy = phys.groundHeight(gx, gz, (sp ? sp.position.y : 0) + 8);
    const feet = Number.isFinite(gy) ? gy : 0;
    base.x = gx; base.y = feet; base.z = gz;
    base.yaw = yaw; base.fx = fx; base.fz = fz;
    p.teleport({ x: gx, y: feet + 1.66, z: gz }, yaw);
    p.health.reset(true);
    p.health.effect = 0;
    step(4);
  };
  /** Point `d` metres in front of the placed player. */
  const ahead = (d) => ({ x: base.x + base.fx * d, z: base.z + base.fz * d });
  /** How far forward of the placement the body has actually travelled. */
  const forwardTravel = () =>
    (p.feetPosition.x - base.x) * base.fx + (p.feetPosition.z - base.z) * base.fz;

  /** Is there `d` metres of empty corridor in front of us? */
  const clearAhead = (d) => {
    // `p.character` is the VISUAL CharacterRig and carries no position — it
    // never did in this form, so this threw on the first runway hunt and took
    // the whole bench with it. The player's own foot position is the authority
    // (`get feetPosition()` -> movement.position), and it is what the capsule
    // being cast actually stands on.
    const c = p.feetPosition;
    const a = { x: c.x, y: c.y + 0.36, z: c.z };
    const b = { x: c.x, y: c.y + 1.62, z: c.z };
    const hit = phys.capsuleCast(a, b, 0.3, { x: base.fx, y: 0, z: base.fz }, d, phys.MASK.CHARACTER);
    return !hit.hit;
  };

  /**
   * Obstacle tests need a genuinely empty runway — the level is dense with
   * stalls and barriers, and a leftover prop in the path is indistinguishable
   * from a controller bug. Hunt for one instead of assuming it.
   */
  const placeClear = (runway = 6, label = '', yaws = null) => {
    for (let idx = 0; idx < 8; idx++) {
      const sp = world?.spawn?.(idx);
      const candidates = yaws ?? [sp?.yaw ?? 0];
      for (const yaw of candidates) {
        for (const lane of [0, 2, -2, 4, -4]) {
          place(lane, idx, yaw);
          if (clearAhead(runway)) return true;
        }
      }
    }
    notes.push(`${label}: no clear ${runway} m runway found; result unreliable`);
    return false;
  };
  /** Headings where an axis-aligned test slab is hit square-on. */
  const AXIS_YAWS = [0, Math.PI, Math.PI / 2, -Math.PI / 2];

  const events = { steps: [], lands: [], states: [], mantles: [] };
  eng.events.on('player:footstep', (e) =>
    events.steps.push({ surface: e.surface, running: e.running, x: e.position.x, z: e.position.z }));
  eng.events.on('player:land', (e) => events.lands.push({ v: e.velocity, surface: e.surface }));
  eng.events.on('player:state', (e) => events.states.push(e.state));
  eng.events.on('player:mantle', (e) => events.mantles.push({ kind: e.kind, height: e.height }));

  /* ---- helpers -------------------------------------------------------- */

  /** Hold keys for `frames` steps and return the peak horizontal speed. */
  function topSpeed(keys, frames, each) {
    for (const k of keys) dn(k);
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      step(1);
      peak = Math.max(peak, p.horizontalSpeed);
      if (each) each(i);
    }
    return peak;
  }

  /** Seconds from release until the body is effectively stopped. */
  function stopTime(limit = 240) {
    release();
    const t = eng.time.elapsed;
    for (let i = 0; i < limit; i++) {
      step(1);
      if (p.horizontalSpeed < 0.15) return eng.time.elapsed - t;
    }
    return -1;
  }

  /**
   * Emitted camera height over the emitted feet, with a 21-frame moving average
   * removed. The average is ~0.35 s of travel, so road camber and the boom's
   * own slow speed response cancel and what is left is the step channel.
   */
  function camResidual(frames, keys) {
    const rel = [];
    for (const k of keys) dn(k);
    for (let i = 0; i < frames; i++) {
      step(1);
      rel.push(cam.position.y - p.feetPosition.y);
    }
    release();
    step(15);
    const W = 21;
    let lo = 1e9, hi = -1e9;
    for (let i = W; i < rel.length - W; i++) {
      let s = 0;
      for (let k = -W; k <= W; k++) s += rel[i + k];
      const v = rel[i] - s / (2 * W + 1);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi > lo ? (hi - lo) * 0.5 : 0;
  }

  /** Axis-aligned box registered straight into the collision world. */
  function addBox(cx, cy, cz, hx, hy, hz, name) {
    const v = [
      [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz],
      [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz],
      [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz],
      [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz],
    ];
    const q = [
      [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7],
      [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0],
    ];
    const tris = new Float32Array(q.length * 2 * 9);
    let o = 0;
    for (const [a, b, c, d] of q) {
      for (const idx of [a, b, c, a, c, d]) {
        tris[o++] = v[idx][0]; tris[o++] = v[idx][1]; tris[o++] = v[idx][2];
      }
    }
    const id = phys.staticWorld.addTriangles(tris, q.length * 2, 'concrete', phys.LAYER.STATIC, name);
    phys.rebuildStatic();
    return id;
  }
  /** A slab across the runway, `alongZ` chosen from the heading we settled on. */
  function addSlab(dist, yLo, yHi, thickness, name) {
    const at = ahead(dist);
    const alongZ = Math.abs(base.fz) > 0.5;
    return addBox(
      at.x, base.y + (yLo + yHi) / 2, at.z,
      alongZ ? 1.7 : thickness, (yHi - yLo) / 2, alongZ ? thickness : 1.7,
      name
    );
  }
  const dropBox = (id) => { phys.removeStatic(id); phys.rebuildStatic(); step(4); };

  const out = { notes };

  /* ---- gaits ---------------------------------------------------------- */
  out.gait = {};
  place(0);
  {
    let t30 = -1;
    const t = eng.time.elapsed;
    out.gait.jog = topSpeed(['KeyW'], 80, () => {
      if (t30 < 0 && p.horizontalSpeed >= 3.0) t30 = eng.time.elapsed - t;
    });
    out.gait.t30 = t30;
    out.gait.stopJog = stopTime(120);
  }
  settle(); place(0);
  out.gait.right = topSpeed(['KeyD'], 70);
  settle(); place(0);
  out.gait.back = topSpeed(['KeyS'], 70);
  settle(); place(0);
  {
    out.gait.sprint = topSpeed(['KeyW', 'ShiftLeft'], 120);
    out.fov = { sprint: cam.fov };
    out.gait.stopSprint = stopTime(200);
  }
  settle(); place(0);
  {
    dn('ControlLeft'); step(2); up('ControlLeft'); step(30);
    out.gait.crouch = topSpeed(['KeyW'], 70);
    settle();
    dn('ControlLeft'); step(2); up('ControlLeft'); step(30);
  }
  settle(); place(0);
  {
    // `setAdsProgress` is the weapon POSE channel and no longer implies aiming
    // — that split is what stopped a carried rifle from disabling sprint. To
    // put the player in ADS from a harness, lock the aim STATE.
    p.setAimLock(1);
    out.gait.aim = topSpeed(['KeyW'], 70, () => p.setAimLock(1));
    out.fov.aim = cam.fov;
    release();
    p.setAimLock(null);
    step(30);
  }
  settle(); place(0); step(30);
  out.fov.rest = cam.fov;

  /* ---- jump ------------------------------------------------------------ */
  settle(); place(0);
  {
    const y0 = p.feetPosition.y;
    let apex = 0;
    let air = 0;
    dn('Space');
    for (let i = 0; i < 90; i++) {
      step(1);
      if (i === 2) up('Space');
      apex = Math.max(apex, p.feetPosition.y - y0);
      if (!p.grounded) air += DT;
      else if (i > 6) break;
    }
    out.jump = { apex, airTime: air };
  }
  // Jumping out of a sprint must not eat the speed. (Was "slide cancel".)
  settle(); place(0);
  {
    dn('KeyW'); dn('ShiftLeft');
    step(90);
    dn('Space'); step(3); up('Space');
    step(8);
    out.jump.sprintJumpSpeed = p.horizontalSpeed;
    out.jump.airborneAfter = !p.grounded;
    settle(50);
  }

  /* ---- air control ----------------------------------------------------- */
  settle(); place(0);
  {
    // Two frames only — long enough to measure accel, short enough that
    // neither case saturates at its top speed.
    dn('KeyD');
    step(2);
    const groundGain = p.horizontalSpeed;
    release(); step(30);
    // Air: same input, same window, from a standstill so `along` starts at 0.
    dn('Space'); step(2); up('Space'); step(6);
    const before = p.horizontalSpeed;
    dn('KeyD'); step(2);
    const airGain = p.horizontalSpeed - before;
    out.air = { controlRatio: groundGain > 0 ? airGain / groundGain : 0 };
    settle(50);
  }

  /* ---- landing: the EMITTED camera pitch, plus a matched idle control --- */
  place(0); step(30);
  {
    const pre = camPitch() * DEG;
    p.teleport({ x: base.x, y: base.y + 1.66 + 3.2, z: base.z }, base.yaw);
    events.lands.length = 0;
    let landFrame = -1;
    let peak = -1e9;
    for (let i = 0; i < 170; i++) {
      step(1);
      if (events.lands.length && landFrame < 0) landFrame = i;
      if (landFrame >= 0 && i - landFrame < 40) peak = Math.max(peak, camPitch() * DEG);
    }
    out.land = {
      kickDeg: landFrame >= 0 ? peak - pre : 0,
      settleDeg: camPitch() * DEG - pre,
      eventSpeed: events.lands.length ? events.lands[0].v : 0,
      surface: events.lands.length ? events.lands[0].surface : 'none',
    };
  }
  settle(); place(0); step(30);
  {
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i < 170; i++) {
      step(1);
      const v = camPitch() * DEG;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out.land.idleSpread = hi - lo;
  }

  /* ---- footsteps + camera bob ------------------------------------------ */
  const stepsPer10m = (keys) => {
    events.steps.length = 0;
    const x0 = p.feetPosition.x, z0 = p.feetPosition.z;
    for (const k of keys) dn(k);
    let dist = 0;
    for (let i = 0; i < 400; i++) {
      step(1);
      dist = Math.hypot(p.feetPosition.x - x0, p.feetPosition.z - z0);
      if (dist > 10) break;
    }
    release(); step(15);
    // Mean gap between consecutive EMITTED footstep positions = half a stride.
    // Steadier than the raw count, which gains or loses a whole step depending
    // on where in the gait cycle the 10 m cutoff happens to fall.
    let gapSum = 0, gapN = 0;
    for (let i = 1; i < events.steps.length; i++) {
      const a = events.steps[i - 1], b = events.steps[i];
      gapSum += Math.hypot(b.x - a.x, b.z - a.z);
      gapN++;
    }
    return {
      count: events.steps.length, dist,
      gap: gapN ? gapSum / gapN : 0,
      surfaces: [...new Set(events.steps.map((s) => s.surface))],
    };
  };
  settle(); place(0); step(20);
  const jogSteps = stepsPer10m(['KeyW']);
  settle(); place(0); step(20);
  const sprintSteps = stepsPer10m(['KeyW', 'ShiftLeft']);
  out.steps = {
    jog: jogSteps.count, sprint: sprintSteps.count,
    jogGap: jogSteps.gap, sprintGap: sprintSteps.gap,
    jogDist: jogSteps.dist, sprintDist: sprintSteps.dist,
    surfaces: [...new Set([...jogSteps.surfaces, ...sprintSteps.surfaces])],
  };
  notes.push(`footsteps: jog ${jogSteps.count} over ${jogSteps.dist.toFixed(2)}m ` +
    `(mean gap ${jogSteps.gap.toFixed(2)}m), sprint ${sprintSteps.count} over ` +
    `${sprintSteps.dist.toFixed(2)}m (mean gap ${sprintSteps.gap.toFixed(2)}m)`);

  settle(); place(0); step(25);
  out.bob = { jog: camResidual(170, ['KeyW']) };
  settle(); place(0); step(25);
  out.bob.idle = camResidual(170, []);

  /* ---- stance, proven by geometry the body either fits through or not --- */
  settle();
  out.stance = {};
  {
    const ok = placeClear(9, 'soffit', AXIS_YAWS);
    const SOFFIT = 3.4;
    // Bottom at 1.35 m: a 1.78 m standing capsule cannot fit, a 1.12 m
    // crouched one clears it by 0.23 m. The top is at 4 m so the ledge probe
    // cannot mistake it for something to climb onto.
    const id = addSlab(SOFFIT, 1.35, 4.0, 0.35, 'feeltest:soffit');
    dn('KeyW');
    for (let i = 0; i < 200; i++) step(1);
    out.stance.standTravel = forwardTravel();
    out.stance.standBlocked = ok && out.stance.standTravel < SOFFIT - 0.4;
    release(); step(10);

    place(0);
    dn('ControlLeft'); step(2); up('ControlLeft'); step(35);
    out.stance.crouchStance = p.stance;
    dn('KeyW');
    for (let i = 0; i < 320; i++) step(1);
    out.stance.crouchTravel = forwardTravel();
    out.stance.crouchPassed = ok && out.stance.crouchTravel > SOFFIT + 1.5;
    release(); step(10);
    dn('ControlLeft'); step(2); up('ControlLeft'); step(35);
    dropBox(id);
    notes.push(`soffit at ${SOFFIT}m: standing reached ${out.stance.standTravel.toFixed(2)}m, ` +
      `crouched reached ${out.stance.crouchTravel.toFixed(2)}m`);
  }
  settle(); place(0); step(25);
  {
    const stand = p.headPosition.y - p.feetPosition.y;
    dn('ControlLeft'); step(2); up('ControlLeft'); step(40);
    const crouch = p.headPosition.y - p.feetPosition.y;
    out.stance.headDrop = stand - crouch;
    out.stance.headStand = stand;
    out.stance.headCrouch = crouch;
    dn('ControlLeft'); step(2); up('ControlLeft'); step(35);
  }

  /* ---- auto vault (0.55 m) --------------------------------------------- */
  settle();
  placeClear(9, 'auto-vault', AXIS_YAWS);
  {
    const AT = 4.6;
    // A thin 0.55 m slab: low enough to clear without a key press, thin enough
    // that the far side is standable, so this must resolve as a VAULT (over and
    // beyond) rather than a mantle onto a top face.
    const tri0 = phys.stats.triangles;
    const id = addSlab(AT, 0.0, 0.55, 0.22, 'feeltest:vault');
    events.mantles.length = 0;
    dn('KeyW'); dn('ShiftLeft');
    let cleared = false;
    let enter = -1, exit = -1;
    /**
     * GROUND SPEED FROM THE EMITTED POSITION, NOT FROM `velocity`.
     *
     * `_beginLedge` zeroes the velocity vector and the rooted motion then drives
     * the capsule along a curve without ever writing it back, so `horizontalSpeed`
     * reads 0 through EVERY climb — vault and mantle alike. It cannot tell them
     * apart — but not by its MINIMUM, which is near zero for both: the vault
     * curve is `smoothstep(u)`, whose derivative is 6u(1-u) and therefore zero
     * at each end, deliberately, so the rooted motion joins the free run without
     * a velocity pop. What separates them is HOW LONG the body is stalled. A
     * vault only touches zero at the two joins; a mantle's first 62 % is pure
     * RISE, so horizontal progress stops for about a third of a second while he
     * hauls himself up. Count the stalled frames, do not take the minimum.
     */
    let prevX = p.feetPosition.x, prevZ = p.feetPosition.z;
    const win = [0, 0, 0];
    let wi = 0, wn = 0;
    let stall = 0, stallRun = 0;
    for (let i = 0; i < 220; i++) {
      step(1);
      const fp = p.feetPosition;
      win[wi] = Math.hypot(fp.x - prevX, fp.z - prevZ) / DT;
      wi = (wi + 1) % 3; wn++;
      prevX = fp.x; prevZ = fp.z;
      const d = forwardTravel();
      if (enter < 0 && d > AT - 1.5) enter = eng.time.elapsed;
      if (enter >= 0 && wn >= 3) {
        if ((win[0] + win[1] + win[2]) / 3 < 1.0) { stallRun++; stall = Math.max(stall, stallRun); }
        else stallRun = 0;
      }
      if (exit < 0 && d > AT + 1.5) { exit = eng.time.elapsed; cleared = true; break; }
    }
    out.vault = {
      ok: cleared,
      cleared,
      crossTime: enter >= 0 && exit >= 0 ? exit - enter : -1,
      stallFrames: stall,
      kinds: events.mantles.map((m) => m.kind),
    };
    notes.push(`auto-vault: kinds=${out.vault.kinds.join(',') || 'none'} cleared=${cleared} ` +
      `cross=${out.vault.crossTime.toFixed(3)}s (unobstructed sprint over 3 m is 0.47 s), ` +
      `longest stall below 1 m/s ${out.vault.stallFrames} frames`);
    release();
    dropBox(id);
    if (phys.stats.triangles !== tri0) notes.push(`vault box not removed (${tri0} -> ${phys.stats.triangles})`);
  }

  /* ---- mantle (1.15 m) ------------------------------------------------- */
  settle();
  placeClear(6, 'mantle');
  {
    const top = base.y + 1.15;
    const id = addSlab(2.6, 0.0, 1.15, 1.6, 'feeltest:mantle');
    events.mantles.length = 0;
    dn('KeyW'); dn('Space');
    let dur = 0;
    let ok = false;
    for (let i = 0; i < 240; i++) {
      step(1);
      if (p.mantling) dur += DT;
      if (!p.mantling && dur > 0) {
        ok = p.feetPosition.y > top - 0.2 && p.grounded;
        break;
      }
    }
    out.mantle = {
      ok, duration: dur,
      kinds: events.mantles.map((m) => m.kind),
      height: events.mantles.length ? events.mantles[0].height : 0,
    };
    notes.push(`mantle: kinds=${out.mantle.kinds.join(',') || 'none'} ` +
      `obstacle read as ${out.mantle.height.toFixed(2)}m above the feet ` +
      `(fast/slow profile splits at 0.85m), duration ${dur.toFixed(3)}s, ` +
      `rise above local ground=${(p.feetPosition.y - base.y).toFixed(2)}m (box top 1.15m)`);
    release();
    dropBox(id);
  }

  /* ---- reach ceiling: a wall he MAY climb and one he MAY NOT ------------
   * Run at it, then TAP jump repeatedly. Holding Space only jumps once, which
   * is exactly how the exploit hid: the single arc happened to be at the wrong
   * phase when the probe fired.                                             */
  const runAndJump = (wallHeight, label) => {
    settle();
    placeClear(6, label);
    const id = addSlab(2.6, 0.0, wallHeight, 0.8, `feeltest:${label}`);
    events.mantles.length = 0;
    dn('KeyW');
    step(50);
    let rise = 0;
    let mantled = false;
    for (let cycle = 0; cycle < 9; cycle++) {
      dn('Space'); step(3); up('Space');
      for (let i = 0; i < 22; i++) {
        step(1);
        rise = Math.max(rise, p.feetPosition.y - base.y);
        if (p.mantling) mantled = true;
      }
    }
    release(); step(15);
    const res = {
      rise, mantled,
      settled: p.feetPosition.y - base.y,
      kinds: events.mantles.map((m) => `${m.kind}@${m.height.toFixed(2)}`),
    };
    dropBox(id);
    notes.push(`${label} (${wallHeight}m): peak rise ${rise.toFixed(2)}m, ` +
      `settled ${res.settled.toFixed(2)}m, ledge events [${res.kinds.join(',') || 'none'}]`);
    return res;
  };
  const low = runAndJump(1.95, 'wall195');
  const high = runAndJump(2.6, 'wall260');
  out.reach = {
    lowClimbed: low.rise > 1.5 && low.mantled,
    highClimbed: high.rise > 1.15 || high.mantled,
    highRise: high.rise,
    highKinds: high.kinds,
    lowKinds: low.kinds,
  };

  /* ---- stairs ---------------------------------------------------------- */
  settle();
  placeClear(7, 'stairs');
  {
    const ids = [];
    // Riser 0.18 m, tread 0.30 m — a real staircase. Each step is a solid block
    // from the ground up, which is how level geometry actually authors them.
    for (let i = 0; i < 6; i++) {
      const top = 0.18 * (i + 1);
      const at = ahead(2.2 + i * 0.3);
      ids.push(addBox(at.x, base.y + top * 0.5, at.z, 1.5, top * 0.5, 0.16, `feeltest:stair${i}`));
    }
    const y0 = p.feetPosition.y;
    events.mantles.length = 0;
    dn('KeyW');
    // Peak height, not final: a 6-step flight is 1.8 m deep, so walking on for
    // three seconds takes you over the top and back down the far side.
    let peak = 0;
    for (let i = 0; i < 190; i++) {
      step(1);
      peak = Math.max(peak, p.feetPosition.y - y0);
    }
    out.stairs = { climbed: peak, travel: forwardTravel(), ledgeEvents: events.mantles.map((m) => m.kind) };
    notes.push(`stairs: climbed ${peak.toFixed(2)}m of 1.08m, travelled ${out.stairs.travel.toFixed(2)}m`);
    release();
    for (const id of ids) phys.removeStatic(id);
    phys.rebuildStatic();
    step(4);
  }

  /* ---- health ---------------------------------------------------------- */
  settle(); place(0);
  {
    /**
     * DAMAGE BEARINGS. Four cardinal shots at 4 m, read off the published
     * indicator. `place()` faces the spawn heading, so "right" is
     * (cos yaw, -sin yaw) — the ACTOR convention, where forward is
     * (-sin, -cos). A vehicle's nose is +Z and does NOT use this basis.
     */
    const bearing = (dx, dz) => {
      p.health.reset(true);
      const from = { x: base.x + dx * 4, y: base.y + 1.6, z: base.z + dz * 4 };
      p.applyDamage(20, from);
      const a = p.health.indicators.find((i) => i.active)?.angle ?? 0;
      step(3);
      return a;
    };
    const cy = Math.cos(base.yaw), sy = Math.sin(base.yaw);
    const right = bearing(cy, -sy);
    const left = bearing(-cy, sy);
    const front = bearing(-sy, -cy);
    const behind = bearing(sy, cy);

    const passEnabled = (() => {
      const keepValue = p.health.value;
      const keepEffect = p.health.effect;
      p.health.value = 20;
      p.health.effect = 0.9;
      p.lowHealthPass?.sync(p.health);
      const on = !!p.lowHealthPass?.enabled;
      // Put it back EXACTLY as found. The old version of this block left
      // health assigned to 55, and the regen rows below then gated a number
      // that had nothing to do with the damage they thought they were timing.
      p.health.value = keepValue;
      p.health.effect = keepEffect;
      return on;
    })();

    /**
     * REGEN. Armour soaks 72 % of a bullet, and Carson spawns with 60 of it,
     * so a 45-point shot leaves him at 117/130 — above the 50 % regen cap,
     * where regen never runs at all. Fall damage bypasses armour, which is the
     * honest way to put the body genuinely below the cap.
     */
    p.health.reset(true);
    const max = p.health.max;
    p.applyDamage(max * 0.75, null, { type: 'fall' });
    const v0 = p.health.value;
    const t = eng.time.elapsed;
    let regenStart = -1;
    let at45 = false;
    let seen45 = false;
    for (let i = 0; i < 780; i++) {
      step(1);
      const el = eng.time.elapsed - t;
      if (regenStart < 0 && p.health.value > v0 + 0.01) regenStart = el;
      if (!seen45 && el >= 4.5) { seen45 = true; at45 = p.health.value > v0 + 0.01; }
    }
    out.health = {
      regenStart, at45,
      plateauFrac: p.health.value / max,
      right, left, front, behind,
      passEnabled,
    };
    notes.push(`regen: ${v0.toFixed(1)} -> ${p.health.value.toFixed(1)} of ${max} ` +
      `(cap is half), first gain at ${regenStart.toFixed(2)}s`);
  }

  /* ---- recoil: A/B on the emitted camera ------------------------------- */
  const recoilRun = (kick) => {
    settle(); place(0); step(50);
    const trace = [];
    if (kick) p.addRecoil(2.4 * Math.PI / 180, 0.6 * Math.PI / 180, 0.4 * Math.PI / 180, 0.01);
    for (let i = 0; i < 100; i++) {
      step(1);
      trace.push(camPitch() * DEG);
    }
    return trace;
  };
  {
    const off = recoilRun(false);
    const on = recoilRun(true);
    let peak = 0;
    for (let i = 0; i < off.length; i++) peak = Math.max(peak, on[i] - off[i]);
    out.recoil = { peak, residual: Math.abs(on[off.length - 1] - off[off.length - 1]) };
  }

  out.states = [...new Set(events.states)];

  render.render = realRender;
  eng.start();
  return out;
}
