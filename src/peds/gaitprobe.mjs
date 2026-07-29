#!/usr/bin/env node
/**
 * GAIT GATE — "does a planted foot stay planted?", offline.
 *
 * Renders nothing and needs no browser, in the same spirit as
 * `src/player/character/headprobe.mjs`. It drives the real `PedAnimator` over
 * the real rig for a whole gait cycle at a real ground speed, reads the ankle
 * and toe bones' world transforms out of the skeleton, and computes the one
 * number that decides whether a walk cycle is believable:
 *
 *   SLIDE = mean | world-space horizontal speed of a PLANTED foot | / ground speed
 *
 * 0 is a foot nailed to the pavement. 1 is a mannequin on a conveyor belt.
 * A hand-keyed AAA walk lands around 0.05-0.15; a pure sinusoidal hip swing
 * whose amplitude happens to be exactly right still cannot beat ~0.30, because
 * a sine is only tangent to the required linear ramp at one instant.
 *
 * It also reports:
 *   PLANT    the stance duty factor the pose actually produces, against the
 *            `DUTY` the phase curve is authored for. If they disagree the
 *            linear stance ramp is running while the foot is in the air.
 *   REACH    peak-to-peak foot travel relative to the hips, against
 *            `stride * DUTY`, which is what it must be by definition.
 *   CENTRE   how far off-centre that sweep sits. A crowd whose feet never get
 *            behind the hips reads as leaning backwards.
 *   CLEAR    toe clearance at mid-swing. Under ~2 cm the foot scrapes.
 *
 *   node src/peds/gaitprobe.mjs
 *   node src/peds/gaitprobe.mjs --plot
 */
import * as THREE from 'three';
import { RIG } from './rig.js';
import { PedAnimator } from './animator.js';
import { dutyOf, ANKLE_SHARE } from './clips.js';
import { Rng } from '../core/rng.js';
import { makeOutfit } from './wardrobe.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

/**
 * Thresholds are RATCHETS, not goals, and they are per clip because the three
 * clips are in three different states of repair.
 *
 * WALK is the one that matters — a pedestrian walks essentially all the time —
 * and it is held to the number this pass achieved. The goal is slide 0.30; a
 * hand-keyed AAA walk measures 0.05-0.15. Before this pass the same probe read
 * 0.82 here and `streetprobe.mjs` read 1.92 in the running game; they now read
 * 0.50 and 0.83. The residual is diagnosed and not closed: the pelvis yaw
 * (+/-4.6 deg) swings the two hip joints fore and aft in antiphase, so the left
 * and right ground tracks differ (R 0.50 vs L 0.33) and the stance lock has to
 * absorb the difference.
 *
 * JOG and RUN are held looser because a second defect is still open in them:
 * the knee and ankle lobes are the same SHAPE in all three clips, so the pose
 * produces a walking stance duty (0.72 measured) whatever `DUTY` says, and a
 * run consequently has no flight phase to speak of. Fixing that means
 * authoring per-clip lobe timings, which is a content job, not a maths one.
 * Lower these as they are closed. Never raise one.
 */
const T = {
  walk: { slide: 0.55, plant: 0.13 },
  jog: { slide: 0.55, plant: 0.30 },
  run: { slide: 1.20, plant: 0.25 },
  reach: 0.18,
  centre: 0.14,
  clear: 0.018,
};
const STEPS = 240;

/** One pedestrian, walked for one full gait cycle on a flat floor. */
function walkCycle(outfit, clip, speed, lock = true) {
  const { bones, skeleton, root } = RIG.createSkeleton();
  // The animator expects the root bone to have a parent, exactly as it does in
  // game (`ped_body` group -> root). Without one the foot IK pole vector has
  // nothing to transform against.
  const holder = new THREE.Group();
  holder.add(root);
  holder.updateMatrixWorld(true);
  const an = new PedAnimator(RIG, bones, {
    gait: { ...outfit.gait, phase: 0 },
    height: outfit.height,
    scale: outfit.scale,
    // A flat floor at y = 0, so the foot IK is exercised exactly as in game.
    probe: (x, z, fromY, out) => {
      out.y = 0; out.nx = 0; out.ny = 1; out.nz = 0; out.hit = true;
      return true;
    },
  });
  holder.scale.setScalar(outfit.scale);
  an.footLock = lock;
  an.setState({ clip, speed });
  an.blend = 1;
  an.phase = 0;

  const hz = speed / an.strideLength(speed);
  const dt = 1 / (hz * STEPS);
  const pos = new THREE.Vector3();
  const rows = [];
  // THE CHARACTER MUST ACTUALLY TRAVEL. A rig walked in place makes the stance
  // lock look like a catastrophic failure — the lock pins the foot in the
  // world, which is exactly right, but with a stationary body "the world" and
  // "the body" are the same thing and the pinned foot cannot sweep. Forward is
  // -Z: positive hip flexion swings the knee toward +Z, and the pose puts the
  // leg toward +Z at toe-off, so +Z is behind the character.
  for (let i = 0; i < STEPS * 2; i++) {
    holder.position.z -= speed * dt;
    holder.updateMatrixWorld(true);
    an.update(dt, i * dt);
    holder.updateMatrixWorld(true);
    const get = (n) => {
      const b = bones[RIG.index(n)];
      pos.setFromMatrixPosition(b.matrixWorld);
      return [pos.x, pos.y, pos.z];
    };
    if (i >= STEPS) {
      const hip = get('Hips');
      rows.push({
        t: i * dt,
        phase: an.phase,
        hip,
        ankleR: get('FootR'),
        toeR: get('ToeR'),
        ankleL: get('FootL'),
        toeL: get('ToeL'),
      });
    }
  }
  void skeleton;
  return { rows, hz, stride: an.strideLength(speed), swing: an.gait.swingDeg ?? null, dt };
}

/**
 * The rig walks in place, so the world position of a foot at time t is
 * `local + speed * t` along the character's forward axis. On this rig the
 * character faces -Z, and a foot that is standing still in the world has a
 * local Z that increases at exactly `speed`.
 */
function analyse(run, speed, clip) {
  const { rows, stride, dt } = run;
  const out = { legs: {} };
  for (const side of ['R', 'L']) {
    const ank = rows.map((r) => r[`ankle${side}`]);
    const toe = rows.map((r) => r[`toe${side}`]);
    const hip = rows.map((r) => r.hip);
    // forward offset of the foot relative to the hips, character-local +Z
    const fwd = ank.map((a, i) => a[2] - hip[i][2]);
    // PLANTED is measured on the ANKLE, at an absolute height above the floor.
    // The toe leaves the ground well before the heel does (that is what toe-off
    // means), so a toe-based test under-reports stance by half; and a threshold
    // expressed as a fraction of the swing arc would quietly redefine stance at
    // every speed, because a longer stride lifts the foot higher.
    const lo = Math.min(...ank.map((p) => p[1]));
    const hi = Math.max(...toe.map((p) => p[1]));
    const down = ank.map((p) => p[1] - lo < 0.025);

    // contiguous stance runs, middle 70% only (heel strike and toe-off are
    // genuinely moving), wrapped so a run spanning the sample edge still counts
    const n = rows.length;
    const runs = [];
    let i = 0;
    while (i < n) {
      if (!down[i]) { i++; continue; }
      let j = i;
      while (j < n && down[j]) j++;
      runs.push([i, j]);
      i = j;
    }
    let sFoot = 0, sBody = 0, cnt = 0, plant = 0;
    for (const [a, b] of runs) {
      plant += b - a;
      const p0 = a + Math.floor((b - a) * 0.15);
      const p1 = b - Math.floor((b - a) * 0.15);
      for (let k = p0 + 1; k < p1; k++) {
        // Both are world space now: the holder travels, so a planted foot's
        // world displacement IS the slide, with nothing to subtract.
        sFoot += Math.hypot(ank[k][2] - ank[k - 1][2], ank[k][0] - ank[k - 1][0]);
        sBody += speed * dt;
        cnt++;
      }
    }
    const mn = Math.min(...fwd), mx = Math.max(...fwd);
    // toe clearance at the top of the swing
    const clear = hi - Math.min(...toe.map((p) => p[1]));
    out.legs[side] = {
      slide: sBody > 1e-9 ? sFoot / sBody : -1,
      plant: plant / n,
      reach: mx - mn,
      need: stride * dutyOf(clip) * ANKLE_SHARE,
      centre: (mx + mn) / 2,
      clear,
      samples: cnt,
    };
  }
  return out;
}

const rng = new Rng(0x9A17);
const CASES = [];
for (const [arch, clip, speed] of [
  ['street', 'walk', 1.35],
  ['office', 'walk', 1.55],
  ['mill', 'walk', 1.15],
  ['street', 'jog', 3.2],
  ['street', 'run', 5.6],
]) {
  const outfit = makeOutfit(rng.fork(), arch, {});
  const run = walkCycle(outfit, clip, speed);
  const a = analyse(run, speed, clip);
  // REACH / CENTRE / PLANT describe the CLIP, so they are read with the stance
  // LOCK off (the ground conform stays on — without it the pose floats and
  // stance duty is meaningless). With the lock on they would measure the
  // corrector rather than the thing being corrected, and a clip that had
  // drifted badly could still score perfectly while the lock quietly stretched
  // the leg on every step.
  const pose = analyse(walkCycle(outfit, clip, speed, false), speed, clip);
  a.legs.R.reach = pose.legs.R.reach; a.legs.L.reach = pose.legs.L.reach;
  a.legs.R.centre = pose.legs.R.centre; a.legs.L.centre = pose.legs.L.centre;
  a.legs.R.plant = pose.legs.R.plant; a.legs.L.plant = pose.legs.L.plant;
  CASES.push({ arch, clip, speed, outfit, run, a });
}

console.log(`=== gait gate — ${STEPS} samples/cycle ===`);
console.log('case                 stride  swingDeg   slide   plant   reach/need    centre   clear');
let fail = 0;
for (const c of CASES) {
  for (const side of ['R', 'L']) {
    const L = c.a.legs[side];
    const bad = [];
    const t = T[c.clip] ?? T.walk;
    if (L.slide > t.slide) bad.push('SLIDE');
    if (Math.abs(L.reach - L.need) / L.need > T.reach) bad.push('REACH');
    if (Math.abs(L.centre) > T.centre) bad.push('CENTRE');
    if (L.clear < T.clear) bad.push('CLEAR');
    if (Math.abs(L.plant - dutyOf(c.clip)) > t.plant) bad.push('PLANT');
    if (bad.length) fail++;
    console.log(
      `${(c.arch + ' ' + c.clip + ' ' + c.speed + ' ' + side).padEnd(22)}` +
        `${c.run.stride.toFixed(2).padStart(5)}  ${(c.run.swing ?? 0).toFixed(1).padStart(7)}  ` +
        `${L.slide.toFixed(3).padStart(6)}  ${L.plant.toFixed(2).padStart(5)}  ` +
        `${L.reach.toFixed(3)}/${L.need.toFixed(3)}  ${L.centre.toFixed(3).padStart(7)}  ` +
        `${L.clear.toFixed(3)}  ${bad.length ? 'FAIL ' + bad.join(',') : ''}`
    );
  }
}
console.log(
  `\nratchets: slide <= walk ${T.walk.slide} / jog ${T.jog.slide} / run ${T.run.slide}, ` +
    `reach within ${T.reach * 100}% of stride*DUTY*ANKLE_SHARE, |centre| <= ${T.centre} m, ` +
    `clear >= ${T.clear} m, plant within 0.13/0.30/0.25 of the clip duty`
);

if (args.plot) {
  const c = CASES[0];
  const rows = c.run.rows;
  console.log('\nphase   fwdR    toeYR   fwdL    toeYL');
  for (let i = 0; i < rows.length; i += 8) {
    const r = rows[i];
    console.log(
      `${r.phase.toFixed(3)}  ${(r.ankleR[2] - r.hip[2]).toFixed(3).padStart(6)}  ` +
        `${r.toeR[1].toFixed(3).padStart(6)}  ${(r.ankleL[2] - r.hip[2]).toFixed(3).padStart(6)}  ` +
        `${r.toeL[1].toFixed(3).padStart(6)}`
    );
  }
}

console.log(fail ? `\nFAIL (${fail} legs)` : '\nPASS');
process.exit(fail ? 1 : 0);
