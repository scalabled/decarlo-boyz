import { LANDMARKS } from './plan.js';

/**
 * WORLD — the incline TRACK AUTHORITY.
 *
 * One solver, one descriptor, published once. The Duquesne Incline has had the
 * same defect twice in its history (see the long post-mortems in
 * `src/buildings/landmarks.js` and `netgen.orientLandmarkSites`): two
 * subsystems each solving "where does the track go" independently, and the two
 * answers drifting 30 degrees apart. The bearing was fixed by making `world`
 * solve it once and publish it (`world.landmarks[].uphill.dir`). This file
 * does the same for the PROFILE — the graded polyline the trestle stands
 * under — because a third consumer has arrived: the moving funicular cars
 * (`src/vehicles/funicular.js`) must ride the exact rails the trestle emits,
 * and "the car re-derives the track for itself" is the same bug waiting to
 * happen a third time.
 *
 * `WorldSystem.init` calls `publishInclineTracks` after `generateCity` has
 * oriented the landmark sites, so every entry of the published table
 * `world.landmarks` whose kind is `incline` carries:
 *
 *     lm.funicular.track   the descriptor below
 *
 * CONSUMERS (both reach it through published state, never an import — rule 2):
 *   - `buildings`' `incline()` EMITS the trestle, rails and sleepers from the
 *     descriptor's arrays (it reads `lm.funicular.track` off the entry that
 *     `adoptLandmarkSites` copied). Descriptor and emitted geometry are
 *     therefore the same object, not two agreeing computations.
 *   - `funicular` poses its two cars each frame by sampling the same
 *     descriptor. `src/vehicles/funicularprobe.mjs` is the gate that the cars
 *     and the EMITTED rail vertices actually coincide.
 *
 * THE DESCRIPTOR
 *
 *   { x, z            lower-station origin (the landmark's authored point)
 *     dirX, dirZ      unit bearing of the climb (from `uphill.dir`)
 *     rx, rz          right-hand normal to the climb
 *     run             metres along the bearing, lower station -> upper
 *     yaw             Math.atan2(dirX, dirZ): puts a box's local +Z up the run
 *     bents           trestle bay count; arrays below have bents+1 entries
 *     px, pz          world XZ of each bent, i/bents of the way up
 *     gnd             raw terrain height under each bent
 *     py              TRACK height at each bent (graded, monotonic, clamped)
 *     gauge           lateral offset of each car's centreline (one rail each)
 *     carLift         car floor height above `trackY`
 *     at(r, a, out?)  world XZ `r` metres right of the track, `a` up the run
 *     trackY(a)       track height at along-distance `a` (lerped over bents)
 *     pitchAt(a)      grade at `a` as a rotation about the right axis, the
 *                     sign matching a RotationX applied after RotationY(yaw)
 *   }
 *
 * The profile math is copied VERBATIM from what `incline()` shipped with (one
 * node per bent at ground+MIN_CLEAR, three smoothing passes, monotonic and
 * clamped to MAX_LEG) so the trestle this descriptor produces is byte-identical
 * to the one players have been photographed under. `incline()` retains its own
 * inline copy ONLY as a fallback for the standalone buildings preview and the
 * prewarm scratch build, where no `world` exists to publish anything.
 */

/** Track rides this high over the ground it crosses (m). */
const MIN_CLEAR = 2.2;
/** Longest stilt the trestle may stand on before the track is pulled down. */
const MAX_LEG = 15;
/** Cars sit one rail-line out from the centre — matches the emitted rails. */
const GAUGE = 3.2;
/** Car floor above the rail head — matches the static cars this replaces. */
const CAR_LIFT = 1.2;

export function solveInclineTrack({ x, z, dirX, dirZ, run = 180, groundY = null, groundAt }) {
  const bents = Math.max(6, Math.round(run / 9));
  const px = new Array(bents + 1);
  const pz = new Array(bents + 1);
  const gnd = new Array(bents + 1);
  const py = new Array(bents + 1);
  for (let i = 0; i <= bents; i++) {
    const t = i / bents;
    px[i] = x + dirX * t * run;
    pz[i] = z + dirZ * t * run;
    gnd[i] = groundAt(px[i], pz[i]);
    py[i] = gnd[i] + MIN_CLEAR;
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < bents; i++) py[i] = (py[i - 1] + py[i] * 2 + py[i + 1]) * 0.25;
    for (let i = 0; i <= bents; i++) {
      if (py[i] < gnd[i] + MIN_CLEAR) py[i] = gnd[i] + MIN_CLEAR;
      if (i && py[i] < py[i - 1]) py[i] = py[i - 1];
      if (py[i] > gnd[i] + MAX_LEG) py[i] = gnd[i] + MAX_LEG;
    }
  }
  py[0] = (groundY ?? gnd[0]) + MIN_CLEAR;

  const rx = dirZ;
  const rz = -dirX;
  const yaw = Math.atan2(dirX, dirZ);

  const at = (r, a, out) => {
    out = out ?? { x: 0, z: 0 };
    out.x = x + rx * r + dirX * a;
    out.z = z + rz * r + dirZ * a;
    return out;
  };
  const trackY = (a) => {
    const f = Math.max(0, Math.min(bents, (a / run) * bents));
    const i = Math.min(bents - 1, Math.floor(f));
    return py[i] + (py[i + 1] - py[i]) * (f - i);
  };
  /** Same sign convention as the trestle's rail bays and the old static cars:
   *  a RotationX by this, applied after RotationY(yaw), lays local +Z on the
   *  local grade. */
  const pitchAt = (a, h = 4) => -Math.atan2(trackY(a + h) - trackY(a - h), 2 * h);

  return {
    x, z, dirX, dirZ, rx, rz, run, yaw, bents,
    px, pz, gnd, py,
    gauge: GAUGE,
    carLift: CAR_LIFT,
    at, trackY, pitchAt,
  };
}

/**
 * Solve and attach `lm.funicular.track` to every incline-kind entry of the
 * published landmark table. Must run AFTER `netgen.orientLandmarkSites` has
 * replaced the authored placeholder bearing with the solved one. `groundAt`
 * is the RAW terrain (`terrain.heightAt`) — the same field the trestle is
 * grounded on and the same one `orientLandmarkSites` scored bearings against;
 * see that function's comment for why `walkableHeightAt` must NOT be used
 * here. Returns how many tracks were published.
 */
export function publishInclineTracks(landmarks = LANDMARKS, groundAt = null) {
  if (typeof groundAt !== 'function') return 0;
  let n = 0;
  for (const lm of landmarks ?? []) {
    if (lm.kind !== 'incline') continue;
    const dir = lm.uphill?.dir;
    if (!dir || !Number.isFinite(dir[0]) || !Number.isFinite(dir[1])) continue;
    if (dir[0] === 0 && dir[1] === 0) continue;
    lm.funicular = {
      track: solveInclineTrack({
        x: lm.x,
        z: lm.z,
        dirX: dir[0],
        dirZ: dir[1],
        run: lm.uphill.run ?? 180,
        groundAt,
      }),
    };
    n++;
  }
  return n;
}
