/**
 * PEDS — animation content.
 *
 * Poses are authored as **local euler deltas in degrees** on top of the bind
 * pose. The rig is built so every bone's local axes mean the same thing:
 *
 *   x  flexion   — positive swings the bone's tip FORWARD (+Z)
 *   y  twist     — roll about the bone's own length
 *   z  lateral   — positive tips the bone toward the character's right
 *
 * Every locomotion clip takes the pedestrian's own `gait` object, so no two
 * people in the crowd walk alike: stride amplitude, arm swing, how much the
 * pelvis rolls, how far the feet turn out, the forward lean, the shoulder that
 * sits lower than the other and the phase they happen to be on are all per
 * person. A crowd where everybody shares one walk cycle is the single most
 * obvious tell that a city is procedural, and it is free to fix.
 */

/**
 * NEGATIVE-CONTROL SWITCH for `src/peds/poseprobe.mjs`. Setting a flag here
 * puts a fixed defect back so the gate can be shown to catch it. Boot-time and
 * gate-time only; the game never writes this.
 */
export const LEGACY = { mirrorSigns: false };

const TAU = Math.PI * 2;
const sin = Math.sin;
const cos = Math.cos;
const lobe = (x, k = 1.4) => {
  const s = sin(x);
  return s > 0 ? s ** k : 0;
};

/**
 * FOOT PLANTING — why the leg swing is not a sine wave.
 *
 * A planted foot does not move. That is the whole of it, and it is the
 * difference between a walk and a mannequin being slid along a rail. Two
 * things have to be true at once, and neither was:
 *
 * 1. THE SHAPE. While the sole is flat on the pavement the foot's position
 *    RELATIVE TO THE HIPS has to decrease LINEARLY, at exactly the ground
 *    speed, because the hips are moving at exactly the ground speed and the
 *    foot is not moving at all. `sin` matches that at one instant — mid-stance
 *    — and is wrong everywhere else, so the foot creeps forward at the start
 *    of stance and drags at the end.
 *
 * 2. THE AMPLITUDE. Over one gait cycle the hips advance one STRIDE, and the
 *    foot is planted for the stance fraction of it, so the peak-to-peak swing
 *    of the foot relative to the hips must be `stride * DUTY` — a number that
 *    depends on how fast the person is going and how long their legs are. It
 *    was a hard-coded 23 degrees of hip flexion. MEASURED on a live 1.63 m
 *    pedestrian walking at 1.53 m/s: the hips travelled 1.351 m per gait cycle
 *    and the foot swung 0.505 m relative to them, against the 0.841 m the
 *    stride demanded. The missing 0.34 m per cycle came out as skate — the
 *    probe read a planted foot moving 45.9 mm/frame while the body moved 23.9.
 *
 * `PedAnimator` now solves the hip amplitude from the stride and the leg
 * length every frame and writes it to `gait.swingDeg`; this curve supplies the
 * shape. `src/peds/streetprobe.mjs` gates the result in the running game.
 */
export const DUTY = { walk: 0.62, jog: 0.46, run: 0.32 };
/** The stance fraction for a clip name; unknown clips walk. */
export const dutyOf = (clip) => DUTY[clip] ?? DUTY.walk;

/**
 * How much of the hips' stance travel the ANKLE has to supply.
 *
 * Over stance the hips advance `stride * DUTY` while the foot stays put, so
 * naively the ankle must swing that far relative to them. It does not, and
 * asking for it produces a 50-degree hip swing that reads as goose-stepping:
 * a real foot ROLLS. The heel lifts at about 40% of stance and the whole foot
 * pivots forward over the toe, so the ankle itself translates 15-20 cm before
 * the toe leaves the ground, and the pelvis rotates about the stance hip on
 * top of that. Measured human hip-to-ankle excursion at a brisk walk is ~0.75 m
 * against a 1.06 m stance travel — 0.71. 0.80 sits just above that because the
 * rig's foot roll is gentler than a real one's.
 *
 * The remainder is exactly what the stance lock in `PedAnimator._footIk`
 * absorbs, which is what a lock is for: the pose carries the shape, the lock
 * carries the last centimetres.
 */
export const ANKLE_SHARE = 0.88;

/**
 * Where heel strike sits on the phase circle, found by measurement rather than
 * by reading the clip: the big knee lobe is authored at `a - 0.55` and peaks
 * mid-swing, which puts the foot back down at a/TAU = 0.68. `gaitprobe.mjs`
 * reports the stance duty the pose actually produces, so if this is ever wrong
 * the PLANT line says so instead of it showing up as a mystery skate.
 */
const HEEL_STRIKE = 0.68;

/**
 * How far through its stance this foot is (0 at heel strike, -> DUTY at
 * toe-off), or -1 if it is in the air.
 *
 * The stance lock asks the CLIP rather than picking "whichever ankle is
 * lower": at a realistic swing amplitude the two ankles pass within
 * millimetres of each other, a lowest-foot test flickers between them, and a
 * lock that re-latches every few frames is indistinguishable from no lock.
 *
 * A walk at DUTY 0.62 also has 24% of double support, and only ONE of those
 * two feet is carrying the body — the one that just landed. Locking both
 * anchors the character between two points it is trying to walk away from, and
 * the leg-reach clamp then fires every step. So the caller takes the foot with
 * the SMALLEST progress: weight transfers to the leading foot at heel strike,
 * which is what it does.
 */
export function stanceProgress(phase, gaitPhase, clip, side) {
  const u = (phase + (gaitPhase ?? 0) + (side ? 0.5 : 0) - HEEL_STRIKE) % 1;
  const w = ((u % 1) + 1) % 1;
  return w < dutyOf(clip) ? w : -1;
}

/**
 * Ground track, +1 at heel strike to -1 at toe-off and smoothly back.
 * `a` is the same phase angle the rest of the clip uses, so u = 0 lands where
 * `sin(a)` used to peak and the arms, spine and pelvis keep their relationship
 * to the legs unchanged.
 */
function track(a, duty) {
  // u = 0 at HEEL STRIKE. On this rig positive hip flexion swings the foot
  // BACKWARD, so `sin(a)` peaks at toe-off, not at heel strike — which is also
  // why the big knee lobe sits at `a - 0.55` (just after toe-off, exactly as
  // its comment says). Heel strike is therefore half a cycle before that.
  let u = (a / TAU - HEEL_STRIKE) % 1;
  if (u < 0) u += 1;
  let s;
  if (u < duty) {
    s = -1 + (2 * u) / duty;                    // stance: LINEAR, the whole point
  } else {
    const w = (u - duty) / (1 - duty);
    s = cos(Math.PI * w);                       // swing: eased +1 -> -1
  }
  // A little of the original sinusoid blended back rounds the corner at heel
  // strike, which is a real thing a foot does (the heel rolls) and stops the
  // knee snapping on the frame the linear sweep begins.
  return s * 0.82 + sin(a) * 0.18;
}

/* ------------------------------------------------------------------ */
/* Locomotion                                                          */
/* ------------------------------------------------------------------ */

/**
 * Base gait constants per clip. `g` (the ped's own gait record) scales them.
 * Hand-tuned against reference footage: the knee flexes hardest just after
 * toe-off, the pelvis drops through mid-stance and rolls toward the stance
 * leg, the spine counter-rotates against the pelvis and the arms are
 * contralateral to the legs.
 */
const WALK = {
  duty: DUTY.walk,
  thigh: 23, thighBias: -1.5, twist: 1.6,
  kneeBase: 5, knee: 50, kneeStance: 7,
  ankle: 13, ankleBias: 2.5, toe: 17,
  sway: 0.016, bob: 0.016, bobBias: -0.014,
  pelvisYaw: 4.6, pelvisRoll: 3.4,
  lean: 2.2, spineYaw: 4.2,
  arm: 17, armBase: -2, elbow: 13, elbowSwing: 9,
  clav: 2.0, headBob: 1.4,
};

const JOG = {
  duty: DUTY.jog,
  thigh: 33, thighBias: 3, twist: 2,
  kneeBase: 12, knee: 82, kneeStance: 20,
  ankle: 19, ankleBias: 4, toe: 24,
  sway: 0.020, bob: 0.030, bobBias: -0.028,
  pelvisYaw: 6.4, pelvisRoll: 4.6,
  lean: 7.5, spineYaw: 6.0,
  arm: 34, armBase: -6, elbow: 58, elbowSwing: 18,
  clav: 3.2, headBob: 2.2,
};

const RUN = {
  duty: DUTY.run,
  thigh: 44, thighBias: 6, twist: 2.4,
  kneeBase: 18, knee: 104, kneeStance: 30,
  ankle: 24, ankleBias: 5, toe: 30,
  sway: 0.024, bob: 0.044, bobBias: -0.040,
  pelvisYaw: 8.2, pelvisRoll: 5.6,
  lean: 15, spineYaw: 7.6,
  arm: 46, armBase: -10, elbow: 80, elbowSwing: 22,
  clav: 4.4, headBob: 3.0,
};

function gaitClip(P, ph, K, g) {
  const t = (ph + (g.phase ?? 0)) * TAU;
  const strideK = g.strideK ?? 1;
  const armK = g.armSwing ?? 1;
  const splay = g.splay ?? 1.5;

  // The hip amplitude the CURRENT ground speed demands, solved by the animator
  // from stride / leg length. Falls back to the authored constant when the clip
  // is driven without an animator (the wardrobe preview, unit tests).
  const swing = g.swingDeg ?? K.thigh * strideK;
  // How far past the authored amplitude we are, used to scale the knee and
  // ankle with it: a longer stride really does flex the knee harder.
  const amp = swing / Math.max(1e-3, K.thigh);
  // The foot must sweep SYMMETRICALLY about the hip. It used to sit 0.14 m
  // forward of centre — the knee lobe pulls it there — so a pedestrian walked
  // with both feet permanently in front of him, which reads as leaning back.
  const centre = K.thighBias + swing * (K.centre ?? 0.55);

  for (const side of [1, -1]) {
    const s = side > 0 ? 'R' : 'L';
    const o = side > 0 ? 0 : Math.PI;
    const a = t + o;
    const thigh = swing * track(a, K.duty) + centre;
    const knee = -(
      K.kneeBase +
      K.knee * strideK * Math.min(1.6, amp) * lobe(a - 0.55, 1.5) +
      K.kneeStance * lobe(a + Math.PI + 0.4, 2)
    );
    const ankle = K.ankle * sin(a - 1.9) + K.ankleBias;
    P.d(`UpLeg${s}`, thigh, side * K.twist, side * splay);
    P.d(`Leg${s}`, knee, 0, 0);
    P.d(`Foot${s}`, ankle * (g.heelK ?? 1), -side * 1.4, -side * splay * 0.35);
    P.d(`Toe${s}`, Math.max(0, -K.toe * sin(a - 2.6)), 0, 0);
  }

  // pelvis: two vertical bobs per stride, rolling toward the stance leg
  P.hip(K.sway * (g.sway ?? 1) * sin(t), K.bobBias + K.bob * (g.bounce ?? 1) * cos(2 * t), 0);
  P.d('Hips', -1 + (g.stoop ?? 0) * 0.25, K.pelvisYaw * sin(t), K.pelvisRoll * (g.roll ?? 1) * sin(t + 1.2));

  const lean = K.lean + (g.lean ?? 0);
  const stoop = g.stoop ?? 0;
  P.d('Spine', lean * 0.34 + stoop * 0.32, -K.spineYaw * 0.42 * sin(t), -K.pelvisRoll * 0.34 * sin(t + 1.2));
  P.d('Spine1', lean * 0.34 + stoop * 0.34, -K.spineYaw * 0.72 * sin(t), 0);
  P.d('Spine2', lean * 0.30 + stoop * 0.30, -K.spineYaw * sin(t), 0);
  P.d('Neck', -lean * 0.45 - stoop * 0.55, K.spineYaw * 0.55 * sin(t), 0);
  P.d('Head', -K.headBob * (g.headBob ?? 1) * cos(2 * t) - stoop * 0.25, K.spineYaw * 0.2 * sin(t), 0);

  // arms, contralateral. `armBias` gives one shoulder a different carry, which
  // is what people actually look like from across a street.
  const bias = g.armBias ?? 0;
  const drop = g.shoulderDrop ?? 0;
  P.d('ClavicleR', -K.clav * sin(t) - 0.5, 0, 1.4 + drop);
  P.d('ClavicleL', K.clav * sin(t) - 0.5, 0, -1.4 + drop);
  P.d('UpperArmR', -K.arm * armK * sin(t) + K.armBase + bias, 0, 3.0);
  P.d('UpperArmL', K.arm * armK * sin(t) + K.armBase - bias, 0, -3.0);
  P.d('ForearmR', K.elbow + K.elbowSwing * armK * Math.max(0, -sin(t)), 0, 0);
  P.d('ForearmL', K.elbow + K.elbowSwing * armK * Math.max(0, sin(t)), 0, 0);
  P.d('HandR', 4, 0, 0);
  P.d('HandL', 4, 0, 0);
}

export function walk(P, ph, g) { gaitClip(P, ph, WALK, g); }
export function jog(P, ph, g) { gaitClip(P, ph, JOG, g); }
export function run(P, ph, g) { gaitClip(P, ph, RUN, g); }

/* ------------------------------------------------------------------ */
/* Standing                                                            */
/* ------------------------------------------------------------------ */

/** Weight on one leg, breathing, a slow drift of the weight to the other. */
export function idle(P, ph, g) {
  const t = ph * TAU;
  const breath = sin(t * 0.9);
  const shift = sin(t * 0.21 + (g.phase ?? 0) * 6.2);       // weight transfer
  const micro = sin(t * 1.7 + 0.4) * 0.35 + sin(t * 2.9) * 0.2;
  const w = shift > 0 ? 1 : -1;
  const k = Math.abs(shift);

  P.hip(0.020 * shift, -0.006 - 0.008 * k + 0.003 * breath, 0);
  P.d('Hips', -1.2 + (g.stoop ?? 0) * 0.3, 2.0 * shift, 3.4 * shift);
  P.d('Spine', 1.2 + 0.5 * breath + (g.stoop ?? 0) * 0.34, -1.2 * shift, -2.0 * shift);
  P.d('Spine1', 0.8 + 0.7 * breath + (g.stoop ?? 0) * 0.34, -0.8 * shift, -1.2 * shift);
  P.d('Spine2', -0.4 + 0.9 * breath + (g.stoop ?? 0) * 0.3, 1.4 * shift, 0.6 * shift);
  P.d('Neck', 0.8 - 0.4 * breath - (g.stoop ?? 0) * 0.6, 1.0 * shift + micro, 0);
  P.d('Head', -1.0 - (g.stoop ?? 0) * 0.3, 1.2 * micro, 0.5 * shift);

  // the loaded leg straightens, the free leg softens and turns out
  const R = w > 0 ? 1 : 0.35;
  const L = w > 0 ? 0.35 : 1;
  P.d('UpLegR', -1.5 - 3 * L, 1.4, -1.5 - 2.5 * L);
  P.d('LegR', -3 - 8 * L, 0, 0);
  P.d('FootR', 2 + 3 * L, -1.4, -(g.splay ?? 1.5) * 0.5);
  P.d('UpLegL', -1.5 - 3 * R, -1.4, 1.5 + 2.5 * R);
  P.d('LegL', -3 - 8 * R, 0, 0);
  P.d('FootL', 2 + 3 * R, 1.4, (g.splay ?? 1.5) * 0.5);

  const drop = g.shoulderDrop ?? 0;
  P.d('ClavicleR', -1.2 + 0.6 * breath, 0, 1.2 + drop);
  P.d('ClavicleL', -1.0 + 0.5 * breath, 0, -1.2 + drop);
  P.d('UpperArmR', -1.5 + (g.armBias ?? 0) * 0.4, 0, 3.5);
  P.d('UpperArmL', -1.5 - (g.armBias ?? 0) * 0.4, 0, -3.5);
  P.d('ForearmR', 9, 0, 0);
  P.d('ForearmL', 9, 0, 0);
}

/** Waiting at a crossing: squarer stance, weight forward, glancing at traffic. */
export function wait(P, ph, g) {
  idle(P, ph, g);
  const t = ph * TAU;
  const glance = sin(t * 0.47 + 1.3);
  P.d('Neck', 1.5, 9 * glance, 0);
  P.d('Head', -1.0, 13 * glance, 2 * glance);
  P.d('Hips', 1.5, 0, 0);
}

/** Leaning on a wall or a railing. */
export function lean(P, ph, g) {
  const t = ph * TAU;
  const breath = sin(t * 0.8);
  P.hip(0.03, -0.045, -0.055);
  P.d('Hips', -8, 4, 6);
  P.d('Spine', -4 + 0.5 * breath, -2, -4);
  P.d('Spine1', -2 + 0.6 * breath, -2, -2);
  P.d('Spine2', 2 + 0.8 * breath, 3, 1);
  P.d('Neck', 4, 4, 0);
  P.d('Head', -3, 6, 2);
  P.d('UpLegR', 4, 3, -2);
  P.d('LegR', -8, 0, 0);
  P.d('FootR', 6, -2, 0);
  P.d('UpLegL', 18, -8, 7);
  P.d('LegL', -34, 0, 0);
  P.d('FootL', 14, 5, 0);
  P.d('ClavicleR', -3, 0, 3);
  P.d('UpperArmR', -4, 0, 8);
  P.d('ForearmR', 16, 0, 0);
  P.d('UpperArmL', -2, 0, -6);
  P.d('ForearmL', 12, 0, 0);
}

/* ------------------------------------------------------------------ */
/* Seated                                                              */
/* ------------------------------------------------------------------ */

/**
 * SEATED IN A CAR — the pose that was missing entirely.
 *
 * Every pedestrian `traffic` and `police` put behind a wheel was drawn STANDING
 * at the car's centre of mass, because `Ped` had no seated state at all: it
 * copied `vehicle.position` into its root (which is the FEET) and went on
 * playing an idle. Measured from the emitted geometry, the crown then sat
 * 0.98 m over a sedan roof, 1.00 m over a sports car and 0.88 m over the
 * Kessel — the player's "NPC heads popping out of cars".
 *
 * TWO NUMBERS DEFINE THIS POSE, and `ped.js` reads the same two to decide where
 * to put the root. That is the whole contract, and it is deliberately the same
 * shape as the one `player/tuning.js` publishes for the player's own driver:
 *
 *   headBind   the Head bone's bind height (`rig.js` BONES). Scales with the
 *              outfit's `scale`.
 *   hipDrop    how far the pelvis falls to sit down.
 *
 * `vehicles.seatAnchor()` publishes where the DRIVER'S HEAD goes, so the root
 * is the anchor minus `SEAT.headHeight` and the pose then reproduces exactly
 * that height. `hipDrop` is pinned from both ends:
 *
 *   too small  the head rises through the roofline of the low classes — the
 *              sports car has 1.15 m of roof over 0.115 m of floor
 *   too large  the root goes under the floor pan and the shoes hang out below
 *              the sill, visible on any car from outside
 *
 * 0.744 puts the ped rig's seated head at the same 0.768 m over the root that
 * the player's rig sits at, so one `seatAnchor` contract serves both.
 *
 * A car driver's legs are nearly straight out, not folded under him: with the
 * hip only ~0.21 m over the floor pan the ankle has to travel forward, not
 * down, which is why the thigh is only 62 degrees off the bind and the knee
 * takes the rest.
 */
export const SEAT = {
  headBind: 1.512,
  hipDrop: 0.744,
  /** Seated head height over the root — the number `ped.js` subtracts. */
  get headHeight() { return this.headBind - this.hipDrop; },
  /**
   * HOW MUCH SKULL IS ALLOWED ABOVE THE HEAD ANCHOR. `ped.js` sinks the seat
   * by whatever a silhouette exceeds this, so a hat costs headroom rather than
   * taking it.
   *
   * `vehicles.seatAnchor` sizes its own headroom on `CROWN_OVER_HEAD = 0.242`,
   * a bare 1.75 m skull. The crowd is neither: measured over the wardrobe, the
   * emitted crown stands 0.213 to 0.289 m over the head bone once beanies,
   * caps and raised hoods are in, and it scales with a stature that runs to
   * 1.94 m. 0.21 is under all of it, and it is chosen against the EMITTED
   * roofline rather than against `roofY`: measured directly over where a
   * seated driver's head actually is (0.72 of the anchor's x — see `trackIn`),
   * the roof stands 1.133 m on the sports car against a 0.895 m anchor, so
   * this leaves 28 mm on the tightest class in the fleet and 74-115 mm on the
   * rest. `src/peds/seatprobe.mjs` measures it.
   *
   * Sinking rather than shrinking is deliberate: a tall driver in a low car
   * drops the seat and reclines, he does not become a shorter man when he gets
   * in. It is paid for at the other end — see `MAX_SOLE_UNDER` in the probe.
   */
  crownBudget: 0.21,
  /**
   * A LOWER BOUND ON THE HEIGHT OF THE HEAD ANCHOR OVER THE FLOOR PAN, as a
   * function of its height over the road — which is the only one of the two
   * `vehicles` publishes (`seatAnchor.enter` is five centimetres over the
   * ground the car stands on, by construction).
   *
   * It has to be a lower bound in that direction, because the leg pose spends
   * it: under-estimate and the feet dangle above the pan, which nobody outside
   * the car can see; over-estimate and the shoes come out under the rocker,
   * which everybody can. `seatAnchor` guarantees the floor is at least 0.64 m
   * under the anchor for EVERY class (its `slouched` term is `floor + 0.64` and
   * the anchor is a `max` over it), so `floorGap` is exact where it binds and
   * `floorSlope` only reclaims part of what the roomier classes actually have.
   *
   * MEASURED, anchor over its own floor pan, by class: sports 0.640,
   * muscle 0.640, sedan 0.728, kessel 0.755, police 0.765, van 0.910,
   * bus 0.980, truck 1.050. This estimator returns 0.640 / 0.640 / 0.660 /
   * 0.659 / 0.664 / 0.724 / 0.852 / 0.856 — under every one of them.
   */
  floorGap: 0.64,
  floorSlope: 0.20,
  floorKnee: 1.00,
  /**
   * How far the SOLES fall below the root as `drop` runs 0 to 1, at scale 1.
   * MEASURED off the emitted mesh rather than derived from the joint angles,
   * because the shoe is a garment and hangs below the ankle bone by its own
   * amount: `fall = soleFallBase + soleFallSpan * drop`, read at
   * drop = 0.00 / 0.18 / 0.44 / 0.84 / 1.00 as 0.032 / 0.131 / 0.261 / 0.369 /
   * 0.521 m. Re-measure it if the leg angles in `sit` change.
   */
  soleFallBase: 0.035,
  soleFallSpan: 0.485,
  /**
   * HOW FAR INBOARD OF `seatAnchor`'S OWN X THE BODY SITS, as a fraction.
   *
   * `seatAnchor` puts the seat (and the steering wheel) at 46% of the car's
   * WIDEST half-width, which is measured at the belt line. A greenhouse
   * narrows above the belt, and a head is 0.6 m above it: measured on the
   * sports car, whose tumblehome is the strongest in the fleet, the crown of a
   * driver seated exactly on the anchor came out 3 mm OUTBOARD of its own side
   * glass — a head through the window, not through the roof, and invisible to
   * any test that only compares heights.
   *
   * 0.72 is chosen from the emitted greenhouse: it puts a car driver's head
   * 0.32-0.35 m off the centreline, which is where a real one sits, and leaves
   * the widest silhouette in the wardrobe 26 mm clear of the glass on the
   * tightest class. It is a `peds` correction because `peds` cannot edit
   * `vehicles`; the better fix is for `seatAnchor` to taper its own x with
   * height, and it would let this go back to 1.
   */
  trackIn: 0.72,
};

/**
 * @param P     the Poser
 * @param ph    idle phase (breathing, a slow head drift)
 * @param g     this pedestrian's gait record
 * @param a     seat arguments — `{ steer, drop }`, or a bare steer number.
 *              `steer` is -1..1, so the hands and the head move with the corner
 *              rather than being welded to the wheel. `drop` is -1..1: where the
 *              floor is relative to the seat, i.e. HOW MUCH FOOTWELL THERE IS.
 *              +1 is a truck cab, knees up and feet well below the seat; 0 is
 *              legs out along the floor with the soles level with the root; -1
 *              is a racing seat, heels HIGHER than the hips. `ped.js` derives
 *              it per car.
 *
 * WHY THE LEGS ARE A PARAMETER AND NOT A POSE.
 *
 * The head is nailed to `seatAnchor`, and the vertical distance from that
 * anchor to the road is a property of the CLASS, not of the man: 0.90 m on the
 * sports car and 2.08 m on the truck. A single leg pose therefore cannot be
 * right twice — folded knees put a sports car driver's shoes 0.34 m under his
 * own floor pan (measured), and stretched legs leave a truck driver's feet
 * dangling in the middle of the cab. So the thigh and shin angles ride between
 * "heels up on the pedals" and "knees up, feet down" on the room that is
 * actually there, and the same clip serves the whole fleet.
 *
 * The NEGATIVE half is not symmetry for its own sake. It is the only thing that
 * fits the tall end of the crowd in the sports car: 1.04 m from underside to
 * roof against a 1.94 m man who needs 1.17 m from sole to crown, with the crown
 * end non-negotiable. Feet up is what a real driver does in that car.
 */
export function sit(P, ph, g, a = 0) {
  const t = ph * TAU;
  const breath = sin(t * 0.9);
  const micro = sin(t * 1.6 + 0.7) * 0.4;
  const s = clampS(typeof a === 'number' ? a : (a?.steer ?? 0));
  const d = clampS(typeof a === 'number' ? 0.4 : (a?.drop ?? 0.4));

  // Sit down. Everything above the hips is a child of them, so this is what
  // puts the head under the headliner instead of through it.
  P.hip(0, -SEAT.hipDrop, -0.030);
  P.d('Hips', -4 + (g.stoop ?? 0) * 0.2, 0, 0);
  P.d('Spine', 5 + 0.4 * breath, -s * 1.5, s * 2.0);
  P.d('Spine1', 4 + 0.5 * breath, -s * 1.5, s * 2.0);
  P.d('Spine2', 2 + 0.6 * breath, s * 2.0, s * 1.5);
  P.d('Neck', 2 - (g.stoop ?? 0) * 0.4, s * 5 + micro, 0);
  P.d('Head', -2, s * 7 + micro * 1.5, s * 2);

  // Legs. `hip` is the thigh's angle off the bind (straight down), `knee` is
  // how far the shin folds back from the thigh — both within the anatomical
  // table in `animator.js`, so nothing here is clamped away. The two halves get
  // different slopes because a knee only bends one way: below zero the leg is
  // already nearly straight and only the thigh can keep rising.
  const hip = d < 0 ? 84 - 15 * d : 84 - 16 * d;
  const knee = d < 0 ? -6 - 6 * d : -6 - 40 * d;
  P.d('UpLegR', hip, 5, -7);
  P.d('LegR', knee, 0, 0);
  P.d('FootR', 16 + 10 * d, -3, 2);
  P.d('UpLegL', hip - 4, -7, 9);
  P.d('LegL', knee + 5, 0, 0);
  P.d('FootL', 12 + 10 * d, 4, -2);

  // Hands on the wheel: both arms forward and in, elbows down and out.
  P.d('ClavicleR', 4, 0, 5);
  P.d('ClavicleL', 4, 0, -5);
  P.d('UpperArmR', 52 - s * 16, -10, 22);
  P.d('UpperArmL', 52 + s * 16, 10, -22);
  P.d('ForearmR', 48 + s * 10, 0, 0);
  P.d('ForearmL', 48 - s * 10, 0, 0);
  P.d('HandR', 10, -14, 0);
  P.d('HandL', 10, 14, 0);
}

function clampS(v) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/* ------------------------------------------------------------------ */
/* Additive behaviour layers                                           */
/* ------------------------------------------------------------------ */

/**
 * Checking a phone: the near arm folds up to chest height, the head drops onto
 * it, the far arm settles. Additive so it works while walking, which is exactly
 * how it looks on a real street.
 */
export function phoneAdd(P, w, ph, side = 1) {
  if (w <= 0) return;
  const s = side > 0 ? 'L' : 'R';
  const o = side > 0 ? 'R' : 'L';
  const t = ph * TAU;
  const thumb = sin(t * 3.1) * 0.5 + 0.5;
  P.d(`Clavicle${s}`, -6 * w, 3 * w * side, -4 * w * side);
  P.d(`UpperArm${s}`, 38 * w, 0, -14 * w * side);
  P.d(`Forearm${s}`, 62 * w + 3 * w * thumb, 0, 0);
  P.d(`Hand${s}`, -8 * w, 12 * w * side, 0);
  P.d(`UpperArm${o}`, 6 * w, 0, 3 * w * side);
  P.d(`Forearm${o}`, 14 * w, 0, 0);
  P.d('Spine2', 4 * w, -5 * w * side, 0);
  P.d('Neck', 8 * w, -3 * w * side, 0);
  P.d('Head', 14 * w, -4 * w * side, 0);
}

/** Filming an incident: both hands up, phone held out at eye level. */
export function filmAdd(P, w, ph) {
  if (w <= 0) return;
  P.d('ClavicleR', -8 * w, -3 * w, 6 * w);
  P.d('ClavicleL', -8 * w, 3 * w, -6 * w);
  P.d('UpperArmR', 62 * w, 0, 16 * w);
  P.d('UpperArmL', 62 * w, 0, -16 * w);
  P.d('ForearmR', 52 * w, 0, -8 * w);
  P.d('ForearmL', 52 * w, 0, 8 * w);
  P.d('Spine2', -3 * w, 0, 0);
  P.d('Neck', -2 * w, 0, 0);
  P.d('Head', -3 * w, 0, 0);
}

/** Smoking: the hand comes up to the mouth on a slow cycle. */
export function smokeAdd(P, w, ph, side = -1) {
  if (w <= 0) return;
  const s = side > 0 ? 'L' : 'R';
  const t = ph * TAU;
  // draw, hold, lower: a 9 second loop
  const c = (sin(t * 0.22) * 0.5 + 0.5) ** 3;
  P.d(`Clavicle${s}`, -6 * w * c, 0, 5 * w * c * -side);
  P.d(`UpperArm${s}`, (14 + 34 * c) * w, 0, (10 + 12 * c) * w * -side);
  P.d(`Forearm${s}`, (26 + 62 * c) * w, 0, 0);
  P.d(`Hand${s}`, -14 * w * c, 10 * w * c * -side, 0);
  P.d('Head', -3 * w * c, -4 * w * c * -side, 0);
  P.d('Neck', 2 * w * c, 0, 0);
}

/** Talking: gesturing hands and a nodding head. */
export function talkAdd(P, w, ph, energy = 1) {
  if (w <= 0) return;
  const t = ph * TAU;
  const beat = sin(t * 1.9) * 0.6 + sin(t * 3.3 + 1.1) * 0.4;
  const beat2 = sin(t * 2.3 + 2.0) * 0.6 + sin(t * 4.1) * 0.4;
  const e = w * energy;
  P.d('UpperArmR', (16 + 10 * beat) * e, 0, (8 + 6 * beat) * e);
  P.d('ForearmR', (44 + 18 * beat) * e, 0, 0);
  P.d('HandR', 10 * beat * e, 14 * beat * e, 0);
  P.d('UpperArmL', (10 + 8 * beat2) * e, 0, -(6 + 5 * beat2) * e);
  P.d('ForearmL', (32 + 14 * beat2) * e, 0, 0);
  P.d('Spine2', 2 * beat * e, 3 * beat2 * e, 0);
  P.d('Neck', 3 * beat * e, 2 * beat2 * e, 0);
  P.d('Head', 4 * beat * e, 4 * beat2 * e, 2 * beat * e);
}

/** Hands in pockets — the default cold-day carry. */
export function pocketsAdd(P, w) {
  if (w <= 0) return;
  P.d('ClavicleR', 3 * w, 0, 2 * w);
  P.d('ClavicleL', 3 * w, 0, -2 * w);
  P.d('UpperArmR', 12 * w, 0, 9 * w);
  P.d('UpperArmL', 12 * w, 0, -9 * w);
  P.d('ForearmR', 26 * w, 0, -6 * w);
  P.d('ForearmL', 26 * w, 0, 6 * w);
  P.d('HandR', -6 * w, 0, 0);
  P.d('HandL', -6 * w, 0, 0);
}

/** Arms folded across the chest. */
export function foldedAdd(P, w) {
  if (w <= 0) return;
  P.d('ClavicleR', -6 * w, 4 * w, 4 * w);
  P.d('ClavicleL', -6 * w, -4 * w, -4 * w);
  P.d('UpperArmR', 44 * w, 0, 22 * w);
  P.d('UpperArmL', 40 * w, 0, -22 * w);
  P.d('ForearmR', 76 * w, 0, -14 * w);
  P.d('ForearmL', 82 * w, 0, 14 * w);
  P.d('Spine2', 3 * w, 0, 0);
}

/** Carrying a bag or a coffee in one hand: the arm is stiffer and swings less. */
export function carryAdd(P, w, side = 1) {
  if (w <= 0) return;
  const s = side > 0 ? 'L' : 'R';
  P.d(`UpperArm${s}`, 6 * w, 0, 4 * w * -side);
  P.d(`Forearm${s}`, 22 * w, 0, 0);
  P.d(`Hand${s}`, -4 * w, 0, 0);
  P.d(`Clavicle${s}`, -2 * w, 0, 2 * w * -side);
}

/** Holding an umbrella overhead. */
export function umbrellaAdd(P, w, side = -1) {
  if (w <= 0) return;
  const s = side > 0 ? 'L' : 'R';
  P.d(`Clavicle${s}`, -10 * w, 0, 8 * w * -side);
  P.d(`UpperArm${s}`, 58 * w, 0, 24 * w * -side);
  P.d(`Forearm${s}`, 66 * w, 0, -10 * w * -side);
  P.d(`Hand${s}`, -18 * w, 0, 0);
  P.d('Spine2', -2 * w, 0, 2 * w * -side);
}

/* ------------------------------------------------------------------ */
/* Reactions                                                           */
/* ------------------------------------------------------------------ */

/** Flinch at a bang: shoulders up, head down, a half crouch. `t` is 0..1. */
export function flinchAdd(P, t, k = 1) {
  if (t > 1) return;
  const e = Math.sin(Math.PI * Math.min(1, t)) ** 0.6 * k;
  P.d('Hips', 9 * e, 0, 0);
  P.d('Spine', 11 * e, 0, 0);
  P.d('Spine1', 10 * e, 0, 0);
  P.d('Spine2', 8 * e, 0, 0);
  P.d('Neck', -10 * e, 0, 0);
  P.d('Head', -14 * e, 0, 0);
  P.d('ClavicleR', -16 * e, 0, 10 * e);
  P.d('ClavicleL', -16 * e, 0, -10 * e);
  P.d('UpperArmR', 26 * e, 0, 20 * e);
  P.d('UpperArmL', 26 * e, 0, -20 * e);
  P.d('ForearmR', 58 * e, 0, 0);
  P.d('ForearmL', 58 * e, 0, 0);
  P.d('UpLegR', 14 * e, 0, 0);
  P.d('LegR', -24 * e, 0, 0);
  P.d('UpLegL', 12 * e, 0, 0);
  P.d('LegL', -22 * e, 0, 0);
  P.hip(0, -0.10 * e, 0);
}

/** Cowering: down on one knee, arms over the head. */
export function cower(P, ph, g) {
  const t = ph * TAU;
  const shake = sin(t * 5.1) * 0.5 + sin(t * 8.3) * 0.3;
  P.hip(0, -0.44, -0.04);
  P.d('Hips', 26, 0, 4);
  P.d('Spine', 22, 0, -3);
  P.d('Spine1', 20, 0, -2);
  P.d('Spine2', 16 + shake, 0, 0);
  P.d('Neck', -22, 0, 0);
  P.d('Head', -26, 3 * shake, 0);
  P.d('UpLegR', 66, 6, -8);
  P.d('LegR', -122, 0, 0);
  P.d('FootR', 46, -3, 0);
  P.d('UpLegL', 54, -8, 10);
  P.d('LegL', -110, 0, 0);
  P.d('FootL', 42, 5, 0);
  P.d('ClavicleR', -22, 0, 14);
  P.d('ClavicleL', -22, 0, -14);
  P.d('UpperArmR', 96, 0, 34);
  P.d('UpperArmL', 96, 0, -34);
  P.d('ForearmR', 104, 0, -10);
  P.d('ForearmL', 104, 0, 10);
}

/** Fleeing: run with the head twisted back and the arms high. */
export function fleeAdd(P, w, ph) {
  if (w <= 0) return;
  const t = ph * TAU;
  P.d('Spine2', 2 * w, 0, 0);
  P.d('Neck', -6 * w, 0, 0);
  P.d('Head', -10 * w, 22 * w * (sin(t * 0.7) > 0 ? 1 : -1), 0);
  P.d('ClavicleR', -8 * w, 0, 6 * w);
  P.d('ClavicleL', -8 * w, 0, -6 * w);
  P.d('ForearmR', 22 * w, 0, 0);
  P.d('ForearmL', 22 * w, 0, 0);
}

/** Gawking at an incident: rubbernecking, one hand half raised. */
export function gawkAdd(P, w, ph) {
  if (w <= 0) return;
  const t = ph * TAU;
  const s = sin(t * 0.6);
  P.d('Spine2', -3 * w, 0, 0);
  P.d('Neck', -4 * w, 3 * w * s, 0);
  P.d('Head', -7 * w, 5 * w * s, 2 * w * s);
  P.d('UpperArmR', 12 * w, 0, 8 * w);
  P.d('ForearmR', 34 * w, 0, 0);
  P.d('HandR', -10 * w, 0, 0);
}

/** A swung punch, for the ones who fight back. `t` is 0..1 over 0.5 s. */
export function punch(P, t, side = -1) {
  if (t > 1) return;
  const s = side > 0 ? 'L' : 'R';
  const o = side > 0 ? 'R' : 'L';
  const wind = Math.sin(Math.PI * Math.min(1, t * 2.6)) * (t < 0.38 ? 1 : 0);
  const strike = t >= 0.30 ? Math.sin(Math.PI * Math.min(1, (t - 0.30) / 0.70)) : 0;
  P.d('Spine2', -8 * wind + 6 * strike, 26 * wind * -side - 34 * strike * -side, 0);
  P.d('Spine1', -4 * wind + 3 * strike, 12 * wind * -side - 16 * strike * -side, 0);
  P.d('Hips', 0, 8 * wind * -side - 12 * strike * -side, 0);
  /**
   * THE LATERAL CHANNEL MUST CARRY THE MIRROR SIGN.
   *
   * `z > 0` tips a bone toward the character's right, so "away from the body"
   * is +z on a right limb and -z on a left one — which is why every other sided
   * clip in this file writes `z` as `X * side` or `X * -side`, and why the
   * three torso lines above do it too. These three did not: they wrote a FIXED
   * +8 / +16 / -10 while `s` and `o` flipped with `side`. A left-handed punch
   * therefore drove the punching arm ACROSS the chest and folded the guard arm
   * inward at the same time, at the exact moment `UpperArm x` peaks at 82 and
   * `Forearm x` swings 92 -> -74. Both callers pick the side on a coin flip
   * (`ped.js` `_updateFight`, `crew.js`), so half of every fight looked like
   * that. `LEGACY.punchSign` restores it for `poseprobe.mjs`'s negative
   * control.
   */
  const m = LEGACY.mirrorSigns ? 1 : -side;
  P.d(`Clavicle${s}`, -10 * wind - 16 * strike, 0, 8 * (wind + strike) * m);
  P.d(`UpperArm${s}`, 22 * wind + 82 * strike, 0, 16 * strike * m);
  P.d(`Forearm${s}`, 92 * wind - 74 * strike, 0, 0);
  P.d(`UpperArm${o}`, 30 * strike, 0, -10 * strike * m);
  P.d(`Forearm${o}`, 62 * strike, 0, 0);
  P.d('Head', 4 * strike, -14 * strike * -side, 0);
}

/** Diving out of the way of a car. `t` is 0..1 over ~0.7 s. */
export function dive(P, t, side = 1) {
  if (t > 1) return;
  const rise = Math.sin(Math.PI * Math.min(1, t * 1.15));
  const tuck = Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.15) * 1.35)));
  P.hip(side * 0.16 * rise, 0.10 * rise - 0.30 * Math.max(0, t - 0.6) * 2.5, 0.04 * rise);
  P.d('Hips', 34 * tuck, 0, -26 * side * rise);
  P.d('Spine', 22 * tuck, 0, -12 * side * rise);
  P.d('Spine1', 16 * tuck, 0, -8 * side * rise);
  P.d('Spine2', 10 * tuck, -16 * side * rise, 0);
  P.d('Neck', -14 * tuck, 8 * side * rise, 0);
  P.d('Head', -18 * tuck, 10 * side * rise, 0);
  /**
   * THE LIMBS HAVE TO FOLLOW THE SIDE TOO.
   *
   * Everything above this point mirrors with `side` — the hip offset, the whole
   * spine, the neck and the head — and everything below it used to be written
   * out in fixed R/L pairs with the leading leg ALWAYS the right one (74 deg of
   * tuck against 58, and -12 of splay against +14). So a dive to the left rolled
   * the torso left while the legs tucked as though it were going right: the same
   * species of defect as the punch above, a side-dependent pose with a
   * side-independent limb. `A` is whichever leg leads, `zk` mirrors the lateral
   * channels, and at `side = +1` this is byte-identical to what it replaced.
   */
  const A = LEGACY.mirrorSigns || side > 0 ? 'R' : 'L';
  const B = LEGACY.mirrorSigns || side > 0 ? 'L' : 'R';
  const zk = LEGACY.mirrorSigns || side > 0 ? 1 : -1;
  P.d(`UpLeg${A}`, 74 * tuck, 0, -12 * tuck * zk);
  P.d(`Leg${A}`, -96 * tuck, 0, 0);
  P.d(`UpLeg${B}`, 58 * tuck, 0, 14 * tuck * zk);
  P.d(`Leg${B}`, -84 * tuck, 0, 0);
  P.d(`Clavicle${A}`, -20 * rise, 0, 16 * rise * zk);
  P.d(`Clavicle${B}`, -20 * rise, 0, -16 * rise * zk);
  P.d(`UpperArm${A}`, 72 * rise, 0, 28 * rise * zk);
  P.d(`UpperArm${B}`, 72 * rise, 0, -28 * rise * zk);
  P.d(`Forearm${A}`, 34 * rise, 0, 0);
  P.d(`Forearm${B}`, 34 * rise, 0, 0);
}

/** Turn-in-place step. */
export function turnStep(P, t, dir) {
  const e = Math.sin(Math.PI * Math.min(1, t));
  const s = dir > 0 ? 'R' : 'L';
  const o = dir > 0 ? 'L' : 'R';
  P.d(`UpLeg${s}`, 12 * e, dir * 16 * e, 0);
  P.d(`Leg${s}`, -32 * e, 0, 0);
  P.d(`Foot${s}`, 15 * e, 0, 0);
  P.d(`UpLeg${o}`, -4 * e, -dir * 4 * e, 0);
  P.d(`Leg${o}`, -10 * e, 0, 0);
  P.d('Hips', 0, dir * 6 * e, dir * -2 * e);
  P.hip(0, -0.012 * e, 0);
}

/** Hurt: favouring one side, slower and lower. */
export function hurtAdd(P, w, ph) {
  if (w <= 0) return;
  const t = ph * TAU;
  P.hip(0, -0.07 * w, -0.02 * w);
  P.d('Hips', 9 * w, 0, 5 * w);
  P.d('Spine', 12 * w, 0, -4 * w);
  P.d('Spine1', 9 * w, 0, -3 * w);
  P.d('Spine2', 5 * w + sin(t * 1.6) * w, 0, 0);
  P.d('Neck', 4 * w, 0, 0);
  P.d('ClavicleR', -6 * w, 0, 4 * w);
  P.d('UpperArmR', 22 * w, 0, 14 * w);
  P.d('ForearmR', 58 * w, 0, 0);
  P.d('UpLegR', 8 * w, 0, -3 * w);
  P.d('LegR', -14 * w, 0, 0);
}

export const CLIPS = { idle, walk, jog, run, wait, lean, cower, sit };
