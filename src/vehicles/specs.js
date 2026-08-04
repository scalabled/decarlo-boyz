/**
 * The eleven vehicle classes, reinterpreted in real units.
 *
 * Everything here is SI — kilograms, newton-metres, metres, radians — because
 * the dynamics model is a real raycast-vehicle with a Pacejka tyre, a torque
 * curve and a gearbox, and arcade constants (`top 47`, `grip 9.5`) cannot feed
 * it. What the table preserves is the RELATIVE ordering and character of the
 * classes:
 *
 *   bike    darty, fragile, fastest off the line, no roll stiffness to speak of
 *   sports  lowest CoM, stiffest springs, most grip, snap oversteer at the limit
 *   police  sports pace in a sedan body — the only thing that can stay with you
 *   muscle  long bonnet, rearward torque bias, lights the rears up in 2nd
 *   sedan   the traffic default, soft, understeers, unremarkable on purpose
 *   van     tall box, huge roll, lifts an inside wheel if you push it
 *   truck   2.6 t of mill flatbed. Takes a county to stop, exactly as specified.
 *   boat    no wheels at all — displacement hull, planes at speed
 *   bus     10 t of transit bus. The heaviest, slowest, tallest thing on the road.
 *   bicycle no engine, no tank: the RIDER is the engine. Slowest powered thing.
 *   heli    no wheels and no road at all — see `heli.js`
 *   tram    on RAILS, not roads: kinematic, timetable-driven — see `tram.js`
 *
 * `style` is consumed by body.js; every number in it is a real dimension on the
 * vehicle, so the silhouettes are distinguishable from 60 m in one glance.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW BUS, BICYCLE AND HELI WERE NUMBERED
 * ────────────────────────────────────────────────────────────────────────────
 * These three classes have no engine data that can simply be scaled up. An
 * arcade `top`/`acc`/`turn` triple is in legacy units per second on a 700 m
 * map, and DESIGN.md multiplies every legacy coordinate by four; taking
 * 20/8/1.2 at face value would give a bus that accelerates like a hatchback
 * and tops out at walking pace.
 *
 * So the rule used for all three, and the reason each number is what it is:
 *
 *   1. Take the REAL vehicle. A 30-foot transit bus, a city bicycle with a
 *      rider on it, a light piston helicopter. Use its real mass, its real
 *      engine, its real gearing.
 *   2. Check the resulting ORDERING. The bus must be the slowest and heaviest
 *      powered thing; the bicycle must be slower than every car; the
 *      helicopter must be quick but not the fastest. All three hold — see the
 *      table in the PACE section of `drivetest.mjs`.
 *   3. Where the real number and the FEEL disagree, the feel wins only on the
 *      controls, never on the mass. The helicopter climbs at 12 m/s where a
 *      real R44 climbs at 5; a 5 m/s ceiling climb would take 36 s and read as
 *      broken. Its WEIGHT is real.
 *
 * What the three produce, against the sedan:
 *
 *                  top speed     ratio to sedan
 *   bus             103 km/h          0.55
 *   bicycle          36 km/h          0.19
 *   heli            223 km/h          1.19
 *   (sedan)         187 km/h          1.00
 *
 * The spread is wider than an arcade table would give, and that is deliberate
 * and already true of this fleet: the truck sits at 0.59 of the sedan, because
 * a fleet built on real engines and real drag cannot also be flat. A governed
 * transit bus does 100 km/h and a cyclist does 36; those are the numbers, and
 * they preserve the ordering that actually matters to play.
 */

const RPM = Math.PI / 30; // rpm -> rad/s

/* ------------------------------------------------------------------ */
/* Paint                                                               */
/* ------------------------------------------------------------------ */

/**
 * Believable rustbelt car colours. Deliberately desaturated relative to Los
 * Santos: this is a wet grey city and a fluorescent green sedan would read as
 * a different game. `f` is the flake amount, `c` the clearcoat.
 */
export const PAINTS = {
  common: [
    { name: 'graphite', color: 0x2b2f33, f: 0.55, c: 1.0 },
    { name: 'oxide white', color: 0xc8c6c0, f: 0.18, c: 1.0 },
    { name: 'gunmetal', color: 0x4a4f55, f: 0.7, c: 1.0 },
    { name: 'midnight', color: 0x15181d, f: 0.45, c: 1.0 },
    { name: 'steel blue', color: 0x2e4356, f: 0.62, c: 1.0 },
    { name: 'ore red', color: 0x6d1f1c, f: 0.5, c: 1.0 },
    { name: 'moss', color: 0x3a4436, f: 0.4, c: 1.0 },
    { name: 'sand', color: 0x9c8f74, f: 0.3, c: 1.0 },
    { name: 'river teal', color: 0x1e5a58, f: 0.55, c: 1.0 },
    { name: 'burgundy', color: 0x3d1620, f: 0.5, c: 1.0 },
  ],
  loud: [
    { name: 'slag orange', color: 0xc4460d, f: 0.62, c: 1.0 },
    { name: 'sodium', color: 0xd9962a, f: 0.5, c: 1.0 },
    { name: 'acid teal', color: 0x0f8f88, f: 0.6, c: 1.0 },
    { name: 'violet', color: 0x5b2f8f, f: 0.68, c: 1.0 },
    { name: 'signal yellow', color: 0xd8b21a, f: 0.35, c: 1.0 },
  ],
  work: [
    { name: 'fleet white', color: 0xb9b6ae, f: 0.05, c: 0.35 },
    { name: 'mill grey', color: 0x585c5e, f: 0.06, c: 0.3 },
    { name: 'foundry blue', color: 0x24506e, f: 0.1, c: 0.4 },
    { name: 'primer', color: 0x6b6660, f: 0.02, c: 0.12 },
    { name: 'rust brown', color: 0x6b4426, f: 0.02, c: 0.1 },
  ],
  police: [{ name: 'precinct', color: 0x0b0d10, f: 0.3, c: 1.0 }],
  /**
   * AIRCRAFT POOLS — one per variant, so the four flyables read differently at
   * a glance. The base Riverhop and Skylark keep the fleet's `work`/`common`
   * greys; the news machine is broadcast livery and the sport plane is club
   * racing colours. Nothing here repeats a colour from `work` or `common` —
   * `flightprobe` asserts the pools are disjoint from each sibling's, so a
   * respray that collapses the distinction goes red.
   */
  newscopter: [
    { name: 'broadcast white', color: 0xdad8d0, f: 0.14, c: 1.0 },
    { name: 'channel blue', color: 0x1c4f9c, f: 0.5, c: 1.0 },
    { name: 'action yellow', color: 0xd2a41d, f: 0.42, c: 1.0 },
  ],
  sportair: [
    { name: 'racing red', color: 0xa5231d, f: 0.55, c: 1.0 },
    { name: 'club cream', color: 0xd8d2bd, f: 0.18, c: 1.0 },
    { name: 'pylon orange', color: 0xc4561a, f: 0.5, c: 1.0 },
  ],
  /**
   * HERO POOLS — the three brothers' own cars, each a single believable
   * catalogue colour so the personal car reads the same every time you get in
   * it. They are hero-only classes (`kessel`, `pickup`, `suv` never appear in
   * `DISTRICT_MIX`), so a single-entry pool is not a loss of variety — it is the
   * point: Dylan's K5 is grey, Aidan's Ranger is red, Carson's 4Runner is white.
   * Tone jitter still nudges the lightness a shade and the 1-in-6 beater roll can
   * still respray one matte, but the HUE never leaves grey / red / white.
   */
  k5grey: [{ name: 'k5 grey', color: 0x767c84, f: 0.55, c: 1.0 }],
  rangerred: [{ name: 'ranger red', color: 0xa72c22, f: 0.42, c: 1.0 }],
  runnerwhite: [{ name: 'runner white', color: 0xdedcd6, f: 0.12, c: 1.0 }],
};

/* ------------------------------------------------------------------ */
/* Shared sub-specs                                                    */
/* ------------------------------------------------------------------ */

/** Dry asphalt tyre. Per-class overrides scale mu and the stiffness. */
const TYRE_ROAD = {
  muLong: 1.62,
  muLat: 1.5,
  // Magic-formula shape. B = stiffness, C = shape, E = curvature.
  Bx: 11.0, Cx: 1.62, Ex: 0.42,
  By: 9.0, Cy: 1.38, Ey: -1.2,
  /** Fraction of mu lost per unit of (Fz/Fz0 - 1). Real tyres: 0.08-0.16. */
  loadSens: 0.13,
  /** Nominal vertical load the mu is quoted at, as a fraction of static load. */
  loadRef: 1.0,
  /** Relaxation length, m — how far the car rolls before lateral force builds. */
  relax: 0.42,
  /** Grip lost when the tyre is hot/spinning (0 = none). */
  fade: 0.16,
  rollRes: 0.014,
};

const TYRE_TRUCK = {
  ...TYRE_ROAD,
  muLong: 1.16, muLat: 1.10,
  Bx: 8.0, Cx: 1.55, Ex: 0.5,
  By: 6.6, Cy: 1.32, Ey: -1.4,
  loadSens: 0.09, relax: 0.62, rollRes: 0.02,
};

const TYRE_BIKE = {
  ...TYRE_ROAD,
  muLong: 1.50, muLat: 1.40,
  Bx: 13.0, Cx: 1.68, Ex: 0.35,
  By: 12.0, Cy: 1.44, Ey: -0.9,
  loadSens: 0.17, relax: 0.24, fade: 0.24, rollRes: 0.012,
};

/**
 * Grip multipliers by `world.surfaceAt()` tag. These are the numbers that make
 * dropping a wheel onto the verge at 120 km/h a real event.
 * `roll` is extra rolling resistance, `drag` is a bulk velocity drag (sand/water),
 * `noise` is the amplitude of the surface bump field under the wheel.
 */
export const SURFACE_GRIP = {
  asphalt: { mu: 1.0, roll: 1.0, drag: 0.0, noise: 0.006, skid: 1.0, dust: 0 },
  concrete: { mu: 0.97, roll: 1.05, drag: 0.0, noise: 0.008, skid: 0.9, dust: 0 },
  sidewalk: { mu: 0.93, roll: 1.1, drag: 0.0, noise: 0.012, skid: 0.7, dust: 0.1 },
  road: { mu: 1.0, roll: 1.0, drag: 0.0, noise: 0.006, skid: 1.0, dust: 0 },
  metal: { mu: 0.82, roll: 0.95, drag: 0.0, noise: 0.004, skid: 0.5, dust: 0 },
  wood: { mu: 0.88, roll: 1.1, drag: 0.0, noise: 0.014, skid: 0.4, dust: 0.1 },
  gravel: { mu: 0.62, roll: 2.3, drag: 0.02, noise: 0.045, skid: 0.35, dust: 1.0 },
  dirt: { mu: 0.66, roll: 2.0, drag: 0.015, noise: 0.055, skid: 0.3, dust: 1.0 },
  grass: { mu: 0.58, roll: 2.6, drag: 0.02, noise: 0.04, skid: 0.2, dust: 0.6 },
  foliage: { mu: 0.55, roll: 3.0, drag: 0.03, noise: 0.05, skid: 0.2, dust: 0.5 },
  sand: { mu: 0.5, roll: 4.2, drag: 0.05, noise: 0.05, skid: 0.15, dust: 1.2 },
  mud: { mu: 0.45, roll: 3.6, drag: 0.05, noise: 0.05, skid: 0.15, dust: 0.9 },
  water: { mu: 0.22, roll: 3.0, drag: 0.12, noise: 0.02, skid: 0.1, dust: 0 },
  ice: { mu: 0.16, roll: 0.9, drag: 0.0, noise: 0.002, skid: 0.1, dust: 0 },
  rubber: { mu: 1.1, roll: 1.2, drag: 0, noise: 0.01, skid: 0.8, dust: 0 },
  glass: { mu: 0.6, roll: 0.9, drag: 0, noise: 0.002, skid: 0.3, dust: 0 },
  plaster: { mu: 0.85, roll: 1.2, drag: 0, noise: 0.02, skid: 0.4, dust: 0.4 },
  fabric: { mu: 0.7, roll: 1.6, drag: 0, noise: 0.02, skid: 0.2, dust: 0.2 },
  flesh: { mu: 0.8, roll: 1.4, drag: 0, noise: 0.02, skid: 0.2, dust: 0 },
};

export const DEFAULT_GRIP = SURFACE_GRIP.asphalt;

/** Wet asphalt costs ~30% of mu; standing water more. Driven by weather. */
export function wetGrip(mu, wetness) {
  return mu * (1 - 0.3 * Math.min(1, Math.max(0, wetness)));
}

/**
 * How much of the wetness a surface actually feels, 0..1.
 *
 * Rain does not do the same thing to every surface. A sealed road is the whole
 * story — the film of water and rubber dust on top of it is what takes a third
 * of the grip away — while gravel and sand drain and pack down and barely
 * change, and ice and standing water are already at the bottom of the table and
 * have nothing left to lose. Painted lines and metal covers are the slippery
 * ones, which is why they are above 1.
 */
export const WET_SENS = {
  asphalt: 1.0, road: 1.0, concrete: 1.0, sidewalk: 0.9,
  metal: 1.35, glass: 1.2, plaster: 0.9, wood: 1.15,
  dirt: 0.85, mud: 0.4, grass: 0.7, foliage: 0.7,
  gravel: 0.35, sand: 0.25,
  water: 0, ice: 0,
  rubber: 0.6, fabric: 0.5, flesh: 0.4,
};

/* ------------------------------------------------------------------ */
/* The eight classes                                                   */
/* ------------------------------------------------------------------ */

/**
 * ────────────────────────────────────────────────────────────────────────────
 * TOP GEAR — why "the cars drive too slow" was a GEARING defect, not a power
 * one, and how to tell the difference before touching a number.
 * ────────────────────────────────────────────────────────────────────────────
 * READ THE ENGINE TORQUE NOTE BELOW THIS ONE TOO. This block answered the
 * question "what is the TOP SPEED limiter", answered it correctly, and did not
 * cure the complaint that the cars drive slow — because on a 3 km map a top
 * speed is a number almost never seen. The complaint recurred unchanged.
 *
 * When the cars read as slow, the chain has four candidates — engine torque,
 * shift points, final drive and top gear — and exactly one measurement
 * separates them: WHAT IS THE ENGINE DOING AT TOP SPEED. A car that is out of
 * power or beaten by drag tops out well below its redline; a car that is
 * under-geared tops out ON THE LIMITER with power still in hand.
 *
 * Measured on flat dry asphalt (`bench.mjs`, and the sweep is reproducible with
 * `topSpeed` in `drivetest.mjs`), every fast class was on the limiter:
 *
 *            top km/h   rpm at top   % of redline
 *   sports      231        7363          99%
 *   muscle      202        5856          99%
 *   sedan     163.5        6258          99%
 *   police    209.4        6569          99%
 *   van       131.1        4036          92%   <- drag-limited already
 *   truck     110.4        2566          88%   <- drag-limited already
 *   bike      229.1       12439          96%   <- effectively drag-limited
 *
 * So the engines and the shift points were never the constraint. Only the four
 * limiter-bound classes get a taller top gear, and ONLY the top gear: every
 * lower ratio is untouched, so acceleration is provably unaffected — 0-60 and
 * 0-100 km/h are identical before and after, to the hundredth, for every class.
 *
 *            before -> after   0-60 km/h    0-100 km/h
 *   sports    231 -> 263.7     2.97 (=)     5.15 (=)
 *   muscle    202 -> 231.6     2.99 (=)     5.43 (=)
 *   sedan   163.5 -> 187.4     5.62 (=)    10.83 (=)
 *   police  209.4 -> 239.9     3.52 (=)     6.23 (=)
 *
 * RATCHET, and this is a deliberate half-measure rather than the end of it:
 * a top gear of x0.80 rather than the x0.87 taken here reaches 270 / 241 / 196 /
 * 261 km/h and finally puts the top speed on DRAG instead of the limiter, which
 * is where a correctly geared car sits. It was not taken because Steel City is
 * about 3 km across and `ARCHITECTURE.md`'s own reference is "kilometres of
 * connected road at 180 km/h" — a 270 km/h car crosses the map in 40 seconds
 * and would be undriveable on it. The headroom is recorded here so the next
 * person knows the bar is higher than the number, and can raise it deliberately
 * rather than rediscover it.
 *
 * NOT changed, and both deliberately: `gb.reverseMax` still governs reverse,
 * and the idle torque an unattended automatic makes in first is what holds
 * parked cars on Pittsburgh's hills.
 */

/**
 * ────────────────────────────────────────────────────────────────────────────
 * ENGINE TORQUE — the second pass at "the cars could drive a little faster",
 * and why the top-gear answer above could never have landed.
 * ────────────────────────────────────────────────────────────────────────────
 * The block above took the sedan from 163.5 to 187.4 km/h and the sports car
 * from 231 to 263.7, and the cars still read as slow. It did not land because
 * it changed ONLY the top gear, which by construction cannot alter a launch,
 * and because Steel City is 3 km across: the sedan needed 12.1 seconds to
 * cover the first 200 m of a straight, and 200 m is about as far as a car gets
 * before the next junction resets it to zero. **The felt speed of a city is
 * metres per second FROM REST, not the number on a long straight.**
 *
 * Four candidates, and this time the one that separates them is not a top-speed
 * measurement but a TRACTION UTILISATION one: during a standing-start run,
 * what fraction of what the driven tyres could take is the drivetrain actually
 * asking for? A car at 0.9 is limited by rubber and more engine is wasted; a
 * car at 0.3 is limited by its engine and has half its grip lying idle.
 *
 *   drive force / driven-tyre capacity, by speed band, BEFORE:
 *              0-25   25-50  50-100  100+     peak accel, m/s^2
 *     sedan    0.76   0.84   0.53    0.25     4.0
 *     van      0.51   0.39   0.25    0.15     3.6
 *     truck    0.66   0.41   0.22    0.11     3.7
 *     muscle   0.72   0.89   0.72    0.27     7.1
 *     sports   0.69   0.82   0.67    0.21     7.1
 *     police   0.60   0.74   0.60    0.23     6.1
 *     bike     0.71   0.96   0.90    0.55     8.7
 *     bus      0.35   0.21   0.10    -        1.5
 *
 * So the limiting link is ENGINE TORQUE in the 25-120 km/h band, and it is
 * worst on exactly the classes a player spends his time in. The other three
 * candidates were each ruled out by a measurement, not by argument:
 *
 *   SHIFT POINTS  `shiftUp` swept from 0.80 to 0.97 on every class. It moves
 *                 0-50 km/h by at most 0.4 s on the sedan and the van and makes
 *                 the truck WORSE (5.91 -> 6.51 at 0.92), because the ratio step
 *                 costs more than the torque curve gives back. The gearbox was
 *                 never short-shifting off the peak: `torqueFactor` stays inside
 *                 0.93-1.00 across every gear on every class.
 *   GRIP          `muLong` x1.4 makes every CAR slower, not faster (sedan 0-50
 *                 4.66 -> 5.03). Only the bike improves. Nothing on four wheels
 *                 was traction-limited.
 *   DRAG          `cd` halved moves 0-50 by 0.01 s. It is a top-speed term and
 *                 nothing else.
 *
 * ── THE SIZING RULE, and it is the mirror of the TOP GEAR rule above ──
 *
 * That block changed the TOP gear only, so acceleration provably could not
 * move. This one raises `peakTorque`, and where first gear was already at or
 * over the tyres' limit it LENGTHENS FIRST GEAR BY THE SAME FACTOR — so the
 * product `peakTorque * gears[first]`, which is the number that decides a hill
 * start, a launch on gravel and a three-point turn, is held where it was, and
 * the whole gain lands in second and above. Top gear is untouched, so top speed
 * and the per-hero trim are untouched by construction.
 *
 * First gear was compensated on exactly two classes, and both for a reason
 * measured on a slope rather than guessed:
 *
 *   sedan   front-drive with 45% of its mass on the driven axle, and nose-up
 *           acceleration takes more off. On a 20 degree (36%) asphalt street —
 *           Pittsburgh has real ones — its first gear asks for 10.6 kN against
 *           7.9 kN of front grip even at the OLD torque, so it is held there
 *           entirely by `_hookUp`, and that controller is bistable at this
 *           operating point. Measured `peakTorque * gears[2]` against the
 *           20-degree hill start: 976 -> 3.77 m/s, 990 -> 3.95, 1012 -> 1.84,
 *           1023 -> 0.84 STUCK. The SHIPPED value was 1011.75 — i.e. the sedan
 *           was already sitting on the cliff edge and nobody knew. 355 N.m
 *           against a first of 2.80 puts the product at 994, which is on the
 *           safe side with margin, and the hill start more than DOUBLES:
 *           1.84 -> 4.02 m/s. Raising torque without this fails the gate.
 *   truck   5.4 t, and its first gear was already spinning its rears (slip 0.57,
 *           traction cut 0.27 below 25 km/h). Uncompensated it took the bench's
 *           three-point turn from 7 legs to 8, which is the cap. 1810 against a
 *           first of 5.77 holds the product at 10 444 vs 10 440.
 *
 * The van, muscle, sports and police were all well inside their tyres in first
 * (0.51-0.72) and keep their gearboxes as authored.
 *
 *          peakTorque   gears[first]     0-50 km/h      0-100 km/h    m in 5 s
 *   sedan   285 -> 355   3.55 -> 2.80   4.66 -> 4.06  10.83 -> 9.10  36.3 -> 38.8
 *   van     390 -> 490   4.10  (=)      5.62 -> 4.51  17.09 -> 13.05 34.7 -> 42.0
 *   truck  1450 -> 1810  7.20 -> 5.77   5.91 -> 5.13  20.87 -> 16.19 35.3 -> 38.6
 *   muscle  720 -> 835   3.00  (=)      2.59 -> 2.20   5.43 -> 4.63  64.9 -> 76.1
 *   sports  470 -> 545   3.60  (=)      2.58 -> 2.18   5.15 -> 4.38  66.3 -> 78.0
 *   police  540 -> 625   3.30  (=)      3.06 -> 2.60   6.23 -> 5.31  54.6 -> 64.8
 *
 *          top km/h        20 deg hill start, m/s   200 m from rest, s
 *   sedan   187.4 -> 187.4   1.84 -> 4.02            12.10 -> 11.43
 *   van     131.1 -> 137.0   6.85 -> 8.03            13.47 -> 12.23
 *   truck   110.4 -> 113.1   5.24 -> 7.46            13.92 -> 13.08
 *   muscle  231.6 -> 231.3  17.47 -> 14.14            9.08 ->  8.48
 *   sports  263.7 -> 264.6  18.91 -> 19.41            8.92 ->  8.29
 *   police  239.9 -> 240.3  12.46 -> 17.95            9.70 ->  9.03
 *
 * Braking distance and peak deceleration are IDENTICAL to the digit for every
 * class, and every three-point turn completes in the same number of legs. The
 * corridor those turns need widens by 0.3-0.8 m on the three classes that got
 * quicker, and that is the change showing up rather than a defect: `bench`
 * holds the manoeuvre at a crawl with a bang-bang throttle, and a car that
 * pulls harder overshoots the crawl further, where `steer.speedFalloff` has
 * wound some lock out.
 *
 * The Kessel GT is not in the table because it was authored after this pass and
 * therefore has no "before": it is the first class designed against the new bar
 * rather than lifted onto it, and its own note explains why a front-drive car
 * with 60% of its mass on the driven axle is the one class in the fleet that
 * can take a big first-gear number without spinning.
 *
 * NOT changed, all three deliberately:
 *   bus       authored as the slowest thing on the road and correct at 94.7
 *             km/h. It is also the only class whose gearbox already carries the
 *             compensation for the missing torque converter (first is 4.90, not
 *             the real Allison's 3.51 — see its own note), so a torque lift here
 *             would be counted twice.
 *   bike      the ONLY class already using its tyres: 0.96 utilisation at
 *             25-50 km/h and the traction controller saturated below 25. More
 *             torque is spin, and measurement agrees — x1.16 makes its 0-100
 *             WORSE, 4.11 -> 4.89 s.
 *   bicycle   118 N.m and 360 W are a real rider's real numbers and the whole
 *             curve is derived from them. There is nothing here to raise.
 *
 * RATCHET on the six numbers above. They record where this pass got to, not
 * where the bar is. Two things are known to be left on the table and neither is
 * a spec value: the engine is pinned AT IDLE for the whole slipping-clutch
 * phase (`Tc === Te` makes `Te - Tc` zero, so the crank cannot flare) — a real
 * automatic's converter would both rev it and multiply by ~1.9 — and `_hookUp`
 * winds ON up to 3.4x faster than it can let GO, because `err` is unbounded
 * above and bounded below by `_tcTarget`, which is the opposite of the
 * asymmetry its own comment asks for and is what makes the sedan's hill start
 * bistable. Fix either and these six numbers can come down. LOWER a RATCHET
 * when you improve it; never raise one to make a run go green.
 */

export const VEHICLE_SPECS = {
  /* ------------------------------------------------------ sports ---- */
  sports: {
    id: 'sports',
    name: 'Peregrine GT',
    kind: 'car',
    seats: 2,
    doors: 2,
    dims: { L: 4.6, W: 2.0, H: 1.15 },
    mass: 1360,
    /** Height of the CoM above the wheel-contact plane. Everything rolls on it. */
    comY: 0.40,
    /** Longitudinal CoM position, 0 = front axle, 1 = rear axle. */
    comZ: 0.46,
    wheelbase: 2.66,
    trackF: 1.63,
    trackR: 1.65,
    wheel: { radius: 0.345, width: 0.28, rimFrac: 0.72, spokes: 5, style: 'split' },
    drive: 'rwd',
    susp: {
      travel: 0.16, rideHeight: 0.12,
      freqF: 2.1, freqR: 2.25, // Hz — sports car springs
      dampF: 0.44, dampR: 0.42, // ratio of critical, bump
      reboundScale: 1.35,
      arbF: 26000, arbR: 20000, // Nm/rad equivalent, applied as a force couple
      camberF: -0.026, camberR: -0.018, // radians of static camber
      toeF: 0.001, toeR: 0.004,
    },
    tyre: { ...TYRE_ROAD, muLong: 1.52, muLat: 1.43, relax: 0.34 },
    engine: {
      // 545 N.m, not 470 — see the ENGINE TORQUE note above the class table.
      peakTorque: 545, peakRpm: 5100, redline: 7400, idle: 900,
      inertia: 0.34, friction: 0.055, brakeTorque: 44,
    },
    gearbox: {
      // Top gear is an OVERDRIVE, not another close ratio. See TOP GEAR above.
      gears: [-3.6, 0, 3.60, 2.50, 1.85, 1.45, 1.008],
      final: 3.55, eff: 0.93,
      shiftUp: 0.955, shiftDown: 0.5, shiftTime: 0.13,
      autoClutchRpm: 1500,
    },
    diff: { lock: 0.55, preload: 60 },
    brakes: { front: 3400, rear: 1900, handbrake: 3000, bias: 0.66 },
    steer: { max: 0.62, speedFalloff: 0.55, rate: 5.2, returnRate: 6.5, counterAssist: 0.5 },
    aero: { cd: 0.38, area: 1.95, downF: 0.72, downR: 0.95, yawDrag: 3.2 },
    body: { hp: 1000, crumple: 1.0 },
    paints: ['common', 'loud'],
    style: {
      shape: 'wedge',
      groundY: 0.115,
      roofY: 1.15,
      beltY: 0.79,
      sillY: 0.30,
      shoulderY: 0.71,
      hwMax: 0.98,
      /**
       * A SHORT, DROPPED NOSE. This car used to carry 0.87 m of body ahead of
       * the front axle with only 0.20 m of fall across 1.6 m of bonnet, and it
       * read exactly as the critics described it: long and flat, a plank with a
       * bumper stuck on the end. Pulling the tip back to 2.00 moves the
       * overhang split rearward (`finalizeStyle` divides `L - wheelbase`
       * between the two ends in the authored ratio) and dropping the tip 9 cm
       * with a stronger bonnet crown gives the wedge somewhere to go.
       */
      noseY: 0.645, noseHw: 0.92, noseZ: 2.00,
      tailY: 0.86, tailHw: 0.94, tailZ: -2.32,
      cowlZ: 0.58, cowlY: 0.90,
      windscreenTopZ: -0.12, roofRearZ: -0.86,
      backlightBaseZ: -1.42,
      greenhouseInset: 0.135, greenhouseTaper: 0.20,
      pillarA: 0.075, pillarB: 0.0, pillarC: 0.115,
      /**
       * The arch cut is a circle in (z, y) and it removes EVERYTHING below it
       * on the flank columns — so an arch whose crown reaches the top of the
       * wing punches a hole through the wing, which is what dropping the nose
       * exposed: two black wedges over the front wheels. 0.42 keeps 7.5 cm of
       * gap over a 0.345 m tyre and 5 cm of metal above it.
       */
      archF: { z: 1.33, r: 0.40, flare: 0.052 },
      archR: { z: -1.33, r: 0.45, flare: 0.075 },
      crownDeck: 0.055, crownRoof: 0.075, crownBonnet: 0.055,
      creaseY: 0.585, creaseDepth: 0.016,
      bumperDrop: 0.11, splitter: 0.03, diffuser: 0.07,
      bumperF: 0.20, bumperR: 0.20,
      grille: { w: 0.86, hf: 0.20, yf: 0.46, kind: 'slot' },
      headlight: { w: 0.44, h: 0.12, yf: 0.68, inset: 0.32, kind: 'slim' },
      taillight: { w: 0.42, h: 0.11, yf: 0.66, inset: 0.28, kind: 'bar' },
      exhaust: { n: 2, r: 0.045, x: 0.36, y: 0.24 },
      mirror: { z: 0.30, y: 0.80, x: 0.99, size: 0.115 },
      spoiler: 'ducktail',
      roofScoop: false,
      doorSplit: [0.55, -0.62],
    },
  },

  /* ------------------------------------------------------ kessel ---- */
  /**
   * ──────────────────────────────────────────────────────────────────────
   * KESSEL GT — DYLAN'S CAR. A FASTBACK, and that word is the whole spec.
   * ──────────────────────────────────────────────────────────────────────
   * Asked for by the player by name. Everything below is a fastback sedan
   * rather than a three-box saloon, and the difference is not decoration —
   * build it with the Allegheny's greenhouse and a boot and it reads as a
   * slightly lower Allegheny, which is the one outcome that fails.
   *
   * The single line that IS the car: the roof peaks a long way back
   * (`roofRearZ` -1.28 against the Allegheny's -1.05) and then falls in one
   * unbroken sweep to a very short, very high deck. Measured off the two
   * style blocks, that is the whole difference:
   *
   *                          Allegheny 4dr     Kessel GT
   *     backlight run          0.47 m           0.74 m   <- the sweep
   *     deck behind it         0.90 m           0.44 m   <- the stub boot
   *     deck height            0.94 m           1.02 m   <- ducktail, not a lid
   *     bonnet (nose to cowl)  1.64 m           1.84 m   <- cab pushed back
   *
   * `pillarC` is 0.145 against the Allegheny's 0.115 because a fastback's
   * C-pillar is structure, not a post, and it is where the bright window
   * surround kicks up.
   *
   * Front: a wide, low grille — `grille.w` 1.05 is the widest in the fleet
   * and sits at `yf` 0.46, below the lamp line, which is what makes a nose
   * read as one aperture rather than a mouth under two eyes. `headlight.kind`
   * is 'slim' with the DRL strip the shared builder hangs off its lower edge.
   *
   * Rear: `taillight.kind` is 'fullbar' — a new kind, and the only one in the
   * fleet that crosses the whole tail instead of sitting in two pods. See
   * `body.js` for the stepped break that keeps it from reading as a van's
   * light bar.
   *
   * GT cues: gloss-black brightwork rather than chrome (the `loud` paint pool
   * and the dark trim the fascia already uses), four exhaust outlets, 19-inch
   * multi-spoke alloys, and `wheel.caliper` — the first painted caliper in the
   * game. `paint.js` has always had the material and nothing ever passed it a
   * colour; see `build.js` for the LOD0-only split that makes it visible.
   *
   * DRIVING CHARACTER, and it must not be a smaller Peregrine. It is
   * FRONT-drive, and it is the only class in the fleet with its mass over the
   * driven axle: `comZ` 0.60 against the Allegheny's 0.45 and the Peregrine's
   * 0.46, which is what a transverse 2.5 turbo four actually does to a car.
   * The consequences are all the right ones — it hooks up off the line where
   * the Allegheny spins, it dives harder under brakes, and the front anti-roll
   * bar is nearly twice the rear so it washes wide at the limit instead of
   * rotating. `dims.W` is 1.96 rather than the real car's 1.86 because this
   * fleet's quoted widths run 8-11% over real (the Allegheny is 2.05 for a
   * real 1.84), and a correct-to-the-brochure number here would have read as
   * a narrow car parked next to its own siblings.
   */
  kessel: {
    id: 'kessel',
    name: 'Kessel GT',
    kind: 'car',
    seats: 4,
    doors: 4,
    dims: { L: 4.90, W: 1.96, H: 1.44 },
    mass: 1600,
    comY: 0.50,
    /**
     * 60% ON THE FRONT AXLE, and it is the only class in the game above 0.55.
     * `loadF = mass * g * comZ`, so this is the fraction the front carries —
     * a transverse engine and a gearbox both ahead of the front axle line.
     * It is also the entire reason this car can use the torque below: the
     * Allegheny is front-drive with 45% on its driven wheels and is traction
     * bound in first everywhere, including on a Pittsburgh hill.
     */
    comZ: 0.60,
    wheelbase: 2.85,
    trackF: 1.56, trackR: 1.58,
    /** 245/40 R19 on a multi-spoke, and the calipers are the giveaway. */
    wheel: {
      radius: 0.345, width: 0.245, rimFrac: 0.71, spokes: 10, style: 'split',
      /**
       * Dylan's accent (`#5fd0ff`, a cold cyan). See `build.js` — LOD0 only, and
       * nothing else pays for it. The K5 is Dylan's car and the caliper is where
       * his trim colour lands: grey car, cyan calipers behind black alloys.
       */
      caliper: 0x5fd0ff,
    },
    drive: 'fwd',
    susp: {
      travel: 0.16, rideHeight: 0.13,
      freqF: 1.85, freqR: 1.95,
      dampF: 0.40, dampR: 0.39,
      reboundScale: 1.38,
      // Front bar nearly double the rear: understeer at the limit, on purpose.
      arbF: 20000, arbR: 11000,
      camberF: -0.020, camberR: -0.016,
      toeF: 0.001, toeR: 0.004,
    },
    tyre: { ...TYRE_ROAD, muLong: 1.46, muLat: 1.36, relax: 0.40 },
    engine: {
      /**
       * 2.5 turbo four, 290 hp. `torqueFactor` peaks at x = 1.30, so peak
       * POWER is `peakTorque * peakW * 1.1655` — 440 N.m at 4000 rpm is
       * 216 kW = 290 hp at 5200 rpm, which is the real car's headline number
       * arrived at through this model's own curve rather than asserted.
       */
      peakTorque: 440, peakRpm: 4000, redline: 6600, idle: 780,
      inertia: 0.30, friction: 0.055, brakeTorque: 38,
    },
    gearbox: {
      /**
       * EIGHT SPEEDS, geometric at 1.204 per step over a 3.67 spread — the
       * only eight-speed in the game and the widest ratio spread in it.
       *
       * The spread is what a dual clutch is FOR and it was worth measuring
       * rather than assuming: a first attempt at a close-ratio set (2.55 down
       * to 0.896, a spread of only 2.85) held the same top speed and cost 0.67
       * s to 50 km/h and 0.6 s to 100, because a narrow box pinned between a
       * traction-limited first and a top-speed-limited eighth has no low gear
       * left in it. First tops out at 56 km/h here against 74 there.
       *
       * `final` 4.55 rather than 4.20 puts the top at 224 km/h, which is a
       * deliberate slot: clear of the Allegheny's 187 and clear of the
       * Ironside's 231, so no two classes tie.
       */
      gears: [-2.90, 0, 3.05, 2.53, 2.10, 1.75, 1.45, 1.21, 1.00, 0.83],
      final: 4.55, eff: 0.93,
      // A dual clutch does not open the driveline the way a torque converter
      // does, so the dead time is a tenth, not the Allegheny's quarter.
      shiftUp: 0.94, shiftDown: 0.48, shiftTime: 0.11,
      autoClutchRpm: 1500,
    },
    diff: { lock: 0.35, preload: 45 },
    brakes: { front: 3200, rear: 1700, handbrake: 2400, bias: 0.68 },
    steer: { max: 0.56, speedFalloff: 0.58, rate: 4.6, returnRate: 5.6, counterAssist: 0.38 },
    aero: { cd: 0.30, area: 2.08, downF: 0.14, downR: 0.20, yawDrag: 3.3 },
    body: { hp: 950, crumple: 1.0 },
    /**
     * GREY, and only grey. This is Dylan's K5, named by the player off a real
     * grey sport sedan. `common`/`loud` used to roll it a red or a burgundy about
     * one spawn in five, which is why it kept reading as "a red coupe" — a K5 is
     * a grey four-door fastback, so `k5grey` is the whole pool.
     */
    paints: ['k5grey'],
    style: {
      /**
       * DERIVED FROM THE ALLEGHENY'S BLOCK, not authored from nothing, and the
       * deltas below are the entire difference between a three-box saloon and
       * a fastback. Everything not listed as a delta is the sedan's number,
       * because the sedan is the one silhouette in this file that is known to
       * render as a credible four-door and the fastback is a modification of
       * it, not a different animal.
       *
       * A first attempt DID author it from nothing — a 0.96 half-width with a
       * 0.69 roof half-width and a 1.44 roof over a 0.90 belt — and it rendered
       * as a narrow canopy perched on a wide slab with the tyres standing proud
       * of the flares. The lesson is the boring one: 72% roof-to-body width
       * reads as a chopped top, 78% reads as a car.
       */
      shape: 'fastback',
      groundY: 0.145,                       // delta: 0.16, sits lower
      roofY: 1.42,                          // delta: 1.40
      beltY: 0.895,
      sillY: 0.355,
      shoulderY: 0.805,
      hwMax: 0.98,                          // delta: 1.005, narrower than the 4dr
      /**
       * OVERHANG SPLIT. `finalizeStyle` divides `L - wheelbase` between the two
       * ends in the ratio these two numbers ask for, so the pair — not either
       * one alone — is what decides whether the car reads cab-rearward. At 1.00
       * ahead of the front arch against 1.06 behind the rear one the split came
       * out 0.995 / 1.055, near enough symmetric; the real car is 0.945 / 1.110.
       * Pulling the tip in to 2.32 gives 0.943 / 1.108 and moves the whole cabin
       * back over the rear axle, which is the proportion people read first.
       */
      noseY: 0.745, noseHw: 0.90, noseZ: 2.32,
      /**
       * A HIGH, SHORT deck — 10 cm above the Allegheny's, and the height is
       * doing as much work as the shortness. The boot is where the roofline
       * has to LAND, so a low deck forces the sweep to fall further over the
       * same run; at 1.00 the roof had dropped to within 9 cm of the belt by
       * the C-pillar and the DLO shut to a slot. `topLine` puts the ducktail
       * itself in the surface — see `ducktail`.
       */
      tailY: 1.045, tailHw: 0.94, tailZ: -2.46,
      cowlZ: 0.66, cowlY: 1.00,             // delta: 0.74 — 8 cm more bonnet
      /**
       * THE FOUR NUMBERS THAT ARE THE CAR, and they are z positions on ONE
       * curve now (`topLine` in body.js) rather than three independent heights.
       * Measured on the emitted silhouette, nose to tail:
       *
       *                        was      now     real K5, scaled to 4.90 m
       *   windscreen run      0.72     0.82        0.83
       *   roof crest          1.16     0.42        ~0.45
       *   backlight sweep     0.78     1.44        ~1.40
       *   deck                0.47     0.41        ~0.40
       *
       * The old roof was a 1.16 m plateau with a cliff at the end of it, which
       * is a notchback with the boot filed off. `roofCrest` is how much flat
       * roof there is behind the header before the smootherstep starts; after
       * that the line never stops falling until it reaches the boot lid.
       */
      windscreenTopZ: -0.16,                // delta: 0.05 — much more rake
      roofCrest: 0.50,
      roofRearZ: -0.92,                     // top edge of the backlight aperture
      backlightBaseZ: -2.09,                // delta: -1.52 — THE fastback number
      /** The DLO ends at the C-pillar; the sail panel behind it is solid. */
      sideWindowEnd: -1.66,
      /** The boot lid lifts this far at its trailing edge, then drops over it. */
      ducktail: 0.044,
      /**
       * THE SHOULDER LINE. The belt climbs this much between the cowl and the
       * rear axle, which is the single change that stops the flank reading as a
       * slab and closes the DLO to a point at the C-pillar. Nothing else in the
       * fleet authors one, so `carStations` no-ops on every other class.
       *
       * It fights the falling roofline for the same DLO, so it is a small
       * number: at 0.085 the shoulder read beautifully and the quarter light
       * shut to 9 cm.
       */
      beltRise: 0.055,
      greenhouseInset: 0.090, greenhouseTaper: 0.100,
      pillarA: 0.062, pillarB: 0.048, pillarC: 0.090,
      /**
       * The only class in the fleet that pays for a finer SECTION at LOD0, and
       * it is the hero car. See `PER_SEG` in body.js: the sail panel between
       * the roof edge and the belt was six columns wide and rendered as two
       * facets meeting in a fold.
       */
      perSeg0: 4,
      /** A bright DLO surround with the kick up the C-pillar. See `body.js`. */
      dloBright: true,
      archF: { z: 1.42, r: 0.435, flare: 0.034 },
      // THE HIP. Twice the front's flare and the widest rear arch on a car in
      // this fleet: the quarter panel has to stand proud of the door.
      archR: { z: -1.40, r: 0.440, flare: 0.072 },
      crownDeck: 0.045, crownRoof: 0.082, crownBonnet: 0.052,
      creaseY: 0.660, creaseDepth: 0.015,
      bumperDrop: 0.12, splitter: 0.02, diffuser: 0.05,
      bumperF: 0.20, bumperR: 0.20,
      // The widest, lowest aperture in the fleet.
      grille: { w: 1.05, hf: 0.20, yf: 0.46, kind: 'slot' },
      headlight: { w: 0.40, h: 0.13, yf: 0.72, inset: 0.26, kind: 'slim' },
      /**
       * The signature. `fullbar` exists for this car; see `body.js`.
       * `h` is 0.075 rather than 0.13 because this lamp has to read THIN —
       * at 13 cm the emitted bar was 42% of the fascia's height and photographed
       * as a black rectangle across the tail rather than as a line.
       */
      taillight: { w: 0.44, h: 0.075, yf: 0.62, inset: 0.20, kind: 'fullbar' },
      // Quad outlets.
      exhaust: { n: 2, r: 0.042, x: 0.40, y: 0.23 },
      mirror: { z: 0.50, y: 0.90, x: 0.985, size: 0.12 },
      /**
       * NO BOLT-ON LIP. The shared `ducktail` is authored for the Peregrine's
       * wedge — a 5-point sweep planted 12 cm ahead of the backlight base — and
       * on a deck this short it lands almost on the tail and renders as a slab
       * floating over the boot. This car's ducktail is in the SURFACE instead:
       * `tailY` 1.00 against the Allegheny's 0.94 is the deck kicking up, which
       * is what a real one is.
       */
      spoiler: 'none',
      /**
       * THREE SHUTLINES, BECAUSE IT IS A FOUR-DOOR.
       *
       * It was authored with two — a single 1.28 m aperture per side and no
       * rear-door shut anywhere on the flank — and `seats: 4, doors: 4` was
       * asserted only in the spec, never in the geometry. From the side it
       * photographed as a two-door coupe, which is a different car from a K5
       * before you get anywhere near the roofline. The B-pillar rides on
       * `doorSplit[1]`, so it was also parked 1.28 m aft of the cowl, behind
       * the driver's shoulder.
       */
      doorSplit: [0.64, -0.145, -1.065],
    },
  },

  /* ------------------------------------------------------ muscle ---- */
  muscle: {
    id: 'muscle',
    name: 'Ironside 440',
    kind: 'car',
    seats: 2,
    doors: 2,
    dims: { L: 5.1, W: 2.15, H: 1.28 },
    mass: 1700,
    comY: 0.47,
    comZ: 0.44,
    wheelbase: 2.92,
    trackF: 1.72, trackR: 1.74,
    wheel: { radius: 0.365, width: 0.32, rimFrac: 0.60, spokes: 5, style: 'dish' },
    drive: 'rwd',
    susp: {
      travel: 0.20, rideHeight: 0.155,
      freqF: 1.5, freqR: 1.42,
      dampF: 0.36, dampR: 0.33,
      reboundScale: 1.5,
      arbF: 14000, arbR: 8000,
      camberF: -0.012, camberR: -0.008,
      toeF: 0.0015, toeR: 0.003,
    },
    tyre: { ...TYRE_ROAD, muLong: 1.33, muLat: 1.25, relax: 0.5, fade: 0.24 },
    engine: {
      // 835 N.m, not 720 — see the ENGINE TORQUE note above the class table.
      peakTorque: 835, peakRpm: 3700, redline: 5900, idle: 750,
      inertia: 0.52, friction: 0.07, brakeTorque: 58,
    },
    gearbox: {
      gears: [-3.1, 0, 3.00, 1.90, 1.42, 1.040],
      final: 3.31, eff: 0.9,
      shiftUp: 0.94, shiftDown: 0.46, shiftTime: 0.24,
      autoClutchRpm: 1300,
    },
    diff: { lock: 0.75, preload: 140 },
    brakes: { front: 3000, rear: 1900, handbrake: 3400, bias: 0.62 },
    steer: { max: 0.55, speedFalloff: 0.62, rate: 4.2, returnRate: 5.2, counterAssist: 0.42 },
    aero: { cd: 0.48, area: 2.3, downF: 0.16, downR: 0.3, yawDrag: 3.8 },
    body: { hp: 1250, crumple: 0.85 },
    paints: ['common', 'loud'],
    style: {
      shape: 'longnose',
      groundY: 0.15,
      roofY: 1.28,
      beltY: 0.86,
      sillY: 0.36,
      shoulderY: 0.79,
      hwMax: 1.055,
      noseY: 0.80, noseHw: 0.96, noseZ: 2.55,
      tailY: 0.90, tailHw: 1.00, tailZ: -2.55,
      cowlZ: 0.30, cowlY: 0.97,
      windscreenTopZ: -0.44, roofRearZ: -1.16,
      backlightBaseZ: -1.66,
      greenhouseInset: 0.115, greenhouseTaper: 0.14,
      pillarA: 0.095, pillarB: 0.0, pillarC: 0.16,
      archF: { z: 1.46, r: 0.47, flare: 0.065 },
      archR: { z: -1.46, r: 0.49, flare: 0.105 },
      crownDeck: 0.045, crownRoof: 0.06, crownBonnet: 0.06,
      creaseY: 0.665, creaseDepth: 0.022,
      bumperDrop: 0.14, splitter: 0.0, diffuser: 0.0,
      bumperF: 0.22, bumperR: 0.22,
      grille: { w: 1.34, hf: 0.32, yf: 0.60, kind: 'egg' },
      headlight: { w: 0.26, h: 0.26, yf: 0.76, inset: 0.30, kind: 'round2' },
      taillight: { w: 0.5, h: 0.16, yf: 0.60, inset: 0.26, kind: 'segment' },
      exhaust: { n: 2, r: 0.055, x: 0.44, y: 0.26 },
      mirror: { z: 0.10, y: 0.87, x: 1.06, size: 0.13 },
      spoiler: 'none',
      bonnetScoop: true,
      doorSplit: [0.30, -0.95],
    },
  },

  /* ------------------------------------------------------- sedan ---- */
  sedan: {
    id: 'sedan',
    name: 'Allegheny 4dr',
    kind: 'car',
    seats: 4,
    doors: 4,
    dims: { L: 4.8, W: 2.05, H: 1.40 },
    mass: 1520,
    comY: 0.52,
    comZ: 0.45,
    wheelbase: 2.78,
    trackF: 1.60, trackR: 1.59,
    wheel: { radius: 0.335, width: 0.225, rimFrac: 0.66, spokes: 10, style: 'cover' },
    drive: 'fwd',
    susp: {
      travel: 0.19, rideHeight: 0.16,
      freqF: 1.42, freqR: 1.52,
      dampF: 0.35, dampR: 0.34,
      reboundScale: 1.45,
      arbF: 12000, arbR: 7000,
      camberF: -0.014, camberR: -0.016,
      toeF: 0.001, toeR: 0.003,
    },
    tyre: { ...TYRE_ROAD, muLong: 1.40, muLat: 1.32, relax: 0.48 },
    engine: {
      // 355 N.m, not 285 — see the ENGINE TORQUE note above the class table.
      // The sedan is the class this whole exercise is about: it is what the
      // player is given when nobody's own car is to hand, and it is the most
      // common thing on the road to steal.
      peakTorque: 355, peakRpm: 4200, redline: 6300, idle: 800,
      inertia: 0.28, friction: 0.05, brakeTorque: 34,
    },
    gearbox: {
      gears: [-3.4, 0, 2.80, 2.20, 1.60, 1.35, 1.070],
      final: 3.9, eff: 0.9,
      shiftUp: 0.83, shiftDown: 0.42, shiftTime: 0.28,
      autoClutchRpm: 1200,
    },
    diff: { lock: 0.12, preload: 20 },
    brakes: { front: 2500, rear: 1350, handbrake: 2100, bias: 0.65 },
    steer: { max: 0.58, speedFalloff: 0.6, rate: 4.0, returnRate: 5.0, counterAssist: 0.35 },
    aero: { cd: 0.40, area: 2.15, downF: 0.1, downR: 0.14, yawDrag: 3.4 },
    body: { hp: 900, crumple: 1.1 },
    paints: ['common', 'work'],
    style: {
      shape: 'sedan',
      groundY: 0.16,
      roofY: 1.40,
      beltY: 0.90,
      sillY: 0.37,
      shoulderY: 0.81,
      hwMax: 1.005,
      noseY: 0.76, noseHw: 0.90, noseZ: 2.38,
      tailY: 0.94, tailHw: 0.94, tailZ: -2.42,
      cowlZ: 0.74, cowlY: 1.00,
      windscreenTopZ: 0.05, roofRearZ: -1.05,
      backlightBaseZ: -1.52,
      greenhouseInset: 0.10, greenhouseTaper: 0.12,
      pillarA: 0.078, pillarB: 0.06, pillarC: 0.115,
      archF: { z: 1.40, r: 0.44, flare: 0.028 },
      archR: { z: -1.38, r: 0.445, flare: 0.03 },
      crownDeck: 0.05, crownRoof: 0.085, crownBonnet: 0.05,
      creaseY: 0.665, creaseDepth: 0.014,
      bumperDrop: 0.13, splitter: 0.0, diffuser: 0.0,
      bumperF: 0.21, bumperR: 0.21,
      grille: { w: 0.92, hf: 0.24, yf: 0.56, kind: 'bar' },
      headlight: { w: 0.34, h: 0.17, yf: 0.78, inset: 0.28, kind: 'wrap' },
      taillight: { w: 0.34, h: 0.24, yf: 0.60, inset: 0.24, kind: 'vertical' },
      exhaust: { n: 1, r: 0.038, x: 0.42, y: 0.24 },
      mirror: { z: 0.50, y: 0.92, x: 1.01, size: 0.12 },
      spoiler: 'none',
      doorSplit: [0.72, -0.10, -0.96],
    },
  },

  /* --------------------------------------------------------- van ---- */
  van: {
    id: 'van',
    name: 'Foundry Van',
    kind: 'car',
    seats: 2,
    doors: 2,
    dims: { L: 5.6, W: 2.3, H: 2.3 },
    mass: 2250,
    comY: 0.72,
    comZ: 0.42,
    wheelbase: 3.30,
    trackF: 1.76, trackR: 1.74,
    wheel: { radius: 0.36, width: 0.235, rimFrac: 0.6, spokes: 6, style: 'steel' },
    drive: 'rwd',
    susp: {
      travel: 0.22, rideHeight: 0.19,
      freqF: 1.5, freqR: 1.72,
      dampF: 0.34, dampR: 0.30,
      reboundScale: 1.4,
      arbF: 11000, arbR: 4000,
      camberF: -0.008, camberR: 0,
      toeF: 0.002, toeR: 0.002,
    },
    tyre: { ...TYRE_ROAD, muLong: 1.25, muLat: 1.18, relax: 0.55, loadSens: 0.11 },
    engine: {
      // 490 N.m, not 390 — see the ENGINE TORQUE note above the class table.
      // The biggest lift in the fleet, because the van was the most
      // under-driven thing in it: 39% of its tyres' capability at 25-50 km/h.
      peakTorque: 490, peakRpm: 2600, redline: 4400, idle: 720,
      inertia: 0.46, friction: 0.07, brakeTorque: 52,
    },
    gearbox: {
      gears: [-3.8, 0, 4.10, 2.40, 1.55, 1.20, 1.012],
      final: 4.1, eff: 0.88,
      shiftUp: 0.8, shiftDown: 0.4, shiftTime: 0.34,
      autoClutchRpm: 1050,
    },
    diff: { lock: 0.2, preload: 40 },
    brakes: { front: 2900, rear: 2000, handbrake: 2400, bias: 0.6 },
    steer: { max: 0.5, speedFalloff: 0.66, rate: 3.3, returnRate: 4.2, counterAssist: 0.3 },
    aero: { cd: 0.52, area: 4.1, downF: 0.0, downR: 0.0, yawDrag: 6.5 },
    body: { hp: 1150, crumple: 1.2 },
    paints: ['work', 'common'],
    style: {
      shape: 'van',
      groundY: 0.19,
      roofY: 2.30,
      beltY: 1.22,
      sillY: 0.48,
      shoulderY: 1.05,
      hwMax: 1.13,
      noseY: 1.10, noseHw: 1.02, noseZ: 2.78,
      tailY: 2.10, tailHw: 1.10, tailZ: -2.82,
      cowlZ: 1.72, cowlY: 1.30,
      windscreenTopZ: 1.05, roofRearZ: -2.6,
      backlightBaseZ: -2.7,
      greenhouseInset: 0.055, greenhouseTaper: 0.03,
      pillarA: 0.10, pillarB: 0.12, pillarC: 0.14,
      archF: { z: 1.70, r: 0.46, flare: 0.02 },
      archR: { z: -1.60, r: 0.47, flare: 0.02 },
      crownDeck: 0.03, crownRoof: 0.11, crownBonnet: 0.04,
      creaseY: 0.98, creaseDepth: 0.02,
      bumperDrop: 0.16, splitter: 0.0, diffuser: 0.0,
      bumperF: 0.20, bumperR: 0.20,
      grille: { w: 1.1, hf: 0.22, yf: 0.62, kind: 'egg' },
      headlight: { w: 0.34, h: 0.26, yf: 0.82, inset: 0.24, kind: 'wrap' },
      taillight: { w: 0.18, h: 0.62, yf: 0.62, inset: 0.14, kind: 'vertical' },
      exhaust: { n: 1, r: 0.05, x: 0.5, y: 0.28 },
      mirror: { z: 1.42, y: 1.42, x: 1.2, size: 0.2, arm: 0.22 },
      spoiler: 'none',
      boxBody: true,
      doorSplit: [1.30],
      sideWindowEnd: 0.55,
    },
  },

  /* ------------------------------------------------------- truck ---- */
  truck: {
    id: 'truck',
    name: 'Millhand 6',
    kind: 'car',
    seats: 2,
    doors: 2,
    dims: { L: 7.2, W: 2.6, H: 2.9 },
    mass: 5400,
    comY: 0.88,
    comZ: 0.38,
    wheelbase: 4.35,
    trackF: 2.02, trackR: 1.86,
    wheel: { radius: 0.52, width: 0.30, rimFrac: 0.62, spokes: 8, style: 'lorry', dually: true },
    drive: 'rwd',
    susp: {
      travel: 0.26, rideHeight: 0.24,
      freqF: 1.55, freqR: 1.85,
      dampF: 0.36, dampR: 0.34,
      reboundScale: 1.3,
      arbF: 42000, arbR: 22000,
      camberF: 0, camberR: 0,
      toeF: 0.002, toeR: 0.001,
    },
    tyre: { ...TYRE_TRUCK },
    engine: {
      // 1810 N.m, not 1450 — see the ENGINE TORQUE note above the class table.
      // This is CARSON'S car, so a player who picks the oldest brother spends
      // his whole first act in it.
      peakTorque: 1810, peakRpm: 1500, redline: 2900, idle: 620,
      inertia: 1.6, friction: 0.11, brakeTorque: 190,
    },
    gearbox: {
      gears: [-6.4, 0, 5.77, 4.20, 2.60, 1.70, 1.22, 0.982],
      final: 4.6, eff: 0.86,
      shiftUp: 0.86, shiftDown: 0.44, shiftTime: 0.55,
      autoClutchRpm: 900,
    },
    diff: { lock: 0.35, preload: 260 },
    brakes: { front: 8200, rear: 9800, handbrake: 6000, bias: 0.46 },
    steer: { max: 0.42, speedFalloff: 0.72, rate: 2.2, returnRate: 3.0, counterAssist: 0.2 },
    aero: { cd: 0.72, area: 6.4, downF: 0, downR: 0, yawDrag: 10 },
    body: { hp: 2600, crumple: 0.55 },
    paints: ['work'],
    style: {
      shape: 'truck',
      groundY: 0.24,
      roofY: 2.90,
      beltY: 1.92,
      sillY: 0.95,
      shoulderY: 1.70,
      hwMax: 1.28,
      noseY: 1.90, noseHw: 1.20, noseZ: 3.58,
      tailY: 1.30, tailHw: 1.26, tailZ: -3.62,
      cowlZ: 2.30, cowlY: 2.00,
      windscreenTopZ: 1.60, roofRearZ: 0.62,
      backlightBaseZ: 0.5,
      greenhouseInset: 0.06, greenhouseTaper: 0.02,
      pillarA: 0.13, pillarB: 0.0, pillarC: 0.15,
      archF: { z: 2.32, r: 0.64, flare: 0.03 },
      archR: { z: -2.03, r: 0.66, flare: 0.03 },
      crownDeck: 0.02, crownRoof: 0.08, crownBonnet: 0.03,
      creaseY: 1.5, creaseDepth: 0.03,
      bumperDrop: 0.42, splitter: 0, diffuser: 0,
      bumperF: 0.16, bumperR: 0.20,
      grille: { w: 1.5, hf: 0.40, yf: 0.66, kind: 'lorry' },
      headlight: { w: 0.34, h: 0.30, yf: 0.30, inset: 0.2, kind: 'square' },
      taillight: { w: 0.2, h: 0.44, yf: 0.52, inset: 0.14, kind: 'cluster' },
      exhaust: { n: 1, r: 0.08, x: 1.16, y: 1.6, stack: true },
      mirror: { z: 2.05, y: 2.1, x: 1.42, size: 0.26, arm: 0.3 },
      flatbed: { z0: -3.5, z1: 0.35, deckY: 1.28, sideH: 0.36 },
      doorSplit: [1.6],
    },
  },

  /* ------------------------------------------------------ police ---- */
  police: {
    id: 'police',
    name: 'Precinct Cruiser',
    kind: 'car',
    seats: 4,
    doors: 4,
    dims: { L: 5.0, W: 2.1, H: 1.45 },
    mass: 1780,
    comY: 0.50,
    comZ: 0.47,
    wheelbase: 2.94,
    trackF: 1.66, trackR: 1.67,
    wheel: { radius: 0.35, width: 0.25, rimFrac: 0.62, spokes: 5, style: 'steel' },
    drive: 'rwd',
    susp: {
      travel: 0.18, rideHeight: 0.145,
      freqF: 1.75, freqR: 1.8,
      dampF: 0.42, dampR: 0.4,
      reboundScale: 1.4,
      arbF: 20000, arbR: 14000,
      camberF: -0.018, camberR: -0.012,
      toeF: 0.001, toeR: 0.003,
    },
    tyre: { ...TYRE_ROAD, muLong: 1.47, muLat: 1.39, relax: 0.42 },
    engine: {
      // 625 N.m, not 540 — see the ENGINE TORQUE note above the class table.
      // Lifted by the same 16% as the sports and muscle cars it has to chase,
      // so the pursuit balance is exactly where it was.
      peakTorque: 625, peakRpm: 4600, redline: 6600, idle: 780,
      inertia: 0.4, friction: 0.06, brakeTorque: 48,
    },
    gearbox: {
      gears: [-3.5, 0, 3.30, 2.10, 1.55, 1.28, 0.991],
      final: 3.6, eff: 0.92,
      shiftUp: 0.94, shiftDown: 0.48, shiftTime: 0.16,
      autoClutchRpm: 1400,
    },
    diff: { lock: 0.6, preload: 110 },
    brakes: { front: 3600, rear: 2200, handbrake: 3000, bias: 0.64 },
    steer: { max: 0.6, speedFalloff: 0.58, rate: 4.6, returnRate: 5.8, counterAssist: 0.46 },
    aero: { cd: 0.41, area: 2.2, downF: 0.2, downR: 0.28, yawDrag: 3.5 },
    body: { hp: 1200, crumple: 0.95 },
    paints: ['police'],
    livery: 'police',
    style: {
      shape: 'sedan',
      groundY: 0.145,
      roofY: 1.45,
      beltY: 0.92,
      sillY: 0.37,
      shoulderY: 0.83,
      hwMax: 1.03,
      noseY: 0.78, noseHw: 0.93, noseZ: 2.48,
      tailY: 0.96, tailHw: 0.96, tailZ: -2.52,
      cowlZ: 0.68, cowlY: 1.03,
      windscreenTopZ: -0.02, roofRearZ: -1.12,
      backlightBaseZ: -1.62,
      greenhouseInset: 0.10, greenhouseTaper: 0.13,
      pillarA: 0.08, pillarB: 0.06, pillarC: 0.12,
      archF: { z: 1.47, r: 0.455, flare: 0.038 },
      archR: { z: -1.47, r: 0.46, flare: 0.042 },
      crownDeck: 0.05, crownRoof: 0.08, crownBonnet: 0.05,
      creaseY: 0.685, creaseDepth: 0.016,
      bumperDrop: 0.13, splitter: 0.0, diffuser: 0.0,
      bumperF: 0.21, bumperR: 0.21,
      grille: { w: 1.0, hf: 0.24, yf: 0.56, kind: 'bar' },
      headlight: { w: 0.36, h: 0.17, yf: 0.78, inset: 0.28, kind: 'wrap' },
      taillight: { w: 0.36, h: 0.24, yf: 0.60, inset: 0.24, kind: 'vertical' },
      exhaust: { n: 2, r: 0.042, x: 0.44, y: 0.24 },
      mirror: { z: 0.44, y: 0.94, x: 1.04, size: 0.125 },
      spoiler: 'none',
      lightbar: true,
      pushBar: true,
      doorSplit: [0.66, -0.16, -1.02],
    },
  },

  /* -------------------------------------------------------- bike ---- */
  bike: {
    id: 'bike',
    name: 'Slagbolt',
    kind: 'bike',
    seats: 1,
    doors: 0,
    dims: { L: 2.3, W: 0.9, H: 1.2 },
    mass: 232, // + rider
    comY: 0.52,
    comZ: 0.48,
    wheelbase: 1.44,
    trackF: 0.001, trackR: 0.001,
    wheel: { radius: 0.32, width: 0.16, rimFrac: 0.62, spokes: 5, style: 'bike' },
    drive: 'rwd',
    susp: {
      travel: 0.13, rideHeight: 0.10,
      freqF: 2.4, freqR: 2.6,
      dampF: 0.45, dampR: 0.44,
      reboundScale: 1.3,
      arbF: 0, arbR: 0,
      camberF: 0, camberR: 0,
      toeF: 0, toeR: 0,
    },
    tyre: { ...TYRE_BIKE },
    engine: {
      peakTorque: 124, peakRpm: 9500, redline: 13000, idle: 1300,
      inertia: 0.09, friction: 0.03, brakeTorque: 12,
    },
    gearbox: {
      gears: [-2.8, 0, 2.60, 1.90, 1.55, 1.32, 1.18],
      final: 5.40, eff: 0.94,
      shiftUp: 0.965, shiftDown: 0.58, shiftTime: 0.08,
      autoClutchRpm: 2200,
    },
    diff: { lock: 1, preload: 0 },
    brakes: { front: 1500, rear: 620, handbrake: 700, bias: 0.72 },
    // A bike steers with its weight. Full lock is for the car park: the lock
    // winds out to a tenth by 26 m/s, which is what stops a keyboard tap at
    // 90 km/h throwing it on its side. See `_updateSteering`.
    steer: {
      max: 0.62, speedFalloff: 0.90, falloffRef: 26, minFrac: 0.10,
      rate: 5.4, returnRate: 6.8, counterAssist: 0.35,
    },
    aero: { cd: 0.70, area: 0.72, downF: 0, downR: 0, yawDrag: 1.2 },
    body: { hp: 340, crumple: 1.6 },
    /** How far the bike leans into a corner, rad per (m/s^2) of lateral accel. */
    lean: { gain: 0.115, max: 0.68, rate: 7.0 },
    /**
     * THE SLAGBOLT'S SPRINT IS 1.25, AND THAT NUMBER WAS MEASURED, NOT COPIED.
     *
     * The default sprint for a two-wheeler is 1.95 — derived for the BICYCLE,
     * which is drag-limited, where 1.95 of power buys exactly 1.25 of top
     * speed. A 124 N.m superbike through a 5.40 final drive is not
     * drag-limited, it is TRACTION-limited, and it cannot put that down. Ground
     * covered in ten seconds from a 20 m/s roll, boosted against unboosted:
     *
     *   torque   1.10   1.15   1.20   1.25   1.35   1.95
     *   distance x1.047 x1.063 x1.086 x1.107 x0.670 x0.921
     *
     * There is a cliff between 1.25 and 1.35: past it the rear simply lights up
     * and the bike goes SLOWER than it does with nothing held (the 1.95 column
     * is on the far side of it, 97 km/h against 229). 1.25 is the last value
     * that is all gain.
     */
    boost: { kind: 'sprint', torque: 1.25 },
    paints: ['loud', 'common'],
    style: {
      shape: 'bike',
      groundY: 0.10,
      roofY: 1.20,
      hwMax: 0.30,
      seatY: 0.80, tankY: 0.90, tankZ: 0.15,
      barY: 1.06, barZ: 0.52, barW: 0.36,
      forkRake: 0.44,
      archF: { z: 0.72, r: 0.36, flare: 0 },
      archR: { z: -0.72, r: 0.37, flare: 0 },
      headlight: { w: 0.16, h: 0.14, y: 1.0, inset: 0, kind: 'round' },
      taillight: { w: 0.1, h: 0.06, y: 0.86, inset: 0, kind: 'bar' },
      exhaust: { n: 1, r: 0.05, x: 0.16, y: 0.36 },
    },
  },

  /* -------------------------------------------------------- boat ---- */
  boat: {
    id: 'boat',
    name: 'Riverjack',
    kind: 'boat',
    seats: 3,
    doors: 0,
    dims: { L: 6.4, W: 2.4, H: 1.5 },
    mass: 1180,
    comY: 0.42,
    comZ: 0.55,
    wheelbase: 4.0,
    trackF: 1.8, trackR: 1.8,
    wheel: { radius: 0.3, width: 0.2, rimFrac: 0.6, spokes: 5, style: 'steel' },
    drive: 'rwd',
    susp: { travel: 0.1, rideHeight: 0.1, freqF: 1, freqR: 1, dampF: 0.4, dampR: 0.4, reboundScale: 1, arbF: 0, arbR: 0, camberF: 0, camberR: 0, toeF: 0, toeR: 0 },
    tyre: { ...TYRE_ROAD },
    engine: {
      peakTorque: 330, peakRpm: 4200, redline: 6000, idle: 850,
      inertia: 0.5, friction: 0.06, brakeTorque: 30,
    },
    gearbox: { gears: [-1.9, 0, 1.9], final: 1.6, eff: 0.9, shiftUp: 2, shiftDown: 0, shiftTime: 0.4, autoClutchRpm: 1200 },
    diff: { lock: 1, preload: 0 },
    brakes: { front: 0, rear: 0, handbrake: 0, bias: 0.5 },
    steer: { max: 0.55, speedFalloff: 0.2, rate: 2.6, returnRate: 3.0, counterAssist: 0 },
    aero: { cd: 0.5, area: 2.4, downF: 0, downR: 0, yawDrag: 4 },
    body: { hp: 1100, crumple: 0.9 },
    /** Hull hydrodynamics — see boat.js. */
    hull: {
      /** Sample points along the hull for displacement, in local metres. */
      draft: 0.42,
      /** Hull volume below the waterline at rest, m^3 (mass/1000 * 1.9). */
      buoyancy: 2.6,
      /** Longitudinal / lateral / vertical drag coefficients, N per (m/s)^2. */
      dragLong: 52, dragLat: 900, dragVert: 900,
      /** Planing lift coefficient — N per (m/s)^2 at full trim. */
      planing: 62,
      planeSpeed: 7.5,
      /** Yaw damping and rudder authority. */
      yawDamp: 9500, rudder: 1800,
      /** Righting stiffness in roll/pitch, Nm/rad. */
      rollStiff: 26000, pitchStiff: 52000,
      rollDamp: 9000, pitchDamp: 16000,
      thrust: 11000,
    },
    paints: ['common', 'work'],
    style: {
      shape: 'boat',
      groundY: 0.0,
      roofY: 1.5,
      hwMax: 1.2,
      sheerY: 0.86, keelY: -0.42,
      bowZ: 3.2, sternZ: -3.2,
      windshieldZ: 0.55, windshieldH: 0.36,
      consoleZ: 0.2,
      deckY: 0.72,
      headlight: { w: 0.14, h: 0.1, y: 1.0, inset: 0, kind: 'round' },
      taillight: { w: 0.1, h: 0.1, y: 0.9, inset: 0, kind: 'round' },
    },
  },

  /* --------------------------------------------------------- bus ---- */
  /**
   * THE STEELHAULER 30 — a 30-foot two-axle transit bus.
   *
   * Real numbers, because the whole point of the class is mass: a Gillig/New
   * Flyer 30-footer is 9.4-9.8 m long, 2.55 m wide over the mirrors' mounts,
   * 3.1-3.3 m to the roof skin, and weighs 10-11 t empty. It carries a 6.7 l
   * diesel making ~1150 N.m at 1500 rpm through a torque-converter automatic
   * and a 5.05 final drive, and the ECU governs it — which is why the top gear
   * here is a straight 1.00 and not the 0.64 overdrive the real Allison has.
   * A bus that will do 150 km/h is not a bus.
   *
   * What the class is FOR, and why the numbers have to be these:
   *   - it is the only thing in the fleet a car cannot push out of the way.
   *     10.2 t against a 1.36 t sports car is a 7.5:1 mass ratio, so
   *     `_pairResolve` gives the sports car all of the impulse.
   *   - it is the only thing that cannot take a corner at speed. comY 1.05 with
   *     a 2.10 m front track is a roll couple three times the sedan's, and the
   *     anti-roll bars are deliberately NOT sized to hide it.
   *   - it is 9.6 m long, which is longer than a lane is wide. Junctions in a
   *     downtown triangle have to be planned rather than driven.
   *
   * At 9.6 m it also needs more camera radius than a car does to frame at all:
   * see the note in the CAMERA section below.
   */
  bus: {
    id: 'bus',
    name: 'Steelhauler 30',
    kind: 'car',
    seats: 4,
    doors: 2,
    dims: { L: 9.6, W: 2.55, H: 3.15 },
    mass: 10200,
    /** A low-floor bus still carries its engine, gearbox and axles high. */
    comY: 1.05,
    /** Rear engine: 38% of the mass on the front axle. */
    comZ: 0.38,
    wheelbase: 5.6,
    trackF: 2.10, trackR: 1.90,
    wheel: { radius: 0.53, width: 0.315, rimFrac: 0.58, spokes: 10, style: 'lorry', dually: true },
    drive: 'rwd',
    susp: {
      // Air suspension: soft, long-travel, heavily damped, and it kneels.
      travel: 0.25, rideHeight: 0.16,
      freqF: 1.20, freqR: 1.34,
      dampF: 0.40, dampR: 0.38,
      reboundScale: 1.25,
      /**
       * Anti-roll deliberately UNDER-sized for the mass. A bus leans, visibly,
       * and that lean is the whole tactile signature of the class. Sized to
       * about half of what would hold it flat.
       */
      arbF: 38000, arbR: 16000,
      camberF: 0, camberR: 0,
      toeF: 0.002, toeR: 0.001,
    },
    tyre: { ...TYRE_TRUCK, muLong: 1.10, muLat: 1.02, relax: 0.68 },
    engine: {
      peakTorque: 1150, peakRpm: 1500, redline: 2600, idle: 600,
      inertia: 1.5, friction: 0.10, brakeTorque: 165,
    },
    gearbox: {
      /**
       * Five forward speeds and a STRAIGHT top, not an overdrive: the ECU
       * governs a transit bus and this is how that is spelled in a gearbox.
       * The real Allison's 0.64 sixth would put this at 153 km/h.
       *
       * First is 4.90 rather than the Allison's 3.51 because this model has no
       * TORQUE CONVERTER, and a converter multiplies torque by about 1.8 at
       * stall — which is the entire reason a bus pulls away from a stop on a
       * hill at all. Steel City is Pittsburgh, so that matters more here than
       * it would anywhere else. Measured, full throttle from rest:
       *
       *                       3.10      4.20      4.90     grade needs
       *   thrust in 1st     28.5 kN   38.7 kN   45.1 kN
       *   14.5 deg (26%)    1.73 m/s   4.0 m/s  ~5.4 m/s     25.1 kN
       *   20.0 deg (36%)   -0.06 m/s  ~0.9 m/s  ~3.0 m/s     36.2 kN
       *
       * At 3.10 the bus SLID BACKWARDS down a 36% grade — Canton Avenue is 37%
       * and a real bus does not go up it either, but a player who has parked
       * one on a hill must never be trapped there. 4.90 is still well inside
       * the 68 kN its rear tyres can put down, and still less than the 6.3
       * effective ratio a real converter-plus-3.51 gives at stall.
       *
       * It does not make the bus quick: first only reaches 19 km/h before the
       * upshift, so what it buys is the pull-away, which is the point.
       */
      gears: [-4.6, 0, 4.90, 2.40, 1.60, 1.18, 1.00],
      final: 5.05, eff: 0.84,
      shiftUp: 0.90, shiftDown: 0.44, shiftTime: 0.5,
      autoClutchRpm: 850,
    },
    diff: { lock: 0.4, preload: 220 },
    brakes: { front: 9000, rear: 11000, handbrake: 7000, bias: 0.45 },
    steer: { max: 0.52, speedFalloff: 0.74, rate: 2.0, returnRate: 2.8, counterAssist: 0.16 },
    aero: { cd: 0.72, area: 7.4, downF: 0, downR: 0, yawDrag: 13 },
    body: { hp: 3000, crumple: 0.5 },
    paints: ['work', 'loud'],
    style: {
      shape: 'bus',
      groundY: 0.32,
      roofY: 3.15,
      beltY: 1.86,
      sillY: 0.92,
      shoulderY: 1.70,
      hwMax: 1.275,
      noseY: 2.98, noseHw: 0.99, noseZ: 4.55,
      tailY: 3.06, tailHw: 1.00, tailZ: -4.65,
      cowlZ: 3.86, cowlY: 3.02,
      windscreenTopZ: 3.30, roofRearZ: -4.20,
      backlightBaseZ: -4.42,
      greenhouseInset: 0.045, greenhouseTaper: 0.02,
      pillarA: 0.11, pillarB: 0.10, pillarC: 0.13,
      archF: { z: 3.45, r: 0.66, flare: 0.02 },
      archR: { z: -2.15, r: 0.68, flare: 0.02 },
      crownDeck: 0.02, crownRoof: 0.09, crownBonnet: 0.03,
      creaseY: 1.44, creaseDepth: 0.022,
      bumperDrop: 0.30, splitter: 0, diffuser: 0,
      bumperF: 0.16, bumperR: 0.18,
      grille: { w: 1.30, hf: 0.18, yf: 0.28, kind: 'bar' },
      headlight: { w: 0.30, h: 0.22, yf: 0.24, inset: 0.20, kind: 'square' },
      taillight: { w: 0.22, h: 0.50, yf: 0.34, inset: 0.16, kind: 'cluster' },
      exhaust: { n: 1, r: 0.06, x: 0.92, y: 0.36 },
      mirror: { z: 3.60, y: 2.48, x: 1.46, size: 0.28, arm: 0.34 },
      spoiler: 'none',
      boxBody: true,
      // Front door at the cowl, centre door behind the middle: two, like a
      // 30-footer, not four like a sedan.
      doorSplit: [2.86, -0.30],
      sideWindowEnd: -4.05,
    },
  },

  /* -------------------------------------------------------- tram ---- */
  /**
   * THE MONONGAHELA — a PCC-style interurban trolley on the Strip ->
   * Lawrenceville mill line. See `tram.js` for the carriage geometry and the
   * rail service; `src/world/railmover.js` runs it along the emitted rail
   * polyline (`railsweep` proves that line continuous end to end).
   *
   * THIS CLASS IS NEVER STEPPED BY THE DYNAMICS. `TramService` flags its one
   * instance `kinematic` and `VehicleSystem.fixedUpdate` skips `fixedStep`
   * for it — a rail vehicle's trajectory IS the track, and a Pacejka tyre has
   * nothing to add but drift. The drivetrain/tyre/suspension numbers below
   * are therefore inert placeholders that only exist so `finalizeSpec` can
   * derive an inertia tensor, collision probes and half-extents; the numbers
   * that are REAL and load-bearing are:
   *
   *   mass 19500      a loaded PCC car, and the whole collision story: at
   *                   19.5 t the pair resolver hands ~93% of any overlap to
   *                   the car that hit it, so traffic is shoved and the tram
   *                   holds its line — the bus behaviour, one weight class up.
   *   dims 14.0 x 2.6 a 46-foot single-unit car; boundingRadius and the
   *                   3-sphere pair test both come from these.
   *   trackF 1.435    standard gauge — `roadmesh._rail` lays the railheads at
   *                   +/-0.7175 m, and the wheel cylinders in `tram.js` sit on
   *                   exactly that.
   *   comY 1.15       CoM above the RAIL HEAD; TramService poses the body at
   *                   railTop + comY, same convention as every other class.
   *   body.hp 3600    heavier than the bus: rolling stock shrugs off a shunt.
   *
   * It is deliberately NOT in traffic's spawn mix, not enterable, and burns no
   * fuel. `npm run tram` (tramprobe.mjs) is the gate.
   */
  tram: {
    id: 'tram',
    name: 'Monongahela',
    kind: 'tram',
    seats: 0,
    doors: 0,
    dims: { L: 14.0, W: 2.6, H: 3.4 },
    mass: 19500,
    comY: 1.15,
    comZ: 0.5,
    /** Bogie pivots, not axles — see BOGIE_HALF in tram.js. */
    wheelbase: 7.6,
    trackF: 1.435, trackR: 1.435,
    wheel: { radius: 0.33, width: 0.09, rimFrac: 0.9, spokes: 0, style: 'steel' },
    drive: 'rwd',
    susp: {
      travel: 0.06, rideHeight: 0.05,
      freqF: 1.4, freqR: 1.4, dampF: 0.6, dampR: 0.6, reboundScale: 1,
      arbF: 0, arbR: 0, camberF: 0, camberR: 0, toeF: 0, toeR: 0,
    },
    tyre: { ...TYRE_TRUCK },
    engine: {
      // Four 55 kW traction motors' worth of torque, for the audio profile if
      // one is ever attached; the timetable in railmover.js is what actually
      // moves it.
      peakTorque: 900, peakRpm: 1400, redline: 2200, idle: 0,
      inertia: 1.2, friction: 0.08, brakeTorque: 60,
    },
    nogas: true,
    gearbox: { gears: [-1, 0, 1], final: 6.0, eff: 0.9, shiftUp: 2, shiftDown: 0, shiftTime: 0.4, autoClutchRpm: 0 },
    diff: { lock: 1, preload: 0 },
    brakes: { front: 0, rear: 0, handbrake: 0, bias: 0.5 },
    steer: { max: 0, speedFalloff: 0, rate: 1, returnRate: 1, counterAssist: 0 },
    aero: { cd: 0.8, area: 8.0, downF: 0, downR: 0, yawDrag: 10 },
    body: { hp: 3600, crumple: 0.35 },
    boost: null,
    paints: ['common'],
    style: {
      shape: 'tram',
      /** Lowest bodywork (skirt bottom) above the rail head. */
      groundY: 0.30,
      /** Base of the roof crown's own box; crown tops out ~0.36 above. */
      roofY: 3.02,
      hwMax: 1.30,
      /** The window band: sill, head, and the letterboard above it. */
      skirtY: 0.30, beltY: 1.45, winTopY: 2.30, cantY: 2.62,
      floorY: 0.90,
      /** Bogie pivot distance from centre (= wheelbase / 2) and wheel size. */
      bogieZ: 3.8, wheelR: 0.33,
      headlight: { w: 0.12, h: 0.12, yf: 0.3, inset: 0, kind: 'round' },
      taillight: { w: 0.16, h: 0.10, yf: 0.25, inset: 0, kind: 'bar' },
    },
  },

  /* ----------------------------------------------------- bicycle ---- */
  /**
   * THE TOWPATH — a city bicycle, and the only vehicle in the game with no
   * engine and no tank.
   *
   * ────────────────────────────────────────────────────────────────────────
   * THE RIDER IS THE ENGINE, AND THAT IS NOT A METAPHOR
   * ────────────────────────────────────────────────────────────────────────
   * A bicycle has a torque source, a multi-ratio gearbox and a final drive, so
   * it fits the existing drivetrain exactly — you just have to put a human in
   * the engine block:
   *
   *   peakTorque 42 N.m    a fit rider's SUSTAINED effort. 42 N.m at 78 rpm is
   *                        343 W, which is what a strong amateur holds. The
   *                        1000 W a sprinter makes for ten seconds is not this
   *                        number, it is the boost — see below.
   *   peakRpm 78           torque peaks at a real cadence and is nearly flat
   *                        from 56 to 92 rpm through `torqueFactor`'s curve,
   *                        which is how legs actually behave. Set to 62 first,
   *                        and the result was a bicycle stuck in first gear at
   *                        24.9 km/h with the cadence pinned at 117 rpm: the
   *                        gearbox upshifts on a fraction of redline, and a peak
   *                        that low put the whole usable range below the shift
   *                        point. Measured, not guessed.
   *   redline 148          you cannot pedal faster than that. It is a real
   *                        limit, not a rev limiter.
   *   idle 0               THERE IS NO IDLE. See `Drivetrain.step`: an engine
   *                        with `idle <= 0` gets no idle governor and no creep,
   *                        which is what stops a parked bicycle wandering off.
   *   brakeTorque 0.55     a freewheel. Almost no engine braking — coasting is
   *                        the defining feel of a bicycle and 40 N.m of engine
   *                        drag would make it feel like a bike with the clutch
   *                        out in first.
   *   shiftUp 0.62         92 rpm. A cyclist changes up at about 95, not at the
   *                        86% of redline (127 rpm) a car uses.
   *
   * The gears are the real thing: a 46-tooth chainring against a 7-speed block
   * from 28 down to 14 teeth, so the ratio (crank rpm per wheel rpm) runs 0.61
   * to 0.30. Those are numbers off a real bicycle.
   *
   * MEASURED on the bench: 38.9 km/h flat out, 48.6 km/h sprinting, 0-25 km/h
   * in 3.4 s. 38.9 is what 343 W against a 0.40 m^2 upright rider actually
   * gives, and the sprint ratio of 1.249 arrives through the physics rather
   * than being clamped on top of it.
   *
   * mass 92 = a 14 kg city bike plus a 78 kg rider, and the Slagbolt's 232 kg
   * is on the same convention (its comment says "+ rider").
   *
   * `nogas: true` means no fuel is consumed, ever, and the tank gauge should
   * not be drawn. See the BOOST section below for why `boost.kind = 'sprint'`
   * shares Shift with nitro instead of getting a key of its own.
   */
  bicycle: {
    id: 'bicycle',
    name: 'Towpath',
    kind: 'bike',
    seats: 1,
    doors: 0,
    dims: { L: 1.82, W: 0.56, H: 1.12 },
    mass: 92,
    comY: 0.62,
    comZ: 0.45,
    wheelbase: 1.06,
    trackF: 0.001, trackR: 0.001,
    wheel: { radius: 0.345, width: 0.042, rimFrac: 0.90, spokes: 16, style: 'bike' },
    drive: 'rwd',
    susp: {
      // A rigid frame on 35 mm tyres. The "suspension" IS the tyre carcass, so
      // the travel is tiny and the frequency is high.
      travel: 0.05, rideHeight: 0.035,
      freqF: 4.2, freqR: 4.4,
      dampF: 0.30, dampR: 0.30,
      reboundScale: 1.1,
      arbF: 0, arbR: 0,
      camberF: 0, camberR: 0,
      toeF: 0, toeR: 0,
    },
    /**
     * `Bx` 9, not TYRE_BIKE's 13, and this is a NUMERICAL limit rather than a
     * taste. The wheel-spin ODE's stability margin scales with the vehicle's
     * effective mass at the contact patch over the tyre's slip stiffness, and a
     * 92 kg vehicle is a quarter of the Slagbolt's 232 kg + rider. Measured on
     * the bench at the class's own launch, peak |slip ratio| between 2 s and
     * 7.5 s with nothing but the throttle held:
     *
     *     Bx  13    11     10     9      8      7      6
     *     slip 0.074 0.060  0.046  0.013  0.015  0.017  0.020
     *
     * i.e. a clean period-2 oscillation above 9 (the chassis velocity flipped
     * 0.158 / 0.081 m/s on ALTERNATE STEPS and both tyres threw +-450 N at the
     * body) which collapses to a rounding error at 9 and below. 9 is taken
     * rather than 6 because it is the largest value that is quiet, so the tyre
     * stays as stiff as the model can carry. It is also physically the more
     * defensible end: a 35 mm bicycle tyre is a narrow, high-pressure, lightly
     * loaded contact patch, much closer to a car's normalised stiffness than to
     * a 200 mm superbike slick's.
     *
     * RATCHET: the real fix is in the integrator, not here — the low-speed
     * reference velocity `V_MIN` in `tyre.js` is a global 2.2 m/s regularisation
     * and the stability margin is proportional to it, so a per-tyre `vRef`
     * would let this class keep Bx 13. Lower this number if that lands; never
     * raise it to quiet a new class.
     */
    tyre: { ...TYRE_BIKE, Bx: 9.0, By: 8.0, muLong: 1.05, muLat: 0.98, relax: 0.16, fade: 0.05, rollRes: 0.006 },
    engine: {
      /**
       * A rider's whole body weight on one pedal: 78 kg x 9.81 x a 0.1725 m
       * crank = 132 N.m. 118 leaves him something to hold on with.
       */
      peakTorque: 118,
      /** 360 W sustained — a strong amateur. See `torqueFactor`'s `powerCap`. */
      powerCap: 360,
      peakRpm: 78, redline: 148, idle: 0,
      /** Cranks, chainring and two legs. Small, so cadence changes instantly. */
      inertia: 0.55, friction: 0.02, brakeTorque: 0.55,
    },
    gearbox: {
      // 40T chainring against an 11-speed 12-46T cassette, which is a real
      // modern 1x setup. `ratio` here is crank-per-wheel: below one in every
      // gear but the lowest, because the wheel turns faster than the pedals.
      gears: [-1.20, 0, 1.150, 0.925, 0.750, 0.600, 0.475, 0.375, 0.300],
      final: 1.0, eff: 0.96,
      // A derailleur does not disengage the drive the way a clutch does — you
      // keep pedalling through the shift — so the dead time is a tenth of a
      // second, not a car's quarter.
      shiftUp: 0.62, shiftDown: 0.36, shiftTime: 0.10,
      autoClutchRpm: 1,
      /**
       * You do not reverse a bicycle, you scoot it back with a foot down — but
       * `reverseMax` is not only a governor, it is also the speed BELOW which
       * `mapControls` will select reverse at all, and the width of the
       * governor's taper is a fixed 1.5 m/s. At 1.4 the entire reverse range
       * sat inside the taper, so it could only ever manage 0.52 m/s, and a
       * bicycle already sliding backwards down an icy 6 degree slope at
       * 1.49 m/s could not select reverse to stop itself at all — measured,
       * both. At 2.0 it could, but only after 203 frames of waiting for the
       * drift to decay below the cap, against a 120-frame bar.
       *
       * 2.6 is the Slagbolt's number, and a bicycle weighs 92 kg against its
       * 232: if you can walk a superbike back at 2.6 m/s you can certainly walk
       * a bicycle back at it.
       */
      reverseMax: 2.6,
    },
    diff: { lock: 1, preload: 0 },
    // Rim brakes: strong at the front, weak at the back, and no handbrake.
    brakes: { front: 460, rear: 210, handbrake: 210, bias: 0.70 },
    steer: {
      max: 0.78, speedFalloff: 0.86, falloffRef: 12, minFrac: 0.14,
      rate: 6.4, returnRate: 7.4, counterAssist: 0.30,
    },
    // Rider + bike CdA ~ 0.40 m^2 upright. This is what actually sets top speed.
    aero: { cd: 0.92, area: 0.44, downF: 0, downR: 0, yawDrag: 0.5 },
    body: { hp: 90, crumple: 2.2 },
    lean: { gain: 0.16, max: 0.55, rate: 8.5 },
    /** No tank, no gauge, no dry-tank cough. */
    nogas: true,
    /**
     * Shift out of the saddle. See the BOOST section: a flat 1.25 on top speed
     * is 1.25^3 = 1.95 on POWER for a drag-limited vehicle, so
     * 1.95 is what the legs are multiplied by and the 1.25 falls out of the
     * physics. 42 -> 82 N.m at 78 rpm is 343 W -> 669 W, which is a real
     * out-of-the-saddle effort and a real reason it only lasts 3.6 seconds.
     */
    boost: { kind: 'sprint', torque: 1.95 },
    paints: ['loud', 'common'],
    style: {
      shape: 'bike',
      pedal: true,
      /**
       * GROUND CLEARANCE IS THE KERB TEST, and it is not cosmetic.
       *
       * `groundY` is where `Vehicle`'s chassis collision probes put their lowest
       * point, so it decides whether a kerb catches the BODY or only the wheels.
       * Authored at 0.03 (the true lowest sweep of a pedal at bottom dead
       * centre) the bicycle wedged its probes into the face of a 15 cm kerb and
       * stopped dead against it at every angle and both speeds — it travelled
       * its 2.2 m run-up and rose nine millimetres. Swept, all seven kerb
       * assertions, `drivetest.mjs --type=bicycle`:
       *
       *   groundY  0.08  0.10  0.12  0.13  0.14  0.16  0.18
       *   kerb     1/7   2/7   7/7   7/7   7/7   6/7   6/7
       *
       * Above 0.16 the probes stop catching at all, `_unstick` never arms
       * because nothing reads as wedged, and the HIGH-CENTRED case starts
       * failing instead. 0.13 sits in the middle of the band and is also the
       * honest number for the part that actually snags: the chainring's lowest
       * tooth is at 0.177 and the bottom bracket shell at 0.27, while the pedal
       * that reaches 0.10 rotates out of the way rather than catching.
       */
      groundY: 0.13,
      roofY: 1.12,
      hwMax: 0.20,
      /** Bottom bracket height — the frame datum the drivetrain hangs on. */
      bbY: 0.27,
      seatY: 0.94, tankY: 0.72, tankZ: 0.02,
      barY: 1.00, barZ: 0.44, barW: 0.24,
      forkRake: 0.30,
      archF: { z: 0.53, r: 0.36, flare: 0 },
      archR: { z: -0.53, r: 0.36, flare: 0 },
      headlight: { w: 0.07, h: 0.06, y: 0.86, inset: 0, kind: 'round' },
      taillight: { w: 0.05, h: 0.04, y: 0.80, inset: 0, kind: 'bar' },
      exhaust: { n: 0, r: 0, x: 0, y: 0 },
      /** Chainring radius and crank length — real bicycle numbers, in metres. */
      chainring: 0.093, crank: 0.1725,
    },
  },

  /* -------------------------------------------------------- heli ---- */
  /**
   * THE RIVERHOP — a light piston helicopter, and the only flyable thing in the
   * game. See `heli.js` for the flight model; this block is its airframe.
   *
   * ────────────────────────────────────────────────────────────────────────
   * WHY THE MASS IS REAL AND THE CLIMB RATE IS NOT
   * ────────────────────────────────────────────────────────────────────────
   * An R44-class machine: 1250 kg at take-off, a 10 m two-blade rotor, ~168 kW
   * at the mast. Every one of those is real, because they are what decide how
   * the thing FEELS — the inertia of the disc is why a helicopter does not stop
   * when you let go, and the mass against the available thrust is why it sags
   * when you pull into a turn.
   *
   * The climb rate is NOT real. A real R44 climbs at 5 m/s, and against a
   * ceiling a couple of hundred metres up that is 40-odd seconds of climbing.
   * That is not a helicopter, it is a lift. `rotor.climbUp` is 12 m/s, which
   * reaches a 180 m ceiling in 15 s and is a rate real military types do make.
   *
   * The CEILING is 180 m above ground level, not above sea level, so it works
   * over Mt. Washington's 120 m rise as well as over the river. That is 60 m
   * clear of the tallest thing in the city.
   */
  heli: {
    id: 'heli',
    name: 'Riverhop',
    kind: 'heli',
    seats: 4,
    doors: 2,
    dims: { L: 9.0, W: 2.24, H: 3.05 },
    /** Fuselage length only; the rotor disc is 10 m and is not bodywork. */
    mass: 1250,
    comY: 1.16,
    comZ: 0.5,
    /** No axles. Present only so `finalizeSpec` can size an inertia tensor. */
    wheelbase: 2.6,
    trackF: 1.9, trackR: 1.9,
    wheel: { radius: 0.1, width: 0.08, rimFrac: 0.6, spokes: 4, style: 'steel' },
    drive: 'rwd',
    susp: { travel: 0.1, rideHeight: 0.1, freqF: 1, freqR: 1, dampF: 0.4, dampR: 0.4, reboundScale: 1, arbF: 0, arbR: 0, camberF: 0, camberR: 0, toeF: 0, toeR: 0 },
    tyre: { ...TYRE_ROAD },
    engine: {
      // A Lycoming IO-540 derating to 168 kW at the mast. The governor holds
      // the rotor at NR, so what the pilot commands is PITCH, not throttle —
      // this block exists for the audio profile and the start-up spool.
      peakTorque: 640, peakRpm: 2500, redline: 2800, idle: 700,
      inertia: 0.9, friction: 0.09, brakeTorque: 30,
    },
    gearbox: { gears: [-1, 0, 1], final: 1, eff: 0.95, shiftUp: 2, shiftDown: 0, shiftTime: 0.4, autoClutchRpm: 1000 },
    diff: { lock: 1, preload: 0 },
    brakes: { front: 0, rear: 0, handbrake: 0, bias: 0.5 },
    steer: { max: 1.0, speedFalloff: 0.0, rate: 3.0, returnRate: 3.4, counterAssist: 0 },
    // Equivalent flat-plate area of a light helicopter with skids, ~1.05 m^2.
    aero: { cd: 1.0, area: 1.05, downF: 0, downR: 0, yawDrag: 2.0 },
    body: { hp: 700, crumple: 1.4 },
    /** Rotorcraft parameters — consumed only by `heli.js`. */
    rotor: {
      /** Main disc radius, m, and nominal head speed, rad/s (400 rpm). */
      radius: 5.0,
      nominal: 41.9,
      /** Governor spool: seconds from rest to nominal, and back down. */
      spoolUp: 4.5, spoolDown: 9.0,
      /**
       * Maximum thrust as a multiple of weight. A real light helicopter has
       * about 1.15; 1.75 is the one arcade concession and it is what makes the
       * 12 m/s climb reachable and a hard turn survivable.
       */
      thrustMax: 1.75,
      /** Commanded climb/descent rates, m/s. See the header. */
      climbUp: 12.0, climbDown: 14.0,
      /** How hard the collective chases the commanded vertical speed, 1/s. */
      climbGain: 2.2,
      /** Height hold: metres of altitude error the hover corrects, per m/s. */
      holdGain: 0.85,
      /** Ceiling above ground level, m, and how far below it authority fades. */
      ceiling: 180, ceilingFade: 25,
      /** Maximum cyclic tilt, radians. 14 deg fore/aft, 22 deg of bank. */
      pitchMax: 0.245, rollMax: 0.38,
      /** Attitude PD, per unit of body inertia. */
      attStiff: 5.4, attDamp: 3.1,
      /** Pedal authority: commanded yaw rate, rad/s, and its PD. */
      yawRate: 1.15, yawStiff: 4.2, yawDamp: 2.6,
      /** Rotor-disc drag on top of the fuselage, N per (m/s)^2. */
      discDrag: 0.42,
      /** Translational lift: the disc gets more efficient in forward flight. */
      etlSpeed: 12.0, etlGain: 0.10,
      /** Skid gear: spring rate N/m, damping N/(m/s), and friction. */
      skidK: 165000, skidC: 26000, skidMu: 0.55,
      /** Blade tip speed the mesh spins at, and the tail rotor's ratio. */
      tailRatio: 5.2,
      /**
       * ALTITUDE ABOVE WHICH THE MACHINE STOPS BLOCKING PEOPLE ON FOOT.
       * See `Vehicle.blocksPeds`.
       */
      pedBlockAlt: 2.0,
    },
    /** Shift is the COLLECTIVE, not a bottle. See the BOOST section. */
    boost: { kind: 'collective', torque: 1 },
    paints: ['work', 'common'],
    style: {
      shape: 'heli',
      /**
       * The FUSELAGE floor, not the bottom of the skids. `Vehicle` puts its
       * chassis collision probes' lowest point exactly here, and the skids hang
       * below on their struts where the ray-based skid contact deals with them.
       * At 0.0 the probe ring's underside sat 2.5 cm off the ground with the
       * machine parked, which is a contact waiting to happen every time it
       * settles; 0.30 leaves the probes to the buildings, which is their job.
       */
      groundY: 0.30,
      roofY: 3.05,
      hwMax: 1.12,
      /** Cabin: a glazed pod ahead of the mast. */
      cabinZ0: -0.55, cabinZ1: 2.05,
      cabinY0: 0.62, cabinY1: 2.06,
      floorY: 0.62,
      noseZ: 2.30,
      /** Tail boom: a taper from the cabin's rear bulkhead to the fin. */
      boomZ0: -0.60, boomZ1: -4.55,
      boomR0: 0.30, boomR1: 0.135, boomY: 1.62,
      finY: 2.28, finZ: -4.32, finChord: 0.62,
      stabW: 0.62, stabZ: -3.65, stabY: 1.62,
      /** Mast and hub. */
      mastY0: 2.02, mastY1: 2.52, mastR: 0.085,
      hubY: 2.56,
      blades: 2, bladeChord: 0.26, bladeThick: 0.045,
      /** Tail rotor: on the LEFT of the fin, turning about x. */
      tailR: 0.85, tailX: -0.16, tailY: 2.10, tailZ: -4.42, tailBlades: 2,
      /** Skids: two tubes on four struts. */
      skidX: 0.86, skidZ0: -1.45, skidZ1: 1.35, skidY: 0.03, skidR: 0.055,
      headlight: { w: 0.13, h: 0.11, y: 0.72, inset: 0, kind: 'round' },
      taillight: { w: 0.08, h: 0.08, y: 2.32, inset: 0, kind: 'round' },
    },
  },

  /* ----------------------------------------------------- newsheli ---- */
  /**
   * THE SKYWATCH 6 — a civilian news/tour helicopter, the second rotorcraft.
   *
   * Same flight model as the Riverhop (`kind: 'heli'`, stepped by `heli.js` —
   * nothing here is a new controller), different MACHINE. A turbine tour ship
   * against the Riverhop's light piston trainer:
   *
   *   - HEAVIER (1450 vs 1250 kg) with MORE excess power (`thrustMax` 1.9 vs
   *     1.75) and a faster commanded climb: `climbUp` 15.5 vs 12.0 m/s. The
   *     news machine's whole job is to get camera height NOW, and the climb is
   *     the character difference a pilot feels first. `flightprobe` measures
   *     both machines on the same 14 s of collective and asserts the EMITTED
   *     altitude gap, with a negative control that swaps this rotor block for
   *     the Riverhop's and watches the gap collapse.
   *   - SLOWER over the ground: `discDrag` 0.55 vs 0.42 — a camera ball, a
   *     skid-mounted antenna farm and a fat cabin are draggy — so it cruises
   *     under the Riverhop while out-climbing it. Two variants, two orderings,
   *     no dominance.
   *   - BIGGER: a 10.4 m fuselage on a longer boom, a taller glazed cabin for
   *     the camera crew, a 5.5 m four-blade disc turning slower. The length and
   *     the disc are both asserted from the EMITTED geometry against the
   *     Riverhop's.
   *
   * Broadcast livery (`newscopter` pool) — white / channel blue / action
   * yellow — where the Riverhop wears fleet `work`/`common` greys.
   */
  newsheli: {
    id: 'newsheli',
    name: 'Skywatch 6',
    kind: 'heli',
    seats: 4,
    doors: 2,
    dims: { L: 10.4, W: 2.4, H: 3.35 },
    /** Fuselage length only; the 11 m rotor disc is not bodywork. */
    mass: 1450,
    comY: 1.20,
    comZ: 0.5,
    /** No axles. Present only so `finalizeSpec` can size an inertia tensor. */
    wheelbase: 2.8,
    trackF: 2.0, trackR: 2.0,
    wheel: { radius: 0.1, width: 0.08, rimFrac: 0.6, spokes: 4, style: 'steel' },
    drive: 'rwd',
    susp: { travel: 0.1, rideHeight: 0.1, freqF: 1, freqR: 1, dampF: 0.4, dampR: 0.4, reboundScale: 1, arbF: 0, arbR: 0, camberF: 0, camberR: 0, toeF: 0, toeR: 0 },
    tyre: { ...TYRE_ROAD },
    engine: {
      // A light turboshaft at the mast: smoother idle, higher torque. Audio
      // profile and spool only — the governor holds NR, the pilot commands pitch.
      peakTorque: 760, peakRpm: 2400, redline: 2700, idle: 700,
      inertia: 1.0, friction: 0.09, brakeTorque: 30,
    },
    gearbox: { gears: [-1, 0, 1], final: 1, eff: 0.95, shiftUp: 2, shiftDown: 0, shiftTime: 0.4, autoClutchRpm: 1000 },
    diff: { lock: 1, preload: 0 },
    brakes: { front: 0, rear: 0, handbrake: 0, bias: 0.5 },
    steer: { max: 1.0, speedFalloff: 0.0, rate: 3.0, returnRate: 3.4, counterAssist: 0 },
    // Fatter cabin, camera ball, antenna farm: more flat plate than the trainer.
    aero: { cd: 1.0, area: 1.25, downF: 0, downR: 0, yawDrag: 2.2 },
    body: { hp: 760, crumple: 1.4 },
    /** Rotorcraft parameters — consumed only by `heli.js`. */
    rotor: {
      /** A bigger, slower four-blade disc: 5.5 m at ~382 rpm. */
      radius: 5.5,
      nominal: 40.0,
      spoolUp: 4.0, spoolDown: 9.0,
      /** More excess power than the trainer — see the header. */
      thrustMax: 1.9,
      /** THE variant number: it out-climbs the Riverhop by a quarter. */
      climbUp: 15.5, climbDown: 15.0,
      climbGain: 2.6,
      holdGain: 0.9,
      ceiling: 200, ceilingFade: 25,
      pitchMax: 0.235, rollMax: 0.36,
      attStiff: 5.8, attDamp: 3.2,
      yawRate: 1.25, yawStiff: 4.4, yawDamp: 2.6,
      /** The other variant number: draggier, so it cruises slower. */
      discDrag: 0.55,
      etlSpeed: 12.0, etlGain: 0.10,
      skidK: 175000, skidC: 28000, skidMu: 0.55,
      tailRatio: 5.0,
      pedBlockAlt: 2.0,
    },
    /** Shift is the COLLECTIVE, exactly as the Riverhop. */
    boost: { kind: 'collective', torque: 1 },
    paints: ['newscopter'],
    style: {
      shape: 'heli',
      groundY: 0.30,
      roofY: 3.35,
      hwMax: 1.18,
      /** A longer, taller glazed cabin — the camera crew sits behind the pilots. */
      cabinZ0: -0.85, cabinZ1: 2.25,
      cabinY0: 0.60, cabinY1: 2.18,
      floorY: 0.60,
      noseZ: 2.62,
      /** The long boom: a metre more tail than the Riverhop. */
      boomZ0: -0.90, boomZ1: -5.55,
      boomR0: 0.34, boomR1: 0.15, boomY: 1.70,
      finY: 2.52, finZ: -5.30, finChord: 0.68,
      stabW: 0.70, stabZ: -4.45, stabY: 1.70,
      mastY0: 2.14, mastY1: 2.66, mastR: 0.09,
      hubY: 2.70,
      blades: 4, bladeChord: 0.22, bladeThick: 0.04,
      tailR: 0.92, tailX: -0.17, tailY: 2.20, tailZ: -5.40, tailBlades: 2,
      skidX: 0.92, skidZ0: -1.55, skidZ1: 1.55, skidY: 0.03, skidR: 0.055,
      headlight: { w: 0.13, h: 0.11, y: 0.72, inset: 0, kind: 'round' },
      taillight: { w: 0.08, h: 0.08, y: 2.55, inset: 0, kind: 'round' },
    },
  },

  /* -------------------------------------------------------- plane ---- */
  /**
   * THE SKYLARK — a light single-engine fixed-wing aircraft, and the second
   * flyable thing in the game. See `plane.js` for the flight model; this block
   * is its airframe and its aerodynamic constants.
   *
   * ────────────────────────────────────────────────────────────────────────
   * WHY IT MUST BUILD SPEED ON A RUNWAY
   * ────────────────────────────────────────────────────────────────────────
   * Unlike the helicopter, an aeroplane makes NO lift standing still: lift goes
   * as the square of airspeed (`plane.js` step 2), so the whole character of it
   * — roll down the runway on the throttle, rotate at flying speed, and sink
   * again the moment you drop below it — is emergent from `q = ½ρV²`, not
   * scripted. The numbers below are chosen so it un-sticks at a believable
   * light-aircraft speed and tops out around 65 m/s, held there by prop-thrust
   * falling off with airspeed rather than by any clamp.
   *
   *   wing:  16 m^2, CL0 0.42, so at the wing's own incidence it holds its
   *          weight up at ~52 m/s straight-and-level and ~30 m/s with the nose
   *          rotated up; it stalls (max CL) at ~28 m/s.
   *   thrust: strong static thrust for a short take-off roll, decaying to zero
   *          near 92 m/s so there is a natural top speed.
   */
  plane: {
    id: 'plane',
    name: 'Skylark',
    kind: 'plane',
    seats: 2,
    doors: 2,
    dims: { L: 8.2, W: 11.4, H: 2.7 },
    /** Fuselage/tail box only; the wing span is bodywork the collision box owns. */
    mass: 1150,
    comY: 1.05,
    comZ: 0.5,
    /** No real axles; present only so `finalizeSpec` can size an inertia tensor. */
    wheelbase: 2.75,
    trackF: 2.2, trackR: 2.2,
    wheel: { radius: 0.30, width: 0.14, rimFrac: 0.55, spokes: 5, style: 'steel' },
    drive: 'fwd',
    susp: { travel: 0.1, rideHeight: 0.1, freqF: 1, freqR: 1, dampF: 0.4, dampR: 0.4, reboundScale: 1, arbF: 0, arbR: 0, camberF: 0, camberR: 0, toeF: 0, toeR: 0 },
    tyre: { ...TYRE_ROAD },
    engine: {
      // A ~150 kW flat-four. The governor/audio profile only; the prop turns
      // this into thrust in `plane.js`.
      peakTorque: 520, peakRpm: 2500, redline: 2800, idle: 780,
      inertia: 0.8, friction: 0.09, brakeTorque: 30,
    },
    gearbox: { gears: [-1, 0, 1], final: 1, eff: 0.95, shiftUp: 2, shiftDown: 0, shiftTime: 0.4, autoClutchRpm: 1000 },
    diff: { lock: 1, preload: 0 },
    brakes: { front: 0, rear: 0, handbrake: 0, bias: 0.5 },
    steer: { max: 1.0, speedFalloff: 0.0, rate: 3.0, returnRate: 3.4, counterAssist: 0 },
    /**
     * `_aero`'s fuselage drag is deliberately small: `plane.js` owns the real
     * parasitic and induced drag (applied at the CoM, so it makes no spurious
     * pitching moment). `yawDrag` still buys a little directional damping.
     */
    aero: { cd: 0.02, area: 2.0, downF: 0, downR: 0, yawDrag: 3.0 },
    body: { hp: 620, crumple: 1.4 },
    /** Fixed-wing parameters — consumed only by `plane.js`. */
    flight: {
      /** Full-throttle static thrust, N, and the pitch speed it decays to, m/s. */
      maxThrust: 5200, propVmax: 92,
      /** Seconds to run the throttle lever from idle to full (and prop spool). */
      throttleRate: 2.2, propSpool: 2.4,
      /** Wing: area m^2, lift-curve slope /rad, camber offset, and stall angle. */
      wingArea: 16.0, CL0: 0.42, CLalpha: 5.4, aoaStall: 0.28, CLmax: 1.5,
      /** Built-in incidence/trim, rad — a touch of nose-up so it climbs off. */
      aoaTrim: 0.05,
      /** Span m and Oswald efficiency, for induced drag; parasitic drag coeff. */
      span: 11.4, oswald: 0.8, CD0: 0.030,
      /** Reference airspeed the control gains are quoted at, m/s. */
      Vref: 30,
      /**
       * Control authorities are ANGULAR ACCELERATIONS (rad/s^2) scaled by
       * dynamic pressure. Against the rate-damping term they set a steady
       * control RATE of roughly `auth * dyn / damp` — tuned here to a snappy but
       * flyable ~0.6 rad/s in pitch and ~1.0 rad/s in roll, not the 3 rad/s that
       * flips the aircraft on a key tap.
       */
      pitchElev: 0.9, pitchStab: 1.6, pitchDamp: 2.8,
      /** Roll: aileron authority, wing-levelling, rate damping. */
      rollAuth: 1.3, rollStab: 0.4, rollDamp: 2.6,
      /** Yaw: weathercock stability, rate damping, coordinating rudder. */
      yawStab: 1.9, yawDamp: 1.7, rudder: 0.5,
      /** Nosewheel steering authority on the ground. */
      groundSteer: 1.1,
      /** Gear: spring N/m, damping N/(m/s); rolling / braking / lateral friction. */
      gearK: 240000, gearC: 26000, muRoll: 0.03, muBrake: 0.7, muLat: 0.9,
      /** Altitude above which the aircraft stops blocking people on foot, m. */
      pedBlockAlt: 2.0,
    },
    /** SHIFT winds the throttle lever up, SPACE winds it down. See `plane.js`. */
    boost: { kind: 'throttle', torque: 1 },
    paints: ['work', 'common'],
    style: {
      shape: 'plane',
      /** Belly (lowest fuselage) and fin top — sized the collision probe ring. */
      groundY: 0.9,
      roofY: 2.7,
      /** Fuselage: a tapered tube along the centreline. */
      hwMax: 0.62,
      fuseZ0: -3.7, fuseZ1: 3.3, fuseY: 1.18, fuseR: 0.60, noseZ: 3.5,
      /** Cabin glazing. */
      cabinZ0: 1.1, cabinZ1: 2.9, cabinY0: 1.2, cabinY1: 2.02, floorY: 1.0,
      /**
       * SEATING FIELDS. `VehicleSystem.seatAnchor` has no plane branch — a
       * fixed-wing cockpit is a car cabin as far as a seated body is concerned,
       * so it takes the generic path, and that path reads `sillY`, `beltY` and
       * `cowlZ`. Without them the anchor arithmetic is NaN and the boarding
       * animation aims at nothing. Chosen so the seat pan lands on `floorY`
       * and the head sits inside the canopy bubble; `flightprobe` asserts the
       * emitted anchor is finite and inside the cabin for every aircraft.
       */
      sillY: 0.26, beltY: 1.30, cowlZ: 2.55,
      /** High wing, with a lift strut each side. */
      wingY: 2.02, wingZ: 1.5, wingSpan: 11.4, wingChord: 1.7, wingThick: 0.22,
      /** Empennage. */
      finZ: -3.35, finY0: 1.4, finY1: 2.66, finChord: 1.2,
      stabZ: -3.25, stabSpan: 3.9, stabChord: 0.9,
      /** Tricycle gear: nose forward, two mains aft. Wheels rest at `gearY`. */
      gearNoseZ: 2.35, gearMainZ: -0.25, gearX: 1.5, gearWheelR: 0.30, gearY: 0.0,
      /** Propeller on the nose, turning about z. */
      propZ: 3.62, propR: 0.95, propBlades: 2,
      headlight: { w: 0.12, h: 0.10, y: 1.1, inset: 0, kind: 'round' },
      taillight: { w: 0.08, h: 0.08, y: 2.5, inset: 0, kind: 'round' },
    },
  },

  /* --------------------------------------------------- sportplane ---- */
  /**
   * THE SLIPSTREAM — a low-wing sport plane, the second fixed-wing.
   *
   * Same flight model as the Skylark (`kind: 'plane'`, stepped by `plane.js`),
   * different AEROPLANE — the club racer against the trainer:
   *
   *   - FASTER. Lighter (950 vs 1150 kg), cleaner (`CD0` 0.024 vs 0.030), more
   *     static thrust (6400 vs 5200 N) and a prop pitched for speed (`propVmax`
   *     122 vs 92 m/s), on a smaller wing (11.0 vs 16.0 m^2). The smaller wing
   *     is what makes the whole machine faster rather than just more powerful:
   *     less area is less parasitic drag at cruise AND a higher flying speed,
   *     so it uses the speed it has. `flightprobe` flies both on the same
   *     seconds of throttle and asserts the EMITTED airspeed gap, with a
   *     negative control that swaps in the Skylark's flight/aero blocks under
   *     this silhouette and watches the gap collapse.
   *   - TWITCHIER. `rollAuth` 2.3 vs 1.3 and less wing-levelling (`rollStab`
   *     0.32 vs 0.40): it banks near twice as far on the same second of
   *     aileron, measured on the emitted attitude.
   *   - LOW-WING. The one-glance silhouette difference: the wing sits under
   *     the fuselage (`wingY` 0.82 against a 1.06 m fuselage centreline) with
   *     no lift struts — `plane.js` builds struts only for a high wing — a
   *     shorter span (8.6 vs 11.4 m), a bubble canopy and a three-blade prop.
   *   - Club racing colours (`sportair` pool) where the Skylark wears
   *     `work`/`common` fleet greys.
   */
  sportplane: {
    id: 'sportplane',
    name: 'Slipstream',
    kind: 'plane',
    seats: 2,
    doors: 2,
    dims: { L: 7.4, W: 8.6, H: 2.45 },
    /** Fuselage/tail box only; the span is bodywork the collision box owns. */
    mass: 950,
    comY: 0.95,
    comZ: 0.5,
    /** No real axles; present only so `finalizeSpec` can size an inertia tensor. */
    wheelbase: 2.3,
    trackF: 2.0, trackR: 2.0,
    wheel: { radius: 0.26, width: 0.13, rimFrac: 0.55, spokes: 5, style: 'steel' },
    drive: 'fwd',
    susp: { travel: 0.1, rideHeight: 0.1, freqF: 1, freqR: 1, dampF: 0.4, dampR: 0.4, reboundScale: 1, arbF: 0, arbR: 0, camberF: 0, camberR: 0, toeF: 0, toeR: 0 },
    tyre: { ...TYRE_ROAD },
    engine: {
      // A ~200 kW six behind a tight cowl. Audio/spool profile only; the prop
      // turns this into thrust in `plane.js`.
      peakTorque: 600, peakRpm: 2700, redline: 3000, idle: 800,
      inertia: 0.7, friction: 0.09, brakeTorque: 30,
    },
    gearbox: { gears: [-1, 0, 1], final: 1, eff: 0.95, shiftUp: 2, shiftDown: 0, shiftTime: 0.4, autoClutchRpm: 1000 },
    diff: { lock: 1, preload: 0 },
    brakes: { front: 0, rear: 0, handbrake: 0, bias: 0.5 },
    steer: { max: 1.0, speedFalloff: 0.0, rate: 3.0, returnRate: 3.4, counterAssist: 0 },
    /** `plane.js` owns the real drag; a slick fuselage leaves little here. */
    aero: { cd: 0.018, area: 1.6, downF: 0, downR: 0, yawDrag: 2.6 },
    body: { hp: 560, crumple: 1.4 },
    /** Fixed-wing parameters — consumed only by `plane.js`. */
    flight: {
      /** More static thrust, and a prop pitched for 122 m/s, not 92. */
      maxThrust: 6400, propVmax: 122,
      throttleRate: 1.8, propSpool: 2.0,
      /** The small wing: a higher flying speed and less area to drag around. */
      wingArea: 11.0, CL0: 0.30, CLalpha: 5.6, aoaStall: 0.30, CLmax: 1.45,
      aoaTrim: 0.05,
      span: 8.6, oswald: 0.82, CD0: 0.024,
      Vref: 36,
      pitchElev: 1.25, pitchStab: 1.55, pitchDamp: 2.5,
      /** The twitch: near twice the Skylark's aileron, less self-levelling. */
      rollAuth: 2.3, rollStab: 0.32, rollDamp: 2.3,
      yawStab: 1.85, yawDamp: 1.65, rudder: 0.55,
      groundSteer: 1.2,
      gearK: 220000, gearC: 24000, muRoll: 0.03, muBrake: 0.75, muLat: 0.9,
      pedBlockAlt: 2.0,
    },
    /** SHIFT winds the throttle lever up, SPACE winds it down. See `plane.js`. */
    boost: { kind: 'throttle', torque: 1 },
    paints: ['sportair'],
    style: {
      shape: 'plane',
      /** Belly and fin top — the collision probe ring. */
      groundY: 0.72,
      roofY: 2.45,
      /** A slimmer fuselage than the trainer's. */
      hwMax: 0.56,
      fuseZ0: -3.30, fuseZ1: 2.95, fuseY: 1.06, fuseR: 0.52, noseZ: 3.12,
      /** Bubble canopy over a two-seat cockpit. */
      cabinZ0: 0.30, cabinZ1: 2.05, cabinY0: 1.06, cabinY1: 1.82, floorY: 0.90,
      /** Seating fields for the generic `seatAnchor` path — see the Skylark. */
      sillY: 0.31, beltY: 1.18, cowlZ: 1.95,
      /**
       * THE LOW WING. Below the fuselage centreline (`fuseY` 1.06), so
       * `plane.js` builds no lift struts; the silhouette difference from the
       * high-wing Skylark is asserted from the emitted geometry.
       */
      wingY: 0.82, wingZ: 0.9, wingSpan: 8.6, wingChord: 1.45, wingThick: 0.19,
      finZ: -3.02, finY0: 1.25, finY1: 2.40, finChord: 1.00,
      stabZ: -2.92, stabSpan: 3.2, stabChord: 0.80,
      /** Tricycle gear, shorter legs than the trainer. */
      gearNoseZ: 2.05, gearMainZ: -0.35, gearX: 1.35, gearWheelR: 0.26, gearY: 0.0,
      /** Three-blade prop on the nose. */
      propZ: 3.24, propR: 0.88, propBlades: 3,
      headlight: { w: 0.11, h: 0.10, y: 1.0, inset: 0, kind: 'round' },
      taillight: { w: 0.07, h: 0.07, y: 2.28, inset: 0, kind: 'round' },
    },
  },

  /* ------------------------------------------------------ pickup ---- */
  /**
   * ──────────────────────────────────────────────────────────────────────
   * THE STEELBED — AIDAN'S CAR. A COMPACT PICKUP, cab + open bed.
   * ──────────────────────────────────────────────────────────────────────
   * The player supplied a red single-cab Ford Ranger: a two-door cab, an open
   * cargo BED behind it, a tall upright grille and a higher stance than a car.
   * None of that body existed — the fleet had a car, a van and a 7.2 m flatbed
   * lorry, and nothing with a separate bed box at compact scale.
   *
   * It is built on `shape: 'truck'`, which already knows how to run a cab
   * greenhouse forward and drop the roofline behind it — the same station code
   * that gives the Millhand its cab-over-flatbed break. The difference is TWO
   * numbers and one builder:
   *
   *   - `tailY` is LOW (0.99, against the Millhand's 1.30 and the cab roof's
   *     1.79). So behind the rear cab window the lofted body settles to a low
   *     flat deck — the bed FLOOR — and the silhouette steps down from the cab
   *     roof to that floor. `shapeprobe` measures exactly that step.
   *   - `bed: true` builds a real pickup bed on top of the floor (see
   *     `pickupBed` in body.js): two smooth side walls with a capping rail, a
   *     front bulkhead against the cab and a drop tailgate — NOT the Millhand's
   *     stake posts, which read as a farm lorry.
   *
   * Red, and only red (`rangerred`). Aidan's accent (`#ffc93c`, amber) is the
   * caliper. Dynamics sit between the van and the truck: 2.0 t, RWD, a torquey
   * six that will still climb a Pittsburgh grade with a load in the back.
   */
  pickup: {
    id: 'pickup',
    name: 'Steelbed',
    kind: 'car',
    seats: 2,
    doors: 2,
    dims: { L: 5.30, W: 2.16, H: 1.82 },
    mass: 2050,
    comY: 0.66,
    /** A pickup carries its mass forward empty; 44% on the rear axle. */
    comZ: 0.44,
    wheelbase: 3.20,
    trackF: 1.70, trackR: 1.68,
    /** Aidan's accent (`#ffc93c`, amber) on the calipers. See `build.js`. */
    wheel: { radius: 0.40, width: 0.27, rimFrac: 0.58, spokes: 6, style: 'split', caliper: 0xffc93c },
    drive: 'rwd',
    susp: {
      travel: 0.24, rideHeight: 0.20,
      freqF: 1.55, freqR: 1.70,
      dampF: 0.36, dampR: 0.32,
      reboundScale: 1.4,
      arbF: 15000, arbR: 6000,
      camberF: -0.008, camberR: 0,
      toeF: 0.002, toeR: 0.002,
    },
    tyre: { ...TYRE_ROAD, muLong: 1.26, muLat: 1.18, relax: 0.54, loadSens: 0.11 },
    engine: {
      // 3.5 V6, ~300 lb-ft. Enough to launch a loaded bed on a 20 deg street.
      peakTorque: 560, peakRpm: 3200, redline: 5400, idle: 720,
      inertia: 0.5, friction: 0.07, brakeTorque: 56,
    },
    gearbox: {
      // A deep reverse (like the van's) so it will still back UP a dirt bank —
      // reversing a nose-down slope unloads the driven rear axle, so it needs
      // the ratio. See `testReverse`.
      gears: [-4.1, 0, 3.85, 2.30, 1.55, 1.15, 0.90],
      final: 3.90, eff: 0.88,
      shiftUp: 0.86, shiftDown: 0.42, shiftTime: 0.34,
      autoClutchRpm: 1100,
    },
    diff: { lock: 0.35, preload: 80 },
    brakes: { front: 3200, rear: 2100, handbrake: 2600, bias: 0.6 },
    steer: { max: 0.48, speedFalloff: 0.68, rate: 3.1, returnRate: 4.0, counterAssist: 0.26 },
    aero: { cd: 0.46, area: 3.1, downF: 0, downR: 0, yawDrag: 5.0 },
    body: { hp: 1300, crumple: 0.9 },
    paints: ['rangerred'],
    style: {
      shape: 'truck',
      groundY: 0.20,
      roofY: 1.79,
      beltY: 1.10,
      sillY: 0.56,
      shoulderY: 0.98,
      hwMax: 1.08,
      noseY: 1.16, noseHw: 1.05, noseZ: 2.92,
      /**
       * THE BED FLOOR. `tailY` is where the lofted top settles behind the cab —
       * a low flat deck. The cab roof is 0.80 m above it, which is the step the
       * eye (and `shapeprobe`) reads as "that is a pickup, not a wagon".
       */
      tailY: 0.99, tailHw: 1.06, tailZ: -3.02,
      cowlZ: 1.66, cowlY: 1.30,
      /** A short, upright cab: header just behind the cowl, quick backlight. */
      windscreenTopZ: 1.00, roofRearZ: 0.44,
      backlightBaseZ: 0.18,
      greenhouseInset: 0.07, greenhouseTaper: 0.05,
      pillarA: 0.11, pillarB: 0.0, pillarC: 0.12,
      archF: { z: 1.66, r: 0.52, flare: 0.05 },
      archR: { z: -1.66, r: 0.54, flare: 0.055 },
      crownDeck: 0.02, crownRoof: 0.05, crownBonnet: 0.04,
      creaseY: 0.86, creaseDepth: 0.02,
      bumperDrop: 0.20, splitter: 0, diffuser: 0,
      bumperF: 0.18, bumperR: 0.20,
      grille: { w: 1.22, hf: 0.34, yf: 0.62, kind: 'egg' },
      headlight: { w: 0.32, h: 0.22, yf: 0.74, inset: 0.20, kind: 'wrap' },
      taillight: { w: 0.20, h: 0.34, yf: 0.52, inset: 0.14, kind: 'vertical' },
      exhaust: { n: 1, r: 0.05, x: 0.6, y: 0.30 },
      mirror: { z: 1.50, y: 1.34, x: 1.16, size: 0.18, arm: 0.20 },
      spoiler: 'none',
      /** The bed. See `pickupBed` in body.js — smooth walls, a rail, a tailgate. */
      bed: { wallH: 0.40, frontZ: 0.02 },
      // One shutline: a single-cab door runs from it to the A-pillar.
      doorSplit: [1.42],
      // No side glass behind the cab — the bed is open.
      sideWindowEnd: 0.60,
    },
  },

  /* --------------------------------------------------------- suv ---- */
  /**
   * ──────────────────────────────────────────────────────────────────────
   * THE OVERLOOK — CARSON'S CAR. A BOXY BODY-ON-FRAME SUV.
   * ──────────────────────────────────────────────────────────────────────
   * The player supplied a white Toyota 4Runner: a tall two-box wagon, a
   * near-vertical windscreen and tailgate, a long flat roof with rails, a big
   * upright grille, chunky arches and a raised stance. The van is the only tall
   * class in the fleet and it is the wrong tall — a one-box panel van with a
   * windowless cargo box, no hood and no rear glass.
   *
   * So the SUV is a TWO-BOX, and it is built on the ordinary car station path
   * (not `boxBody`), which gives a real hood and a full greenhouse for free. The
   * SUV-ness is three authored facts, no new station code:
   *
   *   - the roof stays flat at `roofY` from the header nearly to the tail
   *     (`roofRearZ` -2.05, against the sedan's -1.05) — a long boxy roof, not a
   *     roof that falls to a boot.
   *   - `tailY` is low (1.34) with `roofRearZ`/`backlightBaseZ` close together, so
   *     the roof-to-tail drop is a short, near-vertical backlight over a vertical
   *     tailgate rather than a raked fastback sweep.
   *   - `roofRails: true` lays two rails down the roof edges (see body.js), the
   *     detail nobody names but everybody reads as "SUV".
   *
   * White, and only white (`runnerwhite`). Carson's accent (`#7bf0d8`, teal) is
   * the caliper. Dynamics: 2.2 t, RWD, tall CoM, soft long-travel springs and
   * anti-roll bars deliberately left a little soft so it leans like a truck.
   */
  suv: {
    id: 'suv',
    name: 'Overlook',
    kind: 'car',
    seats: 4,
    doors: 4,
    dims: { L: 4.98, W: 2.14, H: 1.93 },
    mass: 2200,
    comY: 0.72,
    /**
     * 42% on the front axle — rear-biased for RWD traction, like the van. A
     * short-wheelbase SUV transfers a lot of weight off the driven rear when it
     * reverses UP a bank, so it needs the static rear load to climb one at all.
     */
    comZ: 0.42,
    wheelbase: 2.88,
    trackF: 1.68, trackR: 1.68,
    /** Carson's accent (`#7bf0d8`, teal) on the calipers. See `build.js`. */
    wheel: { radius: 0.40, width: 0.26, rimFrac: 0.58, spokes: 6, style: 'split', caliper: 0x7bf0d8 },
    drive: 'rwd',
    susp: {
      travel: 0.24, rideHeight: 0.20,
      freqF: 1.45, freqR: 1.55,
      dampF: 0.36, dampR: 0.34,
      reboundScale: 1.4,
      arbF: 13000, arbR: 7000,
      camberF: -0.006, camberR: 0,
      toeF: 0.0015, toeR: 0.0015,
    },
    tyre: { ...TYRE_ROAD, muLong: 1.28, muLat: 1.20, relax: 0.52, loadSens: 0.11 },
    engine: {
      // 4.0 V6, ~270 hp. A body-on-frame six, not a hot motor.
      peakTorque: 600, peakRpm: 3600, redline: 5600, idle: 720,
      inertia: 0.5, friction: 0.07, brakeTorque: 56,
    },
    gearbox: {
      // A deep reverse (like the van's) so it will still back UP a dirt bank.
      gears: [-4.1, 0, 3.55, 2.10, 1.45, 1.12, 0.88],
      final: 3.90, eff: 0.88,
      shiftUp: 0.86, shiftDown: 0.42, shiftTime: 0.34,
      autoClutchRpm: 1150,
    },
    diff: { lock: 0.3, preload: 60 },
    brakes: { front: 3200, rear: 2100, handbrake: 2600, bias: 0.58 },
    steer: { max: 0.5, speedFalloff: 0.66, rate: 3.2, returnRate: 4.2, counterAssist: 0.28 },
    aero: { cd: 0.44, area: 3.4, downF: 0, downR: 0, yawDrag: 5.5 },
    body: { hp: 1350, crumple: 0.9 },
    paints: ['runnerwhite'],
    style: {
      shape: 'suv',
      groundY: 0.20,
      roofY: 1.92,
      beltY: 1.04,
      sillY: 0.52,
      shoulderY: 0.92,
      hwMax: 1.07,
      noseY: 1.08, noseHw: 1.02, noseZ: 2.44,
      /**
       * A LOW, HIGH TAIL. `tailY` 1.34 is the top of the tailgate; the roof is
       * 0.58 m above it and `roofRearZ`/`backlightBaseZ` are only 0.23 m apart in
       * z, so the drop is a near-vertical rear — a tailgate, not a fastback.
       */
      tailY: 1.34, tailHw: 1.03, tailZ: -2.46,
      cowlZ: 1.16, cowlY: 1.14,
      /** A near-vertical windscreen: 0.50 m of run for 0.78 m of rise. */
      windscreenTopZ: 0.66, roofRearZ: -2.05,
      backlightBaseZ: -2.28,
      // Boxy: little tumblehome, little roof taper, a nearly flat roof crown.
      greenhouseInset: 0.075, greenhouseTaper: 0.045,
      pillarA: 0.10, pillarB: 0.08, pillarC: 0.13,
      archF: { z: 1.44, r: 0.50, flare: 0.052 },
      archR: { z: -1.44, r: 0.52, flare: 0.056 },
      crownDeck: 0.03, crownRoof: 0.045, crownBonnet: 0.05,
      creaseY: 0.78, creaseDepth: 0.016,
      bumperDrop: 0.16, splitter: 0, diffuser: 0,
      bumperF: 0.22, bumperR: 0.22,
      grille: { w: 1.16, hf: 0.30, yf: 0.56, kind: 'egg' },
      headlight: { w: 0.34, h: 0.20, yf: 0.72, inset: 0.22, kind: 'wrap' },
      taillight: { w: 0.20, h: 0.44, yf: 0.56, inset: 0.16, kind: 'vertical' },
      exhaust: { n: 1, r: 0.05, x: 0.5, y: 0.30 },
      mirror: { z: 1.02, y: 1.20, x: 1.12, size: 0.15, arm: 0.14 },
      spoiler: 'none',
      /** Two rails down the roof edges. See `roofRails` in body.js. */
      roofRails: true,
      doorSplit: [1.00, -0.18, -1.12],
      sideWindowEnd: -1.96,
    },
  },
};

/* ------------------------------------------------------------------ */
/* BOOST — what the SPRINT control does, per class                     */
/* ------------------------------------------------------------------ */

/**
 * ────────────────────────────────────────────────────────────────────────────
 * SHIFT IN A VEHICLE. ONE CONTROL, FOUR MEANINGS, AND THE CHANNEL WAS DEAD.
 * ────────────────────────────────────────────────────────────────────────────
 * `src/player/tuning.js` documents nitro as a shipped feature on the sprint
 * control, `player/vehicle.js` drains a bottle and writes `boost` into
 * `vehicles.setInput`, and `VehicleSystem.setInput` stores it on `v.input.boost`
 * — where NOTHING EVER READ IT. Grep the directory before this pass and
 * `boost` appears exactly twice: once being declared and once being assigned.
 * A player holding Shift in a car got a HUD gauge that emptied and no thrust.
 *
 * That had to be fixed here anyway, because the bicycle's whole character is
 * its sprint, and the question of whether a bicycle's run-boost should share
 * the nitro channel has one right answer: YES, THE CONTROL, NO, THE MECHANIC.
 *
 *   - the CONTROL is the same. One held key branches on the vehicle: nitro for
 *     a car, a 1.25 run-boost for a bike, ascend for the helicopter. Giving a
 *     bicycle its own key would be a second sprint key on a keyboard that
 *     already has one, and CONTROLS.md's whole thesis is that playability
 *     depends on not doing that.
 *   - the MECHANIC differs, because a bicycle has no bottle. The player's
 *     nitro meter (drain 28/s, charge 5/s — 3.6 s of boost, 20 s to recover) is
 *     an excellent STAMINA meter for a rider out of the saddle, and it needs no
 *     change at all in `player/`: only the HUD label is wrong.
 *
 * So `boost` is a per-class block and `vehicles` decides what the channel MEANS:
 *
 *   nitro       cars, and the cruiser. Extra engine torque plus a small
 *               longitudinal shove.
 *   sprint      two-wheelers. Torque only, a flat 1.25.
 *   collective  the helicopter. Shift is the COLLECTIVE — it climbs. Handled
 *               entirely in `heli.js`; the torque/thrust fields are inert.
 *   (none)      the boat, which is excluded: an outboard has no second setting.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY BOOST IS ENGINE TORQUE AND NOTHING ELSE. MEASURED.
 * ────────────────────────────────────────────────────────────────────────────
 * The first cut of this had two terms: a torque multiplier and a small
 * longitudinal shove, sized as a fraction of weight so it would be felt at
 * speed. A fraction of WEIGHT is the trap. A vehicle's drag scales with its
 * frontal area and a shove scales with its mass, and those are wildly different
 * things across this fleet — so the same 0.16 g that a sports car barely feels
 * is 16 kN on a 10.2 t bus, which is more than its entire aerodynamic drag at
 * any speed it can reach. Measured on the bench, unboosted against boosted:
 *
 *     bus   94.7 km/h  ->  213.6 km/h
 *
 * A bus at 214 km/h, on a shove that was supposed to be a nudge. The mechanism
 * is that a fixed force does not care about the rev limiter: past the geared
 * top speed the engine has already been cut and the only thing resisting is
 * drag, so any force at all keeps pushing.
 *
 * So there is exactly ONE term, and it is the engine's own torque. That is what
 * nitrous oxide physically is — an engine modification, not a thruster — and it
 * cannot produce the failure above, because the limiter still owns the top end:
 * boost makes a car reach its top speed sooner, and a drag-limited one (the
 * bicycle, the van, the truck) genuinely faster, and nothing reach a speed its
 * gearbox cannot turn.
 *
 * WHERE 1.95 COMES FROM. A two-wheeler's sprint is specified as a flat 1.25 on
 * TOP SPEED. A drag-limited vehicle's top speed goes as the CUBE ROOT of power,
 * so 1.25 of speed is 1.25^3 = 1.95 of power — and 1.95 is therefore what the
 * rider's legs are multiplied by. The 1.25 then arrives through the physics
 * instead of being clamped on top of it, and the bench agrees: 38.9 km/h ->
 * 48.6 km/h, a ratio of 1.249.
 *
 * Nitro's 1.55 has no equivalent anchor — there is no arcade acceleration or
 * top-speed clamp here for it to scale — so it is chosen for feel: half again
 * as much engine.
 */
const BOOST_NITRO = { kind: 'nitro', torque: 1.55 };
const BOOST_SPRINT = { kind: 'sprint', torque: 1.95 };

/**
 * Default `boost` by kind. `'boost' in spec` rather than `??`, so a class can
 * author `boost: null` and mean it.
 */
function defaultBoost(kind) {
  if (kind === 'car') return BOOST_NITRO;
  if (kind === 'bike') return BOOST_SPRINT;
  return null;
}

/* ------------------------------------------------------------------ */
/* WATER — the rule set for a car that has driven into the Allegheny   */
/* ------------------------------------------------------------------ */

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THREE RIVERS AND FORTY BRIDGES, SO THIS IS NOT AN EDGE CASE
 * ────────────────────────────────────────────────────────────────────────────
 * Before this pass a car driven into a river SETTLED ON THE RIVERBED and kept
 * running, indefinitely, on the `water` surface entry's low grip — the only
 * thing that happened at all was mu 0.22. No damage, no drowning, no cap. On a
 * map whose defining geography is water and whose chokepoints are all bridges,
 * that is a state players reach constantly.
 *
 * A land vehicle in water gets three rules, plus a drowned engine that loses
 * drive the way a dry tank does:
 *
 *   damageRate 0.06   6% of the vehicle's health per second. Health is a
 *                     per-class `body.hp` from 90 to 3000, so the rule is a
 *                     FRACTION, not a flat number: a sedan (900) takes 54 hp/s
 *                     and drowns in 16.7 s, a bus (3000) takes 180 hp/s and
 *                     drowns in the same 16.7 s. A flat 6 hp/s would make a bus
 *                     survive eight minutes in a river and a bicycle sixteen
 *                     seconds.
 *   speedCap 0.15     fifteen per cent of the class's own top speed — see
 *                     `topSpeedEst` below for how that is derived without
 *                     reading a test file.
 *   drownDepth        the engine drowns when the water is over the AIR INTAKE,
 *                     not when a tyre gets wet. Fording a shallow bank must not
 *                     kill a car; two metres of Monongahela must. Measured from
 *                     the underbody as a fraction of body height.
 *   drownDelay 0.7 s  an engine ingesting water does not stop instantly, and a
 *                     hard cut on the exact frame the intake submerges makes
 *                     the boundary feel like a trigger volume.
 *
 * A drowned engine STAYS drowned — `repair()` is what brings it back, which is
 * the body shop, which is the intended cost of driving into the river.
 */
export const WATER = {
  /** Fraction of MAX HEALTH per second while the body is in the water. */
  damageRate: 0.06,
  /** Speed cap as a fraction of `spec.topSpeedEst`. */
  speedCap: 0.15,
  /** Below this submerged fraction nothing happens at all (spray, not a river). */
  wadeFrac: 0.10,
  /** Water over this fraction of body height, measured from the floor, drowns it. */
  drownFrac: 0.62,
  /** Seconds of ingestion before the engine actually stops. */
  drownDelay: 0.7,
  /** Density of fresh water, kg/m^3. */
  rho: 1000,
  /**
   * Displaced volume as a fraction of the bounding box, and how much of the
   * resulting buoyancy actually acts. A car is a box full of air and is very
   * nearly neutral when it first goes in — it floats for a few seconds and then
   * fills and sinks, which is what the ramp models. Above 1 it would never sink.
   */
  volumeFrac: 0.55, buoyancy: 0.86,
  /** How fast the cabin fills, per second: buoyancy fades away over ~8 s. */
  floodRate: 0.12,
  /** Drag coefficient of a car pushing through water, times its wet area. */
  dragCd: 0.9,
  /**
   * HEAVE DAMPING, as a multiple of the displaced mass per (m/s) of vertical
   * speed. This is the term that stops a car BOUNCING OUT OF THE RIVER.
   *
   * Without it the first cut threw a sedan that entered at 15 m/s four metres
   * back into the air and left it bobbing for ten seconds — measured, and it
   * halved every damage reading taken during it, because the rule only bites
   * while the body is actually under. Buoyancy alone is a spring: waterplane
   * stiffness rho*g*A is 53 kN/m on a sedan, which against 1.52 t is a 0.94 Hz
   * oscillator with nothing damping it at all.
   *
   * 3.5 x the displaced mass is near CRITICAL for that oscillator (2*sqrt(k*m)
   * = 18 kN per m/s against the 17 kN this gives at the floating waterline), so
   * a car arrives, settles, and fills. Fully submerged it is overdamped, which
   * is also right: a sunk car does not bob. Physically this is the added mass
   * of the water the hull has to drag with it, which is the real reason a car
   * does not behave like a cork.
   */
  heaveDamp: 3.5,
};

/* ------------------------------------------------------------------ */
/* PER-HERO VEHICLE MODIFIERS                                          */
/* ------------------------------------------------------------------ */

/**
 * ────────────────────────────────────────────────────────────────────────────
 * `vehicleGrip` AND `boatSpeed` WERE DEAD DATA IN THREE PLACES AT ONCE
 * ────────────────────────────────────────────────────────────────────────────
 * DESIGN.md's stat table gives each brother a vehicle grip (1.06 / 1.12 / 1.22)
 * and a boat speed (1.25 / 1.00 / 1.05). Those numbers are in
 * `src/player/brothers.js` and in `src/game/data.js` — and they were consumed
 * by nothing anywhere. Every brother drove an identical car,
 * which flattens the one mechanical difference between them that the design
 * asks for outside of running speed and health.
 *
 * WHY THEY ARE CENTRED ON AIDAN RATHER THAN APPLIED RAW. Applying 1.22 straight
 * to the tyre would put Dylan's Peregrine on mu 1.85 — a slick — and would move
 * every number this directory has measured and gated, for every player, because
 * the player is always one of the three. Aidan is DESIGN.md's "middle, best
 * all-rounder" and his 1.12 is the natural pivot, so:
 *
 *     heroGrip = brother.vehicleGrip / 1.12
 *
 *   Carson 0.946    Aidan 1.000    Dylan 1.089
 *
 * which keeps DESIGN.md's ordering and its spacing exactly, makes the fleet as
 * gated today the ALL-ROUNDER's car rather than an arbitrary fourth setup, and
 * lands the spread at +/- 5-9% of tyre mu — about a fifth of what rain costs,
 * so it is felt in a corner without being a different game.
 *
 * TOP SPEED, AND WHY IT IS THE TOP GEAR. The requirement is that top speed as
 * well as grip must differ, and grip does not set a top speed: every fast class in this
 * fleet is limiter-bound (see the TOP GEAR note above), so more mu and even
 * more torque change nothing at all at the top end. The lever that DOES is
 * gearing — and there is already a precedent in this file for using it, with
 * the proof that it leaves acceleration untouched. So the hero factor trims the
 * TOP GEAR ONLY:
 *
 *     heroTop = 1 + (heroGrip - 1) * 0.55     0.970 / 1.000 / 1.049
 *
 * Read it as the brothers running their own final drives: Carson's is short and
 * torquey for a river hand who tows, Dylan's is long because a courier lives on
 * the parkway. Every lower ratio is untouched, exactly as the TOP GEAR pass
 * did, so a hero change cannot alter a launch or a 0-100.
 *
 * BOATS. `boatSpeed` is already 1.00 on Aidan, so it needs no centring and is
 * applied raw to the hull's thrust — which is Carson's whole arc, on the water,
 * at 1.25.
 *
 * WHO GETS THEM: only the vehicle a PLAYER is driving. Traffic and police cars
 * must not change grip when the player switches brother in a menu. Same gate as
 * the fuel tank, and for the same reason.
 */
export const HERO = {
  /** DESIGN.md's all-rounder. The pivot, not a magic number. */
  gripPivot: 1.12,
  /** How much of the grip spread carries into the top gear. */
  topShare: 0.55,
  /** Identity, for a vehicle with no hero at the wheel. */
  none: { id: null, grip: 1, top: 1, boat: 1 },
};

/**
 * Turn a brother spec (`src/player/brothers.js`, reached at runtime — never
 * imported, hard rule 2) into the three multipliers the dynamics consumes.
 * Tolerates a null brother and a brother with neither field.
 */
export function heroMods(brother) {
  if (!brother) return HERO.none;
  const grip = (brother.vehicleGrip ?? brother.vehGrip ?? HERO.gripPivot) / HERO.gripPivot;
  return {
    id: brother.id ?? null,
    grip,
    top: 1 + (grip - 1) * HERO.topShare,
    boat: brother.boatSpeed ?? 1,
  };
}

/* ------------------------------------------------------------------ */
/* Derived quantities                                                  */
/* ------------------------------------------------------------------ */

/**
 * Fill in everything the dynamics needs but nobody should have to type: spring
 * rates from ride frequency and corner mass, inertia tensor from the box, axle
 * positions from the wheelbase and CoM split.
 */
export function finalizeSpec(spec) {
  if (spec._final) return spec;
  const s = { ...spec };
  s.susp = { ...spec.susp };
  s.tyre = { ...spec.tyre };
  s.style = { ...spec.style };

  const g = 9.81;
  const wb = s.wheelbase;
  // z is +forward. Axles sit about the CoM according to comZ.
  s.axleF = wb * (1 - s.comZ);
  s.axleR = -wb * s.comZ;

  const isBike = s.kind === 'bike';
  const nF = isBike ? 1 : 2;
  const nR = isBike ? 1 : 2;
  // Static load split: comZ = 0 puts all the mass on the front axle.
  const loadF = s.mass * g * s.comZ;
  const loadR = s.mass * g * (1 - s.comZ);
  s.cornerMassF = loadF / g / nF;
  s.cornerMassR = loadR / g / nR;
  s.staticLoadF = loadF / nF;
  s.staticLoadR = loadR / nR;

  // k = m * (2*pi*f)^2, c = 2 * zeta * sqrt(k*m)
  const wF = 2 * Math.PI * s.susp.freqF;
  const wR = 2 * Math.PI * s.susp.freqR;
  s.susp.kF = s.cornerMassF * wF * wF;
  s.susp.kR = s.cornerMassR * wR * wR;
  s.susp.cF = 2 * s.susp.dampF * Math.sqrt(s.susp.kF * s.cornerMassF);
  s.susp.cR = 2 * s.susp.dampR * Math.sqrt(s.susp.kR * s.cornerMassR);

  /**
   * Suspension geometry. `staticLen` is how far the wheel centre hangs below
   * the strut top when the car is parked — half the travel, plus a little, so
   * there is room to droop as well as to compress. `rest` is then the spring's
   * free length: the length at which its force is zero. The static load is what
   * separates the two, which is why heavier cars sit on softer springs and
   * still have the same travel left.
   */
  const staticLenF = s.susp.travel * 0.5 + 0.06;
  const staticLenR = s.susp.travel * 0.5 + 0.06;
  s.susp.staticLenF = staticLenF;
  s.susp.staticLenR = staticLenR;
  s.susp.restF = staticLenF + s.staticLoadF / s.susp.kF;
  s.susp.restR = staticLenR + s.staticLoadR / s.susp.kR;
  s.susp.maxF = staticLenF + s.susp.travel * 0.5;
  s.susp.maxR = staticLenR + s.susp.travel * 0.5;
  s.susp.minF = Math.max(0.015, staticLenF - s.susp.travel * 0.5);
  s.susp.minR = Math.max(0.015, staticLenR - s.susp.travel * 0.5);

  /**
   * Fuel burn, in tank-percent per second (the tank is 0-100). Derived rather
   * than authored so a new class cannot forget it:
   * `idle` is what the engine costs just running, `rate` is the extra at
   * redline under full load. Engine torque is the closest proxy this spec set
   * has for displacement, so the Millhand drinks and the Slagbolt sips.
   *
   * At full noise a car empties in ~2.5-3 min, at a steady cruise ~8 min, and
   * idling alone takes half an hour — long enough that fuel is a trip-planning
   * decision rather than a nuisance, on a 3 km map.
   */
  s.fuelBurn = {
    idle: 0.030 + s.mass / 1.4e5,
    rate: 0.20 + (s.engine?.peakTorque ?? 300) / 1250,
  };
  /**
   * `nogas` is the bicycle's flag: no tank, so no burn, no dry-tank cut and no
   * gauge. Derived to zero rather than special-cased at the
   * consumer so that nothing downstream has to remember the exception.
   */
  s.nogas = !!spec.nogas;
  if (s.nogas) s.fuelBurn = { idle: 0, rate: 0 };

  // Inertia tensor of a solid box, fudged: real cars have more mass low and
  // central than a uniform box, so scale pitch/yaw down a touch.
  const L = s.dims.L, W = s.dims.W, H = s.dims.H;
  const m = s.mass;
  s.inertia = {
    x: (m / 12) * (H * H + L * L) * 0.82, // pitch
    y: (m / 12) * (W * W + L * L) * 0.88, // yaw
    z: (m / 12) * (W * W + H * H) * 0.7,  // roll
  };
  if (isBike) {
    s.inertia.z *= 0.45;
    s.inertia.y *= 0.7;
  }

  // Wheel rotational inertia: a solid-ish disc.
  const wr = s.wheel.radius;
  s.wheel.mass = isBike ? 11 : s.mass > 3000 ? 62 : 22;
  s.wheel.inertia = 0.62 * s.wheel.mass * wr * wr;

  // Wheel hardpoints, local space, measured from the CoM at ride height.
  s.wheels = [];
  if (isBike) {
    s.wheels.push(hardpoint(s, 0, s.axleF, true, 0));
    s.wheels.push(hardpoint(s, 0, s.axleR, false, 1));
  } else {
    const hF = s.trackF / 2, hR = s.trackR / 2;
    s.wheels.push(hardpoint(s, -hF, s.axleF, true, 0));
    s.wheels.push(hardpoint(s, hF, s.axleF, true, 1));
    s.wheels.push(hardpoint(s, -hR, s.axleR, false, 2));
    s.wheels.push(hardpoint(s, hR, s.axleR, false, 3));
  }

  s.driven = s.wheels.map((w) =>
    s.drive === 'awd' ? 1 : s.drive === 'fwd' ? (w.front ? 1 : 0) : w.front ? 0 : 1
  );
  s.drivenCount = s.driven.reduce((a, b) => a + b, 0) || 1;

  s.gearbox = { ...s.gearbox };
  s.gearbox.redlineW = s.engine.redline * RPM;
  s.gearbox.idleW = s.engine.idle * RPM;
  /**
   * Reverse speed limiter, m/s. Reverse is a single low gear with no upshift,
   * so on raw ratios a sports car will happily back up at 75 km/h — which is
   * both absurd and unplayable, because the chase camera does not follow you
   * backwards at motorway speed. Every driving game caps it; GTA's cars top out
   * around 25 km/h. Heavy things and two-wheelers get less: a bike has no
   * reverse gear at all in reality, so it walks backwards.
   */
  s.gearbox.reverseMax = s.gearbox.reverseMax ?? (
    isBike ? 2.6 : s.mass > 3000 ? 4.6 : 7.2
  );
  s.engine = { ...s.engine };
  s.engine.peakW = s.engine.peakRpm * RPM;
  s.engine.redlineW = s.engine.redline * RPM;
  s.engine.idleW = s.engine.idle * RPM;

  s.aero = { ...s.aero };
  // 0.5 * rho * Cd * A, so drag is just k*v^2.
  s.aero.kDrag = 0.5 * 1.225 * s.aero.cd * s.aero.area;
  s.aero.kDownF = 0.5 * 1.225 * s.aero.downF * s.aero.area;
  s.aero.kDownR = 0.5 * 1.225 * s.aero.downR * s.aero.area;

  // Bounding half-extents for collision probes and camera framing.
  s.half = { x: W / 2, y: H / 2, z: L / 2 };

  s.boost = 'boost' in spec ? spec.boost : defaultBoost(s.kind);

  /**
   * ────────────────────────────────────────────────────────────────────────
   * `topSpeedEst` — HOW FAST THIS CLASS GOES, DERIVED, NEVER MEASURED.
   * ────────────────────────────────────────────────────────────────────────
   * The water rule needs "15% of top speed" and nothing in the engine knew what
   * a class's top speed was. The obvious fix — copy the numbers out of
   * `drivetest.mjs`'s PACE table — is exactly the circularity hard rule 12 is
   * about: the gate would then be checking a number against the table it was
   * copied from, and a new class would silently get someone else's.
   *
   * So it is derived from first principles, from the two things that actually
   * decide a top speed, and the smaller of them wins:
   *
   *   GEARED   redlineW * wheelRadius / (topGear * final). What the engine can
   *            spin the wheels to before the limiter cuts.
   *   DRAG     cbrt(P / kDrag), because P = F.v and F = kDrag.v^2 at terminal.
   *            P is peak torque times peak angular velocity, times 0.85 for the
   *            shape of `torqueFactor` away from the peak.
   *
   * Checked against what `drivetest.mjs` MEASURES on the emitted motion — which
   * is a genuinely independent number, since nothing below reads it:
   *
   *            geared   drag    est     measured   est/measured
   *   sports     74.7    81.7   74.7      73.5        1.02
   *   kessel     63.1    74.3   63.1      62.3        1.01
   *   muscle     65.5    74.1   65.5      64.3        1.02
   *   sedan      53.0    63.2   53.0      52.1        1.02
   *   van        40.0    44.3   40.0      38.1        1.05
   *   truck      35.0    44.1   35.0      31.4        1.11
   *   bike       68.4    69.8   68.4      63.6        1.08
   *
   * One to eleven per cent high, always high, and high for a known reason —
   * the shift losses and the last few per cent of the limiter are not in the
   * algebra. That is the right side to err on for a speed CAP.
   *
   * RE-CHECKED after the ENGINE TORQUE pass, because that pass is exactly the
   * kind of change that could have quietly inverted this: raising `peakTorque`
   * raises the DRAG branch (it is the cube root of power) while leaving the
   * GEARED branch alone. Every class here is geared-limited, so `est` did not
   * move at all and the measured speed rose only on the two drag-adjacent
   * classes — which means the van and the truck got CLOSER to their estimate,
   * 1.10 to 1.05 and 1.14 to 1.11, and nothing crossed to the wrong side.
   */
  {
    const gb = s.gearbox;
    const g = gb.gears;
    const topGear = Math.abs(g[g.length - 1]) * Math.abs(gb.final);
    const vGeared = topGear > 1e-4
      ? (s.engine.redline * RPM * s.wheel.radius) / topGear
      : Infinity;
    const kDrag = 0.5 * 1.225 * s.aero.cd * s.aero.area;
    // A power-capped class (`powerCap`, the bicycle) states its power outright,
    // so use it rather than inferring one from a torque peak the curve does not
    // have. Inferring gave 14.9 m/s against a real 10.7 — a 39% over-read, and
    // this number is a speed CAP, so an over-read is a cap that does not cap.
    const power = s.engine.powerCap > 0
      ? s.engine.powerCap
      : s.engine.peakTorque * s.engine.peakRpm * RPM * 0.85;
    const vDrag = Math.cbrt(power / Math.max(1e-4, kDrag));
    s.topSpeedEst = Math.min(vGeared, vDrag);
    // A helicopter has no gearbox in the sense above: the disc's tilt sets the
    // thrust and the drag sets the speed, so only the drag branch is meaningful.
    // A fixed-wing aircraft has no road gearbox either — the prop and the wing
    // decide its speed, so the same applies.
    if (s.kind === 'heli' || s.kind === 'plane') s.topSpeedEst = vDrag;
  }

  /**
   * Water. `capSpeed` is the 15% terrain cap; the drag coefficient
   * is the real thing — water is 800 times denser than air — and the intake
   * height is where the engine stops breathing. See the WATER block above.
   */
  s.hydro = {
    capSpeed: WATER.speedCap * s.topSpeedEst,
    /** Displaced volume of the whole body, m^3, if it were fully under. */
    volume: L * W * H * WATER.volumeFrac,
    /** 0.5 * rho * Cd * frontal area — the fully-submerged coefficient. */
    kDrag: 0.5 * WATER.rho * WATER.dragCd * W * H,
    /** World-space height of the air intake above the vehicle's floor. */
    intakeY: (s.style?.groundY ?? 0.15) + H * WATER.drownFrac,
    /** Damage per second once wet, in this class's own health points. */
    dps: WATER.damageRate * s.body.hp,
  };

  finalizeStyle(s, spec.style);

  s._final = true;
  return s;
}

/**
 * The style block is authored with z = 0 at the middle of the body and the
 * arches roughly where the axles ought to be. The dynamics needs z = 0 at the
 * CENTRE OF MASS, and the arches exactly on the axles or the wheels sit in the
 * bodywork. Reconcile the two here, once, so neither the artist-facing numbers
 * nor the physics has to compromise.
 */
function finalizeStyle(s, src) {
  const st = s.style;
  if (!src.archF || !src.archR) return;
  st.archF = { ...src.archF };
  st.archR = { ...src.archR };
  const foA = src.noseZ - src.archF.z;
  const roA = src.archR.z - src.tailZ;
  const spanA = foA + roA;
  const overhang = Math.max(0.05, s.dims.L - s.wheelbase);
  const k = spanA > 1e-4 ? overhang / spanA : 1;

  const authoredMid = (src.archF.z + src.archR.z) * 0.5;
  const realMid = (s.axleF + s.axleR) * 0.5;
  const dz = realMid - authoredMid;

  st.archF.z = s.axleF;
  st.archR.z = s.axleR;
  if (src.noseZ !== undefined) st.noseZ = s.axleF + foA * k;
  if (src.tailZ !== undefined) st.tailZ = s.axleR - roA * k;

  for (const key of ['cowlZ', 'windscreenTopZ', 'roofRearZ', 'backlightBaseZ', 'consoleZ',
    'windshieldZ', 'tankZ', 'barZ', 'bowZ', 'sternZ', 'sideWindowEnd']) {
    if (src[key] !== undefined) st[key] = src[key] + dz;
  }
  if (src.mirror) st.mirror = { ...src.mirror, z: src.mirror.z + dz };
  if (src.flatbed) st.flatbed = { ...src.flatbed, z0: src.flatbed.z0 + dz, z1: src.flatbed.z1 + dz };
  if (src.doorSplit) st.doorSplit = src.doorSplit.map((v) => v + dz);
  if (src.grille) st.grille = { ...src.grille };
  if (src.headlight) st.headlight = { ...src.headlight };
  if (src.taillight) st.taillight = { ...src.taillight };
  if (src.exhaust) st.exhaust = { ...src.exhaust };
}

function hardpoint(s, x, z, front, index) {
  const staticLen = front ? s.susp.staticLenF : s.susp.staticLenR;
  return {
    index,
    front,
    x, z,
    /** Local y of the strut top, measured from the centre of mass. */
    top: s.wheel.radius + staticLen - s.comY,
    staticLen,
    rest: front ? s.susp.restF : s.susp.restR,
    k: front ? s.susp.kF : s.susp.kR,
    c: front ? s.susp.cF : s.susp.cR,
    min: front ? s.susp.minF : s.susp.minR,
    max: front ? s.susp.maxF : s.susp.maxR,
    camber: front ? s.susp.camberF : s.susp.camberR,
    toe: (front ? s.susp.toeF : s.susp.toeR) * (x < 0 ? 1 : -1),
    steered: front,
    braked: front ? s.brakes.front : s.brakes.rear,
    handbrake: front ? 0 : s.brakes.handbrake,
    radius: s.wheel.radius,
    inertia: s.wheel.inertia,
  };
}

/**
 * Normalised engine torque at a given angular velocity, 0..~1.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * `powerCap` — LEGS ARE POWER-LIMITED, AN ENGINE IS SHAPE-LIMITED
 * ────────────────────────────────────────────────────────────────────────────
 * The curve below is a petrol engine's: a peak at `peakRpm` with a parabolic
 * fall either side, and a floor of 0.28 near stall because that is what an
 * engine makes when it is barely turning. A pair of legs does the opposite of
 * all three. A rider's torque is highest at the LOWEST cadence — standing on a
 * pedal is his body weight times the crank, 132 N.m and nothing to do with how
 * fast he is turning it — and above about 30 rpm he is limited by POWER, not by
 * torque, so his curve is a hyperbola: T = P/w.
 *
 * Fitting that with the parabola was tried and it does not work in either
 * direction. A peak at 62 rpm left the whole usable range on the falling side
 * and the bicycle would not leave first gear (measured: stuck at 24.9 km/h,
 * cadence pinned at 117 rpm). Moving the peak down to a real standing-start
 * cadence put 78 rpm at `d = 1.6`, where the parabola has gone negative and is
 * clamped to the 0.04 floor — a rider who stops pedalling at walking pace.
 *
 * So a class may declare `engine.powerCap` in WATTS and get the honest curve:
 * flat torque up to the cadence where it would exceed the power budget, and
 * `P/w` after that. Two numbers, both measurable on a real rider — 118 N.m of
 * standing torque and 360 W sustained — and everything else falls out: 38.4
 * km/h flat out, 49 km/h sprinting, and a launch at 1.9-3.8 m/s^2 which is
 * what a bicycle actually does.
 *
 * `boost` multiplies the RESULT, so an out-of-the-saddle sprint is 702 W and
 * 230 N.m at the crank — twice body weight on a pedal, which is exactly what a
 * sprinter pulling on the bars produces, and exactly why it lasts 3.6 seconds.
 */
export function torqueFactor(spec, w) {
  const e = spec.engine;
  if (e.powerCap > 0) {
    if (w < 0.05) return 1;
    return Math.max(0.04, Math.min(1, e.powerCap / (w * e.peakTorque)));
  }
  const x = w / e.peakW;
  if (x < 0.08) return 0.28;
  const d = x - 1;
  const f = d < 0 ? 1 - 0.42 * d * d : 1 - 1.15 * d * d;
  return Math.max(0.04, Math.min(1, f));
}

export const CLASS_IDS = Object.keys(VEHICLE_SPECS);
