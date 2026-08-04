/**
 * Central tuning + quality configuration.
 * Subsystems read from here rather than hardcoding magic numbers, so the
 * quality scaler and the capture harness can drive everything from one place.
 */

export const PHYSICS_HZ = 120;
export const FIXED_DT = 1 / PHYSICS_HZ;
/** Never simulate more than this many physics steps in one frame (spiral-of-death guard). */
export const MAX_SUBSTEPS = 8;

/**
 * Ceiling on the fixed-step BACKLOG, in fixed steps.
 *
 * `MAX_SUBSTEPS` alone is not a spiral guard, it is a spiral *pump*. The raw
 * frame delta is clamped to 100 ms, which at 120 Hz asks for twelve steps, so
 * every frame after a stall requests the full eight — and MEASURED on this
 * build (tools, tier `low`), eight steps cost 119-132 ms, which is itself over
 * the clamp, so the next frame asks for eight again. One 100 ms hitch turned
 * into a run of 130 ms frames: 25 of 870 frames were pinned at the cap.
 *
 * Capping the accumulator instead means a hitch is simply not made up. The
 * simulation runs microscopically slow for one frame — which nobody can see —
 * rather than converting a single stall into a multi-frame freeze, which is
 * what the uncapped accumulator produced in play.
 *
 * Six steps holds real time down to 20 fps, below which the simulation
 * deliberately runs slow rather than freezing. The old code had the same
 * property at 15 fps (`steps === MAX_SUBSTEPS` already shed the backlog); what
 * it lacked was any bound on what those steps were allowed to COST, which is
 * `FIXED_STEP_BUDGET_MS` and is the guard that actually stops the spiral.
 */
export const MAX_CATCHUP_STEPS = 6;

/**
 * Wall-clock ceiling on one frame's fixed-step block, milliseconds.
 *
 * The backlog cap bounds how many steps are *requested*; this bounds what they
 * are allowed to cost when an individual step goes long (MEASURED max: 180 ms
 * for a single step, during a static-collision rebuild). Always allows one step
 * so the simulation cannot stop dead.
 */
export const FIXED_STEP_BUDGET_MS = 12;

/** Real-world units are metres, seconds, kilograms. */
export const UNITS = {
  gravity: -9.81 * 2.1, // Games use exaggerated gravity; CoD-like feel.
  playerHeight: 1.78,
  playerCrouchHeight: 1.12,
  playerRadius: 0.32,
  eyeOffset: 0.12, // below top of capsule
};

/**
 * Open-world budgets.
 *
 * `streamRadius`      metres of city kept resident around the camera
 * `tileBuildBudgetMs` per-frame ceiling for streamed geometry construction
 * `lightSlots`        FIXED number of punctual light slots. The visible count is
 *                     a shader permutation key, so this never varies at runtime
 *                     (see ARCHITECTURE.md). Street lamps are emissive+bloom, not
 *                     real lights; slots are for headlights / muzzle flash / the
 *                     nearest few practicals.
 * `drawDistance`      camera far plane, metres — the skyline has to be visible
 * `shadowDistance`    far edge of the last cascade
 * `trafficBudget`     CEILING on live moving cars near the camera. `traffic`
 *                     spends min(budget*movingShare, laneCapacity)*volume of it
 *                     (movingShare 0.72), so on a saturated grid the LANE, not
 *                     this number, is the wall — see LANE_M_PER_CAR in
 *                     traffic/population.js. Raising it adds cars where there is
 *                     spare road (the lower tiers, and open arterials/highways
 *                     at ultra); it cannot add them to a downtown already at
 *                     capacity. `props` also parks ~0.7*this many kerb cars.
 * `pedBudget`         CEILING on live ambient pedestrians near the camera. Most
 *                     are drawn by the one instanced far-crowd capsule mesh;
 *                     only ~budget*0.36 (capped at 38) ever get a skinned body,
 *                     so raising this fills the pavement cheaply. `police` caps
 *                     its officers at ~0.28*this.
 *
 * These two set STREET DENSITY, raised for "more NPCs and cars":
 *   pedBudget      8/26/44/110  ->  12/42/72/170   (+50 / +62 / +64 / +55 %)
 *   trafficBudget  5/12/28/64   ->   6/16/38/76    (+20 / +33 / +36 / +19 %)
 * Low stays lightest — it is the mobile floor.
 *
 * THE PEDS TAKE THE BULK OF THE INCREASE, ON PURPOSE. Sidewalks absorb bodies
 * without congestion, so more peds simply reads as a busier city. Cars are
 * raised more gently: an early pass pushed trafficBudget to 96 at ultra and
 * turned the downtown grid into a car PARK — a third to a half of the near
 * cars were sitting still at capacity, which reads as gridlock, not life. The
 * ceilings above sit under that: the Golden Triangle grid flows at ~38 moving
 * cars in the 175 m spawn disc; asking for more just queues them. Most of the
 * added traffic lands on the open roads that make up the rest of the map.
 *
 * `src/core/densprobe.mjs` (npm run dens) measures the EMITTED near-camera ped
 * count and the frame time downtown — never these constants. Its ped floor sits
 * ABOVE the old ped ceiling, so only a raised build can reach it (a
 * by-construction gate, not a lucky sample), and it holds the play-tier frame
 * budget. Downtown cars are capacity-bound, so their count is reported, not
 * gated; the car increase lands on the open roads.
 */
export const QUALITY_PRESETS = {
  // `low` is the PLAYABILITY FLOOR. The governor falls back to it when nothing
  // else holds frame rate, so it has to actually be smooth on modest hardware —
  // there is no tier below it to escape to. Everything here is sized to cut
  // SUBMISSION (draw calls, shadow casters, streamed tiles), because
  // tools/drawbreak.mjs showed the frame is submission-bound, not fill-bound:
  // at 62% resolution it was still issuing ~3.4k draws, ~750 of them shadow
  // casters across the cascades.
  low: {
    renderScale: 0.7,
    shadowMapSize: 1024,
    cascades: 2,
    shadowDistance: 70,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    anisotropy: 4,
    particleBudget: 1500,
    decalBudget: 48,
    drawDistance: 1000,
    streamRadius: 190,
    tileBuildBudgetMs: 3,
    lightSlots: 4,
    trafficBudget: 6,
    pedBudget: 12,
    lodBias: 2.4,
    grassDensity: 0.18,
  },
  // PLAY PRESETS. `medium` and `high` are tuned to be genuinely playable, not to
  // look good in a still. Play used to default to `ultra`, which is a benchmark
  // setting (6 km draw distance, 1 km stream radius, 24k particles) and is far
  // too slow to actually play on. The
  // expensive knobs in an open world are, in order: drawDistance, streamRadius,
  // shadowDistance and renderScale. Cut those hard and the frame comes back
  // without the street looking noticeably emptier.
  medium: {
    renderScale: 0.8,
    shadowMapSize: 1536,
    cascades: 3,
    shadowDistance: 130,
    taa: true,
    gtao: true,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    anisotropy: 8,
    particleBudget: 4000,
    decalBudget: 96,
    drawDistance: 1500,
    streamRadius: 300,
    tileBuildBudgetMs: 4,
    lightSlots: 6,
    trafficBudget: 16,
    pedBudget: 42,
    lodBias: 1.8,
    grassDensity: 0.4,
  },
  high: {
    renderScale: 0.92,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 190,
    taa: true,
    gtao: true,
    ssr: false,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 8000,
    decalBudget: 160,
    drawDistance: 2200,
    streamRadius: 440,
    tileBuildBudgetMs: 5,
    lightSlots: 8,
    trafficBudget: 38,
    pedBudget: 72,
    lodBias: 1.4,
    grassDensity: 0.6,
  },
  ultra: {
    renderScale: 1.0,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 430,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 24000,
    decalBudget: 512,
    drawDistance: 6000,
    streamRadius: 1000,
    tileBuildBudgetMs: 8,
    lightSlots: 8,
    trafficBudget: 76,
    pedBudget: 150,
    lodBias: 0.85,
    grassDensity: 1.0,
  },
};

export const DEFAULTS = {
  quality: 'ultra',
  fov: 80, // horizontal-ish vertical FOV, CoD default feel
  adsFovScale: 0.72,
  sensitivity: 0.0022,
  adsSensScale: 0.65,
  invertY: false,
  exposure: 1.0,
  /** Capture mode disables anything nondeterministic so screenshots are stable. */
  deterministic: false,
};

export function createConfig(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  cfg.q = { ...QUALITY_PRESETS[cfg.quality] };
  cfg.setQuality = (name) => {
    if (!QUALITY_PRESETS[name]) throw new Error(`unknown quality preset "${name}"`);
    cfg.quality = name;
    Object.assign(cfg.q, QUALITY_PRESETS[name]);
  };
  return cfg;
}
