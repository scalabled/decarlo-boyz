/**
 * VEHICLE SURFACES.
 *
 * The texture set here is deliberately quiet: a car body is a smooth, almost
 * featureless surface and everything that makes it read as a CAR happens in the
 * lighting — the metallic flake, the view-dependent flop, the clearcoat lobe
 * with its own IOR and its own orange peel. Those live in the material shader
 * (see the OW_CARPAINT block in shader.js) because they are all functions of
 * the view direction, which a baked texture cannot know.
 *
 * What the bake carries is everything the paint has been THROUGH: wash swirls,
 * stone chips, the chalky bloom of oxidised single-stage paint, resprayed
 * panels, rust blistering out from under the primer and the film of road dirt
 * that sits above the sills and behind the wheels.
 */

export const CARPAINT = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 4.9;

  int finish = int(uParam.x + 0.5);   // 0 gloss 1 metallic 2 matte 3 primer
                                      // 4 faded 5 rusted 6 dirty
  float wear = clamp(uParam.y, 0.0, 1.0);
  float dirt = clamp(uParam.z, 0.0, 1.0);

  vec3 base = uTintA;
  float macro = owFbm01(p * 0.7, P * 0.7, 4, 0.6);
  float fine  = owFbm01(p * 12.0, P * 12.0, 4, 0.5);
  float micro = owFbm01(p * 22.0, P * 22.0, 3, 0.5);

  // ---- the coat ----------------------------------------------------------
  // Even a factory finish is not one number: the film thickness varies across
  // a panel, so a solid colour breathes by a couple of percent.
  vec3 c = base * (0.975 + 0.05 * macro);
  float r = 0.055;
  float mtl = 0.0;
  h = 0.72 + (fine - 0.5) * 0.006;
  ao = 1.0;

  if (finish == 1) {
    // Metallic: the base coat holds aluminium, so it is a touch lighter and it
    // is genuinely part-metal in the BRDF. The flake sparkle itself is a
    // shader-side, view-dependent effect.
    c = base * (0.985 + 0.04 * macro);
    // The BINDER is a dielectric. The aluminium flakes suspended in it are the
    // metal, and they are resolved per-flake by the OW_CARPAINT layer in
    // shader.js — see the note there. Authoring an intermediate metalness on
    // the base coat is the usual shortcut and it is physically meaningless.
    mtl = 0.0;
    r = 0.10 + (fine - 0.5) * 0.02;
  } else if (finish == 2) {
    // Matte wrap / satin respray: a real matte clear scatters, so it needs a
    // high roughness AND a visible micro texture or it reads as untextured.
    r = 0.62 + (micro - 0.5) * 0.14;
    c = base * (0.94 + 0.08 * fine);
  } else if (finish == 3) {
    // Etch primer: flat, chalky, grey-red, with sanding scratches through it.
    c = mix(owSRGB(vec3(0.300, 0.290, 0.285)), owSRGB(vec3(0.330, 0.212, 0.160)), 0.45);
    c *= 0.90 + 0.20 * fine;
    r = 0.80 + (micro - 0.5) * 0.12;
    float sand = owScratches(p * 3.0, P * 3.0, 14.0, 1.0, 0.60);
    sand += owScratches(p * 5.0 + 7.0, P * 5.0, 10.0, -2.0, 0.66) * 0.7;
    c *= 1.0 - clamp(sand, 0.0, 1.0) * 0.10;
    r += clamp(sand, 0.0, 1.0) * 0.06;
  } else if (finish == 4) {
    // Oxidised single-stage: the clear is gone, the pigment has chalked, and
    // it goes pale and dead in patches following the sun exposure.
    float chalk = smoothstep(0.20, 0.85, owFbm01(owWarp(p * 1.3, P * 1.3, 0.7, 3), P * 1.3, 4, 0.58));
    c = mix(base, base * 0.55 + vec3(0.16), chalk * (0.35 + 0.6 * wear));
    r = mix(0.20, 0.72, chalk * (0.4 + 0.6 * wear)) + (micro - 0.5) * 0.10;
    // and it crazes into a fine net where the film has finally let go
    float craze = owCracks(p * 12.0, P * 12.0, 0.9, 0.014, 0.62) * wear;
    c *= 1.0 - craze * 0.22;
    r += craze * 0.18;
    h -= craze * 0.02;
  }

  // ---- wash swirls -------------------------------------------------------
  // A decade of the wrong sponge leaves a field of fine circular scratches in
  // the clear. They are invisible in shadow and they are the whole character of
  // an old car in low sun, so they belong in roughness, not in albedo.
  float swirlA = owScratches(p * 2.2, P * 2.2, 11.0, 1.0, 0.58);
  float swirlB = owScratches(p * 3.4 + 9.0, P * 3.4, 9.0, -2.0, 0.62);
  float swirlC = owScratches(p * 5.0 + 21.0, P * 5.0, 7.0, 3.0, 0.66);
  float swirl = clamp(swirlA * 0.5 + swirlB * 0.4 + swirlC * 0.35, 0.0, 1.0) * wear;
  r += swirl * 0.13;
  c *= 1.0 - swirl * 0.025;

  // ---- stone chips -------------------------------------------------------
  // Nose, sills and the leading edge of everything: 1-3 mm craters down to
  // primer, and the older ones have a rust dot in the middle.
  vec4 chip = owWorley(p * 20.0, P * 20.0, 1.0);
  float chipM = smoothstep(0.10, 0.02, chip.x) * step(0.86 - wear * 0.20, chip.w);
  vec3 primer = owSRGB(vec3(0.290, 0.282, 0.276));
  c = mix(c, primer, chipM * 0.85);
  r = mix(r, 0.78, chipM * 0.8);
  h -= chipM * 0.05;
  ao -= chipM * 0.25;
  float chipRust = chipM * step(0.94 - wear * 0.10, chip.z);
  c = mix(c, owRustColour(0.55, fine), chipRust * 0.8);

  // ---- deeper scratches --------------------------------------------------
  float scr = owScratches(p * 1.6, P * 1.6, 20.0, 1.0, 0.72) * wear;
  c = mix(c, primer * 1.1, scr * 0.55);
  r = mix(r, 0.60, scr * 0.5);
  h -= scr * 0.015;

  // ---- rust --------------------------------------------------------------
  if (finish == 5) {
    // Rust does not appear where it likes. It comes out of the arches, the
    // sills and the bottom of every panel, blisters the paint from underneath
    // first, then eats through.
    float low = smoothstep(0.75, 0.10, uv.y);
    float bloom = 1.0 - owBillow(owWarp(p * 1.5, P * 1.5, 1.1, 4), P * 1.5, 5, 0.6);
    float rustF = smoothstep(0.46, 0.86, bloom * (0.45 + 0.85 * low) + wear * 0.25);
    float grain = owFbm01(p * 20.0, P * 20.0, 4, 0.55);
    vec3 rc = owRustColour(rustF, grain);
    // the blister ring: paint lifted but not yet broken
    float blister = smoothstep(0.30, 0.46, rustF) * (1.0 - smoothstep(0.46, 0.62, rustF));
    h += blister * 0.06;
    c *= 1.0 + blister * 0.10;
    c = mix(c, rc, smoothstep(0.42, 0.70, rustF));
    r = mix(r, 0.90 + 0.08 * grain, smoothstep(0.35, 0.7, rustF));
    mtl = mix(mtl, 0.0, smoothstep(0.3, 0.6, rustF));
    // holed right through, with a ragged edge
    vec4 hole = owWorley(p * 6.0 + 31.0, P * 6.0, 0.95);
    float perf = smoothstep(0.10, 0.02, hole.x) * step(0.92, hole.w) * smoothstep(0.6, 0.9, rustF);
    h -= perf * 0.4;
    ao -= perf * 0.6;
    c = mix(c, rc * 0.25, perf);
  }

  // ---- resprayed panel ---------------------------------------------------
  // Somebody had a bump. The new colour never matches, the metallic lies down
  // at a different angle, and there is always overspray on the rubber.
  float respray = smoothstep(0.76, 0.82, owFbm01(owWarp(p * 0.8 + 41.0, P * 0.8, 1.0, 3), P * 0.8, 4, 0.6)) * wear;
  c = mix(c, c * vec3(1.06, 1.01, 0.95) + 0.008, respray * 0.8);
  r = mix(r, r * 1.25 + 0.02, respray * 0.7);

  // ---- road film ---------------------------------------------------------
  // A car is never clean below its waist. The film is warm grey-brown, it is
  // thickest at the bottom, and it is streaked vertically by rain.
  float low = smoothstep(0.85, 0.05, uv.y);
  // Vertical rain runnels, not marbling: the streak field must be stretched
  // ALONG the run and narrow across it, or the film reads as a paint effect.
  float streak = owFbm01(vec2(p.x * 9.0, p.y * 0.55), vec2(P.x * 9.0, max(P.y, 1.0)), 5, 0.55);
  float film = clamp(dirt * (0.22 + 1.05 * low) * (0.55 + 0.55 * smoothstep(0.38, 0.86, streak)), 0.0, 1.0);
  if (finish == 6) film = clamp(film + dirt * 0.30 * low, 0.0, 1.0);
  vec3 grime = owSRGB(vec3(0.185, 0.166, 0.140));
  c = mix(c, grime, film * 0.62);
  r = mix(r, 0.86, film * 0.75);
  mtl *= 1.0 - film * 0.85;
  // salt spray dries to a pale crust along the sills
  float salt = smoothstep(0.55, 0.9, owFbm01(p * 6.0 + 13.0, P * 6.0, 4, 0.5)) * low * dirt;
  c = mix(c, owSRGB(vec3(0.520, 0.505, 0.480)), salt * 0.30);
  r += salt * 0.08;

  alb = clamp(c, vec3(0.02), vec3(0.92));
  rough = clamp(r, 0.030, 0.99);
  metal = clamp(mtl, 0.0, 1.0);
  ao = clamp(ao, 0.35, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * AUTOMOTIVE GLASS.
 *
 * The green edge, the Fresnel roll-off and the tint density are all functions
 * of the path length through the pane, so they live in the shader (OW_AUTOGLASS)
 * where the view direction is known. What is baked here is the surface: the
 * wiper arc, the defroster lines, the dried rain spots and the film of road
 * spray that makes a windscreen legible as glass rather than as a hole.
 *
 * uParam.x  tint 0..1        0 = clear windscreen, 1 = a limo rear window
 * uParam.y  defroster 0..1   the printed heater grid of a rear screen
 * uParam.z  dirt 0..1
 * uParam.w  shattered 0..1   spidered safety glass
 */
export const AUTOGLASS = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 3.7;
  float tint = clamp(uParam.x, 0.0, 1.0);
  float defr = clamp(uParam.y, 0.0, 1.0);
  float dirt = clamp(uParam.z, 0.0, 1.0);
  float shat = clamp(uParam.w, 0.0, 1.0);

  float dust = owFbm01(p * 5.0, P * 5.0, 5, 0.55);
  float fine = owFbm01(p * 14.0, P * 14.0, 3, 0.5);
  vec4 spots = owWorley(p * 20.0, P * 20.0, 1.0);

  // Glass is nearly black in albedo — everything you see in a window is
  // reflected or transmitted. A tinted pane just absorbs more on the way
  // through, which the shader does with Beer-Lambert.
  vec3 c = owSRGB(vec3(0.030, 0.036, 0.034)) * (1.0 - tint * 0.5);
  float r = 0.035 + (fine - 0.5) * 0.012;
  ao = 1.0;
  h = 0.5;
  metal = 0.0;

  // ---- road film ---------------------------------------------------------
  float grime = smoothstep(0.40, 0.85, dust) * dirt;
  c = mix(c, owSRGB(vec3(0.230, 0.220, 0.200)), grime * 0.32);
  r += grime * 0.22;

  // ---- the wiper arc -----------------------------------------------------
  // The single most recognisable thing on a windscreen: a clean fan swept out
  // of the film, with a hard dirty crescent at its outer edge where the blade
  // stops and a smear pattern inside it.
  vec2 pivot = vec2(0.30, -0.28);
  float rad = length((uv - pivot) * vec2(1.0, 1.15));
  float ang = atan(uv.y - pivot.y, uv.x - pivot.x);
  float inArc = smoothstep(0.36, 0.40, rad) * (1.0 - smoothstep(0.86, 0.92, rad));
  inArc *= smoothstep(0.25, 0.45, ang) * (1.0 - smoothstep(1.35, 1.55, ang));
  float swept = inArc * dirt;
  c = mix(c, owSRGB(vec3(0.030, 0.036, 0.034)), swept * 0.75);
  r -= swept * 0.16;
  // the smear the blade leaves behind, banded along the sweep
  float smear = (1.0 - smoothstep(0.0, 0.5, abs(sin(rad * 42.0)))) * inArc * dirt;
  r += smear * 0.10;
  c = mix(c, owSRGB(vec3(0.170, 0.165, 0.150)), smear * 0.12);
  // the dirt ridge pushed to the end of the stroke
  float ridge = (1.0 - smoothstep(0.0, 0.035, abs(rad - 0.88))) * dirt;
  c = mix(c, owSRGB(vec3(0.260, 0.244, 0.216)), ridge * 0.55);
  r += ridge * 0.20;

  // ---- rain spots --------------------------------------------------------
  float spot = smoothstep(0.26, 0.04, spots.x) * step(0.55, spots.z);
  r += spot * 0.20 * (0.3 + 0.7 * dirt);
  c = mix(c, owSRGB(vec3(0.190, 0.186, 0.176)), spot * 0.16 * dirt);

  // ---- fine scratches ----------------------------------------------------
  // Sand under a wiper blade cuts arcs that only show against a low sun.
  float scr = owScratches(p * 2.0, P * 2.0, 22.0, 1.0, 0.72);
  r += scr * 0.22;
  c += scr * 0.014;

  // ---- defroster grid ----------------------------------------------------
  // Printed silver bus bars: matt, slightly metallic, on a wide pitch, with two
  // heavy vertical buses at the edges.
  float lines = 1.0 - smoothstep(0.16, 0.34, abs(fract(uv.y * 14.0) - 0.5) * 2.0);
  float bus = (1.0 - smoothstep(0.030, 0.055, min(uv.x, 1.0 - uv.x)));
  float grid = clamp(lines * smoothstep(0.06, 0.10, min(uv.x, 1.0 - uv.x)) + bus, 0.0, 1.0) * defr;
  c = mix(c, owSRGB(vec3(0.330, 0.290, 0.215)), grid * 0.80);
  r = mix(r, 0.55, grid * 0.8);
  // fired silver frit is a conductor, not a grey paint
  metal = mix(metal, 1.0, grid * 0.85);
  h += grid * 0.02;

  // ---- the frit band -----------------------------------------------------
  // Every bonded screen has a black ceramic frit round its edge that fades into
  // a dot matrix. It is a small detail and it is instantly recognisable.
  float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  float frit = 1.0 - smoothstep(0.020, 0.030, edge);
  float dots = (1.0 - smoothstep(0.030, 0.062, edge))
             * step(0.35, owHash12(floor(uv * 90.0) + uSeed))
             * (1.0 - smoothstep(0.20, 0.42, abs(fract(uv.x * 90.0) - 0.5) + abs(fract(uv.y * 90.0) - 0.5)));
  float fritM = clamp(frit + dots * 0.85, 0.0, 1.0);
  c = mix(c, owSRGB(vec3(0.022, 0.022, 0.024)), fritM * 0.95);
  r = mix(r, 0.42, fritM * 0.85);

  // ---- shattered ---------------------------------------------------------
  if (shat > 0.0) {
    float web = owCracks(p * 5.0, P * 5.0, 0.9, 0.020, 0.30) * shat;
    float web2 = owCracks(p * 11.0 + 5.0, P * 11.0, 0.95, 0.016, 0.42) * shat;
    float w = clamp(web + web2 * 0.7, 0.0, 1.0);
    c = mix(c, owSRGB(vec3(0.520, 0.545, 0.535)), w * 0.65);
    r = mix(r, 0.55, w * 0.8);
    h -= w * 0.03;
    ao -= w * 0.25;
  }

  alb = clamp(c, vec3(0.015), vec3(0.60));
  rough = clamp(r, 0.02, 0.90);
  metal = clamp(metal, 0.0, 1.0);
  ao = clamp(ao, 0.5, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * CHROME — bumpers, grille surrounds, trim, wheel lips.
 * Metalness 1 everywhere it is still chrome and 0 everywhere the plating has
 * lifted, because that is the difference between chrome and grey plastic.
 *
 * uParam.x  age 0..1   pitting, plating lift, rust bleeding from the substrate
 * uParam.y  dirt 0..1
 */
export const CHROME = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 8.1;
  float age = clamp(uParam.x, 0.0, 1.0);
  float dirt = clamp(uParam.y, 0.0, 1.0);

  float fine = owFbm01(p * 16.0, P * 16.0, 4, 0.5);
  float macro = owFbm01(p * 1.1, P * 1.1, 4, 0.6);
  // The nickel under the chrome is polished on a mop, so there is always a
  // faint directional swirl in the plating — it is what makes chrome read as
  // metal rather than as a mirror ball.
  float mop = owFbm01(owShear(p * 3.0, 0.0, 22.0), owShearPer(P * 3.0, 22.0), 4, 0.5);

  vec3 c = owSRGB(vec3(0.560, 0.566, 0.575));
  c *= 0.975 + 0.05 * mop;
  float r = 0.035 + mop * 0.030 + (fine - 0.5) * 0.010;
  metal = 1.0;
  h = 0.80 + (macro - 0.5) * 0.012;
  ao = 1.0;

  // ---- orange peel in the plating ---------------------------------------
  // Chrome is plated over a sprayed base, so it inherits a very shallow dimple
  // field. A perfectly flat chrome bumper looks like a render.
  float peel = owFbm01(p * 9.0, P * 9.0, 3, 0.5);
  h += (peel - 0.5) * 0.020;

  // ---- pitting -----------------------------------------------------------
  // Road salt gets under the plating and blows it off in craters that ring
  // brown. The plating edge stays bright; the crater is bare steel and rust.
  vec4 pit = owWorley(p * 18.0, P * 18.0, 1.0);
  float pitM = smoothstep(0.13, 0.02, pit.x) * step(0.86 - age * 0.34, pit.w);
  float halo = max(smoothstep(0.20, 0.13, pit.x) - smoothstep(0.13, 0.02, pit.x), 0.0)
             * step(0.86 - age * 0.34, pit.w);
  vec3 rust = owRustColour(0.55 + 0.3 * fine, fine);
  c = mix(c, rust * 0.85, pitM * 0.85);
  c = mix(c, rust * 0.6, halo * 0.45);
  r = mix(r, 0.88, pitM * 0.9);
  metal = mix(metal, 0.0, pitM * 0.9);
  h -= pitM * 0.10;
  ao -= pitM * 0.4;

  // ---- plating lift ------------------------------------------------------
  float lift = smoothstep(0.70 - age * 0.28, 0.86 - age * 0.20,
                          1.0 - owBillow(owWarp(p * 1.7, P * 1.7, 1.0, 4), P * 1.7, 5, 0.6));
  lift *= age;
  c = mix(c, rust, lift * 0.85);
  r = mix(r, 0.90, lift * 0.9);
  metal = mix(metal, 0.0, lift * 0.85);
  h -= lift * 0.03;
  // the bright torn edge of the lifted plating
  float liftEdge = lift * (1.0 - lift) * 4.0;
  c = mix(c, vec3(0.82), liftEdge * 0.30);

  // ---- scratches ---------------------------------------------------------
  float scr = owScratches(p * 2.0, P * 2.0, 26.0, 1.0, 0.70) * (0.4 + 0.7 * age);
  r += scr * 0.20;
  c *= 1.0 - scr * 0.06;

  // ---- grime -------------------------------------------------------------
  // Chrome collects a greasy road film that kills the reflection long before
  // the plating fails, and it collects it in the low spots first.
  float film = smoothstep(0.42, 0.88, owFbm01(p * 4.0, P * 4.0, 4, 0.55)) * dirt;
  c = mix(c, owSRGB(vec3(0.170, 0.162, 0.150)), film * 0.42);
  r = mix(r, 0.62, film * 0.75);
  metal *= 1.0 - film * 0.7;
  // water spots: dried mineral rings, matt on a mirror
  vec4 wsp = owWorley(p * 13.0, P * 13.0, 1.0);
  float ws = max(smoothstep(0.20, 0.13, wsp.x) - smoothstep(0.11, 0.03, wsp.x), 0.0) * step(0.5, wsp.z);
  r += ws * 0.30 * (0.3 + 0.7 * dirt);
  c = mix(c, vec3(0.42), ws * 0.10 * dirt);

  alb = clamp(c, vec3(0.02), vec3(0.92));
  rough = clamp(r, 0.020, 0.99);
  metal = clamp(metal, 0.0, 1.0);
  ao = clamp(ao, 0.35, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * BLACK PLASTIC TRIM — bumper inserts, mirror caps, cowl panels, wheel-arch
 * liners. Textured ABS: a moulded pebble grain, metalness 0, and a roughness
 * that varies with UV fade. Gets chalky and grey with age, which is one of the
 * strongest signals that a car is old.
 *
 * uParam.x  grain 0 = fine pebble, 1 = coarse mould texture
 * uParam.y  fade 0..1
 * uParam.z  dirt 0..1
 */
export const TRIM_PLASTIC = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 5.1;
  float coarse = clamp(uParam.x, 0.0, 1.0);
  float fade = clamp(uParam.y, 0.0, 1.0);
  float dirt = clamp(uParam.z, 0.0, 1.0);

  // The moulded grain: two worley grades, the coarse one selected by uParam.x.
  vec4 gA = owWorley(p * 22.0, P * 22.0, 1.0);
  vec4 gB = owWorley(p * 12.0, P * 12.0, 1.0);
  float pebA = smoothstep(0.40, 0.06, gA.x);
  float pebB = smoothstep(0.42, 0.08, gB.x);
  float peb = mix(pebA, pebB, coarse);
  float cell = mix(gA.z, gB.z, coarse);
  float fine = owFbm01(p * 14.0, P * 14.0, 3, 0.5);
  float macro = owFbm01(p * 1.3, P * 1.3, 4, 0.6);

  // 0.185 sRGB is about as dark as an albedo can be authored here before the
  // 0.02 linear floor flattens the surface; real black ABS is 0.03-0.05 linear.
  vec3 c = owSRGB(vec3(0.185, 0.184, 0.190));
  c *= 0.86 + 0.26 * (peb * 0.6 + 0.4);
  c *= 0.95 + 0.10 * fine;

  h = 0.62 + peb * 0.13 * (0.6 + 0.5 * cell) + (fine - 0.5) * 0.02;
  // Textured plastic is matt but not dead: the crown of each pebble catches a
  // highlight, the valleys do not, and that is the whole read.
  float r = 0.74 - peb * 0.14 + (fine - 0.5) * 0.10;
  metal = 0.0;
  ao = mix(0.70, 1.0, peb * 0.5 + 0.5);

  // ---- UV fade -----------------------------------------------------------
  // Unpainted ABS goes chalky grey from the top down. It also flattens: the
  // surface degrades and scatters, so roughness climbs with the value.
  float sun = smoothstep(0.15, 0.90, macro * 0.5 + owFbm01(p * 0.7 + 3.0, P * 0.7, 3, 0.62) * 0.6);
  float chalk = fade * sun;
  c = mix(c, owSRGB(vec3(0.360, 0.356, 0.348)), chalk * 0.55);
  r += chalk * 0.16;

  // ---- mould seam and ejector marks --------------------------------------
  float seam = 1.0 - smoothstep(0.0, 0.010, abs(fract(uv.y * 2.0 + 0.5) - 0.5));
  h += seam * 0.035;
  c *= 1.0 + seam * 0.20;
  r -= seam * 0.10;

  // ---- scuffs ------------------------------------------------------------
  // Trim is what a kerb, a trolley and a knee actually hit; a scuff on black
  // plastic goes lighter, not darker.
  float scuff = smoothstep(0.58, 0.88, owFbm01(owWarp(p * 3.0, P * 3.0, 0.8, 3), P * 3.0, 4, 0.55));
  c = mix(c, c * 1.7 + 0.02, scuff * 0.35 * (0.4 + 0.7 * fade));
  r += scuff * 0.06;
  h -= scuff * 0.012;
  float gouge = owScratches(p * 2.4, P * 2.4, 15.0, 1.0, 0.72);
  c = mix(c, c * 2.1 + 0.02, gouge * 0.4);
  h -= gouge * 0.02;

  // ---- road dirt ---------------------------------------------------------
  float film = smoothstep(0.35, 0.85, owFbm01(p * 5.0, P * 5.0, 4, 0.55)) * dirt;
  c = mix(c, owSRGB(vec3(0.210, 0.192, 0.164)), film * 0.45);
  r += film * 0.08;
  // dirt packs into the grain valleys first
  float valley = 1.0 - peb;
  c = mix(c, owSRGB(vec3(0.140, 0.128, 0.108)), valley * dirt * 0.30);

  alb = clamp(c, vec3(0.02), vec3(0.55));
  rough = clamp(r, 0.24, 0.99);
  ao = clamp(ao, 0.35, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * TYRE.
 *
 * A CRITIC CHECKS THIS FIRST, so the rules are absolute: metalness 0, roughness
 * never below 0.72, and a linear albedo between 0.026 and 0.055. Rubber loaded
 * with carbon black is one of the darkest and most diffuse materials on a
 * street; a shiny tyre is the single loudest "this is a video game" tell there
 * is, and a tyre that is merely dark-grey-and-flat is the second.
 *
 * What makes it read is texture, not gloss: the moulded tread blocks with their
 * siping, the sidewall's raised lettering and its fine circumferential ribbing,
 * the brown antiozonant bloom that migrates to the surface of old rubber, and
 * the road dust dustPacked into the grooves.
 *
 * uParam.x  zone 0 = sidewall, 1 = tread
 * uParam.y  wear 0..1
 * uParam.z  dirt 0..1
 */
export const TYRE = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 9.6;
  float tread = clamp(uParam.x, 0.0, 1.0);
  float wear = clamp(uParam.y, 0.0, 1.0);
  float dirt = clamp(uParam.z, 0.0, 1.0);

  float fine  = owFbm01(p * 14.0, P * 14.0, 3, 0.5);
  float micro = owFbm01(p * 22.0, P * 22.0, 3, 0.5);
  float macro = owFbm01(p * 1.4, P * 1.4, 4, 0.6);

  // Carbon-black rubber. 0.175 sRGB = 0.026 linear, right at the bottom of the
  // physically plausible band, and it must stay there.
  vec3 c = owSRGB(vec3(0.178, 0.176, 0.180));
  float r = 0.90 + (micro - 0.5) * 0.06;
  metal = 0.0;
  h = 0.55;
  ao = 1.0;

  // ---- moulding texture --------------------------------------------------
  // Every tyre carries the mould's own fine stipple, and it is the thing that
  // stops rubber reading as a matte-painted solid.
  vec4 stip = owWorley(p * 20.0, P * 20.0, 1.0);
  float stipple = smoothstep(0.38, 0.10, stip.x);
  h += stipple * 0.035;
  c *= 0.93 + 0.13 * stipple;
  r += (0.5 - stipple) * 0.04;

  // ---- tread -------------------------------------------------------------
  // Four circumferential grooves with block rows between them, each block
  // siped by fine lateral slits. The grooves are DEEP — 8 mm of real relief —
  // and they are what a tyre reads by at any distance.
  {
    float grooveX = abs(fract(uv.x * 4.0) - 0.5) * 2.0;
    float groove = 1.0 - smoothstep(0.28, 0.46, grooveX);
    // blocks staggered along the circumference
    float rowF = uv.y * 14.0;
    float row = floor(rowF);
    float lug = abs(fract(uv.y * 14.0 + mod(floor(uv.x * 4.0), 2.0) * 0.5) - 0.5) * 2.0;
    float lugGap = 1.0 - smoothstep(0.62, 0.86, lug);
    float sipe = 1.0 - smoothstep(0.06, 0.16, abs(fract(uv.y * 56.0) - 0.5) * 2.0);
    float blockH = (1.0 - groove) * (1.0 - (1.0 - lugGap) * 0.55);
    float tH = 0.34 + blockH * 0.52 - sipe * (1.0 - groove) * 0.20;
    // the block edges round off as the tyre wears
    tH -= (1.0 - smoothstep(0.40, 0.60, grooveX)) * 0.10 * wear;
    float tAo = 1.0 - groove * 0.55 - sipe * 0.25 - (1.0 - lugGap) * 0.25;
    // the block face is polished by the road, the groove wall is not
    float faceM = smoothstep(0.55, 0.85, grooveX) * lugGap;
    float tR = mix(0.94, 0.78 + 0.10 * (1.0 - wear), faceM);
    vec3 tC = c * mix(0.80, 1.06, faceM);
    // stones and grit jammed in the grooves
    vec4 st = owWorley(p * 16.0 + 11.0, P * 16.0, 1.0);
    float stone = smoothstep(0.14, 0.03, st.x) * step(0.90, st.w) * groove;
    tC = mix(tC, owSRGB(vec3(0.360, 0.344, 0.320)), stone * 0.8);
    tH += stone * 0.10;

    h = mix(h, tH, tread);
    c = mix(c, tC, tread);
    r = mix(r, tR, tread);
    ao = mix(ao, tAo, tread);
  }

  // ---- sidewall ----------------------------------------------------------
  // Fine circumferential ribbing, a raised lettering band, and the moulded
  // rim-protector ridge. All shallow — 0.5-1.5 mm — but all directional, which
  // is what catches a low sun and turns a black disc into a tyre.
  {
    float rib = 1.0 - smoothstep(0.25, 0.75, abs(fract(uv.y * 64.0) - 0.5) * 2.0);
    float ribBand = smoothstep(0.12, 0.26, uv.x) * (1.0 - smoothstep(0.55, 0.70, uv.x));
    float sH = 0.55 + rib * ribBand * 0.055;
    // lettering: a band of raised glyph-ish bumps around the circumference
    float lBand = smoothstep(0.70, 0.74, uv.x) * (1.0 - smoothstep(0.86, 0.90, uv.x));
    float gl = step(0.42, owHash11(floor(uv.y * 42.0) + uSeed * 2.0))
             * (1.0 - smoothstep(0.24, 0.44, abs(fract(uv.y * 42.0) - 0.5)));
    float letters = lBand * gl;
    sH += letters * 0.10;
    // the rim protector, a hard proud ring
    float prot = (1.0 - smoothstep(0.030, 0.055, abs(uv.x - 0.075)));
    sH += prot * 0.13;
    float sAo = 1.0 - (1.0 - rib) * ribBand * 0.10 - letters * 0.05;
    // letters are moulded in the same rubber but their faces are unabraded, so
    // they stay a touch darker and rougher than the polished sidewall around
    // them; a WHITE letter would be wrong on almost every car in a city.
    vec3 sC = c * (1.0 - letters * 0.10) * (0.97 + 0.06 * rib * ribBand);
    float sR = 0.92 - rib * ribBand * 0.03 + letters * 0.03;

    h = mix(sH, h, tread);
    c = mix(sC, c, tread);
    r = mix(sR, r, tread);
    ao = mix(sAo, ao, tread);
  }

  // ---- ozone cracking ----------------------------------------------------
  float crack = owCracks(p * 9.0, P * 9.0, 0.9, 0.024, 0.66 - wear * 0.16) * (0.3 + 0.9 * wear);
  h -= crack * 0.055;
  c *= 1.0 - crack * 0.28;
  ao -= crack * 0.35;

  // ---- antiozonant bloom -------------------------------------------------
  // The wax that keeps rubber from cracking migrates to the surface and dries
  // to a brown-grey chalk. It is why old tyres are not black, and putting it
  // in is the difference between a tyre and a black cylinder.
  float bloom = smoothstep(0.35, 0.85, macro * 0.6 + fine * 0.5) * (0.30 + 0.70 * wear);
  c = mix(c, owSRGB(vec3(0.290, 0.268, 0.238)), bloom * 0.30);
  r += bloom * 0.04;

  // ---- road dust ---------------------------------------------------------
  // Packed into every groove and sipe, warm grey, and it is what makes the
  // tread pattern legible from across a street.
  float low = 1.0 - smoothstep(0.30, 0.72, h);
  float dustN = smoothstep(0.30, 0.80, owFbm01(p * 6.0, P * 6.0, 4, 0.55));
  float dust = clamp(dirt * (0.35 + 0.85 * low) * (0.4 + 0.8 * dustN), 0.0, 1.0);
  c = mix(c, owSRGB(vec3(0.320, 0.300, 0.268)), dust * 0.42);
  r += dust * 0.05;
  // and a wet-mud splatter for the arches
  float mud = smoothstep(0.62, 0.90, owFbm01(owWarp(p * 3.5 + 17.0, P * 3.5, 0.9, 3), P * 3.5, 4, 0.55)) * dirt;
  c = mix(c, owSRGB(vec3(0.215, 0.180, 0.132)), mud * 0.45);

  alb = clamp(c, vec3(0.024), vec3(0.34));
  // THE HARD FLOOR. Nothing on a tyre is glossier than this, wet or dry.
  rough = clamp(r, 0.72, 0.99);
  metal = 0.0;
  ao = clamp(ao, 0.25, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;

/**
 * ALLOY WHEEL with brake dust.
 *
 * Brake dust is not dirt: it is iron oxide and sintered pad material blasted on
 * hot, so it BAKES ON. It is warm brown-grey, it is metalness 0 over a
 * metalness 1 substrate, it is heaviest around the hub and on the inboard face
 * of every spoke, and its distribution is the single strongest cue that a wheel
 * has been driven rather than modelled.
 *
 * uParam.x  finish 0 = machined/polished face, 1 = painted silver, 2 = dark grey
 * uParam.z  dust 0..1
 * uParam.y  kerbing 0..1  the gouged rim lip
 */
export const ALLOY = /* glsl */ `
void owSurface(vec2 uv, out vec3 alb, out float h, out float rough, out float metal, out float ao){
  const vec2 P = vec2(8.0);
  vec2 p = uv * P + uSeed * 7.4;
  float finish = clamp(uParam.x, 0.0, 2.0);
  float kerbing = clamp(uParam.y, 0.0, 1.0);
  float dust = clamp(uParam.z, 0.0, 1.0);

  vec2 q = uv - 0.5;
  float rr = length(q);
  float a = atan(q.y, q.x);

  float fine = owFbm01(p * 15.0, P * 15.0, 4, 0.5);
  float macro = owFbm01(p * 1.2, P * 1.2, 4, 0.6);

  // ---- the base finish ---------------------------------------------------
  // A diamond-cut face is turned on a lathe: concentric micro grooves that
  // smear a highlight into a ring. That anisotropy is what says "machined".
  float turn = 1.0 - smoothstep(0.15, 0.85, abs(fract(rr * 220.0) - 0.5) * 2.0);
  float machined = 1.0 - smoothstep(0.5, 1.5, finish);
  float painted = 1.0 - abs(finish - 1.0);
  float dark = smoothstep(1.0, 2.0, finish);

  vec3 cMach = owSRGB(vec3(0.585, 0.590, 0.598)) * (0.96 + 0.07 * turn);
  vec3 cPaint = owSRGB(vec3(0.470, 0.474, 0.482)) * (0.94 + 0.10 * fine);
  vec3 cDark = owSRGB(vec3(0.150, 0.152, 0.158)) * (0.90 + 0.18 * fine);
  vec3 c = cMach * machined + cPaint * painted + cDark * dark;

  float r = machined * (0.13 + turn * 0.10)
          + painted * (0.30 + (fine - 0.5) * 0.10)
          + dark * (0.42 + (fine - 0.5) * 0.12);
  // machined face = bare aluminium (1). Silver paint is flake in binder and
  // resolves to its coverage fraction. Solid dark paint is a dielectric (0).
  metal = machined * 1.0 + painted * 0.45;
  h = 0.74 + (fine - 0.5) * 0.012 + turn * machined * 0.006;
  ao = 1.0;

  // ---- clearcoat pinholes and lacquer blisters ---------------------------
  vec4 blis = owWorley(p * 17.0, P * 17.0, 1.0);
  float blister = smoothstep(0.10, 0.02, blis.x) * step(0.90, blis.w);
  c = mix(c, c * 0.55 + owSRGB(vec3(0.10, 0.09, 0.08)), blister * 0.7);
  r = mix(r, 0.85, blister * 0.8);
  metal *= 1.0 - blister * 0.8;
  h -= blister * 0.05;

  // ---- kerb rash ---------------------------------------------------------
  // The outer 8% of the rim: gouged down to bright bare aluminium in a band,
  // with the deepest strikes leaving parallel chatter marks.
  float lip = smoothstep(0.40, 0.455, rr);
  float rash = lip * kerbing
             * smoothstep(0.42, 0.72, owFbm01(vec2(a * 3.0, rr * 12.0), vec2(24.0, 96.0), 4, 0.55));
  float chatter = rash * (1.0 - smoothstep(0.25, 0.75, abs(fract(a * 42.0) - 0.5) * 2.0));
  c = mix(c, owSRGB(vec3(0.660, 0.665, 0.672)), rash * 0.75);
  r = mix(r, 0.48, rash * 0.8);
  metal = mix(metal, 1.0, rash * 0.85);
  h -= rash * 0.05 + chatter * 0.04;
  ao -= chatter * 0.25;

  // ---- BRAKE DUST --------------------------------------------------------
  // Heaviest at the hub, thinning outward, and modulated by where the spokes
  // shadow the disc. It goes on hot enough to bond, so it survives a wash and
  // it kills both the metalness and the gloss underneath it.
  float radial = 1.0 - smoothstep(0.06, 0.46, rr);
  // the spoke shadow pattern: five spokes
  float spoke = 0.5 + 0.5 * cos(a * 5.0 + macro * 1.5);
  float dustN = smoothstep(0.22, 0.80, owFbm01(owWarp(p * 3.2, P * 3.2, 0.7, 3), P * 3.2, 4, 0.55));
  float d = clamp(dust * (0.25 + 0.95 * radial) * (0.55 + 0.55 * spoke) * (0.40 + 0.80 * dustN), 0.0, 1.0);
  // Iron oxide over sintered pad: a warm, dead brown-grey. Not black.
  vec3 dustCol = mix(owSRGB(vec3(0.230, 0.196, 0.168)), owSRGB(vec3(0.145, 0.128, 0.118)), dustN);
  c = mix(c, dustCol, d * 0.82);
  r = mix(r, 0.93, d * 0.88);
  metal *= 1.0 - d * 0.95;
  ao -= d * 0.10;
  // it packs into every recess before it covers a face
  float cavity = 1.0 - smoothstep(0.62, 0.80, h);
  float dustPacked = clamp(cavity * dust * 1.4, 0.0, 1.0);
  c = mix(c, dustCol * 0.75, dustPacked * 0.6);
  metal *= 1.0 - dustPacked * 0.7;

  // ---- water and salt streaks radiating out ------------------------------
  float streak = smoothstep(0.55, 0.88, owFbm01(vec2(a * 5.0, rr * 3.0), vec2(40.0, 24.0), 4, 0.55));
  c = mix(c, dustCol * 1.15, streak * dust * 0.30);

  // ---- valve stem / wheel-weight scuff ----------------------------------
  float weight = (1.0 - smoothstep(0.02, 0.035, abs(rr - 0.435)))
               * step(0.80, owHash11(floor(a * 8.0) + uSeed));
  c = mix(c, owSRGB(vec3(0.400, 0.402, 0.408)), weight * 0.55);
  h += weight * 0.05;
  metal = mix(metal, 0.9, weight * 0.5);

  alb = clamp(c, vec3(0.02), vec3(0.86));
  rough = clamp(r, 0.10, 0.99);
  metal = clamp(metal, 0.0, 1.0);
  ao = clamp(ao, 0.30, 1.0);
  h = clamp(h, 0.0, 1.0);
}
`;
