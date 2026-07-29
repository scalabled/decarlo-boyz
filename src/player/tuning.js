/**
 * Every number that defines how the player feels, in one place.
 *
 * Calibrated against Grand Theft Auto V's on-foot and in-car cameras. Where a
 * value is a direct measurement off GTA V footage it says so.
 *
 *   walk            ~1.7 m/s   (stick barely deflected)
 *   jog             ~3.3 m/s   (default run, no sprint key)
 *   sprint          6.4-7.9    (per brother, DESIGN.md "run speed")
 *   crouch walk     ~1.5 m/s
 *   jump apex       ~0.62 m
 *   camera distance 3.4 m at rest -> 4.6 m at sprint, 1.6 m aiming
 *   camera height   0.45 m above the chest anchor at rest -> 0.14 m at sprint
 *   chase camera    6.2 m behind the car at rest -> 8.6 m at 40 m/s
 *
 * Gravity comes from UNITS.gravity so the jump arc matches the rest of the
 * game's physics rather than a private constant.
 */

import { UNITS, FIXED_DT } from '../core/config.js';
import { BROTHERS } from './brothers.js';
import { DEG } from './springs.js';

/**
 * The fastest run speed any brother has (DESIGN.md: 6.4 / 6.9 / 7.9).
 *
 * Anything that turns "how fast am I going" into a 0..1 for a camera or a pose
 * normalises against THIS, not against a brother's own top speed and not
 * against `MOVE.sprintSpeed`. Both of those flatten the cast:
 *
 *   - against `MOVE.sprintSpeed` (6.9) the clamp binds for Dylan, so his last
 *     1.0 m/s produced no camera or pose response at all and he was framed
 *     identically to Aidan;
 *   - against each brother's own top speed every brother saturates at 1.0, so
 *     all three sprints look the same through the lens — which is the opposite
 *     of what "the brothers should feel different to move" asks for.
 *
 * Against the cast maximum the three sit at 0.81 / 0.87 / 1.00 and the camera
 * and the run pose separate them without any per-brother special-casing.
 */
export const TOP_RUN_SPEED = Math.max(
  ...Object.values(BROTHERS).map((b) => b.runSpeed)
);

export const GRAVITY = UNITS.gravity; // negative, -20.6 m/s^2

/**
 * Jump apex, metres above the take-off surface. MEASURED, not assumed:
 * `src/player/moveprobe.mjs` reads it off the emitted trajectory at 120 Hz.
 *
 * WHY 0.95. The previous 0.62 (which emitted 0.60 m) was not high enough, for
 * a geometric reason rather than a matter of taste:
 *
 *   - `STANCE.stand.stepHeight` is 0.42 m, and anything at or under that is
 *     WALKED over without the key being pressed at all. A jump worth 1.4x the
 *     step height barely does anything the legs were not already doing, which
 *     is exactly what "not high enough" feels like from the inside. 0.95 is
 *     2.3x, so pressing Space is visibly a different capability.
 *   - The street furniture this city is made of: kerb 0.15, stair riser ~0.18,
 *     bench 0.45, jersey barrier 0.8, car bonnet ~0.9. 0.95 clears every one of
 *     them with margin — "clear a kerb without thinking about it, and reach
 *     what looks reachable".
 *   - Against the body: the capsule is 1.78 m and the neck anchor 1.44 m, so
 *     0.95 lifts the feet to a bit above waist height. That reads as athletic.
 *     Past ~1.1 m it starts reading as a superhero, which this game is not.
 *   - It does NOT have to reach a first-floor window: `MOVE.mantle` already
 *     covers 0.36-2.0 m obstacles when you run at them. The jump's job is to
 *     make low street furniture free, and the mantle's job is everything above.
 *   - Air time follows from the apex and gravity: v0 = 6.25 m/s, up in 0.30 s,
 *     0.61 s in total. Under ~0.5 s reads twitchy and over ~0.8 s reads lunar;
 *     0.61 s is inside the band the genre uses.
 *
 * Landing speed is sqrt(2 g h) = 6.25 m/s, still well under
 * `MOVE.stumble.landSpeed` (9.5), so a flat jump lands clean rather than
 * stumbling — check that again if this number is ever raised much further.
 */
export const JUMP_APEX = 0.95;

/**
 * Take-off speed, solved so the EMITTED apex is `JUMP_APEX`.
 *
 * The textbook v = sqrt(2 g h) is the continuous answer, and the integrator is
 * not continuous. `Movement.step` is semi-implicit Euler — the velocity takes
 * the whole step's gravity before the position uses it — so the arc peaks at
 *
 *     v0^2 / (2g)  -  v0 * h / 2
 *
 * i.e. exactly half a step's worth of rise short. At 120 Hz that is 26 mm, and
 * it is why an authored 0.62 measured 0.60 and an authored 0.95 measured 0.924.
 * Small, but it makes the constant a lie, and the next person to tune it has to
 * rediscover the offset. Inverting the discrete expression instead
 *
 *     v0 = ( g*h + sqrt( (g*h)^2 + 8*g*A ) ) / 2
 *
 * makes JUMP_APEX mean the number `moveprobe.mjs` reads off the trajectory.
 *
 * Applied as an ASSIGNMENT in `Movement._doJump`, never as an addition, and
 * never scaled by the ground normal, the gait, or the frame the input lands on.
 * That is what makes the same input produce the same height wherever the
 * character is standing: measured over 69 jumps across flat ground, slopes,
 * kerbs and steps and four gaits, the spread is 0.00 m.
 */
const G_ABS = Math.abs(GRAVITY);
export const JUMP_SPEED =
  (G_ABS * FIXED_DT + Math.sqrt((G_ABS * FIXED_DT) ** 2 + 8 * G_ABS * JUMP_APEX)) / 2;

/** Capsule + eye/anchor geometry per stance. */
export const STANCE = {
  stand: {
    name: 'stand',
    height: UNITS.playerHeight, // 1.78
    eye: UNITS.playerHeight - UNITS.eyeOffset, // 1.66 — kept for compat
    /** Where the third-person camera pivots: base of the neck. */
    anchor: 1.44,
    stepHeight: 0.42,
    strideLength: 1.5,
  },
  crouch: {
    name: 'crouch',
    height: UNITS.playerCrouchHeight, // 1.12
    eye: UNITS.playerCrouchHeight - 0.1,
    anchor: 0.98,
    stepHeight: 0.3,
    strideLength: 0.95,
  },
  /** Retained so anything that still asks for prone gets a sane record. */
  prone: {
    name: 'prone',
    height: 0.7,
    eye: 0.4,
    anchor: 0.45,
    stepHeight: 0.14,
    strideLength: 0.7,
  },
  swim: {
    name: 'swim',
    height: 1.1,
    eye: 0.95,
    anchor: 0.86,
    stepHeight: 0.05,
    strideLength: 1.2,
  },
};

export const MOVE = {
  /** Gait speeds. `sprint` is overridden per brother from DESIGN.md. */
  walkSpeed: 1.72,
  jogSpeed: 3.35,
  sprintSpeed: 6.9,
  crouchSpeed: 1.48,
  swimSpeed: 2.1,
  swimSprint: 3.4,

  /** Aiming locks you to a slow strafe, GTA-style. */
  aimSpeed: 1.9,
  /** A swing commits: you can shuffle into it, you cannot run through it. */
  meleeSpeed: 1.55,
  /** Directional scaling — slower sideways, slower still backwards. */
  strafeScale: 0.86,
  backScale: 0.74,

  /**
   * Ground response. Deliberately softer than a shooter: GTA's character has
   * mass and takes ~0.35 s to reach sprint, and rolls off rather than stopping
   * dead. `stopDecel` is what makes a sprint->stop read as weight.
   */
  groundAccel: 22,
  groundDecel: 26,
  stopDecel: 15,
  /** Sprint stops take longer and go through the `stop` animation state. */
  hardStopSpeed: 4.2,
  hardStopDecel: 11,
  hardStopTime: 0.42,

  airAccelScale: 0.16,
  airSpeedCap: 3.0,
  terminalSpeed: 55,

  /** Facing turn rate, rad/s. Slower at speed, so sprint arcs are wide. */
  turnRateIdle: 12.0,
  turnRateWalk: 9.0,
  turnRateSprint: 3.6,
  /** Stationary re-facing beyond this angle plays a turn-in-place. */
  turnInPlaceAngle: 55 * DEG,
  turnInPlaceRate: 4.2,

  coyoteTime: 0.1,
  jumpBuffer: 0.14,
  jumpCooldown: 0.3,

  /** Stumble: triggered by a hard landing or by hitting a wall at a sprint. */
  stumble: {
    landSpeed: 9.5,
    wallSpeed: 5.2,
    time: 0.55,
    slow: 0.45,
  },

  mantle: {
    autoVaultMax: 0.85,
    minHeight: 0.36,
    maxHeight: 2.0,
    reach: 0.68,
    landDepth: 0.5,
    vaultTime: 0.42,
    mantleTime: 0.78,
    highMantleTime: 1.0,
    cooldown: 0.22,
    autoSpeed: 2.6,
    proactiveDistance: 0.24,
    proactiveLookahead: 0.04,
  },

  /**
   * Swimming. `world.isWater` decides where; this decides how it feels.
   *
   * Every depth here is metres of water above the FEET. That matters: the old
   * `float: 0.28` was documented as "how high the head floats above the
   * surface" but was applied to the foot depth, so the equilibrium put the feet
   * 28 cm under and the entire torso in the air — a character standing on the
   * river rather than swimming in it. The float line is now the body depth, and
   * 1.32 m of a 1.78 m body under water leaves the head and shoulders out.
   */
  swim: {
    /** Depth of water at which we start swimming / stop. */
    enterDepth: 1.25,
    exitDepth: 0.95,
    /** Rest depth treading water; kicking up; diving and holding under. */
    floatDepth: 1.32,
    surfaceDepth: 1.05,
    diveDepth: 2.6,
    buoyancy: 6.0,
    drag: 2.6,
    maxVertical: 3.2,
    /** Stroke response: reach speed in ~0.5 s, coast down over ~1 s. */
    accel: 4.2,
    coast: 1.4,
    /** Head clearance above the neck anchor, for the submerged test. */
    headOffset: 0.16,
    /** Seconds of air, and seconds to refill a full set of lungs. */
    breathTime: 26,
    recoverTime: 4.5,
    /** Health per second once the air is gone, applied on this tick. */
    drownDps: 22,
    drownTick: 0.5,
    /** How much of your stroke you keep while drowning. */
    drownSlow: 0.45,
    /** Above this depth you cannot reach a bank to climb out. */
    climbMaxDepth: 2.1,
  },

  /** Stance transition time constants (seconds to 63 %). */
  stanceTau: {
    standCrouch: 0.075,
    crouchStand: 0.085,
    prone: 0.16,
  },

  /** Retained so the old lean API keeps working; third person does not lean. */
  lean: { offset: 0, roll: 0, drop: 0, rate: 0.085, probeRadius: 0.17 },
};

/* ====================================================================== */
/* NITRO                                                                  */
/* ====================================================================== */

/**
 * Vehicle boost, on the SPRINT control — Shift on foot runs, Shift in a car
 * boosts. That is what GAMEPLAY.md records, and it is why holding Shift in a
 * car and getting nothing back reads as a broken control. Until this existed,
 * `boost` was a channel `vehicles` accepted and only AI missions ever wrote —
 * the player could not reach it at all.
 *
 * Rates, out of 100: `v.nitro - dt * 28` while boosting, `+ dt * 5` while not.
 *
 *   drain 28/s  -> 3.6 s of continuous boost from full
 *   charge 5/s  -> 20 s to refill from empty
 *
 * Two gates, both kept: boost does nothing with an empty tank, and nothing off
 * the throttle — so it cannot be used as a brake booster or burned while
 * sitting still.
 */
export const NITRO = {
  max: 100,
  drain: 28,
  charge: 5,
  /** Minimum throttle before the bottle opens. */
  minThrottle: 0.05,
  /** Below this the tank is treated as empty, so it cannot stutter on and off. */
  cutoff: 0.5,
};

/* ====================================================================== */
/* CAMERA                                                                 */
/* ====================================================================== */

/**
 * The third-person rig. Read the long comment in camera.js for the model; these
 * are the constants it is tuned with.
 */
export const CAMERA = {
  /** config.fov is an 80-degree first-person value; third person wants ~62. */
  fovScale: 0.775,
  /** ...and the fourth view is first person, so it wants most of it back. */
  fovScaleNear: 0.95,

  /** Pivot follow. Vertical is looser so stairs and kerbs do not jolt. */
  follow: {
    tauXZ: 0.055,
    tauY: 0.155,
    /** In the air the vertical follow tightens or you lose the character. */
    tauYAir: 0.085,
    /** Hard leash — the pivot may never lag further than this behind. */
    maxLag: 1.4,
  },

  orbit: {
    /** Mouse sensitivity multiplier relative to config.sensitivity. */
    sens: 1.0,
    pitchMin: -68 * DEG, // looking down at the character from above
    pitchMax: 34 * DEG,
    /** Rest pitch, slightly above the horizon looking down. */
    restPitch: -8 * DEG,
    /** How fast the orbit settles onto the mouse target. */
    tau: 0.028,
    /**
     * Auto-centre behind the character when running and the stick is not being
     * used to look. GTA does this gently; too fast and it fights the player.
     */
    autoTau: 1.1,
    autoSpeed: 3.4, // m/s before auto-centre starts
    autoDelay: 1.35, // s of no look input
  },

  /** Boom geometry. All lengths in metres from the pivot. */
  boom: {
    distIdle: 3.4,
    distSprint: 4.65,
    /** Additive, on the sprint STATE rather than the speed. See CAMERA.fov. */
    distSprintCommit: 0.18,
    distAim: 1.62,
    distCrouch: -0.22, // additive
    distVault: 0.55, // additive, pull back so the climb reads

    heightIdle: 0.46,
    heightSprint: 0.14,
    heightAim: 0.2,

    /** Constant right-shift so the character sits left of centre. */
    lateralIdle: 0.2,
    lateralAim: 0.62,
    /** Aim shoulder swap speed. */
    swapTau: 0.11,

    /** Time constants for the boom itself reacting to speed / aim. */
    tau: 0.24,
    aimTau: 0.08,
    /**
     * ...and while a view change is in flight. The 0.24 s speed filter is right
     * for a boom reacting to a sprint but wrong for a deliberate dolly: pressing
     * V and watching the camera take 1.5 s to arrive reads as lag, not weight.
     * The timed profile is already C1, so tracking it tightly costs no
     * continuity — measured peak 59 m/s^2 over a full four-view cycle.
     */
    viewTau: 0.07,

    /** The point the camera looks at, relative to the pivot. */
    lookUpIdle: 0.05,
    lookUpAim: 0.12,
    /** Lead the look target in the direction of travel. */
    lead: 0.1,
  },

  /**
   * Collision. A sphere cast from the pivot to the ideal boom position; the
   * boom is shortened to the first blocker. Pull-in is near-instant (a wall
   * must never be entered), push-out is slow (that is what stops the jitter in
   * a tight alley, where the cast flickers between hit and miss).
   */
  collide: {
    radius: 0.3,
    pad: 0.1,
    /** Below this the character is faded rather than the camera being shoved. */
    minDist: 0.55,
    tauIn: 0.045,
    /**
     * Pull-in during a view change. Raising the pivot 22 cm onto the head can
     * make the sphere cast hit a different surface, and `held` then steps by
     * metres in one frame; at the 45 ms combat time constant that is a 55 m/s
     * velocity discontinuity (measured 778 m/s^2 in a tight alley). The
     * geometry is static for the half second a view change lasts, so a softer
     * pull-in there is safe — the hard `min(radius, wantRadius)` clamp still
     * guarantees the boom never exceeds what the solver asked for.
     */
    tauInView: 0.13,
    tauOut: 0.34,
    /** Do not grow the boom until the free space beats the current by this. */
    hysteresis: 0.06,
    /**
     * Frames of free-space history the boom takes the MINIMUM of. A sphere cast
     * along a wall flickers hit/miss frame to frame; without this window the
     * boom chases the flicker and the whole frame vibrates.
     */
    window: 8,
    /** Fade the character out when the camera ends up inside him. */
    fadeStart: 1.1,
    fadeEnd: 0.55,
  },

  fov: {
    sprintGain: 7.5, // degrees added at full sprint
    /**
     * ...plus this much the moment the sprint STATE engages, before the speed
     * has ramped. Sprint has to be legible immediately or the player cannot
     * tell whether Shift did anything — which is half of what "shift to run
     * doesn't always work" was reporting. Small on purpose: the speed term
     * still carries the sensation, this only confirms the input.
     */
    sprintCommitGain: 2.0,
    aimScale: 0.76,
    airGain: 2.5,
    tau: 0.16,
    aimTau: 0.06,
  },

  /** Landing dip / footstep shift / trauma, same channels as before. */
  land: {
    minSpeed: 3.0,
    fullSpeed: 13.5,
    dipImpulse: 1.05,
    pitch: 2.2 * DEG,
    roll: 0.6 * DEG,
    freq: 3.2,
    damping: 0.56,
    trauma: 0.3,
    damageSpeed: 15.5,
    damagePerSpeed: 7.5,
  },

  step: { impulse: 0.022, freq: 5.4, damping: 0.66, sprintScale: 1.8 },

  roll: {
    strafe: 0.5 * DEG,
    yawRate: 0.03,
    yawRateMax: 1.1 * DEG,
    tau: 0.14,
    air: 0.5 * DEG,
    slide: 0,
  },

  recoil: {
    freq: 9.5,
    damping: 0.5,
    residualTau: 0.28,
    residualShare: 0.34,
    punchFreq: 12,
    punchDamping: 0.62,
  },

  shake: { decay: 1.85, rot: 1.1, pos: 0.02, freq: 22 },

  /**
   * CRASH TRAUMA — the screen-shake accumulator. A crash already produced
   * sparks, a metal transient and a real physical jolt; the one thing missing
   * was the camera reacting at all.
   *
   * The three amounts are 0.3 on a building strike, 0.2 on a vehicle-vehicle
   * collision and 0.25 on a scripted cop ram — the last of which `police`
   * already publishes as `camera:shake { amount }` and nobody consumed.
   *
   * The severity ramp is this build's own. Gating on a raw speed
   * (`impact > 14`) and then adding a flat amount means kissing a wall at 15
   * shakes exactly as hard as hitting it at 40. This scales on the collision's
   * DELTA-V — `impulse / mass`, which is the physical measure of "how hard was
   * that" and is the same number for a bus and a bike — so a kerb scrape is
   * nothing and a real crash is the full amount.
   */
  crash: {
    building: 0.30,
    vehicle: 0.20,
    /** `camera:shake` carries its own amount; this only scales it. */
    shakeScale: 1.0,
    /**
     * Delta-v ramp, m/s. `vehicles` will not even report a collision below
     * `impulse > mass * 0.55` (dv 0.55 m/s), so the floor sits just above the
     * noise and the full amount arrives at a genuine crash.
     */
    dvMin: 1.0,
    dvFull: 5.0,
    /** A wreck you are NOT in still registers, with distance falloff. */
    near: 12,
    far: 55,
    /** ...but never at the strength of one you are sitting in. */
    remoteScale: 0.55,
  },

  breath: {
    freqA: 0.235,
    freqB: 0.155,
    amp: 0.0012,
    posAmp: 0.002,
    adsScale: 1.6,
    lowHealthScale: 2.4,
    moveDamp: 0.85,
    suppressionScale: 2.0,
  },

  pitchLimit: 88 * DEG,
  wallPad: 0.09,
};

/**
 * The vehicle chase camera. A separate solver, not a re-parameterised on-foot
 * boom: it frames the car's *direction of travel* rather than its facing, which
 * is the single thing that makes a GTA drift readable.
 */
export const CHASE = {
  /** Pivot above the car's origin; `sizeGain` adds for a big vehicle. */
  heightBase: 1.28,
  heightSizeGain: 0.4,
  followTau: 0.075,

  distBase: 6.15,
  distSpeedGain: 2.5, // at full `speedRef`
  /**
   * Per metre of vehicle length over 4.5. This had never fired: it is scaled by
   * `v.length ?? v.size?.z`, and a real Vehicle carries neither — only
   * `spec.half`. Every vehicle in the game was framed as if it were 4.5 m long
   * until `camera.js` started reading the spec. Measured effect: a truck went
   * from 6.92 m of boom to 8.58 m, a van from 6.92 to 7.72.
   */
  distSizeGain: 0.42,
  heightIdle: 1.62,
  heightFast: 1.2,
  speedRef: 38, // m/s that counts as "flat out"

  /** Blend of travel-direction over facing. 1 = pure velocity. */
  travelWeight: 0.88,
  /** Below this speed the camera uses the car's facing. */
  travelMinSpeed: 3.2,
  /** Yaw settle. Loose enough to lag through a slide, tight enough to catch up. */
  yawTau: 0.26,
  /** After a hard direction change, temporarily loosen further. */
  yawTauFast: 0.42,

  pitchBase: -9 * (Math.PI / 180),
  pitchFast: -4.5 * (Math.PI / 180),
  /** The bonnet camera looks along the road, not down at the roof. */
  pitchBonnet: -1.5 * (Math.PI / 180),
  pitchTau: 0.3,

  /** Bonnet mount, as a fraction of the vehicle's half extents. */
  bonnetUp: 0.72,
  bonnetFore: 0.52,

  fovBase: 1.0,
  fovGain: 16, // degrees at speedRef
  fovTau: 0.22,

  /** Subtle roll into lateral acceleration. */
  roll: 0.55 * (Math.PI / 180), // per m/s^2
  rollMax: 3.4 * (Math.PI / 180),
  rollTau: 0.2,

  /**
   * SPEED-PROPORTIONAL AUTO-ALIGN. The player's look offset eases back behind
   * the car at a rate that RISES WITH SPEED, and is suppressed outright while
   * the look control is being driven.
   *
   * The law, in seconds rather than frames: the rate is 0.06 per second per
   * m/s of road speed, capped at 4.8/s and engaging above 6 m/s. Over a car's
   * 26-41 m/s top-speed range that is a 2.8 s time constant at the engagement
   * threshold down to 0.44 s flat out in a sports car.
   *
   * This used to be a flat `approach(manualYaw, 0, 0.45)` after a 1.1 s hold —
   * i.e. the FLAT-OUT aggression applied at every speed including a car park.
   * That is the "camera fights you" half; the "you hand-steer the camera" half
   * is the same constant being too slow at 40 m/s. One law fixes both.
   *
   * `align.floor` is the one deliberate departure from a pure speed ramp: not
   * re-centring at all below 6 m/s leaves a parked player's view permanently
   * off-axis. The floor is exactly the ramp's own rate AT the 6 m/s threshold,
   * so the law is continuous through it and a parked camera still drifts
   * home over ~3 s instead of never.
   */
  align: {
    /** Per second, per m/s of speed. */
    perSpeed: 0.06,
    /** Never slower than the ramp's own rate at the 6 m/s gate. */
    floor: 0.36,
    /** The rate stops rising past this. */
    rateMax: 4.8,
    /**
     * YIELD INSTANTLY. While the look control has produced input within this
     * many seconds the align rate is exactly zero — the camera never argues
     * with a hand on the stick. Long enough to bridge a frame in which the
     * mouse happened not to move, short enough that release feels immediate.
     */
    suppress: 0.16,
    /**
     * ...AND RESUME GENTLY. The rate ramps in over this window (smootherstep,
     * so the resume has no velocity step either). `suppress + ease` lands at
     * 1.06 s, which is deliberately where the old 1.1 s hold was: the feel of
     * "the camera holds your view for about a second" is preserved, it just
     * arrives as a ramp instead of a cliff.
     */
    ease: 0.9,
  },

  lookPitchMin: -55 * (Math.PI / 180),
  lookPitchMax: 40 * (Math.PI / 180),

  /**
   * NEGATIVE-CONTROL SWITCH — leave this true.
   *
   * The chase solver used to compose only `recoilPitch`/`recoilYaw`/
   * `recoilRoll` plus `kickPitch`, dropping `kickYaw`, `kickRoll`, the punch
   * and the rotational half of the shake — so a melee stagger, a drive-by or a
   * crash could move `viewKick` (which the arsenal gate reads) without moving
   * the emitted camera transform at all. Setting this false restores that
   * partial composition, which is what `camtest.mjs --control=kick` does to
   * prove its recoil gates can actually go red.
   */
  fullKick: true,

  /**
   * How hard the trauma accumulator reads in a car, relative to on foot.
   *
   * The shake is `trauma^2 * 0.02 m` on a short boom, which at a crash's 0.3
   * trauma is 1.8 mm and 0.1 degrees: present in the numbers and invisible on
   * the screen.
   *
   * RATCHET. 2.5 is where this pass got to, not where the bar is — it puts a
   * building crash at roughly a quarter of a degree, which reads as a jolt
   * without ever moving the reticle far enough to miss with. The honest number
   * is higher and wants a human looking at it. Raise this only with a play
   * test, and never to make a gate go green.
   */
  shakeGain: 2.5,

  /** Blend time between the on-foot and chase solvers. */
  blendTau: 0.28,

  collideRadius: 0.36,
};

/**
 * PER-STATE FRAMING. A different distance is framed for each thing you can be
 * inside:
 *
 *   on foot 16    car 18    bus 22    helicopter 24
 *
 * and that radius is FLAT — a bus is 22 whatever its length, because the point
 * of the number is how much of the vehicle and its surroundings you want in
 * frame, not its bounding box.
 *
 * So these are those ratios against the car, applied to the car framing this
 * build already ships. `distBase` itself is untouched: the car and the on-foot
 * boom are the framings already signed off, and the 16:18 foot:car ratio above
 * describes a much longer boom than this build's 3.4:6.15 and is not
 * transferable.
 *
 * `sizeGain` is the existing `distSizeGain` per-metre-of-length term. It stays
 * on for the car class, where it is what separates a pickup from a hatchback,
 * and is OFF for any class with its own framing — otherwise a bus would be
 * paid for twice, once by its class and again by its 11 m body, and the class
 * number would stop meaning anything.
 *
 * Anything that does not resolve to a class here lands on `car` and keeps
 * exactly today's behaviour, which is what makes this safe to land before
 * `vehicles` has finished adding the bus and the helicopter.
 */
CHASE.classFrame = {
  car: { dist: CHASE.distBase, height: 1.00, sizeGain: true },
  bus: { dist: CHASE.distBase * (22 / 18), height: 1.10, sizeGain: false },
  heli: { dist: CHASE.distBase * (24 / 18), height: 1.35, sizeGain: false },
};

/* ====================================================================== */
/* THE VIEW CYCLE (V)                                                     */
/* ====================================================================== */

/**
 * Four views, one key, the same order on foot and in a car — GTA's cycle.
 *
 * `dist` / `height` / `lateral` multiply the boom the solver already wanted, so
 * a view change is a dolly along a filtered channel rather than a cut. `near`
 * is the odd one out: it drives the boom to zero and walks the pivot onto the
 * head (on foot) or the bonnet (in a car), which is what makes the fourth view
 * first-person without a second solver to blend against.
 *
 * `pitchMax` is per-view because the third-person clamp (+34 deg) exists to stop
 * the boom swinging under the character's feet — a constraint that does not
 * apply when the boom is 3 cm long and you want to look up at a tower.
 */
export const VIEWS = [
  { id: 'chase', dist: 1.00, height: 1.00, lateral: 1.00, near: 0, pitchMax: 34 * DEG },
  { id: 'close', dist: 0.68, height: 0.80, lateral: 1.10, near: 0, pitchMax: 34 * DEG },
  { id: 'far', dist: 1.62, height: 1.45, lateral: 0.85, near: 0, pitchMax: 30 * DEG },
  { id: 'near', dist: 0.02, height: 0.00, lateral: 0.00, near: 1, pitchMax: 76 * DEG },
];

/** Human-readable per-context names — `ui` can toast these. */
export const VIEW_NAMES = {
  foot: ['CHASE', 'CLOSE', 'FAR', 'FIRST PERSON'],
  vehicle: ['CHASE', 'CLOSE', 'FAR', 'BONNET'],
};

/**
 * How long a view change takes, in seconds.
 *
 * This is a TIMED transition on a smootherstep, not an exponential settle, and
 * the difference is measurable. An exponential jumps to its maximum velocity on
 * the first frame — going to first person that is 3.4 m of boom over a 0.16 s
 * time constant, i.e. 21 m/s from a standing start — which the continuity meter
 * correctly reports as a discontinuity (measured: 365 m/s^2, twice). A
 * smootherstep has zero derivative at BOTH ends, so the camera accelerates into
 * the move and decelerates out of it: same 3.4 m, peak 78 m/s^2, no spike.
 */
export const VIEW_TIME = {
  /** Floor, so chase -> close is snappy rather than ceremonial. */
  min: 0.26,
  /** ...plus this per metre of boom travel, so far -> first person is not a
   *  five-metre lunge crammed into a quarter of a second. */
  perMetre: 0.085,
  max: 0.80,
};

/* ====================================================================== */

export const HEALTH = {
  max: 100, // overridden per brother
  armour: 0,
  /** GTA V regenerates only to half health, and slowly. */
  regenDelay: 5.0,
  regenRate: 9,
  regenRamp: 0.6,
  regenCap: 0.5,
  lowThreshold: 0.32,
  criticalThreshold: 0.16,
  /** Fraction of incoming damage armour eats while it lasts. */
  armourAbsorb: 0.72,
  indicatorTime: 1.8,
  indicatorMax: 4,

  suppression: {
    perNearMiss: 0.24,
    perHit: 0.45,
    perExplosion: 0.8,
    radius: 3.2,
    decay: 0.62,
    swayScale: 1.4,
    shakeScale: 0.24,
  },

  effect: {
    desaturate: 0.62,
    vignette: 0.55,
    tint: 0.3,
    heartbeatMin: 1.05,
    heartbeatMax: 2.05,
    pulseGain: 0.42,
    hitFlash: 0.85,
    hitFlashTau: 0.22,
  },
};

export const FOOTSTEP = {
  lateral: 0.13,
  probe: 0.9,
  runSpeed: 4.6,
  landHold: 0.12,
};

/* ====================================================================== */
/* ANIMATION                                                              */
/* ====================================================================== */

/**
 * The gait model. Everything is driven from distance travelled, never from a
 * clock: `phase += distance / stride * PI`, so the feet cannot skate no matter
 * what the frame rate or the acceleration does.
 */
export const GAIT = {
  /** Reference gaits: [speed, strideLength, stanceFraction, footLift, cadence] */
  walk: { speed: 1.72, stride: 1.42, stance: 0.63, lift: 0.075, bounce: 0.022, lean: 0.02 },
  jog: { speed: 3.35, stride: 1.86, stance: 0.55, lift: 0.14, bounce: 0.044, lean: 0.075 },
  sprint: { speed: 6.9, stride: 2.64, stance: 0.42, lift: 0.28, bounce: 0.062, lean: 0.2 },
  crouch: { speed: 1.48, stride: 1.06, stance: 0.66, lift: 0.055, bounce: 0.015, lean: 0.06 },
  swim: { speed: 2.1, stride: 2.2, stance: 0.5, lift: 0.1, bounce: 0.02, lean: 0 },

  /** Arm swing amplitude in radians at each gait. */
  armSwing: { walk: 0.38, jog: 0.66, sprint: 1.02 },
  armElbow: { walk: 0.34, jog: 0.72, sprint: 1.32 },

  /** Pelvis motion. */
  hipSway: 0.055, // metres lateral at walk
  hipRoll: 0.09, // radians
  hipYaw: 0.13, // radians counter-rotation at sprint
  chestYaw: 0.16, // counter to the hips

  /** Idle. */
  idle: {
    breathFreq: 0.24,
    breathAmp: 0.011,
    shiftPeriod: 6.4, // seconds between weight shifts
    shiftAmp: 0.045,
    swayAmp: 0.008,
    headAmp: 0.03,
  },

  /** Foot IK. */
  ik: {
    /** How far above/below the animated foot we search for ground. */
    probeUp: 0.55,
    probeDown: 0.75,
    /** Time constant for the IK offset, so a kerb is absorbed not snapped. */
    tau: 0.06,
    /** Pelvis is pulled down when the lower foot cannot reach. */
    pelvisTau: 0.09,
    maxPelvisDrop: 0.34,
    /** Ankle alignment to the ground normal. */
    alignTau: 0.07,
    maxAlign: 32 * (Math.PI / 180),
    /** Never straighten the knee completely — it reads as a stick. */
    kneeMin: 0.035,
  },

  /** Blend time constants between locomotion states. */
  blend: {
    state: 0.11,
    aim: 0.13,
    stance: 0.14,
    turn: 0.16,
  },

  /**
   * THE SWING, from the waist down.
   *
   * `weapons` writes the shoulder and the elbow (see its `_driveArm`) and is
   * forbidden from touching `src/player/`. Everything below the collarbone is
   * therefore ours, and it is most of what makes a swing land: a real strike
   * starts at the back foot, runs up through the hips, and arrives at the hand
   * last. The signed arc (-1 wound up .. +1 followed through) drives all of it.
   */
  melee: {
    hipYaw: 0.40,     // rad the pelvis rotates through the arc
    chestYaw: 0.52,   // ...and the shoulders, on top of the pelvis
    lean: 0.20,       // forward lean at the follow-through
    windLean: 0.11,   // ...and back on the wind-up
    drop: 0.055,      // metres the hips drop as the weight goes in
    shift: 0.075,     // metres of lateral weight transfer
    headLag: 0.55,    // the head stays on target while the body rotates
  },

  /**
   * SWIMMING. A vertical character with the walk cycle switched off reads as a
   * drowning mannequin, which is exactly what it was. A swimmer lies down: the
   * body pitches toward horizontal as it gets moving, the hips lift so the head
   * stays at the waterline, the legs flutter and the arms take alternate
   * over-arm strokes.
   */
  swimPose: {
    treadPitch: 0.22,  // rad from vertical while treading water
    swimPitch: 1.05,   // ...and at full stroke
    /** Hip lift, as a fraction of hip-to-head, to keep the head at the surface. */
    lift: 0.72,
    kick: 0.34,        // rad of thigh flutter
    kickKnee: 0.62,
    strokeReach: 2.05, // rad the shoulder sweeps through one stroke
    strokeElbow: 0.85,
    treadArm: 0.5,
    roll: 0.16,        // body roll into each stroke
    /** Stroke rate: cycles per second at rest and at full speed. */
    rateIdle: 0.55,
    rateFast: 1.35,
  },

  /** The collapse. Not a ragdoll — a two-second fold that ends face down. */
  death: {
    time: 1.1,
    fold: 1.42,   // rad the torso folds forward
    drop: 0.62,   // metres the hips fall
    tau: 0.22,
  },

  /**
   * SITTING IN A CAR.
   *
   * The driving pose used to leave the pelvis at its standing bind height and
   * only fold the knees, so a "seated" driver was a standing man with his legs
   * out in front of him: 1.79 m of body measured up from wherever the root was
   * put. Combined with `vehicle.js` handing the seat anchor straight to the
   * root, that is how the player ended up ON THE ROOF — the crown was measured
   * at 2.80 m over a car whose roof is at 1.40 m.
   *
   * A seated body is defined here by TWO numbers, and `player/vehicle.js` reads
   * the same two to decide where to put the root. That is the whole contract:
   * `vehicles.seatAnchor()` publishes where the DRIVER'S HEAD goes (its own
   * cockpit camera sits there, `vehicles/index.js`), so the root is the anchor
   * minus the seated head height, and the pose then reproduces that height.
   *
   *   headBind  the head bone's height in the BIND pose, from
   *             `character/mesh.js` BONE_SPEC. Scales with `build.scale`.
   *   hipDrop   how far the pelvis falls to sit down.
   *
   * `hipDrop` is not a taste knob — it is pinned from both ends by a body that
   * has to fit in a cabin it is taller than. With the head on the anchor, the
   * drop is what decides where the root (and therefore the FEET) ends up:
   *
   *   too small  the root sinks below the floor pan and the driver's shoes
   *              hang out under the sill — visible on any low car, and the
   *              first thing this was caught doing at 0.62
   *   too large  nothing; the body only folds tighter
   *
   * and the binding case is the sports car, whose roof is 1.15 m over the road
   * and whose floor is 0.115 m: 1.035 m of cabin for 1.79 m of person. 0.78
   * clears the floor by 12 mm there and by 80 mm on a sedan, with the crown
   * still under every roofline in `specs.js`. `src/player/drivetest.mjs`
   * measures both ends for every class.
   *
   * It also finally lets the leg IK REACH the pedals: the old standing-pelvis
   * pose asked for a hip-to-foot span of 0.97 m out of an 0.83 m leg, so the
   * solver saturated and both legs pointed stiffly down and forward.
   */
  seat: {
    headBind: 1.548,
    hipDrop: 0.78,
    /** Seated head height over the root — the number `vehicle.js` subtracts. */
    get headHeight() { return this.headBind - this.hipDrop; },
  },
};
