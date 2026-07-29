/**
 * POLICE — every tunable number.
 *
 * Kept in one file so the controllers read as algorithm rather than as magic
 * constants, and so a designer can re-balance the whole wanted system without
 * touching a state machine. SI units throughout: metres, seconds, m/s, radians.
 */

/* ====================================================================== */
/* Wanted level                                                           */
/* ====================================================================== */

/**
 * Heat required to reach each star. Heat is a continuous quantity so that a
 * long string of small crimes escalates the way a single big one does, and so
 * the HUD can show a star part-filled.
 */
export const STAR_HEAT = [0, 10, 28, 52, 80, 112];

/** Above this the meter stops climbing — five stars is the ceiling. */
export const HEAT_MAX = 150;

/**
 * What each crime is worth, before severity. `severity` (default 1) scales it.
 * These are the numbers that decide whether clipping a pedestrian is a
 * one-star inconvenience or the start of an evening.
 */
export const CRIME_HEAT = {
  /* nuisance */
  speeding: 1.5,
  reckless: 2.2,
  hitCar: 2.0,
  trespass: 3.0,
  /* property */
  carjack: 9,
  vandal: 6,
  /* violence */
  brawl: 8,
  gunfire: 11,
  hitPed: 13,
  woundPed: 16,
  killPed: 26,
  /* against the badge — this is where it gets expensive */
  ramCop: 16,
  gunfireAtCop: 26,
  woundCop: 34,
  killCop: 58,
  destroyCruiser: 40,
  /* ordnance */
  explosion: 36,
  /* scripted */
  mission: 20,
};

/** A crime a police unit actually SAW is worth more and is instantly located. */
export const WITNESS_GAIN = 1.45;

/**
 * A crime nobody could have seen still generates heat, but far less — there is
 * nobody to call it in. Applied when no cop and no pedestrian is within
 * `witnessRange` of the crime.
 */
export const UNWITNESSED_GAIN = 0.55;

export const TUNE = {
  /* -------------------------------------------------------- detection -- */
  /** How far a cruiser can identify the quarry, per star (index = level). */
  sightRange: [70, 95, 115, 135, 160, 190],
  /** Half-angle of a cruiser's forward identification cone, radians. */
  sightHalfAngle: 1.15,
  /** Behind that cone a cop still sees you, but only this close (mirrors). */
  sightRear: 26,
  /** Line-of-sight raycasts per second, spread across the fleet. */
  losHz: 6,
  /** A helicopter sees down through a much wider cone from much further. */
  heliSight: 240,
  /** Anyone within this of a crime can phone it in. */
  witnessRange: 55,

  /* ------------------------------------------------------------ evade -- */
  /**
   * Seconds you must stay unseen AND outside the cordon to lose one star.
   * Index is the level you are losing. Deliberately super-linear: one star is
   * a corner and a side street, five is a serious escape.
   */
  evadeNeed: [0, 11, 15, 20, 26, 33],
  /** Inside the cordon but unseen, the evade timer bleeds back at this rate. */
  cordonBleed: 0.85,
  /** Cordon radius the moment contact is lost. */
  cordonR0: 55,
  /** How fast the search area grows once they have lost you, m/s. */
  cordonGrow: 8.5,
  /** Cap on the cordon radius, per star. */
  cordonMax: [0, 130, 175, 220, 275, 330],
  /** `wanted:heat` is republished at this rate while hunting. */
  heatHz: 2.2,
  /** Losing a star drops heat to this far below the star's threshold. */
  demoteMargin: 1.5,

  /* ------------------------------------------------------------ fleet -- */
  /**
   * Cruisers dispatched per star. This is the TOTAL, including the cars
   * standing on roadblocks — sizing it as "chasers, plus extras for blocks"
   * made the director and the block manager fight: the block spawned a car,
   * the director saw the fleet over target and stood a chaser down, the block
   * went stale, and the roles thrashed at 2.5 Hz. One number, one authority.
   */
  fleet: [0, 1, 2, 4, 6, 8],
  /** Of those, how many are heavy units (vans full of officers). */
  heavies: [0, 0, 0, 0, 1, 2],
  /** Helicopters. */
  helis: [0, 0, 0, 0, 1, 1],
  /** Roadblocks standing at once. */
  blocks: [0, 0, 0, 1, 1, 2],
  /** Fraction of `q.trafficBudget` police may occupy. */
  budgetShare: 0.3,
  /** Never more cruisers than this, whatever the budget says. */
  fleetCeil: 8,

  /* ----------------------------------------------------------- spawns -- */
  spawnMin: 90,
  spawnMax: 260,
  /** A spawn inside this cone of the camera forward is visible — reject it. */
  spawnViewCos: 0.55,
  /** ...unless it is at least this far away, where a pop-in is unreadable. */
  spawnViewFar: 230,
  /** Never spawn a cruiser closer than this to another one. */
  spawnClear: 22,
  /** ...nor inside ANY vehicle, including parked traffic. */
  spawnBodyClear: 9,
  /** Bias: prefer spawns AHEAD of the quarry's travel direction. */
  spawnAheadBonus: 0.55,
  /** Attempts per dispatch tick before giving up until the next one. */
  spawnTries: 14,
  /** Seconds between dispatch ticks. */
  dispatchPeriod: 1.1,
  /** Beyond this a unit is culled and re-dispatched somewhere useful. */
  cullRange: 420,
  /** ...but only if it is also out of the camera cone. */
  cullViewCos: 0.4,

  /* ------------------------------------------------------------ drive -- */
  /** Pure-pursuit lookahead L = clamp(L0 + kv*v, min, max). */
  lookL0: 6.0,
  lookKv: 0.72,
  lookMin: 5.0,
  lookMax: 30,
  crossTrackGain: 0.062,
  crossRateGain: 0.11,
  steerRate: 4.6,
  steerSmooth: 20,
  /** Lateral acceleration a police driver is willing to pull. Civilians: 3.3. */
  cornerLat: 6.4,
  cornerBrake: 4.6,
  cornerMin: 5.0,
  cornerHorizon: 120,
  /** Hard ceiling on commanded braking. */
  brakeMax: 9.5,
  throttleRef: 2.6,
  brakeRef: 5.2,
  brakeDeadband: -0.25,
  /** IDM-ish free acceleration. */
  accelA: 3.1,
  accelB: 3.4,
  /** Speed cap as a multiple of the road's design speed, per star. */
  speedGain: [1.0, 1.20, 1.32, 1.45, 1.58, 1.72],
  /** Absolute cap so a cruiser is never faster than the Precinct Cruiser is. */
  speedCap: 44,
  /** Handbrake-turn threshold: heading error, radians, and minimum speed. */
  spinYaw: 1.45,
  spinSpeed: 11,
  spinHold: 0.55,

  /* -------------------------------------------------------- avoidance -- */
  /** Cop-to-cop separation radius. Inside it they push apart laterally. */
  sepRadius: 13,
  sepGain: 1.35,
  /**
   * Forward corridor half-width used to spot a car we are about to rear-end.
   * Measured from the body sides, so the total is this plus both half-widths.
   * It was 1.6 and that was wrong: at a 3.6 m total tolerance every parked car
   * at the kerb registered as an obstacle dead ahead, and a cruiser would
   * emergency-brake to a permanent stop next to a legally parked sedan.
   */
  corridorHalf: 0.45,
  /** How far ahead we look for an obstacle, as seconds of travel. */
  corridorTime: 1.9,
  /** Gap at which we brake rather than swerve. */
  obstacleBrake: 7.0,
  /** Blocked for this long and the cruiser stops asking and starts shoving. */
  shoveAfter: 1.1,
  /** How long a shove lasts before we go back to driving politely. */
  shoveTime: 3.2,
  /** Speed a shove is delivered at. Enough to move a sedan, not to write off
   *  the cruiser. */
  shoveSpeed: 8.5,

  /* ------------------------------------------------------------ stuck -- */
  /** Below this speed, while asking for throttle, counts as stuck. */
  stuckSpeed: 1.1,
  stuckTime: 2.4,
  /** Seconds spent reversing out of it. */
  unstickTime: 1.3,
  /**
   * Total stuck time before the unit is written off and re-dispatched. Kept
   * short: the dispatcher will put a fresh, useful car on the road out of
   * sight within a second, which is strictly better than a cruiser grinding
   * its nose into a kerb for the rest of the chase.
   */
  stuckGiveUp: 8,
  /**
   * Unbroken seconds of NOT MOVING before a unit is written off, whatever it
   * believes it is doing and whoever is watching. `stuckGiveUp` above only
   * counts while the driver is asking for throttle and bleeds off during the
   * reverse, so a car wedged badly enough to cycle stuck -> reverse -> stuck
   * never reached it: measured 38 s of one cruiser motionless in the road.
   * A roadblock parked on purpose is exempt.
   */
  frozenGiveUp: 9,
  /**
   * After an unstick, seconds before a unit is allowed to abandon the road
   * network and drive straight at the quarry again. Direct mode is what makes a
   * pursuit look improvised, and it is also what parks a cruiser nose-first in
   * a wall: `_obstacles` scans vehicles, not buildings, so nothing sees the
   * wall coming and the car reverses 1.3 m and drives back into it for the rest
   * of the chase.
   */
  directCool: 6,

  /* ---------------------------------------------------------- tactics -- */
  /** Re-assign roles at this rate. */
  tacticsHz: 2.5,
  /** Seconds without a sighting before the fleet stops pursuing the last known
   *  position and starts sweeping the cordon. */
  searchAfter: 8,
  /** Bearings (radians, relative to the quarry's heading) for the chase slots.
   *  Slot 0 sits behind; the rest fan out so six cars are not one queue. */
  slotBearing: [Math.PI, 2.36, -2.36, 1.75, -1.75, 1.05, -1.05, 0.0],
  /** Stand-off distance for a slot, metres. */
  slotRange: 12,
  /** PIT is only attempted below this quarry speed... */
  pitSpeedMax: 30,
  /** ...and above this one (a PIT at walking pace is just a nudge). */
  pitSpeedMin: 7,
  /** Longitudinal window, relative to the quarry's rear axle, for a PIT. */
  pitAhead: [-1.2, 2.6],
  /** Lateral window. */
  pitLateral: 3.4,
  /** Stars at which PIT is permitted at all. */
  pitFromLevel: 2,
  /** Stars at which they simply ram. */
  ramFromLevel: 5,
  /** Distance at which a unit is merely RESPONDING rather than chasing, with
   *  hysteresis so the role does not flip every tactics tick. */
  respondIn: 150,
  respondOut: 105,
  /** How far ahead (seconds of quarry travel) an interceptor aims. */
  interceptLead: 7.5,
  /** An intercept is only worth trying if our ETA beats the quarry's by this. */
  interceptMargin: 1.5,
  /**
   * ...and how long a car will WAIT there once it arrives.
   *
   * An intercept is a bet on the quarry coming past. The bet has to expire, or
   * the car keeps it forever: the ETA test re-passes trivially once the unit is
   * standing on the junction (its own ETA is ~0), so a quarry that turned off
   * two streets back leaves a cruiser parked across a road with its lightbar
   * on for the rest of the chase. The harness measured exactly that as a
   * 24-second continuous stall by one unit. After this it rejoins the pursuit,
   * and `interceptCool` stops the next tactics tick from sending it straight
   * back to the same corner.
   */
  interceptHold: 8,
  interceptCool: 6,
  /** Units that may be doing something other than direct pursuit, per star. */
  flankShare: [0, 0, 0.34, 0.4, 0.45, 0.5],

  /* ------------------------------------------------------------- fire -- */
  /**
   * Officers shooting at the quarry. Tuned for a 100 HP player with
   * regen-to-half (src/player/tuning.js HEALTH) and real ballistics ranges,
   * playtested against two goals:
   *   - wanted 2, on foot, attentive: a cordon sweep is survivable (fire only
   *     opens when an arrest is off the table, accuracy is poor against a
   *     mover, and one officer's expected DPS ~1.5 is under the 9/s regen)
   *   - wanted 4-5, standing still in the open: lethal inside ~15 s (three
   *     established shooters land ~20-27 HP/s)
   */
  fire: {
    /** Stars at which officers open fire at all. Below this: arrest + contact
     *  only, which is what keeps one star an inconvenience. */
    fromLevel: 2,
    /** Metres. Deliberately long: officers hold a 5.5-8.5 m standoff ring, and
     *  a 13 m envelope would leave them mute while visibly aiming. Accuracy
     *  fades with distance (rangeFade). */
    range: 26,
    /** Fraction of accuracy lost at max range. */
    rangeFade: 0.45,
    /** Seconds between aimed shots, per star. Divided by the difficulty
     *  aggression multiplier. */
    period: [0, 2.6, 2.1, 1.55, 1.25, 1.05],
    /** HP per connecting round, per star, before difficulty. */
    damage: [0, 5, 7, 9, 11, 13],
    /** Hit probability at point blank against a stationary target, per star. */
    acc: [0, 0.35, 0.45, 0.58, 0.68, 0.76],
    /** Accuracy multiplier against a target moving faster than a walk. */
    movePenalty: 0.6,
    /** ...and against a vehicle above 8 m/s. */
    fastCarPenalty: 0.75,
    /**
     * How much of a round lands on the CAR instead of the man in it — and the
     * man takes none.
     *
     * 0.8 is a tuning share, in the same category as the deliberately long
     * `range` above it, and it is NOT what the block below is about. Moving it
     * wants a playtest, not a patch.
     */
    vehicleShare: 0.8,
    /**
     * ──────────────────────────────────────────────────────────────────────
     * ACTOR POINTS -> VEHICLE POINTS. THIS IS NOT A POLICE NUMBER.
     * ──────────────────────────────────────────────────────────────────────
     * `damage` above is in ACTOR points, and the proof is eight lines further
     * down the same method (`officer.js:274`): the very same array is handed to
     * `sys.copHit()` against the player's 100 HP body when the quarry is on
     * foot rather than in a car. So converting it for a
     * ~900-1250 HP body (`vehicles/specs.js` `body.hp`) is exactly the
     * question `vehicles` publishes ONE answer to — `ACTOR_TO_VEHICLE`,
     * readable at runtime as `vehicles.actorDamageScale`, which
     * `weapons/vehiclehit.js` already reads rather than keeping a copy.
     *
     * This used to be **3.5**, a private answer to that same question, on the
     * mistaken belief that a car is a 100 HP body — a car is 900-1250 HP and it
     * is the PLAYER who is 100. The number was hand-fitted, and it left police
     * rounds as the only actor-scale damage source in the game still opting
     * out of the central conversion — 3.5/10, so 35% of what an identical
     * number of actor points does to the same car through any other path.
     *
     * MEASURED through the real `Officer._combat` into a real `Vehicle`,
     * emitted health only, before -> after:
     *
     *   sedan (900 hp), rounds to wreck   w2 46 -> 17   w5 25 ->  9
     *   muscle (1250),  rounds to wreck   w2 64 -> 23   w5 35 -> 13
     *   one w5 round as a share of what the same 13 actor points do through
     *   `_explosionDamage` at the epicentre:            0.280 -> 0.800
     *
     * — and 0.800 is `vehicleShare`, which is what "the conversion is now the
     * engine's and only the share is ours" looks like from outside.
     *
     * The pressure that produces is a POLICE tuning question and it lives in
     * `damage` above, in actor points, next to the on-foot balance it was
     * playtested against. It does not live in a conversion factor — so if the
     * 9/11/13 ramp at the top three stars reads too hot, `damage` is the thing
     * to look at.
     *
     * FALLBACK, NOT A SOURCE OF TRUTH. `officer.js` should read
     * `sys.vehicles?.actorDamageScale` and fall back to this only when
     * `vehicles` has not booted (it already try/catches exactly that case).
     * Until it does, this is a mirror, and a mirror can drift: if
     * `ACTOR_TO_VEHICLE` moves and this does not, `node src/police/copfireprobe.mjs`
     * is what says so.
     */
    vehicleScale: 10,
    /** A crooked cop fights like this star level whatever the meter says. */
    crookedLevel: 3,
    /** No single round may take more than this fraction of max HP — the 45%
     *  single-impact cap philosophy (ARCHITECTURE quality bar). */
    hitCapFrac: 0.45,
    /** Seconds before re-testing a blocked line of sight. */
    losRetry: 0.45,
    muzzleHeight: 1.45,
    targetHeight: 1.15,
    tracerSpeed: 420,
    /** Lateral aim error, metres: a hit still grazes, a miss visibly cracks past. */
    hitSpread: 0.25,
    missSpread: 1.1,
  },

  /* -------------------------------------------------------------- ram -- */
  /**
   * The scripted cruiser ram: contact inside a bumper's gap, on a fixed
   * cadence, for damage scaled to ~1000 HP vehicles, plus sparks and camera
   * shake. The velocity cut is deliberately soft because the real collision
   * solver already transfers momentum on top of this.
   */
  ram: {
    /** Damage = (base + level*perStar) * difficulty. w1 54 .. w5 110 against
     *  a 1000 HP car ≈ 5-11% per ram. */
    base: 40,
    perStar: 14,
    /** Seconds between rams from one cruiser. Deliberately slack, because
     *  contact also does real collision damage. */
    period: 1.6,
    /** Bumper-to-bumper gap that counts as contact, metres. */
    gap: 0.9,
    /** The ram is DELIBERATE: the cruiser must be closing or rolling. A block
     *  car the quarry drives into does not scripted-ram — physics handles it. */
    minClosing: 0.8,
    minSpeed: 2.0,
    /** Victim velocity multiplier. The physical shove is real here, so a
     *  harder cut on top of it read as hitting a wall. */
    slow: 0.88,
    /** camera:shake amount. */
    shake: 0.25,
  },

  /* ------------------------------------------------------ foot spawns -- */
  /**
   * Independent pavement responders inside the search cordon. A response is a
   * foot cop 55% of the time at wanted 1-2 and 30% at 3+, rolled per dispatch
   * attempt against a per-star standing target, because the cruiser fleet is
   * sized separately.
   */
  foot: {
    chance: [0, 0.55, 0.55, 0.3, 0.3, 0.3],
    /** Standing foot responders wanted on the street, per star (bailout
     *  officers from cruisers are on top of this, all capped by the officer
     *  pool ceiling). */
    target: [0, 1, 2, 2, 3, 4],
    /** Seconds between foot-dispatch attempts (divided by aggression). */
    period: 2.4,
    minDist: 35,
    maxDist: 110,
    /** Inside the camera cone a foot spawn must be at least this far away. */
    viewFar: 130,
    tries: 10,
  },

  /* --------------------------------------------------------- officers -- */
  /** Officers bail out when the quarry has been stationary this long. */
  bailoutStill: 2.2,
  /** ...or when the quarry is on foot and this close. */
  bailoutRange: 34,
  /** How long an officer stands over you before you are BUSTED. */
  arrestTime: 2.6,
  /** Arrest reach. */
  arrestRange: 2.6,
  /** Busting is only possible at or below this star level. */
  arrestMaxLevel: 2,
  /** Cover offset from the car body when an officer takes the door. */
  coverOut: 1.35,

  /* -------------------------------------------------------- roadblock -- */
  /** How far ahead of the quarry a block is built. */
  blockLead: [0, 0, 0, 200, 260, 300],
  blockLeadMin: 110,
  /** Cars per block. */
  blockCars: [0, 0, 0, 2, 2, 2],
  /** Spike strip stand-off in front of the cars. */
  spikeAhead: 9,
  /** Seconds a spiked vehicle keeps losing speed. */
  spikeDrag: 11,
  /** Deceleration a shredded tyre adds, m/s^2. */
  spikeDecel: 2.1,
  /** Stars at which bridges are closed outright. */
  bridgeFromLevel: 5,
  /** A block is abandoned once the quarry is this far past it. */
  blockStale: 190,

  /* --------------------------------------------------------------- fx -- */
  /** Siren yield radius handed to `traffic.yieldFor`, per star. */
  yieldRadius: [0, 42, 50, 58, 66, 76],
  yieldHz: 3,
  /** How often the crowd is panicked around a cordon. */
  panicHz: 0.6,
};

/**
 * Difficulty scaling, keyed by `game.difficulty` ('easy'|'normal'|'hard'|
 * 'steel' — src/game/data.js DIFFS). Only the ID is published at runtime and
 * rule 2 forbids importing game's module, so the multipliers live here; they
 * track DIFFS' semantics (dmg follows dmgIn — damage INTO the player; aggr
 * follows enemy) but are police-specific tuning, not a copy.
 *
 *   dmg   scales officer round damage and cruiser ram damage
 *   aggr  divides fire periods and dispatch/foot-spawn cadence
 */
export const POLICE_DIFF = {
  easy: { dmg: 0.6, aggr: 0.8 },
  normal: { dmg: 1.0, aggr: 1.0 },
  hard: { dmg: 1.45, aggr: 1.2 },
  steel: { dmg: 2.0, aggr: 1.45 },
};

/** Police uniform, in the twelve-slot palette `peds` uses. Linear RGB. */
export const UNIFORM = [
  null,                        // 0 skin — keep the person's own
  null,                        // 1 hair — keep
  [0.028, 0.034, 0.052],       // 2 top: navy serge, almost black
  [0.055, 0.062, 0.080],       // 3 under: duty shirt
  [0.024, 0.028, 0.042],       // 4 bottom
  [0.016, 0.016, 0.018],       // 5 boots
  [0.150, 0.115, 0.022],       // 6 accent: badge / brass
  [0.022, 0.026, 0.040],       // 7 cap
  [0.040, 0.042, 0.046],       // 8 hard goods: radio, cuffs
  [0.012, 0.012, 0.013],       // 9 eyes, soles
  [0.44, 0.42, 0.40],          // 10 sclera
  [0.28, 0.30, 0.33],          // 11 reflective piping
];

/**
 * The crooked-cop variant: same cut, wrong colours. The `copwar` job needs them
 * readable as "cop, but not one of ours" at a glance, so the serge goes
 * aubergine and the brass goes violet. No badge shine: slot 6 is the tell.
 */
export const CROOKED_UNIFORM = [
  null,                        // 0 skin — keep
  null,                        // 1 hair — keep
  [0.052, 0.018, 0.078],       // 2 top: aubergine serge
  [0.075, 0.030, 0.095],       // 3 under: violet shirt
  [0.040, 0.016, 0.058],       // 4 bottom
  [0.016, 0.014, 0.020],       // 5 boots
  [0.180, 0.060, 0.240],       // 6 accent: violet, where the brass would be
  [0.046, 0.018, 0.070],       // 7 cap
  [0.048, 0.036, 0.058],       // 8 hard goods
  [0.012, 0.012, 0.013],       // 9 eyes, soles
  [0.44, 0.42, 0.40],          // 10 sclera
  [0.34, 0.22, 0.44],          // 11 piping, tinted
];

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
/** Shortest signed angle from a to b. */
export function angDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
