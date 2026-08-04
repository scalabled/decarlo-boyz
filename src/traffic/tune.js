/**
 * TRAFFIC — tuning constants.
 *
 * Everything a human would want to twiddle lives here so the controller files
 * read as algorithm rather than as magic numbers. Units are SI: metres,
 * seconds, m/s, m/s^2, radians.
 */

/** Priority order at an unsignalised junction. Higher wins. */
export const KIND_RANK = { highway: 3, arterial: 2, street: 1, alley: 0 };

/**
 * Legal speed by road kind, m/s. `plan.js` ROAD_KIND carries a `speed` used for
 * A* cost; these are the numbers a *driver* obeys and they are deliberately a
 * little lower — a design speed is not a limit.
 *   highway 28 m/s ~ 100 km/h · arterial 15 ~ 55 · street 10.5 ~ 38 · alley 5.5 ~ 20
 */
export const KIND_LIMIT = { highway: 28, arterial: 15, street: 10.5, alley: 5.5 };

export const TUNE = {
  /* ---------------------------------------------------------- lateral -- */
  /** Pure-pursuit lookahead: L = clamp(L0 + kv * speed, min, max). */
  lookL0: 5.2,
  lookKv: 0.78,
  lookMin: 4.6,
  lookMax: 26,
  /** Extra proportional gain on cross-track error (kills steady-state offset). */
  crossTrackGain: 0.055,
  /** Damping on the rate of change of cross-track error. */
  crossRateGain: 0.10,
  /** Max change in the normalised steer command per second. */
  steerRate: 3.4,
  /** Low-pass on the steer command, per second. */
  steerSmooth: 16,

  /* ------------------------------------------------------ longitudinal -- */
  /** IDM maximum acceleration. */
  idmA: 1.95,
  /** IDM comfortable deceleration. */
  idmB: 2.7,
  /** IDM minimum bumper gap. */
  idmS0: 3.0,
  /** IDM desired time headway. */
  idmT: 1.5,
  /** IDM free-road exponent. */
  idmDelta: 4,
  /** Hard ceiling on commanded braking (emergency). */
  brakeMax: 8.5,
  /** Accel that maps to full throttle. */
  throttleRef: 2.2,
  /** Decel that maps to full brake. */
  brakeRef: 4.6,
  /** Do not touch the brake above this acceleration (deadband). */
  brakeDeadband: -0.22,

  /* ---------------------------------------------------------- corners -- */
  /** Lateral acceleration a civilian driver is willing to pull. */
  cornerLat: 3.3,
  /** Deceleration used when planning the approach to a corner. */
  cornerBrake: 2.4,
  /** Never plan a corner slower than this. */
  cornerMin: 3.2,
  /** How far ahead the corner planner looks. */
  cornerHorizon: 140,
  /**
   * Speed through a dead-end U-turn (path turn > 2.2 rad). Deliberately UNDER
   * `cornerMin`: a pi at full lock is a 4.2 m-radius arc, wider than a
   * street's half-carriageway, and the only way it stays on the road is at a
   * crawl. See `_pathSpeed`.
   */
  uturnSpeed: 2.2,
  /**
   * Cross-track error (m) past which the driver recovers the lane before
   * recovering speed, and the floor that cap never goes under. See
   * `_longitudinal` — cap = max(floor, 9.0 - 1.8 * (err - recoverLat)).
   * `recoverBrake` bounds how far below the CURRENT speed the cap may pull
   * the target in one tick's demand — the glide that keeps the front tyres
   * gripping while the car steers back to its lane.
   */
  recoverLat: 1.4,
  recoverFloor: 3.2,
  recoverBrake: 1.6,

  /* -------------------------------------------------------- junctions -- */
  /** Stop line, metres back from the junction node. */
  stopSetback: 6.0,
  /** Radius of the "junction box" a claim covers. */
  boxRadius: 11,
  /** A claim expires if the claimant has not cleared in this long. */
  claimTimeout: 9,
  /** Amber is only run if stopping would need more than this deceleration. */
  amberRunDecel: 3.4,

  /* ---------------------------------------------------- lane discipline */
  /** Speed advantage needed before considering an overtake. */
  overtakeGain: 3.2,
  /** Minimum gap behind in the target lane. */
  laneChangeBack: 9,
  /** Minimum gap ahead in the target lane. */
  laneChangeAhead: 16,
  /** Seconds a lane change takes to blend. */
  laneChangeTime: 2.2,
  /** Cooldown between lane changes. */
  laneChangeCool: 6,

  /* --------------------------------------------------------- reactions */
  /**
   * Emergency thresholds, expressed as the DECELERATION the situation demands
   * (m/s^2), not as a time-to-collision. Comfortable braking is idmB = 2.7, so
   * anything past ~4.5 is a driver who has been surprised and anything past 6
   * is both feet on the brake pedal.
   */
  hornDecel: 4.6,
  panicDecel: 6.2,
  hornCooldown: 3.2,
  /** Lateral metres a driver will swerve to avoid a head-on. */
  swerveMax: 2.1,
  /** Distance at which a lit siren makes a driver pull over. */
  sirenRadius: 48,

  /* ---------------------------------------------------------- recovery */
  /** Speed under which a driver counts as stopped. */
  stoppedSpeed: 0.45,
  /** Stopped this long with no legitimate reason -> recover. */
  stuckTime: 11,
  /** Off the carriageway this long -> re-route. */
  offroadTime: 2.4,
  /** Off the carriageway by more than this -> hard respawn. */
  offroadHard: 26,

  /* -------------------------------------------------------- population */
  /**
   * Traffic is only spawned inside this radius of the camera.
   *
   * The ceiling is not arbitrary: `world` keeps a terrain collider only within
   * +/-192 m of the player. Spawning past that put cars over a hole in the
   * collision world, and a car with nothing under it falls forever — it never
   * trips the stuck check (it is moving), never trips the off-road check (the
   * lane projection is 2D), and holds a driver slot at y = -3700 m. Half the
   * "stopped traffic" in the first measurements was cars in free fall.
   */
  spawnMin: 62,
  spawnMax: 175,
  /**
   * HARD EXCLUSION AROUND THE PLAYER'S BODY, checked on every spawn path and
   * never relaxed by `force`.
   *
   * Every distance test used to be against `anchor`, and `anchor` is the
   * CAMERA whenever the camera is more than 30 m from the player — a capture
   * shot, a cutscene, a probe that teleports the body without the rig. That is
   * how a car came to materialise 1-2 m away two frames after the area was
   * cleared: the spawn was a legal 34 m from the camera and on top of the
   * player. The player is not the anchor and must be tested for separately.
   */
  spawnPlayerMin: 34,
  /**
   * A car may only appear inside the view cone beyond this, and only when the
   * spawner is otherwise failing. Materialising is imperceptible at a hundred
   * metres down a street and unmissable at thirty.
   */
  popSafe: 110,
  /** Despawn beyond this, when not on screen. */
  despawnR: 300,
  /** Despawn beyond this even if on screen. */
  despawnHard: 480,
  /** Spawns per second at steady state. */
  spawnRate: 2.2,
  /** Never spawn within this of another vehicle. */
  spawnClear: 22,
  /** Cosine of the half-angle counted as "on screen" for spawn suppression. */
  screenCos: 0.55,
  /** ...but only suppress within this distance. */
  screenNear: 150,
};

/**
 * Per-district vehicle mix. Weights over the `vehicles` class ids; `police`
 * and `boat` are never civilian traffic. Falls back to `default`.
 */
export const DISTRICT_MIX = {
  default:   { sedan: 46, van: 16, muscle: 12, sports: 8, truck: 12, bike: 0 },
  downtown:  { sedan: 52, van: 12, muscle: 8, sports: 18, truck: 4, bike: 0 },
  point:     { sedan: 54, van: 12, muscle: 10, sports: 14, truck: 4, bike: 0 },
  strip:     { sedan: 40, van: 24, muscle: 12, sports: 6, truck: 12, bike: 0 },
  steelrow:  { sedan: 22, van: 20, muscle: 12, sports: 2, truck: 40, bike: 0 },
  hazel:     { sedan: 28, van: 20, muscle: 14, sports: 3, truck: 30, bike: 0 },
  lawren:    { sedan: 44, van: 16, muscle: 18, sports: 6, truck: 10, bike: 0 },
  southside: { sedan: 40, van: 18, muscle: 18, sports: 6, truck: 12, bike: 0 },
  northsh:   { sedan: 46, van: 16, muscle: 12, sports: 10, truck: 10, bike: 0 },
  troy:      { sedan: 44, van: 18, muscle: 14, sports: 4, truck: 14, bike: 0 },
  mtwash:    { sedan: 50, van: 14, muscle: 12, sports: 8, truck: 8, bike: 0 },
  westend:   { sedan: 42, van: 18, muscle: 14, sports: 5, truck: 16, bike: 0 },
  northside: { sedan: 44, van: 18, muscle: 14, sports: 5, truck: 13, bike: 0 },
};

/**
 * Traffic volume through the day, indexed by hour 0-23. Two commuter peaks,
 * a midday plateau, and a city that genuinely empties out at 4 am — which is
 * the whole point of having a clock.
 */
export const HOUR_VOLUME = [
  0.14, 0.10, 0.08, 0.07, 0.07, 0.13, // 0-5
  0.32, 0.68, 0.98, 0.86, 0.66, 0.62, // 6-11
  0.70, 0.66, 0.64, 0.74, 0.95, 1.00, // 12-17
  0.88, 0.66, 0.50, 0.40, 0.30, 0.20, // 18-23
];

/**
 * How much of the day/night swing a district actually shows. Downtown empties
 * at night; an industrial road is dead at 4 am but never busy; a residential
 * hill barely notices.
 */
export const DISTRICT_RHYTHM = {
  default: { base: 0.34, swing: 0.66 },
  downtown: { base: 0.22, swing: 0.78 },
  point: { base: 0.26, swing: 0.62 },
  strip: { base: 0.30, swing: 0.70 },
  steelrow: { base: 0.14, swing: 0.80 },
  hazel: { base: 0.20, swing: 0.72 },
  mtwash: { base: 0.42, swing: 0.44 },
  troy: { base: 0.40, swing: 0.46 },
  westend: { base: 0.38, swing: 0.48 },
  northside: { base: 0.38, swing: 0.50 },
  lawren: { base: 0.34, swing: 0.62 },
  southside: { base: 0.32, swing: 0.68 },
  northsh: { base: 0.30, swing: 0.66 },
};

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Wrap to (-PI, PI]. */
export function wrapPi(a) {
  a %= Math.PI * 2;
  if (a > Math.PI) a -= Math.PI * 2;
  else if (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/** Deterministic 32-bit hash — used where a per-edge coin flip must be stable. */
export function hash32(x) {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Stable float in [0,1) from an integer. */
export function hashF(x) {
  return hash32(x) / 4294967296;
}
