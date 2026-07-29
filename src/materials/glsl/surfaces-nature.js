/**
 * NATURE AND GROUND.
 *
 * The trap in all of these is that they are large, near-horizontal, and lit by
 * the sky rather than by a key light, so a surface with weak relief collapses
 * to a flat colour field the moment the sun goes behind a cloud. Every one of
 * these therefore carries its read in HEIGHT and ROUGHNESS first and in albedo
 * second — a green plane is a green plane no matter how many shades of green
 * are painted on it.
 */

/**
 * GRASS — a ground cover, not a green plane.
 *
 * The whole problem with procedural grass is that it is usually authored as
 * colour noise on a flat surface, and a flat surface lit by a hemisphere has no
 * shading variation at all, so it reads as felt. Real turf is a dense field of
 * 2-5 cm blades: it is 40% SHADOW by area, the blades all lean the same way in
 * clumps, the soil shows through wherever it is worn, and the specular is
 * strongly anisotropic along the blade. All of that is height and normal work.
 *
 * uParam.x  health 0..1   burnt brown -> deep green
 * uParam.y  wear 0..1     desire lines, bare soil, compacted patches
 * uParam.z  length 0..1   mown lawn -> unmown verge with seed heads
 * uParam.w  litter 0..1   fallen leaves, twigs, cut clippings
 */
export const GRASS = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 4.3;
  float health = clamp(uParam.x, 0.0, 1.0);
  float wear = clamp(uParam.y, 0.0, 1.0);
  float len = clamp(uParam.z, 0.0, 1.0);
  float litter = clamp(uParam.w, 0.0, 1.0);

  // ---- the soil underneath ----------------------------------------------
  float soilN = owFbm01(p * 3.0, P * 3.0, 5, 0.5);
  float soilF = owFbm01(p * 14.0, P * 14.0, 4, 0.5);
  vec3 soil = mix(owSRGB(vec3(0.205, 0.160, 0.108)), owSRGB(vec3(0.320, 0.262, 0.190)), soilN);
  soil *= 0.90 + 0.20 * soilF;
  vec4 grit = owWorley(p * 20.0, P * 20.0, 1.0);
  soil = mix(soil, owSRGB(vec3(0.400, 0.372, 0.335)), smoothstep(0.22, 0.04, grit.x) * step(0.72, grit.w) * 0.6);

  // ---- clumps ------------------------------------------------------------
  // Turf grows in tussocks 8-20 cm across. The clump field is what gives grass
  // its large-scale shading; without it the blades average out to nothing.
  float clumpA = owBillow(owWarp(p * 4.5, P * 4.5, 0.5, 3), P * 4.5, 4, 0.55);
  float clumpB = owFbm01(owWarp(p * 9.0 + 5.0, P * 9.0, 0.4, 3), P * 9.0, 4, 0.55);
  float clump = clamp(1.0 - clumpA * 0.75 + (clumpB - 0.5) * 0.55, 0.0, 1.0);

  // ---- BLADES ------------------------------------------------------------
  // Sheared noise makes a directional fibre field; three bands at three lean
  // angles gives blades that cross one another instead of combing one way. The
  // lean direction wanders over ~30 cm, which is how a lawn actually lies.
  float leanA = owFbm01(p * 1.6, P * 1.6, 3, 0.62);
  float k1 = 2.0 + floor(leanA * 3.0);
  float b1 = owFbm01(owShear(p * 10.0, k1, 9.0), owShearPer(P * 10.0, 9.0), 4, 0.5);
  float b2 = owFbm01(owShear(p * 15.0 + 3.0, -1.0, 11.0), owShearPer(P * 15.0, 11.0), 4, 0.5);
  float b3 = owFbm01(owShear(p * 21.0 + 7.0, 3.0, 7.0), owShearPer(P * 21.0, 7.0), 3, 0.5);
  // Sharpen into discrete blades: a smoothstep on a fibre field gives a
  // separated blade with a dark gap beside it, which is where the shadow lives.
  /**
   * COVERAGE, and this was measured wrong the first time.
   *
   * A 4-octave fbm01 spans roughly 0.3-0.7, so a smoothstep(0.50, 0.74) over it
   * averages about 0.2 — which meant the blade field covered a FIFTH of the
   * surface and four fifths of a lawn rendered as bare soil. The patch measured
   * 53/53/49: grey-brown, with the green barely above the red. Turf is 90-98%
   * covered; the soil only shows in the worn lines. The thresholds below sit
   * near the middle of the distribution so the blades cover, and the SHADOW
   * structure comes from a separate, deliberately high-contrast gap term rather
   * than from the absence of blades.
   */
  float blade1 = smoothstep(0.36, 0.62, b1);
  float blade2 = smoothstep(0.40, 0.66, b2);
  float blade3 = smoothstep(0.44, 0.70, b3);
  float blades = clamp(blade1 * 0.90 + blade2 * 0.60 + blade3 * 0.40, 0.0, 1.0);
  // The 30-40% of the area that is shadow BETWEEN blades. This is what makes
  // turf read as a three-dimensional cover instead of green felt, so it keeps
  // its contrast independently of how much of the surface the blades cover.
  float gap = 1.0 - smoothstep(0.30, 0.72, b1 * 0.55 + b2 * 0.30 + b3 * 0.15);

  float cover = clamp(blades * (0.78 + 0.30 * clump) * (1.0 - wear * 0.92), 0.0, 1.0);

  // ---- colour ------------------------------------------------------------
  // Grass is never one green. A single tussock runs from a yellow-green new
  // blade to a blue-green mature one to a straw-coloured dead one at its base,
  // and the dead thatch layer is a big part of the value.
  // MEASURED: the first pass authored these a full stop too dark. sRGB 0.235
  // green is 0.045 LINEAR — a 4.5% reflectance — and healthy turf measures
  // 10-18% in the green channel. Stacked against the per-blade shading, the
  // thatch mix and the macro wash it rendered at 53/53/49, i.e. grey-brown.
  vec3 gNew  = owSRGB(vec3(0.330, 0.470, 0.150));
  vec3 gMid  = owSRGB(vec3(0.228, 0.368, 0.118));
  vec3 gDeep = owSRGB(vec3(0.140, 0.252, 0.092));
  vec3 gDry  = owSRGB(vec3(0.470, 0.418, 0.190));
  vec3 gStraw = owSRGB(vec3(0.395, 0.340, 0.175));

  float tone = owFbm01(p * 2.2 + 11.0, P * 2.2, 4, 0.58);
  vec3 green = mix(gMid, gNew, smoothstep(0.35, 0.85, tone * 0.6 + b1 * 0.5));
  green = mix(green, gDeep, smoothstep(0.45, 0.90, clumpA) * 0.55);
  vec3 gc = mix(gDry, green, smoothstep(0.10, 0.80, health));
  // the thatch of dead material at the base of every clump
  gc = mix(gc, gStraw, gap * (0.22 + 0.40 * (1.0 - health)) * 0.7);
  // per-blade value: a lit blade is a full stop brighter than the one beside it
  gc *= 0.86 + 0.30 * (blade1 * 0.6 + blade2 * 0.4);
  // dead patches and moss
  float dead = smoothstep(0.62, 0.90, owFbm01(p * 1.8 + 27.0, P * 1.8, 4, 0.6)) * (1.0 - health);
  gc = mix(gc, gDry * 0.85, dead * 0.7);
  float moss = smoothstep(0.72, 0.94, owFbm01(p * 5.0 + 33.0, P * 5.0, 5, 0.6)) * health;
  gc = mix(gc, owSRGB(vec3(0.115, 0.190, 0.078)), moss * 0.5);

  // ---- height and normal -------------------------------------------------
  // This is the whole surface. The blades stand 2-5 cm proud of a soil datum,
  // the tussocks add another 2 cm, and the gaps go all the way down. Over a
  // 0.09 m relief that is a real, self-shadowing ground cover.
  float bladeH = blade1 * 0.55 + blade2 * 0.30 + blade3 * 0.16;
  float gh = 0.30 + bladeH * (0.42 + 0.30 * len) + clump * 0.18 + (soilN - 0.5) * 0.05;
  float soilH = 0.30 + (soilN - 0.5) * 0.10 + (soilF - 0.5) * 0.05;
  soilH += smoothstep(0.22, 0.04, grit.x) * step(0.72, grit.w) * 0.06;

  // ---- seed heads on an unmown verge ------------------------------------
  float seed = smoothstep(0.80, 0.94, b2) * len;
  gc = mix(gc, gStraw * 1.25, seed * 0.55);
  gh += seed * 0.10;

  // ---- combine with the worn soil ---------------------------------------
  vec3 c = mix(soil, gc, cover);
  h = mix(soilH, gh, cover);
  // Grass is waxy: a blade has a real specular streak along it, and the soil
  // has none. That split is a strong cue on its own.
  rough = mix(0.94 + (soilF - 0.5) * 0.08, 0.58 + (1.0 - blade1) * 0.20, cover);
  // The gaps between blades are deep, narrow and dark. Baking that occlusion is
  // the difference between turf and green felt under an overcast sky.
  ao = mix(0.94, 1.0 - gap * 0.55 - (1.0 - clump) * 0.20, cover);
  metal = 0.0;

  // ---- desire lines ------------------------------------------------------
  // People cut corners. A worn path is compacted soil with the crown of the
  // grass sheared off at its edges, and it is never a straight line.
  float path = smoothstep(0.55, 0.85, owFbm01(owWarp(p * 1.1 + 41.0, P * 1.1, 1.2, 3), P * 1.1, 4, 0.6)) * wear;
  c = mix(c, soil * 0.88, path * 0.8);
  h = mix(h, soilH - 0.04, path * 0.75);
  rough = mix(rough, 0.95, path * 0.8);
  ao = mix(ao, 0.90, path * 0.7);

  // ---- litter ------------------------------------------------------------
  // Fallen leaves and mower clippings sit ON TOP of everything, which is the
  // cheapest way to add a completely different scale of detail to a ground.
  vec4 lf = owWorley(owWarp(p * 9.0 + 13.0, P * 9.0, 0.35, 2), P * 9.0, 1.0);
  float leaf = smoothstep(0.30, 0.10, lf.x) * step(0.60, lf.w) * litter;
  vec3 leafC = mix(owSRGB(vec3(0.400, 0.245, 0.100)), owSRGB(vec3(0.288, 0.190, 0.090)), lf.z);
  leafC = mix(leafC, owSRGB(vec3(0.470, 0.395, 0.155)), step(0.85, lf.z) * 0.7);
  c = mix(c, leafC, leaf * 0.85);
  h += leaf * 0.08;
  rough = mix(rough, 0.72, leaf * 0.7);
  ao -= leaf * 0.10;
  // twigs
  float twig = owScratches(p * 4.0, P * 4.0, 14.0, 2.0, 0.80) * litter;
  c = mix(c, owSRGB(vec3(0.230, 0.176, 0.108)), twig * 0.7);
  h += twig * 0.05;

  // ---- what a city puts in its grass ------------------------------------
  // A scatter of pale grit and the odd scrap of paper. Small, sparse, and it
  // stops a verge reading as a texture swatch.
  vec4 sc = owWorley(p * 16.0 + 51.0, P * 16.0, 1.0);
  float scrap = smoothstep(0.08, 0.02, sc.x) * step(0.955, sc.w);
  c = mix(c, owSRGB(vec3(0.560, 0.545, 0.510)), scrap * 0.8);
  rough = mix(rough, 0.80, scrap * 0.7);
  h += scrap * 0.04;

  alb = clamp(c, vec3(0.02), vec3(0.68));
  rough = clamp(rough, 0.40, 0.99);
  // The gaps between blades are the shading, but a 0.28 floor over a whole
  // lawn is a stop of light removed from the largest surface in a park.
  ao = clamp(ao, 0.40, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * MUD — churned, wet, rutted. The riverbank, the mill yard, the verge a truck
 * has been across.
 *
 * uParam.x  wet 0..1     drying crust -> saturated slurry
 * uParam.y  ruts 0..1    vehicle tracks and the ridges thrown up between them
 * uParam.z  prints 0..1  boot and hoof prints
 */
export const MUD = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 5.9;
  float wet = clamp(uParam.x, 0.0, 1.0);
  float ruts = clamp(uParam.y, 0.0, 1.0);
  float prints = clamp(uParam.z, 0.0, 1.0);

  float macro = owFbm01(p * 0.7, P * 0.7, 4, 0.62);
  float mid   = owBillow(owWarp(p * 3.2, P * 3.2, 0.7, 3), P * 3.2, 5, 0.55);
  float fine  = owFbm01(p * 14.0, P * 14.0, 4, 0.5);

  // Wet mud is much darker and much more saturated than dry mud — the single
  // biggest value range on any ground surface.
  vec3 dry  = owSRGB(vec3(0.360, 0.298, 0.212));
  vec3 damp = owSRGB(vec3(0.205, 0.158, 0.108));
  vec3 sat  = owSRGB(vec3(0.098, 0.075, 0.052));
  vec3 c = mix(dry, damp, smoothstep(0.0, 0.6, wet));
  c = mix(c, sat, smoothstep(0.45, 1.0, wet) * 0.85);
  c *= 0.88 + 0.24 * macro;
  c *= 0.93 + 0.14 * fine;

  h = 0.52 + (macro - 0.5) * 0.16 + (mid - 0.5) * 0.20 + (fine - 0.5) * 0.05;
  float r = mix(0.94, 0.44, wet) + (fine - 0.5) * 0.10;
  metal = 0.0;
  ao = 1.0;

  // ---- ruts --------------------------------------------------------------
  // A wheel does not make a groove, it makes a groove with a RIDGE of displaced
  // mud on each side, and the ridge is what catches the light.
  {
    float across = fract(uv.x + owFbm01(p * 0.5, P * 0.5, 3, 0.6) * 0.10);
    float d = min(abs(across - 0.30), abs(across - 0.70));
    float groove = 1.0 - smoothstep(0.03, 0.085, d);
    float ridge = max(smoothstep(0.085, 0.11, d) - smoothstep(0.11, 0.165, d), 0.0);
    // the tread pattern pressed into the bottom of the rut
    float tread = 1.0 - smoothstep(0.25, 0.75, abs(fract(uv.y * 34.0) - 0.5) * 2.0);
    h -= groove * ruts * 0.24;
    h += tread * groove * ruts * 0.07;
    h += ridge * ruts * 0.14;
    ao -= groove * ruts * 0.35;
    c = mix(c, sat, groove * ruts * wet * 0.6);
    c *= 1.0 + ridge * ruts * 0.14;
    r = mix(r, r * 0.7, groove * ruts * wet);
  }

  // ---- boot prints -------------------------------------------------------
  {
    vec4 bp = owWorley(owWarp(p * 5.0 + 23.0, P * 5.0, 0.3, 2), P * 5.0, 0.9);
    float sel = step(0.68 - prints * 0.25, bp.w);
    float sole = sel * smoothstep(0.20 + 0.08 * bp.z, 0.04, bp.x) * prints;
    float lug = 1.0 - smoothstep(0.3, 0.7, abs(fract(bp.y * 22.0) - 0.5) * 2.0);
    h -= sole * 0.20;
    h += sole * lug * 0.06;
    ao -= sole * 0.35;
    // the rim of squeezed-up mud, and the water that has filled the print
    float rim = max(sel * (smoothstep(0.28 + 0.08 * bp.z, 0.20 + 0.08 * bp.z, bp.x) - sole), 0.0) * prints;
    h += rim * 0.07;
    c = mix(c, sat, sole * wet * 0.7);
    r = mix(r, 0.14, sole * wet * 0.8);
  }

  // ---- dried crust -------------------------------------------------------
  // When it dries the top curls into plates that lift at their edges. The lift
  // is small and it is the only thing that makes dry mud read as dry.
  float crust = 1.0 - wet;
  float crk = owCracks(p * 3.0, P * 3.0, 0.85, 0.032, 0.34) * crust;
  h -= crk * 0.16;
  ao -= crk * 0.36;
  c = mix(c, damp * 0.72, crk * 0.7);
  float plate = smoothstep(0.12, 0.0, crk) * crust;
  h += plate * 0.014;
  c *= 1.0 + plate * 0.06;

  // ---- stones and organic matter ----------------------------------------
  vec4 st = owWorley(p * 12.0, P * 12.0, 1.0);
  float stone = smoothstep(0.26, 0.08, st.x) * step(0.70, st.w);
  c = mix(c, mix(owSRGB(vec3(0.300, 0.286, 0.268)), owSRGB(vec3(0.520, 0.492, 0.450)), st.z), stone * 0.65);
  h += stone * 0.09;
  r = mix(r, 0.60 + 0.24 * st.z, stone * 0.7);
  float straw = owScratches(p * 5.0, P * 5.0, 12.0, 1.0, 0.80);
  c = mix(c, owSRGB(vec3(0.330, 0.272, 0.140)), straw * 0.55);
  h += straw * 0.04;

  // ---- standing water in the low ground ---------------------------------
  // Independent of the global wetness system: this is water that is ALWAYS
  // there in a mud surface, and it is what makes mud legible as mud.
  float pool = smoothstep(0.40, 0.28, h) * smoothstep(0.35, 0.75, wet);
  c = mix(c, sat * 0.55, pool * 0.85);
  r = mix(r, 0.045, pool * 0.9);
  ao = mix(ao, 1.0, pool * 0.6);

  alb = clamp(c, vec3(0.02), vec3(0.60));
  rough = clamp(r, 0.04, 0.99);
  ao = clamp(ao, 0.40, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * RIVER SILT — the exposed mud bank of the Mon and the Allegheny at low water.
 * Fine, laminated, cracked in polygons, studded with the junk a mill town's
 * river deposits.
 *
 * uParam.x  wet 0..1     the tide line: saturated at the water, baked inland
 * uParam.y  debris 0..1
 */
export const RIVER_SILT = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 7.9;
  float wet = clamp(uParam.x, 0.0, 1.0);
  float debris = clamp(uParam.y, 0.0, 1.0);

  float macro = owFbm01(p * 0.65, P * 0.65, 4, 0.62);
  float fine  = owFbm01(p * 16.0, P * 16.0, 4, 0.5);
  // Silt is deposited in laminae, so it has a fine banded structure that runs
  // with the flow — not an isotropic noise.
  float lam = owFbm01(owShear(p * 6.0, 1.0, 5.0), owShearPer(P * 6.0, 5.0), 5, 0.52);

  // Steel-city silt is a cold grey-brown, not a warm mud: it is half coal fines
  // and mill slag washed downstream.
  vec3 dryC = owSRGB(vec3(0.330, 0.306, 0.268));
  vec3 wetC = owSRGB(vec3(0.128, 0.116, 0.100));
  vec3 c = mix(dryC, wetC, smoothstep(0.05, 0.85, wet));
  c *= 0.88 + 0.24 * macro;
  c *= 0.92 + 0.16 * lam;
  c *= 0.95 + 0.10 * fine;

  h = 0.58 + (macro - 0.5) * 0.10 + (lam - 0.5) * 0.06 + (fine - 0.5) * 0.03;
  float r = mix(0.92, 0.30, wet) + (fine - 0.5) * 0.10;
  metal = 0.0;
  ao = 1.0;

  // ---- desiccation polygons ---------------------------------------------
  // Silt cracks into large, clean polygons — much bigger and much straighter
  // than mud cracks, and the plates curl hard at their edges.
  float dryness = 1.0 - wet;
  float poly = owCracks(p * 1.9, P * 1.9, 0.90, 0.030, 0.24) * dryness;
  float poly2 = owCracks(p * 4.2 + 7.0, P * 4.2, 0.88, 0.022, 0.42) * dryness * 0.6;
  float crk = clamp(poly + poly2, 0.0, 1.0);
  h -= crk * 0.24;
  ao -= crk * 0.50;
  c = mix(c, wetC * 0.8, crk * 0.75);
  float curl = smoothstep(0.16, 0.0, crk) * dryness;
  h += curl * 0.030;
  c *= 1.0 + curl * 0.10;

  // ---- ripple marks ------------------------------------------------------
  // The current leaves a 3-5 cm ripple field on a silt bed, asymmetric in the
  // flow direction. It is the strongest normal-map signal the surface has.
  float rip = sin((owShear(p * 2.2, 1.0, 1.0).y + owFbm(p * 0.9, P * 0.9, 3, 0.55) * 0.6) * 6.28318);
  rip = rip * 0.5 + 0.5;
  rip = pow(rip, 1.8) * 0.8 + rip * 0.2;
  float ripAmt = smoothstep(0.25, 0.75, owFbm01(p * 0.9, P * 0.9, 3, 0.6)) * (0.4 + 0.7 * wet);
  h += (rip - 0.5) * 0.16 * ripAmt;
  c *= 1.0 - (rip - 0.5) * 0.10 * ripAmt;

  // ---- what a river leaves behind ---------------------------------------
  vec4 st = owWorley(p * 13.0, P * 13.0, 1.0);
  float pebble = smoothstep(0.22, 0.06, st.x) * step(0.76, st.w) * debris;
  c = mix(c, mix(owSRGB(vec3(0.310, 0.296, 0.280)), owSRGB(vec3(0.520, 0.490, 0.450)), st.z), pebble * 0.75);
  h += pebble * 0.10;
  r = mix(r, 0.55 + 0.25 * st.z, pebble * 0.7);
  // coal fines: black, glassy flecks — the signature of these rivers
  vec4 coal = owWorley(p * 19.0 + 11.0, P * 19.0, 1.0);
  float coalM = smoothstep(0.16, 0.03, coal.x) * step(0.72, coal.z);
  c = mix(c, owSRGB(vec3(0.045, 0.044, 0.048)), coalM * 0.8);
  r = mix(r, 0.35, coalM * 0.6);
  // driftwood splinters and reed stems
  float wood = owScratches(p * 3.2, P * 3.2, 16.0, 1.0, 0.84) * debris;
  c = mix(c, owSRGB(vec3(0.300, 0.256, 0.180)), wood * 0.7);
  h += wood * 0.06;
  r = mix(r, 0.80, wood * 0.6);

  // ---- the tide line -----------------------------------------------------
  // A dark saturated band with a pale scum line of dried foam and litter above
  // it. It is the detail that says "river" instead of "puddle".
  float tide = 1.0 - smoothstep(0.0, 0.10, abs(macro - 0.52));
  c = mix(c, owSRGB(vec3(0.480, 0.462, 0.420)), tide * (1.0 - wet) * 0.35);
  r += tide * 0.06;

  // ---- standing water ----------------------------------------------------
  float pool = smoothstep(0.42, 0.30, h) * smoothstep(0.30, 0.80, wet);
  c = mix(c, wetC * 0.5, pool * 0.85);
  r = mix(r, 0.04, pool * 0.9);
  ao = mix(ao, 1.0, pool * 0.6);

  alb = clamp(c, vec3(0.02), vec3(0.62));
  rough = clamp(r, 0.04, 0.99);
  ao = clamp(ao, 0.35, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * TREE BARK.
 *
 * uParam.x  species 0 = deep-furrowed oak/locust · 0.5 = plated sycamore/plane
 *                   · 1 = smooth-and-lenticelled birch/beech
 * uParam.y  moss 0..1
 * uParam.z  age 0..1  furrow depth and scar density
 */
export const BARK = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 10.6;
  float species = clamp(uParam.x, 0.0, 1.0);
  float mossAmt = clamp(uParam.y, 0.0, 1.0);
  float age = clamp(uParam.z, 0.0, 1.0);

  float furrowed = 1.0 - smoothstep(0.0, 0.5, species);
  float plated = 1.0 - abs(species - 0.5) * 2.0;
  float smoothB = smoothstep(0.5, 1.0, species);

  // Bark grows in a vertically stretched field: everything here is sheared
  // along v, because bark that is isotropic reads as rock.
  float v1 = owFbm01(owShear(p * 3.0, 0.0, 7.0), owShearPer(P * 3.0, 7.0), 5, 0.55);
  float v2 = owFbm01(owShear(p * 7.0 + 3.0, 1.0, 9.0), owShearPer(P * 7.0, 9.0), 4, 0.5);
  float fine = owFbm01(p * 18.0, P * 18.0, 4, 0.5);

  // ---- deep furrows ------------------------------------------------------
  // Ridged bark is a set of long, hard-edged ridges separated by furrows that
  // are genuinely deep — 1-3 cm on an old oak. The furrow is nearly black.
  float ridgeF = owRidged(owShear(p * 2.4, 0.0, 6.0), owShearPer(P * 2.4, 6.0), 5, 0.6);
  float furrow = pow(clamp(ridgeF, 0.0, 1.0), 1.5);
  // the ridges break and step every 20-40 cm rather than running unbroken
  float brk = smoothstep(0.35, 0.65, owFbm01(p * 2.0 + 9.0, P * 2.0, 4, 0.55));
  furrow = mix(furrow * 0.65, furrow, brk);

  // ---- plates ------------------------------------------------------------
  // Sycamore/plane bark sheds in irregular plates, leaving pale patches with
  // hard edges — a completely different read from a furrowed trunk.
  vec4 pl = owWorley(owWarp(p * 3.4, P * 3.4, 0.55, 3), P * 3.4, 0.95);
  float plate = smoothstep(0.06, 0.20, pl.y - pl.x);
  float plateShed = step(0.55, pl.w);

  // ---- colour ------------------------------------------------------------
  vec3 dark = owSRGB(vec3(0.098, 0.082, 0.068));
  vec3 mid  = owSRGB(vec3(0.222, 0.186, 0.148));
  vec3 pale = owSRGB(vec3(0.390, 0.352, 0.300));
  vec3 cream = owSRGB(vec3(0.545, 0.520, 0.462));
  vec3 c = mix(dark, mid, smoothstep(0.25, 0.85, furrow));
  c = mix(c, pale, smoothstep(0.70, 1.0, furrow) * 0.55);
  // plated species: fresh under-bark is cream, old plates are olive-grey
  c = mix(c, mix(cream, owSRGB(vec3(0.300, 0.300, 0.250)), pl.z),
          plated * plate * plateShed * 0.75);
  // smooth species: pale with dark horizontal lenticels
  {
    float lent = (1.0 - smoothstep(0.0, 0.35, abs(fract(p.y * 2.4 + owFbm01(p * 1.5, P * 1.5, 3, 0.6) * 2.0) - 0.5) * 2.0))
               * step(0.55, owFbm01(p * 9.0, P * 9.0, 3, 0.5));
    vec3 sc = mix(cream * 1.05, owSRGB(vec3(0.330, 0.318, 0.290)), owFbm01(p * 1.2, P * 1.2, 4, 0.6) * 0.5);
    sc = mix(sc, dark, lent * 0.8);
    c = mix(c, sc, smoothB);
  }
  c *= 0.90 + 0.20 * v1;
  c *= 0.94 + 0.12 * v2;
  c *= 0.96 + 0.08 * fine;

  // ---- height ------------------------------------------------------------
  float hh = 0.40 + furrow * (0.45 + 0.25 * age) * furrowed
           + plate * 0.22 * plated
           + 0.30 * smoothB;
  hh += (v1 - 0.5) * 0.10 + (v2 - 0.5) * 0.05 + (fine - 0.5) * 0.02;
  // the shed edge of a plate stands proud and casts a hard shadow
  float plateEdge = plated * plateShed * max(smoothstep(0.02, 0.06, pl.y - pl.x) - plate, 0.0);
  hh += plateEdge * 0.10;

  float r = 0.88 + (fine - 0.5) * 0.10 - smoothB * 0.14;
  metal = 0.0;
  ao = 1.0 - (1.0 - furrow) * 0.45 * furrowed - (1.0 - plate) * 0.22 * plated;

  // ---- scars and insect damage ------------------------------------------
  vec4 hole = owWorley(p * 15.0, P * 15.0, 1.0);
  float bore = smoothstep(0.09, 0.02, hole.x) * step(0.90, hole.w) * age;
  hh -= bore * 0.30;
  ao -= bore * 0.55;
  c = mix(c, dark * 0.5, bore * 0.8);
  float scar = smoothstep(0.80, 0.92, owFbm01(owWarp(p * 1.4 + 21.0, P * 1.4, 0.9, 3), P * 1.4, 4, 0.6)) * age;
  c = mix(c, mix(pale, dark, 0.4), scar * 0.6);
  hh -= scar * 0.10;
  r += scar * 0.05;

  // ---- moss and lichen ---------------------------------------------------
  // Both live in the furrows, never on the ridges, and both are much greener
  // and much rougher than the bark. This is the read that says "outdoors".
  float damp = 1.0 - smoothstep(0.30, 0.75, hh);
  float moss = smoothstep(0.42, 0.80, owFbm01(owWarp(p * 3.0 + 31.0, P * 3.0, 0.7, 3), P * 3.0, 5, 0.58))
             * mossAmt * (0.30 + 0.95 * damp);
  vec3 mossC = mix(owSRGB(vec3(0.098, 0.155, 0.062)), owSRGB(vec3(0.170, 0.215, 0.098)), fine);
  c = mix(c, mossC, clamp(moss, 0.0, 1.0) * 0.72);
  r = mix(r, 0.96, moss * 0.7);
  hh += moss * 0.05;
  // crustose lichen: pale grey-green discs on the exposed ridges
  vec4 li = owWorley(p * 8.0 + 41.0, P * 8.0, 0.9);
  float lichen = smoothstep(0.24, 0.10, li.x) * step(0.62, li.w) * mossAmt * smoothstep(0.4, 0.8, hh);
  c = mix(c, owSRGB(vec3(0.430, 0.452, 0.372)), lichen * 0.6);
  r = mix(r, 0.95, lichen * 0.6);

  float cavity = 1.0 - smoothstep(0.30, 0.68, hh);
  c = mix(c, dark * 0.55, cavity * 0.40);

  alb = clamp(c, vec3(0.02), vec3(0.68));
  h = clamp(hh, 0.0, 1.0);
  rough = clamp(r, 0.42, 0.99);
  ao = clamp(ao, 0.18, 1.0);
}
`;

/**
 * LEAF CARD — an alpha-cut cluster of leaves for tree and shrub canopies.
 * 'h' carries the CUTOUT MASK (see generator.js), and the translucency is
 * supplied at runtime by the OW_CLOTH transmission term in shader.js, which
 * sums a forward-scatter lobe over every directional light. A leaf lit from
 * BEHIND has to glow, and its veins have to show as dark lines inside that
 * glow; without that, foliage is cardboard.
 *
 * uParam.x  season 0 = spring yellow-green · 0.5 = summer · 1 = autumn
 * uParam.y  density 0..1  how much of the card is covered
 * uParam.z  species 0 = broad ovate · 1 = narrow lanceolate
 */
export const LEAF_CARD = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  const float CELLS = 4.0;
  vec2 p = uv * P + uSeed * 5.9;
  float season = clamp(uParam.x, 0.0, 1.0);
  float density = clamp(uParam.y, 0.15, 1.0);
  float narrow = clamp(uParam.z, 0.0, 1.0);

  vec2 lp = uv * CELLS;
  vec2 ip = floor(lp), fp = fract(lp);

  float bestCover = 0.0;
  float bestDepth = -1.0;
  vec3 bestCol = vec3(0.0);
  float bestVein = 0.0;
  float bestMid = 0.0;
  float bestCurl = 0.0;

  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 cell = mod(ip + g, vec2(CELLS));
      vec4 r = owHash42(cell + uSeed * 2.0);
      vec4 r2 = owHash42(cell * 1.7 + 9.0 + uSeed);
      if (r2.w > density) continue;
      vec2 centre = g + 0.15 + r.xy * 0.7 - fp;
      float ang = r.z * 6.28318;
      vec2 q = owRot(centre, ang);
      vec2 s = mix(vec2(0.32 + r.w * 0.16, 0.17 + r2.x * 0.08),
                   vec2(0.40 + r.w * 0.14, 0.075 + r2.x * 0.035), narrow);
      vec2 e = q / s;
      float d = length(e);
      // an ovate blade: pinched at the tip, rounded at the base
      float pinch = 1.0 - 0.42 * max(e.x, 0.0) * 0.5;
      // a serrated margin, and the serration size varies per leaf
      float serr = sin(atan(e.y, e.x) * (18.0 + r2.y * 16.0)) * (0.020 + 0.022 * r2.z);
      float cover = smoothstep(1.02 + serr, 0.90 + serr, d / max(pinch, 0.3));
      // a bite out of one side, because a real leaf has been eaten
      float bite = smoothstep(0.30, 0.0, length(e - vec2(0.5 + r2.z, 0.9))) * step(0.72, r2.y);
      cover *= 1.0 - bite;
      if (cover > 0.01){
        float depth = r2.y;
        if (depth > bestDepth){
          // the midrib, and the secondary veins branching off it at an angle
          float mid = 1.0 - smoothstep(0.0, 0.09, abs(e.y));
          float sideV = smoothstep(0.72, 1.0, abs(fract(e.x * 4.0 + abs(e.y) * 2.4) * 2.0 - 1.0));
          float vein = clamp(mid + sideV * 0.55, 0.0, 1.0);

          vec3 cSpring = owSRGB(vec3(0.245, 0.362, 0.098));
          vec3 cSummer = owSRGB(vec3(0.108, 0.212, 0.070));
          vec3 cDeep   = owSRGB(vec3(0.062, 0.132, 0.052));
          vec3 cAutumn = owSRGB(vec3(0.480, 0.268, 0.070));
          vec3 cDry    = owSRGB(vec3(0.360, 0.288, 0.108));
          vec3 lc = mix(cSpring, cSummer, smoothstep(0.0, 0.55, season));
          lc = mix(lc, mix(cAutumn, cDry, r2.z), smoothstep(0.55, 1.0, season));
          // Every leaf on a tree is a different age and gets a different amount
          // of sun; a canopy of one green is the classic tell.
          lc = mix(lc, cDeep, r.z * 0.45);
          lc *= 0.82 + 0.36 * r2.x;
          // blotches, mildew and the beginnings of autumn at the margins
          float spots = owFbm01(p * 20.0, P * 20.0, 3, 0.5);
          lc *= 0.88 + 0.24 * spots;
          lc = mix(lc, cDry * 0.8, smoothstep(0.80, 0.96, spots) * 0.55);
          float margin = smoothstep(0.72, 1.0, d / max(pinch, 0.3));
          lc = mix(lc, cDry, margin * (0.15 + 0.5 * season));
          // the vein is paler and much less waxy than the blade
          lc = mix(lc, lc * 1.45 + 0.012, vein * 0.55);

          bestDepth = depth;
          bestCover = cover;
          bestCol = lc;
          bestVein = vein;
          bestMid = mid;
          // leaves curl: the blade is not flat, and the curl is what makes a
          // canopy shade itself instead of reading as a printed sheet
          bestCurl = (1.0 - smoothstep(0.0, 1.0, d)) - abs(e.y) * 0.5;
        }
      }
    }
  }

  float fine = owFbm01(p * 12.0, P * 12.0, 3, 0.5);
  alb = clamp(bestCol * (0.955 + 0.085 * fine), vec3(0.02), vec3(0.66));
  // h doubles as the alpha-test mask for foliage.
  h = bestCover;
  // A leaf has a waxy cuticle on top: it is genuinely glossy, and the vein and
  // the eaten margin are not. That variation is what stops a canopy reading as
  // a single flat green mass under a bright sky.
  rough = clamp(0.42 + (1.0 - bestVein) * 0.10 + (fine - 0.5) * 0.14 + bestDepth * 0.16, 0.28, 0.92);
  metal = 0.0;
  // Leaves deeper in the cluster are occluded by the ones above them.
  ao = clamp(0.42 + bestDepth * 0.48 + bestCurl * 0.20, 0.25, 1.0);
}
`;
