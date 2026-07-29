/**
 * ROAD SURFACES.
 *
 * The street is the single biggest surface in an open-world game and the one
 * the camera spends the most time two metres above, so it gets the most
 * authoring. Everything here follows the same contract as the other generators:
 *
 *   void owSurface(vec2 uv, out vec3 alb, out float h, out float rough,
 *                  out float metal, out float ao)
 *
 * NYQUIST BUDGET. Every generator writes `p = uv * 8`, so a term at `p * K`
 * lays 8K cells across the bake; at 1024 texels that is 128/K texels per cell.
 * Under ~5 texels a band is not a feature, it is white noise that dithers at
 * mip 0 and averages to flat grey at mip 1. K is capped at 24 throughout and
 * the sub-millimetre read is delegated to the shared detail map, which is tiled
 * ten times finer and has the texel budget for it.
 *
 * LANE-ALIGNED FEATURES. A world-projected tile cannot know which way the road
 * runs, so wheel polish, the oil line down the lane centre and the longitudinal
 * paver joint are gated behind `uParam.w` and only baked for the variants the
 * world maps with road-aligned mesh UVs (v along the carriageway). Baking them
 * unconditionally would run the wheel tracks north-south across every road in
 * the city.
 */

/**
 * Shared: the aggregate bed every bituminous surface is made of.
 * Returns the exposed-stone masks so each caller can weather them differently.
 *   .x  coarse chipping mask     .y  fine chipping mask
 *   .z  grit mask                .w  interstitial void mask
 */
export const ROAD_HELPERS = /* glsl */ `
vec4 owAggregate( vec2 p, vec2 P, out vec3 stone, out float relief ){
  // Angularity comes from warping the worley domain: round cells become
  // faceted, which is what separates crushed rock from a pebble beach.
  vec2 ap = owWarp( p, P, 0.10, 3 );
  vec4 big   = owWorley( ap * 12.0, P * 12.0, 1.0 );
  vec4 small = owWorley( ap * 21.0 + 7.0, P * 21.0, 1.0 );
  vec4 grit  = owWorley( ap * 24.0 + 3.0, P * 24.0, 1.0 );

  float bigM = smoothstep( 0.40, 0.15, big.x )
             * smoothstep( 0.28, 0.60, owFbm01( p * 2.2 + 3.0, P * 2.0, 4, 0.5 ) + big.w * 0.5 );
  float smallM = smoothstep( 0.36, 0.10, small.x ) * step( 0.30, small.w );
  float gritM  = smoothstep( 0.32, 0.06, grit.x ) * step( 0.45, grit.z );
  float voidM  = smoothstep( 0.50, 0.85, big.x ) * smoothstep( 0.28, 0.60, small.x );

  // Four quarry stocks. Pittsburgh mixes limestone and slag, so half the
  // chippings are pale grey and a fair share are near-black.
  vec3 s1 = owSRGB( vec3( 0.400, 0.392, 0.378 ) );  // limestone
  vec3 s2 = owSRGB( vec3( 0.190, 0.184, 0.180 ) );  // slag / trap rock
  vec3 s3 = owSRGB( vec3( 0.560, 0.520, 0.470 ) );  // bright dolomite
  vec3 s4 = owSRGB( vec3( 0.330, 0.268, 0.222 ) );  // ironstone
  stone = mix( s1, s2, big.z );
  stone = mix( stone, s3, step( 0.90, big.w ) );
  stone = mix( stone, s4, step( 0.86, small.w ) * 0.55 );

  relief = bigM * 0.15 * ( 0.6 + 0.6 * big.z ) + smallM * 0.065 + gritM * 0.022;
  return vec4( bigM, smallM, gritM, voidM );
}

/**
 * Crack sealant — "tar snakes".
 *
 * A crew walks the road with a wand and lays a 5-10 cm bead of hot rubberised
 * bitumen over every crack. It sets PROUD of the surface, it is glossy black
 * against grey asphalt, and it wanders. In an American city it is on every
 * street, and its absence is one of the loudest tells that a road is procedural
 * geometry rather than a road.
 */
float owTarSnake( vec2 p, vec2 P, float amt, out float core ){
  vec2 wp = owWarp( p * 1.4, P * 1.4, 0.55, 3 );
  float e = owVoronoiEdge( wp, P * 1.4, 0.9 );
  // The bead is wider than the crack it covers and has a soft, spread shoulder.
  float band = 1.0 - smoothstep( 0.0, 0.075, e );
  core = 1.0 - smoothstep( 0.0, 0.030, e );
  // Only some of the network was ever sealed, and the wand skips.
  float sel = smoothstep( 0.42, 0.70, owFbm01( p * 1.1 + 29.0, P * 1.1, 4, 0.58 ) );
  float skip = smoothstep( 0.30, 0.52, owFbm01( p * 5.0 + 3.0, P * 5.0, 3, 0.5 ) );
  band *= sel * skip * amt;
  core *= sel * skip * amt;
  return clamp( band, 0.0, 1.0 );
}
`;

/**
 * ASPHALT CARRIAGEWAY.
 *
 * uParam.x  age 0..1        fresh black binder -> grey, ravelled, aggregate proud
 * uParam.y  repairs 0..1    utility cuts, skin patches and their sealed perimeters
 * uParam.z  damage 0..1     alligator cracking, potholes, edge break-up
 * uParam.w  lane 0..1       wheel polish + the oil line, along v (mesh UVs only)
 */
export const ROAD_ASPHALT = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 6.9;

  float age    = clamp(uParam.x, 0.0, 1.0);
  float repair = clamp(uParam.y, 0.0, 1.0);
  float damage = clamp(uParam.z, 0.0, 1.0);
  float lane   = clamp(uParam.w, 0.0, 1.0);

  float macro = owFbm01(p * 0.55, P * 0.5, 4, 0.6);
  float mid   = owFbm01(p * 3.0, P * 3.0, 5, 0.5);
  float fine  = owFbm01(p * 16.0, P * 16.0, 4, 0.5);

  // ---- binder ------------------------------------------------------------
  // Fresh hot-mix is nearly black with a blue cast; UV strips the binder off
  // the top of the aggregate over a few winters and it greys out from there.
  vec3 cFresh = owSRGB(vec3(0.072, 0.073, 0.080));
  vec3 cGrey  = owSRGB(vec3(0.315, 0.312, 0.305));
  vec3 c = mix(cFresh, cGrey, smoothstep(0.10, 0.90, macro * 0.55 + age * 0.75));
  c *= 0.94 + 0.12 * fine;

  h = 0.60 + (mid - 0.5) * 0.06;
  rough = 0.74 + (mid - 0.5) * 0.10 + (fine - 0.5) * 0.14 + age * 0.10;
  metal = 0.0;
  ao = 1.0;

  // ---- aggregate ---------------------------------------------------------
  vec3 stone; float relief;
  vec4 agg = owAggregate(p, P, stone, relief);
  // Ravelling: as the binder oxidises it lets go of the stone, so an old road
  // shows far more of its aggregate AND stands it further proud.
  float expose = 0.30 + 0.70 * age;
  c = mix(c, stone, agg.x * 0.55 * expose);
  c = mix(c, stone * 1.06, agg.y * 0.24 * expose);
  c = mix(c, stone * 0.9, agg.z * 0.14 * expose);
  h += relief * (0.55 + 0.75 * age);
  rough += agg.x * 0.10 - agg.x * 0.16 * expose;
  h -= agg.w * 0.10;
  ao -= agg.w * 0.14;

  // ---- laydown structure -------------------------------------------------
  // A paver lays 3.5 m at a time and the screed leaves a longitudinal texture;
  // where two passes meet there is a cold joint that is always the first thing
  // to crack. Both run ALONG the carriageway, so both are lane-gated.
  float screed = owFbm01(owShear(p * 2.0, 0.0, 7.0), owShearPer(P * 2.0, 7.0), 4, 0.52);
  c *= 1.0 - (screed - 0.5) * 0.10 * lane;
  h += (screed - 0.5) * 0.012 * lane;

  // The joint WANDERS: a screed does not run dead straight for a mile, and a
  // perfectly straight one at a fixed pitch reads as a painted line rather than
  // as a seam. It is also quieter than it was — at 0.45 toward fresh binder it
  // was the loudest thing on the carriageway from directly above.
  float coldJ = abs(fract(uv.x * 1.0 + 0.18 + owFbm01(p * 0.5, P * 0.5, 3, 0.6) * 0.14) - 0.5) * 2.0;
  float joint = (1.0 - smoothstep(0.0, 0.030, coldJ)) * lane;
  h -= joint * 0.04;
  ao -= joint * 0.18;
  c = mix(c, cFresh * 0.80, joint * 0.28);

  // ---- wheel polish ------------------------------------------------------
  // Two ~0.9 m bands per lane where the tyres run: the stone is polished flat
  // and the binder is pushed back up, so they are darker AND smoother than the
  // ravelled strip between them. This is the strongest large-scale signal on
  // any real road and it is what a stretched-out grey plane is missing.
  float across = fract(uv.x * 1.0);
  float wheelA = 1.0 - smoothstep(0.055, 0.20, abs(across - 0.27));
  float wheelB = 1.0 - smoothstep(0.055, 0.20, abs(across - 0.73));
  float polish = max(wheelA, wheelB) * lane
               * smoothstep(0.20, 0.62, owFbm01(vec2(p.x * 0.7, p.y * 4.0), vec2(P.x, P.y * 4.0), 4, 0.5));
  rough -= polish * 0.22;
  h -= polish * 0.020;
  c = mix(c, c * 0.72 + owSRGB(vec3(0.040, 0.040, 0.044)), polish * 0.55);

  // ---- oil down the lane centre ------------------------------------------
  // Every car parked at a light drips onto the same strip. It is nearly black,
  // slightly glossy, and it feathers out into individual drop stains.
  float centre = 1.0 - smoothstep(0.02, 0.16, abs(across - 0.5));
  float oilField = owFbm01(owWarp(vec2(p.x * 2.4, p.y * 0.8) + 31.0, vec2(P.x * 2.4, P.y), 0.9, 3),
                           vec2(P.x * 2.4, P.y), 4, 0.55);
  float oil = centre * lane * smoothstep(0.42, 0.80, oilField);
  // and scattered drips everywhere else
  vec4 drips = owWorley(p * 6.0 + 17.0, P * 6.0, 1.0);
  float drip = smoothstep(0.16, 0.03, drips.x) * step(0.90, drips.w);
  oil = clamp(oil + drip * 0.7, 0.0, 1.0);
  c = mix(c, owSRGB(vec3(0.038, 0.036, 0.040)), oil * 0.78);
  rough -= oil * 0.20;
  ao -= oil * 0.05;

  // ---- repairs -----------------------------------------------------------
  // A utility cut is a RECTANGLE — the saw does not cut curves — filled with a
  // different mix that never quite matches, sitting a few millimetres low, with
  // a sealed perimeter that is glossier than either surface.
  {
    float cw = 2.1;
    vec2 pc = vec2(p.x, p.y) / cw;
    pc += (vec2(owFbm01(p * 0.4, P * 0.4, 3, 0.6), owFbm01(p * 0.4 + 9.0, P * 0.4, 3, 0.6)) - 0.5) * 0.7;
    vec2 cid = floor(pc);
    vec2 cf = pc - cid;
    float r0 = owHash12(cid + uSeed * 1.7);
    float r1 = owHash12(cid * 1.31 + 11.0 + uSeed);
    float r2 = owHash12(cid * 2.17 + 27.0 + uSeed);
    float has = step(1.0 - repair * 0.55, r0);
    vec2 lo = vec2(0.08 + r1 * 0.26, 0.08 + r2 * 0.26);
    vec2 hi = vec2(0.94 - r2 * 0.24, 0.94 - r1 * 0.24);
    vec2 a0 = step(lo, cf);
    vec2 a1 = step(cf, hi);
    float inP = a0.x * a0.y * a1.x * a1.y * has;
    // the saw kerf: a 2 cm hard edge with sealant squeezed into it
    vec2 e0 = smoothstep(lo, lo + 0.018, cf);
    vec2 e1 = 1.0 - smoothstep(hi - 0.018, hi, cf);
    float inner = e0.x * e0.y * e1.x * e1.y * has;
    float kerf = max(inP - inner, 0.0);

    vec3 patchMix = mix(cFresh * (0.9 + 0.5 * fine), cGrey * 0.72, r1);
    c = mix(c, patchMix, inP * 0.72);
    rough = mix(rough, 0.80 + 0.14 * r2, inP * 0.6);
    h -= inP * 0.030 * (0.4 + r2);
    // the seal bead over the kerf
    c = mix(c, owSRGB(vec3(0.048, 0.046, 0.050)), kerf * 0.85);
    rough = mix(rough, 0.30, kerf * 0.8);
    h += kerf * 0.045;
    ao -= kerf * 0.20;
  }

  // ---- cracking ----------------------------------------------------------
  // Alligator cracking is fatigue in the wheel path; thermal cracks run the
  // full width and are far coarser. Both get worse with damage AND with age.
  float crackAmt = clamp(damage * 0.8 + age * 0.35, 0.0, 1.0);
  float gator = owCracks(p * 3.4, P * 3.4, 0.9, 0.030, 0.68 - crackAmt * 0.22)
              * (0.35 + 0.65 * max(polish, lane < 0.5 ? 1.0 : 0.0));
  float thermal = owCracks(p * 0.9 + 41.0, P * 0.9, 0.75, 0.048, 0.80 - crackAmt * 0.22);
  float crack = clamp((gator + thermal) * (0.3 + 0.9 * crackAmt), 0.0, 1.0);
  h -= crack * 0.17;
  ao -= crack * 0.32;
  c = mix(c, owSRGB(vec3(0.040, 0.038, 0.038)), crack * 0.85);
  rough += crack * 0.12;

  // ---- tar snakes --------------------------------------------------------
  float snakeCore;
  float snake = owTarSnake(p, P, clamp(damage * 0.7 + age * 0.5, 0.0, 1.0), snakeCore);
  // Fresh sealant is a wet-looking black; it dulls and greys with its own age.
  vec3 sealCol = mix(owSRGB(vec3(0.032, 0.031, 0.033)), owSRGB(vec3(0.115, 0.112, 0.110)), age * 0.7);
  c = mix(c, sealCol, snake * 0.92);
  // It sits PROUD — you feel it through the steering wheel — and it is glossy.
  h += snake * 0.055 + snakeCore * 0.045;
  rough = mix(rough, 0.30 + 0.22 * age, snake * 0.85);
  ao -= (snake - snakeCore) * 0.10;
  // the bead surface itself is smooth and slightly wrinkled where it flowed
  float wrinkle = owFbm01(p * 14.0, P * 14.0, 3, 0.5);
  h += snakeCore * (wrinkle - 0.5) * 0.02;

  // ---- potholes ----------------------------------------------------------
  // A pothole is not a dent: it is a hole with a BROKEN RIM, vertical sides and
  // the pale base course showing in the bottom. The rim is what reads.
  {
    /**
     * DENSITY, MEASURED OFF A FRAME rather than assumed.
     *
     * The lattice used to be p * 1.6, which over the 4 m tile this bakes at is
     * a cell every 31 cm; at damage 0.3 that selected roughly fifteen potholes
     * per 4x4 m of carriageway. On a straight it read as a regular field of
     * dark dots repeating every tile — the single loudest tiling tell in the
     * street shot. 0.25 gives a 2 m cell (and, being an integer multiple of P,
     * tiles exactly, which 12.8 never did); the selection coefficient is raised
     * so a road authored as broken still comes apart.
     */
    vec4 ph = owWorley(owWarp(p * 0.25 + 53.0, P * 0.25, 0.5, 3), P * 0.25, 0.95);
    float sel = step(1.0 - damage * 0.42, ph.w);
    // cell is 2 m now, so the radius fraction has to come down with it:
    // 0.08-0.15 of a cell is a 30-60 cm hole, which is what one looks like.
    float sz = 0.08 + 0.07 * ph.z;
    float ragged = 0.72 + 0.56 * owFbm01(p * 9.0, P * 9.0, 3, 0.5);
    float hole = sel * smoothstep(sz, sz * 0.30, ph.x * ragged);
    float rim = max(sel * (smoothstep(sz * 1.30, sz, ph.x * ragged) - hole), 0.0);
    // base course: crushed limestone, much paler than the wearing course
    vec3 base = mix(owSRGB(vec3(0.300, 0.286, 0.262)), stone, 0.5);
    c = mix(c, base * 0.72, hole * 0.85);
    h -= hole * 0.42;
    ao -= hole * 0.55;
    rough = mix(rough, 0.94, hole * 0.8);
    // the broken lip catches the light and is where loose chippings collect
    c *= 1.0 + rim * 0.16;
    h += rim * 0.03;
    ao -= rim * 0.10;
  }

  // ---- bleeding / flushing ----------------------------------------------
  // Binder-rich patches where the road has been over-compacted: a slick,
  // aggregate-free black sheen. Common at stop lines and in old wheel paths.
  float flush = smoothstep(0.72, 0.94, owFbm01(owWarp(p * 1.3 + 61.0, P * 1.3, 0.8, 3), P * 1.3, 4, 0.58))
              * (0.4 + 0.6 * polish);
  c = mix(c, owSRGB(vec3(0.055, 0.053, 0.055)), flush * 0.7);
  rough -= flush * 0.22;
  h += flush * 0.010;

  // ---- dust in the low spots --------------------------------------------
  float dust = smoothstep(0.52, 0.28, h) * smoothstep(0.35, 0.75, macro);
  c = mix(c, owSRGB(vec3(0.330, 0.310, 0.276)), dust * 0.28);
  rough += dust * 0.10;

  alb = clamp(c, vec3(0.02), vec3(0.72));
  rough = clamp(rough, 0.26, 0.99);
  ao = clamp(ao, 0.62, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * CONCRETE HIGHWAY SLAB.
 *
 * uParam.x  tine 0..1        the transverse broom/tine finish depth
 * uParam.y  joints per tile  transverse contraction joints (defaults to 2)
 * uParam.z  age 0..1         spalling, staining, sealant failure
 * uParam.w  lane 0..1        wheel polish along v
 */
export const ROAD_CONCRETE = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 4.1;

  float tineAmt = clamp(uParam.x, 0.0, 1.0);
  float slabs   = max(uParam.y, 1.0);
  float age     = clamp(uParam.z, 0.0, 1.0);
  float lane    = clamp(uParam.w, 0.0, 1.0);

  float macro = owFbm01(p * 0.5, P * 0.5, 4, 0.6);
  float mid   = owFbm01(owWarp(p * 2.2, P * 2.2, 0.6, 3), P * 2.2, 5, 0.5);
  float fine  = owFbm01(p * 17.0, P * 17.0, 4, 0.5);

  // Highway concrete is a warm pale grey that darkens and yellows with traffic
  // film; a fresh pour is almost white.
  vec3 cPale = owSRGB(vec3(0.560, 0.552, 0.530));
  vec3 cMid  = owSRGB(vec3(0.400, 0.396, 0.384));
  vec3 cDark = owSRGB(vec3(0.235, 0.232, 0.228));
  vec3 c = mix(cPale, cMid, smoothstep(0.25, 0.85, macro * 0.6 + age * 0.6));
  c *= 0.93 + 0.14 * fine;
  c = mix(c, cDark, smoothstep(0.62, 0.96, mid) * 0.35);

  h = 0.66 + (mid - 0.5) * 0.05 + (fine - 0.5) * 0.03;
  rough = 0.86 + (mid - 0.5) * 0.12;
  metal = 0.0;
  ao = 1.0;

  // ---- slab layout -------------------------------------------------------
  // Contraction joints every 4.5 m across, plus one longitudinal joint between
  // lanes. Each slab settles a hair differently, so the joint has a lip.
  float sy = uv.y * slabs;
  float slabId = floor(sy);
  float sf = fract(sy);
  float dj = min(sf, 1.0 - sf);
  float trans = 1.0 - smoothstep(0.004, 0.013, dj);
  float lx = abs(fract(uv.x + 0.5) - 0.5);
  float longi = (1.0 - smoothstep(0.004, 0.013, lx)) * lane;
  float jointM = clamp(trans + longi, 0.0, 1.0);

  // The joint is SEALED: a recessed backer rod with a black silicone bead over
  // it. Old sealant shrinks, pulls away from one face and lets grit in.
  float sealFail = smoothstep(0.45, 0.85, owFbm01(vec2(p.x * 3.0, p.y * 0.6), vec2(P.x * 3.0, P.y), 4, 0.55)) * age;
  h -= jointM * (0.075 + 0.06 * sealFail);
  ao -= jointM * 0.55;
  c = mix(c, owSRGB(vec3(0.055, 0.054, 0.056)), jointM * (0.85 - 0.35 * sealFail));
  rough = mix(rough, 0.42 + 0.4 * sealFail, jointM * 0.8);

  // per-slab pour shade and a settlement step at each joint
  float slabR = owHash11(slabId * 1.93 + uSeed);
  c *= 0.90 + 0.20 * slabR;
  h += (slabR - 0.5) * 0.030;
  // faulting: the downstream slab has settled, so the joint has a hard lip
  float lip = (1.0 - smoothstep(0.0, 0.045, sf)) * age * (slabR - 0.5);
  h += lip * 0.05;
  c *= 1.0 + max(lip, 0.0) * 0.18;

  // ---- transverse tining -------------------------------------------------
  // 3 mm grooves raked across the slab for skid resistance. They are the whole
  // acoustic and visual signature of a concrete highway, and they hold dirt.
  float tine = abs(fract(uv.x * 96.0) - 0.5) * 2.0;
  float tineG = (1.0 - smoothstep(0.28, 0.86, tine)) * tineAmt;
  // the rake wanders and skips
  tineG *= 0.55 + 0.65 * smoothstep(0.25, 0.75, owFbm01(vec2(p.x * 0.8, p.y * 3.0), vec2(P.x, P.y * 3.0), 3, 0.55));
  h -= tineG * 0.085;
  ao -= tineG * 0.30;
  c = mix(c, c * 0.70, tineG * 0.55);
  rough += tineG * 0.06;

  // ---- exposed aggregate + surface texture -------------------------------
  vec4 aggc = owWorley(p * 14.0, P * 14.0, 0.95);
  float aggM = smoothstep(0.44, 0.10, aggc.x)
             * step(0.62, owFbm01(p * 3.0 + 5.0, P * 3.0, 3, 0.5) + aggc.z * 0.4 + age * 0.3);
  c = mix(c, mix(owSRGB(vec3(0.320, 0.306, 0.288)), owSRGB(vec3(0.575, 0.556, 0.512)), aggc.z), aggM * 0.6);
  h += aggM * 0.024 * (0.5 + aggc.z);
  rough += (aggc.z - 0.5) * 0.08;

  vec4 pores = owWorley(p * 22.0, P * 22.0, 1.0);
  float pore = smoothstep(0.24, 0.0, pores.x) * step(0.84, pores.w);
  h -= pore * 0.05;
  ao -= pore * 0.5;

  // ---- wheel polish ------------------------------------------------------
  float across = fract(uv.x * 1.0);
  float polish = max(1.0 - smoothstep(0.05, 0.19, abs(across - 0.27)),
                     1.0 - smoothstep(0.05, 0.19, abs(across - 0.73))) * lane;
  polish *= smoothstep(0.2, 0.6, owFbm01(vec2(p.x * 0.7, p.y * 4.0), vec2(P.x, P.y * 4.0), 4, 0.5));
  rough -= polish * 0.16;
  c = mix(c, c * 0.80, polish * 0.5);
  // the tining is worn shallow in the wheel path
  h += tineG * polish * 0.05;

  // ---- distress ----------------------------------------------------------
  // Corner cracks and mid-panel cracks, always starting at a joint.
  float crk = owCracks(p * 2.4 + 19.0, P * 2.4, 0.85, 0.026, 0.74 - age * 0.20);
  crk *= 0.4 + 0.8 * age;
  h -= crk * 0.10;
  ao -= crk * 0.42;
  c = mix(c, cDark * 0.8, crk * 0.55);

  // spalling along the joints — the arris breaks away and is patched with tar
  float spall = (1.0 - smoothstep(0.0, 0.035, dj)) * smoothstep(0.55, 0.85, owFbm01(p * 6.0, P * 6.0, 4, 0.5)) * age;
  h -= spall * 0.12;
  ao -= spall * 0.30;
  c = mix(c, mix(cDark, owSRGB(vec3(0.070, 0.068, 0.070)), 0.6), spall * 0.7);

  // ---- staining ----------------------------------------------------------
  // Tyre rubber lays a dark film; carbonation and lime leach put a pale bloom
  // along the joints. Both are what stop a slab reading as flat grey card.
  float rubber = smoothstep(0.3, 0.9, owFbm01(vec2(p.x * 1.4, p.y * 3.2), vec2(P.x * 1.4, P.y * 3.0), 4, 0.55));
  c *= 1.0 - rubber * 0.16 * (0.3 + 0.7 * lane);
  float bloom = smoothstep(0.55, 0.9, owFbm01(p * 4.0 + 7.0, P * 4.0, 4, 0.55)) * (0.4 + 0.6 * jointM);
  c = mix(c, cPale * 1.06, bloom * 0.30);
  rough += bloom * 0.05;

  float cavity = 1.0 - smoothstep(0.46, 0.70, h);
  c = mix(c, owSRGB(vec3(0.180, 0.175, 0.168)), cavity * 0.30);

  alb = clamp(c, vec3(0.02), vec3(0.82));
  rough = clamp(rough, 0.32, 0.99);
  ao = clamp(ao, 0.30, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * GRANITE SETTS / BELGIAN BLOCK — the old districts.
 *
 * uParam.x  fan 0..1     0 = straight courses, 1 = a laid fan (Segmentbogen)
 * uParam.y  fill 0..1    0 = sand/grit joints, 1 = joints flooded with tar
 * uParam.z  wear 0..1    crowns polished flat, blocks settled out of plane
 * uParam.w  stone 0..1   0 = grey granite, 1 = the warm Pittsburgh sandstone
 */
export const COBBLE = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 3.3;

  float fan   = clamp(uParam.x, 0.0, 1.0);
  float fill  = clamp(uParam.y, 0.0, 1.0);
  float wear  = clamp(uParam.z, 0.0, 1.0);
  float warm  = clamp(uParam.w, 0.0, 1.0);

  // ---- the lattice -------------------------------------------------------
  // 10x20 cm setts. Straight courses shift half a block each row; the fan
  // rotates the whole lattice by an angle that varies across the tile, which is
  // how a real Segmentbogen pavement is laid around a crown.
  vec2 q = uv;
  float ang = (q.x - 0.5) * fan * 1.15;
  q = owRot(q - 0.5, ang * (1.0 - abs(q.y - 0.5) * 0.6)) + 0.5;

  const float COLS = 10.0, ROWS = 10.0;
  float rowF = q.y * ROWS;
  float row = floor(rowF);
  float colF = q.x * COLS + mod(row, 2.0) * 0.5;
  float col = floor(colF);
  vec2 id = vec2(mod(col, COLS), row);
  vec2 f = vec2(fract(colF), fract(rowF));

  vec4 rnd = owHash42(id + uSeed * 2.0);
  vec4 rnd2 = owHash42(id * 1.71 + 13.0 + uSeed);

  // Hand-split blocks are not square: each is a few percent off in both axes
  // and rotated a degree or two in its bed.
  vec2 fj = f + (rnd.xy - 0.5) * vec2(0.09, 0.09);
  fj = owRot(fj - 0.5, (rnd2.x - 0.5) * 0.14) + 0.5;

  // The joint is wide — 12-20 mm — and irregular, because the blocks are not.
  float jw = 0.085 + 0.045 * rnd.z;
  float dx = min(fj.x, 1.0 - fj.x);
  float dy = min(fj.y, 1.0 - fj.y);
  float edgeD = min(dx, dy);
  // a rounded crown, not a chamfered box: a sett is a domed lump of rock
  float crown = smoothstep(jw * 0.35, jw * 2.6, edgeD);
  float face = smoothstep(jw * 0.55, jw * 1.05, edgeD);

  // ---- the stone ---------------------------------------------------------
  vec2 bp = fj * 3.0 + rnd.zw * 23.0;
  vec2 BP = vec2(30.0);
  float grainN = owFbm01(bp * 3.0, BP, 4, 0.5);
  float grainF = owFbm01(bp * 8.0, BP * 2.5, 4, 0.5);
  vec4 speck = owWorley(bp * 10.0, BP * 3.5, 1.0);

  vec3 gA = owSRGB(vec3(0.360, 0.352, 0.342));   // grey granite
  vec3 gB = owSRGB(vec3(0.238, 0.234, 0.232));   // dark, iron-rich
  vec3 gC = owSRGB(vec3(0.470, 0.452, 0.420));   // pale, feldspar-heavy
  vec3 sA = owSRGB(vec3(0.435, 0.362, 0.278));   // Pittsburgh sandstone
  vec3 sB = owSRGB(vec3(0.322, 0.256, 0.196));
  vec3 base = mix(mix(gA, gB, rnd.z), mix(sA, sB, rnd.z), warm);
  base = mix(base, gC, step(0.86, rnd.w) * (1.0 - warm) * 0.7);
  // every block came out of a different part of the quarry
  base *= 0.86 + 0.28 * rnd2.y;
  base *= 0.90 + 0.20 * grainN;
  // the crystal speckle you only see at half a metre
  base = mix(base, base * 1.30, smoothstep(0.30, 0.02, speck.x) * step(0.55, speck.z) * 0.55);
  base = mix(base, base * 0.66, smoothstep(0.26, 0.02, speck.y) * step(0.80, speck.w) * 0.6);
  base *= 0.92 + 0.16 * grainF;

  // Iron-shod wheels and a century of feet polish the crown to a dark shine
  // and leave the flanks of the block rough — that separation is the whole
  // look of a cobbled street.
  float polish = smoothstep(0.35, 1.0, crown) * wear;
  vec3 stoneC = mix(base, base * 0.62, polish * 0.55);
  float stoneR = mix(0.86 - grainF * 0.10, 0.30, polish) + (rnd2.z - 0.5) * 0.12;

  // tool marks on the un-polished flanks
  float chisel = owScratches(bp * 2.0, BP, 9.0, 1.0, 0.62) * (1.0 - polish);
  stoneC *= 1.0 - chisel * 0.10;

  float faceH = 0.78 + (rnd2.w - 0.5) * 0.14 * (0.4 + wear);   // blocks settle
  faceH += (crown - 1.0) * 0.10;                               // domed top
  faceH += (grainN - 0.5) * 0.02;
  // chipped corners
  float chip = smoothstep(0.55, 0.20, edgeD / jw)
             * smoothstep(0.62, 0.82, owFbm01(bp * 6.0, BP * 2.0, 4, 0.5)) * step(0.55, rnd2.x);
  faceH -= chip * 0.10;
  stoneC = mix(stoneC, base * 1.25, chip * 0.4);

  // ---- the joint ---------------------------------------------------------
  // Sand and street grit packed down hard, or — on a road that has been
  // resurfaced around the setts — bitumen poured in flush.
  float jGrit = owFbm01(p * 18.0, P * 18.0, 4, 0.5);
  vec3 jSand = owSRGB(vec3(0.285, 0.268, 0.238)) * (0.82 + 0.36 * jGrit);
  vec3 jTar = owSRGB(vec3(0.062, 0.060, 0.062)) * (0.85 + 0.3 * jGrit);
  vec3 jointC = mix(jSand, jTar, fill);
  float jointR = mix(0.95, 0.46, fill);
  // grass and moss find the joints on a quiet street
  float moss = smoothstep(0.70, 0.92, owFbm01(p * 3.2 + 27.0, P * 3.2, 5, 0.6)) * (1.0 - fill) * (1.0 - wear * 0.6);
  jointC = mix(jointC, owSRGB(vec3(0.128, 0.158, 0.085)), moss * 0.7);

  float m = face;
  h = mix(0.60 - 0.10 * (1.0 - fill) + (jGrit - 0.5) * 0.03, faceH, m);
  vec3 c = mix(jointC, stoneC, m);
  rough = mix(jointR, stoneR, m);
  ao = mix(0.34, 1.0, smoothstep(0.0, 0.85, crown));
  metal = 0.0;

  // ---- the whole surface -------------------------------------------------
  // Ruts: a cobbled street sinks into two hollows over decades, which is a
  // metre-scale swale the block lattice cannot carry.
  float rut = owFbm01(owWarp(p * 0.55 + 5.0, P * 0.55, 0.7, 3), P * 0.55, 4, 0.6);
  h += (rut - 0.5) * 0.09;
  c *= 0.90 + 0.20 * rut;

  // dirt washed into the low ground
  float cavity = 1.0 - smoothstep(0.52, 0.80, h);
  c = mix(c, owSRGB(vec3(0.135, 0.128, 0.115)), cavity * 0.42);
  rough += cavity * 0.05;

  // oil and rubber down the middle of the running surface
  float film = smoothstep(0.58, 0.90, owFbm01(owWarp(p * 1.7 + 41.0, P * 1.7, 0.8, 3), P * 1.7, 4, 0.55)) * wear;
  c = mix(c, owSRGB(vec3(0.062, 0.060, 0.058)), film * 0.35);
  rough -= film * 0.10;

  alb = clamp(c, vec3(0.02), vec3(0.80));
  rough = clamp(rough, 0.22, 0.99);
  ao = clamp(ao, 0.18, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * CLAY PAVER STREET — the brick roads of Lawrenceville and the South Side.
 * uParam.x  herringbone 0..1   0 = running bond, 1 = 45-degree herringbone
 * uParam.y  wear 0..1
 * uParam.z  missing 0..1       pavers lifted out and patched with asphalt
 */
export const STREET_BRICK = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 8.8;

  float herring = clamp(uParam.x, 0.0, 1.0);
  float wear    = clamp(uParam.y, 0.0, 1.0);
  float missing = clamp(uParam.z, 0.0, 1.0);

  // ---- lattice: 10x20 cm pavers ------------------------------------------
  // Herringbone is two interleaved families at right angles. Selecting between
  // them on a 2x2 super-cell gives the real basket/zigzag rather than a rotated
  // running bond, and it is what a paved street actually looks like from a car.
  vec2 g = uv * 8.0;
  vec2 sc = floor(g * 0.5);
  float pick = mod(sc.x + sc.y, 2.0);
  vec2 tA = vec2(uv.x * 8.0, uv.y * 16.0);
  vec2 tB = vec2(uv.x * 16.0, uv.y * 8.0);
  vec2 tRun = vec2(uv.x * 8.0 + mod(floor(uv.y * 16.0), 2.0) * 0.5, uv.y * 16.0);
  vec2 tHer = mix(tA, tB, pick);
  vec2 t = mix(tRun, tHer, step(0.5, herring));

  vec2 id = floor(t);
  vec2 f = fract(t);
  vec4 rnd = owHash42(id + uSeed * 1.3);
  vec4 rnd2 = owHash42(id * 2.13 + 7.0 + uSeed);

  vec2 fj = f + (rnd.xy - 0.5) * 0.045;
  float jw = 0.045 + 0.02 * rnd.z;
  float dx = min(fj.x, 1.0 - fj.x);
  float dy = min(fj.y, 1.0 - fj.y);
  float edgeD = min(dx, dy);
  float face = smoothstep(jw * 0.5, jw * 1.05, edgeD);
  float crown = smoothstep(jw * 0.4, jw * 3.2, edgeD);

  // ---- the paver ---------------------------------------------------------
  // Vitrified street brick is much harder and darker than a building brick:
  // deep red-brown to near-purple, with a fired skin that goes glassy.
  vec2 bp = fj * vec2(2.4, 1.0) + rnd.zw * 19.0;
  vec2 BP = vec2(26.0);
  float faceN = owFbm01(bp * 2.6, BP, 5, 0.5);
  float faceG = owFbm01(bp * 8.0, BP * 3.0, 4, 0.55);
  vec4 pore = owWorley(bp * 9.0, BP * 3.5, 1.0);

  vec3 bA = owSRGB(vec3(0.352, 0.186, 0.140));   // red
  vec3 bB = owSRGB(vec3(0.238, 0.132, 0.118));   // deep
  vec3 bC = owSRGB(vec3(0.156, 0.112, 0.118));   // over-fired purple
  vec3 bD = owSRGB(vec3(0.420, 0.300, 0.196));   // buff
  vec3 brick = mix(bA, bB, rnd.z);
  brick = mix(brick, bC, step(0.80, rnd.w) * 0.75);
  brick = mix(brick, bD, step(0.93, rnd2.x) * 0.6);
  brick *= 0.86 + 0.28 * rnd2.y;
  brick *= 0.88 + 0.24 * faceN;
  brick *= 0.88 + 0.24 * faceG;
  brick = mix(brick, brick * 0.60, smoothstep(0.22, 0.0, pore.x) * step(0.6, pore.w) * 0.8);
  // the maker's name is stamped into the face and holds dirt
  float stamp = (1.0 - smoothstep(0.0, 0.04, abs(fj.y - 0.5)))
              * smoothstep(0.16, 0.22, abs(fj.x - 0.5)) * step(0.5, rnd2.z);

  // Vitrified skin: polished glassy on the crown where traffic runs, matt on
  // the flanks. This is a much stronger gloss split than a building brick has.
  float polish = smoothstep(0.30, 1.0, crown) * wear;
  float faceR = mix(0.72 - faceG * 0.12, 0.24, polish) + (rnd2.w - 0.5) * 0.14;
  brick = mix(brick, brick * 0.66, polish * 0.45);

  float faceH = 0.80 + (rnd2.w - 0.5) * 0.11 * (0.4 + wear);
  faceH += (crown - 1.0) * 0.055;
  faceH -= stamp * 0.05;
  float chip = smoothstep(0.5, 0.15, edgeD / jw)
             * smoothstep(0.6, 0.82, owFbm01(bp * 7.0, BP * 2.5, 4, 0.5)) * step(0.5, rnd.w);
  faceH -= chip * 0.11;
  brick = mix(brick, brick * 1.20 + owSRGB(vec3(0.05, 0.03, 0.02)), chip * 0.5);

  // ---- joints ------------------------------------------------------------
  float jGrit = owFbm01(p * 18.0, P * 18.0, 4, 0.5);
  vec3 jointC = owSRGB(vec3(0.140, 0.130, 0.115)) * (0.80 + 0.40 * jGrit);
  float m = face;
  h = mix(0.62 + (jGrit - 0.5) * 0.03, faceH, m);
  vec3 c = mix(jointC, brick, m);
  rough = mix(0.94, faceR, m);
  ao = mix(0.30, 1.0, smoothstep(0.0, 0.85, crown));
  metal = 0.0;

  // ---- asphalt patches where pavers were lifted --------------------------
  float patchF = owFbm01(owWarp(p * 0.8 + 33.0, P * 0.8, 0.9, 3), P * 0.8, 4, 0.58);
  float repairM = smoothstep(0.78 - missing * 0.30, 0.86 - missing * 0.28, patchF);
  vec3 tar = owSRGB(vec3(0.085, 0.083, 0.086)) * (0.85 + 0.35 * owFbm01(p * 12.0, P * 12.0, 4, 0.5));
  c = mix(c, tar, repairM * 0.92);
  rough = mix(rough, 0.72, repairM * 0.9);
  h = mix(h, 0.70, repairM * 0.85);
  ao = mix(ao, 0.92, repairM * 0.8);
  float patchEdge = max(smoothstep(0.74 - missing * 0.30, 0.80 - missing * 0.28, patchF) - repairM, 0.0);
  h -= patchEdge * 0.05;
  ao -= patchEdge * 0.25;

  // ---- the whole street --------------------------------------------------
  float rut = owFbm01(owWarp(p * 0.6 + 11.0, P * 0.6, 0.7, 3), P * 0.6, 4, 0.6);
  h += (rut - 0.5) * 0.07;
  c *= 0.90 + 0.20 * rut;

  float cavity = 1.0 - smoothstep(0.56, 0.82, h);
  c = mix(c, owSRGB(vec3(0.115, 0.105, 0.095)), cavity * 0.44);

  alb = clamp(c, vec3(0.02), vec3(0.72));
  rough = clamp(rough, 0.18, 0.99);
  ao = clamp(ao, 0.16, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * ROAD MARKINGS — a decal surface. 'h' carries the CUTOUT MASK, not a height
 * (see generator.js), so the paint's shape is its alpha and the road shows
 * through everywhere else.
 *
 * uParam.x  glyph  0 solid line · 1 dashed · 2 double solid · 3 straight arrow
 *                  4 turn arrow · 5 crossing bars · 6 stop bar · 7 hatch box
 * uParam.y  wear 0..1
 * uParam.z  colour 0 = white, 1 = highway yellow
 * uParam.w  junction 0..1  — extra scrub where traffic turns across the mark
 *
 * uv.y runs ALONG the marking, uv.x across it.
 */
export const ROAD_PAINT = /* glsl */ `
float owBar(float x, float a, float b, float soft){
  return smoothstep(a - soft, a + soft, x) * (1.0 - smoothstep(b - soft, b + soft, x));
}

void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 5.5;

  int glyph = int(uParam.x + 0.5);
  float wear = clamp(uParam.y, 0.0, 1.0);
  float yellow = clamp(uParam.z, 0.0, 1.0);
  float junction = clamp(uParam.w, 0.0, 1.0);

  // ---- the glyph ---------------------------------------------------------
  float mask = 0.0;
  const float SOFT = 0.006;

  if (glyph == 0) {
    mask = owBar(uv.x, 0.36, 0.64, SOFT);
  } else if (glyph == 1) {
    // 3 m mark, 9 m gap — the standard lane dash, four cycles per tile
    mask = owBar(uv.x, 0.36, 0.64, SOFT) * owBar(fract(uv.y * 4.0), 0.03, 0.28, 0.012);
  } else if (glyph == 2) {
    mask = max(owBar(uv.x, 0.22, 0.40, SOFT), owBar(uv.x, 0.60, 0.78, SOFT));
  } else if (glyph == 3 || glyph == 4) {
    // shaft
    float shaft = owBar(uv.x, 0.44, 0.56, SOFT) * owBar(uv.y, 0.08, 0.62, 0.010);
    // head: a triangle pinching to the tip
    float ty = smoothstep(0.58, 0.94, uv.y);
    float halfW = mix(0.20, 0.0, ty);
    float head = owBar(uv.x, 0.5 - halfW, 0.5 + halfW, SOFT) * owBar(uv.y, 0.58, 0.95, 0.010);
    mask = max(shaft, head);
    if (glyph == 4) {
      // a turn barb striking off to the left at mid height
      float barb = owBar(uv.y, 0.30, 0.42, 0.010) * owBar(uv.x, 0.16, 0.50, SOFT);
      float bh = smoothstep(0.14, 0.30, uv.x);
      float bhw = mix(0.0, 0.085, bh);
      float bHead = owBar(uv.y, 0.36 - bhw, 0.36 + bhw, 0.008) * owBar(uv.x, 0.10, 0.24, SOFT);
      mask = max(mask, max(barb, bHead));
    }
  } else if (glyph == 5) {
    // continental crossing: 50 cm bars on a 1 m pitch, running across
    mask = owBar(fract(uv.y * 5.0), 0.06, 0.54, 0.014) * owBar(uv.x, 0.03, 0.97, SOFT);
  } else if (glyph == 6) {
    mask = owBar(uv.y, 0.34, 0.66, 0.010) * owBar(uv.x, 0.02, 0.98, SOFT);
  } else {
    // hatched keep-clear box: diagonals inside a border
    float border = max(max(owBar(uv.x, 0.0, 0.055, SOFT), owBar(uv.x, 0.945, 1.0, SOFT)),
                       max(owBar(uv.y, 0.0, 0.055, 0.008), owBar(uv.y, 0.945, 1.0, 0.008)));
    float diag = owBar(fract((uv.x + uv.y) * 5.0), 0.0, 0.22, 0.02);
    mask = clamp(border + diag * 0.92, 0.0, 1.0);
  }

  // ---- the paint itself --------------------------------------------------
  // Hot thermoplastic, 2-3 mm thick, loaded with glass beads for retro-
  // reflection. Fresh it is bright and matt; the beads are what make it flare
  // in a headlight, and they are the first thing to wear off.
  float beadN = owFbm01(p * 20.0, P * 20.0, 4, 0.5);
  vec4 bead = owWorley(p * 22.0, P * 22.0, 1.0);
  float beadM = smoothstep(0.24, 0.03, bead.x) * step(0.45, bead.z);

  vec3 cWhite = owSRGB(vec3(0.830, 0.822, 0.800));
  vec3 cYellow = owSRGB(vec3(0.780, 0.590, 0.120));
  vec3 c = mix(cWhite, cYellow, yellow);
  // Never a clean swatch: the paint greys with traffic film and the road's own
  // texture prints through the thin edges of the stroke. But it must still read
  // as WHITE against asphalt from fifty metres, which is the entire reason it
  // is painted, so the dimming is one term and not three stacked ones.
  c *= 0.90 + 0.16 * beadN;
  c = mix(c, c * 0.74, smoothstep(0.42, 0.90, owFbm01(p * 3.0, P * 3.0, 4, 0.55)) * (0.20 + 0.42 * wear));
  c = mix(c, c * 1.22, beadM * 0.5);

  rough = 0.70 + (beadN - 0.5) * 0.16 - beadM * 0.30;
  metal = 0.0;
  ao = 1.0;

  // ---- WEAR --------------------------------------------------------------
  // This is the whole point of the surface. Paint does not fade evenly: it is
  // abraded away in the two wheel tracks and scrubbed to nothing where traffic
  // turns across it at a junction. A uniformly faded line is the tell that a
  // road was drawn rather than driven on.
  /**
   * WHERE THE WHEELS ACTUALLY ARE.
   *
   * This is the whole point of the surface, and it is direction-dependent. A
   * lane line lives BETWEEN the two wheel tracks — that is why it survives for
   * years while the crossing forty metres away is scrubbed to nothing in one
   * winter. So a longitudinal mark only sees lane-change traffic and its own
   * edges going first, while a transverse mark (crossing, stop bar, arrow) has
   * every wheel in the city driving straight over it in two bands along v.
   *
   * The first pass applied the LONGITUDINAL track mask to every glyph, and
   * since those bands cover half the tile width they ate the lane lines
   * outright: the markings were invisible in the frame.
   */
  bool transverse = (glyph >= 3);
  float trackV = max(1.0 - smoothstep(0.03, 0.15, abs(uv.y - 0.32)),
                     1.0 - smoothstep(0.03, 0.15, abs(uv.y - 0.70)));
  float wheel = transverse ? trackV : 0.0;

  float scrub = owFbm01(owWarp(p * 3.2 + 17.0, P * 3.2, 0.8, 3), P * 3.2, 5, 0.55);
  float flake = owFbm01(p * 9.0 + 5.0, P * 9.0, 4, 0.5);
  // The stroke edge always goes first: it is thinner, it is where the die ran
  // out, and it is what a snowplough catches.
  float edge = 1.0 - smoothstep(0.0, 0.14, min(mask, 1.0 - mask) * 2.0);
  // Where the wheels run the paint is gone in patches down to the aggregate;
  // between them it survives with its edges nibbled.
  float loss = wear * (0.22 + 1.00 * wheel + 0.55 * junction * (0.35 + 0.65 * wheel)
                     + 0.45 * edge);
  float eaten = smoothstep(0.56 - loss * 0.42, 0.86 - loss * 0.26, scrub * 0.6 + flake * 0.55);
  // paint chips off in flakes with hard edges, not with a soft gradient
  eaten = smoothstep(0.20, 0.70, eaten);

  float alpha = mask * (1.0 - eaten * 0.90);

  // What survives in a worn track is a thin grey ghost, not clean paint.
  float thin = 1.0 - smoothstep(0.15, 0.75, alpha);
  c = mix(c, c * 0.62 + owSRGB(vec3(0.075, 0.074, 0.070)), thin * 0.7);
  rough += thin * 0.20;

  // tyre-black skid film laid over the paint at a stop line
  float skid = smoothstep(0.55, 0.90, owFbm01(vec2(p.x * 1.2, p.y * 5.0), vec2(P.x, P.y * 5.0), 4, 0.55))
             * (junction * 0.7 + wear * 0.3);
  c = mix(c, owSRGB(vec3(0.075, 0.073, 0.072)), skid * 0.45);
  rough -= skid * 0.10;

  // h is the cutout mask for an alpha-tested decal.
  h = clamp(alpha, 0.0, 1.0);
  alb = clamp(c, vec3(0.02), vec3(0.86));
  rough = clamp(rough, 0.20, 0.99);
  ao = clamp(1.0 - thin * 0.12, 0.7, 1.0);
}
`;

/**
 * KERB STONE. Mapped so the tile runs ALONG the kerb; the world projection puts
 * the same texture on the top, the face and the gutter return, which is right —
 * they are one lump of stone.
 *
 * uParam.x  material 0 = granite kerb, 1 = precast concrete
 * uParam.y  wear 0..1   tyre rub, chipped arris, settled joints
 * uParam.z  paint 0..1  the yellow/red no-parking stripe, worn
 */
export const KERB = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 7.1;

  float precast = clamp(uParam.x, 0.0, 1.0);
  float wear    = clamp(uParam.y, 0.0, 1.0);
  float paint   = clamp(uParam.z, 0.0, 1.0);

  // ---- stones every 0.9 m ------------------------------------------------
  float sF = uv.x * 4.0;
  float sId = floor(sF);
  float sf = fract(sF);
  vec4 rnd = owHash42(vec2(sId, 0.0) + uSeed * 3.0);
  // The joint between kerb stones is 6-10 mm of mortar that has mostly failed.
  float dj = min(sf, 1.0 - sf);
  float joint = 1.0 - smoothstep(0.004, 0.014, dj);
  // stones settle out of line with one another — the arris is never straight
  float step1 = (rnd.x - 0.5) * 0.055 * (0.35 + wear);

  float grain = owFbm01(p * 3.0, P * 3.0, 5, 0.5);
  float fine  = owFbm01(p * 14.0, P * 14.0, 4, 0.5);
  vec4 speck  = owWorley(p * 20.0, P * 20.0, 1.0);

  vec3 granite = owSRGB(vec3(0.352, 0.348, 0.342)) * (0.86 + 0.28 * rnd.y);
  granite = mix(granite, granite * 1.34, smoothstep(0.28, 0.02, speck.x) * step(0.55, speck.z) * 0.55);
  granite = mix(granite, granite * 0.62, smoothstep(0.24, 0.02, speck.y) * step(0.82, speck.w) * 0.6);
  vec3 conc = owSRGB(vec3(0.470, 0.462, 0.446)) * (0.90 + 0.20 * rnd.z);
  vec3 c = mix(granite, conc, precast);
  c *= 0.91 + 0.18 * grain;
  c *= 0.94 + 0.12 * fine;

  h = 0.76 + (grain - 0.5) * 0.045 + (fine - 0.5) * 0.02 + step1;
  rough = mix(0.66 + grain * 0.20, 0.88 + fine * 0.10, precast);
  metal = 0.0;
  ao = 1.0;

  h -= joint * 0.09;
  ao -= joint * 0.55;
  c = mix(c, c * 0.42, joint * 0.7);

  // ---- the arris ---------------------------------------------------------
  // The top front edge of a kerb takes every wheel, every shovel and every
  // snowplough. It is rounded, chipped, and rubbed to bare stone.
  float arris = 1.0 - smoothstep(0.0, 0.10, abs(uv.y - 0.5));
  float chipF = owFbm01(vec2(p.x * 6.0, p.y * 2.0), vec2(P.x * 6.0, P.y * 2.0), 4, 0.5);
  float chip = arris * smoothstep(0.60 - wear * 0.20, 0.80 - wear * 0.15, chipF);
  h -= chip * 0.13;
  c = mix(c, c * 1.28, chip * 0.55);       // fresh fracture is bright
  ao -= chip * 0.20;
  rough += chip * 0.10;
  // and where it is not chipped it is polished by rubbing
  float rub = arris * wear * (1.0 - chip);
  c = mix(c, c * 0.78, rub * 0.35);
  rough -= rub * 0.22;

  // ---- tyre scuff --------------------------------------------------------
  float scuff = smoothstep(0.55, 0.88, owFbm01(vec2(p.x * 4.0, p.y * 1.2), vec2(P.x * 4.0, P.y), 4, 0.55))
              * arris * wear;
  c = mix(c, owSRGB(vec3(0.078, 0.076, 0.076)), scuff * 0.55);
  rough += scuff * 0.05;
  // and the white/grey smear of a wheel rim scraping it
  float rim = smoothstep(0.80, 0.95, owFbm01(vec2(p.x * 9.0, p.y * 1.0), vec2(P.x * 9.0, P.y), 3, 0.5)) * arris * wear;
  c = mix(c, owSRGB(vec3(0.520, 0.515, 0.505)), rim * 0.4);

  // ---- the no-parking stripe ---------------------------------------------
  // Painted straight onto the stone, so it follows the chips and dies in them.
  float band = smoothstep(0.06, 0.14, uv.y) * (1.0 - smoothstep(0.62, 0.72, uv.y));
  float pLoss = smoothstep(0.30, 0.72, owFbm01(p * 5.0 + 21.0, P * 5.0, 4, 0.55) + chip * 0.8 + rub * 0.5);
  float pm = paint * band * (1.0 - pLoss * 0.9);
  vec3 pc = owSRGB(vec3(0.700, 0.470, 0.090));
  c = mix(c, pc * (0.75 + 0.35 * fine), pm * 0.9);
  rough = mix(rough, 0.62, pm * 0.8);
  h += pm * 0.012;

  // ---- gutter grime ------------------------------------------------------
  // Everything the street sweeps ends up in the last 10 cm: silt, salt, leaf
  // mould and the black line where the water runs.
  float gut = smoothstep(0.30, 0.02, uv.y);
  float gutN = owFbm01(vec2(p.x * 3.0, p.y * 6.0), vec2(P.x * 3.0, P.y * 6.0), 4, 0.55);
  c = mix(c, owSRGB(vec3(0.108, 0.100, 0.086)), gut * (0.35 + 0.45 * gutN) * 0.8);
  rough += gut * 0.10;
  // salt / lime bloom above the water line
  float bloom = smoothstep(0.28, 0.44, uv.y) * (1.0 - smoothstep(0.44, 0.60, uv.y));
  c = mix(c, owSRGB(vec3(0.600, 0.588, 0.560)), bloom * smoothstep(0.5, 0.85, gutN) * 0.35);

  float cavity = 1.0 - smoothstep(0.60, 0.82, h);
  c = mix(c, owSRGB(vec3(0.140, 0.132, 0.120)), cavity * 0.38);

  alb = clamp(c, vec3(0.02), vec3(0.82));
  rough = clamp(rough, 0.24, 0.99);
  ao = clamp(ao, 0.20, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * CAST-IRON STREET FURNITURE — manhole covers and gutter grates, on mesh UVs so
 * one quad is exactly one casting.
 *
 * uParam.x  kind 0 = round manhole cover, 1 = rectangular gutter grate,
 *                2 = square utility/valve lid
 * uParam.y  wear 0..1
 * uParam.z  silt 0..1  (grates only) how choked the slots are
 */
export const IRON_COVER = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 2.9;
  int kind = int(uParam.x + 0.5);
  float wear = clamp(uParam.y, 0.0, 1.0);
  float silt = clamp(uParam.z, 0.0, 1.0);

  vec2 q = uv - 0.5;
  float r = length(q);
  float a = atan(q.y, q.x);

  // ---- the road it is set into -------------------------------------------
  // Everything outside the casting is the asphalt collar the crew hand-packed
  // around it, which is always a shade off the road and always cracked.
  float aggN = owFbm01(p * 12.0, P * 12.0, 4, 0.5);
  vec4 aggW = owWorley(p * 16.0, P * 16.0, 1.0);
  vec3 road = owSRGB(vec3(0.115, 0.113, 0.115)) * (0.85 + 0.35 * aggN);
  road = mix(road, owSRGB(vec3(0.300, 0.292, 0.278)), smoothstep(0.30, 0.08, aggW.x) * 0.45);
  float roadH = 0.56 + (aggN - 0.5) * 0.06;
  float roadR = 0.86 + (aggN - 0.5) * 0.12;

  // ---- iron --------------------------------------------------------------
  // Cast iron under a street is never bare: it is polished to bright metal
  // where wheels hit the pattern, and rusted to matt brown everywhere else.
  float grain = owFbm01(p * 9.0, P * 9.0, 4, 0.5);
  float sandC = owFbm01(p * 20.0, P * 20.0, 4, 0.5);        // sand-cast skin
  float rustF = smoothstep(0.42, 0.86, 1.0 - owBillow(owWarp(p * 1.6, P * 1.6, 1.0, 4), P * 1.6, 5, 0.6));
  vec3 rustCol = owRustColour(rustF, sandC);
  vec3 iron = owSRGB(vec3(0.148, 0.150, 0.155)) * (0.85 + 0.30 * grain);
  iron *= 0.92 + 0.16 * sandC;

  float shape = 0.0;   // 1 inside the casting
  float pat = 0.0;     // raised pattern
  float slot = 0.0;    // through-slot (deep, dark)
  float ring = 0.0;    // the frame / seating ring

  if (kind == 0) {
    shape = 1.0 - smoothstep(0.415, 0.435, r);
    ring = smoothstep(0.360, 0.378, r) * (1.0 - smoothstep(0.405, 0.425, r));
    // the classic diamond waffle, plus a lettered outer band
    vec2 d = vec2(a * 3.8197, r * 22.0);      // ~24 diamonds around
    vec2 df = abs(fract(d + 0.5) - 0.5);
    float diamond = 1.0 - smoothstep(0.16, 0.34, df.x + df.y);
    pat = diamond * (1.0 - smoothstep(0.320, 0.345, r)) * step(0.055, r);
    // the pick hole and the centre boss
    float boss = 1.0 - smoothstep(0.055, 0.075, r);
    pat = max(pat, boss * 0.8);
    float pick = (1.0 - smoothstep(0.016, 0.028, length(q - vec2(0.0, 0.20))));
    slot = pick;
    // lettering band: a broken ring of glyph-ish bumps
    float lb = smoothstep(0.330, 0.345, r) * (1.0 - smoothstep(0.372, 0.384, r));
    float glyphs = step(0.45, owHash11(floor(a * 9.0) + uSeed * 3.0))
                 * (1.0 - smoothstep(0.22, 0.40, abs(fract(a * 9.0) - 0.5)));
    pat = max(pat, lb * glyphs);
  } else if (kind == 1) {
    // a gutter grate: a frame with long parallel bars
    vec2 e = abs(q);
    shape = (1.0 - smoothstep(0.455, 0.470, e.x)) * (1.0 - smoothstep(0.320, 0.335, e.y));
    float inner = (1.0 - smoothstep(0.385, 0.400, e.x)) * (1.0 - smoothstep(0.255, 0.270, e.y));
    ring = shape - inner;
    // 9 slots running across
    float bars = abs(fract(uv.x * 9.0) - 0.5) * 2.0;
    slot = inner * (1.0 - smoothstep(0.30, 0.55, bars));
    pat = inner * smoothstep(0.55, 0.80, bars) * 0.7;
    // the two cross-ribs that stop the bars ringing
    float rib = (1.0 - smoothstep(0.02, 0.05, abs(abs(q.y) - 0.14)));
    slot *= 1.0 - rib;
    pat = max(pat, inner * rib * 0.8);
  } else {
    vec2 e = abs(q);
    shape = (1.0 - smoothstep(0.360, 0.375, max(e.x, e.y)));
    ring = shape * smoothstep(0.300, 0.318, max(e.x, e.y));
    float grid = max(abs(fract(uv.x * 7.0) - 0.5), abs(fract(uv.y * 7.0) - 0.5)) * 2.0;
    pat = shape * smoothstep(0.45, 0.80, grid) * 0.85;
    slot = (1.0 - smoothstep(0.014, 0.026, length(q - vec2(0.13, 0.0))))
         + (1.0 - smoothstep(0.014, 0.026, length(q + vec2(0.13, 0.0))));
  }

  // Wheels hit the raised pattern and nothing else, so the pattern is bright
  // polished steel and the field between it is rust. That contrast is the whole
  // read of a cover from three metres up.
  float polish = pat * (0.35 + 0.65 * wear);
  vec3 ic = mix(iron, rustCol, rustF * (1.0 - polish * 0.85));
  ic = mix(ic, owSRGB(vec3(0.480, 0.485, 0.492)), polish * 0.55);
  float iRough = mix(mix(0.55 + grain * 0.20, 0.90, rustF), 0.22, polish * 0.8);
  float iMetal = mix(mix(1.0, 0.0, smoothstep(0.15, 0.6, rustF)), 1.0, polish * 0.8);

  float iH = 0.66 + pat * 0.16 + ring * 0.07 + (grain - 0.5) * 0.03 + (sandC - 0.5) * 0.02;
  iH -= slot * 0.55;
  // the casting sits a few millimetres low in the road and its collar is worn
  iH -= 0.035;

  // silt and leaf litter choking the slots
  float siltN = owFbm01(p * 7.0, P * 7.0, 4, 0.55);
  float choke = slot * silt * smoothstep(0.35, 0.75, siltN);
  ic = mix(ic, owSRGB(vec3(0.150, 0.132, 0.098)), choke * 0.85);
  iH += choke * 0.30;
  iMetal *= 1.0 - choke;
  iRough = mix(iRough, 0.95, choke);

  float m = clamp(shape, 0.0, 1.0);
  vec3 c = mix(road, ic, m);
  h = mix(roadH, iH, m);
  rough = mix(roadR, iRough, m);
  metal = iMetal * m;
  ao = 1.0 - slot * m * 0.75 - (1.0 - m) * 0.0;
  // the seating gap between the casting and its frame
  float gap = m * (1.0 - m) * 4.0;
  h -= gap * 0.10;
  ao -= gap * 0.35;
  c = mix(c, owSRGB(vec3(0.045, 0.042, 0.040)), gap * 0.6);

  // grime everywhere it can lodge
  float cavity = 1.0 - smoothstep(0.50, 0.76, h);
  c = mix(c, owSRGB(vec3(0.105, 0.098, 0.088)), cavity * 0.42);
  metal *= 1.0 - cavity * 0.35;

  alb = clamp(c, vec3(0.02), vec3(0.72));
  rough = clamp(rough, 0.16, 0.99);
  metal = clamp(metal, 0.0, 1.0);
  ao = clamp(ao, 0.12, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * EMBEDDED TRAM / STREETCAR RAIL. The tile runs along the track: two grooved
 * rails set in a strip of setts or asphalt, with the railhead polished to a
 * mirror and the flangeway full of black grease and grit.
 *
 * uParam.x  bed 0 = setts, 1 = asphalt
 * uParam.y  use 0..1  0 = abandoned and rusted over, 1 = in daily service
 */
export const TRAM_RAIL = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 6.3;
  float asph = clamp(uParam.x, 0.0, 1.0);
  float use  = clamp(uParam.y, 0.0, 1.0);

  // ---- the bed -----------------------------------------------------------
  float bedN = owFbm01(p * 3.0, P * 3.0, 5, 0.5);
  float bedF = owFbm01(p * 15.0, P * 15.0, 4, 0.5);
  vec4 sett = owWorley(owWarp(p * 5.0, P * 5.0, 0.25, 3), P * 5.0, 0.85);
  float settFace = smoothstep(0.05, 0.16, sett.y - sett.x);
  vec3 settC = owSRGB(vec3(0.320, 0.312, 0.300)) * (0.82 + 0.36 * sett.z);
  settC *= 0.90 + 0.20 * bedN;
  vec3 asphC = owSRGB(vec3(0.115, 0.113, 0.116)) * (0.86 + 0.32 * bedF);
  vec3 bedC = mix(settC, asphC, asph);
  float bedH = mix(0.62 + settFace * 0.10, 0.60 + (bedF - 0.5) * 0.05, asph);
  float bedR = mix(0.86, 0.80, asph);
  float bedAo = mix(mix(0.55, 1.0, settFace), 1.0, asph);

  // ---- two rails at 1.435 m gauge ----------------------------------------
  // One tile spans ~2.4 m, so the rails sit at uv.x 0.20 and 0.80.
  float d = min(abs(uv.x - 0.20), abs(uv.x - 0.80));
  // A grooved (Phoenix) rail: a 55 mm head, a 35 mm flangeway groove beside it,
  // and a keeper lip on the outside of the groove.
  float head = 1.0 - smoothstep(0.020, 0.024, d);
  float groove = (1.0 - smoothstep(0.038, 0.042, d)) * smoothstep(0.026, 0.030, d);
  float lip = (1.0 - smoothstep(0.050, 0.054, d)) * smoothstep(0.042, 0.046, d);
  float rail = clamp(head + groove + lip, 0.0, 1.0);

  // The railhead is the only true mirror on a street: steel wiped clean by a
  // steel wheel every few minutes. It is also the narrowest bright line in the
  // frame, so it is what makes a track read at 60 m.
  float mill = owFbm01(owShear(p * 6.0, 0.0, 30.0), owShearPer(P * 6.0, 30.0), 4, 0.5);
  vec3 bright = owSRGB(vec3(0.560, 0.566, 0.578)) * (0.92 + 0.16 * mill);
  float rustF = smoothstep(0.25, 0.85, (1.0 - use) * 0.9 + owFbm01(p * 2.0 + 9.0, P * 2.0, 4, 0.6) * 0.4);
  vec3 rustC = owRustColour(rustF, bedF);
  vec3 railC = mix(bright, rustC, rustF);
  float railR = mix(0.10 + mill * 0.10, 0.90, rustF);
  float railM = mix(1.0, 0.0, smoothstep(0.2, 0.7, rustF));

  // the web of the rail below the head is never polished
  vec3 webC = mix(owSRGB(vec3(0.180, 0.178, 0.176)), rustC, max(rustF, 0.55));
  railC = mix(webC, railC, head);
  railR = mix(0.88, railR, head);
  railM = mix(mix(1.0, 0.0, 0.6), railM, head);

  // ---- the flangeway -----------------------------------------------------
  // Packed with a black paste of grease, brake dust and grit, and it is the
  // deepest shadow on the street.
  vec3 grease = owSRGB(vec3(0.038, 0.036, 0.034)) * (0.8 + 0.5 * bedF);

  float m = rail;
  vec3 c = mix(bedC, railC, m);
  float hh = mix(bedH, 0.80 + (mill - 0.5) * 0.01, m);
  hh -= groove * 0.42;
  hh -= lip * 0.06;
  c = mix(c, grease, groove * 0.92);
  float rr = mix(bedR, railR, m);
  rr = mix(rr, 0.72, groove * 0.85);
  float mm = railM * m * (1.0 - groove * 0.9);
  float aa = mix(bedAo, 1.0, m) - groove * 0.75;

  // ---- the seam between rail and bed -------------------------------------
  // Sealed with bitumen that has cracked and lets water in; there is always a
  // dark line and always a settled trough along it.
  float seam = (1.0 - smoothstep(0.054, 0.070, d)) * smoothstep(0.050, 0.056, d);
  c = mix(c, owSRGB(vec3(0.055, 0.053, 0.052)), seam * 0.8);
  hh -= seam * 0.10;
  aa -= seam * 0.35;
  rr = mix(rr, 0.55, seam * 0.6);

  // brake dust and grease flung sideways off the wheels
  float fling = (1.0 - smoothstep(0.05, 0.22, d)) * (1.0 - rail);
  c = mix(c, owSRGB(vec3(0.095, 0.088, 0.082)), fling * use * 0.55);
  rr += fling * use * 0.05;

  float cavity = 1.0 - smoothstep(0.50, 0.78, hh);
  c = mix(c, owSRGB(vec3(0.100, 0.094, 0.086)), cavity * 0.40);

  alb = clamp(c, vec3(0.02), vec3(0.78));
  h = clamp(hh, 0.0, 1.0);
  rough = clamp(rr, 0.06, 0.99);
  metal = clamp(mm, 0.0, 1.0);
  ao = clamp(aa, 0.10, 1.0);
}
`;

/**
 * SIDEWALK — cast-in-place concrete flags with tooled joints. The single most
 * common surface a third-person camera looks straight down at.
 *
 * uParam.x  flags per tile (defaults to 2 => 1.2 m flags on a 2.4 m tile)
 * uParam.y  age 0..1
 * uParam.z  repairs 0..1  asphalt cold repairM, utility cuts, tree-root heave
 */
export const SIDEWALK = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 9.4;
  float flags = max(uParam.x, 1.0);
  float age = clamp(uParam.y, 0.0, 1.0);
  float repair = clamp(uParam.z, 0.0, 1.0);

  float macro = owFbm01(p * 0.55, P * 0.55, 4, 0.6);
  float mid   = owFbm01(owWarp(p * 2.4, P * 2.4, 0.6, 3), P * 2.4, 5, 0.5);
  float fine  = owFbm01(p * 17.0, P * 17.0, 4, 0.5);

  vec3 cPale = owSRGB(vec3(0.545, 0.535, 0.512));
  vec3 cMid  = owSRGB(vec3(0.398, 0.392, 0.380));
  vec3 cDark = owSRGB(vec3(0.228, 0.226, 0.224));
  vec3 c = mix(cPale, cMid, smoothstep(0.20, 0.85, macro * 0.55 + age * 0.55));
  c *= 0.93 + 0.14 * fine;

  h = 0.70 + (mid - 0.5) * 0.045 + (fine - 0.5) * 0.025;
  rough = 0.88 + (mid - 0.5) * 0.10;
  metal = 0.0;
  ao = 1.0;

  // ---- flags -------------------------------------------------------------
  vec2 g = uv * vec2(flags, flags * 0.5);
  vec2 gid = floor(g);
  vec2 gf = fract(g);
  vec4 rnd = owHash42(gid + uSeed * 1.9);
  // Each flag was poured on a different day out of a different truck.
  c *= 0.90 + 0.20 * rnd.x;
  rough += (rnd.y - 0.5) * 0.10;
  // and each has settled by a few millimetres, so the joints have a lip
  float settle = (rnd.z - 0.5) * 0.055 * (0.4 + age);
  h += settle;

  // The joint is a TOOLED groove — a jointer run down wet concrete leaves a
  // rounded channel with a raised bead on each side, not a saw cut.
  vec2 dj = min(gf, 1.0 - gf);
  float djm = min(dj.x, dj.y);
  float groove = 1.0 - smoothstep(0.006, 0.020, djm);
  float bead = smoothstep(0.014, 0.024, djm) * (1.0 - smoothstep(0.024, 0.040, djm));
  h -= groove * 0.075;
  h += bead * 0.020;
  ao -= groove * 0.50;
  c = mix(c, cDark * 0.85, groove * 0.55);
  c *= 1.0 + bead * 0.06;
  rough += groove * 0.04;

  // ---- broom finish ------------------------------------------------------
  // Every sidewalk in America is broomed across its width while green. It is a
  // 1-2 mm corduroy that is invisible at 5 m and unmistakable at half a metre,
  // and it is the reason a real sidewalk never reads as a flat grey plane.
  float broom = abs(fract(uv.y * 150.0) - 0.5) * 2.0;
  float broomW = 0.55 + 0.45 * owFbm01(vec2(p.x * 1.5, p.y * 6.0), vec2(P.x * 1.5, P.y * 6.0), 3, 0.55);
  float bg = (1.0 - smoothstep(0.25, 0.85, broom)) * broomW * (1.0 - age * 0.35);
  h -= bg * 0.035;
  ao -= bg * 0.12;
  c *= 1.0 - bg * 0.07;
  rough += bg * 0.04;

  // ---- aggregate + pores -------------------------------------------------
  vec4 agg = owWorley(p * 15.0, P * 15.0, 0.95);
  float aggM = smoothstep(0.42, 0.10, agg.x)
             * step(0.66, owFbm01(p * 3.0 + 5.0, P * 3.0, 3, 0.5) + agg.z * 0.35 + age * 0.35);
  c = mix(c, mix(owSRGB(vec3(0.318, 0.306, 0.290)), owSRGB(vec3(0.572, 0.552, 0.508)), agg.z), aggM * 0.62);
  h += aggM * 0.020;
  vec4 pores = owWorley(p * 21.0, P * 21.0, 1.0);
  float pore = smoothstep(0.24, 0.0, pores.x) * step(0.82, pores.w);
  h -= pore * 0.05;
  ao -= pore * 0.5;

  // ---- damage ------------------------------------------------------------
  // Cracks always start at a joint corner and run to the next joint.
  float crk = owCracks(p * 3.2 + 23.0, P * 3.2, 0.85, 0.024, 0.76 - age * 0.22);
  crk *= 0.35 + 0.9 * age;
  h -= crk * 0.10;
  ao -= crk * 0.44;
  c = mix(c, cDark * 0.72, crk * 0.6);

  // tree-root heave: one flag tilted and broken across
  float heaveN = owFbm01(p * 0.7 + 37.0, P * 0.7, 3, 0.62);
  float heave = smoothstep(0.72, 0.88, heaveN) * age;
  h += heave * 0.055;
  c *= 1.0 - heave * 0.06;

  // asphalt cold repairM over a utility cut
  float patchF = owFbm01(owWarp(p * 0.9 + 47.0, P * 0.9, 0.8, 3), P * 0.9, 4, 0.58);
  float repairM = smoothstep(0.80 - repair * 0.28, 0.87 - repair * 0.26, patchF);
  vec3 tar = owSRGB(vec3(0.095, 0.093, 0.096)) * (0.85 + 0.35 * fine);
  c = mix(c, tar, repairM * 0.9);
  rough = mix(rough, 0.76, repairM * 0.9);
  h = mix(h, 0.66, repairM * 0.8);

  // ---- what a city puts on a sidewalk ------------------------------------
  // Flattened gum, in a scatter that gets denser near the kerb.
  vec4 gum = owWorley(p * 8.0 + 61.0, P * 8.0, 1.0);
  float gumM = smoothstep(0.075, 0.02, gum.x) * step(0.90, gum.w);
  c = mix(c, owSRGB(vec3(0.135, 0.128, 0.122)), gumM * 0.8);
  rough = mix(rough, 0.55, gumM * 0.7);
  h += gumM * 0.008;

  // salt bloom and the general grey traffic film
  float film = smoothstep(0.35, 0.85, owFbm01(p * 4.5, P * 4.5, 4, 0.55));
  c *= 1.0 - film * 0.12 * (0.4 + age);
  float bloom = smoothstep(0.62, 0.92, owFbm01(p * 2.2 + 13.0, P * 2.2, 4, 0.58));
  c = mix(c, cPale * 1.08, bloom * 0.22);

  float cavity = 1.0 - smoothstep(0.52, 0.76, h);
  c = mix(c, owSRGB(vec3(0.160, 0.155, 0.146)), cavity * 0.34);

  alb = clamp(c, vec3(0.02), vec3(0.82));
  rough = clamp(rough, 0.34, 0.99);
  ao = clamp(ao, 0.28, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;
