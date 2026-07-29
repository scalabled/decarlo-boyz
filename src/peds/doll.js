/**
 * PEDS — the death ragdoll.
 *
 * ## Why this file exists
 *
 * `physics.createRagdollFromSkeleton()` derives its bone spec by walking the
 * THREE bone hierarchy: every bone becomes one capsule from its own origin to
 * its FIRST CHILD BONE's origin. That is a fine default for a rig whose joints
 * are collinear, and it is silently catastrophic for a humanoid, because a
 * humanoid's limbs branch SIDEWAYS off the spine:
 *
 *   Hips -> Spine        capsule (0, 0.952) -> (0, 1.062)
 *   UpLegR -> LegR       capsule (-0.086, 0.918) -> (-0.092, 0.492)
 *
 * The PBD solver in `physics/ragdoll.js` has exactly one positional constraint
 * — a shared particle — and it is created by ENDPOINT COINCIDENCE, rounded to
 * the millimetre. `UpLegR`'s head is 9 cm from anything the torso owns, so no
 * particle is shared, so nothing whatsoever holds the leg to the pelvis. The
 * same is true of `ClavicleR/L`. The derived doll is therefore not one body but
 * FIVE FREE-FLOATING CHAINS — torso+head, two arms, two legs — that happen to
 * start in the shape of a person. The joint-angle cone limits still run, but a
 * cone constrains direction, not position: it cannot pull a limb back.
 *
 * From there the visible bug follows mechanically. `applyImpulse` falls off as
 * 1/(1+d^2/r^2), so a chest shot moves the torso island hard and the leg
 * islands barely at all; ground friction differs per island; `_solveSelf`
 * actively pushes islands apart. The skin does not care — every vertex that is
 * weighted partly to a limb and partly to the spine (a sleeve at the shoulder,
 * a coat hem at the thigh) is dragged between two objects that are now metres
 * apart. That is the "body getting strewn/stretched": an elongated smear across
 * the road with limbs far beyond any anatomical length.
 *
 * Measured, over 48 kills x 7 damage types x 5 death poses, on the emitted
 * skinned geometry (`corpseprobe.mjs`), before this file existed and after:
 *
 *   worst skin edge stretch    77.38x bind        ->  7.43x   (4.56x once the
 *                                                             shoulder weights
 *                                                             were fixed too)
 *   worst joint gap            74.95x bind        ->  1.13x
 *   worst corpse bbox           4.30x bind box    ->  1.39x
 *
 * `node src/peds/corpseprobe.mjs --legacy` is the negative control: it rebuilds
 * the doll the old way and the gate goes red on every metric.
 *
 * ## What this file does instead
 *
 * `rig.js` has always exported `DOLL`, a hand-authored spec with explicit
 * WELDING STUBS — a `Spine2 -> ClavicleR` capsule and a `Hips -> UpLegR`
 * capsule whose only job is to put a particle at the shoulder and the hip that
 * the torso already owns, so the solver's shared-particle constraint has
 * something to share. It was written for exactly this and then never wired up;
 * nothing imported it. This module is the wiring, plus two corrections to
 * `DOLL` itself that measurement forced: the clavicle became a simulated link
 * rather than a rigid passenger, and the cone limits were re-derived against
 * the reference direction the solver actually uses. Both are written up beside
 * the table in `rig.js`.
 *
 * The spec is rebuilt from the LIVE bone world matrices at the moment of death,
 * not from the bind pose, so a man shot mid-stride falls from the pose he was
 * actually in.
 */

import * as THREE from 'three';
import { RIG, DOLL } from './rig.js';

const DEG = Math.PI / 180;

/** Reused scratch — `buildPedRagdoll` runs on a death, never per frame. */
const _v = new THREE.Vector3();

/** Total of DOLL's mass fractions, so the spec normalises to the real mass. */
const MASS_TOTAL = DOLL.reduce((a, d) => a + d[3], 0);

/**
 * Build the death ragdoll for one pedestrian and hand it the skeleton.
 *
 * @param phys      the `physics` subsystem (needs `createRagdoll`)
 * @param bones     THREE.Bone[] in RIG order, already posed and world-updated
 * @param skeleton  the THREE.Skeleton those bones belong to
 * @param opts      { mass, scale, iterations, velocity, damping, coneK }
 * @returns the Ragdoll, or null if physics refused
 */
export function buildPedRagdoll(phys, bones, skeleton, opts = {}) {
  if (!phys || !bones || !skeleton) return null;
  const scale = opts.scale ?? 1;
  const mass = opts.mass ?? 78;
  const coneK = opts.coneK ?? 1;

  const spec = new Array(DOLL.length);
  const boneMap = new Array(DOLL.length).fill(null);

  for (let i = 0; i < DOLL.length; i++) {
    const [headName, tailName, radius, massFrac, parent, cone, twist, drives] = DOLL[i];
    const hb = bones[RIG.index(headName)];
    const tb = bones[RIG.index(tailName)];
    _v.setFromMatrixPosition(hb.matrixWorld);
    const head = [_v.x, _v.y, _v.z];
    _v.setFromMatrixPosition(tb.matrixWorld);
    const tail = [_v.x, _v.y, _v.z];
    spec[i] = {
      name: `${headName}>${tailName}`,
      head,
      tail,
      radius: radius * scale,
      mass: (massFrac / MASS_TOTAL) * mass,
      parent,
      cone: Math.min(179, cone * coneK) * DEG,
      twist: Math.min(179, twist * coneK) * DEG,
    };
    /**
     * Only the capsules that ARE a bone drive one. The two welding stubs per
     * side (`Spine2 -> UpperArm`, `Hips -> UpLeg`) are structural: writing
     * their transform into `Spine2` or `Hips` would overwrite the torso bone
     * with a sideways-pointing lateral stub and put the whole spine on its
     * side.
     */
    if (drives) boneMap[i] = hb;
  }

  /**
   * THE WELD MUST ACTUALLY WELD. `Ragdoll` shares a particle between two bones
   * only when their endpoints agree to the millimetre, and every joint here is
   * read from the same `bone.matrixWorld`, so they agree exactly — but a rig
   * edit that moved a joint could silently break it, and a broken weld is
   * invisible until someone dies on camera. Assert the invariant that the whole
   * fix rests on, once, at build time.
   */
  if (opts.verify !== false) {
    const gap = weldGap(spec);
    if (gap > 1e-6) {
      console.warn(`[peds] doll weld broken: ${gap.toExponential(2)} m between a stub and its joint`);
    }
  }

  const rd = phys.createRagdoll({
    bones: spec,
    transform: null,
    mass,
    iterations: opts.iterations ?? 8,
    damping: opts.damping,
    velocity: opts.velocity,
  });
  if (!rd) return null;
  rd.adoptSkeleton(skeleton, boneMap);
  return rd;
}

/**
 * Largest distance between a stub's head and the joint it is meant to weld to.
 * Zero when every limb root coincides with a torso endpoint.
 */
function weldGap(spec) {
  let worst = 0;
  for (let i = 0; i < spec.length; i++) {
    const p = spec[i].parent;
    if (p < 0) continue;
    // A stub starts ON its parent's head or tail; a real bone starts on its
    // parent's tail. Either way it must coincide with one of the two.
    const h = spec[i].head;
    const ph = spec[p].head, pt = spec[p].tail;
    const d = Math.min(dist(h, ph), dist(h, pt));
    if (d > worst) worst = d;
  }
  return worst;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
